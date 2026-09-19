import { createHash } from "node:crypto";
import { getModelEnum } from "../models/models.js";

export function antigravityEnv(name: string): string | undefined {
  return process.env[`ANTIGRAVITY_${name}`] || process.env[`NOAGY_${name}`];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
/**
 * Sets a key-value pair in a Map, maintaining insertion/recency order and enforcing
 * a maximum capacity by deleting the oldest entry when size exceeds `max`.
 */
export function setWithCap<K, V>(map: Map<K, V>, key: K, value: V, max = 64): void {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, value);
  if (map.size > max) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

export function sanitizeText(text: unknown): string {
  const value = String(text ?? "");
  // Replace only *lone* surrogates — invalid UTF-16 that strict JSON parsers
  // reject — and leave valid surrogate pairs untouched, so emoji and other
  // astral-plane characters reach the wire verbatim. Matching the pair first and
  // returning it unchanged is what separates the two cases: a naive
  // /[\uD800-\uDFFF]/g replaces each half of a valid pair, turning every emoji in
  // a user message, system prompt, or tool result into two replacement chars.
  return value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (match) =>
    match.length === 2 ? match : "\uFFFD",
  );
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function nowRequestId(): string {
  return antigravityRequestEnvelope("unknown", false).requestId;
}

/** Deterministic RFC 4122 v5 UUID from seed (survives restarts for the same session seed). */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type AntigravityEnvelopeOptions = {
  isClaude?: boolean;
  isNonGemini?: boolean;
  step?: number;
  lastStepIndex?: string;
  requestIndex?: number;
  userTurnIndex?: number;
  trajectoryId?: string;
  conversationId?: string;
  sessionId?: string;
  lastExecutionId?: string;
  /** Routes model_enum lookups through the per-account catalog when set. */
  projectId?: string;
};

export type SessionTrajectoryEntry = {
  conversationId: string;
  trajectoryId: string;
  sessionId: string;
  lastExecutionId?: string;
};

const sessionTrajectoryMap = new Map<string, SessionTrajectoryEntry>();

/** Stable conversationId and trajectoryId within a multi-turn conversation session. */
export function resolveSessionTrajectory(
  context?: {
    systemPrompt?: string[] | string;
    messages?: Array<{ role?: string; timestamp?: number; content?: unknown }>;
  },
  projectId?: string,
): SessionTrajectoryEntry {
  const firstMsg = context?.messages?.[0];
  if (!firstMsg) {
    return {
      conversationId: crypto.randomUUID(),
      trajectoryId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    };
  }
  // Hash the full first message (and system prompt) rather than truncating: two
  // conversations that share the first 64 chars but diverge later must not share
  // a trajectory or lastExecutionId. Genuinely identical openings still collide —
  // they are indistinguishable by definition.
  const systemSeed = Array.isArray(context?.systemPrompt)
    ? context.systemPrompt.join("\n")
    : typeof context?.systemPrompt === "string"
      ? context.systemPrompt
      : "";
  const contentSeed = createHash("sha256")
    .update(
      `${projectId || "default"}${firstMsg.role || "user"}${firstMsg.timestamp ?? ""}${systemSeed}${typeof firstMsg.content === "string" ? firstMsg.content : JSON.stringify(firstMsg.content ?? "")}`,
    )
    .digest("hex");
  const seed = contentSeed;
  let entry = sessionTrajectoryMap.get(seed);
  if (!entry) {
    entry = {
      conversationId: stableUuid(`antigravity:conv:${seed}`),
      trajectoryId: stableUuid(`antigravity:traj:${seed}`),
      sessionId: stableUuid(`antigravity:session:${seed}`),
    };
    setWithCap(sessionTrajectoryMap, seed, entry, 64);
  }
  return entry;
}
export function recordSessionExecutionId(
  context:
    { messages?: Array<{ role?: string; timestamp?: number; content?: unknown }> } | undefined,
  executionId: string | undefined,
  projectId?: string,
): void {
  if (!executionId) return;
  const entry = resolveSessionTrajectory(context, projectId);
  entry.lastExecutionId = executionId;
}

export function clearSessionTrajectoryMap(): void {
  sessionTrajectoryMap.clear();
}

export function antigravityRequestEnvelope(
  wireModelId: string,
  optionsOrIsClaude: boolean | AntigravityEnvelopeOptions = false,
): { requestId: string; sessionId: string; labels: Record<string, string> } {
  const options: AntigravityEnvelopeOptions =
    typeof optionsOrIsClaude === "boolean" ? { isClaude: optionsOrIsClaude } : optionsOrIsClaude;

  const isClaude = Boolean(options.isClaude);
  const isNonGemini = Boolean(options.isNonGemini || isClaude);
  const step = Math.max(1, options.step ?? 1);
  const lastStepIndex = options.lastStepIndex ?? String(Math.max(0, step - 1));
  const requestIndex = options.requestIndex ?? options.userTurnIndex ?? Math.max(0, step - 1);
  const agentId = options.conversationId || crypto.randomUUID();
  const trajectoryId = options.trajectoryId || crypto.randomUUID();
  const sessionId = options.sessionId || crypto.randomUUID();

  const claudeLabel = isClaude ? "true" : "false";
  const nonGeminiLabel = isNonGemini ? "true" : "false";

  const labels: Record<string, string> = {
    last_step_index: lastStepIndex,
    request_id: `${trajectoryId}-${requestIndex}`,
    trajectory_id: trajectoryId,
    used_claude: claudeLabel,
    used_claude_conservative: claudeLabel,
    used_non_gemini_model: nonGeminiLabel,
    ...(options.lastExecutionId && antigravityEnv("DISABLE_LAST_EXECUTION_ID") !== "1"
      ? { last_execution_id: options.lastExecutionId }
      : {}),
  };

  const modelEnum = getModelEnum(wireModelId, options.projectId);
  if (modelEnum) {
    labels.model_enum = modelEnum;
  }

  return {
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    sessionId,
    labels,
  };
}
