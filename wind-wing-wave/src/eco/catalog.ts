/**
 * The species catalogue compiled into flat typed arrays, so the patch sweep can test
 * "could this species live here?" without touching objects (ARCHITECTURE §7: no
 * allocations in hot paths).
 *
 * This is where src/eco/needs.ts (EcoNeeds, the contract with the catalogue) is
 * interpreted. The rules, in plain words:
 * - Optional needs mean "no requirement".
 * - Plants are judged patch by patch; animals island by island.
 * - Marine plants (coral, seagrass, coralline algae, mangrove) read `substrate` as the sea
 *   BOTTOM material (Basalt/Stone/Limestone = hard bottom, Sand = soft bottom; Sea = any).
 * - `alt` is height above sea level of the patch; `depth` is water depth (marine only).
 * - A plant's `habitats` are matched against what the ground offers (beach, dune, cliff,
 *   pond, reef zone…) plus the vegetation of the patch and its neighbours (forest, scrub…),
 *   so a plant that needs forest can spread along a forest edge.
 */
import { AnimalModel, Habitat, PlantModel, type PlaceKind, type Road, type SpeciesDef } from '../content/speciesTypes';
import type { EcoNeeds, ReasonCode } from './needs';
import { L_CANOPY, L_GROUND, L_HERB, L_SHRUB } from './fields';
import { growRate } from './maths';

/** Every PlaceKind, in a fixed order (bit index = position). */
export const PLACE_KINDS: readonly PlaceKind[] = [
  'lava-field', 'sea-cliff', 'sea-stack', 'beach', 'turtle-beach', 'dune', 'rock-shore', 'rock-basin', 'pond', 'salt-pond', 'stream',
  'lagoon', 'reef', 'seagrass', 'mangrove-shore', 'cloud-peak', 'rain-shadow', 'summit', 'warm-ground', 'islet', 'spit', 'sound',
];
export function placeBit(k: PlaceKind): number {
  return 1 << PLACE_KINDS.indexOf(k);
}

export const ROADS: readonly Road[] = ['wind', 'sea', 'raft', 'bird', 'flight', 'storm'];
export const RoadBit = { wind: 1, sea: 2, raft: 4, bird: 8, flight: 16, storm: 32 } as const;

/** Substrate bits (1 << Substrate value). */
const SUB_SEA = 1 << 0;
const SUB_BASALT = 1 << 1;
const SUB_STONE = 1 << 2;
const SUB_LIME = 1 << 3;
const SUB_SAND = 1 << 4;
const SUB_POND = 1 << 6;
/** Default for land plants: any land material except hot lava (and not ponds or sea). */
const SUB_LAND = SUB_BASALT | SUB_STONE | SUB_LIME | SUB_SAND;
/** Default for marine plants: any sea bottom. */
const SUB_BOTTOM = SUB_BASALT | SUB_STONE | SUB_LIME | SUB_SAND;

/** Ground-layer tint channel (packed into cover A/C for the ground shader). */
export const TintCh = { None: 0, Lichen: 1, Moss: 2, Grass: 3, Algae: 4 } as const;

/** Voices that count as song when a perching land bird makes them (not honks, quacks or squawks). */
const SONG_VOICES = new Set(['trill', 'whistle', 'chirp', 'coo', 'hoot', 'peep', 'kee']);
/** Voices of the night chorus: crickets, geckos and frogs. */
const NIGHT_CHORUS = new Set(['cricket', 'gecko', 'frog-coqui', 'frog-croak']);
/** Birds that nest and raise young on the islands (not migrant shorebirds and waders passing through). */
const NESTING = new Set(['colony', 'soar', 'flit', 'paddle', 'graze']);

