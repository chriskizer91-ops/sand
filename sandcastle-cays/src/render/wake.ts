/**
 * The white water your boat leaves behind under sail: a trail of foam that
 * spreads and fades, lying on the waves. Made from a strip of triangles that
 * follows the stern; the foam pattern comes from the water's own ripples.
 */
import * as THREE from 'three';
import { waterDetailTexture } from './paint';

const N = 48;
/** Seconds between trail points. */
const STEP = 0.35;

export class Wake {
  readonly mesh: THREE.Mesh;
  private pts: { x: number; z: number; age: number; strength: number; nx: number; nz: number }[] = [];
  private pos: Float32Array;
  private alpha: Float32Array;
  private uvs: Float32Array;
  private timer = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(N * 2 * 3);
    this.alpha = new Float32Array(N * 2);
    this.uvs = new Float32Array(N * 2 * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('foam', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { tDetail: { value: waterDetailTexture() }, uGlow: { value: 0 }, uDay: { value: 1 } },
      vertexShader: /* glsl */ `
attribute float foam;
varying float vFoam;
varying vec2 vUv;
varying vec2 vWorld;
void main() {
  vFoam = foam;
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
      fragmentShader: /* glsl */ `
uniform sampler2D tDetail;
uniform float uGlow, uDay;
varying float vFoam;
varying vec2 vUv;
varying vec2 vWorld;
void main() {
  float n = texture2D(tDetail, vWorld * 0.35).a * 0.6 + texture2D(tDetail, vWorld * 0.9).a * 0.4;
  // Streaks along the trail, broken up by the ripple pattern; soft at both edges.
  float across = 1.0 - pow(abs(vUv.x * 2.0 - 1.0), 1.6);
  float a = vFoam * across * smoothstep(0.32, 0.62, n + vFoam * 0.25);
  vec3 col = mix(vec3(0.92, 0.97, 1.0) * (0.25 + 0.75 * uDay), vec3(0.2, 1.4, 1.6), uGlow);
  gl_FragColor = vec4(col, a * 0.75);
}`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  /**
   * @param sternX, sternZ  where the water leaves the hull
   * @param speed  boat speed (m/s)
   * @param sea    water surface height
   */
  update(dt: number, sternX: number, sternZ: number, heading: number, speed: number, sea: (x: number, z: number) => number, glow: number, day: number): void {
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uGlow.value = glow;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uDay.value = day;
    for (const p of this.pts) p.age += dt;
    this.timer -= dt;
    if (this.timer <= 0 && speed > 0.35) {
      this.timer = STEP;
      this.pts.unshift({ x: sternX, z: sternZ, age: 0, strength: Math.min(1, speed / 3), nx: -Math.sin(heading), nz: Math.cos(heading) });
      if (this.pts.length > N - 1) this.pts.length = N - 1;
    }
    while (this.pts.length && this.pts[this.pts.length - 1].age > STEP * (N - 1)) this.pts.pop();
    const list = [{ x: sternX, z: sternZ, age: 0, strength: Math.min(1, speed / 3), nx: -Math.sin(heading), nz: Math.cos(heading) }, ...this.pts].slice(0, N);
    this.mesh.visible = list.length > 2 && list.some((p) => p.strength > 0.1);
    if (!this.mesh.visible) return;
    for (let i = 0; i < N; i++) {
      const p = list[Math.min(i, list.length - 1)];
      const life = Math.min(1, p.age / (STEP * (N - 1)));
      const half = 0.55 + 4.5 * life;
      const y = sea(p.x, p.z) + 0.03;
      const o = i * 6;
      this.pos[o] = p.x + p.nx * half;
      this.pos[o + 1] = y;
      this.pos[o + 2] = p.z + p.nz * half;
      this.pos[o + 3] = p.x - p.nx * half;
      this.pos[o + 4] = y;
      this.pos[o + 5] = p.z - p.nz * half;
      const a = i >= list.length ? 0 : p.strength * (1 - life) * (1 - life) * Math.min(1, i / 2 + 0.3);
      this.alpha[i * 2] = a;
      this.alpha[i * 2 + 1] = a;
      this.uvs[i * 4] = 0;
      this.uvs[i * 4 + 1] = i;
      this.uvs[i * 4 + 2] = 1;
      this.uvs[i * 4 + 3] = i;
    }
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('foam').needsUpdate = true;
    g.getAttribute('uv').needsUpdate = true;
  }
}
