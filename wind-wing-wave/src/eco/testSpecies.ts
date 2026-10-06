/**
 * A small, realistic catalogue for the life simulation's checks and the tuning simulator,
 * so the ecology can be built and tested before the real ~90-species catalogue lands
 * (content/species.ts). It spans every road (wind, sea, raft, bird, flight, storm), every plant
 * layer on land and in the sea, and each key mechanism: succession on bare lava, beaches and
 * dunes, cloud forest and the dry summit, ponds, reefs and seagrass, seabird cliffs, food chains
 * (requires), weak travellers that need stepping stones, storm-only vagrants and the whales.
 *
 * The needs follow the real species in docs/design-notes/ecology.md; rates are tuned so the
 * scripted high island meets the beat sheet (ARCHITECTURE §4).
 */
import { AnimalModel, Habitat as H, PlantModel, Substrate as S, type AnimalLook, type PlantLayer, type PlantLook, type Road, type SpeciesDef, type VoiceSpec } from '../content/speciesTypes';
import type { EcoNeeds } from './needs';

type Draft = Omit<SpeciesDef<EcoNeeds>, 'id'>;
type Extra = { rarity?: SpeciesDef['rarity']; voice?: VoiceSpec; marine?: boolean };

const ROCK = [S.Basalt, S.Stone, S.Limestone];

function plant(key: string, name: string, layer: PlantLayer, roads: Road[], look: PlantLook, eco: EcoNeeds, extra: Extra = {}): Draft {
  return {
    key,
    name,
    sci: '',
    kind: 'plant',
    guide: extra.marine ? 'sea' : 'plants',
    layer,
    marine: extra.marine,
    roads,
    rarity: extra.rarity ?? 'common',
    plant: look,
    fact: `${name}: a test species.`,
    text: { arrive: `${name} took root on {place}.`, seen: `${name} came to {isl} but couldn't stay.`, back: `${name} came back to {isl}.`, lost: `${name} is gone for now.` },
    hint: [`Something green, ${name}.`, `Needs: ${eco.mainNeed}.`, `${name}: ${eco.mainNeed}.`],
    needs: eco.mainNeed,
    eco,
  };
}

function animal(key: string, name: string, guide: SpeciesDef['guide'], roads: Road[], look: AnimalLook, eco: EcoNeeds, extra: Extra = {}): Draft {
  return {
    key,
    name,
    sci: '',
    kind: 'animal',
    guide,
    marine: extra.marine,
    roads,
    rarity: extra.rarity ?? 'common',
    animal: look,
    voice: extra.voice,
    fact: `${name}: a test species.`,
    text: { arrive: `${name} arrived at {place}.`, seen: `${name} came to {isl} but couldn't stay.`, back: `${name} came back to {isl}.`, lost: `${name} is gone for now.` },
    hint: [`Something alive, ${name}.`, `Needs: ${eco.mainNeed}.`, `${name}: ${eco.mainNeed}.`],
    needs: eco.mainNeed,
    eco,
  };
}

const look = (model: number, leaf: number, extra: Partial<PlantLook> = {}): PlantLook => ({ model: model as PlantLook['model'], leaf, size: 1, ...extra });
const body = (model: number, behaviour: AnimalLook['behaviour'], where: number[], size = 0.5): AnimalLook => ({
  model: model as AnimalLook['model'],
  colors: [0x555555, 0xeeeeee, 0x333333],
  size,
  behaviour,
  active: 'day',
  where: where as AnimalLook['where'],
  max: 6,
  speed: 1,
});

