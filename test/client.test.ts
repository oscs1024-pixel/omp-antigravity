import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AntigravityHttpError,
  AntigravityAccountIneligibleError,
  buildModelMatchRegex,
  endpointCandidates,
  fetchAvailableModelsCatalog,
  hasProvisionedTier,
  isRetryableEndpointStatus,
  loadCodeAssist,
  onboardUser,
  postAntigravityJson,
  recordSuccessfulEndpoint,
  resetEndpointPreferenceForTests,
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

describe("catalog endpoint failures", () => {
  const originalFetch = globalThis.fetch;

  it("surfaces the real endpoint error when every catalog request fails", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "VALIDATION_REQUIRED" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => fetchAvailableModelsCatalog("catalog-failure-token", "project"),
        (error: unknown) => {
          assert.ok(error instanceof AntigravityHttpError);
          assert.equal(error.status, 403);
          assert.match(error.message, /VALIDATION_REQUIRED/);
          return true;
        },
      );
      assert.equal(calls, endpointCandidates().length);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the selected endpoint after parallel discovery completes", async () => {
    resetEndpointPreferenceForTests();
    const candidates = endpointCandidates();
    recordSuccessfulEndpoint(candidates[1]!);
    const selected = endpointCandidates()[0];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ models: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    try {
      await fetchAvailableModelsCatalog("catalog-priority-token", "project");
      assert.equal(endpointCandidates()[0], selected);
    } finally {
      globalThis.fetch = originalFetch;
      resetEndpointPreferenceForTests();
    }
  });
});

describe("endpoint preference", () => {
  it("moves the last successful fallback endpoint to the front", () => {
    resetEndpointPreferenceForTests();
    const endpoints = endpointCandidates();
    assert.ok(endpoints.length > 1);
    recordSuccessfulEndpoint(endpoints[1]!);
    assert.equal(endpointCandidates()[0], endpoints[1]);
    resetEndpointPreferenceForTests();
  });
});

describe("loadCodeAssist project cache", () => {
  const originalFetch = globalThis.fetch;

  it("recovers on the next discovery call after a transient failure", async () => {
    let attempt = 0;
    globalThis.fetch = (async () => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: "temporary failure" } }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ projectId: "recovered-project" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      assert.equal(await loadCodeAssist("transient-failure-token"), undefined);
      assert.equal(await loadCodeAssist("transient-failure-token"), "recovered-project");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("free-tier onboarding", () => {
  const originalFetch = globalThis.fetch;
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("reads a missing currentTier as unprovisioned", () => {
    assert.equal(hasProvisionedTier({ currentTier: { id: "free-tier" } }), true);
    assert.equal(hasProvisionedTier({ currentTier: null }), false);
    assert.equal(hasProvisionedTier({ cloudaicompanionProject: "project" }), false);
    assert.equal(hasProvisionedTier(undefined), false);
  });

  it("polls the onboardUser operation until it reports done", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (requests.length === 1) {
        return jsonResponse({ name: "operations/onboard-1", done: false });
      }
      return jsonResponse({
        name: "operations/onboard-1",
        done: true,
        response: { cloudaicompanionProject: "project" },
      });
    }) as typeof fetch;

    try {
      await onboardUser("onboard-poll-token");
      assert.equal(requests.length, 2);
      assert.equal(
        requests[0],
        "POST https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser",
      );
      assert.equal(
        requests[1],
        "GET https://daily-cloudcode-pa.googleapis.com/v1internal/operations/onboard-1",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when the operation reports an error", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        name: "operations/onboard-2",
        done: true,
        error: { code: 7, message: "PERMISSION_DENIED" },
      })) as typeof fetch;

    try {
      await assert.rejects(
        () => onboardUser("onboard-error-token"),
        /onboardUser failed: 7: PERMISSION_DENIED/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("provisions before reading the project when currentTier is absent", async () => {
    const loadCodeAssistCalls: number[] = [];
    const sawOnboard: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("onboardUser")) {
        sawOnboard.push(url);
        return jsonResponse({
          name: "operations/onboard-3",
          done: true,
          response: { cloudaicompanionProject: "project" },
        });
      }
      loadCodeAssistCalls.push(loadCodeAssistCalls.length + 1);
      return loadCodeAssistCalls.length === 1
        ? jsonResponse({ allowedTiers: [{ id: "free-tier" }] })
        : jsonResponse({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "provisioned-project",
          });
    }) as typeof fetch;

    try {
      assert.equal(await loadCodeAssist("onboarding-token"), "provisioned-project");
      assert.equal(sawOnboard.length, 1, "onboarding must run before the project is re-read");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not onboard or enumerate projects for an explicitly ineligible tier", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      requests.push(String(input));
      return jsonResponse({
        ineligibleTiers: [
          {
            id: "free-tier",
            reasonMessage: "Account verification is required.",
            validationUrl: "https://accounts.google.com/verify",
          },
        ],
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => loadCodeAssist("ineligible-tier-token"),
        (error: unknown) => {
          assert.ok(error instanceof AntigravityAccountIneligibleError);
          assert.match(error.message, /Account verification is required/);
          assert.match(error.message, /https:\/\/accounts\.google\.com\/verify/);
          return true;
        },
      );
      assert.equal(requests.length, 1);
      assert.match(requests[0]!, /loadCodeAssist/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the project loadCodeAssist already returned when onboarding fails", async () => {
    globalThis.fetch = (async (input: string | URL) =>
      String(input).includes("onboardUser")
        ? jsonResponse({ error: { message: "PERMISSION_DENIED" } }, 403)
        : jsonResponse({ cloudaicompanionProject: "existing-project" })) as typeof fetch;

    try {
      assert.equal(await loadCodeAssist("onboarding-failure-token"), "existing-project");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
