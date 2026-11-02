/**
 * Your home: an 8.4 m cruising sloop, built entirely in code, detailed enough to
 * stand on and look at up close in first person. Also describes where a person
 * can walk on it (DeckSurface) and the handy spots aboard (SloopPoints).
 *
 * BOAT-LOCAL AXES (metres)
 *   +x  toward the bow (forward)          -x  toward the stern
 *   +y  up                                 y = 0 is the waterline
 *   +z  to starboard (your right-hand side when you face the bow); -z is port
 *   Origin: on the centreline, halfway between the transom (x = -4.2) and the
 *   stem head (x = +4.2), at the waterline.
 *   A camera faces the bow with rotation.y = -PI/2 (three.js cameras look down -z).
 *
 * KEY HEIGHTS (boat-local y, where the feet go)
 *   cockpit sole 0.40 · benches / bridge deck 0.80 · coaming tops 1.00
 *   side decks 0.78-0.86 (0.80 beside the cockpit) · foredeck 0.82-1.00
 *   cabin top 1.17 at its edges to 1.21 on the centreline · sliding hatch 1.28
 *   stern deck (by the ladder) ~0.87
 *
 * LOOK: "slightly storybook" (DECISIONS 13): rounded edges, warm teak and
 * varnish, cream gelcoat, teal boot stripe. Wood grain and deck planks are
 * painted by code into DataTextures (DECISIONS 14). The fixed parts are merged into
 * seven meshes, one per material; the moving rig (boom, sails, lines, rudder) adds four
 * more, so eleven draw calls in all.
 *
 * THE RIG (createSloop().rig): setSail hoists the main and unrolls the jib, setBoom swings
 * the boom about the gooseneck, setJib sheets the jib to a side, setFill fills or luffs the
 * sails, setRudder turns rudder and tiller about the raked rudder stock, setAnchored shows
 * the anchor line or stows the anchor on the bow roller.
 */
import * as THREE from 'three';

// ============================================================ public types

export interface SloopPoints {
  /** On the stern deck at the top of the swim ladder (inside the stern gap in the rail). */
  ladderTop: THREE.Vector3;
  /** Bottom rung of the swim ladder, in the water about 0.5 m below the waterline. */
  ladderBottom: THREE.Vector3;
  /** Centre of the cockpit locker lid: the port bench seat top. */
  locker: THREE.Vector3;
  /** Where you stand to steer: on the cockpit sole just to starboard of the tiller's end. */
  helm: THREE.Vector3;
  /** The anchor roller at the bow, where the anchor line leaves the boat. */
  bow: THREE.Vector3;
  /** Foot of the mast, on the cabin top. */
  mastBase: THREE.Vector3;
  /** Four spots for small plant pots: two little teak trays on the cabin top either side of the hatch. */
  potShelf: THREE.Vector3[];
  /** Where the player starts: standing on the cockpit sole, facing forward (+x). */
  spawn: THREE.Vector3;
}

export interface DeckSurface {
  /** Standing height (boat-local y, where the feet go) at boat-local x,z, or null if that spot is not walkable boat surface. Includes the cockpit sole, side decks, foredeck, cabin top (a 0.3–0.4 m step up is fine), transom step. */
  heightAt(lx: number, lz: number): number | null;
  /** True if a person of radius r at lx,lz would overlap a solid obstacle: the mast, or the cabin trunk's side walls (you step up onto the cabin top from its rounded front, off the foredeck, or from its back, off the bridge deck). Small and thin things (winches, cleats, dorade vents, tiller, stanchions, shrouds, lines) are ignored. Side-deck walkways stay open for r up to 0.3. */
  blocked(lx: number, lz: number, r: number): boolean;
  /** True if lx,lz is inside the lifelines (the safe area). Outside = over the side. The stern opening by the ladder is the one gap: there the safe area runs right to the transom edge (see sternGap). */
  insideLifelines(lx: number, lz: number): boolean;
  /** Hull outline for the water and dinghy: half-beam at the waterline and at deck level for a given local x. */
  halfBeam(lx: number, atDeck: boolean): number;
  /** The opening in the stern rail where the ladder is: at x = sternGap.x (the transom edge), from z0 to z1. */
  sternGap: { x: number; z0: number; z1: number };
}

// ============================================================ shape constants

const X_AFT = -4.2; // transom top
const X_FWD = 4.2; // stem head
const LOA = X_FWD - X_AFT;
const HALF_BEAM = 1.4;
const X_WIDEST = -0.2;
const CROWN = 0.04; // deck camber
const TRANSOM_RAKE = 0.32; // the transom bottom sits this far forward per metre of height
const DRAFT = 1.45;

const SOLE_Y = 0.4;
const BENCH_Y = 0.8;
const CK_AFT = -3.75; // cockpit opening (benches + footwell)
const CK_FWD = -1.6;
const COAM_IN = 0.98;
const COAM_OUT = 1.04;
const COAM_TOP = 1.0;
const FW_AFT = -3.55; // footwell
const FW_FWD = -1.8;
const FW_HW = 0.42;
const FW_R = 0.1;

const TRUNK_AFT = -1.6;
const TRUNK_FWD = 1.45;
const TRUNK_W_AFT = 0.88;
const TRUNK_W_FWD = 0.62;
const TRUNK_TOP = 1.17;
const TRUNK_CAMBER = 0.04;
const TRUNK_CX = (TRUNK_AFT + TRUNK_FWD) / 2;
const TRUNK_AX = (TRUNK_FWD - TRUNK_AFT) / 2;
const WALL_LEAN = 0.05;
const EDGE_R = 0.05;

const HATCH_AFT = -1.66;
const HATCH_FWD = -0.92;
const HATCH_HW = 0.33;
const HATCH_H = 0.07;
const TRAY_X0 = -1.56;
const TRAY_X1 = -1.1;
const TRAY_Z0 = 0.43;
const TRAY_Z1 = 0.75;
const MAST_X = 1.0;
const MAST_R = 0.085;
const MAST_TOP = 11.2;
const FH_X0 = 1.9; // forehatch
const FH_X1 = 2.42;
const FH_HW = 0.26;
const FH_H = 0.07;
const DORADE_X = 1.24;
const DORADE_Z = 0.3;
const NONSKID_M = 0.26; // metres per repeat of the non-skid texture
const LADDER_Z = 0.58;
const GAP_Z0 = 0.24;
const GAP_Z1 = 0.92;
const WINCH_X = -1.95;
const WINCH_Z = 1.01;
const RAIL_H = 0.62;

// ============================================================ small maths

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth01 = (t: number) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Monotone cubic interpolation (no overshoot) through (xs, ys). */
function pchip(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================ the hull shape

/** Height of the deck edge (sheer line) at x: lowest a little aft of amidships, rising to the bow. */
function sheerY(x: number): number {
  const t = (clamp(x, X_AFT, X_FWD) - X_AFT) / LOA;
  return t < 0.42 ? 0.78 + 0.45 * (0.42 - t) ** 2 : 0.78 + 0.6 * (t - 0.42) ** 2;
}

/** Half-width of the deck at x (0 beyond the ends). */
function deckHalfBeam(x: number): number {
  if (x < X_AFT || x > X_FWD) return 0;
  if (x >= X_WIDEST) {
    const s = (x - X_WIDEST) / (X_FWD - X_WIDEST);
    return HALF_BEAM * (1 - Math.pow(s, 2.1));
  }
  const s = (X_WIDEST - x) / (X_WIDEST - X_AFT);
  return HALF_BEAM - 0.34 * s * s;
}

/** Deck surface height (with camber) at x,z. */
function deckY(x: number, z: number): number {
  const b = deckHalfBeam(x);
  const q = b > 1e-4 ? Math.min(1, Math.abs(z) / b) : 1;
  return sheerY(x) + CROWN * Math.min(1, b / 0.6) * (1 - q * q);
}

/** Centreline bottom of the hull (canoe body), rising up the stem to the stem head. */
const keelY = pchip(
  [-4.2, -3.5, -2.6, -1.4, -0.2, 1.0, 2.1, 2.9, 3.45, 3.85, 4.2],
  [0.08, -0.08, -0.25, -0.39, -0.44, -0.41, -0.3, -0.12, 0.12, 0.45, 0.98],
);

/** Stations near the stern lean forward at the bottom so the transom is raked. */
function transomShear(xi: number): number {
  const s = Math.max(0, 1 - (xi - X_AFT) / 3.2);
  return TRANSOM_RAKE * s * s;
}

interface Section {
  yd: number;
  yk: number;
  b: number;
  shear: number;
  point(u: number): [number, number];
}

/** The hull cross-section at station xi: a cubic curve from the deck edge (u = 0) to the centreline bottom (u = 1). */
function sectionAt(xi: number): Section {
  const t = (xi - X_AFT) / LOA;
  const fwd = smooth01((t - 0.45) / 0.55);
  const aft = smooth01((0.5 - t) / 0.5);
  const yd = sheerY(xi);
  const yk = Math.min(keelY(xi), yd);
  const b = deckHalfBeam(xi);
  const H = Math.max(1e-5, yd - yk);
  const k1 = 1 - 0.32 * fwd; // flare toward the bow
  const a1 = 0.74 - 0.27 * fwd; // how far the topsides run down before turning in
  const c2 = 0.74 + 0.1 * aft - 0.57 * fwd; // bilge fullness
  const dr = 0.18 - 0.1 * aft + 0.75 * fwd; // deadrise
  const p1z = b * k1;
  const p1y = yd - a1 * H;
  const p2z = b * c2;
  const p2y = Math.min(p1y, yk + dr * c2 * b);
  return {
    yd,
    yk,
    b,
    shear: transomShear(xi),
    point(u: number): [number, number] {
      const v = 1 - u;
      const w0 = v * v * v;
      const w1 = 3 * v * v * u;
      const w2 = 3 * v * u * u;
      const w3 = u * u * u;
      return [w0 * b + w1 * p1z + w2 * p2z, w0 * yd + w1 * p1y + w2 * p2y + w3 * yk];
    },
  };
}

/** Half-width of the hull skin at station x and height y (0 if the hull doesn't reach that low there). */
function hullZAt(x: number, y: number): number {
  const sec = sectionAt(clamp(x, X_AFT, X_FWD));
  if (y >= sec.yd) return sec.b;
  if (y <= sec.yk) return 0;
  let a = 0;
  let b = 1;
  for (let k = 0; k < 30; k++) {
    const m = (a + b) / 2;
    if (sec.point(m)[1] > y) a = m;
    else b = m;
  }
  return sec.point((a + b) / 2)[0];
}

function waterlineHalfBeam(lx: number): number {
  if (lx < X_AFT || lx > X_FWD) return 0;
  // Find the station whose waterline point (after the transom rake) sits at lx.
  const f = (xi: number) => xi + transomShear(xi) * sheerY(xi) - lx;
  let a = X_AFT;
  let b = X_FWD;
  if (f(a) > 0) return 0;
  for (let k = 0; k < 40; k++) {
    const m = (a + b) / 2;
    if (f(m) > 0) b = m;
    else a = m;
  }
  const xi = (a + b) / 2;
  const sec = sectionAt(xi);
  if (sec.yk >= 0) return 0;
  let u0 = 0;
  let u1 = 1;
  for (let k = 0; k < 40; k++) {
    const m = (u0 + u1) / 2;
    if (sec.point(m)[1] > 0) u0 = m;
    else u1 = m;
  }
  return sec.point((u0 + u1) / 2)[0];
}

// ============================================================ the cabin trunk shape

function trunkW(x: number): number {
  const t = clamp((x - TRUNK_AFT) / (TRUNK_FWD - TRUNK_AFT), 0, 1);
  return TRUNK_W_AFT + (TRUNK_W_FWD - TRUNK_W_AFT) * t;
}
const trunkN = (ex: number) => (ex < 0 ? 8 : 3); // squarish at the back, rounded at the front

/** Half-width of the cabin trunk's base at x (0 outside it). */
function trunkHalfWidth(x: number): number {
  const ex = (x - TRUNK_CX) / TRUNK_AX;
  if (ex <= -1 || ex >= 1) return 0;
  const n = trunkN(ex);
  return Math.pow(1 - Math.pow(Math.abs(ex), n), 1 / n) * trunkW(x);
}

function cabinTop(x: number, z: number): number {
  const w = trunkW(x);
  const q = Math.min(1, (z / w) ** 2);
  return TRUNK_TOP + TRUNK_CAMBER * (1 - q);
}

/**
 * Outline points of the trunk (unit superellipse) spaced evenly along the base outline, with extra
 * points where it turns (the corners). The superellipse angle parameter bunches up badly, so the
 * outline is first traced finely by subdivision, then resampled.
 */
function trunkOutline(count: number): { ex: number; ez: number; xb: number }[] {
  type P = { ex: number; ez: number; x: number; z: number };
  const at = (th: number): P => {
    const c = Math.cos(th);
    const s = Math.sin(th);
    const n = trunkN(c);
    const ex = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const ez = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    const x = TRUNK_CX + TRUNK_AX * ex;
    return { ex, ez, x, z: ez * trunkW(x) };
  };
  const dense: P[] = [];
  const fill = (a: number, b: number, pa: P, pb: P, depth: number): void => {
    if (depth > 48 || Math.hypot(pb.x - pa.x, pb.z - pa.z) < 0.004) return;
    const m = (a + b) / 2;
    const pm = at(m);
    fill(a, m, pa, pm, depth + 1);
    dense.push(pm);
    fill(m, b, pm, pb, depth + 1);
  };
  const M = 720;
  for (let i = 0; i < M; i++) {
    const a = (i / M) * Math.PI * 2;
    const b = ((i + 1) / M) * Math.PI * 2;
    const pa = at(a);
    dense.push(pa);
    fill(a, b, pa, at(b), 0);
  }
  const D = dense.length;
  // Measure: length plus a bonus for turning, so corners get more points.
  const cum: number[] = [0];
  for (let i = 1; i <= D; i++) {
    const a = dense[i - 1];
    const b = dense[i % D];
    const c = dense[(i + 1) % D];
    const t1 = Math.atan2(b.z - a.z, b.x - a.x);
    const t2 = Math.atan2(c.z - b.z, c.x - b.x);
    let turn = Math.abs(t2 - t1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z) + 0.25 * turn);
  }
  const total = cum[D];
  const out: { ex: number; ez: number; xb: number }[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (cum[j + 1] < target) j++;
    const d = dense[j];
    out.push({ ex: d.ex, ez: d.ez, xb: d.x });
  }
  return out;
}

/** The trunk's side walls in plan (for blocked()): x along the side, z = base half-width. */
const TRUNK_SIDE: [number, number][] = [];
for (let x = TRUNK_AFT + 0.03; x <= TRUNK_FWD - 0.3 + 1e-6; x += 0.1) TRUNK_SIDE.push([x, trunkHalfWidth(x)]);

