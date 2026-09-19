import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { AntigravityRouting, ThinkingWire } from "../types/types.js";
import { ThinkingEffort } from "../types/enums.js";
import type { AntigravityCatalog } from "./grouping.js";
import { setWithCap } from "../utils/util.js";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";

/**
 * Public selectable model IDs → backend request model IDs by thinking effort.
 *
 * Catalog mirrors `agy models` (Antigravity CLI), which currently advertises:
 * - Gemini 3.8 Flash (Low / Medium / High)
 * - Gemini 3.7 Flash (Low / Medium / High)
 * - Gemini 3.6 Flash (Low / Medium / High)
 * - Gemini 3.5 Flash (Low / Medium / High)
 * - Gemini 3.1 Pro (Low / High)
 * - Claude Sonnet 4.6 (Thinking)
 * - Claude Opus 4.6 (Thinking)
 * - GPT-OSS 120B (Medium)
 *
 * OMP exposes those as public model IDs and only surfaces the exact thinking levels
 * advertised by the backend for each model.
 */
export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
  "claude-opus-4-6": {
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  // Live fetchAvailableModels exposes `claude-sonnet-4-6` (display: Thinking), not a separate *-thinking id.
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6",
    routing: {
      minimal: "claude-sonnet-4-6",
      low: "claude-sonnet-4-6",
      medium: "claude-sonnet-4-6",
      high: "claude-sonnet-4-6",
      xhigh: "claude-sonnet-4-6",
    },
    defaultRequestId: "claude-sonnet-4-6",
  },
  "gemini-3.1-pro": {
    // `gemini-3.1-pro-high` is advertised but currently 400s for agent streamGenerateContent;
    // `gemini-pro-agent` is the working High runtime id (same display name in fetchAvailableModels).
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      medium: "gemini-3.1-pro-low",
      high: "gemini-pro-agent",
      xhigh: "gemini-pro-agent",
    },
    defaultRequestId: "gemini-3.1-pro-low",
  },
  "gemini-3.8-flash": {
    off: "gemini-3.8-flash-low",
    routing: {
      minimal: "gemini-3.8-flash-low",
      low: "gemini-3.8-flash-low",
      medium: "gemini-3.8-flash-medium",
      high: "gemini-3.8-flash-high",
      xhigh: "gemini-3.8-flash-high",
    },
    defaultRequestId: "gemini-3.8-flash-low",
  },
  "gemini-3.7-flash": {
    off: "gemini-3.7-flash-low",
    routing: {
      minimal: "gemini-3.7-flash-low",
      low: "gemini-3.7-flash-low",
      medium: "gemini-3.7-flash-medium",
      high: "gemini-3.7-flash-high",
      xhigh: "gemini-3.7-flash-high",
    },
    defaultRequestId: "gemini-3.7-flash-low",
  },
  "gemini-3.6-flash": {
    // agy models: gemini-3.6-flash-low / -medium / -high
    off: "gemini-3.6-flash-low",
    routing: {
      minimal: "gemini-3.6-flash-low",
      low: "gemini-3.6-flash-low",
      medium: "gemini-3.6-flash-medium",
      high: "gemini-3.6-flash-high",
      xhigh: "gemini-3.6-flash-high",
    },
    defaultRequestId: "gemini-3.6-flash-low",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-extra-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3.5-flash-extra-low",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
};

/**
 * Verified maximum output tokens accepted by the Cloud Code Assist backend per model/runtime ID.
 * Requesting more than these limits returns a 400 Bad Request from the API.
 */
