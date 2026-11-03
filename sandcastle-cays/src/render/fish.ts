/**
 * Five Caribbean fish, modelled and painted in code, in the finds' style
 * (DECISIONS 13 and 14): real shapes and markings, a little rounded and warm.
 *
 *   grunt     blue-striped grunt, 25 cm: yellow with blue stripes, dusky tail
 *   snapper   yellowtail snapper, 35 cm: the yellow stripe along the side into a forked yellow tail
 *   jack      bar jack, 35 cm: silvery, a dark stripe along the back and down into the lower tail lobe
 *   bonefish  45 cm: bright silver, sleek, a pointed snout
 *   mahi      mahi-mahi (dorado), 90 cm: blunt head, a dorsal fin all down the back, green-gold and blue
 *
 * `fishModel(kind)` gives a new Object3D at real size in metres: length along
 * +x with the head at +x, back up (+y), centred on its bounding box. Each is
 * one body mesh (code-painted texture, with the eyes) and one fin mesh
 * (double-sided), so two materials and two draw calls, about 2,000-2,250
 * triangles. Geometry and textures are shared between all fish of a kind;
 * the materials are per fish, so each can `wiggle` on its own. The first
 * fish of a kind takes a few tens of milliseconds to build and paint;
 * `prepareFish()` does it ahead of time.
 *
 * `wiggle(obj, time, amount)` flexes the body and tail from side to side in
 * the vertex shader (no bones): call it every frame with the clock in
 * seconds; amount 0 is still, 1 is a fish thrashing on the line.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  TAU,
  clamp,
  cross,
  fbm,
  fract,
  grid,
  hash,
  lin,
  mix,
  mixC,
  mulC,
  noise,
  norm,
  paintTexture,
  ramp,
  scl,
  smooth,
  srgb,
  steps,
  sub,
  add,
  dot,
  type C3,
  type V3,
} from './finds';

export type FishKind = 'grunt' | 'snapper' | 'jack' | 'bonefish' | 'mahi';
export const FISH_KINDS: FishKind[] = ['grunt', 'snapper', 'jack', 'bonefish', 'mahi'];

/** Total length, snout to tail tips, in metres (the models are built to it). */
export const FISH_LENGTH: Record<FishKind, number> = { grunt: 0.25, snapper: 0.35, jack: 0.35, bonefish: 0.45, mahi: 0.9 };

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

type Pts = [number, number][];

