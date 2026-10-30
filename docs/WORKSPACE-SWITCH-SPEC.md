# Switch a card between local and worktree

Status: requested on card "switch local and worktree" (2026-10-28): "add a switch or button to change the card from local to worktree and from worktree to local; mostly used when explorative work in local showed that a worktree is needed". Spec approved by the user on 2026-10-29 and implemented (`server/workspace-git.ts`, `server/workspace-switch.ts`, `client/workspace-switch.tsx`); the live check of §15 is still to be run.

The main use case (user, 2026-10-29): a feature was developed in the shared main checkout in parallel with other work. Committing the different changes separately clogs and blocks (other cards' half-done changes break typecheck and tests, shared files mix several features). The card moves to its own worktree, where its changes are verified and committed in isolation, and then integrated back into the main checkout.

## 0. User decisions (2026-10-29)

1. The old workspace is archived when the card switches; its sessions too.
2. After a switch Flowly starts nothing. The user starts the next session.
3. Carry over as much information as possible: the same card (nothing on it is copied or lost), a handover, the old sessions' conversations, and the old sessions stay visible on the card.
4. **Flowly copies all uncommitted changes of the main checkout into the new worktree.** No selection happens in the shared checkout at switch time. (The user suggested the `paseo.json` worktree setup script for the copy; Flowly does the same copy itself, see below.)
5. **The card's changes are identified by its sessions, not by the git index**, because the index is shared. A **handover** lists them; the new session **trims** the worktree to them.
6. A **user-confirmed Release** then removes exactly the worktree's diff from the main checkout.
7. Integration back into the main checkout goes through an agent tool, **`flowly_integrate`**, and is recorded with the existing Committed and Integrated stages ([COMMITTED-STAGE-SPEC](COMMITTED-STAGE-SPEC.md), [INTEGRATED-STAGE-SPEC](INTEGRATED-STAGE-SPEC.md)). No "Land" button and no new lane.

Rejected, with the reason:

- *Copy only selected files*: every feature here touches the same files (10 i18n catalogs, `shared/rpc.ts`, `docs/PROGRESS.md`, `AGENTS.md`); per-file selection moves other cards' work.
- *Move the staged changes (git index)*: the index is shared by every session in the checkout (user).
- *Derive the card's changes from the sessions' Edit/Write tool calls*: measured on card "badge for worktree vs local", whose commit `b776de2` changed 30 files; its Edit/Write calls cover 5. The rest came from `python3` scripts run through the shell. A Codex session had no edit items at all. Used only as a hint (§5.1).
- *The card's agent selects a patch in the shared checkout at switch time*: too fragile (user).
- *Snapshot the tree at every turn and credit diffs to sessions*: several sessions run in the same checkout at the same time, so overlapping turns mix; and it only covers turns after it ships.
- *Copy through the `paseo.json` worktree setup script*: it runs for every new worktree of the project, needs per-project configuration plus a marker saying when to copy, and runs asynchronously after creation, so Flowly cannot tell when it finished. Setup scripts still run as usual next to Flowly's copy.
- *No release step*: the card's changes would stay in the main checkout, keep clogging the other commits there, and be applied twice at integration.

Spikes on a throwaway repository (two features in one shared file, an untracked file of a third) confirmed every git step below: copy all → trim → release removed only the card's lines and kept the others' (including their untracked file); a release after the card's lines had been edited in the worktree was refused; integration into the still-dirty main checkout put the card's commit on the branch and kept the others' changes uncommitted. Plain `git merge --ff-only` refused ("local changes would be overwritten"), and the current `AGENTS.md` recipe (move the branch ref, then a mixed reset) left the moved changes looking reverted.

## 1. Flow

```
local card, main checkout dirty with this card's and other cards' changes
  │ (optional) Handover: the card's session lists its changes          §2
  ▼
Switch to worktree (user, confirmed)                                    §3
  - new worktree from the main checkout's HEAD, all uncommitted changes copied in
  - handoff folder written, card moved to the worktree, old workspace + sessions archived
  ▼
new session (started by the user): trims the worktree to this card's changes   §4
  ▼
Release from main (user, confirmed): exactly the worktree's diff leaves the main checkout   §5
  ▼
verify, fix, commit in the worktree → Committed
  ▼
flowly_integrate (agent, on the user's request) → Integrated            §6
  ▼
wrap-up archives the worktree (MULTITASK-SPEC)
```

"Main checkout" is the project root's own checkout (not a worktree), as in INTEGRATED-STAGE-SPEC §1. Its checked-out branch is the "main branch" below.

## 2. Handover

A handover is the card's own statement of which changes in the main checkout are its own. It is written by a session of the card that did the work, because only that session knows about changes made by scripts, generators and shell commands.

### 2.1 Agent tool `flowly_handover`

- Input: the usual `expectedRevision` and signed `request`; `files`: repo-relative paths this card changed in the main checkout (1–500, each ≤ 500 chars; added, modified and deleted files, including generated ones); `notes`: Markdown ≤ 20 000 chars (which hunks in files shared with other cards are this card's, what is unfinished, anything the next session must know).
- Allowed for any card's session. It replaces the card's previous handover (one per card), records an event `handover_written` and does not change the card revision. CLI: `handover --request-file … --files a,b --notes …` (or `--notes-file`).
- `flowly_get_task` returns `handover` (`{ agentId, at, files, notes }`) when present.

### 2.2 Asking for a handover

The switch dialog (§3.1) shows the handover's age and session, or "No handover yet". When the card has an idle session in its current workspace, the dialog offers **Ask {session} for a handover**. It sends that session this fixed prompt, an explicit user action like "Send Kanban work instructions" (not an ordinary follow-up):

> Write the handover for moving this card to a worktree: call flowly_handover with every file this card changed in the main checkout (including files changed by scripts or generated), and in notes say which hunks in files shared with other cards are this card's and what is unfinished. Change nothing else.

The dialog updates when the handover arrives. A switch without a handover is allowed, with a warning; the new session then works from the transcripts (§3.4).

## 3. Switch to worktree

### 3.1 Entry points and dialog

- **Switch to worktree…** in the card's ⋯ menu and next to the Workspace badge in the card sidebar's Details & workspace section ([CARD-DISPLAY-SPEC](CARD-DISPLAY-SPEC.md) §8, `client/task-metadata.tsx`). Shown for cards whose workspace is not a worktree.
- The dialog (from `tasks.switch-check`) shows:
  - **Branch**: editable, prefilled `kanban/<slug>-<hash>` (`generatedBranchName`, the switch's operation ID as seed).
  - **Base**: "{main branch} at {short sha}", the main checkout's HEAD.
  - **Copied**: "All uncommitted changes of the main checkout: {n} files ({m} new)". The list is folded. The main checkout is not changed.
  - **Handover**: as in §2.2.
  - **Old workspace**: "Archives the current workspace and its {n} sessions." (only its sessions when the card does not own it, §3.3 step 8)
  - Blockers and warnings (§3.2); **Switch** is disabled while a blocker remains.

### 3.2 Preflight `tasks.switch-check({ id, direction: "to_worktree" })`

Blockers:

- Card or project archived; card in Done or Cancelled.
- The card's workspace is already a worktree.
- The project is a linked multi-repo root ([PROJECT-PICKER-SPEC](PROJECT-PICKER-SPEC.md)) or its root is not a Git repository; the main checkout has a detached HEAD.
- A session of the card is running or initializing.
- The main checkout is in the middle of a merge, rebase, cherry-pick or revert.
- The untracked files to copy total more than 500 MB.

Warnings (shown, acknowledged by pressing Switch):

- No handover, or the handover is older than the card's last session turn.
- Sessions of other cards are running in the main checkout: changes they write after the snapshot are not copied.
- Untracked files to copy total more than 50 MB.
- Submodules with changes: they are not copied.

### 3.3 Run `tasks.switch({ id, revision, operationId, direction: "to_worktree", branchName })`

Serialized per project with release and integrate (§7.3). Idempotent by `operationId` like card creation (`server/service.ts` `createCard`): a retry reuses the created workspace.

1. Re-run the preflight; refuse on a changed card revision or a new blocker.
2. **Snapshot** the main checkout, read-only: HEAD commit `base`, `git diff --binary HEAD` (tracked changes including deletions and mode changes), and the untracked, not-ignored files (`git ls-files --others --exclude-standard -z`), copied byte for byte (symlinks stay symlinks). Ignored files (`node_modules`, `.flowly/`, build output) are not copied; the worktree setup script provides what a worktree needs.
3. **Export** the conversations of the card's sessions in its current workspace (SDK timeline: messages, tool names, files of edit/write calls), the latest card summary, and the handover.
4. **Create** the worktree workspace (`workspaces.create`, kind `worktree`, branch-off at `base`, title = card title). Then check that the worktree's HEAD is `base`; otherwise stop with an error naming the created workspace.
5. **Copy**: apply the snapshot diff in the worktree (working tree only, `git apply --binary`) and copy the untracked files. On failure stop with an error naming the workspace; the card is not moved.
6. **Write the handoff folder** (§3.4).
7. **Store write** (one transaction, compare-and-swap on the card revision): `workspaceId` = new workspace, `ownsWorkspace` = true, `previousWorkspaces` += old workspace (§8), `switch` record (§7.1) with `release: "pending"` (or `"none"` when the snapshot was empty), event `workspace_switched` ("{old kind} → worktree {branch}, {n} files copied"), and the handoff file as a card input artifact created by the user ([CARD-ARTIFACTS-SPEC](CARD-ARTIFACTS-SPEC.md)).
8. **Archive** the card's sessions in the old workspace and the old workspace itself, with the wrap-up rules (`server/wrapup.ts`): a workspace the card does not own (e.g. the project's main one) is never archived, only the card's sessions. Archiving a directory workspace deletes nothing on disk. A failure here is a warning: the card has already switched; the dialog says which session or workspace to archive in Paseo.

A failure before step 7 leaves the card unchanged and names any created workspace, as card creation does (PHASE-01-SPEC). Nothing in steps 1–8 writes to the main checkout.

### 3.4 Handoff folder

`<worktree>/.flowly/handoff/<switch id>/`, with `<worktree>/.flowly/.gitignore` = `*` created when missing (same rule as the project folder, [PROJECT-FOLDER-SPEC](PROJECT-FOLDER-SPEC.md)):

- `handoff.md` (registered as input): from/to workspace and branch, `base`, the main branch, the handover (files and notes, or "none"), the list of copied files, the files the card's sessions edited by edit/write calls (hint), files changed in the main checkout by other cards' sessions (by their edit/write calls; hint), the latest card summary, each old session's title, model and last assistant message, and the rules of §4.
- `sessions/<agent id>.md`: each old session's conversation as plain dialogue (messages, tool names, edited files), limited to 2 MB per session (head and tail kept).
- `snapshot.patch` and `untracked.txt`: what was copied.

### 3.5 What the next session sees

- Everything on the card as before: description, type, tags, lane, workpad, artifacts, ideas, links, summary, activity, memory.
- Its first instructions (`shared/scope.ts` `sessionContext`) gain one line while `switch.release` is `pending`: "This card moved from the main checkout to this worktree on {date}. The worktree holds a copy of ALL uncommitted changes of the main checkout, not only this card's. Read the handoff input first, trim the worktree to this card's changes, change nothing else, then ask the user to release." The rules of §4 follow in the skill.
- `flowly_get_task` returns `switch` (§7.1).

## 4. Trim (new session)

Guidance for the session that works in the worktree while `switch.release` is `pending` (skill, `SKILL.md`, turn checklist):

- First read the handoff. Keep exactly this card's changes (the handover's files and the hunks its notes name); revert everything else in the worktree (other cards' hunks, their untracked files). The worktree is the card's own; reverting there touches nobody else.
- Change nothing in this card's own lines before the release: the release removes from the main checkout exactly what the worktree holds, and edited lines no longer match the copy, so the release would be refused for them (§5.2).
- When trimmed, report it (`kind=result`) and ask the user to press **Release from main** on the card.
- If the handover is missing or unclear, use the transcripts and ask the user instead of guessing.

## 5. Release from main

A user-only action. It is the only step that removes changes from the main checkout.

### 5.1 Entry points and preflight `tasks.release-check({ id })`

- While `switch.release` is `pending`, the card sidebar shows a notice: "Release pending. The main checkout still holds a copy of this card's changes." with **Release from main…**; the ⋯ menu has the same entry.
- The preflight computes the **release patch** `R` = the diff from `base` to the worktree's working tree, including untracked files, built with a private index file (the worktree's own index and the main checkout's index are untouched).
- The dialog lists `R`'s files with added/removed line counts and the text "Removes exactly these changes from the main checkout. A backup is kept." Warnings:
  - a file in `R` that is not in the handover, or a handover file that is not in `R`;
  - a file in `R` that a session of another card edited (its edit/write calls);
  - `R` is empty: nothing to release (the run then only marks the release done).

Blockers:

- A session of the card is running or initializing (it may be editing `R`).
- The main checkout is mid-merge/rebase/cherry-pick/revert.
- `R` does not apply in reverse to the main checkout's working tree (`git apply -R --check`): those lines changed there, or the worktree already edited them. The dialog names the files.
- `R` does not apply forward to the main checkout's HEAD (checked in a private index): some of these lines were committed in the main checkout meanwhile.
- Some of `R`'s lines are staged in the main checkout's index in a way that cannot be reversed exactly (partly staged): "Unstage {file} in the main checkout first".

### 5.2 Run `tasks.release({ id, revision, operationId })`

Serialized per project (§7.3). Re-runs the preflight; refuses on a changed card revision, a changed `R` or a new blocker. Then:

1. Writes `R` to the handoff folder (`released.patch`) and to the plugin data folder (`releases/<task id>-<switch id>.patch`, kept until the card is deleted).
2. For files whose entry in the main checkout's index differs from HEAD, reverses `R`'s part in the index (`git apply -R --cached`); files whose index entry equals HEAD are left alone.
3. Reverses `R` in the main checkout's working tree (`git apply -R`). If this fails after step 2, step 2 is undone (forward apply to the index) and the release fails with the reason.
4. Store write: `switch.release` = `released`, `releasedAt`, event `changes_released` ("{n} files").

No stash, reset, checkout or commit in the main checkout. Other cards' changes in the same files stay, line for line.

### 5.3 Undo `tasks.release-undo({ id, revision, operationId })`

While `switch.release` is `released` and nothing was integrated yet, the ⋯ menu offers **Undo release**: `R` is applied forward to the main checkout's working tree (checked first; the index is not changed), `switch.release` returns to `pending`, event `release_undone`. Refused with the file list when it no longer applies.

## 6. Integrate: `flowly_integrate`

An agent tool for any worktree card, not only switched ones. Agents integrate only on the user's request, like committing (INTEGRATED-STAGE-SPEC §3). It does the git work in the main checkout; the agent then sets `integrated` as before (and says whether it pushed). CLI: `integrate --request-file … [--ref <ref>]`.

- Input: `expectedRevision`, signed `request`, optional `ref` (default: the card's worktree branch; e.g. `origin/main` after its merge request was merged remotely and fetched).
- Refusals (each with a code and what to do):
  - `RELEASE_PENDING`: the main checkout still holds a copy of this card's changes; ask the user to release first.
  - `NOT_WORKTREE`, `DETACHED_HEAD`, `CHECKOUT_BUSY` (merge/rebase/cherry-pick/revert in progress), `GIT_BUSY` (index lock held after a short retry).
  - `REBASE_NEEDED`: the main branch is not an ancestor of `ref`. "Rebase your branch onto {main branch} in your worktree, rerun the checks, then call again."
  - `CONFLICT`: the change does not apply to the main checkout's working tree or index because uncommitted changes there touch the same lines; lists the files.
- Already integrated (`ref` is an ancestor of the main branch): returns `integrated: true, commits: 0`, no change.
- Run, serialized per project (§7.3): `D` = `git diff --binary HEAD <ref>` in the main checkout; check `D` against index and working tree; apply to the index, then the working tree; then `git update-ref refs/heads/<main branch> <ref sha> <old HEAD>` (compare-and-swap). A failure after a partial step reverses what was applied and refuses. Result: `{ integrated: true, from, to, commits, files, uncommitted }`, where `uncommitted` counts the worktree's uncommitted changes, which are not part of it. Event `branch_integrated`; no card revision change, no status change.
- Afterwards the main checkout's HEAD contains the card's commits, its working tree and index show only what was uncommitted before (other cards' work), and nothing looks reverted.

## 7. Data, RPC and concurrency

### 7.1 Card record (`shared/model.ts` `taskSchema`, all optional)

- `previousWorkspaces`: `{ id, kind, directory, branch?, switchedAt }[]`, oldest first, at most 10 (older entries leave the list, not Paseo).
- `handover`: `{ agentId, at, files: string[], notes: string }`.
- `switch`: `{ id, at, direction: "to_worktree" | "to_local", base?, mainBranch?, branch?, release: "none" | "pending" | "released", releasedAt?, integratedAt? }`. Only the latest switch is kept; the events keep the history. `integratedAt` is set by a successful `flowly_integrate` and ends **Undo release** (§5.3).

No board version bump: the fields are optional, and SQLite stores cards as JSON rows.

### 7.2 RPCs (`shared/rpc.ts`) and tools

- `tasks.switch-check` and `tasks.switch` (both directions, by `direction`), `tasks.ask-handover` (§2.2), `tasks.release-check` (returns a `patchHash` of the release patch), `tasks.release` (takes that `patchHash` and refuses when the patch changed), `tasks.release-undo`. Inputs are strict objects; writes take `revision` and `operationId`.
- Agent tools (`shared/tools.ts`, `server/tool-server.ts`, CLI in `server/cli-source.ts`): `flowly_handover`, `flowly_integrate`. The release has no agent tool.
- Events: `handover_written`, `workspace_switched`, `changes_released`, `release_undone`, `branch_integrated`, each with its own Activity label in the card sidebar.

### 7.3 Concurrency

- One per-project lock serializes switch, release, release-undo and integrate.
- Other sessions keep working in the main checkout meanwhile. Every write to it is checked against its state at that moment (`--check` first, compare-and-swap for the ref), so a concurrent change makes the step refuse instead of overwriting.
- Git's own `index.lock`: a short retry, then `GIT_BUSY`.

## 8. History of earlier workspaces

A card works in one workspace at a time; its earlier ones stay as read-only history. A helper `cardWorkspaceIds(task)` (current + `previousWorkspaces`) is used where history belongs:

- archived sessions on the card and the archived-session refs (`server/archived-sessions.ts`);
- per-card cost, usage and habit attribution (`server/insights.ts`, `server/workflow-insights.ts`);
- the session preview, read-only for sessions of an earlier workspace (`client/session-preview.tsx`).

Everything live stays on the current workspace only: the session list, composer, attention, card output, wrap-up, delete, restore, and Flowly tool access. Old sessions get `SESSION_MISMATCH` ("Card binding changed"), as today when a binding changes.

## 9. Switch to local (worktree → local)

The original request's other direction; rare in the use case above.

- **Switch to local…** in the same places, shown for worktree cards.
- Blockers: as in §3.2.
- Warnings:
  - The branch has commits that are not in the main branch: "They stay on {branch}; integrate first (flowly_integrate) to bring them into the main checkout."
  - `switch.release` is `pending`: the main checkout still holds the copy; nothing is removed.
- Uncommitted worktree changes (staged, unstaged or untracked) are neither a blocker nor a plain warning: the dialog offers four buttons (user decisions 2026-10-29), and the run refuses without a choice.
  - **Copy changes and switch**: the changes and untracked files are applied to the main checkout's working tree as unstaged changes; its index is not touched. The preflight sorts each file of the patch (below): it applies cleanly, the main checkout already holds it (for example an unreleased copy from the earlier switch to worktree), or it conflicts. Copy is disabled while any file conflicts or a merge/rebase is in progress there; files already there are skipped.
  - **Overwrite changes and switch**: as Copy, and each conflicting file of the main checkout becomes the worktree's file (removed when the worktree deleted it). The main checkout's versions of those files are saved first to `main-before/` in the handoff folder and to `<data>/releases/<task>-<switch>-main-before/`. Only the conflicting files are replaced, so other cards' changes in files that apply cleanly stay.
  - **Discard changes and switch**: nothing reaches the main checkout; the changes stay in the archived worktree, whose folder Paseo may remove.
  - **Cancel**.
  - Either way, before anything moves, the run saves them as `git diff --binary` of the worktree's working tree against its HEAD (private index, untracked files included) to `worktree-uncommitted.patch` in the handoff folder and to `<data>/releases/<task>-<switch>-uncommitted.patch`. `handoff.md` says which option was chosen, names the HEAD commit and lists the copied and overwritten files, or how to restore them (`git apply` in a checkout of the branch at that commit); the `workspace_switched` note counts them. Copy and overwrite run right after the patch is saved, before the workspace is created; a retry finds the copied files already there and skips them.
  - The patch is split into one piece per file and checked in a few `git apply --check` runs whatever the number of files (a fresh `vendor/` folder holds thousands).
- Run: create a directory workspace at the project root (as for a local card), steps 3, 7 and 8 of §3.3 (export, store write with `direction: "to_local"` and `release: "none"`, archive the worktree workspace and its sessions; Paseo may remove the worktree folder, the branch is kept), handoff folder at `<root>/.flowly/handoff/<task id>/<switch id>/`. The context line names the branch when it holds commits that are not integrated.

### 9.1 Side by side

The Switch to local dialog compares the worktree with the main checkout (user request 2026-10-29):

- **Branches**: the worktree's branch and the main checkout's branch, each with how many of its commits the other lacks and its last 5 commits (short hash, subject, age).
- **Changed files**, to give an idea of the kind of changes (user request 2026-10-30): one row per folder cut at the first two directory levels (`vendor/composer/` for `vendor/composer/installed.php`, `docs/` for `docs/guide.md`; a top-level file is its own row), with how many of its files changed in the worktree and in the main checkout and what Copy does with the worktree's (the number of conflicts, else copies or already there). Folders with conflicts come first, then folders changed on both sides, then worktree only, then main checkout only. A summary line counts the files. The server sends up to 300 rows; the dialog shows 40 and a *Show all* button, and says when rows were left out.

## 10. Guidance and constraints

### 10.1 `AGENTS.md` (to add with the implementation)

- Product invariant "One card corresponds to one workspace … Card edits do not create additional workspaces" gains: "A user-confirmed switch (WORKSPACE-SWITCH-SPEC) moves the card to a new workspace; the earlier one is archived and kept as read-only history."
- New exception: "Exception, explicit only: **Switch to worktree** copies the main checkout's uncommitted changes into a new worktree for the card and archives the card's previous workspace (only its sessions when the card does not own it); the main checkout is not changed. **Release from main** (user-confirmed) removes exactly the diff the card's worktree holds from the main checkout's working tree, and from its index where those lines are staged, after checking that it applies exactly; a backup patch allows undo. **Switch to local** with *Copy* (user-chosen) applies the worktree's uncommitted changes to the main checkout's working tree only, after checking per file that they apply cleanly (files already there are skipped, any conflict refuses the copy); with *Overwrite* (user-chosen) the worktree's version also replaces each conflicting file after the main checkout's version is saved to the handoff folder; a patch of the changes is saved first. **`flowly_integrate`** (agent, only on the user's request) applies the card's branch to the main checkout's index and working tree and moves the main branch with a compare-and-swap, refusing when it does not apply cleanly. None of them stash, reset, check out or merge in the main checkout. See `docs/WORKSPACE-SWITCH-SPEC.md`."
- The commit recipe in "Before opening the PR / The working tree is shared" keeps working for cards that stay local. Its final step (move `main` with `git reset origin/main`) is wrong after a release, because the main checkout no longer holds the card's lines. A note points worktree cards to `flowly_integrate` with `ref: origin/<main>`.

### 10.2 Skill and tool descriptions

- `flowly_handover`: when asked for a handover, or before the user switches the card.
- After a switch: §4.
- Integration (INTEGRATED-STAGE-SPEC §3): "integrate with `flowly_integrate` on the user's request; on `REBASE_NEEDED` rebase in the worktree, rerun checks, call again; on `RELEASE_PENDING` ask the user to release; then set `integrated`."

## 11. UI and text

- Switch dialogs, the release notice and dialog, **Undo release**, and the handover row use existing dialog, notice and list components, Reduce Motion-aware like the wrap-up dialog (`client/wrapup.tsx`). Success uses toasts: "Card moved to worktree {branch}. Start a session to continue.", "Released {n} files from the main checkout."
- Every new string goes into all catalogs ([I18N-SPEC](I18N-SPEC.md)). Agent-facing text and daemon errors stay English.

## 12. Non-goals

- Selecting the card's changes in the shared checkout at switch time; using the git index or a `paseo.json` script for the copy.
- Moving or forking live sessions (Paseo cannot), starting a session automatically, or using the internal daemon connection.
- Stash, reset, checkout, merge or commit in the main checkout by Flowly.
- Pushing, opening merge requests, or integrating without the user's request.
- Switching from one worktree to another, and switching linked multi-repo projects to a worktree.
- Copying ignored files or submodule changes.

## 13. Onboarding

The welcome tour's More features list gains "Move a card to its own worktree when local work gets tangled" (`client/onboarding.tsx`, [ONBOARDING-SPEC](ONBOARDING-SPEC.md)). No tip: the release notice explains the only non-obvious step. What's new is decided by the release that ships it.

## 14. Acceptance

- Switch to worktree on a local card in a main checkout holding this card's and another card's changes (a shared file, a new file each): the new worktree starts at the main checkout's HEAD and holds all of them; the main checkout is unchanged; the card is bound to the worktree, owns it, lists the old workspace in `previousWorkspaces`; the handoff file is a card input; the old workspace (when owned) and sessions are archived; no session starts.
- Each blocker of §3.2 refuses the switch with its reason; a retry with the same `operationId` creates no second workspace.
- Handover: `flowly_handover` stores files and notes, replaces the previous one, shows up in `get_task` and in `handoff.md`; **Ask for a handover** sends the fixed prompt to an idle session only.
- After trimming, release removes exactly the worktree's diff from the main checkout. The other card's lines in the shared file, its new file and its staged state stay. `released.patch` exists. **Undo release** restores the lines.
- Release is refused when a card line was edited in the worktree, when those lines changed or were committed in the main checkout, when they are partly staged, or while a card session runs.
- `flowly_integrate`: refuses with `RELEASE_PENDING`, `REBASE_NEEDED` and `CONFLICT` as described. After a successful call, the main branch is the card's commit, other uncommitted work in the main checkout is unchanged, nothing shows as reverted, and a second call returns `commits: 0`.
- Switch to local: shows both branches with their last 5 commits and the changes per folder (two levels) side by side; with uncommitted worktree changes, offers Copy (applied as unstaged changes, skipping files already there, refused on conflicts), Overwrite (Copy plus the worktree's version of each conflicting file, the main checkout's saved first) and Discard (main checkout unchanged); either way a patch that restores them on the branch is saved first. Warns about commits not in the main branch; binds a new directory workspace and archives the worktree.
- Old sessions are listed read-only on the card, their usage still counts for it, and their Flowly tools return `SESSION_MISMATCH`.
- All strings in every catalog; `npm run typecheck`, `npm test`.

## 15. Verification

- Unit tests for the git steps against temporary repositories, including the spike's scenario (two features in one file, an untracked file, a concurrent change in the main checkout, a partly staged file, a moved main branch).
- Live, by an independent session (AGENTS.md: `claude/claude-haiku-5-5`) on a throwaway project, both directions plus release and integrate, with the plugin reloaded only from a tree that typechecks (project memory: the plugin runs from the shared working tree).

## 16. Rollback

An older Flowly drops the new optional card fields on its next write of that card. A switched card stays bound to its worktree. Its earlier workspaces disappear from its history. A pending release can no longer be done from the UI, so release before downgrading; otherwise the main checkout keeps its copy of the card's changes until someone removes them by hand. Release backups (`released.patch`) stay in the plugin data folder for a manual undo.
