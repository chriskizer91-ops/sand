/**
 * Plants from the patch layers (WP-F, ARCHITECTURE §6.6): stable placement, distance tiers,
 * the pop that makes watching trees appear a pleasure, gentle deaths, and wind sway.
 *
 * How it works, in four steps:
 *
 * 1. PLACEMENT (PlantField). Every 4 m patch has six fixed candidate spots: one canopy, two shrub,
 *    three herb. Each spot has a hashed position inside the patch and a hashed threshold. A spot
 *    shows a plant when its layer's cover reaches the threshold and hides only once cover falls
 *    0.05 below it, so plants never flicker and rising cover only ever ADDS plants. The plant is
 *    the layer's species; a new species in a layer means the old plants die and new ones pop.
 *    Spots are worked out per 64 m tile, only for tiles near the camera, only when that tile's
 *    life or ground data changed.
 *
 * 2. TIERS. Each tile gets a detail tier from its nearest point to the camera: under 60 m every
 *    layer at full detail (LOD0), 60-180 m canopy and shrubs as simple models (LOD1), 180-500 m
 *    canopy only as far blobs (LOD2), beyond that nothing (the ground tint carries it). Hard caps
 *    (instances and triangles per tier, phone-sized) are filled nearest-first in 16 m blocks; a
 *    block that doesn't fit drops to the next tier, so a crowded forest keeps a bubble of full
 *    detail around the camera.
 *
 * 3. INSTANCES. Plants are drawn as instances of one model per archetype and tier. Each instance
 *    is three vec4s: position + packed yaw/scale, life (birth, death, death kind, seed + dryness)
 *    and five packed species colours. Buffers are rebuilt at most four times a second, only when
 *    the selection or the plants changed, into reused typed arrays.
 *
 * 4. ANIMATION (vertex shader). The bulk meshes only sway and fade. A plant that pops (at most
 *    four a second, on screen, within 60 m: "watching trees pop up") or dies close by is also
 *    drawn on a small "animating" mesh whose shader runs the full sprout-unfurl-settle pop and
 *    the deaths (lava char and sink, storm topple leaving a log, palms losing fronds, wither,
 *    burial). Everything else fades in over 0.6 s. Nothing uses `discard` (Mali early-z):
 *    hidden things shrink to nothing instead.
 */
import * as THREE from 'three';
import { NP, ORIGIN_X, ORIGIN_Z, PATCH_M, SEA_LEVEL } from '../config';
import { Habitat, PLANT_MODEL_COUNT, PlantModel, type SpeciesDef } from '../content/speciesTypes';
import { hash2 } from '../engine/noise';
import { PLANT_BYTES, type FromEngine, type PondInfo, type StormState } from '../engine/protocol';
import type { WorldFields } from './fields';
import { ARCHETYPES, FAR_SHAPE_COUNT, StormFall, buildFarShape, buildPlant, triangles, type ArchetypeInfo, type FarShape } from './models/plants';
import { addWorldUniforms, type FrameCtx, type PageSystem, type Quality, type SystemDeps, type WorldUniforms } from './shared';

// ---------- layout ----------

/** Patches per vegetation tile side (a tile is 64 m) and per block side (16 m). */
const TILE_P = 16;
export const NT = NP / TILE_P;
const BLOCK_P = 4;
const BPT = TILE_P / BLOCK_P;
export const NB = NP / BLOCK_P;
/** Candidate spots per patch, and each layer's first slot and spot count (canopy 1, shrub 2, herb 3). */
export const SPOTS = 6;
export const LAYER_SLOT = [0, 1, 3] as const;
const LAYER_SPOTS = [1, 2, 3] as const;
/** A shown plant hides only when cover falls this far below its threshold. */
export const HIDE_MARGIN = 0.05;
/** Tier boundaries (m): LOD0 below the first, LOD1 below the second, LOD2 below the third. */
export const TIER_RANGE = [60, 180, 500] as const;
/** Tiles closer than this are worked out; further than UNTRACK they are forgotten. */
const TRACK_RANGE = 540;
const UNTRACK_RANGE = 600;
/** Tier boundaries need this much extra distance before a tile moves out a tier (no flapping). */
const TIER_HYSTERESIS = 6;
const POP_TIME = 1.5;
const FADE_TIME = 0.6;
const POPS_PER_SECOND = 4;
const POP_BURST = 2;
/** A birth waits at most this long for a pop slot before it simply fades in. */
const POP_WAIT = 0.75;
const POP_RANGE = 60;
const SHADOW_RANGE = 40;
const REBUILD_INTERVAL = 0.25;
/** Per-frame time for working out tiles (ms); at least one tile is always done. */
const EVAL_BUDGET_MS = 1.5;
/** Storm-felled trunks (logs) and bare palm trunks lie this long (s) before settling into the ground. */
const LOG_LINGER = 40;
/** Death kinds (the shader's iLife.z low bits). */
export const DeathKind = { None: 0, Wither: 1, Lava: 2, Storm: 3, Burial: 4 } as const;
export type DeathKind = (typeof DeathKind)[keyof typeof DeathKind];
/** How long each death plays before the instance is dropped (s). */
const DEATH_SPAN: readonly number[] = [0, 2.5, 3.1, LOG_LINGER + 3.2, 1.9];
/** "Not dying": a death time far in the future (the shader tests uNow >= death). */
const NEVER = 1e7;

/** Floats per record in a tile's plant list: x, y, z, yawScale, seedDry, spot, species, layer. */
const REC = 8;
/** Floats per dying plant: x, y, z, yawScale, seedDry, birth, death, kind, species, layer, model, variant. */
const DEAD = 12;
/** Floats per instance: iPos (4), iLife (4), iCol (4). */
const INST = 12;

// ---------- spot hashing (pure, deterministic) ----------

function slotLayer(slot: number): 0 | 1 | 2 {
  return slot === 0 ? 0 : slot < 3 ? 1 : 2;
}

/** A 0..1 hash for spot (patch p, slot) and property k. */
function spotHash(p: number, slot: number, k: number): number {
  return hash2(p, slot * 8 + k, 0x7e9e7);
}

/**
 * The cover a spot needs before it shows a plant. Spots in a layer split 0..1 into equal bands
 * (one hashed value per band), so cover 0.34 shows about one herb in every patch, evenly spread.
 */
export function spotThreshold(p: number, slot: number): number {
  const L = slotLayer(slot);
  const i = slot - LAYER_SLOT[L];
  return 0.04 + (0.92 * (i + spotHash(p, slot, 0))) / LAYER_SPOTS[L];
}

/** Should a spot show a plant? Shown plants keep showing until cover drops HIDE_MARGIN below. */
export function spotWanted(cover: number, threshold: number, shown: boolean): boolean {
  return shown ? cover >= threshold - HIDE_MARGIN : cover >= threshold;
}

/** World x of a spot (somewhere inside its 4 m patch, away from the edges). */
export function spotX(p: number, slot: number): number {
  return ORIGIN_X + (p % NP) * PATCH_M + 0.35 + 3.3 * spotHash(p, slot, 1);
}

/** World z of a spot. */
export function spotZ(p: number, slot: number): number {
  return ORIGIN_Z + ((p / NP) | 0) * PATCH_M + 0.35 + 3.3 * spotHash(p, slot, 2);
}

/**
 * Detail tier (0, 1, 2, or 3 = not drawn) for a distance. A tile already in a nearer tier keeps
 * it until it is TIER_HYSTERESIS beyond the boundary.
 */
export function tierOf(dist: number, prev = 3): number {
  for (let t = 0; t < 3; t++) {
    const edge = TIER_RANGE[t] + (prev <= t ? TIER_HYSTERESIS : 0);
    if (dist < edge) return t;
  }
  return 3;
}

/** Pack yaw (radians) and scale into one float: integer part scale * 128, fraction the yaw turn. */
export function packYawScale(yaw: number, scale: number): number {
  const turn = (((yaw / (Math.PI * 2)) % 1) + 1) % 1;
  return Math.max(1, Math.round(scale * 128)) + Math.min(turn, 0.999);
}

/** Pack seed (0..1) and dryness (0..1) into one float: integer part dryness * 15, fraction seed. */
export function packSeedDry(seed: number, dry: number): number {
  return Math.round(Math.max(0, Math.min(1, dry)) * 15) + Math.min(Math.max(seed, 0), 0.999);
}

/**
 * Five sRGB colours (leaf, leaf2, trunk, flower, fruit) at 6 bits a channel, four channels per
 * float (24 bits, exact in a float). The shader unpacks them with floor/mod.
 */
export function packColours(cols: readonly [number, number, number, number, number], out: Float32Array, o: number): void {
  const ch: number[] = [];
  for (const c of cols) ch.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
  ch.push(0);
  for (let k = 0; k < 4; k++) {
    let f = 0;
    for (let j = 3; j >= 0; j--) f = f * 64 + Math.round((ch[k * 4 + j] / 255) * 63);
    out[o + k] = f;
  }
}

// ---------- caps ----------

export interface VegCaps {
  /** Instances per tier (LOD0, LOD1, LOD2). */
  count: [number, number, number];
  /** Triangles per tier. */
  tris: [number, number, number];
}

/**
 * Hard caps. Phone numbers are the architecture's (LOD0 600, LOD1 2,500, LOD2 4,000 instances;
 * plants 120k triangles of the main pass, split 45/35/20 between tiers), scaled by quality.density.
 * Laptops get 1.6 times as much.
 */
export function capsFor(q: Pick<Quality, 'phone' | 'density' | 'tier'>): VegCaps {
  const k = q.density * (q.phone ? 1 : 1.6) * (q.tier === 0 ? 0.7 : 1);
  const tri = 120000 * k;
  return {
    count: [Math.round(600 * k), Math.round(2500 * k), Math.round(4000 * k)],
    tris: [tri * 0.45, tri * 0.35, tri * 0.2],
  };
}

/**
 * Give each candidate block a tier, nearest first. `order` lists block ids by distance; `tier`
 * is each block's tile tier; `cnt`/`tri` hold, per block, the instances and triangles it would
 * cost at LOD0, LOD1, LOD2 (3 values per block). Once a tier's caps are reached it closes, and
 * later blocks fall to the next tier. Writes 0, 1, 2 or 3 (not drawn) into `out[block]`.
 */
