/**
 * Animal body plans, made in code (WP-F2), plus the one shared creature material and the soft
 * point sprites (far seabird specks, fireflies, splashes, mist, motes).
 *
 * How a creature is drawn:
 * - Every body plan in `AnimalModel` is a small low-poly mesh built here from a few tubes and flat
 *   panels, at a normalised size of 1 = the species' body length (`SpeciesDef.animal.size`).
 *   Axes: +z is forward (the head), +y is up, +x is the animal's right side. Walkers and birds have
 *   their feet at y = 0; swimmers are centred on y = 0.
 * - Nothing has a skeleton. Each vertex carries a "rig": which PART it belongs to (wing, leg, head,
 *   tail, fin...), where along that part it sits (`s`, 0 at the root to 1 at the tip), which side
 *   (+1 right, -1 left), and the part's pivot. The vertex shader bends parts from four numbers per
 *   animal (`iAnim`): a gait clock (phase), how big the movement is (amp), a pose blend (fold) and one
 *   extra action (aux). One shader moves every body plan, so it is one shader program for all animals.
 * - Colour comes from the species: each vertex says how much of the species' primary, secondary and
 *   accent colour it takes (`aPaint`); the three colours are per animal (`iCol`, packed 0xRRGGBB).
 *   The slot convention per body plan is listed in `SLOT_GUIDE` below so the catalogue can match it.
 * - Fine patterns (ray spots, butterfly veins, turtle scutes, bee bands, snail spirals) are
 *   computed in the fragment shader from the vertex's rest position, so they cost no triangles.
 *
 * Instances are packed as four small vectors (position+scale, rotation quaternion, animation, colours),
 * never 64-byte matrices (ARCHITECTURE §6.6). Everything here runs once at load; the per-frame work is
 * filling typed arrays in `CreatureBatch` and `SoftPoints`, with no allocations.
 */
import * as THREE from 'three';
import { AnimalModel, ANIMAL_MODEL_COUNT } from '../../content/speciesTypes';
import { WORLD_UNIFORMS_GLSL, addWorldUniforms, type WorldUniforms } from '../shared';

// ---------- the rig vocabulary (shared with the vertex shader) ----------

/** Which part of the body a vertex belongs to; the vertex shader moves each part differently. */
export const Part = {
  /** Rigid body. */
  Body: 0,
  /** Bird or bat wing: flaps about the body axis (the outer wing lags, for a natural whip); `fold` sweeps it back along the flank. */
  Wing: 1,
  /** Leg: |side| 1 = sprawled (crabs, lizards, spiders: swing forward/back, lift on the forward stroke),
   *  2 = upright (tortoise: swing in the walking plane), 3 = bird leg (upright, tucked back in flight). extra = gait phase offset. */
  Leg: 2,
  /** Head and neck: aux > 0 pecks or strikes down, aux < 0 turns the head back to preen. */
  Head: 3,
  /** Side-to-side body wave (fish, sharks, lizards). s = signed distance from the pivot (tail +). extra = flank glint weight. */
  Wag: 4,
  /** Up-and-down body wave (dolphins, whales, seals). s as for Wag. */
  Fluke: 5,
  /** Flipper or pectoral fin: rows and sweeps. |side| 2 = rear flipper (smaller stroke, flicks sand with aux). extra = phase offset. */
  Fin: 6,
  /** Crab claw: raised by fold. */
  Claw: 7,
  /** Dewlap or throat pouch: grows from its pivot with aux. extra = size when aux is 0. */
  Dewlap: 8,
  /** Silk thread: a camera-facing glinting line, s = 0 at the spider to 1 at the top; length = aux (body lengths), glint = fold. */
  Silk: 9,
  /** Slides back into a shell with fold (tortoise head, snail foot), weighted by s (0 stays put, 1 goes all the way). extra = how far (body lengths). */
  Retract: 10,
  /** Tail streamer: a travelling ripple on real time. */
  Streamer: 11,
  /** Insect wing: hinges through a large angle (butterflies close their wings above the back with fold). extra = rest angle. */
  InsectWing: 12,
  /** Ray wing: a wave running out along the span. */
  RayWing: 13,
} as const;

/** Fragment-shader patterns (computed from the rest position, no textures). */
export const Pattern = { None: 0, Spots: 1, Butterfly: 2, Scutes: 3, Bands: 4, Spiral: 5, Mottle: 6 } as const;

/**
 * Which colour slot is used where, per body plan (primary, secondary, accent), so the catalogue's
 * `AnimalLook.colors` come out right. Shown here for builders; not used at run time.
 */
export const SLOT_GUIDE: Record<keyof typeof AnimalModel, string> = {
  Seabird: 'back, wings and head / belly and underwing / bill and feet',
  Frigatebird: 'body / throat pouch / bill and feet',
  SmallBird: 'back and wings / breast and belly / eye ring',
  Wader: 'body / neck front and belly / crown, bill and legs',
  Shorebird: 'back (mottled) / belly / legs and bill',
  Duck: 'body (mottled) / cheek and neck stripe / bill',
  Bat: 'wings and body / mantle (neck and head) / ears and feet',
  Crab: 'shell / eye stalks / legs and claw tips',
  Lizard: 'body / dewlap / legs and stripe',
  Tortoise: 'shell / skin / shell seams',
  SeaTurtle: 'shell / skin (head, flippers) / belly plates and seams',
  FishShoal: 'body / fins and tail / belly',
  Ray: 'back / belly and spots / tail',
  Dolphin: 'flanks / belly / cape and fins',
  Whale: 'body / flippers, fluke underside, throat / back',
  Butterfly: 'wings / body, veins and margins / spots',
  Dragonfly: 'body / wings / eyes',
  Bee: 'body / bands / wings',
  Firefly: 'glow / (unused) / (unused)',
  Seal: 'back / belly / face (eyes and nose)',
  Spider: 'body / silk / legs',
  Shark: 'back and flanks / belly / fin tips',
  Snail: 'shell / foot and body / shell bands',
};

/** Extra body plans used only by the renderer (index after the catalogue's AnimalModel values). */
export const HATCHLING_PLAN = ANIMAL_MODEL_COUNT;
export const PLAN_COUNT = ANIMAL_MODEL_COUNT + 1;

// ---------- a tiny modelling kit ----------

export type Vec3 = readonly [number, number, number];
/** Weights of the primary, secondary and accent colour (the rest is near-black), and a shade multiplier. */
export type Paint = readonly [number, number, number, number];

const PRI: Paint = [1, 0, 0, 1];
const SEC: Paint = [0, 1, 0, 1];
const ACC: Paint = [0, 0, 1, 1];
const DARK: Paint = [0, 0, 0, 1];
/** The paints, for other code-made models drawn with the creature material (vignette props). */
export const PAINT = { PRI, SEC, ACC, DARK } as const;

export function mixPaint(a: Paint, b: Paint, t: number): Paint {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}
export function shade(p: Paint, k: number): Paint {
  return [p[0], p[1], p[2], p[3] * k];
}
function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
/** Paint by ring angle: `top` on the back, `belly` underneath (th = 0 is the top of the ring). */
export function backBelly(top: Paint, belly: Paint, line = 0): (th: number) => Paint {
  return (th) => mixPaint(belly, top, smooth(line - 0.35, line + 0.35, Math.cos(th)));
}
/** Three-band paint: cape on top, flanks, pale belly (dolphins, sharks). */
function capeFlankBelly(cape: Paint, flank: Paint, belly: Paint): (th: number) => Paint {
  return (th) => {
    const c = Math.cos(th);
    if (c > 0.3) return mixPaint(flank, cape, smooth(0.3, 0.8, c));
    return mixPaint(belly, flank, smooth(-0.6, 0.0, c));
  };
}

export interface PartState {
  part: number;
  side: number;
  extra: number;
  pivot: Vec3;
  pattern: number;
  /** How much the back face of a flat panel turns toward the secondary colour (underwings, ray bellies). */
  back: number;
}
const BODY_STATE: PartState = { part: Part.Body, side: 0, extra: 0, pivot: [0, 0, 0], pattern: Pattern.None, back: 0 };

export interface Ring {
  /** Centre of the ring. */
  c: Vec3;
  /** Half-width (x) and half-height (y); `ryb` is the half-height of the lower half (flat bellies). */
  rx: number;
  ry: number;
  ryb?: number;
  /** Rig position along the part. */
  s?: number;
  paint?: Paint | ((th: number) => Paint);
  /** Overrides of the current part for this ring (e.g. a head ring in a body tube). */
  part?: Partial<PartState>;
}

/** A small modelling kit: tubes and flat panels with per-vertex paint and rig (see Part). */
export class Shape {
  private pos: number[] = [];
  private paint: number[] = [];
  private rig: number[] = [];
  private piv: number[] = [];
  private pat: number[] = [];
  private idx: number[] = [];
  private st: PartState = BODY_STATE;

  /** Set the part for the vertices added next (anything not given goes back to the plain body). */
  as(p: Partial<PartState>): this {
    this.st = { ...BODY_STATE, ...p };
    return this;
  }

