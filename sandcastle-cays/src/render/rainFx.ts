/**
 * Rain around the camera: a few thousand falling streaks within 25 m, slanted
 * by the wind, in one draw call. The streaks belong to the world (they don't
 * follow the camera about): each one falls through a box that wraps around the
 * camera, all worked out in the vertex shader from the time. Each streak is a
 * thin quad, at least about a pixel wide (thinner ones are drawn fainter, so
 * they don't flicker), stretched along its motion relative to the camera, so
 * rain sweeps past when the boat moves.
 */
import * as THREE from 'three';
import type { FxUniforms } from './weatherCommon';
import { GLSL_STREAK, rng } from './weatherCommon';

export const RAIN_FX = {
  streaks: 3000,
  phoneStreaks: 1700,
  /** The near box (most streaks) and the far box, metres (x, y, z). */
  near: [22, 16, 22] as const,
  far: [50, 24, 50] as const,
  /** Share of streaks in the far box. */
  farShare: 0.38,
  /** How fast rain falls (m/s), and how much of the wind it moves with. */
  fall: 8.5,
  drift: 0.85,
};

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uBoxA, uBoxB, uVel, uCamVel;
uniform float uTimeW, uExposure, uPixel, uWidth, uAspect, uFarShare;
varying float vAlpha;
varying vec2 vC;
${GLSL_STREAK}

void main() {
  bool far = aSeed.w < uFarShare;
  vec3 box = far ? uBoxB : uBoxA;
  vec3 vel = uVel * (0.88 + 0.24 * fract(aSeed.w * 13.7));
  // World-fixed rain, wrapped into a box around the camera (more of it above eye level).
  vec3 lift = vec3(0.0, box.y * 0.18, 0.0);
  vec3 rel = mod(aSeed.xyz * box + vel * uTimeW - cameraPosition - lift + box * 0.5, box) - box * 0.5 + lift;
  vec3 head = cameraPosition + rel;
  vec3 tail = head - (vel - uCamVel) * uExposure;
  // Fade out toward the edges of the box (so nothing pops) and right at the eye.
  vec3 e = abs(rel - lift) / box;
  float fadeBox = 1.0 - smoothstep(0.34, 0.5, max(max(e.x, e.z), e.y));
  float fadeEye = smoothstep(0.35, 1.3, length(rel));
  // Nothing under the sea (in case the camera is below the surface).
  fadeBox *= step(-0.3, head.y);
  float cover;
  gl_Position = streakCorner(tail, head, uWidth, position.xy, cover);
  vAlpha = fadeBox * fadeEye * cover;
  vC = position.xy;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying float vAlpha;
varying vec2 vC;
void main() {
  float a = vAlpha * uAlpha * (1.0 - vC.y * vC.y) * smoothstep(0.0, 0.45, vC.x);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class RainFx {
  readonly mesh: THREE.Mesh;
  readonly count: number;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private u: Record<string, THREE.IUniform>;
  private amount = 0;

  constructor(shared: FxUniforms, phone: boolean) {
    const n = phone ? RAIN_FX.phoneStreaks : RAIN_FX.streaks;
    this.count = n;
    const r = rng(77);
    const pos = new Float32Array(n * 4 * 3);
    const seed = new Float32Array(n * 4 * 4);
    const idx = new Uint16Array(n * 6);
    const corners = [0, -1, 0, 1, 1, 1, 1, -1];
    for (let i = 0; i < n; i++) {
      const s = [r(), r(), r(), r()];
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        pos[v * 3] = corners[c * 2];
        pos[v * 3 + 1] = corners[c * 2 + 1];
        seed.set(s, v * 4);
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.u = {
      uBoxA: { value: new THREE.Vector3(...RAIN_FX.near) },
      uBoxB: { value: new THREE.Vector3(...RAIN_FX.far) },
      uFarShare: { value: RAIN_FX.farShare },
      uVel: { value: new THREE.Vector3(0, -RAIN_FX.fall, 0) },
      uTimeW: { value: 0 },
      uExposure: { value: 0.032 },
      uWidth: { value: 0.006 },
      uColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
      uAlpha: { value: 0.3 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...shared, ...this.u },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'rain';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  /** Rain falling here, 0..1. */
  set(amount: number): void {
    this.amount = Math.min(1, Math.max(0, amount));
    const n = Math.round(this.count * Math.pow(this.amount, 1.25));
    this.geo.setDrawRange(0, n * 6);
    this.mesh.visible = n > 0;
  }

  get streaks(): number {
    return this.mesh.visible ? this.geo.drawRange.count / 6 : 0;
  }

  update(time: number, windX: number, windZ: number, shared: FxUniforms): void {
    if (!this.mesh.visible) return;
    const u = this.u;
    // Wrap the clock so the sums stay precise on long voyages.
    u.uTimeW.value = time % 600;
    (u.uVel.value as THREE.Vector3).set(windX * RAIN_FX.drift, -RAIN_FX.fall, windZ * RAIN_FX.drift);
    // Streaks catch the grey daylight: pale by day, barely there at night.
    const day = shared.uDay.value;
    (u.uColor.value as THREE.Color).copy(shared.uHorizon.value).lerp(WHITE, 0.35).multiplyScalar(0.3 + 0.7 * day);
    u.uAlpha.value = (0.16 + 0.2 * Math.sqrt(this.amount)) * (0.55 + 0.45 * day);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const WHITE = new THREE.Color(1, 1, 1);
