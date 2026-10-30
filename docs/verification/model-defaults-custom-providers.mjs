// Live check of the agent picker suggestions for custom providers (MODEL-DEFAULTS-SPEC "Automatic approval default",
// card "improve model defaults in create task dialog"): in New task → Start an agent now, switching the provider to
// a custom Codex provider suggests Permissions = Auto-review and Speed = Fast, a custom Claude provider Auto mode;
// the built-in Codex and Claude keep theirs. Reasoning starts at Extra High (`xhigh`) where the model offers it
// (MODEL-DEFAULTS-SPEC "Reasoning default"), else the model's own default.
// Read-only: the form is cancelled, nothing is saved. If "Start an agent now" is off it is turned on and back off.
// Screenshots and report.json go to docs/verification/model-defaults-custom-providers/.
// Usage: node docs/verification/model-defaults-custom-providers.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { launch, open, shot } from '../promo/shot-lib.mjs';

const out = new URL('./model-defaults-custom-providers/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PROJECT = 'paseo-flowly-hevengo';
// Provider label in the picker → expected Permissions, Speed and Reasoning labels (speed null: absent or normal).
const CASES = [
  { slug: 'codex-connected', provider: 'Codex, Connected', mode: 'Auto-review', speed: 'Fast', thinking: 'xhigh' },
  { slug: 'claude-connected', provider: 'Claude Code, Connected', mode: 'Auto mode', speed: null, thinking: 'Extra High' },
  { slug: 'claude-glm-fast', provider: 'Claude Code, GLM 5.3', mode: 'Auto mode', speed: null, thinking: 'Model default (High)' },
  { slug: 'codex', provider: 'Codex', mode: 'Auto-review', speed: 'Fast', thinking: 'xhigh' },
  { slug: 'claude', provider: 'Claude', mode: 'Auto mode', speed: null, thinking: 'Extra High' },
];
const report = { at: new Date().toISOString(), steps: [], rows: {} };
const step = (name, ok, detail = '') => {
  report.steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
// Picker rows in DOM order, by their accessibility labels ("Provider: Codex", "Permissions: Auto-review", …).
const rows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="button"][aria-label]')]
      .map((el) => el.getAttribute('aria-label'))
      .filter((l) => /^(Provider|Model|Reasoning|Speed|Permissions): /.test(l)),
  );
const row = (list, title) => list.find((l) => l.startsWith(`${title}: `))?.slice(title.length + 2) ?? null;

async function choose(page, provider) {
  await page.locator('[role="button"][aria-label^="Provider: "]').first().click();
  await page.locator(`[role="button"][aria-label="Provider: ${provider}"]`).last().click();
}

// Waits until the rows settle on the expected labels (modes and features load after the switch).
async function settle(page, want) {
  let list = [];
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    list = await rows(page);
    const okMode = row(list, 'Permissions') === want.mode;
    const okSpeed = !want.speed || row(list, 'Speed') === want.speed;
    const okThinking = row(list, 'Reasoning') === want.thinking;
    if (row(list, 'Provider') === want.provider && okMode && okSpeed && okThinking) break;
  }
  await page.waitForTimeout(800);
  return rows(page);
}

const browser = await launch();
let turnedOn = false;
try {
  const s = await open(browser, { w: 1700, h: 1100, project: PROJECT });
  await s.page.getByRole('button', { name: /^New task/ }).first().click();
  await s.page.getByText('Start an agent now', { exact: true }).first().waitFor({ timeout: 15000 });
  // The switch has no aria-checked on web; it is on when the agent picker shows.
  const sw = s.page.locator('[role="switch"][aria-label="Start an agent now"]').first();
  await s.page.waitForTimeout(2000);
  if (!(await s.page.locator('[role="button"][aria-label^="Provider: "]').count())) {
    await sw.click();
    turnedOn = true;
  }
  await s.page.locator('[role="button"][aria-label^="Provider: "]').first().waitFor({ timeout: 20000 });
  await s.page.waitForTimeout(3000);
  report.initial = await rows(s.page);
  console.log('initial:', report.initial.join(' | '));
  await shot(s, `${out}00-initial.png`);

  // Start from a provider different from the first case, so every case is a real switch.
  for (const [i, c] of CASES.entries()) {
    if (row(await rows(s.page), 'Provider') === c.provider) {
      await choose(s.page, CASES[(i + 1) % CASES.length].provider);
      await s.page.waitForTimeout(1500);
    }
    await choose(s.page, c.provider);
    const list = await settle(s.page, c);
    report.rows[c.slug] = list;
    const mode = row(list, 'Permissions'), speed = row(list, 'Speed');
    step(`${c.provider}: Permissions = ${c.mode}`, mode === c.mode, list.join(' | '));
    step(`${c.provider}: Reasoning = ${c.thinking}`, row(list, 'Reasoning') === c.thinking, `Reasoning row: ${row(list, 'Reasoning') ?? 'absent'}`);
    if (c.speed) step(`${c.provider}: Speed = ${c.speed}`, speed === c.speed, `Speed row: ${speed ?? 'absent'}`);
    else report.steps.push({ name: `${c.provider}: Speed (info)`, ok: true, detail: `Speed row: ${speed ?? 'absent'}` });
    await shot(s, `${out}${String(i + 1).padStart(2, '0')}-${c.slug}.png`);
  }

  if (turnedOn) {
    await sw.click();
    await s.page.waitForTimeout(800);
  }
  await s.page.getByRole('button', { name: /^Cancel$/ }).last().click();
  await s.page.waitForTimeout(1000);
  report.pageErrors = s.errors;
  step('No page errors', s.errors.length === 0, s.errors.join(' / '));
  await s.context.close();
} finally {
  report.restoredStartAgentOff = turnedOn;
  writeFileSync(`${out}report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
const failed = report.steps.filter((x) => !x.ok).length;
console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed ? 1 : 0);
