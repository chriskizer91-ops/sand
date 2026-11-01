/**
 * Sandcastle Cays: the page. Sets up Home Cay (island, sea, sky, your boat),
 * puts you aboard in first person, runs beachcombing, and connects the sand
 * engine for building when you kneel on the cove's sand.
 */
import * as THREE from 'three';
import { BRUSH_RADIUS, CELL, DAY, GAME_VERSION, LAGOON_DIMS, PLAYER, type BrushSize, type ToolId } from './config';
import { SandAudio } from './audio/audio';
import { startEngine, type EngineHost } from './engine/host';
import type { FromEngine, Ray, TickEvents } from './engine/protocol';
import { decodeHeader, decompress } from './engine/save';
import { OrbitCamera } from './input/camera';
import { Controls } from './input/controls';
import { FpInput } from './input/fpInput';
import { BoatMotion } from './render/boatMotion';
import { BrushCursor } from './render/cursor';
import { Daylight, advanceClock, formatClock, type Clock } from './render/daylight';
import { findModel } from './render/finds';
import { HeldView } from './render/held';
import { createIslandGround } from './render/island';
import { createIslandLife } from './render/islandLife';
import { Ocean, SeaFloorMap } from './render/ocean';
import { Pipeline, type QualityName } from './render/pipeline';
import { SandParticles } from './render/particles';
import { createSandMaterial } from './render/sandMaterial';
import { SandTiles } from './render/sandTiles';
import { createDistantIslands, createRocks, createVegetation, rockTop, type RegionBounds } from './render/scenery';
import { SKY, createSky } from './render/sky';
import { createSloop } from './render/sloop';
import { FINDS } from './content/finds';
import { Beach, BeachView } from './game/beach';
import { Player, type PlayerMode } from './player/player';
import { GroundMap } from './world/ground';
import { ANCHORAGE, HomeCayTerrain } from './world/homeCay';
import { downloadFile, loadAutosave, loadSettings, pickFile, saveAutosave, saveSettings, testStorage, clearAutosave, unwrapSave } from './storage/storage';
import { Hud, cap } from './ui/hud';
import { Ui } from './ui/ui';
import type { CheckResult } from './checks/sandChecks';

declare const __BUILD_TIME__: string;

const settings = loadSettings();
const terrain = new HomeCayTerrain();
const region: RegionBounds = terrain.region;
const debug = location.hash.includes('debug');

// ---------- renderer and scene ----------

const canvas = document.getElementById('view') as HTMLCanvasElement;
const isTouch = matchMedia('(pointer: coarse)').matches;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(SKY.horizon.getHex(), 0.003);
const FP_FOV = 72;
const BUILD_FOV = 50;
const camera = new THREE.PerspectiveCamera(FP_FOV, 1, 0.05, 2500);

const sun = new THREE.DirectionalLight(0xfff2d6, 3);
const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.5);
scene.add(sun, hemi);

const sky = createSky(scene, renderer);
const distant = createDistantIslands();
distant.name = 'distant';
scene.add(distant);

// The ground: the editable cove sand (from the engine), the rest of the island, rocks.
const { material: sandMat, uniforms: sandUniforms } = createSandMaterial();
const sand = new SandTiles(sandMat);
scene.add(sand.group);
const islandGround = createIslandGround(terrain, { x0: -176, x1: 192, z0: -160, z1: 160 }, sandUniforms);
islandGround.name = 'island';
scene.add(islandGround);
const coveRocks = createRocks(terrain, region);
coveRocks.mesh.name = 'coveRocks';
scene.add(coveRocks.mesh);
const swayTime = { value: 0 };
const covePlants = createVegetation(terrain, region, swayTime);
covePlants.name = 'covePlants';
scene.add(covePlants);
const life = createIslandLife(terrain, swayTime);
life.group.name = 'life';
scene.add(life.group);
const ground = new GroundMap(terrain);
ground.rocks = [...coveRocks.blobs, ...life.rocks];

const seaFloor = new SeaFloorMap((x, z) => Math.max(terrain.heightAt(x, z), rockTop(ground.rocks, x, z)), 8, -10, 720, 300);
const ocean = new Ocean(seaFloor, SKY.sunDir, SKY.sunColor, (scene.fog as THREE.FogExp2).color, isTouch ? 170 : 220);
ocean.mesh.name = 'ocean';
scene.add(ocean.mesh);
const seaHeight = (x: number, z: number, t: number) => ocean.heightAt(x, z, t);