  v(x: number, y: number, z: number, paint: Paint, s = 0, o?: Partial<PartState>): number {
    const st = o ? { ...this.st, ...o } : this.st;
    this.pos.push(x, y, z);
    this.paint.push(paint[0], paint[1], paint[2], paint[3]);
    this.rig.push(st.part, s, st.side, st.extra);
    this.piv.push(st.pivot[0], st.pivot[1], st.pivot[2]);
    this.pat.push(st.pattern, st.back);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** A triangle wound so its front face looks along `face`. */
  triFacing(a: number, b: number, c: number, face: Vec3): void {
    const P = this.pos;
    const pa: Vec3 = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const n = cross(sub([P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], pa), sub([P[c * 3], P[c * 3 + 1], P[c * 3 + 2]], pa));
    if (n[0] * face[0] + n[1] * face[1] + n[2] * face[2] < 0) this.tri(a, c, b);
    else this.tri(a, b, c);
  }

  /**
   * A flat polygon (fanned from its first point), wound so its front face looks along `face`.
   * `sOf` gives each point its rig position.
   */
  panel(pts: Vec3[], paint: Paint | Paint[], sOf: (p: Vec3) => number, face: Vec3): void {
    const ids = pts.map((p, i) => this.v(p[0], p[1], p[2], Array.isArray(paint[0]) ? (paint as Paint[])[i] : (paint as Paint), sOf(p)));
    const [a, b, c] = [pts[0], pts[1], pts[2]];
    const n = cross(sub(b, a), sub(c, a));
    const flip = n[0] * face[0] + n[1] * face[1] + n[2] * face[2] < 0;
    for (let i = 1; i < ids.length - 1; i++) {
      if (flip) this.tri(ids[0], ids[i + 1], ids[i]);
      else this.tri(ids[0], ids[i], ids[i + 1]);
    }
  }

  /**
   * A tube through a list of rings (each ring perpendicular to the path). A ring with zero radius
   * becomes a single tip vertex, so tubes close themselves at pointed ends.
   */
  tube(rings: Ring[], sides: number): void {
    const ringIds: number[][] = [];
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      const prev = rings[Math.max(0, i - 1)].c;
      const next = rings[Math.min(rings.length - 1, i + 1)].c;
      const t = norm(sub(next, prev));
      let ref: Vec3 = [0, 1, 0];
      if (Math.abs(t[1]) > 0.92) ref = [0, 0, t[1] > 0 ? -1 : 1];
      const right = norm(cross(ref, t));
      const up = cross(t, right);
      const s = r.s ?? 0;
      const o = r.part;
      const paintAt = (th: number): Paint => (typeof r.paint === 'function' ? r.paint(th) : r.paint ?? PRI);
      if (r.rx === 0 && r.ry === 0) {
        ringIds.push([this.v(r.c[0], r.c[1], r.c[2], paintAt(0), s, o)]);
        continue;
      }
      const ids: number[] = [];
      for (let k = 0; k < sides; k++) {
        const th = (k / sides) * Math.PI * 2;
        const cy = Math.cos(th);
        const ry = cy < 0 && r.ryb !== undefined ? r.ryb : r.ry;
        const ox = r.rx * Math.sin(th);
        const oy = ry * cy;
        ids.push(this.v(r.c[0] + right[0] * ox + up[0] * oy, r.c[1] + right[1] * ox + up[1] * oy, r.c[2] + right[2] * ox + up[2] * oy, paintAt(th), s, o));
      }
      ringIds.push(ids);
    }
    for (let i = 0; i < ringIds.length - 1; i++) {
      const A = ringIds[i];
      const B = ringIds[i + 1];
      if (A.length === 1 && B.length === 1) continue;
      for (let k = 0; k < sides; k++) {
        const k1 = (k + 1) % sides;
        const a = A.length === 1 ? A[0] : A[k];
        const b = A.length === 1 ? A[0] : A[k1];
        const c = B.length === 1 ? B[0] : B[k1];
        const d = B.length === 1 ? B[0] : B[k];
        if (A.length > 1) this.tri(a, c, b);
        if (B.length > 1) this.tri(a, d, c);
      }
    }
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 4));
    g.setAttribute('aRig', new THREE.Float32BufferAttribute(this.rig, 4));
    g.setAttribute('aPivot', new THREE.Float32BufferAttribute(this.piv, 3));
    g.setAttribute('aPat', new THREE.Float32BufferAttribute(this.pat, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export const UP: Vec3 = [0, 1, 0];
const OUT_R: Vec3 = [1, 0, 0];

// ---------- birds ----------

interface WingSpec {
  /** Root leading and trailing z, root half-width and height. */
  rootF: number;
  rootB: number;
  rootX: number;
  y: number;
  /** Elbow: x, leading z, trailing z, height. */
  elbow: [number, number, number, number];
  /** Tip: x, z, height. */
  tip: [number, number, number];
  /** Optional extra trailing-edge point for broad wings: x, z. */
  trail?: [number, number];
  paint: Paint;
  /** Underside turns toward the secondary colour by this much. */
  back: number;
}

/** A pair of two-panel wings (inner and outer panel; 4-5 triangles per side). */
function wings(sh: Shape, w: WingSpec): void {
  for (const side of [1, -1]) {
    const span = w.tip[0];
    sh.as({ part: Part.Wing, side, pivot: [side * w.rootX, w.y, (w.rootF + w.rootB) / 2], back: w.back });
    const s = (p: Vec3) => Math.abs(p[0]) / span;
    const pts: Vec3[] = [
      [side * w.rootX, w.y, w.rootF],
      [side * w.elbow[0], w.elbow[3], w.elbow[1]],
      [side * w.tip[0], w.tip[2], w.tip[1]],
    ];
    if (w.trail) pts.push([side * w.trail[0], (w.tip[2] + w.elbow[3]) / 2, w.trail[1]]);
    pts.push([side * w.elbow[0], w.elbow[3], w.elbow[2]], [side * w.rootX, w.y, w.rootB]);
    sh.panel(pts, w.paint, s, UP);
  }
}

/** Thin bird legs with a small foot (bird legs tuck back in flight). */
function birdLegs(sh: Shape, hipY: number, hipX: number, z: number, footLen: number, paint: Paint, w = 0.012): void {
  for (const side of [1, -1]) {
    const x = side * hipX;
    sh.as({ part: Part.Leg, side: 3 * side, pivot: [x, hipY, z], extra: side > 0 ? 0 : Math.PI });
    const s = (p: Vec3) => (hipY - p[1]) / hipY;
    sh.panel(
      [
        [x - w, hipY, z],
        [x + w, hipY, z],
        [x + w * 0.6, 0.01, z],
        [x - w * 0.6, 0.01, z],
      ],
      paint,
      s,
      [0, 0, 1],
    );
    sh.panel(
      [
        [x, 0.005, z - footLen * 0.3],
        [x + footLen * 0.45, 0.005, z + footLen],
        [x - footLen * 0.45, 0.005, z + footLen],
      ],
      paint,
      () => 1,
      UP,
    );
  }
}

function seabird(): Shape {
  const sh = new Shape();
  const body = backBelly(PRI, SEC, -0.1);
  const head = { part: Part.Head, pivot: [0, 0.21, 0.17] as Vec3 };
  sh.tube(
    [
      { c: [0, 0.19, -0.5], rx: 0, ry: 0, paint: PRI },
      { c: [0, 0.17, -0.24], rx: 0.075, ry: 0.065, paint: body },
      { c: [0, 0.165, -0.02], rx: 0.105, ry: 0.095, paint: body },
      { c: [0, 0.19, 0.13], rx: 0.085, ry: 0.085, paint: body },
      { c: [0, 0.255, 0.27], rx: 0.055, ry: 0.058, paint: PRI, s: 0.7, part: head },
      { c: [0, 0.25, 0.35], rx: 0.03, ry: 0.033, paint: ACC, s: 0.9, part: head },
      { c: [0, 0.228, 0.5], rx: 0, ry: 0, paint: ACC, s: 1, part: head },
    ],
    5,
  );
  sh.as({});
  sh.panel(
    [
      [0, 0.19, -0.3],
      [0.075, 0.19, -0.52],
      [0, 0.19, -0.47],
      [-0.075, 0.19, -0.52],
    ],
    PRI,
    () => 0,
    UP,
  );
  wings(sh, { rootF: 0.1, rootB: -0.13, rootX: 0.06, y: 0.21, elbow: [0.42, 0.06, -0.14, 0.22], tip: [0.98, -0.13, 0.21], paint: PRI, back: 0.75 });
  birdLegs(sh, 0.11, 0.035, -0.01, 0.07, ACC);
  return sh;
}

function frigatebird(): Shape {
  const sh = new Shape();
  const head = { part: Part.Head, pivot: [0, 0.2, 0.15] as Vec3 };
  sh.tube(
    [
      { c: [0, 0.19, -0.42], rx: 0, ry: 0 },
      { c: [0, 0.175, -0.22], rx: 0.06, ry: 0.055 },
      { c: [0, 0.17, 0.0], rx: 0.085, ry: 0.08, paint: backBelly(PRI, shade(PRI, 1.25)) },
      { c: [0, 0.19, 0.13], rx: 0.07, ry: 0.07 },
      { c: [0, 0.24, 0.25], rx: 0.045, ry: 0.048, s: 0.7, part: head },
      { c: [0, 0.24, 0.31], rx: 0.022, ry: 0.024, s: 0.85, paint: ACC, part: head },
      { c: [0, 0.232, 0.46], rx: 0.013, ry: 0.016, s: 0.95, paint: ACC, part: head },
      { c: [0, 0.215, 0.48], rx: 0, ry: 0, s: 1, paint: ACC, part: head },
    ],
    5,
  );
  // Throat pouch: a red balloon under the neck that the male inflates while perched.
  sh.as({ part: Part.Dewlap, pivot: [0, 0.2, 0.2], extra: 0.35 });
  sh.tube(
    [
      { c: [0, 0.2, 0.12], rx: 0, ry: 0, paint: SEC },
      { c: [0, 0.14, 0.18], rx: 0.055, ry: 0.06, paint: SEC },
      { c: [0, 0.15, 0.27], rx: 0.04, ry: 0.045, paint: SEC },
      { c: [0, 0.21, 0.29], rx: 0, ry: 0, paint: SEC },
    ],
    5,
  );
  // Deeply forked tail streamers.
  for (const side of [1, -1]) {
    sh.as({ part: Part.Streamer, side, pivot: [0, 0.19, -0.3] });
    sh.panel(
      [
        [side * 0.012, 0.19, -0.3],
        [side * 0.05, 0.19, -0.33],
        [side * 0.13, 0.19, -0.82],
      ],
      PRI,
      (p) => Math.min(1, (-0.3 - p[2]) / 0.52),
      UP,
    );
  }
  // Long narrow wings with the frigatebird's "M" kink (inner panel up, outer panel down).
  wings(sh, { rootF: 0.08, rootB: -0.1, rootX: 0.05, y: 0.21, elbow: [0.5, 0.05, -0.08, 0.28], tip: [1.25, -0.2, 0.24], paint: PRI, back: 0 });
  birdLegs(sh, 0.09, 0.03, 0.0, 0.05, ACC);
  return sh;
}

function smallBird(): Shape {
  const sh = new Shape();
  const body = backBelly(PRI, SEC, -0.15);
  const head = { part: Part.Head, pivot: [0, 0.22, 0.17] as Vec3 };
  sh.tube(
    [
      { c: [0, 0.16, -0.32], rx: 0, ry: 0, paint: PRI },
      { c: [0, 0.155, -0.2], rx: 0.11, ry: 0.1, paint: body },
      { c: [0, 0.16, 0.0], rx: 0.16, ry: 0.15, paint: body },
      { c: [0, 0.19, 0.15], rx: 0.13, ry: 0.13, paint: body },
      { c: [0, 0.26, 0.27], rx: 0.1, ry: 0.1, s: 0.8, paint: backBelly(PRI, SEC, 0.2), part: head },
      { c: [0, 0.255, 0.36], rx: 0.035, ry: 0.032, s: 0.95, paint: DARK, part: head },
      { c: [0, 0.245, 0.46], rx: 0, ry: 0, s: 1, paint: DARK, part: head },
    ],
    5,
  );
  // Eye rings.
  for (const side of [1, -1]) {
    sh.as({ part: Part.Head, pivot: [0, 0.22, 0.17] });
    sh.panel(
      [
        [side * 0.088, 0.29, 0.31],
        [side * 0.088, 0.25, 0.33],
        [side * 0.088, 0.27, 0.26],
      ],
      ACC,
      () => 0.85,
      [side, 0, 0],
    );
  }
  sh.as({});
  sh.panel(
    [
      [0, 0.18, -0.22],
      [0.06, 0.19, -0.56],
      [-0.06, 0.19, -0.56],
    ],
    PRI,
    () => 0,
    UP,
  );
  wings(sh, { rootF: 0.1, rootB: -0.13, rootX: 0.09, y: 0.22, elbow: [0.36, 0.06, -0.17, 0.23], tip: [0.66, -0.12, 0.22], trail: [0.5, -0.2], paint: PRI, back: 0.5 });
  birdLegs(sh, 0.09, 0.04, -0.01, 0.06, DARK, 0.01);
  return sh;
}

function wader(): Shape {
  const sh = new Shape();
  const body = backBelly(PRI, SEC, -0.3);
  const neck = backBelly(PRI, SEC);
  const head = (s: number) => ({ s, part: { part: Part.Head, pivot: [0, 0.55, 0.1] as Vec3 } });
  sh.tube(
    [
      { c: [0, 0.5, -0.44], rx: 0, ry: 0, paint: PRI },
      { c: [0, 0.5, -0.28], rx: 0.07, ry: 0.06, paint: body },
      { c: [0, 0.48, -0.07], rx: 0.11, ry: 0.1, paint: body },
      { c: [0, 0.53, 0.08], rx: 0.085, ry: 0.095, paint: body },
      { c: [0, 0.63, 0.13], rx: 0.045, ry: 0.045, paint: neck, ...head(0.3) },
      { c: [0, 0.73, 0.11], rx: 0.04, ry: 0.04, paint: neck, ...head(0.6) },
      { c: [0, 0.8, 0.17], rx: 0.048, ry: 0.052, paint: backBelly(ACC, PRI, 0.6), ...head(0.85) },
      { c: [0, 0.795, 0.23], rx: 0.02, ry: 0.022, paint: DARK, ...head(0.92) },
      { c: [0, 0.78, 0.42], rx: 0, ry: 0, paint: DARK, ...head(1) },
    ],
    5,
  );
  wings(sh, { rootF: 0.09, rootB: -0.16, rootX: 0.08, y: 0.55, elbow: [0.5, 0.05, -0.22, 0.56], tip: [0.95, -0.12, 0.55], trail: [0.78, -0.24], paint: PRI, back: 0.3 });
  sh.as({});
  sh.panel(
    [
      [0, 0.5, -0.34],
      [0.06, 0.5, -0.5],
      [-0.06, 0.5, -0.5],
    ],
    PRI,
    () => 0,
    UP,
  );
  birdLegs(sh, 0.44, 0.035, -0.02, 0.1, ACC, 0.013);
  return sh;
}

function shorebird(): Shape {
  const sh = new Shape();
  const body = backBelly(PRI, SEC, 0);
  const head = { part: Part.Head, pivot: [0, 0.2, 0.14] as Vec3 };
  sh.as({ pattern: Pattern.Mottle });
  sh.tube(
    [
      { c: [0, 0.17, -0.48], rx: 0, ry: 0, paint: PRI },
      { c: [0, 0.16, -0.27], rx: 0.09, ry: 0.08, paint: body },
      { c: [0, 0.155, -0.03], rx: 0.13, ry: 0.12, paint: body },
      { c: [0, 0.18, 0.12], rx: 0.11, ry: 0.11, paint: body },
      { c: [0, 0.25, 0.24], rx: 0.085, ry: 0.085, s: 0.8, paint: backBelly(PRI, SEC, 0.3), part: { ...head, pattern: Pattern.Mottle } },
      { c: [0, 0.245, 0.31], rx: 0.024, ry: 0.024, s: 0.95, paint: DARK, part: head },
      { c: [0, 0.232, 0.45], rx: 0, ry: 0, s: 1, paint: DARK, part: head },
    ],
    5,
  );
  wings(sh, { rootF: 0.09, rootB: -0.12, rootX: 0.08, y: 0.2, elbow: [0.36, 0.05, -0.14, 0.21], tip: [0.86, -0.18, 0.2], paint: PRI, back: 0.8 });
  sh.as({});
  sh.panel(
    [
      [0, 0.17, -0.3],
      [0.055, 0.17, -0.5],
      [-0.055, 0.17, -0.5],
    ],
    PRI,
    () => 0,
    UP,
  );
  birdLegs(sh, 0.1, 0.035, -0.01, 0.06, ACC, 0.01);
  return sh;
}

function duck(): Shape {
  const sh = new Shape();
  const head = (s: number) => ({ s, part: { part: Part.Head, pivot: [0, 0.1, 0.18] as Vec3, pattern: Pattern.None } });
  const neck: (th: number) => Paint = (th) => (Math.cos(th) < 0.2 ? SEC : PRI);
  sh.as({ pattern: Pattern.Mottle });
  sh.tube(
    [
      { c: [0, 0.13, -0.5], rx: 0, ry: 0 },
      { c: [0, 0.08, -0.36], rx: 0.13, ry: 0.075, ryb: 0.07 },
      { c: [0, 0.07, -0.08], rx: 0.19, ry: 0.11, ryb: 0.1 },
      { c: [0, 0.08, 0.16], rx: 0.16, ry: 0.11, ryb: 0.1 },
      { c: [0, 0.19, 0.26], rx: 0.06, ry: 0.06, paint: neck, ...head(0.5) },
      { c: [0, 0.3, 0.3], rx: 0.07, ry: 0.075, ...head(0.9) },
      { c: [0, 0.29, 0.37], rx: 0.045, ry: 0.03, paint: ACC, ...head(0.95) },
      { c: [0, 0.27, 0.48], rx: 0.035, ry: 0.012, paint: ACC, ...head(1) },
      { c: [0, 0.27, 0.5], rx: 0, ry: 0, paint: ACC, ...head(1) },
    ],
    6,
  );
  wings(sh, { rootF: 0.06, rootB: -0.16, rootX: 0.13, y: 0.15, elbow: [0.42, 0.02, -0.18, 0.16], tip: [0.82, -0.16, 0.15], paint: PRI, back: 0.5 });
  return sh;
}

function bat(): Shape {
  const sh = new Shape();
  const head = { part: Part.Head, pivot: [0, 0.01, 0.17] as Vec3 };
  const mantle = backBelly(SEC, shade(PRI, 1.2), 0.2);
  sh.tube(
    [
      { c: [0, 0, -0.42], rx: 0, ry: 0 },
      { c: [0, 0, -0.28], rx: 0.08, ry: 0.07 },
      { c: [0, 0, -0.05], rx: 0.12, ry: 0.1 },
      { c: [0, 0.01, 0.14], rx: 0.1, ry: 0.09, paint: mantle },
      { c: [0, 0.03, 0.26], rx: 0.08, ry: 0.08, s: 0.8, paint: mantle, part: head },
      { c: [0, 0.02, 0.38], rx: 0.035, ry: 0.035, s: 0.95, paint: SEC, part: head },
      { c: [0, 0.01, 0.46], rx: 0, ry: 0, s: 1, paint: DARK, part: head },
    ],
    5,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.Head, pivot: [0, 0.01, 0.17] });
    sh.panel(
      [
        [side * 0.035, 0.09, 0.27],
        [side * 0.075, 0.08, 0.24],
        [side * 0.06, 0.17, 0.25],
      ],
      ACC,
      () => 1,
      [0, 0, 1],
    );
  }
  // Membrane wings with a scalloped trailing edge (fanned from the shoulder).
  for (const side of [1, -1]) {
    sh.as({ part: Part.Wing, side, pivot: [side * 0.07, 0.02, 0], back: 0.15 });
    const span = 1.45;
    const pts: Vec3[] = [
      [side * 0.07, 0.02, 0.12],
      [side * 0.55, 0.04, 0.2],
      [side * 1.45, 0.0, -0.04],
      [side * 1.1, 0.0, -0.3],
      [side * 0.95, 0.0, -0.2],
      [side * 0.72, 0.0, -0.42],
      [side * 0.42, 0.0, -0.36],
      [side * 0.07, 0.0, -0.3],
    ];
    sh.panel(pts, PRI, (p) => Math.abs(p[0]) / span, UP);
  }
  for (const side of [1, -1]) {
    sh.as({ part: Part.Leg, side: 2 * side, pivot: [side * 0.04, 0, -0.3] });
    sh.panel(
      [
        [side * 0.04, 0, -0.3],
        [side * 0.07, 0, -0.5],
        [side * 0.02, 0, -0.5],
      ],
      ACC,
      () => 1,
      UP,
    );
  }
  return sh;
}

