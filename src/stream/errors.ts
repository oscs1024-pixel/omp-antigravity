import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { jsonOrTextError } from "../client/client.js";
import { StopReason } from "../types/enums.js";
import { redactSecrets } from "../utils/security.js";

/** Exported for unit tests. */
export function mapStopReason(reason: string | undefined): StopReason {
  if (reason === "STOP") return StopReason.Stop;
  if (reason === "MAX_TOKENS") return StopReason.Length;
  return reason ? StopReason.Error : StopReason.Stop;
}

/** Exported for unit tests. */
export function friendlyAntigravityError(status: number | undefined, text: string): string {
  const msg = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/Requests ending with a model turn are not supported/i.test(msg)) {
      return "Antigravity rejected an invalid conversation message boundary. Next: update the extension or add a user message / start a new session, then retry.";
    }
    if (
      /function call turn comes immediately after a user turn or after a function response turn/i.test(
        msg,
      )
    ) {
      return "Antigravity rejected an invalid function-call message boundary. Next: update the extension or start a new session, then retry; re-login is not required.";
    }
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
      return "Antigravity login expired or credentials are invalid. Next: run /login antigravity, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(msg)) {
      return `Antigravity request format was rejected by the backend (${msg}). Next: switch to a simpler model or retry after updating the extension.`;
    }
    if (/Request contains an invalid argument/i.test(msg)) {
      return `Antigravity rejected this request (${msg}). Next: retry once; if it keeps failing, switch models or re-login.`;
    }
    return `Bad request from Antigravity. Next: retry once, then run /login antigravity if it keeps failing. Backend said: ${msg}`;
  }
  if (status === 401) {
    return "Antigravity authentication failed. Next: run /login antigravity, then retry.";
  }
  if (status === 403) {
    if (text.includes("VALIDATION_REQUIRED")) {
      const start = text.indexOf("{");
      if (start !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start)) as {
            error?: {
              details?: Array<{ reason?: string; metadata?: { validation_url?: string } }>;
            };
          };
          const validationUrl = parsed.error?.details?.find(
            (d) =>
              d.reason === "VALIDATION_REQUIRED" && typeof d.metadata?.validation_url === "string",
          )?.metadata?.validation_url;
          if (validationUrl) {
            return `Account verification required. Visit ${validationUrl} to continue, then retry your request.`;
          }
        } catch {
          // not JSON
        }
      }
    }
    if (/permission|forbidden|access/i.test(msg)) {
      return "Antigravity access was denied for this account or project. Next: try another model, re-login, or use an account with access.";
    }
    return `Antigravity denied this request. Next: re-login or try another model. Backend said: ${msg}`;
  }
  if (status === 404) {
    if (/Requested entity was not found/i.test(msg)) {
      return "This model is not available right now. Next: switch to gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-3.1-pro, or another working model.";
    }
    return `Antigravity could not find the requested resource. Next: retry or switch models. Backend said: ${msg}`;
  }
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) {
    return "Antigravity reported a conflict for this request. Next: retry once or start a new chat session.";
  }
  if (status === 429) {
    const wait = msg.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (/Individual quota reached/i.test(msg)) {
      return `Quota reached.${wait ? ` Resets in ${wait}.` : ""} Next: switch models or try again after reset.`;
    }
    // Google answers a real quota wall with a "Resets in …" hint, but uses generic
    // RESOURCE_EXHAUSTED ("Resource has been exhausted (e.g. check quota).") for
    // transient throttling and capacity pressure. Classifying on the word "quota"
    // alone wrongly marked transient throttling as a hard quota wall, disabling
    // OMP's automatic retry backoff. Keep real quota walls non-retryable, and
    // format transient throttling so OMP's retry mechanism engages.
    //
    // This wording is load-bearing, not cosmetic. OMP classifies the thrown
    // ProviderHttpError by running regexes over its message
    // (`@oh-my-pi/pi-ai/src/error/rate-limit.ts`), and `USAGE_LIMIT_PATTERN`
    // contains `/resource.?exhausted/i`. Spelling the gRPC status out as the
    // single token "ResourceExhausted" therefore stamps `Flag.UsageLimit` on a
    // transient throttle, and OMP then:
    //   1. refuses the provider-level retry — `isProviderRetryableError` returns
    //      false the moment `isUsageLimit(error)` is true; and
    //   2. reads it as an account quota wall — `isUsageLimitOutcome` drives
    //      `rotateSessionCredential` -> `markUsageLimitReached`, which blocks the
    //      credential and rotates to a sibling instead of backing off. With one
    //      logged-in account there is no sibling, the turn dies, and the 60s block
    //      keeps subsequent attempts failing too.
    // Verified against pi-ai 18.2.1: the transient text must avoid
    // "exhausted"/"quota", while "rate limit" plus the bare status code are what
    // make OMP treat it as transient and apply its rate-limit backoff.
    const hardLimit =
      Boolean(wait) ||
      (!/rate.?limit/i.test(msg) &&
        /quota exceeded|exceeded your|limit reached|reached your|daily limit/i.test(msg));
    if (hardLimit) {
      // Emit the backend's own "Resets in …" phrasing verbatim: OMP parses it
      // (`extractProviderRetryHint` -> `WILL_RESET_IN_PATTERN`) to size the
      // credential block. "Please wait …" is not a grammar OMP recognizes, which
      // silently collapsed a multi-hour quota wall into the 60s default block and
      // let the credential be reselected and hammered.
      return `Quota reached.${wait ? ` Resets in ${wait}.` : ""} Next: switch models or retry later.`;
    }
    return "Rate limited by Antigravity (HTTP 429). Next: retrying automatically; if it persists, switch models.";
  }
  if (status === 500) {
    return "Antigravity had an internal server error. Next: retry in a moment or switch models.";
  }
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry in a moment.";
  if (status === 503) {
    if (/No capacity available/i.test(msg)) {
      return "This model has no capacity right now. Next: retry later or switch to another model.";
    }
    return "Antigravity is temporarily unavailable. Next: retry in a moment or switch models.";
  }
  if (status === 504) return "Antigravity timed out upstream. Next: retry in a moment.";
  return msg;
}

/** Google wire `status` strings mapped to their HTTP status code. */
const GOOGLE_STATUS_TO_HTTP: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  ABORTED: 409,
  RESOURCE_EXHAUSTED: 429,
  CANCELLED: 499,
  INTERNAL: 500,
  UNIMPLEMENTED: 501,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

/**
 * Build a typed error from an SSE `error` chunk. Mid-stream errors arrive as
 * data events rather than an HTTP status line, so the status has to be
 * recovered from the payload (`error.code` numeric, or `error.status` like
 * `RESOURCE_EXHAUSTED`) — otherwise downstream layers (including OMP's
 * quota-based account rotation) cannot classify the failure.
 */
export function streamChunkError(error: {
  message?: string;
  code?: number;
  status?: string;
}): ProviderHttpError {
  const message = redactSecrets(error.message || JSON.stringify(error)).slice(0, 500);
  const status =
    (typeof error.code === "number" && error.code >= 400 && error.code < 600 && error.code) ||
    (error.status ? GOOGLE_STATUS_TO_HTTP[error.status] : undefined) ||
    500;
  return new ProviderHttpError(`Antigravity stream error: ${message}`, status, {
    code: error.status,
  });
}
