import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as piAiRuntime from "@oh-my-pi/pi-ai";

type UsageCost = AssistantMessage["usage"]["cost"];
type HostCalculateCost = (
  model: Model<Api>,
  usage: AssistantMessage["usage"],
  timestamp?: number,
) => UsageCost;

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
