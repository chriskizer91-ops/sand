/**
 * The shared state every part of the life simulation reads: the fields, the compiled
 * catalogue, the committed islands, the per-island tallies from the last finished sweep,
 * and the clocks.
 *
 * Tallies are double-buffered: the sweep keeps `run` up to date as it goes, everyone else
 * reads `cur`, a copy taken when the last step finished, so the order in which patches are
 * visited never matters.
 */
import { HABITAT_COUNT, Substrate } from '../content/speciesTypes';
import type { Columns } from '../engine/columns';
import type { GeoForEco } from '../engine/geo/geo';
import { Rng } from '../engine/noise';
import type { ReasonCode } from './needs';
import { REASONS, habitatReason, isBuildableReason, substrateReason, type SpeciesTable } from './catalog';
import { Dirt } from './dirt';
import { EcoFields, Flag, L_CANOPY, LAYERS } from './fields';
import type { IslandRec } from './islands';
import { band, trapezoid } from './maths';
import type { PatchGrid } from './patches';
import type { Features } from './places';

/** Perch samples kept per island for bird-carried arrivals. */
export const PERCH_N = 24;

/**
 * Per-island sums of what lives where: habitat patches, plant cover per species, land, forest
 * and so on, plus a few zone totals. Float64, because the sweep keeps one running copy up to
 * date by adding and taking away each patch's share as it changes.
 */
export class Tally {
  slots = 0;
  readonly nS: number;
  hab: Float64Array = new Float64Array(0);
  cover: Float64Array = new Float64Array(0);
  land: Float64Array = new Float64Array(0);
  /** Land that is not molten (where animals can be). */
  cool: Float64Array = new Float64Array(0);
  /** Patches under closed tree canopy (cover 0.5 or more). */
  forest: Float64Array = new Float64Array(0);
  /** Forest on real soil (0.1 m or more): what counts for first forest, the Age of Forests and the ending. */
  realForest: Float64Array = new Float64Array(0);
  /** Patches with a full-grown tree (the first-tree stamp). */
  trees: Float64Array = new Float64Array(0);
  shrubs: Float64Array = new Float64Array(0);
  herbs: Float64Array = new Float64Array(0);
  coral: Float64Array = new Float64Array(0);
  /** Cliff patches seabirds can nest on: sea cliffs, sea stacks and islets (not crater walls). */
  seaCliff: Float64Array = new Float64Array(0);
  perch: Int32Array = new Int32Array(0);
  perchSeen: Int32Array = new Int32Array(0);
  /** Zone totals. */
  shrubTotal = 0;
  herbTotal = 0;
  forestTotal = 0;
  realForestTotal = 0;
  treeTotal = 0;
  coralTotal = 0;
  seagrassTotal = 0;
  cloudForest = 0;

  constructor(nS: number) {
    this.nS = nS;
  }

  /**
   * Re-key the per-island rows after islands were relabelled: row of old slot i goes to the
   * new slot of island oldIds[i] (dropped if that island is gone).
   */
  remap(oldIds: readonly number[], slotOf: Int16Array, n: number): void {
    const cap = Math.max(8, n);
    const nS = this.nS;
    const HC = HABITAT_COUNT;
    const hab = new Float64Array(cap * HC);
    const cover = new Float64Array(cap * nS);
    const per = (): Float64Array => new Float64Array(cap);
    const land = per();
    const cool = per();
    const forest = per();
    const realForest = per();
    const trees = per();
    const shrubs = per();
    const herbs = per();
    const coral = per();
    const seaCliff = per();
    const perch = new Int32Array(cap * PERCH_N);
    const perchSeen = new Int32Array(cap);
    for (let o = 0; o < oldIds.length && o < this.slots; o++) {
      const ns = slotOf[oldIds[o]];
      if (ns < 0) continue;
      hab.set(this.hab.subarray(o * HC, o * HC + HC), ns * HC);
      cover.set(this.cover.subarray(o * nS, o * nS + nS), ns * nS);
      perch.set(this.perch.subarray(o * PERCH_N, o * PERCH_N + PERCH_N), ns * PERCH_N);
      land[ns] = this.land[o];
      cool[ns] = this.cool[o];
      forest[ns] = this.forest[o];
      realForest[ns] = this.realForest[o];
      trees[ns] = this.trees[o];
      shrubs[ns] = this.shrubs[o];
      herbs[ns] = this.herbs[o];
      coral[ns] = this.coral[o];
      seaCliff[ns] = this.seaCliff[o];
      perchSeen[ns] = this.perchSeen[o];
    }
    this.slots = cap;
    this.hab = hab;
    this.cover = cover;
    this.land = land;
    this.cool = cool;
    this.forest = forest;
    this.realForest = realForest;
    this.trees = trees;
    this.shrubs = shrubs;
    this.herbs = herbs;
    this.coral = coral;
    this.seaCliff = seaCliff;
    this.perch = perch;
    this.perchSeen = perchSeen;
  }

