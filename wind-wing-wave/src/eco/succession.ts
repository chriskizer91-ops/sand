/**
 * Succession: the yearly sweep over every living patch (ARCHITECTURE §3, ecology.md §4).
 *
 * One sweep = one year (ECO_STEP_YEARS) for the whole active set, in a fixed order. The work
 * is spread over many work() calls within the time budget, but it behaves as one step:
 * - a patch reads its neighbours as they were when the step began: each patch keeps a copy of
 *   itself from just before it is processed, and later neighbours read that copy, so the
 *   visiting order never changes the outcome;
 * - island tallies are kept in a running copy and handed to everyone else only when the step
 *   ends (world.ts).
 *
 * Per patch and layer (canopy first, so the light below is known):
 * - an occupied layer grows toward its suitability with the exact logistic, or relaxes down
 *   when the place stops suiting it; at the end of a plant's life a better-placed challenger
 *   (shade-tolerant, later species) may take over: pioneers give way. Same-species renewal is
 *   invisible: nothing changes on screen;
 * - an empty layer may be colonised by spread from a neighbour or by seed rain from the
 *   island's own plants (wind anywhere, birds near perches, the sea along the shore).
 * Then soil, fertility, weathering, guano, logs and char move on.
 *
 * Quiet patches (nothing changing, nothing at the door) are revisited only every 8th step,
 * with an 8-year step; the exact maths keeps that honest. Each patch remembers what it added
 * to its island's tally, so a quiet patch costs nothing at all: only patches that are visited
 * take their old share away and add the new one. Every so often (always right after the
 * islands change) one step counts everything afresh.
 */
import { NP } from '../config';
import { Habitat, HABITAT_COUNT, Substrate } from '../content/speciesTypes';
import { RoadBit } from './catalog';
import { moistureOf } from './climate';
import { Flag, L_CANOPY, L_GROUND, L_HERB, L_SHRUB, LAYERS, NPATCH, habBit, type EcoFields } from './fields';
import { clamp01, hrand, logistic, relax } from './maths';
import { PERCH_N, type EcoWorld, type Tally } from './world';

/** Years for a plant to fade once a place stops suiting it. */
const DECLINE_TAU = 6;
/** Cover a new seedling patch starts with. */
const SEEDLING = 0.05;
/** Lowest suitability at which a seed can take. */
const TAKE = 0.2;
const QUIET_AFTER = 3;
/** The longest step a quiet patch takes when its turn comes (years). */
const MAX_DT = 16;
const MAXP = 12;
/** Seed rain per patch-year at full island abundance, by road. */
const RAIN_WIND = 0.00012;
const RAIN_BIRD = 0.0001;
const RAIN_SEA = 0.00025;
/** Share of the plants' organic matter (EcoGives.soil) kept as soil, on dry and on wet ground. */
const SOIL_KEPT_DRY = 0.12;
const SOIL_KEPT_WET = 0.36;
/** Soil that makes a closed canopy a real forest (not a grove on bare sand or new lava). */
export const REAL_FOREST_SOIL = 0.1;
/** One step of the cover each patch adds to its island's tally. */
const COV_UNIT = 1 / 65535;
/** Count everything afresh at least this often (steps), so the running sums never drift. */
const RECOUNT_EVERY = 64;

const VEG_BITS =
  habBit(Habitat.Grass) | habBit(Habitat.Scrub) | habBit(Habitat.Forest) | habBit(Habitat.WetForest) | habBit(Habitat.CloudForest) | habBit(Habitat.Crust) | habBit(Habitat.Mangrove);
const GEO_LAND_KEEP =
  habBit(Habitat.Beach) |
  habBit(Habitat.Dune) |
  habBit(Habitat.RockShore) |
  habBit(Habitat.Cliff) |
  habBit(Habitat.Pond) |
  habBit(Habitat.SaltPond) |
  habBit(Habitat.Marsh) |
  habBit(Habitat.Stream) |
  habBit(Habitat.Summit) |
  habBit(Habitat.HotLava);
const GEO_SEA_KEEP = habBit(Habitat.OpenSea) | habBit(Habitat.DeepSea) | habBit(Habitat.Lagoon) | habBit(Habitat.Sound);

/** What a patch adds to its island's tally, besides its habitats and plant cover. */
const B_LAND = 1;
const B_COOL = 2;
const B_FOREST = 4;
const B_REAL = 8;
const B_TREE = 16;
const B_SHRUB = 32;
const B_HERB = 64;
const B_CORAL = 128;
const B_SEAGRASS = 256;
const B_CLOUD = 512;
const B_SEACLIFF = 1024;

