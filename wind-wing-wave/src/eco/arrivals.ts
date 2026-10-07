/**
 * Arrivals: how life reaches the islands, and whether it can stay (ecology.md §5).
 *
 * Every step, every species not yet living on an island gets a chance to arrive there:
 *   rate = EcoNeeds.rate per century x RATE_SCALE
 *        x reach from the old islands upwind (weaker for far, western islands: stepping stones)
 *          + hops from islands in the zone where it already lives (much easier)
 *        x the island as a target (wind and birds find big, tall islands; the sea finds long coasts)
 *        x storms (rafts and storm-blown birds come mostly then)
 * An arrival lands by its road: the sea on windward shores, the wind anywhere (high and
 * windward first), birds at perches (tall trees, cliffs, colonies, pond edges).
 * Then the establishment test: plants need a suitable patch, animals a carrying capacity.
 *
 * The feedback guarantees (ARCHITECTURE §4) live here, on the play clock (real, unpaused
 * seconds), so they hold even when a slow phone lets the years fall behind:
 * - a first failed visit always writes its "couldn't stay" story, with the reason;
 * - once that need is met, the visitor returns within 30–90 s (the pity timer);
 * - any species whose needs are met somewhere arrives within 5 minutes (common) or
 *   15 (rare): nothing stays stuck.
 */
import { NP, ORIGIN_X, ZONE_SIZE } from '../config';
import type { PlaceKind, Road } from '../content/speciesTypes';
import type { ArrivalEvent } from '../engine/protocol';
import type { ReasonCode } from './needs';
import { PLACE_KINDS, ROADS, RoadBit, isBuildableReason, placeAnswers } from './catalog';
import type { Director, HintSource } from './director';
import { abundance, islandGap, type Fauna } from './fauna';
import { LAYERS, patchX, patchZ } from './fields';
import { chance } from './maths';
import { placeOfFlags } from './places';
import type { Sweep } from './succession';
import { PERCH_N, type EcoWorld } from './world';

/** The reference island the catalogue's rates are written for (area m², peak m, shore m). */
const REF_AREA = 90000;
const REF_PEAK = 110;
const REF_SHORE = 1100;
/**
 * Arrival attempts per catalogue "attempt per century". The catalogue writes rates as if a
 * century passed between attempts at the reference island; the game's pacing (the beat sheet,
 * ARCHITECTURE §4, in real minutes) wants about a quarter of that, with the never-stuck
 * guarantee catching the slow ones.
 */
export const RATE_SCALE = 0.25;
/** In-zone sources count this much more than the far old islands. */
const HOP_GAIN = 3;
/** Cover a plant arrives with (so the first plant shows at once). */
const ARRIVAL_COVER = 0.4;
const TAKE = 0.3;
/** Pity: a near-missed visitor returns this many play seconds after its need is met (30–75 s). */
const PITY_MIN = 30;
const PITY_SPAN = 45;
/** Never stuck: within this many play seconds once needs are met (common, uncommon, rare). */
const STUCK_CAP = [300, 600, 900];
/** Forced arrivals are spread over this share of the cap, so they do not all come at once. */
const STUCK_LO = 0.45;
const STUCK_HI = 0.92;
/** The very first arrival comes this soon after first land. */
export const FIRST_FLOOR = 14;
/** "Lost" is told only after this many years gone from every island. */
const LOST_AFTER = 200;

export interface SpeciesState {
  found: boolean;
  firstYear: number;
  visitTold: boolean;
  lastReason: ReasonCode | null;
  lastVisitPlay: number;
  /** Island id and reason of the last failed visit (while never established). */
  nearMiss: { island: number; reason: ReasonCode } | null;
  /** Needs seen met on an island: play time, island id and the forced-arrival deadline. */
  metAt: number;
  metIsland: number;
  deadline: number;
  /** Year it was last seen nowhere (-1 while living somewhere). */
  absentSince: number;
  lostTold: boolean;
  /** Lull-guard multiplier on its arrival odds. */
  boost: number;
  /** Island ids it has lived on (its first time on each is news). */
  islands: number[];
}

