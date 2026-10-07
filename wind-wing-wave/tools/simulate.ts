/**
 * The life simulation's tuning bench (run: npm run simulate [-- options]).
 *
 * Builds scripted islands straight into the columns, runs the ecology the way the game does
 * (real-time ticks at the chosen pace, the sky's wet and dry seasons, storms), prints a timeline
 * per real minute and checks it against the beat sheet (ARCHITECTURE §4).
 *
 * Beats are recognised from what each species is (seabird, beach plant, palm on the sea road,
 * crab, moss or fern, tree…), never from catalogue keys, so the same bench judges the test
 * catalogue and the real one. Each beat gets a verdict: on time, early, late, or missed.
 *
 * Several beats depend on what the player has built ("with any beach", "if built for it"), so
 * by default the islands are raised the way a player might: the high island's beaches are
 * poured at 2:30, and the chain grows one island at a time (the second at 0:45, the third,
 * closing the Sound, at 1:30, the seabird islet at 2:00). --prebuilt raises everything at
 * minute 0 instead (every niche open at once: a stress test of the opening).
 *
 * Options:
 *   --scenario high|cay|chain|all   which islands (default all)
 *   --minutes N                     real minutes to run (default: high 60, cay 30, chain 300)
 *   --pace 1|2|5                    years per second (default 2)
 *   --catalogue test|real           species (default: real if it has real data, else test)
 *   --seed N
 *   --hz N                          engine ticks per real second (default 2)
 *   --budget MS                     ecology time budget per tick in ms (default: unlimited).
 *                                   The game gives 2 ms at 30 Hz on a laptop; a phone is about
 *                                   5x slower, so --hz 10 --budget 0.8 stands in for a Pixel.
 *   --prebuilt                      every island and beach there from the start
 *   --quiet                         only the minute lines and the verdicts
 */
import { DAY_SECONDS, NX, NZ, SEASON_DAYS } from '../src/config';
import { SPECIES } from '../src/content/species';
import { AnimalModel, Habitat, PlantModel, Substrate, type SpeciesDef } from '../src/content/speciesTypes';
import { isBuildableReason } from '../src/eco/catalog';
import { Ecology } from '../src/eco/ecology';
import type { ReasonCode, EcoNeeds } from '../src/eco/needs';
import { PatchGrid } from '../src/eco/patches';
import { L_CANOPY, L_GROUND, LAYERS, NPATCH } from '../src/eco/fields';
import { ScriptGeo, chainIsland, highIsland, highIslandBeaches, lowCay, seabed } from '../src/eco/scenarios';
import { TEST_SPECIES } from '../src/eco/testSpecies';
import { ChangeFlag, Columns } from '../src/engine/columns';
import type { JournalEntry } from '../src/engine/protocol';

