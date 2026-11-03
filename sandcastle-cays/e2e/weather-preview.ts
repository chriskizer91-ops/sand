// Preview page for the weather effects alone (built and driven by e2e/weather-look.mjs; not part of the game).
// Uses the game's real sky dome, sea, daylight and render pipeline (tone mapping, bloom), out on the
// open sea, with squalls placed at chosen distances, rain around the camera and spray over the sloop's bow.
import * as THREE from 'three';
import { createSky, SKY } from '../src/render/sky';
import { Ocean, SeaFloorMap } from '../src/render/ocean';
import { Daylight, type Clock } from '../src/render/daylight';
import { Pipeline } from '../src/render/pipeline';
import { createSloop } from '../src/render/sloop';
import { WeatherFx, type SquallInfo } from '../src/render/weatherFx';

declare global {
  interface Window {
    __weather: { ready: boolean; info: Record<string, unknown>; view: (name: string) => string; views: string[]; stats: () => unknown };
  }
}

const W = window.innerWidth;
const H = window.innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(SKY.horizon.getHex(), 0.0026);
const camera = new THREE.PerspectiveCamera(72, W / H, 0.05, 2500);
const sun = new THREE.DirectionalLight(0xfff2d6, 3);
const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.5);
scene.add(sun, hemi);
const sky = createSky(scene, renderer);
// Deep water everywhere: the open sea.
const seaFloor = new SeaFloorMap(() => -40, 0, 0, 400, 8);
const ocean = new Ocean(seaFloor, SKY.sunDir, SKY.sunColor, (scene.fog as THREE.FogExp2).color, 160);
scene.add(ocean.mesh);

const sloop = createSloop();
sloop.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) {
    o.castShadow = true;
    o.receiveShadow = true;
  }
});
sloop.rig.setSail(1);
sloop.rig.setBoom(-0.35);
sloop.rig.setJib(-0.3);
sloop.rig.setFill(1, 0);
sloop.rig.setAnchored(false);
scene.add(sloop.group);

// A simple island (a low green hump with a sand rim and a few palms), to see squalls pass behind and over land.
const island = (() => {
  const g = new THREE.Group();
  const hump = new THREE.Mesh(
    new THREE.SphereGeometry(1, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.95 }),
  );
  hump.scale.set(110, 22, 70);
  hump.position.y = -2;
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(122, 128, 3, 40), new THREE.MeshStandardMaterial({ color: 0xe9dcb6, roughness: 1 }));
  sand.scale.set(1, 1, 0.68);
  sand.position.y = -0.8;
  g.add(sand, hump);
  for (let i = 0; i < 14; i++) {
    const a = i * 2.39;
    const r = 30 + (i * 37) % 60;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r * 0.6;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 14, 6), new THREE.MeshStandardMaterial({ color: 0x8a7350 }));
    trunk.position.set(x, 14 + 7, z);
    const top = new THREE.Mesh(new THREE.ConeGeometry(6, 4, 7), new THREE.MeshStandardMaterial({ color: 0x3f6b2e }));
    top.position.set(x, 29, z);
    g.add(trunk, top);
  }
  g.visible = false;
  scene.add(g);
  return g;
})();

const t0 = performance.now();
const fx = new WeatherFx({ phone: location.hash.includes('phone') });
const buildMs = performance.now() - t0;
scene.add(fx.group);
fx.setViewport(H);

const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(60, W / H, 0.01, 10);
const pipeline = new Pipeline({
  renderer,
  scene,
  camera,
  vmScene,
  vmCamera,
  ocean,
  sun,
  sunDir: SKY.sunDir,
  sky: sky.reflection,
  aboveWaterOnly: [sky.mesh, fx.group],
});
pipeline.setQuality(location.hash.includes('phone') ? 'phone' : 'medium');
pipeline.resize(W, H);
const daylight = new Daylight(scene, sun, hemi, sky, ocean, () => {});
const clock: Clock = { day: 3, hour: 12 };

// Out on the open sea, well beyond the reefs.
const BASE = new THREE.Vector3(900, 0, 700);

