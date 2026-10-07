/**
 * The plant construction kit (WP-F): six little shapes that every plant is made from, all built
 * in code with vertex colours (look-and-sound §4.1). The archetypes in plants.ts combine them.
 *
 *   tube     a tapered stem, trunk, branch or root along a path (4-6 sides)
 *   strip    a frond or strap leaf with an optional folded midrib and saw-toothed edge
 *   blade    a grass blade (1 or 3 triangles)
 *   blob     a crown puff (octahedron or icosahedron, lumpy, soft normals); dome, its low cousin
 *   fan      a round leaf, petal ring, pad or flower cup
 *   rosette  radial copies of any of the above
 *
 * Colour is not baked per species. Each vertex says WHICH palette colour it takes (its part:
 * trunk, leaf, flower, fruit, or its own fixed colour), how far toward the second leaf colour it
 * leans (tone), and a brightness (shade). The plant shader looks the species colours up per
 * instance, so one geometry serves every species of an archetype and draw calls stay low.
 *
 * Every vertex also carries what the animations need:
 *   sway     how much the trunk bend moves it (0 at the base)
 *   flutter  leaf jitter along the normal
 *   grow     0..1 order from base to tips (the pop reveals the plant bottom-up by it)
 *   attach   where its leaf or branch joins the parent (leaves unfurl from it), plus how that
 *            join rides up on the growing parent during the pop (see `Ride`)
 *
 * Triangles are either CLOSED (tubes, puffs, domes, lenses: you only ever see their outside) or
 * THIN (leaves, blades, petals: seen from both sides). A plant made mostly of closed shapes is
 * drawn front faces only, with its few thin pieces given a second, reversed copy; a leafy plant
 * is drawn double-sided. Either way the hidden back faces of a crown are never shaded.
 */
import * as THREE from 'three';

export type V3 = [number, number, number];

/** Which palette colour a vertex takes. `Own` uses the vertex's own fixed colour. */
export const Part = { Trunk: 0, Leaf: 1, Flower: 2, Fruit: 3, Own: 4 } as const;
export type Part = (typeof Part)[keyof typeof Part];

/** A number, or a function of t (0 base .. 1 tip along the piece) and u (0..1 around or across it). */
export type Ramp = number | ((t: number, u: number) => number);

/** How a piece is painted and animated. */
export interface Paint {
  part: Part;
  /** 0..1. Leaves: leaf -> leaf2. Trunks: bark -> moss (leaf2). */
  tone?: Ramp;
  /** Brightness multiplier on the palette colour (1 = as is). */
  shade?: Ramp;
  /** sRGB hex for Part.Own pieces. */
  own?: number;
  /** 0..1 leaf jitter. */
  flutter?: Ramp;
  /** Reveal order at the base and the tip of this piece. */
  grow?: [number, number];
  /** Where this piece joins its parent (default: its own base). */
  attach?: V3;
  /** How the join rides on its growing parent during the pop (default: it stays put). */
  ride?: Ride;
}

/**
 * During the pop every piece is revealed outward from its join while its parent is still being
 * revealed itself, so a join on a trunk has to move up with the trunk (or crowns and fronds would
 * hang in the air above a trunk that is still growing). Trunks grow out of the plant's root at the
 * origin. A piece on a trunk gives the trunk's reveal order (`grow`) at its join. A piece on a
 * branch also gives where that branch joins the trunk (`hub`) and the trunk's order there
 * (`hubGrow`); a hub without `hubGrow` stays put (a branch rooted in the ground, a flower spike).
 */
export interface Ride {
  grow: number;
  hub?: V3;
  hubGrow?: number;
}

/** The reveal order of a join that never moves (the shader's reveal of anything below 0 is 1). */
export const FIXED = -1;

// ---------- small vector helpers (build time only) ----------

