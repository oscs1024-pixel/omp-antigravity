import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { ThinkingEffort } from "../types/enums.js";
import type { AntigravityRouting, ModelInfoRaw } from "../types/types.js";

export type AntigravityCatalog = {
  models: ProviderModelConfig[];
  routing: Record<string, AntigravityRouting>;
};

type ThinkingLevel = ThinkingEffort;

type RuntimeGroup = {
  publicId: string;
  variants: Partial<Record<ThinkingLevel, string>>;
  unsuffixed?: string;
  displayNames: string[];
  /** Catalog capability: true/false when advertised, undefined when omitted. */
  supportsThinking?: boolean;
  supportsImages?: boolean;
};

const THINKING_SUFFIXES: Array<{ suffix: string; level: ThinkingLevel }> = [
  { suffix: "extra-low", level: ThinkingEffort.Low },
  { suffix: "extra-high", level: ThinkingEffort.Xhigh },
  { suffix: "thinking", level: ThinkingEffort.High },
  { suffix: "minimal", level: ThinkingEffort.Minimal },
  { suffix: "medium", level: ThinkingEffort.Medium },
  { suffix: "high", level: ThinkingEffort.High },
  { suffix: "low", level: ThinkingEffort.Low },
];

const DISPLAY_LEVELS: Array<{ pattern: RegExp; level: ThinkingLevel }> = [
  { pattern: /\(\s*extra\s*low\s*\)/i, level: ThinkingEffort.Low },
  { pattern: /\(\s*extra\s*high\s*\)/i, level: ThinkingEffort.Xhigh },
  { pattern: /\(\s*thinking\s*\)/i, level: ThinkingEffort.High },
  { pattern: /\(\s*minimal\s*\)/i, level: ThinkingEffort.Minimal },
  { pattern: /\(\s*medium\s*\)/i, level: ThinkingEffort.Medium },
  { pattern: /\(\s*high\s*\)/i, level: ThinkingEffort.High },
  { pattern: /\(\s*low\s*\)/i, level: ThinkingEffort.Low },
];

/** Known backend aliases whose runtime IDs do not share a thinking suffix with the public family. */
const RUNTIME_ALIASES: Record<string, { publicId: string; level: ThinkingLevel }> = {
  "gemini-3-flash-agent": { publicId: "gemini-3.5-flash", level: ThinkingEffort.High },
  "gemini-pro-agent": { publicId: "gemini-3.1-pro", level: ThinkingEffort.High },
};

/**
 * OMP's effort ladder, ordered least → most intensive.
 *
 * `ThinkingEffort.Off` is deliberately absent: OMP's `Effort` union has no "off"
 * member — an off/disabled request is represented by `reasoning: undefined`, and
 * `thinking.efforts` must never contain it.
 */
const OMP_EFFORTS = [
  ThinkingEffort.Minimal,
  ThinkingEffort.Low,
  ThinkingEffort.Medium,
  ThinkingEffort.High,
  ThinkingEffort.Xhigh,
  "max",
] as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const ANTIGRAVITY_DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310", "gemini-2.5-pro"]);

/** Module-private: only `buildAntigravityCatalog` filters raw runtime ids. */
function isSelectableRuntimeModelId(id: string): boolean {
  if (ANTIGRAVITY_DISCOVERY_DENYLIST.has(id.toLowerCase())) {
    return false;
  }
  if (!/^(gemini-|claude-|gpt-oss-)/i.test(id) || /\s/.test(id) || /^MODEL_/i.test(id)) {
    return false;
  }
  if (/^(chat_|tab_)/i.test(id)) return false;
  if (/image/i.test(id)) return false;
  return true;
}

export function resolvedCatalog(
  discovered: AntigravityCatalog | undefined,
  current: AntigravityCatalog,
): AntigravityCatalog {
  if (discovered && discovered.models.length > 0) return discovered;
  return current;
}

