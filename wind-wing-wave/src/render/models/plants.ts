/**
 * Every plant archetype in `PlantModel` (except Tint, which is ground colour only), made in code
 * from the plant kit (look-and-sound §4.4, with the triangle budgets of critique-feasibility §3.3):
 *
 *   LOD0   the full model: small plants <= 60 triangles, trees and shrubs <= 250, the fig (the
 *          hero tree) <= 400.
 *   LOD1   12-40 triangles: a trunk and a few fronds or crown puffs, for 60-180 m.
 *   LOD2   a shared family of far canopy shapes (round, star, cone, flat), for 180-500 m.
 *
 * Models stand at the origin with their base at y = 0 and are sized in metres at size 1.
 * Colours come from the species at draw time (see plantKit.ts), so one model serves every species
 * of an archetype. `ARCHETYPES` says how each one moves, opens, falls and is placed.
 */
import * as THREE from 'three';
import { PlantModel, PLANT_MODEL_COUNT } from '../../content/speciesTypes';
import {
  Part,
  PlantBuilder,
  add,
  blade,
  blob,
  dirFrom,
  dome,
  fan,
  len,
  norm,
  perpendicular,
  rosette,
  scale,
  seq,
  strip,
  sub,
  tube,
  type Paint,
  type SwayFn,
  type V3,
} from './plantKit';

/** How leaves open during the pop. */
export const Unfurl = { Expand: 0, Fern: 1, Umbrella: 2 } as const;
export type Unfurl = (typeof Unfurl)[keyof typeof Unfurl];

/** What a storm does to a plant whose cover it takes. */
export const StormFall = { Topple: 0, Fronds: 1, Flatten: 2 } as const;
export type StormFall = (typeof StormFall)[keyof typeof StormFall];

/** The far canopy shapes (LOD2). */
export const FarShape = { Round: 0, Star: 1, Cone: 2, Flat: 3 } as const;
export type FarShape = (typeof FarShape)[keyof typeof FarShape];
export const FAR_SHAPE_COUNT = 4;

/** Where a plant may stand. */
export type Placement = 'land' | 'sea' | 'shore' | 'pond' | 'canopy' | 'wet';

export interface ArchetypeInfo {
  model: PlantModel;
  name: string;
  /** Height in metres at size 1 (sway scale, burial depth, motes, far shape size). */
  height: number;
  /** LOD0 triangle limit for this archetype. */
  limit: number;
  unfurl: Unfurl;
  storm: StormFall;
  far: FarShape;
  /** How golden the leaves turn on dry ground in the dry season (0..1). */
  dry: number;
  /** Moves with the slow underwater surge instead of the wind. */
  surge: boolean;
  /** Share of plants in flower at any time (flowers hide on the rest). */
  bloom: number;
  placement: Placement;
  /** Where epiphytes perch on this plant: height and reach from the trunk (m at size 1). */
  crownY: number;
  crownR: number;
  /** Fallback colours (sRGB) for species that leave them out. */
  trunk: number;
  flower: number;
  fruit: number;
  /** Number of shape variants (coral heads); a plant picks one from its seed. */
  variants: number;
}

const M = PlantModel;

function info(model: PlantModel, name: string, o: Partial<ArchetypeInfo> & { height: number }): ArchetypeInfo {
  return {
    model,
    name,
    limit: 250,
    unfurl: Unfurl.Expand,
    storm: StormFall.Topple,
    far: FarShape.Round,
    dry: 0,
    surge: false,
    bloom: 1,
    placement: 'land',
    crownY: o.height * 0.7,
    crownR: o.height * 0.25,
    trunk: 0x6b5a48,
    flower: 0xf2efe6,
    fruit: 0x7a5a32,
    variants: 1,
    ...o,
  };
}

/** Archetype table, indexed by PlantModel. Tint has an entry so indexes line up, but no model. */
export const ARCHETYPES: readonly ArchetypeInfo[] = [
  info(M.Tint, 'tint', { height: 0, limit: 0 }),
  info(M.Fern, 'fern', { height: 0.8, limit: 60, unfurl: Unfurl.Fern, storm: StormFall.Flatten, dry: 0.3 }),
  info(M.TreeFern, 'tree fern', { height: 4.2, unfurl: Unfurl.Fern, far: FarShape.Star, trunk: 0x4a3a2c, crownY: 3.3, crownR: 0.5 }),
  info(M.Grass, 'grass', { height: 0.55, limit: 60, storm: StormFall.Flatten, dry: 1, flower: 0xb58a5a }),
  info(M.DuneGrass, 'dune grass', { height: 1.0, limit: 60, storm: StormFall.Flatten, dry: 0.8, flower: 0xd8c98a }),
  info(M.Sedge, 'sedge', { height: 0.85, limit: 60, storm: StormFall.Flatten, dry: 0.5, fruit: 0x6b4a2a, placement: 'wet' }),
  info(M.Vine, 'vine', { height: 0.2, limit: 60, storm: StormFall.Flatten, dry: 0.4, flower: 0xd35fb7, bloom: 0.8 }),
  info(M.Mat, 'mat', { height: 0.15, limit: 60, storm: StormFall.Flatten, dry: 0.6, trunk: 0xb0473a }),
  info(M.Herb, 'herb', { height: 0.5, limit: 60, storm: StormFall.Flatten, dry: 0.7, flower: 0xf2c230, fruit: 0xb5761f, bloom: 0.85 }),
  info(M.Palm, 'palm', { height: 9, unfurl: Unfurl.Umbrella, storm: StormFall.Fronds, far: FarShape.Star, trunk: 0x8b7257, crownY: 8.6, crownR: 0.4 }),
  info(M.Pandanus, 'pandanus', { height: 6, unfurl: Unfurl.Umbrella, far: FarShape.Star, trunk: 0x8a7a64, fruit: 0xe3812e, crownY: 3.8, crownR: 0.9 }),
  info(M.SeaGrape, 'sea grape', { height: 2.6, dry: 0.35, fruit: 0x6b2e5a, trunk: 0x7a6248, crownY: 1.5, crownR: 0.8 }),
  info(M.Shrub, 'shrub', { height: 1.4, dry: 0.5, crownY: 0.8, crownR: 0.6 }),
  info(M.Mangrove, 'mangrove', { height: 5.5, placement: 'shore', trunk: 0x4a3a2a, fruit: 0x7a8f3a, crownY: 3.4, crownR: 1.2 }),
  info(M.Fig, 'fig', { height: 12, limit: 400, far: FarShape.Flat, trunk: 0x9a8f80, fruit: 0xd8682a, crownY: 7.2, crownR: 2.2 }),
  info(M.PomTree, 'pom tree', { height: 8, flower: 0xe0262a, crownY: 5.2, crownR: 1.4, bloom: 0.8 }),
  info(M.Broadleaf, 'broadleaf', { height: 10, trunk: 0xb0603f, crownY: 6.2, crownR: 1.6 }),
  info(M.CloudTree, 'cloud tree', { height: 6.5, flower: 0xc2383a, trunk: 0x5a4d3d, crownY: 3.8, crownR: 1.4 }),
  info(M.SheOak, 'she-oak', { height: 10, far: FarShape.Cone, crownY: 5.5, crownR: 0.8 }),
  info(M.Cactus, 'cactus', { height: 2.8, flower: 0xf5d23a, fruit: 0xb0304a, trunk: 0x6f7a50, bloom: 0.6, crownY: 1.6, crownR: 0.5 }),
  info(M.Silversword, 'silversword', { height: 1.2, flower: 0x9a3a6a, bloom: 0.35, dry: 0.2 }),
  info(M.Seagrass, 'seagrass', { height: 0.6, limit: 60, surge: true, placement: 'sea' }),
  info(M.Coral, 'coral', { height: 0.9, storm: StormFall.Flatten, surge: true, placement: 'sea', variants: 4, flower: 0x8a4fa8 }),
  info(M.Lily, 'lily', { height: 0.12, limit: 60, storm: StormFall.Flatten, placement: 'pond', bloom: 0.55 }),
  info(M.Epiphyte, 'epiphyte', { height: 0.5, limit: 60, storm: StormFall.Flatten, placement: 'canopy', flower: 0xd76fb0, bloom: 0.75 }),
];