// Your boat.
const sloop = createSloop();
scene.add(sloop.group);
sloop.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) {
    o.castShadow = true;
    o.receiveShadow = true;
  }
});
const boatMotion = new BoatMotion(sloop.group, ANCHORAGE.x, ANCHORAGE.z, ANCHORAGE.heading, sloop.length, sloop.beam, seaHeight);

const particles = new SandParticles();
scene.add(particles.points);
const cursor = new BrushCursor();
scene.add(cursor.mesh);
cursor.hide();

// What the under-the-water picture can skip: anything that never sits below the surface.
const refractSkip: THREE.Object3D[] = [];
const staticSkip: THREE.Object3D[] = [sky.mesh, particles.points, cursor.mesh, distant, covePlants];
islandGround.traverse((o) => o.userData.dry && staticSkip.push(o));
life.group.traverse((o) => o.userData.dry && staticSkip.push(o));
const sandDry = new Set<THREE.Object3D>();
function rebuildRefractSkip(): void {
  refractSkip.length = 0;
  refractSkip.push(...staticSkip, ...sandDry);
}
rebuildRefractSkip();

// Far away, untouched parts of the cove's sand are drawn by a simple stand-in
// (the same shape, far fewer triangles). Anything you've built always shows.
const TILE_M = 4 * 16 * CELL;
const SAND_NEAR = 22;
const standIn = islandGround.userData.standIn as THREE.Mesh;
const standInAll = Array.from(standIn.geometry.index!.array as ArrayLike<number>);
const standInTile: number[] = [];
{
  const pos = standIn.geometry.getAttribute('position');
  const ntx = Math.ceil(LAGOON_DIMS.cx / 4);
  for (let q = 0; q < standInAll.length; q += 6) {
    const a = standInAll[q];
    const d = standInAll[q + 5];
    const cx = (pos.getX(a) + pos.getX(d)) / 2;
    const cz = (pos.getZ(a) + pos.getZ(d)) / 2;
    const tx = Math.max(0, Math.min(ntx - 1, Math.floor((cx - region.x0) / TILE_M)));
    const tz = Math.max(0, Math.floor((cz - region.z0) / TILE_M));
    standInTile.push(tx + tz * ntx);
  }
}
const editedTiles = new Set<number>();
let hiddenKey = '';
function updateSandDetail(): void {
  const hidden: number[] = [];
  for (const m of sand.group.children) {
    const tile = m.userData.tile as number;
    const box = (m as THREE.Mesh).geometry.boundingBox!;
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const far = Math.hypot(camera.position.x - cx, camera.position.z - cz) > SAND_NEAR;
    m.visible = !far || editedTiles.has(tile);
    if (!m.visible) hidden.push(tile);
  }
  const key = hidden.join(',');
  if (key === hiddenKey) return;
  hiddenKey = key;
  const set = new Set(hidden);
  const idx: number[] = [];
  for (let q = 0; q < standInTile.length; q++) if (set.has(standInTile[q])) for (let k = 0; k < 6; k++) idx.push(standInAll[q * 6 + k]);
  standIn.geometry.setIndex(idx);
  standIn.visible = idx.length > 0;
}

const held = new HeldView();
const pipeline = new Pipeline({
  renderer,
  scene,
  camera,
  vmScene: held.scene,
  vmCamera: held.camera,
  ocean,
  sun,
  sunDir: SKY.sunDir,
  sky: sky.reflection,
  aboveWaterOnly: refractSkip,
});
let envTex: THREE.Texture | null = null;
const daylight = new Daylight(scene, sun, hemi, sky, ocean, (env) => (envTex = env));

// ---------- quality ----------

function qualityFor(q: typeof settings.quality): QualityName {
  if (q === 'pretty') return 'high';
  if (q === 'fast') return 'low';
  return isTouch ? 'phone' : 'medium';
}
function applyQuality(): void {
  pipeline.setQuality(qualityFor(settings.quality));
  resize();
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  pipeline.resize(w, h);
  particles.setViewport(h * renderer.getPixelRatio(), camera.fov);
}
window.addEventListener('resize', resize);

