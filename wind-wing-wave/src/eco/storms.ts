/**
 * Storms: a little drama, in real time (ARCHITECTURE §3, PLAN "Storms").
 *
 * Schedule: the first storm waits until 15 real minutes after first land AND shrubs exist.
 * Then storms come only in the wet season (from the page's sky clock): one per wet season,
 * plus a 40% chance of a second. "Gentle storms" makes them rarer and softer.
 *
 * Phases: warning 30–45 s (light turns, swell rises), peak ~60 s (the years slow to 10%),
 * clearing ~30 s (rainbow). At the peak, in three pulses:
 * - windward trees blow down (palms bend, she-oaks snap), leaving logs that nurse new trees;
 * - salt spray triples and scorches what cannot take it;
 * - shallow exposed coral is broken;
 * - the surf works the beaches (geo.stormPulse).
 * Losses are capped and regrow within about two minutes. At clearing, every storm leaves
 * something: driftwood on the windward beach, sometimes a raft of castaways, sometimes a bird
 * blown off course. The journal tells it once: "the storm of Year N".
 */
import { DAY_SECONDS, type Season } from '../config';
import type { Road } from '../content/speciesTypes';
import type { StormState } from '../engine/protocol';
import { RoadBit } from './catalog';
import type { Arrivals } from './arrivals';
import type { Director } from './director';
import { Flag, L_CANOPY, L_GROUND, L_SHRUB, LAYERS } from './fields';
import type { Sweep } from './succession';
import type { EcoWorld } from './world';

const FIRST_AFTER = 15 * 60;
const MIN_SHRUBS = 10;
const PEAK = 60;
const CLEAR = 30;

export interface StormSave {
  state: StormState;
  plan: number[];
  plannedThisWet: boolean;
  count: number;
  warnLen: number;
  pulses: number;
  fallen: number;
  told: boolean;
  gentle: boolean;
}

/** Shared with the ecology: while set, terrain changes are the sea's own work, not the player's. */
export interface DriftFlag {
  on: boolean;
}

export class Storms {
  state: StormState = { phase: 'none', t: 0, level: 0, great: false };
  /** Real-play times of storms planned in this wet season. */
  private plan: number[] = [];
  private plannedThisWet = false;
  private count = 0;
  private warnLen = 38;
  private pulses = 0;
  private fallen = 0;
  private told = false;
  private gentle = false;
  /** Shoreline columns for the surf (set by the zone commit). */
  shoreCols: Int32Array = new Int32Array(0);
  shoreN = 0;

  constructor(
    private w: EcoWorld,
    private sweep: Sweep,
    private arrivals: Arrivals,
    private director: Director,
    private drift: DriftFlag,
  ) {}

  /** Years-per-second multiplier: the clock slows to 10% at the peak. */
  get ypsFactor(): number {
    const s = this.state;
    if (s.phase === 'warning') return 1 - (0.5 * s.t) / this.warnLen;
    if (s.phase === 'peak') return 0.1;
    if (s.phase === 'clearing') return 0.1 + (0.9 * s.t) / CLEAR;
    return 1;
  }

  get active(): boolean {
    return this.state.phase !== 'none';
  }

  /** Real-time update while the game runs (not paused). */
  update(dt: number, season: Season, dayPhase: number, gentle: boolean): void {
    const w = this.w;
    this.gentle = gentle;
    const s = this.state;
    if (s.phase === 'none') {
      this.schedule(season, dayPhase);
      return;
    }
    s.t += dt;
    if (s.phase === 'warning') {
      s.level = (0.6 * Math.min(s.t, this.warnLen)) / this.warnLen;
      if (s.t >= this.warnLen) this.enter('peak');
    } else if (s.phase === 'peak') {
      s.level = 1;
      const k = gentle ? 0.6 : 1;
      // The surf reshapes the beaches: the sea's work (drift), never mistaken for the player's
      // strokes (no undo snapshots, no life reset unless the sand really moves).
      this.drift.on = true;
      try {
        w.geo.stormPulse(s.level * k, dt, this.shoreCols, this.shoreN);
      } finally {
        this.drift.on = false;
      }
      // Three pulses of damage at 10, 30 and 50 s.
      while (this.pulses < 3 && s.t >= 10 + 20 * this.pulses) {
        this.damage(this.pulses);
        this.pulses++;
      }
      if (s.t >= PEAK) this.enter('clearing');
    } else {
      s.level = Math.max(0, 1 - s.t / CLEAR);
      if (!this.told) {
        this.told = true;
        this.aftermath();
      }
      if (s.t >= CLEAR) this.enter('none');
    }
    w.suit.saltMult = 1 + 2 * s.level;
    w.geo.setStorm(s.level * (gentle ? 0.6 : 1));
    this.arrivals.stormPhase = s.phase;
  }