/** exp(-dt / tau) for the whole-year steps a patch can take (dt = 1..MAX_DT). */
function decayTable(tau: number): Float64Array {
  const a = new Float64Array(MAX_DT + 1);
  for (let dt = 0; dt <= MAX_DT; dt++) a[dt] = Math.exp(-dt / tau);
  return a;
}
const E_CHAR = decayTable(60);
const E_LOGS = decayTable(80);
const E_WARM = decayTable(90);
const E_GUANO = decayTable(25);
const E_FERT = decayTable(150);
const E_DECLINE = decayTable(DECLINE_TAU);

/**
 * A roll that comes up with probability 1 - e^(-rate * dt), for a uniform number u.
 * Since that probability is never more than rate * dt, most rolls are settled without the
 * exponential, with exactly the same outcome.
 */
function rolls(u: number, rate: number, dt: number): boolean {
  const x = rate * dt;
  if (u >= x) return false;
  return u < 1 - Math.exp(-x);
}

/**
 * Seed rain pools: per island and layer, the island's own plants weighted by how much of
 * them there is, one pool per way seeds travel (wind, birds, sea).
 */
export class Pools {
  slots = 0;
  count = new Uint8Array(0);
  sp = new Int16Array(0);
  cum = new Float32Array(0);
  total = new Float32Array(0);

  /** Pool index for (slot, layer, mode). */
  static at(slot: number, L: number, mode: number): number {
    return (slot * LAYERS + L) * 3 + mode;
  }

  build(w: EcoWorld): void {
    const t = w.t;
    const slots = w.islands.count;
    const n = Math.max(1, slots) * LAYERS * 3;
    if (this.count.length < n) {
      this.count = new Uint8Array(n);
      this.sp = new Int16Array(n * MAXP);
      this.cum = new Float32Array(n * MAXP);
      this.total = new Float32Array(n);
    }
    this.slots = slots;
    this.count.fill(0);
    this.total.fill(0);
    const cover = w.cur.cover;
    for (let slot = 0; slot < slots; slot++) {
      for (let s = 0; s < t.n; s++) {
        if (!t.isPlant[s]) continue;
        const a = Math.min(1, cover[slot * t.n + s] / 30);
        if (a <= 0.001) continue;
        const L = t.layer[s];
        const r = t.roads[s];
        if (r & (RoadBit.wind | RoadBit.storm)) this.add(Pools.at(slot, L, 0), s, a);
        if (r & RoadBit.bird) this.add(Pools.at(slot, L, 1), s, a);
        if (r & (RoadBit.sea | RoadBit.raft)) this.add(Pools.at(slot, L, 2), s, a);
      }
    }
  }

  private add(i: number, s: number, a: number): void {
    const c = this.count[i];
    if (c >= MAXP) return;
    const base = i * MAXP;
    this.total[i] += a;
    this.sp[base + c] = s;
    this.cum[base + c] = this.total[i];
    this.count[i] = c + 1;
  }

  /** Pick a species from pool i by a uniform number u in [0, 1). */
  pick(i: number, u: number): number {
    const c = this.count[i];
    const base = i * MAXP;
    const x = u * this.total[i];
    for (let k = 0; k < c; k++) if (x < this.cum[base + k]) return this.sp[base + k];
    return this.sp[base + c - 1];
  }
}

export class Sweep {
  readonly active = new Int32Array(NPATCH);
  activeN = 0;
  /** Patch -> 1 if in the active set. */
  readonly inSet = new Uint8Array(NPATCH);
  readonly quiet = new Uint8Array(NPATCH);
  readonly last = new Int32Array(NPATCH);
  /** Vegetation habitats per patch (forest, scrub, grass...), for neighbours' habitat needs. */
  readonly veg = new Uint32Array(NPATCH);
  /** Signature of the bytes packed for the page, to notice real visible change. */
  readonly sig = new Uint32Array(NPATCH);
  readonly pools = new Pools();
  /** The step in which each patch was last processed, and its state from just before. */
  private readonly stamp = new Int32Array(NPATCH).fill(-1);
  private readonly spPrev = new Uint8Array(NPATCH * LAYERS);
  private readonly covPrev = new Float32Array(NPATCH * LAYERS);
  private readonly vegPrev = new Uint32Array(NPATCH);
  /** What each patch last added to the running tally (slot -1: nothing). */
  private readonly tSlot = new Int16Array(NPATCH).fill(-1);
  private readonly tMask = new Uint32Array(NPATCH);
  private readonly tBits = new Uint16Array(NPATCH);
  private readonly tSp = new Uint8Array(NPATCH * LAYERS);
  /** Cover added, in 1/65535 steps (added and taken away as exactly the same number). */
  private readonly tCov = new Uint16Array(NPATCH * LAYERS);
  /** Per island slot: how wide the island is, for its fresh-water lens (set each step). */
  private wide = new Float32Array(8);
  private cursor = 0;
  inProgress = false;
  /** The next step counts every active patch afresh (set when the islands change). */
  recountDue = true;
  private recounting = false;
  /** Patch-steps actually processed (not quiet) in the last finished sweep, for stats. */
  processed = 0;
  private processing = 0;
  private stepIdx = 0;
  private f: EcoFields;

