/**
 * Island-level life: the needs that are judged per island (area, peaks, places, food,
 * predators, neighbours), animal populations and seabird colonies.
 *
 * Animals are counted per island, not per patch: each species has a population 0..1
 * (1 = what a large island could hold), growing with the exact logistic toward a carrying
 * capacity set by how much of its habitat the island has and how much food is there.
 * Losses are gentle (ecology.md §6.3):
 * - when habitat shrinks, a population fades over decades, slower if a nearby island still
 *   has the species (the rescue effect);
 * - no single step removes more than ~15% of an island's species;
 * - "lost" is only told after a long absence from every island, in kind words.
 *
 * Seabird colonies sit where each kind nests: cliff nesters on sea cliffs, sea stacks and
 * islets (never on a crater wall inland), tree nesters in the trees, burrowers in the dunes, and
 * anywhere open on an islet. Their guano whitens the rock and feeds the soil.
 */
import { HABITAT_COUNT, Habitat } from '../content/speciesTypes';
import type { ColonyInfo } from '../engine/protocol';
import type { ReasonCode } from './needs';
import { REASONS, habitatReason, placeReason, reasonIndex, requireReason } from './catalog';
import { NP } from '../config';
import { Flag, habBit, patchAt, patchX, patchZ } from './fields';
import { ISLET_AREA, type IslandRec } from './islands';
import { logistic, relax } from './maths';
import type { EcoWorld } from './world';

const K_SEA = Habitat.OpenSea;
const CLIFF_BIT = habBit(Habitat.Cliff);
const NEST_GROUND = CLIFF_BIT | habBit(Habitat.RockShore) | habBit(Habitat.BareRock) | habBit(Habitat.Beach) | habBit(Habitat.Grass) | habBit(Habitat.Crust) | habBit(Habitat.Dune);
/** Cliffs a seabird can nest on: at the sea, on a stack or on an islet. */
const SEA_CLIFF_FLAGS = Flag.SeaCliff | Flag.Stack | Flag.Islet;
/** Colony sites are re-chosen this often (steps), and whenever the islands change. */
const SITE_EVERY = 8;

/** Edge-to-edge distance between two islands' boxes (m). */
export function islandGap(a: IslandRec, b: IslandRec): number {
  const dx = Math.max(0, a.bbox[0] - b.bbox[2], b.bbox[0] - a.bbox[2]);
  const dz = Math.max(0, a.bbox[1] - b.bbox[3], b.bbox[1] - a.bbox[3]);
  return Math.hypot(dx, dz);
}

/** Abundance 0..1 of species s on island slot (plants from cover, animals from population). */
export function abundance(w: EcoWorld, slot: number, s: number): number {
  const i = slot * w.t.n + s;
  return w.t.isPlant[s] ? Math.min(1, w.cur.cover[i] / 20) : w.pop[i];
}

/**
 * Island-level needs for every species on every island (gate + why), from the last finished
 * step. Plants use the gate inside their suitability; animals inside their capacity.
 */
export function computeGates(w: EcoWorld): void {
  const t = w.t;
  const isl = w.islands;
  const nS = t.n;
  for (let slot = 0; slot < isl.count; slot++) {
    const rec = isl.rec(slot);
    const places = isl.placesNow[slot];
    let predator = false;
    for (let s = 0; s < nS; s++) if (t.predator[s] && w.present[slot * nS + s]) predator = true;
    let nearest = 1e9;
    for (let o = 0; o < isl.count; o++) {
      if (o === slot) continue;
      const r2 = isl.rec(o);
      if (r2.area < 400) continue;
      nearest = Math.min(nearest, islandGap(rec, r2));
    }
    for (let s = 0; s < nS; s++) {
      let why: ReasonCode | null = null;
      if (rec.area < t.minArea[s]) why = 'too-small';
      else if (rec.peak[1] > t.maxPeak[s]) why = 'too-tall';
      else if (rec.peak[1] < t.minPeak[s]) why = 'too-low';
      else if ((t.placeMask[s] & places) !== t.placeMask[s]) why = placeReason(t, s, t.placeMask[s] & ~places);
      else if (t.nearIsland[s] > 0 && nearest > t.nearIsland[s]) why = 'needs-island-nearby';
      else if (t.noPred[s] && predator) why = 'predators';
      else {
        for (let k = t.reqStart[s]; k < t.reqStart[s + 1]; k++) {
          const r = t.req[k];
          if (!w.present[slot * nS + r]) {
            why = requireReason(t, r);
            break;
          }
        }
      }
      w.suit.gate[slot * nS + s] = why === null ? 1 : 0;
      w.suit.gateWhy[slot * nS + s] = why === null ? 0 : reasonIndex(why);
    }
  }
}

