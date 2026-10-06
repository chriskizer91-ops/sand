/**
 * The maker's hands: two cupped hands built in code that hover above the brush and pour.
 *
 * - Shape: each hand is a squashed ellipsoid palm plus four fingers and a thumb made of
 *   tapered five-sided tubes (about 230 triangles a hand, both hands in one mesh).
 * - Look: pale sand-gold and see-through, with a soft bright rim, warmed orange from below
 *   while they hold or pour lava. A depth-only pass first means only the nearest surface
 *   shows, so the fingers don't muddle through the palm.
 * - Size follows the zoom: giant maker's hands from high above, sensible close up.
 * - Place: above the brush, lifted up the screen and a little toward the camera, so they
 *   never cover the brush ring; the material falls from the gap between the palms.
 * - Poses (blended smoothly): holding (cupped, palms up), pouring (tilted, the gap between
 *   the hands opens and the fingers part), rock (fingers open to let boulders drop),
 *   smoothing (palms down, circling), scooping (deep cup, dipping).
 * - Hidden for Look and in watch mode; they fade rather than pop.
 *
 * This file also holds the small pieces the ocean and effects share with the hands: the
 * engine's live stroke (PourTracker) and where the hands are this frame (readHands).
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SEA_LEVEL, type ToolId } from '../config';
import type { FromEngine } from '../engine/protocol';
import { WORLD_UNIFORMS_GLSL, type FrameCtx, type PageSystem, type SystemDeps } from './shared';

// ---------- the live stroke and the hands' place (shared with ocean.ts and effects.ts) ----------

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * The live stroke as the engine reports it (tick.events.pour). Ticks arrive 10-30 times a
 * second; a stroke counts as live until a few ticks go by without one.
 */
export class PourTracker {
  tool: ToolId = 'lava';
  x = 0;
  y = 0;
  z = 0;
  r = 0;
  /** Seconds since the engine last reported the stroke. */
  age = Infinity;

  onEngine(m: FromEngine): void {
    if (m.t !== 'tick' || !m.events.pour) return;
    const p = m.events.pour;
    this.tool = p.tool;
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    this.r = p.r;
    this.age = 0;
  }

  advance(dt: number): void {
    this.age += dt;
  }

  get active(): boolean {
    return this.age < 0.35;
  }
}

/** Hand length (wrist to fingertip, m) per metre of camera distance. */
export const HAND_PER_DIST = 0.11;

/** What the hands are doing this frame. */
export interface HandsState {
  /** There is somewhere to hover (a brush or a live stroke), the tool shapes, and the UI is awake. */
  shown: boolean;
  /** A stroke is happening: pour pose, streams, boulders. */
  pouring: boolean;
  tool: ToolId;
  /** Brush centre on the ground, and its radius (m). */
  x: number;
  y: number;
  z: number;
  r: number;
  /** Where material leaves the hands (the gap between the palms). */
  ax: number;
  ay: number;
  az: number;
  /** Hand length (m). */
  scale: number;
  /** Horizontal unit vector pointing away from the camera (the hands' "forward"). */
  fx: number;
  fz: number;
}

export function createHandsState(): HandsState {
  return { shown: false, pouring: false, tool: 'lava', x: 0, y: 0, z: 0, r: 1, ax: 0, ay: 0, az: 0, scale: 1, fx: 0, fz: -1 };
}

/**
 * Where the hands are this frame. A pure function of the frame (and the engine's live
 * stroke), so the hands, the pour ribbon and the falling grains all agree exactly.
 */