function freshState(): SpeciesState {
  return { found: false, firstYear: -1, visitTold: false, lastReason: null, lastVisitPlay: -1e9, nearMiss: null, metAt: -1, metIsland: 0, deadline: -1, absentSince: -1, lostTold: false, boost: 1, islands: [] };
}

export type StormPhaseNow = 'none' | 'warning' | 'peak' | 'clearing';

interface Spot {
  p: number;
  v: number;
  reason: ReasonCode | null;
  partial: number;
  crowded: boolean;
}

export class Arrivals implements HintSource {
  sp: SpeciesState[];
  readonly events: ArrivalEvent[] = [];
  /** Play time of the last new species (for plateau hints). */
  lastNewPlay = 0;
  stormPhase: StormPhaseNow = 'none';
  private spot: Spot = { p: -1, v: 0, reason: null, partial: 0, crowded: false };
  private targets = new Float32Array(0);
  private hopSum = 0;
  private hopFrom = -1;
  /** Set by spotValue: the spot failed only because a stronger plant holds it. */
  private crowded = false;
  /** Per species: a patch where its needs were last seen met (-1 none). */
  private goodSpot: Int32Array;

  constructor(
    private w: EcoWorld,
    private sweep: Sweep,
    private fauna: Fauna,
    private director: Director,
  ) {
    this.sp = Array.from({ length: w.t.n }, freshState);
    this.goodSpot = new Int32Array(w.t.n).fill(-1);
  }

  get foundCount(): number {
    let n = 0;
    for (const s of this.sp) if (s.found) n++;
    return n;
  }

  /** Lives on some island right now. */
  living(s: number): boolean {
    const w = this.w;
    for (let slot = 0; slot < w.islands.count; slot++) if (w.present[slot * w.t.n + s]) return true;
    return false;
  }

  // ---------- each step ----------

  /** One step of arrivals (a generator: the boundary runs it in slices). */
  *step(dt: number): Generator<void, void, void> {
    const w = this.w;
    const t = w.t;
    const isl = w.islands;
    const nS = t.n;
    this.computeTargets();
    const storming = this.stormPhase === 'peak' || this.stormPhase === 'clearing';
    for (let slot = 0; slot < isl.count; slot++) {
      const rec = isl.rec(slot);
      const hasSea = isl.seaStart[slot + 1] > isl.seaStart[slot];
      const dEast = Math.max(0, Math.min(ZONE_SIZE, ORIGIN_X + ZONE_SIZE - rec.centroid[0]));
      for (let s = 0; s < nS; s++) {
        if (w.present[slot * nS + s] || t.isWhale[s]) continue;
        if ((t.marine[s] || t.marineAnimal[s]) && !hasSea) continue;
        const r = t.roads[s];
        let stormMul = 1;
        if (t.stormOnly[s]) stormMul = storming ? 25 : 0;
        else if (r & (RoadBit.raft | RoadBit.storm)) stormMul = storming ? 8 : r & ~(RoadBit.raft | RoadBit.storm) ? 1 : 0.25;
        if (stormMul === 0) continue;
        const outside = Math.pow(t.reach[s], 0.5 + dEast / ZONE_SIZE);
        this.inZone(s, slot);
        const hop = this.hopSum;
        const lam = ((RATE_SCALE * t.rate[s]) / 100) * (outside + hop) * this.target(slot, s) * stormMul * this.sp[s].boost;
        if (lam <= 0) continue;
        if (w.rng.next() >= chance(lam, dt)) continue;
        const viaHop = hop > outside ? this.hopFrom : -1;
        this.attempt(s, slot, this.pickRoad(s, storming), false, viaHop, false);
      }
      if (slot + 1 < isl.count) yield;
    }
    this.firstFloor();
    yield;
    yield* this.pity();
    this.absences();
  }

