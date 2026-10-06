/**
 * Every word the game says about its world: journal lines, place labels, the Ages and Firsts,
 * Moments and milestones, the plain "why it couldn't stay" reasons, and the one-sentence Look
 * description of any patch of ground or sea.
 *
 * The voice: calm, kind and plain, like a naturalist's field notebook. Never alarmed, never a
 * number on the main screen except in the journal. A lovely real word (kīpuka, kōlea) is
 * explained in the same sentence. No line here shows a year: the journal adds the year stamp.
 *
 * What each journal kind reads (JournalEntry fields and `params`), so the ecology knows what
 * to fill in. Everything is optional; every kind still reads well with nothing but its kind.
 *   first-land      nothing.
 *   new-island      island; params.count = how many islands there are now.
 *   islands-joined  island; params.other = the other island (id or name).
 *   island-lost     island.
 *   arrival         species, island, road, place; params.from = the island it spread from
 *                   (makes it an island-hop line instead of the species' first-arrival line).
 *   visit           species, island, place; params.reason = the ReasonCode it couldn't stay for.
 *                   When that is the species' own main need, its own "seen" line is used;
 *                   otherwise a plain line built from reasonLine().
 *   return, lost    species, island, place.
 *   storm           island; params.great (1 = a great storm), params.fallen (trees felled),
 *                   params.raft (1 = a raft of branches came ashore); the castaway it brought
 *                   as species (or params.castaway), and how it came as road ('raft', or
 *                   'storm' for a bird blown off course; if missing, the castaway's own roads
 *                   decide: rafters and floaters came on the raft, everything else on the wind).
 *   place           place, island; params.waiting = a species id that visited before and
 *                   needed exactly this place.
 *   first           first (a FIRSTS key), species, island.
 *   age             age.
 *   moment          island; params.moment = a MOMENTS key.
 *   milestone       params.milestone = a MILESTONES key; params.count = the number it marks.
 *   lava-buried     species (the main plant covered), island; params.kipuka = 1 when lava
 *                   flowed around living ground and left it standing.
 *   hint            params.text (the line itself), or species + params.level (0..2: which of
 *                   its field-guide hints), or params.reason.
 *   ending          nothing.
 * Placeholders inside species lines: {place} (e.g. "High Island’s beach"), {isl} (the island's
 * name), {from} (the island it came from, or the old islands).
 */
import { Habitat, Substrate, type AgeId, type GuideGroup, type PlaceKind, type Road, type SpeciesDef } from './speciesTypes';
import type { InspectInfo, JournalEntry } from '../engine/protocol';
import type { ReasonCode } from '../eco/needs';

// =======================================================================================
// Firsts and Ages
// =======================================================================================

export interface FirstDef {
  key: string;
  name: string;
  /** The journal line when the first is earned. */
  line: string;
  /** How it is earned, in plain words (shown on a stamp not yet earned). */
  hint: string;
}

/** Stamps on the Firsts page, in the order they are usually earned. */
export const FIRSTS: FirstDef[] = [
  { key: 'first-land', name: 'First land', line: 'Land broke the surface of the sea.', hint: 'Raise land above the sea.' },
  { key: 'first-life', name: 'First life', line: 'The first life arrived, on the wind.', hint: 'Give the wind some land to drop life on.' },
  { key: 'first-animal', name: 'First animal', line: 'The first animal set foot on your land.', hint: 'Any cool land will do.' },
  { key: 'first-drift-seed', name: 'First drift seed', line: 'The sea carried a seed ashore, and it grew.', hint: 'Make a sandy beach for the waves to leave seeds on.' },
  { key: 'first-fern', name: 'First fern', line: 'The first fern unfurled in a crack in the rock.', hint: 'Wet lava, once lichen and moss have made a little soil.' },
  { key: 'first-flower', name: 'First flower', line: 'The first flower opened.', hint: 'Beach flowers come soonest.' },
  { key: 'first-nest', name: 'First nest', line: 'A bird built the first nest on your land.', hint: 'Seabirds want ledges, trees or open ground.' },
  { key: 'first-tree', name: 'First tree', line: 'The first tree popped up.', hint: 'A palm on a beach, or ʻōhiʻa on wet lava.' },
  { key: 'first-return', name: 'First return', line: 'A visitor that couldn’t stay came back, and stayed.', hint: 'Build what a visitor needed; it will come back.' },
  { key: 'first-storm', name: 'First storm weathered', line: 'Your islands weathered their first storm.', hint: 'Storms come in the wet season, once shrubs grow.' },
  { key: 'first-castaway', name: 'First castaway', line: 'A storm brought the first castaway, rafted in on branches or blown far off its course.', hint: 'Storms bring rafts and lost birds to windward shores.' },
  { key: 'first-forest', name: 'First forest', line: 'Trees closed overhead into a forest.', hint: 'Give trees soil and rain, and time.' },
  { key: 'first-song', name: 'First song', line: 'The first birdsong rang out over your land.', hint: 'Songbirds need shrubs and trees.' },
  { key: 'first-cloud', name: 'First cloud', line: 'Your peak caught its first cloud; rain will fall on its windward side.', hint: 'Build a peak tall enough to catch the trade-wind clouds.' },
  { key: 'first-pond', name: 'First pond', line: 'Rain filled a hollow in the rock: your first pond.', hint: 'Scoop a basin in solid rock on the rainy side.' },
  { key: 'first-night-chorus', name: 'First night chorus', line: 'Crickets, geckos and frogs sang through the night.', hint: 'Night singers need shrubs and forest.' },
  { key: 'first-reef', name: 'First reef', line: 'Coral settled on shallow rock: a reef has begun.', hint: 'Make shallow rock just under the sea.' },
  { key: 'first-turtle-nest', name: 'First turtle nest', line: 'A turtle dug the first nest in your sand.', hint: 'Pour a long, wide, gently sloping beach.' },
  { key: 'second-island', name: 'Second island', line: 'A second island rose from the sea.', hint: 'Raise new land apart from the first.' },
  { key: 'first-island-hopper', name: 'First island-hopper', line: 'Life crossed from one of your islands to another.', hint: 'Build islands close enough to hop between.' },
  { key: 'first-seabird-city', name: 'First seabird city', line: 'Seabirds filled an islet with nests and noise.', hint: 'A small islet with no egg-eaters.' },
  { key: 'first-lagoon', name: 'First lagoon', line: 'Your land closed around calm water, as an atoll holds a lagoon.', hint: 'Curve land or islands around shallow sea.' },
  { key: 'first-kipuka', name: 'First kīpuka', line: 'Lava flowed around living ground and left it standing.', hint: 'Let lava part around a patch of forest.' },
  { key: 'first-whale', name: 'First whale', line: 'Whales came into your Sound.', hint: 'Enclose deep, calm water with three or more islands.' },
];

