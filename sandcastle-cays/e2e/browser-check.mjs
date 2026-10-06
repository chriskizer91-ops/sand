// Opens the built game in a real (headless) Chromium, like you would on a laptop
// and on a Pixel phone, plays a little, takes screenshots, and runs the in-game checks.
//   node e2e/browser-check.mjs [path/to/game.html]
import { chromium, devices } from 'playwright-core';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = resolve(process.argv[2] ?? join(root, 'dist/index.html'));
const url = 'file://' + htmlPath;
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(existsSync);

const report = { steps: [], errors: [], checks: [], pass: true };
const step = (name, ok, detail = '') => {
  report.steps.push({ name, ok, detail });
  if (!ok) report.pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'],
});

function watchErrors(page, label) {
  page.on('pageerror', (e) => report.errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') report.errors.push(`${label} console: ${m.text()}`);
  });
}

async function waitReady(page, label) {
  const t0 = Date.now();
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const mode = await page.evaluate(() => window.__game.mode);
  step(`${label}: game loads`, true, `ready in ${secs}s, sand engine on the ${mode === 'worker' ? 'background thread' : 'page'}`);
  return mode;
}

async function drag(page, pts, steps = 6) {
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) {
    await page.mouse.move(pts[i].x, pts[i].y, { steps });
    await sleep(40);
  }
  await page.mouse.up();
}

const proj = (page, x, y, z) => page.evaluate(([x, y, z]) => window.__game.project(x, y, z), [x, y, z]);

// ---------- laptop ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  watchErrors(page, 'laptop');
  await page.goto(url);
  await waitReady(page, 'Laptop');
  await page.screenshot({ path: join(out, '01-start-screen.png') });
  await page.click('text=Start building');
  await sleep(1500);
  await page.screenshot({ path: join(out, '02-beach-overview.png') });

  // Dig a trench just above the waterline.
  await page.evaluate(() => window.__game.selectTool('dig'));
  const a = await proj(page, -1.2, 0.05, -0.7);
  const b = await proj(page, 1.2, 0.05, -0.7);
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10 });
  await drag(page, pts, 4);
  await drag(page, [...pts].reverse(), 4);
  await sleep(600);
  const dug = await page.evaluate(() => window.__game.hand);
  step('Dig scoops sand into your hands', dug > 0, `${((dug / 255) * 0.027).toFixed(1)} litres in hands`);

  // Pile it up behind the trench.
  await page.evaluate(() => window.__game.selectTool('pile'));
  const c = await proj(page, 0, 0.2, 0.6);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await sleep(4000);
  await page.mouse.up();
  await sleep(1500);
  const left = await page.evaluate(() => window.__game.hand);
  step('Pile pours sand from your hands', left < dug, `${((left / 255) * 0.027).toFixed(1)} litres left`);

  // Pat it a few times.
  await page.evaluate(() => window.__game.selectTool('pat'));
  const d = await proj(page, 0, 0.3, 0.6);
  for (let i = 0; i < 4; i++) {
    await page.mouse.click(d.x, d.y);
    await sleep(150);
  }
  await sleep(800);
  await page.screenshot({ path: join(out, '03-after-dig-pile-pat.png') });
  const undo = await page.evaluate(() => window.__game.undo);
  step('Undo is available after building', undo > 0, `${undo} steps to undo`);

  // Close-up of the work.
  await page.evaluate(() => window.__game.camera.setState([0.5, 0.55, 2.2, 0, 0.2, 0.2]));
  await sleep(1200);
  await page.screenshot({ path: join(out, '04-close-up.png') });

  // Trackpad: two-finger swipe swings the camera, pinch zooms.
  const before = await page.evaluate(() => window.__game.camera.state);
  await page.mouse.move(640, 380);
  await page.mouse.wheel(120, 0);
  await sleep(300);
  const after = await page.evaluate(() => window.__game.camera.state);
  step('Trackpad swipe swings the camera', Math.abs(after[0] - before[0]) > 0.05, `turned ${(after[0] - before[0]).toFixed(2)} rad`);

  // The in-game checks (same as the Checks page on your phone).
  const results = await page.evaluate(() => window.__game.runChecks());
  report.checks = results;
  const failed = results.filter((r) => !r.pass);
  step('In-game sand checks (in the browser)', failed.length === 0, `${results.length - failed.length}/${results.length} passed${failed.length ? ': ' + failed.map((f) => f.name + ' (' + f.detail + ')').join('; ') : ''}`);

  // Save and reload: the beach should come back.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(2500);
  await page.reload();
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
  const startText = await page.textContent('#start .big');
  step('Your beach is still there after closing and reopening', /Keep building/.test(startText ?? ''), `start button says "${startText}"`);
  await page.click('#start .big');
  await sleep(1500);
  await page.screenshot({ path: join(out, '05-after-reload.png') });
  await ctx.close();
}

