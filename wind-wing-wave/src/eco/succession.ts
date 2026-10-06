/**
 * Succession: the yearly sweep over every living patch (ARCHITECTURE §3, ecology.md §4).
 *
 * One sweep = one year (ECO_STEP_YEARS) for the whole active set, in a fixed order. The work
 * is spread over many work() calls within the time budget, but it behaves as one step:
 * - neighbours are read from a copy taken at the start of the step (double buffer), so the
 *   visiting order never changes the outcome;
 * - island tallies go into a fresh buffer and replace the old ones only when the step ends.
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
 * with an 8-year step; the exact maths keeps that honest.
 */
import { NP } from '../config';
import { Habitat, HABITAT_COUNT, Substrate } from '../content/speciesTypes';
import { RoadBit } from './catalog';
import { moistureOf } from './climate';
import { Flag, L_CANOPY, L_GROUND, L_HERB, L_SHRUB, LAYERS, NPATCH, habBit, type EcoFields } from './fields';
import { chance, clamp01, growRate, hrand, logistic, relax } from './maths';
import { PERCH_N, type EcoWorld, type Tally } from './world';

/** Years for a plant to fade once a place stops suiting it. */
const DECLINE_TAU = 6;
/** Cover a new seedling patch starts with. */
const SEEDLING = 0.05;
/** Lowest suitability at which a seed can take. */
const TAKE = 0.2;
const QUIET_AFTER = 3;
const MAXP = 12;
/** Seed rain per patch-year at full island abundance, by road. */
const RAIN_WIND = 0.0005;
const RAIN_BIRD = 0.0004;
const RAIN_SEA = 0.001;

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
  readonly spPrev = new Uint8Array(NPATCH * LAYERS);
  readonly covPrev = new Float32Array(NPATCH * LAYERS);
  readonly veg = new Uint32Array(NPATCH);
  readonly vegPrev = new Uint32Array(NPATCH);
  /** Signature of the bytes packed for the page, to notice real visible change. */
  readonly sig = new Uint32Array(NPATCH);
  readonly pools = new Pools();
  private cursor = 0;
  inProgress = false;
  /** Patch-steps actually processed (not quiet) in the last finished sweep, for stats. */
  processed = 0;
  private processing = 0;
  /** Changed patch bbox since the last take (inclusive), or x0 > x1 when clean. */
  dx0 = NP;
  dz0 = NP;
  dx1 = -1;
  dz1 = -1;
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
    for (let i = 0; i < this.activeN; i++) was[this.active[i]] = 0;
    for (let i = 0; i < n; i++) {
      this.active[i] = list[i];
      was[list[i]] = 1;
    }
    this.activeN = n;
  }

  /** After loading a save: every patch's clock starts at `step`, all of them awake. */
  restart(step: number): void {
    this.last.fill(step - 1);
    this.quiet.fill(0);
    this.inProgress = false;
    this.cursor = 0;
  }

  /** Make a patch busy again (terrain change, arrival, storm). */
  wake(p: number): void {
    this.quiet[p] = 0;
  }

  /** Start a new step: snapshot neighbours, clear the new tallies. */
  begin(): void {
    const w = this.w;
    const f = this.f;
    this.stepIdx = w.step;
    w.next.clear();
    const act = this.active;
    for (let i = 0; i < this.activeN; i++) {
      const p = act[i];
      const o = p * LAYERS;
      this.spPrev[o] = f.sp[o];
      this.spPrev[o + 1] = f.sp[o + 1];
      this.spPrev[o + 2] = f.sp[o + 2];
      this.spPrev[o + 3] = f.sp[o + 3];
      this.covPrev[o] = f.cov[o];
      this.covPrev[o + 1] = f.cov[o + 1];
      this.covPrev[o + 2] = f.cov[o + 2];
      this.covPrev[o + 3] = f.cov[o + 3];
      this.vegPrev[p] = this.veg[p];
    }
    this.cursor = 0;
    this.processing = 0;
    this.inProgress = true;
  }

  /**
   * Count every active patch into the new tallies and refresh its habitats, without growing
   * anything (after building or loading a world).
   */
  census(): void {
    const w = this.w;
    const f = this.f;
    w.next.clear();
    for (let i = 0; i < this.activeN; i++) {
      const p = this.active[i];
      const land = f.h[p] > 0;
      const slot = w.slotOfPatch(p);
      if (land) {
        const wide = slot >= 0 ? Math.min(1, w.islands.rec(slot).area / 20000) : 0;
        f.moist[p] = moistureOf(f, p, f.soil[p], wide);
      } else f.moist[p] = 1;
      this.masks(p, land);
      this.tally(p, land, slot);
      this.signature(p);
    }
  }

  /** Continue the sweep until `deadline` (ms clock). Returns true when the step is complete. */
  some(deadline: number, now: () => number): boolean {
    const act = this.active;
    const n = this.activeN;
    const step = this.stepIdx;
    while (this.cursor < n) {
      const end = Math.min(n, this.cursor + 192);
      for (let i = this.cursor; i < end; i++) {
        const p = act[i];
        if (this.quiet[p] >= QUIET_AFTER && ((p + step) & 7) !== 0) this.tallyOnly(p);
        else {
          let dt = step - this.last[p];
          if (dt < 1) dt = 1;
          else if (dt > 16) dt = 16;
          this.last[p] = step;
          this.process(p, dt);
          this.processing++;
        }
      }
      this.cursor = end;
      if (this.cursor < n && now() > deadline) return false;
    }
    this.inProgress = false;
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
    const h = f.h[p];
    const land = h > 0;
    const slot = w.slotOfPatch(p);
    const sub = f.sub[p];
    if (land) {
      const wide = slot >= 0 ? Math.min(1, w.islands.rec(slot).area / 20000) : 0;
      f.moist[p] = moistureOf(f, p, f.soil[p], wide);
    } else f.moist[p] = 1;
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
      const vp = this.vegPrev;
      const veg = vp[p] | (pi > 0 ? vp[p - 1] : 0) | (pi < NP - 1 ? vp[p + 1] : 0) | (pk > 0 ? vp[p - NP] : 0) | (pk < NP - 1 ? vp[p + NP] : 0);
      for (let L = L_CANOPY; L >= L_GROUND; L--) {
        const light = suit.light(p, L);
        const s1 = sp[o + L];
        if (s1 !== 0) {
          const s = s1 - 1;
          const K = suit.plant(s, p, slot, light, veg, false);
          const c0 = cov[o + L];
          let c = K >= c0 ? logistic(c0, K, growRate(t.grow[s]), dt) : relax(c0, K, DECLINE_TAU, dt);
          if (c < 0.015 && K < 0.05) {
            sp[o + L] = 0;
            cov[o + L] = 0;
            changed = true;
            continue;
          }
          // End of a life: a better-placed newcomer may take over (pioneers give way).
          if (hrand(p, step, 10 + L, seed) < chance(1 / t.life[s], dt)) {
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
    this.tally(p, land, slot);
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
      const c1 = this.spPrev[q * LAYERS + L];
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
      const c1 = this.spPrev[q * LAYERS + L];
      if (c1 === 0) continue;
      const s = c1 - 1;
      if (s === tried0 || s === tried1) continue;
      let rate = (t.spread[s] / 10) * this.covPrev[q * LAYERS + L] * boost;
      if (f.flags[q] & Flag.Kipuka) rate *= 2;
      if (hrand(p, step, 20 + L * 4 + k, seed) >= chance(rate, dt)) continue;
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
        else if (mode === 1) rate = RAIN_BIRD * tot * (0.25 + this.covPrev[p * LAYERS + L_CANOPY] + (fl & Flag.Cliff ? 0.5 : 0) + (f.colony[p] > 0 ? 0.8 : 0));
        else rate = fl & (Flag.Shore | Flag.NearSea) ? RAIN_SEA * tot : 0;
        if (rate <= 0) continue;
        if (hrand(p, step, 60 + L * 4 + mode, seed) >= chance(rate * boost, dt)) continue;
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
    f.char[p] *= Math.exp(-dt / 60);
    f.logs[p] *= Math.exp(-dt / 80);
    f.warm[p] *= Math.exp(-dt / 90);
    f.guano[p] = relax(f.guano[p], f.colony[p], 25, dt);
    if (!land) return;
    const m = f.moist[p];
    const bot = f.bot[p];
    const kSub = bot === Substrate.Basalt ? 1 : bot === Substrate.Limestone ? 0.5 : bot === Substrate.Stone ? 0.15 : 0;
    if (kSub > 0) f.wthr[p] = relax(f.wthr[p], 1, 900 / (kSub * (0.3 + m)), dt);
    const g = cov[o];
    const herb = cov[o + 1];
    const shrub = cov[o + 2];
    const can = cov[o + 3];
    let soil = f.soil[p];
    // Weathering: rain, warmth and lichens crumble rock; old basalt fastest, placed stone slowest,
    // sand none. It is a little cooler (slower) up high.
    const warmth = 1 - 0.4 * Math.min(1, f.h[p] / 180);
    const weather = 1.1e-5 * kSub * (0.25 + m) * warmth * (1 + 1.5 * g) * Math.max(0, 1 - soil / 0.6);
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
    organic *= 0.4 + 0.6 * m;
    const total = g + herb + shrub + can;
    const sl = f.slope[p];
    const erosion = sl > 30 ? 6e-5 * ((sl - 30) / 30) * ((sl - 30) / 30) * (0.3 + f.rain[p]) * Math.max(0, 1 - total) : 0;
    soil += (weather + organic + 2e-4 * f.guano[p] - erosion) * dt;
    f.soil[p] = soil < 0 ? 0 : soil > 1.5 ? 1.5 : soil;
    // One merged richness: weathered basalt is the richest ground; guano and fixers add.
    const wt = f.wthr[p];
    const base = bot === Substrate.Basalt ? 0.25 + 0.55 * wt : bot === Substrate.Stone ? 0.12 + 0.2 * wt : bot === Substrate.Limestone ? 0.2 + 0.2 * wt : 0.1;
    const target = clamp01(base + 0.5 * f.guano[p] + 0.4 * fix + 0.15 * Math.min(1, soil / 0.3));
    f.fert[p] = relax(f.fert[p], target, 150, dt);
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

  private tally(p: number, land: boolean, slot: number): void {
    if (slot < 0) return;
    const w = this.w;
    const T: Tally = w.next;
    const f = this.f;
    const t = w.t;
    const nS = t.n;
    let m = f.lifeMask[p];
    const hb = slot * HABITAT_COUNT;
    while (m !== 0) {
      const b = 31 - Math.clz32(m & -m);
      T.hab[hb + b]++;
      m &= m - 1;
    }
    const o = p * LAYERS;
    for (let L = 0; L < LAYERS; L++) {
      const s1 = f.sp[o + L];
      if (s1 !== 0) T.cover[slot * nS + s1 - 1] += f.cov[o + L];
    }
    const can = f.cov[o + 3];
    if (land) {
      T.land[slot]++;
      if (f.sub[p] !== Substrate.HotLava) T.cool[slot]++;
      const canSp = f.sp[o + 3] - 1;
      if (can >= 0.5 && canSp >= 0 && !t.isMangrove[canSp]) {
        T.forest[slot]++;
        T.forestTotal++;
        if (f.lifeMask[p] & habBit(Habitat.CloudForest)) T.cloudForest++;
      }
      if (f.cov[o + 2] >= 0.3) {
        T.shrubs[slot]++;
        T.shrubTotal++;
      }
      if (f.cov[o + 1] >= 0.3) {
        T.herbs[slot]++;
        T.herbTotal++;
      }
      // Perches for birds: big trees, cliffs, colonies, pond edges (reservoir sample).
      const fl = f.flags[p];
      if (can >= 0.5 || fl & (Flag.Cliff | Flag.Marsh) || f.colony[p] > 0) {
        const seen = T.perchSeen[slot]++;
        if (seen < PERCH_N) T.perch[slot * PERCH_N + seen] = p;
        else {
          const j = Math.floor(hrand(p, this.stepIdx, 7, w.seed) * (seen + 1));
          if (j < PERCH_N) T.perch[slot * PERCH_N + j] = p;
        }
      }
    } else {
      if (f.cov[o + 2] >= 0.3 && f.sp[o + 2] !== 0) {
        T.coral[slot]++;
        T.coralTotal++;
      }
      if (f.cov[o + 1] >= 0.3 && f.sp[o + 1] !== 0) T.seagrassTotal++;
    }
  }

  private tallyOnly(p: number): void {
    const land = this.f.h[p] > 0;
    this.tally(p, land, this.w.slotOfPatch(p));
  }

  // ---------- change tracking for the page ----------

  private signature(p: number): void {
    const f = this.f;
    const o = p * LAYERS;
    let h = Math.imul(f.sp[o] | (f.sp[o + 1] << 8) | (f.sp[o + 2] << 16) | (f.sp[o + 3] << 24), 0x9e3779b1);
    h ^= ((f.cov[o] * 15) | 0) | (((f.cov[o + 1] * 15) | 0) << 4) | (((f.cov[o + 2] * 15) | 0) << 8) | (((f.cov[o + 3] * 15) | 0) << 12);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h ^= f.hab[p] | (((f.moist[p] * 7) | 0) << 8) | (((f.guano[p] * 7) | 0) << 11) | (((f.char[p] * 7) | 0) << 14) | (Math.min(15, (f.soil[p] * 40) | 0) << 17) | (((f.wthr[p] * 7) | 0) << 21);
    h >>>= 0;
    if (h !== this.sig[p]) {
      this.sig[p] = h;
      this.markChanged(p);
    }
  }

  markChanged(p: number): void {
    const pi = p % NP;
    const pk = (p / NP) | 0;
    if (pi < this.dx0) this.dx0 = pi;
    if (pi > this.dx1) this.dx1 = pi;
    if (pk < this.dz0) this.dz0 = pk;
    if (pk > this.dz1) this.dz1 = pk;
  }
}
