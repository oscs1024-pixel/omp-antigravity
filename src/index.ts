import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ExtensionCommandContext, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { getApiKey, loginAntigravity, refreshAntigravityToken } from "./auth/index.js";
import { DEFAULT_ENDPOINT, endpointCandidates, parseApiKey } from "./client/index.js";
import { getLastDiagnostics, runWithDiagnostics } from "./diagnostics/index.js";
import {
  DEFAULT_IMAGE_DIR,
  DEFAULT_IMAGE_MODEL,
  generateAntigravityImage,
  IMAGE_ASPECT_RATIOS,
  parseImageCommandArgs,
  type ImageCommandArgs,
} from "./image/index.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  resolvedCatalog,
} from "./models/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import {
  antigravityUsageProvider,
  fetchAccountUsage,
  formatAccountQuotaSummary,
  formatModelsList,
  formatUsageSummary,
  resolveApiKeyFromContext,
} from "./usage/index.js";
import type { AccountUsage } from "./types/index.js";
import { isRecord, prewarmConnection, redactSecrets, safeError } from "./utils/index.js";

/**
 * OMP's interactive `ui.notify` writes into the chat transcript. `console.log` in
 * that mode prints to the raw terminal and paints over the TUI. Use one channel only.
 */
function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") {
    console.error(text);
  } else {
    console.log(text);
  }
}

async function withUsage(
  ctx: ExtensionCommandContext,
  fn: (usage: AccountUsage) => string,
): Promise<void> {
  try {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      emitCommandOutput(
        ctx,
        "No Antigravity credentials. Run /login antigravity first.",
        "warning",
      );
      return;
    }
    if (ctx.hasUI) ctx.ui.notify("Fetching Antigravity usage…", "info");
    const usage = await runWithDiagnostics(() => fetchAccountUsage(apiKey));
    emitCommandOutput(ctx, fn(usage));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitCommandOutput(ctx, `Antigravity usage failed: ${redactSecrets(msg)}`, "warning");
  }
}

/**
 * Narrow the `generate_antigravity_image` tool arguments from `unknown`.
 *
 * OMP's injected `pi.zod` builder produces an omptype `ZodLikeSchema`, which
 * satisfies pi-ai's `TJsonSchema` branch rather than its `Type` branch — so
 * `Static<TParams>` collapses to `unknown` for every `z.object(...)` tool schema.
 * OMP's own bundled example (`examples/extensions/hello.ts`) hits the identical
 * gap, so this is an upstream typing limitation, not a mistake in the schema.
 *
 * The schema passed as `parameters` is still what OMP validates tool arguments
 * against before dispatch. This helper only restores a concrete shape for the
 * handler, and deliberately coerces rather than asserts: the real semantic
 * validation (prompt length, model id, aspect ratio, path containment) lives in
 * `generateAntigravityImage`, which rejects empty or unsafe values with a
 * user-facing error.
 */
function readGenerateImageParams(value: unknown): ImageCommandArgs {
  const record = isRecord(value) ? value : {};
  return {
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    aspectRatio: typeof record.aspectRatio === "string" ? record.aspectRatio : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    path: typeof record.path === "string" ? record.path : undefined,
  };
}

