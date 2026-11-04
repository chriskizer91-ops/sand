/**
 * Shared building kit for the boats: merged-mesh builder (Part), rounded boxes,
 * tubes and sweeps, code-painted textures (teak, varnish, non-skid, sailcloth),
 * foil lofts, and DynPart (a mesh whose pieces move or come and go).
 * Copied from the sloop (src/render/sloop.ts) so the catamaran can share them
 * without changing the sloop; the sloop keeps its own copies until it retires.
 */
import * as THREE from 'three';

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const smooth01 = (t: number) => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Monotone cubic interpolation (no overshoot) through (xs, ys). */
export function pchip(xs: number[], ys: number[]): (x: number) => number {
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

export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type RGB = [number, number, number];
export function rgb(hex: number): RGB {
  const c = new THREE.Color(hex); // sRGB hex -> linear working colour
  return [c.r, c.g, c.b];
}
export const WHITE: RGB = [1, 1, 1];

export type Hint = THREE.Vector3 | ((p: THREE.Vector3) => THREE.Vector3);

/** Accumulates the triangles of one material; becomes one mesh (one draw call). */
export class Part {
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

export function M(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), V(sx, sy, sz));
}

/** Matrix placing a +y-axis primitive between points a and b. */
export function between(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize());
  return new THREE.Matrix4().compose(mid, q, V(1, 1, 1));
}

/** A box with rounded edges and corners (radius r), centred at the origin. UVs run in metres along x (wood grain). */
export function roundedBox(sx: number, sy: number, sz: number, r: number, seg = Math.max(sx, sy, sz) < 0.15 ? 1 : 2): THREE.BufferGeometry {
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
export function tube(
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

export function rod(p: Part, a: THREE.Vector3, b: THREE.Vector3, r: number, radial: number, c: RGB, caps = false): void {
  tube(p, [a, b], r, radial, c, caps);
}

export function curve(ctrl: THREE.Vector3[], n: number): THREE.Vector3[] {
  return new THREE.CatmullRomCurve3(ctrl, false, 'centripetal').getPoints(n);
}

/**
 * Sweeps a 2D profile (in the plane across the path: [side, up]) along a path whose up direction is +y.
 * Corners are mitred. Used for toerails and rubrails.
 */
export function sweep(p: Part, path: THREE.Vector3[], profile: [number, number][], closedPath: boolean, c: RGB, uvScale = 2): void {
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
export function periodicNoise(gw: number, gh: number, rnd: () => number): (u: number, v: number) => number {
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

export function finishTexture(data: Uint8Array, w: number, h: number): THREE.DataTexture {
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

export const PLANK = 0.09; // plank width (m)
export const PLANKS_IN_TEX = 8;
export const TEX_V = PLANK * PLANKS_IN_TEX; // metres across the planks per texture repeat
export const TEX_U = 3.0; // metres along the planks per texture repeat

/** Teak deck planks with black caulking seams and staggered butt joints. u runs along the planks. */
export function paintTeak(): THREE.DataTexture {
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
export function paintVarnish(): THREE.DataTexture {
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
export function paintNonSkid(): THREE.DataTexture {
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

export const nacaShape = (q: number) => 5 * (0.2969 * Math.sqrt(q) - 0.126 * q - 0.3516 * q * q + 0.2843 * q ** 3 - 0.1036 * q ** 4);

export interface FoilSec {
  y: number;
  xLE: number;
  chord: number;
  half: number;
}

/** A foil-section loft (keel, rudder) from top to bottom. Sections with half = 0 close the ends. */
export function foilLoft(p: Part, secs: FoilSec[], n: number, c: RGB = WHITE): void {
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



export function rrLoop(x0: number, x1: number, hw: number, r: number, nc: number): [number, number][] {
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

export class DynPart {
  readonly part = new Part();
  /** Hidden pieces collapse to this point (somewhere nothing can see it). */
  constructor(private hideAt: THREE.Vector3 = new THREE.Vector3(0, 1, 0)) {}
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
  /** Collapse a piece to the hiding point. */
  hide(i: number): void {
    const sg = this.segs[i];
    if (!this.posAttr) return;
    const P = this.posAttr.array as Float32Array;
    const o = sg.start * 3;
    for (let k = 0; k < sg.count; k++) {
      P[o + k * 3] = this.hideAt.x;
      P[o + k * 3 + 1] = this.hideAt.y;
      P[o + k * 3 + 2] = this.hideAt.z;
    }
    this.touch();
  }
  private touch(): void {
    if (this.posAttr) this.posAttr.needsUpdate = true;
    if (this.nrmAttr) this.nrmAttr.needsUpdate = true;
  }
}


export const flap = (u: number, v: number, t: number) => Math.sin(6.283 * (1.7 * u - 1.4 * t) + 3.3 * v) + 0.45 * Math.sin(6.283 * (3.1 * u - 2.3 * t) + 1.7 * v + 1.3);

/** Sailcloth: off-white Dacron with stitched panel seams. Left half = mainsail (battens, tapes, patches), right half = jib (blue sun strip). */
export function paintSail(): THREE.DataTexture {
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


/** Vertex colour that tells the woodwork material "painted like the hull here" (anything else is varnished wood). */
export const PAINTED: RGB = [2, 2, 2];