export function buildAntigravityCatalog(
  rawModels: Record<string, ModelInfoRaw>,
  fallback: AntigravityCatalog,
): AntigravityCatalog {
  const groups = new Map<string, RuntimeGroup>();

  for (const [runtimeId, info] of Object.entries(rawModels)) {
    if (!isSelectableRuntimeModelId(runtimeId)) continue;
    if (info?.isInternal) continue;

    const displayName = modelDisplayName(info);
    if (runtimeId.endsWith("-tiered")) {
      const baseId = runtimeId.slice(0, -"-tiered".length);
      const group = ensureGroup(groups, baseId);
      absorbMetadata(group, info, displayName);
      if (!group.unsuffixed) group.unsuffixed = runtimeId;
      continue;
    }

    const alias = RUNTIME_ALIASES[runtimeId];
    const suffix = alias ? undefined : parseThinkingSuffix(runtimeId);
    const publicId = alias?.publicId ?? suffix?.baseId ?? runtimeId;
    const group = ensureGroup(groups, publicId);
    absorbMetadata(group, info, displayName);

    const level = alias?.level ?? levelFromDisplayName(displayName) ?? suffix?.level;
    if (level) group.variants[level] = runtimeId;
    else group.unsuffixed = runtimeId;
  }

  mergeAgentSingletons(groups);

  if (groups.size === 0) return fallback;

  const models: ProviderModelConfig[] = [];
  const routing: Record<string, AntigravityRouting> = {};

  for (const group of groups.values()) {
    const fallbackModel = fallback.models.find((model) => model.id === group.publicId);
    const fallbackRouting = fallback.routing[group.publicId];
    if (fallbackModel && fallbackRouting) {
      models.push(fallbackModel);
      routing[group.publicId] = fallbackRouting;
      continue;
    }

    const synthesized = synthesizeModel(group, fallback.models);
    models.push(synthesized.model);
    routing[group.publicId] = synthesized.routing;
  }

  for (const fallbackModel of fallback.models) {
    if (routing[fallbackModel.id]) continue;
    const fallbackRouting = fallback.routing[fallbackModel.id];
    if (!fallbackRouting) continue;
    models.push(fallbackModel);
    routing[fallbackModel.id] = fallbackRouting;
  }

  models.sort(comparePublicModels);
  return { models, routing };
}

function ensureGroup(groups: Map<string, RuntimeGroup>, publicId: string): RuntimeGroup {
  const existing = groups.get(publicId);
  if (existing) return existing;
  const created: RuntimeGroup = {
    publicId,
    variants: {},
    displayNames: [],
  };
  groups.set(publicId, created);
  return created;
}

function absorbMetadata(
  group: RuntimeGroup,
  info: ModelInfoRaw | undefined,
  displayName: string | undefined,
): void {
  if (displayName) group.displayNames.push(displayName);
  if (info?.supportsThinking === true) group.supportsThinking = true;
  else if (info?.supportsThinking === false && group.supportsThinking !== true) {
    group.supportsThinking = false;
  }
  if (info?.supportsImages === true) group.supportsImages = true;
  if (info?.supportsImages === false && group.supportsImages === undefined) {
    group.supportsImages = false;
  }
}

function mergeAgentSingletons(groups: Map<string, RuntimeGroup>): void {
  for (const [publicId, group] of [...groups.entries()]) {
    if (!publicId.endsWith("-agent")) continue;
    if (Object.keys(group.variants).length > 0) continue;
    const family = displayFamily(group.displayNames[0]);
    if (!family) continue;
    const target = [...groups.values()].find(
      (candidate) =>
        candidate.publicId !== publicId &&
        candidate.displayNames.some((name) => displayFamily(name) === family),
    );
    if (!target || !group.unsuffixed) continue;
    const level = levelFromDisplayName(group.displayNames[0]) ?? ThinkingEffort.High;
    target.variants[level] = group.unsuffixed;
    absorbMetadata(target, { supportsThinking: group.supportsThinking }, group.displayNames[0]);
    groups.delete(publicId);
  }
}

function parseThinkingSuffix(
  runtimeId: string,
): { baseId: string; level: ThinkingLevel } | undefined {
  const lower = runtimeId.toLowerCase();
  for (const { suffix, level } of THINKING_SUFFIXES) {
    if (lower.endsWith(`-${suffix}`)) {
      return { baseId: runtimeId.slice(0, -(suffix.length + 1)), level };
    }
  }
  return undefined;
}

function levelFromDisplayName(displayName: string | undefined): ThinkingLevel | undefined {
  if (!displayName) return undefined;
  for (const { pattern, level } of DISPLAY_LEVELS) {
    if (pattern.test(displayName)) return level;
  }
  return undefined;
}

