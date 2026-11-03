/**
 * The garden's plants, built in code from small parts: leaves are bent
 * quads cut out by the leaf atlas (gardenPaint.ts), stems and vines are thin
 * tubes, tomatoes and sweet potatoes are little rounded shapes.
 *
 * Each plant is built into two buffers: `leaves` (everything drawn with the
 * alpha-tested leaf atlas: leaves, flowers, stems, the callaloo plume) and
 * `fruit` (smooth vertex-coloured things: tomatoes, the bamboo stake and its
 * ties, sweet potato tubers). So a plant is at most two draw calls.
 *
 * Coordinates: metres, +Y up, the origin on the soil where the plant comes
 * up. 'pot' is one plant in a 28 cm pot; 'bed' is a bed's worth (three
 * callaloo, two staked tomatoes, or two sweet potato slips whose vines fill
 * the bed), laid out along x for a bed that is long in x (see BED).
 */
import * as THREE from 'three';
import { mulberry32 } from '../engine/noise';
import { TAU, add, clamp, cross, len, lin, mix, mixC, mulC, noise, norm, scl, smooth, sub, type C3, type V3 } from './finds';
import { ASPECT, CELL, HEART_JOIN, STALK, cellUV } from './gardenPaint';

export type CropKind = 'callaloo' | 'tomato' | 'sweetpotato';
export const CROP_KINDS: CropKind[] = ['callaloo', 'tomato', 'sweetpotato'];
export type PlantSize = 'pot' | 'bed';

/** The terracotta pot (potModel at scale 1): metres, origin at the centre of its base. */
export const POT = {
  /** Across the rim, outside. */
  diameter: 0.28,
  height: 0.24,
  /** Across the foot. */
  base: 0.2,
  /** Height of the soil surface above the base. */
  soil: 0.205,
  /** Inside radius at the rim, and the rim's outside radius (with its lip). */
  rimInner: 0.128,
  rimOuter: 0.143,
};

/** The raised bed (bedModel): metres, origin at the centre of its base, long side along x. */
export const BED = {
  length: 1.7,
  width: 0.9,
  height: 0.3,
  /** Thickness of the driftwood planks. */
  plank: 0.035,
  /** Height of the soil surface above the base (where the bed's plants stand). */
  soil: 0.26,
};

// ---------------------------------------------------------------------------
// A small mesh builder
// ---------------------------------------------------------------------------

export interface Vert {
  p: V3;
  c: C3;
  uv?: [number, number];
  /** How far this point sways in the breeze (m). */
  s?: number;
  /** How yellow (thirsty) the leaf is here, 0..1. */
  y?: number;
  /** Normal to use where the grid can't tell (a pole). */
  n?: V3;
}

export class Mesher {
  readonly P: number[] = [];
  readonly N: number[] = [];
  readonly C: number[] = [];
  readonly U: number[] = [];
  readonly S: number[] = [];
  readonly Y: number[] = [];
  readonly I: number[] = [];

  get vertices(): number {
    return this.P.length / 3;
  }
  get triangles(): number {
    return this.I.length / 3;
  }

  vertex(v: Vert, n: V3): number {
    const k = this.vertices;
    this.P.push(v.p[0], v.p[1], v.p[2]);
    this.N.push(n[0], n[1], n[2]);
    this.C.push(v.c[0], v.c[1], v.c[2]);
    this.U.push(v.uv ? v.uv[0] : 0, v.uv ? v.uv[1] : 0);
    this.S.push(v.s ?? 0);
    this.Y.push(v.y ?? 0);
    return k;
  }

  tri(a: number, b: number, c: number): void {
    this.I.push(a, b, c);
  }

  /**
   * A grid of (nu + 1) x (nv + 1) vertices, i across and j along, with
   * smooth normals from the grid itself (cross of across x along). With
   * wrapU the last column repeats the first (a closed ring). A row whose
   * vertices all meet at one point (a pole) gets one triangle per quad.
   */
  grid(nu: number, nv: number, f: (i: number, j: number) => Vert, wrapU = false): void {
    const vs: Vert[] = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) vs.push(f(i, j));
    const at = (i: number, j: number): Vert => vs[j * (nu + 1) + i];
    const pole = (j: number): boolean => {
      const a = at(0, j).p;
      for (let i = 1; i <= nu; i++) if (len(sub(at(i, j).p, a)) > 1e-7) return false;
      return true;
    };
    const poles: boolean[] = [];
    for (let j = 0; j <= nv; j++) poles.push(pole(j));
    const base = this.vertices;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const v = at(i, j);
        let ia = i - 1;
        let ib = i + 1;
        if (wrapU) {
          if (ia < 0) ia = nu - 1;
          if (ib > nu) ib = 1;
        } else {
          ia = Math.max(0, ia);
          ib = Math.min(nu, ib);
        }
        const du = sub(at(ib, j).p, at(ia, j).p);
        const dv = sub(at(i, Math.min(nv, j + 1)).p, at(i, Math.max(0, j - 1)).p);
        let n = cross(du, dv);
        const l = len(n);
        if (l < 1e-12 || poles[j]) {
          if (v.n) n = v.n;
          else {
            // average the ring next to the pole
            const jj = j === 0 ? 1 : j - 1;
            let acc: V3 = [0, 0, 0];
            for (let q = 0; q < nu; q++) {
              const a = sub(at(q + 1, jj).p, at(q, jj).p);
              const b = sub(at(q, Math.min(nv, jj + 1)).p, at(q, Math.max(0, jj - 1)).p);
              acc = add(acc, cross(a, b));
            }
            n = len(acc) > 1e-12 ? acc : [0, 1, 0];
          }
        }
        this.vertex(v, norm(n));
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        if (!poles[j]) this.tri(a, b, c);
        if (!poles[j + 1]) this.tri(b, d, c);
      }
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.S, 1));
    g.setAttribute('yellow', new THREE.Float32BufferAttribute(this.Y, 1));
    if (this.vertices > 65535) g.setIndex(new THREE.Uint32BufferAttribute(this.I, 1));
    else g.setIndex(new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Leaves, tubes and blobs
// ---------------------------------------------------------------------------

export interface LeafSpec {
  /** Where the stalk joins the stem. */
  at: V3;
  /** Heading in plan: 0 = +x, PI/2 = +z. */
  yaw: number;
  /** How steeply the stalk rises (radians above level). */
  pitch: number;
  /** How far the blade bends down from its base to its tip (radians). */
  arch: number;
  /** Whole length, stalk included (m). */
  len: number;
  cell: number;
  /** Width as a share of the cell's own proportions (1 = as painted). */
  widthK?: number;
  /** Edges lifted (a V along the midrib), as a share of the half-width. */
  fold?: number;
  /** Roll about the leaf's own length (radians). */
  roll?: number;
  tint: C3;
  /** Sway at the tip (m) and at the stalk. */
  sway: number;
  swayBase?: number;
  /** Yellowing at the base and at the tip (0..1). */
  yellow?: [number, number];
  /** Rows along the leaf: 4 (12 triangles) or 5 (16). */
  rows?: number;
  /** The blade starts this share of its length behind `at` (for a heart leaf, whose lobes reach back past its stalk). */
  back?: number;
}

const dirOf = (yaw: number, pitch: number): V3 => [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)];
const rotateAbout = (v: V3, axis: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * d * (1 - c), v[1] * c + x[1] * s + axis[1] * d * (1 - c), v[2] * c + x[2] * s + axis[2] * d * (1 - c)];
};

