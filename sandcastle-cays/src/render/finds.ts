/**
 * Beachcombing finds and the woven basket, modelled in code ("slightly
 * storybook", DECISIONS 13): simple, rounded and warm, with smooth normals.
 *
 * Every model is built at real-life size in metres, +Y up, with its origin
 * at the point where it rests on the sand (centred in X and Z, lowest point
 * at y = 0), lying the way it would on a beach. Geometries, materials and the
 * few code-painted textures (DECISIONS 14) are built once per kind and shared;
 * `findModel` returns a new Object3D each call that reuses them.
 *
 * Budget: each find is at most 700 triangles and 2 materials; the basket is
 * at most 2500 triangles and 1 material. Textures are small DataTextures
 * (no canvas), so everything also builds in Node for the tests.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FindKind } from '../content/finds';

type V3 = [number, number, number];
type C3 = [number, number, number];
interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
}

// ---------------------------------------------------------------------------
// Small maths and colour helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const fract = (x: number): number => x - Math.floor(x);
/** Smoothstep from e0 to e1 (e0 may be larger than e1 for a falling edge). */
function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const steps = (n: number): number[] => Array.from({ length: n + 1 }, (_, i) => i / n);

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.sqrt(dot(a, a));
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 0 ? scl(a, 1 / l) : [0, 1, 0];
};

function hash(i: number, j: number, seed: number): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Smooth value noise in [0, 1]. With px / py > 0 it repeats every px / py units. */
function noise(x: number, y: number, seed: number, px = 0, py = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (i: number, j: number): number =>
    hash(px > 0 ? ((i % px) + px) % px : i, py > 0 ? ((j % py) + py) % py : j, seed);
  return mix(mix(w(xi, yi), w(xi + 1, yi), sx), mix(w(xi, yi + 1), w(xi + 1, yi + 1), sx), sy);
}
function fbm(x: number, y: number, seed: number, oct = 3, px = 0, py = 0): number {
  let s = 0;
  let amp = 0.5;
  let tot = 0;
  let f = 1;
  for (let o = 0; o < oct; o++) {
    s += amp * noise(x * f, y * f, seed + o * 17, px * f, py * f);
    tot += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / tot;
}

const _c = new THREE.Color();
/** sRGB hex to linear RGB (vertex colours are linear). */
function lin(hex: number): C3 {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
}
/** sRGB hex to sRGB 0..1 (painted textures are stored as sRGB). */
function srgb(hex: number): C3 {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
const mixC = (a: C3, b: C3, t: number): C3 => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const mulC = (a: C3, k: number): C3 => [a[0] * k, a[1] * k, a[2] * k];
/** Mix through a list of colours, t in [0, 1]. */
function ramp(cols: C3[], t: number): C3 {
  const x = clamp(t, 0, 1) * (cols.length - 1);
  const i = Math.min(Math.floor(x), cols.length - 2);
  return mixC(cols[i], cols[i + 1], x - i);
}

// ---------------------------------------------------------------------------
// Geometry builders: parametric grids with smooth, exact normals
// ---------------------------------------------------------------------------

interface GridSpec {
  /** Sample positions across (u) and along (v), each in [0, 1]. */
  us: number[];
  vs: number[];
  pos: (u: number, v: number) => V3;
  col?: (u: number, v: number, p: V3, n: V3) => C3;
  uv?: (u: number, v: number, p: V3) => [number, number];
  /** u = 0 and u = 1 are the same place (a closed loop). */
  wrapU?: boolean;
  /** Turn the surface inside out (if dP/du x dP/dv points inwards). */
  flip?: boolean;
}

/** Normal of a parametric surface by central differences, so it stays smooth across seams and low-poly rows. */
function gridNormal(s: GridSpec, u: number, v: number, nested = false): V3 {
  const e = 1e-4;
  const ua = s.wrapU ? u - e : Math.max(0, u - e);
  const ub = s.wrapU ? u + e : Math.min(1, u + e);
  const va = Math.max(0, v - e);
  const vb = Math.min(1, v + e);
  const du = sub(s.pos(ub, v), s.pos(ua, v));
  const dv = sub(s.pos(u, vb), s.pos(u, va));
  const n = cross(du, dv);
  const ln = len(n);
  const scale = len(du) * len(dv);
  if (scale === 0 || ln <= 1e-6 * scale) {
    // A pole: average the normals of a ring just beside it.
    if (nested) return [0, 0, 0];
    const vv = v < 0.5 ? v + 0.004 : v - 0.004;
    let acc: V3 = [0, 0, 0];
    for (let k = 0; k < 12; k++) acc = add(acc, gridNormal(s, (k + 0.5) / 12, vv, true));
    return norm(acc);
  }
  return scl(n, (s.flip ? -1 : 1) / ln);
}

function grid(s: GridSpec): THREE.BufferGeometry {
  const nu = s.us.length;
  const nv = s.vs.length;
  const P = new Float32Array(nu * nv * 3);
  const N = new Float32Array(nu * nv * 3);
  const C = new Float32Array(nu * nv * 3);
  const UV = new Float32Array(nu * nv * 2);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const u = s.us[i];
      const v = s.vs[j];
      const k = j * nu + i;
      const p = s.pos(u, v);
      const n = gridNormal(s, u, v);
      const c = s.col ? s.col(u, v, p, n) : ([1, 1, 1] as C3);
      const t = s.uv ? s.uv(u, v, p) : [u, v];
      P.set(p, k * 3);
      N.set(n, k * 3);
      C.set(c, k * 3);
      UV.set(t, k * 2);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      const b = a + 1;
      const c = a + nu;
      const d = c + 1;
      if (s.flip) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  g.setIndex(idx);
  return g;
}

interface TubeSpec {
  /** Centreline, t in [0, 1]. */
  path: (t: number) => V3;
  /** Radius at t, at angle a around the centreline (a = 0 is the side, a = -pi/2 the top). */
  radius: (t: number, a: number) => number;
  nu: number;
  /** Body rows, as t values in [0, 1]. */
  ts: number[];
  /** Extra rows for rounded end caps at the start and end (0 = open end). */
  caps?: [number, number];
  /** How far a cap bulges, as a share of the radius (1 = a half sphere). */
  capLen?: number;
  /** Reference "up" for the cross-section frame; must never be parallel to the path. */
  ref?: V3;
  closed?: boolean;
  col?: (t: number, a: number, p: V3, n: V3) => C3;
  uv?: (t: number, a: number, p: V3) => [number, number];
}

function tube(s: TubeSpec): THREE.BufferGeometry {
  const [c0, c1] = s.caps ?? [0, 0];
  const CAP = 0.08;
  const v0 = c0 ? CAP : 0;
  const v1 = c1 ? 1 - CAP : 1;
  const ref = s.ref ?? [0, 1, 0];
  const capLen = s.capLen ?? 0.8;
  const P = (t: number): V3 => s.path(s.closed ? fract(t) : clamp(t, 0, 1));
  const at = (v: number): { t: number; k: number; ax: number } => {
    if (v < v0) {
      const al = (v / v0) * (Math.PI / 2);
      return { t: 0, k: Math.sin(al), ax: -capLen * Math.cos(al) };
    }
    if (v > v1) {
      const al = ((1 - v) / (1 - v1)) * (Math.PI / 2);
      return { t: 1, k: Math.sin(al), ax: capLen * Math.cos(al) };
    }
    return { t: v1 > v0 ? (v - v0) / (v1 - v0) : 0, k: 1, ax: 0 };
  };
  const frame = (t: number): [V3, V3, V3] => {
    const e = 1e-3;
    const T = norm(sub(P(t + e), P(t - e)));
    const side = norm(cross(T, ref));
    const up = cross(side, T);
    return [T, side, up];
  };
  const pos = (u: number, v: number): V3 => {
    const { t, k, ax } = at(v);
    const a = TAU * u;
    const [T, side, up] = frame(t);
    const r = s.radius(t, a);
    const dir = sub(scl(side, Math.cos(a)), scl(up, Math.sin(a)));
    return add(add(P(t), scl(T, ax * r)), scl(dir, r * k));
  };
  const vs: number[] = [];
  for (let i = 0; i < c0; i++) vs.push((i / c0) * v0);
  for (const t of s.ts) vs.push(v0 + t * (v1 - v0));
  for (let i = c1 - 1; i >= 0; i--) vs.push(1 - (i / c1) * (1 - v1));
  return grid({
    us: steps(s.nu),
    vs,
    pos,
    wrapU: true,
    col: s.col ? (u, v, p, n) => s.col!(at(v).t, TAU * u, p, n) : undefined,
    uv: s.uv ? (u, v, p) => s.uv!(at(v).t, TAU * u, p) : undefined,
  });
}

/** Adds a flat vertex colour (and a uv set if missing) to a three.js primitive so it can merge with grids. */
function prim(g: THREE.BufferGeometry, col: C3): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(col, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

/**
 * Rotates the parts into their resting pose, then moves them so the lowest
 * point is at y = 0 and the middle is over x = z = 0. Parts sharing a
 * material are merged into one geometry (one draw call).
 */
function place(parts: Part[], rot?: { x?: number; y?: number; z?: number }): Part[] {
  if (rot) {
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot.x ?? 0, rot.y ?? 0, rot.z ?? 0));
    for (const p of parts) p.geo.applyMatrix4(m);
  }
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const p of parts) {
    const list = byMat.get(p.mat) ?? [];
    list.push(p.geo);
    byMat.set(p.mat, list);
  }
  const out: Part[] = [];
  for (const [mat, geos] of byMat) {
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos);
    if (!geo) throw new Error('finds: could not merge geometries');
    out.push({ geo, mat });
  }
  const box = new THREE.Box3();
  for (const p of out) {
    p.geo.computeBoundingBox();
    box.union(p.geo.boundingBox!);
  }
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  for (const p of out) {
    p.geo.translate(-cx, -box.min.y, -cz);
    p.geo.computeBoundingBox();
    p.geo.computeBoundingSphere();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Code-painted textures (DECISIONS 14): small, shared DataTextures
// ---------------------------------------------------------------------------

const texCache = new Map<string, THREE.DataTexture>();
const matCache = new Map<string, THREE.Material>();

interface PaintOpts {
  wrapU?: boolean;
  wrapV?: boolean;
}

/** Paints a w x h RGBA texture; fn gets (u, v) in [0, 1] and returns sRGB colour 0..1 (and optional alpha). */
function paint(key: string, w: number, h: number, fn: (u: number, v: number) => number[], opts: PaintOpts = {}): THREE.DataTexture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const data = new Uint8Array(w * h * 4);
  const acc = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 2 x 2 samples per texel, so painted edges come out smooth
      acc.fill(0);
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const c = fn((x + 0.25 + 0.5 * sx) / w, (y + 0.25 + 0.5 * sy) / h);
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
          acc[3] += c.length > 3 ? c[3] : 1;
        }
      }
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) data[o + k] = clamp(Math.round(acc[k] * 63.75), 0, 255);
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.name = `finds:${key}`;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = opts.wrapU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = opts.wrapV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  texCache.set(key, t);
  return t;
}