// ---------- small walkers ----------

function crab(): Shape {
  const sh = new Shape();
  const top = backBelly(PRI, shade(PRI, 0.75));
  sh.tube(
    [
      { c: [0, 0.2, -0.46], rx: 0, ry: 0, paint: PRI },
      { c: [0, 0.25, -0.15], rx: 0.58, ry: 0.14, ryb: 0.08, paint: top },
      { c: [0, 0.24, 0.18], rx: 0.53, ry: 0.12, ryb: 0.07, paint: top },
      { c: [0, 0.21, 0.45], rx: 0, ry: 0, paint: PRI },
    ],
    5,
  );
  // Eight walking legs: two bent segments each, as tilted ribbons so they read from above and from the side.
  const legZ = [0.16, 0.02, -0.12, -0.26];
  for (const side of [1, -1]) {
    legZ.forEach((z, i) => {
      const off = (i % 2) * Math.PI + (side > 0 ? 0 : Math.PI / 2);
      sh.as({ part: Part.Leg, side, extra: off, pivot: [side * 0.45, 0.2, z] });
      const spread = (i - 1.5) * 0.12;
      const hip: Vec3 = [side * 0.45, 0.2, z];
      const knee: Vec3 = [side * 0.82, 0.34, z + spread * 0.6];
      const foot: Vec3 = [side * 1.02, 0.0, z + spread];
      const w = 0.035;
      const tilt: Vec3 = [0, 0.5 * w, 0.87 * w];
      const seg = (a: Vec3, b: Vec3, sa: number, sb: number, pa: Paint, pb: Paint) => {
        const i0 = sh.v(a[0] - tilt[0], a[1] - tilt[1], a[2] - tilt[2], pa, sa);
        const i1 = sh.v(a[0] + tilt[0], a[1] + tilt[1], a[2] + tilt[2], pa, sa);
        const i2 = sh.v(b[0] + tilt[0], b[1] + tilt[1], b[2] + tilt[2], pb, sb);
        const i3 = sh.v(b[0] - tilt[0], b[1] - tilt[1], b[2] - tilt[2], pb, sb);
        sh.tri(i0, i1, i2);
        sh.tri(i0, i2, i3);
      };
      seg(hip, knee, 0, 0.5, ACC, ACC);
      seg(knee, foot, 0.5, 1, ACC, shade(ACC, 0.8));
    });
  }
  // Claws (one bigger, as ghost crabs have).
  for (const side of [1, -1]) {
    const big = side > 0 ? 1.25 : 0.9;
    const bx = side * 0.3;
    sh.as({ part: Part.Claw, side, pivot: [bx, 0.22, 0.38] });
    const tip: Vec3 = [bx + side * 0.05, 0.24, 0.38 + 0.32 * big];
    const s = (p: Vec3) => Math.min(1, (p[2] - 0.38) / 0.3);
    sh.panel([[bx - 0.08 * big, 0.2, 0.38], [bx + 0.08 * big, 0.2, 0.38], tip], PRI, s, UP);
    sh.panel([[bx - 0.06 * big, 0.3, 0.42], [bx + 0.06 * big, 0.3, 0.42], tip], [PRI, PRI, ACC], s, UP);
  }
  // Eye stalks with dark tips.
  for (const side of [1, -1]) {
    sh.as({});
    const x = side * 0.17;
    sh.panel(
      [
        [x - 0.03, 0.26, 0.38],
        [x + 0.03, 0.26, 0.38],
        [x + 0.04, 0.5, 0.4],
        [x - 0.04, 0.5, 0.4],
      ],
      [PRI, PRI, SEC, SEC],
      () => 0,
      [0, 0, 1],
    );
  }
  return sh;
}