/** One leaf: a bent strip of 3 x (rows) vertices, cut out by its atlas cell. Returns the tip. */
export function leaf(m: Mesher, L: LeafSpec): V3 {
  const stalk = STALK[L.cell] ?? 0;
  const rows = L.rows ?? 5;
  const blade = rows - (stalk > 0 ? 1 : 0);
  const ss: number[] = [0];
  if (stalk > 0) ss.push(stalk);
  for (let k = 1; k < blade; k++) ss.push(stalk + ((1 - stalk) * k) / (blade - 1));
  const pitchAt = (s: number): number => L.pitch - (s <= stalk ? 0 : (L.arch * (s - stalk)) / (1 - stalk));
  const W = ASPECT[L.cell] * L.len * (L.widthK ?? 1);
  const fold = L.fold ?? 0;
  const side0: V3 = [-Math.sin(L.yaw), 0, Math.cos(L.yaw)];
  const centres: V3[] = [];
  const dirs: V3[] = [];
  let p = L.back ? sub(L.at, scl(dirOf(L.yaw, L.pitch), L.back * L.len)) : L.at;
  let prev = 0;
  for (const s of ss) {
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const a = prev + ((s - prev) * (k + 0.5)) / steps;
      p = add(p, scl(dirOf(L.yaw, pitchAt(a)), ((s - prev) / steps) * L.len));
    }
    prev = s;
    centres.push(p);
    dirs.push(dirOf(L.yaw, pitchAt(s)));
  }
  const yb = L.yellow?.[0] ?? 0;
  const yt = L.yellow?.[1] ?? yb;
  const sb = L.swayBase ?? 0;
  m.grid(2, ss.length - 1, (i, j) => {
    const s = ss[j];
    const D = dirs[j];
    const S = L.roll ? rotateAbout(side0, D, L.roll) : side0;
    const N = cross(S, D);
    const c = i - 1;
    const f = s > stalk + 1e-6 || stalk === 0 ? fold : 0;
    const pos = add(add(centres[j], scl(S, (c * W) / 2)), scl(N, (Math.abs(c) * W * f) / 2));
    const k = Math.pow(s, 1.5);
    return { p: pos, c: L.tint, uv: cellUV(L.cell, i / 2, s), s: mix(sb, L.sway, k), y: clamp(mix(yb, yt, k), 0, 1) };
  });
  return centres[centres.length - 1];
}

export interface TubeSpec {
  /** Radius at t (0..1 along the path) and angle a. */
  r: (t: number, a: number) => number;
  nu: number;
  col: (t: number, a: number) => C3;
  sway?: (t: number) => number;
  yellow?: number;
  /** Texture coordinates (default: the atlas's plain stem area). */
  uv?: (t: number, a: number) => [number, number];
}

/** A tube along a polyline (parallel-transported frames, so it doesn't twist). A zero radius at an end closes it to a point. */
export function tubeAlong(m: Mesher, pts: V3[], o: TubeSpec): void {
  const n = pts.length;
  const lens = [0];
  for (let k = 1; k < n; k++) lens.push(lens[k - 1] + len(sub(pts[k], pts[k - 1])));
  const total = lens[n - 1] || 1;
  const T: V3[] = [];
  for (let k = 0; k < n; k++) T.push(norm(sub(pts[Math.min(n - 1, k + 1)], pts[Math.max(0, k - 1)])));
  const ref: V3 = Math.abs(T[0][1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const S: V3[] = [norm(cross(T[0], ref))];
  for (let k = 1; k < n; k++) {
    const s = S[k - 1];
    const d = s[0] * T[k][0] + s[1] * T[k][1] + s[2] * T[k][2];
    let sk = sub(s, scl(T[k], d));
    if (len(sk) < 1e-6) sk = norm(cross(T[k], ref));
    S.push(norm(sk));
  }
  const uvOf = o.uv ?? ((t: number, a: number): [number, number] => cellUV(CELL.solid, 0.1 + (0.8 * a) / TAU, 0.56 + 0.38 * t));
  m.grid(
    o.nu,
    n - 1,
    (i, j) => {
      const t = lens[j] / total;
      const a = (TAU * i) / o.nu;
      const U = cross(S[j], T[j]);
      const r = o.r(t, a);
      const dir = sub(scl(S[j], Math.cos(a)), scl(U, Math.sin(a)));
      return { p: add(pts[j], scl(dir, r)), c: o.col(t, a), uv: uvOf(t, a), s: o.sway ? o.sway(t) : 0, y: o.yellow ?? 0, n: j === 0 ? scl(T[j], -1) : T[j] };
    },
    true,
  );
}

/** A rounded lump (ellipsoid-ish) with its long axis along `axis`, built as a closed tube; r(t, a) shapes it. */
export function lump(m: Mesher, centre: V3, axis: V3, length: number, nu: number, nv: number, r: (t: number, a: number) => number, col: (t: number, a: number) => C3, sway = 0): void {
  const pts: V3[] = [];
  for (let j = 0; j <= nv; j++) {
    const t = j / nv;
    // rows bunched toward the ends, where the shape turns fastest
    const e = 0.5 - 0.5 * Math.cos(Math.PI * t);
    pts.push(add(centre, scl(axis, (e - 0.5) * length)));
  }
  // (on a straight line the tube's t is the distance fraction, so it already runs 0..1 end to end)
  tubeAlong(m, pts, { nu, r, col, sway: () => sway });
}

/** Smooth a polyline a little (keeps the ends). */
function relax(pts: V3[], passes = 2): V3[] {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    const q = p.map((v) => [...v] as V3);
    for (let i = 1; i < p.length - 1; i++) for (let c = 0; c < 3; c++) q[i][c] = 0.25 * p[i - 1][c] + 0.5 * p[i][c] + 0.25 * p[i + 1][c];
    p = q;
  }
  return p;
}

/** Evenly re-spaced points along a polyline. */
function resample(pts: V3[], n: number): V3[] {
  const lens = [0];
  for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + len(sub(pts[k], pts[k - 1])));
  const total = lens[lens.length - 1];
  const out: V3[] = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const want = (total * i) / (n - 1);
    while (seg < pts.length - 2 && lens[seg + 1] < want) seg++;
    const span = lens[seg + 1] - lens[seg] || 1;
    const f = clamp((want - lens[seg]) / span, 0, 1);
    out.push(add(pts[seg], scl(sub(pts[seg + 1], pts[seg]), f)));
  }
  return out;
}

