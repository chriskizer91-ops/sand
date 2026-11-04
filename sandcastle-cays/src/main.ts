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
import { Wake } from './render/wake';
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
import { createCatamaran } from './render/catamaran';
import { FINDS } from './content/finds';
import { Beach, BeachView } from './game/beach';
import { Player, type PlayerMode } from './player/player';
import { GroundMap } from './world/ground';
import { reefChannel } from './world/homeCay';
import { WorldTerrain } from './world/world';
import { SAILING, autopilot, boomAngle, deepWaterNear, dropAnchor, newBoat, pointOfSail, sailFill, stepBoat, weighAnchor, windAngle, windAt, type BoatState, type Course, type WindState } from './game/sailing';
import { SEA_CENTRE, SEA_RADIUS, newWeather, openness, squallsAt, weatherAt, windWord, type Squall } from './game/weather';
import { createSeaBuoy } from './render/buoy';
import { WeatherFx } from './render/weatherFx';
import { downloadFile, loadAutosave, loadSettings, pickFile, saveAutosave, saveSettings, testStorage, clearAutosave, unwrapSave } from './storage/storage';
import { Hud, cap } from './ui/hud';
import { SailHud } from './ui/sailHud';
import { Chart } from './ui/chart';
import { DevTools } from './ui/devTools';
import { Living, type LivingAction, type LivingRig, type RodView } from './living';
import { FishingLine } from './render/fishingGear';
import { prepareFish } from './render/fish';
import { Gardening, type GardenAction, type GardenViews } from './gardening';
import { HOME_GARDEN } from './world/homeCay';
import { DECK_POT_SCALE, GARDEN_SOIL, PlantView, barrelModel, bedModel, potModel, signModel } from './render/garden';
import { Ui } from './ui/ui';
import { ICONS } from './ui/icons';
import { DinghyCtl, type DinghyAction } from './dinghyCtl';
import { SharkLife } from './sharkLife';
import { Guide, type NotebookPage } from './ui/guide';
import { BANK } from './world/sharkBank';
import { dentDinghy, type Upgrade } from './game/aboard';
import { motorRunning } from './game/dinghy';
import { SHARK_INFO, type SharkEvent, type SharkZone, type YouHow } from './game/sharks';
import { BIG_FISH_KG, CHAPTERS, TIPS, atLeast, chapterNow, checkStory, count as storyCount, doneKeys, goalDone, howTo, newStory, nextGoal, note, restoreStory, takeTip, tipText, type Fact, type StoryState } from './game/story';
import type { CheckResult } from './checks/sandChecks';

declare const __BUILD_TIME__: string;

const settings = loadSettings();
const world = new WorldTerrain();
/** Home Cay: the cove with the sandcastle sand, the reef and the lagoon. */
const terrain = world.home;
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
const islandGround = createIslandGround(terrain, sandUniforms);
islandGround.name = 'island';
scene.add(islandGround);
const pinkGround = createIslandGround(world.pink, sandUniforms);
pinkGround.name = 'pinkIsland';
scene.add(pinkGround);
// Shark Bank: a bare sandbar in wide, shallow sand flats (v0.8).
// Only the bank itself (not the deep floor round it), in a few big, plain pieces: it's mostly seen through the water.
const bankGround = createIslandGround(world.bank, sandUniforms, { x0: BANK.x - 128, x1: BANK.x + 128, z0: BANK.z - 128, z1: BANK.z + 128 }, { wetStep: 2, tileSquares: 8 });
bankGround.name = 'bankIsland';
scene.add(bankGround);
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
const pinkLife = createIslandLife(world.pink, swayTime);
pinkLife.group.name = 'pinkLife';
scene.add(pinkLife.group);
const ground = new GroundMap(world);
ground.rocks = [...coveRocks.blobs, ...life.rocks, ...pinkLife.rocks];
const trunks = [...life.trunks, ...pinkLife.trunks];

const seaFloor = new SeaFloorMap((x, z) => Math.max(world.heightAt(x, z), rockTop(ground.rocks, x, z)), -20, -40, 880, 340);
const ocean = new Ocean(seaFloor, SKY.sunDir, SKY.sunColor, (scene.fog as THREE.FogExp2).color, isTouch ? 170 : 220);
ocean.mesh.name = 'ocean';
scene.add(ocean.mesh);
const seaHeight = (x: number, z: number, t: number) => ocean.heightAt(x, z, t);

// Your boat: a 45 ft catamaran (v0.7; the old sloop is in render/sloop.ts). Still called "sloop" in this file.
const BOAT_IS_CAT = true;
const sloop = createCatamaran();
scene.add(sloop.group);
sloop.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) {
    o.castShadow = true;
    o.receiveShadow = true;
  }
});
/** Where the boat's hulls are, to either side of her centreline (one hull: [0]; the catamaran: two). */
const boatHulls: number[] = BOAT_IS_CAT ? SAILING.hulls : [0];
const boatMotion = new BoatMotion(sloop.group, sloop.length, sloop.beam, seaHeight, BOAT_IS_CAT ? SAILING.heelShown : 1);
/** Your boat under way (or at anchor), and the wind. */
let boat: BoatState = newBoat(terrain.anchorage.x, terrain.anchorage.z, terrain.anchorage.heading);
/** The wind where your boat is (and the rain, and how open the sea is). */
const wind = newWeather();
/** The squalls about now (plus one the checks can call up). */
const squalls: Squall[] = [];
let forcedSquall: (Squall & { t0?: number; x0?: number; z0?: number }) | null = null;
/** Dev tools: squalls on or off, the wind's strength, the game's speed. */
let devSqualls = true;
let devWindK = 1;
let devSpeed = 1;
function updateWeather(t: number): void {
  squallsAt(t, squalls);
  if (!devSqualls) squalls.length = 0;
  if (forcedSquall) {
    const f = forcedSquall;
    if (f.t0 !== undefined) {
      // A squall called up from the dev tools drifts in on the wind.
      f.x = f.x0! + f.vx * (t - f.t0);
      f.z = f.z0! + f.vz * (t - f.t0);
      f.strength = Math.min(1, (t - f.t0) / 20 + 0.3);
      if (f.x < SEA_CENTRE.x - 1800) forcedSquall = null;
    }
    if (forcedSquall) {
      squalls.unshift(forcedSquall);
      if (squalls.length > 4) squalls.length = 4;
    }
  }
  weatherAt(t, boat.x, boat.z, wind, squalls);
  wind.speed *= devWindK;
}
/** The slope of the sea under the boat along her bow (+ = downhill ahead: a wave lifting her stern). */
function seaSlope(t: number): number {
  const c = Math.cos(boat.heading);
  const s = Math.sin(boat.heading);
  const L = sloop.length * 0.4;
  return (seaHeight(boat.x - c * L, boat.z - s * L, t) - seaHeight(boat.x + c * L, boat.z + s * L, t)) / (2 * L);
}
/** The sea floor for the keel: the ground and any rocks or coral heads. */
const seaBed = { floorAt: (x: number, z: number) => Math.max(world.heightAt(x, z), rockTop(ground.rocks, x, z)) };

// A wake behind each hull.
const wakes = boatHulls.map(() => new Wake());
for (const w of wakes) scene.add(w.mesh);
const particles = new SandParticles();
scene.add(particles.points);
const cursor = new BrushCursor();
scene.add(cursor.mesh);
cursor.hide();

// What the under-the-water picture can skip: anything that never sits below the surface.
const refractSkip: THREE.Object3D[] = [];
// Squall clouds, rain and spray.
const weatherFx = new WeatherFx({ phone: isTouch });
scene.add(weatherFx.group);
const staticSkip: THREE.Object3D[] = [sky.mesh, particles.points, cursor.mesh, distant, covePlants, ...wakes.map((w) => w.mesh), weatherFx.group];
pinkGround.traverse((o) => o.userData.dry && staticSkip.push(o));
bankGround.traverse((o) => o.userData.dry && staticSkip.push(o));
islandGround.traverse((o) => o.userData.dry && staticSkip.push(o));
life.group.traverse((o) => o.userData.dry && staticSkip.push(o));
pinkLife.group.traverse((o) => o.userData.dry && staticSkip.push(o));
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
  weatherFx.setViewport(h * renderer.getPixelRatio());
}
window.addEventListener('resize', resize);

// ---------- game state ----------

const clock: Clock = { day: 1, hour: DAY.start };
const beach = new Beach([...terrain.tideline(0.6), ...world.pink.tideline(0.6), ...world.bank.tideline(0.6)]);
const beachView = new BeachView(beach, findModel, (x, z) => ground.heightAt(x, z));
scene.add(beachView.group);
scene.add(beachView.glints);
// Glints never sit under the water: the water picture can skip them.
staticSkip.push(beachView.glints);
rebuildRefractSkip();

/** You can swim and walk anywhere around both cays. */
// You can swim anywhere your boat can sail (and a little more, so jumping off at the edge works).
const ISLAND_CENTRE = { cx: -100, cz: -140, r: 1090 };
// The garden's beds and rain barrel are solid too (two circles per bed, one for the barrel).
const gardenSolid = [
  ...HOME_GARDEN.beds.flatMap((b) => [-0.42, 0.42].map((d) => ({ x: b.x + Math.cos(b.rot) * d, z: b.z - Math.sin(b.rot) * d, r: 0.5 }))),
  { x: HOME_GARDEN.barrel.x, z: HOME_GARDEN.barrel.z, r: 0.38 },
];
const player = new Player({
  groundAt: (x, z) => ground.heightAt(x, z),
  waterAt: (x, z) => seaHeight(x, z, time),
  trunks: [...trunks, ...gardenSolid],
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
    devTools: () => toggleDevTools(true),
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
    chart: () => toggleChart(),
    notebook: () => toggleNotebook(),
  },
  settings,
);
ui.setTool(tool);
let showFps = debug;
if (showFps) ui.fpsEl.style.display = 'block';

const hud = new Hud(
  {
    action: () => input.press('Action'),
    jump: () => input.press('Space'),
    logbook: () => toggleLogbook(),
    standUp: () => exitBuild(),
    click: () => audio.click(),
    stores: () => living.showGalley(!living.galley.open),
    rod: () => living.toggleRod(),
    hold: (on) => input.hold('Action', on),
    button: (id) => {
      if (id === 'motor') dinghy.toggleMotor();
      else if (id === 'bait') throwBait();
    },
  },
  isTouch,
);
hud.setMode('none');

// ---------- sailing ----------

let atHelm = false;
let course: Course | null = null;
let helmTipShown = false;
let ironsTime = 0;
let ironsTipShown = false;
let lastSea = 0;
/** Sailing records: times round the sea buoy, and the fastest run from Home Cay round it and back (seconds). */
const records = { rounds: 0, best: 0 };
/** The run in progress: when the anchor came up at Home Cay, and whether she's rounded the buoy since. */
let run = { start: -1, rounded: false };
let wasAnchored = true;

function minSec(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return `${m} min ${s < 10 ? '0' : ''}${s} s`;
}

