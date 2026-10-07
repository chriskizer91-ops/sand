/**
 * The shared vocabulary of life: species presentation, habitats, places, ages.
 * Lead-owned contract (docs/ARCHITECTURE.md). The ecology (WP-D) fills the catalogue in
 * content/species.ts; renderers (WP-F), sound (WP-G) and the journal (WP-H) read it.
 *
 * Enums are plain `as const` objects so they work across the worker and page bundles.
 */

// ---------- how life arrives ----------

/** wind: spores, dust seeds, ballooning spiders, insects. sea: floating seeds, larvae, crabs.
 *  raft: animals on storm debris. bird: seeds carried by birds. flight: animals that fly or swim here.
 *  storm: storm-blown vagrants. */
export type Road = 'wind' | 'sea' | 'raft' | 'bird' | 'flight' | 'storm';
/** The three roads of the title, for chimes and card icons. */
export type RoadFamily = 'wind' | 'wave' | 'wing';
export function roadFamily(r: Road): RoadFamily {
  return r === 'wind' || r === 'storm' ? 'wind' : r === 'sea' || r === 'raft' ? 'wave' : 'wing';
}

/** Field-guide tabs. land = reptiles, amphibians and mammals. small = insects, spiders, snails, crabs. */
export type GuideGroup = 'plants' | 'birds' | 'sea' | 'small' | 'land';

export type PlantLayer = 'ground' | 'herb' | 'shrub' | 'canopy';

// ---------- habitats (one dominant code per patch, sent to the page) ----------

export const Habitat = {
  None: 0,
  DeepSea: 1,
  OpenSea: 2,
  Reef: 3,
  Seagrass: 4,
  Lagoon: 5,
  Beach: 6,
  Dune: 7,
  RockShore: 8,
  Cliff: 9,
  BareRock: 10,
  HotLava: 11,
  Crust: 12,
  Grass: 13,
  Scrub: 14,
  Forest: 15,
  WetForest: 16,
  CloudForest: 17,
  Pond: 18,
  Marsh: 19,
  SaltPond: 20,
  Mangrove: 21,
  Stream: 22,
  Summit: 23,
  Sound: 24,
} as const;
export type Habitat = (typeof Habitat)[keyof typeof Habitat];
export const HABITAT_COUNT = 25;

export function isSeaHabitat(h: number): boolean {
  return h === Habitat.DeepSea || h === Habitat.OpenSea || h === Habitat.Reef || h === Habitat.Seagrass || h === Habitat.Lagoon || h === Habitat.Sound;
}

/** Ground under a patch, as the life simulation sees it. */
export const Substrate = {
  Sea: 0,
  Basalt: 1,
  Stone: 2,
  Limestone: 3,
  Sand: 4,
  HotLava: 5,
  Pond: 6,
} as const;
export type Substrate = (typeof Substrate)[keyof typeof Substrate];

// ---------- places, ages, firsts ----------

/** Places the island recognises as you shape it (shown as soft labels and journal entries). */
export type PlaceKind =
  | 'lava-field'
  | 'sea-cliff'
  | 'sea-stack'
  | 'beach'
  | 'turtle-beach'
  | 'dune'
  | 'rock-shore'
  | 'rock-basin'
  | 'pond'
  | 'salt-pond'
  | 'stream'
  | 'lagoon'
  | 'reef'
  | 'seagrass'
  | 'mangrove-shore'
  | 'cloud-peak'
  | 'rain-shadow'
  | 'summit'
  | 'warm-ground'
  | 'islet'
  | 'spit'
  | 'sound';

export type AgeId = 'stone' | 'lichen' | 'green' | 'wings' | 'forest' | 'chain' | 'song';

// ---------- presentation ----------

/** Plant archetypes built by the renderer (WP-F). `Tint` = ground cover only, no model. */
export const PlantModel = {
  Tint: 0,
  Fern: 1,
  TreeFern: 2,
  Grass: 3,
  DuneGrass: 4,
  Sedge: 5,
  Vine: 6,
  Mat: 7,
  Herb: 8,
  Palm: 9,
  Pandanus: 10,
  SeaGrape: 11,
  Shrub: 12,
  Mangrove: 13,
  Fig: 14,
  PomTree: 15,
  Broadleaf: 16,
  CloudTree: 17,
  SheOak: 18,
  Cactus: 19,
  Silversword: 20,
  Seagrass: 21,
  Coral: 22,
  Lily: 23,
  Epiphyte: 24,
} as const;
export type PlantModel = (typeof PlantModel)[keyof typeof PlantModel];
export const PLANT_MODEL_COUNT = 25;

/** Which ground-cover channel a Tint plant paints (ARCHITECTURE §6.4). */
export type TintLayer = 'crust' | 'lichen' | 'moss' | 'grass' | 'algae';

export interface PlantLook {
  model: PlantModel;
  /** sRGB hex colours. */
  leaf: number;
  leaf2?: number;
  flower?: number;
  trunk?: number;
  fruit?: number;
  /** Size multiplier (1 = typical for the archetype). */
  size: number;
  /** For Tint plants. */
  tint?: TintLayer;
}