export function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a: V3, s: number): V3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function len(a: V3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function norm(a: V3): V3 {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}
function lerp3(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** Rotate v about a unit axis k by angle a (Rodrigues). */
export function rotate(v: V3, k: V3, a: number): V3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const kv = cross(k, v);
  const d = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}
/** Unit direction from an azimuth (radians around y, 0 = +x) and an elevation above the horizon. */
export function dirFrom(azimuth: number, elevation: number): V3 {
  const ce = Math.cos(elevation);
  return [Math.cos(azimuth) * ce, Math.sin(elevation), Math.sin(azimuth) * ce];
}
/** A unit vector perpendicular to d (prefers a horizontal one). */
export function perpendicular(d: V3): V3 {
  const side = cross(d, [0, 1, 0]);
  return len(side) > 1e-4 ? norm(side) : norm(cross(d, [1, 0, 0]));
}

function ramp(r: Ramp | undefined, t: number, u: number, def: number): number {
  if (r === undefined) return def;
  return typeof r === 'number' ? r : r(t, u);
}

const tmpColor = new THREE.Color();

/** Sway weight of one vertex, from its position and where its piece attaches. */
export type SwayFn = (p: V3, attach: V3, part: Part) => number;

/**
 * Collects vertices and triangles for one plant model. Primitives append to it; `finish` turns it
 * into a BufferGeometry with every attribute the plant shader reads.
 */
export class PlantBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  /** per vertex: flutter, grow, part + tone * 0.98 (sway is filled in by finish) */
  private trait: number[] = [];
  /** per vertex: attach xyz + the parent's reveal order there */
  private att: number[] = [];
  /** per vertex: where the parent joins the trunk xyz + the trunk's reveal order there */
  private hub: number[] = [];
  private idx: number[] = [];
  /** Per triangle: 1 = thin (seen from both sides), 0 = part of a closed shape. */
  private thin: number[] = [];
  /** Vertices whose normals come from their triangles (true) or were set by the primitive (false). */
  private autoN: boolean[] = [];
  /** How much each auto normal is bent toward "up" (soft foliage lighting). */
  private soften: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  /** Add one vertex. n = null means "work the normal out from the triangles". */
  vertex(p: V3, n: V3 | null, paint: Paint, t: number, u: number, attach: V3, soft = 0): number {
    const i = this.vertexCount;
    this.pos.push(p[0], p[1], p[2]);
    if (n) this.nrm.push(n[0], n[1], n[2]);
    else this.nrm.push(0, 0, 0);
    this.autoN.push(!n);
    this.soften.push(soft);
    const shade = ramp(paint.shade, t, u, 1);
    if (paint.part === Part.Own) {
      tmpColor.setHex(paint.own ?? 0xffffff);
      this.col.push(tmpColor.r * shade, tmpColor.g * shade, tmpColor.b * shade);
    } else {
      this.col.push(shade, shade, shade);
    }
    const tone = Math.max(0, Math.min(1, ramp(paint.tone, t, u, 0)));
    const g = paint.grow ?? [0, 1];
    this.trait.push(ramp(paint.flutter, t, u, 0), g[0] + (g[1] - g[0]) * t, paint.part + tone * 0.98);
    const a = paint.attach ?? attach;
    const r = paint.ride;
    this.att.push(a[0], a[1], a[2], r ? r.grow : FIXED);
    const h = r ? (r.hub ?? [0, 0, 0]) : a;
    this.hub.push(h[0], h[1], h[2], r?.hubGrow ?? FIXED);
    return i;
  }

  /** Add a triangle (counter-clockwise seen from its front). `thin` pieces are seen from both sides. */
  tri(a: number, b: number, c: number, thin: boolean): void {
    this.idx.push(a, b, c);
    this.thin.push(thin ? 1 : 0);
  }

  /** Build the geometry. `sway` gives each vertex its trunk-bend weight; `sideOf` says how to draw it. */
  finish(sway: SwayFn): THREE.BufferGeometry {
    const nv = this.vertexCount;
    // Normals from triangles for the pieces that asked for it.
    const acc = new Float32Array(nv * 3);
    const P = this.pos;
    for (let i = 0; i < this.idx.length; i += 3) {
      const a = this.idx[i];
      const b = this.idx[i + 1];
      const c = this.idx[i + 2];
      const e1: V3 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const e2: V3 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      const fn = cross(e1, e2);
      for (const v of [a, b, c]) {
        acc[v * 3] += fn[0];
        acc[v * 3 + 1] += fn[1];
        acc[v * 3 + 2] += fn[2];
      }
    }
    const normal = new Float32Array(nv * 3);
    const plant = new Float32Array(nv * 4);
    for (let v = 0; v < nv; v++) {
      let n: V3 = this.autoN[v] ? norm([acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]]) : [this.nrm[v * 3], this.nrm[v * 3 + 1], this.nrm[v * 3 + 2]];
      const s = this.soften[v];
      if (s > 0) n = norm(lerp3(n, [0, 1, 0], s));
      normal[v * 3] = n[0];
      normal[v * 3 + 1] = n[1];
      normal[v * 3 + 2] = n[2];
      const p: V3 = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
      const at: V3 = [this.att[v * 4], this.att[v * 4 + 1], this.att[v * 4 + 2]];
      const part = Math.floor(this.trait[v * 3 + 2] + 1e-3) as Part;
      plant[v * 4] = sway(p, at, part);
      plant[v * 4 + 1] = this.trait[v * 3];
      plant[v * 4 + 2] = this.trait[v * 3 + 1];
      plant[v * 4 + 3] = this.trait[v * 3 + 2];
    }
    // Front faces only when thin pieces are a small share: they get a reversed second copy on the
    // same vertices, so both faces sway, flutter and light as one leaf. Leafy plants stay double-sided.
    let nThin = 0;
    for (const t of this.thin) nThin += t;
    const front = nThin <= FRONT_SIDE_THIN_SHARE * this.thin.length;
    const index = this.idx.slice();
    if (front) {
      for (let f = 0; f < this.thin.length; f++) if (this.thin[f]) index.push(this.idx[f * 3], this.idx[f * 3 + 2], this.idx[f * 3 + 1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aPlant', new THREE.BufferAttribute(plant, 4));
    g.setAttribute('aAttach', new THREE.Float32BufferAttribute(this.att, 4));
    g.setAttribute('aHub', new THREE.Float32BufferAttribute(this.hub, 4));
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    g.computeBoundingSphere();
    g.userData.side = front ? THREE.FrontSide : THREE.DoubleSide;
    return g;
  }
}

/**
 * A plant whose thin pieces are at most this share of its triangles is drawn front faces only:
 * doubling those few pieces costs less than shading every hidden back face of its trunk and crown.
 */
const FRONT_SIDE_THIN_SHARE = 0.3;

/** How a finished plant geometry is drawn: FrontSide (mostly closed shapes) or DoubleSide (leafy). */
export function sideOf(g: THREE.BufferGeometry): THREE.Side {
  return g.userData.side === THREE.FrontSide ? THREE.FrontSide : THREE.DoubleSide;
}

// ---------- the six shapes ----------

/**
 * A tapered tube along a path. `radii` has one radius per path point; a final radius of 0 closes
 * the tip to a point. Normals point straight out from the path, so trunks shade round.
 * Triangles: (points - 1) * sides * 2, or one ring fewer plus `sides` when the tip is closed.
 */
export function tube(b: PlantBuilder, path: V3[], radii: number[], sides: number, paint: Paint, flatten = 1): void {
  const n = path.length;
  const tipClosed = radii[n - 1] <= 1e-6;
  const attach = path[0];
  // Parallel-transport frames so the rings never twist.
  let tan = norm(sub(path[1], path[0]));
  let side = perpendicular(tan);
  const rings: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    if (i > 0) {
      const nt = norm(sub(path[Math.min(n - 1, i + 1)], path[i - 1]));
      const axis = cross(tan, nt);
      const al = len(axis);
      if (al > 1e-6) side = norm(rotate(side, scale(axis, 1 / al), Math.asin(Math.min(1, al))));
      tan = nt;
    }
    const up = cross(tan, side);
    if (i === n - 1 && tipClosed) {
      rings.push(b.vertex(path[i], tan, paint, t, 0, attach));
      continue;
    }
    const start = b.vertexCount;
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a) * flatten;
      const dir: V3 = norm(add(scale(side, c), scale(up, s)));
      const nn: V3 = norm(add(scale(side, c * flatten), scale(up, Math.sin(a))));
      b.vertex(add(path[i], scale(dir, radii[i] * Math.hypot(c, s))), nn, paint, t, j / sides, attach);
    }
    rings.push(start);
  }
  for (let i = 0; i < n - 1; i++) {
    const r0 = rings[i];
    const r1 = rings[i + 1];
    if (i === n - 2 && tipClosed) {
      for (let j = 0; j < sides; j++) b.tri(r0 + j, r0 + ((j + 1) % sides), r1, false);
      continue;
    }
    // Wound counter-clockwise seen from outside, so the outward normals face the viewer.
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      b.tri(r0 + j, r0 + j1, r1 + j, false);
      b.tri(r0 + j1, r1 + j1, r1 + j, false);
    }
  }
}