export function assignLods(order: ArrayLike<number>, n: number, tier: ArrayLike<number>, cnt: ArrayLike<number>, tri: ArrayLike<number>, caps: VegCaps, out: Uint8Array): void {
  const used = [0, 0, 0];
  const usedTri = [0, 0, 0];
  const open = [true, true, true];
  for (let i = 0; i < n; i++) {
    const b = order[i];
    let lod = 3;
    for (let t = tier[b]; t < 3 && lod === 3; t++) {
      if (!open[t]) continue;
      const c = cnt[b * 3 + t];
      const tr = tri[b * 3 + t];
      if (c === 0) continue;
      if (used[t] + c <= caps.count[t] && usedTri[t] + tr <= caps.tris[t]) {
        used[t] += c;
        usedTri[t] += tr;
        lod = t;
      } else {
        open[t] = false;
      }
    }
    out[b] = lod;
  }
}

// ---------- species table ----------

/** What the vegetation needs to know about each species, in flat arrays. */
export class SpeciesTable {
  readonly n: number;
  /** Plant model per species (-1: no model: animals and ground tints). */
  readonly model: Int8Array;
  readonly marine: Uint8Array;
  readonly size: Float32Array;
  /** Four packed colour floats per species. */
  readonly colours: Float32Array;

  constructor(species: readonly SpeciesDef[]) {
    this.n = species.length;
    this.model = new Int8Array(this.n).fill(-1);
    this.marine = new Uint8Array(this.n);
    this.size = new Float32Array(this.n).fill(1);
    this.colours = new Float32Array(this.n * 4);
    for (const s of species) {
      const look = s.plant;
      if (!look || look.model === PlantModel.Tint || look.model < 0 || look.model >= PLANT_MODEL_COUNT) continue;
      const a = ARCHETYPES[look.model];
      this.model[s.id] = look.model;
      this.marine[s.id] = s.marine ? 1 : 0;
      this.size[s.id] = look.size > 0 ? look.size : 1;
      const leaf2 = look.leaf2 ?? lighten(look.leaf);
      packColours([look.leaf, leaf2, look.trunk ?? a.trunk, look.flower ?? a.flower, look.fruit ?? a.fruit], this.colours, s.id * 4);
    }
  }
}

/** A lighter, warmer version of a leaf colour (for species without a second leaf colour). */
function lighten(hex: number): number {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  const f = (c: number, k: number) => Math.min(255, Math.round(c + (255 - c) * k));
  return (f(r, 0.3) << 16) | (f(g, 0.3) << 8) | f(b, 0.12);
}

// ---------- placement and life (no graphics) ----------

/** The parts of WorldFields placement reads (WorldFields itself satisfies it). */
export type FieldsView = Pick<WorldFields, 'plants' | 'habitat' | 'coverB' | 'heightAt' | 'lavaAt'>;

/** Triangles per archetype at LOD0 and LOD1 (2 per model) and per far shape: the triangle caps use them. */
export interface ModelTris {
  lod: Float32Array;
  far: Float32Array;
}

/** A plant died near enough to be worth a few motes. */
export interface DeathEvent {
  kind: DeathKind;
  x: number;
  y: number;
  z: number;
  /** Plant height (m). */
  h: number;
  /** Direction the wind blows to (radians), for leaves torn off by storms. */
  dir: number;
}

/** Live conditions that decide where plants can stand and how they die. */
export interface FieldConditions {
  now: number;
  storm: StormState;
  ponds: readonly PondInfo[] | null;
  /** Direction the wind blows TO (radians in the x-z plane). */
  windAngle: number;
}

/** The canopy plant of the patch being worked out, for epiphytes perching in it. */
const Host = { None: 0, Alive: 1, Died: 2 } as const;

/**
 * The plants that exist: which spots show which species, since when, and the dying ones.
 * Pure data and rules (no three.js), so it is tested directly.
 */
export class PlantField {
  // per spot (NP * NP * SPOTS)
  /** Shown species + 1 (0 = empty). */
  readonly sp = new Int16Array(NP * NP * SPOTS);
  /** Birth on the vegetation clock; NaN = born but still waiting for its pop-or-fade decision. */
  readonly birth = new Float32Array(NP * NP * SPOTS);
  /** 1 = this plant plays the full pop. */
  readonly pop = new Uint8Array(NP * NP * SPOTS);
  /** Base height. Ground that rises around a plant buries it rather than lifting it. */
  readonly baseY = new Float32Array(NP * NP * SPOTS);

  // per tile
  readonly tracked = new Uint8Array(NT * NT);
  readonly dirty = new Uint8Array(NT * NT);
  /** The ground or ponds changed in the tile (not just life). */
  readonly groundDirty = new Uint8Array(NT * NT);
  readonly evaluated = new Uint8Array(NT * NT);
  readonly tier = new Uint8Array(NT * NT).fill(3);
  readonly tileDist = new Float32Array(NT * NT);
  /** Records per tile (REC floats each), in block order. */
  readonly recs: Float32Array[] = [];
  readonly recN = new Int32Array(NT * NT);
  /** Record index where each of the 16 blocks starts (17 per tile). */
  readonly blockStart = new Int32Array(NT * NT * 17);
  readonly tileY0 = new Float32Array(NT * NT).fill(-30);
  readonly tileY1 = new Float32Array(NT * NT).fill(120);

  // per block (NB * NB)
  /** Instances and triangles a block costs at LOD0, LOD1, LOD2. */
  readonly bCnt = new Int32Array(NB * NB * 3);
  readonly bTri = new Float32Array(NB * NB * 3);
  readonly bY0 = new Float32Array(NB * NB);
  readonly bY1 = new Float32Array(NB * NB);

  /** Births waiting for a pop-or-fade decision: spot ids and when they were born. */
  pend = new Int32Array(256);
  pendT = new Float32Array(256);
  pendN = 0;

  /** Dying plants (DEAD floats each). */
  dead = new Float32Array(64 * DEAD);
  deadN = 0;

  /** Deaths since the system last took them (for motes). */
  readonly events: DeathEvent[] = [];
  /** Bumped whenever the set of drawn plants or their data changed. */
  version = 0;

  private ponds: readonly PondInfo[] | null = null;
  // Where the plant being placed stands (scratch, so the hot loop allocates nothing).
  private px = 0;
  private py = 0;
  private pz = 0;
  // The current patch's canopy plant, for epiphytes.
  private host: number = Host.None;
  private hostX = 0;
  private hostY = 0;
  private hostZ = 0;
  private hostScale = 1;
  private hostYaw = 0;
  private hostModel = 0;

  constructor(
    readonly fields: FieldsView,
    readonly table: SpeciesTable,
    private readonly tris: ModelTris,
  ) {
    for (let t = 0; t < NT * NT; t++) this.recs.push(new Float32Array(64 * REC));
  }

  /** Forget everything (a new world was loaded). */
  reset(): void {
    this.sp.fill(0);
    this.pop.fill(0);
    this.evaluated.fill(0);
    this.recN.fill(0);
    this.blockStart.fill(0);
    this.bCnt.fill(0);
    this.bTri.fill(0);
    this.tier.fill(3);
    this.pendN = 0;
    this.deadN = 0;
    this.events.length = 0;
    for (let t = 0; t < NT * NT; t++) if (this.tracked[t]) this.dirty[t] = 1;
    this.version++;
  }

