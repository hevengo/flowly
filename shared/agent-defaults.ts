import { z } from "zod";

/** A provider + model (+ optional reasoning effort) a new session starts with (MODEL-DEFAULTS-SPEC). */
export const agentModelSchema = z.strictObject({
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  /** Reasoning option id of the model; absent keeps the model's own default. */
  thinking: z.string().min(1).max(100).optional(),
  /** Permission mode id of the provider; absent keeps the latest session's (same provider) or the provider default. */
  mode: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).optional(),
});
export type AgentModel = z.infer<typeof agentModelSchema>;

/** Where a model default comes from, strongest first: the project's, then the global one. */
export type AgentModelSource = "project" | "global";

type WithAgentModel = { agentModel?: AgentModel | null } | null | undefined;

/** The model new sessions in `project` start with: the project's own default wins over the global one; none means "follow the latest session". */
export function effectiveAgentModel(project: WithAgentModel, global: AgentModel | null | undefined): { model: AgentModel; source: AgentModelSource } | null {
  if (project?.agentModel) return { model: project.agentModel, source: "project" };
  if (global) return { model: global, source: "global" };
  return null;
}

type LastSession = { provider: string; model: string; mode: string; thinking?: string; speed?: string } | null | undefined;

/**
 * Starting point of the session form: the chosen default replaces provider,
 * model and reasoning of the latest session; the permission mode and the speed
 * (AGENT-SPEED-SPEC) are only kept when they belong to the same provider.
 */
export function startingAgent(last: LastSession, chosen: AgentModel | null | undefined) {
  if (!chosen) return last ?? null;
  const sameProvider = !!last && last.provider === chosen.provider;
  return {
    provider: chosen.provider,
    model: chosen.model,
    mode: chosen.mode ?? (sameProvider ? last.mode : ""),
    thinking: chosen.thinking ?? "",
    speed: sameProvider ? last.speed ?? "" : "",
  };
}

/** Flat host-setting values (`defaultProvider`/`defaultModel`/`defaultThinking`/`defaultMode`) as a model, or null while incomplete. */
export function agentModelFromValues(values: { defaultProvider?: string; defaultModel?: string; defaultThinking?: string; defaultMode?: string } | null | undefined): AgentModel | null {
  if (!values?.defaultProvider || !values.defaultModel) return null;
  return {
    provider: values.defaultProvider,
    model: values.defaultModel,
    ...(values.defaultThinking ? { thinking: values.defaultThinking } : {}),
    ...(values.defaultMode ? { mode: values.defaultMode } : {}),
  };
}
