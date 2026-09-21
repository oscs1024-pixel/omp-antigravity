import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  friendlyAntigravityError,
  isHardQuotaWall,
  mapStopReason,
  streamChunkError,
} from "../src/stream/errors.js";
import { StopReason } from "../src/types/enums.js";

describe("friendlyAntigravityError", () => {
  it("formats 429 quota exhaustion with reset window", () => {
    const errorMsg =
      '{"error":{"message":"Resource has been exhausted: Individual quota reached. Resets in 2h 45m."}}';
    const friendly = friendlyAntigravityError(429, errorMsg);
    assert.ok(friendly.includes("Quota reached."));
    assert.ok(friendly.includes("2h 45m"));
    // The reset window must stay in the backend's own "Resets in …" grammar:
    // OMP parses that phrasing (`extractProviderRetryHint`) to size the
    // credential block, and ignores "Please wait …".
    assert.match(friendly, /Resets in 2h 45m/);
  });

  it("formats 429 generic quota exceeded as hard limit", () => {
    const errorMsg = "Daily limit exceeded for this project.";
    const friendly = friendlyAntigravityError(429, errorMsg);
    assert.ok(friendly.includes("Quota reached."));
  });

  // Cloud Code Assist's per-model capacity wording reaches the plugin in two
  // shapes with opposite meanings: "…Your quota will reset after 2s" is a blip
  // that clears on its own, "…after 4h 30m" is a spent daily quota. Both used to
  // fall through to the bare "Rate limited by Antigravity (HTTP 429)" text, so
  // the user saw an unexplained 429 and an "retrying automatically" promise that
  // could not hold for hours.
  it("formats a multi-hour per-model capacity window as a quota wall with its window", () => {
    const errorMsg =
      '{"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 4h 30m.","status":"RESOURCE_EXHAUSTED"}}';
    const friendly = friendlyAntigravityError(429, errorMsg);
    assert.match(friendly, /^Quota reached\./);
    assert.match(friendly, /Resets in 4h 30m/);
  });

  it("formats a per-model capacity window of seconds as a retryable throttle", () => {
    for (const body of [
      '{"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 2s.","status":"RESOURCE_EXHAUSTED"}}',
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 30s."}}',
    ]) {
      const friendly = friendlyAntigravityError(429, body);
      assert.ok(!/Quota reached/i.test(friendly), `must not read as a quota wall: ${friendly}`);
      assert.match(friendly, /no capacity for this model/);
      assert.match(friendly, /429/);
      assert.match(friendly, /retrying automatically/);
      assert.ok(!/quota/i.test(friendly), `throttle wording must not mention quota: ${friendly}`);
      assert.ok(
        !/exhausted/i.test(friendly),
        `throttle wording must not echo the backend's exhausted token: ${friendly}`,
      );
    }
  });

  it("keeps a capacity window that clears in seconds out of the quota-wall grammar", () => {
    // "Resets in …" is the grammar OMP parses into a credential *block*; a
    // short-window throttle must not be armed with it.
    const friendly = friendlyAntigravityError(
      429,
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 2s."}}',
    );
    assert.match(friendly, /clears in 2s/);
    assert.ok(!/resets? in/i.test(friendly), `no block grammar on a throttle: ${friendly}`);
  });

  // Regression guard for the 429 transient/hard-limit split.
  //
  // OMP classifies the thrown ProviderHttpError by regex over its message
  // (`@oh-my-pi/pi-ai/src/error/rate-limit.ts`). `USAGE_LIMIT_PATTERN` matches
  // `/resource.?exhausted/i` and `quota`, so echoing the gRPC status name back
  // as the token "ResourceExhausted" makes OMP stamp `Flag.UsageLimit` on a
  // transient throttle. That disables the provider retry
  // (`isProviderRetryableError` bails on `isUsageLimit`) and routes the error to
  // credential rotation (`isUsageLimitOutcome`), which has no sibling to switch
  // to on a single-account setup. The transient wording must therefore stay free
  // of quota/exhausted tokens while keeping "rate limit" and the status code.
  it("formats 429 transient rate limit so retry backoff can engage", () => {
    const errorMsg = "Resource has been exhausted (e.g. check quota).";
    const friendly = friendlyAntigravityError(429, errorMsg);
    assert.match(friendly, /Rate limited by Antigravity/);
    assert.match(friendly, /429/);
    assert.ok(
      !/resource.?exhausted/i.test(friendly),
      `transient 429 must not echo a resource-exhausted token: ${friendly}`,
    );
    assert.ok(!/quota/i.test(friendly), `transient 429 must not mention quota: ${friendly}`);
    assert.ok(!/Quota reached/i.test(friendly), "transient 429 must not read as a quota wall");
  });

  it("keeps transient 429 wording free of quota tokens across throttle bodies", () => {
    for (const body of [
      "Too many requests, slow down.",
      "Rate limit reached, please slow down.",
      '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
    ]) {
      const friendly = friendlyAntigravityError(429, body);
      assert.match(friendly, /Rate limited by Antigravity/);
      assert.ok(!/resource.?exhausted/i.test(friendly), `unexpected exhausted token for: ${body}`);
      assert.ok(!/quota/i.test(friendly), `unexpected quota token for: ${body}`);
    }
  });

  it("extracts verification url on 403 VALIDATION_REQUIRED", () => {
    const json = JSON.stringify({
      error: {
        message: "Validation required",
        details: [
          {
            reason: "VALIDATION_REQUIRED",
            metadata: { validation_url: "https://cloud.google.com/verify?account=123" },
          },
        ],
      },
    });
    const friendly = friendlyAntigravityError(403, json);
    assert.ok(friendly.includes("Account verification required"));
    assert.ok(friendly.includes("https://cloud.google.com/verify?account=123"));
  });

  it("formats 403 permission denied", () => {
    const friendly = friendlyAntigravityError(403, "Access denied: permission missing");
    assert.ok(friendly.includes("Antigravity access was denied for this account or project"));
  });

  it("formats 401 authentication failed", () => {
    const friendly = friendlyAntigravityError(401, "Invalid credentials");
    assert.ok(friendly.includes("Antigravity authentication failed"));
  });

  it("formats 404 entity not found", () => {
    const friendly = friendlyAntigravityError(404, "Requested entity was not found.");
    assert.ok(friendly.includes("This model is not available right now"));
  });
});

