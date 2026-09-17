/**
 * Type declarations for the compatibility surface OMP serves in place of the
 * real `@oh-my-pi/pi-ai` package root.
 *
 * ## Why this file exists
 *
 * When an extension imports the bare `@oh-my-pi/pi-ai` root, OMP substitutes
 * `legacy-pi-ai-shim` for the real package entrypoint. That shim re-exports the
 * genuine pi-ai barrel *plus* a set of symbols pi-ai used to expose from its own
 * root before the model catalog was split into `@oh-my-pi/pi-catalog` — among
 * them `calculateCost`, `getModel`/`getModels`, `Type`, `StringEnum`,
 * `clampThinkingLevel` and `isRetryableAssistantError`.
 *
 * The shim's `.d.ts` (`@oh-my-pi/pi-coding-agent`'s
 * `extensibility/legacy-pi-ai-shim.d.ts`) documents this as the sanctioned path
 * for extensions, but the *real* pi-ai declarations are what a normal
 * `import ... from "@oh-my-pi/pi-ai"` resolves to at type-check time. So the
 * runtime surface is a superset of the type surface, and any compat symbol an
 * extension actually uses needs its signature restated here.
 *
 * ## Scope
 *
 * Only restate symbols this plugin uses. Every declaration below mirrors the
 * shim's published signature exactly; if OMP ever promotes a symbol into the
 * real pi-ai barrel, the augmentation collapses into the real export and should
 * be deleted from this file.
 *
 * ## Never import a shim-only symbol by name
 *
 * A named import (`import { calculateCost } from "@oh-my-pi/pi-ai"`) links the
 * symbol at module load time. Outside OMP the real barrel does not export it, so
 * the whole module fails to load — this is why the test scripts run through Bun
 * and not OMP at all. Read shim-only symbols off the module namespace instead and
 * handle their absence, as `src/stream/stream.ts` does for `calculateCost`.
 * The shim itself re-exports them with `export { ... }`
 * (`extensibility/legacy-pi-ai-shim.ts`), so a namespace read yields the real
 * function under OMP.
 *
 * ## Do not import `@oh-my-pi/pi-catalog/*` from extension code
 *
 * `pi-catalog` is published and is a real dependency of `@oh-my-pi/pi-ai`, so it
 * resolves under a plain Bun/Node host — but inside the compiled `omp` binary it
 * is bundled and is *not* exposed to an extension's module graph, so importing it
 * (bare or subpath) makes the extension fail to load there. `calculateCost` and
 * friends genuinely live in `pi-catalog/models`; reach them through the shim's
 * bare-pi-ai surface instead.
 */

import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";

declare module "@oh-my-pi/pi-ai" {
  /**
   * Price `usage` against `model.cost`, writing the result into `usage.cost`
   * and returning the same object.
   *
   * Mutation is the documented behaviour (`calculateUsageCost` assigns each of
   * `input`/`output`/`cacheRead`/`cacheWrite`/`total` before returning), so
   * callers may ignore the return value.
   *
   * @param timestamp Unix milliseconds used to select time-based pricing tiers;
   *   ignored for the flat-rate cost tables this provider declares.
   */
  export function calculateCost<TApi extends Api>(
    model: Model<TApi>,
    usage: AssistantMessage["usage"],
    timestamp?: number,
  ): AssistantMessage["usage"]["cost"];

  /**
   * Classify whether a failed assistant turn looks like a transient provider or
   * transport error that is worth replaying.
   *
   * Account-level usage/quota limits are deliberately reported as **not**
   * retryable — they are owned by credential rotation, not by seconds-scale
   * backoff. Callers own budget, backoff, and reporting; this is a pure
   * predicate.
   *
   * This symbol has no equivalent in the real `@oh-my-pi/pi-ai` barrel, so it is
   * only resolvable while running under OMP's extension loader. Code that must
   * also run outside OMP has to resolve it defensively.
   */
  export function isRetryableAssistantError(message: AssistantMessage): boolean;
}