  /** Per island, how big a target it is for each road (wind, sea, bird, storm). */
  private computeTargets(): void {
    const w = this.w;
    const isl = w.islands;
    if (this.targets.length < isl.count * 4) this.targets = new Float32Array(isl.count * 4 + 16);
    for (let slot = 0; slot < isl.count; slot++) {
      const rec = isl.rec(slot);
      const size = Math.sqrt(rec.area / REF_AREA);
      const tall = Math.min(1.5, Math.max(0, rec.peak[1]) / REF_PEAK);
      const forestShare = w.cur.land[slot] > 0 ? w.cur.forest[slot] / w.cur.land[slot] : 0;
      const colony = rec.colonySp >= 0 ? 1 : 0;
      const o = slot * 4;
      this.targets[o] = Math.max(0.02, size * (0.4 + 0.6 * tall));
      this.targets[o + 1] = Math.max(0.02, rec.shore / REF_SHORE);
      this.targets[o + 2] = Math.max(0.02, size * (0.5 + 0.5 * tall) * (1 + 0.5 * colony + 0.5 * forestShare));
      this.targets[o + 3] = Math.max(0.02, size);
    }
  }

  /** The island as a target for species s: by its best road. */
  private target(slot: number, s: number): number {
    const r = this.w.t.roads[s];
    const o = slot * 4;
    let best = 0;
    if (r & RoadBit.wind) best = Math.max(best, this.targets[o]);
    if (r & (RoadBit.sea | RoadBit.raft)) best = Math.max(best, this.targets[o + 1]);
    if (r & (RoadBit.bird | RoadBit.flight)) best = Math.max(best, this.targets[o + 2]);
    if (r & RoadBit.storm) best = Math.max(best, this.targets[o + 3]);
    return best;
  }

  /** Hops from islands in the zone where it already lives (sets hopSum and hopFrom). */
  private inZone(s: number, slot: number): void {
    const w = this.w;
    const isl = w.islands;
    const rec = isl.rec(slot);
    let sum = 0;
    let best = 0;
    let from = -1;
    for (let o = 0; o < isl.count; o++) {
      if (o === slot || !w.present[o * w.t.n + s]) continue;
      const a = abundance(w, o, s) * Math.exp(-islandGap(rec, isl.rec(o)) / w.t.hop[s]) * HOP_GAIN;
      sum += a;
      if (a > best) {
        best = a;
        from = isl.ids[o];
      }
    }
    this.hopSum = sum;
    this.hopFrom = from;
  }

  private pickRoad(s: number, storming: boolean): Road {
    const r = this.w.t.roads[s];
    if (storming && r & (RoadBit.raft | RoadBit.storm)) return r & RoadBit.raft ? 'raft' : 'storm';
    let calm = r & ~(RoadBit.raft | RoadBit.storm);
    if (calm === 0) calm = r;
    let n = 0;
    for (let b = 0; b < 6; b++) if (calm & (1 << b)) n++;
    let k = Math.floor(this.w.rng.next() * n);
    for (let b = 0; b < 6; b++) {
      if (!(calm & (1 << b))) continue;
      if (k-- === 0) return ROADS[b];
    }
    return ROADS[0];
  }

  // ---------- one arrival ----------

