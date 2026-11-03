/**
 * The garden's models (the rules are in game/garden.ts): the growing plants,
 * the terracotta pots for the cabin-top trays, the driftwood raised bed, the
 * rain barrel and the "Home garden" sign. All made and painted in code, in
 * the finds' rounded, warm style (DECISIONS 13 and 14).
 *
 *   new PlantView(size)  one crop at any stage of growth, thirsty or not, ripe
 *                        or not, swaying gently: 'pot' is one plant in a pot,
 *                        'bed' a bed's worth (see gardenPlants.ts). At most two
 *                        draw calls and about 1,500 triangles fully grown.
 *   potModel()           a 28 x 24 cm terracotta pot of dark soil (POT).
 *   bedModel()           a 1.7 x 0.9 m driftwood-plank bed, 30 cm high (BED).
 *   barrelModel()        an old rum barrel under a tarp funnel, its water
 *                        rising with setLevel(0..1).
 *   signModel(text)      a driftwood board on a post, lettered in paint.
 *
 * Every model's origin is the middle of its base, where it stands, +Y up.
 * Pots, beds, barrels and signs share their geometry and materials; plants
 * share materials (and one breeze clock, set by any PlantView's update).
 */
import * as THREE from 'three';
import { TAU, clamp, fbm, lin, mix, mixC, mulC, noise, smooth, type C3, type V3 } from './finds';
import { BED, CROP_KINDS, Mesher, POT, buildPlant, lump, tubeAlong, type CropKind, type PlantSize } from './gardenPlants';
import { WOOD_BAND, grainAt, leafAtlas, soilTex, spangleTex, streamTex, terracottaTex, woodTex } from './gardenPaint';
import { mulberry32 } from '../engine/noise';

export { BED, CROP_KINDS, POT, type CropKind, type PlantSize };

/** Growth is shown in this many steps (0, 0.25, 0.5, 0.75, 1). */
export const PLANT_STAGES = 5;
/** Thirst is shown in this many steps. */
export const THIRST_STEPS = 5;

/** Height of the soil above the base of a pot (at scale 1) and of a bed, for standing plants on it. */
export const GARDEN_SOIL = { pot: POT.soil, bed: BED.soil };

/**
 * The sloop's pot spots are 24 cm apart, two to a tray, so 28 cm pots would
 * overlap: on the boat use pots at this scale (22 cm across), with the soil
 * at GARDEN_SOIL.pot * DECK_POT_SCALE and the plant's group scaled the same.
 */
export const DECK_POT_SCALE = 0.8;

const C = (hex: number): C3 => lin(hex);

// ---------------------------------------------------------------------------
// Materials: a gentle breeze in the vertex shader, and yellowing when thirsty
// ---------------------------------------------------------------------------

/** The breeze clock shared by every plant (seconds). */
const breeze = { value: 0 };

