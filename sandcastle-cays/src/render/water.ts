/**
 * The sea. A big grid, fine near the beach and coarse toward the horizon, moved
 * by the same waves the boat feels. Colour comes from the depth of water over
 * the sand: clear turquoise in the shallows, deep blue further out. Holes dug
 * below sea level fill with water automatically, because the water surface
 * runs under the whole beach and only shows where the sand is lower.
 */
import * as THREE from 'three';
import { PALETTE, glslColor } from './colors';
import { SAND_GLSL_COMMON } from './sandMaterial';
import { LAGOON_WAVES, wavesGLSL } from './waves';
import type { Terrain } from '../engine/terrain';

const OUTER_SIZE = 200; // metres covered by the static sea-floor map
const OUTER_RES = 400;

function warp(u: number, inner: number, outer: number, power: number): number {
  const a = Math.abs(u);
  return Math.sign(u) * (inner * a + outer * Math.pow(a, power));
}

function makeWaterGeometry(cx: number, cz: number): THREE.BufferGeometry {
  const n = 200;
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let p = 0;
  for (let zi = 0; zi <= n; zi++) {
    const v = (zi / n) * 2 - 1;
    const z = cz + warp(v, 26, 1500, 7);
    for (let xi = 0; xi <= n; xi++) {
      const u = (xi / n) * 2 - 1;
      pos[p++] = cx + warp(u, 26, 1500, 7);
      pos[p++] = 0;
      pos[p++] = z;
    }
  }
  const idx = new Uint32Array(n * n * 6);
  let q = 0;
  for (let zi = 0; zi < n; zi++) {
    for (let xi = 0; xi < n; xi++) {
      const a = zi * (n + 1) + xi;
      const b = a + 1;
      const c = a + n + 1;
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
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, 0, cz), 3000);
  return g;
}

