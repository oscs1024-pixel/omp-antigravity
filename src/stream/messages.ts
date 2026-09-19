import type { Api, Context, Model, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import { GeminiRole } from "../types/enums.js";
import type {
  ContentBlock,
  GeminiContent,
  GeminiFunctionResponsePart,
  GeminiInlineDataPart,
  GeminiPart,
  GeminiTextPart,
} from "../types/types.js";
import { PROVIDER_ID } from "../models/models.js";
import { isRecord, sanitizeText } from "../utils/util.js";
import { CONTINUATION_TEXT } from "./constants.js";

let toolCallCounter = 0;

export function sanitizeToolCallId(id: string, fallbackName?: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${++toolCallCounter}`;
}

export function toolCallIdNeeded(modelId: string, runtimeModel: string): boolean {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature?: string): boolean {
  if (!signature || typeof signature !== "string" || signature.length === 0) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}

function geminiRequiresThoughtSignature(runtimeModel: string): boolean {
  if (!runtimeModel.startsWith("gemini-")) return false;
  const match = runtimeModel.match(/^gemini-(\d+)/);
  if (match) {
    const major = Number.parseInt(match[1], 10);
    return major >= 3;
  }
  return true;
}

function parseImageData(raw: string, explicitMime?: string): { data: string; mimeType: string } {
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    return {
      mimeType: explicitMime || match[1] || "image/png",
      data: match[2].trim(),
    };
  }
  return {
    mimeType: explicitMime || "image/png",
    data: raw.trim(),
  };
}

const SKILL_BLOCK_PATTERN = /<skill\b[^>]*>[\s\S]*?<\/skill\s*>/gi;

export function skillBlocks(content: unknown): string[] {
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((item) =>
            isRecord(item) && item.type === "text" && typeof item.text === "string"
              ? [item.text]
              : [],
          )
        : [];
  return texts.flatMap((text) => text.match(SKILL_BLOCK_PATTERN) || []);
}

function withoutSkillBlocks(text: string): string {
  return text.replace(SKILL_BLOCK_PATTERN, "");
}

function asTextParts(content: unknown): Array<GeminiTextPart | GeminiInlineDataPart> {
  const textPart = (text: string): GeminiTextPart[] => {
    const userText = withoutSkillBlocks(text);
    return userText.trim() ? [{ text: sanitizeText(userText) }] : [];
  };
  if (typeof content === "string") return textPart(content);
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Array<GeminiTextPart | GeminiInlineDataPart> => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    if (block.type === "text") return textPart(block.text);
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}

function asImageParts(content: unknown): GeminiInlineDataPart[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): GeminiInlineDataPart[] => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}

export function appendTurn(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts });
  }
}

/** Exported for unit tests. */
export function convertMessages(
  model: Model<Api>,
  context: Context,
  runtimeModel: string,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const requiresSig = geminiRequiresThoughtSignature(runtimeModel);
  const droppedToolCallIds = new Map<string, string>();
  // FIFO pairing for tool calls with no host-provided id: an emitted functionCall
  // queues the generated id so its toolResult reuses it, and a dropped call queues
  // a marker so its result takes the observation path. Results arrive in call
  // order, so per-name queues pair nth call with nth result.
  const pendingEmptyToolCalls = new Map<
    string,
    ({ emittedId: string } | { droppedArgs: string })[]
  >();
  const queueEmptyCall = (
    name: string,
    entry: { emittedId: string } | { droppedArgs: string },
  ): void => {
    const queue = pendingEmptyToolCalls.get(name);
    if (queue) queue.push(entry);
    else pendingEmptyToolCalls.set(name, [entry]);
  };
  for (const msg of context.messages) {
    // OMP adds a "developer" role alongside "user"; both are instruction-type
    // user turns on the Cloud Code Assist wire, so handle them identically.
    if (msg.role === "user" || msg.role === "developer") {
      const parts = asTextParts(msg.content);
      appendTurn(contents, GeminiRole.User, parts);
    } else if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const parts: GeminiPart[] = [];
      const isSameModel = msg.provider === PROVIDER_ID && msg.model === model.id;
      const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
      const firstCallHasSig =
        toolCalls.length > 0 && isValidThoughtSignature(toolCalls[0]?.thoughtSignature);
      const allSigsValid = toolCalls.every(
        (tc) => !tc.thoughtSignature || isValidThoughtSignature(tc.thoughtSignature),
      );
      const groupIsSigned = isSameModel && firstCallHasSig && allSigsValid;

      for (const block of msg.content) {
        if (block.type === "text") {
          const textSig =
            isSameModel && isValidThoughtSignature(block.textSignature)
              ? block.textSignature
              : undefined;
          if ((!block.text || block.text.trim() === "") && !textSig) {
            continue;
          }
          parts.push({
            text: sanitizeText(block.text),
            ...(textSig ? { thoughtSignature: textSig } : {}),
          });
        } else if (block.type === "thinking" && String(block.thinking || "").trim()) {
          if (!isSameModel) continue;
          parts.push({
            thought: true,
            text: sanitizeText(block.thinking),
            ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
          });
        } else if (block.type === "toolCall") {
          const rawId = block.id || "";
          if (requiresSig && !groupIsSigned) {
            const argsText = (() => {
              try {
                return JSON.stringify(block.arguments ?? {});
              } catch {
                return "{}";
              }
            })();
            if (rawId) {
              droppedToolCallIds.set(rawId, argsText);
              droppedToolCallIds.set(sanitizeToolCallId(rawId, block.name), argsText);
            } else {
              queueEmptyCall(block.name, { droppedArgs: argsText });
            }
          } else {
            let callId: string | undefined;
            if (toolCallIdNeeded(model.id, runtimeModel)) {
              if (rawId) {
                callId = sanitizeToolCallId(rawId, block.name);
              } else {
                callId = sanitizeToolCallId("", block.name);
                queueEmptyCall(block.name, { emittedId: callId });
              }
            } else if (!rawId) {
              // Keep the queue aligned even when ids are not sent on the wire,
              // so a dropped call's result cannot consume an emitted call's slot.
              queueEmptyCall(block.name, { emittedId: "" });
            }
            parts.push({
              functionCall: {
                name: block.name,
                args: block.arguments ?? {},
                ...(callId ? { id: callId } : {}),
              },
              ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
            });
          }
        }
      }
      appendTurn(contents, GeminiRole.Model, parts);
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => sanitizeText(c.text))
        .join("\n");
      const responseText = text || (msg.isError ? "Tool failed" : "");
      const imageParts = asImageParts(msg.content);
      const rawId = msg.toolCallId || "";
      const sanitizedId = rawId
        ? toolCallIdNeeded(model.id, runtimeModel)
          ? sanitizeToolCallId(rawId, msg.toolName)
          : rawId
        : "";
      const pending = rawId === "" ? pendingEmptyToolCalls.get(msg.toolName)?.shift() : undefined;
      const droppedArgs = requiresSig
        ? rawId
          ? (droppedToolCallIds.get(rawId) ?? droppedToolCallIds.get(sanitizedId))
          : pending && "droppedArgs" in pending
            ? pending.droppedArgs
            : undefined
        : undefined;
      if (droppedArgs !== undefined) {
        const label =
          droppedArgs === "{}" ? `\`${msg.toolName}\`` : `\`${msg.toolName}\` (${droppedArgs})`;
        appendTurn(contents, GeminiRole.User, [
          { text: sanitizeText(`[Observation from ${label}:\n${responseText}]`) },
          ...imageParts,
        ]);
      } else {
        // Empty rawId: reuse the id the paired functionCall was emitted with, so
        // Claude/GPT-OSS see matching call/response ids instead of a fresh counter.
        const responseId = rawId
          ? sanitizedId
          : toolCallIdNeeded(model.id, runtimeModel)
            ? pending && "emittedId" in pending && pending.emittedId
              ? pending.emittedId
              : sanitizeToolCallId("", msg.toolName)
            : "";
        const part: GeminiFunctionResponsePart = {
          functionResponse: {
            name: msg.toolName,
            response: msg.isError ? { error: responseText } : { output: responseText },
            ...(responseId ? { id: responseId } : {}),
          },
        };
        appendTurn(contents, GeminiRole.User, [part, ...imageParts]);
      }
    }
  }

  // A function-call model turn is only valid immediately after a user turn
  // (including a function-response turn). Compacted history can drop that
  // boundary, so restore it before applying the natural-language bridge.
  for (let index = 0; index < contents.length; index += 1) {
    const turn = contents[index];
    if (
      turn?.role === GeminiRole.Model &&
      turn.parts.some((part) => "functionCall" in part) &&
      contents[index - 1]?.role !== GeminiRole.User
    ) {
      contents.splice(index, 0, {
        role: GeminiRole.User,
        parts: [{ text: CONTINUATION_TEXT }],
      });
      index += 1;
    }
  }

  // Google Antigravity requires a natural-language user part in the request,
  // including tool-only continuation turns. Keep injected Skills in the system
  // instruction, then add this protocol bridge only when existing context gives
  // the model something concrete to act on.
  const hasUserText = contents.some(
    (turn) =>
      turn.role === GeminiRole.User &&
      turn.parts.some((part) => "text" in part && Boolean(part.text.trim())),
  );
  if (!hasUserText && contents.length > 0) {
    const bridge = {
      text: CONTINUATION_TEXT,
    };
    const userTurn = contents.find((turn) => turn.role === GeminiRole.User);
    if (userTurn) userTurn.parts.push(bridge);
    else contents.unshift({ role: GeminiRole.User, parts: [bridge] });
  }

  const lastTurn = contents.at(-1);
  if (lastTurn?.role === GeminiRole.Model) {
    if (lastTurn.parts.some((part) => "functionCall" in part)) {
      throw new Error(
        "Antigravity request is missing tool result(s) for the final assistant tool call. Provide the corresponding tool result before continuing.",
      );
    }
    appendTurn(contents, GeminiRole.User, [{ text: CONTINUATION_TEXT }]);
  }

  return contents;
}