/** Monotone cubic through the points (no overshoot), clamped at the ends. */
function spline(pts: Pts): (s: number) => number {
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (s: number): number => {
    if (s <= xs[0]) return ys[0];
    if (s >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && s > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (s - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** A fast lookup table of f on [0, 1]. */
function lut(f: (s: number) => number, n = 1024): (s: number) => number {
  const a = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) a[i] = f(i / n);
  return (s: number): number => {
    const x = clamp(s, 0, 1) * n;
    const i = Math.min(n - 1, Math.floor(x));
    return a[i] + (a[i + 1] - a[i]) * (x - i);
  };
}

interface MedianFin {
  /** Where along the body the fin's base runs (0 = snout, 1 = tail base). */
  s0: number;
  s1: number;
  /** Height along the base (u from front to back), in body lengths. */
  h: Pts;
  /** How far the rays lean back, at the front and at the back of the fin. */
  rake: [number, number];
  /** Spines with notches between them, over the front part of the fin. */
  spines?: { until: number; n: number; depth: number };
  rays: number;
  col: (u: number, v: number) => C3;
}

interface PairedFin {
  s: number;
  /** Base, as heights on the side (sin of the angle round the body) at its two ends. */
  y0: number;
  y1: number;
  /** Fin length along the base (u from y0 to y1), in body lengths. */
  h: Pts;
  /** Direction the fin points: back, down, out. */
  dir: V3;
  rays: number;
  col: (u: number, v: number) => C3;
}

interface Species {
  length: number;
  top: Pts;
  bot: Pts;
  wid: Pts;
  /** The rounded nose cap: its length (body lengths), and 0.5 = round .. 1 = pointed. */
  nose: number;
  noseRound: number;
  /** Narrowing toward the back ridge, and flatness of the sides (1 = oval, smaller = flatter). */
  keel: number;
  flat: number;
  mouth: { y: number; len: number; depth: number };
  eye: { s: number; y: number; r: number; iris: number; ring: number };
  /** Where the gill cover ends. */
  gill: number;
  dorsal: MedianFin[];
  anal: MedianFin[];
  caudal: { lobe: number; fork: number; span: number; rays: number; col: (u: number, v: number) => C3 };
  pectoral: PairedFin;
  pelvic: PairedFin;
  /** Body colour (sRGB) at s along the body, yn = height on the side (-1 belly .. 1 back), side = +1 right / -1 left. */
  paint: (s: number, yn: number, side: number, y: number) => C3;
  /** Metalness on the belly and on the back; roughness. */
  metal: [number, number];
  rough: number;
}

// ---------------------------------------------------------------------------
// The five fish
// ---------------------------------------------------------------------------

/** sRGB colours used by the painters, converted once. */
const S1d252d = srgb(0x1d252d);
const S22609a = srgb(0x22609a);
const S22788e = srgb(0x22788e);
const S2e4a3a = srgb(0x2e4a3a);
const S2f5592 = srgb(0x2f5592);
const S3b2422 = srgb(0x3b2422);
const S3c4646 = srgb(0x3c4646);
const S3c9a92 = srgb(0x3c9a92);
const S3d8ade = srgb(0x3d8ade);
const S3e9a7c = srgb(0x3e9a7c);
const S3f86d8 = srgb(0x3f86d8);
const S485e70 = srgb(0x485e70);
const S55686a = srgb(0x55686a);
const S5c6890 = srgb(0x5c6890);
const S5d7676 = srgb(0x5d7676);
const S5f7688 = srgb(0x5f7688);
const S6aa8dc = srgb(0x6aa8dc);
const S6ab2ee = srgb(0x6ab2ee);
const S7f9696 = srgb(0x7f9696);
const S8e9aa0 = srgb(0x8e9aa0);
const S9cba48 = srgb(0x9cba48);
const S9fb0ba = srgb(0x9fb0ba);
const Sa59fb6 = srgb(0xa59fb6);
const Sb6c4c4 = srgb(0xb6c4c4);
const Sb8382a = srgb(0xb8382a);
const Sc8952a = srgb(0xc8952a);
const Sc8d1d4 = srgb(0xc8d1d4);
const Sd6dddd = srgb(0xd6dddd);
const Sd8c83c = srgb(0xd8c83c);
const Se2e7e6 = srgb(0xe2e7e6);
const Se6c240 = srgb(0xe6c240);
const Se6cf3c = srgb(0xe6cf3c);
const Se6eae8 = srgb(0xe6eae8);
const Se8a81e = srgb(0xe8a81e);
const Seae4ea = srgb(0xeae4ea);
const Seec08a = srgb(0xeec08a);
const Seedb62 = srgb(0xeedb62);
const Sf2bc1a = srgb(0xf2bc1a);
const Sf3eba8 = srgb(0xf3eba8);
const Sf4f5f0 = srgb(0xf4f5f0);
const Sf6b81c = srgb(0xf6b81c);
const Sf6f1ec = srgb(0xf6f1ec);
const Sf7d23c = srgb(0xf7d23c);
const Sf8e290 = srgb(0xf8e290);
const Sfac832 = srgb(0xfac832);

/** A gradient between linear colours over v, the fin's base to its edge. */
const finGrad = (base: number, edge: number, k = 1): ((u: number, v: number) => C3) => {
  const a = lin(base);
  const b = lin(edge);
  return (_u, v) => mixC(a, b, Math.pow(clamp(v, 0, 1), k));
};

/** Soft spots scattered on a jittered grid: returns 0..1 coverage. */
function spots(a: number, b: number, seed: number, r0: number, r1: number, keep = 1): number {
  const ia = Math.floor(a);
  const ib = Math.floor(b);
  let best = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ci = ia + i;
      const cj = ib + j;
      if (hash(ci, cj, seed + 3) > keep) continue;
      const cx = ci + 0.2 + 0.6 * hash(ci, cj, seed);
      const cy = cj + 0.2 + 0.6 * hash(ci, cj, seed + 1);
      const r = mix(r0, r1, hash(ci, cj, seed + 2));
      best = Math.max(best, smooth(r, r * 0.6, Math.hypot(a - cx, b - cy)));
    }
  }
  return best;
}

/** Faint overlapping scales: 0 inside a scale, up to 1 on its rear edge. */
function scaleEdge(s: number, y: number, size: number): number {
  const a = s / size;
  const b = y / (size * 0.75);
  const row = Math.floor(b);
  const off = (row & 1) * 0.5;
  const fa = fract(a + off);
  const fb = fract(b) - 0.5;
  return smooth(0.22, 0.42, Math.hypot(fa - 0.15, fb * 1.25) * (fa > 0.15 ? 1 : 0.6));
}

/** Shading every fish shares: gill cover edge, mouth line, faint scales, a darker snout tip. */
function common(c: C3, s: number, yn: number, y: number, sp: Species, scale = 0.035): C3 {
  let col = mulC(c, 1 - 0.07 * scaleEdge(s, y, scale) * smooth(sp.gill - 0.02, sp.gill + 0.06, s));
  // the gill cover: a soft darker crescent with a lighter rim just in front
  const gl = sp.gill - 0.035 * (1 - yn * yn);
  const dg = s - gl;
  const onSide = smooth(-0.95, -0.75, yn) * smooth(0.95, 0.75, yn);
  col = mulC(col, 1 - 0.14 * smooth(0.014, 0.0, Math.abs(dg)) * onSide);
  col = mulC(col, 1 + 0.07 * smooth(-0.04, -0.012, dg) * smooth(0.0, -0.012, dg) * onSide);
  // the mouth line
  const m = sp.mouth;
  col = mixC(col, S3b2422, smooth(0.05, 0.015, Math.abs(yn - m.y)) * smooth(m.len, m.len * 0.6, s) * 0.85);
  return col;
}

const GRUNT: Species = {
  length: 0.25,
  top: [[0, 0.035], [0.06, 0.08], [0.15, 0.14], [0.28, 0.2], [0.42, 0.215], [0.55, 0.2], [0.7, 0.14], [0.84, 0.085], [0.94, 0.064], [1, 0.06]],
  bot: [[0, 0.026], [0.06, 0.052], [0.15, 0.1], [0.3, 0.15], [0.45, 0.165], [0.6, 0.15], [0.72, 0.105], [0.84, 0.068], [0.94, 0.055], [1, 0.053]],
  wid: [[0, 0.03], [0.08, 0.05], [0.25, 0.075], [0.45, 0.075], [0.65, 0.055], [0.85, 0.032], [1, 0.022]],
  nose: 0.05,
  noseRound: 0.55,
  keel: 0.35,
  flat: 0.8,
  mouth: { y: -0.08, len: 0.085, depth: 0.25 },
  eye: { s: 0.105, y: 0.38, r: 0.042, iris: 0x2b2620, ring: 0xd9b23a },
  gill: 0.27,
  dorsal: [
    {
      s0: 0.3,
      s1: 0.87,
      h: [[0, 0.03], [0.08, 0.14], [0.25, 0.12], [0.5, 0.07], [0.56, 0.062], [0.63, 0.1], [0.82, 0.086], [0.95, 0.05], [1, 0.012]],
      rake: [0.45, 0.85],
      spines: { until: 0.55, n: 12, depth: 0.28 },
      rays: 24,
      col: (u, v) => mixC(mixC(lin(0xd8b032), lin(0x8f8250), v * 0.7), mixC(lin(0xa89038), lin(0x2c2b28), smooth(0.2, 0.9, v)), smooth(0.5, 0.62, u)),
    },
  ],
  anal: [{ s0: 0.68, s1: 0.86, h: [[0, 0.03], [0.15, 0.11], [0.5, 0.095], [0.9, 0.05], [1, 0.012]], rake: [0.6, 0.95], spines: { until: 0.25, n: 3, depth: 0.2 }, rays: 10, col: finGrad(0xe8b62e, 0xf0cf62) }],
  caudal: { lobe: 0.3, fork: 0.17, span: 0.21, rays: 17, col: (u, v) => mixC(lin(0x9c8a3c), lin(0x2a2a27), smooth(0.05, 0.7, v) * (0.85 + 0.15 * Math.abs(2 * u - 1))) },
  pectoral: { s: 0.29, y0: -0.4, y1: -0.12, h: [[0, 0.07], [0.5, 0.17], [0.85, 0.19], [1, 0.15]], dir: [-1, -0.2, 0.2], rays: 14, col: finGrad(0xd8b03c, 0xe2c870) },
  pelvic: { s: 0.33, y0: -0.97, y1: -0.84, h: [[0, 0.12], [1, 0.1]], dir: [-1, -0.55, 0.3], rays: 6, col: finGrad(0xeab734, 0xf1cd5a) },
  paint: (s, yn, side, y) => {
    let col = ramp([Sf8e290, Sfac832, Sf6b81c, Se8a81e, Sc8952a], 0.5 + 0.5 * yn);
    // Blue stripes following the body; more of them, and wavier, on the head.
    const head = smooth(0.3, 0.1, s);
    const q = yn * (3.7 + 2.0 * head) + 0.3 * Math.sin(s * 11 + yn * 2 + side) * head + 0.15 * s + 0.12;
    const f = fract(q);
    const on = smooth(-0.94, -0.78, yn) * smooth(0.98, 0.88, yn) * smooth(1.0, 0.92, s);
    col = mixC(col, S2f5592, smooth(0.22, 0.28, f) * smooth(0.6, 0.54, f) * on * 0.45);
    col = mixC(col, mixC(S3d8ade, S6ab2ee, 0.5 + 0.4 * yn), smooth(0.27, 0.32, f) * smooth(0.55, 0.5, f) * on);
    col = common(col, s, yn, y, GRUNT, 0.03);
    // red at the corner of the mouth
    return mixC(col, Sb8382a, smooth(0.08, 0.03, Math.abs(yn - GRUNT.mouth.y)) * smooth(0.06, 0.075, s) * smooth(0.095, 0.08, s) * 0.8);
  },
  metal: [0.06, 0.04],
  rough: 0.36,
};

const SNAPPER: Species = {
  length: 0.35,
  top: [[0, 0.028], [0.06, 0.06], [0.16, 0.105], [0.3, 0.14], [0.45, 0.15], [0.6, 0.135], [0.75, 0.095], [0.88, 0.062], [1, 0.047]],
  bot: [[0, 0.022], [0.06, 0.045], [0.16, 0.085], [0.32, 0.115], [0.48, 0.12], [0.62, 0.105], [0.76, 0.072], [0.9, 0.05], [1, 0.043]],
  wid: [[0, 0.025], [0.1, 0.045], [0.3, 0.065], [0.5, 0.062], [0.75, 0.04], [1, 0.02]],
  nose: 0.045,
  noseRound: 0.6,
  keel: 0.3,
  flat: 0.85,
  mouth: { y: -0.1, len: 0.085, depth: 0.25 },
  eye: { s: 0.105, y: 0.32, r: 0.045, iris: 0xa82a22, ring: 0xe0a040 },
  gill: 0.26,
  dorsal: [
    {
      s0: 0.3,
      s1: 0.8,
      h: [[0, 0.025], [0.08, 0.095], [0.3, 0.085], [0.52, 0.06], [0.6, 0.075], [0.85, 0.06], [1, 0.01]],
      rake: [0.5, 0.9],
      spines: { until: 0.55, n: 10, depth: 0.22 },
      rays: 22,
      col: finGrad(0xc9b05a, 0xeed266),
    },
  ],
  anal: [{ s0: 0.66, s1: 0.8, h: [[0, 0.02], [0.2, 0.085], [0.7, 0.07], [1, 0.012]], rake: [0.6, 1.0], rays: 9, col: finGrad(0xf0e2b8, 0xf4dc7a) }],
  caudal: { lobe: 0.45, fork: 0.14, span: 0.27, rays: 17, col: (_u, v) => mixC(lin(0xf0c022), lin(0xf6d23a), v) },
  pectoral: { s: 0.28, y0: -0.38, y1: -0.12, h: [[0, 0.07], [0.5, 0.16], [0.85, 0.18], [1, 0.14]], dir: [-1, -0.15, 0.2], rays: 14, col: finGrad(0xc8a8a8, 0xdcc4bc) },
  pelvic: { s: 0.32, y0: -0.97, y1: -0.84, h: [[0, 0.1], [1, 0.085]], dir: [-1, -0.55, 0.3], rays: 6, col: finGrad(0xf2ead8, 0xf4e6c0) },
  paint: (s, yn, side, y) => {
    const mid = -0.12 + 0.14 * s;
    const hw = 0.05 + 0.3 * Math.pow(s, 2.4);
    const stripe = smooth(hw + 0.05, hw - 0.01, Math.abs(yn - mid));
    let col: C3;
    if (yn > mid) {
      col = mixC(Sa59fb6, S5c6890, smooth(mid + 0.1, 0.95, yn));
      // yellow spots and blotches on the back
      const sp = spots(s * 30, yn * 7, side > 0 ? 11 : 17, 0.22, 0.34, 0.85) * smooth(mid + 0.15, mid + 0.3, yn) * smooth(0.18, 0.3, s);
      col = mixC(col, Se6c240, sp * 0.85);
    } else {
      col = mixC(Seae4ea, Sf6f1ec, smooth(mid - 0.1, -0.9, yn));
      // thin pinkish-yellow lines along the lower side
      const f = fract((yn - mid) * 7);
      col = mixC(col, Seec08a, smooth(0.14, 0.0, Math.abs(f - 0.5)) * smooth(mid - 0.1, mid - 0.25, yn) * smooth(-0.9, -0.6, yn) * 0.5);
    }
    col = mixC(col, mixC(Sf2bc1a, Sf7d23c, stripe), stripe);
    return common(col, s, yn, y, SNAPPER, 0.03);
  },
  metal: [0.18, 0.06],
  rough: 0.34,
};

const JACK: Species = {
  length: 0.35,
  top: [[0, 0.03], [0.06, 0.068], [0.18, 0.128], [0.33, 0.152], [0.45, 0.15], [0.6, 0.12], [0.75, 0.075], [0.88, 0.04], [1, 0.032]],
  bot: [[0, 0.024], [0.06, 0.052], [0.18, 0.1], [0.35, 0.13], [0.5, 0.125], [0.65, 0.095], [0.8, 0.055], [0.92, 0.035], [1, 0.03]],
  wid: [[0, 0.025], [0.1, 0.045], [0.3, 0.06], [0.5, 0.055], [0.8, 0.03], [1, 0.022]],
  nose: 0.045,
  noseRound: 0.65,
  keel: 0.32,
  flat: 0.82,
  mouth: { y: -0.12, len: 0.08, depth: 0.25 },
  eye: { s: 0.11, y: 0.3, r: 0.05, iris: 0xc8c2a0, ring: 0x8a8a7a },
  gill: 0.27,
  dorsal: [
    { s0: 0.32, s1: 0.44, h: [[0, 0.03], [0.2, 0.095], [0.6, 0.08], [1, 0.02]], rake: [0.45, 0.7], spines: { until: 1, n: 7, depth: 0.25 }, rays: 7, col: finGrad(0x56636c, 0x8a969c) },
    { s0: 0.47, s1: 0.89, h: [[0, 0.03], [0.05, 0.115], [0.2, 0.06], [0.5, 0.045], [0.9, 0.035], [1, 0.012]], rake: [0.7, 1.1], rays: 26, col: finGrad(0x3a4650, 0x8c979d) },
  ],
  anal: [{ s0: 0.6, s1: 0.89, h: [[0, 0.03], [0.07, 0.095], [0.25, 0.05], [0.9, 0.035], [1, 0.012]], rake: [0.7, 1.1], rays: 20, col: finGrad(0xc2c8c8, 0xdadedc) }],
  caudal: {
    lobe: 0.46,
    fork: 0.1,
    span: 0.3,
    rays: 17,
    // the dark stripe from the back runs on into the lower lobe
    col: (u, v) => mixC(mixC(lin(0x7f8a90), lin(0xa5adb0), v), mixC(lin(0x1c242c), lin(0x2c343a), v), smooth(0.5, 0.36, u)),
  },
  pectoral: { s: 0.28, y0: -0.3, y1: -0.05, h: [[0, 0.06], [0.5, 0.16], [0.9, 0.29], [1, 0.27]], dir: [-1, -0.22, 0.18], rays: 16, col: finGrad(0x9aa6ac, 0xc0c8cc) },
  pelvic: { s: 0.32, y0: -0.97, y1: -0.85, h: [[0, 0.08], [1, 0.07]], dir: [-1, -0.55, 0.3], rays: 6, col: finGrad(0xe8ece8, 0xf2f2ee) },
  paint: (s, yn, _side, y) => {
    let col = ramp([Sf4f5f0, Se2e7e6, Sc8d1d4, S9fb0ba, S5f7688, S485e70], 0.5 + 0.5 * yn);
    // The dark stripe along the base of the soft dorsal fin, then down across the tail stalk to the lower lobe.
    const k = smooth(0.84, 1.0, s);
    const yc = mix(0.92, -0.6, k);
    const w = 0.09 + 0.22 * k;
    const on = smooth(0.42, 0.5, s);
    const d = Math.abs(yn - yc);
    col = mixC(col, S6aa8dc, on * smooth(0.06, 0.0, Math.abs(yn - (yc - w - 0.05))) * 0.5 * smooth(0.9, 0.78, s));
    col = mixC(col, S1d252d, on * smooth(w + 0.05, w - 0.02, d));
    // the lateral line, arched in front, with a row of small bony scutes near the tail
    const ll = 0.45 + 0.25 * smooth(0.6, 0.3, s) - 0.3 * smooth(0.6, 0.85, s);
    col = mulC(col, 1 - 0.12 * smooth(0.025, 0.0, Math.abs(yn - ll)) * smooth(0.28, 0.32, s));
    const scute = smooth(0.66, 0.7, s) * smooth(0.06, 0.02, Math.abs(yn - ll)) * (0.5 + 0.5 * Math.cos(s * TAU * 60));
    col = mixC(col, S8e9aa0, scute * 0.5);
    return common(col, s, yn, y, JACK, 0.028);
  },
  metal: [0.6, 0.35],
  rough: 0.28,
};

const BONEFISH: Species = {
  length: 0.45,
  top: [[0, 0.022], [0.05, 0.048], [0.15, 0.088], [0.3, 0.112], [0.45, 0.12], [0.6, 0.106], [0.75, 0.08], [0.9, 0.052], [1, 0.044]],
  bot: [[0, 0.012], [0.05, 0.032], [0.15, 0.072], [0.3, 0.097], [0.48, 0.102], [0.65, 0.086], [0.8, 0.06], [0.92, 0.043], [1, 0.04]],
  wid: [[0, 0.018], [0.08, 0.045], [0.3, 0.075], [0.5, 0.072], [0.75, 0.05], [1, 0.026]],
  nose: 0.035,
  noseRound: 0.85,
  keel: 0.12,
  flat: 0.95,
  mouth: { y: -0.5, len: 0.075, depth: 0.15 },
  eye: { s: 0.1, y: 0.28, r: 0.046, iris: 0x2a2c2c, ring: 0xc8ccc4 },
  gill: 0.25,
  dorsal: [{ s0: 0.38, s1: 0.56, h: [[0, 0.04], [0.12, 0.135], [0.35, 0.1], [0.75, 0.05], [1, 0.02]], rake: [0.55, 0.9], rays: 16, col: finGrad(0x6a7c80, 0xa2b0b0) }],
  anal: [{ s0: 0.8, s1: 0.885, h: [[0, 0.03], [0.2, 0.065], [1, 0.02]], rake: [0.6, 0.9], rays: 8, col: finGrad(0xd8dcd8, 0xe8eae6) }],
  caudal: { lobe: 0.38, fork: 0.12, span: 0.24, rays: 17, col: (_u, v) => mixC(lin(0x8f9c9e), lin(0x56646a), smooth(0.4, 1.0, v)) },
  pectoral: { s: 0.27, y0: -0.7, y1: -0.45, h: [[0, 0.07], [0.5, 0.14], [0.85, 0.16], [1, 0.13]], dir: [-1, -0.15, 0.2], rays: 14, col: (u, v) => mixC(lin(0x5a6466), lin(0xbcc4c4), smooth(0.0, 0.5, v) * (0.7 + 0.3 * u)) },
  pelvic: { s: 0.52, y0: -0.97, y1: -0.85, h: [[0, 0.1], [1, 0.09]], dir: [-1, -0.5, 0.3], rays: 8, col: finGrad(0xe4e8e4, 0xf0f2ee) },
  paint: (s, yn, _side, y) => {
    let col = ramp([Sf4f5f0, Se6eae8, Sd6dddd, Sb6c4c4, S7f9696, S5d7676], 0.5 + 0.5 * yn);
    // faint dark streaks between the scale rows on the upper sides
    const q = fract(yn * 7.5 + 0.3 + 0.1 * s);
    col = mixC(col, S55686a, smooth(0.13, 0.0, Math.abs(q - 0.5)) * 0.45 * smooth(0.1, 0.35, yn) * smooth(0.96, 0.84, s) * smooth(0.2, 0.28, s));
    // the dusky tip of the snout
    col = mixC(col, S3c4646, smooth(0.07, 0.01, s) * 0.85);
    return common(col, s, yn, y, BONEFISH, 0.026);
  },
  metal: [0.7, 0.45],
  rough: 0.26,
};

const MAHI: Species = {
  length: 0.9,
  top: [[0, 0.075], [0.02, 0.12], [0.06, 0.15], [0.12, 0.165], [0.22, 0.162], [0.4, 0.142], [0.6, 0.108], [0.78, 0.07], [0.92, 0.042], [1, 0.034]],
  bot: [[0, 0.03], [0.04, 0.06], [0.12, 0.098], [0.25, 0.112], [0.42, 0.103], [0.6, 0.08], [0.78, 0.055], [0.92, 0.036], [1, 0.031]],
  wid: [[0, 0.03], [0.06, 0.055], [0.2, 0.065], [0.45, 0.055], [0.75, 0.035], [1, 0.02]],
  nose: 0.05,
  noseRound: 0.5,
  keel: 0.32,
  flat: 0.85,
  mouth: { y: -0.3, len: 0.075, depth: 0.2 },
  eye: { s: 0.085, y: -0.02, r: 0.03, iris: 0x2e2a1e, ring: 0xc9b04a },
  gill: 0.2,
  dorsal: [
    {
      s0: 0.045,
      s1: 0.955,
      h: [[0, 0.055], [0.05, 0.105], [0.15, 0.1], [0.5, 0.078], [0.85, 0.052], [0.97, 0.03], [1, 0.012]],
      rake: [0.35, 0.8],
      rays: 56,
      col: (u, v) => mixC(mixC(lin(0x1c3a8a), lin(0x2d5fb8), v), lin(0x2a7aa6), smooth(0.7, 1, u) * 0.4),
    },
  ],
  anal: [{ s0: 0.52, s1: 0.955, h: [[0, 0.03], [0.08, 0.065], [0.8, 0.048], [1, 0.012]], rake: [0.5, 0.85], rays: 26, col: (_u, v) => mixC(lin(0xd8c64a), lin(0x6a9a7a), smooth(0.5, 1, v)) }],
  caudal: { lobe: 0.33, fork: 0.08, span: 0.27, rays: 17, col: (u, v) => mixC(mixC(lin(0xa8b83e), lin(0xc9c84a), v * 0.6), lin(0x3e8a8e), smooth(0.75, 1, v) * 0.6 + 0.2 * smooth(0.3, 0.0, Math.abs(u - 0.5))) },
  pectoral: { s: 0.2, y0: -0.45, y1: -0.2, h: [[0, 0.06], [0.5, 0.12], [0.85, 0.14], [1, 0.11]], dir: [-1, -0.18, 0.2], rays: 14, col: finGrad(0x6e948e, 0xa8b878) },
  pelvic: { s: 0.22, y0: -0.97, y1: -0.84, h: [[0, 0.12], [1, 0.11]], dir: [-1, -0.55, 0.3], rays: 6, col: finGrad(0xd8d68a, 0xf0e8a8) },
  paint: (s, yn, side, y) => {
    let col = ramp([Sf3eba8, Seedb62, Sd8c83c, S9cba48, S3e9a7c, S22788e, S22609a], 0.5 + 0.5 * yn);
    // brighter gold along the middle of the side, blue-green toward the tail
    col = mixC(col, Se6cf3c, smooth(0.5, 0.0, Math.abs(yn + 0.05)) * 0.35 * smooth(0.95, 0.6, s));
    col = mixC(col, S3c9a92, smooth(0.7, 1.0, s) * smooth(-0.6, 0.2, yn) * 0.5);
    // scattered blue spots on the sides, a few dark ones low down
    const sd = side > 0 ? 31 : 37;
    const blue = spots(s * 34, yn * 8, sd, 0.18, 0.3, 0.8) * smooth(-0.5, -0.2, yn) * smooth(0.85, 0.6, yn) * smooth(0.14, 0.22, s);
    col = mixC(col, S3f86d8, blue * 0.85);
    const dark = spots(s * 26 + 7, yn * 6, sd + 5, 0.15, 0.24, 0.5) * smooth(-0.85, -0.6, yn) * smooth(-0.15, -0.35, yn) * smooth(0.2, 0.28, s);
    col = mixC(col, S2e4a3a, dark * 0.6);
    // a fine shimmer of noise, like the living colours
    col = mulC(col, 0.94 + 0.12 * fbm(s * 20, yn * 6 + side * 3, 41, 2));
    return common(col, s, yn, y, MAHI, 0.02);
  },
  metal: [0.12, 0.3],
  rough: 0.32,
};

const SPECIES: Record<FishKind, Species> = { grunt: GRUNT, snapper: SNAPPER, jack: JACK, bonefish: BONEFISH, mahi: MAHI };

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** Texture layout: the body over u in [0, BODY_U], the eye in a square at the top right. */
const BODY_U = 0.86;
const EYE_U = 0.9375;
const EYE_V = 0.125;
const EYE_RU = 0.055;
const EYE_RV = 0.11;
/** Length of the closed cap behind the tail stalk (hidden in the tail fin's base). */
const CAP = 0.014;

interface Shape {
  sp: Species;
  top: (s: number) => number;
  bot: (s: number) => number;
  wid: (s: number) => number;
}

function shapeOf(sp: Species): Shape {
  const nose = (s: number): number => {
    const t = Math.min(1, s / sp.nose);
    return Math.pow(Math.max(0, 1 - (1 - t) * (1 - t)), sp.noseRound);
  };
  const T = spline(sp.top);
  const B = spline(sp.bot);
  const W = spline(sp.wid);
  return { sp, top: lut((s) => T(s) * nose(s)), bot: lut((s) => B(s) * nose(s)), wid: lut((s) => W(s) * nose(s)) };
}

/** A point on the body (body length = 1): s from the snout (0) to the tail stalk (1, then a short closed cap), th round the body (0 = right side, pi/2 = back). */
function bodyPos(sh: Shape, s: number, th: number): V3 {
  let k = 1;
  let ss = s;
  if (s > 1) {
    k = Math.cos((Math.PI / 2) * Math.min(1, (s - 1) / CAP));
    ss = 1;
  }
  const sn = Math.sin(th);
  const c = Math.cos(th);
  const y = (sn >= 0 ? sh.top(ss) : sh.bot(ss)) * sn * k;
  const ac = Math.abs(c);
  let z = sh.wid(ss) * k * Math.sign(c) * Math.pow(ac, sh.sp.flat) * (1 - sh.sp.keel * Math.max(0, sn) ** 2);
  const m = sh.sp.mouth;
  if (ss < m.len) z *= 1 - m.depth * Math.exp(-(((sn - m.y) / 0.12) ** 2)) * smooth(m.len, m.len * 0.25, ss) * ac;
  return [1 - s, y, z];
}

function bodyNormal(sh: Shape, s: number, th: number): V3 {
  const e = 1e-3;
  const du = sub(bodyPos(sh, s, th + e), bodyPos(sh, s, th - e));
  const dv = sub(bodyPos(sh, s + e, th), bodyPos(sh, Math.max(0, s - e), th));
  return norm(cross(du, dv));
}

const BODY_VS = [
  0, 0.004, 0.012, 0.024, 0.04, 0.06, 0.084, 0.112, 0.145, 0.182, 0.222, 0.265, 0.31, 0.355, 0.4, 0.445, 0.49, 0.535, 0.58, 0.625, 0.67, 0.715,
  0.76, 0.805, 0.85, 0.89, 0.925, 0.955, 0.98, 1, 1 + CAP * 0.5, 1 + CAP * 0.85, 1 + CAP,
];

function buildBody(sh: Shape): THREE.BufferGeometry {
  return grid({
    us: steps(20),
    vs: BODY_VS,
    wrapU: true,
    pos: (u, v) => bodyPos(sh, v, -Math.PI / 2 + TAU * u),
    uv: (u, v) => [Math.min(1, v) * BODY_U, u],
  });
}

/** An eye: a shallow glossy dome set into the side of the head, textured from the eye square. */
function buildEye(sh: Shape, side: 1 | -1): THREE.BufferGeometry {
  const e = sh.sp.eye;
  const th0 = Math.asin(clamp(e.y, -0.95, 0.95));
  const th = side > 0 ? th0 : Math.PI - th0;
  const C = bodyPos(sh, e.s, th);
  const N = bodyNormal(sh, e.s, th);
  const fwd = norm(sub([1, 0, 0], scl(N, N[0])));
  const up = norm(cross(N, fwd)).map((x) => x * side) as V3;
  const R = e.r;
  const bulge = 0.32 * R;
  const pos = (u: number, v: number): V3 => {
    const a = TAU * u;
    const off = add(scl(fwd, Math.cos(a) * R * v), scl(up, Math.sin(a) * R * v));
    return add(add(C, off), scl(N, bulge * (1 - v * v) - 0.18 * R * v * v));
  };
  // Orient it so the normals face out.
  const test = cross(sub(pos(0.26, 0.5), pos(0.24, 0.5)), sub(pos(0.25, 0.52), pos(0.25, 0.48)));
  return grid({
    us: steps(12),
    vs: [0, 0.35, 0.62, 0.84, 1],
    wrapU: true,
    flip: dot(test, N) < 0,
    pos,
    uv: (u, v) => [EYE_U + v * Math.cos(TAU * u) * EYE_RU, EYE_V + v * Math.sin(TAU * u) * EYE_RV],
  });
}

/** Fin rays: a greyscale tile, one ray per tile across (u), base to edge up (v). */
let rayTex: THREE.DataTexture | null = null;
function finRayTexture(): THREE.DataTexture {
  rayTex ??= paintTexture(
    'fish:rays',
    32,
    32,
    (u, v) => {
      const d = Math.abs(u - 0.5);
      let g = 1 - 0.2 * smooth(0.16, 0.04, d);
      // rays are jointed: little pale breaks along them
      g += 0.06 * smooth(0.04, 0.0, Math.abs(fract(v * 6 + 0.5 * u) - 0.5) - 0.42) * smooth(0.16, 0.04, d);
      g *= 0.96 + 0.04 * noise(u * 4, v * 16, 7, 4, 16);
      return [g, g, g];
    },
    { wrapU: true },
  );
  return rayTex;
}

interface FinGeoSpec {
  nu: number;
  vs: number[];
  pos: (u: number, v: number) => V3;
  rays: number;
  col: (u: number, v: number) => C3;
}

function finGeo(f: FinGeoSpec): THREE.BufferGeometry {
  return grid({
    us: steps(f.nu),
    vs: f.vs,
    pos: f.pos,
    col: (u, v) => f.col(u, clamp(v, 0, 1)),
    uv: (u, v) => [u * f.rays, clamp(v, 0, 1)],
  });
}

/** Dorsal and anal fins: a membrane on the back or belly ridge, rays leaning back, a little pleated. */
function medianFin(sh: Shape, f: MedianFin, up: boolean): THREE.BufferGeometry {
  const H = spline(f.h);
  const sgn = up ? 1 : -1;
  const n = f.spines ? Math.max(16, Math.round(f.spines.n / f.spines.until) * 2) : Math.max(10, Math.round(f.rays * 0.9));
  const height = (u: number): number => {
    let h = H(u);
    if (f.spines && u < f.spines.until) {
      // notches between the spines
      const ph = (u / f.spines.until) * f.spines.n;
      h *= 1 - f.spines.depth * (0.5 - 0.5 * Math.cos(TAU * ph)) * smooth(0.0, 0.08, u);
    }
    return h;
  };
  return finGeo({
    nu: n,
    vs: [-0.08, 0.35, 0.7, 1],
    rays: f.rays,
    col: f.col,
    pos: (u, v) => {
      const s = mix(f.s0, f.s1, u);
      const b = bodyPos(sh, s, (sgn * Math.PI) / 2);
      const h = height(u);
      const rake = mix(f.rake[0], f.rake[1], u);
      const d = norm([-rake, sgn, 0]);
      const pleat = 0.0035 * Math.sin(u * f.rays * Math.PI) * clamp(v, 0, 1);
      return [b[0] + d[0] * h * v, b[1] - sgn * 0.004 + d[1] * h * v, pleat];
    },
  });
}

/** The tail fin, forked: u runs from the bottom lobe to the top lobe, v from the tail stalk to the trailing edge. */
function caudalFin(sh: Shape): THREE.BufferGeometry {
  const c = sh.sp.caudal;
  const yTop = sh.top(1) * 1.2;
  const yBot = -sh.bot(1) * 1.2;
  return finGeo({
    nu: 18,
    vs: [-0.1, 0.25, 0.5, 0.75, 1],
    rays: c.rays,
    col: c.col,
    pos: (u, v) => {
      const t = 2 * u - 1;
      // the outer rays start a little further forward, on the top and bottom of the tail stalk
      const base: V3 = [0.012 + 0.03 * t * t, mix(yBot, yTop, u), 0];
      const back = mix(c.fork, c.lobe, Math.pow(Math.abs(t), 0.75));
      // the lobes curve outward a little, and taper to points
      const yEdge = t * c.span * (1 - 0.12 * Math.pow(Math.abs(t), 6));
      const edge: V3 = [-back, (yTop + yBot) / 2 + yEdge, 0];
      const vv = clamp(v, -1, 1);
      const p = add(base, scl(sub(edge, base), vv));
      p[1] += Math.sign(t) * 0.05 * c.span * Math.sin(Math.PI * clamp(vv, 0, 1)) * Math.pow(Math.abs(t), 3);
      p[2] = 0.003 * Math.sin(u * c.rays * Math.PI) * clamp(vv, 0, 1);
      return p;
    },
  });
}

/** Pectoral and pelvic fins: paddles on each side, angled back along the body. */
function pairedFin(sh: Shape, f: PairedFin, side: 1 | -1): THREE.BufferGeometry {
  const H = spline(f.h);
  const th = (y: number): number => {
    const a = Math.asin(clamp(y, -0.999, 0.999));
    return side > 0 ? a : Math.PI - a;
  };
  const dir0 = norm([f.dir[0], f.dir[1], f.dir[2] * side]);
  // the rays fan out from the base, so the fin is a paddle rather than a strip
  const b0 = bodyPos(sh, f.s, th(f.y0));
  const b1 = bodyPos(sh, f.s, th(f.y1));
  const across = norm(sub(b1, b0));
  const dirAt = (u: number): V3 => norm(add(dir0, scl(across, (u - 0.5) * 1.1)));
  const g = finGeo({
    nu: Math.max(6, Math.round(f.rays * 0.8)),
    vs: [-0.05, 0.4, 0.75, 1],
    rays: f.rays,
    col: f.col,
    pos: (u, v) => {
      const y = mix(f.y0, f.y1, u);
      const b = bodyPos(sh, f.s + 0.01 * u, th(y));
      const n = bodyNormal(sh, f.s, th(y));
      const h = H(u);
      const vv = clamp(v, -1, 1);
      const dir = dirAt(u);
      const p = add(add(b, scl(n, -0.002)), scl(dir, h * vv));
      // bowed out a little from the body, and pleated between the rays
      const out = norm(cross([0, 1, 0], dir0)).map((x) => x * side) as V3;
      const vc = clamp(vv, 0, 1);
      return add(p, scl(out, 0.012 * h * Math.sin(Math.PI * vc) + 0.002 * Math.sin(u * f.rays * Math.PI) * vc));
    },
  });
  return g;
}

/** Body texture: painted in (s, angle) space, plus the eye in its square. */
function bodyTexture(kind: FishKind, sh: Shape): THREE.DataTexture {
  const sp = sh.sp;
  const iris = srgb(sp.eye.iris);
  const ring = srgb(sp.eye.ring);
  return paintTexture(
    `fish:${kind}`,
    256,
    128,
    (tu, tv) => {
      if (tu > (BODY_U + EYE_U - EYE_RU) / 2 + 0.005) {
        if (tv > 0.25) {
          // unused: the tail stalk's colours, so distant (blurred) views of the tail stay clean
          const th = -Math.PI / 2 + TAU * tv;
          const yn = Math.sin(th);
          return sp.paint(1, yn, Math.cos(th) >= 0 ? 1 : -1, yn * (yn >= 0 ? sh.top(1) : sh.bot(1)));
        }
        const r = Math.hypot((tu - EYE_U) / EYE_RU, (tv - EYE_V) / EYE_RV);
        const ang = Math.atan2((tv - EYE_V) / EYE_RV, (tu - EYE_U) / EYE_RU);
        let c: C3 = mixC(mulC(iris, 1.25), iris, smooth(0.45, 0.8, r));
        c = mixC(c, ring, smooth(0.62, 0.72, r) * smooth(0.86, 0.78, r) * (0.7 + 0.3 * Math.cos(ang * 9)));
        c = mixC(c, srgb(0x0b0a0c), smooth(0.46, 0.4, r)); // the pupil
        c = mixC(c, srgb(0x1a1612), smooth(0.86, 0.95, r)); // dark rim
        // a little white catch-light, up and to the front
        c = mixC(c, [1, 1, 1], smooth(0.15, 0.08, Math.hypot((tu - EYE_U) / EYE_RU - 0.22, (tv - EYE_V) / EYE_RV - 0.3)) * 0.9);
        return c;
      }
      const s = clamp(tu / BODY_U, 0, 1);
      const th = -Math.PI / 2 + TAU * tv;
      const yn = Math.sin(th);
      const side = Math.cos(th) >= 0 ? 1 : -1;
      const y = yn * (yn >= 0 ? sh.top(s) : sh.bot(s));
      return sp.paint(s, yn, side, y);
    },
    // One sample per texel: the patterns have soft edges already, and it paints four times faster.
    { wrapV: true, samples: 1 },
  );
}

interface FishParts {
  body: THREE.BufferGeometry;
  fins: THREE.BufferGeometry;
  map: THREE.DataTexture;
  length: number;
  /** x of the snout tip (the head end), after centring. */
  headX: number;
  mouth: THREE.Vector3;
  sp: Species;
}

const partsCache = new Map<FishKind, FishParts>();

function partsFor(kind: FishKind): FishParts {
  const hit = partsCache.get(kind);
  if (hit) return hit;
  const sp = SPECIES[kind];
  if (!sp) throw new Error(`fish: unknown kind "${kind}"`);
  const sh = shapeOf(sp);
  const bodyMerged = mergeGeometries([buildBody(sh), buildEye(sh, 1), buildEye(sh, -1)]);
  const finParts = [
    ...sp.dorsal.map((f) => medianFin(sh, f, true)),
    ...sp.anal.map((f) => medianFin(sh, f, false)),
    caudalFin(sh),
    pairedFin(sh, sp.pectoral, 1),
    pairedFin(sh, sp.pectoral, -1),
    pairedFin(sh, sp.pelvic, 1),
    pairedFin(sh, sp.pelvic, -1),
  ];
  const finsMerged = mergeGeometries(finParts);
  if (!bodyMerged || !finsMerged) throw new Error('fish: could not merge geometries');
  // Scale to real length, then centre on the bounding box.
  const box = new THREE.Box3();
  for (const g of [bodyMerged, finsMerged]) {
    g.computeBoundingBox();
    box.union(g.boundingBox!);
  }
  const k = sp.length / (box.max.x - box.min.x);
  const cx = ((box.min.x + box.max.x) / 2) * k;
  const cy = ((box.min.y + box.max.y) / 2) * k;
  for (const g of [bodyMerged, finsMerged]) {
    g.scale(k, k, k);
    g.translate(-cx, -cy, 0);
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }
  const parts: FishParts = {
    body: bodyMerged,
    fins: finsMerged,
    map: bodyTexture(kind, sh),
    length: sp.length,
    headX: k - cx,
    mouth: new THREE.Vector3(k - cx, -cy, 0),
    sp,
  };
  partsCache.set(kind, parts);
  return parts;
}

// ---------------------------------------------------------------------------
// Materials, with the side-to-side flex in the vertex shader
// ---------------------------------------------------------------------------

const WIGGLE_VERT = /* glsl */ `
float fishXn = clamp((uWiggle.z - position.x) / uWiggle.w, 0.0, 1.0);
float fishPh = uWiggle.x - 5.2 * fishXn;
float fishA = uWiggle.y * uWiggle.w * (0.02 - 0.06 * fishXn + 0.2 * fishXn * fishXn);
float fishDA = uWiggle.y * uWiggle.w * (-0.06 + 0.4 * fishXn);
float fishSlope = -(fishDA * sin(fishPh) - 5.2 * fishA * cos(fishPh)) / uWiggle.w;
`;

function withWiggle(mat: THREE.MeshStandardMaterial, uniforms: { uWiggle: { value: THREE.Vector4 } }, extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void, key = 'fish'): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWiggle = uniforms.uWiggle;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uWiggle;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${WIGGLE_VERT}\nobjectNormal.x -= fishSlope * objectNormal.z;\nobjectNormal = normalize(objectNormal);`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.z += fishA * sin(fishPh);');
    extra?.(shader);
  };
  mat.customProgramCacheKey = () => key;
}

function bodyMaterial(p: FishParts, uniforms: { uWiggle: { value: THREE.Vector4 } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: p.map, roughness: p.sp.rough, metalness: 0.3 });
  m.name = 'fish:body';
  const metal = { value: new THREE.Vector3(p.sp.metal[0], p.sp.metal[1], p.sp.rough) };
  withWiggle(
    m,
    uniforms,
    (shader) => {
      shader.uniforms.uFishMetal = metal;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFishUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFishUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFishUv;\nuniform vec3 uFishMetal;')
        // (roughness comes before metalness in the standard material's fragment shader)
        .replace(
          '#include <roughnessmap_fragment>',
          `float fishEye = step(${(BODY_U + 0.008).toFixed(3)}, vFishUv.x);
float fishBack = sin(-1.5707963 + 6.2831853 * vFishUv.y);
float roughnessFactor = mix(uFishMetal.z, 0.12, fishEye);`,
        )
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(mix(uFishMetal.x, uFishMetal.y, smoothstep(-0.5, 0.8, fishBack)), 0.0, fishEye);');
    },
    'fish-body',
  );
  return m;
}

function finMaterial(uniforms: { uWiggle: { value: THREE.Vector4 } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: finRayTexture(), vertexColors: true, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.05 });
  m.name = 'fish:fins';
  withWiggle(m, uniforms, undefined, 'fish-fins');
  return m;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A new fish at real size in metres: length along +x, head at +x, back up,
 * centred on its bounding box. `userData` holds `kind`, `length` (m) and
 * `mouth` (the snout tip, where a hook would be, in the fish's own space).
 * Geometry and textures are shared; call `disposeFish` when you drop one to
 * free its two materials.
 */
export function fishModel(kind: FishKind): THREE.Group {
  const p = partsFor(kind);
  const uniforms = { uWiggle: { value: new THREE.Vector4(0, 0, p.headX, p.length) } };
  const g = new THREE.Group();
  g.name = `fish:${kind}`;
  const body = new THREE.Mesh(p.body, bodyMaterial(p, uniforms));
  const fins = new THREE.Mesh(p.fins, finMaterial(uniforms));
  for (const m of [body, fins]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  g.userData = { kind, length: p.length, mouth: p.mouth.clone(), wiggle: uniforms.uWiggle.value, phase: 0, lastTime: NaN };
  return g;
}

/**
 * Flexes a fish's body and tail from side to side. Call it every frame with
 * the clock in seconds; amount 0 = still, 0.3 = a gentle swim, 1 = thrashing
 * on the line. It speeds up with the amount.
 */
export function wiggle(obj: THREE.Object3D, time: number, amount: number): void {
  const u = obj.userData as { wiggle?: THREE.Vector4; phase: number; lastTime: number };
  if (!u.wiggle) return;
  const a = clamp(amount, 0, 1.5);
  const dt = Number.isFinite(u.lastTime) ? clamp(time - u.lastTime, 0, 0.1) : 0;
  u.lastTime = time;
  u.phase = (u.phase + dt * (5 + 11 * Math.min(1, a))) % (TAU * 1000);
  u.wiggle.x = u.phase;
  u.wiggle.y = a;
}

/** Frees the materials of a fish made by `fishModel` (the shared geometry and textures stay). */
export function disposeFish(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.dispose();
  });
}

/**
 * Build (and paint) these kinds now, so the first catch doesn't stutter: each
 * takes a few tens of milliseconds the first time. Call it at a quiet moment,
 * e.g. when the rod comes out.
 */
export function prepareFish(kinds: FishKind[] = FISH_KINDS): void {
  for (const k of kinds) partsFor(k);
}

/** Triangle count of a fish. */
export function fishTriangles(kind: FishKind): number {
  const p = partsFor(kind);
  return [p.body, p.fins].reduce((n, g) => n + (g.index ? g.index.count : g.getAttribute('position').count) / 3, 0);
}
