/**
 * Sandcastle Cays: the page. Sets up the 3D scene, starts the sand engine,
 * and connects your fingers, the buttons and the sounds to it.
 */
import * as THREE from 'three';
import { BRUSH_RADIUS, CELL, GAME_VERSION, LAGOON_DIMS, type BrushSize, type ToolId } from './config';
import { SandAudio } from './audio/audio';
import { startEngine, type EngineHost } from './engine/host';
import type { FromEngine, Ray, TickEvents } from './engine/protocol';
import { LagoonTerrain } from './engine/terrain';
import { OrbitCamera } from './input/camera';
import { Controls } from './input/controls';
import { BoatMotion, createBoat } from './render/boat';
import { PALETTE } from './render/colors';
import { BrushCursor } from './render/cursor';
import { SandParticles } from './render/particles';
import { createSandMaterial } from './render/sandMaterial';
import { SandTiles } from './render/sandTiles';
import { createDistantIslands, createOuterTerrain, createRocks, createVegetation, rockTop, type RegionBounds } from './render/scenery';
import { createClouds, createSky } from './render/sky';
import { Water } from './render/water';
import { LAGOON_WAVES, waveHeight } from './render/waves';
import { downloadFile, loadAutosave, loadSettings, pickFile, saveAutosave, saveSettings, testStorage, clearAutosave } from './storage/storage';
import { Ui } from './ui/ui';
import type { CheckResult } from './checks/sandChecks';

declare const __BUILD_TIME__: string;

const settings = loadSettings();
const terrain = new LagoonTerrain();
const region: RegionBounds = {
  x0: LAGOON_DIMS.originX,
  x1: LAGOON_DIMS.originX + LAGOON_DIMS.cx * 16 * CELL,
  z0: LAGOON_DIMS.originZ,
  z1: LAGOON_DIMS.originZ + LAGOON_DIMS.cz * 16 * CELL,
};
const debug = location.hash.includes('debug');

// ---------- renderer and scene ----------

const canvas = document.getElementById('view') as HTMLCanvasElement;
const dpr = window.devicePixelRatio || 1;
const isTouch = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: dpr < 2, powerPreference: 'high-performance', alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.skyHorizon);
scene.fog = new THREE.Fog(PALETTE.skyHorizon, 60, 900);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2500);

const sunDir = new THREE.Vector3(0.55, 0.78, -0.3).normalize();
const sun = new THREE.DirectionalLight(PALETTE.sun, 2.9);
sun.castShadow = true;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(PALETTE.hemiSky, PALETTE.hemiGround, 1.35);
scene.add(hemi);

scene.add(createSky(sunDir));
const clouds = createClouds();
scene.add(clouds);
scene.add(createDistantIslands());

const { material: sandMat, uniforms: sandUniforms } = createSandMaterial();
const sand = new SandTiles(sandMat);
scene.add(sand.group);
const outer = createOuterTerrain(terrain, region, sandUniforms);
scene.add(outer);
const rocks = createRocks(terrain, region);
scene.add(rocks.mesh);
const swayTime = { value: 0 };
scene.add(createVegetation(terrain, region, swayTime));

const water = new Water(terrain, (x, z) => rockTop(rocks.blobs, x, z));
scene.add(water.mesh);
// The depth map of the editable beach exists from the start, so saved holes get their water.
water.setRegion(LAGOON_DIMS.cx * 8, LAGOON_DIMS.cz * 8, CELL * 2, region.x0, region.z0);

const boat = createBoat();
scene.add(boat);
const ampAt = (x: number, z: number) => {
  const still = terrain.heightAt(x, z);
  const mask = Math.min(1, Math.max(0, (0.32 - still) / 0.42));
  const deep = Math.min(1, Math.max(0, (-still - 0.6) / 2.4));
  return mask * mask * (3 - 2 * mask) * (1 + 1.6 * deep * deep * (3 - 2 * deep));
};
const boatMotion = new BoatMotion(boat, 3.2, -17, 0.35, ampAt);

const particles = new SandParticles();
scene.add(particles.points);
const cursor = new BrushCursor();
scene.add(cursor.mesh);