function material<M extends THREE.Material>(key: string, make: () => M): M {
  const hit = matCache.get(key);
  if (hit) return hit as M;
  const m = make();
  m.name = `finds:${key}`;
  matCache.set(key, m);
  return m;
}

/** Matte vertex-coloured surfaces (scallop-like shells, plastic). */
const matteVC = (): THREE.MeshStandardMaterial =>
  material('matteVC', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 }));
/** Glossy vertex-coloured surfaces (tellin, sea bean). */
const glossyVC = (): THREE.MeshPhysicalMaterial =>
  material(
    'glossyVC',
    () => new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.18 }),
  );

/** Weathered wood grain, greyscale (vertex colours tint it). Streaks run along u. */
function grainTex(): THREE.DataTexture {
  return paint(
    'grain',
    128,
    64,
    (u, v) => {
      const warp = 0.55 * fbm(u * 2, v * 3, 47, 2, 2, 3);
      const q = fract(v * 7 + warp);
      const dl = Math.abs(q - 0.5);
      let g = 0.84 + 0.16 * fbm(u * 2, v * 20, 41, 3, 2, 20) + 0.06 * (noise(u * 8, v * 64, 43, 8, 64) - 0.5);
      g *= 1 - 0.2 * smooth(0.1, 0.02, dl);
      // a few deeper checks (cracks along the grain)
      const crack = smooth(0.82, 0.9, noise(u * 3, v * 40, 53, 3, 40)) * smooth(0.04, 0.0, Math.abs(fract(v * 13 + warp * 2) - 0.5));
      g *= 1 - 0.45 * crack;
      return [g, g * 0.985, g * 0.965];
    },
    { wrapU: true, wrapV: true },
  );
}
const woodMat = (): THREE.MeshStandardMaterial =>
  material('wood', () => new THREE.MeshStandardMaterial({ vertexColors: true, map: grainTex(), roughness: 0.92, metalness: 0 }));

/** Three-strand laid rope, greyscale. u runs along the rope (one tile = one full twist), v around it. */
function ropeTex(): THREE.DataTexture {
  return paint(
    'rope',
    32,
    32,
    (u, v) => {
      const f = fract(u - 3 * v);
      let g = 0.5 + 0.5 * Math.pow(Math.sin(Math.PI * f), 0.55);
      g *= 0.9 + 0.1 * noise(f * 12, (u + v / 3) * 4, 61, 12, 0);
      return [g, g, g];
    },
    { wrapU: true, wrapV: true },
  );
}
const ropeMat = (): THREE.MeshStandardMaterial =>
  material('rope', () => new THREE.MeshStandardMaterial({ vertexColors: true, map: ropeTex(), roughness: 0.95, metalness: 0 }));

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

/** Measled cowrie: a glossy brown dome sprinkled with white spots, lying dome-up. */
function cowrie(): Part[] {
  const L = 0.0375;
  const W = 0.0245;
  const HT = 0.031;
  const HB = 0.0055;
  // Texture u is squeezed underneath and stretched on top, where it shows.
  const SQ = 0.6;
  const toTex = (u: number): number => u - (SQ * Math.sin(TAU * u)) / TAU;
  const fromTex = (t: number): number => {
    let u = t;
    for (let i = 0; i < 6; i++) u -= (toTex(u) - t) / (1 - SQ * Math.cos(TAU * u));
    return u;
  };
  const geo = grid({
    us: steps(24),
    vs: steps(12),
    wrapU: true,
    uv: (u, v) => [toTex(u), v],
    pos: (u, v) => {
      const a = TAU * u + Math.PI; // u = 0 underneath, u = 0.5 on top
      const sv = Math.sin(Math.PI * v);
      const t = -Math.cos(Math.PI * v);
      const prof = Math.pow(Math.max(sv, 0), 0.62);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      if (ca >= 0) return [L * t, ca * prof * HT * (1 - 0.07 * t), sa * prof * W];
      return [L * t, ca * prof * HB, sa * prof * W * (1 + 0.05 * -ca)];
    },
  });
  const tex = paint(
    'cowrie',
    128,
    128,
    (tu, v) => {
      const u = fromTex(tu);
      const ang = Math.abs(u - 0.5) * 2; // 0 on top, 1 underneath
      if (ang > 0.52) {
        let c = mixC(srgb(0xd8b48a), srgb(0xb88b5c), smooth(0.6, 0.92, ang));
        const nearSlit = smooth(0.88, 0.96, ang) * smooth(0.02, 0.12, v) * smooth(0.98, 0.88, v);
        const teeth = smooth(0.2, 0.7, 0.5 + 0.5 * Math.cos(v * TAU * 24));
        c = mixC(c, mixC(srgb(0x6a3f22), srgb(0x3a2212), smooth(0.96, 0.995, ang)), nearSlit * (0.45 + 0.55 * teeth));
        return c;
      }
      let c = ramp([srgb(0x4e2810), srgb(0x6f3c1d), srgb(0x9a6236)], smooth(0.0, 0.5, ang));
      c = mulC(c, 0.88 + 0.24 * fbm(u * 12, v * 6, 3, 3, 12, 0));
      // spots, on a jittered grid that wraps around the shell
      const CU = 15;
      const CV = 8;
      const su = u * CU;
      const sv = v * CV;
      const iu = Math.floor(su);
      const iv = Math.floor(sv);
      let spot = 0;
      let eye = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ci = iu + di;
          const cj = iv + dj;
          const wi = ((ci % CU) + CU) % CU;
          const cx = ci + 0.15 + 0.7 * hash(wi, cj, 11);
          const cy = cj + 0.15 + 0.7 * hash(wi, cj, 12);
          const rr = 0.22 + 0.14 * hash(wi, cj, 13);
          const dx = (su - cx) * 0.9;
          const dy = sv - cy;
          const d = Math.sqrt(dx * dx + dy * dy) / rr;
          spot = Math.max(spot, smooth(1.0, 0.8, d));
          eye = Math.max(eye, smooth(0.5, 0.38, d));
        }
      }
      // and a scattering of small ones in between
      {
        const su2 = u * 34;
        const sv2 = v * 17;
        const i2 = Math.floor(su2);
        const j2 = Math.floor(sv2);
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ci = i2 + di;
            const cj = j2 + dj;
            const wi = ((ci % 34) + 34) % 34;
            if (hash(wi, cj, 14) < 0.45) continue;
            const dx = (su2 - (ci + 0.2 + 0.6 * hash(wi, cj, 15))) * 0.9;
            const dy = sv2 - (cj + 0.2 + 0.6 * hash(wi, cj, 16));
            spot = Math.max(spot, 0.8 * smooth(0.26, 0.17, Math.sqrt(dx * dx + dy * dy)));
          }
        }
      }
      const ocell = smooth(0.26, 0.38, ang); // low on the sides the spots have dark centres
      c = mixC(c, mixC(srgb(0xf6e8cb), srgb(0xe9cfa4), smooth(0.2, 0.45, ang)), spot * 0.9);
      c = mixC(c, srgb(0x3a1c0c), eye * ocell);
      return mulC(c, 1 - 0.3 * (smooth(0.14, 0, v) + smooth(0.86, 1, v)));
    },
    { wrapU: true },
  );
  const mat = material(
    'cowrie',
    () => new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.28, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 }),
  );
  return place([{ geo, mat }]);
}

