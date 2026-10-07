/**
 * Weather (WP-G): storm light, wind and gusts, rain, lightning, sunbeams, wet ground.
 *
 * The engine decides when storms happen (FrameCtx.storm: warning, then peak, then clearing).
 * This file turns that into what you see and feel:
 * - the shared uniforms uStorm, uRain, uWet and uWind that every material reads;
 * - rain streaks around the camera: one instanced draw whose drops are placed, dropped and
 *   wrapped entirely in the vertex shader, so the CPU does nothing per drop;
 * - far lightning over the sea (never on the island), at most one strike every 6 s, with a
 *   small sky brightening that the "fewer flashes" setting turns off;
 * - soft sunbeams as the clouds break, and the rainbow timing (sky.ts paints the arc);
 * - a small shared WeatherState that daylight (storm light), sky (storm deck, flash,
 *   rainbow) and audio (rain, gusts, thunder) read, so everything follows one storm.
 *
 * Storms are "weather to watch", never danger: the light turns amber, then grey, the wind
 * rises, a minute of rain and far thunder, then the clouds break and a rainbow appears.
 */
import * as THREE from 'three';
import { WIND_TO_X, WIND_TO_Z } from '../config';
import { clamp, hash2, mulberry32, smoothstep } from '../engine/noise';
import type { StormState } from '../engine/protocol';
import type { FrameCtx, PageSystem, SystemDeps, WorldUniforms } from './shared';

// ---------- the storm curve (pure: tested in tests/sky.test.ts) ----------

/**
 * A typical warning lasts this long (ARCHITECTURE §6.8 says 30-45 s). The warning builds with
 * time over this span, or faster if the engine's level says the storm is nearer.
 */
export const WARNING_SECONDS = 40;
/** A typical clearing lasts this long. */
export const CLEARING_SECONDS = 30;
/** Calm trade-wind strength (0..1); storms raise it to 1. */
export const CALM_WIND = 0.35;

/** What a storm does to the world at one moment, before smoothing. */
export interface StormCurve {
  /** uStorm: swell, whitecaps, cloud darkening (0..1). */
  storm: number;
  /** Grey overcast light (0..1). */
  gloom: number;
  /** The amber light at the start of a warning (0..1). */
  amber: number;
  /** Rain intensity (0..1). */
  rain: number;
  /** Wind strength (CALM_WIND..1). */
  wind: number;
  /** Sunbeams through the breaking clouds (0..1). */
  beams: number;
  /** Lightning may strike now. */
  lightning: boolean;
}

export function makeStormCurve(): StormCurve {
  return { storm: 0, gloom: 0, amber: 0, rain: 0, wind: CALM_WIND, beams: 0, lightning: false };
}

/**
 * Map the engine's storm state to the storm curve. Within a phase every value moves one way
 * only (rising through the warning, falling through the clearing; amber and beams are short
 * bumps), and the phases meet without jumps when the engine's timings are the usual ones.
 */
export function stormCurve(s: Pick<StormState, 'phase' | 't' | 'level'>, out: StormCurve = makeStormCurve()): StormCurve {
  out.amber = 0;
  out.beams = 0;
  out.lightning = false;
  if (s.phase === 'warning') {
    // Progress through the warning: time, or the engine's level when it is further along. The
    // contract only says the level "rises in warning, 1 at peak", so it is used as it comes: an
    // engine whose level tops out lower (the stub stops at 0.6) is simply led by the clock, and
    // one that reaches 1 just as the peak begins is followed exactly, even in a short warning.
    const p = clamp(Math.max(s.level, s.t / WARNING_SECONDS), 0, 1);
    out.storm = p;
    out.gloom = smoothstep(0.15, 1, p);
    out.amber = smoothstep(0, 0.25, p) * (1 - smoothstep(0.45, 0.85, p));
    out.wind = CALM_WIND + (0.85 - CALM_WIND) * smoothstep(0, 1, p);
    out.rain = 0.2 * smoothstep(0.8, 1, p);
  } else if (s.phase === 'peak') {
    out.storm = 1;
    out.gloom = 1;
    out.wind = 0.85 + 0.15 * smoothstep(0, 6, s.t);
    out.rain = 0.2 + 0.8 * smoothstep(0, 6, s.t);
    out.lightning = true;
  } else if (s.phase === 'clearing') {
    const c = clamp(Math.max(1 - s.level, s.t / CLEARING_SECONDS), 0, 1);
    out.storm = 1 - c;
    out.gloom = 1 - smoothstep(0, 0.7, c);
    out.wind = 1 - (1 - CALM_WIND) * smoothstep(0, 1, c);
    out.rain = 1 - smoothstep(0, 0.55, c);
    out.beams = smoothstep(0.15, 0.4, c) * (1 - smoothstep(0.75, 1, c));
  } else {
    out.storm = 0;
    out.gloom = 0;
    out.wind = CALM_WIND;
    out.rain = 0;
  }
  return out;
}

