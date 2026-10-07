/**
 * Wind, Wing & Wave: the page. Sets up the 3D scene, starts the engine, creates every page
 * system, routes engine messages, and runs the frame loop. It also owns the shell: the
 * camera and controls, the interface, watch mode, saving, and the frame-rate and sharpness
 * guards (docs/ARCHITECTURE.md §6 and §7).
 *
 * Rendering systems plug in through the factory functions below and the PageSystem interface;
 * their creation and update order is the contract in ARCHITECTURE §6.1 and must stay as is.
 */
import * as THREE from 'three';
import { GAME_TITLE, GAME_VERSION, NP, PACE_YPS, PATCH_M, ORIGIN_X, ORIGIN_Z, brushRadius, type BrushSize, type ToolId } from './config';
import { SPECIES } from './content/species';
import { createAudio } from './audio/audio';
import { startEngine, type EngineHost } from './engine/host';
import type { DebugOp, FromEngine, IslandInfo, LifeInfo, PageSaveHeader, StormState, ToEngine } from './engine/protocol';
import { OrbitCamera, type DriftFocus } from './input/camera';
import { Controls } from './input/controls';
import { createCursor } from './render/cursor';
import { createDaylight } from './render/daylight';
import { createEffects } from './render/effects';
import { createFauna } from './render/fauna';
import { WorldFields } from './render/fields';
import { createHands } from './render/hands';
import { createOcean } from './render/ocean';
import { createPonds } from './render/ponds';
import {
  createWorldUniforms,
  wrapTime,
  type BrushInfo,
  type FrameCtx,
  type PagePrefs,
  type PageSystem,
  type Quality,
  type SystemDeps,
} from './render/shared';
import { createSky } from './render/sky';
import { createTerrain } from './render/terrain';
import { createVegetation } from './render/vegetation';
import { createVignettes } from './render/vignettes';
import { createWeather } from './render/weather';
import { downloadFile, loadAutosaves, loadSettings, pickFile, saveAutosave, saveFileName, saveSettings, testStorage, withTimeout, type Settings } from './storage/storage';
import { engineCheckRows, pageCheckRows, type CheckRow } from './ui/checks';
import type { SeaSteps } from './ui/onboarding';
import { FramePacer, ResolutionGovernor } from './ui/pacing';
import { TOOL_ORDER } from './ui/text';
import { Ui } from './ui/ui';
import { ScreenAwake, WatchDirector } from './ui/watch';

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
renderer.shadowMap.enabled = true; // never toggled at runtime (ARCHITECTURE §7): quality.shadows only decides casters
renderer.shadowMap.type = THREE.PCFShadowMap;

/**
 * Triangles and draw calls of the shadow pass, measured around three.js's own shadow render
 * (renderer.info counts both passes together), so the budgets for the main pass and the
 * shadow pass (ARCHITECTURE §7) can be checked separately. `frame` is what this frame's
 * shadow pass drew; `latest` is the last shadow map actually drawn (a system may draw the
 * shadow map only now and then).
 */
const shadowPass = { frameTriangles: 0, frameCalls: 0, latestTriangles: 0, latestCalls: 0 };
{
  const sm = renderer.shadowMap;
  const drawShadows = sm.render.bind(sm);
  sm.render = (lights, sc, cm) => {
    const willDraw = sm.enabled && (sm.autoUpdate || sm.needsUpdate);
    const r = renderer.info.render;
    const t0 = r.triangles;
    const c0 = r.calls;
    drawShadows(lights, sc, cm);
    shadowPass.frameTriangles = r.triangles - t0;
    shadowPass.frameCalls = r.calls - c0;
    if (willDraw) {
      shadowPass.latestTriangles = shadowPass.frameTriangles;
      shadowPass.latestCalls = shadowPass.frameCalls;
    }
  };
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 1, 16000);

/** Sharpest pixel ratio allowed for a graphics setting (dynamic resolution works below it). */
function pixelCapFor(q: Settings['quality']): number {
  if (q === 'lighter') return Math.max(1, Math.min(dpr, 1.25));
  if (q === 'richer') return Math.max(1, Math.min(dpr, isTouch ? 2 : 2.5));
  return Math.max(1, Math.min(dpr, isTouch ? 1.75 : 2));
}
function tierFor(q: Settings['quality']): 0 | 1 | 2 {
  return q === 'lighter' ? 0 : q === 'richer' ? 2 : isTouch ? 1 : 2;
}
function densityFor(tier: 0 | 1 | 2): number {
  return (isTouch ? [0.55, 0.8, 1.0] : [0.7, 1.0, 1.2])[tier];
}

/**
 * Sharpness and detail follow smoothness: the governor lowers the pixel ratio when frames run
 * long and, on "auto", the detail tier after a sustained strain, and brings both back later.
 */
const governor = new ResolutionGovernor(1, pixelCapFor(settings.quality));
governor.setTier(tierFor(settings.quality), settings.quality === 'auto');
const quality: Quality = {
  setting: settings.quality,
  phone: isTouch,
  tier: governor.tier,
  density: densityFor(governor.tier),
  // The lightest tier only stops things casting shadows; the renderer's shadow map stays on.
  shadows: governor.tier > 0,
};

