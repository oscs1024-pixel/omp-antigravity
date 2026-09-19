import type { Api, Context, Model } from "@oh-my-pi/pi-ai";
import {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
} from "../types/enums.js";
import {
  getMaxOutputTokens,
  getAntigravityRequestModelId,
  getThinkingConfig,
} from "../models/models.js";
import type {
  AntigravityGenerateRequest,
  AntigravityStreamOptions,
  GeminiGenerationConfig,
  GeminiRequestBody,
  GeminiToolConfig,
} from "../types/types.js";
import {
  antigravityEnv,
  antigravityRequestEnvelope,
  resolveSessionTrajectory,
  sanitizeText,
} from "../utils/util.js";
import {
  ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  FORCED_TOOL_DIRECTIVE,
} from "./constants.js";
import { convertMessages, skillBlocks } from "./messages.js";
import { convertTools } from "./schema.js";

/**
 * Translate OMP's `ToolChoice` into Cloud Code Assist's `functionCallingConfig`.
 *
 * OMP sends either a mode string (`"auto" | "none" | "any" | "required"`) or an
 * object form forcing one named tool. Gemini has no per-name "required" mode, so
 * a forced tool is expressed as `mode: ANY` plus `allowedFunctionNames`, which is
 * the closest equivalent the wire supports.
 */
function toolCallingConfig(
  toolChoice: AntigravityStreamOptions["toolChoice"],
): GeminiToolConfig["functionCallingConfig"] | undefined {
  if (!toolChoice || toolChoice === "auto") return undefined;
  if (toolChoice === "none") return { mode: GeminiToolCallingMode.None };
  if (toolChoice === "any" || toolChoice === "required") {
    return { mode: GeminiToolCallingMode.Any };
  }
  if ("name" in toolChoice && toolChoice.name) {
    return { mode: GeminiToolCallingMode.Any, allowedFunctionNames: [toolChoice.name] };
  }
  if ("function" in toolChoice && toolChoice.function.name) {
    return { mode: GeminiToolCallingMode.Any, allowedFunctionNames: [toolChoice.function.name] };
  }
  // `{ type: "computer" }` names no tool — force some call rather than dropping the request.
  return { mode: GeminiToolCallingMode.Any };
}

/**
 * Resolve the thinking level a request should run at.
 *
 * OMP's `SimpleStreamOptions` documents `disableReasoning` as taking precedence
 * over `reasoning`, and its `Effort` union has no "off" member — a disabled
 * request is expressed either as `disableReasoning: true` or as an absent
 * `reasoning`. Both collapse to the provider's off state here, which the
 * Antigravity wire carries as a thinking budget of 0 with no thought summaries.
 *
 * This is the single place the precedence is applied, so the runtime-model
 * routing below and the generation config in {@link buildRequest} can never
 * disagree about which effort was requested.
 */
/** Exported for unit tests. */
export function resolveRequestedEffort(options: AntigravityStreamOptions): string {
  if (options.disableReasoning) return "off";
  return options.reasoning ?? "off";
}

/**
 * Runtime model id for the first attempt: an explicit `ANTIGRAVITY_RUNTIME_MODEL`
 * override wins, otherwise the public model id and the *effective* effort are
 * routed together.
 *
 * This exists so the effort precedence is applied in exactly one place. Resolving
 * the runtime model from `options.reasoning` directly disagreed with
 * {@link resolveRequestedEffort}: `{ reasoning: "high", disableReasoning: true }`
 * picked the `-high` runtime id while the generation config sent
 * `thinkingBudget: 0`, i.e. a thinking-tuned backend model asked not to think.
 *
 * Exported for unit tests.
 */
export function resolveInitialRuntimeModel(
  modelId: string,
  options: AntigravityStreamOptions,
  projectId?: string,
): string {
  return (
    antigravityEnv("RUNTIME_MODEL")?.trim() ||
    getAntigravityRequestModelId(modelId, resolveRequestedEffort(options), projectId)
  );
}

