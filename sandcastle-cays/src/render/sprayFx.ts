/**
 * Spray over the bow: when the boat drives into a wave, a burst of white water
 * leaps up off the bow, then gravity and the wind carry it back across the
 * deck. Droplets are drawn as short motion streaks (fast water reads as
 * streaks, not beads), with puffs of white mist among them; droplets now and
 * then flash as they catch the sun. A pool of a few hundred in one draw call:
 * each one's flight is worked out in the vertex shader from when and how it
 * was thrown (the CPU only writes the new droplets of each burst).
 */
import * as THREE from 'three';
import type { FxUniforms } from './weatherCommon';
import { GLSL_STREAK, rng, weatherNoise } from './weatherCommon';

export const SPRAY_FX = {
  pool: 480,
  phonePool: 300,
  /** Bursts further than this from the camera are skipped (metres). */
  maxDistance: 300,
};

const VERT = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aInfo; // spawn time, life (s), size (m), kind (0 drop, 1 mist) + seed (0..1)
uniform float uTime, uAspect, uPixel;
uniform vec2 uWind;
uniform vec3 uCamVel;
varying float vA;
varying vec2 vUV;
varying float vMist;
varying float vSeed;
varying float vAge;
${GLSL_STREAK}

void main() {
  float age = uTime - aInfo.x;
  float life = aInfo.y;
  vUV = position.xy;
  vAge = age;
  vSeed = fract(aInfo.w);
  vMist = step(1.0, aInfo.w);
  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vA = 0.0;
    return;
  }
  float mist = vMist;
  float k = mix(1.3, 3.0, mist);          // air drag: droplets carry, mist is soon blown away
  float g = 9.8 * mix(1.0, 0.25, mist);
  vec3 w = vec3(uWind.x, 0.0, uWind.y);
  float e = exp(-k * age);
  vec3 p = aP0 + w * age + (aV0 - w) * (1.0 - e) / k;
  p.y += g / (k * k) * (1.0 - e) - g / k * age;
  float t = age / life;
  if (mist > 0.5) {
    // A soft puff facing the camera, growing as it spreads.
    vec4 mv = viewMatrix * vec4(p, 1.0);
    mv.xy += position.xy * aInfo.z * (0.5 + 1.6 * t);
    gl_Position = projectionMatrix * mv;
    vA = 0.5 * (1.0 - t) * (1.0 - t) * smoothstep(0.0, 0.05, t);
  } else {
    // A droplet: a short streak along its motion as you see it (relative to the boat).
    vec3 v = w + (aV0 - w) * e;
    v.y = (aV0.y + g / k) * e - g / k;
    vec3 rel = v - uCamVel;
    vec3 tail = p - rel * 0.03;
    float cover;
    gl_Position = streakCorner(tail, p, aInfo.z, vec2(position.x * 0.5 + 0.5, position.y), cover);
    vA = 0.85 * (1.0 - smoothstep(0.55, 1.0, t)) * cover * step(-0.3, p.y);
  }
}`;

const FRAG = /* glsl */ `
uniform vec3 uSunColor, uHorizon, uZenith, uSunView;
uniform float uDay, uNight;
uniform sampler2D tNoise;
varying float vA;
varying vec2 vUV;
varying float vMist;
varying float vSeed;
varying float vAge;
void main() {
  if (vA < 0.003) discard;
  // White water: lit by the whole sky, a little of its colour.
  vec3 sky = mix(uHorizon, uZenith, 0.3) * 0.6 + 0.3 * (uDay + 0.15);
  vec3 sunV = normalize(uSunView);
  // Looking toward the sun, spray lights up.
  float toward = pow(max(-sunV.z, 0.0), 3.0);
  vec3 col;
  float a;
  if (vMist > 0.5) {
    float r2 = dot(vUV, vUV);
    if (r2 > 1.0) discard;
    // Torn into wisps.
    float n = texture2D(tNoise, vUV * 0.35 + vec2(vSeed * 5.3, vSeed * 2.9 + vAge * 0.2)).r;
    a = vA * (1.0 - r2) * smoothstep(0.25, 0.75, n + 0.35 * (1.0 - r2));
    col = sky + uSunColor * (0.3 + 0.55 * toward) * uDay;
  } else {
    // Soft across, brightest at the head; now and then a flash of sun.
    float along = vUV.x * 0.5 + 0.5;
    a = vA * (1.0 - vUV.y * vUV.y) * smoothstep(0.0, 0.5, along);
    float flash = smoothstep(0.82, 0.97, fract(vSeed * 17.3 + vAge * 2.7));
    col = sky * 1.1 + uSunColor * (0.45 + 0.7 * toward + 2.2 * flash * max(sunV.y + 0.3, 0.0)) * uDay;
  }
  col *= 0.25 + 0.75 * uDay + 0.1 * uNight;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class SprayFx {
  readonly mesh: THREE.Mesh;
  readonly pool: number;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private p0: THREE.BufferAttribute;
  private v0: THREE.BufferAttribute;
  private info: THREE.BufferAttribute;
  private next = 0;
  private r = rng(4242);
  private wind = new THREE.Vector2();
  private sunView = new THREE.Vector3(0, 1, 0);
  /** Time the last droplet dies (for hiding the mesh when nothing is flying). */
  private until = -Infinity;

  constructor(shared: FxUniforms, phone: boolean) {
    const n = phone ? SPRAY_FX.phonePool : SPRAY_FX.pool;
    this.pool = n;
    const pos = new Float32Array(n * 4 * 3);
    const idx = new Uint16Array(n * 6);
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        pos[(i * 4 + c) * 3] = corners[c * 2];
        pos[(i * 4 + c) * 3 + 1] = corners[c * 2 + 1];
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    }
    this.p0 = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.v0 = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const info = new Float32Array(n * 4 * 4);
    // Born long ago and long dead.
    for (let v = 0; v < n * 4; v++) info[v * 4] = -1e9;
    this.info = new THREE.BufferAttribute(info, 4).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('aP0', this.p0);
    this.geo.setAttribute('aV0', this.v0);
    this.geo.setAttribute('aInfo', this.info);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...shared, uWind: { value: this.wind }, uSunView: { value: this.sunView }, tNoise: { value: weatherNoise() } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'spray';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
  }

  /**
   * One burst off the bow at (x, y, z); dir is the boat's heading (unit,
   * horizontal), strength 0..1, boatSpeed in m/s. Returns how many droplets flew.
   */
  burst(x: number, y: number, z: number, dirX: number, dirZ: number, strength: number, time: number, boatSpeed: number, cam: THREE.Vector3): number {
    const s = Math.min(1, Math.max(0, strength));
    if (s <= 0.01) return 0;
    if (Math.hypot(x - cam.x, y - cam.y, z - cam.z) > SPRAY_FX.maxDistance) return 0;
    const l = Math.hypot(dirX, dirZ) || 1;
    const fx = dirX / l;
    const fz = dirZ / l;
    // Starboard (to the right of the heading).
    const sx = -fz;
    const sz = fx;
    const drops = Math.round(14 + 50 * s);
    const mists = Math.round(4 + 9 * s);
    const r = this.r;
    const total = drops + mists;
    for (let k = 0; k < total; k++) {
      const mist = k >= drops;
      const side = r() < 0.5 ? -1 : 1;
      const along = (r() - 0.75) * 0.7;
      const out = 0.15 + 0.4 * r();
      const px = x + fx * along + sx * side * out;
      const pz = z + fz * along + sz * side * out;
      const py = y - 0.3 + 0.3 * r();
      // Thrown up and out to the side, a little ahead, on top of the boat's own speed.
      const upV = (2.5 + 4.5 * r()) * (0.45 + 0.75 * s) * (mist ? 0.55 : 1);
      const outV = (1.0 + 2.6 * r()) * (0.5 + 0.8 * s) * (mist ? 0.6 : 1);
      const fwdV = boatSpeed + (0.3 + 1.6 * r()) * s;
      const vx = fx * fwdV + sx * side * outV;
      const vz = fz * fwdV + sz * side * outV;
      const life = mist ? 0.8 + 0.6 * r() : 0.9 + 0.7 * r();
      // Droplet half-width, or mist puff radius (metres).
      const size = mist ? 0.3 + 0.4 * r() : 0.006 + 0.01 * r();
      const kind = (mist ? 1 : 0) + Math.min(0.999, r());
      const i = this.next;
      this.next = (this.next + 1) % this.pool;
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        this.p0.setXYZ(v, px, py, pz);
        this.v0.setXYZ(v, vx, upV, vz);
        this.info.setXYZW(v, time + r() * 0.06, life, size, kind);
      }
      this.until = Math.max(this.until, time + life + 0.1);
    }
    for (const a of [this.p0, this.v0, this.info]) a.needsUpdate = true;
    this.mesh.visible = true;
    return total;
  }

  update(camera: THREE.PerspectiveCamera, time: number, windX: number, windZ: number, sunDir: THREE.Vector3): void {
    this.wind.set(windX, windZ);
    this.sunView.copy(sunDir).transformDirection(camera.matrixWorldInverse);
    if (time > this.until || time < this.until - 10) this.mesh.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