const drafts: Draft[] = [
  // ---------- rock pioneers (ground layer) ----------
  plant('crust', 'Blue-green crust', 'ground', ['wind'], look(PlantModel.Tint, 0x3a4a3a, { tint: 'crust' }), {
    rate: 4, reach: 1, hop: 5000, substrate: ROCK, moist: [0.28, 0.45, 1, 1], saltMax: 0.7, shade: 0.15, grow: 12, life: 30, spread: 1.5,
    gives: { nitrogen: 0.4 }, mainNeed: 'too-dry',
  }),
  plant('lichen', 'Lava lichen', 'ground', ['wind'], look(PlantModel.Tint, 0xc9cbb0, { tint: 'lichen' }), {
    rate: 3, reach: 1, hop: 5000, substrate: [S.Basalt, S.Stone], moist: [0.1, 0.25, 1, 1], saltMax: 0.55, shade: 0.2, grow: 20, life: 60, spread: 1.2,
    gives: { nitrogen: 0.3 }, mainNeed: 'no-open-ground',
  }),
  plant('moss', 'Woolly moss', 'ground', ['wind'], look(PlantModel.Tint, 0x7fb03a, { tint: 'moss' }), {
    rate: 1, reach: 1, hop: 5000, substrate: ROCK, soil: [0.003, 0.012], moist: [0.42, 0.6, 1, 1], saltMax: 0.35, shade: 0.6, grow: 35, life: 120, spread: 0.8,
    mainNeed: 'too-dry',
  }),
  // ---------- herbs ----------
  plant('amau', 'ʻAmaʻu fern', 'herb', ['wind'], look(PlantModel.Fern, 0x4f8f36, { leaf2: 0xb04030 }), {
    rate: 0.8, reach: 1, hop: 5000, soil: [0.012, 0.04], moist: [0.45, 0.6, 1, 1], saltMax: 0.3, shade: 0.5, grow: 45, life: 80, spread: 1,
    mainNeed: 'thin-soil',
  }),
  plant('searocket', 'Sea rocket', 'herb', ['sea'], look(PlantModel.Herb, 0x7aa860, { flower: 0xe8e0f0 }), {
    rate: 0.12, reach: 0.9, hop: 3000, substrate: [S.Sand], alt: [0, 4], saltMax: 1, shade: 0.1, grow: 8, life: 6, spread: 4,
    gives: { nectar: 0.3 }, mainNeed: 'no-beach',
  }),
  plant('glory', 'Beach morning glory', 'herb', ['sea'], look(PlantModel.Vine, 0x3f8f3a, { flower: 0xd35fb7 }), {
    rate: 0.1, reach: 0.9, hop: 3000, substrate: [S.Sand], alt: [0, 10], moist: [0.04, 0.1, 1, 1], saltMax: 0.7, shade: 0.2, grow: 15, life: 25, spread: 3,
    gives: { dune: 0.4, nectar: 0.5 }, mainNeed: 'no-beach',
  }),
  plant('seaoats', 'Sea oats', 'herb', ['sea', 'wind'], look(PlantModel.DuneGrass, 0x9fb06a), {
    rate: 0.1, reach: 0.7, hop: 3000, substrate: [S.Sand], habitats: [H.Dune], alt: [1.5, 30], saltMax: 0.55, grow: 25, life: 30, spread: 2.5,
    gives: { dune: 0.9, seeds: 0.4 }, mainNeed: 'no-dune',
  }),
  plant('pili', 'Pili grass', 'herb', ['wind', 'bird'], look(PlantModel.Grass, 0xb09a5a), {
    rate: 0.3, reach: 0.7, hop: 3000, soil: [0.025, 0.08], moist: [0.1, 0.18, 0.6, 0.85], saltMax: 0.45, shade: 0.15, grow: 35, life: 30, spread: 2,
    gives: { seeds: 0.7 }, mainNeed: 'thin-soil',
  }),
  plant('sedge', 'Sedge', 'herb', ['bird'], look(PlantModel.Sedge, 0x5e8a3a), {
    rate: 0.4, reach: 0.6, hop: 3000, habitats: [H.Marsh, H.Stream, H.Pond], moist: [0.5, 0.7, 1, 1], grow: 15, life: 20, spread: 2,
    mainNeed: 'no-fresh-water',
  }),
  plant('orchid', 'Dust-seed orchid', 'herb', ['wind'], look(PlantModel.Epiphyte, 0x5a8a4a, { flower: 0xd76fb0 }), {
    rate: 0.2, reach: 1, hop: 5000, habitats: [H.WetForest, H.CloudForest], soil: [0.05, 0.2], shade: 0.95, grow: 60, life: 60, spread: 1,
    gives: { nectar: 0.4 }, mainNeed: 'no-cloud-forest',
  }, { rarity: 'uncommon' }),
  // ---------- shrubs ----------
  plant('naupaka', 'Beach naupaka', 'shrub', ['sea'], look(PlantModel.Shrub, 0x79b65a, { flower: 0xf6f2ea }), {
    rate: 0.08, reach: 0.9, hop: 3000, substrate: [S.Sand, S.Basalt, S.Stone, S.Limestone], alt: [0, 18], moist: [0.06, 0.15, 1, 1], saltMax: 0.9, shade: 0.3,
    grow: 50, life: 60, spread: 1.2, gives: { nests: 0.6, nectar: 0.3 }, mainNeed: 'too-salty',
  }),
  plant('aalii', 'ʻAʻaliʻi', 'shrub', ['wind', 'bird'], look(PlantModel.Shrub, 0x6f9a4a, { fruit: 0xb03a2a }), {
    rate: 0.25, reach: 0.6, hop: 3000, soil: [0.035, 0.12], moist: [0.12, 0.22, 0.7, 0.9], saltMax: 0.4, shade: 0.25, grow: 60, life: 80, spread: 1,
    gives: { nests: 0.4, seeds: 0.3 }, mainNeed: 'thin-soil',
  }),
  plant('treefern', 'Tree fern', 'shrub', ['wind'], look(PlantModel.TreeFern, 0x5aa040, { trunk: 0x4a3a2c }), {
    rate: 0.3, reach: 1, hop: 5000, soil: [0.06, 0.2], moist: [0.6, 0.75, 1, 1], saltMax: 0.25, shade: 0.75, grow: 90, life: 250, spread: 1,
    mainNeed: 'too-dry',
  }),
  plant('silversword', 'Silversword', 'shrub', ['bird'], look(PlantModel.Silversword, 0xc8d0c8, { flower: 0x9a3a6a }), {
    rate: 0.2, reach: 0.4, hop: 3000, habitats: [H.Summit], alt: [115, 190], moist: [0.05, 0.1, 0.45, 0.6], grow: 60, life: 50, spread: 0.5,
    mainNeed: 'no-summit',
  }, { rarity: 'rare' }),
  // ---------- trees ----------
  plant('coconut', 'Coconut palm', 'canopy', ['sea'], look(PlantModel.Palm, 0x4f9d3c, { trunk: 0x8b7257, fruit: 0x7a5a32 }), {
    rate: 0.08, reach: 0.95, hop: 3000, substrate: [S.Sand], alt: [0.3, 12], moist: [0.04, 0.1, 1, 1], saltMax: 0.95, shade: 0.3, grow: 80, life: 90, spread: 0.3,
    gives: { fruit: 0.3 }, mainNeed: 'no-beach',
  }),
  plant('ohia', 'ʻŌhiʻa lehua', 'canopy', ['wind'], look(PlantModel.PomTree, 0x7a8f6a, { flower: 0xe0262a }), {
    rate: 0.3, reach: 1, hop: 5000, soil: [0.05, 0.18], moist: [0.5, 0.65, 1, 1], saltMax: 0.3, shade: 0.3, grow: 140, life: 400, spread: 1,
    gives: { nectar: 0.8, nests: 0.6 }, mainNeed: 'too-dry',
  }),
  plant('fig', 'Strangler fig', 'canopy', ['bird'], look(PlantModel.Fig, 0x3e7a37, { fruit: 0xd8682a }), {
    rate: 0.15, reach: 0.6, hop: 4000, soil: [0.15, 0.4], moist: [0.45, 0.6, 1, 1], saltMax: 0.25, shade: 0.8, fert: 0.35, grow: 180, life: 600, spread: 0.6,
    gives: { fruit: 1, nests: 0.7 }, mainNeed: 'thin-soil',
  }),
  plant('cloudtree', 'Cloud-forest tree', 'canopy', ['bird'], look(PlantModel.CloudTree, 0x3b6b3f), {
    rate: 0.15, reach: 0.5, hop: 3000, alt: [55, 130], soil: [0.12, 0.35], moist: [0.65, 0.8, 1, 1], shade: 0.85, grow: 200, life: 500, spread: 0.6,
    mainNeed: 'no-cloud-forest',
  }, { rarity: 'uncommon' }),
  plant('mangrove', 'Red mangrove', 'canopy', ['sea'], look(PlantModel.Mangrove, 0x2f6b33, { trunk: 0x4a3a2a }), {
    rate: 0.3, reach: 0.9, hop: 3000, substrate: [S.Sand, S.Basalt, S.Limestone], alt: [-1.2, 0.5], habitats: [H.Mangrove], saltMax: 1, grow: 60, life: 150, spread: 1.5,
    gives: { nests: 0.3 }, mainNeed: 'no-shelter',
  }, { marine: true }),
  // ---------- the sea ----------
  plant('coralline', 'Coralline algae', 'ground', ['sea'], look(PlantModel.Tint, 0xd88aa0, { tint: 'algae' }), {
    rate: 1, reach: 1, hop: 5000, substrate: ROCK, depth: [0.3, 25], habitats: [H.Reef], grow: 20, life: 50, spread: 3,
    mainNeed: 'no-reef',
  }, { marine: true }),
  plant('turtlegrass', 'Turtle grass', 'herb', ['sea'], look(PlantModel.Seagrass, 0x4f8a3a), {
    rate: 0.4, reach: 0.9, hop: 3000, substrate: [S.Sand], depth: [0.5, 12], habitats: [H.Seagrass], grow: 30, life: 40, spread: 2,
    mainNeed: 'no-shelter',
  }, { marine: true }),
  plant('coral', 'Reef corals', 'shrub', ['sea'], look(PlantModel.Coral, 0xe3a36a, { leaf2: 0xc86e8a }), {
    rate: 0.5, reach: 1, hop: 5000, substrate: ROCK, depth: [0.5, 22], habitats: [H.Reef], grow: 60, life: 200, spread: 1.5,
    mainNeed: 'no-reef',
  }, { marine: true }),
  // ---------- animals ----------
  animal('spider', 'Ballooning spider', 'small', ['wind'], body(AnimalModel.Spider, 'web', [H.BareRock, H.Scrub], 0.01), {
    rate: 6, reach: 1, hop: 5000, grow: 10, mainNeed: 'no-land',
  }),
  animal('ghostcrab', 'Ghost crab', 'small', ['sea'], body(AnimalModel.Crab, 'scuttle', [H.Beach], 0.08), {
    rate: 0.15, reach: 0.8, hop: 2000, habitats: [H.Beach], minPatches: 6, grow: 20, mainNeed: 'no-beach',
  }),
  animal('booby', 'Brown booby', 'birds', ['flight'], body(AnimalModel.Seabird, 'colony', [H.Cliff, H.OpenSea], 0.8), {
    rate: 0.35, reach: 1, hop: 20000, habitats: [H.Cliff], minPatches: 3, noPredators: true, grow: 30, gives: { guano: 0.8 }, mainNeed: 'no-cliff',
  }, { voice: { kind: 'honk', pitch: 380, rate: 6, when: 'day', loud: 0.6 } }),
  animal('pintail', 'Island pintail', 'birds', ['flight'], body(AnimalModel.Duck, 'paddle', [H.Pond], 0.5), {
    rate: 0.3, reach: 0.7, hop: 8000, habitats: [H.Pond], minPatches: 6, grow: 30, mainNeed: 'no-fresh-water',
  }, { voice: { kind: 'quack', pitch: 500, rate: 3, when: 'day', loud: 0.4 } }),
  animal('skimmer', 'Globe skimmer', 'small', ['flight'], body(AnimalModel.Dragonfly, 'hover', [H.Pond], 0.05), {
    rate: 0.6, reach: 1, hop: 8000, habitats: [H.Pond, H.Marsh, H.Stream], minPatches: 2, grow: 10, mainNeed: 'no-fresh-water',
  }),
  animal('whiteeye', 'White-eye', 'birds', ['flight'], body(AnimalModel.SmallBird, 'flit', [H.Forest, H.Scrub], 0.12), {
    rate: 0.2, reach: 0.5, hop: 6000, habitats: [H.Forest, H.Scrub, H.WetForest], minPatches: 120, grow: 40, mainNeed: 'no-shrubs',
  }, { voice: { kind: 'trill', pitch: 6800, rate: 8, when: 'day', loud: 0.4 } }),
  animal('anole', 'Anole', 'land', ['raft'], body(AnimalModel.Lizard, 'bask', [H.Scrub, H.Forest], 0.18), {
    rate: 0.2, reach: 0.3, hop: 600, habitats: [H.Scrub, H.Forest], minPatches: 80, grow: 40, mainNeed: 'no-shrubs',
  }),
  animal('turtle', 'Green turtle', 'sea', ['flight'], body(AnimalModel.SeaTurtle, 'nest-beach', [H.Beach, H.Seagrass], 1), {
    rate: 0.25, reach: 0.9, hop: 20000, places: ['turtle-beach'], habitats: [H.Beach], minPatches: 10, requires: ['turtlegrass'], noPredators: true, grow: 60,
    mainNeed: 'no-beach',
  }, { marine: true }),
  animal('reeffish', 'Reef fish', 'sea', ['sea'], body(AnimalModel.FishShoal, 'shoal', [H.Reef], 0.15), {
    rate: 0.8, reach: 1, hop: 5000, habitats: [H.Reef], minPatches: 20, requires: ['coral'], grow: 20, mainNeed: 'no-reef',
  }, { marine: true }),
  animal('fruitbat', 'Flying fox', 'land', ['flight'], body(AnimalModel.Bat, 'night-fly', [H.Forest, H.WetForest], 0.3), {
    rate: 0.15, reach: 0.4, hop: 10000, habitats: [H.Forest, H.WetForest], minPatches: 200, requires: ['fig'], grow: 60, mainNeed: 'no-fruit',
  }, { rarity: 'uncommon', voice: { kind: 'bat', pitch: 3000, rate: 10, when: 'dusk', loud: 0.3 } }),
  animal('egret', 'Cattle egret', 'birds', ['storm'], body(AnimalModel.Wader, 'wade', [H.Grass], 0.5), {
    rate: 1, reach: 1, hop: 20000, stormOnly: true, habitats: [H.Grass], minPatches: 40, grow: 30, mainNeed: 'needs-storm',
  }, { rarity: 'rare' }),
  animal('frog', 'Rafted tree frog', 'land', ['raft'], body(AnimalModel.Lizard, 'bask', [H.Pond, H.WetForest], 0.04), {
    rate: 0.2, reach: 0.03, hop: 800, habitats: [H.Pond, H.WetForest], minPatches: 30, minArea: 30000, grow: 40, mainNeed: 'too-far',
  }, { rarity: 'rare', voice: { kind: 'frog-coqui', pitch: 1150, rate: 20, when: 'night', loud: 0.4 } }),
  animal('dolphin', 'Spinner dolphin', 'sea', ['flight'], body(AnimalModel.Dolphin, 'porpoise', [H.Lagoon, H.Sound], 2), {
    rate: 0.3, reach: 1, hop: 20000, habitats: [H.Lagoon, H.Sound], minPatches: 40, grow: 30, mainNeed: 'no-lagoon',
  }, { marine: true }),
  animal('whale', 'Humpback whale', 'sea', ['flight'], body(AnimalModel.Whale, 'surface-blow', [H.Sound, H.DeepSea], 14), {
    rate: 0.5, reach: 1, hop: 50000, places: ['sound'], grow: 30, mainNeed: 'no-lagoon',
  }, { rarity: 'rare', marine: true, voice: { kind: 'whale', pitch: 300, rate: 1, when: 'any', loud: 0.5 } }),
];

export const TEST_SPECIES: SpeciesDef<EcoNeeds>[] = drafts.map((d, id) => ({ ...d, id }));

/** A catalogue made of chosen test species (ids renumbered), for focused checks. */
export function testCatalogue(keys: readonly string[], tweak?: (d: Draft) => Draft): SpeciesDef<EcoNeeds>[] {
  return keys.map((k, id) => {
    const d = drafts.find((x) => x.key === k);
    if (!d) throw new Error(`No test species "${k}"`);
    const e = tweak ? tweak({ ...d, eco: { ...d.eco } }) : d;
    return { ...e, id };
  });
}
