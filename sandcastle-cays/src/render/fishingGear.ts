/**
 * Fishing gear, made in code:
 *
 * - `rodModel()`: a short (1.8 m) spinning rod with a cork grip, a reel seat,
 *   line guides and a spinning reel hanging underneath. Butt at the origin,
 *   the rod along +x, the reel below (-y), its handle on the left (-z, as for
 *   a right-handed angler). One material, three meshes (rod and reel, the
 *   reel's turning rotor, its handle). The blank bows in the vertex shader;
 *   `tipLocal` gives the tip for the same bend, worked out the same way.
 *
 * - `FishingLine`: the line from the rod tip to a red-and-white float on the
 *   water, with its splashes, ripples and a fish flashing at the surface while
 *   it fights. It lives in the world scene: two draw calls (the float, and
 *   one see-through mesh for the line and everything on the water).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAU, clamp, fract, grid, hash, lin, mix, mixC, mulC, noise, paintTexture, smooth, steps, tube, type C3, type V3 } from './finds';

// ---------------------------------------------------------------------------
// The rod
// ---------------------------------------------------------------------------

/** Rod length in metres, butt to tip. */
export const ROD_LENGTH = 1.8;
/** Where the reel seat is (where your hand holds it), along the rod. */
export const ROD_GRIP_X = 0.27;
/** The blank bends from here to the tip. */
const BEND_FROM = 0.45;
const BEND_LEN = ROD_LENGTH - BEND_FROM;
/** Angle of the tip at full bend (radians), and how much the bend gathers toward the tip. */
const BEND_PHI = 0.95;
const BEND_POW = 1.7;
const BEND_STEPS = 8;

/** Where a point of the straight rod (x along it, y up from its axis) goes when the rod bends by `bend` (0..1; negative bows it up). */
export function bentRodPoint(x: number, y: number, bend: number, out = new THREE.Vector2()): THREE.Vector2 {
  const t = x - BEND_FROM;
  if (t <= 0 || bend === 0) return out.set(x, y);
  const q = t / BEND_LEN;
  let ax = 0;
  let ay = 0;
  for (let i = 0; i < BEND_STEPS; i++) {
    const ph = -bend * BEND_PHI * Math.pow(((i + 0.5) / BEND_STEPS) * q, BEND_POW);
    ax += Math.cos(ph);
    ay += Math.sin(ph);
  }
  ax *= t / BEND_STEPS;
  ay *= t / BEND_STEPS;
  const ph = -bend * BEND_PHI * Math.pow(q, BEND_POW);
  return out.set(BEND_FROM + ax - Math.sin(ph) * y, ay + Math.cos(ph) * y);
}

const BEND_GLSL = /* glsl */ `
float rodT = position.x - ${BEND_FROM.toFixed(4)};
float rodPh = 0.0;
vec2 rodC = position.xy;
if (rodT > 0.0 && uBend != 0.0) {
  float q = rodT / ${BEND_LEN.toFixed(4)};
  vec2 acc = vec2(0.0);
  for (int i = 0; i < ${BEND_STEPS}; i++) {
    float ph = -uBend * ${BEND_PHI.toFixed(4)} * pow((float(i) + 0.5) / ${BEND_STEPS.toFixed(1)} * q, ${BEND_POW.toFixed(4)});
    acc += vec2(cos(ph), sin(ph));
  }
  acc *= rodT / ${BEND_STEPS.toFixed(1)};
  rodPh = -uBend * ${BEND_PHI.toFixed(4)} * pow(q, ${BEND_POW.toFixed(4)});
  rodC = vec2(${BEND_FROM.toFixed(4)} + acc.x - sin(rodPh) * position.y, acc.y + cos(rodPh) * position.y);
}
`;

/** Guides: position along the rod, ring radius, and how far the ring's centre sits below the blank's axis. */
const GUIDES: [number, number, number][] = [
  [0.66, 0.0125, 0.044],
  [0.92, 0.0085, 0.031],
  [1.14, 0.0062, 0.023],
  [1.34, 0.005, 0.018],
  [1.52, 0.0042, 0.015],
  [1.67, 0.0036, 0.012],
];
const TIP_RING: [number, number] = [0.0028, 0.0045];

/** Blank radius along the rod (from the winding check to the tip). */
const blankR = (x: number): number => mix(0.0062, 0.0017, Math.pow(clamp((x - 0.43) / (ROD_LENGTH - 0.43), 0, 1), 0.85));

function withRM(g: THREE.BufferGeometry, rough: number, metal: number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[i * 2] = rough;
    a[i * 2 + 1] = metal;
  }
  g.setAttribute('rm', new THREE.BufferAttribute(a, 2));
  if (!g.getAttribute('color')) {
    const c = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2).fill(0.02), 2));
  return g;
}

/** A plain-coloured part (uv points at the plain strip of the texture). */
function plain(g: THREE.BufferGeometry, col: C3, rough: number, metal: number): THREE.BufferGeometry {
  if (g.getAttribute('normal') === undefined) g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set(col, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2).fill(0.02), 2));
  return withRM(g, rough, metal);
}

/** Cork, painted: the top 85% of the texture (tiling round and along); the bottom strip stays plain white for everything else. */
let rodTex: THREE.DataTexture | null = null;
const CORK_V0 = 0.15;
function rodTexture(): THREE.DataTexture {
  rodTex ??= paintTexture(
    'rod:cork',
    64,
    64,
    (u, v) => {
      if (v < CORK_V0 - 0.03) return [1, 1, 1];
      const w = clamp((v - CORK_V0) / (1 - CORK_V0), 0, 1);
      // speckled cork: pale granules, darker pits, and the rings between the cork discs
      let g = 0.9 + 0.1 * noise(u * 16, w * 16, 3, 16, 16);
      g *= 1 - 0.18 * smooth(0.7, 0.86, noise(u * 32 + 3, w * 32, 5, 32, 32));
      g *= 1 - 0.1 * smooth(0.04, 0.0, Math.abs(fract(u * 4) - 0.5) - 0.45);
      const c: C3 = mixC([0.86, 0.68, 0.48], [0.72, 0.52, 0.34], 1 - g);
      return mulC(c, g * 1.1);
    },
    { wrapU: true },
  );
  return rodTex;
}