function inRoundedRect(x: number, z: number, x0: number, x1: number, hw: number, r: number): boolean {
  const az = Math.abs(z);
  if (x < x0 || x > x1 || az > hw) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dz = Math.max(az - (hw - r), 0);
  return dx * dx + dz * dz <= r * r;
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const t = clamp(((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz), 0, 1);
  return Math.hypot(px - ax - t * vx, pz - az - t * vz);
}

// ============================================================ the walkable deck

function heightAt(x: number, z: number): number | null {
  if (x < X_AFT || x > X_FWD) return null;
  const az = Math.abs(z);
  const bd = deckHalfBeam(x);
  if (az > bd - 0.03) return null; // the toerail and the hull edge: not a place to stand
  if (x >= TRUNK_AFT && x <= TRUNK_FWD && az <= trunkHalfWidth(x)) {
    if (x >= HATCH_AFT && x <= HATCH_FWD && az <= HATCH_HW) return cabinTop(x, 0) + HATCH_H;
    if (x >= TRAY_X0 && x <= TRAY_X1 && az >= TRAY_Z0 && az <= TRAY_Z1) return cabinTop(x, z) + 0.02;
    return cabinTop(x, z);
  }
  if (x >= CK_AFT && x <= CK_FWD) {
    if (inRoundedRect(x, z, FW_AFT, FW_FWD, FW_HW, FW_R)) return SOLE_Y;
    if (az < COAM_IN) return BENCH_Y;
    if (az <= COAM_OUT) return COAM_TOP;
  }
  if (x >= FH_X0 && x <= FH_X1 && az <= FH_HW) return deckY(x, 0) + FH_H;
  return deckY(x, z);
}

function blocked(x: number, z: number, r: number): boolean {
  if (Math.hypot(x - MAST_X, z) < r + MAST_R) return true;
  const az = Math.abs(z);
  if (x > TRUNK_AFT - r && x < TRUNK_FWD) {
    for (let i = 0; i < TRUNK_SIDE.length - 1; i++) {
      const a = TRUNK_SIDE[i];
      const b = TRUNK_SIDE[i + 1];
      if (distToSegment(x, az, a[0], a[1], b[0], b[1]) < r) return true;
    }
  }
  return false;
}

function insideLifelines(x: number, z: number): boolean {
  if (x > 4.0 || x < X_AFT) return false;
  if (x < X_AFT + 0.08) return z > GAP_Z0 + 0.04 && z < GAP_Z1 - 0.04; // the stern gap by the ladder
  return Math.abs(z) < deckHalfBeam(x) - 0.08;
}

// ============================================================ geometry building

type RGB = [number, number, number];
function rgb(hex: number): RGB {
  const c = new THREE.Color(hex); // sRGB hex -> linear working colour
  return [c.r, c.g, c.b];
}
const WHITE: RGB = [1, 1, 1];

type Hint = THREE.Vector3 | ((p: THREE.Vector3) => THREE.Vector3);

/** Accumulates the triangles of one material; becomes one mesh (one draw call). */
class Part {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  get nv(): number {
    return this.pos.length / 3;
  }
  v(x: number, y: number, z: number, n: THREE.Vector3 | null = null, u = 0, w = 0, c: RGB = WHITE): number {
    this.pos.push(x, y, z);
    if (n) this.nrm.push(n.x, n.y, n.z);
    else this.nrm.push(0, 1, 0);
    this.uv.push(u, w);
    this.col.push(c[0], c[1], c[2]);
    return this.nv - 1;
  }
  P(i: number): THREE.Vector3 {
    return V(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }
  private cross(a: number, b: number, c: number): THREE.Vector3 {
    const A = this.P(a);
    return this.P(b).sub(A).cross(this.P(c).sub(A));
  }
  /** Triangle a,b,c, flipped if needed so it faces along the hint. */
  tri(a: number, b: number, c: number, hint?: Hint): void {
    if (hint) {
      const n = this.cross(a, b, c);
      const ctr = this.P(a).add(this.P(b)).add(this.P(c)).multiplyScalar(1 / 3);
      const h = typeof hint === 'function' ? hint(ctr) : hint;
      if (n.dot(h) < 0) {
        this.idx.push(a, c, b);
        return;
      }
    }
    this.idx.push(a, b, c);
  }
  /** Joins two equal-length rows of vertices with quads, facing along the hint (decided once, on the biggest quad). */
  stitch(A: number[], B: number[], closed: boolean, hint: Hint): void {
    const n = A.length;
    const last = closed ? n : n - 1;
    let best = -1;
    let flip = false;
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      const nn = this.cross(A[i], A[j], B[j]).add(this.cross(A[i], B[j], B[i]));
      const area = nn.length();
      if (area > best) {
        best = area;
        const ctr = this.P(A[i]).add(this.P(B[j])).multiplyScalar(0.5);
        const h = typeof hint === 'function' ? hint(ctr) : hint;
        flip = nn.dot(h) < 0;
      }
    }
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      if (!flip) this.idx.push(A[i], A[j], B[j], A[i], B[j], B[i]);
      else this.idx.push(A[i], B[j], A[j], A[i], B[i], B[j]);
    }
  }
  fan(center: number, ring: number[], closed: boolean, hint: Hint): void {
    const n = ring.length;
    const last = closed ? n : n - 1;
    let flip = false;
    let best = -1;
    for (let i = 0; i < last; i++) {
      const nn = this.cross(center, ring[i], ring[(i + 1) % n]);
      if (nn.length() > best) {
        best = nn.length();
        const ctr = this.P(center).add(this.P(ring[i])).multiplyScalar(0.5);
        const h = typeof hint === 'function' ? hint(ctr) : hint;
        flip = nn.dot(h) < 0;
      }
    }
    for (let i = 0; i < last; i++) {
      const j = (i + 1) % n;
      if (!flip) this.idx.push(center, ring[i], ring[j]);
      else this.idx.push(center, ring[j], ring[i]);
    }
  }
  /** Recomputes smooth normals for vertices from fromVert, using triangles from fromIdx. */
  smoothNormals(fromVert: number, fromIdx: number): void {
    const acc = new Float64Array((this.nv - fromVert) * 3);
    for (let k = fromIdx; k < this.idx.length; k += 3) {
      const a = this.idx[k];
      const b = this.idx[k + 1];
      const c = this.idx[k + 2];
      const n = this.cross(a, b, c);
      for (const i of [a, b, c]) {
        if (i < fromVert) continue;
        const o = (i - fromVert) * 3;
        acc[o] += n.x;
        acc[o + 1] += n.y;
        acc[o + 2] += n.z;
      }
    }
    for (let i = fromVert; i < this.nv; i++) {
      const o = (i - fromVert) * 3;
      const l = Math.hypot(acc[o], acc[o + 1], acc[o + 2]) || 1;
      this.nrm[i * 3] = acc[o] / l;
      this.nrm[i * 3 + 1] = acc[o + 1] / l;
      this.nrm[i * 3 + 2] = acc[o + 2] / l;
    }
  }
  /** Appends a three.js geometry, moved by m. uvFn (optional) maps the untransformed position to a uv. */
  add(g: THREE.BufferGeometry, c: RGB = WHITE, m?: THREE.Matrix4, uvFn?: (p: THREE.Vector3) => [number, number]): void {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const base = this.nv;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      a.fromBufferAttribute(p, i);
      let u = 0;
      let w = 0;
      if (uvFn) [u, w] = uvFn(a);
      else if (t) {
        u = t.getX(i);
        w = t.getY(i);
      }
      if (m) a.applyMatrix4(m);
      b.fromBufferAttribute(n, i);
      if (nm) b.applyMatrix3(nm).normalize();
      this.v(a.x, a.y, a.z, b, u, w, c);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    g.dispose();
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function M(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(sx, sy, sz));
}

/** Matrix placing a +y-axis primitive between points a and b. */
function between(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
  return new THREE.Matrix4().compose(mid, q, V(1, 1, 1));
}

/** A box with rounded edges and corners (radius r), centred at the origin. UVs run in metres along x (wood grain). */
function roundedBox(sx: number, sy: number, sz: number, r: number, seg = Math.max(sx, sy, sz) < 0.15 ? 1 : 2): THREE.BufferGeometry {
  const rr = Math.max(0.0005, Math.min(r, sx / 2, sy / 2, sz / 2));
  const hx = sx / 2 - rr;
  const hy = sy / 2 - rr;
  const hz = sz / 2 - rr;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const cols = 4 * (seg + 1);
  const rows = 2 * (seg + 1);
  for (let h = 0; h < 2; h++) {
    for (let i = 0; i <= seg; i++) {
      const lat = ((h * seg + i) / (2 * seg)) * Math.PI;
      const syy = h === 0 ? 1 : -1;
      for (let q = 0; q < 4; q++) {
        const mid = (q + 0.5) * (Math.PI / 2);
        const sxx = Math.sign(Math.cos(mid));
        const szz = Math.sign(Math.sin(mid));
        for (let k = 0; k <= seg; k++) {
          const lon = ((q * seg + k) / (4 * seg)) * Math.PI * 2;
          const nx = Math.sin(lat) * Math.cos(lon);
          const ny = Math.cos(lat);
          const nz = Math.sin(lat) * Math.sin(lon);
          const x = sxx * hx + rr * nx;
          const y = syy * hy + rr * ny;
          const z = szz * hz + rr * nz;
          pos.push(x, y, z);
          nrm.push(nx, ny, nz);
          uv.push(x * 2, (y + z) * 2);
        }
      }
    }
  }
  const at = (row: number, col: number) => row * cols + (col % cols);
  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols; col++) {
      const a = at(row, col);
      const b = at(row, col + 1);
      const c = at(row + 1, col);
      const d = at(row + 1, col + 1);
      idx.push(a, b, c, b, d, c);
    }
  }
  // Flat top and bottom caps between the four quadrant corners.
  const corner = (row: number, q: number) => at(row, q * (seg + 1));
  const top = [0, 1, 2, 3].map((q) => corner(0, q));
  const bot = [0, 1, 2, 3].map((q) => corner(rows - 1, q));
  idx.push(top[0], top[2], top[1], top[0], top[3], top[2]);
  idx.push(bot[0], bot[1], bot[2], bot[0], bot[2], bot[3]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A tube through points (radius may vary along it: s = 0..1). Writes straight into a Part. */
function tube(
  p: Part,
  pts: THREE.Vector3[],
  radius: number | ((s: number) => number),
  radial: number,
  c: RGB = WHITE,
  caps = false,
  colorAt?: (s: number, a: number) => RGB,
): void {
  const n = pts.length;
  const rad = typeof radius === 'number' ? () => radius : radius;
  const T: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) T.push(pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
  const t0 = T[0];
  const ax = Math.abs(t0.x) < 0.9 ? V(1, 0, 0) : V(0, 1, 0);
  let N = ax.clone().sub(t0.clone().multiplyScalar(ax.dot(t0))).normalize();
  const lens: number[] = [0];
  for (let i = 1; i < n; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = lens[n - 1] || 1;
  const rings: number[][] = [];
  const dir = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    N = N.sub(T[i].clone().multiplyScalar(N.dot(T[i]))).normalize();
    const B = T[i].clone().cross(N);
    const s = lens[i] / total;
    const r = rad(s);
    const ring: number[] = [];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      ring.push(p.v(pts[i].x + dir.x * r, pts[i].y + dir.y * r, pts[i].z + dir.z * r, dir, lens[i] * 2, j / radial, colorAt ? colorAt(s, a) : c));
    }
    rings.push(ring);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = rings[i][j];
      const b = rings[i][j + 1];
      const cc = rings[i + 1][j];
      const d = rings[i + 1][j + 1];
      p.idx.push(a, b, cc, b, d, cc);
    }
  }
  if (caps) {
    for (const end of [0, n - 1]) {
      const nrm = T[end].clone().multiplyScalar(end === 0 ? -1 : 1);
      const ctr = p.v(pts[end].x, pts[end].y, pts[end].z, nrm, 0, 0, colorAt ? colorAt(end === 0 ? 0 : 1, 0) : c);
      const ring = rings[end].slice(0, radial).map((k) => p.v(p.pos[k * 3], p.pos[k * 3 + 1], p.pos[k * 3 + 2], nrm, 0, 0, colorAt ? colorAt(end === 0 ? 0 : 1, 0) : c));
      p.fan(ctr, ring, true, nrm);
    }
  }
}

function rod(p: Part, a: THREE.Vector3, b: THREE.Vector3, r: number, radial: number, c: RGB, caps = false): void {
  tube(p, [a, b], r, radial, c, caps);
}

function curve(ctrl: THREE.Vector3[], n: number): THREE.Vector3[] {
  return new THREE.CatmullRomCurve3(ctrl, false, 'centripetal').getPoints(n);
}

/**
 * Sweeps a 2D profile (in the plane across the path: [side, up]) along a path whose up direction is +y.
 * Corners are mitred. Used for toerails and rubrails.
 */
function sweep(p: Part, path: THREE.Vector3[], profile: [number, number][], closedPath: boolean, c: RGB, uvScale = 2): void {
  const n = path.length;
  const up = V(0, 1, 0);
  const v0 = p.nv;
  const i0 = p.idx.length;
  const rings: number[][] = [];
  const sides: THREE.Vector3[] = [];
  const cs = profile.reduce((m, pr) => m + pr[0], 0) / profile.length;
  const ch = profile.reduce((m, pr) => m + pr[1], 0) / profile.length;
  let along = 0;
  for (let i = 0; i < n; i++) {
    const prev = path[closedPath ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = path[closedPath ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tPrev = path[i].clone().sub(prev);
    const tNext = next.clone().sub(path[i]);
    if (tPrev.lengthSq() < 1e-10) tPrev.copy(tNext);
    if (tNext.lengthSq() < 1e-10) tNext.copy(tPrev);
    tPrev.y = 0;
    tNext.y = 0;
    tPrev.normalize();
    tNext.normalize();
    const sPrev = tPrev.clone().cross(up).normalize();
    const sNext = tNext.clone().cross(up).normalize();
    const side = sPrev.clone().add(sNext).normalize();
    const scale = 1 / Math.max(0.3, side.dot(sNext));
    sides.push(side.clone().multiplyScalar(scale));
    if (i > 0) along += path[i].distanceTo(path[i - 1]);
    const ring: number[] = [];
    for (const [s, h] of profile) {
      const q = path[i].clone().addScaledVector(side, s * scale).addScaledVector(up, h);
      ring.push(p.v(q.x, q.y, q.z, null, along * uvScale, (s + h) * uvScale, c));
    }
    rings.push(ring);
  }
  const outward = (q: THREE.Vector3): THREE.Vector3 => {
    // nearest path point, then away from it
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = path[i].distanceToSquared(q);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const ctr = path[best].clone().addScaledVector(sides[best], cs).addScaledVector(up, ch);
    return q.clone().sub(ctr);
  };
  for (let i = 0; i < (closedPath ? n : n - 1); i++) p.stitch(rings[i], rings[(i + 1) % n], true, outward);
  p.smoothNormals(v0, i0);
}

// ============================================================ painted textures (DECISIONS 14)

/** Periodic 2D value noise on a gw x gh grid, sampled with u,v in [0,1). */
function periodicNoise(gw: number, gh: number, rnd: () => number): (u: number, v: number) => number {
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (u: number, v: number) => {
    const x = (((u % 1) + 1) % 1) * gw;
    const y = (((v % 1) + 1) % 1) * gh;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const at = (i: number, j: number) => g[(j % gh) * gw + (i % gw)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

function finishTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const PLANK = 0.09; // plank width (m)
const PLANKS_IN_TEX = 8;
const TEX_V = PLANK * PLANKS_IN_TEX; // metres across the planks per texture repeat
const TEX_U = 3.0; // metres along the planks per texture repeat

/** Teak deck planks with black caulking seams and staggered butt joints. u runs along the planks. */
function paintTeak(): THREE.DataTexture {
  const W = 1024;
  const H = 256;
  const PH = H / PLANKS_IN_TEX;
  const rnd = mulberry32(1931);
  const streak = periodicNoise(12, 96, rnd);
  const warp = periodicNoise(6, 16, rnd);
  const blot = periodicNoise(10, 8, rnd);
  const tints: RGB[] = [];
  const joints: number[] = [];
  for (let p = 0; p < PLANKS_IN_TEX; p++) {
    const k = rnd();
    tints.push([188 + 22 * (k - 0.5), 138 + 18 * (k - 0.5) + 6 * (rnd() - 0.5), 90 + 14 * (k - 0.5)]);
    joints.push((((p * 0.375 + rnd() * 0.12) % 1) + 1) % 1);
  }
  const caulk: RGB = [44, 34, 26];
  const data = new Uint8Array(W * H * 4);
  // Slowly varying fields, sampled once per plank (warp) or per 8 pixels (blotches) to keep painting quick.
  const warpRow = new Float32Array(PLANKS_IN_TEX * W);
  for (let p = 0; p < PLANKS_IN_TEX; p++) for (let x = 0; x < W; x++) warpRow[p * W + x] = warp(x / W, (p + 0.5) / PLANKS_IN_TEX) * 9;
  const blotRow = new Float32Array(W / 8 + 1);
  let seed = 12345;
  for (let y = 0; y < H; y++) {
    const p = Math.floor(y / PH);
    const yy = y - p * PH + 0.5;
    const tint = tints[p];
    const v = y / H;
    for (let i = 0; i <= W / 8; i++) blotRow[i] = blot((i * 8) / W + p * 0.3, v);
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const w = warpRow[p * W + x];
      const l = 0.5 + 0.5 * Math.sin((yy + w) * 1.15 + p * 2.1);
      const s = streak(u, v + w * 0.004);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const fine = seed / 4294967296;
      let shade = 1 - 0.12 * l * l * l - 0.1 * (s - 0.5) - 0.05 * (fine - 0.5) + 0.07 * (blotRow[x >> 3] - 0.5);
      // softly rounded plank edges next to the seams
      if (yy < 4 || yy > PH - 1.5) shade *= 0.93;
      let r = tint[0] * shade;
      let g = tint[1] * shade;
      let b = tint[2] * shade;
      let k = 0; // amount of caulk
      if (yy < 2.5) k = yy < 2 ? 1 : 0.5;
      let jd = Math.abs(u - joints[p]) * W;
      jd = Math.min(jd, W - jd);
      if (jd < 1.6) k = Math.max(k, jd < 1 ? 1 : 0.5);
      r += (caulk[0] - r) * k;
      g += (caulk[1] - g) * k;
      b += (caulk[2] - b) * k;
      const o = (y * W + x) * 4;
      data[o] = clamp(r, 0, 255);
      data[o + 1] = clamp(g, 0, 255);
      data[o + 2] = clamp(b, 0, 255);
      data[o + 3] = 255;
    }
  }
  return finishTexture(data, W, H);
}

/** Varnished hardwood: warm, glossy, fine grain along u. */
function paintVarnish(): THREE.DataTexture {
  const W = 256;
  const H = 64;
  const rnd = mulberry32(77);
  const streak = periodicNoise(4, 48, rnd);
  const warp = periodicNoise(4, 6, rnd);
  const fine = periodicNoise(128, 64, rnd);
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const w = warp(u, v) * 6;
      const lines = 0.5 + 0.5 * Math.sin((y + w) * 1.6);
      const shade = 1 - 0.16 * Math.pow(lines, 4) - 0.14 * (streak(u, v + w * 0.01) - 0.5) - 0.06 * (fine(u, v) - 0.5);
      const o = (y * W + x) * 4;
      data[o] = clamp(176 * shade, 0, 255);
      data[o + 1] = clamp(104 * shade, 0, 255);
      data[o + 2] = clamp(54 * shade, 0, 255);
      data[o + 3] = 255;
    }
  }
  return finishTexture(data, W, H);
}

/** Moulded non-skid for the cabin top: a fine diamond pattern of little raised pads, lit from one side. */
function paintNonSkid(): THREE.DataTexture {
  const W = 128;
  const rnd = mulberry32(5);
  const blot = periodicNoise(4, 4, rnd);
  const data = new Uint8Array(W * W * 4);
  const P = 8; // pixels per bump (1 cm)
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      // diamond lattice: rotate the pixel grid by 45 degrees
      const du = (x + y) / 2;
      const dv = (x - y + W) / 2;
      const bx = (du % (P / 2)) - P / 4 + 0.25;
      const by = (dv % (P / 2)) - P / 4 + 0.25;
      const m = Math.abs(bx) + Math.abs(by);
      let shade = 1;
      if (m < 1.2) shade = 1.04; // pad top
      else if (m < 2.0) shade = bx > 0 ? 0.91 : 1.07; // shaded and lit sides
      shade += 0.05 * (blot(x / W, y / W) - 0.5);
      const o = (y * W + x) * 4;
      data[o] = clamp(226 * shade, 0, 255);
      data[o + 1] = clamp(212 * shade, 0, 255);
      data[o + 2] = clamp(184 * shade, 0, 255);
      data[o + 3] = 255;
    }
  }
  return finishTexture(data, W, W);
}

