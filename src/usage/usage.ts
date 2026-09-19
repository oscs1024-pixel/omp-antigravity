import type {
  UsageAmount,
  UsageCredential,
  UsageLimit,
  UsageProvider,
  UsageReport,
  UsageStatus,
  UsageWindow,
} from "@oh-my-pi/pi-ai";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import {
  AntigravityHttpError,
  DISCOVERY_TIMEOUT_MS,
  extractProjectId,
  fetchAvailableModelsCatalog,
  fetchCodeAssistMetadata,
  parseApiKey,
  postAntigravityJson,
  resolveProjectId,
} from "../client/client.js";
import { setLastAccountId, setLastError, setLastProjectId } from "../diagnostics/diagnostics.js";
import { isRecord } from "../utils/util.js";
import { safeError } from "../utils/security.js";
import { PROVIDER_ID } from "../models/models.js";
import type {
  AccountUsage,
  AvailableModelsRaw,
  LoadCodeAssistRaw,
  ModelQuotaRow,
  QuotaBucket,
  QuotaGroup,
  QuotaSummaryRaw,
  TierInfo,
  TierRaw,
} from "../types/types.js";

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function remainingPercent(remaining?: number): number | undefined {
  if (remaining === undefined) return undefined;
  return Math.round(remaining * 1000) / 10;
}

