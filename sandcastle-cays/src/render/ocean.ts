/**
 * The sea (from the raft game). You can see into it: whatever is under the
 * surface (sand, the hull, a swimmer's legs) fades into the water's colour
 * with depth. The surface reflects the sky, sparkles where the sun hits it,
 * and foams in a thin line wherever something breaks it: the beach, the hull,
 * rocks. At night anything that disturbs it glows.
 *
 * Changes for the islands: the swell is calmer inside the reef and dies away
 * over the beach (so holes dug in the sand hold still water), using a map of
 * the sea floor. The same numbers run on the CPU (`seaHeight`) for anything
 * that floats, so what you see is where things float.
 */
import * as THREE from 'three';
import { waterDetailTexture } from './paint';
import { OPEN_FROM, OPEN_FULL, SHELTERS, openness } from '../game/weather';

const G = 9.8;

/** Trade wind from the east: chop runs west (-x); a long swell rolls onto the south beach (+z). */
const WAVES = [
  { dir: [0.25, 1.0], len: 14, amp: 0.14, phase: 0.0 },
  { dir: [-1.0, 0.3], len: 7.5, amp: 0.075, phase: 1.7 },
  { dir: [-0.55, 0.8], len: 4.2, amp: 0.04, phase: 4.1 },
  { dir: [-0.9, -0.45], len: 2.4, amp: 0.018, phase: 2.6 },
].map((w) => {
  const l = Math.hypot(w.dir[0], w.dir[1]);
  const k = (Math.PI * 2) / w.len;
  return { dx: w.dir[0] / l, dz: w.dir[1] / l, k, w: Math.sqrt(G * k), amp: w.amp, phase: w.phase };
});

/**
 * The open sea's long ocean swell, rolling in from the east: about a metre
 * high at its biggest, long enough for a boat to surf down. Only beyond the
 * reefs (scaled by how open the sea is there).
 */
const OPEN_WAVES = [
  { dir: [-1.0, 0.12], len: 52, amp: 0.5, phase: 0.4 },
  { dir: [-0.85, -0.5], len: 33, amp: 0.27, phase: 2.2 },
  { dir: [-0.95, 0.38], len: 21, amp: 0.13, phase: 5.0 },
].map((w) => {
  const l = Math.hypot(w.dir[0], w.dir[1]);
  const k = (Math.PI * 2) / w.len;
  return { dx: w.dir[0] / l, dz: w.dir[1] / l, k, w: Math.sqrt(G * k), amp: w.amp, phase: w.phase };
});
/** The biggest the open swell gets (metres above the mean). */
export const OPEN_SWELL_MAX = OPEN_WAVES.reduce((a, w) => a + w.amp, 0);

/** The open swell's height at x, z, time t (before scaling by how open the sea is). */
function openWaves(x: number, z: number, t: number): number {
  let h = 0;
  for (const w of OPEN_WAVES) h += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t + w.phase);
  return h;
}

/**
 * How big the waves are over a sea floor at height `floor` (metres, sea
 * level = 0): nothing over the beach, gentle in the lagoon, full swell in
 * deep water beyond the reef. The shader computes exactly the same thing.
 */
export function swellAt(floor: number): number {
  const shore = smoothstep(0.32, -0.1, floor);
  const deep = smoothstep(-5, -14, floor);
  return shore * (0.42 + 0.58 * deep);
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Raw wave sum at x, z, time t (before the floor scaling). */
function rawWaves(x: number, z: number, t: number): number {
  let h = 0;
  for (const w of WAVES) h += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t + w.phase);
  return h;
}

export class SeaFloorMap {
  readonly tex: THREE.DataTexture;
  readonly rect: THREE.Vector4;
  /**
   * @param floorAt height of the untouched sea floor and land (metres)
   * @param size    metres covered, centred on (cx, cz)
   */
  constructor(
    readonly floorAt: (x: number, z: number) => number,
    cx: number,
    cz: number,
    size: number,
    res: number,
  ) {
    const data = new Uint16Array(res * res);
    const x0 = cx - size / 2;
    const z0 = cz - size / 2;
    for (let zi = 0; zi < res; zi++) {
      for (let xi = 0; xi < res; xi++) {
        const x = x0 + ((xi + 0.5) / res) * size;
        const z = z0 + ((zi + 0.5) / res) * size;
        data[xi + zi * res] = THREE.DataUtils.toHalfFloat(floorAt(x, z));
      }
    }
    this.tex = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.HalfFloatType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;
    this.rect = new THREE.Vector4(x0, z0, size, size);
  }
}