if (ARCHETYPES.length !== PLANT_MODEL_COUNT) throw new Error('ARCHETYPES must cover every PlantModel');

// ---------- sway and paint helpers ----------

/**
 * Trunk-bend weight: quadratic with height (the base never moves); leaves add their own reach
 * from where they join, so frond tips swing more than the crown they hang from. Anything at
 * ground level stays put, so plants never slide on the ground.
 */
function swayOf(height: number, trunk: number, leaf: number): SwayFn {
  return (p, a, part) => {
    const y = part === Part.Trunk ? p[1] : a[1];
    const base = trunk * Math.pow(Math.max(0, y) / height, 2);
    if (part === Part.Trunk) return base;
    const grounded = Math.min(1, Math.max(0, p[1]) / (0.08 * height));
    return base + ((leaf * len(sub(p, a))) / height) * grounded;
  };
}

/** A rigid plant (cactus, corals): nothing bends. */
const still: SwayFn = () => 0;

function leaf(grow: [number, number], o: Partial<Paint> = {}): Paint {
  return { part: Part.Leaf, tone: (t) => t, shade: (t) => 0.82 + 0.22 * t, flutter: (t) => 0.3 + 0.7 * t, grow, ...o };
}
function bark(grow: [number, number], o: Partial<Paint> = {}): Paint {
  return { part: Part.Trunk, shade: (t) => 0.78 + 0.22 * t, grow, ...o };
}

/** A long leaf radiating from `base` at an azimuth and elevation. */
function frond(
  b: PlantBuilder,
  base: V3,
  az: number,
  elev: number,
  length: number,
  o: { segs: number; width: number; bend: number; fold?: number; zig?: number; paint: Paint; bendPow?: number; shape?: (t: number) => number },
): void {
  const shape = o.shape ?? ((t: number) => Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)));
  strip(b, {
    base,
    dir: dirFrom(az, elev),
    len: length,
    segs: o.segs,
    width: (t) => (t >= 1 ? 0 : o.width * shape(t)),
    bend: o.bend,
    bendPow: o.bendPow ?? 1.6,
    fold: o.fold ?? 0,
    zig: o.zig ?? 0,
    paint: { ...o.paint, attach: o.paint.attach ?? base },
  });
}

/** A two-triangle diamond leaf (pointed at both ends). */
function diamond(b: PlantBuilder, base: V3, dir: V3, length: number, w: number, paint: Paint, bend = 0, roll = 0): void {
  strip(b, { base, dir, len: length, segs: 2, width: (t) => (t <= 0 || t >= 1 ? 0 : w), bend, roll, paint: { ...paint, attach: paint.attach ?? base } });
}

/** A path that rises from `from` to `to` with a sideways kink (gnarled trunks and branches). */
function kinked(from: V3, to: V3, n: number, kink: number, r: () => number): V3[] {
  const pts: V3[] = [];
  const d = sub(to, from);
  const side = perpendicular(norm(d));
  const side2 = norm([d[1] * side[2] - d[2] * side[1], d[2] * side[0] - d[0] * side[2], d[0] * side[1] - d[1] * side[0]]);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = Math.sin(Math.PI * t) * kink;
    pts.push(add(add(add(from, scale(d, t)), scale(side, w * (r() - 0.5) * 2)), scale(side2, w * (r() - 0.5) * 2)));
  }
  return pts;
}

/**
 * A leafy crown: a core puff plus `n - 1` smaller puffs spread over its upper surface (a golden-
 * angle spiral), so the outline reads as a cluster of leaf masses. All puffs shade as one rounded
 * crown (see blob). LOD1 crowns are a single puff. Returns the puffs (centre, radii) for flowers.
 * 20 triangles per puff.
 */
function crown(b: PlantBuilder, c: V3, r: V3, n: number, seed: number, paint: Paint, lod: 0 | 1): [V3, V3][] {
  const puffs: [V3, V3][] = [];
  if (lod === 1) {
    blob(b, c, r, 'ico', 0.12, seed, paint, c);
    return [[c, r]];
  }
  const core = scale(r, 0.72);
  blob(b, c, core, 'ico', 0.15, seed, paint, c);
  puffs.push([c, core]);
  for (let i = 1; i < n; i++) {
    const a = i * 2.39996 + seed;
    const e = -0.35 + 1.45 * ((i - 1) / Math.max(1, n - 2));
    const ce = Math.cos(e);
    const p: V3 = [c[0] + Math.cos(a) * ce * r[0] * 0.62, c[1] + Math.sin(e) * r[1] * 0.55, c[2] + Math.sin(a) * ce * r[2] * 0.62];
    const k = 0.42 + 0.12 * ((i * 0.618) % 1);
    const pr: V3 = [r[0] * k, r[1] * k * 1.15, r[2] * k];
    blob(b, p, pr, 'ico', 0.2, seed + i, paint, c);
    puffs.push([p, pr]);
  }
  return puffs;
}

/** A pad (prickly pear) or lens: a rim with a raised centre on each face. Triangles: 2 * n. */
function pad(b: PlantBuilder, centre: V3, normal: V3, up: V3, rx: number, ry: number, thick: number, n: number, paint: Paint): void {
  fan(b, { centre, normal, start: up, r: ry, n, stretch: rx / ry, peak: thick / ry, paint });
  fan(b, { centre, normal: scale(normal, -1), start: up, r: ry, n, stretch: rx / ry, peak: thick / ry, paint });
}

// ---------- archetype recipes ----------

type Recipe = (lod: 0 | 1, variant: number) => THREE.BufferGeometry;

function fern(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(11);
  const n = lod === 0 ? 7 : 4;
  rosette(n, 0.3, (_i, a) => {
    const az = a + (r() - 0.5) * 0.4;
    const base: V3 = [Math.cos(az) * 0.04, 0.03, Math.sin(az) * 0.04];
    frond(b, base, az, 0.95 + (r() - 0.5) * 0.35, 0.8 + r() * 0.2, {
      segs: lod === 0 ? 4 : 2,
      width: 0.11,
      bend: 1.7,
      zig: lod === 0 ? 0.5 : 0,
      paint: leaf([0.25, 1], { attach: [0, 0.03, 0] }),
    });
  });
  if (lod === 0) {
    // Two young fiddleheads in the middle, still curled.
    for (let i = 0; i < 2; i++) {
      const az = i * Math.PI + 0.7;
      strip(b, { base: [0, 0.02, 0], dir: dirFrom(az, 1.35), len: 0.28, segs: 2, width: (t) => (t >= 1 ? 0 : 0.025), bend: 4.2, bendPow: 1.2, paint: leaf([0.5, 0.9], { tone: 0.9 }) });
    }
  }
  return b.finish(swayOf(0.8, 0, 0.9));
}

