/**
 * Checks for the life simulation (WP-D1). They build scripted islands straight into the
 * columns, run the ecology in one-year steps, and test the rules the game promises
 * (ARCHITECTURE §4 and the WP-D1 brief). The quick ones also run on the in-game checks page.
 */
import { NP, NX, NZ } from '../config';
import { Habitat, Substrate, type SpeciesDef } from '../content/speciesTypes';
import { BLOCKS_X, ChangeFlag, Columns, type ColumnBlock } from '../engine/columns';
import type { JournalEntry, PlaceEvent } from '../engine/protocol';
import { moistureOf } from '../eco/climate';
import { Ecology } from '../eco/ecology';
import { Flag, L_CANOPY, L_GROUND, LAYERS, NPATCH, patchAt, patchX, patchZ } from '../eco/fields';
import type { EcoNeeds } from '../eco/needs';
import { PBLOCKS, PatchGrid, type PatchBlock } from '../eco/patches';
import { MET, STUCK_CAP } from '../eco/arrivals';
import { ScriptGeo, cay, cone, disc, flatSea, highIsland, sandDisc, seabed } from '../eco/scenarios';
import { TEST_SPECIES, testCatalogue } from '../eco/testSpecies';
import { registerChecks } from './registry';

type Species = SpeciesDef<EcoNeeds>[];

interface World {
  cols: Columns;
  grid: PatchGrid;
  eco: Ecology;
}

/** A scripted world with its ecology listening to the ground (as the engine hub wires it). */
function world(build: (cols: Columns) => void, species: Species, seed = 3): World {
  const cols = new Columns();
  build(cols);
  const grid = new PatchGrid();
  const eco = new Ecology(cols, grid, new ScriptGeo(cols), seed, species);
  cols.addListener((i0, k0, i1, k1, f) => eco.onTerrainChanged(i0, k0, i1, k1, f));
  eco.setClock({ paused: false, yps: 2, dayPhase: 0.3, season: 'dry', gentleStorms: false });
  return { cols, grid, eco };
}

/** Same catalogue, with arrival rates multiplied (so arrival is never the bottleneck). */
function eager(keys: string[], times: number): Species {
  return testCatalogue(keys, (d) => ({ ...d, eco: { ...d.eco, rate: d.eco.rate * times } }));
}

function entries(eco: Ecology): JournalEntry[] {
  return eco.journalAll();
}

/** Land patches matching a test. */
function count(eco: Ecology, test: (p: number) => boolean): number {
  const f = eco.debug.w.f;
  let n = 0;
  for (let p = 0; p < NPATCH; p++) if (f.h[p] > 0 && test(p)) n++;
  return n;
}

function idOf(sp: Species, key: string): number {
  return sp.findIndex((s) => s.key === key);
}

// ---------- shared runs (computed once, used by several checks) ----------

let successionRun: { eco: Ecology; firstYear: Map<string, number>; sp: Species } | null = null;
function succession(): { eco: Ecology; firstYear: Map<string, number>; sp: Species } {
  if (successionRun) return successionRun;
  const keys = ['crust', 'lichen', 'moss', 'amau', 'pili', 'aalii', 'ohia'];
  const sp = eager(keys, 30);
  const { eco } = world((c) => {
    seabed(c);
    cone(c, 40, -20, 110, 70);
  }, sp);
  const firstYear = new Map<string, number>();
  for (let y = 0; y < 2400; y += 10) {
    eco.debugAdvance(10);
    for (const e of entries(eco)) {
      if ((e.kind === 'arrival' || e.kind === 'return') && e.params?.first === 1 && e.species !== undefined) {
        const k = sp[e.species].key;
        if (!firstYear.has(k)) firstYear.set(k, e.year);
      }
    }
  }
  successionRun = { eco, firstYear, sp };
  return successionRun;
}