// ============================================================ colours (sRGB, as a designer picks them)

const COL = {
  hull: 0xfbf7ee,
  stripe: 0x1f8e8c,
  bottom: 0xa7443a,
  cream: rgb(0xf3ecdc),
  alu: rgb(0xd3d9dd),
  steel: rgb(0xe8ecef),
  dark: rgb(0x2a2e32),
  black: rgb(0x16181a),
  glass: rgb(0x1a2f3b),
  red: rgb(0xd8392c),
  cowl: rgb(0xb8352c),
  green: rgb(0x2fae5a),
  cover: rgb(0x2b6683),
  coverEdge: rgb(0x214f66),
  sail: rgb(0xf1ece0),
  sailShade: rgb(0xc9d3d8),
  uv: rgb(0x2f6a92),
  uvLight: rgb(0x7da1bb),
  rope: rgb(0xd6c39b),
  line: rgb(0xf2efe6),
  sheet: rgb(0xd9d2c2),
  fender: rgb(0x2b4d70),
  fenderEnd: rgb(0xe8e4d8),
  ring: rgb(0xef5a3a),
  ringWhite: rgb(0xf6f2ea),
  galv: rgb(0x9ea6ab),
  flagA: rgb(0xef6a48),
  flagB: rgb(0xf7efd9),
  flagC: rgb(0x2fb5b0),
};

// ============================================================ the parts of the boat

function buildHull(p: Part): void {
  const NS = 72;
  const NJ = 22;
  const v0 = p.nv;
  const i0 = p.idx.length;
  const S: number[][] = [];
  const Pt: number[][] = [];
  const mids: number[] = [];
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    const t = 0.5 * s + 0.5 * (0.5 - 0.5 * Math.cos(Math.PI * s));
    const xi = X_AFT + LOA * t;
    const sec = sectionAt(xi);
    const rs: number[] = [];
    const rp: number[] = [];
    for (let j = 0; j <= NJ; j++) {
      const u = j / NJ;
      const [z, y] = sec.point(u);
      const x = xi + sec.shear * (sec.yd - y);
      if (j === NJ) {
        const cc = p.v(x, y, 0);
        rs.push(cc);
        rp.push(cc);
      } else {
        rs.push(p.v(x, y, z));
        rp.push(p.v(x, y, -z));
      }
    }
    S.push(rs);
    Pt.push(rp);
    mids.push((sec.yd + sec.yk) / 2);
  }
  for (let i = 0; i < NS; i++) {
    const ym = mids[i];
    const out = (q: THREE.Vector3) => V(0, q.y - ym, q.z);
    p.stitch(S[i], S[i + 1], false, out);
    p.stitch(Pt[i], Pt[i + 1], false, out);
  }
  p.smoothNormals(v0, i0);

  // Transom: a flat raked face closing the stern.
  const tn = V(-1, -TRANSOM_RAKE, 0).normalize();
  const loop: number[] = [];
  for (let j = 0; j <= NJ; j++) loop.push(S[0][j]);
  for (let j = NJ - 1; j >= 0; j--) loop.push(Pt[0][j]);
  const ring: number[] = loop.map((k) => p.v(p.pos[k * 3], p.pos[k * 3 + 1], p.pos[k * 3 + 2], tn));
  const b0 = deckHalfBeam(X_AFT);
  for (let k = 1; k < 10; k++) {
    const z = -b0 + (2 * b0 * k) / 10;
    ring.push(p.v(X_AFT, deckY(X_AFT, z), z, tn));
  }
  let cx = 0;
  let cy = 0;
  for (const k of ring) {
    cx += p.pos[k * 3];
    cy += p.pos[k * 3 + 1];
  }
  cx /= ring.length;
  cy /= ring.length;
  const ctr = p.v(cx, cy, 0, tn);
  p.fan(ctr, ring, true, tn);
}

const nacaShape = (q: number) => 5 * (0.2969 * Math.sqrt(q) - 0.126 * q - 0.3516 * q * q + 0.2843 * q ** 3 - 0.1036 * q ** 4);

interface FoilSec {
  y: number;
  xLE: number;
  chord: number;
  half: number;
}

/** A foil-section loft (keel, rudder) from top to bottom. Sections with half = 0 close the ends. */
function foilLoft(p: Part, secs: FoilSec[], n: number, c: RGB = WHITE): void {
  const v0 = p.nv;
  const i0 = p.idx.length;
  const rings: number[][] = [];
  for (const s of secs) {
    const ring: number[] = [];
    for (let k = 0; k < 2 * n; k++) {
      const side = k <= n ? 1 : -1;
      const kk = k <= n ? k : 2 * n - k;
      const q = 0.5 * (1 - Math.cos((Math.PI * kk) / n));
      ring.push(p.v(s.xLE - q * s.chord, s.y, side * nacaShape(q) * 2 * s.half, null, 0, 0, c));
    }
    rings.push(ring);
  }
  for (let r = 0; r < rings.length - 1; r++) p.stitch(rings[r], rings[r + 1], true, (q) => V(0, 0, q.z));
  p.smoothNormals(v0, i0);
}

/** The rudder's stock axis (it turns about this line) and two marker points on it, at rest. */
interface RudderInfo {
  axisPoint: THREE.Vector3;
  axisDir: THREE.Vector3;
  trailingEdge: THREE.Vector3;
  tillerEnd: THREE.Vector3;
}

/** Vertex colour that tells the rudder material "painted like the hull here" (anything else is varnished wood). */
const PAINTED: RGB = [2, 2, 2];

function buildKeelAndRudder(hull: Part, rudder: Part, metal: Part): RudderInfo {
  foilLoft(
    hull,
    [
      { y: -0.25, xLE: 0.85, chord: 1.8, half: 0.12 },
      { y: -0.45, xLE: 0.78, chord: 1.72, half: 0.115 },
      { y: -0.8, xLE: 0.63, chord: 1.52, half: 0.105 },
      { y: -1.15, xLE: 0.47, chord: 1.32, half: 0.095 },
      { y: -1.36, xLE: 0.37, chord: 1.2, half: 0.088 },
      { y: -1.42, xLE: 0.33, chord: 1.13, half: 0.07 },
      { y: -1.445, xLE: 0.29, chord: 1.05, half: 0.04 },
      { y: -DRAFT, xLE: 0.25, chord: 0.97, half: 0.0 },
    ],
    12,
  );
  // Transom-hung rudder: its leading edge follows the raked transom down into the water.
  const yd0 = sheerY(X_AFT);
  const transomX = (y: number) => X_AFT + TRANSOM_RAKE * (yd0 - y);
  const le = (y: number) => transomX(y) - 0.045;
  const rs: [number, number, number][] = [
    [1.05, 0.15, 0],
    [1.02, 0.17, 0.028],
    [0.8, 0.19, 0.032],
    [0.45, 0.34, 0.034],
    [0.15, 0.5, 0.034],
    [-0.3, 0.54, 0.033],
    [-0.75, 0.52, 0.03],
    [-0.92, 0.46, 0.022],
    [-0.98, 0.38, 0],
  ];
  foilLoft(
    rudder,
    rs.map(([y, chord, half]) => ({ y, xLE: le(y), chord, half })),
    8,
    PAINTED,
  );
  // Pintles and gudgeons holding it to the transom.
  for (const y of [0.62, 0.22]) {
    const x0 = transomX(y) + 0.01;
    const x1 = le(y) - 0.03;
    metal.add(roundedBox(x0 - x1, 0.035, 0.075, 0.01), COL.steel, M((x0 + x1) / 2, y, 0));
  }
  // Rudder-head cheeks and the tiller, rising over the transom into the cockpit.
  for (const s of [-1, 1]) rudder.add(roundedBox(0.22, 0.11, 0.018, 0.008), WHITE, M(le(1.0) - 0.07, 1.0, s * 0.037, 0, 0, 0.12));
  const tillerEnd = V(-2.98, 1.1, 0);
  const tiller = curve([V(le(1.0) - 0.14, 1.0, 0), V(-4.2, 1.055, 0), V(-3.75, 1.1, 0), V(-3.3, 1.115, 0), tillerEnd], 16);
  tube(rudder, tiller, (s) => 0.03 - 0.009 * s, 10, WHITE, true);
  // The stock runs down the leading edge, just inside it, along the transom's rake.
  const top = V(le(1.0) - 0.015, 1.0, 0);
  const bottom = V(le(-0.9) - 0.015, -0.9, 0);
  return {
    axisPoint: top,
    axisDir: bottom.clone().sub(top).normalize(),
    trailingEdge: V(le(-0.3) - 0.54, -0.3, 0),
    tillerEnd,
  };
}

/** Teak decks: side decks, foredeck and stern deck, planks laid parallel to the deck edge with a king plank. */
function buildDeck(teak: Part): void {
  const KING = PLANK / 2;
  const uvSide = (x: number, z: number): [number, number] => [x / TEX_U, (deckHalfBeam(x) - Math.abs(z)) / TEX_V];
  const uvKing = (x: number, z: number): [number, number] => [x / TEX_U + 0.37, (3.5 * PLANK + z) / TEX_V];
  const normalAt = (x: number, z: number) => {
    const e = 0.01;
    const dx = (deckY(x + e, z) - deckY(x - e, z)) / (2 * e);
    const dz = (deckY(x, z + e) - deckY(x, z - e)) / (2 * e);
    return V(-dx, 1, -dz).normalize();
  };
  const strip = (x0: number, x1: number, nx: number, zA: (x: number) => number, zB: (x: number) => number, nz: number, uvf: (x: number, z: number) => [number, number], bias: number) => {
    const rows: number[][] = [];
    for (let i = 0; i <= nx; i++) {
      const s = i / nx;
      const x = x0 + (x1 - x0) * (bias > 0 ? 1 - Math.pow(1 - s, 1 + bias) : s);
      const za = zA(x);
      const zb = zB(x);
      const row: number[] = [];
      for (let j = 0; j <= nz; j++) {
        const z = za + ((zb - za) * j) / nz;
        const [u, w] = uvf(x, z);
        row.push(teak.v(x, deckY(x, z), z, normalAt(x, z), u, w));
      }
      rows.push(row);
    }
    for (let i = 0; i < nx; i++) teak.stitch(rows[i], rows[i + 1], false, V(0, 1, 0));
  };
  const bd = (x: number) => deckHalfBeam(x);
  const kin = (x: number) => Math.min(KING, bd(x));
  // Foredeck + side decks along the cabin (under the trunk too), and the stern deck.
  for (const [x0, x1, nx, bias] of [
    [CK_FWD, X_FWD, 56, 0.6],
    [X_AFT, CK_AFT, 8, 0],
  ] as [number, number, number, number][]) {
    strip(x0, x1, nx, kin, bd, 9, uvSide, bias);
    strip(x0, x1, nx, (x) => -bd(x), (x) => -kin(x), 9, uvSide, bias);
    strip(x0, x1, nx, (x) => -kin(x), kin, 1, uvKing, bias);
  }
  // Side decks beside the cockpit.
  strip(CK_AFT, CK_FWD, 14, () => COAM_OUT - 0.015, bd, 4, uvSide, 0);
  strip(CK_AFT, CK_FWD, 14, (x) => -bd(x), () => -(COAM_OUT - 0.015), 4, uvSide, 0);
}

