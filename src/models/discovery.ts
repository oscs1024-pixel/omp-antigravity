import {
  defaultProjectId,
  fetchAvailableModelsCatalog,
  loadCodeAssist,
  parseApiKey,
} from "../client/index.js";
import { buildAntigravityCatalog, type AntigravityCatalog } from "./grouping.js";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING, registerDiscoveredModelEnums } from "./models.js";

const fallbackCatalog = (): AntigravityCatalog => ({
  models: ANTIGRAVITY_MODELS,
  routing: { ...ANTIGRAVITY_ROUTING },
});

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
): Promise<AntigravityCatalog> {
  const creds = parseApiKey(apiKey);
  const projectId = creds.projectId || (await loadCodeAssist(creds.token)) || defaultProjectId();
  const available = await fetchAvailableModelsCatalog(creds.token, projectId, signal);
  const models = available.data.models;
  if (!models || Object.keys(models).length === 0) {
    return { models: [], routing: {} };
  }
  registerDiscoveredModelEnums(models);
  return buildAntigravityCatalog(models, fallbackCatalog());
}
