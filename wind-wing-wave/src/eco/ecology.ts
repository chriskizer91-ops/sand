/**
 * The life simulation (WP-D1): the facade the engine hub talks to. See ARCHITECTURE §3–5.
 *
 * What happens where:
 * - derive.ts      patch heights and materials from the ground, and what shaping does to life
 * - zone.ts        the whole-sea job after the land settles: islands (islands.ts), climate
 *                  (climate.ts), ponds and streams (hydro.ts), places (places.ts)
 * - succession.ts  the yearly sweep: plants, soil, habitats, island tallies
 * - fauna.ts       island-level needs, animal populations, seabird colonies
 * - arrivals.ts    life arriving by wind, sea and wings; "couldn't stay"; the guarantees
 * - storms.ts      real-time storms and what they leave behind
 * - director.ts    journal stories, firsts, Ages, milestones, hints, the ending
 * - journal.ts     the journal and the pacing of cards
 *
 * Clocks: the page's real time drives storms; years advance in fixed one-year steps
 * (ECO_STEP_YEARS) at the chosen pace, spread across work() calls within the time budget.
 * The visible year is the last completed step.
 */
import { ECO_STEP_YEARS, NP, NX, PATCH, SEA_LEVEL, type Season } from '../config';
import { Habitat, Substrate, type SpeciesDef } from '../content/speciesTypes';
import { ChangeFlag, type Columns } from '../engine/columns';
import type { GeoForEco } from '../engine/geo/geo';
import { Rng } from '../engine/noise';
import type { ArrivalEvent, InspectInfo, JournalEntry, LifeInfo, PlaceEvent, StormState } from '../engine/protocol';
import { Arrivals, type SpeciesState } from './arrivals';
import { SpeciesTable, TintCh } from './catalog';
import { Dirty, LocalDerive, type ResetSink } from './derive';
import { Director, type DirectorSave } from './director';
import { Fauna, computeGates } from './fauna';
import { Flag, L_CANOPY, L_GROUND, L_HERB, L_SHRUB, LAYERS, NPATCH, patchAt, patchX, patchZ } from './fields';
import { CHART_AREA, type IslandRec } from './islands';
import { JournalBook } from './journal';
import type { EcoNeeds, ReasonCode } from './needs';
import { nowMs } from './maths';
import type { PatchGrid } from './patches';
import { Storms, type StormSave } from './storms';
import { Sweep } from './succession';
import { EcoWorld } from './world';
import { ZoneJob } from './zone';

export interface EcoClock {
  /** Journal or menu open, or page hidden: years and storms stop. */
  paused: boolean;
  /** Eco years per real second. */
  yps: number;
  /** Sky clock from the page (0..1 within the day) and season. */
  dayPhase: number;
  season: Season;
  gentleStorms: boolean;
}

/** Output buffers for one eco rectangle (sizes: w*h*4, w*h*4, w*h*4, w*h*PLANT_BYTES, w*h). */
export interface EcoPack {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
  plants: Uint8Array;
  habitat: Uint8Array;
}

/** The ecology's own saved state (PatchGrid persistent arrays are saved separately by the hub). */
export interface EcoSave {
  version: number;
  /** JSON-safe state: year, clocks, RNG, islands, species states, journal, populations, storm schedule… */
  state: unknown;
}

/** What serialize() writes into EcoSave.state (version 2). */
interface StateV2 {
  /** Species keys in id order when saved (PatchGrid species bytes are remapped by key on load). */
  keys: string[];
  step: number;
  play: number;
  realPlay: number;
  target: number;
  firstLand: boolean;
  rng: number;
  islands: IslandRec[];
  labeller: ReturnType<ZoneJob['labeller']['save']>;
  pops: [number, string, number][];
  species: Record<string, SpeciesState>;
  journal: (Omit<JournalEntry, 'species'> & { species?: string })[];
  journalNext: number;
  lastCard: number;
  lastVisitCard: number;
  openedAt: number;
  director: DirectorSave;
  storm: StormSave;
  lastNewPlay: number;
  lastRefresh: number;
}

const SAVE_VERSION = 2;
/** Re-run the zone job this long (real s) after the land last changed… */
const SETTLE = 1.2;
/** …but no later than this after the first change of a busy spell. */
const MAX_WAIT = 6;
/** Slow things (soil, age, forests) refresh places and climate this often (play seconds). */
const REFRESH = 20;
/** Most steps the clock may run ahead of the simulation before it slows down instead. */
const BACKLOG = 6;
/** Coast and reef processes run every this many steps. */
const COAST_EVERY = 4;