export interface StripOpts {
  base: V3;
  /** Initial direction (unit). */
  dir: V3;
  len: number;
  segs: number;
  /** Half-width at t (0 base .. 1 tip). A 0 at t = 1 closes the tip. */
  width: (t: number) => number;
  /** Total downward curl over the length (radians, about the side axis). */
  bend?: number;
  /** Bend distribution exponent (>1 = the tip bends most). */
  bendPow?: number;
  /** Midrib fold: edges raised (+) or dropped (-) by fold * width. 0 = flat strip. */
  fold?: number;
  /** Saw-toothed edge: odd rows are (1 - zig) as wide (fern pinnae, palm leaflets). */
  zig?: number;
  /** Roll the leaf about its own axis (radians). */
  roll?: number;
  paint: Paint;
  soft?: number;
}

/**
 * A frond or strap leaf: a ribbon that curves down as it goes. Folded strips have three vertices
 * per row (edge, midrib, edge: 4 triangles per segment); flat ones two (2 per segment).
 */
export function strip(b: PlantBuilder, o: StripOpts): void {
  const fold = o.fold ?? 0;
  const folded = Math.abs(fold) > 1e-6;
  let dir = norm(o.dir);
  let side = perpendicular(dir);
  if (o.roll) side = rotate(side, dir, o.roll);
  const bend = o.bend ?? 0;
  const bp = o.bendPow ?? 1.5;
  const step = o.len / o.segs;
  let p = o.base;
  let prevAngle = 0;
  const rows: number[][] = [];
  for (let s = 0; s <= o.segs; s++) {
    const t = s / o.segs;
    if (s > 0) {
      p = add(p, scale(dir, step));
      const ang = bend * Math.pow(t, bp);
      dir = norm(rotate(dir, side, -(ang - prevAngle)));
      prevAngle = ang;
    }
    const zig = s % 2 === 1 ? 1 - (o.zig ?? 0) : 1;
    const w = o.width(t) * zig;
    const nrm = norm(cross(side, dir));
    if (w <= 1e-6) {
      rows.push([b.vertex(p, null, o.paint, t, 0.5, o.base, o.soft ?? 0)]);
      continue;
    }
    const lift = scale(nrm, fold * w);
    const left = add(add(p, scale(side, -w)), lift);
    const right = add(add(p, scale(side, w)), lift);
    if (folded) {
      rows.push([
        b.vertex(left, null, o.paint, t, 0, o.base, o.soft ?? 0),
        b.vertex(p, null, o.paint, t, 0.5, o.base, o.soft ?? 0),
        b.vertex(right, null, o.paint, t, 1, o.base, o.soft ?? 0),
      ]);
    } else {
      rows.push([b.vertex(left, null, o.paint, t, 0, o.base, o.soft ?? 0), b.vertex(right, null, o.paint, t, 1, o.base, o.soft ?? 0)]);
    }
  }
  for (let s = 0; s < rows.length - 1; s++) {
    const r0 = rows[s];
    const r1 = rows[s + 1];
    if (r0.length === 1) {
      // Pointed base (a diamond leaf): fan out from the point.
      for (let k = 0; k < r1.length - 1; k++) b.tri(r0[0], r1[k + 1], r1[k], true);
      continue;
    }
    if (r1.length === 1) {
      // Closing tip: fan to the point.
      for (let k = 0; k < r0.length - 1; k++) b.tri(r0[k], r0[k + 1], r1[0], true);
      continue;
    }
    // Wound so the face normal is side x dir: "up" on a level leaf.
    for (let k = 0; k < r0.length - 1; k++) {
      b.tri(r0[k], r0[k + 1], r1[k], true);
      b.tri(r0[k + 1], r1[k + 1], r1[k], true);
    }
  }
}

