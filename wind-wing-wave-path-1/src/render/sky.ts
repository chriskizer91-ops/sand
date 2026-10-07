/**
 * The sky (WP-G): a gradient dome with the sun, the moon and its phase, stars and a faint
 * Milky Way, the storm deck and the rainbow; trade-wind cumulus drifting west; cap clouds
 * that anchor and churn over tall peaks; and hazy distant islands on the horizon.
 *
 * - The dome follows the camera and is drawn at the far plane, so it costs one draw and never
 *   clips. Its colours come from daylight.ts (skyLookOf) and weather.ts (weatherOf).
 * - Clouds are soft round billboards ("puffs") lit like spheres in the shader: a whole cloud of
 *   puffs is a handful of triangles, and all trade clouds are one instanced draw. Puffs fade
 *   near the camera (no walls of cloud), and from above, clouds over the island make way so the
 *   god view stays clear.
 * - Cap clouds are the island's signature: over every peak tall enough to catch one
 *   (life.peaks with cap = true), puffs form on the windward (east) shoulder, roll over the
 *   summit and melt away on the lee side, like real orographic clouds. Thicker in the wet season.
 * - The "old islands", where most life comes from, sit as blue silhouettes on the eastern
 *   horizon (OLD_ISLANDS), with a few fainter islands elsewhere: one cheap mesh.
 *
 * All noise is arithmetic, with sin-free hashes (no textures).
 */
import * as THREE from 'three';
import { OLD_ISLANDS } from '../config';
import { mulberry32, smoothstep } from '../engine/noise';
import type { LifeInfo } from '../engine/protocol';
import { skyLookOf } from './daylight';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';
import { DECK_PERIOD, weatherOf } from './weather';