/** The sea buoy and the run out round it and home. */
function buoyRun(): void {
  const nearHome = Math.hypot(boat.x - terrain.anchorage.x, boat.z - terrain.anchorage.z) < 90;
  if (wasAnchored && !boat.anchored) run = nearHome ? { start: time, rounded: false } : { start: -1, rounded: false };
  if (!boat.anchored && !run.rounded && Math.hypot(boat.x - BUOY.x, boat.z - BUOY.z) < 45) {
    run.rounded = true;
    records.rounds++;
    changedSinceSave = true;
    audio.chime(records.rounds === 1);
    ui.toast(run.start >= 0 ? `Round the sea buoy! ${minSec(time - run.start)} out from Home Cay. Now home!` : 'Round the sea buoy!', 3500);
  }
  if (!wasAnchored && boat.anchored && nearHome && run.rounded && run.start >= 0) {
    const t = time - run.start;
    const best = !records.best || t < records.best;
    const before = records.best;
    if (best) records.best = t;
    changedSinceSave = true;
    hud.showCard('Home from the sea buoy', best ? `Out round the buoy and home in ${minSec(t)}${before ? ` (your old best was ${minSec(before)})` : ''}: your best yet!` : `Out round the buoy and home in ${minSec(t)}. Your best is ${minSec(records.best)}.`, 7000);
    run = { start: -1, rounded: false };
  }
  wasAnchored = boat.anchored;
}

/** Spray over the bow: the sea rising fast against her bow as she drives into a wave. */
const bowV = new THREE.Vector3();
let lastBowRel: number[] = [];
let sprayCool = 0;
const sprayStats = { bursts: 0, maxRise: 0 };
let onSpray: ((x: number, y: number, z: number, dx: number, dz: number, k: number) => void) | null = null;
function bowSpray(dt: number): void {
  if (boat.anchored || boat.speed < 1.5) {
    lastBowRel = [];
    return;
  }
  const c = Math.cos(boat.heading);
  const sn = Math.sin(boat.heading);
  // Each bow: whichever slams into a wave hardest throws the spray.
  let rise = -Infinity;
  let rel = 0;
  const at = new THREE.Vector3();
  boatHulls.forEach((off, i) => {
    bowV.set(sloop.length * 0.47, 0.15, off);
    sloop.group.localToWorld(bowV);
    const r = seaHeight(bowV.x, bowV.z, time) - bowV.y;
    const ri = dt > 0 && lastBowRel[i] !== undefined ? (r - lastBowRel[i]) / dt : 0;
    lastBowRel[i] = r;
    if (ri > rise) {
      rise = ri;
      rel = r;
      at.copy(bowV);
    }
  });
  bowV.copy(at);
  sprayCool -= dt;
  if (boat.anchored || boat.speed < 1.8 || dt <= 0) return;
  sprayStats.maxRise = Math.max(sprayStats.maxRise, rise);
  if (rise > SPRAY_RISE && rel > -0.25 && sprayCool <= 0) {
    const k = Math.min(1, (rise - SPRAY_RISE) / 1.2 + 0.25) * Math.min(1, boat.speed / 4.3);
    sprayCool = 2.2;
    sprayStats.bursts++;
    if (player.aboard) audio.slam(k);
    onSpray?.(bowV.x, bowV.y + 0.6, bowV.z, c, sn, k);
  }
}
const SPRAY_RISE = 1.15;
onSpray = (x, y, z, dx, dz, k) => weatherFx.spray(x, y, z, dx, dz, k, time, boat.speed);

/** Surfing speed now (smoothed), how long she's been overpowered, and when we last said so. */
let surfing = 0;
let overTime = 0;
let lastOverTip = -99;
/** Weather notes: the open-sea card (once), whether you're out there now, squalls already warned about. */
let openCardShown = false;
let outAtSea = false;
const warnedSqualls = new Set<number>();
/** The weather where you stand (rain, squall overhead), smoothed. */
const here = newWeather();
let rainNow = 0;
let overheadNow = 0;
const tradeWind: WindState = windAt(0);

function weatherNotes(dt: number): void {
  void dt;
  if (!started || !player.aboard || boat.anchored) return;
  if (!outAtSea && wind.open > 0.55) {
    outAtSea = true;
    if (!openCardShown) {
      openCardShown = true;
      hud.showCard(
        'The open sea',
        'Out past the reefs the wind blows harder and a long swell rolls in from the east. If she leans too far, take in some sail. Running before the waves with the wind behind you, she’ll surf.',
        9000,
      );
    } else ui.toast('The open sea', 1800);
  } else if (outAtSea && wind.open < 0.2) outAtSea = false;
  for (const q of squalls) {
    if (q.strength < 0.35 || warnedSqualls.has(q.id)) continue;
    const edge = Math.hypot(q.x - boat.x, q.z - boat.z) - q.radius;
    // Coming your way (it drifts west) and close.
    if (edge < 260 && edge > 0 && (boat.x - q.x) * q.vx + (boat.z - q.z) * q.vz > 0) {
      warnedSqualls.add(q.id);
      ui.toast('A squall is coming: wind and rain. Take in some sail if she leans too far.', 4000);
    }
  }
}
const RIG_SPEED = { boom: 0 };
interface Rig {
  setSail(a: number): void;
  setBoom(a: number): void;
  setJib(a: number): void;
  setFill(f: number, t: number): void;
  setRudder(a: number): void;
  setAnchored(down: boolean): void;
  setMotor?(throttle: number, time: number): void;
  setLights?(mode: 'anchor' | 'underway', night: number): void;
}
const rig: Rig | null = sloop.rig ?? null;

const sailHud = new SailHud(
  {
    sailUp: () => sailUp(),
    sailDown: () => sailDown(),
    motorUp: () => motorUp(),
    motorDown: () => motorDown(),
    anchor: () => toggleAnchor(),
    chart: () => toggleChart(),
    leaveHelm: () => leaveHelm(),
    click: () => audio.click(),
  },
  isTouch,
);

/** The sea buoy, out on the open sea to the south-east: close-hauled out to it, surfing home. */
const BUOY = { x: 560, z: -820 };
const seaBuoy = createSeaBuoy(BUOY.x, BUOY.z);
scene.add(seaBuoy.group);
const PLACES = [
  { id: 'home', name: 'Home Cay', x: terrain.anchorage.x, z: terrain.anchorage.z, labelDx: 0, labelDz: 240 },
  { id: 'pink', name: 'Pink Sand Cay', x: world.pink.anchorage.x, z: world.pink.anchorage.z, labelDx: 40, labelDz: -175 },
  { id: 'buoy', name: 'the sea buoy', label: 'sea buoy', button: 'Round the sea buoy and come home', mark: true, x: BUOY.x, z: BUOY.z, labelDx: 0, labelDz: -95 },
  { id: 'bank', name: 'Shark Bank', x: world.bank.anchorage.x, z: world.bank.anchorage.z, labelDx: 90, labelDz: 120 },
];
/** Round the west of Home Cay to Shark Bank, keeping clear of the reef and the bank's flats. */
const BANK_ROUTE = [
  { x: -230, z: -40 },
  { x: -470, z: 100 },
];
const channel = reefChannel(terrain);
const chart = new Chart(
  {
    heightAt: (x, z) => world.heightAt(x, z),
    groundAt: (x, z, h) => world.islandAt(x, z).groundAt(x, z, h),
    openness,
    sea: { x: SEA_CENTRE.x, z: SEA_CENTRE.z, r: SEA_RADIUS },
  },
  PLACES,
  channel.outside,
  {
    sailTo: (id) => startCourse(id),
    stop: () => stopCourse('You have her now: take the helm to steer.'),
    close: () => toggleChart(false),
    click: () => audio.click(),
  },
);

function toggleChart(show?: boolean): void {
  const open = show ?? !chart.open;
  if (open) {
    ui.closePanels();
    hud.showLogbook(false);
    guide.show(false);
    input.unlock();
    input.clear();
    renderChart();
  }
  chart.show(open);
}

function renderChart(): void {
  chart.render(boat, wind.from, course ? course.name : null, player.aboard, player.aboard ? null : { x: player.feet.x, z: player.feet.z }, course ? course.waypoints : [], squalls);
}

function nearHelm(): boolean {
  const h = sloop.points.helm;
  return player.mode === 'deck' && Math.abs(player.pos.y - h.y) < 0.6 && Math.hypot(player.pos.x - h.x, player.pos.z - h.z) < 1.2;
}

function takeHelm(): void {
  living.putRodAway(true);
  if (player.mode !== 'deck') return;
  atHelm = true;
  player.placeAboard(sloop.points.helm.clone(), player.yaw);
  audio.click();
  if (!helmTipShown) {
    helmTipShown = true;
    hud.showCard(
      'You have the helm',
      isTouch
        ? 'Steer with your left thumb. Raise the sails with “More sail”, or use the motor buttons. You can’t sail straight into the wind: if the sails flap, turn away from it (or use the motor).'
        : 'A and D steer, W and S raise and lower the sails, R and F work the motor, X drops or raises the anchor, M opens the chart, E lets go. You can’t sail straight into the wind: if the sails flap, turn away from it (or use the motor).',
      9000,
    );
  }
}

/** The outboard's settings: full astern, half astern, off, slow ahead, half ahead, full ahead. */
const THROTTLE_STEPS = [-1, -0.5, 0, 0.35, 0.65, 1];
function throttleIndex(): number {
  const t = boat.throttle ?? 0;
  let best = 2;
  for (let i = 0; i < THROTTLE_STEPS.length; i++) if (Math.abs(THROTTLE_STEPS[i] - t) < Math.abs(THROTTLE_STEPS[best] - t)) best = i;
  return best;
}
function setThrottle(i: number): void {
  const was = boat.throttle ?? 0;
  const t = THROTTLE_STEPS[Math.max(0, Math.min(THROTTLE_STEPS.length - 1, i))];
  if (boat.anchored && t !== 0) {
    // As with the sails: the anchor comes up first.
    weighAnchor(boat);
    audio.anchorChain(false);
    ui.toast('Anchor up', 1800);
  }
  boat.throttle = t;
  if (course) stopCourse(null);
  if (was === 0 && t !== 0) audio.motorStart();
  changedSinceSave = true;
}
function motorUp(): void {
  setThrottle(throttleIndex() + 1);
}
function motorDown(): void {
  setThrottle(throttleIndex() - 1);
}
function motorWord(t: number): string {
  if (t === 0) return 'off';
  if (t < -0.75) return 'full astern';
  if (t < 0) return 'slow astern';
  if (t < 0.5) return 'slow ahead';
  if (t < 0.9) return 'half ahead';
  return 'full ahead';
}

function leaveHelm(): void {
  if (!atHelm) return;
  atHelm = false;
  // Nobody leaves an outboard running with no one at the tiller.
  if ((boat.throttle ?? 0) !== 0 && !course) {
    boat.throttle = 0;
    ui.toast('You throttle the motor off as you let go of the tiller.', 3000);
  }
  if (!boat.anchored && boat.sail > 0.05 && !course) ui.toast('With nobody steering she’ll turn into the wind and slow down.', 3500);
}

function sailUp(): void {
  if (boat.anchored) {
    weighAnchor(boat);
    audio.anchorChain(false);
    ui.toast('Anchor up', 1800);
  }
  boat.sailSet = boat.sailSet < 0.25 ? 0.5 : 1;
  if (course) stopCourse(null);
  changedSinceSave = true;
}

function sailDown(): void {
  boat.sailSet = boat.sailSet > 0.75 ? 0.5 : 0;
  if (course) stopCourse(null);
}