const f = (n: number) => n.toFixed(5);
const glslWaves = WAVES.map(
  (w) => `{
    float th = ${f(w.k)} * (${f(w.dx)} * p.x + ${f(w.dz)} * p.y) - ${f(w.w)} * t + ${f(w.phase)};
    h += ${f(w.amp)} * sin(th);
    float c = ${f(w.amp * w.k)} * cos(th);
    dx += c * ${f(w.dx)};
    dz += c * ${f(w.dz)};
  }`,
).join('\n');

const glslOpenWaves = OPEN_WAVES.map(
  (w) => `{
    float th = ${f(w.k)} * (${f(w.dx)} * p.x + ${f(w.dz)} * p.y) - ${f(w.w)} * t + ${f(w.phase)};
    h += ${f(w.amp)} * sin(th);
    float c = ${f(w.amp * w.k)} * cos(th);
    dx += c * ${f(w.dx)};
    dz += c * ${f(w.dz)};
  }`,
).join('\n');

const glslOpenness = `
float openness(vec2 p) {
  float d = 1e9;
  ${SHELTERS.map((sh) => `d = min(d, length(p - vec2(${f(sh.x)}, ${f(sh.z)})) - ${f(sh.r)});`).join('\n  ')}
  return smoothstep(${f(OPEN_FROM)}, ${f(OPEN_FULL)}, d);
}`;

