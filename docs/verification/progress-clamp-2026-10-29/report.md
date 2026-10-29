# Drawer Progress card collapses at 240 pt: in-app check (2026-10-29)

- Card: "make the progress box higher" (`e8be350e-f7c7-4496-a2eb-21f202f303ac`), session `92cb8c31-3aeb-47e3-97df-4e962d57a0bd`.
- Tree: `0c08d29` plus uncommitted changes (this card's and other sessions'), loaded with `make reload` (typecheck exit 0, then `paseo plugin reload flowly`). Another session committed its part as `6506ea7` during the run; the loaded code did not change.
- Command: `node docs/verification/progress-clamp-2026-10-29/check.mjs` (exit 0), with `PLAYWRIGHT_MODULE` set to Playwright 1.64 and `PLAYWRIGHT_CHROMIUM_PATH` set to `chrome-headless-shell` 1223.
- Method: open each of the 10 cards of project paseo-flowly-hevengo and measure the Progress card: the content's natural height, the visible height and whether Show more / Show less is shown. The user's saved `drawerShare` (0.5531) is used as is; the drawer is never dragged, so nothing is saved.
- Default window (1477 × 1000, drawer 640 pt): 10/10 summaries in full (167 pt), no Show more ([default-switch-local-and-worktree.png](default-switch-local-and-worktree.png), the card from the user's screenshot). Wide window (1600 × 1000, drawer 708 pt): the same, 10/10.
- Narrow window (1100 × 1000, drawer 431 pt): 8/10 in full (206–244 pt). "integrated stage" (263 pt) and "create cards via ai agent" (282 pt) collapse to 240 pt with the fade and Show more ([narrow-collapsed.png](narrow-collapsed.png)). Show more expands "integrated stage" to 263 pt with Show less ([narrow-expanded.png](narrow-expanded.png)); Show less collapses it to 240 pt again.
- Not covered: a summary that still shows Target. Every card on this host has workpad acceptance criteria, which hide Target, so the narrow window stands in for content taller than 240 pt.
- Result: 0 failures, no page errors ([result.json](result.json)).