/** The point at distance d along a polyline, and the direction there. */
function along(pts: V3[], d: number): { p: V3; t: V3 } {
  let acc = 0;
  for (let k = 1; k < pts.length; k++) {
    const seg = len(sub(pts[k], pts[k - 1]));
    if (acc + seg >= d || k === pts.length - 1) {
      const f = seg > 0 ? clamp((d - acc) / seg, 0, 1) : 0;
      return { p: add(pts[k - 1], scl(sub(pts[k], pts[k - 1]), f)), t: norm(sub(pts[k], pts[k - 1])) };
    }
    acc += seg;
  }
  return { p: pts[pts.length - 1], t: [1, 0, 0] };
}

const polyLength = (pts: V3[]): number => {
  let l = 0;
  for (let k = 1; k < pts.length; k++) l += len(sub(pts[k], pts[k - 1]));
  return l;
};

// ---------------------------------------------------------------------------
// The edge a trailing vine spills over
// ---------------------------------------------------------------------------

export interface Rim {
  /** Distance from (x, z), heading at angle a in plan, to the inside of the pot or bed wall. */
  dist(x: number, z: number, a: number): number;
  /** The wall's top, above the soil. */
  top: number;
  /** The wall's thickness. */
  width: number;
  /** How far a vine may hang below the wall's top. */
  hang: number;
}

export const POT_RIM: Rim = {
  dist(x, z, a) {
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const b = x * dx + z * dz;
    const c = x * x + z * z - POT.rimInner * POT.rimInner;
    return -b + Math.sqrt(Math.max(0, b * b - c));
  },
  top: POT.height - POT.soil,
  width: POT.rimOuter - POT.rimInner + 0.004,
  hang: POT.soil - 0.03,
};

export const BED_RIM: Rim = {
  dist(x, z, a) {
    const hx = BED.length / 2 - BED.plank;
    const hz = BED.width / 2 - BED.plank;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    let t = Infinity;
    if (Math.abs(dx) > 1e-6) t = Math.min(t, ((dx > 0 ? hx : -hx) - x) / dx);
    if (Math.abs(dz) > 1e-6) t = Math.min(t, ((dz > 0 ? hz : -hz) - z) / dz);
    return Math.max(0, t);
  },
  top: BED.height - BED.soil,
  width: BED.plank + 0.004,
  hang: BED.soil - 0.05,
};

// ---------------------------------------------------------------------------
// The three crops
// ---------------------------------------------------------------------------

interface Ctx {
  leaves: Mesher;
  fruit: Mesher;
  rng: () => number;
  /** How thirsty, 0..1: droop and yellow. */
  th: number;
  ripe: boolean;
  /** More detail (one plant in a pot) or less (a bed's worth). */
  hi: boolean;
}

const C = (hex: number): C3 => lin(hex);
const jitter = (rng: () => number, k: number): number => (rng() - 0.5) * 2 * k;
/** A leaf's colour: small variations in shade (the atlas holds the colour itself). */
const leafTint = (rng: () => number): C3 => {
  const v = 0.78 + 0.24 * rng();
  return [v * (0.97 + 0.06 * rng()), v, v * (0.95 + 0.08 * rng())];
};