/** Calico scallop: one fan-ribbed valve with ears, lying convex side up, mottled red, purple, orange and white. */
function scallop(): Part[] {
  const rho = 0.0265;
  const d = 0.9 * rho;
  const earW = 0.62 * rho;
  const H = 0.0105;
  const DISC = 1.3;
  const RIBS = 18;
  const PHI = Math.PI / 2;
  const ribAt = (phi: number): number => {
    const ap = Math.abs(phi);
    if (ap >= DISC) return 0;
    const ph = ((phi + DISC) / (2 * DISC)) * RIBS;
    return (0.5 - 0.5 * Math.cos(TAU * ph)) * smooth(DISC, DISC - 0.1, ap);
  };
  const outline = (phi: number): number => {
    const s = Math.sin(phi);
    const circ = d * Math.cos(phi) + Math.sqrt(Math.max(0, rho * rho - d * d * s * s));
    const ear = Math.abs(phi) > 1.0 ? earW / Math.max(Math.abs(s), 0.05) : 0;
    return Math.max(circ, ear) * (1 + 0.035 * ribAt(phi));
  };
  const phis: number[] = [];
  for (let k = 0; k <= 3; k++) phis.push(-PHI + ((PHI - DISC) * k) / 3);
  for (let k = 1; k <= RIBS * 3; k++) phis.push(-DISC + (2 * DISC * k) / (RIBS * 3));
  for (let k = 1; k <= 3; k++) phis.push(DISC + ((PHI - DISC) * k) / 3);
  const geo = grid({
    us: phis.map((p) => (p + PHI) / (2 * PHI)),
    vs: [0, 0.22, 0.45, 0.68, 0.86, 1],
    flip: true,
    pos: (u, s) => {
      const phi = -PHI + 2 * PHI * u;
      const r = s * outline(phi);
      const earness = smooth(1.05, 1.4, Math.abs(phi));
      const hump = Math.pow(Math.max(0, Math.sin(Math.PI * (0.1 + 0.9 * s))), 0.55);
      const y = H * hump * (1 - 0.82 * earness * smooth(0, 0.45, s)) + 0.0013 * ribAt(phi) * Math.pow(s, 0.6);
      return [r * Math.sin(phi), y, r * Math.cos(phi)];
    },
  });
  const cream = srgb(0xf3e7d5);
  const hues = [srgb(0xa22c46), srgb(0x7b3566), srgb(0xc9643a), srgb(0xe2b24a), srgb(0xa22c46)];
  const tex = paint('scallop', 128, 64, (u, s) => {
    const phi = -PHI + 2 * PHI * u;
    const rib = ribAt(phi);
    const n = fbm(u * 7, s * 4, 21) + 0.12 * Math.sin(s * 26 + 6 * fbm(u * 4, s * 2, 5));
    const hue = ramp(hues, noise(u * 3, s * 2.2, 31));
    let c = mixC(cream, hue, smooth(0.38, 0.5, n));
    // small white flecks scattered on the coloured patches
    const fleck = smooth(0.7, 0.8, noise(u * 34, s * 12, 77));
    c = mixC(c, cream, fleck * 0.75);
    c = mixC(c, mixC(hues[1], hues[0], 0.5), smooth(0.14, 0.02, s) * 0.85); // purple-red umbo
    const inDisc = smooth(DISC + 0.02, DISC - 0.08, Math.abs(phi));
    return mulC(c, 1 - inDisc * (0.2 - 0.26 * rib));
  });
  const mat = material('scallop', () => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.62, metalness: 0 }));
  return place([{ geo, mat }]);
}

/** Six-holed keyhole sand dollar: a bleached, gently domed disc with a five-petal flower and six slots. */
function sandDollar(): Part[] {
  const R = 0.049;
  const HC = 0.0068;
  const E = 0.0011;
  const TOPV = 0.62;
  const RIMV = 0.82;
  const outlineK = (th: number): number => 1 + 0.022 * Math.cos(2 * th) - 0.012 * Math.sin(th);
  const pos = (u: number, v: number): V3 => {
    const th = TAU * u;
    let r: number;
    let y: number;
    if (v <= TOPV) {
      const rn = v / TOPV;
      r = (R - E) * rn;
      y = 2 * E + (HC - 2 * E) * (1 - Math.pow(rn, 2.2));
    } else if (v <= RIMV) {
      const al = Math.PI / 2 - (Math.PI * (v - TOPV)) / (RIMV - TOPV);
      r = R - E + E * Math.cos(al);
      y = E + E * Math.sin(al);
    } else {
      r = (R - E) * (1 - (v - RIMV) / (1 - RIMV));
      y = 0;
    }
    r *= outlineK(th);
    return [r * Math.cos(th), y, r * Math.sin(th)];
  };
  const S = 2.2 * R;
  const geo = grid({
    us: steps(36),
    vs: [0, 0.16, 0.32, 0.47, TOPV, 0.72, RIMV, 0.91, 1],
    wrapU: true,
    pos,
    uv: (_u, _v, p) => [0.5 + p[0] / S, 0.5 + p[2] / S],
  });
  const bone = srgb(0xf2ebdc);
  const pore = srgb(0xbfb39d);
  const petalIn = srgb(0xe7dfcf);
  const petalAngles = [0, 1, 2, 3, 4].map((k) => Math.PI / 2 + (k * TAU) / 5);
  const tex = paint('sand-dollar', 128, 128, (tu, tv) => {
    const px = (tu - 0.5) * S;
    const pz = (tv - 0.5) * S;
    const r = Math.hypot(px, pz) / R;
    const th = Math.atan2(pz, px);
    let c = mulC(bone, 0.97 + 0.05 * noise(tu * 90, tv * 90, 5) - 0.02 * hash(Math.floor(tu * 128), Math.floor(tv * 128), 9));
    let alpha = 1;
    const slot = (a: number, b: number, a0: number, a1: number, w: number): number => {
      const da = Math.max(a0 - a, 0, a - a1);
      return Math.hypot(da, b) / w;
    };
    for (let k = 0; k < 5; k++) {
      const rel = th - petalAngles[k];
      const a = r * Math.cos(rel);
      const b = r * Math.sin(rel);
      // petal: two rows of pores on an elongated leaf shape
      const a0 = 0.07;
      const a1 = k === 2 || k === 3 ? 0.62 : 0.57;
      if (a > a0 - 0.02 && a < a1 + 0.02) {
        const w = 0.115 * Math.pow(Math.max(0, Math.sin((Math.PI * (a - a0)) / (a1 - a0))), 0.75);
        const ab = Math.abs(b);
        if (ab < w - 0.022) c = mixC(c, petalIn, 0.8);
        const band = smooth(0.03, 0.012, Math.abs(ab - (w - 0.012)));
        const dots = smooth(0.25, 0.65, 0.5 + 0.5 * Math.cos(a * TAU * 38));
        c = mixC(c, pore, band * (0.35 + 0.65 * dots));
      }
      // the five slots beyond the petal tips
      const d = slot(a, b, 0.7, 0.84, 0.033);
      if (d < 1) alpha = 0;
      c = mixC(c, mulC(bone, 0.86), smooth(1.7, 1.0, d));
    }
    // the sixth, longer slot between the two back petals
    {
      const rel = th + Math.PI / 2;
      const d = slot(r * Math.cos(rel), r * Math.sin(rel), 0.4, 0.72, 0.034);
      if (d < 1) alpha = 0;
      c = mixC(c, mulC(bone, 0.86), smooth(1.7, 1.0, d));
    }
    c = mixC(c, srgb(0xcfc4ae), smooth(0.05, 0.0, r) * 0.9); // the small star in the middle
    c = mixC(c, mulC(bone, 0.93), smooth(0.9, 1.0, r)); // thin, slightly grey edge
    return [...c, alpha];
  });
  const mat = material('sand-dollar', () => new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.88, metalness: 0 }));
  return place([{ geo, mat }]);
}

/**
 * Bleeding tooth nerite, lying with its opening up: a D-shaped opening, and
 * along its straight inner edge two white teeth in a blood-red blotch. The
 * outside is cream with black and red zigzags.
 */
