/**
 * The colours of the land and the ponds, kept in one place (docs/design-notes/look-and-sound.md §2).
 * All colours are sRGB hex, as a designer would pick them; shaders get them converted to linear
 * light with glslColor(). The family is Sandcastle Cays: soft, sunny, cartoon-real Caribbean.
 */

export const GROUND = {
  // ---------- rock, by kind and age ----------
  /** Fresh basalt straight from the lava: glassy blue-black. */
  basaltFresh: 0x2b2a2e,
  /** A few decades old: the gloss is gone. */
  basaltMatte: 0x3c3a3a,
  /** Weathered: grey-brown. */
  basaltWeathered: 0x5d5750,
  /** Rain stains on weathered rock: rust and ochre. */
  basaltRust: 0x9a5a3a,
  /** Old rock on cliffs where soil can't stay: warm grey, like the sandcastle rocks. */
  basaltOld: 0x8a7f72,
  /** Rock placed with the Rock tool: a neutral boulder grey. */
  stone: 0x8e8a84,
  stoneDark: 0x6f6b66,
  /** Reef limestone: cream. */
  limestone: 0xddd2b6,
  limestoneOld: 0xbdb39c,
  /** Salt crust in the splash zone of windward rock shores. */
  saltCrust: 0xece7da,

  // ---------- sand, by kind (black volcanic glass -> grey -> gold -> coral white) ----------
  sandBlack: 0x3a3634,
  sandGrey: 0x8f877c,
  sandGold: 0xe9d6a8,
  sandWhite: 0xf7f1e3,

  // ---------- soil ----------
  soilYoung: 0x6b4a35,
  /** Red laterite on the dry (lee) side. */
  soilRed: 0x8c4a2f,
  /** Dark humus under forest. */
  soilHumus: 0x3f3024,

  // ---------- living cover ----------
  lichenSage: 0xc9cbb0,
  lichenYellow: 0xd9d3a0,
  /** Orange perch lichen where seabirds sit. */
  lichenOrange: 0xe09a3a,
  /** Biological crust on old sand: a faint dusky film. */
  crust: 0x8a8068,
  mossDry: 0x4a6b2a,
  mossWet: 0x7fb03a,
  grass: 0x6fae4a,
  grassLight: 0x86c45a,
  grassGold: 0xc9b26b,
  grassGoldLight: 0xe2d08f,
  /** Leaf litter on the forest floor. */
  litter: 0x6a5a3c,
  litterDark: 0x4d4130,
  /** The forest seen from far away, where the plants themselves aren't drawn. */
  canopy: 0x3f7a2e,
  canopyWet: 0x2f6a32,
  canopyDry: 0x6b7a3a,
  guano: 0xf2efe4,
  char: 0x2a2622,
  /** Stream and marsh water over pebbles. */
  streamWater: 0x3f6a66,
  marshGreen: 0x5e7a3a,

  // ---------- under the sea ----------
  coralPink: 0xd98a7a,
  coralOchre: 0xd8a25a,
  coralPurple: 0x9a6a9a,
  coralOlive: 0x8a9a5a,
  seagrass: 0x4f8a3a,
  seagrassDark: 0x355f2c,
  /** Coralline algae: pink-purple crust on reef rock. */
  coralline: 0xc98aa0,
  /**
   * The deep floor (deeper than about 25 m), which the sea above almost hides: plain golden sea-floor
   * sand, already darkened the way wet sand under water is, so shallower floor fades into it evenly.
   */
  seabedFloor: 0xb2a07a,
  /** Colour the sea absorbs the seabed toward as it gets deeper. */
  deepWater: 0x0e5872,
  /** Bright web of sunlight on the shallow sea floor. */
  caustic: 0xe8fff4,

  // ---------- lava (glow ramp, then crust) ----------
  lavaDeep: 0xc21f0e,
  lavaOrange: 0xff5a1a,
  lavaYellow: 0xffb02e,
  lavaWhite: 0xfff3c4,
  crustHot: 0x3a1712,
  crustCool: 0x1d1a1c,
  /** The warm light molten lava throws on the ground around it. */
  lavaLight: 0xff7a2a,
} as const;

export const POND = {
  /** Fresh water: clear green-blue. */
  freshShallow: 0x8fd8c6,
  freshDeep: 0x2f8a86,
  /** Salt pond: milky. */
  saltShallow: 0xdde9df,
  saltDeep: 0xa9cfc6,
  /** Salt pond tinted by brine shrimp and flamingos. */
  pinkShallow: 0xf6c9cf,
  pinkDeep: 0xe58fa0,
  /** Salt pond reddened by salt-loving microbes. */
  redShallow: 0xf0b9a2,
  redDeep: 0xc9705a,
  /** Thin bright line where the water meets the bank. */
  rim: 0xf4fbf6,
} as const;

/** sRGB hex to a linear-light RGB triplet (what shaders compute in). */
export function linear(hex: number): [number, number, number] {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return [c[0], c[1], c[2]];
}

/** A GLSL vec3 literal of a colour, in linear light. */
export function glslColor(hex: number): string {
  const [r, g, b] = linear(hex);
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}
