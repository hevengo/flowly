import { z } from "zod";
import { isDeliveryStatus, isWorkStatus } from "./model";
import { addDays, dayStart, type FlowEntry, type TaskHistory } from "./insights";
import { activitySchema } from "./activity";
import { habitsSchema } from "./agent-habits";
import { TOKEN_SLOT_MS, addUsage, totalTokens, zeroUsage, type TokenUsage } from "./usage";

/**
 * Workflow numbers for the folded Workflow section (INSIGHTS-REDESIGN-SPEC §2.5): review
 * rounds and one-pass share of the cards finished in the last 7 days, by model, and
 * tokens per card. Pure: the daemon passes the replayed histories.
 */

export const WINDOW_DAYS = 7;
/** Below this many finished cards the summary says so; a model row merges into "other". */
export const MIN_CARDS = 3;

const ms = (iso: string) => Date.parse(iso);

/** One finished card, counted from its creation to its first Done. */
export type CardStat = {
  taskId: string;
  createdAt: number;
  /** First entry into a work lane (creation when it never had one). */
  start: number;
  finishedAt: number;
  turns: number;
  rounds: number;
  model: string;
};

// ---- Per card --------------------------------------------------------------------

/** Leaving In review for a work lane or Todo: a message that resumed the card, or a drag back (second version §3.2). Committed and Integrated are steps forward (COMMITTED-STAGE-SPEC §5, INTEGRATED-STAGE-SPEC §5). */
const isRound = (e: FlowEntry) =>
  e.action === "status_changed" && e.from === "in_review" && !!e.to && e.to !== "done" && e.to !== "cancelled" && !isDeliveryStatus(e.to);

export function cardStats(input: {
  histories: readonly TaskHistory[];
  /** A session's current model for turns that carry none (WORKFLOW-INSIGHTS-SPEC §12.5). */
  modelOf?(agentId: string): string | undefined;
}): CardStat[] {
  const out: CardStat[] = [];
  for (const h of input.histories) {
    if (h.incomplete) continue;
    const doneEntry = h.entries.find((e) => e.action === "status_changed" && e.to === "done");
    if (!doneEntry) continue;
    const createdAt = ms(h.task.createdAt);
    const finishedAt = ms(doneEntry.at);
    const life = h.entries.filter((e) => ms(e.at) <= finishedAt);
    const firstWork = h.intervals.find((iv) => isWorkStatus(iv.status) && iv.start < finishedAt);
    const start = Math.min(finishedAt, firstWork ? firstWork.start : createdAt);
    const ended = life.filter((e) => e.action === "agent.turn_ended");
    // Model: the one most turns ran on.
    const counts = new Map<string, number>();
    for (const e of ended) {
      const model = e.model || (e.agentId ? input.modelOf?.(e.agentId) : undefined) || "";
      if (model) counts.set(model, (counts.get(model) || 0) + 1);
    }
    const model = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? "";
    out.push({ taskId: h.task.id, createdAt, start, finishedAt, turns: ended.length, rounds: life.filter(isRound).length, model });
  }
  return out;
}

// ---- Aggregates ------------------------------------------------------------------

/** Nearest-rank quantile; the median averages the middle pair. */
export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  if (q === 0.5) {
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}
const median = (values: readonly number[]) => quantile(values, 0.5);

const num = z.number();
const nullable = num.nullable();
const groupSchema = z.object({
  finished: z.number().int(),
  rounds: nullable,
  onePassShare: nullable,
});
export type Group = z.infer<typeof groupSchema>;

export function group(cards: readonly CardStat[]): Group {
  return {
    finished: cards.length,
    rounds: median(cards.map((c) => c.rounds)),
    onePassShare: cards.length ? cards.filter((c) => c.rounds === 0).length / cards.length : null,
  };
}

