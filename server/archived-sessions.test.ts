import { afterEach, expect, test } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "./store";
import { ArchivedSessionsService } from "./archived-sessions";
import { SUMMARIZER_LABELS } from "../shared/summary";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

test("returns only the card workspace's archived, non-summarizer sessions across pages", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-archived-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const pages = [
    [{ id: "a1", workspaceId: "w", archivedAt: now, labels: {} }, { id: "live", workspaceId: "w", archivedAt: null, labels: {} }],
    [{ id: "other", workspaceId: "x", archivedAt: now, labels: {} }, { id: "sum", workspaceId: "w", archivedAt: now, labels: { ...SUMMARIZER_LABELS } }, { id: "a2", workspaceId: "w", archivedAt: now, labels: {} }],
  ];
  const calls: unknown[] = [];
  const paseo = {
    agents: {
      list: async (options: { page: { cursor?: string } }) => {
        calls.push(options);
        const index = options.page.cursor ? 1 : 0;
        return { entries: pages[index].map((agent) => ({ agent })), pageInfo: { nextCursor: index === 0 ? "next" : null } };
      },
    },
  } as unknown as PaseoApi;
  const service = new ArchivedSessionsService(store);
  expect((await service.list("t", paseo)).map((a) => a.id)).toEqual(["a1", "a2"]);
  expect(calls).toHaveLength(2);
  await expect(service.list("missing", paseo)).rejects.toThrow(/Task not found/);
});

test("refs lists bare ids of archived, non-summarizer sessions in card workspaces only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-archived-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({ id: "t", projectId: "p", workspaceId: "w", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null });
  });
  const entries = [
    { id: "a1", workspaceId: "w", archivedAt: now, labels: {} },
    { id: "live", workspaceId: "w", archivedAt: null, labels: {} },
    { id: "other", workspaceId: "x", archivedAt: now, labels: {} },
    { id: "sum", workspaceId: "w", archivedAt: now, labels: { ...SUMMARIZER_LABELS } },
  ];
  const paseo = { agents: { list: async () => ({ entries: entries.map((agent) => ({ agent })), pageInfo: { nextCursor: null } }) } } as unknown as PaseoApi;
  expect(await new ArchivedSessionsService(store).refs(paseo)).toEqual([{ id: "a1", workspaceId: "w" }]);
});

test("a switched card also lists the archived sessions of its earlier workspaces (WORKSPACE-SWITCH-SPEC §8)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ultra-archived-")));
  roots.push(root);
  const store = new BoardStore(join(root, "data"));
  const now = new Date().toISOString();
  await store.mutate((b) => {
    b.projects.push({ id: "p", paseoProjectId: "n", title: "P", description: "", primaryPath: root, repos: [root], revision: 1, createdAt: now, updatedAt: now, archivedAt: null });
    b.tasks.push({
      id: "t", projectId: "p", workspaceId: "w2", sourcePath: root, repoPaths: [root], title: "T", description: "", status: "todo", priority: "normal", position: 0, revision: 1, operationId: "o", createdAt: now, updatedAt: now, archivedAt: null,
      previousWorkspaces: [{ id: "w1", kind: "directory", directory: root, switchedAt: now }],
    });
  });
  const agents = [
    { id: "old", workspaceId: "w1", archivedAt: now, labels: {} },
    { id: "new", workspaceId: "w2", archivedAt: now, labels: {} },
    { id: "foreign", workspaceId: "w9", archivedAt: now, labels: {} },
  ];
  const paseo = { agents: { list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null } }) } } as unknown as PaseoApi;
  const service = new ArchivedSessionsService(store);
  expect((await service.list("t", paseo)).map((a) => a.id)).toEqual(["old", "new"]);
  expect((await service.refs(paseo)).map((r) => r.id)).toEqual(["old", "new"]);
});