// ---------- dev tools ----------

const devTools = new DevTools(
  {
    goTo: (id) => devGoTo(id),
    pushOff: () => {
      if (!startPushOff()) return;
    },
    repairHull: () => {
      boat.hull = 100;
      ui.toast('Hull mended', 1500);
    },
    stopBoat: () => {
      boat.speed = 0;
      boat.sailSet = boat.sail = 0;
      boat.throttle = boat.motor = 0;
      if (course) stopCourse(null);
    },
    squallHere: () => {
      forcedSquall = { id: -2, x: boat.x, z: boat.z, radius: 200, strength: 1, vx: 0, vz: 0 };
      ui.toast('A squall, right here', 1500);
    },
    squallComing: () => {
      forcedSquall = { id: -3, x: boat.x + 900, z: boat.z, radius: 190, strength: 0.3, vx: -6, vz: 0, t0: time, x0: boat.x + 900, z0: boat.z };
      ui.toast('A squall is on its way from the east (about two minutes)', 2500);
    },
    setSqualls: (on) => {
      devSqualls = on;
      if (!on) forcedSquall = null;
    },
    setWind: (k) => (devWindK = k),
    setHour: (h) => {
      clock.hour = h;
      daylight.refresh();
    },
    nextMorning: () => {
      clock.day += 1;
      clock.hour = DAY.washUpHour + 0.6;
      daylight.refresh();
      washIfDue();
    },
    setClockRunning: (on) => (holdTime = !on),
    setSpeed: (k) => (devSpeed = k),
    setFps: (on) => {
      showFps = on;
      ui.fpsEl.style.display = on ? 'block' : 'none';
    },
    fillStores: () => living.devFill(),
    lowStores: () => living.devLow(),
    giveMaterials: () => {
      living.devMaterials();
      ui.toast('Three of every find put in the locker', 2000);
    },
    biteNow: () => living.devBite(),
    growGarden: () => gardening.devGrow(),
    waterGarden: () => gardening.devWater(),
    moreSeeds: () => gardening.devSeeds(),
    scrapeHull: () => {
      boat.hull = 30;
      ui.toast('Hull scraped to 30%: she’ll leak', 2000);
    },
    dinghyToWater: () => {
      if (dinghy.state.where === 'davits') dinghy.doAction({ kind: 'lower', board: false, label: '' });
      else dinghy.fetch();
    },
    fetchDinghy: () => {
      dinghy.fetch();
      ui.toast('The dinghy is tied astern', 1500);
    },
    dentDinghy: () => {
      dentDinghy(living.aboard);
      ui.toast(`Dinghy dented: ${Math.round(living.aboard.dinghy)}%`, 1500);
    },
    sharkLooks: () => {
      if (!sharks.devCurious(player.feet.x, player.feet.z)) ui.toast('You’re not in shark waters: go to the reef gap, the sea buoy or Shark Bank.', 2600);
    },
    giveBait: () => {
      living.aboard.bait = Math.min(12, living.aboard.bait + 5);
      ui.toast(`${living.aboard.bait} pieces of bait in the bait box`, 1500);
    },
    finishChapter: () => {
      const c = chapterNow(story);
      if (!c) return;
      for (const g of c.goals) atLeast(story, g.fact, g.n);
      checkNotebook();
    },
    resetTips: () => {
      story.seen = [];
      ui.toast('Tips will show again', 1500);
    },
    click: () => audio.click(),
  },
  isTouch,
);

function toggleDevTools(on?: boolean): void {
  devTools.toggle(on);
  // Let go of the mouse so you can click the buttons.
  if (devTools.open) input.unlock();
}

function devGoTo(id: 'home' | 'pink' | 'gap' | 'open' | 'buoy' | 'bank'): void {
  if (course) stopCourse(null);
  // In the dinghy? You both come along: it's tied astern again.
  if (player.seated) dinghy.state.tied = true;
  pushOff = null;
  const spots = {
    home: { x: terrain.anchorage.x, z: terrain.anchorage.z, h: 0, anchor: true },
    pink: { x: world.pink.anchorage.x, z: world.pink.anchorage.z, h: 0, anchor: true },
    gap: { x: channel.outside.x, z: channel.outside.z, h: Math.atan2(channel.outside.z - channel.inside.z, channel.outside.x - channel.inside.x), anchor: false },
    open: { x: 700, z: -150, h: Math.PI / 2, anchor: false },
    buoy: { x: BUOY.x - 70, z: BUOY.z + 60, h: -0.75, anchor: false },
    bank: { x: world.bank.anchorage.x, z: world.bank.anchorage.z, h: 0, anchor: true },
  };
  const s0 = spots[id];
  boat.x = s0.x;
  boat.z = s0.z;
  boat.heading = s0.h;
  boat.speed = 0;
  boat.aground = false;
  boat.anchored = s0.anchor;
  boat.ax = s0.x + Math.cos(s0.h) * 6;
  boat.az = s0.z + Math.sin(s0.h) * 6;
  wasAnchored = boat.anchored;
  run = { start: -1, rounded: false };
  boatMotion.update(time, 1, boat);
  player.placeAboard((atHelm ? sloop.points.helm : sloop.points.spawn).clone(), player.yaw);
  changedSinceSave = true;
}

let lastDraws = 0;
let lastTris = 0;
function devInfo(): [string, string][] {
  const kn = (v: number) => `${(v * 1.944).toFixed(1)} kn`;
  const deg = (a: number) => `${Math.round(((90 - (a * 180) / Math.PI) % 360 + 360) % 360)}°`;
  let nearest = '';
  for (const q of squalls) {
    const d = Math.hypot(q.x - boat.x, q.z - boat.z) - q.radius;
    if (!nearest || d < Number(nearest.split(' ')[0])) nearest = `${Math.max(0, Math.round(d))} m away (${Math.round(q.strength * 100)}%)`;
  }
  const state = pushOff ? 'pushing off' : boat.anchored ? 'at anchor' : boat.aground ? `aground ${(boat.agroundTime ?? 0).toFixed(0)} s` : 'under way';
  const extra = [surfing > 0.6 ? 'surfing' : '', overTime > 0.5 ? 'overpowered' : ''].filter(Boolean).join(' · ');
  return [
    ['frame', `${fpsShown} fps · ${pipeline.quality} · ${lastDraws} draws · ${Math.round(lastTris / 1000)}k tris`],
    ['you', `${player.mode}${atHelm ? ' (helm)' : ''} · ${Math.round(player.feet.x)}, ${Math.round(player.feet.z)}`],
    ['boat', `${state} · ${Math.round(boat.x)}, ${Math.round(boat.z)} · hull ${Math.round(boat.hull)}%`],
    ['speed', `${kn(Math.abs(boat.speed))} · ${deg(boat.heading)} · heel ${Math.round((Math.abs(boat.heel) * 180) / Math.PI)}°${extra ? ` · ${extra}` : ''}`],
    ['sail, motor', `${Math.round(boat.sail * 100)}% · ${motorWord(boat.throttle ?? 0)}`],
    ['wind', `${kn(wind.speed)} from ${deg(wind.from)} · ${windWord(wind.speed * 1.944)}`],
    ['sea', `open ${Math.round(wind.open * 100)}% · rain ${Math.round(rainNow * 100)}% · ${squalls.length} squall${squalls.length === 1 ? '' : 's'}${nearest ? `, nearest ${nearest}` : ''}`],
    ['clock', `${formatClock(clock)}${holdTime ? ' (stopped)' : ''} · game ×${devSpeed} · wind ×${devWindK}`],
    ['sea buoy', `${records.rounds} rounds · best ${records.best ? minSec(records.best) : '–'}`],
    ['stores', `food ${living.aboard.food.toFixed(1)} d · water ${living.aboard.water.toFixed(1)} d · ${living.aboard.coolBox.length} fish`],
    ['upkeep', `sails ${Math.round(living.aboard.sails)}% · bilge ${Math.round(living.aboard.bilge * 100)}% · fishing ${living.fishing.phase}`],
    ['dinghy', `${dinghy.info()} · ${Math.round(living.aboard.dinghy)}% · bait ${living.aboard.bait}`],
    ['sharks', sharksInfo()],
    ['notebook', `chapter ${Math.min(story.chapter + 1, CHAPTERS.length)} of ${CHAPTERS.length}${nextGoal(story) ? ` · next: ${nextGoal(story)!.text}` : ' · finished'}`],
  ];
}

function sharksInfo(): string {
  const n = sharks.nearest(player.feet.x, player.feet.z);
  const zn = sharks.zoneAt(player.feet.x, player.feet.z);
  return `${zn ? `in ${zn.name}` : 'no shark waters here'}${n ? ` · nearest ${Math.round(n.d)} m (${n.shark.kind}, ${n.shark.mood})` : ''} · ${sharks.finsUp} fins up`;
}

/** Pushing her off the bottom into deeper water (a few seconds, as if poling her off). */
let pushOff: { fx: number; fz: number; fh: number; tx: number; tz: number; th: number; t: number } | null = null;
let lastStuckTip = -99;

function startPushOff(): boolean {
  if (pushOff) return true;
  const to = deepWaterNear(seaBed, boat.x, boat.z, boat.heading);
  if (!to) {
    ui.toast('She’s high and dry: there’s no deep water close enough to push her into.', 3500);
    return false;
  }
  pushOff = { fx: boat.x, fz: boat.z, fh: boat.heading, tx: to.x, tz: to.z, th: to.heading, t: 0 };
  boat.throttle = 0;
  boat.speed = 0;
  if (course) stopCourse(null);
  audio.thud(0.25);
  ui.toast('You push her off into deeper water…', 2500);
  changedSinceSave = true;
  return true;
}

/** Each frame while pushing off: ease her to the deep spot. Returns true while it's happening. */
function stepPushOff(dt: number): boolean {
  if (!pushOff) return false;
  const p = pushOff;
  p.t = Math.min(1, p.t + dt / 2.5);
  const k = p.t * p.t * (3 - 2 * p.t);
  boat.x = p.fx + (p.tx - p.fx) * k;
  boat.z = p.fz + (p.tz - p.fz) * k;
  boat.heading = wrapAngle(p.fh + wrapAngle(p.th - p.fh) * k);
  boat.speed = 0;
  boat.aground = false;
  boat.agroundTime = 0;
  if (p.t >= 1) {
    pushOff = null;
    audio.splash(0.4);
    ui.toast('Afloat again', 1800);
  }
  return true;
}

