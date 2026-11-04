/**
 * The dinghy (tender) for the catamaran: a classic little wooden clinker boat, 3.0 m long
 * and 1.35 m wide, made entirely in code in the same storybook style as the big boat.
 * White lapstrake (overlapping-plank) hull with a teal sheer strake, cream inside with
 * varnished frames, teak thwarts, gunwales and transom, slatted floorboards, two oars in
 * bronze rowlocks, a bow painter, and a little outboard (the sloop's old one, scaled down).
 *
 * BOAT-LOCAL AXES (metres), as the big boat's: +x toward the bow, +y up (y = 0 is the
 * waterline), +z to starboard; origin on the centreline, halfway along, at the waterline.
 * Yaws (seatYaw, helmYaw) use the player's convention: you face (-sin yaw, 0, -cos yaw),
 * so PI/2 faces aft (-x) and -PI/2 faces the bow (+x).
 *
 * Four meshes (four draw calls): the painted hull (dents, scuffs and patches are drawn by
 * its shader, so damage costs no triangles), the woodwork (the oars move inside it), the
 * fittings (the outboard tilts, steers and spins inside it), and an invisible water mask: a
 * depth-only lid at the waterline inside the hull, drawn at renderOrder 1, so a sea drawn after
 * it (renderOrder 2 or later) doesn't show inside the boat, whose floor is below the water.
 */
import * as THREE from 'three';
import { DynPart, M, Part, V, WHITE, clamp, curve, paintVarnish, pchip, rgb, rod, roundedBox, smooth01, sweep, tube, type RGB } from './boatKit';

// ============================================================ public types

export interface DinghyPoints {
  /** Where you sit to row: on the middle thwart (feet height = seat top), facing aft as rowers do. */
  seat: THREE.Vector3;
  /** Yaw (boat-local) for the rowing seat: PI/2, facing aft. */
  seatYaw: number;
  /** Where you sit to motor: on the stern thwart beside the outboard's tiller, facing forward. */
  helm: THREE.Vector3;
  /** Yaw (boat-local) at the helm: -PI/2, facing the bow. */
  helmYaw: number;
  /** The stem head (the bow painter's eye is just below it). */
  bow: THREE.Vector3;
  /** The middle of the transom top, where the outboard hangs. */
  stern: THREE.Vector3;
  /** Where you step in from a dock or swim platform: on the floorboards between the middle and bow thwarts. */
  board: THREE.Vector3;
  /** Bronze lifting eyes for the davit falls: on the breasthook at the bow and on the stern thwart. */
  liftBow: THREE.Vector3;
  liftStern: THREE.Vector3;
}

/** Where you can be aboard the dinghy (the same shape as the catamaran's deck). */
export interface DinghyDeck {
  /** Floorboards (and the thwarts, a step up): the highest surface no higher than y + 0.45; null outside the boat. */
  heightAt(lx: number, lz: number, y?: number): number | null;
  /** True if a person of radius r with feet at y would push into the hull's sides or ends. */
  blocked(lx: number, lz: number, r: number, y?: number): boolean;
  /** Inside the gunwales. */
  insideLifelines(lx: number, lz: number, y?: number): boolean;
  /** Half-width at lx: at the gunwale (atDeck) or the waterline; 0 beyond the ends. */
  halfBeam(lx: number, atDeck: boolean): number;
  /** For swimmers: how far (lx, lz) is inside the waterline footprint plus 0.3 m; 0 when clear. */
  footprintPen(lx: number, lz: number): number;
  /** An open boat: always null. */
  ceilingAt(lx: number, lz: number, y: number): number | null;
}

export interface DinghyRig {
  /** Rowing: phase 0..1 runs one stroke (0 = the catch, blades forward and dipping; the drive to about 0.42, then the blades feather and swing back). Not rowing: the oars lie inboard along the thwarts. */
  setOars(phase: number, rowing: boolean): void;
  /** Throttle -1 (astern) .. 1 (ahead): the outboard tilts down (about 0.8 s) when running and up again at 0, the prop spins, the cowl shivers. Call every frame with the time in seconds. */
  setMotor(throttle: number, time: number): void;
  /** Turns the outboard on its swivel, -0.6..0.6 radians: + swings the prop to starboard (the bow turns to starboard) and the tiller to port. */
  setRudder(angle: number): void;
  /** Wear, 0..1: scuffs first, then dents with chipped paint, and from about 0.85 copper patches over the dents. */
  setDamage(level: number): void;
  /** Stowed in the davits: the oars lie inboard and the outboard is tilted down and swivelled to lie along the transom (so it hangs clear of the catamaran's stern steps). */
  setStowed(stowed: boolean): void;
  status(): DinghyStatus;
}

export interface DinghyStatus {
  oarPhase: number;
  rowing: boolean;
  /** The two blade tips and handles (port, starboard), boat-local. */
  bladeTips: [THREE.Vector3, THREE.Vector3];
  handles: [THREE.Vector3, THREE.Vector3];
  throttle: number;
  /** 0 = tilted up, 1 = down in the water. */
  motorDown: number;
  /** The propeller hub (boat-local), for bubbles. */
  propTip: THREE.Vector3;
  propAngle: number;
  rudder: number;
  tillerEnd: THREE.Vector3;
  damage: number;
  stowed: boolean;
}

export interface Dinghy {
  group: THREE.Group;
  points: DinghyPoints;
  rig: DinghyRig;
  deck: DinghyDeck;
  length: number;
  beam: number;
  draft: number;
  triangles: number;
}

// ============================================================ shape

