/**
 * Wind, Wing & Wave: the page. Sets up the 3D scene, starts the engine, creates every
 * page system, routes engine messages, and runs the frame loop.
 *
 * Lead skeleton (docs/ARCHITECTURE.md §6). WP-H owns this file afterwards (UI, controls,
 * watch mode, saving). Rendering systems never need edits here: they plug in through the
 * factory functions below and the PageSystem interface.
 */
import * as THREE from 'three';
import { GAME_TITLE, GAME_VERSION, brushRadius, type BrushSize, type ToolId } from './config';
import { SPECIES } from './content/species';
import { createAudio } from './audio/audio';
import { startEngine, type EngineHost } from './engine/host';
import type { FromEngine, LifeInfo, StormState } from './engine/protocol';
import { OrbitCamera } from './input/camera';
import { Controls } from './input/controls';
import { createCursor } from './render/cursor';
import { createDaylight } from './render/daylight';
import { createEffects } from './render/effects';
import { createFauna } from './render/fauna';
import { WorldFields } from './render/fields';
import { createHands } from './render/hands';
import { createOcean } from './render/ocean';
import { createPonds } from './render/ponds';
import { createWorldUniforms, wrapTime, type BrushInfo, type FrameCtx, type PageSystem, type Quality, type SystemDeps } from './render/shared';
import { createSky } from './render/sky';
import { createTerrain } from './render/terrain';
import { createVegetation } from './render/vegetation';
import { createVignettes } from './render/vignettes';
import { createWeather } from './render/weather';
import { loadSettings } from './storage/storage';
import { Ui } from './ui/ui';

declare const __BUILD_TIME__: string;

const settings = loadSettings();
const debug = location.hash.includes('debug');

// ---------- renderer, scene, camera ----------

const canvas = document.getElementById('view') as HTMLCanvasElement;
const dpr = window.devicePixelRatio || 1;
const isTouch = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: dpr < 2, powerPreference: 'high-performance', alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true; // never toggled at runtime (ARCHITECTURE §7)
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 1, 16000);

const quality: Quality = {
  setting: settings.quality,
  phone: isTouch,
  tier: settings.quality === 'lighter' ? 0 : settings.quality === 'richer' ? 2 : isTouch ? 1 : 2,
  density: isTouch ? 0.8 : 1.2,
  shadows: settings.quality !== 'lighter',
};

const fields = new WorldFields();
const u = createWorldUniforms(fields);
const deps: SystemDeps = { renderer, scene, camera, fields, u, quality, species: SPECIES, isTouch };

// ---------- page systems (update order matters: ARCHITECTURE §6.1) ----------

const daylight = createDaylight(deps);
const weather = createWeather(deps);
const terrain = createTerrain(deps);
const ocean = createOcean(deps);
const ponds = createPonds(deps);
const vegetation = createVegetation(deps);
const fauna = createFauna(deps);
const vignettes = createVignettes(deps);
const effects = createEffects(deps);
const cursor = createCursor(deps);
const hands = createHands(deps);
const sky = createSky(deps);
const audio = createAudio(deps);
audio.setEnabled(settings.sound);
const systems: PageSystem[] = [daylight, weather, terrain, ocean, ponds, vegetation, fauna, vignettes, effects, cursor, hands, sky, audio];

// ---------- camera and game state ----------

const cam = new OrbitCamera(camera, (x, z) => fields.heightAt(x, z));
let tool: ToolId = 'lava';
let size: BrushSize = 1;
let host: EngineHost | null = null;
let ready = false;
let started = false;
let year = 0;
let firstLand = false;
let storm: StormState = { phase: 'none', t: 0, level: 0, great: false };
let life: LifeInfo | null = null;
let brush: BrushInfo | null = null;
let stroking = false;
let watching = false;
let undoCount = 0;

const ui = new Ui(
  {
    start: () => startPlaying(),
    selectTool: (t) => selectTool(t),
    undo: () => host?.send({ t: 'undo' }),
    glideTo: (x, z) => cam.glideTo(x, z, Math.min(cam.dist, 220)),
  },
  SPECIES,
);
ui.setTool(tool);

function selectTool(t: ToolId): void {
  tool = t;
  ui.setTool(t);
}