/** Sailing off with the dinghy left somewhere? Say so (it waits for you). */
function dinghyLeftBehind(): void {
  const d = dinghy.state;
  if (d.where !== 'water' || d.tied || player.seated) return;
  if (Math.hypot(d.x - boat.x, d.z - boat.z) < 40) return;
  const near = world.nearest(d.x, d.z).island.name;
  window.setTimeout(() => ui.toast(`The dinghy is still where you left it, by ${near}. It’ll wait for you.`, 4000), 2800);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function toggleAnchor(): void {
  // Aground, the anchor button pushes her off instead.
  if (boat.aground && !boat.anchored) {
    startPushOff();
    return;
  }
  if (boat.anchored) {
    weighAnchor(boat);
    audio.anchorChain(false);
    ui.toast('Anchor up. Raise the sails to get under way.', 2600);
    dinghyLeftBehind();
  } else {
    const why = dropAnchor(boat, seaBed);
    if (why) ui.toast(why, 3500);
    else {
      audio.anchorChain(true);
      ui.toast(`Anchored off ${world.nearest(boat.x, boat.z).island.name}`, 2600);
      if (course) stopCourse(null);
    }
  }
  changedSinceSave = true;
}

function startCourse(id: string): void {
  const dest = PLACES.find((p) => p.id === id);
  if (!dest) return;
  if (!player.aboard) {
    ui.toast('Go aboard first, then set sail.', 2600);
    return;
  }
  // Through the gap in the reef if you're crossing it.
  const inLagoon = (x: number, z: number) => terrain.inland(x, z) > -84;
  const wps: { x: number; z: number }[] = [];
  const fromIn = inLagoon(boat.x, boat.z);
  const toIn = inLagoon(dest.x, dest.z);
  if (fromIn && !toIn) wps.push({ ...channel.inside }, { ...channel.outside });
  if (!fromIn && toIn) wps.push({ ...channel.outside }, { ...channel.inside });
  // Leaving Shark Bank: back out round its flats first.
  const atBank = Math.hypot(boat.x - BANK.x, boat.z - BANK.z) < 170;
  if (atBank && id !== 'bank') {
    wps.length = 0;
    wps.push(...[...BANK_ROUTE].reverse().map((p) => ({ ...p })));
    if (toIn) wps.push({ ...channel.outside }, { ...channel.inside });
  }
  if (id === 'bank') {
    if (!atBank) wps.push(...BANK_ROUTE.map((p) => ({ ...p })));
    wps.push({ x: dest.x, z: dest.z });
    course = { waypoints: wps, tack: 1, name: dest.name };
  } else if (id === 'buoy') {
    // Out round the buoy and home again: through the gap, out to the buoy, back to the gap, home.
    if (!fromIn && !atBank) wps.length = 0;
    wps.push({ x: dest.x, z: dest.z }, { ...channel.outside }, { ...channel.inside }, { x: terrain.anchorage.x, z: terrain.anchorage.z });
    course = { waypoints: wps, tack: 1, name: 'the sea buoy and home', arrive: 'Home Cay' };
  } else {
    wps.push({ x: dest.x, z: dest.z });
    course = { waypoints: wps, tack: 1, name: dest.name };
  }
  if (boat.anchored) {
    weighAnchor(boat);
    audio.anchorChain(false);
    dinghyLeftBehind();
  }
  toggleChart(false);
  hud.showCard(
    id === 'buoy' ? 'Out round the sea buoy' : `Setting sail for ${dest.name}`,
    id === 'buoy'
      ? 'She’ll beat out to the buoy on the open sea, round it, and run home before the wind. Take the helm whenever you like: it’s more fun steering her yourself.'
      : 'She’ll steer herself and anchor when she gets there. Walk about, or take the helm to steer yourself.',
    7000,
  );
}

function stopCourse(msg: string | null): void {
  course = null;
  if (msg) ui.toast(msg, 2600);
  if (chart.open) renderChart();
}

function toggleLogbook(show?: boolean): void {
  const open = show ?? !hud.logbookOpen;
  if (open) {
    ui.closePanels();
    guide.show(false);
    const near = world.nearest(boat.x, boat.z).island.name;
    const sailing = records.rounds
      ? `Round the sea buoy ${records.rounds === 1 ? 'once' : `${records.rounds} times`}.${records.best ? ` Fastest run from Home Cay, round the buoy and back: ${minSec(records.best)}.` : ''}`
      : 'The sea buoy lies out on the open sea to the south-east. Sail out round it and back to Home Cay, and your time goes here.';
    hud.renderLogbook(
      beach.state.found,
      beach.state.locker,
      beach.state.basket,
      formatClock(clock),
      { hull: boat.hull, where: boat.anchored ? `At anchor off ${near}` : `Under way near ${near}`, sailing, rows: living.logRows() },
      living.logFish(),
      { rows: gardening.logRows(), seeds: gardening.seedLine() },
      sharks.logRows(),
    );
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
  return ui.panelOpen || hud.logbookOpen || chart.open || living.panelOpen || gardening.panelOpen || guide.open;
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
  if (e.code === 'KeyT' && !e.repeat) toggleDevTools();
  else if (e.code === 'KeyG' && !e.repeat && view === 'fp' && !atHelm && !anyPanelOpen()) living.toggleRod();
  else if (e.code === 'Escape' && living.panelOpen) living.closePanels();
  else if (e.code === 'Escape' && gardening.panelOpen) gardening.closePanels();
  else if (view === 'build' && (e.code === 'Escape' || e.code === 'KeyB')) exitBuild();
  else if (e.code === 'KeyL' && view === 'fp') toggleLogbook();
  else if (e.code === 'KeyN' && view === 'fp' && !e.repeat) toggleNotebook();
  else if (e.code === 'Escape' && guide.open) toggleNotebook(false);
  else if (e.code === 'KeyQ' && view === 'fp' && !e.repeat && !anyPanelOpen()) throwBait();
  else if (e.code === 'KeyM' && view === 'fp') toggleChart();
  else if (e.code === 'Escape' && chart.open) toggleChart(false);
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
  boat?: Partial<BoatState>;
  sailing?: Partial<typeof records>;
  living?: unknown;
  garden?: unknown;
  player: { mode: PlayerMode; pos: number[]; yaw: number; pitch: number };
  beach: unknown;
  /** v0.8: the dinghy, sharks you've seen, Ida's notebook. */
  dinghy?: unknown;
  sharks?: unknown;
  story?: unknown;
}

function gameState(): GameSave {
  const { x, z, heading, anchored, ax, az, sailSet, hull } = boat;
  return { version: GAME_VERSION, clock: { ...clock }, boat: { x, z, heading, anchored, ax, az, sailSet, hull }, sailing: { ...records }, living: living.save(), garden: gardening.save(), player: player.state, beach: beach.state, dinghy: dinghy.save(), sharks: sharks.save(), story };
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
  // Your boat, where you left her (anchored at Home Cay in older saves).
  const sb = g.boat;
  boat = newBoat(terrain.anchorage.x, terrain.anchorage.z, terrain.anchorage.heading);
  if (sb && Number.isFinite(sb.x) && Number.isFinite(sb.z) && Number.isFinite(sb.heading)) {
    boat.x = sb.x as number;
    boat.z = sb.z as number;
    boat.heading = sb.heading as number;
    boat.anchored = sb.anchored !== false;
    boat.ax = Number.isFinite(sb.ax) ? (sb.ax as number) : boat.x;
    boat.az = Number.isFinite(sb.az) ? (sb.az as number) : boat.z;
    boat.sailSet = boat.sail = Math.min(1, Math.max(0, Number(sb.sailSet) || 0));
    boat.hull = Math.min(100, Math.max(0, Number.isFinite(sb.hull) ? (sb.hull as number) : 100));
  }
  course = null;
  atHelm = false;
  boatMotion.update(time, 1, boat);
  const sr = g.sailing;
  records.rounds = Math.max(0, Math.floor(Number(sr?.rounds) || 0));
  records.best = Number.isFinite(sr?.best) && (sr?.best as number) > 0 ? (sr?.best as number) : 0;
  run = { start: -1, rounded: false };
  wasAnchored = boat.anchored;
  living.restore(g.living);
  gardening.restore(g.garden);
  sharks.restore(g.sharks);
  story = restoreStory(g.story);
  const p = g.player;
  const seated = p?.mode === 'seat';
  dinghy.restore(g.dinghy, false);
  if (p && Array.isArray(p.pos) && p.pos.length === 3 && p.pos.every(Number.isFinite)) {
    const v = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]);
    // Aboard: back in the cockpit (a save from an older boat's deck may not fit this one).
    if (p.mode === 'deck') player.placeAboard(g.version === GAME_VERSION ? v : sloop.points.spawn.clone(), p.yaw ?? START_YAW);
    else if (seated && dinghy.state.where === 'water') dinghy.restore(g.dinghy, true);
    else player.placeWorld(v.x, v.z, p.yaw ?? START_YAW);
    if (Number.isFinite(p.pitch)) player.pitch = p.pitch as number;
  }
  // Catch the notebook up with what you'd already done (rewards included), quietly.
  storyTicks = doneKeys(story);
  storyCatchUp = story.chapter;
  checkNotebook(true);
  storyCatchUp = story.chapter - storyCatchUp;
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
  living.reset();
  gardening.reset();
  story = newStory();
  storyTicks = doneKeys(story);
  dinghy.restore(null, false);
  sharks.restore(null);
  boat = newBoat(terrain.anchorage.x, terrain.anchorage.z, terrain.anchorage.heading);
  course = null;
  atHelm = false;
  boatMotion.update(time, 1, boat);
  player.placeAboard(sloop.points.spawn, START_YAW);
  daylight.refresh();
  ui.toast('A fresh start at Home Cay');
  welcome(false);
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
  boatMotion.update(time, 1, boat);
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
  welcome(resumed);
}

/** The first thing you see: Ida's note (a new game), or news of the notebook (an older save). */
function welcome(resumedGame: boolean): void {
  window.setTimeout(() => {
    if (!resumedGame) {
      if (!story.opened) {
        story.opened = true;
        guide.tip('A note from Ida', CHAPTERS[0].note);
      }
      showTip('welcome');
      showTip('look');
    } else if (!story.opened) {
      const done = storyCatchUp > 0 ? ` You’ve already done ${storyCatchUp === 1 ? 'the whole first chapter' : `the first ${storyCatchUp} chapters`}, so Ida’s gifts for ${storyCatchUp === 1 ? 'it are' : 'them are'} yours.` : '';
      guide.tip('Ida’s notebook', `Tidying the chart table, you’ve found the old owner’s notebook: notes for whoever has the boat next.${done} ${isTouch ? 'Tap the “Next” line' : 'Press N'} to read it.`);
      story.opened = true;
    }
    changedSinceSave = true;
  }, 900);
}

