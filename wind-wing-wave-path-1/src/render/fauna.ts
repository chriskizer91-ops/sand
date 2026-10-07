/**
 * Animal agents near the camera, at real-world pace (WP-F2; ARCHITECTURE §6.7).
 *
 * The two clocks meet here. The ecology (racing through years) decides WHO lives on each island:
 * `life.pops` (how abundant each species is per island) and `life.colonies` (where seabirds nest).
 * This system decides what you SEE them doing right now, in real time and at real speeds: a booby
 * gliding in to land on a ledge, a crab sprinting sideways and freezing, a turtle crawling up the
 * beach at night.
 *
 * - Agents exist only near the camera target (250 m; birds 600 m). Caps: about 60 on a phone and
 *   120 on a laptop (scaled by quality.density), plus one point-sprite "speck flock" for distant
 *   seabird colonies. Fish shoals and firefly swarms are one agent each with up to 16 members.
 * - How many of a species show = its population near the camera x the habitat in view x the time
 *   of day x how big it would look (a crab is invisible from 400 m, so none are simulated there).
 * - Spawn points are patches near the camera whose habitat is in the species' `where` list.
 * - Nothing pops in or out in view. Animals arrive from out of view (birds fly in, fish swim in),
 *   or by a natural entrance (a crab climbs out of its burrow, a lizard steps out from under a shrub,
 *   fireflies light up, a spider lowers itself on silk). They leave the same quiet ways. Entrances
 *   and exits in view are drawn as a short screen-door fade (the creature shader's presence), never a
 *   jump. The only exception is a "cut" (the camera jumped somewhere new), when there is nothing to break.
 * - Every behaviour is a small state machine with pauses (see the Behaviour list in speciesTypes.ts),
 *   using real speeds from `SpeciesDef.animal.speed` and never exceeding `speedLimit()`.
 * - Animals calmly move away from the active brush and from molten lava (birds lift off, walkers
 *   hurry to safe ground, crabs dig in elsewhere), shelter in storms (birds to the lee side, crabs
 *   into burrows, insects into cover) and never die on screen.
 * - Work is spread over frames: the habitat census is taken a few rows of patches per frame, and a
 *   colony's nesting ledges are only looked for again when the ground inside it changes.
 *
 * The simulation (`FaunaSim`) is plain typed arrays with no WebGL, so it is unit-tested in Node
 * (tests/fauna.test.ts). `createFauna` draws it: one instanced mesh per body plan in view (shared
 * creature material) plus one points draw for specks, fireflies, splashes, blows and wakes.
 * No per-frame allocations in the hot paths.
 */
import * as THREE from 'three';
import { CELL, DAY_PARTS, NP, NX, ORIGIN_X, ORIGIN_Z, PATCH, PATCH_M, WIND_TO_X, WIND_TO_Z } from '../config';
import { AnimalModel, Habitat, HABITAT_COUNT, PlantModel, type AnimalLook, type Behaviour, type SpeciesDef } from '../content/speciesTypes';
import { Rng, hash2 } from '../engine/noise';
import { PLANT_BYTES, type FromEngine, type LifeInfo, type StormState } from '../engine/protocol';
import type { WorldFields } from './fields';
import { CreatureBatch, HATCHLING_PLAN, PLAN_COUNT, PointKind, SoftPoints, buildAnimalGeometries, creatureMaterials, hexToLinear, planTriangles } from './models/animals';
import type { BrushInfo, FrameCtx, PageSystem, SystemDeps } from './shared';
import { seaHeight } from './waves';

// ---------- shared rules (also used by vignettes and tests) ----------

/** Agents live within this distance of the camera target (m). */
export const NEAR_RANGE = 250;
/** Birds that fly high and far (seabirds, frigatebirds) live within this distance. */
export const BIRD_RANGE = 600;
/**
 * A colony's 3D birds thin out between these distances from the eye (m), and its speck flock (far
 * birds as dots) takes over across the same band.
 */
const COLONY_NEAR = 250;
const COLONY_FAR = 450;
/** World size of a speck (about a booby's wingspan, m). */
export const SPECK_SIZE = 1.5;
/** Members per group agent (a fish shoal, a firefly swarm, a clutch of hatchlings). */
export const GROUP_SIZE = 16;
/** An animal out of view this long (s) is quietly let go, so new ones can come where the camera looks. */
export const UNSEEN_RECYCLE = 25;
/** Most triangles all animals may draw (ARCHITECTURE §7: animals 15k on the phone). */
export const TRI_BUDGET = 15000;
/** An entrance fade (stepping out from cover) wears off at this rate per second. */
const ENTRANCE_RATE = 0.8;
/** Each agent looks for lava every this many frames. */
const LAVA_CHECK_FRAMES = 4;
/** Molten lava closer than this (m) sends an animal away, and the refuge it heads for is this clear of it. */
const LAVA_ALARM = 7;
/** A ledge, perch or landing spot must have no molten lava within this (m). */
const LAVA_SAFE = 4;

const TAU = Math.PI * 2;
const PHASE_WRAP = Math.PI * 4;
const H = Habitat;

/**
 * The fastest an animal of each behaviour ever moves, as a multiple of its species speed, plus an
 * absolute allowance for its second way of moving (shorebirds and herons fly between spots, turtles
 * and seals swim, which is faster than they crawl). The simulation clamps every move to this.
 */
export const SPEED_LIMIT: Record<Behaviour, readonly [number, number]> = {
  colony: [1.6, 0], // plunge dives
  soar: [1.3, 0],
  flit: [1.3, 0],
  wade: [1.5, 8], // short flights between wading spots
  'run-shore': [1.3, 10], // a flush low along the shore
  paddle: [1.5, 12], // a short flight round the pond
  'night-fly': [1.3, 0],
  scuttle: [1.2, 0],
  bask: [1.2, 0],
  graze: [1.5, 0.3], // hurrying away from lava
  'nest-beach': [1.5, 0.75], // swimming
  shoal: [1.6, 0], // scattering
  'glide-sea': [1.4, 0],
  porpoise: [1.8, 0], // arcs out of the water
  'surface-blow': [4.2, 0], // the rare breach
  flutter: [1.5, 0],
  hover: [1.1, 0],
  buzz: [1.3, 0],
  glow: [2, 0.5],
  'haul-out': [1.5, 2.2], // swimming
  web: [2, 0.3],
  creep: [1.5, 0],
};

/** Hard speed cap for a species (m/s). */
export function speedLimit(look: AnimalLook): number {
  const [k, abs] = SPEED_LIMIT[look.behaviour];
  return Math.max(look.speed * k, abs);
}

/**
 * The size an animal is drawn at (m). Tiny creatures are drawn up to about 1.6x life size so a ghost
 * crab or a white-eye still reads from a normal viewing distance; anything over 30 cm is true to size.
 */
export function displaySize(look: AnimalLook): number {
  return look.size * (1 + 0.6 * smooth(0.3, 0.05, look.size));
}

/** Behaviours whose animals stand, walk or swim (they must stay on their allowed habitats). */
export const GROUNDED: ReadonlySet<Behaviour> = new Set<Behaviour>(['scuttle', 'bask', 'graze', 'creep', 'run-shore', 'wade', 'paddle', 'nest-beach', 'glide-sea', 'porpoise', 'surface-blow', 'haul-out', 'shoal', 'web']);

/** Extra habitats each behaviour may cross besides `where` (the swash zone, the shallows on the way to a beach...). */
const EXTRA: Record<Behaviour, number[]> = {
  colony: [],
  soar: [],
  flit: [],
  wade: [H.Marsh, H.Stream, H.Pond, H.RockShore, H.Mangrove],
  'run-shore': [H.OpenSea, H.Reef, H.Seagrass, H.Lagoon, H.Sound, H.Dune],
  paddle: [H.Marsh],
  'night-fly': [],
  scuttle: [H.Dune],
  bask: [],
  graze: [],
  'nest-beach': [H.DeepSea, H.OpenSea, H.Reef, H.Seagrass, H.Lagoon, H.Sound, H.Dune, H.Beach],
  shoal: [],
  'glide-sea': [H.Sound],
  porpoise: [H.DeepSea, H.OpenSea, H.Reef, H.Seagrass, H.Lagoon, H.Sound],
  'surface-blow': [H.DeepSea, H.OpenSea, H.Sound],
  flutter: [],
  hover: [H.Marsh],
  buzz: [],
  glow: [],
  'haul-out': [H.DeepSea, H.OpenSea, H.Reef, H.Seagrass, H.Lagoon, H.Sound, H.RockShore],
  web: [],
  creep: [],
};

function maskOf(list: readonly number[]): number {
  let m = 0;
  for (const h of list) m |= 1 << h;
  return m;
}

/** Habitats a species' agents may stand or swim on: its `where` list plus its behaviour's extras. */
export function allowedMask(look: AnimalLook): number {
  return maskOf(look.where) | maskOf(EXTRA[look.behaviour]);
}

/** Length of (a, b) and (a, b, c). Math.hypot allocates on every call in V8, so the hot paths use these. */
export function hyp(a: number, b: number): number {
  return Math.sqrt(a * a + b * b);
}
export function hyp3(a: number, b: number, c: number): number {
  return Math.sqrt(a * a + b * b + c * c);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
/** Copy a frustum's six planes into a flat array (nx, ny, nz, constant per plane) for sphereClass. */
function packPlanes(f: THREE.Frustum, out: Float64Array): void {
  for (let k = 0; k < 6; k++) {
    const p = f.planes[k];
    out[k * 4] = p.normal.x;
    out[k * 4 + 1] = p.normal.y;
    out[k * 4 + 2] = p.normal.z;
    out[k * 4 + 3] = p.constant;
  }
}

/**
 * Where a sphere is against the view frustum (packed by packPlanes): 1 wholly inside, -1 wholly
 * outside, 0 across an edge. Plain arithmetic, so the census can call it thousands of times a frame.
 */
function sphereClass(pl: Float64Array, x: number, y: number, z: number, r: number): number {
  let across = 0;
  for (let k = 0; k < 24; k += 4) {
    const d = pl[k] * x + pl[k + 1] * y + pl[k + 2] * z + pl[k + 3];
    if (d < -r) return -1;
    if (d < r) across = 1;
  }
  return across === 1 ? 0 : 1;
}
function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
function turnToward(cur: number, want: number, maxStep: number): number {
  const d = wrapAngle(want - cur);
  return cur + clamp(d, -maxStep, maxStep);
}
function approach(cur: number, want: number, rate: number): number {
  return cur + (want - cur) * Math.min(1, rate);
}

const D1 = DAY_PARTS.dawn;
const D2 = DAY_PARTS.dawn + DAY_PARTS.day;
const D3 = D2 + DAY_PARTS.dusk;

/** How active a species is at a day phase (0 = start of dawn), 0..1. */
export function activityLevel(active: AnimalLook['active'], phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  if (active === 'any') return 1;
  if (active === 'day') {
    if (p < D1) return smooth(0, D1, p);
    if (p < D2) return 1;
    if (p < D3) return 1 - smooth(D2, D3, p);
    return 0;
  }
  if (active === 'night') {
    if (p < D1) return 1 - smooth(0, D1, p);
    if (p < D2) return 0;
    if (p < D3) return smooth(D2, D3, p);
    return 1;
  }
  // Dusk (and dawn) animals: out in the half-light, quieter through the night, hidden by day.
  if (p < D1) return 0.8;
  if (p < D2) return 0.8 * (1 - smooth(D1, D1 + 0.02, p)) + smooth(D2 - 0.02, D2, p);
  if (p < D3) return 1;
  return 0.6;
}

/** How strongly animals seek shelter from a storm, 0..1 (they start heading in during the warning). */
export function shelterLevel(s: StormState): number {
  if (s.phase === 'warning') return smooth(4, 18, s.t);
  if (s.phase === 'peak') return 1;
  if (s.phase === 'clearing') return 1 - smooth(4, 24, s.t);
  return 0;
}

/** Dew on silk catches the light at dawn and in the low evening sun (0..1). */
export function silkGlint(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const dawn = p < D1 + 0.05 ? smooth(0, 0.03, p) * (1 - smooth(D1 - 0.01, D1 + 0.05, p)) : 0;
  const evening = smooth(D2 - 0.08, D2 - 0.02, p) * (1 - smooth(D2, D2 + 0.03, p));
  return Math.max(dawn, evening * 0.5, 0.12);
}

/** Typical height of each plant archetype's top (m at size 1), by PlantModel value. */
const PLANT_TOP: Partial<Record<number, number>> = {
  [PlantModel.Palm]: 9,
  [PlantModel.Pandanus]: 6,
  [PlantModel.Mangrove]: 5,
  [PlantModel.Fig]: 12,
  [PlantModel.PomTree]: 10,
  [PlantModel.Broadleaf]: 11,
  [PlantModel.CloudTree]: 8,
  [PlantModel.SheOak]: 10,
  [PlantModel.SeaGrape]: 3,
  [PlantModel.Shrub]: 1.6,
  [PlantModel.TreeFern]: 4,
  [PlantModel.Cactus]: 3,
  [PlantModel.Silversword]: 1.2,
  [PlantModel.Fern]: 0.7,
  [PlantModel.Grass]: 0.5,
  [PlantModel.Herb]: 0.4,
  [PlantModel.Vine]: 0.15,
};

/**
 * Typical height of a plant's top (m), for perches (birds land on crowns, bats hang in them).
 * The vegetation renderer builds its models at about these sizes.
 */
export function plantTop(model: number, size: number): number {
  return (PLANT_TOP[model] ?? 0.4) * size;
}

// ---------- per-species setup ----------

const BEHAVIOURS: Behaviour[] = [
  'colony',
  'soar',
  'flit',
  'wade',
  'run-shore',
  'paddle',
  'night-fly',
  'scuttle',
  'bask',
  'graze',
  'nest-beach',
  'shoal',
  'glide-sea',
  'porpoise',
  'surface-blow',
  'flutter',
  'hover',
  'buzz',
  'glow',
  'haul-out',
  'web',
  'creep',
];
const B = {
  colony: 0,
  soar: 1,
  flit: 2,
  wade: 3,
  runShore: 4,
  paddle: 5,
  nightFly: 6,
  scuttle: 7,
  bask: 8,
  graze: 9,
  nestBeach: 10,
  shoal: 11,
  glideSea: 12,
  porpoise: 13,
  surfaceBlow: 14,
  flutter: 15,
  hover: 16,
  buzz: 17,
  glow: 18,
  haulOut: 19,
  web: 20,
  creep: 21,
} as const;

/** One animal species as the renderer needs it. */
export interface Kind {
  sp: number;
  look: AnimalLook;
  beh: number;
  plan: number;
  where: number;
  allowed: number;
  /** Packed sRGB colours for the creature shader. */
  colors: Float32Array;
  /** Linear primary colour for point sprites. */
  lin: Float32Array;
  /** Drawn body length (m), see displaySize. */
  size: number;
  /** Biggest visible extent (m): wingspan for birds, body length otherwise. */
  span: number;
  range: number;
  /** Drawn as a group of members (shoal, swarm). */
  group: boolean;
  vmax: number;
  tris: number;
}

function spanOf(look: AnimalLook): number {
  switch (look.model) {
    case AnimalModel.Seabird:
    case AnimalModel.Wader:
    case AnimalModel.Shorebird:
    case AnimalModel.Duck:
      return look.size * 2;
    case AnimalModel.Frigatebird:
    case AnimalModel.Bat:
      return look.size * 2.6;
    case AnimalModel.SmallBird:
      return look.size * 1.4;
    case AnimalModel.Crab:
      return look.size * 2;
    case AnimalModel.Ray:
      return look.size * 2;
    case AnimalModel.Firefly:
      return 0.4;
    case AnimalModel.Spider:
      return 0.3;
    default:
      return look.size;
  }
}

/** Build the per-species table for every animal that can show itself (max > 0). */
export function makeKinds(species: readonly SpeciesDef[], tris: readonly number[]): Kind[] {
  const out: Kind[] = [];
  for (const s of species) {
    const a = s.animal;
    if (!a || a.max <= 0 || a.speed < 0) continue;
    const lin = new Float32Array(3);
    hexToLinear(a.colors[0], lin, 0);
    const flyFar = a.behaviour === 'colony' || a.behaviour === 'soar';
    out.push({
      sp: s.id,
      look: a,
      beh: BEHAVIOURS.indexOf(a.behaviour),
      plan: a.model,
      where: maskOf(a.where),
      allowed: allowedMask(a),
      colors: Float32Array.from([a.colors[0] & 0xffffff, a.colors[1] & 0xffffff, a.colors[2] & 0xffffff]),
      lin,
      size: displaySize(a),
      span: Math.max(0.01, (spanOf(a) * displaySize(a)) / Math.max(1e-3, a.size)),
      range: flyFar ? BIRD_RANGE : NEAR_RANGE,
      group: a.behaviour === 'shoal' || a.behaviour === 'glow',
      vmax: speedLimit(a),
      tris: tris[a.model] ?? 0,
    });
  }
  return out;
}

// ---------- agent storage (structure of arrays) ----------

/** Lifecycle of an agent slot. */
export const Life = { Free: 0, Live: 1, Leaving: 2 } as const;

/** Every agent's state in flat typed arrays (no objects per animal). */
export class Agents {
  readonly cap: number;
  readonly kind: Int16Array;
  readonly life: Uint8Array;
  readonly st: Uint8Array;
  /** Increases with every spawn (lets tests tell a new animal from an old one in the same slot). */
  readonly serial: Uint32Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Current speed along the heading and vertical speed (m/s). */
  readonly v: Float32Array;
  readonly vy: Float32Array;
  readonly yaw: Float32Array;
  readonly pitch: Float32Array;
  readonly roll: Float32Array;
  /** Target and home (colony centre, burrow, pond, shoal area...). */
  readonly tx: Float64Array;
  readonly ty: Float64Array;
  readonly tz: Float64Array;
  readonly hx: Float64Array;
  readonly hy: Float64Array;
  readonly hz: Float64Array;
  /** Behaviour parameters (orbit radius, height, direction, ledge index...). */
  readonly a0: Float32Array;
  readonly a1: Float32Array;
  readonly a2: Float32Array;
  readonly a3: Float32Array;
  /** State timer and a second timer (flap bouts, breaths). */
  readonly tm: Float32Array;
  readonly tm2: Float32Array;
  /** Shader animation: gait clock, amplitude, pose, action. */
  readonly ph: Float32Array;
  readonly amp: Float32Array;
  readonly fold: Float32Array;
  readonly aux: Float32Array;
  readonly scale: Float32Array;
  /** Individual speed factor (animals differ a little). */
  readonly spd: Float32Array;
  /** 0 visible .. 1 hidden (in a burrow, not glowing, thread not catching light, deep under water). */
  readonly hide: Float32Array;
  /** Entrance fade: 1 just stepped out (drawn see-through) .. 0 fully there. Wears off by itself. */
  readonly ent: Float32Array;
  /** Seconds left hurrying away from lava (0 = not escaping). */
  readonly esc: Float32Array;
  /** The colony a seabird belongs to (its uid), or -1. */
  readonly col: Int32Array;
  /** Startle timer (the brush came close). */
  readonly flee: Float32Array;
  /** Group: member block (shoals, swarms, hatchlings) or pod leader slot (dolphins); -1 none. */
  readonly group: Int16Array;
  readonly members: Uint8Array;
  /** Seconds since the agent was last seen on screen. */
  readonly unseen: Float32Array;
  private next = 1;

  constructor(cap: number) {
    this.cap = cap;
    const f32 = () => new Float32Array(cap);
    const f64 = () => new Float64Array(cap);
    this.kind = new Int16Array(cap).fill(-1);
    this.life = new Uint8Array(cap);
    this.st = new Uint8Array(cap);
    this.serial = new Uint32Array(cap);
    this.x = f64();
    this.y = f64();
    this.z = f64();
    this.v = f32();
    this.vy = f32();
    this.yaw = f32();
    this.pitch = f32();
    this.roll = f32();
    this.tx = f64();
    this.ty = f64();
    this.tz = f64();
    this.hx = f64();
    this.hy = f64();
    this.hz = f64();
    this.a0 = f32();
    this.a1 = f32();
    this.a2 = f32();
    this.a3 = f32();
    this.tm = f32();
    this.tm2 = f32();
    this.ph = f32();
    this.amp = f32();
    this.fold = f32();
    this.aux = f32();
    this.scale = f32();
    this.spd = f32();
    this.hide = f32();
    this.ent = f32();
    this.esc = f32();
    this.col = new Int32Array(cap).fill(-1);
    this.flee = f32();
    this.group = new Int16Array(cap).fill(-1);
    this.members = new Uint8Array(cap);
    this.unseen = f32();
  }

  /** Claim a free slot (or -1). Everything is reset. */
  alloc(kind: number): number {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] !== Life.Free) continue;
      this.life[i] = Life.Live;
      this.kind[i] = kind;
      this.serial[i] = this.next++;
      this.st[i] = 0;
      this.v[i] = this.vy[i] = this.yaw[i] = this.pitch[i] = this.roll[i] = 0;
      this.a0[i] = this.a1[i] = this.a2[i] = this.a3[i] = 0;
      this.tm[i] = this.tm2[i] = 0;
      this.ph[i] = this.amp[i] = this.fold[i] = this.aux[i] = 0;
      this.hide[i] = this.flee[i] = this.unseen[i] = 0;
      this.ent[i] = this.esc[i] = 0;
      this.col[i] = -1;
      this.scale[i] = 1;
      this.spd[i] = 1;
      this.group[i] = -1;
      this.members[i] = 0;
      return i;
    }
    return -1;
  }

  free(i: number): void {
    this.life[i] = Life.Free;
    this.kind[i] = -1;
    this.group[i] = -1;
    this.members[i] = 0;
    this.col[i] = -1;
  }

  /** How much of the agent is drawn, 0..1 (the creature shader's presence). */
  presence(i: number): number {
    return (1 - this.hide[i]) * (1 - this.ent[i]);
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.life[i] !== Life.Free) n++;
    return n;
  }
}

/** Group members (fish in a shoal, fireflies in a swarm, hatchlings), in blocks of GROUP_SIZE. */
export class Members {
  readonly blocks: number;
  readonly used: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly ph: Float32Array;
  /** Fish: flank glint. Fireflies: blink phase. Hatchlings: emergence delay. */
  readonly w: Float32Array;
  readonly hide: Float32Array;
  readonly yaw: Float32Array;

  constructor(blocks: number) {
    this.blocks = blocks;
    const n = blocks * GROUP_SIZE;
    this.used = new Uint8Array(blocks);
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.ph = new Float32Array(n);
    this.w = new Float32Array(n);
    this.hide = new Float32Array(n);
    this.yaw = new Float32Array(n);
  }

  alloc(): number {
    for (let b = 0; b < this.blocks; b++) {
      if (!this.used[b]) {
        this.used[b] = 1;
        return b;
      }
    }
    return -1;
  }

  freeBlock(b: number): void {
    if (b >= 0) this.used[b] = 0;
  }

  freeCount(): number {
    let n = 0;
    for (let b = 0; b < this.blocks; b++) if (!this.used[b]) n++;
    return n;
  }
}

/** Short-lived effects: splashes, whale blows, duck wakes, flicked sand. A ring buffer. */
export class Particles {
  readonly n: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly size: Float32Array;
  readonly grow: Float32Array;
  readonly grav: Float32Array;
  readonly kind: Uint8Array;
  readonly rgba: Float32Array;
  private head = 0;

  constructor(n: number) {
    this.n = n;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.z = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.size = new Float32Array(n);
    this.grow = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.rgba = new Float32Array(n * 4);
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, grav: number, kind: number, r: number, g: number, b: number, a: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.n;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.grav[i] = grav;
    this.kind[i] = kind;
    this.rgba[i * 4] = r;
    this.rgba[i * 4 + 1] = g;
    this.rgba[i * 4 + 2] = b;
    this.rgba[i * 4 + 3] = a;
  }

  step(dt: number, windX: number, windZ: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) continue;
      this.age[i] += dt;
      const drag = Math.exp(-dt * 1.2);
      this.vx[i] = this.vx[i] * drag + windX * (1 - drag);
      this.vz[i] = this.vz[i] * drag + windZ * (1 - drag);
      this.vy[i] = this.vy[i] * drag - this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
    }
  }
}

// ---------- the simulation ----------

/** What the camera sees this frame (all the sim needs to know about the view). */
export interface FaunaView {
  /** Camera target (the orbit centre on the ground). */
  tx: number;
  tz: number;
  /** Camera position. */
  cx: number;
  cy: number;
  cz: number;
  /** Orbit distance. */
  dist: number;
  /** Pixels per metre at 1 m: drawing-buffer height / (2 tan(fov / 2)). */
  pxPerRad: number;
  frustum: THREE.Frustum;
}

/** The time, weather and hands this frame. */
export interface FaunaClock {
  /** Seconds since start (unwrapped). */
  t: number;
  dt: number;
  /** Day phase 0..1 (0 = start of dawn). */
  phase: number;
  /** How wet it is, 0..1 (wet season, recent rain): snails come out on wet nights. */
  wet: number;
  storm: StormState;
  /** Direction to the sun (lizards face it). */
  sunX: number;
  sunZ: number;
  brush: BrushInfo | null;
  stroking: boolean;
}

export interface FaunaOptions {
  seed: number;
  phone: boolean;
  /** quality.density (0.5..1.5). */
  density: number;
}

interface Census {
  /** Reservoir of patch indices per habitat code. */
  list: Int32Array;
  /** Patches per habitat code (all of them, not just the reservoir). */
  count: Int32Array;
  kept: Int32Array;
  /** Of those, patches inside the camera's view, and a reservoir of them. */
  inView: Int32Array;
  vlist: Int32Array;
  vkept: Int32Array;
  /** Distance from the camera to the nearest patch in view (m), per habitat code. */
  nearest: Float32Array;
}
const RESERVOIR = 48;

function makeCensus(): Census {
  return {
    list: new Int32Array(HABITAT_COUNT * RESERVOIR),
    count: new Int32Array(HABITAT_COUNT),
    kept: new Int32Array(HABITAT_COUNT),
    inView: new Int32Array(HABITAT_COUNT),
    vlist: new Int32Array(HABITAT_COUNT * RESERVOIR),
    vkept: new Int32Array(HABITAT_COUNT),
    nearest: new Float32Array(HABITAT_COUNT),
  };
}

function resetCensus(c: Census): void {
  c.count.fill(0);
  c.kept.fill(0);
  c.inView.fill(0);
  c.vkept.fill(0);
  c.nearest.fill(Infinity);
}

/**
 * A census being taken a few rows of patches per frame, so no single frame pays for the whole scan
 * (about 12,500 patches within 250 m). Finished censuses are swapped in whole.
 */
interface ScanJob {
  c: Census;
  cx: number;
  cz: number;
  /** Radius in patches, and the patch stride (the far census samples every 4th patch). */
  pr: number;
  stride: number;
  /** Also count what is on screen (the near census). */
  view: boolean;
  /** Next row offset to scan (-pr..pr). */
  dk: number;
  done: boolean;
}

/** Patches per row segment that share one frustum test (most segments are wholly in or out of view). */
const SEGMENT = 8;
/** Rows of patches scanned per frame (near census: about 8 frames for a full scan). */
const NEAR_ROWS_PER_FRAME = 16;
const FAR_ROWS_PER_FRAME = 10;
/** A new census starts this often (s). */
const CENSUS_PERIOD = 0.5;