function nerite(): Part[] {
  const RX = 0.0145;
  const RZ = 0.012;
  const HF = 0.0128;
  const FACEV = 0.45;
  // Face coordinates (a, b) on the unit disc. The opening is the part beyond
  // the straight inner edge b = edge(a), inside the thick outer lip.
  const edge = (a: number): number => -0.04 + 0.1 * a * a;
  const LIP = 0.7;
  const openDist = (a: number, b: number): number => Math.min(LIP - Math.hypot(a, b * 1.08), b - edge(a));
  const pos = (u: number, v: number): V3 => {
    const th = TAU * u;
    const ca = Math.cos(th);
    const sa = Math.sin(th);
    if (v <= FACEV) {
      const rn = v / FACEV;
      const a = rn * ca;
      const b = rn * sa;
      let y = HF - 0.0042 * smooth(0, 0.22, openDist(a, b));
      y += 0.0006 * smooth(edge(a), edge(a) - 0.3, b) * (1 - rn * rn); // the callus swells a little
      y -= 0.002 * smooth(0.8, 1, rn) ** 2; // rounded rim
      return [RX * a, y, RZ * b];
    }
    const be = ((v - FACEV) / (1 - FACEV)) * (Math.PI / 2);
    const k = Math.pow(Math.cos(be), 0.8);
    const spire = 0.0018 * Math.exp(-(((th - Math.PI) / 0.45) ** 2) - ((be - 0.5) / 0.3) ** 2);
    return [(RX + spire) * ca * k, (HF - 0.002) * (1 - Math.sin(be)), RZ * sa * k];
  };
  const geo = grid({
    us: steps(24),
    vs: [0, 0.07, 0.14, 0.21, 0.28, 0.35, 0.4, FACEV, 0.56, 0.68, 0.8, 0.9, 1],
    wrapU: true,
    pos,
  });
  // outside: grey-cream with black and red zigzag stripes and low spiral ridges
  const outside = (u: number, be: number): C3 => {
    const zig = Math.abs(fract(be * 3.5) - 0.5) * 0.8;
    const q = u * 22 + zig;
    const f = fract(q);
    const dark = Math.floor(q) % 3 === 0 ? srgb(0x9e3226) : srgb(0x26211e);
    const c = mixC(srgb(0xd3c8b4), dark, smooth(0.36, 0.48, f) * smooth(0.99, 0.88, f) * 0.94);
    return mixC(mulC(c, 0.9 + 0.1 * Math.cos(be * TAU * 5)), srgb(0xbcae98), smooth(0.8, 1.0, be));
  };
  const tex = paint(
    'nerite',
    128,
    128,
    (u, v) => {
      const th = TAU * u;
      if (v > FACEV) return outside(u, (v - FACEV) / (1 - FACEV));
      const rn = v / FACEV;
      const a = rn * Math.cos(th);
      const b = rn * Math.sin(th);
      const d = openDist(a, b);
      const e = edge(a);
      // one broad white tooth with a notch, biting into the opening from the inner edge
      const tooth = Math.hypot(a / 0.2, (b - e + 0.01) / 0.075) * (1 + 0.35 * smooth(0.06, 0.0, Math.abs(a)) * smooth(-0.03, 0.04, b - e));
      let c: C3;
      if (tooth < 1) {
        c = mixC(srgb(0xfdfaf2), srgb(0xe2d6c2), smooth(0.4, 1.0, tooth));
      } else if (d > 0) {
        // inside the opening: dark and deep, warming towards its edges
        c = ramp([srgb(0x2a1f18), srgb(0x463629), srgb(0x8a765f)], smooth(0.2, 0.0, d));
      } else if (b > edge(a)) {
        // the outer lip: creamy, with fine grooves on its inner side
        c = srgb(0xf0e8d6);
        const lir = smooth(0.4, 0.9, 0.5 + 0.5 * Math.cos(th * 46)) * smooth(-0.1, -0.02, d);
        c = mixC(c, srgb(0xa8967c), lir * 0.6);
      } else {
        // the callus: white, with the red-orange blotch and two white teeth along the inner edge
        c = srgb(0xf3ebdc);
        const blot = Math.hypot(a / 0.5, (b - e + 0.02) / 0.3) * (1 + 0.25 * (noise(a * 7 + 3, b * 7 + 3, 7) - 0.5));
        c = mixC(c, ramp([srgb(0xb3221a), srgb(0xd23f26), srgb(0xe9915f)], smooth(0.35, 1.0, blot)), smooth(1.05, 0.85, blot));
        c = mixC(c, srgb(0x6e3a2a), smooth(0.025, 0.0, e - b) * 0.45); // shadow at the edge of the opening
      }
      // the patterned outside shows over the rounded rim (less on the callus side)
      const rimStart = b > edge(a) ? 0.8 : 0.9;
      return mixC(c, outside(u, 0), smooth(rimStart, rimStart + 0.08, rn));
    },
    { wrapU: true },
  );
  const mat = material('nerite', () => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0 }));
  return place([{ geo, mat }], { x: 0.42 });
}

/** Sunrise tellin: a thin, glossy, flattish valve with pink rays fanning out from the hinge. */
function tellin(): Part[] {
  const A = 0.034;
  const B = 0.0178;
  const H = 0.0052;
  const CX = 0.003;
  const CZ = 0.84 * B;
  const outline = (phi: number): number => {
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const qa = (s * s) / (A * A) + (c * c) / (B * B);
    const qb = -2 * ((s * CX) / (A * A) + (c * CZ) / (B * B));
    const qc = (CX * CX) / (A * A) + (CZ * CZ) / (B * B) - 1;
    return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
  };
  const flat = (phi: number, s: number): [number, number] => {
    const r = s * outline(phi);
    const x = r * Math.sin(phi);
    let z = r * Math.cos(phi);
    if (x < 0) z = CZ + (z - CZ) * (1 - 0.2 * (x / A) ** 2); // the back end is a little narrower
    return [x, z];
  };
  const geo = grid({
    us: steps(40),
    vs: [0, 0.18, 0.36, 0.55, 0.72, 0.87, 1],
    wrapU: true,
    flip: true,
    pos: (u, s) => {
      const phi = -Math.PI + TAU * u;
      const [x, z] = flat(phi, s);
      const [x1, z1] = flat(phi, 1);
      const q = ((x - CX) / A) ** 2 + ((z - CZ) / B) ** 2;
      const q1 = ((x1 - CX) / A) ** 2 + ((z1 - CZ) / B) ** 2;
      const y = H * Math.pow(Math.max(0, 1 - q / q1), 0.7) + 0.0011 * Math.exp(-((Math.hypot(x, z) / 0.005) ** 2));
      return [x, y, z];
    },
    col: (u, s) => {
      const phi = -Math.PI + TAU * u;
      const cream = lin(0xf9efe4);
      const ray = 0.55 * (0.5 + 0.5 * Math.sin(phi * 9 + 1.3 * Math.sin(phi * 2.3))) + 0.45 * noise(u * 14, 0.5, 19, 14);
      let c = mixC(cream, mixC(lin(0xf2b2b8), lin(0xdf7488), smooth(0.6, 0.85, ray)), smooth(0.48, 0.62, ray));
      c = mixC(c, lin(0xd86a7c), smooth(0.3, 0.0, s) * 0.8); // rosy near the hinge
      c = mixC(c, lin(0xf3dfb0), smooth(0.45, 0.15, s) * 0.25);
      c = mulC(c, 1 - 0.07 * smooth(0.75, 1, Math.cos(s * TAU * 3.5)));
      return mixC(c, cream, smooth(0.85, 1, s) * 0.5);
    },
  });
  return place([{ geo, mat: glossyVC() }]);
}

