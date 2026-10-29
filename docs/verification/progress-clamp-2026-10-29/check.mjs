// Drawer Progress card clamp (TASK-SUMMARY-SPEC §7): the Progress card collapses at 240 pt instead of 104 pt.
// At the default window every card of this project should show its whole summary with no Show more; in a narrow
// window the same summaries wrap past 240 pt and must still collapse to 240 pt with the fade and Show more / Show less.
// Every card here has workpad acceptance criteria, so none shows Target; the narrow window is the "taller than the
// clamp" case. Cards are only opened and read; nothing is saved (the drawer is never dragged).
//   node docs/verification/progress-clamp-2026-10-29/check.mjs
import { writeFile } from 'node:fs/promises';
import { launch, open, shot } from '../../promo/shot-lib.mjs';

const project = 'paseo-flowly-hevengo';
const shotCard = 'switch local and worktree'; // the card in the user's screenshot
const h = 1000;
// With the user's saved drawerShare (0.5531 of the Flowly area, window minus the 320-point host sidebar) these give
// drawers of about 708, 640 and 431 points.
const windows = { wide: 1600, default: 1477, narrow: 1100 };
const clamp = 240;
const out = new URL('./', import.meta.url).pathname;

// The drawer width and the Progress card: the clamp view (nearest overflow-hidden ancestor of the "Recap" label),
// its content's natural height and whether the footer row under it has a Show more / Show less button.
const progress = (page) =>
  page.evaluate(() => {
    const grip = document.querySelector('[aria-label="Drag to resize task details"]');
    const drawer = grip ? Math.round(grip.parentElement.getBoundingClientRect().width - grip.getBoundingClientRect().width) : null;
    const recap = [...document.querySelectorAll('div')].find((el) => !el.children.length && el.textContent.trim() === 'Recap' && el.getBoundingClientRect().width > 0);
    if (!recap) return { drawer, found: false };
    let box = recap.parentElement;
    while (box && getComputedStyle(box).overflow !== 'hidden') box = box.parentElement;
    if (!box) return { drawer, found: false };
    const footer = box.nextElementSibling;
    const toggle = footer && [...footer.querySelectorAll('[role="button"]')].map((b) => b.getAttribute('aria-label')).find((l) => l === 'Show more' || l === 'Show less');
    return {
      drawer,
      found: true,
      visible: Math.round(box.getBoundingClientRect().height),
      natural: Math.round(box.firstElementChild.getBoundingClientRect().height),
      toggle: toggle || null,
    };
  });

async function openCard(s, title) {
  await s.page.keyboard.press('Escape');
  await s.page.getByRole('button', { name: `Open task ${title}` }).first().click();
  await s.page.locator('[aria-label="Drag to resize task details"]').first().waitFor({ timeout: 30000 });
  await s.page.waitForTimeout(1200);
}

const browser = await launch();
const result = { project, clamp, windows, h, cards: {}, toggle: null };
const errors = [];
const failures = [];
try {
  for (const [name, w] of Object.entries(windows)) {
    const s = await open(browser, { w, h, project });
    // The label is "Open task <title>. <ideas>. Progress: <state>. …"; no title in this project has a period.
    const titles = await s.page.getByRole('button', { name: /^Open task / }).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('aria-label').replace(/^Open task /, '').split('. ')[0]))]);
    for (const title of titles) {
      await openCard(s, title);
      const p = await progress(s.page);
      (result.cards[title] ??= {})[name] = p;
      if (!p.found) continue;
      const overflows = p.natural > clamp + 8;
      // Fits: shown in full, no toggle. Overflows: collapsed to the clamp with Show more.
      if (!overflows && (p.toggle || Math.abs(p.visible - p.natural) > 1)) failures.push(`${name} ${title}: fits (${p.natural}) but visible ${p.visible}, toggle ${p.toggle}`);
      if (overflows && (p.toggle !== 'Show more' || Math.abs(p.visible - clamp) > 1)) failures.push(`${name} ${title}: overflows (${p.natural}) but visible ${p.visible}, toggle ${p.toggle}`);
      if (title === shotCard) await shot(s, `${out}${name}-${shotCard.replaceAll(' ', '-')}.png`);
    }
    // In the narrow window, open the first collapsed card again and press Show more, then Show less.
    if (name === 'narrow') {
      const collapsed = Object.entries(result.cards).find(([, c]) => c.narrow?.toggle === 'Show more');
      if (!collapsed) failures.push('narrow: no card collapsed, so Show more / Show less was not exercised');
      else {
        await openCard(s, collapsed[0]);
        await shot(s, `${out}narrow-collapsed.png`);
        await s.page.getByRole('button', { name: 'Show more' }).first().click();
        await s.page.waitForTimeout(600);
        const expanded = await progress(s.page);
        await shot(s, `${out}narrow-expanded.png`);
        await s.page.getByRole('button', { name: 'Show less' }).first().click();
        await s.page.waitForTimeout(600);
        const again = await progress(s.page);
        result.toggle = { card: collapsed[0], expanded, collapsedAgain: again };
        if (expanded.toggle !== 'Show less' || Math.abs(expanded.visible - expanded.natural) > 1) failures.push(`Show more did not expand: ${JSON.stringify(expanded)}`);
        if (again.toggle !== 'Show more' || Math.abs(again.visible - clamp) > 1) failures.push(`Show less did not collapse: ${JSON.stringify(again)}`);
      }
    }
    await s.context.close();
    errors.push(...s.errors);
  }
} finally {
  await browser.close();
}
result.errors = errors;
result.failures = failures;
for (const name of Object.keys(windows)) {
  const rows = Object.values(result.cards).map((c) => c[name]).filter((p) => p?.found);
  result[`${name}Summary`] = { cards: rows.length, inFull: rows.filter((p) => !p.toggle).length, drawer: rows[0]?.drawer };
}
await writeFile(`${out}result.json`, JSON.stringify(result, null, 2) + '\n');
const summaries = Object.fromEntries(Object.keys(windows).map((name) => [name, result[`${name}Summary`]]));
console.log(JSON.stringify({ summaries, toggle: !!result.toggle, failures, errors }, null, 2));
process.exit(failures.length || errors.length ? 1 : 0);
