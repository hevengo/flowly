# Timeline Progress row starts open: in-app check (2026-10-29)

- Card: "open progress card in chat view per default" (`84b3c5d1-5748-466c-ae35-cbc73a886280`), session `9ab9d6c9-242c-47a9-9222-7e92fe9027c0`.
- Tree: `3ea6ddf` plus uncommitted changes (this card's and other sessions'), loaded with `make reload` (typecheck exit 0, then `paseo plugin reload flowly`). The shared tree's unit tests passed first (1258 passed, 0 failed).
- Command: `node docs/verification/progress-timeline-open-2026-10-29/check.mjs` (exit 0), with `PLAYWRIGHT_MODULE` set to Playwright 1.64 and `PLAYWRIGHT_CHROMIUM_PATH` set to `chrome-headless-shell` 1223.
- Method: open the session of the card "switch local and worktree" (`wks_b559a4acc6f0c3d6`) in Paseo's own view at 1477 × 1000 and measure every rendered Progress row: its clamp view's visible and natural height, the fade and the toggle. A MutationObserver installed before the app loads records each row's clamp view as it is inserted, before the first measurement.
- At insert: both rows had no max-height and were already 288 pt, so an open row does not mount at 104 pt and then jump.
- Mounted: both rows 288 of 288 pt, fade 0, toggle "Show less" ([open.png](open.png)).
- Show less on the last row: 104 pt, fade 1, "Show more" ([collapsed.png](collapsed.png)). Show more: 288 of 288 pt, "Show less" again.
- Not covered: a row that fits in 104 pt (no toggle); every row in this session is taller. The drawer Progress card was not re-measured: it passes no `defaultOpen`, and the change in `Clamped` only affects a card that is open before its first measurement.
- Result: 0 failures, no page errors ([result.json](result.json)).
