// Opens the built game in a real (headless) Chromium, like you would on a laptop
// and on a Pixel phone, plays through the first-person game (aboard, swimming,
// beachcombing, building), takes screenshots, and runs the in-game checks.
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

const report = { steps: [], errors: [], checks: [], budgets: [], pass: true };
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
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 240000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const mode = await page.evaluate(() => window.__game.mode);
  step(`${label}: game loads`, true, `ready in ${secs}s, sand engine on the ${mode === 'worker' ? 'background thread' : 'page'}`);
  // Software drawing is slow: refresh the sky lighting rarely so the checks run at a usable pace.
  await page.evaluate(() => window.__game.envInterval(30));
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
const G = (page, fn, arg) => page.evaluate(fn, arg);
/** Wait until the game has drawn `n` more frames (software drawing is slow and uneven). */
async function waitFrames(page, n = 2) {
  const f0 = await page.evaluate(() => window.__game.frameCount);
  await page.waitForFunction((f) => window.__game.frameCount >= f, f0 + n, { timeout: 120000 });
}
/** Screenshots use the device's real graphics level; the rest of the test runs on "Fast" to keep it quick. */
async function shot(page, name) {
  const q = await page.evaluate(() => window.__realQuality);
  if (q) {
    await page.evaluate((q) => window.__game.setQuality(q), q);
    await waitFrames(page, 3);
  }
  await page.screenshot({ path: join(out, name), timeout: 180000 });
  if (q) await page.evaluate(() => window.__game.setQuality('low'));
}
async function goFast(page) {
  await page.evaluate(() => {
    window.__realQuality = window.__game.quality();
    window.__game.setQuality('low');
  });
}

/** Hold keys until a condition is true (or time runs out). */
async function holdUntil(page, key, cond, ms) {
  await page.keyboard.down(key);
  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(cond)) {
      ok = true;
      break;
    }
    await sleep(120);
  }
  await page.keyboard.up(key);
  return ok;
}

/** The ground find nearest to x, z. */
const nearestFind = (page, x, z) =>
  G(
    page,
    ([x, z]) => {
      let best = null;
      for (const g of window.__game.beach.state.ground) {
        const d = Math.hypot(g.x - x, g.z - z);
        if (!best || d < best.d) best = { ...g, d };
      }
      return best;
    },
    [x, z],
  );

/** Stand next to a find, looking at it. */
async function standBy(page, f) {
  await G(
    page,
    (f) => {
      const g = window.__game;
      // Stand 1.1 m inland of it, on the beach.
      const t = g.terrain;
      let best = null;
      for (let a = 0; a < 16; a++) {
        const x = f.x + Math.cos((a / 16) * Math.PI * 2) * 1.1;
        const z = f.z + Math.sin((a / 16) * Math.PI * 2) * 1.1;
        const h = t.heightAt(x, z);
        if (!best || h > best.h) best = { x, z, h };
      }
      g.teleport(best.x, best.z);
      g.lookAt(f.x, g.ground(f.x, f.z) + 0.02, f.z);
    },
    f,
  );
  await waitFrames(page, 3);
}

