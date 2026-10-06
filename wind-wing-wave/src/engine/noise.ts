/**
 * Small deterministic random numbers and smooth noise (no dependencies).
 * Shared by the engine and the page. Hash-based value noise has no repeating period.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random generator whose state can be saved and restored. */
export class Rng {
  state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.next() * list.length)];
  }
}

/** Integer hash of 2 ints (+ seed) to [0, 1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Integer hash of 3 ints (+ seed) to [0, 1). */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  return hash2(x, Math.imul(y | 0, 31337) ^ (z | 0), seed);
}

/** Smooth value noise in [0, 1] (no period). */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in roughly [-1, 1]. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (valueNoise2(x * f, y * f, seed + o * 101) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
