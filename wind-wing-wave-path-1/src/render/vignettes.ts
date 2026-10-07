/**
 * Arrival scenes (WP-F2): short, calm moments in real time (10-40 s) that stand for something the
 * racing years produced. The journal keeps the year; this shows the moment.
 *
 * Every arrival event (tick events.arrivals: species, road, x, z, ok) gets:
 * - A marker: soft glow motes rising from the spot for about 30 s, so when the player taps the
 *   arrival card and the camera glides there, there is something to find.
 * - A scene, if the spot is near the camera (or the camera comes near while the marker still glows):
 *   - wind: a stream of glinting motes drifting in from the east (upwind) to settle on the rock,
 *     or one silk thread with a tiny ballooning spider;
 *   - sea: a coconut or a few drift seeds bobbing ashore on the swell; after storms, a raft (a log
 *     with a leafy branch) carrying 1-3 lizards that grounds so they can scamper off; sea animals
 *     swim in to the shallows; a crab walks out of the surf;
 *   - wings: a bird flies in from the horizon, perches, preens and leaves (dropping a glinting seed
 *     when it carried a plant); insects come in low over the sea.
 *   - A visitor that could not stay (ok = false) leaves again: the coconut washes back out, the motes
 *     blow on past, the bird circles and goes.
 *
 * Nothing pops: things start out of view or too far to see, or else fade in (the creature shader's
 * screen-door presence: a swimmer rising from deeper water, a raft out of the glare, a crab out of
 * the surf); motes and silk fade in as light. They end the same quiet ways, and an actor is only let
 * go once it is out of view, too small to see, or faded right out. The simulation (`VignetteSim`) is
 * plain arrays, tested in tests/fauna.test.ts; createVignettes draws it with the shared creature
 * material.
 */
import * as THREE from 'three';
import { WIND_TO_X, WIND_TO_Z } from '../config';
import { AnimalModel, PlantModel, roadFamily, type Road, type SpeciesDef } from '../content/speciesTypes';
import { Rng } from '../engine/noise';
import { PLANT_BYTES, type ArrivalEvent, type FromEngine } from '../engine/protocol';
import { apparentPx, displaySize, hyp, hyp3, plantTop, setOrientation, viewFromCamera, type FaunaView } from './fauna';
import type { WorldFields } from './fields';
import { CreatureBatch, PAINT, PLAN_COUNT, Part, PointKind, Shape, SoftPoints, UP, backBelly, buildAnimalGeometries, creatureMaterials, hexToLinear, shade, type Vec3 } from './models/animals';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';
import { seaHeight } from './waves';

export type SceneKind = 'motes' | 'silk' | 'coconut' | 'seeds' | 'raft' | 'bird' | 'flyers' | 'swim' | 'crab';

/** A scene plays when its spot is this close to the camera target (m)... */
export const SCENE_RANGE = 260;
/** ...and the camera is no further out than this. */
export const SCENE_MAX_DIST = 650;
/** How long the rising marker glows (s). */
export const MARKER_SECONDS = 30;

const TAU = Math.PI * 2;
/** Where an arriving bird may start: distance upwind and offset across the wind (m), nearest first. */
const BIRD_STARTS: readonly (readonly [number, number])[] = [
  [260, 0],
  [260, 90],
  [260, -90],
  [320, 0],
  [300, 160],
  [300, -160],
];
/** Bearings (rad) either side of straight out to sea that seaStart tries, nearest first. */
const FAN = [0, 0.45, -0.45, 0.9, -0.9, 1.3, -1.3] as const;
const MAX_SCENES = 3;
const MAX_WAITING = 4;
const MAX_ACTORS = 4;
const MAX_MOTES = 48;
const MAX_MARKERS = 8;
const MARKER_MOTES = 14;
/** After this long (s) a scene stops and its last actors leave as soon as they are out of sight. */
const SCENE_LINGER = 240;

/** Props drawn with the creature material: index after the animal body plans. */
const PROP_COCONUT = PLAN_COUNT;
const PROP_SEED = PLAN_COUNT + 1;
const PROP_RAFT = PLAN_COUNT + 2;
const VISUAL_COUNT = PLAN_COUNT + 3;

/** Which scene shows a species arriving by a road. */
export function sceneFor(s: SpeciesDef, road: Road): SceneKind {
  const a = s.animal;
  if (!a) {
    if (road === 'wind' || road === 'storm') return 'motes';
    if (road === 'sea') return s.plant?.model === PlantModel.Palm ? 'coconut' : 'seeds';
    if (road === 'raft') return 'raft';
    return 'bird';
  }
  switch (a.model) {
    case AnimalModel.Seabird:
    case AnimalModel.Frigatebird:
    case AnimalModel.SmallBird:
    case AnimalModel.Wader:
    case AnimalModel.Shorebird:
    case AnimalModel.Duck:
    case AnimalModel.Bat:
      return 'bird';
    case AnimalModel.Butterfly:
    case AnimalModel.Dragonfly:
    case AnimalModel.Bee:
      return road === 'raft' ? 'raft' : 'flyers';
    case AnimalModel.Firefly:
      return 'motes';
    case AnimalModel.Spider:
      return road === 'raft' ? 'raft' : 'silk';
    case AnimalModel.Crab:
      return road === 'raft' ? 'raft' : 'crab';
    case AnimalModel.SeaTurtle:
    case AnimalModel.Ray:
    case AnimalModel.Dolphin:
    case AnimalModel.Whale:
    case AnimalModel.FishShoal:
    case AnimalModel.Seal:
    case AnimalModel.Shark:
    case AnimalModel.Tortoise: // tortoises float, and have crossed whole oceans that way
      return 'swim';
    default:
      // Lizards, snails and other small walkers: on storm rafts, or as eggs in mud on a bird's feet.
      return road === 'bird' ? 'bird' : 'raft';
  }
}

/** Body plans that fly in as themselves (anything else arriving by wing comes with a carrier bird). */
function fliesIn(model: number): boolean {
  return (
    model === AnimalModel.Seabird ||
    model === AnimalModel.Frigatebird ||
    model === AnimalModel.SmallBird ||
    model === AnimalModel.Wader ||
    model === AnimalModel.Shorebird ||
    model === AnimalModel.Duck ||
    model === AnimalModel.Bat
  );
}

/** Small walkers that can ride a raft as themselves. */
function rides(model: number): boolean {
  return model === AnimalModel.Lizard || model === AnimalModel.Snail || model === AnimalModel.Spider || model === AnimalModel.Crab;
}

// ---------- props, made in code ----------

function coconutShape(): Shape {
  const sh = new Shape();
  // A husked coconut: a fat three-sided ovoid, green-brown with a fibrous end.
  sh.tube(
    [
      { c: [0, 0.02, -0.5], rx: 0, ry: 0, paint: PAINT.SEC },
      { c: [0, 0.02, -0.38], rx: 0.3, ry: 0.27, paint: PAINT.PRI },
      { c: [0, 0.02, 0.0], rx: 0.42, ry: 0.4, paint: PAINT.PRI },
      { c: [0, 0.02, 0.3], rx: 0.32, ry: 0.3, paint: shade(PAINT.PRI, 0.9) },
      { c: [0, 0.02, 0.5], rx: 0, ry: 0, paint: PAINT.ACC },
    ],
    6,
  );
  return sh;
}

function seedShape(): Shape {
  const sh = new Shape();
  sh.tube(
    [
      { c: [0, 0, -0.5], rx: 0, ry: 0, paint: PAINT.SEC },
      { c: [0, 0, 0], rx: 0.5, ry: 0.22, paint: backBelly(PAINT.PRI, PAINT.SEC) },
      { c: [0, 0, 0.5], rx: 0, ry: 0, paint: PAINT.SEC },
    ],
    5,
  );
  return sh;
}

/** Top of the raft's log above its axis, in log lengths (the log's radius, see raftShape). */
const LOG_TOP = 0.072;

function raftShape(): Shape {
  const sh = new Shape();
  // A storm-broken log (1 unit = its length) with a leafy branch still attached.
  const bark = backBelly(PAINT.PRI, shade(PAINT.PRI, 0.75));
  sh.tube(
    [
      { c: [0, 0, -0.5], rx: 0.055, ry: 0.055, paint: PAINT.ACC },
      { c: [0, 0, -0.48], rx: 0.065, ry: 0.065, paint: bark },
      { c: [0, 0.005, 0.0], rx: 0.07, ry: 0.07, paint: bark },
      { c: [0, 0, 0.47], rx: 0.06, ry: 0.06, paint: bark },
      { c: [0, 0, 0.5], rx: 0.05, ry: 0.05, paint: PAINT.ACC },
    ],
    7,
  );
  // End caps (pale broken wood).
  for (const z of [-0.5, 0.5]) {
    const pts: Vec3[] = [];
    for (let k = 0; k < 6; k++) pts.push([Math.sin((k / 6) * TAU) * 0.05, Math.cos((k / 6) * TAU) * 0.05, z]);
    sh.panel(pts, PAINT.ACC, () => 0, [0, 0, z]);
  }
  // The branch: a stick angling up and out, with leaves that ripple in the breeze.
  sh.tube(
    [
      { c: [0.03, 0.04, 0.15], rx: 0.02, ry: 0.02, paint: PAINT.PRI },
      { c: [0.2, 0.2, 0.32], rx: 0.012, ry: 0.012, paint: PAINT.PRI },
      { c: [0.32, 0.3, 0.45], rx: 0, ry: 0, paint: PAINT.PRI },
    ],
    4,
  );
  const leaves: [number, number, number, number][] = [
    [0.14, 0.15, 0.27, 0.6],
    [0.22, 0.22, 0.35, -0.4],
    [0.28, 0.27, 0.41, 1.2],
    [0.18, 0.18, 0.3, 2.2],
    [0.3, 0.3, 0.46, -1.4],
    [0.25, 0.25, 0.38, 2.9],
  ];
  for (const [x, y, z, a] of leaves) {
    sh.as({ part: Part.Streamer, pivot: [x, y, z] });
    const dx = Math.sin(a) * 0.12;
    const dz = Math.cos(a) * 0.12;
    sh.panel(
      [
        [x, y, z],
        [x + dx * 0.5 - dz * 0.25, y + 0.01, z + dz * 0.5 + dx * 0.25],
        [x + dx, y - 0.02, z + dz],
        [x + dx * 0.5 + dz * 0.25, y + 0.01, z + dz * 0.5 - dx * 0.25],
      ],
      PAINT.SEC,
      (p) => hyp(p[0] - x, p[2] - z) / 0.12,
      UP,
    );
  }
  return sh;
}