  constructor(private w: EcoWorld) {
    this.f = w.f;
  }

  /** Replace the active set (sorted patch list). Only between steps. */
  setActive(list: Int32Array, n: number): void {
    const step = this.w.step;
    const was = this.inSet;
    // Patches that join the set start fresh; those that stay keep their quiet count and clock.
    for (let i = 0; i < n; i++) {
      const p = list[i];
      if (was[p] !== 1) {
        this.quiet[p] = 0;
        this.last[p] = step - 1;
      }
    }
    for (let i = 0; i < this.activeN; i++) {
      const p = this.active[i];
      was[p] = 0;
      this.tSlot[p] = -1;
    }
    for (let i = 0; i < n; i++) {
      this.active[i] = list[i];
      was[list[i]] = 1;
    }
    this.activeN = n;
    this.recountDue = true;
  }

  /** After loading a save: every patch's clock starts at `step`, all of them awake. */
  restart(step: number): void {
    this.last.fill(step - 1);
    this.quiet.fill(0);
    this.stamp.fill(-1);
    this.inProgress = false;
    this.cursor = 0;
    this.recountDue = true;
  }

  /** Make a patch busy again (terrain change, arrival, storm). */
  wake(p: number): void {
    this.quiet[p] = 0;
  }

  /** Start a new step. */
  begin(): void {
    const w = this.w;
    this.stepIdx = w.step;
    this.cursor = 0;
    this.processing = 0;
    this.inProgress = true;
    this.recounting = this.recountDue || this.stepIdx % RECOUNT_EVERY === 0;
    this.recountDue = false;
    if (this.recounting) w.run.clear();
    this.islandWidths();
  }

  /**
   * Count every active patch into fresh tallies and refresh its habitats, without growing
   * anything (after building or loading a world). The caller hands the tallies on.
   */
  census(): void {
    const w = this.w;
    const f = this.f;
    this.stepIdx = w.step;
    this.islandWidths();
    this.recounting = true;
    w.run.clear();
    for (let i = 0; i < this.activeN; i++) {
      const p = this.active[i];
      const land = f.h[p] > 0;
      const slot = w.slotOfPatch(p);
      f.moist[p] = land ? moistureOf(f, p, f.soil[p], slot >= 0 ? this.wide[slot] : 0) : 1;
      this.masks(p, land);
      this.contribute(p);
      this.signature(p);
    }
    this.recounting = false;
    this.recountDue = false;
  }

  /** Continue the sweep until `deadline` (ms clock). Returns true when the step is complete. */
  some(deadline: number, now: () => number): boolean {
    const act = this.active;
    const n = this.activeN;
    const step = this.stepIdx;
    while (this.cursor < n) {
      const end = Math.min(n, this.cursor + 160);
      for (let i = this.cursor; i < end; i++) {
        const p = act[i];
        if (this.quiet[p] >= QUIET_AFTER && ((p + step) & 7) !== 0) {
          if (this.recounting) this.contribute(p);
        } else {
          let dt = step - this.last[p];
          if (dt < 1) dt = 1;
          else if (dt > MAX_DT) dt = MAX_DT;
          this.last[p] = step;
          this.process(p, dt);
          this.processing++;
        }
      }
      this.cursor = end;
      if (this.cursor < n && now() > deadline) return false;
    }
    this.inProgress = false;
    this.recounting = false;
    this.processed = this.processing;
    return true;
  }

  // ---------- one patch ----------

