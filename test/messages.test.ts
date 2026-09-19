import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Context, Model, Api, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { convertMessages } from "../src/stream/messages.js";
import { clearSessionTrajectoryMap, resolveSessionTrajectory } from "../src/utils/util.js";

const claudeModel = {
  id: "claude-sonnet-4-6",
  provider: "antigravity",
  api: "antigravity",
} as unknown as Model<Api>;

function assistantWithToolCall(id: string, name: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: { q: 1 } }],
    api: "antigravity",
    provider: "antigravity",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  } as unknown as AssistantMessage;
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  };
}

describe("convertMessages empty toolCallId pairing", () => {
  it("pairs a generated functionCall id with its functionResponse id", () => {
    const context: Context = {
      messages: [assistantWithToolCall("", "read_file"), toolResult("", "read_file", "contents")],
    };
    const contents = convertMessages(claudeModel, context, "claude-sonnet-4-6");
    const callPart = contents.flatMap((c) => c.parts).find((p) => "functionCall" in p) as
      { functionCall: { id?: string } } | undefined;
    const responsePart = contents.flatMap((c) => c.parts).find((p) => "functionResponse" in p) as
      { functionResponse: { id?: string } } | undefined;
    assert.ok(callPart?.functionCall.id, "functionCall must carry a generated id");
    assert.equal(
      responsePart?.functionResponse.id,
      callPart?.functionCall.id,
      "functionResponse must reuse the paired functionCall id",
    );
  });

  it("pairs nth empty-id call with nth empty-id result in order", () => {
    const context: Context = {
      messages: [
        assistantWithToolCall("", "read_file"),
        assistantWithToolCall("", "write_file"),
        toolResult("", "read_file", "A"),
        toolResult("", "write_file", "B"),
      ],
    };
    const contents = convertMessages(claudeModel, context, "claude-sonnet-4-6");
    const calls = contents
      .flatMap((c) => c.parts)
      .filter((p) => "functionCall" in p)
      .map((p) => (p as { functionCall: { name: string; id?: string } }).functionCall);
    const responses = contents
      .flatMap((c) => c.parts)
      .filter((p) => "functionResponse" in p)
      .map((p) => (p as { functionResponse: { name: string; id?: string } }).functionResponse);
    assert.equal(calls.length, 2);
    assert.equal(responses.length, 2);
    for (const call of calls) {
      const match = responses.find((r) => r.name === call.name);
      assert.equal(match?.id, call.id, `${call.name} response must reuse its call id`);
    }
  });
});

describe("resolveSessionTrajectory seed hashing", () => {
  it("distinguishes conversations sharing the first 64 chars of the first message", () => {
    clearSessionTrajectoryMap();
    const prefix = "x".repeat(64);
    const contextA = {
      messages: [{ role: "user", timestamp: 1000, content: `${prefix} conversation A tail` }],
    };
    const contextB = {
      messages: [{ role: "user", timestamp: 1000, content: `${prefix} conversation B tail` }],
    };
    const trajA = resolveSessionTrajectory(contextA, "project-A");
    const trajB = resolveSessionTrajectory(contextB, "project-A");
    assert.notEqual(trajA.trajectoryId, trajB.trajectoryId);
    assert.notEqual(trajA.conversationId, trajB.conversationId);
  });

  it("is stable across calls for the same conversation", () => {
    clearSessionTrajectoryMap();
    const context = {
      messages: [{ role: "user", timestamp: 1000, content: "same opening" }],
    };
    const first = resolveSessionTrajectory(context, "project-A");
    const second = resolveSessionTrajectory(context, "project-A");
    assert.equal(first.trajectoryId, second.trajectoryId);
    assert.equal(first.sessionId, second.sessionId);
  });
});