  /** Start a storm warning now (debug and checks). */
  startNow(): void {
    if (this.state.phase !== 'none') return;
    this.begin();
  }

  private schedule(season: Season, dayPhase: number): void {
    const w = this.w;
    if (season === 'dry') {
      this.plannedThisWet = false;
      this.plan.length = 0;
      return;
    }
    const eligible = w.realPlay >= FIRST_AFTER && w.cur.shrubTotal >= MIN_SHRUBS;
    const remaining = (1 - (((dayPhase % 1) + 1) % 1)) * DAY_SECONDS;
    if (!this.plannedThisWet && eligible) {
      this.plannedThisWet = true;
      const rng = w.rng;
      const many = this.gentle ? (rng.next() < 0.6 ? 1 : 0) : 1;
      if (many > 0 && remaining > 45) {
        // The first-ever storm comes soon after it becomes possible; later ones anywhere in the season.
        const span = this.count === 0 ? Math.min(240, remaining - 40) : remaining - 60;
        const first = w.realPlay + 5 + rng.next() * Math.max(5, span - 5);
        this.plan.push(first);
        if (!this.gentle && rng.next() < 0.4) {
          const second = first + 240 + rng.next() * 180;
          if (second < w.realPlay + remaining - 60) this.plan.push(second);
        }
      }
    }
    if (this.plan.length > 0 && w.realPlay >= this.plan[0]) {
      this.plan.shift();
      if (eligible) this.begin();
    }
  }

  private begin(): void {
    const w = this.w;
    this.count++;
    this.warnLen = 30 + w.rng.next() * 15;
    this.pulses = 0;
    this.fallen = 0;
    this.told = false;
    this.state = { phase: 'warning', t: 0, level: 0, great: this.count % 3 === 0 && !this.gentle };
  }

  private enter(phase: StormState['phase']): void {
    this.state = { phase, t: 0, level: phase === 'peak' ? 1 : phase === 'clearing' ? 1 : 0, great: this.state.great };
    if (phase === 'none') {
      this.w.suit.saltMult = 1;
      this.w.geo.setStorm(0);
      this.arrivals.stormPhase = 'none';
    }
  }

  /** One pulse of wind and salt and surf on the living things. */
  private damage(pulse: number): void {
    const w = this.w;
    const f = w.f;
    const t = w.t;
    const k = (this.gentle ? 0.5 : 1) * (this.state.great ? 1.3 : 1);
    const act = this.sweep.active;
    for (let i = 0; i < this.sweep.activeN; i++) {
      const p = act[i];
      const o = p * LAYERS;
      const h = f.h[p];
      let hit = false;
      if (h > 0) {
        const expo = Math.min(1, 0.12 + 0.88 * Math.max(0, f.wind[p])) * (0.55 + 0.45 * Math.min(1, h / 40)) * (f.flags[p] & Flag.RainShadow ? 0.5 : 1);
        for (let L = L_SHRUB; L <= L_CANOPY; L++) {
          const s1 = f.sp[o + L];
          if (s1 === 0) continue;
          const c = f.cov[o + L];
          const loss = (L === L_CANOPY ? 0.22 : 0.1) * k * expo * (1 - t.firm[s1 - 1]);
          if (loss <= 0.005) continue;
          f.cov[o + L] = c * (1 - loss);
          f.logs[p] = Math.min(1, f.logs[p] + (L === L_CANOPY ? c * loss * 1.5 : 0));
          if (L === L_CANOPY && c * loss >= 0.06) this.fallen++;
          hit = true;
        }
        // Salt burn on the second pulse, where spray now outruns what plants can take.
        if (pulse === 1 && f.salt[p] >= 0.12) {
          const se = f.salt[p] * w.suit.saltMult;
          for (let L = L_GROUND + 1; L <= L_CANOPY; L++) {
            const s1 = f.sp[o + L];
            if (s1 === 0 || se <= t.saltMax[s1 - 1]) continue;
            f.cov[o + L] *= 1 - 0.3 * k;
            hit = true;
          }
        }
      } else if (h > -5 && f.sp[o + L_SHRUB] !== 0) {
        // Shallow coral facing open water breaks.
        const open = 1 - f.shelter[p];
        f.cov[o + L_SHRUB] *= 1 - (0.4 / 3) * k * open;
        hit = true;
      }
      if (hit) {
        for (let L = 0; L < LAYERS; L++) {
          if (f.sp[o + L] !== 0 && f.cov[o + L] < 0.01) {
            f.sp[o + L] = 0;
            f.cov[o + L] = 0;
          }
        }
        this.sweep.wake(p);
        this.sweep.markChanged(p);
      }
    }
  }

