// Live check of the composer Speed chip (AGENT-SPEED-SPEC, card "show selected agent speed setting"):
// 1. this card's Claude Opus session in paseo-flowly-hevengo (fast_mode off);
// 2. the Codex session at Fast (service_tier "priority") of the temporary card from agent-speed-chip-codex.mjs,
//    only while that fixture exists (/tmp/flowly-speed-chip.json). A closed/archived Codex session is no substitute:
//    its snapshot carries no features or modes, so it shows neither a Speed nor a Permissions chip.
// Read-only: nothing is typed or sent. Screenshots and report.json go to docs/verification/agent-speed-chip/.
// Usage: [ONLY_CODEX=1] node docs/verification/agent-speed-chip-shots.mjs
//   ONLY_CODEX=1 skips the Claude part (step 1) and checks only the Codex fixture.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launch, open, shot, pageText } from '../promo/shot-lib.mjs';

const out = new URL('./agent-speed-chip/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PROJECT = 'paseo-flowly-hevengo';
const report = { at: new Date().toISOString(), steps: [] };
const step = (name, ok, detail = '') => {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
// Composer chips in DOM order, by their accessibility labels.
const chips = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="button"][aria-label]')]
      .map((el) => el.getAttribute('aria-label'))
      .filter((l) => /^(Model|Reasoning|Speed|Permissions): /.test(l)),
  );
const chipText = (page, label) =>
  page.evaluate((label) => document.querySelector(`[role="button"][aria-label="${label}"]`)?.textContent || '', label);
// The composer strip: from the chip row's top edge, a fixed band under it.
const composerClip = async (s) => {
  const box = await s.page.locator('[role="button"][aria-label^="Model: "]').last().boundingBox();
  return { x: box.x - 40, y: box.y - 360, width: s.w - box.x + 40, height: 420 };
};

async function openSession(s, card, row) {
  await s.page.getByRole('button', { name: new RegExp(`^Open task ${card}`) }).first().click();
  await s.page.waitForTimeout(2500);
  await s.page.getByText(row).last().click();
  await s.page.locator('[role="button"][aria-label^="Model: "]').last().waitFor({ timeout: 20000 });
  await s.page.waitForTimeout(2500);
}

const browser = await launch();
try {
  // 1. Claude Opus 5.5 session, fast mode off: Model · Reasoning · Speed (Standard) · Permissions.
  const s = await open(browser, { w: 1700, h: 1000, project: PROJECT });
  if (!process.env.ONLY_CODEX) {
  await openSession(s, 'show selected agent speed setting', 'claude-opus-5-5');
  const claude = await chips(s.page);
  report.claudeChips = claude;
  step('Claude: Speed chip right after Reasoning', claude.findIndex((l) => l.startsWith('Speed: ')) === claude.findIndex((l) => l.startsWith('Reasoning: ')) + 1, claude.join(' | '));
  step('Claude: Speed chip reads Standard (fast mode off)', claude.includes('Speed: Standard'));
  const model = await chipText(s.page, claude.find((l) => l.startsWith('Model: ')));
  step('Claude: Model chip no longer repeats the speed', !/Fast/.test(model), model);
  const clip = await composerClip(s);
  await s.page.mouse.move(s.w / 2, 8);
  await shot(s, `${out}claude-chips.png`, clip);
  await s.page.locator('[role="button"][aria-label="Speed: Standard"]').last().click();
  await s.page.waitForTimeout(900);
  const menu = await pageText(s);
  step('Claude: Speed menu lists Standard and Fast with the cost note', menu.includes('Fast') && menu.includes('Lower latency Opus responses at higher token cost'));
  step('Claude: Speed menu is read-only with Change in Paseo', menu.includes('Plugins cannot switch the model or features like Fast mode yet.') && menu.includes('Change in Paseo'));
  // Menu items carry no aria-selected on web; the selected one is the only item with the check icon.
  const checked = await s.page.evaluate(() =>
    ['Standard', 'Fast'].filter((l) => [...document.querySelectorAll(`[role="button"][aria-label="${l}"]`)].some((el) => el.querySelector('svg'))),
  );
  step('Claude: Standard is the checked speed', checked.length === 1 && checked[0] === 'Standard', checked.join(', '));
  await shot(s, `${out}claude-speed-menu.png`, { ...clip, y: clip.y - 160, height: clip.height + 160 });
  await s.page.keyboard.press('Escape');
  }
  await s.context.close();

  // 2. The fixture's live Codex session at service_tier "priority": the chip reads Fast.
  const fixture = '/tmp/flowly-speed-chip.json';
  if (!existsSync(fixture)) {
    step('Codex: skipped, no fixture (run agent-speed-chip-codex.mjs setup first)', true);
    report.codexSkipped = true;
  } else {
  const fx = JSON.parse(readFileSync(fixture, 'utf8'));
  report.codexSession = fx.session;
  const c = await open(browser, { w: 1700, h: 1000, project: fx.projectTitle || PROJECT });
  await openSession(c, 'Speed chip check', 'Codex · Speed chip check');
  const codex = await chips(c.page);
  report.codexChips = codex;
  step('Codex: Speed chip right after Reasoning', codex.findIndex((l) => l.startsWith('Speed: ')) === codex.findIndex((l) => l.startsWith('Reasoning: ')) + 1, codex.join(' | '));
  step('Codex: Speed chip reads Fast (service_tier priority)', codex.includes('Speed: Fast'));
  const codexModel = await chipText(c.page, codex.find((l) => l.startsWith('Model: ')));
  step('Codex: Model chip no longer repeats the speed', !/Fast|Speed/.test(codexModel), codexModel);
  const codexClip = await composerClip(c);
  await c.page.mouse.move(c.w / 2, 8);
  await shot(c, `${out}codex-chips.png`, codexClip);
  await c.page.locator('[role="button"][aria-label="Speed: Fast"]').last().click();
  await c.page.waitForTimeout(900);
  const codexMenu = await pageText(c);
  step('Codex: Speed menu lists Normal, Fast and Ultrafast with the usage note', ['Normal', 'Fast', 'Ultrafast', 'Faster tiers increase usage.'].every((t) => codexMenu.includes(t)));
  const codexChecked = await c.page.evaluate(() =>
    ['Normal', 'Fast', 'Ultrafast'].filter((l) => [...document.querySelectorAll(`[role="button"][aria-label="${l}"]`)].some((el) => el.querySelector('svg'))),
  );
  step('Codex: Fast is the checked speed', codexChecked.length === 1 && codexChecked[0] === 'Fast', codexChecked.join(', '));
  await shot(c, `${out}codex-speed-menu.png`, { ...codexClip, y: codexClip.y - 200, height: codexClip.height + 200 });
  await c.page.keyboard.press('Escape');
  await c.context.close();
  }
} catch (e) {
  step('Script finished', false, String(e).split('\n')[0]);
} finally {
  writeFileSync(`${out}report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
