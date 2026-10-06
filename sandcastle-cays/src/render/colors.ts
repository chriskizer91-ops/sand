/** The colour palette, kept in one place. All colours are sRGB hex, as a designer would pick them. */

export const PALETTE = {
  sandDry: 0xf3e6c8,
  sandDamp: 0xdcc497,
  sandWet: 0xc2a576,
  sandSoaked: 0xb0926a,
  waterShallow: 0x8ff0e4,
  waterMid: 0x2fc2cf,
  waterDeep: 0x1279b8,
  foam: 0xffffff,
  skyZenith: 0x3d9be9,
  skyHorizon: 0xd9f1ff,
  sun: 0xfff2d6,
  hemiSky: 0xcfe9ff,
  hemiGround: 0xe8d4a8,
  rock: 0xb6ad9c,
  rockDark: 0x8d8574,
  grass: 0x6fae4a,
  grassDark: 0x4f8f36,
  leaf: 0x4f9d3c,
  leafLight: 0x86c45a,
  trunk: 0x8b7257,
  coconut: 0x7a5a32,
  hullWhite: 0xfbf8f0,
  hullStripe: 0x2fb5b0,
  hullBottom: 0xb8483b,
  deckWood: 0xc99a64,
  sailCloth: 0xf6efdc,
  cabinRoof: 0x2c9c98,
  flag: 0xf0644a,
};

/** sRGB hex to linear RGB triplet (what shaders compute in). */
export function linear(hex: number): [number, number, number] {
  const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return [c[0], c[1], c[2]];
}

/** A GLSL vec3 literal of a colour, in linear space. */
export function glslColor(hex: number): string {
  const [r, g, b] = linear(hex);
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}