/** Varnished toerail around the deck edge and a rubbing strake down each side. */
function buildRails(varnish: Part): void {
  const path: THREE.Vector3[] = [];
  const N = 48;
  const xs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    xs.push(X_AFT + 0.02 + (X_FWD - 0.03 - X_AFT - 0.02) * (1 - Math.pow(1 - s, 1.4)));
  }
  const inset = 0.018;
  for (const x of xs) path.push(V(x, sheerY(x) - 0.004, deckHalfBeam(x) - inset));
  path.push(V(X_FWD - 0.005, sheerY(X_FWD) - 0.004, 0));
  for (let i = xs.length - 1; i >= 0; i--) path.push(V(xs[i], sheerY(xs[i]) - 0.004, -(deckHalfBeam(xs[i]) - inset)));
  const b0 = deckHalfBeam(X_AFT + 0.02) - inset;
  for (let k = 1; k < 8; k++) {
    const z = -b0 + (2 * b0 * k) / 8;
    path.push(V(X_AFT + inset - 0.004, deckY(X_AFT, z) - 0.004, z));
  }
  const prof: [number, number][] = [
    [-0.022, -0.01],
    [-0.022, 0.035],
    [-0.016, 0.048],
    [0, 0.052],
    [0.016, 0.048],
    [0.022, 0.035],
    [0.022, -0.01],
  ];
  sweep(varnish, path, prof, true, WHITE);
  // Rubbing strake: a half-round on the hull side just below the deck edge.
  for (const side of [1, -1]) {
    const rp: THREE.Vector3[] = [];
    for (let i = 0; i <= 50; i++) {
      const s = i / 50;
      const x = X_AFT + 0.06 + (X_FWD - 0.14 - X_AFT - 0.06) * (1 - Math.pow(1 - s, 1.3));
      const y = sheerY(x) - 0.04;
      const sec = sectionAt(x);
      const xp = x + sec.shear * (sec.yd - y);
      rp.push(V(xp, y, side * (hullZAt(x, y) - 0.004)));
    }
    const half: [number, number][] = [];
    for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * Math.PI;
      half.push([side * 0.02 * Math.sin(a), -0.018 * Math.cos(a)]);
    }
    if (side < 0) half.reverse();
    sweep(varnish, rp, half, false, WHITE);
  }
}

/** Rounded-rectangle loop in plan (x, z), four corners of nc+1 points each. */
function rrLoop(x0: number, x1: number, hw: number, r: number, nc: number): [number, number][] {
  const out: [number, number][] = [];
  const corners: [number, number, number][] = [
    [x1 - r, hw - r, 0],
    [x0 + r, hw - r, Math.PI / 2],
    [x0 + r, -(hw - r), Math.PI],
    [x1 - r, -(hw - r), (3 * Math.PI) / 2],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= nc; k++) {
      const a = a0 + ((Math.PI / 2) * k) / nc;
      out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
    }
  }
  return out;
}

function buildCockpit(gel: Part, teak: Part, varnish: Part, metal: Part): void {
  const up = V(0, 1, 0);
  const uvFlat = (x: number, z: number): [number, number] => [x / TEX_U + 0.21, z / TEX_V + 0.5];
  const fcx = (FW_AFT + FW_FWD) / 2;
  // Sole (teak).
  const sole = rrLoop(FW_AFT, FW_FWD, FW_HW, FW_R, 4).map(([x, z]) => teak.v(x, SOLE_Y, z, up, ...uvFlat(x, z)));
  teak.fan(teak.v(fcx, SOLE_Y, 0, up, ...uvFlat(fcx, 0)), sole, true, up);
  // Footwell walls with a rounded nosing (gelcoat).
  const v0 = gel.nv;
  const i0 = gel.idx.length;
  const ringAt = (o: number, y: number) => rrLoop(FW_AFT - o, FW_FWD + o, FW_HW + o, FW_R + o, 4).map(([x, z]) => gel.v(x, y, z, null, 0, 0, COL.cream));
  const NR = 0.03;
  const rings = [ringAt(0, SOLE_Y - 0.01), ringAt(0, BENCH_Y - NR)];
  for (const a of [Math.PI / 6, Math.PI / 3, Math.PI / 2]) rings.push(ringAt(NR * (1 - Math.cos(a)), BENCH_Y - NR + NR * Math.sin(a)));
  const inward = (q: THREE.Vector3) => V(fcx - q.x, 0.4, -q.z);
  for (let k = 0; k < rings.length - 1; k++) gel.stitch(rings[k], rings[k + 1], true, inward);
  gel.smoothNormals(v0, i0);
  // Bench tops and bridge deck (teak), from the nosing out to the coamings.
  const inner = rrLoop(FW_AFT - NR, FW_FWD + NR, FW_HW + NR, FW_R + NR, 4).map(([x, z]) => teak.v(x, BENCH_Y, z, up, ...uvFlat(x, z)));
  const outer = rrLoop(CK_AFT, CK_FWD + 0.02, COAM_IN + 0.005, 0.05, 4).map(([x, z]) => teak.v(x, BENCH_Y, z, up, ...uvFlat(x, z)));
  teak.stitch(inner, outer, true, up);
  // Riser from the benches up to the stern deck.
  const lo: number[] = [];
  const hi: number[] = [];
  const fwd = V(1, 0, 0);
  for (let k = 0; k <= 12; k++) {
    const z = -COAM_IN + (2 * COAM_IN * k) / 12;
    lo.push(varnish.v(CK_AFT, BENCH_Y - 0.01, z, fwd, z * 2, 0));
    hi.push(varnish.v(CK_AFT, deckY(CK_AFT, z) + 0.002, z, fwd, z * 2, 0.1));
  }
  varnish.stitch(lo, hi, false, fwd);
  // Coamings with varnished caps.
  const cl = CK_FWD - CK_AFT - 0.04;
  const cxm = (CK_AFT + CK_FWD) / 2;
  for (const s of [-1, 1]) {
    varnish.add(roundedBox(cl, COAM_TOP - BENCH_Y + 0.04, COAM_OUT - COAM_IN, 0.012), WHITE, M(cxm, (COAM_TOP + BENCH_Y - 0.04) / 2 - 0.01, s * (COAM_IN + COAM_OUT) / 2));
    varnish.add(roundedBox(cl + 0.02, 0.024, COAM_OUT - COAM_IN + 0.026, 0.01), WHITE, M(cxm, COAM_TOP - 0.008, s * (COAM_IN + COAM_OUT) / 2));
    // Winch on a teak pad.
    varnish.add(roundedBox(0.2, 0.026, 0.2, 0.01), WHITE, M(WINCH_X, COAM_TOP + 0.012, s * WINCH_Z));
    const wy = COAM_TOP + 0.025;
    metal.add(new THREE.CylinderGeometry(0.072, 0.08, 0.05, 16), COL.steel, M(WINCH_X, wy + 0.025, s * WINCH_Z));
    metal.add(new THREE.CylinderGeometry(0.057, 0.064, 0.085, 16), COL.steel, M(WINCH_X, wy + 0.092, s * WINCH_Z));
    metal.add(new THREE.CylinderGeometry(0.04, 0.052, 0.028, 16), COL.dark, M(WINCH_X, wy + 0.148, s * WINCH_Z));
  }
  // The port bench seat is the locker lid: seam, hinges and a latch.
  const lx0 = -3.2;
  const lx1 = -2.2;
  const lz0 = -0.95;
  const lz1 = -0.49;
  const seam = (x0: number, x1: number, z0: number, z1: number) => {
    const a = metal.v(x0, BENCH_Y + 0.0015, z0, up, 0, 0, COL.black);
    const b = metal.v(x1, BENCH_Y + 0.0015, z0, up, 0, 0, COL.black);
    const c = metal.v(x1, BENCH_Y + 0.0015, z1, up, 0, 0, COL.black);
    const d = metal.v(x0, BENCH_Y + 0.0015, z1, up, 0, 0, COL.black);
    metal.tri(a, b, c, up);
    metal.tri(a, c, d, up);
  };
  const sw = 0.008;
  seam(lx0, lx1, lz0 - sw, lz0);
  seam(lx0, lx1, lz1, lz1 + sw);
  seam(lx0 - sw, lx0, lz0 - sw, lz1 + sw);
  seam(lx1, lx1 + sw, lz0 - sw, lz1 + sw);
  for (const hx of [lx0 + 0.18, lx1 - 0.18]) metal.add(roundedBox(0.09, 0.008, 0.03, 0.003), COL.steel, M(hx, BENCH_Y + 0.004, lz0 + 0.02));
  metal.add(roundedBox(0.08, 0.01, 0.035, 0.005), COL.steel, M((lx0 + lx1) / 2, BENCH_Y + 0.005, lz1 - 0.035));
  // Cockpit drains.
  for (const s of [-1, 1]) {
    metal.add(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 14), COL.steel, M(FW_AFT + 0.1, SOLE_Y + 0.003, s * (FW_HW - 0.1)));
    metal.add(new THREE.CylinderGeometry(0.022, 0.022, 0.004, 14), COL.black, M(FW_AFT + 0.1, SOLE_Y + 0.006, s * (FW_HW - 0.1)));
  }
}