const COCONUT_COLORS = Float32Array.from([0x6f6a2e, 0x8a6a3a, 0x5a4428]);
const SEED_COLORS = Float32Array.from([0x6a4a2c, 0x9a7a4a, 0x3a2a1a]);
const RAFT_COLORS = Float32Array.from([0x6e5a44, 0x4f8a3e, 0xc8b48c]);
/** The bird that brings a plant's seed: a brown fruit-dove (the small-bird body at pigeon size). */
const CARRIER_PLAN = AnimalModel.SmallBird;
const CARRIER_SIZE = 0.3;
const CARRIER_COLORS = Float32Array.from([0x6a5a4e, 0xb8a898, 0xd8a03a]);

// ---------- the scene simulation ----------

interface Marker {
  on: boolean;
  x: number;
  y: number;
  z: number;
  t: number;
  family: number;
}

/** One arrival scene. All storage is preallocated; scenes are reused. */
export class Scene {
  on = false;
  /** Waiting for the camera to come near (the marker is still glowing). */
  waiting = false;
  kind: SceneKind = 'motes';
  sp = -1;
  ok = true;
  x = 0;
  z = 0;
  t = 0;
  st = 0;
  tm = 0;
  /** Seconds left before a waiting scene is dropped. */
  expire = 0;
  /** Approach: start out at sea, waterline, landing point. */
  sx = 0;
  sz = 0;
  wx = 0;
  wz = 0;
  lx = 0;
  lz = 0;
  hasShore = false;
  /** Where seaStart put the start out at sea. */
  bx = 0;
  bz = 0;
  n = 0;
  readonly plan = new Int16Array(MAX_ACTORS);
  readonly x0 = new Float64Array(MAX_ACTORS);
  readonly y0 = new Float64Array(MAX_ACTORS);
  readonly z0 = new Float64Array(MAX_ACTORS);
  readonly tx = new Float64Array(MAX_ACTORS);
  readonly ty = new Float64Array(MAX_ACTORS);
  readonly tz = new Float64Array(MAX_ACTORS);
  readonly yaw = new Float32Array(MAX_ACTORS);
  readonly pitch = new Float32Array(MAX_ACTORS);
  readonly roll = new Float32Array(MAX_ACTORS);
  readonly v = new Float32Array(MAX_ACTORS);
  readonly vy = new Float32Array(MAX_ACTORS);
  readonly ph = new Float32Array(MAX_ACTORS);
  readonly amp = new Float32Array(MAX_ACTORS);
  readonly fold = new Float32Array(MAX_ACTORS);
  readonly aux = new Float32Array(MAX_ACTORS);
  readonly scale = new Float32Array(MAX_ACTORS);
  readonly speed = new Float32Array(MAX_ACTORS);
  /** 0 shown .. 1 hidden (buried, sunk, tucked under leaves, not set off yet). */
  readonly hide = new Float32Array(MAX_ACTORS);
  /** Entrance fade: 1 = just appeared in view (drawn see-through) .. 0 fully there. */
  readonly ent = new Float32Array(MAX_ACTORS);
  readonly gone = new Uint8Array(MAX_ACTORS);
  readonly st2 = new Uint8Array(MAX_ACTORS);
  readonly tm2 = new Float32Array(MAX_ACTORS);
  readonly colors = new Float32Array(MAX_ACTORS * 3);
  m = 0;
  readonly mx = new Float32Array(MAX_MOTES);
  readonly my = new Float32Array(MAX_MOTES);
  readonly mz = new Float32Array(MAX_MOTES);
  readonly ms = new Float32Array(MAX_MOTES * 3);
  readonly mt = new Float32Array(MAX_MOTES * 3);
  readonly mdur = new Float32Array(MAX_MOTES);
  readonly malpha = new Float32Array(MAX_MOTES);
  readonly mphase = new Float32Array(MAX_MOTES);
  readonly mrgb = new Float32Array(3);
  /** A falling seed glint: x, y, z, t (t < 0 = none). */
  glintX = 0;
  glintY = 0;
  glintZ = 0;
  glintT = -1;

  /** How much of an actor is drawn, 0..1 (the creature shader's presence). */
  presence(i: number): number {
    return (1 - this.hide[i]) * (1 - this.ent[i]);
  }
}

/** Entrance fades last this long (s): slow for things rising out of the sea, quicker for the rest. */
const FADE_IN_SEA = 3;
const FADE_IN = 1.5;

export interface VignetteClock {
  t: number;
  dt: number;
  storm: number;
}

/** Arrival scenes as plain data: queue arrivals, step them, read actors/motes/markers to draw. */
export class VignetteSim {
  readonly scenes: Scene[] = [];
  readonly markers: Marker[] = [];
  private readonly rng: Rng;
  private readonly sphere = new THREE.Sphere();
  private view!: FaunaView;
  private clock!: VignetteClock;
  /** Puffs (whale blows, splashes): x, y, z, vx, vy, vz, age, life per puff. */
  readonly puffs = new Float32Array(64 * 8);
  private puffHead = 0;

  constructor(
    private readonly species: readonly SpeciesDef[],
    private readonly fields: WorldFields,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    for (let i = 0; i < MAX_SCENES + MAX_WAITING; i++) this.scenes.push(new Scene());
    for (let i = 0; i < MAX_MARKERS; i++) this.markers.push({ on: false, x: 0, y: 0, z: 0, t: 0, family: 0 });
    for (let p = 0; p < 64; p++) this.puffs[p * 8 + 6] = this.puffs[p * 8 + 7] = 1;
  }

  /** A new arrival: always a marker; a scene now if near, or later if the camera comes while the marker glows. */
  arrive(ev: ArrivalEvent, view: FaunaView | null): void {
    const s = this.species[ev.species];
    if (!s) return;
    const fam = roadFamily(ev.road);
    const mk = this.markers.find((m) => !m.on) ?? this.markers.reduce((a, b) => (a.t > b.t ? a : b));
    mk.on = true;
    mk.x = ev.x;
    mk.z = ev.z;
    mk.y = Math.max(this.fields.heightAt(ev.x, ev.z), 0);
    mk.t = 0;
    mk.family = fam === 'wind' ? 0 : fam === 'wave' ? 1 : 2;
    const slot = this.scenes.find((sc) => !sc.on);
    if (!slot) return;
    slot.on = true;
    slot.waiting = true;
    slot.expire = MARKER_SECONDS;
    slot.kind = sceneFor(s, ev.road);
    slot.sp = ev.species;
    slot.ok = ev.ok;
    slot.x = ev.x;
    slot.z = ev.z;
    if (view && this.isNear(view, slot)) {
      this.view = view;
      this.start(slot);
    }
  }

  private isNear(v: FaunaView, sc: Scene): boolean {
    return hyp(sc.x - v.tx, sc.z - v.tz) < SCENE_RANGE && v.dist < SCENE_MAX_DIST;
  }

  activeScenes(): number {
    let n = 0;
    for (const sc of this.scenes) if (sc.on && !sc.waiting) n++;
    return n;
  }

  step(clock: VignetteClock, view: FaunaView): void {
    this.clock = clock;
    this.view = view;
    const dt = clock.dt;
    for (const m of this.markers) {
      if (!m.on) continue;
      m.t += dt;
      if (m.t > MARKER_SECONDS) m.on = false;
    }
    for (const sc of this.scenes) {
      if (!sc.on) continue;
      if (sc.waiting) {
        sc.expire -= dt;
        if (sc.expire <= 0) sc.on = false;
        else if (this.activeScenes() < MAX_SCENES && this.isNear(view, sc)) this.start(sc);
        continue;
      }
      sc.t += dt;
      this.stepScene(sc, dt);
    }
    for (let p = 0; p < 64; p++) {
      const o = p * 8;
      if (this.puffs[o + 6] >= this.puffs[o + 7]) continue;
      this.puffs[o + 6] += dt;
      this.puffs[o] += this.puffs[o + 3] * dt;
      this.puffs[o + 1] += this.puffs[o + 4] * dt;
      this.puffs[o + 2] += this.puffs[o + 5] * dt;
      this.puffs[o + 4] -= 1.5 * dt;
    }
  }

  // ---------- setting a scene ----------

