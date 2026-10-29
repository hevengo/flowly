import { describe, expect, it } from "vitest";
import { prepare, type AnalyzeInput, type FlowEntry } from "./insights";
import type { Task } from "./model";
import { cardStats, cardTokens, group, workflowStats, type CardStat } from "./workflow-stats";

const H = 3_600_000;
let n = 0;
const ev = (taskId: string, at: string, action: string, extra: Partial<FlowEntry> = {}): FlowEntry => ({ id: `e${++n}`, at, taskId, actor: "system", action, ...extra });
const move = (taskId: string, at: string, from: string, to: string, extra: Partial<FlowEntry> = {}) => ev(taskId, at, "status_changed", { from, to, actor: "human", ...extra });
const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, title: `Task ${id}`, status: "done", priority: "normal", createdAt: "2026-10-12T00:00:00.000Z", archivedAt: null, workspaceId: `w-${id}`, ...extra }) as Task;
const base = (extra: Partial<AnalyzeInput>): AnalyzeInput => ({
  tasks: [],
  entries: [],
  now: Date.parse("2026-10-22T12:00:00.000Z"),
  tz: "UTC",
  runningAgents: new Set(),
  runningWorkspaces: new Set(),
  commits: [],
  repos: 0,
  gitError: null,
  ...extra,
});
const statsOf = (input: AnalyzeInput, modelOf?: (id: string) => string | undefined) => {
  const p = prepare(input);
  return cardStats({ histories: p.histories, modelOf });
};
const created = (id: string, at = "2026-10-12T00:00:00.000Z") => ev(id, at, "created", { actor: "human" });
const turn = (id: string, agent: string, from: string, to: string, extra: Partial<FlowEntry> = {}) => [
  ev(id, from, "agent.turn_started", { agentId: agent }),
  ev(id, to, "agent.turn_ended", { agentId: agent, outcome: "completed", ...extra }),
];

describe("per card (§3.1, §3.2)", () => {
  it("counts from creation to the first Done; rounds include resumes and drags back, not the move to Done", () => {
    const entries = [
      created("a"),
      move("a", "2026-10-12T01:00:00.000Z", "todo", "development"),
      ...turn("a", "s1", "2026-10-12T01:00:00.000Z", "2026-10-12T02:00:00.000Z", { byUser: true, model: "m/x" }),
      move("a", "2026-10-12T02:00:00.000Z", "development", "in_review", { actor: "agent" }),
      // the user replies on the card in review: rule A1 resumes it
      move("a", "2026-10-12T03:00:00.000Z", "in_review", "development", { actor: "system", rule: "A1" }),
      ...turn("a", "s1", "2026-10-12T03:00:00.000Z", "2026-10-12T04:00:00.000Z", { byUser: true, model: "m/x" }),
      ev("a", "2026-10-12T03:30:00.000Z", "agent.permission_requested", { agentId: "s1", tool: "Bash" }),
      move("a", "2026-10-12T04:00:00.000Z", "development", "in_review", { actor: "agent" }),
      // dragged back by hand
      move("a", "2026-10-12T05:00:00.000Z", "in_review", "development"),
      move("a", "2026-10-12T06:00:00.000Z", "development", "in_review", { actor: "agent" }),
      move("a", "2026-10-12T07:00:00.000Z", "in_review", "done"),
      // after the first Done: not counted
      move("a", "2026-10-13T00:00:00.000Z", "done", "development"),
      move("a", "2026-10-13T01:00:00.000Z", "development", "done"),
    ];
    const [a] = statsOf(base({ tasks: [task("a")], entries }));
    expect(a).toMatchObject({ rounds: 2, turns: 2, model: "m/x" });
    expect(a.finishedAt).toBe(Date.parse("2026-10-12T07:00:00.000Z"));
  });

  it("drops an A1 → A1r pair (a message that changed nothing) from the rounds", () => {
    const entries = [
      created("a"),
      move("a", "2026-10-12T01:00:00.000Z", "todo", "in_review", { actor: "agent" }),
      move("a", "2026-10-12T02:00:00.000Z", "in_review", "development", { actor: "system", rule: "A1" }),
      move("a", "2026-10-12T02:10:00.000Z", "development", "in_review", { actor: "system", rule: "A1r" }),
      move("a", "2026-10-12T03:00:00.000Z", "in_review", "done"),
    ];
    expect(statsOf(base({ tasks: [task("a")], entries }))[0].rounds).toBe(0);
  });

  it("does not count In review → Committed as a round (COMMITTED-STAGE-SPEC §5)", () => {
    const entries = [
      created("a"),
      move("a", "2026-10-12T01:00:00.000Z", "todo", "in_review", { actor: "agent" }),
      move("a", "2026-10-12T02:00:00.000Z", "in_review", "committed", { actor: "agent" }),
      move("a", "2026-10-12T03:00:00.000Z", "committed", "done"),
    ];
    expect(statsOf(base({ tasks: [task("a")], entries }))[0].rounds).toBe(0);
  });

  it("leaves out cards without a Done and cards whose history was cut", () => {
    const entries = [created("a"), move("a", "2026-10-12T01:00:00.000Z", "todo", "development"), move("b", "2026-10-12T01:00:00.000Z", "todo", "done")];
    expect(statsOf(base({ tasks: [task("a", { status: "development" }), task("b")], entries }))).toEqual([]);
  });
});

