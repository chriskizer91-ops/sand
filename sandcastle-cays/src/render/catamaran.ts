/**
 * Your home, version two: a 45 ft (13.7 m) cruising catamaran you can walk around
 * inside, built entirely in code in the same storybook style as the sloop
 * (white hulls, teal stripes, teak decks, blue sail covers, rounded edges).
 *
 * BOAT-LOCAL AXES (metres) — the same as the sloop's
 *   +x toward the bows, +y up (y = 0 is the waterline), +z to starboard.
 *   Origin: on the centreline between the hulls, halfway along, at the waterline.
 *
 * LEVELS (y, where the feet go)
 *   hull cabins -0.50 (ceiling 1.42) · swim platforms 0.35 · stern steps 0.6 / 0.9 / 1.2
 *   cockpit, saloon floor, side decks 1.50 (saloon ceiling 3.58) · trampoline ~1.43
 *   cockpit benches 1.93 · pot shelf 1.85 · flybridge (saloon roof) 3.66
 *   Hull stairs: seven steps of 0.29 m, from the saloon's sides down into each hull.
 *   Flybridge stairs: seven steps of 0.31 m, up from the cockpit's port side.
 *
 * LAYOUT
 *   Hulls centred at z = ±2.75, 2 m wide at deck. Bridgedeck from x -5.2 (aft crossbeam)
 *   to 4.3, 0.8 m above the water. Cockpit x -5.2..-1.4; saloon x -1.4..3.55 with a big
 *   sliding door aft; galley along the port side, dinette in the middle, chart table
 *   forward to starboard. Port hull: stairs, a little head (toilet and basin), the owner's
 *   V-berth forward. Starboard hull: stairs, the workshop (workbench, vise, tools), a second
 *   V-berth. Flybridge over the saloon's aft part with the wheel, compass, helm seat and
 *   engine levers. Trampoline between the bows, windlass on the front deck, mast on the roof.
 *
 * The deck description (CatDeck) answers every question at your own level (y).
 * Everything is merged by material: 19 draw calls. Glass, glows, water, netting and the
 * water mask cast no shadows even when castShadow is set (they carry a see-through depth
 * material). The hull cabins' floors are below the waterline: 'cat-water-mask' is an invisible
 * depth-only lid at the waterline inside each hull, drawn after the boat (renderOrder 1), so a
 * sea drawn after it (renderOrder 2 or later, or a transparent sea) never shows inside.
 */
import * as THREE from 'three';
import {
  DynPart,
  M,
  PAINTED,
  PLANK,
  Part,
  TEX_U,
  TEX_V,
  WHITE,
  between,
  clamp,
  curve,
  finishTexture,
  flap,
  foilLoft,
  mulberry32,
  paintNonSkid,
  paintSail,
  paintTeak,
  paintVarnish,
  pchip,
  periodicNoise,
  rgb,
  rod,
  roundedBox,
  smooth01,
  sweep,
  tube,
  V,
  type RGB,
} from './boatKit';

// ============================================================ public types

export interface CatPoints {
  /** On the starboard swim platform at the top of the swim ladder. */
  ladderTop: THREE.Vector3;
  /** Bottom rung of the swim ladder, in the water about 0.5 m down. */
  ladderBottom: THREE.Vector3;
  /** The cockpit locker: the lid of the aft cockpit bench seat (port side). */
  locker: THREE.Vector3;
  /** Where you stand to steer: on the flybridge behind the wheel. */
  helm: THREE.Vector3;
  /** The anchor roller on the forward crossbeam, where the chain leaves the boat. */
  bow: THREE.Vector3;
  /** Foot of the mast, on the saloon roof. */
  mastBase: THREE.Vector3;
  /** Four spots for 28 cm pots on the teak planter shelf in front of the saloon windscreen. */
  potShelf: THREE.Vector3[];
  /** Where the player starts: in the cockpit facing forward (+x), toward the saloon door. */
  spawn: THREE.Vector3;
  /** Where you stand to cook: in the saloon, facing the galley counter along the port side. */
  galley: THREE.Vector3;
  /** Where you stand at the workbench: in the starboard hull's workshop. */
  workbench: THREE.Vector3;
  /** Where you stand to work the bilge pump: in the cockpit by the saloon's aft wall, starboard of the door. */
  pump: THREE.Vector3;
  /** Where you stand at the chart table: in the saloon, forward on the starboard side. */
  chart: THREE.Vector3;
  /** Where you stand beside the owner's double bunk to sleep: in the port hull's forward cabin. */
  bunk: THREE.Vector3;
}

/** Where a person can walk aboard, at several levels: y is the height of their feet. */
export interface CatDeck {
  /** Standing height at boat-local (lx, lz) for feet at y: the highest walkable surface no higher than y + 0.45 (so you climb stairs but never pop up through a ceiling), or null if there's nothing to stand on (over the side, or open water between the hulls). With no y: the highest surface there. */
  heightAt(lx: number, lz: number, y?: number): number | null;
  /** True if a person of radius r with feet at y (default: main-deck level) would hit a wall or solid fitting anywhere from y + 0.1 to y + 1.8. */
  blocked(lx: number, lz: number, r: number, y?: number): boolean;
  /** Inside the guard rails or walls at that level (default y: main-deck level; false = over the side). The swim steps are open at their aft and inboard edges. */
  insideLifelines(lx: number, lz: number, y?: number): boolean;
  /** For swimmers: how far (lx, lz) is inside the boat's waterline footprint (both hulls and the water under the bridgedeck) plus 0.3 m; 0 when clear. */
  footprintPen(lx: number, lz: number): number;
  /** Overall half-width at lx (deck level or waterline); 0 beyond the ends. */
  halfBeam(lx: number, atDeck: boolean): number;
  /** Ceiling height above feet at y, or null in the open air. */
  ceilingAt(lx: number, lz: number, y: number): number | null;
}

export interface CatRig {
  /** 0 = main furled in its stack pack and jib rolled up; 1 = main hoisted, jib unrolled. */
  setSail(amount: number): void;
  /** Boom angle (radians) about the gooseneck: + swings it out to starboard. Stops at about ±1.2. */
  setBoom(angle: number): void;
  /** Jib sheeted to a side: radians of its foot from the centreline, -1.1 (port) .. 1.1 (starboard). */
  setJib(angle: number): void;
  /** 1 = sails full and drawing; 0 = luffing (flat, rippling below 0.6). Pass the time in seconds. */
  setFill(fill: number, time: number): void;
  /** Rudder angle (radians, -0.6..0.6), both rudders; + = trailing edges to starboard (bows turn to starboard). The wheel turns with them. */
  setRudder(angle: number): void;
  /** Anchor down: the chain runs from the bow roller into the water. Up: anchor stowed on the roller. */
  setAnchored(down: boolean): void;
  /** Throttle -1 (astern) .. 1 (ahead): both saildrive propellers spin (direction by sign), the engine levers move, and the exhausts burble at the sterns. Call every frame with the time. */
  setMotor(throttle: number, time: number): void;
  /** Night 0..1. 'anchor' = white masthead light; 'underway' = red/green sidelights at the bows and white sternlights. */
  setLights(mode: 'anchor' | 'underway', night: number): void;
  /** The saloon's big sliding door: 0 closed .. 1 open (default 1). blocked() stops you at the doorway while it's under half open. */
  setHatch(open: number): void;
  /** Warm lamps in the saloon, galley, chart table and hull cabins. */
  setGalleyLight(on: boolean): void;
  /** Bilge-pump handle, 0..1 (on the cockpit side of the saloon's aft wall). */
  setPump(stroke: number): void;
  /** Water in the bilge 0..1: above 0.6 water slops about on the hull cabin floors. */
  setBilge(level: number, time?: number): void;
  /** Rain catching: shown 0..1 = water trickling along the roof gutters and down to the tank fillers; big = the canvas catcher over the cockpit as well. */
  setAwning(shown: number, big: boolean): void;
  /** The fish trap hanging off the starboard stern quarter, about 1 m down. */
  setTrap(set: boolean): void;
  /** The fishing rod in its holder on the port stern rail. */
  setRodStowed(shown: boolean): void;
  status(): CatRigStatus;
}

export interface CatRigStatus {
  sail: number;
  boom: number;
  jib: number;
  fill: number;
  rudder: number;
  anchored: boolean;
  coverShown: boolean;
  mainShown: boolean;
  jibShown: boolean;
  rodeShown: boolean;
  anchorStowedShown: boolean;
  boomEnd: THREE.Vector3;
  mainHead: THREE.Vector3;
  jibClew: THREE.Vector3;
  /** Trailing edges of the port and starboard rudders (boat-local). */
  rudderTrailingEdges: [THREE.Vector3, THREE.Vector3];
  /** The starboard rudder's trailing edge (as the sloop's single rudder). */
  rudderTrailingEdge: THREE.Vector3;
  /** Wheel rotation (radians, + = clockwise seen from the helm). */
  wheelAngle: number;
  throttle: number;
  /** Saildrive propeller hubs, port and starboard (for bubbles). */
  propTips: [THREE.Vector3, THREE.Vector3];
  /** The starboard propeller hub (as the sloop's single prop). */
  propTip: THREE.Vector3;
  propAngle: number;
  lights: { mode: 'anchor' | 'underway'; night: number; anchorOn: boolean; sidelightsOn: boolean; sternOn: boolean; interiorOn: boolean };
  hatchOpen: number;
  galleyLight: boolean;
  pumpStroke: number;
  bilge: number;
  awning: { shown: number; big: boolean; clothBox: THREE.Box3 | null };
  trapSet: boolean;
  rodStowed: boolean;
}

/** Boxes (boat-local) around the fixed fittings, for prompts and placing things. */
export interface CatFittings {
  workbench: THREE.Box3;
  pump: THREE.Box3;
  rodHolder: THREE.Box3;
  fillers: THREE.Box3[];
  galley: THREE.Box3;
  chartTable: THREE.Box3;
  bunk: THREE.Box3;
  helm: THREE.Box3;
  potShelf: THREE.Box3;
  locker: THREE.Box3;
}

export interface Catamaran {
  group: THREE.Group;
  deck: CatDeck;
  points: CatPoints;
  rig: CatRig;
  length: number;
  beam: number;
  draft: number;
  triangles: number;
  fittings: CatFittings;
}

// ============================================================ layout

const X_ST = -6.85; // transoms
const X_BW = 6.85; // bow tips
const LOA = X_BW - X_ST;
const HZ = 2.75; // hull centres at z = ±HZ
const DECK_Y = 1.5; // cockpit, saloon floor, side decks
const UNDER_Y = 0.8; // bridgedeck underside
const X_AFTBEAM = -5.2; // aft end of the bridgedeck; the stern steps start here
const X_FWDDECK = 4.3; // forward edge of the bridgedeck; the trampoline starts here
const X_XBEAM = 6.25; // forward crossbeam
const DRAFT = 1.3;
const SAL_X0 = -1.4; // saloon outside
const SAL_X1 = 3.55;
const SAL_Z = 3.05;
const SAL_TOPX = 3.32; // where the raked windscreen meets the roof
const SILL_Y = 2.35; // window sills
const WIN_Y = 3.25; // window heads
const ROOF_Y0 = 3.58; // saloon ceiling
const ROOF_Y = 3.66; // roof top = flybridge floor
const ROOF_X0 = -2.4; // the roof overhangs the cockpit to here
const ROOF_X1 = 3.42;
const ROOF_Z = 3.12;
const FLY_X0 = -2.4;
const FLY_X1 = 1.2;
const FLY_Z = 2.6;
const DOOR_Z = 1.0;
const HST_X0 = -0.8; // hull stairs (both hulls): top at x -0.8, foot at 1.25
const HST_X1 = 1.25;
const HST_Z0 = 2.27;
const HST_Z1 = 2.95;
const HST_N = 7;
const HFLOOR_Y = -0.5;
const HCEIL_Y = 1.42;
const HROOM_X1 = 3.35; // the cabin floor ends at the V-berths
const HLIN_X0 = -0.85; // hull interior lining, aft and forward bulkheads
const HLIN_X1 = 5.05;
const LINING = 0.06;
const FST_X0 = -4.1; // flybridge stairs (cockpit, port side)
const FST_X1 = -2.4;
const FST_Z0 = -2.55;
const FST_Z1 = -2.0;
const FST_N = 7;
const BENCH_Y = 1.93;
const ABENCH_X0 = -5.15; // aft cockpit bench (locker)
const ABENCH_X1 = -4.68;
const ABENCH_Z = 1.72;
const SBENCH_X0 = -4.55; // starboard cockpit bench
const SBENCH_X1 = -2.75;
const SBENCH_Z0 = 1.25;
const SBENCH_Z1 = 1.68;
const SHELF_X0 = 3.6; // planter shelf in front of the windscreen
const SHELF_X1 = 3.96;
const SHELF_Z0 = 0.45;
const SHELF_Z1 = 1.75;
const SHELF_Y = 1.85;
const STEPS: { x0: number; x1: number; y: number }[] = [
  { x0: -5.6, x1: -5.2, y: 1.2 },
  { x0: -6.0, x1: -5.6, y: 0.9 },
  { x0: -6.4, x1: -6.0, y: 0.6 },
  { x0: -6.85, x1: -6.4, y: 0.35 },
];
const MAST_X = 3.05;
const MAST_TOP = 23.3;
const WHEEL_C = V(0.66, 4.62, 1.1); // wheel hub
const WHEEL_R = 0.48;
const PUMP_C = V(SAL_X0 - 0.04, 2.0, 1.55);
const LADDER_X = X_ST - 0.12;

// ============================================================ the hull shape

/** Deck height along a hull (flat to the bridgedeck's front, then a gentle rise to the bows). */
function deckH(x: number): number {
  return x > X_FWDDECK ? DECK_Y + 0.28 * ((Math.min(x, X_BW) - X_FWDDECK) / (X_BW - X_FWDDECK)) ** 2 : DECK_Y;
}
/** Top edge of a hull's side: the deck, sloping down over the stern steps. */
function yTop(x: number): number {
  return x >= X_AFTBEAM ? deckH(x) : 0.36 + (DECK_Y - 0.36) * ((x - X_ST) / (X_AFTBEAM - X_ST));
}
/** A hull's half-width at deck level. */
function hd(x: number): number {
  if (x < X_ST || x > X_BW) return 0;
  if (x <= X_AFTBEAM) return 0.94 + (0.06 * (x - X_ST)) / (X_AFTBEAM - X_ST);
  if (x <= 3.0) return 1.0;
  return 1 - Math.pow((x - 3.0) / (X_BW - 3.0), 2.2);
}
const keelY = pchip(
  [-6.85, -6.0, -5.0, -3.5, -1.5, 1.0, 3.0, 4.0, 5.0, 5.8, 6.4, 6.72, 6.82, 6.85],
  [-0.06, -0.3, -0.52, -0.7, -0.78, -0.78, -0.74, -0.68, -0.56, -0.41, -0.26, -0.06, 0.3, 1.78],
);

interface Section {
  yd: number;
  yk: number;
  b: number;
  point(u: number): [number, number];
}
/** Hull cross-section at x: a cubic from the deck edge (u = 0) down to the keel line (u = 1); w = distance from the hull's centre plane. */
function sectionAt(x: number): Section {
  const t = (x - X_ST) / LOA;
  const fwd = smooth01((t - 0.6) / 0.4);
  const aft = smooth01((0.45 - t) / 0.45);
  const yd = yTop(x);
  const yk = Math.min(keelY(x), yd);
  const b = hd(x);
  const H = Math.max(1e-5, yd - yk);
  const k1 = 0.93 - 0.2 * fwd;
  const a1 = 0.6 - 0.1 * fwd;
  const c2 = 0.84 + 0.06 * aft - 0.45 * fwd;
  const dr = 0.14 - 0.06 * aft + 0.65 * fwd;
  const p1z = b * k1;
  const p1y = yd - a1 * H;
  const p2z = b * c2;
  const p2y = Math.min(p1y, yk + dr * c2 * b);
  return {
    yd,
    yk,
    b,
    point(u: number): [number, number] {
      const v = 1 - u;
      const w0 = v * v * v;
      const w1 = 3 * v * v * u;
      const w2 = 3 * v * u * u;
      const w3 = u * u * u;
      return [w0 * b + w1 * p1z + w2 * p2z, w0 * yd + w1 * p1y + w2 * p2y + w3 * yk];
    },
  };
}
/** Half-width of a hull at x and height y (0 below its bottom). */
function hullHalfAt(x: number, y: number): number {
  if (x < X_ST || x > X_BW) return 0;
  const s = sectionAt(x);
  if (y >= s.yd) return s.b;
  if (y <= s.yk) return 0;
  let a = 0;
  let b = 1;
  for (let k = 0; k < 28; k++) {
    const m = (a + b) / 2;
    if (s.point(m)[1] > y) a = m;
    else b = m;
  }
  return s.point((a + b) / 2)[0];
}
/** Waterline half-widths are asked for every frame (water, swimmers): tabulate them. */
const WL_TABLE = (() => {
  const n = 275;
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = hullHalfAt(X_ST + (LOA * i) / n, 0);
  return t;
})();
function wlHalf(x: number): number {
  if (x < X_ST || x > X_BW) return 0;
  const f = ((x - X_ST) / LOA) * (WL_TABLE.length - 1);
  const i = Math.min(WL_TABLE.length - 2, Math.floor(f));
  return WL_TABLE[i] + (WL_TABLE[i + 1] - WL_TABLE[i]) * (f - i);
}
/** Half-width of a hull cabin's floor (inside the lining). */
const FLOOR_TABLE = (() => {
  const n = 60;
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = Math.max(0, hullHalfAt(HLIN_X0 + ((HLIN_X1 - HLIN_X0) * i) / n, HFLOOR_Y) - LINING);
  return t;
})();
function floorHalf(x: number): number {
  if (x < HLIN_X0 || x > HLIN_X1) return 0;
  const f = ((x - HLIN_X0) / (HLIN_X1 - HLIN_X0)) * (FLOOR_TABLE.length - 1);
  const i = Math.min(FLOOR_TABLE.length - 2, Math.floor(f));
  return FLOOR_TABLE[i] + (FLOOR_TABLE[i + 1] - FLOOR_TABLE[i]) * (f - i);
}

// ============================================================ the walkable boat (multi-level)

const HST_RISE = (DECK_Y - HFLOOR_Y) / HST_N;
const HST_RUN = (HST_X1 - HST_X0) / HST_N;
const FST_RISE = (ROOF_Y - DECK_Y) / FST_N;
const FST_RUN = (FST_X1 - FST_X0) / (FST_N - 1);
const STEP_UP = 0.45;

/** Is (x, z) on the main deck level's footprint (bridgedeck, cockpit, saloon floor, side decks, foredecks)? */
function onMainFootprint(x: number, z: number): boolean {
  if (x < X_AFTBEAM || x > X_BW) return false;
  const az = Math.abs(z);
  const h = hd(x);
  if (x <= X_FWDDECK) return az <= HZ + h - 0.02;
  return Math.abs(az - HZ) <= h - 0.02;
}
function inHullStair(x: number, z: number): boolean {
  const az = Math.abs(z);
  return x >= HST_X0 && x <= HST_X1 && az >= HST_Z0 && az <= HST_Z1;
}
function inFlyStair(x: number, z: number): boolean {
  return x >= FST_X0 && x <= FST_X1 && z >= FST_Z0 && z <= FST_Z1;
}
function inTrampoline(x: number, z: number): boolean {
  return x >= X_FWDDECK && x <= X_XBEAM && Math.abs(z) <= HZ - hd(x) + 0.02;
}
function stepHalf(x: number, y: number): number {
  return Math.max(0, hullHalfAt(x, y) - 0.04);
}
function inSternSteps(x: number, z: number): { y: number } | null {
  if (x < X_ST || x >= X_AFTBEAM) return null;
  const s = STEPS.find((st) => x >= st.x0 && x < st.x1);
  if (!s) return null;
  if (Math.abs(Math.abs(z) - HZ) > stepHalf((s.x0 + s.x1) / 2, s.y)) return null;
  return { y: s.y };
}
function inHullRoom(x: number, z: number): boolean {
  const az = Math.abs(z);
  if (x >= HST_X0 && x < HST_X1) return az >= HST_Z0 && az <= HST_Z1;
  if (x >= HST_X1 && x <= HROOM_X1) return Math.abs(az - HZ) <= floorHalf(x);
  return false;
}
function trampolineY(x: number, z: number): number {
  const az = Math.abs(z);
  if (az < 0.11) return DECK_Y; // the centre beam
  const w = HZ - hd(x);
  const u = clamp((x - X_FWDDECK) / (X_XBEAM - X_FWDDECK), 0, 1);
  const v = clamp((az - 0.11) / Math.max(0.1, w - 0.11), 0, 1);
  return 1.45 - 0.05 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
}

interface Surface {
  name: string;
  /** Height here, or null if this surface isn't at (x, z). */
  at(x: number, z: number): number | null;
  /** Rails (or walls) around this surface: false = over the side. */
  inside(x: number, z: number): boolean;
}

function mainInside(x: number, z: number): boolean {
  if (x < X_ST || x > 6.72) return false;
  const az = Math.abs(z);
  if (x < X_AFTBEAM) return inSternSteps(x, z) !== null;
  if (x > X_XBEAM) return Math.abs(az - HZ) < hd(x) - 0.05;
  return az < HZ + hd(x) - 0.1;
}
function flyInside(x: number, z: number): boolean {
  return x >= FLY_X0 - 0.02 && x <= FLY_X1 - 0.03 && Math.abs(z) <= FLY_Z - 0.03;
}

