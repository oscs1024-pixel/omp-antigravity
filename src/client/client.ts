import {
  getCurrentAvailableModels,
  getCurrentEndpoint,
  getCurrentMatchedModelDebug,
  setLastAvailableModels,
  setLastEndpoint,
  setLastError,
  setLastMatchedModelDebug,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { assertSafeApiBaseUrl, safeError } from "../utils/security.js";
import type { AntigravityApiKey, AvailableModelsRaw, DynamicModelInfo } from "../types/types.js";
import { antigravityEnv, asString, escapeRegExp, isRecord, stableUuid } from "../utils/util.js";
import { antigravityFetch } from "../utils/http.js";
import { registerDiscoveredModelEnums } from "../models/models.js";

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
/** Ordered endpoint candidates; module-private since `endpointCandidates` is the accessor. */
const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
let lastGoodEndpoint: string | undefined;

const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
/** Hard cap on cached (token) project id lookups; oldest entries are dropped first. */
const PROJECT_CACHE_MAX_ENTRIES = 64;
const projectCache = new Map<string, { projectId: string; expiresAt: number }>();

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
/** Hard cap on cached (token, project, model) lookups; oldest entries are dropped first. */
const MODEL_CACHE_MAX_ENTRIES = 64;
const modelCache = new Map<string, { result: DynamicModelInfo | undefined; expiresAt: number }>();

/** Metadata lookups (project/model discovery, onboarding) must be fast; a stalled
 * endpoint should fall through to the next candidate instead of hanging the whole
 * request. Exported so every metadata call site shares one deadline. */
export const DISCOVERY_TIMEOUT_MS = 8000;

/** In-flight de-dupe: concurrent requests for the same (token, project, model) share one probe. */
const inFlightModelLookups = new Map<string, Promise<DynamicModelInfo | undefined>>();

/** UUID-shaped stable id from a seed. Never seeded from process.cwd(). */
export function stableProjectId(seed: string): string {
  return stableUuid(`antigravity:${seed}`);
}

/**
 * Seed for the synthetic placeholder project id.
 *
 * Deliberately a single constant rather than something account-derived: the
 * placeholder is computed independently on the discovery path (which only ever
 * sees a bare access token) and on the request path (which reads the stored
 * credential), so any account-specific seed would make those two disagree and
 * split one account across two per-project routing buckets.
 */
const FALLBACK_PROJECT_SEED = "antigravity-default";
const FALLBACK_PROJECT_ID = stableProjectId(FALLBACK_PROJECT_SEED);

/**
 * Whether a project id is the synthetic fallback rather than a project resolved
 * from Google. Treat it as missing on later requests so a transient discovery
 * failure can heal automatically instead of poisoning the credential forever.
 */
export function isPlaceholderProjectId(projectId: string | undefined): boolean {
  return projectId?.trim() === FALLBACK_PROJECT_ID;
}

/**
 * Fallback project id when discovery fails.
 * Prefer ANTIGRAVITY_PROJECT_ID, then the shared stable placeholder.
 */
export function defaultProjectId(): string {
  return antigravityEnv("PROJECT_ID")?.trim() || FALLBACK_PROJECT_ID;
}

/** @deprecated Use defaultProjectId(); kept for backwards compatibility. */
export const DEFAULT_PROJECT_ID = defaultProjectId();

export function endpointCandidates(): string[] {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  if (explicit) return [assertSafeApiBaseUrl(explicit)];
  if (!lastGoodEndpoint || !ENDPOINT_FALLBACKS.includes(lastGoodEndpoint)) {
    return [...ENDPOINT_FALLBACKS];
  }
  return [
    lastGoodEndpoint,
    ...ENDPOINT_FALLBACKS.filter((endpoint) => endpoint !== lastGoodEndpoint),
  ];
}

export function recordSuccessfulEndpoint(endpoint: string): void {
  if (ENDPOINT_FALLBACKS.includes(endpoint)) {
    lastGoodEndpoint = endpoint;
  }
}

export function resetEndpointPreferenceForTests(): void {
  lastGoodEndpoint = undefined;
}

const DEFAULT_USER_AGENT =
  "antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)";

/** Default User-Agent matching pure Antigravity CLI wire fingerprint. */
export function defaultUserAgent(): string {
  return DEFAULT_USER_AGENT;
}

/** HTTP headers for Antigravity API requests matching CLI wire traffic. */
export function antigravityHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
  };
}

