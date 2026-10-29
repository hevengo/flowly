import { expect, test } from "vitest";
import { enabledStatuses, laneName, laneProblem, projectLanes } from "./lanes";
import { lanesSchema } from "./model";

test("lanes default to the built-in workflow and honour order, names and toggles", () => {
  expect(enabledStatuses(undefined)).toEqual(["backlog", "todo", "design", "development", "test", "in_review", "committed", "blocked", "done", "cancelled"]);
  const project = {
    lanes: [
      { status: "todo" as const, enabled: true, name: "Ready" },
      { status: "development" as const, enabled: true },
      { status: "design" as const, enabled: false },
      { status: "test" as const, enabled: false },
      { status: "done" as const, enabled: true },
      { status: "backlog" as const, enabled: false },
      { status: "in_review" as const, enabled: false },
      { status: "committed" as const, enabled: false },
      { status: "blocked" as const, enabled: false },
      { status: "cancelled" as const, enabled: false },
    ],
  };
  expect(enabledStatuses(project)).toEqual(["todo", "development", "done"]);
  expect(laneName(project, "todo")).toBe("Ready");
  expect(laneName(project, "done")).toBe("Done");
  expect(laneProblem(project, "blocked")).toMatch(/not a lane/);
  expect(laneProblem(project, "todo")).toBe("");
  expect(projectLanes(project)).toHaveLength(10);
});

// Lanes stored before Committed existed (COMMITTED-STAGE-SPEC §2).
const before = [
  { status: "todo" as const, enabled: true, name: "Ready" },
  { status: "development" as const, enabled: true },
  { status: "in_review" as const, enabled: false, name: "QA" },
  { status: "design" as const, enabled: false },
  { status: "test" as const, enabled: true },
  { status: "done" as const, enabled: true },
  { status: "backlog" as const, enabled: false },
  { status: "blocked" as const, enabled: false },
  { status: "cancelled" as const, enabled: false },
];

test("stored lanes without Committed get it right after In review, enabled, everything else kept", () => {
  const parsed = lanesSchema.parse(before);
  expect(parsed.map((l) => l.status)).toEqual(["todo", "development", "in_review", "committed", "design", "test", "done", "backlog", "blocked", "cancelled"]);
  expect(parsed[3]).toEqual({ status: "committed", enabled: true });
  expect(parsed.filter((l) => l.status !== "committed")).toEqual(before);
  expect(projectLanes({ lanes: before })).toEqual(parsed);
  expect(enabledStatuses({ lanes: before })).toEqual(["todo", "development", "committed", "test", "done"]);
  // Already complete: unchanged, including a disabled or moved Committed.
  expect(lanesSchema.parse(parsed)).toEqual(parsed);
  const moved = [{ status: "committed" as const, enabled: false }, ...before];
  expect(lanesSchema.parse(moved)).toEqual(moved);
});

test("lane completion does not hide invalid lanes", () => {
  expect(lanesSchema.safeParse([...before, { status: "todo", enabled: true }]).success).toBe(false);
  expect(lanesSchema.safeParse(before.slice(1)).success).toBe(true);
  expect(lanesSchema.safeParse(before.map((l) => ({ ...l, enabled: false }))).success).toBe(true);
  expect(lanesSchema.safeParse([...before.map((l) => ({ ...l, enabled: false })), { status: "committed", enabled: false }]).success).toBe(false);
  expect(lanesSchema.safeParse("lanes").success).toBe(false);
});
