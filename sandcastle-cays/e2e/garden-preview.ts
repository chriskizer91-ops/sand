/**
 * Preview page for the garden models (built and driven by e2e/garden-look.mjs;
 * not part of the game). It uses the game's own sky, sea, daylight and frame
 * pipeline, with the held view drawn on top. Shows:
 *   - each crop at the five growth steps in pots, and in beds;
 *   - ripe and not yet ripe; thirsty next to watered;
 *   - the bed, the rain barrel low and high, and the sign;
 *   - the watering can in your hands, idle and pouring;
 *   - pots on the cabin-top trays of the real sloop (28 cm, and a smaller 22 cm).
 */
import * as THREE from 'three';
import { createSky, SKY } from '../src/render/sky';
import { Ocean, SeaFloorMap } from '../src/render/ocean';
import { Pipeline } from '../src/render/pipeline';
import { Daylight } from '../src/render/daylight';
import { HeldView } from '../src/render/held';
import { createSloop } from '../src/render/sloop';
import { BED, CROP_KINDS, GARDEN_SOIL, PLANT_STAGES, POT, PlantView, barrelModel, bedModel, potModel, signModel, type CropKind } from '../src/render/garden';
import { leafAtlas } from '../src/render/gardenPaint';

declare global {
  interface Window {
    __garden: { ready: boolean; view: (name: string) => string; views: string[]; info: Record<string, unknown> };
  }
}

const W = window.innerWidth;
const H = window.innerHeight;
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(SKY.horizon.getHex(), 0.003);
const camera = new THREE.PerspectiveCamera(72, W / H, 0.03, 2500);
const sun = new THREE.DirectionalLight(0xfff2d6, 3);
const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.5);
scene.add(sun, hemi);
const sky = createSky(scene, renderer);

