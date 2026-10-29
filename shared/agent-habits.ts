import { z } from "zod";
import { addDays, dayKey, projectInsightsSchema, type FlowEntry } from "./insights";
import { openNextMoves } from "./next-moves";
import { isDeliveryStatus, type BoardEvent } from "./model";

/**
 * Agent habits (WORKFLOW-INSIGHTS-SPEC §12): how often an agent's turns end with next
 * moves and ideas, by day, model and session, and how often the user takes a
 * suggestion. Pure rules over the flow log; no model call, no settings.
 */

export const HABIT_DAYS = 7;
/** Deliveries a model or session needs in the window before a rate of 0 is flagged. */
export const FLAG_MIN = 10;
/** A prompt this short only counts as picked when the message is the whole prompt. */
export const PICK_MIN_CONTAINS = 12;
/** Share of the prompt's character trigrams an edited message must still hold. */
export const PICK_COVERAGE = 0.8;

// ---- Views ------------------------------------------------------------------------

const count = z.number().int().min(0);
export const habitCountsSchema = z.object({
  /** Turns that moved the card to In review. */
  deliveries: count,
  /** Turns that reported a result and did not deliver. */
  results: count,
  /** Turns that asked a question and did neither. Kept out of the next-move rate. */
  questions: count,
  /** Deliveries and results that suggested next moves: the rate is `moves / (deliveries + results)`. */
  moves: count,
  /** Deliveries and results whose last call said there is nothing for the user to do (`moves: []`). */
  none: count,
  /** Every turn that suggested next moves, whatever it reported; for cross-checking event counts. */
  movesAny: count,
  /** `idea_proposed` events. */
  ideas: count,
  /** Suggestion sets whose outcome is known (answered by a message or by moving the card to Done). */
  offered: count,
  picked: count,
});
export type HabitCounts = z.infer<typeof habitCountsSchema>;

export const habitFlagSchema = z.object({
  kind: z.enum(["model", "session"]),
  /** What the group never did. */
  miss: z.enum(["moves", "ideas"]),
  /** `provider/model`; empty when unknown. */
  model: z.string(),
  /** The deliveries (ideas) or deliveries plus results (moves) it was judged on. */
  n: count,
  agentId: z.string().optional(),
  taskId: z.string().optional(),
});
export type HabitFlag = z.infer<typeof habitFlagSchema>;

export const habitsSchema = z.object({
  days: z.array(habitCountsSchema.extend({ day: z.string() })),
  total: habitCountsSchema,
  models: z.array(habitCountsSchema.extend({ model: z.string() })),
  flags: z.array(habitFlagSchema),
});
export type Habits = z.infer<typeof habitsSchema>;

/** `insights.project`'s answer: the project insights plus the habits. */
export const insightsWithHabitsSchema = projectInsightsSchema.extend({ habits: habitsSchema });
export type InsightsWithHabits = z.infer<typeof insightsWithHabitsSchema>;

export const emptyCounts = (): HabitCounts => ({ deliveries: 0, results: 0, questions: 0, moves: 0, none: 0, movesAny: 0, ideas: 0, offered: 0, picked: 0 });
export const baseOf = (c: Pick<HabitCounts, "deliveries" | "results">) => c.deliveries + c.results;

// ---- Picked -----------------------------------------------------------------------

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

function trigrams(text: string) {
  const out = new Set<string>();
  for (let i = 0; i + 3 <= text.length; i++) out.add(text.slice(i, i + 3));
  return out;
}

/** Share of the prompt's trigrams that the message still holds. */
function coverage(prompt: string, message: string) {
  const want = trigrams(prompt);
  if (!want.size) return 0;
  const have = trigrams(message);
  let hit = 0;
  for (const g of want) if (have.has(g)) hit++;
  return hit / want.size;
}

/**
 * Which suggestion the user's message took: its index, or -1. The message is the
 * prompt itself, the prompt after the user's own text (the composer appends a pick),
 * or the prompt with small edits. Action moves have no prompt and never match.
 */
export function matchPick(moves: readonly { label?: string; prompt?: string; moveTo?: string }[], texts: readonly string[]): number {
  const messages = texts.map(squash).filter(Boolean);
  let best = -1,
    bestScore = 0;
  moves.forEach((move, index) => {
    const prompt = move.prompt ? squash(move.prompt) : "";
    if (!prompt) return;
    for (const message of messages) {
      let score = 0;
      if (message === prompt) score = 1;
      else if (prompt.length >= PICK_MIN_CONTAINS) score = message.includes(prompt) ? 1 : coverage(prompt, message);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    }
  });
  return bestScore >= PICK_COVERAGE ? best : -1;
}

/**
 * The `pick` for the turn that just ended (§12.4): decided on the suggestions open when
 * that turn began, against the turn's user messages. Undefined when none was open or there
 * was no message to compare, so the share never counts a guess.
 */
