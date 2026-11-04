/**
 * Sharks, modelled and painted in code like the fish (DECISIONS 13 and 14):
 * real shapes and colours, a little rounded, menacing but calm.
 *
 *   reef   Caribbean reef shark, 2.2 m: grey-bronze above, white below, dusky fin tips
 *   nurse  nurse shark, 2.6 m: tawny-brown and stocky, two dorsal fins far back,
 *          barbels at the nostrils, a long low tail; often rests on the sand
 *
 * `sharkModel(kind)` gives a new Group at real size in metres: length along
 * +x, head at +x, back up (+y), centred on its bounding box. Body, fins, eyes
 * (and the nurse shark's barbels) are one mesh with one material, so one draw
 * call; about 3,000-3,500 triangles. `userData.finTip` is the top of the
 * first dorsal fin (for the fin wake), `userData.rest` how far the lowest
 * point is below the origin (lift it by that to rest it on the sand).
 *
 * `swim(obj, time, speed, turn)` makes the body wave from side to side in the
 * vertex shader, stronger toward the tail and faster with speed; `turn` bends
 * it into the turn; at speed 0 only the gills pump and the tail flicks lazily.
 *
 * `FinWake`: the white V of ripples and the splash where dorsal fins cut the
 * surface, for up to 8 sharks in one draw call. `baitModel()` is a chunk of
 * fish for bait, and `BaitCloud` the bits that sink when it hits the water.
 *
 * Angles follow the game (sailing.ts): heading h points along (cos h, sin h)
 * in world x, z, so a shark facing h has rotation.y = -h.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAU, add, clamp, cross, fbm, grid, hash, lin, mix, mixC, mulC, noise, norm, paintTexture, ramp, scl, smooth, srgb, steps, sub, tube, type C3, type V3 } from './finds';
import { lut, spline, type Pts } from './fish';

export type SharkKind = 'reef' | 'nurse';
export const SHARK_KINDS: SharkKind[] = ['reef', 'nurse'];
/** Total length, snout to tail tip, in metres (the models are built to it). */
export const SHARK_LENGTH: Record<SharkKind, number> = { reef: 2.2, nurse: 2.6 };

// ---------------------------------------------------------------------------
// The two sharks (lengths in shark lengths; s runs along the body from the
// snout, 0, to the start of the tail fin, 1)
// ---------------------------------------------------------------------------

interface FinSpec {
  /** Root along the body (s), and its height round the body (sin of the angle: 1 = back, -1 = belly). */
  s0: number;
  s1: number;
  at: number;
  /** Paired fins: +1 on the right (+z), -1 on the left. */
  side?: 1 | -1;
  /** Which way it reaches out: 'up', 'down', or a paired fin's droop below the horizontal (radians). */
  dir: 'up' | 'down' | number;
  /** How far it reaches, and how far back its tip sits from the front of its root. */
  span: number;
  sweep: number;
  /** 'falcate': a pointed, sickle-shaped fin (reef shark); 'round': a broad, rounded one (nurse shark). */
  shape: 'falcate' | 'round';
  /** Falcate fins: how much the leading edge bows out (power, above 1), and the trailing edge in (power, above 1). */
  lead?: number;
  trail?: number;
  /** How far the free rear tip reaches behind the root. */
  rear?: number;
  thick: number;
  /** Colour at a point: u along the chord, v out along the span (0 root .. 1 tip), face +1 top/right or -1 under/left. */
  col: (u: number, v: number, face: number) => C3;
  /** Fewer rows for small fins. */
  small?: boolean;
}

interface Species {
  length: number;
  /** Length of the body before the tail fin, as a share of the whole. */
  pre: number;
  top: Pts;
  bot: Pts;
  wid: Pts;
  nose: number;
  noseRound: number;
  /** Shape of the cross-section: exponents for the back and the belly (below 1 = flatter), side flatness, and narrowing to the back ridge. */
  exTop: number;
  exBot: number;
  flat: number;
  keel: number;
  eye: { s: number; y: number; r: number; iris: number };
  gills: [number, number];
  fins: FinSpec[];
  /** The tail fin's trailing edge, bottom tip to top tip, relative to the tail's root (x back is negative). */
  tail: [number, number, number][];
  tailThick: number;
  tailCol: (u: number, v: number) => C3;
  paint: (s: number, yn: number, side: number) => C3;
  rough: number;
  barbels?: boolean;
}

const dusky = (base: C3, tip: C3, from = 0.55) => (_u: number, v: number): C3 => mixC(base, tip, smooth(from, 1, v));

// --- Caribbean reef shark --------------------------------------------------
const R_BACK = lin(0x6b665a);
const R_FLANK = lin(0x8a8472);
const R_BELLY = lin(0xece8de);
const R_DUSK = lin(0x2e2e2c);