// ---------- game state ----------

const clock: Clock = { day: 1, hour: DAY.start };
const beach = new Beach(terrain.tideline(0.6));
const beachView = new BeachView(beach, findModel, (x, z) => ground.heightAt(x, z));
scene.add(beachView.group);

const ISLAND_CENTRE = { cx: 4, cz: 10, r: 200 };
const player = new Player({
  groundAt: (x, z) => ground.heightAt(x, z),
  waterAt: (x, z) => seaHeight(x, z, time),
  trunks: life.trunks,
  boat: { obj: sloop.group, deck: sloop.deck, ladderTop: sloop.points.ladderTop, ladderBottom: sloop.points.ladderBottom, length: sloop.length },
  bounds: ISLAND_CENTRE,
});
const START_YAW = Math.PI; // looking north, toward the island

type ViewMode = 'fp' | 'build';
let view: ViewMode = 'fp';
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
let holdTime = false;
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
    saveFile: () => void saveToFile(),
    loadFile: () => void loadFromFile(),
    newBeach: () => newBeach(),
    newGame: () => newGame(),
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
    logbook: () => toggleLogbook(),
  },
  settings,
);
ui.setTool(tool);
if (debug) ui.fpsEl.style.display = 'block';

const hud = new Hud(
  {
    action: () => input.press('Action'),
    jump: () => input.press('Space'),
    logbook: () => toggleLogbook(),
    standUp: () => exitBuild(),
    click: () => audio.click(),
  },
  isTouch,
);
hud.setMode('none');

function toggleLogbook(show?: boolean): void {
  const open = show ?? !hud.logbookOpen;
  if (open) {
    ui.closePanels();
    hud.renderLogbook(beach.state.found, beach.state.locker, beach.state.basket, formatClock(clock));
    input.unlock();
    input.clear();
  }
  hud.showLogbook(open);
}

