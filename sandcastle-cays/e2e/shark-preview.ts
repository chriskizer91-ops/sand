/**
 * Preview page for the sharks (built and driven by e2e/shark-look.mjs; not part
 * of the game). Uses the game's own sky, sea, daylight and frame pipeline, so
 * sharks under the water are seen through it as in the game. Shows:
 *   - both sharks side on, from above and from the front;
 *   - a reef shark swimming just under the surface, its fin cutting the water;
 *   - nurse sharks resting on the sand in shallow, clear water;
 *   - fin wakes seen from the boat's height;
 *   - the bait chunk and the cloud of bits it leaves.
 */
import * as THREE from 'three';
import { createSky, SKY } from '../src/render/sky';
import { Ocean, SeaFloorMap } from '../src/render/ocean';
import { Pipeline } from '../src/render/pipeline';
import { Daylight } from '../src/render/daylight';
import { HeldView } from '../src/render/held';
import { BaitCloud, FinWake, SHARK_LENGTH, baitModel, sharkModel, swim, type FinState, type SharkKind } from '../src/render/shark';

declare global {
  interface Window {
    __shark: { ready: boolean; view: (name: string) => string; views: string[]; info: Record<string, unknown> };
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

// A shallow sandy flat (about 1.1 m deep) for the nurse sharks; deeper water elsewhere.
const FLAT = new THREE.Vector3(40, 0, -10);
const floorAt = (x: number, z: number): number => {
  const d = Math.hypot(x - FLAT.x, z - FLAT.z);
  return -3.6 + 2.5 * Math.min(1, Math.max(0, (14 - d) / 5)) + 0.05 * Math.sin(x * 0.7) * Math.cos(z * 0.5);
};
const ocean = new Ocean(new SeaFloorMap(floorAt, 10, -10, 200, 160), SKY.sunDir, SKY.sunColor, (scene.fog as THREE.FogExp2).color, 160);
scene.add(ocean.mesh);
const floorGeo = new THREE.PlaneGeometry(200, 200, 160, 160);
floorGeo.rotateX(-Math.PI / 2);
floorGeo.translate(10, 0, -10);
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
  t.repeat.set(160, 160);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
const seaFloor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ color: 0xead6ab, map: sandTexture(), roughness: 1, metalness: 0 }));
seaFloor.receiveShadow = true;
scene.add(seaFloor);

const held = new HeldView();
const aboveWaterOnly: THREE.Object3D[] = [sky.mesh];
const pipeline = new Pipeline({ renderer, scene, camera, vmScene: held.scene, vmCamera: held.camera, ocean, sun, sunDir: SKY.sunDir, sky: sky.reflection, aboveWaterOnly });
pipeline.setQuality('medium');
pipeline.resize(W, H);
let envTex: THREE.Texture | null = null;
const daylight = new Daylight(scene, sun, hemi, sky, ocean, (env) => (envTex = env));
void envTex;
const clock = { day: 1, hour: 10.5 };
let time = 3;

const wake = new FinWake();
wake.waterAt = (x, z) => ocean.heightAt(x, z, time);
scene.add(wake.mesh);
aboveWaterOnly.push(wake.mesh);
const cloud = new BaitCloud();
scene.add(cloud.mesh);

// ---- display sharks in the air over the water (for judging shape and colour) ----
const SHOW = new THREE.Vector3(-30, 1.6, -12);
const display: Record<SharkKind, THREE.Group> = { reef: sharkModel('reef'), nurse: sharkModel('nurse') };
display.reef.position.set(SHOW.x - 1.6, SHOW.y, SHOW.z);
display.nurse.position.set(SHOW.x + 1.6, SHOW.y, SHOW.z);
scene.add(display.reef, display.nurse);

// ---- a bait chunk in the air, near the display ----
const bait = baitModel();
bait.position.set(SHOW.x, SHOW.y - 0.6, SHOW.z + 1.2);
bait.rotation.set(0.2, -0.9, 0.15);
scene.add(bait);

