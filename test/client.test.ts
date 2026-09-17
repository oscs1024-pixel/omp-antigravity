import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AntigravityHttpError,
  buildModelMatchRegex,
  isRetryableEndpointStatus,
  postAntigravityJson,
  type PostJsonResponse,
} from "../src/client/client.js";

describe("buildModelMatchRegex", () => {
  describe("special aliases", () => {
    it("matches gemini-pro-agent to 3.1 pro high and agent runtime", () => {
      const re = buildModelMatchRegex("gemini-pro-agent");
      assert.ok(re.test("Gemini 3.1 Pro (High)"));
      assert.ok(re.test("gemini-pro-agent"));
      assert.ok(!re.test("Gemini 3.5 Flash (High)"));
    });

    it("matches gemini-3-flash-agent to 3.5 flash high and agent runtime", () => {
      const re = buildModelMatchRegex("gemini-3-flash-agent");
      assert.ok(re.test("Gemini 3.5 Flash (High)"));
      assert.ok(re.test("gemini-3-flash-agent"));
      assert.ok(!re.test("Gemini 3.1 Pro (High)"));
    });

    it("matches gemini-3.5-flash-extra-low to low or extra-low", () => {
      const re = buildModelMatchRegex("gemini-3.5-flash-extra-low");
      assert.ok(re.test("Gemini 3.5 Flash (Extra Low)"));
      assert.ok(re.test("Gemini 3.5 Flash (Low)"));
      assert.ok(re.test("gemini-3.5-flash-extra-low"));
      assert.ok(!re.test("Gemini 3.5 Flash (High)"));
    });

    it("matches gemini-3.5-flash-low to medium variant", () => {
      const re = buildModelMatchRegex("gemini-3.5-flash-low");
      assert.ok(re.test("Gemini 3.5 Flash (Medium)"));
      assert.ok(re.test("gemini-3.5-flash-low"));
      assert.ok(re.test("gemini-3.5-flash-medium"));
      assert.ok(!re.test("Gemini 3.5 Flash (High)"));
    });

    it("matches gemini-3.5-flash-high to high variant", () => {
      const re = buildModelMatchRegex("gemini-3.5-flash-high");
      assert.ok(re.test("Gemini 3.5 Flash (High)"));
      assert.ok(re.test("gemini-3.5-flash-high"));
      assert.ok(!re.test("Gemini 3.5 Flash (Medium)"));
    });

    it("matches claude and gpt-oss aliases", () => {
      assert.ok(buildModelMatchRegex("claude-opus-4-6").test("Claude Opus 4.6"));
      assert.ok(buildModelMatchRegex("claude-sonnet-4-6").test("Claude Sonnet 4.6"));
      assert.ok(buildModelMatchRegex("gpt-oss-120b").test("GPT OSS 120B"));
    });
  });

  describe("generic level suffix parsing (future-proof models)", () => {
    it("matches gemini-3.9-flash-low in wire id and display name form", () => {
      const re = buildModelMatchRegex("gemini-3.9-flash-low");
      assert.ok(re.test("gemini-3.9-flash-low"));
      assert.ok(re.test("Gemini 3.9 Flash (Low)"));
      assert.ok(!re.test("Gemini 3.9 Flash (High)"));
      assert.ok(!re.test("gemini-3.8-flash-low"));
    });

    it("matches gemini-3.9-flash-extra-low and allows low fallback", () => {
      const re = buildModelMatchRegex("gemini-3.9-flash-extra-low");
      assert.ok(re.test("gemini-3.9-flash-extra-low"));
      assert.ok(re.test("Gemini 3.9 Flash (Extra Low)"));
      assert.ok(re.test("Gemini 3.9 Flash (Low)"));
      assert.ok(!re.test("Gemini 3.9 Flash (High)"));
    });

    it("matches gemini-4.0-flash-high", () => {
      const re = buildModelMatchRegex("gemini-4.0-flash-high");
      assert.ok(re.test("gemini-4.0-flash-high"));
      assert.ok(re.test("Gemini 4.0 Flash (High)"));
      assert.ok(!re.test("Gemini 4.0 Flash (Medium)"));
    });

    it("matches gemini-4.0-pro-medium", () => {
      const re = buildModelMatchRegex("gemini-4.0-pro-medium");
      assert.ok(re.test("gemini-4.0-pro-medium"));
      assert.ok(re.test("Gemini 4.0 Pro (Medium)"));
      assert.ok(!re.test("Gemini 4.0 Pro (Low)"));
    });

    it("matches minimal and extra-high levels", () => {
      const minRe = buildModelMatchRegex("gemini-3.9-flash-minimal");
      assert.ok(minRe.test("Gemini 3.9 Flash (Minimal)"));
      assert.ok(minRe.test("gemini-3.9-flash-minimal"));

      const xhRe = buildModelMatchRegex("gemini-3.9-flash-extra-high");
      assert.ok(xhRe.test("Gemini 3.9 Flash (Extra High)"));
      assert.ok(xhRe.test("gemini-3.9-flash-extra-high"));
    });

    it("does not let -extra-low greedily match -low", () => {
      const re = buildModelMatchRegex("gemini-3.9-flash-extra-low");
      // Suffix parsing must not strip just "-low" leaving "-extra" on base
      assert.ok(!re.test("gemini-3.9-flash-extra (High)"));
    });
  });

  describe("unsuffixed models", () => {
    it("matches bare model ids and display names", () => {
      const re = buildModelMatchRegex("gemini-3.8-flash");
      assert.ok(re.test("gemini-3.8-flash"));
      assert.ok(re.test("Gemini 3.8 Flash"));
      assert.ok(!re.test("gemini-3.7-flash"));
    });
  });
});