  /** Driftwood, castaways and the journal line. */
  private aftermath(): void {
    const w = this.w;
    const f = w.f;
    const isl = w.islands;
    const rng = w.rng;
    // Driftwood along windward shores (nurse logs for the next trees).
    for (let i = 0; i < this.sweep.activeN; i++) {
      const p = this.sweep.active[i];
      if (f.flags[p] & Flag.Shore && f.wind[p] > 0.2) f.logs[p] = Math.min(1, f.logs[p] + 0.3);
    }
    // The windward-most island catches the castaways.
    let slot = -1;
    let bestX = -1e9;
    for (let s = 0; s < isl.count; s++) {
      const rec = isl.rec(s);
      if (rec.area >= 400 && rec.centroid[0] > bestX) {
        bestX = rec.centroid[0];
        slot = s;
      }
    }
    let castaway = -1;
    let castRoad: Road | null = null;
    let castIsland = 0;
    let raft = 0;
    if (slot >= 0) {
      const great = this.state.great;
      // A raft of tangled branches, sometimes carrying lizards, snails or insects.
      if (rng.next() < (great ? 0.6 : 0.35)) {
        raft = 1;
        castaway = this.cast(slot, RoadBit.raft, 'raft');
        if (castaway >= 0) {
          castRoad = 'raft';
          castIsland = isl.ids[slot];
        }
      }
      // Birds and insects blown off course.
      const vagrants = 1 + Math.floor(rng.next() * (great ? 3 : 2));
      for (let v = 0; v < vagrants; v++) {
        const target = Math.floor(rng.next() * isl.count);
        const to = isl.rec(target).area >= 400 ? target : slot;
        const got = this.cast(to, RoadBit.storm, 'storm');
        if (castaway < 0 && got >= 0) {
          castaway = got;
          castRoad = 'storm';
          castIsland = isl.ids[to];
        }
      }
    }
    const rec = slot >= 0 ? isl.rec(slot) : null;
    this.director.onStorm(
      { fallen: this.fallen, great: this.state.great ? 1 : 0, raft },
      castaway,
      castRoad,
      castIsland || (rec ? rec.id : 0),
      rec ? rec.centroid[0] : 0,
      rec ? rec.centroid[1] : 0,
    );
  }

  /** Bring one castaway by `road` to island slot: one whose needs are met if possible. */
  private cast(slot: number, bit: number, road: 'raft' | 'storm'): number {
    const w = this.w;
    const t = w.t;
    const cands: number[] = [];
    for (let s = 0; s < t.n; s++) {
      if (!(t.roads[s] & bit) && !(road === 'storm' && t.stormOnly[s])) continue;
      if (t.isWhale[s] || w.present[slot * t.n + s]) continue;
      cands.push(s);
    }
    // Shuffle deterministically, then prefer ones that can stay.
    for (let i = cands.length - 1; i > 0; i--) {
      const j = Math.floor(w.rng.next() * (i + 1));
      const tmp = cands[i];
      cands[i] = cands[j];
      cands[j] = tmp;
    }
    for (const s of cands) {
      if (this.arrivals.needsMet(s) < 0) continue;
      if (this.arrivals.attempt(s, slot, road, true, -1, true)) return s;
    }
    // Nobody could stay: one still visits (its story says why).
    if (cands.length > 0) this.arrivals.attempt(cands[0], slot, road, true, -1, true);
    return -1;
  }

  save(): StormSave {
    return {
      state: { ...this.state },
      plan: this.plan.map((x) => x - this.w.realPlay),
      plannedThisWet: this.plannedThisWet,
      count: this.count,
      warnLen: this.warnLen,
      pulses: this.pulses,
      fallen: this.fallen,
      told: this.told,
      gentle: this.gentle,
    };
  }

  load(s: StormSave): void {
    this.state = { ...s.state };
    this.plan = s.plan.map((x) => x + this.w.realPlay);
    this.plannedThisWet = s.plannedThisWet;
    this.count = s.count;
    this.warnLen = s.warnLen;
    this.pulses = s.pulses;
    this.fallen = s.fallen;
    this.told = s.told;
    this.gentle = s.gentle;
    this.arrivals.stormPhase = this.state.phase;
    this.w.suit.saltMult = 1 + 2 * this.state.level;
  }
}