/** Module-private: read through `getMaxOutputTokens`, which also applies the family defaults. */
const RUNTIME_MAX_OUTPUT_TOKENS: Record<string, number> = {
  "gemini-3.8-flash": 65536,
  "gemini-3.8-flash-low": 65536,
  "gemini-3.8-flash-medium": 65536,
  "gemini-3.8-flash-high": 65536,
  "gemini-3.7-flash": 65536,
  "gemini-3.7-flash-tiered": 65536,
  // Retain rollout-era IDs for compatibility with pinned runtime overrides.
  "gemini-3.7-flash-low": 65536,
  "gemini-3.7-flash-medium": 65536,
  "gemini-3.7-flash-high": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.6-flash-low": 65536,
  "gemini-3.6-flash-medium": 65536,
  "gemini-3.6-flash-high": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-extra-low": 65536,
  "gemini-3.5-flash-low": 65536,
  "gemini-3-flash-agent": 65536,
  "gemini-3.1-pro": 65535,
  "gemini-3.1-pro-low": 65535,
  "gemini-3.1-pro-high": 65535,
  "gemini-pro-agent": 65535,
  "claude-opus-4-6": 64000,
  "claude-opus-4-6-thinking": 64000,
  "claude-sonnet-4-6": 64000,
  "gpt-oss-120b": 32768,
  "gpt-oss-120b-medium": 32768,
};

export function getMaxOutputTokens(modelId: string, runtimeModel?: string): number {
  if (runtimeModel && RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[runtimeModel];
  }
  if (RUNTIME_MAX_OUTPUT_TOKENS[modelId] !== undefined) {
    return RUNTIME_MAX_OUTPUT_TOKENS[modelId];
  }
  if (runtimeModel) {
    if (runtimeModel.startsWith("claude-")) return 64000;
    if (runtimeModel.startsWith("gpt-oss-")) return 32768;
    if (runtimeModel.startsWith("gemini-3.1-pro") || runtimeModel === "gemini-pro-agent")
      return 65535;
    if (runtimeModel.startsWith("gemini-")) return 65536;
  }
  return 8192;
}

const geminiFlashCost = { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 };
const geminiProCost = { input: 1.25, output: 5.0, cacheRead: 0.3125, cacheWrite: 1.25 };
const claudeSonnetCost = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const claudeOpusCost = { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 };
const gptOssCost = { input: 0.6, output: 2.4, cacheRead: 0.15, cacheWrite: 0.6 };

/**
 * OMP's canonical thinking metadata for one public model.
 *
 * `ProviderModelConfig` has no `thinkingLevelMap` field — that was a pi-era field
 * which OMP silently ignores, leaving each model's selectable efforts to OMP's
 * model-id heuristics. Declaring `thinking` instead makes the catalog
 * self-describing and gives OMP two things it cannot infer:
 *
 * - `efforts`: the levels the `/thinking` menu offers and the set OMP clamps a
 *   requested effort against (`clampThinkingLevelForModel`). A reasoning model
 *   with no `thinking.efforts` is treated as having no controllable effort
 *   surface, so the level the user picks would never reach this provider.
 * - `effortRouting`: the per-effort upstream wire id. OMP builds a reverse index
 *   from it so a collapsed variant id (`antigravity/gemini-3.8-flash-high`) still
 *   resolves to this public model.
 *
 * `mode: "budget"` matches what this provider actually emits on the wire:
 * `generationConfig.thinkingConfig.thinkingBudget`.
 *
 * `suppressWhenOff` states the Cloud Code Assist requirement explicitly: when
 * thinking is off this provider sends `thinkingBudget: 0` rather than omitting
 * `thinkingConfig`, because the backend re-applies the per-runtime-id baked
 * server default when the config is absent.
 */
type AntigravityThinking = NonNullable<ProviderModelConfig["thinking"]>;