function selectTool(t: ToolId): void {
  tool = t;
  ui.setTool(t);
  if (started && view === 'build') {
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

// ---------- first-person input ----------

const input = new FpInput(canvas);
input.onInteract = () => {
  if (started) audio.start();
};
input.onLockChange = () => updateLookHint();
function updateLookHint(): void {
  hud.setLookHint(!isTouch && started && view === 'fp' && !input.locked && !input.dragLook && !anyPanelOpen());
}
function anyPanelOpen(): boolean {
  return ui.panelOpen || hud.logbookOpen;
}

// ---------- building (kneeling at the sand) ----------

const cam = new OrbitCamera(
  camera,
  { minX: region.x0 + 0.5, maxX: region.x1 - 0.5, minZ: region.z0 + 0.5, maxZ: region.z1 - 0.3 },
  (x, z) => ground.sandAt(x, z),
);
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
    const r = screenRay(x, y);
    const p = r.origin.clone();
    for (let t = 0; t < 60; t += 0.04) {
      p.copy(r.origin).addScaledVector(r.direction, t);
      if (p.y <= Math.max(ground.sandAt(p.x, p.z), terrain.waterLevel)) return p.clone();
    }
    return null;
  },
  stroke: (phase, ray) => {
    if (!host || !ready || !started || view !== 'build') return;
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
    if (!host || !ready || view !== 'build') return;
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
controls.enabled = false;
let cursorFromHover = !isTouch;

/** Camera glide between standing (first person) and kneeling (building). */
let blend: { t: number; fromPos: THREE.Vector3; fromQuat: THREE.Quaternion; toFp: boolean } | null = null;

function canBuildHere(): boolean {
  return player.mode === 'land' && ground.inRegion(player.feet.x, player.feet.z) && player.waterDepth < 0.05;
}

function enterBuild(): void {
  if (view === 'build' || !canBuildHere()) return;
  const fx = -Math.sin(player.yaw);
  const fz = -Math.cos(player.yaw);
  const tx = player.feet.x + fx * 1.3;
  const tz = player.feet.z + fz * 1.3;
  blend = { t: 0, fromPos: camera.position.clone(), fromQuat: camera.quaternion.clone(), toFp: false };
  cam.setState([player.yaw, 0.62, 2.6, tx, ground.sandAt(tx, tz) + 0.05, tz]);
  view = 'build';
  camera.fov = BUILD_FOV;
  camera.updateProjectionMatrix();
  controls.enabled = true;
  input.enabled = false;
  input.unlock();
  input.clear();
  hud.setMode('build');
  hud.setPrompt(null);
  ui.hint(tool);
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => ui.hint(null), 6000);
  updateLookHint();
}

function exitBuild(): void {
  if (view !== 'build') return;
  host?.send({ t: 'stroke', phase: 'cancel', tool, size, ray: null });
  blend = { t: 0, fromPos: camera.position.clone(), fromQuat: camera.quaternion.clone(), toFp: true };
  // Stand facing the castle.
  player.yaw = Math.atan2(-(cam.target.x - player.feet.x), -(cam.target.z - player.feet.z));
  player.pitch = -0.35;
  view = 'fp';
  camera.fov = FP_FOV;
  camera.updateProjectionMatrix();
  controls.enabled = false;
  input.enabled = true;
  cursor.hide();
  ui.hint(null);
  hud.setMode('fp');
  updateLookHint();
}

window.addEventListener('keydown', (e) => {
  if (!started) return;
  if (view === 'build' && (e.code === 'Escape' || e.code === 'KeyB')) exitBuild();
  else if (e.code === 'KeyL' && view === 'fp') toggleLogbook();
  else if (e.code === 'Escape' && hud.logbookOpen) toggleLogbook(false);
});

// ---------- engine ----------

function onEngine(msg: FromEngine): void {
  switch (msg.t) {
    case 'tile': {
      sand.update(msg.tile, msg.positions, msg.normals, msg.attrs, msg.indices);
      ground.patch(msg.hx, msg.hz, 32, msg.heights);
      // Has this tile been built on or dug? (Compare with the untouched beach.)
      let diff = 0;
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) {
          const wx = region.x0 + ((msg.hx + x) * 2 + 0.5) * CELL;
          const wz = region.z0 + ((msg.hz + z) * 2 + 0.5) * CELL;
          diff = Math.max(diff, Math.abs(msg.heights[x + z * 32] - terrain.heightAt(wx, wz)));
        }
      }
      if (diff > 0.045) editedTiles.add(msg.tile);
      else editedTiles.delete(msg.tile);
      hiddenKey = '?';
      sandDry.clear();
      for (const m of sand.group.children) {
        (m as THREE.Mesh).castShadow = sun.castShadow;
        m.userData.tile = Number(m.name.slice(5));
        const box = (m as THREE.Mesh).geometry.boundingBox;
        if (box && box.min.y > 0.12) sandDry.add(m);
      }
      rebuildRefractSkip();
      break;
    }
    case 'clear':
      sand.clear();
      editedTiles.clear();
      sandDry.clear();
      rebuildRefractSkip();
      hiddenKey = '?';
      break;
    case 'progress':
      ui.setProgress(msg.done, msg.total);
      break;
    case 'ready':
      ground.setRegion(msg.mapW, msg.mapH, msg.mapCell, msg.originX, msg.originZ);
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
      if (view === 'build' && msg.hit && (cursorFromHover || controls.busy)) {
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
        if (msg.header?.game) restoreGame(msg.header.game);
        else if (msg.header?.camera) cam.setState(msg.header.camera);
        ui.toast('Game loaded');
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

// ---------- saving ----------

interface GameSave {
  version: string;
  clock: Clock;
  player: { mode: PlayerMode; pos: number[]; yaw: number; pitch: number };
  beach: unknown;
}

function gameState(): GameSave {
  return { version: GAME_VERSION, clock: { ...clock }, player: player.state, beach: beach.state };
}

function restoreGame(raw: unknown): void {
  const g = raw as Partial<GameSave> | null;
  if (!g || typeof g !== 'object') return;
  if (g.clock && Number.isFinite(g.clock.day) && Number.isFinite(g.clock.hour)) {
    clock.day = Math.max(1, Math.floor(g.clock.day));
    clock.hour = ((g.clock.hour % 24) + 24) % 24;
  }
  beach.state = Beach.restore(g.beach);
  beachView.sync();
  boatMotion.update(time, 1);
  const p = g.player;
  if (p && Array.isArray(p.pos) && p.pos.length === 3 && p.pos.every(Number.isFinite)) {
    const v = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]);
    if (p.mode === 'deck') player.placeAboard(v, p.yaw ?? START_YAW);
    else player.placeWorld(v.x, v.z, p.yaw ?? START_YAW);
    if (Number.isFinite(p.pitch)) player.pitch = p.pitch as number;
  }
  daylight.refresh();
  washIfDue();
}

