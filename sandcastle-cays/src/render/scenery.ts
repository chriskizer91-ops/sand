/**
 * Everything around the editable sand: the rest of the island and sea floor,
 * rocky headlands at each end of the cove, palms and sea-grape bushes at the
 * back, and low islands on the horizon. All made from simple shapes in code.
 */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE } from './colors';
import { mergeGeometries } from './sky';
import { createSandMaterial, type SandUniforms } from './sandMaterial';
import { Noise2D, mulberry32, smoothstep } from '../engine/noise';
import type { Terrain } from '../engine/terrain';

export interface RegionBounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function axisCoords(innerMin: number, innerMax: number, step: number, outer: number, growth: number): number[] {
  const out: number[] = [];
  for (let v = innerMin; v <= innerMax + 1e-6; v += step) out.push(v);
  let s = step;
  let v = innerMax;
  while (v < innerMax + outer) {
    s *= growth;
    v += s;
    out.push(v);
  }
  s = step;
  v = innerMin;
  const neg: number[] = [];
  while (v > innerMin - outer) {
    s *= growth;
    v -= s;
    neg.push(v);
  }
  return [...neg.reverse(), ...out];
}

const color = new THREE.Color();
function rgb(hex: number): [number, number, number] {
  color.setHex(hex);
  return [color.r, color.g, color.b];
}

