// Plays the joined game the way a person would, but fast: Begin, pour lava on the glow, let
// centuries pass, and check that the life simulation, the plants, the animals, the journal,
// the storm, and save and load all work together on a real, grown island. It also measures the
// drawing budgets over that grown island (the browser check only ever sees a bare fresh sea).
//   node e2e/playthrough.mjs [--phone] [--years 400]
// Screenshots (pt-*.png) and a JSON report go to e2e/output/. Headless Chromium draws with
// software (SwiftShader), so frame rates mean nothing here and are never asserted.
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAPTOP, PHONE, launch, openGame, root, setCamera, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const phone = args.includes('--phone');
const yi = args.indexOf('--years');
const TOTAL_YEARS = yi >= 0 ? Number(args[yi + 1]) : 400;
const tag = phone ? 'phone' : 'laptop';
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });

const BUDGET = { mainTriangles: 350000, mainCalls: 80, shadowTriangles: 100000, shadowCalls: 20 };
const report = { device: tag, steps: [], numbers: {}, pass: true };
function step(name, ok, detail = '') {
  report.steps.push({ name, ok, detail });
  if (!ok) report.pass = false;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const game = (page, fn, arg) => page.evaluate(fn, arg);
async function shot(page, name) {
  await page.screenshot({ path: join(out, `pt-${tag}-${name}.png`) });
}

const browser = await launch();
const { ctx, page, errors } = await openGame(browser, phone ? PHONE : LAPTOP);
await page.waitForSelector('.begin:not([disabled])', { timeout: 60000 });
if (phone) await page.tap('.begin');
else await page.click('.begin');
await sleep(1200);
step('Begin starts the game', await game(page, () => window.__game.started));

// ---------- 1. the first land ----------
const glow = await game(page, () => window.__game.glow);
await setCamera(page, glow.x, glow.z, 220, -0.5, 0.9);
const poured = await game(page, ([x, z]) => window.__game.pour('lava', x, z, 22, 25), [glow.x, glow.z]);
step('A scripted lava pour on the glow finishes and settles', !!poured && poured.ok === true && poured.settled === true, `${poured?.seconds?.toFixed?.(0)} s of physics`);
await sleep(1500);
const landed = await game(page, () => window.__game.firstLand);
step('First land breaks the surface and starts the year clock', landed === true);
const h = await game(page, ([x, z]) => window.__game.fields.heightAt(x, z), [glow.x, glow.z]);
step('The island stands above the sea', h > 1, `${h.toFixed(1)} m at the glow`);
await shot(page, '1-fresh-island');

// ---------- 2. life arrives ----------
const stats = {};
async function snapshot(label) {
  const s = await game(page, () => {
    const g = window.__game;
    const life = g.life;
    let canopy = 0, shrub = 0, herb = 0;
    const pl = g.fields.plants;
    for (let p = 0; p < pl.length / 6; p++) {
      if (pl[p * 6 + 1] > 40) canopy++;
      if (pl[p * 6 + 3] > 40) shrub++;
      if (pl[p * 6 + 5] > 40) herb++;
    }
    const fauna = g.scene.getObjectByName('fauna')?.userData.sim;
    const species = new Set((life?.pops ?? []).map((q) => q.species));
    return {
      year: g.year,
      islands: life?.islands?.length ?? 0,
      area: Math.round((life?.islands ?? []).reduce((a, i) => a + i.area, 0)),
      speciesPresent: species.size,
      canopyPatches: canopy,
      shrubPatches: shrub,
      herbPatches: herb,
      animalsAlive: fauna ? fauna.liveCount() : -1,
      journal: g.journalEntries.length,
    };
  });
  stats[label] = s;
  console.log('  ' + label.padEnd(14), JSON.stringify(s));
  return s;
}
await snapshot('after the pour');
let ydone = 0;
const marks = [20, 60, 150, TOTAL_YEARS].filter((v, i, a) => v <= TOTAL_YEARS && a.indexOf(v) === i);
for (const m of marks) {
  const r = await game(page, (n) => window.__game.advanceYears(n), m - ydone);
  ydone = m;
  if (!r || r.ok !== true) step(`Advance to year ${m}`, false, JSON.stringify(r));
  await sleep(1500);
  await snapshot(`year ${m}`);
  if (m === 20) await shot(page, '2-year20');
}
const last = stats[`year ${marks[marks.length - 1]}`];
const first = stats['after the pour'];
step('Years advance', last.year >= TOTAL_YEARS - 1, `year ${last.year}`);
step('The life simulation sees one island', last.islands >= 1, `${last.islands} island(s), ${last.area} m²`);
step('Species arrive', last.speciesPresent >= 5, `${last.speciesPresent} kinds present`);
step('Plants grow into layers (herbs, shrubs, canopy)', last.herbPatches > 0 && last.shrubPatches > 0, `herb ${last.herbPatches}, shrub ${last.shrubPatches}, canopy ${last.canopyPatches} patches`);
step('The journal fills', last.journal > first.journal + 5, `${first.journal} → ${last.journal} entries`);
await game(page, () => window.__game.openJournal('guide'));
await sleep(800);
const cards = await page.locator('.gcard').count();
step('The field guide lists species', cards > 5, `${cards} cards`);
await shot(page, '3-field-guide');
await game(page, () => window.__game.closeJournal());
await sleep(500);

// ---------- 3. the grown island, seen from several places ----------
const isl = await game(page, () => {
  const l = window.__game.life;
  const i = [...l.islands].sort((a, b) => b.area - a.area)[0];
  return { cx: i.centroid[0], cz: i.centroid[1], bbox: i.bbox, peak: i.peak };
});
// The best forest patch (most canopy) and the patch with the most beach-looking sand.
const best = await game(page, () => {
  const pl = window.__game.fields.plants;
  let bi = -1, bc = 0;
  for (let p = 0; p < pl.length / 6; p++) if (pl[p * 6 + 1] > bc) { bc = pl[p * 6 + 1]; bi = p; }
  return bi < 0 ? null : { x: -512 + ((bi % 256) + 0.5) * 4, z: -512 + (((bi / 256) | 0) + 0.5) * 4, cover: bc };
});
const poses = [
  ['island from above', [isl.cx, isl.cz, 330, -0.5, 1.1]],
  ['island from the sea', [isl.cx, isl.cz, 170, -0.7, 0.55]],
];
if (best) poses.push(['among the trees', [best.x, best.z, 38, 0.8, 0.35]], ['a canopy close-up', [best.x, best.z, 14, 1.2, 0.25]]);
const held = await game(page, () => window.__game.holdQuality(true));
step('Budgets are measured at the real detail', held.tier === (phone ? 1 : 2) && held.shadows, `tier ${held.tier}`);
report.numbers.poses = [];
for (const [name, pose] of poses) {
  await setCamera(page, ...pose);
  await sleep(2500);
  const s = await game(page, () => window.__game.stats());
  const ok = s.mainTriangles <= BUDGET.mainTriangles && s.mainCalls <= BUDGET.mainCalls && s.shadowTriangles <= BUDGET.shadowTriangles && s.shadowCalls <= BUDGET.shadowCalls;
  report.numbers.poses.push({ name, main: s.mainTriangles, mainCalls: s.mainCalls, shadow: s.shadowTriangles, shadowCalls: s.shadowCalls });
  step(`Budget: ${name}`, ok, `main ${s.mainTriangles} tri / ${s.mainCalls} draws; shadow ${s.shadowTriangles} tri / ${s.shadowCalls} draws`);
  await shot(page, `4-${name.replace(/[^a-z]+/g, '-')}`);
}
await game(page, () => window.__game.holdQuality(false));
const animalsNear = await game(page, () => window.__game.scene.getObjectByName('fauna').userData.sim.liveCount());
step('Animals appear near the camera on a grown island', animalsNear > 0, `${animalsNear} alive in view`);

// ---------- 4. a storm ----------
await setCamera(page, isl.cx, isl.cz, 200, -0.6, 0.8);
await game(page, () => window.__game.stormNow());
let phase = 'none';
let sawWarning = false;
let sawPeak = false;
for (let t = 0; t < 150; t++) {
  phase = await game(page, () => window.__game.storm.phase);
  if (phase === 'warning') sawWarning = true;
  if (phase === 'peak' && !sawPeak) {
    sawPeak = true;
    await sleep(8000);
    await shot(page, '5-storm-peak');
  }
  if (sawPeak && phase === 'clearing') break;
  await sleep(1000);
}
step('A storm goes through warning and peak', sawWarning && sawPeak, `warning ${sawWarning}, peak ${sawPeak}, now ${phase}`);
for (let t = 0; t < 90 && phase !== 'none'; t++) {
  await sleep(1000);
  phase = await game(page, () => window.__game.storm.phase);
}
step('The storm clears', phase === 'none', phase);
await shot(page, '6-after-storm');
const afterStorm = await snapshot('after storm');
let stormEntry = false;
for (let t = 0; t < 40 && !stormEntry; t++) {
  stormEntry = await game(page, () => window.__game.journalEntries.some((e) => e.kind === 'storm'));
  if (!stormEntry) await sleep(1000);
}
const kinds = await game(page, () => {
  const c = {};
  for (const e of window.__game.journalEntries) c[e.kind] = (c[e.kind] ?? 0) + 1;
  return c;
});
step('The journal records the storm', stormEntry === true, JSON.stringify(kinds));

// ---------- 5. undo brings life back; save and load keep everything ----------
await game(page, () => window.__game.holdYears(true));
await sleep(1500);
const before = await game(page, () => {
  window.__before = new Float32Array(window.__game.fields.surf);
  return { year: window.__game.year, life: window.__game.life.islands.length };
});
await game(page, () => window.__game.openMenu('menu'));
const dl = page.waitForEvent('download', { timeout: 60000 });
await page.click('text=Save to a file');
const d = await dl;
const path = join(out, `pt-${tag}.wwwsave`);
await d.saveAs(path);
step('Save to a file works on a grown island', d.suggestedFilename().endsWith('.wwwsave') && statSync(path).size > 1000, `${statSync(path).size} bytes`);
await game(page, () => window.__game.closeMenu());
await game(page, () => window.__game.openMenu('menu'));
const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
await page.click('text=Open a saved file');
await (await chooser).setFiles(path);
await page.waitForFunction(() => /Your sea is back|Couldn't open/.test(document.querySelector('.toast.show')?.textContent ?? ''), null, { timeout: 120000 });
await sleep(3000);
const after = await game(page, () => {
  const a = window.__before, b = window.__game.fields.surf;
  let worst = 0, off = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) worst = d;
    if (d > 0.02) off++;
  }
  return { worst, off, year: window.__game.year, life: window.__game.life?.islands.length ?? 0 };
});
// The save file keeps ground heights to 1/128 m, so the loaded ground may differ by a hair.
step('The saved file loads back to the same island and year', after.off === 0 && after.year === before.year && after.life === before.life, `year ${before.year} → ${after.year}, islands ${before.life} → ${after.life}, biggest height difference ${after.worst.toFixed(4)} m, ${after.off} columns off by more than 2 cm`);
await game(page, () => window.__game.closeMenu());
await game(page, () => window.__game.holdYears(false));

// ---------- 6. the engine's own numbers ----------
const eng = await game(page, () => window.__game.engineStats());
report.numbers.engine = { year: eng.year, activePatches: eng.activePatches, geoMs: eng.perf.geoMs, ecoMs: eng.perf.ecoMs, packMs: eng.perf.packMs, memoryMB: eng.memoryMB, tickInterval: eng.tickInterval };
console.log('  engine', JSON.stringify(report.numbers.engine));
report.numbers.stats = stats;
step('No page errors during the whole playthrough', errors.length === 0, errors.slice(0, 5).join(' | '));

await browser.close();
writeFileSync(join(out, `playthrough-${tag}.json`), JSON.stringify(report, null, 2));
const failed = report.steps.filter((s) => !s.ok);
console.log(`\n${report.steps.length - failed.length} of ${report.steps.length} playthrough checks passed (${tag}).`);
if (failed.length) {
  console.log('Failed:\n' + failed.map((s) => `  - ${s.name}${s.detail ? ': ' + s.detail : ''}`).join('\n'));
  process.exitCode = 1;
}