  /** Start counting afresh (perch samples are refilled by the same count). */
  clear(): void {
    this.hab.fill(0);
    this.cover.fill(0);
    this.land.fill(0);
    this.cool.fill(0);
    this.forest.fill(0);
    this.realForest.fill(0);
    this.trees.fill(0);
    this.shrubs.fill(0);
    this.herbs.fill(0);
    this.coral.fill(0);
    this.seaCliff.fill(0);
    this.perchSeen.fill(0);
    this.shrubTotal = 0;
    this.herbTotal = 0;
    this.forestTotal = 0;
    this.realForestTotal = 0;
    this.treeTotal = 0;
    this.coralTotal = 0;
    this.seagrassTotal = 0;
    this.cloudForest = 0;
  }

  /** Become a copy of `o` (same island slots). */
  copyFrom(o: Tally): void {
    if (this.slots !== o.slots) this.remap([], new Int16Array(1).fill(-1), o.slots);
    this.hab.set(o.hab);
    this.cover.set(o.cover);
    this.land.set(o.land);
    this.cool.set(o.cool);
    this.forest.set(o.forest);
    this.realForest.set(o.realForest);
    this.trees.set(o.trees);
    this.shrubs.set(o.shrubs);
    this.herbs.set(o.herbs);
    this.coral.set(o.coral);
    this.seaCliff.set(o.seaCliff);
    this.perch.set(o.perch);
    this.perchSeen.set(o.perchSeen);
    this.shrubTotal = o.shrubTotal;
    this.herbTotal = o.herbTotal;
    this.forestTotal = o.forestTotal;
    this.realForestTotal = o.realForestTotal;
    this.treeTotal = o.treeTotal;
    this.coralTotal = o.coralTotal;
    this.seagrassTotal = o.seagrassTotal;
    this.cloudForest = o.cloudForest;
  }
}

/** The committed island picture (changes only at step boundaries). */
export class IslandState {
  recs = new Map<number, IslandRec>();
  /** Island id -> dense slot (-1 = none). */
  readonly slotOf = new Int16Array(65536).fill(-1);
  /** Slot -> island id. */
  ids: number[] = [];
  /** Per slot: land patches, shore patches (land within 8 m of sea), nearby shallow sea. */
  landStart: Int32Array = new Int32Array(1);
  land: Int32Array = new Int32Array(0);
  shoreStart: Int32Array = new Int32Array(1);
  shore: Int32Array = new Int32Array(0);
  seaStart: Int32Array = new Int32Array(1);
  sea: Int32Array = new Int32Array(0);
  /** Per slot: places recognised now (bit per PLACE_KINDS index). */
  placesNow = new Uint32Array(0);

  get count(): number {
    return this.ids.length;
  }
  rec(slot: number): IslandRec {
    return this.recs.get(this.ids[slot]) as IslandRec;
  }
}