// ---------- phone (Pixel 7 size, touch) ----------
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  watchErrors(page, 'phone');
  await page.goto(url);
  await waitReady(page, 'Phone');
  await page.screenshot({ path: join(out, '06-phone-start.png') });
  await page.tap('text=Start building');
  await sleep(1500);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });

  // One finger: dig a line.
  const a = await proj(page, -0.8, 0.05, -0.6);
  const b = await proj(page, 0.8, 0.05, -0.6);
  await touch('touchStart', [a]);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 }]);
    await sleep(50);
  }
  await touch('touchEnd', []);
  await sleep(600);
  const dug = await page.evaluate(() => window.__game.hand);
  step('Phone: one finger digs', dug > 0, `${((dug / 255) * 0.027).toFixed(1)} litres in hands`);

  // Two fingers: swing the camera; must not dig.
  const st0 = await page.evaluate(() => window.__game.camera.state);
  const h0 = dug;
  await touch('touchStart', [{ x: 150, y: 400 }, { x: 260, y: 420 }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: 150 + i * 12, y: 400 }, { x: 260 + i * 12, y: 420 }]);
    await sleep(30);
  }
  await touch('touchEnd', []);
  await sleep(500);
  const st1 = await page.evaluate(() => window.__game.camera.state);
  const h1 = await page.evaluate(() => window.__game.hand);
  step('Phone: two fingers swing the camera without digging', Math.abs(st1[0] - st0[0]) > 0.1 && h1 === h0, `turned ${(st1[0] - st0[0]).toFixed(2)} rad, sand in hands unchanged: ${h1 === h0}`);

  // Pinch to zoom in.
  await touch('touchStart', [{ x: 150, y: 450 }, { x: 260, y: 450 }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: 150 - i * 6, y: 450 }, { x: 260 + i * 6, y: 450 }]);
    await sleep(30);
  }
  await touch('touchEnd', []);
  await sleep(700);
  const st2 = await page.evaluate(() => window.__game.camera.state);
  step('Phone: pinch zooms in', st2[2] < st1[2], `distance ${st1[2].toFixed(1)} m → ${st2[2].toFixed(1)} m`);

  // Pile with one finger (hold still).
  await page.tap('button[aria-label="Pile"]');
  const c = await proj(page, 0, 0.2, 0.4);
  await touch('touchStart', [c]);
  await sleep(2500);
  await touch('touchEnd', []);
  await sleep(1200);
  await page.screenshot({ path: join(out, '07-phone-after-building.png') });
  const errs = report.errors.filter((e) => e.startsWith('phone'));
  step('Phone: no errors', errs.length === 0, errs.join(' | '));

  await ctx.close();
}

// ---------- backup mode, at phone speed ----------
// Some phones refuse background threads for downloaded files; then the sand runs on the page.
// Here we force that mode and slow the processor 4x (roughly a phone) to measure the engine.
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  watchErrors(page, 'backup');
  await page.goto(url + '#noworker');
  const mode = await waitReady(page, 'Backup mode (no background thread)');
  step('Backup mode is really on the page', mode === 'page', `mode: ${mode}`);
  await page.tap('text=Start building');
  await sleep(800);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate(() => {
    window.__perfMax = { sim: 0, mesh: 0, samples: 0 };
    window.__perfTimer = setInterval(() => {
      const p = window.__game.perf;
      if (!p) return;
      window.__perfMax.sim = Math.max(window.__perfMax.sim, p.simMs);
      window.__perfMax.mesh = Math.max(window.__perfMax.mesh, p.meshMs);
      window.__perfMax.samples++;
    }, 50);
  });
  // A big change all at once: a tower, a wall, two heaps collapsing and a hole.
  await page.evaluate(() => window.__game.demo());
  await sleep(8000);
  const perf = await page.evaluate(() => {
    clearInterval(window.__perfTimer);
    return window.__perfMax;
  });
  step(
    'Sand engine at phone speed (4x slower, a whole castle settling at once)',
    perf.samples > 0 && perf.sim < 20,
    `busiest physics step ${perf.sim.toFixed(1)} ms (budget 33 ms), surface rebuilding capped at ${perf.mesh.toFixed(1)} ms per frame`,
  );
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await page.screenshot({ path: join(out, '08-backup-mode-demo.png') });
  const errs = report.errors.filter((e) => e.startsWith('backup'));
  step('Backup mode: no errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

await browser.close();
const laptopErrs = report.errors.filter((e) => e.startsWith('laptop'));
step('Laptop: no errors', laptopErrs.length === 0, laptopErrs.join(' | '));
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(report.pass ? '\nALL BROWSER CHECKS PASSED' : '\nSOME BROWSER CHECKS FAILED');
process.exit(report.pass ? 0 : 1);
