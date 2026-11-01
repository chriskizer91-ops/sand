/**
 * Textures painted by code at startup (DECISIONS 14), pixel by pixel from
 * seeded noise. Nothing is loaded from disk. Adapted from the raft game.
 * Only DataTextures (no canvas), so they also build in Node for the checks.
 */
import * as THREE from 'three';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value noise on a px-by-py lattice; inputs are lattice units. */
function lattice(r: () => number, px: number, py: number): (x: number, y: number) => number {
  const g = new Float32Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    let fx = x - xi;
    let fy = y - yi;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % px) + px) % px;
    const x1 = (x0 + 1) % px;
    const y0 = ((yi % py) + py) % py;
    const y1 = (y0 + 1) % py;
    const a = g[y0 * px + x0];
    const b = g[y0 * px + x1];
    const c = g[y1 * px + x0];
    const d = g[y1 * px + x1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/** Tileable fractal noise over u, v in [0, 1). */
export function fbm(seed: number, px: number, py: number, octaves = 4): (u: number, v: number) => number {
  const r = rng(seed);
  const layers: { n: (x: number, y: number) => number; s: number; a: number }[] = [];
  for (let o = 0; o < octaves; o++) layers.push({ n: lattice(r, px << o, py << o), s: 1 << o, a: 0.5 ** o });
  const norm = layers.reduce((s, l) => s + l.a, 0);
  return (u, v) => {
    let s = 0;
    for (const l of layers) s += l.n(u * px * l.s, v * py * l.s) * l.a;
    return s / norm;
  };
}

let waterDetail: THREE.DataTexture | null = null;

/**
 * Small ripples for the water: rg = surface tilt (a normal map), a = a foam
 * pattern. Tiles seamlessly; the water shader scrolls two copies of it.
 */
export function waterDetailTexture(): THREE.DataTexture {
  if (waterDetail) return waterDetail;
  const N = 256;
  const h1 = fbm(201, 8, 8, 4);
  const h2 = fbm(202, 16, 16, 3);
  const foam = fbm(203, 6, 6, 5);
  const hs = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) hs[y * N + x] = h1(x / N, y / N) * 0.7 + h2(x / N, y / N) * 0.3;
  }
  const data = new Uint8Array(N * N * 4);
  const s = 6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const xl = (x + N - 1) % N;
      const xr = (x + 1) % N;
      const yd = (y + N - 1) % N;
      const yu = (y + 1) % N;
      const dx = (hs[y * N + xr] - hs[y * N + xl]) * s;
      const dy = (hs[yu * N + x] - hs[yd * N + x]) * s;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 4;
      data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[i + 3] = foam(x / N, y / N) * 255;
    }
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  waterDetail = t;
  return t;
}