const X_ST = -1.5; // transom
const X_BW = 1.5; // stem head
const LEN = X_BW - X_ST;
const HB = 0.675;
const X_W = -0.15; // widest
const THICK = 0.016; // planking
const LAP = 0.012; // how far each plank's lower edge stands proud of the next
const STRAKE_U = [0, 0.15, 0.3, 0.45, 0.6, 0.78, 1.0];
const FLOOR_Y = -0.06;
const THW_TOP = 0.25;
const THW_T = 0.028;
const THWARTS = [
  { x: -1.1, w: 0.26 },
  { x: 0.05, w: 0.2 },
  { x: 0.95, w: 0.18 },
];
const OARLOCK_X = -0.25;
const MOTOR_SCALE = 0.8;
const MOTOR_PIVOT = V(X_ST - 0.03, 0.49, 0);
const MOTOR_UP = -1.31;
const TILT_TIME = 0.8;
const PROP_HUB = V(-0.27, -0.86, 0).multiplyScalar(MOTOR_SCALE); // motor-local
const TILLER_END = V(0.29, 0.31, 0).multiplyScalar(MOTOR_SCALE);
const RUDDER_MAX = 0.6;
const STOW_SWIVEL = Math.PI / 2; // stowed in the davits, the motor is turned to lie along the transom (small outboards swivel right round)
/** Lifting eyes, dinghy-local (the catamaran's davit falls hook on here). */
export const DINGHY_LIFT = { bow: V(1.2, 0.505, 0), stern: V(-1.2, THW_TOP + 0.012, 0) };

function sheerY(x: number): number {
  const t = (clamp(x, X_ST, X_BW) - X_ST) / LEN;
  return t < 0.45 ? 0.4 + 0.06 * ((0.45 - t) / 0.45) ** 2 : 0.4 + 0.16 * ((t - 0.45) / 0.55) ** 2;
}
function bd(x: number): number {
  if (x < X_ST || x > X_BW) return 0;
  if (x >= X_W) return HB * (1 - Math.pow((x - X_W) / (X_BW - X_W), 1.9));
  const s = (X_W - x) / (X_W - X_ST);
  return HB - 0.2 * s * s;
}
const keelY = pchip([-1.5, -1.1, -0.5, 0.2, 0.8, 1.15, 1.35, 1.46, 1.5], [-0.04, -0.12, -0.17, -0.17, -0.13, -0.04, 0.12, 0.35, 0.56]);

interface Section {
  ys: number;
  yk: number;
  b: number;
  point(u: number): [number, number];
  /** Outward unit normal in the (z, y) plane at u. */
  normal(u: number): [number, number];
}
function sectionAt(x: number): Section {
  const t = (x - X_ST) / LEN;
  const fwd = smooth01((t - 0.55) / 0.45);
  const aft = smooth01((0.45 - t) / 0.45);
  const ys = sheerY(x);
  const yk = Math.min(keelY(x), ys);
  const b = bd(x);
  const H = Math.max(1e-5, ys - yk);
  const k1 = 0.96 - 0.25 * fwd;
  const a1 = 0.56;
  const c2 = 0.8 + 0.1 * aft - 0.5 * fwd;
  const dr = 0.2 - 0.08 * aft + 0.55 * fwd;
  const p1z = b * k1;
  const p1y = ys - a1 * H;
  const p2z = b * c2;
  const p2y = Math.min(p1y, yk + dr * c2 * b);
  const point = (u: number): [number, number] => {
    const v = 1 - u;
    const w0 = v * v * v;
    const w1 = 3 * v * v * u;
    const w2 = 3 * v * u * u;
    const w3 = u * u * u;
    return [w0 * b + w1 * p1z + w2 * p2z, w0 * ys + w1 * p1y + w2 * p2y + w3 * yk];
  };
  return {
    ys,
    yk,
    b,
    point,
    normal(u: number): [number, number] {
      const e = 0.002;
      const a = point(Math.max(0, u - e));
      const c = point(Math.min(1, u + e));
      const dz = c[0] - a[0];
      const dy = c[1] - a[1];
      const l = Math.hypot(dz, dy) || 1;
      return [-dy / l, dz / l];
    },
  };
}
/** Half-width of the hull's outside at x and height y. */
function hullHalfAt(x: number, y: number): number {
  if (x < X_ST || x > X_BW) return 0;
  const s = sectionAt(x);
  if (y >= s.ys) return s.b;
  if (y <= s.yk) return 0;
  let a = 0;
  let b = 1;
  for (let k = 0; k < 26; k++) {
    const m = (a + b) / 2;
    if (s.point(m)[1] > y) a = m;
    else b = m;
  }
  return s.point((a + b) / 2)[0];
}
const innerHalf = (x: number, y: number) => Math.max(0, hullHalfAt(x, y) - THICK);
const WL = (() => {
  const n = 120;
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = hullHalfAt(X_ST + (LEN * i) / n, 0);
  return t;
})();
function wlHalf(x: number): number {
  if (x < X_ST || x > X_BW) return 0;
  const f = ((x - X_ST) / LEN) * (WL.length - 1);
  const i = Math.min(WL.length - 2, Math.floor(f));
  return WL[i] + (WL[i + 1] - WL[i]) * (f - i);
}

// ============================================================ the walkable boat

const FB_X0 = -1.3;
const FB_X1 = 1.05;
const FLOOR_TABLE = (() => {
  const n = 60;
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = Math.min(0.264, innerHalf(FB_X0 + ((FB_X1 - FB_X0) * i) / n, FLOOR_Y + 0.01) - 0.02);
  return t;
})();
function floorHalf(x: number): number {
  if (x < FB_X0 || x > FB_X1) return 0;
  const f = ((x - FB_X0) / (FB_X1 - FB_X0)) * (FLOOR_TABLE.length - 1);
  const i = Math.min(FLOOR_TABLE.length - 2, Math.floor(f));
  return Math.max(0, FLOOR_TABLE[i] + (FLOOR_TABLE[i + 1] - FLOOR_TABLE[i]) * (f - i));
}
const thwartSpan = (x: number) => innerHalf(x, THW_TOP - 0.012) - 0.004;
const THWART_SPANS = THWARTS.map((t) => thwartSpan(t.x));