/** Callaloo: an upright stem with broad leaves on long stalks, side shoots when bigger, and a red-purple plume when ripe. */
function callaloo(cx: Ctx, at: V3, k: number, g: number, red: boolean): void {
  const { rng, th, leaves: L } = cx;
  const rows = cx.hi ? 5 : 4;
  const yaw0 = rng() * TAU;
  const stemCol = (t: number): C3 => mixC(C(0x6b9a3c), C(0x8a3048), (1 - t) * (red ? 0.65 : 0.3));
  if (g < 0.1) {
    // a seedling: two round seed leaves and the first two true leaves
    const h = 0.026;
    const top: V3 = add(at, [0.002, h, 0.001]);
    tubeAlong(L, [add(at, [0, -0.015, 0]), add(at, [0.001, h * 0.5, 0]), top], { nu: 3, r: (t) => 0.0014 * (1 - 0.3 * t), col: () => C(0x8fb85a), sway: (t) => 0.001 * t, yellow: th * 0.4 });
    for (const s of [0, Math.PI]) {
      leaf(L, { at: top, yaw: yaw0 + s, pitch: 0.35 - th * 0.7, arch: 0.25 + th * 0.5, len: 0.02, cell: CELL.seedling, tint: leafTint(rng), sway: 0.002, rows: 4, yellow: [th * 0.5, th * 0.8] });
    }
    for (const s of [Math.PI / 2, (3 * Math.PI) / 2]) {
      leaf(L, { at: add(top, [0, 0.003, 0]), yaw: yaw0 + s, pitch: 1.0 - th * 0.8, arch: 0.4 + th * 0.4, len: 0.026, cell: red ? CELL.callalooRed : CELL.callaloo, tint: leafTint(rng), sway: 0.003, rows: 4, yellow: [th * 0.4, th * 0.7] });
    }
    return;
  }
  const H = k * (0.07 + 0.37 * g);
  const lean: V3 = [jitter(rng, 0.04) * H, 0, jitter(rng, 0.04) * H];
  const wiltYaw = rng() * TAU;
  const stemAt = (t: number): V3 => {
    const w = th * Math.pow(smooth(0.45, 1, t), 2);
    return add(at, [lean[0] * t * t + Math.cos(wiltYaw) * w * 0.3 * H, H * t - w * 0.18 * H, lean[2] * t * t + Math.sin(wiltYaw) * w * 0.3 * H]);
  };
  const r0 = k * (0.003 + 0.0055 * g);
  const sn = cx.hi ? 7 : 4;
  const stemPts: V3[] = [add(at, [0, -0.02, 0])];
  for (let j = 0; j <= sn; j++) stemPts.push(stemAt(j / sn));
  tubeAlong(L, stemPts, { nu: cx.hi ? 5 : 4, r: (t) => r0 * (1 - 0.65 * t), col: stemCol, sway: (t) => 0.008 * t * t * g, yellow: th * 0.3 });

  // leaves spiralling up the stem, biggest at the bottom
  const nL = Math.round(cx.hi ? 6 + 16 * g : 4 + 6 * g);
  const kLeaf = cx.hi ? 1 : 1.12;
  const redShare = red ? 0.6 : 0.18;
  const leafAt = (base: V3, t: number, yaw: number, size: number, upper: number): void => {
    const len0 = size * (0.88 + 0.24 * rng());
    leaf(L, {
      at: base,
      yaw,
      pitch: 0.35 + 0.55 * upper + jitter(rng, 0.12) - th * (0.75 + 0.45 * upper),
      arch: 0.75 + 0.35 * upper + 0.3 * rng() + th * 0.9,
      len: len0,
      cell: rng() < redShare * (0.6 + 0.8 * upper) ? CELL.callalooRed : CELL.callaloo,
      fold: 0.12 + 0.35 * th,
      roll: jitter(rng, 0.25),
      tint: leafTint(rng),
      sway: 0.006 + 0.02 * len0 * (0.5 + t),
      swayBase: 0.006 * t * t * g,
      rows,
      yellow: [th * (0.35 + 0.45 * (1 - t)), th * (0.7 + 0.3 * (1 - t))],
    });
  };
  for (let i = 0; i < nL; i++) {
    const t = 0.1 + 0.85 * Math.pow((i + 0.5) / nL, 0.85);
    leafAt(stemAt(t), t, yaw0 + i * 2.39996 + jitter(rng, 0.2), kLeaf * k * (0.07 + 0.16 * g) * (1.02 - 0.38 * t), t);
  }
  // side shoots make it bushy
  const nb = g < 0.45 ? 0 : g >= 0.7 ? (cx.hi ? 4 : 3) : 2;
  const tops: V3[] = [];
  for (let b = 0; b < nb; b++) {
    const tb = 0.14 + 0.11 * b + 0.05 * rng();
    const base = stemAt(tb);
    const yb = yaw0 + 1.1 + b * 2.3 + jitter(rng, 0.3);
    const lb = H * (0.38 + 0.25 * g) * (1 - 0.12 * b);
    const pts: V3[] = [base];
    let p = base;
    const segs = cx.hi ? 4 : 3;
    for (let j = 1; j <= segs; j++) {
      const e = 0.38 + (0.7 * j) / segs - th * (0.9 * j) / segs;
      p = add(p, scl(dirOf(yb, e), lb / segs));
      pts.push(p);
    }
    tubeAlong(L, pts, { nu: cx.hi ? 4 : 3, r: (t) => r0 * 0.55 * (1 - 0.6 * t), col: (t) => stemCol(tb + t * 0.4), sway: (t) => 0.004 + 0.008 * t, yellow: th * 0.3 });
    const nbl = cx.hi ? 4 : 3;
    for (let q = 0; q < nbl; q++) {
      const u = 0.3 + (0.7 * q) / (nbl - 1);
      const { p: lp } = along(pts, u * lb);
      leafAt(lp, Math.min(1, tb + 0.4 * u), yb + (q % 2 ? 1 : -1) * (0.9 + 0.5 * rng()), kLeaf * k * (0.06 + 0.11 * g) * (1 - 0.25 * u), 0.3 + 0.5 * u);
    }
    tops.push(pts[pts.length - 1]);
  }
  // the plume: a small bud while growing, the full red-purple plume when ripe
  if (g >= 0.7) {
    const p = cx.ripe ? 1 : g >= 0.95 ? 0.5 : 0.25;
    const top = stemAt(1);
    const py = rng() * TAU;
    const pl = k * (0.03 + 0.14 * p);
    plume(cx, top, pl, k * 0.013 * (0.55 + 0.45 * p), py, 0.9 + th * 0.8, cx.ripe, cx.hi ? 7 : 4, cx.hi ? 12 : 6);
    if (p >= 0.5 && cx.hi) {
      // a panicle: two side spikes low on the plume, and small plumes at the shoot tips and leaf joints
      for (const s of [-1, 1]) {
        const base = add(top, [Math.sin(0.1) * Math.cos(py) * pl * 0.18, pl * 0.18, Math.sin(0.1) * Math.sin(py) * pl * 0.18]);
        plume(cx, base, pl * 0.42, k * 0.008, py + s * 1.9, 1.3 + th, cx.ripe, cx.hi ? 5 : 4, cx.hi ? 6 : 4);
      }
      for (const t of tops.slice(0, 3)) plume(cx, t, k * 0.055 * p, k * 0.008, rng() * TAU, 0.8 + th, cx.ripe, 4, 5);
      plume(cx, stemAt(0.8), k * 0.05 * p, k * 0.007, yaw0 + 2, 1.2 + th, cx.ripe, 4, 5);
    } else if (p >= 0.5 && tops.length) plume(cx, tops[0], k * 0.05 * p, k * 0.008, rng() * TAU, 0.8 + th, cx.ripe, 4, 4);
  }
}

/** A chenille-like flower plume, rising and nodding over at the tip. */
function plume(cx: Ctx, base: V3, length: number, radius: number, yaw: number, nod: number, ripe: boolean, nu: number, rows: number): void {
  const pts: V3[] = [base];
  let p = base;
  for (let j = 1; j <= rows; j++) {
    const t = j / rows;
    const tilt = 0.1 + nod * t * t;
    p = add(p, scl([Math.sin(tilt) * Math.cos(yaw), Math.cos(tilt), Math.sin(tilt) * Math.sin(yaw)], length / rows));
    pts.push(p);
  }
  const seed = cx.rng() * 100;
  const deep = ripe ? C(0x7e1236) : C(0x7d9440);
  const bright = ripe ? C(0xc2305c) : C(0xa8ad62);
  tubeAlong(cx.leaves, pts, {
    nu,
    r: (t, a) => {
      if (t >= 0.999) return 0;
      const body = 0.55 + 0.45 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.6 + 0.1)), 0.5);
      const tip = smooth(1, 0.6, t);
      // lumpy clusters of tiny flowers
      const lumps = 1 + 0.16 * Math.sin(t * rows * Math.PI + a * 2 + seed) + 0.3 * (noise(t * 14, a * 1.3, seed) - 0.5);
      return radius * body * Math.max(0.12, tip) * lumps;
    },
    col: (t, a) => mulC(mixC(deep, bright, 0.35 + 0.5 * t), 0.85 + 0.3 * noise(t * 9 + 3, a, seed + 1)),
    sway: (t) => 0.004 + 0.012 * t,
    yellow: cx.th * 0.2,
    uv: (t, a) => cellUV(CELL.solid, 0.04 + (0.92 * a) / TAU, 0.04 + 0.42 * t),
  });
}