function treeFern(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(12);
  const top: V3 = [0.25, 3.4, 0.1];
  const path: V3[] = lod === 0 ? [[0, 0, 0], [0.04, 0.9, 0.02], [0.12, 1.8, 0.05], [0.2, 2.6, 0.08], top] : [[0, 0, 0], [0.1, 1.7, 0.04], top];
  const radii = lod === 0 ? [0.22, 0.17, 0.15, 0.14, 0.17] : [0.2, 0.15, 0.16];
  tube(b, path, radii, lod === 0 ? 6 : 4, bark([0, 0.55], { shade: (t) => 0.75 + 0.25 * (Math.sin(t * 40) > 0 ? 1 : 0.6), tone: (t) => 0.15 * (1 - t) }));
  const n = lod === 0 ? 9 : 6;
  rosette(n, 0.2, (_i, a) => {
    const az = a + (r() - 0.5) * 0.3;
    const base = add(top, [Math.cos(az) * 0.12, 0.05, Math.sin(az) * 0.12]);
    frond(b, base, az, 0.55 + (r() - 0.5) * 0.3, 2.3 + r() * 0.4, {
      segs: lod === 0 ? 5 : 2,
      width: 0.36,
      bend: 1.6,
      fold: lod === 0 ? 0.25 : 0,
      zig: lod === 0 ? 0.35 : 0,
      paint: leaf([0.55, 1], { attach: top }),
    });
  });
  if (lod === 0) {
    // A skirt of old brown fronds hanging against the trunk.
    rosette(3, 1.0, (_i, a) => {
      const base = add(top, [Math.cos(a) * 0.15, -0.1, Math.sin(a) * 0.15]);
      frond(b, base, a, -1.25, 1.2, { segs: 2, width: 0.2, bend: -0.2, paint: { part: Part.Own, own: 0x8b6a3e, shade: 0.9, grow: [0.5, 0.7], attach: top } });
    });
    // Fiddleheads in the crown.
    for (let i = 0; i < 2; i++) {
      strip(b, { base: add(top, [0, 0.05, 0]), dir: dirFrom(i * 2.6, 1.3), len: 0.4, segs: 2, width: (t) => (t >= 1 ? 0 : 0.04), bend: 4, bendPow: 1.2, paint: leaf([0.8, 1], { tone: 0.9 }) });
    }
  }
  return b.finish(swayOf(4.2, 0.5, 0.35));
}

function grass(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(13);
  const n = lod === 0 ? 12 : 6;
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + r() * 0.5;
    const base: V3 = [Math.cos(az) * 0.05, 0, Math.sin(az) * 0.05];
    blade(b, base, az, 0.32 + r() * 0.26, 0.022, 0.3 + r() * 0.35, 2, leaf([0.1, 1], { attach: [0, 0, 0] }));
  }
  if (lod === 0) {
    // Seed heads (they show as the flower part, so the dry season can tint them).
    for (let i = 0; i < 3; i++) {
      const az = i * 2.1 + 0.4;
      blade(b, [Math.cos(az) * 0.03, 0, Math.sin(az) * 0.03], az, 0.62 + r() * 0.1, 0.015, 0.2, 1, { part: Part.Flower, shade: (t) => 0.8 + 0.2 * t, grow: [0.6, 1], flutter: 0.5, attach: [0, 0, 0] });
    }
  }
  return b.finish(swayOf(0.55, 0, 1.1));
}

function duneGrass(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(14);
  const n = lod === 0 ? 10 : 6;
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + r() * 0.6;
    blade(b, [Math.cos(az) * 0.06, 0, Math.sin(az) * 0.06], az, 0.6 + r() * 0.35, 0.025, 0.55 + r() * 0.4, 2, leaf([0.1, 1], { attach: [0, 0, 0] }));
  }
  if (lod === 0) {
    // Nodding seed heads on tall stalks: sea oats.
    for (let i = 0; i < 3; i++) {
      const az = i * 2.2 + 0.9;
      const top: V3 = [Math.cos(az) * 0.18, 0.95 + r() * 0.12, Math.sin(az) * 0.18];
      blade(b, [0, 0, 0], az, top[1], 0.012, 0.18, 1, { part: Part.Flower, shade: 0.75, grow: [0.3, 0.8], attach: [0, 0, 0] });
      strip(b, { base: top, dir: dirFrom(az, -0.6), len: 0.26, segs: 2, width: (t) => (t >= 1 ? 0 : 0.03), bend: 0.4, paint: { part: Part.Flower, shade: (t) => 0.9 + 0.15 * t, grow: [0.8, 1], flutter: 0.6, attach: top } });
    }
  }
  return b.finish(swayOf(1.0, 0, 1.2));
}

function sedge(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(15);
  const n = lod === 0 ? 18 : 12;
  for (let i = 0; i < n; i++) {
    const az = r() * Math.PI * 2;
    blade(b, [Math.cos(az) * 0.05, 0, Math.sin(az) * 0.05], az, 0.55 + r() * 0.35, 0.018, 0.08 + r() * 0.2, 1, leaf([0.1, 1], { attach: [0, 0, 0] }));
  }
  if (lod === 0) {
    for (let i = 0; i < 3; i++) {
      const az = i * 2.1;
      const top: V3 = [Math.cos(az) * 0.08, 0.85 + r() * 0.1, Math.sin(az) * 0.08];
      blade(b, [0, 0, 0], az, top[1] - 0.05, 0.01, 0.09, 1, leaf([0.2, 0.8], { tone: 0.3, attach: [0, 0, 0] }));
      tube(b, [add(top, [0, -0.07, 0]), add(top, [0, 0.06, 0])], [0.025, 0], 4, { part: Part.Fruit, grow: [0.85, 1], shade: 0.9 });
    }
  }
  return b.finish(swayOf(0.85, 0, 0.8));
}

function vine(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(16);
  const runners = lod === 0 ? 2 : 1;
  const leaves: { p: V3; az: number }[] = [];
  for (let k = 0; k < runners; k++) {
    const az0 = k * Math.PI + 0.4;
    const segs = lod === 0 ? 3 : 2;
    const length = 1.0;
    // The runner creeps along the sand (it never sways); only its leaves and flowers move.
    strip(b, { base: [0, 0.02, 0], dir: dirFrom(az0, 0), len: length, segs, width: () => 0.03, paint: { part: Part.Trunk, tone: 0.6, shade: 0.8, grow: [0, 0.9] } });
    for (let j = 0; j < (lod === 0 ? 4 : 3); j++) {
      const d = (j + 0.6) / 4.4;
      leaves.push({ p: [Math.cos(az0) * d * length, 0.03, Math.sin(az0) * d * length], az: az0 + (j % 2 === 0 ? 1.2 : -1.2) + (r() - 0.5) * 0.4 });
    }
  }
  const nLeaves = lod === 0 ? 7 : 3;
  for (let i = 0; i < nLeaves; i++) {
    const { p, az } = leaves[i];
    // Goat's-foot leaves: round with a notch at the tip, tipped up toward the sun.
    const nrm = norm([Math.cos(az) * 0.5, 1, Math.sin(az) * 0.5]);
    const start = norm(sub(dirFrom(az, 0.4), scale(nrm, 0.4)));
    fan(b, { centre: add(p, scale(dirFrom(az, 0.3), 0.12)), normal: nrm, start, r: 0.14, n: lod === 0 ? 5 : 3, zig: lod === 0 ? 0.35 : 0, cup: 0.15, paint: leaf([0.3 + i * 0.08, 0.6 + i * 0.05], { tone: 0.3, attach: p }) });
  }
  if (lod === 0) {
    for (let i = 0; i < 2; i++) {
      const p: V3 = [Math.cos(i * 2.4 + 1) * 0.35, 0.05, Math.sin(i * 2.4 + 1) * 0.35];
      fan(b, { centre: add(p, [0, 0.08, 0]), normal: [0, 1, 0], start: [1, 0, 0], r: 0.09, n: 4, cup: 0.9, peak: -0.6, paint: { part: Part.Flower, grow: [0.9, 1], shade: 1, attach: p } });
    }
  }
  return b.finish(swayOf(0.2, 0, 0.15));
}