/** The chapters of the island's story. */
export const AGES: { id: AgeId; name: string; line: string }[] = [
  { id: 'stone', name: 'The Age of Stone', line: 'There was only the sea. Then there was stone.' },
  { id: 'lichen', name: 'The Age of Lichen', line: 'The first life came on the wind, and the rock began, slowly, to soften.' },
  { id: 'green', name: 'The Age of Green', line: 'Green crept out of the cracks and up from the shore.' },
  { id: 'wings', name: 'The Age of Wings', line: 'Birds stopped passing by, and began to stay.' },
  { id: 'forest', name: 'The Age of Forests', line: 'Trees closed overhead, and the land made its own shade and rain.' },
  { id: 'chain', name: 'The Age of the Chain', line: 'One island became many, and life began to hop between them.' },
  { id: 'song', name: 'The Age of Song', line: 'From dawn to dark, the islands are full of voices.' },
];

export function ageName(age: AgeId): string {
  return AGES.find((a) => a.id === age)?.name ?? age;
}

export function firstName(key: string): string {
  return FIRSTS.find((f) => f.key === key)?.name ?? key;
}

// =======================================================================================
// Places
// =======================================================================================

interface PlaceText {
  /** Soft label shown on the land when the place is recognised. */
  label: string;
  /** Name on the Places page. */
  name: string;
  /** Short noun used inside sentences ("High Island’s sea cliff"). */
  noun: string;
  /** What makes it (the hint for an undiscovered place). */
  makes: string;
  /** Who it brings. */
  brings: string;
  /** The journal line when it first appears; {isl} is the island. */
  story: string;
}

