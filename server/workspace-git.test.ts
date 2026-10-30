import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyCopyBack,
  applyRelease,
  changedPaths,
  checkCopyBack,
  checkRelease,
  copySnapshot,
  failedPaths,
  GitStepError,
  integrate,
  overwriteFiles,
  recentCommits,
  releasePatch,
  snapshot,
  undoRelease,
} from "./workspace-git";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const write = (dir: string, path: string, body: string) => writeFileSync(join(dir, path), body);
const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const status = (dir: string) => sh(dir, "status", "--porcelain").trimEnd().split("\n").filter(Boolean).sort();

/**
 * The spike scenario: card A and card B both changed `shared.txt` (different
 * regions), B changed `onlyB.txt`, A added `newA.txt`, C left `untrackedC.txt`.
 */
function scenario() {
  const top = mkdtempSync(join(tmpdir(), "flowly-switch-"));
  dirs.push(top);
  const root = join(top, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  sh(root, "config", "user.email", "t@t");
  sh(root, "config", "user.name", "t");
  write(root, "shared.txt", "a1\na2\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2\nb3\n");
  write(root, "onlyB.txt", "x\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-qm", "base");
  write(root, "shared.txt", "a1\na2-A\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2-B\nb3\n");
  write(root, "onlyB.txt", "x\ny\n");
  write(root, "newA.txt", "new A\n");
  write(root, "untrackedC.txt", "scratch C\n");
  const wt = join(top, "wt");
  return { top, root, wt };
}

async function switched() {
  const s = scenario();
  const snap = await snapshot(s.root);
  sh(s.root, "worktree", "add", "-q", "-b", "kanban/a", s.wt, snap.base);
  await copySnapshot(snap, s.root, s.wt);
  return { ...s, snap };
}

/** The new session trims the worktree to card A's changes. */
function trim(wt: string) {
  sh(wt, "checkout", "-q", "--", "onlyB.txt");
  rmSync(join(wt, "untrackedC.txt"));
  write(wt, "shared.txt", "a1\na2-A\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2\nb3\n");
}

test("snapshot copies every uncommitted change into the worktree and leaves the main checkout alone", async () => {
  const { root, wt, snap } = await switched();
  expect(snap.tracked.sort()).toEqual(["onlyB.txt", "shared.txt"]);
  expect(snap.untracked.sort()).toEqual(["newA.txt", "untrackedC.txt"]);
  expect(read(wt, "shared.txt")).toBe(read(root, "shared.txt"));
  expect(read(wt, "newA.txt")).toBe("new A\n");
  expect(read(wt, "untrackedC.txt")).toBe("scratch C\n");
  expect(status(root)).toEqual([" M onlyB.txt", " M shared.txt", "?? newA.txt", "?? untrackedC.txt"]);
});

test("copying again into the same worktree (a retried switch) keeps the copy as it is", async () => {
  const { root, wt, snap } = await switched();
  await copySnapshot(snap, root, wt);
  expect(read(wt, "shared.txt")).toBe(read(root, "shared.txt"));
  expect(read(wt, "newA.txt")).toBe("new A\n");
});

test("release removes exactly the trimmed worktree's diff from the main checkout, undo puts it back", async () => {
  const { root, wt, snap } = await switched();
  trim(wt);
  const patch = await releasePatch(wt, snap.base);
  const check = await checkRelease(root, patch);
  expect(check.blockers).toEqual([]);
  expect(check.files.map((f) => f.path).sort()).toEqual(["newA.txt", "shared.txt"]);
  await applyRelease(root, patch, check.staged);
  expect(status(root)).toEqual([" M onlyB.txt", " M shared.txt", "?? untrackedC.txt"]);
  expect(read(root, "shared.txt")).toContain("b2-B");
  expect(read(root, "shared.txt")).not.toContain("a2-A");
  expect(existsSync(join(root, "newA.txt"))).toBe(false);
  await undoRelease(root, patch);
  expect(read(root, "shared.txt")).toContain("a2-A");
  expect(read(root, "newA.txt")).toBe("new A\n");
});

test("release is refused once the card's lines were edited in the worktree", async () => {
  const { root, wt, snap } = await switched();
  trim(wt);
  write(wt, "newA.txt", "new A\nedited before release\n");
  const check = await checkRelease(root, await releasePatch(wt, snap.base));
  expect(check.blockers.map((b) => b.code)).toEqual(["NOT_APPLICABLE"]);
  expect(check.blockers[0].files).toContain("newA.txt");
});

test("release is refused when those lines changed in the main checkout", async () => {
  const { root, wt, snap } = await switched();
  trim(wt);
  write(root, "shared.txt", "a1\na2-A changed in main\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2-B\nb3\n");
  const check = await checkRelease(root, await releasePatch(wt, snap.base));
  expect(check.blockers.map((b) => b.code)).toContain("NOT_APPLICABLE");
  expect(check.blockers.find((b) => b.code === "NOT_APPLICABLE")!.files).toContain("shared.txt");
});

test("release is refused when the lines were committed in the main checkout meanwhile", async () => {
  const { root, wt, snap } = await switched();
  trim(wt);
  sh(root, "add", "newA.txt");
  sh(root, "commit", "-qm", "someone committed A's file");
  const check = await checkRelease(root, await releasePatch(wt, snap.base));
  expect(check.blockers.map((b) => b.code)).toContain("COMMITTED");
});

test("release unstages the card's lines when they are staged, and leaves other staged work alone", async () => {
  const { root, wt, snap } = await switched();
  trim(wt);
  sh(root, "add", "newA.txt", "onlyB.txt");
  const patch = await releasePatch(wt, snap.base);
  const check = await checkRelease(root, patch);
  expect(check.blockers).toEqual([]);
  expect(check.staged).toEqual(["newA.txt"]);
  await applyRelease(root, patch, check.staged);
  expect(sh(root, "diff", "--cached", "--name-only").trim()).toBe("onlyB.txt");
  expect(existsSync(join(root, "newA.txt"))).toBe(false);
});

test("release is refused while the card's lines are partly staged", async () => {
  const { root, wt, snap } = await switched();
  trim(wt);
  write(wt, "shared.txt", "a1\na2-A\na3-A\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2\nb3\n");
  write(root, "shared.txt", "a1\na2-A\na3-A\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2-B\nb3\n");
  // Stage only the a2 line of card A in the main checkout.
  execFileSync("git", ["-C", root, "update-index", "--add", "--cacheinfo", `100644,${writeStaged(root)},shared.txt`]);
  const check = await checkRelease(root, await releasePatch(wt, snap.base));
  expect(check.blockers.map((b) => b.code)).toContain("PARTLY_STAGED");
});

/** A blob of shared.txt with only the a2 line of card A, for a partly staged index entry. */
function writeStaged(root: string) {
  return execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
    input: "a1\na2-A\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2\nb3\n",
    encoding: "utf8",
  }).trim();
}

