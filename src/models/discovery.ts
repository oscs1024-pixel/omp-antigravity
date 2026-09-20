import {
  defaultProjectId,
  fetchAvailableModelsCatalog,
  isPlaceholderProjectId,
  loadCodeAssist,
  parseApiKey,
} from "../client/index.js";
import { buildAntigravityCatalog, type AntigravityCatalog } from "./grouping.js";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING } from "./models.js";

const fallbackCatalog = (): AntigravityCatalog => ({
  models: ANTIGRAVITY_MODELS,
  routing: { ...ANTIGRAVITY_ROUTING },
});

/**
 * Result of one discovery pass.
 *
 * `projectId` is the account the catalog belongs to. OMP only ever hands
 * `fetchDynamicModels` a bare access token, so the project id has to be resolved
 * here; returning it is what lets the caller bucket the catalog per account
 * instead of applying it to the shared routing table.
 */
export type AntigravityDiscovery = {
  catalog: AntigravityCatalog;
  projectId: string;
};

/**
 * Discover the live Antigravity model catalog.
 *
 * Called by OMP's fetchDynamicModels with the resolved API key, which is either
 * the structured `{token, projectId}` JSON from getApiKey() or — when OMP hands
 * over AuthStorage.peekApiKey's result — a bare access token. In the bare-token
 * (or missing-projectId) case the project id is discovered via loadCodeAssist
 * first, mirroring the streaming path's resolveProjectId fallback.
 */
export async function discoverAntigravityModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<AntigravityDiscovery> {
  const creds = parseApiKey(apiKey);
  const credentialProjectId =
    creds.projectId && !isPlaceholderProjectId(creds.projectId) ? creds.projectId : undefined;
  const projectId =
    credentialProjectId || (await loadCodeAssist(creds.token, signal)) || defaultProjectId();
  const available = await fetchAvailableModelsCatalog(creds.token, projectId, signal);
  const models = available.data.models;
  if (!models || Object.keys(models).length === 0) {
    return { catalog: { models: [], routing: {} }, projectId };
  }
  return { catalog: buildAntigravityCatalog(models, fallbackCatalog()), projectId };
}
