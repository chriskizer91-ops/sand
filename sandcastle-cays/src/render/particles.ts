/** Falling sand and dig spray, drawn as little lit balls (one point each). */
import * as THREE from 'three';
import { PALETTE, glslColor } from './colors';

const CAP = 12000;

export class SandParticles {
  readonly points: THREE.Points;
  private pos = new Float32Array(CAP * 3);
  private size = new Float32Array(CAP);
  private wet = new Float32Array(CAP);
  private geo = new THREE.BufferGeometry();
  readonly uniforms = {
    uScale: { value: 800 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
  };

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('pwet', new THREE.BufferAttribute(this.wet, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
uniform float uScale;
attribute float psize;
attribute float pwet;
varying float vWet;
void main() {
  vWet = pwet;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.5, psize * 2.0 * uScale / -mv.z);
}`,
      fragmentShader: /* glsl */ `
uniform vec3 uSunView;
varying float vWet;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  vec3 n = vec3(c.x, -c.y, sqrt(1.0 - r2));
  vec3 dry = ${glslColor(PALETTE.sandDry)};
  vec3 wet = ${glslColor(PALETTE.sandWet)};
  vec3 col = mix(dry, wet, smoothstep(0.1, 0.7, vWet));
  float light = 0.55 + 0.6 * max(dot(n, normalize(uSunView)), 0.0);
  gl_FragColor = vec4(col * light, 1.0);
  #include <colorspace_fragment>
}`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
  }

  /** data: x, y, z, radius, wetness per particle. */
  set(data: Float32Array, n: number): void {
    const count = Math.min(n, CAP);
    for (let p = 0; p < count; p++) {
      const o = p * 5;
      this.pos[p * 3] = data[o];
      this.pos[p * 3 + 1] = data[o + 1];
      this.pos[p * 3 + 2] = data[o + 2];
      this.size[p] = data[o + 3];
      this.wet[p] = data[o + 4];
    }
    for (const name of ['position', 'psize', 'pwet']) {
      const a = this.geo.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.geo.setDrawRange(0, count);
  }

  setViewport(heightPx: number, fovDeg: number): void {
    this.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }
}