/** How well a tree stands up to storm wind, by model (1 = never falls). */
function firmness(model: number | undefined): number {
  switch (model) {
    case PlantModel.Palm:
      return 0.75;
    case PlantModel.Pandanus:
      return 0.65;
    case PlantModel.Mangrove:
      return 0.6;
    case PlantModel.Fig:
      return 0.45;
    case PlantModel.SheOak:
      return 0.05;
    case PlantModel.Broadleaf:
      return 0.25;
    case PlantModel.TreeFern:
      return 0.4;
    default:
      return 0.3;
  }
}

/**
 * Typed-array view of the catalogue. Index = species id.
 */
export class SpeciesTable {
  readonly n: number;
  readonly defs: readonly SpeciesDef<EcoNeeds>[];
  readonly keyToId = new Map<string, number>();

  readonly isPlant: Uint8Array;
  /** Plant layer 0..3, or -1 for animals. */
  readonly layer: Int8Array;
  readonly marine: Uint8Array;
  readonly subMask: Uint8Array;
  readonly soilMin: Float32Array;
  readonly soilOk: Float32Array;
  readonly hasMoist: Uint8Array;
  readonly m0: Float32Array;
  readonly m1: Float32Array;
  readonly m2: Float32Array;
  readonly m3: Float32Array;
  readonly saltMax: Float32Array;
  readonly hasAlt: Uint8Array;
  readonly altMin: Float32Array;
  readonly altMax: Float32Array;
  readonly slopeMax: Float32Array;
  readonly hasDepth: Uint8Array;
  readonly depMin: Float32Array;
  readonly depMax: Float32Array;
  /** Shade tolerance (1 when the catalogue sets none). */
  readonly shade: Float32Array;
  /** Competitive standing of a seedling under others: shade-tolerant late species win. */
  readonly rank: Float32Array;
  readonly fert: Float32Array;
  readonly habMask: Uint32Array;
  readonly minPatches: Float32Array;
  readonly placeMask: Uint32Array;
  /** Required species ids, flattened: reqStart[s]..reqStart[s+1]. */
  readonly reqStart: Int32Array;
  readonly req: Int32Array;
  readonly minArea: Float32Array;
  readonly maxPeak: Float32Array;
  readonly minPeak: Float32Array;
  readonly noPred: Uint8Array;
  readonly predator: Uint8Array;
  readonly nearIsland: Float32Array;
  readonly grow: Float32Array;
  /** Logistic growth rate per year (5% to 95% of capacity in `grow` years). */
  readonly gr: Float32Array;
  readonly life: Float32Array;
  readonly spread: Float32Array;
  readonly rate: Float32Array;
  readonly reach: Float32Array;
  readonly hop: Float32Array;
  readonly stormOnly: Uint8Array;
  readonly roads: Uint8Array;
  /** 0 common, 1 uncommon, 2 rare. */
  readonly rarity: Uint8Array;
  readonly givesSoil: Float32Array;
  readonly givesN: Float32Array;
  readonly givesGuano: Float32Array;
  readonly givesFruit: Float32Array;
  readonly givesNectar: Float32Array;
  readonly givesDune: Float32Array;
  readonly givesNests: Float32Array;
  readonly givesSand: Float32Array;
  readonly givesInsects: Float32Array;
  readonly givesSeeds: Float32Array;
  readonly mainNeed: ReasonCode[];
  /** Storm firmness for trees. */
  readonly firm: Float32Array;
  readonly tint: Uint8Array;
  /** Herb-layer grasses (count as the Grass habitat). */
  readonly grassy: Uint8Array;
  readonly isTree: Uint8Array;
  readonly isMangrove: Uint8Array;
  readonly hasFlower: Uint8Array;
  readonly isBird: Uint8Array;
  /** Birds that nest here (first-nest stamp): colonies, frigatebirds, perching birds, ducks, megapodes. */
  readonly nester: Uint8Array;
  readonly isFern: Uint8Array;
  /** Night singers (crickets, geckos, frogs): the night chorus. */
  readonly nightSinger: Uint8Array;
  readonly isSeabird: Uint8Array;
  readonly isTurtle: Uint8Array;
  readonly isWhale: Uint8Array;
  readonly isDolphin: Uint8Array;
  readonly isSongbird: Uint8Array;
  readonly voiced: Uint8Array;
  readonly marineAnimal: Uint8Array;