/** Sin-free hashes (after Dave Hoskins) and value noise shared by the sky shaders. */
const HASH_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
// 2D value noise that repeats every 256 cells, so drifting patterns can wrap without a seam.
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, 256.0);
  vec2 i1 = mod(i + 1.0, 256.0);
  float a = hash12(i0);
  float b = hash12(vec2(i1.x, i0.y));
  float c = hash12(vec2(i0.x, i1.y));
  float d = hash12(i1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// Interleaved gradient noise: a cheap screen-space dither against banding.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
`;

/** Peaks that can wear a cap cloud at once, and puffs per cap. */
const CAP_SLOTS = 6;
const CAP_PUFFS = 9;

// ---------- the dome ----------

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFogColor;
uniform vec3 uGlow;
uniform float uGlowI;
uniform vec3 uSunDir;
uniform vec3 uSunDisc;
uniform float uSunVis;
uniform vec3 uMoonDir;
uniform vec3 uMoonLight;
uniform float uMoonVis;
uniform float uMoonFull;
uniform float uStars;
uniform mat3 uStarRot;
uniform float uDeck;
uniform vec3 uDeckColor;
uniform vec2 uDrift;
uniform float uRainbow;
uniform vec3 uRainbowDir;
uniform float uFlash;
uniform float uTime;
varying vec3 vDir;
${HASH_GLSL}
const vec3 MILKY_AXIS = vec3(0.3092, 0.4859, -0.8175);

// Hue ramp without trig: 0 red .. 1 violet.
vec3 spectrum(float t) {
  return clamp(abs(fract(t * 0.8 + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void main() {
  vec3 d = normalize(vDir);
  // Below the horizon the sky is all haze. The sea is see-through and drawn after the sky, so
  // from the god view most of the screen lands here: answer it before any of the sky's work.
  if (d.y <= 0.0) {
    gl_FragColor = vec4(uFogColor * (1.0 + uFlash) + (ign(gl_FragCoord.xy) - 0.5) / 255.0, 1.0);
    #include <colorspace_fragment>
    return;
  }
  float up = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.55));

  // Warm glow toward the sun near the horizon (sunrise and sunset).
  vec2 hd = normalize(d.xz + vec2(1e-5));
  vec2 hs = normalize(uSunDir.xz + vec2(1e-5));
  float az = 0.5 + 0.5 * dot(hd, hs);
  col += uGlow * uGlowI * az * az * az * exp(-up * 5.0) * (1.0 - uDeck);

  // Stars and the Milky Way, turning slowly around the pole star through the night.
  if (uStars > 0.01) {
    vec3 sd = uStarRot * d;
    vec3 g = sd * 220.0;
    vec3 cell = floor(g);
    vec3 h = hash33(cell);
    float band = exp(-pow(dot(sd, MILKY_AXIS) / 0.2, 2.0));
    float star = 0.0;
    if (h.x > 0.991 - 0.007 * band) {
      float dd = length(g - (cell + 0.3 + 0.4 * h.yzx));
      float tw = 0.75 + 0.25 * sin(uTime * (1.3 + 2.5 * h.z) + h.y * 40.0);
      star = (1.0 - smoothstep(0.0, 0.3, dd)) * (0.25 + 0.75 * h.y * h.y) * tw;
    }
    // The band's mottling is only worked out where the band shows.
    float mw = band > 0.01 ? band * (0.35 + 0.65 * vnoise3(sd * 7.0)) : 0.0;
    col += (vec3(1.0, 0.97, 0.92) * star * 1.5 + vec3(0.5, 0.56, 0.78) * mw * 0.06) * uStars * smoothstep(0.0, 0.2, up);
  }

  // Sun: a soft halo and a bright disc.
  float sdot = dot(d, uSunDir);
  float sp = max(sdot, 0.0);
  col += uSunDisc * uSunVis * (pow(sp, 8.0) * 0.05 + pow(sp, 160.0) * 0.22);
  col = mix(col, uSunDisc, uSunVis * smoothstep(0.99976, 0.99986, sdot));

  // Moon: a disc lit from one side by its phase, with a few soft grey seas.
  float mdot = dot(d, uMoonDir);
  if (uMoonVis > 0.01 && mdot > 0.999) {
    vec3 rgt = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 upm = cross(rgt, uMoonDir);
    vec2 q = vec2(dot(d, rgt), dot(d, upm)) / 0.0165;
    float r2 = dot(q, q);
    float disc = 1.0 - smoothstep(0.9, 1.0, r2);
    vec3 n = vec3(q, sqrt(max(0.0, 1.0 - r2)));
    float lit = smoothstep(-0.04, 0.08, dot(n, uMoonLight));
    float seas = 0.5 * (1.0 - smoothstep(0.0, 0.42, length(q - vec2(-0.25, 0.22))))
      + 0.4 * (1.0 - smoothstep(0.0, 0.3, length(q - vec2(0.22, -0.2))))
      + 0.3 * (1.0 - smoothstep(0.0, 0.24, length(q - vec2(0.3, 0.36))));
    vec3 face = vec3(0.98, 0.98, 1.0) * (1.25 - 0.3 * seas);
    col = mix(col, mix(col * 0.92, face, lit), disc * uMoonVis);
  }
  col += vec3(0.55, 0.65, 0.9) * uMoonVis * uMoonFull * pow(max(mdot, 0.0), 500.0) * 0.1;

  // Storm deck: a drifting grey overcast that thickens with the storm.
  if (uDeck > 0.01) {
    vec2 q = d.xz / (d.y + 0.1) * 1.6 + uDrift / 600.0;
    float n = vnoise(q) * 0.65 + vnoise(q * 2.3 + 17.0) * 0.35;
    float cover = smoothstep(1.0 - uDeck, 1.25 - uDeck, n + 0.25 * uDeck);
    vec3 deck = uDeckColor * (0.75 + 0.45 * n);
    col = mix(col, deck, cover * smoothstep(-0.02, 0.2, d.y) * smoothstep(0.0, 0.35, uDeck));
  }

  // Rainbow, opposite the sun: the primary bow (red outside) and a faint reversed secondary.
  if (uRainbow > 0.01) {
    float ang = degrees(acos(clamp(dot(d, uRainbowDir), -1.0, 1.0)));
    float p1 = (ang - 40.4) / 2.2;
    float bow1 = smoothstep(0.0, 0.15, p1) * (1.0 - smoothstep(0.85, 1.0, p1));
    float p2 = (ang - 50.5) / 3.0;
    float bow2 = smoothstep(0.0, 0.15, p2) * (1.0 - smoothstep(0.85, 1.0, p2)) * 0.3;
    float mask = smoothstep(0.0, 0.06, d.y);
    col += (spectrum(1.0 - p1) * bow1 + spectrum(p2) * bow2) * uRainbow * 0.3 * mask;
    col += vec3(0.025) * uRainbow * mask * (1.0 - smoothstep(36.0, 40.4, ang));
  }

  // The far sea and the sky meet in the haze colour.
  col = mix(col, uFogColor, exp(-up * 14.0));
  col *= 1.0 + uFlash;
  col += (ign(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

// ---------- clouds ----------

const CLOUD_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aPuff;
#ifndef CAP
attribute vec4 aCloud;
#endif
uniform float uTime;
uniform vec3 uCamPos;
uniform float uDry;
uniform vec3 uTarget;
uniform float uCoverage;
#ifdef CAP
uniform vec4 uCaps[${CAP_SLOTS}];
#endif
varying vec2 vUv;
varying vec3 vCenter;
varying float vRadius;
varying float vAlpha;
varying float vBaseY;
varying float vSeed;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vBack;
void main() {
  vec3 c;
  float r;
  float alpha;
  float baseY;
#ifdef CAP
  // Cap cloud: puffs form on the windward (east) shoulder, roll west over the summit and melt
  // away in the lee. Each puff loops every 72 s (a period that divides the shader clock's wrap).
  vec4 cap = uCaps[int(aPuff.x)];
  float R = clamp(cap.z * 0.7, 35.0, 130.0);
  float s = fract(uTime / 72.0 + aPuff.y);
  float env = smoothstep(0.0, 0.18, s) * (1.0 - smoothstep(0.66, 1.0, s));
  float wet = 1.0 - uDry;
  c = vec3(cap.x + R * (0.7 - 1.6 * s), cap.z + R * (0.04 + 0.22 * aPuff.w * env), cap.y + R * aPuff.z * (0.45 + 0.2 * env));
  r = R * (0.3 + 0.16 * aPuff.w) * (0.6 + 0.4 * env) * (0.9 + 0.2 * wet);
  alpha = env * cap.w * (0.85 + 0.15 * wet);
  // Up at the summit the cap makes way: it shows from the shore, the sea and the god view.
  alpha *= smoothstep(R * 1.3, R * 3.0, length(vec3(cap.x, cap.z + R * 0.2, cap.y) - uCamPos));
  baseY = cap.z - R * 0.12;
#else
  // Trade cumulus drift west at 5 m/s on a 6 km tile that wraps around the camera target
  // (5 m/s x 3600 s is a whole number of tiles, so the shader clock's wrap is seamless).
  float T = 6000.0;
  vec2 xz = aCloud.xy - vec2(5.0 * uTime, 0.0);
  xz = mod(xz - uTarget.xz + T * 0.5, T) - T * 0.5 + uTarget.xz;
  c = vec3(xz.x, aCloud.z, xz.y) + aPuff.xyz;
  r = aPuff.w;
  alpha = smoothstep(aCloud.w - 0.1, aCloud.w, uCoverage);
  float hd = length(xz - uTarget.xz);
  alpha *= 1.0 - smoothstep(2300.0, 2850.0, hd);
  // Seen from above, clouds over the island make way, so the god view stays clear.
  float above = smoothstep(aCloud.z, aCloud.z + 250.0, uCamPos.y);
  alpha *= mix(1.0, smoothstep(250.0, 700.0, hd), above);
  baseY = aCloud.z;
#endif
  // Never a wall of cloud right in front of the lens.
  float dc = length(c - uCamPos);
  alpha *= smoothstep(r * 1.2, r * 3.5, dc);
  vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vBack = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  vUv = aCorner;
  vCenter = c;
  vRadius = r;
  vAlpha = alpha;
  vBaseY = baseY;
  vSeed = aPuff.w * 17.0 + aPuff.y * 5.0;
  if (alpha < 0.004) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // invisible: collapse the quad, no pixels drawn
    return;
  }
  vec3 world = c + (vRight * aCorner.x + vUp * aCorner.y) * r;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const CLOUD_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCamPos;
uniform float uStorm;
varying vec2 vUv;
varying vec3 vCenter;
varying float vRadius;
varying float vAlpha;
varying float vBaseY;
varying float vSeed;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vBack;
${HASH_GLSL}
void main() {
  // A soft, slightly lumpy rim.
  float r2 = dot(vUv, vUv) * (0.9 + 0.22 * vnoise(vUv * 2.7 + vSeed));
  if (r2 > 1.0) discard;
  vec3 n = normalize(vRight * vUv.x + vUp * vUv.y + vBack * sqrt(max(0.0, 1.0 - r2)));
  vec3 surf = vCenter + n * vRadius;
  // Flat bottoms, like real cumulus sitting on their condensation level.
  float base = smoothstep(vBaseY - vRadius * 0.05, vBaseY + vRadius * 0.3, surf.y);
  // Faint puffs (forming, melting or making way for the camera) turn into soft blobs with no
  // rim, so a thinning cloud looks like mist rather than a stack of discs.
  float firm = smoothstep(0.0, 0.85, vAlpha);
  float a = vAlpha * base * (1.0 - smoothstep(0.68 * firm, 1.0, r2)) * 0.97;
  if (a < 0.004) discard;
  float ndl = dot(n, uSunDir);
  vec3 amb = mix(mix(uGroundColor, uSkyColor, 0.6), uSkyColor, 0.5 + 0.5 * n.y);
  vec3 col = amb * 0.75 + uSunColor * max(0.4 + 0.6 * ndl, 0.0) * 0.55;
  col *= mix(0.74, 1.0, smoothstep(vBaseY, vBaseY + vRadius * 1.6, surf.y));
  col = mix(col, col * vec3(0.55, 0.58, 0.62), uStorm * 0.8);
  float fogF = smoothstep(uFogNear, uFogFar, length(surf - uCamPos));
  col = mix(col, uFogColor, fogF);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

// ---------- distant islands ----------

const ISLE_VERT = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normal;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const ISLE_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uFogColor;
uniform vec3 uCamPos;
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  vec3 base = vec3(0.07, 0.12, 0.1);
  float ndl = max(dot(normalize(vNormal), uSunDir), 0.0);
  vec3 col = base * (uSkyColor * 0.7 + uSunColor * ndl * 0.9);
  // Kilometres of sea air: blue haze, thicker low down.
  float haze = 1.0 - exp(-length(vWorld - uCamPos) / 7000.0);
  haze = mix(haze, 1.0, 0.35 * (1.0 - smoothstep(0.0, 250.0, vWorld.y)));
  col = mix(col, uFogColor, clamp(haze, 0.0, 0.9));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

/** A distant island: centre, radius and height (m). */
interface FarIsland {
  x: number;
  z: number;
  r: number;
  h: number;
}

/** The old islands (upwind, the source of most life) and a few faint ones elsewhere. */
const FAR_ISLANDS: readonly FarIsland[] = [
  { x: OLD_ISLANDS.x, z: OLD_ISLANDS.z, r: 1700, h: 520 },
  { x: OLD_ISLANDS.x + 900, z: OLD_ISLANDS.z + 1500, r: 1000, h: 270 },
  { x: OLD_ISLANDS.x - 500, z: OLD_ISLANDS.z - 1800, r: 800, h: 190 },
  { x: -9500, z: 2600, r: 900, h: 230 },
  { x: 2500, z: 10200, r: 650, h: 120 },
  { x: -4200, z: -10000, r: 1200, h: 330 },
];

/** A weathered volcanic island: a radial mesh with ridges and valleys (about 160 triangles). */
function farIslandGeometry(isl: FarIsland, rand: () => number): THREE.BufferGeometry {
  const SEG = 22;
  const RINGS = [0, 0.18, 0.4, 0.65, 0.85, 1.0];
  const pos: number[] = [];
  const idx: number[] = [];
  const ridges = Array.from({ length: SEG }, () => 0.7 + 0.5 * rand());
  const peakX = (rand() - 0.5) * 0.3 * isl.r;
  const peakZ = (rand() - 0.5) * 0.3 * isl.r;
  pos.push(isl.x + peakX, isl.h, isl.z + peakZ);
  for (let ri = 1; ri < RINGS.length; ri++) {
    const t = RINGS[ri];
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      const wob = 1 + 0.18 * (ridges[s] - 0.95);
      const rr = isl.r * t * wob;
      const fall = Math.pow(1 - t, 1.5) * (0.85 + 0.3 * ridges[(s + ri) % SEG] * (1 - t));
      const y = ri === RINGS.length - 1 ? -8 : isl.h * fall;
      pos.push(isl.x + peakX * (1 - t) + Math.cos(a) * rr, y, isl.z + peakZ * (1 - t) + Math.sin(a) * rr);
    }
  }
  for (let s = 0; s < SEG; s++) idx.push(0, 1 + ((s + 1) % SEG), 1 + s);
  for (let ri = 1; ri < RINGS.length - 1; ri++) {
    const a0 = 1 + (ri - 1) * SEG;
    const b0 = 1 + ri * SEG;
    for (let s = 0; s < SEG; s++) {
      const s1 = (s + 1) % SEG;
      idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mergeIslands(rand: () => number): THREE.BufferGeometry {
  const parts = FAR_ISLANDS.map((isl) => farIslandGeometry(isl, rand));
  let nv = 0;
  let ni = 0;
  for (const g of parts) {
    nv += g.getAttribute('position').count;
    ni += g.index!.count;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const idx = new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of parts) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    pos.set(p.array as Float32Array, vo * 3);
    nrm.set((g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array, vo * 3);
    const gi = g.index!;
    for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo;
    vo += p.count;
    io += gi.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// ---------- cap cloud slots ----------

export interface CapSlot {
  x: number;
  z: number;
  h: number;
  /** Where the peak is now (the cap glides there). */
  tx: number;
  tz: number;
  th: number;
  presence: number;
  want: number;
}

/**
 * Match the peaks that should wear a cap to slots, keeping each cap on its peak as the
 * island changes (a moved summit glides; a new cap fades in; a lost one fades out).
 */
export function assignCaps(slots: CapSlot[], peaks: readonly { x: number; z: number; h: number; cap: boolean }[]): void {
  for (const s of slots) s.want = 0;
  const capped = peaks.filter((p) => p.cap).sort((a, b) => b.h - a.h).slice(0, slots.length);
  const used = new Set<CapSlot>();
  const strength = (h: number) => Math.min(1, Math.max(0.35, (h - 50) / 40));
  const pending: typeof capped = [];
  for (const p of capped) {
    let best: CapSlot | null = null;
    let bestD = 80;
    for (const s of slots) {
      if (used.has(s) || s.presence <= 0.001) continue;
      const d = Math.hypot(s.tx - p.x, s.tz - p.z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) {
      used.add(best);
      best.tx = p.x;
      best.tz = p.z;
      best.th = p.h;
      best.want = strength(p.h);
    } else pending.push(p);
  }
  for (const p of pending) {
    const free = slots.find((s) => !used.has(s) && s.presence <= 0.001);
    if (!free) continue;
    used.add(free);
    free.x = free.tx = p.x;
    free.z = free.tz = p.z;
    free.h = free.th = p.h;
    free.want = strength(p.h);
  }
}

// ---------- the system ----------

export function createSky(deps: SystemDeps): PageSystem {
  const { scene, u, quality } = deps;
  const look = skyLookOf(u);
  const weather = weatherOf(u);
  const rand = mulberry32(0xc10d);

  // ----- dome -----
  const domeUniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uFogColor: u.uFogColor,
    uGlow: { value: new THREE.Color() },
    uGlowI: { value: 0 },
    uSunDir: { value: new THREE.Vector3() },
    uSunDisc: { value: new THREE.Color() },
    uSunVis: { value: 1 },
    uMoonDir: { value: new THREE.Vector3() },
    uMoonLight: { value: new THREE.Vector3() },
    uMoonVis: { value: 0 },
    uMoonFull: { value: 0 },
    uStars: { value: 0 },
    uStarRot: { value: new THREE.Matrix3() },
    uDeck: { value: 0 },
    uDeckColor: { value: new THREE.Color() },
    uDrift: { value: new THREE.Vector2() },
    uRainbow: { value: 0 },
    uRainbowDir: { value: new THREE.Vector3(0, 0, -1) },
    uFlash: { value: 0 },
    uTime: u.uTime,
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(100, 24, 12),
    new THREE.ShaderMaterial({ uniforms: domeUniforms, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false }),
  );
  dome.frustumCulled = false;
  // Drawn after the other solid things: it sits at the far plane, so the depth test skips every
  // sky pixel already covered by land. The sea is see-through and drawn later, over the sky, so
  // the pixels under it take the shader's cheap below-the-horizon path instead.
  dome.renderOrder = 100;
  scene.add(dome);

  // ----- trade cumulus: one instanced draw of soft puffs -----
  const corner = new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2);
  const quadIndex = [0, 1, 2, 0, 2, 3];
  const clouds = quality.phone ? 14 : 20;
  const cloudAttr: number[] = [];
  const puffAttr: number[] = [];
  for (let c = 0; c < clouds; c++) {
    const x = (rand() - 0.5) * 6000;
    const z = (rand() - 0.5) * 6000;
    const baseY = 470 + rand() * 160;
    const rank = (c + 0.5) / clouds;
    const w = 160 + rand() * 230;
    const n = 5 + Math.floor(rand() * 4);
    for (let p = 0; p < n; p++) {
      const main = p === 0;
      const r = main ? w * 0.3 : w * (0.15 + rand() * 0.11);
      const ox = main ? 0 : (rand() - 0.5) * w * 0.8;
      const oz = main ? 0 : (rand() - 0.5) * w * 0.35;
      const oy = r * (0.5 + rand() * 0.25) + (main ? w * 0.06 : 0);
      cloudAttr.push(x, z, baseY, rank);
      puffAttr.push(ox, oy, oz, r);
    }
  }
  const tradeGeo = new THREE.InstancedBufferGeometry();
  tradeGeo.setAttribute('aCorner', corner);
  tradeGeo.setIndex(quadIndex);
  tradeGeo.setAttribute('aCloud', new THREE.InstancedBufferAttribute(new Float32Array(cloudAttr), 4));
  tradeGeo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(new Float32Array(puffAttr), 4));
  tradeGeo.instanceCount = puffAttr.length / 4;

  const cloudShared = {
    uTime: u.uTime,
    uCamPos: u.uCamPos,
    uDry: u.uDry,
    uSunDir: u.uSunDir,
    uSunColor: u.uSunColor,
    uSkyColor: u.uSkyColor,
    uGroundColor: u.uGroundColor,
    uFogColor: u.uFogColor,
    uFogNear: u.uFogNear,
    uFogFar: u.uFogFar,
    uStorm: u.uStorm,
    uTarget: { value: new THREE.Vector3() },
    uCoverage: { value: 0.7 },
  };
  const cloudMaterial = (cap: boolean, extra: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({
      uniforms: { ...cloudShared, ...extra },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      defines: cap ? { CAP: 1 } : {},
      transparent: true,
      depthWrite: false,
    });
  const trade = new THREE.Mesh(tradeGeo, cloudMaterial(false, {}));
  trade.frustumCulled = false;
  trade.renderOrder = 5;
  scene.add(trade);

  // ----- cap clouds -----
  const capGeo = new THREE.InstancedBufferGeometry();
  capGeo.setAttribute('aCorner', corner);
  capGeo.setIndex(quadIndex);
  const capPuffs = new Float32Array(CAP_SLOTS * CAP_PUFFS * 4);
  for (let s = 0; s < CAP_SLOTS; s++) {
    for (let p = 0; p < CAP_PUFFS; p++) {
      const o = (s * CAP_PUFFS + p) * 4;
      capPuffs[o] = s;
      capPuffs[o + 1] = p / CAP_PUFFS + rand() * 0.05;
      capPuffs[o + 2] = (rand() - 0.5) * 1.1;
      capPuffs[o + 3] = rand();
    }
  }
  capGeo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(capPuffs, 4));
  capGeo.instanceCount = 0;
  const capData = Array.from({ length: CAP_SLOTS }, () => new THREE.Vector4());
  const cap = new THREE.Mesh(capGeo, cloudMaterial(true, { uCaps: { value: capData } }));
  cap.frustumCulled = false;
  cap.renderOrder = 5;
  scene.add(cap);
  const slots: CapSlot[] = Array.from({ length: CAP_SLOTS }, () => ({ x: 0, z: 0, h: 0, tx: 0, tz: 0, th: 0, presence: 0, want: 0 }));
  let seenLife: LifeInfo | null = null;
  // The cap mesh starts visible but empty, so its shader is built with the first frame (or a
  // precompile at load) rather than the moment the first cap cloud forms.
  let firstFrame = true;

  // ----- distant islands -----
  const isles = new THREE.Mesh(
    mergeIslands(rand),
    new THREE.ShaderMaterial({
      uniforms: { uSunDir: u.uSunDir, uSunColor: u.uSunColor, uSkyColor: u.uSkyColor, uFogColor: u.uFogColor, uCamPos: u.uCamPos },
      vertexShader: ISLE_VERT,
      fragmentShader: ISLE_FRAG,
    }),
  );
  isles.frustumCulled = false;
  scene.add(isles);

  // Pole star direction (about 20 degrees up in the north, -z): the stars turn around it.
  const pole = new THREE.Vector3(0, Math.sin(0.35), -Math.cos(0.35));
  const starQuat = new THREE.Quaternion();
  const starMat4 = new THREE.Matrix4();

  return {
    name: 'sky',
    update(f: FrameCtx) {
      dome.position.copy(f.camera.position);
      const du = domeUniforms;
      du.uZenith.value.copy(look.zenith);
      du.uHorizon.value.copy(look.horizon);
      du.uGlow.value.copy(look.glow);
      du.uGlowI.value = look.glowI;
      du.uSunDir.value.copy(look.sunDir);
      du.uSunDisc.value.copy(look.sunDisc);
      du.uSunVis.value = look.sunVis;
      du.uMoonDir.value.copy(look.moonDir);
      // Lit side of the moon in its own frame: x right, z toward the viewer.
      const th = look.moonPhase * Math.PI * 2;
      du.uMoonLight.value.set(Math.sin(th), 0, -Math.cos(th));
      du.uMoonVis.value = look.moonVis;
      du.uMoonFull.value = 1 - Math.abs(look.moonPhase - 0.5) * 2;
      du.uStars.value = look.stars;
      starQuat.setFromAxisAngle(pole, look.starTurn);
      du.uStarRot.value.setFromMatrix4(starMat4.makeRotationFromQuaternion(starQuat));
      du.uDeck.value = weather.gloom;
      du.uDeckColor.value.copy(look.zenith).lerp(u.uFogColor.value, 0.35).multiplyScalar(0.85);
      du.uDrift.value.set(weather.driftX % DECK_PERIOD, weather.driftZ % DECK_PERIOD);
      // The rainbow centres opposite the sun; a high sun is treated as lower so the arc still shows.
      const sd = look.sunDir;
      const ry = -Math.min(Math.max(sd.y, 0.05), 0.26);
      const hl = Math.hypot(sd.x, sd.z) || 1;
      const hs = Math.sqrt(1 - ry * ry) / hl;
      du.uRainbowDir.value.set(-sd.x * hs, ry, -sd.z * hs);
      // Rainbows need sunshine on falling rain: the sun must be up, and the deck breaking.
      du.uRainbow.value = weather.rainbow * smoothstep(-0.02, 0.06, sd.y) * (1 - 0.7 * weather.gloom);
      du.uFlash.value = weather.flash;

      // Clouds: more in the wet season and when a storm gathers.
      cloudShared.uTarget.value.copy(f.cam.target);
      cloudShared.uCoverage.value = Math.min(1, 0.55 + 0.25 * (1 - u.uDry.value) + 0.3 * weather.storm);

      if (f.life !== seenLife) {
        seenLife = f.life;
        assignCaps(slots, f.life ? f.life.peaks : []);
      }
      const ease = 1 - Math.exp(-f.dt / 3);
      const fadeIn = 1 - Math.exp(-f.dt / 8);
      let active = 0;
      for (let i = 0; i < CAP_SLOTS; i++) {
        const s = slots[i];
        s.x += (s.tx - s.x) * ease;
        s.z += (s.tz - s.z) * ease;
        s.h += (s.th - s.h) * ease;
        s.presence += (s.want - s.presence) * fadeIn;
        if (s.want === 0 && s.presence < 0.002) s.presence = 0;
        capData[i].set(s.x, s.z, s.h, s.presence);
        if (s.presence > 0) active = i + 1;
      }
      // Only draw the slots in use (slots past the last active one cost nothing).
      capGeo.instanceCount = active * CAP_PUFFS;
      cap.visible = active > 0 || firstFrame;
      firstFrame = false;
    },
    dispose() {
      scene.remove(dome, trade, cap, isles);
      for (const m of [dome, trade, cap, isles]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}
