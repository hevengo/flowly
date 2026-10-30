import { describe, expect, it } from "vitest";
import { suggestedSpeed, sessionSpeed, speedFeature, speedFeatureValues } from "./agent-speed";

// Shapes as the Paseo daemon builds them (Codex `buildCodexSpeedFeature`, Claude `CLAUDE_FAST_MODE_FEATURE`).
const codexSpeed = (value: string | null = "default") => ({
  type: "select",
  id: "service_tier",
  label: "Speed",
  description: "Choose processing speed. Faster tiers increase usage.",
  value,
  options: [
    { id: "default", label: "Normal", isDefault: true },
    { id: "fast", label: "Fast" },
  ],
});
const codexPlan = { type: "toggle", id: "plan_mode", label: "Plan", value: false };
const claudeFast = (value = false) => ({
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  value,
});

describe("speedFeature", () => {
  it("reads Codex's service tier: normal speed by its own name, faster tiers with the cost note", () => {
    expect(speedFeature([codexSpeed(), codexPlan])).toEqual({
      featureId: "service_tier",
      kind: "select",
      normalLabel: "Normal",
      options: [{ id: "fast", label: "Fast", description: "Choose processing speed. Faster tiers increase usage." }],
    });
  });
  it("reads Claude's fast mode toggle as one faster option", () => {
    expect(speedFeature([claudeFast()])).toEqual({
      featureId: "fast_mode",
      kind: "toggle",
      options: [{ id: "fast", label: "Fast", description: "Lower latency Opus responses at higher token cost" }],
    });
  });
  it("offers nothing for other features, no features or a tier list without a faster tier", () => {
    expect(speedFeature([codexPlan])).toBeNull();
    expect(speedFeature([])).toBeNull();
    expect(speedFeature(undefined)).toBeNull();
    expect(speedFeature([{ ...codexSpeed(), options: [{ id: "default", label: "Normal", isDefault: true }] }])).toBeNull();
  });
});

describe("speedFeatureValues", () => {
  it("sends the tier id for a select and true for the toggle", () => {
    expect(speedFeatureValues(speedFeature([codexSpeed()]), "fast")).toEqual({ service_tier: "fast" });
    expect(speedFeatureValues(speedFeature([claudeFast()]), "fast")).toEqual({ fast_mode: true });
  });
  it("sends nothing for normal speed, an option the model lacks, or no speed feature", () => {
    expect(speedFeatureValues(speedFeature([codexSpeed()]), "")).toBeUndefined();
    expect(speedFeatureValues(speedFeature([codexSpeed()]), "flex")).toBeUndefined();
    expect(speedFeatureValues(null, "fast")).toBeUndefined();
  });
});

describe("sessionSpeed", () => {
  it("reads the speed a session runs at", () => {
    expect(sessionSpeed([codexSpeed("fast"), codexPlan])).toBe("fast");
    expect(sessionSpeed([codexSpeed("default")])).toBe("");
    expect(sessionSpeed([codexSpeed(null)])).toBe("");
    expect(sessionSpeed([claudeFast(true)])).toBe("fast");
    expect(sessionSpeed([claudeFast(false)])).toBe("");
    expect(sessionSpeed(null)).toBe("");
  });

  it("names a session's tier among several faster ones (composer Speed chip)", () => {
    const tiers = {
      ...codexSpeed("ultrafast"),
      options: [...codexSpeed().options, { id: "ultrafast", label: "Ultrafast" }],
    };
    const choice = speedFeature([tiers, codexPlan]);
    expect(choice?.options.map((o) => o.label)).toEqual(["Fast", "Ultrafast"]);
    expect(choice?.options.find((o) => o.id === sessionSpeed([tiers]))?.label).toBe("Ultrafast");
  });
});

it("defaults Codex to fast while preserving explicit normal and other tiers", () => {
  expect(suggestedSpeed("codex")).toBe("fast");
  expect(suggestedSpeed("codex", "")).toBe("");
  expect(suggestedSpeed("codex", "flex")).toBe("flex");
  expect(suggestedSpeed("claude")).toBe("");
});

it("suggests Codex's Fast tier by the id the daemon offers", () => {
  // Paseo's Codex service tiers: default (Normal), priority (Fast), ultrafast (Ultrafast).
  const live = [{ id: "priority" }, { id: "ultrafast" }];
  expect(suggestedSpeed("codex", undefined, live)).toBe("priority");
  expect(suggestedSpeed("codex", undefined, [{ id: "fast" }])).toBe("fast");
  expect(suggestedSpeed("codex", "", live)).toBe("");
  expect(suggestedSpeed("claude", undefined, [{ id: "fast" }])).toBe("");
});
