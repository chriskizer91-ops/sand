/**
 * The shape of untouched ground. The world asks the terrain for the sand that
 * was there before anyone touched it. The same formulas shape the scenery
 * around the editable area, so the two meet without a visible seam.
 */
import { Noise2D, clamp, lerp, smoothstep } from './noise';

export interface Terrain {
  /** Water level (and water table under the sand), in metres. */
  readonly waterLevel: number;
  /** Ground height in metres at world x, z. */
  heightAt(x: number, z: number): number;
  /** Starting moisture (0-255) of sand at height y, `depth` metres below the surface. */
  wetAt(x: number, y: number, z: number, depth: number): number;
  /** Starting compaction (0-255). */
  packAt(x: number, y: number, z: number, depth: number): number;
}

/** A curved lagoon cove. x runs along the shore, z runs from the sea (negative) to the land (positive). */
export class LagoonTerrain implements Terrain {
  readonly waterLevel = 0;
  private noise = new Noise2D(1337);

  /** Distance (in z) of the waterline from x = 0; the shore curves landward toward the rocky ends. */
  shoreZ(x: number): number {
    return -1.2 + 0.022 * x * x;
  }

  heightAt(x: number, z: number): number {
    const s = z - this.shoreZ(x);
    let h: number;
    if (s >= 0) {
      h = 0.55 * (1 - Math.exp(-s / 4.0)) + 0.01 * s;
    } else {
      h = -0.85 * (1 - Math.exp(s / 5.0));
      if (s < -6) h -= 0.08 * (-s - 6);
    }
    // Low bank of sand rising toward the rocks at each end of the cove.
    const ax = Math.abs(x);
    h += 0.16 * smoothstep(6.0, 7.8, ax) * smoothstep(-3, 0.5, s);
    // Beyond the editable area: rocky headlands at the ends and a vegetated bank at the back.
    if (ax > 7.7) h += 0.7 * smoothstep(7.7, 10.5, ax) * smoothstep(-4, 1, s);
    if (s > 7.4) h += 0.18 * Math.pow(s - 7.4, 1.5);
    // Gentle undulation so the beach doesn't look machine-made.
    const n = this.noise.fbm(x * 0.32, z * 0.32, 3);
    h += n * (s > -0.3 ? 0.035 : 0.02);
    return h;
  }

  wetAt(_x: number, y: number, _z: number, depth: number): number {
    if (y < this.waterLevel - 0.015) return 255;
    const above = y - this.waterLevel;
    // Water wicks up from the water table (the "capillary fringe").
    const cap = above < 0.3 ? lerp(235, 120, above / 0.3) : Math.max(0, 120 - (above - 0.3) * 300);
    // Under the sun-dried skin the beach stays damp.
    const interior = depth < 0.05 ? 14 : depth < 0.17 ? lerp(14, 115, (depth - 0.05) / 0.12) : 115;
    return clamp(Math.round(Math.max(cap, interior)), 0, 255);
  }

  packAt(_x: number, y: number, _z: number, depth: number): number {
    let p = depth < 0.05 ? 50 : 150;
    if (y < this.waterLevel + 0.12) p = Math.max(p, 175);
    return p;
  }
}

/** Flat ground used by the automatic checks. */
export class FlatTerrain implements Terrain {
  constructor(
    readonly groundHeight: number,
    readonly wet: number,
    readonly pack: number,
    readonly waterLevel = -100,
  ) {}
  heightAt(): number {
    return this.groundHeight;
  }
  wetAt(): number {
    return this.wet;
  }
  packAt(): number {
    return this.pack;
  }
}
