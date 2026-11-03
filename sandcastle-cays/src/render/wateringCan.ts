/**
 * The watering can you carry in the garden: an old galvanised can with a
 * long spout and a brass rose, a strap handle over the top and another at
 * the back. Made in code; the zinc spangle is a code-painted texture.
 *
 * `canModel()` gives the can at real size (about 43 cm from the back handle
 * to the rose, 29 cm to the top of the handle), +Y up with the spout toward
 * +x, origin at the middle of its base. `grip` is where your hand holds the
 * top handle; `rose` and `roseDir` are the rose's face and which way it
 * points, for the water.
 *
 * `CanStream` draws the little stream from the rose: a few thin ribbons of
 * falling water, rebuilt each frame from where the rose is.
 */
import * as THREE from 'three';
import { TAU, clamp, lin, mixC, mulC, smooth, type C3, type V3 } from './finds';
import { Mesher, lump, tubeAlong } from './gardenPlants';
import { spangleTex, streamTex } from './gardenPaint';

export interface WateringCan {
  group: THREE.Group;
  /** Where your hand holds the top handle (can space). */
  grip: THREE.Vector3;
  /** Middle of the rose's face, and the way it points (can space). */
  rose: THREE.Vector3;
  roseDir: THREE.Vector3;
}

const C = (hex: number): C3 => lin(hex);
const RX = 0.08;
const RZ = 0.066;
const SPOUT0: V3 = [0.072, 0.035, 0];
const SPOUT1: V3 = [0.3, 0.25, 0];
const ROSE_LEN = 0.03;
const GRIP: V3 = [0, 0.292, 0];

let canGeo: THREE.BufferGeometry | null = null;
let canMat: THREE.MeshStandardMaterial | null = null;

function spoutDir(): V3 {
  const d: V3 = [SPOUT1[0] - SPOUT0[0], SPOUT1[1] - SPOUT0[1], 0];
  const l = Math.hypot(d[0], d[1]);
  return [d[0] / l, d[1] / l, 0];
}