// ---------- quality ----------

let pixelCap = 1.75;
let shadowsOn = true;
function applyQuality(): void {
  const q = settings.quality;
  pixelCap = q === 'fast' ? 1.25 : q === 'pretty' ? Math.min(dpr, 2.25) : Math.min(dpr, isTouch ? 1.75 : 2);
  shadowsOn = q !== 'fast';
  renderer.setPixelRatio(Math.min(dpr, pixelCap));
  const size = q === 'pretty' || !isTouch ? 2048 : 1536;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
  }
  renderer.shadowMap.enabled = shadowsOn;
  sand.group.traverse((o) => ((o as THREE.Mesh).castShadow = shadowsOn));
  resize();
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  particles.setViewport(h * renderer.getPixelRatio(), camera.fov);
}
window.addEventListener('resize', resize);

// ---------- camera ----------

const cam = new OrbitCamera(
  camera,
  { minX: region.x0 + 0.5, maxX: region.x1 - 0.5, minZ: region.z0 + 0.5, maxZ: region.z1 - 0.3 },
  (x, z) => water.groundAt(x, z),
);
cam.snap();

// ---------- game state ----------

let tool: ToolId = 'dig';
let size: BrushSize = 1;
let host: EngineHost | null = null;
let ready = false;
let started = false;
let resumed = false;
let undoCount = 0;
let handWet = 0;
let handAmount = 0;
let pendingEvents: TickEvents | null = null;
let lastPerf: { simMs: number; meshMs: number; queue: number; chunks: number; dirty: number } | null = null;
let changedSinceSave = false;
let strokeWarned = false;
let saveSeq = 1;
const saveWaiters = new Map<number, (data: ArrayBuffer | null, error?: string) => void>();
let checksWaiter: ((r: CheckResult[]) => void) | null = null;
const audio = new SandAudio();
audio.enabled = settings.sound;

const ui = new Ui(
  {
    start: () => startPlaying(),
    selectTool: (t) => selectTool(t),
    setSize: (s) => (size = s),
    undo: () => doUndo(),
    home: () => cam.home(),
    photo: () => takePhoto(),
    saveFile: () => saveToFile(),
    loadFile: () => loadFromFile(),
    newBeach: () => newBeach(),
    setDrying: (d) => {
      settings.drying = d;
      saveSettings(settings);
      host?.send({ t: 'settings', settings: { drying: d } });
    },
    setSound: (on) => {
      settings.sound = on;
      saveSettings(settings);
      audio.setEnabled(on);
      if (on) audio.start();
    },
    setQuality: (q) => {
      settings.quality = q;
      saveSettings(settings);
      applyQuality();
    },
    runChecks: () => void runChecks(),
    click: () => audio.click(),
  },
  settings,
);
ui.setTool(tool);
if (debug) ui.fpsEl.style.display = 'block';

function selectTool(t: ToolId): void {
  tool = t;
  ui.setTool(t);
  if (started) {
    ui.hint(t);
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => ui.hint(null), 4500);
  }
}
let hintTimer = 0;

function doUndo(): void {
  if (undoCount === 0) return;
  host?.send({ t: 'undo' });
  ui.toast('Undone');
  changedSinceSave = true;
}

// ---------- controls ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function screenRay(x: number, y: number): THREE.Ray {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}

const controls = new Controls(canvas, cam, {
  ray: (x, y): Ray => {
    const r = screenRay(x, y);
    return { ox: r.origin.x, oy: r.origin.y, oz: r.origin.z, dx: r.direction.x, dy: r.direction.y, dz: r.direction.z };
  },
  pickGround: (x, y) => {
    // March along the ray over the ground-height map (fast and good enough for the camera).
    const r = screenRay(x, y);
    const p = r.origin.clone();
    const step = 0.04;
    for (let t = 0; t < 60; t += step) {
      p.copy(r.origin).addScaledVector(r.direction, t);
      if (p.y <= Math.max(water.groundAt(p.x, p.z), terrain.waterLevel)) return p.clone();
    }
    return null;
  },
  stroke: (phase, ray) => {
    if (!host || !ready || !started) return;
    if (phase === 'begin') {
      strokeWarned = false;
      ui.closePanels();
    }
    host.send({ t: 'stroke', phase, tool, size, ray });
    if (phase === 'end' || phase === 'cancel') {
      ui.hint(null);
      if (!isTouch) cursorFromHover = true;
    }
  },
  hover: (ray) => {
    if (!host || !ready) return;
    host.send({ t: 'hover', ray });
  },
  undo: () => doUndo(),
  selectTool: (i) => selectTool((['dig', 'pile', 'pat'] as ToolId[])[i]),
  cycleSize: (d) => {
    size = Math.max(0, Math.min(2, size + d)) as BrushSize;
    ui.setSize(size);
  },
  home: () => cam.home(),
  interacted: () => {
    if (started) audio.start();
  },
});
let cursorFromHover = !isTouch;

