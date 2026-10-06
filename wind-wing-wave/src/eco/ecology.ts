/**
 * The life simulation (WP-D1): derived fields, climate, succession, arrivals, animal
 * populations, storms, places, journal, the pacing director. See docs/ARCHITECTURE.md §3–5.
 *
 * STUB (lead): the class shape is the contract used by the engine hub (WP-C). It tracks first
 * land and the year clock only. WP-D1 replaces the bodies and adds the other eco/*.ts modules.
 */
import { NP, SEA_LEVEL, type Season } from '../config';
import type { SpeciesDef } from '../content/speciesTypes';
import type { Columns } from '../engine/columns';
import type { GeoForEco } from '../engine/geo/geo';
import type { ArrivalEvent, InspectInfo, JournalEntry, LifeInfo, PlaceEvent, StormState } from '../engine/protocol';
import type { EcoNeeds } from './needs';
import type { PatchGrid } from './patches';

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

export class Ecology {
  private _year = 0;
  private _firstLand = false;
  private _storm: StormState = { phase: 'none', t: 0, level: 0, great: false };
  private clock: EcoClock = { paused: false, yps: 2, dayPhase: 0.3, season: 'wet', gentleStorms: false };
  private journal: JournalEntry[] = [];
  private pendingJournal: JournalEntry[] = [];
  private dirty: [number, number, number, number] | null = null;

  constructor(
    readonly cols: Columns,
    readonly grid: PatchGrid,
    readonly geo: GeoForEco,
    readonly seed: number,
    readonly species: readonly SpeciesDef<EcoNeeds>[],
  ) {}

  /** Completed eco year (integer steps). */
  get year(): number {
    return Math.floor(this._year);
  }
  /** Has any land ever broken the surface (the year clock starts then). */
  get firstLand(): boolean {
    return this._firstLand;
  }
  get storm(): StormState {
    return this._storm;
  }
  /** Patches currently simulated. */
  get activePatches(): number {
    return 0;
  }

  /** Terrain changed in a column rectangle (inclusive). flags: ChangeFlag bits. */
  onTerrainChanged(i0: number, k0: number, i1: number, k1: number, flags: number): void {
    void flags;
    this.markDirty(i0 >> 1, k0 >> 1, i1 >> 1, k1 >> 1);
    if (!this._firstLand) {
      for (let k = k0; k <= k1 && !this._firstLand; k++) {
        for (let i = i0; i <= i1; i++) {
          if (this.cols.surf(i + k * this.cols.nx) > SEA_LEVEL + 0.2) {
            this._firstLand = true;
            const e: JournalEntry = { id: 1, year: 0, kind: 'first-land', headline: true, x: this.cols.cx(i), z: this.cols.cz(k) };
            this.journal.push(e);
            this.pendingJournal.push(e);
            break;
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
    if (this.clock.paused || !this._firstLand) return;
    this._year += realDt * this.clock.yps;
  }

  /** Do sliced simulation work within budgetMs. Returns ms spent. */
  work(budgetMs: number): number {
    void budgetMs;
    return 0;
  }

  /** Patch rectangle (inclusive) changed since the last call, for the eco stream. */
  takeDirty(): [number, number, number, number] | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /** Pack a patch rectangle for the page (see protocol.ts 'eco' message). */
  packEco(x0: number, z0: number, w: number, h: number, out: EcoPack): void {
    void x0;
    void z0;
    out.a.fill(0, 0, w * h * 4);
    out.b.fill(0, 0, w * h * 4);
    out.c.fill(0, 0, w * h * 4);
    out.plants.fill(0);
    out.habitat.fill(0, 0, w * h);
  }

  /** Life summary when it changed since the last call (else null). */
  takeLife(): LifeInfo | null {
    return null;
  }

  takeJournal(out: JournalEntry[]): void {
    out.push(...this.pendingJournal);
    this.pendingJournal.length = 0;
  }

  /** The whole journal (after load, the page is sent everything). */
  journalAll(): JournalEntry[] {
    return this.journal.slice();
  }

  takeArrivals(out: ArrivalEvent[]): void {
    void out;
  }

  takePlaces(out: PlaceEvent[]): void {
    void out;
  }

  inspect(x: number, z: number): InspectInfo {
    const h = this.cols.heightAt(x, z);
    return {
      x,
      z,
      island: 0,
      islandName: '',
      height: h,
      depth: Math.max(0, SEA_LEVEL - h),
      substrate: 0,
      groundAge: 0,
      rain: 0,
      moist: 0,
      salt: 0,
      soil: 0,
      windward: 0,
      habitat: 0,
      layers: { canopy: -1, shrub: -1, herb: -1, ground: -1 },
    };
  }

  renameIsland(id: number, name: string): void {
    void id;
    void name;
  }

  /**
   * Undo merge policy for PatchGrid persistent fields: given a field name and the snapshot and
   * current values of one element, return the value to keep. Default: the snapshot (exact rewind).
   */
  undoMerge(name: string, snapshot: number, current: number): number {
    void name;
    void current;
    return snapshot;
  }

  serialize(): EcoSave {
    return { version: 1, state: { year: this._year, firstLand: this._firstLand, journal: this.journal } };
  }

  restore(s: EcoSave): void {
    const st = s.state as { year: number; firstLand: boolean; journal: JournalEntry[] };
    this._year = st.year;
    this._firstLand = st.firstLand;
    this.journal = st.journal ?? [];
    this.pendingJournal = [];
    this.markDirty(0, 0, NP - 1, NP - 1);
  }

  /** Run `years` of ecology synchronously in sub-steps (checks, e2e, tuning). */
  debugAdvance(years: number): void {
    this._year += years;
  }

  /** Start a storm warning now. */
  debugStormNow(): void {
    this._storm = { phase: 'warning', t: 0, level: 0, great: false };
  }

  private markDirty(x0: number, z0: number, x1: number, z1: number): void {
    if (!this.dirty) this.dirty = [x0, z0, x1, z1];
    else {
      const d = this.dirty;
      d[0] = Math.min(d[0], x0);
      d[1] = Math.min(d[1], z0);
      d[2] = Math.max(d[2], x1);
      d[3] = Math.max(d[3], z1);
    }
  }
}
