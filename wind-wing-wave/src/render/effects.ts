/**
 * Small effects that make shaping feel physical (ARCHITECTURE 6, look-and-sound 2.2 and 3):
 *   - steam where lava meets the sea: soft puffs that rise, drift downwind, grow and fade
 *     over about 4 s, warm-lit from below by the lava (from the engine's steam reports, and
 *     where the lava pour itself hits the water);
 *   - the lava pour: a glowing, slightly lumpy ribbon falling from the hands, with sparks
 *     spattering where it lands;
 *   - sand: a stream of grains (and a faint sandy ribbon) in the colour of the local sand;
 *   - rock: boulders tumble from opening hands, bounce once, settle and sink into the new
 *     ground, with a small dust puff (or a splash in the sea);
 *   - scoop: little puffs of dust, or splashes under water;
 *   - smoothing hands: a soft shimmer of glints over the brush.
 *
 * Everything is pooled in typed arrays and drawn as instances (one draw call per kind that
 * is on screen, none when idle), with fog like the land and nothing allocated per frame.
 * Puffs never grow past a share of the screen and fade when the camera is close, so a
 * steaming shore can't fill the view. Motions near the brush are scaled with the zoom, so
 * a pour takes the same calm second whether you are close up or high above.
 */
import * as THREE from 'three';
import { SEA_LEVEL } from '../config';
import type { FromEngine } from '../engine/protocol';
import { PourTracker, createHandsState, readHands } from './hands';
import { GLSL_NOISE, glslColor, steamLevel } from './ocean';
import { WORLD_UNIFORMS_GLSL, type FrameCtx, type PageSystem, type SystemDeps } from './shared';

// ---------- particle pools ----------

/** Per-particle layout (floats). */
const PX = 0; // position x, y, z
const VX = 3; // velocity x, y, z
const AGE = 6;
const LIFE = 7;
const SIZE0 = 8;
const SIZE1 = 9;
const ALPHA = 10;
const SEED = 11;
const RGB = 12; // r, g, b
const EXTRA = 15; // warmth (steam), passed to the shader
const GRAV = 16; // downward acceleration (m/s^2)
const RELAX = 17; // how fast velocity relaxes toward (wind drift, rise) (1/s)
const RISE = 18; // upward speed it relaxes toward (m/s)
const DRIFT = 19; // share of the wind it drifts with
const FLOOR = 20; // dies (lands) below this height
const FADEIN = 21; // share of life spent fading in
const FADEOUT = 22; // share of life after which it fades out
const STRIDE = 23;
/** The per-particle layout offsets the checks need. */
export const PARTICLE_LAYOUT = { STRIDE, GRAV, FLOOR } as const;

/** What a pool calls when a particle lands (below its floor); gets the particle's offset into `pool.s`. */
type LandFn = (pool: Particles, i: number) => void;

/**
 * A pool of short-lived billboards. Alive particles are packed at the front (dead ones are
 * swapped with the last), so drawing them is one instanced call over the first n.
 */
export class Particles {
  readonly s: Float32Array;
  n = 0;
  readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly aMisc: THREE.InstancedBufferAttribute;
  private readonly attrs: readonly THREE.InstancedBufferAttribute[];

  constructor(
    readonly cap: number,
    private readonly onLand: LandFn | null = null,
  ) {
    this.s = new Float32Array(cap * STRIDE);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute(name, a);
      return a;
    };
    this.aPos = attr('iPos');
    this.aCol = attr('iCol');
    this.aMisc = attr('iMisc');
    this.attrs = [this.aPos, this.aCol, this.aMisc];
    this.geometry.instanceCount = 0;
  }

  /** Start a particle; returns its offset into `s`, or -1 when the pool is full. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number): number {
    if (this.n >= this.cap) return -1;
    const o = this.n++ * STRIDE;
    const s = this.s;
    s.fill(0, o, o + STRIDE);
    s[o + PX] = x;
    s[o + PX + 1] = y;
    s[o + PX + 2] = z;
    s[o + VX] = vx;
    s[o + VX + 1] = vy;
    s[o + VX + 2] = vz;
    s[o + LIFE] = life;
    s[o + ALPHA] = 1;
    s[o + SEED] = Math.random();
    s[o + FLOOR] = -Infinity;
    s[o + FADEOUT] = 1;
    return o;
  }

  private kill(i: number): void {
    const last = --this.n;
    if (i !== last) this.s.copyWithin(i * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
  }

  /** Move everything on by dt with the wind (m/s, x and z), and drop what has died or landed. */
  step(dt: number, windX: number, windZ: number): void {
    const s = this.s;
    for (let i = 0; i < this.n; i++) {
      const o = i * STRIDE;
      s[o + AGE] += dt;
      if (s[o + AGE] >= s[o + LIFE]) {
        this.kill(i--);
        continue;
      }
      const k = Math.min(1, s[o + RELAX] * dt);
      const drift = s[o + DRIFT];
      s[o + VX] += (windX * drift - s[o + VX]) * k;
      s[o + VX + 1] += (s[o + RISE] - s[o + VX + 1]) * k - s[o + GRAV] * dt;
      s[o + VX + 2] += (windZ * drift - s[o + VX + 2]) * k;
      s[o + PX] += s[o + VX] * dt;
      s[o + PX + 1] += s[o + VX + 1] * dt;
      s[o + PX + 2] += s[o + VX + 2] * dt;
      if (s[o + PX + 1] < s[o + FLOOR]) {
        this.onLand?.(this, o);
        this.kill(i--);
      }
    }
  }

  /** Write the alive particles into the instance attributes. */
  upload(): void {
    const s = this.s;
    const p = this.aPos.array as Float32Array;
    const c = this.aCol.array as Float32Array;
    const m = this.aMisc.array as Float32Array;
    for (let i = 0; i < this.n; i++) {
      const o = i * STRIDE;
      const a = s[o + AGE] / s[o + LIFE];
      const grow = 1 - (1 - a) * (1 - a);
      const fin = s[o + FADEIN] > 0 ? Math.min(1, a / s[o + FADEIN]) : 1;
      const fout = a > s[o + FADEOUT] ? 1 - (a - s[o + FADEOUT]) / (1 - s[o + FADEOUT]) : 1;
      const j = i * 4;
      p[j] = s[o + PX];
      p[j + 1] = s[o + PX + 1];
      p[j + 2] = s[o + PX + 2];
      p[j + 3] = s[o + SIZE0] + (s[o + SIZE1] - s[o + SIZE0]) * grow;
      c[j] = s[o + RGB];
      c[j + 1] = s[o + RGB + 1];
      c[j + 2] = s[o + RGB + 2];
      c[j + 3] = s[o + ALPHA] * fin * fout;
      m[j] = s[o + SEED];
      m[j + 1] = a;
      m[j + 2] = s[o + EXTRA];
    }
    for (let i = 0; i < this.attrs.length; i++) markRange(this.attrs[i], this.n);
    this.geometry.instanceCount = this.n;
  }
}