// A broad sand bank for the garden; open water round it (the boat lies off to the south-west).
const G = new THREE.Vector3(30, 0, -12);
const GY = 0.4;
const floorAt = (x: number, z: number): number => {
  const d = Math.hypot(x - G.x, z - G.z);
  return -3.2 + (3.2 + GY) * Math.min(1, Math.max(0, (20 - d) / 4));
};
const ocean = new Ocean(new SeaFloorMap(floorAt, 0, 0, 200, 128), SKY.sunDir, SKY.sunColor, (scene.fog as THREE.FogExp2).color, 160);
scene.add(ocean.mesh);
const floorGeo = new THREE.PlaneGeometry(200, 200, 120, 120);
floorGeo.rotateX(-Math.PI / 2);
{
  const p = floorGeo.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, floorAt(p.getX(i), p.getZ(i)));
  floorGeo.computeVertexNormals();
}
function sandTexture(): THREE.DataTexture {
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const h = Math.sin(i * 12.9898) * 43758.5453;
    const r = h - Math.floor(h);
    const k = 0.93 + 0.07 * r;
    data.set([Math.round(255 * k), Math.round(250 * k), Math.round(240 * k), 255], i * 4);
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(120, 120);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
const sandMat = new THREE.MeshStandardMaterial({ color: 0xead6ab, map: sandTexture(), roughness: 1, metalness: 0 });
const seaFloor = new THREE.Mesh(floorGeo, sandMat);
seaFloor.receiveShadow = true;
scene.add(seaFloor);

const held = new HeldView();
const aboveWaterOnly: THREE.Object3D[] = [sky.mesh];
const pipeline = new Pipeline({ renderer, scene, camera, vmScene: held.scene, vmCamera: held.camera, ocean, sun, sunDir: SKY.sunDir, sky: sky.reflection, aboveWaterOnly });
pipeline.setQuality('medium');
pipeline.resize(W, H);
pipeline.shadowSpan = 9;
let envTex: THREE.Texture | null = null;
const daylight = new Daylight(scene, sun, hemi, sky, ocean, (env) => (envTex = env));
const clock = { day: 1, hour: 10.2 };
let time = 3;

const plants: PlantView[] = [];
const at = (dx: number, dz: number): THREE.Vector3 => new THREE.Vector3(G.x + dx, GY, G.z + dz);

/** A pot on the sand with a plant in it. */
function potWith(p: THREE.Vector3, crop: CropKind | null, g: number, thirsty: number, ripe: boolean, seed: number, scale = 1, parent: THREE.Object3D = scene): PlantView {
  const pot = potModel(scale);
  pot.position.copy(p);
  parent.add(pot);
  const pl = new PlantView('pot', seed);
  pl.set(crop, g, thirsty, ripe);
  pl.group.position.set(p.x, p.y + GARDEN_SOIL.pot * scale, p.z);
  pl.group.scale.setScalar(scale);
  pl.group.rotation.y = seed * 1.3;
  parent.add(pl.group);
  plants.push(pl);
  return pl;
}
function bedWith(p: THREE.Vector3, crop: CropKind | null, g: number, thirsty: number, ripe: boolean, seed: number, rot = 0): void {
  const bed = bedModel();
  bed.position.copy(p);
  bed.rotation.y = rot;
  scene.add(bed);
  const pl = new PlantView('bed', seed);
  pl.set(crop, g, thirsty, ripe);
  pl.group.position.set(p.x, p.y + GARDEN_SOIL.bed, p.z);
  pl.group.rotation.y = rot;
  scene.add(pl.group);
  plants.push(pl);
}

const stageG = (s: number): number => s / (PLANT_STAGES - 1);

// ---- pots: each crop at the five steps, a row each (3 m apart), the last ripe ----
// (The sun is to the -z side, so every view looks from there toward +z: rows run toward -x to read left to right.)
const POTS = { x0: -6, rx: -3, dx: -0.42, z0: 3 };
CROP_KINDS.forEach((crop, r) => {
  for (let s = 0; s < PLANT_STAGES; s++) potWith(at(POTS.x0 + r * POTS.rx + s * POTS.dx, POTS.z0), crop, stageG(s), 0, s === PLANT_STAGES - 1, 10 + r * 7 + s);
});
// ---- full grown, not ripe and ripe ----
const RIPE = { x0: -6, z0: 7 };
CROP_KINDS.forEach((crop, r) => {
  potWith(at(RIPE.x0 - r * 0.9, RIPE.z0), crop, 1, 0, false, 40 + r);
  potWith(at(RIPE.x0 - r * 0.9 - 0.42, RIPE.z0), crop, 1, 0, true, 50 + r);
});
// ---- thirsty: watered, half, very thirsty ----
const THIRST = { x0: 2, z0: 10, rx: -2.2 };
CROP_KINDS.forEach((crop, r) => {
  [0, 0.5, 1].forEach((t, k) => potWith(at(THIRST.x0 + r * THIRST.rx - k * 0.42, THIRST.z0), crop, 1, t, false, 60 + r * 3 + k));
});
// ---- beds: each crop at the five steps (rows along x), the last ripe ----
const BEDS = { x0: 5, dx: -2.3, z0: -10, dz: 5 };
CROP_KINDS.forEach((crop, r) => {
  for (let s = 0; s < PLANT_STAGES; s++) bedWith(at(BEDS.x0 + s * BEDS.dx, BEDS.z0 + r * BEDS.dz), crop, stageG(s), 0, s === PLANT_STAGES - 1, 100 + r * 9 + s);
});
// ---- a thirsty bed next to a watered one ----
const TBED = { x: 9.5, z: -6 };
bedWith(at(TBED.x, TBED.z), 'callaloo', 1, 0, false, 140);
bedWith(at(TBED.x, TBED.z + 1.5), 'callaloo', 1, 1, false, 140);
bedWith(at(TBED.x, TBED.z + 3), 'sweetpotato', 1, 1, false, 141);
// ---- the home garden: a bed, two barrels (low and high) and the sign ----
const HOME = { x: 4, z: 4 };
bedWith(at(HOME.x, HOME.z), 'tomato', 1, 0, true, 150);
const barrelLow = barrelModel();
barrelLow.group.position.copy(at(HOME.x + 1.6, HOME.z - 0.3));
barrelLow.setLevel(0.15);
scene.add(barrelLow.group);
const barrelHigh = barrelModel();
barrelHigh.group.position.copy(at(HOME.x + 2.4, HOME.z - 0.1));
barrelHigh.group.rotation.y = 0.8;
barrelHigh.setLevel(0.9);
scene.add(barrelHigh.group);
const sign = signModel('Home garden');
sign.position.copy(at(HOME.x - 1.4, HOME.z - 0.9));
const SIGN_YAW = Math.PI - 0.35;
sign.rotation.y = SIGN_YAW;
scene.add(sign);
// a watered bed for the watering-can views
bedWith(at(HOME.x, HOME.z + 2.2), 'callaloo', 0.75, 0, false, 151);

// ---- the sloop at anchor with four pots on her cabin-top trays (28 cm), and a set of smaller ones (22 cm) ----
const boat = createSloop();
const BOAT = new THREE.Vector3(-30, 0, 28);
boat.group.position.copy(BOAT);
boat.group.rotation.y = 0.4;
scene.add(boat.group);
boat.rig.setAnchored(true);
const potsBig = new THREE.Group();
const potsSmall = new THREE.Group();
boat.group.add(potsBig, potsSmall);
const deckCrops: [CropKind, number, boolean][] = [
  ['tomato', 1, true],
  ['callaloo', 0.75, false],
  ['sweetpotato', 1, false],
  ['callaloo', 1, true],
];
boat.points.potShelf.forEach((p, i) => {
  const [crop, g, ripe] = deckCrops[i];
  potWith(p, crop, g, 0, ripe, 200 + i, 1, potsBig);
  potWith(p, crop, g, 0, ripe, 200 + i, 0.8, potsSmall);
});

// ---- the leaf atlas on a board, for checking the painting ----
const atlasBoard = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial({ map: leafAtlas(), transparent: true, alphaTest: 0.02, side: THREE.DoubleSide }));
atlasBoard.position.copy(at(-14, -12)).add(new THREE.Vector3(0, 0.9, 0));
const atlasBack = new THREE.Mesh(new THREE.PlaneGeometry(2.04, 1.04), new THREE.MeshBasicMaterial({ color: 0x223040 }));
atlasBack.position.copy(atlasBoard.position).add(new THREE.Vector3(0, 0, -0.01));
scene.add(atlasBoard, atlasBack);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const sunView = new THREE.Vector3();