function swaying<M extends THREE.MeshStandardMaterial>(m: M, yellowing: boolean): M {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uGardenTime = breeze;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uGardenTime;
attribute float sway;
${yellowing ? 'attribute float yellow;\nvarying float vYellow;' : ''}`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 o = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float ph = o.x * 1.7 + o.z * 1.3;
  float t = uGardenTime;
  float q = position.x * 9.0 + position.z * 7.0 + position.y * 5.0;
  transformed.x += sway * (sin(t * 1.6 + ph + position.y * 3.0) * 0.7 + sin(t * 4.1 + q) * 0.3);
  transformed.z += sway * (cos(t * 1.25 + ph * 1.3 + position.y * 2.0) * 0.6 + sin(t * 3.7 + q * 1.3) * 0.3);
  transformed.y += sway * sin(t * 2.9 + q) * 0.25;
}
${yellowing ? 'vYellow = yellow;' : ''}`,
      );
    if (yellowing) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vYellow;').replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  // thirsty leaves fade to straw yellow, browning at the tips
  float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  vec3 straw = lum * vec3(2.3, 1.85, 0.5) * (1.0 - 0.45 * smoothstep(0.75, 1.0, vYellow));
  diffuseColor.rgb = mix(diffuseColor.rgb, straw, smoothstep(0.0, 1.0, vYellow));
}`,
      );
    }
  };
  m.customProgramCacheKey = () => (yellowing ? 'garden-sway-yellow' : 'garden-sway');
  return m;
}

const mats = new Map<string, THREE.Material>();
function mat<M extends THREE.Material>(key: string, make: () => M): M {
  let m = mats.get(key) as M | undefined;
  if (!m) {
    m = make();
    m.name = `garden:${key}`;
    mats.set(key, m);
  }
  return m;
}

const FOLIAGE_ROUGH: Record<CropKind, number> = { callaloo: 0.55, tomato: 0.78, sweetpotato: 0.62 };
const FRUIT_ROUGH: Record<CropKind, number> = { callaloo: 0.6, tomato: 0.3, sweetpotato: 0.7 };

/** Leaves, flowers and stems: the leaf atlas, alpha-tested, both sides. */
function foliageMat(crop: CropKind): THREE.MeshStandardMaterial {
  return mat(`foliage-${crop}`, () =>
    swaying(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: leafAtlas(),
        alphaTest: 0.5,
        alphaToCoverage: true,
        side: THREE.DoubleSide,
        roughness: FOLIAGE_ROUGH[crop],
        metalness: 0,
      }),
      true,
    ),
  );
}
/** Tomatoes, the stake and its ties, tubers: smooth vertex colours. */
function fruitMat(crop: CropKind): THREE.MeshStandardMaterial {
  return mat(`fruit-${crop}`, () => swaying(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: FRUIT_ROUGH[crop], metalness: 0 }), false));
}
const soilMat = (): THREE.MeshStandardMaterial => mat('soil', () => new THREE.MeshStandardMaterial({ vertexColors: true, map: soilTex(), roughness: 1, metalness: 0 }));
const clayMat = (): THREE.MeshStandardMaterial =>
  mat('clay', () => new THREE.MeshStandardMaterial({ vertexColors: true, map: terracottaTex(), roughness: 0.9, metalness: 0 }));
/** Driftwood, rusty iron and tarp (the wood texture's three bands), tinted by vertex colours. */
const woodMat = (): THREE.MeshStandardMaterial => mat('wood', () => new THREE.MeshStandardMaterial({ vertexColors: true, map: woodTex(), roughness: 0.88, metalness: 0 }));

const band = (b: readonly [number, number], w: number): number => mix(b[0], b[1], clamp(w, 0, 1));

function meshOf(m: Mesher, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(m.geometry(), material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.dry = true;
  return mesh;
}

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

let plantsMade = 0;

/**
 * A crop growing in a pot or a bed. `set` it every frame if you like: the
 * geometry is only rebuilt (a millisecond or two) when the crop, the growth
 * step, the thirst step or ripeness changes. Put `group` at the soil's
 * surface (GARDEN_SOIL above the pot's or bed's base), turned like its bed.
 */
export class PlantView {
  readonly group = new THREE.Group();
  readonly size: PlantSize;
  private readonly seed: number;
  private readonly leaves: THREE.Mesh;
  private readonly fruit: THREE.Mesh;
  private key = '';

  /** `seed` varies the details (which way leaves face, red or green callaloo); by default each plant differs. */
  constructor(size: PlantSize = 'pot', seed?: number) {
    this.size = size;
    this.seed = seed ?? ++plantsMade;
    this.leaves = new THREE.Mesh(new THREE.BufferGeometry(), foliageMat('callaloo'));
    this.fruit = new THREE.Mesh(new THREE.BufferGeometry(), fruitMat('callaloo'));
    for (const m of [this.leaves, this.fruit]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.dry = true;
      m.visible = false;
      this.group.add(m);
    }
    this.leaves.name = 'plant-leaves';
    this.fruit.name = 'plant-fruit';
    this.group.name = `plant-${size}`;
  }

  /**
   * What grows here: a crop (or null for bare soil, nothing drawn), its
   * growth 0..1 (shown in PLANT_STAGES steps), how thirsty it is 0..1
   * (leaves droop and yellow) and whether it's ripe (red tomatoes, the
   * callaloo's plume, sweet potatoes showing).
   */
  set(crop: CropKind | null, growth: number, thirsty: number, ripe: boolean): void {
    const fin = (x: number): number => (Number.isFinite(x) ? clamp(x, 0, 1) : 0);
    const stage = Math.round(fin(growth) * (PLANT_STAGES - 1));
    const thirst = Math.round(fin(thirsty) * (THIRST_STEPS - 1));
    const key = crop ? `${crop}|${stage}|${thirst}|${ripe ? 1 : 0}` : '';
    if (key === this.key) return;
    this.key = key;
    if (!crop) {
      this.swap(this.leaves, null, null);
      this.swap(this.fruit, null, null);
      return;
    }
    const b = buildPlant(crop, this.size, stage / (PLANT_STAGES - 1), thirst / (THIRST_STEPS - 1), ripe, this.seed);
    this.swap(this.leaves, b.leaves, foliageMat(crop));
    this.swap(this.fruit, b.fruit, fruitMat(crop));
  }

  /** The breeze: call every frame with the clock in seconds. */
  update(time: number): void {
    breeze.value = time;
  }

  /** Triangles drawn now. */
  get triangles(): number {
    let n = 0;
    for (const m of [this.leaves, this.fruit]) if (m.visible && m.geometry.index) n += m.geometry.index.count / 3;
    return n;
  }

  /** Draw calls now (0, 1 or 2). */
  get drawCalls(): number {
    return (this.leaves.visible ? 1 : 0) + (this.fruit.visible ? 1 : 0);
  }

  dispose(): void {
    this.leaves.geometry.dispose();
    this.fruit.geometry.dispose();
  }

  private swap(mesh: THREE.Mesh, m: Mesher | null, material: THREE.Material | null): void {
    mesh.geometry.dispose();
    if (!m || m.triangles === 0 || !material) {
      mesh.geometry = new THREE.BufferGeometry();
      mesh.visible = false;
      return;
    }
    mesh.geometry = m.geometry();
    mesh.material = material;
    mesh.visible = true;
  }
}

// ---------------------------------------------------------------------------
// The terracotta pot
// ---------------------------------------------------------------------------

/** The pot's profile: radius, height, and v up the texture (0 = foot, 0.82..0.95 the rim band, 1 the inside). */
const POT_PROFILE: [number, number, number][] = [
  [0, 0.002, 0],
  [0.092, 0.0, 0.01],
  [0.098, 0.004, 0.02],
  [0.1, 0.014, 0.05],
  [0.11, 0.095, 0.4],
  [0.124, 0.185, 0.78],
  [0.127, 0.194, 0.81],
  [0.135, 0.197, 0.83],
  [0.141, 0.201, 0.85],
  [0.143, 0.212, 0.88],
  [0.143, 0.228, 0.92],
  [0.141, 0.236, 0.94],
  [0.136, 0.24, 0.955],
  [0.131, 0.239, 0.965],
  [0.128, 0.235, 0.975],
  [0.1265, 0.222, 0.985],
  [0.125, POT.soil - 0.004, 1],
];

const potCache = new Map<number, THREE.BufferGeometry[]>();

function buildPot(): THREE.BufferGeometry[] {
  const clay = new Mesher();
  const nu = 24;
  const prof = POT_PROFILE;
  clay.grid(
    nu,
    prof.length - 1,
    (i, j) => {
      const [r, y, v] = prof[j];
      const a = (-TAU * i) / nu;
      // a little wobble: hand-thrown, not machined
      const wob = 1 + 0.006 * Math.sin(a * 3 + 1) * smooth(0.02, 0.1, y);
      const inside = v > 0.97 ? 0.62 : v > 0.955 ? 0.85 : 1;
      const top = v > 0.93 && v < 0.97 ? 1.06 : 1;
      return { p: [r * wob * Math.cos(a), y, r * wob * Math.sin(a)], c: [inside * top, inside * top, inside * top], uv: [i / nu, v], n: [0, -1, 0] };
    },
    true,
  );
  const soil = new Mesher();
  const rings = [0, 0.05, 0.095, 0.1275];
  soil.grid(
    nu,
    rings.length - 1,
    (i, j) => {
      const r = rings[j];
      const a = (TAU * i) / nu;
      const x = r * Math.cos(a);
      const z = r * Math.sin(a);
      const rel = r / 0.1275;
      const y = POT.soil + 0.006 * (1 - rel * rel) + 0.0025 * (noise(x * 60 + 5, z * 60, 7) - 0.5) - 0.003 * smooth(0.85, 1, rel);
      // in the rim's shadow toward the edge
      const k = (1 - 0.35 * smooth(0.6, 1, rel)) * (0.9 + 0.2 * noise(x * 25, z * 25, 9));
      return { p: [x, y, z], c: [k, k, k], uv: [x / 0.22 + 0.5, z / 0.22 + 0.5], n: [0, 1, 0] };
    },
    true,
  );
  return [clay.geometry(), soil.geometry()];
}

/**
 * A terracotta pot of dark soil: 28 cm across the rim and 24 cm tall at
 * scale 1 (POT), the soil POT.soil above the base. Origin at the middle of
 * its base. Two draw calls. For a smaller pot pass a scale (and scale the
 * plant and its soil height to match).
 */
export function potModel(scale = 1): THREE.Group {
  let geos = potCache.get(scale);
  if (!geos) {
    geos = buildPot();
    if (scale !== 1) for (const g of geos) g.scale(scale, scale, scale);
    potCache.set(scale, geos);
  }
  const g = new THREE.Group();
  g.name = 'pot';
  for (const [geo, m, name] of [
    [geos[0], clayMat(), 'pot-clay'],
    [geos[1], soilMat(), 'pot-soil'],
  ] as [THREE.BufferGeometry, THREE.Material, string][]) {
    const mesh = new THREE.Mesh(geo, m);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  g.userData.soil = POT.soil * scale;
  return g;
}

// ---------------------------------------------------------------------------
// The raised bed
// ---------------------------------------------------------------------------

/** A weathered driftwood plank as a rounded box, `length` along `axis` ('x' or 'z'), bowed and uneven. */
function plank(m: Mesher, centre: V3, axis: 'x' | 'z', length: number, height: number, thick: number, rng: () => number, tint: C3, damp: number): void {
  const T = thick / 2;
  const Hh = height / 2;
  const c = 0.006;
  // cross-section points (thickness, height), going round
  const cs: [number, number][] = [
    [T, -Hh + c],
    [T, 0],
    [T, Hh - c],
    [T - c, Hh],
    [0, Hh],
    [-T + c, Hh],
    [-T, Hh - c],
    [-T, 0],
    [-T, -Hh + c],
    [-T + c, -Hh],
    [0, -Hh],
    [T - c, -Hh],
  ];
  const per: number[] = [0];
  for (let k = 1; k <= cs.length; k++) {
    const a = cs[k - 1];
    const b = cs[k % cs.length];
    per.push(per[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L2 = length / 2;
  const along = [-L2, -L2 * 0.5, 0, L2 * 0.5, L2];
  const bow = (rng() - 0.5) * 0.012;
  const seed = rng() * 100;
  const endCut = [(rng() - 0.5) * 0.01, (rng() - 0.5) * 0.01];
  const u0 = rng();
  // (mirrored across for planks along x, so the faces still point outward)
  const toWorld = (a: number, t: number, h: number): V3 => (axis === 'x' ? [centre[0] + a, centre[1] + h, centre[2] - t] : [centre[0] + t, centre[1] + h, centre[2] + a]);
  const rows = along.length + 2;
  m.grid(
    cs.length,
    rows - 1,
    (i, j) => {
      const k = i % cs.length;
      const [t0, h0] = cs[k];
      // the end caps are poles in the middle of each end
      const cap = j === 0 || j === rows - 1;
      const jj = clamp(j - 1, 0, along.length - 1);
      let a = along[jj];
      const f = a / L2;
      if (j === 1) a += endCut[0] * (h0 / Hh);
      if (j === rows - 2) a += endCut[1] * (h0 / Hh);
      const b = bow * (1 - f * f);
      const top = h0 > 0 ? 0.004 * (noise(a * 6, 1, seed) - 0.5) * 2 : 0;
      const t = cap ? b : t0 + b;
      const h = cap ? 0 : h0 + top;
      const aa = cap ? (j === 0 ? -L2 : L2) : a;
      const w = per[i] / per[cs.length];
      const low = smooth(0.2, -1, (centre[1] + h - Hh) / height) * damp;
      let col = mulC(tint, 0.9 + 0.2 * noise(aa * 3, w * 4, seed + 1));
      col = mixC(col, mulC(tint, 0.62), low);
      // rust where old nails were, near the ends
      const nail = smooth(0.06, 0.0, Math.abs(Math.abs(aa) - (L2 - 0.05))) * smooth(0.5, 0.2, Math.abs(h / Hh)) * (t0 > 0 ? 1 : 0);
      col = mixC(col, C(0x6a3a22), nail * 0.5);
      const axisN: V3 = axis === 'x' ? [j === 0 ? -1 : 1, 0, 0] : [0, 0, j === 0 ? -1 : 1];
      return { p: toWorld(aa, t, h), c: col, uv: [u0 + aa / 0.7, band(WOOD_BAND.grain, w)], n: axisN };
    },
    true,
  );
}

let bedCache: THREE.BufferGeometry[] | null = null;

function buildBed(): THREE.BufferGeometry[] {
  const rng = mulberry32(4051);
  const wood = new Mesher();
  const { length: BL, width: BW, height: BH, plank: PT } = BED;
  const ph = BH / 2;
  const tints = [C(0xb3a794), C(0xa59683), C(0xbab09f), C(0xa39584), C(0xb59f83), C(0xab9f8e), C(0xb6ab99), C(0x9e9282)];
  let n = 0;
  for (const s of [-1, 1]) {
    for (let r = 0; r < 2; r++) {
      const y = ph * r + ph / 2;
      plank(wood, [0, y, s * (BW / 2 - PT / 2)], 'x', BL + 0.01 * (rng() - 0.5), ph - 0.004, PT, rng, tints[n++ % tints.length], r === 0 ? 1 : 0.3);
      plank(wood, [s * (BL / 2 - PT / 2), y, 0], 'z', BW - 2 * PT - 0.002, ph - 0.004, PT * 0.95, rng, tints[n++ % tints.length], r === 0 ? 1 : 0.3);
    }
  }
  // stakes in the corners, inside, holding the planks together
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (BL / 2 - PT - 0.025);
      const z = sz * (BW / 2 - PT - 0.025);
      const top = BH + 0.035 + 0.02 * rng();
      const pts: V3[] = [];
      for (let k = 0; k <= 4; k++) pts.push([x + 0.004 * Math.sin(k * 1.7 + x * 9), (top + 0.001) * (k / 4) - 0.001, z + 0.004 * Math.cos(k * 1.3 + z * 7)]);
      pts.push([pts[4][0], top + 0.012, pts[4][2]]);
      const seed = rng() * 10;
      tubeAlong(wood, pts, {
        nu: 6,
        r: (t) => (t > 0.999 ? 0 : t > 0.95 ? 0.022 * Math.sqrt(1 - ((t - 0.95) / 0.05) ** 2 * 0.85) : 0.023),
        col: (t, a) => mulC(C(0xa59c8f), 0.85 + 0.2 * noise(t * 6, a, seed) - 0.15 * smooth(0.3, 0, t)),
        uv: (t, a) => [t * 0.6, band(WOOD_BAND.grain, a / TAU)],
      });
    }
  }
  // the soil, a little heaped up along the middle
  const soil = new Mesher();
  const hx = BL / 2 - PT + 0.004;
  const hz = BW / 2 - PT + 0.004;
  soil.grid(20, 10, (i, j) => {
    const x = -hx + (2 * hx * i) / 20;
    const z = hz - (2 * hz * j) / 10;
    const ex = Math.abs(x) / hx;
    const ez = Math.abs(z) / hz;
    const edge = Math.max(ex, ez);
    const y = BED.soil + 0.004 * (1 - ez * ez) + 0.006 * (fbm(x * 5, z * 5, 13, 3) - 0.5) - 0.006 * smooth(0.9, 1, edge);
    const k = 0.72 * (1 - 0.3 * smooth(0.8, 1, edge)) * (0.85 + 0.3 * fbm(x * 2 + 4, z * 2, 17, 2));
    return { p: [x, y, z], c: [k * 0.95, k * 0.95, k], uv: [x / 0.45, z / 0.45], n: [0, 1, 0] };
  });
  return [wood.geometry(), soil.geometry()];
}

/**
 * A raised bed: a frame of silvered driftwood planks, 1.7 m long (x) by
 * 0.9 m wide (z) and 30 cm high, full of dark soil BED.soil above the base.
 * Origin at the middle of its base. Two draw calls.
 */
export function bedModel(): THREE.Group {
  bedCache ??= buildBed();
  const g = new THREE.Group();
  g.name = 'bed';
  const wood = new THREE.Mesh(bedCache[0], woodMat());
  wood.name = 'bed-wood';
  const soil = new THREE.Mesh(bedCache[1], soilMat());
  soil.name = 'bed-soil';
  for (const m of [wood, soil]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.dry = true;
    g.add(m);
  }
  g.userData.soil = BED.soil;
  return g;
}

// ---------------------------------------------------------------------------
// The rain barrel
// ---------------------------------------------------------------------------

/** The barrel's size: height, radius at the ends and at the middle (the bilge), stave thickness. */
export const BARREL = { height: 0.86, end: 0.235, bilge: 0.272, stave: 0.022, floor: 0.05 };
const barrelR = (y: number): number => {
  const e = (y - BARREL.height / 2) / (BARREL.height / 2);
  return BARREL.end + (BARREL.bilge - BARREL.end) * (1 - e * e);
};
/** Where the water's surface is at level 0 and at level 1 (height above the base). */
const WATER_Y = [BARREL.floor + 0.01, BARREL.height - 0.11];

let barrelCache: THREE.BufferGeometry | null = null;

function buildBarrel(): THREE.BufferGeometry {
  const rng = mulberry32(777);
  const m = new Mesher();
  const H = BARREL.height;
  const ST = BARREL.stave;
  const N = 16;
  // ---- the staves: outside up, over the top, inside down ----
  const outY = [0, 0.06, 0.16, 0.3, 0.43, 0.56, 0.7, 0.8, H];
  const inY = [H - 0.004, 0.62, 0.35, BARREL.floor + 0.004];
  for (let k = 0; k < N; k++) {
    const a0 = (TAU * k) / N;
    const a1 = (TAU * (k + 1)) / N;
    const shade = 0.82 + 0.3 * rng();
    const grey = rng();
    const tint = mixC(mulC(C(0x8a6a4c), shade), mulC(C(0x8c867c), shade), 0.25 + 0.45 * grey);
    const u0 = rng() * 3;
    const lift = 0.004 * (rng() - 0.5);
    type Row = { y: number; inner: boolean };
    const rows: Row[] = [...outY.map((y) => ({ y: y === H ? H + lift : y, inner: false })), ...inY.map((y) => ({ y, inner: true }))];
    m.grid(2, rows.length - 1, (i, j) => {
      const a = -mix(a0, a1, i / 2);
      const { y, inner } = rows[j];
      const r = inner ? barrelR(y) - ST : barrelR(Math.min(y, H));
      // damp and a little green low down outside; dark and wet inside
      let col = tint;
      if (!inner) col = mixC(col, mulC(C(0x5d5c3c), shade), smooth(0.14, 0.0, y) * 0.7);
      else col = mulC(col, 0.22 + 0.2 * smooth(0.3, H, y));
      const v = band(WOOD_BAND.grain, inner ? 1 - i / 2 : i / 2);
      return { p: [r * Math.cos(a), y, r * Math.sin(a)], c: col, uv: [u0 + y * 1.4, v], n: [0, 1, 0] };
    });
  }
  // the floor inside
  m.grid(N * 2, 1, (i, j) => {
    const a = (TAU * i) / (N * 2);
    const r = j === 0 ? 0 : barrelR(BARREL.floor) - ST + 0.002;
    return { p: [r * Math.cos(a), BARREL.floor, r * Math.sin(a)], c: mulC(C(0x5a4632), 0.5), uv: [r * 3, band(WOOD_BAND.grain, 0.3 + 0.4 * Math.cos(a * 8))], n: [0, 1, 0] };
  }, true);
  // ---- iron hoops ----
  for (const hy of [0.07, 0.25, 0.61, 0.79]) {
    const hw = 0.045;
    const prof: [number, number][] = [
      [hy - hw / 2, 0],
      [hy - hw / 2 + 0.001, 0.0045],
      [hy + hw / 2 - 0.001, 0.0045],
      [hy + hw / 2, 0],
    ];
    const nu = 24;
    m.grid(
      nu,
      prof.length - 1,
      (i, j) => {
        const a = (-TAU * i) / nu;
        const [y, out] = prof[j];
        const r = barrelR(y) + out + 0.0005;
        return { p: [r * Math.cos(a), y, r * Math.sin(a)], c: [1, 1, 1], uv: [i / 6, band(WOOD_BAND.iron, j / 3)], n: [0, 1, 0] };
      },
      true,
    );
  }
  // ---- the tarp funnel: tied round under the rim with rope, sagging into a hole in the middle ----
  {
    const ropeY = H - 0.055;
    const rTop = barrelR(H);
    const rRope = barrelR(ropeY) + 0.009;
    // rows: inner hole edge, slope, near the rim, over the rim, down the outside, at the rope, the skirt's edge
    const prof: [number, number][] = [
      [0.13, H - 0.075],
      [0.165, H - 0.05],
      [0.2, H - 0.022],
      [rTop - 0.004, H + 0.006],
      [rTop + 0.01, H - 0.01],
      [rRope, ropeY],
      [rRope + 0.016, ropeY - 0.05],
    ];
    const nu = 30;
    const tie = 6;
    m.grid(
      nu,
      prof.length - 1,
      (i, j) => {
        const a = (TAU * i) / nu;
        let [r, y] = prof[j];
        // sags between the ties at the rim, and the hole's edge is ragged
        const sag = 0.5 - 0.5 * Math.cos(a * tie);
        if (j <= 2) y -= (0.012 + 0.006 * j) * sag * (j === 0 ? 1.4 : 1);
        if (j === 0) r += 0.008 * Math.sin(a * 5 + 1) + 0.005 * Math.sin(a * 11);
        if (j === 6) {
          y += 0.012 * Math.sin(a * 7 + 2) + 0.008 * Math.sin(a * 13);
          r += 0.006 * (0.5 + 0.5 * Math.sin(a * 7 + 2));
        }
        if (j === 4 || j === 5) r += 0.003 * sag;
        const topSide = j <= 3;
        let col = mixC(C(0x48708f), C(0x8aa4b4), smooth(0.45, 0.8, fbm(Math.cos(a) * 2 + 3, Math.sin(a) * 2 + j * 0.3, 21, 3)) * (topSide ? 0.8 : 0.4));
        if (j === 0) col = mulC(col, 0.7);
        col = mixC(col, C(0x6a5a40), smooth(0.65, 0.85, noise(a * 4, j, 23)) * 0.35);
        return { p: [r * Math.cos(a), y, r * Math.sin(a)], c: col, uv: [(i / nu) * 4, band(WOOD_BAND.canvas, j / 6)], n: [0, 1, 0] };
      },
      true,
    );
    // the rope round it, and a knot with two loose ends
    const ring: V3[] = [];
    const rn = 26;
    for (let k = 0; k <= rn; k++) {
      const a = (TAU * k) / rn;
      const r = rRope + 0.003 + 0.002 * (0.5 - 0.5 * Math.cos(a * tie));
      ring.push([r * Math.cos(a), ropeY + 0.002 * Math.sin(a * 3), r * Math.sin(a)]);
    }
    const ropeCol = (t: number, a: number): C3 => mulC(C(0xb9a47c), 0.8 + 0.25 * (0.5 + 0.5 * Math.sin(t * 400 + a)));
    tubeAlong(m, ring, { nu: 4, r: () => 0.0055, col: ropeCol, uv: (t, a) => [t * 30, band(WOOD_BAND.canvas, a / TAU)] });
    const ka = 0.3;
    const knot: V3 = [(rRope + 0.008) * Math.cos(ka), ropeY, (rRope + 0.008) * Math.sin(ka)];
    lump(m, knot, [Math.cos(ka + 1.57), 0.3, Math.sin(ka + 1.57)], 0.03, 6, 4, (t) => 0.011 * Math.sin(Math.PI * t) ** 0.7, () => mulC(C(0xb09a72), 0.9));
    for (const s of [-1, 1]) {
      const pts: V3[] = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        const r = rRope + 0.012 + 0.012 * t;
        const a = ka + s * 0.05 + s * 0.04 * t;
        pts.push([r * Math.cos(a), ropeY - 0.005 - 0.11 * t * (s > 0 ? 1 : 0.8), r * Math.sin(a)]);
      }
      tubeAlong(m, pts, { nu: 4, r: (t) => (t > 0.999 ? 0 : 0.005), col: ropeCol, uv: (t, a) => [t * 6, band(WOOD_BAND.canvas, a / TAU)] });
    }
  }
  // ---- a wooden tap low on the front (+z), with a brass key ----
  {
    const ty = 0.13;
    const r0 = barrelR(ty);
    const pts: V3[] = [
      [0, ty, r0 - 0.005],
      [0, ty, r0 + 0.02],
      [0, ty - 0.004, r0 + 0.05],
      [0, ty - 0.012, r0 + 0.062],
    ];
    tubeAlong(m, pts, { nu: 8, r: (t) => (t > 0.97 ? 0.008 : 0.012 - 0.002 * t), col: (t) => mulC(C(0x7a5a3c), t > 0.95 ? 0.4 : 0.95), uv: (t, a) => [t * 0.2, band(WOOD_BAND.grain, a / TAU)] });
    lump(m, [0, ty + 0.016, r0 + 0.035], [0, 1, 0], 0.024, 6, 4, (t) => 0.007 * Math.sin(Math.PI * t) ** 0.6, () => C(0xb88a3a));
    lump(m, [0, ty + 0.03, r0 + 0.035], [1, 0, 0], 0.03, 6, 4, (t) => 0.005 * Math.sin(Math.PI * t) ** 0.5, () => C(0xc49a48));
  }
  return m.geometry();
}

/**
 * A weathered wooden rum barrel with iron hoops and a wooden tap, a blue
 * tarp tied over the top as a funnel for the rain. The water shows through
 * the hole in the tarp and rises with `setLevel(0..1)` (hidden when empty).
 * About 86 cm tall and 55 cm across. Two draw calls (one when empty).
 */
export function barrelModel(): { group: THREE.Group; setLevel(level: number): void } {
  barrelCache ??= buildBarrel();
  const group = new THREE.Group();
  group.name = 'barrel';
  const body = new THREE.Mesh(barrelCache, woodMat());
  body.name = 'barrel-body';
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.dry = true;
  const water = new THREE.Mesh(
    waterDisc(),
    mat('barrel-water', () => new THREE.MeshStandardMaterial({ color: 0x2b5862, roughness: 0.08, metalness: 0, envMapIntensity: 1.6 })),
  );
  water.name = 'barrel-water';
  water.receiveShadow = true;
  water.userData.dry = true;
  group.add(body, water);
  const setLevel = (level: number): void => {
    const l = Number.isFinite(level) ? clamp(level, 0, 1) : 0;
    const y = mix(WATER_Y[0], WATER_Y[1], l);
    const r = barrelR(y) - BARREL.stave - 0.001;
    water.position.y = y;
    water.scale.set(r, 1, r);
    water.visible = l > 0.005;
  };
  setLevel(0);
  return { group, setLevel };
}

let discGeo: THREE.BufferGeometry | null = null;
function waterDisc(): THREE.BufferGeometry {
  if (!discGeo) {
    discGeo = new THREE.CircleGeometry(1, 32);
    discGeo.rotateX(-Math.PI / 2);
  }
  return discGeo;
}

// ---------------------------------------------------------------------------
// The sign
// ---------------------------------------------------------------------------

const SIGN = { w: 0.56, h: 0.21, t: 0.024, y: 0.8 };
/** Share of the sign's canvas (from the top) that is the board's face; the rest is plain grain for its edges and back. */
const FACE_SHARE = 0.75;

const PAINT_FONT = '"Comic Sans MS", "Coming Soon", casual, "Chalkboard SE", "Segoe Print", "Bradley Hand", "Trebuchet MS", sans-serif';

/** Paints the board: driftwood grain, the words in sea-green paint (worn), a little sprout, two nails. */
function signTexture(text: string): THREE.Texture {
  const W = 512;
  const Hc = 256;
  const FH = Math.round(Hc * FACE_SHARE);
  const woodAt = (x: number, y: number): [number, number, number] => {
    const face = y < FH;
    const u = x / W;
    const w = face ? y / FH : (y - FH) / (Hc - FH);
    const g = grainAt(u * 0.8 + (face ? 0 : 0.37), face ? 0.08 + 0.84 * w : w, !face);
    const warm = smooth(0.35, 0.75, fbm(u * 3, w * 2, 501, 3));
    const r = g * mix(0.78, 0.8, warm);
    const gg = g * mix(0.75, 0.72, warm);
    const b = g * mix(0.7, 0.62, warm);
    return [r, gg, b];
  };
  // the wood is soft-grained, so it's painted at half size and drawn up
  const w2 = W / 2;
  const h2 = Hc / 2;
  const wood = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const [r, g, b] = woodAt(x * 2 + 1, y * 2 + 1);
      wood.set([r * 255, g * 255, b * 255, 255], (y * w2 + x) * 4);
    }
  }
  const hasCanvas = typeof document !== 'undefined' && typeof document.createElement === 'function';
  if (!hasCanvas) {
    // Node (the tests): the grain without lettering, upside down as a DataTexture is
    const data = new Uint8Array(w2 * h2 * 4);
    for (let y = 0; y < h2; y++) data.set(wood.subarray((h2 - 1 - y) * w2 * 4, (h2 - y) * w2 * 4), y * w2 * 4);
    const t = new THREE.DataTexture(data, w2, h2);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  }
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = Hc;
  const ctx = cv.getContext('2d')!;
  {
    const half = document.createElement('canvas');
    half.width = w2;
    half.height = h2;
    half.getContext('2d')!.putImageData(new ImageData(wood, w2, h2), 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(half, 0, 0, W, Hc);
  }

  // The lettering, on its own canvas so the paint can be worn away.
  const tc = document.createElement('canvas');
  tc.width = W;
  tc.height = FH;
  const t = tc.getContext('2d')!;
  const words = text.trim() || ' ';
  const room = W * 0.72;
  let size = 84;
  let lines = [words];
  t.font = `bold ${size}px ${PAINT_FONT}`;
  while (size > 40 && t.measureText(words).width > room) {
    size -= 4;
    t.font = `bold ${size}px ${PAINT_FONT}`;
  }
  if (t.measureText(words).width > room && words.includes(' ')) {
    const cut = words.lastIndexOf(' ', Math.ceil(words.length / 2) + 2);
    lines = [words.slice(0, cut), words.slice(cut + 1)];
    size = 64;
    t.font = `bold ${size}px ${PAINT_FONT}`;
    while (size > 28 && Math.max(...lines.map((l) => t.measureText(l).width)) > room) {
      size -= 4;
      t.font = `bold ${size}px ${PAINT_FONT}`;
    }
  }
  t.textAlign = 'center';
  t.textBaseline = 'middle';
  t.lineJoin = 'round';
  t.lineCap = 'round';
  const paint = '#2b7a70';
  const cx = W * 0.45;
  const lh = size * 1.05;
  const y0 = FH * 0.5 - ((lines.length - 1) * lh) / 2;
  // a brushy edge: a few passes, slightly offset, then the solid letters
  t.fillStyle = paint;
  t.strokeStyle = paint;
  lines.forEach((line, i) => {
    const y = y0 + i * lh;
    t.globalAlpha = 0.35;
    t.lineWidth = size * 0.09;
    t.strokeText(line, cx + 1.5, y + 1);
    t.strokeText(line, cx - 1, y - 1.5);
    t.globalAlpha = 1;
    t.lineWidth = size * 0.05;
    t.strokeText(line, cx, y);
    t.fillText(line, cx, y);
  });
  // a little sprout, painted at the end: a curved stem and two round leaves
  {
    const width = Math.max(...lines.map((l) => t.measureText(l).width));
    const sx = Math.min(W - 50, cx + width / 2 + 38);
    const sy = FH * 0.5 + size * 0.42;
    const top = sy - size * 0.62;
    t.globalAlpha = 1;
    t.strokeStyle = '#4d8a34';
    t.fillStyle = '#4d8a34';
    t.lineWidth = Math.max(4, size * 0.07);
    t.beginPath();
    t.moveTo(sx - 2, sy);
    t.quadraticCurveTo(sx + size * 0.08, sy - size * 0.3, sx, top);
    t.stroke();
    for (const s of [-1, 1]) {
      t.save();
      t.translate(sx, top + 2);
      t.rotate(-s * 0.5);
      t.beginPath();
      // a leaf: two arcs meeting in points
      const L = size * 0.42;
      const Wd = size * 0.2;
      t.moveTo(0, 0);
      t.quadraticCurveTo((s * L) / 2, -Wd, s * L, 0);
      t.quadraticCurveTo((s * L) / 2, Wd * 0.7, 0, 0);
      t.fill();
      t.restore();
    }
    // a little mound of earth under it
    t.fillStyle = '#7a5a3c';
    t.beginPath();
    t.ellipse(sx, sy + 2, size * 0.3, size * 0.08, 0, Math.PI, TAU);
    t.fill();
  }
  // wear the paint: flaking in patches, and none down in the cracks of the grain
  const ti = t.getImageData(0, 0, W, FH);
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      if (ti.data[o + 3] === 0) continue;
      const u = x / W;
      const v = y / FH;
      const flake = smooth(0.24, 0.34, fbm(u * 22, v * 9, 511, 3));
      const grain = grainAt(u * 0.8, 0.08 + 0.84 * v, false);
      const crack = smooth(0.7, 0.55, grain);
      const keep = clamp(0.5 + 0.5 * flake - crack * 0.6, 0, 1) * (0.88 + 0.12 * noise(x * 0.7, y * 0.7, 513));
      ti.data[o + 3] = Math.round(ti.data[o + 3] * keep);
    }
  }
  t.putImageData(ti, 0, 0);
  ctx.globalAlpha = 0.95;
  ctx.drawImage(tc, 0, 0);
  ctx.globalAlpha = 1;
  // two nails where it's fixed to the post (the post is behind the middle)
  for (const ny of [FH * 0.2, FH * 0.8]) {
    const g = ctx.createRadialGradient(W / 2, ny, 1, W / 2, ny, 13);
    g.addColorStop(0, 'rgba(70,40,25,0.55)');
    g.addColorStop(1, 'rgba(110,60,30,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(W / 2, ny + 4, 13, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#3c3430';
    ctx.beginPath();
    ctx.arc(W / 2, ny, 5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(200,190,175,0.5)';
    ctx.beginPath();
    ctx.arc(W / 2 - 1.5, ny - 1.5, 2, 0, TAU);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.name = 'garden:sign';
  return tex;
}

let postCache: THREE.BufferGeometry | null = null;
let boardCache: THREE.BufferGeometry | null = null;

function buildBoard(): THREE.BufferGeometry {
  const m = new Mesher();
  const { w, h, t } = SIGN;
  const nu = 36;
  // a driftwood board's outline: a rounded rectangle, worn uneven, one corner broken off
  const outline = (a: number): [number, number] => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const p = 0.28;
    let x = (w / 2) * Math.sign(c) * Math.pow(Math.abs(c), p);
    let y = (h / 2) * Math.sign(s) * Math.pow(Math.abs(s), p);
    const wob = 1 + 0.025 * Math.sin(a * 5 + 1) + 0.015 * Math.sin(a * 11 + 2);
    x *= wob;
    y *= 1 + 0.04 * Math.sin(a * 7 + 0.5);
    // the broken corner (top right)
    if (x > w * 0.38 && y > h * 0.2) {
      const cut = (x - w * 0.38) / (w * 0.12) + (y - h * 0.2) / (h * 0.3);
      if (cut > 1) {
        x -= (cut - 1) * 0.02;
        y -= (cut - 1) * 0.02;
      }
    }
    return [x, y];
  };
  // rows: front middle, front ring, front edge, side front, side back, back edge, back ring, back middle
  const rows: [number, number][] = [
    [0, 1],
    [0.6, 1],
    [0.96, 0.92],
    [1, 0.6],
    [1, -0.6],
    [0.96, -0.92],
    [0.6, -1],
    [0, -1],
  ];
  m.grid(
    nu,
    rows.length - 1,
    (i, j) => {
      const a = (-TAU * i) / nu;
      const [k, zf] = rows[j];
      const [ox, oy] = outline(a);
      const x = ox * k;
      const y = oy * k;
      const bend = 0.004 * Math.cos((x / w) * Math.PI);
      const z = (zf * t) / 2 + bend;
      const front = zf > 0.5;
      const uv: [number, number] = front ? [x / w + 0.5, 1 - FACE_SHARE * (1 - (y / h + 0.5))] : [x / w + 0.5, 0.02 + (1 - FACE_SHARE - 0.04) * (0.5 + 0.5 * Math.sin(a * 2))];
      const shade = front ? 1 : zf < -0.5 ? 0.82 : 0.9;
      return { p: [x, y, z], c: [shade, shade, shade], uv, n: [0, 0, zf > 0 ? 1 : -1] };
    },
    true,
  );
  return m.geometry();
}

function buildPost(): THREE.BufferGeometry {
  const m = new Mesher();
  const pts: V3[] = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    pts.push([0.01 * Math.sin(t * 2.5), -0.15 + 1.12 * t, -SIGN.t / 2 - 0.022 + 0.006 * Math.sin(t * 4 + 1)]);
  }
  pts.push([pts[6][0], pts[6][1] + 0.012, pts[6][2]]);
  tubeAlong(m, pts, {
    nu: 7,
    r: (t, a) => (t > 0.999 ? 0 : (0.022 - 0.004 * t) * (1 + 0.08 * Math.sin(a * 3 + t * 9))),
    col: (t, a) => mulC(C(0xa69d90), (0.85 + 0.2 * noise(t * 8, a, 31)) * (1 - 0.35 * smooth(0.2, 0.1, t))),
    uv: (t, a) => [t * 1.6, band(WOOD_BAND.grain, a / TAU)],
  });
  return m.geometry();
}

/**
 * A little driftwood sign on a post, with `text` lettered on in worn
 * sea-green paint (a canvas texture, painted once per sign). The words
 * face +z; the board is about 56 x 21 cm, its middle 0.8 m up. Origin at
 * the foot of the post. Two draw calls.
 */
export function signModel(text: string): THREE.Group {
  boardCache ??= buildBoard();
  postCache ??= buildPost();
  const g = new THREE.Group();
  g.name = 'sign';
  const board = new THREE.Mesh(boardCache, new THREE.MeshStandardMaterial({ map: signTexture(text), vertexColors: true, roughness: 0.9, metalness: 0 }));
  board.name = 'sign-board';
  board.position.set(0, SIGN.y, 0);
  board.rotation.z = 0.035;
  const post = new THREE.Mesh(postCache, woodMat());
  post.name = 'sign-post';
  for (const m of [board, post]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.dry = true;
    g.add(m);
  }
  g.userData.text = text;
  return g;
}

// ---------------------------------------------------------------------------

/**
 * Paints the garden's textures and builds the pot, bed and barrel ahead of
 * time (a few hundred milliseconds on a phone, once), so the first time the
 * garden is shown doesn't stutter. Optional: everything is made on first use.
 */
export function prepareGarden(): void {
  leafAtlas();
  soilTex();
  terracottaTex();
  woodTex();
  spangleTex();
  streamTex();
  for (const c of CROP_KINDS) {
    foliageMat(c);
    fruitMat(c);
  }
  potCache.has(1) || potModel();
  bedCache ??= buildBed();
  barrelCache ??= buildBarrel();
}

/** Frees the cached pot, bed, barrel and sign geometry and the shared materials (textures: disposeGardenTextures). */
export function disposeGardenCache(): void {
  for (const geos of potCache.values()) for (const g of geos) g.dispose();
  potCache.clear();
  for (const g of [bedCache?.[0], bedCache?.[1], barrelCache, discGeo, boardCache, postCache]) g?.dispose();
  bedCache = null;
  barrelCache = null;
  discGeo = null;
  boardCache = null;
  postCache = null;
  for (const m of mats.values()) m.dispose();
  mats.clear();
}
