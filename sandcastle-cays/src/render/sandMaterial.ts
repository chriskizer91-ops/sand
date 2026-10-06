/**
 * How sand looks: pale and sparkly when dry, darker and glossy when wet,
 * shadowed in crevices, and patterned with dancing light under the water.
 * Built on three.js's Lambert material so it gets the sun's shadows for free.
 */
import * as THREE from 'three';
import { PALETTE, glslColor } from './colors';

export interface SandUniforms {
  /** Debug views: 0 normal, 1 show surface direction, 2 show crevice shading, 3 show wetness. */
  uDebug: { value: number };
  uTime: { value: number };
  uWaterLevel: { value: number };
  uSunView: { value: THREE.Vector3 };
}

/** Shared GLSL helpers: hashing, value noise and underwater caustics. */
export const SAND_GLSL_COMMON = /* glsl */ `
float sc_hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float sc_hash2(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float sc_noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sc_hash2(i), sc_hash2(i + vec2(1.0, 0.0)), u.x),
             mix(sc_hash2(i + vec2(0.0, 1.0)), sc_hash2(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Bright, wobbly light network seen on a shallow sea floor.
float sc_caustics(vec2 uv, float t) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = p;
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
vec3 sc_sandColor(float wet) {
  vec3 col = mix(${glslColor(PALETTE.sandDry)}, ${glslColor(PALETTE.sandDamp)}, smoothstep(0.08, 0.42, wet));
  col = mix(col, ${glslColor(PALETTE.sandWet)}, smoothstep(0.55, 0.85, wet));
  col = mix(col, ${glslColor(PALETTE.sandSoaked)}, smoothstep(0.88, 1.0, wet));
  return col;
}
`;

/**
 * @param tint  the mesh has a `landTint` attribute (rgb + amount) to paint grass or rock over the sand
 * @param shared  reuse another sand material's uniforms (time, sun) so they stay in step
 */
export function createSandMaterial(tint = false, shared?: SandUniforms): { material: THREE.MeshLambertMaterial; uniforms: SandUniforms } {
  const uniforms: SandUniforms = shared ?? {
    uDebug: { value: 0 },
    uTime: { value: 0 },
    uWaterLevel: { value: 0 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
  };
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  if (tint) material.defines = { USE_LAND_TINT: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 sandAttr;
varying vec4 vSand;
varying vec3 vWorld;
#ifdef USE_LAND_TINT
attribute vec4 landTint;
varying vec4 vTint;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vSand = sandAttr;
#ifdef USE_LAND_TINT
vTint = landTint;
#endif
vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uWaterLevel;
uniform vec3 uSunView;
uniform float uDebug;
varying vec4 vSand;
varying vec3 vWorld;
#ifdef USE_LAND_TINT
varying vec4 vTint;
#endif
${SAND_GLSL_COMMON}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float sWet = vSand.x;
float sPack = vSand.y;
float sAo = vSand.z;
vec3 sCol = sc_sandColor(sWet);
float sTintA = 0.0;
#ifdef USE_LAND_TINT
sTintA = vTint.a;
sCol = mix(sCol, vTint.rgb, sTintA);
#endif
// Fine grain, fading out with distance so it never shimmers.
float sDist = length(vViewPosition);
float sFade = 1.0 - smoothstep(1.5, 9.0, sDist);
float sGrain = sc_hash3(floor(vWorld * 260.0)) - 0.5;
sCol *= 1.0 + sGrain * 0.16 * sFade * (1.0 - 0.6 * sPack);
// Gentle large-scale variation.
sCol *= 0.96 + 0.08 * sc_noise2(vWorld.xz * 1.1);
// Crevices and hollows are darker.
sCol *= mix(0.55, 1.0, sAo * sAo);
// Under the water: absorb reds first, and let light dance on the sand.
float sDepth = uWaterLevel - vWorld.y;
if (sDepth > 0.0) {
  vec3 absorb = exp(-sDepth * vec3(2.2, 0.55, 0.38));
  sCol *= absorb;
  float ca = sc_caustics(vWorld.xz * 0.42, uTime * 0.55);
  sCol += vec3(0.85, 0.95, 0.9) * ca * 0.35 * smoothstep(0.0, 0.08, sDepth) * exp(-sDepth * 1.2);
}
diffuseColor.rgb = sCol;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  vec3 V = normalize(vViewPosition);
  vec3 L = normalize(uSunView);
  vec3 H = normalize(L + V);
  float nh = max(dot(normal, H), 0.0);
  // Wet sand glistens.
  float wetSheen = pow(nh, 90.0) * smoothstep(0.75, 1.0, sWet) * 0.22;
  // Dry sand sparkles: a few grains catch the sun.
  float spark = step(0.988, sc_hash3(floor(vWorld * 420.0)));
  float sparkle = spark * pow(nh, 10.0) * (1.0 - smoothstep(0.1, 0.35, sWet)) * sFade * 0.7 * (1.0 - sTintA);
  outgoingLight += vec3(1.0, 0.97, 0.9) * (wetSheen + sparkle) * step(0.0, -sDepth + 0.0);
}
#include <opaque_fragment>
if (uDebug > 0.5) {
  vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
  if (uDebug < 1.5) gl_FragColor = vec4(nW * 0.5 + 0.5, 1.0);
  else if (uDebug < 2.5) gl_FragColor = vec4(vec3(sAo), 1.0);
  else gl_FragColor = vec4(vec3(sWet), 1.0);
}`,
      );
  };
  return { material, uniforms };
}