function requestSave(): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    if (!host || !ready) return resolve(null);
    const id = saveSeq++;
    saveWaiters.set(id, (data, error) => {
      if (error) console.warn('Save failed:', error);
      resolve(data);
    });
    host.send({ t: 'save', id, header: { camera: cam.state, game: gameState() } });
  });
}

let saving = false;
async function autosave(force = false): Promise<void> {
  if (saving || !ready || !started) return;
  saving = true;
  try {
    const data = await requestSave();
    if (data && (await saveAutosave(data))) changedSinceSave = false;
  } finally {
    saving = false;
  }
  void force;
}
// The clock, you and the finds always change, so save every minute while playing.
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
  if (await downloadFile(data, `sandcastle-cays-${stamp}.sandsave`)) ui.toast('Saved to a file');
  else ui.toast('Not saved to a file this time');
}

async function loadFromFile(): Promise<void> {
  const picked = await pickFile('.sandsave,.json,application/octet-stream,application/json');
  if (!picked || !host) return;
  const data = unwrapSave(picked);
  host.send({ t: 'load', id: saveSeq++, data }, [data]);
}

function newBeach(): void {
  host?.send({ t: 'reset' });
  changedSinceSave = true;
  ui.toast('The cove’s sand is smooth again');
}

function newGame(): void {
  if (view === 'build') exitBuild();
  host?.send({ t: 'reset' });
  void clearAutosave();
  clock.day = 1;
  clock.hour = DAY.start;
  beach.state = Beach.fresh();
  beach.washUp(1);
  beachView.sync();
  player.placeAboard(sloop.points.spawn, START_YAW);
  daylight.refresh();
  ui.toast('A fresh start at Home Cay');
}

function takePhoto(): void {
  cursor.hide();
  pipeline.render(false, player.feet);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const d = new Date();
    void downloadFile(blob, `sandcastle-cays-${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`, 'image/png').then((ok) => {
      if (ok) ui.toast('Photo saved');
    });
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
    detail: where === 'browser' ? 'yes (browser storage)' : where === 'backup' ? 'yes (backup storage, smaller)' : 'no: use "Save to a file" to keep your game',
  });
  const results = await new Promise<CheckResult[]>((resolve) => {
    checksWaiter = resolve;
    host?.send({ t: 'checks', id: 1 });
  });
  // Measure smoothness for a few seconds after the checks.
  const f0 = frames;
  const s0 = performance.now();
  await new Promise((r) => setTimeout(r, 4000));
  const fps = ((frames - f0) / (performance.now() - s0)) * 1000;
  extra.push({
    label: 'Smooth on this device',
    pass: fps >= 28,
    detail: `${Math.round(fps)} frames per second (30 or more is smooth) · graphics: ${pipeline.quality}, sharpness ${pipeline.pixelRatio.toFixed(2)}`,
  });
  ui.showChecks(results, extra);
}

// ---------- start ----------

async function readSaveHeader(save: ArrayBuffer): Promise<unknown> {
  try {
    const raw = await decompress(new Uint8Array(save.slice(0)));
    return decodeHeader(raw).game ?? null;
  } catch {
    return null;
  }
}

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
  const game = save ? await readSaveHeader(save) : null;
  player.placeAboard(sloop.points.spawn, START_YAW);
  if (game) restoreGame(game);
  else {
    beach.washUp(clock.day);
    beachView.sync();
  }
  host.send({ t: 'init', save, settings: { drying: settings.drying }, focus: [0, 0.2, 0.8] }, save ? [save] : []);
  console.log(`Sandcastle Cays v${GAME_VERSION} (${__BUILD_TIME__}), engine on ${host.mode}`);
}

function startPlaying(): void {
  if (!ready || started) return;
  started = true;
  ui.hideStart();
  if (settings.sound) audio.start();
  view = 'fp';
  input.enabled = true;
  hud.setMode('fp');
  if (!isTouch) void input.lock();
  updateLookHint();
  canvas.focus();
  if (!resumed) {
    window.setTimeout(
      () => hud.showCard('Home Cay', isTouch ? 'Your boat is anchored off the island. Walk to the ladder at the back to climb down and swim ashore.' : 'Your boat is anchored off the island. Walk (W A S D) to the ladder at the back to climb down and swim ashore.', 7000),
      800,
    );
  }
}