/** Rainbow strength, from seconds since the clearing began: fades in, holds ~30 s, fades out. */
export function rainbowAt(sinceClear: number): number {
  return smoothstep(3, 11, sinceClear) * (1 - smoothstep(42, 58, sinceClear));
}

/** Seconds until the next lightning strike: never sooner than 6 s (photosensitivity-safe). */
export function nextStrikeDelay(rand: () => number): number {
  return 6 + 8 * rand();
}

/**
 * Sky brightening after a strike (multiplier added to the sky, 0..0.3): one soft flash of
 * 0.12 s and a fainter re-strobe. Kept small: a dark storm sky brightens by about a third,
 * far below the luminance change that counts as a "flash" for photosensitive viewers.
 */
export function flashAt(sinceStrike: number): number {
  const a = sinceStrike;
  if (a < 0 || a > 0.4) return 0;
  const first = smoothstep(0, 0.02, a) * (1 - smoothstep(0.1, 0.16, a));
  const second = smoothstep(0.22, 0.25, a) * (1 - smoothstep(0.27, 0.36, a));
  return 0.3 * first + 0.14 * second;
}

/**
 * Bolt visibility after a strike: bright, a flicker, bright, gone by 0.2 s. With "fewer
 * flashes" (`soft`) it is one dim, smooth pulse with no flicker at all.
 */
export function boltAt(sinceStrike: number, soft = false): number {
  const a = sinceStrike;
  if (a < 0 || a > 0.2) return 0;
  if (soft) return 0.45 * Math.sin((Math.PI * a) / 0.2);
  if (a < 0.07) return 1;
  if (a < 0.11) return 0.35;
  return 1 - smoothstep(0.16, 0.2, a);
}

/** Smooth 1D value noise in [0, 1] from a sin-free integer hash. */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash2(i, 0, seed) * (1 - u) + hash2(i + 1, 0, seed) * u;
}

/** Gusts (0..1) at real time t: occasional soft gusts when calm, frequent strong ones in storms. */
export function gustAt(t: number, storm: number): number {
  const speed = 1 + 1.5 * storm;
  const n = noise1(t * 0.19 * speed, 11) * 0.65 + noise1(t * 0.53 * speed, 12) * 0.35;
  return smoothstep(0.42 - 0.25 * storm, 0.85 - 0.2 * storm, n);
}

/** Slow veer of the trade wind (radians): a few degrees when calm, more in storms. */
export function windVeer(t: number, storm: number): number {
  return (noise1(t / 97, 13) - 0.5) * (0.3 + 0.6 * storm);
}

// ---------- how the rain moves (pure: tested in tests/sky.test.ts) ----------

/**
 * Rain falls in four nested boxes around the camera, half-widths in metres, a quarter of the
 * drops in each. Every drop has a fixed place in the world and wraps around the camera inside
 * its box, so panning and zooming move through the rain as they would through real rain. The
 * boxes never change size: a box that changed size would shuffle every drop in it.
 */
export const RAIN_BOXES = [24, 48, 96, 192] as const;
/** The wind's push wraps at this distance: a whole number of every box's width, so no drop jumps. */
export const RAIN_WRAP = 2 * RAIN_BOXES[RAIN_BOXES.length - 1];
/** Sideways speed of the rain in full wind (m/s), and the extra a gust adds. Drops fall at 8.5-11.5 m/s. */
const RAIN_PUSH = 6;
const RAIN_GUST_PUSH = 3;

/** The rain's own clocks, moved on each frame so drops travel at real speeds whatever the wind does. */
export interface RainMotion {
  /** How far the wind has carried the rain (m, wrapped at RAIN_WRAP). */
  driftX: number;
  driftZ: number;
  /** The rain's sideways speed now (m/s): it also slants the streaks. */
  velX: number;
  velZ: number;
  /** Seconds this shower has been falling. */
  fall: number;
}

/** v wrapped into [0, RAIN_WRAP). */
function wrapRain(v: number): number {
  return v - Math.floor(v / RAIN_WRAP) * RAIN_WRAP;
}