test("integrate needs a rebase after main moved, then lands the card's commit and keeps others' work uncommitted", async () => {
  const { root, wt, snap } = await switched();
  trim(wt);
  const patch = await releasePatch(wt, snap.base);
  await applyRelease(root, patch, (await checkRelease(root, patch)).staged);
  write(wt, "newA.txt", "new A (fixed)\n");
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", "feat: A");
  write(root, "c.txt", "c\n");
  sh(root, "add", "c.txt");
  sh(root, "commit", "-qm", "feat: C");
  await expect(integrate(root, "kanban/a")).rejects.toMatchObject({ code: "REBASE_NEEDED" });
  sh(wt, "rebase", "-q", "main");
  const result = await integrate(root, "kanban/a");
  expect(result.commits).toBe(1);
  expect(sh(root, "log", "--format=%s", "-2").trim().split("\n")).toEqual(["feat: A", "feat: C"]);
  expect(status(root)).toEqual([" M onlyB.txt", " M shared.txt", "?? untrackedC.txt"]);
  expect(read(root, "newA.txt")).toBe("new A (fixed)\n");
  expect(read(root, "shared.txt")).toBe("a1\na2-A\na3\nmid1\nmid2\nmid3\nmid4\nmid5\nb1\nb2-B\nb3\n");
  expect((await integrate(root, "kanban/a")).commits).toBe(0);
});

test("integrate refuses a conflict with uncommitted lines in the main checkout and changes nothing", async () => {
  const { root, wt } = await switched();
  trim(wt);
  sh(wt, "add", "-A");
  sh(wt, "commit", "-qm", "feat: A");
  // Not released: the main checkout still holds A's copy of the same lines.
  const before = sh(root, "rev-parse", "HEAD");
  const error = await integrate(root, "kanban/a").catch((e: GitStepError) => e);
  expect(error).toBeInstanceOf(GitStepError);
  expect((error as GitStepError).code).toBe("CONFLICT");
  expect((error as GitStepError).files.length).toBeGreaterThan(0);
  expect(sh(root, "rev-parse", "HEAD")).toBe(before);
});

