/**
 * Preview page for the fishing models (built and driven by e2e/fish-look.mjs;
 * not part of the game). It uses the game's own sky, sea, daylight and frame
 * pipeline, with the held view drawn on top, so the rod, line and float look
 * as they will in the game. Shows:
 *   - the five fish side by side, and each close up (and one wiggling);
 *   - the rod in your hands: idle, mid-cast, bent with a fish fighting, holding up a catch;
 *   - the float and line on the water: idle, a bite, landing, a fish fighting;
 *   - the three new beach finds on sand;
 *   - a palm with its coconuts (and a marker at the crown the game drops them from).
 */
import * as THREE from 'three';
import { createSky, SKY } from '../src/render/sky';
import { Ocean, SeaFloorMap } from '../src/render/ocean';
import { Pipeline } from '../src/render/pipeline';
import { Daylight } from '../src/render/daylight';
import { HeldView } from '../src/render/held';
import { FishingLine, rodModel } from '../src/render/fishingGear';
import { FISH_KINDS, FISH_LENGTH, fishModel, wiggle, type FishKind } from '../src/render/fish';
import { findModel } from '../src/render/finds';
import { palm, swayMaterial } from '../src/render/scenery';
import { palmCrown } from '../src/render/islandLife';
import { mulberry32 } from '../src/engine/noise';

declare global {
  interface Window {
    __fish: { ready: boolean; view: (name: string) => string; views: string[]; info: Record<string, unknown> };
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
const camera = new THREE.PerspectiveCamera(72, W / H, 0.05, 2500);
const sun = new THREE.DirectionalLight(0xfff2d6, 3);
const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.5);
scene.add(sun, hemi);
const sky = createSky(scene, renderer);

// A sand bank in the lagoon for the finds and the palm; open water elsewhere.
const BANK = new THREE.Vector3(30, 0, -12);
const floorAt = (x: number, z: number): number => {
  const d = Math.hypot(x - BANK.x, z - BANK.z);
  return -3.2 + 3.6 * Math.min(1, Math.max(0, (9 - d) / 4));
};
const ocean = new Ocean(new SeaFloorMap(floorAt, 0, 0, 200, 128), SKY.sunDir, SKY.sunColor, (scene.fog as THREE.FogExp2).color, 160);
scene.add(ocean.mesh);
// the sea floor, so the water has something to show through it
const floorGeo = new THREE.PlaneGeometry(200, 200, 100, 100);
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
let envTex: THREE.Texture | null = null;
const daylight = new Daylight(scene, sun, hemi, sky, ocean, (env) => (envTex = env));
const clock = { day: 1, hour: 10.5 };

let time = 3;
const line = new FishingLine();
line.waterAt = (x, z) => ocean.heightAt(x, z, time);
scene.add(line.group);
aboveWaterOnly.push(...line.overWater);

// ---- the five fish, in a row in the air over the water ----
const ROW = new THREE.Vector3(-20, 1.4, -10);
const fishes = new Map<FishKind, THREE.Object3D>();
{
  let x = ROW.x;
  for (const k of FISH_KINDS) {
    const f = fishModel(k);
    x += FISH_LENGTH[k] / 2;
    f.position.set(x, ROW.y, ROW.z);
    x += FISH_LENGTH[k] / 2 + 0.12;
    scene.add(f);
    fishes.set(k, f);
  }
  // centre the row
  const shift = (x - 0.12 - ROW.x) / 2;
  for (const f of fishes.values()) f.position.x -= shift;
}
const rowCentre = ROW.clone();

// ---- the new finds and a palm on the sand bank ----
const BANK_Y = 0.4;
const newFinds: [string, number, number, number][] = [
  ['sailcloth', -0.55, 0.1, 0.4],
  ['net', 0.05, -0.05, -0.3],
  ['bottle', 0.6, 0.15, 0.9],
];
for (const [kind, dx, dz, yaw] of newFinds) {
  const m = findModel(kind as never);
  m.position.set(BANK.x + dx, BANK_Y, BANK.z + dz);
  m.rotation.y = yaw;
  scene.add(m);
}
// old finds alongside for scale
for (const [kind, dx, dz, yaw] of [
  ['rope', -0.15, 0.55, 0.2],
  ['float', 0.35, 0.6, 0.5],
  ['glass-green', 0.7, -0.3, 0.3],
] as [string, number, number, number][]) {
  const m = findModel(kind as never);
  m.position.set(BANK.x + dx, BANK_Y, BANK.z + dz);
  m.rotation.y = yaw;
  scene.add(m);
}
const sandTop = new THREE.Mesh(new THREE.CircleGeometry(7, 64), sandMat);
sandTop.rotation.x = -Math.PI / 2;
sandTop.position.set(BANK.x, BANK_Y - 0.002, BANK.z);
sandTop.receiveShadow = true;
scene.add(sandTop);

// a rod lying across two finds' worth of air, for a close look at the reel
const showRod = rodModel();
showRod.group.position.set(BANK.x - 2.2, BANK_Y + 0.25, BANK.z + 0.6);
showRod.group.rotation.set(0, 0.5, 0);
scene.add(showRod.group);

const swayTime = { value: 0 };
const PALM_AT = new THREE.Vector3(BANK.x + 3.5, BANK_Y - 0.05, BANK.z - 2.5);
const palmH = 5.6;
const palmLean = 0.32;
const palmYaw = 2.4;
const palmGeo = palm(palmH, palmLean, mulberry32(7));
palmGeo.rotateY(palmYaw);
palmGeo.translate(PALM_AT.x, PALM_AT.y, PALM_AT.z);
const palmMesh = new THREE.Mesh(palmGeo, swayMaterial(swayTime));
palmMesh.castShadow = true;
scene.add(palmMesh);
const crown = palmCrown(palmH, palmLean, palmYaw, PALM_AT.x, PALM_AT.y, PALM_AT.z);
const crownMark = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2266 }));
crownMark.position.set(crown.x, crown.y, crown.z);
scene.add(crownMark);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const sunView = new THREE.Vector3();