// ---------- laptop ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await ctx.newPage();
  watchErrors(page, 'laptop');
  await page.goto(url);
  await waitReady(page, 'Laptop');
  await shot(page, '01-start-screen.png');
  await page.click('#start .big');
  await waitFrames(page, 6);
  await goFast(page);
  await waitFrames(page, 2);
  const started = await G(page, () => window.__game.started && window.__game.view === 'fp' && window.__game.playerMode === 'deck');
  step('Laptop: you start aboard your boat, in first person', started);
  await G(page, () => window.__game.holdTime(true));
  await shot(page, '02-aboard-looking-at-island.png');

  // Look around with the mouse or trackpad.
  const yaw0 = await G(page, () => window.__game.player.yaw);
  const locked = await G(page, () => window.__game.input.locked);
  if (locked) {
    // The pointer is captured: the browser reports how far the mouse moved (the test can't make real ones).
    await G(page, () => {
      for (let i = 0; i < 10; i++) window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', movementX: 20, movementY: 0 }));
    });
  } else {
    await page.mouse.move(640, 380);
    await page.mouse.down();
    await page.mouse.move(840, 380, { steps: 10 });
    await page.mouse.up();
  }
  await waitFrames(page, 3);
  const yaw1 = await G(page, () => window.__game.player.yaw);
  step('Laptop: the mouse turns your head', Math.abs(yaw1 - yaw0) > 0.1, `turned ${(yaw1 - yaw0).toFixed(2)} rad (${locked ? 'pointer captured' : 'drag to look'})`);

  // Walk on the deck.
  const f0 = await G(page, () => window.__game.feet);
  await page.keyboard.down('KeyW');
  await waitFrames(page, 6);
  await page.keyboard.up('KeyW');
  const f1 = await G(page, () => window.__game.feet);
  const moved = Math.hypot(f1[0] - f0[0], f1[2] - f0[2]);
  step('Laptop: W walks you along the deck', moved > 0.3 && (await G(page, () => window.__game.playerMode)) === 'deck', `moved ${moved.toFixed(2)} m and still aboard`);

  // Walk to the stern and down the ladder into the water.
  await G(page, () => window.__game.aboard(Math.PI / 2, -0.2));
  await waitFrames(page, 3);
  // Software drawing is slow, so long walks run in even steps rather than holding the key.
  const walkUntil = async (x, y, mode, secs) => {
    for (let t = 0; t < secs; t += 0.5) if ((await G(page, ([x, y]) => window.__game.walk(0.5, x, y, false, true), [x, y])) === mode) return true;
    return (await G(page, () => window.__game.playerMode)) === mode;
  };
  const down = (await walkUntil(0, 1, 'climb', 10)) && (await walkUntil(0, 0, 'swim', 3));
  step('Laptop: walking to the stern ladder climbs you down into the sea', down);
  await waitFrames(page, 6);
  await shot(page, '03-swimming-by-the-boat.png');

  // Jump over the side: you land clear of the hull and can swim away (owner found you could get stuck).
  await G(page, () => {
    const g = window.__game;
    g.player.placeAboard(g.vec(0, 0.8, 1.15), 0);
    const out = g.sloop.group.localToWorld(g.vec(0, 0.8, 4)).sub(g.player.feet);
    g.player.yaw = Math.atan2(-out.x, -out.z);
    g.player.pitch = -0.1;
  });
  await waitFrames(page, 2);
  await page.keyboard.down('KeyW');
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Space');
    if (await G(page, () => window.__game.playerMode === 'swim')) break;
    await waitFrames(page, 4);
  }
  await page.keyboard.up('KeyW');
  const overboard = await G(page, () => window.__game.playerMode === 'swim');
  const fBefore = await G(page, () => window.__game.feet);
  await G(page, () => window.__game.walk(3, 0, 1));
  const fAfter = await G(page, () => window.__game.feet);
  const swamAway = Math.hypot(fAfter[0] - fBefore[0], fAfter[2] - fBefore[2]);
  step('Laptop: jumping over the side lands you in the sea, free to swim away', overboard && swamAway > 2, `${overboard ? 'in the water' : 'still aboard'}, swam ${swamAway.toFixed(1)} m in 3 s`);

  // Swim ashore to the cove.
  await G(page, () => window.__game.teleport(0, -16, Math.PI, -0.05));
  await waitFrames(page, 3);
  const swimming = (await G(page, () => window.__game.playerMode)) === 'swim';
  const ashore = await walkUntil(0, 1, 'land', 20);
  step('Laptop: you can swim and wade ashore onto the beach', swimming && ashore);
  await waitFrames(page, 3);
  await shot(page, '04-ashore-in-the-cove.png');

  // Beachcombing.
  const feet = await G(page, () => window.__game.feet);
  const find = await nearestFind(page, feet[0], feet[2]);
  let picked = false;
  if (find) {
    await standBy(page, find);
    const action = await G(page, () => window.__game.action());
    await page.keyboard.press('KeyE');
    await waitFrames(page, 3);
    const basket = await G(page, () => window.__game.basket);
    picked = basket.length === 1;
    step('Laptop: look at a find and press E to pick it up', picked, `prompt: "${action?.label}", basket now ${basket.join(', ')}`);
    await waitFrames(page, 3);
    await shot(page, '05-picked-up-a-find.png');
  } else step('Laptop: there are finds on the beach', false, 'none found');
  const nOnSand = await G(page, () => window.__game.beach.state.ground.length);
  step('Laptop: the sea has left finds along the beaches', nOnSand >= 8, `${nOnSand} finds lying on the sand`);

  // A close look at a few more finds.
  const f2 = await nearestFind(page, 20, 5);
  if (f2) {
    await standBy(page, f2);
    await shot(page, '06-a-find-on-the-sand.png');
  }

  // Kneel and build.
  await G(page, () => window.__game.teleport(0, 2.6, 0.03, -0.5));
  await waitFrames(page, 3);
  const canBuild = await G(page, () => window.__game.canBuildHere());
  await page.keyboard.press('KeyB');
  await waitFrames(page, 6);
  const building = (await G(page, () => window.__game.view)) === 'build';
  step('Laptop: on the cove’s sand, B kneels you down to build', canBuild && building);
  await page.evaluate(() => window.__game.selectTool('dig'));
  const a = await proj(page, -0.9, 0.1, 1.0);
  const b = await proj(page, 0.9, 0.1, 1.0);
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10 });
  await drag(page, pts, 4);
  await drag(page, [...pts].reverse(), 4);
  await waitFrames(page, 3);
  const dug = await G(page, () => window.__game.hand);
  step('Laptop: Dig scoops sand into your hands', dug > 0, `${((dug / 255) * 0.027).toFixed(1)} litres in hands`);
  await page.evaluate(() => window.__game.selectTool('pile'));
  const c = await proj(page, 0, 0.3, 1.7);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await sleep(3500);
  await page.mouse.up();
  await waitFrames(page, 6);
  const left = await G(page, () => window.__game.hand);
  step('Laptop: Pile pours sand from your hands', left < dug, `${((left / 255) * 0.027).toFixed(1)} litres left`);
  await page.evaluate(() => window.__game.selectTool('pat'));
  const d = await proj(page, 0, 0.35, 1.7);
  for (let i = 0; i < 4; i++) {
    await page.mouse.click(d.x, d.y);
    await sleep(150);
  }
  await waitFrames(page, 3);
  const undo = await G(page, () => window.__game.undo);
  step('Laptop: Undo is available after building', undo > 0, `${undo} steps to undo`);
  await shot(page, '07-building-in-the-cove.png');
  const before = await G(page, () => window.__game.camera.state);
  await page.mouse.move(640, 380);
  await page.mouse.wheel(120, 0);
  await waitFrames(page, 3);
  const after = await G(page, () => window.__game.camera.state);
  step('Laptop: while building, a trackpad swipe swings the camera', Math.abs(after[0] - before[0]) > 0.05, `turned ${(after[0] - before[0]).toFixed(2)} rad`);
  await page.keyboard.press('Escape');
  await waitFrames(page, 6);
  step('Laptop: Esc stands you back up', (await G(page, () => window.__game.view)) === 'fp');
  await shot(page, '08-standing-by-the-castle.png');

  // Back aboard by the ladder, and stow the finds.
  await G(page, () => {
    const g = window.__game;
    const p = g.sloop.points.ladderBottom.clone();
    g.sloop.group.localToWorld(p);
    g.teleport(p.x - 0.4, p.z, Math.PI / 2, 0);
  });
  await waitFrames(page, 3);
  const ladderPrompt = await G(page, () => window.__game.action());
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => window.__game.playerMode === 'deck', null, { timeout: 30000 }).catch(() => {});
  const aboard = (await G(page, () => window.__game.playerMode)) === 'deck';
  step('Laptop: E at the foot of the ladder climbs you aboard', aboard, `prompt: "${ladderPrompt?.label}"`);
  await G(page, () => {
    const g = window.__game;
    g.player.placeAboard(g.sloop.points.locker.clone(), g.player.yaw);
  });
  await waitFrames(page, 3);
  const lockerPrompt = await G(page, () => window.__game.action());
  await page.keyboard.press('KeyE');
  await waitFrames(page, 3);
  const st = await G(page, () => ({ basket: window.__game.basket.length, locker: Object.values(window.__game.beach.state.locker).reduce((a, b) => a + b, 0) }));
  step('Laptop: in the cockpit, E empties your basket into the locker', !picked || (st.basket === 0 && st.locker >= 1), `prompt: "${lockerPrompt?.label}", locker holds ${st.locker}`);

  // The logbook.
  await page.keyboard.press('KeyL');
  await waitFrames(page, 3);
  const logText = await page.textContent('#logbook');
  step('Laptop: L opens the logbook with what you found', /kinds found/.test(logText ?? '') && (!picked || /aboard/.test(logText ?? '')));
  await shot(page, '09-logbook.png');
  await page.keyboard.press('Escape');
  await waitFrames(page, 3);

  // Budgets: how much the graphics chip draws in a few views.
  const views = [
    ['aboard, looking at the island', () => window.__game.aboard(Math.PI, -0.05)],
    ['on the beach, looking along it', () => window.__game.teleport(-12, 6, Math.PI / 2 + 0.3, -0.15)],
    ['inland, among the palms', () => window.__game.teleport(10, 22, -Math.PI / 2, -0.05)],
  ];
  for (const [name, fn] of views) {
    await page.evaluate(fn);
    await waitFrames(page, 6);
    const r = await G(page, () => window.__game.render);
    report.budgets.push({ view: name, ...r });
    step(`Laptop: drawing budget, ${name}`, r.calls < 250 && r.triangles < 900000, `${r.calls} draws, ${Math.round(r.triangles / 1000)}k triangles (whole frame, all passes)`);
  }
  await shot(page, '10-inland.png');

  // ---- Sailing ----
  await G(page, () => window.__game.aboard(-Math.PI / 2, -0.05));
  await waitFrames(page, 3);
  const helmPrompt = await G(page, () => window.__game.action());
  await page.keyboard.press('KeyE');
  await waitFrames(page, 3);
  step('Laptop: in the cockpit, E takes the helm', await G(page, () => window.__game.atHelm), `prompt: "${helmPrompt?.label}"`);
  await page.keyboard.press('KeyW');
  await waitFrames(page, 2);
  await page.keyboard.press('KeyW');
  await waitFrames(page, 2);
  const up = await G(page, () => ({ set: window.__game.boat.sailSet, anchored: window.__game.boat.anchored }));
  step('Laptop: W raises the sails (and the anchor comes up)', up.set === 1 && !up.anchored, `sails ${up.set === 1 ? 'full' : up.set}, anchor ${up.anchored ? 'down' : 'up'}`);
  // Steer onto a reach and sail a little (even steps: software drawing is slow).
  const h0 = await G(page, () => window.__game.boat.heading);
  // Bear away to port (toward open water inside the reef), then sail on.
  await G(page, () => window.__game.sail(12, -1));
  const h1 = await G(page, () => window.__game.boat.heading);
  const run = await G(page, () => window.__game.sail(16, 0));
  step('Laptop: she turns when you steer and picks up speed under sail', Math.abs(h1 - h0) > 0.3 && run.speed > 1.2, `turned ${(h1 - h0).toFixed(2)} rad, ${(run.speed * 1.944).toFixed(1)} knots`);
  await waitFrames(page, 3);
  await shot(page, '12a-at-the-helm-under-sail.png');
  await G(page, () => window.__game.player.yaw = window.__game.player.yaw + Math.PI);
  await waitFrames(page, 3);
  await shot(page, '12b-looking-aft-wake.png');
  // The little outboard: sails down, motor ahead, then astern.
  await page.keyboard.press('KeyS');
  await waitFrames(page, 2);
  await page.keyboard.press('KeyS');
  await waitFrames(page, 2);
  await page.keyboard.press('KeyR');
  await waitFrames(page, 2);
  await page.keyboard.press('KeyR');
  await waitFrames(page, 2);
  const thr = await G(page, () => window.__game.boat.throttle);
  const motorRun = await G(page, () => window.__game.sail(14, 0));
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyF');
  await waitFrames(page, 2);
  const back = await G(page, () => window.__game.sail(10, 0));
  step('Laptop: R starts the outboard and motors her along; F slows and reverses', thr > 0.5 && motorRun.speed > 1.5 && back.speed < -0.4, `throttle ${thr}, ${(motorRun.speed * 1.944).toFixed(1)} knots ahead, then ${(back.speed * 1.944).toFixed(1)} knots`);
  await G(page, () => {
    const g = window.__game;
    g.boat.throttle = 0;
    g.sail(4, 0);
  });

  // The chart, and sailing there by herself.
  await page.keyboard.press('KeyM');
  await waitFrames(page, 3);
  const chartOpen = await page.isVisible('#chart');
  await shot(page, '12c-chart.png');
  const sailBtn = await page.$('#chart button:has-text("Pink Sand Cay")');
  if (sailBtn) await sailBtn.click();
  await waitFrames(page, 2);
  const courseName = await G(page, () => window.__game.course);
  step('Laptop: M opens the chart; "Sail to Pink Sand Cay" sets her going by herself', chartOpen && courseName === 'Pink Sand Cay', `course: ${courseName}`);
  await G(page, () => window.__game.leaveHelm());
  let arrived = null;
  for (let i = 0; i < 16 && !arrived; i++) {
    const r = await G(page, () => window.__game.sail(30));
    if (r.anchored) arrived = r;
  }
  const pinkA = { x: -258, z: -258 };
  step('Laptop: she sails through the gap in the reef to Pink Sand Cay and anchors', !!arrived && Math.hypot(arrived.x - pinkA.x, arrived.z - pinkA.z) < 60 && arrived.hull === 100, arrived ? `anchored ${Math.round(Math.hypot(arrived.x - pinkA.x, arrived.z - pinkA.z))} m from the anchorage, hull ${arrived.hull}%` : 'did not arrive');
  // Look from the boat toward the island.
  await G(page, () => {
    const g = window.__game;
    g.aboard(0, -0.05);
    const f = g.feet;
    g.player.yaw = Math.atan2(-(-210 - f[0]), -(-300 - f[2]));
  });
  await waitFrames(page, 4);
  await shot(page, '12d-arrived-at-pink-sand-cay.png');
  // Ashore on the pink beach: finds there too.
  const pinkFind = await nearestFind(page, -210, -300);
  if (pinkFind) {
    await standBy(page, pinkFind);
    await shot(page, '12e-pink-sand-beach.png');
  }
  step('Laptop: there are finds on Pink Sand Cay\'s beaches', !!pinkFind && Math.hypot(pinkFind.x + 210, pinkFind.z + 300) < 120, pinkFind ? `nearest: ${pinkFind.kind}` : 'none');
  // Running onto the reef scrapes the hull.
  const ground = await G(page, () => {
    const g = window.__game;
    const b = g.boat;
    b.x = 2; b.z = -60; b.heading = -Math.PI / 2; b.anchored = false; b.sailSet = 1; b.sail = 1; b.speed = 3; b.hull = 100;
    return g.sail(40, 0);
  });
  step('Laptop: sailing onto the reef runs her aground and scrapes the hull', ground.aground && ground.hull < 100, `aground: ${ground.aground}, hull ${Math.round(ground.hull)}%`);
  // Back home for the rest of the checks.
  await G(page, () => {
    const g = window.__game;
    const b = g.boat;
    b.x = 2; b.z = -31; b.heading = 0; b.speed = 0; b.sailSet = 0; b.sail = 0; b.anchored = true; b.ax = 8; b.az = -31; b.aground = false; b.hull = 100;
    g.sail(1);
    g.aboard(Math.PI, -0.05);
  });

  // Evening and night.
  await G(page, () => window.__game.teleport(-3, 1.5, Math.PI * 0.05, 0.02));
  await G(page, () => window.__game.setHour(19.35));
  await G(page, () => window.__game.envInterval(0.5));
  await waitFrames(page, 16);
  await shot(page, '11-golden-hour.png');
  await G(page, () => window.__game.setHour(22.5));
  await waitFrames(page, 16);
  await shot(page, '12-night.png');
  await G(page, () => window.__game.envInterval(30));
  await G(page, () => window.__game.setHour(9));

  // The in-game checks (same as the Checks page on your phone).
  const results = await page.evaluate(() => window.__game.runChecks());
  report.checks = results;
  const failed = results.filter((r) => !r.pass);
  step('In-game sand checks (in the browser)', failed.length === 0, `${results.length - failed.length}/${results.length} passed${failed.length ? ': ' + failed.map((f) => f.name + ' (' + f.detail + ')').join('; ') : ''}`);

  // Save and reload: the game should come back.
  const lockerBefore = await G(page, () => JSON.stringify(window.__game.beach.state.locker));
  await page.evaluate(() => window.__game.save());
  await waitFrames(page, 16);
  await page.reload();
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 240000 });
  await page.evaluate(() => window.__game.envInterval(30));
  const startText = await page.textContent('#start .big');
  const lockerAfter = await G(page, () => JSON.stringify(window.__game.beach.state.locker));
  step('Laptop: everything is still there after closing and reopening', /Carry on/.test(startText ?? '') && lockerAfter === lockerBefore, `start button says "${startText}", locker ${lockerAfter}`);
  await page.click('#start .big');
  await waitFrames(page, 6);
  await ctx.close();
}