/** Suitability: "could plant species s live in patch p?" (0..1). The heart of succession. */
export class Suit {
  /** Storm multiplier on salt spray. */
  saltMult = 1;
  /** Per (slot, species): island-level needs met (requires, places, area, peaks, predators). */
  gate = new Uint8Array(0);
  /** Per (slot, species): why the gate failed (index into REASONS). */
  gateWhy = new Uint8Array(0);
  /** Filled when explaining: the limiting factor and the product of the others. */
  reason: ReasonCode | null = null;
  partial = 1;
  private fx = new Float32Array(16);
  private fr: ReasonCode[] = new Array<ReasonCode>(16).fill('no-land');

  constructor(
    readonly f: EcoFields,
    readonly t: SpeciesTable,
  ) {}

  /** Light reaching layer L, from the cover of the layers above it. */
  light(p: number, L: number): number {
    if (L === L_CANOPY) return 1;
    const cov = this.f.cov;
    const o = p * LAYERS;
    const can = 1 - 0.85 * cov[o + 3];
    if (L === 2) return can;
    const shr = can * (1 - 0.5 * cov[o + 2]);
    if (L === 1) return shr;
    return shr * (1 - 0.3 * cov[o + 1]);
  }

  /**
   * Suitability of plant `s` in patch `p` (on island slot `slot`, -1 = none), with `light` at
   * its layer and `veg` the vegetation habitats around. The product of trapezoid-shaped terms
   * over each need. With `explain`, also finds the most limiting factor (this.reason) and the
   * product of the others (this.partial), for "couldn't stay" stories and Look.
   * No allocation: this runs for every patch, layer and step.
   */
  plant(s: number, p: number, slot: number, light: number, veg: number, explain: boolean): number {
    const t = this.t;
    const f = this.f;
    const fx = this.fx;
    const fr = this.fr;
    let k = 0;
    let v = 1;
    let x: number;
    const h = f.h[p];
    // ---------- ground and position ----------
    if (t.marine[s]) {
      x = t.subMask[s] & (1 << f.bot[p]) && f.bot[p] !== Substrate.HotLava ? 1 : 0;
      if (explain) {
        fx[k] = x;
        fr[k++] = f.bot[p] === Substrate.HotLava ? 'hot-lava' : substrateReason(t, s, false);
      } else if (x === 0) return 0;
      if (t.hasAlt[s]) x = band(h, t.altMin[s], t.altMax[s], 0.5);
      else if (t.hasDepth[s]) x = band(-h, t.depMin[s], t.depMax[s], 0.75);
      else x = h < 0 ? 1 : 0;
      if (explain) {
        fx[k] = x;
        fr[k++] = t.mainNeed[s];
      } else if (x <= 0) return 0;
      v *= x;
    } else {
      const sub = f.sub[p];
      x = t.subMask[s] & (1 << sub) ? 1 : 0;
      if (explain) {
        fx[k] = x;
        fr[k++] = sub === Substrate.HotLava ? 'hot-lava' : substrateReason(t, s, false);
      } else if (x === 0) return 0;
      if (t.hasAlt[s]) {
        const lo = t.altMin[s];
        const hi = t.altMax[s];
        x = band(h, lo, hi, Math.max(1, 0.08 * (hi - lo)));
        if (explain) {
          fx[k] = x;
          fr[k++] = h < lo && lo >= 100 ? 'no-summit' : h < lo && lo >= 30 && !isBuildableReason(t.mainNeed[s]) ? 'too-low' : t.mainNeed[s];
        } else if (x <= 0) return 0;
        v *= x;
      }
      if (t.hasDepth[s] && sub === Substrate.Pond) {
        x = band(f.pondLvl[p] - h, t.depMin[s], t.depMax[s], 0.5);
        if (explain) {
          fx[k] = x;
          fr[k++] = 'no-fresh-water';
        } else if (x <= 0) return 0;
        v *= x;
      }
    }
    // ---------- soil ----------
    // EcoNeeds.soil is [minimum, comfortable]: none below the minimum, a struggling 0.35 at it,
    // rising to 1 at "comfortable". A minimum of 0 (beach she-oak: [0, 0.1]) still has a
    // comfortable depth, so on bare rock it only manages a third of its cover.
    const sok = t.soilOk[s];
    if (sok > 0) {
      const smin = t.soilMin[s];
      const so = f.soil[p];
      if (so < smin) x = 0;
      else x = so >= sok ? 1 : 0.35 + (0.65 * (so - smin)) / (sok - smin);
      if (explain) {
        fx[k] = x;
        fr[k++] = so < 0.3 * smin ? 'no-soil' : 'thin-soil';
      } else if (x <= 0) return 0;
      v *= x;
    }
    // ---------- water, salt, slope, light, richness ----------
    if (t.hasMoist[s] && !t.marine[s]) {
      const m = f.moist[p];
      x = trapezoid(m, t.m0[s], t.m1[s], t.m2[s], t.m3[s]);
      if (explain) {
        fx[k] = x;
        fr[k++] = m < t.m1[s] ? 'too-dry' : 'too-wet';
      } else if (x <= 0) return 0;
      v *= x;
    }
    if (!t.marine[s] && h > 0) {
      const se = f.salt[p] * this.saltMult;
      const sm = t.saltMax[s];
      if (se > sm) {
        x = Math.max(0, 1 - (se - sm) / 0.15);
        if (explain) {
          fx[k] = x;
          fr[k++] = 'too-salty';
        } else if (x <= 0) return 0;
        v *= x;
      }
    }
    const sl = f.slope[p];
    if (sl > t.slopeMax[s]) {
      x = Math.max(0, 1 - (sl - t.slopeMax[s]) / 10);
      if (explain) {
        fx[k] = x;
        fr[k++] = 'no-open-ground';
      } else if (x <= 0) return 0;
      v *= x;
    }
    const need = 1 - light;
    const tol = t.shade[s];
    if (need > tol) {
      x = Math.max(0, 1 - (need - tol) / 0.25);
      if (explain) {
        fx[k] = x;
        fr[k++] = 'no-open-ground';
      } else if (x <= 0) return 0;
      v *= x;
    }
    const fm = t.fert[s];
    if (fm > 0 && f.fert[p] < fm) {
      x = Math.max(0, 1 - (fm - f.fert[p]) / 0.15);
      if (explain) {
        fx[k] = x;
        fr[k++] = 'thin-soil';
      } else if (x <= 0) return 0;
      v *= x;
    }
    // ---------- habitat and island ----------
    const hm = t.habMask[s];
    if (hm !== 0) {
      x = hm & (f.geoMask[p] | veg) ? 1 : 0;
      if (explain) {
        fx[k] = x;
        fr[k++] = habitatReason(t, s);
      } else if (x === 0) return 0;
    }
    if (slot >= 0) {
      const g = slot * t.n + s;
      x = this.gate[g];
      if (explain) {
        fx[k] = x;
        fr[k++] = REASONS[this.gateWhy[g]];
      } else if (x === 0) return 0;
    }
    if (!explain) return v;
    // The most limiting factor, and what is left without it. On a tie, a place the player
    // can build is the more useful story ("no beach" beats "too dry").
    let wi = -1;
    let worst = 1;
    for (let i = 0; i < k; i++) {
      if (fx[i] < worst || (wi >= 0 && fx[i] === worst && isBuildableReason(fr[i]) && !isBuildableReason(fr[wi]))) {
        worst = fx[i];
        wi = i;
      }
    }
    let rest = 1;
    for (let i = 0; i < k; i++) if (i !== wi) rest *= fx[i];
    this.reason = wi >= 0 && worst < 0.999 ? fr[wi] : null;
    this.partial = rest;
    return worst <= 0 ? 0 : v;
  }
}