function buildTrunk(gel: Part, nonskid: Part, varnish: Part, metal: Part): void {
  const NT = 104;
  const outline = trunkOutline(NT);
  const v0 = gel.nv;
  const i0 = gel.idx.length;
  const at = (o: { ex: number; ez: number; xb: number }, d: number): [number, number] => [TRUNK_CX + (TRUNK_AX - d) * o.ex, o.ez * (trunkW(o.xb) - d)];
  const rings: number[][] = [];
  // base (tucked under the deck) and the wall top, leaning in
  rings.push(
    outline.map((o) => {
      const [x, z] = at(o, -0.002);
      return gel.v(x, deckY(x, z) - 0.03, z, null, 0, 0, COL.cream);
    }),
  );
  const DT = WALL_LEAN + EDGE_R; // inset of the cabin-top edge
  const edgeY = (o: { ex: number; ez: number; xb: number }) => {
    const [x, z] = at(o, DT);
    return cabinTop(x, z);
  };
  rings.push(
    outline.map((o) => {
      const [x, z] = at(o, WALL_LEAN);
      return gel.v(x, edgeY(o) - EDGE_R, z, null, 0, 0, COL.cream);
    }),
  );
  for (const a of [Math.PI / 6, Math.PI / 3]) {
    rings.push(
      outline.map((o) => {
        const [x, z] = at(o, WALL_LEAN + EDGE_R * (1 - Math.cos(a)));
        return gel.v(x, edgeY(o) - EDGE_R + EDGE_R * Math.sin(a), z, null, 0, 0, COL.cream);
      }),
    );
  }
  // cabin top: a smooth margin, then non-skid in concentric rings to the middle, following the camber
  const capRing = (p: Part, s: number) =>
    outline.map((o) => {
      const x = TRUNK_CX + s * (TRUNK_AX - DT) * o.ex;
      const z = s * o.ez * (trunkW(o.xb) - DT);
      return p.v(x, cabinTop(x, z), z, null, x / NONSKID_M, z / NONSKID_M, COL.cream);
    });
  const MARGIN = 0.95;
  rings.push(capRing(gel, 1), capRing(gel, MARGIN));
  const out = (q: THREE.Vector3) => V(q.x - TRUNK_CX, (q.y - 0.9) * 2, q.z);
  for (let k = 0; k < rings.length - 1; k++) gel.stitch(rings[k], rings[k + 1], true, out);
  gel.smoothNormals(v0, i0);
  const nv0 = nonskid.nv;
  const ni0 = nonskid.idx.length;
  const ns = [MARGIN, 0.8, 0.64, 0.48, 0.32, 0.16].map((s) => capRing(nonskid, s));
  for (let k = 0; k < ns.length - 1; k++) nonskid.stitch(ns[k], ns[k + 1], true, V(0, 1, 0));
  nonskid.fan(nonskid.v(TRUNK_CX, cabinTop(TRUNK_CX, 0), 0, null, TRUNK_CX / NONSKID_M, 0), ns[ns.length - 1], true, V(0, 1, 0));
  nonskid.smoothNormals(nv0, ni0);

  // Varnished eyebrow trim just under the cabin-top edge, round the sides and front.
  {
    const keep: number[] = [];
    for (let k = 0; k < NT; k++) if (outline[k].ex > -0.93) keep.push(k);
    let startAt = 0;
    for (let i = 0; i < keep.length; i++) if (keep[(i + keep.length - 1) % keep.length] !== (keep[i] + NT - 1) % NT) startAt = i;
    const path: THREE.Vector3[] = [];
    for (let i = 0; i < keep.length; i++) {
      const o = outline[keep[(startAt + i) % keep.length]];
      const [x, z] = at(o, WALL_LEAN * 0.9);
      path.push(V(x, edgeY(o) - EDGE_R - 0.012, z));
    }
    const brow: [number, number][] = [];
    for (let k = 0; k <= 6; k++) {
      const a = (k / 6) * Math.PI;
      brow.push([-0.016 * Math.sin(a), -0.016 * Math.cos(a)]);
    }
    sweep(varnish, path, brow, false, WHITE);
  }

  // Small round portlights: three each side and two smaller ones looking forward.
  const wallH = TRUNK_TOP - EDGE_R - 0.8;
  const port = (px: number, s: number, y: number, r: number) => {
    const base = trunkHalfWidth(px);
    const f = clamp((y - deckY(px, base)) / wallH, 0, 1);
    const dw = (trunkHalfWidth(px + 0.004) - trunkHalfWidth(px - 0.004)) / 0.008;
    const nH = V(-dw, 0, s).normalize();
    const pt = V(px, y, s * base).addScaledVector(nH, -WALL_LEAN * f);
    const n = nH.clone().add(V(0, WALL_LEAN / wallH, 0)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), n);
    metal.add(new THREE.TorusGeometry(r + 0.006, 0.012, 5, 16), COL.steel, new THREE.Matrix4().compose(pt.clone().addScaledVector(n, 0.006), q, V(1, 1, 1)));
    metal.add(new THREE.CircleGeometry(r, 16), COL.glass, new THREE.Matrix4().compose(pt.clone().addScaledVector(n, 0.003), q, V(1, 1, 1)));
  };
  // x on the rounded front where the trunk is hw wide
  const frontX = (hw: number) => {
    let a = TRUNK_FWD - 0.5;
    let b = TRUNK_FWD - 0.001;
    for (let k = 0; k < 40; k++) {
      const m = (a + b) / 2;
      if (trunkHalfWidth(m) > hw) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  for (const s of [1, -1]) {
    for (const px of [-0.95, -0.3, 0.35]) port(px, s, 0.99, 0.062);
    port(frontX(0.2), s, 0.99, 0.05);
  }

  // Dorade cowl vents on boxes at the front of the cabin top: white, red inside.
  for (const s of [1, -1]) {
    const dz = s * DORADE_Z;
    const y0 = cabinTop(DORADE_X, dz);
    gel.add(roundedBox(0.22, 0.09, 0.17, 0.025, 2), COL.cream, M(DORADE_X, y0 + 0.03, dz));
    const yb = y0 + 0.075;
    const path = curve([V(DORADE_X - 0.03, yb, dz), V(DORADE_X - 0.03, yb + 0.08, dz), V(DORADE_X - 0.01, yb + 0.15, dz), V(DORADE_X + 0.05, yb + 0.185, dz), V(DORADE_X + 0.09, yb + 0.19, dz)], 12);
    path.push(path[path.length - 1].clone().add(V(0.004, 0, 0)));
    tube(gel, path, (t) => 0.028 + 0.036 * Math.pow(t, 2.2), 12, COL.cream, true, (t) => (t >= 0.999 ? COL.cowl : COL.cream));
  }

  // Varnished handrails along the cabin top.
  for (const s of [1, -1]) {
    const pts: THREE.Vector3[] = [];
    const feet: number[] = [-0.75, -0.2, 0.35, 0.85];
    for (let k = 0; k <= 16; k++) {
      const x = -0.75 + (1.6 * k) / 16;
      const z = s * (trunkHalfWidth(x) - 0.2);
      pts.push(V(x, cabinTop(x, z) + 0.065, z));
    }
    tube(varnish, pts, 0.017, 8, WHITE, true);
    for (const fx of feet) {
      const z = s * (trunkHalfWidth(fx) - 0.2);
      varnish.add(roundedBox(0.05, 0.07, 0.03, 0.01), WHITE, M(fx, cabinTop(fx, z) + 0.03, z));
    }
  }

  // Companionway: washboards in the aft face, and the sliding hatch on top.
  const wallTop = cabinTop(TRUNK_AFT, 0) - 0.012;
  const lean = Math.atan2(WALL_LEAN, wallTop - BENCH_Y);
  const wbH = wallTop - BENCH_Y - 0.01;
  const wbM = (dx: number, dy: number) => {
    const c = V(TRUNK_AFT + 0.004 + dx, BENCH_Y + 0.005 + wbH / 2 + dy, 0);
    c.x += Math.tan(lean) * (wbH / 2 + dy);
    return M(c.x, c.y, c.z, 0, 0, -lean);
  };
  varnish.add(roundedBox(0.03, wbH, 0.56, 0.008), WHITE, wbM(-0.012, 0));
  for (const sz of [-1, 1]) varnish.add(roundedBox(0.04, wbH + 0.01, 0.035, 0.008), WHITE, wbM(-0.01, 0).multiply(M(0, 0, sz * 0.3)));
  for (const fy of [-wbH / 6, wbH / 6]) metal.add(roundedBox(0.004, 0.008, 0.54, 0.002), COL.black, wbM(-0.028, fy));
  const hcx = (HATCH_AFT + HATCH_FWD) / 2;
  const hy = cabinTop(hcx, 0);
  varnish.add(roundedBox(HATCH_FWD - HATCH_AFT, HATCH_H + 0.015, HATCH_HW * 2, 0.025, 3), WHITE, M(hcx, hy + HATCH_H / 2 - 0.0075, 0));
  for (const k of [-1, 0, 1]) metal.add(roundedBox(HATCH_FWD - HATCH_AFT - 0.05, 0.003, 0.006, 0.001), COL.black, M(hcx, hy + HATCH_H + 0.0075, k * 0.11));
  for (const s of [-1, 1]) gel.add(roundedBox(HATCH_FWD - HATCH_AFT + 0.12, 0.05, 0.04, 0.015), COL.cream, M(hcx + 0.04, hy + 0.014, s * (HATCH_HW + 0.024)));
  metal.add(roundedBox(0.03, 0.03, 0.3, 0.012), COL.steel, M(HATCH_AFT + 0.07, hy + HATCH_H + 0.02, 0));

  // Two little teak trays for deck pots, either side of the hatch.
  for (const s of [-1, 1]) {
    const tx = (TRAY_X0 + TRAY_X1) / 2;
    const tz = s * (TRAY_Z0 + TRAY_Z1) / 2;
    const ty = cabinTop(tx, tz);
    const lx = TRAY_X1 - TRAY_X0;
    const lz = TRAY_Z1 - TRAY_Z0;
    varnish.add(roundedBox(lx, 0.02, lz, 0.006), WHITE, M(tx, ty + 0.008, tz));
    for (const e of [-1, 1]) {
      varnish.add(roundedBox(lx, 0.045, 0.016, 0.006), WHITE, M(tx, ty + 0.03, tz + (e * (lz - 0.016)) / 2));
      varnish.add(roundedBox(0.016, 0.045, lz, 0.006), WHITE, M(tx + (e * (lx - 0.016)) / 2, ty + 0.03, tz));
    }
  }

  // Forehatch on the foredeck: a gelcoat frame with a smoky acrylic lid.
  const fx = (FH_X0 + FH_X1) / 2;
  const fy = deckY(fx, 0);
  gel.add(roundedBox(FH_X1 - FH_X0, FH_H + 0.03, FH_HW * 2, 0.025, 3), COL.cream, M(fx, fy + (FH_H + 0.03) / 2 - 0.03, 0));
  metal.add(roundedBox(FH_X1 - FH_X0 - 0.06, 0.012, FH_HW * 2 - 0.06, 0.005), COL.glass, M(fx, fy + FH_H + 0.001, 0));
  for (const s of [-1, 1]) metal.add(roundedBox(0.04, 0.02, 0.07, 0.006), COL.steel, M(FH_X1 + 0.005, fy + FH_H - 0.005, s * 0.14));
}

/** Mast, boom, spreaders, standing rigging, furled sails and the lines. */
function buildRig(metal: Part, cloth: Part): void {
  const mastY0 = cabinTop(MAST_X, 0);
  const mastH = MAST_TOP - mastY0;
  // Mast: tapered, oval (longer fore-and-aft).
  metal.add(new THREE.CylinderGeometry(0.056, 0.078, mastH, 16, 1, false), COL.alu, M(MAST_X, mastY0 + mastH / 2, 0, 0, 0, 0, 1, 1, 0.68));
  metal.add(roundedBox(0.22, 0.05, 0.16, 0.015), COL.dark, M(MAST_X, mastY0 + 0.02, 0)); // mast step
  metal.add(roundedBox(0.26, 0.12, 0.1, 0.02), COL.dark, M(MAST_X + 0.02, MAST_TOP + 0.03, 0)); // masthead
  metal.add(new THREE.SphereGeometry(0.035, 10, 6), COL.steel, M(MAST_X, MAST_TOP + 0.12, 0)); // anchor light
  rod(metal, V(MAST_X - 0.08, MAST_TOP + 0.08, 0), V(MAST_X - 0.08, MAST_TOP + 0.9, 0), 0.006, 4, COL.dark); // VHF aerial
  // Spreaders.
  const spY = 6.5;
  for (const s of [-1, 1]) metal.add(roundedBox(0.07, 0.028, 0.74, 0.012), COL.alu, M(MAST_X, spY, s * 0.42));
  // Standing rigging.
  const wire = 0.0055;
  for (const s of [-1, 1]) {
    const tip = V(MAST_X, spY, s * 0.79);
    const capPlate = V(MAST_X, deckY(MAST_X, 1.24) + 0.04, s * 1.24);
    rod(metal, V(MAST_X, MAST_TOP - 0.2, s * 0.05), tip, wire, 4, COL.steel);
    rod(metal, tip, capPlate, wire, 4, COL.steel);
    for (const lx of [0.45, 1.55]) {
      const plate = V(lx, deckY(lx, 1.22) + 0.04, s * 1.22);
      rod(metal, V(MAST_X, spY - 0.05, s * 0.05), plate, wire, 4, COL.steel);
      rod(metal, plate, plate.clone().add(V(0, -0.05, 0)), 0.012, 6, COL.steel, true);
    }
    rod(metal, capPlate, capPlate.clone().add(V(0, -0.06, 0)), 0.012, 6, COL.steel, true);
  }
  rod(metal, FORE_TOP, STEM_HEAD, wire, 4, COL.steel);
  // Split backstay: one wire from the masthead, two legs to the transom corners (the rudder head is in the middle).
  const split = V(-2.4, 4.4, 0);
  rod(metal, V(MAST_X - 0.08, MAST_TOP - 0.05, 0), split, wire, 4, COL.steel);
  for (const s of [-1, 1]) rod(metal, split, V(-4.05, deckY(-4.05, 1.0) + 0.02, s * 1.0), wire, 4, COL.steel);
  metal.add(roundedBox(0.05, 0.03, 0.04, 0.01), COL.steel, M(split.x, split.y, 0));

  // Furling drum at the foot of the forestay and the swivel at the top of the jib.
  const T = FORE_TOP.clone().sub(STEM_HEAD).normalize();
  const fLen = FORE_TOP.distanceTo(STEM_HEAD);
  const s1 = 1 - 0.75 / fLen;
  metal.add(new THREE.CylinderGeometry(0.065, 0.065, 0.09, 16), COL.dark, between(STEM_HEAD.clone().addScaledVector(T, 0.06), STEM_HEAD.clone().addScaledVector(T, 0.15)));
  metal.add(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8), COL.steel, between(STEM_HEAD.clone().addScaledVector(T, s1 * fLen + 0.01), STEM_HEAD.clone().addScaledVector(T, s1 * fLen + 0.13)));
  // Jib-sheet fairleads on the side decks, and the sheets' fixed run from there back to the winches.
  for (const s of [-1, 1]) {
    const fair = fairlead(s);
    metal.add(roundedBox(0.09, 0.05, 0.05, 0.015), COL.dark, M(fair.x, fair.y - 0.015, fair.z));
    tube(cloth, curve([fair, V(-1.0, deckY(-1.0, 1.1) + 0.06, s * 1.1), V(WINCH_X + 0.03, COAM_TOP + 0.11, s * (WINCH_Z + 0.06))], 10), 0.006, 4, COL.sheet);
  }
  // Halyards down the back of the mast.
  for (const s of [-1, 1]) rod(cloth, V(MAST_X - 0.06, MAST_TOP - 0.1, s * 0.025), V(MAST_X - 0.065, mastY0 + 0.45, s * 0.03), 0.004, 4, COL.line);
  // Mainsheet traveller: a track across the cabin top, just forward of the sliding hatch.
  const ty = travellerY();
  metal.add(roundedBox(0.05, 0.018, 2 * TRAVELLER_HW + 0.12, 0.006), COL.steel, M(TRAVELLER_X, ty, 0));
  for (const e of [-1, 0, 1]) {
    const z = e * (TRAVELLER_HW + 0.07);
    const base = cabinTop(TRAVELLER_X, z);
    metal.add(roundedBox(0.06, ty - base + 0.02, 0.04, 0.008), COL.dark, M(TRAVELLER_X, (ty + base) / 2 - 0.005, z));
  }
}

/** Stanchions, lifelines, bow pulpit, stern pushpit (with the gap for the ladder). */
function buildLifelines(metal: Part, cloth: Part): void {
  const tubeR = 0.0125;
  const edge = (x: number) => deckHalfBeam(x) - 0.06;
  const topY = (x: number) => sheerY(x) + RAIL_H;
  const midY = (x: number) => sheerY(x) + 0.32;
  const stanX = [-2.25, -1.1, 0.1, 1.3, 2.4];
  for (const s of [-1, 1]) {
    for (const x of stanX) {
      const z = s * edge(x);
      const y0 = deckY(x, z);
      rod(metal, V(x, y0, z), V(x, topY(x), z), tubeR, 7, COL.steel, true);
      metal.add(roundedBox(0.09, 0.012, 0.06, 0.004), COL.steel, M(x, y0 + 0.004, z));
    }
  }
  // Bow pulpit.
  const pulpX = 3.25;
  for (const hy of [topY, midY]) {
    const ctrl: THREE.Vector3[] = [];
    for (const s of [-1, 1]) {
      const pts = [pulpX, 3.62, 3.9].map((x) => V(x, hy(x), s * edge(x) * (x > 3.8 ? 0.85 : 1)));
      if (s < 0) ctrl.push(...pts);
      else {
        ctrl.push(V(4.1, hy(4.1), 0));
        ctrl.push(...pts.reverse());
      }
    }
    tube(metal, curve(ctrl, 22), tubeR, 7, COL.steel, true);
  }
  for (const s of [-1, 1]) {
    for (const x of [pulpX, 3.7]) {
      const z = s * edge(x);
      rod(metal, V(x, deckY(x, z), z), V(x, topY(x), z), tubeR, 7, COL.steel);
    }
    rod(metal, V(4.0, deckY(4.0, 0.06), s * 0.06), V(4.08, topY(4.08), s * 0.04), tubeR, 7, COL.steel);
    // Navigation light on the pulpit: red to port, green to starboard.
    metal.add(roundedBox(0.07, 0.05, 0.04, 0.012), s < 0 ? COL.red : COL.green, M(3.95, topY(3.95) - 0.06, s * edge(3.95) * 0.85 + s * 0.02));
  }
  // Stern pushpit: two corner pieces, leaving the gap over the ladder.
  const sternX = X_AFT + 0.07;
  const corner = (s: number, hy: (x: number) => number, endZ: number) => {
    const pts = [
      V(-3.35, hy(-3.35), s * edge(-3.35)),
      V(-3.75, hy(-3.75), s * edge(-3.75)),
      V(-4.02, hy(-4.02), s * (edge(-4.02) - 0.04)),
      V(sternX, hy(sternX), s * (edge(sternX) - 0.2)),
      V(sternX, hy(sternX), endZ),
    ];
    return pts;
  };
  for (const s of [-1, 1]) {
    const endZ = s < 0 ? GAP_Z0 : GAP_Z1;
    tube(metal, curve(corner(s, topY, endZ), 20), tubeR, 7, COL.steel, true);
    tube(metal, curve(corner(s, midY, endZ).slice(0, 3), 8), tubeR, 7, COL.steel, true);
    const legs = [V(-3.35, 0, s * edge(-3.35)), V(-4.0, 0, s * (edge(-4.0) - 0.05)), V(sternX, 0, endZ)];
    for (const l of legs) rod(metal, V(l.x, deckY(l.x, l.z), l.z), V(l.x, topY(l.x), l.z), tubeR, 7, COL.steel);
  }
  // Lifelines: two white-coated wires each side from the pushpit to the pulpit.
  for (const s of [-1, 1]) {
    for (const hy of [topY, midY]) {
      const xs = [-3.35, ...stanX, pulpX];
      for (let i = 0; i < xs.length - 1; i++) {
        const a = V(xs[i], hy(xs[i]), s * edge(xs[i]));
        const b = V(xs[i + 1], hy(xs[i + 1]), s * edge(xs[i + 1]));
        rod(cloth, a, b, 0.0045, 4, COL.line);
      }
    }
  }
}

