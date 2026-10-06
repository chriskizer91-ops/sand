/**
 * Checks for the species catalogue and every line of text (content/species.ts, content/stories.ts).
 * They guard the rules the owner cares about (every species can be seen or heard, no caves, calm
 * short lines, true and complete hints) and the shape the ecology and renderers rely on.
 */
import { describe, expect, it } from 'vitest';
import { SPECIES, speciesByKey } from '../src/content/species';
import {
  AGES,
  ALL_PLACES,
  FIRSTS,
  GUIDE_GROUPS,
  MILESTONES,
  MOMENTS,
  ageName,
  entryText,
  firstName,
  guideGroupName,
  inspectText,
  placeInfo,
  placeLabel,
  reasonLine,
  roadWord,
  type MilestoneKey,
  type MomentKey,
} from '../src/content/stories';
import {
  ANIMAL_MODEL_COUNT,
  HABITAT_COUNT,
  Habitat,
  PLANT_MODEL_COUNT,
  PlantModel,
  Substrate,
  isSeaHabitat,
  type AgeId,
  type Behaviour,
  type GuideGroup,
  type PlaceKind,
  type PlantLayer,
  type Road,
  type VoiceKind,
} from '../src/content/speciesTypes';
import type { EcoNeeds, ReasonCode } from '../src/eco/needs';
import type { InspectInfo, JournalEntry, JournalKind } from '../src/engine/protocol';

// Exhaustive lists: TypeScript fails to compile if a union gains or loses a member.
const REASON_SET: Record<ReasonCode, true> = {
  'no-land': true, 'no-beach': true, 'no-dune': true, 'no-cliff': true, 'no-stack': true, 'no-rock-shore': true, 'no-soil': true,
  'thin-soil': true, 'too-dry': true, 'too-wet': true, 'too-salty': true, 'too-small': true, 'too-low': true, 'too-tall': true,
  'no-fresh-water': true, 'no-salt-pond': true, 'no-stream': true, 'no-shelter': true, 'no-lagoon': true, 'no-reef': true,
  'no-seagrass': true, 'no-mangrove': true, 'no-open-ground': true, 'no-grass': true, 'no-shrubs': true, 'no-trees': true,
  'no-forest': true, 'no-cloud-forest': true, 'no-flowers': true, 'no-fruit': true, 'no-prey': true, 'no-host': true,
  'no-warm-ground': true, 'no-summit': true, predators: true, 'needs-island-nearby': true, 'too-far': true, 'hot-lava': true,
  'needs-storm': true,
};
const KIND_SET: Record<JournalKind, true> = {
  'first-land': true, 'new-island': true, 'islands-joined': true, 'island-lost': true, arrival: true, visit: true, return: true,
  lost: true, storm: true, place: true, first: true, age: true, moment: true, milestone: true, 'lava-buried': true, hint: true, ending: true,
};
const PLACE_SET: Record<PlaceKind, true> = {
  'lava-field': true, 'sea-cliff': true, 'sea-stack': true, beach: true, 'turtle-beach': true, dune: true, 'rock-shore': true,
  'rock-basin': true, pond: true, 'salt-pond': true, stream: true, lagoon: true, reef: true, seagrass: true, 'mangrove-shore': true,
  'cloud-peak': true, 'rain-shadow': true, summit: true, 'warm-ground': true, islet: true, spit: true, sound: true,
};
const AGE_SET: Record<AgeId, true> = { stone: true, lichen: true, green: true, wings: true, forest: true, chain: true, song: true };
const ROAD_SET: Record<Road, true> = { wind: true, sea: true, raft: true, bird: true, flight: true, storm: true };
const GROUP_SET: Record<GuideGroup, true> = { plants: true, birds: true, sea: true, small: true, land: true };
const BEHAVIOUR_SET: Record<Behaviour, true> = {
  colony: true, soar: true, flit: true, wade: true, 'run-shore': true, paddle: true, 'night-fly': true, scuttle: true, bask: true,
  graze: true, 'nest-beach': true, shoal: true, 'glide-sea': true, porpoise: true, 'surface-blow': true, flutter: true, hover: true,
  buzz: true, glow: true, 'haul-out': true, web: true, creep: true,
};
const VOICE_SET: Record<VoiceKind, true> = {
  trill: true, coo: true, kee: true, honk: true, wail: true, peep: true, whistle: true, squawk: true, hoot: true, chirp: true,
  cricket: true, cicada: true, 'frog-coqui': true, 'frog-croak': true, gecko: true, bat: true, whale: true, seal: true, buzz: true,
  colony: true, clatter: true, quack: true, click: true, rustle: true,
};
const REASONS = Object.keys(REASON_SET) as ReasonCode[];
const KINDS = Object.keys(KIND_SET) as JournalKind[];
const PLACES = Object.keys(PLACE_SET) as PlaceKind[];

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const isColour = (c: number | undefined): boolean => c === undefined || (Number.isInteger(c) && c >= 0 && c <= 0xffffff);
const inRange = (v: number | undefined, lo: number, hi: number): boolean => v === undefined || (Number.isFinite(v) && v >= lo && v <= hi);
const ascending = (a: readonly number[] | undefined): boolean => !a || a.every((v, i) => i === 0 || v >= a[i - 1]);

