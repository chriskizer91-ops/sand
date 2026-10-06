/** Sky dome with a soft sun, and a few puffy clouds drifting far away. */
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE, glslColor } from './colors';
import { mulberry32 } from '../engine/noise';

export function createSky(sunDir: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uSunDir: { value: sunDir } },
    vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  vec3 col = mix(${glslColor(PALETTE.skyHorizon)}, ${glslColor(PALETTE.skyZenith)}, pow(max(h, 0.0), 0.55));
  float s = max(dot(d, normalize(uSunDir)), 0.0);
  col += vec3(1.0, 0.92, 0.75) * (pow(s, 12.0) * 0.18 + pow(s, 200.0) * 0.6);
  col = mix(col, vec3(1.0, 0.99, 0.95), smoothstep(0.9993, 0.9997, s));
  if (h < 0.0) col = ${glslColor(PALETTE.skyHorizon)};
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

/** Cartoon cumulus clouds: clusters of squashed spheres with flat bottoms. */
export function createClouds(): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(42);
  const ico = new THREE.IcosahedronGeometry(1, 3);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const base = mergeVertices(ico);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xc9dcec, emissiveIntensity: 0.55 });
  for (let c = 0; c < 14; c++) {
    const parts: THREE.BufferGeometry[] = [];
    const puffs = 5 + Math.floor(rand() * 5);
    for (let p = 0; p < puffs; p++) {
      const g = base.clone();
      const s = 6 + rand() * 8;
      g.scale(s * 1.2, s * 0.8, s);
      g.translate((p - puffs / 2) * 7 + rand() * 4, rand() * 4, rand() * 6 - 3);
      parts.push(g);
    }
    const merged = mergeGeometries(parts);
    // Flatten the bottom.
    const pos = merged.getAttribute('position') as THREE.BufferAttribute;
    for (let v = 0; v < pos.count; v++) if (pos.getY(v) < -2) pos.setY(v, -2 + (pos.getY(v) + 2) * 0.15);
    merged.computeVertexNormals();
    const cloud = new THREE.Mesh(merged, mat);
    const ang = rand() * Math.PI * 2;
    const dist = 380 + rand() * 450;
    cloud.position.set(Math.cos(ang) * dist, 70 + rand() * 110, Math.sin(ang) * dist - 100);
    cloud.rotation.y = rand() * Math.PI;
    cloud.scale.setScalar(0.8 + rand() * 0.9);
    group.add(cloud);
  }
  return group;
}

/** Join several geometries (same attributes) into one. */
export function mergeGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const g of geoms) {
    nv += g.getAttribute('position').count;
    ni += g.index ? g.index.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const hasColor = geoms.every((g) => g.getAttribute('color'));
  const col = hasColor ? new Float32Array(nv * 3) : null;
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of geoms) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    for (let v = 0; v < p.count; v++) {
      pos[(vo + v) * 3] = p.getX(v);
      pos[(vo + v) * 3 + 1] = p.getY(v);
      pos[(vo + v) * 3 + 2] = p.getZ(v);
      nrm[(vo + v) * 3] = n.getX(v);
      nrm[(vo + v) * 3 + 1] = n.getY(v);
      nrm[(vo + v) * 3 + 2] = n.getZ(v);
    }
    if (col) {
      const c = g.getAttribute('color') as THREE.BufferAttribute;
      for (let v = 0; v < p.count; v++) {
        col[(vo + v) * 3] = c.getX(v);
        col[(vo + v) * 3 + 1] = c.getY(v);
        col[(vo + v) * 3 + 2] = c.getZ(v);
      }
    }
    if (g.index) {
      for (let n2 = 0; n2 < g.index.count; n2++) idx[io + n2] = g.index.getX(n2) + vo;
      io += g.index.count;
    } else {
      for (let n2 = 0; n2 < p.count; n2++) idx[io + n2] = n2 + vo;
      io += p.count;
    }
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