  /**
   * Species s arrives at island slot by `road`. `forced` arrivals (pity, never-stuck, the first
   * arrival, castaways) search harder for a landing spot. Returns true if it stayed.
   */
  attempt(s: number, slot: number, road: Road, forced: boolean, hopFrom: number, castaway: boolean): boolean {
    const w = this.w;
    const t = w.t;
    const rec = w.islands.rec(slot);
    const st = this.sp[s];
    let ok = false;
    let reason: ReasonCode | null = null;
    let p = -1;
    if (t.isPlant[s]) {
      // A species new to the sea squeezes in among the established plants (a few seedlings).
      const squeeze = !st.found;
      const take = forced ? 0.2 : TAKE;
      let spot = this.findSpot(s, slot, road, forced ? 40 : 6, false, squeeze, true);
      let best = spot.v;
      let bestP = spot.p;
      let why = spot.reason;
      let partial = spot.partial;
      let crowded = spot.crowded;
      if (best < take) {
        // Drifting on along the same road, it may still find a place that suits it.
        const good = this.goodSpot[s];
        if (good >= 0 && w.slotOfPatch(good) === slot) {
          const v = this.spotValue(s, good, slot, squeeze);
          if (v > best) {
            best = v;
            bestP = good;
          }
        }
        if (best < take) {
          spot = this.findSpot(s, slot, road, 24, true, squeeze, true);
          if (spot.v > best) {
            best = spot.v;
            bestP = spot.p;
          }
          if (spot.partial > partial && spot.reason) {
            partial = spot.partial;
            why = spot.reason;
          }
          crowded = crowded || spot.crowded;
        }
      }
      p = bestP;
      if (bestP >= 0 && best >= take) {
        const o = bestP * LAYERS + t.layer[s];
        w.f.sp[o] = s + 1;
        w.f.cov[o] = Math.min(ARRIVAL_COVER, best);
        this.sweep.wake(bestP);
        this.sweep.markChanged(bestP, true);
        ok = true;
      } else if (crowded && why === null) return false;
      else reason = why ?? t.mainNeed[s];
    } else {
      const K = this.fauna.K(s, slot);
      p = this.animalSpot(s, slot, road);
      if (K >= 0.03) {
        const i = slot * t.n + s;
        w.pop[i] = Math.max(w.pop[i], 0.15 * K, 0.02);
        ok = true;
      } else reason = this.fauna.reason ?? t.mainNeed[s];
    }
    const x = p >= 0 ? patchX(p) : rec.centroid[0];
    const z = p >= 0 ? patchZ(p) : rec.centroid[1];
    const place = p >= 0 ? this.placeOf(p, rec.places) : null;
    if (ok) {
      w.present[slot * t.n + s] = 1;
      const first = !st.found;
      const returned = first && st.nearMiss !== null;
      const afterLost = !first && st.lostTold;
      const newHere = !st.islands.includes(rec.id);
      if (newHere) st.islands.push(rec.id);
      if (first) {
        st.found = true;
        st.firstYear = w.year;
        this.lastNewPlay = w.realPlay;
      }
      st.lostTold = false;
      st.absentSince = -1;
      st.nearMiss = null;
      st.metAt = -1;
      st.deadline = -1;
      st.boost = 1;
      this.director.onEstablish(s, rec.id, x, z, road, { first, returned, afterLost, hopFrom, castaway, place, newHere });
      this.events.push({ species: s, road, x, z, island: rec.id, ok: true, first, returned: returned || afterLost });
      return true;
    }
    if (!st.found && reason) {
      const changed = reason !== st.lastReason && w.realPlay - st.lastVisitPlay >= 120;
      if (!st.visitTold || changed) {
        st.visitTold = true;
        st.lastReason = reason;
        st.lastVisitPlay = w.realPlay;
        this.director.onVisit(s, rec.id, x, z, road, reason, place);
        this.events.push({ species: s, road, x, z, island: rec.id, ok: false, first: false, returned: false });
      }
      st.nearMiss = { island: rec.id, reason };
    }
    return false;
  }

  /** The recognised place a patch is part of (only if its island has that place), for stories. */
  private placeOf(p: number, islandPlaces: number): PlaceKind | null {
    const k = placeOfFlags(this.w.f.flags[p], this.w.f.h[p] > 0);
    return k && islandPlaces & (1 << PLACE_KINDS.indexOf(k)) ? k : null;
  }

  /** Where an animal shows up: a patch of its habitat if there is one, else by its road. */
  private animalSpot(s: number, slot: number, road: Road): number {
    const w = this.w;
    const t = w.t;
    const isl = w.islands;
    const marine = t.marineAnimal[s] === 1;
    const start = marine ? isl.seaStart : isl.landStart;
    const list = marine ? isl.sea : isl.land;
    const a = start[slot];
    const n = start[slot + 1] - a;
    if (n <= 0) return -1;
    const hm = t.habMask[s];
    for (let k = 0; k < 16; k++) {
      const p = list[a + Math.floor(w.rng.next() * n)];
      if (hm === 0 || w.f.lifeMask[p] & hm) return p;
    }
    if (road === 'sea' || road === 'raft') {
      const ss = isl.shoreStart[slot];
      const sn = isl.shoreStart[slot + 1] - ss;
      if (sn > 0) return isl.shore[ss + Math.floor(w.rng.next() * sn)];
    }
    return list[a + Math.floor(w.rng.next() * n)];
  }