const fields = new WorldFields();
const u = createWorldUniforms(fields);
/** Preferences systems read live; kept in step with the settings. */
const prefs: PagePrefs = { fewerFlashes: settings.fewerFlashes, sound: settings.sound, dayMode: settings.dayMode, vibration: settings.vibration, volume: settings.volume };
const deps: SystemDeps = { renderer, scene, camera, fields, u, quality, species: SPECIES, isTouch, prefs };

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
daylight.setMode(settings.dayMode);
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
const brushInfo: BrushInfo = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, r: 1 };
let stroking = false;
let strokeOpen = false;
const lastStroke = { x: 0, z: 0 };
let watching = false;
let undoCount = 0;
let enginePaused = false;
let lavaArea = 0;
let rockPlaced = 0;
let glow = { x: 0, z: 0 };
/** The full tray appears once the first land has cooled (Lava alone before that). */
let trayFull = false;
let landTime = 0;
/** A load or a new sea is replacing the world. */
let swapping: 'load' | 'reset' | null = null;
/** Screenshot preview of the first minute (no land yet), until the next input. */
let previewNoLand = false;
/** The sea's real first-minute steps, put back when the preview ends. */
let stepsBeforePreview: SeaSteps = { island: false, keep: false };

const director = new WatchDirector();
const awake = new ScreenAwake();
const pacer = new FramePacer();

// ---------- the interface ----------

let viewW = window.innerWidth;
let viewH = window.innerHeight;
const projV = new THREE.Vector3();
/** Screen position (CSS px) of a world point; false when behind the camera or well off screen. */
function projectTo(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
  projV.set(x, y, z).project(camera);
  if (projV.z > 1 || projV.z < -1) return false;
  out.x = ((projV.x + 1) / 2) * viewW;
  out.y = ((1 - projV.y) / 2) * viewH;
  return out.x > -80 && out.x < viewW + 80 && out.y > -80 && out.y < viewH + 80;
}

const ui = new Ui({
  actions: {
    start: () => startPlaying(),
    selectTool: (t) => selectTool(t, true),
    cycleSize: () => setSize(((size + 1) % 3) as BrushSize),
    undo: () => doUndo(),
    glideTo: (x, z) => cam.glideTo(x, z, 150),
    panelsChanged: () => {
      idle = 0;
      syncPause();
    },
    photo: () => (photoPending = true),
    saveFile: () => void saveToFile(),
    loadFile: () => void loadFromFile(),
    newSea: () => newSea(),
    runChecks: () => void runChecks(),
    rename: (island, name) => send({ t: 'rename', island, name }),
    home: () => home(),
    settingChanged: (key) => settingChanged(key),
    click: () => audio.click(),
    pageTurn: () => audio.page(),
  },
  species: SPECIES,
  fields,
  settings,
  touch: isTouch,
  project: projectTo,
});
ui.setTool(tool);
ui.setSize(size);
ui.setUndo(0);
ui.setTrayFull(false);
ui.sheets.setAbout(`Version ${GAME_VERSION} · built ${__BUILD_TIME__.slice(0, 16).replace('T', ' ')}`);

/**
 * Choose a tool. Lava alone is offered until the first land cools; `force` (the scripted
 * __game hook only) brings out the full tray at once, so scripts can pick any tool on any sea.
 */
function selectTool(t: ToolId, byPlayer: boolean, force = false): void {
  if (!trayFull && t !== 'lava') {
    if (!force) return;
    setTrayFull(true);
  }
  if (byPlayer && started) ui.onboarding.toolChosen(t);
  if (byPlayer) lookHeldFrom = null;
  if (t === tool) return;
  tool = t;
  ui.setTool(t);
  if (brush) brush.r = brushRadiusNow();
}

function setSize(s: BrushSize): void {
  size = s;
  ui.setSize(s);
}

function doUndo(): void {
  if (undoCount === 0 || !host || swapping) return;
  send({ t: 'undo' });
  ui.toast('Undone', 1.4);
}

function panelsOpen(): boolean {
  return ui.journalOpen || ui.menuOpen;
}

// ---------- talking to the engine ----------

/** The last message of each kind sent to the engine (except the big init and load ones), for the browser checks. */
const lastSent = new Map<ToEngine['t'], ToEngine>();

function send(m: ToEngine, transfer?: Transferable[]): void {
  if (!host) return;
  if (m.t !== 'init' && m.t !== 'load') lastSent.set(m.t, m);
  host.send(m, transfer);
}

// ---------- engine requests that wait for an answer ----------

let nextId = 1;
const waiters = new Map<number, (m: FromEngine) => void>();
type Asked = Extract<ToEngine, { id: number }>;

/** Send a message carrying an id and wait for the engine's answer with the same id (or null on timeout). */
function ask(msg: Asked, ms: number, transfer?: Transferable[]): Promise<FromEngine | null> {
  return new Promise((resolve) => {
    if (!host) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      waiters.delete(msg.id);
      resolve(null);
    }, ms);
    waiters.set(msg.id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    send(msg, transfer);
  });
}

function debugOp(op: DebugOp, extra: Omit<Extract<ToEngine, { t: 'debug' }>, 't' | 'id' | 'op'> = {}): Promise<unknown> {
  return ask({ t: 'debug', id: nextId++, op, ...extra }, 120000).then((m) => (m && m.t === 'debugResult' ? m.data : null));
}