/** Cherry tomato: a vine climbing a bamboo stake, tied on with twine; yellow flowers, then trusses of fruit, red when ripe. */
function tomato(cx: Ctx, at: V3, k: number, g: number): void {
  const { rng, th, leaves: L, fruit: F } = cx;
  const rows = cx.hi ? 5 : 4;
  const Hs = k * 0.95;
  const stakeR = cx.hi ? 0.0085 : 0.0095;
  const stakeYaw = rng() * TAU;
  const S: V3 = add(at, [Math.cos(stakeYaw) * 0.026, 0, Math.sin(stakeYaw) * 0.026]);
  const away = stakeYaw + Math.PI;
  // ---- the bamboo stake ----
  {
    const nodes = Hs > 0.75 ? [0.3, 0.62, 0.93] : [0.32, 0.72];
    const ys: number[] = [-0.05];
    for (const nd of nodes) ys.push(nd * Hs - 0.01, nd * Hs, nd * Hs + 0.01);
    ys.push(Hs - 0.001, Hs);
    const tilt: V3 = [jitter(rng, 0.015), 1, jitter(rng, 0.015)];
    const pts = ys.map((y) => add(S, [tilt[0] * y, y, tilt[2] * y]));
    // the last ring is the cut top, closed flat
    tubeAlong(F, pts, {
      nu: cx.hi ? 6 : 5,
      r: (t) => {
        const y = t * (Hs + 0.05) - 0.05;
        if (t >= 0.9999) return 0;
        let r = stakeR;
        for (const nd of nodes) r *= 1 + 0.16 * Math.exp(-(((y - nd * Hs) / 0.006) ** 2));
        return r;
      },
      col: (t) => {
        const y = t * (Hs + 0.05) - 0.05;
        let c = mixC(C(0xbfa46a), C(0xd6c08a), smooth(0, Hs, y));
        for (const nd of nodes) c = mixC(c, C(0x8f7a4a), 0.6 * Math.exp(-(((y - nd * Hs) / 0.005) ** 2)));
        if (y < 0.002) c = mulC(c, 0.55);
        return t >= 0.9999 ? C(0xd8c49a) : c;
      },
    });
  }
  // ---- the vine ----
  const Hv = g < 0.1 ? 0.05 : Hs * (0.12 + 0.86 * g);
  const ph = rng() * TAU;
  const around = (y: number): number => away + 0.5 * Math.sin(ph + y * 7);
  const stemAt = (y: number): V3 => {
    const a = around(y);
    const zig = 0.004 * Math.sin((y / 0.06) * Math.PI);
    const free = smooth(Hv - 0.14, Hv, y) * smooth(0.25, 0.4, Hv);
    const flop = free * (0.03 + th * 0.07);
    const sag = free * th * 0.05;
    const rr = 0.022 + zig + flop;
    return add(S, [Math.cos(a) * rr, y - sag, Math.sin(a) * rr]);
  };
  const vn = cx.hi ? 10 : 7;
  const vpts: V3[] = [add(at, [0, -0.02, 0])];
  for (let j = 0; j <= vn; j++) {
    const y = (Hv * j) / vn;
    vpts.push(j === 0 ? at : stemAt(y));
  }
  const vr = (cx.hi ? 0.0048 : 0.0055) * (0.5 + 0.5 * g);
  const tied = (y: number): number => smooth(Hv - 0.15, Hv, y);
  tubeAlong(L, vpts, { nu: cx.hi ? 5 : 4, r: (t) => vr * (1 - 0.55 * t) + 0.0012, col: (t) => mixC(C(0x6d6a3a), C(0x5f8f38), smooth(0, 0.15, t)), sway: (t) => 0.006 * tied(t * Hv), yellow: th * 0.3 });
  // ---- twine ties ----
  for (const f of [0.25, 0.5, 0.75, 0.95]) {
    const y = f * Hs;
    if (y > Hv - 0.04) break;
    const p = stemAt(y);
    const dv: V3 = [p[0] - S[0], 0, p[2] - S[2]];
    const dl = len(dv) || 1;
    const ax = scl(dv, 1 / dl);
    const bx: V3 = [-ax[2], 0, ax[0]];
    const ctr = add(S, scl(dv, 0.5));
    const A = dl / 2 + stakeR + 0.003;
    const B = stakeR + 0.0025;
    const loop: V3[] = [];
    const seg = cx.hi ? 6 : 5;
    for (let q = 0; q <= seg; q++) {
      const a = (TAU * q) / seg;
      const p2 = add(add(ctr, scl(ax, Math.cos(a) * A)), scl(bx, Math.sin(a) * B));
      loop.push([p2[0], y + 0.002 * Math.sin(a * 2), p2[2]]);
    }
    tubeAlong(F, loop, { nu: 3, r: () => 0.0016, col: () => C(0xcdb689) });
  }
  // ---- leaves ----
  if (g < 0.1) {
    const top = stemAt(Hv);
    const y0 = rng() * TAU;
    for (const s of [0, Math.PI]) {
      leaf(L, { at: top, yaw: y0 + s, pitch: 0.3 - th * 0.7, arch: 0.3 + th * 0.5, len: 0.03, widthK: 0.55, cell: CELL.seedling, tint: leafTint(rng), sway: 0.002, rows: 4, yellow: [th * 0.5, th * 0.8] });
    }
    leaf(L, { at: add(top, [0, 0.003, 0]), yaw: y0 + Math.PI / 2, pitch: 1.0 - th * 0.8, arch: 0.5 + th * 0.5, len: 0.042, cell: CELL.tomato, tint: leafTint(rng), sway: 0.003, rows: 4, yellow: [th * 0.4, th * 0.7] });
  } else {
    const sp = cx.hi ? 0.052 : 0.07;
    const nodes = Math.max(2, Math.round(Hv / sp));
    const kL = cx.hi ? 0.9 : 1.1;
    for (let i = 0; i < nodes; i++) {
      const y = ((i + 0.55) * Hv) / (nodes + 0.15);
      const u = y / Hv;
      const top = u > 0.82 ? 1 : 0;
      const size = kL * (0.1 + 0.17 * g) * (1 - 0.5 * Math.max(0, u - 0.45) * 1.8);
      const yaw = away + (i % 2 ? 1 : -1) * (0.7 + 0.6 * rng()) + jitter(rng, 0.4);
      leaf(L, {
        at: stemAt(y),
        yaw,
        pitch: 0.5 + top * 0.45 + jitter(rng, 0.12) - th * (0.85 + 0.2 * top),
        arch: 0.95 + 0.35 * rng() + th * 0.7 - top * 0.3,
        len: size * (0.9 + 0.2 * rng()),
        cell: CELL.tomato,
        fold: 0.06 + 0.35 * th,
        roll: jitter(rng, 0.25),
        tint: leafTint(rng),
        sway: 0.008 + 0.03 * size,
        swayBase: 0.004 * tied(y),
        rows,
        yellow: [th * (0.35 + 0.4 * (1 - u)), th * (0.7 + 0.3 * (1 - u))],
      });
    }
  }
  // ---- side shoots, for a fuller plant ----
  if (g >= 0.45) {
    const n = g >= 0.7 ? 3 : 2;
    for (let q = 0; q < n; q++) {
      const y = Hv * (0.18 + 0.2 * q + 0.05 * rng());
      const base = stemAt(y);
      const yaw = away + (q % 2 ? 1.1 : -1.1) + jitter(rng, 0.3);
      const lb = 0.07 + 0.08 * g;
      const pts: V3[] = [base];
      for (let j = 1; j <= 3; j++) pts.push(add(base, add(scl(dirOf(yaw, 0.9 - 0.2 * j - th * 0.3 * j), (lb * j) / 3), [0, 0, 0])));
      tubeAlong(L, pts, { nu: 3, r: (t) => vr * 0.6 * (1 - 0.5 * t) + 0.001, col: () => C(0x5f8f38), sway: (t) => 0.004 + 0.008 * t, yellow: th * 0.3 });
      for (let k = 0; k < 2; k++) {
        const tip = pts[k + 2];
        const size = (cx.hi ? 0.9 : 1.1) * (0.08 + 0.1 * g) * (k === 0 ? 1 : 0.8);
        leaf(L, { at: tip, yaw: yaw + (k ? 0.8 : -0.8), pitch: 0.5 - th * 0.9, arch: 1.0 + th * 0.6, len: size, cell: CELL.tomato, fold: 0.06 + 0.35 * th, roll: jitter(rng, 0.25), tint: leafTint(rng), sway: 0.012, swayBase: 0.006, rows, yellow: [th * 0.5, th * 0.85] });
      }
    }
  }
  // ---- flowers and fruit ----
  const trusses: { u: number; fruit: number; scale: number }[] = [];
  if (g >= 0.4 && g < 0.6) trusses.push({ u: 0.55, fruit: 0, scale: 1 }, { u: 0.78, fruit: 0, scale: 1 });
  else if (g >= 0.6 && g < 0.9) trusses.push({ u: 0.38, fruit: 4, scale: 0.6 }, { u: 0.56, fruit: 4, scale: 0.5 }, { u: 0.8, fruit: 0, scale: 1 });
  else if (g >= 0.9) {
    const n = cx.hi ? 5 : 4;
    trusses.push({ u: 0.3, fruit: n, scale: 1 }, { u: 0.5, fruit: n, scale: 1 });
    if (cx.hi) trusses.push({ u: 0.66, fruit: 4, scale: 0.9 });
    trusses.push({ u: 0.84, fruit: 0, scale: 1 });
  }
  trusses.forEach((tr, ti) => truss(cx, stemAt(tr.u * Hv), away + (ti % 2 ? 0.7 : -0.7) + jitter(rng, 0.3), tr.fruit, tr.scale, 0.006 * tied(tr.u * Hv)));
}