const REEF: Species = {
  length: 2.2,
  pre: 0.73,
  top: [[0, 0.02], [0.05, 0.034], [0.12, 0.056], [0.25, 0.076], [0.4, 0.085], [0.55, 0.077], [0.7, 0.056], [0.85, 0.036], [1, 0.026]],
  bot: [[0, 0.012], [0.05, 0.026], [0.12, 0.048], [0.25, 0.068], [0.4, 0.074], [0.55, 0.064], [0.7, 0.045], [0.85, 0.028], [1, 0.021]],
  wid: [[0, 0.02], [0.05, 0.038], [0.15, 0.06], [0.3, 0.074], [0.45, 0.071], [0.6, 0.054], [0.8, 0.032], [1, 0.019]],
  nose: 0.04,
  noseRound: 0.55,
  exTop: 0.9,
  exBot: 0.72,
  flat: 0.85,
  keel: 0.25,
  eye: { s: 0.078, y: 0.3, r: 0.0095, iris: 0x5e5a3a },
  gills: [0.26, 0.335],
  fins: [
    // first dorsal: tall, sickle-shaped, dusky along its trailing edge
    { s0: 0.39, s1: 0.56, at: 1, dir: 'up', span: 0.115, sweep: 0.075, shape: 'falcate', lead: 1.7, trail: 1.8, rear: 0.03, thick: 0.016, col: (u, v) => mixC(R_BACK, mulC(R_BACK, 0.7), smooth(0.6, 1, Math.max(u, v)) * 0.8) },
    { s0: 0.82, s1: 0.875, at: 1, dir: 'up', span: 0.032, sweep: 0.024, shape: 'falcate', lead: 1.5, trail: 1.5, rear: 0.03, thick: 0.007, small: true, col: dusky(R_BACK, R_DUSK, 0.5) },
    { s0: 0.82, s1: 0.875, at: -1, dir: 'down', span: 0.032, sweep: 0.026, shape: 'falcate', lead: 1.5, trail: 1.5, rear: 0.025, thick: 0.007, small: true, col: dusky(R_FLANK, R_DUSK, 0.4) },
    // pectorals: long and narrow, held out like wings; pale underneath with dusky tips
    ...([1, -1] as const).map(
      (side): FinSpec => ({
        s0: 0.31,
        s1: 0.44,
        at: -0.55,
        side,
        dir: 0.5,
        span: 0.175,
        sweep: 0.1,
        shape: 'falcate',
        lead: 1.6,
        trail: 1.5,
        rear: 0.012,
        thick: 0.014,
        col: (_u, v, face) => mixC(face > 0 ? R_BACK : R_BELLY, R_DUSK, smooth(0.6, 1, v) * (face > 0 ? 0.55 : 0.9)),
      }),
    ),
    ...([1, -1] as const).map(
      (side): FinSpec => ({ s0: 0.655, s1: 0.725, at: -0.8, side, dir: 0.8, span: 0.055, sweep: 0.04, shape: 'falcate', lead: 1.4, trail: 1.4, rear: 0.02, thick: 0.008, small: true, col: (_u, v, face) => mixC(face > 0 ? R_FLANK : R_BELLY, R_DUSK, smooth(0.5, 1, v) * 0.8) }),
    ),
  ],
  tail: [
    [-0.095, -0.11, 0],
    [-0.085, -0.075, 0.12],
    [-0.062, -0.035, 0.24],
    [-0.05, -0.008, 0.32],
    [-0.088, 0.03, 0.44],
    [-0.14, 0.068, 0.6],
    [-0.19, 0.102, 0.74],
    [-0.2, 0.108, 0.8],
    [-0.232, 0.13, 0.9],
    [-0.26, 0.16, 1],
  ],
  tailThick: 0.03,
  tailCol: (u, v) => mixC(mixC(R_BACK, R_FLANK, 0.3), R_DUSK, smooth(0.6, 1, v) * (u < 0.3 ? 0.9 : 0.45)),
  paint: (s, yn, side) => {
    const flank = smooth(-0.42, -0.22, yn);
    let c = mixC(SR_BELLY, ramp([SR_FLANK, SR_MID, SR_BACK], smooth(-0.3, 0.9, yn)), flank);
    // the faint pale band along the flank of the requiem sharks
    c = mixC(c, SR_BAND, smooth(0.16, 0.0, Math.abs(yn + 0.12 - 0.05 * s)) * smooth(0.42, 0.55, s) * smooth(0.95, 0.75, s) * 0.45);
    // bronze sheen and a soft mottle in the skin
    c = mixC(c, SR_BRONZE, smooth(0.1, 0.7, yn) * 0.25 * fbm(s * 7, yn * 3 + side, 811, 2));
    c = mulC(c, 0.95 + 0.08 * noise(s * 90, yn * 30 + side * 7, 813));
    // slightly darker snout tip
    c = mixC(c, mulC(c, 0.8), smooth(0.04, 0.0, s) * smooth(-0.3, 0.2, yn));
    return c;
  },
  rough: 0.58,
};

// --- Nurse shark -----------------------------------------------------------
const N_BACK = lin(0x8a6a40);
const N_SIDE = lin(0xa07a4a);
const N_UNDER = lin(0xc8a878);
const N_EDGE = lin(0x6a4e30);

const NURSE: Species = {
  length: 2.6,
  pre: 0.72,
  top: [[0, 0.018], [0.04, 0.03], [0.12, 0.048], [0.25, 0.062], [0.4, 0.072], [0.55, 0.074], [0.7, 0.062], [0.85, 0.044], [1, 0.032]],
  bot: [[0, 0.014], [0.04, 0.022], [0.12, 0.034], [0.25, 0.05], [0.4, 0.06], [0.55, 0.058], [0.7, 0.046], [0.85, 0.032], [1, 0.024]],
  wid: [[0, 0.04], [0.04, 0.058], [0.12, 0.076], [0.25, 0.088], [0.4, 0.09], [0.55, 0.082], [0.7, 0.062], [0.85, 0.042], [1, 0.026]],
  nose: 0.035,
  noseRound: 0.45,
  exTop: 0.82,
  exBot: 0.45,
  flat: 0.78,
  keel: 0.18,
  eye: { s: 0.105, y: 0.55, r: 0.0065, iris: 0x6a5232 },
  gills: [0.225, 0.275],
  fins: [
    // two rounded dorsal fins of about the same size, set far back
    { s0: 0.61, s1: 0.75, at: 1, dir: 'up', span: 0.07, sweep: 0.035, shape: 'round', rear: 0.02, thick: 0.016, col: dusky(N_BACK, N_EDGE, 0.7) },
    { s0: 0.8, s1: 0.91, at: 1, dir: 'up', span: 0.056, sweep: 0.03, shape: 'round', rear: 0.02, thick: 0.014, col: dusky(N_BACK, N_EDGE, 0.7) },
    { s0: 0.85, s1: 0.95, at: -1, dir: 'down', span: 0.04, sweep: 0.03, shape: 'round', rear: 0.015, thick: 0.011, small: true, col: dusky(N_SIDE, N_EDGE, 0.6) },
    // broad, rounded pectorals and pelvics (they prop the shark up on the sand)
    ...([1, -1] as const).map(
      (side): FinSpec => ({
        s0: 0.26,
        s1: 0.4,
        at: -0.62,
        side,
        dir: 0.45,
        span: 0.125,
        sweep: 0.055,
        shape: 'round',
        thick: 0.016,
        col: (_u, v, face) => mixC(face > 0 ? N_SIDE : N_UNDER, N_EDGE, smooth(0.65, 1, v) * 0.6),
      }),
    ),
    ...([1, -1] as const).map(
      (side): FinSpec => ({ s0: 0.55, s1: 0.66, at: -0.75, side, dir: 0.7, span: 0.065, sweep: 0.035, shape: 'round', thick: 0.012, small: true, col: (_u, v, face) => mixC(face > 0 ? N_SIDE : N_UNDER, N_EDGE, smooth(0.6, 1, v) * 0.5) }),
    ),
  ],
  // a long, low tail: almost all upper lobe, nearly in line with the body
  tail: [
    [-0.03, -0.055, 0],
    [-0.07, -0.066, 0.12],
    [-0.12, -0.05, 0.26],
    [-0.175, -0.03, 0.42],
    [-0.22, -0.012, 0.58],
    [-0.255, 0.0, 0.72],
    [-0.258, 0.008, 0.8],
    [-0.275, 0.016, 0.9],
    [-0.29, 0.026, 1],
  ],
  tailThick: 0.042,
  tailCol: (_u, v) => mixC(N_BACK, N_EDGE, smooth(0.7, 1, v) * 0.6),
  paint: (s, yn, side) => {
    let c = ramp([SN_UNDER, SN_SIDE, SN_SIDE2, SN_BACK], smooth(-0.85, 0.85, yn));
    // plain tawny skin, a little mottled, rough to look at
    c = mulC(c, 0.92 + 0.14 * fbm(s * 9 + side, yn * 3, 821, 3));
    c = mulC(c, 0.95 + 0.08 * noise(s * 140, yn * 40 + side * 5, 823));
    return c;
  },
  rough: 0.78,
  barbels: true,
};

/** sRGB colours for the painters, converted once. */
const SR_BELLY = srgb(0xeae6dc);
const SR_FLANK = srgb(0x9a9482);
const SR_MID = srgb(0x847e6c);
const SR_BACK = srgb(0x625d50);
const SR_BAND = srgb(0xc4c0b0);
const SR_BRONZE = srgb(0x8a7450);
const SN_UNDER = srgb(0xd0b080);
const SN_SIDE = srgb(0xb08a56);
const SN_SIDE2 = srgb(0x9c7646);
const SN_BACK = srgb(0x86643a);
const S_DARK = srgb(0x2a2622);

