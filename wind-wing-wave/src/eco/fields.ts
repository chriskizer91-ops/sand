/**
 * Everything the life simulation stores per 4 m patch, registered in the PatchGrid.
 *
 * Two kinds of field (ARCHITECTURE §5.3):
 * - Live state (persistent): plant layers, soil, fertility and the like. Saved in the save
 *   file and restored by undo. Always Float32 for anything that accumulates, so slow growth
 *   never rounds away to nothing (DECISIONS 6).
 * - Derived fields (not persistent): heights, climate, places. Recomputed from the ground
 *   whenever it changes, so they never need saving.
 *
 * Plant layers per patch, bottom to top: ground, herb, shrub, canopy. On land these are
 * crusts/lichens/mosses, ferns/grasses/vines, shrubs, trees. In the sea the same four slots
 * hold coralline algae, seagrass, coral and mangrove.
 */
import { NP, ORIGIN_X, ORIGIN_Z, PATCH_M } from '../config';
import type { PatchGrid } from './patches';

export const NPATCH = NP * NP;
export const LAYERS = 4;
export const L_GROUND = 0;
export const L_HERB = 1;
export const L_SHRUB = 2;
export const L_CANOPY = 3;

/** Terrain features per patch (from the zone job). One bit each. */
export const Flag = {
  /** Land within 8 m of the sea. */
  Shore: 1 << 0,
  /** A drop of 8 m or more straight down to the sea. */
  SeaCliff: 1 << 1,
  /** Steep rock face (inland or at the sea). */
  Cliff: 1 << 2,
  Beach: 1 << 3,
  /** Long, gentle, wide sand: where turtles can nest. */
  TurtleBeach: 1 << 4,
  Dune: 1 << 5,
  RockShore: 1 << 6,
  /** A narrow tongue of sand with sea on both sides. */
  Spit: 1 << 7,
  /** Above about 120 m: above the clouds, dry. */
  Summit: 1 << 8,
  /** 60–120 m on the wet side: in the cloud and fog belt. */
  CloudBelt: 1 << 9,
  /** New thick lava still warm underneath. */
  Warm: 1 << 10,
  /** Old life ringed by new lava. */
  Kipuka: 1 << 11,
  /** A rock hollow that can hold rain. */
  Basin: 1 << 12,
  Pond: 1 << 13,
  SaltPond: 1 << 14,
  Marsh: 1 << 15,
  Stream: 1 << 16,
  /** Where a stream meets the sea (muddy: no coral). */
  Mouth: 1 << 17,
  /** Shallow sea near an island, where sea life can settle. */
  NearSea: 1 << 18,
  Lagoon: 1 << 19,
  ReefZone: 1 << 20,
  SeagrassZone: 1 << 21,
  MangroveZone: 1 << 22,
  Sound: 1 << 23,
  /** Part of a small, steep rock standing in the sea. */
  Stack: 1 << 24,
  /** Part of a small island. */
  Islet: 1 << 25,
  /** The dry lee of a cloud-catching peak. */
  RainShadow: 1 << 26,
} as const;

/** Bit for a Habitat code in a habitat mask. */
export function habBit(h: number): number {
  return 1 << h;
}

export function patchX(p: number): number {
  return ORIGIN_X + ((p % NP) + 0.5) * PATCH_M;
}
export function patchZ(p: number): number {
  return ORIGIN_Z + (((p / NP) | 0) + 0.5) * PATCH_M;
}
/** Patch under a world point (clamped to the zone). */
export function patchAt(x: number, z: number): number {
  const pi = Math.max(0, Math.min(NP - 1, Math.floor((x - ORIGIN_X) / PATCH_M)));
  const pk = Math.max(0, Math.min(NP - 1, Math.floor((z - ORIGIN_Z) / PATCH_M)));
  return pi + pk * NP;
}

const f32 = (n: number): Float32Array => new Float32Array(n);
const u8 = (n: number): Uint8Array => new Uint8Array(n);
const u16 = (n: number): Uint16Array => new Uint16Array(n);
const u32 = (n: number): Uint32Array => new Uint32Array(n);

/**
 * What the zone job (zone.ts) works on: the ground and the life it reads straight from the
 * live fields, and the derived fields it writes. The job writes those into its own staged
 * copies (ZoneOut) and they replace the live ones in one go between ecology steps, so nobody
 * ever sees a half-finished picture (no streams vanishing for a moment, no coast at 400 m).
 * EcoFields fits this shape too.
 */
export interface ZoneFields {
  // ---------- read (live) ----------
  readonly h: Float32Array;
  readonly hmin: Float32Array;
  readonly hmax: Float32Array;
  readonly slope: Float32Array;
  readonly sand: Float32Array;
  readonly bot: Uint8Array;
  readonly born: Float32Array;
  readonly soil: Float32Array;
  readonly warm: Float32Array;
  readonly sp: Uint8Array;
  readonly cov: Float32Array;
  // ---------- written (staged) ----------
  readonly coast: Float32Array;
  readonly rain: Float32Array;
  readonly fog: Float32Array;
  readonly salt: Float32Array;
  readonly wind: Float32Array;
  readonly pondLvl: Float32Array;
  readonly pondId: Uint16Array;
  readonly flow: Float32Array;
  readonly shelter: Float32Array;
  readonly flags: Uint32Array;
  readonly geoMask: Uint32Array;
}