/** A truss: a stalk arching out from the vine with flowers, or with cherry tomatoes hanging from it. */
function truss(cx: Ctx, base: V3, yaw: number, nFruit: number, scale: number, swayBase: number): void {
  const { rng, th, leaves: L, fruit: F } = cx;
  const flowers = nFruit === 0;
  const length = flowers ? 0.045 : 0.07;
  const droop = flowers ? 0.02 : 0.035 * scale + 0.01;
  const dir: V3 = [Math.cos(yaw), 0, Math.sin(yaw)];
  const side: V3 = [-dir[2], 0, dir[0]];
  const at = (s: number): V3 => add(add(base, scl(dir, length * 0.8 * s)), [0, 0.014 * Math.sin(Math.PI * s * 0.8) - droop * s * s - th * 0.01 * s, 0]);
  const pts: V3[] = [];
  const segs = cx.hi ? 4 : 3;
  for (let j = 0; j <= segs; j++) pts.push(at(j / segs));
  const sw = (s: number): number => swayBase + 0.004 + 0.008 * s;
  tubeAlong(L, pts, { nu: 3, r: (t) => 0.0017 * (1 - 0.4 * t), col: () => C(0x5f8d38), sway: sw, yellow: th * 0.3 });
  if (flowers) {
    const n = cx.hi ? 5 : 4;
    for (let q = 0; q < n; q++) {
      const s = 0.35 + (0.65 * q) / (n - 1);
      const c = add(at(s), add(scl(side, (q % 2 ? 1 : -1) * 0.008), [0, -0.009, 0]));
      // a nodding star, facing out and down
      const face = norm(add(dir, [jitter(rng, 0.4), -0.9 - th * 0.3, jitter(rng, 0.4)]));
      const u = norm(cross(face, [0, 1, 0]));
      const v = cross(u, face);
      const R = 0.0125;
      const yel = th * 0.4;
      L.grid(1, 1, (i, j) => ({ p: add(c, add(scl(u, (i - 0.5) * 2 * R), scl(v, (j - 0.5) * 2 * R))), c: [1, 1, 1], uv: cellUV(CELL.flower, i, j), s: sw(s), y: yel }));
    }
    return;
  }
  const nu = cx.hi ? 6 : 5;
  const nv = cx.hi ? 5 : 3;
  for (let q = 0; q < nFruit; q++) {
    const s = 0.28 + (0.72 * q) / Math.max(1, nFruit - 1);
    const r = 0.0118 * scale * (0.92 + 0.14 * rng()) * (q === nFruit - 1 ? 0.85 : 1);
    const hangTo = add(at(s), add(scl(side, (q % 2 ? 1 : -1) * 0.009), [0, -0.006 - r, 0]));
    // ripening runs from the stalk end outward: the last one is still orange
    const ripeness = cx.ripe ? (q < nFruit - 1 ? 1 : 0.55) : 0;
    const body = ripeness >= 1 ? C(0xc8261a) : ripeness > 0 ? C(0xe0782a) : C(0x8dbb52);
    const shoulder = ripeness >= 1 ? C(0xb8361c) : ripeness > 0 ? C(0xb98a32) : C(0x5d8f38);
    const bottom = ripeness >= 1 ? C(0xd8402a) : ripeness > 0 ? C(0xeb9a3a) : C(0xadd06e);
    const swq = sw(s);
    F.grid(
      nu,
      nv,
      (i, j) => {
        const th2 = (TAU * i) / nu;
        const ph2 = (Math.PI * j) / nv;
        const p: V3 = [Math.sin(ph2) * Math.cos(th2) * r, Math.cos(ph2) * r * 0.9, Math.sin(ph2) * Math.sin(th2) * r];
        const up = Math.cos(ph2);
        const col = up > 0 ? mixC(body, shoulder, smooth(0.2, 0.95, up)) : mixC(body, bottom, smooth(-0.2, -1, up));
        return { p: add(hangTo, p), c: col, s: swq };
      },
      true,
    );
    // the green calyx on top: five pointed sepals, one triangle each
    const top = add(hangTo, [0, r * 0.9 + 0.0006, 0]);
    const ctr = F.vertex({ p: add(top, [0, 0.0014, 0]), c: C(0x4f7f2a), s: swq }, [0, 1, 0]);
    const a0 = rng() * TAU;
    const tipR = 0.0105 * (0.8 + 0.4 * scale);
    for (let k = 0; k < 5; k++) {
      const a = a0 + (TAU * k) / 5;
      const b1 = F.vertex({ p: add(top, [Math.cos(a + 0.5) * 0.0035, 0.0003, Math.sin(a + 0.5) * 0.0035]), c: C(0x5a8a30), s: swq }, [0, 1, 0]);
      const tp = F.vertex({ p: add(top, [Math.cos(a) * tipR, -0.0035, Math.sin(a) * tipR]), c: C(0x6a9a3a), s: swq }, norm([Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3]));
      F.tri(ctr, b1, tp);
    }
  }
}