export interface PostJsonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Internal: callers aggregating parallel endpoints select the winner explicitly. */
  recordSuccess?: boolean;
  /** Internal: parallel probes must not race the shared diagnostics snapshot. */
  recordDiagnostics?: boolean;
}

export interface PostJsonResponse<T = unknown> {
  endpoint: string;
  status: number;
  data: T;
}

export class AntigravityHttpError extends Error {
  status: number;
  endpoint: string;
  data?: unknown;

  constructor(message: string, status: number, endpoint: string, data?: unknown) {
    super(message);
    this.name = "AntigravityHttpError";
    this.status = status;
    this.endpoint = endpoint;
    this.data = data;
  }
}

export class AntigravityAccountIneligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityAccountIneligibleError";
  }
}

/**
 * Returns true only for HTTP status codes that indicate endpoint-specific
 * transient errors (404 Not Found, 500 Internal, 502 Bad Gateway, 503 Service
 * Unavailable, 504 Gateway Timeout).
 *
 * Account/auth errors (401, 403) and quota/rate limits (429) are account-level
 * and MUST NOT be retried across candidate endpoints.
 */
export function isRetryableEndpointStatus(status: number): boolean {
  return status === 404 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Send one JSON request to a specific Antigravity endpoint.
 *
 * Shared core for the two verbs this provider speaks: the metadata/turn RPCs are
 * POSTs, while long-running-operation polling after `onboardUser` is a GET.
 */
async function requestEndpointJson<T = unknown>(
  endpoint: string,
  path: string,
  token: string,
  method: "GET" | "POST",
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResponse<T>> {
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signal =
    options.signal && timeout
      ? AbortSignal.any([options.signal, timeout])
      : (options.signal ?? timeout);

  const res = await antigravityFetch(`${endpoint}${path}`, {
    method,
    headers: {
      ...antigravityHeaders(token),
      Accept: "application/json",
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (options.recordDiagnostics !== false) {
    setLastEndpoint(endpoint);
    setLastStatus(res.status);
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const errorBody = isRecord(data) ? (data as { error?: { message?: string } }) : undefined;
    const message = typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
    if (options.recordDiagnostics !== false) setLastError(message);
    throw new AntigravityHttpError(
      `${path} failed (${String(res.status)}): ${message.slice(0, 300)}`,
      res.status,
      endpoint,
      data,
    );
  }
  if (options.recordSuccess !== false) recordSuccessfulEndpoint(endpoint);

  return { endpoint, status: res.status, data: data as T };
}

/** Send a single POST JSON request to a specific Antigravity endpoint. */
export async function postEndpointJson<T = unknown>(
  endpoint: string,
  path: string,
  token: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResponse<T>> {
  return requestEndpointJson<T>(endpoint, path, token, "POST", body, options);
}

/**
 * Iterate through endpointCandidates() in priority order.
 * - 2xx: returns immediately.
 * - 401, 403, 429, or client 4xx: throws immediately (account/quota-level, non-retryable across endpoints).
 * - 404, 500-504, or network errors: retries on next candidate endpoint.
 */
async function requestAntigravityJson<T = unknown>(
  path: string,
  token: string,
  method: "GET" | "POST",
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResponse<T>> {
  const endpoints = endpointCandidates();
  let lastErrorText = "";
  for (const endpoint of endpoints) {
    try {
      return await requestEndpointJson<T>(endpoint, path, token, method, body, options);
    } catch (error) {
      if (options.signal?.aborted) {
        throw error;
      }
      lastErrorText = safeError(error);
      if (error instanceof AntigravityHttpError) {
        if (!isRetryableEndpointStatus(error.status)) {
          throw error;
        }
        // Retryable status across endpoints (404, 500, 502, 503, 504) -> try next endpoint
        continue;
      }
      // Network/abort/fetch error without HTTP status -> try next endpoint
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

/** POST JSON across endpoint candidates, per {@link requestAntigravityJson}. */
export async function postAntigravityJson<T = unknown>(
  path: string,
  token: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResponse<T>> {
  return requestAntigravityJson<T>(path, token, "POST", body, options);
}

/** GET JSON across endpoint candidates, per {@link requestAntigravityJson}. */
export async function getAntigravityJson<T = unknown>(
  path: string,
  token: string,
  options: PostJsonOptions = {},
): Promise<PostJsonResponse<T>> {
  return requestAntigravityJson<T>(path, token, "GET", undefined, options);
}

export function jsonOrTextError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; status?: string; code?: number };
    };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // not JSON
  }
  return text;
}

export function parseApiKey(apiKeyRaw: string | undefined): AntigravityApiKey {
  if (!apiKeyRaw) {
    throw new Error("No Antigravity OAuth credentials. Run /login antigravity.");
  }
  let parsed: Partial<AntigravityApiKey> | undefined;
  try {
    parsed = JSON.parse(apiKeyRaw) as Partial<AntigravityApiKey>;
  } catch {
    // Not JSON — fall through to the bare-token form below.
  }
  if (parsed?.token) {
    // Structured form from getApiKey(): {token, projectId, email}. A missing
    // projectId is not fatal — callers fall back to loadCodeAssist discovery.
    return {
      token: parsed.token,
      projectId: parsed.projectId ?? "",
      email: parsed.email,
    };
  }
  // OMP's AuthStorage.peekApiKey hands OAuth access tokens to extension
  // fetchDynamicModels as a bare string (no JSON wrapper), so accept that form
  // too and let callers discover the project id.
  return { token: apiKeyRaw, projectId: "" };
}

export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project;
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct.id);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item);
        if (nested) return nested;
        const itemId = asString(item);
        if (itemId) return itemId;
      }
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(
  token: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await postAntigravityJson(
      "/v1internal:listCloudAICompanionProjects",
      token,
      {},
      { signal, timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    return extractProjectId(res.data);
  } catch (error) {
    setLastError(safeError(error));
    return undefined;
  }
}

function collectModelLabels(value: unknown, out: string[] = []): string[] {
  if (!value || out.length > 50) return out;
  if (typeof value === "string") {
    if (/gemini|claude|gpt-oss/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelLabels(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const key of ["id", "name", "label", "displayName", "model", "modelId"]) {
      collectModelLabels(value[key], out);
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") collectModelLabels(nested, out);
    }
  }
  return out;
}

function summarizeModelCandidate(value: unknown): string {
  if (!isRecord(value)) return String(value ?? "none");
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|auth|credential|secret|email/i.test(key)) continue;
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
    else if (Array.isArray(raw)) out[key] = `[array:${String(raw.length)}]`;
    else if (isRecord(raw)) {
      out[key] = `{${Object.keys(raw).slice(0, 12).join(",")}}`;
    }
  }
  return JSON.stringify(out).slice(0, 1200);
}

/** Runtime ids look like gemini-*, claude-*, gpt-oss-*, never MODEL_PLACEHOLDER_* enums. */
function isUsableRuntimeModelId(id: string): boolean {
  return /^(gemini-|claude-|gpt-oss-)/i.test(id) && !/\s/.test(id) && !/^MODEL_/i.test(id);
}

export function buildModelMatchRegex(requestedId: string): RegExp {
  const req = requestedId.toLowerCase();
  // Special alias mappings where runtime ids or display labels differ from their canonical family
  if (req === "gemini-pro-agent") return /gemini[- ]3\.1[- ]pro\s*\(high\)|gemini[- ]pro[- ]agent/i;
  if (req === "gemini-3-flash-agent")
    return /gemini[- ]3\.5[- ]flash\s*\(high\)|gemini[- ]3[- ]flash[- ]agent/i;
  if (req === "gemini-3.5-flash-extra-low")
    return /gemini[- ]3\.5[- ]flash\s*\((?:low|extra[- ]low)\)|gemini[- ]3\.5[- ]flash[- ]extra[- ]low/i;
  if (req === "gemini-3.5-flash-low" || req === "gemini-3.5-flash-medium")
    return /gemini[- ]3\.5[- ]flash\s*\(medium\)|gemini[- ]3\.5[- ]flash[- ](?:low|medium)/i;
  if (req === "gemini-3.5-flash-high")
    return /gemini[- ]3\.5[- ]flash\s*\(high\)|gemini[- ]3\.5[- ]flash[- ]high/i;
  if (req.includes("claude-opus-4-6")) return /claude.*opus.*4\.6/i;
  if (req.includes("claude-sonnet-4-6")) return /claude.*sonnet.*4\.6/i;
  if (req.includes("gpt-oss-120b")) return /gpt.*oss.*120b/i;

  // Generic rule: parse (Level) suffix (e.g. -extra-low, -low, -medium, -high, -extra-high, -minimal) + family name,
  // matching either runtime id form (gemini-3.9-flash-low) or display name form (Gemini 3.9 Flash (Low)).
  const levelMatch = req.match(/-(extra-low|extra-high|minimal|medium|high|low)$/);
  if (levelMatch) {
    const level = levelMatch[1];
    const base = req.slice(0, -(level.length + 1));
    const baseEscaped = escapeRegExp(base).replace(/-/g, "[- ]");
    const levelPattern =
      level === "extra-low"
        ? "(?:extra[- ]low|low)"
        : level === "extra-high"
          ? "(?:extra[- ]high|high)"
          : level.replace(/-/g, "[- ]");
    return new RegExp(`${baseEscaped}(?:[- ]${levelPattern}|\\s*\\(${levelPattern}\\))`, "i");
  }

  const escaped = escapeRegExp(req).replace(/-/g, "[- ]");
  return new RegExp(escaped, "i");
}

function dynamicModelFromInfo(modelId: string, info: unknown): DynamicModelInfo {
  if (!isRecord(info)) return { id: modelId };
  setLastMatchedModelDebug(summarizeModelCandidate({ modelId, ...info }));
  const modelEnum = asString(info.model);
  return {
    id: modelId,
    apiProvider: asString(info.apiProvider),
    modelProvider: asString(info.modelProvider),
    model: modelEnum,
  };
}

/**
 * Resolve a requested runtime model against fetchAvailableModels payload.
 * The real runtime ids are the keys of `data.models`; the nested `model` field is often
 * a MODEL_PLACEHOLDER_* enum that 404s on streamGenerateContent.
 */
function findDynamicModel(value: unknown, requestedId: string): DynamicModelInfo | undefined {
  if (!value) return undefined;

  if (isRecord(value) && isRecord(value.models)) {
    const modelsMap = value.models;
    if (isUsableRuntimeModelId(requestedId) && requestedId in modelsMap) {
      return dynamicModelFromInfo(requestedId, modelsMap[requestedId]);
    }

    const targetRegex = buildModelMatchRegex(requestedId);
    for (const [modelId, info] of Object.entries(modelsMap)) {
      if (!isUsableRuntimeModelId(modelId)) continue;
      if (targetRegex.test(modelId)) return dynamicModelFromInfo(modelId, info);
      if (isRecord(info)) {
        const label = info.label ?? info.displayName ?? info.name;
        if (typeof label === "string" && targetRegex.test(label)) {
          return dynamicModelFromInfo(modelId, info);
        }
      }
    }
    return undefined;
  }

  const targetRegex = buildModelMatchRegex(requestedId);

  if (typeof value === "string") {
    return targetRegex.test(value) && isUsableRuntimeModelId(value) ? { id: value } : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDynamicModel(item, requestedId);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") {
        const found = findDynamicModel(nested, requestedId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

async function fetchAvailableRuntimeModelUncached(
  token: string,
  projectId: string,
  requestedRuntimeModel: string,
): Promise<DynamicModelInfo | undefined> {
  const endpoints = endpointCandidates();
  let lastLabels = "";

  // Try endpoints in priority order (production first). If the primary endpoint
  // resolves the model, return immediately without waiting on slower sandbox endpoints.
  for (const endpoint of endpoints) {
    try {
      const { data } = await postEndpointJson(
        endpoint,
        "/v1internal:fetchAvailableModels",
        token,
        { project: projectId },
        { timeoutMs: DISCOVERY_TIMEOUT_MS },
      );
      if (isRecord(data) && isRecord(data.models)) {
        registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>, projectId);
      }
      const labels = [...new Set(collectModelLabels(data))].slice(0, 16);
      if (labels.length) lastLabels = labels.join(",");
      const found = findDynamicModel(data, requestedRuntimeModel);
      if (found) {
        if (lastLabels) setLastAvailableModels(lastLabels);
        return found;
      }
    } catch (error) {
      setLastError(safeError(error));
      if (error instanceof AntigravityHttpError && !isRetryableEndpointStatus(error.status)) {
        break;
      }
    }
  }

  if (lastLabels) setLastAvailableModels(lastLabels);
  return undefined;
}

export async function fetchAvailableRuntimeModel(
  token: string,
  projectId: string,
  requestedRuntimeModel: string,
): Promise<DynamicModelInfo | undefined> {
  const cacheKey = `${token}::${projectId}::${requestedRuntimeModel}`;
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  // De-dupe concurrent lookups for the same key (e.g. parallel requests right after
  // startup) so they share one probe instead of each firing their own round-trips.
  const inFlight = inFlightModelLookups.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = fetchAvailableRuntimeModelUncached(token, projectId, requestedRuntimeModel).then(
    (result) => {
      modelCache.set(cacheKey, { result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
      return result;
    },
  );
  inFlightModelLookups.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightModelLookups.delete(cacheKey);
    // Bound the cache. Dropping only *expired* entries is not a bound: when every
    // entry is still fresh the map just keeps growing. Insertion order is
    // oldest-first, so delete from the front until the cap holds (which also
    // discards expired keys, since those are the oldest).
    for (const key of modelCache.keys()) {
      if (modelCache.size <= MODEL_CACHE_MAX_ENTRIES) break;
      modelCache.delete(key);
    }
  }
}

type AvailableModelsAttempt =
  | {
      endpoint: string;
      result: { endpoint: string; status: number; data: unknown };
      error?: never;
    }
  | { endpoint: string; result?: never; error: unknown };

async function fetchAvailableModelsFromEndpoint(
  endpoint: string,
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<AvailableModelsAttempt> {
  try {
    return {
      endpoint,
      result: await postEndpointJson(
        endpoint,
        "/v1internal:fetchAvailableModels",
        token,
        { project: projectId },
        {
          signal,
          timeoutMs: DISCOVERY_TIMEOUT_MS,
          recordSuccess: false,
          recordDiagnostics: false,
        },
      ),
    };
  } catch (error) {
    return { endpoint, error };
  }
}

/** Merge catalog payloads from one or more fetchAvailableModels responses. */
export function mergeAvailableModelsResults(
  results: Array<{ endpoint: string; status: number; data: unknown } | undefined>,
  projectId?: string,
): { endpoint: string; status: number; data: AvailableModelsRaw } {
  const mergedModels: Record<string, unknown> = {};
  let defaultAgentModelId: string | undefined;
  let defaultAgentModel: string | undefined;
  let selectedEndpoint = "";
  let selectedStatus = 0;

  for (const result of results) {
    if (!result) continue;
    if (!selectedEndpoint) {
      selectedEndpoint = result.endpoint;
      selectedStatus = result.status;
    }
    const data = result.data;
    if (isRecord(data) && isRecord(data.models)) {
      Object.assign(mergedModels, data.models);
      registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>, projectId);
    }
    if (isRecord(data) && typeof data.defaultAgentModelId === "string") {
      defaultAgentModelId = data.defaultAgentModelId;
    }
    if (isRecord(data) && typeof data.defaultAgentModel === "string") {
      defaultAgentModel = data.defaultAgentModel;
    }
  }

  if (!selectedEndpoint) {
    throw new Error(`/v1internal:fetchAvailableModels failed: no endpoint available`);
  }
  setLastEndpoint(selectedEndpoint);
  setLastStatus(selectedStatus);
  return {
    endpoint: selectedEndpoint,
    status: selectedStatus,
    data: {
      models: mergedModels as AvailableModelsRaw["models"],
      defaultAgentModelId,
      defaultAgentModel,
    },
  };
}

/**
 * Merge fetchAvailableModels across endpoint candidates so daily/sandbox-only
 * models appear alongside production catalog entries.
 */
export async function fetchAvailableModelsCatalog(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: AvailableModelsRaw }> {
  const endpoints = endpointCandidates();
  const attempts = await Promise.all(
    endpoints.map((endpoint) =>
      fetchAvailableModelsFromEndpoint(endpoint, token, projectId, signal),
    ),
  );
  const results = attempts.flatMap((attempt) => (attempt.result ? [attempt.result] : []));
  if (results.length === 0) {
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      const attempt = attempts[index];
      const error = attempt?.error;
      if (error !== undefined) {
        setLastEndpoint(attempt.endpoint);
        setLastStatus(error instanceof AntigravityHttpError ? error.status : undefined);
        setLastError(safeError(error));
        throw error instanceof Error ? error : new Error(safeError(error));
      }
    }
  }
  const preferred = results[0];
  if (preferred) recordSuccessfulEndpoint(preferred.endpoint);
  return mergeAvailableModelsResults(results, projectId);
}

/** Tier id the Cloud Code Assist onboarding RPC provisions. */
const FREE_TIER_ID = "free-tier";
/** Budget for the whole onboardUser exchange, polling included. */
const ONBOARD_TIMEOUT_MS = 30_000;
const ONBOARD_POLL_INTERVAL_MS = 1_000;

type OnboardOperation = {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string } | null;
};

/**
 * `loadCodeAssist` reports `currentTier` only once the account has been provisioned
 * for Cloud Code Assist. An account that has just authorised for the first time
 * answers without it and needs `onboardUser` to bind a `cloudaicompanionProject`.
 */
export function hasProvisionedTier(data: unknown): boolean {
  return isRecord(data) && data.currentTier !== undefined && data.currentTier !== null;
}

function freeTierIneligibility(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const ineligibleTiers: unknown = data.ineligibleTiers;
  if (!Array.isArray(ineligibleTiers)) return undefined;
  const tier: unknown = ineligibleTiers.find(
    (value) => isRecord(value) && asString(value.id) === FREE_TIER_ID,
  );
  if (!isRecord(tier)) return undefined;
  const reason =
    asString(tier.reasonMessage) ??
    asString(tier.reason) ??
    asString(tier.message) ??
    "Free-tier onboarding is not available for this account.";
  const validationUrl = asString(tier.validationUrl) ?? asString(tier.validation_url);
  return validationUrl ? `${reason} Verify: ${validationUrl}` : reason;
}

/**
 * Provision the free tier for a freshly authorised account.
 *
 * Speaks the same protocol as OMP's built-in `google-antigravity` provider:
 * POST `onboardUser`, then poll the returned long-running operation until it
 * reports `done`. Throws on failure so the caller can choose to degrade.
 */
export async function onboardUser(token: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`onboardUser timed out after ${ONBOARD_TIMEOUT_MS}ms`);
    return left;
  };
  const onboardBody = { tierId: FREE_TIER_ID, metadata: { ideType: "ANTIGRAVITY" } };

  let operation = (
    await postAntigravityJson<OnboardOperation>("/v1internal:onboardUser", token, onboardBody, {
      signal,
      timeoutMs: remaining(),
    })
  ).data;

  while (operation?.done !== true) {
    const name = typeof operation?.name === "string" ? operation.name : "";
    if (!name) throw new Error("onboardUser returned an operation without a name");
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(ONBOARD_POLL_INTERVAL_MS, remaining())),
    );
    if (signal?.aborted) throw new Error("onboardUser aborted");
    operation = (
      await getAntigravityJson<OnboardOperation>(`/v1internal/${name}`, token, {
        signal,
        timeoutMs: remaining(),
      })
    ).data;
  }

  if (operation.error) {
    const code = typeof operation.error.code === "number" ? `${operation.error.code}: ` : "";
    throw new Error(`onboardUser failed: ${code}${operation.error.message ?? "unknown error"}`);
  }
}

/** Body of the account-tier probe. Shared by discovery and usage diagnostics. */
const LOAD_CODE_ASSIST_BODY = { metadata: { ideType: "ANTIGRAVITY" } };

export function fetchCodeAssistMetadata(
  token: string,
  signal?: AbortSignal,
): Promise<PostJsonResponse<unknown>> {
  return postAntigravityJson("/v1internal:loadCodeAssist", token, LOAD_CODE_ASSIST_BODY, {
    signal,
    timeoutMs: DISCOVERY_TIMEOUT_MS,
  });
}

async function loadCodeAssistUncached(
  token: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const read = (): Promise<PostJsonResponse<unknown>> => fetchCodeAssistMetadata(token, signal);

    let data = (await read()).data;
    if (!hasProvisionedTier(data)) {
      const ineligible = freeTierIneligibility(data);
      if (ineligible) {
        setLastError(ineligible);
        throw new AntigravityAccountIneligibleError(ineligible);
      }
      // Never provisioned: without onboarding this account can never resolve a
      // project, so the fallback placeholder would stick forever. Failures keep
      // the login usable — they are recorded for /antigravity.doctor instead.
      try {
        await onboardUser(token, signal);
        data = (await read()).data;
      } catch (error) {
        setLastError(`onboardUser: ${safeError(error)}`);
      }
    }

    const project = extractProjectId(data);
    if (project) return project;
    return await listCloudAICompanionProjects(token, signal);
  } catch (error) {
    setLastError(safeError(error));
    if (error instanceof AntigravityAccountIneligibleError) throw error;
    return undefined;
  }
}