const SPECIES: Record<SharkKind, Species> = { reef: REEF, nurse: NURSE };

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** Texture layout: body over u in [0, BODY_U]; the eye in a square at the top right; plain white below it for the fins. */
const BODY_U = 0.84;
const EYE_U = 0.94;
const EYE_V = 0.12;
const EYE_RU = 0.05;
const EYE_RV = 0.1;
const PLAIN_UV: [number, number] = [0.94, 0.65];
/** The tail stalk runs on past the start of the tail fin, narrowing and flattening into it. */
const CAP = 0.07;

interface Shape {
  sp: Species;
  top: (s: number) => number;
  bot: (s: number) => number;
  wid: (s: number) => number;
}

function shapeOf(sp: Species): Shape {
  const nose = (s: number): number => Math.pow(Math.max(0, 1 - (1 - Math.min(1, s / sp.nose)) ** 2), sp.noseRound);
  const T = spline(sp.top);
  const B = spline(sp.bot);
  const W = spline(sp.wid);
  return { sp, top: lut((s) => T(s) * nose(s)), bot: lut((s) => B(s) * nose(s)), wid: lut((s) => W(s) * nose(s)) };
}

/** A point on the body (shark length = 1, snout at x = 1): s along it, th round it (0 = right side, pi/2 = back). */
function bodyPos(sh: Shape, s: number, th: number): V3 {
  const sp = sh.sp;
  let kh = 1;
  let kw = 1;
  let ss = s;
  if (s > 1) {
    const e = Math.cos((Math.PI / 2) * Math.min(1, (s - 1) / CAP));
    kh = Math.pow(e, 0.4);
    kw = Math.pow(e, 1.4);
    ss = 1;
  }
  const sn = Math.sin(th);
  const c = Math.cos(th);
  const y = (sn >= 0 ? sh.top(ss) * Math.pow(sn, sp.exTop) : -sh.bot(ss) * Math.pow(-sn, sp.exBot)) * kh;
  const z = sh.wid(ss) * kw * Math.sign(c) * Math.pow(Math.abs(c), sp.flat) * (1 - sp.keel * Math.max(0, sn) ** 2);
  return [1 - sp.pre * s, y, z];
}

function bodyNormal(sh: Shape, s: number, th: number): V3 {
  const e = 1e-3;
  return norm(cross(sub(bodyPos(sh, s, th + e), bodyPos(sh, s, th - e)), sub(bodyPos(sh, s + e, th), bodyPos(sh, Math.max(0, s - e), th))));
}

const angleAt = (y: number, side: number): number => {
  const a = Math.asin(clamp(y, -0.999, 0.999));
  return side > 0 ? a : Math.PI - a;
};

const BODY_VS = [
  0, 0.004, 0.012, 0.024, 0.04, 0.06, 0.085, 0.115, 0.15, 0.19, 0.23, 0.27, 0.31, 0.35, 0.39, 0.43, 0.47, 0.51, 0.55, 0.59, 0.63, 0.67, 0.71, 0.75, 0.79,
  0.83, 0.87, 0.91, 0.945, 0.975, 1, 1 + CAP * 0.35, 1 + CAP * 0.7, 1 + CAP,
];

const white = (): C3 => [1, 1, 1];

/**
 * Rows sampled in [lo, hi], handed to grid() as [0, 1]: grid() finds normals by
 * sampling either side of each row, clamped to [0, 1], so rows outside that
 * range would get their normals flipped.
 */
function rows(raw: number[], lo: number, hi: number): { vs: number[]; at: (v: number) => number } {
  return { vs: raw.map((v) => (v - lo) / (hi - lo)), at: (v) => lo + v * (hi - lo) };
}

function buildBody(sh: Shape): THREE.BufferGeometry {
  const r = rows(BODY_VS, 0, 1 + CAP);
  return grid({
    us: steps(24),
    vs: r.vs,
    wrapU: true,
    pos: (u, v) => bodyPos(sh, r.at(v), -Math.PI / 2 + TAU * u),
    col: white,
    uv: (u, v) => [Math.min(1, r.at(v)) * BODY_U, u],
  });
}

function buildEye(sh: Shape, side: 1 | -1): THREE.BufferGeometry {
  const e = sh.sp.eye;
  const th = angleAt(e.y, side);
  const C = bodyPos(sh, e.s, th);
  const N = bodyNormal(sh, e.s, th);
  const fwd = norm(sub([1, 0, 0], scl(N, N[0])));
  const up = scl(norm(cross(N, fwd)), side);
  const R = e.r;
  const pos = (u: number, v: number): V3 => {
    const a = TAU * u;
    return add(add(C, add(scl(fwd, Math.cos(a) * R * v), scl(up, Math.sin(a) * R * v))), scl(N, 0.25 * R * (1 - v * v) - 0.15 * R * v * v));
  };
  const test = cross(sub(pos(0.26, 0.5), pos(0.24, 0.5)), sub(pos(0.25, 0.52), pos(0.25, 0.48)));
  return grid({
    us: steps(10),
    vs: [0, 0.4, 0.75, 1],
    wrapU: true,
    flip: test[0] * N[0] + test[1] * N[1] + test[2] * N[2] < 0,
    pos,
    col: white,
    uv: (u, v) => [EYE_U + v * Math.cos(TAU * u) * EYE_RU, EYE_V + v * Math.sin(TAU * u) * EYE_RV],
  });
}

/**
 * Samples round a closed fin: w in [0, 0.5] runs along one face (u = 2w, 0 to 1),
 * w in [0.5, 1] back along the other (u = 2 - 2w, 1 to 0), always increasing.
 */
function loopSamples(half: number[]): number[] {
  return [...half.map((u) => u / 2), ...[...half].reverse().slice(1).map((u) => 1 - u / 2)];
}

/**
 * A fin with real thickness: a closed fan from its root out to its outline.
 * u runs round the outline from the front of the root, up the leading edge,
 * over the tip and down the trailing edge to the free rear tip (on one face,
 * and back on the other); v from just inside the body (root) out to the edge.
 */
