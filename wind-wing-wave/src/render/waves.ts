/**
 * The sea surface as a function: the same Gerstner swell the ocean shader draws, so floating
 * things (coconuts, rafts, birds resting on the water) ride the visible waves.
 *
 * One set of numbers drives both sides:
 *   - seaHeight() here, on the CPU, for anything that floats;
 *   - swellGLSL(), which writes the very same constants and formulas into the ocean shader.
 * tests/ocean.test.ts reads the constants back out of the generated GLSL to prove they match.
 *
 * The swell is a small set of wave trains rolling in from the east (the trade-wind side),
 * sized for a 1 km sea: 16-61 m long and a few tens of centimetres high, three times higher
 * at the peak of a storm. Near land the depth (from the height map) shapes them:
 *   - in a few metres of water they grow and their crests sharpen (shoaling), so waves
 *     visibly steepen onto beaches;
 *   - in the last metre or two they die away, so a brand-new island is never swamped;
 *   - right at the waterline a gentle swash lifts and drops the water, so the sea laps
 *     up and down every beach.
 *
 * Time: the shader only sees time wrapped to an hour (shared.ts wrapTime). Every period
 * here divides 3600 s exactly, so the sea never jumps when the clock wraps.
 *
 * Detail: the ocean's grid is fine around the camera's target and coarse toward the horizon,
 * and a wave train is faded out wherever the grid is too coarse to draw it without shimmering.
 * The grid's shape lives here too, and the ocean reports where it put the grid each frame
 * (setSeaGrid), so seaHeight fades exactly the same trains: a raft far out on a sea drawn
 * smooth sits still, instead of bobbing over waves nobody can see.
 */
import { SEA_LEVEL } from '../config';
import { wrapTime } from './shared';

/** Shader time wraps at this period (see wrapTime). Every wave and swash period divides it. */
export const SEA_TIME_WRAP = 3600;
const G = 9.81;

/** One train of swell. */
export interface SwellTrain {
  /** Unit direction of travel (x, z). */
  readonly dx: number;
  readonly dz: number;
  /** Height of the crest above still water in open, calm sea (m). */
  readonly amp: number;
  /** Period (s); divides SEA_TIME_WRAP. */
  readonly period: number;
  /** Wavelength from deep-water dispersion, L = g T^2 / 2 pi (m). */
  readonly length: number;
  /** Wavenumber 2 pi / L (1/m). */
  readonly k: number;
  /** Angular frequency 2 pi / T (1/s). */
  readonly omega: number;
  /** Crest sharpening in open water (horizontal sway as a fraction of the height). */
  readonly steep: number;
  /** Phase offset (radians), so the trains don't all crest together at the origin. */
  readonly phase: number;
  /**
   * Along-crest variation: crests rise and fall by CREST_VAR over a few wavelengths sideways,
   * so the sea is made of short crests rather than endless straight ridges.
   */
  readonly crestK: number;
  readonly crestPhase: number;
}

function train(dirX: number, dirZ: number, amp: number, period: number, steep: number, phase: number): SwellTrain {
  const l = Math.hypot(dirX, dirZ);
  const length = (G * period * period) / (2 * Math.PI);
  const k = (2 * Math.PI) / length;
  return { dx: dirX / l, dz: dirZ / l, amp, period, length, k, omega: (2 * Math.PI) / period, steep, phase, crestK: k / 3.7, crestPhase: phase * 2.3 + 0.7 };
}

/**
 * The swell, rolling in from the east (travelling toward -x) with a little spread.
 * Periods 6.25, 4.5, 3.6 and 3.2 s give wavelengths of about 61, 32, 20 and 16 m.
 */
export const SWELL: readonly SwellTrain[] = [
  train(-1, 0.12, 0.24, 6.25, 1.0, 0.0),
  train(-0.92, -0.38, 0.14, 4.5, 1.0, 1.7),
  train(-0.9, 0.44, 0.08, 3.6, 0.9, 4.1),
  train(-0.72, -0.69, 0.045, 3.2, 0.8, 2.6),
];

/** How much each crest's height varies along its length (fraction). */
export const CREST_VAR = 0.35;

/** Sum of the open-water heights (the tallest crest possible when every train lines up). */
export const SWELL_SUM = SWELL.reduce((s, w) => s + w.amp, 0) * (1 + CREST_VAR);