/** A seabird colony and its nesting ledges. */
interface Colony {
  /** Stable id (agents remember which colony they nest in). */
  uid: number;
  sp: number;
  x: number;
  z: number;
  /** Typical ledge height (birds wheel around it), and the same eased for the speck flock. */
  y: number;
  yDraw: number;
  r: number;
  n: number;
  ledges: Float32Array; // x, y, z, facing yaw per ledge
  ledgeCount: number;
  taken: Uint8Array;
  /** The ground inside it changed: find its ledges again (not before `rebuildAt`, sim time). */
  dirty: boolean;
  rebuildAt: number;
}
const MAX_LEDGES = 32;
/** How far beyond its radius a colony's ledge search reads the ground (the seaward look-out). */
const COLONY_REACH = 30;

/** Where birds wait out a storm: the sheltered (downwind) side of each island. */
interface Lee {
  x: number;
  z: number;
  y: number;
}

export class FaunaSim {
  readonly A: Agents;
  readonly M: Members;
  readonly P: Particles;
  readonly kinds: Kind[];
  /** Agent cap for the current quality. */
  cap = 60;
  /** Agents wanted per kind after the cap (members for group kinds). */
  readonly want: Float32Array;
  private readonly have: Float32Array;
  /** Colony specks: x, y, z, beat, alpha, r, g, b per speck (filled every frame). */
  readonly specks: Float32Array;
  speckCount = 0;
  private readonly rng: Rng;
  private readonly fields: WorldFields;
  private life: LifeInfo | null = null;
  private readonly kindBySp: Int16Array;
  /** The census in use (front) and the one being taken (back), near and far. */
  private near = makeCensus();
  private far = makeCensus();
  private readonly nearJob: ScanJob = { c: makeCensus(), cx: 0, cz: 0, pr: 0, stride: 1, view: true, dk: 0, done: true };
  private readonly farJob: ScanJob = { c: makeCensus(), cx: 0, cz: 0, pr: 0, stride: 4, view: false, dk: 0, done: true };
  private colonies: Colony[] = [];
  private nextColonyUid = 1;
  private lees: Lee[] = [];
  /** Columns changed since the last frame (a rectangle in columns; x0 > x1 = none). */
  private colsDirty = { x0: 1, z0: 1, x1: 0, z1: 0 };
  private censusTimer = 0;
  private cutPending = true;
  private lastTx = 0;
  private lastTz = 0;
  private lastDist = 0;
  private spawnTokens = 0;
  private leaveTokens = 0;
  private colonyVersion = -1;
  private lifeVersion = 0;
  /** Frames stepped (spreads the lava checks over frames). */
  private frame = 0;
  /** Lava check results: how close the nearest molten lava is, and which way is away from it. */
  private lavaDist = Infinity;
  private awayX = 0;
  private awayZ = 0;
  /** A clutch has hatched this dawn (cleared once the dawn is over). */
  private hatched = false;
  private phone: boolean;
  private density: number;
  private readonly plantTopBySp: Float32Array;
  private readonly flowerBySp: Uint8Array;
  private readonly fruitBySp: Uint8Array;
  private readonly sphere = new THREE.Sphere();
  /** The view frustum's planes, packed for the census (see sphereClass). */
  private readonly planes = new Float64Array(24);
  private clock!: FaunaClock;
  private view!: FaunaView;
  private shelter = 0;

  constructor(species: readonly SpeciesDef[], fields: WorldFields, opts: FaunaOptions, tris: readonly number[]) {
    this.fields = fields;
    this.rng = new Rng(opts.seed);
    this.phone = opts.phone;
    this.density = opts.density;
    this.kinds = makeKinds(species, tris);
    this.kindBySp = new Int16Array(species.length).fill(-1);
    this.kinds.forEach((k, i) => (this.kindBySp[k.sp] = i));
    this.want = new Float32Array(this.kinds.length);
    this.have = new Float32Array(this.kinds.length);
    this.A = new Agents(200);
    this.M = new Members(12);
    this.P = new Particles(opts.phone ? 160 : 320);
    this.specks = new Float32Array(400 * 8);
    this.plantTopBySp = new Float32Array(species.length);
    this.flowerBySp = new Uint8Array(species.length);
    this.fruitBySp = new Uint8Array(species.length);
    for (const s of species) {
      if (!s.plant) continue;
      this.plantTopBySp[s.id] = plantTop(s.plant.model, s.plant.size);
      this.flowerBySp[s.id] = s.plant.flower !== undefined ? 1 : 0;
      this.fruitBySp[s.id] = s.plant.fruit !== undefined ? 1 : 0;
    }
    this.setQuality(opts.phone, opts.density);
    // Only the ground matters for nesting ledges, so colonies are re-examined when columns change
    // inside them (not on every ecology update).
    fields.onCols.push(this.onCols);
  }

  /** Stop listening to the world (the system is going away). */
  dispose(): void {
    const k = this.fields.onCols.indexOf(this.onCols);
    if (k >= 0) this.fields.onCols.splice(k, 1);
  }

  /** Columns changed: remember where (colonies there look for their ledges again). */
  private readonly onCols = (x0: number, z0: number, w: number, h: number): void => {
    const d = this.colsDirty;
    if (d.x0 > d.x1) {
      d.x0 = x0;
      d.z0 = z0;
      d.x1 = x0 + w - 1;
      d.z1 = z0 + h - 1;
    } else {
      d.x0 = Math.min(d.x0, x0);
      d.z0 = Math.min(d.z0, z0);
      d.x1 = Math.max(d.x1, x0 + w - 1);
      d.z1 = Math.max(d.z1, z0 + h - 1);
    }
  };

  /** Caps follow the device and quality.density: about 60 agents on a phone and 120 on a laptop. */
  setQuality(phone: boolean, density: number): void {
    this.phone = phone;
    this.density = density;
    this.cap = Math.round(clamp(density * (phone ? 75 : 100), 20, this.A.cap));
  }

  setLife(life: LifeInfo | null): void {
    if (life === this.life) return;
    this.life = life;
    this.lifeVersion++;
  }

  /** The world was replaced (a new sea or a load): everything goes at once. */
  clear(): void {
    for (let i = 0; i < this.A.cap; i++) if (this.A.life[i] !== Life.Free) this.release(i);
    this.cutPending = true;
    this.colonies = [];
    this.lees = [];
    this.colonyVersion = -1;
  }

  /** The next step may fill the view freely (the camera jumped). */
  cut(): void {
    this.cutPending = true;
  }

  // ---------- frame ----------

  step(clock: FaunaClock, view: FaunaView): void {
    this.clock = clock;
    this.view = view;
    this.frame++;
    const dt = clock.dt;
    const A = this.A;
    const jump = hyp(view.tx - this.lastTx, view.tz - this.lastTz);
    const zoom = this.lastDist > 0 ? view.dist / this.lastDist : 99;
    const cut = this.cutPending || jump > Math.max(40, this.lastDist * 0.3) || zoom > 1.8 || zoom < 1 / 1.8;
    this.cutPending = false;
    this.lastTx = view.tx;
    this.lastTz = view.tz;
    this.lastDist = view.dist;
    this.shelter = shelterLevel(clock.storm);

    if (this.lifeVersion !== this.colonyVersion) {
      this.colonyVersion = this.lifeVersion;
      this.syncColonies();
    }
    this.groundChanged();
    this.rebuildOneColony();
    this.census(cut, dt);
    if (cut) {
      for (let i = 0; i < A.cap; i++) {
        if (A.life[i] !== Life.Free && (this.outOfRange(i, 1) || !this.seen(i, this.kinds[A.kind[i]]))) this.release(i);
      }
    }
    this.spawnTokens = cut ? 1e9 : Math.min(3, this.spawnTokens + dt * 2.5);
    this.leaveTokens = Math.min(2, this.leaveTokens + dt * 1.5);
    this.populate(cut);
    this.hatchlings(cut);

    const brush = clock.stroking ? clock.brush : null;
    for (let i = 0; i < A.cap; i++) {
      if (A.life[i] === Life.Free) continue;
      const k = this.kinds[A.kind[i]];
      if (brush) {
        const reach = brush.r + (k.range === BIRD_RANGE || this.isFlyer(k.beh) ? 14 : 4);
        if (hyp(A.x[i] - brush.x, A.z[i] - brush.z) < reach) A.flee[i] = 4;
      }
      if (A.flee[i] > 0) A.flee[i] -= dt;
      if (A.ent[i] > 0) A.ent[i] = Math.max(0, A.ent[i] - dt * ENTRANCE_RATE);
      // Lava: each agent looks around every few frames (a flow moves a metre or two a second at most).
      if (A.esc[i] <= 0 && (this.frame + i) % LAVA_CHECK_FRAMES === 0) this.lavaCheck(i, k);
      if (A.life[i] === Life.Free) continue; // it slipped away (a crab under lava, a hidden snail)
      if (A.esc[i] > 0) this.escape(i, k, dt);
      else this.update(i, k, dt);
      if (A.life[i] === Life.Free) continue; // it went quietly during its update
      const seen = this.seen(i, k);
      A.unseen[i] = seen ? 0 : A.unseen[i] + dt;
      if (A.unseen[i] > 0.25 && (A.life[i] === Life.Leaving || this.outOfRange(i, 1.25) || (A.unseen[i] > UNSEEN_RECYCLE && !this.framed(i, k)))) this.release(i);
    }
    this.P.step(dt, WIND_TO_X * 1.5, WIND_TO_Z * 1.5);
    this.fillSpecks(dt);
  }

  /** Live agents (not counting free slots). */
  liveCount(): number {
    return this.A.count();
  }

  // ---------- what the camera sees ----------

  /** Pixel size of something `size` metres across at a world point (0 if off screen). */
  apparentPx(x: number, y: number, z: number, size: number): number {
    return apparentPx(this.view, this.sphere, x, y, z, size);
  }

  /**
   * Is the agent (or any of its members) visibly on screen right now? "Visibly" = its size in pixels
   * times how much of it is drawn (presence) is at least one pixel.
   */
  seen(i: number, k: Kind): boolean {
    return this.visiblePx(i, k, true) >= 1;
  }

  /** Is the agent in frame and big enough to see, however faded? (A diving whale is still "there".) */
  private framed(i: number, k: Kind): boolean {
    return this.visiblePx(i, k, false) >= 1;
  }

  /** The biggest on-screen size (px) of the agent or its members, times presence if `faded`. */
  visiblePx(i: number, k: Kind, faded: boolean): number {
    const A = this.A;
    const vis = faded ? A.presence(i) : 1;
    if (vis <= 0.02) return 0;
    if (A.group[i] >= 0 && (k.group || (k.beh === B.nestBeach && A.st[i] === T_HATCH))) {
      const M = this.M;
      const m0 = A.group[i] * GROUP_SIZE;
      const span = k.beh === B.glow ? 0.5 : k.group ? k.span : 0.08;
      let best = 0;
      for (let m = m0; m < m0 + A.members[i]; m++) {
        const mv = faded ? 1 - M.hide[m] : 1;
        if (mv <= 0.02) continue;
        best = Math.max(best, this.apparentPx(M.x[m], M.y[m], M.z[m], span) * mv * vis);
      }
      return best;
    }
    const span = k.beh === B.web ? (A.fold[i] > 0.05 ? 0.6 + A.a0[i] : k.span) : (k.span * A.scale[i]) / k.size;
    return this.apparentPx(A.x[i], A.y[i], A.z[i], span) * vis;
  }

  /** Would a new animal of this kind be seen if it appeared here? */
  private wouldSee(k: Kind, x: number, y: number, z: number): boolean {
    // With a margin: individuals vary in size, swimmers settle a little from where they were placed,
    // and a flyer covers some ground in its first moments.
    return this.apparentPx(x, y, z, k.span * 1.25 + k.vmax * 0.1) >= 0.6;
  }

  private outOfRange(i: number, k: number): boolean {
    const kind = this.kinds[this.A.kind[i]];
    return hyp(this.A.x[i] - this.view.tx, this.A.z[i] - this.view.tz) > kind.range * k;
  }

  private isFlyer(beh: number): boolean {
    return beh === B.colony || beh === B.soar || beh === B.flit || beh === B.nightFly || beh === B.flutter || beh === B.hover || beh === B.buzz;
  }

  // ---------- world queries ----------

  ground(x: number, z: number): number {
    return this.fields.heightAt(x, z);
  }

  hab(x: number, z: number): number {
    const p = this.fields.patchIndex(x, z);
    return p < 0 ? Habitat.None : this.fields.habitat[p];
  }

  okAt(k: Kind, x: number, z: number): boolean {
    return ((k.allowed >>> this.hab(x, z)) & 1) === 1 && this.fields.lavaAt(x, z) < 0.02;
  }

  /**
   * Does an animal here throw a shadow? Only on or near dry ground or in the shallowest water: a duck
   * on a deep pond or a bird high overhead would print a crisp shadow far below, stretched down the
   * slope, on ground the water or the distance should hide.
   */
  castsShadow(x: number, y: number, z: number, size: number): boolean {
    const g = this.ground(x, z);
    return y - g < 1.5 + size && this.surface(x, z) - g < 1;
  }