/** Swim ladder over the transom, life ring, flag, fenders, cleats, bow roller and the anchor line. */
function buildFittings(metal: Part, cloth: Part, varnish: Part): void {
  // --- Swim ladder (starboard side of the transom; the rudder hangs in the middle).
  const yd0 = sheerY(X_AFT);
  const dTop = deckY(X_AFT + 0.1, LADDER_Z);
  for (const s of [-1, 1]) {
    const z = LADDER_Z + s * 0.17;
    const rail = curve(
      [
        V(-3.98, dTop, z),
        V(-4.0, dTop + 0.36, z),
        V(-4.12, dTop + 0.5, z),
        V(-4.27, dTop + 0.38, z),
        V(-4.32, yd0 - 0.1, z),
        V(-4.37, 0.2, z),
        V(-4.41, -0.35, z),
        V(-4.43, -0.62, z),
      ],
      26,
    );
    tube(metal, rail, 0.014, 7, COL.steel, true);
    metal.add(roundedBox(0.07, 0.012, 0.06, 0.004), COL.steel, M(-3.98, dTop + 0.004, z));
    // stand-off feet against the transom
    const ty = 0.45;
    const tx = X_AFT + TRANSOM_RAKE * (yd0 - ty);
    rod(metal, V(-4.355, ty, z), V(tx - 0.01, ty, z), 0.011, 6, COL.steel);
    metal.add(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 10), COL.black, M(tx - 0.005, ty, z, 0, 0, Math.PI / 2 - Math.atan(TRANSOM_RAKE)));
  }
  const rungX = (y: number) => -4.37 - ((0.2 - y) / 0.55) * 0.04;
  for (const y of [0.62, 0.32, 0.02, -0.27, -0.55]) {
    varnish.add(roundedBox(0.075, 0.03, 0.36, 0.01), WHITE, M(rungX(y) - (y > 0.5 ? -0.01 : 0), y, LADDER_Z));
  }

  // --- Life ring on the port pushpit.
  const ringC = V(-3.75, sheerY(-3.75) + 0.42, -(deckHalfBeam(-3.75) - 0.06) - 0.065);
  const ringGeo = new THREE.TorusGeometry(0.2, 0.045, 8, 24);
  {
    const p = ringGeo.getAttribute('position');
    const tmp = new THREE.Vector3();
    const m = M(ringC.x, ringC.y, ringC.z);
    const base = cloth.nv;
    const n = ringGeo.getAttribute('normal');
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    for (let i = 0; i < p.count; i++) {
      tmp.fromBufferAttribute(p, i);
      const a = Math.atan2(tmp.y, tmp.x) + Math.PI;
      const c = Math.floor(a / (Math.PI / 4)) % 2 === 0 ? COL.ring : COL.ringWhite;
      tmp.applyMatrix4(m);
      const nn = new THREE.Vector3().fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      cloth.v(tmp.x, tmp.y, tmp.z, nn, 0, 0, c);
    }
    const ix = ringGeo.index;
    if (ix) for (let i = 0; i < ix.count; i++) cloth.idx.push(base + ix.getX(i));
    ringGeo.dispose();
  }
  // grab line round the ring
  const gl: THREE.Vector3[] = [];
  for (let k = 0; k <= 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const r = 0.247 + 0.012 * Math.cos(a * 4);
    gl.push(V(ringC.x + Math.cos(a) * r, ringC.y + Math.sin(a) * r, ringC.z + 0.0));
  }
  tube(cloth, gl, 0.006, 4, COL.ringWhite);

  // --- Flag on a varnished staff at the port quarter.
  const staffA = V(-4.08, deckY(-4.08, -0.86) + 0.2, -0.86);
  const staffB = V(-4.36, staffA.y + 1.0, -0.86);
  tube(varnish, [staffA, staffB], 0.014, 8, WHITE, true);
  metal.add(new THREE.CylinderGeometry(0.022, 0.022, 0.12, 10), COL.steel, between(staffA.clone().add(V(0.02, -0.08, 0)), staffA.clone().add(V(-0.01, 0.06, 0))));
  {
    const sd = staffB.clone().sub(staffA).normalize();
    const hoistTop = staffB.clone().addScaledVector(sd, -0.03);
    const W = 0.4;
    const Hh = 0.26;
    const NX = 8;
    const bands = [COL.flagA, COL.flagB, COL.flagC];
    for (let b = 0; b < 3; b++) {
      for (const face of [1, -1]) {
        const rows: number[][] = [];
        for (let j = 0; j <= 1; j++) {
          const v = (b + j) / 3;
          const row: number[] = [];
          for (let i = 0; i <= NX; i++) {
            const u = i / NX;
            const wave = 0.045 * Math.sin(u * 7.5 - 0.6) * u;
            const p = hoistTop.clone().addScaledVector(sd, -v * Hh).add(V(-u * W, -u * 0.03, wave + face * 0.0015));
            const nz = face * (1 - 0.3 * Math.cos(u * 7.5 - 0.6) * u);
            const n = V(0.3 * Math.cos(u * 7.5 - 0.6) * face * u, 0, nz).normalize();
            row.push(cloth.v(p.x, p.y, p.z, n, 0, 0, bands[b]));
          }
          rows.push(row);
        }
        cloth.stitch(rows[0], rows[1], false, V(0, 0, face));
      }
    }
  }

  // --- Fenders over the starboard side, ready for the dinghy.
  for (const fx of [-0.9, 0.45]) {
    const fy = 0.42;
    const fz = hullZAt(fx, fy) + 0.1;
    const g = new THREE.CapsuleGeometry(0.095, 0.3, 4, 12);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const base = cloth.nv;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      tmp.fromBufferAttribute(p, i);
      const c = Math.abs(tmp.y) > 0.2 ? COL.fenderEnd : COL.fender;
      cloth.v(tmp.x + fx, tmp.y + fy, tmp.z + fz, new THREE.Vector3().fromBufferAttribute(n, i), 0, 0, c);
    }
    const ix = g.index;
    if (ix) for (let i = 0; i < ix.count; i++) cloth.idx.push(base + ix.getX(i));
    g.dispose();
    const tie = V(fx + 0.05, deckY(fx, 1) + 0.05, deckHalfBeam(fx) - 0.03);
    tube(cloth, curve([V(fx, fy + 0.3, fz), V(fx + 0.03, sheerY(fx) - 0.05, deckHalfBeam(fx) + 0.05), tie], 8), 0.006, 4, COL.rope);
  }

  // --- Cleats.
  const cleat = (x: number, z: number, ry: number) => {
    const y = deckY(x, z);
    const m = M(x, y, z, 0, ry, 0);
    metal.add(roundedBox(0.17, 0.022, 0.03, 0.01), COL.steel, m.clone().multiply(M(0, 0.045, 0)));
    for (const e of [-1, 1]) metal.add(roundedBox(0.03, 0.045, 0.026, 0.008), COL.steel, m.clone().multiply(M(e * 0.04, 0.022, 0)));
  };
  cleat(3.62, 0, 0);
  for (const s of [-1, 1]) cleat(-3.55, s * 1.06, 0);

  // --- Stemhead fitting with the anchor roller.
  metal.add(roundedBox(0.46, 0.025, 0.1, 0.01), COL.steel, M(4.18, 1.0, 0, 0, 0, 0.06));
  for (const s of [-1, 1]) metal.add(roundedBox(0.2, 0.08, 0.008, 0.004), COL.steel, M(4.33, 1.04, s * 0.045, 0, 0, 0.06));
  const roller = V(4.37, 1.05, 0);
  metal.add(new THREE.CylinderGeometry(0.035, 0.035, 0.075, 14), COL.black, M(roller.x, roller.y, 0, Math.PI / 2, 0, 0));

}

// ============================================================ the moving rig (sailing)

/**
 * Sail controls, returned by createSloop() as `rig`. Boat-local: +x bow, +z starboard.
 * Each call only redraws what it changes, so it is fine to call every frame.
 */
export interface SloopRig {
  /** 0 = mainsail furled under its cover on the boom and jib rolled up; 1 = main fully hoisted and jib fully unrolled. In between, the main rises up the mast and the jib unrolls proportionally. */
  setSail(amount: number): void;
  /** Boom angle in radians about the gooseneck (vertical axis): 0 = along the centreline, positive swings the boom out to starboard (+z). The boom stops against the aft shrouds at about ±1.25. */
  setBoom(angle: number): void;
  /** Jib sheeted to this side, as an angle like the boom's: -1 port .. +1 starboard (radians of the jib's foot from the centreline, up to ±1.1). Pass the same sign as the boom. */
  setJib(angle: number): void;
  /** How full the sails are: 1 = drawing, curved and taut; 0 = luffing (nearly flat and rippling; ripple only below 0.6). Pass the time in seconds for the ripple. */
  setFill(fill: number, time: number): void;
  /** Tiller/rudder angle in radians, -0.6..0.6. Positive = rudder trailing edge to starboard (the bow turns to starboard); the tiller swings the other way, to port. */
  setRudder(angle: number): void;
  /** Anchor down: the line runs from the bow roller into the water. Up: no line in the water, anchor stowed on the bow roller. */
  setAnchored(down: boolean): void;
  /** Current state and where the moving bits are (boat-local), for tests, debugging and game logic. */
  status(): SloopRigStatus;
}

export interface SloopRigStatus {
  sail: number;
  boom: number;
  jib: number;
  fill: number;
  rudder: number;
  anchored: boolean;
  coverShown: boolean;
  mainShown: boolean;
  jibShown: boolean;
  rodeShown: boolean;
  anchorStowedShown: boolean;
  boomEnd: THREE.Vector3;
  mainHead: THREE.Vector3;
  jibClew: THREE.Vector3;
  rudderTrailingEdge: THREE.Vector3;
  tillerEnd: THREE.Vector3;
}

interface RigState {
  sail: number;
  boom: number;
  jib: number;
  fill: number;
  time: number;
  rudder: number;
  anchored: boolean;
}

const STEM_HEAD = V(4.25, 1.05, 0); // forestay foot
const FORE_TOP = V(MAST_X + 0.08, MAST_TOP - 0.1, 0); // forestay head
const MAST_Y0 = cabinTop(MAST_X, 0);
const GOOSE_X = MAST_X - 0.09; // the boom swings about a vertical axis through the gooseneck
const GOOSE_Y = 2.25;
const BOOM_END = V(-2.85, 2.36, 0);
const BOOM_MAX = 1.25; // the boom rests against the aft lower shroud beyond this
const TACK_Y = 2.33;
const HEAD_Y = 10.7;
const HEADBOARD = 0.15;
const ROACH = 0.2;
const MAIN_CLEW = V(-2.78, 2.43, 0); // on top of the boom near its end, boom amidships
const MAIN_DEPTH = 0.1; // camber when drawing, as a fraction of the chord
const JIB_DEPTH = 0.12;
const JIB_FOOT = 2.72;
const JIB_MAX = 1.1;
const RUDDER_MAX = 0.6;
const TRAVELLER_X = -0.76; // mainsheet traveller across the cabin top, just forward of the hatch
const TRAVELLER_HW = 0.46;
const MS_BOOM_X = -0.76; // where the mainsheet block hangs from the boom (boom amidships)
const FORE_LEN = FORE_TOP.distanceTo(STEM_HEAD);
const FORE_DIR = FORE_TOP.clone().sub(STEM_HEAD).normalize();
const JIB_T0 = 0.2 / FORE_LEN; // jib tack just above the furling drum
const JIB_T1 = 1 - 0.75 / FORE_LEN; // jib head at the swivel

/** Height of the traveller track (it stands a little proud of the cambered cabin top). */
function travellerY(): number {
  return cabinTop(TRAVELLER_X, 0) + 0.025;
}
function fairlead(side: number): THREE.Vector3 {
  return V(-0.1, deckY(-0.1, 1.15) + 0.045, side * 1.15);
}
/** x of the aft face of the (tapered) mast at height y. */
function mastAftX(y: number): number {
  const t = clamp((y - MAST_Y0) / (MAST_TOP - MAST_Y0), 0, 1);
  return MAST_X - (0.078 - 0.022 * t);
}
function boomY(x: number): number {
  return GOOSE_Y + ((BOOM_END.y - GOOSE_Y) * (GOOSE_X - x)) / (GOOSE_X - BOOM_END.x);
}
/** A point fixed to the boom (given with the boom amidships), swung to boom angle b. */
function onBoom(x: number, y: number, b: number): THREE.Vector3 {
  const dx = x - GOOSE_X;
  return V(GOOSE_X + dx * Math.cos(b), y, -dx * Math.sin(b));
}
function boomMatrix(b: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(GOOSE_X, 0, 0).multiply(new THREE.Matrix4().makeRotationY(b)).multiply(new THREE.Matrix4().makeTranslation(-GOOSE_X, 0, 0));
}
const foreAt = (t: number) => STEM_HEAD.clone().addScaledVector(FORE_DIR, t * FORE_LEN);
const sideOf = (a: number) => (a < -0.01 ? -1 : 1);

/**
 * A cloth-material mesh whose pieces move or are rebuilt when the rig changes. The vertex count and
 * triangles never change: hidden pieces are collapsed to a point.
 */
