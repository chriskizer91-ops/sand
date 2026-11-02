/**
 * The beachcombing catalogue: every kind of thing the sea can wash up, with a
 * true fact for the logbook. Plain data only (no three.js), so the game rules,
 * the logbook and the tests can all read it.
 *
 * `rarity` is a relative weight for washing up: common ~10, rare ~1.
 * `size` is the rough longest dimension in metres, real-life (the 3D models
 * in render/finds.ts are built at this size).
 */

export type FindKind =
  | 'cowrie'
  | 'calico-scallop'
  | 'sand-dollar'
  | 'nerite'
  | 'sunrise-tellin'
  | 'top-shell'
  | 'glass-white'
  | 'glass-green'
  | 'glass-brown'
  | 'glass-blue'
  | 'driftwood'
  | 'plank'
  | 'rope'
  | 'coconut'
  | 'sea-bean'
  | 'float'
  | 'feather'
  | 'netted-olive'
  | 'flamingo-tongue'
  | 'pumice';

/** Islands where finds wash up: Home Cay and Pink Sand Cay. */
export type IslandId = 'home' | 'pink';

export interface FindInfo {
  kind: FindKind;
  /** Name in the logbook, singular ("a measled cowrie"). */
  name: string;
  plural: string;
  group: 'shell' | 'sea glass' | 'wood' | 'drift';
  /** Relative weight for washing up: common ~10, rare ~1. */
  rarity: number;
  /** Rough longest dimension in metres, real-life. */
  size: number;
  /** One or two short, true sentences for the logbook. */
  fact: string;
  /** Shown the first time you pick one up. */
  firstLine: string;
  /** Where it can wash up. Absent means everywhere. */
  islands?: IslandId[];
}