// ---- swimmers: reef sharks circling near the surface, nurse sharks resting on the flat ----
interface Swimmer {
  obj: THREE.Group;
  kind: SharkKind;
  /** path: centre, radius, angular speed (rad/s), phase, depth of the origin below the water */
  cx: number;
  cz: number;
  r: number;
  w: number;
  ph: number;
  depth: number;
  heading: number;
  speed: number;
  turn: number;
}
const swimmers: Swimmer[] = [];
function addSwimmer(kind: SharkKind, cx: number, cz: number, r: number, w: number, ph: number, depth: number): Swimmer {
  const obj = sharkModel(kind);
  scene.add(obj);
  const s: Swimmer = { obj, kind, cx, cz, r, w, ph, depth, heading: 0, speed: 0, turn: 0 };
  swimmers.push(s);
  return s;
}
// the circling reef sharks, just under the surface (their fins cut the water)
const POOL = new THREE.Vector3(0, 0, -14);
addSwimmer('reef', POOL.x, POOL.z, 4.5, 0.25, 0.4, -0.25);
addSwimmer('reef', POOL.x, POOL.z, 7, 0.17, 2.6, -0.24);
addSwimmer('reef', POOL.x, POOL.z, 2.6, -0.4, 4.4, -0.6);
// nurse sharks resting on the sandy flat
const resting: THREE.Group[] = [];
for (const [dx, dz, yaw, kind] of [
  [0, 0, 0.6, 'nurse'],
  [1.4, 1.6, 2.3, 'nurse'],
  [-1.6, 2.4, -0.4, 'nurse'],
] as [number, number, number, SharkKind][]) {
  const o = sharkModel(kind);
  const x = FLAT.x + dx;
  const z = FLAT.z + dz;
  o.position.set(x, floorAt(x, z) + (o.userData.rest as number) - 0.03, z);
  o.rotation.y = yaw;
  scene.add(o);
  resting.push(o);
}

function moveSwimmers(dt: number): void {
  for (const s of swimmers) {
    s.ph += s.w * dt;
    const a = s.ph;
    const x = s.cx + Math.cos(a) * s.r;
    const z = s.cz + Math.sin(a) * s.r;
    // heading along the circle (the game's convention: forward = (cos h, sin h))
    const h = Math.atan2(Math.cos(a) * Math.sign(s.w), -Math.sin(a) * Math.sign(s.w));
    s.turn = s.w;
    s.speed = Math.abs(s.w) * s.r;
    s.heading = h;
    s.obj.position.set(x, ocean.heightAt(x, z, time) + s.depth, z);
    s.obj.rotation.set(0, -h, 0);
  }
}