/** Discover project id with a short in-memory LRU cache keyed by access token. */
export async function loadCodeAssist(
  token: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const cached = projectCache.get(token);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      // Refresh LRU order: delete and re-insert so newest is at the end.
      projectCache.delete(token);
      projectCache.set(token, cached);
      return cached.projectId;
    }
    // Expired entry — drop immediately.
    projectCache.delete(token);
  }

  const projectId = await loadCodeAssistUncached(token, signal);
  if (projectId) {
    projectCache.set(token, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });

    // Discard oldest entries when exceeding capacity cap.
    for (const key of projectCache.keys()) {
      if (projectCache.size <= PROJECT_CACHE_MAX_ENTRIES) break;
      projectCache.delete(key);
    }
  }
  return projectId;
}

export function resolveProjectId(opts: {
  credentialProjectId?: string;
  warmedProject?: string | null;
}): string {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    opts.warmedProject ||
    opts.credentialProjectId ||
    defaultProjectId()
  );
}

/** Build a diagnostic suffix using the active request bag. */
export function formatRequestDiagnostics(extra: {
  projectId: string;
  runtimeModel: string;
}): string {
  return `endpoint=${getCurrentEndpoint() || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${getCurrentMatchedModelDebug() || "none"}, available=${getCurrentAvailableModels() || "unknown"}`;
}
