/**
 * Geology: the tools, lava flow and cooling, sand sliding, waves on beaches (WP-B).
 * See docs/ARCHITECTURE.md §5.2.
 *
 * STUB (lead): the class shape is the contract used by the engine hub (WP-C) and the
 * ecology (WP-D). WP-B replaces the bodies (and adds seabed.ts, lava.ts, sand.ts, tools.ts, coast.ts).
 */
import type { ToolId } from '../../config';
import type { Columns } from '../columns';

export interface ToolResult {
  /** Volume added (+) or removed (-) this call, m^3. */
  volume: number;
  /** Column rectangle touched (inclusive), or null if nothing changed. */
  rect: [number, number, number, number] | null;
}

export interface GeoStepStats {
  /** Columns with molten lava. */
  lavaCols: number;
  /** Columns in the sand-sliding active set. */
  sandCols: number;
  /** Sand volume moved this step (m^3). */
  slid: number;
  ms: number;
}

/** What the ecology may ask of geology (years-time coast processes and storm surf). */
export interface GeoForEco {
  setStorm(level: number): void;
  stormPulse(level: number, dt: number, shore: Int32Array, n: number): void;
  coastYears(dtYears: number, shore: Int32Array, n: number, reefSand: Float32Array | null): void;
  growReef(cols: Int32Array, amounts: Float32Array, n: number): void;
}

export class Geo implements GeoForEco {
  /** Where the first-minute glow sits (the knoll nearest the centre). */
  readonly seabed: { glow: { x: number; z: number } } = { glow: { x: 0, z: 0 } };

  constructor(
    readonly cols: Columns,
    readonly seed: number,
  ) {}

  /** Shape the starting seabed into the columns (called once for a new sea). */
  generateSeabed(): void {}

  /**
   * Apply a tool for dt seconds at world (x, z). `strength` 0..1.
   * Must touch() before writing and markChanged() after (with ChangeFlag.Tool, and Burn when lava covers ground).
   */
  applyTool(tool: ToolId, x: number, z: number, radius: number, dt: number, strength: number): ToolResult {
    void tool;
    void x;
    void z;
    void radius;
    void dt;
    void strength;
    return { volume: 0, rect: null };
  }

  /** Advance lava and sand physics by dt (seconds), within budgetMs (continues next step if out of time). */
  step(dt: number, budgetMs: number): GeoStepStats {
    void dt;
    void budgetMs;
    return { lavaCols: 0, sandCols: 0, slid: 0, ms: 0 };
  }

  /** Nothing molten and nothing sliding. */
  isSettled(): boolean {
    return true;
  }

  /** Append x, z, strength triples where lava met water since the last call. */
  takeSteam(out: number[]): void {
    void out;
  }

  /** Molten lava area (m^2) and the biggest molten area's centre, radius and strength 0..1. */
  lavaStats(): { area: number; glow: [number, number, number, number] } {
    return { area: 0, glow: [0, 0, 0, 0] };
  }

  /** Rock volume placed since the last call (m^3), for clatter sounds. */
  takeRockPlaced(): number {
    return 0;
  }

  setStorm(level: number): void {
    void level;
  }

  stormPulse(level: number, dt: number, shore: Int32Array, n: number): void {
    void level;
    void dt;
    void shore;
    void n;
  }

  coastYears(dtYears: number, shore: Int32Array, n: number, reefSand: Float32Array | null): void {
    void dtYears;
    void shore;
    void n;
    void reefSand;
  }

  growReef(cols: Int32Array, amounts: Float32Array, n: number): void {
    void cols;
    void amounts;
    void n;
  }
}