// ---------- engine ----------

function onEngine(msg: FromEngine): void {
  switch (msg.t) {
    case 'tile':
      sand.update(msg.tile, msg.positions, msg.normals, msg.attrs, msg.indices);
      water.patch(msg.hx, msg.hz, 32, msg.heights);
      if (!shadowsOn) sand.group.traverse((o) => ((o as THREE.Mesh).castShadow = false));
      break;
    case 'clear':
      sand.clear();
      break;
    case 'progress':
      ui.setProgress(msg.done, msg.total);
      break;
    case 'ready':
      water.setRegion(msg.mapW, msg.mapH, msg.mapCell, msg.originX, msg.originZ);
      if (!ready) {
        ready = true;
        ui.setReady(resumed);
      }
      break;
    case 'tick': {
      particles.set(msg.particles, msg.np);
      handAmount = msg.hand.amount;
      handWet = msg.hand.wet;
      ui.setHand(msg.hand.amount, msg.hand.capacity, msg.hand.wet);
      undoCount = msg.undo;
      lastPerf = msg.perf;
      ui.setUndo(msg.undo);
      const ev = msg.events;
      if (msg.hit && (cursorFromHover || controls.busy)) {
        cursor.show(msg.hit.x, msg.hit.y, msg.hit.z, msg.hit.nx, msg.hit.ny, msg.hit.nz, BRUSH_RADIUS[tool][size], tool);
      } else cursor.hide();
      if (ev.pats > 0) {
        audio.pat(handWet / 255);
        if (navigator.vibrate) navigator.vibrate(12);
      }
      if (ev.handFull && !strokeWarned) {
        strokeWarned = true;
        ui.toast('Your hands are full. Switch to Pile to put sand down.', 3000);
        if (navigator.vibrate) navigator.vibrate([20, 40, 20]);
      }
      if (ev.handEmpty && !strokeWarned) {
        strokeWarned = true;
        ui.toast('Your hands are empty. Dig some sand first.', 3000);
      }
      if (ev.dug || ev.poured || ev.pats || ev.rubbed || ev.slid || ev.landed) changedSinceSave = true;
      pendingEvents = mergeEvents(pendingEvents, ev);
      if (debug) {
        ui.fpsEl.textContent = `${fpsShown} fps · ${host?.mode} · sim ${msg.perf.simMs.toFixed(1)}ms mesh ${msg.perf.meshMs.toFixed(1)}ms · queue ${msg.perf.queue} · chunks ${msg.perf.chunks} · dirty ${msg.perf.dirty} · tris ${Math.round(sand.triangleCount / 1000)}k · grains ${msg.np}`;
      }
      break;
    }
    case 'saved': {
      const w = saveWaiters.get(msg.id);
      saveWaiters.delete(msg.id);
      w?.(msg.data, msg.error);
      break;
    }
    case 'loaded':
      if (msg.ok) {
        if (msg.header?.camera) cam.setState(msg.header.camera);
        ui.toast('Beach loaded');
        changedSinceSave = true;
      } else ui.toast(`Couldn't load that file: ${msg.error}`, 4000);
      break;
    case 'checks':
      checksWaiter?.(msg.results);
      checksWaiter = null;
      break;
    case 'error':
      console.error(msg.message);
      ui.toast(msg.message, 4000);
      break;
    case 'hello':
      break;
  }
}

