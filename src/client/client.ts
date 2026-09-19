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
import { registerDiscoveredModelEnums, registerModelEnum } from "../models/models.js";

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
/** Ordered endpoint candidates; module-private since `endpointCandidates` is the accessor. */
const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
/** Hard cap on cached (token) project id lookups; oldest entries are dropped first. */
const PROJECT_CACHE_MAX_ENTRIES = 64;
const projectCache = new Map<string, { projectId: string | undefined; expiresAt: number }>();

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
/** Hard cap on cached (token, project, model) lookups; oldest entries are dropped first. */
const MODEL_CACHE_MAX_ENTRIES = 64;
const modelCache = new Map<string, { result: DynamicModelInfo | undefined; expiresAt: number }>();

/** Metadata lookups (project/model discovery) must be fast; a stalled endpoint should
 * fall through to the next candidate instead of hanging the whole request. */
const DISCOVERY_TIMEOUT_MS = 8000;

/** In-flight de-dupe: concurrent requests for the same (token, project, model) share one probe. */
const inFlightModelLookups = new Map<string, Promise<DynamicModelInfo | undefined>>();

/** UUID-shaped stable id from a seed (account email preferred over cwd). */
export function stableProjectId(seed: string): string {
  return stableUuid(`antigravity:${seed}`);
}

/**
 * Fallback project id when discovery fails.
 * Prefer ANTIGRAVITY_PROJECT_ID, then a stable seed (email), never process.cwd().
 */
export function defaultProjectId(seed = "antigravity-default"): string {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}

/** @deprecated Use defaultProjectId(seed); kept for scripts that imported the old constant. */
export const DEFAULT_PROJECT_ID = defaultProjectId();

export function endpointCandidates(): string[] {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [assertSafeApiBaseUrl(explicit)] : ENDPOINT_FALLBACKS;
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
 * Send a single POST JSON request to a specific Antigravity endpoint.
 */
export async function postEndpointJson<T = unknown>(
  endpoint: string,
  path: string,
  token: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResponse<T>> {
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const signal =
    options.signal && timeout
      ? AbortSignal.any([options.signal, timeout])
      : (options.signal ?? timeout);

  const res = await antigravityFetch(`${endpoint}${path}`, {
    method: "POST",
    headers: {
      ...antigravityHeaders(token),
      Accept: "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  setLastEndpoint(endpoint);
  setLastStatus(res.status);

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
    setLastError(message);
    throw new AntigravityHttpError(
      `${path} failed (${String(res.status)}): ${message.slice(0, 300)}`,
      res.status,
      endpoint,
      data,
    );
  }

  return { endpoint, status: res.status, data: data as T };
}

/**
 * Send a POST JSON request iterating through endpointCandidates() in priority order.
 * - 2xx: returns immediately.
 * - 401, 403, 429, or client 4xx: throws immediately (account/quota-level, non-retryable across endpoints).
 * - 404, 500-504, or network errors: retries on next candidate endpoint.
 */
export async function postAntigravityJson<T = unknown>(
  path: string,
  token: string,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResponse<T>> {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    try {
      return await postEndpointJson<T>(endpoint, path, token, body, options);
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
    // Structured form from getApiKey(): {token, projectId}. A missing projectId
    // is not fatal — callers fall back to loadCodeAssist discovery.
    return { token: parsed.token, projectId: parsed.projectId ?? "" };
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

async function listCloudAICompanionProjects(token: string): Promise<string | undefined> {
  try {
    const res = await postAntigravityJson(
      "/v1internal:listCloudAICompanionProjects",
      token,
      {},
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
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
  const experiments = Array.isArray(info.modelExperiments)
    ? info.modelExperiments.filter((item): item is string => typeof item === "string")
    : undefined;
  const modelEnum = asString(info.model);
  if (modelEnum) {
    registerModelEnum(modelId, modelEnum);
  }
  return {
    id: modelId,
    experiments,
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
        registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>);
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

async function fetchAvailableModelsFromEndpoint(
  endpoint: string,
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: unknown } | undefined> {
  try {
    return await postEndpointJson(
      endpoint,
      "/v1internal:fetchAvailableModels",
      token,
      { project: projectId },
      { signal, timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
  } catch {
    return undefined;
  }
}

/** Merge catalog payloads from one or more fetchAvailableModels responses. */
export function mergeAvailableModelsResults(
  results: Array<{ endpoint: string; status: number; data: unknown } | undefined>,
): { endpoint: string; status: number; data: AvailableModelsRaw } {
  const mergedModels: Record<string, unknown> = {};
  let defaultAgentModelId: string | undefined;
  let defaultAgentModel: string | undefined;
  let lastEndpoint = "";
  let lastStatus = 0;

  for (const result of results) {
    if (!result) continue;
    setLastEndpoint(result.endpoint);
    setLastStatus(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    const data = result.data;
    if (isRecord(data) && isRecord(data.models)) {
      Object.assign(mergedModels, data.models);
      registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>);
    }
    if (isRecord(data) && typeof data.defaultAgentModelId === "string") {
      defaultAgentModelId = data.defaultAgentModelId;
    }
    if (isRecord(data) && typeof data.defaultAgentModel === "string") {
      defaultAgentModel = data.defaultAgentModel;
    }
  }

  if (!lastEndpoint) {
    throw new Error(`/v1internal:fetchAvailableModels failed: no endpoint available`);
  }

  return {
    endpoint: lastEndpoint,
    status: lastStatus,
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
  const results = await Promise.all(
    endpointCandidates().map((endpoint) =>
      fetchAvailableModelsFromEndpoint(endpoint, token, projectId, signal),
    ),
  );
  return mergeAvailableModelsResults(results);
}

async function loadCodeAssistUncached(token: string): Promise<string | undefined> {
  try {
    const res = await postAntigravityJson(
      "/v1internal:loadCodeAssist",
      token,
      {
        metadata: {
          ideType: "ANTIGRAVITY",
        },
      },
      { timeoutMs: DISCOVERY_TIMEOUT_MS },
    );
    const project = extractProjectId(res.data);
    if (project) return project;
    return await listCloudAICompanionProjects(token);
  } catch (error) {
    setLastError(safeError(error));
    return undefined;
  }
}

/** Discover project id with a short in-memory LRU cache keyed by access token. */
export async function loadCodeAssist(token: string): Promise<string | undefined> {
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

  const projectId = await loadCodeAssistUncached(token);
  projectCache.set(token, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });

  // Discard oldest entries when exceeding capacity cap.
  for (const key of projectCache.keys()) {
    if (projectCache.size <= PROJECT_CACHE_MAX_ENTRIES) break;
    projectCache.delete(key);
  }
  return projectId;
}

export function resolveProjectId(opts: {
  token: string;
  credentialProjectId?: string;
  email?: string;
  warmedProject?: string | null;
}): string {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    opts.warmedProject ||
    opts.credentialProjectId ||
    defaultProjectId(opts.email || "antigravity-default")
  );
}

/** Build a diagnostic suffix using the active request bag. */
export function formatRequestDiagnostics(extra: {
  projectId: string;
  runtimeModel: string;
}): string {
  return `endpoint=${getCurrentEndpoint() || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${getCurrentMatchedModelDebug() || "none"}, available=${getCurrentAvailableModels() || "unknown"}`;
}
