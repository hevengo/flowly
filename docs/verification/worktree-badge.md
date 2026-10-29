# Worktree / Local badge — visual check (CARD-DISPLAY-SPEC §8)

2026-10-29, card "badge for worktree vs local". Implementer session `f07f88fc-2813-499d-b331-8a8074623b4d` (not an independent verifier).

- Tree: `7495a7c` + uncommitted changes of the shared checkout (this card and other sessions' work); `npm run typecheck` exit 0 before the reload.
- `paseo plugin reload flowly` → running, no error.
- Shots: `docs/promo/shot-lib.mjs` (headless, sidebar cropped, other project tabs hidden) on project `paseo-flowly-hevengo`, 1700×1000. On this Mac it needed `PLAYWRIGHT_MODULE` (Playwright ≥ 1.64 for `local-network-access`) and `PLAYWRIGHT_CHROMIUM_PATH` (Chrome for Testing in `ms-playwright/chromium-1223`).

| Check | Result |
| --- | --- |
| Badge first in the meta row on the board | pass: 8 of 9 cards show `Local` (folder) as the first item; the 9th has no live workspace and shows none (its label has no kind either) |
| Worktree badge | pass in the Settings → Cards preview (`Worktree`, branch icon, first in the row); this project has no worktree cards, so not seen on a board card |
| Settings → Cards | pass: *Workspace* is the first Details switch, on by default |
| Switch hides the badge | pass: off → preview and board drop it (0 of 9); card accessibility labels keep `Workspace: Local` |
| Dark theme | pass: `Local` first on every live card |
| Setting restored | pass after a second run: the first script's restore step did not fire (the switch exposes no `aria-checked`), so the field stayed off until the restore run turned it back on; a fresh page load then showed 8 badges |

Screenshots in `worktree-badge/`: `board-light.png`, `board-dark.png`, `settings-cards.png`, `settings-cards-workspace-off.png`, `board-workspace-hidden.png`.

## Card sidebar (2026-10-29, second run)

- Tree: `1495afe` + uncommitted shared checkout; typecheck exit 0; `paseo plugin reload flowly` → running. Isolated (temp worktree of `1495afe` + only this card's hunks): typecheck exit 0, `npm test` exit 0, 141 files, 1209 passed, 1 skipped.
- Opened "badge for worktree vs local" (light and dark): the Status / Priority / Type row starts with `Local` (folder icon), accessibility label *Workspace: Local*, not a button; the next item is *Status: Test*. No page errors. Read-only run: no settings touched.
- Shots: `sidebar-light.png`, `sidebar-dark.png`.

Not covered: phone/compact layout.