/** Every display string of a species, with a label for failures. */
function textsOf(s: (typeof SPECIES)[number]): [string, string][] {
  return [
    ['name', s.name],
    ['fact', s.fact],
    ['arrive', s.text.arrive],
    ['seen', s.text.seen],
    ['back', s.text.back],
    ['lost', s.text.lost],
    ['hint0', s.hint[0]],
    ['hint1', s.hint[1]],
    ['hint2', s.hint[2]],
    ['needs', s.needs],
  ];
}

/** Which layer each plant archetype belongs in (sea plants follow the same rule). */
const MODEL_LAYER: Record<number, PlantLayer> = {
  [PlantModel.Tint]: 'ground',
  [PlantModel.Fern]: 'herb',
  [PlantModel.Grass]: 'herb',
  [PlantModel.DuneGrass]: 'herb',
  [PlantModel.Sedge]: 'herb',
  [PlantModel.Vine]: 'herb',
  [PlantModel.Mat]: 'herb',
  [PlantModel.Herb]: 'herb',
  [PlantModel.Seagrass]: 'herb',
  [PlantModel.Lily]: 'herb',
  [PlantModel.Epiphyte]: 'herb',
  [PlantModel.TreeFern]: 'shrub',
  [PlantModel.SeaGrape]: 'shrub',
  [PlantModel.Shrub]: 'shrub',
  [PlantModel.Cactus]: 'shrub',
  [PlantModel.Silversword]: 'shrub',
  [PlantModel.Coral]: 'shrub',
  [PlantModel.Palm]: 'canopy',
  [PlantModel.Pandanus]: 'canopy',
  [PlantModel.Mangrove]: 'canopy',
  [PlantModel.Fig]: 'canopy',
  [PlantModel.PomTree]: 'canopy',
  [PlantModel.Broadleaf]: 'canopy',
  [PlantModel.CloudTree]: 'canopy',
  [PlantModel.SheOak]: 'canopy',
};