const card = (over: Partial<CardStat>): CardStat => ({
  taskId: "x",
  createdAt: 0,
  start: 0,
  finishedAt: Date.parse("2026-10-21T12:00:00.000Z"),
  turns: 2,
  rounds: 1,
  model: "m/x",
  ...over,
});

describe("groups (§2.5)", () => {
  it("takes the median rounds and the one-pass share", () => {
    expect(group([card({ rounds: 0 }), card({ rounds: 2 }), card({ rounds: 30 })])).toEqual({ finished: 3, rounds: 2, onePassShare: 1 / 3 });
    expect(group([])).toEqual({ finished: 0, rounds: null, onePassShare: null });
  });
});

describe("window and models (§2.5)", () => {
  const at = (iso: string) => Date.parse(iso);
  const cards = [
    card({ taskId: "a", finishedAt: at("2026-10-21T12:00:00.000Z"), model: "m/x" }),
    card({ taskId: "b", finishedAt: at("2026-10-20T12:00:00.000Z"), model: "m/x" }),
    card({ taskId: "c", finishedAt: at("2026-10-19T12:00:00.000Z"), model: "m/x" }),
    card({ taskId: "d", finishedAt: at("2026-10-16T12:00:00.000Z"), model: "m/y" }),
    card({ taskId: "e", finishedAt: at("2026-10-15T12:00:00.000Z"), model: "m/y" }),
  ];
  const stats = workflowStats({ cards, today: "2026-10-22", tz: "UTC", now: at("2026-10-22T12:00:00.000Z") });

  it("takes the cards finished in the last 7 days, today included", () => {
    expect(stats.window).toEqual({ from: "2026-10-16", to: "2026-10-22" });
    expect(stats.finished).toBe(4);
    expect(stats.cards.map((c) => c.taskId)).toEqual(["a", "b", "c", "d"]);
  });

  it("gives a model its own row from 3 cards; the rest merge into other", () => {
    expect(stats.models.map((m) => [m.model, m.finished])).toEqual([
      ["m/x", 3],
      ["", 1],
    ]);
  });
});

describe("tokens per card (§3.4)", () => {
  it("sums each card's tokens over its active span only", () => {
    const slot = (iso: string) => Math.floor(Date.parse(iso) / (15 * 60_000));
    const usage = (input: number) => ({ input, cacheRead: input, cacheWrite: 0, output: 0, reasoning: 0 });
    const buckets = new Map([
      [slot("2026-10-20T01:00:00.000Z"), usage(10)],
      [slot("2026-10-20T05:00:00.000Z"), usage(100)], // after the card finished
    ]);
    const r = cardTokens({
      series: [{ taskId: "a", buckets }, { taskId: "a", buckets: null }],
      cards: [{ taskId: "a", start: Date.parse("2026-10-20T00:00:00.000Z"), finishedAt: Date.parse("2026-10-20T02:00:00.000Z") }],
      modelOf: () => "m/x",
      models: ["m/x"],
    });
    expect(r.perCard).toBe(20);
    expect(r.models).toEqual([{ model: "m/x", perCard: 20 }]);
    expect([r.sessions, r.missing]).toEqual([2, 1]);
  });
});