export function turnPick(events: readonly BoardEvent[], agentId: string, userTexts: readonly string[]): number | undefined {
  let started = -1;
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i].agentId === agentId && events[i].action === "agent.turn_started") {
      started = i;
      break;
    }
  if (started < 0 || !userTexts.some((t) => t.trim())) return undefined;
  const open = openNextMoves(events.slice(0, started), agentId);
  return open ? matchPick(open.moves, userTexts) : undefined;
}

/** The text of a turn's user messages, from the timeline the `agent.turn_ended` hook receives. */
export function userTexts(items: readonly { type?: unknown; text?: unknown }[]): string[] {
  return items.flatMap((item) => (item.type === "user_message" && typeof item.text === "string" && item.text.trim() ? [item.text] : []));
}

/** Text the provider injects as a user message (background task notices, reminders, slash-command echoes); same filter as USAGE-STATS-SPEC §3. */
const injected = /^(<task-notification|<system-reminder|<command-|<local-command)/;
/**
 * Whether a turn began with a real user message (INSIGHTS-REDESIGN-SPEC §7.1): a non-empty
 * user_message that is not an injection. undefined when the timeline is missing.
 */
export function startedByUser(items: readonly { type?: unknown; text?: unknown }[] | null | undefined): boolean | undefined {
  if (!items) return undefined;
  return userTexts(items).some((text) => !injected.test(text.trim()));
}

/**
 * Flow entries written before the log kept `offered`/`offersDone` get them from the
 * board's events of the same id; entries the board no longer holds stay as they are (§12.4).
 */
export function withMoveDetails(entries: readonly FlowEntry[], events: readonly BoardEvent[]): FlowEntry[] {
  const needed = entries.some((e) => e.action === "next_moves_suggested" && e.offered === undefined);
  if (!needed) return [...entries];
  const moves = new Map<string, NonNullable<BoardEvent["moves"]>>();
  for (const e of events) if (e.action === "next_moves_suggested" && e.moves) moves.set(e.id, e.moves);
  return entries.map((e) => {
    const list = e.action === "next_moves_suggested" && e.offered === undefined ? moves.get(e.id) : undefined;
    return list ? { ...e, offered: list.length, ...(list.some((m) => m.moveTo === "done") ? { offersDone: true } : {}) } : e;
  });
}

// ---- Turns ------------------------------------------------------------------------

type Turn = {
  agentId: string;
  taskId: string;
  /** The turn's last event: its day. */
  at: number;
  ended: boolean;
  model: string;
  pick: number | undefined;
  delivery: boolean;
  result: boolean;
  question: boolean;
  /** The turn's last next-moves call suggested something / said none. */
  moves: boolean;
  none: boolean;
  offersDone: boolean;
  ideas: number;
  /** The turn the user's reply started, when this turn's suggestions were answered. */
  reply: Turn | null;
  /** True when the card was moved to Done while a Move to Done suggestion was open. */
  doneMove: boolean;
};

/** Whether this turn's suggestions were taken: null when there were none or the outcome is unknown. */
function picked(turn: Turn): boolean | null {
  if (!turn.moves) return null;
  if (turn.doneMove) return true;
  return turn.reply && turn.reply.pick !== undefined ? turn.reply.pick >= 0 : null;
}

/**
 * Entries → turns (§12.3): a session's events belong to its latest turn, from one
 * `agent.turn_started` to the next; events with no turn before them make one of their own.
 */
function turnsOf(entries: readonly FlowEntry[]): Turn[] {
  const sorted = entries.map((e) => ({ e, t: Date.parse(e.at) })).filter((x) => Number.isFinite(x.t));
  sorted.sort((a, b) => a.t - b.t);
  const turns: Turn[] = [];
  const current = new Map<string, Turn>();
  /** Per session, the latest turn whose suggestions nobody has answered yet. */
  const waiting = new Map<string, Turn>();
  const begin = (agentId: string, taskId: string, at: number) => {
    const turn: Turn = { agentId, taskId, at, ended: false, model: "", pick: undefined, delivery: false, result: false, question: false, moves: false, none: false, offersDone: false, ideas: 0, reply: null, doneMove: false };
    turns.push(turn);
    current.set(agentId, turn);
    return turn;
  };
  for (const { e, t } of sorted) {
    if (!e.agentId) {
      // A person moving the card to Done takes up an open Move to Done suggestion.
      if (e.actor === "human" && e.action === "status_changed" && e.to === "done")
        for (const [agentId, turn] of waiting)
          if (turn.taskId === e.taskId) {
            if (turn.offersDone) turn.doneMove = true;
            waiting.delete(agentId);
          }
      continue;
    }
    if (e.action === "agent.turn_started") {
      const before = waiting.get(e.agentId);
      const turn = begin(e.agentId, e.taskId, t);
      if (before) {
        before.reply = turn;
        waiting.delete(e.agentId);
      }
      continue;
    }
    if (e.action === "agent.turn_ended") {
      let turn = current.get(e.agentId);
      if (!turn || turn.ended) turn = begin(e.agentId, e.taskId, t);
      turn.ended = true;
      turn.at = Math.max(turn.at, t);
      if (e.model) turn.model = e.model;
      if (e.pick !== undefined) turn.pick = e.pick;
      continue;
    }
    if (e.actor !== "agent") continue;
    const turn = current.get(e.agentId) ?? begin(e.agentId, e.taskId, t);
    turn.at = Math.max(turn.at, t);
    if (e.action === "next_moves_suggested") {
      // The latest call of the turn replaces the earlier ones; an empty list is an explicit "none".
      turn.none = e.offered === 0;
      turn.moves = !turn.none;
      turn.offersDone = turn.moves && !!e.offersDone;
      waiting.set(e.agentId, turn);
    } else if (e.action === "idea_proposed") turn.ideas++;
    else if (e.action === "status_changed" && isDeliveryStatus(e.to)) turn.delivery = true;
    if (e.reportKind === "result") turn.result = true;
    else if (e.reportKind === "question") turn.question = true;
  }
  return turns;
}