/** Upload only the first n instances of an attribute. */
function markRange(attr: THREE.InstancedBufferAttribute, n: number): void {
  if (n === 0) return; // nothing is drawn, so nothing to send
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, n * attr.itemSize);
  attr.needsUpdate = true;
}

// ---------- shaders ----------

/** Fog amount like three's own fog chunk, for shaders that apply it their own way. */
const FOG_AMOUNT_GLSL = /* glsl */ `
float ww_fogAmount() {
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      return 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      return smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #else
    return 0.0;
  #endif
}
`;

/** Camera-facing quads, clamped to a share of the screen and faded close to the camera. */
const BILLBOARD_VERTEX = /* glsl */ `
attribute vec4 iPos;
attribute vec4 iCol;
attribute vec4 iMisc;
uniform float uPxScale;
uniform float uMaxPx;
uniform float uNearFade;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = viewMatrix * vec4(iPos.xyz, 1.0);
  float dist = max(-mvPosition.z, 0.001);
  float size = min(iPos.w, uMaxPx * dist / uPxScale);
  float a = iMisc.x * 6.2832 + iMisc.y * (iMisc.x - 0.5) * 2.0;
  float ca = cos(a);
  float sa = sin(a);
  mvPosition.xy += vec2(position.x * ca - position.y * sa, position.x * sa + position.y * ca) * size;
  vUv = position.xy;
  vCol = iCol;
  vCol.a *= smoothstep(iPos.w * uNearFade, iPos.w * uNearFade * 3.0 + 1.0, dist);
  vMisc = iMisc;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Steam, dust and splash puffs: soft, noisy, lit from the sun's side, warm underneath near lava. */
const SOFT_FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform vec3 uSunView;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
#include <common>
#include <fog_pars_fragment>
${GLSL_NOISE}
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float n = ww_vnoise(vUv * 2.2 + vMisc.x * 37.0 + vec2(0.0, vMisc.y * 1.6)) * 0.65
          + ww_vnoise(vUv * 4.9 - vMisc.x * 19.0) * 0.35;
  float body = 1.0 - r2;
  // Wispy edges: the noise eats into the rim more than the middle.
  float a = smoothstep(0.05, 0.6, body * (0.2 + 1.3 * n));
  vec3 nv = vec3(vUv, sqrt(body));
  vec3 illum = mix(vec3(1.0), vec3(0.42, 0.48, 0.62), uNight) * (1.0 - 0.25 * uStorm);
  vec3 col = vCol.rgb * illum * (0.72 + 0.32 * dot(nv, uSunView));
  // Lava light from below: a soft warmth by day, a glow at night.
  col = mix(col, ${glslColor(0xffa060)}, vMisc.z * (1.0 - smoothstep(-0.9, 0.3, vUv.y)) * (0.35 + 0.5 * uNight));
  gl_FragColor = vec4(col, a * vCol.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Sparks and glints: additive glowing dots that fade into the fog (rather than turning fog-coloured). */
const GLOW_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
#include <common>
#include <fog_pars_fragment>
${FOG_AMOUNT_GLSL}
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float a = (1.0 - r2) * (1.0 - r2);
  vec3 col = vCol.rgb + vec3(1.0, 0.95, 0.8) * (1.0 - smoothstep(0.0, 0.2, r2)) * 0.7;
  gl_FragColor = vec4(col, a * vCol.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a *= 1.0 - ww_fogAmount();
}
`;

