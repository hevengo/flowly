# Agent card tools: live check (AGENT-CARDS-SPEC)

2026-10-29, Paseo 0.14.0-beta.2, plugin loaded from the shared working tree at 7495a7c plus uncommitted changes (load 23:42:45Z, includes all of this card's server code). Run by the implementing session (card "create cards via ai agent"), not an independent verifier.

## Fixture

- Flowly project *paseo-playground* (`fa991850-…`, native `prj_809babad6b9a5f68`), no cards before the run.
- Temporary workspace `wks_fe128fb2b4f904b5` (directory, project folder) and session `a168c35f-e7cd-47c3-a0d9-22809f701e3f` (claude/claude-haiku-5-5, bypassPermissions): a session outside any card.

## Results

| Check | Result |
|---|---|
| Session outside cards gets the `flowly-board` MCP server from `agent.session_open` | pass: tools `mcp__flowly-board__flowly_{list,get,create,update}_card`, no card tools |
| `flowly_list_cards` | pass: project paseo-playground, 0 cards, then 1 |
| `flowly_create_card` | pass: card `719bbc43-…` in Backlog, revision 1, own new workspace `wks_eeb1e8bbbd79b6b8` (directory, `ownsWorkspace`) |
| Same `idempotencyKey` again | pass: `replayed: true`, same card, no second workspace |
| `flowly_get_card` | pass: full card, `editable: true` |
| `flowly_update_card` (title, priority, Backlog→Todo, add tag) | pass: `changed: [title, priority, status, tags]`, revision 2 |
| Board attribution | pass: `created`, `status_changed` (note *Changed title, priority*), `tags_changed`, `edited` all `actor: agent` with the session's agentId; tags `by: agent` with agentId; no links |
| Stale revision refused | pass, from the card session: `REVISION_CONFLICT` (current revision=9), nothing written. The test session's own step used the current revision by mistake and wrote "stale write" (revision 3) |
| Work-stage card moved to Todo refused (`STATUS_FORBIDDEN`) | not run live: the probe was blocked by this session's permission classifier. Covered by `server/agent-cards.test.ts` |
| `status: development` | refused by the tool's input schema (Backlog/Todo only) before reaching the server |

Observation: the session's first call failed with *MCP server flowly-board is not connected* and worked on the retry; the provider was still connecting the HTTP server when the first turn began.

## Cleanup

`tasks.delete-check` (no blockers or warnings), then `tasks.delete` with `archive: true` (backup in plugin-data `removed/`, card workspace archived); session and temporary workspace archived. Afterwards: no cards in paseo-playground, no active workspaces in its native project, the only session created is archived.