/** Shared state and clocks. */
export class EcoWorld {
  readonly f: EcoFields;
  readonly t: SpeciesTable;
  readonly suit: Suit;
  readonly islands = new IslandState();
  /** What the page has not been sent yet. */
  readonly dirt = new Dirt();
  /** Tallies as of the last finished step (read by everyone). */
  cur: Tally;
  /** Running tallies, kept up to date by the sweep. */
  run: Tally;
  rng: Rng;
  /** Completed one-year steps since first land (the visible year). */
  step = 0;
  /** Real seconds since the ecology started (any state, for debounces). */
  real = 0;
  /**
   * Play seconds: real seconds of unpaused play since first land. Storms, cards and the
   * feedback guarantees run on this clock, so they keep their promises in real time even when
   * a slow phone lets the years fall behind. (debugAdvance adds one step's worth per step.)
   */
  realPlay = 0;
  firstLand = false;
  /** Years per real second right now (pace times storm slowdown). */
  yps = 2;
  /** Per (slot, species): lives on that island (plants with cover, animals with a population). */
  present = new Uint8Array(0);
  /** Per (slot, species): animal population 0..1. */
  pop = new Float32Array(0);
  features!: Features;

  constructor(
    readonly cols: Columns,
    readonly grid: PatchGrid,
    readonly geo: GeoForEco,
    readonly seed: number,
    t: SpeciesTable,
  ) {
    this.f = new EcoFields(grid);
    this.t = t;
    this.suit = new Suit(this.f, t);
    this.cur = new Tally(t.n);
    this.run = new Tally(t.n);
    this.rng = new Rng(seed ^ 0x51ed270b);
  }