describe("mapStopReason", () => {
  it("maps STOP to Stop", () => {
    assert.equal(mapStopReason("STOP"), StopReason.Stop);
  });

  it("maps MAX_TOKENS to Length", () => {
    assert.equal(mapStopReason("MAX_TOKENS"), StopReason.Length);
  });

  it("maps unknown reasons to Error", () => {
    assert.equal(mapStopReason("SAFETY"), StopReason.Error);
    assert.equal(mapStopReason(undefined), StopReason.Stop);
  });
});

describe("streamChunkError", () => {
  it("recovers HTTP status from numeric error.code", () => {
    const err = streamChunkError({
      code: 429,
      message: "Quota exceeded",
      status: "RESOURCE_EXHAUSTED",
    });
    assert.equal(err.status, 429);
  });

  it("maps Google status string when code is absent", () => {
    const err = streamChunkError({ status: "PERMISSION_DENIED", message: "denied" });
    assert.equal(err.status, 403);
  });

  it("falls back to 500 for unclassified errors", () => {
    const err = streamChunkError({ message: "something broke" });
    assert.equal(err.status, 500);
  });

  it("formats 429 stream chunks through friendlyAntigravityError", () => {
    const transientErr = streamChunkError({
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      status: "RESOURCE_EXHAUSTED",
    });
    assert.equal(transientErr.status, 429);
    assert.match(transientErr.message, /Rate limited by Antigravity/);
    assert.ok(!/resource.?exhausted/i.test(transientErr.message));
    assert.ok(!/quota/i.test(transientErr.message));

    const capacityBlipErr = streamChunkError({
      code: 429,
      message: "You have exhausted your capacity on this model. Your quota will reset after 2s.",
      status: "RESOURCE_EXHAUSTED",
    });
    assert.equal(capacityBlipErr.status, 429);
    assert.match(capacityBlipErr.message, /no capacity for this model.*clears in 2s/);
    assert.ok(!/quota/i.test(capacityBlipErr.message));

    const hardWallErr = streamChunkError({
      code: 429,
      message: "Individual quota reached. Resets in 2h 45m.",
      status: "RESOURCE_EXHAUSTED",
    });
    assert.equal(hardWallErr.status, 429);
    assert.match(hardWallErr.message, /^Quota reached\. Resets in 2h 45m/);
  });
  it("formats 403 VALIDATION_REQUIRED stream chunks with validation url", () => {
    const err = streamChunkError({
      code: 403,
      status: "PERMISSION_DENIED",
      message: JSON.stringify({
        error: {
          details: [
            {
              reason: "VALIDATION_REQUIRED",
              metadata: { validation_url: "https://accounts.google.com/verify" },
            },
          ],
        },
      }),
    });
    assert.equal(err.status, 403);
    assert.match(err.message, /https:\/\/accounts\.google\.com\/verify/);
  });
});

/**
 * Cross-check the 429 wording against the classifier OMP 18.x actually drives
 * retry and credential rotation with.
 *
 * The previous guard only exercised the legacy `isRetryableAssistantError` shim
 * (`@oh-my-pi/pi-coding-agent/src/extensibility/legacy-pi-ai-shim.ts`), which
 * reads "ResourceExhausted" as retryable. The live path —
 * `isProviderRetryableError` -> `isUsageLimit` -> `isUsageLimitOutcome` — reads
 * the same token as an account quota wall, so a transient throttle was silently
 * routed into credential rotation while the suite stayed green. Asserting the
 * real classifier is what closes that gap.
 */