/** West Indian top shell (Cittarium pica): a heavy cone striped in black-and-white zigzags. */
function topShell(): Part[] {
  const HS = 0.066;
  const HB = 0.012;
  const RB = 0.04;
  const SPV = 0.8;
  const W = 4.4;
  const whorl = (t: number): number => (W * Math.log(1 + 5 * t)) / Math.log(6);
  const pos = (u: number, v: number): V3 => {
    const th = TAU * u;
    let r: number;
    let y: number;
    if (v <= SPV) {
      const t = v / SPV;
      const w = whorl(t);
      const ph = fract(w + u);
      const bulge = Math.pow(Math.sin(Math.PI * ph), 0.6);
      r = RB * Math.pow(t, 0.85) * (1 - 0.035 * (1 - bulge) * smooth(0.05, 0.25, t)) * (1 + 0.04 * Math.sin(Math.PI * t));
      y = HB + (HS - HB) * Math.pow(1 - t, 1.08);
    } else {
      const k = (v - SPV) / (1 - SPV);
      r = RB * Math.pow(Math.cos((k * Math.PI) / 2), 0.55);
      y = HB * Math.pow(1 - Math.sin((k * Math.PI) / 2), 1.8);
    }
    return [r * Math.cos(th), y, r * Math.sin(th)];
  };
  const vs = [0, 0.03, 0.07, 0.12, 0.19, 0.27, 0.36, 0.46, 0.57, 0.68, SPV, 0.87, 0.94, 1];
  const geo = grid({ us: steps(24), vs, wrapU: true, pos });
  const tex = paint(
    'top-shell',
    128,
    128,
    (u, v) => {
      if (v <= SPV) {
        const t = v / SPV;
        const w = whorl(t);
        const ph = fract(w + u);
        const zig = Math.abs(fract(ph * 2) - 0.5) * 2;
        const q = fract(u * 14 + 0.3 * zig + 0.18 * w);
        const dark = mixC(srgb(0x23282a), srgb(0x34413a), noise(u * 14, w * 2, 3, 14));
        let c = mixC(srgb(0xece7db), dark, smooth(0.37, 0.5, q) * smooth(0.99, 0.86, q));
        // the groove between whorls, with a pale shoulder just below it
        c = mixC(c, srgb(0xf3efe6), smooth(0.05, 0.1, ph) * smooth(0.22, 0.12, ph) * 0.55);
        c = mulC(c, 1 - 0.6 * smooth(0.05, 0.0, ph) - 0.18 * smooth(0.8, 1.0, ph));
        // the worn tip shows pearly shell underneath
        return mixC(c, mixC(srgb(0xd9cfc6), srgb(0xe8d8d0), noise(u * 8, v * 30, 9, 8)), smooth(1.25, 0.6, w));
      }
      const k = (v - SPV) / (1 - SPV);
      // underneath: the opening (pearly rim, dark inside) on one side
      const du = Math.min(Math.abs(u), Math.abs(1 - u)) * 3.2;
      const dap = Math.hypot(du, (k - 0.55) / 0.42);
      let c = mixC(srgb(0xdfe0d4), srgb(0x3b3f39), smooth(0.45, 0.55, fract(u * 15)) * 0.5 * smooth(0.6, 0.2, k));
      c = mixC(c, srgb(0xe7ece6), smooth(1.15, 0.95, dap));
      return mixC(c, srgb(0x2c2a25), smooth(0.8, 0.65, dap));
    },
    { wrapU: true },
  );
  const mat = material('top-shell', () => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0 }));
  return place([{ geo, mat }], { z: 0.3 });
}

// ---------------------------------------------------------------------------
// Sea glass: frosted, rounded pebbles
// ---------------------------------------------------------------------------

const GLASS: Record<'glass-white' | 'glass-green' | 'glass-brown' | 'glass-blue', { seed: number; rx: number; rz: number; h: number; deep: number; frost: number }> = {
  'glass-white': { seed: 1, rx: 0.017, rz: 0.012, h: 0.0078, deep: 0xc4dcd2, frost: 0xf1f7f3 },
  'glass-green': { seed: 2, rx: 0.019, rz: 0.0135, h: 0.0082, deep: 0x1f7a3c, frost: 0x86c995 },
  'glass-brown': { seed: 3, rx: 0.016, rz: 0.0115, h: 0.0075, deep: 0x6a3006, frost: 0xbd7a34 },
  'glass-blue': { seed: 4, rx: 0.0135, rz: 0.0102, h: 0.007, deep: 0x123a9e, frost: 0x6a8ae0 },
};

function seaGlass(kind: keyof typeof GLASS): Part[] {
  const g = GLASS[kind];
  const amps = [2, 3, 4].map((k) => [0.12 / (k - 1), hash(k, g.seed, 3) * TAU] as const);
  const lobes = (th: number): number => 1 + amps.reduce((s, [a, p], i) => s + a * Math.cos((i + 2) * th + p), 0);
  const deep = lin(g.deep);
  const frost = lin(g.frost);
  const geo = grid({
    us: steps(18),
    vs: [0, 0.015, 0.05, 0.11, 0.2, 0.32, 0.46, 0.6, 0.75, 0.88, 1],
    wrapU: true,
    pos: (u, v) => {
      const th = TAU * u;
      const ph = Math.PI * v;
      const r = Math.pow(Math.sin(ph), 0.55) * lobes(th);
      const cy = Math.cos(ph);
      const s2 = Math.sin(ph) ** 2;
      const y = Math.sign(cy) * Math.pow(Math.abs(cy), 0.6) * g.h * (cy > 0 ? 0.6 + 0.1 * Math.cos(2 * th + g.seed) * s2 : 0.4);
      return [g.rx * r * Math.cos(th), y, g.rz * r * Math.sin(th)];
    },
    col: (_u, v, p) => {
      const edge = Math.pow(Math.sin(Math.PI * v), 3);
      const speck = noise(p[0] * 220 + 7, p[2] * 220 + 3, g.seed * 7);
      return mixC(deep, frost, clamp(0.1 + 0.55 * edge * edge + 0.25 * (speck - 0.5), 0, 1));
    },
  });
  const mat = material(
    kind,
    () =>
      new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        roughness: 0.5,
        metalness: 0,
        sheen: 0.6,
        sheenRoughness: 0.5,
        sheenColor: new THREE.Color(0xffffff).lerp(new THREE.Color(g.frost), 0.6),
        emissive: new THREE.Color(g.deep),
        emissiveIntensity: kind === 'glass-white' ? 0.12 : 0.3,
        transparent: true,
        opacity: 0.86,
      }),
  );
  return place([{ geo, mat }], { x: 0.05 * (g.seed - 2.5), z: 0.04 });
}

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

/** A bent, tapering driftwood stick with a knot and a broken-off side branch, bleached silver-grey. */
function driftwood(): Part[] {
  const path = (t: number): V3 => [
    -0.24 + 0.48 * t,
    0,
    0.03 * Math.sin(Math.PI * t * 1.6 + 0.3) + 0.008 * Math.sin(Math.PI * t * 5.5) - 0.016 * t,
  ];
  const rad = (t: number): number => 0.0195 * (1 - 0.42 * t) * (1 + 0.22 * Math.exp(-(((t - 0.33) / 0.045) ** 2)));
  // gnarled, with ridges along the grain
  const lump = (t: number, a: number): number =>
    1 + 0.16 * (fbm((a / TAU) * 4, t * 10, 71, 2, 4, 0) - 0.5) * 2 + 0.05 * Math.cos(5 * a + 3 * t);
  const silver = lin(0xb4aa9a);
  const shade = lin(0x887e70);
  const warm = lin(0xa8957b);
  const col = (t: number, a: number, _p: V3, n: V3): C3 => {
    let c = mixC(silver, warm, smooth(0.5, 0.75, noise(t * 7, 0.5, 73)));
    c = mixC(c, shade, smooth(0.1, -0.7, n[1]) * 0.7);
    c = mulC(c, 0.8 + 0.5 * (lump(t, a) - 1) + 0.2); // darker in the hollows
    return mulC(c, 0.92 + 0.12 * noise(t * 30, a, 75));
  };
  const lift = (p: V3, t: number): V3 => [p[0], p[1] + rad(t) * 0.92, p[2]];
  const main = tube({
    path: (t) => lift(path(t), t),
    radius: (t, a) => rad(t) * lump(t, a),
    nu: 10,
    ts: steps(14),
    caps: [3, 3],
    capLen: 0.55,
    col,
    uv: (t, a) => [t * 4, a / TAU],
  });
  const b0 = lift(path(0.62), 0.62);
  const bd = norm([0.55, 0.12, 0.83]);
  const stub = tube({
    path: (t) => add(b0, scl(bd, t * 0.055)),
    radius: (t) => 0.0085 * (1 - 0.25 * t),
    nu: 6,
    ts: steps(3),
    caps: [0, 3],
    capLen: 0.7,
    col: (t, a, p, n) => mixC(col(0.62, a, p, n), lin(0x8f877a), smooth(0.7, 1, t) * 0.5),
    uv: (t, a) => [t * 0.5, a / TAU],
  });
  return place([
    { geo: main, mat: woodMat() },
    { geo: stub, mat: woodMat() },
  ]);
}