interface Setup {
  cam: [number, number, number];
  look: [number, number, number];
  fov?: number;
  /** what's in your hands (and draw the held view) */
  holding?: 'rod' | 'fish' | 'basket';
  fishKind?: FishKind;
  /** float position relative to the camera, along the view on the water (metres ahead, metres right) */
  float?: [number, number];
  tension?: number;
  bend?: number;
  reel?: number;
  fight?: number;
  /** things to do before the picture, with how long to run after each (seconds) */
  steps?: [() => void, number][];
  settle?: number;
  wiggleKind?: FishKind;
  crown?: boolean;
}

const fwdOf = (s: Setup): THREE.Vector3 => new THREE.Vector3(s.look[0] - s.cam[0], 0, s.look[2] - s.cam[2]).normalize();

function floatWorld(s: Setup, out = new THREE.Vector3()): THREE.Vector3 {
  const f = fwdOf(s);
  const right = new THREE.Vector3(-f.z, 0, f.x);
  out.set(s.cam[0], 0, s.cam[2]).addScaledVector(f, s.float![0]).addScaledVector(right, s.float![1]);
  out.y = ocean.heightAt(out.x, out.z, time);
  return out;
}

function tick(s: Setup, dt: number): void {
  time += dt;
  swayTime.value = time;
  daylight.update(dt, time, clock);
  camera.updateMatrixWorld();
  sunView.copy(SKY.sunDir).transformDirection(camera.matrixWorldInverse);
  sky.update(time, camera.position);
  ocean.update(time, camera.position);
  held.update(dt, { walking: 0, hide: !s.holding, sunDir: sunView, sunColor: SKY.sunColor, sunIntensity: sun.intensity, hemiIntensity: hemi.intensity, env: envTex });
  if (s.float) {
    const tip = held.rodTipWorld(camera, new THREE.Vector3());
    line.update(tip, floatWorld(s), time, s.tension ?? 0.2);
  }
  if (s.wiggleKind) wiggle(fishes.get(s.wiggleKind)!, time, 1);
}