/** The folded Workflow section (INSIGHTS-REDESIGN-SPEC §2.5): the last 7 days, by model. */
export const workflowStatsSchema = groupSchema.extend({
  window: z.object({ from: z.string(), to: z.string() }),
  models: z.array(groupSchema.extend({ model: z.string() })),
  /** The window's cards, so the token reader can sum each card's active span. */
  cards: z.array(z.object({ taskId: z.string(), start: z.number(), finishedAt: z.number() })),
});
export type WorkflowStats = z.infer<typeof workflowStatsSchema>;

export function workflowStats(input: { cards: readonly CardStat[]; today: string; tz: string | undefined; now: number }): WorkflowStats {
  const from = addDays(input.today, 1 - WINDOW_DAYS);
  const start = dayStart(from, input.tz);
  const windowCards = input.cards.filter((c) => c.finishedAt >= start && c.finishedAt <= input.now);
  const byModel = new Map<string, CardStat[]>();
  for (const c of windowCards) {
    const list = byModel.get(c.model);
    if (list) list.push(c);
    else byModel.set(c.model, [c]);
  }
  const other: CardStat[] = [];
  const models: WorkflowStats["models"] = [];
  for (const [model, list] of byModel) {
    if (!model || list.length < MIN_CARDS) other.push(...list);
    else models.push({ model, ...group(list) });
  }
  models.sort((a, b) => b.finished - a.finished || a.model.localeCompare(b.model));
  if (other.length && models.length) models.push({ model: "", ...group(other) });
  return {
    window: { from, to: input.today },
    ...group(windowCards),
    models,
    cards: windowCards.map((c) => ({ taskId: c.taskId, start: c.start, finishedAt: c.finishedAt })),
  };
}

// ---- Tokens per finished card (§2.5) ---------------------------------------------

export const cardTokensSchema = z.object({
  /** Median tokens per card finished in the window. */
  perCard: nullable,
  models: z.array(z.object({ model: z.string(), perCard: nullable })),
  /** Sessions read, and sessions without a local Claude Code / Codex log. */
  sessions: z.number().int(),
  missing: z.number().int(),
});
export type CardTokens = z.infer<typeof cardTokensSchema>;

/** Sums each finished card's tokens over its active span (first work lane → first Done). */
export function cardTokens(input: {
  series: readonly { taskId: string; buckets: ReadonlyMap<number, TokenUsage> | null }[];
  cards: WorkflowStats["cards"];
  /** Card → model, for the model rows (the same attribution as the stats). */
  modelOf(taskId: string): string;
  models: readonly string[];
}): CardTokens {
  const named = input.models.filter(Boolean);
  const per = new Map<string, number>();
  for (const card of input.cards) {
    const a = Math.floor(card.start / TOKEN_SLOT_MS),
      b = Math.floor(card.finishedAt / TOKEN_SLOT_MS);
    let sum = zeroUsage();
    for (const s of input.series) {
      if (s.taskId !== card.taskId || !s.buckets) continue;
      for (const [slot, usage] of s.buckets) if (slot >= a && slot <= b) sum = addUsage(sum, usage);
    }
    per.set(card.taskId, totalTokens(sum));
  }
  const totals = (list: readonly { taskId: string }[]) => list.map((c) => per.get(c.taskId)!).filter((n) => n > 0);
  return {
    perCard: median(totals(input.cards)),
    // "" is the merged "other" row: every card whose model has no row of its own.
    models: input.models.map((model) => ({
      model,
      perCard: median(totals(input.cards.filter((c) => (model ? input.modelOf(c.taskId) === model : !named.includes(input.modelOf(c.taskId)))))),
    })),
    sessions: input.series.length,
    missing: input.series.filter((s) => !s.buckets).length,
  };
}

/** `insights.project` value (INSIGHTS-REDESIGN-SPEC §7). Habits only with the developer switch on (§6). */
export const insightsViewSchema = z.object({
  today: z.string(),
  activity: activitySchema,
  workflow: workflowStatsSchema,
  habits: habitsSchema.optional(),
});
export type InsightsView = z.infer<typeof insightsViewSchema>;
