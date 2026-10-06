/**
 * What is around the listener (WP-G): a quick count of land, plants, habitats and the nearest
 * shore near the camera target, read from the page's copies of the world data (WorldFields).
 * The soundscape is built from it: bare rock whistles, leaves rustle, surf rolls in from the
 * nearest shore, and each species calls from the places it lives.
 *
 * Pure (plain typed arrays in, numbers out) so tests can feed it made-up worlds. It runs twice
 * a second and visits a few thousand patches, well under a millisecond.
 */
import { NP, NX, ORIGIN_X, ORIGIN_Z, PATCH, PATCH_M, SEA_LEVEL } from '../config';
import { HABITAT_COUNT, Habitat } from '../content/speciesTypes';
import { PLANT_BYTES, type LifeInfo } from '../engine/protocol';

/** The parts of WorldFields the census reads. */
export interface CensusFields {
  readonly surf: Float32Array;
  readonly ground: Uint8Array;
  readonly coverA: Uint8Array;
  readonly plants: Uint8Array;
  readonly habitat: Uint8Array;
}

/** Life is counted within this radius of the listener (m); the shore is searched further out. */
export const LIFE_RADIUS = 90;
export const SHORE_RADIUS = 220;
/** Random patch samples kept per habitat, as places for voices to call from. */
export const SAMPLES = 6;

export interface Census {
  /** Share of patches within LIFE_RADIUS that are land (0..1). */
  land: number;
  /** Of the land: the share with no plants at all (bare rock, fresh lava, bare sand). */
  bare: number;
  /** Of the land: mean plant cover of any kind (moss, grass, herbs, shrubs, trees), 0..1. */
  green: number;
  /** Of the land: mean shrub and tree cover, 0..1. */
  woody: number;
  /** Distance (m) from the listener to the nearest coastline, and where that coast is. */
  shoreDist: number;
  shoreX: number;
  shoreZ: number;
  /** That coast is rocky (1) or sandy (0), or in between. */
  shoreRock: number;
  /** Patches per habitat code within LIFE_RADIUS, and up to SAMPLES patch indices of each. */
  habCount: Int32Array;
  habSample: Int32Array;
}

export function makeCensus(): Census {
  return {
    land: 0,
    bare: 0,
    green: 0,
    woody: 0,
    shoreDist: SHORE_RADIUS,
    shoreX: 0,
    shoreZ: 0,
    shoreRock: 0,
    habCount: new Int32Array(HABITAT_COUNT),
    habSample: new Int32Array(HABITAT_COUNT * SAMPLES),
  };
}

/** World x/z of a patch centre. */
export function patchX(p: number): number {
  return ORIGIN_X + ((p % NP) + 0.5) * PATCH_M;
}
export function patchZ(p: number): number {
  return ORIGIN_Z + (Math.floor(p / NP) + 0.5) * PATCH_M;
}

function isLand(src: CensusFields, pi: number, pk: number): boolean {
  return src.surf[pi * PATCH + pk * PATCH * NX] > SEA_LEVEL + 0.05;
}

