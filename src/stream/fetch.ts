import { antigravityFetch } from "../utils/http.js";
import { antigravityEnv } from "../utils/util.js";
import { STREAM_HEADER_TIMEOUT_DEFAULT_MS, STREAM_STALL_TIMEOUT_DEFAULT_MS } from "./constants.js";

function envTimeoutMs(name: string, fallback: number): number {
  const raw = antigravityEnv(name);
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

/**
 * Streaming header deadline in milliseconds, from ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS
 * (or the legacy NOAGY_ prefix). 0 disables the deadline; invalid values fall back
 * to the default.
 */
export function streamHeaderTimeoutMs(): number {
  return envTimeoutMs("STREAM_HEADER_TIMEOUT_MS", STREAM_HEADER_TIMEOUT_DEFAULT_MS);
}

/**
 * Mid-body stall deadline in milliseconds, from ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS
 * (legacy NOAGY_ prefix honored). 0 disables. A healthy SSE stream emits bytes
 * continuously while generating, so a silent gap this long means the connection
 * is dead even though headers arrived — abort with a named error rather than
 * hanging until an external process timeout.
 */
export function streamStallTimeoutMs(): number {
  return envTimeoutMs("STREAM_STALL_TIMEOUT_MS", STREAM_STALL_TIMEOUT_DEFAULT_MS);
}

function stallError(stallMs: number): Error {
  return new Error(`stream stalled: no data for ${stallMs}ms`);
}

/**
 * Guard a response body against mid-stream stalls while retaining caller
 * cancellation until the body finishes or is cancelled. The wrapper reads only
 * when its consumer pulls, preserving backpressure; its timer is unref'd so an
 * armed deadline cannot keep the process alive.
 */
export function guardResponseBody(
  response: Response,
  controller: AbortController,
  stallMs: number,
  cleanup: () => void,
): Response {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    cleanup();
  };
  const reset = () => {
    if (stallMs <= 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(stallError(stallMs)), stallMs);
    timer.unref?.();
  };
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abortBody = () => {
    streamController?.error(controller.signal.reason);
    void reader.cancel(controller.signal.reason).catch(() => undefined);
    finish();
  };
  controller.signal.addEventListener("abort", abortBody, { once: true });
  reset();
  const guarded = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    async pull(streamController) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          streamController.close();
          return;
        }
        if (!(chunk.value instanceof Uint8Array)) {
          throw new Error("Response body yielded an invalid chunk");
        }
        reset();
        streamController.enqueue(chunk.value);
      } catch (error) {
        finish();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
  return new Response(guarded, response);
}

/**
 * Fetch with a response-header deadline and a mid-body stall watchdog. A server
 * can accept a request on a warm keep-alive socket and then never send response
 * headers (header phase), or send headers and then go silent mid-body (stall
 * phase); either way the request is aborted with a named error instead of
 * hanging until an external process timeout. Long healthy responses are never
 * cut: the header timer disarms once headers arrive, and the stall timer resets
 * on every chunk, so only genuine silence aborts.
 *
 * Exported with an injectable fetch for unit tests.
 */
export async function fetchWithHeaderDeadline(
  url: string,
  init: RequestInit,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  stallMs: number = 0,
  fetchFn: (input: string, init: RequestInit) => Promise<Response> = antigravityFetch,
): Promise<Response> {
  if (timeoutMs <= 0 && stallMs <= 0) {
    return fetchFn(url, { ...init, signal: callerSignal ?? init.signal });
  }
  const controller = new AbortController();
  const forward = () => controller.abort(callerSignal?.reason);
  const cleanup = () => callerSignal?.removeEventListener("abort", forward);
  callerSignal?.addEventListener("abort", forward, { once: true });
  if (callerSignal?.aborted) forward();
  const timer =
    timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new Error(`no response headers within ${timeoutMs}ms`)),
          timeoutMs,
        )
      : undefined;
  let responseBodyGuarded = false;
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    responseBodyGuarded = Boolean(response.body);
    return guardResponseBody(response, controller, stallMs, cleanup);
  } finally {
    if (timer) clearTimeout(timer);
    if (!responseBodyGuarded) cleanup();
  }
}