/** Exported for unit tests. */
export function buildRequest(
  model: Model<Api>,
  context: Context,
  projectId: string,
  options: AntigravityStreamOptions,
  runtimeModel: string,
): AntigravityGenerateRequest {
  const injectedSkills = context.messages.flatMap((msg) =>
    msg.role === "user" ? skillBlocks(msg.content) : [],
  );
  // OMP passes systemPrompt as string[] (pi <=0.84 used a plain string).
  // Join the lines so the full system prompt survives the wire conversion.
  const systemPromptText = Array.isArray(context.systemPrompt)
    ? context.systemPrompt.filter(Boolean).join("\n\n")
    : context.systemPrompt;
  const systemParts = systemPromptText
    ? [{ text: sanitizeText(systemPromptText) }]
    : [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION }];
  systemParts.push(...injectedSkills.map((skill) => ({ text: sanitizeText(skill) })));

  const contents = convertMessages(model, context, runtimeModel);
  const hasUserText = contents.some(
    (turn) =>
      turn.role === GeminiRole.User &&
      turn.parts.some((part) => "text" in part && Boolean(part.text.trim())),
  );
  if (!hasUserText && (injectedSkills.length > 0 || systemPromptText)) {
    contents.unshift({
      role: GeminiRole.User,
      parts: [{ text: "Apply the active system instructions." }],
    });
  }

  const request: GeminiRequestBody = {
    contents,
    systemInstruction: {
      role: GeminiRole.User,
      parts: systemParts,
    },
  };

  const generationConfig: GeminiGenerationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const thinking = getThinkingConfig(
    runtimeModel,
    resolveRequestedEffort(options),
    options.thinkingBudgets,
  );
  if (thinking) generationConfig.thinkingConfig = thinking;
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = Math.min(options.maxTokens, maxAllowed);
  } else {
    generationConfig.maxOutputTokens = Math.min(maxAllowed, model.maxTokens || maxAllowed);
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const isClaude = model.id.startsWith("claude-") || runtimeModel.startsWith("claude-");
  const tools = convertTools(context.tools, isClaude || model.id.startsWith("gpt-oss-"));
  if (tools) {
    request.tools = tools;
    if (options.toolChoice) {
      const functionCallingConfig = toolCallingConfig(options.toolChoice);
      if (functionCallingConfig) {
        request.toolConfig = { functionCallingConfig };
      }
      if (
        !isClaude &&
        request.toolConfig?.functionCallingConfig.mode === GeminiToolCallingMode.Any
      ) {
        request.contents.push({
          role: GeminiRole.User,
          parts: [{ text: FORCED_TOOL_DIRECTIVE }],
        });
      }
    }
    if (!request.toolConfig) {
      request.toolConfig = {
        functionCallingConfig: { mode: GeminiToolCallingMode.Validated },
      };
    }
  }

  // Claude on Antigravity always forces VALIDATED, even with no tools declared
  if (isClaude && !request.toolConfig) {
    request.toolConfig = {
      functionCallingConfig: { mode: GeminiToolCallingMode.Validated },
    };
  }
  const isNonGemini =
    isClaude ||
    model.id.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("gpt-oss-") ||
    (!model.id.startsWith("gemini-") && !runtimeModel.startsWith("gemini-"));

  // Pure agy CLI wire alignment:
  // - step in requestId (.../<step>) equals contents.length (total content blocks)
  // - last_step_index is 0-based index of the last content block (contents.length - 1)
  // - request_id is ${trajectoryId}-${requestIndex} (0-based HTTP request sequence counter)
  //   In multi-turn agent loops (with tools), every completed assistant response increments the request counter.
  const step = Math.max(1, request.contents.length);
  const lastStepIndex = String(Math.max(0, request.contents.length - 1));
  const requestIndex =
    context.messages?.filter(
      (m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted",
    ).length ?? 0;

  const trajectory = resolveSessionTrajectory(context, projectId);

  const envelope = antigravityRequestEnvelope(runtimeModel, {
    isClaude,
    isNonGemini,
    step,
    lastStepIndex,
    requestIndex,
    conversationId: trajectory.conversationId,
    trajectoryId: trajectory.trajectoryId,
    sessionId: options.sessionId || trajectory.sessionId,
    lastExecutionId: trajectory.lastExecutionId,
    projectId,
  });
  request.sessionId = envelope.sessionId;
  request.labels = envelope.labels;

  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  };
}