  constructor(defs: readonly SpeciesDef<EcoNeeds>[]) {
    const n = defs.length;
    this.n = n;
    this.defs = defs;
    defs.forEach((d, i) => this.keyToId.set(d.key, i));
    const F = (): Float32Array => new Float32Array(n);
    const U = (): Uint8Array => new Uint8Array(n);
    this.isPlant = U();
    this.layer = new Int8Array(n);
    this.marine = U();
    this.subMask = U();
    this.soilMin = F();
    this.soilOk = F();
    this.hasMoist = U();
    this.m0 = F();
    this.m1 = F();
    this.m2 = F();
    this.m3 = F();
    this.saltMax = F();
    this.hasAlt = U();
    this.altMin = F();
    this.altMax = F();
    this.slopeMax = F();
    this.hasDepth = U();
    this.depMin = F();
    this.depMax = F();
    this.shade = F();
    this.rank = F();
    this.fert = F();
    this.habMask = new Uint32Array(n);
    this.minPatches = F();
    this.placeMask = new Uint32Array(n);
    this.reqStart = new Int32Array(n + 1);
    this.minArea = F();
    this.maxPeak = F();
    this.minPeak = F();
    this.noPred = U();
    this.predator = U();
    this.nearIsland = F();
    this.grow = F();
    this.gr = F();
    this.life = F();
    this.spread = F();
    this.rate = F();
    this.reach = F();
    this.hop = F();
    this.stormOnly = U();
    this.roads = U();
    this.rarity = U();
    this.givesSoil = F();
    this.givesN = F();
    this.givesGuano = F();
    this.givesFruit = F();
    this.givesNectar = F();
    this.givesDune = F();
    this.givesNests = F();
    this.givesSand = F();
    this.givesInsects = F();
    this.givesSeeds = F();
    this.mainNeed = [];
    this.firm = F();
    this.tint = U();
    this.grassy = U();
    this.isTree = U();
    this.isMangrove = U();
    this.hasFlower = U();
    this.isBird = U();
    this.nester = U();
    this.isFern = U();
    this.nightSinger = U();
    this.isSeabird = U();
    this.isTurtle = U();
    this.isWhale = U();
    this.isDolphin = U();
    this.isSongbird = U();
    this.voiced = U();
    this.marineAnimal = U();

    const reqs: number[] = [];
    for (let s = 0; s < n; s++) {
      const d = defs[s];
      const e = d.eco;
      const plant = d.kind === 'plant';
      this.isPlant[s] = plant ? 1 : 0;
      const L = d.layer === 'ground' ? L_GROUND : d.layer === 'herb' ? L_HERB : d.layer === 'shrub' ? L_SHRUB : d.layer === 'canopy' ? L_CANOPY : -1;
      this.layer[s] = plant ? (L < 0 ? L_HERB : L) : -1;
      this.marine[s] = d.marine ? 1 : 0;
      let mask = 0;
      for (const v of e.substrate ?? []) mask |= 1 << v;
      if (d.marine) {
        if (mask === 0 || mask & SUB_SEA) mask |= SUB_BOTTOM;
        mask &= SUB_BOTTOM;
      } else if (mask === 0) mask = SUB_LAND;
      this.subMask[s] = mask;
      this.soilMin[s] = e.soil ? e.soil[0] : 0;
      this.soilOk[s] = e.soil ? Math.max(e.soil[0] + 1e-4, e.soil[1]) : 0;
      if (e.moist) {
        this.hasMoist[s] = 1;
        this.m0[s] = e.moist[0];
        this.m1[s] = Math.max(e.moist[0], e.moist[1]);
        this.m2[s] = Math.max(this.m1[s], e.moist[2]);
        this.m3[s] = Math.max(this.m2[s], e.moist[3]);
      }
      this.saltMax[s] = e.saltMax ?? 1;
      if (e.alt) {
        this.hasAlt[s] = 1;
        this.altMin[s] = e.alt[0];
        this.altMax[s] = e.alt[1];
      }
      this.slopeMax[s] = e.slopeMax ?? 90;
      if (e.depth) {
        this.hasDepth[s] = 1;
        this.depMin[s] = e.depth[0];
        this.depMax[s] = e.depth[1];
      }
      this.shade[s] = e.shade ?? 1;
      this.rank[s] = 0.4 + 0.6 * (e.shade ?? 0.3);
      this.fert[s] = e.fert ?? 0;
      let hm = 0;
      for (const h of e.habitats ?? []) hm |= 1 << h;
      this.habMask[s] = hm;
      this.minPatches[s] = e.minPatches ?? 1;
      let pm = 0;
      for (const k of e.places ?? []) {
        const i = PLACE_KINDS.indexOf(k);
        if (i >= 0) pm |= 1 << i;
      }
      this.placeMask[s] = pm;
      this.reqStart[s] = reqs.length;
      for (const key of e.requires ?? []) {
        const id = defs.findIndex((x) => x.key === key);
        if (id >= 0 && id !== s) reqs.push(id);
      }
      this.minArea[s] = e.minArea ?? 0;
      this.maxPeak[s] = e.maxPeak ?? 1e9;
      this.minPeak[s] = e.minPeak ?? -1e9;
      this.noPred[s] = e.noPredators ? 1 : 0;
      this.predator[s] = e.predator ? 1 : 0;
      this.nearIsland[s] = e.nearIsland ?? 0;
      this.grow[s] = Math.max(1, e.grow);
      this.gr[s] = growRate(this.grow[s]);
      this.life[s] = e.life ?? Math.max(20, e.grow * 3);
      this.spread[s] = e.spread ?? (plant ? 1 : 0);
      this.rate[s] = Math.max(0, e.rate);
      this.reach[s] = Math.max(0.001, Math.min(1, e.reach));
      this.hop[s] = Math.max(1, e.hop);
      this.stormOnly[s] = e.stormOnly ? 1 : 0;
      let rb = 0;
      for (const r of d.roads) rb |= RoadBit[r];
      if (rb === 0) rb = plant ? RoadBit.wind : RoadBit.flight;
      this.roads[s] = rb;
      this.rarity[s] = d.rarity === 'rare' ? 2 : d.rarity === 'uncommon' ? 1 : 0;
      const g = e.gives ?? {};
      this.givesSoil[s] = g.soil ?? 0;
      this.givesN[s] = g.nitrogen ?? 0;
      this.givesGuano[s] = g.guano ?? 0;
      this.givesFruit[s] = g.fruit ?? 0;
      this.givesNectar[s] = g.nectar ?? 0;
      this.givesDune[s] = g.dune ?? 0;
      this.givesNests[s] = g.nests ?? 0;
      this.givesSand[s] = g.sand ?? 0;
      this.givesInsects[s] = g.insects ?? 0;
      this.givesSeeds[s] = g.seeds ?? 0;
      this.mainNeed.push(e.mainNeed);
      const model = d.plant?.model;
      this.firm[s] = firmness(model);
      const t = d.plant?.tint;
      this.tint[s] = t === 'crust' || t === 'lichen' ? TintCh.Lichen : t === 'moss' ? TintCh.Moss : t === 'grass' ? TintCh.Grass : t === 'algae' ? TintCh.Algae : TintCh.None;
      this.grassy[s] = plant && (model === PlantModel.Grass || model === PlantModel.DuneGrass || model === PlantModel.Sedge || t === 'grass') ? 1 : 0;
      this.isMangrove[s] = model === PlantModel.Mangrove ? 1 : 0;
      this.isTree[s] = plant && L === L_CANOPY && !this.isMangrove[s] && !d.marine ? 1 : 0;
      this.hasFlower[s] = plant && (d.plant?.flower !== undefined || (g.nectar ?? 0) > 0) ? 1 : 0;
      this.isFern[s] = plant && (model === PlantModel.Fern || model === PlantModel.TreeFern) ? 1 : 0;
      const a = d.animal;
      this.isBird[s] = !plant && d.guide === 'birds' ? 1 : 0;
      this.nester[s] = this.isBird[s] && a && NESTING.has(a.behaviour) ? 1 : 0;
      this.nightSinger[s] = !plant && d.voice && d.voice.when === 'night' && NIGHT_CHORUS.has(d.voice.kind) ? 1 : 0;
      this.isSeabird[s] = a?.behaviour === 'colony' ? 1 : 0;
      this.isTurtle[s] = a?.behaviour === 'nest-beach' ? 1 : 0;
      this.isWhale[s] = a?.model === AnimalModel.Whale ? 1 : 0;
      this.isDolphin[s] = a?.model === AnimalModel.Dolphin ? 1 : 0;
      this.voiced[s] = d.voice ? 1 : 0;
      this.isSongbird[s] = this.isBird[s] && a?.behaviour === 'flit' && d.voice && SONG_VOICES.has(d.voice.kind) ? 1 : 0;
      this.marineAnimal[s] = !plant && (d.marine || d.guide === 'sea') ? 1 : 0;
    }
    this.reqStart[n] = reqs.length;
    this.req = Int32Array.from(reqs);
  }