/**
 * OMP's effort vocabulary, mirroring `@oh-my-pi/pi-catalog/effort`'s
 * `THINKING_EFFORTS` ladder. Spelled out as literals because OMP declares
 * `Effort` as a `const enum`, which an extension cannot import as a value under
 * `isolatedModules`.
 *
 * Because `Effort` is a `const enum`, a member's type (`Effort.Low`) is a
 * distinct enum-literal type that a plain `"low"` does not satisfy. The two
 * `as` casts in {@link antigravityThinking} are the only places that lean on the
 * two vocabularies agreeing, so both need the runtime ladder to stay in sync
 * with `THINKING_EFFORTS`.
 */
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function antigravityThinking(
  routing: AntigravityRouting,
  efforts: readonly ThinkingLevel[],
  effortBudgets: Partial<Record<ThinkingLevel, number>>,
): AntigravityThinking {
  const effortRouting: Record<string, string> = {};
  if (routing.off) effortRouting.off = routing.off;
  for (const effort of efforts) {
    // `ThinkingEffort` mirrors pi's `Effort` minus "max", and no routing table
    // defines "max"; the cast only lets the wider pi union index the table.
    const wireId = routing.routing?.[effort as ThinkingEffort];
    if (wireId) effortRouting[effort] = wireId;
  }
  return {
    mode: "budget",
    efforts: [...efforts] as AntigravityThinking["efforts"],
    defaultLevel: efforts[0] as AntigravityThinking["defaultLevel"],
    effortRouting,
    effortBudgets: effortBudgets,
    suppressWhenOff: true,
  };
}

/** Same set as `agy models`, collapsed to public OMP model IDs. */
export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(
      ANTIGRAVITY_ROUTING["gemini-3.8-flash"],
      ["low", "medium", "high"],
      {
        low: 1000,
        medium: 4000,
        high: -1,
      },
    ),
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.7-flash",
    name: "Gemini 3.7 Flash (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(
      ANTIGRAVITY_ROUTING["gemini-3.7-flash"],
      ["low", "medium", "high"],
      {
        low: 1000,
        medium: 4000,
        high: -1,
      },
    ),
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(
      ANTIGRAVITY_ROUTING["gemini-3.6-flash"],
      ["low", "medium", "high"],
      {
        low: 1000,
        medium: 4000,
        high: -1,
      },
    ),
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(ANTIGRAVITY_ROUTING["claude-opus-4-6"], ["high"], { high: 1024 }),
    input: ["text", "image"],
    cost: claudeOpusCost,
    contextWindow: 250000,
    maxTokens: 64000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(ANTIGRAVITY_ROUTING["claude-sonnet-4-6"], ["high"], {
      high: 1024,
    }),
    input: ["text", "image"],
    cost: claudeSonnetCost,
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(ANTIGRAVITY_ROUTING["gemini-3.1-pro"], ["low", "high"], {
      low: 1001,
      high: 10001,
    }),
    input: ["text", "image"],
    cost: geminiProCost,
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(
      ANTIGRAVITY_ROUTING["gemini-3.5-flash"],
      ["low", "medium", "high"],
      {
        low: 1000,
        medium: 4000,
        high: 10000,
      },
    ),
    input: ["text", "image"],
    cost: geminiFlashCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B (Antigravity)",
    reasoning: true,
    thinking: antigravityThinking(ANTIGRAVITY_ROUTING["gpt-oss-120b"], ["medium"], {
      medium: 8192,
    }),
    input: ["text"],
    cost: gptOssCost,
    contextWindow: 131072,
    maxTokens: 32768,
  },
];

let currentModels: ProviderModelConfig[] = ANTIGRAVITY_MODELS;
let currentRouting: Record<string, AntigravityRouting> = { ...ANTIGRAVITY_ROUTING };
const MAX_PROJECT_CATALOGS = 64;
const MAX_MODEL_ENUMS = 64;
const catalogsByProject = new Map<string, AntigravityCatalog>();

export function getCurrentAntigravityRouting(): Record<string, AntigravityRouting> {
  return currentRouting;
}

export function getCurrentAntigravityCatalog(): AntigravityCatalog {
  return { models: currentModels, routing: currentRouting };
}

export function getAntigravityCatalogForProject(projectId?: string): AntigravityCatalog {
  if (projectId && catalogsByProject.has(projectId)) {
    return catalogsByProject.get(projectId)!;
  }
  return { models: currentModels, routing: currentRouting };
}