const SURFACES: Surface[] = [
  {
    name: 'main deck',
    at: (x, z) => (onMainFootprint(x, z) && !inHullStair(x, z) && !inFlyStair(x, z) && !inTrampoline(x, z) ? deckH(x) : null),
    inside: mainInside,
  },
  { name: 'trampoline', at: (x, z) => (inTrampoline(x, z) ? trampolineY(x, z) : null), inside: mainInside },
  {
    name: 'hull stairs',
    at: (x, z) => {
      if (!inHullStair(x, z)) return null;
      const i = Math.min(HST_N - 1, Math.floor((x - HST_X0) / HST_RUN));
      return DECK_Y - (i + 1) * HST_RISE;
    },
    inside: () => true,
  },
  { name: 'hull cabin floor', at: (x, z) => (x >= HST_X1 && x <= HROOM_X1 && inHullRoom(x, z) ? HFLOOR_Y : null), inside: () => true },
  {
    name: 'flybridge stairs',
    at: (x, z) => {
      if (!inFlyStair(x, z)) return null;
      const i = Math.min(FST_N - 2, Math.floor((x - FST_X0) / FST_RUN));
      return DECK_Y + (i + 1) * FST_RISE;
    },
    inside: mainInside,
  },
  {
    name: 'roof',
    at: (x, z) => (x >= ROOF_X0 && x <= ROOF_X1 - 0.05 && Math.abs(z) <= ROOF_Z - 0.05 ? ROOF_Y : null),
    inside: flyInside,
  },
  {
    name: 'cockpit benches',
    at: (x, z) => {
      if (x >= ABENCH_X0 && x <= ABENCH_X1 && Math.abs(z) <= ABENCH_Z) return BENCH_Y;
      if (x >= SBENCH_X0 && x <= SBENCH_X1 && z >= SBENCH_Z0 && z <= SBENCH_Z1) return BENCH_Y;
      return null;
    },
    inside: mainInside,
  },
  {
    name: 'planter shelf',
    at: (x, z) => (x >= SHELF_X0 && x <= SHELF_X1 && Math.abs(z) >= SHELF_Z0 && Math.abs(z) <= SHELF_Z1 ? SHELF_Y : null),
    inside: mainInside,
  },
  { name: 'stern steps', at: (x, z) => inSternSteps(x, z)?.y ?? null, inside: mainInside },
];

/** The surface you'd stand on at (x, z) with feet at y (the highest one within a step), or the highest of all. */
function surfaceAt(x: number, z: number, y?: number): { s: Surface; h: number } | null {
  let best: { s: Surface; h: number } | null = null;
  for (const s of SURFACES) {
    const h = s.at(x, z);
    if (h === null) continue;
    if (y !== undefined && h > y + STEP_UP) continue;
    if (!best || h > best.h) best = { s, h };
  }
  return best;
}

/** Solid things you bump into, each over a band of heights. */
type Shape = { kind: 'box'; x0: number; x1: number; z0: number; z1: number } | { kind: 'seg'; ax: number; az: number; bx: number; bz: number; t: number } | { kind: 'circle'; x: number; z: number; r: number };
interface Obstacle {
  shape: Shape;
  y0: number;
  y1: number;
  /** Only while this returns true (the saloon door). */
  when?: () => boolean;
}

function hitShape(s: Shape, x: number, z: number, r: number): boolean {
  if (s.kind === 'box') {
    const dx = Math.max(s.x0 - x, 0, x - s.x1);
    const dz = Math.max(s.z0 - z, 0, z - s.z1);
    return dx * dx + dz * dz < r * r;
  }
  if (s.kind === 'circle') return Math.hypot(x - s.x, z - s.z) < r + s.r;
  const vx = s.bx - s.ax;
  const vz = s.bz - s.az;
  const t = clamp(((x - s.ax) * vx + (z - s.az) * vz) / (vx * vx + vz * vz || 1), 0, 1);
  return Math.hypot(x - s.ax - t * vx, z - s.az - t * vz) < r + s.t;
}

const doorState = { open: 1 };
const box = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): Obstacle => ({ shape: { kind: 'box', x0, x1, z0, z1 }, y0, y1 });
const seg = (ax: number, az: number, bx: number, bz: number, y0: number, y1: number, t = 0.04): Obstacle => ({ shape: { kind: 'seg', ax, az, bx, bz, t }, y0, y1 });

const OBSTACLES: Obstacle[] = (() => {
  const o: Obstacle[] = [];
  const S0 = DECK_Y;
  const S1 = ROOF_Y0;
  // saloon walls (outside faces at SAL_X0, ±SAL_Z; the raked front stops heads at SAL_TOPX)
  for (const k of [-1, 1]) {
    o.push(seg(SAL_X0, k * DOOR_Z, SAL_X0, k * SAL_Z, S0, S1));
    o.push(seg(SAL_X0, k * SAL_Z, SAL_X1, k * SAL_Z, S0, S1));
  }
  o.push(box(SAL_TOPX - 0.06, SAL_X1 + 0.04, -SAL_Z, SAL_Z, S0, S1));
  o.push({ ...seg(SAL_X0, -DOOR_Z, SAL_X0, DOOR_Z, S0, S1), when: () => doorState.open < 0.5 });
  // galley, dinette, chart table
  o.push(box(1.55, 3.2, -SAL_Z, -2.37, S0, S0 + 1.0));
  o.push(box(1.6, 2.5, -0.5, 0.5, S0, S0 + 0.78));
  o.push(box(2.6, 3.1, -1.05, 1.05, S0, S0 + 0.95));
  for (const k of [-1, 1]) o.push(box(1.45, 3.1, k < 0 ? -1.05 : 0.62, k < 0 ? -0.62 : 1.05, S0, S0 + 0.5));
  o.push(box(2.72, 3.25, 1.6, SAL_Z, S0, S0 + 0.8));
  // guard rails round the hull stairwells (saloon level only)
  for (const k of [-1, 1]) {
    o.push(seg(-0.55, k * HST_Z0, HST_X1, k * HST_Z0, S0, S0 + 0.95, 0.03));
    o.push(seg(HST_X1, k * HST_Z0, HST_X1, k * SAL_Z, S0, S0 + 0.95, 0.03));
  }
  // cockpit table, windlass, mast
  o.push(box(-3.9, -2.9, -0.55, 0.55, S0, S0 + 0.75));
  o.push({ shape: { kind: 'circle', x: 4.1, z: 0, r: 0.17 }, y0: S0, y1: S0 + 0.32 });
  o.push({ shape: { kind: 'circle', x: MAST_X, z: 0, r: 0.13 }, y0: ROOF_Y, y1: MAST_TOP });
  // flybridge: rails all round (gap at the stair top), the wheel and binnacle, helm seat, engine levers
  const F0 = ROOF_Y;
  const F1 = ROOF_Y + 0.9;
  o.push(seg(FLY_X0, -FLY_Z, FLY_X1, -FLY_Z, F0, F1, 0.03));
  o.push(seg(FLY_X1, -FLY_Z, FLY_X1, FLY_Z, F0, F1, 0.03));
  o.push(seg(FLY_X1, FLY_Z, FLY_X0, FLY_Z, F0, F1, 0.03));
  o.push(seg(FLY_X0, FLY_Z, FLY_X0, FST_Z1 + 0.03, F0, F1, 0.03));
  o.push(box(WHEEL_C.x - 0.16, WHEEL_C.x + 0.3, WHEEL_C.z - WHEEL_R - 0.04, WHEEL_C.z + WHEEL_R + 0.04, F0, F0 + 1.5));
  o.push(box(-0.62, -0.22, 0.58, 1.62, F0, F0 + 0.95));
  o.push(box(0.6, 0.86, 1.62, 1.92, F0, F0 + 0.95));
  // hull cabins: the head, the workbench, the V-berths
  const H0 = HFLOOR_Y;
  const H1 = HCEIL_Y;
  o.push(box(1.45, 2.25, -HZ - 1, -2.95, H0, H1));
  o.push(box(1.45, 2.75, 2.95, HZ + 1, H0, H1));
  for (const k of [-1, 1]) o.push(box(HROOM_X1, HLIN_X1, k * HZ - 1, k * HZ + 1, H0, H0 + 0.82));
  return o;
})();

function heightAt(x: number, z: number, y?: number): number | null {
  return surfaceAt(x, z, y)?.h ?? null;
}

/** In a hull cabin (or on its stairs below the saloon floor), the hull's lining is a wall all round. */
function hullWallHit(x: number, z: number, r: number): boolean {
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (!inHullRoom(x + r * Math.cos(a), z + r * Math.sin(a))) return true;
  }
  return false;
}

function blocked(x: number, z: number, r: number, y?: number): boolean {
  const feet = y ?? heightAt(x, z, DECK_Y) ?? DECK_Y;
  const lo = feet + 0.1;
  const hi = feet + 1.8;
  for (const ob of OBSTACLES) {
    if (ob.y1 < lo || ob.y0 > hi) continue;
    if (ob.when && !ob.when()) continue;
    if (hitShape(ob.shape, x, z, r)) return true;
  }
  // below the saloon floor you're inside a hull: its sides are walls
  if (feet < DECK_Y - 0.6 && inHullRoom(x, z) && hullWallHit(x, z, r)) return true;
  return false;
}

function insideLifelines(x: number, z: number, y: number = DECK_Y): boolean {
  const s = surfaceAt(x, z, y);
  if (s) return s.s.inside(x, z);
  const feet = y ?? DECK_Y;
  if (feet < DECK_Y - 0.6 && inHullRoom(x, z)) return true;
  return feet > ROOF_Y - 0.6 ? flyInside(x, z) : mainInside(x, z);
}

function footprintPen(x: number, z: number): number {
  const ROOM = 0.3;
  let pen = 0;
  for (const k of [-1, 1]) {
    const w = wlHalf(clamp(x, X_ST + 0.01, X_BW - 0.01));
    if (w <= 0 && (x < X_ST - ROOM || x > X_BW + ROOM)) continue;
    const side = w + ROOM - Math.abs(z - k * HZ);
    const ends = Math.min(x - (X_ST - ROOM), X_BW + ROOM - x);
    pen = Math.max(pen, Math.min(side, ends));
  }
  // the water under the bridgedeck and trampoline, between the hulls
  const x0 = X_AFTBEAM - ROOM;
  const x1 = X_XBEAM + 0.15 + ROOM;
  if (x > x0 && x < x1 && Math.abs(z) < HZ) pen = Math.max(pen, Math.min(x - x0, x1 - x));
  return Math.max(0, pen);
}

function halfBeam(x: number, atDeck: boolean): number {
  if (x < X_ST || x > X_BW) return 0;
  const w = atDeck ? hd(x) : wlHalf(x);
  return w > 0 ? HZ + w : 0;
}

function ceilingAt(x: number, z: number, y: number): number | null {
  const az = Math.abs(z);
  if (y < DECK_Y - 0.6 && inHullRoom(x, z)) return inHullStair(x, z) ? ROOF_Y0 : HCEIL_Y;
  if (y < ROOF_Y - 0.3) {
    if (inHullStair(x, z)) return ROOF_Y0;
    if (x >= SAL_X0 && x <= SAL_X1 && az <= SAL_Z) return ROOF_Y0;
    if (x >= ROOF_X0 && x < SAL_X0 && az <= ROOF_Z) return ROOF_Y0;
  }
  return null;
}

/** The deck description, shared by every catamaran built (the saloon door's state comes from the last one's rig). */
const CAT_DECK: CatDeck = { heightAt, blocked, insideLifelines, footprintPen, halfBeam, ceilingAt };

// ============================================================ colours and small helpers

const COL = {
  hull: 0xfbf7ee,
  stripe: 0x1f8e8c,
  bottom: 0xa7443a,
  white: rgb(0xf8f5ee),
  cream: rgb(0xf1e9d8),
  creamDark: rgb(0xdccfb4),
  lining: rgb(0xf7e4bf),
  liningLow: rgb(0xe6cc9c),
  teal: rgb(0x2a9d9a),
  alu: rgb(0xd3d9dd),
  steel: rgb(0xe8ecef),
  dark: rgb(0x2a2e32),
  black: rgb(0x16181a),
  glass: rgb(0x1a2f3b),
  cover: rgb(0x2b6683),
  coverEdge: rgb(0x214f66),
  sail: rgb(0xf1ece0),
  sailShade: rgb(0xc9d3d8),
  uv: rgb(0x2f6a92),
  uvLight: rgb(0x7da1bb),
  rope: rgb(0xd6c39b),
  line: rgb(0xf2efe6),
  sheet: rgb(0xd9d2c2),
  chain: rgb(0x8d959a),
  galv: rgb(0x9ea6ab),
  cushion: rgb(0x2d6a8a),
  cushionLight: rgb(0xe9e1cc),
  mattress: rgb(0xf3ede0),
  pillow: rgb(0xfbf8f0),
  towel: rgb(0x7fc4c0),
  porcelain: rgb(0xf6f6f2),
  stove: rgb(0x24272a),
  jar: rgb(0xcfe3da),
  lid: rgb(0xc86a3c),
  kettle: rgb(0x2a9d9a),
  canvas: rgb(0xe2d3ad),
  canvasHem: rgb(0x2a8f8c),
  funnel: rgb(0xf0ede4),
  hose: rgb(0x8fc4c0),
  net: rgb(0x5f8c7c),
  rodBlank: [0.16, 0.24, 0.17] as RGB,
  reel: rgb(0xc9a24a),
  vise: rgb(0x3e5f7a),
  prop: rgb(0xb08d57),
  motorGrey: rgb(0xbfc3bf),
  flagA: rgb(0xef6a48),
  flagB: rgb(0xf7efd9),
  flagC: rgb(0x2fb5b0),
};

/** Vertex colour for the woodwork material: wood grain without the varnish amber, in this tint (blue + 2 is the flag). */
const grain = (hex: number): RGB => {
  const c = rgb(hex);
  return [c[0], c[1], c[2] + 2];
};
const DRIFTWOOD = grain(0xa79a86);
const CORK = grain(0xc99d6c);
const BRASS = grain(0xd8b46a);

/** Copies a Part's triangles into another, moved by m. */
function addPart(dst: Part, src: Part, m?: THREE.Matrix4): void {
  const base = dst.nv;
  const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (let i = 0; i < src.nv; i++) {
    a.set(src.pos[i * 3], src.pos[i * 3 + 1], src.pos[i * 3 + 2]);
    b.set(src.nrm[i * 3], src.nrm[i * 3 + 1], src.nrm[i * 3 + 2]);
    if (m) a.applyMatrix4(m);
    if (nm) b.applyMatrix3(nm).normalize();
    dst.v(a.x, a.y, a.z, b, src.uv[i * 2], src.uv[i * 2 + 1], [src.col[i * 3], src.col[i * 3 + 1], src.col[i * 3 + 2]]);
  }
  for (const i of src.idx) dst.idx.push(base + i);
}

/** An axis-aligned rounded box between two corners. */
function slab(p: Part, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: RGB = WHITE, r = 0.015, seg?: number): void {
  const sx = Math.abs(x1 - x0);
  const sy = Math.abs(y1 - y0);
  const sz = Math.abs(z1 - z0);
  p.add(roundedBox(sx, sy, sz, Math.min(r, sx / 2, sy / 2, sz / 2), seg), c, M((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
}

/** A flat quad a-b-c-d (any order around), facing along n, mapped to the uv rectangle. */
function quad(p: Part, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3, c0: RGB = WHITE, uv: [number, number, number, number] = [0, 0, 1, 1]): void {
  const [u0, v0, u1, v1] = uv;
  const ia = p.v(a.x, a.y, a.z, n, u0, v0, c0);
  const ib = p.v(b.x, b.y, b.z, n, u1, v0, c0);
  const ic = p.v(c.x, c.y, c.z, n, u1, v1, c0);
  const id = p.v(d.x, d.y, d.z, n, u0, v1, c0);
  p.tri(ia, ib, ic, n);
  p.tri(ia, ic, id, n);
}

/** Boat-local box of the vertices added to a Part since vertex v0. */
function partBox(p: Part, v0: number): THREE.Box3 {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = v0; i < p.nv; i++) b.expandByPoint(v.set(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]));
  return b;
}

/** Teak planks over (x, z) from x0 to x1, between zA(x) and zB(x), at height yFn(x, z). */
function deckStrip(p: Part, x0: number, x1: number, nx: number, zA: (x: number) => number, zB: (x: number) => number, nz: number, yFn: (x: number, z: number) => number): void {
  const rows: number[][] = [];
  for (let i = 0; i <= nx; i++) {
    const x = x0 + ((x1 - x0) * i) / nx;
    const za = zA(x);
    const zb = zB(x);
    const row: number[] = [];
    for (let j = 0; j <= nz; j++) {
      const z = za + ((zb - za) * j) / nz;
      const e = 0.01;
      const n = V(-(yFn(x + e, z) - yFn(x - e, z)) / (2 * e), 1, -(yFn(x, z + e) - yFn(x, z - e)) / (2 * e)).normalize();
      row.push(p.v(x, yFn(x, z), z, n, x / TEX_U, z / TEX_V));
    }
    rows.push(row);
  }
  for (let i = 0; i < nx; i++) p.stitch(rows[i], rows[i + 1], false, V(0, 1, 0));
}

// ============================================================ painted textures (DECISIONS 14)

/** Regions of the decal atlas, as [u0, v0, u1, v1]. */
const DEC = {
  chart: [0.004, 0.004, 0.496, 0.496] as [number, number, number, number],
  compass: [0.504, 0.004, 0.746, 0.246] as [number, number, number, number],
  quilt: [0.504, 0.254, 0.996, 0.496] as [number, number, number, number],
  rug: [0.004, 0.504, 0.496, 0.996] as [number, number, number, number],
  books: [0.504, 0.504, 0.996, 0.746] as [number, number, number, number],
  quilt2: [0.504, 0.754, 0.996, 0.996] as [number, number, number, number],
  towel: [0.754, 0.004, 0.996, 0.246] as [number, number, number, number],
};

/** The decal atlas: a sea chart, the compass card, two quilts, a rug, book spines and a striped towel. */
function paintDecals(): THREE.DataTexture {
  const S = 512;
  const data = new Uint8Array(S * S * 4);
  const rnd = mulberry32(2024);
  const noise = periodicNoise(32, 32, rnd);
  const put = (x: number, y: number, c: RGB, a = 255) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const o = (y * S + x) * 4;
    data[o] = clamp(c[0], 0, 255);
    data[o + 1] = clamp(c[1], 0, 255);
    data[o + 2] = clamp(c[2], 0, 255);
    data[o + 3] = a;
  };
  const fill = (x0: number, y0: number, x1: number, y1: number, f: (u: number, v: number, x: number, y: number) => RGB) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, f((x - x0) / (x1 - x0), (y - y0) / (y1 - y0), x, y));
  };
  // --- the chart: two cays in a pale sea, depth contours, a dashed course and a compass rose
  const islands = [
    { x: 0.36, y: 0.58, r: 0.13 },
    { x: 0.72, y: 0.3, r: 0.08 },
  ];
  fill(0, 0, 256, 256, (u, v) => {
    const paper: RGB = [236, 226, 196];
    let d = 9;
    for (const is of islands) {
      const wob = 0.025 * Math.sin(Math.atan2(v - is.y, u - is.x) * 5 + is.x * 9);
      d = Math.min(d, Math.hypot(u - is.x, v - is.y) - is.r - wob);
    }
    let c: RGB = d < 0 ? (d < -0.04 ? [160, 190, 120] : [232, 208, 150]) : [196, 222, 222];
    if (d >= 0 && d < 0.1) c = [178, 214, 218];
    if (d >= 0 && Math.abs(((d * 60) % 1) - 0.5) < 0.06 && d < 0.2) c = [150, 186, 196];
    if (Math.abs(d) < 0.004) c = [90, 80, 60];
    const g = Math.min(Math.abs(((u * 6) % 1) - 0.5), Math.abs(((v * 6) % 1) - 0.5));
    if (g > 0.49) c = [c[0] * 0.92, c[1] * 0.92, c[2] * 0.92];
    if (u < 0.03 || v < 0.03 || u > 0.97 || v > 0.97) c = paper;
    const n = 1 + 0.05 * (noise(u, v) - 0.5);
    return [c[0] * n, c[1] * n, c[2] * n];
  });
  for (let t = 0; t < 1; t += 0.004) {
    if (Math.floor(t * 40) % 2) continue;
    const x = (0.12 + 0.6 * t) * 256;
    const y = (0.15 + 0.3 * t + 0.1 * Math.sin(t * 6)) * 256;
    put(Math.round(x), Math.round(y), [200, 70, 50]);
    put(Math.round(x) + 1, Math.round(y), [200, 70, 50]);
  }
  for (let a = 0; a < 16; a++) {
    const len = a % 4 === 0 ? 30 : a % 2 === 0 ? 18 : 11;
    for (let r = 0; r < len; r++) put(Math.round(205 + Math.cos((a * Math.PI) / 8) * r), Math.round(205 + Math.sin((a * Math.PI) / 8) * r), a === 4 ? [200, 70, 50] : [80, 70, 60]);
  }
  // --- the compass card
  fill(256, 0, 384, 128, (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.hypot(dx, dy) * 2;
    const a = Math.atan2(dy, dx);
    if (r > 0.98) return [30, 32, 34];
    let c: RGB = [246, 242, 230];
    const tick = Math.abs(((a / (Math.PI / 18)) % 1 + 1) % 1 - 0.5) > 0.42;
    if (r > 0.8 && tick) c = [40, 40, 40];
    if (r > 0.7 && Math.abs(((a / (Math.PI / 2)) % 1 + 1) % 1 - 0.5) > 0.47) c = [40, 40, 40];
    const north = Math.abs(dx) < 0.18 * (0.5 - dy) && dy > 0 && dy < 0.4;
    if (north) c = [210, 60, 45];
    if (r < 0.08) c = [40, 40, 40];
    return c;
  });
  // --- a patchwork quilt (owner's bunk) and a blue gingham one (second cabin)
  const patch: RGB[] = [
    [42, 157, 154],
    [232, 102, 76],
    [244, 236, 214],
    [125, 168, 196],
    [226, 200, 140],
    [96, 150, 110],
  ];
  fill(256, 128, 512, 256, (u, v, x, y) => {
    const i = Math.floor((x - 256) / 16);
    const j = Math.floor((y - 128) / 16);
    let c = patch[(i * 7 + j * 3 + ((i * j) % 5)) % patch.length];
    const lx = (x - 256) % 16;
    const ly = (y - 128) % 16;
    if (lx === 0 || ly === 0) c = [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75];
    if ((lx === 2 || ly === 2) && (x + y) % 3 === 0) c = [250, 246, 236];
    if (u < 0.03 || v < 0.03 || u > 0.97 || v > 0.97) c = [42, 120, 130];
    return c;
  });
  fill(256, 384, 512, 512, (u, v, x, y) => {
    const a = Math.floor((x - 256) / 12) % 2;
    const b = Math.floor((y - 384) / 12) % 2;
    const k = a + b;
    const c: RGB = k === 0 ? [246, 244, 238] : k === 1 ? [150, 186, 214] : [70, 120, 170];
    return u < 0.03 || v < 0.03 || u > 0.97 || v > 0.97 ? [60, 100, 150] : c;
  });
  // --- a woven rug: border, then diamonds
  fill(0, 256, 256, 512, (u, v) => {
    const bu = Math.min(u, 1 - u);
    const bv = Math.min(v, 1 - v);
    const b = Math.min(bu, bv);
    if (b < 0.035) return [180, 80, 55];
    if (b < 0.07) return [240, 228, 200];
    if (b < 0.1) return [42, 140, 140];
    const du = Math.abs(((u * 5) % 1) - 0.5);
    const dv = Math.abs(((v * 3) % 1) - 0.5);
    const d = du + dv;
    const w = 1 + 0.06 * Math.sin(v * 400);
    if (d < 0.18) return [200 * w, 90 * w, 60 * w];
    if (d < 0.26) return [242 * w, 232 * w, 205 * w];
    if (d < 0.32) return [42 * w, 140 * w, 140 * w];
    return [228 * w, 205 * w, 160 * w];
  });
  // --- book spines
  const spines: RGB[] = [
    [150, 60, 50],
    [40, 90, 120],
    [220, 190, 110],
    [60, 110, 80],
    [200, 120, 70],
    [90, 70, 110],
    [235, 225, 200],
  ];
  let bx = 256;
  let bi = 0;
  while (bx < 512) {
    const w = 8 + Math.floor(rnd() * 10);
    const top = 384 - Math.floor(rnd() * 26);
    const c = spines[bi++ % spines.length];
    for (let x = bx; x < Math.min(512, bx + w); x++) {
      for (let y = 256; y < 384; y++) {
        if (y > top) put(x, y, [70, 55, 40]);
        else {
          const edge = x === bx || x === bx + w - 1;
          const band = Math.abs(y - (300 + (bi % 3) * 14)) < 3;
          put(x, y, edge ? [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7] : band ? [230, 200, 120] : c);
        }
      }
    }
    bx += w;
  }
  // --- a striped towel
  fill(384, 0, 512, 128, (u) => (Math.floor(u * 9) % 2 ? [127, 196, 192] : [246, 242, 232]));
  return finishTexture(data, S, S);
}

