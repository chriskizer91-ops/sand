/**
 * The life simulation's tuning bench (run: npm run simulate [-- options]).
 *
 * Builds scripted islands straight into the columns, runs the ecology exactly as the game
 * does (real-time clock at the chosen pace, the sky's wet and dry seasons, storms), prints a
 * timeline per real minute and checks it against the beat sheet (ARCHITECTURE §4).
 *
 * Options:
 *   --scenario high|cay|chain|all   which islands (default all)
 *   --minutes N                     real minutes to run (default 30; chain 60)
 *   --pace 1|2|5                    years per second (default 2)
 *   --catalogue test|real           species (default: real if it has real data, else test)
 *   --seed N
 *   --quiet                         only the summary
 */
import { DAY_SECONDS, NP, SEASON_DAYS } from '../src/config';
import { SPECIES } from '../src/content/species';
import { Substrate, type SpeciesDef } from '../src/content/speciesTypes';
import { Ecology } from '../src/eco/ecology';
import type { EcoNeeds } from '../src/eco/needs';
import { PatchGrid } from '../src/eco/patches';
import { L_CANOPY, L_GROUND, LAYERS } from '../src/eco/fields';
import { ScriptGeo, chain, highIsland, lowCay } from '../src/eco/scenarios';
import { TEST_SPECIES } from '../src/eco/testSpecies';
import { Columns } from '../src/engine/columns';
import type { JournalEntry } from '../src/engine/protocol';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const quiet = args.includes('--quiet');
const pace = Number(opt('pace', '2'));
const seed = Number(opt('seed', '7'));
const realHasData = SPECIES.some((s) => s.eco.mainNeed !== 'no-land' || s.eco.rate !== 10);
const catalogueName = opt('catalogue', realHasData ? 'real' : 'test');
const species: readonly SpeciesDef<EcoNeeds>[] = catalogueName === 'real' ? SPECIES : TEST_SPECIES;

interface Beat {
  label: string;
  /** Real seconds it happened at (or null), and the window it should fall in. */
  at: number | null;
  lo: number;
  hi: number;
}