  /**
   * The best landing patch for plant s on island slot by `road`, trying `tries` spots. With
   * `explain`, also finds the most promising failure (reason + partial) for the story.
   */
  findSpot(s: number, slot: number, road: Road, tries: number, uniform: boolean, squeeze: boolean, explain: boolean): Spot {
    const w = this.w;
    const t = w.t;
    const suit = w.suit;
    const out = this.spot;
    out.p = -1;
    out.v = 0;
    out.reason = null;
    out.partial = -1;
    out.crowded = false;
    const L = t.layer[s];
    const marine = t.marine[s] === 1;
    for (let k = 0; k < tries; k++) {
      const p = this.candidate(slot, road, marine, uniform);
      if (p < 0) break;
      const v = this.spotValue(s, p, slot, squeeze);
      if (v > 0) {
        if (v > out.v) {
          out.v = v;
          out.p = p;
        }
      } else if (this.crowded) out.crowded = true;
      else if (explain) {
        suit.plant(s, p, slot, suit.light(p, L), this.vegAround(p), true);
        if (suit.partial > out.partial && suit.reason) {
          out.partial = suit.partial;
          out.reason = suit.reason;
          if (out.p < 0 && out.v === 0) out.p = p;
        }
      }
    }
    if (out.v > 0) out.reason = null;
    return out;
  }

  /**
   * How well plant s would do landing in patch p: its suitability, or 0 when the place does not
   * suit it or a stronger plant already holds its layer there (this.crowded tells which).
   * With `squeeze`, a newcomer takes the spot unless the holder is much the stronger.
   */
  private spotValue(s: number, p: number, slot: number, squeeze: boolean): number {
    const w = this.w;
    const t = w.t;
    const suit = w.suit;
    const L = t.layer[s];
    const light = suit.light(p, L);
    const veg = this.vegAround(p);
    this.crowded = false;
    const v = suit.plant(s, p, slot, light, veg, false);
    if (v <= 0) return 0;
    const o1 = w.f.sp[p * LAYERS + L];
    if (o1 !== 0) {
      const o = o1 - 1;
      if (o === s || v * t.rank[s] <= suit.plant(o, p, slot, light, veg, false) * t.rank[o] * (squeeze ? 0.5 : 1.05)) {
        this.crowded = true;
        return 0;
      }
    }
    return v;
  }

  private vegAround(p: number): number {
    const v = this.sweep.veg;
    const pi = p % NP;
    const pk = (p / NP) | 0;
    return v[p] | (pi > 0 ? v[p - 1] : 0) | (pi < NP - 1 ? v[p + 1] : 0) | (pk > 0 ? v[p - NP] : 0) | (pk < NP - 1 ? v[p + NP] : 0);
  }

  /** A landing patch by road (deterministic from the world's random stream). */
  private candidate(slot: number, road: Road, marine: boolean, uniform: boolean): number {
    const w = this.w;
    const isl = w.islands;
    const f = w.f;
    const rng = w.rng;
    if (marine) {
      const a = isl.seaStart[slot];
      const n = isl.seaStart[slot + 1] - a;
      return n > 0 ? isl.sea[a + Math.floor(rng.next() * n)] : -1;
    }
    const la = isl.landStart[slot];
    const ln = isl.landStart[slot + 1] - la;
    if (ln <= 0) return -1;
    if (road === 'sea' || road === 'raft') {
      const a = isl.shoreStart[slot];
      const n = isl.shoreStart[slot + 1] - a;
      if (n > 0) {
        // The current and the wind bring flotsam to windward shores first.
        for (let k = 0; k < 4; k++) {
          const p = isl.shore[a + Math.floor(rng.next() * n)];
          if (uniform || k === 3 || rng.next() < 0.35 + 0.65 * Math.max(0, f.wind[p])) return p;
        }
      }
    } else if (road === 'bird') {
      const T = w.cur;
      const n = Math.min(PERCH_N, T.perchSeen[slot]);
      if (n > 0) {
        const perch = T.perch[slot * PERCH_N + Math.floor(rng.next() * n)];
        const pi = Math.max(0, Math.min(NP - 1, (perch % NP) + Math.floor(rng.next() * 5) - 2));
        const pk = Math.max(0, Math.min(NP - 1, ((perch / NP) | 0) + Math.floor(rng.next() * 5) - 2));
        const p = pi + pk * NP;
        if (f.isl[p] === isl.ids[slot]) return p;
        return perch;
      }
    } else {
      // Wind: anywhere, but high and windward ground combs the most out of the air.
      for (let k = 0; k < 4; k++) {
        const p = isl.land[la + Math.floor(rng.next() * ln)];
        const wgt = (0.35 + 0.65 * Math.min(1, f.h[p] / 60)) * (0.6 + 0.4 * Math.max(0, f.wind[p]));
        if (uniform || k === 3 || rng.next() < wgt) return p;
      }
    }
    return isl.land[la + Math.floor(rng.next() * ln)];
  }