export class Ecology {
  private w: EcoWorld;
  private derive = new LocalDerive();
  private job = new ZoneJob();
  private sweep: Sweep;
  private fauna: Fauna;
  private book = new JournalBook();
  private director: Director;
  private arrivals: Arrivals;
  private storms: Storms;
  private clock: EcoClock = { paused: false, yps: 2, dayPhase: 0.3, season: 'wet', gentleStorms: false };
  /** Target year (fractional): the steps catch up to it. */
  private target = 0;
  private jobGen: Generator<void, void, void> | null = null;
  private jobDone = false;
  private zonePending = false;
  private pendingSince = -1;
  private lastChange = -1e9;
  private lastRefresh = 0;
  /** Set when the zone job is a periodic refresh (it need not wait for the land to settle). */
  private refreshDue = false;
  private inGeo = false;
  private lifeDirty = true;
  private places: PlaceEvent[] = [];
  private dirty: [number, number, number, number] | null = null;
  private shoreCols: Int32Array = new Int32Array(0);
  private shoreIsles: Uint16Array = new Uint16Array(0);
  private shoreN = 0;
  private reefSand: Float32Array = new Float32Array(0);
  private reefCols: Int32Array = new Int32Array(0);
  private reefAmt: Float32Array = new Float32Array(0);
  private sink: ResetSink;

  constructor(
    readonly cols: Columns,
    readonly grid: PatchGrid,
    readonly geo: GeoForEco,
    readonly seed: number,
    readonly species: readonly SpeciesDef<EcoNeeds>[],
  ) {
    const t = new SpeciesTable(species);
    this.w = new EcoWorld(cols, grid, geo, seed, t);
    this.w.features = this.job.features;
    this.sweep = new Sweep(this.w);
    this.fauna = new Fauna(this.w);
    this.director = new Director(this.w, this.book);
    this.arrivals = new Arrivals(this.w, this.sweep, this.fauna, this.director);
    this.storms = new Storms(this.w, this.sweep, this.arrivals, this.director);
    const w = this.w;
    const director = this.director;
    const sweep = this.sweep;
    this.sink = {
      get year() {
        return w.year;
      },
      touch: (p) => grid.touch(p),
      burned: (p, canopy) => director.burned(w.f.isl[p], canopy, patchX(p), patchZ(p)),
      reset: (p) => {
        sweep.wake(p);
        sweep.markChanged(p);
        const pi = p % NP;
        const pk = (p / NP) | 0;
        if (pi > 0) sweep.wake(p - 1);
        if (pi < NP - 1) sweep.wake(p + 1);
        if (pk > 0) sweep.wake(p - NP);
        if (pk < NP - 1) sweep.wake(p + NP);
      },
    };
    this.rebuildAll(true);
    // Land already there (a scripted world): it counts as first land, at year 0.
    let land = -1;
    for (let p = 0; p < NPATCH && land < 0; p++) if (w.f.h[p] > 0.2) land = p;
    if (land >= 0) this.landed(patchX(land), patchZ(land));
  }

  /** Completed eco year (integer steps). */
  get year(): number {
    return this.w.step * ECO_STEP_YEARS;
  }
  /** Has any land ever broken the surface (the year clock starts then). */
  get firstLand(): boolean {
    return this.w.firstLand;
  }
  get storm(): StormState {
    return this.storms.state;
  }
  /** Patches currently simulated. */
  get activePatches(): number {
    return this.sweep.activeN;
  }
  /** Play seconds since first land (eco step time at the chosen pace). */
  get playSeconds(): number {
    return this.w.play;
  }

  // ---------- inputs ----------

  /** Terrain changed in a column rectangle (inclusive). flags: ChangeFlag bits. */
  onTerrainChanged(i0: number, k0: number, i1: number, k1: number, flags: number): void {
    if (flags & (ChangeFlag.Geom | ChangeFlag.Burn) || (flags & ChangeFlag.Look && flags & ChangeFlag.Tool)) {
      let why: number = Dirty.Geom;
      if (flags & ChangeFlag.Burn) why |= Dirty.Burn;
      if (flags & ChangeFlag.Tool) why |= Dirty.Tool;
      if (this.inGeo) why |= Dirty.Drift;
      this.derive.mark(i0, k0, i1, k1, why);
      this.markDirty(i0 >> 1, k0 >> 1, i1 >> 1, k1 >> 1);
    }
    if (!this.inGeo) {
      this.zonePending = true;
      this.lastChange = this.w.real;
      if (this.pendingSince < 0) this.pendingSince = this.w.real;
    }
    if (!this.w.firstLand) {
      const cols = this.cols;
      for (let k = Math.max(0, k0); k <= Math.min(cols.nz - 1, k1); k++) {
        for (let i = Math.max(0, i0); i <= Math.min(cols.nx - 1, i1); i++) {
          if (cols.surf(i + k * NX) > SEA_LEVEL + 0.2) {
            this.landed(cols.cx(i), cols.cz(k));
            return;
          }
        }
      }
    }
  }

  setClock(c: EcoClock): void {
    this.clock = c;
  }