/** A weathered plank, broken at one end, with two old nail stains and a scrap of faded paint. */
function plank(): Part[] {
  const L2 = 0.31;
  const W2 = 0.055;
  const T2 = 0.011;
  const CAPV = 0.04;
  const brk = (z: number): number => 0.028 * (0.55 + 0.45 * Math.sin(z * 95 + 1.2) * Math.cos(z * 37));
  const warp = (x: number, z: number): number => 0.004 * Math.pow(Math.cos((Math.PI * x) / (2 * L2)), 2) + 0.03 * (z * x) / L2;
  const cs = (a: number): [number, number] => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [W2 * Math.sign(c) * Math.pow(Math.abs(c), 0.22), T2 * Math.sign(s) * Math.pow(Math.abs(s), 0.22)];
  };
  const pos = (u: number, v: number): V3 => {
    const a = TAU * u;
    const [z, y0] = cs(a);
    const xEnd = L2 - brk(z);
    let x: number;
    let k = 1;
    if (v < CAPV) {
      const al = (v / CAPV) * (Math.PI / 2);
      k = Math.sin(al);
      x = -L2 - 0.004 * Math.cos(al);
    } else if (v > 1 - CAPV) {
      const al = ((1 - v) / CAPV) * (Math.PI / 2);
      k = Math.sin(al);
      x = xEnd + 0.003 * Math.cos(al);
    } else {
      const t = (v - CAPV) / (1 - 2 * CAPV);
      x = -L2 + (xEnd + L2) * t;
    }
    const zz = z * k;
    return [x, y0 * k + T2 + warp(x, zz), zz];
  };
  const top = lin(0xb2aa9b);
  const side = lin(0x9d9487);
  const under = lin(0x857c70);
  const body = grid({
    us: steps(16),
    vs: [0, CAPV / 2, CAPV, ...[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => CAPV + t * (1 - 2 * CAPV)), 1 - CAPV, 1 - CAPV / 2, 1],
    wrapU: true,
    flip: true,
    pos,
    col: (u, v, p, n) => {
      let c = n[1] > 0 ? mixC(side, top, smooth(0.3, 0.9, n[1])) : mixC(side, under, smooth(-0.3, -0.9, n[1]));
      c = mixC(c, lin(0xb5a68e), smooth(0.55, 0.8, noise(p[0] * 9, p[2] * 30, 81)) * 0.6);
      const endGrain = v < CAPV || v > 1 - CAPV ? 1 : 0;
      return mulC(c, (0.93 + 0.1 * noise(p[0] * 40, p[2] * 90, 83)) * (1 - 0.18 * endGrain));
    },
    uv: (u, _v, p) => [(p[0] + L2) / 0.13, u * 2],
  });
  // decals that lie just on the top face: nail stains and a scrap of faded teal paint
  const decal = (cx: number, cz: number, radius: (a: number) => number, colAt: (r: number) => C3, rings: number[]): THREE.BufferGeometry => {
    const g = grid({
      us: steps(14),
      vs: rings,
      wrapU: true,
      pos: (u, v) => {
        const a = TAU * u;
        const x = cx + v * radius(a) * Math.cos(a);
        const z = cz + v * radius(a) * Math.sin(a);
        return [x, 2 * T2 + warp(x, z) + 0.0004, z];
      },
      col: (_u, v) => colAt(v),
      uv: (_u, _v, p) => [(p[0] + L2) / 0.13, 0.5 + p[2] / (4 * W2)],
    });
    return g;
  };
  const rust = (r: number): C3 => mixC(mixC(lin(0x3a2416), lin(0x8e5430), smooth(0.2, 0.6, r)), top, smooth(0.6, 1, r));
  const nail1 = decal(-0.255, 0.024, () => 0.0075, rust, [0, 0.4, 1]);
  const nail2 = decal(-0.25, -0.026, () => 0.0065, rust, [0, 0.4, 1]);
  const paintPatch = decal(
    0.02,
    -0.004,
    (a) => 0.03 * (0.6 + 0.6 * fbm((a / TAU) * 12, 0.5, 91, 3, 12)) * (1 + 0.6 * Math.abs(Math.cos(a))),
    (r) => mixC(lin(0x8fb6ae), lin(0xa4bdb4), r),
    [0, 0.6, 1],
  );
  return place([
    { geo: body, mat: woodMat() },
    { geo: nail1, mat: woodMat() },
    { geo: nail2, mat: woodMat() },
    { geo: paintPatch, mat: woodMat() },
  ]);
}

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

/** A loose, overlapping coil of old blue rope; where it crosses itself it drapes over. */
function rope(): Part[] {
  const RR = 0.0065;
  const N = 240;
  const pts: V3[] = [];
  for (let i = 0; i < N; i++) {
    const s = i / (N - 1);
    const al = 0.4 + TAU * 1.55 * s;
    let rho = 0.082 + 0.014 * Math.sin(1.7 * al + 0.5) - 0.018 * s;
    rho += 0.17 * smooth(0.86, 1, s) ** 1.5 + 0.07 * smooth(0.1, 0, s) ** 2;
    pts.push([0.03 * s + rho * Math.cos(al), RR, 0.015 * s + rho * Math.sin(al)]);
  }
  // where a later stretch crosses an earlier one, lift it over and let it drape
  const need = new Float64Array(N).fill(RR);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < i - 14; j++) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][2] - pts[j][2]);
      if (d < 2 * RR) need[i] = Math.max(need[i], need[j] + Math.sqrt(4 * RR * RR - d * d));
    }
  }
  let y = Array.from(need);
  for (let pass = 0; pass < 6; pass++) {
    y = y.map((_, i) => {
      let s = 0;
      let w = 0;
      for (let k = -6; k <= 6; k++) {
        const j = clamp(i + k, 0, N - 1);
        const ww = 1 - Math.abs(k) / 7;
        s += y[j] * ww;
        w += ww;
      }
      return Math.max(need[i], s / w);
    });
  }
  const curve = new THREE.CatmullRomCurve3(
    pts.filter((_, i) => i % 4 === 0 || i === N - 1).map((p, k, arr) => {
      const i = k === arr.length - 1 ? N - 1 : k * 4;
      return new THREE.Vector3(p[0], y[i], p[2]);
    }),
  );
  const length = curve.getLength();
  const blue = lin(0x5f93b3);
  const faded = lin(0x9fbfcf);
  const geo = tube({
    path: (t) => curve.getPointAt(t).toArray() as V3,
    radius: (t) => RR * (1 + 0.25 * smooth(0.985, 1, t) + 0.25 * smooth(0.015, 0, t)),
    nu: 6,
    ts: steps(50),
    caps: [2, 2],
    capLen: 0.5,
    col: (t, _a, _p, n) => {
      const c = mixC(blue, faded, smooth(0.45, 0.75, noise(t * 9, 0.5, 101)) * 0.8);
      return mulC(c, 0.85 + 0.15 * smooth(-0.6, 0.6, n[1]));
    },
    uv: (t, a) => [(t * length) / 0.042, a / TAU],
  });
  return place([{ geo, mat: ropeMat() }]);
}

/** A coconut still in its brown, fibrous, three-sided husk, lying on its side. */
function coconut(): Part[] {
  const L2 = 0.128;
  const R = 0.094;
  const brown = lin(0x80583a);
  const grey = lin(0x9a8670);
  const ridge = lin(0xa58458);
  const calyx = lin(0x3b2817);
  const geo = grid({
    us: steps(18),
    vs: steps(12),
    wrapU: true,
    pos: (u, v) => {
      const a = TAU * u + Math.PI;
      const sv = Math.sin(Math.PI * v);
      const t = -Math.cos(Math.PI * v);
      const prof = Math.pow(Math.max(sv, 0), 0.72) * (1 - 0.13 * t);
      const tri = 1 + 0.1 * Math.cos(3 * a + 0.4 * t) * Math.pow(sv, 0.7);
      const r = R * prof * tri;
      const tip = 0.022 * Math.pow(Math.max(0, t), 6);
      return [L2 * t + tip, r * Math.cos(a) * 0.93, r * Math.sin(a)];
    },
    col: (u, v) => {
      const a = TAU * u + Math.PI;
      const t = -Math.cos(Math.PI * v);
      let c = mixC(brown, grey, smooth(0.5, 0.8, fbm(u * 6, v * 3, 111, 2, 6)) * 0.8);
      c = mixC(c, ridge, smooth(0.6, 0.95, Math.cos(3 * a + 0.4 * t)) * 0.6 * Math.sin(Math.PI * v));
      c = mixC(c, calyx, smooth(-0.8, -0.95, t));
      c = mixC(c, grey, smooth(0.85, 0.98, t) * 0.6);
      return mulC(c, 0.9 + 0.15 * noise(u * 40, v * 8, 113, 40));
    },
    uv: (u, v) => [v * 2.5, u * 12],
  });
  return place([{ geo, mat: woodMat() }]);
}