/** Beats that cannot happen on a given island (a sand cay has no rock for lichen, moss or soil). */
function run(name: string, build: (cols: Columns) => void, minutes: number, skip: readonly string[] = []): { ok: number; total: number } {
  const cols = new Columns();
  build(cols);
  const grid = new PatchGrid();
  const geo = new ScriptGeo(cols);
  const t0 = Date.now();
  const eco = new Ecology(cols, grid, geo, seed, species);
  cols.addListener((i0, k0, i1, k1, f) => eco.onTerrainChanged(i0, k0, i1, k1, f));
  const { w, book } = eco.debug;
  const names = species.map((s) => s.name);
  console.log(`\n=== ${name} (${catalogueName} catalogue, ${species.length} species, pace ${pace} yr/s, seed ${seed}) ===`);
  console.log(`built in ${Date.now() - t0} ms; ${eco.activePatches} active patches; islands: ${[...w.islands.recs.values()].map((r) => `${r.name} ${Math.round(r.area)} m² peak ${r.peak[1].toFixed(0)} m`).join(', ')}`);
  const firstAt = new Map<string, number>();
  const note = (key: string, sec: number): void => {
    if (!firstAt.has(key)) firstAt.set(key, sec);
  };
  const dt = 0.5;
  let seen = 0;
  let workMs = 0;
  let sweptPatches = 0;
  let sweeps = 0;
  for (let sec = 0; sec < minutes * 60; sec += dt) {
    const day = sec / DAY_SECONDS;
    eco.setClock({ paused: false, yps: pace, dayPhase: day % 1, season: Math.floor(day) % SEASON_DAYS === 0 ? 'wet' : 'dry', gentleStorms: false });
    eco.advance(dt);
    const a = performance.now();
    const before = w.step;
    eco.work(1e9);
    workMs += performance.now() - a;
    if (w.step > before) {
      sweeps += w.step - before;
      sweptPatches += eco.debug.sweep.processed * (w.step - before);
    }
    const entries: JournalEntry[] = [];
    eco.takeJournal(entries);
    for (const e of entries) {
      const sp = e.species !== undefined ? names[e.species] : '';
      if (e.kind === 'arrival' || e.kind === 'return') {
        note('arrival', sec);
        note(`arrive:${species[e.species ?? 0].key}`, sec);
      }
      if (e.kind === 'visit') {
        note('visit', sec);
        note(`visit:${species[e.species ?? 0].key}`, sec);
      }
      if (e.first) note(e.first, sec);
      if (e.kind === 'storm') note('storm', sec);
      if (e.kind === 'place' && e.place) note(`place:${e.place}`, sec);
      if (!quiet && (e.headline || e.kind === 'visit' || e.kind === 'arrival' || e.kind === 'return' || e.kind === 'place')) {
        const extra = e.params?.reason ? ` (${e.params.reason})` : e.place ? ` ${e.place}` : e.age ? ` ${e.age}` : e.first ? ` [${e.first}]` : e.params?.key ? ` ${e.params.key}` : '';
        console.log(`  ${fmt(sec)}  Y${String(e.year).padStart(5)}  ${e.headline ? '*' : ' '} ${e.kind.padEnd(14)} ${sp}${extra}`);
      }
    }
    // Lichen frosting: patches with a crust or lichen layer of good cover.
    if (!firstAt.has('lichen-visible')) {
      let n = 0;
      let land = 0;
      for (let p = 0; p < NP * NP; p++) {
        if (w.f.h[p] <= 0) continue;
        land++;
        if (w.f.cov[p * LAYERS + L_GROUND] >= 0.3) n++;
      }
      // Visible frosting: a twentieth of the land.
      if (n >= land * 0.05) note('lichen-visible', sec);
    }
    if (!firstAt.has('forest-visible')) {
      let n = 0;
      // Forest on the rock (not palm groves on the beach).
      for (let p = 0; p < NP * NP; p++) if (w.f.cov[p * LAYERS + L_CANOPY] >= 0.5 && w.f.h[p] > 0 && w.f.bot[p] !== Substrate.Sand) n++;
      if (n >= 150) note('forest-visible', sec);
    }
    if (sec % 60 === 59.5) {
      const found = eco.debug.arrivals.foundCount;
      if (found !== seen || !quiet) {
        seen = found;
        console.log(
          `-- minute ${String(Math.round((sec + 0.5) / 60)).padStart(3)}: year ${w.year}, ${found}/${species.length} species found, age ${eco.debug.director.age}, storm ${eco.storm.phase}, active ${eco.activePatches}, processed ${eco.debug.sweep.processed}`,
        );
      }
    }
  }
  const perPatchUs = sweptPatches > 0 ? (workMs * 1000) / sweptPatches : 0;
  console.log(`work: ${(workMs / 1000).toFixed(1)} s for ${sweeps} steps (${(workMs / Math.max(1, sweeps)).toFixed(2)} ms/step, ~${perPatchUs.toFixed(2)} µs per processed patch-step incl. arrivals and jobs)`);
  // ---------- beat sheet ----------
  const any = (...keys: string[]): number | null => {
    let best: number | null = null;
    for (const k of keys) {
      const v = firstAt.get(k);
      if (v !== undefined && (best === null || v < best)) best = v;
    }
    return best;
  };
  const arr = (keys: string[]): number | null => any(...keys.map((k) => `arrive:${k}`));
  const beats: Beat[] = [
    { label: 'first wind arrival (spider or spores)', at: any('arrival'), lo: 0, hi: 20 },
    { label: 'lichen visibly frosting the rock', at: any('lichen-visible'), lo: 20, hi: 120 },
    { label: 'a seabird visits', at: any('visit:booby', 'arrive:booby'), lo: 30, hi: 240 },
    { label: 'beach plants (sea rocket or morning glory)', at: arr(['searocket', 'glory']), lo: 90, hi: 330 },
    { label: 'a coconut', at: arr(['coconut']), lo: 120, hi: 420 },
    { label: 'moss or first ferns', at: arr(['moss', 'amau']), lo: 150, hi: 420 },
    { label: 'first "couldn\'t stay" story', at: any('visit'), lo: 0, hi: 480 },
    { label: 'ghost crabs on a beach', at: arr(['ghostcrab']), lo: 180, hi: 600 },
    { label: 'grass or first inland shrubs', at: arr(['pili', 'aalii']), lo: 240, hi: 660 },
    { label: 'first tree', at: any('first-tree'), lo: 300, hi: 720 },
    { label: 'visible forest on the wet side', at: any('forest-visible'), lo: 600, hi: 1320 },
    { label: 'first storm', at: any('storm'), lo: 900, hi: 1500 },
  ];
  let ok = 0;
  let total = 0;
  console.log('beat sheet:');
  for (const b of beats) {
    if (skip.some((k) => b.label.includes(k))) continue;
    if (b.at === null && b.hi > minutes * 60) continue;
    total++;
    const pass = b.at !== null && b.at <= b.hi;
    const early = b.at !== null && b.at < b.lo;
    if (pass) ok++;
    console.log(`  ${pass ? (early ? 'early' : ' ok  ') : ' MISS'}  ${b.label.padEnd(44)} ${b.at === null ? 'never' : fmt(b.at)}  (target ${fmt(b.lo)}–${fmt(b.hi)})`);
  }
  const found = eco.debug.arrivals.foundCount;
  console.log(`species found: ${found}/${species.length}; journal entries ${book.entries.length}, cards ${book.entries.filter((e) => e.headline).length}`);
  return { ok, total };
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2)}:${String(s).padStart(2, '0')}`;
}

const which = opt('scenario', 'all');
const minutes = Number(opt('minutes', '0'));
let ok = 0;
let total = 0;
const tally = (r: { ok: number; total: number }): void => {
  ok += r.ok;
  total += r.total;
};
if (which === 'high' || which === 'all') tally(run('High island', (c) => highIsland(c), minutes || 30));
if (which === 'cay' || which === 'all') tally(run('Low cay', (c) => lowCay(c), minutes || 20, ['lichen', 'moss', 'grass', 'forest']));
if (which === 'chain' || which === 'all') tally(run('Chain around a sound', (c) => chain(c), minutes || 60));
console.log(`\nbeat sheet: ${ok}/${total} on time`);
