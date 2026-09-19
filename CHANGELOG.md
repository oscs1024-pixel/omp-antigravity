# Changelog

All notable changes to this project are documented in this file.

This project is a fork of [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity),
adapted to OMP's plugin and provider API. History before the fork lives in the upstream changelog;
entries here describe this plugin's OMP line only.

## [Unreleased]

## [0.8.0] - 2026-09-19

### Added

- **Native multi-account support:** Antigravity credentials participate in OMP's account pool with
  per-session pinning, automatic quota-aware rotation, isolated project/model state, and
  `/antigravity.accounts` for account selection and quota inspection.
- **Normalized usage reporting:** the provider registers `ProviderConfig.usage`, so Antigravity quota
  appears in OMP's native usage surfaces. Shared 5-hour, daily, and weekly pools are reported once
  instead of duplicated per model, while failed refreshes preserve the host's last-good report.
- **Regression coverage:** added Bun tests for endpoint retry policy, OAuth callback handling,
  multi-account isolation, message pairing, image saves, cache recovery, and terminal formatting.

### Changed

- **Readable account quota display:** account, project, plan, model family, remaining percentage,
  progress bar, and reset time now render on separate aligned lines, with clear active/inactive
  markers and compact account-switching help.
- **Unified provider transport:** userinfo and Antigravity API requests use the shared transport seam;
  the obsolete usage `postJson` forwarding wrapper and private keep-alive dispatcher were removed.
- **Thinking metadata:** models that already send `thinkingBudget: 0` when thinking is off now declare
  `suppressWhenOff`, matching Cloud Code Assist's server-side default behavior.

### Fixed

- **OAuth callback resilience:** malformed, prefetched, or state-mismatched callback requests return
  HTTP 400 without cancelling the active login; explicit OAuth errors still reject immediately.
  Manual callback prompts are cancellable, and loopback handling supports IPv4 and IPv6 safely.
- **Discovery cache recovery:** failed project discovery is no longer cached, and project, model,
  dynamic enum, diagnostics, and trajectory caches are bounded or scoped to prevent stale
  cross-account state and unbounded growth.
- **Streaming and message integrity:** preserve emoji surrogate pairs, pair tool results by
  `toolCallId`, hash trajectory seeds, classify backend failures correctly, and keep
  `disableReasoning` precedence consistent between runtime routing and generation config.
- **Image and diagnostics safety:** retry only eligible image endpoints, harden generated-image path
  validation, restrict debug dump permissions, and retain project-scoped diagnostics.
- **Tool argument typing:** narrow image-tool arguments at the documented OMP schema boundary instead
  of allowing `Static<TParams>` to collapse to `unknown`.

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