describe('species catalogue: shape', () => {
  it('has about 90 species, balanced across the guide', () => {
    expect(SPECIES.length).toBeGreaterThanOrEqual(85);
    expect(SPECIES.length).toBeLessThanOrEqual(95);
    const count = (g: GuideGroup) => SPECIES.filter((s) => s.guide === g).length;
    expect(count('plants')).toBeGreaterThanOrEqual(35);
    expect(count('plants')).toBeLessThanOrEqual(40);
    expect(count('birds')).toBeGreaterThanOrEqual(20);
    expect(count('birds')).toBeLessThanOrEqual(25);
    expect(count('sea')).toBeGreaterThanOrEqual(12);
    expect(count('sea')).toBeLessThanOrEqual(15);
    expect(count('small')).toBeGreaterThanOrEqual(10);
    expect(count('small')).toBeLessThanOrEqual(12);
    expect(count('land')).toBeGreaterThanOrEqual(6);
    expect(count('land')).toBeLessThanOrEqual(8);
  });

  it('has unique keys, ids equal to the index, and lookups by key', () => {
    const keys = new Set<string>();
    SPECIES.forEach((s, i) => {
      expect(s.id, s.key).toBe(i);
      expect(s.key, s.key).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(keys.has(s.key), `duplicate ${s.key}`).toBe(false);
      keys.add(s.key);
      expect(speciesByKey(s.key)).toBe(s);
    });
    expect(speciesByKey('no-such-species')).toBeUndefined();
    expect(new Set(SPECIES.map((s) => s.name)).size).toBe(SPECIES.length);
    expect(new Set(SPECIES.map((s) => s.sci)).size).toBe(SPECIES.length);
  });

  it('gives every species something to see or hear', () => {
    for (const s of SPECIES) {
      const sign = (s.plant !== undefined) || (s.animal !== undefined && s.animal.max > 0) || s.voice !== undefined || s.effect !== undefined;
      expect(sign, s.key).toBe(true);
    }
  });

  it('has no cave species (the ground has no caves)', () => {
    for (const s of SPECIES) {
      const all = [s.key, s.sci, ...textsOf(s).map(([, t]) => t)].join(' ').toLowerCase();
      expect(all, s.key).not.toMatch(/\bcaves?\b|swiftlet|lava tube/);
    }
  });

  it('dresses every plant in a valid model, layer and colours', () => {
    for (const s of SPECIES.filter((x) => x.kind === 'plant')) {
      const look = s.plant;
      expect(look, s.key).toBeDefined();
      if (!look) continue;
      expect(s.animal, s.key).toBeUndefined();
      expect(look.model >= 0 && look.model < PLANT_MODEL_COUNT, s.key).toBe(true);
      expect(s.layer, s.key).toBe(MODEL_LAYER[look.model]);
      expect(look.model === PlantModel.Tint, `${s.key} tint`).toBe(look.tint !== undefined);
      for (const c of [look.leaf, look.leaf2, look.flower, look.trunk, look.fruit]) expect(isColour(c), s.key).toBe(true);
      expect(look.size > 0 && look.size <= 3, s.key).toBe(true);
      expect(s.guide === 'plants' || s.guide === 'sea', s.key).toBe(true);
      if (s.guide === 'sea') expect(s.marine, s.key).toBe(true);
    }
  });

  it('gives every animal a valid body, behaviour, habitats, colours and pace', () => {
    for (const s of SPECIES.filter((x) => x.kind === 'animal')) {
      expect(s.plant, s.key).toBeUndefined();
      expect(s.layer, s.key).toBeUndefined();
      expect(['birds', 'sea', 'small', 'land']).toContain(s.guide);
      const a = s.animal;
      if (!a) {
        expect(s.voice !== undefined || s.effect !== undefined, `${s.key} has no body, voice or effect`).toBe(true);
        continue;
      }
      expect(a.model >= 0 && a.model < ANIMAL_MODEL_COUNT, s.key).toBe(true);
      expect(BEHAVIOUR_SET[a.behaviour], s.key).toBe(true);
      expect(a.colors.every((c) => isColour(c)), s.key).toBe(true);
      expect(a.size > 0 && a.size <= 20, s.key).toBe(true);
      expect(a.speed >= 0 && a.speed <= 15, s.key).toBe(true);
      expect(Number.isInteger(a.max) && a.max >= 1 && a.max <= 40, s.key).toBe(true);
      expect(['day', 'night', 'dusk', 'any']).toContain(a.active);
      expect(a.where.length, s.key).toBeGreaterThan(0);
      for (const h of a.where) expect(Number.isInteger(h) && h > 0 && h < HABITAT_COUNT, s.key).toBe(true);
    }
  });

  it('spawns animals only where their behaviour makes sense', () => {
    const swim: Behaviour[] = ['shoal', 'glide-sea', 'porpoise', 'surface-blow'];
    const ground: Behaviour[] = ['scuttle', 'bask', 'graze', 'creep', 'web', 'haul-out', 'run-shore', 'flutter', 'buzz', 'glow', 'flit', 'colony', 'wade'];
    const freshWater = [Habitat.Pond, Habitat.Marsh, Habitat.Stream, Habitat.SaltPond];
    for (const s of SPECIES) {
      const a = s.animal;
      if (!a) continue;
      if (swim.includes(a.behaviour)) expect(a.where.every((h) => isSeaHabitat(h)), `${s.key} swims on land`).toBe(true);
      if (ground.includes(a.behaviour)) expect(a.where.some((h) => !isSeaHabitat(h)), `${s.key} has nowhere on land`).toBe(true);
      if (a.behaviour === 'nest-beach') expect(a.where).toContain(Habitat.Beach);
      if (a.behaviour === 'haul-out') expect(a.where).toContain(Habitat.Beach);
      if (a.behaviour === 'paddle' || a.behaviour === 'hover') expect(a.where.every((h) => freshWater.includes(h as never)), s.key).toBe(true);
      if (s.marine) expect(s.guide, s.key).toBe('sea');
    }
  });

  it('uses every plant model and every animal body plan', () => {
    const plantModels = new Set(SPECIES.map((s) => s.plant?.model).filter((m) => m !== undefined));
    const animalModels = new Set(SPECIES.map((s) => s.animal?.model).filter((m) => m !== undefined));
    expect(plantModels.size).toBe(PLANT_MODEL_COUNT);
    expect(animalModels.size).toBe(ANIMAL_MODEL_COUNT);
    const behaviours = new Set(SPECIES.map((s) => s.animal?.behaviour).filter(Boolean));
    expect(behaviours.size).toBe(Object.keys(BEHAVIOUR_SET).length);
  });

  it('gives the things you can hear a sensible voice', () => {
    for (const s of SPECIES) {
      const v = s.voice;
      if (!v) continue;
      expect(VOICE_SET[v.kind], s.key).toBe(true);
      expect(v.pitch >= 50 && v.pitch <= 12000, s.key).toBe(true);
      expect(v.rate > 0 && v.rate <= 60, s.key).toBe(true);
      expect(v.loud > 0 && v.loud <= 1, s.key).toBe(true);
      expect(['day', 'night', 'dusk', 'dawn', 'any']).toContain(v.when);
    }
    // The soundscape grows: birds, insects, frogs, geckos, bats, whales and seals all have voices.
    const voiced = new Set(SPECIES.filter((s) => s.voice).map((s) => s.voice!.kind));
    for (const k of ['cricket', 'frog-coqui', 'gecko', 'bat', 'whale', 'seal', 'wail', 'colony', 'trill', 'coo'] as VoiceKind[]) expect(voiced.has(k), k).toBe(true);
    expect(SPECIES.filter((s) => s.guide === 'birds' && s.voice).length).toBeGreaterThanOrEqual(18);
  });

  it('has the two water effects: glowing plankton and pink brine shrimp ponds', () => {
    expect(speciesByKey('plankton')?.effect).toBe('glow');
    expect(speciesByKey('brine-shrimp')?.effect).toBe('pink-pond');
  });

  it('uses every road', () => {
    const roads = new Set(SPECIES.flatMap((s) => s.roads));
    for (const r of Object.keys(ROAD_SET) as Road[]) expect(roads.has(r), r).toBe(true);
    for (const s of SPECIES) expect(s.roads.length, s.key).toBeGreaterThan(0);
  });
});