  /** Pond level if (x, z) is inside a known pond's water, else NaN. */
  pondLevel(x: number, z: number): number {
    const ponds = this.life?.ponds;
    if (!ponds) return NaN;
    for (let i = 0; i < ponds.length; i++) {
      const p = ponds[i];
      if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1 && this.ground(x, z) < p.level) return p.level;
    }
    return NaN;
  }

  /** The water surface over (x, z): a pond's level, or the moving sea. */
  surface(x: number, z: number): number {
    const pond = this.pondLevel(x, z);
    if (pond === pond) return pond;
    const depth = Math.max(0, -this.ground(x, z));
    return seaHeight(x, z, this.clock.t, this.clock.storm.level, depth);
  }

  /** Height of the tallest plant top in a patch (m above ground), with its cover. */
  private plantTopAt(p: number): number {
    const pl = this.fields.plants;
    const o = p * PLANT_BYTES;
    const can = pl[o] - 1;
    if (can >= 0 && pl[o + 1] > 60) return this.plantTopBySp[can] || 8;
    const sh = pl[o + 2] - 1;
    if (sh >= 0 && pl[o + 3] > 60) return this.plantTopBySp[sh] || 1.5;
    return 0;
  }

  /** Cover a small animal can hide under (shrub or canopy), 0..1. */
  private coverAt(x: number, z: number): number {
    const p = this.fields.patchIndex(x, z);
    if (p < 0) return 0;
    const o = p * PLANT_BYTES;
    return Math.max(this.fields.plants[o + 1], this.fields.plants[o + 3], this.fields.plants[o + 5] * 0.6) / 255;
  }

  // ---------- lava ----------

  /** Is there molten lava within r of (x, z)? (The point and a ring of eight around it.) */
  lavaNear(x: number, z: number, r: number): boolean {
    const f = this.fields;
    if (f.lavaAt(x, z) > 0.02) return true;
    for (let s = 0; s < 8; s++) {
      const a = s * (TAU / 8);
      if (f.lavaAt(x + Math.cos(a) * r, z + Math.sin(a) * r) > 0.02) return true;
    }
    return false;
  }

  /** Look for lava around a point (two rings out to LAVA_ALARM): sets lavaDist and the way away from it. */
  private senseLava(x: number, z: number): void {
    const f = this.fields;
    this.lavaDist = f.lavaAt(x, z) > 0.02 ? 0 : Infinity;
    let ax = 0;
    let az = 0;
    for (let ring = 1; ring <= 2; ring++) {
      const r = LAVA_ALARM * ring * 0.5;
      for (let s = 0; s < 8; s++) {
        const a = (s + ring * 0.5) * (TAU / 8);
        const ux = Math.cos(a);
        const uz = Math.sin(a);
        if (f.lavaAt(x + ux * r, z + uz * r) <= 0.02) continue;
        if (r < this.lavaDist) this.lavaDist = r;
        ax -= ux / ring;
        az -= uz / ring;
      }
    }
    const l = hyp(ax, az);
    this.awayX = l > 1e-6 ? ax / l : 0;
    this.awayZ = l > 1e-6 ? az / l : 0;
  }

  /**
   * Molten lava close to an animal sends it away calmly: flyers, waders and swimmers simply startle
   * (they lift off or move off), walkers hurry to safe ground, crabs dig a new burrow elsewhere, and
   * the smallest (snails, spiders, fireflies) slip out of sight.
   */
  private lavaCheck(i: number, k: Kind): void {
    const A = this.A;
    if (A.life[i] === Life.Free) return;
    // Anything well above the ground (soaring, wheeling) is in no danger.
    if (A.y[i] > Math.max(this.ground(A.x[i], A.z[i]), 0) + 12) return;
    if (k.beh === B.colony && (A.st[i] === C_APPROACH || A.st[i] === C_FLARE) && this.lavaNear(A.tx[i], A.tz[i], LAVA_SAFE)) {
      // The ledge it was heading for is by the lava now: wheel again and pick another later.
      this.freeLedge(i);
      A.st[i] = C_ORBIT;
      A.tm[i] = 5 + this.rng.next() * 10;
      return;
    }
    this.senseLava(A.x[i], A.z[i]);
    if (this.lavaDist === Infinity) return;
    const onLand = this.surface(A.x[i], A.z[i]) - this.ground(A.x[i], A.z[i]) < 0.15;
    switch (k.beh) {
      case B.bask:
      case B.graze:
        this.startEscape(i, k);
        return;
      case B.scuttle:
        // Already underground (or going): its burrow is going under, and it is never seen again.
        if (A.st[i] === K_HIDDEN || A.st[i] === K_BURROW) this.leave(i);
        else this.startEscape(i, k);
        return;
      case B.nestBeach:
        if (A.st[i] !== T_HATCH && onLand) this.startEscape(i, k);
        else A.flee[i] = Math.max(A.flee[i], 3);
        return;
      case B.haulOut:
        if (onLand && A.st[i] !== E_SWIM && A.st[i] !== E_IN) this.startEscape(i, k);
        else A.flee[i] = Math.max(A.flee[i], 3);
        return;
      case B.creep:
      case B.web:
      case B.glow:
        this.leave(i);
        A.flee[i] = Math.max(A.flee[i], 3);
        return;
      default:
        A.flee[i] = Math.max(A.flee[i], 3);
    }
  }

  /** How fast a walker hurries from lava (m/s): a good deal faster than it ambles, within its cap. */
  private escapeSpeed(k: Kind): number {
    return Math.min(k.vmax, Math.max(k.look.speed * 2.5, 0.3));
  }

  /**
   * Send a walker to the nearest safe ground away from the lava (turtles and seals to the sea if it is
   * close). With nowhere safe in reach it heads straight away from the lava and goes once unseen.
   */
  private startEscape(i: number, k: Kind): void {
    const A = this.A;
    const sea = this.swimsToo(k);
    if (!this.findRefuge(i, k, sea) && !(sea && this.findRefuge(i, k, false))) {
      const ax = this.awayX || Math.sin(A.yaw[i]);
      const az = this.awayZ || Math.cos(A.yaw[i]);
      A.tx[i] = A.x[i] + ax * 25;
      A.tz[i] = A.z[i] + az * 25;
      if (A.life[i] === Life.Live) A.life[i] = Life.Leaving;
    }
    A.esc[i] = 40;
    A.flee[i] = 0;
  }

  /**
   * The nearest spot within 30 m out of the lava's reach (none within LAVA_ALARM, so it can settle
   * there): on the kind's own habitats if possible, out in water at least 0.8 m deep if `water`.
   * Prefers spots away from the lava. Writes the target and returns true, or false if there is none.
   */
  private findRefuge(i: number, k: Kind, water: boolean): boolean {
    const A = this.A;
    const x = A.x[i];
    const z = A.z[i];
    for (let ring = 0; ring < REFUGE_RINGS.length; ring++) {
      const r = REFUGE_RINGS[ring];
      let best = -Infinity;
      for (let s = 0; s < 12; s++) {
        const a = (s + ring * 0.37) * (TAU / 12);
        const ux = Math.sin(a);
        const uz = Math.cos(a);
        const px = x + ux * r;
        const pz = z + uz * r;
        const depth = this.surface(px, pz) - this.ground(px, pz);
        if (water ? depth < 0.8 : depth > 0.02) continue;
        if (this.lavaNear(px, pz, LAVA_SAFE) || this.lavaNear(px, pz, LAVA_ALARM)) continue;
        const own = (k.allowed >>> this.hab(px, pz)) & 1;
        const score = ux * this.awayX + uz * this.awayZ + own * 1.5;
        if (score > best) {
          best = score;
          A.tx[i] = px;
          A.tz[i] = pz;
        }
      }
      if (best > -Infinity) return true;
    }
    return false;
  }

  /** Hurrying away from lava; once on safe ground the animal settles back into its own ways. */
  private escape(i: number, k: Kind, dt: number): void {
    const A = this.A;
    A.esc[i] -= dt;
    const speed = this.escapeSpeed(k) * A.spd[i];
    A.hide[i] = Math.max(0, A.hide[i] - dt * 2); // a lizard that was tucking under leaves comes out to run
    let d: number;
    if (k.beh === B.scuttle) {
      d = this.crabStep(i, k, speed, dt, WALK_ESCAPE);
      this.anim(i, 14, 1, 0, 0, dt);
    } else {
      d = this.walkTo(i, k, A.tx[i], A.tz[i], speed, 3, dt, WALK_ESCAPE);
      if (this.swimsToo(k)) this.surfaceOrGround(i, k, dt);
      const hz = k.beh === B.bask ? 9 : k.beh === B.graze ? 0.7 : 1.2;
      this.anim(i, hz, 1, 0, k.beh === B.graze ? 0.2 : 0, dt);
    }
    if (d >= 0.1 && A.esc[i] > 0) return;
    A.esc[i] = 0;
    // Walled in (by the sea, for a land animal) with lava still close: it goes once nobody is looking.
    // Meanwhile the next lava check sends it off again, maybe another way.
    if (d < 0 && A.life[i] === Life.Live && this.lavaNear(A.x[i], A.z[i], LAVA_SAFE)) A.life[i] = Life.Leaving;
    // Safe: back to its own ways (the next lava check sends it on again if the flow keeps coming).
    switch (k.beh) {
      case B.bask:
        A.st[i] = L_BASK;
        A.tm[i] = 2 + this.rng.next() * 4;
        return;
      case B.graze:
        A.st[i] = G_REST;
        A.tm[i] = 10 + this.rng.next() * 10;
        return;
      case B.scuttle:
        A.hx[i] = A.x[i];
        A.hz[i] = A.z[i];
        A.st[i] = K_BURROW;
        A.tm[i] = 0;
        return;
      case B.nestBeach:
        A.st[i] = this.surface(A.x[i], A.z[i]) - this.ground(A.x[i], A.z[i]) > 0.8 ? T_SWIM : T_DOWN;
        A.a1[i] = 0;
        A.tm[i] = 300;
        return;
      case B.haulOut:
        A.st[i] = this.surface(A.x[i], A.z[i]) - this.ground(A.x[i], A.z[i]) > 0.7 ? E_SWIM : E_DOWN;
        A.a1[i] = 0;
        A.tm[i] = 90;
        return;
    }
  }

  // ---------- census and colonies ----------

  /**
   * Keep the census fresh. Normally a new one is taken every half second, a few rows per frame, and
   * swapped in when done; after a cut (the camera jumped) it is taken at once so the view fills now.
   */
  private census(cut: boolean, dt: number): void {
    this.censusTimer -= dt;
    const nj = this.nearJob;
    const fj = this.farJob;
    if (cut) {
      // The whole census at once (into the back tables), then swapped in.
      this.startScan(nj, NEAR_RANGE);
      this.startScan(fj, BIRD_RANGE);
      this.scanRows(nj, Infinity);
      this.scanRows(fj, Infinity);
    } else {
      if (nj.done && fj.done) {
        if (this.censusTimer > 0) return;
        this.startScan(nj, NEAR_RANGE);
        this.startScan(fj, BIRD_RANGE);
      }
      const nearDone = this.scanRows(nj, NEAR_ROWS_PER_FRAME);
      const farDone = this.scanRows(fj, FAR_ROWS_PER_FRAME);
      if (!nearDone || !farDone) return;
    }
    // Swap the finished census in; the old one becomes the next back buffer.
    this.censusTimer = CENSUS_PERIOD;
    const n = this.near;
    this.near = nj.c;
    nj.c = n;
    const f = this.far;
    this.far = fj.c;
    fj.c = f;
    this.planCounts();
  }

  private startScan(job: ScanJob, r: number): void {
    job.cx = this.view.tx;
    job.cz = this.view.tz;
    job.pr = Math.ceil(r / PATCH_M);
    job.dk = -job.pr;
    job.done = false;
    resetCensus(job.c);
  }

  /** Scan up to `maxRows` more rows of a census job. Returns true once the job is finished. */
  private scanRows(job: ScanJob, maxRows: number): boolean {
    if (job.done) return true;
    const c = job.c;
    const v = this.view;
    const surf = this.fields.surf;
    const hab = this.fields.habitat;
    const planes = this.planes;
    packPlanes(v.frustum, planes);
    const pr = job.pr;
    const stride = job.stride;
    const pi0 = Math.floor((job.cx - ORIGIN_X) / PATCH_M);
    const pk0 = Math.floor((job.cz - ORIGIN_Z) / PATCH_M);
    const r2 = pr * pr;
    let rows = 0;
    for (; job.dk <= pr && rows < maxRows; job.dk += stride, rows++) {
      const dk = job.dk;
      const pk = pk0 + dk;
      if (pk < 0 || pk >= NP) continue;
      // The row's span inside the circle, on the stride grid.
      const half = Math.floor(Math.sqrt(Math.max(0, r2 - dk * dk)) / stride) * stride;
      const z = ORIGIN_Z + (pk + 0.5) * PATCH_M;
      for (let s0 = -half; s0 <= half; s0 += SEGMENT * stride) {
        const s1 = Math.min(half, s0 + (SEGMENT - 1) * stride);
        // One frustum test for the whole segment: wholly in view, wholly out, or test each patch.
        // (The radius allows for the ground rising or falling along it; a tall pillar may be
        // misjudged, which only nudges where new animals are tried.)
        let cls = -1;
        if (job.view) {
          const piM = clamp(pi0 + Math.round((s0 + s1) / 2), 0, NP - 1);
          const yM = Math.max(0, surf[piM * PATCH + 1 + (pk * PATCH + 1) * NX]);
          cls = sphereClass(planes, ORIGIN_X + (piM + 0.5) * PATCH_M, yM, z, ((s1 - s0 + 1) * PATCH_M) / 2 + PATCH_M + 20);
        }
        for (let di = s0; di <= s1; di += stride) {
          const pi = pi0 + di;
          if (pi < 0 || pi >= NP) continue;
          const p = pi + pk * NP;
          const h = hab[p];
          if (cls >= 0) {
            // Is this patch on screen, and how far is it from the eye?
            const x = ORIGIN_X + (pi + 0.5) * PATCH_M;
            const y = Math.max(0, surf[pi * PATCH + 1 + (pk * PATCH + 1) * NX]);
            const inView = cls === 1 || (cls === 0 && sphereClass(planes, x, y, z, PATCH_M) >= 0);
            if (inView) {
              const nv = c.inView[h]++;
              if (nv < RESERVOIR) {
                c.vlist[h * RESERVOIR + nv] = p;
                c.vkept[h] = nv + 1;
              } else {
                const j = this.rng.int(nv + 1);
                if (j < RESERVOIR) c.vlist[h * RESERVOIR + j] = p;
              }
              const dx = x - v.cx;
              const dy = y - v.cy;
              const dz = z - v.cz;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 < c.nearest[h]) c.nearest[h] = d2;
            }
          }
          const n = c.count[h]++;
          if (n < RESERVOIR) {
            c.list[h * RESERVOIR + n] = p;
            c.kept[h] = n + 1;
          } else {
            const j = this.rng.int(n + 1);
            if (j < RESERVOIR) c.list[h * RESERVOIR + j] = p;
          }
        }
      }
    }
    if (job.dk <= pr) return false;
    // Nearest distances were kept squared while scanning.
    if (job.view) for (let h = 0; h < HABITAT_COUNT; h++) if (c.nearest[h] < Infinity) c.nearest[h] = Math.sqrt(c.nearest[h]);
    job.done = true;
    return true;
  }

  /** A random patch of the kind's habitats from a census, or -1. */
  private pickPatch(c: Census, mask: number, inView = false): number {
    const count = inView ? c.inView : c.count;
    const kept = inView ? c.vkept : c.kept;
    const list = inView ? c.vlist : c.list;
    let total = 0;
    for (let h = 0; h < HABITAT_COUNT; h++) if ((mask >>> h) & 1) total += count[h];
    if (total === 0) return inView ? this.pickPatch(c, mask, false) : -1;
    let r = this.rng.int(total);
    for (let h = 0; h < HABITAT_COUNT; h++) {
      if (!((mask >>> h) & 1)) continue;
      if (r < count[h]) return kept[h] > 0 ? list[h * RESERVOIR + this.rng.int(kept[h])] : -1;
      r -= count[h];
    }
    return -1;
  }

  /** Population of a species near a point (0..1), from the islands whose bounds reach it. */
  popNear(sp: number, x: number, z: number, pad: number): number {
    const life = this.life;
    if (!life) return 0;
    let n = 0;
    for (const pop of life.pops) {
      if (pop.species !== sp || pop.n <= 0) continue;
      let bbox: [number, number, number, number] | null = null;
      for (const isl of life.islands) if (isl.id === pop.island) bbox = isl.bbox;
      if (!bbox) {
        n = Math.max(n, pop.n);
        continue;
      }
      if (x >= bbox[0] - pad && x <= bbox[2] + pad && z >= bbox[1] - pad && z <= bbox[3] + pad) n = Math.max(n, pop.n);
    }
    return n;
  }

  /**
   * Match the colonies to the latest life message. A colony that is still there (same species, place
   * and size) keeps its ledges and who sits on them; only new or changed ones look for ledges. Each
   * island's lee (where birds wait out storms) is found again too.
   */
  private syncColonies(): void {
    const life = this.life;
    const old = this.colonies;
    const next: Colony[] = [];
    for (const c of life ? life.colonies : []) {
      let col: Colony | null = null;
      for (let o = 0; o < old.length; o++) {
        const p = old[o];
        if (p.sp === c.species && Math.abs(p.x - c.x) < 0.5 && Math.abs(p.z - c.z) < 0.5 && Math.abs(p.r - c.r) < 0.5) col = p;
      }
      if (col) col.n = c.n;
      else {
        col = { uid: this.nextColonyUid++, sp: c.species, x: c.x, z: c.z, y: 0, yDraw: NaN, r: c.r, n: c.n, ledges: new Float32Array(MAX_LEDGES * 4), ledgeCount: 0, taken: new Uint8Array(MAX_LEDGES), dirty: false, rebuildAt: 0 };
        this.findLedges(col);
      }
      next.push(col);
    }
    // A colony that changed (it grew, or moved a little) carries its birds over to its successor, each
    // keeping the ledge at its spot. Birds of a colony that has gone keep what they are doing, without
    // a ledge to come back to.
    for (let o = 0; o < old.length; o++) {
      const p = old[o];
      if (next.indexOf(p) >= 0) continue;
      let succ: Colony | null = null;
      for (let c = 0; c < next.length; c++) {
        const q = next[c];
        if (q.sp === p.sp && hyp(q.x - p.x, q.z - p.z) < Math.max(p.r, q.r)) succ = q;
      }
      if (succ) this.adopt(p.uid, succ);
      else this.orphan(p.uid);
    }
    this.colonies = next;
    this.lees = [];
    if (!life) return;
    for (const isl of life.islands) {
      const [x0, z0, x1, z1] = isl.bbox;
      const cx = isl.centroid[0];
      const cz = isl.centroid[1];
      // Walk from the downwind edge toward the centre until there is land to sit on.
      let lx = cx + (WIND_TO_X * (x1 - x0)) / 2;
      let lz = cz + (WIND_TO_Z * (z1 - z0)) / 2;
      for (let s = 0; s < 40; s++) {
        if (this.ground(lx, lz) > 1.5) break;
        lx += (cx - lx) * 0.08;
        lz += (cz - lz) * 0.08;
      }
      this.lees.push({ x: lx, z: lz, y: Math.max(0, this.ground(lx, lz)) });
    }
  }

  /** Mark colonies whose ground changed since the last frame (from the columns stream). */
  private groundChanged(): void {
    const d = this.colsDirty;
    if (d.x0 > d.x1) return;
    const x0 = ORIGIN_X + d.x0 * CELL;
    const z0 = ORIGIN_Z + d.z0 * CELL;
    const x1 = ORIGIN_X + (d.x1 + 1) * CELL;
    const z1 = ORIGIN_Z + (d.z1 + 1) * CELL;
    d.x0 = 1;
    d.x1 = 0;
    for (let ci = 0; ci < this.colonies.length; ci++) {
      const c = this.colonies[ci];
      const R = c.r + COLONY_REACH;
      if (x1 >= c.x - R && x0 <= c.x + R && z1 >= c.z - R && z0 <= c.z + R) c.dirty = true;
    }
  }

  /**
   * Find the ledges of one changed colony again (at most one per frame, and each colony at most every
   * couple of seconds while lava or sand is still moving there).
   */
  private rebuildOneColony(): void {
    const t = this.clock.t;
    for (let ci = 0; ci < this.colonies.length; ci++) {
      const c = this.colonies[ci];
      if (!c.dirty || t < c.rebuildAt) continue;
      c.dirty = false;
      c.rebuildAt = t + 2;
      this.findLedges(c);
      this.remapLedges(c);
      return;
    }
  }

  /**
   * Look for nesting ledges in a colony. The search is seeded by the colony itself (its place and
   * species), so looking again over the same ground finds exactly the same ledges, and ground that
   * changed only moves the ledges on it.
   */
  private findLedges(col: Colony): void {
    const seed = Math.round(col.x * 4) * 7919 + Math.round(col.z * 4) * 104729 + col.sp * 31;
    col.ledgeCount = 0;
    col.taken.fill(0);
    let sum = 0;
    // Two passes: first ledges that look out over the sea (cliff tops and shelves), then, if the
    // colony has too few of those, any footing with a drop beside it (or flat ground on a low islet).
    for (let pass = 0; pass < 2 && col.ledgeCount < 8; pass++) {
      for (let t = 0; t < 160 && col.ledgeCount < MAX_LEDGES; t++) {
        const a = hash2(t, pass * 2, seed) * TAU;
        const d = Math.sqrt(hash2(t, pass * 2 + 1, seed)) * col.r;
        const x = col.x + Math.cos(a) * d;
        const z = col.z + Math.sin(a) * d;
        const h = this.ground(x, z);
        if (h < 2 || this.fields.lavaAt(x, z) > 0.02) continue;
        const gx = (this.ground(x + 1.5, z) - this.ground(x - 1.5, z)) / 3;
        const gz = (this.ground(x, z + 1.5) - this.ground(x, z - 1.5)) / 3;
        if (hyp(gx, gz) > 0.9) continue;
        // Fairly flat footing with a drop close by; the bird faces out over the drop.
        let best = 0;
        let face = 0;
        for (let s = 0; s < 8; s++) {
          const b = (s / 8) * TAU;
          const drop = h - this.ground(x + Math.sin(b) * 5, z + Math.cos(b) * 5);
          if (drop > best) {
            best = drop;
            face = b;
          }
        }
        if (best < 2.5 && h > 4) continue;
        const seaward = this.ground(x + Math.sin(face) * 25, z + Math.cos(face) * 25) < 2;
        if (pass === 0 && !seaward) continue;
        const o = col.ledgeCount * 4;
        col.ledges[o] = x;
        col.ledges[o + 1] = h;
        col.ledges[o + 2] = z;
        col.ledges[o + 3] = face;
        col.ledgeCount++;
        sum += h;
      }
    }
    col.y = col.ledgeCount > 0 ? sum / col.ledgeCount : Math.max(0, this.ground(col.x, col.z));
    if (col.yDraw !== col.yDraw) col.yDraw = col.y;
  }

  /**
   * After a colony's ledges were found again: each bird that held a ledge keeps the one now at its
   * spot. One whose ledge is gone flies off again (landing birds go back to wheeling; a perched
   * bird stays put unless the ground under it moved).
   */
  private remapLedges(col: Colony): void {
    const A = this.A;
    for (let i = 0; i < A.cap; i++) if (A.life[i] !== Life.Free && A.col[i] === col.uid && A.a3[i] >= 0) this.reclaimLedge(i, col);
  }

  /** A bird that held a ledge takes the free ledge of `col` at its spot, or goes without one. */
  private reclaimLedge(i: number, col: Colony): void {
    const A = this.A;
    let best = -1;
    let bd = 1.5;
    for (let l = 0; l < col.ledgeCount; l++) {
      const o = l * 4;
      const d = hyp(col.ledges[o] - A.tx[i], col.ledges[o + 2] - A.tz[i]);
      if (d < bd && !col.taken[l] && Math.abs(col.ledges[o + 1] - A.ty[i]) < 1) {
        bd = d;
        best = l;
      }
    }
    A.a3[i] = best;
    if (best >= 0) {
      col.taken[best] = 1;
      return;
    }
    const st = A.st[i];
    if (st === C_APPROACH || st === C_FLARE) {
      A.st[i] = C_ORBIT;
      A.tm[i] = 5 + this.rng.next() * 10;
    } else if (st === C_PERCH && Math.abs(this.ground(A.x[i], A.z[i]) - A.y[i]) > 0.3) {
      A.st[i] = C_DROP;
      A.tm[i] = 0;
      this.takeOff(i);
    }
  }

  /** Move the birds of colony `uid` to colony `to`, keeping the ledges they hold (by place). */
  private adopt(uid: number, to: Colony): void {
    const A = this.A;
    for (let i = 0; i < A.cap; i++) {
      if (A.life[i] === Life.Free || A.col[i] !== uid) continue;
      A.col[i] = to.uid;
      A.hx[i] = to.x;
      A.hz[i] = to.z;
      if (A.a3[i] >= 0) this.reclaimLedge(i, to);
    }
  }

  /** Birds of a colony that is gone: no ledge to hold, no colony to return to. */
  private orphan(uid: number): void {
    const A = this.A;
    for (let i = 0; i < A.cap; i++) {
      if (A.life[i] === Life.Free || A.col[i] !== uid) continue;
      A.col[i] = -1;
      A.a3[i] = -1;
      if (A.st[i] === C_APPROACH || A.st[i] === C_FLARE) A.st[i] = C_ORBIT;
    }
  }

  /** The colony with this uid, or null. */
  private colonyById(uid: number): Colony | null {
    if (uid < 0) return null;
    for (let ci = 0; ci < this.colonies.length; ci++) if (this.colonies[ci].uid === uid) return this.colonies[ci];
    return null;
  }

  private colonyFor(sp: number): Colony | null {
    let best: Colony | null = null;
    let bd = Infinity;
    for (let ci = 0; ci < this.colonies.length; ci++) {
      const c = this.colonies[ci];
      if (c.sp !== sp) continue;
      const d = hyp(c.x - this.view.tx, c.z - this.view.tz);
      if (d < BIRD_RANGE + c.r && d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  private nearestLee(x: number, z: number): Lee | null {
    let best: Lee | null = null;
    let bd = Infinity;
    for (let li = 0; li < this.lees.length; li++) {
      const l = this.lees[li];
      const d = hyp(l.x - x, l.z - z);
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    return bd < 900 ? best : null;
  }

  // ---------- how many of each ----------

  /** Wanted agents per kind: population x habitat in view x time of day x apparent size, then capped. */
  private planCounts(): void {
    const v = this.view;
    const phase = this.clock.phase;
    let total = 0;
    let tris = 0;
    for (let ki = 0; ki < this.kinds.length; ki++) {
      const k = this.kinds[ki];
      const look = k.look;
      let act = activityLevel(look.active, phase);
      if (k.beh === B.colony) act = Math.max(act, 0.6); // seabirds roost on their ledges at night
      if (k.beh === B.nestBeach) act = Math.max(act, 0.5); // turtles swim the shallows by day
      if (k.beh === B.creep) act *= smooth(0.25, 0.6, this.clock.wet);
      if (k.beh === B.web) act = Math.max(act, 0.5);
      const shelterHide = this.isFlyer(k.beh) && k.beh !== B.colony && k.beh !== B.soar ? this.shelter : k.beh === B.scuttle || k.beh === B.bask ? this.shelter : 0;
      act *= 1 - shelterHide;
      const col = k.beh === B.colony ? this.colonyFor(k.sp) : null;
      // Habitat on screen counts fully; habitat nearby but out of view only a little (the camera may
      // turn, and new animals can always come in from off screen).
      let all = 0;
      let seen = 0;
      let nearest = Infinity;
      for (let h = 0; h < HABITAT_COUNT; h++) {
        if (!((k.where >>> h) & 1)) continue;
        all += this.near.count[h];
        seen += this.near.inView[h];
        if (this.near.nearest[h] < nearest) nearest = this.near.nearest[h];
      }
      // How big would one look: at the colony, or at the nearest patch of its habitat in view.
      const px = col ? hyp3(col.x - v.cx, col.y - v.cy, col.z - v.cz) : nearest < Infinity ? nearest : hyp(v.dist, NEAR_RANGE * 0.5);
      const vis = smooth(0.6, 2.5, (k.span * v.pxPerRad) / Math.max(1, px));
      const presence = col ? 1 : Math.min(1, Math.min(1, seen / 20) + 0.15 * Math.min(1, (all - seen) / 20));
      let pop = this.popNear(k.sp, v.tx, v.tz, k.range * 0.6);
      if (col) pop = Math.max(pop, col.n);
      const popF = pop > 0 ? Math.min(1, 0.3 + pop) : 0;
      // Far colonies are drawn as the speck flock instead of agents; a colony behind the camera keeps a few.
      let near = 1;
      if (col) {
        this.sphere.center.set(col.x, col.y + 15, col.z);
        this.sphere.radius = col.r + 30;
        near = (1 - smooth(COLONY_NEAR, COLONY_FAR, hyp3(col.x - v.cx, col.y - v.cy, col.z - v.cz))) * (v.frustum.intersectsSphere(this.sphere) ? 1 : 0.3);
      }
      let w = look.max * this.density * popF * act * vis * presence * near;
      if (k.group) w = Math.min(w, (this.M.blocks / 2) * GROUP_SIZE);
      this.want[ki] = w;
      total += k.group ? Math.ceil(w / GROUP_SIZE) : w;
      tris += w * Math.max(1, k.tris);
    }
    const scale = Math.min(1, this.cap / Math.max(1, total), TRI_BUDGET / Math.max(1, tris));
    for (let ki = 0; ki < this.kinds.length; ki++) this.want[ki] *= scale;
  }

  /** Spawn toward the wanted counts and send extras away (rate-limited unless the camera cut). */
  private populate(cut: boolean): void {
    const A = this.A;
    const have = this.have;
    have.fill(0);
    let live = 0;
    for (let i = 0; i < A.cap; i++) {
      if (A.life[i] === Life.Free) continue;
      live++;
      if (A.life[i] === Life.Live) have[A.kind[i]] += this.headcount(i);
    }
    for (let ki = 0; ki < this.kinds.length; ki++) {
      const k = this.kinds[ki];
      const want = this.want[ki];
      while (have[ki] < want - 0.5 && this.spawnTokens >= 1 && live < this.cap) {
        if (!this.spawn(ki, cut)) break;
        this.spawnTokens -= 1;
        have[ki] = 0;
        live = 0;
        for (let i = 0; i < A.cap; i++) {
          if (A.life[i] === Life.Free) continue;
          live++;
          if (A.kind[i] === ki && A.life[i] === Life.Live) have[ki] += this.headcount(i);
        }
      }
      if (have[ki] > want + 0.9 && (this.leaveTokens >= 1 || cut)) {
        // The one least in view leaves first.
        let pick = -1;
        let best = -1;
        for (let i = 0; i < A.cap; i++) {
          if (A.kind[i] !== ki || A.life[i] !== Life.Live || this.headcount(i) === 0) continue;
          const score = A.unseen[i] + hyp(A.x[i] - this.view.tx, A.z[i] - this.view.tz) * 0.01;
          if (score > best) {
            best = score;
            pick = i;
          }
        }
        if (pick >= 0) {
          if (cut || !this.seen(pick, k)) this.release(pick);
          else this.leave(pick);
          this.leaveTokens -= 1;
        }
      }
    }
  }

  /** How many animals an agent stands for (a shoal counts its fish; a clutch of hatchlings is extra). */
  private headcount(i: number): number {
    const A = this.A;
    const k = this.kinds[A.kind[i]];
    if (k.beh === B.nestBeach && A.st[i] === T_HATCH) return 0;
    return k.group ? A.members[i] : 1;
  }

  private release(i: number): void {
    const A = this.A;
    if (A.group[i] >= 0 && (this.kinds[A.kind[i]]?.group || A.members[i] > 0)) this.M.freeBlock(A.group[i]);
    this.freeLedge(i);
    A.free(i);
  }

  /** Start leaving the quiet way for this behaviour. */
  leave(i: number): void {
    const A = this.A;
    if (A.life[i] !== Life.Live) return;
    A.life[i] = Life.Leaving;
    this.freeLedge(i);
    // Hurrying from lava: it keeps heading for safe ground, and goes once out of sight.
    if (A.esc[i] > 0) return;
    const k = this.kinds[A.kind[i]];
    // Pick an exit direction away from the camera target.
    const dx = A.x[i] - this.view.tx;
    const dz = A.z[i] - this.view.tz;
    const d = hyp(dx, dz) || 1;
    const far = this.isFlyer(k.beh) ? 500 : 120;
    A.tx[i] = A.x[i] + (dx / d) * far;
    A.tz[i] = A.z[i] + (dz / d) * far;
    A.ty[i] = A.y[i] + (this.isFlyer(k.beh) ? 30 : 0);
  }

  // ---------- spawning ----------

  /** Place one new agent of a kind (or a whole pod or group). Returns true if one appeared. */
  private spawn(ki: number, cut: boolean): boolean {
    const k = this.kinds[ki];
    const census = k.range === BIRD_RANGE && this.rng.next() < 0.4 ? this.far : this.near;
    for (let attempt = 0; attempt < 6; attempt++) {
      let x: number;
      let z: number;
      const col = k.beh === B.colony ? this.colonyFor(k.sp) : null;
      if (col) {
        const a = this.rng.next() * TAU;
        const d = Math.sqrt(this.rng.next()) * col.r;
        x = col.x + Math.cos(a) * d;
        z = col.z + Math.sin(a) * d;
      } else {
        const p = this.pickPatch(census, k.where, census === this.near && this.rng.next() < 0.75);
        if (p < 0) return false;
        x = ORIGIN_X + ((p % NP) + this.rng.next()) * PATCH_M;
        z = ORIGIN_Z + (Math.floor(p / NP) + this.rng.next()) * PATCH_M;
        if (this.popNear(k.sp, x, z, k.range === BIRD_RANGE ? 200 : 60) <= 0 || this.lavaNear(x, z, LAVA_ALARM)) continue;
      }
      const i = this.A.alloc(ki);
      if (i < 0) return false;
      const A = this.A;
      A.scale[i] = k.size * (0.88 + this.rng.next() * 0.24);
      A.spd[i] = 0.85 + this.rng.next() * 0.25;
      A.ph[i] = this.rng.next() * TAU;
      A.yaw[i] = this.rng.next() * TAU;
      A.hx[i] = x;
      A.hz[i] = z;
      A.hy[i] = this.ground(x, z);
      if (this.init(i, k, x, z, cut, col)) return true;
      this.release(i);
    }
    return false;
  }

  /** Put a new agent in its first state. False = no good place this time. */
  private init(i: number, k: Kind, x: number, z: number, cut: boolean, col: Colony | null): boolean {
    const A = this.A;
    const g = this.ground(x, z);
    switch (k.beh) {
      case B.colony: {
        // Wheel close round the nesting ledges, from just above them to a few tens of metres up.
        const R = col ? col.r * (0.45 + this.rng.next() * 0.6) : 40 + this.rng.next() * 40;
        A.a0[i] = R;
        A.a1[i] = 6 + this.rng.next() * 24;
        A.a2[i] = this.rng.next() < 0.5 ? 1 : -1;
        A.a3[i] = -1;
        if (col) {
          A.col[i] = col.uid;
          A.hx[i] = col.x;
          A.hz[i] = col.z;
        }
        A.hy[i] = col ? col.y : 0;
        A.tm[i] = 8 + this.rng.next() * 30;
        if (cut && col && col.ledgeCount > 0 && this.rng.next() < 0.5 && this.takeLedge(i, col)) {
          this.land(i, k);
          return true;
        }
        const a = this.rng.next() * TAU;
        const px = A.hx[i] + Math.cos(a) * R;
        const pz = A.hz[i] + Math.sin(a) * R;
        const py = A.hy[i] + A.a1[i];
        A.st[i] = C_ORBIT;
        A.v[i] = k.look.speed * 0.9;
        A.yaw[i] = Math.atan2(-Math.sin(a) * A.a2[i], Math.cos(a) * A.a2[i]);
        return this.placeFlyer(i, k, px, py, pz, cut);
      }
      case B.soar: {
        A.a0[i] = 60 + this.rng.next() * 60;
        A.a1[i] = 50 + this.rng.next() * 80;
        A.a2[i] = this.rng.next() < 0.5 ? 1 : -1;
        A.st[i] = S_CIRCLE;
        A.tm[i] = 20 + this.rng.next() * 30;
        A.v[i] = k.look.speed * 0.8;
        const a = this.rng.next() * TAU;
        return this.placeFlyer(i, k, x + Math.cos(a) * A.a0[i], Math.max(0, g) + A.a1[i], z + Math.sin(a) * A.a0[i], cut);
      }
      case B.flit:
      case B.nightFly: {
        const p = this.findPerch(x, z, 30, k.beh === B.nightFly);
        if (p < 0) return false;
        this.perchPoint(i, p, k.beh === B.nightFly);
        if (cut || !this.wouldSee(k, A.tx[i], A.ty[i], A.tz[i])) {
          A.x[i] = A.tx[i];
          A.y[i] = A.ty[i];
          A.z[i] = A.tz[i];
          A.st[i] = k.beh === B.flit ? F_PERCH : N_HANG;
          A.fold[i] = 1;
          A.tm[i] = 2 + this.rng.next() * 8;
          if (k.beh === B.nightFly) A.pitch[i] = -Math.PI / 2;
          return true;
        }
        A.st[i] = k.beh === B.flit ? F_FLY : N_FLY;
        A.v[i] = k.look.speed;
        return this.placeFlyer(i, k, A.tx[i], A.ty[i] + 4, A.tz[i], false);
      }
      case B.wade: {
        if (!this.wadeSpot(i, k, x, z, 12)) return false;
        if (cut || !this.wouldSee(k, A.tx[i], A.ty[i], A.tz[i])) {
          A.x[i] = A.tx[i];
          A.y[i] = A.ty[i];
          A.z[i] = A.tz[i];
          A.st[i] = W_STAND;
          A.fold[i] = 1;
          A.tm[i] = 10 + this.rng.next() * 60;
          return true;
        }
        A.st[i] = W_FLY;
        A.v[i] = 6;
        return this.placeFlyer(i, k, A.tx[i], A.ty[i] + 6, A.tz[i], false);
      }
      case B.runShore: {
        if (!this.shorePoint(i, k, x, z, 0.15)) return false;
        A.a2[i] = this.rng.next() < 0.5 ? 1 : -1;
        A.a3[i] = this.rng.next() * TAU;
        if (cut || !this.wouldSee(k, A.tx[i], A.ty[i], A.tz[i])) {
          A.x[i] = A.tx[i];
          A.y[i] = A.ty[i];
          A.z[i] = A.tz[i];
          A.st[i] = R_PECK;
          A.fold[i] = 1;
          A.tm[i] = 1;
          return true;
        }
        A.st[i] = R_FLY;
        A.a1[i] = 1; // flying in to the shore point already chosen
        A.v[i] = 8;
        return this.placeFlyer(i, k, A.tx[i], A.ty[i] + 3, A.tz[i], false);
      }
      case B.paddle: {
        if (!this.waterPoint(i, k, x, z, 0.15, 10)) return false;
        if (cut || !this.wouldSee(k, A.tx[i], A.ty[i], A.tz[i])) {
          A.x[i] = A.tx[i];
          A.z[i] = A.tz[i];
          A.y[i] = this.surface(A.x[i], A.z[i]);
          A.st[i] = P_SWIM;
          A.fold[i] = 1;
          A.tm[i] = 3 + this.rng.next() * 6;
          return true;
        }
        A.st[i] = P_FLY;
        A.v[i] = 9;
        return this.placeFlyer(i, k, A.tx[i], A.ty[i] + 8, A.tz[i], false);
      }
      case B.scuttle: {
        if (!this.okAt(k, x, z) || this.ground(x, z) < 0.15) return false;
        A.st[i] = K_HIDDEN;
        A.x[i] = x;
        A.z[i] = z;
        A.y[i] = g - A.scale[i] * 0.6;
        A.hide[i] = 1;
        A.tm[i] = cut ? this.rng.next() * 2 : 1 + this.rng.next() * 6;
        A.yaw[i] = this.rng.next() * TAU;
        return true;
      }
      case B.bask:
      case B.graze:
      case B.creep: {
        if (!this.okAt(k, x, z) || g < 0.2) return false;
        if (!cut && this.wouldSee(k, x, g, z)) {
          // In view, it may only step out from under a shrub (fading in as it comes out).
          if (this.coverAt(x, z) <= (k.beh === B.graze ? 0.6 : 0.4)) return false;
          A.ent[i] = 1;
        }
        A.x[i] = x;
        A.z[i] = z;
        A.y[i] = g;
        A.st[i] = 0;
        A.tm[i] = 2 + this.rng.next() * 10;
        if (k.beh === B.creep) A.fold[i] = cut ? 0 : 1;
        return true;
      }
      case B.nestBeach:
      case B.glideSea:
      case B.porpoise:
      case B.surfaceBlow:
      case B.haulOut: {
        const minDepth = k.beh === B.surfaceBlow ? 15 : k.beh === B.porpoise ? 2.5 : k.beh === B.haulOut ? 1.2 : 0.8;
        if (k.beh === B.haulOut && cut && this.beachRest(i, k, x, z)) return true;
        if (!this.waterPoint(i, k, x, z, minDepth, 30)) return false;
        const sx = A.tx[i];
        const sz = A.tz[i];
        const sy = this.swimDepth(i, k, sx, sz);
        if (!cut && this.wouldSee(k, sx, sy, sz)) return false;
        A.x[i] = sx;
        A.z[i] = sz;
        A.y[i] = sy;
        A.st[i] = 0;
        A.v[i] = k.look.speed * 0.6;
        A.tm[i] = 10 + this.rng.next() * 30;
        A.tm2[i] = 5 + this.rng.next() * 25;
        if (k.beh === B.surfaceBlow) A.hide[i] = smooth(3, 6, this.surface(sx, sz) - sy); // deep: unseen
        if (k.beh === B.nestBeach) A.st[i] = T_SWIM;
        if (k.beh === B.porpoise) this.spawnPod(i, k, cut);
        return true;
      }
      case B.shoal: {
        if (!this.waterPoint(i, k, x, z, 0.8, 12)) return false;
        const b = this.M.alloc();
        if (b < 0) return false;
        A.group[i] = b;
        const have = this.groupMembers(this.kindBySp[k.sp]);
        const n = clamp(Math.round(this.want[this.kindBySp[k.sp]] - have), 4, GROUP_SIZE);
        A.members[i] = n;
        A.x[i] = A.tx[i];
        A.z[i] = A.tz[i];
        A.y[i] = this.swimDepth(i, k, A.x[i], A.z[i]);
        this.initMembers(i, k, 1.6);
        if (!cut) {
          // The whole shoal swims in from out of view: no fish may start on screen.
          const m0 = b * GROUP_SIZE;
          for (let m = m0; m < m0 + n; m++) if (this.wouldSee(k, this.M.x[m], this.M.y[m], this.M.z[m])) return false;
        }
        A.st[i] = 0;
        A.tm[i] = 0;
        return true;
      }
      case B.glow: {
        if (!this.okAt(k, x, z) || g < 0.3) return false;
        const b = this.M.alloc();
        if (b < 0) return false;
        A.group[i] = b;
        const have = this.groupMembers(this.kindBySp[k.sp]);
        A.members[i] = clamp(Math.round(this.want[this.kindBySp[k.sp]] - have), 4, GROUP_SIZE);
        A.x[i] = x;
        A.z[i] = z;
        A.y[i] = g + 1.5;
        A.hide[i] = 1; // lights up gradually
        this.initMembers(i, k, 5);
        return true;
      }
      case B.flutter:
      case B.hover:
      case B.buzz: {
        const fy = g + (k.beh === B.hover ? 0.6 : 0.8);
        if (k.beh === B.hover) {
          const pond = this.pondLevel(x, z);
          if (pond !== pond && !this.okAt(k, x, z)) return false;
          A.hy[i] = pond === pond ? pond : Math.max(g, 0);
        } else A.hy[i] = Math.max(g, 0);
        A.tx[i] = x;
        A.ty[i] = Math.max(fy, A.hy[i] + 0.5);
        A.tz[i] = z;
        A.st[i] = 0;
        A.v[i] = k.look.speed * 0.6;
        return this.placeFlyer(i, k, x, A.ty[i], z, cut, 25);
      }
      case B.web: {
        if (!this.okAt(k, x, z) || g < 0.2) return false;
        const top = Math.max(0.5, this.plantTopAt(this.fields.patchIndex(x, z)) * 0.8);
        A.x[i] = x;
        A.z[i] = z;
        A.hy[i] = g + top; // the silk's anchor
        A.a0[i] = cut ? 0.3 + this.rng.next() * 0.6 : 0; // thread length
        A.a1[i] = 0.25 + this.rng.next() * 0.7; // where it will settle
        A.y[i] = A.hy[i] - A.a0[i];
        A.hide[i] = A.a0[i] < 0.01 ? 1 : 0; // up under its leaf until it lowers itself
        A.st[i] = 0;
        return true;
      }
      default:
        return false;
    }
  }

  /** Spawn the rest of a dolphin pod (2-5 more, as many as are wanted) around a new leader. */
  private spawnPod(lead: number, k: Kind, cut: boolean): void {
    const A = this.A;
    const ki = A.kind[lead];
    let have = 0;
    for (let i = 0; i < A.cap; i++) if (A.kind[i] === ki && A.life[i] === Life.Live) have++;
    const size = Math.min(2 + this.rng.int(4), Math.round(this.want[ki] - have));
    for (let n = 0; n < size && A.count() < this.cap; n++) {
      const j = A.alloc(ki);
      if (j < 0) return;
      const ox = (this.rng.next() - 0.5) * 8;
      const oz = (this.rng.next() - 0.5) * 8;
      const x = A.x[lead] + ox;
      const z = A.z[lead] + oz;
      if (!this.okAt(k, x, z) || (!cut && this.wouldSee(k, x, A.y[lead], z))) {
        A.free(j);
        continue;
      }
      A.scale[j] = k.size * (0.85 + this.rng.next() * 0.25);
      A.spd[j] = 0.9 + this.rng.next() * 0.2;
      A.x[j] = x;
      A.z[j] = z;
      A.y[j] = A.y[lead];
      A.yaw[j] = A.yaw[lead];
      A.group[j] = lead;
      A.a0[j] = ox;
      A.a1[j] = oz;
      A.tm2[j] = 1 + this.rng.next() * 4;
      A.v[j] = A.v[lead];
    }
  }

  private groupMembers(ki: number): number {
    let n = 0;
    for (let i = 0; i < this.A.cap; i++) if (this.A.kind[i] === ki && this.A.life[i] !== Life.Free) n += this.A.members[i];
    return n;
  }

  /** Scatter a group's members around its centre. */
  private initMembers(i: number, k: Kind, spread: number): void {
    const A = this.A;
    const M = this.M;
    const m0 = A.group[i] * GROUP_SIZE;
    for (let m = m0; m < m0 + A.members[i]; m++) {
      M.x[m] = A.x[i] + (this.rng.next() - 0.5) * spread * 2;
      M.z[m] = A.z[i] + (this.rng.next() - 0.5) * spread * 2;
      if (k.beh === B.shoal && this.surface(M.x[m], M.z[m]) - this.ground(M.x[m], M.z[m]) < 0.5) {
        // Fish start in the water with the shoal, never on the shore.
        M.x[m] = A.x[i] + (this.rng.next() - 0.5) * 0.4;
        M.z[m] = A.z[i] + (this.rng.next() - 0.5) * 0.4;
      }
      M.y[m] = A.y[i] + (this.rng.next() - 0.5) * (k.beh === B.glow ? 2 : 0.6);
      M.vx[m] = M.vy[m] = M.vz[m] = 0;
      M.ph[m] = this.rng.next() * TAU;
      M.w[m] = this.rng.next() * TAU;
      M.hide[m] = 0;
      M.yaw[m] = this.rng.next() * TAU;
    }
  }

  /**
   * Put a flying animal at its first position: on a cut, right there; otherwise off screen on a
   * line from where it is heading (it then flies in).
   */
  private placeFlyer(i: number, k: Kind, px: number, py: number, pz: number, cut: boolean, reach = 160): boolean {
    const A = this.A;
    if (cut || !this.wouldSee(k, px, py, pz)) {
      A.x[i] = px;
      A.y[i] = py;
      A.z[i] = pz;
      return true;
    }
    for (let t = 0; t < 10; t++) {
      const a = this.rng.next() * TAU;
      const d = reach * (0.35 + this.rng.next() * 0.65);
      const sx = px + Math.cos(a) * d;
      const sz = pz + Math.sin(a) * d;
      const sy = Math.max(py, this.ground(sx, sz) + 4);
      if (!this.wouldSee(k, sx, sy, sz)) {
        A.x[i] = sx;
        A.y[i] = sy;
        A.z[i] = sz;
        A.yaw[i] = Math.atan2(px - sx, pz - sz);
        return true;
      }
    }
    return false;
  }

  // ---------- places to stand ----------

  /** A crown or shrub top near (x, z) within r (fruiting trees preferred by bats). Returns a patch or -1. */
  private findPerch(x: number, z: number, r: number, fruit: boolean): number {
    let fallback = -1;
    for (let t = 0; t < 18; t++) {
      const a = this.rng.next() * TAU;
      const d = Math.sqrt(this.rng.next()) * r;
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      const p = this.fields.patchIndex(px, pz);
      if (p < 0 || this.lavaNear(px, pz, LAVA_SAFE)) continue;
      const o = p * PLANT_BYTES;
      const pl = this.fields.plants;
      const tall = pl[o + 1] > 90 ? pl[o] - 1 : pl[o + 3] > 110 ? pl[o + 2] - 1 : -1;
      if (tall < 0) continue;
      if (!fruit || this.fruitBySp[tall]) return p;
      fallback = p;
    }
    return fallback;
  }

  /** Target = the top of the plant in patch p. */
  private perchPoint(i: number, p: number, hang: boolean): void {
    const A = this.A;
    const x = ORIGIN_X + ((p % NP) + 0.3 + this.rng.next() * 0.4) * PATCH_M;
    const z = ORIGIN_Z + (Math.floor(p / NP) + 0.3 + this.rng.next() * 0.4) * PATCH_M;
    const top = this.plantTopAt(p);
    A.tx[i] = x;
    A.tz[i] = z;
    A.ty[i] = this.ground(x, z) + top * (hang ? 0.8 : 0.96);
  }

  /** A spot in shallow water (0.03..0.3 m deep) or at the very edge, near (x, z). */
  private wadeSpot(i: number, k: Kind, x: number, z: number, r: number): boolean {
    const A = this.A;
    for (let t = 0; t < 24; t++) {
      const a = this.rng.next() * TAU;
      const d = this.rng.next() * r;
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      if (!this.okAt(k, px, pz)) continue;
      const g = this.ground(px, pz);
      const s = this.surface(px, pz);
      const depth = s - g;
      if (depth > -0.15 && depth < 0.3) {
        A.tx[i] = px;
        A.tz[i] = pz;
        A.ty[i] = g;
        return true;
      }
    }
    return false;
  }

  /** The swash line (the ground at `h` above the water) near (x, z), along the shore. */
  private shorePoint(i: number, k: Kind, x: number, z: number, h: number): boolean {
    const A = this.A;
    let px = x;
    let pz = z;
    for (let it = 0; it < 6; it++) {
      const g = this.ground(px, pz);
      const gx = (this.ground(px + 1, pz) - this.ground(px - 1, pz)) / 2;
      const gz = (this.ground(px, pz + 1) - this.ground(px, pz - 1)) / 2;
      const g2 = gx * gx + gz * gz;
      if (g2 < 1e-5) return false;
      const err = g - (this.surface(px, pz) + h);
      const step = clamp(err / g2, -4, 4);
      px -= gx * step;
      pz -= gz * step;
    }
    if (hyp(px - x, pz - z) > 25 || !this.okAt(k, px, pz)) return false;
    A.tx[i] = px;
    A.tz[i] = pz;
    A.ty[i] = this.ground(px, pz);
    return true;
  }

  /** Open water at least `depth` deep within r of (x, z), on the kind's habitats. */
  private waterPoint(i: number, k: Kind, x: number, z: number, depth: number, r: number): boolean {
    const A = this.A;
    for (let t = 0; t < 16; t++) {
      const a = this.rng.next() * TAU;
      const d = t === 0 ? 0 : this.rng.next() * r;
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      if (!this.okAt(k, px, pz)) continue;
      if (this.surface(px, pz) - this.ground(px, pz) < depth) continue;
      A.tx[i] = px;
      A.tz[i] = pz;
      A.ty[i] = this.surface(px, pz);
      return true;
    }
    return false;
  }

  /** A seal already resting on the beach (only on a cut). */
  private beachRest(i: number, k: Kind, x: number, z: number): boolean {
    const A = this.A;
    if (!this.shorePoint(i, k, x, z, 0.9) || !this.okAt(k, A.tx[i], A.tz[i])) return false;
    A.x[i] = A.tx[i];
    A.z[i] = A.tz[i];
    A.y[i] = this.ground(A.x[i], A.z[i]);
    A.st[i] = E_REST;
    A.tm[i] = 20 + this.rng.next() * 60;
    this.faceDownhill(i);
    return true;
  }

  /** Swimming depth for a swimmer at (x, z): rays near the bottom, sharks and turtles mid-water, whales deeper. */
  private swimDepth(i: number, k: Kind, x: number, z: number): number {
    const s = this.surface(x, z);
    const g = this.ground(x, z);
    const body = this.A.scale[i] * 0.12;
    let y: number;
    if (k.plan === AnimalModel.Ray) y = g + 0.35 + body;
    else if (k.beh === B.surfaceBlow) y = s - Math.min(6, (s - g) * 0.5);
    else if (k.beh === B.shoal) y = Math.max(g + 0.4, s - 1.2);
    else y = Math.max(g + 0.3 + body, s - 1.0 - body);
    return Math.min(y, s - 0.25 - body);
  }

  private takeLedge(i: number, col: Colony): boolean {
    const start = this.rng.int(col.ledgeCount);
    for (let n = 0; n < col.ledgeCount; n++) {
      const l = (start + n) % col.ledgeCount;
      if (col.taken[l] || this.lavaNear(col.ledges[l * 4], col.ledges[l * 4 + 2], LAVA_SAFE)) continue;
      col.taken[l] = 1;
      const A = this.A;
      if (A.col[i] !== col.uid) {
        // Joining this colony (its own has gone): wheel round this one from now on.
        A.col[i] = col.uid;
        A.hx[i] = col.x;
        A.hz[i] = col.z;
        A.hy[i] = col.y;
      }
      A.a3[i] = l;
      A.tx[i] = col.ledges[l * 4];
      A.ty[i] = col.ledges[l * 4 + 1];
      A.tz[i] = col.ledges[l * 4 + 2];
      A.a2[i] = A.a2[i] === 0 ? 1 : A.a2[i];
      A.tm2[i] = col.ledges[l * 4 + 3];
      return true;
    }
    return false;
  }

  /** No ledge free at nightfall: settle on open ground in the colony, facing downhill. */
  private groundRoost(i: number, col: Colony): boolean {
    const A = this.A;
    for (let t = 0; t < 12; t++) {
      const a = this.rng.next() * TAU;
      const d = Math.sqrt(this.rng.next()) * col.r;
      const x = col.x + Math.cos(a) * d;
      const z = col.z + Math.sin(a) * d;
      const h = this.ground(x, z);
      const gx = this.ground(x + 1, z) - this.ground(x - 1, z);
      const gz = this.ground(x, z + 1) - this.ground(x, z - 1);
      if (h < 1.5 || hyp(gx, gz) > 1.2 || this.lavaNear(x, z, LAVA_SAFE)) continue;
      A.a3[i] = -1;
      A.tx[i] = x;
      A.ty[i] = h;
      A.tz[i] = z;
      A.tm2[i] = Math.atan2(-gx, -gz);
      return true;
    }
    return false;
  }

  private freeLedge(i: number): void {
    const A = this.A;
    const k = this.kinds[A.kind[i]];
    if (!k || k.beh !== B.colony || A.a3[i] < 0) return;
    const col = this.colonyById(A.col[i]);
    if (col && A.a3[i] < col.ledgeCount) col.taken[A.a3[i]] = 0;
    A.a3[i] = -1;
  }

  /** Settle a colony bird onto its ledge. */
  private land(i: number, k: Kind): void {
    const A = this.A;
    A.x[i] = A.tx[i];
    A.y[i] = A.ty[i];
    A.z[i] = A.tz[i];
    A.st[i] = C_PERCH;
    A.fold[i] = 1;
    A.amp[i] = 0;
    A.v[i] = 0;
    A.vy[i] = 0;
    A.pitch[i] = 0;
    A.roll[i] = 0;
    A.yaw[i] = A.tm2[i] + (this.rng.next() - 0.5) * 1.2;
    A.tm[i] = this.clock && activityLevel(k.look.active, this.clock.phase) < 0.3 ? 60 + this.rng.next() * 60 : 12 + this.rng.next() * 50;
  }

  private faceDownhill(i: number): void {
    const A = this.A;
    const gx = this.ground(A.x[i] + 1, A.z[i]) - this.ground(A.x[i] - 1, A.z[i]);
    const gz = this.ground(A.x[i], A.z[i] + 1) - this.ground(A.x[i], A.z[i] - 1);
    A.yaw[i] = Math.atan2(-gx, -gz);
  }

  // ---------- moving ----------

  /** Advance the shader gait clock and ease the pose toward targets. */
  private anim(i: number, hz: number, amp: number, fold: number, aux: number, dt: number): void {
    const A = this.A;
    A.ph[i] = (A.ph[i] + hz * TAU * dt) % PHASE_WRAP;
    A.amp[i] = approach(A.amp[i], amp, dt * 6);
    A.fold[i] = approach(A.fold[i], fold, dt * 5);
    A.aux[i] = approach(A.aux[i], aux, dt * 8);
  }

  /**
   * Fly toward a point: turn at a limited rate, ease speed and climb, bank into turns.
   * Returns the horizontal distance left.
   */
  private flyTo(i: number, k: Kind, tx: number, ty: number, tz: number, speed: number, dt: number, minClear = 2): number {
    const A = this.A;
    const dx = tx - A.x[i];
    const dz = tz - A.z[i];
    const dh = hyp(dx, dz);
    const v = A.v[i];
    const rate = Math.min(4, Math.max(0.6, (1.6 * Math.max(v, 1)) / Math.max(dh, 1)));
    const want = Math.atan2(dx, dz);
    const yaw0 = A.yaw[i];
    A.yaw[i] = turnToward(yaw0, want, rate * dt);
    const turn = wrapAngle(A.yaw[i] - yaw0) / Math.max(dt, 1e-3);
    A.v[i] = approach(v, Math.min(speed, k.vmax), dt * 1.2);
    // Look ahead so the climb over rising ground starts early (never a sudden hop).
    const ax = A.x[i] + Math.sin(A.yaw[i]) * A.v[i] * 1.5;
    const az = A.z[i] + Math.cos(A.yaw[i]) * A.v[i] * 1.5;
    const floor = Math.max(this.ground(A.x[i], A.z[i]), this.surface(A.x[i], A.z[i]), this.ground(ax, az), this.surface(ax, az)) + minClear;
    const need = floor - A.y[i];
    // Rising ground ahead: climb hard, and slow down only as much as the climb needs (as at a cliff).
    if (need > 0) {
      const vyNeed = need / 1.5;
      A.v[i] = Math.min(A.v[i], Math.max(1, Math.sqrt(Math.max(0, k.vmax * k.vmax - vyNeed * vyNeed))));
    }
    const climb = clamp((Math.max(ty, floor) - A.y[i]) * 0.7, -A.v[i] * 0.7, need > 0 ? k.vmax : A.v[i] * 0.6 + 1);
    A.vy[i] = approach(A.vy[i], climb, dt * 3);
    this.limit(i, k);
    const nx = A.x[i] + Math.sin(A.yaw[i]) * A.v[i] * dt;
    const nz = A.z[i] + Math.cos(A.yaw[i]) * A.v[i] * dt;
    const ny = A.y[i] + A.vy[i] * dt;
    const under = Math.max(this.ground(nx, nz), this.surface(nx, nz)) + 0.3;
    if (ny >= under) {
      A.x[i] = nx;
      A.z[i] = nz;
      A.y[i] = ny;
    } else {
      // Skimming the ground: ride up over it, trading forward speed for the rise (never faster than the cap).
      const maxStep = k.vmax * dt;
      const rise = under - A.y[i];
      if (Math.abs(rise) >= maxStep) {
        A.y[i] += Math.sign(rise) * maxStep;
        A.v[i] *= 0.5;
      } else {
        const fwd = Math.min(A.v[i] * dt, Math.sqrt(maxStep * maxStep - rise * rise));
        A.x[i] += Math.sin(A.yaw[i]) * fwd;
        A.z[i] += Math.cos(A.yaw[i]) * fwd;
        A.y[i] = under;
      }
      A.vy[i] = 0;
    }
    A.roll[i] = approach(A.roll[i], clamp(-Math.atan((A.v[i] * turn) / 9.8), -0.75, 0.75), dt * 3);
    A.pitch[i] = approach(A.pitch[i], Math.atan2(A.vy[i], Math.max(A.v[i], 0.5)), dt * 3);
    return dh;
  }

  /**
   * The last metre or two of a landing: straight in, braking, then down on the spot (no jump).
   * Returns true once it is down.
   */
  private settle(i: number, k: Kind, tx: number, ty: number, tz: number, dt: number): boolean {
    const A = this.A;
    const dx = tx - A.x[i];
    const dy = ty - A.y[i];
    const dz = tz - A.z[i];
    const d = hyp3(dx, dy, dz);
    const v = Math.min(k.vmax, Math.max(0.4, Math.min(A.v[i] + 0.5, d * 2.5)));
    const step = Math.min(d, v * dt);
    if (d > 1e-4) {
      A.x[i] += (dx / d) * step;
      A.y[i] += (dy / d) * step;
      A.z[i] += (dz / d) * step;
      if (hyp(dx, dz) > 0.05) A.yaw[i] = turnToward(A.yaw[i], Math.atan2(dx, dz), dt * 6);
    }
    A.v[i] = v;
    A.vy[i] = 0;
    A.pitch[i] = approach(A.pitch[i], 0.35, dt * 4);
    A.roll[i] = approach(A.roll[i], 0, dt * 6);
    if (d - step > 0.02) return false;
    A.v[i] = 0;
    A.pitch[i] = 0;
    A.roll[i] = 0;
    return true;
  }

  /** Within this (horizontal) distance a flyer stops steering and settles straight in. */
  private landRadius(i: number): number {
    return Math.max(1.2, this.A.v[i] * 0.45);
  }

  /** Keep the agent's combined speed under its hard cap. */
  private limit(i: number, k: Kind): void {
    const A = this.A;
    const s = hyp(A.v[i], A.vy[i]);
    if (s > k.vmax) {
      A.v[i] *= k.vmax / s;
      A.vy[i] *= k.vmax / s;
    }
  }

  /**
   * Walk toward a point on the ground: turn first, then move along the heading. `mode` says what may
   * be stepped on: WALK_HABITAT (the allowed habitats, no lava), WALK_NO_LAVA (anything but lava: a
   * turtle or seal getting back to the sea) or WALK_ESCAPE (anything a land animal can stand on,
   * lava included: hurrying off a flow). Returns the distance left, or -1 if the way is blocked.
   */
  private walkTo(i: number, k: Kind, tx: number, tz: number, speed: number, turnRate: number, dt: number, mode = WALK_HABITAT): number {
    const A = this.A;
    const dx = tx - A.x[i];
    const dz = tz - A.z[i];
    const d = hyp(dx, dz);
    if (d < 0.005) {
      A.v[i] = 0;
      return 0;
    }
    const want = Math.atan2(dx, dz);
    A.yaw[i] = turnToward(A.yaw[i], want, turnRate * dt);
    const err = Math.abs(wrapAngle(want - A.yaw[i]));
    const v = Math.min(speed, k.vmax) * Math.max(0, Math.cos(err));
    const step = Math.min(d, v * dt);
    const nx = A.x[i] + Math.sin(A.yaw[i]) * step;
    const nz = A.z[i] + Math.cos(A.yaw[i]) * step;
    if (!this.canStep(k, nx, nz, mode)) {
      A.v[i] = 0;
      return -1;
    }
    A.x[i] = nx;
    A.z[i] = nz;
    A.v[i] = v;
    A.vy[i] = 0;
    this.stickToGround(i, k);
    return d - step;
  }

  /** May a walker of this kind step onto (x, z)? See walkTo for the modes. */
  private canStep(k: Kind, x: number, z: number, mode: number): boolean {
    if (mode === WALK_HABITAT) return this.okAt(k, x, z);
    if (mode === WALK_NO_LAVA) return this.fields.lavaAt(x, z) < 0.02;
    return this.swimsToo(k) || this.surface(x, z) - this.ground(x, z) < 0.05;
  }

  /** Animals that crawl on land but are at home in the sea (turtles, seals). */
  private swimsToo(k: Kind): boolean {
    return k.beh === B.nestBeach || k.beh === B.haulOut;
  }

  /** Stand on the ground, pitched to the slope along the heading. */
  private stickToGround(i: number, k: Kind): void {
    const A = this.A;
    const L = Math.max(0.25, A.scale[i] * 0.5);
    const sx = Math.sin(A.yaw[i]) * L;
    const sz = Math.cos(A.yaw[i]) * L;
    const ahead = this.ground(A.x[i] + sx, A.z[i] + sz);
    const behind = this.ground(A.x[i] - sx, A.z[i] - sz);
    A.y[i] = this.ground(A.x[i], A.z[i]) + this.lift(i, k);
    A.pitch[i] = clamp(Math.atan2(ahead - behind, 2 * L), -0.7, 0.7);
    A.roll[i] = 0;
  }

  /** Height of a body plan's origin above the ground when it lies on land (sea turtles are modelled round their middle). */
  private lift(i: number, k: Kind): number {
    return k.plan === AnimalModel.SeaTurtle ? this.A.scale[i] * 0.07 : 0;
  }

  /**
   * Swim toward a point at a depth band, on the allowed habitats. Returns the horizontal distance
   * left, or -1 if blocked (the caller picks a new target).
   */
  private swimTo(i: number, k: Kind, tx: number, tz: number, ty: number, speed: number, turnRate: number, dt: number, minDepth = 0.3): number {
    const A = this.A;
    const dx = tx - A.x[i];
    const dz = tz - A.z[i];
    const dh = hyp(dx, dz);
    const want = Math.atan2(dx, dz);
    const yaw0 = A.yaw[i];
    A.yaw[i] = turnToward(yaw0, want, turnRate * dt);
    const turn = wrapAngle(A.yaw[i] - yaw0) / Math.max(dt, 1e-3);
    A.v[i] = approach(A.v[i], Math.min(speed, k.vmax), dt * 0.8);
    // Steer to the wanted depth, kept between the sea floor and the surface (a body's height clear of both).
    const body = A.scale[i] * 0.1;
    const s0 = this.surface(A.x[i], A.z[i]);
    const g0 = this.ground(A.x[i], A.z[i]);
    const band = clamp(ty, g0 + body, Math.max(g0 + body, s0 - body * 0.5));
    A.vy[i] = approach(A.vy[i], clamp((band - A.y[i]) * 0.6, -0.6, 0.6), dt * 2);
    this.limit(i, k);
    const nx = A.x[i] + Math.sin(A.yaw[i]) * A.v[i] * dt;
    const nz = A.z[i] + Math.cos(A.yaw[i]) * A.v[i] * dt;
    // Big swimmers need deeper water.
    if (!this.okAt(k, nx, nz) || this.surface(nx, nz) - this.ground(nx, nz) < Math.max(minDepth, A.scale[i] * 0.35)) {
      A.v[i] *= 0.5;
      return -1;
    }
    A.x[i] = nx;
    A.z[i] = nz;
    A.y[i] = Math.max(A.y[i] + A.vy[i] * dt, this.ground(nx, nz));
    A.pitch[i] = approach(A.pitch[i], Math.atan2(A.vy[i], Math.max(A.v[i], 0.3)) * 0.8, dt * 2);
    A.roll[i] = approach(A.roll[i], clamp(-turn * 0.4, -0.4, 0.4), dt * 2);
    return dh;
  }

  /** A random point within r of (x, z) on the kind's habitats (writes the target), or false. */
  private pickNear(i: number, k: Kind, x: number, z: number, rMin: number, rMax: number, water = false, minDepth = 0.4): boolean {
    const A = this.A;
    for (let t = 0; t < 10; t++) {
      const a = this.rng.next() * TAU;
      const d = rMin + this.rng.next() * (rMax - rMin);
      const px = x + Math.sin(a) * d;
      const pz = z + Math.cos(a) * d;
      if (!this.okAt(k, px, pz)) continue;
      const depth = this.surface(px, pz) - this.ground(px, pz);
      if (water ? depth < minDepth : depth > 0.02) continue;
      A.tx[i] = px;
      A.tz[i] = pz;
      return true;
    }
    return false;
  }

  // ---------- behaviours ----------

  private update(i: number, k: Kind, dt: number): void {
    switch (k.beh) {
      case B.colony:
        return this.colony(i, k, dt);
      case B.soar:
        return this.soar(i, k, dt);
      case B.flit:
        return this.flit(i, k, dt);
      case B.wade:
        return this.wade(i, k, dt);
      case B.runShore:
        return this.runShore(i, k, dt);
      case B.paddle:
        return this.paddle(i, k, dt);
      case B.nightFly:
        return this.nightFly(i, k, dt);
      case B.scuttle:
        return this.scuttle(i, k, dt);
      case B.bask:
        return this.bask(i, k, dt);
      case B.graze:
        return this.graze(i, k, dt);
      case B.nestBeach:
        return this.nestBeach(i, k, dt);
      case B.shoal:
        return this.shoal(i, k, dt);
      case B.glideSea:
        return this.glideSea(i, k, dt);
      case B.porpoise:
        return this.porpoise(i, k, dt);
      case B.surfaceBlow:
        return this.surfaceBlow(i, k, dt);
      case B.flutter:
      case B.buzz:
        return this.flowerFlyer(i, k, dt);
      case B.hover:
        return this.hover(i, k, dt);
      case B.glow:
        return this.glow(i, dt);
      case B.haulOut:
        return this.haulOut(i, k, dt);
      case B.web:
        return this.web(i, dt);
      case B.creep:
        return this.creep(i, k, dt);
      default:
        return;
    }
  }

  /** A flyer that is leaving: climb away and keep going until out of view. */
  private flyAway(i: number, k: Kind, dt: number, speed: number, flapHz: number): void {
    const A = this.A;
    this.flyTo(i, k, A.tx[i], A.ty[i], A.tz[i], speed, dt, 6);
    this.anim(i, flapHz, 0.9, 0, 0, dt);
  }

  /** Flap bouts: `tm2` counts down through flapping and gliding spells. Returns the wing amplitude. */
  private flapBouts(i: number, dt: number, flapFor: number, glideFor: number, flapAmp: number): number {
    const A = this.A;
    A.tm2[i] -= dt;
    if (A.tm2[i] <= -glideFor) A.tm2[i] = flapFor * (0.7 + this.rng.next() * 0.6);
    return A.tm2[i] > 0 ? flapAmp : 0.06;
  }

  /** Seabirds: wheel over the colony, glide in, flare and land on a ledge, preen, drop off; plunge-dive at sea. */
  private colony(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.life[i] === Life.Leaving) return this.flyAway(i, k, dt, sp, 3.5);
    const st = A.st[i];
    const night = activityLevel(k.look.active, this.clock.phase) < 0.3;
    if (this.shelter > 0.5 && st !== C_SHELTER && st !== C_SHELTER_FLY) {
      this.freeLedge(i);
      if (this.shelterSpot(i)) {
        A.st[i] = C_SHELTER_FLY;
        if (st === C_PERCH || st === C_FLOAT) this.takeOff(i);
      }
    }
    switch (A.st[i]) {
      case C_ORBIT: {
        const R = A.a0[i];
        const ang = Math.atan2(A.z[i] - A.hz[i], A.x[i] - A.hx[i]) + A.a2[i] * 0.45;
        const ty = A.hy[i] + A.a1[i] + Math.sin(this.clock.t * 0.2 + A.a3[i]) * 4;
        this.flyTo(i, k, A.hx[i] + Math.cos(ang) * R, ty, A.hz[i] + Math.sin(ang) * R, sp * 0.9, dt, 4);
        const amp = this.flapBouts(i, dt, 1.4, 3.5, 0.95);
        this.anim(i, 3.5, amp, 0, 0, dt);
        A.a0[i] += (this.rng.next() - 0.5) * dt * 4;
        A.tm[i] -= dt;
        if (A.tm[i] <= 0) {
          A.tm[i] = 10 + this.rng.next() * 30;
          const col = this.colonyById(A.col[i]) ?? this.colonyFor(k.sp);
          const overSea = this.ground(A.x[i], A.z[i]) < -2;
          if (col && (night || this.rng.next() < 0.6) && (this.takeLedge(i, col) || (night && this.groundRoost(i, col)))) A.st[i] = C_APPROACH;
          else if (overSea && !night && this.rng.next() < 0.35) {
            A.st[i] = C_PLUNGE;
            A.tx[i] = A.x[i] + Math.sin(A.yaw[i]) * 25;
            A.tz[i] = A.z[i] + Math.cos(A.yaw[i]) * 25;
            A.tm[i] = 0;
          }
        }
        return;
      }
      case C_APPROACH: {
        // Glide to a point out from the ledge, a little above it, then flare in.
        const face = A.tm2[i];
        const ax = A.tx[i] + Math.sin(face) * 9;
        const az = A.tz[i] + Math.cos(face) * 9;
        const d = this.flyTo(i, k, ax, A.ty[i] + 2.5, az, sp * 0.8, dt, 1);
        this.anim(i, 3.5, 0.12, 0, 0, dt);
        if (d < 5) {
          A.st[i] = C_FLARE;
          A.tm[i] = 0;
        }
        return;
      }
      case C_FLARE: {
        const d = hyp3(A.tx[i] - A.x[i], A.ty[i] - A.y[i], A.tz[i] - A.z[i]);
        const v = Math.max(1.2, Math.min(sp * 0.8, d * 1.1));
        A.v[i] = approach(A.v[i], v, dt * 4);
        const ux = (A.tx[i] - A.x[i]) / Math.max(d, 1e-3);
        const uy = (A.ty[i] - A.y[i]) / Math.max(d, 1e-3);
        const uz = (A.tz[i] - A.z[i]) / Math.max(d, 1e-3);
        const step = Math.min(d, A.v[i] * dt);
        A.x[i] += ux * step;
        A.y[i] += uy * step;
        A.z[i] += uz * step;
        A.vy[i] = uy * A.v[i];
        A.yaw[i] = turnToward(A.yaw[i], Math.atan2(ux, uz), dt * 3);
        A.pitch[i] = approach(A.pitch[i], 0.55, dt * 3);
        A.roll[i] = approach(A.roll[i], 0, dt * 4);
        this.anim(i, 8, 0.95, 0, 0, dt);
        A.tm[i] += dt;
        if (d < 0.12 || A.tm[i] > 8) this.land(i, k);
        return;
      }
      case C_PERCH: {
        A.tm[i] -= dt;
        A.pitch[i] = approach(A.pitch[i], 0, dt * 3);
        // Preen now and then, look about, stretch a wing.
        const cyc = (this.clock.t + A.ph[i]) % 9;
        const aux = cyc < 2.5 ? -0.7 - 0.25 * Math.sin(this.clock.t * 5) : cyc < 3.2 ? 0.25 : 0;
        const stretch = (this.clock.t * 0.37 + A.ph[i]) % 23 < 1 ? 0.45 : 1;
        this.anim(i, 0, 0, stretch, aux, dt);
        if (A.flee[i] > 0 || (A.tm[i] <= 0 && !night)) {
          this.freeLedge(i);
          A.st[i] = C_DROP;
          A.tm[i] = 0;
          this.takeOff(i);
        } else if (A.tm[i] <= 0) A.tm[i] = 30 + this.rng.next() * 60;
        return;
      }
      case C_DROP: {
        // Fall forward off the ledge to gain speed, then climb back up to wheel.
        A.tm[i] += dt;
        const ax = A.x[i] + Math.sin(A.yaw[i]) * 30;
        const az = A.z[i] + Math.cos(A.yaw[i]) * 30;
        this.flyTo(i, k, ax, A.y[i] - (A.tm[i] < 1 ? 6 : -4), az, sp, dt, 1.5);
        this.anim(i, 4.5, A.tm[i] < 0.6 ? 0.2 : 0.95, 0, 0, dt);
        if (A.tm[i] > 3) {
          A.st[i] = C_ORBIT;
          A.tm[i] = 10 + this.rng.next() * 25;
        }
        return;
      }
      case C_PLUNGE: {
        // Climb to ~14 m over the sea, then fold and dive.
        A.tm[i] += dt;
        const sea = this.surface(A.x[i], A.z[i]);
        this.flyTo(i, k, A.tx[i], sea + 14, A.tz[i], sp * 0.7, dt, 2);
        this.anim(i, 3.5, 0.6, 0, 0, dt);
        if (A.tm[i] > 2.5 || Math.abs(A.y[i] - sea - 14) < 2) {
          A.st[i] = C_DIVE;
          A.tm[i] = 0;
        }
        return;
      }
      case C_DIVE: {
        // Wings folded, straight down into the sea; then bob up and rest on the water.
        const sea = this.surface(A.x[i], A.z[i]);
        if (this.ground(A.x[i], A.z[i]) > sea - 1) {
          // Drifted over the shore while climbing: no dive here, pull out and go back to wheeling.
          A.st[i] = C_DROP;
          A.tm[i] = 1;
          return;
        }
        const v = Math.min(k.vmax, A.v[i] + 9.8 * dt);
        A.v[i] = v;
        A.pitch[i] = approach(A.pitch[i], -1.25, dt * 5);
        A.x[i] += Math.sin(A.yaw[i]) * Math.cos(A.pitch[i]) * v * dt;
        A.z[i] += Math.cos(A.yaw[i]) * Math.cos(A.pitch[i]) * v * dt;
        A.y[i] += Math.sin(A.pitch[i]) * v * dt;
        A.vy[i] = Math.sin(A.pitch[i]) * v;
        this.anim(i, 0, 0, 0.75, 0, dt);
        if (A.y[i] <= sea) {
          this.splash(A.x[i], sea, A.z[i], 1.2, 14);
          A.st[i] = C_FLOAT;
          A.tm[i] = 4 + this.rng.next() * 6;
          A.v[i] = 0;
          A.vy[i] = 0;
          A.y[i] = sea - 0.5;
        }
        return;
      }
      case C_FLOAT: {
        A.tm[i] -= dt;
        const sea = this.surface(A.x[i], A.z[i]);
        A.y[i] = approach(A.y[i], sea - A.scale[i] * 0.08, dt * 2);
        A.pitch[i] = approach(A.pitch[i], 0, dt * 3);
        A.roll[i] = 0;
        this.anim(i, 0, 0, 1, Math.sin(this.clock.t * 2 + A.ph[i]) > 0.8 ? -0.6 : 0, dt);
        if (A.tm[i] <= 0 || A.flee[i] > 0) {
          this.takeOff(i);
          A.st[i] = C_DROP;
          A.tm[i] = 0.6;
        }
        return;
      }
      case C_SHELTER_FLY: {
        const dh = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
        if (dh > this.landRadius(i)) {
          this.flyTo(i, k, A.tx[i], A.ty[i] + Math.min(6, dh * 0.2), A.tz[i], sp * 0.8, dt, 2);
          this.anim(i, 3.5, 0.8, 0, 0, dt);
        } else {
          this.anim(i, 6, 0.9, 0, 0, dt);
          if (this.settle(i, k, A.tx[i], A.ty[i], A.tz[i], dt)) {
            A.st[i] = C_SHELTER;
            A.yaw[i] = Math.atan2(-WIND_TO_X, -WIND_TO_Z); // face into the wind
          }
        }
        return;
      }
      case C_SHELTER: {
        this.anim(i, 0, 0, 1, 0, dt);
        A.y[i] = this.ground(A.x[i], A.z[i]);
        if (this.shelter < 0.3) {
          this.takeOff(i);
          A.st[i] = C_DROP;
          A.tm[i] = 0.8;
        } else if (A.flee[i] > 0 && this.shelterSpot(i)) {
          // Disturbed (the brush, or lava coming): shift to another sheltered spot.
          this.takeOff(i);
          A.st[i] = C_SHELTER_FLY;
        }
        return;
      }
      default:
        A.st[i] = C_ORBIT;
    }
  }

  /** Somewhere on land near the sheltered (downwind) side of the nearest island, away from lava. */
  private shelterSpot(i: number): boolean {
    const A = this.A;
    const lee = this.nearestLee(A.x[i], A.z[i]);
    if (!lee) return false;
    A.tx[i] = lee.x;
    A.tz[i] = lee.z;
    for (let t = 0; t < 8; t++) {
      const x = lee.x + (this.rng.next() - 0.5) * 30;
      const z = lee.z + (this.rng.next() - 0.5) * 30;
      if (this.ground(x, z) > 0.5 && !this.lavaNear(x, z, LAVA_SAFE)) {
        A.tx[i] = x;
        A.tz[i] = z;
        break;
      }
    }
    A.ty[i] = Math.max(0, this.ground(A.tx[i], A.tz[i]));
    return true;
  }

  private takeOff(i: number): void {
    const A = this.A;
    A.v[i] = Math.max(A.v[i], 3);
    A.vy[i] = 1.5;
    A.fold[i] = Math.min(A.fold[i], 0.6);
  }

  /** Frigatebirds: kite almost motionless high on the wind, circle, glide on; rarely flap; sometimes perch. */
  private soar(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.life[i] === Life.Leaving) return this.flyAway(i, k, dt, sp, 2.5);
    // One slow flap now and then (about one every 20 s).
    const flap = (this.clock.t + A.ph[i] * 3) % 20 < 0.6 ? 0.85 : 0.04;
    A.tm[i] -= dt;
    // The thermal centre drifts downwind.
    A.hx[i] += WIND_TO_X * 0.4 * dt;
    A.hz[i] += WIND_TO_Z * 0.4 * dt;
    const g = Math.max(0, this.ground(A.hx[i], A.hz[i]));
    if (this.shelter > 0.5 && A.st[i] !== S_PERCH) {
      const lee = this.nearestLee(A.x[i], A.z[i]);
      if (lee) {
        A.st[i] = S_DESCEND;
        A.tx[i] = lee.x;
        A.tz[i] = lee.z;
        A.ty[i] = this.ground(lee.x, lee.z) + 1.5;
      }
    }
    switch (A.st[i]) {
      case S_CIRCLE: {
        const R = A.a0[i];
        const ang = Math.atan2(A.z[i] - A.hz[i], A.x[i] - A.hx[i]) + A.a2[i] * 0.35;
        this.flyTo(i, k, A.hx[i] + Math.cos(ang) * R, g + A.a1[i], A.hz[i] + Math.sin(ang) * R, sp, dt, 20);
        this.anim(i, 2.2, flap, 0, 0, dt);
        if (A.tm[i] <= 0) {
          const r = this.rng.next();
          if (r < 0.35) {
            A.st[i] = S_KITE;
            A.tm[i] = 10 + this.rng.next() * 20;
          } else if (r < 0.75) {
            A.st[i] = S_GLIDE;
            const a = this.rng.next() * TAU;
            A.tx[i] = this.view.tx + Math.cos(a) * 150;
            A.tz[i] = this.view.tz + Math.sin(a) * 150;
            A.tm[i] = 40;
          } else {
            const p = this.findPerch(A.x[i], A.z[i], 120, false);
            if (p >= 0) {
              this.perchPoint(i, p, false);
              A.st[i] = S_DESCEND;
            } else A.tm[i] = 15;
          }
        }
        return;
      }
      case S_KITE: {
        // Face into the trade wind and hang there, rising and falling a little.
        A.v[i] = approach(A.v[i], 0.6, dt);
        A.yaw[i] = turnToward(A.yaw[i], Math.atan2(-WIND_TO_X, -WIND_TO_Z), dt * 0.5);
        A.x[i] += (Math.sin(A.yaw[i]) * A.v[i] + WIND_TO_X * 0.3) * dt;
        A.z[i] += (Math.cos(A.yaw[i]) * A.v[i] + WIND_TO_Z * 0.3) * dt;
        A.vy[i] = Math.sin(this.clock.t * 0.4 + A.ph[i]) * 0.4;
        A.y[i] += A.vy[i] * dt;
        A.roll[i] = approach(A.roll[i], Math.sin(this.clock.t * 0.7 + A.ph[i]) * 0.12, dt);
        A.pitch[i] = approach(A.pitch[i], 0.08, dt);
        this.anim(i, 2.2, flap, 0, 0, dt);
        if (A.tm[i] <= 0) {
          A.st[i] = S_CIRCLE;
          A.hx[i] = A.x[i] - Math.cos(A.yaw[i]) * A.a0[i];
          A.hz[i] = A.z[i] - Math.sin(A.yaw[i]) * A.a0[i];
          A.tm[i] = 20 + this.rng.next() * 30;
        }
        return;
      }
      case S_GLIDE: {
        const d = this.flyTo(i, k, A.tx[i], g + A.a1[i], A.tz[i], sp, dt, 20);
        this.anim(i, 2.2, flap, 0, 0, dt);
        if (d < A.a0[i] || A.tm[i] <= 0) {
          A.st[i] = S_CIRCLE;
          A.hx[i] = A.tx[i];
          A.hz[i] = A.tz[i];
          A.tm[i] = 20 + this.rng.next() * 30;
        }
        return;
      }
      case S_DESCEND: {
        const dh = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
        if (dh > this.landRadius(i)) {
          this.flyTo(i, k, A.tx[i], A.ty[i] + Math.min(6, dh * 0.3), A.tz[i], sp * 0.7, dt, 0.3);
          this.anim(i, 2.2, dh < 8 ? 0.9 : flap, 0, 0, dt);
        } else {
          this.anim(i, 4, 0.9, 0, 0, dt);
          if (this.settle(i, k, A.tx[i], A.ty[i], A.tz[i], dt)) {
            A.st[i] = S_PERCH;
            A.tm[i] = 20 + this.rng.next() * 40;
          }
        }
        return;
      }
      case S_PERCH: {
        // A male on a perch puffs out his red throat pouch.
        this.anim(i, 0, 0, 1, Math.min(1, 0.4 + 0.6 * Math.sin(this.clock.t * 0.3 + A.ph[i]) ** 2), dt);
        if ((A.tm[i] <= 0 && this.shelter < 0.3) || A.flee[i] > 0) {
          this.takeOff(i);
          A.st[i] = S_CIRCLE;
          A.hx[i] = A.x[i] + 30;
          A.hz[i] = A.z[i];
          A.tm[i] = 30;
        }
        return;
      }
      default:
        A.st[i] = S_CIRCLE;
    }
  }

  /** Small birds: perch in crowns, bound between them (flap-flap-glide), hop and peck on the ground. */
  private flit(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.life[i] === Life.Leaving) return this.flyAway(i, k, dt, sp, 14);
    switch (A.st[i]) {
      case F_PERCH: {
        A.tm[i] -= dt;
        A.pitch[i] = approach(A.pitch[i], 0, dt * 4);
        A.roll[i] = 0;
        const look = Math.sin(this.clock.t * 1.7 + A.ph[i] * 5) > 0.7 ? -0.5 : Math.sin(this.clock.t * 2.3 + A.ph[i]) > 0.85 ? 0.4 : 0;
        if ((this.clock.t + A.ph[i]) % 3 < 0.05) A.yaw[i] += (this.rng.next() - 0.5) * 2;
        this.anim(i, 0, 0, 1, look, dt);
        if ((A.tm[i] <= 0 && this.shelter < 0.5) || A.flee[i] > 0) {
          if (this.rng.next() < 0.25 && A.flee[i] <= 0) {
            // Drop to the ground to feed.
            const gx = A.x[i] + (this.rng.next() - 0.5) * 6;
            const gz = A.z[i] + (this.rng.next() - 0.5) * 6;
            if (this.ground(gx, gz) > 0.3 && !this.lavaNear(gx, gz, LAVA_SAFE)) {
              A.tx[i] = gx;
              A.tz[i] = gz;
              A.ty[i] = this.ground(gx, gz);
              A.st[i] = F_TO_GROUND;
              this.takeOff(i);
              return;
            }
          }
          const p = this.findPerch(A.x[i], A.z[i], 25, false);
          if (p >= 0) {
            this.perchPoint(i, p, false);
            A.st[i] = F_FLY;
            this.takeOff(i);
          } else A.tm[i] = 3;
        }
        return;
      }
      case F_FLY:
      case F_TO_GROUND: {
        // Bounding flight: a burst of wingbeats, then a short glide with closed wings.
        const cyc = (this.clock.t * 2.2 + A.ph[i]) % 1;
        const flapping = cyc < 0.6;
        const dh = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
        let down = false;
        if (dh > this.landRadius(i)) {
          this.flyTo(i, k, A.tx[i], A.ty[i] + Math.min(3, dh * 0.3) + (flapping ? 0.4 : -0.4), A.tz[i], sp, dt, 0.2);
          this.anim(i, 15, flapping ? 1.0 : 0, flapping ? 0 : 0.85, 0, dt);
        } else {
          down = this.settle(i, k, A.tx[i], A.ty[i], A.tz[i], dt);
          this.anim(i, 15, 1, 0, 0, dt);
        }
        if (down) {
          A.st[i] = A.st[i] === F_FLY ? F_PERCH : F_GROUND;
          A.tm[i] = A.st[i] === F_PERCH ? 3 + this.rng.next() * 9 : 4 + this.rng.next() * 6;
          A.a0[i] = 0;
        }
        return;
      }
      case F_GROUND: {
        // Hop, hop, peck.
        A.tm[i] -= dt;
        A.a0[i] -= dt;
        if (A.a0[i] <= 0) {
          A.a0[i] = 0.35 + this.rng.next() * 0.5;
          A.yaw[i] += (this.rng.next() - 0.5) * 1.5;
          A.a1[i] = 0.3; // hop time left
        }
        if (A.a1[i] > 0) {
          A.a1[i] -= dt;
          const hop = 0.3 * A.scale[i] * 4;
          A.x[i] += Math.sin(A.yaw[i]) * (hop / 0.3) * dt * 0.25;
          A.z[i] += Math.cos(A.yaw[i]) * (hop / 0.3) * dt * 0.25;
          const u = 1 - A.a1[i] / 0.3;
          A.y[i] = this.ground(A.x[i], A.z[i]) + Math.sin(Math.PI * clamp(u, 0, 1)) * 0.06;
        } else A.y[i] = this.ground(A.x[i], A.z[i]);
        this.anim(i, 0, 0, 1, A.a1[i] > 0 ? 0 : 0.8, dt);
        if (A.tm[i] <= 0 || A.flee[i] > 0 || this.shelter > 0.5) {
          const p = this.findPerch(A.x[i], A.z[i], 20, false);
          if (p >= 0) {
            this.perchPoint(i, p, false);
            A.st[i] = F_FLY;
            this.takeOff(i);
          } else A.tm[i] = 2;
        }
        return;
      }
      default:
        A.st[i] = F_PERCH;
    }
  }

  /** Herons and egrets: stand still a long time, step slowly, strike; fly to a new spot now and then. */
  private wade(i: number, k: Kind, dt: number): void {
    const A = this.A;
    if (A.life[i] === Life.Leaving) return this.flyAway(i, k, dt, 6, 2.5);
    switch (A.st[i]) {
      case W_STAND: {
        A.tm[i] -= dt;
        const look = Math.sin(this.clock.t * 0.4 + A.ph[i]) > 0.92 ? -0.35 : 0;
        this.anim(i, 0, 0, 1, look, dt);
        A.y[i] = this.ground(A.x[i], A.z[i]);
        if (A.flee[i] > 0) {
          if (this.wadeSpot(i, k, A.x[i], A.z[i], 40)) {
            A.st[i] = W_FLY;
            this.takeOff(i);
          }
          return;
        }
        if (A.tm[i] <= 0) {
          const r = this.rng.next();
          if (r < 0.45) {
            A.st[i] = W_STRIKE;
            A.tm[i] = 1.4;
          } else if (r < 0.9 && this.wadeSpot(i, k, A.x[i], A.z[i], 4)) {
            A.st[i] = W_STEP;
          } else if (this.wadeSpot(i, k, A.x[i], A.z[i], 40)) {
            A.st[i] = W_FLY;
            this.takeOff(i);
          } else A.tm[i] = 10;
        }
        return;
      }
      case W_STEP: {
        const d = this.walkTo(i, k, A.tx[i], A.tz[i], k.look.speed * A.spd[i], 1.2, dt);
        this.anim(i, 0.9, 0.7, 1, 0, dt);
        if (d < 0.05) {
          A.st[i] = W_STAND;
          A.tm[i] = 20 + this.rng.next() * 80;
        }
        return;
      }
      case W_STRIKE: {
        A.tm[i] -= dt;
        const u = 1.4 - A.tm[i];
        const aux = u < 0.25 ? u / 0.25 : u < 0.5 ? 1 : Math.max(0, 1 - (u - 0.5) * 2);
        A.aux[i] = aux;
        this.anim(i, 0, 0, 1, aux, dt);
        if (Math.abs(u - 0.25) < dt) this.ripple(A.x[i] + Math.sin(A.yaw[i]) * A.scale[i] * 0.6, this.surface(A.x[i], A.z[i]), A.z[i] + Math.cos(A.yaw[i]) * A.scale[i] * 0.6, 0.4);
        if (A.tm[i] <= 0) {
          A.st[i] = W_STAND;
          A.tm[i] = 15 + this.rng.next() * 60;
        }
        return;
      }
      case W_FLY: {
        const dh = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
        if (dh > this.landRadius(i)) {
          this.flyTo(i, k, A.tx[i], A.ty[i] + Math.min(6, dh * 0.3), A.tz[i], 6, dt, 1.5);
          this.anim(i, 2.4, dh < 3 ? 1 : 0.85, 0, 0, dt);
        } else {
          this.anim(i, 3, 1, 0, 0, dt);
          if (this.settle(i, k, A.tx[i], A.ty[i], A.tz[i], dt)) {
            A.st[i] = W_STAND;
            A.tm[i] = 20 + this.rng.next() * 60;
          }
        }
        return;
      }
      default:
        A.st[i] = W_STAND;
    }
  }

  /** Sandpipers: run with the swash (down as a wave backs off, up ahead of the next), stop and peck. */
  private runShore(i: number, k: Kind, dt: number): void {
    const A = this.A;
    if (A.life[i] === Life.Leaving) return this.flyAway(i, k, dt, 9, 8);
    switch (A.st[i]) {
      case R_RUN:
      case R_PECK: {
        // The swash rises and falls on a ~9 s cycle; the bird keeps just above it.
        const swash = 0.08 + 0.3 * (0.5 + 0.5 * Math.sin((this.clock.t / 9) * TAU + A.a3[i]));
        A.tm[i] -= dt;
        if (A.flee[i] > 0 || this.shelter > 0.5) {
          A.st[i] = R_FLY;
          A.a1[i] = 0;
          this.takeOff(i);
          return;
        }
        if (A.st[i] === R_PECK) {
          this.anim(i, 0, 0, 1, Math.sin(this.clock.t * 9 + A.ph[i]) > 0.3 ? 0.8 : 0.1, dt);
          A.y[i] = this.ground(A.x[i], A.z[i]);
          if (A.tm[i] <= 0) {
            // Next target: a little along the shore, at the swash line.
            const along = A.yaw[i] + A.a2[i] * Math.PI * 0.5;
            const ax = A.x[i] + Math.sin(along) * (0.5 + this.rng.next() * 2.5);
            const az = A.z[i] + Math.cos(along) * (0.5 + this.rng.next() * 2.5);
            if (this.shorePoint(i, k, ax, az, swash)) {
              A.st[i] = R_RUN;
              A.tm[i] = 4;
            } else {
              A.a2[i] = -A.a2[i];
              A.tm[i] = 0.5;
            }
            if (this.rng.next() < 0.1) A.a2[i] = -A.a2[i];
          }
          return;
        }
        const d = this.walkTo(i, k, A.tx[i], A.tz[i], k.look.speed * A.spd[i], 8, dt);
        this.anim(i, 12, 0.9, 1, 0, dt);
        if (d < 0.05 || d < 0 || A.tm[i] <= 0) {
          A.st[i] = R_PECK;
          A.tm[i] = 0.4 + this.rng.next() * 1.4;
        }
        return;
      }
      case R_FLY: {
        // Flush low along the shore, then land again.
        if (A.a1[i] === 0) {
          // Along the shore one way, else the other way, else back to where it took off.
          const x0 = A.x[i];
          const z0 = A.z[i];
          const y0 = this.ground(x0, z0);
          let found = false;
          for (let t = 0; t < 2 && !found; t++) {
            const along = A.yaw[i] + (t === 0 ? A.a2[i] : -A.a2[i]) * Math.PI * 0.5;
            const d = 20 + this.rng.next() * 20;
            found = this.shorePoint(i, k, x0 + Math.sin(along) * d, z0 + Math.cos(along) * d, 0.2);
          }
          if (!found) {
            A.tx[i] = x0;
            A.tz[i] = z0;
            A.ty[i] = y0;
          }
          A.a1[i] = 1;
        }
        const dh = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
        if (dh > this.landRadius(i)) {
          this.flyTo(i, k, A.tx[i], A.ty[i] + Math.min(2.5, dh * 0.2), A.tz[i], 9, dt, 1);
          this.anim(i, 8, 0.9, 0, 0, dt);
        } else {
          this.anim(i, 10, 0.9, 0, 0, dt);
          if (this.settle(i, k, A.tx[i], A.ty[i], A.tz[i], dt)) {
            if (this.shelter < 0.5) {
              A.st[i] = R_PECK;
              A.tm[i] = 1;
            }
            A.a1[i] = 0;
          }
        }
        return;
      }
      default:
        A.st[i] = R_PECK;
    }
  }

  /** Ducks: paddle slowly with a small V wake, up-end to dabble, preen; a short flight now and then. */
  private paddle(i: number, k: Kind, dt: number): void {
    const A = this.A;
    if (A.life[i] === Life.Leaving) return this.flyAway(i, k, dt, 10, 5);
    const s = this.surface(A.x[i], A.z[i]);
    switch (A.st[i]) {
      case P_SWIM: {
        A.tm[i] -= dt;
        const d = this.waterWalk(i, k, k.look.speed * A.spd[i], dt);
        A.y[i] = s - A.scale[i] * 0.02 + Math.sin(this.clock.t * 1.3 + A.ph[i]) * 0.01;
        A.pitch[i] = approach(A.pitch[i], 0, dt * 3);
        this.anim(i, 1.5, 0, 1, 0, dt);
        A.tm2[i] -= dt;
        if (A.v[i] > 0.05 && A.tm2[i] <= 0) {
          A.tm2[i] = 0.35;
          this.wake(i);
        }
        if (d < 0.2 || d < 0) this.pickWater(i, k, 1.5, 8);
        if (A.flee[i] > 0) {
          if (this.waterPoint(i, k, A.x[i], A.z[i], 0.2, 25)) {
            A.st[i] = P_FLY;
            A.a1[i] = 1;
            this.takeOff(i);
          }
        } else if (A.tm[i] <= 0) {
          const r = this.rng.next();
          A.st[i] = r < 0.45 ? P_UPEND : r < 0.85 ? P_PREEN : P_FLY;
          A.tm[i] = A.st[i] === P_UPEND ? 2 + this.rng.next() * 3 : 3 + this.rng.next() * 5;
          if (A.st[i] === P_FLY) {
            if (this.waterPoint(i, k, A.x[i], A.z[i], 0.2, 30) && this.shelter < 0.3) {
              A.a1[i] = 1;
              this.takeOff(i);
            } else A.st[i] = P_SWIM;
          }
        }
        return;
      }
      case P_UPEND:
      case P_PREEN: {
        A.tm[i] -= dt;
        A.v[i] = 0;
        A.y[i] = s - A.scale[i] * 0.02;
        const up = A.st[i] === P_UPEND;
        A.pitch[i] = approach(A.pitch[i], up && A.tm[i] > 0.5 ? -1.45 : 0, dt * 4);
        this.anim(i, 3, up ? 0.3 : 0, 1, up ? 0 : -0.6 - 0.3 * Math.sin(this.clock.t * 6), dt);
        if (A.tm[i] <= 0) {
          A.st[i] = P_SWIM;
          A.tm[i] = 4 + this.rng.next() * 8;
        }
        return;
      }
      case P_FLY: {
        // Circle out and splash down on new water.
        const far = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
        this.anim(i, 6, 1, 0, 0, dt);
        if (far > this.landRadius(i)) this.flyTo(i, k, A.tx[i], s + Math.min(10, far * 0.4) + 0.3, A.tz[i], 10, dt, 1.5);
        else if (this.settle(i, k, A.tx[i], this.surface(A.tx[i], A.tz[i]), A.tz[i], dt)) {
          this.splash(A.x[i], s, A.z[i], 0.5, 6);
          A.st[i] = P_SWIM;
          A.tm[i] = 4 + this.rng.next() * 6;
        }
        return;
      }
      default:
        A.st[i] = P_SWIM;
    }
  }

  /** Move a floating animal toward its target over water deep enough (returns distance left, -1 blocked). */
  private waterWalk(i: number, k: Kind, speed: number, dt: number): number {
    const A = this.A;
    const dx = A.tx[i] - A.x[i];
    const dz = A.tz[i] - A.z[i];
    const d = hyp(dx, dz);
    if (d < 0.01) return 0;
    A.yaw[i] = turnToward(A.yaw[i], Math.atan2(dx, dz), dt * 1.5);
    const err = Math.abs(wrapAngle(Math.atan2(dx, dz) - A.yaw[i]));
    const v = Math.min(speed, k.vmax) * (0.3 + 0.7 * Math.max(0, Math.cos(err)));
    const nx = A.x[i] + Math.sin(A.yaw[i]) * v * dt;
    const nz = A.z[i] + Math.cos(A.yaw[i]) * v * dt;
    if (!this.okAt(k, nx, nz) || this.surface(nx, nz) - this.ground(nx, nz) < 0.12) {
      A.v[i] = 0;
      return -1;
    }
    A.x[i] = nx;
    A.z[i] = nz;
    A.v[i] = v;
    return d;
  }

  private pickWater(i: number, k: Kind, rMin: number, rMax: number): void {
    const A = this.A;
    for (let t = 0; t < 8; t++) {
      const a = this.rng.next() * TAU;
      const d = rMin + this.rng.next() * (rMax - rMin);
      const px = A.x[i] + Math.sin(a) * d;
      const pz = A.z[i] + Math.cos(a) * d;
      if (this.okAt(k, px, pz) && this.surface(px, pz) - this.ground(px, pz) > 0.2) {
        A.tx[i] = px;
        A.tz[i] = pz;
        return;
      }
    }
  }

  /** Fruit bats: at dusk and night, fly between fruiting trees and hang upside down in them. */
  private nightFly(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.life[i] === Life.Leaving) return this.flyAway(i, k, dt, sp, 6);
    switch (A.st[i]) {
      case N_FLY: {
        // Irregular flight: the path wobbles from side to side.
        const wob = Math.sin(this.clock.t * 1.7 + A.ph[i]) * 0.5;
        A.yaw[i] += wob * dt;
        const dh = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
        this.anim(i, 6, 1.0, 0, 0, dt);
        if (dh > this.landRadius(i)) this.flyTo(i, k, A.tx[i], A.ty[i] + Math.min(4, dh * 0.2), A.tz[i], sp, dt, 0.3);
        else if (this.settle(i, k, A.tx[i], A.ty[i], A.tz[i], dt)) {
          A.st[i] = N_HANG;
          A.tm[i] = 8 + this.rng.next() * 25;
        }
        return;
      }
      case N_HANG: {
        A.tm[i] -= dt;
        A.pitch[i] = approach(A.pitch[i], -Math.PI / 2, dt * 5);
        this.anim(i, 0.5, (this.clock.t + A.ph[i]) % 7 < 0.8 ? 0.4 : 0, 1, 0, dt);
        if ((A.tm[i] <= 0 && this.shelter < 0.5) || A.flee[i] > 0) {
          const p = this.findPerch(A.x[i], A.z[i], 60, true);
          if (p >= 0) {
            this.perchPoint(i, p, true);
            A.st[i] = N_FLY;
            A.pitch[i] = 0;
            this.takeOff(i);
          } else A.tm[i] = 5;
        }
        return;
      }
      default:
        A.st[i] = N_FLY;
    }
  }

  /** Ghost crabs: climb out of the burrow, freeze, sprint sideways, freeze, wander, dash home and dive in. */
  private scuttle(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    const g = this.ground(A.x[i], A.z[i]);
    const danger = A.flee[i] > 0 || this.shelter > 0.4 || A.life[i] === Life.Leaving;
    switch (A.st[i]) {
      case K_HIDDEN: {
        A.tm[i] -= dt;
        A.hide[i] = 1;
        A.y[i] = g - A.scale[i] * 0.6;
        if (A.life[i] === Life.Leaving) return this.release(i);
        if (A.tm[i] <= 0 && !danger) {
          A.st[i] = K_EMERGE;
          A.tm[i] = 0;
        }
        return;
      }
      case K_EMERGE: {
        A.tm[i] += dt;
        const u = Math.min(1, A.tm[i] / 0.6);
        A.y[i] = g - A.scale[i] * 0.6 * (1 - u);
        A.hide[i] = 1 - u;
        this.anim(i, 6, 0.6, 0, 0, dt);
        if (u >= 1) {
          A.st[i] = K_FREEZE;
          A.tm[i] = 0.5 + this.rng.next() * 2;
        }
        return;
      }
      case K_FREEZE: {
        A.tm[i] -= dt;
        A.y[i] = g;
        const display = (A.ph[i] * 7) % 1 < 0.15 ? 1 : 0;
        this.anim(i, 0, 0, display, 0, dt);
        if (danger) {
          A.st[i] = K_HOME;
          return;
        }
        if (A.tm[i] <= 0) {
          const r = this.rng.next();
          const range = 1.5 + (activityLevel('night', this.clock.phase) > 0.5 ? 4 : 1.5);
          if (r < 0.15 || hyp(A.x[i] - A.hx[i], A.z[i] - A.hz[i]) > range) {
            A.st[i] = K_HOME;
          } else if (this.pickNear(i, k, A.hx[i], A.hz[i], 0.3, range)) {
            A.st[i] = r < 0.6 ? K_SPRINT : K_WANDER;
            A.tm[i] = A.st[i] === K_SPRINT ? 0.8 : 4;
          } else A.tm[i] = 1;
        }
        return;
      }
      case K_SPRINT:
      case K_WANDER:
      case K_HOME: {
        if (A.st[i] === K_HOME) {
          A.tx[i] = A.hx[i];
          A.tz[i] = A.hz[i];
        }
        const fast = A.st[i] !== K_WANDER;
        const d = this.crabStep(i, k, fast ? sp : sp * 0.07, dt);
        this.anim(i, fast ? 14 : 4, fast ? 1 : 0.6, 0, 0, dt);
        A.tm[i] -= dt;
        if (A.st[i] === K_HOME && d < 0.03) {
          A.st[i] = K_BURROW;
          A.tm[i] = 0;
          return;
        }
        if (A.st[i] !== K_HOME && (d < 0.03 || d < 0 || A.tm[i] <= 0)) {
          A.st[i] = danger ? K_HOME : K_FREEZE;
          A.tm[i] = 0.4 + this.rng.next() * 2.5;
        }
        if (A.st[i] === K_HOME && d < 0) {
          // Blocked on the way home: dig a new burrow right here.
          A.hx[i] = A.x[i];
          A.hz[i] = A.z[i];
        }
        return;
      }
      case K_BURROW: {
        A.tm[i] += dt;
        const u = Math.min(1, A.tm[i] / 0.5);
        A.y[i] = g - A.scale[i] * 0.6 * u;
        A.hide[i] = Math.max(A.hide[i], u);
        this.anim(i, 10, 0.8, 0, 0, dt);
        if (u >= 1) {
          A.st[i] = K_HIDDEN;
          A.hide[i] = 1;
          A.tm[i] = 4 + this.rng.next() * 18;
        }
        return;
      }
      default:
        A.st[i] = K_HIDDEN;
    }
  }

  /** Crabs move sideways: the body stays put and the legs carry it left or right. */
  private crabStep(i: number, k: Kind, speed: number, dt: number, mode = WALK_HABITAT): number {
    const A = this.A;
    const dx = A.tx[i] - A.x[i];
    const dz = A.tz[i] - A.z[i];
    const d = hyp(dx, dz);
    if (d < 0.01) return 0;
    const dir = Math.atan2(dx, dz);
    // Turn the body so it faces across the line of travel (whichever side is closer).
    const a = wrapAngle(dir - Math.PI / 2 - A.yaw[i]);
    const b = wrapAngle(dir + Math.PI / 2 - A.yaw[i]);
    A.yaw[i] += clamp(Math.abs(a) < Math.abs(b) ? a : b, -dt * 3, dt * 3);
    const v = Math.min(speed, k.vmax);
    const step = Math.min(d, v * dt);
    const nx = A.x[i] + (dx / d) * step;
    const nz = A.z[i] + (dz / d) * step;
    if (!this.canStep(k, nx, nz, mode)) {
      A.v[i] = 0;
      return -1;
    }
    A.x[i] = nx;
    A.z[i] = nz;
    A.v[i] = v;
    A.y[i] = this.ground(nx, nz);
    A.pitch[i] = 0;
    return d - step;
  }

  /** Lizards: bask facing the sun, bob the head and flash the dewlap, dart to a new spot. */
  private bask(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.life[i] === Life.Leaving || A.flee[i] > 0) return this.hideAway(i, k, dt, sp);
    switch (A.st[i]) {
      case L_BASK: {
        A.tm[i] -= dt;
        A.yaw[i] = turnToward(A.yaw[i], Math.atan2(this.clock.sunX, this.clock.sunZ), dt * 0.8);
        this.stickToGround(i, k);
        this.anim(i, 0, 0, 0, 0, dt);
        if (A.tm[i] <= 0) {
          const r = this.rng.next();
          if (r < 0.4) {
            A.st[i] = L_DISPLAY;
            A.tm[i] = 3.2;
          } else if (this.pickNear(i, k, A.x[i], A.z[i], 0.4, r < 0.8 ? 2 : 1)) {
            A.st[i] = r < 0.8 ? L_DART : L_WALK;
          } else A.tm[i] = 4;
        }
        return;
      }
      case L_DISPLAY: {
        // Three push-ups with the dewlap fanned.
        A.tm[i] -= dt;
        const u = (3.2 - A.tm[i]) / 3.2;
        const bob = Math.max(0, Math.sin(u * Math.PI * 6));
        this.stickToGround(i, k);
        A.pitch[i] += bob * 0.25;
        A.y[i] += bob * A.scale[i] * 0.04;
        this.anim(i, 0, 0, 0, Math.max(0, Math.sin(u * Math.PI * 3)), dt);
        if (A.tm[i] <= 0) {
          A.st[i] = L_BASK;
          A.tm[i] = 15 + this.rng.next() * 40;
        }
        return;
      }
      case L_DART:
      case L_WALK: {
        const dart = A.st[i] === L_DART;
        const d = this.walkTo(i, k, A.tx[i], A.tz[i], dart ? sp : sp * 0.2, dart ? 14 : 4, dt);
        this.anim(i, dart ? 9 : 3, dart ? 1 : 0.6, 0, 0, dt);
        if (d < 0.02) {
          A.st[i] = L_BASK;
          A.tm[i] = 8 + this.rng.next() * 30;
        }
        return;
      }
      default:
        A.st[i] = L_BASK;
    }
  }

  /** A small walker heads for cover (a shrub) or out of view; once hidden it goes. */
  private hideAway(i: number, k: Kind, dt: number, speed: number): void {
    const A = this.A;
    if (A.st[i] !== L_HIDE) {
      A.st[i] = L_HIDE;
      // Find cover close by on our habitats; failing that, just move off.
      let found = false;
      for (let t = 0; t < 12 && !found; t++) {
        const a = this.rng.next() * TAU;
        const d = 0.5 + this.rng.next() * 6;
        const px = A.x[i] + Math.sin(a) * d;
        const pz = A.z[i] + Math.cos(a) * d;
        if (this.okAt(k, px, pz) && this.coverAt(px, pz) > 0.4) {
          A.tx[i] = px;
          A.tz[i] = pz;
          found = true;
        }
      }
      if (!found && !this.pickNear(i, k, A.x[i], A.z[i], 1, 4)) {
        A.tx[i] = A.x[i];
        A.tz[i] = A.z[i];
      }
    }
    const d = this.walkTo(i, k, A.tx[i], A.tz[i], speed, 10, dt);
    this.anim(i, 9, 1, 0, 0, dt);
    // Fleeing: wait in cover until the brush has gone (then basking resumes). Leaving: tuck in and go.
    if ((d < 0.05 || d < 0) && A.life[i] === Life.Leaving) {
      if (this.coverAt(A.x[i], A.z[i]) > 0.4) {
        A.hide[i] = Math.min(1, A.hide[i] + dt * 1.2); // tucked under the leaves
        if (A.hide[i] >= 1) this.release(i);
      } else this.pickNear(i, k, A.x[i], A.z[i], 1, 5);
    }
  }

  /** Tortoises: graze very slowly with the head down, rest with the head drawn in. */
  private graze(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.flee[i] > 0 || this.shelter > 0.5) {
      this.stickToGround(i, k);
      this.anim(i, 0, 0, 1, 0, dt); // head in
      return;
    }
    if (A.life[i] === Life.Leaving) {
      if (this.walkTo(i, k, A.tx[i], A.tz[i], sp, 0.4, dt) < 0) this.pickNear(i, k, A.x[i], A.z[i], 3, 10);
      this.anim(i, 0.5, 0.8, 0, 0, dt);
      return;
    }
    A.tm[i] -= dt;
    switch (A.st[i]) {
      case G_GRAZE: {
        this.stickToGround(i, k);
        this.anim(i, 0, 0, 0, Math.sin(this.clock.t * 0.8 + A.ph[i]) > 0 ? 0.7 : 0.3, dt);
        if (A.tm[i] <= 0) {
          const r = this.rng.next();
          if (r < 0.75 && this.pickNear(i, k, A.x[i], A.z[i], 1, 5)) {
            A.st[i] = G_WALK;
            A.tm[i] = 60;
          } else {
            A.st[i] = G_REST;
            A.tm[i] = 15 + this.rng.next() * 40;
          }
        }
        return;
      }
      case G_WALK: {
        const d = this.walkTo(i, k, A.tx[i], A.tz[i], sp, 0.35, dt);
        this.anim(i, 0.45, 0.8, 0, 0.2, dt);
        if (d < 0.05 || d < 0 || A.tm[i] <= 0) {
          A.st[i] = G_GRAZE;
          A.tm[i] = 6 + this.rng.next() * 15;
        }
        return;
      }
      case G_REST: {
        this.stickToGround(i, k);
        this.anim(i, 0, 0, 1, 0, dt);
        if (A.tm[i] <= 0) {
          A.st[i] = G_GRAZE;
          A.tm[i] = 8 + this.rng.next() * 15;
        }
        return;
      }
      default:
        A.st[i] = G_GRAZE;
    }
  }

  /**
   * Sea turtles: by day they swim the shallows and seagrass, surfacing to breathe. At night one crawls
   * up the beach, digs, lays, covers the nest and crawls back to the sea.
   */
  private nestBeach(i: number, k: Kind, dt: number): void {
    const A = this.A;
    if (A.st[i] === T_HATCH) return this.hatchRun(i, k, dt);
    const crawl = k.look.speed * A.spd[i];
    const swim = Math.min(k.vmax, 0.5) * A.spd[i];
    const night = activityLevel('night', this.clock.phase) > 0.6;
    A.tm[i] -= dt;
    switch (A.st[i]) {
      case T_SWIM: {
        if (A.life[i] === Life.Leaving) {
          if (this.swimTo(i, k, A.tx[i], A.tz[i], this.swimDepth(i, k, A.x[i], A.z[i]), swim, 0.5, dt) < 0) this.leave2(i);
          this.anim(i, 0.5, 0.8, 0, 0, dt);
          return;
        }
        this.cruise(i, k, swim, dt, 0.4);
        this.anim(i, 0.45, 0.8, 0, 0, dt);
        if (night && A.tm[i] <= 0) {
          // Head for a beach.
          if (this.shorePoint(i, k, A.x[i], A.z[i], -0.4) && this.beachAhead(A.tx[i], A.tz[i])) {
            A.st[i] = T_APPROACH;
            A.tm[i] = 120;
          } else A.tm[i] = 20;
        }
        return;
      }
      case T_APPROACH: {
        // Swim in until the water is too shallow to swim (or the shore is reached), then crawl.
        const d = this.swimTo(i, k, A.tx[i], A.tz[i], this.surface(A.x[i], A.z[i]) - 0.3, swim, 0.6, dt);
        this.anim(i, 0.5, 0.8, 0, 0, dt);
        if (d < 0.6 || A.tm[i] <= 0) {
          A.st[i] = T_UP;
          A.tm[i] = 200;
        }
        return;
      }
      case T_UP: {
        // Crawl straight up the slope until above the swash.
        const gx = this.ground(A.x[i] + 1, A.z[i]) - this.ground(A.x[i] - 1, A.z[i]);
        const gz = this.ground(A.x[i], A.z[i] + 1) - this.ground(A.x[i], A.z[i] - 1);
        const l = hyp(gx, gz) || 1;
        A.tx[i] = A.x[i] + (gx / l) * 2;
        A.tz[i] = A.z[i] + (gz / l) * 2;
        const d = this.walkTo(i, k, A.tx[i], A.tz[i], crawl, 0.5, dt);
        this.surfaceOrGround(i, k, dt);
        this.anim(i, 0.5, 0.9, 0, 0, dt);
        const g = this.ground(A.x[i], A.z[i]);
        if (g > 1.3 || d < 0 || A.tm[i] <= 0 || A.flee[i] > 0) {
          // She nests only on dry sand above the swash; anywhere else she turns back to the sea.
          const dry = g > 0.4 && this.hab(A.x[i], A.z[i]) === Habitat.Beach;
          A.st[i] = A.flee[i] <= 0 && dry ? T_DIG : T_DOWN;
          A.tm[i] = A.st[i] === T_DIG ? 60 : 300;
          A.a1[i] = 0;
        }
        return;
      }
      case T_DIG:
      case T_LAY:
      case T_COVER: {
        const flick = A.st[i] !== T_LAY;
        this.stickToGround(i, k);
        A.y[i] -= Math.min(0.15, (60 - Math.max(0, A.tm[i])) * 0.004) * A.scale[i];
        this.anim(i, flick ? 0.9 : 0, 0.1, 0, flick ? 1 : 0, dt);
        if (flick && this.rng.next() < dt * 6) this.flickSand(i);
        if (A.tm[i] <= 0) {
          A.st[i] = A.st[i] === T_DIG ? T_LAY : A.st[i] === T_LAY ? T_COVER : T_DOWN;
          A.tm[i] = A.st[i] === T_LAY ? 30 : A.st[i] === T_COVER ? 30 : 300;
        }
        return;
      }
      case T_DOWN: {
        if (this.backToSea(i, k, crawl, 0.5, 0.8, dt)) {
          A.st[i] = T_SWIM;
          A.tm[i] = 200 + this.rng.next() * 200; // one nest a night is plenty
        }
        return;
      }
      default:
        A.st[i] = T_SWIM;
    }
  }

  /** Is there sand to nest on just above this shore point? */
  private beachAhead(x: number, z: number): boolean {
    for (let r = 1; r < 10; r += 2) {
      for (let s = 0; s < 6; s++) {
        const a = (s / 6) * TAU;
        const h = this.hab(x + Math.sin(a) * r, z + Math.cos(a) * r);
        if (h === Habitat.Beach) return true;
      }
    }
    return false;
  }

  /** In the shallows a crawling animal floats; on land it lies on the ground. */
  private surfaceOrGround(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const g = this.ground(A.x[i], A.z[i]) + this.lift(i, k);
    const want = Math.max(g, this.surface(A.x[i], A.z[i]) - A.scale[i] * 0.1);
    A.y[i] = want <= g ? g : Math.max(g, approach(A.y[i], want, dt * 1.5));
  }

  /**
   * A turtle or seal crawling back into the sea: straight down the slope; if that way is blocked
   * (rock it would not normally cross), to the nearest water over whatever lies between (`a1` = 1
   * once that water is picked). Walled in by lava, it stays put and goes once nobody is looking; it
   * never swims on dry land. Returns true once it is in water `deep` enough to swim.
   */
  private backToSea(i: number, k: Kind, crawl: number, turn: number, deep: number, dt: number): boolean {
    const A = this.A;
    if (A.a1[i] === 0) {
      const gx = this.ground(A.x[i] + 1, A.z[i]) - this.ground(A.x[i] - 1, A.z[i]);
      const gz = this.ground(A.x[i], A.z[i] + 1) - this.ground(A.x[i], A.z[i] - 1);
      const l = hyp(gx, gz) || 1;
      A.tx[i] = A.x[i] - (gx / l) * 2;
      A.tz[i] = A.z[i] - (gz / l) * 2;
    }
    const d = this.walkTo(i, k, A.tx[i], A.tz[i], crawl, turn, dt, A.a1[i] === 1 ? WALK_NO_LAVA : WALK_HABITAT);
    this.surfaceOrGround(i, k, dt);
    this.anim(i, k.plan === AnimalModel.Seal ? 1.2 : 0.5, 0.9, 0, 0, dt);
    if (this.surface(A.x[i], A.z[i]) - this.ground(A.x[i], A.z[i]) > deep) {
      A.a1[i] = 0;
      return true;
    }
    let stuck = A.tm[i] <= 0;
    if (d < 0) {
      if (A.a1[i] === 0 && (this.waterPoint(i, k, A.x[i], A.z[i], deep + 0.2, 30) || this.waterPoint(i, k, A.x[i], A.z[i], deep + 0.2, 90))) A.a1[i] = 1;
      else stuck = true;
    } else if (A.a1[i] === 1 && d < 0.3) A.a1[i] = 0; // reached that water's edge: on down the slope
    // Still trying, but it will be let go as soon as it is out of sight.
    if (stuck && A.life[i] === Life.Live) A.life[i] = Life.Leaving;
    return false;
  }

  /** Leave by swimming deeper and on until out of view. */
  private leave2(i: number): void {
    const A = this.A;
    A.tx[i] = A.x[i] + (this.rng.next() - 0.5) * 60;
    A.tz[i] = A.z[i] + (this.rng.next() - 0.5) * 60;
  }

  private flickSand(i: number): void {
    const A = this.A;
    const back = A.yaw[i] + Math.PI;
    const x = A.x[i] + Math.sin(back) * A.scale[i] * 0.4;
    const z = A.z[i] + Math.cos(back) * A.scale[i] * 0.4;
    for (let n = 0; n < 2; n++) {
      const s = (this.rng.next() - 0.5) * 1.2;
      this.P.emit(x, A.y[i] + 0.05, z, Math.sin(back + s) * 1.2, 1.4 + this.rng.next(), Math.cos(back + s) * 1.2, 0.8, 0.05, 0, 9.8, PointKind.Dot, 0.75, 0.68, 0.5, 0.9);
    }
  }

  /** Swim about on the kind's waters at a depth band, picking new targets when close or blocked. */
  private cruise(i: number, k: Kind, speed: number, dt: number, turn: number, minDepth = 0.4): void {
    const A = this.A;
    const depth = this.swimDepth(i, k, A.x[i], A.z[i]);
    let ty = depth;
    // Turtles come up to breathe now and then.
    if (k.plan === AnimalModel.SeaTurtle) {
      A.tm2[i] -= dt;
      if (A.tm2[i] < 0) ty = this.surface(A.x[i], A.z[i]) - A.scale[i] * 0.05;
      if (A.tm2[i] < -4) A.tm2[i] = 30 + this.rng.next() * 30;
    }
    const d = this.swimTo(i, k, A.tx[i], A.tz[i], ty, speed, turn, dt, minDepth * 0.75);
    if (d < 1.5 || d < 0) {
      if (!this.pickNear(i, k, A.x[i], A.z[i], 6, 25, true, minDepth)) this.pickNear(i, k, A.hx[i], A.hz[i], 2, 20, true, minDepth);
    }
  }

  /** Reef fish: a shoal wanders the reef; its fish school around it (cohesion, alignment, separation). */
  private shoal(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const M = this.M;
    const leaving = A.life[i] === Life.Leaving;
    const sp = k.look.speed * A.spd[i];
    const scatter = A.flee[i] > 0 || this.shelter > 0.8 ? 1 : 0;
    // The shoal's centre is an invisible leader cruising the reef.
    if (leaving) {
      if (this.swimTo(i, k, A.tx[i], A.tz[i], this.swimDepth(i, k, A.x[i], A.z[i]), sp * 0.6, 0.6, dt) < 0) this.leave2(i);
    } else this.cruise(i, k, sp * 0.45, dt, 0.5, 1.2);
    const m0 = A.group[i] * GROUP_SIZE;
    const n = A.members[i];
    const cx = A.x[i];
    const cy = A.y[i];
    const cz = A.z[i];
    const lvx = Math.sin(A.yaw[i]) * A.v[i];
    const lvz = Math.cos(A.yaw[i]) * A.v[i];
    const vmax = k.vmax * 0.95;
    for (let m = m0; m < m0 + n; m++) {
      // Each fish keeps its own place in the school, which slowly swirls.
      const slot = (m - m0) / n;
      const sw = this.clock.t * 0.25 + slot * TAU;
      const ox = Math.cos(sw) * (1.2 + slot) * (1 + scatter * 2);
      const oz = Math.sin(sw) * (0.8 + slot * 0.8) * (1 + scatter * 2);
      const oy = Math.sin(sw * 1.7) * 0.35;
      let ax = (cx + ox - M.x[m]) * 0.8 + (lvx - M.vx[m]) * 0.6;
      const gm = this.ground(M.x[m], M.z[m]);
      const sm = this.surface(M.x[m], M.z[m]);
      const band = clamp(cy + oy, gm + 0.3, sm - 0.3);
      let ay = (band - M.y[m]) * 1.6 - M.vy[m] * 0.8;
      let az = (cz + oz - M.z[m]) * 0.8 + (lvz - M.vz[m]) * 0.6;
      for (let o = m0; o < m0 + n; o++) {
        if (o === m) continue;
        const dx = M.x[m] - M.x[o];
        const dz = M.z[m] - M.z[o];
        const d2 = dx * dx + dz * dz;
        if (d2 < 0.36 && d2 > 1e-6) {
          ax += (dx / d2) * 0.25;
          az += (dz / d2) * 0.25;
        }
      }
      M.vx[m] += ax * dt;
      M.vy[m] += ay * dt;
      M.vz[m] += az * dt;
      const s = hyp3(M.vx[m], M.vy[m], M.vz[m]);
      if (s > vmax) {
        M.vx[m] *= vmax / s;
        M.vy[m] *= vmax / s;
        M.vz[m] *= vmax / s;
      }
      const nx = M.x[m] + M.vx[m] * dt;
      const nz = M.z[m] + M.vz[m] * dt;
      const deepNext = this.surface(nx, nz) - this.ground(nx, nz);
      if (deepNext < 0.25 && deepNext < sm - gm) {
        // Too shallow ahead: turn back.
        M.vx[m] *= -0.5;
        M.vz[m] *= -0.5;
      } else {
        M.x[m] = nx;
        M.z[m] = nz;
      }
      M.y[m] += M.vy[m] * dt;
      const hs = hyp(M.vx[m], M.vz[m]);
      if (hs > 0.05) {
        const yaw = Math.atan2(M.vx[m], M.vz[m]);
        const turn = Math.abs(wrapAngle(yaw - M.yaw[m])) / Math.max(dt, 1e-3);
        M.yaw[m] = yaw;
        M.w[m] = approach(M.w[m], clamp(turn * 0.35 - 0.2, 0, 1), dt * 6);
      }
      M.ph[m] = (M.ph[m] + (2 + hs * 6) * TAU * dt) % PHASE_WRAP;
    }
  }

  /** Rays, sharks and swimming turtles: long smooth glides; rays settle on the sand now and then. */
  private glideSea(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.life[i] === Life.Leaving) {
      if (this.swimTo(i, k, A.tx[i], A.tz[i], this.swimDepth(i, k, A.x[i], A.z[i]), sp * 0.8, 0.4, dt) < 0) this.leave2(i);
      this.anim(i, k.plan === AnimalModel.Ray ? 0.4 : 1, 0.8, 0, 0, dt);
      return;
    }
    const ray = k.plan === AnimalModel.Ray;
    if (A.st[i] === Y_REST) {
      // Resting on the sand.
      A.tm[i] -= dt;
      A.v[i] = 0;
      A.y[i] = approach(A.y[i], this.ground(A.x[i], A.z[i]) + A.scale[i] * 0.05, dt);
      this.anim(i, 0.2, 0.08, 0, 0, dt);
      if (A.tm[i] <= 0 || A.flee[i] > 0) {
        A.st[i] = Y_GLIDE;
        A.tm[i] = 20 + this.rng.next() * 40;
      }
      return;
    }
    this.cruise(i, k, sp * (A.flee[i] > 0 ? 1.3 : 0.8), dt, ray ? 0.35 : 0.5);
    const hz = ray ? 0.4 : k.plan === AnimalModel.SeaTurtle ? 0.45 : 0.9 + A.v[i] * 0.4;
    this.anim(i, hz, ray ? 0.9 : 0.8, 0, 0, dt);
    A.tm[i] -= dt;
    if (ray && A.tm[i] <= 0) {
      A.st[i] = Y_REST;
      A.tm[i] = 6 + this.rng.next() * 14;
    } else if (A.tm[i] <= 0) A.tm[i] = 30;
  }

  /** Dolphins: a pod cruising the lagoon or the Sound, each rolling up out of the water in arcs every few seconds. */
  private porpoise(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    const lead = A.group[i];
    const isLead = lead < 0 || A.life[lead] === Life.Free || A.kind[lead] !== A.kind[i];
    if (!isLead && A.life[lead] === Life.Leaving && A.life[i] === Life.Live) this.leave(i);
    const s = this.surface(A.x[i], A.z[i]);
    const arcT = A.a2[i];
    if (arcT > 0) {
      // In an arc: up out of the water and back in over 1.3 s.
      const u = 1 - arcT / 1.3;
      const hgt = A.a3[i];
      const y0 = s - 0.8;
      const ny = y0 + (hgt + 0.8) * Math.sin(Math.PI * u);
      A.vy[i] = (ny - A.y[i]) / Math.max(dt, 1e-3);
      A.y[i] = ny;
      A.pitch[i] = Math.atan2(Math.cos(Math.PI * u) * (hgt + 0.8) * Math.PI / 1.3, Math.max(A.v[i], 1));
      // The leap adds upward speed to the swimming speed; the total stays within the species' limit.
      const vh = Math.min(A.v[i], Math.sqrt(Math.max(0, k.vmax * k.vmax - A.vy[i] * A.vy[i])));
      const nx = A.x[i] + Math.sin(A.yaw[i]) * vh * dt;
      const nz = A.z[i] + Math.cos(A.yaw[i]) * vh * dt;
      if (this.okAt(k, nx, nz)) {
        A.x[i] = nx;
        A.z[i] = nz;
      }
      const prev = A.a2[i];
      A.a2[i] -= dt;
      if (prev > 1.3 * 0.82 && A.a2[i] <= 1.3 * 0.82) this.splash(A.x[i], s, A.z[i], 0.6, 5);
      if (prev > 0.13 && A.a2[i] <= 0.13) this.splash(A.x[i], s, A.z[i], 0.7, 7);
      this.anim(i, 1.5, 0.3, 0, 0, dt);
      return;
    }
    if (A.life[i] === Life.Leaving || isLead) {
      const d = this.swimTo(i, k, A.tx[i], A.tz[i], s - 0.8, sp, 0.35, dt);
      if (d < 8 || d < 0) {
        if (A.life[i] === Life.Leaving) this.leave2(i);
        else if (!this.pickNear(i, k, A.x[i], A.z[i], 40, 120, true)) this.pickNear(i, k, A.x[i], A.z[i], 10, 40, true);
      }
    } else {
      // Followers keep station on the leader.
      const fx = A.x[lead] + Math.cos(A.yaw[lead]) * A.a0[i] - Math.sin(A.yaw[lead]) * (2 + Math.abs(A.a1[i]));
      const fz = A.z[lead] - Math.sin(A.yaw[lead]) * A.a0[i] - Math.cos(A.yaw[lead]) * (2 + Math.abs(A.a1[i]));
      const gap = hyp(fx - A.x[i], fz - A.z[i]);
      if (this.swimTo(i, k, fx, fz, s - 0.8, Math.min(k.vmax * 0.9, sp * (0.8 + gap * 0.1)), 0.9, dt) < 0) A.v[i] *= 0.5;
    }
    this.anim(i, 1.2 + A.v[i] * 0.2, 0.9, 0, 0, dt);
    A.tm2[i] -= dt;
    if (A.tm2[i] <= 0) {
      A.tm2[i] = 3 + this.rng.next() * 3;
      // Arc only where the water is deep all the way to where it dives back in.
      const lx = A.x[i] + Math.sin(A.yaw[i]) * A.v[i] * 1.4;
      const lz = A.z[i] + Math.cos(A.yaw[i]) * A.v[i] * 1.4;
      if (A.v[i] > 2 && this.surface(A.x[i], A.z[i]) - this.ground(A.x[i], A.z[i]) > 2 && this.okAt(k, lx, lz) && this.surface(lx, lz) - this.ground(lx, lz) > 2) {
        A.a2[i] = 1.3;
        A.a3[i] = 0.4 + this.rng.next() * 0.7;
      }
    }
  }

  /** Whales: long dives, a few breaths at the surface with a misty blow, a fluke-up dive; a rare breach. */
  private surfaceBlow(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    const s = this.surface(A.x[i], A.z[i]);
    const body = A.scale[i] * 0.11;
    // Deeper than a few metres it fades into the blue (and is not drawn at all on a long dive); the
    // fade is eased so even the plunge back after a breach thins it out rather than snapping.
    A.hide[i] += clamp(smooth(3, 6, s - A.y[i]) - A.hide[i], -dt * 2, dt * 2);
    A.tm[i] -= dt;
    switch (A.st[i]) {
      case H_DIVE: {
        const deep = this.swimDepth(i, k, A.x[i], A.z[i]);
        const d = this.swimTo(i, k, A.tx[i], A.tz[i], deep, sp, 0.12, dt);
        if (d < 20 || d < 0) {
          if (A.life[i] === Life.Leaving) this.leave2(i);
          else if (!this.pickNear(i, k, A.x[i], A.z[i], 60, 200, true, 15)) this.pickNear(i, k, A.x[i], A.z[i], 20, 60, true, 15);
        }
        this.anim(i, 0.25, 0.7, 0, 0, dt);
        if (A.tm[i] <= 0 && A.life[i] === Life.Live) {
          A.st[i] = H_RISE;
          A.tm[i] = 6;
          A.a1[i] = 2 + this.rng.int(2); // breaths this time up
          if (this.rng.next() < 0.06 && s - this.ground(A.x[i], A.z[i]) > 12) {
            A.st[i] = H_BREACH;
            A.tm[i] = 0;
            A.a0[i] = A.y[i];
          }
        }
        return;
      }
      case H_RISE:
      case H_SURFACE: {
        const atTop = s - body * 0.6;
        if (this.swimTo(i, k, A.tx[i], A.tz[i], atTop, sp * 0.6, 0.1, dt) < 20) this.pickNear(i, k, A.x[i], A.z[i], 60, 160, true, 15);
        this.anim(i, 0.2, 0.5, 0, 0, dt);
        if (A.st[i] === H_RISE && A.y[i] > atTop - 0.3) {
          A.st[i] = H_SURFACE;
          A.tm[i] = 0.5;
        }
        if (A.st[i] === H_SURFACE && A.tm[i] <= 0) {
          this.blow(i);
          A.a1[i] -= 1;
          A.tm[i] = A.a1[i] > 0 ? 10 + this.rng.next() * 6 : 6;
          if (A.a1[i] < 0) {
            A.st[i] = H_SOUND;
            A.tm[i] = 5;
          }
        }
        return;
      }
      case H_SOUND: {
        // Arch the back and lift the flukes as it dives.
        A.pitch[i] = approach(A.pitch[i], -1.0, dt * 0.8);
        A.v[i] = approach(A.v[i], sp * 0.6, dt);
        const nx = A.x[i] + Math.sin(A.yaw[i]) * Math.cos(A.pitch[i]) * A.v[i] * dt;
        const nz = A.z[i] + Math.cos(A.yaw[i]) * Math.cos(A.pitch[i]) * A.v[i] * dt;
        if (this.okAt(k, nx, nz)) {
          A.x[i] = nx;
          A.z[i] = nz;
        }
        A.vy[i] = Math.sin(A.pitch[i]) * A.v[i];
        A.y[i] = Math.max(A.y[i] + A.vy[i] * dt, this.ground(A.x[i], A.z[i]) + body * 2);
        this.anim(i, 0.2, 0.9, 0, 0, dt);
        if (A.tm[i] <= 0) {
          A.st[i] = H_DIVE;
          A.tm[i] = 30 + this.rng.next() * 30;
          A.pitch[i] = 0;
        }
        return;
      }
      case H_BREACH: {
        // Burst up, two-thirds out of the water, twist and crash back.
        A.tm[i] += dt;
        const u = A.tm[i];
        if (u < 2.2) {
          const up = Math.min(k.vmax, 3 + u * 3);
          A.pitch[i] = approach(A.pitch[i], 1.25, dt * 2);
          A.vy[i] = up;
          A.y[i] += up * dt;
          A.roll[i] += dt * 0.8;
          if (A.y[i] > s + A.scale[i] * 0.25) A.tm[i] = 2.2;
        } else {
          A.vy[i] = Math.max(-k.vmax, A.vy[i] - 9.8 * dt);
          A.y[i] += A.vy[i] * dt;
          A.pitch[i] = approach(A.pitch[i], -0.2, dt * 1.5);
          A.roll[i] += dt * 0.6;
          if (A.y[i] < s && A.a2[i] === 0) {
            A.a2[i] = 1;
            this.splash(A.x[i], s, A.z[i], 4, 40);
          }
          if (A.y[i] < s - body * 3) {
            A.st[i] = H_DIVE;
            A.tm[i] = 40;
            A.roll[i] = 0;
            A.pitch[i] = 0;
            A.a2[i] = 0;
          }
        }
        A.v[i] = Math.min(A.v[i], Math.sqrt(Math.max(0, k.vmax * k.vmax - A.vy[i] * A.vy[i])));
        this.anim(i, 0.3, 0.5, 0, 0, dt);
        return;
      }
      default:
        A.st[i] = H_DIVE;
    }
  }

  /** Butterflies and bees: wander toward flowers, settle (butterflies close their wings), move on. */
  private flowerFlyer(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    const bee = k.beh === B.buzz;
    const wingHz = bee ? 30 : 8;
    if (A.life[i] === Life.Leaving || this.shelter > 0.5) {
      if (A.life[i] === Life.Live) this.leave(i);
      this.flyTo(i, k, A.tx[i], A.ty[i], A.tz[i], sp, dt, 1);
      this.anim(i, wingHz, bee ? 0.5 : 1.1, 0, 0, dt);
      return;
    }
    A.tm[i] -= dt;
    if (A.st[i] === FL_SETTLED) {
      // Settled on a flower.
      A.v[i] = 0;
      const open = bee ? 0 : 0.35 + 0.65 * Math.max(0, Math.sin(this.clock.t * 1.4 + A.ph[i]));
      this.anim(i, bee ? wingHz : 0, bee ? 0.15 : 0, open, 0, dt);
      if (bee) A.y[i] = A.ty[i] + Math.sin(this.clock.t * 9 + A.ph[i]) * 0.01;
      if (A.tm[i] <= 0 || A.flee[i] > 0) {
        A.st[i] = FL_FLY;
        A.tm[i] = 4 + this.rng.next() * 6;
        this.flowerTarget(i, k, bee ? 6 : 12);
        this.takeOff(i);
      }
      return;
    }
    // Erratic flight toward the target flower.
    const jitter = bee ? 2.5 : 1.6;
    A.yaw[i] += Math.sin(this.clock.t * (bee ? 7 : 3.3) + A.ph[i] * 4) * jitter * dt;
    const dh = hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]);
    this.anim(i, wingHz, bee ? 0.5 : 1.1, 0, 0, dt);
    if (dh > 0.6) {
      const bob = Math.sin(this.clock.t * (bee ? 5 : 2.2) + A.ph[i]) * (bee ? 0.15 : 0.35);
      this.flyTo(i, k, A.tx[i], A.ty[i] + (bee ? 0.1 : 0.4) + bob, A.tz[i], sp, dt, 0.15);
    } else if (this.settle(i, k, A.tx[i], A.ty[i], A.tz[i], dt)) {
      A.st[i] = FL_SETTLED;
      A.tm[i] = bee ? 1 + this.rng.next() * 2 : 3 + this.rng.next() * 7;
    } else if (A.tm[i] <= 0) {
      this.flowerTarget(i, k, bee ? 6 : 12);
      A.tm[i] = 6;
    }
  }

  /** Pick a flower (a flowering herb or shrub) near the insect, or any plant top on its habitats. */
  private flowerTarget(i: number, k: Kind, r: number): void {
    const A = this.A;
    const pl = this.fields.plants;
    let fx = A.x[i] + (this.rng.next() - 0.5) * r;
    let fz = A.z[i] + (this.rng.next() - 0.5) * r;
    let top = 0.3;
    for (let t = 0; t < 14; t++) {
      const px = A.x[i] + (this.rng.next() - 0.5) * 2 * r;
      const pz = A.z[i] + (this.rng.next() - 0.5) * 2 * r;
      const p = this.fields.patchIndex(px, pz);
      if (p < 0 || !this.okAt(k, px, pz)) continue;
      const o = p * PLANT_BYTES;
      const herb = pl[o + 4] - 1;
      const shrub = pl[o + 2] - 1;
      if (herb >= 0 && this.flowerBySp[herb] && pl[o + 5] > 50) {
        fx = px;
        fz = pz;
        top = Math.max(0.15, this.plantTopBySp[herb]);
        break;
      }
      if (shrub >= 0 && this.flowerBySp[shrub] && pl[o + 3] > 50) {
        fx = px;
        fz = pz;
        top = this.plantTopBySp[shrub];
        break;
      }
    }
    A.tx[i] = fx;
    A.tz[i] = fz;
    A.ty[i] = Math.max(this.ground(fx, fz), 0) + top;
  }

  /** Dragonflies: hover over the pond, dart a few metres, hover again. */
  private hover(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    if (A.life[i] === Life.Leaving || this.shelter > 0.5) {
      if (A.life[i] === Life.Live) this.leave(i);
      this.flyTo(i, k, A.tx[i], A.ty[i], A.tz[i], sp * 0.6, dt, 1);
      this.anim(i, 25, 0.35, 0, 0, dt);
      return;
    }
    A.tm[i] -= dt;
    if (A.st[i] === HV_HOVER) {
      // Hovering: tiny drift, then pick a dart target over the water.
      A.v[i] = 0;
      A.vy[i] = 0;
      A.y[i] += Math.sin(this.clock.t * 3 + A.ph[i]) * 0.05 * dt;
      A.pitch[i] = approach(A.pitch[i], 0, dt * 6);
      A.roll[i] = 0;
      this.anim(i, 25, 0.35, 0, 0, dt);
      if (A.tm[i] <= 0) {
        for (let t = 0; t < 8; t++) {
          const a = this.rng.next() * TAU;
          const d = 1 + this.rng.next() * 2.5;
          const px = A.x[i] + Math.sin(a) * d;
          const pz = A.z[i] + Math.cos(a) * d;
          if (!this.okAt(k, px, pz) && hyp(px - A.hx[i], pz - A.hz[i]) > 6) continue;
          A.tx[i] = px;
          A.tz[i] = pz;
          A.ty[i] = Math.max(this.ground(px, pz), A.hy[i]) + 0.3 + this.rng.next() * 0.9;
          A.st[i] = HV_DART;
          A.v[i] = sp * 0.6;
          break;
        }
        if (A.st[i] === HV_HOVER) A.tm[i] = 0.5;
      }
      return;
    }
    // Darting: straight and quick, then stop dead.
    const dx = A.tx[i] - A.x[i];
    const dy = A.ty[i] - A.y[i];
    const dz = A.tz[i] - A.z[i];
    const d = hyp3(dx, dy, dz);
    const v = Math.min(sp, k.vmax);
    const step = Math.min(d, v * dt);
    if (d > 1e-3) {
      A.x[i] += (dx / d) * step;
      A.y[i] += (dy / d) * step;
      A.z[i] += (dz / d) * step;
      A.yaw[i] = Math.atan2(dx, dz);
      A.v[i] = v;
    }
    this.anim(i, 25, 0.35, 0, 0, dt);
    if (d < 0.05) {
      A.st[i] = HV_HOVER;
      A.tm[i] = 0.5 + this.rng.next() * 1.5;
    }
  }

  /** Fireflies: a swarm drifting under the trees at night, blinking, slowly falling into step. */
  private glow(i: number, dt: number): void {
    const A = this.A;
    const M = this.M;
    const lit = A.life[i] === Life.Leaving || this.shelter > 0.5 ? -1 : 1;
    A.hide[i] = clamp(A.hide[i] - lit * dt * 0.3, 0, 1);
    if (A.life[i] === Life.Leaving && A.hide[i] >= 1) return this.release(i);
    const m0 = A.group[i] * GROUP_SIZE;
    const n = A.members[i];
    // Mean blink phase, for synchrony.
    let sx = 0;
    let sz = 0;
    for (let m = m0; m < m0 + n; m++) {
      sx += Math.cos(M.w[m]);
      sz += Math.sin(M.w[m]);
    }
    const mean = Math.atan2(sz, sx);
    const g = this.ground(A.x[i], A.z[i]);
    for (let m = m0; m < m0 + n; m++) {
      M.w[m] += (TAU / 1.7 + 0.35 * Math.sin(mean - M.w[m])) * dt;
      if (M.w[m] > TAU) M.w[m] -= TAU;
      const seed = M.ph[m];
      const t = this.clock.t * 0.035;
      const nx = A.x[i] + Math.sin(t * 1.1 + seed) * 4 + Math.sin(t * 2.3 + seed * 3) * 1.5;
      const nz = A.z[i] + Math.cos(t * 0.9 + seed * 2) * 4 + Math.sin(t * 1.9 + seed) * 1.5;
      const ny = g + 1.2 + Math.sin(t * 1.7 + seed * 5) * 0.8;
      M.vx[m] = (nx - M.x[m]) / Math.max(dt, 1e-3);
      M.vz[m] = (nz - M.z[m]) / Math.max(dt, 1e-3);
      M.x[m] = nx;
      M.y[m] = ny;
      M.z[m] = nz;
      M.hide[m] = A.hide[i];
    }
  }

  /** Seals: rest on a quiet beach, lift the head, shuffle a little; slip into the sea for a swim and come back. */
  private haulOut(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const crawl = k.look.speed * A.spd[i];
    const swim = Math.min(k.vmax, 1.8) * A.spd[i];
    A.tm[i] -= dt;
    switch (A.st[i]) {
      case E_SWIM: {
        if (A.life[i] === Life.Leaving) {
          if (this.swimTo(i, k, A.tx[i], A.tz[i], this.surface(A.x[i], A.z[i]) - 0.6, swim, 0.5, dt) < 0) this.leave2(i);
          this.anim(i, 0.8, 0.8, 0, 0, dt);
          return;
        }
        this.cruise(i, k, swim, dt, 0.6);
        this.anim(i, 0.8, 0.8, 0, 0, dt);
        if (A.tm[i] <= 0 && this.shelter < 0.3) {
          if (this.shorePoint(i, k, A.x[i], A.z[i], -0.2) && this.beachAhead(A.tx[i], A.tz[i])) {
            A.st[i] = E_IN;
            A.tm[i] = 90;
          } else A.tm[i] = 20;
        }
        return;
      }
      case E_IN: {
        const d = this.swimTo(i, k, A.tx[i], A.tz[i], this.surface(A.x[i], A.z[i]) - 0.3, swim, 0.8, dt);
        this.anim(i, 0.8, 0.8, 0, 0, dt);
        // Swim in until the water is too shallow to swim (or the shore is reached), then haul out.
        if (d < 0.8 || A.tm[i] <= 0) {
          A.st[i] = E_UP;
          A.tm[i] = 60;
        }
        return;
      }
      case E_UP: {
        const gx = this.ground(A.x[i] + 1, A.z[i]) - this.ground(A.x[i] - 1, A.z[i]);
        const gz = this.ground(A.x[i], A.z[i] + 1) - this.ground(A.x[i], A.z[i] - 1);
        const l = hyp(gx, gz) || 1;
        const d = this.walkTo(i, k, A.x[i] + (gx / l) * 2, A.z[i] + (gz / l) * 2, crawl, 0.6, dt);
        this.surfaceOrGround(i, k, dt);
        this.anim(i, 1.2, 1, 0, 0, dt);
        if (this.ground(A.x[i], A.z[i]) > 0.8 || d < 0 || A.tm[i] <= 0) {
          // Rest only once out of the water; blocked in the shallows, slide back down and try elsewhere later.
          const dry = this.surface(A.x[i], A.z[i]) - this.ground(A.x[i], A.z[i]) < 0.05;
          A.st[i] = dry ? E_REST : E_DOWN;
          A.tm[i] = dry ? 40 + this.rng.next() * 150 : 60;
          A.a1[i] = 0;
        }
        return;
      }
      case E_REST: {
        this.stickToGround(i, k);
        const look = Math.max(0, Math.sin(this.clock.t * 0.25 + A.ph[i])) ** 6;
        A.pitch[i] += look * 0.18;
        const scratch = (this.clock.t + A.ph[i] * 9) % 30 < 1.5 ? 0.6 : 0;
        this.anim(i, 2, scratch, 0, 0, dt);
        if (A.flee[i] > 0 || this.shelter > 0.5 || A.life[i] === Life.Leaving || A.tm[i] <= 0) {
          if (A.tm[i] <= 0 && A.flee[i] <= 0 && this.shelter <= 0.5 && A.life[i] === Life.Live && this.rng.next() < 0.5 && this.pickNear(i, k, A.x[i], A.z[i], 1, 4)) {
            A.st[i] = E_SHUFFLE;
            A.tm[i] = 20;
          } else {
            A.st[i] = E_DOWN;
            A.tm[i] = 90;
            A.a1[i] = 0;
          }
        }
        return;
      }
      case E_SHUFFLE: {
        const d = this.walkTo(i, k, A.tx[i], A.tz[i], crawl, 0.6, dt);
        this.anim(i, 1.2, 1, 0, 0, dt);
        if (d < 0.05 || d < 0 || A.tm[i] <= 0) {
          A.st[i] = E_REST;
          A.tm[i] = 30 + this.rng.next() * 120;
        }
        return;
      }
      case E_DOWN: {
        if (this.backToSea(i, k, crawl, 0.6, 0.7, dt)) {
          A.st[i] = E_SWIM;
          A.tm[i] = 30 + this.rng.next() * 60;
          if (A.life[i] === Life.Leaving) this.leave2(i);
        }
        return;
      }
      default:
        A.st[i] = E_SWIM;
    }
  }

  /** Spiders: hang on silk from a shrub or rock, climbing and dropping a little; the silk glints at dawn. */
  private web(i: number, dt: number): void {
    const A = this.A;
    const leaving = A.life[i] === Life.Leaving || A.flee[i] > 0 || this.shelter > 0.5;
    const target = leaving ? 0 : A.a1[i];
    A.a0[i] = approach(A.a0[i], target, dt * 0.05) + clamp(target - A.a0[i], -0.02, 0.02) * dt;
    A.y[i] = A.hy[i] - A.a0[i];
    A.v[i] = 0;
    // Swing a little on the breeze.
    A.roll[i] = Math.sin(this.clock.t * 0.9 + A.ph[i]) * 0.08;
    A.pitch[i] = Math.sin(this.clock.t * 0.7 + A.ph[i] * 2) * 0.05;
    if ((this.clock.t + A.ph[i] * 10) % 12 < dt) A.a1[i] = 0.25 + this.rng.next() * 0.7;
    const glint = A.a0[i] > 0.02 ? silkGlint(this.clock.phase) : 0;
    // Tucked up under the leaf (thread drawn in): out of sight.
    A.hide[i] = approach(A.hide[i], A.a0[i] < 0.01 ? 1 : 0, dt * 2);
    // The shader reads silk length (aux, in body lengths) and glint (fold).
    this.anim(i, 0.5, 0.2, glint, A.a0[i] / Math.max(1e-3, A.scale[i]), dt);
    A.aux[i] = A.a0[i] / Math.max(1e-3, A.scale[i]);
    if (A.life[i] === Life.Leaving && A.a0[i] < 0.01) this.release(i);
  }

  /** Snails: creep slowly on wet nights with eye stalks out; draw in when disturbed. */
  private creep(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const sp = k.look.speed * A.spd[i];
    A.tm[i] -= dt;
    const shy = A.flee[i] > 0 || A.life[i] === Life.Leaving || A.st[i] === SN_TUCKED;
    if (shy) {
      this.stickToGround(i, k);
      this.anim(i, 0, 0, 1, 0, dt);
      if (A.life[i] === Life.Leaving && A.fold[i] > 0.95) {
        A.hide[i] = Math.min(1, A.hide[i] + dt * 0.5); // into the leaf litter
        if (A.hide[i] >= 1) this.release(i);
      }
      if (A.st[i] === SN_TUCKED && A.tm[i] <= 0) {
        A.st[i] = SN_CREEP;
        A.tm[i] = 30 + this.rng.next() * 60;
      }
      return;
    }
    if (A.tm[i] <= 0 && this.rng.next() < 0.3) {
      A.st[i] = SN_TUCKED;
      A.tm[i] = 15 + this.rng.next() * 30;
      return;
    }
    if (A.tm[i] <= 0) A.tm[i] = 20 + this.rng.next() * 40;
    if (hyp(A.tx[i] - A.x[i], A.tz[i] - A.z[i]) < 0.02 || this.walkTo(i, k, A.tx[i], A.tz[i], sp, 0.3, dt) < 0) this.pickNear(i, k, A.x[i], A.z[i], 0.1, 0.4);
    this.anim(i, 0.5, 0.5, 0, 0, dt);
  }

  // ---------- hatchlings ----------

  /** At dawn on a turtle beach near the camera, a clutch of hatchlings dashes to the sea (once a day). */
  private hatchlings(cut: boolean): void {
    if (cut) return;
    const p = this.clock.phase;
    if (p > D1) this.hatched = false;
    if (p > D1 * 0.9 || p < 0.01 || this.hatched) return;
    for (let ki = 0; ki < this.kinds.length; ki++) {
      const k = this.kinds[ki];
      if (k.beh !== B.nestBeach) continue;
      if (this.popNear(k.sp, this.view.tx, this.view.tz, 100) <= 0) continue;
      if (this.view.dist > 160) continue;
      const pch = this.pickPatch(this.near, 1 << Habitat.Beach);
      if (pch < 0) continue;
      const x = ORIGIN_X + ((pch % NP) + 0.5) * PATCH_M;
      const z = ORIGIN_Z + (Math.floor(pch / NP) + 0.5) * PATCH_M;
      const i = this.A.alloc(ki);
      if (i < 0) return;
      const b = this.M.alloc();
      if (b < 0) {
        this.A.free(i);
        return;
      }
      const A = this.A;
      // The nest sits on the beach above the swash.
      if (!this.shorePoint(i, k, x, z, 1.0)) {
        this.M.freeBlock(b);
        A.free(i);
        continue;
      }
      this.hatched = true;
      A.st[i] = T_HATCH;
      A.group[i] = b;
      A.members[i] = 10 + this.rng.int(GROUP_SIZE - 9);
      A.x[i] = A.tx[i];
      A.z[i] = A.tz[i];
      A.y[i] = this.ground(A.x[i], A.z[i]);
      A.scale[i] = 0.055;
      const M = this.M;
      const m0 = b * GROUP_SIZE;
      for (let m = m0; m < m0 + A.members[i]; m++) {
        M.x[m] = A.x[i] + (this.rng.next() - 0.5) * 0.4;
        M.z[m] = A.z[i] + (this.rng.next() - 0.5) * 0.4;
        M.y[m] = this.ground(M.x[m], M.z[m]) - 0.05;
        M.w[m] = this.rng.next() * 8; // emergence delay
        M.hide[m] = 1;
        M.ph[m] = this.rng.next() * TAU;
        M.yaw[m] = this.rng.next() * TAU;
        M.vx[m] = 0.08 + this.rng.next() * 0.07; // own crawling speed
      }
      return;
    }
  }

  /** Hatchlings dig out of the sand and scramble downhill into the sea, then dive and are gone. */
  private hatchRun(i: number, k: Kind, dt: number): void {
    const A = this.A;
    const M = this.M;
    const m0 = A.group[i] * GROUP_SIZE;
    let alive = 0;
    for (let m = m0; m < m0 + A.members[i]; m++) {
      if (M.w[m] > 0) {
        M.w[m] -= dt;
        alive++;
        continue;
      }
      const g = this.ground(M.x[m], M.z[m]);
      const s = this.surface(M.x[m], M.z[m]);
      if (M.hide[m] >= 1 && M.y[m] < s - 0.3) continue; // gone to sea
      alive++;
      if (s - g > 0.05) {
        // Swimming away, then diving.
        M.x[m] += Math.sin(M.yaw[m]) * 0.15 * dt;
        M.z[m] += Math.cos(M.yaw[m]) * 0.15 * dt;
        M.y[m] = Math.min(M.y[m] + (s - g > 0.4 ? -0.1 : 0) * dt, s - 0.01);
        M.hide[m] = s - g > 0.4 ? Math.min(1, M.hide[m] + dt * 0.5) : Math.max(0, M.hide[m] - dt * 2);
        if (M.hide[m] >= 1) M.y[m] = s - 0.5;
      } else {
        M.hide[m] = Math.max(0, M.hide[m] - dt * 2.5); // wriggling up out of the sand
        const gx = this.ground(M.x[m] + 0.5, M.z[m]) - this.ground(M.x[m] - 0.5, M.z[m]);
        const gz = this.ground(M.x[m], M.z[m] + 0.5) - this.ground(M.x[m], M.z[m] - 0.5);
        const want = Math.atan2(-gx, -gz) + Math.sin(this.clock.t * 2 + M.ph[m]) * 0.4;
        M.yaw[m] = turnToward(M.yaw[m], want, dt * 3);
        const v = Math.min(M.vx[m], k.vmax);
        M.x[m] += Math.sin(M.yaw[m]) * v * dt;
        M.z[m] += Math.cos(M.yaw[m]) * v * dt;
        M.y[m] = approach(M.y[m], this.ground(M.x[m], M.z[m]), dt * 4);
      }
      M.ph[m] = (M.ph[m] + 3 * TAU * dt) % PHASE_WRAP;
    }
    if (alive === 0) this.release(i);
  }

  // ---------- small effects ----------

  splash(x: number, y: number, z: number, size: number, n: number): void {
    for (let s = 0; s < n; s++) {
      const a = this.rng.next() * TAU;
      const r = this.rng.next() * size;
      this.P.emit(x + Math.cos(a) * r * 0.3, y + 0.05, z + Math.sin(a) * r * 0.3, Math.cos(a) * r * 1.2, 1.5 + this.rng.next() * 2.5 * size, Math.sin(a) * r * 1.2, 0.7 + this.rng.next() * 0.5, 0.12 * size + 0.05, 0.4 * size, 9.8, PointKind.Mist, 0.95, 0.98, 1, 0.8);
    }
  }

  private ripple(x: number, y: number, z: number, size: number): void {
    for (let s = 0; s < 4; s++) {
      const a = (s / 4) * TAU;
      this.P.emit(x, y + 0.02, z, Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3, 1.2, size * 0.2, size * 0.4, 0, PointKind.Mist, 0.9, 0.95, 1, 0.5);
    }
  }

  private wake(i: number): void {
    const A = this.A;
    const back = A.yaw[i] + Math.PI;
    const x = A.x[i] + Math.sin(back) * A.scale[i] * 0.4;
    const z = A.z[i] + Math.cos(back) * A.scale[i] * 0.4;
    for (let side = -1; side <= 1; side += 2) {
      const a = back + side * 0.6;
      this.P.emit(x, A.y[i] + 0.01, z, Math.sin(a) * 0.12, 0, Math.cos(a) * 0.12, 2.2, 0.08, 0.12, 0, PointKind.Mist, 0.92, 0.96, 1, 0.45);
    }
  }

  private blow(i: number): void {
    const A = this.A;
    const x = A.x[i] + Math.sin(A.yaw[i]) * A.scale[i] * 0.3;
    const z = A.z[i] + Math.cos(A.yaw[i]) * A.scale[i] * 0.3;
    const y = this.surface(x, z) + 0.2;
    for (let s = 0; s < 36; s++) {
      const a = this.rng.next() * TAU;
      const r = this.rng.next() * 0.5;
      this.P.emit(x + Math.cos(a) * r * 0.3, y, z + Math.sin(a) * r * 0.3, Math.cos(a) * r, 3 + this.rng.next() * 3, Math.sin(a) * r, 2.2 + this.rng.next() * 1.5, 0.5, 1.6, 1.2, PointKind.Mist, 0.93, 0.95, 0.97, 0.55);
    }
  }

  // ---------- far colonies: the speck flock ----------

  /**
   * Specks: a far colony's birds as small flapping dots. They take over exactly where the colony's 3D
   * birds thin out (COLONY_NEAR..COLONY_FAR from the eye), and each speck shows only while it is far
   * and small: one that comes near the eye, or would look bigger than a few pixels, fades out (that
   * close, birds are drawn as birds). They roost at night and sit out storms, like the real ones.
   */
  private fillSpecks(dt: number): void {
    const v = this.view;
    const t = this.clock.t;
    let n = 0;
    const maxSpecks = Math.round((this.phone ? 200 : 400) * clamp(this.density / (this.phone ? 0.8 : 1.2), 0.5, 1));
    const calm = 1 - this.shelter;
    for (let ci = 0; ci < this.colonies.length; ci++) {
      const c = this.colonies[ci];
      // Ledges found again after the ground changed may shift the colony's height: ease to it.
      c.yDraw = approach(c.yDraw, c.y, dt * 0.5);
      const ki = this.kindBySp[c.sp];
      if (ki < 0) continue;
      const k = this.kinds[ki];
      const fade = smooth(COLONY_NEAR, COLONY_FAR, hyp3(c.x - v.cx, c.yDraw - v.cy, c.z - v.cz)) * calm;
      if (fade <= 0.01) continue;
      const act = activityLevel(k.look.active, this.clock.phase);
      const count = Math.min(maxSpecks - n, Math.round(c.n * 160 * act * (this.phone ? 0.6 : 1)));
      const g = c.yDraw;
      for (let s = 0; s < count; s++) {
        const h1 = hash01(s * 3 + 1, c.sp);
        const h2 = hash01(s * 3 + 2, c.sp);
        const h3 = hash01(s * 3 + 3, c.sp);
        const R = c.r * (0.4 + 1.4 * h1);
        const w = (k.look.speed / R) * (0.6 + 0.4 * h2) * (h3 < 0.5 ? 1 : -1);
        const a = t * w + h2 * TAU;
        const x = c.x + Math.cos(a) * R;
        const y = g + 8 + 45 * h3 + Math.sin(t * 0.3 + s) * 3;
        const z = c.z + Math.sin(a) * R;
        const eye = hyp3(x - v.cx, y - v.cy, z - v.cz);
        const px = (SPECK_SIZE * v.pxPerRad) / Math.max(1, eye);
        const alpha = fade * smooth(150, 220, eye) * (1 - smooth(8, 12, px));
        if (alpha < 0.02) continue;
        const o = n * 8;
        this.specks[o] = x;
        this.specks[o + 1] = y;
        this.specks[o + 2] = z;
        // Wing beat: flap in bouts, glide between.
        const bout = (t * 0.25 + h1 * 7) % 1 < 0.35;
        this.specks[o + 3] = bout ? 0.5 + 0.45 * Math.sin(t * 22 + s) : 0.62;
        this.specks[o + 4] = alpha;
        this.specks[o + 5] = k.lin[0];
        this.specks[o + 6] = k.lin[1];
        this.specks[o + 7] = k.lin[2];
        n++;
      }
    }
    this.speckCount = n;
  }
}