/** Count everything near (x, z). `rand` picks the habitat samples. Writes into `out`. */
export function takeCensus(src: CensusFields, x: number, z: number, out: Census, rand: () => number): Census {
  const fx = (x - ORIGIN_X) / PATCH_M;
  const fz = (z - ORIGIN_Z) / PATCH_M;
  const ci = Math.floor(fx);
  const ck = Math.floor(fz);
  out.habCount.fill(0);

  // ----- life within LIFE_RADIUS -----
  const rp = Math.ceil(LIFE_RADIUS / PATCH_M);
  const r2 = (LIFE_RADIUS / PATCH_M) * (LIFE_RADIUS / PATCH_M);
  let total = 0;
  let land = 0;
  let bare = 0;
  let green = 0;
  let woody = 0;
  for (let pk = Math.max(0, ck - rp); pk <= Math.min(NP - 1, ck + rp); pk++) {
    for (let pi = Math.max(0, ci - rp); pi <= Math.min(NP - 1, ci + rp); pi++) {
      const dx = pi + 0.5 - fx;
      const dz = pk + 0.5 - fz;
      if (dx * dx + dz * dz > r2) continue;
      const p = pi + pk * NP;
      total++;
      const h = src.habitat[p];
      const n = ++out.habCount[h];
      if (n <= SAMPLES) out.habSample[h * SAMPLES + n - 1] = p;
      else {
        const j = Math.floor(rand() * n);
        if (j < SAMPLES) out.habSample[h * SAMPLES + j] = p;
      }
      if (!isLand(src, pi, pk)) continue;
      land++;
      const o = p * PLANT_BYTES;
      const canopy = src.plants[o] ? src.plants[o + 1] / 255 : 0;
      const shrub = src.plants[o + 2] ? src.plants[o + 3] / 255 : 0;
      const herb = src.plants[o + 4] ? src.plants[o + 5] / 255 : 0;
      const moss = src.coverA[p * 4 + 1] / 255;
      const grass = src.coverA[p * 4 + 2] / 255;
      const g = Math.max(canopy, shrub, herb, moss, grass);
      green += g;
      woody += Math.max(canopy, shrub);
      if (g < 0.05) bare++;
    }
  }
  out.land = total ? land / total : 0;
  out.green = land ? green / land : 0;
  out.woody = land ? woody / land : 0;
  out.bare = land ? bare / land : 0;

  // ----- the nearest coastline: rings outward until land meets sea -----
  const inside = ci >= 0 && ck >= 0 && ci < NP && ck < NP;
  const here = inside && isLand(src, ci, ck);
  const rings = Math.ceil(SHORE_RADIUS / PATCH_M);
  let found = -1;
  let bestD = Infinity;
  for (let r = 1; r <= rings && found < 0; r++) {
    for (let pk = ck - r; pk <= ck + r; pk++) {
      if (pk < 0 || pk >= NP) continue;
      const edge = pk === ck - r || pk === ck + r;
      for (let pi = ci - r; pi <= ci + r; pi += edge ? 1 : 2 * r) {
        if (pi < 0 || pi >= NP) continue;
        if (isLand(src, pi, pk) === here) continue;
        const dx = pi + 0.5 - fx;
        const dz = pk + 0.5 - fz;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          found = pi + pk * NP;
        }
      }
    }
  }
  if (found < 0) {
    out.shoreDist = SHORE_RADIUS;
    out.shoreX = x;
    out.shoreZ = z;
    out.shoreRock = 0.5;
    return out;
  }
  out.shoreDist = Math.sqrt(bestD) * PATCH_M;
  out.shoreX = patchX(found);
  out.shoreZ = patchZ(found);
  // Sand or rock along that bit of coast: sediment depth, and cliff or rocky-shore habitat.
  const fi = found % NP;
  const fk = Math.floor(found / NP);
  let rock = 0;
  let seen = 0;
  for (let k = Math.max(0, fk - 1); k <= Math.min(NP - 1, fk + 1); k++) {
    for (let i = Math.max(0, fi - 1); i <= Math.min(NP - 1, fi + 1); i++) {
      const p = i + k * NP;
      const c = i * PATCH + k * PATCH * NX;
      const sed = src.ground[c * 4 + 2] / 50;
      const hab = src.habitat[p];
      seen++;
      if (hab === Habitat.Cliff || hab === Habitat.RockShore || sed < 0.4) rock++;
    }
  }
  out.shoreRock = rock / seen;
  return out;
}

/** How well a species' habitats are represented near the listener (0..1). */
export function habitatPresence(where: readonly number[] | undefined, census: Census): number {
  if (!where || where.length === 0) return census.land > 0.05 ? 1 : 0;
  let n = 0;
  for (const h of where) n += census.habCount[h];
  return Math.min(1, n / 10);
}

/**
 * Each species' abundance near the listener (0..1), from life.pops on the islands within reach:
 * full on an island the listener is over, fading to nothing 250 m off its shore.
 */
export function popsNear(life: LifeInfo | null, x: number, z: number, out: Float32Array): Float32Array {
  out.fill(0);
  if (!life) return out;
  for (const pop of life.pops) {
    let prox = 0;
    for (const isl of life.islands) {
      if (isl.id !== pop.island) continue;
      const dx = Math.max(isl.bbox[0] - x, 0, x - isl.bbox[2]);
      const dz = Math.max(isl.bbox[1] - z, 0, z - isl.bbox[3]);
      const d = Math.hypot(dx, dz);
      prox = d <= 60 ? 1 : d >= 250 ? 0 : 1 - (d - 60) / 190;
      break;
    }
    if (pop.species >= 0 && pop.species < out.length) out[pop.species] = Math.max(out[pop.species], pop.n * prox);
  }
  return out;
}