// ---------- picking, the brush, and Look ----------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pick(sx: number, sy: number): { x: number; y: number; z: number } | null {
  ndc.set((sx / viewW) * 2 - 1, -(sy / viewH) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const ray = raycaster.ray;
  const hit = fields.raycast(ray.origin, ray.direction);
  return hit ? { x: hit.x, y: hit.y, z: hit.z } : null;
}

function brushRadiusNow(): number {
  return tool === 'look' ? Math.max(1.2, Math.min(10, cam.dist * 0.015)) : brushRadius(size, cam.dist);
}

const normalTmp = new THREE.Vector3();
function setBrush(p: { x: number; y: number; z: number } | null): void {
  if (!p) {
    brush = null;
    return;
  }
  const n = fields.normalAt(p.x, p.z, normalTmp);
  brushInfo.x = p.x;
  brushInfo.y = p.y;
  brushInfo.z = p.z;
  brushInfo.nx = n.x;
  brushInfo.ny = n.y;
  brushInfo.nz = n.z;
  brushInfo.r = brushRadiusNow();
  brush = brushInfo;
}

let lookId = 0;
function lookAt(x: number, z: number): void {
  const id = nextId++;
  lookId = id;
  void ask({ t: 'inspect', id, x, z }, 4000).then((m) => {
    if (m && m.t === 'inspected' && id === lookId) ui.look(m.info);
  });
}

// ---------- controls ----------

let idle = 0;
let lookHeldFrom: ToolId | null = null;

/** Any input: leaves watch mode. Returns true if it was watching (that touch only wakes the screen). */
function wake(): boolean {
  idle = 0;
  if (previewNoLand) {
    previewNoLand = false;
    ui.setTrayFull(trayFull);
    ui.setSea(stepsBeforePreview, ui.directHints);
  }
  if (!watching) return false;
  watching = false;
  ui.setWatching(false);
  awake.set(false);
  // Coming back from watching, the first thing people do is look at what happened.
  if (trayFull && tool !== 'look') {
    selectTool('look', false);
    ui.onboarding.toolChosen('look');
  }
  return true;
}

const controls = new Controls(canvas, cam, {
  stroke: (phase, sx, sy) => {
    if (!host) return;
    // Only a start needs the game to be open for shaping; a stroke already under way may always finish.
    if (phase === 'start' && (!ready || !started || swapping || panelsOpen())) return;
    const p = pick(sx, sy);
    if (tool === 'look') {
      setBrush(p);
      if (phase === 'start' && p) lookAt(p.x, p.z);
      if ((phase === 'end' || phase === 'cancel') && isTouch) brush = null;
      return;
    }
    if (phase === 'start') {
      if (!p) return;
      strokeOpen = true;
      ui.pins.closeLook();
    }
    if (!strokeOpen) return;
    setBrush(p);
    if (p) {
      lastStroke.x = p.x;
      lastStroke.z = p.z;
    } else if (phase === 'move') return; // off the world: hold the last point
    stroking = phase === 'start' || phase === 'move';
    send({ t: 'stroke', phase, tool, x: lastStroke.x, z: lastStroke.z, radius: brushRadius(size, cam.dist), strength: 1 });
    if (!stroking) {
      strokeOpen = false;
      if (isTouch) brush = null;
    }
  },
  hover: (sx, sy) => setBrush(pick(sx, sy)),
  leave: () => (brush = null),
  tap: (sx, sy) => {
    if (!ready || !started || swapping || panelsOpen()) return;
    const p = pick(sx, sy);
    if (tool === 'look' && p) lookAt(p.x, p.z);
    else ui.pins.closeLook();
  },
  glideTo: (sx, sy) => {
    const p = pick(sx, sy);
    if (p) cam.glideTo(p.x, p.z, Math.min(cam.dist, 400));
  },
  pick,
  undo: () => doUndo(),
  selectTool: (i) => selectTool(TOOL_ORDER[i] ?? 'lava', true),
  cycleSize: (d) => setSize(Math.max(0, Math.min(2, size + d)) as BrushSize),
  journal: () => ui.toggleJournal(),
  lookHold: (on) => {
    if (on && tool !== 'look' && trayFull && !stroking) {
      lookHeldFrom = tool;
      selectTool('look', false);
    } else if (!on && lookHeldFrom) {
      selectTool(lookHeldFrom, false);
      lookHeldFrom = null;
    }
  },
  home: () => home(),
  photo: () => (photoPending = true),
  escape: () => ui.escape(),
  interacted: (kind) => {
    if (started && kind !== 'hover') audio.start(); // sound may only begin from a real touch, click or key
    return wake();
  },
  blocked: () => panelsOpen(),
});
// A touch anywhere (a card, a faded button) also wakes the screen; the canvas handles its own.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target !== canvas) wake();
  },
  true,
);

/** Frame all the islands (or the glow, before there is land). */
function home(): void {
  const isl = life?.islands ?? [];
  if (isl.length) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const i of isl) {
      x0 = Math.min(x0, i.bbox[0]);
      z0 = Math.min(z0, i.bbox[1]);
      x1 = Math.max(x1, i.bbox[2]);
      z1 = Math.max(z1, i.bbox[3]);
    }
    cam.frameBox(x0, z0, x1, z1);
  } else cam.glideTo(glow.x, glow.z, 300, undefined, true);
}

