/** Shared constants. Plain numbers only, so both the page and the sand worker can use them. */

export const GAME_VERSION = '0.1';

/** Size of one sand cell in metres (3 cm). */
export const CELL = 0.03;
/** Cells along each side of a chunk. Chunks are the unit of storage and meshing. */
export const CHUNK = 16;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK;
/** Chunk size in metres. */
export const CHUNK_M = CHUNK * CELL;
/** Chunks per render tile side (tiles merge chunk meshes to keep draw calls low). */
export const TILE_CHUNKS = 4;

/** Bump when the beach-shape formula changes; stored in saves. */
export const GENERATOR_VERSION = 1;

export interface WorldDims {
  /** Chunk counts along x (along the shore), y (up) and z (sea to land). */
  cx: number;
  cy: number;
  cz: number;
  /** World position (metres) of the corner of cell (0,0,0). */
  originX: number;
  originY: number;
  originZ: number;
}

/** The calm lagoon: 15.36 m along the shore, 11.52 m from the water to the back of the beach. */
export const LAGOON_DIMS: WorldDims = {
  cx: 32,
  cy: 12,
  cz: 24,
  originX: -7.68,
  originY: -1.44,
  originZ: -5.76,
};

/** Sea level in the calm lagoon (also the water table under the beach). */
export const LAGOON_WATER_LEVEL = 0;

export type ToolId = 'dig' | 'pile' | 'pat';
export const TOOLS: ToolId[] = ['dig', 'pile', 'pat'];

/** Brush sizes: small, medium, large. */
export type BrushSize = 0 | 1 | 2;
export const BRUSH_RADIUS: Record<ToolId, [number, number, number]> = {
  dig: [0.045, 0.09, 0.18],
  pile: [0.04, 0.08, 0.16],
  pat: [0.06, 0.12, 0.24],
};

/** How much sand you can carry: 40 litres, stored in "fill units" (255 = one full cell). */
export const HAND_CAPACITY_LITRES = 40;
export const LITRES_PER_CELL = CELL * CELL * CELL * 1000;
export const HAND_CAPACITY = Math.round((HAND_CAPACITY_LITRES / LITRES_PER_CELL) * 255);

export type DryingSpeed = 'off' | 'slow' | 'normal' | 'fast';
/** Moisture lost per second by a fully exposed cell (moisture runs 0-255). */
export const DRYING_RATE: Record<DryingSpeed, number> = {
  off: 0,
  slow: 0.07,
  normal: 0.2,
  fast: 0.8,
};

export interface EngineSettings {
  drying: DryingSpeed;
}