  /** Move the year clock (and real-time storms) by realDt seconds. */
  advance(realDt: number): void {
    const w = this.w;
    w.real += realDt;
    if (this.clock.paused || !w.firstLand) return;
    w.realPlay += realDt;
    this.storms.update(realDt, this.clock.season, this.clock.dayPhase, this.clock.gentleStorms);
    w.yps = Math.max(0.01, this.clock.yps * this.storms.ypsFactor);
    this.target += (realDt * w.yps) / ECO_STEP_YEARS;
    if (this.target > w.step + BACKLOG) this.target = w.step + BACKLOG;
  }

  /** Do sliced simulation work within budgetMs. Returns ms spent. */
  work(budgetMs: number): number {
    const t0 = nowMs();
    const deadline = t0 + budgetMs;
    const w = this.w;
    if (this.derive.pending > 0) this.derive.apply(this.cols, w.f, this.sink);
    // The whole-sea job runs first once the land has settled.
    if (!this.jobGen && !this.jobDone && this.zonePending && (this.refreshDue || w.real - this.lastChange >= SETTLE || w.real - this.pendingSince >= MAX_WAIT)) {
      this.zonePending = false;
      this.refreshDue = false;
      this.pendingSince = -1;
      this.jobGen = this.job.run(w);
    }
    if (this.jobGen) {
      while (nowMs() < deadline) {
        if (this.jobGen.next().done) {
          this.jobGen = null;
          this.jobDone = true;
          break;
        }
      }
      if (this.jobGen) return nowMs() - t0;
    }
    if (this.jobDone && !this.sweep.inProgress) this.commit(false);
    // Then the years.
    while (w.firstLand && (this.sweep.inProgress || w.step + 1 <= this.target) && nowMs() < deadline) {
      if (!this.sweep.inProgress) {
        if (this.jobDone) this.commit(false);
        this.sweep.begin();
      }
      if (this.sweep.some(deadline, nowMs)) this.stepBoundary();
    }
    this.book.tick(w.play);
    return nowMs() - t0;
  }

  /** Patch rectangle (inclusive) changed since the last call, for the eco stream. */
  takeDirty(): [number, number, number, number] | null {
    this.collectDirty();
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /** The changed rectangle without taking it. */
  isDirtyRect(): [number, number, number, number] | null {
    this.collectDirty();
    return this.dirty;
  }

  /** Pack a patch rectangle for the page (see protocol.ts 'eco' message). */
  packEco(x0: number, z0: number, wd: number, ht: number, out: EcoPack): void {
    const f = this.w.f;
    const t = this.w.t;
    let o = 0;
    for (let pk = z0; pk < z0 + ht; pk++) {
      for (let pi = x0; pi < x0 + wd; pi++, o++) {
        const p = pi + pk * NP;
        const l = p * LAYERS;
        const o4 = o * 4;
        const land = f.h[p] > 0;
        const g = f.cov[l + L_GROUND];
        const gs = f.sp[l + L_GROUND] - 1;
        const tint = gs >= 0 ? t.tint[gs] : TintCh.None;
        const herb = f.cov[l + L_HERB];
        const shrub = f.cov[l + L_SHRUB];
        const can = f.cov[l + L_CANOPY];
        const canSp = f.sp[l + L_CANOPY] - 1;
        // A: lichen/crust, moss, grass/herb, forest floor.
        out.a[o4] = land && gs >= 0 && (tint === TintCh.Lichen || tint === TintCh.None) ? byte(g) : 0;
        out.a[o4 + 1] = land && tint === TintCh.Moss ? byte(g) : 0;
        out.a[o4 + 2] = land ? byte(herb + (tint === TintCh.Grass ? g : 0)) : 0;
        out.a[o4 + 3] = land && canSp >= 0 && !t.isMangrove[canSp] ? byte(can) : 0;
        // B: weathering-to-soil, guano, moisture, burn char.
        out.b[o4] = byte(0.55 * f.wthr[p] + 0.45 * Math.min(1, f.soil[p] / 0.25));
        out.b[o4 + 1] = byte(f.guano[p]);
        out.b[o4 + 2] = byte(land ? f.moist[p] : 0);
        out.b[o4 + 3] = byte(f.char[p]);
        // C: coral, seagrass, coralline/reef crest, stream/marsh water.
        const fl = f.flags[p];
        out.c[o4] = !land && f.sp[l + L_SHRUB] !== 0 ? byte(shrub) : 0;
        out.c[o4 + 1] = !land && f.sp[l + L_HERB] !== 0 ? byte(herb) : 0;
        out.c[o4 + 2] = !land && gs >= 0 ? byte(g) : 0;
        out.c[o4 + 3] = fl & Flag.Stream ? 255 : fl & Flag.Marsh ? 150 : 0;
        // Plants: species byte (id + 1) and cover per canopy, shrub, herb.
        const op = o * 6;
        out.plants[op] = f.sp[l + L_CANOPY];
        out.plants[op + 1] = f.sp[l + L_CANOPY] ? byte(can) : 0;
        out.plants[op + 2] = f.sp[l + L_SHRUB];
        out.plants[op + 3] = f.sp[l + L_SHRUB] ? byte(shrub) : 0;
        out.plants[op + 4] = f.sp[l + L_HERB];
        out.plants[op + 5] = f.sp[l + L_HERB] ? byte(herb) : 0;
        out.habitat[o] = f.hab[p];
      }
    }
  }

  /** Life summary when it changed since the last call (else null). */
  takeLife(): LifeInfo | null {
    if (!this.lifeDirty) return null;
    this.lifeDirty = false;
    return this.life();
  }

  takeJournal(out: JournalEntry[]): void {
    const pend = this.book.pending;
    for (let i = 0; i < pend.length; i++) out.push(pend[i]);
    pend.length = 0;
  }

  /** The whole journal (after load, the page is sent everything). */
  journalAll(): JournalEntry[] {
    return this.book.entries.slice();
  }

  takeArrivals(out: ArrivalEvent[]): void {
    const ev = this.arrivals.events;
    for (let i = 0; i < ev.length; i++) out.push(ev[i]);
    ev.length = 0;
  }

  takePlaces(out: PlaceEvent[]): void {
    for (let i = 0; i < this.places.length; i++) out.push(this.places[i]);
    this.places.length = 0;
  }

  inspect(x: number, z: number): InspectInfo {
    const w = this.w;
    const f = w.f;
    const p = patchAt(x, z);
    const h = this.cols.heightAt(x, z);
    const id = f.isl[p] || f.near[p];
    const rec = w.islands.recs.get(id);
    const l = p * LAYERS;
    const info: InspectInfo = {
      x,
      z,
      island: id,
      islandName: rec?.name ?? '',
      height: h,
      depth: Math.max(0, SEA_LEVEL - h),
      substrate: f.sub[p] as Substrate,
      groundAge: Math.max(0, Math.round(w.year - f.born[p])),
      rain: f.rain[p],
      moist: f.h[p] > 0 ? f.moist[p] : 1,
      salt: f.salt[p],
      soil: f.soil[p],
      windward: f.wind[p],
      habitat: f.hab[p] as Habitat,
      layers: { canopy: f.sp[l + L_CANOPY] - 1, shrub: f.sp[l + L_SHRUB] - 1, herb: f.sp[l + L_HERB] - 1, ground: f.sp[l + L_GROUND] - 1 },
    };
    const why = this.why(p);
    if (why) info.why = why;
    return info;
  }

  renameIsland(id: number, name: string): void {
    const rec = this.w.islands.recs.get(id);
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!rec || clean === '') return;
    rec.name = clean;
    rec.named = true;
    this.lifeDirty = true;
  }