function thickFin(root0: V3, root1: V3, d: V3, f: FinSpec): { geo: THREE.BufferGeometry; tip: V3 } {
  const chordV = sub(root1, root0);
  const chord = Math.hypot(chordV[0], chordV[1], chordV[2]);
  const c = scl(chordV, 1 / chord);
  const n = norm(cross(c, d));
  const rear = f.rear ?? 0;
  // the outline, in the fin's own plane: x back along the root, y out along the span
  const edge = (uIn: number): [number, number] => {
    const u = clamp(uIn, 0, 1);
    if (f.shape === 'round') {
      const a = Math.PI * u;
      const sa = Math.sin(a);
      return [(chord + rear) * 0.5 * (1 - Math.cos(a)) + f.sweep * sa * sa, f.span * Math.pow(sa, 0.55) * (1 - 0.1 * u)];
    }
    const UA = 0.5;
    if (u <= UA) {
      const q = u / UA;
      return [f.sweep * Math.pow(q, f.lead ?? 1.6), f.span * q];
    }
    const q = (u - UA) / (1 - UA);
    // sickle-shaped: the trailing edge drops almost straight from the tip, then sweeps back to the free rear tip
    return [f.sweep + (chord + rear - f.sweep) * Math.pow(q, f.trail ?? 1.6), f.span * (1 - q) + 0.05 * f.span * q];
  };
  const half = f.small ? [0, 0.2, 0.38, 0.5, 0.62, 0.8, 1] : [0, 0.1, 0.22, 0.34, 0.44, 0.5, 0.56, 0.66, 0.78, 0.9, 1];
  const ws = loopSamples(half);
  const r = rows(f.small ? [-0.15, 0, 0.45, 0.8, 1] : [-0.15, 0, 0.3, 0.55, 0.75, 0.9, 1], -0.15, 1);
  const at = (w: number, vIn: number): { p: V3; face: number; u: number; e: [number, number] } => {
    const v = r.at(vIn);
    const face = w <= 0.5 ? 1 : -1;
    // (clamped: the normals are found by sampling just either side of each point)
    const u = clamp(w <= 0.5 ? 2 * w : 2 - 2 * w, 0, 1);
    const e = edge(u);
    const x = mix(chord * u, e[0], v);
    const y = e[1] * v;
    // thickest at the root and toward the leading edge; thin at the outline
    const t = f.thick * 0.5 * Math.sqrt(Math.max(0, 1 - Math.max(0, v) ** 2)) * (0.35 + 0.65 * (1 - u)) * Math.pow(Math.sin(Math.PI * u), 0.35);
    return { p: add(add(add(root0, scl(c, x)), scl(d, y)), scl(n, face * t)), face, u, e };
  };
  // (the faces wind outward: a face's normal is (along u) x (along v), which is +n on the +n face)
  const geo = grid({
    us: ws,
    vs: r.vs,
    wrapU: true,
    pos: (w, v) => at(w, v).p,
    col: (w, vIn) => {
      const a = at(w, vIn);
      const v = r.at(vIn);
      return f.col(clamp((a.e[0] * v) / (chord + rear + f.sweep), 0, 1), clamp((a.e[1] * v) / f.span, 0, 1), a.face);
    },
    uv: () => PLAIN_UV,
  });
  const tipE = f.shape === 'round' ? edge(0.5) : edge(0.5);
  return { geo, tip: add(add(root0, scl(c, tipE[0])), scl(d, tipE[1])) };
}

/** The body-side fins, placed by their specs. Returns the geometries and the first dorsal's tip. */
function buildFins(sh: Shape): { geos: THREE.BufferGeometry[]; dorsalTip: V3 } {
  const geos: THREE.BufferGeometry[] = [];
  let dorsalTip: V3 = [0, 0, 0];
  let first = true;
  for (const f of sh.sp.fins) {
    let th: number;
    let d: V3;
    if (f.dir === 'up') {
      th = Math.PI / 2;
      d = [0, 1, 0];
    } else if (f.dir === 'down') {
      th = -Math.PI / 2;
      d = [0, -1, 0];
    } else {
      // a paired fin, low on one side, reaching out and down (and a little back)
      const side = f.side ?? 1;
      th = angleAt(f.at, side);
      d = norm([-0.15, -Math.sin(f.dir), side * Math.cos(f.dir)]);
    }
    const inset = f.dir === 'up' || f.dir === 'down' ? 0.004 : 0.003;
    const n0 = bodyNormal(sh, f.s0, th);
    const n1 = bodyNormal(sh, f.s1, th);
    const r0 = sub(bodyPos(sh, f.s0, th), scl(n0, inset));
    const r1 = sub(bodyPos(sh, f.s1, th), scl(n1, inset));
    const { geo, tip } = thickFin(r0, r1, d, f);
    geos.push(geo);
    if (first && f.dir === 'up') {
      dorsalTip = tip;
      first = false;
    }
  }
  return { geos, dorsalTip };
}

/** The tail fin: a thick fan from the tail's root out to its trailing edge (heterocercal: the upper lobe is the long one). */
function buildTail(sh: Shape): THREE.BufferGeometry {
  const sp = sh.sp;
  const x0 = 1 - sp.pre;
  const yT = sh.top(1) * 1.25;
  const yB = -sh.bot(1) * 1.1;
  const ex = spline(sp.tail.map((p) => [p[2], p[0]]));
  const ey = spline(sp.tail.map((p) => [p[2], p[1]]));
  const half = [0, 0.05, 0.16, 0.32, 0.5, 0.7, 0.86, 1];
  const ws = loopSamples(half);
  const r = rows([-0.12, 0, 0.18, 0.38, 0.58, 0.76, 0.9, 1], -0.12, 1);
  const at = (w: number, vIn: number): { p: V3; u: number } => {
    const v = r.at(vIn);
    const face = w <= 0.5 ? 1 : -1;
    // across the fan, from the bottom lobe (u = 0) to the top lobe (u = 1), denser near the long top lobe
    const a = w <= 0.5 ? 2 * w : 2 - 2 * w;
    const u = 1 - Math.pow(1 - a, 1.15);
    const base: V3 = [x0 + 0.012 + 0.02 * u * u, mix(yB, yT, u), 0];
    const edge: V3 = [x0 + ex(u), ey(u), 0];
    const p: V3 = [mix(base[0], edge[0], v), mix(base[1], edge[1], v), 0];
    // thickest along the top lobe's leading edge (the backbone runs into it), thin at the trailing edge
    const t = sp.tailThick * 0.5 * Math.pow(Math.max(0, 1 - Math.max(0, v)), 0.7) * (0.35 + 0.65 * Math.pow(u, 2)) * Math.pow(Math.sin(Math.PI * clamp(a, 0, 1)), 0.4);
    p[2] = face * t;
    return { p, u };
  };
  const geo = grid({
    us: ws,
    vs: r.vs,
    wrapU: true,
    pos: (w, v) => at(w, v).p,
    col: (w, v) => sp.tailCol(at(w, v).u, clamp(r.at(v), 0, 1)),
    uv: () => PLAIN_UV,
  });
  return geo;
}

/** The nurse shark's barbels: two little fleshy feelers hanging under the nostrils. */
function buildBarbels(sh: Shape): THREE.BufferGeometry[] {
  return ([1, -1] as const).map((side) => {
    const th = -Math.PI / 2 + side * 0.55;
    const p0 = bodyPos(sh, 0.02, th);
    const dir = norm([0.5, -1, side * 0.12]);
    const L = 0.016;
    return tube({
      path: (t) => add(p0, add(scl(dir, L * t), [0.003 * t * t, 0, 0])),
      radius: (t) => 0.0024 * (1 - 0.4 * t),
      nu: 5,
      ts: [0, 0.35, 0.7, 1],
      caps: [0, 2],
      capLen: 0.6,
      ref: [1, 0, 0],
      col: () => lin(0xa88458),
      uv: () => PLAIN_UV,
    });
  });
}