  private process(p: number, dt: number): void {
    const w = this.w;
    const f = this.f;
    const t = w.t;
    const suit = w.suit;
    const seed = w.seed;
    const step = this.stepIdx;
    const o = p * LAYERS;
    const sp = f.sp;
    const cov = f.cov;
    // Keep this patch as it was, for neighbours visited later in the same step.
    this.spPrev[o] = sp[o];
    this.spPrev[o + 1] = sp[o + 1];
    this.spPrev[o + 2] = sp[o + 2];
    this.spPrev[o + 3] = sp[o + 3];
    this.covPrev[o] = cov[o];
    this.covPrev[o + 1] = cov[o + 1];
    this.covPrev[o + 2] = cov[o + 2];
    this.covPrev[o + 3] = cov[o + 3];
    this.vegPrev[p] = this.veg[p];
    this.stamp[p] = step;
    const h = f.h[p];
    const land = h > 0;
    const slot = w.slotOfPatch(p);
    const sub = f.sub[p];
    f.moist[p] = land ? moistureOf(f, p, f.soil[p], slot >= 0 ? this.wide[slot] : 0) : 1;
    let changed = false;
    let busy = false;
    if (sub === Substrate.HotLava) {
      for (let L = 0; L < LAYERS; L++) {
        if (sp[o + L] !== 0) {
          sp[o + L] = 0;
          cov[o + L] = 0;
          changed = true;
        }
      }
    } else {
      const pi = p % NP;
      const pk = (p / NP) | 0;
      const veg = this.vegAt(p) | (pi > 0 ? this.vegAt(p - 1) : 0) | (pi < NP - 1 ? this.vegAt(p + 1) : 0) | (pk > 0 ? this.vegAt(p - NP) : 0) | (pk < NP - 1 ? this.vegAt(p + NP) : 0);
      for (let L = L_CANOPY; L >= L_GROUND; L--) {
        const light = suit.light(p, L);
        const s1 = sp[o + L];
        if (s1 !== 0) {
          const s = s1 - 1;
          const K = suit.plant(s, p, slot, light, veg, false);
          const c0 = cov[o + L];
          let c = K >= c0 ? logistic(c0, K, t.gr[s], dt) : K + (c0 - K) * E_DECLINE[dt];
          if (c < 0.015 && K < 0.05) {
            sp[o + L] = 0;
            cov[o + L] = 0;
            changed = true;
            continue;
          }
          // End of a life: a better-placed newcomer may take over (pioneers give way).
          if (rolls(hrand(p, step, 10 + L, seed), 1 / t.life[s], dt)) {
            const ch = this.challenger(p, L, s, K, slot, light, veg);
            if (ch >= 0) {
              sp[o + L] = ch + 1;
              c = Math.min(c * 0.4, 0.3);
              changed = true;
            }
          }
          cov[o + L] = c;
          if (c - c0 > 0.002 * dt || c0 - c > 0.002 * dt) busy = true;
        } else if (this.colonise(p, L, slot, light, veg, dt)) {
          changed = true;
        }
      }
    }
    this.ground(p, dt, land);
    this.masks(p, land);
    this.contribute(p);
    if (changed || busy) this.quiet[p] = 0;
    else if (this.quiet[p] < 255) this.quiet[p]++;
    if (changed) {
      const pi = p % NP;
      const pk = (p / NP) | 0;
      if (pi > 0) this.quiet[p - 1] = 0;
      if (pi < NP - 1) this.quiet[p + 1] = 0;
      if (pk > 0) this.quiet[p - NP] = 0;
      if (pk < NP - 1) this.quiet[p + NP] = 0;
    }
    this.signature(p);
  }

  /** A neighbour's vegetation habitats as they were when this step began. */
  private vegAt(q: number): number {
    return this.stamp[q] === this.stepIdx ? this.vegPrev[q] : this.veg[q];
  }

  /** A neighbour's species byte (id + 1) in layer L as it was when this step began. */
  private spAt(q: number, L: number): number {
    const i = q * LAYERS + L;
    return this.stamp[q] === this.stepIdx ? this.spPrev[i] : this.f.sp[i];
  }

  private covAt(q: number, L: number): number {
    const i = q * LAYERS + L;
    return this.stamp[q] === this.stepIdx ? this.covPrev[i] : this.f.cov[i];
  }

  /** A newcomer that would do better here than the current occupant, or -1. */
  private challenger(p: number, L: number, s: number, K: number, slot: number, light: number, veg: number): number {
    const t = this.w.t;
    const suit = this.w.suit;
    const occupant = K * t.rank[s];
    let best = -1;
    let bestScore = occupant * 1.08 + 0.02;
    const pi = p % NP;
    const pk = (p / NP) | 0;
    for (let k = 0; k < 4; k++) {
      let q: number;
      if (k === 0) q = pi > 0 ? p - 1 : -1;
      else if (k === 1) q = pi < NP - 1 ? p + 1 : -1;
      else if (k === 2) q = pk > 0 ? p - NP : -1;
      else q = pk < NP - 1 ? p + NP : -1;
      if (q < 0) continue;
      const c1 = this.spAt(q, L);
      if (c1 === 0 || c1 - 1 === s) continue;
      const c = c1 - 1;
      const sc = suit.plant(c, p, slot, light, veg, false) * t.rank[c];
      if (sc > bestScore) {
        bestScore = sc;
        best = c;
      }
    }
    if (slot >= 0) {
      const pool = this.pools;
      for (let mode = 0; mode < 3; mode++) {
        const i = Pools.at(slot, L, mode);
        if (pool.count[i] === 0) continue;
        const c = pool.pick(i, hrand(p, this.stepIdx, 40 + mode, this.w.seed));
        if (c === s) continue;
        const sc = suit.plant(c, p, slot, light, veg, false) * t.rank[c];
        if (sc > bestScore) {
          bestScore = sc;
          best = c;
        }
      }
    }
    return best;
  }