/** Rod material: vertex colours over the cork texture, per-vertex roughness and metalness, and the bend. */
function rodMaterial(bend: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: rodTexture(), vertexColors: true, roughness: 0.5, metalness: 0 });
  m.name = 'rod';
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uBend = bend;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uBend;\nattribute vec2 rm;\nvarying vec2 vRm;')
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n${BEND_GLSL}\nobjectNormal.xy = mat2(cos(rodPh), sin(rodPh), -sin(rodPh), cos(rodPh)) * objectNormal.xy;\nvRm = rm;`,
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.xy = rodC;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vRm;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRm.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vRm.y;');
  };
  m.customProgramCacheKey = () => 'rod';
  return m;
}

const tubeAlongX = (x0: number, x1: number, r: (x: number) => number, nu: number, xs: number[], col: (x: number, a: number) => C3, uv?: (x: number, a: number) => [number, number]): THREE.BufferGeometry =>
  tube({
    path: (t) => [mix(x0, x1, t), 0, 0],
    radius: (t) => r(mix(x0, x1, t)),
    nu,
    ts: xs.map((x) => (x - x0) / (x1 - x0)),
    col: (t, a) => col(mix(x0, x1, t), a),
    uv: uv ? (t, a) => uv(mix(x0, x1, t), a) : () => [0.02, 0.02],
    ref: [0, 1, 0],
  });

/** The rod itself: butt cap, cork grips, reel seat, winding check, blank with thread wraps, guides and tip-top. */
function buildRod(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const wraps = [...GUIDES.map((g) => g[0]), ROD_LENGTH - 0.006];
  const wrapAt = (x: number): number => {
    for (const w of wraps) {
      const d = Math.abs(x - w);
      const half = w > ROD_LENGTH - 0.01 ? 0.012 : 0.016 + 0.01 * (1 - x / ROD_LENGTH);
      if (d < half) return d < half - 0.0025 ? 1 : 2; // 2 = the gold trim at each end
    }
    return 0;
  };
  const R = (x: number): number => {
    if (x < 0.012) return 0.0128;
    if (x < 0.215) return 0.0128 + 0.0012 * Math.sin((Math.PI * (x - 0.012)) / 0.203);
    if (x < 0.226) return 0.0119;
    if (x < 0.305) return 0.0104;
    if (x < 0.318) return 0.0122;
    if (x < 0.42) return mix(0.0118, 0.0097, (x - 0.318) / 0.102);
    if (x < 0.432) return 0.0086;
    return blankR(x) + (wrapAt(x) ? 0.00045 : 0);
  };
  const xs: number[] = [0, 0.006, 0.0118, 0.0122, 0.06, 0.11, 0.16, 0.2148, 0.2152, 0.2258, 0.2262, 0.3048, 0.3052, 0.3178, 0.3182, 0.37, 0.4198, 0.4202, 0.4318, 0.4322];
  for (const w of wraps) {
    const half = w > ROD_LENGTH - 0.01 ? 0.012 : 0.016 + 0.01 * (1 - w / ROD_LENGTH);
    // a sharp edge where the wrap meets the blank; the gold trim shades into the red
    xs.push(w - half - 0.0002, w - half + 0.0002, w - half + 0.0025, w + half - 0.0025, w + half - 0.0002, w + half + 0.0002);
  }
  for (let x = 0.5; x < ROD_LENGTH; x += 0.14) xs.push(x);
  xs.push(ROD_LENGTH);
  const sorted = [...new Set(xs.filter((x) => x >= 0 && x <= ROD_LENGTH).map((x) => Math.round(x * 1e5) / 1e5))].sort((a, b) => a - b);
  const cork = lin(0xffffff);
  const rubber = lin(0x2a2622);
  const seat = lin(0x23272b);
  const metalDark = lin(0x3a3c3e);
  const gold = lin(0xc9a24a);
  const blank = lin(0x1f3550);
  const wrap = lin(0x8a2a24);
  const body = tube({
    path: (t) => [t * ROD_LENGTH, 0, 0],
    radius: (t) => R(t * ROD_LENGTH),
    nu: 8,
    ts: sorted.map((x) => x / ROD_LENGTH),
    caps: [3, 0],
    capLen: 0.5,
    ref: [0, 1, 0],
    col: (t) => {
      const x = t * ROD_LENGTH;
      if (x < 0.012) return rubber;
      if (x < 0.215 || (x >= 0.318 && x < 0.42)) return cork;
      if (x < 0.226) return gold;
      if (x < 0.305) return seat;
      if (x < 0.318) return metalDark;
      if (x < 0.432) return gold;
      const w = wrapAt(x);
      return w === 1 ? wrap : w === 2 ? gold : blank;
    },
    uv: (t, a) => {
      const x = t * ROD_LENGTH;
      const isCork = (x >= 0.012 && x < 0.215) || (x >= 0.318 && x < 0.42);
      return isCork ? [x / 0.05, CORK_V0 + (1 - CORK_V0) * (a / TAU)] : [0.02, 0.02];
    },
  });
  // roughness and metalness by part
  {
    const pos = body.getAttribute('position');
    const rm = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const isCork = (x >= 0.012 && x < 0.215) || (x >= 0.318 && x < 0.42);
      const isMetal = (x >= 0.215 && x < 0.226) || (x >= 0.305 && x < 0.318) || (x >= 0.42 && x < 0.432) || wrapAt(x) === 2;
      // gold-anodised trim: only half metallic, so it stays gold and doesn't just mirror the sky
      rm[i * 2] = isCork ? 0.9 : x < 0.012 ? 0.8 : isMetal ? 0.4 : 0.22;
      rm[i * 2 + 1] = isMetal ? 0.5 : 0;
    }
    body.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  }
  parts.push(body);

  // Guides: a ring (dark frame, pale ceramic insert) on two slanting legs under the blank.
  const ring = (x: number, r: number, below: number, segs: number): void => {
    const tubeR = 0.0009 + r * 0.09;
    const g = new THREE.TorusGeometry(r, tubeR, segs > 8 ? 4 : 3, segs);
    g.rotateY(Math.PI / 2);
    g.translate(x, -below, 0);
    const p = g.getAttribute('position');
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const d = Math.hypot(p.getY(i) + below, p.getZ(i));
      c.set(d < r ? lin(0xd8d4cc) : lin(0x2e3236), i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(p.count * 2).fill(0.02), 2));
    parts.push(withRM(g, 0.25, 0.8));
  };
  for (const [x, r, below] of GUIDES) {
    ring(x, r, below, r > 0.006 ? 12 : 8);
    const top = -blankR(x) * 0.6;
    for (const [dx, side] of [
      [0.012 + r * 0.6, 1],
      [-0.012 - r * 0.9, -1],
    ] as const) {
      const a: V3 = [x + side * r * 0.15, -below + r * 0.92, 0];
      const b: V3 = [x + dx, top, 0];
      const leg = tube({
        path: (t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), 0],
        radius: () => 0.00085,
        nu: 4,
        ts: [0, 1],
        ref: [0, 0, 1],
        col: () => lin(0x2e3236),
        uv: () => [0.02, 0.02],
      });
      parts.push(withRM(leg, 0.3, 0.8));
    }
  }
  // the tip-top: a little ring right at the end
  ring(ROD_LENGTH + 0.002, TIP_RING[0], TIP_RING[1], 8);
  const merged = mergeGeometries(parts.map((g) => keepRodAttrs(g)));
  if (!merged) throw new Error('rod: could not merge');
  return merged;
}

function keepRodAttrs(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g : g.setIndex([...Array(g.getAttribute('position').count).keys()]);
  for (const name of Object.keys(ng.attributes)) if (!['position', 'normal', 'color', 'uv', 'rm'].includes(name)) ng.deleteAttribute(name);
  return ng;
}

/** Reel centre line: the spool and rotor turn about the line y = REEL_Y, z = 0. */
const REEL_X = 0.252;
const REEL_Y = -0.066;

/** The reel's fixed parts: foot and stem, gearbox body, spool with line on it. */
function buildReelBody(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const graphite = lin(0x2a2d31);
  const gold = lin(0xc79a3c);
  // foot on the reel seat, and the stem down to the body
  const foot = tube({
    path: (t) => [mix(0.232, 0.298, t), -0.0108, 0],
    radius: (_t, a) => (Math.abs(Math.sin(a)) > 0.7 ? 0.0012 : 0.0055) * 1,
    nu: 6,
    ts: [0, 0.5, 1],
    caps: [2, 2],
    capLen: 0.4,
    ref: [0, 1, 0],
    col: () => graphite,
    uv: () => [0.02, 0.02],
  });
  parts.push(withRM(foot, 0.35, 0.4));
  const stem = tube({
    path: (t) => [mix(0.262, REEL_X + 0.004, t), mix(-0.012, REEL_Y + 0.012, t), 0],
    radius: (t, a) => mix(0.0045, 0.0068, t) * (Math.abs(Math.cos(a)) > 0.5 ? 0.62 : 1),
    nu: 6,
    ts: [0, 0.5, 1],
    ref: [0, 0, 1],
    col: () => graphite,
    uv: () => [0.02, 0.02],
  });
  parts.push(withRM(stem, 0.35, 0.4));
  // gearbox body: a rounded housing
  const bodyGeo = grid({
    us: steps(12),
    vs: steps(7),
    wrapU: true,
    pos: (u, v) => {
      const th = TAU * u;
      const ph = Math.PI * v;
      const sx = Math.cos(ph);
      const r = Math.sin(ph);
      // a fatter back, narrowing to the rotor at the front
      const rx = sx < 0 ? 0.024 : 0.018;
      return [REEL_X + rx * sx, REEL_Y + 0.02 * r * Math.sin(th), 0.0185 * r * Math.cos(th)];
    },
    col: (_u, v) => (Math.abs(v - 0.62) < 0.05 ? gold : graphite),
  });
  parts.push(withRM(bodyGeo, 0.3, 0.45));
  // spool, with line wound on it
  const sx0 = 0.287;
  const sx1 = 0.313;
  const spool = tubeAlongX(
    sx0,
    sx1 + 0.002,
    (x) => (x < sx0 + 0.003 ? 0.0215 : x > sx1 - 0.002 ? 0.0218 : 0.0192),
    14,
    [sx0, sx0 + 0.0028, sx0 + 0.0032, sx1 - 0.0022, sx1 - 0.0018, sx1 + 0.002],
    (x) => (x > sx0 + 0.003 && x < sx1 - 0.002 ? lin(0xd8e2d0) : gold),
  );
  spool.translate(0, REEL_Y, 0);
  parts.push(withRM(spool, 0.4, 0.3));
  // the spool's front face
  const face = new THREE.CircleGeometry(0.0216, 14);
  face.rotateY(Math.PI / 2);
  face.translate(sx1 + 0.002, REEL_Y, 0);
  parts.push(plain(face, gold, 0.4, 0.5));
  return mergeGeometries(parts.map((g) => keepRodAttrs(g)))!;
}

/** The rotor (cup, two arms and the bail wire), built round its own turning axis (x). */
function buildRotor(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const dark = lin(0x303438);
  const silver = lin(0xc8ccd0);
  const cup = tubeAlongX(
    0.268,
    0.288,
    (x) => mix(0.012, 0.0235, smooth(0.268, 0.282, x)),
    12,
    [0.268, 0.274, 0.28, 0.284, 0.288],
    (x) => (x > 0.285 ? lin(0xb88a34) : dark),
  );
  parts.push(withRM(cup, 0.3, 0.5));
  for (const side of [1, -1]) {
    const arm = tube({
      path: (t) => [mix(0.282, 0.304, t), side * mix(0.022, 0.0262, t), 0],
      radius: () => 0.0028,
      nu: 5,
      ts: [0, 0.5, 1],
      caps: [0, 2],
      ref: [0, 0, 1],
      col: () => dark,
      uv: () => [0.02, 0.02],
    });
    parts.push(withRM(arm, 0.3, 0.5));
  }
  // the bail: a wire arc round the far side of the spool, from arm to arm
  const bail = tube({
    path: (t) => {
      const a = -Math.PI / 2 + Math.PI * t;
      return [0.304 + 0.004 * Math.sin(Math.PI * t), 0.0262 * Math.sin(-a), 0.0262 * Math.cos(a) * 1.04];
    },
    radius: () => 0.0011,
    nu: 4,
    ts: steps(12),
    ref: [1, 0, 0],
    col: () => silver,
    uv: () => [0.02, 0.02],
  });
  parts.push(withRM(bail, 0.2, 0.9));
  return mergeGeometries(parts.map((p) => keepRodAttrs(p)))!;
}

/** The handle: hub, crank arm and knob, built round its own axle (z, at the origin). */
function buildHandle(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const dark = lin(0x2c3034);
  const hub = tube({
    path: (t) => [0, 0, mix(-0.018, -0.03, t)],
    radius: () => 0.0055,
    nu: 8,
    ts: [0, 1],
    caps: [0, 2],
    capLen: 0.4,
    ref: [0, 1, 0],
    col: () => mixC(dark, lin(0xc79a3c), 0.3),
    uv: () => [0.02, 0.02],
  });
  parts.push(withRM(hub, 0.3, 0.7));
  const arm = tube({
    path: (t) => [0, -0.044 * t, -0.031],
    radius: (_t, a) => (Math.abs(Math.cos(a)) > 0.6 ? 0.0016 : 0.0034),
    nu: 6,
    ts: [0, 0.5, 1],
    caps: [2, 2],
    capLen: 0.5,
    ref: [0, 0, 1],
    col: () => dark,
    uv: () => [0.02, 0.02],
  });
  parts.push(withRM(arm, 0.3, 0.7));
  // a wooden knob, sticking out sideways
  const knob = tube({
    path: (t) => [0, -0.044, mix(-0.032, -0.051, t)],
    radius: (t) => 0.0052 * (0.8 + 0.25 * Math.sin(Math.PI * t)),
    nu: 7,
    ts: [0, 0.3, 0.7, 1],
    caps: [0, 3],
    capLen: 0.5,
    ref: [0, 1, 0],
    col: (t) => mixC(lin(0x9a6a3a), lin(0xb88452), t),
    uv: () => [0.02, 0.02],
  });
  parts.push(withRM(knob, 0.55, 0));
  return mergeGeometries(parts.map((p) => keepRodAttrs(p)))!;
}

let rodParts: { rod: THREE.BufferGeometry; reel: THREE.BufferGeometry; rotor: THREE.BufferGeometry; handle: THREE.BufferGeometry } | null = null;

export interface Rod {
  /** The whole rod: butt at the origin, along +x, reel below. */
  readonly group: THREE.Group;
  /** The reel's handle (turns about its local z) and rotor (turns about its local x). */
  readonly handle: THREE.Object3D;
  readonly rotor: THREE.Object3D;
  /** Bow the blank: 0 = straight, 1 = bent hard (tip pulled down toward the line); negative bows it up. */
  setBend(amount: number): void;
  readonly bend: number;
  /** The tip (where the line leaves the tip-top ring), in the rod's own space, for the current bend. */
  tipLocal(out?: THREE.Vector3): THREE.Vector3;
  /** Turn the handle (radians); the rotor turns 5.2 times as fast, as in a real reel. */
  turnHandle(angle: number): void;
}

/** A new spinning rod with its reel (geometry shared between rods; material per rod, for its own bend). */
export function rodModel(): Rod {
  rodParts ??= { rod: buildRod(), reel: buildReelBody(), rotor: buildRotor(), handle: buildHandle() };
  const bend = { value: 0 };
  const mat = rodMaterial(bend);
  const group = new THREE.Group();
  group.name = 'rod';
  const rod = new THREE.Mesh(rodParts.rod, mat);
  const reel = new THREE.Mesh(rodParts.reel, mat);
  const rotor = new THREE.Mesh(rodParts.rotor, mat);
  // the rotor and the handle are built round their own axles, and placed on the reel
  rotor.position.set(0, REEL_Y, 0);
  const handle = new THREE.Mesh(rodParts.handle, mat);
  handle.position.set(REEL_X, REEL_Y, 0);
  group.add(rod, reel, rotor, handle);
  for (const m of [rod, reel, rotor, handle]) m.frustumCulled = false;
  const tmp = new THREE.Vector2();
  return {
    group,
    handle,
    rotor,
    get bend() {
      return bend.value;
    },
    setBend(amount: number) {
      bend.value = clamp(amount, -1, 1.2);
    },
    tipLocal(out = new THREE.Vector3()) {
      bentRodPoint(ROD_LENGTH + 0.002, -TIP_RING[1], bend.value, tmp);
      return out.set(tmp.x, tmp.y, 0);
    },
    turnHandle(angle: number) {
      handle.rotation.z = angle;
      rotor.rotation.x = angle * 5.2;
    },
  };
}

/** Triangles in the rod and reel together. */
export function rodTriangles(): number {
  rodParts ??= { rod: buildRod(), reel: buildReelBody(), rotor: buildRotor(), handle: buildHandle() };
  return Object.values(rodParts).reduce((n, g) => n + (g.index ? g.index.count : g.getAttribute('position').count) / 3, 0);
}

// ---------------------------------------------------------------------------
// The line, the float, and what happens on the water
// ---------------------------------------------------------------------------

const LINE_SEGS = 40;
/** The float's radius (a 5 cm bobber). */
const FLOAT_R = 0.025;
const RINGS = 5;
// colours of the line and the white water (linear)
const LINE_COL = lin(0xeef2ea);
const FOAM_COL = lin(0xf4fbff);
const WHITE = lin(0xffffff);
const FLASH_DARK = lin(0x2c4a58);
const FLASH_BRIGHT = mulC(lin(0xffffff), 1.6);
const RING_SEGS = 24;
const DROPS = 28;
const FOAM = 3;
const FLASH_RIM = 12;

interface Ripple {
  x: number;
  z: number;
  age: number;
  life: number;
  r0: number;
  r1: number;
  strength: number;
}
interface Drop {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
}

const FX_VERT = /* glsl */ `
attribute vec4 rgba;
attribute vec4 offs;
uniform float uWidth;
varying vec4 vCol;
varying vec2 vUv;
varying vec2 vW;
void main() {
  vec3 p = position;
  vW = p.xz;
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  if (offs.w != 0.0) {
    // the line: a ribbon widened across the view, about the same width on screen near and far
    vec3 side = normalize(cross(offs.xyz, toCam));
    p += side * offs.w * max(uWidth * dist, 0.0006);
    vUv = vec2(-2.0);
  } else if (offs.z > 0.0) {
    // a splash drop, facing the camera
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p += (right * offs.x + up * offs.y) * offs.z;
    vUv = offs.xy;
  } else {
    vUv = offs.xy;
  }
  vCol = rgba;
  // Nudge everything a little toward the camera: it stays put on screen, but rings and foam lying on
  // the water aren't lost under the crest of a ripple.
  vec3 back = cameraPosition - p;
  float bd = length(back);
  p += back / max(bd, 1e-4) * min(bd * 0.5, 0.03 + 0.012 * bd);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FX_FRAG = /* glsl */ `
uniform float uDay;
varying vec4 vCol;
varying vec2 vUv;
varying vec2 vW;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float r = length(vUv);
  float shape = vUv.x < -1.5 ? 1.0 : 1.0 - smoothstep(0.2, 1.0, r);
  // foam patches (alpha above 1 marks them): bubbly and broken up
  float a = vCol.a;
  if (a > 1.0) {
    a -= 1.0;
    float n = vnoise(vW * 22.0) * 0.6 + vnoise(vW * 55.0 + 7.0) * 0.4;
    shape = smoothstep(0.4, 0.62, n * (1.35 - r));
  }
  a *= shape;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol.rgb * (0.22 + 0.78 * uDay), a);
}`;

/** The float: a round red-and-white bobber with a little stem, its middle at the waterline. */
function buildFloat(): THREE.BufferGeometry {
  const R = FLOAT_R;
  const red = lin(0xd8262a);
  const white = lin(0xf4f1ea);
  const ball = grid({
    us: steps(14),
    vs: [0, 0.1, 0.22, 0.36, 0.47, 0.5, 0.53, 0.64, 0.78, 0.9, 1],
    wrapU: true,
    flip: true,
    pos: (u, v) => {
      const th = TAU * u;
      const ph = Math.PI * v;
      return [R * Math.sin(ph) * Math.cos(th), R * Math.cos(ph), R * Math.sin(ph) * Math.sin(th)];
    },
    col: (_u, v) => (v < 0.5 ? red : white),
  });
  const stem = tube({
    path: (t) => [0, mix(R * 0.85, R + 0.016, t), 0],
    radius: (t) => mix(0.0036, 0.0028, t),
    nu: 6,
    ts: [0, 0.6, 1],
    caps: [0, 2],
    capLen: 0.6,
    ref: [1, 0, 0],
    col: (t) => (t > 0.6 ? red : white),
  });
  const nub = tube({
    path: (t) => [0, mix(-R * 0.85, -R - 0.006, t), 0],
    radius: () => 0.0025,
    nu: 6,
    ts: [0, 1],
    caps: [0, 2],
    ref: [1, 0, 0],
    col: () => white,
  });
  const g = mergeGeometries([ball, stem, nub]);
  if (!g) throw new Error('float: could not merge');
  return g;
}

/**
 * The line from the rod tip to the float, the float bobbing on the water,
 * and the ripples, splashes and the flash of a fighting fish. Add `group` to
 * the world scene, and `overWater` to the things the under-water picture
 * skips (Pipeline's aboveWaterOnly), so they aren't seen twice.
 */
export class FishingLine {
  readonly group = new THREE.Group();
  readonly overWater: THREE.Object3D[];
  /** The float, so you can check where it is drawn. */
  readonly float: THREE.Mesh;
  /** Line width, in metres per metre from the camera (about 1.5 pixels on a phone). */
  lineWidth = 0.0022;
  /** Draw the float larger when it's far away, so a bite stays easy to see (1 = always real size). */
  floatBoost = 4;
  /**
   * Optional: the water's height at (x, z) right now (e.g. ocean.heightAt(x, z, time)), so ripples and
   * foam follow the waves around the float. Without it they lie level at the float's height.
   * Sampled 25 times a frame, on a small grid round the float.
   */
  waterAt: ((x: number, z: number) => number) | null = null;
  private wGrid = new Float32Array(25);
  private wX0 = 0;
  private wZ0 = 0;
  private wLevel = 0;

  private fx: THREE.Mesh;
  private fxMat: THREE.ShaderMaterial;
  private pos: Float32Array;
  private col: Float32Array;
  private offs: Float32Array;
  private out = false;
  private lastTime = NaN;
  private ripples: Ripple[] = [];
  private drops: Drop[] = [];
  private dip = 0;
  private dipVel = 0;
  private biteHold = 0;
  private biteStrength = 0;
  private twitch = 0;
  private fight = 0;
  private wakeTimer = 0;
  private spawnTimer = 0;
  private prevFloat = new THREE.Vector3(NaN, 0, 0);
  private floatPos = new THREE.Vector3();
  private seed = 1;
  private axis = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  // vertex layout
  private readonly vLine = 0;
  private readonly vRings = (LINE_SEGS + 1) * 2;
  private readonly vDrops = this.vRings + RINGS * (RING_SEGS + 1) * 3;
  private readonly vFoam = this.vDrops + DROPS * 4;
  private readonly vFlash = this.vFoam + FOAM * 4;
  private readonly vCount = this.vFlash + 1 + FLASH_RIM * 2;

  constructor() {
    this.group.name = 'fishingLine';
    const floatMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0 });
    floatMat.name = 'float';
    this.float = new THREE.Mesh(buildFloat(), floatMat);
    this.float.castShadow = true;
    this.float.name = 'float';

    const n = this.vCount;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.offs = new Float32Array(n * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rgba', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('offs', new THREE.BufferAttribute(this.offs, 4).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < LINE_SEGS; i++) {
      const a = this.vLine + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    for (let r = 0; r < RINGS; r++) {
      const base = this.vRings + r * (RING_SEGS + 1) * 3;
      for (let s = 0; s < RING_SEGS; s++) {
        for (let row = 0; row < 2; row++) {
          const a = base + s * 3 + row;
          const b = a + 3;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    for (let d = 0; d < DROPS + FOAM; d++) {
      const a = this.vDrops + d * 4;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    const c = this.vFlash;
    for (let k = 0; k < FLASH_RIM; k++) {
      const k1 = (k + 1) % FLASH_RIM;
      const i0 = c + 1 + k;
      const i1 = c + 1 + k1;
      const o0 = i0 + FLASH_RIM;
      const o1 = i1 + FLASH_RIM;
      idx.push(c, i0, i1, i0, o0, i1, i1, o0, o1);
    }
    g.setIndex(idx);
    // static parts of the layout: corner codes for drops and foam, "solid" for the rest
    for (let i = 0; i < n; i++) this.offs.set([-2, -2, 0, 0], i * 4);
    for (let d = 0; d < DROPS + FOAM; d++) {
      const corners = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ];
      for (let k = 0; k < 4; k++) this.offs.set([corners[k][0], corners[k][1], 0, 0], (this.vDrops + d * 4 + k) * 4);
    }
    this.fxMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uWidth: { value: this.lineWidth }, uDay: { value: 1 } },
      vertexShader: FX_VERT,
      fragmentShader: FX_FRAG,
    });
    this.fxMat.name = 'fishingLine';
    this.fx = new THREE.Mesh(g, this.fxMat);
    this.fx.frustumCulled = false;
    this.fx.renderOrder = 4;
    this.fx.name = 'fishingLineFx';
    this.group.add(this.float, this.fx);
    this.overWater = [this.fx];
    this.group.visible = false;
  }

  /** Show or hide the line and float. */
  setOut(on: boolean): void {
    this.out = on;
    this.group.visible = on;
    if (!on) {
      this.ripples.length = 0;
      this.drops.length = 0;
      this.fight = 0;
      this.biteHold = 0;
      this.dip = this.dipVel = 0;
      this.prevFloat.set(NaN, 0, 0);
    }
  }

  get isOut(): boolean {
    return this.out;
  }

  /** 0 = night .. 1 = full day: dims the line and splashes (they're unlit). */
  setDaylight(day: number): void {
    this.fxMat.uniforms.uDay.value = clamp(day, 0, 1);
  }

  /** A fish takes the bait: the float dips and twitches. Strength 0..1 (1 pulls it right under for a moment). */
  bite(strength: number): void {
    const s = clamp(strength, 0, 1);
    this.biteStrength = Math.max(s, this.biteHold > 0 ? this.biteStrength : 0);
    this.biteHold = 0.08 + 0.4 * s;
    this.dipVel -= 0.25 + 0.7 * s;
    this.twitch = Math.max(this.twitch, 0.4 + 0.6 * s);
    this.ripple(this.floatPos.x, this.floatPos.z, 0.04, 0.35 + 0.3 * s, 0.5 + 0.4 * s, 0.9);
  }

  /** The float lands on the water: a splash and spreading rings (where the float is, or at `at`). */
  landed(at?: THREE.Vector3): void {
    if (at) this.floatPos.copy(at);
    const p = this.floatPos;
    this.ripple(p.x, p.z, 0.05, 0.9, 1.0, 1.6);
    this.ripple(p.x, p.z, 0.02, 0.55, 0.7, 1.2);
    this.dipVel -= 0.6;
    for (let i = 0; i < 12; i++) this.drop(p, 0.6 + this.rand() * 0.9, 0.5 + this.rand() * 0.5);
  }

  /** A fish fighting on the line, 0..1: white splashes at the float and a silver flash as it turns at the surface. */
  fighting(amount: number): void {
    this.fight = clamp(amount, 0, 1);
  }

  /**
   * Call every frame while the line is out.
   * @param tipWorld   the rod tip in world space (HeldView.rodTipWorld)
   * @param floatWorld where the float is, on the water (y = the water's height there)
   * @param time       the clock, in seconds
   * @param tension    0 = slack line (it sags) .. 1 = tight (straight)
   */
  update(tipWorld: THREE.Vector3, floatWorld: THREE.Vector3, time: number, tension: number): void {
    if (!this.out) return;
    const dt = Number.isFinite(this.lastTime) ? clamp(time - this.lastTime, 0, 0.1) : 0;
    this.lastTime = time;
    const ten = clamp(tension, 0, 1);
    this.fxMat.uniforms.uWidth.value = this.lineWidth;
    const water = floatWorld.y;
    const dist = Math.max(0.5, tipWorld.distanceTo(floatWorld));
    const boost = clamp(dist / 3.5, 1, Math.max(1, this.floatBoost));

    // ---- the float: bobbing, dipping on a bite, jerking about while a fish fights
    this.biteHold = Math.max(0, this.biteHold - dt);
    if (this.biteHold <= 0) this.biteStrength *= Math.exp(-dt * 4);
    this.twitch *= Math.exp(-dt * 3.5);
    const fight = this.fight;
    let target = 0;
    if (this.biteHold > 0) target = -(0.012 + 0.05 * this.biteStrength) * boost;
    if (fight > 0) target = Math.min(target, -0.025 * fight * boost * (0.6 + 0.4 * Math.sin(time * 7.3) * Math.sin(time * 2.1)));
    target -= 0.008 * ten * boost; // a tight line pulls it down a little
    const k = 140;
    const c = 11;
    this.dipVel += (-k * (this.dip - target) - c * this.dipVel) * dt;
    this.dip += this.dipVel * dt;
    const bob = (0.004 * Math.sin(time * 2.3) + 0.0025 * Math.sin(time * 3.9 + 1.3)) * boost;
    const jx = (0.012 * this.twitch * Math.sin(time * 37) + 0.05 * fight * Math.sin(time * 5.1 + Math.sin(time * 1.7) * 2)) * boost;
    const jz = (0.012 * this.twitch * Math.cos(time * 31) + 0.05 * fight * Math.cos(time * 4.3 + 1)) * boost;
    const fp = this.floatPos.set(floatWorld.x + jx, water + bob + this.dip, floatWorld.z + jz);
    this.float.position.copy(fp);
    this.float.scale.setScalar(boost);
    // lean toward the rod when the line is tight; rock a little otherwise
    const toTip = Math.atan2(tipWorld.x - fp.x, tipWorld.z - fp.z);
    const lean = 0.08 * Math.sin(time * 1.7) + 0.45 * ten + 0.25 * fight * Math.sin(time * 6);
    this.float.rotation.set(0, 0, 0);
    this.float.rotateOnWorldAxis(this.axis.set(Math.cos(toTip), 0, -Math.sin(toTip)), lean);
    this.float.rotateOnWorldAxis(this.axis.set(1, 0, 0), 0.06 * Math.sin(time * 2.9 + 0.5));

    // ---- ripples behind the float while it's pulled through the water
    if (Number.isFinite(this.prevFloat.x) && dt > 0) {
      const speed = Math.hypot(floatWorld.x - this.prevFloat.x, floatWorld.z - this.prevFloat.z) / dt;
      this.wakeTimer -= dt;
      if (speed > 0.25 && this.wakeTimer <= 0) {
        this.wakeTimer = 0.28;
        this.ripple(floatWorld.x, floatWorld.z, 0.03, 0.22 + Math.min(0.3, speed * 0.08), 0.35, 0.9);
      }
    }
    this.prevFloat.copy(floatWorld);
    // ---- a fighting fish throws up spray
    if (fight > 0.02) {
      this.spawnTimer -= dt * (4 + 16 * fight);
      while (this.spawnTimer <= 0) {
        this.spawnTimer += 1;
        const a = this.rand() * TAU;
        const r = 0.08 * boost + 0.25 * this.rand() * fight;
        this.drop(this.tmp.set(fp.x + Math.cos(a) * r, water, fp.z + Math.sin(a) * r), 0.5 + fight * 0.9 * this.rand(), 0.35 + 0.5 * this.rand());
        if (this.rand() < 0.12) this.ripple(fp.x + Math.cos(a) * r, fp.z + Math.sin(a) * r, 0.03, 0.4, 0.5 * fight, 0.8);
      }
    }

    // ---- the water round the float, for things lying on it
    this.sampleWater(floatWorld.x, floatWorld.z, water);
    // ---- write the mesh
    this.writeLine(tipWorld, fp, boost, ten, water);
    this.writeRipples(dt, water);
    this.writeDrops(dt, water, boost);
    this.writeFoam(fp, time, fight, boost);
    this.writeFlash(fp, time, fight);
    const g = this.fx.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('rgba').needsUpdate = true;
    g.getAttribute('offs').needsUpdate = true;
  }

  private writeLine(tip: THREE.Vector3, fp: THREE.Vector3, boost: number, ten: number, water: number): void {
    // The line leaves the float from the top of its stem.
    const ex = fp.x;
    const ey = fp.y + (FLOAT_R + 0.016) * boost;
    const ez = fp.z;
    const horiz = Math.hypot(ex - tip.x, ez - tip.z);
    const span = Math.hypot(horiz, ey - tip.y);
    const slack = (1 - ten) * (1 - ten);
    const sag = slack * (0.03 + 0.07 * horiz) + 0.004 * span;
    const lineCol = LINE_COL;
    const pts: V3[] = [];
    for (let i = 0; i <= LINE_SEGS; i++) {
      // more points near the tip, where the line is closest to you
      const t = Math.pow(i / LINE_SEGS, 1.6);
      let y = mix(tip.y, ey, t) - sag * 4 * t * (1 - t) * (1 + 0.6 * (t - 0.5));
      // where it sags to the water, it lies on the surface (up to the float, which may be pulled under)
      const x = mix(tip.x, ex, t);
      const z = mix(tip.z, ez, t);
      if (t < 0.96) y = Math.max(y, this.waterNear(x, z) + 0.004);
      pts.push([x, y, z]);
    }
    for (let i = 0; i <= LINE_SEGS; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(LINE_SEGS, i + 1)];
      const dir: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const alpha = 0.85;
      for (let s = 0; s < 2; s++) {
        const v = this.vLine + i * 2 + s;
        this.pos.set(p, v * 3);
        this.col.set([lineCol[0], lineCol[1], lineCol[2], alpha], v * 4);
        this.offs.set([dir[0], dir[1], dir[2], s === 0 ? -0.5 : 0.5], v * 4);
      }
    }
  }

  private static readonly W_SPAN = 3;

  private sampleWater(x: number, z: number, level: number): void {
    this.wLevel = level;
    const h = FishingLine.W_SPAN / 2;
    this.wX0 = x - h;
    this.wZ0 = z - h;
    const f = this.waterAt;
    for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) this.wGrid[j * 5 + i] = f ? f(this.wX0 + (i / 4) * FishingLine.W_SPAN, this.wZ0 + (j / 4) * FishingLine.W_SPAN) : level;
  }

  /** Water height near the float (from the sampled grid; level outside it). */
  private waterNear(x: number, z: number): number {
    const gx = ((x - this.wX0) / FishingLine.W_SPAN) * 4;
    const gz = ((z - this.wZ0) / FishingLine.W_SPAN) * 4;
    if (gx < 0 || gz < 0 || gx > 4 || gz > 4) return this.wLevel;
    const i = Math.min(3, Math.floor(gx));
    const j = Math.min(3, Math.floor(gz));
    const fx = gx - i;
    const fz = gz - j;
    const g = this.wGrid;
    const a = g[j * 5 + i] + (g[j * 5 + i + 1] - g[j * 5 + i]) * fx;
    const b = g[(j + 1) * 5 + i] + (g[(j + 1) * 5 + i + 1] - g[(j + 1) * 5 + i]) * fx;
    return a + (b - a) * fz;
  }

  private ripple(x: number, z: number, r0: number, r1: number, strength: number, life: number): void {
    if (this.ripples.length >= RINGS) {
      // replace the oldest
      let oldest = 0;
      for (let i = 1; i < this.ripples.length; i++) if (this.ripples[i].age / this.ripples[i].life > this.ripples[oldest].age / this.ripples[oldest].life) oldest = i;
      this.ripples.splice(oldest, 1);
    }
    this.ripples.push({ x, z, age: 0, life, r0, r1, strength });
  }

  private drop(at: THREE.Vector3, speed: number, life: number): void {
    if (this.drops.length >= DROPS) this.drops.shift();
    const a = this.rand() * TAU;
    const out = 0.25 + 0.6 * this.rand();
    this.drops.push({
      x: at.x,
      y: at.y + 0.01,
      z: at.z,
      vx: Math.cos(a) * out * speed,
      vy: speed * (1.2 + this.rand()),
      vz: Math.sin(a) * out * speed,
      age: 0,
      life,
      size: 0.012 + 0.02 * this.rand(),
    });
  }

  private rand(): number {
    this.seed = (this.seed + 1) | 0;
    return hash(this.seed, 17, 5);
  }

  private writeRipples(dt: number, water: number): void {
    for (const r of this.ripples) r.age += dt;
    this.ripples = this.ripples.filter((r) => r.age < r.life);
    const foam = FOAM_COL;
    for (let k = 0; k < RINGS; k++) {
      const r = this.ripples[k];
      const base = this.vRings + k * (RING_SEGS + 1) * 3;
      const t = r ? r.age / r.life : 1;
      const rad = r ? mix(r.r0, r.r1, 1 - (1 - t) * (1 - t)) : 0;
      const w = r ? 0.018 + 0.05 * t : 0;
      const a = r ? r.strength * Math.pow(1 - t, 1.4) * smooth(0, 0.05, t) * 0.7 : 0;
      for (let s = 0; s <= RING_SEGS; s++) {
        const ang = (s / RING_SEGS) * TAU;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        for (let row = 0; row < 3; row++) {
          const rr = Math.max(0, rad + (row - 1) * w);
          const v = base + s * 3 + row;
          const px = (r?.x ?? 0) + ca * rr;
          const pz = (r?.z ?? 0) + sa * rr;
          this.pos.set([px, (r ? this.waterNear(px, pz) : water) + 0.012, pz], v * 3);
          this.col.set([foam[0], foam[1], foam[2], row === 1 ? a : 0], v * 4);
        }
      }
    }
  }

  private writeDrops(dt: number, water: number, boost: number): void {
    for (const d of this.drops) {
      d.age += dt;
      d.vy -= 9.8 * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
    }
    this.drops = this.drops.filter((d) => d.age < d.life && d.y > water - 0.02);
    const white = WHITE;
    for (let k = 0; k < DROPS; k++) {
      const d = this.drops[k];
      const a = d ? 0.85 * (1 - d.age / d.life) : 0;
      const size = d ? d.size * Math.min(2, Math.sqrt(boost)) * (1 + d.age) : 0;
      for (let c = 0; c < 4; c++) {
        const v = this.vDrops + k * 4 + c;
        this.pos.set(d ? [d.x, d.y, d.z] : [0, -1000, 0], v * 3);
        this.col.set([white[0], white[1], white[2], a], v * 4);
        this.offs[v * 4 + 2] = size;
      }
    }
  }

  private writeFoam(fp: THREE.Vector3, time: number, fight: number, boost: number): void {
    const white = FOAM_COL;
    for (let k = 0; k < FOAM; k++) {
      const ang = k * 2.1 + time * (0.6 + k * 0.3);
      const off = (0.05 + 0.08 * k) * boost * fight;
      const cx = fp.x + Math.cos(ang) * off;
      const cz = fp.z + Math.sin(ang) * off;
      const size = (0.16 + 0.12 * k) * Math.max(1, boost * 0.6) * (0.65 + 0.35 * Math.sin(time * 3 + k * 2));
      // (alpha above 1 tells the shader it's foam)
      const a = fight > 0.002 ? 1 + fight * (0.9 - 0.15 * k) * (0.7 + 0.3 * Math.sin(time * 9 + k)) : 0;
      const corners = [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ];
      for (let c = 0; c < 4; c++) {
        const v = this.vFoam + k * 4 + c;
        const px = cx + corners[c][0] * size;
        const pz = cz + corners[c][1] * size;
        this.pos.set([px, this.waterNear(px, pz) + 0.012, pz], v * 3);
        this.col.set([white[0], white[1], white[2], a], v * 4);
        this.offs.set([corners[c][0], corners[c][1], 0, 0], v * 4);
      }
    }
  }

  private writeFlash(fp: THREE.Vector3, time: number, fight: number): void {
    // A silver fish shape just under the surface, swinging about the float; it flashes as it rolls.
    const ang = time * 1.4 + Math.sin(time * 0.7) * 2;
    const r = 0.35 + 0.15 * Math.sin(time * 0.9);
    const cx = fp.x + Math.cos(ang) * r;
    const cz = fp.z + Math.sin(ang) * r;
    const head = ang + Math.PI / 2 + 0.4 * Math.sin(time * 5);
    const hx = Math.cos(head);
    const hz = Math.sin(head);
    const roll = Math.max(0, Math.sin(time * 4.7) * Math.sin(time * 1.3 + 1));
    // a dark back just under the surface, flashing bright silver when it rolls onto its side
    const a = fight * (0.45 + 0.45 * roll);
    const L = 0.34;
    const W = 0.06 + 0.04 * roll;
    const silver = mixC(FLASH_DARK, FLASH_BRIGHT, Math.min(1, roll * 1.4));
    const c = this.vFlash;
    this.pos.set([cx, this.waterNear(cx, cz) + 0.01, cz], c * 3);
    this.col.set([silver[0], silver[1], silver[2], a], c * 4);
    for (let k = 0; k < FLASH_RIM; k++) {
      const t = (k / FLASH_RIM) * TAU;
      // a fish outline: a blunt head, tapering to the tail
      const along = Math.cos(t);
      const across = Math.sin(t) * Math.pow(Math.max(0, 1 - along * along), 0.5) * (1 + 0.35 * along);
      for (let ring = 0; ring < 2; ring++) {
        const grow = ring === 0 ? 0.8 : 1.15;
        const lx = along * L * 0.5 * grow;
        const lz = across * W * grow;
        const v = c + 1 + k + ring * FLASH_RIM;
        const px = cx + hx * lx - hz * lz;
        const pz = cz + hz * lx + hx * lz;
        this.pos.set([px, this.waterNear(px, pz) + 0.01, pz], v * 3);
        this.col.set([silver[0], silver[1], silver[2], ring === 0 ? a * 0.85 : 0], v * 4);
      }
    }
  }
}
