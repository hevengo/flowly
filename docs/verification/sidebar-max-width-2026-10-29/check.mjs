// Card sidebar width (wide layout): a share of the Flowly area, with no fixed 720-point maximum. Starting from a
// never-dragged sidebar it must open at 50%; dragging it 300 px wider saves the share; a fresh page restores it; and a
// narrower window gives the same share of its smaller area. Opens this card itself in its project (no Tinylink
// fixture on this host); the card is only read. The drag saves the host-scoped board-view drawerShare, so
// board-view.json is backed up first and put back in `finally`; a last fresh page checks the sidebar opens at 50% again.
//   node docs/verification/sidebar-max-width-2026-10-29/check.mjs
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, open, shot } from '../../promo/shot-lib.mjs';

const project = 'paseo-flowly-hevengo';
const card = 'unlock the sidebar max width';
const wide = 2400;
const narrow = 1600;
const h = 1000;
const dragBy = 300;
const out = new URL('./', import.meta.url).pathname;
const settingsFile = join(homedir(), '.paseo', 'plugin-settings', 'flowly', 'board-view.json');
const backup = process.env.BOARD_VIEW_BACKUP || join(tmpdir(), `flowly-board-view-${process.pid}.json`);
const stored = async () => JSON.parse(await readFile(settingsFile, 'utf8')).values;
const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

// The grip, the drawer column it sits in (drawer width plus the 8-point grip) and the Flowly area around both.
const grip = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[aria-label="Drag to resize task details"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const attr = (name) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : null);
    return {
      x: r.x, y: r.y, width: r.width, height: r.height,
      drawer: Math.round(el.parentElement.getBoundingClientRect().width - r.width),
      surface: Math.round(el.parentElement.parentElement.getBoundingClientRect().width),
      valueNow: attr('aria-valuenow'), valueMax: attr('aria-valuemax'),
    };
  });

async function openCard(browser, w) {
  const s = await open(browser, { w, h, project });
  // The board card by its label: the plain title also matches the host sidebar's workspace row.
  await s.page.getByRole('button', { name: `Open task ${card}` }).first().click();
  await s.page.locator('[aria-label="Drag to resize task details"]').first().waitFor({ timeout: 30000 });
  await s.page.waitForTimeout(800);
  return s;
}

const browser = await launch();
const result = { project, card, windows: { wide, narrow, h } };
const errors = [];
await copyFile(settingsFile, backup);
try {
  const before = await stored();
  result.storedBefore = { drawerShare: before.drawerShare ?? null, drawerWidth: before.drawerWidth ?? null };

  const s = await openCard(browser, wide);
  result.opened = await grip(s.page);
  await shot(s, `${out}default.png`);
  const g = result.opened;
  await s.page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await s.page.mouse.down();
  for (let i = 1; i <= 18; i++) await s.page.mouse.move(g.x + g.width / 2 - (dragBy * i) / 18, g.y + g.height / 2);
  await s.page.mouse.up();
  await s.page.waitForTimeout(1500);
  result.dragged = await grip(s.page);
  await shot(s, `${out}dragged.png`);
  await s.context.close();
  errors.push(...s.errors);
  result.storedAfterDrag = (await stored()).drawerShare;

  const again = await openCard(browser, wide);
  result.reopened = await grip(again.page);
  await shot(again, `${out}reopened.png`);
  await again.context.close();
  errors.push(...again.errors);

  const small = await openCard(browser, narrow);
  result.narrower = await grip(small.page);
  await shot(small, `${out}narrower.png`);
  await small.context.close();
  errors.push(...small.errors);
} finally {
  await copyFile(backup, settingsFile);
}
try {
  const last = await openCard(browser, wide);
  result.afterRestore = await grip(last.page);
  await last.context.close();
  errors.push(...last.errors);
} finally {
  await browser.close();
}
result.pageErrors = errors;

const share = result.storedAfterDrag;
result.checks = {
  opensAtHalf: near(result.opened.drawer, result.opened.surface / 2),
  draggedPast720: result.dragged.drawer > 720,
  draggedByFullAmount: near(result.dragged.drawer, result.opened.drawer + dragBy),
  savedAsShare: typeof share === 'number' && near(share * result.dragged.surface, result.dragged.drawer),
  restoredOnReopen: near(result.reopened.drawer, result.dragged.drawer),
  narrowerKeepsShare: result.narrower.surface < result.dragged.surface && near(result.narrower.drawer, Math.min(share * result.narrower.surface, result.narrower.surface - 312)),
  settingsPutBack: near(result.afterRestore.drawer, result.afterRestore.surface / 2),
  noPageErrors: errors.length === 0,
};
result.pass = Object.values(result.checks).every(Boolean);
await writeFile(`${out}result.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.pass ? 0 : 1;