/** Integer hash to [0, 1) for stable speck orbits. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Distances (m) at which a walker looks for safe ground away from lava. */
const REFUGE_RINGS = [5, 9, 14, 20, 28] as const;

/** What a walker may step on (see FaunaSim.walkTo). */
const WALK_HABITAT = 0;
const WALK_NO_LAVA = 1;
const WALK_ESCAPE = 2;

// State numbers per behaviour (each behaviour reads only its own).
const C_ORBIT = 0;
const C_APPROACH = 1;
const C_FLARE = 2;
const C_PERCH = 3;
const C_DROP = 4;
const C_PLUNGE = 5;
const C_FLOAT = 6;
const C_SHELTER_FLY = 7;
const C_SHELTER = 8;
const C_DIVE = 9;
const S_CIRCLE = 0;
const S_KITE = 1;
const S_GLIDE = 2;
const S_DESCEND = 3;
const S_PERCH = 4;
const F_PERCH = 0;
const F_FLY = 1;
const F_TO_GROUND = 2;
const F_GROUND = 3;
const W_STAND = 0;
const W_STEP = 1;
const W_STRIKE = 2;
const W_FLY = 3;
const R_PECK = 0;
const R_RUN = 1;
const R_FLY = 2;
const P_SWIM = 0;
const P_UPEND = 1;
const P_PREEN = 2;
const P_FLY = 3;
const N_FLY = 0;
const N_HANG = 1;
const K_HIDDEN = 0;
const K_EMERGE = 1;
const K_FREEZE = 2;
const K_SPRINT = 3;
const K_WANDER = 4;
const K_HOME = 5;
const K_BURROW = 6;
const L_BASK = 0;
const L_DISPLAY = 1;
const L_DART = 2;
const L_WALK = 3;
const L_HIDE = 9;
const G_GRAZE = 0;
const G_WALK = 1;
const G_REST = 2;
const T_SWIM = 0;
const T_APPROACH = 1;
const T_UP = 2;
const T_DIG = 3;
const T_LAY = 4;
const T_COVER = 5;
const T_DOWN = 6;
/** A clutch of hatchlings (a group agent of the turtle species). */
export const T_HATCH = 7;
const FL_FLY = 0;
const FL_SETTLED = 1;
const HV_HOVER = 0;
const HV_DART = 1;
const SN_CREEP = 0;
const SN_TUCKED = 1;
const Y_GLIDE = 0;
const Y_REST = 1;
const H_DIVE = 0;
const H_RISE = 1;
const H_SURFACE = 2;
const H_SOUND = 3;
const H_BREACH = 4;
const E_SWIM = 0;
const E_IN = 1;
const E_UP = 2;
const E_REST = 3;
const E_SHUFFLE = 4;
const E_DOWN = 5;