function heightAt(x: number, z: number, y?: number): number | null {
  const az = Math.abs(z);
  let best: number | null = null;
  const consider = (h: number) => {
    if (y !== undefined && h > y + 0.45) return;
    if (best === null || h > best) best = h;
  };
  if (az < floorHalf(x)) consider(FLOOR_Y);
  THWARTS.forEach((t, i) => {
    if (Math.abs(x - t.x) <= t.w / 2 && az <= THWART_SPANS[i]) consider(THW_TOP);
  });
  return best;
}
function insideLifelines(x: number, z: number): boolean {
  return x > X_ST + 0.04 && x < X_BW - 0.15 && Math.abs(z) < bd(x) - 0.04;
}
function blocked(x: number, z: number, r: number, y?: number): boolean {
  const feet = y ?? FLOOR_Y;
  if (x - r < X_ST + 0.03 || x + r > X_BW - 0.2) return true;
  return Math.abs(z) + r > innerHalf(x, Math.min(sheerY(x) - 0.02, feet + 0.15));
}
function footprintPen(x: number, z: number): number {
  const ROOM = 0.3;
  if (x < X_ST - ROOM || x > X_BW + ROOM) return 0;
  const w = Math.max(wlHalf(clamp(x, X_ST + 0.01, X_BW - 0.01)), 0.12);
  const side = w + ROOM - Math.abs(z);
  const ends = Math.min(x - (X_ST - ROOM), X_BW + ROOM - x);
  return Math.max(0, Math.min(side, ends));
}
const DINGHY_DECK: DinghyDeck = {
  heightAt,
  blocked,
  insideLifelines: (x, z) => insideLifelines(x, z),
  halfBeam: (x, atDeck) => (atDeck ? bd(x) : wlHalf(x)),
  footprintPen,
  ceilingAt: () => null,
};

// ============================================================ colours

const COL = {
  white: rgb(0xfbf8f0),
  teal: rgb(0x1f8e8c),
  bottom: rgb(0xe9e3d3),
  inner: rgb(0xf0e3c4),
  /** Woodwork tints (multiply the varnish grain). */
  floor: [1.18, 1.16, 1.08] as RGB,
  frame: [0.95, 0.9, 0.85] as RGB,
  grip: [0.72, 0.62, 0.55] as RGB,
  /** Paint on the woodwork (green channel + 2 is the flag). */
  oarTip: [0.12, 0.56 + 2, 0.55] as RGB,
  leather: [0.42, 0.24 + 2, 0.13] as RGB,
  /** Fittings: red channel + 2 = metal. */
  bronze: [0.72 + 2, 0.5, 0.27] as RGB,
  steel: [0.82 + 2, 0.84, 0.86] as RGB,
  prop: [0.24 + 2, 0.26, 0.29] as RGB,
  motorCowl: rgb(0xefe8d7),
  cowlBand: rgb(0xe8664c),
  motorGrey: rgb(0xbfc3bf),
  dark: rgb(0x2a2e32),
  black: rgb(0x16181a),
  rope: rgb(0xd6c39b),
};
const INNER: RGB = [COL.inner[0], COL.inner[1], COL.inner[2] + 2]; // blue + 2 marks the inside (no damage drawn there)

// ============================================================ the hull

function stations(n: number): number[] {
  const xs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    xs.push(X_ST + (LEN - 0.006) * (0.55 * s + 0.45 * (0.5 - 0.5 * Math.cos(Math.PI * s)))); // stop a hair short of the stem so the planks never fold to a point
  }
  return xs;
}

/** A point on the outside of the planking (the lap offset half applied), for damage spots. */
function hullPoint(x: number, u: number, side: number): THREE.Vector3 {
  const s = sectionAt(x);
  const [z, y] = s.point(u);
  const [nz, ny] = s.normal(u);
  return V(x, y + ny * LAP * 0.5, side * (z + nz * LAP * 0.5));
}

function buildHull(p: Part): void {
  const xs = stations(26);
  const secs = xs.map(sectionAt);
  const SUB = 2;
  for (const side of [1, -1]) {
    // the strakes: each plank's surface leans out to its lower edge, which overlaps the next plank down
    for (let i = 0; i < STRAKE_U.length - 1; i++) {
      const v0 = p.nv;
      const i0 = p.idx.length;
      const rows = secs.map((sec, si) => {
        const row: number[] = [];
        for (let j = 0; j <= SUB; j++) {
          const f = j / SUB;
          const u = STRAKE_U[i] + (STRAKE_U[i + 1] - STRAKE_U[i]) * f;
          const [z, y] = sec.point(u);
          const [nz, ny] = sec.normal(u);
          const lap = i === STRAKE_U.length - 2 ? LAP * f * (1 - f) * 2 : LAP * f; // the garboard meets the keel flush
          row.push(p.v(xs[si], y + ny * lap, side * (z + nz * lap), null, 0, 0, i === 0 ? COL.teal : y < 0.02 ? COL.bottom : COL.white));
        }
        return row;
      });
      for (let si = 0; si < xs.length - 1; si++) p.stitch(rows[si], rows[si + 1], false, (q) => V(0, q.y - 0.2, q.z));
      p.smoothNormals(v0, i0);
    }
    // the lands: the narrow edge where one plank overlaps the next
    for (let i = 1; i < STRAKE_U.length - 1; i++) {
      const v0 = p.nv;
      const i0 = p.idx.length;
      const u = STRAKE_U[i];
      const rows = secs.map((sec, si) => {
        const [z, y] = sec.point(u);
        const [nz, ny] = sec.normal(u);
        const c = i === 1 ? COL.teal : y < 0.02 ? COL.bottom : COL.white;
        return [p.v(xs[si], y + ny * LAP, side * (z + nz * LAP), null, 0, 0, c), p.v(xs[si], y, side * z, null, 0, 0, c)];
      });
      for (let si = 0; si < xs.length - 1; si++) p.stitch(rows[si], rows[si + 1], false, (q) => V(0, q.y - 0.4, q.z));
      p.smoothNormals(v0, i0);
    }
  }
  // the inside: smooth cream planking (the laps don't show inside)
  const NJ = 14;
  const v0 = p.nv;
  const i0 = p.idx.length;
  const S: number[][] = [];
  const P: number[][] = [];
  secs.forEach((sec, si) => {
    const rs: number[] = [];
    const rp: number[] = [];
    for (let j = 0; j <= NJ; j++) {
      const u = j / NJ;
      const [z, y] = sec.point(u);
      const [nz, ny] = sec.normal(u);
      const zi = Math.max(0, z - nz * THICK);
      const yi = y - ny * THICK;
      if (j === NJ) {
        const c = p.v(xs[si], yi, 0, null, 0, 0, INNER);
        rs.push(c);
        rp.push(c);
      } else {
        rs.push(p.v(xs[si], yi, zi, null, 0, 0, INNER));
        rp.push(p.v(xs[si], yi, -zi, null, 0, 0, INNER));
      }
    }
    S.push(rs);
    P.push(rp);
  });
  for (let si = 0; si < xs.length - 1; si++) {
    p.stitch(S[si], S[si + 1], false, (q) => V(0, 0.4 - q.y, -q.z));
    p.stitch(P[si], P[si + 1], false, (q) => V(0, 0.4 - q.y, -q.z));
  }
  p.smoothNormals(v0, i0);
  // right at the stem the inside skin folds to a line (hidden under the breasthook): give those a normal anyway
  for (let i = v0; i < p.nv; i++) {
    if (Math.hypot(p.nrm[i * 3], p.nrm[i * 3 + 1], p.nrm[i * 3 + 2]) < 0.5) {
      p.nrm[i * 3] = 0;
      p.nrm[i * 3 + 1] = 1;
      p.nrm[i * 3 + 2] = 0;
    }
  }
}