interface View {
  hour: number;
  /** Squalls relative to BASE: x, z, radius, strength. */
  squalls: [number, number, number, number][];
  cam: [number, number, number];
  /** Where to look, relative to BASE. */
  target: [number, number, number];
  roll?: number;
  fov?: number;
  rain?: number;
  /** Rain and squall overhead where you are (fed to daylight, as the game does). */
  here?: { rain: number; overhead: number };
  wind?: [number, number];
  /** Camera speed (m/s) along x during the frames before the picture. */
  move?: number;
  boat?: boolean;
  /** Where the island sits, relative to BASE. */
  island?: [number, number];
  /** Spray bursts this many seconds before the picture (strength). */
  spray?: [number, number][];
}

const WIND: [number, number] = [-9, 0];
const views: Record<string, View> = {
  // Two squalls out to the east at midday: one about 600 m away, one about 1.4 km.
  horizon: { hour: 12, squalls: [[600, -170, 190, 0.85], [1400, 300, 240, 1]], cam: [0, 2.6, 0], target: [100, 13, 15] },
  // Looking straight at the near one.
  near: { hour: 12, squalls: [[600, 0, 200, 0.95]], cam: [0, 2.6, 0], target: [100, 12, 0] },
  // A young squall (rain not yet reaching the sea) and a fading one.
  young: { hour: 11, squalls: [[800, -250, 160, 0.2], [900, 380, 200, 0.45]], cam: [0, 2.6, 0], target: [100, 12, 10] },
  // Standing in the middle of a heavy squall.
  inside: { hour: 12, squalls: [[0, 0, 200, 1], [-1100, 600, 220, 0.9]], cam: [0, 2.6, 0], target: [100, 0, 0], rain: 1, here: { rain: 1, overhead: 0.6 } },
  'inside-west': { hour: 12, squalls: [[0, 0, 200, 1], [-1100, 600, 220, 0.9]], cam: [0, 2.6, 0], target: [-100, 0, 30], rain: 1, here: { rain: 1, overhead: 0.6 } },
  'inside-up': { hour: 12, squalls: [[0, 0, 200, 1]], cam: [0, 2.6, 0], target: [100, 90, 0], rain: 1, here: { rain: 1, overhead: 0.6 } },
  // Moving at boat speed and rolled with the boat.
  'inside-moving': { hour: 12, squalls: [[0, 0, 200, 1]], cam: [0, 2.6, 0], target: [100, 0, 20], rain: 1, here: { rain: 1, overhead: 0.6 }, move: 7, roll: 0.2 },
  // The same with none of the game's rain fog (what this module draws on its own).
  'inside-raw': { hour: 12, squalls: [[0, 0, 200, 1]], cam: [0, 2.6, 0], target: [100, 0, 0], rain: 1 },
  // At the edge of the rain, looking in.
  edge: { hour: 12, squalls: [[190, 0, 200, 1]], cam: [0, 2.6, 0], target: [100, 4, -10], rain: 0.12, here: { rain: 0.12, overhead: 0.5 } },
  // A wall of rain about 150 m off.
  approach: { hour: 14, squalls: [[360, 40, 210, 1]], cam: [0, 2.6, 0], target: [100, 10, 0], here: { rain: 0, overhead: 0.15 } },
  // Light rain at the edge of a passing shower.
  'light-rain': { hour: 15, squalls: [[250, 60, 220, 0.6]], cam: [0, 2.6, 0], target: [100, 6, 40], rain: 0.2, here: { rain: 0.2, overhead: 0.35 } },
  // A squall passing behind an island 450 m away, and one over it.
  island: { hour: 13, squalls: [[700, -40, 200, 1], [420, 260, 150, 0.7]], cam: [0, 2.6, 0], target: [100, 9, 10], island: [450, 0] },
  // At anchor 120 m off an island with a squall right over you both.
  'island-inside': { hour: 13, squalls: [[60, 0, 230, 1]], cam: [0, 2.6, 0], target: [100, 5, 0], island: [200, 0], rain: 1, here: { rain: 1, overhead: 0.6 } },
  sunset: { hour: 19.45, squalls: [[650, -200, 200, 0.9], [1300, 280, 240, 1]], cam: [0, 2.6, 0], target: [100, 12, 10] },
  'sunset-west': { hour: 19.45, squalls: [[-700, -150, 200, 0.9], [-1350, 350, 230, 1]], cam: [0, 2.6, 0], target: [-100, 12, 10] },
  night: { hour: 23, squalls: [[650, -150, 200, 0.95], [1300, 300, 230, 1]], cam: [0, 2.6, 0], target: [100, 12, 10] },
  'night-inside': { hour: 23, squalls: [[0, 0, 200, 1]], cam: [0, 2.6, 0], target: [100, 0, 0], rain: 1, here: { rain: 1, overhead: 0.6 } },
  // Fading out near the limit: one at 1.55 km, one at 1.68 km.
  far: { hour: 13, squalls: [[1550, -250, 230, 1], [1680, 420, 240, 1]], cam: [0, 2.6, 0], target: [100, 10, 5] },
  // Spray over the bow, seen from the cockpit, sailing east into the morning sun.
  spray: { hour: 9, squalls: [], cam: [-3.0, 2.05, 0.35], target: [6, 1.9, 0], boat: true, move: 5, wind: [-9, -2], spray: [[0.75, 0.6], [0.45, 0.9], [0.12, 0.8]] },
  // The same from the side deck at midday, looking across the bow.
  'spray-side': { hour: 12.5, squalls: [], cam: [-0.4, 2.45, 1.25], target: [4.0, 1.9, -0.4], boat: true, move: 5, wind: [-9, -2], spray: [[0.5, 0.8], [0.2, 1]] },
  // Spray in the rain inside a squall.
  'spray-squall': { hour: 12, squalls: [[0, 0, 200, 1]], cam: [-3.0, 2.05, 0.35], target: [6, 1.9, 0], boat: true, move: 5, rain: 0.8, here: { rain: 0.8, overhead: 0.6 }, wind: [-12, -3], spray: [[0.6, 1], [0.3, 0.8]] },
};