export class Fauna {
  colonies: ColonyInfo[] = [];
  /** The island of each colony (same order as `colonies`). */
  colonyIslands: number[] = [];
  /** Guano discs painted last time (x, z, r), cleared before repainting. */
  private painted: number[] = [];
  /** Nest patch per (island id, species), kept while it still suits so colonies stay put. */
  private sites = new Map<number, number>();
  /** Choose the colony sites again at the next step (the islands changed). */
  sitesDue = true;
  reason: ReasonCode | null = null;
  /** Species that died out on an island this step (slot * nS + s). */
  readonly lostNow: number[] = [];

  constructor(private w: EcoWorld) {}

  /**
   * Habitat patches available to animal s on island slot. A seabird that nests on cliffs only
   * counts cliffs at the sea (and on stacks and islets): a crater wall inland is no use to it.
   */
  habitatCount(s: number, slot: number): number {
    const w = this.w;
    const t = w.t;
    const T = w.cur;
    const hm = t.habMask[s];
    const base = slot * HABITAT_COUNT;
    const seabird = t.isSeabird[s] === 1;
    let count = 0;
    if (hm === 0) count = t.marineAnimal[s] ? T.hab[base + K_SEA] : T.cool[slot];
    else {
      for (let h = 0; h < HABITAT_COUNT; h++) {
        if (!(hm & (1 << h))) continue;
        count += seabird && h === Habitat.Cliff ? T.seaCliff[slot] : T.hab[base + h];
      }
    }
    // On an islet, seabirds nest on any open ground.
    if (seabird && w.islands.rec(slot).area < ISLET_AREA) {
      for (let h = 0; h < HABITAT_COUNT; h++) if (NEST_GROUND & (1 << h) && !(hm & (1 << h))) count += T.hab[base + h];
    }
    return count;
  }

  /** Carrying capacity of animal s on island slot (0..1); sets this.reason when 0. */
  K(s: number, slot: number): number {
    const w = this.w;
    const t = w.t;
    const g = slot * t.n + s;
    this.reason = null;
    if (!w.suit.gate[g]) {
      this.reason = REASONS[w.suit.gateWhy[g]];
      return 0;
    }
    const T = w.cur;
    const count = this.habitatCount(s, slot);
    const need = Math.max(1, t.minPatches[s]);
    if (count < need) {
      // Some of its habitat but not enough: on a small island that is the island's size.
      this.reason = count > 0 && T.land[slot] < 3 * need ? 'too-small' : habitatReason(t, s);
      return 0;
    }
    let K = 1 - Math.exp(-count / (3 * Math.max(need, 4)));
    // Food: as much as the scarcest thing it needs.
    let food = 1;
    for (let k = t.reqStart[s]; k < t.reqStart[s + 1]; k++) food = Math.min(food, Math.min(1, abundance(w, slot, t.req[k]) / 0.3));
    K *= 0.25 + 0.75 * food;
    return K;
  }

  /** One step of every population on every island. */
  step(dt: number): void {
    const w = this.w;
    const t = w.t;
    const nS = t.n;
    const isl = w.islands;
    this.lostNow.length = 0;
    for (let slot = 0; slot < isl.count; slot++) {
      let alive = 0;
      for (let s = 0; s < nS; s++) if (w.present[slot * nS + s]) alive++;
      let lossBudget = Math.max(1, Math.floor(alive * 0.15));
      for (let s = 0; s < nS; s++) {
        if (t.isPlant[s]) continue;
        const i = slot * nS + s;
        const P = w.pop[i];
        if (P <= 0) continue;
        const K = this.K(s, slot);
        let next: number;
        if (K >= P) next = logistic(P, K, t.gr[s], dt);
        else next = relax(P, K, this.rescued(s, slot) ? 24 : 10, dt);
        if (next < 0.004 && K < 0.01) {
          if (lossBudget > 0) {
            lossBudget--;
            w.pop[i] = 0;
            w.present[i] = 0;
            this.lostNow.push(i);
            continue;
          }
          next = 0.004;
        }
        w.pop[i] = next;
      }
    }
    if (this.sitesDue || w.step % SITE_EVERY === 0) this.placeColonies();
  }