// ============================================================ woodwork

function slab(p: Part, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: RGB = WHITE, r = 0.01): void {
  const sx = Math.abs(x1 - x0);
  const sy = Math.abs(y1 - y0);
  const sz = Math.abs(z1 - z0);
  p.add(roundedBox(sx, sy, sz, Math.min(r, sx / 2, sy / 2, sz / 2)), c, M((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
}

function buildWoodwork(p: Part): void {
  // transom: a varnished board closing the stern, outside and in
  const sec = sectionAt(X_ST);
  const ring: [number, number][] = [];
  const N = 12;
  for (let j = 0; j <= N; j++) {
    const [z, y] = sec.point(j / N);
    const [nz, ny] = sec.normal(j / N);
    ring.push([z + nz * (LAP + 0.004), y + ny * (LAP + 0.004)]);
  }
  const outline: [number, number][] = [...ring, ...ring.slice(0, N).reverse().map(([z, y]): [number, number] => [-z, y])];
  for (const [x, nx] of [
    [X_ST - 0.003, -1],
    [X_ST + 0.022, 1],
  ] as [number, number][]) {
    const n = V(nx, 0, 0);
    const ids = outline.map(([z, y]) => p.v(x, y, z, n, z * 2, y * 2));
    let cy = 0;
    for (const [, y] of outline) cy += y;
    p.fan(p.v(x, cy / outline.length, 0, n, 0, 0.2), ids, true, n);
  }
  slab(p, X_ST - 0.006, X_ST + 0.026, sec.ys - 0.012, sec.ys + 0.012, -sec.b - LAP - 0.01, sec.b + LAP + 0.01, WHITE, 0.008);
  // gunwales along the sheer, capping both skins
  for (const side of [1, -1]) {
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= 26; i++) {
      const x = X_ST + 0.005 + (X_BW - 0.05 - X_ST - 0.005) * (1 - Math.pow(1 - i / 26, 1.15));
      path.push(V(x, sheerY(x), side * bd(x)));
    }
    const prof: [number, number][] = [
      [-0.034, -0.03],
      [-0.034, 0.004],
      [-0.024, 0.014],
      [0.012, 0.014],
      [0.024, 0.004],
      [0.024, -0.03],
    ];
    sweep(p, path, prof.map(([s, h]): [number, number] => [side * s, h]), false, WHITE);
  }
  // breasthook at the bow and quarter knees at the transom corners
  const bx = 1.3;
  slab(p, 1.1, 1.46, sheerY(bx) - 0.03, sheerY(bx) - 0.005, -bd(1.12) + 0.02, bd(1.12) - 0.02, WHITE, 0.012);
  for (const s of [-1, 1]) slab(p, X_ST + 0.01, X_ST + 0.2, sheerY(X_ST) - 0.03, sheerY(X_ST) - 0.006, s * (bd(X_ST) - 0.16), s * (bd(X_ST) - 0.02), WHITE, 0.01);
  // keel strip along the bottom, the stem post up the bow
  const keel: THREE.Vector3[] = [];
  for (let i = 0; i <= 18; i++) {
    const x = X_ST + 0.01 + (1.47 - X_ST - 0.01) * (i / 18);
    keel.push(V(x, keelY(x) - 0.006, 0));
  }
  tube(p, keel, 0.024, 6, WHITE, true);
  // frames (ribs), steamed to the inside of the planking
  for (let x = -1.2; x <= 1.21; x += 0.3) {
    const s = sectionAt(x);
    const pts: THREE.Vector3[] = [];
    for (const side of [-1, 1]) {
      const us = side < 0 ? [0.03, 0.2, 0.4, 0.6, 0.8, 0.97] : [0.97, 0.8, 0.6, 0.4, 0.2, 0.03];
      for (const u of us) {
        const [z, y] = s.point(u);
        const [nz, ny] = s.normal(u);
        pts.push(V(x, y - ny * (THICK + 0.01), side * Math.max(0.005, z - nz * (THICK + 0.01))));
      }
    }
    tube(p, pts, 0.011, 5, COL.frame);
  }
  // risers the thwarts sit on
  for (const side of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    const yr = THW_TOP - THW_T - 0.012;
    for (let i = 0; i <= 12; i++) {
      const x = -1.38 + (2.5 * i) / 12;
      pts.push(V(x, yr, side * (innerHalf(x, yr) - 0.012)));
    }
    tube(p, pts, 0.014, 6, WHITE, true);
  }
  // thwarts, with a knee post under the rowing thwart
  THWARTS.forEach((t, i) => {
    const span = THWART_SPANS[i];
    p.add(roundedBox(t.w, THW_T, 2 * span, 0.01), WHITE, M(t.x, THW_TOP - THW_T / 2, 0));
  });
  slab(p, 0.02, 0.08, FLOOR_Y, THW_TOP - THW_T, -0.03, 0.03, WHITE, 0.008);
  // floorboards: five slats on cross bearers
  for (const x of [-0.95, -0.25, 0.5]) {
    const w = Math.min(0.28, innerHalf(x, FLOOR_Y - 0.03) - 0.01);
    slab(p, x - 0.03, x + 0.03, FLOOR_Y - 0.045, FLOOR_Y - 0.018, -w, w, COL.frame, 0.006);
  }
  for (const zc of [-0.22, -0.11, 0, 0.11, 0.22]) {
    let a = FB_X0;
    let b = FB_X1;
    while (a < b && innerHalf(a, FLOOR_Y + 0.01) < Math.abs(zc) + 0.07) a += 0.01;
    while (b > a && innerHalf(b, FLOOR_Y + 0.01) < Math.abs(zc) + 0.07) b -= 0.01;
    if (b - a > 0.2) slab(p, a, b, FLOOR_Y - 0.018, FLOOR_Y, zc - 0.044, zc + 0.044, COL.floor, 0.006);
  }
}

/** One oar along its own +x: the pivot (on the leather) at the origin, handle inboard (-x), blade outboard (+x), the blade broad in y. */
function buildOar(p: Part): void {
  tube(p, [V(-0.62, 0, 0), V(-0.47, 0, 0)], 0.017, 6, COL.grip, true);
  tube(p, [V(-0.47, 0, 0), V(0.4, 0, 0), V(1.02, 0, 0)], (s) => 0.021 - 0.004 * s, 6, WHITE, true);
  tube(p, [V(-0.09, 0, 0), V(0.17, 0, 0)], 0.025, 6, COL.leather, true);
  // the blade: a slim spoon, painted teal
  p.add(new THREE.SphereGeometry(1, 10, 6), COL.oarTip, M(1.24, 0, 0, 0, 0, 0, 0.25, 0.068, 0.011));
}

// ============================================================ fittings

/** The outboard (the sloop's, at 0.8 scale), motor-local: origin at the tilt pivot, +x toward the boat. */
function buildMotorBody(): Part {
  const p = new Part();
  p.add(roundedBox(0.36, 0.2, 0.24, 0.07, 3), COL.motorCowl, M(-0.12, 0.31, 0));
  p.add(roundedBox(0.37, 0.03, 0.25, 0.06, 2), COL.cowlBand, M(-0.12, 0.215, 0));
  p.add(roundedBox(0.34, 0.12, 0.22, 0.045, 2), COL.motorGrey, M(-0.115, 0.15, 0));
  p.add(new THREE.CylinderGeometry(0.028, 0.03, 0.012, 12), COL.dark, M(-0.05, 0.412, 0));
  p.add(roundedBox(0.22, 0.1, 0.15, 0.04, 2), COL.motorGrey, M(-0.13, 0.06, 0));
  p.add(new THREE.CylinderGeometry(0.052, 0.06, 0.74, 12), COL.motorGrey, M(-0.13, -0.37, 0, 0, 0, 0, 1, 1, 0.55));
  p.add(roundedBox(0.25, 0.012, 0.15, 0.005), COL.motorGrey, M(-0.16, -0.72, 0));
  p.add(new THREE.CapsuleGeometry(0.042, 0.17, 4, 10), COL.motorGrey, M(-0.14, -0.86, 0, 0, 0, Math.PI / 2));
  p.add(roundedBox(0.09, 0.1, 0.012, 0.004), COL.motorGrey, M(-0.17, -0.94, 0, 0, 0, 0.25));
  tube(p, curve([V(0.03, 0.17, 0), V(0.12, 0.22, 0), V(0.2, 0.265, 0)], 6), 0.017, 8, COL.black);
  tube(p, [V(0.2, 0.265, 0), V(0.29, 0.31, 0)], 0.022, 8, COL.black, true);
  scalePart(p, MOTOR_SCALE);
  return p;
}
function buildProp(): Part {
  const q = new Part();
  const hub = V(-0.27, -0.86, 0);
  const at = new THREE.Matrix4().makeTranslation(hub.x, hub.y, hub.z);
  q.add(new THREE.CylinderGeometry(0.024, 0.03, 0.08, 10), COL.prop, at.clone().multiply(M(0, 0, 0, 0, 0, Math.PI / 2)));
  q.add(new THREE.SphereGeometry(0.025, 8, 6), COL.prop, at.clone().multiply(M(-0.04, 0, 0)));
  for (let k = 0; k < 3; k++) {
    const m = at
      .clone()
      .multiply(new THREE.Matrix4().makeRotationX((k * 2 * Math.PI) / 3))
      .multiply(new THREE.Matrix4().makeRotationY(0.55))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0.068, 0))
      .multiply(new THREE.Matrix4().makeScale(0.011, 0.07, 0.045));
    q.add(new THREE.SphereGeometry(1, 8, 6), COL.prop, m);
  }
  scalePart(q, MOTOR_SCALE);
  return q;
}
function scalePart(p: Part, s: number): void {
  for (let i = 0; i < p.pos.length; i++) p.pos[i] *= s;
}
function addPart(dst: Part, src: Part): void {
  const base = dst.nv;
  for (let i = 0; i < src.nv; i++) {
    dst.v(src.pos[i * 3], src.pos[i * 3 + 1], src.pos[i * 3 + 2], V(src.nrm[i * 3], src.nrm[i * 3 + 1], src.nrm[i * 3 + 2]), src.uv[i * 2], src.uv[i * 2 + 1], [src.col[i * 3], src.col[i * 3 + 1], src.col[i * 3 + 2]]);
  }
  for (const i of src.idx) dst.idx.push(base + i);
}

