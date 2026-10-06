/**
 * Messages between the page and the engine (which may run on a background thread).
 * Lead-owned contract (docs/ARCHITECTURE.md §5). Large typed arrays are transferred.
 *
 * Coordinates: world metres for x/z in strokes, events and info.
 * `cols` rectangles are in columns (512 grid); `eco` rectangles are in patches (256 grid).
 */
import type { PaceId, Season, ToolId } from '../config';
import type { AgeId, Habitat, PlaceKind, Road, Substrate } from '../content/speciesTypes';
import type { CheckResult } from '../checks/registry';

// ---------- page -> engine ----------

export interface EngineSettings {
  pace: PaceId;
  gentleStorms: boolean;
}

/** Page state stored inside the save file header. */
export interface PageSaveHeader {
  camera: number[];
  dayPhase: number;
  /** Small UI state (seen hints, onboarding step, etc.). */
  ui?: Record<string, unknown>;
}

export type DebugOp =
  | 'advanceYears' // arg = years (runs the ecology synchronously in sub-steps)
  | 'stormNow' // start a storm warning now
  | 'stats' // performance and world stats
  | 'hash' // fingerprint of columns + patches (same world?)
  | 'pour' // scripted pour: tool at x, z, radius for `seconds` of physics, then settle
  | 'settle' // run physics until settled (or 120 s of physics)
  | 'demoChain'; // build a scripted chain of islands instantly (for screenshots and tests)

export type ToEngine =
  | { t: 'init'; save: ArrayBuffer | null; seed: number; settings: EngineSettings }
  | {
      t: 'stroke';
      phase: 'start' | 'move' | 'end' | 'cancel';
      tool: ToolId;
      x: number;
      z: number;
      radius: number;
      /** 0..1 pressure-like strength (1 normally). */
      strength: number;
    }
  /** Camera focus and sky clock, sent at about 2 Hz. */
  | { t: 'focus'; x: number; z: number; dist: number; dayPhase: number; season: Season }
  | { t: 'settings'; settings: EngineSettings }
  /** Pause the year clock and storms (page hidden, journal or menu open). Physics keeps running unless hidden. */
  | { t: 'pause'; on: boolean; hidden: boolean }
  | { t: 'undo' }
  | { t: 'inspect'; id: number; x: number; z: number }
  | { t: 'rename'; island: number; name: string }
  | { t: 'save'; id: number; header: PageSaveHeader }
  | { t: 'load'; id: number; data: ArrayBuffer }
  | { t: 'reset'; seed: number }
  | { t: 'checks'; id: number; quick: boolean }
  | { t: 'debug'; id: number; op: DebugOp; arg?: number; x?: number; z?: number; tool?: ToolId; radius?: number; seconds?: number };

// ---------- engine -> page ----------

export interface StormState {
  phase: 'none' | 'warning' | 'peak' | 'clearing';
  /** Seconds since the phase began. */
  t: number;
  /** Overall intensity for visuals and sound, 0..1 (rises in warning, 1 at peak, falls in clearing). */
  level: number;
  great: boolean;
}

export interface ArrivalEvent {
  species: number;
  road: Road;
  x: number;
  z: number;
  island: number;
  /** Stayed (true) or visited and left (false). */
  ok: boolean;
  /** First time this species ever established. */
  first: boolean;
  /** Came back after an earlier failed visit. */
  returned: boolean;
}

export interface PlaceEvent {
  kind: PlaceKind;
  x: number;
  z: number;
  island: number;
  /** First time this kind of place was recognised in this sea. */
  first: boolean;
}

export interface TickEvents {
  /** Flat x, z, strength triples where lava meets water. */
  steam: number[];
  /** The live stroke, for pour visuals and sounds. */
  pour: { tool: ToolId; x: number; y: number; z: number; r: number } | null;
  /** Molten lava area (m^2). */
  lavaArea: number;
  /** Biggest molten area: x, z, radius, strength 0..1. */
  lavaGlow: [number, number, number, number];
  /** Sand volume sliding this tick (m^3), for trickle sounds. */
  sliding: number;
  /** Rock volume placed this tick (m^3), for clatter sounds. */
  rockPlaced: number;
  /** Patches burned this tick. */
  burned: number;
  arrivals: ArrivalEvent[];
  places: PlaceEvent[];
}

export interface PerfStats {
  geoMs: number;
  ecoMs: number;
  packMs: number;
  activeLava: number;
  activeSand: number;
  activePatches: number;
  tickHz: number;
}

export interface IslandInfo {
  id: number;
  name: string;
  /** Land area in m^2. */
  area: number;
  /** Highest point (x, y, z). */
  peak: [number, number, number];
  centroid: [number, number];
  /** World bbox x0, z0, x1, z1. */
  bbox: [number, number, number, number];
  /** Year it first broke the surface. */
  founded: number;
  /** Species established on it. */
  species: number;
  /** Share of land under forest canopy, 0..1. */
  forest: number;
}