class DynPart {
  readonly part = new Part();
  private segs: { start: number; count: number; rest: Float32Array | null; restN: Float32Array | null }[] = [];
  private posAttr: THREE.BufferAttribute | null = null;
  private nrmAttr: THREE.BufferAttribute | null = null;
  /** A piece that moves as a whole: built once at rest, then placed by a matrix. */
  rigid(build: (p: Part) => void): number {
    const start = this.part.nv;
    build(this.part);
    const count = this.part.nv - start;
    this.segs.push({
      start,
      count,
      rest: Float32Array.from(this.part.pos.slice(start * 3, (start + count) * 3)),
      restN: Float32Array.from(this.part.nrm.slice(start * 3, (start + count) * 3)),
    });
    return this.segs.length - 1;
  }
  /** A piece rebuilt from scratch whenever its ends move (lines). The builder must always make the same number of vertices. */
  gen(build: (p: Part) => void): number {
    const start = this.part.nv;
    build(this.part);
    this.segs.push({ start, count: this.part.nv - start, rest: null, restN: null });
    return this.segs.length - 1;
  }
  bind(g: THREE.BufferGeometry): void {
    this.posAttr = g.getAttribute('position') as THREE.BufferAttribute;
    this.nrmAttr = g.getAttribute('normal') as THREE.BufferAttribute;
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.nrmAttr.setUsage(THREE.DynamicDrawUsage);
  }
  place(i: number, m: THREE.Matrix4 | null): void {
    const sg = this.segs[i];
    if (!m || !sg.rest || !sg.restN || !this.posAttr || !this.nrmAttr) return this.hide(i);
    const P = this.posAttr.array as Float32Array;
    const N = this.nrmAttr.array as Float32Array;
    const e = m.elements;
    const nm = new THREE.Matrix3().getNormalMatrix(m).elements;
    for (let k = 0; k < sg.count; k++) {
      const x = sg.rest[k * 3];
      const y = sg.rest[k * 3 + 1];
      const z = sg.rest[k * 3 + 2];
      const o = (sg.start + k) * 3;
      P[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const a = sg.restN[k * 3];
      const b = sg.restN[k * 3 + 1];
      const c = sg.restN[k * 3 + 2];
      const nx = nm[0] * a + nm[3] * b + nm[6] * c;
      const ny = nm[1] * a + nm[4] * b + nm[7] * c;
      const nz = nm[2] * a + nm[5] * b + nm[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      N[o] = nx / l;
      N[o + 1] = ny / l;
      N[o + 2] = nz / l;
    }
    this.touch();
  }
  regen(i: number, build: (p: Part) => void, visible = true): void {
    if (!visible) return this.hide(i);
    const sg = this.segs[i];
    if (!this.posAttr || !this.nrmAttr) return;
    const tmp = new Part();
    build(tmp);
    if (tmp.nv !== sg.count) throw new Error(`sloop rig: piece ${i} changed size (${tmp.nv} vs ${sg.count})`);
    const P = this.posAttr.array as Float32Array;
    const N = this.nrmAttr.array as Float32Array;
    P.set(tmp.pos, sg.start * 3);
    N.set(tmp.nrm, sg.start * 3);
    this.touch();
  }
  hide(i: number): void {
    const sg = this.segs[i];
    if (!this.posAttr) return;
    const P = this.posAttr.array as Float32Array;
    const o = sg.start * 3;
    const hx = sg.rest ? sg.rest[0] : P[o];
    const hy = sg.rest ? sg.rest[1] : P[o + 1];
    const hz = sg.rest ? sg.rest[2] : P[o + 2];
    for (let k = 0; k < sg.count; k++) {
      P[o + k * 3] = hx;
      P[o + k * 3 + 1] = hy;
      P[o + k * 3 + 2] = hz;
    }
    this.touch();
  }
  private touch(): void {
    if (this.posAttr) this.posAttr.needsUpdate = true;
    if (this.nrmAttr) this.nrmAttr.needsUpdate = true;
  }
}

/** The furled main on the boom: the sail cover (or, while hoisting, the bare flaked sail). Boom amidships. */
function boomFurl(p: Part, main: RGB, edge: RGB): void {
  const v0 = p.nv;
  const i0 = p.idx.length;
  const NL = 40;
  const K = 16;
  const rings: number[][] = [];
  const xa = MAST_X - 0.06;
  const xb = -2.72;
  for (let i = 0; i <= NL; i++) {
    const s = i / NL;
    const x = xa + (xb - xa) * s;
    const by = boomY(x) + 0.035;
    let h = 0.33 - 0.13 * s + 0.1 * Math.max(0, 1 - s / 0.05) ** 2;
    let w = 0.25 - 0.09 * s;
    const fold = 1 + 0.045 * Math.sin(s * 47) + 0.02 * Math.sin(s * 113);
    h *= 1 + 0.02 * Math.sin(s * 47 + 1);
    w *= fold;
    const endR = s > 0.965 ? Math.sqrt(Math.max(0, 1 - ((s - 0.965) / 0.035) ** 2)) : 1;
    const ring: number[] = [];
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2;
      const z = (w / 2) * Math.sin(a) * (0.82 + 0.18 * Math.sin(a / 2)) * endR;
      const y = by - 0.03 + (h / 2) * (1 - Math.cos(a)) * (0.25 + 0.75 * endR);
      ring.push(p.v(x, y, z, null, 0, 0, Math.cos(a) > 0.82 ? edge : main));
    }
    rings.push(ring);
  }
  const ctrOf = (q: THREE.Vector3) => V(0, q.y - (boomY(q.x) + 0.12), q.z);
  for (let i = 0; i < NL; i++) p.stitch(rings[i], rings[i + 1], true, ctrOf);
  const end = rings[NL];
  let ex = 0;
  let ey = 0;
  for (const k of end) {
    ex += p.pos[k * 3];
    ey += p.pos[k * 3 + 1];
  }
  p.fan(p.v(ex / K - 0.005, ey / K, 0, null, 0, 0, main), end, true, V(-1, 0, 0));
  p.fan(p.v(xa + 0.02, 2.45, 0, null, 0, 0, main), rings[0], true, V(1, 0, 0));
  p.smoothNormals(v0, i0);
}

/** The jib rolled round the forestay, its blue sun-cover strip spiralling round it. Thinner as the jib unrolls. */
function jibRoll(p: Part, sail: number): void {
  const v0 = p.nv;
  const i0 = p.idx.length;
  const N = FORE_DIR.clone().cross(V(0, 0, 1)).normalize();
  const B = FORE_DIR.clone().cross(N);
  const NL = 56;
  const K = 10;
  const turns = 13;
  const rolled = Math.pow(1 - clamp(sail, 0, 1), 0.8);
  const rings: number[][] = [];
  for (let i = 0; i <= NL; i++) {
    const e = i / NL;
    const c = foreAt(JIB_T0 + (JIB_T1 - JIB_T0) * e);
    let r = 0.022 + 0.08 * Math.pow(1 - e, 1.3);
    r = 0.016 + (r - 0.016) * rolled;
    if (e < 0.03) r *= 0.6 + 0.4 * (e / 0.03);
    if (e > 0.985) r *= Math.max(0.15, 1 - (e - 0.985) / 0.015);
    const ring: number[] = [];
    for (let k = 0; k <= K; k++) {
      const a = (k / K) * Math.PI * 2;
      const ph = (((k / K - turns * e) % 1) + 1) % 1;
      const rr = r * (1 + 0.05 * rolled * Math.cos(ph * Math.PI * 2));
      const d = N.clone().multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      ring.push(p.v(c.x + d.x * rr, c.y + d.y * rr, c.z + d.z * rr, null, 0, 0, ph < 0.88 ? COL.uv : ph < 0.95 ? COL.uvLight : COL.sailShade));
    }
    rings.push(ring);
  }
  const axis = (q: THREE.Vector3) => {
    const t = q.clone().sub(STEM_HEAD).dot(FORE_DIR);
    return q.clone().sub(STEM_HEAD.clone().addScaledVector(FORE_DIR, t));
  };
  for (let i = 0; i < NL; i++) p.stitch(rings[i], rings[i + 1], false, axis);
  p.smoothNormals(v0, i0);
}

/** The anchor line: from the bow cleat over the roller, down and forward into the water. */
function anchorLine(p: Part): void {
  const rode = curve(
    [
      V(3.66, deckY(3.66, 0) + 0.05, 0),
      V(4.0, 1.05, 0),
      V(4.33, 1.09, 0),
      V(4.43, 1.03, 0),
      V(4.75, 0.62, 0.02),
      V(5.35, 0.1, 0.06),
      V(6.45, -0.52, 0.12),
      V(8.0, -1.15, 0.2),
      V(9.4, -1.62, 0.26),
    ],
    44,
  );
  tube(p, rode, (s) => 0.013 * (s > 0.9 ? Math.max(0.05, (1 - s) / 0.1) : 1), 5, COL.rope);
}

/** A galvanised plough anchor stowed in the bow roller, with its line made fast to the bow cleat. */
function stowedAnchor(p: Part): void {
  const a = V(3.93, 1.048, 0);
  const b = V(4.48, 1.065, 0);
  p.add(roundedBox(a.distanceTo(b), 0.03, 0.035, 0.01), COL.galv, M((a.x + b.x) / 2, (a.y + b.y) / 2, 0, 0, 0, Math.atan2(b.y - a.y, b.x - a.x)));
  // The plough itself: two triangular plates meeting along a ridge, point down, hanging in front of the stem.
  const crown = V(4.5, 1.03, 0);
  const tip = V(4.43, 0.72, 0);
  const shade: RGB = [COL.galv[0] * 0.8, COL.galv[1] * 0.8, COL.galv[2] * 0.8];
  for (const k of [-1, 1]) {
    const wing = crown.clone().lerp(tip, 0.3).add(V(-0.08, 0.02, k * 0.13));
    const n = tip.clone().sub(crown).cross(wing.clone().sub(crown)).normalize();
    if (n.z * k < 0) n.negate();
    const t = n.clone().multiplyScalar(-0.012);
    const front = [crown, tip, wing].map((q) => p.v(q.x, q.y, q.z, n, 0, 0, COL.galv));
    const nb = n.clone().negate();
    const back = [crown, tip, wing].map((q) => p.v(q.x + t.x, q.y + t.y, q.z + t.z, nb, 0, 0, shade));
    p.tri(front[0], front[1], front[2], n);
    p.tri(back[0], back[1], back[2], nb);
    for (let e = 0; e < 3; e++) {
      const a0 = [crown, tip, wing][e];
      const a1 = [crown, tip, wing][(e + 1) % 3];
      const mid = a0.clone().add(a1).multiplyScalar(0.5);
      const centre = crown.clone().add(tip).add(wing).multiplyScalar(1 / 3);
      const en = mid.clone().sub(centre).normalize();
      const q = [a0, a1, a1.clone().add(t), a0.clone().add(t)].map((r) => p.v(r.x, r.y, r.z, en, 0, 0, shade));
      p.tri(q[0], q[1], q[2], en);
      p.tri(q[0], q[2], q[3], en);
    }
  }
  p.add(roundedBox(0.05, 0.05, 0.05, 0.014), COL.galv, M(crown.x - 0.01, crown.y + 0.01, 0));
  tube(p, curve([V(3.66, deckY(3.66, 0) + 0.05, 0), V(3.8, 1.04, 0), a], 8), 0.013, 5, COL.rope);
}

const flap = (u: number, v: number, t: number) => Math.sin(6.283 * (1.7 * u - 1.4 * t) + 3.3 * v) + 0.45 * Math.sin(6.283 * (3.1 * u - 2.3 * t) + 1.7 * v + 1.3);

/**
 * The mainsail and jib as two cloth grids in one mesh, reshaped on the CPU: the main rises up the mast and
 * swings with the boom; the jib unrolls from the forestay; fill gives them camber, luffing makes them ripple.
 */
class Sails {
  static readonly NUM = 12;
  static readonly NVM = 26;
  static readonly NUJ = 10;
  static readonly NVJ = 22;
  readonly geometry = new THREE.BufferGeometry();
  readonly triangles: number;
  readonly mainHead = new THREE.Vector3();
  readonly jibClew = new THREE.Vector3();
  private pos: Float32Array;
  private uv: Float32Array;
  private jibStart: number;
  constructor() {
    const nm = (Sails.NUM + 1) * (Sails.NVM + 1);
    const nj = (Sails.NUJ + 1) * (Sails.NVJ + 1);
    this.jibStart = nm;
    this.pos = new Float32Array((nm + nj) * 3);
    this.uv = new Float32Array((nm + nj) * 2);
    const idx: number[] = [];
    const grid = (base: number, nu: number, nv: number) => {
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const a = base + j * (nu + 1) + i;
          const b = a + 1;
          const c = a + nu + 1;
          const d = c + 1;
          idx.push(a, b, d, a, d, c);
        }
      }
    };
    grid(0, Sails.NUM, Sails.NVM);
    grid(nm, Sails.NUJ, Sails.NVJ);
    this.triangles = idx.length / 3;
    const pa = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    const ua = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', pa);
    this.geometry.setAttribute('uv', ua);
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array((nm + nj) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(idx);
    // Fixed bounds that hold the sails in any position (so the mesh is never wrongly culled).
    this.geometry.boundingSphere = new THREE.Sphere(V(0.6, 6.4, 0), 8.5);
  }
  update(st: RigState): void {
    const s = Math.max(st.sail, 0.02); // keep a sliver of sail so normals stay sound while hidden
    const lf = st.fill < 0.6 ? (0.6 - st.fill) / 0.6 : 0;
    const fill = clamp(st.fill, 0, 1);
    const P = this.pos;
    const U = this.uv;
    // --- Mainsail: luff up the mast, foot along the boom, roached leech with a headboard.
    {
      const side = sideOf(st.boom);
      const headY = TACK_Y + s * (HEAD_Y - TACK_Y);
      const hx = mastAftX(headY) - HEADBOARD;
      const lx = hx - MAIN_CLEW.x;
      const ly = headY - MAIN_CLEW.y;
      const ll = Math.hypot(lx, ly);
      const rnx = -ly / ll; // leech normal, pointing aft and up (the roach bulges this way)
      const rny = lx / ll;
      const twist = 0.2 * (0.5 + 0.5 * fill);
      for (let j = 0; j <= Sails.NVM; j++) {
        const v = j / Sails.NVM;
        const yL = TACK_Y + v * (headY - TACK_Y);
        const Lx = mastAftX(yL) - 0.006;
        const roach = ROACH * s * Math.pow(Math.sin(Math.PI * v), 0.9);
        const Ex = MAIN_CLEW.x + v * lx + rnx * roach;
        const Ey = MAIN_CLEW.y + v * ly + rny * roach;
        const ang = st.boom + side * twist * Math.pow(v, 1.5);
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const chord = Math.hypot(Ex - Lx, Ey - yL);
        const g = smooth01(v / 0.12) * (1 - 0.35 * v);
        for (let i = 0; i <= Sails.NUM; i++) {
          const u = i / Sails.NUM;
          const dx = (Ex - Lx) * u;
          const y = yL + (Ey - yL) * u;
          let off = fill * MAIN_DEPTH * chord * Math.sin(Math.PI * Math.pow(u, 0.85)) * g * side;
          if (lf > 0) off += lf * 0.1 * Math.sqrt(chord) * Math.pow(u, 0.6) * (0.35 + 0.65 * Math.sin(Math.PI * v)) * smooth01(v / 0.06) * flap(u, v, st.time);
          const o = (j * (Sails.NUM + 1) + i) * 3;
          P[o] = Lx + dx * ca + off * sa;
          P[o + 1] = y;
          P[o + 2] = -dx * sa + off * ca;
          const t = (j * (Sails.NUM + 1) + i) * 2;
          U[t] = 0.01 + 0.47 * u;
          U[t + 1] = 1 - s + s * v;
        }
      }
      this.mainHead.set(mastAftX(headY), headY, 0);
    }
    // --- Jib: luff on the forestay, unrolling from the roll; clew sheeted aft to one side.
    {
      const side = sideOf(st.jib);
      const j = st.jib;
      const tack = foreAt(JIB_T0);
      const head = foreAt(JIB_T1);
      const full = V(tack.x - JIB_FOOT * Math.cos(j), tack.y + 0.5 + 0.2 * Math.abs(Math.sin(j)), JIB_FOOT * Math.sin(j));
      const clew = tack.clone().lerp(full, s);
      this.jibClew.copy(clew);
      const rolled = Math.pow(1 - st.sail, 0.8);
      const L = new THREE.Vector3();
      const E = new THREE.Vector3();
      const C = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let jv = 0; jv <= Sails.NVJ; jv++) {
        const v = jv / Sails.NVJ;
        const r = 0.016 + (0.006 + 0.08 * Math.pow(1 - v, 1.3)) * rolled;
        L.copy(foreAt(JIB_T0 + (JIB_T1 - JIB_T0) * v));
        L.z += side * r;
        E.copy(clew).lerp(head, v);
        E.lerp(L, 0.03 * Math.sin(Math.PI * v) * s); // slightly hollow leech
        C.copy(E).sub(L);
        const chord = C.length();
        n.copy(FORE_DIR).cross(C);
        if (n.lengthSq() < 1e-10) n.set(0, 0, side);
        n.normalize();
        if (n.z * side < 0) n.negate();
        for (let i = 0; i <= Sails.NUJ; i++) {
          const u = i / Sails.NUJ;
          let off = fill * JIB_DEPTH * chord * Math.sin(Math.PI * Math.pow(u, 0.9)) * (1 - 0.25 * v);
          if (lf > 0) off += lf * 0.09 * Math.sqrt(chord) * Math.pow(u, 0.6) * (0.4 + 0.6 * Math.sin(Math.PI * v)) * flap(u, v + 0.5, st.time * 1.15);
          const o = (this.jibStart + jv * (Sails.NUJ + 1) + i) * 3;
          P[o] = L.x + C.x * u + n.x * off;
          P[o + 1] = L.y + C.y * u + n.y * off;
          P[o + 2] = L.z + C.z * u + n.z * off;
          const t = (this.jibStart + jv * (Sails.NUJ + 1) + i) * 2;
          U[t] = 0.52 + 0.47 * (1 - s + s * u);
          U[t + 1] = v;
        }
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('uv').needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

/** Sailcloth: off-white Dacron with stitched panel seams. Left half = mainsail (battens, tapes, patches), right half = jib (blue sun strip). */
function paintSail(): THREE.DataTexture {
  const W = 512;
  const H = 512;
  const rnd = mulberry32(31);
  const weave = periodicNoise(128, 128, rnd);
  const data = new Uint8Array(W * H * 4);
  const BATTENS = [0.2, 0.41, 0.61, 0.8];
  const uvc: RGB = [47, 106, 146];
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const isMain = x < W / 2;
      const u = isMain ? ((x + 0.5) / W - 0.01) / 0.47 : ((x + 0.5) / W - 0.52) / 0.47;
      let shade = 1 + 0.025 * (weave(x / W, y / H) - 0.5);
      let col: RGB = [244, 241, 232];
      // panel seams: a stitched double line
      const panels = isMain ? 15 : 13;
      const sp = (v * panels) % 1;
      const pd = Math.min(sp, 1 - sp) * (H / panels);
      if (pd < 1.0) shade *= 0.86;
      else if (pd < 2.2) shade *= 1.03;
      // tapes along the edges
      if (u < 0.015 || v < 0.012 || u > 0.985) shade *= 0.9;
      if (isMain) {
        for (const b of BATTENS) {
          const bd = Math.abs(v - b) * H;
          const len = b < 0.7 ? 0.38 : 0.3;
          if (u > 1 - len && bd < 3.5) shade *= bd > 2.5 ? 0.82 : 0.93;
        }
        if (u + v * 2.2 < 0.13 || (u > 0.86 && v < 0.07 && (1 - u) + v * 2 < 0.16) || v > 0.965) shade *= 0.93; // reinforcing patches
      } else {
        const strip = u > 0.91 || v < 0.035;
        if (strip && u < 0.975) col = uvc;
        if ((Math.abs(u - 0.91) * W * 0.47 < 1 && v > 0.035) || (Math.abs(v - 0.035) * H < 1 && u < 0.91)) shade *= 0.8;
        if (u > 0.975) col = [236, 232, 222];
      }
      const o = (y * W + x) * 4;
      data[o] = clamp(col[0] * shade, 0, 255);
      data[o + 1] = clamp(col[1] * shade, 0, 255);
      data[o + 2] = clamp(col[2] * shade, 0, 255);
      data[o + 3] = 255;
    }
  }
  const tex = finishTexture(data, W, H);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** The boom and its fittings, built with the boom amidships, then moved so the gooseneck pivot is the origin. */
function buildBoom(p: Part): void {
  const boomA = V(GOOSE_X, GOOSE_Y, 0);
  const boomLen = boomA.distanceTo(BOOM_END);
  p.add(new THREE.CylinderGeometry(0.055, 0.055, boomLen, 14, 1, false), COL.alu, between(boomA, BOOM_END).multiply(M(0, 0, 0, 0, 0, 0, 1, 1, 0.7)));
  p.add(roundedBox(0.09, 0.08, 0.07, 0.015), COL.dark, M(GOOSE_X + 0.02, GOOSE_Y, 0)); // gooseneck
  p.add(roundedBox(0.1, 0.12, 0.08, 0.02), COL.dark, M(BOOM_END.x, BOOM_END.y, 0)); // end fitting
  rod(p, V(MAST_X - 0.06, MAST_Y0 + 0.25, 0), V(0.3, boomY(0.3) - 0.04, 0), 0.016, 8, COL.alu); // vang
  const by = boomY(MS_BOOM_X);
  p.add(roundedBox(0.035, 0.03, 0.04, 0.008), COL.steel, M(MS_BOOM_X, by - 0.06, 0)); // bail
  p.add(roundedBox(0.045, 0.06, 0.04, 0.016), COL.dark, M(MS_BOOM_X, by - 0.1, 0)); // mainsheet block
  for (let i = 0; i < p.pos.length; i += 3) p.pos[i] -= GOOSE_X;
}

/** The varnished-wood material for the rudder and tiller, painting the blade like the hull where vertex colour says so. */
function rudderMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.3, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vBoatPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBoatPos = transformed;');
    sh.fragmentShader =
      'varying vec3 vBoatPos;\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  float hPainted = vColor.g > 1.5 ? 1.0 : 0.0;
${hullBandGlsl()}
  diffuseColor.rgb = mix(diffuseColor.rgb, hc, hPainted);`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.75, hBottom * hPainted);');
  };
  mat.customProgramCacheKey = () => 'sloop-rudder-v1';
  return mat;
}

/** Builds the moving rig: boom, sails, the soft parts (cover, rolled jib, sheets, anchor line), rudder and tiller. */
function buildMovingRig(
  metalMat: THREE.Material,
  clothMat: THREE.Material,
  varnishTex: THREE.Texture,
  rudderPart: Part,
  rudderInfo: RudderInfo,
): { objects: THREE.Object3D[]; rig: SloopRig; triangles: number } {
  const st: RigState = { sail: 0, boom: 0, jib: 0, fill: 1, time: 0, rudder: 0, anchored: true };

  // Boom: its own group, pivoting about the vertical axis through the gooseneck.
  const boomPart = new Part();
  buildBoom(boomPart);
  const boomMesh = new THREE.Mesh(boomPart.geometry(), metalMat);
  boomMesh.name = 'sloop-boom';
  const boomGroup = new THREE.Group();
  boomGroup.name = 'sloop-boom-pivot';
  boomGroup.position.set(GOOSE_X, 0, 0);
  boomGroup.add(boomMesh);

  // Soft parts that move or come and go.
  const dyn = new DynPart();
  const segCover = dyn.rigid((p) => boomFurl(p, COL.cover, COL.coverEdge));
  const segBundle = dyn.rigid((p) => boomFurl(p, COL.sail, COL.sailShade));
  const segRoll = dyn.gen((p) => jibRoll(p, st.sail));
  const sheetCtrl = (side: number): THREE.Vector3[] => {
    const fair = fairlead(side);
    const clew = sails.jibClew;
    const k = smooth01(st.sail / 0.25);
    const lee = sideOf(st.jib) === side;
    const a = clew.clone().add(V(-0.05 * (1 - k), 0, side * 0.06 * (1 - k)));
    const m0 = V(2.0, 1.12, side * 0.62);
    const m1 = lee ? clew.clone().lerp(fair, 0.5).add(V(0, -0.04, 0)) : V((clew.x + 1.9) / 2, 1.2, side * 0.5);
    return [a, m0.lerp(m1, k), fair];
  };
  const sheetBuild = (side: number) => (p: Part) => tube(p, curve(sheetCtrl(side), 14), 0.006, 4, COL.sheet);
  const sails = new Sails();
  sails.update(st);
  const segSheets = [dyn.gen(sheetBuild(-1)), dyn.gen(sheetBuild(1))];
  const liftTop = V(MAST_X - 0.1, MAST_TOP - 0.05, 0);
  const liftBuild = (p: Part) => rod(p, liftTop, onBoom(BOOM_END.x + 0.04, BOOM_END.y + 0.05, st.boom), 0.0035, 4, COL.line);
  const segLift = dyn.gen(liftBuild);
  const msBlock = () => onBoom(MS_BOOM_X, boomY(MS_BOOM_X) - 0.13, st.boom);
  const carZ = () => clamp(msBlock().z, -TRAVELLER_HW, TRAVELLER_HW);
  const msBuild = (p: Part) => {
    const top = msBlock();
    const car = V(TRAVELLER_X, travellerY() + 0.07, carZ());
    for (const dx of [-0.014, 0, 0.014]) rod(p, top.clone().add(V(dx, 0, 0)), car.clone().add(V(dx * 1.2, 0, 0)), 0.0045, 4, COL.sheet);
  };
  const segMainsheet = dyn.gen(msBuild);
  const segCar = dyn.rigid((p) => {
    const y = travellerY();
    p.add(roundedBox(0.07, 0.025, 0.07, 0.01), COL.dark, M(TRAVELLER_X, y + 0.02, 0));
    p.add(roundedBox(0.045, 0.05, 0.04, 0.016), COL.dark, M(TRAVELLER_X, y + 0.055, 0));
  });
  const segRode = dyn.rigid(anchorLine);
  const segAnchor = dyn.rigid(stowedAnchor);
  const dynGeom = dyn.part.geometry();
  dyn.bind(dynGeom);
  dynGeom.boundingSphere = new THREE.Sphere(V(2.4, 3.8, 0), 10.5);
  const dynMesh = new THREE.Mesh(dynGeom, clothMat);
  dynMesh.name = 'sloop-rig-lines';

  // Sails.
  sailTexture ??= paintSail();
  const sailMat = new THREE.MeshStandardMaterial({ map: sailTexture, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  const sailMesh = new THREE.Mesh(sails.geometry, sailMat);
  sailMesh.name = 'sloop-sails';

  // Rudder and tiller: one mesh turned about the raked rudder stock.
  const rudderMesh = new THREE.Mesh(rudderPart.geometry(), rudderMaterial(varnishTex));
  rudderMesh.name = 'sloop-rudder';
  rudderMesh.matrixAutoUpdate = false;
  const rudderMatrix = (a: number, sign: number) => {
    const p = rudderInfo.axisPoint;
    return new THREE.Matrix4()
      .makeTranslation(p.x, p.y, p.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(rudderInfo.axisDir, sign * a))
      .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
  };
  const rudderSign = rudderInfo.trailingEdge.clone().applyMatrix4(rudderMatrix(0.3, 1)).z > 0 ? 1 : -1;

  for (const m of [boomMesh, dynMesh, sailMesh, rudderMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }

  // --- Applying the state.
  const boomM = () => boomMatrix(st.boom);
  const applyFurl = () => {
    dyn.place(segCover, st.sail < 0.01 ? boomM() : null);
    if (st.sail >= 0.01 && st.sail < 0.985) {
      const k = Math.pow(1 - st.sail, 0.85);
      const yb = GOOSE_Y + 0.06;
      const m = boomM()
        .multiply(new THREE.Matrix4().makeTranslation(0, yb, 0))
        .multiply(new THREE.Matrix4().makeScale(1, Math.max(0.05, k), 0.55 + 0.45 * k))
        .multiply(new THREE.Matrix4().makeTranslation(0, -yb, 0));
      dyn.place(segBundle, m);
    } else dyn.hide(segBundle);
    dyn.regen(segLift, liftBuild, st.sail < 0.03);
  };
  const applyMainsheet = () => {
    dyn.regen(segMainsheet, msBuild);
    dyn.place(segCar, new THREE.Matrix4().makeTranslation(0, 0, carZ()));
  };
  const applySheets = () => {
    dyn.regen(segSheets[0], sheetBuild(-1));
    dyn.regen(segSheets[1], sheetBuild(1));
  };
  const applyAnchor = () => {
    dyn.place(segRode, st.anchored ? new THREE.Matrix4() : null);
    dyn.place(segAnchor, st.anchored ? null : new THREE.Matrix4());
  };
  const applySails = () => {
    sails.update(st);
    sailMesh.visible = st.sail > 0.005;
  };
  const applyBoom = () => {
    boomGroup.rotation.y = st.boom;
    boomGroup.updateMatrix();
  };
  const applyRudder = () => {
    rudderMesh.matrix.copy(rudderMatrix(st.rudder, rudderSign));
    rudderMesh.matrixWorldNeedsUpdate = true;
  };
  applyFurl();
  applyMainsheet();
  applySheets();
  applyAnchor();
  applySails();
  applyBoom();
  applyRudder();

  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const rig: SloopRig = {
    setSail(amount) {
      const a = clamp(amount, 0, 1);
      if (same(a, st.sail)) return;
      st.sail = a;
      applySails();
      applyFurl();
      dyn.regen(segRoll, (p) => jibRoll(p, st.sail));
      applySheets();
    },
    setBoom(angle) {
      const a = clamp(angle, -BOOM_MAX, BOOM_MAX);
      if (same(a, st.boom)) return;
      st.boom = a;
      applyBoom();
      applyFurl();
      applyMainsheet();
      if (st.sail > 0.005) applySails();
    },
    setJib(angle) {
      const a = clamp(angle, -JIB_MAX, JIB_MAX);
      if (same(a, st.jib)) return;
      st.jib = a;
      applySails();
      applySheets();
    },
    setFill(fill, time) {
      const f = clamp(fill, 0, 1);
      const changed = !same(f, st.fill) || (f < 0.6 && !same(time, st.time));
      st.fill = f;
      st.time = time;
      if (changed && st.sail > 0.005) applySails();
    },
    setRudder(angle) {
      const a = clamp(angle, -RUDDER_MAX, RUDDER_MAX);
      if (same(a, st.rudder)) return;
      st.rudder = a;
      applyRudder();
    },
    setAnchored(down) {
      if (down === st.anchored) return;
      st.anchored = down;
      applyAnchor();
    },
    status() {
      const rm = rudderMatrix(st.rudder, rudderSign);
      return {
        sail: st.sail,
        boom: st.boom,
        jib: st.jib,
        fill: st.fill,
        rudder: st.rudder,
        anchored: st.anchored,
        coverShown: st.sail < 0.01,
        mainShown: st.sail > 0.005,
        jibShown: st.sail > 0.005,
        rodeShown: st.anchored,
        anchorStowedShown: !st.anchored,
        boomEnd: onBoom(BOOM_END.x, BOOM_END.y, st.boom),
        mainHead: sails.mainHead.clone(),
        jibClew: sails.jibClew.clone(),
        rudderTrailingEdge: rudderInfo.trailingEdge.clone().applyMatrix4(rm),
        tillerEnd: rudderInfo.tillerEnd.clone().applyMatrix4(rm),
      };
    },
  };
  const triangles = (boomPart.idx.length + dyn.part.idx.length + rudderPart.idx.length) / 3 + sails.triangles;
  return { objects: [boomGroup, dynMesh, sailMesh, rudderMesh], rig, triangles };
}

/** The painted sailcloth is made once and shared. */
let sailTexture: THREE.DataTexture | null = null;

// ============================================================ materials

/** GLSL: the hull's paint at boat-local vBoatPos -> hc (colour) and hBottom (1 on the antifouling). */
function hullBandGlsl(): string {
  const lin = (hex: number) => {
    const c = new THREE.Color(hex);
    return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
  };
  const f = (n: number) => n.toFixed(4);
  return `  float hy = vBoatPos.y;
  float aa = max(fwidth(hy), 0.0008);
  float ht = (clamp(vBoatPos.x, ${f(X_AFT)}, ${f(X_FWD)}) - ${f(X_AFT)}) / ${f(LOA)};
  float hsheer = ht < 0.42 ? 0.78 + 0.45 * (0.42 - ht) * (0.42 - ht) : 0.78 + 0.6 * (ht - 0.42) * (ht - 0.42);
  float hdown = hsheer - hy;
  float hBottom = 1.0 - smoothstep(0.035 - aa, 0.035 + aa, hy);
  float hBoot = smoothstep(0.035 - aa, 0.035 + aa, hy) - smoothstep(0.125 - aa, 0.125 + aa, hy);
  float hCove = smoothstep(0.08 - aa, 0.08 + aa, hdown) - smoothstep(0.104 - aa, 0.104 + aa, hdown);
  vec3 hc = ${lin(COL.hull)};
  hc = mix(hc, ${lin(COL.stripe)}, clamp(hBoot + hCove, 0.0, 1.0));
  hc = mix(hc, ${lin(COL.bottom)}, hBottom);`;
}

function hullMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vBoatPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBoatPos = transformed;');
    sh.fragmentShader =
      'varying vec3 vBoatPos;\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
${hullBandGlsl()}
  diffuseColor.rgb *= hc;`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.75, hBottom);');
  };
  mat.customProgramCacheKey = () => 'sloop-hull-v1';
  return mat;
}

