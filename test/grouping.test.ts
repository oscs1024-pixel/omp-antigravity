import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAntigravityCatalog,
  parseThinkingSuffix,
  routingFromVariants,
  type AntigravityCatalog,
} from "../src/models/grouping.js";
import { ThinkingEffort } from "../src/types/enums.js";

describe("parseThinkingSuffix", () => {
  it("correctly parses low suffix", () => {
    const result = parseThinkingSuffix("gemini-3.9-flash-low");
    assert.deepEqual(result, {
      baseId: "gemini-3.9-flash",
      level: ThinkingEffort.Low,
    });
  });

  it("correctly parses extra-low suffix without leaving 'extra' in baseId", () => {
    const result = parseThinkingSuffix("gemini-3.9-flash-extra-low");
    assert.deepEqual(result, {
      baseId: "gemini-3.9-flash",
      level: ThinkingEffort.Low,
    });
  });

  it("correctly parses extra-high suffix without leaving 'extra' in baseId", () => {
    const result = parseThinkingSuffix("gemini-3.9-flash-extra-high");
    assert.deepEqual(result, {
      baseId: "gemini-3.9-flash",
      level: ThinkingEffort.Xhigh,
    });
  });

  it("correctly parses minimal, medium, high, and thinking suffixes", () => {
    assert.deepEqual(parseThinkingSuffix("gemini-3.9-flash-minimal"), {
      baseId: "gemini-3.9-flash",
      level: ThinkingEffort.Minimal,
    });
    assert.deepEqual(parseThinkingSuffix("gemini-3.9-flash-medium"), {
      baseId: "gemini-3.9-flash",
      level: ThinkingEffort.Medium,
    });
    assert.deepEqual(parseThinkingSuffix("gemini-3.9-flash-high"), {
      baseId: "gemini-3.9-flash",
      level: ThinkingEffort.High,
    });
    assert.deepEqual(parseThinkingSuffix("gemini-3.9-flash-thinking"), {
      baseId: "gemini-3.9-flash",
      level: ThinkingEffort.High,
    });
  });

  it("returns undefined for unsuffixed model IDs", () => {
    assert.equal(parseThinkingSuffix("gemini-3.8-flash"), undefined);
    assert.equal(parseThinkingSuffix("claude-sonnet-4-6"), undefined);
    assert.equal(parseThinkingSuffix("gpt-oss-120b"), undefined);
  });
});

describe("routingFromVariants", () => {
  it("routes exactly to requested variant when all variants are present", () => {
    const variants = {
      [ThinkingEffort.Minimal]: "gemini-3.9-flash-minimal",
      [ThinkingEffort.Low]: "gemini-3.9-flash-low",
      [ThinkingEffort.Medium]: "gemini-3.9-flash-medium",
      [ThinkingEffort.High]: "gemini-3.9-flash-high",
      [ThinkingEffort.Xhigh]: "gemini-3.9-flash-extra-high",
    };
    const routing = routingFromVariants("gemini-3.9-flash", variants);
    assert.equal(routing.routing?.minimal, "gemini-3.9-flash-minimal");
    assert.equal(routing.routing?.low, "gemini-3.9-flash-low");
    assert.equal(routing.routing?.medium, "gemini-3.9-flash-medium");
    assert.equal(routing.routing?.high, "gemini-3.9-flash-high");
    assert.equal(routing.routing?.xhigh, "gemini-3.9-flash-extra-high");
    assert.equal(routing.off, "gemini-3.9-flash-low");
  });

  it("prioritizes downward cost-saving when variants are missing", () => {
    // Missing minimal -> falls back to low
    const noMinimal = {
      [ThinkingEffort.Low]: "gemini-3.9-flash-low",
      [ThinkingEffort.Medium]: "gemini-3.9-flash-medium",
      [ThinkingEffort.High]: "gemini-3.9-flash-high",
    };
    const r1 = routingFromVariants("gemini-3.9-flash", noMinimal);
    assert.equal(r1.routing?.minimal, "gemini-3.9-flash-low");

    // Missing low -> falls back downward to minimal first
    const noLow = {
      [ThinkingEffort.Minimal]: "gemini-3.9-flash-minimal",
      [ThinkingEffort.Medium]: "gemini-3.9-flash-medium",
      [ThinkingEffort.High]: "gemini-3.9-flash-high",
    };
    const r2 = routingFromVariants("gemini-3.9-flash", noLow);
    assert.equal(r2.routing?.low, "gemini-3.9-flash-minimal");

    // Missing medium -> falls back downward to low first (not jumping to high)
    const noMed = {
      [ThinkingEffort.Minimal]: "gemini-3.9-flash-minimal",
      [ThinkingEffort.Low]: "gemini-3.9-flash-low",
      [ThinkingEffort.High]: "gemini-3.9-flash-high",
    };
    const r3 = routingFromVariants("gemini-3.9-flash", noMed);
    assert.equal(r3.routing?.medium, "gemini-3.9-flash-low");

    // Missing high -> falls back downward to medium
    const noHigh = {
      [ThinkingEffort.Low]: "gemini-3.9-flash-low",
      [ThinkingEffort.Medium]: "gemini-3.9-flash-medium",
    };
    const r4 = routingFromVariants("gemini-3.9-flash", noHigh);
    assert.equal(r4.routing?.high, "gemini-3.9-flash-medium");
  });

  it("demonstrates availability-first upward fallback when only high variant exists", () => {
    // In Antigravity, some models only exist as High/Agent variants (e.g. gemini-3.1-pro)
    const onlyHigh = {
      [ThinkingEffort.High]: "gemini-3.1-pro-high",
    };
    const routing = routingFromVariants("gemini-3.1-pro", onlyHigh);
    assert.equal(routing.routing?.minimal, "gemini-3.1-pro-high");
    assert.equal(routing.routing?.low, "gemini-3.1-pro-high");
    assert.equal(routing.routing?.medium, "gemini-3.1-pro-high");
    assert.equal(routing.routing?.high, "gemini-3.1-pro-high");
    assert.equal(routing.off, "gemini-3.1-pro-high");
  });
});