function bodyTexture(kind: SharkKind, sh: Shape): THREE.DataTexture {
  const sp = sh.sp;
  const iris = srgb(sp.eye.iris);
  const [g0, g1] = sp.gills;
  const mouthAt = kind === 'reef' ? { s: 0.07, back: 0.065, spread: 1.05 } : { s: 0.035, back: 0.025, spread: 0.7 };
  return paintTexture(
    `shark:${kind}`,
    256,
    128,
    (tu, tv) => {
      if (tu > BODY_U + 0.03) {
        if (tv > 0.3) return [1, 1, 1];
        // the eye: dark, a dull iris, a dark slit of a pupil
        const x = (tu - EYE_U) / EYE_RU;
        const y = (tv - EYE_V) / EYE_RV;
        const r = Math.hypot(x, y);
        let c: C3 = mixC(mulC(iris, 1.1), mulC(iris, 0.6), smooth(0.3, 0.8, r));
        c = mixC(c, srgb(0x0a0a0c), smooth(0.2, 0.14, Math.abs(x) / (1 - 0.6 * Math.min(1, Math.abs(y)))) * smooth(0.85, 0.7, Math.abs(y)));
        c = mixC(c, srgb(0x141210), smooth(0.8, 0.95, r));
        return mixC(c, [1, 1, 1], smooth(0.13, 0.06, Math.hypot(x - 0.25, y - 0.3)) * 0.7);
      }
      const s = clamp(tu / BODY_U, 0, 1);
      const th = -Math.PI / 2 + TAU * tv;
      const yn = Math.sin(th);
      const side = Math.cos(th) >= 0 ? 1 : -1;
      let c = sp.paint(s, yn, side);
      // gill slits: five curved lines on each side, the last ones a little shorter
      if (s > g0 - 0.01 && s < g1 + 0.01) {
        for (let i = 0; i < 5; i++) {
          const gs = mix(g0, g1, i / 4) + 0.008 * (1 - yn * yn);
          const tall = (kind === 'reef' ? 0.42 : 0.3) * (1 - 0.12 * i);
          const mid = kind === 'reef' ? -0.05 : -0.2;
          const on = smooth(tall, tall - 0.08, Math.abs(yn - mid));
          const d = Math.abs(s - gs);
          c = mixC(c, mulC(c, 0.62), smooth(0.003, 0.001, d) * on);
          c = mixC(c, mulC(c, 1.08), smooth(0.006, 0.003, d) * smooth(0.0, 0.003, s - gs) * on * 0.6);
        }
      }
      // the mouth: a closed crescent under the snout
      const phi = signedPhi(th); // angle from straight underneath
      const ap = Math.abs(phi);
      if (ap < mouthAt.spread) {
        const ms = mouthAt.s + mouthAt.back * (ap / mouthAt.spread) ** 2;
        c = mixC(c, S_DARK, smooth(0.006, 0.002, Math.abs(s - ms)) * 0.8);
      }
      // nostrils: two small dark marks under the snout
      for (const sgn of [1, -1]) c = mixC(c, S_DARK, smooth(0.07, 0.04, Math.hypot((s - 0.025) * 3, phi - 0.42 * sgn)) * 0.7);
      return c;
    },
    { wrapV: true, samples: 1 },
  );
}

/** The angle from straight underneath, -pi..pi. */
function signedPhi(th: number): number {
  let a = th + Math.PI / 2;
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

interface SharkParts {
  geo: THREE.BufferGeometry;
  map: THREE.DataTexture;
  length: number;
  headX: number;
  gillX: number;
  finTip: THREE.Vector3;
  rest: number;
  sp: Species;
}

const cache = new Map<SharkKind, SharkParts>();

function partsFor(kind: SharkKind): SharkParts {
  const hit = cache.get(kind);
  if (hit) return hit;
  const sp = SPECIES[kind];
  if (!sp) throw new Error(`shark: unknown kind "${kind}"`);
  const sh = shapeOf(sp);
  const fins = buildFins(sh);
  const parts = [buildBody(sh), buildEye(sh, 1), buildEye(sh, -1), ...fins.geos, buildTail(sh), ...(sp.barbels ? buildBarbels(sh) : [])];
  for (const p of parts) for (const name of Object.keys(p.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) p.deleteAttribute(name);
  const geo = mergeGeometries(parts);
  if (!geo) throw new Error('shark: could not merge');
  geo.computeBoundingBox();
  const box = geo.boundingBox!;
  const k = sp.length / (box.max.x - box.min.x);
  const cx = ((box.min.x + box.max.x) / 2) * k;
  const cy = ((box.min.y + box.max.y) / 2) * k;
  geo.scale(k, k, k);
  geo.translate(-cx, -cy, 0);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const p: SharkParts = {
    geo,
    map: bodyTexture(kind, sh),
    length: sp.length,
    headX: geo.boundingBox!.max.x,
    gillX: (1 - sp.pre * (sp.gills[0] + sp.gills[1]) * 0.5) * k - cx,
    finTip: new THREE.Vector3(fins.dorsalTip[0] * k - cx, fins.dorsalTip[1] * k - cy, 0),
    rest: -geo.boundingBox!.min.y,
    sp,
  };
  cache.set(kind, p);
  return p;
}

// ---------------------------------------------------------------------------
// Swimming, in the vertex shader
// ---------------------------------------------------------------------------

const SWIM_VERT = /* glsl */ `
float shXn = clamp((uSwim.z - position.x) / uSwim.w, 0.0, 1.0);
float shPh = uSwim.x - 5.3 * shXn;
float shE = 0.15 - 0.3 * shXn + 1.15 * shXn * shXn;
float shDE = -0.3 + 2.3 * shXn;
float shA = uSwim.y * uSwim.w;
float shXc = shXn - 0.45;
float shB = uSwim2.x * 0.6 * uSwim.w;
float shOff = shA * shE * sin(shPh) + shB * shXc * shXc;
float shSlope = -(shA * (shDE * sin(shPh) - 5.3 * shE * cos(shPh)) + shB * 2.0 * shXc) / uSwim.w;
float shGd = (position.x - uSwim2.w) / (0.045 * uSwim.w);
float shG = uSwim2.y * exp(-shGd * shGd) * (0.5 + 0.5 * sin(uSwim2.z));
`;

function sharkMaterial(p: SharkParts, u: { uSwim: { value: THREE.Vector4 }; uSwim2: { value: THREE.Vector4 } }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map: p.map, vertexColors: true, roughness: p.sp.rough, metalness: 0 });
  m.name = 'shark';
  const rough = { value: p.sp.rough };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSwim = u.uSwim;
    shader.uniforms.uSwim2 = u.uSwim2;
    shader.uniforms.uSharkRough = rough;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uSwim;\nuniform vec4 uSwim2;\nvarying vec2 vSharkUv;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${SWIM_VERT}\nobjectNormal.x -= shSlope * objectNormal.z;\nobjectNormal = normalize(objectNormal);`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSharkUv = uv;\ntransformed.z = transformed.z * (1.0 + 0.07 * shG) + shOff;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSharkUv;\nuniform float uSharkRough;')
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = mix(uSharkRough, 0.15, step(${(BODY_U + 0.03).toFixed(3)}, vSharkUv.x) * step(vSharkUv.y, 0.3));`,
      );
  };
  m.customProgramCacheKey = () => 'shark';
  return m;
}