function mat(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(17);
  const stems = lod === 0 ? 5 : 2;
  const nLeaves = lod === 0 ? 22 : 5;
  const tips: { p: V3; az: number }[] = [];
  for (let k = 0; k < stems; k++) {
    const az = (k / stems) * Math.PI * 2 + r() * 0.5;
    strip(b, { base: [0, 0.03, 0], dir: dirFrom(az, 0.08), len: 0.38, segs: 1, width: () => 0.016, paint: bark([0, 0.6]) });
    tips.push({ p: [0, 0.03, 0], az });
  }
  for (let i = 0; i < nLeaves; i++) {
    const s = tips[i % stems];
    const d = 0.05 + r() * 0.33;
    const p: V3 = [Math.cos(s.az) * d, 0.04 + d * 0.06, Math.sin(s.az) * d];
    const az = s.az + (r() - 0.5) * 2.2;
    diamond(b, p, dirFrom(az, 0.35 + r() * 0.4), 0.14, 0.045, leaf([0.3, 0.9], { tone: r() * 0.6, attach: p }));
  }
  return b.finish(swayOf(0.15, 0, 0.2));
}

function herb(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(18);
  const heads: V3[] = [];
  for (let k = 0; k < 3; k++) {
    const az = k * 2.1 + 0.3;
    const h = 0.38 + r() * 0.15;
    const top: V3 = [Math.cos(az) * 0.09, h, Math.sin(az) * 0.09];
    blade(b, [0, 0, 0], az, h, 0.012, 0.22, 1, leaf([0, 0.7], { tone: 0.1, attach: [0, 0, 0] }));
    heads.push(top);
  }
  if (lod === 0) {
    for (let i = 0; i < 6; i++) {
      const az = i * 1.05 + r() * 0.4;
      const p: V3 = [0, 0.04 + (i % 3) * 0.07, 0];
      diamond(b, p, dirFrom(az, 0.45), 0.18, 0.035, leaf([0.15, 0.6], { attach: p }));
    }
  }
  for (const top of heads) {
    const nrm = norm([top[0], 1.4, top[2]]);
    const start = perpendicular(nrm);
    fan(b, { centre: top, normal: nrm, start, r: 0.07, n: lod === 0 ? 6 : 4, zig: lod === 0 ? 0.45 : 0, cup: 0.12, paint: { part: Part.Flower, grow: [0.9, 1], shade: 1, attach: top } });
    if (lod === 0) fan(b, { centre: add(top, scale(nrm, 0.008)), normal: nrm, start, r: 0.022, n: 4, peak: 0.3, paint: { part: Part.Fruit, grow: [0.9, 1], attach: top } });
  }
  return b.finish(swayOf(0.5, 0, 1.0));
}

function palm(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(19);
  const H = 8.6;
  const lean = 0.12;
  const rings = lod === 0 ? 5 : 3;
  const path: V3[] = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    path.push([lean * H * t * t, H * t, 0]);
  }
  const radii = lod === 0 ? [0.34, 0.26, 0.22, 0.2, 0.19] : [0.32, 0.22, 0.19];
  tube(b, path, radii, lod === 0 ? 6 : 4, bark([0, 0.55], { shade: (t, u) => 0.82 + 0.12 * Math.sin(t * 60) + 0.06 * Math.cos(u * 6.28) }));
  const top = path[rings - 1];
  if (lod === 0) blob(b, add(top, [0, 0.1, 0]), [0.36, 0.3, 0.36], 'octa', 0.1, 3, leaf([0.5, 0.6], { tone: 0.2, shade: 0.75, flutter: 0 }));
  const n = lod === 0 ? 8 : 6;
  rosette(n, 0.15, (_i, a) => {
    const az = a + (r() - 0.5) * 0.3;
    const base = add(top, [Math.cos(az) * 0.15, 0.1, Math.sin(az) * 0.15]);
    frond(b, base, az, 0.5 + (r() - 0.5) * 0.4, 4.0 + r() * 0.6, {
      segs: lod === 0 ? 5 : 2,
      width: 0.55,
      bend: 2.0,
      fold: lod === 0 ? -0.3 : 0,
      zig: lod === 0 ? 0.3 : 0,
      paint: leaf([0.55, 1], { attach: top }),
      shape: (t) => Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.92)) * (0.7 + 0.3 * t),
    });
  });
  if (lod === 0) {
    for (let c = 0; c < 3; c++) {
      const a = c * 2.1 + 0.5;
      blob(b, add(top, [Math.cos(a) * 0.28, -0.22, Math.sin(a) * 0.28]), [0.2, 0.22, 0.2], 'octa', 0.05, c, { part: Part.Fruit, grow: [0.85, 0.95], shade: 1, attach: top });
    }
  }
  return b.finish(swayOf(9, 1.8, 0.25));
}

function pandanus(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(20);
  const fork: V3 = [0.1, 3.4, 0.05];
  if (lod === 0) {
    // Stilt roots.
    rosette(3, 0.5, (_i, a) => {
      tube(b, [[Math.cos(a) * 0.85, 0, Math.sin(a) * 0.85], [Math.cos(a) * 0.12, 1.25, Math.sin(a) * 0.12]], [0.06, 0.08], 4, bark([0, 0.2]));
    });
  }
  tube(b, lod === 0 ? [[0, 0.6, 0], [0.03, 1.6, 0.02], [0.06, 2.5, 0.04], fork] : [[0, 0, 0], fork], lod === 0 ? [0.17, 0.15, 0.14, 0.12] : [0.16, 0.12], lod === 0 ? 5 : 4, bark([0, 0.45]));
  const tips: V3[] = [];
  rosette(3, 0.4, (_i, a) => {
    const tip: V3 = add(fork, [Math.cos(a) * 1.3, 1.5 + r() * 0.6, Math.sin(a) * 1.3]);
    if (lod === 0) tube(b, kinked(fork, tip, 3, 0.2, r), [0.11, 0.09, 0.08], 4, bark([0.4, 0.6], { attach: fork }));
    tips.push(tip);
  });
  for (const tip of tips) {
    const nl = lod === 0 ? 11 : 4;
    rosette(nl, r() * 3, (_j, a) => {
      if (lod === 0) {
        frond(b, tip, a, 0.75 + (r() - 0.5) * 0.7, 2.1 + r() * 0.4, { segs: 2, width: 0.15, bend: 1.7, paint: leaf([0.6, 1], { attach: tip }), shape: (t) => 1 - t * 0.6 });
      } else {
        frond(b, tip, a, 0.3, 1.4, { segs: 1, width: 0.12, bend: 1, paint: leaf([0.6, 1], { attach: tip }), shape: () => 1 });
      }
    });
  }
  if (lod === 0) {
    for (let k = 0; k < 2; k++) blob(b, add(tips[k], [0.1, -0.35, 0.05]), [0.18, 0.24, 0.18], 'octa', 0.1, 9 + k, { part: Part.Fruit, grow: [0.85, 0.95], shade: (t) => 0.85 + 0.2 * t, attach: tips[k] });
  }
  return b.finish(swayOf(6, 0.7, 0.3));
}