const PLACES: Record<PlaceKind, PlaceText> = {
  'lava-field': {
    label: 'A lava field',
    name: 'Lava field',
    noun: 'lava field',
    makes: 'Fresh lava, cooled into black rock.',
    brings: 'Lichens, lava crickets, spiders and lava lizards.',
    story: 'A new lava field has cooled on {isl}; the wind will bring its first life.',
  },
  'sea-cliff': {
    label: 'A sea cliff',
    name: 'Sea cliff',
    noun: 'sea cliff',
    makes: 'A steep rock face standing straight up out of the sea.',
    brings: 'Brown boobies, tropicbirds and noddies on its ledges.',
    story: '{isl} has a sea cliff now, the kind of ledge seabirds look for.',
  },
  'sea-stack': {
    label: 'A sea stack',
    name: 'Sea stack',
    noun: 'sea stack',
    makes: 'A lone pillar of rock standing in the sea.',
    brings: 'Frigatebirds, resting high above the waves.',
    story: 'A sea stack stands off {isl}, a lonely perch above the waves.',
  },
  beach: {
    label: 'A sandy beach',
    name: 'Sandy beach',
    noun: 'beach',
    makes: 'Sand at the water’s edge, sloping gently into the sea.',
    brings: 'Beach flowers, coconuts, ghost crabs and shorebirds.',
    story: 'A sandy beach on {isl}: the waves can wash seeds ashore here.',
  },
  'turtle-beach': {
    label: 'A turtle beach',
    name: 'Turtle beach',
    noun: 'long beach',
    makes: 'A long, wide sandy beach with a gentle slope.',
    brings: 'Green turtles, crawling up at night to nest.',
    story: 'A long, soft beach on {isl}, wide enough for a turtle’s nest.',
  },
  dune: {
    label: 'Dunes',
    name: 'Dunes',
    noun: 'dunes',
    makes: 'Dry sand piled up behind a beach.',
    brings: 'Sea oats, beach peas and burrowing shearwaters.',
    story: 'Dunes have built up behind the beach on {isl}.',
  },
  'rock-shore': {
    label: 'A rocky shore',
    name: 'Rocky shore',
    noun: 'rocky shore',
    makes: 'Rock at the water’s edge, splashed by the waves.',
    brings: 'Sally Lightfoot crabs, turnstones and lava lizards.',
    story: 'A rocky shore on {isl}, splashed by every wave.',
  },
  'rock-basin': {
    label: 'A rock basin: it will hold rain',
    name: 'Rock basin',
    noun: 'rock basin',
    makes: 'A hollow in solid rock, above the sea.',
    brings: 'Rain, in time: it fills and becomes a pond.',
    story: 'A hollow in the rock of {isl}; in time, rain will fill it.',
  },
  pond: {
    label: 'A pond',
    name: 'Pond',
    noun: 'pond',
    makes: 'A rock hollow filled with fresh rainwater.',
    brings: 'Dragonflies, ducks, sedges, water fern and night herons.',
    story: 'Rain has filled a hollow on {isl}: a fresh pond.',
  },
  'salt-pond': {
    label: 'A salt pond',
    name: 'Salt pond',
    noun: 'salt pond',
    makes: 'A shallow pond close to the sea on low, dry ground, where the water turns salty.',
    brings: 'Brine shrimp, flamingos and black mangroves.',
    story: 'A shallow salt pond lies on {isl}, warm and still.',
  },
  stream: {
    label: 'A stream',
    name: 'Stream',
    noun: 'stream',
    makes: 'Rain running off a wet slope down to the sea.',
    brings: 'Night herons, dragonflies and hunting bats.',
    story: 'Rain runs off the slopes of {isl} in a little stream.',
  },
  lagoon: {
    label: 'A lagoon',
    name: 'Lagoon',
    noun: 'lagoon',
    makes: 'Calm, shallow sea almost enclosed by land.',
    brings: 'Seagrass, eagle rays, blacktip pups, spinner dolphins and godwits.',
    story: 'Your land has closed around calm, shallow water: a lagoon, as an atoll holds.',
  },
  reef: {
    label: 'A reef',
    name: 'Reef',
    noun: 'reef',
    makes: 'Living coral on shallow rock under clear water.',
    brings: 'Reef fish, parrotfish, hawksbill turtles and mantas.',
    story: 'A reef has grown off {isl}, rising a few millimetres a year.',
  },
  seagrass: {
    label: 'A seagrass meadow',
    name: 'Seagrass meadow',
    noun: 'seagrass',
    makes: 'Turtle grass on calm, sandy shallows.',
    brings: 'Grazing turtles, and young fish hiding in the blades.',
    story: 'A seagrass meadow sways in the shallows off {isl}.',
  },
  'mangrove-shore': {
    label: 'A calm shore for mangroves',
    name: 'Mangrove shore',
    noun: 'mangrove shore',
    makes: 'Calm, shallow, sheltered water at the shore.',
    brings: 'Mangroves, then fireflies and glowing water at night.',
    story: 'Calm, shallow water at the edge of {isl}: mangroves could stand here.',
  },
  'cloud-peak': {
    label: 'A cloud-catching peak',
    name: 'Cloud-catching peak',
    noun: 'peak',
    makes: 'A peak tall enough to catch the trade-wind clouds.',
    brings: 'Rain on its windward side, mist, and cloud forest.',
    story: 'The peak of {isl} caught a cloud; rain will fall on its windward side.',
  },
  'rain-shadow': {
    label: 'A rain shadow',
    name: 'Rain shadow',
    noun: 'dry side',
    makes: 'The dry, sheltered (west) side of a tall peak.',
    brings: 'Pili grass, prickly pears, finches and tortoises.',
    story: 'The west side of {isl} lies in its peak’s rain shadow, dry and sunny.',
  },
  summit: {
    label: 'A summit above the clouds',
    name: 'Summit',
    noun: 'summit',
    makes: 'A peak whose top rises above the cloud cap.',
    brings: 'Silverswords, in the bright, dry air.',
    story: 'The top of {isl} rises above the clouds, into clear, dry air.',
  },
  'warm-ground': {
    label: 'Warm ground',
    name: 'Warm ground',
    noun: 'warm ground',
    makes: 'A thick pile of lava that stays warm for many years.',
    brings: 'Megapodes, which bury their eggs in its warmth.',
    story: 'The thick lava on {isl} will stay warm for years.',
  },
  islet: {
    label: 'An islet',
    name: 'Islet',
    noun: 'islet',
    makes: 'A small island, apart from the rest.',
    brings: 'Seabird colonies, monk seals and nesting pigeons, safe from egg-eaters.',
    story: '{isl} is a little islet: a quiet place for seabirds and seals.',
  },
  spit: {
    label: 'A sand spit',
    name: 'Sand spit',
    noun: 'sand spit',
    makes: 'A finger of sand reaching out into the sea.',
    brings: 'Resting shorebirds; walking animals can cross it to the next island.',
    story: 'A sand spit reaches out from {isl} into the sea.',
  },
  sound: {
    label: 'The Sound',
    name: 'The Sound',
    noun: 'Sound',
    makes: 'Deep, sheltered water enclosed by three or more islands.',
    brings: 'Dolphins, and in the end, whales with their calves.',
    story: 'Your islands have closed around deep, calm water: the Sound.',
  },
};

