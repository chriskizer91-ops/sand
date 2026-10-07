/**
 * What a species needs to reach the islands and to stay (the `eco` part of SpeciesDef).
 * Lead-owned contract between the ecology engine (WP-D1, which interprets it) and the
 * catalogue (WP-D2, which fills it in for every species). See docs/ARCHITECTURE.md §4–5.
 *
 * Units: metres, years, 0..1 fractions. Optional fields mean "no requirement".
 * Plants are judged patch by patch; animals island by island (from habitat counts).
 */
import type { PlaceKind } from '../content/speciesTypes';

/** Why something couldn't stay (plain-language lines live in content/stories.ts). */
export type ReasonCode =
  | 'no-land'
  | 'no-beach'
  | 'no-dune'
  | 'no-cliff'
  | 'no-stack'
  | 'no-rock-shore'
  | 'no-soil'
  | 'thin-soil'
  | 'too-dry'
  | 'too-wet'
  | 'too-salty'
  | 'too-small'
  | 'too-low'
  | 'too-tall'
  | 'no-fresh-water'
  | 'no-salt-pond'
  | 'no-stream'
  | 'no-shelter'
  | 'no-lagoon'
  | 'no-reef'
  | 'no-seagrass'
  | 'no-mangrove'
  | 'no-open-ground'
  | 'no-grass'
  | 'no-shrubs'
  | 'no-trees'
  | 'no-forest'
  | 'no-cloud-forest'
  | 'no-flowers'
  | 'no-fruit'
  | 'no-prey'
  | 'no-host'
  | 'no-warm-ground'
  | 'no-summit'
  | 'predators'
  | 'needs-island-nearby'
  | 'too-far'
  | 'hot-lava'
  | 'needs-storm';

export interface EcoGives {
  /** Soil building (m per century at full cover). */
  soil?: number;
  /** Nitrogen fixing, 0..1 strength. */
  nitrogen?: number;
  /** Guano (seabirds), 0..1 strength. */
  guano?: number;
  /** Fruit for birds and bats, 0..1. */
  fruit?: number;
  /** Nectar/flowers for pollinators, 0..1. */
  nectar?: number;
  /** Seeds for seed-eaters, 0..1. */
  seeds?: number;
  /** Insects as food (for insect-eaters), 0..1. */
  insects?: number;
  /** Binds sand into dunes and steadies beaches, 0..1. */
  dune?: number;
  /** Shelter/nest sites for birds (trees, shrubs), 0..1. */
  nests?: number;
  /** Makes white sand (parrotfish, reef). */
  sand?: number;
}

export interface EcoNeeds {
  // ---------- getting here ----------
  /** Arrival attempts per century at a reference island (about 1 km² equivalent, high, upwind side of the zone). */
  rate: number;
  /** How well it crosses open sea from the old islands, 0..1 (spores and seabirds ~1; land snails ~0.2; frogs ~0.03). */
  reach: number;
  /** Hop distance between islands inside the zone (m) once it lives on one of them. */
  hop: number;
  /** Arrives only during or right after storms (rafts, storm-blown birds). */
  stormOnly?: boolean;

  // ---------- where it can live ----------
  /** Plants: substrates it can root in (Substrate values from speciesTypes). Default: any land substrate except hot lava. */
  substrate?: number[];
  /** Plants: soil depth in metres [minimum, comfortable]. */
  soil?: [number, number];
  /** Moisture 0..1 [min, ideal low, ideal high, max]. */
  moist?: [number, number, number, number];
  /** Highest salt spray it tolerates, 0..1. */
  saltMax?: number;
  /** Height band above sea level (m) [min, max]. */
  alt?: [number, number];
  /** Steepest slope (degrees). */
  slopeMax?: number;
  /** Marine: water depth band in metres below sea level [min, max]. */
  depth?: [number, number];
  /** Seedlings tolerate shade, 0..1. */
  shade?: number;
  /** Minimum fertility 0..1 (old soil, guano). */
  fert?: number;
  /** Plants: patch habitat must be one of these. Animals: the island must have these habitats (Habitat values). */
  habitats?: number[];
  /** Animals: at least this many suitable habitat patches on the island. */
  minPatches?: number;
  /** The island must have these recognised places. */
  places?: PlaceKind[];
  /** Species keys that must already live on the same island (food, hosts, pollinators). */
  requires?: string[];
  /** Island land area at least (m²). */
  minArea?: number;
  /** Island's highest point at most (m): low, open islands. */
  maxPeak?: number;
  /** Island's highest point at least (m). */
  minPeak?: number;
  /** Avoids islands where an egg-eating predator lives. */
  noPredators?: boolean;
  /** Is itself an egg/nest predator. */
  predator?: boolean;
  /** Needs another island within this distance (m). */
  nearIsland?: number;

  // ---------- life ----------
  /** Years from first establishment to full cover (plants) or carrying capacity (animals). */
  grow: number;
  /** Plants: lifespan in years (turnover and gaps). */
  life?: number;
  /** Plants: spread to neighbouring patches, patches per decade. */
  spread?: number;
  gives?: EcoGives;
  /** The need most often missing, used for its "couldn't stay" story and first hint. */
  mainNeed: ReasonCode;
}