/** Trampoline netting: dark woven strands with holes (alpha), repeating every 16 cm. */
function paintNet(): THREE.DataTexture {
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const gx = Math.min(x % 16, 16 - (x % 16));
      const gy = Math.min(y % 16, 16 - (y % 16));
      const g = Math.min(gx, gy);
      const o = (y * S + x) * 4;
      const strand = g < 2.2;
      const knot = gx < 3 && gy < 3;
      data[o] = knot ? 52 : 44;
      data[o + 1] = knot ? 56 : 49;
      data[o + 2] = knot ? 58 : 53;
      data[o + 3] = strand || knot ? 255 : 0;
    }
  }
  const tex = finishTexture(data, S, S);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ============================================================ hulls, decks, steps

function buildHullShell(p: Part, k: number): void {
  const zc = k * HZ;
  const NS = 76;
  const NJ = 20;
  const v0 = p.nv;
  const i0 = p.idx.length;
  const O: number[][] = [];
  const I: number[][] = [];
  const mids: number[] = [];
  for (let i = 0; i <= NS; i++) {
    const s = i / NS;
    const x = X_ST + LOA * (0.55 * s + 0.45 * (0.5 - 0.5 * Math.cos(Math.PI * s)));
    const sec = sectionAt(x);
    const ro: number[] = [];
    const ri: number[] = [];
    for (let j = 0; j <= NJ; j++) {
      const [w, y] = sec.point(j / NJ);
      if (j === NJ) {
        const c = p.v(x, y, zc);
        ro.push(c);
        ri.push(c);
      } else {
        ro.push(p.v(x, y, zc + k * w));
        ri.push(p.v(x, y, zc - k * w));
      }
    }
    O.push(ro);
    I.push(ri);
    mids.push((sec.yd + sec.yk) / 2);
  }
  for (let i = 0; i < NS; i++) {
    const ym = mids[i];
    const out = (q: THREE.Vector3) => V(0, q.y - ym, q.z - zc);
    p.stitch(O[i], O[i + 1], false, out);
    p.stitch(I[i], I[i + 1], false, out);
  }
  p.smoothNormals(v0, i0);
  // the transom
  const tn = V(-1, 0, 0);
  const loopIdx = [...O[0], ...I[0].slice(0, NJ).reverse()];
  const ring = loopIdx.map((q) => p.v(p.pos[q * 3], p.pos[q * 3 + 1], p.pos[q * 3 + 2], tn));
  let cy = 0;
  for (const q of ring) cy += p.pos[q * 3 + 1];
  p.fan(p.v(X_ST, cy / ring.length, zc, tn), ring, true, tn);
}

function buildKeelsAndLegs(hull: Part, metal: Part): void {
  for (const k of [-1, 1]) {
    const zc = k * HZ;
    const t = new Part();
    foilLoft(
      t,
      [
        { y: -0.62, xLE: 2.25, chord: 3.5, half: 0.1 },
        { y: -0.9, xLE: 2.05, chord: 3.3, half: 0.095 },
        { y: -1.15, xLE: 1.85, chord: 3.05, half: 0.085 },
        { y: -1.25, xLE: 1.7, chord: 2.85, half: 0.07 },
        { y: -1.29, xLE: 1.6, chord: 2.7, half: 0.04 },
        { y: -DRAFT, xLE: 1.5, chord: 2.55, half: 0 },
      ],
      10,
    );
    addPart(hull, t, M(0, 0, zc));
    // saildrive leg and pod (grey), the propeller spins on its end (see the moving rig)
    const leg = new Part();
    foilLoft(
      leg,
      [
        { y: -0.6, xLE: -2.72, chord: 0.36, half: 0.045 },
        { y: -0.86, xLE: -2.74, chord: 0.34, half: 0.045 },
        { y: -0.88, xLE: -2.74, chord: 0.34, half: 0 },
      ],
      6,
      COL.motorGrey,
    );
    addPart(metal, leg, M(0, 0, zc));
    metal.add(new THREE.CapsuleGeometry(0.065, 0.3, 4, 10), COL.motorGrey, M(-2.93, -0.92, zc, 0, 0, Math.PI / 2));
  }
}

function buildBridgedeck(gel: Part): void {
  const top = DECK_Y - 0.02;
  gel.add(roundedBox(X_FWDDECK - X_AFTBEAM, top - UNDER_Y, 2 * 1.78, 0.12, 2), COL.white, M((X_FWDDECK + X_AFTBEAM) / 2, (top + UNDER_Y) / 2, 0));
  // forward crossbeam and the centre beam the chain runs along
  gel.add(roundedBox(0.18, 0.2, 2 * (HZ - 0.12), 0.05, 2), COL.white, M(X_XBEAM + 0.07, 1.62, 0));
  gel.add(roundedBox(X_XBEAM - X_FWDDECK, 0.12, 0.2, 0.03, 2), COL.white, M((X_XBEAM + X_FWDDECK) / 2, DECK_Y - 0.07, 0));
}

function buildDecks(teak: Part): void {
  const outer = (x: number) => HZ + hd(x) - 0.002;
  deckStrip(teak, X_AFTBEAM, HST_X0, 14, (x) => -outer(x), outer, 28, (x) => deckH(x));
  deckStrip(teak, HST_X0, HST_X1, 8, (x) => -outer(x), () => -HST_Z1, 3, (x) => deckH(x));
  deckStrip(teak, HST_X0, HST_X1, 8, () => -HST_Z0, () => HST_Z0, 18, (x) => deckH(x));
  deckStrip(teak, HST_X0, HST_X1, 8, () => HST_Z1, outer, 3, (x) => deckH(x));
  deckStrip(teak, HST_X1, X_FWDDECK, 14, (x) => -outer(x), outer, 28, (x) => deckH(x));
  // the trampoline's centre beam
  deckStrip(teak, X_FWDDECK, X_XBEAM, 6, () => -0.1, () => 0.1, 1, () => DECK_Y + 0.001);
  for (const k of [-1, 1]) {
    deckStrip(teak, X_FWDDECK, X_BW - 0.01, 20, (x) => k * HZ - hd(x) + 0.002, (x) => k * HZ + hd(x) - 0.002, 6, (x) => deckH(x));
  }
}

function buildEdges(wood: Part): void {
  const prof: [number, number][] = [
    [-0.02, -0.01],
    [-0.02, 0.03],
    [-0.012, 0.042],
    [0, 0.046],
    [0.012, 0.042],
    [0.02, 0.03],
    [0.02, -0.01],
  ];
  for (const k of [-1, 1]) {
    const zc = k * HZ;
    // toerail: along the outer deck edge to the bow, back along the inner edge of the foredeck
    const path: THREE.Vector3[] = [];
    const N = 40;
    for (let i = 0; i <= N; i++) {
      const x = X_AFTBEAM + 0.02 + (X_BW - 0.06 - X_AFTBEAM - 0.02) * (1 - Math.pow(1 - i / N, 1.3));
      path.push(V(x, deckH(x) - 0.004, zc + k * (hd(x) - 0.018)));
    }
    path.push(V(X_BW - 0.01, deckH(X_BW) - 0.004, zc));
    for (let i = N; i >= 0; i--) {
      const x = X_FWDDECK + (X_BW - 0.06 - X_FWDDECK) * (1 - Math.pow(1 - i / N, 1.3));
      path.push(V(x, deckH(x) - 0.004, zc - k * (hd(x) - 0.018)));
    }
    sweep(wood, path, prof, false, WHITE);
    // rubbing strake on the outer topsides
    const rp: THREE.Vector3[] = [];
    for (let i = 0; i <= 50; i++) {
      const x = X_ST + 0.06 + (X_BW - 0.2 - X_ST - 0.06) * (1 - Math.pow(1 - i / 50, 1.2));
      const yy = yTop(x) - 0.05;
      rp.push(V(x, yy, zc + k * (hullHalfAt(x, yy) - 0.004)));
    }
    const half: [number, number][] = [];
    for (let j = 0; j <= 6; j++) {
      const a = (j / 6) * Math.PI;
      half.push([k * 0.022 * Math.sin(a), -0.02 * Math.cos(a)]);
    }
    if (k < 0) half.reverse();
    sweep(wood, rp, half, false, WHITE);
  }
}

function buildSternSteps(gel: Part, teak: Part): void {
  for (const k of [-1, 1]) {
    const zc = k * HZ;
    for (const s of STEPS) {
      const w = stepHalf((s.x0 + s.x1) / 2, s.y);
      slab(gel, Math.max(s.x0, X_ST + 0.012), s.x1, Math.max(s.y - 0.32, -0.02), s.y - 0.008, zc - w, zc + w, COL.white, 0.025);
      deckStrip(teak, s.x0 + 0.02, s.x1 - 0.01, 2, () => zc - w + 0.03, () => zc + w - 0.03, 4, () => s.y);
    }
    const w0 = stepHalf(-5.4, STEPS[0].y);
    slab(gel, X_AFTBEAM - 0.02, X_AFTBEAM + 0.005, STEPS[0].y - 0.01, DECK_Y - 0.002, zc - w0, zc + w0, COL.white, 0.006);
  }
}

// ============================================================ the saloon: walls, windows, roof

const frontX = (y: number) => (y <= SILL_Y ? SAL_X1 : SAL_X1 - ((SAL_X1 - SAL_TOPX) * (y - SILL_Y)) / (ROOF_Y0 - SILL_Y));
const WALL = 0.08;

function buildSaloon(gel: Part, nonskid: Part, teak: Part, wood: Part, metal: Part, glass: Part): void {
  const gz = (k: number) => k * (SAL_Z - WALL / 2);
  const glassN = (k: number) => V(0, 0, k);
  for (const k of [-1, 1]) {
    const z0 = k * (SAL_Z - WALL);
    const z1 = k * SAL_Z;
    // side wall: solid below the sills, three tall windows, a band above
    slab(gel, SAL_X0, SAL_X1, DECK_Y - 0.01, SILL_Y, z0, z1, COL.white, 0.02);
    slab(gel, SAL_X0, frontX(WIN_Y), WIN_Y, ROOF_Y0, z0, z1, COL.white, 0.02);
    for (const [a, b] of [
      [SAL_X0, SAL_X0 + 0.14],
      [0.25, 0.4],
      [1.85, 2.0],
    ]) slab(gel, a, b, SILL_Y - 0.01, WIN_Y + 0.01, z0, z1, COL.white, 0.012);
    const fa = V(frontX(SILL_Y) - 0.06, SILL_Y, gz(k));
    const fb = V(frontX(WIN_Y) - 0.06, WIN_Y, gz(k));
    gel.add(roundedBox(0.12, fa.distanceTo(fb) + 0.04, WALL, 0.012), COL.white, between(fa, fb).multiply(M(0, 0, 0, 0, 0, 0)));
    // the teal accent line along the outside
    slab(gel, SAL_X0 - 0.003, SAL_X1 + 0.003, 2.2, 2.27, z1 - k * 0.004, z1 + k * 0.004, COL.teal, 0.003);
    for (const [a, b] of [
      [SAL_X0 + 0.14, 0.25],
      [0.4, 1.85],
    ])
      quad(glass, V(a, SILL_Y, gz(k)), V(b, SILL_Y, gz(k)), V(b, WIN_Y, gz(k)), V(a, WIN_Y, gz(k)), glassN(k));
    quad(glass, V(2.0, SILL_Y, gz(k)), V(frontX(SILL_Y) - 0.12, SILL_Y, gz(k)), V(frontX(WIN_Y) - 0.12, WIN_Y, gz(k)), V(2.0, WIN_Y, gz(k)), glassN(k));
    // varnished sill inside
    slab(wood, SAL_X0 + 0.06, SAL_X1 - 0.1, SILL_Y - 0.03, SILL_Y + 0.015, z0 - k * 0.07, z0, WHITE, 0.01);
  }
  // aft wall: low sills, tall glass either side of the big door, a header across
  const ax0 = SAL_X0;
  const ax1 = SAL_X0 + WALL;
  for (const k of [-1, 1]) {
    slab(gel, ax0, ax1, DECK_Y - 0.01, DECK_Y + 0.12, k * DOOR_Z, k * SAL_Z, COL.white, 0.012);
    slab(gel, ax0, ax1, DECK_Y - 0.01, WIN_Y + 0.01, k * (SAL_Z - 0.16), k * SAL_Z, COL.white, 0.012);
    slab(gel, ax0, ax1, DECK_Y - 0.01, WIN_Y + 0.01, k * (DOOR_Z - 0.03), k * (DOOR_Z + 0.07), COL.white, 0.012);
    quad(glass, V(ax0 + 0.03, DECK_Y + 0.12, k * (DOOR_Z + 0.07)), V(ax0 + 0.03, DECK_Y + 0.12, k * (SAL_Z - 0.16)), V(ax0 + 0.03, WIN_Y, k * (SAL_Z - 0.16)), V(ax0 + 0.03, WIN_Y, k * (DOOR_Z + 0.07)), V(-1, 0, 0));
  }
  slab(gel, ax0, ax1, WIN_Y, ROOF_Y0, -SAL_Z, SAL_Z, COL.white, 0.012);
  slab(wood, ax0 - 0.01, ax1 + 0.01, DECK_Y - 0.008, DECK_Y + 0.01, -DOOR_Z, DOOR_Z, WHITE, 0.004); // door track
  // front: solid below the sills, raked windscreen in three panes
  slab(gel, SAL_X1 - WALL, SAL_X1, DECK_Y - 0.01, SILL_Y, -SAL_Z, SAL_Z, COL.white, 0.02);
  slab(gel, SAL_X1 - 0.004, SAL_X1 + 0.004, 2.2, 2.27, -SAL_Z, SAL_Z, COL.teal, 0.003);
  const panes: [number, number][] = [
    [-SAL_Z + 0.06, -0.97],
    [-0.93, 0.93],
    [0.97, SAL_Z - 0.06],
  ];
  const rake = new THREE.Vector3(frontX(WIN_Y) - frontX(SILL_Y), WIN_Y - SILL_Y, 0);
  const fn = V(rake.y, -rake.x, 0).normalize();
  for (const [a, b] of panes) {
    const xs = frontX(SILL_Y) - 0.04;
    const xw = frontX(WIN_Y) - 0.04;
    quad(glass, V(xs, SILL_Y, a), V(xs, SILL_Y, b), V(xw, WIN_Y, b), V(xw, WIN_Y, a), fn);
  }
  for (const z of [-0.95, 0.95]) {
    const a = V(frontX(SILL_Y) - 0.04, SILL_Y, z);
    const b = V(frontX(WIN_Y) - 0.04, WIN_Y, z);
    gel.add(roundedBox(0.08, a.distanceTo(b) + 0.02, 0.06, 0.01), COL.white, between(a, b));
  }
  const ha = V(frontX(WIN_Y) - 0.04, WIN_Y, 0);
  const hb = V(frontX(ROOF_Y0) - 0.04, ROOF_Y0, 0);
  gel.add(roundedBox(0.08, ha.distanceTo(hb) + 0.04, 2 * SAL_Z, 0.015), COL.white, between(ha, hb));
  slab(wood, SAL_X1 - 0.17, SAL_X1 - WALL, SILL_Y - 0.03, SILL_Y + 0.015, -SAL_Z + 0.08, SAL_Z - 0.08, WHITE, 0.01);
  // the roof, overhanging the cockpit; teak on the flybridge, non-skid elsewhere
  gel.add(roundedBox(ROOF_X1 - ROOF_X0, ROOF_Y - ROOF_Y0, 2 * ROOF_Z, 0.035, 2), COL.white, M((ROOF_X0 + ROOF_X1) / 2, (ROOF_Y + ROOF_Y0) / 2, 0));
  slab(gel, ROOF_X0 - 0.004, ROOF_X1 + 0.004, ROOF_Y0 + 0.012, ROOF_Y0 + 0.05, -ROOF_Z - 0.004, ROOF_Z + 0.004, COL.teal, 0.01);
  deckStrip(teak, FLY_X0 + 0.03, FLY_X1, 10, () => -FLY_Z, () => FLY_Z, 16, () => ROOF_Y + 0.004);
  const ns = (x0: number, x1: number, z0: number, z1: number) => {
    const y = ROOF_Y + 0.004;
    quad(nonskid, V(x0, y, z0), V(x1, y, z0), V(x1, y, z1), V(x0, y, z1), V(0, 1, 0), WHITE, [x0 / 0.26, z0 / 0.26, x1 / 0.26, z1 / 0.26]);
  };
  ns(FLY_X1 + 0.05, ROOF_X1 - 0.08, -ROOF_Z + 0.08, ROOF_Z - 0.08);
  for (const k of [-1, 1]) ns(ROOF_X0 + 0.08, FLY_X1 + 0.05, k < 0 ? -ROOF_Z + 0.08 : FLY_Z + 0.05, k < 0 ? -FLY_Z - 0.05 : ROOF_Z - 0.08);
  void metal;
}

// ============================================================ inside the saloon

