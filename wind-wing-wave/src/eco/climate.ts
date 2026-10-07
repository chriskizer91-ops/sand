/**
 * Climate from the shape of the land: how far everything is from the sea, where the rain
 * falls, where the fog sits and how far the salt spray reaches.
 *
 * The trade wind blows from the east. Each row of patches is marched from the east edge
 * carrying "air moisture" q:
 * - over the sea q recovers;
 * - rising ground squeezes rain out of it (orographic rain), so windward slopes are wet;
 * - between about 60 m and 120 m the air is in cloud: fog adds water (cloud forest);
 * - above about 120 m the peak pokes out of the cloud layer: the summit is dry;
 * - downwind of a ridge the air sinks and warms: little rain falls (the rain shadow).
 * Everything is in plain 0..1 units and clamped (critique-feasibility §5.6).
 */
import { NP, PATCH_M } from '../config';
import { Substrate } from '../content/speciesTypes';
import { Flag, NPATCH, type EcoFields, type ZoneFields } from './fields';
import { clamp01, smooth } from './maths';

export const CLOUD_BASE = 60;
export const CLOUD_TOP = 120;
const DIST_CAP = 400;
/** Sea patches further than this from land belong to no island. */
export const NEAR_REACH = 160;
/** Rows of patches per slice of the sliced passes below (a slice stays well under a millisecond). */
const BAND = 32;

/**
 * Chamfer distances on the patch grid (two passes, O(n)):
 * land patches get the distance to the sea, sea patches the distance to land and the
 * nearest island's id (from `isl`). Yields between bands of rows.
 */
export function* coastDistances(f: ZoneFields, isl: Uint16Array, nearOut: Uint16Array, dLand: Float32Array): Generator<void, void, void> {
  const h = f.h;
  const ds = f.coast;
  const D1 = PATCH_M;
  const D2 = PATCH_M * Math.SQRT2;
  for (let p = 0; p < NPATCH; p++) {
    const land = isl[p] !== 0;
    ds[p] = land ? DIST_CAP : 0; // distance to sea (for land)
    dLand[p] = land ? 0 : DIST_CAP; // distance to land (for sea)
    nearOut[p] = isl[p];
  }
  // Treat unlabelled land (tiny rocks between jobs) by height too.
  for (let p = 0; p < NPATCH; p++) if (isl[p] === 0 && h[p] > 0) ds[p] = 0;
  for (let pk = 0; pk < NP; pk++) {
    for (let pi = 0; pi < NP; pi++) {
      const p = pi + pk * NP;
      if (pi > 0) relax(ds, dLand, nearOut, p, p - 1, D1);
      if (pk > 0) {
        relax(ds, dLand, nearOut, p, p - NP, D1);
        if (pi > 0) relax(ds, dLand, nearOut, p, p - NP - 1, D2);
        if (pi < NP - 1) relax(ds, dLand, nearOut, p, p - NP + 1, D2);
      }
    }
    if (pk % BAND === BAND - 1) yield;
  }
  for (let pk = NP - 1; pk >= 0; pk--) {
    for (let pi = NP - 1; pi >= 0; pi--) {
      const p = pi + pk * NP;
      if (pi < NP - 1) relax(ds, dLand, nearOut, p, p + 1, D1);
      if (pk < NP - 1) {
        relax(ds, dLand, nearOut, p, p + NP, D1);
        if (pi < NP - 1) relax(ds, dLand, nearOut, p, p + NP + 1, D2);
        if (pi > 0) relax(ds, dLand, nearOut, p, p + NP - 1, D2);
      }
    }
    if (pk % BAND === 0) yield;
  }
  for (let p = 0; p < NPATCH; p++) {
    if (isl[p] !== 0) continue;
    if (dLand[p] > NEAR_REACH) nearOut[p] = 0;
    ds[p] = Math.min(DIST_CAP, dLand[p]);
  }
}

/** One chamfer relaxation of patch p from neighbour q at distance w. */
function relax(ds: Float32Array, dl: Float32Array, near: Uint16Array, p: number, q: number, w: number): void {
  const a = ds[q] + w;
  if (a < ds[p]) ds[p] = a;
  const b = dl[q] + w;
  if (b < dl[p]) {
    dl[p] = b;
    near[p] = near[q];
  }
}

