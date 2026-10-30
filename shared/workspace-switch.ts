import type { Task } from "./model";

/**
 * The card's current workspace and its earlier ones (WORKSPACE-SWITCH-SPEC §8):
 * where history belongs (archived sessions, usage, insights). Live views use
 * `task.workspaceId` only.
 */
export function cardWorkspaceIds(task: Pick<Task, "workspaceId" | "previousWorkspaces">): string[] {
  return [task.workspaceId, ...(task.previousWorkspaces || []).map((w) => w.id)];
}

/** Workspace id → card id, current and earlier workspaces of every card. */
export function workspaceOwners<T extends Pick<Task, "id" | "workspaceId" | "previousWorkspaces">>(tasks: readonly T[]): Map<string, T> {
  const owners = new Map<string, T>();
  for (const task of tasks) for (const id of cardWorkspaceIds(task)) if (!owners.has(id) || id === task.workspaceId) owners.set(id, task);
  return owners;
}

/**
 * The row a changed file belongs to in the Switch to local overview (§9.1):
 * its folder cut at two levels ("a/b/" for "a/b/c/d.php", "a/" for "a/x.php");
 * a top-level file is its own row.
 */
export function folderOf(path: string): string {
  const parts = path.split("/");
  return parts.length === 1 ? path : `${parts.slice(0, Math.min(2, parts.length - 1)).join("/")}/`;
}

/** The fixed prompt of "Ask {session} for a handover" (§2.2). */
export const handoverPrompt =
  "Write the handover for moving this card to a worktree: call flowly_handover with every file this card changed in the main checkout (including files changed by scripts or generated), and in notes say which hunks in files shared with other cards are this card's and what is unfinished. Change nothing else.";

/** The first-instructions line of a switched card (§3.5, §9); empty when nothing is pending. */
export function switchContextLine(task: Pick<Task, "switch">): string {
  const s = task.switch;
  if (!s) return "";
  const day = s.at.slice(0, 10);
  if (s.direction === "to_worktree" && s.release === "pending")
    return `This card moved from the main checkout to this worktree on ${day}. The worktree holds a copy of ALL uncommitted changes of the main checkout, not only this card's. Read the handoff input first, trim the worktree to this card's changes, change nothing else, then ask the user to release.`;
  if (s.direction === "to_local" && s.branch)
    return `This card moved from its worktree back to the main checkout on ${day}. Read the handoff input first. Its earlier branch ${s.branch} is kept; if it holds commits that are not in the main branch, integrate them only when the user asks.`;
  return "";
}