describe("isRetryableEndpointStatus", () => {
  it("treats 404 and 5xx transient server errors as retryable across endpoints", () => {
    assert.equal(isRetryableEndpointStatus(404), true);
    assert.equal(isRetryableEndpointStatus(500), true);
    assert.equal(isRetryableEndpointStatus(502), true);
    assert.equal(isRetryableEndpointStatus(503), true);
    assert.equal(isRetryableEndpointStatus(504), true);
  });

  it("treats auth, permission, quota, and client errors as non-retryable across endpoints", () => {
    assert.equal(isRetryableEndpointStatus(401), false);
    assert.equal(isRetryableEndpointStatus(403), false);
    assert.equal(isRetryableEndpointStatus(429), false);
    assert.equal(isRetryableEndpointStatus(400), false);
    assert.equal(isRetryableEndpointStatus(422), false);
    assert.equal(isRetryableEndpointStatus(200), false);
  });
});

describe("postAntigravityJson retry policy", () => {
  const originalFetch = globalThis.fetch;

  it("fails immediately on 401 or 403 without trying remaining endpoints", async () => {
    let callCount = 0;
    const requestedUrls: string[] = [];

    globalThis.fetch = (async (input: string | URL) => {
      callCount++;
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ error: { message: "PERMISSION_DENIED" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        async () => {
          await postAntigravityJson("/v1internal:loadCodeAssist", "fake-token", {});
        },
        (err: unknown) => {
          assert.ok(err instanceof AntigravityHttpError);
          assert.equal(err.status, 403);
          return true;
        },
      );
      assert.equal(callCount, 1, "Should have made exactly 1 call and stopped on 403");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails immediately on 429 quota reached without trying remaining endpoints", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount++;
      return new Response(
        JSON.stringify({ error: { message: "Resource has been exhausted: quota reached" } }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    try {
      await assert.rejects(
        async () => {
          await postAntigravityJson("/v1internal:loadCodeAssist", "fake-token", {});
        },
        (err: unknown) => {
          assert.ok(err instanceof AntigravityHttpError);
          assert.equal(err.status, 429);
          return true;
        },
      );
      assert.equal(callCount, 1, "Should have made exactly 1 call and stopped on 429");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries on 404 or 500 across endpoints until success", async () => {
    let callCount = 0;

    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(JSON.stringify({ projectId: "proj-123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const res = (await postAntigravityJson(
        "/v1internal:loadCodeAssist",
        "fake-token",
        {},
      )) as PostJsonResponse<{ projectId: string }>;
      assert.equal(res.status, 200);
      assert.equal(res.data.projectId, "proj-123");
      assert.equal(callCount, 2, "Should have retried after 404 and succeeded on second endpoint");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