/** Row march: rain, fog and salt spray (writes f.rain, f.fog, f.salt). Yields between bands of rows. */
export function* windMarch(f: ZoneFields, isl: Uint16Array): Generator<void, void, void> {
  const h = f.h;
  const rain = f.rain;
  const fog = f.fog;
  const salt = f.salt;
  const decaySalt = Math.exp(-PATCH_M / 22);
  const ring = new Float32Array(4);
  for (let pk = 0; pk < NP; pk++) {
    let q = 1; // air moisture
    let ridge = 0; // highest ground upwind, decaying
    let s = 0; // salt load
    let shadowAcc = 0;
    ring.fill(0);
    for (let pi = NP - 1; pi >= 0; pi--) {
      const p = pi + pk * NP;
      const hp = h[p];
      const land = isl[p] !== 0 || hp > 0;
      if (!land) {
        q += (1 - q) * 0.06;
        ridge *= 0.97;
        s = 1;
        shadowAcc *= 0.9;
        ring[pi & 3] = 0;
        rain[p] = 0;
        fog[p] = 0;
        salt[p] = 1;
        continue;
      }
      // Rise over the last 12 m (three patches upwind).
      const up = ring[(pi + 3) & 3];
      ring[pi & 3] = hp;
      const lift = Math.max(0, (hp - up) / (3 * PATCH_M));
      // Sinking air downwind of a ridge.
      const below = Math.max(0, ridge - hp);
      shadowAcc = Math.max(shadowAcc * 0.985, below);
      // Small hollows (a crater, a gully) do not make a rain shadow; a mountain does.
      const shadow = Math.exp(-Math.max(0, shadowAcc - 10) / 24);
      const belt = smooth(CLOUD_BASE - 22, CLOUD_BASE, hp) * (1 - smooth(CLOUD_TOP - 8, CLOUD_TOP + 12, hp));
      const above = smooth(CLOUD_TOP - 8, CLOUD_TOP + 15, hp);
      const fg = belt * q * (0.35 + 0.65 * shadow);
      let r = (0.16 + 0.12 * smooth(4, 40, hp)) * q * (0.45 + 0.55 * shadow) + 2.4 * q * lift * shadow;
      r *= 1 - 0.65 * above;
      r += 0.25 * fg;
      q = Math.max(0.08, q - 0.016 * r - 0.008 * fg);
      ridge = Math.max(ridge * 0.996, hp);
      rain[p] = clamp01(1 - Math.exp(-1.7 * r));
      fog[p] = clamp01(fg);
      salt[p] = s;
      s *= decaySalt;
    }
    if (pk % BAND === BAND - 1) yield;
  }
}

/**
 * Soften the march's streaks (a 3x3 blur of rain and fog over land) and add shore spray.
 * `tmp` is scratch of NPATCH floats.
 */
export function* smoothClimate(f: ZoneFields, isl: Uint16Array, tmp: Float32Array): Generator<void, void, void> {
  const h = f.h;
  const salt = f.salt;
  yield* blurLand(f.rain, isl, h, tmp);
  yield* blurLand(f.rain, isl, h, tmp);
  yield* blurLand(f.fog, isl, h, tmp);
  // Salt: the windward march plus a little spray on every shore.
  for (let p = 0; p < NPATCH; p++) {
    if (isl[p] === 0 && h[p] <= 0) continue;
    const any = 0.42 * Math.exp(-f.coast[p] / 12);
    salt[p] = clamp01(Math.max(salt[p] * 0.92, any));
  }
}

function* blurLand(a: Float32Array, isl: Uint16Array, h: Float32Array, tmp: Float32Array): Generator<void, void, void> {
  tmp.set(a);
  for (let pk = 1; pk < NP - 1; pk++) {
    if (pk % BAND === 0) yield;
    for (let pi = 1; pi < NP - 1; pi++) {
      const p = pi + pk * NP;
      if (isl[p] === 0 && h[p] <= 0) continue;
      let sum = 0;
      let n = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = p + dx + dz * NP;
          if (isl[q] === 0 && h[q] <= 0) continue;
          sum += tmp[q];
          n++;
        }
      }
      a[p] = sum / n;
    }
  }
}

/**
 * Windward-ness: half the local face (ground rising toward the west faces the wind), half
 * where the patch sits on its island (the east side takes the wind).
 */
export function* windwardness(f: ZoneFields, isl: Uint16Array, centroidX: (id: number) => number, radius: (id: number) => number): Generator<void, void, void> {
  const h = f.h;
  for (let pk = 0; pk < NP; pk++) {
    if (pk % (BAND * 2) === BAND * 2 - 1) yield;
    for (let pi = 0; pi < NP; pi++) {
      const p = pi + pk * NP;
      const id = isl[p];
      if (id === 0) {
        f.wind[p] = 0;
        continue;
      }
      const w = h[Math.max(0, pi - 2) + pk * NP];
      const e = h[Math.min(NP - 1, pi + 2) + pk * NP];
      const local = Math.max(-1, Math.min(1, (w - e) / (4 * PATCH_M) / 0.25));
      const x = (pi + 0.5) * PATCH_M - NP * PATCH_M * 0.5;
      const side = Math.max(-1, Math.min(1, (x - centroidX(id)) / Math.max(12, 0.45 * radius(id))));
      f.wind[p] = Math.max(-1, Math.min(1, 0.5 * local + 0.5 * side));
    }
  }
}

/**
 * Moisture of a land patch from rain, fog, soil, standing water and salt. Called by the
 * sweep (soil changes over time); 0..1.
 */
export function moistureOf(f: EcoFields, p: number, soil: number, islandWide: number): number {
  const sub = f.sub[p];
  if (sub === Substrate.Sea || sub === Substrate.Pond) return 1;
  const r = f.rain[p];
  let m = 0.04 + 0.8 * r + 0.32 * f.fog[p] + 0.14 * Math.min(1, soil / 0.25) * (0.3 + r);
  if (sub === Substrate.Sand) {
    // Sand drains, but fresh water floats on the sea water underneath: near the shore the roots
    // reach it, and a wide low island holds a whole lens of it under its middle.
    const lens = 0.18 * smooth(30, 90, f.coast[p]) * islandWide;
    m = m * 0.75 + 0.05 + lens;
  }
  const fl = f.flags[p];
  if (fl & (Flag.Marsh | Flag.Stream)) m = Math.max(m, 0.82);
  m -= 0.08 * f.salt[p];
  return clamp01(m);
}
