# Changelog

All notable changes to this project are documented in this file.

This project is a fork of [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity),
adapted to OMP's plugin and provider API. History before the fork lives in the upstream changelog;
entries here describe this plugin's OMP line only.

## [Unreleased]

### Added

- **Normalized usage reporting:** the provider registers `ProviderConfig.usage`, so Antigravity quota
  shows up in OMP's own usage surfaces instead of only through `/antigravity.usage`. One limit is
  emitted per shared quota bucket (per-model rows repeat the same pool, so they are summarized in
  `metadata` instead of duplicated), windows are classified into OMP's `5h` / `daily` / `weekly`
  labels, and a failed fetch returns `null` so the host keeps its last-good report.
- **`suppressWhenOff` thinking metadata:** models that already send `thinkingBudget: 0` when thinking
  is off now say so declaratively, matching how Cloud Code Assist re-applies server-side defaults.

### Fixed

- **Emoji mangling:** `sanitizeText` replaced every surrogate code unit, so each valid pair was split
  into two replacement characters — every emoji or astral-plane character in a user message, system
  prompt, tool result, or image prompt was corrupted before reaching the backend. It now matches valid
  pairs first and replaces only _lone_ surrogates (the invalid UTF-16 that strict JSON parsers reject).
- **Effort precedence in runtime-model routing:** `{ reasoning: "high", disableReasoning: true }` routed
  to the `-high` runtime model while sending `thinkingBudget: 0` — a thinking-tuned backend model asked
  not to think. The runtime model is now selected through the same `resolveRequestedEffort` precedence
  the generation config uses, and an explicit `ANTIGRAVITY_RUNTIME_MODEL` still overrides both.
- **Unbounded model-discovery cache:** eviction only dropped entries that had _already_ expired, so a
  session with many distinct (token, project, model) lookups grew the map without limit. It is now
  capped at 64 entries, oldest first.
- **Tool argument typing:** `generate_antigravity_image`'s `params` was collapsing to `unknown` because OMP's
  injected `pi.zod` builder satisfies pi-ai's `TJsonSchema` branch rather than its `Type` branch, so
  `Static<TParams>` could not infer. Arguments are now narrowed at a documented boundary. OMP's own
  bundled `examples/extensions/hello.ts` hits the same gap.

### Removed

- **Private keep-alive dispatcher and the `undici` dependency.** The runtime is Bun
  (`engines.bun`), where `process.versions.node` reports a Node 22+ compatibility version, so the
  guard always skipped the custom Agent — and Node's bundled `fetch` rejects an npm `undici` Agent
  outright while attaching one would bypass the host's proxy-aware dispatcher. Requests now go through
  the host's `fetch`, with the load-time connection pre-warm (and `ANTIGRAVITY_NO_PREWARM`) kept.
  `ANTIGRAVITY_HTTP2` and `ANTIGRAVITY_NO_KEEPALIVE` are gone with it.

## [0.1.0]

Port of `pi-antigravity` to Oh My Pi (OMP). The provider, streaming, discovery, diagnostics, usage,
and image-generation implementations carry over; the OMP adaptation is:

### Added

- **OMP provider registration:** registers the `antigravity` provider through
  `pi.registerProvider` with a native `streamSimple`, a static fallback catalog, and dynamic
  discovery wired to `fetchDynamicModels`.
- **Thinking metadata:** each model declares OMP's `thinking` capability
  (`mode: "budget"`, `efforts`, `defaultLevel`, `effortRouting`, `effortBudgets`) instead of the
  retired pi-era `thinkingLevelMap` field, so the effort menu and collapsed-variant resolution work.
- **OMP-only host symbol handling:** the legacy `calculateCost` and `isRetryableAssistantError`
  shims exist only under OMP's extension loader. They are now resolved defensively, with a flat-rate
  pricing fallback and an explicit skip, so the plugin still loads and its tests still run on a plain
  Bun/Node host.

### Changed

- **Plugin manifest:** the extension entry point is declared under `omp.extensions` in
  `package.json`, and the peer dependencies target `@oh-my-pi/pi-ai` / `@oh-my-pi/pi-coding-agent`.
- **Provider id:** registered as `antigravity`, which keeps it distinct from OMP's built-in
  `google-antigravity` provider so the two cannot shadow each other's OAuth handlers.
- **Generated images:** written under `.omp/generated-images/` (the OMP project config directory).
- **Provider refresh:** `/antigravity.refresh` drives `ctx.modelRegistry.refreshProvider`, and model
  discovery accepts the bare access token that OMP's `AuthStorage` hands to `fetchDynamicModels`,
  resolving the project id when the credential does not carry one.

### Fixed

- **OMP type/API drift:** `context.systemPrompt` is a `string[]` under OMP and is now joined rather
  than coerced, and OMP's `developer` message role is folded into the user turn instead of being
  dropped.

### Security

- Endpoint validation, callback loopback enforcement, diagnostic secret redaction, and the
  image-path containment checks are unchanged from upstream and covered by `scripts/security-check.ts`.