function halfTexture(w: number, h: number, data: Float32Array): THREE.DataTexture {
  const half = new Uint16Array(w * h);
  for (let n = 0; n < w * h; n++) half[n] = THREE.DataUtils.toHalfFloat(data[n]);
  const tex = new THREE.DataTexture(half, w, h, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

export class Water {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private regionTex: THREE.DataTexture | null = null;
  private regionHalf: Uint16Array | null = null;
  /** Top sand height on the editable beach (for the camera), 2-cell resolution. */
  regionHeights: Float32Array | null = null;
  regionW = 0;
  regionH = 0;
  regionCell = 0.06;
  regionX = 0;
  regionZ = 0;
  private regionDirty = false;

  /** @param extraFloor  height of anything else on the sea floor (rocks), or -Infinity */
  constructor(
    private terrain: Terrain,
    extraFloor: (x: number, z: number) => number = () => -Infinity,
  ) {
    // Static map of the untouched sea floor around the island (and the rocks on it).
    const outer = new Float32Array(OUTER_RES * OUTER_RES);
    const x0 = -OUTER_SIZE / 2;
    const z0 = -OUTER_SIZE / 2 - 30;
    for (let zi = 0; zi < OUTER_RES; zi++) {
      for (let xi = 0; xi < OUTER_RES; xi++) {
        const x = x0 + ((xi + 0.5) / OUTER_RES) * OUTER_SIZE;
        const z = z0 + ((zi + 0.5) / OUTER_RES) * OUTER_SIZE;
        outer[xi + zi * OUTER_RES] = Math.max(terrain.heightAt(x, z), extraFloor(x, z));
      }
    }
    const outerTex = halfTexture(OUTER_RES, OUTER_RES, outer);
    const dummy = halfTexture(1, 1, new Float32Array([-10]));
    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uCamPos: { value: new THREE.Vector3() },
        uOuterRect: { value: new THREE.Vector4(x0, z0, OUTER_SIZE, OUTER_SIZE) },
        uRegionRect: { value: new THREE.Vector4(0, 0, 0.001, 0.001) },
      },
    ]);
    // Textures are kept out of the merge (merge clones them).
    this.uniforms.uOuterFloor = { value: outerTex };
    this.uniforms.uRegionFloor = { value: dummy };

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: true,
      vertexShader: /* glsl */ `
uniform float uTime;
uniform sampler2D uOuterFloor;
uniform vec4 uOuterRect;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vMask;
#include <fog_pars_vertex>
${wavesGLSL(LAGOON_WAVES)}
void main() {
  vec3 p = position;
  float still = texture2D(uOuterFloor, (p.xz - uOuterRect.xy) / uOuterRect.zw).r;
  // Waves die away over the beach, so holes dug inland hold calm water.
  float mask = smoothstep(0.32, -0.1, still);
  // A little more swell out where the lagoon is deeper (the boat feels the same).
  float deep = smoothstep(0.6, 3.0, -still);
  vec3 n;
  p += gerstner(p.xz, uTime, mask * (1.0 + 1.6 * deep), n);
  vWorld = p;
  vNrm = n;
  vMask = mask;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`,
      fragmentShader: /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uCamPos;
uniform sampler2D uOuterFloor;
uniform vec4 uOuterRect;
uniform sampler2D uRegionFloor;
uniform vec4 uRegionRect;
varying vec3 vWorld;
varying vec3 vNrm;
varying float vMask;
#include <common>
#include <fog_pars_fragment>
${SAND_GLSL_COMMON}
float floorAt(vec2 xz) {
  vec2 r = (xz - uRegionRect.xy) / uRegionRect.zw;
  if (r.x >= 0.0 && r.y >= 0.0 && r.x <= 1.0 && r.y <= 1.0) return texture2D(uRegionFloor, r).r;
  return texture2D(uOuterFloor, (xz - uOuterRect.xy) / uOuterRect.zw).r;
}
void main() {
  float depth = vWorld.y - floorAt(vWorld.xz);
  if (depth <= 0.0) discard;
  vec2 q = vWorld.xz;
  float t = uTime;
  // Small ripples on top of the big waves (lighting only).
  vec2 rip = vec2(
    sin(q.x * 6.1 + q.y * 1.7 + t * 2.6) + 0.6 * sin(q.x * 11.3 - q.y * 4.1 - t * 3.4) + 0.4 * sin(q.y * 9.7 + t * 2.2),
    cos(q.y * 6.7 - q.x * 1.3 + t * 2.3) + 0.6 * cos(q.y * 12.1 + q.x * 3.7 + t * 3.1) + 0.4 * cos(q.x * 8.9 - t * 2.8)
  );
  vec3 n = normalize(vNrm + vec3(rip.x, 0.0, rip.y) * 0.045);
  vec3 V = normalize(uCamPos - vWorld);
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 col = mix(${glslColor(PALETTE.waterShallow)}, ${glslColor(PALETTE.waterMid)}, smoothstep(0.03, 0.9, depth));
  col = mix(col, ${glslColor(PALETTE.waterDeep)}, smoothstep(1.0, 5.0, depth));
  vec3 R = reflect(-V, n);
  vec3 sky = mix(${glslColor(PALETTE.skyHorizon)}, ${glslColor(PALETTE.skyZenith)}, clamp(R.y * 1.6, 0.0, 1.0));
  col = mix(col, sky, clamp(fres, 0.0, 1.0) * 0.85);
  float rs = max(dot(R, uSunDir), 0.0);
  col += vec3(1.0, 0.96, 0.86) * (pow(rs, 900.0) * 7.0 + pow(rs, 80.0) * 0.18);
  // Clear in the shallows, solid further out.
  float alpha = 1.0 - exp(-depth * 2.6);
  alpha = max(alpha, fres * 0.85);
  alpha = mix(alpha, 1.0, smoothstep(5.0, 25.0, depth));
  // Foam where the water meets the sand.
  float edge = 1.0 - smoothstep(0.0, 0.03 + 0.04 * vMask, depth);
  float fn = sc_noise2(q * 10.0 + vec2(t * 0.35, -t * 0.25)) * 0.6 + sc_noise2(q * 23.0 - vec2(t * 0.5, 0.0)) * 0.4;
  float foam = edge * smoothstep(0.42, 0.62, fn + edge * 0.35);
  col = mix(col, vec3(1.0), foam * 0.9);
  alpha = max(alpha, foam * 0.92);
  alpha *= smoothstep(0.0, 0.004, depth);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`,
    });
    this.mesh = new THREE.Mesh(makeWaterGeometry(0, -4), material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }

  /** Set up the depth map of the editable beach (when the engine is ready). */
  setRegion(w: number, h: number, cell: number, originX: number, originZ: number): void {
    this.regionW = w;
    this.regionH = h;
    this.regionCell = cell;
    this.regionX = originX;
    this.regionZ = originZ;
    if (!this.regionHeights || this.regionHeights.length !== w * h) {
      this.regionHeights = new Float32Array(w * h);
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          this.regionHeights[x + z * w] = this.terrain.heightAt(originX + (x + 0.5) * cell, originZ + (z + 0.5) * cell);
        }
      }
    }
    this.regionHalf = new Uint16Array(w * h);
    for (let n = 0; n < w * h; n++) this.regionHalf[n] = THREE.DataUtils.toHalfFloat(this.regionHeights[n]);
    this.regionTex?.dispose();
    this.regionTex = new THREE.DataTexture(this.regionHalf, w, h, THREE.RedFormat, THREE.HalfFloatType);
    this.regionTex.magFilter = THREE.LinearFilter;
    this.regionTex.minFilter = THREE.LinearFilter;
    this.regionTex.needsUpdate = true;
    this.uniforms.uRegionFloor.value = this.regionTex;
    // Texel centres sit half a texel in from the edge.
    (this.uniforms.uRegionRect.value as THREE.Vector4).set(originX, originZ, w * cell, h * cell);
  }

  /** Update part of the depth map after the sand changed. */
  patch(hx: number, hz: number, span: number, heights: Float32Array): void {
    if (!this.regionHeights || !this.regionHalf) return;
    for (let z = 0; z < span; z++) {
      for (let x = 0; x < span; x++) {
        const gx = hx + x;
        const gz = hz + z;
        if (gx >= this.regionW || gz >= this.regionH) continue;
        const v = heights[x + z * span];
        this.regionHeights[gx + gz * this.regionW] = v;
        this.regionHalf[gx + gz * this.regionW] = THREE.DataUtils.toHalfFloat(v);
      }
    }
    this.regionDirty = true;
  }

  /** Ground height under any point (editable beach, or the untouched shape elsewhere). */
  groundAt(x: number, z: number): number {
    if (this.regionHeights) {
      const gx = Math.floor((x - this.regionX) / this.regionCell);
      const gz = Math.floor((z - this.regionZ) / this.regionCell);
      if (gx >= 0 && gz >= 0 && gx < this.regionW && gz < this.regionH) return this.regionHeights[gx + gz * this.regionW];
    }
    return this.terrain.heightAt(x, z);
  }

  update(time: number, camera: THREE.Camera, sunDir: THREE.Vector3): void {
    this.uniforms.uTime.value = time;
    (this.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position);
    (this.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    if (this.regionDirty && this.regionTex) {
      this.regionTex.needsUpdate = true;
      this.regionDirty = false;
    }
  }
}