registerChecks('eco', [
  {
    id: 'succession-order',
    label: 'Bare lava greens in order: crust, moss, fern, grass, shrub, tree',
    quick: false,
    run() {
      const { firstYear } = succession();
      const order = ['crust', 'moss', 'amau', 'pili', 'aalii', 'ohia'];
      const years = order.map((k) => firstYear.get(k) ?? Infinity);
      let ok = years.every((y) => Number.isFinite(y));
      for (let i = 1; i < years.length; i++) if (years[i] < years[i - 1]) ok = false;
      return { pass: ok, detail: order.map((k, i) => `${k} Y${years[i]}`).join(', ') };
    },
  },
  {
    id: 'no-trees-thin-soil',
    label: 'No tree grows where the soil is still too thin',
    quick: false,
    run() {
      const { eco } = succession();
      const { w } = eco.debug;
      const f = w.f;
      let trees = 0;
      let bad = 0;
      for (let p = 0; p < NPATCH; p++) {
        const s1 = f.sp[p * LAYERS + L_CANOPY];
        if (s1 === 0 || f.cov[p * LAYERS + L_CANOPY] < 0.1) continue;
        trees++;
        if (f.soil[p] < w.t.soilMin[s1 - 1] * 0.98) bad++;
      }
      return { pass: trees > 0 && bad === 0, detail: `${trees} tree patches, ${bad} on soil thinner than the tree needs` };
    },
  },
  {
    id: 'rain-shadow',
    label: 'An 80 m peak is at least 1.8x wetter on the windward side than in its lee',
    quick: true,
    run() {
      const { eco } = world((c) => {
        flatSea(c, 14);
        cone(c, 0, 0, 140, 80);
      }, TEST_SPECIES);
      const f = eco.debug.w.f;
      let wet = 0;
      let wn = 0;
      let dry = 0;
      let dn = 0;
      for (let p = 0; p < NPATCH; p++) {
        if (f.h[p] < 5 || f.h[p] > 60) continue;
        const m = moistureOf(f, p, 0, 0);
        const x = patchX(p);
        if (x > 25) {
          wet += m;
          wn++;
        } else if (x < -25) {
          dry += m;
          dn++;
        }
      }
      const ratio = wet / Math.max(1, wn) / Math.max(1e-6, dry / Math.max(1, dn));
      return { pass: ratio >= 1.8, detail: `windward moisture ${(wet / wn).toFixed(2)}, lee ${(dry / dn).toFixed(2)}, ratio ${ratio.toFixed(2)}` };
    },
  },
  {
    id: 'ponds',
    label: 'A rock crater in the rain holds a pond; a sand hollow does not',
    quick: true,
    run() {
      const { eco } = world((c) => {
        flatSea(c, 14);
        cone(c, 120, 0, 130, 85, { crater: { r: 20, depth: 8 } });
        cay(c, -220, 0, 80, 5);
        // A hollow scooped into the sand cay.
        for (let k = 0; k < NZ; k++) {
          for (let i = 0; i < NX; i++) {
            const d = Math.hypot(c.cx(i) + 220, c.cz(k));
            if (d < 22) c.sed[i + k * NX] -= 3 * (1 - d / 22);
          }
        }
      }, TEST_SPECIES);
      const { w, job } = eco.debug;
      eco.debugAdvance(80);
      const crater = patchAt(120, 0);
      const hollow = patchAt(-220, 0);
      const ponds = job.hydro.ponds;
      const inCrater = (w.f.flags[crater] & Flag.Pond) !== 0;
      const inHollow = (w.f.flags[hollow] & Flag.Pond) !== 0;
      const sandBasin = job.hydro.basinAt(hollow);
      return {
        pass: inCrater && !inHollow,
        detail: `crater pond ${inCrater ? 'yes' : 'no'}, sand-hollow pond ${inHollow ? 'yes' : 'no'} (${sandBasin?.dry ?? 'no basin'}), ${ponds.length} pond(s)`,
      };
    },
  },
  {
    id: 'island-ids',
    label: 'Island ids stay put through small edits, joins and splits',
    quick: true,
    run() {
      const { cols, eco } = world((c) => {
        flatSea(c, 6);
        disc(c, -80, 0, 50, 6);
        disc(c, 80, 0, 50, 6);
      }, TEST_SPECIES);
      const isl = eco.debug.w.f.isl;
      const a = isl[patchAt(-80, 0)];
      const b = isl[patchAt(80, 0)];
      const steps: string[] = [`A=${a} B=${b}`];
      let ok = a !== 0 && b !== 0 && a !== b;
      // A small bump on A.
      disc(cols, -80, 0, 8, 8);
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
      eco.flushJobs();
      ok = ok && isl[patchAt(-80, 0)] === a && isl[patchAt(80, 0)] === b;
      steps.push(`after bump A=${isl[patchAt(-80, 0)]} B=${isl[patchAt(80, 0)]}`);
      // A sand bridge joins them.
      for (let x = -40; x <= 40; x += 2) sandDisc(cols, x, 0, 8, 8);
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
      eco.flushJobs();
      const joined = isl[patchAt(-80, 0)] === isl[patchAt(80, 0)];
      const keep = isl[patchAt(80, 0)];
      const told = entries(eco).some((e) => e.kind === 'islands-joined');
      ok = ok && joined && told && (keep === a || keep === b);
      steps.push(`joined as ${keep} (told: ${told})`);
      // Scoop the bridge away: the two come apart with their old ids.
      for (let k = 0; k < NZ; k++) {
        for (let i = 0; i < NX; i++) {
          const x = cols.cx(i);
          const z = cols.cz(k);
          if (Math.abs(x) <= 32 && Math.abs(z) <= 14) {
            const c = i + k * NX;
            cols.sed[c] = 1;
            cols.rock[c] = -7;
          }
        }
      }
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
      eco.flushJobs();
      const a2 = isl[patchAt(-80, 0)];
      const b2 = isl[patchAt(80, 0)];
      ok = ok && a2 === a && b2 === b;
      steps.push(`split A=${a2} B=${b2}`);
      return { pass: ok, detail: steps.join('; ') };
    },
  },
  {
    id: 'deterministic',
    label: 'The same seed and the same edits give the same history',
    quick: false,
    run() {
      const runOnce = (): { journal: string; hash: number } => {
        const { cols, eco } = world((c) => highIsland(c, 0.6), TEST_SPECIES, 11);
        eco.debugAdvance(150);
        sandDisc(cols, 0, 60, 14, 2);
        cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
        eco.debugAdvance(150);
        const f = eco.debug.w.f;
        let h = 2166136261;
        for (let i = 0; i < f.sp.length; i++) h = Math.imul(h ^ f.sp[i] ^ (Math.round(f.cov[i] * 1e5) << 8), 16777619) >>> 0;
        return { journal: entries(eco).map((e) => `${e.year}:${e.kind}:${e.species ?? ''}:${e.place ?? ''}`).join('|'), hash: h };
      };
      const r1 = runOnce();
      const r2 = runOnce();
      const same = r1.journal === r2.journal && r1.hash === r2.hash;
      return { pass: same, detail: `journal ${r1.journal.split('|').length} entries, life hash ${r1.hash.toString(16)} vs ${r2.hash.toString(16)}` };
    },
  },
  {
    id: 'visit-then-return',
    label: "A coconut on an all-rock shore can't stay (no beach), says so once, and returns within 90 s of a beach",
    quick: false,
    run() {
      // A coconut that would take to any sand beach (the lee here is dry and the check is about the return).
      const sp = testCatalogue(['lichen', 'coconut'], (d) => (d.key === 'coconut' ? { ...d, eco: { ...d.eco, rate: 3, moist: [0.02, 0.05, 1, 1], saltMax: 1 } } : d));
      const { cols, eco } = world((c) => {
        flatSea(c, 10);
        cone(c, 0, 0, 110, 40);
      }, sp);
      const coconut = idOf(sp, 'coconut');
      // Wait for its first visit (chance decides when it drifts in).
      for (let y = 0; y < 3000 && !entries(eco).some((e) => e.kind === 'visit' && e.species === coconut); y += 10) eco.debugAdvance(10);
      eco.debugAdvance(100);
      const visits = entries(eco).filter((e) => e.kind === 'visit' && e.species === coconut);
      const reason = visits[0]?.params?.reason;
      // Build a beach on the lee shore.
      sandDisc(cols, -112, 0, 26, 2.2);
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
      eco.flushJobs();
      const builtAt = eco.playSeconds;
      let backAt = -1;
      for (let y = 0; y < 400 && backAt < 0; y++) {
        eco.debugAdvance(1);
        if (entries(eco).some((e) => (e.kind === 'return' || e.kind === 'arrival') && e.species === coconut)) backAt = eco.playSeconds;
      }
      const wait = backAt - builtAt;
      const ok = visits.length === 1 && reason === 'no-beach' && backAt >= 0 && wait <= 90;
      return { pass: ok, detail: `${visits.length} visit entr${visits.length === 1 ? 'y' : 'ies'} (reason ${reason ?? 'none'}); back ${backAt < 0 ? 'never' : `${wait.toFixed(0)} s after the beach`}` };
    },
  },
  {
    id: 'never-stuck',
    label: 'Never stuck: once a species could live here, it arrives within 5 minutes (common) to 15 (rare)',
    quick: false,
    run() {
      // Arrival rates all but zero: only the guarantees bring life.
      const sp = testCatalogue(
        TEST_SPECIES.map((s) => s.key),
        (d) => ({ ...d, eco: { ...d.eco, rate: d.eco.rate * 1e-6 } }),
      );
      const { eco } = world((c) => highIsland(c, 0.6), sp, 6);
      const { w, arrivals, sweep } = eco.debug;
      const t = w.t;
      const f = w.f;
      const isl = w.islands;
      const metAt = new Float64Array(t.n).fill(-1);
      const cameAt = new Float64Array(t.n).fill(-1);
      /** Could plant s stay in patch p of island slot (the same rule the guarantee uses: suitability 0.35, room in its layer)? */
      const stays = (s: number, p: number, slot: number): boolean => {
        const L = t.layer[s];
        const pi = p % NP;
        const pk = (p / NP) | 0;
        const v = sweep.veg;
        const veg = v[p] | (pi > 0 ? v[p - 1] : 0) | (pi < NP - 1 ? v[p + 1] : 0) | (pk > 0 ? v[p - NP] : 0) | (pk < NP - 1 ? v[p + NP] : 0);
        const light = w.suit.light(p, L);
        const val = w.suit.plant(s, p, slot, light, veg, false);
        if (val < MET) return false;
        const o1 = f.sp[p * LAYERS + L];
        if (o1 === 0) return true;
        const o = o1 - 1;
        return o !== s && val * t.rank[s] > w.suit.plant(o, p, slot, light, veg, false) * t.rank[o] * 0.5;
      };
      const STEP = 10;
      const YEARS = 1500;
      for (let y = 0; y < YEARS; y += STEP) {
        eco.debugAdvance(STEP);
        const now = eco.playSeconds;
        for (let s = 0; s < t.n; s++) {
          if (t.isWhale[s] || t.stormOnly[s] || cameAt[s] >= 0) continue;
          if (arrivals.sp[s].found) {
            cameAt[s] = now;
            continue;
          }
          if (metAt[s] >= 0) continue;
          for (let slot = 0; slot < isl.count && metAt[s] < 0; slot++) {
            if (!arrivals.reachable(s, slot)) continue;
            if (!t.isPlant[s]) {
              if (eco.debug.fauna.K(s, slot) >= 0.05) metAt[s] = now;
              continue;
            }
            const list = t.marine[s] ? isl.sea : isl.land;
            const a = t.marine[s] ? isl.seaStart[slot] : isl.landStart[slot];
            const b = t.marine[s] ? isl.seaStart[slot + 1] : isl.landStart[slot + 1];
            for (let i = a; i < b; i++) {
              if (stays(s, list[i], slot)) {
                metAt[s] = now;
                break;
              }
            }
          }
        }
      }
      const end = eco.playSeconds;
      // The scan above runs every STEP years: needs may have been met up to that long before it saw them.
      const slack = STEP / 2;
      let tested = 0;
      let worst = 0;
      const late: string[] = [];
      for (let s = 0; s < t.n; s++) {
        if (metAt[s] < 0) continue;
        const cap = STUCK_CAP[t.rarity[s]];
        const waited = (cameAt[s] >= 0 ? cameAt[s] : end) - metAt[s];
        if (cameAt[s] < 0 && waited < cap) continue;
        tested++;
        worst = Math.max(worst, waited / cap);
        if (waited > cap + slack) late.push(`${t.defs[s].key} waited ${Math.round(waited)} s (cap ${cap} s)`);
      }
      return {
        pass: tested >= 10 && late.length === 0,
        detail: `${tested} species measured from the moment their needs were met; longest wait ${(worst * 100).toFixed(0)}% of its cap${late.length ? `; late: ${late.join(', ')}` : ''}`,
      };
    },
  },
  {
    id: 'sand-burial',
    label: 'Trees live through sand poured a little at a time (and keep their soil); deep burial ends them',
    quick: false,
    run() {
      // A tree that roots in rock (as ʻōhiʻa does), happy anywhere else on the island.
      const sp = testCatalogue(['crust', 'ohia'], (d) =>
        d.key === 'ohia'
          ? { ...d, eco: { ...d.eco, rate: 0, substrate: [Substrate.Basalt, Substrate.Stone, Substrate.Limestone], moist: [0, 0, 1, 1], saltMax: 1, soil: [0.05, 0.1] } }
          : { ...d, eco: { ...d.eco, rate: 0 } },
      );
      const ohia = idOf(sp, 'ohia');
      const { cols, eco } = world((c) => {
        flatSea(c, 12);
        cone(c, 0, 0, 120, 30);
      }, sp);
      const f = eco.debug.w.f;
      // A grown forest on good soil, in three test rings.
      const ring = (x: number): number[] => {
        const out: number[] = [];
        for (let p = 0; p < NPATCH; p++) if (Math.hypot(patchX(p) - x, patchZ(p)) <= 10 && f.h[p] > 4) out.push(p);
        return out;
      };
      const rings = [ring(-40), ring(40), ring(0)];
      for (const r of rings) {
        for (const p of r) {
          f.sp[p * LAYERS + L_CANOPY] = ohia + 1;
          f.cov[p * LAYERS + L_CANOPY] = 1;
          f.soil[p] = 0.2;
        }
      }
      eco.debugAdvance(5);
      const state = (r: number[]): [number, number] => {
        let c = 0;
        let s = 0;
        for (const p of r) {
          c += f.sp[p * LAYERS + L_CANOPY] === ohia + 1 ? f.cov[p * LAYERS + L_CANOPY] : 0;
          s += f.soil[p];
        }
        return [c / r.length, s / r.length];
      };
      const before = rings.map(state);
      // Pour sand on each ring in 2 cm layers: 0.4 m, 1.0 m and 4 m.
      const depths = [0.4, 1.0, 4];
      const xs = [-40, 40, 0];
      for (let k = 0; k < 3; k++) {
        for (let d = 0; d < depths[k] - 1e-6; d += 0.02) {
          sandDisc(cols, xs[k], 0, 12, 0.02);
          cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
          eco.flushJobs();
        }
      }
      eco.debugAdvance(60);
      const after = rings.map(state);
      const ok =
        after[0][0] >= 0.8 * before[0][0] && after[0][1] >= 0.8 * before[0][1] && after[1][0] >= 0.8 * before[1][0] && after[1][1] >= 0.8 * before[1][1] && after[2][0] < 0.1;
      const fmtR = (i: number): string => `${depths[i]} m: canopy ${before[i][0].toFixed(2)}→${after[i][0].toFixed(2)}, soil ${before[i][1].toFixed(2)}→${after[i][1].toFixed(2)} m`;
      return { pass: ok, detail: [0, 1, 2].map(fmtR).join('; ') };
    },
  },
  {
    id: 'undo-sea-plants',
    label: 'Undoing new land leaves no land plants standing under the sea',
    quick: false,
    run() {
      const sp = eager(['searocket', 'glory'], 400);
      const { cols, grid, eco } = world((c) => {
        seabed(c);
        cay(c, -260, 250, 60, 4);
      }, sp);
      eco.debugAdvance(100);
      // Open an undo record and pour a sand spit out from the cay.
      const colSnaps = new Map<number, ColumnBlock>();
      const patchSnaps = new Map<number, PatchBlock>();
      cols.recordId = 1;
      grid.recordId = 1;
      cols.beforeModify = (b) => {
        colSnaps.set(b, cols.snapshotBlock(b));
        const pb = (b % BLOCKS_X) + ((b / BLOCKS_X) | 0) * PBLOCKS;
        if (!patchSnaps.has(pb)) patchSnaps.set(pb, grid.snapshotBlock(pb));
        grid.blockStamp[pb] = grid.recordId;
      };
      grid.beforeModify = (b) => {
        if (!patchSnaps.has(b)) patchSnaps.set(b, grid.snapshotBlock(b));
      };
      for (let x = -200; x <= -140; x += 4) {
        for (let k = 0; k < NZ; k++) {
          for (let i = 0; i < NX; i++) {
            if (Math.hypot(cols.cx(i) - x, cols.cz(k) - 250) > 10) continue;
            const c = i + k * NX;
            cols.touch(c);
            cols.sed[c] = Math.max(cols.sed[c], 1.5 - cols.rock[c]);
          }
        }
      }
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
      eco.debugAdvance(150);
      const f = eco.debug.w.f;
      const t = eco.debug.w.t;
      const spitPlants = (): number => {
        let n = 0;
        for (let p = 0; p < NPATCH; p++) {
          if (patchX(p) < -205 || patchX(p) > -135 || Math.abs(patchZ(p) - 250) > 12) continue;
          for (let L = 0; L < LAYERS; L++) if (f.sp[p * LAYERS + L] !== 0 && !t.marine[f.sp[p * LAYERS + L] - 1]) n++;
        }
        return n;
      };
      const grown = spitPlants();
      // Undo: the ground exactly, life merged; the hub then reports the restored ground.
      for (const s of colSnaps.values()) cols.restoreBlock(s);
      for (const s of patchSnaps.values()) grid.restoreBlock(s, (name, a, b) => eco.undoMerge(name, a, b));
      cols.recordId = -1;
      grid.recordId = -1;
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Look);
      eco.flushJobs();
      let drowned = 0;
      for (let p = 0; p < NPATCH; p++) {
        if (f.h[p] > 0) continue;
        for (let L = 0; L < LAYERS; L++) if (f.sp[p * LAYERS + L] !== 0 && !t.marine[f.sp[p * LAYERS + L] - 1]) drowned++;
      }
      return { pass: grown > 5 && drowned === 0, detail: `${grown} plant layers grew on the spit; ${drowned} land-plant layers left under the sea after undo` };
    },
  },
  {
    id: 'seabirds-cliffs',
    label: 'Seabirds settle only where there are sea cliffs or an islet',
    quick: false,
    run() {
      const sp = eager(['booby', 'lichen'], 10);
      const booby = idOf(sp, 'booby');
      const { eco } = world((c) => {
        flatSea(c, 14);
        cone(c, -200, 0, 110, 50, { cliffs: true });
        cone(c, 160, 0, 110, 30, { beaches: true });
        cone(c, 330, 250, 18, 14);
      }, sp);
      eco.debugAdvance(400);
      const { w } = eco.debug;
      const on = (x: number, z: number): boolean => {
        const id = w.f.isl[patchAt(x, z)];
        const slot = w.islands.slotOf[id];
        return slot >= 0 && w.pop[slot * w.t.n + booby] > 0;
      };
      const cliff = on(-200, 0);
      const smooth = on(160, 0);
      const islet = on(330, 250);
      return { pass: cliff && islet && !smooth, detail: `cliff island ${cliff ? 'yes' : 'no'}, islet ${islet ? 'yes' : 'no'}, gentle island ${smooth ? 'yes' : 'no'}` };
    },
  },
  {
    id: 'lava-burial-undo',
    label: 'Lava burns what it covers; undo brings that life back without rewinding the rest',
    quick: false,
    run() {
      const sp = eager(['crust', 'lichen', 'moss', 'amau', 'pili'], 20);
      const { cols, grid, eco } = world((c) => {
        seabed(c);
        cone(c, 40, -20, 110, 60);
      }, sp);
      eco.debugAdvance(700);
      const f = eco.debug.w.f;
      const zoneCover = (x: number, z: number, r: number): number => {
        let s = 0;
        for (let p = 0; p < NPATCH; p++) {
          if (Math.hypot(patchX(p) - x, patchZ(p) - z) <= r) for (let L = 0; L < LAYERS; L++) s += f.cov[p * LAYERS + L];
        }
        return s;
      };
      const before = zoneCover(70, -20, 20);
      // Open an undo record the way the hub does: snapshot column and patch blocks on first touch.
      const colSnaps = new Map<number, ColumnBlock>();
      const patchSnaps = new Map<number, PatchBlock>();
      cols.recordId = 1;
      grid.recordId = 1;
      cols.beforeModify = (b) => {
        colSnaps.set(b, cols.snapshotBlock(b));
        const pb = (b % BLOCKS_X) + ((b / BLOCKS_X) | 0) * PBLOCKS;
        if (!patchSnaps.has(pb)) patchSnaps.set(pb, grid.snapshotBlock(pb));
        grid.blockStamp[pb] = grid.recordId;
      };
      grid.beforeModify = (b) => {
        if (!patchSnaps.has(b)) patchSnaps.set(b, grid.snapshotBlock(b));
      };
      // Pour lava over a disc of living ground.
      for (let k = 0; k < NZ; k++) {
        for (let i = 0; i < NX; i++) {
          if (Math.hypot(cols.cx(i) - 70, cols.cz(k) + 20) > 20) continue;
          const c = i + k * NX;
          cols.touch(c);
          cols.lava[c] = 1.5;
          cols.temp[c] = 1;
        }
      }
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Burn | ChangeFlag.Tool);
      eco.flushJobs();
      const burned = zoneCover(70, -20, 20);
      // It cools into rock.
      for (let c = 0; c < NX * NZ; c++) {
        if (cols.lava[c] <= 0) continue;
        cols.touch(c);
        cols.rock[c] += cols.lava[c];
        cols.lava[c] = 0;
        cols.temp[c] = 0;
      }
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom);
      eco.debugAdvance(5);
      // Undo: ground exactly, life merged.
      for (const s of colSnaps.values()) cols.restoreBlock(s);
      for (const s of patchSnaps.values()) grid.restoreBlock(s, (name, a, b) => eco.undoMerge(name, a, b));
      cols.recordId = -1;
      grid.recordId = -1;
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Look);
      eco.flushJobs();
      const after = zoneCover(70, -20, 20);
      const elsewhere = zoneCover(20, -20, 15);
      const ok = before > 5 && burned < before * 0.05 && after >= before * 0.95 && elsewhere > 0;
      return { pass: ok, detail: `cover before ${before.toFixed(1)}, after lava ${burned.toFixed(1)}, after undo ${after.toFixed(1)}` };
    },
  },
  {
    id: 'storm-windward',
    label: 'A storm fells windward trees (more than twice the lee) and the forest grows back',
    quick: false,
    run() {
      // A grown forest of a tree that is happy all over the island (so only the storm decides).
      const sp = testCatalogue(['crust', 'ohia'], (d) => ({
        ...d,
        eco: { ...d.eco, rate: 0, moist: d.key === 'ohia' ? [0, 0, 1, 1] : d.eco.moist, soil: d.key === 'ohia' ? [0.05, 0.1] : d.eco.soil, saltMax: 1 },
      }));
      const ohia = idOf(sp, 'ohia');
      const { eco } = world((c) => {
        flatSea(c, 14);
        cone(c, 0, 0, 120, 40);
      }, sp);
      const f = eco.debug.w.f;
      for (let p = 0; p < NPATCH; p++) {
        if (f.h[p] <= 3) continue;
        f.sp[p * LAYERS + L_CANOPY] = ohia + 1;
        f.cov[p * LAYERS + L_CANOPY] = 1;
        f.soil[p] = 0.2;
      }
      eco.debugAdvance(20);
      const canopy = (side: number): number => {
        let s = 0;
        for (let p = 0; p < NPATCH; p++) if (f.h[p] > 3 && Math.sign(patchX(p)) === side && Math.abs(patchX(p)) > 20) s += f.cov[p * LAYERS + L_CANOPY];
        return s;
      };
      const wind0 = canopy(1);
      const lee0 = canopy(-1);
      eco.debugStormNow();
      for (let t = 0; t < 400 && (eco.storm.phase !== 'none' || t < 5); t++) {
        eco.advance(0.5);
        eco.work(1e9);
      }
      const wind1 = canopy(1);
      const lee1 = canopy(-1);
      eco.debugAdvance(240);
      const wind2 = canopy(1);
      const lossW = (wind0 - wind1) / Math.max(1e-6, wind0);
      const lossL = (lee0 - lee1) / Math.max(1e-6, lee0);
      const told = entries(eco).some((e) => e.kind === 'storm');
      const ok = wind0 > 20 && lossW > 2 * lossL && lossW > 0.03 && wind2 >= 0.9 * wind0 && told;
      return {
        pass: ok,
        detail: `windward canopy lost ${(lossW * 100).toFixed(0)}%, lee ${(lossL * 100).toFixed(0)}%; two minutes later windward at ${((wind2 / wind0) * 100).toFixed(0)}%; journal ${told ? 'tells it' : 'silent'}`,
      };
    },
  },
  {
    id: 'species-level-off',
    label: 'Left alone, an island fills up and its species count levels off',
    quick: false,
    run() {
      const { eco } = world((c) => highIsland(c, 0.6), TEST_SPECIES, 5);
      const counts: number[] = [];
      for (let i = 0; i < 16; i++) {
        eco.debugAdvance(250);
        counts.push(eco.debug.arrivals.foundCount);
      }
      const firstQ = counts[3] - 0;
      const lastQ = counts[15] - counts[11];
      return { pass: lastQ <= Math.max(1, 0.15 * firstQ), detail: `species over time: ${counts.join(' ')}` };
    },
  },
  {
    id: 'species-area',
    label: 'An island four times larger ends up with at least 1.3 times the species',
    quick: false,
    run() {
      const living = (r: number, h: number): number => {
        const { eco } = world((c) => {
          seabed(c);
          cone(c, 40, -20, r, h, { beaches: true });
        }, TEST_SPECIES, 9);
        eco.debugAdvance(3000);
        const life = eco.takeLife();
        return life ? Math.max(...life.islands.map((i) => i.species)) : 0;
      };
      // Same shape, four times the area (and so twice as tall, as real islands are).
      const small = living(50, 36);
      const big = living(100, 72);
      return { pass: big >= 1.3 * small, detail: `small island ${small} species living, four times the area ${big}` };
    },
  },
  {
    id: 'one-first-arrival',
    label: 'Every species gets exactly one first-arrival story',
    quick: false,
    run() {
      const { eco } = succession();
      // The last check to use the shared run: let it go (it holds a whole world).
      successionRun = null;
      const firsts = new Map<number, number>();
      for (const e of entries(eco)) if (e.params?.first === 1 && e.species !== undefined) firsts.set(e.species, (firsts.get(e.species) ?? 0) + 1);
      const sp = eco.debug.arrivals.sp;
      let found = 0;
      let bad = 0;
      sp.forEach((st, s) => {
        if (st.found) found++;
        if ((st.found ? 1 : 0) !== (firsts.get(s) ?? 0)) bad++;
      });
      return { pass: bad === 0 && found > 0, detail: `${found} species found, ${bad} with the wrong number of first stories` };
    },
  },
  {
    id: 'beat-sheet',
    label: 'The scripted high island keeps the beat sheet (first life, lichen, first story, first tree)',
    quick: false,
    run() {
      const { eco } = world((c) => highIsland(c, 0.75), TEST_SPECIES, 7);
      const f = eco.debug.w.f;
      let lichenAt = -1;
      let treeAt = -1;
      for (let y = 0; y < 1440 && treeAt < 0; y += 2) {
        eco.debugAdvance(2);
        if (lichenAt < 0) {
          const land = count(eco, () => true);
          if (count(eco, (p) => f.cov[p * LAYERS + L_GROUND] >= 0.3) >= land * 0.05) lichenAt = eco.playSeconds;
        }
        if (entries(eco).some((e) => e.first === 'first-tree')) treeAt = eco.playSeconds;
      }
      const j = entries(eco);
      const yearToSec = (year: number): number => year / 2;
      const firstArrival = j.find((e) => e.kind === 'arrival');
      const firstVisit = j.find((e) => e.kind === 'visit');
      const a = firstArrival ? yearToSec(firstArrival.year) : Infinity;
      const v = firstVisit ? yearToSec(firstVisit.year) : Infinity;
      const ok = a <= 20 && lichenAt >= 0 && lichenAt <= 120 && v <= 480 && treeAt >= 0 && treeAt <= 720;
      return { pass: ok, detail: `first arrival ${a.toFixed(0)} s, lichen visible ${lichenAt.toFixed(0)} s, first "couldn't stay" ${v.toFixed(0)} s, first tree ${treeAt.toFixed(0)} s` };
    },
  },
  {
    id: 'places-quick',
    label: 'A new beach and sea cliff are recognised within 3 s of the land settling',
    quick: true,
    run() {
      const { cols, eco } = world((c) => flatSea(c, 14), TEST_SPECIES);
      cone(cols, 0, 0, 100, 40, { cliffs: true, beaches: true });
      cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool);
      const got = new Set<string>();
      let t = 0;
      for (; t < 6 && !(got.has('beach') && got.has('sea-cliff')); t += 0.1) {
        eco.advance(0.1);
        eco.work(50);
        const out: PlaceEvent[] = [];
        eco.takePlaces(out);
        for (const e of out) got.add(e.kind);
      }
      return { pass: got.has('beach') && got.has('sea-cliff') && t <= 3, detail: `recognised after ${t.toFixed(1)} s: ${[...got].join(', ')}` };
    },
  },
  {
    id: 'look-explains',
    label: 'Look explains young ground ("too thin", "fresh rock") in plain words',
    quick: true,
    run() {
      const { eco } = world((c) => {
        flatSea(c, 14);
        cone(c, 0, 0, 100, 40);
      }, TEST_SPECIES);
      const info = eco.inspect(30, 0);
      const ok = typeof info.why === 'string' && info.why.length > 5 && info.substrate === Substrate.Basalt && info.habitat !== Habitat.None;
      return { pass: ok, detail: `"${info.why ?? ''}" (${info.height.toFixed(1)} m, habitat ${info.habitat})` };
    },
  },
  {
    id: 'save-restore',
    label: 'Saving and loading keeps the year, the journal and the islands',
    quick: false,
    run() {
      const a = world((c) => highIsland(c, 0.6), TEST_SPECIES, 4);
      a.eco.debugAdvance(400);
      const save = JSON.parse(JSON.stringify(a.eco.serialize()));
      const b = world((c) => highIsland(c, 0.6), TEST_SPECIES, 4);
      for (const f of a.grid.persistentFields()) (b.grid.get(f.name) as typeof f.arr).set(f.arr);
      b.eco.restore(save);
      const ja = a.eco.journalAll().map((e) => `${e.id}:${e.kind}:${e.year}:${e.species ?? ''}`).join('|');
      const jb = b.eco.journalAll().map((e) => `${e.id}:${e.kind}:${e.year}:${e.species ?? ''}`).join('|');
      const la = a.eco.takeLife();
      const lb = b.eco.takeLife();
      // Saving the loaded world again gives the same save.
      const again = JSON.stringify(b.eco.serialize()) === JSON.stringify(save);
      let same = true;
      for (const f of a.grid.persistentFields()) {
        const g = b.grid.get(f.name);
        for (let i = 0; i < f.arr.length && same; i++) if (f.arr[i] !== g[i]) same = false;
      }
      // And the loaded world carries on living.
      b.eco.debugAdvance(100);
      const ok = ja === jb && again && same && a.eco.year + 100 === b.eco.year && la !== null && lb !== null && la.islands.length === lb.islands.length && la.found === lb.found;
      return { pass: ok, detail: `year ${a.eco.year}, journal ${ja === jb ? 'same' : 'different'}, species ${la?.found} / ${lb?.found}, save again ${again ? 'identical' : 'different'}, life arrays ${same ? 'identical' : 'different'}` };
    },
  },
  {
    id: 'performance',
    label: 'One year of one patch costs at most 4 microseconds on a laptop',
    quick: true,
    run() {
      const { eco } = world((c) => highIsland(c, 0.5), TEST_SPECIES, 2);
      eco.debugAdvance(120);
      const { sweep } = eco.debug;
      let best = Infinity;
      for (let rep = 0; rep < 5; rep++) {
        const t0 = performance.now();
        eco.debugAdvance(10);
        const ms = performance.now() - t0;
        best = Math.min(best, (ms * 1000) / Math.max(1, 10 * sweep.processed));
      }
      const phone = typeof navigator !== 'undefined' && /Android|iPhone|Mobile/i.test(navigator.userAgent);
      const limit = phone ? 16 : 4;
      return { pass: best <= limit, detail: `${best.toFixed(2)} µs per patch-year (${sweep.processed} of ${eco.activePatches} active patches busy; limit ${limit} µs)` };
    },
  },
]);