/** Where watch mode looks when nothing new is happening: the biggest island, or the glow. */
const restFocus: DriftFocus = { x: 0, z: 0, dist: 120 };
const NO_ISLANDS: readonly IslandInfo[] = [];
function fallbackFocus(): DriftFocus {
  let best = -1;
  for (const i of life?.islands ?? NO_ISLANDS) {
    if (i.area > best) {
      best = i.area;
      restFocus.x = i.centroid[0];
      restFocus.z = i.centroid[1];
      restFocus.dist = 120;
    }
  }
  if (best < 0) {
    restFocus.x = glow.x;
    restFocus.z = glow.z;
    restFocus.dist = 220;
  }
  return restFocus;
}

// Plants popping up are something to watch: note where canopy and shrub cover jumps.
const seenCover = new Uint8Array(NP * NP * 2);
fields.onEco.push((x0, z0, w, h) => {
  let n = 0;
  let sx = 0;
  let sz = 0;
  for (let k = z0; k < z0 + h; k++) {
    for (let i = x0; i < x0 + w; i++) {
      const p = i + k * NP;
      const canopy = fields.plants[p * 6 + 1];
      const shrub = fields.plants[p * 6 + 3];
      if (canopy > seenCover[p * 2] + 40 || shrub > seenCover[p * 2 + 1] + 40) {
        n++;
        sx += i;
        sz += k;
      }
      seenCover[p * 2] = canopy;
      seenCover[p * 2 + 1] = shrub;
    }
  }
  if (n > 0 && started && !swapping) {
    director.note('growth', ORIGIN_X + (sx / n + 0.5) * PATCH_M, ORIGIN_Z + (sz / n + 0.5) * PATCH_M, time, Math.min(2, 0.4 + n / 25));
  }
});

// ---------- engine messages ----------

let errorShownAt = -1e9;

function onEngine(m: FromEngine): void {
  fields.apply(m);
  for (const s of systems) s.onEngine?.(m);
  switch (m.t) {
    case 'progress':
      if (!ready) ui.setProgress(m.done, m.total);
      break;
    case 'ready':
      glow = m.glow;
      ui.setGlow(glow.x, glow.z);
      firstLand = m.firstLand;
      year = m.year;
      if (!ready) {
        ready = true;
        // The engine starts with its clocks running: stop them at once, so a resumed sea's
        // years and storms wait behind the start screen while shaders compile.
        syncPause();
        void prepare(m.resumed, m.header);
      } else finishSwap(m.header);
      break;
    case 'clear':
      strokeOpen = false;
      stroking = false;
      ui.pins.clear();
      director.forget();
      life = null;
      ui.setLife(null);
      undoCount = 0;
      ui.setUndo(0);
      break;
    case 'life':
      life = m.life;
      ui.setLife(life);
      for (const c of life.colonies) director.note('colony', c.x, c.z, time, 0.25 + c.n * 0.35);
      break;
    case 'journal':
      ui.addJournal(m.entries, !!m.reset, firstLand);
      if (!m.reset && started) {
        for (const e of m.entries) {
          if (e.x !== undefined && e.z !== undefined && (e.kind === 'arrival' || e.kind === 'return' || e.kind === 'visit')) director.note('arrival', e.x, e.z, time);
          if (e.kind === 'age') {
            ui.nudgeKeepCopy();
            void autosave();
          }
        }
      }
      break;
    case 'tick': {
      year = m.year;
      firstLand = m.firstLand;
      storm = m.storm;
      enginePaused = m.paused;
      if (m.undo !== undoCount) {
        undoCount = m.undo;
        ui.setUndo(undoCount);
      }
      const ev = m.events;
      lavaArea = ev.lavaArea;
      rockPlaced += ev.rockPlaced;
      u.uLavaGlow.value.set(ev.lavaGlow[0], ev.lavaGlow[1], ev.lavaGlow[2], ev.lavaGlow[3]);
      if (ev.lavaGlow[3] > 0.2 && started) director.note('lava', ev.lavaGlow[0], ev.lavaGlow[1], time, ev.lavaGlow[3]);
      if (started) {
        for (const a of ev.arrivals) director.note('arrival', a.x, a.z, time, a.ok ? 1.2 : 0.8);
        for (const p of ev.places) {
          ui.place(p, Math.max(0, fields.heightAt(p.x, p.z)));
          director.note('place', p.x, p.z, time);
        }
      }
      ui.setYear(year, PACE_YPS[settings.pace]);
      break;
    }
    case 'inspected':
    case 'saved':
    case 'loaded':
    case 'checks':
    case 'debugResult': {
      const w = waiters.get(m.id);
      if (w) {
        waiters.delete(m.id);
        w(m);
      }
      break;
    }
    case 'error':
      console.error(m.message);
      if (time - errorShownAt > 10) {
        errorShownAt = time;
        ui.toast(`Something went wrong in the island engine: ${m.message}`, 6);
      }
      break;
    default:
      break;
  }
}

/** First-minute steps for a sea: skipped when there is already land. */
function seaSteps(h: PageSaveHeader | undefined): SeaSteps {
  const s = h?.ui?.steps as Partial<SeaSteps> | undefined;
  return { island: s?.island ?? firstLand, keep: s?.keep ?? firstLand };
}

/** Field-guide hints this sea has already sharpened to the direct line. */
function seaHints(h: PageSaveHeader | undefined): readonly unknown[] {
  const list = h?.ui?.hints;
  return Array.isArray(list) ? list : [];
}