// ---------- drawing ----------

/**
 * Pixel size of something `size` metres across at a world point, or 0 if it is off screen.
 * Under about one pixel a thing can appear or vanish without anyone seeing it pop.
 */
export function apparentPx(v: FaunaView, sphere: THREE.Sphere, x: number, y: number, z: number, size: number): number {
  sphere.center.set(x, y, z);
  sphere.radius = Math.max(0.05, size);
  if (!v.frustum.intersectsSphere(sphere)) return 0;
  const d = Math.max(0.1, hyp3(x - v.cx, y - v.cy, z - v.cz));
  return (size * v.pxPerRad) / d;
}

/** Any valid colour triple, for the invisible warm-up animal. */
const WARM_COLORS = Float32Array.from([0x808080, 0x808080, 0x808080]);

/** Build the camera snapshot the simulation needs from a frame. */
export function viewFromCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3, dist: number, bufferHeight: number, out: FaunaView, m: THREE.Matrix4): FaunaView {
  camera.updateMatrixWorld();
  m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  out.frustum.setFromProjectionMatrix(m);
  out.tx = target.x;
  out.tz = target.z;
  out.cx = camera.position.x;
  out.cy = camera.position.y;
  out.cz = camera.position.z;
  out.dist = dist;
  out.pxPerRad = bufferHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  return out;
}