const rowCam = (k: FishKind | null, dist: number, dy = 0.15, side = 0): Setup => {
  const target = k ? fishes.get(k)!.position : rowCentre;
  return { cam: [target.x + side, target.y + dy, target.z + dist], look: [target.x, target.y, target.z], fov: 40 };
};

const FIRST_PERSON = (extra: Partial<Setup>): Setup => ({ cam: [0, 1.75, 6], look: [0, 1.25, -4], fov: 72, ...extra });

const VIEWS: Record<string, () => Setup> = {
  'fish-row': () => rowCam(null, 2.6, 0.25),
  'fish-row-3q': () => ({ ...rowCam(null, 2.2, 0.9, -0.6) }),
  ...Object.fromEntries(FISH_KINDS.map((k) => [`fish-${k}`, () => rowCam(k, FISH_LENGTH[k] * 1.45 + 0.06, FISH_LENGTH[k] * 0.3)])),
  'fish-mahi-top': () => {
    const p = fishes.get('mahi')!.position;
    return { cam: [p.x + 0.05, p.y + 1.6, p.z + 0.5], look: [p.x, p.y, p.z], fov: 40 };
  },
  'fish-jack-wiggle': () => {
    const p = fishes.get('jack')!.position;
    return { cam: [p.x + 0.02, p.y + 0.75, p.z + 0.12], look: [p.x, p.y, p.z], fov: 45, wiggleKind: 'jack', settle: 0.37 };
  },
  'held-rod': () => FIRST_PERSON({ holding: 'rod', float: [9, 1.2], tension: 0.15, settle: 1.5 }),
  'held-cast': () => FIRST_PERSON({ holding: 'rod', settle: 1.5, steps: [[() => held.cast(), 0.33]] }),
  'held-bent': () =>
    FIRST_PERSON({
      holding: 'rod',
      float: [7, 0.6],
      tension: 1,
      settle: 1.2,
      steps: [
        [
          () => {
            held.bend(0.85);
            held.reelTurn(1.5);
            line.fighting(0.9);
          },
          1.4,
        ],
      ],
    }),
  'held-catch': () => FIRST_PERSON({ holding: 'rod', settle: 1.2, steps: [[() => held.showCatch('snapper'), 1.1]] }),
  'held-catch-mahi': () => FIRST_PERSON({ holding: 'rod', settle: 1.2, steps: [[() => held.showCatch('mahi'), 1.3]] }),
  'held-catch-grunt': () => FIRST_PERSON({ holding: 'rod', settle: 1.2, steps: [[() => held.showCatch('grunt'), 1.0]] }),
  'held-fish': () => FIRST_PERSON({ holding: 'fish', fishKind: 'bonefish', settle: 1.5 }),
  'held-basket': () => FIRST_PERSON({ holding: 'basket', settle: 1.5 }),
  'float-close': () => ({ cam: [0, 0.9, 6], look: [0, 0.0, 3.6], fov: 60, holding: 'rod', float: [2.4, 0.0], tension: 0.1, settle: 1.5 }),
  'float-bite': () => ({ cam: [0, 0.9, 6], look: [0, 0.0, 3.6], fov: 60, holding: 'rod', float: [2.4, 0.0], tension: 0.3, settle: 1.5, steps: [[() => line.bite(1), 0.15]] }),
  'float-landed': () => ({ cam: [0, 0.9, 6], look: [0, 0.0, 3.6], fov: 60, holding: 'rod', float: [2.4, 0.0], tension: 0.1, settle: 1.2, steps: [[() => line.landed(), 0.3]] }),
  'float-fight': () => ({ cam: [0, 0.9, 6], look: [0, 0.0, 3.6], fov: 60, holding: 'rod', float: [2.4, 0.0], tension: 1, settle: 1.0, steps: [[() => line.fighting(1), 1.2]] }),
  'float-fight-top': () => ({ cam: [0, 2.0, 5.0], look: [0, 0.0, 3.6], fov: 60, holding: 'rod', float: [1.4, 0.0], tension: 1, settle: 1.0, steps: [[() => line.fighting(1), 1.2]] }),
  'finds-new': () => ({ cam: [BANK.x + 0.05, BANK_Y + 0.75, BANK.z + 1.25], look: [BANK.x + 0.05, BANK_Y, BANK.z + 0.1], fov: 50 }),
  'finds-sailcloth': () => ({ cam: [BANK.x - 0.55, BANK_Y + 0.42, BANK.z + 0.55], look: [BANK.x - 0.55, BANK_Y, BANK.z + 0.1], fov: 50 }),
  'finds-net': () => ({ cam: [BANK.x + 0.05, BANK_Y + 0.38, BANK.z + 0.45], look: [BANK.x + 0.05, BANK_Y, BANK.z - 0.05], fov: 50 }),
  'finds-bottle': () => ({ cam: [BANK.x + 0.62, BANK_Y + 0.3, BANK.z + 0.55], look: [BANK.x + 0.6, BANK_Y + 0.02, BANK.z + 0.15], fov: 50 }),
  'rod-reel': () => {
    showRod.group.updateMatrixWorld();
    const p = new THREE.Vector3(0.27, -0.05, 0).applyMatrix4(showRod.group.matrixWorld);
    return { cam: [p.x - 0.2, p.y + 0.12, p.z + 0.3], look: [p.x, p.y, p.z], fov: 45 };
  },
  'rod-reel-side': () => {
    showRod.group.updateMatrixWorld();
    const p = new THREE.Vector3(0.27, -0.05, 0).applyMatrix4(showRod.group.matrixWorld);
    return { cam: [p.x + 0.12, p.y - 0.02, p.z - 0.32], look: [p.x, p.y, p.z], fov: 45 };
  },
  'rod-tip': () => {
    showRod.group.updateMatrixWorld();
    const p = new THREE.Vector3(1.6, 0, 0).applyMatrix4(showRod.group.matrixWorld);
    return { cam: [p.x - 0.15, p.y + 0.06, p.z + 0.3], look: [p.x, p.y, p.z], fov: 45 };
  },
  palm: () => ({ cam: [crown.x - 3.2, crown.y - 1.1, crown.z + 3.2], look: [crown.x, crown.y - 0.3, crown.z], fov: 45, crown: true }),
  'palm-far': () => ({ cam: [PALM_AT.x - 7, 1.7, PALM_AT.z + 7], look: [PALM_AT.x, 3, PALM_AT.z], fov: 60 }),
};