function setTrayFull(on: boolean): void {
  trayFull = on;
  landTime = 0;
  ui.setTrayFull(on);
  if (!on && tool !== 'lava') {
    tool = 'lava';
    ui.setTool('lava');
  }
}

/** Restore the page's part of a save: camera, sky clock, tool, first-minute steps, sharpened hints. */
function applyHeader(h: PageSaveHeader): void {
  if (Array.isArray(h.camera) && h.camera.length >= 6) cam.state = h.camera;
  if (Number.isFinite(h.dayPhase) && h.dayPhase >= 0) daylight.setPhase(h.dayPhase % 1, Math.floor(h.dayPhase));
  const ui0 = h.ui ?? {};
  setTrayFull(ui0.trayFull === true || firstLand);
  ui.setSea(seaSteps(h), seaHints(h));
  if (typeof ui0.size === 'number' && ui0.size >= 0 && ui0.size <= 2) setSize(ui0.size as BrushSize);
  if (typeof ui0.tool === 'string' && (TOOL_ORDER as readonly string[]).includes(ui0.tool)) selectTool(ui0.tool as ToolId, false);
}

/** The page's part of a save. */
function header(): PageSaveHeader {
  return {
    camera: cam.state,
    dayPhase: daylight.day.day + daylight.day.phase,
    ui: { steps: { ...(previewNoLand ? stepsBeforePreview : ui.onboarding.sea) }, hints: ui.directHints, trayFull, tool, size },
  };
}

/** Look at a fresh sea's glow from a gentle height. */
function frameGlow(glideSeconds?: number): void {
  if (glideSeconds) cam.glideTo(glow.x, glow.z, 300, glideSeconds, true);
  else cam.state = [glow.x, 0, glow.z, 300, -0.5, 0.9];
}

/** The world has loaded for the first time: set the scene, compile shaders, offer Begin. */
async function prepare(resumed: boolean, h: PageSaveHeader | undefined): Promise<void> {
  if (h) applyHeader(h);
  else {
    setTrayFull(firstLand);
    ui.setSea(seaSteps(undefined), []);
    if (firstLand) {
      cam.state = [40, 0, -20, 420, -0.6, 0.75];
      home();
    } else frameGlow();
  }
  let resumedNow = resumed;
  const older = recovery;
  recovery = null;
  if (older && !resumed) {
    // The newest autosave would not open (the engine started a fresh sea instead): try the copy before it.
    swapping = 'load';
    const m = await ask({ t: 'load', id: nextId++, data: older }, 60000, [older]);
    if (m && m.t === 'loaded' && m.ok) {
      resumedNow = true;
      if (m.header) applyHeader(m.header);
    } else swapping = null;
  }
  cam.update(0);
  try {
    await withTimeout(renderer.compileAsync(scene, camera), 8000, 'Preparing the graphics');
  } catch {
    /* compiling on first use instead is slower but fine */
  }
  ui.setReady(resumedNow);
  syncPause();
}

/** A load or a new sea has finished arriving. */
function finishSwap(h: PageSaveHeader | undefined): void {
  const was = swapping;
  swapping = null;
  ui.setBusy(null);
  if (h) applyHeader(h);
  else {
    setTrayFull(firstLand);
    ui.setSea(seaSteps(undefined), []);
    if (was === 'reset') frameGlow(3);
  }
  pauseSent = ''; // a replaced world starts with fresh clocks: tell it again whether to run
  syncPause();
  void autosave();
}

// ---------- start, pause, settings ----------

let recovery: ArrayBuffer | null = null;

async function boot(): Promise<void> {
  host = await startEngine(onEngine);
  let saves: Awaited<ReturnType<typeof loadAutosaves>> = [];
  try {
    saves = await withTimeout(loadAutosaves(), 12000, 'Reading your saved sea');
  } catch {
    saves = [];
  }
  recovery = saves[1]?.data ?? null;
  const save = saves[0]?.data ?? null;
  send({ t: 'init', save, seed: newSeed(), settings: { pace: settings.pace, gentleStorms: settings.gentleStorms } }, save ? [save] : []);
  console.log(`${GAME_TITLE} v${GAME_VERSION} (${__BUILD_TIME__}), engine on ${host.mode}`);
}

function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return (a[0] % 2147483646) + 1;
}

function startPlaying(): void {
  if (!ready || started) return;
  started = true;
  idle = 0;
  ui.hideStart();
  if (settings.sound) audio.start();
  canvas.focus();
  syncPause();
}

let pauseSent = '';
/** Years and storms stop while the journal or menu is open, before Begin, and when hidden. */
function syncPause(): void {
  if (!host || !ready) return;
  const hidden = document.visibilityState === 'hidden';
  const on = hidden || panelsOpen() || !started;
  const key = `${on}|${hidden}`;
  if (key === pauseSent) return;
  pauseSent = key;
  send({ t: 'pause', on, hidden });
}

document.addEventListener('visibilitychange', () => {
  syncPause();
  if (document.visibilityState === 'hidden') {
    awake.set(false);
    void autosave();
  } else if (watching) awake.set(true);
});
window.addEventListener('pagehide', () => void autosave());

/** The detail tier systems draw at (the governor may hold it below the setting's for a while). */
function applyTier(): void {
  quality.tier = governor.tier;
  quality.density = densityFor(quality.tier);
  quality.shadows = quality.tier > 0;
}