  /**
   * Undo merge policy for PatchGrid persistent fields (ARCHITECTURE §5.4): never rewind natural
   * growth, but bring back what the stroke burned or buried.
   * - Plant layers: an empty layer (species and cover are 0 together) takes the snapshot;
   *   a living one keeps what grew since.
   * - Soil, richness, weathering, guano, logs: the larger value (a burn or burial zeroes them).
   * - Surface age and char: the older surface and the lesser char.
   * - Surface reference (height, material, warmth): the snapshot, matching the restored ground.
   * - Island ids: the current map (the next zone job relabels from the restored ground).
   */
  undoMerge(name: string, snapshot: number, current: number): number {
    switch (name) {
      case 'eco.sp':
      case 'eco.cov':
        return current !== 0 ? current : snapshot;
      case 'eco.soil':
      case 'eco.fert':
      case 'eco.wthr':
      case 'eco.guano':
      case 'eco.logs':
        return Math.max(snapshot, current);
      case 'eco.born':
      case 'eco.char':
        return Math.min(snapshot, current);
      case 'eco.isl':
        return current;
      default:
        return snapshot;
    }
  }

  serialize(): EcoSave {
    const w = this.w;
    this.book.flushHeld(w.play);
    const keys = this.species.map((s) => s.key);
    const pops: [number, string, number][] = [];
    for (let slot = 0; slot < w.islands.count; slot++) {
      for (let s = 0; s < w.t.n; s++) {
        const v = w.pop[slot * w.t.n + s];
        if (v > 0) pops.push([w.islands.ids[slot], keys[s], v]);
      }
    }
    const state: StateV2 = {
      keys,
      step: w.step,
      play: w.play,
      realPlay: w.realPlay,
      target: this.target,
      firstLand: w.firstLand,
      rng: w.rng.state,
      islands: [...w.islands.recs.values()].map((r) => ({ ...r })),
      labeller: this.job.labeller.save(),
      pops,
      species: this.arrivals.save(keys),
      journal: this.book.entries.map((e) => ({ ...e, species: e.species !== undefined ? keys[e.species] : undefined })),
      journalNext: this.book.nextId,
      lastCard: this.book.lastCard,
      lastVisitCard: this.book.lastVisitCard,
      openedAt: this.book.openedAt,
      director: this.director.save(),
      storm: this.storms.save(),
      lastNewPlay: this.arrivals.lastNewPlay,
      lastRefresh: this.lastRefresh,
    };
    return { version: SAVE_VERSION, state };
  }

