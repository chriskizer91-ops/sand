/**
 * The sea. One camera-centred grid, fine around where you are looking and growing coarser
 * out to the horizon, moved by the same swell as waves.ts (so floating things ride it).
 *
 * Everything it shows comes from the world data the engine streams over:
 *   - the depth (height map) colours it: pale turquoise over white sand, teal over black sand,
 *     darker over coral, deep blue past 25 m, fully opaque by 30 m; it also damps and steepens
 *     the swell, so new islands are never swamped and waves steepen onto beaches;
 *   - foam: a lapping line at the waterline, a lacy fringe in the shallows, breaker bands on
 *     shores open to the swell, surf on reef crests and whitecaps in storms;
 *   - lava touching the sea (ground heat, steam reports, the live lava pour) turns the water
 *     milky jade and makes it fizz;
 *   - light: sky reflection from the shared sky colours, sun glint by day and a moonglade by
 *     night; storms grey it out and rain dimples it.
 *
 * Grid: (2M+1)^2 vertices (about 32k triangles, one draw call). The innermost 2*M0 steps are
 * evenly spaced, then each step is a little longer than the last, out to 14 km. The step near
 * the centre is a power of two picked from the camera height, and the grid snaps to it, so
 * the water never swims as the camera moves. Waves too short for the local spacing (vertex)
 * or pixel size (normal) fade out instead of shimmering; the grid is reported to waves.ts
 * each frame so seaHeight fades exactly the same waves.
 *
 * Cost: the quality tier is compiled in. Lighter (0) keeps one ripple layer and one foam
 * layer; the default (1, phones) adds raindrop rings and finer foam; richer (2) adds a
 * second ripple layer and close-up glitter.
 */
import * as THREE from 'three';
import { CELL, NX, NZ, SEA_LEVEL } from '../config';
import type { FromEngine, LifeInfo } from '../engine/protocol';
import { PourTracker } from './hands';
import { SEA_GRID_EVEN, SWELL, seaHeight, setSeaGrid, swellGLSL } from './waves';
import { WORLD_UNIFORMS_GLSL, type FrameCtx, type PageSystem, type SystemDeps } from './shared';

export interface OceanSystem extends PageSystem {
  /** Water surface height at a world point and time (matches what is drawn), for floating things. */
  waveHeight(x: number, z: number, t: number): number;
}

// ---------- GLSL helpers shared by the page effects (cursor, effects, hands) ----------

/** A colour (sRGB hex, as a designer picks it) as a GLSL vec3 in the linear space shaders work in. */
export function glslColor(hex: number): string {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
}

/**
 * Sin-free hash, value noise, and value noise with its slope. The lattice wraps every 4096
 * cells so far-away hashes keep their precision; the wrap is seamless (it falls on whole cells).
 */
export const GLSL_NOISE = /* glsl */ `
float ww_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float ww_vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 i0 = mod(i, 4096.0);
  vec2 i1 = mod(i + 1.0, 4096.0);
  return mix(mix(ww_hash12(i0), ww_hash12(vec2(i1.x, i0.y)), u.x),
             mix(ww_hash12(vec2(i0.x, i1.y)), ww_hash12(i1), u.x), u.y);
}
// Value noise and its slope: (value, d/dx, d/dy).
vec3 ww_vnoiseGrad(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  vec2 i0 = mod(i, 4096.0);
  vec2 i1 = mod(i + 1.0, 4096.0);
  float a = ww_hash12(i0);
  float b = ww_hash12(vec2(i1.x, i0.y));
  float c = ww_hash12(vec2(i0.x, i1.y));
  float d = ww_hash12(i1);
  float k = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du.x * (b - a + k * u.y), du.y * (c - a + k * u.x));
}
`;

/**
 * The visible ground height at a world point from heightTex, with manual bilinear filtering
 * (the R32F map is NEAREST: phones can't filter float textures). Outside the zone the bank
 * drops away into the open ocean, which is what makes the far sea a deep blue.
 * Needs `uniform sampler2D uHeightTex;` and the world uniforms (uZone) declared first.
 */