function mergeEvents(a: TickEvents | null, b: TickEvents): TickEvents {
  if (!a) return { ...b };
  return {
    dug: a.dug + b.dug,
    poured: a.poured + b.poured,
    pats: a.pats + b.pats,
    rubbed: a.rubbed + b.rubbed,
    slid: a.slid + b.slid,
    fell: a.fell + b.fell,
    landed: a.landed + b.landed,
    handFull: a.handFull || b.handFull,
    handEmpty: a.handEmpty || b.handEmpty,
  };
}

function requestSave(): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    if (!host || !ready) return resolve(null);
    const id = saveSeq++;
    saveWaiters.set(id, (data, error) => {
      if (error) console.warn('Save failed:', error);
      resolve(data);
    });
    host.send({ t: 'save', id, header: { camera: cam.state } });
  });
}

let saving = false;
async function autosave(force = false): Promise<void> {
  if (saving || !ready || !started || (!changedSinceSave && !force)) return;
  saving = true;
  try {
    const data = await requestSave();
    if (data && (await saveAutosave(data))) changedSinceSave = false;
  } finally {
    saving = false;
  }
}
setInterval(() => void autosave(), 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void autosave();
});
window.addEventListener('pagehide', () => void autosave());

async function saveToFile(): Promise<void> {
  const data = await requestSave();
  if (!data) {
    ui.toast('Nothing to save yet');
    return;
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  downloadFile(data, `sandcastle-cays-lagoon-${stamp}.sandsave`);
  ui.toast('Beach saved to a file');
}

async function loadFromFile(): Promise<void> {
  const data = await pickFile('.sandsave,application/octet-stream');
  if (!data || !host) return;
  host.send({ t: 'load', id: saveSeq++, data }, [data]);
}

function newBeach(): void {
  host?.send({ t: 'reset' });
  void clearAutosave();
  cam.home();
  ui.toast('A fresh, smooth beach');
}

function takePhoto(): void {
  cursor.hide();
  renderer.render(scene, camera);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const d = new Date();
    downloadFile(blob, `sandcastle-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`, 'image/png');
    ui.toast('Photo saved');
  }, 'image/png');
}

async function runChecks(): Promise<void> {
  ui.showChecksRunning();
  const extra: { label: string; pass: boolean | null; detail: string }[] = [];
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown graphics chip';
  extra.push({ label: '3D graphics work', pass: renderer.capabilities.isWebGL2, detail: `WebGL ${renderer.capabilities.isWebGL2 ? '2' : '1'} on ${gpu}` });
  extra.push({
    label: 'Sand runs on a background thread',
    pass: host?.mode === 'worker' ? true : null,
    detail: host?.mode === 'worker' ? 'yes (keeps the screen smooth)' : 'no, it runs on the page here (still works, may be less smooth)',
  });
  const where = await testStorage();
  extra.push({
    label: 'Saving works in this browser',
    pass: where !== 'none',
    detail: where === 'browser' ? 'yes (browser storage)' : where === 'backup' ? 'yes (backup storage, smaller)' : 'no: use "Save beach to a file" to keep your work',
  });
  const fpsStart = frames;
  const t0 = performance.now();
  const results = await new Promise<CheckResult[]>((resolve) => {
    checksWaiter = resolve;
    host?.send({ t: 'checks', id: 1 });
  });
  // Measure smoothness for a few seconds after the checks.
  const f0 = frames;
  const s0 = performance.now();
  await new Promise((r) => setTimeout(r, 3000));
  const fps = ((frames - f0) / (performance.now() - s0)) * 1000;
  void fpsStart;
  void t0;
  extra.push({ label: 'Smooth on this device', pass: fps >= 28, detail: `${Math.round(fps)} frames per second (30 or more is smooth)` });
  ui.showChecks(results, extra);
}

// ---------- start ----------

async function boot(): Promise<void> {
  applyQuality();
  host = await startEngine(onEngine);
  let save: ArrayBuffer | null = null;
  try {
    save = await loadAutosave();
  } catch {
    save = null;
  }
  resumed = !!save;
  host.send({ t: 'init', save, settings: { drying: settings.drying }, focus: [0, 0.2, 0.8] }, save ? [save] : []);
  console.log(`Sandcastle Cays v${GAME_VERSION} (${__BUILD_TIME__}), engine on ${host.mode}`);
}