  /**
   * Restore from a save. Call after the PatchGrid persistent arrays have been loaded: plant
   * species bytes are remapped by key if the catalogue changed, then every derived field is
   * rebuilt from the ground.
   */
  restore(s: EcoSave): void {
    const w = this.w;
    const st = s.state as StateV2;
    if (s.version !== SAVE_VERSION || !st || !Array.isArray(st.keys)) throw new Error('This save was made by a different version of the life simulation.');
    const t = w.t;
    // Species ids may have moved between versions: remap the plant layers by key.
    const remap = st.keys.map((k) => t.id(k));
    const same = remap.length === t.n && remap.every((v, i) => v === i);
    if (!same) {
      const f = w.f;
      for (let i = 0; i < NPATCH * LAYERS; i++) {
        const b = f.sp[i];
        if (b === 0) continue;
        const nid = b - 1 < remap.length ? remap[b - 1] : -1;
        if (nid < 0) {
          f.sp[i] = 0;
          f.cov[i] = 0;
        } else f.sp[i] = nid + 1;
      }
    }
    w.step = st.step;
    w.play = st.play;
    w.realPlay = st.realPlay;
    w.firstLand = st.firstLand;
    w.rng = new Rng(0);
    w.rng.state = st.rng >>> 0;
    this.target = st.target;
    this.job.labeller.load(st.labeller);
    w.islands.recs = new Map(st.islands.map((r) => [r.id, { ...r }]));
    w.islands.ids = [];
    w.islands.slotOf.fill(-1);
    this.arrivals.load(st.species, (k) => t.id(k));
    this.arrivals.lastNewPlay = st.lastNewPlay;
    this.lastRefresh = st.lastRefresh;
    this.book.entries = st.journal.map((e) => {
      const sp = e.species !== undefined ? t.id(e.species) : -1;
      const out: JournalEntry = { ...e, species: sp >= 0 ? sp : undefined } as JournalEntry;
      if (out.species === undefined) delete out.species;
      return out;
    });
    this.book.pending = [];
    this.book.nextId = st.journalNext;
    this.book.lastCard = st.lastCard;
    this.book.lastVisitCard = st.lastVisitCard;
    this.book.openedAt = st.openedAt;
    this.director.load(st.director);
    this.places = [];
    this.arrivals.events.length = 0;
    // Rebuild the derived world from the ground (silently: nothing here is news).
    this.rebuildAll(false);
    // Populations go onto the rebuilt island slots.
    for (const [id, key, v] of st.pops) {
      const slot = w.islands.slotOf[id];
      const sp = t.id(key);
      if (slot >= 0 && sp >= 0) {
        w.pop[slot * t.n + sp] = v;
        w.present[slot * t.n + sp] = 1;
      }
    }
    this.storms.load(st.storm);
    this.sweep.restart(w.step);
    computeGates(w);
    this.fauna.placeColonies();
    this.lifeDirty = true;
    this.dirty = [0, 0, NP - 1, NP - 1];
  }

  /** Run `years` of ecology synchronously in one-year steps (checks, e2e, tuning). */
  debugAdvance(years: number): void {
    const w = this.w;
    const steps = Math.max(0, Math.round(years / ECO_STEP_YEARS));
    for (let i = 0; i < steps; i++) {
      this.flushJobs();
      if (!w.firstLand) break;
      w.yps = this.clock.yps;
      if (!this.sweep.inProgress) this.sweep.begin();
      this.sweep.some(Infinity, nowMs);
      this.stepBoundary();
      this.book.tick(w.play);
    }
    this.target = Math.max(this.target, w.step);
  }

  /** Start a storm warning now. */
  debugStormNow(): void {
    this.storms.startNow();
  }

  /** Finish any pending ground work at once (checks and debugAdvance). */
  flushJobs(): void {
    const w = this.w;
    if (this.derive.pending > 0) this.derive.apply(this.cols, w.f, this.sink);
    if (this.zonePending && !this.jobGen) {
      this.zonePending = false;
      this.refreshDue = false;
      this.pendingSince = -1;
      this.jobGen = this.job.run(w);
    }
    if (this.jobGen) {
      while (!this.jobGen.next().done);
      this.jobGen = null;
      this.jobDone = true;
    }
    if (this.jobDone) {
      if (this.sweep.inProgress) {
        this.sweep.some(Infinity, nowMs);
        this.stepBoundary();
      }
      this.commit(false);
    }
  }