/** Short label shown on the land when a place is recognised ("A sea cliff"). */
export function placeLabel(kind: PlaceKind): string {
  return PLACES[kind].label;
}

/** For the Places page: name, what makes it (hint), who it brings. */
export function placeInfo(kind: PlaceKind): { name: string; makes: string; brings: string } {
  const p = PLACES[kind];
  return { name: p.name, makes: p.makes, brings: p.brings };
}

export const ALL_PLACES: PlaceKind[] = Object.keys(PLACES) as PlaceKind[];

// =======================================================================================
// Reasons, roads, guide groups
// =======================================================================================

const REASONS: Record<ReasonCode, string> = {
  'no-land': 'There’s no land here for it yet.',
  'no-beach': 'There’s no sandy beach yet.',
  'no-dune': 'There are no dunes: dry sand piled up behind a beach.',
  'no-cliff': 'There’s no sea cliff: a steep rock face standing over the water.',
  'no-stack': 'There’s no sea stack: a lone pillar of rock out in the sea.',
  'no-rock-shore': 'There’s no rocky shore where the waves splash.',
  'no-soil': 'There’s no soil yet; lichens and mosses have to make some first.',
  'thin-soil': 'The soil is still too thin.',
  'too-dry': 'It’s too dry; most rain falls on the windward (east) side.',
  'too-wet': 'It’s too wet; it wants a drier, sheltered side.',
  'too-salty': 'It’s too salty, so close to the sea spray.',
  'too-small': 'The island is too small for it.',
  'too-low': 'The land is too low for it.',
  'too-tall': 'The island is too tall and steep; it wants a low, open island.',
  'no-fresh-water': 'There’s no fresh water: no pond or stream.',
  'no-salt-pond': 'There’s no shallow salt pond.',
  'no-stream': 'There’s no stream running down to the sea.',
  'no-shelter': 'The water is too rough; it needs shelter from the waves.',
  'no-lagoon': 'There’s no calm lagoon enclosed by land.',
  'no-reef': 'There’s no living reef, or shallow rock for one to grow on.',
  'no-seagrass': 'There’s no seagrass meadow in the shallows.',
  'no-mangrove': 'There are no mangroves along the shore.',
  'no-open-ground': 'There’s no open, bare ground left for it.',
  'no-grass': 'There’s no grassland.',
  'no-shrubs': 'There are no shrubs yet.',
  'no-trees': 'There are no trees yet.',
  'no-forest': 'There’s no forest yet.',
  'no-cloud-forest': 'No cloud sits on a peak to make a misty forest.',
  'no-flowers': 'There are no flowers of the kind it needs.',
  'no-fruit': 'There’s no ripe fruit to eat.',
  'no-prey': 'There’s nothing for it to hunt.',
  'no-host': 'The plant or animal it depends on doesn’t live here yet.',
  'no-warm-ground': 'There’s no warm volcanic ground.',
  'no-summit': 'No peak rises above the clouds.',
  predators: 'An egg-eater lives here, so it keeps away.',
  'needs-island-nearby': 'It needs another island close by.',
  'too-far': 'It’s a long way from the old islands; islands nearby would be stepping stones.',
  'hot-lava': 'The ground is still hot lava.',
  'needs-storm': 'It only arrives with a storm.',
};

/** One plain sentence saying why something couldn't stay. */
export function reasonLine(code: ReasonCode): string {
  return REASONS[code];
}

function isReasonCode(x: unknown): x is ReasonCode {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(REASONS, x);
}

const ROADS: Record<Road, string> = {
  wind: 'on the wind',
  sea: 'on the waves',
  raft: 'on a raft of driftwood',
  bird: 'carried by a bird',
  flight: 'on its own, flying or swimming',
  storm: 'blown in by a storm',
};