/**
 * A grass blade from `base`, leaning toward `azimuth`. segs 1 = one triangle, 2 = a bent blade
 * of three triangles. Normals lean toward the sky so tufts read soft and bright.
 */
export function blade(b: PlantBuilder, base: V3, azimuth: number, h: number, w: number, lean: number, segs: 1 | 2, paint: Paint): void {
  const d: V3 = [Math.cos(azimuth), 0, Math.sin(azimuth)];
  const side: V3 = [-d[2], 0, d[0]];
  const tip = add(base, [d[0] * lean * h, h, d[2] * lean * h]);
  const bl = b.vertex(add(base, scale(side, -w)), null, paint, 0, 0, base, 0.55);
  const br = b.vertex(add(base, scale(side, w)), null, paint, 0, 1, base, 0.55);
  if (segs === 1) {
    const tp = b.vertex(tip, null, paint, 1, 0.5, base, 0.55);
    b.tri(bl, tp, br, true);
    return;
  }
  const mid = add(base, [d[0] * lean * h * 0.3, h * 0.55, d[2] * lean * h * 0.3]);
  const ml = b.vertex(add(mid, scale(side, -w * 0.7)), null, paint, 0.55, 0, base, 0.55);
  const mr = b.vertex(add(mid, scale(side, w * 0.7)), null, paint, 0.55, 1, base, 0.55);
  const tp = b.vertex(tip, null, paint, 1, 0.5, base, 0.55);
  b.tri(bl, ml, br, true);
  b.tri(br, ml, mr, true);
  b.tri(ml, tp, mr, true);
}

