import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError, ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import {
  antigravityHeaders,
  endpointCandidates,
  fetchAvailableRuntimeModel,
  formatRequestDiagnostics,
  isRetryableEndpointStatus,
  loadCodeAssist,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  getCurrentEndpoint,
  runWithDiagnostics,
  setLastEndpoint,
  setLastError,
  setLastLatencyMs,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import {
  getCurrentAntigravityRouting,
  getFallbackRuntimeModel,
  PROVIDER_ID,
} from "../models/models.js";
import { safeError } from "../utils/security.js";
import type { AntigravityStreamOptions } from "../types/types.js";
import { antigravityEnv, recordSessionExecutionId } from "../utils/util.js";
import { friendlyAntigravityError } from "./errors.js";
import { fetchWithHeaderDeadline, streamHeaderTimeoutMs, streamStallTimeoutMs } from "./fetch.js";
import { buildRequest, resolveInitialRuntimeModel, resolveRequestedEffort } from "./request.js";
import { createOutput, streamResponse } from "./response.js";

// Re-export all submodule symbols for backwards compatibility across tests and callers
export * from "./constants.js";
export * from "./cost.js";
export * from "./errors.js";
export * from "./fetch.js";
export * from "./leak-detector.js";
export * from "./messages.js";
export * from "./request.js";
export * from "./response.js";
export * from "./schema.js";

export function streamAntigravity(
  model: Model<Api>,
  context: Context,
  options?: AntigravityStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const opts = options ?? {};

  void runWithDiagnostics(async () => {
    const startTime = Date.now();
    const output = createOutput(model);
    try {
      // OMP resolves an `ApiKeyResolver` to a string before provider dispatch, so
      // `apiKey` is a string here in practice. Guard anyway: a resolver that leaks
      // through must fail with a clear message instead of being stringified into a
      // `Bearer function …` header.
      const apiKeyRaw = typeof opts.apiKey === "string" ? opts.apiKey : undefined;
      if (opts.apiKey !== undefined && apiKeyRaw === undefined) {
        throw new Error(
          "Antigravity received an unresolved API-key resolver. Re-run /login antigravity.",
        );
      }
      const creds = parseApiKey(apiKeyRaw);
      // Skip loadCodeAssist roundtrip when credentials already carry a projectId.
      const warmedProject = creds.projectId ? null : await loadCodeAssist(creds.token);
      const projectId = resolveProjectId({
        token: creds.token,
        warmedProject,
        credentialProjectId: creds.projectId,
      });
      setLastProjectId(projectId);

      // Single source of truth for the requested effort: `disableReasoning`
      // overrides `reasoning`, exactly as `buildRequest` applies it below.
      const effort = resolveRequestedEffort(opts);
      const isKnownModel = model.id in getCurrentAntigravityRouting();
      const baseRuntimeModel = resolveInitialRuntimeModel(model.id, opts);

      let initialRuntimeModel = baseRuntimeModel;
      // Skip pre-flight model discovery for known static models to optimize TTFT latency.
      // Dynamic lookup is only needed for unmapped custom models.
      if (!isKnownModel && !antigravityEnv("RUNTIME_MODEL")) {
        const dynamic = await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel);
        if (dynamic?.id && /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)) {
          initialRuntimeModel = dynamic.id;
        }
      }

      const runtimeCandidates = [initialRuntimeModel];
      const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
      if (fallback && fallback !== initialRuntimeModel) {
        runtimeCandidates.push(fallback);
      }

      const requestHeaders = antigravityHeaders(creds.token);

      let response: Response | undefined;
      let lastText = "";
      let received = false;
      let rawStopReason: string | undefined;
      let runtimeModel = initialRuntimeModel;

      for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
        if (opts.signal?.aborted) throw new Error("Request was aborted");
        if (emptyAttempt > 0) {
          const delay = 500 * 2 ** (emptyAttempt - 1);
          await new Promise((res) => setTimeout(res, delay));
        }

        for (let candIdx = 0; candIdx < runtimeCandidates.length; candIdx++) {
          runtimeModel = runtimeCandidates[candIdx]!;
          setLastResolvedRuntimeModel(runtimeModel);
          const body = JSON.stringify(buildRequest(model, context, projectId, opts, runtimeModel));

          for (const endpoint of endpointCandidates()) {
            setLastEndpoint(endpoint);
            response = await fetchWithHeaderDeadline(
              `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
              {
                method: "POST",
                headers: requestHeaders,
                body,
              },
              opts.signal,
              streamHeaderTimeoutMs(),
              streamStallTimeoutMs(),
            );
            setLastStatus(response.status);
            if (response.ok) break;
            lastText = await response.text();
            if (response.status === 401 || response.status === 403) {
              break;
            }
            if (
              response.status === 429 &&
              (/Individual quota reached/i.test(lastText) ||
                /Resets? in /i.test(lastText) ||
                (!/rate.?limit/i.test(lastText) &&
                  /quota exceeded|exceeded your|daily limit/i.test(lastText)))
            ) {
              break;
            }
            // Only retry across endpoints for 404 (model candidate may exist on another endpoint)
            // or transient server errors (500, 502, 503, 504).
            if (!isRetryableEndpointStatus(response.status)) break;
          }

          if (response?.ok) break;
          if (response?.status === 404) {
            if (candIdx + 1 < runtimeCandidates.length) {
              continue;
            }
            if (isKnownModel && candIdx === runtimeCandidates.length - 1) {
              const dynamic = await fetchAvailableRuntimeModel(
                creds.token,
                projectId,
                baseRuntimeModel,
              );
              if (
                dynamic?.id &&
                !runtimeCandidates.includes(dynamic.id) &&
                /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)
              ) {
                runtimeCandidates.push(dynamic.id);
                continue;
              }
            }
          }
          break;
        }

        if (!response || !response.ok) {
          if (antigravityEnv("DEBUG_DUMP") === "1") {
            try {
              const body = JSON.stringify(
                buildRequest(model, context, projectId, opts, runtimeModel),
              );
              let parsedBody: unknown = body;
              try {
                parsedBody = JSON.parse(body) as unknown;
              } catch {
                parsedBody = body;
              }
              await (
                await import("node:fs/promises")
              ).writeFile(
                "/tmp/antigravity-last-request.json",
                JSON.stringify(
                  {
                    status: response?.status,
                    runtimeModel,
                    lastText: lastText.slice(0, 4000),
                    body: parsedBody,
                  },
                  null,
                  2,
                ),
              );
            } catch {
              // ignore dump failures
            }
          }
          const friendly = friendlyAntigravityError(response?.status, lastText);
          if (response?.status === 429 && /Quota reached\./i.test(friendly)) {
            throw new ProviderHttpError(friendly, 429);
          }
          const httpStatus = response?.status ?? 0;
          throw new ProviderHttpError(
            `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}`,
            httpStatus,
          );
        }

        output.content = [];
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        output.stopReason = "stop";

        const streamed = await streamResponse(response, stream, output, model, context);
        received = streamed.received;
        if (streamed.responseId) {
          recordSessionExecutionId(context, streamed.responseId);
        }
        if (received) {
          rawStopReason = streamed.rawStopReason;
          break;
        }
      }

      if (!received)
        throw new ProviderResponseError("Antigravity API returned an empty response", {
          provider: PROVIDER_ID,
          kind: "empty-body",
        });
      setLastLatencyMs(Date.now() - startTime);
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        const errorDetail = rawStopReason
          ? `Provider stopped with: ${rawStopReason}`
          : "An unknown error occurred";
        output.errorMessage = output.errorMessage || errorDetail;
        setLastError(output.errorMessage);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (error) {
      setLastLatencyMs(Date.now() - startTime);
      output.stopReason = opts.signal?.aborted ? "aborted" : "error";
      output.errorMessage = safeError(error);
      setLastError(output.errorMessage);
      // Ensure endpoint is recorded even if failure happened before setLastEndpoint.
      if (!getCurrentEndpoint() && endpointCandidates()[0]) {
        setLastEndpoint(endpointCandidates()[0]);
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  });

  return stream;
}