/**
 * A new shark at real size in metres: length along +x, head at +x, back up,
 * centred on its bounding box. `userData`: `kind`, `length` (m), `finTip`
 * (top of the first dorsal fin, in the shark's own space) and `rest` (lift
 * it by this much to rest it on the sand). Geometry and texture are shared;
 * call `disposeShark` when you drop one, to free its material.
 */
export function sharkModel(kind: SharkKind): THREE.Group {
  const p = partsFor(kind);
  const uniforms = { uSwim: { value: new THREE.Vector4(0, 0.02, p.headX, p.length) }, uSwim2: { value: new THREE.Vector4(0, 0, 0, p.gillX) } };
  const mesh = new THREE.Mesh(p.geo, sharkMaterial(p, uniforms));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const g = new THREE.Group();
  g.name = `shark:${kind}`;
  g.add(mesh);
  g.userData = {
    kind,
    length: p.length,
    finTip: p.finTip.clone(),
    rest: p.rest,
    swim: uniforms.uSwim.value,
    swim2: uniforms.uSwim2.value,
    phase: 0,
    bend: 0,
    lastTime: NaN,
  };
  return g;
}

/**
 * Makes a shark swim: a side-to-side wave down the body, stronger toward the
 * tail and quicker with speed. Call every frame.
 * @param time   the clock (s)
 * @param speed  m/s; 0 = resting (only the gills pump and the tail flicks now and then), ~1 cruising, 3+ a dash
 * @param turn   how fast its heading is changing (rad/s, the game's heading: positive turns toward the
 *               shark's own +z side); the body bends into the turn
 */
export function swim(obj: THREE.Object3D, time: number, speed: number, turn = 0): void {
  const u = obj.userData as { swim?: THREE.Vector4; swim2?: THREE.Vector4; phase: number; bend: number; lastTime: number };
  if (!u.swim || !u.swim2) return;
  const t = Number.isFinite(time) ? time : 0;
  const sp = Number.isFinite(speed) ? clamp(speed, 0, 12) : 0;
  const dt = Number.isFinite(u.lastTime) ? clamp(t - u.lastTime, 0, 0.1) : 0;
  u.lastTime = t;
  const k = Math.min(1, sp / 1.5);
  const rest = 1 - k;
  // tail beats: lazy at rest, about half a beat a second cruising, quicker in a dash
  const freq = 0.12 + 0.42 * k + 0.35 * clamp((sp - 1.5) / 3, 0, 1);
  u.phase = (u.phase + dt * TAU * freq) % (TAU * 1000);
  const flick = Math.max(0, Math.sin(t * 0.31) * Math.sin(t * 0.19 + 1.3));
  const amp = 0.012 + 0.07 * k + 0.02 * clamp((sp - 1.5) / 3, 0, 1) + rest * 0.03 * flick;
  const target = clamp((Number.isFinite(turn) ? turn : 0) / 1.2, -1, 1);
  u.bend += (target - u.bend) * (1 - Math.exp(-dt * 5));
  u.swim.x = u.phase;
  u.swim.y = amp;
  u.swim2.x = u.bend;
  // the gills flare as it pumps water over them; more when it's resting
  u.swim2.y = 0.3 + 0.7 * rest;
  u.swim2.z = t * 2.3;
}

/** Frees a shark's material (the shared geometry and texture stay). */
export function disposeShark(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.dispose();
  });
}

/** Builds (and paints) the sharks now, so the first one doesn't stutter. */
export function prepareSharks(kinds: SharkKind[] = SHARK_KINDS): void {
  for (const k of kinds) partsFor(k);
}