  id(key: string): number {
    return this.keyToId.get(key) ?? -1;
  }
}

// ---------- reasons ----------

const HABITAT_REASON: Partial<Record<number, ReasonCode>> = {
  [Habitat.Beach]: 'no-beach',
  [Habitat.Dune]: 'no-dune',
  [Habitat.RockShore]: 'no-rock-shore',
  [Habitat.Cliff]: 'no-cliff',
  [Habitat.Pond]: 'no-fresh-water',
  [Habitat.Marsh]: 'no-fresh-water',
  [Habitat.SaltPond]: 'no-salt-pond',
  [Habitat.Stream]: 'no-stream',
  [Habitat.Lagoon]: 'no-lagoon',
  [Habitat.Sound]: 'no-lagoon',
  [Habitat.Reef]: 'no-reef',
  [Habitat.Seagrass]: 'no-seagrass',
  [Habitat.Mangrove]: 'no-mangrove',
  [Habitat.Grass]: 'no-grass',
  [Habitat.Scrub]: 'no-shrubs',
  [Habitat.Forest]: 'no-forest',
  [Habitat.WetForest]: 'no-forest',
  [Habitat.CloudForest]: 'no-cloud-forest',
  [Habitat.Summit]: 'no-summit',
  [Habitat.HotLava]: 'no-warm-ground',
  [Habitat.BareRock]: 'no-open-ground',
  [Habitat.Crust]: 'no-open-ground',
};

