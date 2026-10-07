/**
 * Ponds (ARCHITECTURE §6.5): one flat sheet of water for each pond the life simulation reports
 * (life.ponds), at the pond's own water level.
 *
 * - Where exactly is the water? A pond only reports its level and a box. Inside the box the ground
 *   can dip below that level in places the water can't reach (the outside of a crater wall, say), so
 *   the page fills the basin itself: starting from the pond's own squares (the life map marks them),
 *   it spreads to every connected column lower than the water. That small map (world data, 2 m per
 *   texel) tells the shader where to draw; the exact shoreline comes from the ground height under
 *   every pixel, so the edge is smooth and follows the hollow.
 * - Fresh ponds are clear green-blue; salt ponds are milky, and turn pink (or rosy red) when the
 *   creatures that colour salt ponds live on that island (species with the 'pink-pond' or
 *   'red-pond' water effect).
 * - Small wind ripples always; rain rings when it rains. Fog, sky and sun come from the shared uniforms.
 * Ponds come and go with the life messages; their meshes and maps are freed when they go. If the
 * land under a pond is reshaped, its basin is filled again.
 */
import * as THREE from 'three';
import { CELL, NP, NX, NZ, ORIGIN_X, ORIGIN_Z, PATCH } from '../config';
import { Habitat } from '../content/speciesTypes';
import type { FromEngine, LifeInfo, PondInfo } from '../engine/protocol';
import { POND, linear } from './colors';
import { WORLD_UNIFORMS_GLSL, type FrameCtx, type PageSystem, type SystemDeps, type WorldUniforms } from './shared';
import { HASH_GLSL, HEIGHT_GLSL, WAVE_GLSL } from './terrainMaterial';

/** Columns of slack around a pond's box, so the basin can always be filled to its true shore. */
const MARGIN_COLS = 2;

/** What colours a pond: its water type and who lives around it. */
export type PondTint = 'fresh' | 'salt' | 'pink' | 'red';

const TINTS: Record<PondTint, { shallow: number; deep: number; milk: number }> = {
  fresh: { shallow: POND.freshShallow, deep: POND.freshDeep, milk: 0 },
  salt: { shallow: POND.saltShallow, deep: POND.saltDeep, milk: 0.7 },
  pink: { shallow: POND.pinkShallow, deep: POND.pinkDeep, milk: 0.75 },
  red: { shallow: POND.redShallow, deep: POND.redDeep, milk: 0.75 },
};

/**
 * A salt pond turns pink or red when a species with that water effect lives on its island
 * (the island whose box holds the pond's centre). Fresh ponds keep their colour.
 */
export function pondTint(p: PondInfo, life: LifeInfo, effectOf: (species: number) => string | undefined): PondTint {
  if (!p.salt) return 'fresh';
  const cx = (p.x0 + p.x1) / 2;
  const cz = (p.z0 + p.z1) / 2;
  const island = life.islands.find((i) => cx >= i.bbox[0] && cx <= i.bbox[2] && cz >= i.bbox[1] && cz <= i.bbox[3]);
  if (!island) return 'salt';
  let tint: PondTint = 'salt';
  for (const pop of life.pops) {
    if (pop.island !== island.id || pop.n <= 0) continue;
    const effect = effectOf(pop.species);
    if (effect === 'pink-pond') return 'pink';
    if (effect === 'red-pond') tint = 'red';
  }
  return tint;
}

/** Where a pond's water is: a column rectangle and 255 for every column the water reaches. */
export interface PondBasin {
  i0: number;
  k0: number;
  w: number;
  h: number;
  data: Uint8Array;
  /** Columns under water. */
  wet: number;
}

/** Scratch space for fillBasin, grown when needed (a refill can run often while lava flows nearby). */
let fillStack = new Int32Array(0);
let fillNear = new Uint8Array(0);

/**
 * Fill a pond's basin: from the columns of its own pond squares (habitat Pond or SaltPond) that lie
 * below the water, spread to every connected column below the water inside the pond's box (plus a
 * little slack), but never more than one life square past the pond's own squares, so water can't
 * run down a slope that happens to be lower than the pond. Without pond squares yet (the life map
 * can lag a moment), start from the lowest column near the middle of the box.
 */