function seaGrape(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(21);
  if (lod === 1) {
    tube(b, [[0, 0, 0], [0.05, 1.2, 0]], [0.08, 0.05], 4, bark([0, 0.5]));
    crown(b, [0.05, 1.6, 0], [1.25, 0.85, 1.2], 1, 1, leaf([0.5, 0.9], { attach: [0.05, 1.2, 0] }), 1);
    return b.finish(swayOf(2.6, 0.5, 0.15));
  }
  const tips: V3[] = [];
  rosette(3, 0.7, (_i, a) => {
    const tip: V3 = [Math.cos(a) * 0.7, 1.7 + r() * 0.5, Math.sin(a) * 0.7];
    tube(b, kinked([0, 0, 0], tip, 3, 0.15, r), [0.08, 0.06, 0.04], 4, bark([0, 0.5]));
    tips.push(tip);
  });
  // Big round leaves crowded along the upper stems, overlapping like shingles.
  for (let i = 0; i < 30; i++) {
    const tip = tips[i % 3];
    const along = 0.45 + 0.55 * r();
    const at: V3 = [tip[0] * along, tip[1] * along, tip[2] * along];
    const a = r() * Math.PI * 2;
    const e = (r() - 0.35) * 1.5;
    const out = dirFrom(a, e);
    const c = add(at, scale(out, 0.25 + r() * 0.35));
    const nrm = norm(add(out, [0, 0.8, 0]));
    fan(b, { centre: c, normal: nrm, start: perpendicular(nrm), r: 0.3 + r() * 0.1, n: 5, cup: 0.12, paint: leaf([0.45 + along * 0.4, 0.95], { tone: r(), shade: 0.8 + r() * 0.25, attach: at }) });
  }
  for (let k = 0; k < 3; k++) {
    const tip = tips[k];
    blob(b, add(tip, [0.15, -0.35, 0.1]), [0.07, 0.2, 0.07], 'octa', 0.1, 30 + k, { part: Part.Fruit, grow: [0.9, 1], shade: 1, attach: tip });
  }
  return b.finish(swayOf(2.6, 0.5, 0.15));
}

function shrub(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(22);
  if (lod === 1) {
    crown(b, [0.1, 0.62, 0.05], [0.95, 0.68, 0.9], 1, 1, leaf([0.2, 0.9], { attach: [0, 0, 0] }), 1);
    return b.finish(swayOf(1.4, 0.4, 0.1));
  }
  const puffs: V3[] = [
    [0, 0.72, 0],
    [0.45, 0.5, 0.25],
    [-0.4, 0.48, -0.2],
  ];
  const radii: V3[] = [
    [0.7, 0.6, 0.7],
    [0.55, 0.45, 0.55],
    [0.55, 0.45, 0.5],
  ];
  puffs.forEach((c, i) => blob(b, c, radii[i], 'ico', 0.18, 40 + i, leaf([0.25 + i * 0.1, 0.8], { attach: [c[0] * 0.3, 0.1, c[2] * 0.3] }), [0, 0.5, 0]));
  // Spoon-leaf rosettes poking out of the mound.
  for (let i = 0; i < 12; i++) {
    const a = r() * Math.PI * 2;
    const e = 0.15 + r() * 1.1;
    const c = puffs[i % 3];
    const out = dirFrom(a, e);
    const p = add(c, [out[0] * radii[i % 3][0] * 0.9, out[1] * radii[i % 3][1] * 0.9, out[2] * radii[i % 3][2] * 0.9]);
    diamond(b, p, norm(add(out, [0, 0.6, 0])), 0.28, 0.07, leaf([0.6, 1], { tone: 0.7 + r() * 0.3, attach: c }));
  }
  // White half-flowers: fans that are only half a circle.
  for (let i = 0; i < 6; i++) {
    const a = i * 1.05 + r() * 0.3;
    const c = puffs[i % 3];
    const out = dirFrom(a, 0.6);
    const p = add(c, [out[0] * radii[i % 3][0], out[1] * radii[i % 3][1], out[2] * radii[i % 3][2]]);
    fan(b, { centre: p, normal: out, start: [0, 1, 0], r: 0.07, n: 3, arc: Math.PI, cup: 0.2, paint: { part: Part.Flower, grow: [0.9, 1], attach: c } });
  }
  return b.finish(swayOf(1.4, 0.4, 0.1));
}

function mangrove(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(23);
  const trunkTop: V3 = [0.1, 3.4, 0];
  tube(b, lod === 0 ? [[0, 0.9, 0], [0.05, 2.2, 0.02], trunkTop] : [[0, 0.5, 0], trunkTop], lod === 0 ? [0.16, 0.14, 0.11] : [0.15, 0.1], lod === 0 ? 5 : 4, bark([0.2, 0.6]));
  // Arched prop roots: from the trunk out and down into the mud (darker below the tide line).
  const roots = lod === 0 ? 6 : 2;
  rosette(roots, 0.3, (_i, a) => {
    const from: V3 = [Math.cos(a) * 0.1, 1.1 + r() * 0.8, Math.sin(a) * 0.1];
    const reach = 1.4 + r() * 0.8;
    const to: V3 = [Math.cos(a) * reach, -0.3, Math.sin(a) * reach];
    const mid1: V3 = [Math.cos(a) * reach * 0.45, from[1] + 0.35, Math.sin(a) * reach * 0.45];
    const mid2: V3 = [Math.cos(a) * reach * 0.85, from[1] * 0.5, Math.sin(a) * reach * 0.85];
    const path: V3[] = lod === 0 ? [from, mid1, mid2, to] : [from, to];
    tube(b, path, lod === 0 ? [0.06, 0.055, 0.05, 0.05] : [0.06, 0.05], 3, { part: Part.Trunk, grow: [0, 0.5], shade: (t) => (t > 0.75 ? 0.6 : 0.9), attach: [0, from[1], 0] });
  });
  crown(b, [0.1, 3.9, 0], [2.5, 1.4, 2.4], 5, 50, leaf([0.6, 0.95], { attach: trunkTop }), lod);
  if (lod === 0) {
    // Dangling cigar-shaped seedlings (propagules).
    for (let k = 0; k < 4; k++) {
      const a = k * 1.6 + 0.3;
      const p: V3 = [Math.cos(a) * 1.0, 3.1, Math.sin(a) * 1.0];
      tube(b, [p, add(p, [0, -0.45, 0])], [0.03, 0], 3, { part: Part.Fruit, grow: [0.9, 1], shade: 0.9, attach: trunkTop });
    }
  }
  return b.finish(swayOf(5.5, 0.35, 0.08));
}

function fig(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(24);
  const crownBase: V3 = [0, 6.2, 0];
  if (lod === 0) {
    // Three stems twisted together (a strangler fig's fused trunk).
    for (let k = 0; k < 3; k++) {
      const path: V3[] = [];
      for (let i = 0; i < 4; i++) {
        const t = i / 3;
        const a = k * 2.1 + t * 2.2;
        const rr = 0.42 * (1 - t * 0.55);
        path.push([Math.cos(a) * rr, t * 6.4, Math.sin(a) * rr]);
      }
      tube(b, path, [0.32, 0.26, 0.24, 0.2], 5, bark([0, 0.5], { shade: (t, u) => 0.8 + 0.12 * Math.sin(u * 12.6 + t * 8) }));
    }
    // Limbs spreading wide.
    rosette(4, 0.4, (_i, a) => {
      const tip: V3 = [Math.cos(a) * 4.2, 8.2 + r() * 1.2, Math.sin(a) * 4.2];
      tube(b, kinked(crownBase, tip, 3, 0.4, r), [0.2, 0.15, 0.1], 3, bark([0.45, 0.65], { attach: crownBase }));
    });
    // Aerial roots dropping from the limbs.
    rosette(6, 0.9, (_i, a) => {
      const d = 2.2 + r() * 1.8;
      const top: V3 = [Math.cos(a) * d, 7.4, Math.sin(a) * d];
      tube(b, [top, [top[0] * 1.03, 0, top[2] * 1.03]], [0.04, 0.05], 3, bark([0.6, 0.75], { shade: 0.85, attach: top }));
    });
  } else {
    tube(b, [[0, 0, 0], crownBase], [0.7, 0.45], 5, bark([0, 0.5]));
  }
  // A wide, flat, dark crown: the fig is the island's great tree.
  crown(b, [0, 9.3, 0], lod === 0 ? [6.2, 2.6, 6.0] : [6.0, 2.4, 5.8], 10, 60, leaf([0.6, 0.95], { attach: crownBase }), lod);
  if (lod === 0) {
    for (let k = 0; k < 2; k++) {
      const a = k * 2.7 + 0.2;
      blob(b, [Math.cos(a) * 2.6, 7.6, Math.sin(a) * 2.6], [0.16, 0.16, 0.16], 'octa', 0, 70 + k, { part: Part.Fruit, grow: [0.9, 1], attach: [Math.cos(a) * 2.0, 8.4, Math.sin(a) * 2.0] });
    }
  }
  return b.finish(swayOf(12, 0.22, 0.05));
}

