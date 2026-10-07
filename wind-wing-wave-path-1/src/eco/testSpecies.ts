/**
 * A small, realistic catalogue for the life simulation's checks and the tuning simulator,
 * so the ecology can be built and tested before the real ~90-species catalogue lands
 * (content/species.ts). It spans every road (wind, sea, raft, bird, flight, storm), every plant
 * layer on land and in the sea, and each key mechanism: succession on bare lava, beaches and
 * dunes, cloud forest and the dry summit, ponds, reefs and seagrass, seabird cliffs, food chains
 * (requires), weak travellers that need stepping stones, storm-only vagrants and the whales.
 *
 * The needs follow the real species in docs/design-notes/ecology.md, with the same numbers the
 * real catalogue gives them (rates, soil ladder, what they give back), so a check tuned here
 * behaves the same with the real catalogue.
 */
import { AnimalModel, Habitat as H, PlantModel, Substrate as S, type AnimalLook, type PlantLayer, type PlantLook, type Road, type SpeciesDef, type VoiceSpec } from '../content/speciesTypes';
import type { EcoNeeds } from './needs';

type Draft = Omit<SpeciesDef<EcoNeeds>, 'id'>;
type Extra = { rarity?: SpeciesDef['rarity']; voice?: VoiceSpec; marine?: boolean };

