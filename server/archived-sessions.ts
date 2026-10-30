import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { BoardStore } from "./store";
import { isSummarizer } from "../shared/summary";
import { cardWorkspaceIds } from "../shared/workspace-switch";

/**
 * Archived sessions of a card's workspace (PERFORMANCE-SPEC §3). The SDK has
 * no workspace filter, so finding them means paging every agent on the host,
 * archived included: cheap on the daemon, hundreds of KB per read for a phone.
 */
export class ArchivedSessionsService {
  constructor(readonly store: BoardStore) {}

  async list(taskId: string, paseo: PaseoApi): Promise<PaseoAgent[]> {
    const board = await this.store.read();
    const task = board.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found.");
    // Earlier workspaces of a switched card count too (WORKSPACE-SWITCH-SPEC §8).
    const workspaces = new Set(cardWorkspaceIds(task));
    const found: PaseoAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries)
        if (agent.workspaceId && workspaces.has(agent.workspaceId) && agent.archivedAt && !isSummarizer(agent)) found.push(agent);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return found;
  }

  /** Ids of the archived, non-summarizer sessions in any card's workspace (the Task chip's scan). */
  async refs(paseo: PaseoApi): Promise<{ id: string; workspaceId: string }[]> {
    const board = await this.store.read();
    const workspaces = new Set(board.tasks.flatMap(cardWorkspaceIds));
    const found: { id: string; workspaceId: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, cursor } });
      for (const { agent } of page.entries)
        if (agent.archivedAt && agent.workspaceId && workspaces.has(agent.workspaceId) && !isSummarizer(agent)) found.push({ id: agent.id, workspaceId: agent.workspaceId });
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return found;
  }
}