  /** Internals for checks, the simulator and Look (read-only use, please). */
  get debug(): { w: EcoWorld; arrivals: Arrivals; fauna: Fauna; director: Director; book: JournalBook; sweep: Sweep; job: ZoneJob; storms: Storms } {
    return { w: this.w, arrivals: this.arrivals, fauna: this.fauna, director: this.director, book: this.book, sweep: this.sweep, job: this.job, storms: this.storms };
  }

  // ---------- internals ----------

  private landed(x: number, z: number): void {
    const w = this.w;
    if (w.firstLand) return;
    w.firstLand = true;
    this.target = 0;
    this.director.onFirstLand(x, z);
    this.lifeDirty = true;
  }

  /** Re-derive every patch and run the zone job to completion (fresh world or load). */
  private rebuildAll(fresh: boolean): void {
    const w = this.w;
    this.derive.markAll();
    this.derive.apply(this.cols, w.f, null);
    if (fresh) {
      const f = w.f;
      for (let p = 0; p < NPATCH; p++) {
        f.refH[p] = f.h[p];
        f.refSub[p] = f.bot[p] === Substrate.HotLava ? Substrate.Basalt : f.bot[p];
        f.born[p] = 0;
        // The old sea floor is long weathered; any land already there is new rock.
        f.wthr[p] = f.bot[p] !== Substrate.Sand && f.h[p] <= 0 ? 0.6 : 0;
      }
    }
    this.jobGen = null;
    const gen = this.job.run(w);
    while (!gen.next().done);
    this.jobDone = true;
    this.zonePending = false;
    this.pendingSince = -1;
    this.commit(true);
    // Count what lives where (without growing anything), so the first step has a picture.
    this.sweep.census();
    const tmp = w.cur;
    w.cur = w.next;
    w.next = tmp;
    this.updatePresentPlants();
    computeGates(w);
    this.sweep.pools.build(w);
  }

  private commit(silent: boolean): void {
    const w = this.w;
    this.jobDone = false;
    const ev = this.job.commit(w, this.sweep, this.director, silent, (cols, isles, n) => {
      this.shoreCols = cols;
      this.shoreIsles = isles;
      this.shoreN = n;
      this.storms.shoreCols = cols;
      this.storms.shoreN = n;
    });
    for (const e of ev) this.places.push(e);
    computeGates(w);
    this.sweep.pools.build(w);
    this.lifeDirty = true;
  }

  private stepBoundary(): void {
    const w = this.w;
    const tmp = w.cur;
    w.cur = w.next;
    w.next = tmp;
    w.step++;
    w.play += ECO_STEP_YEARS / Math.max(0.01, w.yps);
    this.updatePresentPlants();
    computeGates(w);
    this.fauna.step(ECO_STEP_YEARS);
    this.arrivals.step(ECO_STEP_YEARS);
    if (w.play - this.book.lastCard >= 90) this.arrivals.lull();
    const t = w.t;
    let found = 0;
    let birds = 0;
    let voiced = 0;
    for (let s = 0; s < t.n; s++) {
      if (!this.arrivals.sp[s].found) continue;
      found++;
      if (!this.arrivals.living(s)) continue;
      if (t.isBird[s]) birds++;
      if (t.voiced[s]) voiced++;
    }
    const colonies = this.fauna.colonies.map((c, i) => ({ island: this.fauna.colonyIslands[i], x: c.x, z: c.z, n: c.n }));
    this.director.stepChecks(found, t.n, birds, voiced, w.play - this.arrivals.lastNewPlay, this.arrivals.nearMissReasons(), this.arrivals.lowReachWaiting(), colonies);
    if (this.director.checkEnding(found, t.n)) this.whales();
    if (w.step % COAST_EVERY === 0) this.coast(COAST_EVERY * ECO_STEP_YEARS);
    this.sweep.pools.build(w);
    this.lifeDirty = true;
    if (w.play - this.lastRefresh >= REFRESH) {
      this.lastRefresh = w.play;
      this.zonePending = true;
      this.refreshDue = true;
    }
  }

  /** Plants count as living on an island while they have cover there. */
  private updatePresentPlants(): void {
    const w = this.w;
    const t = w.t;
    const n = w.islands.count;
    for (let slot = 0; slot < n; slot++) {
      for (let s = 0; s < t.n; s++) {
        if (!t.isPlant[s]) continue;
        const i = slot * t.n + s;
        w.present[i] = w.cur.cover[i] > 0.02 ? 1 : 0;
      }
    }
  }