/** Hamburger bean (Mucuna): a glossy brown lens with a black band around most of its edge. */
function seaBean(): Part[] {
  const RX = 0.0148;
  const RZ = 0.0138;
  const RY = 0.0074;
  const BAND = 0.36; // half-width of the black band, as latitude (radians)
  const lats = [Math.PI / 2, 1.38, 1.12, 0.82, 0.58, 0.44, 0.3, 0.15, 0];
  const allLats = [...lats, ...lats.slice(0, -1).reverse().map((l) => -l)];
  const vOf = (lat: number): number => 0.5 - lat / Math.PI;
  const seed = lin(0x6e2e1c);
  const dark = lin(0x42190f);
  const red = lin(0x9a4428);
  const tan = lin(0xd8b884);
  const black = lin(0x17110e);
  const geo = grid({
    us: steps(16),
    vs: allLats.map(vOf),
    wrapU: true,
    pos: (u, v) => {
      const th = TAU * u;
      const lat = (0.5 - v) * Math.PI;
      const cl = Math.cos(lat);
      const r = Math.sign(cl) * Math.pow(Math.abs(cl), 0.85);
      const y = Math.sign(lat) * Math.pow(Math.abs(Math.sin(lat)), 0.9);
      return [RX * r * Math.cos(th), RY * y, RZ * r * Math.sin(th)];
    },
    col: (u, v) => {
      const lat = Math.abs((0.5 - v) * Math.PI);
      // the band runs about three quarters of the way round, with rounded ends
      const along = Math.abs(fract(u + 0.5) - 0.5) * 2; // 0 at u = 0, 1 at u = 0.5
      const e = clamp((along - 0.6) / 0.15, 0, 1);
      const halfW = BAND * Math.sqrt(1 - e * e);
      let c = mixC(seed, dark, smooth(0.5, 0.75, noise(u * 10, v * 5, 121, 10)) * 0.7);
      c = mixC(c, red, smooth(0.6, 0.85, noise(u * 6, v * 4, 123, 6)) * 0.5);
      c = mixC(c, tan, smooth(halfW + 0.12, halfW + 0.03, lat) * smooth(0.0, 0.05, halfW));
      return mixC(c, black, smooth(halfW + 0.02, halfW - 0.04, lat) * smooth(0.0, 0.05, halfW));
    },
  });
  return place([{ geo, mat: glossyVC() }], { x: -0.62, y: 0.4 });
}

/** A small, sun-faded orange fishing float lying on its side, with a rope loop through its moulded ear. */
function float(): Part[] {
  const RF = 0.05;
  const orange = lin(0xe8864a);
  const bleached = lin(0xf2b88e);
  const dirty = lin(0xa86a46);
  const shellCol = (y: number, u: number, v: number): C3 => {
    let c = mixC(orange, bleached, smooth(RF * 1.2, RF * 1.95, y));
    c = mixC(c, dirty, smooth(RF * 0.5, RF * 0.05, y) * 0.8);
    return mulC(c, 0.95 + 0.08 * noise(u * 12, v * 8, 131, 12));
  };
  const ball = grid({
    us: steps(16),
    vs: [0, 0.12, 0.25, 0.38, 0.47, 0.5, 0.53, 0.62, 0.75, 0.88, 1],
    wrapU: true,
    flip: true,
    pos: (u, v) => {
      const th = TAU * u;
      const ph = Math.PI * v;
      const r = RF * (1 + 0.025 * Math.exp(-(((v - 0.5) / 0.025) ** 2)));
      return [r * Math.sin(ph) * Math.cos(th), RF + r * Math.sin(ph) * Math.sin(th), r * Math.cos(ph)];
    },
    col: (u, v, p) => shellCol(p[1], u, v),
  });
  const lugR = 0.011;
  const lug = prim(new THREE.TorusGeometry(lugR, 0.0045, 4, 8), orange).translate(RF + 0.007, RF, 0);
  const xh = RF + 0.007;
  const RR = 0.004;
  const loop = (al: number): V3 => {
    const c = Math.cos(al);
    return [xh + 0.09 * (1 - c) * 0.5, RR + (RF - RR) * Math.pow((1 + c) / 2, 3), 0.036 * Math.sin(al) * (1 - 0.25 * (1 - c) * 0.5)];
  };
  const ropeGeo = tube({
    path: (t) => loop(TAU * t),
    radius: () => RR,
    nu: 5,
    ts: steps(22),
    closed: true,
    col: (t, _a, _p, n) => mulC(lin(0x3f6a8a), 0.85 + 0.15 * smooth(-0.6, 0.6, n[1]) + 0.1 * noise(t * 6, 0, 133)),
    uv: (t, a) => [t * 6, a / TAU],
  });
  return place([
    { geo: ball, mat: matteVC() },
    { geo: lug, mat: matteVC() },
    { geo: ropeGeo, mat: ropeMat() },
  ]);
}