const args = process.argv.slice(2);
const opt = (name: string, def: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const quiet = args.includes('--quiet');
const prebuilt = args.includes('--prebuilt');
const pace = Number(opt('pace', '2'));
const seed = Number(opt('seed', '7'));
const hz = Number(opt('hz', '2'));
const budget = Number(opt('budget', '1e9'));
const realHasData = SPECIES.some((s) => s.eco.mainNeed !== 'no-land' || s.eco.rate !== 10);
const catalogueName = opt('catalogue', realHasData ? 'real' : 'test');
const species: readonly SpeciesDef<EcoNeeds>[] = catalogueName === 'real' ? SPECIES : TEST_SPECIES;

// ---------- what each species is, for the beats ----------

const has = (list: readonly number[] | undefined, v: number): boolean => (list ?? []).includes(v);
const isSeabird = (d: SpeciesDef<EcoNeeds>): boolean => d.animal?.behaviour === 'colony';
/** A beach plant: a herb that drifts in on the sea and roots in sand (sea rocket, morning glory). */
const isBeachHerb = (d: SpeciesDef<EcoNeeds>): boolean =>
  d.kind === 'plant' && !d.marine && d.layer === 'herb' && d.roads.includes('sea') && (has(d.eco.substrate, Substrate.Sand) || has(d.eco.habitats, Habitat.Beach));
const isDriftPalm = (d: SpeciesDef<EcoNeeds>): boolean => d.plant?.model === PlantModel.Palm && d.roads.includes('sea');
const isMossOrFern = (d: SpeciesDef<EcoNeeds>): boolean => d.plant?.tint === 'moss' || d.plant?.model === PlantModel.Fern || d.plant?.model === PlantModel.TreeFern;
const isBeachCrab = (d: SpeciesDef<EcoNeeds>): boolean => d.animal?.model === AnimalModel.Crab && (has(d.eco.habitats, Habitat.Beach) || has(d.animal.where, Habitat.Beach));
/** Grass, or a shrub that needs some soil (an inland shrub, not a beach one). */
const isGrassOrShrub = (d: SpeciesDef<EcoNeeds>): boolean =>
  d.kind === 'plant' &&
  !d.marine &&
  ((d.layer === 'herb' && (d.plant?.model === PlantModel.Grass || d.plant?.tint === 'grass')) || (d.layer === 'shrub' && (d.eco.soil?.[0] ?? 0) > 0));
const isPondLife = (d: SpeciesDef<EcoNeeds>): boolean => d.animal?.model === AnimalModel.Duck || d.animal?.model === AnimalModel.Dragonfly;

interface Beat {
  label: string;
  /** Real seconds it happened at (or null), and the window it should fall in. */
  at: number | null;
  lo: number;
  hi: number;
}

/** Land the scripted player raises at a given real second. */
interface Stage {
  at: number;
  label: string;
  build: (cols: Columns) => void;
}

interface Totals {
  ok: number;
  early: number;
  late: number;
  missed: number;
}

function run(name: string, build: (cols: Columns) => void, stages: Stage[], minutes: number, beatsFor: 'high' | 'cay' | 'chain'): Totals {
  const cols = new Columns();
  build(cols);
  const later = prebuilt ? [] : stages.slice();
  if (prebuilt) for (const st of stages) st.build(cols);
  const grid = new PatchGrid();
  const geo = new ScriptGeo(cols);
  const t0 = performance.now();
  const eco = new Ecology(cols, grid, geo, seed, species);
  const buildMs = performance.now() - t0;
  cols.addListener((i0, k0, i1, k1, f) => eco.onTerrainChanged(i0, k0, i1, k1, f));
  const { w, book, arrivals } = eco.debug;
  console.log(`\n=== ${name} (${catalogueName} catalogue, ${species.length} species, pace ${pace} yr/s, ${hz} Hz, budget ${budget >= 1e8 ? 'unlimited' : `${budget} ms`}, seed ${seed}) ===`);
  console.log(
    `built in ${buildMs.toFixed(0)} ms; ${eco.activePatches} active patches; islands: ${[...w.islands.recs.values()].map((r) => `${r.name} ${Math.round(r.area)} m² peak ${r.peak[1].toFixed(0)} m`).join(', ')}`,
  );
  const firstAt = new Map<string, number>();
  /** Remember when something first happened; true the first time. */
  const note = (key: string, sec: number): boolean => {
    if (firstAt.has(key)) return false;
    firstAt.set(key, sec);
    return true;
  };
  const cardsPerMin: number[] = [];
  const newPerMin: number[] = [];
  let lastFound = 0;
  let workMs = 0;
  let worst = 0;
  let over = 0;
  let ticks = 0;
  const dt = 1 / hz;
  const total = Math.round(minutes * 60 * hz);
  for (let tick = 0; tick < total; tick++) {
    const sec = tick * dt;
    // The sky starts at dawn of a wet day.
    const day = sec / DAY_SECONDS;
    eco.setClock({ paused: false, yps: pace, dayPhase: day % 1, season: Math.floor(day) % SEASON_DAYS === 0 ? 'wet' : 'dry', gentleStorms: false });
    eco.advance(dt);
    while (later.length > 0 && sec >= later[0].at) {
      const st = later.shift() as Stage;
      st.build(cols);
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
      if (!quiet) console.log(`  ${fmt(sec)}  -- the player: ${st.label}`);
    }
    const a = performance.now();
    eco.work(budget);
    const ms = performance.now() - a;
    workMs += ms;
    ticks++;
    if (ms > worst) worst = ms;
    if (budget < 1e8 && ms > budget * 1.5 + 0.5) over++;
    const entries: JournalEntry[] = [];
    eco.takeJournal(entries);
    const minute = Math.floor(sec / 60);
    for (const e of entries) {
      const sp = e.species !== undefined ? species[e.species] : null;
      // Cards, not counting the first-land card (the island's own moment, before any life).
      if (e.headline && e.kind !== 'first-land') cardsPerMin[minute] = (cardsPerMin[minute] ?? 0) + 1;
      if ((e.kind === 'arrival' || e.kind === 'return') && sp) {
        note('arrival', sec);
        if (isSeabird(sp)) note('seabird', sec);
        if (isBeachHerb(sp)) note('beach-herb', sec);
        if (isDriftPalm(sp)) note('palm', sec);
        if (isMossOrFern(sp)) note('moss-fern', sec);
        if (isBeachCrab(sp)) note('crab', sec);
        if (isGrassOrShrub(sp)) note('grass-shrub', sec);
        if (isPondLife(sp)) note('pond-life', sec);
      }
      if (e.kind === 'visit' && sp) {
        note('visit', sec);
        if (isSeabird(sp)) note('seabird', sec);
        if (isBuildableReason(e.params?.reason as ReasonCode)) note('visit-buildable', sec);
      }
      if (e.first) note(e.first, sec);
      if (e.kind === 'storm') note('storm', sec);
      if (e.kind === 'ending') note('ending', sec);
      if (e.kind === 'place' && e.place) note(`place:${e.place}`, sec);
      if (!quiet && (e.headline || e.kind === 'visit' || e.kind === 'arrival' || e.kind === 'return' || e.kind === 'place')) {
        const extra = e.params?.reason ? ` (${e.params.reason})` : e.place ? ` ${e.place}` : e.age ? ` ${e.age}` : e.first ? ` [${e.first}]` : '';
        console.log(`  ${fmt(sec)}  Y${String(e.year).padStart(5)}  ${e.headline ? '*' : ' '} ${e.kind.padEnd(14)} ${sp?.name ?? ''}${extra}`);
      }
    }
    const found = arrivals.foundCount;
    if (found > lastFound) {
      newPerMin[minute] = (newPerMin[minute] ?? 0) + found - lastFound;
      lastFound = found;
    }
    if (tick % Math.max(1, Math.round(hz * 5)) === 0) {
      visible(eco, sec, note);
      const life = eco.takeLife();
      if (life?.peaks.some((k) => k.cap)) note('cloud', sec);
      if (life && life.ponds.length > 0) note('pond', sec);
    }
    if ((tick + 1) % Math.round(60 * hz) === 0) {
      console.log(
        `-- minute ${String(minute + 1).padStart(3)}: year ${w.year}, ${found}/${species.length} found, cards ${cardsPerMin[minute] ?? 0}, age ${eco.debug.director.age}, storm ${eco.storm.phase}, active ${eco.activePatches}, swept ${eco.debug.sweep.processed}`,
      );
    }
  }
  // ---------- the beat sheet ----------
  const at = (...keys: string[]): number | null => {
    let best: number | null = null;
    for (const k of keys) {
      const v = firstAt.get(k);
      if (v !== undefined && (best === null || v < best)) best = v;
    }
    return best;
  };
  const beats: Beat[] = [
    { label: 'first wind arrival (spider or spores)', at: at('arrival'), lo: 0, hi: 20 },
    { label: 'lichen visibly frosting the oldest rock', at: at('lichen-visible'), lo: 30, hi: 120 },
    { label: 'a seabird visits', at: at('seabird'), lo: 120, hi: 180 },
    { label: 'beach plants (sea rocket or morning glory)', at: at('beach-herb'), lo: 180, hi: 300 },
    { label: 'a coconut (within ~5 min of a beach)', at: at('palm'), lo: 180, hi: 420 },
    { label: 'moss and first ferns', at: at('moss-fern'), lo: 240, hi: 360 },
    { label: 'first "couldn\'t stay" about something to build', at: at('visit-buildable'), lo: 0, hi: 480 },
    { label: 'ghost crabs on a beach', at: at('crab'), lo: 300, hi: 600 },
    { label: 'grass, first shrubs', at: at('grass-shrub'), lo: 360, hi: 600 },
    { label: 'first tree', at: at('first-tree'), lo: 480, hi: 720 },
    { label: 'visible forest on the wet side', at: at('forest-visible'), lo: 900, hi: 1200 },
    { label: 'first storm (once shrubs exist)', at: at('storm'), lo: 900, hi: 1200 },
    { label: 'cloud cap on the peak', at: at('cloud'), lo: 0, hi: 2100 },
    { label: 'a pond in the rock basin', at: at('pond'), lo: 0, hi: 2100 },
    { label: 'ducks or dragonflies', at: at('pond-life'), lo: 1200, hi: 2100 },
    { label: 'birdsong', at: at('first-song'), lo: 1200, hi: 2100 },
  ];
  // The first island levels off: the last new species before six quiet minutes.
  const plateau = plateauAt(newPerMin, minutes);
  if (beatsFor === 'high') beats.push({ label: 'the island plateaus (no new kinds for 6 min)', at: plateau, lo: 2400, hi: 3000 });
  // The ending is ~4 h for a player; this scripted one closes the Sound at 1:30, so it may come from 2:00.
  if (beatsFor === 'chain') beats.push({ label: 'the ending: whales in the Sound', at: at('ending'), lo: 2 * 3600, hi: 5 * 3600 });
  // A sand cay has no rock for lichen, moss, a crater pond or a cloud cap; its own beats are the beach ones.
  const skip = beatsFor === 'cay' ? ['lichen', 'moss', 'grass', 'forest', 'cloud', 'pond', 'ducks', 'birdsong', 'storm'] : [];
  const tot: Totals = { ok: 0, early: 0, late: 0, missed: 0 };
  console.log('beat sheet:');
  for (const b of beats) {
    if (skip.some((k) => b.label.includes(k))) continue;
    if (b.at === null && b.hi > minutes * 60) continue;
    let verdict: string;
    if (b.at === null) {
      verdict = 'MISS ';
      tot.missed++;
    } else if (b.at < b.lo) {
      verdict = 'early';
      tot.early++;
    } else if (b.at > b.hi) {
      verdict = 'late ';
      tot.late++;
    } else {
      verdict = ' ok  ';
      tot.ok++;
    }
    console.log(`  ${verdict}  ${b.label.padEnd(50)} ${b.at === null ? '  never' : fmt(b.at)}  (target ${fmt(b.lo)}–${fmt(b.hi)})`);
  }
  // ---------- pacing of cards and the work it cost ----------
  const opening = Array.from({ length: Math.min(10, Math.ceil(minutes)) }, (_, m) => cardsPerMin[m] ?? 0);
  const busiest = Math.max(0, ...opening);
  let laterSum = 0;
  for (let m = 10; m < minutes; m++) laterSum += cardsPerMin[m] ?? 0;
  const laterAvg = minutes > 10 ? laterSum / (minutes - 10) : 0;
  const cardsOk = busiest <= 4 && laterAvg <= 2;
  if (cardsOk) tot.ok++;
  else tot.late++;
  console.log(`  ${cardsOk ? ' ok  ' : 'BUSY '}  cards per minute, first ten minutes: ${opening.join(' ')} (most ${busiest}; at most 4); later on average ${laterAvg.toFixed(1)} (at most 2)`);
  const found = arrivals.foundCount;
  console.log(`species found: ${found}/${species.length}; living now: ${living(eco)}; journal entries ${book.entries.length}, cards ${book.entries.filter((e) => e.headline).length}`);
  console.log(
    `work: ${(workMs / 1000).toFixed(1)} s over ${ticks} ticks (mean ${(workMs / ticks).toFixed(2)} ms, worst ${worst.toFixed(1)} ms${budget < 1e8 ? `, ${over} ticks over budget` : ''}); years reached ${w.year} of ${Math.round(minutes * 60 * pace)}`,
  );
  return tot;
}

/** Visible milestones read from the patches: lichen frosting the rock, forest on the rock. */
function visible(eco: Ecology, sec: number, note: (key: string, sec: number) => boolean): void {
  const f = eco.debug.w.f;
  let land = 0;
  let frost = 0;
  let forest = 0;
  for (let p = 0; p < NPATCH; p++) {
    if (f.h[p] <= 0) continue;
    land++;
    if (f.cov[p * LAYERS + L_GROUND] >= 0.3 && f.bot[p] !== Substrate.Sand) frost++;
    // Forest on the wet, windward side (not palm groves on the beach or screwpine in the dry lee).
    if (f.cov[p * LAYERS + L_CANOPY] >= 0.5 && f.bot[p] !== Substrate.Sand && f.wind[p] > 0) forest++;
  }
  // Visible frosting: a twentieth of the land.
  if (frost >= land * 0.05) note('lichen-visible', sec);
  if (forest >= 150) {
    if (!quiet && note('forest-visible', sec)) console.log(`  ${fmt(sec)}  forest: ${canopyMix(eco)}`);
  }
}

/** The trees making up the forest on the rock, most patches first. */
function canopyMix(eco: Ecology): string {
  const f = eco.debug.w.f;
  const n = new Map<number, number>();
  for (let p = 0; p < NPATCH; p++) {
    const s1 = f.sp[p * LAYERS + L_CANOPY];
    if (s1 === 0 || f.h[p] <= 0 || f.cov[p * LAYERS + L_CANOPY] < 0.5 || f.bot[p] === Substrate.Sand || f.wind[p] <= 0) continue;
    n.set(s1 - 1, (n.get(s1 - 1) ?? 0) + 1);
  }
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, k]) => `${species[s].name} ${k}`)
    .join(', ');
}