  // ---------- guarantees ----------

  /** Could species s stay somewhere right now? The island slot, or -1. */
  needsMet(s: number): number {
    const w = this.w;
    const t = w.t;
    const isl = w.islands;
    const squeeze = !this.sp[s].found;
    // The spot found last time, if it still suits.
    const good = this.goodSpot[s];
    if (t.isPlant[s] && good >= 0) {
      const slot = w.slotOfPatch(good);
      if (slot >= 0 && this.spotValue(s, good, slot, squeeze) >= 0.35) return slot;
    }
    for (let slot = 0; slot < isl.count; slot++) {
      if ((t.marine[s] || t.marineAnimal[s]) && isl.seaStart[slot + 1] === isl.seaStart[slot]) continue;
      if (t.isPlant[s]) {
        // A fair search of the island along each of its roads.
        const r = t.roads[s];
        for (let b = 0; b < 6; b++) {
          if (!(r & (1 << b))) continue;
          const spot = this.findSpot(s, slot, ROADS[b], 24, true, squeeze, false);
          if (spot.v >= 0.35) {
            this.goodSpot[s] = spot.p;
            return slot;
          }
        }
      } else if (this.fauna.K(s, slot) >= 0.05) return slot;
    }
    return -1;
  }

  /** Watch for needs being met; force the arrival when its time comes. */
  private *pity(): Generator<void, void, void> {
    const w = this.w;
    const t = w.t;
    const nS = t.n;
    const isl = w.islands;
    // Check an eighth of the catalogue per step (each species every ~4 s at normal pace).
    let checked = 0;
    for (let s = w.step & 7; s < nS; s += 8) {
      const st = this.sp[s];
      if (t.isWhale[s] || t.stormOnly[s] || this.living(s)) {
        st.metAt = -1;
        st.deadline = -1;
        continue;
      }
      const slot = this.needsMet(s);
      if (++checked % 4 === 0) yield;
      if (slot < 0) {
        st.metAt = -1;
        st.deadline = -1;
        continue;
      }
      if (st.deadline < 0) {
        st.metAt = w.realPlay;
        st.metIsland = isl.ids[slot];
        const u = w.rng.next();
        const cap = STUCK_CAP[t.rarity[s]];
        st.deadline = st.nearMiss ? w.realPlay + PITY_MIN + PITY_SPAN * u : w.realPlay + cap * (STUCK_LO + (STUCK_HI - STUCK_LO) * u);
      }
    }
    for (let s = 0; s < nS; s++) {
      const st = this.sp[s];
      if (st.deadline < 0 || w.realPlay < st.deadline) continue;
      const slot = isl.slotOf[st.metIsland];
      st.deadline = -1;
      if (slot < 0) continue;
      this.attempt(s, slot, this.pickRoad(s, false), true, -1, false);
    }
  }