export const GLSL_GROUND = /* glsl */ `
const float WW_CELL = ${CELL.toFixed(1)};
const vec2 WW_GRID_MAX = vec2(${(NX - 1).toFixed(1)}, ${(NZ - 1).toFixed(1)});
float ww_ground(vec2 xz) {
  vec2 g = (xz - uZone.xy) / WW_CELL - 0.5;
  vec2 g0 = floor(g);
  vec2 t = clamp(g - g0, 0.0, 1.0);
  ivec2 a = ivec2(clamp(g0, vec2(0.0), WW_GRID_MAX));
  ivec2 b = ivec2(clamp(g0 + 1.0, vec2(0.0), WW_GRID_MAX));
  float h00 = texelFetch(uHeightTex, a, 0).r;
  float h10 = texelFetch(uHeightTex, ivec2(b.x, a.y), 0).r;
  float h01 = texelFetch(uHeightTex, ivec2(a.x, b.y), 0).r;
  float h11 = texelFetch(uHeightTex, b, 0).r;
  float h = mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  vec2 outside = max(abs(xz - uZone.xy - 0.5 * uZone.zw) - 0.5 * uZone.zw, 0.0);
  return h - length(outside) * 0.12;
}
`;

// ---------- the grid ----------

/** Vertices from the centre to each edge (the grid is 2M+1 vertices across). */
const M = 63;
/** Evenly spaced steps each side of the centre (shared with seaHeight, which fades the same waves). */
const M0 = SEA_GRID_EVEN;
/** How far the grid reaches (m). */
const EXTENT = 14000;
/** Centre step sizes (m), picked by camera height. */
const STEPS = [0.5, 1, 2, 4, 8];
/** Camera height (m) per metre of centre step. */
const HEIGHT_PER_STEP = 22;

/** The growth ratio that makes a grid with this centre step reach EXTENT. */
function growthRatio(step: number): number {
  const steps = M - M0;
  const want = EXTENT / step - M0;
  let lo = 1.0001;
  let hi = 2.5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if ((Math.pow(mid, steps) - 1) / (mid - 1) < want) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
const RATIOS = STEPS.map(growthRatio);

/** The sea grid's shape, for the checks: vertices to each edge, evenly spaced steps, reach, centre steps and growth ratios. */
export const OCEAN_GRID = { M, M0, EXTENT, STEPS, RATIOS } as const;

function makeGridGeometry(): THREE.BufferGeometry {
  const n = 2 * M + 1;
  const pos = new Float32Array(n * n * 3);
  let p = 0;
  for (let j = -M; j <= M; j++) {
    for (let i = -M; i <= M; i++) {
      pos[p++] = i;
      pos[p++] = 0;
      pos[p++] = j;
    }
  }
  const idx = new Uint16Array((n - 1) * (n - 1) * 6);
  let q = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      idx[q++] = a;
      idx[q++] = c;
      idx[q++] = b;
      idx[q++] = b;
      idx[q++] = c;
      idx[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), EXTENT * 2);
  return g;
}

// ---------- hot water ----------

/** How many hot-water spots the shader knows about (unrolled, so keep it at 4). */
export const HOT_SPOTS = 4;

/**
 * Where lava has just met the sea: up to four spots (x, z, radius, strength 0..1), fed by
 * steam reports and the live lava pour, fading over a few seconds.
 */
export class HotSpots {
  /** x, z, radius, strength per spot. */
  readonly data = new Float32Array(HOT_SPOTS * 4);

  /** Heat the water within `radius` m of (x, z); strength 0..1. Nearby spots merge. */
  add(x: number, z: number, strength: number, radius: number): void {
    const d = this.data;
    let weakest = 0;
    for (let s = 0; s < HOT_SPOTS; s++) {
      const o = s * 4;
      if (d[o + 3] > 0.01 && Math.hypot(d[o] - x, d[o + 1] - z) < 24) {
        // Drift toward the newest contact, weighted by how strong it is; the warm patch eases
        // toward the newest contact's size but never shrinks below it.
        const w = strength / (strength + d[o + 3]);
        d[o] += (x - d[o]) * w;
        d[o + 1] += (z - d[o + 1]) * w;
        d[o + 2] = Math.max(radius, d[o + 2] * 0.99);
        d[o + 3] = Math.min(1, Math.max(d[o + 3], strength));
        return;
      }
      if (d[o + 3] < d[weakest * 4 + 3]) weakest = s;
    }
    if (strength <= d[weakest * 4 + 3]) return;
    const o = weakest * 4;
    d[o] = x;
    d[o + 1] = z;
    d[o + 2] = radius;
    d[o + 3] = strength;
  }