test("copy back applies a worktree's uncommitted changes to the main checkout, skips what is already there and reports conflicts", async () => {
  const { root, wt } = await switched();
  // Untouched copy: the main checkout already holds every change.
  let check = await checkCopyBack(root, await releasePatch(wt, "HEAD"));
  expect(check).toMatchObject({ apply: [], conflicts: [], busy: null });
  expect(check.present.sort()).toEqual(["newA.txt", "onlyB.txt", "shared.txt", "untrackedC.txt"]);
  write(wt, "late.txt", "late\n");
  write(wt, "newA.txt", "new A\nedited in the worktree\n");
  const patch = await releasePatch(wt, "HEAD");
  check = await checkCopyBack(root, patch);
  expect(check.apply).toEqual(["late.txt"]);
  expect(check.conflicts).toEqual(["newA.txt"]);
  expect(check.present.sort()).toEqual(["onlyB.txt", "shared.txt", "untrackedC.txt"]);
  await applyCopyBack(root, patch, check.apply);
  expect(read(root, "late.txt")).toBe("late\n");
  expect(read(root, "newA.txt")).toBe("new A\n");
  expect(status(root)).toEqual([" M onlyB.txt", " M shared.txt", "?? late.txt", "?? newA.txt", "?? untrackedC.txt"]);
});

test("copy back checks thousands of files in a few git runs (a worktree with a fresh vendor folder)", async () => {
  const { root, wt } = await switched();
  mkdirSync(join(wt, "vendor"));
  mkdirSync(join(root, "vendor"));
  for (let i = 0; i < 1500; i++) write(wt, `vendor/f${i}.php`, `<?php // ${i}\n`);
  // A third is already in the main checkout, one differs there.
  for (let i = 0; i < 500; i++) write(root, `vendor/f${i}.php`, `<?php // ${i}\n`);
  write(root, "vendor/f7.php", "<?php // changed in main\n");
  const started = Date.now();
  const patch = await releasePatch(wt, "HEAD");
  const check = await checkCopyBack(root, patch);
  expect(Date.now() - started).toBeLessThan(15_000);
  expect(check.apply).toHaveLength(1000);
  expect(check.conflicts).toEqual(["vendor/f7.php"]);
  // The untouched copy (4 files) plus 499 vendor files are already there.
  expect(check.present).toHaveLength(503);
  await applyCopyBack(root, patch, check.apply);
  expect(read(root, "vendor/f1499.php")).toBe("<?php // 1499\n");
  expect(read(root, "vendor/f7.php")).toBe("<?php // changed in main\n");
}, 60_000);

test("overwrite makes the main checkout's files what they are in the worktree and saves the main checkout's versions first", async () => {
  const { top, root, wt } = await switched();
  write(wt, "newA.txt", "new A\nedited in the worktree\n");
  write(wt, "late.txt", "late\n");
  rmSync(join(wt, "untrackedC.txt"));
  const backup = join(top, "backup");
  const created = await overwriteFiles(root, wt, ["newA.txt", "late.txt", "untrackedC.txt"], [backup]);
  expect(created).toEqual(["late.txt"]);
  expect(read(root, "newA.txt")).toBe("new A\nedited in the worktree\n");
  expect(read(root, "late.txt")).toBe("late\n");
  expect(existsSync(join(root, "untrackedC.txt"))).toBe(false);
  expect(read(backup, "newA.txt")).toBe("new A\n");
  expect(read(backup, "untrackedC.txt")).toBe("scratch C\n");
  expect(existsSync(join(backup, "late.txt"))).toBe(false);
  // Other files and the index stay as they were.
  expect(read(root, "shared.txt")).toContain("b2-B");
  expect(sh(root, "diff", "--cached", "--name-only").trim()).toBe("");
});

test("changedPaths lists every uncommitted file (untracked ones one by one); recentCommits lists the last commits", async () => {
  const { root } = scenario();
  sh(root, "add", "onlyB.txt");
  rmSync(join(root, "untrackedC.txt"));
  mkdirSync(join(root, "dir"));
  write(root, "dir/deep.txt", "deep\n");
  expect([...(await changedPaths(root))].sort()).toEqual(["dir/deep.txt", "newA.txt", "onlyB.txt", "shared.txt"]);
  sh(root, "commit", "-qm", "second");
  const commits = await recentCommits(root, "HEAD");
  expect(commits.map((c) => c.subject)).toEqual(["second", "base"]);
  expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
});

test("failedPaths reads git apply errors", () => {
  expect(failedPaths("error: patch failed: shared.txt:2\nerror: shared.txt: patch does not apply\nerror: a b.ts: does not match index\n")).toEqual([
    "shared.txt",
    "a b.ts",
  ]);
});