/** The ground outside the editable sand (island, headlands, sea floor). */
export function createOuterTerrain(terrain: Terrain, region: RegionBounds, sandUniforms: SandUniforms): THREE.Mesh {
  const xs = axisCoords(region.x0 - 4, region.x1 + 4, 0.12, 160, 1.12);
  const zs = axisCoords(region.z0 - 3, region.z1 + 4, 0.12, 160, 1.12);
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const attr = new Uint8Array(nx * nz * 4);
  const tint = new Float32Array(nx * nz * 4);
  const noise = new Noise2D(5);
  const grass = rgb(PALETTE.grass);
  const grassDark = rgb(PALETTE.grassDark);
  const rock = rgb(PALETTE.rock);
  const wl = terrain.waterLevel;
  const overlap = 0.09; // the outer ground tucks under the editable sand by 3 cells
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      const x = xs[xi];
      const z = zs[zi];
      const inside = x > region.x0 && x < region.x1 && z > region.z0 && z < region.z1;
      let h = terrain.heightAt(x, z);
      if (inside) h -= 0.015;
      const o = xi + zi * nx;
      pos[o * 3] = x;
      pos[o * 3 + 1] = h;
      pos[o * 3 + 2] = z;
      const above = h - wl;
      const wet = above < -0.01 ? 255 : above < 0.12 ? 200 : above < 0.3 ? 120 : 20;
      attr[o * 4] = wet;
      attr[o * 4 + 1] = 150;
      attr[o * 4 + 2] = 240;
      // Green behind the beach and on the headlands.
      const back = smoothstep(region.z1 + 0.5, region.z1 + 2.2, z) * smoothstep(0.35, 0.7, h);
      const side = smoothstep(region.x1 + 1.5, region.x1 + 3.5, Math.abs(x)) * smoothstep(0.3, 0.8, h);
      const g = Math.max(back, side);
      const n = noise.fbm(x * 0.4, z * 0.4, 2) * 0.5 + 0.5;
      const gcol = n > 0.5 ? grass : grassDark;
      // Rocky ground only above the water; underwater it stays sea floor.
      const isRock = smoothstep(region.x1 + 0.4, region.x1 + 1.6, Math.abs(x)) * smoothstep(0.02, 0.3, h) * (1 - side);
      if (isRock > g) {
        tint[o * 4] = rock[0];
        tint[o * 4 + 1] = rock[1];
        tint[o * 4 + 2] = rock[2];
        tint[o * 4 + 3] = isRock * 0.8;
      } else {
        tint[o * 4] = gcol[0];
        tint[o * 4 + 1] = gcol[1];
        tint[o * 4 + 2] = gcol[2];
        tint[o * 4 + 3] = g;
      }
    }
  }
  const idx: number[] = [];
  for (let zi = 0; zi < nz - 1; zi++) {
    for (let xi = 0; xi < nx - 1; xi++) {
      // Skip cells well inside the editable sand (keep an overlap band at its edges).
      const cx = (xs[xi] + xs[xi + 1]) / 2;
      const cz = (zs[zi] + zs[zi + 1]) / 2;
      if (cx > region.x0 + overlap && cx < region.x1 - overlap && cz > region.z0 + overlap && cz < region.z1 - overlap) continue;
      const a = xi + zi * nx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('sandAttr', new THREE.BufferAttribute(attr, 4, true));
  g.setAttribute('landTint', new THREE.BufferAttribute(tint, 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  const { material } = createSandMaterial(true, sandUniforms);
  const mesh = new THREE.Mesh(g, material);
  mesh.receiveShadow = true;
  return mesh;
}

/** A rounded boulder: a sphere pushed in and out by noise. */
function boulder(rand: () => number, size: number): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 3);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const n = new Noise2D(Math.floor(rand() * 1e6));
  const cols = new Float32Array(pos.count * 3);
  const light = rgb(PALETTE.rock);
  const dark = rgb(PALETTE.rockDark);
  const sx = 0.8 + rand() * 0.5;
  const sz = 0.8 + rand() * 0.5;
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const r = 1 + 0.18 * n.noise(x * 1.7 + y, z * 1.7 - y) + 0.07 * n.noise(x * 4.1, y * 4.1 + z);
    pos.setXYZ(v, x * r * size * sx, y * r * size * 0.62, z * r * size * sz);
    const t = 0.5 + 0.5 * n.noise(x * 3 + 10, z * 3 + y * 2);
    for (let c = 0; c < 3; c++) cols[v * 3 + c] = dark[c] + (light[c] - dark[c]) * t;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}

/** A rock's rough shape (an ellipsoid), so the water knows how shallow it is above it. */
export interface RockBlob {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

/** Height of the top of the rocks at x, z (or -Infinity). */
export function rockTop(blobs: RockBlob[], x: number, z: number): number {
  let top = -Infinity;
  for (const b of blobs) {
    const u = (x - b.x) / b.rx;
    const v = (z - b.z) / b.rz;
    const d = u * u + v * v;
    if (d < 1) top = Math.max(top, b.y + b.ry * Math.sqrt(1 - d));
  }
  return top;
}

export function createRocks(terrain: Terrain, region: RegionBounds): { mesh: THREE.Mesh; blobs: RockBlob[] } {
  const rand = mulberry32(2024);
  const parts: THREE.BufferGeometry[] = [];
  const blobs: RockBlob[] = [];
  const place = (g: THREE.BufferGeometry, size: number, x: number, y: number, z: number) => {
    g.translate(x, y, z);
    parts.push(g);
    blobs.push({ x, y, z, rx: size * 0.95, ry: size * 0.6, rz: size * 0.95 });
  };
  for (const side of [-1, 1]) {
    const edge = side > 0 ? region.x1 : region.x0;
    // A wall of rounded rocks along each end of the cove, from the water up to the bushes.
    for (let z = region.z0 - 2.5; z < region.z1 + 1.5; ) {
      const size = 0.55 + rand() * 0.9;
      const x = edge + side * (size * 0.55 + rand() * 0.6);
      const g = boulder(rand, size);
      g.rotateY(rand() * Math.PI * 2);
      place(g, size, x, terrain.heightAt(x, z) + size * 0.12, z);
      // Some bigger rocks further out on the headland.
      if (rand() < 0.6) {
        const s2 = 0.9 + rand() * 1.6;
        const x2 = edge + side * (1.6 + rand() * 3.5);
        const z2 = z + rand() * 1.2;
        const g2 = boulder(rand, s2);
        g2.rotateY(rand() * Math.PI * 2);
        place(g2, s2, x2, terrain.heightAt(x2, z2) + s2 * 0.1, z2);
      }
      z += size * 0.9 + rand() * 0.35;
    }
  }
  // A few rocks poking out of the lagoon.
  for (let r = 0; r < 6; r++) {
    const s = 0.3 + rand() * 0.7;
    const x = (rand() - 0.5) * 30;
    const z = region.z0 - 6 - rand() * 18;
    const g = boulder(rand, s);
    place(g, s, x, terrain.heightAt(x, z) + s * 0.35, z);
  }
  const merged = mergeGeometries(parts);
  const mesh = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, blobs };
}

/** Vertex shader patch that makes leaves sway in the breeze. */
function swayMaterial(time: { value: number }): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float sway;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
float ph = position.x * 0.35 + position.z * 0.27;
transformed.x += sway * (sin(uTime * 1.3 + ph) * 0.06 + sin(uTime * 2.9 + ph * 2.0) * 0.025);
transformed.z += sway * cos(uTime * 1.1 + ph) * 0.05;
transformed.y += sway * sin(uTime * 2.1 + ph) * 0.02;`,
      );
  };
  return mat;
}

function withSway(g: THREE.BufferGeometry, swayFn: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const s = new Float32Array(pos.count);
  for (let v = 0; v < pos.count; v++) s[v] = swayFn(pos.getX(v), pos.getY(v), pos.getZ(v));
  g.setAttribute('sway', new THREE.BufferAttribute(s, 1));
  return g;
}

function paint(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => [number, number, number]): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const c = new Float32Array(pos.count * 3);
  for (let v = 0; v < pos.count; v++) {
    const [r, gg, b] = fn(pos.getX(v), pos.getY(v), pos.getZ(v));
    c[v * 3] = r;
    c[v * 3 + 1] = gg;
    c[v * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** One palm frond: a drooping rib with saw-toothed leaflets. */
function frond(length: number, droop: number, rand: () => number): THREE.BufferGeometry {
  const segs = 14;
  const pos: number[] = [];
  const idx: number[] = [];
  const cols: number[] = [];
  const leaf = rgb(PALETTE.leaf);
  const leafLight = rgb(PALETTE.leafLight);
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const x = t * length;
    const y = Math.sin(t * Math.PI * 0.55) * length * 0.25 - t * t * droop;
    // Leaflets: wide in the middle, jagged edge.
    const w = Math.sin(Math.PI * Math.min(1, t * 1.15)) * length * 0.2 * (s % 2 === 0 ? 1 : 0.62);
    const fold = w * 0.35;
    pos.push(x, y + fold, -w, x, y, 0, x, y + fold, w);
    const k = 0.35 + 0.65 * t;
    for (let c = 0; c < 3; c++) {
      const col: [number, number, number] = [0, 0, 0];
      for (let q = 0; q < 3; q++) col[q] = leaf[q] + (leafLight[q] - leaf[q]) * (c === 1 ? k * 0.6 : k);
      cols.push(...col);
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = s * 3;
    const b = a + 3;
    idx.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  void rand;
  return g;
}

/** A coconut palm, curving up from (0,0,0) and leaning toward +x. */
function palm(height: number, lean: number, rand: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunkCol = rgb(PALETTE.trunk);
  // Curved, ringed trunk.
  const pts: THREE.Vector3[] = [];
  for (let s = 0; s <= 16; s++) {
    const t = s / 16;
    pts.push(new THREE.Vector3(lean * height * t * t, height * t, 0));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const trunk = new THREE.TubeGeometry(curve, 24, 0.12, 8, false);
  const tp = trunk.getAttribute('position') as THREE.BufferAttribute;
  for (let v = 0; v < tp.count; v++) {
    const y = tp.getY(v);
    const t = y / height;
    const ring = 1 + 0.08 * Math.max(0, Math.sin(y * 9));
    const taper = 1.35 - 0.5 * t;
    const c = curve.getPoint(Math.max(0, Math.min(1, t)));
    tp.setX(v, c.x + (tp.getX(v) - c.x) * taper * ring);
    tp.setZ(v, c.z + (tp.getZ(v) - c.z) * taper * ring);
  }
  trunk.computeVertexNormals();
  paint(trunk, (_x, y) => {
    const k = 0.85 + 0.15 * Math.sin(y * 9);
    return [trunkCol[0] * k, trunkCol[1] * k, trunkCol[2] * k];
  });
  withSway(trunk, (_x, y) => Math.max(0, y / height - 0.6) * 0.8);
  trunk.deleteAttribute('uv');
  parts.push(trunk);
  const top = curve.getPoint(1);
  // Fronds radiating from the crown.
  const count = 9 + Math.floor(rand() * 3);
  for (let f = 0; f < count; f++) {
    const len = 2.1 + rand() * 0.8;
    const g = frond(len, 0.9 + rand() * 0.7, rand);
    g.rotateZ(-0.15 + rand() * 0.5);
    g.rotateY((f / count) * Math.PI * 2 + rand() * 0.3);
    g.translate(top.x, top.y, top.z);
    withSway(g, (x, _y, z) => Math.min(1.4, Math.hypot(x - top.x, z - top.z) * 0.55));
    parts.push(g);
  }
  // Coconuts.
  for (let c = 0; c < 4; c++) {
    const g = new THREE.SphereGeometry(0.13, 8, 6);
    g.deleteAttribute('uv');
    const a = (c / 4) * Math.PI * 2;
    g.translate(top.x + Math.cos(a) * 0.17, top.y - 0.18, top.z + Math.sin(a) * 0.17);
    paint(g, () => rgb(PALETTE.coconut));
    withSway(g, () => 0.4);
    parts.push(g);
  }
  return mergeWithSway(parts);
}

function mergeWithSway(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  for (const p of parts) {
    if (p.getAttribute('uv')) p.deleteAttribute('uv');
  }
  const merged = mergeGeometries(parts);
  const sway = new Float32Array(merged.getAttribute('position').count);
  let o = 0;
  for (const p of parts) {
    const s = p.getAttribute('sway') as THREE.BufferAttribute;
    for (let v = 0; v < s.count; v++) sway[o + v] = s.getX(v);
    o += s.count;
  }
  merged.setAttribute('sway', new THREE.BufferAttribute(sway, 1));
  return merged;
}

/** A sea-grape bush: a cluster of round leafy blobs. */
function bush(rand: () => number, size: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 5 + Math.floor(rand() * 4);
  const a = rgb(PALETTE.grassDark);
  const b = rgb(PALETTE.leafLight);
  for (let k = 0; k < n; k++) {
    const g = new THREE.IcosahedronGeometry(size * (0.45 + rand() * 0.35), 1);
    const ang = rand() * Math.PI * 2;
    const r = rand() * size * 0.7;
    g.translate(Math.cos(ang) * r, size * (0.25 + rand() * 0.45), Math.sin(ang) * r);
    const t = rand();
    paint(g, (_x, y) => {
      const k2 = Math.min(1, Math.max(0, y / (size * 1.3))) * 0.6 + t * 0.4;
      return [a[0] + (b[0] - a[0]) * k2, a[1] + (b[1] - a[1]) * k2, a[2] + (b[2] - a[2]) * k2];
    });
    withSway(g, (_x, y) => Math.max(0, y) * 0.25);
    parts.push(g);
  }
  return mergeWithSway(parts);
}

/** Tufts of beach grass. */
function grassTuft(rand: () => number): THREE.BufferGeometry {
  const pos: number[] = [];
  const cols: number[] = [];
  const g1 = rgb(PALETTE.grass);
  const g2 = rgb(PALETTE.leafLight);
  const blades = 7 + Math.floor(rand() * 5);
  for (let b = 0; b < blades; b++) {
    const ang = rand() * Math.PI * 2;
    const h = 0.25 + rand() * 0.3;
    const lean = 0.08 + rand() * 0.12;
    const bx = Math.cos(ang) * 0.04;
    const bz = Math.sin(ang) * 0.04;
    const px = -Math.sin(ang) * 0.015;
    const pz = Math.cos(ang) * 0.015;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + Math.cos(ang) * lean, h, bz + Math.sin(ang) * lean);
    cols.push(...g1, ...g1, ...g2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  withSway(g, (_x, y) => y * 1.5);
  return g;
}

export function createVegetation(terrain: Terrain, region: RegionBounds, time: { value: number }): THREE.Mesh {
  const rand = mulberry32(77);
  const parts: THREE.BufferGeometry[] = [];
  // Palms along the back of the beach, leaning toward the sea (-z).
  const palmSpots = [
    [-5.6, 1.2],
    [-2.4, 0.4],
    [1.6, 1.4],
    [4.8, 0.6],
    [6.9, 2.2],
    [-7.4, 2.6],
    [0.0, 3.4],
    [-4.0, 3.8],
    [3.4, 4.2],
  ];
  for (const [x, dz] of palmSpots) {
    const z = region.z1 + 0.7 + dz;
    const h = 4.2 + rand() * 2.6;
    const g = palm(h, 0.25 + rand() * 0.25, rand);
    g.rotateY(Math.PI / 2 + (rand() - 0.5) * 0.9); // lean toward the sea
    g.translate(x, terrain.heightAt(x, z) - 0.05, z);
    parts.push(g);
  }
  // Bushes hiding the back edge of the sand, and at the ends of the cove.
  for (let x = region.x0 - 0.5; x < region.x1 + 0.5; ) {
    const s = 0.45 + rand() * 0.5;
    const z = region.z1 + 0.15 + rand() * 0.6;
    const g = bush(rand, s);
    g.translate(x, terrain.heightAt(x, z) - 0.08, z);
    parts.push(g);
    x += s * 1.1 + rand() * 0.7;
  }
  for (let n = 0; n < 40; n++) {
    const s = 0.4 + rand() * 0.7;
    const x = region.x0 - 3 + rand() * (region.x1 - region.x0 + 6);
    const z = region.z1 + 1.2 + rand() * 7;
    const g = bush(rand, s);
    g.translate(x, terrain.heightAt(x, z) - 0.1, z);
    parts.push(g);
  }
  for (const side of [-1, 1]) {
    for (let n = 0; n < 14; n++) {
      const s = 0.4 + rand() * 0.6;
      const x = (side > 0 ? region.x1 : region.x0) + side * (2.5 + rand() * 5);
      const z = region.z0 + 4 + rand() * 10;
      const g = bush(rand, s);
      g.translate(x, terrain.heightAt(x, z) - 0.1, z);
      parts.push(g);
    }
  }
  for (let n = 0; n < 70; n++) {
    const x = region.x0 - 1 + rand() * (region.x1 - region.x0 + 2);
    const z = region.z1 + 0.05 + rand() * 3.5;
    const g = grassTuft(rand);
    g.translate(x, terrain.heightAt(x, z) - 0.02, z);
    parts.push(g);
  }
  const merged = mergeWithSway(parts);
  const mesh = new THREE.Mesh(merged, swayMaterial(time));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Low green islands on the horizon. */
export function createDistantIslands(): THREE.Mesh {
  const rand = mulberry32(9);
  const parts: THREE.BufferGeometry[] = [];
  const sand = rgb(PALETTE.sandDry);
  const green = rgb(PALETTE.grassDark);
  const spots = [
    [-180, -260, 60],
    [120, -330, 80],
    [330, -150, 50],
    [-360, -90, 70],
    [40, -520, 110],
  ];
  for (const [x, z, s] of spots) {
    const g = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    g.deleteAttribute('uv');
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) {
      const px = pos.getX(v);
      const pz = pos.getZ(v);
      const py = pos.getY(v);
      const bump = 1 + 0.25 * Math.sin(px * 3.1 + pz * 2.3);
      pos.setXYZ(v, px * s * 1.6, py * s * 0.12 * bump - 1.5, pz * s);
    }
    paint(g, (_x, y) => (y < 0.5 ? sand : green));
    g.computeVertexNormals();
    g.translate(x, 0, z);
    parts.push(g);
    // A few palm silhouettes.
    for (let p = 0; p < 6; p++) {
      const t = new THREE.ConeGeometry(2.4, 2, 6);
      t.deleteAttribute('uv');
      const tx = x + (rand() - 0.5) * s * 1.6;
      const tz = z + (rand() - 0.5) * s * 0.8;
      t.translate(tx, s * 0.1 + 6, tz);
      paint(t, () => green);
      const trunk = new THREE.CylinderGeometry(0.25, 0.35, 6, 5);
      trunk.deleteAttribute('uv');
      trunk.translate(tx, s * 0.1 + 3, tz);
      paint(trunk, () => rgb(PALETTE.trunk));
      parts.push(t, trunk);
    }
  }
  const merged = mergeGeometries(parts);
  return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true }));
}
