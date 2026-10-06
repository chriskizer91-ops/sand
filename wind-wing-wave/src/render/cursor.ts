/**
 * The brush ring: where, and how big, your tool will act.
 *
 * The ring is a disc mesh draped over the ground by the graphics chip (it reads the same
 * height map as the terrain), so it hugs slopes, crater rims and the sea floor exactly, and
 * marks the true footprint of the tool. Colour says which tool: ember orange (lava), stone
 * grey (rock), sand gold (sand), soft white (hands), sea blue (scoop). Look shows a small
 * eye instead. It breathes gently, follows the pointer smoothly, and hides in watch mode.
 * Where a hill hides part of the ring, that part still shows faintly, so you never lose it.
 */
import * as THREE from 'three';
import type { ToolId } from '../config';
import { GLSL_GROUND } from './ocean';
import { WORLD_UNIFORMS_GLSL, type FrameCtx, type PageSystem, type SystemDeps } from './shared';

export const TOOL_COLORS: Record<ToolId, number> = {
  lava: 0xff7a2a,
  rock: 0xb4b0a8,
  sand: 0xf2d48a,
  hands: 0xffffff,
  scoop: 0x5cc8ee,
  look: 0xffffff,
};

/** The eye for Look is this share of the brush radius. */
const EYE_SCALE = 0.4;

/** A disc of rings (radius 1.1), denser near the edge where the ring line is drawn. */
function makeDisc(): THREE.BufferGeometry {
  const around = 64;
  const radii = [0.1, 0.3, 0.55, 0.75, 0.88, 0.95, 1.0, 1.05, 1.1];
  const pos = new Float32Array((1 + radii.length * around) * 3);
  let p = 3; // centre at the origin
  for (const r of radii) {
    for (let k = 0; k < around; k++) {
      const a = (k / around) * Math.PI * 2;
      pos[p++] = Math.cos(a) * r;
      pos[p++] = 0;
      pos[p++] = Math.sin(a) * r;
    }
  }
  const idx: number[] = [];
  const at = (ring: number, k: number) => 1 + ring * around + (k % around);
  for (let k = 0; k < around; k++) {
    idx.push(0, at(0, k + 1), at(0, k));
    for (let ring = 0; ring < radii.length - 1; ring++) {
      idx.push(at(ring, k), at(ring, k + 1), at(ring + 1, k), at(ring + 1, k), at(ring, k + 1), at(ring + 1, k + 1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const VERTEX = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
uniform sampler2D uHeightTex;
uniform vec3 uCenter;
uniform float uRadius;
uniform float uLift;
varying vec2 vLocal;
${GLSL_GROUND}
void main() {
  vec2 xz = uCenter.xz + position.xz * uRadius;
  vLocal = position.xz;
  gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, ww_ground(xz) + uLift, xz.y, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uPulse;
uniform float uEye;
varying vec2 vLocal;
void main() {
  float rho = length(vLocal);
  float aa = fwidth(rho) * 1.2 + 1e-4;
  // The ring line: at least about two pixels wide, breathing a little.
  float w = max(0.022 + 0.012 * uPulse, aa * 1.6);
  float line = 1.0 - smoothstep(w, w + aa, abs(rho - 1.0));
  // A soft dark edge either side keeps it readable on white sand.
  float edge = (1.0 - smoothstep(w + aa, w + aa * 4.0 + 0.03, abs(rho - 1.0))) * (1.0 - line);
  // A faint wash inside, and a centre dot (or, for Look, a pupil).
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0, rho);
  float dotR = mix(0.04, 0.3, uEye);
  float centre = 1.0 - smoothstep(dotR, dotR + aa, rho);
  float a = max(line, max(inside * (0.07 + 0.05 * uPulse), centre * mix(0.85, 0.6, uEye)));
  vec3 col = uColor;
  col = mix(col, vec3(0.08, 0.1, 0.12), edge);
  a = max(a, edge * 0.3);
  gl_FragColor = vec4(col, a * uOpacity);
  #include <colorspace_fragment>
}
`;

export function createCursor(deps: SystemDeps): PageSystem {
  const { scene, u } = deps;
  const center = new THREE.Vector3();
  const color = new THREE.Color();
  const shared = {
    uHeightTex: u.uHeightTex,
    uZone: u.uZone,
    uCenter: { value: center },
    uRadius: { value: 1 },
    uLift: { value: 0.1 },
    uColor: { value: color },
    uPulse: { value: 0 },
    uEye: { value: 0 },
  };
  const make = (opacity: number, behind: boolean) =>
    new THREE.ShaderMaterial({
      name: behind ? 'cursor-behind' : 'cursor',
      uniforms: { ...shared, uOpacity: { value: opacity } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthFunc: behind ? THREE.GreaterDepth : THREE.LessEqualDepth,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
  const geometry = makeDisc();
  const front = new THREE.Mesh(geometry, make(0.9, false));
  const behind = new THREE.Mesh(geometry, make(0.28, true));
  for (const m of [front, behind]) {
    m.frustumCulled = false;
    m.visible = false;
  }
  behind.renderOrder = 5;
  front.renderOrder = 6;
  scene.add(behind, front);

  const target = new THREE.Vector3();
  let radius = 1;
  let shown = false;

  return {
    name: 'cursor',
    update(f: FrameCtx) {
      const b = f.brush;
      const visible = !!b && !f.watching;
      front.visible = behind.visible = visible;
      if (!b || !visible) {
        shown = false;
        return;
      }
      const eye = f.tool === 'look';
      const r = b.r * (eye ? EYE_SCALE : 1);
      target.set(b.x, b.y, b.z);
      // Follow the pointer smoothly, but jump when it comes back somewhere new.
      if (!shown || target.distanceTo(center) > 4 * r) {
        center.copy(target);
        radius = r;
      } else {
        const k = 1 - Math.exp(-f.dt * 30);
        center.lerp(target, k);
        radius += (r - radius) * k;
      }
      shown = true;
      shared.uRadius.value = radius;
      shared.uLift.value = 0.06 + f.cam.dist * 0.002;
      shared.uEye.value = eye ? 1 : 0;
      shared.uPulse.value = 0.5 + 0.5 * Math.sin((f.t * 2 * Math.PI) / 2.4);
      color.setHex(TOOL_COLORS[f.tool]);
    },
    dispose() {
      scene.remove(behind, front);
      geometry.dispose();
      (front.material as THREE.Material).dispose();
      (behind.material as THREE.Material).dispose();
    },
  };
}