export function makeRainMotion(): RainMotion {
  return { driftX: 0, driftZ: 0, velX: 0, velZ: 0, fall: 0 };
}

/**
 * Move the rain on by dt. The wind (unit direction, strength CALM_WIND..1, gust 0..1) carries it
 * sideways at a few metres a second. Between showers (`raining` false, nothing drawn) the
 * clocks start again from zero, so the GPU always works with small, exact numbers.
 */
export function advanceRain(m: RainMotion, windX: number, windZ: number, strength: number, gust: number, dt: number, raining: boolean): RainMotion {
  const push = strength * (RAIN_PUSH + RAIN_GUST_PUSH * gust);
  m.velX = windX * push;
  m.velZ = windZ * push;
  if (!raining) {
    m.driftX = 0;
    m.driftZ = 0;
    m.fall = 0;
    return m;
  }
  m.driftX = wrapRain(m.driftX + m.velX * dt);
  m.driftZ = wrapRain(m.driftZ + m.velZ * dt);
  m.fall += dt;
  return m;
}

/**
 * How much each rain box shows from a camera distance (0..1 each). The boxes near the scale
 * of the view show fully, the much smaller or larger ones fade away (from up high, a box of
 * rain hugging the lens would only streak across the island). Weights change smoothly with
 * zoom, so the rain never jumps while you zoom.
 */
export function rainBoxWeights(camDist: number, out: THREE.Vector4): THREE.Vector4 {
  const best = clamp(camDist * 0.35, RAIN_BOXES[0], RAIN_BOXES[RAIN_BOXES.length - 1]);
  return out.set(boxShow(RAIN_BOXES[0], best), boxShow(RAIN_BOXES[1], best), boxShow(RAIN_BOXES[2], best), boxShow(RAIN_BOXES[3], best));
}

/** A box shows fully within 1.5 doublings of the view's own scale and is gone 3 doublings away. */
function boxShow(r: number, best: number): number {
  return 1 - smoothstep(1.5, 3, Math.abs(Math.log2(r / best)));
}

// ---------- shared state ----------

/** One storm, as every system sees it (smoothed, so nothing ever jumps). */
export interface WeatherState {
  storm: number;
  gloom: number;
  amber: number;
  rain: number;
  /** Surfaces still wet after rain (drains slowly). */
  wet: number;
  /** Wind strength (CALM_WIND..1) and the current gust (0..1). */
  wind: number;
  gust: number;
  /** Where the wind blows to (unit, x/z). */
  windX: number;
  windZ: number;
  beams: number;
  rainbow: number;
  /** Sky brightening from lightning (0 with "fewer flashes"). */
  flash: number;
  /** Strikes so far, and the latest one's place and distance from the camera (m). */
  strikes: number;
  strikeX: number;
  strikeZ: number;
  strikeDist: number;
  /** How far the storm deck has drifted (m), for the sky's moving overcast. */
  driftX: number;
  driftZ: number;
}

const states = new WeakMap<WorldUniforms, WeatherState>();

/** The weather shared by every system that renders this world (created on first use). */
export function weatherOf(u: WorldUniforms): WeatherState {
  let s = states.get(u);
  if (!s) {
    s = {
      storm: 0,
      gloom: 0,
      amber: 0,
      rain: 0,
      wet: 0,
      wind: CALM_WIND,
      gust: 0,
      windX: WIND_TO_X,
      windZ: WIND_TO_Z,
      beams: 0,
      rainbow: 0,
      flash: 0,
      strikes: 0,
      strikeX: 0,
      strikeZ: 0,
      strikeDist: 0,
      driftX: 0,
      driftZ: 0,
    };
    states.set(u, s);
  }
  return s;
}

/** The storm deck's noise repeats every this many metres, so its drift can wrap without a seam. */
export const DECK_PERIOD = 256 * 600;

// ---------- lightning bolt geometry ----------

/** Points per bolt line: 64 segments on the main bolt (6 halvings), 16 on each of 2 branches. */
const MAIN_PTS = 65;
const BRANCH_PTS = 17;
const BRANCHES = 2;
const SEGMENTS = MAIN_PTS - 1 + BRANCHES * (BRANCH_PTS - 1);
/** Core ribbon plus a wider soft halo. */
const BOLT_QUADS = SEGMENTS * 2;

/**
 * Midpoint displacement between pts[i0] and pts[i1] (x, y, z triples), sideways along
 * (sx, sz) and a little toward the viewer, halving the jitter each level.
 */
