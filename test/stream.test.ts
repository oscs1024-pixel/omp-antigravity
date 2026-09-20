import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import type { Api, AssistantMessageEventStream, Context, Model } from "@oh-my-pi/pi-ai";
import {
  defaultProjectId,
  endpointCandidates,
  resetEndpointPreferenceForTests,
} from "../src/client/client.js";
import { streamAntigravity } from "../src/stream/stream.js";

const model = {
  id: "gemini-3.7-flash",
  provider: "antigravity",
  api: "antigravity",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
} as unknown as Model<Api>;

const context = {
  messages: [{ role: "user", content: "Reply briefly.", timestamp: 1 }],
} as unknown as Context;

const apiKey = JSON.stringify({ token: "stream-test-token", projectId: "stream-test-project" });

function successfulSseResponse(): Response {
  const payload = {
    response: {
      candidates: [
        {
          content: { parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
    },
  };
  return new Response(`data: ${JSON.stringify(payload)}\ndata: [DONE]\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

async function firstEventOrImmediateFailure(
  stream: AssistantMessageEventStream,
): Promise<{ type: string }> {
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = immediate().then(() => {
    throw new Error("stream did not emit an event in the current event-loop turn");
  });
  const next = await Promise.race([iterator.next(), deadline]);
  assert.equal(next.done, false);
  return next.value as { type: string };
}

describe("streamAntigravity endpoint lifecycle", () => {
  const originalFetch = globalThis.fetch;

  it("emits an error instead of rethrowing invalid endpoint configuration from its catch path", async () => {
    const previous = process.env.ANTIGRAVITY_BASE_URL;
    process.env.ANTIGRAVITY_BASE_URL = "http://untrusted.example.test";
    try {
      const event = await firstEventOrImmediateFailure(
        streamAntigravity(model, context, { apiKey }),
      );
      assert.equal(event.type, "error");
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_BASE_URL;
      else process.env.ANTIGRAVITY_BASE_URL = previous;
    }
  });

  it("parses a final SSE data line even when EOF has no trailing newline", async () => {
    let calls = 0;
    const payload = {
      response: {
        candidates: [
          {
            content: { parts: [{ text: "tail-ok" }] },
            finishReason: "STOP",
          },
        ],
      },
    };
    globalThis.fetch = (async () => {
      calls++;
      return new Response(`data: ${JSON.stringify(payload)}`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;

    try {
      const events: string[] = [];
      for await (const event of streamAntigravity(model, context, { apiKey })) {
        events.push(event.type);
      }
      assert.equal(calls, 1);
      assert.ok(events.includes("text_delta"));
      assert.ok(events.includes("done"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("re-discovers a real project from placeholder credentials", async () => {
    const previousProject = process.env.ANTIGRAVITY_PROJECT_ID;
    delete process.env.ANTIGRAVITY_PROJECT_ID;
    const seenProjects: string[] = [];
    const placeholderKey = JSON.stringify({
      token: "stream-placeholder-token",
      projectId: defaultProjectId(),
    });

    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1internal:loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "stream-recovered-project",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1internal:streamGenerateContent")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { project?: string };
        if (body.project) seenProjects.push(body.project);
        return successfulSseResponse();
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      for await (const _event of streamAntigravity(model, context, { apiKey: placeholderKey })) {
        // consume
      }
      assert.deepEqual(seenProjects, ["stream-recovered-project"]);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousProject === undefined) delete process.env.ANTIGRAVITY_PROJECT_ID;
      else process.env.ANTIGRAVITY_PROJECT_ID = previousProject;
    }
  });

  it("tries the next endpoint after a transport failure and records the verified SSE endpoint", async () => {
    resetEndpointPreferenceForTests();
    const candidates = endpointCandidates();
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      requested.push(String(input));
      if (requested.length === 1) throw new TypeError("simulated connection failure");
      return successfulSseResponse();
    }) as typeof fetch;

    try {
      const events: string[] = [];
      for await (const event of streamAntigravity(model, context, { apiKey })) {
        events.push(event.type);
      }
      assert.equal(requested.length, 2);
      assert.ok(requested[0]!.startsWith(candidates[0]!));
      assert.ok(requested[1]!.startsWith(candidates[1]!));
      assert.equal(endpointCandidates()[0], candidates[1]);
      assert.ok(events.includes("done"));
    } finally {
      globalThis.fetch = originalFetch;
      resetEndpointPreferenceForTests();
    }
  });
});