describe("buildAntigravityCatalog", () => {
  const fallback: AntigravityCatalog = {
    models: [
      {
        id: "gemini-3.1-pro",
        name: "Gemini 3.1 Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 65536,
      },
    ],
    routing: {},
  };

  it("groups multi-tier models into one public model with thinking configuration", () => {
    const raw = {
      "gemini-3.9-flash-low": { displayName: "Gemini 3.9 Flash (Low)" },
      "gemini-3.9-flash-medium": { displayName: "Gemini 3.9 Flash (Medium)" },
      "gemini-3.9-flash-high": { displayName: "Gemini 3.9 Flash (High)" },
    };

    const catalog = buildAntigravityCatalog(raw, fallback);
    const flashModel = catalog.models.find((m) => m.id === "gemini-3.9-flash");
    assert.ok(flashModel, "gemini-3.9-flash should be grouped into a single model");
    assert.equal(flashModel.reasoning, true);
    assert.deepEqual(flashModel.thinking?.efforts, ["low", "medium", "high"]);

    const routing = catalog.routing["gemini-3.9-flash"];
    assert.ok(routing);
    assert.equal(routing.routing?.low, "gemini-3.9-flash-low");
    assert.equal(routing.routing?.medium, "gemini-3.9-flash-medium");
    assert.equal(routing.routing?.high, "gemini-3.9-flash-high");
  });

  it("merges agent singletons into their canonical parent family", () => {
    const raw = {
      "gemini-pro-agent": { displayName: "Gemini 3.1 Pro (High)" },
    };

    const catalog = buildAntigravityCatalog(raw, fallback);
    const proModel = catalog.models.find((m) => m.id === "gemini-3.1-pro");
    assert.ok(proModel, "gemini-3.1-pro should absorb gemini-pro-agent");
    assert.equal(
      catalog.models.find((m) => m.id === "gemini-pro-agent"),
      undefined,
    );

    const routing = catalog.routing["gemini-3.1-pro"];
    assert.ok(routing);
    assert.equal(routing.routing?.high, "gemini-pro-agent");
    assert.equal(routing.routing?.low, "gemini-pro-agent"); // Availability fallback
  });

  it("filters out denylisted and internal models", () => {
    const raw = {
      chat_20706: { displayName: "Internal Chat 20706" },
      chat_23310: { displayName: "Internal Chat 23310" },
      "gemini-2.5-pro": { displayName: "Gemini 2.5 Pro" },
      "internal-model": { displayName: "Internal", isInternal: true },
      "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash" },
    };

    const catalog = buildAntigravityCatalog(raw, fallback);
    assert.equal(
      catalog.models.find((m) => m.id === "chat_20706"),
      undefined,
    );
    assert.equal(
      catalog.models.find((m) => m.id === "chat_23310"),
      undefined,
    );
    assert.equal(
      catalog.models.find((m) => m.id === "gemini-2.5-pro"),
      undefined,
    );
    assert.equal(
      catalog.models.find((m) => m.id === "internal-model"),
      undefined,
    );
    assert.ok(catalog.models.find((m) => m.id === "gemini-3.8-flash"));
  });
});