/** The start of the first stretch of six minutes without a new species (seconds), or null. */
function plateauAt(newPerMin: number[], minutes: number): number | null {
  let last = 0;
  for (let m = 0; m < minutes; m++) {
    if ((newPerMin[m] ?? 0) > 0) last = m + 1;
    else if (m + 1 - last >= 6) return last * 60;
  }
  return null;
}

function living(eco: Ecology): number {
  let n = 0;
  for (let s = 0; s < species.length; s++) if (eco.debug.arrivals.living(s)) n++;
  return n;
}

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2)}:${String(s).padStart(2, '0')}`;
}

const which = opt('scenario', 'all');
const minutes = Number(opt('minutes', '0'));
const sum: Totals = { ok: 0, early: 0, late: 0, missed: 0 };
const add = (r: Totals): void => {
  sum.ok += r.ok;
  sum.early += r.early;
  sum.late += r.late;
  sum.missed += r.missed;
};
if (which === 'high' || which === 'all') {
  add(run('High island', (c) => highIsland(c, 1, false), [{ at: 150, label: 'pours beaches on the lee', build: (c) => highIslandBeaches(c) }], minutes || 60, 'high'));
}
if (which === 'cay' || which === 'all') add(run('Low cay', (c) => lowCay(c), [], minutes || 30, 'cay'));
if (which === 'chain' || which === 'all') {
  add(
    run(
      'Chain around a sound',
      (c) => {
        seabed(c);
        chainIsland(c, 0);
      },
      [
        { at: 45 * 60, label: 'raises a second island', build: (c) => chainIsland(c, 1) },
        { at: 90 * 60, label: 'raises a third island, closing the Sound', build: (c) => chainIsland(c, 2) },
        { at: 120 * 60, label: 'raises a seabird islet', build: (c) => chainIsland(c, 3) },
      ],
      minutes || 300,
      'chain',
    ),
  );
}
console.log(`\nbeat sheet: ${sum.ok} on time, ${sum.early} early, ${sum.late} late, ${sum.missed} missed`);