/** Swell height x (1 + STORM_GAIN * storm). */
export const STORM_GAIN = 2;
/** Shoaling: waves grow by up to SHOAL_GAIN as the depth falls from SHOAL_D1 to SHOAL_D0 metres. */
export const SHOAL_GAIN = 0.6;
export const SHOAL_D0 = 2;
export const SHOAL_D1 = 14;
/** Damping: waves fade to nothing between DAMP_D (+ DAMP_STORM * storm) metres and the waterline. */
export const DAMP_D = 2.5;
export const DAMP_STORM = 3;
/** Crests sharpen by up to STEEP_GAIN between STEEP_D1 and STEEP_D0 metres of water. */
export const STEEP_GAIN = 2.5;
export const STEEP_D0 = 1;
export const STEEP_D1 = 10;
/** Crest sharpening is capped so the trains together never fold the surface over (sum of Q k A <= Q_MAX). */
export const Q_MAX = 0.9;
/** Swash at the waterline: height (m), extra height in a storm, the depth band it fades over, and its period (s). */
export const SWASH_AMP = 0.12;
export const SWASH_STORM = 0.33;
export const SWASH_D0 = 0.3;
export const SWASH_D1 = 2;
export const SWASH_PERIOD = 6.25;
export const SWASH_OMEGA = (2 * Math.PI) / SWASH_PERIOD;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ---------- the sea grid's level of detail ----------

/** Evenly spaced grid steps each side of the sea grid's centre; beyond them each step grows by the grid's ratio. */
export const SEA_GRID_EVEN = 20;
/** A train fades out as the grid spacing grows from TRAIN_FADE0 to TRAIN_FADE1 of its wavelength. */
export const TRAIN_FADE0 = 0.2;
export const TRAIN_FADE1 = 0.4;
/** The swash fades out as the grid spacing grows from SWASH_FADE0 to SWASH_FADE1 metres. */
export const SWASH_FADE0 = 3;
export const SWASH_FADE1 = 8;

/** World offset of grid index i from the grid's centre (the CPU twin of ww_gridOffset). */
export function gridOffset(i: number, step: number, ratio: number): number {
  const a = Math.abs(i);
  const o = a <= SEA_GRID_EVEN ? step * a : step * (SEA_GRID_EVEN + (Math.pow(ratio, a - SEA_GRID_EVEN) - 1) / (ratio - 1));
  return Math.sign(i) * o;
}

/**
 * Grid spacing at a distance `o` (m) from the grid's centre along one axis. At every vertex it
 * equals the shader's ww_gridStep for that vertex (step x ratio^(index - SEA_GRID_EVEN)), and it
 * runs smoothly in between.
 */
export function gridStepAt(o: number, step: number, ratio: number): number {
  const a = Math.abs(o);
  return a <= step * SEA_GRID_EVEN ? step : step + (a - step * SEA_GRID_EVEN) * (ratio - 1);
}

/** Where the ocean drew its grid this frame: centre, centre step and growth ratio (step 0 = full detail everywhere). */
const seaGrid = { cx: 0, cz: 0, step: 0, ratio: 1 };

/**
 * The ocean calls this each frame with where it put its grid, so seaHeight drops the same wave
 * trains the grid can't carry. Pass step 0 to get the full-detail sea everywhere (the default).
 */
export function setSeaGrid(cx: number, cz: number, step: number, ratio: number): void {
  seaGrid.cx = cx;
  seaGrid.cz = cz;
  seaGrid.step = step;
  seaGrid.ratio = ratio;
}

/** The sea grid's vertex spacing at a world point (0 when no grid has been reported). */
export function seaGridSpacing(x: number, z: number): number {
  const g = seaGrid;
  if (g.step <= 0) return 0;
  return Math.max(gridStepAt(x - g.cx, g.step, g.ratio), gridStepAt(z - g.cz, g.step, g.ratio));
}

/** How much of a train the grid draws at this vertex spacing (1 all of it, 0 none). */
function trainFade(w: SwellTrain, spacing: number): number {
  return 1 - smoothstep(w.length * TRAIN_FADE0, w.length * TRAIN_FADE1, spacing);
}

/** How much of the swash the grid draws at this vertex spacing. */
function swashFade(spacing: number): number {
  return 1 - smoothstep(SWASH_FADE0, SWASH_FADE1, spacing);
}