  /** The very first arrival: a wind traveller within 20 s of first land. */
  private firstFloor(): void {
    const w = this.w;
    if (this.foundCount > 0 || w.realPlay - this.director.book.openedAt < FIRST_FLOOR || w.islands.count === 0) return;
    const t = w.t;
    // Wind travellers, most eager first.
    const order: number[] = [];
    for (let s = 0; s < t.n; s++) if (t.roads[s] & RoadBit.wind && !t.marine[s] && !t.stormOnly[s]) order.push(s);
    order.sort((a, b) => t.rate[b] * t.reach[b] - t.rate[a] * t.reach[a]);
    let bigSlot = 0;
    for (let slot = 1; slot < w.islands.count; slot++) if (w.islands.rec(slot).area > w.islands.rec(bigSlot).area) bigSlot = slot;
    for (const s of order) {
      if (t.isPlant[s]) {
        const spot = this.findSpot(s, bigSlot, 'wind', 30, true, true, false);
        if (spot.v < 0.2) continue;
      } else if (this.fauna.K(s, bigSlot) < 0.03) continue;
      if (this.attempt(s, bigSlot, 'wind', true, -1, false)) return;
    }
  }

  /** Species gone from every island: told as "lost" only after a long absence. */
  private absences(): void {
    const w = this.w;
    for (let s = 0; s < w.t.n; s++) {
      const st = this.sp[s];
      if (!st.found) continue;
      if (this.living(s)) {
        st.absentSince = -1;
        continue;
      }
      if (st.absentSince < 0) st.absentSince = w.year;
      if (!st.lostTold && w.year - st.absentSince >= LOST_AFTER) {
        st.lostTold = true;
        this.director.onLost(s);
      }
    }
  }

  /** Lull guard: nothing to tell for a while, so something plausible gets better odds. */
  lull(): void {
    for (const st of this.sp) if (st.boost > 1) return;
    let best = -1;
    let bestAt = 1e18;
    for (let s = 0; s < this.sp.length; s++) {
      const st = this.sp[s];
      if (st.metAt >= 0 && st.metAt < bestAt && st.boost === 1) {
        bestAt = st.metAt;
        best = s;
      }
    }
    if (best >= 0) this.sp[best].boost = 3;
  }

  // ---------- what the director asks (HintSource) ----------

  buildableWait(skip: (s: number) => boolean): number {
    let best = -1;
    let at = -1e18;
    for (let s = 0; s < this.sp.length; s++) {
      const st = this.sp[s];
      if (st.found || !st.nearMiss || !isBuildableReason(st.nearMiss.reason) || skip(s)) continue;
      if (st.lastVisitPlay > at) {
        at = st.lastVisitPlay;
        best = s;
      }
    }
    return best;
  }

  farWait(): number {
    const t = this.w.t;
    for (let s = 0; s < t.n; s++) if (!this.sp[s].found && t.reach[s] < 0.3 && this.sp[s].metAt >= 0) return s;
    return -1;
  }

  islandWait(skip: (s: number) => boolean): number {
    const w = this.w;
    const t = w.t;
    for (let s = 0; s < t.n; s++) {
      if (this.sp[s].found || t.isWhale[s] || skip(s)) continue;
      const st = this.sp[s];
      const r = st.nearMiss?.reason ?? t.mainNeed[s];
      if (r === 'needs-island-nearby' || r === 'too-small' || r === 'no-stack') return s;
    }
    return -1;
  }

  placeWaiting(kind: PlaceKind, island: number): number {
    let best = -1;
    let bestScore = -1e18;
    for (let s = 0; s < this.sp.length; s++) {
      const st = this.sp[s];
      if (st.found || !st.nearMiss || !placeAnswers(kind, st.nearMiss.reason)) continue;
      const score = st.lastVisitPlay + (st.nearMiss.island === island ? 1e9 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  // ---------- save ----------

  save(keys: readonly string[]): Record<string, SpeciesState> {
    const out: Record<string, SpeciesState> = {};
    this.sp.forEach((st, s) => (out[keys[s]] = { ...st, islands: st.islands.slice() }));
    return out;
  }

  load(states: Record<string, SpeciesState>, keyToId: (k: string) => number): void {
    this.sp = Array.from({ length: this.w.t.n }, freshState);
    for (const [k, st] of Object.entries(states)) {
      const s = keyToId(k);
      if (s >= 0) this.sp[s] = { ...freshState(), ...st, islands: (st.islands ?? []).slice() };
    }
  }
}