  /** Try to seed an empty layer. Returns true if something took. */
  private colonise(p: number, L: number, slot: number, light: number, veg: number, dt: number): boolean {
    const w = this.w;
    const f = this.f;
    const t = w.t;
    const suit = w.suit;
    const seed = w.seed;
    const step = this.stepIdx;
    const pi = p % NP;
    const pk = (p / NP) | 0;
    let best = -1;
    let bestV = TAKE;
    // Microsites: logs nurse seedlings of shrubs and trees; crust and moss nurse ferns.
    let boost = 1;
    if (L >= L_SHRUB) boost += 2 * f.logs[p];
    else if (L === L_HERB && f.cov[p * LAYERS] >= 0.3) boost += 0.5;
    let tried0 = -1;
    let tried1 = -1;
    for (let k = 0; k < 4; k++) {
      let q: number;
      if (k === 0) q = pi > 0 ? p - 1 : -1;
      else if (k === 1) q = pi < NP - 1 ? p + 1 : -1;
      else if (k === 2) q = pk > 0 ? p - NP : -1;
      else q = pk < NP - 1 ? p + NP : -1;
      if (q < 0) continue;
      const c1 = this.spAt(q, L);
      if (c1 === 0) continue;
      const s = c1 - 1;
      if (s === tried0 || s === tried1) continue;
      let rate = (t.spread[s] / 10) * this.covAt(q, L) * boost;
      if (f.flags[q] & Flag.Kipuka) rate *= 2;
      if (!rolls(hrand(p, step, 20 + L * 4 + k, seed), rate, dt)) continue;
      tried1 = tried0;
      tried0 = s;
      const v = suit.plant(s, p, slot, light, veg, false);
      if (v > bestV) {
        bestV = v;
        best = s;
      }
    }
    if (slot >= 0) {
      const pool = this.pools;
      const fl = f.flags[p];
      for (let mode = 0; mode < 3; mode++) {
        const i = Pools.at(slot, L, mode);
        const tot = pool.total[i];
        if (tot <= 0) continue;
        let rate: number;
        if (mode === 0) rate = RAIN_WIND * tot;
        else if (mode === 1) rate = RAIN_BIRD * tot * (0.25 + this.covAt(p, L_CANOPY) + (fl & Flag.Cliff ? 0.5 : 0) + (f.colony[p] > 0 ? 0.8 : 0));
        else rate = fl & (Flag.Shore | Flag.NearSea) ? RAIN_SEA * tot : 0;
        if (rate <= 0) continue;
        if (!rolls(hrand(p, step, 60 + L * 4 + mode, seed), rate * boost, dt)) continue;
        const s = pool.pick(i, hrand(p, step, 80 + L * 4 + mode, seed));
        if (s === tried0 || s === tried1) continue;
        const v = suit.plant(s, p, slot, light, veg, false);
        if (v > bestV) {
          bestV = v;
          best = s;
        }
      }
    }
    if (best < 0) return false;
    f.sp[p * LAYERS + L] = best + 1;
    f.cov[p * LAYERS + L] = Math.min(SEEDLING, bestV);
    return true;
  }

  // ---------- soil and the slow things ----------