// ---------- controls ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function screenRay(sx: number, sy: number): THREE.Ray {
  const r = canvas.getBoundingClientRect();
  ndc.set(((sx - r.left) / r.width) * 2 - 1, -((sy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}
function pick(sx: number, sy: number): { x: number; y: number; z: number } | null {
  const ray = screenRay(sx, sy);
  const hit = fields.raycast(ray.origin, ray.direction);
  return hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
}
function setBrush(p: { x: number; y: number; z: number } | null): void {
  if (!p) {
    brush = null;
    return;
  }
  const n = fields.normalAt(p.x, p.z);
  brush = { x: p.x, y: p.y, z: p.z, nx: n.x, ny: n.y, nz: n.z, r: brushRadius(size, cam.dist) };
}

new Controls(canvas, cam, {
  stroke: (phase, sx, sy) => {
    if (!host || !ready || !started) return;
    const p = pick(sx, sy);
    setBrush(p);
    if (tool === 'look') {
      if (phase === 'start' && p) host.send({ t: 'inspect', id: 1, x: p.x, z: p.z });
      return;
    }
    stroking = phase === 'start' || phase === 'move';
    if (!p && phase !== 'end' && phase !== 'cancel') return;
    host.send({ t: 'stroke', phase, tool, x: p?.x ?? 0, z: p?.z ?? 0, radius: brushRadius(size, cam.dist), strength: 1 });
  },
  hover: (sx, sy) => setBrush(pick(sx, sy)),
  tap: () => {},
  glideTo: (sx, sy) => {
    const p = pick(sx, sy);
    if (p) cam.glideTo(p.x, p.z);
  },
  pick,
  undo: () => host?.send({ t: 'undo' }),
  selectTool: (i) => selectTool((['lava', 'rock', 'sand', 'hands', 'scoop', 'look'] as ToolId[])[i] ?? 'lava'),
  cycleSize: (d) => (size = Math.max(0, Math.min(2, size + d)) as BrushSize),
  journal: () => {},
  interacted: () => {
    if (started) audio.start();
  },
});

// ---------- engine messages ----------

function onEngine(m: FromEngine): void {
  fields.apply(m);
  for (const s of systems) s.onEngine?.(m);
  switch (m.t) {
    case 'progress':
      ui.setProgress(m.done, m.total);
      break;
    case 'ready':
      if (!ready) {
        ready = true;
        firstLand = m.firstLand;
        year = m.year;
        ui.setReady();
      }
      break;
    case 'life':
      life = m.life;
      break;
    case 'journal':
      ui.journal(m.entries);
      break;
    case 'tick':
      year = m.year;
      firstLand = m.firstLand;
      storm = m.storm;
      undoCount = m.undo;
      u.uLavaGlow.value.set(m.events.lavaGlow[0], m.events.lavaGlow[1], m.events.lavaGlow[2], m.events.lavaGlow[3]);
      ui.setYear(year);
      break;
    case 'inspected':
      ui.toast(`Look: ${m.info.islandName}, ${m.info.height.toFixed(0)} m`);
      break;
    case 'error':
      console.error(m.message);
      break;
    default:
      break;
  }
}

// ---------- start ----------

async function boot(): Promise<void> {
  resize();
  host = await startEngine(onEngine);
  host.send({ t: 'init', save: null, seed: 1, settings: { pace: settings.pace, gentleStorms: settings.gentleStorms } });
  console.log(`${GAME_TITLE} v${GAME_VERSION} (${__BUILD_TIME__}), engine on ${host.mode}`);
}

function startPlaying(): void {
  if (started) return;
  started = true;
  if (settings.sound) audio.start();
}

document.addEventListener('visibilitychange', () => {
  host?.send({ t: 'pause', on: document.visibilityState === 'hidden', hidden: document.visibilityState === 'hidden' });
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(dpr, isTouch ? 1.5 : 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------- frame loop ----------

let last = performance.now();
let time = 0;
let focusTimer = 0;
const frameCap = isTouch ? 1 / 45 : 0; // the Pixel's 90 Hz screen: every second frame
let sinceRender = 1;
let frames = 0;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  sinceRender += rawDt;
  if (sinceRender + 0.002 < frameCap) return;
  const dt = Math.min(0.1, sinceRender);
  sinceRender = 0;
  time += dt;
  frames++;
  host?.tick(dt);
  cam.update(dt);
  u.uTime.value = wrapTime(time);
  u.uCamPos.value.copy(camera.position);
  if (brush) brush.r = brushRadius(size, cam.dist);

  focusTimer -= dt;
  if (focusTimer <= 0 && host && ready) {
    focusTimer = 0.5;
    host.send({ t: 'focus', x: cam.target.x, z: cam.target.z, dist: cam.dist, dayPhase: daylight.day.phase, season: daylight.day.season });
  }

  const f: FrameCtx = {
    t: time,
    dt,
    camera,
    cam,
    fields,
    u,
    quality,
    day: daylight.day,
    year,
    firstLand,
    storm,
    life,
    tool,
    stroking,
    watching,
    isTouch,
    brush,
  };
  for (const s of systems) s.update(f);
  fields.flush();
  renderer.render(scene, camera);
}

requestAnimationFrame(frame);
void boot();

// ---------- hooks for the automated browser checks ----------

(window as unknown as { __game: unknown }).__game = {
  get ready() {
    return ready;
  },
  get started() {
    return started;
  },
  get mode() {
    return host?.mode;
  },
  get year() {
    return year;
  },
  get frames() {
    return frames;
  },
  get undo() {
    return undoCount;
  },
  get life() {
    return life;
  },
  camera: cam,
  fields,
  renderer,
  scene,
  selectTool,
  send: (m: Parameters<EngineHost['send']>[0]) => host?.send(m),
  /** Screen position (CSS px) of a world point. */
  project: (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
  /** Triangles and draw calls in the last frame. */
  stats: () => ({ triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, programs: renderer.info.programs?.length ?? 0 }),
  debug,
};