function modelDisplayName(info: ModelInfoRaw | undefined): string | undefined {
  if (!info) return undefined;
  if (typeof info.displayName === "string" && info.displayName) return info.displayName;
  if (typeof info.label === "string" && info.label) return info.label;
  if (typeof info.modelName === "string" && info.modelName) return info.modelName;
  return undefined;
}

function displayFamily(displayName: string | undefined): string | undefined {
  if (!displayName) return undefined;
  return displayName
    .replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "")
    .trim()
    .toLowerCase();
}

function synthesizeModel(
  group: RuntimeGroup,
  fallbackModels: ProviderModelConfig[],
): { model: ProviderModelConfig; routing: AntigravityRouting } {
  const template = familyTemplate(group.publicId, fallbackModels);
  const advertisedLevels = advertisedThinkingLevels(group);
  const routing = routingFromVariants(group.publicId, group.variants, group.unsuffixed);
  const supportsImages = group.supportsImages ?? template?.input.includes("image") ?? true;
  const reasoning =
    advertisedLevels.size > 0 ||
    group.supportsThinking === true ||
    (group.supportsThinking === undefined && Boolean(template?.reasoning));
  return {
    model: {
      id: group.publicId,
      name: publicModelName(group),
      reasoning,
      thinking: thinkingConfigFromLevels(advertisedLevels, routing),
      input: supportsImages ? ["text", "image"] : ["text"],
      cost: template?.cost ?? ZERO_COST,
      contextWindow: template?.contextWindow ?? 128000,
      maxTokens: template?.maxTokens ?? 8192,
    },
    routing,
  };
}

function advertisedThinkingLevels(group: RuntimeGroup): Set<string> {
  const levels = new Set(Object.keys(group.variants));
  if (levels.size > 0) return levels;
  // Explicit false from the catalog must not grow a fake High control.
  if (group.supportsThinking === false) return levels;
  if (group.supportsThinking === true || group.unsuffixed) {
    levels.add(ThinkingEffort.High);
  }
  return levels;
}

function routingFromVariants(
  publicId: string,
  variants: Partial<Record<ThinkingLevel, string>>,
  unsuffixed?: string,
): AntigravityRouting {
  const defaultRequestId =
    variants[ThinkingEffort.Low] ??
    variants[ThinkingEffort.Minimal] ??
    variants[ThinkingEffort.Medium] ??
    variants[ThinkingEffort.High] ??
    unsuffixed ??
    publicId;

  const pick = (...keys: ThinkingLevel[]): string => {
    for (const key of keys) {
      const id = variants[key];
      if (id) return id;
    }
    return unsuffixed ?? defaultRequestId;
  };

  return {
    off: pick(
      ThinkingEffort.Low,
      ThinkingEffort.Minimal,
      ThinkingEffort.Medium,
      ThinkingEffort.High,
    ),
    routing: {
      minimal: pick(
        ThinkingEffort.Minimal,
        ThinkingEffort.Low,
        ThinkingEffort.Medium,
        ThinkingEffort.High,
      ),
      low: pick(
        ThinkingEffort.Low,
        ThinkingEffort.Minimal,
        ThinkingEffort.Medium,
        ThinkingEffort.High,
      ),
      medium: pick(
        ThinkingEffort.Medium,
        ThinkingEffort.Low,
        ThinkingEffort.High,
        ThinkingEffort.Minimal,
      ),
      high: pick(
        ThinkingEffort.High,
        ThinkingEffort.Medium,
        ThinkingEffort.Low,
        ThinkingEffort.Minimal,
      ),
      xhigh: pick(
        ThinkingEffort.Xhigh,
        ThinkingEffort.High,
        ThinkingEffort.Medium,
        ThinkingEffort.Low,
      ),
    },
    defaultRequestId,
  };
}

/**
 * The official `thinking` metadata shape an extension may attach to a model.
 * Derived from `ProviderModelConfig` rather than imported so this module keeps
 * depending on the provider config type only.
 */
type AntigravityThinking = NonNullable<ProviderModelConfig["thinking"]>;