/** A gnarled tree: a kinked trunk, a few limbs and crown puffs at their ends. Shared by PomTree, Broadleaf and CloudTree. */
function puffTree(
  lod: 0 | 1,
  o: {
    seed: number;
    height: number;
    trunkTop: number;
    trunkR: number;
    sides: number;
    kink: number;
    limbs: number;
    reach: number;
    crownC: V3;
    crownR: V3;
    puffs: number;
    trunkTone?: (t: number) => number;
  },
  extra?: (b: PlantBuilder, tips: V3[], puffs: [V3, V3][], r: () => number) => void,
): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(o.seed);
  const top: V3 = [0.15, o.trunkTop, 0.1];
  const tone = o.trunkTone ?? (() => 0);
  if (lod === 0) {
    tube(b, kinked([0, 0, 0], top, 4, o.kink, r), [o.trunkR, o.trunkR * 0.8, o.trunkR * 0.7, o.trunkR * 0.6], o.sides, bark([0, 0.5], { tone: (t) => tone(t), shade: (t, u) => 0.78 + 0.18 * t + 0.06 * Math.sin(u * 18.8 + t * 11) }));
  } else {
    tube(b, [[0, 0, 0], top], [o.trunkR, o.trunkR * 0.6], 4, bark([0, 0.5], { tone: (t) => tone(t) }));
  }
  const tips: V3[] = [];
  rosette(o.limbs, r() * 3, (_i, a) => {
    const tip: V3 = add(top, [Math.cos(a) * o.reach, o.height * 0.12 + r() * o.height * 0.1, Math.sin(a) * o.reach]);
    if (lod === 0) tube(b, kinked(top, tip, 3, o.kink * 0.5, r), [o.trunkR * 0.5, o.trunkR * 0.35, o.trunkR * 0.25], 3, bark([0.4, 0.6], { tone: (t) => tone(0.5 + t * 0.5), attach: top }));
    tips.push(tip);
  });
  const puffs = crown(b, o.crownC, o.crownR, o.puffs, o.seed * 10, leaf([0.6, 0.95], { attach: top }), lod);
  if (lod === 0 && extra) extra(b, tips, puffs, r);
  return b.finish(swayOf(o.height, 0.3, 0.06));
}

function pomTree(lod: 0 | 1): THREE.BufferGeometry {
  return puffTree(lod, { seed: 25, height: 8, trunkTop: 4.0, trunkR: 0.22, sides: 5, kink: 0.6, limbs: 3, reach: 1.6, crownC: [0.2, 5.9, 0.1], crownR: [3.0, 1.9, 2.9], puffs: 7 }, (b, _tips, puffs, r) => {
    // Red pom-pom flowers dotted over the crown.
    for (let i = 0; i < 8; i++) {
      const [c, rr] = puffs[1 + (i % (puffs.length - 1))];
      const a = r() * Math.PI * 2;
      const e = r() * 1.0 + 0.1;
      const out = dirFrom(a, e);
      const p: V3 = [c[0] + out[0] * rr[0] * 1.02, c[1] + out[1] * rr[1] * 1.02, c[2] + out[2] * rr[2] * 1.02];
      fan(b, { centre: p, normal: out, start: perpendicular(out), r: 0.34, n: 4, zig: 0.65, peak: 0.6, paint: { part: Part.Flower, grow: [0.9, 1], flutter: 0.4, attach: c } });
    }
  });
}

function broadleaf(lod: 0 | 1): THREE.BufferGeometry {
  return puffTree(lod, { seed: 26, height: 10, trunkTop: 5.4, trunkR: 0.3, sides: 6, kink: 0.35, limbs: 4, reach: 2.0, crownC: [0.2, 7.6, 0.1], crownR: [3.7, 2.4, 3.5], puffs: 8 });
}

function cloudTree(lod: 0 | 1): THREE.BufferGeometry {
  return puffTree(lod, { seed: 27, height: 6.5, trunkTop: 3.0, trunkR: 0.3, sides: 5, kink: 0.9, limbs: 3, reach: 1.7, crownC: [0.2, 4.6, 0.1], crownR: [3.0, 1.6, 2.8], puffs: 6, trunkTone: (t) => 0.25 + 0.55 * t }, (b, tips, _puffs, r) => {
    // Bromeliads perched on the limbs: a rosette of straps around a red heart.
    for (let k = 0; k < 3; k++) {
      const p = add(tips[k % tips.length], [0, -0.55, 0]);
      rosette(4, r() * 3, (_j, a) => diamond(b, p, dirFrom(a, 0.7), 0.35, 0.06, leaf([0.8, 1], { tone: 0.8, attach: p })));
      fan(b, { centre: add(p, [0, 0.05, 0]), normal: [0, 1, 0], start: [1, 0, 0], r: 0.07, n: 3, cup: 0.6, paint: { part: Part.Flower, grow: [0.9, 1], attach: p } });
    }
    // Beard lichen hanging from the limbs, pale and slow.
    for (let k = 0; k < 4; k++) {
      const t = tips[k % tips.length];
      const p: V3 = add(t, [(r() - 0.5) * 0.6, -0.5, (r() - 0.5) * 0.6]);
      strip(b, { base: p, dir: [0.05, -1, 0], len: 0.8, segs: 2, width: (tt) => (tt >= 1 ? 0 : 0.06), paint: { part: Part.Own, own: 0xc9d3a8, grow: [0.85, 1], flutter: 0.8, attach: t } });
    }
  });
}

function sheOak(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(28);
  const top: V3 = [0.1, 9.4, 0];
  tube(b, lod === 0 ? [[0, 0, 0], [0.05, 3, 0.02], [0.08, 6.2, 0.03], top] : [[0, 0, 0], top], lod === 0 ? [0.22, 0.17, 0.12, 0.05] : [0.2, 0.06], lod === 0 ? 5 : 4, bark([0, 0.6]));
  // Tiers of drooping, feathery skirts: a cone shape like a soft pine.
  const tiers = lod === 0 ? 5 : 3;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const y = 3.4 + t * 5.4;
    const rad = 2.4 * (1 - t * 0.75);
    const c: V3 = [0.08 * t, y, 0];
    fan(b, { centre: c, normal: [0, 1, 0], start: dirFrom(k * 0.7, 0), r: rad, n: 7, cup: -0.45, peak: 0.55, zig: 0.25, paint: leaf([0.45 + t * 0.4, 0.95], { tone: 0.2 + t * 0.6, shade: 0.8 + t * 0.2, attach: c }) });
    if (lod === 0) fan(b, { centre: add(c, [0, -0.35, 0]), normal: [0, 1, 0], start: dirFrom(k * 0.7 + 0.45, 0), r: rad * 0.9, n: 7, cup: -0.5, peak: 0.6, zig: 0.3, paint: leaf([0.45 + t * 0.4, 0.95], { tone: 0.1 + t * 0.5, shade: 0.72, attach: c }) });
  }
  if (lod === 0) {
    // Hanging needle wisps under the tiers.
    for (let i = 0; i < 12; i++) {
      const a = r() * Math.PI * 2;
      const y = 3.2 + r() * 4.8;
      const rad = 2.2 * (1 - ((y - 3.2) / 5.4) * 0.7);
      const p: V3 = [Math.cos(a) * rad * 0.85, y, Math.sin(a) * rad * 0.85];
      strip(b, { base: p, dir: norm([Math.cos(a) * 0.3, -1, Math.sin(a) * 0.3]), len: 0.7, segs: 2, width: (t) => (t >= 1 ? 0 : 0.05), paint: leaf([0.7, 1], { tone: 0.5, flutter: 0.9, attach: [0, y, 0] }) });
    }
  }
  return b.finish(swayOf(10, 0.45, 0.06));
}