export function roadWord(road: Road): string {
  return ROADS[road];
}

/** Field-guide tabs, with a plain line about each. */
export const GUIDE_GROUPS: { id: GuideGroup; name: string; about: string }[] = [
  { id: 'plants', name: 'Plants', about: 'From the first lichen on bare rock to the forest.' },
  { id: 'birds', name: 'Birds', about: 'Seabirds, shorebirds and the birds of the forest.' },
  { id: 'sea', name: 'Sea life', about: 'Coral, seagrass, turtles, fish, dolphins and whales.' },
  { id: 'small', name: 'Small creatures', about: 'Spiders, insects, snails and crabs.' },
  { id: 'land', name: 'Land animals', about: 'Lizards, a tortoise, a frog and the bats.' },
];

export function guideGroupName(g: GuideGroup): string {
  return GUIDE_GROUPS.find((x) => x.id === g)?.name ?? g;
}

// =======================================================================================
// Moments and milestones
// =======================================================================================

export type MomentKey =
  | 'hatchlings'
  | 'coral-spawning'
  | 'bat-stream'
  | 'frigate-courtship'
  | 'glowing-bay'
  | 'firefly-night'
  | 'storm-rainbow'
  | 'shorebird-gathering'
  | 'albatross-dance'
  | 'dawn-chorus'
  | 'whale-breach'
  | 'old-boat';

/** Rare, lovely sights the journal keeps ({isl} is the island it happened on). */
export const MOMENTS: Record<MomentKey, { name: string; line: string }> = {
  hatchlings: { name: 'Hatchlings at dawn', line: 'At dawn, baby turtles burst from the sand of {isl} and raced to the sea.' },
  'coral-spawning': { name: 'Coral spawning', line: 'Under a full moon, the reef off {isl} spawned, filling the water with drifting pink specks.' },
  'bat-stream': { name: 'Bat stream', line: 'At dusk, fruit bats poured out of the forest of {isl} in a long, dark stream.' },
  'frigate-courtship': { name: 'Frigatebird courtship', line: 'Male frigatebirds puffed out their red throat pouches on {isl}, calling to the sky.' },
  'glowing-bay': { name: 'The glowing bay', line: 'Tonight the lagoon by {isl} glowed blue wherever a fish moved.' },
  'firefly-night': { name: 'Firefly night', line: 'Tonight the mangroves of {isl} blinked on and off, all in time.' },
  'storm-rainbow': { name: 'Storm rainbow', line: 'After the storm, a double rainbow arched over {isl}.' },
  'shorebird-gathering': { name: 'Gathering of shorebirds', line: 'Shorebirds gathered on the beaches of {isl} for one evening, resting before the long flight north.' },
  'albatross-dance': { name: 'Albatross dance', line: 'On {isl}, albatross pairs bowed, clacked their bills and pointed at the sky together.' },
  'dawn-chorus': { name: 'Dawn chorus', line: 'At first light, every bird on {isl} sang at once.' },
  'whale-breach': { name: 'Whale breach', line: 'A whale leapt clear of the Sound and came down in a great white splash.' },
  'old-boat': { name: 'The old boat', line: 'A small sailboat anchored in the calmest bay of {isl} for one night, and was gone by morning.' },
};

export type MilestoneKey = 'kinds' | 'rakata' | 'hawaii' | 'half' | 'islands';

/**
 * Real-island milestones. {n} is params.count. `at` is when the ecology should mark it;
 * `of` says what it counts (kinds of plants found, kinds of life found, or islands).
 */
export const MILESTONES: Record<MilestoneKey, { line: string; of: 'plants' | 'life' | 'islands'; at?: number }> = {
  kinds: { line: 'Your islands are now home to {n} kinds of life.', of: 'life' },
  rakata: { line: 'Your islands hold {n} kinds of plants: as many as Krakatau had three years after it erupted.', of: 'plants', at: 26 },
  hawaii: { line: 'Hawaiʻi’s native flowering plants grew from about 270 arrivals over millions of years. Your islands have had a kinder sea.', of: 'plants', at: 30 },
  half: { line: 'Half of all the life in the field guide has found your islands.', of: 'life' },
  islands: { line: 'You have raised {n} islands from the sea.', of: 'islands' },
};

// =======================================================================================
// Journal lines
// =======================================================================================

/** First words that stay capitalised inside a sentence (they are names of places or people). */
const PROPER_FIRST_WORDS = new Set(['Pacific', 'Hawaiian', 'Sally', 'American', 'Laysan', 'Aldabra', 'Polynesian', 'Pisonia']);