const ROCK = [S.Basalt, S.Stone, S.Limestone];
const LAND = [S.Basalt, S.Stone, S.Limestone, S.Sand];

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
    rate: 12, reach: 1, hop: 3000, substrate: ROCK, soil: [0, 0.01], moist: [0.35, 0.5, 1, 1], saltMax: 0.8, slopeMax: 85, shade: 0.2, grow: 20, life: 50, spread: 4,
    gives: { soil: 0.004, nitrogen: 0.5 }, mainNeed: 'too-dry',
  }),
  plant('lichen', 'Lava lichen', 'ground', ['wind'], look(PlantModel.Tint, 0xc9cbb0, { tint: 'lichen' }), {
    rate: 9, reach: 1, hop: 3000, substrate: [S.Basalt, S.Stone], soil: [0, 0.02], moist: [0.25, 0.45, 0.9, 1], saltMax: 0.5, slopeMax: 85, shade: 0.1, grow: 30, life: 150,
    spread: 3, gives: { soil: 0.006, nitrogen: 0.4 }, mainNeed: 'too-dry',
  }),
  plant('moss', 'Woolly moss', 'ground', ['wind'], look(PlantModel.Tint, 0x7fb03a, { tint: 'moss' }), {
    rate: 5, reach: 1, hop: 2500, substrate: ROCK, soil: [0.01, 0.05], moist: [0.45, 0.65, 1, 1], saltMax: 0.35, slopeMax: 75, shade: 0.3, grow: 50, life: 150, spread: 2.5,
    gives: { soil: 0.015 }, mainNeed: 'too-dry',
  }),
  // ---------- herbs ----------
  plant('amau', 'ʻAmaʻu fern', 'herb', ['wind'], look(PlantModel.Fern, 0x4f8f36, { leaf2: 0xb04030 }), {
    rate: 3, reach: 1, hop: 2000, substrate: [S.Basalt, S.Stone], soil: [0.015, 0.08], moist: [0.45, 0.65, 0.95, 1], saltMax: 0.3, alt: [0, 160], slopeMax: 60, shade: 0.4,
    grow: 60, life: 60, spread: 1.5, gives: { soil: 0.02 }, mainNeed: 'thin-soil',
  }),
  plant('searocket', 'Sea rocket', 'herb', ['sea'], look(PlantModel.Herb, 0x7aa860, { flower: 0xe8e0f0 }), {
    rate: 2.5, reach: 0.8, hop: 1500, substrate: [S.Sand], soil: [0, 0.03], moist: [0.1, 0.2, 0.6, 0.9], saltMax: 1, alt: [0.3, 5], slopeMax: 25, shade: 0,
    habitats: [H.Beach, H.Dune], grow: 10, life: 2, spread: 3, gives: { nectar: 0.3 }, mainNeed: 'no-beach',
  }),
  plant('glory', 'Beach morning glory', 'herb', ['sea'], look(PlantModel.Vine, 0x3f8f3a, { flower: 0xd35fb7 }), {
    rate: 2.2, reach: 0.9, hop: 1500, substrate: [S.Sand], soil: [0, 0.05], moist: [0.1, 0.25, 0.7, 0.9], saltMax: 0.9, alt: [0.5, 10], slopeMax: 30, shade: 0.05,
    habitats: [H.Beach, H.Dune], grow: 25, life: 15, spread: 3, gives: { dune: 0.5, nectar: 0.5, soil: 0.008 }, mainNeed: 'no-beach',
  }),
  plant('seaoats', 'Sea oats', 'herb', ['sea', 'wind'], look(PlantModel.DuneGrass, 0x9fb06a), {
    rate: 1.2, reach: 0.7, hop: 1200, substrate: [S.Sand], soil: [0, 0.05], moist: [0.15, 0.25, 0.6, 0.85], saltMax: 0.85, alt: [0.8, 15], slopeMax: 35, shade: 0.05,
    habitats: [H.Dune, H.Beach], grow: 40, life: 25, spread: 2.5, gives: { dune: 0.9, soil: 0.01 }, mainNeed: 'no-dune',
  }),
  plant('pili', 'Pili grass', 'herb', ['wind', 'bird'], look(PlantModel.Grass, 0xb09a5a), {
    rate: 2, reach: 0.8, hop: 1500, substrate: LAND, soil: [0.03, 0.12], moist: [0.15, 0.25, 0.6, 0.85], saltMax: 0.5, alt: [0, 120], slopeMax: 40, shade: 0.05, grow: 40,
    life: 15, spread: 3, gives: { soil: 0.015, seeds: 0.6, insects: 0.2 }, mainNeed: 'thin-soil',
  }),
  plant('sedge', 'Sedge', 'herb', ['bird'], look(PlantModel.Sedge, 0x5e8a3a), {
    rate: 1.5, reach: 0.7, hop: 1500, substrate: [S.Basalt, S.Stone, S.Limestone, S.Sand, S.Pond], moist: [0.75, 0.85, 1, 1], saltMax: 0.6,
    habitats: [H.Pond, H.Marsh, H.Stream, H.SaltPond], grow: 30, life: 15, spread: 2, gives: { soil: 0.02, seeds: 0.4 }, mainNeed: 'no-fresh-water',
  }),
  plant('orchid', 'Dust-seed orchid', 'herb', ['wind'], look(PlantModel.Epiphyte, 0x5a8a4a, { flower: 0xd76fb0 }), {
    rate: 0.6, reach: 1, hop: 2000, habitats: [H.WetForest, H.CloudForest], moist: [0.65, 0.8, 1, 1], saltMax: 0.15, shade: 0.8, grow: 80, life: 40, spread: 0.6,
    gives: { nectar: 0.4 }, mainNeed: 'no-cloud-forest',
  }, { rarity: 'uncommon' }),
  // ---------- shrubs ----------
  plant('naupaka', 'Beach naupaka', 'shrub', ['sea'], look(PlantModel.Shrub, 0x79b65a, { flower: 0xf6f2ea }), {
    rate: 1.5, reach: 0.85, hop: 1500, substrate: LAND, soil: [0, 0.08], moist: [0.2, 0.3, 0.75, 0.9], saltMax: 0.9, alt: [0.5, 25], slopeMax: 40, shade: 0.1, grow: 60,
    life: 50, spread: 1.5, gives: { nests: 0.6, nectar: 0.5, dune: 0.4, soil: 0.015 }, mainNeed: 'no-beach',
  }),
  plant('aalii', 'ʻAʻaliʻi', 'shrub', ['wind', 'bird'], look(PlantModel.Shrub, 0x6f9a4a, { fruit: 0xb03a2a }), {
    rate: 1.2, reach: 0.9, hop: 1500, substrate: LAND, soil: [0.05, 0.15], moist: [0.15, 0.3, 0.7, 0.9], saltMax: 0.5, alt: [0, 170], slopeMax: 45, shade: 0.1, grow: 70,
    life: 50, spread: 1.2, gives: { nests: 0.3, seeds: 0.4, soil: 0.02 }, mainNeed: 'thin-soil',
  }),
  plant('treefern', 'Tree fern', 'shrub', ['wind'], look(PlantModel.TreeFern, 0x5aa040, { trunk: 0x4a3a2c }), {
    rate: 1.2, reach: 0.9, hop: 1500, substrate: ROCK, soil: [0.1, 0.3], moist: [0.6, 0.75, 1, 1], saltMax: 0.2, alt: [3, 170], slopeMax: 45, shade: 0.7, grow: 120, life: 300,
    spread: 0.6, gives: { soil: 0.03, nests: 0.2 }, mainNeed: 'too-dry',
  }),
  plant('silversword', 'Silversword', 'shrub', ['bird'], look(PlantModel.Silversword, 0xc8d0c8, { flower: 0x9a3a6a }), {
    rate: 0.3, reach: 0.6, hop: 1500, substrate: [S.Basalt, S.Stone], soil: [0, 0.05], moist: [0.1, 0.2, 0.45, 0.6], saltMax: 0.1, alt: [110, 200], slopeMax: 45, shade: 0,
    habitats: [H.Summit], grow: 150, life: 60, spread: 0.3, gives: { nectar: 0.5 }, mainNeed: 'no-summit',
  }, { rarity: 'rare' }),
  // ---------- trees ----------
  plant('coconut', 'Coconut palm', 'canopy', ['sea'], look(PlantModel.Palm, 0x4f9d3c, { trunk: 0x8b7257, fruit: 0x7a5a32 }), {
    rate: 1, reach: 0.8, hop: 1500, substrate: [S.Sand], soil: [0, 0.1], moist: [0.3, 0.4, 0.85, 1], saltMax: 0.85, alt: [0.5, 12], slopeMax: 25, shade: 0.2, grow: 100,
    life: 80, spread: 0.6, gives: { fruit: 0.5, nests: 0.3, soil: 0.02 }, mainNeed: 'no-beach',
  }),
  plant('ohia', 'ʻŌhiʻa lehua', 'canopy', ['wind'], look(PlantModel.PomTree, 0x7a8f6a, { flower: 0xe0262a }), {
    rate: 1, reach: 0.9, hop: 2500, substrate: ROCK, soil: [0.07, 0.3], moist: [0.35, 0.55, 1, 1], saltMax: 0.3, alt: [0, 170], slopeMax: 50, shade: 0.3, grow: 180, life: 400,
    spread: 0.8, gives: { nectar: 0.9, nests: 0.7, soil: 0.04, insects: 0.4 }, mainNeed: 'thin-soil',
  }),
  plant('fig', 'Strangler fig', 'canopy', ['bird'], look(PlantModel.Fig, 0x3e7a37, { fruit: 0xd8682a }), {
    rate: 0.5, reach: 0.6, hop: 1500, substrate: LAND, soil: [0.06, 0.4], moist: [0.35, 0.5, 0.95, 1], saltMax: 0.3, alt: [0, 120], slopeMax: 70, shade: 0.6,
    habitats: [H.Forest, H.WetForest, H.Scrub], grow: 200, life: 300, spread: 0.4, gives: { fruit: 1, nests: 0.8, insects: 0.4, soil: 0.035 }, mainNeed: 'no-trees',
  }, { rarity: 'uncommon' }),
  plant('cloudtree', 'Cloud-forest tree', 'canopy', ['bird'], look(PlantModel.CloudTree, 0x3b6b3f), {
    rate: 0.4, reach: 0.6, hop: 1500, substrate: ROCK, soil: [0.08, 0.4], moist: [0.7, 0.85, 1, 1], saltMax: 0.15, alt: [35, 160], slopeMax: 45, shade: 0.5,
    places: ['cloud-peak'], grow: 200, life: 150, spread: 0.6, gives: { fruit: 0.6, nests: 0.6, soil: 0.035 }, mainNeed: 'no-cloud-forest',
  }, { rarity: 'uncommon' }),
  plant('mangrove', 'Red mangrove', 'canopy', ['sea'], look(PlantModel.Mangrove, 0x2f6b33, { trunk: 0x4a3a2a }), {
    rate: 0.6, reach: 0.8, hop: 1500, substrate: [S.Sand], depth: [0, 1.5], alt: [-1.5, 0.8], saltMax: 1, slopeMax: 15, shade: 0.3, places: ['mangrove-shore'], grow: 150,
    life: 100, spread: 0.8, gives: { nests: 0.6, soil: 0.03 }, mainNeed: 'no-shelter',
  }, { rarity: 'uncommon', marine: true }),
  // ---------- the sea ----------
  plant('coralline', 'Coralline algae', 'ground', ['sea'], look(PlantModel.Tint, 0xd88aa0, { tint: 'algae' }), {
    rate: 2, reach: 1, hop: 2000, substrate: ROCK, depth: [0, 15], saltMax: 1, grow: 50, life: 100, spread: 2, gives: { sand: 0.1 }, mainNeed: 'no-reef',
  }, { marine: true }),
  plant('turtlegrass', 'Turtle grass', 'herb', ['sea'], look(PlantModel.Seagrass, 0x4f8a3a), {
    rate: 0.8, reach: 0.7, hop: 1500, substrate: [S.Sand], depth: [0.5, 8], saltMax: 1, habitats: [H.Lagoon, H.Seagrass, H.Sound], grow: 120, life: 60, spread: 1.5,
    mainNeed: 'no-lagoon',
  }, { marine: true }),
  plant('coral', 'Reef corals', 'shrub', ['sea'], look(PlantModel.Coral, 0xe3a36a, { leaf2: 0xc86e8a }), {
    rate: 0.8, reach: 0.8, hop: 1500, substrate: ROCK, depth: [1, 15], saltMax: 1, grow: 300, life: 200, spread: 0.8, gives: { sand: 0.3 }, mainNeed: 'no-reef',
  }, { marine: true }),
  // ---------- animals ----------
  animal('spider', 'Ballooning spider', 'small', ['wind'], body(AnimalModel.Spider, 'web', [H.BareRock, H.Scrub], 0.01), {
    rate: 14, reach: 1, hop: 4000, grow: 20, gives: { insects: 0.1 }, mainNeed: 'hot-lava',
  }),
  animal('ghostcrab', 'Ghost crab', 'small', ['sea'], body(AnimalModel.Crab, 'scuttle', [H.Beach], 0.08), {
    rate: 1.5, reach: 1, hop: 2000, habitats: [H.Beach, H.Dune], minPatches: 4, grow: 30, mainNeed: 'no-beach',
  }),
  animal('booby', 'Brown booby', 'birds', ['flight'], body(AnimalModel.Seabird, 'colony', [H.Cliff, H.OpenSea], 0.8), {
    rate: 0.6, reach: 1, hop: 5000, habitats: [H.Cliff], minPatches: 3, noPredators: true, grow: 80, gives: { guano: 0.7 }, mainNeed: 'no-cliff',
  }, { voice: { kind: 'honk', pitch: 380, rate: 6, when: 'day', loud: 0.6 } }),
  animal('pintail', 'Island pintail', 'birds', ['flight'], body(AnimalModel.Duck, 'paddle', [H.Pond], 0.5), {
    rate: 0.5, reach: 1, hop: 5000, habitats: [H.Pond, H.Marsh], minPatches: 4, grow: 50, mainNeed: 'no-fresh-water',
  }, { voice: { kind: 'quack', pitch: 500, rate: 3, when: 'day', loud: 0.4 } }),
  animal('skimmer', 'Globe skimmer', 'small', ['flight'], body(AnimalModel.Dragonfly, 'hover', [H.Pond], 0.05), {
    rate: 0.8, reach: 1, hop: 4000, habitats: [H.Pond, H.Marsh, H.Stream], minPatches: 2, grow: 20, mainNeed: 'no-fresh-water',
  }),
  animal('whiteeye', 'White-eye', 'birds', ['flight'], body(AnimalModel.SmallBird, 'flit', [H.Forest, H.Scrub], 0.12), {
    rate: 0.45, reach: 0.6, hop: 3000, habitats: [H.Scrub, H.Forest, H.WetForest], minPatches: 20, grow: 60, mainNeed: 'no-shrubs',
  }, { voice: { kind: 'trill', pitch: 6800, rate: 8, when: 'day', loud: 0.4 } }),
  animal('anole', 'Anole', 'land', ['raft'], body(AnimalModel.Lizard, 'bask', [H.Scrub, H.Forest], 0.18), {
    rate: 0.6, reach: 0.3, hop: 800, habitats: [H.Scrub, H.Forest], minPatches: 10, grow: 50, mainNeed: 'no-shrubs',
  }),
  animal('turtle', 'Green turtle', 'sea', ['flight'], body(AnimalModel.SeaTurtle, 'nest-beach', [H.Beach, H.Seagrass], 1), {
    rate: 0.8, reach: 1, hop: 3000, places: ['turtle-beach'], habitats: [H.Beach], minPatches: 10, requires: ['turtlegrass'], noPredators: true, grow: 100,
    mainNeed: 'no-beach',
  }, { marine: true }),
  animal('reeffish', 'Reef fish', 'sea', ['sea'], body(AnimalModel.FishShoal, 'shoal', [H.Reef], 0.15), {
    rate: 1.5, reach: 1, hop: 2000, habitats: [H.Reef], minPatches: 8, requires: ['coral'], grow: 60, mainNeed: 'no-reef',
  }, { marine: true }),
  animal('fruitbat', 'Flying fox', 'land', ['flight'], body(AnimalModel.Bat, 'night-fly', [H.Forest, H.WetForest], 0.3), {
    rate: 0.25, reach: 0.5, hop: 3000, habitats: [H.Forest, H.WetForest], minPatches: 40, requires: ['fig'], grow: 100, mainNeed: 'no-fruit',
  }, { rarity: 'uncommon', voice: { kind: 'bat', pitch: 3000, rate: 10, when: 'dusk', loud: 0.3 } }),
  animal('egret', 'Cattle egret', 'birds', ['storm'], body(AnimalModel.Wader, 'wade', [H.Grass], 0.5), {
    rate: 1, reach: 1, hop: 5000, stormOnly: true, habitats: [H.Grass], minPatches: 20, grow: 60, mainNeed: 'needs-storm',
  }, { rarity: 'uncommon' }),
  animal('frog', 'Rafted tree frog', 'land', ['raft'], body(AnimalModel.Lizard, 'bask', [H.Pond, H.WetForest], 0.04), {
    rate: 0.2, reach: 0.05, hop: 250, habitats: [H.Pond, H.WetForest], minPatches: 30, minArea: 30000, grow: 80, mainNeed: 'too-far',
  }, { rarity: 'rare', voice: { kind: 'frog-coqui', pitch: 1150, rate: 20, when: 'night', loud: 0.4 } }),
  animal('dolphin', 'Spinner dolphin', 'sea', ['flight'], body(AnimalModel.Dolphin, 'porpoise', [H.Lagoon, H.Sound], 2), {
    rate: 0.3, reach: 1, hop: 5000, habitats: [H.Lagoon, H.Sound], minPatches: 40, grow: 80, mainNeed: 'no-lagoon',
  }, { marine: true }),
  animal('whale', 'Humpback whale', 'sea', ['flight'], body(AnimalModel.Whale, 'surface-blow', [H.Sound, H.DeepSea], 14), {
    rate: 0.15, reach: 1, hop: 10000, places: ['sound'], grow: 200, mainNeed: 'no-shelter',
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