  /**
   * Mark the tiles under a patch rectangle as needing another look. `ground` says the ground (or a
   * pond) changed too, so every plant's footing is checked again; life-only changes skip that for
   * plants that simply stay.
   */
  markPatches(x0: number, z0: number, w: number, h: number, ground: boolean): void {
    const tx0 = Math.max(0, Math.floor(x0 / TILE_P));
    const tz0 = Math.max(0, Math.floor(z0 / TILE_P));
    const tx1 = Math.min(NT - 1, Math.floor((x0 + w - 1) / TILE_P));
    const tz1 = Math.min(NT - 1, Math.floor((z0 + h - 1) / TILE_P));
    for (let tz = tz0; tz <= tz1; tz++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        this.dirty[tx + tz * NT] = 1;
        if (ground) this.groundDirty[tx + tz * NT] = 1;
      }
    }
  }

  /**
   * Update which tiles are worked out and their tiers, from the camera position.
   * Returns true if any tier changed.
   */
  track(cx: number, cy: number, cz: number): boolean {
    let changed = false;
    const size = TILE_P * PATCH_M;
    for (let tz = 0; tz < NT; tz++) {
      for (let tx = 0; tx < NT; tx++) {
        const t = tx + tz * NT;
        const x0 = ORIGIN_X + tx * size;
        const z0 = ORIGIN_Z + tz * size;
        const dx = cx < x0 ? x0 - cx : cx > x0 + size ? cx - x0 - size : 0;
        const dz = cz < z0 ? z0 - cz : cz > z0 + size ? cz - z0 - size : 0;
        const dy = cy < this.tileY0[t] ? this.tileY0[t] - cy : cy > this.tileY1[t] ? cy - this.tileY1[t] : 0;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this.tileDist[t] = d;
        if (!this.tracked[t] && d < TRACK_RANGE) {
          this.tracked[t] = 1;
          this.dirty[t] = 1;
        } else if (this.tracked[t] && d > UNTRACK_RANGE) {
          this.untrack(t);
          changed = true;
        }
        const tier = this.tracked[t] && this.evaluated[t] ? tierOf(d, this.tier[t]) : 3;
        if (tier !== this.tier[t]) {
          this.tier[t] = tier;
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Drop a far tile's plants without any death animation (nobody can see them). */
  private untrack(t: number): void {
    this.tracked[t] = 0;
    this.dirty[t] = 0;
    this.evaluated[t] = 0;
    this.recN[t] = 0;
    this.blockStart.fill(0, t * 17, t * 17 + 17);
    this.tier[t] = 3;
    const tx = t % NT;
    const tz = (t / NT) | 0;
    for (let pz = 0; pz < TILE_P; pz++) {
      const p0 = tx * TILE_P + (tz * TILE_P + pz) * NP;
      this.sp.fill(0, p0 * SPOTS, (p0 + TILE_P) * SPOTS);
    }
    for (let bz = 0; bz < BPT; bz++) {
      for (let bx = 0; bx < BPT; bx++) {
        const gb = tx * BPT + bx + (tz * BPT + bz) * NB;
        this.bCnt.fill(0, gb * 3, gb * 3 + 3);
        this.bTri.fill(0, gb * 3, gb * 3 + 3);
      }
    }
    this.version++;
  }

  /** The next dirty tracked tile, nearest first (-1 if none). */
  nextDirty(): number {
    let best = -1;
    let bestD = Infinity;
    for (let t = 0; t < NT * NT; t++) {
      if (this.tracked[t] && this.dirty[t] && this.tileDist[t] < bestD) {
        bestD = this.tileDist[t];
        best = t;
      }
    }
    return best;
  }

  /** Work out every spot of a tile: births, deaths, positions. Returns true if anything changed. */
  evaluate(t: number, c: FieldConditions): boolean {
    this.dirty[t] = 0;
    // Plants found on a first look at a tile (the camera arrived, or a save loaded) were already
    // there: they count as having waited for a pop slot, so a few pop and the rest fade in at once.
    const firstLook = !this.evaluated[t];
    const footing = firstLook || this.groundDirty[t] === 1;
    this.groundDirty[t] = 0;
    let changed = firstLook;
    this.evaluated[t] = 1;
    this.ponds = c.ponds;
    const tx = t % NT;
    const tz = (t / NT) | 0;
    const plants = this.fields.plants;
    const triLod = this.tris.lod;
    let rec = this.recs[t];
    let n = 0;
    let ty0 = Infinity;
    let ty1 = -Infinity;
    for (let bz = 0; bz < BPT; bz++) {
      for (let bx = 0; bx < BPT; bx++) {
        const bi = bx + bz * BPT;
        const gb = tx * BPT + bx + (tz * BPT + bz) * NB;
        this.blockStart[t * 17 + bi] = n;
        let c0 = 0;
        let c1 = 0;
        let c2 = 0;
        let t0 = 0;
        let t1 = 0;
        let t2 = 0;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (let pz = 0; pz < BLOCK_P; pz++) {
          for (let px = 0; px < BLOCK_P; px++) {
            const p = tx * TILE_P + bx * BLOCK_P + px + (tz * TILE_P + bz * BLOCK_P + pz) * NP;
            this.host = Host.None;
            for (let L = 0; L < 3; L++) {
              const o = p * PLANT_BYTES + L * 2;
              const species = plants[o] - 1;
              const cover = plants[o + 1] / 255;
              const model = species >= 0 && species < this.table.n ? this.table.model[species] : -1;
              for (let k = 0; k < LAYER_SPOTS[L]; k++) {
                const slot = LAYER_SLOT[L] + k;
                const s = p * SPOTS + slot;
                const shown = this.sp[s] - 1;
                if (shown < 0 && (model <= 0 || cover <= 0)) continue;
                let want = model > 0 && spotWanted(cover, spotThreshold(p, slot), shown === species);
                if (want) {
                  if (!footing && shown === species && ARCHETYPES[model].placement !== 'canopy') {
                    // Same plant, same ground: it stays exactly where it stands.
                    this.px = spotX(p, slot);
                    this.pz = spotZ(p, slot);
                    this.py = this.baseY[s];
                  } else {
                    want = this.place(p, slot, species, model);
                  }
                }
                if (shown >= 0 && (!want || shown !== species)) {
                  this.kill(s, p, slot, shown, c);
                  changed = true;
                }
                if (!want) continue;
                const arch = ARCHETYPES[model];
                if (this.sp[s] === 0) {
                  this.sp[s] = species + 1;
                  this.birth[s] = NaN;
                  this.pop[s] = 0;
                  this.baseY[s] = this.py;
                  this.queueBirth(s, firstLook ? c.now - POP_WAIT - 1 : c.now);
                  changed = true;
                } else {
                  // Living plants ride down with the ground; ground that rises around them buries
                  // them instead (trees keep their crowns above new sand). Perched plants follow their host.
                  const b = this.baseY[s];
                  if (arch.placement === 'canopy' || this.py < b - 0.03 || (this.py > b && this.py < b + 0.15)) {
                    if (Math.abs(this.py - b) > 1e-3) changed = true;
                    this.baseY[s] = this.py;
                  }
                }
                if ((n + 1) * REC > rec.length) {
                  const bigger = new Float32Array(rec.length * 2);
                  bigger.set(rec);
                  rec = bigger;
                  this.recs[t] = rec;
                }
                const scale = this.plantScale(p, slot, species);
                const yaw = spotHash(p, slot, 3) * Math.PI * 2;
                const y = this.baseY[s];
                const o2 = n * REC;
                rec[o2] = this.px;
                rec[o2 + 1] = y;
                rec[o2 + 2] = this.pz;
                rec[o2 + 3] = packYawScale(yaw, scale);
                rec[o2 + 4] = packSeedDry(spotHash(p, slot, 5), 1 - this.fields.coverB[p * 4 + 2] / 255);
                rec[o2 + 5] = s;
                rec[o2 + 6] = species;
                rec[o2 + 7] = L;
                n++;
                if (slot === 0) this.setHost(Host.Alive, this.px, y, this.pz, scale, yaw, model);
                const top = y + arch.height * scale;
                if (y < y0) y0 = y;
                if (top > y1) y1 = top;
                c0++;
                t0 += triLod[model * 2];
                if (L < 2) {
                  c1++;
                  t1 += triLod[model * 2 + 1];
                }
                if (L === 0) {
                  c2++;
                  t2 += this.tris.far[arch.far];
                }
              }
            }
          }
        }
        this.bCnt[gb * 3] = c0;
        this.bCnt[gb * 3 + 1] = c1;
        this.bCnt[gb * 3 + 2] = c2;
        this.bTri[gb * 3] = t0;
        this.bTri[gb * 3 + 1] = t1;
        this.bTri[gb * 3 + 2] = t2;
        this.bY0[gb] = y0 === Infinity ? 0 : y0;
        this.bY1[gb] = y1 === -Infinity ? 0 : y1;
        if (y0 < ty0) ty0 = y0;
        if (y1 > ty1) ty1 = y1;
      }
    }
    this.blockStart[t * 17 + 16] = n;
    if (n !== this.recN[t]) changed = true;
    this.recN[t] = n;
    this.tileY0[t] = ty0 === Infinity ? -30 : ty0;
    this.tileY1[t] = ty1 === -Infinity ? 0 : ty1;
    // A tile seen for the first time gets its tier now, so its first births can pop this round.
    if (this.tracked[t]) this.tier[t] = tierOf(this.tileDist[t], this.tier[t]);
    if (changed) this.version++;
    return changed;
  }

  /** A plant's size: the species' size, a little per-plant variety, and the oldest spots (lowest threshold) a bit bigger. */
  plantScale(p: number, slot: number, species: number): number {
    return this.table.size[species] * (0.82 + 0.36 * spotHash(p, slot, 4)) * (1.1 - 0.2 * spotThreshold(p, slot));
  }

  private setHost(state: number, x: number, y: number, z: number, scale: number, yaw: number, model: number): void {
    this.host = state;
    this.hostX = x;
    this.hostY = y;
    this.hostZ = z;
    this.hostScale = scale;
    this.hostYaw = yaw;
    this.hostModel = model;
  }

  /**
   * Can this spot hold this plant right now? Sets px, py, pz to where it stands.
   * Rules: never on molten lava; sea plants only under water; mangroves at the waterline; lilies
   * only floating on ponds; sedges also in shallow pond water; land plants above the sea and out
   * of ponds; epiphytes perch in the crown of the patch's own (living) canopy plant.
   */
  private place(p: number, slot: number, species: number, model: number): boolean {
    const f = this.fields;
    const arch = ARCHETYPES[model];
    if (arch.placement === 'canopy') return this.host === Host.Alive && this.perch(p, slot);
    const x = spotX(p, slot);
    const z = spotZ(p, slot);
    this.px = x;
    this.pz = z;
    const hab = f.habitat[p];
    if (hab === Habitat.HotLava || f.lavaAt(x, z) > 0.03) return false;
    const h = f.heightAt(x, z);
    if (this.table.marine[species] || arch.placement === 'sea') {
      this.py = h - 0.02;
      return h < SEA_LEVEL - 0.4 && h > -26;
    }
    if (arch.placement === 'shore') {
      this.py = h - 0.05;
      return h > -1.6 && h < 1.2;
    }
    const pond = this.ponds ? pondLevel(this.ponds, x, z) : NaN;
    if (arch.placement === 'pond') {
      this.py = pond + 0.005;
      return pond > h + 0.1;
    }
    if (arch.placement === 'wet' && pond > h && pond < h + 0.6) {
      this.py = h - 0.02;
      return true;
    }
    if (h < SEA_LEVEL + 0.15 || hab === Habitat.Pond || hab === Habitat.SaltPond || pond > h + 0.05) return false;
    if (arch.limit > 60) {
      // Trees stand on the lowest ground under their trunk, so roots never float on a slope.
      const r = 0.6;
      this.py = Math.min(h, f.heightAt(x + r, z), f.heightAt(x - r, z), f.heightAt(x, z + r), f.heightAt(x, z - r)) - 0.12;
    } else {
      this.py = h - 0.03;
    }
    return true;
  }

  /** Where an epiphyte perches in the current host's crown (sets px, py, pz). False without a host. */
  private perch(p: number, slot: number): boolean {
    if (this.host === Host.None) return false;
    const host = ARCHETYPES[this.hostModel];
    if (host.placement !== 'land' && host.placement !== 'shore') return false;
    const a = spotHash(p, slot, 6) * Math.PI * 2;
    const reach = host.crownR * this.hostScale * (0.55 + 0.4 * spotHash(p, slot, 7));
    const lx = Math.cos(a) * reach;
    const lz = Math.sin(a) * reach;
    const c = Math.cos(this.hostYaw);
    const s = Math.sin(this.hostYaw);
    this.px = this.hostX + c * lx + s * lz;
    this.pz = this.hostZ - s * lx + c * lz;
    this.py = this.hostY + host.crownY * this.hostScale * (0.85 + 0.12 * spotHash(p, slot, 8));
    return true;
  }

  private queueBirth(s: number, now: number): void {
    if (this.pendN >= this.pend.length) {
      const a = new Int32Array(this.pend.length * 2);
      a.set(this.pend);
      this.pend = a;
      const b = new Float32Array(this.pendT.length * 2);
      b.set(this.pendT);
      this.pendT = b;
    }
    this.pend[this.pendN] = s;
    this.pendT[this.pendN] = now;
    this.pendN++;
  }

  /** Why a plant is dying: molten lava under it, ground risen around it, a storm, or (otherwise) withering. */
  deathKind(s: number, p: number, model: number, x: number, z: number, scale: number, storm: StormState): DeathKind {
    const f = this.fields;
    if (f.habitat[p] === Habitat.HotLava || f.lavaAt(x, z) > 0.03) return DeathKind.Lava;
    const arch = ARCHETYPES[model];
    if (arch.placement !== 'canopy' && f.heightAt(x, z) - this.baseY[s] > Math.max(0.25, 0.3 * arch.height * scale)) return DeathKind.Burial;
    // Storms fell and flatten land plants; under water and on ponds things just fade.
    if (storm.phase !== 'none' && storm.level > 0.25 && arch.placement !== 'sea' && arch.placement !== 'pond') return DeathKind.Storm;
    return DeathKind.Wither;
  }

  /** A shown plant dies: it joins the dying list (unless it was never seen) and its spot empties. */
  private kill(s: number, p: number, slot: number, species: number, c: FieldConditions): void {
    this.sp[s] = 0;
    const model = this.table.model[species];
    if (model <= 0) return;
    const arch = ARCHETYPES[model];
    const scale = this.plantScale(p, slot, species);
    const yaw = spotHash(p, slot, 3) * Math.PI * 2;
    // Where it stands. Epiphytes are found in their host's crown (keep the placement scratch intact).
    const sx = this.px;
    const sy = this.py;
    const sz = this.pz;
    let x = spotX(p, slot);
    let z = spotZ(p, slot);
    let y = this.baseY[s];
    if (arch.placement === 'canopy' && this.perch(p, slot)) {
      x = this.px;
      y = this.py;
      z = this.pz;
    }
    this.px = sx;
    this.py = sy;
    this.pz = sz;
    if (slot === 0) this.setHost(Host.Died, x, y, z, scale, yaw, model);
    const born = this.birth[s];
    if (Number.isNaN(born)) return; // it never showed
    const kind = this.deathKind(s, p, model, x, z, scale, c.storm);
    if ((this.deadN + 1) * DEAD > this.dead.length) {
      const d = new Float32Array(this.dead.length * 2);
      d.set(this.dead);
      this.dead = d;
    }
    const seed = spotHash(p, slot, 5);
    const dirIdx = ((Math.round((c.windAngle / (Math.PI * 2)) * 64) % 64) + 64) % 64;
    const o = this.deadN * DEAD;
    this.dead[o] = x;
    this.dead[o + 1] = y;
    this.dead[o + 2] = z;
    this.dead[o + 3] = packYawScale(yaw, scale);
    this.dead[o + 4] = packSeedDry(seed, 1 - this.fields.coverB[p * 4 + 2] / 255);
    this.dead[o + 5] = born;
    this.dead[o + 6] = c.now;
    this.dead[o + 7] = kind + 16 * dirIdx;
    this.dead[o + 8] = species;
    this.dead[o + 9] = slotLayer(slot);
    this.dead[o + 10] = model;
    // The same variant the living plant drew (it read its seed back from a float32 record).
    const sd = this.dead[o + 4];
    this.dead[o + 11] = variantOf(arch, sd - Math.floor(sd));
    this.deadN++;
    this.events.push({ kind, x, y, z, h: arch.height * scale, dir: c.windAngle });
  }

  /** Drop dying plants whose animation is over. Returns true if any were dropped. */
  expireDead(now: number): boolean {
    let w = 0;
    for (let i = 0; i < this.deadN; i++) {
      const o = i * DEAD;
      const kind = this.dead[o + 7] % 16;
      if (now - this.dead[o + 6] > DEATH_SPAN[kind]) continue;
      if (w !== i) this.dead.copyWithin(w * DEAD, o, o + DEAD);
      w++;
    }
    const changed = w !== this.deadN;
    this.deadN = w;
    if (changed) this.version++;
    return changed;
  }

  /** Shift every stored time back by dt seconds (keeps float32 times precise in long sessions). */
  rebase(dt: number): void {
    for (let i = 0; i < this.birth.length; i++) this.birth[i] -= dt;
    for (let i = 0; i < this.pendN; i++) this.pendT[i] -= dt;
    for (let i = 0; i < this.deadN; i++) {
      this.dead[i * DEAD + 5] -= dt;
      this.dead[i * DEAD + 6] -= dt;
    }
    this.version++;
  }
}

/** Which shape variant (coral heads) a plant uses, from its seed. */
function variantOf(arch: ArchetypeInfo, seed: number): number {
  return arch.variants <= 1 ? 0 : Math.min(arch.variants - 1, Math.floor(((seed * 7.77) % 1) * arch.variants));
}

function pondLevel(ponds: readonly PondInfo[], x: number, z: number): number {
  for (const p of ponds) if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) return p.level;
  return NaN;
}

/** Every plant model, built once at load, with the triangle counts the caps need. */
export interface PlantModels {
  /** [model][variant] at LOD0 and LOD1 (empty lists for Tint). */
  lod0: THREE.BufferGeometry[][];
  lod1: THREE.BufferGeometry[][];
  /** Per far shape. */
  far: THREE.BufferGeometry[];
  tris: ModelTris;
}

/** Build every archetype (LOD0 and LOD1, all variants) and the far shapes, and count triangles. */
export function buildModels(): PlantModels {
  const out: PlantModels = { lod0: [], lod1: [], far: [], tris: { lod: new Float32Array(PLANT_MODEL_COUNT * 2), far: new Float32Array(FAR_SHAPE_COUNT) } };
  for (const a of ARCHETYPES) {
    out.lod0[a.model] = [];
    out.lod1[a.model] = [];
    if (a.model === PlantModel.Tint) continue;
    for (let v = 0; v < a.variants; v++) {
      const g0 = buildPlant(a.model, 0, v);
      const g1 = buildPlant(a.model, 1, v);
      out.lod0[a.model].push(g0);
      out.lod1[a.model].push(g1);
      // A block's cost uses the largest variant.
      out.tris.lod[a.model * 2] = Math.max(out.tris.lod[a.model * 2], triangles(g0));
      out.tris.lod[a.model * 2 + 1] = Math.max(out.tris.lod[a.model * 2 + 1], triangles(g1));
    }
  }
  for (let s = 0; s < FAR_SHAPE_COUNT; s++) {
    const g = buildFarShape(s as FarShape);
    out.far.push(g);
    out.tris.far[s] = triangles(g);
  }
  return out;
}

// ---------- shaders ----------

/** Angular frequency with a whole number of cycles in uTime's 3600 s wrap (no hourly jump). */
function freq(cyclesPerHour: number): string {
  return ((2 * Math.PI * cyclesPerHour) / 3600).toFixed(6);
}

const PLANT_GLSL = /* glsl */ `
attribute vec4 aPlant;
attribute vec3 aAttach;
attribute vec4 iPos;
attribute vec4 iLife;
attribute vec4 iCol;
uniform float uTime;
uniform vec4 uWind;
uniform float uStorm;
uniform float uDry;
uniform vec4 uLavaGlow;
uniform vec3 uCamPos;
uniform float uNow;
uniform vec4 uArch;   // height (m), unfurl style, dry-season response, underwater surge
uniform vec4 uArch2;  // share in flower, storm fall style, far fade-out distance (0 = none)
#ifndef PLANT_DEPTH
varying vec3 vEmit;
#endif

vec3 vegRotY(vec3 v, float c, float s) { return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 vegRot(vec3 v, vec3 k, float a) { float c = cos(a); float s = sin(a); return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c); }
vec4 vegUnpack(float f) {
  float a = mod(f, 64.0); f = floor(f / 64.0);
  float b = mod(f, 64.0); f = floor(f / 64.0);
  float c = mod(f, 64.0); f = floor(f / 64.0);
  return vec4(a, b, c, f) / 63.0;
}
vec3 vegLinear(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
float vegBack(float t) { float u = t - 1.0; return 1.0 + 2.70158 * u * u * u + 1.70158 * u * u; }

void plantVertex(out vec3 wp, out vec3 wn, out vec3 col, out vec3 emit) {
  float sc = floor(iPos.w) / 128.0;
  float yaw = fract(iPos.w) * 6.2831853;
  float cy = cos(yaw);
  float sy = sin(yaw);
  float kind = mod(iLife.z, 8.0);
  float popF = mod(floor(iLife.z / 8.0), 2.0);
  float fallA = floor(iLife.z / 16.0) * 0.09817477;
  float seed = fract(iLife.w);
  float dryness = floor(iLife.w) / 15.0;
  float sway = aPlant.x;
  float flutter = aPlant.y;
  float grow = aPlant.z;
  float part = floor(aPlant.w + 0.001);
  float tone = min(fract(aPlant.w + 0.001) / 0.98, 1.0);
  float H = uArch.x;
  float age = uNow - iLife.x;
  float dAge = uNow - iLife.y;
  float dying = step(0.0, dAge);
  vec3 p = position;
  vec3 a = aAttach;
  vec3 n = normal;
  float vis = 1.0;
  float fall = 0.0;
  float sink = 0.0;
  float blow = 0.0;
  float strawK = 0.0;
  float charK = 0.0;
  float ember = 0.0;
  // Only some plants are in flower at any time.
  if (part > 1.5 && part < 2.5 && fract(seed * 7.31) > uArch2.x) p = a;
#ifdef PLANT_ANIM
  if (dying < 0.5) {
    // The pop: sprout up from the ground (ease-out-back), revealed bottom-up by grow; leaves
    // unfurl from where they join (fern fiddleheads uncurl, palms open like an umbrella),
    // flowers open last; then two small settling wobbles.
    float settle = max(age - 0.55, 0.0);
    float wob = exp(-settle * 4.0) * sin(settle * 13.0) * (1.0 - smoothstep(1.2, 1.5, age));
    float hs = vegBack(clamp(age / 0.55, 0.0, 1.0)) + 0.07 * wob;
    float wsx = mix(0.35, 1.0, smoothstep(0.05, 0.9, age)) - 0.05 * wob;
    float rv = smoothstep(grow * 0.55, grow * 0.55 + 0.3, age / 0.95);
    vec3 off = (p - a) * rv;
    if (part > 0.5) {
      float u = smoothstep(0.3 + 0.3 * grow, 1.1 + 0.15 * grow, age);
      if (part > 1.5) {
        float fu = smoothstep(0.85, 1.35, age);
        float tw = (1.0 - fu) * 0.35;
        off = vegRotY(off, cos(tw), sin(tw)) * fu;
      } else if (uArch.y > 1.5) {
        float L = length(off);
        vec3 spear = vec3(off.x * 0.1, L, off.z * 0.1);
        off = normalize(mix(spear, off, u) + vec3(0.0, 1e-4, 0.0)) * L;
      } else if (uArch.y > 0.5) {
        float L = length(off);
        float rl = length(off.xz);
        vec3 rh = rl > 1e-4 ? vec3(off.x / rl, 0.0, off.z / rl) : vec3(1.0, 0.0, 0.0);
        float k = max((1.0 - u) * 10.0 / max(H, 0.2), 1e-3);
        vec3 curl = rh * (sin(k * L) / k) + vec3(0.0, (1.0 - cos(k * L)) / k, 0.0);
        off = mix(curl, off, u);
      } else {
        off *= mix(0.15, 1.0, u);
      }
    }
    p = a + off;
    p.y *= hs;
    p.xz *= wsx;
    vis = 1.0 - step(${POP_TIME.toFixed(2)}, age);
  } else {
    vec3 off = p - a;
    if (kind < 1.5) {
      // Wither: straw, droop, shrink away.
      strawK = smoothstep(0.0, 1.3, dAge);
      if (part > 0.5) { off *= mix(1.0, 0.45, strawK); off.y -= strawK * 0.35 * length(off); }
      vis = 1.0 - smoothstep(1.5, 2.4, dAge);
      sink = 0.15 * smoothstep(0.8, 2.4, dAge);
    } else if (kind < 2.5) {
      // Lava: char black with an ember rim, leaves curl, then the plant sinks into the flow.
      charK = smoothstep(0.0, 0.8, dAge);
      ember = (1.0 - smoothstep(1.4, 2.8, dAge)) * smoothstep(0.0, 0.3, dAge);
      if (part > 0.5) off *= mix(1.0, 0.3, smoothstep(0.3, 2.2, dAge));
      float sk = clamp((dAge - 0.9) / 2.0, 0.0, 1.0);
      sink = sk * sk * 1.05;
      vis = 1.0 - step(3.0, dAge);
    } else if (kind < 3.5) {
      if (uArch2.y < 0.5) {
        // Storm topple: pivot at the base across the wind, a bounce, the crown fades, the log stays.
        float t = clamp(dAge / 0.9, 0.0, 1.0);
        float st = max(dAge - 0.9, 0.0);
        fall = 1.4708 * t * t - 0.15 * exp(-st * 5.0) * sin(st * 14.0) * step(0.9, dAge);
        strawK = smoothstep(1.2, 2.6, dAge) * 0.6;
        if (part > 0.5) off *= 1.0 - smoothstep(1.3, 2.6, dAge);
      } else if (uArch2.y < 1.5) {
        // Palms lose their fronds to the wind instead; the bare trunk stands on.
        blow = smoothstep(0.0, 1.6, dAge);
        if (part > 0.5) off *= 1.0 - smoothstep(0.6, 1.6, dAge);
      } else {
        // Small plants are flattened downwind and wither.
        fall = 1.25 * smoothstep(0.0, 0.6, dAge);
        strawK = smoothstep(0.5, 1.5, dAge);
        vis = 1.0 - smoothstep(1.2, 2.0, dAge);
      }
      sink = max(sink, smoothstep(${LOG_LINGER.toFixed(1)}, ${(LOG_LINGER + 3).toFixed(1)}, dAge) * 0.6);
      vis *= 1.0 - step(${(LOG_LINGER + 3).toFixed(1)}, dAge);
    } else {
      // Burial: the plant sinks into the new ground.
      sink = smoothstep(0.0, 1.6, dAge) * 1.1;
      vis = 1.0 - step(1.8, dAge);
    }
    p = a + off;
  }
#else
  // Bulk: a popping plant waits for the animating mesh to finish; others fade in; far deaths shrink away.
  vis = popF > 0.5 ? step(${POP_TIME.toFixed(2)}, age) : smoothstep(0.0, ${FADE_TIME.toFixed(2)}, age);
  vis *= 1.0 - dying * smoothstep(0.0, ${FADE_TIME.toFixed(2)}, dAge);
  // Far blobs thin out smoothly toward the edge of their range (no hard tile edge).
  if (uArch2.z > 0.0) vis *= 1.0 - smoothstep(uArch2.z - 80.0, uArch2.z, distance(iPos.xyz, uCamPos));
#endif
  float s = sc * vis;
  vec3 wpos = vegRotY(p * s, cy, sy);
  wn = vegRotY(n, cy, sy);
  float hsc = H * sc;

  // Wind: a slow bend of the whole plant (gusts travel across the island), a branch sway and a
  // fast leaf flutter. Under water: the slow back-and-forth surge instead.
  float wl = length(uWind.xy);
  vec2 wdir = wl > 1e-4 ? uWind.xy / wl : vec2(-1.0, 0.0);
  float ws = clamp(max(wl, uStorm), 0.0, 1.0);
  float ph = seed * 6.2831853 + dot(iPos.xz, wdir) * 0.07;
  float gust = (0.55 + 0.45 * sin(uTime * ${freq(344)} - ph) * sin(uTime * ${freq(120)} - ph * 0.4)) * (0.75 + 0.5 * uWind.z);
  vec3 swayOff;
  if (uArch.w > 0.5) {
    float surge = sin(uTime * ${freq(229)} + ph) * (0.6 + 0.8 * uStorm);
    swayOff = vec3(wdir.x, 0.0, wdir.y) * (sway * hsc * 0.16 * surge);
  } else {
    float bend = sway * hsc * (ws * gust * 0.12 + 0.025 * sin(uTime * ${freq(458)} + ph));
    float bp = dot(aAttach, vec3(3.1, 1.7, 2.3)) + seed * 17.0;
    float branch = sway * hsc * 0.02 * (0.3 + ws) * sin(uTime * ${freq(630)} + bp);
    swayOff = vec3(wdir.x, 0.0, wdir.y) * (bend + branch);
    swayOff.y -= bend * bend / max(hsc, 0.3) * 0.5;
    swayOff += wn * (flutter * sc * 0.02 * (0.25 + 1.5 * ws) * sin(uTime * ${freq(4011)} + bp * 5.0 + position.x * 4.0));
  }
  wpos += swayOff * vis * (1.0 - min(fall * 2.0, 1.0));
#ifdef PLANT_ANIM
  if (fall != 0.0) {
    vec3 fd = vec3(cos(fallA), 0.0, sin(fallA));
    vec3 axis = vec3(fd.z, 0.0, -fd.x);
    wpos = vegRot(wpos, axis, fall);
    wn = vegRot(wn, axis, fall);
  }
  if (blow > 0.0 && part > 0.5) {
    vec3 fd = vec3(cos(fallA), 0.0, sin(fallA));
    float k = 0.6 + 0.8 * fract(dot(a, vec3(1.7, 3.1, 2.3)));
    wpos += (fd * (blow * blow * 6.0) + vec3(0.0, blow * 1.5 - blow * blow * 2.5, 0.0)) * (sc * k);
  }
  wpos.y -= sink * hsc;
#endif
  wp = iPos.xyz + wpos;
#ifdef PLANT_DEPTH
  col = vec3(0.0);
  emit = vec3(0.0);
#else
  vec4 c0 = vegUnpack(iCol.x);
  vec4 c1 = vegUnpack(iCol.y);
  vec4 c2 = vegUnpack(iCol.z);
  vec4 c3 = vegUnpack(iCol.w);
  vec3 cLeaf = c0.xyz;
  vec3 cLeaf2 = vec3(c0.w, c1.x, c1.y);
  vec3 cTrunk = vec3(c1.z, c1.w, c2.x);
  vec3 cFlower = vec3(c2.y, c2.z, c2.w);
  vec3 cFruit = c3.xyz;
  vec3 base = part < 0.5 ? mix(cTrunk, cLeaf2, tone) : part < 1.5 ? mix(cLeaf, cLeaf2, tone) : part < 2.5 ? cFlower : cFruit;
  col = part < 3.5 ? vegLinear(base) * color : color;
  // Each plant a touch different in shade and warmth.
  float j1 = fract(seed * 53.17) - 0.5;
  float j2 = fract(seed * 97.31) - 0.5;
  col *= (1.0 + 0.16 * j1) * vec3(1.0 + 0.08 * j2, 1.0, 1.0 - 0.08 * j2);
  // Dry season: leaves on dry ground go golden (grasses most). Withering goes to straw.
  float leafy = step(0.5, part) * step(part, 1.5);
  vec3 straw = mix(vec3(0.58, 0.45, 0.15), vec3(0.76, 0.65, 0.28), tone);
  col = mix(col, straw, clamp(uDry * dryness * uArch.z * 0.8 * leafy + strawK * (0.4 + 0.6 * leafy), 0.0, 1.0));
  // Storm wind flips leaves to their paler undersides.
  col *= 1.0 + 0.3 * flutter * uStorm * gust;
  col = mix(col, vec3(0.023, 0.018, 0.014), charK);
  float ld = length(wp.xz - uLavaGlow.xy);
  emit = vec3(1.0, 0.36, 0.08) * (uLavaGlow.w * 0.22 * exp(-max(ld - uLavaGlow.z, 0.0) * 0.08));
  // Embers: scattered glowing spots on the charred plant (some vertices glow, the rest stay black).
  float speck = fract(dot(position, vec3(7.13, 3.71, 5.29)) + seed * 3.0);
  emit += vec3(1.0, 0.36, 0.08) * ember * smoothstep(0.68, 0.97, speck) * (0.5 + 0.5 * flutter) * (0.7 + 0.3 * sin(uNow * 9.0 + speck * 20.0)) * 1.4;
#endif
}
`;

type Variant = 'bulk' | 'anim';

/** The shared plant material (Lambert, double-sided leaves) with the plant vertex code. */
function plantMaterial(u: WorldUniforms, now: THREE.IUniform<number>, arch: THREE.Vector4, arch2: THREE.Vector4, variant: Variant): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  if (variant === 'anim') mat.defines = { PLANT_ANIM: '' };
  mat.onBeforeCompile = (shader) => {
    addWorldUniforms(shader, u);
    shader.uniforms.uNow = now;
    shader.uniforms.uArch = { value: arch };
    shader.uniforms.uArch2 = { value: arch2 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PLANT_GLSL}`)
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvec3 vegP; vec3 vegN; vec3 vegC; vec3 vegE;\nplantVertex(vegP, vegN, vegC, vegE);')
      .replace('#include <color_vertex>', 'vColor = vec4(vegC, 1.0);\nvEmit = vegE;')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vegN;')
      .replace('#include <begin_vertex>', 'vec3 transformed = vegP;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEmit;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;');
  };
  mat.customProgramCacheKey = () => `wwwplant-${variant}`;
  return mat;
}

/** The matching shadow material: the same sway, pop and fall, so shadows move with the plant. */
function plantDepthMaterial(u: WorldUniforms, now: THREE.IUniform<number>, arch: THREE.Vector4, arch2: THREE.Vector4, variant: Variant): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial();
  mat.defines = variant === 'anim' ? { PLANT_ANIM: '', PLANT_DEPTH: '' } : { PLANT_DEPTH: '' };
  mat.onBeforeCompile = (shader) => {
    addWorldUniforms(shader, u);
    shader.uniforms.uNow = now;
    shader.uniforms.uArch = { value: arch };
    shader.uniforms.uArch2 = { value: arch2 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PLANT_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 vegP; vec3 vegN; vec3 vegC; vec3 vegE;\nplantVertex(vegP, vegN, vegC, vegE);\nvec3 transformed = vegP;');
  };
  mat.customProgramCacheKey = () => `wwwplant-depth-${variant}`;
  return mat;
}

// ---------- instance buffers ----------

/** One instanced mesh: an archetype (or far shape) at one level of detail, bulk or animating. */
class Slot {
  geo: THREE.InstancedBufferGeometry;
  arr: Float32Array;
  buf: THREE.InstancedInterleavedBuffer;
  readonly mesh: THREE.Mesh;
  n = 0;
  /** Instances (a prefix, since blocks are written nearest first) close enough to cast shadows. */
  near = 0;

  constructor(
    private readonly base: THREE.BufferGeometry,
    material: THREE.Material,
    depth: THREE.Material | null,
    scene: THREE.Scene,
    shadows: boolean,
  ) {
    this.arr = new Float32Array(32 * INST);
    this.buf = new THREE.InstancedInterleavedBuffer(this.arr, INST, 1);
    this.geo = this.makeGeometry();
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false; // culled per 16 m block on the CPU
    this.mesh.visible = false;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    if (depth && shadows) {
      this.mesh.castShadow = true;
      this.mesh.customDepthMaterial = depth;
      // Only the nearest instances cast shadows (a prefix of the buffer).
      this.mesh.onBeforeShadow = () => {
        this.geo.instanceCount = this.near;
      };
      this.mesh.onAfterShadow = () => {
        this.geo.instanceCount = this.n;
      };
    }
    scene.add(this.mesh);
  }

  /** A geometry with its own copies of the model attributes plus this slot's instance buffer. */
  private makeGeometry(): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    for (const name of ['position', 'normal', 'color', 'aPlant', 'aAttach']) g.setAttribute(name, this.base.getAttribute(name).clone());
    g.setIndex(this.base.getIndex()!.clone());
    this.buf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', new THREE.InterleavedBufferAttribute(this.buf, 4, 0));
    g.setAttribute('iLife', new THREE.InterleavedBufferAttribute(this.buf, 4, 4));
    g.setAttribute('iCol', new THREE.InterleavedBufferAttribute(this.buf, 4, 8));
    g.instanceCount = 0;
    return g;
  }

  /** Make room for one more instance (doubling; a new geometry, as three fixes a geometry's instance capacity). */
  private grow(): void {
    const bigger = new Float32Array(this.arr.length * 2);
    bigger.set(this.arr);
    this.arr = bigger;
    this.buf = new THREE.InstancedInterleavedBuffer(this.arr, INST, 1);
    const old = this.geo;
    this.geo = this.makeGeometry();
    this.mesh.geometry = this.geo;
    old.dispose();
  }

  write(x: number, y: number, z: number, ys: number, birth: number, death: number, kind: number, sd: number, cols: Float32Array, co: number): void {
    if ((this.n + 1) * INST > this.arr.length) this.grow();
    const a = this.arr;
    const o = this.n * INST;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = ys;
    a[o + 4] = birth;
    a[o + 5] = death;
    a[o + 6] = kind;
    a[o + 7] = sd;
    a[o + 8] = cols[co];
    a[o + 9] = cols[co + 1];
    a[o + 10] = cols[co + 2];
    a[o + 11] = cols[co + 3];
    this.n++;
  }

  /** Upload what was written this round. */
  commit(): void {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) {
      this.buf.clearUpdateRanges();
      this.buf.addUpdateRange(0, this.n * INST);
      this.buf.needsUpdate = true;
    }
  }

}

// ---------- motes ----------

const MOTE_N = 128;
const MOTE_LIFE = 1.8;
/** Mote kinds: green-gold pop motes, grey ash, falling leaves, embers. */
const MoteKind = { Pop: 0, Ash: 1, Leaf: 2, Ember: 3 } as const;

/** A few drifting motes for pops and deaths (one Points draw, a ring buffer of 128). */
class Motes {
  readonly points: THREE.Points;
  private readonly start: Float32Array;
  private readonly vel: Float32Array;
  private readonly info: Float32Array;
  private next = 0;
  private lastSpawn = -100;
  private warming = true;
  private readonly mat: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, now: THREE.IUniform<number>) {
    const g = new THREE.BufferGeometry();
    this.start = new Float32Array(MOTE_N * 3);
    this.vel = new Float32Array(MOTE_N * 3);
    this.info = new Float32Array(MOTE_N * 2).fill(-100);
    g.setAttribute('position', new THREE.BufferAttribute(this.start, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uNow: now, uPx: { value: 800 } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec3 aVel;
        attribute vec2 aInfo;
        uniform float uNow;
        uniform float uPx;
        varying vec3 vCol;
        varying float vA;
        void main() {
          float age = uNow - aInfo.x;
          float k = age / ${MOTE_LIFE.toFixed(1)};
          if (age < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; vCol = vec3(0.0); return; }
          float kind = aInfo.y;
          vec3 p = position + aVel * age;
          p += vec3(sin(uNow * 2.1 + position.x * 3.0), 0.0, cos(uNow * 1.7 + position.z * 3.0)) * 0.12 * age;
          if (kind > 1.5 && kind < 2.5) p.y -= 0.5 * age * age;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          float size = kind < 0.5 ? 0.11 : kind < 1.5 ? 0.22 : kind < 2.5 ? 0.16 : 0.07;
          gl_PointSize = max(size * sin(min(k * 3.14159 * 1.4, 3.14159 * 0.5) + k * 1.0) * uPx / -mv.z, 0.0);
          vCol = kind < 0.5 ? vec3(0.81, 0.89, 0.36) : kind < 1.5 ? vec3(0.15, 0.14, 0.13) : kind < 2.5 ? vec3(0.42, 0.55, 0.16) : vec3(1.0, 0.45, 0.12);
          vA = (1.0 - k) * (kind < 0.5 ? 0.9 : 0.75);
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vCol, vA * smoothstep(0.5, 0.15, d));
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.mat.dispose();
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, at: number, kind: number): void {
    const i = this.next;
    this.next = (this.next + 1) % MOTE_N;
    this.start[i * 3] = x;
    this.start[i * 3 + 1] = y;
    this.start[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.info[i * 2] = at;
    this.info[i * 2 + 1] = kind;
    if (at + MOTE_LIFE > this.lastSpawn) this.lastSpawn = at + MOTE_LIFE;
    for (const name of ['position', 'aVel', 'aInfo']) (this.points.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Keep the (empty) points visible for the first frames so the shader compiles at load. */
  warm(on: boolean): void {
    this.warming = on;
  }

  update(now: number, camera: THREE.PerspectiveCamera, pixelHeight: number): void {
    this.points.visible = this.warming || now < this.lastSpawn;
    this.mat.uniforms.uPx.value = pixelHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
}

// ---------- the system ----------

/** Deterministic 0..1 from two numbers (mote scatter; no Math.random, so screenshots repeat). */
function jitter(a: number, b: number): number {
  return hash2(Math.floor(a * 97), Math.floor(b * 131), 0x30e5);
}

/** The 16 m block (global id) a spot belongs to. */
function blockOfSpot(s: number): number {
  const p = (s / SPOTS) | 0;
  return (((p % NP) / BLOCK_P) | 0) + (((p / NP / BLOCK_P) | 0) * NB);
}

interface Slots {
  /** [lod 0|1][model][variant] */
  bulk: Slot[][][];
  /** [model][variant] at LOD0 with the full animation shader */
  anim: Slot[][];
  /** per far shape */
  far: Slot[];
  all: Slot[];
}

export function createVegetation(deps: SystemDeps): PageSystem {
  const { scene, fields, u, quality } = deps;
  const now: THREE.IUniform<number> = { value: 0 };
  const models = buildModels();
  const slots: Slots = { bulk: [[], []], anim: [], far: [], all: [] };
  for (const a of ARCHETYPES) {
    slots.bulk[0][a.model] = [];
    slots.bulk[1][a.model] = [];
    slots.anim[a.model] = [];
    if (a.model === PlantModel.Tint) continue;
    // One set of materials per archetype: they share programs, only the uniforms differ.
    const archU = new THREE.Vector4(a.height, a.unfurl, a.dry, a.surge ? 1 : 0);
    const arch2U = new THREE.Vector4(a.bloom, a.storm, 0, 0);
    const mBulk = plantMaterial(u, now, archU, arch2U, 'bulk');
    const mAnim = plantMaterial(u, now, archU, arch2U, 'anim');
    const dBulk = plantDepthMaterial(u, now, archU, arch2U, 'bulk');
    const dAnim = plantDepthMaterial(u, now, archU, arch2U, 'anim');
    for (let v = 0; v < a.variants; v++) {
      const g0 = models.lod0[a.model][v];
      const g1 = models.lod1[a.model][v];
      const s0 = new Slot(g0, mBulk, dBulk, scene, quality.shadows);
      const s1 = new Slot(g1, mBulk, null, scene, false);
      const sa = new Slot(g0, mAnim, dAnim, scene, quality.shadows);
      slots.bulk[0][a.model][v] = s0;
      slots.bulk[1][a.model][v] = s1;
      slots.anim[a.model][v] = sa;
      slots.all.push(s0, s1, sa);
    }
  }
  const farMat = plantMaterial(u, now, new THREE.Vector4(1, 0, 0.25, 0), new THREE.Vector4(1, StormFall.Topple, TIER_RANGE[2], 0), 'bulk');
  for (const g of models.far) {
    const slot = new Slot(g, farMat, null, scene, false);
    slots.far.push(slot);
    slots.all.push(slot);
  }
  const table = new SpeciesTable(deps.species);
  const field = new PlantField(fields, table, models.tris);
  // New life data or reshaped ground: those tiles get another look.
  const onEco = (x0: number, z0: number, w: number, h: number): void => field.markPatches(x0, z0, w, h, false);
  const onCols = (x0: number, z0: number, w: number, h: number): void => {
    // Column rectangle -> patch rectangle (2 columns per patch).
    const px0 = x0 >> 1;
    const pz0 = z0 >> 1;
    field.markPatches(px0, pz0, ((x0 + w - 1) >> 1) - px0 + 1, ((z0 + h - 1) >> 1) - pz0 + 1, true);
  };
  fields.onEco.push(onEco);
  fields.onCols.push(onCols);
  const unlisten = (): void => {
    fields.onEco.splice(fields.onEco.indexOf(onEco), 1);
    fields.onCols.splice(fields.onCols.indexOf(onCols), 1);
  };
  return new VegetationSystem(field, table, slots, new Motes(scene, now), now, deps, unlisten);
}

/** Ties placement, selection, instance writing, pops and motes together, once per frame. */
class VegetationSystem implements PageSystem {
  readonly name = 'vegetation';
  private epoch = 0;
  private sinceBuild = REBUILD_INTERVAL;
  private needBuild = true;
  private needSelect = true;
  private tokens = POP_BURST;
  private readonly lastCam = new THREE.Vector3(1e9, 0, 0);
  private readonly lastDir = new THREE.Vector3();
  private nextAnimEnd = Infinity;
  private seenVersion = -1;
  /** Frames left in which one empty mesh per program stays visible, so shaders compile at load. */
  private warm = 3;
  private pondKey = '';
  private ponds: readonly PondInfo[] | null = null;
  private readonly cond: FieldConditions = { now: 0, storm: { phase: 'none', t: 0, level: 0, great: false }, ponds: null, windAngle: Math.PI };

  // Selection scratch, per 16 m block.
  private readonly lod = new Uint8Array(NB * NB).fill(3);
  /** Per block: tier, plus 4 when it casts shadows; a change means the buffers need rewriting. */
  private readonly state = new Uint8Array(NB * NB).fill(3);
  private readonly prevState = new Uint8Array(NB * NB).fill(3);
  private readonly strict = new Uint8Array(NB * NB);
  private readonly bDist = new Float32Array(NB * NB);
  private readonly bTier = new Uint8Array(NB * NB);
  private readonly cand = new Int32Array(NB * NB);
  private readonly keys = new Float64Array(NB * NB);
  private readonly order = new Int32Array(NB * NB);
  private candN = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly camDir = new THREE.Vector3();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly u: WorldUniforms;
  private readonly quality: Quality;

  constructor(
    private readonly field: PlantField,
    private readonly table: SpeciesTable,
    private readonly slots: Slots,
    private readonly motes: Motes,
    private readonly now: THREE.IUniform<number>,
    deps: SystemDeps,
    private readonly unlisten: () => void,
  ) {
    this.camera = deps.camera;
    this.renderer = deps.renderer;
    this.u = deps.u;
    this.quality = deps.quality;
  }

  dispose(): void {
    this.unlisten();
    // Materials are shared between the slots of an archetype: dispose each once.
    const seen = new Set<THREE.Material>();
    for (const s of this.slots.all) {
      s.mesh.removeFromParent();
      s.geo.dispose();
      for (const m of [s.mesh.material as THREE.Material, s.mesh.customDepthMaterial]) {
        if (m && !seen.has(m)) {
          seen.add(m);
          m.dispose();
        }
      }
    }
    this.motes.dispose();
  }

  onEngine(m: FromEngine): void {
    if (m.t === 'clear') {
      // A new world: everything goes at once, no death animations; ponds come with the next life info.
      this.field.reset();
      this.ponds = null;
      this.pondKey = '';
      this.needBuild = true;
    } else if (m.t === 'life') {
      // Ponds decide where lilies float and where land plants can't stand.
      const ponds = m.life.ponds;
      const key = ponds.map((p) => `${p.x0},${p.z0},${p.x1},${p.z1},${p.level.toFixed(2)}`).join(';');
      if (key === this.pondKey) return;
      for (const list of [this.ponds ?? [], ponds]) {
        for (const p of list) {
          const px0 = Math.floor((p.x0 - ORIGIN_X) / PATCH_M);
          const pz0 = Math.floor((p.z0 - ORIGIN_Z) / PATCH_M);
          const px1 = Math.floor((p.x1 - ORIGIN_X) / PATCH_M);
          const pz1 = Math.floor((p.z1 - ORIGIN_Z) / PATCH_M);
          this.field.markPatches(px0, pz0, px1 - px0 + 1, pz1 - pz0 + 1, true);
        }
      }
      this.pondKey = key;
      this.ponds = ponds;
    }
  }

  update(f: FrameCtx): void {
    // The vegetation clock: real seconds, rebased every hour so float32 times stay precise.
    if (f.t - this.epoch > 4000) {
      this.epoch += 3600;
      this.field.rebase(3600);
      this.nextAnimEnd -= 3600;
    }
    const t = f.t - this.epoch;
    this.now.value = t;
    // The camera moved this frame (before render updates its matrices): culling needs them now.
    this.camera.updateMatrixWorld();
    const cam = this.camera.position;
    if (this.field.track(cam.x, cam.y, cam.z)) this.needSelect = true;

    // Work out dirty tiles, nearest first, within a small time budget.
    const c = this.cond;
    c.now = t;
    c.storm = f.storm;
    c.ponds = this.ponds;
    const w = this.u.uWind.value;
    c.windAngle = Math.hypot(w.x, w.y) > 1e-4 ? Math.atan2(w.y, w.x) : Math.PI;
    const t0 = performance.now();
    for (let tile = this.field.nextDirty(); tile >= 0; tile = this.field.nextDirty()) {
      this.field.evaluate(tile, c);
      if (performance.now() - t0 > EVAL_BUDGET_MS) break;
    }
    if (this.field.version !== this.seenVersion) {
      this.seenVersion = this.field.version;
      this.needSelect = true;
      this.needBuild = true;
    }
    this.deathMotes(t);

    // Camera moved or turned enough to change what is culled or capped.
    this.camera.getWorldDirection(this.camDir);
    if (cam.distanceToSquared(this.lastCam) > 4 || this.camDir.dot(this.lastDir) < 0.9994) this.needSelect = true;
    if (this.field.pendN > 0 || t >= this.nextAnimEnd) this.needBuild = true;

    this.sinceBuild += f.dt;
    this.tokens = Math.min(POP_BURST, this.tokens + f.dt * POPS_PER_SECOND);
    if ((this.needSelect || this.needBuild) && this.sinceBuild >= REBUILD_INTERVAL) {
      this.sinceBuild = 0;
      if (this.field.expireDead(t)) this.needBuild = true;
      if (this.needSelect && this.select()) this.needBuild = true;
      this.needSelect = false;
      if (this.needBuild) this.build(t);
      this.needBuild = false;
    }
    if (this.warm > 0) {
      this.warm--;
      const keep = this.warm > 0;
      for (const s of [this.slots.bulk[0][PlantModel.Fern][0], this.slots.anim[PlantModel.Fern][0], this.slots.far[0]]) s.mesh.visible = s.n > 0 || keep;
      this.motes.warm(keep);
    }
    this.motes.update(t, f.camera, this.renderer.domElement.height);
  }

  /**
   * Choose each block's tier: frustum cull (with a margin, since rebuilds lag the camera by up to
   * 0.25 s), sort by distance, then fill the caps nearest first. Returns true if anything changed.
   */
  private select(): boolean {
    const fd = this.field;
    const cam = this.camera.position;
    this.lastCam.copy(cam);
    this.lastDir.copy(this.camDir);
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const size = BLOCK_P * PATCH_M;
    let n = 0;
    for (let t = 0; t < NT * NT; t++) {
      if (fd.tier[t] > 2 || fd.recN[t] === 0) continue;
      const tx = t % NT;
      const tz = (t / NT) | 0;
      for (let bi = 0; bi < BPT * BPT; bi++) {
        if (fd.blockStart[t * 17 + bi + 1] === fd.blockStart[t * 17 + bi]) continue;
        const bx = tx * BPT + (bi % BPT);
        const bz = tz * BPT + ((bi / BPT) | 0);
        const gb = bx + bz * NB;
        const x0 = ORIGIN_X + bx * size;
        const z0 = ORIGIN_Z + bz * size;
        const y0 = fd.bY0[gb];
        const y1 = fd.bY1[gb];
        const dx = cam.x < x0 ? x0 - cam.x : cam.x > x0 + size ? cam.x - x0 - size : 0;
        const dz = cam.z < z0 ? z0 - cam.z : cam.z > z0 + size ? cam.z - z0 - size : 0;
        const dy = cam.y < y0 ? y0 - cam.y : cam.y > y1 ? cam.y - y1 : 0;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const r = Math.sqrt(size * size * 0.5 + (y1 - y0) * (y1 - y0) * 0.25);
        this.sphere.center.set(x0 + size / 2, (y0 + y1) / 2, z0 + size / 2);
        this.sphere.radius = r;
        this.strict[gb] = this.frustum.intersectsSphere(this.sphere) ? 1 : 0;
        if (!this.strict[gb]) {
          this.sphere.radius = r + 6 + d * 0.25;
          if (!this.frustum.intersectsSphere(this.sphere)) continue;
        }
        this.bDist[gb] = d;
        this.bTier[gb] = fd.tier[t];
        this.cand[n] = gb;
        this.keys[n] = Math.floor(d * 16) * 8192 + n;
        n++;
      }
    }
    this.candN = n;
    this.keys.subarray(0, n).sort();
    for (let i = 0; i < n; i++) this.order[i] = this.cand[this.keys[i] % 8192];
    this.lod.fill(3);
    assignLods(this.order, n, this.bTier, fd.bCnt, fd.bTri, capsFor(this.quality), this.lod);
    // What a build depends on per block: its tier, and whether it is close enough to cast shadows.
    this.prevState.set(this.state);
    this.state.fill(3);
    for (let i = 0; i < n; i++) {
      const gb = this.order[i];
      this.state[gb] = this.lod[gb] | (this.lod[gb] === 0 && this.bDist[gb] < SHADOW_RANGE ? 4 : 0);
    }
    for (let i = 0; i < NB * NB; i++) if (this.state[i] !== this.prevState[i]) return true;
    return false;
  }

  /** May this spot's plant pop (full detail, on screen, close)? */
  private canPop(s: number): boolean {
    const gb = blockOfSpot(s);
    return this.lod[gb] === 0 && this.strict[gb] === 1 && this.bDist[gb] <= POP_RANGE;
  }

  /**
   * Decide pending births: the best few on screen and close pop (trees before shrubs before herbs,
   * then nearest), at most four a second; the rest fade in, at once if they can't pop at all.
   */
  private schedulePops(now: number): void {
    const fd = this.field;
    while (this.tokens >= 1) {
      let best = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < fd.pendN; i++) {
        const s = fd.pend[i];
        if (fd.sp[s] === 0 || !Number.isNaN(fd.birth[s]) || !this.canPop(s)) continue;
        const score = (2 - slotLayer(s % SPOTS)) * 1000 - this.bDist[blockOfSpot(s)];
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      if (best < 0) break;
      fd.birth[best] = now;
      fd.pop[best] = 1;
      this.tokens -= 1;
      this.popMotes(best, now);
    }
    let w = 0;
    for (let i = 0; i < fd.pendN; i++) {
      const s = fd.pend[i];
      if (fd.sp[s] === 0 || !Number.isNaN(fd.birth[s])) continue;
      if (!this.canPop(s) || now - fd.pendT[i] > POP_WAIT) {
        fd.birth[s] = now;
        fd.pop[s] = 0;
        continue;
      }
      fd.pend[w] = s;
      fd.pendT[w] = fd.pendT[i];
      w++;
    }
    fd.pendN = w;
  }

  /** Green-gold motes drifting up as a popped plant settles. */
  private popMotes(s: number, now: number): void {
    const p = (s / SPOTS) | 0;
    const slot = s % SPOTS;
    const sp = this.field.sp[s] - 1;
    const h = ARCHETYPES[this.table.model[sp]].height * this.field.plantScale(p, slot, sp);
    const x = spotX(p, slot);
    const z = spotZ(p, slot);
    const y = this.field.baseY[s];
    for (let k = 0; k < 6; k++) {
      const a = jitter(x + k, z) * Math.PI * 2;
      const r = h * 0.3 * jitter(z + k, x);
      this.motes.spawn(x + Math.cos(a) * r, y + h * (0.3 + 0.5 * jitter(k, x + z)), z + Math.sin(a) * r, Math.cos(a) * 0.15, 0.25 + 0.2 * jitter(x, k), Math.sin(a) * 0.15, now + 0.9 + k * 0.08, MoteKind.Pop);
    }
  }

  /** Motes for deaths close to the camera: ash and embers, storm-torn leaves, falling straw. */
  private deathMotes(now: number): void {
    const ev = this.field.events;
    const cam = this.camera.position;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      const dx = e.x - cam.x;
      const dz = e.z - cam.z;
      if (dx * dx + dz * dz > POP_RANGE * POP_RANGE || e.kind === DeathKind.Burial) continue;
      const fx = Math.cos(e.dir);
      const fz = Math.sin(e.dir);
      const n = e.kind === DeathKind.Wither ? 3 : 8;
      for (let k = 0; k < n; k++) {
        const j = jitter(e.x + k, e.z - k);
        const y = e.y + e.h * (0.4 + 0.5 * jitter(k, e.x));
        if (e.kind === DeathKind.Lava) {
          this.motes.spawn(e.x + (j - 0.5) * e.h * 0.4, y, e.z + (jitter(k, e.z) - 0.5) * e.h * 0.4, 0, k < 5 ? 0.9 : 1.8, 0, now + k * 0.12, k < 5 ? MoteKind.Ash : MoteKind.Ember);
        } else if (e.kind === DeathKind.Storm) {
          this.motes.spawn(e.x, y, e.z, fx * (2 + 3 * j), 0.6 + j, fz * (2 + 3 * j), now + k * 0.07, MoteKind.Leaf);
        } else {
          this.motes.spawn(e.x + (j - 0.5) * e.h * 0.5, y, e.z + (jitter(e.z, k) - 0.5) * e.h * 0.5, 0.1, 0.2, 0.05, now + 0.4 + k * 0.3, MoteKind.Leaf);
        }
      }
    }
    ev.length = 0;
  }

  /** Write every drawn plant into the instance buffers and upload them. */
  private build(now: number): void {
    const fd = this.field;
    const { bulk, anim, far, all } = this.slots;
    this.schedulePops(now);
    for (const s of all) {
      s.n = 0;
      s.near = 0;
    }
    const cols = this.table.colours;
    let animEnd = Infinity;
    for (let i = 0; i < this.candN; i++) {
      const gb = this.order[i];
      const lod = this.lod[gb];
      if (lod > 2) continue;
      const bx = gb % NB;
      const bz = (gb / NB) | 0;
      const t = ((bx / BPT) | 0) + ((bz / BPT) | 0) * NT;
      const bi = (bx % BPT) + (bz % BPT) * BPT;
      const rec = fd.recs[t];
      const near = this.bDist[gb] < SHADOW_RANGE;
      for (let r = fd.blockStart[t * 17 + bi]; r < fd.blockStart[t * 17 + bi + 1]; r++) {
        const o = r * REC;
        const L = rec[o + 7];
        if ((lod === 1 && L > 1) || (lod === 2 && L > 0)) continue;
        const s = rec[o + 5];
        const birth = fd.birth[s];
        if (Number.isNaN(birth)) continue;
        const sp = rec[o + 6];
        const model = this.table.model[sp];
        const arch = ARCHETYPES[model];
        const sd = rec[o + 4];
        const co = sp * 4;
        if (lod === 2) {
          // Far blobs are 1 m models: scale them by the plant's height, and sink them a little
          // (the far terrain is coarser than the height map).
          const ys = rec[o + 3];
          far[arch.far].write(rec[o], rec[o + 1] - 0.4, rec[o + 2], packYawScale((ys - Math.floor(ys)) * Math.PI * 2, (Math.floor(ys) / 128) * arch.height), birth, NEVER, 0, sd, cols, co);
          continue;
        }
        const v = variantOf(arch, sd - Math.floor(sd));
        const popping = lod === 0 && fd.pop[s] === 1 && now - birth < POP_TIME;
        const slot = bulk[lod][model][v];
        slot.write(rec[o], rec[o + 1], rec[o + 2], rec[o + 3], birth, NEVER, popping ? 8 : 0, sd, cols, co);
        if (lod === 0 && near) slot.near = slot.n;
        if (popping) {
          const a = anim[model][v];
          a.write(rec[o], rec[o + 1], rec[o + 2], rec[o + 3], birth, NEVER, 8, sd, cols, co);
          if (near) a.near = a.n;
          animEnd = Math.min(animEnd, birth + POP_TIME);
        }
      }
    }
    // Dying plants: the full death close up, a quick shrink further away.
    const cam = this.camera.position;
    const d = fd.dead;
    for (let i = 0; i < fd.deadN; i++) {
      const o = i * DEAD;
      const dx = d[o] - cam.x;
      const dy = d[o + 1] - cam.y;
      const dz = d[o + 2] - cam.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const model = d[o + 10];
      const v = d[o + 11];
      const kind = d[o + 7];
      const co = d[o + 8] * 4;
      if (dist < TIER_RANGE[0]) {
        const a = anim[model][v];
        a.write(d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 5], d[o + 6], kind, d[o + 4], cols, co);
        if (dist < SHADOW_RANGE) a.near = a.n;
        animEnd = Math.min(animEnd, d[o + 6] + DEATH_SPAN[kind % 16]);
      } else if (now - d[o + 6] < FADE_TIME) {
        const L = d[o + 9];
        const arch = ARCHETYPES[model];
        if (dist < TIER_RANGE[1] && L < 2) {
          bulk[1][model][v].write(d[o], d[o + 1], d[o + 2], d[o + 3], d[o + 5], d[o + 6], 0, d[o + 4], cols, co);
        } else if (dist < TIER_RANGE[2] && L === 0) {
          const ys = d[o + 3];
          far[arch.far].write(d[o], d[o + 1] - 0.4, d[o + 2], packYawScale((ys - Math.floor(ys)) * Math.PI * 2, (Math.floor(ys) / 128) * arch.height), d[o + 5], d[o + 6], 0, d[o + 4], cols, co);
        }
        animEnd = Math.min(animEnd, d[o + 6] + FADE_TIME);
      }
    }
    for (const s of all) s.commit();
    this.nextAnimEnd = animEnd;
  }
}
