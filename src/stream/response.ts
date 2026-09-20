import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
} from "@oh-my-pi/pi-ai";
import { StopReason } from "../types/enums.js";
import type { ActiveBlock, StreamChunk } from "../types/types.js";
import { PROVIDER_ID } from "../models/models.js";
import { ANTIGRAVITY_API } from "./constants.js";
import { applyUsageCost } from "./cost.js";
import { mapStopReason, streamChunkError } from "./errors.js";
import {
  isPlanningLeakObject,
  isPlanningLeakPrefix,
  splitLeadingJsonObject,
} from "./leak-detector.js";
import { sanitizeToolCallId } from "./messages.js";

export function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function asToolCallArguments(
  args: Record<string, unknown> | undefined,
): ToolCall["arguments"] {
  return args ?? {};
}

/**
 * Result of consuming one SSE response body.
 *
 * `rawStopReason` is the provider's own finish reason (e.g. `STOP`,
 * `MAX_TOKENS`, `MALFORMED_FUNCTION_CALL`). It is returned rather than stored on
 * the `AssistantMessage` because OMP's message contract has no field for it.
 */
export type StreamResponseResult = {
  received: boolean;
  rawStopReason?: string;
  responseId?: string;
};

/** Exported for unit tests. */
export async function streamResponse(
  response: Response,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model?: Model<Api>,
  context?: Context,
): Promise<StreamResponseResult> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Consumed-prefix offset: the buffer is compacted once per network chunk instead of
  // re-copying the whole remainder for every SSE line.
  let scanStart = 0;
  let started = false;
  let currentBlock: ActiveBlock | null = null;
  let hasContent = false;
  let rawStopReason: string | undefined;
  let lastResponseId: string | undefined;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;
  const toolNames = new Set(context?.tools?.map((t) => t.name) ?? []);

  let isBufferingText = false;
  let textBuffer = "";
  let textBufferSignature: string | undefined;

  const ensureStarted = () => {
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }
  };

  const emitTextDelta = (delta: string, thoughtSignature?: string) => {
    if (!delta) return;
    if (!currentBlock || currentBlock.type !== "text") {
      finishCurrent();
      currentBlock = { type: "text", text: "" };
      blocks.push(currentBlock);
      ensureStarted();
      stream.push({
        type: "text_start",
        contentIndex: blockIndex(),
        partial: output,
      });
    }
    if (currentBlock.type === "text") {
      currentBlock.text += delta;
      if (thoughtSignature) currentBlock.textSignature = thoughtSignature;
      stream.push({
        type: "text_delta",
        contentIndex: blockIndex(),
        delta,
        partial: output,
      });
    }
  };

  const flushTextBuffer = (isFinal = false) => {
    if (!isBufferingText || !textBuffer) return;
    const leading = splitLeadingJsonObject(textBuffer);
    if (leading) {
      const isLeak = (() => {
        try {
          const parsed: unknown = JSON.parse(leading.jsonText);
          return isPlanningLeakObject(parsed, toolNames);
        } catch {
          return leading.jsonText.includes('"thought"');
        }
      })();
      isBufferingText = false;
      const signature = textBufferSignature;
      const rest = leading.rest;
      textBuffer = "";
      textBufferSignature = undefined;
      if (!isLeak) {
        emitTextDelta(leading.jsonText, signature);
      }
      if (rest) {
        emitTextDelta(rest, signature);
      }
      return;
    }
    if (isFinal) {
      const isLeak =
        textBuffer.includes('"thought"') ||
        Array.from(toolNames).some((n) => textBuffer.includes(`"${n}"`));
      isBufferingText = false;
      const signature = textBufferSignature;
      const textToEmit = isLeak ? "" : textBuffer;
      textBuffer = "";
      textBufferSignature = undefined;
      if (textToEmit) emitTextDelta(textToEmit, signature);
    }
  };

  const finishCurrent = () => {
    flushTextBuffer(true);
    if (!currentBlock) return;
    if (currentBlock.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: currentBlock.text,
        partial: output,
      });
    } else {
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: currentBlock.thinking,
        partial: output,
      });
    }
    currentBlock = null;
  };

  while (true) {
    const result = await reader.read();
    if (result.done) {
      buffer += decoder.decode();
      if (buffer && !buffer.endsWith("\n")) buffer += "\n";
    } else {
      if (!(result.value instanceof Uint8Array)) continue;
      buffer += decoder.decode(result.value, { stream: true });
    }

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n", scanStart)) !== -1) {
      const line = buffer.slice(scanStart, newlineIdx);
      scanStart = newlineIdx + 1;
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(json) as StreamChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        throw streamChunkError(chunk.error);
      }

      const responseData = chunk.response || chunk;
      const candidate = responseData.candidates?.[0];

      for (const part of candidate?.content?.parts || []) {
        // An empty text part carries no content and must not count as `received`
        // — otherwise an all-empty-parts response would skip the empty retry.
        if (part.text) {
          hasContent = true;
          const isThinking = part.thought === true;
          if (isThinking) {
            flushTextBuffer(true);
            if (!currentBlock || currentBlock.type !== "thinking") {
              finishCurrent();
              currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
              blocks.push(currentBlock);
              ensureStarted();
              stream.push({
                type: "thinking_start",
                contentIndex: blockIndex(),
                partial: output,
              });
            }
            if (currentBlock.type === "thinking") {
              currentBlock.thinking += part.text;
              if (part.thoughtSignature) currentBlock.thinkingSignature = part.thoughtSignature;
              stream.push({
                type: "thinking_delta",
                contentIndex: blockIndex(),
                delta: part.text,
                partial: output,
              });
            }
          } else {
            if (isBufferingText) {
              textBuffer += part.text;
              flushTextBuffer(false);
            } else if (part.text.trimStart().startsWith("{") && isPlanningLeakPrefix(part.text)) {
              isBufferingText = true;
              textBuffer = part.text;
              textBufferSignature = part.thoughtSignature;
              flushTextBuffer(false);
            } else {
              emitTextDelta(part.text, part.thoughtSignature);
            }
          }
        }

        if (part.functionCall) {
          hasContent = true;
          flushTextBuffer(true);
          finishCurrent();
          const rawId = part.functionCall.id || "";
          const toolCall: ToolCall = {
            type: "toolCall",
            id: sanitizeToolCallId(rawId, part.functionCall.name),
            name: part.functionCall.name || "",
            arguments: asToolCallArguments(part.functionCall.args),
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          };
          blocks.push(toolCall);
          ensureStarted();
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: JSON.stringify(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall,
            partial: output,
          });
        }
      }

      if (candidate?.finishReason) {
        rawStopReason = candidate.finishReason;
        output.stopReason = blocks.some((b) => b.type === "toolCall")
          ? StopReason.ToolUse
          : mapStopReason(candidate.finishReason);
      }

      if (responseData.usageMetadata) {
        const prompt = responseData.usageMetadata.promptTokenCount || 0;
        const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
        const thoughts = responseData.usageMetadata.thoughtsTokenCount || 0;
        output.usage.input = prompt - cacheRead;
        output.usage.output = (responseData.usageMetadata.candidatesTokenCount || 0) + thoughts;
        // OMP reads `reasoningTokens` (documented as Google's `thoughtsTokenCount`).
        // `usage.reasoning` is not part of the Usage contract and would be dropped
        // by OMP's usage accounting, telemetry, and cost breakdown.
        output.usage.reasoningTokens = thoughts;
        output.usage.cacheRead = cacheRead;
        output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
        if (model?.cost) {
          applyUsageCost(model, output.usage);
        } else {
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
      }

      if (responseData.responseId) {
        lastResponseId = responseData.responseId;
      }
    }

    if (scanStart > 0) {
      buffer = buffer.slice(scanStart);
      scanStart = 0;
    }
    if (result.done) break;
  }

  flushTextBuffer(true);
  finishCurrent();
  return { received: hasContent, rawStopReason, responseId: lastResponseId };
}