  private start(sc: Scene): void {
    if (this.activeScenes() >= MAX_SCENES) return;
    sc.waiting = false;
    sc.t = 0;
    sc.st = 0;
    sc.tm = 0;
    sc.n = 0;
    sc.m = 0;
    sc.glintT = -1;
    sc.gone.fill(0);
    sc.hide.fill(0);
    sc.ent.fill(0);
    sc.st2.fill(0);
    this.findShore(sc);
    const s = this.species[sc.sp];
    const a = s.animal;
    switch (sc.kind) {
      case 'motes':
        this.setupMotes(sc, a ? a.colors[0] : 0xfff6d0);
        break;
      case 'silk':
        this.setupSilk(sc, s);
        break;
      case 'coconut':
      case 'seeds':
        this.setupFloaters(sc);
        break;
      case 'raft':
        this.setupRaft(sc, s);
        break;
      case 'bird':
        this.setupBird(sc, s);
        break;
      case 'flyers':
        this.setupFlyers(sc, s);
        break;
      case 'swim':
        this.setupSwim(sc, s);
        break;
      case 'crab':
        this.setupCrab(sc, s);
        break;
    }
    // Whatever would be seen where it starts fades in instead of appearing (see `ent`).
    for (let i = 0; i < sc.n; i++) if (sc.hide[i] < 1 && this.inSight(sc, i)) sc.ent[i] = 1;
  }

  /** Could actor i be seen where it is now (at full presence)? */
  private inSight(sc: Scene, i: number): boolean {
    return apparentPx(this.view, this.sphere, sc.x0[i], sc.y0[i], sc.z0[i], this.extent(sc, i) * 1.3) >= 0.5;
  }

  /** On-screen size (px) of actor i in the last stepped view, times its presence if `faded`. */
  visiblePx(sc: Scene, i: number, faded: boolean): number {
    const px = apparentPx(this.view, this.sphere, sc.x0[i], sc.y0[i], sc.z0[i], this.extent(sc, i));
    return faded ? px * sc.presence(i) : px;
  }

  /** The biggest visible extent of an actor (m): wingspan, the log and its branch, a silk thread. */
  private extent(sc: Scene, i: number): number {
    const plan = sc.plan[i];
    if (plan === AnimalModel.Spider) return sc.fold[i] > 0.02 ? 1.6 : sc.scale[i];
    if (plan === PROP_RAFT) return sc.scale[i];
    if (plan === AnimalModel.Seabird || plan === AnimalModel.Frigatebird || plan === AnimalModel.Wader || plan === AnimalModel.Shorebird || plan === AnimalModel.Duck || plan === AnimalModel.Bat || plan === AnimalModel.Ray || plan === AnimalModel.Crab) return sc.scale[i] * 2.6;
    if (plan === AnimalModel.SmallBird) return sc.scale[i] * 1.4;
    return sc.scale[i];
  }