/** The graphics setting changed (or the browser checks asked for it as set): start from its own level. */
function applyQuality(): void {
  quality.setting = settings.quality;
  governor.setTier(tierFor(settings.quality), settings.quality === 'auto');
  applyTier();
  governor.cap = pixelCapFor(settings.quality);
  governor.reset(governor.cap);
  resizeWanted = true;
  drawNow = true;
}

function settingChanged(key: keyof Settings): void {
  saveSettings(settings);
  switch (key) {
    case 'pace':
    case 'gentleStorms':
      send({ t: 'settings', settings: { pace: settings.pace, gentleStorms: settings.gentleStorms } });
      ui.setYear(year, PACE_YPS[settings.pace]);
      break;
    case 'fewerFlashes':
      prefs.fewerFlashes = settings.fewerFlashes;
      break;
    case 'sound':
      prefs.sound = settings.sound;
      audio.setEnabled(settings.sound);
      if (settings.sound) audio.start();
      break;
    case 'volume':
      prefs.volume = settings.volume;
      break;
    case 'quality':
      applyQuality();
      break;
    case 'dayMode':
      prefs.dayMode = settings.dayMode;
      daylight.setMode(settings.dayMode);
      break;
    case 'vibration':
      prefs.vibration = settings.vibration;
      break;
    default:
      break; // cameraDrift and seen are read where they are used
  }
}

/**
 * The canvas needs a new size or sharpness (window, graphics setting or governor). Resizing
 * clears what the canvas shows, so it never happens on its own: the frame loop does it right
 * before it draws. A new window size or setting also draws at the very next animation frame,
 * whatever the frame cap says (`drawNow`), so the new layout shows at once.
 */
let resizeWanted = true;
let drawNow = true;
window.addEventListener('resize', () => {
  resizeWanted = true;
  drawNow = true;
});
/** Browser checks only: hold the graphics at the setting's own level (no automatic changes). */
let qualityHeld = false;

function resize(): void {
  resizeWanted = false;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  renderer.setPixelRatio(governor.ratio);
  renderer.setSize(viewW, viewH, false);
  camera.aspect = viewW / Math.max(1, viewH);
  camera.updateProjectionMatrix();
}

// ---------- saving ----------

let saving = false;
let yearsRunning = 0;
let warnedNoStorage = false;

/** Keep an automatic copy in the browser (every minute while years run, on hide, at each new Age). */
async function autosave(): Promise<void> {
  if (saving || !ready || !started || swapping) return;
  saving = true;
  try {
    const m = await ask({ t: 'save', id: nextId++, header: header() }, 15000);
    if (m && m.t === 'saved' && m.data && m.data.byteLength > 0) {
      const where = await saveAutosave(m.data, year);
      yearsRunning = 0;
      if (where === 'none' && !warnedNoStorage) {
        // Some phones won't let a page opened from Downloads keep anything: say so, once, kindly.
        warnedNoStorage = true;
        ui.toast('This browser won’t keep your sea by itself. Save a copy to a file now and then.', 10, { label: 'Save a copy', run: () => void saveToFile() });
      }
    }
  } finally {
    saving = false;
  }
}

async function saveToFile(): Promise<void> {
  if (!ready) return;
  ui.toast('Saving…', 15);
  const m = await ask({ t: 'save', id: nextId++, header: header() }, 20000);
  if (m && m.t === 'saved' && m.data && m.data.byteLength > 0) {
    downloadFile(m.data, saveFileName());
    ui.copySaved();
    ui.toast('Your sea is saved to a file. Keep it somewhere safe.', 4);
  } else {
    const why = m && m.t === 'saved' ? (m.error ?? 'there was nothing to save') : 'the island engine did not answer';
    ui.toast(`Couldn't save: ${why}.`, 6);
  }
}

async function loadFromFile(): Promise<void> {
  const data = await pickFile('.wwwsave,application/octet-stream');
  if (!data || !host) return;
  swapping = 'load';
  ui.setBusy('Opening your sea…');
  const m = await ask({ t: 'load', id: nextId++, data }, 90000, [data]);
  if (!m || m.t !== 'loaded' || !m.ok) {
    swapping = null;
    ui.setBusy(null);
    const why = m && m.t === 'loaded' && m.error ? m.error : 'the file could not be read';
    ui.toast(`Couldn't open that file: ${why}`, 6);
    return;
  }
  if (m.header) applyHeader(m.header);
  ui.toast('Your sea is back.', 3);
}

function newSea(): void {
  if (!host) return;
  swapping = 'reset';
  ui.setBusy('A new sea…');
  // The old sea's land and tray go now, so nothing about it shows while the new one arrives.
  firstLand = false;
  setTrayFull(false);
  ui.setSea({ island: false, keep: false }, []);
  send({ t: 'reset', seed: newSeed() });
}

// ---------- photo ----------

let photoPending = false;

/** Save the current view as a picture (the interface is never part of it). */
function savePhoto(): void {
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 400);
  // Must run right after render(): the drawing buffer is only readable until the frame ends.
  canvas.toBlob((blob) => {
    if (!blob) {
      ui.toast('That photo did not work on this device.', 4);
      return;
    }
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    downloadFile(blob, `wind-wing-wave-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.png`, 'image/png');
    ui.toast('Photo saved.', 2.5);
  }, 'image/png');
}