function buildCan(): THREE.BufferGeometry {
  const m = new Mesher();
  const zinc = C(0xb3b8bb);
  const dull = C(0x8f969a);
  // ---- the body: an oval drum with rolled beads top and bottom and a band round the middle ----
  const rows: [number, number][] = [
    [0, 0.003],
    [0.9, 0.0],
    [0.985, 0.002],
    [1.0, 0.008],
    [1.014, 0.012],
    [1.0, 0.017],
    [1.0, 0.088],
    [1.012, 0.093],
    [1.012, 0.106],
    [1.0, 0.111],
    [1.0, 0.176],
    [1.016, 0.182],
    [1.0, 0.189],
    [0.86, 0.196],
    [0.55, 0.202],
    [0.22, 0.205],
    [0, 0.2055],
  ];
  const nu = 26;
  m.grid(
    nu,
    rows.length - 1,
    (i, j) => {
      const a = (-TAU * i) / nu;
      const [k, y] = rows[j];
      const bead = k > 1.005 ? 1 : 0;
      const col = mixC(zinc, dull, 0.25 * bead + 0.3 * smooth(0.03, 0.0, y) + 0.15 * (0.5 + 0.5 * Math.sin(a * 3 + y * 40)));
      return { p: [RX * k * Math.cos(a), y, RZ * k * Math.sin(a)], c: col, uv: [(i / nu) * 3, y * 5], n: j === 0 ? [0, -1, 0] : [0, 1, 0] };
    },
    true,
  );
  // the filling hole on top, toward the back, with a raised collar
  {
    const cx = -0.03;
    const hr: [number, number] = [0.032, 0.028];
    m.grid(
      16,
      1,
      (i, j) => {
        const a = (TAU * i) / 16;
        const r = j === 0 ? 0 : 1;
        return { p: [cx + hr[0] * r * Math.cos(a), 0.2068, hr[1] * r * Math.sin(a)], c: C(0x2a2c2e), uv: [0, 0], n: [0, 1, 0] };
      },
      true,
    );
    const ring: V3[] = [];
    for (let k = 0; k <= 16; k++) {
      const a = (TAU * k) / 16;
      ring.push([cx + (hr[0] + 0.002) * Math.cos(a), 0.2085, (hr[1] + 0.002) * Math.sin(a)]);
    }
    tubeAlong(m, ring, { nu: 4, r: () => 0.0035, col: () => zinc, uv: (t) => [t * 2, 0.2] });
  }
  // ---- the spout, a stay from the body, and the rose ----
  const sd = spoutDir();
  const spout: V3[] = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    spout.push([SPOUT0[0] + (SPOUT1[0] - SPOUT0[0]) * t, SPOUT0[1] + (SPOUT1[1] - SPOUT0[1]) * t + 0.01 * Math.sin(Math.PI * t), 0]);
  }
  spout.unshift([SPOUT0[0] - 0.02, SPOUT0[1] - 0.006, 0]);
  tubeAlong(m, spout, { nu: 8, r: (t) => 0.0145 - 0.0055 * t, col: (t) => mixC(zinc, dull, 0.2 + 0.2 * Math.sin(t * 9)), uv: (t, a) => [t * 3, a / TAU] });
  const mid = spout[4];
  tubeAlong(m, [[0.068, 0.168, 0], [0.12, 0.158, 0], [mid[0], mid[1] + 0.006, 0]], { nu: 4, r: () => 0.0028, col: () => dull, uv: (t) => [t, 0.5] });
  {
    const tip = SPOUT1;
    const brass = C(0xc39a4c);
    const dark = C(0x5a4520);
    // cone flaring out to the face, then the slightly domed face
    const prof: [number, number][] = [
      [0.0075, -0.004],
      [0.0095, 0.004],
      [0.024, ROSE_LEN - 0.006],
      [0.03, ROSE_LEN - 0.001],
      [0.03, ROSE_LEN + 0.002],
      [0.024, ROSE_LEN + 0.0035],
      [0.017, ROSE_LEN + 0.0042],
      [0.01, ROSE_LEN + 0.0046],
      [0, ROSE_LEN + 0.0048],
    ];
    const T = sd;
    const S: V3 = [0, 0, 1];
    const U: V3 = [-T[1], T[0], 0];
    m.grid(
      14,
      prof.length - 1,
      (i, j) => {
        const a = (TAU * i) / 14;
        const [r, d] = prof[j];
        const dir: V3 = [S[0] * Math.cos(a) - U[0] * Math.sin(a), S[1] * Math.cos(a) - U[1] * Math.sin(a), S[2] * Math.cos(a) - U[2] * Math.sin(a)];
        // rings of holes in the face
        const face = j >= 5;
        const col = face ? (j % 2 === 0 ? mixC(brass, dark, 0.65) : brass) : mulC(brass, 0.9 + 0.1 * (j / 4));
        return { p: [tip[0] + T[0] * d + dir[0] * r, tip[1] + T[1] * d + dir[1] * r, tip[2] + T[2] * d + dir[2] * r], c: col, uv: [0.5, 0.5], n: T };
      },
      true,
    );
  }
  // ---- handles: a strap over the top and one down the back ----
  const strap = (t: number, a: number): number => {
    void t;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return 1 / Math.sqrt((c / 0.0095) ** 2 + (s / 0.0032) ** 2);
  };
  const top: V3[] = [];
  for (let k = 0; k <= 10; k++) {
    const t = k / 10;
    const a = Math.PI * (1 - t);
    top.push([0.065 * Math.cos(a) - 0.005, 0.192 + 0.1 * Math.pow(Math.sin(a), 0.8), 0]);
  }
  tubeAlong(m, top, { nu: 6, r: strap, col: (t) => mixC(zinc, dull, 0.3 * Math.sin(Math.PI * t)), uv: (t) => [t * 2, 0.3] });
  const back: V3[] = [
    [-0.076, 0.186, 0],
    [-0.1, 0.19, 0],
    [-0.122, 0.17, 0],
    [-0.128, 0.13, 0],
    [-0.12, 0.085, 0],
    [-0.098, 0.06, 0],
    [-0.078, 0.052, 0],
  ];
  tubeAlong(m, back, { nu: 6, r: strap, col: () => zinc, uv: (t) => [t * 2, 0.6] });
  // rivets where the handles meet the body
  for (const p of [
    [-0.07, 0.195, 0],
    [0.06, 0.195, 0],
    [-0.08, 0.052, 0],
  ] as V3[]) {
    lump(m, p, [0, 1, 0], 0.008, 6, 3, (t) => 0.004 * Math.sin(Math.PI * t), () => dull);
  }
  return m.geometry();
}

/** A new watering can (the geometry and material are shared). */
export function canModel(): WateringCan {
  canGeo ??= buildCan();
  canMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, map: spangleTex(), metalness: 0.65, roughness: 0.38 });
  canMat.name = 'garden:can';
  const mesh = new THREE.Mesh(canGeo, canMat);
  mesh.name = 'watering-can';
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.name = 'can';
  group.add(mesh);
  const sd = spoutDir();
  const rose = new THREE.Vector3(SPOUT1[0] + sd[0] * (ROSE_LEN + 0.005), SPOUT1[1] + sd[1] * (ROSE_LEN + 0.005), 0);
  return { group, grip: new THREE.Vector3(...GRIP), rose, roseDir: new THREE.Vector3(sd[0], sd[1], 0) };
}