/** How much of the open-sea swell is left at a given storm level and water depth (m, >= 0). */
export function swellAmpScale(storm: number, depth: number): number {
  const shoal = 1 + SHOAL_GAIN * (1 - smoothstep(SHOAL_D0, SHOAL_D1, depth));
  const damp = smoothstep(0, DAMP_D + DAMP_STORM * storm, depth);
  return (1 + STORM_GAIN * storm) * shoal * damp;
}

/** How much sharper the crests are at a given depth (1 in deep water). */
export function swellSteepScale(depth: number): number {
  return 1 + STEEP_GAIN * (1 - smoothstep(STEEP_D0, STEEP_D1, depth));
}

/** Slow along-shore phase drift, so neighbouring beaches don't lap in lockstep. */
function swashPhase(x: number, z: number): number {
  return 0.9 * Math.sin(x * 0.031 + z * 0.017) + 0.7 * Math.sin(z * 0.043 - x * 0.011);
}

/** Swash lift (m) at the waterline: the sea running up and down the beach. tw is wrapped time. */
export function swashLift(x: number, z: number, tw: number, storm: number, depth: number): number {
  const band = 1 - smoothstep(SWASH_D0, SWASH_D1, depth);
  if (band <= 0) return 0;
  const th = SWASH_OMEGA * tw + swashPhase(x, z);
  return band * (SWASH_AMP + SWASH_STORM * storm) * (0.35 + 0.65 * Math.sin(th));
}

/**
 * Offset of the swell surface for the undisturbed point (px, pz): out[0..2] = dx, dy, dz.
 * tw is wrapped time; amp and steepK come from swellAmpScale and swellSteepScale; spacing is
 * the sea grid's vertex spacing there (0 for full detail).
 */
export function swellOffset(px: number, pz: number, tw: number, amp: number, steepK: number, spacing: number, out: Float64Array): void {
  let ox = 0;
  let oy = 0;
  let oz = 0;
  const n = SWELL.length;
  for (let i = 0; i < n; i++) {
    const w = SWELL[i];
    const a = trainFade(w, spacing) * w.amp * amp * (1 + CREST_VAR * Math.sin(w.crestK * (w.dx * pz - w.dz * px) + w.crestPhase));
    if (a <= 0) continue;
    const ph = w.k * (w.dx * px + w.dz * pz) - w.omega * tw + w.phase;
    const c = Math.cos(ph);
    const q = Math.min(w.steep * steepK, Q_MAX / (n * w.k * a + 1e-6));
    ox += q * a * w.dx * c;
    oz += q * a * w.dz * c;
    oy += a * Math.sin(ph);
  }
  out[0] = ox;
  out[1] = oy;
  out[2] = oz;
}

const scratch = new Float64Array(3);
/** Fixed-point steps used to find which undisturbed point the swell carried to (x, z). */
const INVERT_STEPS = 6;

/**
 * Water surface height at world (x, z) and time t (seconds, unwrapped), for storm level 0..1
 * and local water depth (m, positive; small depths damp the swell): exactly the surface the
 * ocean draws, including the trains its grid fades out far from the camera's target.
 *
 * Gerstner waves move the water sideways as well as up and down, so the surface above a
 * point belongs to a neighbouring undisturbed point. A few fixed-point steps find it (the
 * sideways sway is capped well under one, so this always converges), and the height there
 * is what the shader computes at that grid point.
 */
export function seaHeight(x: number, z: number, t: number, storm: number, depth: number): number {
  const tw = wrapTime(t);
  const d = Math.max(0, depth);
  const amp = swellAmpScale(storm, d);
  const steepK = swellSteepScale(d);
  let px = x;
  let pz = z;
  if (amp > 0) {
    for (let it = 0; it < INVERT_STEPS; it++) {
      swellOffset(px, pz, tw, amp, steepK, seaGridSpacing(px, pz), scratch);
      px = x - scratch[0];
      pz = z - scratch[2];
    }
    swellOffset(px, pz, tw, amp, steepK, seaGridSpacing(px, pz), scratch);
  } else {
    scratch[1] = 0;
  }
  return SEA_LEVEL + scratch[1] + swashLift(px, pz, tw, storm, d) * swashFade(seaGridSpacing(px, pz));
}

/** A GLSL float literal that reads back to the same number. */
function f(v: number): string {
  const s = Number.isInteger(v) ? v.toFixed(1) : String(v);
  return s.includes('e') ? v.toFixed(12) : s;
}