  /** Let the water cool (time constant about 3.5 s). */
  cool(dt: number): void {
    const k = Math.exp(-dt / 3.5);
    for (let s = 0; s < HOT_SPOTS; s++) this.data[s * 4 + 3] *= k;
  }
}

/** Steam strength (engine units) to a 0..1 contact level, saturating for big contacts. */
export function steamLevel(strength: number): number {
  return 1 - Math.exp(-2 * Math.max(0, strength));
}

// ---------- night glow (bioluminescence) ----------

/** How many glowing lagoons the shader knows about (unrolled). */
const GLOW_AREAS = 3;

// ---------- shaders ----------

const UPWIND_X = -SWELL[0].dx;
const UPWIND_Z = -SWELL[0].dz;

const VERTEX = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform sampler2D uHeightTex;
uniform vec4 uGrid;
uniform float uGridM0;
varying vec3 vWorld;
varying vec2 vGrid;
varying float vAmp;
varying float vSteep;
varying float vCrest;
#include <common>
#include <fog_pars_vertex>
${GLSL_GROUND}
${swellGLSL()}
float ww_gridOffset(float i) {
  float a = abs(i);
  float o = a <= uGridM0 ? uGrid.z * a : uGrid.z * (uGridM0 + (pow(uGrid.w, a - uGridM0) - 1.0) / (uGrid.w - 1.0));
  return sign(i) * o;
}
float ww_gridStep(float i) {
  return uGrid.z * pow(uGrid.w, max(abs(i) - uGridM0, 0.0));
}
void main() {
  vec2 p = uGrid.xy + vec2(ww_gridOffset(position.x), ww_gridOffset(position.z));
  float spacing = max(ww_gridStep(position.x), ww_gridStep(position.z));
  float depth = max(uSeaLevel - ww_ground(p), 0.0);
  float amp = ww_swellAmp(uStorm, depth);
  float steepK = ww_swellSteep(depth);
  vec3 o = ww_swell(p, uTime, amp, steepK, spacing);
  // The swash only where the grid can carry it (close to the camera's target).
  float lift = ww_swash(p, uTime, uStorm, depth, spacing);
  vec3 w = vec3(p.x + o.x, uSeaLevel + o.y + lift, p.y + o.z);
  vWorld = w;
  vGrid = p;
  vAmp = amp;
  vSteep = steepK;
  vCrest = o.y / (amp * WW_SWELL_SUM + 0.001);
  vec4 mvPosition = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform sampler2D uHeightTex;
uniform sampler2D uGroundTex;
uniform sampler2D uCoverCTex;
uniform vec4 uHot[${HOT_SPOTS}];
uniform vec4 uGlow[${GLOW_AREAS}];
varying vec3 vWorld;
varying vec2 vGrid;
varying float vAmp;
varying float vSteep;
varying float vCrest;
#include <common>
#include <fog_pars_fragment>
${GLSL_NOISE}
${GLSL_GROUND}
${swellGLSL()}
const vec2 WW_UPWIND = vec2(${UPWIND_X.toFixed(5)}, ${UPWIND_Z.toFixed(5)});
// The column under a point (clamped to the zone).
ivec2 ww_column(vec2 xz) {
  return ivec2(clamp(floor((xz - uZone.xy) / WW_CELL), vec2(0.0), WW_GRID_MAX));
}
// Nearest-column ground height: enough to tell open water from land upwind.
float ww_groundCoarse(vec2 xz) {
  return texelFetch(uHeightTex, ww_column(xz), 0).r;
}
float ww_hotSpot(vec4 s, vec2 q) {
  return s.w * (1.0 - smoothstep(s.z * 0.35, s.z, distance(q, s.xy)));
}
float ww_glowArea(vec4 g, vec2 q) {
  return g.w * (1.0 - smoothstep(g.z * 0.7, g.z * 1.2, distance(q, g.xy)));
}
void main() {
  vec2 q = vWorld.xz;
  float ground = ww_ground(q);
  float rawDepth = vWorld.y - ground;
  // Rates across the screen, taken first, while every pixel of each 2x2 block is still running:
  // metres of sea per pixel (waves, ripples and glitter finer than this fade instead of
  // shimmering), how fast the depth changes per pixel, and how steep the sea floor is.
  float fp = length(fwidth(vGrid)) + 0.001;
  float depthRate = fwidth(rawDepth);
  float slope = fwidth(ground) / fp;
  // Land: the water ends where the height map's ground rises out of it. Far away, where the
  // terrain mesh is coarser than the height map, the water may reach a little past that line
  // (a height that grows with the pixel size, up to half a metre), so small dips of a coarse
  // mesh stay wet instead of showing dry notches along the coast. Where the mesh stands above
  // the water the depth test hides it anyway.
  float shoreReach = 0.03 + min(0.25 * fp, 0.5);
  if (rawDepth < -shoreReach) discard;
  float depth = max(rawDepth, 0.0);
  vec3 toEye = uCamPos - vWorld;
  vec3 V = toEye / max(length(toEye), 0.001);

  // ---- what lies under the water ----
  vec2 zuv = (q - uZone.xy) / uZone.zw;
  vec4 gr = texture2D(uGroundTex, zuv);
  vec4 cc = texture2D(uCoverCTex, zuv);
  float sandCover = smoothstep(0.004, 0.05, gr.b);
  // Rock kind lives in the low bits, which filtering would smear: read the nearest column exactly.
  float rockKind = mod(floor(texelFetch(uGroundTex, ww_column(q), 0).a * 255.0 + 0.5), 4.0);
  float rockBright = rockKind < 0.5 ? 0.1 : (rockKind < 1.5 ? 0.45 : 0.8);
  float bright = mix(rockBright, gr.a, sandCover);
  // Saturated, because the water is still thin here: over white sand it reads pale turquoise.
  vec3 shallow = mix(${glslColor(0x1f8f8c)}, ${glslColor(0x2bd4dc)}, bright);
  if (cc.r + cc.g > 0.01) {
    // Coral heads and seagrass beds, mottled.
    float mott = ww_vnoise(q * 0.3);
    shallow = mix(shallow, ${glslColor(0x2a9a9a)} * (0.75 + 0.5 * mott), cc.r * 0.75);
    shallow = mix(shallow, ${glslColor(0x4f8a3a)}, cc.g * 0.5 * (0.6 + 0.4 * mott));
  }
  vec3 body = mix(shallow, ${glslColor(0x22a7c4)}, smoothstep(1.5, 12.0, depth));
  body = mix(body, ${glslColor(0x1279b8)}, smoothstep(8.0, 26.0, depth));
  body = mix(body, ${glslColor(0x0b4f8a)}, smoothstep(30.0, 90.0, depth));
  // Tinted quickly in the first metre or two (so the shallows read turquoise), then slowly,
  // so the sea floor still shows through ten metres of water; opaque by 30 m.
  float alpha = 0.4 * (1.0 - exp(-depth * 1.2)) + 0.6 * (1.0 - exp(-depth * 0.08));
  alpha = mix(alpha, 1.0, smoothstep(18.0, 30.0, depth));

  // ---- heat: lava in or beside the water turns it milky jade ----
  float heat = smoothstep(0.0, 0.03, gr.r) * gr.g;
  heat = max(heat, ww_hotSpot(uHot[0], q));
  heat = max(heat, ww_hotSpot(uHot[1], q));
  heat = max(heat, ww_hotSpot(uHot[2], q));
  heat = max(heat, ww_hotSpot(uHot[3], q));
  heat *= mix(1.0, 0.6, smoothstep(10.0, 30.0, depth));
  body = mix(body, ${glslColor(0xb9e3c8)}, heat * 0.8);
  alpha = max(alpha, heat * 0.85);

  // ---- light on the water: moonlit at night, grey in storms ----
  vec3 illum = mix(vec3(1.0), ${glslColor(0x3a4d72)}, uNight) * mix(vec3(1.0), uSunColor, 0.25) * (1.0 - 0.3 * uStorm);
  body *= illum;
  body = mix(body, ${glslColor(0x4f7c80)} * illum, uStorm * 0.5);

  // ---- surface normal: swell, wind ripples (in slowly wandering gusty patches), raindrop rings ----
  float gusty = ww_vnoise(q * 0.015 + vec2(cos(uTime * 0.05236), sin(uTime * 0.05236)) * 2.0);
  vec3 n = ww_swellNormal(vGrid, uTime, vAmp, vSteep, fp);
  float near = 1.0 - smoothstep(0.06, 0.45, fp);
  if (near > 0.0) {
    float wk = (0.35 + length(uWind.xy) + 0.8 * uStorm) * (0.5 + gusty);
    // Rippled noise sloshing to and fro (period 4.5 s); richer quality adds a finer layer (3.6 s).
    vec3 g1 = ww_vnoiseGrad(q * 0.9 + vec2(cos(uTime * 1.3963), sin(uTime * 1.3963)) * 1.7);
#if WW_TIER >= 2
    vec3 g2 = ww_vnoiseGrad(mat2(0.8, 0.6, -0.6, 0.8) * q * 2.1 + vec2(cos(uTime * 1.7453), -sin(uTime * 1.7453)) * 1.3);
    vec2 ripple = g1.yz * 0.9 + (mat2(0.8, -0.6, 0.6, 0.8) * g2.yz) * 0.95;
#else
    vec2 ripple = g1.yz * 1.3;
#endif
    n = normalize(n - vec3(ripple.x, 0.0, ripple.y) * 0.1 * wk * near);
#if WW_TIER >= 1
    if (uRain > 0.01) {
      vec2 rq = q * 1.4;
      vec2 ci = floor(rq);
      vec2 cf = rq - ci - 0.5;
      float h = ww_hash12(mod(ci, 4096.0));
      vec2 dv = cf - (vec2(h, fract(h * 23.17)) - 0.5) * 0.5;
      float age = fract(uTime * 1.25 + h);
      float dl = length(dv) + 0.0001;
      float ring = (1.0 - smoothstep(0.0, 0.07, abs(dl - age * 0.5))) * (1.0 - age);
      n = normalize(n + vec3(dv.x, 0.0, dv.y) / dl * ring * 0.6 * uRain * near);
    }
#endif
  }
  // Rougher patches read a touch darker from afar, calm slicks a touch brighter.
  body *= 0.93 + 0.14 * (1.0 - gusty);
  // ---- sky reflection, sun glint, moonglade ----
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 sky = mix(uFogColor, uSkyColor * vec3(0.5, 0.72, 1.0), pow(R.y, 0.6)) * (1.0 - 0.3 * uStorm);
  vec3 col = mix(body, sky, min(1.0, fres * (1.0 - 0.35 * uStorm) * (0.85 + 0.3 * gusty)));
  alpha = max(alpha, fres);
  float rs = max(dot(R, uSunDir), 0.0);
  float shin = mix(700.0, 110.0, uNight);
  float glint = pow(rs, shin) * mix(1.9, 1.4, uNight);
#if WW_TIER >= 2
  // Close up, the glare breaks into glitter on the tiniest ripples (cells about 8 cm across, so
  // it only shows while a pixel is smaller than a cell; further off it would just twinkle).
  float nearGlitter = 1.0 - smoothstep(0.02, 0.07, fp);
  if (glint > 0.004 && nearGlitter > 0.0) {
    float sparkle = ww_vnoise(q * 13.0 + vec2(sin(uTime * 2.618), cos(uTime * 2.0944)) * 3.0);
    glint *= mix(1.0, smoothstep(0.55, 0.8, sparkle) * 3.0, nearGlitter);
  }
#endif
  glint = (glint + pow(rs, 48.0) * mix(0.12, 0.07, uNight)) * smoothstep(-0.04, 0.08, uSunDir.y) * (1.0 - 0.85 * uStorm);
  col += uSunColor * glint;
  alpha = max(alpha, min(glint, 1.0));

  // ---- foam ----
  float shoreBand = 1.0 - smoothstep(0.0, 1.0, depth);
  float foam = shoreBand * (0.25 + 0.35 * uStorm) + (1.0 - smoothstep(0.0, 0.06 + 0.12 * uStorm, depth));
  float crest = 0.0;
  if (depth < 8.0) {
    // Open water upwind means a windward shore, where the swell breaks.
    float up = uSeaLevel - max(ww_groundCoarse(q + WW_UPWIND * 18.0), ww_groundCoarse(q + WW_UPWIND * 45.0));
    float exposure = smoothstep(1.0, 4.5, up);
    // Breaking waves. Out in the surf zone each passing swell crest (the very waves the grid
    // draws) turns white, so the white water rolls in with the swell and never traces depth
    // contours. In the last metre or so the foam rides the swash up and down the beach instead.
    float swellCrest = smoothstep(0.05, 0.45, vCrest);
    float th = WW_SWASH_OMEGA * uTime + ww_swashPhase(q) + depth * 5.2;
    float swashCrest = pow(0.5 + 0.5 * sin(th), 3.0);
    // Where the swash bands would crowd closer than about a pixel (far away, or a steep shore),
    // show their average instead.
    float resolved = (1.0 - smoothstep(0.6, 1.3, depthRate * 5.2)) * (1.0 - smoothstep(0.15, 0.35, slope));
    swashCrest = mix(0.3125, swashCrest, resolved);
    crest = mix(swashCrest, swellCrest, smoothstep(0.6, 1.5, depth));
    // Waves break where the water is not much deeper than they are tall: a narrow band in calm
    // weather, a wide surf zone in a storm.
    float zone = smoothstep(0.25, 0.8, depth) * (1.0 - smoothstep(1.2 + 3.3 * uStorm, 2.5 + 5.5 * uStorm, depth));
    foam += exposure * zone * crest * (0.45 + 0.5 * uStorm);
    // Surf on a reef crest offshore, as each swell crest passes.
    foam += smoothstep(0.25, 0.75, cc.b) * exposure * (0.3 + 0.7 * swellCrest) * 0.8;
  }
  if (uStorm > 0.05) {
    // Whitecaps: one may bloom and fade (over 4 s) in each 7 m cell, stretched along the crest,
    // more often on high crests.
    vec2 wq = q / 7.0;
    vec2 ci = floor(wq);
    float h = ww_hash12(mod(ci, 4096.0));
    vec2 d = wq - ci - 0.5 - (vec2(h, fract(h * 31.7)) - 0.5) * 0.5;
    d = vec2(dot(d, WW_UPWIND), dot(d, vec2(-WW_UPWIND.y, WW_UPWIND.x))) * vec2(2.6, 1.0);
    float life = fract(uTime * 0.25 + h);
    // Some caps are small, some broad, so they don't read as a dotted grid.
    float sz = 0.55 + 0.6 * fract(h * 13.7);
    float cap = (1.0 - smoothstep(0.06 * sz, (0.16 + 0.18 * life) * sz, length(d))) * smoothstep(0.0, 0.12, life) * (1.0 - life);
    cap *= step(0.45 - 0.25 * uStorm, fract(h * 7.31)) * smoothstep(-0.3, 0.4, vCrest);
    foam += cap * uStorm * 1.6;
  }
  foam += heat * heat * 0.35;
  float fv = 0.0;
  if (foam > 0.003) {
    // Lacy foam that sloshes with the swash, fizzing fast over hot water.
    vec2 drift = vec2(cos(uTime * WW_SWASH_OMEGA), sin(uTime * WW_SWASH_OMEGA)) * 0.35;
    vec2 fizz = vec2(cos(uTime * 8.3776), sin(uTime * 8.3776)) * 0.6 * heat;
#if WW_TIER >= 1
    float fn = ww_vnoise(q * 1.7 + drift + fizz) * 0.6 + ww_vnoise(q * 4.3 - drift * 1.7 - fizz) * 0.4;
#else
    float fn = ww_vnoise(q * 1.7 + drift + fizz);
#endif
    // Ridges of the noise make a web of foam lines that fill in as the foam thickens.
    float web = 1.0 - abs(2.0 * fn - 1.0);
    float lace = smoothstep(1.0 - foam * 0.8, 1.18 - foam * 0.8, web * 0.75 + fn * 0.35) * min(1.0, foam * 2.5);
    // Far away the lace is finer than a pixel: show its average instead.
    fv = mix(lace, min(foam, 1.0) * 0.6, smoothstep(0.4, 2.5, fp));
    vec3 foamCol = mix(vec3(0.97, 0.99, 1.0), ${glslColor(0xe4f6e8)}, heat) * (0.15 + 0.85 * illum);
    col = mix(col, foamCol, fv);
    alpha = max(alpha, fv);
  }

  // ---- glowing plankton in the lagoons of some islands, at night ----
  float glow = ww_glowArea(uGlow[0], q) + ww_glowArea(uGlow[1], q) + ww_glowArea(uGlow[2], q);
  glow *= uNight * (1.0 - smoothstep(4.0, 12.0, depth));
  col += ${glslColor(0x5ff2d0)} * glow * (fv * 1.6 + crest * 0.4);
  alpha = max(alpha, glow * fv);

  // A thin film of water at the very edge stays see-through.
  alpha *= smoothstep(-shoreReach, 0.03, rawDepth);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ---------- the system ----------

export function createOcean(deps: SystemDeps): OceanSystem {
  const { scene, fields, u, species, quality } = deps;
  const glowSpecies = new Set(species.filter((s) => s.effect === 'glow').map((s) => s.id));

  const grid = new THREE.Vector4(0, 0, STEPS[1], RATIOS[1]);
  const hot = Array.from({ length: HOT_SPOTS }, () => new THREE.Vector4());
  const glowAreas = Array.from({ length: GLOW_AREAS }, () => new THREE.Vector4());
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...u,
    uGrid: { value: grid },
    uGridM0: { value: M0 },
    uHot: { value: hot },
    uGlow: { value: glowAreas },
  };
  // Quality tier as a compile-time switch: lighter drops the finer ripples, glitter, rain rings and foam detail.
  let tier = quality.tier;
  const material = new THREE.ShaderMaterial({
    name: 'ocean',
    defines: { WW_TIER: tier },
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const mesh = new THREE.Mesh(makeGridGeometry(), material);
  mesh.name = 'ocean';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  scene.add(mesh);

  const spots = new HotSpots();
  const pour = new PourTracker();
  let level = 1;
  let lastLife: LifeInfo | null = null;

  /** Recompute the glowing lagoons when the life summary changes. */
  function updateGlow(life: LifeInfo | null): void {
    for (const g of glowAreas) g.set(0, 0, 0, 0);
    if (!life || glowSpecies.size === 0) return;
    let k = 0;
    for (const p of life.pops) {
      if (k >= GLOW_AREAS) break;
      if (!glowSpecies.has(p.species) || p.n <= 0) continue;
      const isl = life.islands.find((i) => i.id === p.island);
      if (!isl) continue;
      const [x0, z0, x1, z1] = isl.bbox;
      glowAreas[k++].set((x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2 + 30, Math.min(1, p.n * 1.5));
    }
  }

  return {
    name: 'ocean',
    waveHeight(x: number, z: number, t: number): number {
      return seaHeight(x, z, t, u.uStorm.value, fields.waterDepthAt(x, z));
    },
    onEngine(m: FromEngine) {
      if (m.t !== 'tick') return;
      pour.onEngine(m);
      const s = m.events.steam;
      for (let i = 0; i + 2 < s.length; i += 3) {
        const level = steamLevel(s[i + 2]);
        spots.add(s[i], s[i + 1], level, 8 + 14 * level);
      }
    },
    update(f: FrameCtx) {
      if (f.quality.tier !== tier) {
        // The quality setting changed (rare): rebuild the shader for the new tier.
        tier = f.quality.tier;
        material.defines.WW_TIER = tier;
        material.needsUpdate = true;
      }
      // Centre step from the camera height, with some hysteresis so it doesn't flicker.
      const h = Math.max(1, f.camera.position.y - SEA_LEVEL);
      const want = Math.log2(h / HEIGHT_PER_STEP / STEPS[0]);
      if (Math.abs(want - level) > 0.65) level = Math.max(0, Math.min(STEPS.length - 1, Math.round(want)));
      const step = STEPS[level];
      // Centre a little toward the camera from its target, so the fine part covers the foreground too.
      const cx = f.cam.target.x + (f.camera.position.x - f.cam.target.x) * 0.35;
      const cz = f.cam.target.z + (f.camera.position.z - f.cam.target.z) * 0.35;
      grid.set(Math.round(cx / step) * step, Math.round(cz / step) * step, step, RATIOS[level]);
      // Floating things read the sea through seaHeight: tell it which waves this grid carries.
      setSeaGrid(grid.x, grid.y, grid.z, grid.w);

      // Hot water: the live lava pour into the sea heats it at once.
      pour.advance(f.dt);
      if (pour.active && pour.tool === 'lava' && fields.waterDepthAt(pour.x, pour.z) > 0.2) spots.add(pour.x, pour.z, 1, Math.max(6, pour.r * 2.5));
      spots.cool(f.dt);
      for (let s = 0; s < HOT_SPOTS; s++) hot[s].fromArray(spots.data, s * 4);

      if (f.life !== lastLife) {
        lastLife = f.life;
        updateGlow(f.life);
      }
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      setSeaGrid(0, 0, 0, 1);
    },
  };
}
