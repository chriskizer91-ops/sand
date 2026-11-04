/**
 * What every island shares, so the same code can draw its ground, plant its
 * palms, find its high-tide line and wash finds up on it.
 */
import type { Terrain } from '../engine/terrain';

export type IslandId = 'home' | 'pink' | 'bank';
export type Ground = 'sand' | 'pinksand' | 'grass' | 'rock' | 'seagrass' | 'reef';

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface TidePoint {
  x: number;
  z: number;
  /** Outward from the island (toward the sea). */
  nx: number;
  nz: number;
  island: IslandId;
}

export interface IslandTerrain extends Terrain {
  readonly id: IslandId;
  readonly name: string;
  /** The editable sandcastle sand on this island (a zero-size box if none). */
  readonly region: Rect;
  /** The area worth drawing and planting (land, shallows and a margin of sea floor). */
  readonly bounds: Rect;
  /** A rough box around the dry land (for planting). */
  readonly land: Rect;
  /** Where boats anchor off this island: bow into the trade wind. */
  readonly anchorage: { x: number; z: number; heading: number };
  /** Signed distance inland from the coast (negative out at sea), roughly in metres. */
  inland(x: number, z: number): number;
  /** How rocky the coast is here (0 beach .. 1 ironshore). */
  rockiness(x: number, z: number): number;
  groundAt(x: number, z: number, h?: number): Ground;
  tideline(spacing?: number): TidePoint[];
}