const PLACE_REASON: Record<PlaceKind, ReasonCode> = {
  'lava-field': 'hot-lava',
  'sea-cliff': 'no-cliff',
  'sea-stack': 'no-stack',
  beach: 'no-beach',
  'turtle-beach': 'no-beach',
  dune: 'no-dune',
  'rock-shore': 'no-rock-shore',
  'rock-basin': 'no-fresh-water',
  pond: 'no-fresh-water',
  'salt-pond': 'no-salt-pond',
  stream: 'no-stream',
  lagoon: 'no-lagoon',
  reef: 'no-reef',
  seagrass: 'no-seagrass',
  'mangrove-shore': 'no-shelter',
  'cloud-peak': 'no-cloud-forest',
  'rain-shadow': 'too-wet',
  summit: 'no-summit',
  'warm-ground': 'no-warm-ground',
  islet: 'needs-island-nearby',
  spit: 'no-beach',
  sound: 'no-lagoon',
};

/** Reasons that name a place the player can build: these win over generic ones. */
const BUILDABLE = new Set<ReasonCode>([
  'no-beach', 'no-dune', 'no-cliff', 'no-stack', 'no-rock-shore', 'no-fresh-water', 'no-salt-pond', 'no-stream', 'no-shelter',
  'no-lagoon', 'no-reef', 'no-summit', 'no-warm-ground', 'needs-island-nearby', 'no-cloud-forest', 'too-small',
]);