// ---------- phone (Pixel 7 size, touch) ----------
{
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  watchErrors(page, 'phone');
  await page.goto(url);
  await waitReady(page, 'Phone');
  await shot(page, '13-phone-start.png');
  await page.tap('#start .big');
  await waitFrames(page, 6);
  await goFast(page);
  await waitFrames(page, 2);
  await G(page, () => window.__game.holdTime(true));
  await shot(page, '14-phone-aboard.png');
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0 })) });
  const vw = await G(page, () => window.innerWidth);
  const vh = await G(page, () => window.innerHeight);

  // Left thumb walks.
  await G(page, () => window.__game.teleport(-4, 2.5, Math.PI / 2, -0.1));
  await waitFrames(page, 3);
  const p0 = await G(page, () => window.__game.feet);
  const s0 = { x: vw * 0.2, y: vh * 0.75, id: 1 };
  await touch('touchStart', [s0]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [{ ...s0, y: s0.y - i * 6 }]);
    await sleep(40);
  }
  await waitFrames(page, 6);
  await touch('touchEnd', []);
  await waitFrames(page, 3);
  const p1 = await G(page, () => window.__game.feet);
  step('Phone: the left thumb walks you', Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 0.4, `moved ${Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2)} m`);

  // Right thumb looks (and doesn't walk).
  const y0 = await G(page, () => window.__game.player.yaw);
  const r0 = { x: vw * 0.7, y: vh * 0.5, id: 2 };
  await touch('touchStart', [r0]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ ...r0, x: r0.x - i * 8 }]);
    await sleep(30);
  }
  await touch('touchEnd', []);
  await waitFrames(page, 3);
  const y1 = await G(page, () => window.__game.player.yaw);
  const p2 = await G(page, () => window.__game.feet);
  step('Phone: the right thumb turns your head without walking', Math.abs(y1 - y0) > 0.2 && Math.hypot(p2[0] - p1[0], p2[2] - p1[2]) < 0.05, `turned ${(y1 - y0).toFixed(2)} rad`);

  // Tap a find to pick it up.
  const feet = await G(page, () => window.__game.feet);
  const find = await nearestFind(page, feet[0], feet[2]);
  if (find) {
    await standBy(page, find);
    const aim = await G(page, () => window.__game.action());
    const pos = await proj(page, find.x, await G(page, (f) => window.__game.ground(f.x, f.z) + 0.02, find), find.z);
    await touch('touchStart', [{ ...pos, id: 3 }]);
    await sleep(60);
    await touch('touchEnd', []);
    await waitFrames(page, 3);
    let basket = await G(page, () => window.__game.basket);
    let how = `a real touch, ${Math.round(await G(page, () => window.__game.input.lastPressMs))} ms long`;
    if (basket.length === 0) {
      // On this slow software-drawing machine a 60 ms touch can arrive stretched past the tap limit.
      // Try again with the touch's start and end delivered back to back, as a phone would.
      const held = Math.round(await G(page, () => window.__game.input.lastPressMs));
      await G(page, (p) => {
        const c = document.getElementById('view');
        c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 77, pointerType: 'touch', clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
        c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 77, pointerType: 'touch', clientX: p.x, clientY: p.y, bubbles: true, cancelable: true }));
      }, pos);
      await waitFrames(page, 3);
      basket = await G(page, () => window.__game.basket);
      how = `the test machine stretched the real touch to ${held} ms (over the 450 ms tap limit), so it was resent as a quick tap`;
    }
    step('Phone: tap a find to pick it up', basket.length === 1, `looking at: "${aim?.label}", ${how}, basket: ${basket.join(', ')}`);
    await shot(page, '15-phone-picked-up.png');
  } else step('Phone: there are finds to tap', false);

  // The action button kneels you down to build.
  await G(page, () => window.__game.teleport(0, 2.6, 0.03, -0.5));
  await waitFrames(page, 3);
  const btnVisible = await page.isVisible('#actionbtn');
  if (btnVisible) await page.tap('#actionbtn');
  await waitFrames(page, 6);
  step('Phone: on the cove’s sand the round button kneels you down to build', btnVisible && (await G(page, () => window.__game.view)) === 'build');
  const a = await proj(page, -0.6, 0.1, 1.1);
  const b = await proj(page, 0.6, 0.1, 1.1);
  await touch('touchStart', [a]);
  for (let i = 1; i <= 12; i++) {
    await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / 12, y: a.y + ((b.y - a.y) * i) / 12 }]);
    await sleep(50);
  }
  await touch('touchEnd', []);
  await waitFrames(page, 3);
  const dug = await G(page, () => window.__game.hand);
  step('Phone: one finger digs', dug > 0, `${((dug / 255) * 0.027).toFixed(1)} litres in hands`);
  const st0 = await G(page, () => window.__game.camera.state);
  await touch('touchStart', [{ x: 150, y: 400, id: 0 }, { x: 260, y: 420, id: 1 }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [{ x: 150 + i * 12, y: 400, id: 0 }, { x: 260 + i * 12, y: 420, id: 1 }]);
    await sleep(30);
  }
  await touch('touchEnd', []);
  await waitFrames(page, 3);
  const st1 = await G(page, () => window.__game.camera.state);
  const h1 = await G(page, () => window.__game.hand);
  step('Phone: two fingers swing the camera without digging', Math.abs(st1[0] - st0[0]) > 0.1 && h1 === dug, `turned ${(st1[0] - st0[0]).toFixed(2)} rad`);
  await shot(page, '16-phone-building.png');
  await page.tap('#standbtn');
  await waitFrames(page, 6);
  step('Phone: "Stand up" takes you back to first person', (await G(page, () => window.__game.view)) === 'fp');

  // In the water by the ladder, the button climbs you aboard.
  await G(page, () => {
    const g = window.__game;
    const p = g.sloop.points.ladderBottom.clone();
    g.sloop.group.localToWorld(p);
    g.teleport(p.x - 0.4, p.z, Math.PI / 2, 0);
  });
  await waitFrames(page, 3);
  const climbBtn = await page.isVisible('#actionbtn');
  if (climbBtn) await page.tap('#actionbtn');
  await page.waitForFunction(() => window.__game.playerMode === 'deck', null, { timeout: 30000 }).catch(() => {});
  step('Phone: by the ladder, the round button climbs you aboard', climbBtn && (await G(page, () => window.__game.playerMode)) === 'deck');
  await shot(page, '17-phone-back-aboard.png');
  // At the helm on the phone: the round button takes it, the thumb steers, buttons work the sails.
  await G(page, () => window.__game.aboard(-Math.PI / 2, -0.05));
  await waitFrames(page, 3);
  const helmBtn = await page.isVisible('#actionbtn');
  if (helmBtn) await page.tap('#actionbtn');
  await waitFrames(page, 3);
  const helmOk = await G(page, () => window.__game.atHelm);
  const moreSail = await page.$('#helmbar button:has-text("More sail")');
  if (moreSail) {
    await moreSail.tap();
    await waitFrames(page, 2);
  }
  const sailSet = await G(page, () => window.__game.boat.sailSet);
  const s1 = { x: vw * 0.2, y: vh * 0.75, id: 5 };
  await touch('touchStart', [s1]);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', [{ ...s1, x: s1.x + i * 7 }]);
    await sleep(30);
  }
  await waitFrames(page, 6);
  const rudder = await G(page, () => window.__game.boat.rudder);
  await touch('touchEnd', []);
  const motorBtn = await page.$('#helmbar button:has-text("Motor ahead")');
  if (motorBtn) {
    await motorBtn.tap();
    await waitFrames(page, 2);
  }
  const phoneThr = await G(page, () => window.__game.boat.throttle);
  step('Phone: the "Motor ahead" button starts the outboard', phoneThr > 0, `throttle ${phoneThr}`);
  step('Phone: the round button takes the helm, "More sail" raises sail, the thumb steers', helmOk && sailSet > 0 && rudder > 0.05, `helm: ${helmOk}, sails ${sailSet}, rudder ${rudder.toFixed(2)}`);
  await shot(page, '17b-phone-at-the-helm.png');

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
  await page.tap('#start .big');
  await sleep(800);
  await G(page, () => window.__game.teleport(0, 2.4, Math.PI, -0.5));
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
  await shot(page, '18-backup-mode-demo.png');
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