function oarlockAt(side: number): THREE.Vector3 {
  return V(OARLOCK_X, sheerY(OARLOCK_X) + 0.045, side * (bd(OARLOCK_X) - 0.005));
}

function buildFixedFittings(p: Part): void {
  // bronze rowlocks: a pad on the gunwale, the socket, and the open horn the oar sits in
  for (const side of [-1, 1]) {
    const c = oarlockAt(side);
    slab(p, c.x - 0.05, c.x + 0.05, sheerY(c.x) + 0.012, sheerY(c.x) + 0.02, c.z - 0.025, c.z + 0.025, COL.bronze, 0.004);
    p.add(new THREE.CylinderGeometry(0.009, 0.009, 0.06, 8), COL.bronze, M(c.x, c.y - 0.04, c.z));
    p.add(new THREE.TorusGeometry(0.03, 0.007, 5, 10, Math.PI), COL.bronze, M(c.x, c.y + 0.01, c.z, 0, 0, Math.PI));
  }
  // bow eye with the painter coiled on the bow thwart; lifting eyes
  const eye = V(1.47, 0.42, 0);
  p.add(new THREE.TorusGeometry(0.022, 0.006, 5, 12), COL.bronze, M(eye.x + 0.01, eye.y, 0, 0, Math.PI / 2, 0));
  tube(p, curve([eye.clone().add(V(0.02, -0.01, 0)), V(1.5, 0.54, 0.02), V(1.32, 0.56, 0.05), V(1.12, 0.36, 0.08), V(0.98, THW_TOP + 0.02, 0.1)], 12), 0.007, 5, COL.rope);
  p.add(new THREE.TorusGeometry(0.07, 0.016, 5, 14), COL.rope, M(0.95, THW_TOP + 0.016, 0.12, Math.PI / 2, 0, 0));
  p.add(new THREE.TorusGeometry(0.055, 0.014, 5, 14), COL.rope, M(0.95, THW_TOP + 0.045, 0.12, Math.PI / 2, 0, 0));
  for (const e of [DINGHY_LIFT.bow, DINGHY_LIFT.stern]) {
    p.add(new THREE.TorusGeometry(0.024, 0.006, 5, 12), COL.bronze, M(e.x, e.y + 0.022, 0, 0, Math.PI / 2, 0));
    slab(p, e.x - 0.025, e.x + 0.025, e.y - 0.004, e.y + 0.004, -0.02, 0.02, COL.bronze, 0.002);
  }
  // bronze stem band
  const stem: THREE.Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const x = 1.05 + (0.455 * i) / 10;
    stem.push(V(x, keelY(x) - 0.008, 0));
  }
  tube(p, stem, 0.014, 5, COL.bronze, true);
  // the outboard's clamp bracket over the transom top (fixed; the motor swivels and tilts on it)
  slab(p, X_ST - 0.05, X_ST + 0.045, MOTOR_PIVOT.y - 0.13, MOTOR_PIVOT.y + 0.01, -0.07, 0.07, COL.motorGrey, 0.01);
  for (const e of [-1, 1]) {
    const z = e * 0.04;
    rod(p, V(X_ST + 0.03, MOTOR_PIVOT.y - 0.1, z), V(X_ST + 0.09, MOTOR_PIVOT.y - 0.1, z), 0.006, 6, COL.dark);
    rod(p, V(X_ST + 0.09, MOTOR_PIVOT.y - 0.1, z - 0.03), V(X_ST + 0.09, MOTOR_PIVOT.y - 0.1, z + 0.03), 0.007, 6, COL.dark, true);
  }
}

