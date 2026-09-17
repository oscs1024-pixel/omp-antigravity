# Dynamic Antigravity model discovery

How this plugin keeps its selectable model list in sync with the Antigravity backend instead of
shipping a new release for every newly enabled model.

## Goal

Make the Antigravity backend catalog the source of truth for the provider's selectable models, so a
newly launched model can appear in OMP without a plugin release.

## How it works

1. OMP calls the provider's `fetchDynamicModels(apiKey)` hook — from the model registry at startup
   and from `/antigravity.refresh` (`ctx.modelRegistry.refreshProvider(id, "online")`).
2. `discoverAntigravityModels` resolves credentials to `{token, projectId}`. OMP hands over either the
   structured JSON produced by `getApiKey`, or the bare access token that `AuthStorage` exposes, so
   the bare-token case resolves the project id via `loadCodeAssist` first.
3. `POST /v1internal:fetchAvailableModels` is queried across every endpoint candidate and the payloads
   are merged, so daily/sandbox-only models appear alongside production entries.
4. `buildAntigravityCatalog` (`src/models/grouping.ts`) normalizes runtime ids into public model ids:
   it strips known thinking suffixes (`-low`, `-medium`, `-high`, `-extra-low`, `-thinking`, …),
   applies explicit aliases where a runtime id does not share its family's suffix
   (`gemini-pro-agent` → `gemini-3.1-pro` high), merges `*-agent` singletons into their family, and
   reads back the advertised thinking levels.
5. `applyAntigravityCatalog` swaps the live catalog in, and `fetchDynamicModels` returns its models to
   OMP.
6. Models present in the conservative static table but missing from an account's live catalog stay
   selectable, which is what keeps a free-tier account working.

### Effort Routing Fallback: Availability over Cost

When constructing model routing tables from discovered variants, Antigravity uses an **Availability-First** fallback hierarchy:

- **Downward cost-conscious fallback**: Higher tiers degrade downward (`high` -> `medium` -> `low` -> `minimal`, and `medium` -> `low` -> `minimal` -> `high`).
- **Upward availability tail**: Lower tiers (`minimal`, `low`) check downward/adjacent tiers first (`low` -> `minimal`), but if neither exists on the backend (e.g. a model family like `gemini-3.1-pro` only deployed with High thinking / agent runtime), routing degrades upward (`medium` -> `high`).
- **Rationale**: In Google Antigravity, some architectures are only deployed at higher reasoning tiers. Refusing upward fallback would render the model completely unusable (404 / route error) unless the user manually selected High effort. Preserving model availability is prioritized when cheaper tiers are absent from Google's backend.

## Acceptance criteria

- **Required:** a fixture containing a previously unknown `gemini-3.9-flash-low|medium|high` family
  yields one selectable `gemini-3.9-flash` with Low/Medium/High reasoning levels, produced by
  grouping rather than a static catalog entry.
- **Required:** a single unknown unsuffixed Gemini/Claude/GPT-OSS runtime stays selectable
  conservatively, and an explicit `supportsThinking: false` does not grow fake reasoning controls.
- **Required:** existing Claude, GPT-OSS, and Gemini 3.1/3.5 aliases and routing keep working, and the
  Gemini rollout remaps are unchanged.
- **Required:** discovery returning nothing does not erase the conservative static catalog.
- **Required:** OAuth, streaming, usage, diagnostics, image generation, and runtime overrides are
  unaffected. `bun run check` passes.
- **Conditional live validation:** when an account's `fetchAvailableModels` payload advertises a newly
  available family, it appears after a refresh without editing the static list. Accounts whose tier
  omits that family are not a failure of discovery.

## Constraints

- No `agy` (Antigravity CLI) shell-out and no second agent loop — OMP remains the only harness.
- Discovery does not change the OAuth flow.
- No new silent cross-generation fallback for discovered models; the existing Gemini rollout remaps
  stay as they are.
- An unauthenticated or empty result throws rather than returning `[]`, so OMP retries in minutes
  instead of caching an empty catalog for its default TTL.

## Where the pieces live

- `src/client/client.ts` — authenticated endpoint access, project resolution, runtime-model lookup.
- `src/models/discovery.ts` — fetch + normalize + group the live catalog.
- `src/models/grouping.ts` — runtime-id → public-model grouping, diffs, and ordering.
- `src/models/models.ts` — conservative static seed, routing tables, and the live catalog slot.
- `src/index.ts` — registers the provider and the `/antigravity.refresh` command.
