import { spawn } from "node:child_process";
import { existsSync, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readlink, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Git steps of a workspace switch (WORKSPACE-SWITCH-SPEC): snapshot and copy
 * the main checkout's uncommitted changes, release the worktree's diff from
 * it, and integrate a branch into it. Every write to the main checkout is
 * checked first (`git apply --check`, compare-and-swap ref update), never a
 * stash, reset, checkout or merge. Private index files keep the shared index
 * untouched wherever a step only needs to compute something.
 */
export class GitStepError extends Error {
  override name = "GitStepError";
  constructor(
    readonly code: "CHECKOUT_BUSY" | "DETACHED_HEAD" | "REBASE_NEEDED" | "CONFLICT" | "GIT_BUSY" | "NOT_APPLICABLE" | "COMMITTED" | "PARTLY_STAGED" | "GIT_FAILED",
    message: string,
    readonly files: string[] = [],
  ) {
    super(message);
  }
}

type Run = { input?: Buffer | string; env?: Record<string, string>; timeout?: number };

const LOCK_RETRIES = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function spawnGit(cwd: string, args: string[], run: Run): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...run.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), run.timeout ?? 60_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err });
    });
    child.stdin.end(run.input ?? "");
  });
}

/** Runs git; a held `index.lock` is retried briefly, then reported as GIT_BUSY. */
export async function git(cwd: string, args: string[], run: Run = {}): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const result = await spawnGit(cwd, args, run);
    if (result.code === 0) return result.stdout;
    if (/index\.lock/.test(result.stderr)) {
      if (attempt < LOCK_RETRIES) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      throw new GitStepError("GIT_BUSY", "Another git process holds the index lock. Try again in a moment.");
    }
    const error = new GitStepError("GIT_FAILED", `git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    (error as GitStepError & { stderr?: string }).stderr = result.stderr;
    throw error;
  }
}

const text = async (cwd: string, args: string[], run?: Run) => (await git(cwd, args, run)).toString().trim();
const ok = (cwd: string, args: string[], run?: Run) => git(cwd, args, run).then(() => true, () => false);
const stderrOf = (e: unknown) => (e as { stderr?: string }).stderr || (e instanceof Error ? e.message : String(e));

/** Paths named in `git apply` errors ("error: patch failed: a.ts:3", "error: a.ts: does not match index"). */
export function failedPaths(stderr: string): string[] {
  const paths = new Set<string>();
  for (const line of stderr.split("\n")) {
    const m = /^error: (?:patch failed: )?(.+?):(?:\d+$| )/.exec(line.trim());
    if (m && m[1] && !/^(?:corrupt patch|unrecognized input)/.test(m[1])) paths.add(m[1]);
  }
  return [...paths];
}

/** A temporary index file; the shared index of the checkout is never used for computations. */
async function withPrivateIndex<T>(fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "flowly-index-"));
  try {
    return await fn({ GIT_INDEX_FILE: join(dir, "index") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A merge, rebase, cherry-pick or revert in progress, or null. */
export async function operationInProgress(dir: string): Promise<string | null> {
  const checks: [string, string][] = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
  ];
  for (const [name, label] of checks) {
    const path = await text(dir, ["rev-parse", "--git-path", name]);
    if (existsSync(resolve(dir, path))) return label;
  }
  return null;
}

/** The branch checked out in `dir`, or null on a detached HEAD. */
export async function checkedOutBranch(dir: string): Promise<string | null> {
  return text(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null);
}

export const headCommit = (dir: string) => text(dir, ["rev-parse", "HEAD"]);
export const isGitRoot = (dir: string) =>
  text(dir, ["rev-parse", "--show-toplevel"]).then((top) => resolve(top) === resolve(dir), () => false);

/** Number of uncommitted entries (tracked changes and untracked files). */
export async function uncommittedCount(dir: string): Promise<number> {
  // Every untracked file, not the folder holding them: the copy works per file.
  return (await text(dir, ["status", "--porcelain", "--untracked-files=all"])).split("\n").filter((l) => l.trim()).length;
}

/** Commits on `ref` that `target` does not contain. */
export async function commitsNotIn(dir: string, ref: string, target: string): Promise<number> {
  return Number.parseInt(await text(dir, ["rev-list", "--count", `${target}..${ref}`]), 10) || 0;
}

export type FileStat = { path: string; added: number; removed: number };

/** Per-file line counts of a patch (binary files count 0/0). */
export async function patchStats(dir: string, patch: Buffer): Promise<FileStat[]> {
  if (!patch.length) return [];
  const out = await text(dir, ["apply", "--numstat", "-"], { input: patch });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, r, ...rest] = line.split("\t");
      return { path: rest.join("\t"), added: Number.parseInt(a, 10) || 0, removed: Number.parseInt(r, 10) || 0 };
    });
}

export type Snapshot = {
  /** The main checkout's HEAD commit the copy is relative to. */
  base: string;
  /** `git diff --binary HEAD`: tracked changes, deletions and mode changes. */
  diff: Buffer;
  /** Untracked, not ignored files (repo-relative). */
  untracked: string[];
  untrackedBytes: number;
  /** Changed tracked files (repo-relative). */
  tracked: string[];
  /** Submodules with changes; they are not copied. */
  submodules: string[];
};

/** Read-only snapshot of a checkout's uncommitted state (§3.3 step 2). */
export async function snapshot(root: string): Promise<Snapshot> {
  const base = await headCommit(root);
  const diff = await git(root, ["diff", "--binary", "--no-renames", "--ignore-submodules=all", base]);
  const raw = await text(root, ["diff", "--raw", "--no-renames", base]);
  const tracked: string[] = [];
  const submodules: string[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    if (!path) continue;
    const [srcMode, dstMode] = meta.slice(1).split(" ");
    if (srcMode === "160000" || dstMode === "160000") submodules.push(path);
    else tracked.push(path);
  }
  const listed = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).toString().split("\0").filter(Boolean);
  let untrackedBytes = 0;
  for (const path of listed) untrackedBytes += (await lstat(join(root, path)).catch(() => null))?.size ?? 0;
  return { base, diff, untracked: listed, untrackedBytes, tracked, submodules };
}

/** Applies a snapshot in a fresh worktree at `snapshot.base` (§3.3 step 5); the main checkout is only read. */
export async function copySnapshot(snap: Snapshot, root: string, worktree: string): Promise<void> {
  const at = await headCommit(worktree);
  if (at !== snap.base) throw new GitStepError("NOT_APPLICABLE", `The worktree starts at ${at.slice(0, 7)}, not at ${snap.base.slice(0, 7)}.`);
  if (snap.diff.length) {
    try {
      await git(worktree, ["apply", "--binary", "-"], { input: snap.diff });
    } catch (e) {
      // A retry of the same switch reuses its worktree: the copy may already be there.
      const copied = await ok(worktree, ["apply", "-R", "--check", "--binary", "-"], { input: snap.diff });
      if (!copied) throw new GitStepError("NOT_APPLICABLE", `The uncommitted changes could not be copied: ${stderrOf(e).trim()}`, failedPaths(stderrOf(e)));
    }
  }
  for (const path of snap.untracked) {
    const from = join(root, path);
    const to = join(worktree, path);
    const info = await lstat(from).catch(() => null);
    if (!info) continue; // removed since the snapshot
    await copyEntry(from, to, info);
  }
}

/** Copies one file or symlink (`info` is its lstat), creating parent folders; the mode is kept. */
async function copyEntry(from: string, to: string, info: Stats) {
  await mkdir(dirname(to), { recursive: true });
  if (info.isSymbolicLink()) {
    await rm(to, { force: true });
    await symlink(await readlink(from), to);
  } else {
    await copyFile(from, to);
    await chmod(to, info.mode & 0o777);
  }
}

/**
 * The release patch R (§5.1): the diff from `base` to the worktree's working
 * tree, untracked files included, built with a private index (the worktree's
 * own index is untouched; ignored files such as `.flowly/` stay out).
 */
export async function releasePatch(worktree: string, base: string): Promise<Buffer> {
  return withPrivateIndex(async (env) => {
    await git(worktree, ["read-tree", base], { env });
    await git(worktree, ["add", "-A"], { env });
    return git(worktree, ["diff", "--cached", "--binary", "--no-renames", base], { env });
  });
}

export type ReleaseCheck = {
  files: FileStat[];
  /** Files whose lines in R are staged in the main checkout's index (reversed there too). */
  staged: string[];
  blockers: { code: "NOT_APPLICABLE" | "COMMITTED" | "PARTLY_STAGED" | "CHECKOUT_BUSY"; message: string; files: string[] }[];
};

const includeArgs = (path: string) => [`--include=${path.replace(/([*?[\\])/g, "\\$1")}`];

/** Checks R against the main checkout without changing anything (§5.1). */
export async function checkRelease(root: string, patch: Buffer): Promise<ReleaseCheck> {
  const files = await patchStats(root, patch);
  const result: ReleaseCheck = { files, staged: [], blockers: [] };
  if (!patch.length) return result;
  const busy = await operationInProgress(root);
  if (busy) result.blockers.push({ code: "CHECKOUT_BUSY", message: `The main checkout is in the middle of a ${busy}.`, files: [] });
  // Not committed there meanwhile: R must still apply forward to the main checkout's HEAD.
  const head = await headCommit(root);
  const forward = await withPrivateIndex(async (env) => {
    await git(root, ["read-tree", head], { env });
    return git(root, ["apply", "--cached", "--check", "--binary", "-"], { env, input: patch }).then(() => null, (e) => stderrOf(e));
  });
  if (forward !== null)
    result.blockers.push({ code: "COMMITTED", message: "Some of these lines were committed in the main checkout meanwhile.", files: failedPaths(forward) });
  // Exactly these lines are still in the main checkout's working tree.
  const reverse = await git(root, ["apply", "-R", "--check", "--binary", "-"], { input: patch }).then(() => null, (e) => stderrOf(e));
  if (reverse !== null)
    result.blockers.push({
      code: "NOT_APPLICABLE",
      message: "These lines changed in the main checkout, or were already edited in the worktree.",
      files: failedPaths(reverse),
    });
  // The shared index: reverse R's part where it is staged, leave it where it is not, refuse a mix.
  const indexed = (await text(root, ["diff", "--cached", "--name-only", "--no-renames", head])).split("\n").filter(Boolean);
  const touched = new Set(files.map((f) => f.path));
  const partly: string[] = [];
  for (const path of indexed.filter((p) => touched.has(p))) {
    if (await ok(root, ["apply", "-R", "--cached", "--check", "--binary", ...includeArgs(path), "-"], { input: patch })) result.staged.push(path);
    else if (!(await ok(root, ["apply", "--cached", "--check", "--binary", ...includeArgs(path), "-"], { input: patch }))) partly.push(path);
  }
  if (partly.length)
    result.blockers.push({ code: "PARTLY_STAGED", message: "Some of these lines are partly staged in the main checkout; unstage them there first.", files: partly });
  return result;
}

/** Removes exactly R from the main checkout (§5.2 steps 2–3). Call after a clean checkRelease. */
export async function applyRelease(root: string, patch: Buffer, staged: string[]): Promise<void> {
  if (!patch.length) return;
  const stagedArgs = staged.flatMap(includeArgs);
  if (staged.length) await git(root, ["apply", "-R", "--cached", "--binary", ...stagedArgs, "-"], { input: patch });
  try {
    await git(root, ["apply", "-R", "--binary", "-"], { input: patch });
  } catch (e) {
    if (staged.length) await git(root, ["apply", "--cached", "--binary", ...stagedArgs, "-"], { input: patch }).catch(() => undefined);
    throw new GitStepError("NOT_APPLICABLE", `The release could not be applied: ${stderrOf(e).trim()}`, failedPaths(stderrOf(e)));
  }
}

/** Puts R back into the main checkout's working tree (§5.3); the index is not changed. */
export async function undoRelease(root: string, patch: Buffer): Promise<void> {
  if (!patch.length) return;
  try {
    await git(root, ["apply", "--check", "--binary", "-"], { input: patch });
  } catch (e) {
    throw new GitStepError("NOT_APPLICABLE", "These lines changed in the main checkout since the release.", failedPaths(stderrOf(e)));
  }
  await git(root, ["apply", "--binary", "-"], { input: patch });
}

export type CopyBackCheck = {
  files: FileStat[];
  /** Files whose changes apply cleanly to the main checkout's working tree. */
  apply: string[];
  /** Files whose changes the main checkout already holds (an unreleased copy, §9). */
  present: string[];
  /** Files that neither apply nor are already there. */
  conflicts: string[];
  busy: string | null;
};

/**
 * Splits a `git diff --binary --no-renames` patch into one piece per file, in
 * patch order, which is the order `git apply --numstat` lists them. Null when
 * the pieces don't line up with that list. "diff --git " never starts a hunk
 * line (" ", "+", "-", "\") or a base85 line (no spaces).
 */
function splitPatch(patch: Buffer, files: FileStat[]): Map<string, Buffer> | null {
  const marker = Buffer.from("diff --git ");
  const starts: number[] = [];
  for (let i = patch.indexOf(marker); i !== -1; i = patch.indexOf(marker, i + 1)) if (i === 0 || patch[i - 1] === 0x0a) starts.push(i);
  if (starts.length !== files.length) return null;
  return new Map(starts.map((start, n) => [files[n].path, patch.subarray(start, starts[n + 1] ?? patch.length)]));
}

/**
 * The files among `paths` whose pieces don't apply to the main checkout
 * (forward, or reversed with `-R`). One `git apply --check` names every
 * failing file, so this takes a few runs whatever the number of files; a
 * failure git doesn't name counts every file as failing.
 */
async function failingFiles(root: string, pieces: Map<string, Buffer>, paths: string[], flags: string[]): Promise<Set<string>> {
  const failing = new Set<string>();
  for (let round = 0; round < 5; round++) {
    const rest = paths.filter((p) => !failing.has(p));
    if (!rest.length) return failing;
    const input = Buffer.concat(rest.map((p) => pieces.get(p)!));
    const error = await git(root, ["apply", ...flags, "--check", "--binary", "-"], { input }).then(
      () => null,
      (e) => stderrOf(e),
    );
    if (error === null) return failing;
    const named = failedPaths(error).filter((p) => pieces.has(p) && !failing.has(p));
    if (!named.length) break;
    for (const p of named) failing.add(p);
  }
  return new Set(paths);
}

/**
 * Which files of a worktree's uncommitted patch can be copied into the main
 * checkout (§9 "Copy to the main checkout"). Nothing is changed.
 */
export async function checkCopyBack(root: string, patch: Buffer): Promise<CopyBackCheck> {
  const files = await patchStats(root, patch);
  const result: CopyBackCheck = { files, apply: [], present: [], conflicts: [], busy: await operationInProgress(root) };
  if (!patch.length) return result;
  const paths = files.map((f) => f.path);
  const pieces = splitPatch(patch, files);
  if (!pieces) {
    // Not checkable file by file: copy only when the whole patch applies.
    if (await ok(root, ["apply", "--check", "--binary", "-"], { input: patch })) result.apply = paths;
    else result.conflicts = paths;
    return result;
  }
  const failing = await failingFiles(root, pieces, paths, []);
  const missing = await failingFiles(root, pieces, [...failing], ["-R"]);
  result.apply = paths.filter((p) => !failing.has(p));
  result.present = [...failing].filter((p) => !missing.has(p));
  result.conflicts = [...missing];
  return result;
}

/** Applies the given files of the patch to the main checkout's working tree only; the index is not changed. */
export async function applyCopyBack(root: string, patch: Buffer, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const pieces = splitPatch(patch, await patchStats(root, patch));
  // Without pieces checkCopyBack only offers the whole patch.
  const input = pieces ? Buffer.concat(paths.map((p) => pieces.get(p)).filter((b): b is Buffer => !!b)) : patch;
  try {
    await git(root, ["apply", "--binary", "-"], { input });
  } catch (e) {
    throw new GitStepError("NOT_APPLICABLE", `The changes could not be copied: ${stderrOf(e).trim()}`, failedPaths(stderrOf(e)));
  }
}

/**
 * Overwrite (§9): each file of the main checkout's working tree becomes what
 * it is in the worktree (removed when the worktree deleted it), after the main
 * checkout's current file is saved under every backup folder. The index is not
 * changed. Returns the files that did not exist in the main checkout.
 */
export async function overwriteFiles(root: string, worktree: string, paths: string[], backups: string[]): Promise<string[]> {
  const created: string[] = [];
  for (const path of paths) {
    const target = join(root, path);
    const before = await lstat(target).catch(() => null);
    if (before) for (const dir of backups) await copyEntry(target, join(dir, path), before);
    else created.push(path);
    const source = join(worktree, path);
    const after = await lstat(source).catch(() => null);
    if (after) await copyEntry(source, target, after);
    else await rm(target, { force: true });
  }
  return created;
}

/** A checkout's uncommitted files: staged, unstaged and untracked (one by one, not their folders). */
export async function changedPaths(dir: string): Promise<Set<string>> {
  const status = (await git(dir, ["status", "--porcelain", "--untracked-files=all", "--no-renames", "-z"])).toString();
  return new Set(status.split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3)));
}

export type CommitInfo = { sha: string; subject: string; at: string };

/** The last `count` commits of `ref`, newest first. */
export async function recentCommits(dir: string, ref: string, count = 5): Promise<CommitInfo[]> {
  const out = await text(dir, ["log", `-${count}`, "--format=%H%x09%cI%x09%s", ref, "--"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, at, ...subject] = line.split("\t");
      return { sha, at, subject: subject.join("\t") };
    });
}

export type IntegrateResult = { integrated: true; from: string; to: string; commits: number; files: string[] };

/**
 * Integrates `ref` into the branch checked out in the main checkout (§6):
 * fast-forward only, applied as a patch to its index and working tree so that
 * other uncommitted work there stays, then a compare-and-swap ref update.
 */
export async function integrate(root: string, ref: string): Promise<IntegrateResult> {
  const branch = await checkedOutBranch(root);
  if (!branch) throw new GitStepError("DETACHED_HEAD", "The main checkout has a detached HEAD.");
  const busy = await operationInProgress(root);
  if (busy) throw new GitStepError("CHECKOUT_BUSY", `The main checkout is in the middle of a ${busy}.`);
  const from = await headCommit(root);
  const to = await text(root, ["rev-parse", "--verify", `${ref}^{commit}`]).catch(() => {
    throw new GitStepError("GIT_FAILED", `Unknown ref ${ref}.`);
  });
  if (await ok(root, ["merge-base", "--is-ancestor", to, from])) return { integrated: true, from, to: from, commits: 0, files: [] };
  if (!(await ok(root, ["merge-base", "--is-ancestor", from, to])))
    throw new GitStepError("REBASE_NEEDED", `${branch} is not an ancestor of ${ref}. Rebase your branch onto ${branch} in your worktree, rerun the checks, then call again.`);
  const diff = await git(root, ["diff", "--binary", "--no-renames", from, to]);
  const files = (await patchStats(root, diff)).map((f) => f.path);
  const conflicts = new Set<string>();
  for (const args of [["apply", "--check", "--binary", "-"], ["apply", "--cached", "--check", "--binary", "-"]]) {
    const error = await git(root, args, { input: diff }).then(() => null, (e) => stderrOf(e));
    if (error !== null) for (const path of failedPaths(error).length ? failedPaths(error) : files) conflicts.add(path);
  }
  if (conflicts.size)
    throw new GitStepError("CONFLICT", "Uncommitted changes in the main checkout touch the same lines.", [...conflicts]);
  const commits = await commitsNotIn(root, to, from);
  if (diff.length) await git(root, ["apply", "--cached", "--binary", "-"], { input: diff });
  try {
    if (diff.length) await git(root, ["apply", "--binary", "-"], { input: diff });
  } catch (e) {
    await git(root, ["apply", "-R", "--cached", "--binary", "-"], { input: diff }).catch(() => undefined);
    throw new GitStepError("CONFLICT", `The change could not be applied: ${stderrOf(e).trim()}`, failedPaths(stderrOf(e)));
  }
  try {
    await git(root, ["update-ref", `refs/heads/${branch}`, to, from]);
  } catch (e) {
    if (diff.length) {
      await git(root, ["apply", "-R", "--binary", "-"], { input: diff }).catch(() => undefined);
      await git(root, ["apply", "-R", "--cached", "--binary", "-"], { input: diff }).catch(() => undefined);
    }
    throw new GitStepError("GIT_FAILED", `${branch} moved meanwhile; nothing was changed. ${stderrOf(e).trim()}`);
  }
  return { integrated: true, from, to, commits, files };
}
