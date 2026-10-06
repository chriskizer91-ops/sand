/**
 * How sand behaves, from its moisture and compaction.
 *
 * - cohesion: 0 (dry, loose) .. 1 (damp and well packed)
 * - maxSlope: the steepest slope (rise over run) the sand holds before it slides
 * - span: how many cells cohesive sand can reach sideways off supported sand
 *
 * Everything is precomputed into tables indexed by (wet << 8) | pack.
 */
import { smoothstep } from './noise';

/** Longest overhang, in cells, for damp, fully packed sand (8 cells = 24 cm). */
export const MAX_SPAN = 8;
/** Above this slope limit sand never slides sideways (it holds vertical faces). */
export const HOLDS_VERTICAL = 2.9;

export const COHESION = new Float32Array(65536);
export const MAX_SLOPE = new Float32Array(65536);
export const SPAN = new Uint8Array(65536);

export function cohesionOf(wet: number, pack: number): number {
  const p = pack / 255;
  // Water bridges between grains make damp sand sticky; soaked sand loses them again.
  const f = smoothstep(12, 55, wet) * (1 - 0.8 * smoothstep(215, 252, wet));
  const g = 0.35 + 0.65 * p;
  // Well-packed sand keeps some strength after it dries (but not when soaked).
  const dryPacked = 0.5 * p * p * (1 - smoothstep(200, 250, wet));
  return Math.max(f * g, dryPacked);
}

for (let wet = 0; wet < 256; wet++) {
  for (let pack = 0; pack < 256; pack++) {
    const c = cohesionOf(wet, pack);
    const idx = (wet << 8) | pack;
    COHESION[idx] = c;
    MAX_SLOPE[idx] = 0.65 + 3.5 * c;
    SPAN[idx] = Math.floor(c * MAX_SPAN + 1e-6);
  }
}

/** Plain-language name for how wet some sand is. */
export function wetnessWord(wet: number): string {
  if (wet < 30) return 'dry';
  if (wet < 70) return 'barely damp';
  if (wet < 205) return 'damp';
  if (wet < 240) return 'wet';
  return 'soaked';
}