describe("429 wording vs OMP's real error classifier", () => {
  type ModernClassifier = {
    isUsageLimit: (error: unknown) => boolean;
    isUsageLimitOutcome: (status: number | undefined, message: string | undefined) => boolean;
    isProviderRetryableError: (error: unknown) => boolean;
    ProviderHttpError: new (message: string, status: number) => Error;
  };

  async function resolveClassifier(): Promise<ModernClassifier | undefined> {
    try {
      const mod = (await import("@oh-my-pi/pi-ai/error")) as Record<string, unknown>;
      if (
        typeof mod.isProviderRetryableError !== "function" ||
        typeof mod.isUsageLimit !== "function" ||
        typeof mod.isUsageLimitOutcome !== "function" ||
        typeof mod.ProviderHttpError !== "function"
      ) {
        return undefined;
      }
      return mod as unknown as ModernClassifier;
    } catch {
      return undefined;
    }
  }

  /** Mirrors the throw shape in `src/stream/stream.ts`. */
  function asThrown(c: ModernClassifier, friendly: string, status: number): Error {
    const message = /^Quota reached\./.test(friendly)
      ? friendly
      : `Antigravity API error (${status}, endpoint=https://daily-cloudcode-pa.googleapis.com, project=aicode-consumers, runtimeModel=gemini-3.8-flash-high, matched=none, available=unknown): ${friendly}`;
    return new c.ProviderHttpError(message, status);
  }

  const TRANSIENT_BODIES = [
    "Resource has been exhausted (e.g. check quota).",
    "Too many requests, slow down.",
    "Rate limit reached, please slow down.",
    '{"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 2s."}}',
  ];
  const QUOTA_BODIES = [
    '{"error":{"message":"Quota exceeded. Resets in 6 days."}}',
    "You have exceeded your weekly limit.",
    '{"error":{"code":429,"message":"You have exhausted your capacity on this model. Your quota will reset after 4h 30m."}}',
  ];

  it("keeps transient 429 retryable and off the credential-rotation path", async () => {
    const c = await resolveClassifier();
    assert.ok(
      c,
      "expected @oh-my-pi/pi-ai/error to export isProviderRetryableError/isUsageLimit/isUsageLimitOutcome; re-verify the 429 wording contract if these moved",
    );
    for (const body of TRANSIENT_BODIES) {
      const error = asThrown(c, friendlyAntigravityError(429, body), 429);
      assert.equal(
        c.isUsageLimit(error),
        false,
        `transient 429 must not classify as a usage limit: ${body}`,
      );
      assert.equal(
        c.isProviderRetryableError(error),
        true,
        `transient 429 must stay provider-retryable: ${body}`,
      );
      assert.equal(
        c.isUsageLimitOutcome(429, error.message),
        false,
        `transient 429 must not rotate: ${body}`,
      );
    }
  });

  it("keeps real quota walls classified as usage limits so OMP rotates", async () => {
    const c = await resolveClassifier();
    assert.ok(c, "expected @oh-my-pi/pi-ai/error to export the modern error classifier");
    for (const body of QUOTA_BODIES) {
      const error = asThrown(c, friendlyAntigravityError(429, body), 429);
      assert.equal(
        c.isUsageLimit(error),
        true,
        `quota wall must classify as a usage limit: ${body}`,
      );
      assert.equal(
        c.isUsageLimitOutcome(429, error.message),
        true,
        `quota wall must rotate: ${body}`,
      );
    }
  });
});

/**
 * The predicate the streaming endpoint loop and the wording share. Its contract
 * is behavioral: a wall stops the endpoint fan-out and is reported as a quota,
 * a throttle keeps walking the candidate chain and stays retryable.
 */
describe("isHardQuotaWall", () => {
  it("classifies account quota walls and per-model capacity windows", () => {
    const walls = [
      '{"error":{"message":"Individual quota reached. Resets in 2h 45m."}}',
      '{"error":{"message":"Quota exceeded. Resets in 6 days."}}',
      "You have exceeded your weekly limit.",
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 4h 30m."}}',
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 1 week."}}',
      '{"error":{"message":"You have exhausted your capacity on this model."}}',
    ];
    for (const body of walls) {
      assert.equal(isHardQuotaWall(body), true, `expected a quota wall: ${body}`);
    }

    const throttles = [
      "Resource has been exhausted (e.g. check quota).",
      "Too many requests, slow down.",
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 2s."}}',
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 2s, please retry."}}',
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 30s."}}',
    ];
    for (const body of throttles) {
      assert.equal(isHardQuotaWall(body), false, `expected a throttle: ${body}`);
    }
  });

  it("honors a 4h30m window as a block-sized retry hint for the host", async () => {
    const utils = (await import("@oh-my-pi/pi-utils/fetch-retry").catch(() => undefined)) as
      { extractRetryHint: (headers: undefined, body: string) => number | undefined } | undefined;
    if (!utils) return;
    const friendly = friendlyAntigravityError(
      429,
      '{"error":{"message":"You have exhausted your capacity on this model. Your quota will reset after 4h 30m."}}',
    );
    const hint = utils.extractRetryHint(undefined, friendly);
    // A multi-hour wall must not collapse into OMP's 60s default block: that is
    // what let the credential be reselected and hammered mid-wall.
    assert.ok(hint !== undefined && hint >= 4 * 3_600_000, `unexpected wall hint: ${hint}`);
  });
});