function buildSaloonInterior(gel: Part, wood: Part, metal: Part, cloth: Part, decal: Part): { galley: THREE.Box3; chart: THREE.Box3 } {
  const F = DECK_Y;
  // --- the galley along the port side: cabinets, counter, sink, stove, cool box, jars
  const g0 = wood.nv;
  const gm0 = metal.nv;
  slab(wood, 1.55, 3.2, F - 0.005, 2.33, -SAL_Z + WALL, -2.4, WHITE, 0.012);
  slab(gel, 1.53, 3.22, 2.33, 2.38, -SAL_Z + WALL - 0.005, -2.37, COL.cream, 0.008);
  for (const x of [2.06, 2.5, 2.88]) slab(metal, x - 0.003, x + 0.003, F + 0.06, 2.3, -2.402, -2.397, COL.black, 0.001);
  slab(metal, 2.06, 3.18, 2.13, 2.136, -2.402, -2.397, COL.black, 0.001);
  for (const [x, y] of [
    [2.28, 2.22],
    [2.69, 2.22],
    [3.04, 2.22],
    [2.28, 1.92],
    [2.69, 1.92],
    [3.04, 1.92],
  ])
    metal.add(new THREE.SphereGeometry(0.014, 8, 6), COL.steel, M(x, y, -2.39));
  slab(gel, 1.6, 2.0, F + 0.08, 2.27, -2.405, -2.39, COL.white, 0.012); // the cool box under the counter
  rod(metal, V(1.94, 1.9, -2.375), V(1.94, 2.12, -2.375), 0.009, 6, COL.steel, true);
  slab(metal, 1.68, 2.04, 2.355, 2.383, -2.86, -2.52, COL.steel, 0.01); // sink
  metal.add(new THREE.CylinderGeometry(0.02, 0.02, 0.004, 10), COL.dark, M(1.86, 2.385, -2.69));
  tube(metal, curve([V(1.86, 2.38, -2.9), V(1.86, 2.6, -2.9), V(1.86, 2.62, -2.8), V(1.86, 2.55, -2.72)], 8), 0.011, 6, COL.steel, true);
  slab(metal, 2.48, 2.98, 2.38, 2.405, -2.88, -2.5, COL.stove, 0.01); // stove
  for (const x of [2.61, 2.85]) metal.add(new THREE.TorusGeometry(0.07, 0.008, 5, 16), COL.dark, M(x, 2.41, -2.69, Math.PI / 2, 0, 0));
  metal.add(new THREE.CylinderGeometry(0.06, 0.075, 0.12, 14), COL.kettle, M(2.61, 2.47, -2.69)); // kettle
  metal.add(new THREE.SphereGeometry(0.06, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), COL.kettle, M(2.61, 2.53, -2.69));
  tube(metal, curve([V(2.67, 2.5, -2.69), V(2.71, 2.55, -2.69), V(2.74, 2.58, -2.69)], 4), 0.01, 6, COL.kettle, true);
  for (const [x, h] of [
    [3.0, 0.14],
    [3.08, 0.11],
    [3.15, 0.16],
  ]) {
    cloth.add(new THREE.CylinderGeometry(0.035, 0.035, h, 12), COL.jar, M(x, 2.38 + h / 2, -2.88));
    cloth.add(new THREE.CylinderGeometry(0.037, 0.037, 0.02, 12), COL.lid, M(x, 2.38 + h + 0.01, -2.88));
  }
  const galley = partBox(wood, g0).union(partBox(metal, gm0));
  // --- the dinette: table, U-shaped settee with cushions, a rug in front of the door
  rod(metal, V(2.05, F, 0), V(2.05, 2.2, 0), 0.04, 10, COL.steel);
  metal.add(new THREE.CylinderGeometry(0.2, 0.22, 0.015, 18), COL.steel, M(2.05, F + 0.008, 0));
  slab(wood, 1.6, 2.5, 2.2, 2.255, -0.5, 0.5, WHITE, 0.03);
  slab(gel, 2.6, 3.1, F - 0.005, 1.85, -1.05, 1.05, COL.white, 0.03);
  for (const k of [-1, 1]) slab(gel, 1.45, 2.6, F - 0.005, 1.85, k < 0 ? -1.05 : 0.62, k < 0 ? -0.62 : 1.05, COL.white, 0.03);
  slab(cloth, 2.62, 3.08, 1.85, 1.95, -1.03, 1.03, COL.cushion, 0.035);
  for (const k of [-1, 1]) slab(cloth, 1.47, 2.62, 1.85, 1.95, k < 0 ? -1.03 : 0.64, k < 0 ? -0.64 : 1.03, COL.cushion, 0.035);
  for (const z of [-0.6, 0, 0.6]) cloth.add(roundedBox(0.12, 0.36, 0.56, 0.05, 2), COL.cushionLight, M(3.05, 2.15, z, 0, 0, -0.15));
  quad(decal, V(-0.75, F + 0.003, -1.0), V(1.15, F + 0.003, -1.0), V(1.15, F + 0.003, 1.0), V(-0.75, F + 0.003, 1.0), V(0, 1, 0), WHITE, DEC.rug);
  // --- the chart table forward to starboard, and a bookshelf
  const c0 = wood.nv;
  slab(wood, 2.72, 3.25, F - 0.005, 2.24, 1.6, SAL_Z - WALL, WHITE, 0.015);
  slab(wood, 2.7, 3.27, 2.24, 2.28, 1.58, SAL_Z - WALL + 0.01, WHITE, 0.01);
  const cy = 2.284;
  quad(decal, V(2.76, cy, 2.88), V(2.76, cy, 1.66), V(3.22, cy, 1.66), V(3.22, cy, 2.88), V(0, 1, 0), WHITE, DEC.chart);
  rod(metal, V(2.9, cy + 0.006, 2.2), V(3.08, cy + 0.006, 2.35), 0.003, 4, COL.steel);
  rod(metal, V(2.9, cy + 0.006, 2.2), V(3.1, cy + 0.006, 2.18), 0.003, 4, COL.steel);
  tube(wood, [V(2.85, cy + 0.008, 2.55), V(2.86, cy + 0.008, 2.72)], 0.006, 6, WHITE, true);
  const chart = partBox(wood, c0);
  slab(wood, 1.45, 2.62, F - 0.005, 2.3, 2.72, SAL_Z - WALL, WHITE, 0.015);
  quad(decal, V(1.5, 1.6, 2.715), V(2.57, 1.6, 2.715), V(2.57, 2.22, 2.715), V(1.5, 2.22, 2.715), V(0, 0, -1), WHITE, DEC.books);
  // --- framing and guard rails round the two stairwells down into the hulls
  for (const k of [-1, 1]) {
    const zi = k * HST_Z0;
    const zo = k * HST_Z1;
    slab(wood, HST_X0 - 0.03, HST_X1 + 0.03, HCEIL_Y + 0.01, F + 0.006, zi - 0.03, zi + 0.03, WHITE, 0.008);
    slab(wood, HST_X1 - 0.03, HST_X1 + 0.03, HCEIL_Y + 0.01, F + 0.006, Math.min(zi, zo), Math.max(zi, zo), WHITE, 0.008);
    for (const x of [-0.55, 0.35, HST_X1]) rod(metal, V(x, F, zi), V(x, F + 0.93, zi), 0.016, 8, COL.steel, true);
    rod(metal, V(HST_X1, F, k * 2.82), V(HST_X1, F + 0.93, k * 2.82), 0.016, 8, COL.steel, true);
    tube(wood, curve([V(-0.55, F + 0.94, zi), V(0.6, F + 0.94, zi), V(HST_X1, F + 0.94, zi + k * 0.05), V(HST_X1, F + 0.94, k * 2.86)], 12), 0.022, 8, WHITE, true);
    rod(metal, V(-0.55, F + 0.5, zi), V(HST_X1, F + 0.5, zi), 0.01, 6, COL.steel);
  }
  return { galley, chart };
}

// ============================================================ the hull cabins

function buildHullInterior(cabin: Part, gel: Part, teak: Part, wood: Part, metal: Part, cloth: Part, decal: Part, k: number): { bunk: THREE.Box3; workbench: THREE.Box3 | null } {
  const zc = k * HZ;
  const wAt = (x: number, y: number) => Math.max(0.03, hullHalfAt(x, y) - LINING);
  const NX = 26;
  const NY = 9;
  const xs = Array.from({ length: NX + 1 }, (_, i) => HLIN_X0 + ((HLIN_X1 - HLIN_X0) * i) / NX);
  const ys = Array.from({ length: NY + 1 }, (_, j) => HFLOOR_Y + ((HCEIL_Y - HFLOOR_Y) * j) / NY);
  // the lining: cream walls following the hull, a ceiling (open over the stairs), the floor and the two end bulkheads
  for (const s of [1, -1]) {
    const v0 = cabin.nv;
    const i0 = cabin.idx.length;
    const rows = xs.map((x) => ys.map((y) => cabin.v(x, y, zc + s * k * wAt(x, y), null, 0, 0, y < -0.15 ? COL.liningLow : COL.lining)));
    for (let i = 0; i < NX; i++) cabin.stitch(rows[i], rows[i + 1], false, (q) => V(0, 0, zc - q.z));
    cabin.smoothNormals(v0, i0);
  }
  const ceil = (x0: number, x1: number, za: (x: number) => number, zb: (x: number) => number) => {
    const rows: number[][] = [];
    const n = 8;
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      rows.push([cabin.v(x, HCEIL_Y, za(x), V(0, -1, 0), 0, 0, COL.lining), cabin.v(x, HCEIL_Y, zb(x), V(0, -1, 0), 0, 0, COL.lining)]);
    }
    for (let i = 0; i < n; i++) cabin.stitch(rows[i], rows[i + 1], false, V(0, -1, 0));
  };
  const inW = (x: number) => zc - k * wAt(x, HCEIL_Y);
  const outW = (x: number) => zc + k * wAt(x, HCEIL_Y);
  ceil(HLIN_X0, HST_X0, inW, outW);
  ceil(HST_X0, HST_X1, inW, () => k * HST_Z0);
  ceil(HST_X0, HST_X1, () => k * HST_Z1, outW);
  ceil(HST_X1, HLIN_X1, inW, outW);
  deckStrip(teak, HLIN_X0, HROOM_X1 + 0.03, 12, (x) => zc - floorHalf(x) - 0.004, (x) => zc + floorHalf(x) + 0.004, 4, () => HFLOOR_Y);
  for (const [x, n] of [
    [HLIN_X0, 1],
    [HLIN_X1, -1],
  ] as [number, number][]) {
    const nn = V(n, 0, 0);
    const ring: number[] = [];
    for (const y of ys) ring.push(cabin.v(x, y, zc + k * wAt(x, y), nn, 0, 0, COL.lining));
    for (const y of [...ys].reverse()) ring.push(cabin.v(x, y, zc - k * wAt(x, y), nn, 0, 0, COL.lining));
    cabin.fan(cabin.v(x, (HFLOOR_Y + HCEIL_Y) / 2, zc, nn, 0, 0, COL.lining), ring, true, nn);
  }
  // varnished battens along both walls, and a skirting strip
  for (const s of [1, -1]) {
    for (const y of [0.3, 0.55, 0.8, 1.05, 1.3]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 10; i++) {
        const x = HST_X1 + 0.05 + ((HLIN_X1 - 0.1 - HST_X1 - 0.05) * i) / 10;
        pts.push(V(x, y, zc + s * k * (wAt(x, y) - 0.012)));
      }
      tube(wood, pts, 0.016, 5, WHITE, true);
    }
  }
  // the stairs down from the saloon: varnished treads, cream risers, closed sides
  const zA = Math.min(k * HST_Z0, k * HST_Z1);
  const zB = Math.max(k * HST_Z0, k * HST_Z1);
  for (let i = 0; i < HST_N; i++) {
    const xa = HST_X0 + i * HST_RUN;
    const xb = xa + HST_RUN;
    const h = DECK_Y - (i + 1) * HST_RISE;
    const hPrev = DECK_Y - i * HST_RISE;
    slab(cabin, xa - 0.006, xa + 0.012, h - 0.01, hPrev - 0.03, zA + 0.01, zB - 0.01, COL.lining, 0.004);
    if (i === HST_N - 1) break;
    slab(wood, xa - 0.02, xb + 0.015, h - 0.045, h, zA + 0.01, zB - 0.01, WHITE, 0.012);
    for (const z of [zA, zB]) slab(cabin, xa, xb + 0.01, HFLOOR_Y, h - 0.04, z - 0.012, z + 0.012, COL.lining, 0.004);
  }
  tube(wood, [V(HST_X0 + 0.15, DECK_Y - 0.12, k * (HST_Z0 + 0.015)), V(HST_X1 - 0.05, HFLOOR_Y + 0.2, k * (HST_Z0 + 0.015))], 0.016, 6, WHITE, true);
  let workbench: THREE.Box3 | null = null;
  if (k < 0) {
    // the head: a little vanity with a basin and mirror, the loo beside it, a towel
    const zo = (x: number, y: number) => zc + k * (wAt(x, y) - 0.01);
    slab(wood, 1.45, 1.92, HFLOOR_Y, 0.33, zc + k * floorHalf(1.45), k * 2.97, WHITE, 0.012);
    slab(gel, 1.43, 1.94, 0.33, 0.37, zo(1.7, 0.35), k * 2.95, COL.cream, 0.01);
    gel.add(roundedBox(0.3, 0.07, 0.24, 0.03, 2), COL.porcelain, M(1.68, 0.39, k * 3.18));
    tube(metal, curve([V(1.68, 0.37, zo(1.68, 0.4) - k * 0.02), V(1.68, 0.52, zo(1.68, 0.5) - k * 0.04), V(1.68, 0.5, zo(1.68, 0.5) - k * 0.13)], 6), 0.009, 6, COL.steel, true);
    slab(metal, 1.5, 1.88, 0.6, 1.1, zo(1.7, 0.85) - k * 0.01, zo(1.7, 0.85) - k * 0.002, COL.glass, 0.01);
    gel.add(roundedBox(0.3, 0.38, 0.36, 0.1, 2), COL.porcelain, M(2.1, HFLOOR_Y + 0.19, k * 3.12));
    slab(wood, 1.95, 2.25, -0.1, -0.08, k * 2.95, k * 3.3, WHITE, 0.01);
    quad(decal, V(1.5, -0.25, k * 2.968), V(1.86, -0.25, k * 2.968), V(1.86, 0.25, k * 2.968), V(1.5, 0.25, k * 2.968), V(0, 0, -k), WHITE, DEC.towel);
  } else {
    // the workshop: a stout bench with a vise, tools on a board, rope and a jar of screws
    const w0 = wood.nv;
    const m0 = metal.nv;
    const zo = (x: number, y: number) => zc + k * (wAt(x, y) - 0.01);
    slab(wood, 1.45, 2.75, HFLOOR_Y, 0.31, k * 2.95, zc + k * floorHalf(1.45), WHITE, 0.012);
    slab(wood, 1.42, 2.78, 0.31, 0.36, k * 2.93, zo(2.1, 0.33), WHITE, 0.012);
    const top = 0.36;
    const vx = 2.35;
    const vz = 3.0;
    slab(metal, vx - 0.06, vx + 0.06, top, top + 0.03, vz - 0.0, vz + 0.12, COL.vise, 0.008);
    slab(metal, vx - 0.06, vx + 0.06, top + 0.03, top + 0.11, vz - 0.02, vz + 0.01, COL.vise, 0.008);
    slab(metal, vx - 0.06, vx + 0.06, top + 0.03, top + 0.11, vz + 0.08, vz + 0.11, COL.vise, 0.008);
    rod(metal, V(vx, top + 0.07, vz - 0.12), V(vx, top + 0.07, vz + 0.05), 0.008, 6, COL.steel, true);
    rod(metal, V(vx - 0.07, top + 0.07, vz - 0.12), V(vx + 0.07, top + 0.07, vz - 0.12), 0.006, 6, COL.steel, true);
    const bz = zc + k * 0.8;
    slab(wood, 1.5, 2.7, 0.52, 1.12, bz, bz + k * 0.02, WHITE, 0.006);
    const face = bz - k * 0.004;
    // saw, hammer, wrench, screwdrivers on the board
    const sawN = V(0, 0, -k);
    quad(metal, V(1.62, 0.72, face), V(1.98, 0.76, face), V(1.98, 0.86, face), V(1.62, 0.84, face), sawN, COL.galv);
    slab(metal, 1.62, 1.98, 0.715, 0.725, face - k * 0.004, face, COL.dark, 0.002);
    slab(wood, 1.98, 2.08, 0.73, 0.88, face - k * 0.02, face, WHITE, 0.01);
    slab(wood, 2.2, 2.23, 0.62, 0.95, face - k * 0.025, face, WHITE, 0.008);
    slab(metal, 2.15, 2.28, 0.95, 0.99, face - k * 0.035, face, COL.dark, 0.008);
    slab(metal, 2.38, 2.4, 0.68, 0.98, face - k * 0.012, face, COL.steel, 0.004);
    for (const x of [2.5, 2.56, 2.62]) {
      slab(wood, x - 0.012, x + 0.012, 0.86, 0.96, face - k * 0.025, face, WHITE, 0.008);
      slab(metal, x - 0.004, x + 0.004, 0.72, 0.86, face - k * 0.012, face, COL.steel, 0.002);
    }
    cloth.add(new THREE.TorusGeometry(0.07, 0.022, 6, 16), COL.rope, M(1.7, top + 0.022, 3.12, Math.PI / 2, 0, 0));
    cloth.add(new THREE.CylinderGeometry(0.04, 0.04, 0.12, 12), COL.jar, M(2.62, top + 0.06, 3.15));
    cloth.add(new THREE.CylinderGeometry(0.042, 0.042, 0.02, 12), COL.lid, M(2.62, top + 0.13, 3.15));
    workbench = partBox(wood, w0).union(partBox(metal, m0));
  }
  // a V-berth in the bow: drawers below, a padded mattress, a quilt, pillows
  const bx0 = HROOM_X1;
  const bx1 = HLIN_X1 - 0.03;
  const top = 0.16;
  const halfAt = (x: number) => Math.max(0.1, hullHalfAt(x, top) - LINING - 0.015);
  const b0 = wood.nv;
  slab(wood, bx0 - 0.02, bx0 + 0.015, HFLOOR_Y, top, zc - halfAt(bx0), zc + halfAt(bx0), WHITE, 0.012);
  for (const y of [-0.22, 0.0]) slab(metal, bx0 - 0.024, bx0 - 0.02, y - 0.003, y + 0.003, zc - halfAt(bx0) + 0.08, zc + halfAt(bx0) - 0.08, COL.black, 0.001);
  deckStrip(wood, bx0, bx1, 8, (x) => zc - halfAt(x), (x) => zc + halfAt(x), 4, () => top);
  const mattress = (p: Part, c: RGB, xa: number, xb: number, lift: number, uv?: [number, number, number, number], drape = 0) => {
    const nx = 10;
    const nz = 8;
    const rows: number[][] = [];
    const v0 = p.nv;
    const i0 = p.idx.length;
    for (let i = 0; i <= nx; i++) {
      const fi = i / nx;
      const x = xa + (xb - xa) * fi;
      const w = halfAt(Math.max(x, bx0)) - 0.03;
      const row: number[] = [];
      for (let j = 0; j <= nz; j++) {
        const fj = j / nz;
        const z = zc + (2 * fj - 1) * w;
        const e = Math.min(smooth01(Math.min(fi, 1 - fi) * nx / 1.3), smooth01(Math.min(fj, 1 - fj) * nz / 1.3));
        let y = top + 0.02 + (0.12 + lift) * Math.sqrt(e);
        if (drape > 0 && x < bx0 + drape) y -= 0.18 * (1 - (x - (bx0 - 0.04)) / (drape + 0.04));
        const [u0, v0u, u1, v1] = uv ?? [0, 0, 1, 1];
        row.push(p.v(x, y, z, null, u0 + (u1 - u0) * fj, v0u + (v1 - v0u) * fi, c));
      }
      rows.push(row);
    }
    for (let i = 0; i < nx; i++) p.stitch(rows[i], rows[i + 1], false, V(0, 1, 0));
    p.smoothNormals(v0, i0);
  };
  mattress(cloth, COL.mattress, bx0 + 0.02, bx1 - 0.02, 0);
  mattress(decal, WHITE, bx0 - 0.04, bx0 + 0.62 * (bx1 - bx0), 0.012, k < 0 ? DEC.quilt : DEC.quilt2, 0.06);
  for (const dz of k < 0 ? [-0.2, 0.2] : [0]) cloth.add(roundedBox(0.28, 0.11, 0.38, 0.05, 2), COL.pillow, M(bx1 - 0.42, top + 0.2, zc + dz, 0, 0, 0.25));
  const bunk = partBox(wood, b0);
  bunk.expandByPoint(V(bx1, top + 0.3, zc));
  return { bunk, workbench };
}

// ============================================================ the cockpit and the flybridge

function buildCockpit(gel: Part, wood: Part, metal: Part, cloth: Part): { locker: THREE.Box3; pump: THREE.Box3 } {
  const F = DECK_Y;
  slab(gel, ABENCH_X0, ABENCH_X1, F - 0.005, BENCH_Y - 0.09, -ABENCH_Z, ABENCH_Z, COL.white, 0.03);
  const c0 = cloth.nv;
  slab(cloth, ABENCH_X0 + 0.01, ABENCH_X1 - 0.01, BENCH_Y - 0.09, BENCH_Y, -ABENCH_Z + 0.02, -0.015, COL.cushion, 0.035);
  const locker = partBox(cloth, c0);
  slab(cloth, ABENCH_X0 + 0.01, ABENCH_X1 - 0.01, BENCH_Y - 0.09, BENCH_Y, 0.015, ABENCH_Z - 0.02, COL.cushion, 0.035);
  slab(gel, X_AFTBEAM - 0.03, X_AFTBEAM + 0.05, F - 0.005, 2.3, -1.76, 1.76, COL.white, 0.025);
  slab(wood, X_AFTBEAM - 0.045, X_AFTBEAM + 0.065, 2.29, 2.33, -1.78, 1.78, WHITE, 0.015);
  for (const k of [-1, 1]) cloth.add(roundedBox(0.09, 0.3, 1.6, 0.04, 2), COL.cushionLight, M(ABENCH_X0 + 0.05, 2.12, k * 0.86, 0, 0, 0.12));
  slab(metal, ABENCH_X1 - 0.005, ABENCH_X1 + 0.012, 1.7, 1.76, -0.9, -0.8, COL.steel, 0.006); // locker latch
  slab(gel, SBENCH_X0, SBENCH_X1, F - 0.005, BENCH_Y - 0.09, SBENCH_Z0, SBENCH_Z1, COL.white, 0.03);
  slab(cloth, SBENCH_X0 + 0.01, SBENCH_X1 - 0.01, BENCH_Y - 0.09, BENCH_Y, SBENCH_Z0 + 0.01, SBENCH_Z1 - 0.01, COL.cushion, 0.035);
  // table
  rod(metal, V(-3.4, F, 0), V(-3.4, 2.2, 0), 0.045, 10, COL.steel);
  metal.add(new THREE.CylinderGeometry(0.2, 0.22, 0.015, 18), COL.steel, M(-3.4, F + 0.008, 0));
  slab(wood, -3.9, -2.9, 2.2, 2.25, -0.55, 0.55, WHITE, 0.08);
  // the bilge pump on the saloon's aft wall, starboard of the door (its handle moves)
  const p0 = metal.nv;
  slab(metal, PUMP_C.x - 0.06, PUMP_C.x, PUMP_C.y - 0.15, PUMP_C.y + 0.12, PUMP_C.z - 0.1, PUMP_C.z + 0.1, COL.motorGrey, 0.02);
  metal.add(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 14), COL.dark, M(PUMP_C.x - 0.07, PUMP_C.y - 0.04, PUMP_C.z, 0, 0, Math.PI / 2));
  metal.add(new THREE.CylinderGeometry(0.022, 0.026, 0.06, 10), COL.dark, M(PUMP_C.x - 0.07, PUMP_C.y + 0.13, PUMP_C.z));
  const pump = partBox(metal, p0);
  // the stairs up to the flybridge, on the port side
  const zA = FST_Z0;
  const zB = FST_Z1;
  for (let i = 0; i < FST_N - 1; i++) {
    const xa = FST_X0 + i * FST_RUN;
    const xb = xa + FST_RUN;
    const h = DECK_Y + (i + 1) * FST_RISE;
    slab(wood, xa - 0.01, xb + 0.03, h - 0.05, h, zA + 0.03, zB - 0.03, WHITE, 0.012);
    for (const z of [zA, zB]) slab(gel, xa, xb + 0.02, F - 0.005, h - 0.04, z, z + (z === zA ? 0.03 : -0.03), COL.white, 0.006);
  }
  for (const z of [zA - 0.02, zB + 0.02]) {
    const a = V(FST_X0 - 0.05, F + 0.9, z);
    const b = V(FST_X1, ROOF_Y + 0.88, z);
    tube(metal, [a, b], 0.017, 8, COL.steel, true);
    rod(metal, V(FST_X0 - 0.05, F, z), a, 0.017, 8, COL.steel);
  }
  return { locker, pump };
}