  /**
   * The nearest sea from the spot: waterline W (just under water), landing L (just above the swash)
   * and a start S out at sea along the same line. Without a shore nearby, `hasShore` is false.
   */
  private findShore(sc: Scene): void {
    const f = this.fields;
    sc.hasShore = false;
    const onLand = f.heightAt(sc.x, sc.z) > 0;
    let best = Infinity;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU;
      const ux = Math.sin(a);
      const uz = Math.cos(a);
      for (let r = 2; r < 90; r += 2) {
        const h = f.heightAt(sc.x + ux * r, sc.z + uz * r);
        if ((onLand && h < -0.4) || (!onLand && h > 0.3)) {
          if (r < best) {
            best = r;
            // Seaward unit vector.
            sc.sx = onLand ? ux : -ux;
            sc.sz = onLand ? uz : -uz;
          }
          break;
        }
      }
    }
    if (best === Infinity) {
      sc.sx = -WIND_TO_X;
      sc.sz = -WIND_TO_Z;
      sc.wx = sc.lx = sc.x;
      sc.wz = sc.lz = sc.z;
      return;
    }
    // March along the seaward line to find the waterline and a dry landing just above it.
    let px = onLand ? sc.x : sc.x - sc.sx * best;
    let pz = onLand ? sc.z : sc.z - sc.sz * best;
    for (let s = 0; s < 120 && f.heightAt(px, pz) > 0.35; s++) {
      px += sc.sx * 0.5;
      pz += sc.sz * 0.5;
    }
    sc.lx = px - sc.sx * 0.8;
    sc.lz = pz - sc.sz * 0.8;
    for (let s = 0; s < 120 && f.heightAt(px, pz) > -0.15; s++) {
      px += sc.sx * 0.5;
      pz += sc.sz * 0.5;
    }
    sc.wx = px;
    sc.wz = pz;
    sc.hasShore = f.heightAt(sc.lx, sc.lz) > 0;
  }

  /**
   * A start point out at sea for something swimming or drifting in to the shore (written to bx, bz):
   * the nearest spot out of view, first straight out from the waterline, then fanning out to either
   * side, between minD and maxD from the waterline (how far it can travel in the scene) and in water
   * at least `depth` deep. When every candidate is in view (the camera looks out to sea), the near
   * end: the actor fades in there instead (see `ent`), rising from below or out of the glare.
   */
  private seaStart(sc: Scene, minD: number, maxD: number, size: number, depth: number): void {
    sc.bx = sc.wx + sc.sx * minD;
    sc.bz = sc.wz + sc.sz * minD;
    const steps = 8;
    for (let n = 0; n <= steps; n++) {
      const d = minD + ((maxD - minD) * n) / steps;
      for (let b = 0; b < FAN.length; b++) {
        const c = Math.cos(FAN[b]);
        const sn = Math.sin(FAN[b]);
        const ux = sc.sx * c - sc.sz * sn;
        const uz = sc.sz * c + sc.sx * sn;
        const x = sc.wx + ux * d;
        const z = sc.wz + uz * d;
        if (-this.fields.heightAt(x, z) < depth) continue;
        if (apparentPx(this.view, this.sphere, x, 0, z, size * 1.3) < 0.5) {
          sc.bx = x;
          sc.bz = z;
          return;
        }
      }
    }
  }

  private addActor(sc: Scene, plan: number, scale: number, colors: ArrayLike<number>): number {
    const i = sc.n++;
    sc.plan[i] = plan;
    sc.scale[i] = scale;
    sc.colors[i * 3] = colors[0];
    sc.colors[i * 3 + 1] = colors[1];
    sc.colors[i * 3 + 2] = colors[2];
    sc.yaw[i] = sc.pitch[i] = sc.roll[i] = 0;
    sc.v[i] = sc.vy[i] = 0;
    sc.ph[i] = this.rng.next() * TAU;
    sc.amp[i] = sc.fold[i] = sc.aux[i] = 0;
    sc.hide[i] = 0;
    sc.gone[i] = 0;
    sc.st2[i] = 0;
    sc.tm2[i] = 0;
    return i;
  }

  private setupMotes(sc: Scene, color: number): void {
    const f = this.fields;
    const g = Math.max(0, f.heightAt(sc.x, sc.z));
    hexToLinear(color, sc.mrgb, 0);
    sc.m = 30 + this.rng.int(MAX_MOTES - 30);
    for (let m = 0; m < sc.m; m++) {
      const o = m * 3;
      // From upwind, in a loose stream.
      sc.ms[o] = sc.x - WIND_TO_X * (70 + this.rng.next() * 40) + (this.rng.next() - 0.5) * 6;
      sc.ms[o + 1] = g + 4 + this.rng.next() * 14;
      sc.ms[o + 2] = sc.z - WIND_TO_Z * (70 + this.rng.next() * 40) + (this.rng.next() - 0.5) * 24;
      if (sc.ok) {
        const a = this.rng.next() * TAU;
        const r = Math.sqrt(this.rng.next()) * 5;
        sc.mt[o] = sc.x + Math.cos(a) * r;
        sc.mt[o + 2] = sc.z + Math.sin(a) * r;
        sc.mt[o + 1] = Math.max(f.heightAt(sc.mt[o], sc.mt[o + 2]), 0) + 0.05;
      } else {
        sc.mt[o] = sc.x + WIND_TO_X * (50 + this.rng.next() * 30);
        sc.mt[o + 2] = sc.z + WIND_TO_Z * (50 + this.rng.next() * 30) + (this.rng.next() - 0.5) * 20;
        sc.mt[o + 1] = g + 6 + this.rng.next() * 10;
      }
      sc.mdur[m] = 20 + this.rng.next() * 8;
      sc.mphase[m] = this.rng.next() * TAU;
      sc.malpha[m] = 0;
    }
  }

  private setupSilk(sc: Scene, s: SpeciesDef): void {
    const a = s.animal;
    const size = a ? displaySize(a) : 0.008;
    const i = this.addActor(sc, AnimalModel.Spider, size, a ? a.colors.map((c) => c & 0xffffff) : [0x6a5a4a, 0xe8e0d0, 0x6a5a4a]);
    const g = Math.max(0, this.fields.heightAt(sc.x, sc.z));
    sc.x0[i] = sc.x - WIND_TO_X * 55;
    sc.z0[i] = sc.z - WIND_TO_Z * 55 + (this.rng.next() - 0.5) * 8;
    sc.y0[i] = g + 6 + this.rng.next() * 3;
    sc.tx[i] = sc.x;
    sc.tz[i] = sc.z;
    sc.ty[i] = g + Math.max(0.3, plantTop(PlantModel.Fern, 1) * 0.8);
    sc.aux[i] = 1.6 / size; // thread length in body lengths
    sc.fold[i] = 0; // glint, fades in
    // The thread streams up and downwind of the spider.
    sc.roll[i] = 0.65;
  }

  private setupFloaters(sc: Scene): void {
    const coconut = sc.kind === 'coconut';
    const count = coconut ? 1 : 3 + this.rng.int(2);
    this.seaStart(sc, 25, 80, coconut ? 0.3 : 0.06, 0.3);
    const bx = sc.bx;
    const bz = sc.bz;
    for (let n = 0; n < count; n++) {
      const i = this.addActor(sc, coconut ? PROP_COCONUT : PROP_SEED, coconut ? 0.3 : 0.05 + this.rng.next() * 0.02, coconut ? COCONUT_COLORS : SEED_COLORS);
      const side = (n - (count - 1) / 2) * 1.6;
      sc.x0[i] = bx + sc.sz * side + (this.rng.next() - 0.5);
      sc.z0[i] = bz - sc.sx * side + (this.rng.next() - 0.5);
      sc.y0[i] = -0.8; // rises out of a trough
      sc.tx[i] = sc.lx + sc.sz * side * 1.5;
      sc.tz[i] = sc.lz - sc.sx * side * 1.5;
      sc.yaw[i] = this.rng.next() * TAU;
      sc.speed[i] = 0.9 + this.rng.next() * 0.2;
    }
  }

  private setupRaft(sc: Scene, s: SpeciesDef): void {
    this.seaStart(sc, 35, 100, 2.6, 0.5);
    const r = this.addActor(sc, PROP_RAFT, 2.6, RAFT_COLORS);
    sc.x0[r] = sc.bx;
    sc.z0[r] = sc.bz;
    sc.y0[r] = -0.5;
    sc.yaw[r] = Math.atan2(sc.sz, -sc.sx); // lies along the shore
    sc.tx[r] = sc.wx;
    sc.tz[r] = sc.wz;
    const a = s.animal;
    if (a && rides(a.model)) {
      const riders = 1 + this.rng.int(3);
      for (let n = 0; n < riders; n++) {
        const i = this.addActor(sc, a.model, displaySize(a) * (0.9 + this.rng.next() * 0.2), a.colors.map((c) => c & 0xffffff));
        sc.aux[i] = (n - (riders - 1) / 2) * 0.55; // place along the log (m)
        sc.speed[i] = a.speed;
        sc.yaw[i] = sc.yaw[r] + (this.rng.next() < 0.5 ? 0 : Math.PI);
        sc.x0[i] = sc.x0[r] + Math.sin(sc.yaw[r]) * sc.aux[i];
        sc.z0[i] = sc.z0[r] + Math.cos(sc.yaw[r]) * sc.aux[i];
        sc.y0[i] = sc.y0[r] + sc.scale[r] * LOG_TOP;
      }
    }
  }

  private setupBird(sc: Scene, s: SpeciesDef): void {
    // The bird itself, or (for a plant's seed, or a snail's eggs in mud on its feet) a carrier bird.
    const a = s.animal && fliesIn(s.animal.model) ? s.animal : null;
    const plan = a ? a.model : CARRIER_PLAN;
    const size = a ? displaySize(a) : CARRIER_SIZE;
    const i = this.addActor(sc, plan, size, a ? a.colors.map((c) => c & 0xffffff) : CARRIER_COLORS);
    sc.speed[i] = a ? Math.min(12, Math.max(6, a.speed)) : 10;
    // In from the horizon, upwind (the old islands are east): from somewhere out of view if there is
    // such a place along that way (else it fades in, a speck far out over the sea).
    sc.y0[i] = Math.max(0, this.fields.heightAt(sc.x, sc.z)) + 35;
    const jitter = (this.rng.next() - 0.5) * 40;
    let found = false;
    for (let n = 0; n < BIRD_STARTS.length && !found; n++) {
      const [d, off] = BIRD_STARTS[n];
      sc.x0[i] = sc.x - WIND_TO_X * d - WIND_TO_Z * (off + jitter);
      sc.z0[i] = sc.z - WIND_TO_Z * d + WIND_TO_X * (off + jitter);
      found = !this.inSight(sc, i);
    }
    if (!found) {
      sc.x0[i] = sc.x - WIND_TO_X * 260 - WIND_TO_Z * jitter;
      sc.z0[i] = sc.z - WIND_TO_Z * 260 + WIND_TO_X * jitter;
    }
    sc.yaw[i] = Math.atan2(sc.x - sc.x0[i], sc.z - sc.z0[i]);
    sc.v[i] = sc.speed[i];
    // Perch: the highest ground (or plant top) near the spot.
    let best = -Infinity;
    for (let t = 0; t < 30; t++) {
      const ang = this.rng.next() * TAU;
      const r = Math.sqrt(this.rng.next()) * 22;
      const px = sc.x + Math.cos(ang) * r;
      const pz = sc.z + Math.sin(ang) * r;
      const g = this.fields.heightAt(px, pz);
      if (g < 0.3) continue;
      const p = this.fields.patchIndex(px, pz);
      const can = p >= 0 ? this.fields.plants[p * PLANT_BYTES] - 1 : -1;
      const top = can >= 0 && this.fields.plants[p * PLANT_BYTES + 1] > 90 ? plantTop(this.species[can]?.plant?.model ?? 0, this.species[can]?.plant?.size ?? 1) : 0;
      if (g + top > best) {
        best = g + top;
        sc.tx[i] = px;
        sc.tz[i] = pz;
        sc.ty[i] = g + top;
      }
    }
    if (best === -Infinity) {
      // Nowhere to land: circle over the spot and go.
      sc.ok = false;
      sc.tx[i] = sc.x;
      sc.tz[i] = sc.z;
      sc.ty[i] = Math.max(0, this.fields.heightAt(sc.x, sc.z)) + 15;
    }
  }

  private setupFlyers(sc: Scene, s: SpeciesDef): void {
    const a = s.animal;
    if (!a) return;
    const count = 2 + this.rng.int(2);
    for (let n = 0; n < count; n++) {
      const i = this.addActor(sc, a.model, displaySize(a) * (0.9 + this.rng.next() * 0.2), a.colors.map((c) => c & 0xffffff));
      sc.speed[i] = Math.max(0.8, a.speed);
      sc.x0[i] = sc.x - WIND_TO_X * (38 + n * 3) + (this.rng.next() - 0.5) * 6;
      sc.z0[i] = sc.z - WIND_TO_Z * (38 + n * 3) + (this.rng.next() - 0.5) * 10;
      sc.y0[i] = Math.max(0, this.fields.heightAt(sc.x0[i], sc.z0[i])) + 1 + this.rng.next();
      sc.tx[i] = sc.x + (this.rng.next() - 0.5) * 6;
      sc.tz[i] = sc.z + (this.rng.next() - 0.5) * 6;
      sc.ty[i] = Math.max(0, this.fields.heightAt(sc.tx[i], sc.tz[i])) + 0.4;
      sc.yaw[i] = Math.atan2(sc.tx[i] - sc.x0[i], sc.tz[i] - sc.z0[i]);
      sc.tm2[i] = n * 1.5; // set off one after another
    }
  }

  private setupSwim(sc: Scene, s: SpeciesDef): void {
    const a = s.animal;
    if (!a) return;
    const big = a.model === AnimalModel.Whale || a.model === AnimalModel.Dolphin;
    const tortoise = a.model === AnimalModel.Tortoise;
    const swim = a.model === AnimalModel.SeaTurtle ? 0.5 : a.model === AnimalModel.Seal ? 1.6 : tortoise ? 0.25 : Math.max(0.5, a.speed);
    const fishes = a.model === AnimalModel.FishShoal ? MAX_ACTORS : 1;
    // Whales come up from well below; the rest from a little under the surface (a tortoise floats).
    const startDepth = a.model === AnimalModel.Whale ? 8 : big ? 3 : tortoise ? 0 : 1.2;
    this.seaStart(sc, Math.min(60, swim * 8) + (big ? 30 : 4), Math.min(110, swim * 25) + (big ? 60 : 6), displaySize(a), tortoise ? 0.4 : startDepth + a.size * 0.3);
    const bx = sc.bx;
    const bz = sc.bz;
    // Where to swim to: shallows near the shore (deeper water for whales and dolphins).
    const want = big ? Math.max(5, a.size * 0.4) : a.model === AnimalModel.Tortoise ? 0.2 : 0.9;
    let tx = sc.wx;
    let tz = sc.wz;
    for (let d = 0; d < 200; d += 1) {
      const x = sc.wx + sc.sx * d;
      const z = sc.wz + sc.sz * d;
      if (-this.fields.heightAt(x, z) >= want) {
        tx = x;
        tz = z;
        break;
      }
    }
    for (let n = 0; n < fishes; n++) {
      const i = this.addActor(sc, a.model, displaySize(a) * (0.9 + this.rng.next() * 0.2), a.colors.map((c) => c & 0xffffff));
      sc.speed[i] = swim;
      sc.x0[i] = bx + (this.rng.next() - 0.5) * (fishes > 1 ? 2 : 0);
      sc.z0[i] = bz + (this.rng.next() - 0.5) * (fishes > 1 ? 2 : 0);
      // As deep as asked, but clear of the bottom where the water is shallower.
      sc.y0[i] = tortoise ? -a.size * 0.12 : -Math.min(startDepth, Math.max(0.6, -this.fields.heightAt(bx, bz) - a.size * 0.3));
      sc.tx[i] = tx + (fishes > 1 ? (this.rng.next() - 0.5) * 2 : 0);
      sc.tz[i] = tz + (fishes > 1 ? (this.rng.next() - 0.5) * 2 : 0);
      sc.yaw[i] = Math.atan2(sc.tx[i] - sc.x0[i], sc.tz[i] - sc.z0[i]);
      sc.v[i] = swim * 0.8;
    }
  }

  private setupCrab(sc: Scene, s: SpeciesDef): void {
    const a = s.animal;
    if (!a || !sc.hasShore) {
      sc.on = false;
      return;
    }
    const i = this.addActor(sc, AnimalModel.Crab, displaySize(a), a.colors.map((c) => c & 0xffffff));
    sc.speed[i] = a.speed;
    sc.x0[i] = sc.wx + sc.sx * 1.2;
    sc.z0[i] = sc.wz + sc.sz * 1.2;
    sc.y0[i] = this.fields.heightAt(sc.x0[i], sc.z0[i]);
    sc.tx[i] = sc.lx - sc.sx * (1 + this.rng.next() * 2);
    sc.tz[i] = sc.lz - sc.sz * (1 + this.rng.next() * 2);
    sc.yaw[i] = Math.atan2(sc.sz, -sc.sx);
  }

  // ---------- playing a scene ----------

  private stepScene(sc: Scene, dt: number): void {
    const fadeRate = dt / (sc.kind === 'swim' || sc.kind === 'raft' || sc.kind === 'coconut' || sc.kind === 'seeds' ? FADE_IN_SEA : FADE_IN);
    for (let i = 0; i < sc.n; i++) if (sc.ent[i] > 0) sc.ent[i] = Math.max(0, sc.ent[i] - fadeRate);
    switch (sc.kind) {
      case 'motes':
        this.stepMotes(sc);
        break;
      case 'silk':
        this.stepSilk(sc, dt);
        break;
      case 'coconut':
      case 'seeds':
        this.stepFloaters(sc, dt);
        break;
      case 'raft':
        this.stepRaft(sc, dt);
        break;
      case 'bird':
        this.stepBird(sc, dt);
        break;
      case 'flyers':
        this.stepFlyers(sc, dt);
        break;
      case 'swim':
        this.stepSwim(sc, dt);
        break;
      case 'crab':
        this.stepCrab(sc, dt);
        break;
    }
    if (sc.glintT >= 0) {
      sc.glintT += dt;
      const g = Math.max(0, this.fields.heightAt(sc.glintX, sc.glintZ));
      sc.glintY = Math.max(g + 0.05, sc.glintY - Math.min(4, sc.glintT * 3) * dt);
      if (sc.glintT > 6) sc.glintT = -1;
    }
    // Long over: anything still lingering goes as soon as nobody sees it.
    if (sc.t > SCENE_LINGER) for (let i = 0; i < sc.n; i++) if (!sc.gone[i]) this.retire(sc, i);
    // Finished when every actor is gone and the motes have faded.
    let alive = sc.glintT >= 0 || (sc.kind === 'motes' && sc.t < 40);
    for (let i = 0; i < sc.n; i++) if (!sc.gone[i]) alive = true;
    if (!alive) sc.on = false;
  }

  /**
   * Remove an actor only when nobody can see it: out of view, too small, or faded right out
   * (`hide` 1 = buried, sunk or tucked away; on the way there it is drawn thinning out).
   */
  private retire(sc: Scene, i: number): void {
    if (this.visiblePx(sc, i, true) < 1) sc.gone[i] = 1;
  }

  /** How much leafy cover a spot has, 0..1 (a small animal can slip out of sight under it). */
  private coverAt(x: number, z: number): number {
    const p = this.fields.patchIndex(x, z);
    if (p < 0) return 0;
    const o = p * PLANT_BYTES;
    const pl = this.fields.plants;
    return Math.max(pl[o + 1], pl[o + 3], pl[o + 5] * 0.6) / 255;
  }

  private sea(x: number, z: number): number {
    const depth = Math.max(0, -this.fields.heightAt(x, z));
    return seaHeight(x, z, this.clock.t, this.clock.storm, depth);
  }

  /** Ride the swell: height plus tilt from the local wave slope. */
  private float(sc: Scene, i: number, sink: number, dt: number): void {
    const x = sc.x0[i];
    const z = sc.z0[i];
    const h = this.sea(x, z);
    const e = 0.6;
    sc.pitch[i] = Math.atan2(this.sea(x + Math.sin(sc.yaw[i]) * e, z + Math.cos(sc.yaw[i]) * e) - h, e) * 0.8;
    sc.roll[i] = Math.atan2(this.sea(x + Math.cos(sc.yaw[i]) * e, z - Math.sin(sc.yaw[i]) * e) - h, e) * 0.8;
    const bob = Math.sin(this.clock.t * 1.3 + sc.ph[i]) * 0.04;
    sc.y0[i] = sc.y0[i] + (h - sink + bob - sc.y0[i]) * Math.min(1, dt * 1.5);
  }

  /** Move toward (tx, tz) at a speed, turning to face the way (at most `turn` rad/s; 0 = drift without turning). Returns the distance left. */
  private glide(sc: Scene, i: number, tx: number, tz: number, speed: number, dt: number, turn = 1.5): number {
    const dx = tx - sc.x0[i];
    const dz = tz - sc.z0[i];
    const d = hyp(dx, dz);
    if (d < 1e-3) return 0;
    const want = Math.atan2(dx, dz);
    const err = wrap(want - sc.yaw[i]);
    sc.yaw[i] += Math.max(-turn * dt, Math.min(turn * dt, err));
    const step = Math.min(d, speed * dt);
    sc.x0[i] += (dx / d) * step;
    sc.z0[i] += (dz / d) * step;
    sc.v[i] = speed;
    return d - step;
  }

  private stepMotes(sc: Scene): void {
    const t = sc.t;
    for (let m = 0; m < sc.m; m++) {
      const u = Math.min(1, t / sc.mdur[m]);
      const e = u * u * (3 - 2 * u);
      const o = m * 3;
      const wob = (1 - e) * 1.6;
      sc.mx[m] = sc.ms[o] + (sc.mt[o] - sc.ms[o]) * e + Math.sin(t * 0.7 + sc.mphase[m]) * wob;
      sc.mz[m] = sc.ms[o + 2] + (sc.mt[o + 2] - sc.ms[o + 2]) * e + Math.cos(t * 0.6 + sc.mphase[m] * 2) * wob;
      // A gentle arc down onto the ground.
      sc.my[m] = sc.ms[o + 1] + (sc.mt[o + 1] - sc.ms[o + 1]) * (sc.ok ? e * e : e) + Math.sin(t * 0.9 + sc.mphase[m]) * wob * 0.4;
      const fadeIn = Math.min(1, t / 2.5);
      const fadeOut = sc.ok ? 1 - Math.min(1, Math.max(0, t - sc.mdur[m]) / 5) : 1 - Math.max(0, (u - 0.6) / 0.4);
      sc.malpha[m] = fadeIn * fadeOut;
    }
  }

  private stepSilk(sc: Scene, dt: number): void {
    const i = 0;
    const settle = sc.ok ? 1 : 0;
    if (sc.st === 0) {
      // Drift in on the breeze, sinking gently, glinting.
      sc.fold[i] = Math.min(1, sc.fold[i] + dt * 0.5);
      const d = this.glide(sc, i, sc.tx[i], sc.tz[i], 1.8, dt, 10);
      sc.yaw[i] = 0;
      const total = hyp(sc.tx[i] - sc.x0[i], sc.tz[i] - sc.z0[i]) + 1e-3;
      sc.y0[i] += (sc.ty[i] - sc.y0[i]) * Math.min(1, (1.8 * dt) / total);
      sc.y0[i] += Math.sin(this.clock.t * 1.1) * 0.15 * dt;
      sc.roll[i] = 0.65 + Math.sin(this.clock.t * 0.8) * 0.08;
      if (d < 0.2) {
        sc.st = settle ? 1 : 2;
        sc.tm = 0;
      }
    } else if (sc.st === 1) {
      // Landed: the thread is drawn in and the glint fades; the spider stays.
      sc.tm += dt;
      sc.aux[i] = Math.max(0, sc.aux[i] * (1 - dt * 0.6));
      sc.fold[i] = Math.max(0, 1 - sc.tm / 5);
      sc.roll[i] *= 1 - dt;
    } else {
      // Couldn't stay: lifted off again and carried on downwind.
      sc.tm += dt;
      sc.x0[i] += WIND_TO_X * 1.8 * dt;
      sc.z0[i] += WIND_TO_Z * 1.8 * dt;
      sc.y0[i] += 0.4 * dt;
      sc.fold[i] = Math.max(0, 1 - sc.tm / 14);
    }
    if (sc.st > 0) this.retire(sc, i);
  }

  private stepFloaters(sc: Scene, dt: number): void {
    for (let i = 0; i < sc.n; i++) {
      if (sc.gone[i]) continue;
      const size = sc.scale[i];
      sc.tm2[i] += dt;
      switch (sc.st2[i]) {
        case 0: {
          // Bob shoreward on the swell (about 20 s).
          const tx = sc.ok ? sc.wx + (sc.tx[i] - sc.lx) : sc.wx + sc.sx * 4 + (sc.tx[i] - sc.lx);
          const tz = sc.ok ? sc.wz + (sc.tz[i] - sc.lz) : sc.wz + sc.sz * 4 + (sc.tz[i] - sc.lz);
          const far = hyp(tx - sc.x0[i], tz - sc.z0[i]);
          const speed = Math.max(0.6, far / Math.max(1, 20 - sc.tm2[i])) * sc.speed[i];
          const d = this.glide(sc, i, tx, tz, Math.min(speed, 2.5), dt, 0);
          sc.yaw[i] += dt * 0.2;
          this.float(sc, i, size * 0.12, dt);
          if (d < 0.3 || !sc.hasShore) {
            sc.st2[i] = sc.ok && sc.hasShore ? 1 : 3;
            sc.tm2[i] = 0;
          }
          break;
        }
        case 1: {
          // A last wave nudges it up the beach; it rolls to rest above the swash.
          const d = this.glide(sc, i, sc.tx[i], sc.tz[i], 1.2, dt, 3);
          const g = this.fields.heightAt(sc.x0[i], sc.z0[i]);
          const s = this.sea(sc.x0[i], sc.z0[i]);
          sc.y0[i] = Math.max(g + size * 0.4, s - size * 0.3);
          sc.roll[i] += dt * 3;
          if (d < 0.05) {
            sc.st2[i] = 2;
            sc.tm2[i] = 0;
          }
          break;
        }
        case 2: {
          // Rest, then settle into the sand as it takes root.
          const g = this.fields.heightAt(sc.x0[i], sc.z0[i]);
          const sink = Math.min(1, Math.max(0, sc.tm2[i] - 6) / 10);
          sc.y0[i] = g + size * 0.4 - sink * size * 1.1;
          sc.hide[i] = smooth01(0.6, 1, sink); // the last of it goes under the sand
          this.retire(sc, i);
          break;
        }
        case 3: {
          // Washed back out to sea and away; sinks from view far out.
          this.glide(sc, i, sc.wx + sc.sx * 200, sc.wz + sc.sz * 200, 0.9, dt, 0);
          this.float(sc, i, size * 0.12 + Math.max(0, sc.tm2[i] - 25) * 0.05, dt);
          sc.hide[i] = smooth01(30, 40, sc.tm2[i]); // waterlogged, it slips under
          this.retire(sc, i);
          break;
        }
      }
    }
  }

  private stepRaft(sc: Scene, dt: number): void {
    const r = 0;
    const log = sc.scale[r];
    sc.tm += dt;
    if (sc.st === 0) {
      // Drifting in, slow and heavy.
      const tx = sc.ok ? sc.wx : sc.wx + sc.sx * 6 - sc.sz * 30;
      const tz = sc.ok ? sc.wz : sc.wz + sc.sz * 6 + sc.sx * 30;
      const far = hyp(tx - sc.x0[r], tz - sc.z0[r]);
      const d = this.glide(sc, r, tx, tz, Math.min(2.5, Math.max(0.5, far / Math.max(1, 26 - sc.t))), dt, 0);
      this.float(sc, r, 0.04, dt);
      if (d < 0.4 || !sc.hasShore) {
        sc.st = sc.ok && sc.hasShore ? 1 : 3;
        sc.tm = 0;
      }
    } else if (sc.st === 1) {
      // Grounded in the swash; rocks a little; the riders hop off one by one.
      const g = this.fields.heightAt(sc.x0[r], sc.z0[r]);
      const s = this.sea(sc.x0[r], sc.z0[r]);
      sc.y0[r] = Math.max(g + log * 0.05, s - log * 0.02);
      sc.roll[r] = Math.sin(this.clock.t * 1.2) * 0.05;
      sc.pitch[r] *= 1 - dt;
      if (sc.tm > 60) sc.st = 2;
    } else if (sc.st === 2) {
      // Long after: the beach slowly buries the driftwood, branch and all (a third of its length).
      sc.y0[r] -= dt * 0.025;
      const buried = (this.fields.heightAt(sc.x0[r], sc.z0[r]) - sc.y0[r]) / (log * 0.35);
      sc.hide[r] = smooth01(0.7, 1, buried);
      this.retire(sc, r);
    } else {
      // Couldn't land: carried along the shore and back out.
      this.glide(sc, r, sc.wx + sc.sx * 200 - sc.sz * 60, sc.wz + sc.sz * 200 + sc.sx * 60, 0.8, dt, 0);
      const sink = 0.04 + Math.max(0, sc.tm - 40) * 0.02;
      this.float(sc, r, sink, dt);
      sc.hide[r] = smooth01(log * 0.25, log * 0.4, sink); // waterlogged and gone under, branch and all
      this.retire(sc, r);
    }
    // Riders.
    const sy = Math.sin(sc.yaw[r]);
    const cy = Math.cos(sc.yaw[r]);
    for (let i = 1; i < sc.n; i++) {
      if (sc.gone[i]) continue;
      if (sc.st2[i] === 0) {
        // Clinging to the log: seen (or not) with it.
        sc.x0[i] = sc.x0[r] + sy * sc.aux[i];
        sc.z0[i] = sc.z0[r] + cy * sc.aux[i];
        sc.y0[i] = sc.y0[r] + log * LOG_TOP;
        sc.pitch[i] = sc.pitch[r];
        sc.roll[i] = sc.roll[r];
        sc.amp[i] = 0;
        sc.hide[i] = sc.hide[r];
        sc.ent[i] = sc.ent[r];
        if (sc.gone[r]) sc.gone[i] = 1;
        if (sc.st === 1 && sc.tm > 2 + i * 0.9) {
          sc.st2[i] = 1;
          sc.tm2[i] = 0;
          // Scamper inland, to cover if there is any.
          const ang = Math.atan2(-sc.sx, -sc.sz) + (this.rng.next() - 0.5) * 1.2;
          const run = 8 + this.rng.next() * 8;
          sc.tx[i] = sc.x0[r] + Math.sin(ang) * run;
          sc.tz[i] = sc.z0[r] + Math.cos(ang) * run;
        }
      } else {
        // Dash, pause, dash (lizards) or trundle (snails); then slip into cover.
        sc.tm2[i] += dt;
        const pause = sc.tm2[i] % 2.4 > 1.6;
        const d = pause ? hyp(sc.tx[i] - sc.x0[i], sc.tz[i] - sc.z0[i]) : this.glide(sc, i, sc.tx[i], sc.tz[i], sc.speed[i], dt, 8);
        sc.y0[i] = this.fields.heightAt(sc.x0[i], sc.z0[i]);
        sc.pitch[i] = 0;
        sc.roll[i] = 0;
        sc.amp[i] = pause ? 0 : 1;
        sc.ph[i] = (sc.ph[i] + (pause ? 0 : 9) * TAU * dt) % (TAU * 2);
        if (d < 0.1) {
          sc.amp[i] = 0;
          if (this.coverAt(sc.x0[i], sc.z0[i]) > 0.4) sc.hide[i] = Math.min(1, sc.hide[i] + dt); // under the leaves
        }
        this.retire(sc, i);
      }
    }
  }

  private stepBird(sc: Scene, dt: number): void {
    const i = 0;
    const sp = sc.speed[i];
    sc.tm += dt;
    const arriving = this.species[sc.sp]?.animal;
    const plant = !arriving;
    // A bird that came to stay lingers; a carrier only drops off what it brought.
    const stays = sc.ok && !!arriving && fliesIn(arriving.model);
    switch (sc.st) {
      case 0: {
        // The long straight line in from the horizon, flapping in bouts.
        const d = this.fly(sc, i, sc.tx[i], sc.ty[i] + Math.min(12, hyp(sc.tx[i] - sc.x0[i], sc.tz[i] - sc.z0[i]) * 0.15), sc.tz[i], sp, dt);
        sc.amp[i] = (this.clock.t * 0.3 + sc.ph[i]) % 1 < 0.5 ? 0.9 : 0.08;
        sc.fold[i] = 0;
        if (!sc.ok && d < 18) {
          sc.st = 4; // circle once, can't stay
          sc.tm = 0;
        } else if (d < 6) {
          sc.st = 1;
          sc.tm = 0;
        }
        break;
      }
      case 1: {
        // Flare and land.
        const dx = sc.tx[i] - sc.x0[i];
        const dy = sc.ty[i] - sc.y0[i];
        const dz = sc.tz[i] - sc.z0[i];
        const d = hyp3(dx, dy, dz);
        const v = Math.max(1, Math.min(sp, d * 1.2));
        const step = Math.min(d, v * dt);
        if (d > 1e-3) {
          sc.x0[i] += (dx / d) * step;
          sc.y0[i] += (dy / d) * step;
          sc.z0[i] += (dz / d) * step;
          sc.yaw[i] = Math.atan2(dx, dz);
        }
        sc.pitch[i] += (0.5 - sc.pitch[i]) * Math.min(1, dt * 3);
        sc.roll[i] *= 1 - Math.min(1, dt * 4);
        sc.amp[i] = 0.95;
        if (d < 0.1 || sc.tm > 6) {
          sc.st = 2;
          sc.tm = 0;
          sc.pitch[i] = 0;
          sc.roll[i] = 0;
        }
        break;
      }
      case 2: {
        // Perched: fold the wings, preen, look about.
        sc.amp[i] = 0;
        sc.fold[i] = Math.min(1, sc.fold[i] + dt * 3);
        sc.aux[i] = sc.tm % 3 < 1.6 ? -0.7 : sc.tm % 3 < 2 ? 0.3 : 0;
        if (plant && sc.ok && sc.glintT < 0 && sc.tm > 2 && sc.tm < 2.5) {
          sc.glintT = 0;
          sc.glintX = sc.x0[i];
          sc.glintY = sc.y0[i] + 0.1;
          sc.glintZ = sc.z0[i];
        }
        if (sc.tm > (stays ? 14 : 7)) {
          sc.st = 3;
          sc.tm = 0;
          sc.fold[i] = 0.5;
          sc.v[i] = 3;
          // Away downwind and up.
          sc.tx[i] = sc.x0[i] + WIND_TO_X * 400 + (this.rng.next() - 0.5) * 200;
          sc.tz[i] = sc.z0[i] + WIND_TO_Z * 400 + (this.rng.next() - 0.5) * 200;
          sc.ty[i] = sc.y0[i] + 40;
        }
        break;
      }
      case 3: {
        this.fly(sc, i, sc.tx[i], sc.ty[i], sc.tz[i], sp, dt);
        sc.fold[i] = Math.max(0, sc.fold[i] - dt * 3);
        sc.amp[i] = 0.9;
        this.retire(sc, i);
        break;
      }
      case 4: {
        // One wide circle over the spot, then away.
        const ang = Math.atan2(sc.z0[i] - sc.z, sc.x0[i] - sc.x) + 0.5;
        this.fly(sc, i, sc.x + Math.cos(ang) * 15, sc.ty[i] + 12, sc.z + Math.sin(ang) * 15, sp * 0.8, dt);
        sc.amp[i] = (this.clock.t * 0.4) % 1 < 0.4 ? 0.9 : 0.08;
        if (sc.tm > 9) {
          sc.st = 3;
          sc.tx[i] = sc.x0[i] + WIND_TO_X * 400;
          sc.tz[i] = sc.z0[i] + WIND_TO_Z * 400;
          sc.ty[i] = sc.y0[i] + 30;
        }
        break;
      }
    }
    sc.ph[i] = (sc.ph[i] + (sc.st === 1 ? 8 : 3.5) * TAU * dt) % (TAU * 2);
  }

  /** Turn-limited flight toward a point; returns the horizontal distance left. */
  private fly(sc: Scene, i: number, tx: number, ty: number, tz: number, speed: number, dt: number): number {
    const dx = tx - sc.x0[i];
    const dz = tz - sc.z0[i];
    const dh = hyp(dx, dz);
    const want = Math.atan2(dx, dz);
    const rate = Math.min(3, Math.max(0.6, (1.6 * speed) / Math.max(dh, 1)));
    const err = wrap(want - sc.yaw[i]);
    const turn = Math.max(-rate * dt, Math.min(rate * dt, err));
    sc.yaw[i] += turn;
    sc.v[i] += (speed - sc.v[i]) * Math.min(1, dt);
    sc.vy[i] += (Math.max(-speed * 0.5, Math.min(speed * 0.4, (ty - sc.y0[i]) * 0.6)) - sc.vy[i]) * Math.min(1, dt * 2);
    sc.x0[i] += Math.sin(sc.yaw[i]) * sc.v[i] * dt;
    sc.z0[i] += Math.cos(sc.yaw[i]) * sc.v[i] * dt;
    sc.y0[i] += sc.vy[i] * dt;
    const floor = Math.max(this.fields.heightAt(sc.x0[i], sc.z0[i]), 0) + 1;
    if (sc.y0[i] < floor) sc.y0[i] = floor;
    sc.roll[i] += (-Math.atan((sc.v[i] * turn) / Math.max(dt, 1e-3) / 9.8) - sc.roll[i]) * Math.min(1, dt * 3);
    sc.pitch[i] += (Math.atan2(sc.vy[i], Math.max(sc.v[i], 0.5)) - sc.pitch[i]) * Math.min(1, dt * 3);
    return dh;
  }

  private stepFlyers(sc: Scene, dt: number): void {
    for (let i = 0; i < sc.n; i++) {
      if (sc.gone[i]) continue;
      sc.tm2[i] -= dt;
      if (sc.tm2[i] > 0) {
        sc.hide[i] = 1; // not set off yet (far out over the sea, unseen)
        continue;
      }
      if (sc.hide[i] > 0) {
        // Setting off now: in sight already, it fades in as it comes in low over the water.
        sc.hide[i] = 0;
        if (this.inSight(sc, i)) sc.ent[i] = 1;
      }
      const insectHz = sc.plan[i] === AnimalModel.Butterfly ? 8 : 25;
      sc.ph[i] = (sc.ph[i] + insectHz * TAU * dt) % (TAU * 2);
      if (sc.st2[i] === 0) {
        sc.yaw[i] += Math.sin(this.clock.t * 3 + i * 2) * 1.5 * dt;
        const tx = sc.ok ? sc.tx[i] : sc.x + WIND_TO_X * 60;
        const tz = sc.ok ? sc.tz[i] : sc.z + WIND_TO_Z * 60 + (i - 1) * 4;
        const d = this.fly(sc, i, tx, sc.ty[i] + 0.6 + Math.sin(this.clock.t * 2 + i) * 0.3, tz, sc.speed[i], dt);
        sc.y0[i] = Math.max(sc.y0[i], this.sea(sc.x0[i], sc.z0[i]) + 0.5);
        sc.amp[i] = sc.plan[i] === AnimalModel.Butterfly ? 1.1 : 0.4;
        if (d < 0.4) {
          sc.st2[i] = sc.ok ? 1 : 2;
          sc.tm2[i] = 0;
          sc.y0[i] = sc.ty[i];
          sc.pitch[i] = sc.roll[i] = 0;
        }
      } else if (sc.st2[i] === 1) {
        // Settled for a moment (the timer runs on below zero), then off inland.
        sc.amp[i] = 0;
        sc.fold[i] = sc.plan[i] === AnimalModel.Butterfly ? 0.4 + 0.6 * Math.max(0, Math.sin(this.clock.t * 1.4 + i)) : 0;
        if (sc.tm2[i] < -6) {
          sc.st2[i] = 2;
          sc.fold[i] = 0;
          sc.tx[i] = sc.x0[i] + WIND_TO_X * 80 + (this.rng.next() - 0.5) * 40;
          sc.tz[i] = sc.z0[i] + WIND_TO_Z * 80 + (this.rng.next() - 0.5) * 40;
        }
      } else {
        this.fly(sc, i, sc.tx[i], this.fields.heightAt(sc.x0[i], sc.z0[i]) + 3, sc.tz[i], sc.speed[i], dt);
        sc.amp[i] = sc.plan[i] === AnimalModel.Butterfly ? 1.1 : 0.4;
        this.retire(sc, i);
      }
    }
  }

  private stepSwim(sc: Scene, dt: number): void {
    for (let i = 0; i < sc.n; i++) {
      if (sc.gone[i]) continue;
      const plan = sc.plan[i];
      const size = sc.scale[i];
      const tortoise = plan === AnimalModel.Tortoise;
      sc.tm2[i] += dt;
      const s = this.sea(sc.x0[i], sc.z0[i]);
      const g = this.fields.heightAt(sc.x0[i], sc.z0[i]);
      const stroke = plan === AnimalModel.SeaTurtle || tortoise ? 0.5 : plan === AnimalModel.Whale ? 0.25 : plan === AnimalModel.Ray ? 0.4 : 1.2;
      sc.ph[i] = (sc.ph[i] + stroke * TAU * dt) % (TAU * 2);
      sc.amp[i] = 0.8;
      if (sc.st2[i] === 0) {
        // Swim in toward the shallows, rising from deeper water.
        const d = this.glide(sc, i, sc.tx[i], sc.tz[i], sc.speed[i], dt, 0.6);
        const top = tortoise ? s - size * 0.12 : s - Math.max(0.35, size * 0.12);
        sc.y0[i] += (Math.max(g + size * 0.1, top) - sc.y0[i]) * Math.min(1, dt * 0.4);
        if (d < 0.5) {
          sc.st2[i] = tortoise && sc.ok && sc.hasShore ? 3 : 1;
          sc.tm2[i] = 0;
          if (plan === AnimalModel.Whale) this.blow(sc.x0[i], s, sc.z0[i]);
        }
      } else if (sc.st2[i] === 1) {
        // Linger: a turtle lifts its head to breathe, a dolphin rolls, a whale blows again.
        sc.y0[i] += (s - size * 0.08 - sc.y0[i]) * Math.min(1, dt * 0.8);
        sc.pitch[i] = Math.sin(sc.tm2[i] * 0.8) * 0.1;
        if (plan === AnimalModel.Whale && sc.tm2[i] > 6 && sc.tm2[i] - dt <= 6) this.blow(sc.x0[i], s, sc.z0[i]);
        if (sc.tm2[i] > 10) {
          sc.st2[i] = 2;
          sc.tm2[i] = 0;
          // ok: along the shore and on; not ok: back out the way it came.
          const along = sc.ok ? 1 : 0;
          sc.tx[i] = sc.x0[i] + sc.sx * (along ? 150 : 500) + sc.sz * along * 150;
          sc.tz[i] = sc.z0[i] + sc.sz * (along ? 150 : 500) - sc.sx * along * 150;
        }
      } else if (sc.st2[i] === 2) {
        // Leave, sinking out of sight.
        this.glide(sc, i, sc.tx[i], sc.tz[i], sc.speed[i], dt, 0.5);
        const deep = Math.max(g + size * 0.1, s - 3);
        sc.y0[i] += (deep - sc.y0[i]) * Math.min(1, dt * 0.2);
        sc.pitch[i] = -0.1;
        // It fades into the deep as it goes down (as the fauna's diving whales do), starting from
        // the depth it was lingering at (a big whale already floats more than a metre down, so
        // measuring from a fixed depth would make it dim in one jump).
        // The sea surface moves with the waves, so the fade only ever rises, and never faster
        // than the creature shader's fades are allowed to go.
        const lingering = size * 0.08;
        const want = Math.min(1, Math.max(0, (s - sc.y0[i] - lingering) / Math.max(0.5, 3 - lingering)));
        sc.hide[i] = Math.max(sc.hide[i], Math.min(want, sc.hide[i] + dt * 1.5));
        this.retire(sc, i);
      } else {
        // A tortoise wades out and plods inland.
        const d = this.glide(sc, i, sc.lx - sc.sx * 6, sc.lz - sc.sz * 6, 0.08, dt, 0.5);
        sc.y0[i] = Math.max(this.fields.heightAt(sc.x0[i], sc.z0[i]), s - size * 0.12);
        sc.amp[i] = d < 0.05 ? 0 : 0.8;
        sc.ph[i] = (sc.ph[i] + (d < 0.05 ? 0 : 0.4) * TAU * dt) % (TAU * 2);
        this.retire(sc, i);
      }
    }
  }

  private stepCrab(sc: Scene, dt: number): void {
    const i = 0;
    sc.tm += dt;
    const moving = sc.st === 0 || sc.st === 2 || sc.st === 3;
    // Ghost crabs move in short sideways sprints with frozen pauses between.
    const sprint = moving && sc.tm % 1.3 < 0.4;
    sc.ph[i] = (sc.ph[i] + (sprint ? 14 : 0) * TAU * dt) % (TAU * 2);
    sc.amp[i] = sprint ? 1 : 0;
    const d = sprint ? this.crabDash(sc, i, sc.tx[i], sc.tz[i], dt) : hyp(sc.tx[i] - sc.x0[i], sc.tz[i] - sc.z0[i]);
    if (sc.st === 0 && d < 0.05) {
      // Out of the surf: freeze and look about, with a wave of the claws.
      sc.st = 1;
      sc.tm = 0;
    } else if (sc.st === 1) {
      sc.fold[i] = sc.tm > 1 && sc.tm < 2 ? 1 : 0;
      if (sc.tm > 3) {
        sc.st = sc.ok ? 3 : 2;
        sc.tm = 0;
        if (sc.ok) {
          // A few more sprints up the beach to a spot for a burrow.
          sc.tx[i] = sc.x0[i] - sc.sx * (1.5 + this.rng.next() * 1.5) + sc.sz * (this.rng.next() - 0.5) * 2;
          sc.tz[i] = sc.z0[i] - sc.sz * (1.5 + this.rng.next() * 1.5) - sc.sx * (this.rng.next() - 0.5) * 2;
        } else {
          sc.tx[i] = sc.wx + sc.sx * 2;
          sc.tz[i] = sc.wz + sc.sz * 2;
        }
      }
    } else if (sc.st === 2) {
      // Couldn't stay: back into the sea, fading as the surf takes it.
      if (this.sea(sc.x0[i], sc.z0[i]) - this.fields.heightAt(sc.x0[i], sc.z0[i]) > sc.scale[i] * 0.5) sc.hide[i] = Math.min(1, sc.hide[i] + dt);
      this.retire(sc, i);
    } else if (sc.st === 3 && d < 0.05) {
      sc.st = 4;
      sc.tm = 0;
    } else if (sc.st === 4 && sc.tm > 2) {
      sc.st = 5;
      sc.tm = 0;
    } else if (sc.st === 5) {
      // Dig in and disappear into the new burrow.
      sc.y0[i] -= dt * sc.scale[i];
      sc.hide[i] = Math.min(1, sc.tm / 0.8);
      this.retire(sc, i);
      return;
    }
    sc.y0[i] = this.fields.heightAt(sc.x0[i], sc.z0[i]);
  }

  private crabDash(sc: Scene, i: number, tx: number, tz: number, dt: number): number {
    const dx = tx - sc.x0[i];
    const dz = tz - sc.z0[i];
    const d = hyp(dx, dz);
    if (d < 1e-3) return 0;
    const step = Math.min(d, sc.speed[i] * dt);
    sc.x0[i] += (dx / d) * step;
    sc.z0[i] += (dz / d) * step;
    sc.yaw[i] = Math.atan2(dx, dz) - Math.PI / 2;
    return d - step;
  }

  private blow(x: number, y: number, z: number): void {
    for (let n = 0; n < 24; n++) {
      const o = this.puffHead * 8;
      this.puffHead = (this.puffHead + 1) % 64;
      const a = this.rng.next() * TAU;
      const r = this.rng.next() * 0.4;
      this.puffs[o] = x;
      this.puffs[o + 1] = y + 0.3;
      this.puffs[o + 2] = z;
      this.puffs[o + 3] = Math.cos(a) * r + WIND_TO_X * 0.8;
      this.puffs[o + 4] = 3 + this.rng.next() * 2.5;
      this.puffs[o + 5] = Math.sin(a) * r + WIND_TO_Z * 0.8;
      this.puffs[o + 6] = 0;
      this.puffs[o + 7] = 2.2 + this.rng.next() * 1.2;
    }
  }
}