/** Grains, chips and droplets: tiny solid balls lit by the sun. */
const GRAIN_FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform vec3 uSunView;
varying vec2 vUv;
varying vec4 vCol;
varying vec4 vMisc;
#include <common>
#include <fog_pars_fragment>
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  vec3 nv = vec3(vUv, sqrt(1.0 - r2));
  vec3 illum = mix(vec3(1.0), vec3(0.35, 0.4, 0.55), uNight);
  gl_FragColor = vec4(vCol.rgb * illum * (0.55 + 0.55 * max(dot(nv, uSunView), 0.0)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** The pour ribbon: a tube along the same falling curve the grains follow. */
const RIBBON_VERTEX = /* glsl */ `
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform vec3 uSide;
uniform vec2 uRad;
uniform vec2 uSpan;
uniform float uTime;
uniform float uLava;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec2 vTube;
#include <common>
#include <fog_pars_vertex>
void main() {
  float s = mix(uSpan.x, uSpan.y, position.x);
  float is = 1.0 - s;
  vec3 P = is * is * uP0 + 2.0 * s * is * uP1 + s * s * uP2;
  vec3 T = normalize(2.0 * is * (uP1 - uP0) + 2.0 * s * (uP2 - uP1) + vec3(0.0, -1e-4, 0.0));
  vec3 S = normalize(uSide - T * dot(uSide, T));
  vec3 B = cross(T, S);
  vec3 N = S * cos(position.y) + B * sin(position.y);
  // Viscous lava sags into lumps that slide down the stream.
  float lump = 1.0 + uLava * 0.18 * sin(s * 17.0 - uTime * 8.3776);
  vec3 w = P + N * mix(uRad.x, uRad.y, s) * lump;
  vNormalW = N;
  vWorld = w;
  vTube = vec2(s, position.y);
  vec4 mvPosition = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const RIBBON_FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform float uLava;
uniform vec3 uSandColor;
varying vec3 vNormalW;
varying vec3 vWorld;
varying vec2 vTube;
#include <common>
#include <fog_pars_fragment>
${FOG_AMOUNT_GLSL}
${GLSL_NOISE}
void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(uCamPos - vWorld);
  float facing = abs(dot(N, V));
  vec4 outCol;
  if (uLava > 0.5) {
    // Hot core facing you, cooler red edges, bright streaks flowing down.
    float flow = 0.5 + 0.5 * sin(vTube.x * 26.0 - uTime * 10.472 + vTube.y * 2.0);
    float heat = 0.4 + 0.45 * facing + 0.18 * flow;
    vec3 c = mix(${glslColor(0xc21f0e)}, ${glslColor(0xff5a1a)}, smoothstep(0.3, 0.55, heat));
    c = mix(c, ${glslColor(0xffb02e)}, smoothstep(0.55, 0.8, heat));
    c = mix(c, ${glslColor(0xfff3c4)}, smoothstep(0.82, 1.0, heat));
    outCol = vec4(c * 1.4, 1.0);
  } else {
    // A loose, grainy curtain of sand, lit by the sun.
    float grain = ww_hash12(floor(vec2(vTube.x * 70.0 - uTime * 24.0, vTube.y * 2.5)));
    vec3 illum = mix(vec3(1.0), vec3(0.35, 0.4, 0.55), uNight);
    vec3 c = uSandColor * illum * (0.65 + 0.4 * max(dot(N, uSunDir), 0.0));
    outCol = vec4(c, (0.25 + 0.45 * step(0.45, grain)) * (0.4 + 0.6 * facing));
  }
  gl_FragColor = outCol;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef USE_FOG
    // As three's fog, but lava glows through half of it.
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, ww_fogAmount() * (1.0 - 0.5 * uLava));
  #endif
}
`;

// ---------- geometry ----------

const RIBBON_SIDES = 6;
const RIBBON_SEGS = 12;

function makeRibbonGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let j = 0; j <= RIBBON_SEGS; j++) {
    for (let k = 0; k < RIBBON_SIDES; k++) pos.push(j / RIBBON_SEGS, (k / RIBBON_SIDES) * Math.PI * 2, 0);
  }
  const idx: number[] = [];
  for (let j = 0; j < RIBBON_SEGS; j++) {
    for (let k = 0; k < RIBBON_SIDES; k++) {
      const a = j * RIBBON_SIDES + k;
      const b = j * RIBBON_SIDES + ((k + 1) % RIBBON_SIDES);
      idx.push(a, a + RIBBON_SIDES, b, b, a + RIBBON_SIDES, b + RIBBON_SIDES);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

/** A lumpy boulder: an icosahedron (80 triangles) pushed in and out, in stone greys. */
function makeBoulderGeometry(): THREE.InstancedBufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1).toNonIndexed();
  const pos = ico.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const light = new THREE.Color(0xb3ada3);
  const dark = new THREE.Color(0x77726b);
  const c = new THREE.Color();
  const bump = (x: number, y: number, z: number) => 1 + 0.16 * Math.sin(x * 3.1 + y * 1.7) * Math.cos(z * 2.3 - x) + 0.08 * Math.sin(y * 5.3 + z * 4.1);
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const r = bump(x, y, z);
    pos.setXYZ(v, x * r, y * r * 0.78, z * r);
    c.copy(dark).lerp(light, 0.5 + 0.5 * Math.sin(x * 4.0 + z * 3.0 + y * 2.0));
    c.toArray(col, v * 3);
  }
  ico.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ico.computeVertexNormals();
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', ico.getAttribute('position'));
  g.setAttribute('normal', ico.getAttribute('normal'));
  g.setAttribute('color', ico.getAttribute('color'));
  ico.dispose();
  return g;
}

