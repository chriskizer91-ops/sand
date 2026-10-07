// Opens the built game in headless Chromium as a laptop (1280x760, mouse and trackpad) and as
// a Pixel-sized phone (412x915, touch, DPR 2.625), plays a little, and checks what the player
// touches: starting, pouring, camera gestures that must never edit the land, every tool, the
// journal (and that it pauses time), cards, Look, settings, photo, save and load, watch mode,
// the checks page, low close-ups staying low, resizing never showing an empty screen, page
// errors, and the triangle and draw-call budgets (main and shadow pass on their own, at the
// detail tier the real laptop and phone draw).
//   node e2e/browser-check.mjs [--html dist/index.html]
// Headless Chromium draws with software (SwiftShader): frame rates mean nothing here and are
// never asserted. Screenshots and a JSON report go to e2e/output/.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAPTOP, PHONE, launch, openGame, root, setCamera, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const htmlArg = args.indexOf('--html');
const html = htmlArg >= 0 ? args[htmlArg + 1] : undefined;
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });

// Budgets (docs/ARCHITECTURE.md §7), each pass on its own: the page measures the shadow pass
// around three.js's shadow render, and the main pass is the rest of the frame.
const BUDGET = { mainTriangles: 350000, mainCalls: 80, shadowTriangles: 100000, shadowCalls: 20 };

const report = { steps: [], pass: true };
function step(name, ok, detail = '') {
  report.steps.push({ name, ok, detail });
  if (!ok) report.pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}
async function attempt(name, fn) {
  try {
    await fn();
  } catch (err) {
    step(name, false, `error: ${err.message.split('\n')[0]}`);
  }
}

const game = (page, fn, arg) => page.evaluate(fn, arg);
const cam = (page) => game(page, () => window.__game.camera.state);
const hash = (page) => game(page, () => window.__game.heightHash());
const heightAt = (page, x, z) => game(page, ([x, z]) => window.__game.fields.heightAt(x, z), [x, z]);
const project = (page, x, z) => game(page, ([x, z]) => window.__game.project(x, window.__game.fields.heightAt(x, z), z), [x, z]);
const wake = (page) => game(page, () => window.__game.wake());
/** Wait for a camera glide to finish (software drawing runs game time slower than real time). */
const glided = (page) => page.waitForFunction(() => !window.__game.camera.gliding, null, { timeout: 60000 });
const closeMenu = (page) => game(page, () => window.__game.closeMenu());
/**
 * Stop (or restart) the years and storms. With years running, beaches and cliffs keep shifting a
 * little, as they should, so any check that asks "did the land change?" holds the years first.
 * Lava and sand still move, so the ground can settle.
 */
const holdYears = (page, on) => game(page, (v) => window.__game.holdYears(v), on);

/** Wait until no lava is molten and the heights stop changing (so gesture checks start from a still world). */
async function settle(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const lava = await game(page, () => window.__game.lavaArea);
    const a = await hash(page);
    await sleep(1200);
    const b = await hash(page);
    if (lava === 0 && a === b) return true;
  }
  return false;
}

/**
 * Triangle and draw-call budgets at a few camera poses, measured at the detail the real device
 * draws (laptop: tier 2, phone: tier 1, both with shadows). Software drawing here is so slow
 * that the page's automatic governor would otherwise fall to the lightest tier, with no
 * shadows, and the check would measure that instead; so the graphics are held as set.
 */
async function budgets(page, label, tier, poses) {
  const held = await game(page, () => window.__game.holdQuality(true));
  step(`${label}: budgets are measured at the real detail`, held.tier === tier && held.shadows, `tier ${held.tier} (expected ${tier}), shadows ${held.shadows ? 'on' : 'off'}`);
  for (const [name, pose] of poses) {
    await setCamera(page, ...pose);
    await sleep(1200);
    const s = await game(page, () => window.__game.stats());
    const ok =
      s.mainTriangles <= BUDGET.mainTriangles &&
      s.mainCalls <= BUDGET.mainCalls &&
      s.shadowTriangles <= BUDGET.shadowTriangles &&
      s.shadowCalls <= BUDGET.shadowCalls &&
      s.tier === tier &&
      s.shadows;
    step(
      `${label}: budget at ${name}`,
      ok,
      `main pass ${s.mainTriangles} triangles, ${s.mainCalls} draws (≤ ${BUDGET.mainTriangles}, ${BUDGET.mainCalls}); ` +
        `shadow pass ${s.shadowTriangles} triangles, ${s.shadowCalls} draws (≤ ${BUDGET.shadowTriangles}, ${BUDGET.shadowCalls}); ` +
        `tier ${s.tier}, shadows ${s.shadows ? 'on' : 'off'}`,
    );
  }
  await game(page, () => window.__game.holdQuality(false));
}

