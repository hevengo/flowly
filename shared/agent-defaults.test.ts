import { describe, expect, it } from "vitest";
import { agentModelFromValues, agentModelSchema, effectiveAgentModel, startingAgent, suggestedMode } from "./agent-defaults";

const claude = { provider: "claude", model: "claude-sonnet-5-5", thinking: "high" };
const codex = { provider: "codex", model: "gpt-6-luna" };

describe("effective model default", () => {
  it("prefers the project's default over the global one", () => {
    expect(effectiveAgentModel({ agentModel: claude }, codex)).toEqual({ model: claude, source: "project" });
  });
  it("falls back to the global default, then to nothing", () => {
    expect(effectiveAgentModel({}, codex)).toEqual({ model: codex, source: "global" });
    expect(effectiveAgentModel(null, codex)).toEqual({ model: codex, source: "global" });
    expect(effectiveAgentModel({ agentModel: undefined }, null)).toBeNull();
  });
});

describe("startingAgent", () => {
  const last = { provider: "claude", model: "claude-haiku-5-5", mode: "plan", thinking: "low" };
  it("keeps the latest session when no default is chosen", () => {
    expect(startingAgent(last, null)).toBe(last);
    expect(startingAgent(null, null)).toBeNull();
  });
  it("replaces provider, model and reasoning; keeps the mode only for the same provider", () => {
    expect(startingAgent(last, claude)).toEqual({ provider: "claude", model: "claude-sonnet-5-5", mode: "plan", thinking: "high", speed: "" });
    expect(startingAgent(last, codex)).toEqual({ provider: "codex", model: "gpt-6-luna", mode: "auto-review", thinking: "", speed: "fast" });
    expect(startingAgent(null, codex)).toEqual({ provider: "codex", model: "gpt-6-luna", mode: "auto-review", thinking: "", speed: "fast" });
  });
  it("keeps the latest session's speed only for the same provider", () => {
    expect(startingAgent({ ...last, speed: "fast" }, claude)?.speed).toBe("fast");
    expect(startingAgent({ ...last, speed: "fast" }, codex)?.speed).toBe("fast");
  });
  it("uses the default's own permission mode over the latest session's", () => {
    expect(startingAgent(last, { ...claude, mode: "acceptEdits" })?.mode).toBe("acceptEdits");
    expect(startingAgent(null, { ...codex, mode: "full-access" })?.mode).toBe("full-access");
  });
});

describe("stored values", () => {
  it("builds a model only when provider and model are both set", () => {
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "m", defaultThinking: "" })).toEqual({ provider: "claude", model: "m" });
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "m", defaultThinking: "high" })).toEqual({ provider: "claude", model: "m", thinking: "high" });
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "m", defaultMode: "plan" })).toEqual({ provider: "claude", model: "m", mode: "plan" });
    expect(agentModelFromValues({ defaultProvider: "claude", defaultModel: "" })).toBeNull();
    expect(agentModelFromValues({})).toBeNull();
    expect(agentModelFromValues(undefined)).toBeNull();
  });
  it("rejects incomplete or unknown fields in the project's model", () => {
    expect(agentModelSchema.safeParse({ provider: "claude" }).success).toBe(false);
    expect(agentModelSchema.safeParse({ provider: "claude", model: "m", extra: 1 }).success).toBe(false);
    expect(agentModelSchema.safeParse(claude).success).toBe(true);
  });
});

it("suggests automatic approval and preserves explicit permissions", () => {
 expect(suggestedMode("claude")).toBe("auto");
 expect(suggestedMode("codex")).toBe("auto-review");
 expect(suggestedMode("codex", "full-access")).toBe("full-access");
 expect(suggestedMode("claude", "plan")).toBe("plan");
 expect(suggestedMode("other")).toBe("");
});