// ---------- boulders ----------

const B_STRIDE = 14; // x y z, vx vy vz, axis xyz, angle, spin, size, state, gravity
const MAX_BOULDERS = 48;

// ---------- tuning ----------

/** Time (s) for material to fall from the hands to the ground, at any zoom. */
const FALL_T = 0.7;
/** Steam puffs spawned per second by one fully-hot contact. */
const STEAM_RATE = 14;
/** Wind drift speed (m/s) at full wind strength. */
const WIND_SPEED = 5;
/** Spawn streams (each keeps its own fractional debt). */
const STREAM_SPARKS = 0;
const STREAM_STEAM = 1;
const STREAM_GRAINS = 2;
const STREAM_BOULDERS = 3;
const STREAM_GLINTS = 4;
const STREAM_SCOOP = 5;

// ---------- the system ----------

export function createEffects(deps: SystemDeps): PageSystem {
  const { scene, fields, u, renderer, quality } = deps;
  const steamCap = quality.phone ? 100 : 220;

  const pxScale = { value: 800 };
  const maxPx = { value: 300 };
  const sunView = { value: new THREE.Vector3(0, 1, 0) };

  // Pools. Grains that land sometimes kick up a little puff of their own colour (or a splash on the sea).
  const soft = new Particles(steamCap + 40);
  const glow = new Particles(quality.phone ? 120 : 200);
  const grains = new Particles(quality.phone ? 220 : 360, (pool, o) => {
    if (Math.random() >= 0.04) return;
    const x = pool.s[o + PX];
    const z = pool.s[o + PX + 2];
    const size = pool.s[o + SIZE0] * 5;
    if (fields.heightAt(x, z) < SEA_LEVEL - 0.05) puff(x, SEA_LEVEL, z, size, 0.9, 0.96, 1.0, 0, 0.8);
    else puff(x, pool.s[o + FLOOR], z, size, pool.s[o + RGB], pool.s[o + RGB + 1], pool.s[o + RGB + 2], 0, 0.8);
  });

  const billboard = (fragmentShader: string, extra: Partial<THREE.ShaderMaterialParameters>, nearFade: number) =>
    new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        ...u,
        uPxScale: pxScale,
        uMaxPx: maxPx,
        uNearFade: { value: nearFade },
        uSunView: sunView,
      },
      vertexShader: BILLBOARD_VERTEX,
      fragmentShader,
      fog: true,
      ...extra,
    });
  const meshFor = (pool: Particles, material: THREE.Material, order: number) => {
    const m = new THREE.Mesh(pool.geometry, material);
    m.frustumCulled = false;
    m.renderOrder = order;
    m.visible = false;
    scene.add(m);
    return m;
  };
  const softMesh = meshFor(soft, billboard(SOFT_FRAGMENT, { transparent: true, depthWrite: false, name: 'fx-soft' }, 1.2), 3);
  const glowMesh = meshFor(glow, billboard(GLOW_FRAGMENT, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, name: 'fx-glow' }, 0), 4);
  const grainMesh = meshFor(grains, billboard(GRAIN_FRAGMENT, { name: 'fx-grains' }, 0), 0);

  // The pour ribbon.
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const side = new THREE.Vector3(1, 0, 0);
  const rad = new THREE.Vector2();
  const span = new THREE.Vector2(0, 0);
  const lava = { value: 1 };
  const sandColor = new THREE.Color(0xe9d6a8);
  const ribbonMat = new THREE.ShaderMaterial({
    name: 'fx-ribbon',
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      ...u,
      uP0: { value: p0 },
      uP1: { value: p1 },
      uP2: { value: p2 },
      uSide: { value: side },
      uRad: { value: rad },
      uSpan: { value: span },
      uLava: lava,
      uSandColor: { value: sandColor },
    },
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const ribbonGeo = makeRibbonGeometry();
  const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
  ribbon.frustumCulled = false;
  ribbon.renderOrder = 4;
  ribbon.visible = false;
  scene.add(ribbon);

  // Boulders.
  const bState = new Float32Array(MAX_BOULDERS * B_STRIDE);
  let nBoulders = 0;
  const boulderGeo = makeBoulderGeometry();
  const bPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOULDERS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const bRot = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BOULDERS * 4), 4).setUsage(THREE.DynamicDrawUsage);
  boulderGeo.setAttribute('iPos', bPos);
  boulderGeo.setAttribute('iRot', bRot);
  boulderGeo.instanceCount = 0;
  const boulderMat = new THREE.MeshLambertMaterial({ vertexColors: true, name: 'fx-boulders' });
  boulderMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 iPos;