export function fillBasin(p: PondInfo, surf: Float32Array, habitat: Uint8Array, out?: PondBasin): PondBasin {
  const i0 = Math.max(0, Math.floor((p.x0 - ORIGIN_X) / CELL) - MARGIN_COLS);
  const k0 = Math.max(0, Math.floor((p.z0 - ORIGIN_Z) / CELL) - MARGIN_COLS);
  const i1 = Math.min(NX - 1, Math.floor((p.x1 - ORIGIN_X) / CELL) + MARGIN_COLS);
  const k1 = Math.min(NZ - 1, Math.floor((p.z1 - ORIGIN_Z) / CELL) + MARGIN_COLS);
  const w = Math.max(1, i1 - i0 + 1);
  const h = Math.max(1, k1 - k0 + 1);
  const basin: PondBasin = out && out.w === w && out.h === h ? out : { i0, k0, w, h, data: new Uint8Array(w * h), wet: 0 };
  basin.i0 = i0;
  basin.k0 = k0;
  basin.data.fill(0);
  if (fillStack.length < w * h) {
    fillStack = new Int32Array(w * h);
    fillNear = new Uint8Array(w * h);
  }
  const stack = fillStack;
  // Columns the water may reach: next to a pond square (all of them until the life map has some).
  const near = fillNear;
  near.fill(0, 0, w * h);
  const isPond = (pi: number, pk: number): boolean => {
    if (pi < 0 || pk < 0 || pi >= NP || pk >= NP) return false;
    const hab = habitat[pi + pk * NP];
    return hab === Habitat.Pond || hab === Habitat.SaltPond;
  };
  let seeded = false;
  for (let k = 0; k < h; k++) {
    for (let i = 0; i < w; i++) {
      const pi = ((i0 + i) / PATCH) | 0;
      const pk = ((k0 + k) / PATCH) | 0;
      if (isPond(pi, pk)) seeded = true;
      for (let dk = -1; dk <= 1 && !near[i + k * w]; dk++) for (let di = -1; di <= 1; di++) if (isPond(pi + di, pk + dk)) near[i + k * w] = 1;
    }
  }
  if (!seeded) near.fill(1, 0, w * h);
  let top = 0;
  const push = (i: number, k: number): void => {
    const o = i + k * w;
    if (basin.data[o] || !near[o] || surf[i0 + i + (k0 + k) * NX] >= p.level) return;
    basin.data[o] = 255;
    stack[top++] = o;
  };
  for (let k = 0; k < h && seeded; k++) {
    for (let i = 0; i < w; i++) if (isPond(((i0 + i) / PATCH) | 0, ((k0 + k) / PATCH) | 0)) push(i, k);
  }
  if (top === 0) {
    let best = -1;
    let lowest = p.level;
    for (let k = Math.floor(h / 4); k < Math.ceil((h * 3) / 4); k++) {
      for (let i = Math.floor(w / 4); i < Math.ceil((w * 3) / 4); i++) {
        const v = surf[i0 + i + (k0 + k) * NX];
        if (v < lowest) {
          lowest = v;
          best = i + k * w;
        }
      }
    }
    if (best >= 0) push(best % w, (best / w) | 0);
  }
  let wet = 0;
  while (top > 0) {
    const o = stack[--top];
    wet++;
    const i = o % w;
    const k = (o / w) | 0;
    if (i > 0) push(i - 1, k);
    if (i < w - 1) push(i + 1, k);
    if (k > 0) push(i, k - 1);
    if (k < h - 1) push(i, k + 1);
  }
  basin.wet = wet;
  return basin;
}

const VERTEX = /* glsl */ `
varying vec3 vWorld;
varying float vViewDepth;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec4 v = viewMatrix * w;
  vWorld = w.xyz;
  vViewDepth = -v.z;
  gl_Position = projectionMatrix * v;
}
`;