/** Animal body plans built by the renderer (WP-F). */
export const AnimalModel = {
  Seabird: 0,
  Frigatebird: 1,
  SmallBird: 2,
  Wader: 3,
  Shorebird: 4,
  Duck: 5,
  Bat: 6,
  Crab: 7,
  Lizard: 8,
  Tortoise: 9,
  SeaTurtle: 10,
  FishShoal: 11,
  Ray: 12,
  Dolphin: 13,
  Whale: 14,
  Butterfly: 15,
  Dragonfly: 16,
  Bee: 17,
  Firefly: 18,
  Seal: 19,
  Spider: 20,
  Shark: 21,
  Snail: 22,
} as const;
export type AnimalModel = (typeof AnimalModel)[keyof typeof AnimalModel];
export const ANIMAL_MODEL_COUNT = 23;

export type Behaviour =
  | 'colony' // seabirds wheeling over a colony, landing on ledges
  | 'soar' // frigatebirds kiting high
  | 'flit' // small birds hopping between crowns
  | 'wade' // herons and flamingos standing, stepping, striking
  | 'run-shore' // sandpipers following the swash
  | 'paddle' // ducks on ponds
  | 'night-fly' // bats
  | 'scuttle' // crabs
  | 'bask' // lizards
  | 'graze' // tortoises
  | 'nest-beach' // sea turtles crawling up at night
  | 'shoal' // reef fish
  | 'glide-sea' // rays, sharks, swimming turtles
  | 'porpoise' // dolphins
  | 'surface-blow' // whales
  | 'flutter' // butterflies
  | 'hover' // dragonflies
  | 'buzz' // bees at flowers
  | 'glow' // fireflies at night
  | 'haul-out' // seals resting on beaches
  | 'web' // spiders on silk
  | 'creep'; // snails on wet leaves

export interface AnimalLook {
  model: AnimalModel;
  /** Primary, secondary, accent (sRGB hex). */
  colors: [number, number, number];
  /** Body length in metres. */
  size: number;
  behaviour: Behaviour;
  active: 'day' | 'night' | 'dusk' | 'any';
  /** Habitats where agents spawn. */
  where: Habitat[];
  /** Most agents of this species shown near the camera at once (before quality scaling). */
  max: number;
  /** Typical speed (m/s). */
  speed: number;
}

export type VoiceKind =
  | 'trill'
  | 'coo'
  | 'kee'
  | 'honk'
  | 'wail'
  | 'peep'
  | 'whistle'
  | 'squawk'
  | 'hoot'
  | 'chirp'
  | 'cricket'
  | 'cicada'
  | 'frog-coqui'
  | 'frog-croak'
  | 'gecko'
  | 'bat'
  | 'whale'
  | 'seal'
  | 'buzz'
  | 'colony'
  | 'clatter'
  | 'quack'
  | 'click'
  | 'rustle';

export interface VoiceSpec {
  kind: VoiceKind;
  /** Base pitch (Hz). */
  pitch: number;
  /** Calls per minute when nearby and active. */
  rate: number;
  when: 'day' | 'night' | 'dusk' | 'dawn' | 'any';
  /** 0..1 loudness. */
  loud: number;
}

/** A visible water effect a species causes. */
export type WaterEffect = 'glow' | 'pink-pond' | 'red-pond';

export type Rarity = 'common' | 'uncommon' | 'rare';

/**
 * One species (or species group). `E` is the ecology's needs type (owned by WP-D in eco/needs.ts);
 * page code uses SpeciesDef<unknown>.
 *
 * Every species must have at least one sign: a plant model or tint, an animal look, a voice, or a water effect.
 */
export interface SpeciesDef<E = unknown> {
  /** Index into SPECIES (stable within a version; saves store keys, not ids). */
  id: number;
  key: string;
  name: string;
  sci: string;
  kind: 'plant' | 'animal';
  guide: GuideGroup;
  /** Plants: which layer they occupy (sea plants use herb = seagrass, shrub = coral, ground = coralline algae). */
  layer?: PlantLayer;
  /** Lives in the sea. */
  marine?: boolean;
  roads: Road[];
  rarity: Rarity;
  plant?: PlantLook;
  animal?: AnimalLook;
  voice?: VoiceSpec;
  effect?: WaterEffect;
  /** One true real-world fact (≤ 30 words). */
  fact: string;
  /**
   * Story lines (≤ 25 words). Placeholders: {place} (e.g. "the north shore"), {isl} (island name), {from}.
   *   arrive: first establishment. seen: visited but couldn't stay (says why in plain words).
   *   back: returned and stayed after a failed visit. lost: gone from all islands.
   */
  text: { arrive: string; seen: string; back: string; lost: string };
  /** Field-guide hints for unfound species, sharpening: [riddle, plain need, direct line]. */
  hint: [string, string, string];
  /** Short plain "needs" line for found species ("Needs a sandy beach above the waves"). */
  needs: string;
  eco: E;
}