function buildFlybridge(gel: Part, wood: Part, metal: Part, cloth: Part, decal: Part, glass: Part): THREE.Box3 {
  const Y = ROOF_Y;
  const rh = 0.88;
  // rails all round, open at the top of the stairs
  const corners = [V(FLY_X0, Y, FST_Z1 + 0.05), V(FLY_X0, Y, FLY_Z), V(FLY_X1, Y, FLY_Z), V(FLY_X1, Y, -FLY_Z), V(FLY_X0, Y, -FLY_Z)];
  for (const h of [rh, 0.45]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < corners.length - 1; i++) {
      const a = corners[i];
      const b = corners[i + 1];
      for (let t = 0; t < 1; t += 0.25) pts.push(a.clone().lerp(b, t).add(V(0, h, 0)));
    }
    pts.push(corners[corners.length - 1].clone().add(V(0, h, 0)));
    tube(metal, curve(pts, 60), 0.018, 8, COL.steel, true);
  }
  for (let i = 0; i < corners.length - 1; i++) {
    const a = corners[i];
    const b = corners[i + 1];
    const n = Math.max(1, Math.round(a.distanceTo(b) / 1.0));
    for (let j = i === 0 ? 0 : 1; j <= n; j++) {
      const q = a.clone().lerp(b, j / n);
      rod(metal, q, q.clone().add(V(0, rh, 0)), 0.016, 8, COL.steel);
    }
  }
  // the helm: pedestal, compass, helm seat and the engine levers' console (the wheel and levers move)
  const h0 = metal.nv;
  const px = WHEEL_C.x + 0.13;
  rod(metal, V(px, Y, WHEEL_C.z), V(px, WHEEL_C.y + 0.12, WHEEL_C.z), 0.075, 14, COL.steel);
  metal.add(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 18), COL.steel, M(px, Y + 0.015, WHEEL_C.z));
  metal.add(roundedBox(0.16, 0.12, 0.14, 0.04, 2), COL.steel, M(WHEEL_C.x + 0.07, WHEEL_C.y, WHEEL_C.z));
  const cY = WHEEL_C.y + 0.2;
  metal.add(new THREE.CylinderGeometry(0.11, 0.09, 0.08, 18), COL.dark, M(px, cY - 0.04, WHEEL_C.z));
  const r = 0.085;
  quad(decal, V(px - r, cY + 0.004, WHEEL_C.z + r), V(px - r, cY + 0.004, WHEEL_C.z - r), V(px + r, cY + 0.004, WHEEL_C.z - r), V(px + r, cY + 0.004, WHEEL_C.z + r), V(0, 1, 0), WHITE, DEC.compass);
  glass.add(new THREE.SphereGeometry(0.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), WHITE, M(px, cY, WHEEL_C.z));
  const helm = partBox(metal, h0);
  helm.expandByPoint(V(WHEEL_C.x - 0.05, WHEEL_C.y - WHEEL_R - 0.1, WHEEL_C.z - WHEEL_R - 0.1));
  helm.expandByPoint(V(WHEEL_C.x + 0.05, WHEEL_C.y + WHEEL_R + 0.1, WHEEL_C.z + WHEEL_R + 0.1));
  slab(gel, -0.62, -0.22, Y, Y + 0.38, 0.58, 1.62, COL.white, 0.03);
  slab(cloth, -0.61, -0.23, Y + 0.38, Y + 0.46, 0.6, 1.6, COL.cushion, 0.035);
  slab(gel, -0.64, -0.56, Y + 0.38, Y + 0.95, 0.58, 1.62, COL.white, 0.02);
  cloth.add(roundedBox(0.08, 0.4, 0.96, 0.035, 2), COL.cushionLight, M(-0.53, Y + 0.7, 1.1, 0, 0, -0.1));
  slab(gel, 0.6, 0.86, Y, Y + 0.82, 1.62, 1.92, COL.white, 0.03);
  slab(metal, 0.62, 0.84, Y + 0.82, Y + 0.85, 1.64, 1.9, COL.dark, 0.01);
  // jib-sheet winches at the forward corners, the mainsheet traveller across the aft edge
  for (const k of [-1, 1]) {
    metal.add(new THREE.CylinderGeometry(0.09, 0.1, 0.06, 16), COL.steel, M(1.0, Y + 0.03, k * 2.3));
    metal.add(new THREE.CylinderGeometry(0.07, 0.08, 0.11, 16), COL.steel, M(1.0, Y + 0.115, k * 2.3));
    metal.add(new THREE.CylinderGeometry(0.05, 0.065, 0.035, 16), COL.dark, M(1.0, Y + 0.19, k * 2.3));
  }
  slab(metal, MS_X - 0.03, MS_X + 0.03, Y, Y + 0.025, -TRAV_HW - 0.05, TRAV_HW + 0.05, COL.steel, 0.008);
  void wood;
  return helm;
}

// ============================================================ rails, foredeck, rig, fittings

function buildRails(metal: Part, cloth: Part): THREE.Box3 {
  const tubeR = 0.014;
  const H = 0.65;
  const edge = (x: number) => HZ + hd(x) - 0.06;
  const stanX = [-4.85, -3.35, -1.85, -0.35, 1.15, 2.65, 4.15];
  const PULP = 5.35;
  let rodHolder = new THREE.Box3();
  for (const k of [-1, 1]) {
    for (const x of stanX) {
      const z = k * edge(x);
      rod(metal, V(x, deckH(x), z), V(x, deckH(x) + H, z), tubeR, 7, COL.steel, true);
      slab(metal, x - 0.045, x + 0.045, deckH(x), deckH(x) + 0.012, z - 0.03, z + 0.03, COL.steel, 0.004);
    }
    // bow pulpit round each bow, ending on the forward crossbeam
    const zc = k * HZ;
    const pp = [V(PULP, 0, k * edge(PULP)), V(5.9, 0, zc + k * (hd(5.9) - 0.06)), V(6.45, 0, zc + k * 0.08), V(6.55, 0, zc), V(6.45, 0, zc - k * 0.1), V(X_XBEAM + 0.05, 0, zc - k * (hd(X_XBEAM) - 0.05))];
    for (const h of [H, 0.33]) tube(metal, curve(pp.map((q) => V(q.x, deckH(q.x) + h, q.z)), 24), tubeR, 7, COL.steel, true);
    for (const q of [pp[0], pp[2], pp[5]]) rod(metal, V(q.x, deckH(q.x), q.z), V(q.x, deckH(q.x) + H, q.z), tubeR, 7, COL.steel);
    // stern hoop beside the steps, and the lifelines along the side
    const sx = X_AFTBEAM + 0.05;
    const hoop = [V(stanX[0], deckH(0) + H, k * edge(stanX[0])), V(sx, deckH(0) + H, k * edge(sx)), V(sx, deckH(0) + H, k * (HZ + 0.62)), V(sx, deckH(0), k * (HZ + 0.62))];
    tube(metal, curve(hoop, 14), tubeR, 7, COL.steel, true);
    rod(metal, V(sx, DECK_Y, k * edge(sx)), V(sx, DECK_Y + H, k * edge(sx)), tubeR, 7, COL.steel);
    const xs = [stanX[0], ...stanX.slice(1), PULP];
    for (const h of [H, 0.33]) {
      for (let i = 0; i < xs.length - 1; i++) rod(cloth, V(xs[i], deckH(xs[i]) + h, k * edge(xs[i])), V(xs[i + 1], deckH(xs[i + 1]) + h, k * edge(xs[i + 1])), 0.005, 4, COL.line);
    }
    if (k < 0) {
      // rod holder on the port hoop
      const m0 = metal.nv;
      const b = V(sx + 0.02, DECK_Y + 0.42, k * (edge(sx) + 0.04));
      rod(metal, b, b.clone().add(ROD_DIR.clone().multiplyScalar(0.25)), 0.024, 10, COL.steel, true);
      slab(metal, sx - 0.03, sx + 0.06, DECK_Y + 0.5, DECK_Y + 0.56, k * (edge(sx) + 0.05), k * (edge(sx) - 0.02), COL.steel, 0.01);
      rodHolder = partBox(metal, m0);
    }
  }
  // a lifeline across the bows, over the crossbeam
  const fz = HZ - hd(X_XBEAM) + 0.05;
  rod(cloth, V(X_XBEAM + 0.05, deckH(X_XBEAM) + H, -fz), V(X_XBEAM + 0.05, deckH(X_XBEAM) + H, fz), 0.005, 4, COL.line);
  return rodHolder;
}

const ROD_DIR = V(-0.3, 0.88, -0.36).normalize();
const MS_X = -2.36;
const TRAV_HW = 1.7;

function buildForedeck(metal: Part, wood: Part, cloth: Part, net: Part): THREE.Box3 {
  // trampoline net either side of the centre beam
  for (const k of [-1, 1]) {
    const rows: number[][] = [];
    const nx = 10;
    const nz = 8;
    for (let i = 0; i <= nx; i++) {
      const x = X_FWDDECK + 0.02 + ((X_XBEAM - X_FWDDECK - 0.04) * i) / nx;
      const zi = 0.11;
      const zo = HZ - hd(x) - 0.03;
      const row: number[] = [];
      for (let j = 0; j <= nz; j++) {
        const z = k * (zi + ((zo - zi) * j) / nz);
        row.push(net.v(x, trampolineY(x, z) - 0.006, z, V(0, 1, 0), x / 0.16, z / 0.16));
      }
      rows.push(row);
    }
    for (let i = 0; i < nx; i++) net.stitch(rows[i], rows[i + 1], false, V(0, 1, 0));
    // lacing along the edges
    const lace: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const x = X_FWDDECK + 0.02 + ((X_XBEAM - X_FWDDECK - 0.04) * i) / 12;
      lace.push(V(x, trampolineY(x, k * (HZ - hd(x) - 0.03)) + 0.01, k * (HZ - hd(x) - 0.02)));
    }
    tube(cloth, lace, 0.008, 4, COL.rope);
  }
  // windlass on the front deck, the chain along the centre beam to the roller
  slab(metal, 3.98, 4.22, DECK_Y, DECK_Y + 0.11, -0.14, 0.14, COL.dark, 0.02);
  metal.add(new THREE.CylinderGeometry(0.085, 0.085, 0.2, 16), COL.steel, M(4.1, DECK_Y + 0.2, 0, Math.PI / 2, 0, 0));
  metal.add(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 12), COL.galv, M(4.1, DECK_Y + 0.2, 0.14, Math.PI / 2, 0, 0));
  tube(cloth, [V(4.2, DECK_Y + 0.13, 0.14), V(4.4, DECK_Y + 0.02, 0.06), V(5.5, DECK_Y + 0.02, 0.04), V(X_XBEAM + 0.05, 1.74, 0.0), V(6.5, 1.79, 0)], 0.014, 5, COL.chain);
  slab(metal, X_XBEAM, 6.62, 1.72, 1.745, -0.07, 0.07, COL.steel, 0.008);
  for (const s of [-1, 1]) slab(metal, 6.42, 6.62, 1.72, 1.82, s * 0.06 - 0.004, s * 0.06 + 0.004, COL.steel, 0.003);
  metal.add(new THREE.CylinderGeometry(0.04, 0.04, 0.1, 14), COL.black, M(6.55, 1.79, 0, Math.PI / 2, 0, 0));
  // bow cleats
  for (const k of [-1, 1]) {
    const x = 5.55;
    const y = deckH(x);
    slab(metal, x - 0.1, x + 0.1, y + 0.04, y + 0.065, k * HZ - 0.018, k * HZ + 0.018, COL.steel, 0.01);
    for (const e of [-1, 1]) slab(metal, x + e * 0.05 - 0.016, x + e * 0.05 + 0.016, y, y + 0.05, k * HZ - 0.014, k * HZ + 0.014, COL.steel, 0.006);
  }
  // the planter shelf in front of the windscreen: teak top, a low fiddle rail
  const s0 = wood.nv;
  for (const k of [-1, 1]) {
    const za = k < 0 ? -SHELF_Z1 : SHELF_Z0;
    const zb = k < 0 ? -SHELF_Z0 : SHELF_Z1;
    slab(wood, SHELF_X0, SHELF_X1, DECK_Y - 0.005, SHELF_Y - 0.02, za, zb, WHITE, 0.02);
    slab(wood, SHELF_X0 - 0.01, SHELF_X1 + 0.01, SHELF_Y - 0.02, SHELF_Y, za - 0.01, zb + 0.01, WHITE, 0.008);
    slab(wood, SHELF_X1 - 0.005, SHELF_X1 + 0.015, SHELF_Y, SHELF_Y + 0.035, za, zb, WHITE, 0.006);
  }
  return partBox(wood, s0);
}

function buildRigStatic(metal: Part, cloth: Part): void {
  const y0 = ROOF_Y;
  const h = MAST_TOP - y0;
  metal.add(new THREE.CylinderGeometry(0.075, 0.11, h, 16, 1, false), COL.alu, M(MAST_X, y0 + h / 2, 0, 0, 0, 0, 1, 1, 0.66));
  slab(metal, MAST_X - 0.16, MAST_X + 0.16, y0, y0 + 0.07, -0.12, 0.12, COL.dark, 0.02);
  slab(metal, MAST_X - 0.15, MAST_X + 0.2, MAST_TOP, MAST_TOP + 0.14, -0.07, 0.07, COL.dark, 0.02);
  metal.add(new THREE.CylinderGeometry(0.03, 0.034, 0.02, 12), COL.dark, M(MAST_X, MAST_TOP + 0.15, 0));
  rod(metal, V(MAST_X - 0.1, MAST_TOP + 0.1, 0), V(MAST_X - 0.1, MAST_TOP + 1.0, 0), 0.007, 4, COL.dark);
  // two pairs of swept spreaders and the shrouds over them
  const sp = [
    { y: 9.8, half: 1.25, sweep: 0.42 },
    { y: 16.2, half: 0.82, sweep: 0.26 },
  ];
  const wire = 0.007;
  for (const k of [-1, 1]) {
    const tips = sp.map((s) => V(MAST_X - s.sweep, s.y, k * s.half));
    for (const [i, s] of sp.entries()) {
      const a = V(MAST_X - 0.05, s.y, k * 0.06);
      metal.add(roundedBox(0.08, a.distanceTo(tips[i]), 0.035, 0.014), COL.alu, between(a, tips[i]));
    }
    const plate = V(1.45, DECK_Y + 0.05, k * (HZ + 0.92));
    const cap = [V(MAST_X - 0.03, MAST_TOP - 0.3, k * 0.06), tips[1], tips[0], plate];
    for (let i = 0; i < cap.length - 1; i++) rod(metal, cap[i], cap[i + 1], wire, 4, COL.steel);
    const lower = V(2.0, DECK_Y + 0.05, k * (HZ + 0.92));
    rod(metal, V(MAST_X - 0.05, 9.6, k * 0.06), lower, wire, 4, COL.steel);
    for (const q of [plate, lower]) rod(metal, q, q.clone().add(V(0, -0.06, 0)), 0.014, 6, COL.steel, true);
  }
  rod(metal, FORE_TOP, STEM, wire, 4, COL.steel);
  metal.add(new THREE.CylinderGeometry(0.08, 0.08, 0.11, 16), COL.dark, between(STEM.clone().addScaledVector(FORE_DIR, 0.06), STEM.clone().addScaledVector(FORE_DIR, 0.17)));
  metal.add(new THREE.CylinderGeometry(0.025, 0.025, 0.14, 8), COL.steel, between(foreAt(JIB_T1).addScaledVector(FORE_DIR, 0.01), foreAt(JIB_T1).addScaledVector(FORE_DIR, 0.15)));
  // jib-sheet lead blocks on the roof's forward corners and the sheets' run back to the winches
  for (const k of [-1, 1]) {
    const lead = leadBlock(k);
    slab(metal, lead.x - 0.05, lead.x + 0.05, ROOF_Y, ROOF_Y + 0.07, lead.z - 0.03, lead.z + 0.03, COL.dark, 0.015);
    tube(cloth, curve([lead, V(1.6, ROOF_Y + 0.06, k * 2.5), V(1.04, ROOF_Y + 0.17, k * 2.36)], 8), 0.007, 4, COL.sheet);
  }
  for (const k of [-1, 1]) rod(cloth, V(MAST_X - 0.08, MAST_TOP - 0.1, k * 0.03), V(MAST_X - 0.09, ROOF_Y + 0.6, k * 0.03), 0.005, 4, COL.line);
}

function buildFittings(metal: Part, wood: Part): THREE.Box3[] {
  // tank fillers on the side decks aft of the saloon, under the roof gutters' downpipes
  const fillers: THREE.Box3[] = [];
  for (const k of [-1, 1]) {
    const m0 = metal.nv;
    const f = FILLER(k);
    metal.add(new THREE.CylinderGeometry(0.05, 0.055, 0.012, 18), COL.steel, M(f.x, DECK_Y + 0.004, f.z));
    metal.add(new THREE.CylinderGeometry(0.032, 0.032, 0.012, 14), COL.dark, M(f.x, DECK_Y + 0.012, f.z));
    fillers.push(partBox(metal, m0));
    // gutter along the roof edge and the downpipe to the filler
    const gz = k * (ROOF_Z + 0.025);
    rod(metal, V(ROOF_X0 + 0.05, ROOF_Y0 + 0.02, gz), V(ROOF_X1 - 0.1, ROOF_Y0 + 0.02, gz), 0.022, 8, COL.alu, true);
    tube(metal, curve([V(ROOF_X0 + 0.08, ROOF_Y0 + 0.01, gz), V(ROOF_X0 + 0.1, ROOF_Y0 - 0.2, gz), V(f.x, 2.3, k * (ROOF_Z + 0.04)), V(f.x, DECK_Y + 0.25, f.z - k * 0.04), V(f.x, DECK_Y + 0.03, f.z)], 14), 0.02, 8, COL.alu, true);
  }
  // the swim ladder off the starboard platform
  const zc = HZ;
  for (const s of [-1, 1]) {
    const z = zc + s * 0.17;
    tube(
      metal,
      curve([V(X_ST + 0.2, 0.35, z), V(X_ST + 0.18, 0.78, z), V(X_ST + 0.02, 0.9, z), V(X_ST - 0.1, 0.72, z), V(X_ST - 0.14, 0.2, z), V(X_ST - 0.2, -0.3, z), V(X_ST - 0.24, -0.66, z)], 24),
      0.015,
      7,
      COL.steel,
      true,
    );
  }
  for (const y of [0.1, -0.2, -0.5]) slab(wood, X_ST - 0.22 + (0.1 - y) * 0.13 - 0.04, X_ST - 0.22 + (0.1 - y) * 0.13 + 0.04, y - 0.015, y + 0.015, zc - 0.18, zc + 0.18, WHITE, 0.01);
  // hull windows (dark glass) along both outer topsides, round portlights on the inner sides
  for (const k of [-1, 1]) {
    for (const [xa, xb] of HULL_WINDOWS) hullWindow(metal, k, xa, xb, 0.42, 0.74, 1);
    hullWindow(metal, k, 2.18, 2.42, 0.42, 0.62, -1);
    // exhaust outlet near the stern
    const ex = EXHAUST(k);
    metal.add(new THREE.CylinderGeometry(0.04, 0.04, 0.02, 12), COL.dark, M(ex.x, ex.y, ex.z, Math.PI / 2, 0, 0));
    // stern cleat by the steps
    const cx = -4.95;
    const cz = k * (HZ + 0.8);
    slab(metal, cx - 0.09, cx + 0.09, DECK_Y + 0.035, DECK_Y + 0.058, cz - 0.016, cz + 0.016, COL.steel, 0.01);
    for (const e of [-1, 1]) slab(metal, cx + e * 0.045 - 0.014, cx + e * 0.045 + 0.014, DECK_Y, DECK_Y + 0.045, cz - 0.012, cz + 0.012, COL.steel, 0.005);
  }
  return fillers;
}

const HULL_WINDOWS: [number, number][] = [
  [1.55, 2.7],
  [3.55, 4.65],
];
const FILLER = (k: number) => V(-2.15, DECK_Y, k * (HZ + 0.62));
const EXHAUST = (k: number) => V(-5.45, 0.24, k * (HZ + hullHalfAt(-5.45, 0.24) + 0.004));

/** A rounded-rectangle hull window on the outer (side = 1) or inner (side = -1) topsides of hull k. */
function hullWindow(p: Part, k: number, xa: number, xb: number, ya: number, yb: number, side: number): void {
  const zc = k * HZ;
  const nx = 10;
  const ny = 4;
  const rows: number[][] = [];
  const r = Math.min(0.12, (yb - ya) / 2);
  for (let i = 0; i <= nx; i++) {
    const x = xa + ((xb - xa) * i) / nx;
    const ex = Math.min(x - xa, xb - x);
    const pinch = ex < r ? r - Math.sqrt(Math.max(0, r * r - (r - ex) * (r - ex))) : 0;
    const row: number[] = [];
    for (let j = 0; j <= ny; j++) {
      const y = ya + pinch + ((yb - ya - 2 * pinch) * j) / ny;
      const z = zc + side * k * (hullHalfAt(x, y) + 0.006);
      row.push(p.v(x, y, z, V(0, 0, side * k), 0, 0, COL.glass));
    }
    rows.push(row);
  }
  for (let i = 0; i < nx; i++) p.stitch(rows[i], rows[i + 1], false, V(0, 0, side * k));
}

// ============================================================ the moving rig

const GOOSE_X = MAST_X - 0.14;
const GOOSE_Y = 5.75;
const BOOM_END = V(-3.25, 5.95, 0);
const BOOM_MAX = 1.2;
const TACK_Y = 5.86;
const HEAD_Y = 22.7;
const HEADBOARD = 0.7;
const ROACH = 1.0;
const MAIN_CLEW = V(-3.15, 6.04, 0);
const MAIN_DEPTH = 0.1;
const STEM = V(6.5, 1.8, 0); // forestay foot, on the crossbeam's roller fitting
const FORE_TOP = V(MAST_X + 0.12, MAST_TOP - 0.35, 0);
const FORE_LEN = FORE_TOP.distanceTo(STEM);
const FORE_DIR = FORE_TOP.clone().sub(STEM).normalize();
const JIB_T0 = 0.26 / FORE_LEN;
const JIB_T1 = 1 - 1.1 / FORE_LEN;
const JIB_FOOT = 4.4;
const JIB_DEPTH = 0.12;
const JIB_MAX = 1.1;
const RUDDER_MAX = 0.6;
const RUDDER_X = -5.5; // rudder stocks
const PROP_HUB = (k: number) => V(-3.12, -0.92, k * HZ);
const WHEEL_TURNS = 4; // wheel radians per rudder radian
const TRAP_C = V(-5.55, -1.0, HZ + 1.55);
const TRAP_SIZE = V(0.5, 0.3, 0.34);
const STERN_CLEAT = V(-4.95, DECK_Y, HZ + 0.8);