export class EcoFields implements ZoneFields {
  // ---------- live state (persistent) ----------
  /** Species id + 1 per layer (0 = empty), LAYERS per patch. */
  readonly sp: Uint8Array;
  /** Cover 0..1 per layer. Kept at 0 exactly when the layer is empty (undo relies on it). */
  readonly cov: Float32Array;
  /** Soil depth (m). */
  readonly soil: Float32Array;
  /** Fertility 0..1: one merged "richness" (old lava, guano, nitrogen fixers). */
  readonly fert: Float32Array;
  /** How weathered the rock surface is, 0 fresh glossy .. 1 crumbling. */
  readonly wthr: Float32Array;
  /** Bird droppings 0..1. */
  readonly guano: Float32Array;
  /** Fallen trunks 0..1 (nurse logs after storms). */
  readonly logs: Float32Array;
  /** Burn char 0..1 (fades over decades). */
  readonly char: Float32Array;
  /** Warmth left in thick new lava 0..1. */
  readonly warm: Float32Array;
  /** Year this surface last formed (lava cooled, sand laid, ground dug). */
  readonly born: Float32Array;
  /** Height when the surface last formed: small changes against it never reset life. */
  readonly refH: Float32Array;
  /** Material when the surface last formed (Substrate value, never Sea or Pond). */
  readonly refSub: Uint8Array;
  /** Island id per land patch (0 = sea). Kept across saves so ids stay stable. */
  readonly isl: Uint16Array;

  // ---------- derived from the ground (not persistent) ----------
  /** Mean visible height (m). */
  readonly h: Float32Array;
  readonly hmin: Float32Array;
  readonly hmax: Float32Array;
  /** Steepest slope (degrees). */
  readonly slope: Float32Array;
  /** Mean sand depth (m). */
  readonly sand: Float32Array;
  /** Mean molten lava depth (m). */
  readonly lava: Float32Array;
  /** Substrate (speciesTypes.Substrate): Sea underwater, Pond in ponds. */
  readonly sub: Uint8Array;
  /** Bottom material ignoring water (Basalt, Stone, Limestone, Sand or HotLava). */
  readonly bot: Uint8Array;
  /** -1 lee .. 1 windward (facing the east trade wind). */
  readonly wind: Float32Array;
  /** Land: distance to the sea (m). Sea: distance to land (m). Capped at 400. */
  readonly coast: Float32Array;
  /** Sea patches: the nearest island id within reach (0 = none). */
  readonly near: Uint16Array;
  readonly rain: Float32Array;
  readonly fog: Float32Array;
  /** Salt spray 0..1 in calm weather (storms multiply it). */
  readonly salt: Float32Array;
  /** Moisture 0..1 (rain, fog, soil, ponds and salt combined; refreshed by the sweep). */
  readonly moist: Float32Array;
  /** Pond water level (m) where flagged Pond. */
  readonly pondLvl: Float32Array;
  readonly pondId: Uint16Array;
  /** Rain collected from upslope (flow accumulation). */
  readonly flow: Float32Array;
  /** Sea patches: how enclosed by land, 0 open .. 1 ringed. */
  readonly shelter: Float32Array;
  /** Flag bits. */
  readonly flags: Uint32Array;
  /** Habitats the ground itself offers (plants test against these). */
  readonly geoMask: Uint32Array;
  /** Habitats offered now, including vegetation (animals count these). */
  readonly lifeMask: Uint32Array;
  /** Dominant habitat code (sent to the page). */
  readonly hab: Uint8Array;
  /** Guano input from seabird colonies 0..1. */
  readonly colony: Float32Array;

  constructor(grid: PatchGrid) {
    this.sp = grid.add('eco.sp', u8, true, LAYERS);
    this.cov = grid.add('eco.cov', f32, true, LAYERS);
    this.soil = grid.add('eco.soil', f32);
    this.fert = grid.add('eco.fert', f32);
    this.wthr = grid.add('eco.wthr', f32);
    this.guano = grid.add('eco.guano', f32);
    this.logs = grid.add('eco.logs', f32);
    this.char = grid.add('eco.char', f32);
    this.warm = grid.add('eco.warm', f32);
    this.born = grid.add('eco.born', f32);
    this.refH = grid.add('eco.refH', f32);
    this.refSub = grid.add('eco.refSub', u8);
    this.isl = grid.add('eco.isl', u16);

    this.h = grid.add('eco.h', f32, false);
    this.hmin = grid.add('eco.hmin', f32, false);
    this.hmax = grid.add('eco.hmax', f32, false);
    this.slope = grid.add('eco.slope', f32, false);
    this.sand = grid.add('eco.sand', f32, false);
    this.lava = grid.add('eco.lava', f32, false);
    this.sub = grid.add('eco.sub', u8, false);
    this.bot = grid.add('eco.bot', u8, false);
    this.wind = grid.add('eco.wind', f32, false);
    this.coast = grid.add('eco.coast', f32, false);
    this.near = grid.add('eco.near', u16, false);
    this.rain = grid.add('eco.rain', f32, false);
    this.fog = grid.add('eco.fog', f32, false);
    this.salt = grid.add('eco.salt', f32, false);
    this.moist = grid.add('eco.moist', f32, false);
    this.pondLvl = grid.add('eco.pondLvl', f32, false);
    this.pondId = grid.add('eco.pondId', u16, false);
    this.flow = grid.add('eco.flow', f32, false);
    this.shelter = grid.add('eco.shelter', f32, false);
    this.flags = grid.add('eco.flags', u32, false);
    this.geoMask = grid.add('eco.geoMask', u32, false);
    this.lifeMask = grid.add('eco.lifeMask', u32, false);
    this.hab = grid.add('eco.hab', u8, false);
    this.colony = grid.add('eco.colony', f32, false);
  }
}