/** A brown pelican's flight feather lying on the sand: a pale shaft, a narrow outer vane and a wide inner one. */
function feather(): Part[] {
  const LF = 0.28;
  const V0 = 0.12; // where the vane starts (below it is the bare quill)
  const centre = (v: number): V3 => [-LF / 2 + LF * v, 0.007 * Math.pow(Math.sin(Math.PI * v), 1.2), 0.028 * v * v - 0.008 * v];
  const env = (v: number): number => smooth(V0 - 0.01, 0.3, v) * Math.sqrt(Math.max(0, 1 - Math.pow((v - 0.2) / 0.8, 6)));
  const wOut = (v: number): number => 0.012 * env(v);
  const wIn = (v: number): number => 0.03 * env(v);
  const vane = grid({
    us: [0, 0.14, 0.28, 0.4, 0.5, 0.6, 0.72, 0.86, 1],
    vs: steps(16).map((t) => V0 + (1 - V0) * t),
    pos: (u, v) => {
      const c = centre(v);
      const b = u < 0.5 ? -wOut(v) * (0.5 - u) * 2 : wIn(v) * (u - 0.5) * 2;
      const rel = Math.abs(u - 0.5) * 2;
      return [c[0] - 0.006 * rel * env(v), c[1] - 0.0045 * rel * rel, c[2] + b];
    },
    uv: (u, v) => [u, v],
  });
  const shaft = tube({
    path: (t) => {
      const v = t;
      const c = centre(v);
      return [c[0], c[1] + 0.0006, c[2]];
    },
    radius: (t) => (t < V0 ? 0.0024 : 0.0019 * (1 - 0.85 * t) + 0.0003),
    nu: 5,
    ts: steps(12),
    caps: [2, 0],
    capLen: 0.6,
    uv: (t) => [0.5, t],
  });
  const tex = paint('feather', 64, 128, (u, v) => {
    const b = (u - 0.5) * 2; // -1 outer edge .. +1 inner edge
    const ab = Math.abs(b);
    if (ab < 0.05 || v < V0) return [...mixC(srgb(0xe6dcc6), srgb(0x8a7a66), smooth(0.15, 0.8, v)), 1];
    let c = mixC(srgb(0x86705a), srgb(0x4a3b30), smooth(0.5, 0.97, v));
    if (b < 0) c = mulC(c, 0.8);
    c = mixC(c, srgb(0xa08a74), smooth(0.65, 1, b) * 0.55); // paler inner edge
    c = mixC(c, srgb(0xd2c6b6), smooth(0.32, 0.14, v)); // soft, downy base
    // barbs: soft slanted lines
    const barb = fract(v * 30 - ab * 4);
    c = mulC(c, 0.9 + 0.12 * smooth(0.1, 0.5, barb) * smooth(0.95, 0.6, barb));
    c = mulC(c, 0.92 + 0.08 * smooth(0.0, 0.25, ab)); // a little darker beside the shaft
    // ragged edges and a few splits between barbs
    let alpha = smooth(0.97, 0.9, ab + 0.08 * (noise(v * 60, b > 0 ? 1 : 3, 141) - 0.5));
    alpha *= smooth(0.12, 0.2, v) + smooth(0.75, 0.4, ab) * (1 - smooth(0.12, 0.2, v));
    for (const [sv, side] of [
      [0.44, 1],
      [0.58, -1],
      [0.66, 1],
      [0.8, 1],
    ] as const) {
      if (Math.sign(b) !== side) continue;
      const line = Math.abs(v - (sv + ab * 0.13));
      alpha *= smooth(0.004, 0.009, line) + smooth(0.45, 0.3, ab);
    }
    return [...c, clamp(alpha, 0, 1)];
  });
  const mat = material(
    'feather',
    () => new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 }),
  );
  return place([
    { geo: prim(vane, [1, 1, 1]), mat },
    { geo: shaft, mat },
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BUILDERS: Record<FindKind, () => Part[]> = {
  cowrie,
  'calico-scallop': scallop,
  'sand-dollar': sandDollar,
  nerite,
  'sunrise-tellin': tellin,
  'top-shell': topShell,
  'glass-white': () => seaGlass('glass-white'),
  'glass-green': () => seaGlass('glass-green'),
  'glass-brown': () => seaGlass('glass-brown'),
  'glass-blue': () => seaGlass('glass-blue'),
  driftwood,
  plank,
  rope,
  coconut,
  'sea-bean': seaBean,
  float,
  feather,
};

const partCache = new Map<FindKind, Part[]>();

function partsFor(kind: FindKind): Part[] {
  let parts = partCache.get(kind);
  if (!parts) {
    const make = BUILDERS[kind];
    if (!make) throw new Error(`finds: unknown kind "${kind}"`);
    parts = make();
    partCache.set(kind, parts);
  }
  return parts;
}

function meshesOf(parts: Part[], name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  for (const p of parts) {
    const m = new THREE.Mesh(p.geo, p.mat);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

/**
 * A new model of a find, at real-life size in metres: +Y up, origin where it
 * rests on the sand (lowest point y = 0, centred in X and Z). Geometries and
 * materials are shared between all models of the same kind, so don't dispose
 * them per model; call `disposeFindCache` when no finds are shown at all.
 */
export function findModel(kind: FindKind): THREE.Object3D {
  const g = meshesOf(partsFor(kind), `find:${kind}`);
  g.userData.kind = kind;
  return g;
}

/** Triangle count of a find's model. */
export function findTriangles(kind: FindKind): number {
  return partsFor(kind).reduce((n, p) => n + (p.geo.index ? p.geo.index.count : p.geo.getAttribute('position').count) / 3, 0);
}

// ---------------------------------------------------------------------------
// The woven basket
// ---------------------------------------------------------------------------

/**
 * Plain over-under weave of flat palm-leaf strips, four strips each way per
 * tile. Between two strips on top you see the crossing strip underneath, in
 * shadow; only where both gaps meet is there a small dark hole.
 */
function weaveTex(): THREE.DataTexture {
  const tones = [0xdcbc7e, 0xcfaa66, 0xe6cc93, 0xd4b06f, 0xc8a15e, 0xdfc084, 0xd1aa68, 0xe2c68c].map(srgb);
  const GAP = 0.07;
  const stripCol = (strip: number, across: number, along: number, u: number, v: number, horizontal: boolean): C3 => {
    let k = 0.86 + 0.14 * Math.pow(Math.sin(Math.PI * clamp(across, 0, 1)), 0.6);
    k *= 0.62 + 0.38 * Math.pow(Math.sin(Math.PI * clamp(along, 0, 1)), 0.7);
    const fib = horizontal ? noise(u * 4, v * 160, 151 + strip, 4, 160) : noise(u * 160, v * 4, 151 + strip, 160, 4);
    const blotch = horizontal ? noise(u * 3, 0.5 + strip, 171, 3) : noise(0.5 + strip, v * 3, 171, 0, 3);
    k *= (0.9 + 0.13 * fib) * (0.94 + 0.1 * blotch);
    return mulC(tones[strip], k);
  };
  return paint(
    'weave',
    128,
    128,
    (u, v) => {
      const x = u * 4;
      const y = v * 4;
      const i = Math.floor(x);
      const j = Math.floor(y);
      const fx = x - i;
      const fy = y - j;
      const hTop = (i + j) % 2 === 0;
      const across = hTop ? fy : fx;
      const along = hTop ? fx : fy;
      const inGap = Math.min(across, 1 - across) < GAP;
      if (!inGap) return hTop ? stripCol(j, fy, fx, u, v, true) : stripCol(4 + i, fx, fy, u, v, false);
      // in the gap: the crossing strip underneath, in shadow, or a hole where both gaps meet
      const underAcross = along;
      if (Math.min(underAcross, 1 - underAcross) < GAP) return srgb(0x3a2812);
      const under = hTop ? stripCol(4 + i, fx, 0.5, u, v, false) : stripCol(j, fy, 0.5, u, v, true);
      return mulC(under, 0.55);
    },
    { wrapU: true, wrapV: true },
  );
}

const BASKET_FLOOR = 0.0095;
let basketParts: Part[] | null = null;

function buildBasket(): Part[] {
  // Profile (radius, height): outside bottom, outer wall, rolled rim, inner wall, inside floor.
  const rim = [-40, 10, 60, 110, 160, 210].map((d): [number, number] => {
    const a = (d * Math.PI) / 180;
    return [0.1795 + 0.0105 * Math.cos(a), 0.205 + 0.0105 * Math.sin(a)];
  });
  const prof: [number, number][] = [
    [0, 0],
    [0.07, 0],
    [0.122, 0.0015],
    [0.14, 0.008],
    [0.148, 0.02],
    [0.155, 0.05],
    [0.163, 0.09],
    [0.171, 0.13],
    [0.178, 0.17],
    [0.183, 0.193],
    ...rim,
    [0.1745, 0.17],
    [0.1665, 0.13],
    [0.1585, 0.09],
    [0.1505, 0.05],
    [0.1435, 0.025],
    [0.135, 0.0135],
    [0.115, 0.0105],
    [0.06, BASKET_FLOOR],
    [0, BASKET_FLOOR],
  ];
  const cum = [0];
  for (let i = 1; i < prof.length; i++) cum.push(cum[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  const total = cum[cum.length - 1];
  const vs = cum.map((c) => c / total);
  const at = (v: number): [number, number, number] => {
    const s = clamp(v, 0, 1) * total;
    let i = 1;
    while (i < prof.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [mix(prof[i - 1][0], prof[i][0], t), mix(prof[i - 1][1], prof[i][1], t), s];
  };
  const TILE = 0.059;
  const AROUND = 18;
  const rimStart = vs[10];
  const rimEnd = vs[15];
  const body = grid({
    us: steps(40),
    vs,
    wrapU: true,
    flip: true,
    pos: (u, v) => {
      const [r, y] = at(v);
      const th = TAU * u;
      return [r * Math.cos(th), y, r * Math.sin(th)];
    },
    uv: (u, v) => [u * AROUND, at(v)[2] / TILE],
    col: (u, v, p) => {
      const inner = v > rimEnd;
      const outerBottom = v < vs[3];
      let k = 1;
      if (inner) k = mix(0.78, 0.5, smooth(0.15, 0.0, p[1]));
      if (outerBottom) k = 0.7;
      let c: C3 = [k, k, k];
      // one dyed band round the outside, as in Caribbean straw-work
      if (!inner && v > vs[4]) c = mixC(c, [0.78, 0.42, 0.3], smooth(0.118, 0.124, p[1]) * smooth(0.152, 0.146, p[1]));
      if (v >= rimStart && v <= rimEnd) c = mulC(c, 1.0);
      return mulC(c, 0.96 + 0.08 * noise(u * 20, v * 20, 161, 20));
    },
  });
  // the handle: a flat plaited band arching over the top
  const handle = tube({
    path: (t) => {
      const a = Math.PI * t;
      return [0.176 * Math.cos(a), 0.2 + 0.135 * Math.sin(a), 0];
    },
    radius: (_t, a) => {
      const c = Math.cos(a);
      const s = Math.sin(a);
      // a flattened rounded rectangle: 0.9 cm thick (in the arch's plane), 2.4 cm wide (along z)
      const ex = 0.0045;
      const ey = 0.012;
      return 1 / Math.pow(Math.pow(Math.abs(c) / ex, 4) + Math.pow(Math.abs(s) / ey, 4), 0.25);
    },
    nu: 8,
    ts: steps(22),
    ref: [0, 0, 1],
    uv: (t, a) => [(a / TAU) * 1, (t * Math.PI * 0.16) / (TILE * 0.5)],
    col: (_t, _a, _p, n) => mulC([1, 1, 1], 0.88 + 0.12 * smooth(-0.5, 0.8, n[1])),
  });
  const mat = material('basket', () => new THREE.MeshStandardMaterial({ map: weaveTex(), vertexColors: true, roughness: 0.85, metalness: 0 }));
  const merged = mergeGeometries([body, handle]);
  if (!merged) throw new Error('finds: could not merge the basket');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return [{ geo: merged, mat }];
}

/**
 * A round woven palm-leaf basket, about 0.38 m across and 0.22 m tall (the
 * handle arches higher), open at the top. Origin at the bottom centre.
 */
export function basketModel(): THREE.Group {
  basketParts ??= buildBasket();
  return meshesOf(basketParts, 'basket');
}

/**
 * Twelve resting places for finds inside the basket, in the basket's local
 * coordinates, in the order to fill them (bottom layer first). Place a find's
 * origin on a slot; the sand-dollar-sized finds fit, long ones (driftwood,
 * plank, feather) are best scaled down or shown sticking out.
 */
export function basketSlots(): THREE.Vector3[] {
  const slots: THREE.Vector3[] = [new THREE.Vector3(0, BASKET_FLOOR, 0)];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * TAU + Math.PI / 6;
    slots.push(new THREE.Vector3(0.088 * Math.cos(a), BASKET_FLOOR, 0.088 * Math.sin(a)));
  }
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU;
    slots.push(new THREE.Vector3(0.06 * Math.cos(a), 0.05, 0.06 * Math.sin(a)));
  }
  return slots;
}

/** Frees every cached find and basket geometry, material and texture. */
export function disposeFindCache(): void {
  for (const parts of partCache.values()) for (const p of parts) p.geo.dispose();
  partCache.clear();
  if (basketParts) for (const p of basketParts) p.geo.dispose();
  basketParts = null;
  for (const m of matCache.values()) m.dispose();
  matCache.clear();
  for (const t of texCache.values()) t.dispose();
  texCache.clear();
}