function displace(pts: Float32Array, i0: number, i1: number, jitter: number, sx: number, sz: number, rand: () => number): void {
  if (i1 - i0 < 2) return;
  const m = (i0 + i1) >> 1;
  const off = (rand() - 0.5) * 2 * jitter;
  pts[m * 3] = (pts[i0 * 3] + pts[i1 * 3]) / 2 + sx * off;
  pts[m * 3 + 1] = (pts[i0 * 3 + 1] + pts[i1 * 3 + 1]) / 2 + (rand() - 0.5) * jitter * 0.3;
  pts[m * 3 + 2] = (pts[i0 * 3 + 2] + pts[i1 * 3 + 2]) / 2 + sz * off;
  displace(pts, i0, m, jitter * 0.55, sx, sz, rand);
  displace(pts, m, i1, jitter * 0.55, sx, sz, rand);
}

// ---------- the system ----------

const RAIN_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aSeed;      // x, y, z: the drop's place in its box (0..1); w: its fall speed
uniform vec3 uCamPos;
uniform vec2 uRainDrift;   // how far the wind has carried the rain (m)
uniform vec2 uRainVel;     // the rain's sideways speed now (m/s)
uniform float uRainFall;   // seconds this shower has been falling
uniform vec4 uRainBoxes;   // half-width of each box (m)
uniform vec4 uRainShow;    // how much each box shows from this camera distance
varying float vAlpha;
varying float vAcross;
void main() {
  // Drops take turns between the four boxes, so each box keeps its share at any rain amount.
  vec4 box = vec4(equal(vec4(float(gl_InstanceID % 4)), vec4(0.0, 1.0, 2.0, 3.0)));
  float show = dot(uRainShow, box);
  if (show < 0.01) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // this box is out of scale for the view: no pixels
    return;
  }
  float R = dot(uRainBoxes, box);
  float H = R * 1.4;
  vec3 c = uCamPos;
  // Each drop has its own place in the world, carried by the wind and falling; it wraps around
  // the camera inside its box, so the rain always surrounds you and moving moves through it.
  vec3 rel;
  rel.xz = mod(aSeed.xz * 2.0 * R + uRainDrift - c.xz, 2.0 * R) - R;
  float speed = 8.5 + 3.0 * aSeed.w;
  rel.y = mod(aSeed.y * H - uRainFall * speed - c.y, H) - 0.5 * H;
  vec3 p = c + rel;
  // Slanted along the drop's own motion: falling at about 10 m/s, pushed sideways by the wind.
  vec3 dir = normalize(vec3(uRainVel.x * 0.1, -1.0, uRainVel.y * 0.1));
  vec3 toCam = -rel;
  float dCam = length(toCam);
  // Width and length grow with distance, so every streak stays about two pixels wide.
  float len = 0.8 + 0.035 * dCam;
  float w = 0.0028 * dCam;
  // Wound to face the camera (the other order would be culled as a back face).
  vec3 side = normalize(cross(toCam / max(dCam, 0.001), dir));
  vec3 world = p - dir * len * aCorner.y + side * aCorner.x * w;
  // Drops fade in and out at the edges of their box, so wrapping around is never seen.
  float yRel = rel.y / H + 0.5;
  float edge = max(abs(rel.x), abs(rel.z)) / R;
  vAlpha = show * smoothstep(0.0, 0.12, yRel) * (1.0 - smoothstep(0.85, 1.0, yRel)) * (1.0 - smoothstep(0.75, 1.0, edge)) * smoothstep(0.6, 3.0, dCam);
  vAcross = aCorner.x * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uNight;