/** Triangle count of a shark. */
export function sharkTriangles(kind: SharkKind): number {
  const g = partsFor(kind).geo;
  return (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}

// ---------------------------------------------------------------------------
// The fin wake
// ---------------------------------------------------------------------------

/** A dorsal fin, for the wake: its tip (y = the tip's height), heading (the game's), and speed (m/s). */
export interface FinState {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
}

const WAKE_FINS = 8;
/** The arms of the V are ripples catching the sky rather than white foam. */
const RIPPLE = lin(0xdcecf2);
const WAKE_PTS = 12;
const WAKE_STEP = 0.09;
const WAKE_AGE = WAKE_PTS * WAKE_STEP;
const SPLASH = 4;

const WAKE_VERT = /* glsl */ `
attribute vec4 rgba;
attribute vec4 offs;
varying vec4 vCol;
varying vec2 vUv;
varying vec2 vW;
void main() {
  vec3 p = position;
  vW = p.xz;
  if (offs.z > 0.0) {
    // splash drops face the camera
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p += (right * offs.x + up * offs.y) * offs.z;
  }
  vUv = offs.xy;
  vCol = rgba;
  // nudged toward the camera (stays put on screen), so ripples aren't lost under the crests
  vec3 back = cameraPosition - p;
  float bd = length(back);
  p += back / max(bd, 1e-4) * min(bd * 0.5, 0.03 + 0.012 * bd);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const WAKE_FRAG = /* glsl */ `
uniform float uDay;
uniform float uCut;
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
  float a = vCol.a;
  float shape = vUv.x < -1.5 ? 1.0 : 1.0 - smoothstep(0.2, 1.0, length(vUv));
  // foam (alpha above 1): broken up into bubbles and streaks
  if (a > 1.0) {
    a -= 1.0;
    float n = vnoise(vW * 9.0) * 0.55 + vnoise(vW * 26.0 + 3.0) * 0.45;
    shape *= smoothstep(0.32, 0.6, n);
  }
  a *= shape;
  if (a < uCut) discard;
  gl_FragColor = vec4(vCol.rgb * (0.22 + 0.78 * uDay), a);
}`;

interface WakePoint {
  x: number;
  z: number;
  t: number;
  show: number;
  speed: number;
}

/**
 * The white water where dorsal fins cut the surface: a V of ripples spreading
 * behind each fin, foam along its track and a little splash at its leading
 * edge. Up to 8 fins, one draw call. Add `mesh` to the world scene, and to the
 * pipeline's aboveWaterOnly list. Keep each shark at the same index in the
 * list you pass to `update` (its wake follows its own track).
 */
export class FinWake {
  readonly mesh: THREE.Mesh;
  /** Optional: the water's height at (x, z) right now (e.g. ocean.heightAt(x, z, time)); without it, sea level (0). */
  waterAt: ((x: number, z: number) => number) | null = null;
  private mat: THREE.ShaderMaterial;
  private pos: Float32Array;
  private col: Float32Array;
  private offs: Float32Array;
  private tracks: WakePoint[][] = Array.from({ length: WAKE_FINS }, () => []);
  private lastSample: number[] = new Array(WAKE_FINS).fill(-Infinity);
  // per fin: 3 strips (left arm, track, right arm) of WAKE_PTS points x 3 across, then the splash sprites and a foam patch
  private static readonly STRIP = WAKE_PTS * 3;
  private static readonly PER = FinWake.STRIP * 3 + SPLASH * 4 + 4;

  constructor() {
    const n = WAKE_FINS * FinWake.PER;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.offs = new Float32Array(n * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rgba', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('offs', new THREE.BufferAttribute(this.offs, 4).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let f = 0; f < WAKE_FINS; f++) {
      const base = f * FinWake.PER;
      for (let s = 0; s < 3; s++) {
        const sb = base + s * FinWake.STRIP;
        for (let i = 0; i < WAKE_PTS - 1; i++) {
          for (let r = 0; r < 2; r++) {
            const a = sb + i * 3 + r;
            const b = a + 3;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
          }
        }
      }
      for (let q = 0; q < SPLASH + 1; q++) {
        const a = base + FinWake.STRIP * 3 + q * 4;
        idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      }
    }
    g.setIndex(idx);
    for (let i = 0; i < n; i++) this.offs.set([-2, -2, 0, 0], i * 4);
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    for (let f = 0; f < WAKE_FINS; f++) {
      for (let q = 0; q < SPLASH + 1; q++) {
        for (let c = 0; c < 4; c++) this.offs.set([corners[c][0], corners[c][1], 0, 0], (f * FinWake.PER + FinWake.STRIP * 3 + q * 4 + c) * 4);
      }
    }
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uDay: { value: 1 }, uCut: { value: 0.003 } },
      vertexShader: WAKE_VERT,
      fragmentShader: WAKE_FRAG,
    });
    this.mat.name = 'finWake';
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'finWake';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  /** 0 = night .. 1 = full day (the white water is unlit). */
  setDaylight(day: number): void {
    this.mat.uniforms.uDay.value = clamp(day, 0, 1);
  }

  private water(x: number, z: number): number {
    return this.waterAt ? this.waterAt(x, z) : 0;
  }

  /** Call every frame with the fins (up to 8, each at the same index from frame to frame). */
  update(fins: readonly FinState[], time: number): void {
    const foam = lin(0xf4fbff);
    let any = false;
    for (let f = 0; f < WAKE_FINS; f++) {
      const fin = fins[f];
      const track = this.tracks[f];
      // forget what has faded
      while (track.length && time - track[track.length - 1].t > WAKE_AGE) track.pop();
      let cut: WakePoint | null = null;
      if (fin && Number.isFinite(fin.x + fin.y + fin.z + fin.heading)) {
        const w = this.water(fin.x, fin.z);
        const above = fin.y - w;
        const show = smooth(-0.01, 0.06, above);
        const spd = Number.isFinite(fin.speed) ? Math.max(0, fin.speed) : 0;
        // the leading edge meets the water a little ahead of the tip
        const ahead = clamp(above * 0.6, 0, 0.2);
        cut = { x: fin.x + Math.cos(fin.heading) * ahead, z: fin.z + Math.sin(fin.heading) * ahead, t: time, show, speed: spd };
        // a different shark in this slot, or a jump: start a fresh track rather than draw across the gap
        if (track.length && Math.hypot(cut.x - track[0].x, cut.z - track[0].z) > 2) track.length = 0;
        if (time - this.lastSample[f] >= WAKE_STEP || time < this.lastSample[f] || !track.length) {
          this.lastSample[f] = time;
          track.unshift(cut);
          if (track.length > WAKE_PTS) track.length = WAKE_PTS;
        } else if (track.length) {
          track[0] = cut;
        }
      }
      const live = track.some((p) => p.show > 0.01);
      any ||= live;
      this.writeFin(f, live ? track : [], cut, time, foam);
    }
    this.mesh.visible = any;
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('rgba').needsUpdate = true;
    g.getAttribute('offs').needsUpdate = true;
  }

  private writeFin(f: number, track: WakePoint[], cut: WakePoint | null, time: number, foam: C3): void {
    const base = f * FinWake.PER;
    const n = track.length;
    for (let s = 0; s < 3; s++) {
      const side = s - 1; // -1 left arm, 0 track, +1 right arm
      for (let i = 0; i < WAKE_PTS; i++) {
        // points past the end of the track sit on its last point, invisible (so no strip stretches anywhere)
        const ii = Math.min(i, n - 1);
        const p = track[ii];
        const valid = n > 0;
        const live = i < n;
        let x = 0;
        let z = 0;
        let nx = 0;
        let nz = 0;
        let a = 0;
        let half = 0;
        if (valid) {
          const older = track[Math.min(n - 1, ii + 1)];
          const newer = track[Math.max(0, ii - 1)];
          let tx = newer.x - older.x;
          let tz = newer.z - older.z;
          const tl = Math.hypot(tx, tz);
          if (tl < 1e-5) {
            tx = 1;
            tz = 0;
          } else {
            tx /= tl;
            tz /= tl;
          }
          nx = -tz;
          nz = tx;
          const age = time - p.t;
          const life = clamp(1 - age / WAKE_AGE, 0, 1);
          const go = Math.min(1, p.speed / 1.5);
          // the arms spread at about the Kelvin angle as the fin moves on
          const spread = side === 0 ? 0 : side * (0.05 + age * p.speed * 0.36);
          x = p.x + nx * spread;
          z = p.z + nz * spread;
          // thin lines of ripple for the arms; a narrow, broken trail of foam down the middle
          half = side === 0 ? 0.03 + 0.07 * age * (0.4 + go) : 0.016 + 0.035 * age;
          a = live ? p.show * life ** 1.5 * (side === 0 ? 0.32 * (0.3 + 0.7 * go) : 0.45 * go) * (i === 0 ? 0.6 : 1) : 0;
          if (!live) half = 0;
        }
        for (let k = 0; k < 3; k++) {
          const v = base + s * FinWake.STRIP + i * 3 + k;
          const o = (k - 1) * half;
          const px = x + nx * o;
          const pz = z + nz * o;
          this.pos.set([px, valid ? this.water(px, pz) + 0.012 : -1000, pz], v * 3);
          // the track is foam (alpha above 1); the arms are smooth lines of ripple
          const alpha = k === 1 ? a : 0;
          const c = side === 0 ? foam : RIPPLE;
          this.col.set([c[0], c[1], c[2], side === 0 && alpha > 0 ? 1 + alpha : alpha], v * 4);
        }
      }
    }
    // the splash at the leading edge, and the foam where the fin stands in the water
    const sb = base + FinWake.STRIP * 3;
    const show = cut ? cut.show : 0;
    const go = cut ? Math.min(1, cut.speed / 1.2) : 0;
    const heading = Math.atan2(track[0] && track[1] ? track[0].z - track[1].z : 0, track[0] && track[1] ? track[0].x - track[1].x : 1);
    for (let q = 0; q < SPLASH; q++) {
      const ph = time * (7 + q * 1.7) + q * 2.1 + f;
      const flick = 0.5 + 0.5 * Math.sin(ph);
      const side = q % 2 === 0 ? 1 : -1;
      const back = 0.02 + 0.07 * q * 0.5;
      const cx = cut ? cut.x - Math.cos(heading) * back - Math.sin(heading) * side * (0.03 + 0.03 * q) : 0;
      const cz = cut ? cut.z - Math.sin(heading) * back + Math.cos(heading) * side * (0.03 + 0.03 * q) : 0;
      const cy = cut ? this.water(cx, cz) + 0.02 + 0.07 * go * flick : -1000;
      const size = (0.03 + 0.05 * go) * (0.6 + 0.4 * flick);
      const a = show * go * (0.5 + 0.4 * flick);
      for (let c = 0; c < 4; c++) {
        const v = sb + q * 4 + c;
        this.pos.set([cx, cy, cz], v * 3);
        this.col.set([foam[0], foam[1], foam[2], a], v * 4);
        this.offs[v * 4 + 2] = size;
      }
    }
    const fb = sb + SPLASH * 4;
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    const size = 0.08 + 0.08 * go;
    for (let c = 0; c < 4; c++) {
      const v = fb + c;
      const px = cut ? cut.x + corners[c][0] * size : 0;
      const pz = cut ? cut.z + corners[c][1] * size : 0;
      this.pos.set([px, cut ? this.water(px, pz) + 0.012 : -1000, pz], v * 3);
      this.col.set([foam[0], foam[1], foam[2], show > 0.01 ? 1 + show * 0.6 : 0], v * 4);
    }
  }
}

// ---------------------------------------------------------------------------
// Bait
// ---------------------------------------------------------------------------

let baitGeo: THREE.BufferGeometry | null = null;

/**
 * A chunk of fish for bait, about 5 cm: silver skin with a dark back, pink
 * flesh at the two slanted cuts. Origin at its middle, length along x. One mesh.
 */
export function baitModel(): THREE.Group {
  if (!baitGeo) {
    const L = 0.026;
    const silver = lin(0xc8ced4);
    const back = lin(0x4e5e6e);
    const flesh = lin(0xe8b0a6);
    const pale = lin(0xf4e2d8);
    const geo = grid({
      us: steps(12),
      vs: [0, 0.07, 0.15, 0.2, 0.35, 0.5, 0.65, 0.8, 0.85, 0.93, 1],
      wrapU: true,
      // (x runs forward along the rows, so the surface needs turning outside-out)
      flip: true,
      pos: (u, v) => {
        const a = TAU * u;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // a fish's cross-section: taller than wide, the back a little narrower than the belly
        const ry = 0.018;
        const rz = 0.011 * (1 - 0.25 * Math.max(0, sa));
        // the two cuts are slanted, so it's a wedge-ish chunk rather than a tidy slice
        const cutF = L + 0.006 * sa;
        const cutB = -L + 0.004 * sa + 0.002 * ca;
        let x: number;
        let k = 1;
        if (v < 0.2) {
          x = cutB;
          k = v / 0.2;
        } else if (v > 0.8) {
          x = cutF;
          k = (1 - v) / 0.2;
        } else x = mix(cutB, cutF, (v - 0.2) / 0.6);
        const bulge = 1 + 0.08 * Math.sin(Math.PI * clamp((v - 0.2) / 0.6, 0, 1));
        return [x, sa * ry * k * bulge, ca * rz * k * bulge];
      },
      col: (u, v) => {
        const sa = Math.sin(TAU * u);
        if (v < 0.17 || v > 0.83) {
          // the cut face: pale near the backbone, pink flesh, a thin silver rim of skin
          const r = v < 0.17 ? v / 0.17 : (1 - v) / 0.17;
          return mixC(mixC(pale, flesh, smooth(0.05, 0.35, r)), silver, smooth(0.85, 1, r));
        }
        // skin: dark along the back, silver sides, a faint stripe
        let c = mixC(silver, back, smooth(0.35, 0.85, sa));
        c = mixC(c, lin(0xa8b4bc), smooth(0.12, 0.0, Math.abs(sa - 0.25)) * 0.5);
        return c;
      },
    });
    for (const name of Object.keys(geo.attributes)) if (name === 'uv') geo.deleteAttribute(name);
    geo.computeBoundingSphere();
    baitGeo = geo;
  }
  const g = new THREE.Group();
  g.name = 'bait';
  const m = new THREE.Mesh(baitGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.15 }));
  m.castShadow = true;
  g.add(m);
  return g;
}

const BITS = 48;

/**
 * The little cloud of bits that drifts down when bait hits the water. It lives
 * under the surface, so it shows through the water (leave it out of
 * aboveWaterOnly). One draw call.
 */
export class BaitCloud {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private col: Float32Array;
  private offs: Float32Array;
  private bits: { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; size: number; tint: number }[] = [];
  private seed = 7;
  private lastTime = NaN;

  constructor() {
    this.pos = new Float32Array(BITS * 4 * 3);
    this.col = new Float32Array(BITS * 4 * 4);
    this.offs = new Float32Array(BITS * 4 * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('rgba', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('offs', new THREE.BufferAttribute(this.offs, 4).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    const corners = [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ];
    for (let b = 0; b < BITS; b++) {
      const a = b * 4;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
      for (let c = 0; c < 4; c++) this.offs.set([corners[c][0], corners[c][1], 0, 0], (a + c) * 4);
    }
    g.setIndex(idx);
    // The bits write depth (their solid middles only), so the water tints them for how deep they
    // really are rather than as if they lay on the sea floor.
    const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: true, uniforms: { uDay: { value: 1 }, uCut: { value: 0.3 } }, vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG });
    mat.name = 'baitCloud';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'baitCloud';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  private rand(): number {
    this.seed = (this.seed + 1) | 0;
    return hash(this.seed, 31, 9);
  }

  /** Bait hits the water here: a puff of bits starts to sink and spread. */
  drop(at: THREE.Vector3, count = 28): void {
    for (let i = 0; i < count; i++) {
      if (this.bits.length >= BITS) this.bits.shift();
      const a = this.rand() * TAU;
      const out = 0.05 + 0.2 * this.rand();
      this.bits.push({
        x: at.x + Math.cos(a) * 0.04,
        y: at.y - 0.05 - 0.1 * this.rand(),
        z: at.z + Math.sin(a) * 0.04,
        vx: Math.cos(a) * out,
        vy: -(0.08 + 0.16 * this.rand()),
        vz: Math.sin(a) * out,
        age: 0,
        life: 5 + 4 * this.rand(),
        size: 0.006 + 0.012 * this.rand(),
        tint: this.rand(),
      });
    }
  }

  /** Call every frame (time in seconds). */
  update(time: number): void {
    const dt = Number.isFinite(this.lastTime) ? clamp(time - this.lastTime, 0, 0.1) : 0;
    this.lastTime = time;
    for (const b of this.bits) {
      b.age += dt;
      const drag = Math.exp(-dt * 1.5);
      b.vx *= drag;
      b.vz *= drag;
      b.x += b.vx * dt + 0.01 * Math.sin(time * 0.9 + b.tint * 6) * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
    }
    this.bits = this.bits.filter((b) => b.age < b.life);
    this.mesh.visible = this.bits.length > 0;
    const pink = lin(0xf0b8ac);
    const pale = lin(0xf4ece4);
    const silver = lin(0xd8dde2);
    for (let i = 0; i < BITS; i++) {
      const b = this.bits[i];
      const c: C3 = b ? (b.tint < 0.55 ? mixC(pink, pale, b.tint) : b.tint < 0.85 ? pale : silver) : pale;
      const a = b ? 0.9 * smooth(0, 0.3, b.age) * (1 - smooth(b.life * 0.6, b.life, b.age)) : 0;
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        this.pos.set(b ? [b.x, b.y, b.z] : [0, -1000, 0], v * 3);
        this.col.set([c[0], c[1], c[2], a], v * 4);
        this.offs[v * 4 + 2] = b ? b.size : 0;
      }
    }
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('rgba').needsUpdate = true;
    g.getAttribute('offs').needsUpdate = true;
  }
}