export function readHands(f: FrameCtx, pour: PourTracker, out: HandsState): HandsState {
  const live = pour.active;
  const tool = live ? pour.tool : f.tool;
  const b = f.brush;
  out.tool = tool;
  out.pouring = false;
  if (f.watching || tool === 'look' || (!b && !live)) {
    out.shown = false;
    return out;
  }
  out.shown = true;
  out.pouring = f.stroking || live;
  if (b) {
    out.x = b.x;
    out.y = b.y;
    out.z = b.z;
    out.r = b.r;
  } else {
    out.x = pour.x;
    out.y = pour.y;
    out.z = pour.z;
    out.r = pour.r;
  }
  // Hand size follows the zoom; on a tall, narrow phone screen they shrink to keep a similar share of its width.
  const scale = Math.max(0.8, Math.min(140, f.cam.dist * HAND_PER_DIST * Math.max(0.6, Math.min(1, f.camera.aspect))));
  out.scale = scale;
  const sy = Math.sin(f.cam.yaw);
  const cy = Math.cos(f.cam.yaw);
  const sp = Math.sin(f.cam.pitch);
  const cp = Math.cos(f.cam.pitch);
  out.fx = -sy;
  out.fz = -cy;
  // Lift the hands straight up until they clear the ring on screen (by about a hand), so the
  // stream falls straight down onto the brush. Looking steeply down, lifting no longer moves
  // them up the screen, so they also slide away from the camera. A little toward the camera
  // (along the view, which doesn't move them on screen) keeps them in front of nearby bumps.
  const r = out.r;
  const clear = r + 0.8 * scale;
  const ahead = clear * smoothstep(0.75, 1.3, f.cam.pitch);
  let lift = Math.max(0.3 * r + 0.6 * scale, (clear - ahead * sp) / Math.max(cp, 0.2));
  const toward = 0.3 * scale;
  // Smoothing hands circle; scooping hands dip (both stay clear of the ring).
  let ox = 0;
  let oz = 0;
  if (out.pouring && tool === 'hands') {
    const w = (f.t * 2 * Math.PI) / 2.4;
    ox = Math.cos(w) * 0.15 * r;
    oz = Math.sin(w) * 0.15 * r;
  } else if (out.pouring && tool === 'scoop') {
    lift *= 0.92 + 0.08 * Math.cos((f.t * 2 * Math.PI) / 1.6);
  }
  const bob = Math.sin((f.t * 2 * Math.PI) / 3.6) * 0.04 * scale;
  out.ax = out.x + out.fx * ahead + sy * cp * toward + ox;
  out.az = out.z + out.fz * ahead + cy * cp * toward + oz;
  // Lift from where material lands: the ground, or the sea surface above a submerged brush.
  out.ay = Math.max(out.y, SEA_LEVEL) + lift + sp * toward + bob;
  // Never inside the ground or the sea.
  const floor = Math.max(f.fields.heightAt(out.ax, out.az), SEA_LEVEL) + 0.45 * scale;
  if (out.ay < floor) out.ay = floor;
  return out;
}

// ---------- hand geometry ----------

/** One finger or thumb: a chain of tapered tubes. Coordinates in hand lengths, right hand, palm up, fingers toward +z. */
interface Digit {
  base: readonly [number, number, number];
  /** Direction it points when straight (unit). */
  dir: readonly [number, number, number];
  /** The way it curls (unit, at right angles to dir). */
  curlDir: readonly [number, number, number];
  lens: readonly number[];
  /** Radius at each joint (lens.length + 1). */
  radii: readonly number[];
  /** Bend at each joint when fully curled (radians). */
  bends: readonly number[];
  /** Sideways fan when the fingers part (radians). */
  splay: number;
}

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

/** A curl direction made exactly square to the digit's direction (the bending maths needs it). */
function across(dir: readonly [number, number, number], x: number, y: number, z: number): [number, number, number] {
  const d = x * dir[0] + y * dir[1] + z * dir[2];
  return unit(x - d * dir[0], y - d * dir[1], z - d * dir[2]);
}

const UP: readonly [number, number, number] = [0, 1, 0];
const THUMB_DIR = unit(0.75, 0.12, 0.65);
const FWD: readonly [number, number, number] = [0, 0, 1];
const DIGITS: readonly Digit[] = [
  // pinky (next to the other hand), ring, middle, index
  { base: [0.06, 0.0, 0.14], dir: FWD, curlDir: UP, lens: [0.14, 0.085, 0.07], radii: [0.044, 0.04, 0.035, 0.03], bends: [0.8, 0.85, 0.5], splay: -0.07 },
  { base: [0.155, 0.005, 0.17], dir: FWD, curlDir: UP, lens: [0.17, 0.105, 0.08], radii: [0.049, 0.045, 0.039, 0.033], bends: [0.75, 0.85, 0.5], splay: -0.025 },
  { base: [0.255, 0.005, 0.18], dir: FWD, curlDir: UP, lens: [0.185, 0.115, 0.085], radii: [0.051, 0.047, 0.04, 0.034], bends: [0.72, 0.85, 0.5], splay: 0.02 },
  { base: [0.35, 0.0, 0.165], dir: FWD, curlDir: UP, lens: [0.17, 0.1, 0.08], radii: [0.048, 0.044, 0.038, 0.032], bends: [0.7, 0.8, 0.5], splay: 0.06 },
  // thumb: from the heel of the palm, out and forward, curling up across the palm
  { base: [0.39, -0.005, -0.06], dir: THUMB_DIR, curlDir: across(THUMB_DIR, -0.55, 0.78, 0.3), lens: [0.16, 0.12], radii: [0.06, 0.05, 0.04], bends: [0.45, 0.6], splay: 0.2 },
];
const SIDES = 5;
/** The palm: a squashed ellipsoid. */
const PALM_C: readonly [number, number, number] = [0.21, 0.0, -0.05];
const PALM_R: readonly [number, number, number] = [0.215, 0.078, 0.25];
const PALM_AROUND = 10;
const PALM_RINGS = 3;
/** The axis the hand turns over around (its middle). */
const HAND_MID_X = 0.21;