export interface PondInfo {
  id: number;
  /** Water surface height (m). */
  level: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  salt: boolean;
}

export interface PeakInfo {
  x: number;
  z: number;
  h: number;
  /** Tall enough to catch a cloud cap. */
  cap: boolean;
}

export interface PopInfo {
  species: number;
  island: number;
  /** Relative abundance 0..1 (1 = at carrying capacity of a large island). */
  n: number;
}

export interface ColonyInfo {
  species: number;
  x: number;
  z: number;
  r: number;
  n: number;
}

export interface SoundInfo {
  x: number;
  z: number;
  r: number;
  dolphins: boolean;
  whales: boolean;
}

export interface LifeInfo {
  islands: IslandInfo[];
  ponds: PondInfo[];
  peaks: PeakInfo[];
  pops: PopInfo[];
  colonies: ColonyInfo[];
  sound: SoundInfo | null;
  /** Species ever established (found) and total in the catalogue. */
  found: number;
  total: number;
  age: AgeId;
  /** The whale ending has happened. */
  ending: boolean;
}

export type JournalKind =
  | 'first-land'
  | 'new-island'
  | 'islands-joined'
  | 'island-lost'
  | 'arrival'
  | 'visit'
  | 'return'
  | 'lost'
  | 'storm'
  | 'place'
  | 'first'
  | 'age'
  | 'moment'
  | 'milestone'
  | 'lava-buried'
  | 'hint'
  | 'ending';

export interface JournalEntry {
  id: number;
  year: number;
  kind: JournalKind;
  species?: number;
  island?: number;
  x?: number;
  z?: number;
  road?: Road;
  place?: PlaceKind;
  age?: AgeId;
  /** Key of a "first" stamp (e.g. 'first-tree'), see content/stories.ts. */
  first?: string;
  params?: Record<string, string | number>;
  /** Show as a card (otherwise journal only). */
  headline: boolean;
}

export interface InspectInfo {
  x: number;
  z: number;
  island: number;
  islandName: string;
  /** Visible surface height (m). */
  height: number;
  /** Water depth if under water, else 0. */
  depth: number;
  substrate: Substrate;
  /** Years since this ground formed or was last reshaped. */
  groundAge: number;
  /** 0..1 */
  rain: number;
  moist: number;
  salt: number;
  /** Soil depth (m). */
  soil: number;
  /** -1 lee .. 1 windward */
  windward: number;
  habitat: Habitat;
  /** Species ids per layer (-1 = none). */
  layers: { canopy: number; shrub: number; herb: number; ground: number };
  /** Optional plain reason something can't grow here yet (from ecology). */
  why?: string;
}

/** Bytes per patch in the eco `plants` array: canopySp, canopyCov, shrubSp, shrubCov, herbSp, herbCov. Species byte = id + 1 (0 = none). */
export const PLANT_BYTES = 6;

export type FromEngine =
  | { t: 'hello' }
  | { t: 'progress'; done: number; total: number }
  | { t: 'ready'; resumed: boolean; year: number; firstLand: boolean; glow: { x: number; z: number }; header?: PageSaveHeader }
  | { t: 'cols'; x0: number; z0: number; w: number; h: number; surf: Float32Array; ground: Uint8Array }
  | {
      t: 'eco';
      x0: number;
      z0: number;
      w: number;
      h: number;
      /** RGBA8 per patch: lichen/crust, moss, grass/herb, forest floor. */
      a: Uint8Array;
      /** RGBA8 per patch: weathering/soil, guano, moisture, burn. */
      b: Uint8Array;
      /** RGBA8 per patch: coral, seagrass, coralline/reef crest, stream/marsh water. */
      c: Uint8Array;
      /** PLANT_BYTES per patch. */
      plants: Uint8Array;
      /** Habitat code per patch. */
      habitat: Uint8Array;
    }
  | { t: 'life'; life: LifeInfo }
  | { t: 'journal'; entries: JournalEntry[]; reset?: boolean }
  | { t: 'tick'; year: number; firstLand: boolean; paused: boolean; storm: StormState; events: TickEvents; undo: number; perf: PerfStats }
  | { t: 'inspected'; id: number; info: InspectInfo }
  | { t: 'saved'; id: number; data: ArrayBuffer | null; error?: string }
  | { t: 'loaded'; id: number; ok: boolean; error?: string; header?: PageSaveHeader }
  /** The world was replaced (load or reset): drop mirrors; full resend follows, then `ready`. */
  | { t: 'clear' }
  | { t: 'checks'; id: number; results: CheckResult[] }
  | { t: 'debugResult'; id: number; data: unknown }
  | { t: 'error'; message: string };