const browser = await launch();

// ---------- laptop ----------
{
  const t0 = Date.now();
  const { ctx, page, errors } = await openGame(browser, LAPTOP, html);
  const mode = await game(page, () => window.__game.mode);
  step('Laptop: the game loads', true, `ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, island engine on ${mode === 'worker' ? 'a background thread' : 'the page'}`);
  await page.waitForSelector('.begin:not([disabled])', { timeout: 60000 });
  await page.screenshot({ path: join(out, 'bc-laptop-start.png') });
  await page.click('.begin');
  await sleep(1200);
  step('Laptop: Begin starts the game', await game(page, () => window.__game.started));

  await attempt('Laptop: pour lava with the mouse', async () => {
    const glow = await game(page, () => window.__game.glow);
    await setCamera(page, glow.x, glow.z, 260, -0.5, 0.9);
    await wake(page);
    await game(page, () => window.__game.selectTool('lava'));
    const h0 = await heightAt(page, glow.x, glow.z);
    const p = await project(page, glow.x, glow.z);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await sleep(800);
    await page.mouse.move(p.x + 6, p.y + 4, { steps: 3 });
    await sleep(800);
    await page.mouse.up();
    await sleep(1500);
    const h1 = await heightAt(page, glow.x, glow.z);
    step('Laptop: touching the glow pours lava (the land rises)', h1 > h0 + 0.3, `height ${h0.toFixed(1)} m → ${h1.toFixed(1)} m`);
    await page.screenshot({ path: join(out, 'bc-laptop-pour.png') });
    await holdYears(page, true);
    step('Laptop: the land settles after pouring', await settle(page));
  });

  await attempt('Laptop: camera gestures never edit', async () => {
    await wake(page);
    const h0 = await hash(page);
    await page.mouse.move(640, 380);
    const c0 = await cam(page);
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(18.5, 7);
      await sleep(40);
    }
    await sleep(500);
    const c1 = await cam(page);
    step('Laptop: two-finger swipe pans', Math.hypot(c1[0] - c0[0], c1[2] - c0[2]) > 5, `target moved ${Math.hypot(c1[0] - c0[0], c1[2] - c0[2]).toFixed(1)} m`);
    await page.keyboard.down('Control');
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -12);
      await sleep(40);
    }
    await page.keyboard.up('Control');
    await sleep(500);
    const c2 = await cam(page);
    step('Laptop: pinch zooms in', c2[3] < c1[3] * 0.95, `distance ${c1[3].toFixed(0)} m → ${c2[3].toFixed(0)} m`);
    await page.mouse.wheel(0, 100);
    await sleep(500);
    const c3 = await cam(page);
    step('Laptop: mouse wheel zooms out', c3[3] > c2[3] * 1.05, `distance ${c2[3].toFixed(0)} m → ${c3[3].toFixed(0)} m`);
    await page.mouse.move(640, 380);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(760, 420, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await sleep(500);
    const c4 = await cam(page);
    step('Laptop: right-drag turns and tilts', Math.abs(c4[4] - c3[4]) > 0.2, `turned ${(c4[4] - c3[4]).toFixed(2)} rad`);
    await page.mouse.click(700, 300, { button: 'right' });
    await sleep(200);
    step('Laptop: right-click glides there', await game(page, () => window.__game.camera.gliding));
    await glided(page);
    step('Laptop: no camera gesture changed the land', (await hash(page)) === h0);
  });

  await attempt('Laptop: tools', async () => {
    await holdYears(page, false);
    await wake(page);
    const picked = [];
    for (const t of ['lava', 'rock', 'sand', 'hands', 'scoop', 'look']) {
      await page.click(`.tool-${t}`);
      picked.push((await game(page, () => window.__game.tool)) === t);
    }
    step('Laptop: every tool can be chosen from the tray', picked.every(Boolean), picked.join(', '));
    await page.keyboard.press('3');
    step('Laptop: number keys choose tools', (await game(page, () => window.__game.tool)) === 'sand');
    const s0 = await game(page, () => window.__game.size);
    await page.click('.tool.size');
    const s1 = await game(page, () => window.__game.size);
    step('Laptop: the size button changes the size', s1 !== s0, `${s0} → ${s1}`);
  });

  await attempt('Laptop: journal', async () => {
    await wake(page);
    await page.click('.journal-btn');
    await page.waitForSelector('.journal.open');
    await sleep(1200);
    const pause = await game(page, () => window.__game.lastSent('pause'));
    const y0 = await game(page, () => window.__game.year);
    await sleep(2000);
    const y1 = await game(page, () => window.__game.year);
    step('Laptop: the journal opens and time stops', pause?.on === true && y1 === y0, `pause sent: ${pause?.on}, year ${y0} → ${y1}`);
    await page.screenshot({ path: join(out, 'bc-laptop-journal.png') });
    await page.click('.j-tab:nth-child(2)');
    await sleep(500);
    const cards = await page.locator('.gcard').count();
    step('Laptop: the field guide lists species', cards > 0, `${cards} cards`);
    await page.click('.j-tab:nth-child(3)');
    await sleep(800);
    await page.screenshot({ path: join(out, 'bc-laptop-chart.png') });
    await page.click('.j-close');
    await sleep(1200);
    const resumed = await game(page, () => window.__game.lastSent('pause'));
    const y2 = await game(page, () => window.__game.year);
    await sleep(2000);
    const y3 = await game(page, () => window.__game.year);
    step('Laptop: closing the journal lets time run again', !resumed?.on && y3 > y2 && !(await game(page, () => window.__game.journalOpen)), `year ${y2} → ${y3}`);
    await page.keyboard.press('j');
    await sleep(400);
    const open = await game(page, () => window.__game.journalOpen);
    await page.keyboard.press('j');
    await sleep(400);
    step('Laptop: J opens and closes the journal', open && !(await game(page, () => window.__game.journalOpen)));
  });

  await attempt('Laptop: a card tap glides the camera there', async () => {
    await setCamera(page, -300, 300, 300, -0.5, 1);
    await wake(page);
    // A card for a place (an arrival, a visit): cards for ages and firsts have no place, and
    // tapping those opens the journal instead.
    await page.waitForSelector('.card-slip.in[data-place="1"]', { timeout: 150000 });
    await page.screenshot({ path: join(out, 'bc-laptop-card.png') });
    const id = Number(await page.getAttribute('.card-slip.in[data-place="1"]', 'data-id'));
    const entry = await game(page, (id) => window.__game.journalEntries.find((e) => e.id === id), id);
    await page.click('.card-slip.in[data-place="1"]');
    await sleep(300);
    await glided(page);
    const c = await cam(page);
    const off = Math.hypot(c[0] - entry.x, c[2] - entry.z);
    step('Laptop: a card tap glides the camera there', off < 30 && Math.abs(c[3] - 150) < 20, `${off.toFixed(1)} m from the story's place, ${c[3].toFixed(0)} m away`);
  });

  await attempt('Laptop: Look', async () => {
    await holdYears(page, true);
    await settle(page);
    await setCamera(page, 40, -20, 280, -0.6, 0.9);
    await wake(page);
    await game(page, () => window.__game.selectTool('look'));
    const p = await project(page, 40, -20);
    const h0 = await hash(page);
    await page.mouse.click(p.x, p.y);
    await page.waitForSelector('.look-bubble.in', { timeout: 10000 });
    const words = (await page.textContent('.look-bubble .look-line')) ?? '';
    step('Laptop: Look answers with a sentence', words.trim().length > 3, `"${words.trim()}"`);
    await page.screenshot({ path: join(out, 'bc-laptop-look.png') });
    await sleep(800);
    step('Laptop: Look never changes the land', (await hash(page)) === h0);
    await holdYears(page, false);
  });

  await attempt('Laptop: settings change the pace', async () => {
    await wake(page);
    await page.click('.menu-btn');
    await page.click('text=Settings');
    await page.click('text=Brisk · 5 a second');
    await sleep(300);
    const m = await game(page, () => window.__game.lastSent('settings'));
    step('Laptop: settings change the pace (the engine is told)', m?.settings?.pace === 'brisk', JSON.stringify(m?.settings));
    await page.screenshot({ path: join(out, 'bc-laptop-settings.png') });
    await page.click('text=Normal · 2 a second');
    const stored = await game(page, () => JSON.parse(localStorage.getItem('wind-wing-wave:settings') ?? '{}').pace);
    step('Laptop: settings are remembered', stored === 'normal', `stored pace: ${stored}`);
    await page.click('.sheet-head button[aria-label="Close"]');
  });

  await attempt('Laptop: photo', async () => {
    await wake(page);
    await page.click('.menu-btn');
    const dl = page.waitForEvent('download', { timeout: 20000 });
    await page.click('text=Take a photo');
    const d = await dl;
    const path = join(out, 'bc-photo.png');
    await d.saveAs(path);
    step('Laptop: a photo is saved as a picture', statSync(path).size > 1000 && d.suggestedFilename().endsWith('.png'), `${d.suggestedFilename()}, ${statSync(path).size} bytes`);
  });

  await attempt('Laptop: save to a file and load it back', async () => {
    await wake(page);
    await holdYears(page, true);
    await settle(page);
    await game(page, () => (window.__before = new Float32Array(window.__game.fields.surf)));
    await page.click('.menu-btn');
    const dl = page.waitForEvent('download', { timeout: 30000 });
    await page.click('text=Save to a file');
    const d = await dl;
    const path = join(out, 'bc-sea.wwwsave');
    await d.saveAs(path);
    const bytes = statSync(path).size;
    step('Laptop: "Save to a file" gives a .wwwsave file', d.suggestedFilename().endsWith('.wwwsave') && bytes > 0, `${d.suggestedFilename()}, ${bytes} bytes`);
    await closeMenu(page);
    await page.click('.menu-btn');
    const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
    await page.click('text=Open a saved file');
    await (await chooser).setFiles(path);
    const toast = await page.waitForFunction(() => {
      const t = document.querySelector('.toast.show')?.textContent ?? '';
      return /Your sea is back|Couldn't open/.test(t) ? t : null;
    }, null, { timeout: 90000 });
    const words = await toast.jsonValue();
    await sleep(2500);
    // The save file keeps ground heights to 1/128 m, so the loaded ground may differ by a hair.
    const off = await game(page, () => {
      const a = window.__before, b = window.__game.fields.surf;
      let n = 0;
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 0.02) n++;
      return n;
    });
    step('Laptop: the saved file loads back to the same sea', /Your sea is back/.test(words) && off === 0, `"${words}", ${off} columns off by more than 2 cm`);
    await holdYears(page, false);
  });
  await closeMenu(page);

  await attempt('Laptop: watch mode', async () => {
    await setCamera(page, 40, -20, 300, -0.6, 0.9);
    await game(page, () => {
      window.__game.wake();
      window.__game.selectTool('lava');
      window.__game.goIdle();
    });
    await sleep(1000);
    const watching = await game(page, () => document.body.classList.contains('watching') && window.__game.watching);
    step('Laptop: after a minute without input the buttons fade (watch mode)', watching);
    await page.screenshot({ path: join(out, 'bc-laptop-watch.png') });
    await holdYears(page, true);
    await settle(page);
    const h0 = await hash(page);
    const p = await project(page, 40, -20);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await sleep(600);
    await page.mouse.up();
    await sleep(1500);
    const st = await game(page, () => ({ watching: window.__game.watching, tool: window.__game.tool }));
    step('Laptop: a touch brings the buttons back without pouring', !st.watching && (await hash(page)) === h0, `tool is now ${st.tool}`);
    await holdYears(page, false);
  });

  await attempt('Laptop: the checks page', async () => {
    await wake(page);
    await page.click('.menu-btn');
    await page.click('text=Run the checks on this device');
    await page.waitForSelector('.checks-summary.ok, .checks-summary.bad', { timeout: 180000 });
    const rows = await page.$$eval('.check-row', (els) => els.map((e) => ({ ok: !e.querySelector('.mark.bad'), label: e.querySelector('.check-label')?.textContent })));
    // Smoothness and time limits are measured on real devices only: software drawing here is
    // always slow, and a shared build machine can be twice as slow as the laptop the limits fit.
    const failed = rows.filter((r) => !r.ok && !/Smooth|microseconds|Lava speed|Sand speed|time budget/.test(r.label ?? ''));
    step('Laptop: the checks page runs and everything but smoothness passes here', rows.length > 5 && failed.length === 0, `${rows.length} rows${failed.length ? '; failed: ' + failed.map((r) => r.label).join(', ') : ''}`);
    await page.screenshot({ path: join(out, 'bc-laptop-checks.png') });
    await page.click('.sheet-head button[aria-label="Close"]');
  });

  await attempt('Laptop: a close-up on flat ground stays low', async () => {
    const asked = 0.25;
    await setCamera(page, -300, 255, 15, -1.2, asked);
    await sleep(800);
    const drawn = await game(page, () => {
      const c = window.__game.camera;
      const p = c.camera.position;
      return Math.atan2(p.y - c.target.y, Math.hypot(p.x - c.target.x, p.z - c.target.z));
    });
    const deg = (r) => ((r * 180) / Math.PI).toFixed(1);
    step('Laptop: a close-up on the flat cay stays low (never lifted into a top-down view)', Math.abs(drawn - asked) < 0.035, `asked for ${deg(asked)}°, drew ${deg(drawn)}°`);
    await page.screenshot({ path: join(out, 'bc-laptop-low-cay.png') });
  });

  await budgets(page, 'Laptop', 2, [
    ['the whole zone', [-20, 40, 1600, -0.3, 1.25]],
    ['the volcano', [40, -20, 420, -0.6, 0.9]],
    ['a low close-up on the volcano', [60, -10, 40, 0.9, 0.3]],
    ['a low close-up on the flat cay, facing the horizon', [-300, 255, 15, -1.2, 0.25]],
    ['the cay', [-260, 250, 150, -1.2, 0.6]],
  ]);
  step('Laptop: no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
}

