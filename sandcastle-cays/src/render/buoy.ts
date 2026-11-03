/**
 * The sea buoy: a red-and-white striped "safe water" mark out on the open
 * sea, with a red ball on top and a white light that flashes the Morse letter
 * A (short, long) at night. It bobs on the swell. All made in code.
 */
import * as THREE from 'three';

const RED: [number, number, number] = [0.78, 0.13, 0.1];
const WHITE: [number, number, number] = [0.93, 0.92, 0.88];
const DARK: [number, number, number] = [0.16, 0.17, 0.18];

function coloured(g: THREE.BufferGeometry, c: [number, number, number]): THREE.BufferGeometry {
  const g2 = g.index ? g.toNonIndexed() : g;
  g2.deleteAttribute('uv');
  const n = g2.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(c, i * 3);
  g2.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g2;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  for (const p of parts) count += p.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o = 0;
  for (const p of parts) {
    p.computeVertexNormals();
    const n = p.getAttribute('position').count;
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    col.set(p.getAttribute('color').array as Float32Array, o * 3);
    o += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

/** A striped cylinder: vertical red and white stripes. */
function striped(rTop: number, rBot: number, h: number, y: number, stripes: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const w = (Math.PI * 2) / stripes;
  for (let i = 0; i < stripes; i++) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, 4, 1, true, i * w, w);
    g.translate(0, y, 0);
    out.push(coloured(g, i % 2 ? WHITE : RED));
  }
  return out;
}

const GLOW_VERT = /* glsl */ `
uniform float uSize, uOn;
varying float vOn;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Holds a steady size on screen far off; grows a little up close.
  gl_PointSize = uSize * clamp(14.0 / -mv.z, 1.0, 2.5);
  vOn = uOn;
}`;
const GLOW_FRAG = /* glsl */ `
varying float vOn;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = (exp(-r * r * 5.0) * 0.85 + exp(-r * r * 60.0)) * vOn;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.88) * a * 2.2, a);
}`;

export interface SeaBuoy {
  group: THREE.Group;
  /** Bob on the sea (heightAt gives the water surface) and flash the light at night. */
  update(time: number, heightAt: (x: number, z: number) => number, night: number, viewHeight: number): void;
}

export function createSeaBuoy(x: number, z: number): SeaBuoy {
  const group = new THREE.Group();
  group.name = 'seaBuoy';
  const parts: THREE.BufferGeometry[] = [];
  // The float: a fat drum, mostly under water.
  parts.push(...striped(0.85, 0.75, 1.1, -0.15, 8));
  parts.push(coloured(new THREE.CylinderGeometry(0.85, 0.85, 0.06, 16).translate(0, 0.42, 0), WHITE));
  parts.push(coloured(new THREE.CylinderGeometry(0.75, 0.3, 0.4, 12).translate(0, -0.9, 0), DARK));
  // The pillar and its cage.
  parts.push(...striped(0.32, 0.42, 1.6, 1.25, 6));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const leg = new THREE.CylinderGeometry(0.025, 0.025, 0.7, 4);
    leg.translate(Math.cos(a) * 0.3, 2.35, Math.sin(a) * 0.3);
    parts.push(coloured(leg, RED));
  }
  parts.push(coloured(new THREE.TorusGeometry(0.3, 0.025, 4, 16).rotateX(Math.PI / 2).translate(0, 2.7, 0), RED));
  // The red ball on top, and the lantern.
  parts.push(coloured(new THREE.SphereGeometry(0.26, 14, 10).translate(0, 3.05, 0), RED));
  parts.push(coloured(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 8).translate(0, 2.2, 0), [0.95, 0.94, 0.86]));
  const mesh = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 }));
  mesh.castShadow = true;
  group.add(mesh);

  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 2.2, 0], 3));
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 30 }, uOn: { value: 0 } },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Points(glowGeo, glowMat);
  glow.frustumCulled = false;
  glow.renderOrder = 4;
  group.add(glow);
  group.position.set(x, 0, z);

  let y = 0;
  return {
    group,
    update(time, heightAt, night, viewHeight) {
      const h = heightAt(x, z);
      const hx = heightAt(x + 1, z) - heightAt(x - 1, z);
      const hz = heightAt(x, z + 1) - heightAt(x, z - 1);
      y += (h - y) * 0.25;
      group.position.y = y;
      group.rotation.set(hz * 0.5 + 0.05 * Math.sin(time * 0.9), 0, -hx * 0.5 + 0.05 * Math.sin(time * 0.7 + 1));
      // Morse A every 6 s: a short flash, then a long one.
      const p = time % 6;
      const on = (p < 0.4 ? 1 : 0) + (p > 0.9 && p < 2.4 ? 1 : 0);
      glowMat.uniforms.uOn.value = on * Math.min(1, night * 1.6);
      glowMat.uniforms.uSize.value = 30 * (viewHeight / 900);
    },
  };
}
