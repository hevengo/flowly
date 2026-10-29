# Committed stage

Status: requested by the user on card "commited stage" (2026-10-29): "add a new state and stage after review that indicates when the card's changes were already committed". Implemented.

## 1. Status

A new built-in status `committed`, default name **Committed**, placed right after In review:

```
backlog → todo → design → development → test → in_review → committed → blocked → done → cancelled
```

- Meaning: everything this card changed is committed. It says nothing about pushed or merged; the note of the move says that.
- It is not a work stage (`workStatuses` is unchanged) and not finished (Done/Cancelled stay the only finished statuses; wrap-up, the finished-card filters and summaries are unchanged).
- `deliveryStatuses = ["in_review", "committed"]` (`shared/model.ts`): the statuses an agent delivers into. Code that treated `in_review` as "the delivery" uses `isDeliveryStatus` instead (§3).
- Icon `GitCommitHorizontal` (lucide, shipped by the host), colour `statusSuccess`. Lane editor, board columns, phone status sheet, card status menu and the compact "first lane with cards" logic take it from `statuses` without special cases.

## 2. Stored lane configurations

`lanesSchema` (a project's lanes) keeps "one entry per built-in status". Data written before this change has 9 entries. Before validation, `completeLanes` inserts each missing status right after the nearest status that precedes it in the default order (Committed after In review), `enabled: true`, no custom name. Because it runs inside the schema, it covers every path that reads lanes: SQLite rows, `board.json` (all versions), project-folder imports and RPC input from a client that still sends 9 lanes. `projectLanes` uses the same helper instead of appending missing statuses at the end.

- No board version bump: nothing else in the data shape changes, and an older Flowly fails on the new status value either way (it keeps the data and reports the error; it never resets).
- The project row is rewritten with 10 lanes at its next write; until then the stored row stays as it was.
- Projects without a lane configuration get every default lane, Committed included.

## 3. Agents

- `agentStatuses` gains `committed`; `allowedStatuses` still lists only enabled lanes; `STATUS_UNAVAILABLE` when its lane is off. CLI: `status committed`, with `--outputs`/`--no-outputs`, `--moves`/`--no-moves` and `--acknowledge-open` like `status in_review`.
- A move into Committed is a delivery, same as In review: `outputs` are accepted and recorded atomically, a `moveTo:"done"` next move is accepted (NEXT-MOVES-SPEC §8.2 now says "with a delivery to In review or Committed"), the delivery reminders (next moves, ideas, outputs) apply, and the soft delivery gate runs when the status changes (WORKPAD_OPEN / SETUP_INCOMPLETE, WORKPAD-SPEC §5.3, CARD-SETUP-SPEC §3.4). The gate compares checks with the HEAD at the move, so checks that ran on the uncommitted tree are out of date after the commit: rerun them on the commit, or acknowledge with a note.
- The workpad's delivery snapshot and the card's "Delivered with n open items" mark follow the latest move into either delivery status.
- Guidance (skill, `SKILL.md`, turn checklist, tool description): set `committed` only after **all** of this card's changes are committed, normally on the user's commit request (agents never commit on their own); say in the note whether it was pushed. A follow-up that only commits, pushes or merges ends with `committed`, or with `integrated` once the commits are in the main checkout's branch ([INTEGRATED-STAGE-SPEC](INTEGRATED-STAGE-SPEC.md) §3); a partial commit stays in In review. The `moveTo:"done"` move still requires committed and pushed.
- Daemon does not check git for this: a project-root workspace is shared by several cards, so its dirty state says nothing about one card.

## 4. Status rules (AUTO-STATUS-SPEC)

- **A1**: a turn starting on a Committed card resumes like one on In review: → Development, or when Development is off the first enabled work stage (none enabled: no move).
- **A1r**: a turn that A1 resumed from Committed and that ends without any Kanban report returns the card to Committed (same conditions as for In review/Blocked).
- No rule moves a card into Committed.

## 5. Insights and memory

- Review rounds (`shared/workflow-stats.ts`) do not count In review → Committed: it is a step forward, not a bounce. In review → work stage is still the round; Committed → work stage is not counted as a review round.
- Agent habits count a move into either delivery status as a delivery. The memory clue for a message after a delivery is "feedback" after either status.
- Telemetry `c_deliveries` stays "agent moves into In review" (TELEMETRY-SPEC §4 unchanged; telemetry is built off in this fork).

## 6. Onboarding

The tour's lane strip (`Todo › Design › Development › Test › In review › Done`) shows the basic loop, not every lane, and stays as it is. No tip: the lane appears on every board by itself. No What's new entry here; the release that ships it decides (minor release rule in AGENTS.md).

## 7. Acceptance

- Default order and labels include Committed after In review; `statusLabels.committed` is translated in every catalog.
- 9-lane stored configurations load (SQLite, JSON, RPC input) with Committed inserted after In review, enabled; custom names and on/off of other lanes kept; a lane config that already has Committed is unchanged.
- Agent `status committed`: allowed when enabled, `STATUS_UNAVAILABLE` when off; outputs and `moveTo:"done"` accepted; gate refuses once with open items or missing setup; CLI accepts `status committed --outputs ... --moves ...`.
- A1 from Committed → Development; A1r restores Committed.
- Review rounds ignore In review → Committed.
- `npm run typecheck`, `npm test`.

## 8. Rollback

Older Flowly versions cannot read a board that has a Committed card or a 10-lane configuration. To go back: move Committed cards to In review or Done and remove `committed` from each project's lanes (or restore the daily backup from before the upgrade), then install the older version.