const PALM_VERTS = 2 + PALM_RINGS * PALM_AROUND;
const DIGIT_VERTS = DIGITS.map((d) => (d.lens.length + 1) * SIDES + 1);
const HAND_VERTS = PALM_VERTS + DIGIT_VERTS.reduce((s, n) => s + n, 0);

/** Triangle indices for one right hand (vertex order matches poseHand). */
function handIndices(): number[] {
  const idx: number[] = [];
  // Palm: top pole 0, rings 1.., bottom pole last.
  const ring = (r: number, k: number) => 1 + r * PALM_AROUND + (k % PALM_AROUND);
  const bottom = PALM_VERTS - 1;
  for (let k = 0; k < PALM_AROUND; k++) {
    idx.push(0, ring(0, k + 1), ring(0, k));
    for (let r = 0; r < PALM_RINGS - 1; r++) idx.push(ring(r, k), ring(r, k + 1), ring(r + 1, k), ring(r + 1, k), ring(r, k + 1), ring(r + 1, k + 1));
    idx.push(bottom, ring(PALM_RINGS - 1, k), ring(PALM_RINGS - 1, k + 1));
  }
  // Digits: tube rings then the fingertip.
  let o = PALM_VERTS;
  DIGITS.forEach((d, di) => {
    const rings = d.lens.length + 1;
    for (let r = 0; r < rings - 1; r++) {
      for (let k = 0; k < SIDES; k++) {
        const a = o + r * SIDES + k;
        const b = o + r * SIDES + ((k + 1) % SIDES);
        const c = a + SIDES;
        const e = b + SIDES;
        idx.push(a, b, c, c, b, e);
      }
    }
    const tip = o + rings * SIDES;
    for (let k = 0; k < SIDES; k++) idx.push(o + (rings - 1) * SIDES + k, o + (rings - 1) * SIDES + ((k + 1) % SIDES), tip);
    o += DIGIT_VERTS[di];
  });
  return idx;
}

/** A pose for the pair of hands. All values blend smoothly. */
export interface HandPose {
  /** 0 straight .. 1 fully curled fingers. */
  curl: number;
  /** 0 together .. 1 fingers parted. */
  spread: number;
  /** Cup roll (radians): thumb sides up, pinky edges down. */
  roll: number;
  /** 0 palms up .. 1 palms down. */
  flip: number;
  /** Gap between the two hands at the pinky edges (hand lengths). */
  gap: number;
  /** Fingertips tipped down (radians). */
  pitch: number;
}

const POSES: Record<'hold' | 'pour' | 'drop' | 'smooth' | 'scoop', HandPose> = {
  hold: { curl: 0.35, spread: 0, roll: 0.4, flip: 0, gap: 0.0, pitch: 0.0 },
  pour: { curl: 0.28, spread: 0.35, roll: 0.45, flip: 0, gap: 0.08, pitch: 0.25 },
  drop: { curl: 0.08, spread: 0.8, roll: -0.12, flip: 0, gap: 0.22, pitch: 0.2 },
  smooth: { curl: 0.15, spread: 0.3, roll: -0.15, flip: 1, gap: 0.34, pitch: 0.0 },
  scoop: { curl: 0.8, spread: 0.05, roll: 0.36, flip: 0, gap: 0.0, pitch: 0.35 },
};

