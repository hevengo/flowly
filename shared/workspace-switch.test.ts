import { expect, test } from "vitest";
import { cardWorkspaceIds, folderOf, switchContextLine, workspaceOwners } from "./workspace-switch";

const at = "2026-10-29T10:00:00.000Z";

test("a card's history covers its current and earlier workspaces; the current card wins a shared id", () => {
  const moved = { id: "a", workspaceId: "w2", previousWorkspaces: [{ id: "w1", kind: "directory", directory: "/r", switchedAt: at }] };
  const other = { id: "b", workspaceId: "w3" };
  expect(cardWorkspaceIds(moved)).toEqual(["w2", "w1"]);
  expect(cardWorkspaceIds(other)).toEqual(["w3"]);
  const owners = workspaceOwners([moved, other, { id: "c", workspaceId: "w1" }]);
  expect(owners.get("w1")?.id).toBe("c");
  expect(owners.get("w2")?.id).toBe("a");
});

test("the first instructions name a pending release and a kept branch, nothing otherwise", () => {
  expect(switchContextLine({})).toBe("");
  const pending = switchContextLine({ switch: { id: "s", at, direction: "to_worktree", release: "pending" } });
  expect(pending).toMatch(/ALL uncommitted changes/);
  expect(pending).toMatch(/ask the user to release/);
  expect(switchContextLine({ switch: { id: "s", at, direction: "to_worktree", release: "released" } })).toBe("");
  expect(switchContextLine({ switch: { id: "s", at, direction: "to_local", branch: "kanban/a", release: "none" } })).toMatch(/kanban\/a is kept/);
});

test("the Switch to local overview groups a file by its first two directory levels", () => {
  expect(folderOf("vendor/composer/installed.php")).toBe("vendor/composer/");
  expect(folderOf("vendor/nikic/php-parser/lib/PhpParser/Lexer.php")).toBe("vendor/nikic/");
  expect(folderOf("docs/guide.md")).toBe("docs/");
  expect(folderOf("composer.json")).toBe("composer.json");
});
