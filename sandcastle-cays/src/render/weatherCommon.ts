/**
 * Shared by the weather effects (weatherFx.ts): the light they all read, and
 * a small noise texture painted by code at startup (DataTexture, no canvas,
 * so it also builds in Node for the checks).
 */
import * as THREE from 'three';
import { fbm } from './paint';

/** The uniforms every weather material shares (one set, updated once a frame). */
export interface FxUniforms {
  [name: string]: THREE.IUniform;
  uTime: { value: number };
  /** Where the light comes from: the sun by day, the moon by night. */
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uHorizon: { value: THREE.Color };
  uZenith: { value: THREE.Color };
  /** 1 by day, 0 at night. */
  uDay: { value: number };
  /** 0 by day, 1 at night. */
  uNight: { value: number };
  /** The camera's velocity (m/s): streaks are drawn along motion relative to you. */
  uCamVel: { value: THREE.Vector3 };
  /** Width / height of the view, and 2 / its height in pixels (one pixel in screen units). */
  uAspect: { value: number };
  uPixel: { value: number };
}

export function makeFxUniforms(): FxUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.9, -0.3).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uHorizon: { value: new THREE.Color(0xc4e2ee) },
    uZenith: { value: new THREE.Color(0x2b78cf) },
    uDay: { value: 1 },
    uNight: { value: 0 },
    uCamVel: { value: new THREE.Vector3() },
    uAspect: { value: 1.6 },
    uPixel: { value: 2 / 900 },
  };
}

/** A small seeded random number generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let noise: THREE.DataTexture | null = null;

/**
 * Tileable noise, 128 x 128:
 *  r = big soft billows (cloud puffs), g = finer billows,
 *  b = tall vertical streaks (rain shafts), a = medium blotches (ragged edges).
 */
export function weatherNoise(): THREE.DataTexture {
  if (noise) return noise;
  const N = 128;
  const layers = [fbm(401, 4, 4, 5), fbm(402, 8, 8, 4), fbm(403, 24, 2, 3), fbm(404, 6, 6, 3)];
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      for (let c = 0; c < 4; c++) {
        // fbm clusters around 0.5; stretch it so the full range gets used.
        const v = (layers[c](x / N, y / N) - 0.5) * 2.4 + 0.5;
        data[(y * N + x) * 4 + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  noise = tex;
  return tex;
}

/**
 * Shared GLSL: a streak from tail to head as a thin screen-space quad (corner
 * c: x = 0 tail .. 1 head, y = -1..1 across), at least about a pixel wide;
 * cover < 1 when it is really thinner (draw it fainter). Needs uAspect, uPixel.
 */
export const GLSL_STREAK = /* glsl */ `
vec4 streakCorner(vec3 tail, vec3 head, float halfWidth, vec2 c, out float cover) {
  vec4 ch = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec4 ct = projectionMatrix * viewMatrix * vec4(tail, 1.0);
  if (ch.w < 0.12 || ct.w < 0.12) {
    cover = 0.0;
    return vec4(2.0, 2.0, 2.0, 1.0);
  }
  vec2 dir = (ch.xy / ch.w - ct.xy / ct.w) * vec2(uAspect, 1.0);
  float len = length(dir);
  vec2 perp = len > 1e-6 ? vec2(-dir.y, dir.x) / len : vec2(1.0, 0.0);
  perp.x /= uAspect;
  float w = halfWidth * projectionMatrix[1][1] / ch.w;
  float minW = uPixel * 0.75;
  cover = clamp(w / minW, 0.0, 1.0);
  vec4 p = mix(ct, ch, c.x);
  p.xy += perp * max(w, minW) * c.y * p.w;
  return p;
}`;

/** Shared GLSL: a fast error function (for the rain curtain's soft column). */
export const GLSL_ERF = /* glsl */ `
float erfA(float x) {
  float ax = abs(x);
  if (ax < 0.08) return x * 1.1283792 * (1.0 - x * x / 3.0);
  float x2 = x * x;
  float r = sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2)));
  return x < 0.0 ? -r : r;
}`;