export function applyAntigravityCatalog(catalog: AntigravityCatalog, projectId?: string): void {
  if (projectId) {
    setWithCap(catalogsByProject, projectId, catalog, MAX_PROJECT_CATALOGS);
  }
  const existingMap = new Map<string, ProviderModelConfig>();
  for (const m of currentModels) existingMap.set(m.id, m);
  for (const m of catalog.models) existingMap.set(m.id, m);
  currentModels = Array.from(existingMap.values());
  currentRouting = { ...currentRouting, ...catalog.routing };
}

/** Resolve public model id + thinking effort to Antigravity runtime model id. */
export function getAntigravityRequestModelId(
  modelId: string,
  effort: string | undefined,
  projectId?: string,
): string {
  const projectCatalog = projectId ? catalogsByProject.get(projectId) : undefined;
  const r =
    projectCatalog?.routing[modelId] ?? currentRouting[modelId] ?? ANTIGRAVITY_ROUTING[modelId];
  if (!r) return modelId;

  if (effort === undefined || effort === "off") {
    return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
  }

  const effortKey = effort as ThinkingEffort;
  if (effortKey === ThinkingEffort.Xhigh) {
    return (
      r.routing?.xhigh ??
      r.routing?.high ??
      r.routing?.low ??
      r.routing?.minimal ??
      r.off ??
      r.defaultRequestId ??
      modelId
    );
  }

  return (
    r.routing?.[effortKey] ??
    r.routing?.low ??
    r.routing?.minimal ??
    r.off ??
    r.defaultRequestId ??
    modelId
  );
}

/**
 * If a next-gen model (e.g. Gemini 3.8 Flash) is not yet available on the backend,
 * provide a fallback runtime model ID (e.g. Gemini 3.7 Flash) to maintain availability.
 */
export function getFallbackRuntimeModel(runtimeModel: string, effort?: string): string | undefined {
  if (runtimeModel.startsWith("gemini-3.8-flash-")) {
    return runtimeModel.replace("gemini-3.8-flash-", "gemini-3.7-flash-");
  }
  if (runtimeModel === "gemini-3.8-flash") {
    return "gemini-3.7-flash-low";
  }
  if (runtimeModel === "gemini-3.7-flash-tiered") {
    return getAntigravityRequestModelId("gemini-3.6-flash", effort);
  }
  if (runtimeModel.startsWith("gemini-3.7-flash-")) {
    return runtimeModel.replace("gemini-3.7-flash-", "gemini-3.6-flash-");
  }
  if (runtimeModel === "gemini-3.7-flash") {
    return "gemini-3.6-flash-low";
  }
  return undefined;
}

export type { ThinkingWire };

/** Module-private: read through `getModelEnum`, which prefers the discovered cache. */
const ANTIGRAVITY_MODEL_ENUM: Record<string, string> = {
  // Gemini 3.8 Flash
  "gemini-3.8-flash": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-high": "MODEL_PLACEHOLDER_M318",
  "gemini-3.8-flash-medium": "MODEL_PLACEHOLDER_M319",
  "gemini-3.8-flash-low": "MODEL_PLACEHOLDER_M320",
  "gemini-3.8-flash-tiered": "MODEL_PLACEHOLDER_M322",
  // Gemini 3.7 Flash
  "gemini-3.7-flash": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-high": "MODEL_PLACEHOLDER_M298",
  "gemini-3.7-flash-medium": "MODEL_PLACEHOLDER_M299",
  "gemini-3.7-flash-low": "MODEL_PLACEHOLDER_M300",
  "gemini-3.7-flash-tiered": "MODEL_PLACEHOLDER_M301",
  // Gemini 3.6 Flash
  "gemini-3.6-flash": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-high": "MODEL_PLACEHOLDER_M71",
  "gemini-3.6-flash-medium": "MODEL_PLACEHOLDER_M72",
  "gemini-3.6-flash-low": "MODEL_PLACEHOLDER_M73",
  "gemini-3.6-flash-tiered": "MODEL_PLACEHOLDER_M196",
  // Gemini 3.5 Flash
  "gemini-3.5-flash": "MODEL_PLACEHOLDER_M20",
  "gemini-3.5-flash-extra-low": "MODEL_PLACEHOLDER_M187",
  "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
  "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M84",
  // Gemini 3.1 Pro
  "gemini-3.1-pro": "MODEL_PLACEHOLDER_M36",
  "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
  "gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M37",
  "gemini-pro-agent": "MODEL_PLACEHOLDER_M16",
  // Claude
  "claude-sonnet-4-6": "MODEL_PLACEHOLDER_M35",
  "claude-opus-4-6": "MODEL_PLACEHOLDER_M26",
  "claude-opus-4-6-thinking": "MODEL_PLACEHOLDER_M26",
  // GPT-OSS
  "gpt-oss-120b": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
  "gpt-oss-120b-medium": "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
};