const POSE_KEYS = ['curl', 'spread', 'roll', 'flip', 'gap', 'pitch'] as const;

/** The pose for a tool, holding or stroking. */
export function poseFor(tool: ToolId, stroking: boolean): HandPose {
  if (tool === 'hands') return POSES.smooth;
  if (tool === 'scoop') return POSES.scoop;
  if (!stroking) return POSES.hold;
  return tool === 'rock' ? POSES.drop : POSES.pour;
}

/** Rotations of the pose being written (set by poseHands, used by putVertex). */
const turn = { cf: 1, sf: 0, cr: 1, sr: 0, gap: 0, v: 0 };

/** Write one vertex of the right hand and its mirror image (the left hand). */
function putVertex(pos: Float32Array, nrm: Float32Array, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
  // Turn the hand over about its middle, then roll it about its pinky edge, then open the gap.
  const { cf, sf, cr, sr } = turn;
  let px = HAND_MID_X + (x - HAND_MID_X) * cf - y * sf;
  let py = (x - HAND_MID_X) * sf + y * cf;
  let qx = nx * cf - ny * sf;
  let qy = nx * sf + ny * cf;
  const rx = px * cr - py * sr;
  py = px * sr + py * cr;
  px = rx + turn.gap * 0.5;
  const rnx = qx * cr - qy * sr;
  qy = qx * sr + qy * cr;
  qx = rnx;
  const o = turn.v * 3;
  const m = HAND_VERTS * 3;
  pos[o] = px;
  pos[o + 1] = py;
  pos[o + 2] = z;
  nrm[o] = qx;
  nrm[o + 1] = qy;
  nrm[o + 2] = nz;
  pos[m + o] = -px;
  pos[m + o + 1] = py;
  pos[m + o + 2] = z;
  nrm[m + o] = -qx;
  nrm[m + o + 1] = qy;
  nrm[m + o + 2] = nz;
  turn.v++;
}

/**
 * Write one pose of both hands into position/normal arrays (right hand first, then its mirror).
 * Coordinates are in hand lengths around the gap between the palms.
 */