const finStates: FinState[] = [];
function fins(): FinState[] {
  finStates.length = 0;
  for (const s of swimmers) {
    if (!s.obj.visible) continue;
    s.obj.updateMatrixWorld();
    const tip = (s.obj.userData.finTip as THREE.Vector3).clone().applyMatrix4(s.obj.matrixWorld);
    finStates.push({ x: tip.x, y: tip.y, z: tip.z, heading: s.heading, speed: s.speed });
  }
  return finStates;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface Setup {
  cam: [number, number, number];
  look: [number, number, number];
  fov?: number;
  settle?: number;
  /** which swimmers to show (default none) */
  swimmers?: number[];
  resting?: boolean;
  /** the display sharks: swim speed and turn while settling */
  displaySpeed?: number;
  displayTurn?: number;
  bait?: boolean;
  steps?: [() => void, number][];
  /** after settling, put the camera this far behind-and-beside swimmer 0 (along, across, up) and look at it */
  follow?: [number, number, number];
}

const sunView = new THREE.Vector3();
function tick(s: Setup, dt: number): void {
  time += dt;
  daylight.update(dt, time, clock);
  camera.updateMatrixWorld();
  sunView.copy(SKY.sunDir).transformDirection(camera.matrixWorldInverse);
  sky.update(time, camera.position);
  ocean.update(time, camera.position);
  moveSwimmers(dt);
  for (const sw of swimmers) swim(sw.obj, time, sw.speed, sw.turn);
  for (const o of resting) swim(o, time, 0, 0);
  for (const k of ['reef', 'nurse'] as SharkKind[]) swim(display[k], time, s.displaySpeed ?? 0, s.displayTurn ?? 0);
  wake.update(fins(), time);
  cloud.update(time);
}

const side = (k: SharkKind, d = 1): Setup => {
  const p = display[k].position;
  return { cam: [p.x, p.y + 0.15, p.z + SHARK_LENGTH[k] * 1.25 * d], look: [p.x, p.y, p.z], fov: 45 };
};

const VIEWS: Record<string, () => Setup> = {
  'reef-side': () => side('reef'),
  'nurse-side': () => side('nurse'),
  'both-side': () => ({ cam: [SHOW.x, SHOW.y + 0.3, SHOW.z + 6.2], look: [SHOW.x, SHOW.y, SHOW.z], fov: 45 }),
  'reef-top': () => {
    const p = display.reef.position;
    return { cam: [p.x + 0.01, p.y + 3.2, p.z + 0.3], look: [p.x, p.y, p.z], fov: 45 };
  },
  'nurse-top': () => {
    const p = display.nurse.position;
    return { cam: [p.x + 0.01, p.y + 3.6, p.z + 0.3], look: [p.x, p.y, p.z], fov: 45 };
  },
  'reef-front': () => {
    const p = display.reef.position;
    return { cam: [p.x + 2.1, p.y + 0.35, p.z + 1.1], look: [p.x + 0.5, p.y, p.z], fov: 45 };
  },
  'nurse-head': () => {
    const p = display.nurse.position;
    return { cam: [p.x + 1.9, p.y - 0.15, p.z + 0.75], look: [p.x + 1.05, p.y - 0.05, p.z], fov: 45 };
  },
  'reef-swim-top': () => {
    const p = display.reef.position;
    return { cam: [p.x + 0.01, p.y + 3.2, p.z + 0.3], look: [p.x, p.y, p.z], fov: 45, displaySpeed: 1.6, displayTurn: 0.9, settle: 2.3 };
  },
  'reef-surface': () => ({ cam: [POOL.x - 9, 2.6, POOL.z + 6], look: [POOL.x, 0, POOL.z], fov: 60, swimmers: [0], settle: 4 }),
  'reef-surface-close': () => ({ cam: [0, 2, 0], look: [0, 0, -1], fov: 55, swimmers: [0], settle: 4, follow: [-2.2, 3.2, 1.5] }),
  'reef-surface-low': () => ({ cam: [0, 2, 0], look: [0, 0, -1], fov: 55, swimmers: [0], settle: 5, follow: [2.5, 4.5, 0.6] }),
  'nurse-sand': () => ({ cam: [FLAT.x - 4.5, 2.4, FLAT.z + 5.5], look: [FLAT.x - 0.2, -1, FLAT.z + 1.2], fov: 60, resting: true, settle: 2 }),
  'nurse-sand-close': () => ({ cam: [FLAT.x + 2.2, 1.4, FLAT.z + 1.8], look: [FLAT.x, -0.9, FLAT.z], fov: 60, resting: true, settle: 2 }),
  'wake-boat': () => ({ cam: [POOL.x - 2, 3.2, POOL.z + 11], look: [POOL.x, 0, POOL.z - 1], fov: 72, swimmers: [0, 1, 2], settle: 6 }),
  'wake-boat-down': () => ({ cam: [POOL.x + 1, 3.2, POOL.z + 6], look: [POOL.x, 0, POOL.z], fov: 72, swimmers: [0, 1, 2], settle: 9 }),
  bait: () => ({ cam: [bait.position.x + 0.12, bait.position.y + 0.08, bait.position.z + 0.18], look: [bait.position.x, bait.position.y, bait.position.z], fov: 45, bait: true }),
  'bait-cloud': () => ({
    cam: [POOL.x + 7.5, 1.7, POOL.z + 9.5],
    look: [POOL.x + 7, -0.6, POOL.z + 7.6],
    fov: 50,
    settle: 0.5,
    steps: [[() => cloud.drop(new THREE.Vector3(POOL.x + 7, ocean.heightAt(POOL.x + 7, POOL.z + 7.5, time), POOL.z + 7.5), 40), 2.2]],
  }),
};

function view(name: string): string {
  const make = VIEWS[name];
  if (!make) return 'no such view';
  const s = make();
  swimmers.forEach((sw, i) => (sw.obj.visible = !!s.swimmers?.includes(i)));
  for (const o of resting) o.visible = !!s.resting;
  camera.fov = s.fov ?? 72;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.position.set(...s.cam);
  camera.lookAt(new THREE.Vector3(...s.look));
  daylight.refresh();
  const dt = 1 / 30;
  for (let t = 0; t < (s.settle ?? 0.5); t += dt) tick(s, dt);
  for (const [fn, after] of s.steps ?? []) {
    fn();
    for (let t = 0; t < after; t += dt) tick(s, dt);
  }
  if (s.follow) {
    const sw = swimmers[0];
    const fx = Math.cos(sw.heading);
    const fz = Math.sin(sw.heading);
    const p = sw.obj.position;
    camera.position.set(p.x + fx * s.follow[0] - fz * s.follow[1], s.follow[2], p.z + fz * s.follow[0] + fx * s.follow[1]);
    camera.lookAt(p.x + fx * 0.3, 0, p.z + fz * 0.3);
  }
  tick(s, dt);
  pipeline.render(false, camera.position);
  return 'ok';
}

window.__shark = {
  ready: true,
  view,
  views: Object.keys(VIEWS),
  info: Object.fromEntries((['reef', 'nurse'] as SharkKind[]).map((k) => [k, new THREE.Box3().setFromObject(display[k]).getSize(new THREE.Vector3()).toArray()])),
};
