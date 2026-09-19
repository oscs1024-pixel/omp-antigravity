import { antigravityEnv } from "./util.js";

/**
 * Request path for every Antigravity call.
 *
 * The runtime is Bun (`@oh-my-pi/pi-coding-agent` declares `engines.bun`), and Bun's
 * `fetch` keeps connections pooled well past the 4-second idle window that made a
 * custom keep-alive dispatcher worthwhile under Node. A private `undici.Agent` was
 * tried and removed: Bun reports `process.versions.node` >= 22, so the guard that
 * skipped the Agent on modern runtimes made the branch dead code, and Node's bundled
 * fetch rejects an npm `undici` Agent outright (`TypeError: fetch failed`) — while
 * attaching one would also have bypassed the host's own proxy-aware dispatcher.
 *
 * Keeping a thin wrapper (instead of calling `fetch` directly) preserves one seam for
 * tests and leaves room for per-request policy, without owning transport behaviour.
 */

const PREWARM_TIMEOUT_MS = 5_000;

/** fetch() as used for this provider's requests. Delegates to the host's fetch. */
export function antigravityFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, init);
}

/**
 * Combine a caller's cancellation signal with an HTTP deadline.
 *
 * Every request path in this plugin is bounded. The streaming path has its own
 * header/stall watchdog; the remaining calls (OAuth token exchange, image
 * generation) use this so a stalled endpoint surfaces as an error instead of an
 * indefinite hang with no diagnostic.
 */
export function withDeadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Open the connection when the extension loads so the first message of a session does
 * not pay the DNS + TCP + TLS setup. Best-effort: failures are ignored.
 */
export function prewarmConnection(url: string): void {
  if (antigravityEnv("NO_PREWARM") === "1") return;
  void (async () => {
    try {
      const res = await antigravityFetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
      // Release the socket back to the pool even though HEAD carries no body.
      await res.arrayBuffer();
    } catch {
      // Warm-up only; the real request will establish the connection instead.
    }
  })();
}
