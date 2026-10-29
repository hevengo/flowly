// Timeline Progress row starts open (NATIVE-SESSION-SPEC §5.3): in Paseo's own session view every flowly-summary row
// shows its whole summary with Show less and no fade; Show less collapses it to 104 pt with the fade and Show more
// opens it again. An open row is never capped before its first measurement, so it does not mount short and then
// jump (checked from a MutationObserver installed before the app loads, which sees each row as it is inserted).
// Uses the session of this project's "switch local and worktree" card; only Show less / Show more are pressed.
//   node docs/verification/progress-timeline-open-2026-10-29/check.mjs
import { writeFile } from 'node:fs/promises';
import { launch, open, shot } from '../../promo/shot-lib.mjs';

const project = 'paseo-flowly-hevengo';
const workspaceId = 'wks_b559a4acc6f0c3d6'; // "switch local and worktree"
const clamp = 104;
const out = new URL('./', import.meta.url).pathname;

// Installed before the app loads: the clamp view of a row (the nearest overflow-hidden ancestor of its Target / Recap /
// Next label), and a record of each row's clamp view the moment it is inserted, before React Native Web's first onLayout.
const install = () => {
  window.__clampBox = (row) => {
    const label = [...row.querySelectorAll('div')].find((el) => !el.children.length && ['Target', 'Recap', 'Next'].includes(el.textContent.trim()));
    let box = label && label.parentElement;
    while (box && box !== row && getComputedStyle(box).overflow !== 'hidden') box = box.parentElement;
    return box && box !== row ? box : null;
  };
  window.__rowsAtInsert = [];
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const row of document.querySelectorAll('[data-testid="session-summary-row"]')) {
      if (seen.has(row)) continue;
      seen.add(row);
      const box = window.__clampBox(row);
      if (!box) continue;
      window.__rowsAtInsert.push({ maxHeight: getComputedStyle(box).maxHeight, height: Math.round(box.getBoundingClientRect().height) });
    }
  }).observe(document, { childList: true, subtree: true });
};

const measure = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="session-summary-row"]')].map((row) => {
      const box = window.__clampBox(row);
      if (!box) return { found: false };
      const fade = box.children[1];
      const toggle = [...box.nextElementSibling.querySelectorAll('[role="button"]')].map((b) => b.getAttribute('aria-label')).find((l) => l === 'Show more' || l === 'Show less');
      return {
        found: true,
        visible: Math.round(box.getBoundingClientRect().height),
        natural: Math.round(box.firstElementChild.getBoundingClientRect().height),
        fade: fade ? Number(getComputedStyle(fade).opacity) : null,
        toggle: toggle || null,
      };
    }),
  );

const browser = await launch();
const failures = [];
const result = { workspaceId, clamp };
try {
  const s = await open(browser, { w: 1477, h: 1000, project });
  const { page } = s;
  const base = page.url().match(/^https:\/\/[^/]+\/h\/[^/]+/)?.[0];
  if (!base) throw new Error(`No host route in ${page.url()}`);
  await page.addInitScript(install);
  await page.goto(`${base}/workspace/${workspaceId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('[data-testid="session-summary-row"]').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);

  result.atInsert = await page.evaluate(() => window.__rowsAtInsert);
  for (const [i, r] of result.atInsert.entries()) if (r.maxHeight !== 'none') failures.push(`row ${i} was capped at insert (max-height ${r.maxHeight})`);

  result.mounted = await measure(page);
  if (!result.mounted.length) failures.push('no Progress row rendered');
  for (const [i, r] of result.mounted.entries()) {
    if (!r.found) { failures.push(`row ${i}: no clamp view`); continue; }
    if (Math.abs(r.visible - r.natural) > 1) failures.push(`row ${i} mounted at ${r.visible} of ${r.natural} pt`);
    if (r.natural > clamp + 8 && r.toggle !== 'Show less') failures.push(`row ${i} (${r.natural} pt) shows ${r.toggle} instead of Show less`);
    if (r.natural <= clamp + 8 && r.toggle) failures.push(`row ${i} (${r.natural} pt) fits but shows ${r.toggle}`);
    if (r.fade) failures.push(`row ${i} shows the fade while open`);
  }

  const rows = page.locator('[data-testid="session-summary-row"]');
  const last = rows.last();
  await last.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const clipOf = async () => {
    const b = await last.boundingBox();
    return { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 24 };
  };
  await shot(s, `${out}open.png`, await clipOf());

  const lastIndex = result.mounted.length - 1;
  if (result.mounted[lastIndex]?.toggle === 'Show less') {
    await last.getByRole('button', { name: 'Show less' }).click();
    await page.waitForTimeout(500);
    result.collapsed = (await measure(page))[lastIndex];
    if (result.collapsed.visible !== clamp) failures.push(`Show less left the row at ${result.collapsed.visible} pt`);
    if (result.collapsed.toggle !== 'Show more') failures.push(`after Show less the toggle reads ${result.collapsed.toggle}`);
    if (result.collapsed.fade !== 1) failures.push(`after Show less the fade is at ${result.collapsed.fade}`);
    await shot(s, `${out}collapsed.png`, await clipOf());

    await last.getByRole('button', { name: 'Show more' }).click();
    await page.waitForTimeout(500);
    result.reopened = (await measure(page))[lastIndex];
    if (Math.abs(result.reopened.visible - result.reopened.natural) > 1) failures.push(`Show more opened the row to ${result.reopened.visible} of ${result.reopened.natural} pt`);
    if (result.reopened.toggle !== 'Show less') failures.push(`after Show more the toggle reads ${result.reopened.toggle}`);
  } else failures.push('the last row has no Show less to press');

  result.pageErrors = s.errors;
  if (s.errors.length) failures.push(`${s.errors.length} page error(s)`);
} finally {
  await browser.close();
}
result.failures = failures;
await writeFile(`${out}result.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(failures.length ? 1 : 0);