/** A species' name as it reads inside a sentence ("the ʻōhiʻa lehua", "the Laysan albatross"). */
function nameInSentence(name: string): string {
  const firstWord = name.split(/[\s-]/)[0];
  if (PROPER_FIRST_WORDS.has(firstWord)) return name;
  if (name.startsWith('ʻ') && name.length > 1) return 'ʻ' + name.charAt(1).toLowerCase() + name.slice(2);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

function capitalise(s: string): string {
  if (s.startsWith('ʻ') && s.length > 1) return 'ʻ' + s.charAt(1).toUpperCase() + s.slice(2);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}

function num(v: string | number | undefined): number {
  return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || 0 : 0;
}

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/** The species' own main need (the reason its "seen" line gives), if its eco says. */
function mainNeedOf(sp: SpeciesDef): ReasonCode | undefined {
  const eco = sp.eco;
  if (typeof eco !== 'object' || eco === null || !('mainNeed' in eco)) return undefined;
  const m = (eco as { mainNeed: unknown }).mainNeed;
  return isReasonCode(m) ? m : undefined;
}

interface LineContext {
  place: string;
  isl: string;
  from: string;
}

function fill(template: string, ctx: LineContext): string {
  return template.replace(/\{place\}/g, ctx.place).replace(/\{isl\}/g, ctx.isl).replace(/\{from\}/g, ctx.from);
}

/** How an island-hop arrival travelled. */
const HOP_WORDS: Record<Road, string> = {
  wind: 'drifted over on the wind',
  sea: 'floated over',
  raft: 'rafted over',
  bird: 'came over with a bird',
  flight: 'crossed over',
  storm: 'was blown over by a storm',
};

/**
 * Did a storm's castaway come on a raft of branches (rather than on the wind)? The ecology's
 * road says so when it sends one; otherwise the species' own roads decide, so a storm-blown
 * bird is never said to have rafted.
 */
function cameByRaft(sp: SpeciesDef, road: Road | undefined): boolean {
  if (road !== undefined) return road === 'raft' || road === 'sea';
  return sp.roads.includes('raft') || sp.roads.includes('sea');
}

/** The text of a journal entry (no year; the UI adds the year stamp). */
export function entryText(e: JournalEntry, species: readonly SpeciesDef[], islandName: (id: number) => string): string {
  const p = e.params ?? {};
  const sp = e.species !== undefined ? species[e.species] : undefined;
  const named = e.island !== undefined ? islandName(e.island) : '';
  const isl = named || 'your island';
  const islandRef = (v: string | number | undefined): string => (typeof v === 'number' ? islandName(v) : typeof v === 'string' ? v : '');
  // A place kind from an old save may no longer exist; fall back to the island's name.
  const placeText = e.place !== undefined ? PLACES[e.place] : undefined;
  const placeParam = p.place;
  const place =
    typeof placeParam === 'string'
      ? placeParam
      : e.place === 'islet'
        ? isl
        : e.place === 'sound'
          ? 'the Sound'
          : placeText
            ? `${possessive(isl)} ${placeText.noun}`
            : isl;
  const ctx: LineContext = { place, isl, from: islandRef(p.from) || 'the old islands' };
  const speciesParam = (v: string | number | undefined): SpeciesDef | undefined => (typeof v === 'number' ? species[v] : undefined);

  switch (e.kind) {
    case 'first-land':
      return 'Land broke the surface of the sea. Your island has begun.';
    case 'new-island': {
      const n = num(p.count);
      if (!named) return 'New land rose from the sea: a new island.';
      return n >= 2 && n < ORDINALS.length ? `A ${ORDINALS[n]} island rose from the sea: ${isl}.` : `New land rose from the sea: ${isl}.`;
    }
    case 'islands-joined': {
      const other = islandRef(p.other);
      return other && named ? `${isl} and ${other} have joined into one island.` : 'Two of your islands have joined into one.';
    }
    case 'island-lost':
      return `${capitalise(isl)} has slipped back beneath the waves; you can always raise it again.`;
    case 'arrival': {
      if (!sp) return `Something new arrived ${roadWord(e.road ?? 'wind')}.`;
      const from = islandRef(p.from);
      if (from) return `${capitalise(`the ${nameInSentence(sp.name)}`)} ${HOP_WORDS[e.road ?? sp.roads[0]]} from ${from} to ${isl}.`;
      return fill(sp.text.arrive, ctx);
    }
    case 'visit': {
      const reason = isReasonCode(p.reason) ? p.reason : undefined;
      if (!sp) return reason ? `Something visited ${isl} and moved on. ${reasonLine(reason)}` : `Something visited ${isl} and moved on.`;
      if (!reason || reason === mainNeedOf(sp)) return fill(sp.text.seen, ctx);
      const who = capitalise(`the ${nameInSentence(sp.name)}`);
      const did = sp.kind === 'plant' ? `reached ${isl} but couldn’t take root.` : `came to ${isl} but couldn’t stay.`;
      return `${who} ${did} ${reasonLine(reason)}`;
    }
    case 'return':
      return sp ? fill(sp.text.back, ctx) : `A visitor came back to ${isl}, and stayed.`;
    case 'lost':
      return sp ? fill(sp.text.lost, ctx) : 'Something has gone quiet on your islands, for now.';
    case 'storm': {
      const head = num(p.great) > 0 ? 'A great storm swept over your islands.' : 'A storm passed over your islands.';
      const castaway = speciesParam(p.castaway) ?? sp;
      if (castaway) {
        const name = nameInSentence(castaway.name);
        if (cameByRaft(castaway, e.road)) return `${head} A raft of branches drifted ashore on ${isl}, bringing the ${name}.`;
        return `${head} Its winds carried the ${name} to ${isl}, far off its course.`;
      }
      if (num(p.raft) > 0) return `${head} A raft of tangled branches drifted ashore on ${isl}.`;
      if (num(p.fallen) > 0) return `${head} A few trees fell; seedlings will soon fill the gaps.`;
      return `${head} The sea left driftwood and seaweed on the beaches.`;
    }
    case 'place': {
      if (!placeText) return `Your land has made a new kind of place on ${isl}.`;
      const story = fill(placeText.story, ctx);
      const waiting = speciesParam(p.waiting);
      return waiting ? `${capitalise(story)} The ${nameInSentence(waiting.name)} that visited before may come back now.` : capitalise(story);
    }
    case 'first': {
      const f = FIRSTS.find((x) => x.key === e.first);
      if (!f) return 'Something happened on your islands for the very first time.';
      return sp ? `${f.name}: ${nameInSentence(sp.name)}, on ${isl}.` : f.line;
    }
    case 'age': {
      const a = AGES.find((x) => x.id === e.age);
      return a ? `${a.name} begins. ${a.line}` : 'A new age begins on your islands.';
    }
    case 'moment': {
      const key = p.moment;
      const m = typeof key === 'string' && Object.prototype.hasOwnProperty.call(MOMENTS, key) ? MOMENTS[key as MomentKey] : undefined;
      return fill(m ? m.line : 'Something rare and lovely happened on {isl}.', ctx);
    }
    case 'milestone': {
      const key = p.milestone;
      const m = typeof key === 'string' && Object.prototype.hasOwnProperty.call(MILESTONES, key) ? MILESTONES[key as MilestoneKey] : undefined;
      const n = String(num(p.count));
      if (m && (!m.line.includes('{n}') || p.count !== undefined)) return fill(m.line, ctx).replace(/\{n\}/g, n);
      return p.count !== undefined ? `Your islands are now home to ${n} kinds of life.` : 'Your islands grow richer with every century.';
    }
    case 'lava-buried':
      if (num(p.kipuka) > 0) return `Lava flowed around living ground on ${isl} and left it standing: a kīpuka, the Hawaiian word for an island of life in new lava.`;
      return sp
        ? `Your lava ran over the ${nameInSentence(sp.name)} on ${isl}. In time, that ground will make the richest soil of all.`
        : `Your lava covered living ground on ${isl}. In time, it will make the richest soil of all.`;
    case 'hint': {
      if (typeof p.text === 'string') return p.text;
      if (sp) return sp.hint[Math.max(0, Math.min(2, Math.round(num(p.level ?? 2))))];
      return isReasonCode(p.reason) ? reasonLine(p.reason) : 'Keep shaping the land; life is always on its way.';
    }
    case 'ending':
      return 'Whales have come to raise their calves in your Sound. You made the land; the world brought the life.';
  }
}

// =======================================================================================
// Look: one plain sentence about any ground
// =======================================================================================

const SEA_NOUNS: Partial<Record<Habitat, string>> = {
  [Habitat.DeepSea]: 'open sea',
  [Habitat.OpenSea]: 'open sea',
  [Habitat.Reef]: 'reef',
  [Habitat.Seagrass]: 'seagrass meadow',
  [Habitat.Lagoon]: 'lagoon water',
  [Habitat.Mangrove]: 'water among mangroves',
  [Habitat.Sound]: 'water of the Sound',
};

/** Names of the species growing in a patch's layers, tallest first, without repeats. */
function layerNames(info: InspectInfo, species: readonly SpeciesDef[]): string[] {
  const out: string[] = [];
  for (const id of [info.layers.canopy, info.layers.shrub, info.layers.herb, info.layers.ground]) {
    const sp = id >= 0 ? species[id] : undefined;
    if (sp && !out.includes(sp.name)) out.push(sp.name);
  }
  return out.map(nameInSentence);
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The ecology's own reason, joined into the sentence. */
function whyClause(why: string | undefined): string {
  if (!why) return '';
  const w = why.trim().replace(/[.\s]+$/, '');
  if (!w) return '';
  const lower = /^[A-Z][a-z]/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w;
  return lower;
}

function finish(parts: string[], reason: string): string {
  const body = parts.filter((x) => x).join(', ');
  return `${body}${reason ? `: ${reason}` : ''}.`;
}

/** One plain sentence for Look on the ground or the sea. */
export function inspectText(info: InspectInfo, species: readonly SpeciesDef[]): string {
  const why = whyClause(info.why);
  const life = layerNames(info, species);

  if (info.substrate === Substrate.HotLava || info.habitat === Habitat.HotLava) {
    return 'Molten lava, still glowing: nothing can live here until it cools into rock.';
  }

  // Ponds: fresh or salty, with what grows at the edge.
  if (info.substrate === Substrate.Pond || info.habitat === Habitat.Pond || info.habitat === Habitat.SaltPond) {
    const salty = info.habitat === Habitat.SaltPond;
    const subject = salty ? 'A shallow salt pond, warm and still' : 'A pond of fresh rainwater';
    return finish([subject, life.length ? `with ${listWords(life.slice(0, 3))} at its edge` : ''], why);
  }

  // The sea.
  if (info.substrate === Substrate.Sea || info.depth > 0) {
    const d = info.depth;
    const noun = SEA_NOUNS[info.habitat] ?? 'open sea';
    const depthWord = d < 1 ? 'Very shallow' : d < 5 ? 'Shallow' : d < 15 ? 'Fairly deep' : 'Deep';
    const subject = info.habitat === Habitat.Sound ? 'The Sound, deep water sheltered by your islands' : `${depthWord} ${noun}`;
    const trait =
      info.habitat === Habitat.Lagoon || info.habitat === Habitat.Seagrass || info.habitat === Habitat.Mangrove
        ? 'sheltered from the waves'
        : info.habitat === Habitat.OpenSea && d < 6
          ? 'open to the waves'
          : '';
    const growing = life.length ? `with ${listWords(life.slice(0, 3))} growing here` : '';
    let reason = why;
    if (!reason && !life.length) reason = d > 20 ? 'too deep and dark for anything to grow on the bottom' : 'nothing has settled on the bottom yet';
    return finish([subject, trait, growing], reason);
  }

  // Land.
  const soil = info.soil;
  let subject: string;
  switch (info.substrate) {
    case Substrate.Sand:
      subject = info.habitat === Habitat.Beach ? 'Beach sand' : info.habitat === Habitat.Dune ? 'Dune sand' : soil >= 0.05 ? 'Sandy soil' : 'Sand';
      break;
    case Substrate.Stone:
      subject = soil >= 0.15 ? 'Rich soil over set stone' : 'Set stone';
      break;
    case Substrate.Limestone:
      subject = soil >= 0.15 ? 'Rich soil over old reef rock' : 'Old reef limestone';
      break;
    default:
      subject =
        soil >= 0.15
          ? 'Rich soil over old lava'
          : info.groundAge < 30
            ? 'Fresh black lava'
            : info.groundAge < 300
              ? 'Young lava rock'
              : info.groundAge < 1500
                ? 'Weathered lava rock'
                : 'Old lava rock';
  }
  if (info.habitat === Habitat.Cliff) subject = `A steep cliff of ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;

  const traits: string[] = [];
  if (info.habitat === Habitat.Summit) traits.push('above the clouds, dry and bright');
  else if (info.habitat === Habitat.CloudForest || info.moist >= 0.85) traits.push('wet with cloud mist');
  else if (info.rain >= 0.6 && info.windward > 0.2) traits.push('on the rainy windward side');
  else if (info.rain < 0.3 && info.windward < -0.2) traits.push('dry, in the rain shadow');
  else if (info.moist >= 0.6) traits.push('damp');
  else if (info.moist < 0.3) traits.push('dry');
  if (info.habitat === Habitat.Stream) traits.push('beside a stream');
  else if (info.habitat === Habitat.Marsh) traits.push('marshy');
  if (info.salt >= 0.6) traits.push('salty with sea spray');
  if (info.substrate !== Substrate.Sand && soil < 0.15) {
    traits.push(soil < 0.005 ? 'with no soil yet' : soil < 0.03 ? 'with a thin crust of soil' : soil < 0.08 ? 'with a little soil' : 'with good soil');
  }

  const growing = life.length ? `growing ${listWords(life.slice(0, 3))}` : '';
  let reason = why;
  if (!reason && !life.length) {
    if (info.substrate === Substrate.Basalt && info.groundAge < 5) reason = 'too new for life; the first lichens will come on the wind';
    else if (info.moist < 0.25) reason = 'too dry for anything to grow yet';
    else if (info.salt >= 0.85) reason = 'too salty for all but beach plants';
    else if (info.substrate === Substrate.Sand) reason = 'the waves have not left any seeds here yet';
    else if (info.habitat === Habitat.Cliff) reason = 'too steep for most plants, but seabirds love its ledges';
    else reason = 'nothing has taken root here so far';
  }
  return finish([subject, ...traits.slice(0, 3), growing], reason);
}
