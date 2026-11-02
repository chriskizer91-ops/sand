/**
 * Home Cay: the shape of your home island and the sea floor around it.
 *
 * - The sandcastle cove sits in the middle of the south shore. Inside the
 *   cove the ground is exactly the old lagoon beach (LagoonTerrain), so the
 *   sand engine and old saves are unchanged; it blends into the island over a
 *   few metres outside the editable sand.
 * - Beaches on the south and west; rocky ironshore on the windward east side
 *   and on two points either side of the cove; a low wooded hill to the north-east.
 * - A turquoise lagoon (2-4 m deep) inside a fringing reef about 95 m off the
 *   coast, with a channel through it to the south-west; deep blue beyond.
 *
 * Coordinates: metres; x east, z south-to-north is +z (the sea in front of the
 * cove is -z); y up, sea level 0.
 */
import { LAGOON_DIMS, CELL, CHUNK } from '../config';
import { LagoonTerrain } from '../engine/terrain';
import type { Ground, IslandTerrain, Rect, TidePoint } from './islands';
import { Noise2D, clamp, lerp, smoothstep } from '../engine/noise';

const REGION = {
  x0: LAGOON_DIMS.originX,
  x1: LAGOON_DIMS.originX + LAGOON_DIMS.cx * CHUNK * CELL,
  z0: LAGOON_DIMS.originZ,
  z1: LAGOON_DIMS.originZ + LAGOON_DIMS.cz * CHUNK * CELL,
};

/** Centre of the island's outline. */
const CX = 4;
const CZ = 30;
const AX = 62;
const AZ = 31;
/** Distance of the reef crest from the coast (metres). */
const REEF_OFF = 95;

export type { Ground } from './islands';

export class HomeCayTerrain implements IslandTerrain {
  readonly id = 'home' as const;
  readonly name = 'Home Cay';
  readonly waterLevel = 0;
  readonly region = REGION;
  readonly bounds: Rect = { x0: -176, x1: 192, z0: -160, z1: 160 };
  readonly land: Rect = { x0: -70, x1: 75, z0: -10, z1: 70 };
  readonly anchorage = { x: 2, z: -31, heading: 0 };
  private lagoon = new LagoonTerrain();
  private noise = new Noise2D(9091);
  private noise2 = new Noise2D(4410);

  /** Radius of the coastline from the island centre, in the direction `th`. */
  coastRadius(th: number): number {
    const c = Math.cos(th);
    const s = Math.sin(th);
    const ell = 1 / Math.sqrt((c / AX) ** 2 + (s / AZ) ** 2);
    // Keep the cove's shore smooth; let the rest of the coast wander.
    const south = Math.abs(Math.atan2(Math.sin(th + Math.PI / 2), Math.cos(th + Math.PI / 2)));
    const wander = smoothstep(0.12, 0.45, south);
    const lumps = 3.5 * Math.sin(3 * th + 0.7) + 2.2 * Math.sin(5 * th + 2.1) + 1.2 * Math.sin(9 * th + 0.3);
    return ell + lumps * wander;
  }

  /** Signed distance inland from the coast (negative out at sea), roughly in metres. */
  inland(x: number, z: number): number {
    const dx = x - CX;
    const dz = z - CZ;
    const r = Math.hypot(dx, dz);
    let s = this.coastRadius(Math.atan2(dz, dx)) - r;
    // Two rocky points either side of the cove reach a few metres out to sea.
    for (const px of [-13.5, 14.5]) {
      const d2 = (x - px) ** 2 + ((z + 1.5) * 1.3) ** 2;
      s += 6.5 * Math.exp(-d2 / 26);
    }
    return s;
  }

  /** How rocky the coast is here (0 beach .. 1 ironshore). */
  rockiness(x: number, z: number): number {
    const th = Math.atan2(z - CZ, x - CX);
    // The windward (east) side is rocky; so are the two cove points.
    const east = smoothstep(0.55, 0.85, Math.cos(th - 0.15));
    let points = 0;
    for (const px of [-13.5, 14.5]) points = Math.max(points, 1 - smoothstep(3.5, 7.5, Math.hypot(x - px, (z + 1.5) * 1.2)));
    const wobble = 0.15 * this.noise2.noise(x * 0.08, z * 0.08);
    return clamp(Math.max(east, points) + wobble, 0, 1);
  }

  /** The island's own shape (before blending with the cove). */
  private islandHeight(x: number, z: number): number {
    const s = this.inland(x, z);
    let h: number;
    if (s >= 0) {
      // Beach rising to a low berm, then scrubby ground and the hills.
      h = 0.55 * (1 - Math.exp(-s / 4.0)) + 0.01 * s;
      h += 0.85 * smoothstep(7, 20, s);
      const hill = 8.5 * Math.exp(-((x - 34) ** 2 + (z - 44) ** 2) / (2 * 15 * 15)) + 3.5 * Math.exp(-((x + 32) ** 2 + (z - 38) ** 2) / (2 * 11 * 11));
      h += hill * smoothstep(5, 18, s);
      h += this.noise.fbm(x * 0.06, z * 0.06, 3) * 0.6 * smoothstep(6, 16, s);
      // Ironshore: a low, jagged limestone shelf instead of a beach.
      const rock = this.rockiness(x, z);
      h += rock * (0.55 * smoothstep(-0.5, 2.5, s) + 0.25 * this.noise2.fbm(x * 0.7, z * 0.7, 2));
    } else {
      // Under water: the beach slope, the lagoon floor, the reef, the drop-off.
      h = -0.85 * (1 - Math.exp(s / 5.0));
      if (s < -6) h -= 0.08 * (-s - 6);
      const lagoonFloor = -3.3 + 0.5 * this.noise.fbm(x * 0.035, z * 0.035, 3);
      h = Math.max(h, lagoonFloor);
      const reefT = (s + REEF_OFF) / 9;
      const th = Math.atan2(z - CZ, x - CX);
      // A channel through the reef to the south-west.
      const channel = smoothstep(0.08, 0.2, Math.abs(Math.sin((th + 2.15) / 2)));
      const reef = 3.0 * Math.exp(-reefT * reefT) * channel * (0.8 + 0.2 * this.noise2.noise(x * 0.05, z * 0.05));
      h += reef;
      h = lerp(h, -16 + 3 * this.noise.noise(x * 0.01, z * 0.01), smoothstep(-REEF_OFF - 6, -REEF_OFF - 40, s));
      // Sand ripples on the lagoon floor.
      h += 0.04 * this.noise2.noise(x * 0.9, z * 0.35) * smoothstep(-2, -10, s);
    }
    // Small undulations so nothing looks machine-made.
    h += this.noise.fbm(x * 0.32, z * 0.32, 3) * 0.03;
    return h;
  }

