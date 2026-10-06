/**
 * The species catalogue.
 *
 * STUB (lead): one placeholder species for every plant archetype and animal body plan, so
 * renderers and sound can be built and tested before the real catalogue exists.
 * WP-D replaces this whole file with the real ~90-species catalogue (same exports).
 */
import { AnimalModel, Habitat, PlantModel, type AnimalLook, type PlantLayer, type PlantLook, type SpeciesDef, type VoiceSpec } from './speciesTypes';
import type { EcoNeeds } from '../eco/needs';

type Draft = Omit<SpeciesDef<EcoNeeds>, 'id'>;

const ECO: EcoNeeds = { rate: 10, reach: 1, hop: 2000, grow: 50, mainNeed: 'no-land' };

function plant(key: string, name: string, layer: PlantLayer, look: PlantLook, marine = false): Draft {
  return {
    key,
    name,
    sci: '',
    kind: 'plant',
    guide: marine ? 'sea' : 'plants',
    layer,
    marine,
    roads: ['wind'],
    rarity: 'common',
    plant: look,
    fact: 'Placeholder species.',
    text: { arrive: `${name} arrived at {place}.`, seen: `${name} visited but couldn't stay.`, back: `${name} came back.`, lost: `${name} is gone.` },
    hint: ['Something green.', 'Needs land.', `${name}: needs land.`],
    needs: 'Placeholder',
    eco: ECO,
  };
}

function animal(key: string, name: string, guide: SpeciesDef['guide'], look: AnimalLook, voice?: VoiceSpec): Draft {
  return {
    key,
    name,
    sci: '',
    kind: 'animal',
    guide,
    roads: ['flight'],
    rarity: 'common',
    animal: look,
    voice,
    fact: 'Placeholder species.',
    text: { arrive: `${name} arrived at {place}.`, seen: `${name} visited but couldn't stay.`, back: `${name} came back.`, lost: `${name} is gone.` },
    hint: ['Something alive.', 'Needs a place.', `${name}: needs a place.`],
    needs: 'Placeholder',
    eco: ECO,
  };
}