export function poseHands(p: HandPose, pos: Float32Array, nrm: Float32Array): void {
  turn.cf = Math.cos(p.flip * Math.PI);
  turn.sf = Math.sin(p.flip * Math.PI);
  turn.cr = Math.cos(p.roll);
  turn.sr = Math.sin(p.roll);
  turn.gap = p.gap;
  turn.v = 0;
  // Palm: a squashed ellipsoid whose top dips into a shallow dish (the hollow of the hand).
  putVertex(pos, nrm, PALM_C[0], PALM_C[1] + PALM_R[1] * 0.15, PALM_C[2], 0, 1, 0);
  for (let r = 0; r < PALM_RINGS; r++) {
    const lat = Math.PI * ((r + 1) / (PALM_RINGS + 1));
    const sy = Math.cos(lat);
    const sr = Math.sin(lat);
    for (let k = 0; k < PALM_AROUND; k++) {
      const lon = (k / PALM_AROUND) * Math.PI * 2;
      const ex = Math.cos(lon) * sr;
      const ez = Math.sin(lon) * sr;
      // Ellipsoid normal (position over squared radii); on the dish's rim it leans inward.
      const dish = sy > 0.5 ? 0.9 : 0;
      const nx = ex / PALM_R[0] - (ex * dish) / PALM_R[1];
      const ny = sy / PALM_R[1] + dish / PALM_R[1];
      const nz = ez / PALM_R[2] - (ez * dish) / PALM_R[1];
      const nl = Math.hypot(nx, ny, nz);
      putVertex(pos, nrm, PALM_C[0] + ex * PALM_R[0], PALM_C[1] + sy * PALM_R[1], PALM_C[2] + ez * PALM_R[2], nx / nl, ny / nl, nz / nl);
    }
  }
  putVertex(pos, nrm, PALM_C[0], PALM_C[1] - PALM_R[1], PALM_C[2], 0, -1, 0);
  // Digits: bend each one in the plane of its direction and curl direction.
  for (let di = 0; di < DIGITS.length; di++) {
    const d = DIGITS[di];
    const thumb = di === DIGITS.length - 1;
    const curl = thumb ? p.curl * 0.8 : p.curl;
    // Fan the digit about its curl direction (Rodrigues; dir is at right angles to the axis).
    const fan = d.splay * (1 + 1.6 * p.spread);
    const cfn = Math.cos(fan);
    const sfn = Math.sin(fan);
    const [ux, uy, uz] = d.curlDir;
    const cxx = uy * d.dir[2] - uz * d.dir[1];
    const cxy = uz * d.dir[0] - ux * d.dir[2];
    const cxz = ux * d.dir[1] - uy * d.dir[0];
    const dx = d.dir[0] * cfn + cxx * sfn;
    const dy = d.dir[1] * cfn + cxy * sfn;
    const dz = d.dir[2] * cfn + cxz * sfn;
    // The side axis of the bending plane.
    let lx = dy * uz - dz * uy;
    let ly = dz * ux - dx * uz;
    let lz = dx * uy - dy * ux;
    const ll = Math.hypot(lx, ly, lz);
    lx /= ll;
    ly /= ll;
    lz /= ll;
    let jx = d.base[0];
    let jy = d.base[1];
    let jz = d.base[2];
    let ang = 0;
    let hx = dx;
    let hy = dy;
    let hz = dz;
    const rings = d.lens.length + 1;
    for (let r = 0; r < rings; r++) {
      // Heading of the next segment, and the ring's direction halfway between the two.
      const nextAng = r < d.lens.length ? ang + curl * d.bends[r] : ang;
      const tAng = r === 0 ? nextAng * 0.5 : (ang + nextAng) * 0.5;
      const ct = Math.cos(tAng);
      const st = Math.sin(tAng);
      const tx = dx * ct + ux * st;
      const ty = dy * ct + uy * st;
      const tz = dz * ct + uz * st;
      // Second ring axis, in the bending plane and across the tube.
      const mx = ty * lz - tz * ly;
      const my = tz * lx - tx * lz;
      const mz = tx * ly - ty * lx;
      const rad = d.radii[r];
      for (let k = 0; k < SIDES; k++) {
        const th = (k / SIDES) * Math.PI * 2;
        const c = Math.cos(th);
        const s = Math.sin(th);
        const nx = lx * c + mx * s;
        const ny = ly * c + my * s;
        const nz = lz * c + mz * s;
        putVertex(pos, nrm, jx + nx * rad, jy + ny * rad, jz + nz * rad, nx, ny, nz);
      }
      if (r < d.lens.length) {
        ang = nextAng;
        hx = dx * Math.cos(ang) + ux * Math.sin(ang);
        hy = dy * Math.cos(ang) + uy * Math.sin(ang);
        hz = dz * Math.cos(ang) + uz * Math.sin(ang);
        jx += hx * d.lens[r];
        jy += hy * d.lens[r];
        jz += hz * d.lens[r];
      }
    }
    const tipR = d.radii[rings - 1] * 0.95;
    putVertex(pos, nrm, jx + hx * tipR, jy + hy * tipR, jz + hz * tipR, hx, hy, hz);
  }
}

/** Both hands' geometry (posed later by poseHands). */
export function makeHandsGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(HAND_VERTS * 2 * 3);
  const nrm = new Float32Array(HAND_VERTS * 2 * 3);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage));
  const one = handIndices();
  const idx = new Uint16Array(one.length * 2);
  for (let i = 0; i < one.length; i += 3) {
    idx[i] = one[i];
    idx[i + 1] = one[i + 1];
    idx[i + 2] = one[i + 2];
    // The mirrored hand needs its triangles wound the other way.
    const j = one.length + i;
    idx[j] = one[i] + HAND_VERTS;
    idx[j + 1] = one[i + 2] + HAND_VERTS;
    idx[j + 2] = one[i + 1] + HAND_VERTS;
  }
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.5);
  return g;
}

/** The heap of material held in the cup: a lumpy, squashed ball (80 triangles), in hand lengths. */
export function makePileGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  ico.dispose();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const r = 1 + 0.14 * Math.sin(x * 5.1 + z * 3.3) * Math.cos(y * 4.2);
    // A flat underside resting in the palms, a rounded heap on top.
    pos.setXYZ(v, x * r * 0.17, Math.max(y, -0.35) * r * 0.075 + 0.035, z * r * 0.2 - 0.04);
  }
  g.computeVertexNormals();
  return g;
}

// ---------- the system ----------