/**
 * GLSL for the same swell (generated from the constants above, so they can't drift apart):
 *   float ww_swellAmp(float storm, float depth)
 *   float ww_swellSteep(float depth)
 *   float ww_swashPhase(vec2 p), ww_swash(vec2 p, float t, float storm, float depth, float spacing)
 *   vec3  ww_swell(vec2 p, float t, float amp, float steepK, float spacing)        vertex offset
 *   vec3  ww_swellNormal(vec2 p, float t, float amp, float steepK, float footprint) surface normal
 * `spacing` is the sea grid's vertex spacing there and `footprint` the metres per pixel: each
 * train fades out where it can't be drawn without shimmering (seaHeight fades the same way).
 */
export function swellGLSL(): string {
  const n = SWELL.length;
  // The shared part of one train: its height (after `fade`), phase and crest sharpening.
  const head = (w: SwellTrain, fade: string): string => `
    A = ${fade} * amp * ${f(w.amp)} * (1.0 + ${f(CREST_VAR)} * sin(${f(w.crestK)} * dot(vec2(${f(-w.dz)}, ${f(w.dx)}), p) + ${f(w.crestPhase)}));
    ph = ${f(w.k)} * dot(vec2(${f(w.dx)}, ${f(w.dz)}), p) - ${f(w.omega)} * t + ${f(w.phase)};
    Q = min(${f(w.steep)} * steepK, ${f(Q_MAX)} / (${f(n)} * ${f(w.k)} * A + 1e-6));`;
  let off = '';
  let nrm = '';
  for (const w of SWELL) {
    off += `
  {${head(w, `(1.0 - smoothstep(${f(w.length * TRAIN_FADE0)}, ${f(w.length * TRAIN_FADE1)}, spacing))`)}
    o.xz += Q * A * vec2(${f(w.dx)}, ${f(w.dz)}) * cos(ph);
    o.y += A * sin(ph);
  }`;
    nrm += `
  {${head(w, `(1.0 - smoothstep(${f(w.length * 0.12)}, ${f(w.length * 0.33)}, footprint))`)}
    float kA = ${f(w.k)} * A;
    nr.xz -= vec2(${f(w.dx)}, ${f(w.dz)}) * kA * cos(ph);
    nr.y -= Q * kA * sin(ph);
  }`;
  }
  return /* glsl */ `
const float WW_SWELL_SUM = ${f(SWELL_SUM)};
float ww_swellAmp(float storm, float depth) {
  float shoal = 1.0 + ${f(SHOAL_GAIN)} * (1.0 - smoothstep(${f(SHOAL_D0)}, ${f(SHOAL_D1)}, depth));
  float damp = smoothstep(0.0, ${f(DAMP_D)} + ${f(DAMP_STORM)} * storm, depth);
  return (1.0 + ${f(STORM_GAIN)} * storm) * shoal * damp;
}
float ww_swellSteep(float depth) {
  return 1.0 + ${f(STEEP_GAIN)} * (1.0 - smoothstep(${f(STEEP_D0)}, ${f(STEEP_D1)}, depth));
}
const float WW_SWASH_OMEGA = ${f(SWASH_OMEGA)};
float ww_swashPhase(vec2 p) {
  return 0.9 * sin(p.x * 0.031 + p.y * 0.017) + 0.7 * sin(p.y * 0.043 - p.x * 0.011);
}
float ww_swash(vec2 p, float t, float storm, float depth, float spacing) {
  float band = (1.0 - smoothstep(${f(SWASH_D0)}, ${f(SWASH_D1)}, depth)) * (1.0 - smoothstep(${f(SWASH_FADE0)}, ${f(SWASH_FADE1)}, spacing));
  float th = WW_SWASH_OMEGA * t + ww_swashPhase(p);
  return band * (${f(SWASH_AMP)} + ${f(SWASH_STORM)} * storm) * (0.35 + 0.65 * sin(th));
}
vec3 ww_swell(vec2 p, float t, float amp, float steepK, float spacing) {
  vec3 o = vec3(0.0);
  float A, ph, Q;${off}
  return o;
}
vec3 ww_swellNormal(vec2 p, float t, float amp, float steepK, float footprint) {
  vec3 nr = vec3(0.0, 1.0, 0.0);
  float A, ph, Q;${nrm}
  return normalize(nr);
}
`;
}