interface Setup {
  cam: [number, number, number];
  look: [number, number, number];
  fov?: number;
  holding?: 'can' | 'basket';
  steps?: [() => void, number][];
  settle?: number;
  small?: boolean;
  hour?: number;
}

function tick(s: Setup, dt: number): void {
  time += dt;
  for (const p of plants) p.update(time);
  daylight.update(dt, time, clock);
  camera.updateMatrixWorld();
  sunView.copy(SKY.sunDir).transformDirection(camera.matrixWorldInverse);
  sky.update(time, camera.position);
  ocean.update(time, camera.position);
  held.update(dt, { walking: 0, hide: !s.holding, sunDir: sunView, sunColor: SKY.sunColor, sunIntensity: sun.intensity, hemiIntensity: hemi.intensity, env: envTex });
}

const v3 = (p: THREE.Vector3): [number, number, number] => [p.x, p.y, p.z];
const look = (from: THREE.Vector3, to: THREE.Vector3, fov = 45, extra: Partial<Setup> = {}): Setup => ({ cam: v3(from), look: v3(to), fov, ...extra });
/** Looking at c from the sunny side (-z), `dist` away and `up` higher, `side` toward +x. */
const front = (c: THREE.Vector3, dist: number, up: number, side: number, lookUp: number, fov: number, extra: Partial<Setup> = {}): Setup =>
  look(c.clone().add(new THREE.Vector3(side, up, -dist)), c.clone().add(new THREE.Vector3(0, lookUp, 0)), fov, extra);