function progressBar(remaining?: number, width = 20): string {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const filled = Math.max(0, Math.min(width, Math.round(remaining * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function formatReset(resetTime?: string): string {
  if (!resetTime) return "n/a";
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return resetTime;
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function parseQuotaSummary(data: unknown): { groups: QuotaGroup[]; description?: string } {
  const summary = (isRecord(data) ? data : {}) as QuotaSummaryRaw;
  const groups: QuotaGroup[] = [];
  for (const group of summary.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const bucket of group.buckets || []) {
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data: unknown): {
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
} {
  const raw = (isRecord(data) ? data : {}) as AvailableModelsRaw;
  const modelsObj = raw.models && isRecord(raw.models) ? raw.models : {};
  const models: ModelQuotaRow[] = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!info || !isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const qi = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(qi.remainingFraction),
      resetTime: qi.resetTime ? String(qi.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

function parseTier(value: unknown): TierInfo | undefined {
  if (!isRecord(value)) return undefined;
  const tier = value as TierRaw;
  if (!tier.id && !tier.name) return undefined;
  return {
    id: tier.id ? String(tier.id) : undefined,
    name: tier.name ? String(tier.name) : undefined,
    description: tier.description ? String(tier.description) : undefined,
  };
}

async function loadCodeAssistSafe(token: string, signal?: AbortSignal) {
  try {
    return await fetchCodeAssistMetadata(token, signal);
  } catch {
    return null;
  }
}

/**
 * The user-quota-summary RPC is gated behind a paid subscription: free-tier
 * accounts get 403 SUBSCRIPTION_REQUIRED (#3501). It is best-effort diagnostics
 * only — never let it block the rest of the account data (models, tier, project).
 */
async function fetchQuotaSummarySafe(
  token: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; result: { endpoint: string; status: number; data: unknown } }
  | {
      ok: false;
      error: string;
      validationUrl?: string;
    }
> {
  try {
    return {
      ok: true,
      result: await postAntigravityJson(
        "/v1internal:retrieveUserQuotaSummary",
        token,
        {},
        { signal, timeoutMs: DISCOVERY_TIMEOUT_MS },
      ),
    };
  } catch (error) {
    let validationUrl: string | undefined;
    if (error instanceof AntigravityHttpError && isRecord(error.data)) {
      const errObj = error.data as {
        error?: {
          details?: Array<{ reason?: string; metadata?: { validation_url?: string } }>;
        };
      };
      validationUrl = errObj.error?.details?.find(
        (d) => d.reason === "VALIDATION_REQUIRED" && typeof d.metadata?.validation_url === "string",
      )?.metadata?.validation_url;
    }
    const msg = safeError(error);
    setLastError(msg);
    return { ok: false, error: msg, validationUrl };
  }
}

export async function fetchAccountUsage(
  apiKeyRaw?: string,
  options?: { signal?: AbortSignal },
): Promise<AccountUsage> {
  const signal = options?.signal;
  const creds = parseApiKey(apiKeyRaw);
  setLastAccountId(creds.email);
  const initialProjectId =
    creds.projectId ||
    resolveProjectId({
      credentialProjectId: creds.projectId,
    });

  // Fetch loadCodeAssist, quota summary, and available models all in parallel
  // to minimize command execution latency.
  const [assistResult, summaryRes, available] = await Promise.all([
    loadCodeAssistSafe(creds.token, signal),
    fetchQuotaSummarySafe(creds.token, signal),
    fetchAvailableModelsCatalog(creds.token, initialProjectId, signal),
  ]);

  // Derive project ID from the loadCodeAssist response or stored project ID.
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    warmedProject: discoveredProject ?? null,
    credentialProjectId: creds.projectId,
  });
  setLastProjectId(projectId);

  const summary = summaryRes.ok ? summaryRes.result : null;
  const quotaSummaryError = summaryRes.ok ? undefined : summaryRes.error;
  const validationUrl = summaryRes.ok ? undefined : summaryRes.validationUrl;
  const { groups, description } = summary
    ? parseQuotaSummary(summary.data)
    : { groups: [], description: undefined };
  const { models, defaultAgentModelId } = parseModels(available.data);

  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);

  // Google returns currentTier=free-tier even for Google AI Pro accounts.
  // The real subscription lives in paidTier (e.g. g1-pro-tier / Google AI Pro).
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    projectId,
    endpoint: summary?.endpoint ?? available.endpoint ?? assistResult?.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    quotaSummaryError,
    validationUrl,
    models,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };
}

function quotaErrorNote(msg: string): string {
  if (/SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(msg)) {
    return "Aggregate quota summary needs a paid subscription (free-tier can't use that endpoint). Per-model usage is still available via /antigravity.models.";
  }
  return `Aggregate quota summary unavailable: ${msg.slice(0, 160)}`;
}

export function formatUsageSummary(usage: AccountUsage): string {
  const lines: string[] = [];

  if (usage.planLabel) lines.push(usage.planLabel);

  if (!usage.groups.length) {
    if (usage.quotaSummaryError) {
      lines.push(quotaErrorNote(usage.quotaSummaryError));
    } else {
      lines.push("No quota groups returned.");
    }
    return lines.join("\n");
  }

  for (const group of usage.groups) {
    if (lines.length) lines.push("");
    lines.push(group.displayName);
    for (const bucket of group.buckets) {
      const rem = remainingPercent(bucket.remainingFraction);
      lines.push(
        `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${rem ?? "?"}% left · resets ${formatReset(bucket.resetTime)}`,
      );
    }
  }

  return lines.join("\n").trimEnd();
}
export function formatAccountQuotaSummary(usage: AccountUsage): string {
  const lines: string[] = [];
  if (usage.planLabel) {
    lines.push(`Plan: ${usage.planLabel}`);
  }

  for (const group of usage.groups) {
    if (!group.buckets.length) continue;

    const rawGroup = group.displayName.trim();
    const groupLabel = rawGroup
      .replace(/\s+models$/i, "")
      .replace(/\s*(?:and|&)\s+other\b/i, "/Other")
      .trim();
    if (groupLabel && !/quota\s*group/i.test(rawGroup)) {
      lines.push(groupLabel);
    }

    const buckets = group.buckets.map((bucket) => {
      const rawLabel = bucket.displayName.trim();
      const label = /^five[\s_-]*hour(?:\s+limit)?(?:\s+remaining)?$/i.test(rawLabel)
        ? "5h"
        : /^weekly(?:\s+limit)?(?:\s+remaining)?$/i.test(rawLabel)
          ? "Weekly"
          : /^daily(?:\s+limit)?(?:\s+remaining)?$/i.test(rawLabel)
            ? "Daily"
            : rawLabel.replace(/\s+limit\s+remaining$/i, "");
      return { bucket, label };
    });
    const labelWidth = Math.max(...buckets.map(({ label }) => label.length));

    for (const { bucket, label } of buckets) {
      const percent = `${Math.round(bucket.remainingFraction * 100)}%`.padStart(4);
      const reset = bucket.resetTime ? `  resets ${formatReset(bucket.resetTime)}` : "";
      lines.push(
        `  ${label.padEnd(labelWidth)}  ${percent} left  ${progressBar(bucket.remainingFraction, 10)}${reset}`,
      );
    }
  }

  if (usage.groups.some((group) => group.buckets.length > 0)) {
    return lines.join("\n");
  }

  if (
    usage.validationUrl ||
    /VALIDATION_REQUIRED|verify your account/i.test(usage.quotaSummaryError || "")
  ) {
    lines.push(
      usage.validationUrl
        ? `Account verification required: ${usage.validationUrl}`
        : "Account verification required (Google human verification challenge)",
    );
  } else if (
    usage.quotaSummaryError &&
    /SUBSCRIPTION_REQUIRED|#3501/i.test(usage.quotaSummaryError)
  ) {
    lines.push("Free Tier (quota summary requires paid subscription)");
  } else if (usage.quotaSummaryError) {
    lines.push(`Quota unavailable: ${usage.quotaSummaryError.slice(0, 100)}`);
  } else {
    lines.push("Quota available");
  }

  return lines.join("\n");
}

export function formatModelsList(usage: AccountUsage, opts?: { all?: boolean }): string {
  const lines: string[] = [];
  lines.push("Antigravity available models");
  lines.push(`project=${usage.projectId}`);
  if (usage.defaultAgentModelId) lines.push(`defaultAgentModel=${usage.defaultAgentModelId}`);
  lines.push("");

  const rows = opts?.all
    ? usage.models
    : usage.models.filter((m) => !/tab_|chat_/i.test(m.modelId));

  if (!rows.length) {
    lines.push("No models returned.");
    return lines.join("\n");
  }

  const maxId = Math.max(...rows.map((m) => m.modelId.length), 8);
  for (const m of rows) {
    const rem = remainingPercent(m.remainingFraction);
    const flags = [
      m.recommended ? "recommended" : "",
      m.supportsThinking ? "thinking" : "",
      m.supportsImages ? "images" : "",
    ]
      .filter(Boolean)
      .join(",");
    const name = m.displayName && m.displayName !== m.modelId ? `  ${m.displayName}` : "";
    lines.push(
      `${m.modelId.padEnd(maxId)}  rem ${rem === undefined ? "  ?" : String(rem).padStart(5)}%  reset ${formatReset(m.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${name}`,
    );
  }
  lines.push("");
  lines.push("Note: remaining % is pool-shared (not a private per-model budget).");
  return lines.join("\n");
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Classify a quota bucket's window the way OMP's own Antigravity usage provider
 * does, so the normalized report renders with native window labels instead of
 * raw backend strings.
 */
function classifyWindow(
  id: string | undefined,
  label: string | undefined,
): UsageWindow | undefined {
  const source = `${id ?? ""} ${label ?? ""}`.toLowerCase();
  if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) {
    return { id: "weekly", label: "Weekly", durationMs: 7 * 24 * HOUR_MS };
  }
  if (source.includes("5h") || source.includes("five hour") || /5[\s_-]*hour/.test(source)) {
    return { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS };
  }
  if (source.includes("day") || source.includes("daily") || source.includes("24h")) {
    return { id: "daily", label: "Daily", durationMs: 24 * HOUR_MS };
  }
  if (id || label) return { id: id ?? label ?? "default", label: label ?? id ?? "Default" };
  return undefined;
}

function usageStatus(remainingFraction: number | undefined): UsageStatus {
  if (remainingFraction === undefined) return "unknown";
  if (remainingFraction <= 0) return "exhausted";
  if (remainingFraction <= 0.1) return "warning";
  return "ok";
}

/**
 * Map this provider's account usage onto OMP's normalized usage report, so OMP's
 * own usage surfaces can show Antigravity quota rather than only the plugin's
 * `/antigravity.usage` command.
 *
 * One limit is emitted per shared quota bucket. Per-model rows are deliberately
 * only summarized in `metadata`: they repeat the same shared pool figures, so
 * emitting one limit per model would fill the usage UI with duplicates.
 */
export function buildUsageReport(usage: AccountUsage): UsageReport {
  const shared = usage.groups.length > 1 || usage.groups.some((group) => group.buckets.length > 1);
  const limits: UsageLimit[] = [];

  for (const group of usage.groups) {
    for (const bucket of group.buckets) {
      const window = classifyWindow(bucket.window, bucket.displayName);
      const resetsAt = bucket.resetTime ? Date.parse(bucket.resetTime) : undefined;
      const hasResetsAt = Number.isFinite(resetsAt);
      const amount: UsageAmount = {
        unit: "percent",
        remainingFraction: bucket.remainingFraction,
      };
      limits.push({
        id: `${PROVIDER_ID}:${group.displayName}:${bucket.bucketId}`,
        label: bucket.displayName,
        scope: {
          provider: PROVIDER_ID,
          projectId: usage.projectId,
          ...(usage.email ? { accountId: usage.email } : {}),
          ...(usage.planLabel ? { tier: usage.planLabel } : {}),
          windowId: window?.id ?? bucket.bucketId,
          ...(shared ? { shared: true, sharedGroup: group.displayName } : {}),
        },
        ...(window || hasResetsAt
          ? {
              window: {
                ...(window ?? { id: bucket.bucketId, label: bucket.displayName }),
                ...(hasResetsAt ? { resetsAt } : {}),
              },
            }
          : {}),
        amount,
        status: usageStatus(bucket.remainingFraction),
      });
    }
  }

  const notes: string[] = [];
  if (usage.groupDescription) notes.push(usage.groupDescription);
  notes.push("Remaining percent reflects a shared pool, not a private per-model budget.");
  if (usage.quotaSummaryError) notes.push(quotaErrorNote(usage.quotaSummaryError));

  return {
    provider: PROVIDER_ID,
    fetchedAt: usage.fetchedAt,
    limits,
    notes,
    metadata: {
      endpoint: usage.endpoint,
      projectId: usage.projectId,
      plan: usage.planLabel ?? null,
      modelCount: usage.models.length,
      defaultAgentModelId: usage.defaultAgentModelId ?? null,
    },
  };
}

/**
 * OMP may hand a usage fetcher either the OAuth access token or the provider's
 * own API-key string, so accept both forms. The bare token is what
 * `AuthStorage` exposes for OAuth providers.
 */
function usageCredentialToken(credential: UsageCredential): string | undefined {
  if (typeof credential.accessToken === "string" && credential.accessToken) {
    return credential.accessToken;
  }
  if (typeof credential.apiKey === "string" && credential.apiKey) {
    try {
      return parseApiKey(credential.apiKey).token;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Normalized usage provider registered on the `ProviderConfig`.
 *
 * `validatesCredentials` is deliberately left unset: the aggregate quota-summary
 * RPC is gated behind a paid subscription, so a free-tier 403 is expected and
 * must not be read as a broken credential.
 */
export const antigravityUsageProvider: UsageProvider = {
  id: PROVIDER_ID,
  async fetchUsage(params): Promise<UsageReport | null> {
    const token = usageCredentialToken(params.credential);
    if (!token) return null;
    try {
      const usage = await fetchAccountUsage(
        JSON.stringify({
          token,
          projectId: params.credential.projectId ?? "",
          email: params.credential.email,
        }),
        { signal: params.signal },
      );
      return buildUsageReport(usage);
    } catch (error) {
      // Returning null (instead of throwing) keeps OMP's last-good report and
      // records the reason for /antigravity.doctor.
      setLastError(safeError(error));
      return null;
    }
  },
};

export async function resolveApiKeyFromContext(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  try {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    return await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID, sessionId);
  } catch {
    return undefined;
  }
}
