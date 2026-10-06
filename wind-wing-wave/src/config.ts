/**
 * Shared constants. Plain values only, so the page and the engine worker can both use them.
 * See docs/ARCHITECTURE.md §1 and §3.
 */

export const GAME_TITLE = 'Wind, Wing & Wave';
export const GAME_VERSION = '0.1';
/** Storage id: fixed, so renaming the game never orphans saves. */
export const STORAGE_ID = 'wind-wing-wave';

// ---------- world ----------

/** Column size in metres (horizontal). */
export const CELL = 2;
/** Columns per side. */
export const NX = 512;
export const NZ = 512;
/** World x/z of the corner of column (0, 0). */
export const ORIGIN_X = -512;
export const ORIGIN_Z = -512;
export const ZONE_SIZE = NX * CELL;
export const SEA_LEVEL = 0;
/** The flat deep sea floor. */
export const FLOOR_Y = -30;
/** Tools fade out between BUILD_FADE and BUILD_MAX. */
export const BUILD_MAX = 180;
export const BUILD_FADE = 170;
/** Scoop stops here. */
export const BUILD_MIN = -30;
/** Tool strength fades to 0 within this many metres of the zone edge. */
export const EDGE_FADE = 40;
/** Columns per patch side (a patch is 4 m). */
export const PATCH = 2;
/** Patches per side. */
export const NP = NX / PATCH;
/** Patch size in metres. */
export const PATCH_M = PATCH * CELL;

/** Undo/snapshot block sizes. */
export const COL_BLOCK = 16;
export const PATCH_BLOCK = 8;

/** The trade wind blows from +x (east) toward -x. Unit vector of where it blows TO. */
export const WIND_TO_X = -1;
export const WIND_TO_Z = 0;
/** The "old islands" on the eastern horizon, the source of most life (world x, z, in metres). */
export const OLD_ISLANDS = { x: 8000, z: -600 };

// ---------- lava ----------

/** Lava freezes into rock below this temperature (0..1). */
export const LAVA_FREEZE = 0.3;

// ---------- tools ----------

export type ToolId = 'lava' | 'rock' | 'sand' | 'hands' | 'scoop' | 'look';
export const SHAPING_TOOLS: ToolId[] = ['lava', 'rock', 'sand', 'hands', 'scoop'];
export type BrushSize = 0 | 1 | 2;
/** Brush radius = clamp(BRUSH_K[size] * cameraDistance, BRUSH_MIN, BRUSH_MAX) metres. */
export const BRUSH_K: readonly [number, number, number] = [0.03, 0.06, 0.11];
export const BRUSH_MIN = 3;
export const BRUSH_MAX = 60;

export function brushRadius(size: BrushSize, cameraDistance: number): number {
  return Math.max(BRUSH_MIN, Math.min(BRUSH_MAX, BRUSH_K[size] * cameraDistance));
}

// ---------- time ----------

export type PaceId = 'gentle' | 'normal' | 'brisk';
/** Eco years per real second. */
export const PACE_YPS: Record<PaceId, number> = { gentle: 1, normal: 2, brisk: 5 };
/** Size of one ecology step in years. */
export const ECO_STEP_YEARS = 1;
/** Physics fixed step (seconds). */
export const PHYS_STEP = 1 / 30;
/** Length of one sky day in real seconds (16 minutes). */
export const DAY_SECONDS = 16 * 60;
/** Fractions of the day: dawn, day, dusk, night (sum to 1). Day starts at dawn. */
export const DAY_PARTS = { dawn: 1.5 / 16, day: 9 / 16, dusk: 1.5 / 16, night: 4 / 16 } as const;
/** The wet/dry season cycle spans this many days (day A wet, day B dry). */
export const SEASON_DAYS = 2;

export type Season = 'wet' | 'dry';

/** Phase (0..1 within a day) helpers shared by page and engine. */
export function dayPart(phase: number): 'dawn' | 'day' | 'dusk' | 'night' {
  const p = ((phase % 1) + 1) % 1;
  if (p < DAY_PARTS.dawn) return 'dawn';
  if (p < DAY_PARTS.dawn + DAY_PARTS.day) return 'day';
  if (p < DAY_PARTS.dawn + DAY_PARTS.day + DAY_PARTS.dusk) return 'dusk';
  return 'night';
}

// ---------- quality ----------

export type QualityId = 'auto' | 'lighter' | 'richer';