// Unit octahedron and icosahedron (shared vertices, so blobs shade smooth).
const OCTA_V: V3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
const OCTA_F = [2, 4, 0, 2, 0, 5, 2, 5, 1, 2, 1, 4, 3, 0, 4, 3, 5, 0, 3, 1, 5, 3, 4, 1];
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V: V3[] = (
  [
    [-1, PHI, 0],
    [1, PHI, 0],
    [-1, -PHI, 0],
    [1, -PHI, 0],
    [0, -1, PHI],
    [0, 1, PHI],
    [0, -1, -PHI],
    [0, 1, -PHI],
    [PHI, 0, -1],
    [PHI, 0, 1],
    [-PHI, 0, -1],
    [-PHI, 0, 1],
  ] as V3[]
).map(norm);
const ICO_F = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9,
  5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
];

/**
 * A crown puff: an ellipsoid made from an octahedron (8 triangles) or an icosahedron (20),
 * pushed in and out by `lump` (deterministic from `seed`). Normals blend the puff's own with the
 * direction from the whole crown's centre (`crown`), and lean a little toward the sky, so the
 * puffs of one crown shade together as one soft rounded mass instead of flat facets.
 * Tone runs bottom (0) to top (1).
 */
export function blob(b: PlantBuilder, centre: V3, r: V3, kind: 'octa' | 'ico', lump: number, seed: number, paint: Paint, crown: V3 = centre): void {
  const verts = kind === 'octa' ? OCTA_V : ICO_V;
  const faces = kind === 'octa' ? OCTA_F : ICO_F;
  const base = b.vertexCount;
  const attach = paint.attach ?? centre;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const k = 1 + lump * (hash1(seed * 31 + i * 7.13) - 0.5) * 2;
    const p: V3 = [centre[0] + v[0] * r[0] * k, centre[1] + v[1] * r[1] * k, centre[2] + v[2] * r[2] * k];
    const own = norm([v[0] / r[0], v[1] / r[1], v[2] / r[2]]);
    const whole = norm(sub(p, crown));
    const n = norm(add(add(scale(own, 0.45), scale(whole, 0.55)), [0, 0.3, 0]));
    const t = (v[1] + 1) / 2;
    b.vertex(p, n, { ...paint, attach }, t, i / verts.length, attach);
  }
  for (let f = 0; f < faces.length; f += 3) b.tri(base + faces[f], base + faces[f + 1], base + faces[f + 2], false);
}

/**
 * A low dome (brain coral, cushion): `sides` around, one middle ring and a top point.
 * Triangles: 3 * sides.
 */