const VERT = /* glsl */ `
uniform float uTime, uSwell, uOpenSwell;
uniform sampler2D tFloor;
uniform vec4 uFloorRect;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vH;
varying float vViewZ;
varying float vFloor;
varying float vOpen;
varying float vHo;

void waves(vec2 p, float t, out float h, out float dx, out float dz) {
  h = 0.0; dx = 0.0; dz = 0.0;
  ${glslWaves}
}
void openWaves(vec2 p, float t, out float h, out float dx, out float dz) {
  h = 0.0; dx = 0.0; dz = 0.0;
  ${glslOpenWaves}
}
${glslOpenness}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 fuv = (wp.xz - uFloorRect.xy) / uFloorRect.zw;
  float floorH = (fuv.x > 0.0 && fuv.y > 0.0 && fuv.x < 1.0 && fuv.y < 1.0) ? texture2D(tFloor, fuv).r : -30.0;
  float shore = 1.0 - smoothstep(-0.1, 0.32, floorH);
  float amp = shore * (0.42 + 0.58 * (1.0 - smoothstep(-14.0, -5.0, floorH))) * uSwell;
  float h, dx, dz;
  waves(wp.xz, uTime, h, dx, dz);
  // Far away the swell flattens out under the haze; saves shimmer.
  float camDist = length(wp.xz - cameraPosition.xz);
  float fade = 1.0 - smoothstep(140.0, 450.0, camDist);
  amp *= fade;
  // The open sea's long swell (fades further out, so the horizon stays lumpy).
  float open = openness(wp.xz);
  float oh = 0.0, odx = 0.0, odz = 0.0;
  float oamp = open * uOpenSwell * (1.0 - smoothstep(220.0, 700.0, camDist));
  // Sheltered water has no ocean swell: skip the sums there.
  if (oamp > 0.0) openWaves(wp.xz, uTime, oh, odx, odz);
  wp.y += h * amp + oh * oamp;
  vH = h * amp;
  vHo = oh / ${f(OPEN_SWELL_MAX)} * step(0.001, oamp);
  vOpen = open;
  vFloor = floorH;
  vNormalW = normalize(vec3(-dx * amp - odx * oamp, 1.0, -dz * amp - odz * oamp));
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
#include <packing>
uniform float uTime, uNear, uFar, uFogDensity, uRefract, uGlow, uDay, uWind, uSquallOn;
uniform vec4 uSquall[4];
uniform vec2 uScreen;
uniform vec3 uSunDir, uSunColor, uDeep, uShallow, uFogColor, uAbsorb;
uniform sampler2D tDetail, tScene, tDepth;
uniform samplerCube tSky;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vH;
varying float vViewZ;
varying float vFloor;
varying float vOpen;
varying float vHo;

float sceneViewZ(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return -perspectiveDepthToViewZ(d, uNear, uFar);
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // Squalls: rough, dark water under each one (rain on the surface, gusts).
  float sq = 0.0;
  if (uSquallOn > 0.5) {
    for (int i = 0; i < 4; i++) {
      vec4 s = uSquall[i];
      float d = length(vWorld.xz - s.xy);
      sq = max(sq, s.w * (1.0 - smoothstep(0.45 * s.z, 1.25 * s.z, d)));
    }
  }
  // The wind here: the trade wind, half as strong again on the open sea, more under a squall.
  float windHere = uWind * (1.0 + 0.5 * vOpen) + 6.0 * sq;

  // Two scrolling layers of small ripples on top of the swell (calmer over the sand, rougher in a blow).
  float calm = (0.45 + 0.55 * (1.0 - smoothstep(-2.5, 0.1, vFloor))) * (1.0 + 0.35 * vOpen + 0.8 * sq);
  vec2 uvA = vWorld.xz * 0.11 + vec2(uTime * 0.018, uTime * 0.011);
  vec2 uvB = vWorld.xz * 0.37 + vec2(-uTime * 0.021, uTime * 0.03);
  vec4 dA = texture2D(tDetail, uvA);
  vec4 dB = texture2D(tDetail, uvB);
  vec2 bump = (dA.xy * 2.0 - 1.0) * 0.5 + (dB.xy * 2.0 - 1.0) * 0.32;
  bump *= (1.0 - smoothstep(20.0, 160.0, dist) * 0.8) * calm;
  vec3 N = normalize(vNormalW + vec3(bump.x, 0.0, bump.y));

  float NdV = max(dot(N, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 refl = textureCube(tSky, R).rgb;

  // What is under the surface: the scene behind it, bent a little and fading
  // into the water's own colour with depth.
  vec2 suv = gl_FragCoord.xy / uScreen;
  vec2 off = N.xz * uRefract / max(1.0, dist * 0.15);
  float behindZ = sceneViewZ(suv + off);
  if (behindZ < vViewZ) { off = vec2(0.0); behindZ = sceneViewZ(suv); }
  float thick = behindZ - vViewZ;
  bool inFront = thick < -0.05;
  thick = inFront ? 60.0 : max(thick, 0.0);
  vec3 behind = texture2D(tScene, suv + off).rgb;
  vec3 absorb = exp(-uAbsorb * thick);

  float sunUp = clamp(uSunDir.y * 2.0, 0.2, 1.0);
  float lightLvl = mix(0.08, 1.0, uDay);
  vec3 body = uDeep * sunUp * lightLvl;
  // Light scattering up through thin crests on the far side of a wave.
  float back = pow(max(dot(-V, uSunDir) * 0.5 + 0.5, 0.0), 3.0);
  body += uShallow * clamp(vH * 3.0 + 0.25, 0.0, 1.2) * (0.35 + back * 0.8) * lightLvl * lightLvl;
  vec3 under = behind * absorb + body * (1.0 - absorb);
  // Under a squall the water goes grey-dark, in the cloud's shadow.
  under *= 1.0 - 0.45 * sq;

  vec3 col = mix(under, refl, fresnel);

  vec3 Hh = normalize(V + uSunDir);
  float NdH = max(dot(N, Hh), 0.0);
  col += uSunColor * (pow(NdH, 1600.0) * 26.0 + pow(NdH, 200.0) * 0.3) * smoothstep(0.0, 0.1, uSunDir.y);

  // Foam where things break the surface (the beach, the hull, rocks), and on the tallest crests.
  float fn = dA.a * 0.6 + texture2D(tDetail, vWorld.xz * 0.9 + uTime * 0.03).a * 0.4;
  float edge = 1.0 - smoothstep(0.0, 0.03 + fn * 0.06, thick);
  edge *= smoothstep(0.3, 0.6, fn + 0.2) * 0.85 * (1.0 - smoothstep(25.0, 60.0, dist));
  float crest = smoothstep(0.2, 0.34, vH + (fn - 0.5) * 0.12) * smoothstep(0.58, 0.82, fn);
  // Whitecaps: breaking crests scattered over the sea once the wind passes about 15 knots,
  // more the stronger it blows. They ride the tops of the open swell and drift downwind.
  float cover = clamp((windHere - 8.0) / 14.0, 0.0, 0.32);
  float whitecap = 0.0;
  if (cover > 0.0) {
    vec2 wuv = vWorld.xz * 0.045 + vec2(uTime * 0.035, uTime * 0.004);
    float wn = texture2D(tDetail, wuv).a * 0.65 + texture2D(tDetail, wuv * 2.7 + 0.3).a * 0.35;
    whitecap = smoothstep(1.0 - cover, 1.06 - cover * 0.6, wn) * (0.45 + 0.55 * smoothstep(-0.2, 0.55, vHo + vH * 2.0));
    whitecap *= 1.0 - smoothstep(120.0, 600.0, dist) * 0.6;
  }
  float foam = clamp(edge + crest * 0.45 + whitecap * 0.75, 0.0, 1.0);
  vec3 foamCol = vec3(0.95, 0.98, 1.0) * (0.55 + 0.45 * sunUp) * lightLvl + uSunColor * 0.08;
  // At night anything that disturbs the water lights it up.
  foamCol = mix(foamCol, vec3(0.2, 1.5, 1.7), uGlow);
  foam *= mix(1.0, 1.0 - smoothstep(20.0, 70.0, dist), uGlow);
  col = mix(col, foamCol, foam * 0.92);

  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, fog);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** A grid that is dense under the viewer and stretches toward the horizon. */
function oceanGrid(n: number, inner: number, outer: number): { geo: THREE.BufferGeometry; step: number } {
  const geo = new THREE.PlaneGeometry(2, 2, n, n);
  geo.rotateX(-Math.PI / 2);
  geo.deleteAttribute('uv');
  geo.deleteAttribute('normal');
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const span = (u: number) => Math.sign(u) * (inner * Math.abs(u) + (outer - inner) * Math.abs(u) ** 3);
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, span(pos.getX(i)));
    pos.setZ(i, span(pos.getZ(i)));
  }
  geo.computeBoundingSphere();
  return { geo, step: (inner * 2) / n };
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private step: number;
  /** Storms raise the swell (later versions). */
  swell = 1;
  /** The open sea's long swell (1 = as designed). */
  openSwell = 1;

  constructor(
    private floor: SeaFloorMap,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    fogColor: THREE.Color,
    gridN = 220,
  ) {
    const { geo, step } = oceanGrid(gridN, 40, 1400);
    this.step = step;
    this.uniforms = {
      uTime: { value: 0 },
      uSwell: { value: 1 },
      uOpenSwell: { value: 1 },
      uWind: { value: 6.5 },
      uSquallOn: { value: 0 },
      uSquall: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uGlow: { value: 0 },
      uDay: { value: 1 },
      uNear: { value: 0.05 },
      uFar: { value: 2500 },
      uScreen: { value: new THREE.Vector2(1, 1) },
      uRefract: { value: 0.03 },
      uSunDir: { value: sunDir },
      uSunColor: { value: sunColor },
      // Caribbean water: red light is soaked up fast, blue-green travels far,
      // so white sand under clear water reads turquoise and depth reads blue.
      uDeep: { value: new THREE.Color(0x0b5f86) },
      uShallow: { value: new THREE.Color(0x1aa39a) },
      uAbsorb: { value: new THREE.Vector3(0.42, 0.085, 0.07) },
      uFogColor: { value: fogColor },
      uFogDensity: { value: 0.003 },
      tDetail: { value: waterDetailTexture() },
      tScene: { value: null },
      tDepth: { value: null },
      tSky: { value: null },
      tFloor: { value: floor.tex },
      uFloorRect: { value: floor.rect },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /** Height of the water surface at x, z and time t, as drawn (metres above sea level). */
  heightAt(x: number, z: number, t: number): number {
    return rawWaves(x, z, t) * swellAt(this.floor.floorAt(x, z)) * this.swell + openWaves(x, z, t) * openness(x, z) * this.openSwell;
  }

  setSources(sceneTex: THREE.Texture, depth: THREE.DepthTexture, sky: THREE.CubeTexture): void {
    this.uniforms.tScene.value = sceneTex;
    this.uniforms.tDepth.value = depth;
    this.uniforms.tSky.value = sky;
  }

  setCamera(cam: THREE.PerspectiveCamera): void {
    this.uniforms.uNear.value = cam.near;
    this.uniforms.uFar.value = cam.far;
  }

  setScreen(w: number, h: number): void {
    (this.uniforms.uScreen.value as THREE.Vector2).set(w, h);
  }

  setRefract(amount: number): void {
    this.uniforms.uRefract.value = 0.03 * amount;
  }

  setLight(day: number, glow: number, fogDensity: number): void {
    this.uniforms.uDay.value = day;
    this.uniforms.uGlow.value = glow;
    this.uniforms.uFogDensity.value = fogDensity;
  }

  /** The weather on the water: the trade wind's strength (m/s, before the open sea adds to it) and the squalls (x, z, radius, strength). */
  setWeather(tradeWind: number, squalls: readonly { x: number; z: number; radius: number; strength: number }[]): void {
    this.uniforms.uWind.value = tradeWind;
    const u = this.uniforms.uSquall.value as THREE.Vector4[];
    let on = 0;
    for (let i = 0; i < 4; i++) {
      const s = squalls[i];
      if (s) u[i].set(s.x, s.z, s.radius, s.strength);
      else u[i].set(0, 0, 1, 0);
      if (s && s.strength > 0.001) on = 1;
    }
    this.uniforms.uSquallOn.value = on;
  }

  update(t: number, focus: THREE.Vector3): void {
    this.uniforms.uTime.value = t;
    this.uniforms.uSwell.value = this.swell;
    this.uniforms.uOpenSwell.value = this.openSwell;
    // Follow the viewer in whole grid steps so the surface doesn't swim.
    this.mesh.position.set(Math.round(focus.x / this.step) * this.step, 0, Math.round(focus.z / this.step) * this.step);
  }
}