function view(name: string): string {
  const make = VIEWS[name];
  if (!make) return 'no such view';
  const s = make();
  // reset
  line.setOut(false);
  line.fighting(0);
  held.bend(0);
  held.reelTurn(0);
  held.hideCatch();
  held.setHolding(s.holding ?? 'basket', s.fishKind);
  crownMark.visible = !!s.crown;
  for (const f of fishes.values()) wiggle(f, time, 0);
  camera.fov = s.fov ?? 72;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.position.set(...s.cam);
  camera.lookAt(new THREE.Vector3(...s.look));
  if (s.float) line.setOut(true);
  daylight.refresh();
  const dt = 1 / 30;
  for (let t = 0; t < (s.settle ?? 0.5); t += dt) tick(s, dt);
  for (const [fn, after] of s.steps ?? []) {
    fn();
    for (let t = 0; t < after; t += dt) tick(s, dt);
  }
  tick(s, dt);
  pipeline.render(!!s.holding, camera.position);
  return 'ok';
}

window.__fish = {
  ready: true,
  view,
  views: Object.keys(VIEWS),
  info: { crown, fish: Object.fromEntries([...fishes].map(([k, f]) => [k, new THREE.Box3().setFromObject(f).getSize(new THREE.Vector3()).toArray()])) },
};