const FRAGMENT = /* glsl */ `
${WORLD_UNIFORMS_GLSL}
${HEIGHT_GLSL}
${HASH_GLSL}
${WAVE_GLSL}
uniform float uLevel;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uMilk;
uniform vec3 uRim;
uniform sampler2D uBasin;
uniform vec4 uBasinRect;   // first column, first row, columns, rows
varying vec3 vWorld;
varying float vViewDepth;
void main() {
  vec2 t = tgTexelPos(vWorld.xz);
  float inBasin = texture(uBasin, (t - uBasinRect.xy + 0.5) / uBasinRect.zw).r;
  float depth = uLevel - tgHeight(vWorld.xz);
  if (depth <= 0.0 || inBasin < 0.02) discard;
  vec2 p = vWorld.xz;
  float time = uTime;
  // Small wind ripples (lighting only), livelier in wind and storms, calmer far away (no shimmer).
  float wind = (0.35 + length(uWind.xy) + 0.8 * uStorm) * (1.0 - smoothstep(25.0, 90.0, vViewDepth));
  vec2 rip = vec2(
    tgWave(p.x * 1.7 + p.y * 0.6 + time * 0.6) + 0.6 * tgWave(p.y * 2.3 - p.x * 0.9 - time * 0.45),
    tgWave(p.y * 1.9 - p.x * 0.7 + time * 0.55) + 0.6 * tgWave(p.x * 2.1 + p.y * 1.1 + time * 0.4)
  ) - 0.8;
  vec3 n = vec3(rip.x * 0.08 * wind, 1.0, rip.y * 0.08 * wind);
  // Rain rings: in each 0.8 m cell a drop lands now and then and a ring spreads and fades.
  float ring = 0.0;
  if (uRain > 0.0 && vViewDepth < 70.0) {
    vec2 cp = p / 0.8;
    vec2 cell = floor(cp);
    vec4 h = tgHash4(ivec2(cell));
    float age = fract(time * 0.9 + h.x);
    vec2 d = (cp - cell - 0.25 - h.yz * 0.5) * 0.8;
    float r = length(d);
    float band = 1.0 - smoothstep(0.0, 0.035, abs(r - age * 0.35));
    ring = band * (1.0 - age) * step(h.w, uRain) * (1.0 - smoothstep(40.0, 70.0, vViewDepth));
    n.xz += d / max(r, 1e-3) * ring * 0.5;
  }
  n = normalize(n);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  // Body colour: clear and bright in the shallows, richer where deeper; lit by sky and sun.
  vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 2.5, depth));
  vec3 col = body * (uSkyColor * 0.5 + uSunColor * (0.25 + 0.6 * max(uSunDir.y, 0.0)));
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uFogColor, uSkyColor, clamp(R.y * 1.5, 0.0, 1.0)) * (1.0 - 0.6 * uNight);
  col = mix(col, sky, fres * 0.75);
  float rs = max(dot(R, uSunDir), 0.0);
  col += uSunColor * (pow(rs, 400.0) * 2.5 + pow(rs, 40.0) * 0.12) * (1.0 - 0.8 * uNight);
  col += vec3(ring * 0.25);
  // See-through at the edge, more solid with depth; milky salt water goes solid sooner.
  float alpha = mix(1.0 - exp(-depth * 1.3), 1.0 - exp(-depth * 4.0), uMilk);
  alpha = max(alpha, fres * 0.6) * smoothstep(0.0, 0.05, depth);
  // A thin bright line where the water meets the bank.
  float rim = 1.0 - smoothstep(0.0, 0.07, depth);
  col = mix(col, uRim, rim * 0.45);
  alpha = max(alpha, rim * 0.5 * smoothstep(0.0, 0.015, depth));
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <colorspace_fragment>
  // The same fog as the land (three's convention: mixed after the colour-space step).
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, smoothstep(uFogNear, uFogFar, vViewDepth));
}
`;

interface Pond {
  info: PondInfo;
  tint: PondTint;
  basin: PondBasin;
  basinTex: THREE.DataTexture;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  /** The land under it changed: fill the basin again. */
  dirty: boolean;
}

function setColor(v: THREE.Vector3, hex: number): void {
  const [r, g, b] = linear(hex);
  v.set(r, g, b);
}