function lizard(): Shape {
  const sh = new Shape();
  const pivotZ = 0.15;
  sh.as({ part: Part.Wag, pivot: [0, 0.05, pivotZ] });
  const r = (z: number, y: number, rx: number, ry: number, paint: Ring['paint'] = backBelly(PRI, shade(PRI, 1.25))): Ring => ({
    c: [0, y, z],
    rx,
    ry,
    s: (pivotZ - z) / (pivotZ + 0.5),
    paint,
  });
  sh.tube(
    [
      r(0.5, 0.05, 0, 0, PRI),
      r(0.42, 0.055, 0.035, 0.028),
      r(0.28, 0.058, 0.045, 0.036),
      r(0.12, 0.054, 0.055, 0.04),
      r(-0.0, 0.047, 0.042, 0.033),
      r(-0.1, 0.04, 0.025, 0.021),
      r(-0.3, 0.028, 0.013, 0.012),
      r(-0.5, 0.02, 0, 0, ACC),
    ],
    4,
  );
  // Eyes.
  for (const side of [1, -1]) {
    sh.as({ part: Part.Wag, pivot: [0, 0.05, pivotZ] });
    sh.panel(
      [
        [side * 0.031, 0.07, 0.43],
        [side * 0.031, 0.06, 0.4],
        [side * 0.031, 0.075, 0.39],
      ],
      DARK,
      () => (pivotZ - 0.41) / (pivotZ + 0.5),
      [side, 0, 0],
    );
  }
  // Four sprawled legs (diagonal pairs move together).
  const legs: [number, number][] = [
    [0.27, 0],
    [0.02, Math.PI],
  ];
  for (const side of [1, -1]) {
    for (const [z, ph] of legs) {
      const off = ph + (side > 0 ? 0 : Math.PI);
      sh.as({ part: Part.Leg, side, extra: off, pivot: [side * 0.04, 0.045, z] });
      const hip: Vec3 = [side * 0.04, 0.045, z];
      const elbow: Vec3 = [side * 0.13, 0.05, z + 0.03];
      const foot: Vec3 = [side * 0.15, 0.0, z + 0.07];
      const w = 0.012;
      const a0 = sh.v(hip[0], hip[1], hip[2] - w, ACC, 0);
      const a1 = sh.v(hip[0], hip[1], hip[2] + w, ACC, 0);
      const b0 = sh.v(elbow[0], elbow[1], elbow[2] - w, ACC, 0.5);
      const b1 = sh.v(elbow[0], elbow[1], elbow[2] + w, ACC, 0.5);
      const c0 = sh.v(foot[0] - w, foot[1], foot[2], ACC, 1);
      const c1 = sh.v(foot[0] + w, foot[1], foot[2], ACC, 1);
      sh.tri(a0, a1, b1);
      sh.tri(a0, b1, b0);
      sh.tri(b0, b1, c1);
      sh.tri(b0, c1, c0);
    }
  }
  // Dewlap: a fan under the throat that flicks open in display.
  sh.as({ part: Part.Dewlap, pivot: [0, 0.03, 0.36], extra: 0.12 });
  sh.panel(
    [
      [0, 0.035, 0.37],
      [0, -0.045, 0.39],
      [0, -0.07, 0.32],
      [0, -0.04, 0.26],
      [0, 0.03, 0.28],
    ],
    SEC,
    () => 1,
    OUT_R,
  );
  return sh;
}

function tortoise(): Shape {
  const sh = new Shape();
  sh.as({ pattern: Pattern.Scutes });
  const shell = backBelly(PRI, shade(PRI, 0.7), -0.4);
  sh.tube(
    [
      { c: [0, 0.17, -0.47], rx: 0, ry: 0, paint: PRI },
      { c: [0, 0.24, -0.37], rx: 0.31, ry: 0.19, ryb: 0.1, paint: shell },
      { c: [0, 0.27, -0.1], rx: 0.41, ry: 0.27, ryb: 0.14, paint: shell },
      { c: [0, 0.27, 0.17], rx: 0.39, ry: 0.26, ryb: 0.14, paint: shell },
      { c: [0, 0.23, 0.37], rx: 0.29, ry: 0.17, ryb: 0.1, paint: shell },
      { c: [0, 0.19, 0.45], rx: 0, ry: 0, paint: PRI },
    ],
    8,
  );
  // Head on a neck that pulls back into the shell.
  sh.as({ part: Part.Retract, pivot: [0, 0.15, 0.38], extra: 0.2 });
  sh.tube(
    [
      { c: [0, 0.14, 0.36], rx: 0.07, ry: 0.06, s: 0.4, paint: SEC },
      { c: [0, 0.17, 0.56], rx: 0.065, ry: 0.06, s: 0.9, paint: SEC },
      { c: [0, 0.155, 0.65], rx: 0, ry: 0, s: 1, paint: shade(SEC, 0.8) },
    ],
    5,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.Retract, pivot: [0, 0.15, 0.38], extra: 0.2 });
    sh.panel(
      [
        [side * 0.052, 0.19, 0.57],
        [side * 0.05, 0.175, 0.6],
        [side * 0.052, 0.2, 0.6],
      ],
      DARK,
      () => 1,
      [side, 0, 0],
    );
  }
  // Four stumpy elephant legs.
  const legs: [number, number, number][] = [
    [0.3, 0.22, 0],
    [0.28, -0.25, Math.PI],
  ];
  for (const side of [1, -1]) {
    for (const [x, z, ph] of legs) {
      sh.as({ part: Part.Leg, side: 2 * side, extra: ph + (side > 0 ? 0 : Math.PI), pivot: [side * x, 0.2, z] });
      sh.tube(
        [
          { c: [side * x, 0.2, z], rx: 0.07, ry: 0.07, s: 0, paint: SEC },
          { c: [side * (x + 0.03), 0.03, z], rx: 0.065, ry: 0.065, s: 1, paint: shade(SEC, 0.85) },
          { c: [side * (x + 0.03), 0.0, z], rx: 0, ry: 0, s: 1, paint: shade(SEC, 0.7) },
        ],
        4,
      );
    }
  }
  return sh;
}

// ---------- the sea ----------

function seaTurtle(lowDetail: boolean): Shape {
  const sh = new Shape();
  sh.as({ pattern: lowDetail ? Pattern.None : Pattern.Scutes });
  const shell = backBelly(PRI, ACC, -0.2);
  const rings: Ring[] = lowDetail
    ? [
        { c: [0, 0, -0.45], rx: 0, ry: 0 },
        { c: [0, 0.02, -0.05], rx: 0.33, ry: 0.14, ryb: 0.06, paint: shell },
        { c: [0, 0, 0.33], rx: 0, ry: 0 },
      ]
    : [
        { c: [0, 0, -0.5], rx: 0, ry: 0 },
        { c: [0, 0.01, -0.36], rx: 0.22, ry: 0.1, ryb: 0.05, paint: shell },
        { c: [0, 0.03, -0.1], rx: 0.36, ry: 0.16, ryb: 0.07, paint: shell },
        { c: [0, 0.03, 0.14], rx: 0.34, ry: 0.15, ryb: 0.07, paint: shell },
        { c: [0, 0.01, 0.3], rx: 0.22, ry: 0.1, ryb: 0.05, paint: shell },
        { c: [0, 0, 0.36], rx: 0, ry: 0 },
      ];
  sh.tube(rings, lowDetail ? 5 : 8);
  sh.as({ part: Part.Head, pivot: [0, 0, 0.32] });
  sh.tube(
    [
      { c: [0, -0.005, 0.3], rx: 0.07, ry: 0.06, s: 0.3, paint: SEC },
      { c: [0, 0.01, 0.46], rx: 0.065, ry: 0.06, s: 0.8, paint: backBelly(SEC, shade(ACC, 0.9)) },
      { c: [0, 0.0, 0.56], rx: 0, ry: 0, s: 1, paint: shade(SEC, 0.8) },
    ],
    lowDetail ? 4 : 5,
  );
  if (!lowDetail) {
    for (const side of [1, -1]) {
      sh.as({ part: Part.Head, pivot: [0, 0, 0.32] });
      sh.panel(
        [
          [side * 0.058, 0.025, 0.47],
          [side * 0.058, 0.01, 0.5],
          [side * 0.058, 0.03, 0.5],
        ],
        DARK,
        () => 0.85,
        [side, 0, 0],
      );
    }
  }
  // Long front flippers (rowed together in the green turtle's "butterfly" stroke) and small rear flippers.
  for (const side of [1, -1]) {
    sh.as({ part: Part.Fin, side, pivot: [side * 0.2, 0, 0.18], back: 0.4 });
    sh.panel(
      [
        [side * 0.2, 0, 0.19],
        [side * 0.46, -0.005, 0.21],
        [side * 0.78, -0.02, -0.02],
        [side * 0.45, -0.01, 0.06],
        [side * 0.22, -0.005, 0.08],
      ],
      SEC,
      (p) => Math.abs(p[0]) / 0.78,
      UP,
    );
    sh.as({ part: Part.Fin, side: 2 * side, extra: Math.PI, pivot: [side * 0.14, -0.01, -0.3], back: 0.4 });
    sh.panel(
      [
        [side * 0.14, -0.01, -0.28],
        [side * 0.33, -0.02, -0.44],
        [side * 0.18, -0.02, -0.47],
      ],
      SEC,
      (p) => Math.abs(p[0]) / 0.33,
      UP,
    );
  }
  return sh;
}