  /** 0 inside the cove's editable sand (and a margin), 1 a few metres outside it. */
  private islandWeight(x: number, z: number): number {
    const dx = Math.max(REGION.x0 - x, 0, x - REGION.x1);
    const dz = Math.max(REGION.z0 - z, 0, z - REGION.z1);
    return smoothstep(1.0, 7.0, Math.hypot(dx, dz));
  }

  heightAt(x: number, z: number): number {
    const w = this.islandWeight(x, z);
    if (w <= 0) return this.lagoon.heightAt(x, z);
    if (w >= 1) return this.islandHeight(x, z);
    return lerp(this.lagoon.heightAt(x, z), this.islandHeight(x, z), w);
  }

  wetAt(x: number, y: number, z: number, depth: number): number {
    return this.lagoon.wetAt(x, y, z, depth);
  }

  packAt(x: number, y: number, z: number, depth: number): number {
    return this.lagoon.packAt(x, y, z, depth);
  }

  /** What the ground is made of at x, z (for colour, footsteps and what can wash up). */
  groundAt(x: number, z: number, h = this.heightAt(x, z)): Ground {
    const s = this.inland(x, z);
    if (h < -0.6) {
      const reef = s < -REEF_OFF + 12 && s > -REEF_OFF - 10 && h > -2.6;
      if (reef) return 'reef';
      const grass = this.noise2.fbm(x * 0.045, z * 0.045, 3);
      return grass > 0.22 && h < -1.6 && s > -REEF_OFF + 15 ? 'seagrass' : 'sand';
    }
    if (this.rockiness(x, z) > 0.55 && s > -3 && s < 7 + 2 * this.noise2.noise(x * 0.2, z * 0.2)) return 'rock';
    const grassLine = 9.5 + 3 * this.noise.noise(x * 0.12, z * 0.12);
    if (s > grassLine && this.islandWeight(x, z) > 0.5) return 'grass';
    if (h > 1.6) return 'grass';
    return 'sand';
  }

  /**
   * Points along the high-tide line on the beaches (not the rocks), every
   * `spacing` metres, where the sea leaves what it carries.
   */
  tideline(spacing = 0.7): TidePoint[] {
    const out: TidePoint[] = [];
    // Walk the coastline; the wrack line sits about 2.5 m inland of the waterline.
    const steps = 2400;
    let carry = 0;
    let px = NaN;
    let pz = NaN;
    for (let i = 0; i < steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      const R = this.coastRadius(th);
      let x = CX + Math.cos(th) * R;
      let z = CZ + Math.sin(th) * R;
      // Pull onto the real coast (the points bend it) with a few Newton-ish steps.
      for (let k = 0; k < 4; k++) {
        const s = this.inland(x, z);
        x -= Math.cos(th) * s;
        z -= Math.sin(th) * s;
      }
      // Inside the cove the shoreline is the lagoon's.
      if (x > REGION.x0 - 2 && x < REGION.x1 + 2 && z < REGION.z1) z = this.lagoon.shoreZ(x);
      const nx = Math.cos(th);
      const nz = Math.sin(th);
      const wx = x - nx * 2.5;
      const wz = z - nz * 2.5;
      if (!Number.isNaN(px)) carry += Math.hypot(wx - px, wz - pz);
      px = wx;
      pz = wz;
      if (carry < spacing) continue;
      carry = 0;
      if (this.rockiness(wx, wz) > 0.4) continue;
      const h = this.heightAt(wx, wz);
      if (h < 0.08 || h > 0.9) continue;
      out.push({ x: wx, z: wz, nx, nz, island: 'home' });
    }
    return out;
  }
}

/** Where your sloop lies at anchor off Home Cay (bow into the trade wind, to the east). */
export const ANCHORAGE = { x: 2, z: -31, heading: 0 };

/**
 * The gap in Home Cay's reef, to the south-west: a point just inside the
 * lagoon and one just outside, for the chart and the autopilot.
 */
export function reefChannel(t: HomeCayTerrain): { inside: { x: number; z: number }; outside: { x: number; z: number } } {
  const th = -2.15;
  const r = t.coastRadius(th);
  const dx = Math.cos(th);
  const dz = Math.sin(th);
  return {
    inside: { x: CX + dx * (r + REEF_OFF - 32), z: CZ + dz * (r + REEF_OFF - 32) },
    outside: { x: CX + dx * (r + REEF_OFF + 34), z: CZ + dz * (r + REEF_OFF + 34) },
  };
}
