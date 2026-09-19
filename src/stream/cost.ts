import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as piAiRuntime from "@oh-my-pi/pi-ai";

type UsageCost = AssistantMessage["usage"]["cost"];
type HostCalculateCost = (
  model: Model<Api>,
  usage: AssistantMessage["usage"],
  timestamp?: number,
) => UsageCost;

/**
 * Host cost helper, when one is reachable.
 *
 * `@oh-my-pi/pi-ai` does not export `calculateCost` itself: inside OMP this
 * module specifier is rewritten to the host's legacy pi-ai shim, which does
 * (`pi-coding-agent/src/extensibility/legacy-pi-ai-shim.ts`). When the plugin is
 * loaded standalone — the scripts under `scripts/` — the lookup is `undefined`
 * and {@link calculateFlatRateCost} prices the turn with the same arithmetic.
 */
const hostCalculateCost: HostCalculateCost | undefined = piAiRuntime.calculateCost;

export function calculateFlatRateCost(
  model: Model<Api>,
  usage: AssistantMessage["usage"],
): UsageCost {
  const rates = model.cost;
  usage.cost.input = (rates.input / 1_000_000) * usage.input;
  usage.cost.output = (rates.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (rates.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

/** Price one streamed turn, preferring OMP's helper when the host provides it. */
export function applyUsageCost(model: Model<Api>, usage: AssistantMessage["usage"]): void {
  if (hostCalculateCost) hostCalculateCost(model, usage);
  else calculateFlatRateCost(model, usage);
}