const rowView = (x0: number, z: number, n: number, dx: number, dist: number, up: number, fov = 40): Setup => front(at(x0 + ((n - 1) * dx) / 2, z), dist, up, 0, 0.22, fov);
const boatPt = (x: number, y: number, z: number): THREE.Vector3 => boat.group.localToWorld(new THREE.Vector3(x, y, z));

const VIEWS: Record<string, () => Setup> = {
  'pots-all': () => front(at(POTS.x0 + POTS.rx - 0.84, POTS.z0), 4.6, 2.2, 0, 0.15, 50),
  ...Object.fromEntries(CROP_KINDS.map((crop, r) => [`pots-${crop}`, () => rowView(POTS.x0 + r * POTS.rx, POTS.z0, PLANT_STAGES, POTS.dx, 1.75, 0.75, 42)])),
  ...Object.fromEntries(
    CROP_KINDS.map((crop, r) => [
      `pot-${crop}-ripe`,
      () => front(at(RIPE.x0 - r * 0.9 - 0.21, RIPE.z0), 0.95, 0.7, 0, 0.3, 45),
    ]),
  ),
  'pots-ripe': () => rowView(RIPE.x0, RIPE.z0, 6, -0.42, 2.0, 0.9, 45),
  ...Object.fromEntries(
    CROP_KINDS.map((crop, r) => [
      `thirsty-${crop}`,
      () => front(at(THIRST.x0 + r * THIRST.rx - 0.42, THIRST.z0), 1.3, 0.75, 0, 0.28, 42),
    ]),
  ),
  'thirsty-beds': () => {
    const c = at(TBED.x, TBED.z + 1.5);
    return look(c.clone().add(new THREE.Vector3(3.6, 1.9, -0.6)), c.clone().add(new THREE.Vector3(0, 0.3, 0)), 50);
  },
  ...Object.fromEntries(
    CROP_KINDS.map((crop, r) => [
      `beds-${crop}`,
      () => front(at(BEDS.x0 + 2 * BEDS.dx, BEDS.z0 + r * BEDS.dz), 4.4, 2.6, 0, 0.2, 62),
    ]),
  ),
  ...Object.fromEntries(
    CROP_KINDS.map((crop, r) => [
      `bed-${crop}`,
      () => front(at(BEDS.x0 + 4 * BEDS.dx, BEDS.z0 + r * BEDS.dz), 1.75, 1.25, 0.6, 0.35, 50),
    ]),
  ),
  ...Object.fromEntries(
    CROP_KINDS.map((crop, r) => [
      `bed-${crop}-mid`,
      () => front(at(BEDS.x0 + 2 * BEDS.dx, BEDS.z0 + r * BEDS.dz), 1.75, 1.25, 0.6, 0.3, 50),
    ]),
  ),
  garden: () => front(at(HOME.x + 0.5, HOME.z - 0.3), 3.6, 1.65, 0.6, 0.4, 55),
  'barrel-low': () => front(barrelLow.group.position, 0.75, 1.62, 0.1, 0.62, 50),
  'barrel-high': () => front(barrelHigh.group.position, 0.75, 1.62, 0.1, 0.62, 50),
  'barrel-side': () => front(barrelLow.group.position.clone().add(new THREE.Vector3(0.3, 0, 0)), 1.5, 0.8, 0.1, 0.45, 50),
  sign: () => {
    const c = sign.position.clone();
    const out = new THREE.Vector3(Math.sin(SIGN_YAW), 0, Math.cos(SIGN_YAW));
    return look(c.clone().add(out.multiplyScalar(1.3)).add(new THREE.Vector3(0.15, 1.15, 0)), c.clone().add(new THREE.Vector3(0, 0.75, 0)), 45);
  },
  'held-can': () => front(at(HOME.x, HOME.z + 2.2), 1.35, 1.72, 0, 0.2, 72, { holding: 'can', settle: 1.6 }),
  'held-can-pour': () => front(at(HOME.x, HOME.z + 2.2), 1.35, 1.72, 0, 0.2, 72, { holding: 'can', settle: 1.6, steps: [[() => held.pour(2), 0.9]] }),
  'held-can-pour-start': () => front(at(HOME.x, HOME.z + 2.2), 1.35, 1.72, 0, 0.2, 72, { holding: 'can', settle: 1.6, steps: [[() => held.pour(2), 0.22]] }),
  'held-can-level': () => look(at(HOME.x, HOME.z - 3.5).add(new THREE.Vector3(0, 1.72, 0)), at(HOME.x, HOME.z + 4).add(new THREE.Vector3(0, 1.3, 0)), 72, { holding: 'can', settle: 1.6 }),
  // pour() while holding the basket: the can comes up for it
  'held-basket-pour': () => look(at(HOME.x, HOME.z - 3.5).add(new THREE.Vector3(0, 1.72, 0)), at(HOME.x, HOME.z + 4).add(new THREE.Vector3(0, 1.0, 0)), 72, { holding: 'basket', settle: 1.2, steps: [[() => held.pour(2), 1.3]] }),
  'boat-trays': () => look(boatPt(-2.75, 2.02, 0.15), boatPt(-1.2, 1.3, 0.1), 70),
  'boat-trays-small': () => look(boatPt(-2.75, 2.02, 0.15), boatPt(-1.2, 1.3, 0.1), 70, { small: true }),
  'boat-tray-close': () => look(boatPt(-1.0, 1.95, 1.25), boatPt(-1.33, 1.28, 0.55), 50),
  'boat-tray-close-small': () => look(boatPt(-1.0, 1.95, 1.25), boatPt(-1.33, 1.28, 0.55), 50, { small: true }),
  'boat-tray-top': () => look(boatPt(-1.33, 2.6, 0.62), boatPt(-1.33, 1.2, 0.6), 40),
  'boat-tray-top-small': () => look(boatPt(-1.33, 2.6, 0.62), boatPt(-1.33, 1.2, 0.6), 40, { small: true }),
  'boat-far': () => look(boatPt(4, 2.6, 7.5), boatPt(-1.0, 1.4, 0), 50),
  atlas: () => look(atlasBoard.position.clone().add(new THREE.Vector3(0, 0, 1.25)), atlasBoard.position.clone(), 46),
};