  /** The whales come to the Sound (the ending). */
  private whales(): void {
    const w = this.w;
    const t = w.t;
    const sound = w.features.sound;
    if (!sound) return;
    let slot = -1;
    let best = 0;
    for (const id of sound.islands) {
      const s = w.islands.slotOf[id];
      if (s >= 0 && w.islands.rec(s).area > best) {
        best = w.islands.rec(s).area;
        slot = s;
      }
    }
    if (slot < 0) return;
    for (let s = 0; s < t.n; s++) {
      if (!t.isWhale[s]) continue;
      w.pop[slot * t.n + s] = 0.6;
      w.present[slot * t.n + s] = 1;
      const st = this.arrivals.sp[s];
      if (!st.found) {
        st.found = true;
        st.firstYear = w.year;
      }
      this.arrivals.events.push({ species: s, road: 'flight', x: sound.x, z: sound.z, island: w.islands.ids[slot], ok: true, first: true, returned: false });
    }
  }

  /** Years-time coast: beaches rebuild, cliffs retreat, reefs grow (geology does the work). */
  private coast(dt: number): void {
    const w = this.w;
    const f = w.f;
    const t = w.t;
    // White sand from living reefs, per shore column of each island.
    let sandy = false;
    if (this.reefSand.length < this.shoreN) this.reefSand = new Float32Array(this.shoreN);
    const supply = new Map<number, number>();
    for (let slot = 0; slot < w.islands.count; slot++) {
      let g = 0;
      for (let s = 0; s < t.n; s++) if (t.givesSand[s] > 0 && w.present[slot * t.n + s]) g += t.givesSand[s];
      const coral = Math.min(1, w.cur.coral[slot] / 50);
      if (g > 0 && coral > 0) supply.set(w.islands.ids[slot], 0.0015 * Math.min(1, g) * coral);
    }
    for (let i = 0; i < this.shoreN; i++) {
      const v = supply.get(this.shoreIsles[i]) ?? 0;
      this.reefSand[i] = v;
      if (v > 0) sandy = true;
    }
    // Limestone under living coral, a few millimetres a year until it nears the surface.
    let n = 0;
    const act = this.sweep.active;
    for (let i = 0; i < this.sweep.activeN; i++) {
      const p = act[i];
      const c = f.cov[p * LAYERS + L_SHRUB];
      if (f.h[p] >= -0.6 || f.sp[p * LAYERS + L_SHRUB] === 0 || c < 0.4) continue;
      if (this.reefCols.length < (n + 1) * PATCH * PATCH) {
        const nc = new Int32Array(Math.max(256, this.reefCols.length * 2));
        nc.set(this.reefCols);
        this.reefCols = nc;
        const na = new Float32Array(nc.length);
        na.set(this.reefAmt);
        this.reefAmt = na;
      }
      const c0 = (p % NP) * PATCH + ((p / NP) | 0) * PATCH * NX;
      for (let dz = 0; dz < PATCH; dz++) {
        for (let dx = 0; dx < PATCH; dx++) {
          this.reefCols[n] = c0 + dx + dz * NX;
          this.reefAmt[n++] = 0.004 * c * dt;
        }
      }
    }
    this.inGeo = true;
    try {
      this.geo.coastYears(dt, this.shoreCols, this.shoreN, sandy ? this.reefSand : null);
      if (n > 0) this.geo.growReef(this.reefCols, this.reefAmt, n);
    } finally {
      this.inGeo = false;
    }
  }

  private collectDirty(): void {
    const s = this.sweep;
    if (s.dx1 < s.dx0) return;
    this.markDirty(s.dx0, s.dz0, s.dx1, s.dz1);
    s.dx0 = NP;
    s.dz0 = NP;
    s.dx1 = -1;
    s.dz1 = -1;
  }

  private markDirty(x0: number, z0: number, x1: number, z1: number): void {
    x0 = Math.max(0, x0);
    z0 = Math.max(0, z0);
    x1 = Math.min(NP - 1, x1);
    z1 = Math.min(NP - 1, z1);
    if (!this.dirty) this.dirty = [x0, z0, x1, z1];
    else {
      const d = this.dirty;
      d[0] = Math.min(d[0], x0);
      d[1] = Math.min(d[1], z0);
      d[2] = Math.max(d[2], x1);
      d[3] = Math.max(d[3], z1);
    }
  }