  /** Does a nearby island still hold this species (slows losses). */
  private rescued(s: number, slot: number): boolean {
    const w = this.w;
    const isl = w.islands;
    const rec = isl.rec(slot);
    for (let o = 0; o < isl.count; o++) {
      if (o === slot || !w.present[o * w.t.n + s]) continue;
      if (islandGap(rec, isl.rec(o)) <= w.t.hop[s]) return true;
    }
    return false;
  }

  /** Seabird colonies: each kind at its own nest site on each island, with guano painted round it. */
  placeColonies(): void {
    const w = this.w;
    const t = w.t;
    const isl = w.islands;
    const nS = t.n;
    this.sitesDue = false;
    // Clear the old rasters.
    for (let i = 0; i < this.painted.length; i += 3) this.raster(this.painted[i], this.painted[i + 1], this.painted[i + 2], 0, true);
    this.painted.length = 0;
    this.colonies = [];
    this.colonyIslands = [];
    for (let slot = 0; slot < isl.count; slot++) {
      const rec = isl.rec(slot);
      let biggest = -1;
      let biggestN = 0;
      for (let s = 0; s < nS; s++) {
        if (!t.isSeabird[s]) continue;
        const P = w.pop[slot * nS + s];
        if (P < 0.02) continue;
        const site = this.site(slot, s);
        if (site < 0) continue;
        const x = patchX(site);
        const z = patchZ(site);
        this.colonies.push({ species: s, x, z, r: Math.min(60, 10 + 30 * Math.sqrt(P)), n: Math.min(1, P) });
        this.colonyIslands.push(rec.id);
        if (P > biggestN) {
          biggestN = P;
          biggest = s;
        }
        const guano = Math.min(1, t.givesGuano[s] * P);
        if (guano > 0) {
          const r = 12 + 25 * guano;
          this.raster(x, z, r, guano, false);
          this.painted.push(x, z, r);
        }
      }
      rec.colonySp = biggest;
    }
  }

  /**
   * Where species s nests on island slot: the nesting patch nearest the middle of all its
   * nesting patches (so the colony sits among them), kept from last time while it still suits.
   * Only an islet with no open ground left falls back to its top.
   */
  private site(slot: number, s: number): number {
    const w = this.w;
    const f = w.f;
    const isl = w.islands;
    const rec = isl.rec(slot);
    const islet = rec.area < ISLET_AREA;
    const hm = w.t.habMask[s];
    const want = (hm === 0 ? NEST_GROUND : hm) | (islet ? NEST_GROUND : 0);
    const nests = (p: number): boolean => {
      const m = f.lifeMask[p] & want;
      if (m === 0) return false;
      // A cliff alone is a nest site only at the sea, on a stack or on an islet.
      return m !== CLIFF_BIT || (f.flags[p] & SEA_CLIFF_FLAGS) !== 0;
    };
    const key = rec.id * 1024 + s;
    const old = this.sites.get(key);
    if (old !== undefined && f.isl[old] === rec.id && nests(old)) return old;
    let sx = 0;
    let sz = 0;
    let n = 0;
    const a = isl.landStart[slot];
    const b = isl.landStart[slot + 1];
    for (let i = a; i < b; i++) {
      const p = isl.land[i];
      if (!nests(p)) continue;
      sx += p % NP;
      sz += (p / NP) | 0;
      n++;
    }
    let best = -1;
    if (n > 0) {
      const cx = sx / n;
      const cz = sz / n;
      let bestD = Infinity;
      for (let i = a; i < b; i++) {
        const p = isl.land[i];
        if (!nests(p)) continue;
        const d = (p % NP - cx) ** 2 + (((p / NP) | 0) - cz) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
    } else if (islet) best = patchAt(rec.peak[0], rec.peak[2]);
    if (best >= 0) this.sites.set(key, best);
    else this.sites.delete(key);
    return best;
  }

  /** Paint (or clear) guano input in a disc on land. */
  private raster(x: number, z: number, r: number, v: number, clear: boolean): void {
    const f = this.w.f;
    const p0 = patchAt(x - r, z - r);
    const p1 = patchAt(x + r, z + r);
    const i0 = p0 % NP;
    const k0 = (p0 / NP) | 0;
    const i1 = p1 % NP;
    const k1 = (p1 / NP) | 0;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const p = i + k * NP;
        if (clear) {
          f.colony[p] = 0;
          continue;
        }
        if (f.h[p] <= 0) continue;
        const d = Math.hypot(patchX(p) - x, patchZ(p) - z);
        if (d > r) continue;
        f.colony[p] = Math.max(f.colony[p], v * (1 - (0.6 * d) / r));
      }
    }
  }
}
