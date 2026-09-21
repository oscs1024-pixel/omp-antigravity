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
  isPlaceholderProjectId,
  loadCodeAssist,
  parseApiKey,
  resolveProjectId,
  recordSuccessfulEndpoint,
} from "../client/client.js";
import {
  runWithDiagnostics,
  setLastAccountId,
  setLastEndpoint,
  setLastError,
  setLastErrorBody,
  setLastLatencyMs,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { getFallbackRuntimeModel, hasAntigravityRouting, PROVIDER_ID } from "../models/models.js";
import { safeError, writePrivateFileNoFollow } from "../utils/security.js";
import type { AntigravityStreamOptions } from "../types/types.js";
import { antigravityEnv, recordSessionExecutionId } from "../utils/util.js";
import { friendlyAntigravityError, isHardQuotaWall } from "./errors.js";
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
      setLastAccountId(creds.email);
      // A synthetic fallback project is not authoritative. Re-probe it so a
      // transient login-time discovery failure heals without requiring re-login.
      const credentialProjectId =
        creds.projectId && !isPlaceholderProjectId(creds.projectId) ? creds.projectId : undefined;
      const warmedProject = credentialProjectId ? null : await loadCodeAssist(creds.token);
      const projectId = resolveProjectId({
        warmedProject,
        credentialProjectId,
      });
      setLastProjectId(projectId);

      // Single source of truth for the requested effort: `disableReasoning`
      // overrides `reasoning`, exactly as `buildRequest` applies it below.
      const effort = resolveRequestedEffort(opts);
      // Same account-scoped routing lookup `resolveInitialRuntimeModel` uses, so
      // the "known model" shortcut can never disagree with the routing decision
      // made on the very next line.
      const isKnownModel = hasAntigravityRouting(model.id, projectId);
      const baseRuntimeModel = resolveInitialRuntimeModel(model.id, opts, projectId);

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
      const endpoints = endpointCandidates();

      let response: Response | undefined;
      let responseEndpoint: string | undefined;
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
          response = undefined;
          responseEndpoint = undefined;
          lastText = "";

          for (let endpointOffset = 0; endpointOffset < endpoints.length; endpointOffset++) {
            const endpoint = endpoints[(endpointOffset + emptyAttempt) % endpoints.length];
            setLastEndpoint(endpoint);
            try {
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
            } catch (error) {
              if (opts.signal?.aborted) throw error;
              lastText = safeError(error);
              setLastError(lastText);
              continue;
            }
            setLastStatus(response.status);
            if (response.ok) {
              responseEndpoint = endpoint;
              break;
            }
            lastText = await response.text();
            setLastErrorBody(lastText);
            if (response.status === 401 || response.status === 403) {
              break;
            }
            if (response.status === 429) {
              // A quota wall (account weekly/daily, or a per-model capacity window
              // measured in hours) is account-scoped: no sibling endpoint can serve
              // it, so failing fast leaves the credential block to OMP. A throttle
              // is endpoint-scoped — the sandbox and production pools fill
              // independently — so it keeps walking the candidate chain.
              if (isHardQuotaWall(lastText)) break;
              continue;
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
              await writePrivateFileNoFollow(
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
          recordSessionExecutionId(context, streamed.responseId, projectId);
        }
        if (received) {
          rawStopReason = streamed.rawStopReason;
          if (responseEndpoint) recordSuccessfulEndpoint(responseEndpoint);
          setLastError(undefined);
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
      let errStatus: number | undefined;
      if (error instanceof ProviderHttpError) {
        errStatus = error.status;
      } else if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof error.status === "number"
      ) {
        errStatus = error.status;
      }
      if (errStatus !== undefined) {
        output.errorStatus = errStatus;
      }
      setLastError(output.errorMessage);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  });

  return stream;
}