  private ground(p: number, dt: number, land: boolean): void {
    const f = this.f;
    const t = this.w.t;
    const o = p * LAYERS;
    const cov = f.cov;
    const sp = f.sp;
    if (f.char[p] > 0) f.char[p] *= E_CHAR[dt];
    if (f.logs[p] > 0) f.logs[p] *= E_LOGS[dt];
    if (f.warm[p] > 0) f.warm[p] *= E_WARM[dt];
    const col = f.colony[p];
    if (f.guano[p] !== col) f.guano[p] = col + (f.guano[p] - col) * E_GUANO[dt];
    if (!land) return;
    const m = f.moist[p];
    const bot = f.bot[p];
    const kSub = bot === Substrate.Basalt ? 1 : bot === Substrate.Limestone ? 0.5 : bot === Substrate.Stone ? 0.15 : 0;
    if (kSub > 0 && f.wthr[p] < 1) f.wthr[p] = relax(f.wthr[p], 1, 900 / (kSub * (0.3 + m)), dt);
    const g = cov[o];
    const herb = cov[o + 1];
    const shrub = cov[o + 2];
    const can = cov[o + 3];
    let soil = f.soil[p];
    // Weathering: rain, warmth and lichens crumble rock; old basalt fastest, placed stone slowest,
    // sand none. It is a little cooler (slower) up high.
    const warmth = 1 - 0.4 * Math.min(1, f.h[p] / 180);
    const weather = 0.5e-5 * kSub * (0.25 + m) * warmth * (1 + 1.5 * g) * Math.max(0, 1 - soil / 0.6);
    // Organic matter from the plants (their own `gives.soil` when the catalogue sets it).
    let organic = 0;
    let fix = 0;
    for (let L = 0; L < LAYERS; L++) {
      const s1 = sp[o + L];
      if (s1 === 0) continue;
      const s = s1 - 1;
      const c = cov[o + L];
      organic += (t.givesSoil[s] > 0 ? t.givesSoil[s] / 100 : 3.5e-5 * (L === 0 ? 0.3 : L === 1 ? 0.5 : L === 2 ? 0.8 : 1)) * c;
      fix += t.givesN[s] * c;
    }
    // Only part of what the plants shed stays as soil (the rest rots away, washes off or blows
    // away): more in the wet, where it lies damp and keeps. This retention is what sets the
    // pace of the soil ladder against the beat sheet (tools/simulate.ts).
    organic *= SOIL_KEPT_DRY + (SOIL_KEPT_WET - SOIL_KEPT_DRY) * m;
    const total = g + herb + shrub + can;
    const sl = f.slope[p];
    const erosion = sl > 30 ? 6e-5 * ((sl - 30) / 30) * ((sl - 30) / 30) * (0.3 + f.rain[p]) * Math.max(0, 1 - total) : 0;
    soil += (weather + organic + 2e-4 * f.guano[p] - erosion) * dt;
    f.soil[p] = soil < 0 ? 0 : soil > 1.5 ? 1.5 : soil;
    // One merged richness: weathered basalt is the richest ground; guano and fixers add.
    const wt = f.wthr[p];
    const base = bot === Substrate.Basalt ? 0.25 + 0.55 * wt : bot === Substrate.Stone ? 0.12 + 0.2 * wt : bot === Substrate.Limestone ? 0.2 + 0.2 * wt : 0.1;
    const target = clamp01(base + 0.5 * f.guano[p] + 0.4 * fix + 0.15 * Math.min(1, soil / 0.3));
    f.fert[p] = target + (f.fert[p] - target) * E_FERT[dt];
  }

  // ---------- habitats ----------

  private masks(p: number, land: boolean): void {
    const f = this.f;
    const t = this.w.t;
    const o = p * LAYERS;
    const cov = f.cov;
    const sp = f.sp;
    const geo = f.geoMask[p];
    const fl = f.flags[p];
    const g = cov[o];
    const herb = cov[o + 1];
    const shrub = cov[o + 2];
    const can = cov[o + 3];
    const canSp = sp[o + 3] - 1;
    const mangrove = canSp >= 0 && t.isMangrove[canSp] === 1;
    let m: number;
    let hab: number;
    if (land) {
      m = geo & GEO_LAND_KEEP;
      if (can >= 0.4 && !mangrove) {
        m |= habBit(Habitat.Forest);
        if (f.moist[p] >= 0.62) m |= habBit(Habitat.WetForest);
        if (fl & Flag.CloudBelt && f.fog[p] >= 0.3) m |= habBit(Habitat.CloudForest);
      }
      if (mangrove && can >= 0.25) m |= habBit(Habitat.Mangrove);
      if (shrub >= 0.3) m |= habBit(Habitat.Scrub);
      const herbSp = sp[o + 1] - 1;
      if ((herb >= 0.3 && herbSp >= 0 && t.grassy[herbSp]) || herb >= 0.5) m |= habBit(Habitat.Grass);
      const rock = f.bot[p] !== Substrate.Sand && f.bot[p] !== Substrate.HotLava;
      const total = g + herb + shrub + can;
      if (rock && g >= 0.3 && herb + shrub + can < 0.3) m |= habBit(Habitat.Crust);
      if (rock && total < 0.25 && !(fl & Flag.Pond)) m |= habBit(Habitat.BareRock);
      // Dominant code for the page.
      if (m & habBit(Habitat.HotLava)) hab = Habitat.HotLava;
      else if (fl & Flag.SaltPond) hab = Habitat.SaltPond;
      else if (fl & Flag.Pond && f.sub[p] === Substrate.Pond) hab = Habitat.Pond;
      else if (fl & Flag.Stream) hab = Habitat.Stream;
      else if (fl & Flag.Marsh) hab = Habitat.Marsh;
      else if (m & habBit(Habitat.Mangrove)) hab = Habitat.Mangrove;
      else if (fl & Flag.Cliff) hab = Habitat.Cliff;
      else if (m & habBit(Habitat.CloudForest)) hab = Habitat.CloudForest;
      else if (m & habBit(Habitat.WetForest)) hab = Habitat.WetForest;
      else if (m & habBit(Habitat.Forest)) hab = Habitat.Forest;
      else if (fl & Flag.Beach && herb + shrub < 0.6) hab = Habitat.Beach;
      else if (fl & Flag.Dune && shrub < 0.3) hab = Habitat.Dune;
      else if (m & habBit(Habitat.Scrub)) hab = Habitat.Scrub;
      else if (m & habBit(Habitat.Grass)) hab = Habitat.Grass;
      else if (fl & Flag.RockShore) hab = Habitat.RockShore;
      else if (fl & Flag.Summit) hab = Habitat.Summit;
      else if (m & habBit(Habitat.Crust)) hab = Habitat.Crust;
      else if (fl & Flag.Beach) hab = Habitat.Beach;
      else if (!rock) hab = Habitat.Dune;
      else hab = Habitat.BareRock;
    } else {
      m = geo & GEO_SEA_KEEP;
      if (mangrove && can >= 0.25) m |= habBit(Habitat.Mangrove);
      if (shrub >= 0.2 && sp[o + 2] !== 0) m |= habBit(Habitat.Reef);
      if (herb >= 0.25 && sp[o + 1] !== 0) m |= habBit(Habitat.Seagrass);
      if (m & habBit(Habitat.Mangrove)) hab = Habitat.Mangrove;
      else if (m & habBit(Habitat.Reef)) hab = Habitat.Reef;
      else if (m & habBit(Habitat.Seagrass)) hab = Habitat.Seagrass;
      else if (m & habBit(Habitat.Sound)) hab = Habitat.Sound;
      else if (m & habBit(Habitat.Lagoon)) hab = Habitat.Lagoon;
      else hab = f.h[p] < -25 ? Habitat.DeepSea : Habitat.OpenSea;
    }
    f.lifeMask[p] = m;
    f.hab[p] = hab;
    this.veg[p] = m & VEG_BITS;
  }