uniform float uRainAmt;
varying float vAlpha;
varying float vAcross;
void main() {
  vec3 col = mix(uFogColor, vec3(0.86, 0.9, 0.95), 0.55) * (0.35 + 0.65 * (1.0 - uNight));
  float a = 0.42 * vAlpha * (1.0 - vAcross * vAcross) * (0.5 + 0.5 * uRainAmt);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

const BOLT_VERT = /* glsl */ `
attribute float aAcross;
attribute float aHalo;
varying float vAcross;
varying float vHalo;
void main() {
  vAcross = aAcross;
  vHalo = aHalo;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BOLT_FRAG = /* glsl */ `
uniform float uBolt;
varying float vAcross;
varying float vHalo;
void main() {
  float edge = 1.0 - vAcross * vAcross;
  vec3 core = vec3(0.87, 0.83, 1.0);
  vec3 halo = vec3(0.3, 0.25, 1.0);
  vec3 col = mix(core * 1.6, halo, vHalo) * edge * mix(1.0, 0.3, vHalo) * uBolt;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const BEAM_VERT = /* glsl */ `
attribute vec3 aLocal;    // cos, sin, height 0..1
attribute float aBeam;
uniform vec4 uBeams[4];   // ground x, z, radius, strength
uniform vec3 uSunDir;
uniform vec3 uCamPos;
varying float vH;
varying float vEdge;
varying float vStrength;
varying float vNear;
varying vec2 vRing;
varying float vSeed;
void main() {
  vec4 b = uBeams[int(aBeam)];
  vec3 axis = normalize(uSunDir);
  vec3 p1 = normalize(cross(axis, abs(axis.z) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0)));
  vec3 p2 = cross(axis, p1);
  float r = b.z * (0.7 + 0.9 * aLocal.z);
  vec3 radial = p1 * aLocal.x + p2 * aLocal.y;
  vec3 world = vec3(b.x, -2.0, b.y) + axis * aLocal.z * 900.0 + radial * r;
  vec3 v = normalize(uCamPos - world);
  vEdge = abs(dot(radial, v));
  // A beam right next to the camera would fill the view: it fades away up close.
  vNear = smoothstep(120.0, 400.0, length(uCamPos.xz - b.xy));
  vH = aLocal.z;
  vStrength = b.w;
  vRing = aLocal.xy;
  vSeed = aBeam * 17.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uSunColor;
uniform float uBeamAmt;
varying float vH;
varying float vEdge;
varying float vStrength;
varying float vNear;
varying vec2 vRing;
varying float vSeed;
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
void main() {
  // Soft rays along the shaft: smooth value noise around its circumference (9 cells, wrapping).
  float x = (atan(vRing.y, vRing.x) / 6.2832 + 0.5) * 9.0;
  float i = floor(x);
  float f = fract(x);
  float rays = mix(hash11(mod(i, 9.0) + vSeed), hash11(mod(i + 1.0, 9.0) + vSeed), f * f * (3.0 - 2.0 * f));
  // Brightest down the middle of the shaft, nothing at its edges, fading out along its length.
  float a = uBeamAmt * vStrength * vNear * vEdge * vEdge * vEdge * (0.45 + 0.55 * rays)
    * smoothstep(0.0, 0.08, vH) * (1.0 - smoothstep(0.4, 1.0, vH));
  // Added straight onto the finished screen colours, so there is no colour-space step here: a
  // small linear amount becomes a large screen amount after it, and the shaft would glare white.
  // The sun's colour is brought to screen space once (square root, near enough) to keep its tint.
  gl_FragColor = vec4(sqrt(max(uSunColor, vec3(0.0))) * a * 0.13, 1.0);
}`;

export function createWeather(deps: SystemDeps): PageSystem {
  const { scene, u, fields, prefs, quality } = deps;
  const st = weatherOf(u);
  const rand = mulberry32(0x5eed);
  const curve = makeStormCurve();
  const motion = makeRainMotion();
  // Every weather mesh starts visible but empty (nothing to draw), so the first frame, or a
  // precompile at load, builds its shader then, not at the storm's most dramatic moment. From
  // the second frame on each one shows only while it has something to draw.
  let firstFrame = true;

  // ----- rain: up to 1400 streaks on a phone, 2600 on a laptop (2 triangles each) -----
  const rainMax = quality.phone ? 1400 : 2600;
  const rainGeo = new THREE.InstancedBufferGeometry();
  rainGeo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1], 2));
  rainGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const seeds = new Float32Array(rainMax * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
  rainGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  rainGeo.instanceCount = 0;
  const rainUniforms = {
    uCamPos: u.uCamPos,
    uFogColor: u.uFogColor,
    uNight: u.uNight,
    uRainDrift: { value: new THREE.Vector2() },
    uRainVel: { value: new THREE.Vector2() },
    uRainFall: { value: 0 },
    uRainBoxes: { value: new THREE.Vector4(...RAIN_BOXES) },
    uRainShow: { value: new THREE.Vector4() },
    uRainAmt: { value: 0 },
  };
  const rain = new THREE.Mesh(
    rainGeo,
    new THREE.ShaderMaterial({ uniforms: rainUniforms, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false }),
  );
  rain.frustumCulled = false;
  rain.renderOrder = 8;
  scene.add(rain);

  // ----- lightning: camera-facing ribbons rebuilt at each strike (no per-frame work) -----
  const boltPos = new Float32Array(BOLT_QUADS * 4 * 3);
  const boltAcross = new Float32Array(BOLT_QUADS * 4);
  const boltHalo = new Float32Array(BOLT_QUADS * 4);
  const boltIndex = new Uint16Array(BOLT_QUADS * 6);
  for (let q = 0; q < BOLT_QUADS; q++) {
    boltAcross.set([-1, 1, -1, 1], q * 4);
    boltHalo.fill(q < SEGMENTS ? 0 : 1, q * 4, q * 4 + 4);
    boltIndex.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2], q * 6);
  }
  const boltGeo = new THREE.BufferGeometry();
  const boltPosAttr = new THREE.BufferAttribute(boltPos, 3);
  boltPosAttr.setUsage(THREE.DynamicDrawUsage);
  boltGeo.setAttribute('position', boltPosAttr);
  boltGeo.setAttribute('aAcross', new THREE.BufferAttribute(boltAcross, 1));
  boltGeo.setAttribute('aHalo', new THREE.BufferAttribute(boltHalo, 1));
  boltGeo.setIndex(new THREE.BufferAttribute(boltIndex, 1));
  // Nothing to draw until the first strike builds a bolt.
  boltGeo.setDrawRange(0, 0);
  const boltUniforms = { uBolt: { value: 0 } };
  const bolt = new THREE.Mesh(
    boltGeo,
    new THREE.ShaderMaterial({
      uniforms: boltUniforms,
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Light only adds, so the order of the faces does not matter: one pass draws both sides.
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }),
  );
  bolt.frustumCulled = false;
  bolt.renderOrder = 6;
  scene.add(bolt);
  const mainPts = new Float32Array(MAIN_PTS * 3);
  const branchPts = new Float32Array(BRANCHES * BRANCH_PTS * 3);

  /** Write one ribbon quad per segment of a polyline, facing the camera. */
  function ribbon(pts: Float32Array, start: number, count: number, quad: number, width: number, cam: THREE.Vector3): number {
    for (let i = 0; i < count - 1; i++) {
      const a = (start + i) * 3;
      const b = a + 3;
      const tx = pts[b] - pts[a];
      const ty = pts[b + 1] - pts[a + 1];
      const tz = pts[b + 2] - pts[a + 2];
      const vx = cam.x - pts[a];
      const vy = cam.y - pts[a + 1];
      const vz = cam.z - pts[a + 2];
      // side = normalize(t x v) * width/2
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      const k = (width * 0.5) / sl;
      sx *= k;
      sy *= k;
      sz *= k;
      const o = quad * 12;
      boltPos[o] = pts[a] - sx;
      boltPos[o + 1] = pts[a + 1] - sy;
      boltPos[o + 2] = pts[a + 2] - sz;
      boltPos[o + 3] = pts[a] + sx;
      boltPos[o + 4] = pts[a + 1] + sy;
      boltPos[o + 5] = pts[a + 2] + sz;
      boltPos[o + 6] = pts[b] - sx;
      boltPos[o + 7] = pts[b + 1] - sy;
      boltPos[o + 8] = pts[b + 2] - sz;
      boltPos[o + 9] = pts[b] + sx;
      boltPos[o + 10] = pts[b + 1] + sy;
      boltPos[o + 11] = pts[b + 2] + sz;
      quad++;
    }
    return quad;
  }

  /** Pick a far spot over the sea in front of the camera and build the bolt there. */
  function strike(f: FrameCtx): void {
    const cam = f.camera.position;
    const steep = smoothstep(0.6, 1.2, f.cam.pitch);
    // The camera looks along (-sin yaw, -cos yaw); strikes land ahead of it, a little to the sides.
    const ang = Math.atan2(-Math.cos(f.cam.yaw), -Math.sin(f.cam.yaw)) + (rand() - 0.5) * 1.0;
    let dist = 1400 - 500 * steep + rand() * 1200;
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 3; tries++) {
      x = f.cam.target.x + Math.cos(ang) * dist;
      z = f.cam.target.z + Math.sin(ang) * dist;
      if (fields.heightAt(x, z) < -3) break;
      dist += 600;
    }
    const top = 650 + rand() * 200;
    // Sideways axis: across the line of sight, so the zig-zag faces the viewer.
    const lx = z - cam.z;
    const lz = -(x - cam.x);
    const ll = Math.hypot(lx, lz) || 1;
    const sx = lx / ll;
    const sz = lz / ll;
    const lean = (rand() - 0.5) * 0.35 * top;
    mainPts[0] = x - sx * lean;
    mainPts[1] = top;
    mainPts[2] = z - sz * lean;
    mainPts[(MAIN_PTS - 1) * 3] = x;
    mainPts[(MAIN_PTS - 1) * 3 + 1] = 0;
    mainPts[(MAIN_PTS - 1) * 3 + 2] = z;
    displace(mainPts, 0, MAIN_PTS - 1, top * 0.22, sx, sz, rand);
    for (let b = 0; b < BRANCHES; b++) {
      const from = 12 + Math.floor(rand() * 28);
      const o = b * BRANCH_PTS * 3;
      branchPts[o] = mainPts[from * 3];
      branchPts[o + 1] = mainPts[from * 3 + 1];
      branchPts[o + 2] = mainPts[from * 3 + 2];
      const len = top * (0.25 + 0.2 * rand());
      const side = rand() < 0.5 ? -1 : 1;
      const e = o + (BRANCH_PTS - 1) * 3;
      branchPts[e] = branchPts[o] + sx * side * len * 0.6;
      branchPts[e + 1] = Math.max(20, branchPts[o + 1] - len);
      branchPts[e + 2] = branchPts[o + 2] + sz * side * len * 0.6;
      const sub = branchPts.subarray(o, o + BRANCH_PTS * 3);
      displace(sub, 0, BRANCH_PTS - 1, len * 0.18, sx, sz, rand);
    }
    const d = Math.hypot(x - cam.x, cam.y, z - cam.z);
    const core = d * 0.0016;
    let q = ribbon(mainPts, 0, MAIN_PTS, 0, core, cam);
    for (let b = 0; b < BRANCHES; b++) q = ribbon(branchPts, b * BRANCH_PTS, BRANCH_PTS, q, core * 0.6, cam);
    q = ribbon(mainPts, 0, MAIN_PTS, q, core * 5, cam);
    for (let b = 0; b < BRANCHES; b++) q = ribbon(branchPts, b * BRANCH_PTS, BRANCH_PTS, q, core * 3, cam);
    boltPosAttr.needsUpdate = true;
    boltGeo.setDrawRange(0, q * 6);
    st.strikes++;
    st.strikeX = x;
    st.strikeZ = z;
    st.strikeDist = d;
  }

  // ----- sunbeams: four soft cones along the sun direction as the clouds break -----
  const BEAMS = 4;
  const SIDES = 14;
  const beamLocal: number[] = [];
  const beamId: number[] = [];
  const beamIndex: number[] = [];
  for (let b = 0; b < BEAMS; b++) {
    const base = beamLocal.length / 3;
    for (let s = 0; s <= SIDES; s++) {
      const a = (s / SIDES) * Math.PI * 2;
      for (const h of [0, 1]) {
        beamLocal.push(Math.cos(a), Math.sin(a), h);
        beamId.push(b);
      }
    }
    for (let s = 0; s < SIDES; s++) {
      const i = base + s * 2;
      beamIndex.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('aLocal', new THREE.Float32BufferAttribute(beamLocal, 3));
  beamGeo.setAttribute('aBeam', new THREE.Float32BufferAttribute(beamId, 1));
  beamGeo.setIndex(beamIndex);
  // Nothing to draw until a clearing places the beams.
  beamGeo.setDrawRange(0, 0);
  const beamData = Array.from({ length: BEAMS }, () => new THREE.Vector4());
  const beamUniforms = { uBeams: { value: beamData }, uSunDir: u.uSunDir, uSunColor: u.uSunColor, uCamPos: u.uCamPos, uBeamAmt: { value: 0 } };
  const beams = new THREE.Mesh(
    beamGeo,
    new THREE.ShaderMaterial({
      uniforms: beamUniforms,
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Front faces only: the near side of each shaft, once. Both sides would double its light.
    }),
  );
  beams.frustumCulled = false;
  beams.renderOrder = 7;
  scene.add(beams);

  function placeBeams(f: FrameCtx): void {
    for (let b = 0; b < BEAMS; b++) {
      const a = rand() * Math.PI * 2;
      const r = 250 + rand() * 350;
      beamData[b].set(f.cam.target.x + Math.cos(a) * r, f.cam.target.z + Math.sin(a) * r, 25 + rand() * 35, 0.6 + 0.4 * rand());
    }
    beamGeo.setDrawRange(0, Infinity);
  }

  let lastPhase: StormState['phase'] = 'none';
  let sinceClear = -1;
  let sinceStrike = 99;
  let strikeTimer = nextStrikeDelay(rand);

  return {
    name: 'weather',
    update(f: FrameCtx) {
      const dt = f.dt;
      const s = f.storm;
      stormCurve(s, curve);
      // Smooth everything, so a phase change or a reload never jumps the light.
      const k = 1 - Math.exp(-dt / 1.2);
      st.storm += (curve.storm - st.storm) * k;
      st.gloom += (curve.gloom - st.gloom) * k;
      st.amber += (curve.amber - st.amber) * k;
      st.rain += (curve.rain - st.rain) * k;
      st.wind += (curve.wind - st.wind) * k;
      st.beams += (curve.beams - st.beams) * (1 - Math.exp(-dt / 3));
      // Wet ground: soaks up quickly, dries slowly.
      st.wet += (st.rain - st.wet) * (1 - Math.exp(-dt / (st.rain > st.wet ? 6 : 75)));

      if (s.phase === 'clearing' && lastPhase !== 'clearing') {
        sinceClear = s.t;
        placeBeams(f);
      } else if (sinceClear >= 0) {
        sinceClear += dt;
        if (sinceClear > 70) sinceClear = -1;
      }
      if (s.phase === 'warning' || s.phase === 'peak') sinceClear = -1;
      lastPhase = s.phase;
      st.rainbow = sinceClear >= 0 ? rainbowAt(sinceClear) : 0;

      // Wind: the east trade wind, veering a little, gusting more in storms.
      st.gust = gustAt(f.t, st.storm);
      const veer = windVeer(f.t, st.storm);
      const c = Math.cos(veer);
      const sn = Math.sin(veer);
      st.windX = WIND_TO_X * c - WIND_TO_Z * sn;
      st.windZ = WIND_TO_X * sn + WIND_TO_Z * c;
      st.driftX = (st.driftX + st.windX * (6 + 10 * st.wind) * dt) % DECK_PERIOD;
      st.driftZ = (st.driftZ + st.windZ * (6 + 10 * st.wind) * dt) % DECK_PERIOD;

      u.uStorm.value = st.storm;
      u.uRain.value = st.rain;
      u.uWet.value = st.wet;
      u.uWind.value.set(st.windX * st.wind, st.windZ * st.wind, st.gust, st.storm);

      // Lightning: only at the peak, never more often than every 6 s.
      sinceStrike += dt;
      if (curve.lightning) {
        strikeTimer -= dt;
        if (strikeTimer <= 0) {
          strikeTimer = nextStrikeDelay(rand);
          sinceStrike = 0;
          strike(f);
        }
      } else {
        strikeTimer = Math.max(strikeTimer, 3);
      }
      const b = boltAt(sinceStrike, prefs.fewerFlashes);
      bolt.visible = b > 0 || firstFrame;
      boltUniforms.uBolt.value = b;
      st.flash = prefs.fewerFlashes ? 0 : flashAt(sinceStrike);

      // Rain streaks: more drops as it rains harder. The drops' motion is integrated here, so
      // they move at real speeds however the wind changes and however long the game has run.
      const drops = Math.round(rainMax * clamp(st.rain * 1.1, 0, 1));
      advanceRain(motion, st.windX, st.windZ, st.wind, st.gust, dt, drops > 0);
      rain.visible = drops > 0 || firstFrame;
      rainGeo.instanceCount = drops;
      rainUniforms.uRainDrift.value.set(motion.driftX, motion.driftZ);
      rainUniforms.uRainVel.value.set(motion.velX, motion.velZ);
      rainUniforms.uRainFall.value = motion.fall;
      rainBoxWeights(f.cam.dist, rainUniforms.uRainShow.value);
      rainUniforms.uRainAmt.value = st.rain;

      const beamAmt = st.beams * (1 - u.uNight.value);
      beams.visible = beamAmt > 0.01 || firstFrame;
      beamUniforms.uBeamAmt.value = beamAmt;
      firstFrame = false;
    },
    dispose() {
      scene.remove(rain, bolt, beams);
      rainGeo.dispose();
      boltGeo.dispose();
      beamGeo.dispose();
      (rain.material as THREE.Material).dispose();
      (bolt.material as THREE.Material).dispose();
      (beams.material as THREE.Material).dispose();
    },
  };
}