/** New finds wash up each morning. */
function washIfDue(): void {
  const st = beach.state;
  if (st.lastWash < clock.day && clock.hour >= DAY.washUpHour) {
    const n = beach.washUp(clock.day);
    beachView.sync();
    if (started && n > 0 && clock.hour < DAY.washUpHour + 1.5) hud.showCard('The tide has been in', 'New things have washed up along the beaches.', 4500);
  }
}

// ---------- what you can do right now ----------

type Action =
  | { kind: 'pick'; id: number; label: string }
  | { kind: 'climb'; label: string }
  | { kind: 'climbdown'; label: string }
  | { kind: 'locker'; label: string }
  | { kind: 'build'; label: string }
  | null;

const center = new THREE.Vector2(0, 0);
const tmpV = new THREE.Vector3();
function currentAction(): Action {
  if (player.mode === 'climb') return null;
  if (player.nearLadder()) return { kind: 'climb', label: 'Climb aboard' };
  if (player.atLadderTop()) return { kind: 'climbdown', label: 'Climb down the ladder' };
  raycaster.setFromCamera(center, camera);
  const f = beachView.pick(raycaster.ray, camera.position, PLAYER.reach);
  if (f) return { kind: 'pick', id: f.id, label: `Pick up the ${FINDS[f.kind].name.toLowerCase()}` };
  if (player.mode === 'deck') {
    const lk = sloop.points.locker;
    if (Math.hypot(player.pos.x - lk.x, player.pos.z - lk.z) < 1.4) {
      if (beach.state.basket.length) return { kind: 'locker', label: 'Empty your basket into the locker' };
    }
  }
  if (canBuildHere()) return { kind: 'build', label: 'Kneel and build' };
  return null;
}

function doAction(a: Action): void {
  if (!a) return;
  if (a.kind === 'pick') pickUp(a.id);
  else if (a.kind === 'climb') {
    if (player.climbAboard()) audio.ladder();
  } else if (a.kind === 'climbdown') {
    if (player.climbDown()) audio.ladder();
  } else if (a.kind === 'locker') {
    const n = beach.emptyBasket();
    audio.locker();
    hud.showCard('Stowed', `${n} ${n === 1 ? 'find' : 'finds'} put away in the locker. The logbook lists everything aboard.`, 3500);
    changedSinceSave = true;
  } else if (a.kind === 'build') enterBuild();
}