function foreAt(t: number): THREE.Vector3 {
  return STEM.clone().addScaledVector(FORE_DIR, t * FORE_LEN);
}
function leadBlock(k: number): THREE.Vector3 {
  return V(2.1, ROOF_Y + 0.05, k * 2.85);
}
function mastAftX(y: number): number {
  const t = clamp((y - ROOF_Y) / (MAST_TOP - ROOF_Y), 0, 1);
  return MAST_X - (0.11 - 0.035 * t);
}
function boomY(x: number): number {
  return GOOSE_Y + ((BOOM_END.y - GOOSE_Y) * (GOOSE_X - x)) / (GOOSE_X - BOOM_END.x);
}
function onBoom(x: number, y: number, b: number): THREE.Vector3 {
  const dx = x - GOOSE_X;
  return V(GOOSE_X + dx * Math.cos(b), y, -dx * Math.sin(b));
}
function boomMatrix(b: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(GOOSE_X, 0, 0).multiply(new THREE.Matrix4().makeRotationY(b)).multiply(new THREE.Matrix4().makeTranslation(-GOOSE_X, 0, 0));
}
const sideOf = (a: number) => (a < -0.01 ? -1 : 1);

interface RigState {
  sail: number;
  boom: number;
  jib: number;
  fill: number;
  time: number;
  rudder: number;
  anchored: boolean;
  throttle: number;
  motorTime: number;
  propAngle: number;
  hatch: number;
  pump: number;
  bilge: number;
  awning: number;
  awningBig: boolean;
  trap: boolean;
  rod: boolean;
}

/** Mainsail and jib as two cloth grids, reshaped on the CPU (as on the sloop, sized for the cat). */
class CatSails {
  static readonly NUM = 12;
  static readonly NVM = 28;
  static readonly NUJ = 10;
  static readonly NVJ = 24;
  readonly geometry = new THREE.BufferGeometry();
  readonly triangles: number;
  readonly mainHead = new THREE.Vector3();
  readonly jibClew = new THREE.Vector3();
  private pos: Float32Array;
  private uv: Float32Array;
  private jibStart: number;
  constructor() {
    const nm = (CatSails.NUM + 1) * (CatSails.NVM + 1);
    const nj = (CatSails.NUJ + 1) * (CatSails.NVJ + 1);
    this.jibStart = nm;
    this.pos = new Float32Array((nm + nj) * 3);
    this.uv = new Float32Array((nm + nj) * 2);
    const idx: number[] = [];
    const grid = (base: number, nu: number, nv: number) => {
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const a = base + j * (nu + 1) + i;
          idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1);
        }
      }
    };
    grid(0, CatSails.NUM, CatSails.NVM);
    grid(nm, CatSails.NUJ, CatSails.NVJ);
    this.triangles = idx.length / 3;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array((nm + nj) * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(idx);
    this.geometry.boundingSphere = new THREE.Sphere(V(1.0, 13.5, 0), 14);
  }
  update(st: RigState): void {
    const s = Math.max(st.sail, 0.02);
    const lf = st.fill < 0.6 ? (0.6 - st.fill) / 0.6 : 0;
    const fill = clamp(st.fill, 0, 1);
    const P = this.pos;
    const U = this.uv;
    {
      const side = sideOf(st.boom);
      const headY = TACK_Y + s * (HEAD_Y - TACK_Y);
      const hx = mastAftX(headY) - HEADBOARD * s;
      const lx = hx - MAIN_CLEW.x;
      const ly = headY - MAIN_CLEW.y;
      const ll = Math.hypot(lx, ly);
      const rnx = -ly / ll;
      const rny = lx / ll;
      const twist = 0.22 * (0.5 + 0.5 * fill);
      for (let j = 0; j <= CatSails.NVM; j++) {
        const v = j / CatSails.NVM;
        const yL = TACK_Y + v * (headY - TACK_Y);
        const Lx = mastAftX(yL) - 0.008;
        const roach = ROACH * s * Math.pow(Math.sin(Math.PI * Math.min(1, v * 1.05)), 0.8);
        const Ex = MAIN_CLEW.x + v * lx + rnx * roach;
        const Ey = MAIN_CLEW.y + v * ly + rny * roach;
        const ang = st.boom + side * twist * Math.pow(v, 1.5);
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const chord = Math.hypot(Ex - Lx, Ey - yL);
        const g = smooth01(v / 0.1) * (1 - 0.3 * v);
        for (let i = 0; i <= CatSails.NUM; i++) {
          const u = i / CatSails.NUM;
          const dx = (Ex - Lx) * u;
          const y = yL + (Ey - yL) * u;
          let off = fill * MAIN_DEPTH * chord * Math.sin(Math.PI * Math.pow(u, 0.85)) * g * side;
          if (lf > 0) off += lf * 0.12 * Math.sqrt(chord) * Math.pow(u, 0.6) * (0.35 + 0.65 * Math.sin(Math.PI * v)) * smooth01(v / 0.06) * flap(u, v, st.time);
          const o = (j * (CatSails.NUM + 1) + i) * 3;
          P[o] = Lx + dx * ca + off * sa;
          P[o + 1] = y;
          P[o + 2] = -dx * sa + off * ca;
          const t = (j * (CatSails.NUM + 1) + i) * 2;
          U[t] = 0.01 + 0.47 * u;
          U[t + 1] = 1 - s + s * v;
        }
      }
      this.mainHead.set(mastAftX(headY), headY, 0);
    }
    {
      const side = sideOf(st.jib);
      const j = st.jib;
      const tack = foreAt(JIB_T0);
      const head = foreAt(JIB_T1);
      const full = V(tack.x - JIB_FOOT * Math.cos(j), tack.y + 0.7 + 0.3 * Math.abs(Math.sin(j)), JIB_FOOT * Math.sin(j));
      const clew = tack.clone().lerp(full, s);
      this.jibClew.copy(clew);
      const rolled = Math.pow(1 - st.sail, 0.8);
      const L = new THREE.Vector3();
      const E = new THREE.Vector3();
      const C = new THREE.Vector3();
      const n = new THREE.Vector3();
      for (let jv = 0; jv <= CatSails.NVJ; jv++) {
        const v = jv / CatSails.NVJ;
        const r = 0.02 + (0.01 + 0.11 * Math.pow(1 - v, 1.3)) * rolled;
        L.copy(foreAt(JIB_T0 + (JIB_T1 - JIB_T0) * v));
        L.z += side * r;
        E.copy(clew).lerp(head, v);
        E.lerp(L, 0.03 * Math.sin(Math.PI * v) * s);
        C.copy(E).sub(L);
        const chord = C.length();
        n.copy(FORE_DIR).cross(C);
        if (n.lengthSq() < 1e-10) n.set(0, 0, side);
        n.normalize();
        if (n.z * side < 0) n.negate();
        for (let i = 0; i <= CatSails.NUJ; i++) {
          const u = i / CatSails.NUJ;
          let off = fill * JIB_DEPTH * chord * Math.sin(Math.PI * Math.pow(u, 0.9)) * (1 - 0.25 * v);
          if (lf > 0) off += lf * 0.1 * Math.sqrt(chord) * Math.pow(u, 0.6) * (0.4 + 0.6 * Math.sin(Math.PI * v)) * flap(u, v + 0.5, st.time * 1.15);
          const o = (this.jibStart + jv * (CatSails.NUJ + 1) + i) * 3;
          P[o] = L.x + C.x * u + n.x * off;
          P[o + 1] = L.y + C.y * u + n.y * off;
          P[o + 2] = L.z + C.z * u + n.z * off;
          const t = (this.jibStart + jv * (CatSails.NUJ + 1) + i) * 2;
          U[t] = 0.52 + 0.47 * (1 - s + s * u);
          U[t + 1] = v;
        }
      }
    }
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('uv').needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
}

/** The stack pack (lazy bag) on the boom, boom amidships: zipped shut over the flaked main. */
function stackPack(p: Part, main: RGB, edge: RGB): void {
  const v0 = p.nv;
  const i0 = p.idx.length;
  const NL = 40;
  const K = 16;
  const rings: number[][] = [];
  const xa = GOOSE_X - 0.05;
  const xb = BOOM_END.x + 0.12;
  for (let i = 0; i <= NL; i++) {
    const s = i / NL;
    const x = xa + (xb - xa) * s;
    const by = boomY(x) + 0.05;
    let h = 0.5 - 0.2 * s + 0.12 * Math.max(0, 1 - s / 0.05) ** 2;
    let w = 0.42 - 0.12 * s;
    h *= 1 + 0.02 * Math.sin(s * 53 + 1);
    w *= 1 + 0.04 * Math.sin(s * 53) + 0.015 * Math.sin(s * 131);
    const endR = s > 0.97 ? Math.sqrt(Math.max(0, 1 - ((s - 0.97) / 0.03) ** 2)) : 1;
    const ring: number[] = [];
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2;
      const z = (w / 2) * Math.sin(a) * (0.82 + 0.18 * Math.sin(a / 2)) * endR;
      const y = by - 0.04 + (h / 2) * (1 - Math.cos(a)) * (0.25 + 0.75 * endR);
      ring.push(p.v(x, y, z, null, 0, 0, Math.cos(a) > 0.82 || Math.abs(Math.cos(a) + 1) < 0.02 ? edge : main));
    }
    rings.push(ring);
  }
  for (let i = 0; i < NL; i++) p.stitch(rings[i], rings[i + 1], true, (q) => V(0, q.y - (boomY(q.x) + 0.2), q.z));
  let ex = 0;
  let ey = 0;
  for (const k of rings[NL]) {
    ex += p.pos[k * 3];
    ey += p.pos[k * 3 + 1];
  }
  p.fan(p.v(ex / K - 0.005, ey / K, 0, null, 0, 0, main), rings[NL], true, V(-1, 0, 0));
  p.fan(p.v(xa + 0.02, GOOSE_Y + 0.3, 0, null, 0, 0, main), rings[0], true, V(1, 0, 0));
  p.smoothNormals(v0, i0);
}

function jibRoll(p: Part, sail: number): void {
  const v0 = p.nv;
  const i0 = p.idx.length;
  const N = FORE_DIR.clone().cross(V(0, 0, 1)).normalize();
  const B = FORE_DIR.clone().cross(N);
  const NL = 64;
  const K = 10;
  const turns = 22;
  const rolled = Math.pow(1 - clamp(sail, 0, 1), 0.8);
  const rings: number[][] = [];
  for (let i = 0; i <= NL; i++) {
    const e = i / NL;
    const c = foreAt(JIB_T0 + (JIB_T1 - JIB_T0) * e);
    let r = 0.03 + 0.12 * Math.pow(1 - e, 1.3);
    r = 0.02 + (r - 0.02) * rolled;
    if (e < 0.03) r *= 0.6 + 0.4 * (e / 0.03);
    if (e > 0.985) r *= Math.max(0.15, 1 - (e - 0.985) / 0.015);
    const ring: number[] = [];
    for (let k = 0; k <= K; k++) {
      const a = (k / K) * Math.PI * 2;
      const ph = (((k / K - turns * e) % 1) + 1) % 1;
      const rr = r * (1 + 0.05 * rolled * Math.cos(ph * Math.PI * 2));
      const d = N.clone().multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
      ring.push(p.v(c.x + d.x * rr, c.y + d.y * rr, c.z + d.z * rr, null, 0, 0, ph < 0.88 ? COL.uv : ph < 0.95 ? COL.uvLight : COL.sailShade));
    }
    rings.push(ring);
  }
  const axis = (q: THREE.Vector3) => {
    const t = q.clone().sub(STEM).dot(FORE_DIR);
    return q.clone().sub(STEM.clone().addScaledVector(FORE_DIR, t));
  };
  for (let i = 0; i < NL; i++) p.stitch(rings[i], rings[i + 1], false, axis);
  p.smoothNormals(v0, i0);
}

function anchorChain(p: Part): void {
  const rode = curve([V(6.55, 1.83, 0), V(6.66, 1.74, 0), V(7.0, 1.25, 0.02), V(7.7, 0.35, 0.06), V(8.9, -0.6, 0.14), V(10.6, -1.5, 0.24), V(12.0, -2.1, 0.3)], 48);
  tube(p, rode, (s) => 0.016 * (s > 0.9 ? Math.max(0.05, (1 - s) / 0.1) : 1), 5, COL.chain);
}

function stowedAnchor(p: Part): void {
  const crown = V(6.72, 1.74, 0);
  const tip = V(6.66, 1.32, 0);
  p.add(roundedBox(0.36, 0.04, 0.045, 0.014), COL.galv, M(6.52, 1.84, 0, 0, 0, -0.18));
  const shade: RGB = [COL.galv[0] * 0.8, COL.galv[1] * 0.8, COL.galv[2] * 0.8];
  for (const k of [-1, 1]) {
    const wing = crown.clone().lerp(tip, 0.3).add(V(-0.1, 0.02, k * 0.18));
    const n = tip.clone().sub(crown).cross(wing.clone().sub(crown)).normalize();
    if (n.z * k < 0) n.negate();
    const t = n.clone().multiplyScalar(-0.014);
    const tri = [crown, tip, wing];
    const f = tri.map((q) => p.v(q.x, q.y, q.z, n, 0, 0, COL.galv));
    const nb = n.clone().negate();
    const b = tri.map((q) => p.v(q.x + t.x, q.y + t.y, q.z + t.z, nb, 0, 0, shade));
    p.tri(f[0], f[1], f[2], n);
    p.tri(b[0], b[1], b[2], nb);
    for (let e = 0; e < 3; e++) {
      const a0 = tri[e];
      const a1 = tri[(e + 1) % 3];
      const en = a0.clone().add(a1).multiplyScalar(0.5).sub(crown.clone().add(tip).add(wing).multiplyScalar(1 / 3)).normalize();
      const q = [a0, a1, a1.clone().add(t), a0.clone().add(t)].map((r) => p.v(r.x, r.y, r.z, en, 0, 0, shade));
      p.tri(q[0], q[1], q[2], en);
      p.tri(q[0], q[2], q[3], en);
    }
  }
  p.add(roundedBox(0.06, 0.06, 0.06, 0.016), COL.galv, M(crown.x - 0.01, crown.y + 0.01, 0));
}

function trapFrame(p: Part): void {
  const rnd = mulberry32(42);
  const h = TRAP_SIZE.clone().multiplyScalar(0.5);
  const c = TRAP_C;
  const bar = (a: THREE.Vector3, b: THREE.Vector3) => {
    const j = () => (rnd() - 0.5) * 0.012;
    const a2 = a.clone().add(V(j(), j(), j()));
    const b2 = b.clone().add(V(j(), j(), j()));
    p.add(roundedBox(0.03, a2.distanceTo(b2) + 0.03, 0.026, 0.008), DRIFTWOOD, between(a2, b2).multiply(M(0, 0, 0, 0, rnd() * 3, 0)));
  };
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) bar(V(c.x - h.x, c.y + sy * h.y, c.z + sz * h.z), V(c.x + h.x, c.y + sy * h.y, c.z + sz * h.z));
    for (const sx of [-1, 1]) bar(V(c.x + sx * h.x, c.y + sy * h.y, c.z - h.z), V(c.x + sx * h.x, c.y + sy * h.y, c.z + h.z));
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(V(c.x + sx * h.x, c.y - h.y, c.z + sz * h.z), V(c.x + sx * h.x, c.y + h.y, c.z + sz * h.z));
}

function trapNet(p: Part): void {
  const c = TRAP_C;
  const h = TRAP_SIZE.clone().multiplyScalar(0.5);
  const strand = (a: THREE.Vector3, b: THREE.Vector3) => rod(p, a, b, 0.0035, 3, COL.net);
  for (let i = 1; i <= 3; i++) {
    const x = c.x - h.x + (2 * h.x * i) / 4;
    const y = c.y - h.y + (2 * h.y * i) / 4;
    const z = c.z - h.z + (2 * h.z * i) / 4;
    for (const s of [-1, 1]) {
      strand(V(x, c.y - h.y, c.z + s * h.z), V(x, c.y + h.y, c.z + s * h.z));
      strand(V(x, c.y + s * h.y, c.z - h.z), V(x, c.y + s * h.y, c.z + h.z));
      strand(V(c.x - h.x, y, c.z + s * h.z), V(c.x + h.x, y, c.z + s * h.z));
      strand(V(c.x + s * h.x, y, c.z - h.z), V(c.x + s * h.x, y, c.z + h.z));
      strand(V(c.x - h.x, c.y + s * h.y, z), V(c.x + h.x, c.y + s * h.y, z));
      strand(V(c.x + s * h.x, c.y - h.y, z), V(c.x + s * h.x, c.y + h.y, z));
    }
  }
  const ring = V(c.x, c.y + h.y + 0.2, c.z);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) rod(p, ring, V(c.x + sx * h.x, c.y + h.y, c.z + sz * h.z), 0.004, 3, COL.rope);
  const cleat = STERN_CLEAT.clone().add(V(0, 0.05, 0));
  const edge = V(STERN_CLEAT.x - 0.02, DECK_Y + 0.05, HZ + hd(STERN_CLEAT.x) + 0.01);
  tube(p, curve([ring, V(c.x + 0.15, 0.1, c.z - 0.15), V(edge.x, 0.9, edge.z + 0.12), edge, cleat], 18), 0.007, 4, COL.rope);
}

function rodBase(): THREE.Vector3 {
  const sx = X_AFTBEAM + 0.05;
  return V(sx + 0.02, DECK_Y + 0.42, -(HZ + hd(sx) - 0.06 + 0.04)).addScaledVector(ROD_DIR, 0.03);
}
function rodWood(p: Part): void {
  const butt = rodBase();
  tube(p, [butt, butt.clone().addScaledVector(ROD_DIR, 0.5)], 0.017, 10, CORK, true);
  const b0 = butt.clone().addScaledVector(ROD_DIR, 0.5);
  const tip = butt.clone().addScaledVector(ROD_DIR, 2.0);
  tube(p, [b0, b0.clone().lerp(tip, 0.5), tip], (t) => 0.009 - 0.0065 * t, 6, COL.rodBlank, true);
}
function rodReel(p: Part): void {
  const butt = rodBase();
  const d = ROD_DIR;
  const out = V(0, 0, -1).sub(d.clone().multiplyScalar(-d.z)).normalize();
  const seat = butt.clone().addScaledVector(d, 0.42);
  const body = seat.clone().addScaledVector(out, 0.06);
  rod(p, seat, body, 0.006, 6, COL.dark);
  p.add(new THREE.CylinderGeometry(0.032, 0.032, 0.036, 14), COL.dark, between(body.clone().addScaledVector(d, -0.018), body.clone().addScaledVector(d, 0.018)));
  p.add(new THREE.CylinderGeometry(0.026, 0.028, 0.03, 14), COL.reel, between(body.clone().addScaledVector(d, 0.018), body.clone().addScaledVector(d, 0.048)));
  rod(p, body.clone().addScaledVector(d, 0.048), butt.clone().addScaledVector(d, 2.0).addScaledVector(out, 0.008), 0.0015, 3, COL.line);
  const keeper = butt.clone().addScaledVector(d, 0.56).addScaledVector(out, 0.015);
  p.add(new THREE.CapsuleGeometry(0.009, 0.04, 2, 6), COL.flagA, between(keeper, keeper.clone().addScaledVector(d, -0.05)));
}

/** The canvas rain catcher over the cockpit (the upgrade): a dished cloth under the roof's edge, a funnel and hose to the starboard filler. */
function canvasCatcher(p: Part, shown: number, clothBox: THREE.Box3): void {
  const s = clamp(shown, 0.02, 1);
  const x1 = ROOF_X0 - 0.03;
  const x0 = x1 - 2.45 * s;
  const z0 = -1.8;
  const z1 = 2.3;
  const funnel = V(x1 - 1.3 * s, 0, 1.0);
  const yAt = (x: number, z: number) => {
    const u = (x - x0) / Math.max(0.01, x1 - x0);
    const w = (z - z0) / (z1 - z0);
    let y = 3.5 + 0.06 * u - 0.12 * Math.sin(Math.PI * u) * Math.sin(Math.PI * w) * s;
    y -= 0.1 * s * Math.exp(-((x - funnel.x) ** 2 + (z - funnel.z) ** 2) / 0.05);
    return y;
  };
  clothBox.makeEmpty();
  const NX = 9;
  const NZ = 12;
  for (const face of [1, -1]) {
    const v0 = p.nv;
    const i0 = p.idx.length;
    const rows: number[][] = [];
    for (let i = 0; i <= NX; i++) {
      const x = x0 + ((x1 - x0) * i) / NX;
      const row: number[] = [];
      for (let k = 0; k <= NZ; k++) {
        const z = z0 + ((z1 - z0) * k) / NZ;
        const hem = i === 0 || i === NX || k === 0 || k === NZ;
        const y = yAt(x, z) + face * 0.002;
        row.push(p.v(x, y, z, null, 0, 0, hem ? COL.canvasHem : COL.canvas));
        clothBox.expandByPoint(V(x, y, z));
      }
      rows.push(row);
    }
    for (let i = 0; i < NX; i++) p.stitch(rows[i], rows[i + 1], false, V(0, face, 0));
    p.smoothNormals(v0, i0);
  }
  const low = yAt(funnel.x, funnel.z);
  p.add(new THREE.CylinderGeometry(0.06, 0.016, 0.09, 10), COL.funnel, M(funnel.x, low - 0.045, funnel.z));
  clothBox.expandByPoint(V(funnel.x, low - 0.09, funnel.z));
  const f = FILLER(1);
  tube(p, curve([V(funnel.x, low - 0.09, funnel.z), V(funnel.x + 0.2, 2.9, 2.0), V(f.x - 0.1, 2.2, f.z - 0.05), V(f.x, DECK_Y + 0.03, f.z)], 14), 0.012, 6, COL.hose);
  for (const [x, z, tx, tz] of [
    [x0, z0, X_AFTBEAM + 0.05, -(HZ + 0.62)],
    [x0, z1, X_AFTBEAM + 0.05, HZ + 0.62],
  ])
    rod(p, V(x, yAt(x, z), z), V(tx, DECK_Y + 0.65, tz), 0.004, 3, COL.line);
}

// ---------------------------------------------------------------- lamps

type LampKind = 'anchor' | 'side' | 'stern' | 'interior' | 'daylight';
interface Lamp {
  kind: LampKind;
  day: RGB;
  lit: RGB;
  radius: number;
  lens: [number, number];
  halo: number;
}