// ---------- phone ----------
{
  const t0 = Date.now();
  const { ctx, page, errors } = await openGame(browser, PHONE, html);
  const mode = await game(page, () => window.__game.mode);
  step('Phone: the game loads', true, `ready in ${((Date.now() - t0) / 1000).toFixed(1)} s, island engine on ${mode === 'worker' ? 'a background thread' : 'the page'}`);
  await page.waitForSelector('.begin:not([disabled])', { timeout: 60000 });
  await page.screenshot({ path: join(out, 'bc-phone-start.png') });
  await page.tap('.begin');
  await sleep(1200);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });

  await attempt('Phone: pour with one finger', async () => {
    const glow = await game(page, () => window.__game.glow);
    await setCamera(page, glow.x, glow.z, 260, -0.5, 0.9);
    await wake(page);
    await game(page, () => window.__game.selectTool('lava'));
    const h0 = await heightAt(page, glow.x, glow.z);
    const p = await project(page, glow.x, glow.z);
    await touch('touchStart', [p]);
    await sleep(1500);
    await touch('touchEnd', []);
    await sleep(1500);
    const h1 = await heightAt(page, glow.x, glow.z);
    step('Phone: one finger pours lava on the glow', h1 > h0 + 0.3, `height ${h0.toFixed(1)} m → ${h1.toFixed(1)} m`);
    await holdYears(page, true);
    step('Phone: the land settles after pouring', await settle(page));
  });

  await attempt('Phone: a quick tap never shapes', async () => {
    await wake(page);
    const h0 = await hash(page);
    // Sent back to back (not awaited in between): software drawing makes each touch slow to be
    // acknowledged, which would otherwise turn the test's tap into a long press.
    await Promise.all([touch('touchStart', [{ x: 200, y: 500 }]), touch('touchEnd', [])]);
    await sleep(1500);
    step('Phone: a quick tap never shapes the land', (await hash(page)) === h0);
  });

  await attempt('Phone: two-finger gestures', async () => {
    await setCamera(page, 40, -20, 400, -0.6, 0.9);
    await wake(page);
    const h0 = await hash(page);
    const c0 = await cam(page);
    await touch('touchStart', [{ x: 150, y: 500 }, { x: 260, y: 500 }]);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', [{ x: 150 + i * 9, y: 500 - i * 6 }, { x: 260 + i * 9, y: 500 - i * 6 }]);
      await sleep(30);
    }
    await touch('touchEnd', []);
    await sleep(600);
    const c1 = await cam(page);
    const moved = Math.hypot(c1[0] - c0[0], c1[2] - c0[2]);
    step('Phone: two-finger drag pans', moved > 10 && Math.abs(c1[3] - c0[3]) < c0[3] * 0.05, `target moved ${moved.toFixed(1)} m`);

    await touch('touchStart', [{ x: 160, y: 460 }, { x: 250, y: 460 }]);
    for (let i = 1; i <= 10; i++) {
      await touch('touchMove', [{ x: 160 - i * 7, y: 460 }, { x: 250 + i * 7, y: 460 }]);
      await sleep(30);
    }
    await touch('touchEnd', []);
    await sleep(600);
    const c2 = await cam(page);
    step('Phone: pinch zooms in', c2[3] < c1[3] * 0.8, `distance ${c1[3].toFixed(0)} m → ${c2[3].toFixed(0)} m`);

    const at = (a) => [
      { x: 206 - 70 * Math.cos(a), y: 460 - 70 * Math.sin(a) },
      { x: 206 + 70 * Math.cos(a), y: 460 + 70 * Math.sin(a) },
    ];
    await touch('touchStart', at(0));
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', at(i * 0.07));
      await sleep(30);
    }
    await touch('touchEnd', []);
    await sleep(600);
    const c3 = await cam(page);
    step('Phone: two-finger twist turns the view', c3[4] - c2[4] > 0.4, `turned ${(c3[4] - c2[4]).toFixed(2)} rad`);

    await Promise.all([touch('touchStart', [{ x: 180, y: 300 }, { x: 220, y: 320 }]), touch('touchEnd', [])]);
    await sleep(150);
    step('Phone: a quick two-finger tap glides there', await game(page, () => window.__game.camera.gliding));
    await glided(page);
    step('Phone: two-finger gestures never change the land', (await hash(page)) === h0);
  });

  await attempt('Phone: tray and journal', async () => {
    await holdYears(page, false);
    await wake(page);
    const picked = [];
    for (const t of ['lava', 'rock', 'sand', 'hands', 'scoop', 'look']) {
      await page.tap(`.tool-${t}`);
      picked.push((await game(page, () => window.__game.tool)) === t);
    }
    step('Phone: every tool can be tapped in the tray', picked.every(Boolean));
    await page.screenshot({ path: join(out, 'bc-phone-tray.png') });
    await page.tap('.journal-btn');
    await page.waitForSelector('.journal.open');
    await sleep(800);
    await page.screenshot({ path: join(out, 'bc-phone-journal.png') });
    await page.tap('.j-close');
    await sleep(800);
    step('Phone: the journal opens and closes', !(await game(page, () => window.__game.journalOpen)));
  });

  await budgets(page, 'Phone', 1, [
    ['the volcano', [40, -20, 420, -0.6, 0.9]],
    ['a low close-up on the volcano', [60, -10, 40, 0.9, 0.3]],
    ['a low close-up on the flat cay, facing the horizon', [-300, 255, 15, -1.2, 0.25]],
  ]);

  // Last on the phone, because it stops the game's frame loop: the frame cap often skips
  // frames, and a canvas resized while no frame is drawn would show an empty screen. With the
  // loop held still, a rotation-like window change and a sharpness change must leave the
  // picture alone (the page resizes the canvas only right before it draws).
  await attempt('Phone: resizing between frames never shows an empty screen', async () => {
    await setCamera(page, 40, -20, 260, -0.6, 1.1);
    await sleep(1200);
    await game(page, () => {
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => raf(() => undefined);
    });
    await sleep(500);
    await page.setViewportSize({ width: 412, height: 860 });
    await game(page, () => window.__game.holdQuality(true));
    await sleep(400);
    const png = await page.screenshot({ path: join(out, 'bc-phone-resize-held.png') });
    // How much of the middle of the screen is the bare page background, #bfe3f2 (an empty canvas)?
    const bare = await game(page, async (b64) => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, Math.floor(img.height * 0.3), img.width, Math.floor(img.height * 0.4)).data;
      let n = 0;
      for (let p = 0; p < d.length; p += 4) if (Math.abs(d[p] - 191) < 4 && Math.abs(d[p + 1] - 227) < 4 && Math.abs(d[p + 2] - 242) < 4) n++;
      return n / (d.length / 4);
    }, png.toString('base64'));
    step('Phone: resizing between frames never shows an empty screen', bare < 0.5, `${(bare * 100).toFixed(1)}% of the middle of the screen is bare background`);
  });
  step('Phone: no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
}

await browser.close();
writeFileSync(join(out, 'browser-check.json'), JSON.stringify(report, null, 2));
const failed = report.steps.filter((s) => !s.ok);
console.log(`\n${report.steps.length - failed.length} of ${report.steps.length} browser checks passed.`);
if (failed.length) {
  console.log('Failed:\n' + failed.map((s) => `  - ${s.name}${s.detail ? ': ' + s.detail : ''}`).join('\n'));
  process.exitCode = 1;
}