/** Sweet potato: trailing vines with heart-shaped leaves, spilling over the edge; when ripe, purple tubers showing at the soil. */
function sweetPotato(cx: Ctx, slips: V3[], g: number, rim: Rim): void {
  const { rng, th, leaves: L, fruit: F } = cx;
  const kL = cx.hi ? 1 : 1.55;
  const vineCol = (t: number, a: number): C3 => mixC(C(0x6a9440), C(0x8a5268), 0.2 + 0.3 * noise(t * 6, a, 3));
  /** A leaf on its stalk: the stalk rises from the vine, the heart blade is held out level at its top. */
  const heart = (at: V3, yaw: number, stalkPitch: number, stalk: number, bladePitch: number, arch: number, size: number, sway: number, swayBase: number, age: number): void => {
    const sp = stalkPitch - th * 0.5;
    const top = add(at, scl(dirOf(yaw, sp), stalk));
    // the stalk droops a little at its top when thirsty
    tubeAlong(L, [at, top], { nu: 3, r: (t) => 0.0016 * (1 - 0.3 * t), col: (t) => mixC(C(0x6f9a4a), C(0x8a5068), 0.3 * (1 - t)), sway: (t) => mix(swayBase, sway * 0.7, t), yellow: th * 0.4 });
    leaf(L, {
      at: top,
      yaw: yaw + jitter(rng, 0.3),
      pitch: bladePitch - th * 1.1,
      arch: arch + th * 0.7,
      len: size,
      back: HEART_JOIN,
      cell: rng() < 0.25 ? CELL.heartLobed : CELL.heart,
      fold: 0.12 + 0.45 * th,
      roll: jitter(rng, 0.3),
      tint: leafTint(rng),
      sway,
      swayBase: sway * 0.7,
      rows: 4,
      yellow: [th * (0.4 + 0.3 * age), th * (0.75 + 0.25 * age)],
    });
  };
  slips.forEach((sp, si) => {
    const a0 = rng() * TAU;
    if (g < 0.1) {
      // a slip: a cut length of vine pushed into the soil, with a few young leaves
      const pts: V3[] = [];
      for (let j = 0; j <= 4; j++) {
        const t = j / 4;
        pts.push(add(sp, [Math.cos(a0) * 0.02 * t * t, -0.02 + 0.075 * t - th * 0.015 * t * t, Math.sin(a0) * 0.02 * t * t]));
      }
      tubeAlong(L, pts, { nu: 3, r: (t) => 0.0028 * (1 - 0.3 * t), col: vineCol, sway: (t) => 0.002 * t, yellow: th * 0.3 });
      const top = pts[pts.length - 1];
      for (let q = 0; q < 3; q++) heart(add(top, [0, -0.008 * q, 0]), a0 + q * 2.2, 0.9, 0.018, 0.3, 0.4, 0.045 - 0.005 * q, 0.004, 0.002, q / 2);
      return;
    }
    const nv = cx.hi ? 3 + Math.round(4 * g) : 3 + Math.round(g);
    for (let v = 0; v < nv; v++) {
      const a = a0 + (v * TAU) / nv + jitter(rng, 0.35);
      const want = (cx.hi ? 0.07 + 0.36 * g : 0.08 + 0.62 * g) * (0.75 + 0.5 * rng());
      const hangMax = rim.hang * (0.55 + 0.45 * rng());
      const ph = rng() * 50;
      // wander out across the soil, up over the wall, and down the outside
      const raw: V3[] = [add(sp, [0, -0.01, 0])];
      let x = sp[0];
      let z = sp[2];
      let head = a;
      let state: 'soil' | 'over' | 'hang' = 'soil';
      let over = 0;
      let hung = 0;
      let overAt = 0;
      let outward: V3 = [Math.cos(a), 0, Math.sin(a)];
      const step = 0.015;
      for (let s = step; s <= want + 1e-6; s += step) {
        if (state === 'soil') {
          const d = rim.dist(x, z, head);
          if (d < step) {
            state = 'over';
            overAt = s;
            outward = [Math.cos(head), 0, Math.sin(head)];
          } else {
            head += (noise(s * 4, 0.5, ph) - 0.5) * 7 * step * (cx.hi ? 0.6 : 1);
            x += Math.cos(head) * step;
            z += Math.sin(head) * step;
            const soilY = 0.01 + 0.014 * Math.exp(-s / 0.03) + 0.003 * Math.sin(s * 23 + ph);
            raw.push([x, mix(soilY, rim.top + 0.004, smooth(0.06, 0.012, d)), z]);
            continue;
          }
        }
        if (state === 'over') {
          over += step;
          x += outward[0] * step;
          z += outward[2] * step;
          raw.push([x, rim.top + 0.0045, z]);
          if (over > rim.width) state = 'hang';
          continue;
        }
        hung += step;
        if (hung > hangMax) break;
        const out = 0.006 + 0.035 * (1 - Math.exp(-hung / 0.05));
        raw.push([x + outward[0] * out, rim.top - hung, z + outward[2] * out]);
      }
      if (raw.length < 3) continue;
      // the growing tip turns up
      const last = raw[raw.length - 1];
      raw.push(add(last, hung > 0 ? add(scl(outward, 0.012), [0, 0.006, 0]) : [Math.cos(head) * 0.01, 0.012, Math.sin(head) * 0.01]));
      const pts = resample(relax(raw, 2), cx.hi ? 10 : 9);
      const total = polyLength(pts);
      const edgeD = overAt > 0 ? overAt : Infinity;
      const swayAt = (d: number): number => 0.0015 + 0.05 * Math.max(0, d - edgeD - rim.width);
      tubeAlong(L, pts, { nu: 3, r: (t) => 0.0032 * (1 - 0.4 * t), col: vineCol, sway: (t) => swayAt(t * total), yellow: th * 0.3 });
      // leaves at the nodes, held up on their stalks; facing outward where the vine hangs
      const spacing = cx.hi ? 0.038 : 0.1;
      let side = rng() < 0.5 ? 1 : -1;
      for (let d = 0.035; d < total - 0.01; d += spacing * (0.85 + 0.3 * rng())) {
        const { p, t } = along(pts, d);
        if (d > edgeD - 0.015 && d < edgeD + rim.width + 0.015) continue;
        side = -side;
        const heading = Math.atan2(t[2], t[0]);
        const size = kL * (0.055 + 0.04 * g) * (0.85 + 0.3 * rng()) * (1 - 0.3 * smooth(total * 0.6, total, d));
        const age = 1 - d / total;
        const sw = swayAt(d);
        if (d > edgeD + rim.width) heart(p, Math.atan2(outward[2], outward[0]) + side * (0.4 + 0.4 * rng()), 0.25, size * 0.45, 1.05, 0.7, size, sw + 0.01, sw, age);
        else heart(p, heading + side * (1.0 + 0.6 * rng()), 1.15 + jitter(rng, 0.2), size * (0.5 + 0.3 * rng()), 0.15 + jitter(rng, 0.15), 0.5, size, 0.006, sw, age);
      }
    }
    // a few leaves at the crown on tall stalks make it lush
    if (g >= 0.45) {
      const n = cx.hi ? 3 : 2;
      for (let q = 0; q < n; q++) heart(add(sp, [0, 0.01, 0]), a0 + 0.5 + (q * TAU) / n, 1.25, kL * (0.06 + 0.04 * g), 0.2, 0.5, kL * (0.06 + 0.04 * g), 0.007, 0.001, 0.3);
    }
    // ripe: purple-skinned tubers pushing up out of the soil by the crown
    if (cx.ripe && g >= 0.7) {
      const n = cx.hi ? 2 : si === 0 ? 2 : 1;
      for (let q = 0; q < n; q++) {
        const ta = a0 + 0.9 + q * 2.6 + jitter(rng, 0.3);
        const c: V3 = add(sp, [Math.cos(ta) * (0.045 + 0.015 * rng()), 0.002, Math.sin(ta) * (0.045 + 0.015 * rng())]);
        const ax = norm([Math.cos(ta + 1.3), -0.28, Math.sin(ta + 1.3)]);
        const Lt = (cx.hi ? 0.11 : 0.13) * (0.9 + 0.2 * rng());
        const R = (cx.hi ? 0.026 : 0.03) * (0.9 + 0.2 * rng());
        const seed = rng() * 50;
        const nn = cx.hi ? 8 : 6;
        lump(
          F,
          c,
          ax,
          Lt,
          nn,
          nn,
          (t, a) => R * Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.62) * (1 + 0.07 * Math.sin(t * 9 + a * 2) + 0.05 * (noise(t * 6, a, seed) - 0.5)),
          (t, a) => {
            let col = mixC(C(0x6a2a3e), C(0x8e4652), noise(t * 5, a * 1.5, seed + 2));
            // soil still clinging underneath and toward the buried end
            const dirt = smooth(-0.2, 0.9, Math.sin(a)) * 0.55 + smooth(0.6, 1, t) * 0.4;
            col = mixC(col, C(0x4e3a2a), clamp(dirt, 0, 0.8));
            return col;
          },
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// One plant (or a bed's worth), at one stage
// ---------------------------------------------------------------------------

export interface PlantBuild {
  leaves: Mesher;
  fruit: Mesher;
}

/**
 * Builds a crop at growth g (0..1), thirst th (0..1) and ripeness, for a
 * pot or a bed. `seed` varies the details so neighbouring plants differ.
 */
export function buildPlant(crop: CropKind, size: PlantSize, g: number, th: number, ripe: boolean, seed: number): PlantBuild {
  const cx: Ctx = { leaves: new Mesher(), fruit: new Mesher(), rng: mulberry32(seed * 7919 + 17), th: clamp(th, 0, 1), ripe, hi: size === 'pot' };
  const gg = clamp(g, 0, 1);
  if (crop === 'callaloo') {
    if (size === 'pot') callaloo(cx, [0, 0, 0], 0.85, gg, (seed & 1) === 1);
    else {
      const spots: [number, number][] = [
        [-0.56, -0.14],
        [-0.19, 0.15],
        [0.19, -0.14],
        [0.56, 0.15],
      ];
      spots.forEach(([x, z], i) => callaloo(cx, [x + jitter(cx.rng, 0.04), 0, z + jitter(cx.rng, 0.04)], 1, gg, ((seed + i) & 1) === 1));
    }
  } else if (crop === 'tomato') {
    if (size === 'pot') tomato(cx, [0, 0, 0], 0.66, gg);
    else for (const x of [-0.4, 0.4]) tomato(cx, [x + jitter(cx.rng, 0.04), 0, jitter(cx.rng, 0.05)], 1, gg);
  } else {
    if (size === 'pot') sweetPotato(cx, [[0, 0, 0]], gg, POT_RIM);
    else sweetPotato(cx, [[-0.38, 0, jitter(cx.rng, 0.06)], [0.38, 0, jitter(cx.rng, 0.06)]], gg, BED_RIM);
  }
  return { leaves: cx.leaves, fruit: cx.fruit };
}