function cactus(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(29);
  const top: V3 = [0.05, 1.25, 0];
  tube(b, lod === 0 ? [[0, 0, 0], [0.03, 0.65, 0], top] : [[0, 0, 0], top], lod === 0 ? [0.17, 0.15, 0.13] : [0.16, 0.12], lod === 0 ? 6 : 4, bark([0, 0.45], { shade: (_t, u) => (Math.floor(u * 12) % 2 === 0 ? 0.9 : 1.02) }));
  const pads: { c: V3; n: V3; up: V3; s: number }[] = [];
  // Pads chained upward from the trunk top, two to three levels deep.
  const grow = (c: V3, dir: V3, depth: number, s: number): void => {
    if (pads.length >= (lod === 0 ? 9 : 4)) return;
    const up = norm(dir);
    const centre = add(c, scale(up, 0.42 * s));
    const nrm = norm([up[2] + (r() - 0.5) * 0.6, 0.15, -up[0] + (r() - 0.5) * 0.6]);
    pads.push({ c: centre, n: nrm, up, s });
    if (depth >= 2) return;
    const tip = add(centre, scale(up, 0.4 * s));
    for (let k = 0; k < 2; k++) grow(tip, norm(add(up, scale(perpendicular(up), (k === 0 ? 1 : -1) * (0.6 + r() * 0.4)))), depth + 1, s * 0.85);
  };
  grow(top, [0.4, 1, 0.1], 0, 1);
  grow(top, [-0.5, 1, -0.2], 1, 0.95);
  pads.forEach((p, i) => {
    if (lod === 0) pad(b, p.c, p.n, p.up, 0.3 * p.s, 0.43 * p.s, 0.06 * p.s, 6, { part: Part.Leaf, tone: (t) => 0.3 * t, shade: (t) => 0.86 + 0.14 * t, grow: [0.45 + i * 0.05, 0.6 + i * 0.05], attach: add(p.c, scale(p.up, -0.3 * p.s)) });
    else fan(b, { centre: p.c, normal: p.n, start: p.up, r: 0.43 * p.s, n: 4, stretch: 0.7, paint: { part: Part.Leaf, grow: [0.5, 0.8], attach: p.c } });
  });
  if (lod === 0) {
    for (let k = 0; k < 3; k++) {
      const p = pads[pads.length - 1 - k];
      const at = add(p.c, scale(p.up, 0.44 * p.s));
      fan(b, { centre: at, normal: p.up, start: perpendicular(p.up), r: 0.07, n: 4, cup: 0.7, zig: 0.2, paint: { part: Part.Flower, grow: [0.9, 1], attach: at } });
      const fr = add(p.c, add(scale(p.up, 0.34 * p.s), scale(perpendicular(p.up), 0.2)));
      blob(b, fr, [0.05, 0.07, 0.05], 'octa', 0, 80 + k, { part: Part.Fruit, grow: [0.9, 1], attach: fr });
    }
  }
  return b.finish(still);
}

function silversword(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(30);
  const n = lod === 0 ? 22 : 12;
  for (let i = 0; i < n; i++) {
    const az = i * 2.39996;
    const e = 0.15 + (i / n) * 1.25;
    const base: V3 = [0, 0.18 + (i / n) * 0.12, 0];
    frond(b, base, az, e, 0.42 + r() * 0.08, { segs: lod === 0 ? 2 : 1, width: 0.035, bend: -0.5, paint: leaf([0.1 + (i / n) * 0.4, 0.5 + (i / n) * 0.3], { shade: (t) => 0.9 + 0.2 * t, flutter: 0.15, attach: base }), shape: () => 1 });
  }
  // A tall flowering spike on the plants that are in bloom.
  const spike: V3[] = lod === 0 ? [[0, 0.35, 0], [0, 0.7, 0], [0.02, 1.0, 0], [0.03, 1.25, 0]] : [[0, 0.35, 0], [0.03, 1.2, 0]];
  tube(b, spike, lod === 0 ? [0.06, 0.055, 0.045, 0] : [0.06, 0], lod === 0 ? 5 : 3, { part: Part.Flower, shade: (t) => 1.1 + 0.3 * t, grow: [0.7, 1], attach: [0, 0.35, 0] });
  if (lod === 0) {
    for (let k = 0; k < 8; k++) {
      const y = 0.5 + k * 0.09;
      const a = k * 2.4;
      const p: V3 = [Math.cos(a) * 0.08, y, Math.sin(a) * 0.08];
      fan(b, { centre: p, normal: dirFrom(a, 0.5), start: [0, 1, 0], r: 0.05, n: 3, cup: 0.3, paint: { part: Part.Flower, shade: 1.1, grow: [0.85, 1], attach: [0, 0.35, 0] } });
    }
  }
  return b.finish(swayOf(1.2, 0.15, 0.05));
}

function seagrass(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(31);
  const n = lod === 0 ? 8 : 4;
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + r();
    const base: V3 = [Math.cos(az) * 0.06, 0, Math.sin(az) * 0.06];
    strip(b, { base, dir: dirFrom(az, 1.35 + r() * 0.15), len: 0.45 + r() * 0.2, segs: lod === 0 ? 3 : 2, width: (t) => 0.018 * (1 - t * 0.4), bend: 0.4, roll: (r() - 0.5) * 0.8, paint: leaf([0.1, 1], { attach: [0, 0, 0], flutter: 0 }) });
  }
  return b.finish(swayOf(0.6, 0, 1.4));
}

function coral(lod: 0 | 1, variant: number): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(32 + variant);
  if (variant === 0) {
    // Brain coral: a low lumpy dome; tones alternate like its grooves.
    dome(b, [0, -0.05, 0], 0.55, 0.5, lod === 0 ? 9 : 5, 3, { part: Part.Leaf, tone: (_t, u) => (Math.floor(u * 18) % 2 === 0 ? 0.15 : 0.6), shade: (t) => 0.8 + 0.25 * t, grow: [0, 1] });
    return b.finish(still);
  }
  if (variant === 1) {
    // Staghorn: antler branches.
    const nb = lod === 0 ? 7 : 4;
    if (lod === 0) dome(b, [0, -0.05, 0], 0.2, 0.12, 5, 4, { part: Part.Leaf, tone: 1, shade: 0.8, grow: [0, 0.2] });
    rosette(nb, r(), (i, a) => {
      const e = 0.6 + r() * 0.7;
      const tip = add([0, 0, 0], scale(dirFrom(a, e), 0.55 + r() * 0.3));
      const mid = add(scale(tip, 0.5), [(r() - 0.5) * 0.1, 0.05, (r() - 0.5) * 0.1]);
      tube(b, lod === 0 ? [[0, 0, 0], mid, tip] : [[0, 0, 0], tip], lod === 0 ? [0.05, 0.04, 0] : [0.05, 0], lod === 0 ? 4 : 3, { part: Part.Leaf, tone: (t) => 0.4 + 0.6 * t, shade: (t) => 0.8 + 0.3 * t, grow: [0.1 + i * 0.05, 0.9] });
    });
    return b.finish(still);
  }
  if (variant === 2) {
    // Table coral: a wide flat plate on a short stalk.
    if (lod === 0) tube(b, [[0, -0.05, 0], [0, 0.35, 0]], [0.1, 0.08], 5, { part: Part.Leaf, tone: 0.2, shade: 0.75, grow: [0, 0.4] });
    const c: V3 = [0, 0.38, 0];
    const n = lod === 0 ? 10 : 6;
    fan(b, { centre: c, normal: [0, 1, 0], start: [1, 0, 0], r: 0.75, n, cup: 0.12, zig: 0.12, paint: { part: Part.Flower, shade: (t) => 1.05 - 0.15 * t, grow: [0.4, 1], attach: c } });
    fan(b, { centre: add(c, [0, -0.04, 0]), normal: [0, -1, 0], start: [1, 0, 0], r: 0.72, n, cup: -0.08, paint: { part: Part.Flower, shade: 0.6, grow: [0.4, 1], attach: c } });
    return b.finish(still);
  }
  // Sea fan: a flat lacy fan standing across the surge, which sways.
  const c: V3 = [0, 0.05, 0];
  fan(b, { centre: c, normal: [1, 0, 0], start: [0, 1, 0], r: 0.75, n: lod === 0 ? 10 : 12, arc: 2.3, zig: 0.18, paint: { part: Part.Leaf, tone: (t) => 0.5 + 0.5 * t, shade: (t) => 0.75 + 0.35 * t, grow: [0.1, 1], flutter: 0, attach: c } });
  if (lod === 0) blade(b, [0, 0, 0], 0, 0.12, 0.04, 0, 1, { part: Part.Leaf, tone: 0.5, shade: 0.6, grow: [0, 0.1] });
  return b.finish((p) => Math.max(0, p[1]) * 1.1);
}