  private life(): LifeInfo {
    const w = this.w;
    const t = w.t;
    const isl = w.islands;
    const islands: LifeInfo['islands'] = [];
    for (let slot = 0; slot < isl.count; slot++) {
      const r = isl.rec(slot);
      if (r.area < CHART_AREA) continue;
      let species = 0;
      for (let s = 0; s < t.n; s++) if (w.present[slot * t.n + s]) species++;
      islands.push({
        id: r.id,
        name: r.name,
        area: r.area,
        peak: [r.peak[0], r.peak[1], r.peak[2]],
        centroid: [r.centroid[0], r.centroid[1]],
        bbox: [r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]],
        founded: r.founded,
        species,
        forest: w.cur.land[slot] > 0 ? w.cur.forest[slot] / w.cur.land[slot] : 0,
      });
    }
    const pops: LifeInfo['pops'] = [];
    for (let slot = 0; slot < isl.count; slot++) {
      for (let s = 0; s < t.n; s++) {
        const v = w.pop[slot * t.n + s];
        if (v > 0.005) pops.push({ species: s, island: isl.ids[slot], n: Math.min(1, v) });
      }
    }
    const sound = w.features.sound;
    let dolphins = false;
    if (sound) {
      for (const id of sound.islands) {
        const slot = isl.slotOf[id];
        if (slot < 0) continue;
        for (let s = 0; s < t.n; s++) if (t.isDolphin[s] && w.present[slot * t.n + s]) dolphins = true;
      }
    }
    return {
      islands,
      ponds: this.job.hydro.ponds.map((p) => ({ id: p.id, level: p.level, x0: p.x0, z0: p.z0, x1: p.x1, z1: p.z1, salt: p.salt })),
      peaks: w.features.peaks.map((p) => ({ ...p })),
      pops,
      colonies: this.fauna.colonies.map((c) => ({ ...c })),
      sound: sound ? { x: sound.x, z: sound.z, r: sound.r, dolphins: dolphins || this.director.ending, whales: this.director.ending } : null,
      found: this.arrivals.foundCount,
      total: t.n,
      age: this.director.age,
      ending: this.director.ending,
    };
  }

  /** One plain reason something can't live here yet (for Look), or null. */
  private why(p: number): string | null {
    const w = this.w;
    const f = w.f;
    const t = w.t;
    if (f.sub[p] === Substrate.HotLava) return 'Molten lava: nothing can live here until it cools.';
    const land = f.h[p] > 0;
    if (!land && f.h[p] < -25) return 'Too deep for reef or seagrass: they need water less than 25 m deep.';
    if (land && f.flags[p] & Flag.Basin && !(f.flags[p] & Flag.Pond)) {
      const b = this.job.hydro.basinAt(p);
      if (b?.dry === 'sand') return 'Sand drains: a rock floor would hold water.';
      if (b?.dry === 'young-lava') return 'New lava is full of cracks: in a few decades this basin will hold rain.';
      if (b?.dry === 'little-rain') return 'Little rain falls here: the clouds drop it on the windward side.';
    }
    if (land && f.bot[p] === Substrate.Sand && f.flags[p] & Flag.Basin) return 'Sand drains: a rock floor would hold water.';
    // The nearest miss among plants the islands already know.
    const slot = w.slotOfPatch(p);
    const suit = w.suit;
    let best: { name: string; reason: ReasonCode; partial: number } | null = null;
    const pi = p % NP;
    const pk = (p / NP) | 0;
    const v = this.sweep.veg;
    const veg = v[p] | (pi > 0 ? v[p - 1] : 0) | (pi < NP - 1 ? v[p + 1] : 0) | (pk > 0 ? v[p - NP] : 0) | (pk < NP - 1 ? v[p + NP] : 0);
    for (let s = 0; s < t.n; s++) {
      if (!t.isPlant[s] || !this.arrivals.sp[s].found) continue;
      if ((t.marine[s] === 1) === land && !(t.hasAlt[s] && t.marine[s])) continue;
      const L = t.layer[s];
      if (f.sp[p * LAYERS + L] !== 0) continue;
      const val = suit.plant(s, p, slot, suit.light(p, L), veg, true);
      if (val > 0 || !suit.reason) continue;
      if (!best || suit.partial > best.partial) best = { name: t.defs[s].name, reason: suit.reason, partial: suit.partial };
    }
    if (best && best.partial > 0.2) return reasonLine(best.reason, best.name, f.wind[p] < -0.2);
    if (land && w.coverSum(p) < 0.05 && f.bot[p] !== Substrate.Sand && w.year - f.born[p] < 80) return 'Fresh rock: lichens come first, on the wind.';
    return null;
  }
}

function byte(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

/** Look's plain sentence for a reason. */
function reasonLine(r: ReasonCode, name: string, lee: boolean): string {
  switch (r) {
    case 'no-soil':
    case 'thin-soil':
      return `Soil is still too thin for ${name}.`;
    case 'too-dry':
      return lee ? `Too dry here for ${name}: the rain falls on the windward side.` : `Too dry here for ${name}.`;
    case 'too-wet':
      return `Too wet here for ${name}.`;
    case 'too-salty':
      return `Too much salt spray here for ${name}.`;
    case 'no-open-ground':
      return `Too steep or shady here for ${name}.`;
    case 'no-beach':
      return `${name} needs a sandy beach.`;
    case 'no-fresh-water':
      return `${name} needs fresh water nearby.`;
    case 'no-shelter':
    case 'no-lagoon':
      return `${name} needs calm, sheltered water.`;
    case 'no-reef':
      return `${name} needs a reef on a hard sea floor.`;
    case 'no-summit':
    case 'too-low':
      return `${name} lives higher up.`;
    case 'no-forest':
    case 'no-cloud-forest':
      return `${name} needs forest around it.`;
    default:
      return `${name} can't grow here yet.`;
  }
}