function thinkingConfigFromLevels(
  levels: Set<string>,
  routing: AntigravityRouting,
): AntigravityThinking | undefined {
  const efforts = OMP_EFFORTS.filter((level) => levels.has(level));
  if (efforts.length === 0) return undefined;

  const effortRouting: Record<string, string> = {};
  if (routing.off) effortRouting.off = routing.off;
  for (const effort of efforts) {
    const wireId = routing.routing?.[effort as ThinkingEffort];
    if (wireId) effortRouting[effort] = wireId;
  }

  // `OMP_EFFORTS` is spelled with local literals because OMP declares `Effort`
  // as a `const enum`; the cast is the single point that relies on the two
  // vocabularies agreeing.
  return {
    mode: "budget",
    efforts: [...efforts] as AntigravityThinking["efforts"],
    defaultLevel: efforts[0] as AntigravityThinking["defaultLevel"],
    effortRouting,
    // Cloud Code Assist re-applies the per-runtime-id baked thinking default
    // when `thinkingConfig` is absent, so an off request must send budget 0.
    suppressWhenOff: true,
  };
}

function familyTemplate(
  publicId: string,
  fallbackModels: ProviderModelConfig[],
): ProviderModelConfig | undefined {
  if (/^gemini-.*-flash/i.test(publicId)) {
    return fallbackModels.find((model) => /^gemini-.*-flash/i.test(model.id));
  }
  if (/^gemini-.*-pro/i.test(publicId)) {
    return fallbackModels.find((model) => /^gemini-.*-pro/i.test(model.id));
  }
  if (publicId.startsWith("claude-opus")) {
    return fallbackModels.find((model) => model.id.startsWith("claude-opus"));
  }
  if (publicId.startsWith("claude-")) {
    return (
      fallbackModels.find((model) => model.id.startsWith("claude-sonnet")) ??
      fallbackModels.find((model) => model.id.startsWith("claude-"))
    );
  }
  if (publicId.startsWith("gpt-oss")) {
    return fallbackModels.find((model) => model.id.startsWith("gpt-oss"));
  }
  if (publicId.startsWith("gemini-")) {
    return fallbackModels.find((model) => model.id.startsWith("gemini-"));
  }
  return undefined;
}

function publicModelName(group: RuntimeGroup): string {
  const family = group.displayNames.map((name) => displayFamily(name)).find(Boolean);
  if (family) {
    return `${titleCase(family)} (Antigravity)`;
  }
  return `${humanizePublicId(group.publicId)} (Antigravity)`;
}

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/g, (char) => char.toUpperCase());
}

/** Module-private: drives `publicModelName` for synthesized catalog entries. */
function humanizePublicId(id: string): string {
  const tokens = id.split("-");
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const next = tokens[i + 1];
    if (token === "gpt" && next === "oss") {
      words.push("GPT-OSS");
      i++;
      continue;
    }
    if (/^\d+$/.test(token) && next && /^\d+$/.test(next)) {
      words.push(`${token}.${next}`);
      i++;
      continue;
    }
    if (/^\d/.test(token)) {
      words.push(token.toUpperCase());
      continue;
    }
    words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ");
}

function parseGeminiVersion(id: string): number {
  const match = id.match(/^gemini-(\d+)(?:\.(\d+))?/i);
  if (!match) return 0;
  return Number(match[1]) * 1000 + Number(match[2] || 0);
}

function comparePublicModels(a: ProviderModelConfig, b: ProviderModelConfig): number {
  const rankA = modelRank(a.id);
  const rankB = modelRank(b.id);
  if (rankA[0] !== rankB[0]) return rankA[0] - rankB[0];
  if (rankA[1] !== rankB[1]) return rankA[1] - rankB[1];
  return a.id.localeCompare(b.id);
}

function modelRank(id: string): [number, number] {
  const version = parseGeminiVersion(id);
  if (/^gemini-.*flash/i.test(id) && !/pro/i.test(id)) return [0, -version];
  if (id.startsWith("claude-opus")) return [1, 0];
  if (id.startsWith("claude-sonnet")) return [2, 0];
  if (id.startsWith("claude-")) return [3, 0];
  if (/^gemini-.*pro/i.test(id)) return [4, -version];
  if (id.startsWith("gemini-")) return [5, -version];
  if (id.startsWith("gpt-oss")) return [6, 0];
  return [7, 0];
}
