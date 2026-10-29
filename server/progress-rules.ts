import { enabledStatuses, laneEnabled } from "../shared/lanes";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import { isDeliveryStatus, isWorkStatus, legacyStatus, workStatuses, type Board, type BoardEvent, type Status, type Task } from "../shared/model";
import type { ToolIdentity } from "../shared/tools";
import { nextMovesAction } from "../shared/next-moves";

type Store = { event(board: Board, input: Omit<BoardEvent, "id" | "at">): unknown };

function bound(board: Board, identity: ToolIdentity) {
  const task = board.tasks.find(
    (t) => t.id === identity.taskId && t.workspaceId === identity.workspaceId,
  );
  const project = task && board.projects.find((p) => p.id === task.projectId);
  return task && project ? { task, project } : null;
}

/** Records a lifecycle fact for a Kanban-managed session's card. */
export function recordLifecycle(
  store: Store,
  board: Board,
  identity: ToolIdentity,
  action: "agent.turn_started" | "agent.turn_ended" | "agent.permission_requested",
  outcome?: PluginTurnOutcome,
  /** WORKFLOW-INSIGHTS-SPEC §12.4: the session's model and the next move the user's message took, on turn_ended. */
  habits: { model?: string; pick?: number; byUser?: boolean; tool?: string } = {},
) {
  const target = bound(board, identity);
  if (!target) return;
  store.event(board, {
    taskId: target.task.id,
    actor: "system",
    action,
    agentId: identity.agentId,
    ...(outcome ? { outcome: outcome.kind } : {}),
    ...(outcome?.kind === "failed" ? { note: outcome.error.message.slice(0, 500) } : {}),
    ...(habits.model ? { model: habits.model.slice(0, 200) } : {}),
    ...(habits.pick !== undefined ? { pick: habits.pick } : {}),
    ...(habits.byUser !== undefined ? { byUser: habits.byUser } : {}),
    ...(habits.tool ? { tool: habits.tool.slice(0, 80) } : {}),
  });
}

/** Statuses a new turn resumes from: continuing after review, commit (COMMITTED-STAGE-SPEC §4) or a blocker. */
const restartable: readonly Status[] = ["in_review", "committed", "blocked"];

/**
 * The work stage a resumed card goes to. Feedback after review is rework, so a card
 * in review (or committed) resumes in Development. A blocked card returns to the latest stage it was
 * in (the retired In progress counts as Development). Disabled lanes fall back to
 * the first enabled stage; null when the workflow has no enabled work stage. The
 * agent corrects the stage when the turn's work belongs elsewhere.
 */
export function resumeStage(board: Board, task: Task, project: Parameters<typeof laneEnabled>[0]): Status | null {
  if (isDeliveryStatus(task.status) && laneEnabled(project, "development")) return "development";
  if (!isDeliveryStatus(task.status)) for (let i = board.events.length - 1; i >= 0; i--) {
    const e = board.events[i];
    if (e.taskId !== task.id || e.action !== "status_changed" || !e.to) continue;
    const stage = e.to === legacyStatus ? "development" : e.to;
    if (isWorkStatus(stage) && laneEnabled(project, stage)) return stage;
  }
  return enabledStatuses(project).find((s) => (workStatuses as readonly Status[]).includes(s)) ?? null;
}

/**
 * Rule A1: a Kanban-managed session starting a turn on a card in review, committed or blocked
 * means work resumes (see resumeStage). Starting from Backlog/Todo leaves
 * the card alone: the agent decides whether to begin with Design or Development
 * (WORKFLOW-STAGES-SPEC). Never touches finished/archived cards or projects that
 * turned the rules off.
 */
export function applyTurnStarted(
  store: Store,
  board: Board,
  identity: ToolIdentity,
  sessionTitle: string | null,
  now = new Date(),
): boolean {
  const target = bound(board, identity);
  if (!target) return false;
  const { task, project } = target;
  if (
    task.archivedAt ||
    project.archivedAt ||
    project.autoStatus === false ||
    !restartable.includes(task.status)
  )
    return false;
  const stage = resumeStage(board, task, project);
  // The workflow has no work stage lane: leave the card where it is.
  if (!stage) return false;
  const from = task.status;
  task.status = stage;
  task.revision++;
  task.updatedAt = now.toISOString();
  store.event(board, {
    taskId: task.id,
    actor: "system",
    action: "status_changed",
    agentId: identity.agentId,
    rule: "A1",
    from,
    to: stage,
    note: `${sessionTitle || "A session"} resumed after a new message`,
  });
  return true;
}

/**
 * Rule A1r: a turn that A1 resumed from In review/Committed/Blocked, which then ends
 * without any Kanban report, restores the previous status. A casual message
 * ("thanks") must not leave a reviewed card looking active.
 */
export function applyTurnEnded(
  store: Store,
  board: Board,
  identity: ToolIdentity,
  outcome: PluginTurnOutcome,
  now = new Date(),
): boolean {
  const target = bound(board, identity);
  if (!target || outcome.kind === "failed") return false;
  const { task, project } = target;
  if (task.archivedAt || project.archivedAt || project.autoStatus === false || !isWorkStatus(task.status))
    return false;
  const mine = board.events.filter((e) => e.taskId === task.id && e.agentId === identity.agentId);
  let started = -1;
  for (let i = mine.length - 1; i >= 0; i--)
    if (mine[i].action === "agent.turn_started") {
      started = i;
      break;
    }
  if (started < 0) return false;
  const turn = mine.slice(started + 1);
  const resumed = turn.find(
    (e) => e.rule === "A1" && !!e.from && (restartable as readonly string[]).includes(e.from),
  );
  // Suggested next moves are not work (NEXT-MOVES-SPEC §3).
  if (!resumed?.from || turn.some((e) => e.actor === "agent" && e.action !== nextMovesAction)) return false;
  const restored = resumed.from as Status;
  if (!laneEnabled(project, restored)) return false;
  // Someone else (a person or another session) may have moved it since.
  const lastChange = [...board.events].reverse().find((e) => e.taskId === task.id && e.action === "status_changed");
  if (lastChange?.id !== resumed.id) return false;
  const from = task.status;
  task.status = restored;
  task.revision++;
  task.updatedAt = now.toISOString();
  store.event(board, {
    taskId: task.id,
    actor: "system",
    action: "status_changed",
    agentId: identity.agentId,
    rule: "A1r",
    from,
    to: restored,
    note: "No work was reported in that turn; restored",
  });
  return true;
}