/** Navigation lights, the warm lamps inside and the daylight in the hull windows: lenses plus glow discs, one unlit mesh. */
class Glow {
  readonly mesh: THREE.Mesh;
  readonly triangles: number;
  private lamps: Lamp[] = [];
  private col: THREE.BufferAttribute;
  private halo: THREE.BufferAttribute;
  mode: 'anchor' | 'underway' = 'anchor';
  night = 0;
  interior = false;
  constructor() {
    const pos: number[] = [];
    const nrm: number[] = [];
    const col: number[] = [];
    const halo: number[] = [];
    const idx: number[] = [];
    const lensOf = (p: Part, c: RGB): [number, number] => {
      const start = pos.length / 3;
      for (let i = 0; i < p.nv; i++) {
        pos.push(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]);
        nrm.push(p.nrm[i * 3], p.nrm[i * 3 + 1], p.nrm[i * 3 + 2]);
        col.push(c[0], c[1], c[2], 1);
        halo.push(0, 0, 0, -2);
      }
      for (const i of p.idx) idx.push(start + i);
      return [start, p.nv];
    };
    const addLamp = (kind: LampKind, centre: THREE.Vector3, facing: THREE.Vector3, cosHalf: number, lens: Part, day: RGB, lit: RGB, radius: number) => {
      const range = lensOf(lens, day);
      const h = pos.length / 3;
      for (const [cx, cy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        pos.push(centre.x, centre.y, centre.z);
        nrm.push(facing.x, facing.y, facing.z);
        col.push(lit[0] * 1.8, lit[1] * 1.8, lit[2] * 1.8, 0.85);
        halo.push(cx, cy, 0, cosHalf);
      }
      this.lamps.push({ kind, day, lit, radius, lens: range, halo: h });
    };
    const geo = (g: THREE.BufferGeometry, m: THREE.Matrix4) => {
      const p = new Part();
      p.add(g, WHITE, m);
      return p;
    };
    const white: RGB = [1, 0.96, 0.86];
    const frosted: RGB = [0.78, 0.78, 0.74];
    const top = V(MAST_X, MAST_TOP + 0.2, 0);
    addLamp('anchor', top, V(0, 1, 0), -2, geo(new THREE.CapsuleGeometry(0.03, 0.04, 3, 10), M(top.x, top.y, top.z)), frosted, white, 0.32);
    for (const k of [-1, 1]) {
      const x = 5.9;
      const c = V(x, deckH(x) + 0.58, k * (HZ + hd(x) - 0.02));
      const facing = V(Math.cos(0.95), 0, k * Math.sin(0.95));
      addLamp('side', c, facing, Math.cos(1.03), geo(roundedBox(0.07, 0.05, 0.035, 0.012), M(c.x, c.y, c.z)), k < 0 ? [0.42, 0.05, 0.04] : [0.03, 0.3, 0.1], k < 0 ? [1, 0.1, 0.06] : [0.08, 1, 0.32], 0.3);
      const st = V(X_AFTBEAM + 0.01, DECK_Y + 0.58, k * (HZ + 0.62));
      addLamp('stern', st, V(-1, 0, 0), Math.cos(1.18), geo(roundedBox(0.035, 0.045, 0.07, 0.012), M(st.x, st.y, st.z)), frosted, white, 0.28);
    }
    const warm: RGB = [1, 0.62, 0.3];
    const lampOff: RGB = [0.86, 0.83, 0.75];
    const ceilingLamp = (x: number, y: number, z: number, r = 0.08) => addLamp('interior', V(x, y - 0.03, z), V(0, -1, 0), -2, geo(new THREE.CylinderGeometry(r, r * 0.85, 0.035, 14), M(x, y - 0.018, z)), lampOff, warm, 0.34);
    for (const [x, z] of [
      [-0.45, 0],
      [0.9, 0],
      [2.05, 0],
      [2.4, -2.4],
      [2.95, 2.25],
      [-1.9, 0],
    ])
      ceilingLamp(x, ROOF_Y0, z);
    for (const k of [-1, 1]) {
      ceilingLamp(2.1, HCEIL_Y, k * HZ);
      ceilingLamp(4.2, HCEIL_Y, k * HZ, 0.06);
    }
    // daylight in the hull windows, seen from inside
    const sky: RGB = [0.7, 0.86, 0.97];
    const panel = (k: number, xa: number, xb: number, ya: number, yb: number, side: number) => {
      const p = new Part();
      const zc = k * HZ;
      const rows: number[][] = [];
      for (let i = 0; i <= 8; i++) {
        const x = xa + ((xb - xa) * i) / 8;
        const row: number[] = [];
        for (let j = 0; j <= 3; j++) {
          const y = ya + ((yb - ya) * j) / 3;
          row.push(p.v(x, y, zc + side * k * (hullHalfAt(x, y) - LINING - 0.006), V(0, 0, -side * k)));
        }
        rows.push(row);
      }
      for (let i = 0; i < 8; i++) p.stitch(rows[i], rows[i + 1], false, V(0, 0, -side * k));
      addLamp('daylight', V((xa + xb) / 2, (ya + yb) / 2, zc), V(0, 0, -side * k), -2, p, sky, sky, 0);
    };
    for (const k of [-1, 1]) {
      for (const [xa, xb] of HULL_WINDOWS) panel(k, xa + 0.05, xb - 0.05, 0.46, 0.7, 1);
      panel(k, 2.2, 2.4, 0.45, 0.59, -1);
    }
    for (const l of this.lamps) idx.push(l.halo, l.halo + 1, l.halo + 2, l.halo, l.halo + 2, l.halo + 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    this.col = new THREE.Float32BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    this.halo = new THREE.Float32BufferAttribute(halo, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('color', this.col);
    g.setAttribute('halo', this.halo);
    g.setIndex(idx);
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius += 2;
    this.triangles = idx.length / 3;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader =
        'attribute vec4 halo;\nvarying vec3 vHalo;\n' +
        sh.vertexShader.replace(
          '#include <project_vertex>',
          `#include <project_vertex>
  vHalo = vec3(halo.xy, halo.z > 0.0 ? 1.0 : 0.0);
  if (halo.z > 0.0) {
    float vis = 1.0;
    if (halo.w > -1.5) vis = smoothstep(halo.w - 0.05, halo.w + 0.05, dot(normalize(normalMatrix * normal), normalize(-mvPosition.xyz)));
    mvPosition.xy += halo.xy * halo.z * vis * max(1.0, -mvPosition.z / 12.0);
    gl_Position = projectionMatrix * mvPosition;
  }`,
        );
      sh.fragmentShader =
        'varying vec3 vHalo;\n' +
        sh.fragmentShader.replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  if (vHalo.z > 0.5) diffuseColor.a *= pow(max(0.0, 1.0 - length(vHalo.xy)), 2.2);`,
        );
    };
    mat.customProgramCacheKey = () => 'cat-glow-v1';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'cat-lights';
    this.mesh.renderOrder = 2;
    this.set('anchor', 0);
  }
  isOn(kind: LampKind): boolean {
    if (kind === 'interior') return this.interior;
    if (kind === 'daylight') return true;
    return this.night > 0.001 && (this.mode === 'anchor' ? kind === 'anchor' : kind === 'side' || kind === 'stern');
  }
  set(mode: 'anchor' | 'underway', night: number): void {
    this.mode = mode;
    this.night = clamp(night, 0, 1);
    const n = this.night;
    const C = this.col.array as Float32Array;
    const H = this.halo.array as Float32Array;
    for (const l of this.lamps) {
      const on = this.isOn(l.kind);
      let rgbOut: RGB;
      let halo = 0;
      if (l.kind === 'daylight') {
        const d = 1 - 0.93 * n;
        rgbOut = [l.day[0] * d, l.day[1] * d, l.day[2] * d];
      } else if (l.kind === 'interior') {
        const k = on ? 0.45 + 0.55 * n : 0;
        const glow = 0.9 + 0.9 * n;
        const dim = 1 - 0.75 * n;
        rgbOut = [0, 1, 2].map((c) => l.day[c] * dim * (1 - k) + l.lit[c] * glow * k) as RGB;
        halo = on ? l.radius * (0.3 + 0.7 * n) : 0;
      } else {
        const k = on ? n : 0;
        const glow = 1 + 3 * n;
        const dim = 1 - 0.8 * n;
        rgbOut = [0, 1, 2].map((c) => l.day[c] * dim * (1 - k) + l.lit[c] * glow * k) as RGB;
        halo = on ? l.radius * n : 0;
      }
      for (let i = l.lens[0]; i < l.lens[0] + l.lens[1]; i++) for (let c = 0; c < 3; c++) C[i * 4 + c] = rgbOut[c];
      for (let i = l.halo; i < l.halo + 4; i++) H[i * 4 + 2] = halo;
    }
    this.col.needsUpdate = true;
    this.halo.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- materials

function hullBandGlsl(): string {
  const lin = (hex: number) => {
    const c = new THREE.Color(hex);
    return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
  };
  const f = (n: number) => n.toFixed(4);
  return `  float hy = vBoatPos.y;
  float aa = max(fwidth(hy), 0.0008);
  float hx = clamp(vBoatPos.x, ${f(X_ST)}, ${f(X_BW)});
  float htop = hx >= ${f(X_AFTBEAM)} ? (hx > ${f(X_FWDDECK)} ? ${f(DECK_Y)} + 0.28 * pow((hx - ${f(X_FWDDECK)}) / ${f(X_BW - X_FWDDECK)}, 2.0) : ${f(DECK_Y)}) : 0.36 + ${f(DECK_Y - 0.36)} * ((hx - ${f(X_ST)}) / ${f(X_AFTBEAM - X_ST)});
  float hdown = htop - hy;
  float hBottom = 1.0 - smoothstep(0.04 - aa, 0.04 + aa, hy);
  float hBoot = smoothstep(0.04 - aa, 0.04 + aa, hy) - smoothstep(0.13 - aa, 0.13 + aa, hy);
  float hSheer = smoothstep(0.09 - aa, 0.09 + aa, hdown) - smoothstep(0.17 - aa, 0.17 + aa, hdown);
  float hPin = smoothstep(0.21 - aa, 0.21 + aa, hdown) - smoothstep(0.226 - aa, 0.226 + aa, hdown);
  vec3 hc = ${lin(COL.hull)};
  hc = mix(hc, ${lin(COL.stripe)}, clamp(hBoot + hSheer + hPin, 0.0, 1.0));
  hc = mix(hc, ${lin(COL.bottom)}, hBottom);`;
}

function hullMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vBoatPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBoatPos = transformed;');
    sh.fragmentShader =
      'varying vec3 vBoatPos;\n' +
      sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>\n${hullBandGlsl()}\n  diffuseColor.rgb *= hc;`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.75, hBottom);');
  };
  mat.customProgramCacheKey = () => 'cat-hull-v1';
  return mat;
}

/** Varnished wood that can also be painted like the hull (PAINTED vertex colour) or show bare grain (blue + 2). */
function woodworkMaterial(tex: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, roughness: 0.3, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vBoatPos;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBoatPos = transformed;');
    sh.fragmentShader =
      'varying vec3 vBoatPos;\n' +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  float hPainted = vColor.g > 1.5 ? 1.0 : 0.0;
  float hGrain = (1.0 - hPainted) * (vColor.b > 1.5 ? 1.0 : 0.0);
${hullBandGlsl()}
  vec3 hTint = vColor.rgb - vec3(0.0, 0.0, 2.0);
  vec3 hGrey = vec3(dot(diffuseColor.rgb / max(vColor.rgb, vec3(0.001)), vec3(0.3, 0.59, 0.11)) / 0.22) * hTint;
  diffuseColor.rgb = mix(diffuseColor.rgb, hGrey, hGrain);
  diffuseColor.rgb = mix(diffuseColor.rgb, hc, hPainted);`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.75, hBottom * hPainted);');
  };
  mat.customProgramCacheKey = () => 'cat-woodwork-v1';
  return mat;
}

/** A depth material that draws nothing: glass, glows, water and netting cast no shadows even with castShadow on. */
const noShadow = () => new THREE.MeshDepthMaterial({ transparent: true, opacity: 0, alphaTest: 0.5 });

let textures: { teak: THREE.DataTexture; varnish: THREE.DataTexture; nonskid: THREE.DataTexture; sail: THREE.DataTexture; decal: THREE.DataTexture; net: THREE.DataTexture } | null = null;

// ---------------------------------------------------------------- assembling the moving parts

function buildMovingRig(mats: { metal: THREE.Material; cloth: THREE.Material; glass: THREE.Material; cabin: THREE.MeshStandardMaterial }, varnishTex: THREE.Texture, glass: DynPart): { objects: THREE.Object3D[]; rig: CatRig; triangles: number } {
  const st: RigState = { sail: 0, boom: 0, jib: 0, fill: 1, time: 0, rudder: 0, anchored: true, throttle: 0, motorTime: NaN, propAngle: 0, hatch: 1, pump: 0, bilge: 0, awning: 0, awningBig: false, trap: false, rod: true };
  doorState.open = st.hatch;

  // boom: its own group, swinging about the gooseneck
  const boomPart = new Part();
  const boomA = V(GOOSE_X, GOOSE_Y, 0);
  boomPart.add(new THREE.CylinderGeometry(0.08, 0.08, boomA.distanceTo(BOOM_END), 16, 1, false), COL.alu, between(boomA, BOOM_END).multiply(M(0, 0, 0, 0, 0, 0, 1, 1, 0.72)));
  boomPart.add(roundedBox(0.13, 0.12, 0.1, 0.02), COL.dark, M(GOOSE_X + 0.03, GOOSE_Y, 0));
  boomPart.add(roundedBox(0.14, 0.18, 0.12, 0.03), COL.dark, M(BOOM_END.x, BOOM_END.y, 0));
  rod(boomPart, V(MAST_X - 0.1, ROOF_Y + 0.5, 0), V(GOOSE_X - 1.0, boomY(GOOSE_X - 1.0) - 0.06, 0), 0.022, 8, COL.alu);
  boomPart.add(roundedBox(0.06, 0.08, 0.06, 0.02), COL.dark, M(MS_X, boomY(MS_X) - 0.12, 0));
  for (let i = 0; i < boomPart.pos.length; i += 3) boomPart.pos[i] -= GOOSE_X;
  const boomMesh = new THREE.Mesh(boomPart.geometry(), mats.metal);
  boomMesh.name = 'cat-boom';
  const boomGroup = new THREE.Group();
  boomGroup.name = 'cat-boom-pivot';
  boomGroup.position.set(GOOSE_X, 0, 0);
  boomGroup.add(boomMesh);

  // soft parts: stack pack, flaked main, rolled jib, sheets, lines, anchor chain, trap net, reel, canvas catcher
  const sails = new CatSails();
  const lines = new DynPart(V(0, 2.5, 0));
  const segPack = lines.rigid((p) => stackPack(p, COL.cover, COL.coverEdge));
  const segBag = lines.rigid((p) => stackPack(p, COL.cover, COL.coverEdge));
  const segBundle = lines.rigid((p) => stackPack(p, COL.sail, COL.sailShade));
  const segRoll = lines.gen((p) => jibRoll(p, st.sail));
  const sheetCtrl = (side: number): THREE.Vector3[] => {
    const lead = leadBlock(side);
    const clew = sails.jibClew;
    const k = smooth01(st.sail / 0.25);
    const lee = sideOf(st.jib) === side;
    const a = clew.clone().add(V(-0.06 * (1 - k), 0, side * 0.08 * (1 - k)));
    const m0 = V(4.4, 2.2, side * 0.9);
    const m1 = lee ? clew.clone().lerp(lead, 0.5).add(V(0, -0.05, 0)) : V((clew.x + lead.x) / 2, 2.6, side * 1.0);
    return [a, m0.lerp(m1, k), lead];
  };
  const sheetBuild = (side: number) => (p: Part) => tube(p, curve(sheetCtrl(side), 16), 0.008, 4, COL.sheet);
  sails.update(st);
  const segSheets = [lines.gen(sheetBuild(-1)), lines.gen(sheetBuild(1))];
  const liftBuild = (p: Part) => rod(p, V(MAST_X - 0.12, MAST_TOP - 0.05, 0), onBoom(BOOM_END.x + 0.05, BOOM_END.y + 0.06, st.boom), 0.004, 4, COL.line);
  const segLift = lines.gen(liftBuild);
  const msBlock = () => onBoom(MS_X, boomY(MS_X) - 0.17, st.boom);
  const carZ = () => clamp(msBlock().z, -TRAV_HW, TRAV_HW);
  const msBuild = (p: Part) => {
    const top = msBlock();
    const car = V(MS_X, ROOF_Y + 0.09, carZ());
    for (const dx of [-0.016, 0, 0.016]) rod(p, top.clone().add(V(dx, 0, 0)), car.clone().add(V(dx * 1.2, 0, 0)), 0.005, 4, COL.sheet);
  };
  const segMainsheet = lines.gen(msBuild);
  const segCar = lines.rigid((p) => {
    p.add(roundedBox(0.08, 0.03, 0.08, 0.01), COL.dark, M(MS_X, ROOF_Y + 0.035, 0));
    p.add(roundedBox(0.06, 0.06, 0.05, 0.02), COL.dark, M(MS_X, ROOF_Y + 0.075, 0));
  });
  const segRode = lines.rigid(anchorChain);
  const segAnchor = lines.rigid(stowedAnchor);
  const segTrapNet = lines.rigid(trapNet);
  const segReel = lines.rigid(rodReel);
  const canvasBox = new THREE.Box3();
  const canvasBuild = (p: Part) => canvasCatcher(p, st.awning, canvasBox);
  const segCanvas = lines.gen((p) => canvasCatcher(p, 1, canvasBox));
  const linesGeom = lines.part.geometry();
  lines.bind(linesGeom);
  linesGeom.boundingSphere = new THREE.Sphere(V(2, 10, 0), 16);
  const linesMesh = new THREE.Mesh(linesGeom, mats.cloth);
  linesMesh.name = 'cat-rig-lines';

  const sailMat = new THREE.MeshStandardMaterial({ map: textures?.sail ?? null, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  const sailMesh = new THREE.Mesh(sails.geometry, sailMat);
  sailMesh.name = 'cat-sails';

  // woodwork that moves: both rudders (painted like the hulls), the wheel, the trap's frame, the rod
  const wood = new DynPart(V(0, 2.5, 0));
  const segRudders = [-1, 1].map((k) =>
    wood.rigid((p) => {
      const t = new Part();
      foilLoft(
        t,
        [
          { y: -0.3, xLE: -5.38, chord: 0.5, half: 0.036 },
          { y: -0.55, xLE: -5.38, chord: 0.58, half: 0.042 },
          { y: -0.95, xLE: -5.41, chord: 0.55, half: 0.04 },
          { y: -1.1, xLE: -5.44, chord: 0.47, half: 0.03 },
          { y: -1.15, xLE: -5.47, chord: 0.38, half: 0 },
        ],
        8,
        PAINTED,
      );
      addPart(p, t, M(0, 0, k * HZ));
    }),
  );
  const segWheel = wood.rigid((p) => {
    const c = WHEEL_C;
    p.add(new THREE.TorusGeometry(WHEEL_R, 0.026, 8, 32), WHITE, M(c.x, c.y, c.z, 0, Math.PI / 2, 0));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const d = V(0, Math.cos(a), Math.sin(a));
      tube(p, [c.clone().addScaledVector(d, 0.05), c.clone().addScaledVector(d, WHEEL_R + 0.03)], 0.014, 6, WHITE);
      const h0 = c.clone().addScaledVector(d, WHEEL_R + 0.03);
      tube(p, [h0, c.clone().addScaledVector(d, WHEEL_R + 0.13)], (s) => 0.018 + 0.006 * Math.sin(Math.PI * s), 6, WHITE, true);
    }
    p.add(new THREE.CylinderGeometry(0.06, 0.06, 0.07, 14), BRASS, M(c.x - 0.02, c.y, c.z, 0, 0, Math.PI / 2));
  });
  const segTrapFrame = wood.rigid(trapFrame);
  const segRod = wood.rigid(rodWood);
  const woodGeom = wood.part.geometry();
  wood.bind(woodGeom);
  woodGeom.boundingSphere = new THREE.Sphere(V(-2.5, 1.5, 0), 6.5);
  const woodMesh = new THREE.Mesh(woodGeom, woodworkMaterial(varnishTex));
  woodMesh.name = 'cat-woodwork';

  // metal that moves: propellers, the door frames, pump handle, engine levers
  const steel = new DynPart(V(0, 2.5, 0));
  const segProps = [-1, 1].map((k) =>
    steel.rigid((p) => {
      const hub = PROP_HUB(k);
      p.add(new THREE.CylinderGeometry(0.045, 0.055, 0.12, 12), COL.prop, M(hub.x, hub.y, hub.z, 0, 0, Math.PI / 2));
      p.add(new THREE.SphereGeometry(0.045, 10, 6), COL.prop, M(hub.x - 0.06, hub.y, hub.z));
      for (let b = 0; b < 3; b++) {
        const m = new THREE.Matrix4()
          .makeTranslation(hub.x, hub.y, hub.z)
          .multiply(new THREE.Matrix4().makeRotationX((b * 2 * Math.PI) / 3))
          .multiply(new THREE.Matrix4().makeRotationY(0.55))
          .multiply(new THREE.Matrix4().makeTranslation(0, 0.12, 0))
          .multiply(new THREE.Matrix4().makeScale(0.016, 0.12, 0.075));
        p.add(new THREE.SphereGeometry(1, 10, 6), COL.prop, m);
      }
    }),
  );
  const DX = SAL_X0 + 0.11;
  const doorZ = (k: number): [number, number] => (k < 0 ? [-DOOR_Z, 0.02] : [-0.02, DOOR_Z]);
  const segDoorFrames = [-1, 1].map((k) =>
    steel.rigid((p) => {
      const [za, zb] = doorZ(k);
      const y0 = DECK_Y + 0.01;
      const y1 = WIN_Y - 0.01;
      slab(p, DX - 0.02, DX + 0.02, y0, y0 + 0.06, za, zb, COL.dark, 0.008);
      slab(p, DX - 0.02, DX + 0.02, y1 - 0.05, y1, za, zb, COL.dark, 0.008);
      slab(p, DX - 0.02, DX + 0.02, y0, y1, za, za + 0.045, COL.dark, 0.008);
      slab(p, DX - 0.02, DX + 0.02, y0, y1, zb - 0.045, zb, COL.dark, 0.008);
      const hz = k < 0 ? zb - 0.1 : za + 0.1;
      rod(p, V(DX - 0.04, 2.2, hz), V(DX - 0.04, 2.6, hz), 0.012, 6, COL.steel, true);
    }),
  );
  const segDoorGlass = [-1, 1].map((k) =>
    glass.rigid((p) => {
      const [za, zb] = doorZ(k);
      quad(p, V(DX, DECK_Y + 0.07, za + 0.04), V(DX, DECK_Y + 0.07, zb - 0.04), V(DX, WIN_Y - 0.06, zb - 0.04), V(DX, WIN_Y - 0.06, za + 0.04), V(-1, 0, 0));
    }),
  );
  const pumpPivot = V(PUMP_C.x - 0.08, PUMP_C.y + 0.17, PUMP_C.z);
  const segPump = steel.rigid((p) => {
    tube(p, [pumpPivot, pumpPivot.clone().add(V(-0.42, 0, 0))], 0.012, 8, COL.alu, true);
    tube(p, [pumpPivot.clone().add(V(-0.42, 0, -0.07)), pumpPivot.clone().add(V(-0.42, 0, 0.07))], 0.017, 8, COL.black, true);
  });
  const leverPivot = (i: number) => V(0.73, ROOF_Y + 0.85, 1.7 + i * 0.12);
  const segLevers = [0, 1].map((i) =>
    steel.rigid((p) => {
      const q = leverPivot(i);
      rod(p, q, q.clone().add(V(0, 0.17, 0)), 0.01, 6, COL.steel);
      p.add(new THREE.SphereGeometry(0.025, 10, 6), i === 0 ? COL.black : [0.75, 0.15, 0.1], M(q.x, q.y + 0.18, q.z));
    }),
  );
  const steelGeom = steel.part.geometry();
  steel.bind(steelGeom);
  steelGeom.boundingSphere = new THREE.Sphere(V(-1.5, 1.5, 0), 6.5);
  const steelMesh = new THREE.Mesh(steelGeom, mats.metal);
  steelMesh.name = 'cat-moving-metal';
  const glassGeom = glass.part.geometry();
  glass.bind(glassGeom);
  const glassMesh = new THREE.Mesh(glassGeom, mats.glass);
  glassMesh.name = 'cat-glass';
  glassMesh.renderOrder = 1;
  glassMesh.customDepthMaterial = noShadow();

  // water: bilge water on the hull cabin floors, rain in the gutters, exhaust bubbles
  const water = new DynPart(V(0, 2.5, 0));
  const wc: RGB = rgb(0x7fc8cf);
  const segBilge = [-1, 1].map((k) =>
    water.rigid((p) => {
      const zc = k * HZ;
      deckStrip(p, HST_X1 + 0.03, HROOM_X1 - 0.03, 6, (x) => zc - floorHalf(x) + 0.01, (x) => zc + floorHalf(x) - 0.01, 3, () => HFLOOR_Y + 0.006);
      for (let i = 0; i < p.col.length; i++) p.col[i] = wc[i % 3];
    }),
  );
  const segGutters = [-1, 1].map((k) =>
    water.rigid((p) => {
      const gz = k * (ROOF_Z + 0.025);
      rod(p, V(ROOF_X0 + 0.06, ROOF_Y0 + 0.036, gz), V(ROOF_X1 - 0.12, ROOF_Y0 + 0.036, gz), 0.013, 6, wc, true);
      const f = FILLER(k);
      p.add(new THREE.TorusGeometry(0.06, 0.008, 4, 14), [0.92, 0.96, 0.98], M(f.x, DECK_Y + 0.02, f.z, Math.PI / 2, 0, 0));
    }),
  );
  const segBubbles: number[] = [];
  for (let i = 0; i < 10; i++) segBubbles.push(water.rigid((p) => p.add(new THREE.SphereGeometry(0.045, 8, 6), [0.94, 0.97, 0.98], M(0, 0, 0))));
  const waterGeom = water.part.geometry();
  water.bind(waterGeom);
  waterGeom.boundingSphere = new THREE.Sphere(V(-1, 1.5, 0), 7.5);
  // opaque, so it's drawn before the water mask (below) and still shows in the hull cabins
  const waterMesh = new THREE.Mesh(waterGeom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.06, metalness: 0.1 }));
  waterMesh.name = 'cat-water';
  waterMesh.customDepthMaterial = noShadow();

  // The water mask: an invisible lid at the waterline inside each hull's cabins. It only writes depth, after the
  // boat's other opaque meshes (renderOrder 1), so a sea drawn after it (the game's ocean has renderOrder 2) can't
  // show inside the hulls, where the cabin floors are below the waterline.
  const mask = new Part();
  for (const k of [-1, 1]) {
    const zc = k * HZ;
    deckStrip(mask, HLIN_X0 - 0.02, HLIN_X1 + 0.02, 24, (x) => zc - Math.max(0.05, hullHalfAt(x, 0.03) - 0.025), (x) => zc + Math.max(0.05, hullHalfAt(x, 0.03) - 0.025), 2, () => 0.03);
  }
  const maskMesh = new THREE.Mesh(mask.geometry(), new THREE.MeshBasicMaterial({ colorWrite: false }));
  maskMesh.name = 'cat-water-mask';
  maskMesh.renderOrder = 1;
  maskMesh.customDepthMaterial = noShadow();

  const glow = new Glow();
  glow.mesh.customDepthMaterial = noShadow();
  const applyCabinGlow = () => {
    const n = glow.night;
    mats.cabin.emissiveIntensity = 0.1 * (1 - n) + (glow.interior ? 0.1 + 0.2 * n : 0.01);
  };
  applyCabinGlow();

  for (const m of [boomMesh, linesMesh, sailMesh, woodMesh, steelMesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }

  // ---------------------------------------------------------------- applying the state
  const boomM = () => boomMatrix(st.boom);
  const applyFurl = () => {
    lines.place(segPack, st.sail < 0.01 ? boomM() : null);
    const flat = (k: number, kz: number) => {
      const yb = GOOSE_Y + 0.05;
      return boomM()
        .multiply(new THREE.Matrix4().makeTranslation(0, yb, 0))
        .multiply(new THREE.Matrix4().makeScale(1, k, kz))
        .multiply(new THREE.Matrix4().makeTranslation(0, -yb, 0));
    };
    lines.place(segBag, st.sail >= 0.01 ? flat(0.42, 1.04) : null);
    if (st.sail >= 0.01 && st.sail < 0.985) {
      const k = Math.pow(1 - st.sail, 0.85);
      lines.place(segBundle, flat(Math.max(0.05, k * 0.85), 0.6 + 0.3 * k));
    } else lines.hide(segBundle);
    lines.regen(segLift, liftBuild, st.sail < 0.03);
  };
  const applyMainsheet = () => {
    lines.regen(segMainsheet, msBuild);
    lines.place(segCar, new THREE.Matrix4().makeTranslation(0, 0, carZ()));
  };
  const applySheets = () => {
    lines.regen(segSheets[0], sheetBuild(-1));
    lines.regen(segSheets[1], sheetBuild(1));
  };
  const applyAnchor = () => {
    lines.place(segRode, st.anchored ? new THREE.Matrix4() : null);
    lines.place(segAnchor, st.anchored ? null : new THREE.Matrix4());
  };
  const applySails = () => {
    sails.update(st);
    sailMesh.visible = st.sail > 0.005;
  };
  const applyBoom = () => {
    boomGroup.rotation.y = st.boom;
    boomGroup.updateMatrix();
  };
  const rudderMatrix = (k: number, a: number) => new THREE.Matrix4().makeTranslation(RUDDER_X, 0, k * HZ).multiply(new THREE.Matrix4().makeRotationY(a)).multiply(new THREE.Matrix4().makeTranslation(-RUDDER_X, 0, -k * HZ));
  const wheelMatrix = (a: number) => new THREE.Matrix4().makeTranslation(WHEEL_C.x, WHEEL_C.y, WHEEL_C.z).multiply(new THREE.Matrix4().makeRotationX(a)).multiply(new THREE.Matrix4().makeTranslation(-WHEEL_C.x, -WHEEL_C.y, -WHEEL_C.z));
  const applyRudder = () => {
    [-1, 1].forEach((k, i) => wood.place(segRudders[i], rudderMatrix(k, st.rudder)));
    wood.place(segWheel, wheelMatrix(st.rudder * WHEEL_TURNS));
  };
  const applyDoor = () => {
    const e = smooth01(st.hatch);
    [-1, 1].forEach((k, i) => {
      const m = new THREE.Matrix4().makeTranslation(0, 0, k * 0.97 * e);
      steel.place(segDoorFrames[i], m);
      glass.place(segDoorGlass[i], m);
    });
    doorState.open = st.hatch;
  };
  const applyPump = () => {
    const a = (st.pump - 0.5) * 0.9;
    const P = pumpPivot;
    steel.place(segPump, new THREE.Matrix4().makeTranslation(P.x, P.y, P.z).multiply(new THREE.Matrix4().makeRotationZ(-a)).multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z)));
  };
  const applyMotor = () => {
    [-1, 1].forEach((k, i) => {
      const h = PROP_HUB(k);
      steel.place(segProps[i], new THREE.Matrix4().makeTranslation(h.x, h.y, h.z).multiply(new THREE.Matrix4().makeRotationX(st.propAngle * k)).multiply(new THREE.Matrix4().makeTranslation(-h.x, -h.y, -h.z)));
    });
    segLevers.forEach((sg, i) => {
      const q = leverPivot(i);
      steel.place(sg, new THREE.Matrix4().makeTranslation(q.x, q.y, q.z).multiply(new THREE.Matrix4().makeRotationZ(-0.7 * st.throttle)).multiply(new THREE.Matrix4().makeTranslation(-q.x, -q.y, -q.z)));
    });
    const running = Math.abs(st.throttle) > 0.01;
    const t = st.motorTime || 0;
    segBubbles.forEach((sg, i) => {
      if (!running) return water.hide(sg);
      const k = i < 5 ? -1 : 1;
      const ph = (((t * 1.4 + (i % 5) / 5) % 1) + 1) % 1;
      const ex = EXHAUST(k);
      const s = (0.5 + 0.9 * ph) * (0.5 + 0.5 * Math.abs(st.throttle)) * (1 - ph * 0.6);
      water.place(sg, new THREE.Matrix4().makeTranslation(ex.x - 0.15 - 0.6 * ph, ex.y - 0.17 + 0.12 * ph, ex.z + k * (0.05 + 0.2 * ph)).multiply(new THREE.Matrix4().makeScale(s, s * 0.7, s)));
    });
  };
  const applyBilge = () => {
    const show = st.bilge > 0.6;
    const k = clamp((st.bilge - 0.6) / 0.4, 0, 1);
    const t = st.time;
    [-1, 1].forEach((side, i) => {
      if (!show) return water.hide(segBilge[i]);
      const c = V((HST_X1 + HROOM_X1) / 2, HFLOOR_Y, side * HZ);
      const m = new THREE.Matrix4()
        .makeTranslation(c.x, c.y + 0.01 + 0.07 * k, c.z)
        .multiply(new THREE.Matrix4().makeRotationZ(0.012 * Math.sin(t * 1.5 + i)))
        .multiply(new THREE.Matrix4().makeRotationX(0.02 * Math.sin(t * 1.9 + 1 + i)))
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
      water.place(segBilge[i], m);
    });
  };
  const applyAwning = () => {
    const shown = st.awning > 0.02;
    segGutters.forEach((sg) => water.place(sg, shown ? new THREE.Matrix4() : null));
    lines.regen(segCanvas, canvasBuild, shown && st.awningBig);
  };
  const applyTrap = () => {
    const m = st.trap ? new THREE.Matrix4() : null;
    wood.place(segTrapFrame, m);
    lines.place(segTrapNet, m);
  };
  const applyRod = () => {
    const m = st.rod ? new THREE.Matrix4() : null;
    wood.place(segRod, m);
    lines.place(segReel, m);
  };
  applyFurl();
  applyMainsheet();
  applySheets();
  applyAnchor();
  applySails();
  applyBoom();
  applyRudder();
  applyDoor();
  applyPump();
  applyMotor();
  applyBilge();
  applyAwning();
  applyTrap();
  applyRod();

  const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const rig: CatRig = {
    setSail(amount) {
      const a = clamp(amount, 0, 1);
      if (same(a, st.sail)) return;
      st.sail = a;
      applySails();
      applyFurl();
      lines.regen(segRoll, (p) => jibRoll(p, st.sail));
      applySheets();
    },
    setBoom(angle) {
      const a = clamp(angle, -BOOM_MAX, BOOM_MAX);
      if (same(a, st.boom)) return;
      st.boom = a;
      applyBoom();
      applyFurl();
      applyMainsheet();
      if (st.sail > 0.005) applySails();
    },
    setJib(angle) {
      const a = clamp(angle, -JIB_MAX, JIB_MAX);
      if (same(a, st.jib)) return;
      st.jib = a;
      applySails();
      applySheets();
    },
    setFill(fill, time) {
      const f = clamp(fill, 0, 1);
      const changed = !same(f, st.fill) || (f < 0.6 && !same(time, st.time));
      st.fill = f;
      st.time = time;
      if (changed && st.sail > 0.005) applySails();
      if (st.bilge > 0.6) applyBilge();
    },
    setRudder(angle) {
      const a = clamp(angle, -RUDDER_MAX, RUDDER_MAX);
      if (same(a, st.rudder)) return;
      st.rudder = a;
      applyRudder();
    },
    setAnchored(down) {
      if (down === st.anchored) return;
      st.anchored = down;
      applyAnchor();
    },
    setMotor(throttle, time) {
      const dt = Number.isFinite(st.motorTime) ? clamp(time - st.motorTime, 0, 0.1) : 0;
      st.motorTime = time;
      const before = st.throttle;
      st.throttle = clamp(throttle, -1, 1);
      st.propAngle = (st.propAngle + dt * st.throttle * 30) % (Math.PI * 2);
      if (Math.abs(st.throttle) > 0.01 || !same(before, st.throttle)) applyMotor();
    },
    setLights(mode, night) {
      const n = clamp(night, 0, 1);
      if (mode === glow.mode && same(n, glow.night)) return;
      glow.set(mode, n);
      applyCabinGlow();
    },
    setHatch(open) {
      const a = clamp(open, 0, 1);
      if (same(a, st.hatch)) return;
      st.hatch = a;
      applyDoor();
    },
    setGalleyLight(on) {
      if (on === glow.interior) return;
      glow.interior = on;
      glow.set(glow.mode, glow.night);
      applyCabinGlow();
    },
    setPump(stroke) {
      const a = clamp(stroke, 0, 1);
      if (same(a, st.pump)) return;
      st.pump = a;
      applyPump();
    },
    setBilge(level, time) {
      const a = clamp(level, 0, 1);
      if (time !== undefined) st.time = time;
      if (same(a, st.bilge) && time === undefined) return;
      st.bilge = a;
      applyBilge();
    },
    setAwning(shown, big) {
      const a = clamp(shown, 0, 1);
      if (same(a, st.awning) && big === st.awningBig) return;
      st.awning = a;
      st.awningBig = big;
      applyAwning();
    },
    setTrap(set) {
      if (set === st.trap) return;
      st.trap = set;
      applyTrap();
    },
    setRodStowed(shown) {
      if (shown === st.rod) return;
      st.rod = shown;
      applyRod();
    },
    status() {
      const te = [-1, 1].map((k) => V(-5.93, -0.8, k * HZ).applyMatrix4(rudderMatrix(k, st.rudder))) as [THREE.Vector3, THREE.Vector3];
      const props = [-1, 1].map((k) => PROP_HUB(k)) as [THREE.Vector3, THREE.Vector3];
      return {
        sail: st.sail,
        boom: st.boom,
        jib: st.jib,
        fill: st.fill,
        rudder: st.rudder,
        anchored: st.anchored,
        coverShown: st.sail < 0.01,
        mainShown: st.sail > 0.005,
        jibShown: st.sail > 0.005,
        rodeShown: st.anchored,
        anchorStowedShown: !st.anchored,
        boomEnd: onBoom(BOOM_END.x, BOOM_END.y, st.boom),
        mainHead: sails.mainHead.clone(),
        jibClew: sails.jibClew.clone(),
        rudderTrailingEdges: te,
        rudderTrailingEdge: te[1].clone(),
        wheelAngle: st.rudder * WHEEL_TURNS,
        throttle: st.throttle,
        propTips: props,
        propTip: props[1].clone(),
        propAngle: st.propAngle,
        lights: { mode: glow.mode, night: glow.night, anchorOn: glow.isOn('anchor'), sidelightsOn: glow.isOn('side'), sternOn: glow.isOn('stern'), interiorOn: glow.interior },
        hatchOpen: st.hatch,
        galleyLight: glow.interior,
        pumpStroke: st.pump,
        bilge: st.bilge,
        awning: { shown: st.awning, big: st.awningBig, clothBox: st.awning > 0.02 && st.awningBig ? canvasBox.clone() : null },
        trapSet: st.trap,
        rodStowed: st.rod,
      };
    },
  };
  const triangles = (boomPart.idx.length + lines.part.idx.length + wood.part.idx.length + steel.part.idx.length + glass.part.idx.length + water.part.idx.length) / 3 + sails.triangles + glow.triangles;
  return { objects: [boomGroup, linesMesh, sailMesh, woodMesh, steelMesh, glassMesh, waterMesh, glow.mesh, maskMesh], rig, triangles: triangles + mask.idx.length / 3 };
}

// ============================================================ assembly

export function createCatamaran(): Catamaran {
  const hull = new Part();
  const gel = new Part();
  const nonskid = new Part();
  const teak = new Part();
  const wood = new Part();
  const metal = new Part();
  const cloth = new Part();
  const decal = new Part();
  const net = new Part();
  const glass = new DynPart(V(0, 2.5, 0));

  for (const k of [-1, 1]) buildHullShell(hull, k);
  buildKeelsAndLegs(hull, metal);
  buildBridgedeck(gel);
  buildDecks(teak);
  buildEdges(wood);
  buildSternSteps(gel, teak);
  buildSaloon(gel, nonskid, teak, wood, metal, glass.part);
  const saloon = buildSaloonInterior(gel, wood, metal, cloth, decal);
  const cabin = new Part();
  const portHull = buildHullInterior(cabin, gel, teak, wood, metal, cloth, decal, -1);
  const stbdHull = buildHullInterior(cabin, gel, teak, wood, metal, cloth, decal, 1);
  const cockpit = buildCockpit(gel, wood, metal, cloth);
  const helm = buildFlybridge(gel, wood, metal, cloth, decal, glass.part);
  const rodHolder = buildRails(metal, cloth);
  const potShelf = buildForedeck(metal, wood, cloth, net);
  buildRigStatic(metal, cloth);
  const fillers = buildFittings(metal, wood);

  textures ??= { teak: paintTeak(), varnish: paintVarnish(), nonskid: paintNonSkid(), sail: paintSail(), decal: paintDecals(), net: paintNet() };
  const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.85 });
  const clothMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  // The hull cabins' lining glows faintly warm: daylight through the windows by day, the lamps at night.
  const cabinMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, emissive: 0xffc184, emissiveIntensity: 0.1 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1f3a44, transparent: true, opacity: 0.42, roughness: 0.04, metalness: 0.25, side: THREE.DoubleSide, depthWrite: false });
  const parts: [Part, THREE.Material, string][] = [
    [hull, hullMaterial(), 'cat-hulls'],
    [gel, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 }), 'cat-gelcoat'],
    [cabin, cabinMat, 'cat-cabins'],
    [nonskid, new THREE.MeshStandardMaterial({ map: textures.nonskid, roughness: 0.7, metalness: 0 }), 'cat-nonskid'],
    [teak, new THREE.MeshStandardMaterial({ vertexColors: true, map: textures.teak, roughness: 0.8, metalness: 0 }), 'cat-teak'],
    [wood, new THREE.MeshStandardMaterial({ vertexColors: true, map: textures.varnish, roughness: 0.3, metalness: 0 }), 'cat-varnish'],
    [metal, metalMat, 'cat-metal'],
    [cloth, clothMat, 'cat-cloth'],
    [decal, new THREE.MeshStandardMaterial({ map: textures.decal, roughness: 0.85, metalness: 0 }), 'cat-decals'],
    [net, new THREE.MeshStandardMaterial({ map: textures.net, transparent: true, alphaTest: 0.04, side: THREE.DoubleSide, depthWrite: false, roughness: 0.9, metalness: 0 }), 'cat-trampoline'],
  ];
  const group = new THREE.Group();
  group.name = 'catamaran';
  let triangles = 0;
  for (const [part, mat, name] of parts) {
    const mesh = new THREE.Mesh(part.geometry(), mat);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (name === 'cat-trampoline') mesh.customDepthMaterial = noShadow();
    group.add(mesh);
    triangles += part.idx.length / 3;
  }
  const moving = buildMovingRig({ metal: metalMat, cloth: clothMat, glass: glassMat, cabin: cabinMat }, textures.varnish, glass);
  for (const o of moving.objects) group.add(o);
  triangles += moving.triangles;

  const pz = [-1.42, -0.78, 0.78, 1.42];
  const points: CatPoints = {
    ladderTop: V(-6.62, STEPS[3].y, HZ),
    ladderBottom: V(X_ST - 0.22, -0.5, HZ),
    locker: V((ABENCH_X0 + ABENCH_X1) / 2, BENCH_Y, -0.85),
    helm: V(0.15, ROOF_Y, WHEEL_C.z),
    bow: V(6.55, 1.79, 0),
    mastBase: V(MAST_X, ROOF_Y, 0),
    potShelf: pz.map((z) => V((SHELF_X0 + SHELF_X1) / 2, SHELF_Y, z)),
    spawn: V(-2.3, DECK_Y, 0),
    galley: V(2.35, DECK_Y, -1.95),
    workbench: V(2.15, HFLOOR_Y, HZ - 0.13),
    pump: V(-1.95, DECK_Y, PUMP_C.z),
    chart: V(2.3, DECK_Y, 2.2),
    bunk: V(2.95, HFLOOR_Y, -HZ),
  };
  const fittings: CatFittings = {
    workbench: stbdHull.workbench ?? new THREE.Box3(),
    pump: cockpit.pump,
    rodHolder,
    fillers,
    galley: saloon.galley,
    chartTable: saloon.chart,
    bunk: portHull.bunk,
    helm,
    potShelf,
    locker: cockpit.locker,
  };
  return { group, deck: CAT_DECK, points, rig: moving.rig, length: LOA, beam: 2 * (HZ + 1.0), draft: DRAFT, triangles, fittings };
}