let time = 1000;
function step(dt: number, squalls: SquallInfo[], v: View): void {
  time += dt;
  const light = daylight.update(dt, time, clock);
  sky.update(time, camera.position);
  ocean.update(time, camera.position);
  const o = ocean as unknown as { setWeather?: (wind: number, sq: SquallInfo[]) => void };
  o.setWeather?.(9, squalls);
  const w = v.wind ?? WIND;
  fx.update(squalls, camera, time, dt, { daylight: light.daylight, night: light.night, sunDir: SKY.sunDir, sunColor: SKY.sunColor, horizon: SKY.horizon, zenith: SKY.zenith }, w[0], w[1]);
}

function view(name: string): string {
  const v = views[name];
  if (!v) return 'no such view';
  clock.hour = v.hour;
  const dw = (daylight as unknown as { weather?: { rain: number; overhead: number } }).weather;
  if (dw) {
    dw.rain = v.here?.rain ?? 0;
    dw.overhead = v.here?.overhead ?? 0;
  }
  daylight.refresh();
  const squalls: SquallInfo[] = v.squalls.map(([x, z, r, s], i) => ({ id: 10 + i + name.length * 7, x: BASE.x + x, z: BASE.z + z, radius: r, strength: s }));
  sloop.group.visible = !!v.boat;
  island.visible = !!v.island;
  if (v.island) island.position.set(BASE.x + v.island[0], 0, BASE.z + v.island[1]);
  camera.fov = v.fov ?? 72;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  const frames = 16;
  const dt = 1 / 30;
  const bursts = [...(v.spray ?? [])].sort((a, b) => b[0] - a[0]);
  fx.setLocalRain(v.rain ?? 0);
  for (let k = 0; k < frames; k++) {
    const left = (frames - 1 - k) * dt;
    const back = (v.move ?? 0) * left;
    sloop.group.position.set(BASE.x - back, 0, BASE.z);
    camera.position.set(BASE.x + v.cam[0] - back, v.cam[1], BASE.z + v.cam[2]);
    camera.up.set(0, 1, 0);
    camera.lookAt(BASE.x + v.target[0] - back, v.target[1], BASE.z + v.target[2]);
    if (v.roll) camera.rotateZ(v.roll);
    camera.updateMatrixWorld();
    while (bursts.length && bursts[0][0] >= left - 1e-6) {
      const [, s] = bursts.shift()!;
      const bow = sloop.points.bow.clone().add(sloop.group.position);
      fx.spray(bow.x, bow.y, bow.z, 1, 0, s, time, v.move ?? 0);
    }
    step(dt, squalls, v);
  }
  pipeline.render(false, camera.position);
  return 'ok';
}

window.__weather = {
  ready: true,
  views: Object.keys(views),
  view,
  stats: () => fx.stats(),
  info: { buildMs: Math.round(buildMs), size: `${W}x${H}` },
};
