import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import registerExtension from "../src/index.js";
import { deriveFallbackEmail } from "../src/auth/oauth.js";
import {
  getLastDiagnostics,
  resetDiagnosticsForTests,
  runWithDiagnostics,
  setLastError,
  setLastProjectId,
  setLastStatus,
} from "../src/diagnostics/diagnostics.js";
import {
  applyAntigravityCatalog,
  getAntigravityRequestModelId,
  getModelEnum,
  registerModelEnum,
} from "../src/models/models.js";
import { ThinkingEffort } from "../src/types/enums.js";
import type { AccountUsage } from "../src/types/types.js";
import { formatAccountQuotaSummary } from "../src/usage/usage.js";
import {
  clearSessionTrajectoryMap,
  recordSessionExecutionId,
  resolveSessionTrajectory,
  setWithCap,
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
describe("setWithCap LRU cache utility", () => {
  it("evicts oldest entry when size exceeds capacity", () => {
    const map = new Map<string, number>();
    setWithCap(map, "a", 1, 3);
    setWithCap(map, "b", 2, 3);
    setWithCap(map, "c", 3, 3);
    assert.equal(map.size, 3);
    assert.deepEqual(Array.from(map.keys()), ["a", "b", "c"]);

    // Adding 4th entry evicts "a"
    setWithCap(map, "d", 4, 3);
    assert.equal(map.size, 3);
    assert.equal(map.has("a"), false);
    assert.deepEqual(Array.from(map.keys()), ["b", "c", "d"]);
  });

  it("updates existing key and refreshes recency order", () => {
    const map = new Map<string, number>();
    setWithCap(map, "a", 1, 3);
    setWithCap(map, "b", 2, 3);
    setWithCap(map, "c", 3, 3);

    // Re-setting "a" makes it the newest
    setWithCap(map, "a", 10, 3);
    assert.deepEqual(Array.from(map.keys()), ["b", "c", "a"]);
    assert.equal(map.get("a"), 10);

    // Adding "d" should now evict "b", not "a"
    setWithCap(map, "d", 4, 3);
    assert.equal(map.has("b"), false);
    assert.equal(map.has("a"), true);
    assert.deepEqual(Array.from(map.keys()), ["c", "a", "d"]);
  });

  it("uses default capacity of 64", () => {
    const map = new Map<number, number>();
    for (let i = 0; i < 70; i += 1) {
      setWithCap(map, i, i);
    }
    assert.equal(map.size, 64);
    assert.equal(map.has(0), false);
    assert.equal(map.has(5), false);
    assert.equal(map.has(6), true);
    assert.equal(map.has(69), true);
  });
});

describe("dynamic model enum cache", () => {
  it("evicts old enum entries after reaching its capacity", () => {
    for (let i = 0; i < 65; i += 1) {
      registerModelEnum(`dynamic-cap-test-${i}`, `DYNAMIC_CAP_TEST_${i}`);
    }

    assert.equal(getModelEnum("dynamic-cap-test-0"), undefined);
    assert.equal(getModelEnum("dynamic-cap-test-64"), "DYNAMIC_CAP_TEST_64");
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
    assert.ok(summary.startsWith("Plan: Google AI Pro\n"));
    assert.match(summary, /Gemini\s+95% left\s+\[##########\]/);
    assert.match(summary, /Claude\/GPT\s+50% left\s+\[#####-----\]/);
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
  it("formats multiple groups with generic limit labels cleanly", () => {
    const usage: AccountUsage = {
      projectId: "proj-real",
      endpoint: "https://daily-cloudcode-pa.googleapis.com",
      planLabel: "Google AI Pro (g1-pro-tier)",
      groups: [
        {
          displayName: "Gemini models",
          buckets: [
            {
              bucketId: "five-hour",
              displayName: "Five Hour Limit Remaining",
              remainingFraction: 0.55,
              resetTime: new Date(Date.now() + 4 * 3600000 + 25 * 60000).toISOString(),
            },
            {
              bucketId: "weekly",
              displayName: "Weekly Limit Remaining",
              remainingFraction: 0.62,
              resetTime: new Date(Date.now() + 5 * 86400000 + 21 * 3600000).toISOString(),
            },
          ],
        },
        {
          displayName: "Claude and other models",
          buckets: [
            {
              bucketId: "five-hour",
              displayName: "Five Hour Limit Remaining",
              remainingFraction: 1.0,
              resetTime: new Date(Date.now() + 5 * 3600000).toISOString(),
            },
            {
              bucketId: "weekly",
              displayName: "Weekly Limit Remaining",
              remainingFraction: 0.67,
              resetTime: new Date(Date.now() + 6 * 86400000 + 2 * 3600000).toISOString(),
            },
          ],
        },
      ],
      models: [],
      fetchedAt: Date.now(),
    };

    const summary = formatAccountQuotaSummary(usage);
    assert.ok(summary.startsWith("Plan: Google AI Pro (g1-pro-tier)\n"));
    assert.match(summary, /Gemini\n  5h\s+55% left\s+\[######----\]/);
    assert.match(summary, /Weekly\s+62% left\s+\[######----\]/);
    assert.match(summary, /Claude\/Other\n  5h\s+100% left\s+\[##########\]/);
    assert.match(summary, /Weekly\s+67% left\s+\[#######---\]/);
  });
  it("formats validation-required accounts with account verification link", () => {
    const usage: AccountUsage = {
      projectId: "aicode-consumers",
      endpoint: "https://daily-cloudcode-pa.googleapis.com",
      planLabel: "Google AI Pro (g1-pro-tier)",
      groups: [],
      quotaSummaryError:
        "/v1internal:retrieveUserQuotaSummary failed (403): Verify your account to continue.",
      validationUrl:
        "https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini",
      models: [],
      fetchedAt: Date.now(),
    };

    const summary = formatAccountQuotaSummary(usage);
    assert.ok(summary.startsWith("Plan: Google AI Pro (g1-pro-tier)\n"));
    assert.ok(summary.includes("Account verification required:"));
    assert.ok(summary.includes("https://accounts.google.com/signin/continue"));
  });
});

describe("antigravity.accounts command output formatting", () => {
  it("renders green dot indicator for active account and provides switch examples", async () => {
    type CommandEntry = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
    const registeredCommands: Record<string, CommandEntry> = {};
    const dummyNode: Record<string, unknown> = {};
    dummyNode.describe = () => dummyNode;
    dummyNode.optional = () => dummyNode;
    const dummyZod = {
      object: () => dummyNode,
      string: () => dummyNode,
      enum: () => dummyNode,
    };
    const mockPi = {
      setLabel: () => {},
      zod: dummyZod,
      registerProvider: () => {},
      registerCommand: (name: string, config: unknown) => {
        registeredCommands[name] = config as CommandEntry;
      },
      registerTool: () => {},
    } as unknown as ExtensionAPI;

    registerExtension(mockPi);
    assert.ok(
      registeredCommands["antigravity.accounts"],
      "antigravity.accounts command must be registered",
    );

    const emitted: string[] = [];
    const mockCtx = {
      hasUI: true,
      ui: {
        notify: (msg: string) => emitted.push(msg),
      },
      sessionManager: {
        getSessionId: () => "test-session-123",
      },
      modelRegistry: {
        authStorage: {
          listOAuthAccounts: () => [
            {
              position: 0,
              credentialId: 101,
              email: "vulnhubs@gmail.com",
              projectId: "aicode-consumers",
              active: true,
            },
            {
              position: 1,
              credentialId: 102,
              email: "oscs1024@gmail.com",
              projectId: "aicode-consumers",
              active: false,
            },
          ],
          exportSnapshot: () => ({
            credentials: [
              {
                id: 101,
                provider: "antigravity",
                credential: {
                  type: "oauth",
                  access: "mock-token-1",
                  expires: Date.now() + 3600000,
                  projectId: "aicode-consumers",
                },
              },
              {
                id: 102,
                provider: "antigravity",
                credential: {
                  type: "oauth",
                  access: "mock-token-2",
                  expires: Date.now() + 3600000,
                  projectId: "aicode-consumers",
                },
              },
            ],
          }),
        },
      },
    } as unknown as ExtensionCommandContext;

    await registeredCommands["antigravity.accounts"].handler("", mockCtx);

    const output = emitted.join("\n");
    assert.ok(output.includes("Antigravity Accounts (2 stored)"));
    assert.ok(output.includes("\x1b[32m●\x1b[0m #1: vulnhubs@gmail.com"));
    assert.ok(output.includes("[ACTIVE]"));
    assert.ok(output.includes("○ #2: oscs1024@gmail.com"));
    assert.ok(output.includes("\n      Project: aicode-consumers\n"));
    assert.ok(output.includes("Switch account:\n  /antigravity.accounts <number|email>"));
    assert.ok(output.includes("Example: /antigravity.accounts 2"));
  });
  it("displays neutral no-pin status when no account is explicitly active", async () => {
    type CommandEntry = { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> };
    const registeredCommands: Record<string, CommandEntry> = {};
    const dummyNode: Record<string, unknown> = {};
    dummyNode.describe = () => dummyNode;
    dummyNode.optional = () => dummyNode;
    const dummyZod = {
      object: () => dummyNode,
      string: () => dummyNode,
      enum: () => dummyNode,
    };
    const mockPi = {
      setLabel: () => {},
      zod: dummyZod,
      registerProvider: () => {},
      registerCommand: (name: string, config: unknown) => {
        registeredCommands[name] = config as CommandEntry;
      },
      registerTool: () => {},
    } as unknown as ExtensionAPI;

    registerExtension(mockPi);

    const emitted: string[] = [];
    const mockCtx = {
      hasUI: false,
      sessionManager: {
        getSessionId: () => "test-session-456",
      },
      modelRegistry: {
        authStorage: {
          listOAuthAccounts: () => [
            {
              position: 0,
              credentialId: 201,
              email: "vulnhubs@gmail.com",
              projectId: "aicode-consumers",
              active: false,
            },
            {
              position: 1,
              credentialId: 202,
              email: "oscs1024@gmail.com",
              projectId: "aicode-consumers",
              active: false,
            },
          ],
          exportSnapshot: () => ({
            credentials: [
              {
                id: 201,
                provider: "antigravity",
                credential: {
                  type: "oauth",
                  access: "mock-token-1",
                  expires: Date.now() + 3600000,
                  projectId: "aicode-consumers",
                },
              },
              {
                id: 202,
                provider: "antigravity",
                credential: {
                  type: "oauth",
                  access: "mock-token-2",
                  expires: Date.now() + 3600000,
                  projectId: "aicode-consumers",
                },
              },
            ],
          }),
        },
      },
    } as unknown as ExtensionCommandContext;

    const originalLog = console.log;
    console.log = (msg: string) => {
      emitted.push(msg);
    };

    try {
      await registeredCommands["antigravity.accounts"].handler("", mockCtx);
    } finally {
      console.log = originalLog;
    }

    const output = emitted.join("\n");
    assert.ok(output.includes("no pin — host auto-selects"));
    assert.ok(!output.includes("[ACTIVE]"));
    assert.ok(!output.includes("\x1b[32m●\x1b[0m"));
  });
});