export function isBuildableReason(r: ReasonCode): boolean {
  return BUILDABLE.has(r);
}

/** Reason for a missing habitat: the species' main need when it names a place, else from the first habitat. */
export function habitatReason(t: SpeciesTable, s: number): ReasonCode {
  if (BUILDABLE.has(t.mainNeed[s])) return t.mainNeed[s];
  const m = t.habMask[s];
  for (let h = 0; h < 32; h++) if (m & (1 << h)) return HABITAT_REASON[h] ?? t.mainNeed[s];
  return t.mainNeed[s];
}

/** Does a newly recognised place answer the reason a visitor gave for leaving? */
export function placeAnswers(kind: PlaceKind, r: ReasonCode): boolean {
  if (PLACE_REASON[kind] === r) return true;
  if (r === 'no-fresh-water') return kind === 'stream';
  if (r === 'no-shelter') return kind === 'lagoon' || kind === 'sound' || kind === 'seagrass';
  return false;
}

export function placeReason(t: SpeciesTable, s: number, missing: number): ReasonCode {
  for (let i = 0; i < PLACE_KINDS.length; i++) if (missing & (1 << i)) return PLACE_REASON[PLACE_KINDS[i]];
  return t.mainNeed[s];
}

/** Reason when the ground material is wrong. */
export function substrateReason(t: SpeciesTable, s: number, isHotLava: boolean): ReasonCode {
  if (isHotLava) return 'hot-lava';
  if (BUILDABLE.has(t.mainNeed[s])) return t.mainNeed[s];
  const m = t.subMask[s];
  if (t.marine[s]) return m === SUB_SAND ? 'no-seagrass' : 'no-reef';
  if (m === SUB_SAND || (m & SUB_SAND && !(m & SUB_BASALT))) return 'no-beach';
  if (m & SUB_POND) return 'no-fresh-water';
  return 'no-open-ground';
}

/** Reason for a missing required species, from what it gives. */
export function requireReason(t: SpeciesTable, r: number): ReasonCode {
  if (!t.isPlant[r]) return 'no-prey';
  if (t.marine[r]) return t.layer[r] === L_HERB ? 'no-seagrass' : t.layer[r] === L_CANOPY ? 'no-mangrove' : 'no-reef';
  if (t.givesFruit[r] > 0) return 'no-fruit';
  if (t.givesNectar[r] > 0) return 'no-flowers';
  if (t.layer[r] === L_CANOPY) return 'no-trees';
  if (t.layer[r] === L_SHRUB) return 'no-shrubs';
  if (t.grassy[r]) return 'no-grass';
  return 'no-host';
}

/** Every ReasonCode, so reasons can be stored as small numbers. */
export const REASONS: readonly ReasonCode[] = [
  'no-land', 'no-beach', 'no-dune', 'no-cliff', 'no-stack', 'no-rock-shore', 'no-soil', 'thin-soil', 'too-dry', 'too-wet', 'too-salty',
  'too-small', 'too-low', 'too-tall', 'no-fresh-water', 'no-salt-pond', 'no-stream', 'no-shelter', 'no-lagoon', 'no-reef', 'no-seagrass',
  'no-mangrove', 'no-open-ground', 'no-grass', 'no-shrubs', 'no-trees', 'no-forest', 'no-cloud-forest', 'no-flowers', 'no-fruit', 'no-prey',
  'no-host', 'no-warm-ground', 'no-summit', 'predators', 'needs-island-nearby', 'too-far', 'hot-lava', 'needs-storm',
];
export function reasonIndex(r: ReasonCode): number {
  return REASONS.indexOf(r);
}