const H = Habitat;
const drafts: Draft[] = [
  plant('lichen', 'Lava lichen', 'ground', { model: PlantModel.Tint, leaf: 0xc9cbb0, size: 1, tint: 'lichen' }),
  plant('moss', 'Woolly moss', 'ground', { model: PlantModel.Tint, leaf: 0x7fb03a, size: 1, tint: 'moss' }),
  plant('fern', 'Sword fern', 'herb', { model: PlantModel.Fern, leaf: 0x4f8f36, leaf2: 0x9ccc5a, size: 1 }),
  plant('treefern', 'Tree fern', 'shrub', { model: PlantModel.TreeFern, leaf: 0x5aa040, leaf2: 0xa8d468, trunk: 0x4a3a2c, size: 1 }),
  plant('grass', 'Bunchgrass', 'herb', { model: PlantModel.Grass, leaf: 0x6fae4a, leaf2: 0x9ccc5a, size: 1 }),
  plant('duneg', 'Sea oats', 'herb', { model: PlantModel.DuneGrass, leaf: 0x9fb06a, leaf2: 0xd8c98a, size: 1 }),
  plant('sedge', 'Sedge', 'herb', { model: PlantModel.Sedge, leaf: 0x5e8a3a, fruit: 0x6b4a2a, size: 1 }),
  plant('vine', 'Beach morning glory', 'herb', { model: PlantModel.Vine, leaf: 0x3f8f3a, flower: 0xd35fb7, size: 1 }),
  plant('mat', 'Sea purslane', 'herb', { model: PlantModel.Mat, leaf: 0x7fae4f, trunk: 0xb0473a, size: 1 }),
  plant('herb', 'Wildflowers', 'herb', { model: PlantModel.Herb, leaf: 0x5f9b44, flower: 0xf2c230, size: 1 }),
  plant('palm', 'Coconut palm', 'canopy', { model: PlantModel.Palm, leaf: 0x4f9d3c, leaf2: 0x86c45a, trunk: 0x8b7257, fruit: 0x7a5a32, size: 1 }),
  plant('pandanus', 'Screwpine', 'canopy', { model: PlantModel.Pandanus, leaf: 0x5d8f4a, leaf2: 0xb9c98a, trunk: 0x8a7a64, fruit: 0xe3812e, size: 1 }),
  plant('seagrape', 'Sea grape', 'shrub', { model: PlantModel.SeaGrape, leaf: 0x5f9b44, leaf2: 0x8bc463, fruit: 0x6b2e5a, size: 1 }),
  plant('shrub', 'Beach naupaka', 'shrub', { model: PlantModel.Shrub, leaf: 0x79b65a, flower: 0xf6f2ea, size: 1 }),
  plant('mangrove', 'Red mangrove', 'canopy', { model: PlantModel.Mangrove, leaf: 0x2f6b33, leaf2: 0x4f8f45, trunk: 0x4a3a2a, size: 1 }),
  plant('fig', 'Strangler fig', 'canopy', { model: PlantModel.Fig, leaf: 0x3e7a37, leaf2: 0x5f9b44, trunk: 0x9a8f80, fruit: 0xd8682a, size: 1 }),
  plant('ohia', 'ʻŌhiʻa lehua', 'canopy', { model: PlantModel.PomTree, leaf: 0x7a8f6a, flower: 0xe0262a, trunk: 0x6b5a48, size: 1 }),
  plant('broadleaf', 'Tropical almond', 'canopy', { model: PlantModel.Broadleaf, leaf: 0x4f8a3e, leaf2: 0x6b9a3a, trunk: 0xb0603f, size: 1 }),
  plant('cloudtree', 'Cloud-forest tree', 'canopy', { model: PlantModel.CloudTree, leaf: 0x3b6b3f, leaf2: 0x6f9a3a, trunk: 0x5a4d3d, size: 1 }),
  plant('sheoak', 'Beach she-oak', 'canopy', { model: PlantModel.SheOak, leaf: 0x5a7a4a, trunk: 0x6b5a48, size: 1 }),
  plant('cactus', 'Tree prickly pear', 'shrub', { model: PlantModel.Cactus, leaf: 0x6f9a5a, flower: 0xf5d23a, fruit: 0xb0304a, size: 1 }),
  plant('silversword', 'Silversword', 'shrub', { model: PlantModel.Silversword, leaf: 0xc8d0c8, flower: 0x9a3a6a, size: 1 }),
  plant('seagrass', 'Turtle grass', 'herb', { model: PlantModel.Seagrass, leaf: 0x4f8a3a, size: 1 }, true),
  plant('coral', 'Reef corals', 'shrub', { model: PlantModel.Coral, leaf: 0xe3a36a, leaf2: 0xc86e8a, flower: 0x7aa6c2, size: 1 }, true),
  plant('lily', 'Water lily', 'herb', { model: PlantModel.Lily, leaf: 0x4f8f3a, flower: 0xf6f0f4, size: 1 }),
  plant('orchid', 'Dust-seed orchid', 'herb', { model: PlantModel.Epiphyte, leaf: 0x5a8a4a, flower: 0xd76fb0, size: 1 }),
  animal('booby', 'Brown booby', 'birds', { model: AnimalModel.Seabird, colors: [0x4a3a2e, 0xf4f1ea, 0xe8c84a], size: 0.8, behaviour: 'colony', active: 'day', where: [H.Cliff, H.OpenSea], max: 20, speed: 12 }, { kind: 'honk', pitch: 380, rate: 6, when: 'day', loud: 0.6 }),
  animal('frigate', 'Great frigatebird', 'birds', { model: AnimalModel.Frigatebird, colors: [0x1e1e22, 0xe0302a, 0x1e1e22], size: 1.0, behaviour: 'soar', active: 'day', where: [H.Scrub, H.OpenSea], max: 4, speed: 8 }),
  animal('bananaquit', 'White-eye', 'birds', { model: AnimalModel.SmallBird, colors: [0x6f8a3a, 0xf4cc2a, 0xffffff], size: 0.12, behaviour: 'flit', active: 'day', where: [H.Forest, H.Scrub, H.WetForest], max: 10, speed: 6 }, { kind: 'trill', pitch: 6800, rate: 8, when: 'day', loud: 0.4 }),
  animal('heron', 'Night heron', 'birds', { model: AnimalModel.Wader, colors: [0x7a8590, 0xf2efe6, 0xe8c84a], size: 0.6, behaviour: 'wade', active: 'dusk', where: [H.Pond, H.Mangrove, H.RockShore], max: 2, speed: 0.3 }),
  animal('sandpiper', 'Ruddy turnstone', 'birds', { model: AnimalModel.Shorebird, colors: [0x8a7458, 0xf4f1ea, 0xe8742a], size: 0.22, behaviour: 'run-shore', active: 'day', where: [H.Beach], max: 10, speed: 1.5 }, { kind: 'peep', pitch: 3400, rate: 10, when: 'day', loud: 0.3 }),
  animal('duck', 'Island pintail', 'birds', { model: AnimalModel.Duck, colors: [0xa8865a, 0xf2efe6, 0x3a3a3a], size: 0.5, behaviour: 'paddle', active: 'day', where: [H.Pond], max: 6, speed: 0.3 }, { kind: 'quack', pitch: 500, rate: 3, when: 'day', loud: 0.4 }),
  animal('bat', 'Flying fox', 'land', { model: AnimalModel.Bat, colors: [0x3a2e2a, 0x7a4a2a, 0x3a2e2a], size: 0.3, behaviour: 'night-fly', active: 'dusk', where: [H.Forest, H.WetForest], max: 8, speed: 6 }, { kind: 'bat', pitch: 3000, rate: 10, when: 'dusk', loud: 0.3 }),
  animal('ghostcrab', 'Ghost crab', 'small', { model: AnimalModel.Crab, colors: [0xe8d8b8, 0x3a3a3a, 0xe8d8b8], size: 0.08, behaviour: 'scuttle', active: 'any', where: [H.Beach], max: 12, speed: 3 }),
  animal('anole', 'Anole', 'land', { model: AnimalModel.Lizard, colors: [0x6fae3a, 0xf0628a, 0x3a5a2a], size: 0.18, behaviour: 'bask', active: 'day', where: [H.Scrub, H.Forest], max: 8, speed: 1.5 }),
  animal('tortoise', 'Giant tortoise', 'land', { model: AnimalModel.Tortoise, colors: [0x5a5040, 0x7a6a50, 0x3a3328], size: 1.0, behaviour: 'graze', active: 'day', where: [H.Grass, H.Scrub], max: 4, speed: 0.08 }),
  animal('turtle', 'Green turtle', 'sea', { model: AnimalModel.SeaTurtle, colors: [0x5a5a3a, 0x6b6a4a, 0xd8d0b0], size: 1.0, behaviour: 'nest-beach', active: 'night', where: [H.Beach, H.Seagrass], max: 3, speed: 0.1 }),
  animal('reeffish', 'Reef fish', 'sea', { model: AnimalModel.FishShoal, colors: [0x3a7fd0, 0xf0d03a, 0x3fbfa0], size: 0.15, behaviour: 'shoal', active: 'any', where: [H.Reef], max: 40, speed: 0.8 }),
  animal('ray', 'Spotted eagle ray', 'sea', { model: AnimalModel.Ray, colors: [0x3a3f4a, 0xf2f2f2, 0x3a3f4a], size: 1.6, behaviour: 'glide-sea', active: 'any', where: [H.Lagoon, H.Seagrass], max: 2, speed: 1.5 }),
  animal('dolphin', 'Spinner dolphin', 'sea', { model: AnimalModel.Dolphin, colors: [0x7f8c95, 0xd9dde0, 0x5a6670], size: 2.0, behaviour: 'porpoise', active: 'day', where: [H.Lagoon, H.Sound, H.OpenSea], max: 6, speed: 5 }),
  animal('whale', 'Humpback whale', 'sea', { model: AnimalModel.Whale, colors: [0x3b4048, 0xf2f2f2, 0x2a2e34], size: 14, behaviour: 'surface-blow', active: 'any', where: [H.Sound, H.DeepSea], max: 2, speed: 2 }, { kind: 'whale', pitch: 300, rate: 1, when: 'any', loud: 0.5 }),
  animal('butterfly', 'Sulphur butterfly', 'small', { model: AnimalModel.Butterfly, colors: [0xf2d33a, 0x2a2a2a, 0xf2d33a], size: 0.06, behaviour: 'flutter', active: 'day', where: [H.Grass, H.Scrub, H.Beach], max: 10, speed: 1.5 }),
  animal('dragonfly', 'Globe skimmer', 'small', { model: AnimalModel.Dragonfly, colors: [0xc23a2a, 0xb8d8f0, 0xc23a2a], size: 0.05, behaviour: 'hover', active: 'day', where: [H.Pond], max: 6, speed: 5 }),
  animal('bee', 'Yellow-faced bee', 'small', { model: AnimalModel.Bee, colors: [0x2a2a2a, 0xf0d03a, 0xffffff], size: 0.01, behaviour: 'buzz', active: 'day', where: [H.Beach, H.Scrub], max: 8, speed: 2 }, { kind: 'buzz', pitch: 220, rate: 4, when: 'day', loud: 0.2 }),
  animal('firefly', 'Click beetle', 'small', { model: AnimalModel.Firefly, colors: [0xb8ff7a, 0x2a2a2a, 0xb8ff7a], size: 0.01, behaviour: 'glow', active: 'night', where: [H.WetForest, H.Forest], max: 30, speed: 0.2 }),
  animal('seal', 'Monk seal', 'land', { model: AnimalModel.Seal, colors: [0x6a6a66, 0xb8b4aa, 0x3a3a38], size: 2.2, behaviour: 'haul-out', active: 'day', where: [H.Beach], max: 2, speed: 0.4 }, { kind: 'seal', pitch: 200, rate: 2, when: 'day', loud: 0.4 }),
  animal('spider', 'Ballooning spider', 'small', { model: AnimalModel.Spider, colors: [0x6a5a4a, 0xe8e0d0, 0x6a5a4a], size: 0.005, behaviour: 'web', active: 'any', where: [H.BareRock, H.Scrub], max: 3, speed: 0.5 }),
  animal('shark', 'Blacktip reef shark', 'sea', { model: AnimalModel.Shark, colors: [0x8a9098, 0xf0f0f0, 0x1a1a1a], size: 1.5, behaviour: 'glide-sea', active: 'any', where: [H.Lagoon, H.Reef], max: 3, speed: 1.5 }),
  animal('snail', 'Land snail', 'small', { model: AnimalModel.Snail, colors: [0xc89a5a, 0x6a4a2a, 0xe8d8c0], size: 0.02, behaviour: 'creep', active: 'night', where: [H.WetForest], max: 6, speed: 0.01 }),
  animal('cricket', 'Tree cricket', 'small', { model: AnimalModel.Bee, colors: [0x9ab060, 0x6a8a40, 0x9ab060], size: 0.02, behaviour: 'buzz', active: 'night', where: [H.Scrub, H.Forest], max: 0, speed: 0 }, { kind: 'cricket', pitch: 4600, rate: 30, when: 'night', loud: 0.3 }),
  animal('frog', 'Rafted tree frog', 'land', { model: AnimalModel.Lizard, colors: [0x7a9a4a, 0xe8d8a0, 0x4a6a2a], size: 0.04, behaviour: 'bask', active: 'night', where: [H.Pond, H.WetForest], max: 0, speed: 0 }, { kind: 'frog-coqui', pitch: 1150, rate: 20, when: 'night', loud: 0.4 }),
];

export const SPECIES: SpeciesDef<EcoNeeds>[] = drafts.map((d, id) => ({ ...d, id }));

const byKey = new Map(SPECIES.map((s) => [s.key, s]));
export function speciesByKey(key: string): SpeciesDef<EcoNeeds> | undefined {
  return byKey.get(key);
}