export function dome(b: PlantBuilder, centre: V3, r: number, h: number, sides: number, seed: number, paint: Paint): void {
  const ring0: number[] = [];
  const ring1: number[] = [];
  for (let j = 0; j < sides; j++) {
    const a = (j / sides) * Math.PI * 2;
    const k = 1 + 0.12 * (hash1(seed + j * 3.1) - 0.5);
    const c = Math.cos(a);
    const s = Math.sin(a);
    ring0.push(b.vertex([centre[0] + c * r * k, centre[1], centre[2] + s * r * k], norm([c, 0.25, s]), paint, 0, j / sides, centre));
  }
  for (let j = 0; j < sides; j++) {
    const a = ((j + 0.5) / sides) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ring1.push(b.vertex([centre[0] + c * r * 0.72, centre[1] + h * 0.72, centre[2] + s * r * 0.72], norm([c, 1.1, s]), paint, 0.6, j / sides, centre));
  }
  const top = b.vertex([centre[0], centre[1] + h, centre[2]], [0, 1, 0], paint, 1, 0.5, centre);
  for (let j = 0; j < sides; j++) {
    const j1 = (j + 1) % sides;
    b.tri(ring0[j], ring1[j], ring0[j1], false);
    b.tri(ring0[j1], ring1[j], ring1[j1], false);
    b.tri(ring1[j], top, ring1[j1], false);
  }
}

export interface FanOpts {
  centre: V3;
  /** The fan's facing (unit). */
  normal: V3;
  /** Direction in the fan's plane where the arc starts (unit, perpendicular to normal). */
  start: V3;
  r: number;
  n: number;
  /** Arc in radians (2 PI = closed disc). */
  arc?: number;
  /** Rim lifted along the normal by cup * r (a bowl), or dropped if negative. */
  cup?: number;
  /** Odd rim points are (1 - zig) as far out: petals. */
  zig?: number;
  /** Stretch along `start` (1 = round): leaves and pads are longer than wide. */
  stretch?: number;
  /** Shift the centre point along the normal (a dome or a cone). */
  peak?: number;
  /** One face of a closed shape (a lens, a plate's top or bottom): never seen from behind. */
  solid?: boolean;
  paint: Paint;
}

/** A round leaf, pad, petal ring or flower cup. Triangles: n. */
export function fan(b: PlantBuilder, o: FanOpts): void {
  const arc = o.arc ?? Math.PI * 2;
  const closed = arc >= Math.PI * 2 - 1e-6;
  const nRim = closed ? o.n : o.n + 1;
  const other = norm(cross(o.normal, o.start));
  const c = b.vertex(add(o.centre, scale(o.normal, (o.peak ?? 0) * o.r)), null, o.paint, 0, 0.5, o.paint.attach ?? o.centre);
  const rim: number[] = [];
  for (let j = 0; j < nRim; j++) {
    const a = (j / o.n) * arc - (closed ? 0 : arc / 2);
    const k = j % 2 === 1 ? 1 - (o.zig ?? 0) : 1;
    const st = o.stretch ?? 1;
    const pa = add(scale(o.start, Math.cos(a) * o.r * k * st), scale(other, Math.sin(a) * o.r * k));
    const p = add(add(o.centre, pa), scale(o.normal, (o.cup ?? 0) * o.r * k));
    rim.push(b.vertex(p, null, o.paint, 1, j / nRim, o.paint.attach ?? o.centre));
  }
  for (let j = 0; j < o.n; j++) {
    const j1 = closed ? (j + 1) % nRim : j + 1;
    b.tri(c, rim[j], rim[j1], !o.solid);
  }
}

/** Radial copies: calls fn(i, angle) for i = 0..n-1 with evenly spread angles (plus a phase). */
export function rosette(n: number, phase: number, fn: (i: number, angle: number) => void): void {
  for (let i = 0; i < n; i++) fn(i, phase + (i / n) * Math.PI * 2);
}

/** Deterministic 0..1 hash of a number (build-time jitter, no Math.random). */
function hash1(x: number): number {
  let h = Math.imul(Math.floor(x * 1000.3) | 0, 0x27d4eb2d) ^ 0x165667b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A tiny seeded random sequence for model building. */
export function seq(seed: number): () => number {
  let i = 0;
  return () => hash1(seed * 97.13 + i++ * 13.37);
}
