import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { friendlyAntigravityError, mapStopReason } from "../src/stream/errors.js";
import { StopReason } from "../src/types/enums.js";

describe("friendlyAntigravityError", () => {
  it("formats 429 quota exhaustion with reset window", () => {
    const errorMsg =
      '{"error":{"message":"Resource has been exhausted: Individual quota reached. Resets in 2h 45m."}}';
    const friendly = friendlyAntigravityError(429, errorMsg);
    assert.ok(friendly.includes("Quota reached."));
    assert.ok(friendly.includes("2h 45m"));
  });

  it("formats 429 generic quota exceeded as hard limit", () => {
    const errorMsg = "Daily limit exceeded for this project.";
    const friendly = friendlyAntigravityError(429, errorMsg);
    assert.ok(friendly.includes("Quota reached."));
  });

  it("formats 429 transient rate limit so retry backoff can engage", () => {
    const errorMsg = "Resource has been exhausted (e.g. check quota).";
    const friendly = friendlyAntigravityError(429, errorMsg);
    assert.ok(friendly.includes("Rate limited by Antigravity (429 ResourceExhausted)"));
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