  get year(): number {
    return this.step;
  }

  /** Island slot for a patch: its own island on land, the nearest island at sea. */
  slotOfPatch(p: number): number {
    const id = this.f.isl[p] || this.f.near[p];
    return id === 0 ? -1 : this.islands.slotOf[id];
  }

  /** Total plant cover in a patch. */
  coverSum(p: number): number {
    const c = this.f.cov;
    const o = p * LAYERS;
    return c[o] + c[o + 1] + c[o + 2] + c[o + 3];
  }

  isLand(p: number): boolean {
    return this.f.h[p] > 0;
  }

  /** Zone share of land (patches). */
  landPatches(): number {
    let n = 0;
    for (let s = 0; s < this.islands.count; s++) n += this.cur.land[s];
    return n;
  }

  /** Is the patch in shallow sea near an island. */
  nearSea(p: number): boolean {
    return (this.f.flags[p] & Flag.NearSea) !== 0;
  }

  /**
   * Re-key everything stored per (island, species) after relabelling. When islands joined,
   * the survivor keeps the best of both populations.
   */
  remapSlots(oldIds: readonly number[], n: number, joins: readonly [number, number][]): void {
    const isl = this.islands;
    const nS = this.t.n;
    const cap = Math.max(1, n) * nS;
    const present = new Uint8Array(cap);
    const pop = new Float32Array(cap);
    for (let o = 0; o < oldIds.length; o++) {
      const ns = isl.slotOf[oldIds[o]];
      if (ns < 0) continue;
      present.set(this.present.subarray(o * nS, o * nS + nS), ns * nS);
      pop.set(this.pop.subarray(o * nS, o * nS + nS), ns * nS);
    }
    for (const [keeper, other] of joins) {
      const ks = isl.slotOf[keeper];
      const os = oldIds.indexOf(other);
      if (ks < 0 || os < 0) continue;
      for (let s = 0; s < nS; s++) {
        pop[ks * nS + s] = Math.max(pop[ks * nS + s], this.pop[os * nS + s]);
        present[ks * nS + s] |= this.present[os * nS + s];
      }
    }
    this.present = present;
    this.pop = pop;
    this.suit.gate = new Uint8Array(cap);
    this.suit.gateWhy = new Uint8Array(cap);
    this.cur.remap(oldIds, isl.slotOf, n);
    this.run.remap(oldIds, isl.slotOf, n);
  }
}