function fish(): Shape {
  const sh = new Shape();
  const pivotZ = 0.2;
  const s = (z: number) => (pivotZ - z) / 0.7;
  const flank = (th: number): Paint => (Math.cos(th) < -0.5 ? ACC : PRI);
  sh.as({ part: Part.Wag, pivot: [0, 0, pivotZ], extra: 1 });
  sh.tube(
    [
      { c: [0, 0, 0.5], rx: 0, ry: 0, s: s(0.5) },
      { c: [0, 0.01, 0.15], rx: 0.07, ry: 0.19, s: s(0.15), paint: flank },
      { c: [0, 0.0, -0.3], rx: 0.02, ry: 0.05, s: s(-0.3), paint: flank },
    ],
    4,
  );
  sh.as({ part: Part.Wag, pivot: [0, 0, pivotZ], extra: 0 });
  sh.panel(
    [
      [0, 0, -0.28],
      [0, 0.17, -0.5],
      [0, 0, -0.43],
      [0, -0.17, -0.5],
    ],
    SEC,
    (p) => s(p[2]),
    OUT_R,
  );
  return sh;
}

function ray(): Shape {
  const sh = new Shape();
  // Body and wings: a flat diamond whose wing tips ripple. Top has spots; the underside is pale.
  sh.as({ part: Part.RayWing, pivot: [0, 0, 0], pattern: Pattern.Spots, back: 1 });
  const stations: [number, number, number, number][] = [
    // x, front z, back z, height
    [0, 0.32, -0.3, 0.06],
    [0.3, 0.24, -0.27, 0.04],
    [0.62, 0.1, -0.16, 0.015],
    [1.0, -0.06, -0.06, 0],
  ];
  for (const side of [1, -1]) {
    const f: number[] = [];
    const b: number[] = [];
    for (const [x, zf, zb, h] of stations) {
      f.push(sh.v(side * x, h, zf, PRI, x));
      b.push(zf === zb ? f[f.length - 1] : sh.v(side * x, h, zb, PRI, x));
    }
    for (let i = 0; i < stations.length - 1; i++) {
      sh.triFacing(f[i], f[i + 1], b[i], UP);
      if (b[i + 1] !== f[i + 1]) sh.triFacing(f[i + 1], b[i + 1], b[i], UP);
    }
  }
  // Head lobe.
  sh.as({ pattern: Pattern.None });
  sh.tube(
    [
      { c: [0, 0.03, 0.26], rx: 0.09, ry: 0.05, paint: backBelly(PRI, SEC) },
      { c: [0, 0.03, 0.38], rx: 0.07, ry: 0.04, paint: backBelly(PRI, SEC) },
      { c: [0, 0.02, 0.46], rx: 0, ry: 0, paint: PRI },
    ],
    4,
  );
  // Long whip tail.
  sh.as({ part: Part.Streamer, pivot: [0, 0, -0.3] });
  sh.panel(
    [
      [0.012, 0.01, -0.3],
      [0, 0.01, -1.4],
      [-0.012, 0.01, -0.3],
    ],
    ACC,
    (p) => Math.min(1, (-0.3 - p[2]) / 1.1),
    UP,
  );
  return sh;
}

function dolphin(): Shape {
  const sh = new Shape();
  const pivotZ = 0.1;
  const s = (z: number) => (pivotZ - z) / 0.6;
  const skin = capeFlankBelly(ACC, PRI, SEC);
  sh.as({ part: Part.Fluke, pivot: [0, 0, pivotZ] });
  const r = (z: number, y: number, rx: number, ry: number): Ring => ({ c: [0, y, z], rx, ry, s: s(z), paint: skin });
  sh.tube([r(0.5, -0.02, 0, 0), r(0.42, -0.015, 0.025, 0.022), r(0.35, 0.01, 0.07, 0.075), r(0.25, 0.01, 0.1, 0.105), r(0.05, 0, 0.12, 0.125), r(-0.18, 0, 0.08, 0.09), r(-0.36, 0, 0.03, 0.05), r(-0.44, 0, 0, 0)], 6);
  sh.panel(
    [
      [0, 0.11, 0.02],
      [0, 0.24, -0.14],
      [0, 0.09, -0.15],
    ],
    ACC,
    (p) => s(p[2]),
    OUT_R,
  );
  sh.panel(
    [
      [0, 0, -0.4],
      [0.17, 0, -0.53],
      [0.05, 0, -0.5],
      [0, 0, -0.47],
      [-0.05, 0, -0.5],
      [-0.17, 0, -0.53],
    ],
    ACC,
    (p) => s(p[2]),
    UP,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.Fin, side, pivot: [side * 0.09, -0.05, 0.16] });
    sh.panel(
      [
        [side * 0.09, -0.05, 0.18],
        [side * 0.23, -0.1, 0.06],
        [side * 0.08, -0.06, 0.09],
      ],
      ACC,
      (p) => Math.abs(p[0]) / 0.23,
      UP,
    );
  }
  return sh;
}

function whale(): Shape {
  const sh = new Shape();
  const pivotZ = 0.05;
  const s = (z: number) => (pivotZ - z) / 0.5;
  const skin = capeFlankBelly(ACC, PRI, mixPaint(PRI, SEC, 0.45));
  sh.as({ part: Part.Fluke, pivot: [0, 0, pivotZ] });
  const r = (z: number, y: number, rx: number, ry: number): Ring => ({ c: [0, y, z], rx, ry, s: s(z), paint: skin });
  sh.tube(
    [r(0.5, -0.01, 0, 0), r(0.46, 0, 0.05, 0.035), r(0.38, 0, 0.085, 0.07), r(0.25, 0.005, 0.11, 0.095), r(0.08, 0, 0.125, 0.11), r(-0.1, 0, 0.11, 0.1), r(-0.25, 0, 0.075, 0.07), r(-0.38, 0, 0.03, 0.045), r(-0.44, 0, 0, 0)],
    10,
  );
  // Small dorsal hump.
  sh.panel(
    [
      [0, 0.06, -0.12],
      [0, 0.11, -0.2],
      [0, 0.05, -0.24],
    ],
    ACC,
    (p) => s(p[2]),
    OUT_R,
  );
  // Wide flukes with a pale underside.
  sh.as({ part: Part.Fluke, pivot: [0, 0, pivotZ], back: 1 });
  sh.panel(
    [
      [0, 0, -0.41],
      [0.2, 0.0, -0.49],
      [0.14, 0, -0.52],
      [0.04, 0, -0.5],
      [0, 0, -0.47],
      [-0.04, 0, -0.5],
      [-0.14, 0, -0.52],
      [-0.2, 0.0, -0.49],
    ],
    ACC,
    (p) => s(p[2]),
    UP,
  );
  // The humpback's long white flippers.
  for (const side of [1, -1]) {
    sh.as({ part: Part.Fin, side, pivot: [side * 0.1, -0.05, 0.2], back: 0.3 });
    sh.panel(
      [
        [side * 0.1, -0.05, 0.22],
        [side * 0.24, -0.1, 0.17],
        [side * 0.43, -0.15, 0.04],
        [side * 0.2, -0.09, 0.1],
        [side * 0.09, -0.06, 0.13],
      ],
      SEC,
      (p) => Math.abs(p[0]) / 0.43,
      UP,
    );
  }
  return sh;
}

function shark(): Shape {
  const sh = new Shape();
  const pivotZ = 0.15;
  const s = (z: number) => (pivotZ - z) / 0.65;
  const skin = capeFlankBelly(shade(PRI, 0.9), PRI, SEC);
  sh.as({ part: Part.Wag, pivot: [0, 0, pivotZ] });
  const r = (z: number, y: number, rx: number, ry: number): Ring => ({ c: [0, y, z], rx, ry, s: s(z), paint: skin });
  sh.tube([r(0.5, 0, 0, 0), r(0.42, 0, 0.04, 0.035), r(0.3, 0, 0.08, 0.07), r(0.12, 0, 0.1, 0.095), r(-0.08, 0, 0.085, 0.08), r(-0.25, 0, 0.05, 0.05), r(-0.36, 0.0, 0.02, 0.03), r(-0.4, 0.01, 0, 0)], 6);
  sh.panel(
    [
      [0, 0.09, 0.08],
      [0, 0.24, -0.05],
      [0, 0.07, -0.09],
    ],
    [PRI, ACC, PRI],
    (p) => s(p[2]),
    OUT_R,
  );
  sh.panel(
    [
      [0, 0.0, -0.35],
      [0, 0.21, -0.52],
      [0, 0.02, -0.45],
      [0, -0.11, -0.49],
    ],
    [PRI, ACC, PRI, ACC],
    (p) => s(p[2]),
    OUT_R,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.Fin, side, pivot: [side * 0.08, -0.05, 0.12] });
    sh.panel(
      [
        [side * 0.08, -0.05, 0.15],
        [side * 0.28, -0.12, 0.0],
        [side * 0.07, -0.06, 0.04],
      ],
      [PRI, ACC, PRI],
      (p) => Math.abs(p[0]) / 0.28,
      UP,
    );
  }
  return sh;
}