  // ---------- island tallies ----------

  /** Per island slot, how wide the island is (fresh-water lens under sand), for this step. */
  private islandWidths(): void {
    const isl = this.w.islands;
    if (this.wide.length < isl.count) this.wide = new Float32Array(isl.count + 8);
    for (let slot = 0; slot < isl.count; slot++) this.wide[slot] = Math.min(1, isl.rec(slot).area / 20000);
  }

  /**
   * Bring patch p's share of its island's running tally up to date: take away what it added
   * last time (unless the step counts afresh) and add what it holds now.
   */
  private contribute(p: number): void {
    const w = this.w;
    const T: Tally = w.run;
    const f = this.f;
    const t = w.t;
    const nS = t.n;
    const o = p * LAYERS;
    if (!this.recounting) this.withdraw(p, T);
    const slot = w.slotOfPatch(p);
    if (slot < 0) {
      this.tSlot[p] = -1;
      return;
    }
    let m = f.lifeMask[p];
    this.tMask[p] = m;
    const hb = slot * HABITAT_COUNT;
    while (m !== 0) {
      T.hab[hb + 31 - Math.clz32(m & -m)]++;
      m &= m - 1;
    }
    for (let L = 0; L < LAYERS; L++) {
      const s1 = f.sp[o + L];
      const q = Math.round(f.cov[o + L] * 65535);
      this.tSp[o + L] = s1;
      this.tCov[o + L] = q;
      if (s1 !== 0) T.cover[slot * nS + s1 - 1] += q * COV_UNIT;
    }
    const land = f.h[p] > 0;
    const can = f.cov[o + 3];
    const fl = f.flags[p];
    let bits = 0;
    if (land) {
      bits |= B_LAND;
      if (f.sub[p] !== Substrate.HotLava) bits |= B_COOL;
      const canSp = f.sp[o + 3] - 1;
      if (can >= 0.5 && canSp >= 0 && !t.isMangrove[canSp]) {
        bits |= B_FOREST;
        if (f.soil[p] >= REAL_FOREST_SOIL) bits |= B_REAL;
        if (t.isTree[canSp]) bits |= B_TREE;
        if (f.lifeMask[p] & habBit(Habitat.CloudForest)) bits |= B_CLOUD;
      }
      if (f.cov[o + 2] >= 0.3) bits |= B_SHRUB;
      if (f.cov[o + 1] >= 0.3) bits |= B_HERB;
      if (fl & Flag.Cliff && fl & (Flag.SeaCliff | Flag.Stack | Flag.Islet)) bits |= B_SEACLIFF;
      // Perches for birds: big trees, cliffs, colonies, pond edges (a sample, refreshed by each recount).
      if (this.recounting && (can >= 0.5 || fl & (Flag.Cliff | Flag.Marsh) || f.colony[p] > 0)) {
        const seen = T.perchSeen[slot]++;
        if (seen < PERCH_N) T.perch[slot * PERCH_N + seen] = p;
        else {
          const j = Math.floor(hrand(p, this.stepIdx, 7, w.seed) * (seen + 1));
          if (j < PERCH_N) T.perch[slot * PERCH_N + j] = p;
        }
      }
    } else {
      if (f.cov[o + 2] >= 0.3 && f.sp[o + 2] !== 0) bits |= B_CORAL;
      if (f.cov[o + 1] >= 0.3 && f.sp[o + 1] !== 0) bits |= B_SEAGRASS;
    }
    this.tBits[p] = bits;
    this.tSlot[p] = slot;
    if (bits !== 0) addBits(T, slot, bits, 1);
  }

