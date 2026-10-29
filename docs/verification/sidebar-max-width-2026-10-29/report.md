# Card sidebar width as a share of the Flowly area: in-app check (2026-10-29)

- Card: "unlock the sidebar max width" (`a68da9bc-d5be-439b-b115-50c4fc9d24ce`), session `61aff76b-8953-4564-9d50-90bc3e0e5dc2`.
- Tree: `9d1d9cf` plus uncommitted changes (this card's and other sessions'), loaded with `make reload` (typecheck exit 0, then `paseo plugin reload flowly`).
- Command: `node docs/verification/sidebar-max-width-2026-10-29/check.mjs` (exit 0). On this host shot-lib needs `PLAYWRIGHT_MODULE` set to a Playwright ≥ 1.58 and `PLAYWRIGHT_CHROMIUM_PATH` set to an installed `chrome-headless-shell`.
- Start state: the user's saved width was reset at their request, so `board-view.json` has no `drawerShare` and no `drawerWidth`.
- At 2400 × 1000 the Flowly area is 2080 points. The sidebar opened at 1040, which is 50% ([default.png](default.png)). Dragging the grip 300 px gave 1340, saved as `drawerShare` 0.6442 ([dragged.png](dragged.png)). A fresh page reopened at 1340 ([reopened.png](reopened.png)). At 1600 × 1000 (an area of 1280) it opened at 825, which is 0.6442 × 1280 and under the 968-point limit ([narrower.png](narrower.png)).
- `board-view.json` was put back to the reset state afterwards, and a fresh page opened at 50% again.
- Result: 8/8 checks pass, no page errors ([result.json](result.json)).
- Seen on the way, not caused by this change: on web the grip renders `role=slider` without `aria-valuenow`/`aria-valuemax`, because the host drops `accessibilityValue`.