/** New finds wash up each morning. */
function washIfDue(): void {
  if (clock.hour >= DAY.washUpHour) living.morning(clock.day);
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
  | { kind: 'helm'; label: string }
  | { kind: 'living'; a: LivingAction; label: string }
  | { kind: 'garden'; a: GardenAction; label: string }
  | { kind: 'sleep'; label: string }
  | { kind: 'charttable'; label: string }
  | { kind: 'dinghy'; a: DinghyAction; label: string }
  | null;

const center = new THREE.Vector2(0, 0);
const tmpV = new THREE.Vector3();
function currentAction(): Action {
  if (player.mode === 'climb' || dinghy.busy) return null;
  // With the rod in your hands, the use button fishes.
  if (living.rodHeld) {
    const la = living.action();
    if (la) return { kind: 'living', a: la, label: la.label };
  }
  // Sitting in the dinghy: climb out (or aboard the big boat at her stern).
  if (player.seated) {
    const da = dinghy.seatedAction();
    return da ? { kind: 'dinghy', a: da, label: da.label } : null;
  }
  if (player.nearLadder()) return { kind: 'climb', label: 'Climb aboard' };
  {
    const da = dinghy.outsideAction(player.feet.x, player.feet.z);
    if (da) return { kind: 'dinghy', a: da, label: da.label };
  }
  if (player.atLadderTop()) return { kind: 'climbdown', label: 'Climb down the ladder' };
  raycaster.setFromCamera(center, camera);
  const f = beachView.pick(raycaster.ray, camera.position, PLAYER.reach);
  if (f) return { kind: 'pick', id: f.id, label: `Pick up the ${FINDS[f.kind].name.toLowerCase()}` };
  if (player.mode === 'deck' && !atHelm) {
    // The locker and the tiller are side by side in the cockpit: offer whichever you're nearer.
    const lk = sloop.points.locker;
    const hm = sloop.points.helm;
    // (Only spots on your own level: the helm is up on the flybridge.)
    const level = (p: THREE.Vector3) => Math.abs(player.pos.y - p.y) < 0.7;
    const dLocker = beach.state.basket.length && level(lk) ? Math.hypot(player.pos.x - lk.x, player.pos.z - lk.z) : Infinity;
    const dHelm = level(hm) ? Math.hypot(player.pos.x - hm.x, player.pos.z - hm.z) : Infinity;
    // The galley, the workbench and the pump too: whichever spot you're nearest.
    const opts: [number, number, Action][] = [
      [dLocker, 1.4, { kind: 'locker', label: 'Empty your basket into the locker' }],
      [dHelm, 1.2, { kind: 'helm', label: 'Take the helm' }],
      ...living.deckOptions().map(([d, a]) => [d, 1.0, { kind: 'living', a, label: a.label }] as [number, number, Action]),
      ...(living.rodHeld ? [] : gardening.deckOptions().map(([d, a]) => [d, 0.9, { kind: 'garden', a, label: a.label }] as [number, number, Action])),
      // Below decks: the bunk and the chart table (on boats that have them).
      ...boatSpot('bunk', 1.0, { kind: 'sleep', label: canSleepNow() ? 'Sleep until morning' : 'Your bunk (sleep after sunset)' }),
      ...boatSpot('chart', 1.0, { kind: 'charttable', label: 'Look at the chart' }),
      // The dinghy: at the port swim step, or the back of the cockpit by the davits.
      ...dinghy.deckOptions(player.pos).map(([d, r, a]) => [d, r, { kind: 'dinghy', a, label: a.label }] as [number, number, Action]),
    ];
    opts.sort((x, y) => x[0] - y[0]);
    for (const [d, r, a] of opts) if (d < r) return a;
  }
  // Ashore: the garden beds, or under a coconut palm.
  {
    const ga = living.rodHeld ? null : gardening.landAction();
    if (ga) return { kind: 'garden', a: ga, label: ga.label };
    const la = living.action();
    if (la) return { kind: 'living', a: la, label: la.label };
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
    storyNote('stowed');
    audio.locker();
    hud.showCard('Stowed', `${n} ${n === 1 ? 'find' : 'finds'} put away in the locker. The logbook lists everything aboard.`, 3500);
    changedSinceSave = true;
  } else if (a.kind === 'build') enterBuild();
  else if (a.kind === 'helm') takeHelm();
  else if (a.kind === 'living') living.doAction(a.a);
  else if (a.kind === 'garden') gardening.doAction(a.a);
  else if (a.kind === 'sleep') sleepUntilMorning();
  else if (a.kind === 'charttable') toggleChart(true);
  else if (a.kind === 'dinghy') {
    if (a.a.kind === 'board' || a.a.kind === 'lower') living.putRodAway(true);
    dinghy.doAction(a.a);
  }
}

/** A named spot on the boat (boat-local), if the boat has it: [distance, reach, action]. Only on the same level as you. */
function boatSpot(name: string, reach: number, a: Action): [number, number, Action][] {
  const p = (sloop.points as unknown as Record<string, THREE.Vector3 | undefined>)[name];
  if (!p || Math.abs(player.pos.y - p.y) > 0.6) return [];
  return [[Math.hypot(player.pos.x - p.x, player.pos.z - p.z), reach, a]];
}

// ---------- sleeping ----------

/** You can sleep from sunset (6 pm) until dawn, at anchor. */
function canSleepNow(): boolean {
  return clock.hour >= 18 || clock.hour < 5;
}

const fadeEl = document.createElement('div');
fadeEl.id = 'sleepfade';
document.body.appendChild(fadeEl);
let sleeping = false;

function sleepUntilMorning(): void {
  if (sleeping) return;
  if (!boat.anchored) {
    ui.toast('Anchor first: you can’t sleep while she’s under way.', 3000);
    return;
  }
  if (!canSleepNow()) {
    ui.toast('It’s still daytime. You can sleep after sunset (6 pm).', 3000);
    return;
  }
  sleeping = true;
  fadeEl.classList.add('on');
  input.unlock();
  setTimeout(() => {
    // To dawn: 6:30 tomorrow (or today, if it's already after midnight).
    if (clock.hour >= 18) clock.day += 1;
    clock.hour = 6.5;
    daylight.refresh();
    washIfDue();
    storyNote('slept');
    changedSinceSave = true;
    setTimeout(() => {
      fadeEl.classList.remove('on');
      sleeping = false;
      hud.showCard('Good morning', 'You slept until dawn. The stores, the garden and the tide carried on while you slept.', 5000);
    }, 900);
  }, 900);
}

function pickUp(id: number): void {
  const g = beach.state.ground.find((x) => x.id === id);
  const r = beach.pickUp(id);
  if (r.ok && g && world.islandAt(g.x, g.z).id === 'bank') storyNote('bankFinds');
  if (r.ok) showTip('firstFind');
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

// ---------- living aboard ----------

/** The boat's fittings for living aboard. On the catamaran the "hatch" is the saloon door: it stays open. */
const livingRig: LivingRig | null = rig ? (BOAT_IS_CAT ? Object.assign(Object.create(rig), { setHatch: undefined }) : (rig as unknown as LivingRig)) : null;

// The fishing line and float, in the world (skipped by the under-the-water picture).
const fishingLine = new FishingLine();
scene.add(fishingLine.group);
staticSkip.push(...fishingLine.overWater);
rebuildRefractSkip();
fishingLine.waterAt = (x, z) => seaHeight(x, z, time);
const living: Living = new Living({
  boat: () => boat,
  player,
  beach,
  beachView,
  hud,
  toast: (m, ms) => ui.toast(m, ms),
  audio,
  input,
  isTouch,
  points: sloop.points as unknown as { galley?: THREE.Vector3; workbench?: THREE.Vector3; pump?: THREE.Vector3; locker: THREE.Vector3 },
  rig: () => livingRig,
  floorAt: (x, z) => seaBed.floorAt(x, z),
  seaHeight: (x, z) => seaHeight(x, z, time),
  openness,
  camera,
  held: held as unknown as RodView,
  line: fishingLine,
  tipWorld: (out) => held.rodTipWorld(camera, out),
  prepare: () => prepareFish(),
  clearOfBoat: (x, z) => {
    const l = sloop.group.worldToLocal(new THREE.Vector3(x, 0, z));
    const deck = sloop.deck as { footprintPen?(x: number, z: number): number };
    const pen = deck.footprintPen ? deck.footprintPen(l.x, l.z) : Math.max(0, 3.5 - Math.hypot(l.x, l.z));
    return pen <= 0 && Math.hypot(l.x, l.z) > sloop.length * 0.3;
  },
  palms: trunks,
  dayNow: () => clock.day + clock.hour / 24,
  atHelm: () => atHelm,
  changed: () => (changedSinceSave = true),
  closeOtherPanels: () => {
    ui.closePanels();
    hud.showLogbook(false);
    guide.show(false);
    if (chart.open) toggleChart(false);
  },
  unlockPointer: () => {
    input.unlock();
    input.clear();
  },
  riskAt: (x, z) => sharks.zoneAt(x, z)?.risk ?? 0,
  seatedSpeed: (): number | null => (player.seated ? dinghy.state.speed : null),
  baitKnown: () => baitKnown(),
  onCatch: (_k, kg, risk) => {
    if (risk > 0 && kg >= BIG_FISH_KG) storyNote('bigFish');
  },
  onCook: () => storyNote('cooked'),
  onMake: () => storyNote('made'),
  onGalley: () => showTip('galley'),
});

// ---------- the garden ----------

/** The garden's models (the old sloop's trays needed smaller pots; the catamaran's planter shelf takes full-size ones). */
const POT_SCALE = BOAT_IS_CAT ? 1 : DECK_POT_SCALE;
const gardenViews: GardenViews = {
  plant: (size) => {
    const p = new PlantView(size);
    if (size === 'pot') p.group.scale.setScalar(POT_SCALE);
    return p;
  },
  pot: () => potModel(POT_SCALE),
  bed: () => bedModel(),
  barrel: () => barrelModel(),
  sign: (text) => signModel(text),
  soil: { pot: GARDEN_SOIL.pot * POT_SCALE, bed: GARDEN_SOIL.bed },
};
const gardenRain = newWeather();
const gardening = new Gardening({
  potSpots: sloop.points.potShelf,
  boatGroup: sloop.group,
  scene,
  beds: HOME_GARDEN.beds,
  barrelAt: HOME_GARDEN.barrel,
  signAt: HOME_GARDEN.sign,
  groundAt: (x, z) => ground.heightAt(x, z),
  views: gardenViews,
  player: () => ({ mode: player.mode, x: player.pos.x, y: player.pos.y, z: player.pos.z }),
  dayNow: () => clock.day + clock.hour / 24,
  useTankWater: (d) => {
    if (living.aboard.water < d) return false;
    living.aboard.water -= d;
    return true;
  },
  addFood: (d) => {
    const before = living.aboard.food;
    living.aboard.food = Math.min(30, living.aboard.food + d);
    return living.aboard.food - before;
  },
  toast: (m, ms) => ui.toast(m, ms),
  card: (t, x, ms) => hud.showCard(t, x, ms),
  sound: { splash: (n) => audio.splash(n), chime: (f) => audio.chime(f), click: () => audio.click() },
  pour: () => (held as unknown as { setHolding?(w: string): void; pour?(): void }).pour?.(),
  changed: () => (changedSinceSave = true),
  closeOtherPanels: () => {
    ui.closePanels();
    hud.showLogbook(false);
    guide.show(false);
    living.closePanels();
    if (chart.open) toggleChart(false);
  },
  unlockPointer: () => {
    input.unlock();
    input.clear();
  },
});

// ---------- the dinghy (v0.8) ----------

const dinghy: DinghyCtl = new DinghyCtl({
  scene,
  cat: sloop as unknown as ConstructorParameters<typeof DinghyCtl>[0]['cat'],
  boat: () => boat,
  player,
  seaHeight: (x, z) => seaHeight(x, z, time),
  floorAt: (x, z) => seaBed.floorAt(x, z),
  groundAt: (x, z) => ground.heightAt(x, z),
  wind: () => ({ x: -Math.cos(wind.from) * wind.speed, z: -Math.sin(wind.from) * wind.speed }),
  condition: (): number => living.aboard.dinghy,
  audio,
  toast: (m, ms) => ui.toast(m, ms),
  tip: (id) => showTip(id),
  changed: () => (changedSinceSave = true),
  onRowed: () => storyNote('dinghy'),
});
staticSkip.push(dinghy.wakeMesh);
rebuildRefractSkip();

/** Your wish to row or motor: W/S and A/D (or the stick), while you're sitting in the dinghy. */
function dinghyDrive(): { ahead: number; steer: number } {
  if (!player.seated || !started || view !== 'fp' || anyPanelOpen()) return { ahead: 0, steer: 0 };
  return { ahead: input.move.y, steer: input.move.x };
}

// ---------- sharks (v0.8) ----------

/** The three shark waters, rising risk and reward. */
const SHARK_ZONES: SharkZone[] = [
  {
    id: 'gap',
    name: 'the reef gap',
    x: channel.inside.x + (channel.outside.x - channel.inside.x) * 0.75,
    z: channel.inside.z + (channel.outside.z - channel.inside.z) * 0.75,
    r: 55,
    kind: 'reef',
    count: 1,
    risk: 1,
  },
  { id: 'buoy', name: 'the deep water round the sea buoy', x: BUOY.x, z: BUOY.z, r: 160, kind: 'reef', count: 2, risk: 2 },
  { id: 'bank', name: 'Shark Bank', x: BANK.x, z: BANK.z, r: 95, kind: 'nurse', count: 6, risk: 3 },
];
let lastBaitThrow = -99;
let baitNoted = false;
let lastCircleToast = -99;
let lastStartle = -99;
const sharks = new SharkLife(SHARK_ZONES, {
  scene,
  seaHeight: (x, z) => seaHeight(x, z, time),
  floorAt: (x, z) => seaBed.floorAt(x, z),
  onEvent: (e) => onSharkEvent(e),
  noBait: () => {
    ui.toast('No bait in the bait box.', 2200);
    showTip('noBait');
  },
  takeBait: () => {
    if (living.aboard.bait <= 0) return false;
    living.aboard.bait--;
    changedSinceSave = true;
    return true;
  },
  onSeen: (kind, zone) => {
    if (sharks.seen[kind] === 1) hud.showCard(`A ${SHARK_INFO[kind].name}!`, `${SHARK_INFO[kind].fact} This is ${zone.name}.`, 9000);
    changedSinceSave = true;
  },
});
staticSkip.push(...sharks.overWater);
rebuildRefractSkip();

/** Where you are, as far as the sharks are concerned. */
function youForSharks(): { x: number; z: number; how: YouHow } {
  const f = player.feet;
  let how: YouHow = 'safe';
  if (!started) how = 'safe';
  else if (player.seated) how = 'dinghy';
  else if (player.mode === 'swim') how = 'swim';
  else if (player.mode === 'land' && player.waterDepth > 0.25) how = 'wade';
  return { x: f.x, z: f.z, how };
}

function onSharkEvent(e: SharkEvent): void {
  if (!started) return;
  const name = SHARK_INFO[e.shark.kind].name;
  if (e.type === 'circling') {
    if (time - lastCircleToast > 30) {
      lastCircleToast = time;
      ui.toast(`A ${name} is circling you…`, 3000);
    }
    showTip('circling');
  } else if (e.type === 'startled') {
    if (time - lastStartle > 15) {
      lastStartle = time;
      ui.toast('A nurse shark bolts off the sand right by your feet!', 2600);
    }
  } else if (e.type === 'baited') {
    if (time - lastBaitThrow < 60 && !baitNoted) {
      baitNoted = true;
      storyNote('baited');
      ui.toast(`The ${name} goes for the bait.`, 2600);
    }
  } else if (e.type === 'bump') {
    audio.thud(0.35);
    if (navigator.vibrate) navigator.vibrate([40, 30, 80]);
    player.look((Math.random() - 0.5) * 0.12, 0.05);
    if (e.how === 'dinghy') {
      dentDinghy(living.aboard);
      hud.showCard('Bump!', `A ${name} nudges the dinghy with its nose and swims off. It’s left a dent (the dinghy is at ${Math.round(living.aboard.dinghy)}%).`, 5000);
      showTip('dented');
    } else if (beach.state.basket.length) {
      const isl = world.nearest(player.feet.x, player.feet.z).island;
      const n = beach.lose(isl.id);
      hud.showCard('Bump!', `A ${name} knocks into you and you drop your basket. The sea will wash ${n === 1 ? 'your find' : `your ${n} finds`} up on ${isl.name} with the next tide.`, 6000);
      showTip('dropped');
    } else hud.showCard('Bump!', `A ${name} nudges you with its nose and turns away. It was only curious.`, 4500);
    changedSinceSave = true;
  }
}

function throwBait(): void {
  if (!started || view !== 'fp' || atHelm) return;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  if (sharks.throwBait(camera.position, dir)) {
    lastBaitThrow = time;
    baitNoted = false;
    audio.splash(0.06);
    if (!sharks.threatened && !sharks.zoneAt(player.feet.x, player.feet.z)) ui.toast('Splash. No sharks about to notice it.', 2000);
  }
}

// ---------- Ida's notebook, the next step and tips (v0.8) ----------

let story: StoryState = newStory();
/** After loading: how many chapters were finished just by catching up (said once, when you start playing). */
let storyCatchUp = 0;
let storyTicks = doneKeys(story);
let storyTimer = 0;
const guide = new Guide(
  {
    open: () => toggleNotebook(true),
    close: () => toggleNotebook(false),
    click: () => audio.click(),
  },
  isTouch,
);

function storyNote(f: Fact): void {
  note(story, f);
  changedSinceSave = true;
}

function showTip(id: string): void {
  if (!started) return;
  const t = takeTip(story, id);
  if (!t) return;
  guide.tip(t.title, tipText(t, isTouch));
  changedSinceSave = true;
}

/** Can you cut bait? (Ida's notebook teaches it at the end of chapter 2.) */
function baitKnown(): boolean {
  return story.chapter >= 2;
}

const sum = (o: Partial<Record<string, number>>) => Object.values(o).reduce((a: number, b) => a + (b ?? 0), 0);

/** Read the counts the notebook needs from the rest of the game. */
function deriveFacts(): void {
  const found = beach.state.found;
  atLeast(story, 'finds', sum(found));
  if (sum(beach.state.locker) > 0) atLeast(story, 'stowed', 1);
  atLeast(story, 'fish', sum(living.aboard.fishLog));
  const g = gardening.save();
  atLeast(story, 'harvested', sum(g.grown));
  if (Object.keys(g.plots).length > 0 || sum(g.grown) > 0) atLeast(story, 'planted', 1);
  const made = living.aboard.made;
  if ((made.catcher ?? 0) + (made.jugs ?? 0) + (made.lure ?? 0) + (made.trap ?? 0) + (made.planter ?? 0) > 0) atLeast(story, 'made', 1);
  atLeast(story, 'pinkShells', (found['netted-olive'] ?? 0) + (found['flamingo-tongue'] ?? 0));
  atLeast(story, 'buoy', records.rounds);
  if (boat.anchored) {
    const n = world.nearest(boat.x, boat.z);
    if (n.island.id === 'pink' && n.coast < 220) atLeast(story, 'pinkAnchored', 1);
  }
  if (!started) return;
  const f = player.feet;
  if (player.mode === 'land') {
    const isl = world.islandAt(f.x, f.z);
    if (isl.id === 'home' && terrain.inland(f.x, f.z) > 0) atLeast(story, 'ashore', 1);
    if (isl.id === 'bank' && world.bank.inland(f.x, f.z) > 0) atLeast(story, 'bankAshore', 1);
  }
  if (player.seated && sharks.zoneAt(f.x, f.z)?.id === 'gap') atLeast(story, 'gap', 1);
  if (view === 'build' && undoCount > 0) atLeast(story, 'castle', 1);
}

/** A chapter's reward is yours. Returns the line to show. */
function giveReward(id: string): string {
  const c = CHAPTERS.find((x) => x.id === id);
  if (!c) return '';
  const r = c.reward;
  if (r.kind === 'seeds') {
    const g = gardening.save();
    for (const [k, n] of Object.entries(r.seeds)) (g.seeds as Record<string, number>)[k] = ((g.seeds as Record<string, number>)[k] ?? 0) + n;
  } else if (r.kind === 'recipe') living.aboard.bait = Math.max(living.aboard.bait, 3);
  else {
    living.aboard.made[r.upgrade as Upgrade] = 1;
    if (r.upgrade === 'goodSails') living.aboard.sails = 100;
  }
  changedSinceSave = true;
  return r.text;
}

/** Check the notebook for progress (a couple of times a second). `quiet`: just catch up (after loading). */
function checkNotebook(quiet = false): void {
  deriveFacts();
  for (let i = 0; i < CHAPTERS.length; i++) {
    const news = checkStory(story, storyTicks);
    if (!quiet) for (const g of news.ticked) {
      audio.chime(false);
      ui.toast(`✓ ${g.text}`, 2600);
    }
    if (!news.finished) break;
    const reward = giveReward(news.finished.id);
    if (!quiet) {
      audio.chime(true);
      hud.showCard(`Chapter done: ${news.finished.title}`, `${news.finished.done} (${reward})`, 11000);
      window.setTimeout(() => showTip('chapter'), 11500);
    }
    changedSinceSave = true;
  }
  if (guide.open) renderNotebook();
}

function goalProgress(f: Fact, n: number): string {
  if (n <= 1) return '';
  return `${Math.min(n, storyCount(story, f))} of ${n}`;
}

function renderNotebook(): void {
  const pages: NotebookPage[] = CHAPTERS.map((c, i) => ({
    title: c.title,
    state: i < story.chapter ? 'done' : i === story.chapter ? 'now' : 'later',
    note: c.note,
    goals: c.goals.map((g) => ({ text: g.text, how: howTo(g.how, isTouch), done: goalDone(story, g), progress: goalProgress(g.fact, g.n) })),
    reward: c.reward.text,
    doneLine: c.done,
  }));
  guide.render(
    'Found in the chart table, with the boat’s papers: a notebook, its cover soft with salt. On the first page, in pencil: “For whoever has her next. — Ida”',
    pages,
    story.chapter >= CHAPTERS.length ? 'You’ve done everything in Ida’s notebook. The cays are yours: the rest of the pages are empty, for your own notes.' : null,
  );
}

function toggleNotebook(show?: boolean): void {
  const open = show ?? !guide.open;
  if (open) {
    ui.closePanels();
    hud.showLogbook(false);
    living.closePanels();
    gardening.closePanels();
    if (chart.open) toggleChart(false);
    renderNotebook();
    input.unlock();
    input.clear();
    story.opened = true;
  }
  guide.show(open);
}

/** Tips that pop up when something is first useful, and the next-step line. */
function updateGuide(): void {
  guide.setVisible(started && view === 'fp');
  if (!started || view !== 'fp') return;
  const g = nextGoal(story);
  guide.setNext(g ? g.text : null, g ? howTo(g.how, isTouch) : '', time);
  const f = player.feet;
  if (player.atLadderTop()) showTip('ladder');
  if (player.mode === 'swim') showTip('swimming');
  if (player.mode === 'land' && player.waterDepth < 0.05) showTip('ashore');
  if (clock.hour >= 18 && clock.hour < 22) showTip('dusk');
  if (living.rodHeld) showTip('rod');
  const zn = sharks.zoneAt(f.x, f.z);
  const how = youForSharks().how;
  if (zn && how !== 'safe') showTip('sharkZone');
  if ((player.seated || how === 'wade') && Math.hypot(f.x - BANK.x, f.z - BANK.z) < 90) showTip('bankFlats');
}

/** The buttons for now: the outboard (in the dinghy), bait (near the sea, if you have some). */
function updateButtons(): void {
  const list: { id: string; label: string; icon: string; key?: string; on?: boolean }[] = [];
  if (started && view === 'fp' && !anyPanelOpen()) {
    if (player.seated) list.push({ id: 'motor', label: dinghy.state.motor ? 'Outboard off' : 'Start outboard', icon: ICONS.outboard, key: dinghy.state.motor ? 'F' : 'R', on: dinghy.state.motor });
    const nearSea = player.seated || player.mode === 'swim' || (player.mode === 'land' && player.waterDepth > 0.1) || (player.aboard && !atHelm);
    const sharky = sharks.zoneAt(player.feet.x, player.feet.z) || sharks.threatened;
    if (living.aboard.bait > 0 && nearSea && sharky) list.push({ id: 'bait', label: `Throw bait (${living.aboard.bait})`, icon: ICONS.bait, key: 'Q' });
  }
  hud.setButtons(list);
}

// ---------- frame loop ----------

let last = performance.now();
let time = 0;
/** The dinghy's outboard this frame (for the sound). */
let dinghyOut = { motorLevel: 0, stroke: false };
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
  time += dt * devSpeed;
  frames++;
  renderer.info.reset();
  host?.tick(dt);

  // The wind and your boat.
  updateWeather(time);
  let steer = 0;
  if (course) {
    const ap = autopilot(boat, wind, course);
    boat.sailSet = ap.sailSet;
    boat.throttle = ap.throttle;
    steer = ap.steer;
    if (ap.arrived) {
      const name = course.arrive ?? course.name;
      const why = dropAnchor(boat, seaBed);
      if (!why) {
        audio.anchorChain(true);
        hud.showCard(`Anchored off ${name}`, 'Swim or climb down the ladder to go ashore.', 5000);
        course = null;
        changedSinceSave = true;
      }
    }
  } else if (atHelm && started && view === 'fp' && !anyPanelOpen()) steer = input.move.x;
  const pushing = stepPushOff(dt);
  const sailEv = { grounded: 0, floated: false, over: 0, surfing: 0 };
  if (!pushing) {
    const simDt = dt * devSpeed;
    const n = Math.max(1, Math.ceil(simDt / 0.05));
    for (let i = 0; i < n; i++) {
      const e = stepBoat(boat, wind, { steer, attended: atHelm || !!course, slope: seaSlope(time), sailCondition: living.sailCondition, drag: living.drag }, seaBed, simDt / n);
      sailEv.grounded = Math.max(sailEv.grounded, e.grounded);
      sailEv.floated = sailEv.floated || e.floated;
      sailEv.over = Math.max(sailEv.over, e.over);
      sailEv.surfing = Math.max(sailEv.surfing, e.surfing);
    }
  }
  // Stuck a while? Say how to get off.
  if (boat.aground && !boat.anchored && player.aboard && (boat.agroundTime ?? 0) > 6 && time - lastStuckTip > 60) {
    lastStuckTip = time;
    hud.showCard(
      'Stuck aground',
      isTouch
        ? 'At the helm, tap “Push off” and you’ll push her off into deeper water. Or motor astern and steer away from the shallows.'
        : 'At the helm, press X (“Push off”) and you’ll push her off into deeper water. Or motor astern (F) and steer away from the shallows.',
      8000,
    );
  }
  surfing += (sailEv.surfing - surfing) * (1 - Math.exp(-dt * 3));
  overTime = sailEv.over > 0.05 && atHelm ? overTime + dt : 0;
  if (overTime > 1.2 && time - lastOverTip > 25) {
    lastOverTip = time;
    ui.toast(isTouch ? 'She’s overpowered! Tap “Less sail”, or steer off the wind.' : 'She’s overpowered! Take in some sail (S), or steer off the wind.', 3500);
  }
  if (sailEv.grounded > 0) {
    audio.thud(sailEv.grounded / 2);
    if (navigator.vibrate) navigator.vibrate([60, 40, 90]);
    ui.toast(boat.hull < 40 ? 'Aground again! The hull is badly scraped.' : 'Aground! You’ve scraped the hull. Steer for deeper water.', 3500);
    if (course) stopCourse(null);
    changedSinceSave = true;
  }
  if (sailEv.floated) ui.toast('Afloat again', 1800);
  {
    const twa = windAngle(boat, wind);
    const flogging = boat.sail > 0.3 && sailFill(twa) < 0.4 && wind.speed > 10 && !boat.anchored;
    living.update(dt, dt * devSpeed, time, wind.rain, sailEv.over, flogging, daylight.info.night);
    weatherAt(time, HOME_GARDEN.x, HOME_GARDEN.z, gardenRain, squalls);
    gardening.setPlanters(living.aboard.made.planter ?? 0);
    gardening.update(dt, dt * devSpeed, time, wind.rain, gardenRain.rain);
  }
  // Stuck head to wind at the helm for a while? A gentle tip, once.
  if (atHelm && !boat.anchored && boat.sail > 0.5 && Math.abs(boat.motor ?? 0) < 0.05 && Math.abs(boat.speed) < 0.3 && Math.abs(windAngle(boat, wind)) < SAILING.noGo) ironsTime += dt;
  else ironsTime = 0;
  if (ironsTime > 5 && !ironsTipShown) {
    ironsTipShown = true;
    hud.showCard(
      'In irons',
      isTouch
        ? 'The wind is straight ahead, so the sails can’t fill. Hold the steering hard to one side until the wind comes from the side, or give her a little motor.'
        : 'The wind is straight ahead, so the sails can’t fill. Hold A or D until the wind comes from the side (the arrow on the dial moves out of the red wedge), or press R for a little motor.',
      9000,
    );
  }
  // She stays within the waters on your chart.
  {
    const dx = boat.x - SEA_CENTRE.x;
    const dz = boat.z - SEA_CENTRE.z;
    const d = Math.hypot(dx, dz);
    if (d > SEA_RADIUS) {
      boat.x = SEA_CENTRE.x + (dx / d) * SEA_RADIUS;
      boat.z = SEA_CENTRE.z + (dz / d) * SEA_RADIUS;
      boat.speed *= 0.5;
      if (time - lastSea > 10) {
        lastSea = time;
        ui.toast('That’s the edge of your chart. Turn back toward the cays.', 3000);
      }
    }
  }
  weatherNotes(dt);
  buoyRun();
  boatMotion.update(time, dt, boat);
  bowSpray(dt);
  {
    // Each wake starts at a stern, where the water leaves the hull. (Starboard of the bow is (-sin h, cos h).)
    const c = Math.cos(boat.heading);
    const sn = Math.sin(boat.heading);
    const back = sloop.length * 0.48;
    wakes.forEach((w, i) => {
      const off = boatHulls[i];
      w.update(dt, boat.x - c * back - sn * off, boat.z - sn * back + c * off, boat.heading, boat.anchored ? 0 : Math.abs(boat.speed), (x, z) => seaHeight(x, z, time), daylight.info.night, daylight.info.daylight);
    });
  }
  if (rig) {
    const twa = windAngle(boat, wind);
    const boomTarget = boat.sail > 0.05 ? boomAngle(twa) : 0;
    RIG_SPEED.boom += (boomTarget - RIG_SPEED.boom) * (1 - Math.exp(-dt * 1.6));
    rig.setSail(boat.sail);
    rig.setBoom(RIG_SPEED.boom);
    rig.setJib(RIG_SPEED.boom);
    rig.setFill(sailFill(twa), time);
    rig.setRudder(boat.rudder);
    rig.setAnchored(boat.anchored);
    rig.setMotor?.(boat.motor ?? 0, time);
    rig.setLights?.(boat.anchored ? 'anchor' : 'underway', daylight.info.night);
  }
  // The dinghy: in the davits, towed astern, left afloat, or carrying you.
  dinghyOut = dinghy.update(dt, dt * devSpeed, time, dinghyDrive(), daylight.info.night, daylight.info.daylight);
  {
    // The dinghy stays within the waters on your chart too.
    const d = dinghy.state;
    const dx = d.x - SEA_CENTRE.x;
    const dz = d.z - SEA_CENTRE.z;
    const r = Math.hypot(dx, dz);
    if (d.where === 'water' && r > SEA_RADIUS) {
      d.x = SEA_CENTRE.x + (dx / r) * SEA_RADIUS;
      d.z = SEA_CENTRE.z + (dz / r) * SEA_RADIUS;
      d.speed *= 0.5;
    }
  }

  // The clock (paused while a menu or the logbook is open).
  if (started && !anyPanelOpen() && !holdTime) {
    advanceClock(clock, dt * devSpeed);
    washIfDue();
  }

  if (started && view === 'fp') {
    input.update();
    const paused = anyPanelOpen();
    if (!paused) {
      player.look(input.lookYaw, input.lookPitch);
      const action = atHelm ? null : currentAction();
      hud.setPrompt(action ? action.label : null, action?.kind === 'build' ? 'B' : 'E');
      // Taps on a phone (or clicks in drag-look mode) pick up what they touch.
      for (const tap of input.takeTaps()) {
        const r = screenRay(tap.x, tap.y);
        const f = beachView.pick(r, camera.position, PLAYER.reach + 0.4);
        if (f) pickUp(f.id);
      }
      if (atHelm) {
        if (input.wasPressed('KeyW') || input.wasPressed('ArrowUp')) sailUp();
        if (input.wasPressed('KeyS') || input.wasPressed('ArrowDown')) sailDown();
        if (input.wasPressed('KeyX')) toggleAnchor();
        if (input.wasPressed('KeyR')) motorUp();
        if (input.wasPressed('KeyF')) motorDown();
        if (input.wasPressed('KeyE') || input.wasPressed('Use') || input.wasPressed('Action')) leaveHelm();
        // Taking the wheel back from the autopilot.
        if (course && Math.abs(input.move.x) > 0.3) stopCourse('You have the helm.');
      } else if (input.wasPressed('KeyE') || input.wasPressed('Use') || input.wasPressed('Action')) doAction(action);
      if (player.seated) {
        // The outboard: R starts it, F stops it (W and S then work the throttle).
        if (input.wasPressed('KeyR')) dinghy.toggleMotor(true);
        if (input.wasPressed('KeyF')) dinghy.toggleMotor(false);
      }
      if (input.wasPressed('KeyB') && canBuildHere()) enterBuild();
      const jump = !atHelm && !player.seated && input.wasPressed('Space');
      if (jump && player.nearLadder()) {
        if (player.climbAboard()) audio.ladder();
      }
      const ev = player.update(dt, atHelm || player.seated ? { x: 0, y: 0 } : input.move, input.running, jump && player.mode !== 'swim');
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
    player.applyCamera(camera, player.seated ? dinghy.roll : boatMotion.rollAngle);
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

  // The weather where you stand: rain, a squall's cloud overhead.
  weatherAt(time, camera.position.x, camera.position.z, here, squalls);
  here.speed *= devWindK;
  rainNow += (here.rain - rainNow) * (1 - Math.exp(-dt / 2.0));
  {
    let over = 0;
    for (const q of squalls) {
      const d = Math.hypot(camera.position.x - q.x, camera.position.z - q.z);
      over = Math.max(over, q.strength * (1 - smooth01(0.9 * q.radius, 1.9 * q.radius, d)));
    }
    overheadNow += (over - overheadNow) * (1 - Math.exp(-dt / 2.0));
  }
  daylight.weather.rain = rainNow;
  daylight.weather.overhead = overheadNow * 0.6;
  windAt(time, tradeWind);
  ocean.setWeather(tradeWind.speed * devWindK, squalls);
  audio.setWeather(rainNow, here.speed);
  // The far islands drift part of the way with you: you never quite reach them.
  distant.position.set(camera.position.x * 0.6, 0, camera.position.z * 0.6);

  // Light, sky and water.
  const light = daylight.update(dt, time, clock);
  fishingLine.setDaylight(light.daylight);
  weatherFx.setLocalRain(rainNow);
  weatherFx.update(
    squalls,
    camera,
    time,
    dt,
    { daylight: light.daylight, night: light.night, sunDir: SKY.sunDir, sunColor: SKY.sunColor, horizon: SKY.horizon, zenith: SKY.zenith },
    -Math.cos(here.from) * here.speed,
    -Math.sin(here.from) * here.speed,
  );
  // The far islands take on the colour of the haze at the horizon.
  (distant.material as THREE.MeshBasicMaterial).color.copy(SKY.horizon).multiplyScalar(0.62 + 0.25 * light.daylight);
  sky.update(time, camera.position);
  ocean.update(time, camera.position);
  sandUniforms.uTime.value = time;
  sunView.copy(SKY.sunDir).transformDirection(camera.matrixWorldInverse);
  sandUniforms.uSunView.value.copy(sunView);
  particles.uniforms.uSunView.value.copy(sunView);
  swayTime.value = time;
  cursor.update(dt, time);
  beachView.update(player.feet, time, daylight.info.daylight, window.innerHeight * renderer.getPixelRatio());
  sharks.update(dt, dt * devSpeed, time, youForSharks(), camera.position, daylight.info.daylight);
  if (Math.hypot(camera.position.x - BUOY.x, camera.position.z - BUOY.z) < 900) seaBuoy.update(time, (x, z) => seaHeight(x, z, time), daylight.info.night, window.innerHeight * renderer.getPixelRatio());

  // What you're carrying.
  held.setContents(beach.state.basket);
  held.update(dt, {
    walking: Math.min(1, player.speed / 2),
    // Both hands on the tiller at the helm, so the basket is put down.
    hide: !started || view !== 'fp' || player.mode === 'swim' || player.mode === 'climb' || anyPanelOpen() || atHelm || (player.seated && !living.rodHeld),
    sunDir: sunView,
    sunColor: SKY.sunColor,
    sunIntensity: sun.intensity,
    hemiIntensity: hemi.intensity,
    env: envTex,
  });
  hud.setBasket(beach.state.basket.length);
  {
    const aboard = player.aboard;
    sailHud.show(started && view === 'fp' && (atHelm || (aboard && (!boat.anchored || boat.sail > 0.05)) || !!course), started && view === 'fp' && atHelm);
    if (frames % 6 === 0) {
      const twa = windAngle(boat, wind);
      sailHud.update({
        windRel: twa,
        compass: (((90 - (boat.heading * 180) / Math.PI) % 360) + 360) % 360,
        knots: Math.abs(boat.speed) * 1.944,
        windKnots: wind.speed * 1.944,
        point: pointOfSail(twa),
        sail: boat.sail,
        sailSet: boat.sailSet,
        anchored: boat.anchored,
        aground: boat.aground && !boat.anchored,
        course: course ? course.name : null,
        motor: motorWord(boat.throttle ?? 0),
        windWord: windWord(wind.speed * 1.944),
        over: overTime > 0.5,
        surfing: surfing > 0.6,
        rain: wind.rain > 0.25,
      });
      if (chart.open) renderChart();
      if (devTools.open) devTools.setInfo(devInfo());
    }
    const nearDinghy = player.seated || Math.hypot(player.feet.x - dinghy.state.x, player.feet.z - dinghy.state.z) < 60;
    if (dinghyOut.motorLevel > 0 && nearDinghy) audio.setMotor(dinghyOut.motorLevel, true);
    else audio.setMotor(Math.abs(boat.motor ?? 0), aboard || Math.hypot(player.feet.x - boat.x, player.feet.z - boat.z) < 60);
    audio.setSailing(Math.abs(boat.speed), wind.speed, boat.sail * (1 - sailFill(windAngle(boat, wind))) * (boat.anchored ? 0 : 1), boat.heel, aboard);
  }
  hud.setClock(formatClock(clock));
  updateLookHint();
  // Ida's notebook: progress, the next step, tips, and the buttons for now.
  storyTimer -= dt;
  if (storyTimer <= 0 && started) {
    storyTimer = 0.5;
    checkNotebook();
  }
  updateGuide();
  updateButtons();

  // Sound: louder surf near the beach.
  const shoreDist = Math.abs(world.nearest(player.feet.x, player.feet.z).coast);
  audio.setShore(Math.max(0, 1 - shoreDist / 40));
  const lapH = seaHeight(player.feet.x, player.feet.z, time);
  audio.update(dt, Math.min(1, Math.max(0, 0.5 + lapH / 0.08)), pendingEvents, handWet / 255);
  pendingEvents = null;

  pipeline.shadowSpan = view === 'build' ? Math.min(14, Math.max(4, cam.dist * 1.1)) : 16;
  pipeline.render(started && view === 'fp' && !blend, view === 'build' ? cam.target : player.feet);
  lastDraws = renderer.info.render.calls;
  lastTris = renderer.info.render.triangles;
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
    if (showFps) {
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
  sloopPoints: sloop.points,
  trunks,
  gardening,
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
      updateWeather(time);
      stepBoat(boat, wind, { steer: 0, attended: atHelm || !!course, slope: seaSlope(time) }, seaBed, 1 / 30);
      boatMotion.update(time, 1 / 30, boat);
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
  get boat() {
    return boat;
  },
  wind,
  takeHelm,
  leaveHelm,
  get atHelm() {
    return atHelm;
  },
  sailUp,
  sailDown,
  motorUp,
  motorDown,
  toggleAnchor,
  startCourse,
  get course() {
    return course ? course.name : null;
  },
  toggleChart,
  /** Test helper: sail for some seconds in even steps (autopilot or a fixed helm). */
  sail: (seconds: number, steerInput = 0) => {
    let maxSurf = 0;
    let maxSpeed = 0;
    let maxOver = 0;
    for (let t = 0; t < seconds; t += 1 / 30) {
      time += 1 / 30;
      updateWeather(time);
      let st = steerInput;
      if (course) {
        const ap = autopilot(boat, wind, course);
        boat.sailSet = ap.sailSet;
        boat.throttle = ap.throttle;
        st = ap.steer;
        if (ap.arrived && !dropAnchor(boat, seaBed)) course = null;
      }
      const ev = stepPushOff(1 / 30) ? { grounded: 0, floated: false, over: 0, surfing: 0 } : stepBoat(boat, wind, { steer: st, attended: true, slope: seaSlope(time), sailCondition: living.sailCondition, drag: living.drag }, seaBed, 1 / 30);
      maxSurf = Math.max(maxSurf, ev.surfing);
      maxSpeed = Math.max(maxSpeed, boat.speed);
      maxOver = Math.max(maxOver, ev.over);
      boatMotion.update(time, 1 / 30, boat);
      bowSpray(1 / 30);
      buoyRun();
      // Living aboard goes on too: rain into the tank, leaks, sail wear.
      living.update(1 / 30, 1 / 30, time, wind.rain, ev.over, false, daylight.info.night);
      player.update(1 / 30, { x: 0, y: 0 }, false, false);
    }
    return { x: boat.x, z: boat.z, speed: boat.speed, anchored: boat.anchored, aground: boat.aground, hull: boat.hull, course: course ? course.name : null, maxSurf, maxSpeed, maxOver, wind: wind.speed, open: wind.open, rain: wind.rain, heading: boat.heading };
  },
  /** The camera's and the boat's lean now (radians), for the checks. */
  get pose() {
    return { cameraRoll: camera.rotation.z, boatRoll: boatMotion.rollAngle, heel: boat.heel, boatRotX: sloop.group.rotation.x, boatRotZ: sloop.group.rotation.z, playerMode: player.mode };
  },
  /** v0.8: the dinghy, the sharks, Ida's notebook and the guide. */
  dinghy,
  sharks,
  guide,
  world,
  get story() {
    return story;
  },
  sharkZones: SHARK_ZONES,
  bank: BANK,
  toggleNotebook: (on?: boolean) => toggleNotebook(on),
  checkNotebook: () => checkNotebook(),
  throwBait: () => throwBait(),
  nextGoal: () => nextGoal(story),
  /** Test helper: row (or motor) the dinghy you're sitting in for a while, as if holding the keys. */
  row: (seconds: number, ahead = 1, steer = 0) => {
    let stroke = 0;
    for (let t = 0; t < seconds; t += 1 / 30) {
      time += 1 / 30;
      updateWeather(time);
      stepBoat(boat, wind, { steer: 0, attended: false, slope: 0 }, seaBed, 1 / 30);
      boatMotion.update(time, 1 / 30, boat);
      const o = dinghy.update(1 / 30, 1 / 30, time, player.seated ? { ahead, steer } : { ahead: 0, steer: 0 }, daylight.info.night, daylight.info.daylight);
      if (o.stroke) stroke++;
      player.update(1 / 30, { x: 0, y: 0 }, false, false);
      sharks.update(1 / 30, 1 / 30, time, youForSharks(), camera.position, daylight.info.daylight);
    }
    const d = dinghy.state;
    return { x: d.x, z: d.z, heading: d.heading, speed: d.speed, aground: d.aground, motor: d.motor, strokes: stroke, seated: player.seated, feet: player.feet.toArray() };
  },
  /** Test helper: call up a squall (or clear it with null). */
  forceSquall: (x: number | null, z = 0, radius = 180, strength = 1) => {
    forcedSquall = x === null ? null : { id: -1, x, z, radius, strength, vx: 0, vz: 0 };
  },
  /** Test helper: put the boat somewhere, under way, heading h. */
  placeBoat: (x: number, z: number, h: number) => {
    boat.x = x;
    boat.z = z;
    boat.heading = h;
    boat.anchored = false;
    boat.aground = false;
    boatMotion.update(time, 1, boat);
  },
  sprayStats,
  get records() {
    return { ...records, run: { ...run } };
  },
  pushOff: () => startPushOff(),
  get pushing() {
    return !!pushOff;
  },
  devTools: (on?: boolean) => toggleDevTools(on),
  /** Test helper: squalls on or off (as the dev tools' switch). */
  squallsOn: (on: boolean) => {
    devSqualls = on;
    if (!on) forcedSquall = null;
  },
  get devOpen() {
    return devTools.open;
  },
  living,
  sleep: () => sleepUntilMorning(),
  get sleeping() {
    return sleeping;
  },
  get weather() {
    return { wind: wind.speed, from: wind.from, open: wind.open, rain: wind.rain, squall: wind.squall, rainHere: rainNow, squalls: squalls.length };
  },
  sandInfo: () => ({ edited: editedTiles.size, shown: sand.group.children.filter((m) => m.visible).length, tiles: sand.group.children.length, standIn: standIn.visible }),
  time: () => time,
};

function smooth01(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