export default function (pi: ExtensionAPI): void {
  pi.setLabel("Antigravity");

  // Prewarming is opportunistic. Configuration errors remain request-time
  // errors and must not prevent the extension from registering its commands.
  try {
    const primaryEndpoint = endpointCandidates()[0];
    if (primaryEndpoint) prewarmConnection(primaryEndpoint);
  } catch {
    // Invalid ANTIGRAVITY_BASE_URL is reported when the provider is used.
  }

  // OMP injects a Zod-compatible schema builder; the docs recommend it over the
  // legacy TypeBox `Type` helper for new tool schemas.
  const z = pi.zod;

  const initialCatalog = getCurrentAntigravityCatalog();

  pi.registerProvider(PROVIDER_ID, {
    // `ProviderConfig` has no `name` field — the display name OMP shows comes from
    // `oauth.name` below and from each model's `name`.
    baseUrl: DEFAULT_ENDPOINT,
    // OMP: a custom `api` id is registered together with `streamSimple` below.
    api: ANTIGRAVITY_API,
    // Static catalog stays as an offline/cold-start fallback alongside the
    // live discovery result from fetchDynamicModels.
    models: initialCatalog.models,
    // OMP-native streaming: Cloud Code Assist is not OpenAI-compatible, so all
    // requests go through the native streamSimple implementation.
    streamSimple: streamAntigravity,
    // OMP: normalized usage fetcher, so OMP's own usage surfaces can show
    // Antigravity quota instead of only the /antigravity.usage command.
    usage: antigravityUsageProvider,
    // OMP: dynamic model discovery via /v1internal:fetchAvailableModels.
    // Throws (instead of returning []) when unauthenticated or empty, so OMP
    // retries in minutes rather than caching an empty catalog for 24h.
    fetchDynamicModels: async (apiKey: string | undefined) => {
      if (!apiKey) {
        throw new Error("Antigravity credentials not available yet. Run /login antigravity first.");
      }
      const discovered = await discoverAntigravityModels(apiKey);
      if (discovered.catalog.models.length === 0) {
        throw new Error("Antigravity model discovery returned no selectable models");
      }
      const next = resolvedCatalog(discovered.catalog, getCurrentAntigravityCatalog());
      // Bucket under the project discovery resolved for this account. OMP hands
      // this callback a bare access token, so the credential's own project id is
      // not readable here — without using the discovered one the per-account
      // routing table documented in docs/DYNAMIC_MODEL_DISCOVERY.md stays empty
      // and every account shares one last-writer-wins routing table.
      applyAntigravityCatalog(next, discovered.projectId);
      return next.models;
    },
    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
  });

  pi.registerCommand("antigravity.accounts", {
    description:
      "List stored Antigravity accounts with quota or pin session to an account (usage: /antigravity.accounts [<number|email>])",
    handler: async (args, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      const authStorage: AuthStorage | undefined = ctx.modelRegistry.authStorage;

      if (!authStorage || typeof authStorage.listOAuthAccounts !== "function") {
        const apiKey = await resolveApiKeyFromContext(ctx);
        let projectInfo = "";
        if (apiKey) {
          try {
            const parsed = parseApiKey(apiKey);
            if (parsed.projectId) projectInfo = ` (project: ${parsed.projectId})`;
          } catch {
            // bare token
          }
        }
        emitCommandOutput(
          ctx,
          `Antigravity accounts:\nActive session credentials: configured${projectInfo}\n(Host multi-account storage inspection is unavailable in this environment; use /session pin)`,
        );
        return;
      }

      const accounts = authStorage.listOAuthAccounts(PROVIDER_ID, sessionId);
      if (!accounts.length) {
        emitCommandOutput(
          ctx,
          "No stored OAuth accounts for Antigravity. Run /login antigravity to add an account.",
          "warning",
        );
        return;
      }

      const targetArg = args?.trim();
      if (targetArg) {
        let match = accounts.find((acc) => String(acc.position + 1) === targetArg);
        if (!match) {
          const lower = targetArg.toLowerCase();
          const matches = accounts.filter(
            (acc) =>
              acc.email?.toLowerCase().includes(lower) ||
              acc.projectId?.toLowerCase().includes(lower),
          );
          if (matches.length > 1) {
            emitCommandOutput(
              ctx,
              `Multiple accounts match "${targetArg}". Please specify by number:\n` +
                matches
                  .map((a) => `  #${a.position + 1}: ${a.email || a.projectId || "account"}`)
                  .join("\n"),
              "warning",
            );
            return;
          }
          match = matches[0];
        }
        if (!match) {
          emitCommandOutput(
            ctx,
            `No Antigravity account matching "${targetArg}". Available accounts:\n` +
              accounts
                .map((a) => `  #${a.position + 1}: ${a.email || a.projectId || "account"}`)
                .join("\n"),
            "warning",
          );
          return;
        }
        if (!sessionId) {
          emitCommandOutput(ctx, "Current session ID is not available to pin account.", "error");
          return;
        }
        if (!authStorage.pinSessionOAuthAccount(PROVIDER_ID, sessionId, match.credentialId)) {
          emitCommandOutput(
            ctx,
            `Failed to pin session to Account #${match.position + 1}: credential unavailable or a runtime/config override is active.`,
            "error",
          );
          return;
        }
        emitCommandOutput(
          ctx,
          `[Antigravity] Pinned session to Account #${match.position + 1} (${match.email || match.projectId || "account"}).`,
          "info",
        );
        return;
      }

      if (ctx.hasUI) ctx.ui.notify("Checking Antigravity accounts quota…", "info");

      const useColor = ctx.hasUI || Boolean(process.stdout?.isTTY);
      const hasExplicitActive = accounts.some((a) => a.active);
      const titleSuffix = hasExplicitActive ? "" : " (no pin — host auto-selects)";
      const lines: string[] = [`Antigravity Accounts (${accounts.length} stored${titleSuffix})`];
      const accountIdentity = (acc: (typeof accounts)[number]) => {
        const num = `#${acc.position + 1}`;
        const statusDot = acc.active ? (useColor ? "\x1b[32m●\x1b[0m" : "●") : "○";
        const tag = acc.active ? (useColor ? " \x1b[32m[ACTIVE]\x1b[0m" : " [ACTIVE]") : "";
        return {
          header: `  ${statusDot} ${num}: ${acc.email || "(no email)"}${tag}`,
          projectLine: `      Project: ${acc.projectId || "unknown"}`,
        };
      };
      const inspectAccount = async (acc: (typeof accounts)[number]): Promise<string> => {
        const { header, projectLine } = accountIdentity(acc);
        try {
          let accessToken: string | undefined;
          let projectId: string | undefined = acc.projectId;

          // Try reading cached access token from snapshot if still fresh (avoids redundant refresh)
          if (typeof authStorage.exportSnapshot === "function") {
            try {
              const snapshot = authStorage.exportSnapshot();
              const match = snapshot?.credentials?.find(
                (c) => c.id === acc.credentialId && c.provider === PROVIDER_ID,
              );
              if (match && match.credential.type === "oauth") {
                const cred = match.credential;
                if (
                  typeof cred.access === "string" &&
                  cred.access &&
                  typeof cred.expires === "number" &&
                  Date.now() + 60_000 < cred.expires
                ) {
                  accessToken = cred.access;
                  if (cred.projectId) projectId = cred.projectId;
                }
              }
            } catch {
              // best-effort snapshot inspection
            }
          }

          if (!accessToken) {
            const access = await authStorage.getOAuthAccessAt(PROVIDER_ID, acc.position);
            if (access?.ok && access.accessToken) {
              accessToken = access.accessToken;
              if (access.projectId) projectId = access.projectId;
            } else {
              const err = access && !access.ok ? access.error : "offline";
              return `${header}\n${projectLine}\n      Quota: unable to resolve access token (${err})`;
            }
          }

          const usage = await fetchAccountUsage(
            JSON.stringify({
              token: accessToken,
              projectId: projectId || "",
              email: acc.email,
            }),
            { signal: inspectionDeadline.signal },
          );
          const quotaLines = formatAccountQuotaSummary(usage, { useColor })
            .split("\n")
            .map((line) => `      ${line}`)
            .join("\n");
          return `${header}\n${projectLine}\n${quotaLines}`;
        } catch (error) {
          return `${header}\n${projectLine}\n      Quota unavailable: ${safeError(error).slice(0, 100)}`;
        }
      };
      const inspectionDeadline = new AbortController();
      const inspectionTimeout = setTimeout(() => inspectionDeadline.abort(), 20_000);
      const accountRows = new Array<string>(accounts.length);
      let nextAccount = 0;
      const inspectWorker = async (): Promise<void> => {
        while (true) {
          const index = nextAccount++;
          if (index >= accounts.length) return;
          const account = accounts[index];
          const { header, projectLine } = accountIdentity(account);
          const timeoutResult = `${header}\n${projectLine}\n      Quota unavailable: account inspection deadline exceeded`;
          if (inspectionDeadline.signal.aborted) {
            accountRows[index] = timeoutResult;
            continue;
          }
          let onAbort: (() => void) | undefined;
          const abortResult = new Promise<string>((resolve) => {
            onAbort = () => resolve(timeoutResult);
            inspectionDeadline.signal.addEventListener("abort", onAbort, { once: true });
            if (inspectionDeadline.signal.aborted) onAbort();
          });
          try {
            accountRows[index] = await Promise.race([inspectAccount(account), abortResult]);
          } finally {
            if (onAbort) inspectionDeadline.signal.removeEventListener("abort", onAbort);
          }
        }
      };
      try {
        await Promise.all(
          Array.from({ length: Math.min(3, accounts.length) }, () => inspectWorker()),
        );
      } finally {
        clearTimeout(inspectionTimeout);
      }
      lines.push("", accountRows.join("\n\n"), "");
      lines.push("Switch account:");
      lines.push("  /antigravity.accounts <number|email>");
      lines.push("  /session pin <number>");
      lines.push("Example: /antigravity.accounts 2");
      emitCommandOutput(ctx, lines.join("\n"));
    },
  });
  pi.registerCommand("antigravity.usage", {
    description: "Show Antigravity shared quota pools (Gemini / Claude+GPT, 5h + weekly)",
    handler: async (_args, ctx) => {
      const useColor = ctx.hasUI || Boolean(process.stdout?.isTTY);
      await withUsage(ctx, (usage) => formatUsageSummary(usage, { useColor }));
    },
  });
  pi.registerCommand("antigravity.models", {
    description: "List Antigravity runtime models + remaining pool fraction",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args || "");
      await withUsage(ctx, (usage) => formatModelsList(usage, { all }));
    },
  });

  pi.registerCommand("antigravity.refresh", {
    description: "Force refresh Antigravity dynamic model catalog",
    handler: async (_args, ctx) => {
      const apiKey = await resolveApiKeyFromContext(ctx);
      if (!apiKey) {
        emitCommandOutput(
          ctx,
          "No Antigravity credentials. Run /login antigravity first.",
          "warning",
        );
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Refreshing Antigravity models…", "info");
      try {
        if (typeof ctx.modelRegistry?.refreshProvider === "function") {
          // OMP public API: re-runs fetchDynamicModels for this provider online.
          await ctx.modelRegistry.refreshProvider(PROVIDER_ID, "online");
        } else {
          const discovered = await discoverAntigravityModels(apiKey);
          if (discovered.catalog.models.length > 0) {
            const next = resolvedCatalog(discovered.catalog, getCurrentAntigravityCatalog());
            applyAntigravityCatalog(next, discovered.projectId);
          }
        }
        const catalog = getCurrentAntigravityCatalog();
        const count = catalog.models.length;
        const sample = catalog.models
          .slice(0, 4)
          .map((m) => m.name || m.id)
          .join(", ");
        emitCommandOutput(
          ctx,
          `Antigravity models refreshed (${count} available: ${sample}${count > 4 ? ", …" : ""})`,
          "info",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity model refresh failed: ${redactSecrets(msg)}`, "error");
      }
    },
  });

  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: async (_args, ctx) => {
      const apiKey = await resolveApiKeyFromContext(ctx);
      let diagnosticsScope: string | undefined;
      if (apiKey) {
        try {
          const parsed = parseApiKey(apiKey);
          diagnosticsScope = parsed.email || parsed.projectId || undefined;
        } catch {
          // bare token
        }
      }
      const d = getLastDiagnostics(diagnosticsScope);
      const lines = [
        `provider=${PROVIDER_ID}`,
        `host=omp`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastProjectId=${d.projectId || "none"}`,
        ...(d.latencyMs !== undefined ? [`lastLatencyMs=${d.latencyMs}`] : []),
        `toolSchemaWarnings=${d.toolSchemaWarnings || "none"}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.accounts /antigravity.usage /antigravity.models /antigravity.refresh /antigravity.doctor /antigravity.image",
      ];
      emitCommandOutput(ctx, `Antigravity doctor\n${lines.join("\n")}`);
    },
  });

  pi.registerCommand("antigravity.image", {
    description:
      "Generate an image via Antigravity (usage: /antigravity.image [--ratio 16:9] <prompt>)",
    handler: async (args, ctx) => {
      const parsed = parseImageCommandArgs(args || "");
      if (!parsed.prompt) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.image [--ratio 16:9] [--model gemini-3-pro-image] [--path file.png] <prompt>",
          "warning",
        );
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Generating Antigravity image…", "info");
        const result = await generateAntigravityImage({
          apiKey,
          cwd: ctx.cwd,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          model: parsed.model,
          path: parsed.path,
        });
        emitCommandOutput(ctx, `Saved image to ${result.savedPaths.join(", ")}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity image failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  pi.registerTool({
    name: "generate_antigravity_image",
    label: "Generate Antigravity image",
    approval: "write",
    description: `Generate an image via Antigravity using the signed-in Google account. Saves under ${DEFAULT_IMAGE_DIR}/ unless path is set.`,
    parameters: z.object({
      prompt: z.string().describe("Image description."),
      aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional().describe("Output aspect ratio."),
      model: z.string().optional().describe(`Image model id. Default: ${DEFAULT_IMAGE_MODEL}.`),
      path: z.string().optional().describe("Project-relative file or directory to save the image."),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID, sessionId);
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
      const parsed = readGenerateImageParams(params);
      const result = await generateAntigravityImage({
        apiKey,
        cwd: ctx.cwd,
        prompt: parsed.prompt,
        aspectRatio: parsed.aspectRatio,
        model: parsed.model,
        path: parsed.path,
        signal,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved image to ${result.savedPaths.join(", ")}`,
          },
          ...result.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: { model: result.model, savedPaths: result.savedPaths },
      };
    },
  });
}