attribute vec4 iRot;
vec3 ww_rotate(vec3 v) {
  float c = cos(iRot.w);
  return v * c + cross(iRot.xyz, v) * sin(iRot.w) + iRot.xyz * dot(iRot.xyz, v) * (1.0 - c);
}`,
      )
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = ww_rotate(normal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = ww_rotate(position) * iPos.w + iPos.xyz;');
  };
  const boulderMesh = new THREE.Mesh(boulderGeo, boulderMat);
  boulderMesh.frustumCulled = false;
  boulderMesh.visible = false;
  scene.add(boulderMesh);

  // Steam contacts reported by the engine: x, z, level; they fade unless reported again.
  const MAX_CONTACTS = 32;
  const contacts = new Float32Array(MAX_CONTACTS * 4); // x, z, level, spawn accumulator
  let nContacts = 0;

  const pour = new PourTracker();
  const hs = createHandsState();
  let ribbonOn = false;
  /** Spawn debt per stream (see due()). */
  const owed = new Float32Array(6);
  const tmpColor = new THREE.Color();
  const sandA = new THREE.Color();
  const sandB = new THREE.Color();
  const drawSize = new THREE.Vector2();

  // ---- spawners ----

  /** A soft puff of steam (warmth > 0), dust or splash. */
  function puff(x: number, y: number, z: number, size: number, r: number, g: number, b: number, warmth: number, life = 1.4): void {
    const o = soft.spawn(x, y, z, 0, 0, 0, life);
    if (o < 0) return;
    const s = soft.s;
    s[o + SIZE0] = size;
    s[o + SIZE1] = size * 2.2;
    s[o + ALPHA] = 0.75;
    s[o + RGB] = r;
    s[o + RGB + 1] = g;
    s[o + RGB + 2] = b;
    s[o + EXTRA] = warmth;
    s[o + RELAX] = 2.5;
    s[o + RISE] = 0.3;
    s[o + DRIFT] = 0.4;
    s[o + FADEIN] = 0.06;
    s[o + FADEOUT] = 0.25;
  }

  /** One steam puff at a lava contact, about `base` metres across (one in six is a big plume puff). */
  function steamPuff(x: number, z: number, level: number, base: number): void {
    if (soft.n >= steamCap) return;
    const big = Math.random() < 0.17;
    const size = base * (0.7 + 0.6 * Math.random()) * (big ? 2 : 1);
    // Bursts up and out of the water, then settles into a steady 1.5 m/s rise, drifting downwind.
    const o = soft.spawn(
      x + (Math.random() - 0.5) * base * 1.5,
      SEA_LEVEL + 0.2 + size * 0.3,
      z + (Math.random() - 0.5) * base * 1.5,
      (Math.random() - 0.5) * 1.6,
      2.6 + Math.random(),
      (Math.random() - 0.5) * 1.6,
      3.4 + Math.random() * 1.2,
    );
    if (o < 0) return;
    const s = soft.s;
    s[o + SIZE0] = size;
    s[o + SIZE1] = size * 3;
    s[o + ALPHA] = 0.3 + 0.25 * level;
    s[o + RGB] = 0.93;
    s[o + RGB + 1] = 0.95;
    s[o + RGB + 2] = 0.96;
    s[o + EXTRA] = 0.25 + 0.35 * level;
    s[o + RELAX] = 0.8;
    s[o + RISE] = 1.5;
    s[o + DRIFT] = 1;
    s[o + FADEIN] = 0.08;
    s[o + FADEOUT] = 0.3;
  }

  /** A glowing dot: a lava spark (falls) or a glint (floats). */
  function spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grav: number, r: number, g: number, b: number, life: number, floor: number): void {
    const o = glow.spawn(x, y, z, vx, vy, vz, life);
    if (o < 0) return;
    const s = glow.s;
    s[o + SIZE0] = size;
    s[o + SIZE1] = size * 0.5;
    s[o + RGB] = r;
    s[o + RGB + 1] = g;
    s[o + RGB + 2] = b;
    s[o + GRAV] = grav;
    s[o + RELAX] = 0.4;
    s[o + FLOOR] = floor;
    s[o + FADEIN] = grav > 0 ? 0 : 0.3;
    s[o + FADEOUT] = 0.5;
  }

  /** A solid grain, chip or droplet. */
  function grain(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grav: number, r: number, g: number, b: number, floor: number, life: number): void {
    const o = grains.spawn(x, y, z, vx, vy, vz, life);
    if (o < 0) return;
    const s = grains.s;
    s[o + SIZE0] = size;
    s[o + SIZE1] = size;
    s[o + RGB] = r;
    s[o + RGB + 1] = g;
    s[o + RGB + 2] = b;
    s[o + GRAV] = grav;
    s[o + FLOOR] = floor;
  }

  /** Sand colour for a sand kind byte (0 black, 128 golden, 255 coral-white), into tmpColor. */
  function sandKindColor(kind: number): THREE.Color {
    const k = kind / 255;
    if (k < 0.33) return tmpColor.copy(sandA.setHex(0x3a3634)).lerp(sandB.setHex(0x8f877c), k / 0.33);
    if (k < 0.66) return tmpColor.copy(sandA.setHex(0x8f877c)).lerp(sandB.setHex(0xe9d6a8), (k - 0.33) / 0.33);
    return tmpColor.copy(sandA.setHex(0xe9d6a8)).lerp(sandB.setHex(0xf7f1e3), (k - 0.66) / 0.34);
  }

  /** The look of the ground at a point: its sand colour if sandy, else rock grey (into tmpColor). */
  function groundColor(x: number, z: number): THREE.Color {
    const c = fields.colIndex(x, z);
    if (c < 0) return tmpColor.setHex(0xe9d6a8);
    const sed = fields.ground[c * 4 + 2];
    if (sed >= 2) return sandKindColor(fields.ground[c * 4 + 3] & 0xfc);
    return tmpColor.setHex((fields.ground[c * 4 + 3] & 3) === 0 ? 0x4a4644 : 0x8a8580);
  }

  /** A boulder thrown with velocity v that falls under gravity `grav` (the pour's parabola). */
  function spawnBoulder(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grav: number): void {
    if (nBoulders >= MAX_BOULDERS) return;
    const o = nBoulders++ * B_STRIDE;
    const ax = Math.random() - 0.5;
    const ay = Math.random() - 0.5;
    const az = Math.random() - 0.5;
    const al = Math.hypot(ax, ay, az) || 1;
    const b = bState;
    b[o] = x;
    b[o + 1] = y;
    b[o + 2] = z;
    b[o + 3] = vx;
    b[o + 4] = vy;
    b[o + 5] = vz;
    b[o + 6] = ax / al;
    b[o + 7] = ay / al;
    b[o + 8] = az / al;
    b[o + 9] = Math.random() * 6.28;
    b[o + 10] = 3 + Math.random() * 5;
    b[o + 11] = size;
    b[o + 12] = 0;
    b[o + 13] = grav;
  }

  /** Boulders: fall, bounce once, settle, then sink into the ground the engine has raised. */
  function stepBoulders(dt: number): void {
    for (let i = 0; i < nBoulders; i++) {
      const o = i * B_STRIDE;
      const b = bState;
      const size = b[o + 11];
      const grav = b[o + 13];
      let state = b[o + 12];
      if (state >= 2) {
        // Settled: sink over about 1.2 s, then go.
        b[o + 12] = state += dt / 1.2;
        b[o + 1] -= size * 0.9 * (dt / 1.2);
        if (state >= 3) {
          const last = --nBoulders;
          if (i !== last) b.copyWithin(o, last * B_STRIDE, last * B_STRIDE + B_STRIDE);
          i--;
        }
        continue;
      }
      const wet = b[o + 1] < SEA_LEVEL;
      b[o + 4] -= grav * dt;
      if (wet) {
        const drag = Math.exp(-dt * 4);
        b[o + 3] *= drag;
        b[o + 4] *= drag;
        b[o + 5] *= drag;
      }
      const wasDry = b[o + 1] >= SEA_LEVEL;
      b[o] += b[o + 3] * dt;
      b[o + 1] += b[o + 4] * dt;
      b[o + 2] += b[o + 5] * dt;
      b[o + 9] += b[o + 10] * dt;
      if (wasDry && b[o + 1] < SEA_LEVEL) {
        puff(b[o], SEA_LEVEL + size * 0.3, b[o + 2], size * 1.6, 0.9, 0.96, 1.0, 0, 1.1);
        for (let d = 0; d < 3; d++) {
          grain(b[o], SEA_LEVEL, b[o + 2], (Math.random() - 0.5) * size * 4, size * (3 + Math.random() * 3), (Math.random() - 0.5) * size * 4, size * 0.12, grav * 0.6, 0.85, 0.95, 1.0, SEA_LEVEL - 0.1, 2);
        }
      }
      const ground = fields.heightAt(b[o], b[o + 2]);
      if (b[o + 1] - size * 0.5 < ground && b[o + 4] < 0) {
        b[o + 1] = ground + size * 0.5;
        if (state === 0) {
          // First touch: bounce once, losing most of the speed and spin.
          b[o + 4] = -b[o + 4] * 0.3;
          b[o + 3] *= 0.5;
          b[o + 5] *= 0.5;
          b[o + 10] *= 0.5;
          b[o + 12] = 1;
        } else {
          b[o + 12] = 2;
        }
        if (!wet) {
          const gc = groundColor(b[o], b[o + 2]);
          const lighten = 0.35;
          for (let d = 0; d < 3; d++) {
            puff(b[o] + (Math.random() - 0.5) * size, ground + size * 0.3, b[o + 2] + (Math.random() - 0.5) * size, size * 0.9, gc.r + (1 - gc.r) * lighten, gc.g + (1 - gc.g) * lighten, gc.b + (1 - gc.b) * lighten, 0, 1.3);
          }
          for (let d = 0; d < 3; d++) {
            grain(b[o], ground + size * 0.3, b[o + 2], (Math.random() - 0.5) * size * 5, size * (2 + Math.random() * 2), (Math.random() - 0.5) * size * 5, size * 0.1, grav * 0.7, 0.55, 0.53, 0.5, ground - 0.2, 1.5);
          }
        }
      }
    }
    const p = bPos.array as Float32Array;
    const r = bRot.array as Float32Array;
    for (let i = 0; i < nBoulders; i++) {
      const o = i * B_STRIDE;
      const j = i * 4;
      p[j] = bState[o];
      p[j + 1] = bState[o + 1];
      p[j + 2] = bState[o + 2];
      p[j + 3] = bState[o + 11];
      r[j] = bState[o + 6];
      r[j + 1] = bState[o + 7];
      r[j + 2] = bState[o + 8];
      r[j + 3] = bState[o + 9];
    }
    markRange(bPos, nBoulders);
    markRange(bRot, nBoulders);
    boulderGeo.instanceCount = nBoulders;
    boulderMesh.visible = nBoulders > 0;
  }

  /** How many to spawn this frame from a stream running at `rate` per second (the fraction carries over). */
  function due(stream: number, rate: number, dt: number): number {
    const acc = owed[stream] + rate * dt;
    const n = Math.floor(acc);
    owed[stream] = acc - n;
    return n;
  }

  /** The pour: ribbon, grains, boulders, sparks, glints, puffs, depending on the tool. */
  function pourEffects(f: FrameCtx): void {
    const r = hs.r;
    const dt = f.dt;
    const inWater = hs.y < SEA_LEVEL - 0.05;
    // Material lands on the ground, or on the sea surface above it.
    const lx = hs.x;
    const ly = Math.max(hs.y, SEA_LEVEL);
    const lz = hs.z;
    const ax = hs.ax;
    const ay = hs.ay;
    const az = hs.az;
    // Falling material follows a parabola from the hands that lands at the brush after FALL_T.
    const g = (2 * Math.max(0.5, ay - ly)) / (FALL_T * FALL_T);
    const hvx = (lx - ax) / FALL_T;
    const hvz = (lz - az) / FALL_T;
    // Splashes and spatter at the brush: gravity scaled with the brush, so they take the same time at any zoom.
    const zoomG = 9.81 * Math.max(1, r / 3);
    const tool = hs.tool;
    if (tool === 'lava' || tool === 'sand') {
      // The ribbon is the same parabola as a quadratic curve.
      p0.set(ax, ay, az);
      p1.set((ax + lx) / 2, ay, (az + lz) / 2);
      p2.set(lx, ly, lz);
      const hl = Math.hypot(lx - ax, lz - az);
      if (hl > 0.01 * r) side.set(-(lz - az) / hl, 0, (lx - ax) / hl);
      else side.set(Math.cos(f.cam.yaw), 0, -Math.sin(f.cam.yaw));
      lava.value = tool === 'lava' ? 1 : 0;
      if (tool === 'lava') rad.set(0.075 * r, 0.05 * r);
      else rad.set(0.06 * r, 0.08 * r);
      ribbonOn = true;
    }
    if (tool === 'lava') {
      // Spatter where the lava lands; steam where it pours into the sea.
      for (let i = due(STREAM_SPARKS, 40, dt); i > 0; i--) {
        const a = Math.random() * Math.PI * 2;
        const sp = Math.sqrt(2 * zoomG * r * (0.1 + 0.25 * Math.random()));
        spark(lx + Math.cos(a) * r * 0.1, ly + 0.1, lz + Math.sin(a) * r * 0.1, Math.cos(a) * sp * 0.45, sp, Math.sin(a) * sp * 0.45, r * (0.03 + 0.03 * Math.random()), zoomG, 1.0, 0.45 + 0.3 * Math.random(), 0.12, 0.9 + Math.random() * 0.5, ly - 0.2);
      }
      if (inWater) for (let i = due(STREAM_STEAM, 10, dt); i > 0; i--) steamPuff(lx, lz, 1, Math.max(2, r * 0.45));
    } else if (tool === 'sand') {
      // New sand takes on the local sand's colour, golden where there is none.
      const c = fields.colIndex(hs.x, hs.z);
      sandColor.copy(sandKindColor(c >= 0 && fields.ground[c * 4 + 2] >= 2 ? fields.ground[c * 4 + 3] & 0xfc : 128));
      const spread = 0.35 * r;
      for (let i = due(STREAM_GRAINS, 110, dt); i > 0; i--) {
        const jx = (Math.random() - 0.5) * 0.12 * hs.scale;
        const jz = (Math.random() - 0.5) * 0.12 * hs.scale;
        const t = 0.85 + 0.3 * Math.random();
        grain(ax + jx, ay - Math.random() * 0.05 * hs.scale, az + jz, hvx + ((Math.random() - 0.5) * spread) / FALL_T, 0, hvz + ((Math.random() - 0.5) * spread) / FALL_T, r * (0.028 + 0.02 * Math.random()), g * t, sandColor.r, sandColor.g, sandColor.b, ly, FALL_T * 2);
      }
    } else if (tool === 'rock') {
      // Boulders drop from across the opened hands and scatter over the brush.
      for (let i = due(STREAM_BOULDERS, 5, dt); i > 0; i--) {
        const lat = (Math.random() - 0.5) * 0.4 * hs.scale;
        const sx = ax + Math.cos(f.cam.yaw) * lat;
        const sz = az - Math.sin(f.cam.yaw) * lat;
        const tx = lx + (Math.random() - 0.5) * r * 0.9;
        const tz = lz + (Math.random() - 0.5) * r * 0.9;
        spawnBoulder(sx, ay, sz, (tx - sx) / FALL_T, 0, (tz - sz) / FALL_T, r * (0.09 + 0.09 * Math.random()), g);
      }
    } else if (tool === 'hands') {
      // A soft shimmer across the brush, as the palms smooth it.
      for (let i = due(STREAM_GLINTS, 32, dt); i > 0; i--) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * r;
        const x = hs.x + Math.cos(a) * d;
        const z = hs.z + Math.sin(a) * d;
        const y = Math.max(fields.heightAt(x, z), SEA_LEVEL) + 0.05 * r;
        spark(x, y, z, 0, 0.06 * r, 0, r * (0.025 + 0.02 * Math.random()), 0, 1.0, 0.93, 0.75, 0.8, -Infinity);
      }
    } else if (tool === 'scoop') {
      // A puff of dust (or a splash) and a few flung bits, a few times a second.
      for (let i = due(STREAM_SCOOP, 3.5, dt); i > 0; i--) {
        const gc = inWater ? tmpColor.setRGB(0.88, 0.95, 1.0) : groundColor(lx, lz);
        puff(lx + (Math.random() - 0.5) * r * 0.5, ly + r * 0.08, lz + (Math.random() - 0.5) * r * 0.5, r * 0.25, gc.r, gc.g, gc.b, 0, 1.2);
        for (let k = 0; k < 4; k++) {
          const a = Math.random() * Math.PI * 2;
          const sp = Math.sqrt(2 * zoomG * r * 0.15);
          grain(lx, ly + 0.1, lz, Math.cos(a) * sp * 0.5, sp, Math.sin(a) * sp * 0.5, r * 0.02, zoomG, gc.r * 0.85, gc.g * 0.85, gc.b * 0.85, ly - 0.3, 1.5);
        }
      }
    }
  }

  return {
    name: 'effects',
    onEngine(m: FromEngine) {
      if (m.t !== 'tick') return;
      pour.onEngine(m);
      const st = m.events.steam;
      for (let i = 0; i + 2 < st.length; i += 3) {
        const x = st[i];
        const z = st[i + 1];
        const level = steamLevel(st[i + 2]);
        let k = -1;
        for (let c = 0; c < nContacts; c++) {
          if (Math.abs(contacts[c * 4] - x) < 8 && Math.abs(contacts[c * 4 + 1] - z) < 8) {
            k = c;
            break;
          }
        }
        if (k < 0 && nContacts < MAX_CONTACTS) {
          k = nContacts++;
          contacts[k * 4] = x;
          contacts[k * 4 + 1] = z;
          contacts[k * 4 + 2] = 0;
          contacts[k * 4 + 3] = 0;
        }
        if (k >= 0) contacts[k * 4 + 2] = Math.max(contacts[k * 4 + 2], level);
      }
    },
    update(f: FrameCtx) {
      const dt = f.dt;
      pour.advance(dt);
      readHands(f, pour, hs);
      const windX = u.uWind.value.x * WIND_SPEED;
      const windZ = u.uWind.value.y * WIND_SPEED;

      // Steam from the engine's lava-meets-sea contacts.
      for (let c = 0; c < nContacts; c++) {
        const o = c * 4;
        const level = contacts[o + 2];
        contacts[o + 3] += dt * STEAM_RATE * level;
        while (contacts[o + 3] >= 1) {
          contacts[o + 3] -= 1;
          steamPuff(contacts[o], contacts[o + 1], level, 2 + 3 * level);
        }
        contacts[o + 2] = level * Math.exp(-dt / 0.5);
        if (contacts[o + 2] < 0.02) {
          // Forget it: move the last contact into its place.
          nContacts--;
          contacts.copyWithin(o, nContacts * 4, nContacts * 4 + 4);
          c--;
        }
      }

      // The pour.
      ribbonOn = false;
      if (hs.shown && hs.pouring) pourEffects(f);
      // The ribbon grows down from the hands when a pour starts, and its tail falls away when it stops.
      const grow = dt / FALL_T;
      if (ribbonOn) {
        span.x = 0;
        span.y = Math.min(1, span.y + grow);
      } else if (span.y > 0) {
        span.x = Math.min(1, span.x + grow);
        if (span.x >= 1) span.set(0, 0);
      }
      ribbon.visible = span.y > span.x;

      // Physics and upload.
      soft.step(dt, windX, windZ);
      glow.step(dt, windX, windZ);
      grains.step(dt, windX, windZ);
      stepBoulders(dt);
      soft.upload();
      glow.upload();
      grains.upload();
      softMesh.visible = soft.n > 0;
      glowMesh.visible = glow.n > 0;
      grainMesh.visible = grains.n > 0;

      // Screen-size clamp and the sun as seen from the camera.
      renderer.getDrawingBufferSize(drawSize);
      pxScale.value = drawSize.y / (2 * Math.tan((f.camera.fov * Math.PI) / 360));
      maxPx.value = drawSize.y * 0.28;
      sunView.value.copy(u.uSunDir.value).transformDirection(f.camera.matrixWorldInverse);
    },
    dispose() {
      for (const m of [softMesh, glowMesh, grainMesh, ribbon, boulderMesh]) {
        scene.remove(m);
        (m.material as THREE.Material).dispose();
      }
      soft.geometry.dispose();
      glow.geometry.dispose();
      grains.geometry.dispose();
      ribbonGeo.dispose();
      boulderGeo.dispose();
    },
  };
}