/** Turn yaw/pitch/roll (see Agents) into a quaternion without allocating. */
export function setOrientation(q: THREE.Quaternion, e: THREE.Euler, yaw: number, pitch: number, roll: number): THREE.Quaternion {
  e.set(-pitch, yaw, roll, 'YXZ');
  return q.setFromEuler(e);
}

export function createFauna(deps: SystemDeps): PageSystem {
  const { scene, fields, u, quality, renderer } = deps;
  const geoms = buildAnimalGeometries();
  const tris = planTriangles(geoms);
  const sim = new FaunaSim(deps.species, fields, { seed: 20260706, phone: quality.phone, density: quality.density }, tris);
  const mats = creatureMaterials(u);
  const group = new THREE.Group();
  group.name = 'fauna';
  scene.add(group);
  // One batch per body plan; capacity covers every agent or group member that could use it.
  const batches: (CreatureBatch | null)[] = geoms.map((g, plan) => {
    if (!g) return null;
    const cap = plan === AnimalModel.FishShoal ? sim.M.blocks * GROUP_SIZE : plan === HATCHLING_PLAN ? GROUP_SIZE * 2 : sim.A.cap;
    const b = new CreatureBatch(g, cap, mats);
    group.add(b.mesh);
    return b;
  });
  const points = new SoftPoints(400 + sim.M.blocks * GROUP_SIZE + sim.P.n, u);
  group.add(points.points);

  const view: FaunaView = { tx: 0, tz: 0, cx: 0, cy: 0, cz: 0, dist: 1, pxPerRad: 800, frustum: new THREE.Frustum() };
  const clock: FaunaClock = { t: 0, dt: 0, phase: 0, wet: 0, storm: { phase: 'none', t: 0, level: 0, great: false }, sunX: 0, sunZ: 1, brush: null, stroking: false };
  const mat4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const buf = new THREE.Vector2();
  const glowRgb = new Float32Array(3);
  // The creature programs (lit, and shadow once shadows are on) are built on the first frames.
  let warmedMain = false;
  let warmedShadow = false;
  // For the browser checks and screenshots: hold the animals' clock at a day phase (null = follow the sky).
  let phaseOverride: number | null = null;
  group.userData.setPhase = (p: number | null) => {
    phaseOverride = p;
    sim.cut();
  };
  group.userData.sim = sim;

  const draw = (f: FrameCtx) => {
    const A = sim.A;
    const M = sim.M;
    for (let plan = 0; plan < PLAN_COUNT; plan++) batches[plan]?.begin();
    points.begin();
    // Shadows only close up, where animals are big enough for a shadow to matter.
    const shadows = quality.shadows && f.cam.dist < 70;
    for (let i = 0; i < A.cap; i++) {
      if (A.life[i] === Life.Free) continue;
      const presence = A.presence(i);
      if (presence < 0.001) continue;
      const k = sim.kinds[A.kind[i]];
      if (k.group) continue;
      if (k.beh === B.nestBeach && A.st[i] === T_HATCH) continue;
      const b = batches[k.plan];
      if (!b) continue;
      setOrientation(q, e, A.yaw[i], A.pitch[i], A.roll[i]);
      const shadow = shadows && sim.castsShadow(A.x[i], A.y[i], A.z[i], A.scale[i]);
      b.add(A.x[i], A.y[i], A.z[i], A.scale[i], q, A.ph[i], A.amp[i], A.fold[i], A.aux[i], k.colors, 0, presence, shadow);
    }
    // Group members: fish, hatchlings, fireflies.
    const night = u.uNight.value;
    for (let i = 0; i < A.cap; i++) {
      if (A.life[i] === 0 || A.group[i] < 0) continue;
      const k = sim.kinds[A.kind[i]];
      const hatch = k.beh === B.nestBeach && A.st[i] === T_HATCH;
      if (!k.group && !hatch) continue;
      const m0 = A.group[i] * GROUP_SIZE;
      if (k.beh === B.glow) {
        hexToLinear(k.look.colors[0], glowRgb, 0);
        for (let m = m0; m < m0 + A.members[i]; m++) {
          const blink = Math.pow(Math.max(0, Math.sin(M.w[m])), 6);
          const a = blink * (1 - M.hide[m]) * (0.35 + 0.65 * night);
          if (a < 0.02) continue;
          points.add(M.x[m], M.y[m], M.z[m], 0.14, glowRgb[0] * 1.6, glowRgb[1] * 1.6, glowRgb[2] * 1.6, a, PointKind.Glow);
        }
        continue;
      }
      const b = batches[hatch ? HATCHLING_PLAN : k.plan];
      if (!b) continue;
      const presence = A.presence(i);
      for (let m = m0; m < m0 + A.members[i]; m++) {
        const mp = presence * (1 - M.hide[m]);
        if (mp < 0.001 || (hatch && M.w[m] > 0)) continue;
        const sp = hyp3(M.vx[m], M.vy[m], M.vz[m]);
        const pitch = hatch ? 0 : Math.atan2(M.vy[m], Math.max(0.05, hyp(M.vx[m], M.vz[m]))) * 0.6;
        setOrientation(q, e, M.yaw[m], pitch, 0);
        const scale = hatch ? A.scale[i] : A.scale[i] * (0.85 + 0.3 * ((m * 0.618) % 1));
        const shadow = shadows && sim.castsShadow(M.x[m], M.y[m], M.z[m], scale);
        b.add(M.x[m], M.y[m], M.z[m], scale, q, M.ph[m], hatch ? 1 : clamp(0.4 + sp, 0.4, 1.2), 0, hatch ? 0 : M.w[m], k.colors, 0, mp, shadow);
      }
    }
    // Specks over far colonies.
    const S = sim.specks;
    for (let s = 0; s < sim.speckCount; s++) {
      const o = s * 8;
      points.add(S[o], S[o + 1], S[o + 2], SPECK_SIZE, S[o + 5] * 0.55, S[o + 6] * 0.55, S[o + 7] * 0.55, S[o + 4] * 0.9, PointKind.Speck + clamp(S[o + 3], 0, 0.99));
    }
    // Splashes, blows, wakes, flicked sand.
    const P = sim.P;
    for (let p = 0; p < P.n; p++) {
      if (P.age[p] >= P.life[p]) continue;
      const u01 = P.age[p] / P.life[p];
      const fade = (1 - u01) * Math.min(1, u01 * 8);
      points.add(P.x[p], P.y[p], P.z[p], P.size[p] + P.grow[p] * u01, P.rgba[p * 4], P.rgba[p * 4 + 1], P.rgba[p * 4 + 2], P.rgba[p * 4 + 3] * fade, P.kind[p]);
    }
    // Warm-up: one invisible animal at the camera target, drawn (with a shadow when shadows are on) so
    // WebGL builds the creature programs at load, not when the first animal or shadow appears.
    const warmShadow = quality.shadows && !warmedShadow;
    if (!warmedMain || warmShadow) {
      const t = f.cam.target;
      q.identity();
      batches[AnimalModel.Seabird]?.warm(t.x, t.y, t.z, q, sim.kinds[0]?.colors ?? WARM_COLORS);
      points.add(t.x, t.y, t.z, 1, 0, 0, 0, 0, PointKind.Glow);
      warmedMain = true;
      warmedShadow = warmedShadow || warmShadow;
    }
    // The bounds pad is in body lengths: a spider's silk can hang a hundred or more of its tiny body lengths.
    for (let plan = 0; plan < PLAN_COUNT; plan++) batches[plan]?.end(shadows || warmShadow, plan === AnimalModel.Spider ? 300 : 1.6);
    renderer.getDrawingBufferSize(buf);
    points.end(buf.y);
  };

  return {
    name: 'fauna',
    onEngine(m: FromEngine) {
      if (m.t === 'life') sim.setLife(m.life);
      else if (m.t === 'clear') sim.clear();
      else if (m.t === 'ready') sim.cut();
    },
    update(f: FrameCtx) {
      sim.setQuality(quality.phone, quality.density);
      renderer.getDrawingBufferSize(buf);
      viewFromCamera(f.camera, f.cam.target, f.cam.dist, buf.y, view, mat4);
      clock.t = f.t;
      clock.dt = f.dt;
      clock.phase = phaseOverride ?? f.day.phase;
      clock.wet = clamp(u.uWet.value + (f.day.season === 'wet' ? 0.6 : 0.15), 0, 1);
      clock.storm = f.storm;
      clock.sunX = u.uSunDir.value.x;
      clock.sunZ = u.uSunDir.value.z;
      clock.brush = f.brush;
      clock.stroking = f.stroking;
      sim.step(clock, view);
      draw(f);
    },
    dispose() {
      sim.dispose();
      for (const b of batches) b?.dispose();
      points.dispose();
      scene.remove(group);
    },
  };
}