function basinTexture(b: PondBasin): THREE.DataTexture {
  const tex = new THREE.DataTexture(b.data, b.w, b.h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export function createPonds(deps: SystemDeps): PageSystem {
  const { scene, u, species, fields } = deps;
  const plane = new THREE.PlaneGeometry(1, 1);
  plane.rotateX(-Math.PI / 2);
  plane.translate(0.5, 0, 0.5); // corner at the origin: scaled to cover the basin's columns
  const ponds = new Map<number, Pond>();
  /** Some pond needs its basin filled again. */
  let anyDirty = false;
  const effectOf = (id: number): string | undefined => species[id]?.effect;

  // Reshaped land under a pond: refill its basin on the next frame.
  const onCols = (x0: number, z0: number, w: number, h: number): void => {
    for (const pond of ponds.values()) {
      const b = pond.basin;
      if (x0 <= b.i0 + b.w && x0 + w >= b.i0 && z0 <= b.k0 + b.h && z0 + h >= b.k0) {
        pond.dirty = true;
        anyDirty = true;
      }
    }
  };
  fields.onCols.push(onCols);
  // New pond squares on the life map: they seed the fill, so refill the ponds they touch.
  const onEco = (x0: number, z0: number, w: number, h: number): void => onCols(x0 * PATCH, z0 * PATCH, w * PATCH, h * PATCH);
  fields.onEco.push(onEco);

  const makeMaterial = (uniforms: WorldUniforms, tex: THREE.DataTexture): THREE.ShaderMaterial =>
    new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        uLevel: { value: 0 },
        uShallow: { value: new THREE.Vector3() },
        uDeep: { value: new THREE.Vector3() },
        uMilk: { value: 0 },
        uRim: { value: new THREE.Vector3(...linear(POND.rim)) },
        uBasin: { value: tex },
        uBasinRect: { value: new THREE.Vector4() },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
    });

  /** Fit the mesh and the shader to the pond's basin. */
  const fit = (pond: Pond): void => {
    const b = pond.basin;
    (pond.material.uniforms.uBasinRect.value as THREE.Vector4).set(b.i0, b.k0, b.w, b.h);
    pond.mesh.position.set(ORIGIN_X + b.i0 * CELL, pond.info.level, ORIGIN_Z + b.k0 * CELL);
    pond.mesh.scale.set(b.w * CELL, 1, b.h * CELL);
    pond.mesh.updateMatrix();
    pond.mesh.visible = b.wet > 0;
  };

  /** Fill the basin again (the land or the pond changed). */
  const refill = (pond: Pond): void => {
    pond.dirty = false;
    const before = pond.basin;
    pond.basin = fillBasin(pond.info, fields.surf, fields.habitat, before);
    if (pond.basin !== before) {
      pond.basinTex.dispose();
      pond.basinTex = basinTexture(pond.basin);
      pond.material.uniforms.uBasin.value = pond.basinTex;
    } else {
      pond.basinTex.needsUpdate = true;
    }
    fit(pond);
  };

  const restyle = (pond: Pond): void => {
    pond.material.uniforms.uLevel.value = pond.info.level;
    const t = TINTS[pond.tint];
    setColor(pond.material.uniforms.uShallow.value as THREE.Vector3, t.shallow);
    setColor(pond.material.uniforms.uDeep.value as THREE.Vector3, t.deep);
    pond.material.uniforms.uMilk.value = t.milk;
  };

  const remove = (id: number): void => {
    const pond = ponds.get(id);
    if (!pond) return;
    scene.remove(pond.mesh);
    pond.material.dispose();
    pond.basinTex.dispose();
    ponds.delete(id);
  };

  const sync = (life: LifeInfo): void => {
    const seen = new Set<number>();
    for (const info of life.ponds) {
      seen.add(info.id);
      let pond = ponds.get(info.id);
      if (!pond) {
        const basin = fillBasin(info, fields.surf, fields.habitat);
        const basinTex = basinTexture(basin);
        const material = makeMaterial(u, basinTex);
        const mesh = new THREE.Mesh(plane, material);
        mesh.name = 'pond';
        mesh.matrixAutoUpdate = false;
        // Drawn after the sea (ponds sit above it, and both are see-through).
        mesh.renderOrder = 2;
        scene.add(mesh);
        pond = { info, tint: pondTint(info, life, effectOf), basin, basinTex, mesh, material, dirty: false };
        ponds.set(info.id, pond);
        fit(pond);
      } else {
        pond.info = info;
        pond.tint = pondTint(info, life, effectOf);
        pond.dirty = true;
        anyDirty = true;
      }
      restyle(pond);
    }
    for (const id of [...ponds.keys()]) if (!seen.has(id)) remove(id);
  };

  return {
    name: 'ponds',
    onEngine(m: FromEngine) {
      if (m.t === 'life') sync(m.life);
      else if (m.t === 'clear') for (const id of [...ponds.keys()]) remove(id);
    },
    update(f: FrameCtx) {
      void f;
      if (!anyDirty) return;
      anyDirty = false;
      for (const pond of ponds.values()) if (pond.dirty) refill(pond);
    },
    dispose() {
      const i = fields.onCols.indexOf(onCols);
      if (i >= 0) fields.onCols.splice(i, 1);
      const j = fields.onEco.indexOf(onEco);
      if (j >= 0) fields.onEco.splice(j, 1);
      for (const id of [...ponds.keys()]) remove(id);
      plane.dispose();
    },
  };
}