const VERTEX = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vLocal;
#include <common>
#include <fog_pars_vertex>
void main() {
  vLocal = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vec4 mvPosition = viewMatrix * w;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform vec3 uHandColor;
uniform vec3 uWarmColor;
uniform float uWarm;
uniform float uOpacity;
varying vec3 vNormalW;
varying vec3 vWorld;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(uCamPos - vWorld);
  float rim = pow(1.0 - abs(dot(N, V)), 2.0);
  float wrap = dot(N, uSunDir) * 0.5 + 0.5;
  // Soft shading from the sun and sky, readable at night (the moonlight only dims them a little).
  vec3 light = mix(vec3(1.0), vec3(0.72, 0.78, 0.95), uNight) * (0.42 + 0.7 * wrap * wrap) * (0.85 + 0.15 * N.y);
  vec3 col = uHandColor * light;
  // Lava glow from below: strongest on the undersides, breathing slowly.
  float below = 1.0 - smoothstep(-0.9, 0.3, N.y);
  float warm = uWarm * (0.3 + 0.7 * below) * (0.85 + 0.15 * sin(uTime * 2.618));
  col += uWarmColor * warm;
  col += vec3(1.0, 0.97, 0.9) * rim * 0.35;
  float alpha = uOpacity * (0.7 + 0.25 * rim + 0.2 * warm);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** The heap in the cup: lit sand or stone, or molten lava that glows and churns slowly. */
const PILE_FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform vec3 uPileColor;
uniform float uMolten;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec3 vLocal;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec3 N = normalize(vNormalW);
  float wrap = dot(N, uSunDir) * 0.5 + 0.5;
  vec3 lit = uPileColor * mix(vec3(1.0), vec3(0.4, 0.46, 0.62), uNight) * (0.35 + 0.75 * wrap);
  // Slow churning bands of brighter melt (periods 5 s and 7.5 s).
  float n = 0.5 + 0.5 * sin(vLocal.x * 26.0 + 2.2 * sin(vLocal.z * 30.0 + uTime * 1.2566) + vLocal.y * 20.0 - uTime * 0.8378);
  float core = clamp(dot(N, normalize(uCamPos - vWorld)), 0.0, 1.0);
  vec3 molten = mix(vec3(0.8, 0.14, 0.03), vec3(1.0, 0.72, 0.25), n * 0.7 + core * 0.3) * (1.1 + 0.5 * core);
  gl_FragColor = vec4(mix(lit, molten, uMolten), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** What each tool holds in the cup: colour, molten or not, and its size held / while stroking. */
const PILES: Record<ToolId, { color: number; molten: number; held: number; stroking: number }> = {
  lava: { color: 0xff6a20, molten: 1, held: 1, stroking: 0.8 },
  sand: { color: 0xe9d6a8, molten: 0, held: 1, stroking: 0.8 },
  rock: { color: 0x8f8a82, molten: 0, held: 1, stroking: 0 },
  hands: { color: 0xffffff, molten: 0, held: 0, stroking: 0 },
  scoop: { color: 0xffffff, molten: 0, held: 0, stroking: 0 },
  look: { color: 0xffffff, molten: 0, held: 0, stroking: 0 },
};

export function createHands(deps: SystemDeps): PageSystem {
  const { scene, u } = deps;
  const geometry = makeHandsGeometry();
  const posAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
  const nrmAttr = geometry.getAttribute('normal') as THREE.BufferAttribute;

  const warm = { value: 0 };
  const opacity = { value: 0 };
  const material = new THREE.ShaderMaterial({
    name: 'hands',
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...u,
      uHandColor: { value: new THREE.Color(0xe8cfa0) },
      uWarmColor: { value: new THREE.Color(0xff7a2a) },
      uWarm: warm,
      uOpacity: opacity,
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  // Depth first, so only the nearest surface of the hands is tinted (no fingers seen through palms).
  // It runs the very same vertex shader, so both passes land on exactly the same depths.
  const depthOnly = new THREE.ShaderMaterial({
    name: 'hands-depth',
    vertexShader: VERTEX,
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    colorWrite: false,
    transparent: true,
    depthWrite: true,
  });
  const prepass = new THREE.Mesh(geometry, depthOnly);
  const mesh = new THREE.Mesh(geometry, material);
  for (const m of [prepass, mesh]) {
    m.frustumCulled = false;
    m.visible = false;
    m.matrixAutoUpdate = false;
  }
  prepass.renderOrder = 8;
  mesh.renderOrder = 9;
  // The heap is solid, drawn with the opaque world, so it shows through the see-through fingers.
  const pileColor = new THREE.Color();
  const molten = { value: 0 };
  const pileGeometry = makePileGeometry();
  const pileMaterial = new THREE.ShaderMaterial({
    name: 'hands-pile',
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...u, uPileColor: { value: pileColor }, uMolten: molten },
    vertexShader: VERTEX,
    fragmentShader: PILE_FRAGMENT,
    fog: true,
  });
  const pile = new THREE.Mesh(pileGeometry, pileMaterial);
  pile.frustumCulled = false;
  pile.visible = false;
  pile.matrixAutoUpdate = false;
  scene.add(prepass, mesh, pile);
  let pileSize = 0;

  const pour = new PourTracker();
  const state = createHandsState();
  const pose: HandPose = { ...POSES.hold };
  let posed = false;
  // Last place the hands were seen, so they can fade out where they were.
  const at = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const tilt = new THREE.Matrix4();
  const scaleV = new THREE.Vector3();

  return {
    name: 'hands',
    onEngine(m: FromEngine) {
      pour.onEngine(m);
    },
    update(f: FrameCtx) {
      pour.advance(f.dt);
      readHands(f, pour, state);
      // Fade in and out (about a quarter of a second).
      const targetOpacity = state.shown ? 1 : 0;
      opacity.value += (targetOpacity - opacity.value) * (1 - Math.exp(-f.dt * 10));
      if (opacity.value < 0.01 && !state.shown) {
        opacity.value = 0;
        mesh.visible = prepass.visible = pile.visible = false;
        pileSize = 0;
        return;
      }
      mesh.visible = prepass.visible = true;
      // Blend toward the tool's pose; re-pose the vertices only while something changes.
      const target = poseFor(state.tool, state.pouring);
      const k = 1 - Math.exp(-f.dt * 7);
      let moved = !posed;
      for (let i = 0; i < POSE_KEYS.length; i++) {
        const key = POSE_KEYS[i];
        const d = target[key] - pose[key];
        if (Math.abs(d) > 1e-4) {
          pose[key] += d * k;
          moved = true;
        }
      }
      if (moved) {
        poseHands(pose, posAttr.array as Float32Array, nrmAttr.array as Float32Array);
        posAttr.needsUpdate = true;
        nrmAttr.needsUpdate = true;
        posed = true;
      }
      const warmTarget = state.tool === 'lava' ? (state.pouring ? 1 : 0.3) : 0;
      warm.value += (warmTarget - warm.value) * (1 - Math.exp(-f.dt * 4));
      if (state.shown) at.set(state.ax, state.ay, state.az);
      // Hand frame: x across (the camera's left: the pair is symmetric, and this keeps the frame
      // a proper rotation), y up, z away from the camera; then tipped forward by the pose.
      basis.set(state.fz, 0, state.fx, at.x, 0, 1, 0, at.y, -state.fx, 0, state.fz, at.z, 0, 0, 0, 1);
      // From low down, tip the cup a little toward the camera so you still see into the hands.
      tilt.makeRotationX(pose.pitch - 0.3 * (1 - smoothstep(0.25, 0.8, f.cam.pitch)));
      scaleV.setScalar(state.scale);
      mesh.matrix.copy(basis).multiply(tilt).scale(scaleV);
      prepass.matrix.copy(mesh.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      prepass.matrixWorldNeedsUpdate = true;
      // The heap grows and shrinks rather than popping (with the tool, the pour, and the fade).
      const held = PILES[state.tool];
      const pileTarget = (state.pouring ? held.stroking : held.held) * opacity.value;
      pileSize += (pileTarget - pileSize) * (1 - Math.exp(-f.dt * 8));
      pile.visible = pileSize > 0.02;
      if (pile.visible) {
        pileColor.setHex(held.color);
        molten.value = held.molten;
        scaleV.setScalar(pileSize);
        pile.matrix.copy(mesh.matrix).scale(scaleV);
        pile.matrixWorldNeedsUpdate = true;
      }
    },
    dispose() {
      scene.remove(prepass, mesh, pile);
      geometry.dispose();
      material.dispose();
      depthOnly.dispose();
      pileGeometry.dispose();
      pileMaterial.dispose();
    },
  };
}