function pickUp(id: number): void {
  const r = beach.pickUp(id);
  if (!r.ok) {
    if (r.reason === 'full') ui.toast('Your basket is full. Empty it into the locker aboard.', 3200);
    return;
  }
  beachView.sync();
  held.pickupNudge();
  audio.chime(r.first);
  changedSinceSave = true;
  if (navigator.vibrate) navigator.vibrate(10);
  const info = FINDS[r.kind];
  if (r.first) hud.showCard(`New: ${cap(info.name)}`, info.firstLine, 6000);
  if (beach.basketFull) ui.toast('That fills your basket. Time to take it back aboard.', 3200);
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
let farWarned = 0;
const sunView = new THREE.Vector3();
const blendTarget = new THREE.Vector3();

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  frames++;
  renderer.info.reset();
  host?.tick(dt);

  boatMotion.update(time, dt);

  // The clock (paused while a menu or the logbook is open).
  if (started && !anyPanelOpen() && !holdTime) {
    advanceClock(clock, dt);
    washIfDue();
  }

  if (started && view === 'fp') {
    input.update();
    const paused = anyPanelOpen();
    if (!paused) {
      player.look(input.lookYaw, input.lookPitch);
      const action = currentAction();
      hud.setPrompt(action ? action.label : null, action?.kind === 'build' ? 'B' : 'E');
      // Taps on a phone (or clicks in drag-look mode) pick up what they touch.
      for (const tap of input.takeTaps()) {
        const r = screenRay(tap.x, tap.y);
        const f = beachView.pick(r, camera.position, PLAYER.reach + 0.4);
        if (f) pickUp(f.id);
      }
      if (input.wasPressed('KeyE') || input.wasPressed('Use') || input.wasPressed('Action')) doAction(action);
      if (input.wasPressed('KeyB') && canBuildHere()) enterBuild();
      const jump = input.wasPressed('Space');
      if (jump && player.nearLadder()) {
        if (player.climbAboard()) audio.ladder();
      }
      const ev = player.update(dt, input.move, input.running, jump && player.mode !== 'swim');
      for (const s of ev.steps) audio.footstep(s);
      if (ev.splash > 0) audio.splash(ev.splash);
      if (ev.climbed) audio.ladder();
      if (ev.tooFar && time - farWarned > 8) {
        farWarned = time;
        ui.toast('That’s far enough from home for now.', 2500);
      }
    } else {
      input.takeTaps();
      hud.setPrompt(null);
      player.update(dt, { x: 0, y: 0 }, false, false);
    }
    hud.setStick(input.stickView);
    input.endFrame();
  } else if (started) {
    // Building: you stay where you knelt; the boat still rocks you if aboard.
    player.update(dt, { x: 0, y: 0 }, false, false);
  } else {
    player.refresh();
  }

  // Camera.
  if (view === 'build') {
    controls.update(dt);
    cam.update(dt);
  } else {
    player.applyCamera(camera, boatMotion.rollAngle);
  }
  if (blend) {
    blend.t = Math.min(1, blend.t + dt / 0.55);
    const k = blend.t * blend.t * (3 - 2 * blend.t);
    blendTarget.copy(camera.position);
    const q = camera.quaternion.clone();
    camera.position.lerpVectors(blend.fromPos, blendTarget, k);
    camera.quaternion.slerpQuaternions(blend.fromQuat, q, k);
    if (blend.t >= 1) blend = null;
  }
  camera.updateMatrixWorld();
  updateSandDetail();

  focusTimer -= dt;
  if (focusTimer <= 0 && host) {
    focusTimer = 0.3;
    if (view === 'build') host.send({ t: 'focus', x: cam.target.x, y: cam.target.y, z: cam.target.z });
    else host.send({ t: 'focus', x: player.feet.x - Math.sin(player.yaw) * 2, y: player.feet.y, z: player.feet.z - Math.cos(player.yaw) * 2 });
  }

  // Light, sky and water.
  const light = daylight.update(dt, time, clock);
  sky.update(time, camera.position);
  ocean.update(time, camera.position);
  sandUniforms.uTime.value = time;
  sunView.copy(SKY.sunDir).transformDirection(camera.matrixWorldInverse);
  sandUniforms.uSunView.value.copy(sunView);
  particles.uniforms.uSunView.value.copy(sunView);
  swayTime.value = time;
  cursor.update(dt, time);
  beachView.update(player.feet);

  // What you're carrying.
  held.setContents(beach.state.basket);
  held.update(dt, {
    walking: Math.min(1, player.speed / 2),
    hide: !started || view !== 'fp' || player.mode === 'swim' || player.mode === 'climb' || anyPanelOpen(),
    sunDir: sunView,
    sunColor: SKY.sunColor,
    sunIntensity: sun.intensity,
    hemiIntensity: hemi.intensity,
    env: envTex,
  });
  hud.setBasket(beach.state.basket.length);
  hud.setClock(formatClock(clock));
  updateLookHint();

  // Sound: louder surf near the beach.
  const shoreDist = Math.abs(terrain.inland(player.feet.x, player.feet.z));
  audio.setShore(Math.max(0, 1 - shoreDist / 40));
  const lapH = seaHeight(player.feet.x, player.feet.z, time);
  audio.update(dt, Math.min(1, Math.max(0, 0.5 + lapH / 0.08)), pendingEvents, handWet / 255);
  pendingEvents = null;

  pipeline.shadowSpan = view === 'build' ? Math.min(14, Math.max(4, cam.dist * 1.1)) : 16;
  pipeline.render(started && view === 'fp' && !blend, view === 'build' ? cam.target : player.feet);
  void light;

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
        if (pipeline.stepDown()) resize();
      }
    }
    if (debug) {
      const info = renderer.info.render;
      ui.fpsEl.textContent = `${fpsShown} fps · ${host?.mode} · ${pipeline.quality} ×${pipeline.pixelRatio.toFixed(2)} · draws ${info.calls} · tris ${Math.round(info.triangles / 1000)}k · ${player.mode}${lastPerf ? ` · sim ${lastPerf.simMs.toFixed(1)}ms` : ''}`;
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
  get view() {
    return view;
  },
  get fps() {
    return fpsShown;
  },
  get frameCount() {
    return frames;
  },
  get triangles() {
    return sand.triangleCount;
  },
  get hand() {
    return handAmount;
  },
  get perf() {
    return lastPerf;
  },
  get undo() {
    return undoCount;
  },
  get render() {
    const r = renderer.info.render;
    return { calls: r.calls, triangles: r.triangles };
  },
  start: () => startPlaying(),
  selectTool: (t: ToolId) => selectTool(t),
  runChecks: () =>
    new Promise<CheckResult[]>((resolve) => {
      checksWaiter = resolve;
      host?.send({ t: 'checks', id: 2 });
    }),
  camera: cam,
  player,
  beach,
  clock,
  sloop,
  input,
  terrain,
  /** Screen position (CSS pixels) of a point in the world. */
  project: (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  },
  ground: (x: number, z: number) => ground.heightAt(x, z),
  sea: (x: number, z: number) => seaHeight(x, z, time),
  demo: () => host?.send({ t: 'demo' }),
  debugSand: (mode: number) => (sandUniforms.uDebug.value = mode),
  enterBuild,
  exitBuild,
  canBuildHere,
  action: () => currentAction(),
  doAction: () => doAction(currentAction()),
  /** Stand at a world spot, looking along yaw/pitch. */
  teleport: (x: number, z: number, yaw = 0, pitch = -0.2) => {
    if (view === 'build') exitBuild();
    player.placeWorld(x, z, yaw);
    player.pitch = pitch;
  },
  aboard: (yaw = START_YAW, pitch = -0.1) => {
    if (view === 'build') exitBuild();
    player.placeAboard(sloop.points.spawn, yaw);
    player.pitch = pitch;
  },
  setHour: (h: number) => {
    clock.hour = h;
    daylight.refresh();
  },
  holdTime: (on: boolean) => (holdTime = on),
  envInterval: (s: number) => (daylight.envInterval = s),
  save: () => autosave(true),
  gameState,
  /** Look at a find: aim the view at it from where you stand. */
  lookAt: (x: number, y: number, z: number) => {
    const e = player.eye;
    player.yaw = Math.atan2(-(x - e.x), -(z - e.z));
    player.pitch = Math.atan2(y - e.y, Math.hypot(x - e.x, z - e.z));
  },
  pickUp,
  /** Test helper: walk (or swim) with a fixed stick input for some seconds, in small even steps (independent of the frame rate). */
  walk: (seconds: number, x: number, y: number, run = false, steerToLadder = false) => {
    for (let t = 0; t < seconds; t += 1 / 30) {
      boatMotion.update(time, 1 / 30);
      if (steerToLadder && player.mode === 'deck') {
        // Head for a spot just past the top of the swim ladder.
        const lt = sloop.points.ladderTop;
        const goal = sloop.group.localToWorld(new THREE.Vector3(lt.x - 0.6, lt.y, lt.z));
        player.yaw = Math.atan2(-(goal.x - player.feet.x), -(goal.z - player.feet.z));
      }
      player.update(1 / 30, { x, y }, run, false);
    }
    return player.mode;
  },
  emptyBasket: () => beach.emptyBasket(),
  logbook: toggleLogbook,
  quality: () => pipeline.quality,
  get canvasPixels() {
    return { w: renderer.domElement.width, h: renderer.domElement.height };
  },
  isTouch,
  setQuality: (q: QualityName) => pipeline.setQuality(q),
  vec: (x: number, y: number, z: number) => new THREE.Vector3(x, y, z),
  get basket() {
    return beach.state.basket.slice();
  },
  get playerMode() {
    return player.mode;
  },
  heldVisible: () => held.scene.children.length > 0,
  get feet() {
    return player.feet.toArray();
  },
  ocean,
  seaFloor,
  sky,
  scene,
  sandInfo: () => ({ edited: editedTiles.size, shown: sand.group.children.filter((m) => m.visible).length, tiles: sand.group.children.length, standIn: standIn.visible }),
  time: () => time,
};