// ============================================================ materials

function hullMaterial(spots: { pos: THREE.Vector4[]; info: THREE.Vector4[] }): { mat: THREE.MeshStandardMaterial; damage: { value: number } } {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 });
  const damage = { value: 0 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDamage = damage;
    sh.uniforms.uSpot = { value: spots.pos };
    sh.uniforms.uSpotInfo = { value: spots.info };
    sh.vertexShader = 'varying vec3 vDingPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vDingPos = transformed;');
    sh.fragmentShader =
      `varying vec3 vDingPos;\nuniform float uDamage;\nuniform vec4 uSpot[${spots.pos.length}];\nuniform vec4 uSpotInfo[${spots.pos.length}];\n` +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        `vec3 dvc = vColor.rgb;
  float dInner = dvc.b > 1.5 ? 1.0 : 0.0;
  dvc.b -= 2.0 * dInner;
  vec3 dcol = dvc;
  for (int i = 0; i < ${spots.pos.length}; i++) {
    vec4 s = uSpot[i];
    vec4 info = uSpotInfo[i];
    float vis = smoothstep(info.y, info.y + 0.12, uDamage) * (1.0 - dInner);
    if (vis <= 0.0) continue;
    vec3 d3 = vDingPos - s.xyz;
    d3.x *= info.z;
    float d = length(d3);
    if (info.x < 0.5) {
      float m = 1.0 - smoothstep(s.w * 0.35, s.w, d);
      float streak = 0.55 + 0.45 * sin(vDingPos.y * 260.0 + vDingPos.x * 31.0 + float(i) * 1.7);
      dcol = mix(dcol, vec3(0.45, 0.4, 0.34), m * streak * vis * 0.75);
    } else {
      float m = 1.0 - smoothstep(s.w * 0.8, s.w, d);
      float rim = smoothstep(s.w * 0.4, s.w * 0.85, d) * m;
      float chip = step(0.6, fract(sin(dot(floor(vDingPos * 160.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453));
      dcol = mix(dcol, dcol * 0.6, rim * vis);
      dcol = mix(dcol, vec3(0.52, 0.37, 0.22), m * (1.0 - rim * 0.5) * chip * vis * 0.85);
      float pv = smoothstep(0.85, 0.92, uDamage) * (1.0 - dInner) * step(0.5, info.w);
      if (pv > 0.0) {
        vec2 q = abs(vDingPos.xy - s.xy);
        vec2 hs = vec2(s.w * 1.5, s.w * 1.15);
        float inP = step(q.x, hs.x) * step(q.y, hs.y) * step(abs(vDingPos.z - s.z), 0.08);
        float edge = max(q.x / hs.x, q.y / hs.y);
        vec3 pc = vec3(0.7, 0.47, 0.29) * (0.92 + 0.08 * sin(vDingPos.x * 140.0 + vDingPos.y * 60.0));
        vec2 rv = fract((vDingPos.xy - s.xy) / 0.028 + 0.5) - 0.5;
        float riv = (1.0 - smoothstep(0.14, 0.22, length(rv))) * smoothstep(0.74, 0.8, edge);
        pc = mix(pc, vec3(0.28, 0.2, 0.13), riv);
        pc = mix(pc, pc * 0.75, smoothstep(0.95, 1.0, edge));
        dcol = mix(dcol, pc, inP * pv);
      }
    }
  }
  diffuseColor.rgb *= dcol;`,
      );
  };
  mat.customProgramCacheKey = () => 'dinghy-hull-v1';
  return { mat, damage };
}