// ---------- the checks page ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runChecks(): Promise<void> {
  if (ui.sheets.checks.busy) return;
  ui.sheets.checks.showRunning();
  const engineAnswer = ask({ t: 'checks', id: nextId++, quick: true }, 90000);
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const storage = await testStorage();
  const wakeLock = await ScreenAwake.probe();
  const f0 = frames;
  const t0 = performance.now();
  await sleep(3500);
  const fps = ((frames - f0) * 1000) / (performance.now() - t0);
  const rows: CheckRow[] = pageCheckRows({
    webgl2: renderer.capabilities.isWebGL2,
    gpu,
    engine: host?.mode ?? 'none',
    storage,
    fps,
    fpsTarget: isTouch ? 45 : 60,
    wakeLock,
    pixelRatio: renderer.getPixelRatio(),
    screen: `${viewW}×${viewH} at ${dpr.toFixed(2)}×`,
    tier: governor.tier,
    chosenTier: governor.chosenTier,
  });
  const m = await engineAnswer;
  if (m && m.t === 'checks') rows.push(...engineCheckRows(m.results));
  else rows.push({ label: 'Land and life checks', pass: false, detail: 'The island engine did not answer in time.' });
  ui.sheets.checks.show(rows);
}

// ---------- frame loop ----------

let last = performance.now();
let time = 0;
let focusTimer = 0;
let frames = 0;
let vibeTimer = 0;

const f: FrameCtx = {
  t: 0,
  dt: 0,
  camera,
  cam,
  fields,
  u,
  quality,
  day: daylight.day,
  year: 0,
  firstLand: false,
  storm,
  life: null,
  tool,
  stroking: false,
  watching: false,
  isTouch,
  brush: null,
};
const onboardingState = { started: false, firstLand: false, trayFull: false, cameraMoved: false };

/** Seconds per frame to aim for right now (0 = as fast as the screen allows). */
function frameCap(): number {
  if (ui.journalOpen) return 1 / 8; // the notebook covers the view
  if (watching) return 1 / 30; // calm, and kinder to a phone left on a table
  return isTouch ? 1 / 45 : 0;
}

/** A gentle buzz while pouring (phones only): rolling for lava, a tick for sand, a thunk for rock. */
function vibrate(dt: number): void {
  vibeTimer -= dt;
  if (!prefs.vibration || !isTouch || !stroking || vibeTimer > 0 || typeof navigator.vibrate !== 'function') {
    rockPlaced = 0;
    return;
  }
  if (tool === 'lava') {
    navigator.vibrate(16);
    vibeTimer = 0.32;
  } else if (tool === 'rock' && rockPlaced > 0) {
    navigator.vibrate(22);
    vibeTimer = 0.25;
  } else if (tool === 'sand') {
    navigator.vibrate(5);
    vibeTimer = 0.45;
  } else if (tool === 'scoop') {
    navigator.vibrate(8);
    vibeTimer = 0.45;
  }
  rockPlaced = 0;
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const raw = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;
  const cap = frameCap();
  if (cap !== pacer.cap) {
    pacer.cap = cap;
    governor.reset(); // a new target: judge afresh
  }
  const dt = pacer.tick(raw, drawNow);
  if (dt < 0) return;
  drawNow = false;
  if (resizeWanted) resize(); // the canvas is cleared here and drawn again below, in this same frame
  time += dt;
  frames++;
  host?.tick(dt);
  controls.update(dt);

  // Watch mode: after a minute with no input the buttons fade and the camera drifts.
  if (started && ready && !panelsOpen() && !controls.busy && !swapping) idle += dt;
  else idle = 0;
  if (!watching && idle > 60) {
    watching = true;
    ui.setWatching(true);
    awake.set(true);
  }
  if (watching && settings.cameraDrift) {
    const focus = director.focus(time, fallbackFocus());
    if (focus) cam.drift(dt, focus);
  }
  cam.update(dt);
  u.uTime.value = wrapTime(time);
  u.uCamPos.value.copy(camera.position);
  if (brush) brush.r = brushRadiusNow();

  focusTimer -= dt;
  if (focusTimer <= 0 && host && ready) {
    focusTimer = 0.5;
    send({ t: 'focus', x: cam.target.x, z: cam.target.z, dist: cam.dist, dayPhase: daylight.day.phase, season: daylight.day.season });
  }

  // The full tray arrives once the first land has cooled (or soon after, if lava keeps flowing).
  if (firstLand && !trayFull && !swapping && !previewNoLand) {
    landTime += dt;
    if ((lavaArea < 30 && !stroking && landTime > 1.5) || landTime > 25) setTrayFull(true);
  }
  if (started && ready && firstLand && !enginePaused && !swapping) {
    yearsRunning += dt;
    if (yearsRunning >= 60) {
      yearsRunning = 0;
      void autosave();
    }
  }
  vibrate(dt);

  // While a load or a new sea replaces the world, the first-minute lines hold still (the land
  // and tray they would read belong to the sea that is leaving).
  onboardingState.started = started && !swapping;
  onboardingState.firstLand = firstLand && !previewNoLand;
  onboardingState.trayFull = trayFull && !previewNoLand;
  onboardingState.cameraMoved = cam.userMoves > 0;
  ui.setCamera(cam.target.x, cam.target.z, cam.yaw);
  ui.update(dt, onboardingState);

  f.t = time;
  f.dt = dt;
  f.day = daylight.day;
  f.year = year;
  f.firstLand = firstLand;
  f.storm = storm;
  f.life = life;
  f.tool = tool;
  f.stroking = stroking;
  f.watching = watching || photoPending;
  f.brush = photoPending ? null : brush;
  for (const s of systems) s.update(f);
  fields.flush();
  renderer.render(scene, camera);
  if (photoPending) {
    photoPending = false;
    savePhoto();
  }

  // Sharpness and detail follow smoothness (only while playing in the open view). A new
  // sharpness waits for the start of the next drawn frame, so the canvas is never left cleared.
  if (started && !qualityHeld && !ui.journalOpen && document.visibilityState === 'visible') {
    const target = pacer.cap > 0 ? pacer.cap : 1 / 60;
    const change = governor.frame(pacer.interval, target);
    if (change === 'softer' || change === 'sharper') resizeWanted = true;
    else if (change === 'lighter' || change === 'richer') applyTier();
  }
}