function startPlaying(): void {
  if (!ready || started) return;
  started = true;
  ui.hideStart();
  if (settings.sound) audio.start();
  ui.hint(tool);
  hintTimer = window.setTimeout(() => ui.hint(null), 7000);
  canvas.focus();
}

// ---------- frame loop ----------

let last = performance.now();
let time = 0;
let frames = 0;
let fpsShown = 0;
let fpsFrames = 0;
let fpsTime = 0;
let focusTimer = 0;
let slowTime = 0;
const tmpV = new THREE.Vector3();
const shoreZ = terrain.shoreZ(0);

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  frames++;
  host?.tick(dt);
  controls.update(dt);
  cam.update(dt);

  focusTimer -= dt;
  if (focusTimer <= 0 && host) {
    focusTimer = 0.3;
    host.send({ t: 'focus', x: cam.target.x, y: cam.target.y, z: cam.target.z });
  }

  // Sun, shadows and shaders.
  const shadowHalf = Math.min(14, Math.max(3, cam.dist * 0.9));
  const sc = sun.shadow.camera;
  sc.left = -shadowHalf;
  sc.right = shadowHalf;
  sc.top = shadowHalf;
  sc.bottom = -shadowHalf;
  sc.near = 1;
  sc.far = 60;
  sc.updateProjectionMatrix();
  const texel = (shadowHalf * 2) / sun.shadow.mapSize.x;
  tmpV.copy(cam.target);
  tmpV.x = Math.round(tmpV.x / texel) * texel;
  tmpV.z = Math.round(tmpV.z / texel) * texel;
  sun.target.position.copy(tmpV);
  sun.position.copy(tmpV).addScaledVector(sunDir, 30);
  sandUniforms.uTime.value = time;
  sandUniforms.uSunView.value.copy(sunDir).transformDirection(camera.matrixWorldInverse);
  particles.uniforms.uSunView.value.copy(sandUniforms.uSunView.value);
  water.update(time, camera, sunDir);
  swayTime.value = time;
  boatMotion.update(time, dt);
  cursor.update(dt, time);
  clouds.rotation.y += dt * 0.002;

  const lapH = waveHeight(LAGOON_WAVES, 0, shoreZ, time, 1);
  audio.update(dt, Math.min(1, Math.max(0, 0.5 + lapH / 0.08)), pendingEvents, handWet / 255);
  pendingEvents = null;

  renderer.render(scene, camera);

  // Frame rate, and automatic quality when it drops.
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 1) {
    fpsShown = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
    if (settings.quality === 'auto' && started) {
      if (fpsShown < 40) slowTime++;
      else slowTime = 0;
      if (slowTime >= 3) {
        slowTime = 0;
        const pr = renderer.getPixelRatio();
        if (pr > 1.05) {
          renderer.setPixelRatio(Math.max(1, pr - 0.25));
          resize();
        } else if (shadowsOn) {
          shadowsOn = false;
          renderer.shadowMap.enabled = false;
        }
      }
    }
  }
  void handAmount;
  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);
void boot();

// For the automated browser checks.
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
  get fps() {
    return fpsShown;
  },
  get triangles() {
    return sand.triangleCount;
  },
  get hand() {
    return handAmount;
  },
  start: () => startPlaying(),
  selectTool: (t: ToolId) => selectTool(t),
  runChecks: () =>
    new Promise<CheckResult[]>((resolve) => {
      checksWaiter = resolve;
      host?.send({ t: 'checks', id: 2 });
    }),
  camera: cam,
  /** Screen position (CSS pixels) of a point in the world. */
  project: (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
  get perf() {
    return lastPerf;
  },
  get undo() {
    return undoCount;
  },
  ground: (x: number, z: number) => water.groundAt(x, z),
  demo: () => host?.send({ t: 'demo' }),
  debugSand: (mode: number) => (sandUniforms.uDebug.value = mode),
};