function smooth01(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function wrap(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

// ---------- drawing ----------

const MARKER_RGB: [number, number, number][] = [
  [1.0, 0.92, 0.62], // wind: pale gold
  [0.75, 0.97, 1.0], // wave: sea-glass
  [1.0, 0.86, 0.74], // wing: warm white
];

export function createVignettes(deps: SystemDeps): PageSystem {
  const { scene, fields, u, renderer } = deps;
  const sim = new VignetteSim(deps.species, fields, 9061);
  const mats = creatureMaterials(u);
  const group = new THREE.Group();
  group.name = 'vignettes';
  scene.add(group);
  const animalGeoms = buildAnimalGeometries();
  const visuals: (THREE.BufferGeometry | null)[] = [...animalGeoms, coconutShape().build(), seedShape().build(), raftShape().build()];
  // Batches are made on first use (most body plans never appear in a scene).
  const batches: (CreatureBatch | null)[] = new Array(VISUAL_COUNT).fill(null);
  const batch = (plan: number): CreatureBatch | null => {
    if (batches[plan]) return batches[plan];
    const g = visuals[plan];
    if (!g) return null;
    const b = new CreatureBatch(g, MAX_SCENES * MAX_ACTORS, mats);
    group.add(b.mesh);
    batches[plan] = b;
    return b;
  };
  // The raft and coconut are always ready (the commonest props), so their first use never builds anything.
  batch(PROP_RAFT);
  batch(PROP_COCONUT);
  batch(PROP_SEED);
  const points = new SoftPoints(MAX_SCENES * MAX_MOTES + MAX_MARKERS * MARKER_MOTES + 64 + 8, u);
  group.add(points.points);
  const view: FaunaView = { tx: 0, tz: 0, cx: 0, cy: 0, cz: 0, dist: 1, pxPerRad: 800, frustum: new THREE.Frustum() };
  const clock: VignetteClock = { t: 0, dt: 0, storm: 0 };
  const mat4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const buf = new THREE.Vector2();
  let haveView = false;
  // For the browser checks and screenshots: play an arrival at a chosen spot.
  group.userData.arrive = (ev: ArrivalEvent) => sim.arrive(ev, haveView ? view : null);
  group.userData.sim = sim;

  const draw = (f: FrameCtx) => {
    for (const b of batches) b?.begin();
    points.begin();
    for (const sc of sim.scenes) {
      if (!sc.on || sc.waiting) continue;
      for (let i = 0; i < sc.n; i++) {
        const presence = sc.presence(i);
        if (sc.gone[i] || presence < 0.001) continue;
        const b = batch(sc.plan[i]);
        if (!b) continue;
        setOrientation(q, e, sc.yaw[i], sc.pitch[i], sc.roll[i]);
        b.add(sc.x0[i], sc.y0[i], sc.z0[i], sc.scale[i], q, sc.ph[i], sc.amp[i], sc.fold[i], sc.aux[i], sc.colors, i * 3, presence);
      }
      for (let m = 0; m < sc.m; m++) {
        const a = sc.malpha[m] * (0.6 + 0.4 * Math.sin(f.t * 7 + sc.mphase[m] * 5));
        if (a < 0.02) continue;
        points.add(sc.mx[m], sc.my[m], sc.mz[m], 0.09, sc.mrgb[0] * 1.3, sc.mrgb[1] * 1.3, sc.mrgb[2] * 1.3, a, m % 3 === 0 ? PointKind.Sparkle : PointKind.Glow);
      }
      if (sc.glintT >= 0) {
        const a = Math.min(1, sc.glintT * 3) * (1 - Math.max(0, sc.glintT - 4) / 2);
        points.add(sc.glintX, sc.glintY, sc.glintZ, 0.25, 1.4, 1.3, 1.0, a, PointKind.Sparkle);
      }
    }
    // The glide-there markers: soft motes rising from the spot, big enough to find from far out.
    const size = Math.max(0.35, f.cam.dist * 0.008);
    for (const mk of sim.markers) {
      if (!mk.on) continue;
      const life = Math.min(1, mk.t / 1.5) * Math.min(1, (MARKER_SECONDS - mk.t) / 5);
      const rgb = MARKER_RGB[mk.family];
      for (let s = 0; s < MARKER_MOTES; s++) {
        const k = s / MARKER_MOTES;
        const rise = (mk.t * 0.35 + k * 8) % 8;
        const a = life * Math.sin((rise / 8) * Math.PI) * 0.85;
        const ang = k * TAU * 3 + mk.t * 0.3;
        const r = 0.6 + 0.9 * k;
        points.add(mk.x + Math.cos(ang) * r, mk.y + 0.3 + rise, mk.z + Math.sin(ang) * r, size, rgb[0], rgb[1], rgb[2], a, PointKind.Glow);
      }
    }
    for (let p = 0; p < 64; p++) {
      const o = p * 8;
      const P = sim.puffs;
      if (P[o + 6] >= P[o + 7]) continue;
      const k = P[o + 6] / P[o + 7];
      points.add(P[o], P[o + 1], P[o + 2], 0.5 + k * 1.5, 0.93, 0.95, 0.97, 0.55 * (1 - k) * Math.min(1, k * 8), PointKind.Mist);
    }
    for (let plan = 0; plan < VISUAL_COUNT; plan++) batches[plan]?.end(false, plan === AnimalModel.Spider ? 400 : 1.6);
    renderer.getDrawingBufferSize(buf);
    points.end(buf.y);
  };

  return {
    name: 'vignettes',
    onEngine(m: FromEngine) {
      if (m.t === 'tick') {
        for (const ev of m.events.arrivals) sim.arrive(ev, haveView ? view : null);
      } else if (m.t === 'clear') {
        for (const sc of sim.scenes) sc.on = false;
        for (const mk of sim.markers) mk.on = false;
      }
    },
    update(f: FrameCtx) {
      renderer.getDrawingBufferSize(buf);
      viewFromCamera(f.camera, f.cam.target, f.cam.dist, buf.y, view, mat4);
      haveView = true;
      clock.t = f.t;
      clock.dt = f.dt;
      clock.storm = f.storm.level;
      sim.step(clock, view);
      draw(f);
    },
    dispose() {
      for (const b of batches) b?.dispose();
      points.dispose();
      scene.remove(group);
    },
  };
}