  /** Take patch p's last share out of the running tally. */
  private withdraw(p: number, T: Tally): void {
    const slot = this.tSlot[p];
    if (slot < 0) return;
    const nS = this.w.t.n;
    let m = this.tMask[p];
    const hb = slot * HABITAT_COUNT;
    while (m !== 0) {
      T.hab[hb + 31 - Math.clz32(m & -m)]--;
      m &= m - 1;
    }
    const o = p * LAYERS;
    for (let L = 0; L < LAYERS; L++) {
      const s1 = this.tSp[o + L];
      if (s1 !== 0) T.cover[slot * nS + s1 - 1] -= this.tCov[o + L] * COV_UNIT;
    }
    const bits = this.tBits[p];
    if (bits !== 0) addBits(T, slot, bits, -1);
    this.tSlot[p] = -1;
  }

  // ---------- change tracking for the page ----------

  /**
   * A fingerprint of what packEco sends for this patch, coarse enough that slow drifts (soil,
   * moisture, weathering) only count when the page would see a step.
   */
  private signature(p: number): void {
    const f = this.f;
    const o = p * LAYERS;
    let h = Math.imul(f.sp[o] | (f.sp[o + 1] << 8) | (f.sp[o + 2] << 16) | (f.sp[o + 3] << 24), 0x9e3779b1);
    h ^= ((f.cov[o] * 15) | 0) | (((f.cov[o + 1] * 15) | 0) << 4) | (((f.cov[o + 2] * 15) | 0) << 8) | (((f.cov[o + 3] * 15) | 0) << 12);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    const ground = 0.55 * f.wthr[p] + 0.45 * Math.min(1, f.soil[p] / 0.25);
    const water = f.flags[p] & Flag.Stream ? 1 : f.flags[p] & Flag.Marsh ? 2 : 0;
    h ^=
      f.hab[p] |
      (((f.moist[p] * 4) | 0) << 8) |
      (((f.guano[p] * 7) | 0) << 11) |
      (((f.char[p] * 7) | 0) << 14) |
      (((ground * 8) | 0) << 17) |
      (water << 21) |
      ((f.h[p] > 0 ? 1 : 0) << 23);
    h >>>= 0;
    if (h !== this.sig[p]) {
      this.sig[p] = h;
      this.markChanged(p);
    }
  }

  /** Tell the page this patch looks different. */
  markChanged(p: number): void {
    this.w.dirt.markPatch(p % NP, (p / NP) | 0);
  }
}

/** Add (k = 1) or take away (k = -1) a patch's tally bits for island `slot`. */
function addBits(T: Tally, slot: number, bits: number, k: number): void {
  if (bits & B_LAND) T.land[slot] += k;
  if (bits & B_COOL) T.cool[slot] += k;
  if (bits & B_FOREST) {
    T.forest[slot] += k;
    T.forestTotal += k;
  }
  if (bits & B_REAL) {
    T.realForest[slot] += k;
    T.realForestTotal += k;
  }
  if (bits & B_TREE) {
    T.trees[slot] += k;
    T.treeTotal += k;
  }
  if (bits & B_CLOUD) T.cloudForest += k;
  if (bits & B_SHRUB) {
    T.shrubs[slot] += k;
    T.shrubTotal += k;
  }
  if (bits & B_HERB) {
    T.herbs[slot] += k;
    T.herbTotal += k;
  }
  if (bits & B_SEACLIFF) T.seaCliff[slot] += k;
  if (bits & B_CORAL) {
    T.coral[slot] += k;
    T.coralTotal += k;
  }
  if (bits & B_SEAGRASS) T.seagrassTotal += k;
}