export const FINDS: Record<FindKind, FindInfo> = {
  cowrie: {
    kind: 'cowrie',
    name: 'measled cowrie',
    plural: 'measled cowries',
    group: 'shell',
    rarity: 3,
    size: 0.075,
    fact:
      'A living cowrie wraps its shell in a soft fold of its own body, called the mantle, which is why the shell stays so glossy. The measled cowrie is named for its white spots.',
    firstLine: 'A measled cowrie: glossy brown, sprinkled with white spots.',
  },
  'calico-scallop': {
    kind: 'calico-scallop',
    name: 'calico scallop',
    plural: 'calico scallops',
    group: 'shell',
    rarity: 8,
    size: 0.055,
    fact:
      'A living scallop has a row of tiny eyes along the edge of its shell, and it swims by clapping its two shells together. The calico scallop is named for its patchy colours, like calico cloth.',
    firstLine: 'A calico scallop, with ribs like a fan and patches of colour.',
  },
  'sand-dollar': {
    kind: 'sand-dollar',
    name: 'six-holed sand dollar',
    plural: 'six-holed sand dollars',
    group: 'shell',
    rarity: 4,
    size: 0.1,
    fact:
      'A sand dollar is the skeleton of a flat sea urchin. Alive, it is covered in short, soft spines; the sun bleaches the empty skeleton white.',
    firstLine: 'A six-holed sand dollar, bleached white by the sun.',
  },
  nerite: {
    kind: 'nerite',
    name: 'bleeding tooth nerite',
    plural: 'bleeding tooth nerites',
    group: 'shell',
    rarity: 7,
    size: 0.03,
    fact:
      'Bleeding tooth nerites live in crowds on rocks at the edge of the sea, grazing on thin films of algae. At low tide they shut a little door, called an operculum, to keep from drying out.',
    firstLine: "A bleeding tooth nerite: the red-and-white 'tooth' is how it got its name.",
  },
  'sunrise-tellin': {
    kind: 'sunrise-tellin',
    name: 'sunrise tellin',
    plural: 'sunrise tellins',
    group: 'shell',
    rarity: 6,
    size: 0.07,
    fact:
      'A living tellin stays buried in the sand and reaches up with a long, thin tube, called a siphon, to vacuum up bits of food from the surface.',
    firstLine: 'A sunrise tellin: pink rays spread across it like a sunrise.',
  },
  'top-shell': {
    kind: 'top-shell',
    name: 'West Indian top shell',
    plural: 'West Indian top shells',
    group: 'shell',
    rarity: 4,
    size: 0.08,
    fact:
      'Many islanders call this snail a whelk and cook it in soups and stews. Its shell is lined with shining mother-of-pearl, and empty ones make fine homes for hermit crabs.',
    firstLine: 'A West Indian top shell, striped black and white like a zigzag.',
  },
  'glass-white': {
    kind: 'glass-white',
    name: 'piece of white sea glass',
    plural: 'pieces of white sea glass',
    group: 'sea glass',
    rarity: 10,
    size: 0.032,
    fact:
      'Sea glass starts out as broken bottles and jars. Years of waves and sand rub it smooth and frosted. White, from clear glass, is the most common colour.',
    firstLine: 'A piece of white sea glass, frosted soft by the waves.',
  },
  'glass-green': {
    kind: 'glass-green',
    name: 'piece of green sea glass',
    plural: 'pieces of green sea glass',
    group: 'sea glass',
    rarity: 9,
    size: 0.036,
    fact: 'Green sea glass mostly comes from old drink bottles, for things like soda, beer and wine.',
    firstLine: 'A piece of green sea glass, like a frosted sweet.',
  },
  'glass-brown': {
    kind: 'glass-brown',
    name: 'piece of brown sea glass',
    plural: 'pieces of brown sea glass',
    group: 'sea glass',
    rarity: 8,
    size: 0.03,
    fact:
      'A lot of brown sea glass was once a beer bottle. Bottle makers use brown glass because it shields what is inside from sunlight.',
    firstLine: 'A piece of brown sea glass, the colour of honey.',
  },
  'glass-blue': {
    kind: 'glass-blue',
    name: 'piece of cobalt blue sea glass',
    plural: 'pieces of cobalt blue sea glass',
    group: 'sea glass',
    rarity: 1.2,
    size: 0.025,
    fact:
      'Cobalt blue is one of the rarer colours of sea glass. It came from old bottles and jars for medicines and creams, tinted with a pinch of cobalt.',
    firstLine: 'Cobalt blue sea glass! One of the rarer colours.',
  },
  driftwood: {
    kind: 'driftwood',
    name: 'driftwood stick',
    plural: 'driftwood sticks',
    group: 'wood',
    rarity: 8,
    size: 0.5,
    fact: 'Sun and salt water bleach driftwood a soft silver-grey, and the waves and sand wear it smooth.',
    firstLine: 'A driftwood stick, silver-grey and smooth.',
  },
  plank: {
    kind: 'plank',
    name: 'weathered plank',
    plural: 'weathered planks',
    group: 'wood',
    rarity: 2.5,
    size: 0.62,
    fact:
      'Sun, salt and sand wear away the softer wood first, so the grain of an old plank stands up in ridges you can feel with your fingers.',
    firstLine: 'A weathered plank. Good timber is always worth keeping aboard.',
  },
  rope: {
    kind: 'rope',
    name: 'tangle of old rope',
    plural: 'tangles of old rope',
    group: 'drift',
    rarity: 5,
    size: 0.32,
    fact:
      'Most rope today is made of plastic, so it lasts a long time at sea. Picking it up keeps it from tangling turtles and seabirds.',
    firstLine: 'A tangle of old rope. Handy aboard, and better off out of the sea.',
  },
  coconut: {
    kind: 'coconut',
    name: 'drifting coconut',
    plural: 'drifting coconuts',
    group: 'drift',
    rarity: 6,
    size: 0.26,
    fact:
      "A coconut's thick, airy husk lets it float for months, and it can still sprout when it lands on a beach. That is one way coconut palms reach new islands.",
    firstLine: 'A coconut, still in its husk, washed up from somewhere.',
  },
  'sea-bean': {
    kind: 'sea-bean',
    name: 'hamburger bean',
    plural: 'hamburger beans',
    group: 'drift',
    rarity: 1.5,
    size: 0.03,
    fact:
      'Hamburger beans are seeds of tropical forest vines. They drop into rivers, float out to sea and can drift for many months before washing up.',
    firstLine: "A sea bean! The dark band around it is why it's called a hamburger bean.",
  },
  float: {
    kind: 'float',
    name: 'fishing float',
    plural: 'fishing floats',
    group: 'drift',
    rarity: 3,
    size: 0.12,
    fact:
      'Floats like this hold fishing nets and lines up near the surface. Lost ones can drift a very long way before they wash ashore.',
    firstLine: 'A little fishing float, faded orange by the sun.',
  },
  feather: {
    kind: 'feather',
    name: 'pelican feather',
    plural: 'pelican feathers',
    group: 'drift',
    rarity: 4,
    size: 0.28,
    fact:
      'Most birds replace their feathers a few at a time as they wear out, so a feather on the beach does not mean a bird is hurt. Brown pelicans catch fish by diving headfirst into the sea.',
    firstLine: "A brown pelican's feather, as light as anything.",
  },
  'netted-olive': {
    kind: 'netted-olive',
    name: 'netted olive',
    plural: 'netted olives',
    group: 'shell',
    rarity: 3,
    size: 0.045,
    islands: ['pink'],
    fact:
      'Netted olives burrow through the sand just under the surface, mostly at night. The shell is named for the fine net of lines across it.',
    firstLine: 'A netted olive, glossy as a polished pebble.',
  },
  'flamingo-tongue': {
    kind: 'flamingo-tongue',
    name: 'flamingo tongue',
    plural: 'flamingo tongues',
    group: 'shell',
    rarity: 1.5,
    size: 0.03,
    islands: ['pink'],
    fact:
      'Alive, this little snail lives on sea fans and covers its shell with a bright orange, spotted mantle, a soft fold of its body. The empty shell underneath is plain and creamy.',
    firstLine: 'A flamingo tongue shell! Alive, it wears a spotted orange coat; the shell itself is plain.',
  },
  pumice: {
    kind: 'pumice',
    name: 'piece of pumice',
    plural: 'pieces of pumice',
    group: 'drift',
    rarity: 2.5,
    size: 0.07,
    fact:
      'Pumice is volcanic rock so full of tiny bubbles that it floats. Pieces can drift on the sea for a very long time before they wash ashore.',
    firstLine: 'A lump of pumice: a stone so light it floats!',
  },
};

export const FIND_KINDS: FindKind[] = Object.keys(FINDS) as FindKind[];