// ============================================================ assembly

/** The painted textures are made once and shared by every sloop built. */
let textures: { teak: THREE.DataTexture; varnish: THREE.DataTexture; nonskid: THREE.DataTexture } | null = null;

/** Everything createSloop() makes. */
export interface Sloop {
  group: THREE.Group;
  deck: DeckSurface;
  points: SloopPoints;
  length: number;
  beam: number;
  draft: number;
  triangles: number;
  /** Sail, boom, jib, rudder and anchor controls. */
  rig: SloopRig;
}

export function createSloop(): Sloop {
  const hull = new Part();
  const rudder = new Part();
  const gel = new Part();
  const teak = new Part();
  const varnish = new Part();
  const metal = new Part();
  const cloth = new Part();
  const nonskid = new Part();

  buildHull(hull);
  const rudderInfo = buildKeelAndRudder(hull, rudder, metal);
  buildDeck(teak);
  buildRails(varnish);
  buildCockpit(gel, teak, varnish, metal);
  buildTrunk(gel, nonskid, varnish, metal);
  buildRig(metal, cloth);
  buildLifelines(metal, cloth);
  buildFittings(metal, cloth, varnish);

  textures ??= { teak: paintTeak(), varnish: paintVarnish(), nonskid: paintNonSkid() };
  const teakTex = textures.teak;
  const varnishTex = textures.varnish;
  const mats: [Part, THREE.Material, string][] = [
    [hull, hullMaterial(), 'sloop-hull'],
    [gel, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 }), 'sloop-gelcoat'],
    [nonskid, new THREE.MeshStandardMaterial({ map: textures.nonskid, roughness: 0.7, metalness: 0 }), 'sloop-nonskid'],
    [teak, new THREE.MeshStandardMaterial({ vertexColors: true, map: teakTex, roughness: 0.8, metalness: 0 }), 'sloop-teak'],
    [varnish, new THREE.MeshStandardMaterial({ vertexColors: true, map: varnishTex, roughness: 0.3, metalness: 0 }), 'sloop-varnish'],
    [metal, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.85 }), 'sloop-metal'],
    [cloth, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }), 'sloop-cloth'],
  ];
  const group = new THREE.Group();
  group.name = 'sloop';
  let triangles = 0;
  for (const [part, mat, name] of mats) {
    const mesh = new THREE.Mesh(part.geometry(), mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    triangles += part.idx.length / 3;
  }
  const metalMat = mats.find((m) => m[2] === 'sloop-metal')?.[1] as THREE.Material;
  const clothMat = mats.find((m) => m[2] === 'sloop-cloth')?.[1] as THREE.Material;
  const moving = buildMovingRig(metalMat, clothMat, varnishTex, rudder, rudderInfo);
  for (const o of moving.objects) group.add(o);
  triangles += moving.triangles;

  const deck: DeckSurface = {
    heightAt,
    blocked,
    insideLifelines,
    halfBeam: (lx: number, atDeck: boolean) => (atDeck ? deckHalfBeam(lx) : waterlineHalfBeam(lx)),
    sternGap: { x: X_AFT, z0: GAP_Z0, z1: GAP_Z1 },
  };
  const potY = (x: number, z: number) => cabinTop(x, z) + 0.02;
  const pz = (TRAY_Z0 + TRAY_Z1) / 2;
  const points: SloopPoints = {
    ladderTop: V(X_AFT + 0.1, deckY(X_AFT + 0.1, LADDER_Z), LADDER_Z),
    ladderBottom: V(-4.42, -0.5, LADDER_Z),
    locker: V(-2.7, BENCH_Y, -0.72),
    helm: V(-3.2, SOLE_Y, 0.3),
    bow: V(4.37, 1.05, 0),
    mastBase: V(MAST_X, cabinTop(MAST_X, 0), 0),
    potShelf: [V(-1.45, potY(-1.45, -pz), -pz), V(-1.21, potY(-1.21, -pz), -pz), V(-1.45, potY(-1.45, pz), pz), V(-1.21, potY(-1.21, pz), pz)],
    spawn: V(-2.75, SOLE_Y, 0),
  };
  return { group, deck, points, length: LOA, beam: HALF_BEAM * 2, draft: DRAFT, triangles, rig: moving.rig };
}