requestAnimationFrame(frame);
void boot();

// ---------- hooks for the automated browser checks ----------

/** A quick fingerprint of the visible heights (did anything get edited?). */
function heightHash(): number {
  let h = 2166136261;
  const v = new Uint32Array(fields.surf.buffer);
  for (let i = 0; i < v.length; i += 7) h = Math.imul(h ^ v[i], 16777619);
  return h >>> 0;
}

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
  get tool() {
    return tool;
  },
  get size() {
    return size;
  },
  get watching() {
    return watching;
  },
  get trayFull() {
    return trayFull;
  },
  get firstLand() {
    return firstLand;
  },
  get glow() {
    return glow;
  },
  get lavaArea() {
    return lavaArea;
  },
  get paused() {
    return enginePaused;
  },
  get journalOpen() {
    return ui.journalOpen;
  },
  get journalEntries() {
    return ui.journalEntries;
  },
  camera: cam,
  fields,
  renderer,
  scene,
  /** Choose a tool; any tool works on any sea (the full tray comes out if it hadn't yet). */
  selectTool: (t: ToolId) => selectTool(t, false, true),
  send: (m: ToEngine) => send(m),
  /** The last message of a kind the page sent to the engine (e.g. 'settings', 'pause'). */
  lastSent: (t: ToEngine['t']) => lastSent.get(t) ?? null,
  /** Screen position (CSS px) of a world point. */
  project: (x: number, y: number, z: number) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return { x: ((v.x + 1) / 2) * viewW, y: ((1 - v.y) / 2) * viewH };
  },
  /**
   * The last frame's triangles and draw calls (both passes together, and the main and shadow
   * passes on their own), the current sharpness and detail tier, and whether things cast shadows.
   */
  stats: () => {
    const r = renderer.info.render;
    return {
      triangles: r.triangles,
      calls: r.calls,
      mainTriangles: r.triangles - shadowPass.frameTriangles,
      mainCalls: r.calls - shadowPass.frameCalls,
      shadowTriangles: shadowPass.latestTriangles,
      shadowCalls: shadowPass.latestCalls,
      programs: renderer.info.programs?.length ?? 0,
      pixelRatio: renderer.getPixelRatio(),
      setting: quality.setting,
      tier: quality.tier,
      shadows: quality.shadows,
      held: qualityHeld,
      frames,
    };
  },
  /**
   * Hold the graphics at the setting's own detail tier, with no automatic steps down (or let
   * them run again). The browser checks measure budgets this way: software drawing is so slow
   * that the governor would otherwise fall to the lightest tier and test that instead.
   */
  holdQuality: (on: boolean) => {
    qualityHeld = on;
    applyQuality();
    return { tier: quality.tier, shadows: quality.shadows };
  },
  debug,
  start: () => startPlaying(),
  /** Leave watch mode and reset the idle clock (scripts call this before acting). */
  wake: () => wake(),
  /** Pretend a minute has passed without input: watch mode starts on the next frame. */
  goIdle: () => (idle = 61),
  /** Scripted pour through the engine (no gestures): tool at x, z with a radius, for `seconds` of physics. */
  pour: (t: ToolId, x: number, z: number, radius = 12, seconds = 3) => debugOp('pour', { tool: t, x, z, radius, seconds }),
  advanceYears: (n: number) => debugOp('advanceYears', { arg: n }),
  stormNow: () => debugOp('stormNow'),
  openJournal: (tab?: 'story' | 'guide' | 'chart') => ui.openJournal(tab),
  closeJournal: () => ui.closeJournal(),
  openMenu: (page?: Parameters<typeof ui.sheets.open>[0]) => ui.sheets.open(page ?? 'menu'),
  closeMenu: () => ui.sheets.close(),
  runChecks: () => runChecks(),
  heightHash,
  /** Set the sky clock (0..1 through the day, 0 = dawn), for screenshots. */
  setDayPhase: (p: number) => daylight.setPhase(p, daylight.day.day),
  /** Show the first minute ("Touch the glow.") over the current sea until the next input, for screenshots. */
  previewFirstMinute: () => {
    if (!previewNoLand) stepsBeforePreview = { ...ui.onboarding.sea };
    previewNoLand = true;
    ui.setSea({ island: false, keep: false }, ui.directHints);
    ui.setTrayFull(false);
    frameGlow(1.5);
  },
};