/** Varnished wood; vertex colours tint it, and green + 2 means paint (oar tips, leathers). */
function woodMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.32, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <color_fragment>',
        `float wPaint = vColor.g > 1.5 ? 1.0 : 0.0;
  diffuseColor.rgb = mix(diffuseColor.rgb * vColor.rgb, vec3(vColor.r, vColor.g - 2.0, vColor.b), wPaint);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.55, wPaint);');
  };
  mat.customProgramCacheKey = () => 'dinghy-wood-v1';
  return mat;
}

/** Fittings: painted or plastic, and red + 2 means metal (bronze, steel). */
function fittingsMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <color_fragment>',
        `float fMetal = vColor.r > 1.5 ? 1.0 : 0.0;
  diffuseColor.rgb *= vec3(vColor.r - 2.0 * fMetal, vColor.g, vColor.b);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.3, fMetal);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = mix(metalnessFactor, 0.85, fMetal);');
  };
  mat.customProgramCacheKey = () => 'dinghy-fittings-v1';
  return mat;
}

let varnishTex: THREE.DataTexture | null = null;

// ============================================================ assembly

export function createDinghy(): Dinghy {
  const hull = new Part();
  buildHull(hull);

  const wood = new DynPart(V(0, 0.1, 0));
  buildWoodwork(wood.part);
  const segOars = [-1, 1].map(() => wood.rigid(buildOar));

  const fit = new DynPart(V(0, 0.1, 0));
  buildFixedFittings(fit.part);
  const motorBody = buildMotorBody();
  const prop = buildProp();
  const segMotor = fit.rigid((p) => addPart(p, motorBody));
  const segProp = fit.rigid((p) => addPart(p, prop));

  // damage spots on the outside of the planking: kind 0 = scuff (stretched along x), 1 = dent (4th value 1 = gets a patch)
  const spotDefs: [number, number, number, number, number, number, number][] = [
    // x, u, side, radius, kind, threshold, stretch-or-patch
    [1.18, 0.42, 1, 0.13, 0, 0.04, 0.35],
    [0.2, 0.52, -1, 0.18, 0, 0.12, 0.3],
    [-0.8, 0.36, 1, 0.15, 0, 0.22, 0.32],
    [0.65, 0.18, -1, 0.11, 0, 0.3, 0.4],
    [-1.2, 0.55, -1, 0.12, 0, 0.4, 0.35],
    [1.32, 0.62, -1, 0.09, 0, 0.28, 0.5],
    [0.45, 0.36, 1, 0.075, 1, 0.38, 1],
    [-0.5, 0.56, -1, 0.085, 1, 0.52, 1],
    [0.92, 0.6, 1, 0.065, 1, 0.62, 0],
    [-1.0, 0.27, 1, 0.07, 1, 0.72, 1],
  ];
  const spots = { pos: [] as THREE.Vector4[], info: [] as THREE.Vector4[] };
  for (const [x, u, side, r, kind, th, extra] of spotDefs) {
    const q = hullPoint(x, u, side);
    spots.pos.push(new THREE.Vector4(q.x, q.y, q.z, r));
    spots.info.push(new THREE.Vector4(kind, th, kind === 0 ? extra : 1, kind === 1 ? extra : 0));
  }

  varnishTex ??= paintVarnish();
  const hm = hullMaterial(spots);
  const hullMesh = new THREE.Mesh(hull.geometry(), hm.mat);
  hullMesh.name = 'dinghy-hull';
  const woodGeom = wood.part.geometry();
  wood.bind(woodGeom);
  woodGeom.boundingSphere = new THREE.Sphere(V(0, 0.2, 0), 2.6);
  const woodMesh = new THREE.Mesh(woodGeom, woodMaterial(varnishTex));
  woodMesh.name = 'dinghy-wood';
  const fitGeom = fit.part.geometry();
  fit.bind(fitGeom);
  fitGeom.boundingSphere = new THREE.Sphere(V(-0.6, 0.2, 0), 2.6);
  const fitMesh = new THREE.Mesh(fitGeom, fittingsMaterial());
  fitMesh.name = 'dinghy-fittings';
  // The water mask: an invisible depth-only lid at the waterline inside the hull, drawn after the boat (renderOrder 1)
  // so a sea drawn after it (renderOrder 2 or later) never shows inside, where the floorboards are below the water.
  const mask = new Part();
  {
    const rows: number[][] = [];
    const n = 16;
    for (let i = 0; i <= n; i++) {
      const x = X_ST + 0.01 + ((X_BW - 0.25 - X_ST - 0.01) * i) / n;
      const w = Math.max(0.01, innerHalf(x, 0.03) - 0.005);
      rows.push([mask.v(x, 0.03, -w), mask.v(x, 0.03, 0), mask.v(x, 0.03, w)]);
    }
    for (let i = 0; i < n; i++) mask.stitch(rows[i], rows[i + 1], false, V(0, 1, 0));
  }
  const maskMesh = new THREE.Mesh(mask.geometry(), new THREE.MeshBasicMaterial({ colorWrite: false }));
  maskMesh.name = 'dinghy-water-mask';
  maskMesh.renderOrder = 1;
  maskMesh.customDepthMaterial = new THREE.MeshDepthMaterial({ transparent: true, opacity: 0, alphaTest: 0.5 }); // casts no shadow
  const group = new THREE.Group();
  group.name = 'dinghy';
  for (const m of [hullMesh, woodMesh, fitMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  group.add(maskMesh);

  // ---------------------------------------------------------------- the rig
  const st = { phase: 0, rowing: false, throttle: 0, time: NaN, tilt: 0, propAngle: 0, rudder: 0, damage: 0, stowed: false };
  const oarMatrices: THREE.Matrix4[] = [new THREE.Matrix4(), new THREE.Matrix4()];
  const oarPose = (side: number): THREE.Matrix4 => {
    if (!st.rowing || st.stowed) {
      // shipped: lying along the thwarts, blades forward and flat
      return new THREE.Matrix4().compose(V(-0.45, THW_TOP + 0.022, side * 0.27), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), V(1, 1, 1));
    }
    const ph = ((st.phase % 1) + 1) % 1;
    const DRIVE = 0.42;
    const ease = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t, 0, 1));
    let alpha: number;
    let beta: number;
    let feather: number;
    if (ph < DRIVE) {
      const s = ph / DRIVE;
      alpha = 0.75 + (-0.45 - 0.75) * ease(s);
      beta = 0.28 + 0.14 * smooth01(s / 0.12) - 0.14 * smooth01((s - 0.88) / 0.12);
      feather = (Math.PI / 2) * smooth01((s - 0.9) / 0.1);
    } else {
      const s = (ph - DRIVE) / (1 - DRIVE);
      alpha = -0.45 + (0.75 + 0.45) * ease(s);
      beta = 0.28;
      feather = (Math.PI / 2) * (1 - smooth01((s - 0.8) / 0.2));
    }
    const theta = side > 0 ? alpha - Math.PI / 2 : Math.PI / 2 - alpha;
    const piv = oarlockAt(side);
    return new THREE.Matrix4()
      .makeTranslation(piv.x, piv.y, piv.z)
      .multiply(new THREE.Matrix4().makeRotationY(theta))
      .multiply(new THREE.Matrix4().makeRotationZ(-beta))
      .multiply(new THREE.Matrix4().makeRotationX(feather));
  };
  const applyOars = () => {
    [-1, 1].forEach((side, i) => {
      oarMatrices[i] = oarPose(side);
      wood.place(segOars[i], oarMatrices[i]);
    });
  };
  const motorMatrix = (): THREE.Matrix4 => {
    const down = st.stowed ? 1 : smooth01(st.tilt);
    const running = Math.abs(st.throttle) > 0.01 && st.tilt > 0.98 && !st.stowed;
    const sh = running ? Math.sqrt(Math.abs(st.throttle)) : 0;
    const t = st.time || 0;
    return new THREE.Matrix4()
      .makeTranslation(MOTOR_PIVOT.x, MOTOR_PIVOT.y + sh * 0.0012 * Math.sin(t * 171), MOTOR_PIVOT.z + sh * 0.0008 * Math.sin(t * 133 + 1))
      .multiply(new THREE.Matrix4().makeRotationZ(MOTOR_UP * (1 - down) + sh * 0.004 * Math.sin(t * 151)))
      .multiply(new THREE.Matrix4().makeRotationY(st.stowed ? STOW_SWIVEL : st.rudder));
  };
  const applyMotor = () => {
    const m = motorMatrix();
    fit.place(segMotor, m);
    fit.place(
      segProp,
      m
        .clone()
        .multiply(new THREE.Matrix4().makeTranslation(PROP_HUB.x, PROP_HUB.y, PROP_HUB.z))
        .multiply(new THREE.Matrix4().makeRotationX(st.propAngle))
        .multiply(new THREE.Matrix4().makeTranslation(-PROP_HUB.x, -PROP_HUB.y, -PROP_HUB.z)),
    );
  };
  applyOars();
  applyMotor();

  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const rig: DinghyRig = {
    setOars(phase, rowing) {
      if (same(phase, st.phase) && rowing === st.rowing) return;
      st.phase = phase;
      st.rowing = rowing;
      applyOars();
    },
    setMotor(throttle, time) {
      const dt = Number.isFinite(st.time) ? clamp(time - st.time, 0, 0.1) : 0;
      st.time = time;
      const before = st.throttle;
      st.throttle = clamp(throttle, -1, 1);
      const target = Math.abs(st.throttle) > 0.01 ? 1 : 0;
      const tiltBefore = st.tilt;
      st.tilt += clamp(target - st.tilt, -dt / TILT_TIME, dt / TILT_TIME);
      st.propAngle = (st.propAngle + dt * st.throttle * 30) % (Math.PI * 2);
      if (st.tilt !== tiltBefore || Math.abs(st.throttle) > 0.01 || !same(before, st.throttle)) applyMotor();
    },
    setRudder(angle) {
      const a = clamp(angle, -RUDDER_MAX, RUDDER_MAX);
      if (same(a, st.rudder)) return;
      st.rudder = a;
      applyMotor();
    },
    setDamage(level) {
      st.damage = clamp(level, 0, 1);
      hm.damage.value = st.damage;
    },
    setStowed(stowed) {
      if (stowed === st.stowed) return;
      st.stowed = stowed;
      applyOars();
      applyMotor();
    },
    status() {
      const m = motorMatrix();
      return {
        oarPhase: st.phase,
        rowing: st.rowing,
        bladeTips: [V(1.48, 0, 0).applyMatrix4(oarMatrices[0]), V(1.48, 0, 0).applyMatrix4(oarMatrices[1])],
        handles: [V(-0.55, 0, 0).applyMatrix4(oarMatrices[0]), V(-0.55, 0, 0).applyMatrix4(oarMatrices[1])],
        throttle: st.throttle,
        motorDown: st.stowed ? 1 : st.tilt,
        propTip: PROP_HUB.clone().applyMatrix4(m),
        propAngle: st.propAngle,
        rudder: st.rudder,
        tillerEnd: TILLER_END.clone().applyMatrix4(m),
        damage: st.damage,
        stowed: st.stowed,
      };
    },
  };

  const points: DinghyPoints = {
    seat: V(THWARTS[1].x, THW_TOP, 0),
    seatYaw: Math.PI / 2,
    helm: V(THWARTS[0].x, THW_TOP, 0.18),
    helmYaw: -Math.PI / 2,
    bow: V(X_BW, sheerY(X_BW), 0),
    stern: V(X_ST, sheerY(X_ST), 0),
    board: V(0.5, FLOOR_Y, 0),
    liftBow: DINGHY_LIFT.bow.clone(),
    liftStern: DINGHY_LIFT.stern.clone(),
  };
  const triangles = (hull.idx.length + wood.part.idx.length + fit.part.idx.length + mask.idx.length) / 3;
  return { group, points, rig, deck: DINGHY_DECK, length: LEN, beam: 2 * HB, draft: -keelY(0), triangles };
}