function add(into: HabitCounts, turn: Turn) {
  if (turn.delivery) into.deliveries++;
  else if (turn.result) into.results++;
  else if (turn.question) into.questions++;
  const base = turn.delivery || turn.result;
  if (turn.moves) {
    into.movesAny++;
    if (base) into.moves++;
  }
  if (turn.none && base) into.none++;
  into.ideas += turn.ideas;
  const took = picked(turn);
  if (took !== null) {
    into.offered++;
    if (took) into.picked++;
  }
}

const used = (c: HabitCounts) => c.deliveries + c.results + c.questions + c.movesAny + c.ideas > 0;

type Window = { day: string; tz?: string; days?: number };
function windowOf(input: Window) {
  const n = input.days ?? HABIT_DAYS;
  return Array.from({ length: n }, (_, i) => addDays(input.day, i - n + 1));
}

export type HabitInput = Window & {
  /** The model of a session whose turns carry none (turns before the stamp existed). */
  modelOf?: (agentId: string) => string | undefined;
};

/** Sessions with turns in the window that have no stamped model, so the caller can look them up (§12.5). */
export function modellessAgents(entries: readonly FlowEntry[], input: Window): Set<string> {
  const days = windowOf(input);
  const out = new Set<string>();
  for (const turn of turnsOf(entries)) {
    const day = dayKey(turn.at, input.tz);
    if (!turn.model && day >= days[0] && day <= days[days.length - 1]) out.add(turn.agentId);
  }
  return out;
}

export function habits(entries: readonly FlowEntry[], input: HabitInput): Habits {
  const days = windowOf(input);
  const byDay = new Map(days.map((day) => [day, emptyCounts()]));
  const total = emptyCounts();
  const byModel = new Map<string, HabitCounts>();
  const bySession = new Map<string, { taskId: string; model: string; at: number; counts: HabitCounts }>();
  for (const turn of turnsOf(entries)) {
    const counts = byDay.get(dayKey(turn.at, input.tz));
    if (!counts) continue;
    const model = turn.model || input.modelOf?.(turn.agentId) || "";
    add(counts, turn);
    add(total, turn);
    let m = byModel.get(model);
    if (!m) byModel.set(model, (m = emptyCounts()));
    add(m, turn);
    let s = bySession.get(turn.agentId);
    if (!s) bySession.set(turn.agentId, (s = { taskId: turn.taskId, model, at: turn.at, counts: emptyCounts() }));
    if (turn.at >= s.at) {
      s.at = turn.at;
      s.model = model;
    }
    add(s.counts, turn);
  }
  const models = [...byModel]
    .filter(([, c]) => used(c))
    .map(([model, c]) => ({ model, ...c }))
    .sort((a, b) => baseOf(b) - baseOf(a) || a.model.localeCompare(b.model));
  const flagsOf = (kind: HabitFlag["kind"], model: string, c: HabitCounts, who: { agentId?: string; taskId?: string }): HabitFlag[] => [
    ...(baseOf(c) >= FLAG_MIN && c.moves === 0 && c.none === 0 ? [{ kind, miss: "moves" as const, model, n: baseOf(c), ...who }] : []),
    ...(c.deliveries >= FLAG_MIN && c.ideas === 0 ? [{ kind, miss: "ideas" as const, model, n: c.deliveries, ...who }] : []),
  ];
  const sessions = [...bySession]
    .map(([agentId, s]) => ({ agentId, ...s }))
    .sort((a, b) => baseOf(b.counts) - baseOf(a.counts) || a.agentId.localeCompare(b.agentId));
  return {
    days: days.map((day) => ({ day, ...byDay.get(day)! })),
    total,
    models,
    flags: [
      ...models.flatMap((m) => flagsOf("model", m.model, m, {})),
      ...sessions.flatMap((s) => flagsOf("session", s.model, s.counts, { agentId: s.agentId, taskId: s.taskId })),
    ],
  };
}