function lily(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(33);
  const pads = lod === 0 ? 4 : 2;
  for (let i = 0; i < pads; i++) {
    const a = (i / pads) * Math.PI * 2 + r() * 0.6;
    const d = i === 0 ? 0 : 0.35 + r() * 0.25;
    const c: V3 = [Math.cos(a) * d, 0.01, Math.sin(a) * d];
    // A round pad with its notch.
    fan(b, { centre: c, normal: [0, 1, 0], start: dirFrom(r() * 6.28, 0), r: 0.2 + r() * 0.08, n: lod === 0 ? 7 : 6, arc: Math.PI * 1.8, cup: 0.04, paint: leaf([0.2 + i * 0.1, 0.6 + i * 0.1], { tone: r() * 0.5, flutter: 0, attach: c }) });
  }
  if (lod === 0) {
    const c: V3 = [0.12, 0.03, 0.05];
    fan(b, { centre: c, normal: [0, 1, 0], start: [1, 0, 0], r: 0.11, n: 6, cup: 0.55, zig: 0.35, paint: { part: Part.Flower, grow: [0.85, 1], shade: 1, attach: c } });
    fan(b, { centre: add(c, [0, 0.01, 0]), normal: [0, 1, 0], start: dirFrom(0.5, 0), r: 0.07, n: 5, cup: 0.9, zig: 0.3, paint: { part: Part.Flower, grow: [0.9, 1], shade: 1.08, attach: c } });
  }
  return b.finish(still);
}

function epiphyte(lod: 0 | 1): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const r = seq(34);
  const c: V3 = [0, 0, 0];
  const straps = lod === 0 ? 7 : 6;
  rosette(straps, 0.2, (_i, a) => diamond(b, c, dirFrom(a, 0.75 + (r() - 0.5) * 0.4), 0.32, 0.05, leaf([0.2, 0.7], { attach: c }), 0.6));
  if (lod === 0) {
    fan(b, { centre: [0, 0.04, 0], normal: [0, 1, 0], start: [1, 0, 0], r: 0.06, n: 4, cup: 0.7, paint: { part: Part.Own, own: 0xc2383a, grow: [0.7, 0.9], attach: c } });
    // Two arching orchid sprays.
    for (let k = 0; k < 2; k++) {
      const az = k * 3 + 0.6;
      strip(b, { base: c, dir: dirFrom(az, 1.0), len: 0.45, segs: 2, width: (t) => (t >= 1 ? 0 : 0.008), bend: 1.4, paint: leaf([0.5, 0.8], { tone: 0.2, attach: c }) });
      for (let f = 0; f < (k === 0 ? 3 : 2); f++) {
        const t = 0.45 + f * 0.2;
        const p: V3 = [Math.cos(az) * 0.3 * t, 0.32 * Math.sin(Math.PI * t * 0.8), Math.sin(az) * 0.3 * t];
        fan(b, { centre: p, normal: dirFrom(az, 0.2), start: [0, 1, 0], r: 0.045, n: 5, zig: 0.45, paint: { part: Part.Flower, grow: [0.85, 1], flutter: 0.5, attach: c } });
      }
    }
  }
  return b.finish(swayOf(0.5, 0, 0.4));
}

const RECIPES: Partial<Record<PlantModel, Recipe>> = {
  [M.Fern]: fern,
  [M.TreeFern]: treeFern,
  [M.Grass]: grass,
  [M.DuneGrass]: duneGrass,
  [M.Sedge]: sedge,
  [M.Vine]: vine,
  [M.Mat]: mat,
  [M.Herb]: herb,
  [M.Palm]: palm,
  [M.Pandanus]: pandanus,
  [M.SeaGrape]: seaGrape,
  [M.Shrub]: shrub,
  [M.Mangrove]: mangrove,
  [M.Fig]: fig,
  [M.PomTree]: pomTree,
  [M.Broadleaf]: broadleaf,
  [M.CloudTree]: cloudTree,
  [M.SheOak]: sheOak,
  [M.Cactus]: cactus,
  [M.Silversword]: silversword,
  [M.Seagrass]: seagrass,
  [M.Coral]: coral,
  [M.Lily]: lily,
  [M.Epiphyte]: epiphyte,
};

/** Build one archetype at LOD0 or LOD1 (variant 0..variants-1). Throws for Tint. */
export function buildPlant(model: PlantModel, lod: 0 | 1, variant = 0): THREE.BufferGeometry {
  const recipe = RECIPES[model];
  if (!recipe) throw new Error(`No model for plant archetype ${model}`);
  return recipe(lod, variant);
}

/**
 * The far canopy family (LOD2), each 1 m tall so the instance scale is the plant's height:
 * Round (crown puff on a stalk), Star (palm-like), Cone (she-oak), Flat (wide fig crown).
 */
export function buildFarShape(shape: FarShape): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const stalk = (top: number): void => tube(b, [[0, -0.05, 0], [0, top, 0]], [0.035, 0.025], 3, bark([0, 0.5]));
  if (shape === FarShape.Round) {
    stalk(0.5);
    blob(b, [0, 0.66, 0], [0.42, 0.32, 0.42], 'ico', 0.15, 1, leaf([0.5, 1], { flutter: 0, attach: [0, 0.4, 0] }));
  } else if (shape === FarShape.Star) {
    stalk(0.92);
    rosette(6, 0.3, (_i, a) => diamond(b, [0, 0.95, 0], dirFrom(a, 0.25), 0.42, 0.07, leaf([0.6, 1], { flutter: 0, attach: [0, 0.95, 0] }), 1.2));
  } else if (shape === FarShape.Cone) {
    stalk(0.3);
    fan(b, { centre: [0, 0.3, 0], normal: [0, 1, 0], start: [1, 0, 0], r: 0.24, n: 7, peak: 2.9, paint: leaf([0.5, 1], { flutter: 0, tone: (t) => 0.3 + 0.5 * t }) });
    fan(b, { centre: [0, 0.3, 0], normal: [0, -1, 0], start: [1, 0, 0], r: 0.24, n: 7, peak: 0.2, paint: leaf([0.5, 1], { flutter: 0, shade: 0.7 }) });
  } else {
    stalk(0.6);
    blob(b, [0, 0.78, 0], [0.55, 0.2, 0.52], 'ico', 0.12, 2, leaf([0.5, 1], { flutter: 0, attach: [0, 0.6, 0] }));
  }
  return b.finish((p) => Math.max(0, p[1]) * Math.max(0, p[1]) * 0.6);
}

/** Triangles in a built geometry. */
export function triangles(g: THREE.BufferGeometry): number {
  return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
}
