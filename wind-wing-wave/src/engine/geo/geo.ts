/**
 * Geology: the tools, lava flow and cooling, sand sliding, and waves on beaches (WP-B).
 * See docs/ARCHITECTURE.md §5.2. This is the one object the engine hub and the ecology talk to;
 * the work is done in seabed.ts, lava.ts, sand.ts, tools.ts and coast.ts.
 *
 * Geo sends no messages. Every change it makes is reported through Columns.markChanged
 * (one tight rectangle per changed 16 x 16 block), and the hub streams those to the page.
 *
 * Geo also listens to Columns: when something else rewrites the ground (undo, loading a save),
 * it picks up any molten lava there and any sand left steeper than it can hold, so nothing is
 * ever stuck half-done.
 */
import { NX, NZ, type ToolId } from '../../config';
import type { Columns } from '../columns';
import { Coast } from './coast';
import { Lava } from './lava';
import { ChangeTracker, Sand, type Reporter } from './sand';
import { generateSeabed, seabedLayout, type SeabedLayout } from './seabed';
import { Tools, type ToolResult } from './tools';

export type { ToolResult } from './tools';

export interface GeoStepStats {
  /** Columns with molten lava. */
  lavaCols: number;
  /** Columns in the sand-sliding active set. */
  sandCols: number;
  /** Sand volume moved this step (m^3). */
  slid: number;
  ms: number;
}

/**
 * What the ecology may ask of geology (years-time coast processes and storm surf). Shore lists
 * hold column indices (i + k * NX) of shoreline columns; only the first `n` entries are used.
 */
export interface GeoForEco {
  /** Storm level 0..1: widens and flattens the band of beach the waves work. */
  setStorm(level: number): void;
  /** Real-time storm surf for dt seconds: berm sand is pulled offshore, windward beaches most. */
  stormPulse(level: number, dt: number, shore: Int32Array, n: number): void;
  /** Calm years: berms rebuild, windward sea cliffs wear back, `reefSand[j]` (m/yr) lands at `shore[j]`. */
  coastYears(dtYears: number, shore: Int32Array, n: number, reefSand: Float32Array | null): void;
  /** Raise reef limestone on `cols[j]` by `amounts[j]` metres, never above -0.5 m. */
  growReef(cols: Int32Array, amounts: Float32Array, n: number): void;
}

export class Geo implements GeoForEco {
  /** Where the first-minute glow sits (the knoll nearest the centre). Known from the seed alone. */
  readonly seabed: { glow: { x: number; z: number } };
  private readonly layout: SeabedLayout;
  /** Changed columns (Geom/Look) and newly burnt columns, gathered per block. */
  private readonly changes = new ChangeTracker();
  private readonly burns = new ChangeTracker();
  private readonly sand: Sand;
  private readonly lava: Lava;
  private readonly tools: Tools;
  private readonly coast: Coast;
  /** True while Geo itself is reporting, so its own changes don't wake it again. */
  private reporting = false;

  constructor(
    readonly cols: Columns,
    readonly seed: number,
  ) {
    this.layout = seabedLayout(seed);
    this.seabed = { glow: { ...this.layout.glow } };
    this.sand = new Sand(cols, this.changes, seed);
    this.lava = new Lava(cols, this.changes, this.burns, this.sand);
    this.tools = new Tools(cols, this.lava, this.sand, this.report);
    this.coast = new Coast(cols, this.sand, this.changes, this.report);
    cols.addListener(this.onOutsideChange);
    // A world that already holds molten lava (built before Geo) carries on flowing.
    this.lava.wakeRect(0, 0, NX - 1, NZ - 1);
  }

  /** Report a change made by Geo (and don't react to it ourselves). */
  private readonly report: Reporter = (i0, k0, i1, k1, flags) => {
    this.reporting = true;
    try {
      this.cols.markChanged(i0, k0, i1, k1, flags);
    } finally {
      this.reporting = false;
    }
  };

  /** Someone else rewrote some ground (undo, load, a debug island): pick up loose ends there. */
  private readonly onOutsideChange = (i0: number, k0: number, i1: number, k1: number): void => {
    if (this.reporting) return;
    this.lava.wakeRect(i0, k0, i1, k1);
    this.sand.wakeUnstableRect(i0, k0, i1, k1);
    this.flush();
  };

  private flush(): void {
    if (this.changes.pending) this.changes.flush(this.report);
    if (this.burns.pending) this.burns.flush(this.report);
  }

  /** Shape the starting seabed into the columns (called once for a new sea). */
  generateSeabed(): void {
    this.lava.clear();
    this.sand.clear();
    generateSeabed(this.cols, this.layout, this.seed, this.report);
  }

  /**
   * Apply a tool for dt seconds at world (x, z), brush radius in metres, strength 0..1.
   * Called by the hub every physics step while a stroke is held, at the stroke's latest point.
   */
  applyTool(tool: ToolId, x: number, z: number, radius: number, dt: number, strength: number): ToolResult {
    return this.tools.apply(tool, x, z, radius, dt, strength);
  }

  /**
   * Advance lava, then sand, by dt seconds within budgetMs. If time runs out, the rest waits
   * for the next step: the physics slows down rather than skipping ahead.
   */
  step(dt: number, budgetMs: number): GeoStepStats {
    const t0 = performance.now();
    let slid = 0;
    if (dt > 0) {
      const deadline = t0 + budgetMs;
      this.lava.step(dt, deadline);
      slid = this.sand.step(dt, deadline);
      this.flush();
    }
    return { lavaCols: this.lava.molten, sandCols: this.sand.set.count, slid, ms: performance.now() - t0 };
  }

  /** Nothing molten and nothing sliding. */
  isSettled(): boolean {
    return this.lava.molten === 0 && this.sand.set.count === 0;
  }

  /** Append x, z, strength triples where lava met water since the last call (at most 32). */
  takeSteam(out: number[]): void {
    this.lava.takeSteam(out);
  }

  /** Molten lava area (m^2) and the biggest molten area's centre, radius and strength 0..1. */
  lavaStats(): { area: number; glow: [number, number, number, number] } {
    return this.lava.stats();
  }

  /** Rock volume placed since the last call (m^3), for clatter sounds. */
  takeRockPlaced(): number {
    return this.tools.takeRockPlaced();
  }

  /** Storm level 0..1: widens and flattens the beach band where waves move sand. */
  setStorm(level: number): void {
    this.sand.setStorm(level);
  }

  /** Real-time storm surf on the listed shoreline columns (windward beaches lose the most sand). */
  stormPulse(level: number, dt: number, shore: Int32Array, n: number): void {
    this.coast.stormPulse(level, dt, shore, n);
  }

  /**
   * dtYears of calm coast on the listed shoreline columns: berms rebuild, windward sea cliffs
   * wear back, and reef sand (`reefSand[j]` m/yr for `shore[j]`, or null) whitens the beaches.
   */
  coastYears(dtYears: number, shore: Int32Array, n: number, reefSand: Float32Array | null): void {
    this.coast.coastYears(dtYears, shore, n, reefSand);
  }

  /** Raise reef limestone on the listed columns by `amounts` metres (never above -0.5 m). */
  growReef(cols: Int32Array, amounts: Float32Array, n: number): void {
    this.coast.growReef(cols, amounts, n);
  }
}