const modelEnumCache = new Map<string, string>();

/** Register dynamically discovered model enum (e.g. from fetchAvailableModels). */
export function registerModelEnum(wireModelId: string, modelEnum: string): void {
  if (wireModelId && modelEnum) {
    setWithCap(modelEnumCache, wireModelId, modelEnum, MAX_MODEL_ENUMS);
  }
}

/** Register batch of discovered model enums from fetchAvailableModels raw models dictionary. */
export function registerDiscoveredModelEnums(
  models: Record<string, { model?: unknown }> | undefined,
): void {
  if (!models) return;
  for (const [wireId, info] of Object.entries(models)) {
    if (typeof info?.model === "string" && info.model) {
      setWithCap(modelEnumCache, wireId, info.model, MAX_MODEL_ENUMS);
    }
  }
}

/** Get model_enum label for a given wire model id (dynamic cache first, then static fallback). */
export function getModelEnum(wireModelId: string, projectId?: string): string | undefined {
  const direct = modelEnumCache.get(wireModelId) || ANTIGRAVITY_MODEL_ENUM[wireModelId];
  if (direct) return direct;

  // Runtime overrides may name a public/base model while discovery only returned
  // an enum for its selected runtime variant (for example `-low`). Scoped to the
  // caller's project so another account's catalog cannot leak into the label.
  const routed = getAntigravityRequestModelId(wireModelId, undefined, projectId);
  return modelEnumCache.get(routed) || ANTIGRAVITY_MODEL_ENUM[routed];
}

export function getThinkingConfig(
  modelId: string,
  effort: string | undefined,
  budgets?: Partial<Record<string, number>>,
): ThinkingWire | undefined {
  const config = defaultThinkingConfig(modelId, effort);
  if (!config || !effort || effort === "off") return config;
  // OMP's documented precedence for token-based providers is caller `thinkingBudgets`
  // first, then the model's baked budget, then the provider ladder.
  const override = budgets?.[effort];
  if (typeof override !== "number" || !Number.isFinite(override)) return config;
  return { includeThoughts: true, thinkingBudget: override };
}

function defaultThinkingConfig(
  modelId: string,
  effort: string | undefined,
): ThinkingWire | undefined {
  if (modelId.startsWith("claude-")) {
    if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
    return { includeThoughts: true, thinkingBudget: 1024 };
  }
  if (modelId.startsWith("gpt-oss-")) {
    if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
    return { includeThoughts: true, thinkingBudget: 8192 };
  }
  if (modelId.startsWith("gemini-3.5-flash") || modelId === "gemini-3-flash-agent") {
    if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
    const thinkingBudget =
      effort === "high" || effort === "xhigh" ? 10_000 : effort === "medium" ? 4_000 : 1_000;
    return { includeThoughts: true, thinkingBudget };
  }
  if (modelId.startsWith("gemini-3.1-pro") || modelId === "gemini-pro-agent") {
    if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
    return {
      includeThoughts: true,
      thinkingBudget: effort === "high" || effort === "xhigh" ? 10_001 : 1_001,
    };
  }
  if (modelId.startsWith("gemini-")) {
    if (!effort || effort === "off") return { includeThoughts: false, thinkingBudget: 0 };
    const thinkingBudget =
      effort === "high" || effort === "xhigh" ? -1 : effort === "medium" ? 4_000 : 1_000;
    return { includeThoughts: true, thinkingBudget };
  }
  return undefined;
}