function view(name: string): string {
  const make = VIEWS[name];
  if (!make) return 'no such view';
  const s = make();
  potsBig.visible = !s.small;
  potsSmall.visible = !!s.small;
  held.hideCatch();
  held.setHolding(s.holding ?? 'basket');
  clock.hour = s.hour ?? 10.2;
  camera.fov = s.fov ?? 72;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.position.set(...s.cam);
  camera.lookAt(new THREE.Vector3(...s.look));
  pipeline.shadowSpan = name.startsWith('beds') ? 9 : 5;
  daylight.refresh();
  const dt = 1 / 30;
  for (let t = 0; t < (s.settle ?? 0.4); t += dt) tick(s, dt);
  for (const [fn, after] of s.steps ?? []) {
    fn();
    for (let t = 0; t < after; t += dt) tick(s, dt);
  }
  tick(s, dt);
  // the shadows follow what we're looking at
  pipeline.render(!!s.holding || name === 'held-basket-pour', new THREE.Vector3(...s.look));
  return 'ok';
}

const full = (crop: CropKind, size: 'pot' | 'bed', ripe: boolean): number => {
  const p = new PlantView(size, 1);
  p.set(crop, 1, 0, ripe);
  const n = p.triangles;
  p.dispose();
  return n;
};
window.__garden = {
  ready: true,
  view,
  views: Object.keys(VIEWS),
  info: {
    pot: POT,
    bed: BED,
    potShelf: boat.points.potShelf.map((p) => p.toArray().map((v) => +v.toFixed(3))),
    triangles: Object.fromEntries(CROP_KINDS.flatMap((c) => (['pot', 'bed'] as const).map((s) => [`${c}-${s}`, full(c, s, true)]))),
  },
};