describe('species catalogue: words', () => {
  it('keeps every line short, finished and free of stray placeholders', () => {
    for (const s of SPECIES) {
      for (const [label, t] of textsOf(s)) {
        expect(t.trim().length, `${s.key} ${label}`).toBeGreaterThan(0);
        expect(t, `${s.key} ${label}`).not.toMatch(/['‘`]/); // curly apostrophes only; ʻokina is U+02BB
        expect(t, `${s.key} ${label}`).not.toMatch(/undefined|NaN|TODO/);
        const holes = t.match(/\{[^}]*\}/g) ?? [];
        for (const h of holes) expect(['{place}', '{isl}', '{from}'], `${s.key} ${label}`).toContain(h);
        expect(t.replace(/\{(place|isl|from)\}/g, ''), `${s.key} ${label}`).not.toMatch(/[{}]/);
        if (label !== 'name') expect(t, `${s.key} ${label}`).toMatch(/[.!?]$/);
      }
      expect(words(s.fact), `${s.key} fact`).toBeLessThanOrEqual(30);
      for (const k of ['arrive', 'seen', 'back', 'lost'] as const) expect(words(s.text[k]), `${s.key} ${k}`).toBeLessThanOrEqual(25);
      for (const h of s.hint) expect(words(h), `${s.key} hint`).toBeLessThanOrEqual(25);
      expect(words(s.needs), `${s.key} needs`).toBeLessThanOrEqual(12);
      expect(s.sci.length, s.key).toBeGreaterThan(3);
    }
  });

  it('writes Hawaiian words with the ʻokina, never a quote mark', () => {
    const hawaiian = SPECIES.filter((s) => /ʻ/.test(s.name));
    expect(hawaiian.length).toBeGreaterThanOrEqual(6);
    for (const s of SPECIES) expect(s.name, s.key).not.toMatch(/[‘']/);
  });

  it('has three different hints that sharpen: riddle, plain need, then a direct line', () => {
    for (const s of SPECIES) {
      expect(new Set(s.hint).size, s.key).toBe(3);
      expect(s.hint[0].toLowerCase(), `${s.key} riddle gives the name away`).not.toContain(s.name.toLowerCase());
      expect(s.hint[2].startsWith(`${s.name}:`), `${s.key} direct line should start with its name`).toBe(true);
      expect(s.needs.startsWith('Needs'), s.key).toBe(true);
    }
  });

  it('has a different true fact for every species', () => {
    expect(new Set(SPECIES.map((s) => s.fact)).size).toBe(SPECIES.length);
  });
});

describe('species catalogue: what life needs', () => {
  const eco = (s: (typeof SPECIES)[number]): EcoNeeds => s.eco;

  it('keeps every number in a sane range', () => {
    const substrates = Object.values(Substrate) as number[];
    for (const s of SPECIES) {
      const e = eco(s);
      const k = s.key;
      expect(e.rate > 0 && e.rate <= 20, k).toBe(true);
      expect(inRange(e.reach, 0.01, 1), k).toBe(true);
      expect(e.hop > 0 && e.hop <= 20000, k).toBe(true);
      expect(e.grow > 0 && e.grow <= 500, k).toBe(true);
      expect(inRange(e.life, 1, 1000), k).toBe(true);
      expect(inRange(e.spread, 0, 10), k).toBe(true);
      for (const f of [e.saltMax, e.shade, e.fert]) expect(inRange(f, 0, 1), k).toBe(true);
      expect(inRange(e.slopeMax, 1, 90), k).toBe(true);
      if (e.moist) {
        expect(e.moist.length, k).toBe(4);
        expect(ascending(e.moist) && e.moist.every((v) => v >= 0 && v <= 1), `${k} moist`).toBe(true);
      }
      if (e.soil) expect(ascending(e.soil) && e.soil[0] >= 0 && e.soil[1] > 0 && e.soil[1] <= 1, `${k} soil`).toBe(true);
      if (e.alt) expect(e.alt[0] < e.alt[1] && e.alt[0] >= -5 && e.alt[1] <= 200, `${k} alt`).toBe(true);
      if (e.depth) expect(e.depth[0] < e.depth[1] && e.depth[0] >= 0 && e.depth[1] <= 30, `${k} depth`).toBe(true);
      for (const sub of e.substrate ?? []) expect(substrates, k).toContain(sub);
      expect(e.substrate?.includes(Substrate.HotLava) ?? false, `${k} on hot lava`).toBe(false);
      for (const h of e.habitats ?? []) expect(Number.isInteger(h) && h > 0 && h < HABITAT_COUNT, k).toBe(true);
      for (const p of e.places ?? []) expect(PLACE_SET[p], `${k} place ${p}`).toBe(true);
      expect(REASON_SET[e.mainNeed], k).toBe(true);
      if (e.minPatches !== undefined) expect(Number.isInteger(e.minPatches) && e.minPatches >= 1, k).toBe(true);
      if (e.minArea !== undefined) expect(e.minArea > 0, k).toBe(true);
      if (e.maxPeak !== undefined) expect(e.maxPeak > (e.minPeak ?? 0), k).toBe(true);
      if (e.nearIsland !== undefined) expect(e.nearIsland > 0 && e.nearIsland < 1024, k).toBe(true);
      const g = e.gives ?? {};
      expect(inRange(g.soil, 0, 0.2), `${k} soil gift`).toBe(true);
      for (const v of [g.nitrogen, g.guano, g.fruit, g.nectar, g.seeds, g.insects, g.dune, g.nests, g.sand]) expect(inRange(v, 0, 1), k).toBe(true);
    }
  });

  it('keeps plant-only and animal-only needs on the right kind', () => {
    for (const s of SPECIES) {
      const e = eco(s);
      if (s.kind === 'plant') {
        expect(e.minPatches === undefined && e.noPredators === undefined && e.predator === undefined && e.requires === undefined, s.key).toBe(true);
        expect(e.life !== undefined && e.spread !== undefined, s.key).toBe(true);
      } else {
        expect(e.substrate === undefined && e.soil === undefined && e.spread === undefined && e.life === undefined, s.key).toBe(true);
      }
      if (s.marine && s.kind === 'plant') expect(e.depth, s.key).toBeDefined();
    }
  });

  it('only requires species that exist, never itself, and never in a circle', () => {
    for (const s of SPECIES) for (const r of eco(s).requires ?? []) {
      expect(speciesByKey(r), `${s.key} requires ${r}`).toBeDefined();
      expect(r, s.key).not.toBe(s.key);
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (key: string, path: string[]): void => {
      if (state.get(key) === 'done') return;
      expect(state.get(key), `circular needs: ${[...path, key].join(' -> ')}`).not.toBe('visiting');
      state.set(key, 'visiting');
      for (const r of eco(speciesByKey(key)!).requires ?? []) visit(r, [...path, key]);
      state.set(key, 'done');
    };
    for (const s of SPECIES) visit(s.key, []);
  });

  it('never makes a plant wait for a habitat only it can create', () => {
    const forest = [Habitat.Forest, Habitat.WetForest, Habitat.CloudForest];
    for (const s of SPECIES.filter((x) => x.kind === 'plant')) {
      const hs = eco(s).habitats;
      if (!hs) continue;
      if (s.layer === 'canopy') expect(hs.some((h) => !forest.includes(h as never)), `${s.key} needs a forest to make a forest`).toBe(true);
      if (s.plant?.model === PlantModel.Seagrass) expect(hs.some((h) => h !== Habitat.Seagrass), s.key).toBe(true);
      if (s.plant?.model === PlantModel.Mangrove) expect(hs.includes(Habitat.Mangrove), s.key).toBe(false);
      if (s.plant?.model === PlantModel.Coral) expect(hs.includes(Habitat.Reef), s.key).toBe(false);
    }
  });

  it('makes storm-only arrivals come by raft or storm, and has an egg-eater for the islets to escape', () => {
    for (const s of SPECIES.filter((x) => eco(x).stormOnly)) expect(s.roads.some((r) => r === 'storm' || r === 'raft'), s.key).toBe(true);
    expect(SPECIES.some((s) => eco(s).predator)).toBe(true);
    expect(SPECIES.filter((s) => eco(s).noPredators).length).toBeGreaterThanOrEqual(2);
  });

  it('makes the beat sheet possible (ARCHITECTURE §4)', () => {
    const e = (k: string) => eco(speciesByKey(k)!);
    // ≤ 20 s: a wind pioneer that needs nothing but cool land.
    const pioneers = SPECIES.filter((s) => s.roads.includes('wind') && eco(s).rate >= 8);
    expect(pioneers.some((s) => s.kind === 'animal' && !eco(s).habitats && !eco(s).requires && !eco(s).places)).toBe(true);
    // ~1 min: lichen on bare lava, needing no soil.
    expect(e('lichen').soil?.[0]).toBe(0);
    // The soil ladder sets the order on rock: lichen, moss, ferns, grass, shrubs, trees.
    const minSoil = (k: string) => e(k).soil?.[0] ?? 0;
    const ladder = ['lichen', 'woolly-moss', 'amau', 'pili', 'aalii', 'ohia', 'hapuu', 'koa'];
    for (let i = 1; i < ladder.length; i++) expect(minSoil(ladder[i]), ladder[i]).toBeGreaterThan(minSoil(ladder[i - 1]));
    // Minutes after a beach: sea-borne beach plants come often; coconuts root in bare sand.
    for (const k of ['sea-rocket', 'morning-glory', 'purslane', 'coconut']) expect(e(k).rate, k).toBeGreaterThanOrEqual(1);
    expect(minSoil('coconut')).toBe(0);
    // Something walks soon: crabs on a beach or a rocky shore.
    expect(e('ghost-crab').rate).toBeGreaterThanOrEqual(1);
    expect(e('sally-lightfoot').rate).toBeGreaterThanOrEqual(1);
    // A seabird can visit and be turned away by something the player can build.
    expect(e('brown-booby').places).toContain('sea-cliff');
    // Chain-only life: things a single tall island can't give.
    expect(SPECIES.some((s) => eco(s).nearIsland !== undefined)).toBe(true);
    expect(SPECIES.some((s) => eco(s).maxPeak !== undefined)).toBe(true);
    expect(SPECIES.some((s) => eco(s).places?.includes('islet'))).toBe(true);
    // The ending's whales need only the Sound.
    expect(e('humpback').places).toEqual(['sound']);
    expect(e('humpback').requires).toBeUndefined();
  });

  it('spreads arrivals across early, mid and late, and common to rare', () => {
    const r = (x: string) => SPECIES.filter((s) => s.rarity === x).length;
    expect(r('common')).toBeGreaterThan(r('uncommon'));
    expect(r('rare')).toBeGreaterThanOrEqual(8);
    expect(SPECIES.filter((s) => eco(s).rate >= 2).length).toBeGreaterThanOrEqual(8);
    expect(SPECIES.filter((s) => eco(s).rate < 0.3).length).toBeGreaterThanOrEqual(8);
  });
});

describe('stories', () => {
  const islandName = (id: number) => ['', 'High Island', 'White Cay', 'Booby Rocks'][id] ?? '';
  const checkLine = (t: string, what: string) => {
    expect(t.trim().length, what).toBeGreaterThan(0);
    expect(t, what).not.toMatch(/[{}]|undefined|NaN|\[object/);
    expect(t, what).toMatch(/[.!?]$/);
    expect(words(t), what).toBeLessThanOrEqual(40);
  };

  it('names and explains every place', () => {
    expect([...ALL_PLACES].sort()).toEqual([...PLACES].sort());
    for (const k of PLACES) {
      expect(placeLabel(k).length, k).toBeGreaterThan(2);
      const info = placeInfo(k);
      expect(info.name.length && info.makes.length && info.brings.length, k).toBeTruthy();
    }
  });

  it('has seven Ages, each with a chapter line', () => {
    expect(AGES.map((a) => a.id).sort()).toEqual((Object.keys(AGE_SET) as AgeId[]).sort());
    for (const a of AGES) {
      expect(ageName(a.id)).toBe(a.name);
      checkLine(a.line, a.id);
    }
  });

  it('has about two dozen Firsts, including every one the ecology awards', () => {
    expect(FIRSTS.length).toBeGreaterThanOrEqual(22);
    expect(new Set(FIRSTS.map((f) => f.key)).size).toBe(FIRSTS.length);
    const needed = ['first-land', 'first-life', 'first-animal', 'first-flower', 'first-tree', 'first-forest', 'first-nest', 'first-cloud', 'first-pond',
      'first-song', 'first-reef', 'first-turtle-nest', 'first-storm', 'first-castaway', 'second-island', 'first-seabird-city', 'first-island-hopper',
      'first-lagoon', 'first-whale'];
    for (const k of needed) expect(FIRSTS.some((f) => f.key === k), k).toBe(true);
    for (const f of FIRSTS) {
      expect(firstName(f.key)).toBe(f.name);
      checkLine(f.line, f.key);
      checkLine(f.hint, f.key);
    }
  });

  it('says plainly why, for every reason a visitor can be turned away', () => {
    for (const r of REASONS) checkLine(reasonLine(r), r);
    expect(new Set(REASONS.map(reasonLine)).size).toBe(REASONS.length);
  });

  it('has words for every road and guide group', () => {
    for (const r of Object.keys(ROAD_SET) as Road[]) expect(roadWord(r).length, r).toBeGreaterThan(3);
    for (const g of Object.keys(GROUP_SET) as GuideGroup[]) expect(guideGroupName(g).length, g).toBeGreaterThan(3);
    expect(GUIDE_GROUPS.length).toBe(5);
  });

  it('writes one calm line for every journal kind, with or without details', () => {
    const turtle = speciesByKey('green-turtle')!.id;
    const rich: Record<JournalKind, Partial<JournalEntry>> = {
      'first-land': {},
      'new-island': { island: 2, params: { count: 2 } },
      'islands-joined': { island: 1, params: { other: 2 } },
      'island-lost': { island: 3 },
      arrival: { species: turtle, island: 1, place: 'turtle-beach', road: 'flight' },
      visit: { species: turtle, island: 1, params: { reason: 'no-beach' } },
      return: { species: turtle, island: 1, place: 'beach' },
      lost: { species: turtle },
      storm: { island: 1, params: { great: 1, castaway: speciesByKey('iguana')!.id } },
      place: { place: 'sea-cliff', island: 1, params: { waiting: speciesByKey('brown-booby')!.id } },
      first: { first: 'first-tree', species: speciesByKey('coconut')!.id, island: 2 },
      age: { age: 'green' },
      moment: { island: 1, params: { moment: 'hatchlings' } },
      milestone: { params: { milestone: 'rakata', count: 26 } },
      'lava-buried': { species: speciesByKey('ohia')!.id, island: 1 },
      hint: { params: { text: 'An island to the east would help.' } },
      ending: {},
    };
    for (const kind of KINDS) {
      const base: JournalEntry = { id: 1, year: 100, kind, headline: true };
      checkLine(entryText({ ...base, ...rich[kind] }, SPECIES, islandName), `${kind} (rich)`);
      checkLine(entryText(base, SPECIES, islandName), `${kind} (bare)`);
      // No year ever appears in the line itself.
      expect(entryText({ ...base, ...rich[kind] }, SPECIES, islandName), kind).not.toContain('100');
    }
  });

  it('tells visits in the species’ own words, or plainly when the reason differs', () => {
    const turtle = speciesByKey('green-turtle')!;
    const base: JournalEntry = { id: 1, year: 5, kind: 'visit', species: turtle.id, island: 1, headline: true };
    expect(entryText(base, SPECIES, islandName)).toBe(turtle.text.seen.replace('{isl}', 'High Island'));
    const other = entryText({ ...base, params: { reason: 'predators' } }, SPECIES, islandName);
    expect(other).toContain(reasonLine('predators'));
    expect(other).toContain('green turtle');
  });

  it('fills every species line for every place without leaving holes', () => {
    for (const s of SPECIES) {
      for (const kind of ['arrival', 'visit', 'return', 'lost'] as JournalKind[]) {
        for (const place of [undefined, ...PLACES]) {
          const t = entryText({ id: 1, year: 1, kind, species: s.id, island: 3, place, headline: true }, SPECIES, islandName);
          expect(t, `${s.key} ${kind} ${place}`).not.toMatch(/[{}]|undefined/);
        }
      }
      // A place kind saved by an older version still reads (as the island's name).
      const old = entryText({ id: 1, year: 1, kind: 'arrival', species: s.id, island: 1, place: 'old-place' as PlaceKind, headline: true }, SPECIES, islandName);
      expect(old, `${s.key} old place`).not.toMatch(/[{}]|undefined/);
      const hop = entryText({ id: 1, year: 1, kind: 'arrival', species: s.id, island: 2, road: s.roads[0], params: { from: 1 }, headline: true }, SPECIES, islandName);
      checkLine(hop, `${s.key} hop`);
      expect(hop).toContain('High Island');
      expect(hop).toContain('White Cay');
    }
  });

  it('has a line for every Moment and milestone', () => {
    for (const k of Object.keys(MOMENTS) as MomentKey[]) {
      checkLine(entryText({ id: 1, year: 1, kind: 'moment', island: 1, params: { moment: k }, headline: true }, SPECIES, islandName), k);
    }
    for (const k of Object.keys(MILESTONES) as MilestoneKey[]) {
      checkLine(entryText({ id: 1, year: 1, kind: 'milestone', params: { milestone: k, count: 30 }, headline: true }, SPECIES, islandName), k);
    }
  });

  it('describes any ground in one plain sentence (Look)', () => {
    const id = (k: string) => speciesByKey(k)!.id;
    const base: InspectInfo = {
      x: 0, z: 0, island: 1, islandName: 'High Island', height: 12, depth: 0, substrate: Substrate.Basalt, groundAge: 0, rain: 0.5,
      moist: 0.5, salt: 0.1, soil: 0, windward: 0, habitat: Habitat.BareRock, layers: { canopy: -1, shrub: -1, herb: -1, ground: -1 },
    };
    const cases: [string, Partial<InspectInfo>][] = [
      ['fresh lava', {}],
      ['hot lava', { substrate: Substrate.HotLava, habitat: Habitat.HotLava }],
      ['lichen', { groundAge: 80, rain: 0.8, windward: 0.6, moist: 0.7, soil: 0.004, layers: { canopy: -1, shrub: -1, herb: -1, ground: id('lichen') } }],
      ['wet forest', { groundAge: 2000, rain: 0.9, windward: 0.7, moist: 0.8, soil: 0.3, habitat: Habitat.WetForest, layers: { canopy: id('ohia'), shrub: id('hapuu'), herb: id('amau'), ground: id('woolly-moss') } }],
      ['dry side', { groundAge: 600, rain: 0.15, windward: -0.6, moist: 0.2, soil: 0.04, habitat: Habitat.Scrub, layers: { canopy: -1, shrub: id('prickly-pear'), herb: id('pili'), ground: -1 } }],
      ['beach', { substrate: Substrate.Sand, height: 1.5, salt: 0.9, habitat: Habitat.Beach, layers: { canopy: id('coconut'), shrub: -1, herb: id('morning-glory'), ground: -1 } }],
      ['bare beach', { substrate: Substrate.Sand, height: 1.5, salt: 0.7, habitat: Habitat.Beach }],
      ['cliff', { substrate: Substrate.Stone, habitat: Habitat.Cliff, groundAge: 300 }],
      ['summit', { groundAge: 900, height: 150, habitat: Habitat.Summit, moist: 0.3, layers: { canopy: -1, shrub: id('silversword'), herb: -1, ground: -1 } }],
      ['pond', { substrate: Substrate.Pond, habitat: Habitat.Pond, layers: { canopy: -1, shrub: -1, herb: id('makaloa'), ground: -1 } }],
      ['salt pond', { substrate: Substrate.Pond, habitat: Habitat.SaltPond }],
      ['deep sea', { substrate: Substrate.Sea, height: -28, depth: 28, habitat: Habitat.DeepSea }],
      ['reef', { substrate: Substrate.Sea, height: -3, depth: 3, habitat: Habitat.Reef, layers: { canopy: -1, shrub: id('coral'), herb: -1, ground: id('coralline') } }],
      ['lagoon', { substrate: Substrate.Sea, height: -2, depth: 2, habitat: Habitat.Lagoon, layers: { canopy: -1, shrub: -1, herb: id('turtle-grass'), ground: -1 } }],
      ['sound', { substrate: Substrate.Sea, height: -20, depth: 20, habitat: Habitat.Sound }],
      ['why', { groundAge: 200, soil: 0.01, why: 'Ferns need a little more soil here.' }],
    ];
    for (const [label, over] of cases) {
      const t = inspectText({ ...base, ...over }, SPECIES);
      checkLine(t, label);
      expect(t.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length, `${label}: one sentence`).toBe(1);
    }
    expect(inspectText({ ...base, groundAge: 2000, soil: 0.3, habitat: Habitat.WetForest, layers: { canopy: id('ohia'), shrub: -1, herb: -1, ground: -1 } }, SPECIES)).toContain('ʻōhiʻa lehua');
    expect(inspectText({ ...base, groundAge: 200, soil: 0.01, why: 'Ferns need a little more soil here.' }, SPECIES)).toContain('ferns need a little more soil here');
  });
});
