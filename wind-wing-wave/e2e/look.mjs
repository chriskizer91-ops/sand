// A set of screenshots for the visual review: the start screen, the god view, close-ups,
// night, a storm, the journal's tabs, the menu, settings and checks, and the phone layouts.
//   node e2e/look.mjs [--html dist/index.html] [--only name,name]
// Screenshots go to e2e/output/look-*.png. Headless Chromium draws with software
// (SwiftShader), so frame rates mean nothing here; the render stats are printed for budgets.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LAPTOP, PHONE, launch, openGame, root, setCamera, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const html = opt('html');
const only = opt('only')?.split(',');
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });

const browser = await launch();
const errors = [];

async function shot(page, name, note = '') {
  if (only && !only.includes(name)) return;
  const path = join(out, `look-${name}.png`);
  await page.screenshot({ path });
  const s = await page.evaluate(() => window.__game.stats());
  const pass = (t, c) => `${String(t).padStart(7)} tris ${String(c).padStart(3)} calls`;
  console.log(`${name.padEnd(18)} main ${pass(s.mainTriangles, s.mainCalls)} · shadow ${pass(s.shadowTriangles, s.shadowCalls)} · tier ${s.tier}  ${note}`);
}

/** Wait until an arrival card is on screen (the stand-in engine sends one every 25 s). */
async function waitForCard(page) {
  await page.waitForSelector('.card-slip.in', { timeout: 45000 });
  await sleep(700);
}

async function begin(page) {
  await page.click('.begin');
  await sleep(1500);
}

// ---------- laptop ----------
{
  const { ctx, page, errors: errs } = await openGame(browser, LAPTOP, html);
  await page.waitForSelector('.begin:not([disabled])');
  await sleep(800);
  await shot(page, 'start', 'start screen');
  await begin(page);

  await setCamera(page, -20, 40, 1600, -0.3, 1.25);
  await shot(page, 'god-view', 'the whole zone from above');

  await page.evaluate(() => window.__game.previewFirstMinute());
  await sleep(2500);
  await shot(page, 'glow', 'first minute: "Touch the glow."');
  await page.evaluate(() => window.__game.wake());

  await setCamera(page, 40, -20, 420, -0.6, 0.95);
  await waitForCard(page);
  await shot(page, 'tray-card', 'tray and an arrival card');

  await setCamera(page, 60, -10, 120, 0.9, 0.42);
  await shot(page, 'island-close', 'island close-up');

  await setCamera(page, -300, 255, 60, -1.2, 0.35);
  await shot(page, 'beach', 'the white cay close up');

  await setCamera(page, -300, 255, 15, -1.2, 0.25);
  await sleep(600);
  await shot(page, 'beach-low', 'standing on the cay: a low view toward the horizon');

  // Look: tap the volcano with the eye.
  await setCamera(page, 40, -20, 300, -0.6, 0.9);
  await page.evaluate(() => {
    window.__game.wake();
    window.__game.selectTool('look');
  });
  const p = await page.evaluate(() => window.__game.project(40, window.__game.fields.heightAt(40, -20), -20));
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('.look-bubble.in', { timeout: 10000 });
  await sleep(500);
  await shot(page, 'look-bubble', 'Look tool answer');

  await page.evaluate(() => window.__game.setDayPhase(0.86));
  await sleep(1200);
  await shot(page, 'night', 'night (if the sky package draws it)');
  await page.evaluate(() => window.__game.setDayPhase(0.3));

  await page.evaluate(() => window.__game.openJournal('story'));
  await sleep(900);
  await shot(page, 'journal-story', 'journal: Story');
  await page.evaluate(() => window.__game.openJournal('guide'));
  await page.click('.j-tab:nth-child(2)');
  await sleep(700);
  await shot(page, 'journal-guide', 'journal: Life & Places');
  await page.click('.j-tab:nth-child(3)');
  await sleep(1200);
  await shot(page, 'journal-chart', 'journal: Chart');
  await page.evaluate(() => window.__game.closeJournal());
  await sleep(600);

  await page.evaluate(() => window.__game.openMenu('menu'));
  await sleep(500);
  await shot(page, 'menu', 'menu');
  await page.evaluate(() => window.__game.openMenu('settings'));
  await sleep(400);
  await shot(page, 'settings', 'settings');
  await page.evaluate(() => window.__game.openMenu('help'));
  await sleep(400);
  await shot(page, 'help', 'help');
  await page.evaluate(() => window.__game.runChecks());
  await page.evaluate(() => window.__game.openMenu('checks'));
  await page.waitForSelector('.checks-summary.ok, .checks-summary.bad', { timeout: 120000 });
  await sleep(300);
  await shot(page, 'checks', 'checks on this device');
  await page.evaluate(() => window.__game.closeMenu());

  await page.evaluate(() => window.__game.stormNow());
  await setCamera(page, 40, -20, 380, -0.6, 0.85);
  await sleep(48000);
  await shot(page, 'storm', 'storm peak (if the weather package draws it)');
  errors.push(...errs.map((e) => 'laptop: ' + e));
  await ctx.close();
}

// ---------- phone (portrait) ----------
{
  const { ctx, page, errors: errs } = await openGame(browser, PHONE, html);
  await page.waitForSelector('.begin:not([disabled])');
  await sleep(600);
  await shot(page, 'phone-start', 'phone start screen');
  await page.tap('.begin');
  await sleep(1500);
  await setCamera(page, 40, -20, 380, -0.6, 0.95);
  await waitForCard(page);
  await shot(page, 'phone-play', 'phone: tray and a card');
  await page.evaluate(() => window.__game.openJournal('story'));
  await sleep(900);
  await shot(page, 'phone-journal', 'phone: journal');
  await page.tap('.j-tab:nth-child(2)');
  await sleep(600);
  await shot(page, 'phone-guide', 'phone: field guide');
  await page.evaluate(() => window.__game.closeJournal());
  await page.evaluate(() => window.__game.openMenu('settings'));
  await sleep(500);
  await shot(page, 'phone-settings', 'phone: settings');
  errors.push(...errs.map((e) => 'phone: ' + e));
  await ctx.close();
}

// ---------- phone held sideways ----------
{
  const { ctx, page, errors: errs } = await openGame(browser, { ...PHONE, viewport: { width: 915, height: 412 } }, html);
  await page.waitForSelector('.begin:not([disabled])');
  await page.tap('.begin');
  await sleep(1500);
  await setCamera(page, 40, -20, 380, -0.6, 0.95);
  await sleep(800);
  await shot(page, 'phone-landscape', 'phone held sideways');
  errors.push(...errs.map((e) => 'landscape: ' + e));
  await ctx.close();
}

await browser.close();
if (errors.length) {
  console.log('PAGE ERRORS:\n' + errors.join('\n'));
  process.exitCode = 1;
} else console.log(`No page errors. Screenshots in ${out}`);
