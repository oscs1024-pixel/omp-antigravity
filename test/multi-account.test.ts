import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveFallbackEmail } from "../src/auth/oauth.js";
import {
  getLastDiagnostics,
  resetDiagnosticsForTests,
  runWithDiagnostics,
  setLastError,
  setLastProjectId,
  setLastStatus,
} from "../src/diagnostics/diagnostics.js";
import { applyAntigravityCatalog, getAntigravityRequestModelId } from "../src/models/models.js";
import { ThinkingEffort } from "../src/types/enums.js";
import type { AccountUsage } from "../src/types/types.js";
import { formatAccountQuotaSummary } from "../src/usage/usage.js";
import {
  clearSessionTrajectoryMap,
  recordSessionExecutionId,
  resolveSessionTrajectory,
} from "../src/utils/util.js";

describe("deriveFallbackEmail", () => {
  it("generates collision-free deterministic emails from refresh tokens", () => {
    const email1 = deriveFallbackEmail("token_alpha_123");
    const email2 = deriveFallbackEmail("token_beta_456");
    const email1Again = deriveFallbackEmail("token_alpha_123");

    assert.notEqual(email1, email2, "Different tokens must produce different emails");
    assert.equal(email1, email1Again, "Same token must produce identical email");
    assert.ok(email1.startsWith("antigravity-"), "Email must start with antigravity- prefix");
    assert.ok(email1.endsWith("@oauth.local"), "Email must end with @oauth.local");
  });
});

describe("resolveSessionTrajectory & recordSessionExecutionId multi-account isolation", () => {
  it("isolates lastExecutionId between different projectIds in the same session", () => {
    clearSessionTrajectoryMap();
    const context = {
      messages: [{ role: "user", timestamp: 1700000000, content: "Hello world multi-turn" }],
    };

    // Account A executes turn 1
    const trajA = resolveSessionTrajectory(context, "project-A");
    assert.equal(trajA.lastExecutionId, undefined);
    recordSessionExecutionId(context, "exec-id-account-A", "project-A");
    assert.equal(trajA.lastExecutionId, "exec-id-account-A");

    // Session auto-rotates to Account B (e.g. on 429 quota exhaustion)
    const trajB = resolveSessionTrajectory(context, "project-B");
    assert.notEqual(trajA.trajectoryId, trajB.trajectoryId);
    assert.equal(
      trajB.lastExecutionId,
      undefined,
      "Account B must not inherit Account A's execution ID",
    );

    // Account B records its own response execution ID
    recordSessionExecutionId(context, "exec-id-account-B", "project-B");
    assert.equal(trajB.lastExecutionId, "exec-id-account-B");
    assert.equal(trajA.lastExecutionId, "exec-id-account-A");
  });
});

describe("applyAntigravityCatalog per-project routing", () => {
  it("routes requests to project-specific runtime models when configured", () => {
    const catalogA = {
      models: [
        {
          id: "gemini-custom",
          name: "Gemini Custom",
          reasoning: true,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      routing: {
        "gemini-custom": {
          off: "runtime-a-low",
          routing: {
            [ThinkingEffort.Low]: "runtime-a-low",
            [ThinkingEffort.High]: "runtime-a-high",
          },
          defaultRequestId: "runtime-a-low",
        },
      },
    };

    const catalogB = {
      models: [
        {
          id: "gemini-custom",
          name: "Gemini Custom",
          reasoning: true,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        },
      ],
      routing: {
        "gemini-custom": {
          off: "runtime-b-low",
          routing: {
            [ThinkingEffort.Low]: "runtime-b-low",
            [ThinkingEffort.High]: "runtime-b-high",
          },
          defaultRequestId: "runtime-b-low",
        },
      },
    };

    applyAntigravityCatalog(catalogA, "project-A");
    applyAntigravityCatalog(catalogB, "project-B");

    const reqA = getAntigravityRequestModelId("gemini-custom", ThinkingEffort.High, "project-A");
    const reqB = getAntigravityRequestModelId("gemini-custom", ThinkingEffort.High, "project-B");

    assert.equal(reqA, "runtime-a-high");
    assert.equal(reqB, "runtime-b-high");
  });
});

describe("diagnostics per-project scoping", () => {
  it("stores and retrieves diagnostics scoped to projectId", async () => {
    resetDiagnosticsForTests();

    await runWithDiagnostics(async () => {
      setLastProjectId("project-A");
      setLastStatus(200);
      setLastError(undefined);
    });

    await runWithDiagnostics(async () => {
      setLastProjectId("project-B");
      setLastStatus(429);
      setLastError("Quota reached");
    });

    const diagA = getLastDiagnostics("project-A");
    const diagB = getLastDiagnostics("project-B");

    assert.equal(diagA.projectId, "project-A");
    assert.equal(diagA.status, 200);

    assert.equal(diagB.projectId, "project-B");
    assert.equal(diagB.status, 429);
    assert.equal(diagB.error, "Quota reached");
  });
});

describe("formatAccountQuotaSummary", () => {
  it("formats paid tier with bucket percentages", () => {
    const usage: AccountUsage = {
      projectId: "proj-1",
      endpoint: "https://daily-cloudcode-pa.googleapis.com",
      planLabel: "Google AI Pro",
      groups: [
        {
          displayName: "Quota Group",
          buckets: [
            {
              bucketId: "gemini",
              displayName: "Gemini",
              remainingFraction: 0.95,
            },
            {
              bucketId: "claude",
              displayName: "Claude/GPT",
              remainingFraction: 0.5,
              resetTime: new Date(Date.now() + 3600000).toISOString(),
            },
          ],
        },
      ],
      models: [],
      fetchedAt: Date.now(),
    };

    const summary = formatAccountQuotaSummary(usage);
    assert.ok(summary.includes("[Google AI Pro]"));
    assert.ok(summary.includes("Gemini: 95%"));
    assert.ok(summary.includes("Claude/GPT: 50%"));
  });

  it("handles free-tier 403 gracefully", () => {
    const usage: AccountUsage = {
      projectId: "proj-free",
      endpoint: "https://daily-cloudcode-pa.googleapis.com",
      quotaSummaryError: "403 SUBSCRIPTION_REQUIRED: Paid subscription required",
      groups: [],
      models: [],
      fetchedAt: Date.now(),
    };

    const summary = formatAccountQuotaSummary(usage);
    assert.equal(summary, "Free Tier (quota summary requires paid subscription)");
  });
});