function seal(): Shape {
  const sh = new Shape();
  const pivotZ = 0.1;
  const s = (z: number) => (pivotZ - z) / 0.55;
  const skin = backBelly(PRI, SEC, -0.2);
  sh.as({ part: Part.Fluke, pivot: [0, 0.1, pivotZ] });
  const r = (z: number, y: number, rx: number, ry: number, ryb: number, paint: Ring['paint'] = skin): Ring => ({ c: [0, y, z], rx, ry, ryb, s: s(z), paint });
  sh.tube(
    [
      r(0.5, 0.11, 0, 0, 0, ACC),
      r(0.45, 0.11, 0.04, 0.035, 0.03, PRI),
      r(0.36, 0.12, 0.075, 0.07, 0.065),
      r(0.26, 0.115, 0.1, 0.09, 0.09),
      r(0.1, 0.11, 0.15, 0.11, 0.1),
      r(-0.08, 0.1, 0.14, 0.1, 0.095),
      r(-0.25, 0.08, 0.09, 0.065, 0.065),
      r(-0.38, 0.06, 0.05, 0.035, 0.035),
      r(-0.44, 0.05, 0, 0, 0),
    ],
    7,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.Fluke, pivot: [0, 0.1, pivotZ] });
    sh.panel(
      [
        [side * 0.068, 0.15, 0.38],
        [side * 0.068, 0.135, 0.41],
        [side * 0.068, 0.155, 0.41],
      ],
      ACC,
      (p) => s(p[2]),
      [side, 0, 0],
    );
    // Hind flippers fanned behind the tail.
    sh.panel(
      [
        [side * 0.02, 0.05, -0.4],
        [side * 0.12, 0.04, -0.56],
        [side * 0.03, 0.05, -0.55],
      ],
      PRI,
      (p) => s(p[2]),
      UP,
    );
    sh.as({ part: Part.Fin, side, pivot: [side * 0.12, 0.05, 0.14] });
    sh.panel(
      [
        [side * 0.12, 0.05, 0.16],
        [side * 0.22, 0.0, 0.08],
        [side * 0.13, 0.03, 0.07],
      ],
      PRI,
      (p) => Math.abs(p[0]) / 0.22,
      UP,
    );
  }
  return sh;
}

// ---------- insects, spiders, snails ----------

function butterfly(): Shape {
  const sh = new Shape();
  sh.tube(
    [
      { c: [0, 0, 0.22], rx: 0, ry: 0, paint: SEC },
      { c: [0, 0, 0.12], rx: 0.03, ry: 0.03, paint: SEC },
      { c: [0, -0.005, -0.22], rx: 0, ry: 0, paint: SEC },
    ],
    3,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.InsectWing, side, extra: 0.25, pivot: [side * 0.02, 0, 0], pattern: Pattern.Butterfly, back: 0.35 });
    sh.panel(
      [
        [side * 0.02, 0, 0.1],
        [side * 0.48, 0, 0.27],
        [side * 0.5, 0, -0.02],
        [side * 0.36, 0, -0.26],
        [side * 0.02, 0, -0.14],
      ],
      PRI,
      (p) => Math.abs(p[0]) / 0.5,
      UP,
    );
  }
  return sh;
}

function dragonfly(): Shape {
  const sh = new Shape();
  sh.tube(
    [
      { c: [0, 0, 0.5], rx: 0, ry: 0, paint: ACC },
      { c: [0, 0, 0.43], rx: 0.07, ry: 0.06, paint: ACC },
      { c: [0, 0, 0.3], rx: 0.06, ry: 0.06, paint: PRI },
      { c: [0, 0, 0.18], rx: 0.03, ry: 0.03, paint: PRI },
      { c: [0, 0, -0.5], rx: 0, ry: 0, paint: shade(PRI, 0.8) },
    ],
    3,
  );
  for (const side of [1, -1]) {
    for (const [z, sweep] of [
      [0.33, 0.04],
      [0.24, -0.04],
    ] as [number, number][]) {
      sh.as({ part: Part.InsectWing, side, extra: 0.04, pivot: [side * 0.03, 0.03, z] });
      sh.panel(
        [
          [side * 0.03, 0.03, z + 0.03],
          [side * 0.78, 0.03, z + sweep + 0.04],
          [side * 0.8, 0.03, z + sweep - 0.03],
          [side * 0.03, 0.03, z - 0.04],
        ],
        SEC,
        (p) => Math.abs(p[0]) / 0.8,
        UP,
      );
    }
  }
  return sh;
}

function bee(): Shape {
  const sh = new Shape();
  sh.as({ pattern: Pattern.Bands });
  sh.tube(
    [
      { c: [0, 0, 0.5], rx: 0, ry: 0 },
      { c: [0, 0.02, 0.2], rx: 0.17, ry: 0.17 },
      { c: [0, 0, -0.18], rx: 0.2, ry: 0.19 },
      { c: [0, -0.02, -0.48], rx: 0, ry: 0 },
    ],
    4,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.InsectWing, side, extra: 0.3, pivot: [side * 0.08, 0.15, 0.15] });
    sh.panel(
      [
        [side * 0.08, 0.15, 0.2],
        [side * 0.62, 0.17, 0.0],
        [side * 0.5, 0.16, -0.18],
        [side * 0.08, 0.15, 0.08],
      ],
      ACC,
      (p) => Math.abs(p[0]) / 0.62,
      UP,
    );
  }
  return sh;
}

function spider(): Shape {
  const sh = new Shape();
  sh.tube(
    [
      { c: [0, 0, 0.45], rx: 0, ry: 0 },
      { c: [0, 0, 0.3], rx: 0.17, ry: 0.13 },
      { c: [0, 0, 0.12], rx: 0.09, ry: 0.07 },
      { c: [0, 0.03, -0.12], rx: 0.3, ry: 0.25, paint: backBelly(PRI, shade(PRI, 0.7)) },
      { c: [0, 0.02, -0.45], rx: 0, ry: 0 },
    ],
    4,
  );
  for (const side of [1, -1]) {
    for (let i = 0; i < 4; i++) {
      const z = 0.36 - i * 0.07;
      const reach = [0.55, 0.35, 0.1, -0.3][i];
      sh.as({ part: Part.Leg, side, extra: i * 1.6 + (side > 0 ? 0 : Math.PI), pivot: [side * 0.1, 0, z] });
      sh.panel(
        [
          [side * 0.1, 0.01, z - 0.02],
          [side * 0.1, 0.01, z + 0.02],
          [side * 0.75, -0.18, z + reach],
        ],
        ACC,
        (p) => (Math.abs(p[0]) - 0.1) / 0.65,
        UP,
      );
    }
  }
  // The silk line, drawn as a camera-facing glint above the spider.
  sh.as({ part: Part.Silk, pivot: [0, 0.2, 0] });
  const a = sh.v(0, 0.2, 0, SEC, 0, { side: -1 });
  const b = sh.v(0, 0.2, 0, SEC, 0, { side: 1 });
  const c = sh.v(0, 0.2, 0, SEC, 1, { side: 1 });
  const d = sh.v(0, 0.2, 0, SEC, 1, { side: -1 });
  sh.tri(a, b, c);
  sh.tri(a, c, d);
  return sh;
}

function snail(): Shape {
  const sh = new Shape();
  // Foot and head (they slide back under the shell when it hides).
  sh.as({ part: Part.Retract, pivot: [0, 0.05, 0.0], extra: 0.18 });
  sh.tube(
    [
      { c: [0, 0.02, -0.5], rx: 0, ry: 0, s: 0, paint: SEC },
      { c: [0, 0.03, -0.3], rx: 0.1, ry: 0.03, s: 0.2, paint: SEC },
      { c: [0, 0.045, 0.05], rx: 0.12, ry: 0.05, s: 0.5, paint: SEC },
      { c: [0, 0.07, 0.32], rx: 0.08, ry: 0.06, s: 0.9, paint: SEC },
      { c: [0, 0.06, 0.43], rx: 0, ry: 0, s: 1, paint: SEC },
    ],
    4,
  );
  for (const side of [1, -1]) {
    sh.as({ part: Part.Retract, pivot: [0, 0.05, 0.0], extra: 0.3 });
    sh.panel(
      [
        [side * 0.03, 0.09, 0.31],
        [side * 0.05, 0.09, 0.33],
        [side * 0.075, 0.25, 0.44],
      ],
      [SEC, SEC, DARK],
      () => 1,
      [0, 0, 1],
    );
  }
  // The coiled shell (the spiral is painted by the shader).
  sh.as({ pattern: Pattern.Spiral });
  sh.tube(
    [
      { c: [0, 0.22, -0.26], rx: 0, ry: 0 },
      { c: [0, 0.29, -0.14], rx: 0.15, ry: 0.17 },
      { c: [0, 0.31, 0.04], rx: 0.17, ry: 0.2, ryb: 0.24 },
      { c: [0, 0.27, 0.18], rx: 0, ry: 0 },
    ],
    6,
  );
  return sh;
}

// ---------- the catalogue of body plans ----------

/** Build every body plan once. Index = AnimalModel value (HATCHLING_PLAN last). Firefly is drawn as points: null. */
export function buildAnimalGeometries(): (THREE.BufferGeometry | null)[] {
  const out: (THREE.BufferGeometry | null)[] = new Array(PLAN_COUNT).fill(null);
  const shapes: [number, () => Shape][] = [
    [AnimalModel.Seabird, seabird],
    [AnimalModel.Frigatebird, frigatebird],
    [AnimalModel.SmallBird, smallBird],
    [AnimalModel.Wader, wader],
    [AnimalModel.Shorebird, shorebird],
    [AnimalModel.Duck, duck],
    [AnimalModel.Bat, bat],
    [AnimalModel.Crab, crab],
    [AnimalModel.Lizard, lizard],
    [AnimalModel.Tortoise, tortoise],
    [AnimalModel.SeaTurtle, () => seaTurtle(false)],
    [AnimalModel.FishShoal, fish],
    [AnimalModel.Ray, ray],
    [AnimalModel.Dolphin, dolphin],
    [AnimalModel.Whale, whale],
    [AnimalModel.Butterfly, butterfly],
    [AnimalModel.Dragonfly, dragonfly],
    [AnimalModel.Bee, bee],
    [AnimalModel.Seal, seal],
    [AnimalModel.Spider, spider],
    [AnimalModel.Shark, shark],
    [AnimalModel.Snail, snail],
    [HATCHLING_PLAN, () => seaTurtle(true)],
  ];
  for (const [plan, make] of shapes) out[plan] = make().build();
  return out;
}

/** Triangles per body plan (0 for points). */
export function planTriangles(geoms: readonly (THREE.BufferGeometry | null)[]): number[] {
  return geoms.map((g) => (g && g.index ? g.index.count / 3 : 0));
}

// ---------- the shared creature material ----------

const VERTEX_PARS = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
attribute vec4 aPaint;
attribute vec4 aRig;
attribute vec3 aPivot;
attribute vec2 aPat;
attribute vec4 iPos;
attribute vec4 iQuat;
attribute vec4 iAnim;
attribute vec3 iCol;
varying vec3 vColBack;
varying vec4 vPat;
varying vec3 vC1;
varying vec3 vC2;
varying float vUnder;
varying float vGlow;
vec3 cPos;
vec3 cNrm;
vec3 cFront;

vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec2 rot2(vec2 v, float a) { float c = cos(a); float s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
vec3 unpackColor(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  return pow(vec3(r, g, b) / 255.0, vec3(2.2));
}

// Bend one vertex by its part (see Part in animals.ts), then place it in the world.
void creatureDeform() {
  vec3 p = position;
  vec3 n = normal;
  int part = int(aRig.x + 0.5);
  float s = aRig.y;
  float side = aRig.z;
  float sg = side < 0.0 ? -1.0 : 1.0;
  float ex = aRig.w;
  float ph = iAnim.x;
  float amp = iAnim.y;
  float fold = iAnim.z;
  float aux = iAnim.w;
  vec3 r = p - aPivot;
  if (part == 1) {
    // Wing: flap (the outer wing lags, for a whip). Folding tucks the outer wing over the inner one,
    // sweeps the wing back along the flank and turns it on edge (leading edge up).
    r.x *= 1.0 - 0.5 * fold;
    r.z *= 1.0 - 0.35 * fold;
    float th = amp * sin(ph - 0.9 * s) * (1.0 - fold);
    r.xy = rot2(r.xy, sg * th); n.xy = rot2(n.xy, sg * th);
    float sweep = sg * fold * 1.45;
    r.zx = rot2(r.zx, sweep); n.zx = rot2(n.zx, sweep);
    float edge = sg * fold * 1.5;
    r.xy = rot2(r.xy, edge); n.xy = rot2(n.xy, edge);
    p = aPivot + r + fold * vec3(sg * 0.01, -0.04, 0.0);
  } else if (part == 2) {
    float kind = abs(side);
    float swing = sin(ph + ex) * amp;
    if (kind < 1.5) {
      // Sprawled leg: swing forward/back, lift the foot on the forward stroke.
      r.zx = rot2(r.zx, sg * swing * 0.5);
      r.y += max(0.0, cos(ph + ex)) * amp * 0.35 * length(r.xz);
    } else {
      // Upright leg: swing in the walking plane; bird legs tuck back in flight.
      float tuck = kind > 2.5 ? (1.0 - fold) : 0.0;
      float a = -swing * 0.55 + tuck * 1.35;
      r.yz = rot2(r.yz, a); n.yz = rot2(n.yz, a);
    }
    p = aPivot + r;
  } else if (part == 3) {
    float peck = max(aux, 0.0) * s;
    float turn = max(-aux, 0.0) * s;
    r.yz = rot2(r.yz, peck); n.yz = rot2(n.yz, peck);
    r.zx = rot2(r.zx, turn * 2.4); n.zx = rot2(n.zx, turn * 2.4);
    p = aPivot + r;
  } else if (part == 4) {
    float k = s < 0.0 ? 0.3 : 1.0;
    p.x += amp * 0.22 * sin(ph - s * 3.2) * s * abs(s) * k;
  } else if (part == 5) {
    float k = s < 0.0 ? 0.3 : 1.0;
    p.y += amp * 0.12 * sin(ph - s * 2.6) * s * abs(s) * k;
  } else if (part == 6) {
    float rear = step(1.5, abs(side));
    float k = mix(1.0, 0.45, rear);
    float th = amp * k * 0.8 * sin(ph + ex) + rear * aux * (0.7 + 0.5 * sin(ph * 3.0));
    r.xy = rot2(r.xy, sg * th); n.xy = rot2(n.xy, sg * th);
    float sw = amp * k * 0.45 * cos(ph + ex);
    r.zx = rot2(r.zx, sg * sw); n.zx = rot2(n.zx, sg * sw);
    p = aPivot + r;
  } else if (part == 7) {
    float a = -fold * 1.1 + sin(ph * 0.5 + side) * amp * 0.15;
    r.yz = rot2(r.yz, a); n.yz = rot2(n.yz, a);
    p = aPivot + r;
  } else if (part == 8) {
    p = aPivot + r * mix(ex, 1.0, clamp(aux, 0.0, 1.0));
  } else if (part == 9) {
    p = aPivot + vec3(0.0, s * aux, 0.0);
  } else if (part == 10) {
    r *= 1.0 - 0.3 * fold * s;
    r.z -= fold * ex * s;
    p = aPivot + r;
  } else if (part == 11) {
    p.x += sin(uTime * 4.0 + iPos.x * 0.7 - s * 5.0) * s * 0.05 * (0.4 + amp);
    p.y += sin(uTime * 3.1 + iPos.z * 0.7 - s * 4.0) * s * 0.025;
  } else if (part == 12) {
    float th = mix(ex + amp * sin(ph), 1.5, fold);
    r.xy = rot2(r.xy, sg * th); n.xy = rot2(n.xy, sg * th);
    p = aPivot + r;
  } else if (part == 13) {
    float ax = abs(p.x);
    p.y += amp * 0.32 * sin(ph - ax * 2.5) * ax;
  }
  cPos = iPos.xyz + qrot(iQuat, p * iPos.w);
  cNrm = qrot(iQuat, n);

  vec3 c0 = unpackColor(iCol.x);
  vec3 c1 = unpackColor(iCol.y);
  vec3 c2 = unpackColor(iCol.z);
  float rest = max(0.0, 1.0 - aPaint.x - aPaint.y - aPaint.z);
  vec3 base = (aPaint.x * c0 + aPaint.y * c1 + aPaint.z * c2 + rest * vec3(0.012)) * aPaint.w;
  cFront = base;
  // Flat panels show the secondary colour underneath (pale underwings); a folded wing shows its upper side.
  vColBack = mix(base, c1 * aPaint.w, part == 1 ? aPat.y * (1.0 - fold) : aPat.y);
  vGlow = 0.0;
  if (part == 4) cFront += ex * clamp(aux, 0.0, 1.0) * vec3(0.55);
  if (part == 9) {
    // Silk: a camera-facing line about a pixel wide that glints (fold = how much light it catches).
    vec3 axis = qrot(iQuat, vec3(0.0, 1.0, 0.0));
    vec3 toCam = cameraPosition - cPos;
    float dist = length(toCam);
    vec3 across = normalize(cross(axis, toCam) + vec3(1e-5, 0.0, 0.0));
    float hw = fold > 0.02 ? max(0.0006, dist * 0.0009) : 0.0;
    cPos += across * sg * hw;
    cNrm = toCam / max(dist, 1e-3);
    float g = fold * (0.55 + 0.45 * sin(s * 18.0 - uTime * 2.5));
    cFront = c1 * (0.5 + g);
    vColBack = cFront;
    vGlow = g * 0.8;
  }
  vPat = vec4(position, aPat.x);
  vC1 = c1;
  vC2 = c2;
  vUnder = clamp((uSeaLevel - 0.05 - cPos.y) * 0.12, 0.0, 0.45);
}
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vColBack;
varying vec4 vPat;
varying vec3 vC1;
varying vec3 vC2;
varying float vUnder;
varying float vGlow;

// Sin-free hash (no textures, no trig).
float cHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 creaturePattern(vec3 c, bool front) {
  float k = vPat.w;
  vec3 lp = vPat.xyz;
  if (k < 0.5) return c;
  if (k < 1.5) {
    // Spots (eagle ray): pale dots on a hashed grid, top side only.
    if (!front) return c;
    vec2 g = lp.xz * 9.0;
    vec2 id = floor(g);
    vec2 f = fract(g) - 0.5;
    vec2 o = vec2(cHash(id), cHash(id + 7.13)) - 0.5;
    float rad = 0.13 + 0.1 * cHash(id + 3.71);
    float d = length(f - o * 0.45);
    return mix(c, vC1, 1.0 - smoothstep(rad - 0.05, rad, d));
  }
  if (k < 2.5) {
    // Butterfly wing: dark veins fanning from the body, a dark margin with pale spots.
    float x = abs(lp.x);
    float ang = atan(lp.z, x);
    float rad = length(vec2(x, lp.z));
    float vein = (1.0 - smoothstep(0.0, 0.07, abs(fract(ang * 2.4 + 0.5) - 0.5))) * smoothstep(0.12, 0.3, rad);
    float margin = smoothstep(0.36, 0.42, rad);
    vec3 col = mix(c, vC1, max(vein * 0.7, margin));
    float spot = 1.0 - smoothstep(0.02, 0.035, length(vec2(x, lp.z) - normalize(vec2(x, lp.z) + 1e-4) * 0.44));
    return mix(col, vC2, spot * margin * (front ? 1.0 : 0.4));
  }
  if (k < 3.5) {
    // Shell plates: offset cells with dark seams.
    vec2 g = lp.xz * vec2(6.5, 5.5);
    g.x += floor(g.y) * 0.5;
    vec2 f = abs(fract(g) - 0.5);
    float seam = smoothstep(0.38, 0.47, max(f.x, f.y));
    vec3 col = mix(c, c * (0.8 + 0.4 * cHash(floor(g))), 0.6);
    return mix(col, vC2 * 0.8, seam * 0.75);
  }
  if (k < 4.5) {
    // Bands across the body (bees).
    float b = smoothstep(0.42, 0.5, abs(fract(lp.z * 5.0) - 0.5) * 2.0 - 0.0);
    return lp.z < 0.05 ? mix(c, vC1, b) : c;
  }
  if (k < 5.5) {
    // Spiral bands on a snail shell.
    float a = atan(lp.y - 0.29, lp.z + 0.05);
    float rr = length(vec2(lp.y - 0.29, lp.z + 0.05));
    float band = smoothstep(0.3, 0.5, abs(fract(a / 6.2832 + rr * 6.0) - 0.5) * 2.0);
    return mix(c, vC2, band * 0.8);
  }
  // Mottle: darker flecks on the back.
  vec2 g = lp.xz * 26.0;
  float m = cHash(floor(g));
  return lp.y > 0.12 ? c * (0.75 + 0.35 * m) : c;
}
`;

export interface CreatureMaterials {
  /** Lit, double-sided creature material (one program for every body plan). */
  material: THREE.MeshLambertMaterial;
  /** Matching shadow-map material with the same vertex animation. */
  depth: THREE.MeshDepthMaterial;
}

const materialCache = new WeakMap<WorldUniforms, CreatureMaterials>();

/** The one shared creature material (cached per set of world uniforms, so fauna and vignettes share it). */
export function creatureMaterials(u: WorldUniforms): CreatureMaterials {
  const hit = materialCache.get(u);
  if (hit) return hit;
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.shadowSide = THREE.DoubleSide;
  material.onBeforeCompile = (shader) => {
    addWorldUniforms(shader, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <color_vertex>', 'creatureDeform();\nvColor = vec4(cFront, 1.0);')
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = cNrm;')
      .replace('#include <begin_vertex>', 'vec3 transformed = cPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        '#include <color_fragment>',
        `vec3 cBase = gl_FrontFacing ? vColor.rgb : vColBack;
cBase = creaturePattern(cBase, gl_FrontFacing);
cBase = mix(cBase, vec3(0.02, 0.2, 0.24), vUnder);
diffuseColor.rgb *= cBase;`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cBase * vGlow;');
  };
  const depth = new THREE.MeshDepthMaterial();
  depth.onBeforeCompile = (shader) => {
    addWorldUniforms(shader, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
      .replace('#include <begin_vertex>', 'creatureDeform();\nvec3 transformed = cPos;');
  };
  const out = { material, depth };
  materialCache.set(u, out);
  return out;
}

// ---------- instanced batches ----------

/**
 * One instanced draw of one body plan. Fill with add() between begin() and end() each frame.
 * Instance layout: iPos (x, y, z, scale), iQuat (rotation), iAnim (phase, amp, fold, aux), iCol (packed colours).
 */
export class CreatureBatch {
  readonly mesh: THREE.Mesh;
  readonly capacity: number;
  readonly triangles: number;
  count = 0;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aQuat: THREE.InstancedBufferAttribute;
  private readonly aAnim: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  /** The four per-instance attributes, for marking what changed each frame. */
  private readonly attrs: readonly THREE.InstancedBufferAttribute[];
  private readonly pos: Float32Array;
  private readonly quat: Float32Array;
  private readonly anim: Float32Array;
  private readonly col: Float32Array;
  private minX = 0;
  private minY = 0;
  private minZ = 0;
  private maxX = 0;
  private maxY = 0;
  private maxZ = 0;
  private maxScale = 0;

  constructor(base: THREE.BufferGeometry, capacity: number, mats: CreatureMaterials) {
    this.capacity = capacity;
    this.triangles = base.index ? base.index.count / 3 : 0;
    const g = new THREE.InstancedBufferGeometry();
    for (const name of Object.keys(base.attributes)) g.setAttribute(name, base.getAttribute(name));
    g.setIndex(base.index);
    this.pos = new Float32Array(capacity * 4);
    this.quat = new Float32Array(capacity * 4);
    this.anim = new Float32Array(capacity * 4);
    this.col = new Float32Array(capacity * 3);
    const inst = (arr: Float32Array, size: number) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = inst(this.pos, 4);
    this.aQuat = inst(this.quat, 4);
    this.aAnim = inst(this.anim, 4);
    this.aCol = inst(this.col, 3);
    this.attrs = [this.aPos, this.aQuat, this.aAnim, this.aCol];
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iQuat', this.aQuat);
    g.setAttribute('iAnim', this.aAnim);
    g.setAttribute('iCol', this.aCol);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    g.boundingBox = new THREE.Box3();
    this.geo = g;
    this.mesh = new THREE.Mesh(g, mats.material);
    this.mesh.customDepthMaterial = mats.depth;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
  }

  begin(): void {
    this.count = 0;
    this.minX = this.minY = this.minZ = Infinity;
    this.maxX = this.maxY = this.maxZ = -Infinity;
    this.maxScale = 0;
  }

  /** Add one animal (its three colours read from `colors` at `co`). Returns false when the batch is full. */
  add(x: number, y: number, z: number, scale: number, q: THREE.Quaternion, ph: number, amp: number, fold: number, aux: number, colors: ArrayLike<number>, co = 0): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    const o4 = i * 4;
    this.pos[o4] = x;
    this.pos[o4 + 1] = y;
    this.pos[o4 + 2] = z;
    this.pos[o4 + 3] = scale;
    this.quat[o4] = q.x;
    this.quat[o4 + 1] = q.y;
    this.quat[o4 + 2] = q.z;
    this.quat[o4 + 3] = q.w;
    this.anim[o4] = ph;
    this.anim[o4 + 1] = amp;
    this.anim[o4 + 2] = fold;
    this.anim[o4 + 3] = aux;
    const o3 = i * 3;
    this.col[o3] = colors[co];
    this.col[o3 + 1] = colors[co + 1];
    this.col[o3 + 2] = colors[co + 2];
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
    if (scale > this.maxScale) this.maxScale = scale;
    return true;
  }

  /** Upload what was added this frame and size the culling sphere around it. `reach` = extra body lengths beyond the origin (wings, silk). */
  end(castShadow: boolean, reach = 1.6): void {
    const n = this.count;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    this.mesh.castShadow = castShadow && n > 0;
    if (n === 0) return;
    // Upload only the filled part of each buffer.
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k];
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    const sp = this.geo.boundingSphere as THREE.Sphere;
    const pad = this.maxScale * reach;
    sp.center.set((this.minX + this.maxX) * 0.5, (this.minY + this.maxY) * 0.5, (this.minZ + this.maxZ) * 0.5);
    sp.radius = 0.5 * Math.hypot(this.maxX - this.minX, this.maxY - this.minY, this.maxZ - this.minZ) + pad;
  }

  dispose(): void {
    this.geo.dispose();
  }
}

// ---------- soft points: specks, fireflies, splashes, mist, motes ----------

/** Point sprite looks. */
export const PointKind = {
  /** Soft glow with a bright core (fireflies, glow motes). */
  Glow: 0,
  /** A far bird: a small flapping "V" (the fractional part of the kind is the wing beat, 0..1). */
  Speck: 1,
  /** A soft puff (whale blow, splash spray, wake). */
  Mist: 2,
  /** A four-pointed sparkle (glinting seeds and motes). */
  Sparkle: 3,
  /** A small round dot (drops, flicked sand). */
  Dot: 4,
} as const;

const POINTS_VERTEX = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
attribute float aKind;
uniform float uViewH;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec4 vColor;
varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(0.05, -mv.z);
  float px = aSize * projectionMatrix[1][1] * 0.5 * uViewH / depth;
  float kind = floor(aKind + 0.001);
  float minPx = kind < 1.5 ? 2.6 : (kind < 2.5 ? 1.5 : 2.0);
  gl_PointSize = clamp(px, minPx, 72.0);
  float fog = smoothstep(uFogNear, uFogFar, length(mv.xyz));
  vColor = vec4(mix(aColor.rgb, uFogColor, fog * (kind < 0.5 ? 0.35 : 1.0)), aColor.a * clamp(px / minPx, 0.35, 1.0));
  vKind = aKind;
  gl_Position = projectionMatrix * mv;
}
`;

const POINTS_FRAGMENT = /* glsl */ `
varying vec4 vColor;
varying float vKind;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  float kind = floor(vKind + 0.001);
  float r2 = dot(p, p);
  float a;
  if (kind < 0.5) {
    a = exp(-r2 * 7.0) * 0.75 + exp(-r2 * 40.0) * 0.6;
  } else if (kind < 1.5) {
    float beat = fract(vKind) * 2.0 - 1.0;
    vec2 q = vec2(abs(p.x), p.y);
    vec2 a0 = vec2(0.0, -0.15);
    vec2 tip = vec2(0.92, 0.12 + 0.42 * beat);
    vec2 ba = tip - a0;
    vec2 pa = q - a0;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float d = length(pa - ba * h);
    a = 1.0 - smoothstep(0.07, 0.17, d);
  } else if (kind < 2.5) {
    a = max(0.0, 1.0 - r2);
    a *= a * 0.6;
  } else if (kind < 3.5) {
    vec2 q = abs(p);
    a = max(exp(-q.x * 9.0) * exp(-q.y * 2.2), exp(-q.y * 9.0) * exp(-q.x * 2.2)) + exp(-r2 * 14.0) * 0.6;
  } else {
    a = 1.0 - smoothstep(0.45, 1.0, sqrt(r2));
  }
  a = min(1.0, a) * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
  #include <colorspace_fragment>
}
`;

/** A pool of soft point sprites drawn in one call. Colours are linear RGB. Fill between begin() and end() each frame. */
export class SoftPoints {
  readonly points: THREE.Points;
  readonly capacity: number;
  count = 0;
  private readonly geo: THREE.BufferGeometry;
  private readonly pos: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly kind: Float32Array;
  private readonly attrs: THREE.BufferAttribute[];
  private readonly viewH: { value: number };
  private minX = 0;
  private minY = 0;
  private minZ = 0;
  private maxX = 0;
  private maxY = 0;
  private maxZ = 0;

  constructor(capacity: number, u: WorldUniforms) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.color = new Float32Array(capacity * 4);
    this.kind = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    const attr = (arr: Float32Array, n: number) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [attr(this.pos, 3), attr(this.size, 1), attr(this.color, 4), attr(this.kind, 1)];
    g.setAttribute('position', this.attrs[0]);
    g.setAttribute('aSize', this.attrs[1]);
    g.setAttribute('aColor', this.attrs[2]);
    g.setAttribute('aKind', this.attrs[3]);
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    this.geo = g;
    this.viewH = { value: 800 };
    const mat = new THREE.ShaderMaterial({
      uniforms: { uViewH: this.viewH, uFogColor: u.uFogColor, uFogNear: u.uFogNear, uFogFar: u.uFogFar },
      vertexShader: POINTS_VERTEX,
      fragmentShader: POINTS_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, mat);
    this.points.matrixAutoUpdate = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  begin(): void {
    this.count = 0;
    this.minX = this.minY = this.minZ = Infinity;
    this.maxX = this.maxY = this.maxZ = -Infinity;
  }

  /** Add one sprite: world position, world size (m), linear colour and alpha, PointKind (+ fraction for specks). */
  add(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.size[i] = size;
    this.color[i * 4] = r;
    this.color[i * 4 + 1] = g;
    this.color[i * 4 + 2] = b;
    this.color[i * 4 + 3] = a;
    this.kind[i] = kind;
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (z < this.minZ) this.minZ = z;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
    if (z > this.maxZ) this.maxZ = z;
    return true;
  }

  /** Upload this frame's sprites. `viewH` = drawing-buffer height in pixels (for size attenuation). */
  end(viewH: number): void {
    const n = this.count;
    this.viewH.value = viewH;
    this.geo.setDrawRange(0, n);
    this.points.visible = n > 0;
    if (n === 0) return;
    for (let k = 0; k < this.attrs.length; k++) {
      const a = this.attrs[k];
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    const sp = this.geo.boundingSphere as THREE.Sphere;
    sp.center.set((this.minX + this.maxX) * 0.5, (this.minY + this.maxY) * 0.5, (this.minZ + this.maxZ) * 0.5);
    sp.radius = 0.5 * Math.hypot(this.maxX - this.minX, this.maxY - this.minY, this.maxZ - this.minZ) + 2;
  }

  dispose(): void {
    this.geo.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** sRGB hex to linear RGB (written into `out` at `o`). */
export function hexToLinear(hex: number, out: Float32Array | number[], o = 0): void {
  out[o] = srgbByteToLinear((hex >> 16) & 255);
  out[o + 1] = srgbByteToLinear((hex >> 8) & 255);
  out[o + 2] = srgbByteToLinear(hex & 255);
}

function srgbByteToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