/** Triangles in the can's model. */
export function canTriangles(): number {
  canGeo ??= buildCan();
  return canGeo.index ? canGeo.index.count / 3 : 0;
}

/**
 * A little stream of water from the rose: thin ribbons falling in an arc,
 * turned to face the eye. Call `update` every frame with the rose's place
 * and direction (in the same space as the mesh) and how hard it's flowing
 * (0 = nothing, hidden).
 */
export class CanStream {
  readonly mesh: THREE.Mesh;
  private readonly strands: number;
  private readonly segs: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly spread: { off: THREE.Vector2; v: THREE.Vector3; w: number }[] = [];
  private readonly tex: THREE.Texture;
  private readonly tmp = { p: new THREE.Vector3(), q: new THREE.Vector3(), t: new THREE.Vector3(), e: new THREE.Vector3(), s: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3() };

  constructor(strands = 7, segs = 10) {
    this.strands = strands;
    this.segs = segs;
    const nv = strands * (segs + 1) * 2;
    this.pos = new Float32Array(nv * 3);
    this.col = new Float32Array(nv * 4);
    const uv = new Float32Array(nv * 2);
    const idx: number[] = [];
    for (let s = 0; s < strands; s++) {
      const lane = s % 4;
      for (let k = 0; k <= segs; k++) {
        const o = (s * (segs + 1) + k) * 2;
        uv.set([(lane + 0.05) / 4, (k / segs) * 1.5 + s * 0.37, (lane + 0.95) / 4, (k / segs) * 1.5 + s * 0.37], o * 2);
        if (k < segs) idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
      // where on the rose's face it comes from, and how it fans out
      const a = (s / strands) * TAU + 0.3;
      const r = s === 0 ? 0 : 0.6 + 0.4 * ((s * 7) % 3) / 2;
      this.spread.push({ off: new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r), v: new THREE.Vector3(Math.cos(a) * r * 0.22, Math.sin(a) * r * 0.22, 0), w: 0.0026 + 0.0012 * ((s * 5) % 3) / 2 });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.tex = streamTex().clone();
    this.tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, color: 0xe6f6ff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: true });
    mat.name = 'garden:stream';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'can-stream';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * Rebuild the stream: from `rose` (face middle) along `dir`, falling with
   * `gravity`, turned toward `eye`; `flow` 0..1 fades it in and out; `time`
   * scrolls the water along.
   */
  update(rose: THREE.Vector3, dir: THREE.Vector3, flow: number, time: number, eye: THREE.Vector3, gravity = new THREE.Vector3(0, -9.8, 0)): void {
    const f = clamp(flow, 0, 1);
    this.mesh.visible = f > 0.01;
    if (!this.mesh.visible) return;
    const { p, q, t, e, s, a, b } = this.tmp;
    // two directions across the rose's face
    a.set(0, 0, 1).cross(dir);
    if (a.lengthSq() < 1e-6) a.set(1, 0, 0);
    a.normalize();
    b.copy(dir).cross(a).normalize();
    const speed = 1.15;
    const tMax = 0.36;
    for (let si = 0; si < this.strands; si++) {
      const sp = this.spread[si];
      for (let k = 0; k <= this.segs; k++) {
        const u = k / this.segs;
        // the stream lengthens as the flow starts
        const tau = tMax * u * (0.35 + 0.65 * f);
        // position along a falling arc
        p.copy(rose).addScaledVector(a, sp.off.x * 0.018).addScaledVector(b, sp.off.y * 0.018);
        q.copy(dir).multiplyScalar(speed).addScaledVector(a, sp.v.x * speed).addScaledVector(b, sp.v.y * speed);
        t.copy(q).addScaledVector(gravity, tau).normalize();
        p.addScaledVector(q, tau).addScaledVector(gravity, 0.5 * tau * tau);
        // ribbon across, facing the eye
        e.copy(eye).sub(p);
        s.copy(t).cross(e);
        if (s.lengthSq() < 1e-9) s.set(1, 0, 0);
        s.normalize().multiplyScalar(sp.w * (1 + 0.6 * u) * 0.5);
        const o = (si * (this.segs + 1) + k) * 2;
        this.pos[o * 3] = p.x - s.x;
        this.pos[o * 3 + 1] = p.y - s.y;
        this.pos[o * 3 + 2] = p.z - s.z;
        this.pos[o * 3 + 3] = p.x + s.x;
        this.pos[o * 3 + 4] = p.y + s.y;
        this.pos[o * 3 + 5] = p.z + s.z;
        const alpha = f * smooth(0, 0.12, u) * smooth(1, 0.55, u) * 0.9;
        for (let c = 0; c < 2; c++) this.col.set([1, 1, 1, alpha], (o + c) * 4);
      }
    }
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('color').needsUpdate = true;
    this.tex.offset.y = -time * 2.4;
  }
}
