/**
 * How the land looks: one ground shader for every rock, beach, meadow, lava flow and reef
 * (ARCHITECTURE §6.4, look-and-sound.md §2). It is three's Lambert material with extra code
 * spliced in (onBeforeCompile), so sun shadows and the sky light work as for everything else.
 *
 * Everything is worked out per pixel from the world data maps, never from pictures:
 * - heights (heightTex) give the exact surface slope at every pixel, so lighting stays crisp even
 *   where the triangles are big and far away;
 * - the ground map (groundTex) says where lava is and how hot, how deep the sand is, and which kind
 *   of sand and rock it is;
 * - the life maps (cover A/B/C) say where lichen, moss, grass, forest, guano, burns, streams, coral and
 *   seagrass are. They are coarse (4 m), so cover is drawn as patches that grow outward: each layer
 *   shows where its amount beats a little noise field, rather than fading in evenly.
 *
 * Noise is plain arithmetic with integer hashes (no sin, no stored pattern), in four sizes:
 * - very big (~50 m), big (~12 m) and medium (~4 m) patches are worked out per VERTEX and handed to the
 *   pixels, which is nearly free (there are ~20 times fewer vertices than pixels). Each size is kept
 *   only where the grid has vertices enough to carry it (about three per noise cell) and fades out
 *   where the grid is coarser, so it never turns into visible triangles. The sizes add up, so as
 *   you come closer the patches gain detail rather than changing shape;
 * - fine (~50 cm) detail is one 4-hash value noise per pixel, near the camera only, measured from a point
 *   near the camera so it stays sharp anywhere in the 1 km zone. It is projected from above on gentle
 *   ground and from the side on cliffs (so cliffs get real texture, not stretched streaks); grains in
 *   two sizes add one hash each up close, only while they span a few pixels.
 * So: at most 6 hashes per pixel near the camera and none far away. Regular things (rock layers and
 * joints, ripples, wind waves over grass, caustics) use cheap smooth "waves" made from folded lines.
 * Heavy work (smooth slope, detail, caustics) is skipped where it can't be seen, and the deep sea
 * floor, which the sea above hides, is one plain colour.
 */
import * as THREE from 'three';
import { CELL, FLOOR_Y, NX, NZ, ORIGIN_X, ORIGIN_Z } from '../config';
import { GROUND as G, glslColor as c } from './colors';
import { WORLD_UNIFORMS_GLSL, addWorldUniforms, type WorldUniforms } from './shared';

/** Squares per side of the one grid patch every terrain node draws. */
export const GRID_N = 32;
/**
 * The node grid starts on the centre of column (0, 0), so every vertex of every level sits exactly
 * on a height sample: the finest level shows the true column heights, not an average of four.
 */
export const GRID_X0 = ORIGIN_X + CELL / 2;
export const GRID_Z0 = ORIGIN_Z + CELL / 2;
/** Outside the zone the edge height falls away into the deep over this distance (m). */
export const FALL = 160;
/** How deep the world falls outside the zone: below the floor, where the sea is opaque. */
export const DEEP_Y = FLOOR_Y - 12;
/** Pixel detail noise (hashed) is used out to this distance (m); beyond it, no hashes at all. */
export const NEAR_DETAIL = 90;
/**
 * Sea floor deeper than ABYSS_FROM (m) fades into one plain colour, reached at ABYSS_AT: the sea
 * above is close to opaque there, so the floor skips all its detail (and its map reads).
 */
export const ABYSS_FROM = 18;
export const ABYSS_AT = 28;

/** Terrain-only uniforms (shared by the main and the shadow material). */
export interface TerrainUniforms {
  /** x: range of the finest level (m); y: where morphing starts, as a fraction of each range. */
  uLod: { value: THREE.Vector2 };
  /** The same for the shadow pass (coarser when the sun's box would cost too many triangles). */
  uLodShadow: { value: THREE.Vector2 };
  /** Point near the camera (snapped to 256 m) that hashed pixel noise is measured from. */
  uNoiseOrigin: { value: THREE.Vector3 };
}

const f1 = (v: number): string => v.toFixed(1);

/**
 * Reading heights (vertex and fragment). Heights are 2 m column samples; the zone's texel centres are
 * column centres. Outside the zone the nearest edge height falls smoothly to DEEP_Y.
 * Exported so the ponds (and the sea) can read the same ground.
 * Needs WORLD_UNIFORMS_GLSL (uZone) declared before it.
 */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
#define TG_NX ${NX}
#define TG_NZ ${NZ}
#define TG_CELL ${f1(CELL)}
#define TG_DEEP ${f1(DEEP_Y)}
#define TG_FALL ${f1(FALL)}
float tgTexel(ivec2 c) {
  return texelFetch(uHeightTex, clamp(c, ivec2(0), ivec2(TG_NX - 1, TG_NZ - 1)), 0).r;
}
// Texel space: column centres sit on whole numbers.
vec2 tgTexelPos(vec2 xz) {
  return (xz - uZone.xy) / TG_CELL - 0.5;
}
// 0 inside the zone .. 1 once FALL metres outside it.
float tgFall(vec2 t) {
  vec2 o = t - clamp(t, vec2(0.0), vec2(float(TG_NX - 1), float(TG_NZ - 1)));
  return smoothstep(0.0, TG_FALL, length(o) * TG_CELL);
}
// The ground surface at any point: bilinear between column centres, falling away outside the zone.
float tgHeight(vec2 xz) {
  vec2 t = tgTexelPos(xz);
  vec2 tc = clamp(t, vec2(0.0), vec2(float(TG_NX - 1), float(TG_NZ - 1)));
  vec2 fl = floor(tc);
  ivec2 i = ivec2(fl);
  vec2 f = tc - fl;
  float h = mix(mix(tgTexel(i), tgTexel(i + ivec2(1, 0)), f.x), mix(tgTexel(i + ivec2(0, 1)), tgTexel(i + ivec2(1, 1)), f.x), f.y);
  return mix(h, TG_DEEP, tgFall(t));
}
`;

/** Integer hashing and value noise (vertex and fragment; the ponds use it too). */
export const HASH_GLSL = /* glsl */ `
// Integer hash (pcg2d, Jarzynski and Olano 2020): one call gives four 8-bit random numbers for a
// lattice cell. The offset keeps cells positive.
vec4 tgHash4(ivec2 cell) {
  uvec2 v = uvec2(cell + ivec2(1 << 21));
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  uint h = v.x ^ v.y;
  return vec4(uvec4(h, h >> 8u, h >> 16u, h >> 24u) & 255u) * (1.0 / 255.0);
}
// Four independent channels of smooth value noise (4 hashes) on the unit lattice of p, whose cell
// (0, 0) is lattice cell 'origin'.
vec4 tgValue4(vec2 p, ivec2 origin) {
  vec2 fl = floor(p);
  vec2 f = p - fl;
  ivec2 i = ivec2(fl) + origin;
  vec2 s = f * f * (3.0 - 2.0 * f);
  return mix(mix(tgHash4(i), tgHash4(i + ivec2(1, 0)), s.x), mix(tgHash4(i + ivec2(0, 1)), tgHash4(i + ivec2(1, 1)), s.x), s.y);
}
`;

/** Placing a vertex (main and shadow pass): CDLOD morph, height, skirt. */
const VERTEX_GLSL = /* glsl */ `
attribute vec4 aNode;   // x0, z0, size, level
attribute float aSkirt; // how far this node's edge curtain hangs (m)
uniform vec2 uLod;
#define TG_N ${f1(GRID_N)}
#define TG_GRID0 vec2(${f1(GRID_X0)}, ${f1(GRID_Z0)})
// The vertex spacing of the grid this vertex ends up on, counting a part-done morph as part of the
// way to the next coarser grid. It changes smoothly everywhere, also across node edges.
float tgSpacing;
// Height exactly on a column centre (every grid vertex of every level sits on one).
float tgGridHeight(vec2 xz) {
  vec2 t = tgTexelPos(xz);
  float h = tgTexel(ivec2(floor(t + 0.5)));
  return mix(h, TG_DEEP, tgFall(t));
}
void tgTerrainVertex(out vec3 pos, out vec3 nrm) {
  vec2 p = aNode.xy + position.xz * aNode.z;
  float spacing = aNode.z / TG_N;
  float range = uLod.x * exp2(aNode.w);
  // Geomorph: near the far end of its level's range, every odd vertex slides onto a vertex of the
  // next coarser grid, so the grid smoothly becomes that grid. Squares are cut like a chessboard
  // (see cutsForward in terrain.ts), so the middle vertex of each coarse square must land on an end
  // of that square's own cut: back in x and z on squares cut one way, forward in x and back in z on
  // the others. Every other odd vertex slides back along its odd axis. If the morph completes, the
  // coarser level may itself be morphing here (its own nodes do, across a shared edge), so carry
  // on: each vertex lands exactly where any coarser neighbour puts it, and no crack can open.
  // The distance is to the main camera (uCamPos), also in the shadow pass.
  for (int i = 0; i < 4; i++) {
    float d = distance(uCamPos, vec3(p.x, tgGridHeight(p), p.y));
    float k = clamp((d - range * uLod.y) / (range * (1.0 - uLod.y)), 0.0, 1.0);
    vec2 g = floor((p - TG_GRID0) / spacing + 0.5);
    vec2 odd = mod(g, 2.0);
    vec2 dir = -odd;
    if (odd.x + odd.y > 1.5 && mod(floor(g.x * 0.5) + floor(g.y * 0.5), 2.0) > 0.5) dir.x = 1.0;
    p += dir * spacing * k;
    tgSpacing = spacing * (1.0 + k);
    if (k < 1.0) break;
    spacing *= 2.0;
    range *= 2.0;
  }
  float h = tgHeight(p) - position.y * aSkirt;
  pos = vec3(p.x, h, p.y);
  // A rough normal (one column either side): only used to nudge shadow lookups off the surface.
  vec2 t = tgTexelPos(p);
  ivec2 i = ivec2(floor(t + 0.5));
  float sx = tgTexel(i + ivec2(1, 0)) - tgTexel(i - ivec2(1, 0));
  float sz = tgTexel(i + ivec2(0, 1)) - tgTexel(i - ivec2(0, 1));
  float out_ = tgFall(t);
  nrm = normalize(vec3(-sx, 2.0 * TG_CELL, -sz) * (1.0 - out_) + vec3(0.0, out_, 0.0));
}
`;

/** Patch noise and the flowing noise of lava and streams, worked out per vertex (main pass only). */
const VERTEX_NOISE_GLSL = /* glsl */ `
uniform sampler2D uGroundTex;
uniform sampler2D uCoverCTex;
varying vec3 vWorldPos;
varying vec4 vNoiseBig;
varying vec4 vNoiseMid;
varying vec4 vFlow;
void tgVertexNoise(vec3 pos, vec3 nrm) {
  // Each noise size is kept only while the grid has about three vertices per noise cell; where the
  // grid is coarser it fades out (sampled that sparsely it would only draw triangles).
  float aLow = 1.0 - smoothstep(16.0, 28.0, tgSpacing);  // ~50 m cells
  float aBig = 1.0 - smoothstep(4.0, 7.0, tgSpacing);    // ~12 m cells
  float aMid = 1.0 - smoothstep(2.0, 3.0, tgSpacing);    // ~4 m cells
  vec4 low = vec4(0.5);
  vec4 big = vec4(0.5);
  vec4 mid = vec4(0.5);
  if (aLow > 0.0) low = tgValue4(pos.xz * 0.02 + 41.0, ivec2(0));
  if (aBig > 0.0) big = tgValue4(pos.xz * 0.08, ivec2(0));
  if (aMid > 0.0) mid = tgValue4(pos.xz * 0.25 + 17.0, ivec2(0));
  // The big patches are the very big ones with the big ones added on top. As the big ones fade, the
  // very big ones are turned up to keep the same contrast, so far patches cover as much as near ones.
  float wb = 0.55 * aBig;
  vNoiseBig = 0.5 + aLow * (0.45 * (low - 0.5) + wb * (big - 0.5)) * (0.71 / sqrt(0.2025 + wb * wb));
  vNoiseMid = mix(vec4(0.5), mid, aMid);
  // Molten lava and running water: two copies of a noise field sliding downhill, each restarting
  // while the other is fully shown (a "flow map"), so they keep moving without ever stretching.
  // Close up the blobs are small; lava further off (where vertices are sparser) gets big slow ones,
  // and where even those would be too sparse it is evenly lit.
  vFlow = vec4(0.5);
  vec2 t = tgTexelPos(pos.xz);
  bool lava = texelFetch(uGroundTex, clamp(ivec2(floor(t + 0.5)), ivec2(0), ivec2(TG_NX - 1, TG_NZ - 1)), 0).r > 0.0;
  bool water = texture(uCoverCTex, (pos.xz - uZone.xy) / uZone.zw).a > 0.1;
  float aCoarse = 1.0 - smoothstep(5.0, 9.0, tgSpacing);
  if ((lava && aCoarse > 0.0) || (water && aMid > 0.0)) {
    float slope = 1.0 - nrm.y;
    vec2 down = normalize(nrm.xz + vec2(1e-4, 0.0)) * (lava ? 0.6 + 3.0 * slope : 1.5 + 5.0 * slope);
    float ph0 = fract(uTime * 0.25);
    float ph1 = fract(uTime * 0.25 + 0.5);
    vec4 fine = vec4(0.5);
    vec4 coarse = vec4(0.5);
    if (aMid > 0.0) {
      float freq = lava ? 0.35 : 0.6;
      fine = vec4(tgValue4((pos.xz - down * ph0 * 3.0) * freq, ivec2(0)).xy, tgValue4((pos.xz - down * ph1 * 3.0) * freq + 7.3, ivec2(0)).xy);
    }
    if (lava && aMid < 1.0) {
      coarse = vec4(tgValue4((pos.xz - down * ph0 * 8.0) * 0.1, ivec2(0)).xy, tgValue4((pos.xz - down * ph1 * 8.0) * 0.1 + 3.1, ivec2(0)).xy);
      coarse = mix(vec4(0.5), coarse, aCoarse);
    }
    vFlow = mix(coarse, fine, aMid);
  }
}
`;

/** Smooth periodic wave, 0..1: a folded line eased by smoothstep (looks like a cosine; no sin). */
export const WAVE_GLSL = /* glsl */ `
float tgWave(float x) {
  float t = abs(fract(x) * 2.0 - 1.0);
  return t * t * (3.0 - 2.0 * t);
}
`;

/** Pixel helpers: the near detail noise, patches, caustics, colour ramps. */
const NOISE_GLSL = /* glsl */ `
uniform vec3 uNoiseOrigin;
// The fine noise lattice: 2 cells per metre, turned about 29 degrees. Cliffs use the same turn at
// 1 cell per metre, so their blocks, knobs and patches are rock-sized. All entries are whole 256ths
// (1.75 = 448/256, 0.96875 = 248/256), so an origin on a multiple of 256 m always lands on a cell.
#define TG_FINE_TURN mat2(1.75, 0.96875, -0.96875, 1.75)
#define TG_SIDE_TURN mat2(0.875, 0.484375, -0.484375, 0.875)
// How soft patch edges are (set per pixel: crisper close to the camera).
float gPatchSoft;
// Spread a blend of noise channels (which bunch up around 0.5) back over 0..1.
float tgSpread(float n) {
  return clamp((n - 0.5) * 1.9 + 0.5, 0.0, 1.0);
}
// Cover grows outward as patches: it shows where its amount beats the local (big + medium) noise.
// The fine noise then frays the patch edges into specks, strongest right at the edge, so cover
// spreads like real lichen or moss rather than like a stain.
float tgPatch(float amount, float n, float soft, float fine) {
  float s = soft * gPatchSoft;
  float p = smoothstep(n - s, n + s, amount * 1.15 - 0.08);
  return clamp(p + (fine - 0.5) * 3.2 * p * (1.0 - p), 0.0, 1.0);
}
// How much of a grain layer to draw, from how many pixels one of its cells spans: none below a pixel
// (it would only shimmer as the camera moves), none when big enough to look like a pattern.
float tgGrainShow(float px) {
  return smoothstep(1.0, 2.0, px) * (1.0 - smoothstep(10.0, 16.0, px));
}
// One layer of grains on cells of 1/scale metres (one hash): x = a shade -0.5..0.5, y = 1 for the
// rare grain that glints. While a cell spans only a pixel or so it is plain speckle; bigger, each
// cell holds one round grain at a random spot, its edge one pixel soft, so grains never look square.
vec2 tgGrains(vec2 xz, float scale, float px) {
  vec2 q = (xz - uNoiseOrigin.xz) * scale;
  vec2 cell = floor(q);
  vec4 h = tgHash4(ivec2(cell) + ivec2(uNoiseOrigin.xz * scale));
  float roundness = smoothstep(1.5, 3.0, px);
  float aa = 0.7 / px;
  float grain = 1.0 - smoothstep(0.26 - aa, 0.26 + aa, length(q - cell - 0.3 - 0.4 * h.zw));
  return vec2(mix(h.x - 0.5, (h.x - 0.4) * grain, roundness), step(0.985, h.y) * mix(1.0, grain, roundness));
}
// Bright web of sunlight on a shallow sea floor: two drifting, bent wave fields at odd angles;
// light gathers where they agree. p is already wobbled by the patch noise, so it never tiles.
float tgCaustics(vec2 p, float t) {
  float a = tgWave(dot(p, vec2(0.94, 0.34)) * 0.53 + 0.8 * tgWave(dot(p, vec2(-0.5, 0.87)) * 0.47 + t * 0.15) + t * 0.1);
  float b = tgWave(dot(p, vec2(-0.26, 0.97)) * 0.59 + 0.8 * tgWave(dot(p, vec2(0.71, 0.71)) * 0.41 - t * 0.2) - t * 0.15);
  float r = 1.0 - abs(a - b);
  r *= r;
  r *= r;
  return r * r;
}
vec3 tgLavaRamp(float g) {
  vec3 col = mix(${c(G.lavaDeep)}, ${c(G.lavaOrange)}, smoothstep(0.0, 0.4, g));
  col = mix(col, ${c(G.lavaYellow)}, smoothstep(0.35, 0.75, g));
  return mix(col, ${c(G.lavaWhite)}, smoothstep(0.78, 1.0, g));
}
vec3 tgSandColor(float kind) {
  vec3 col = mix(${c(G.sandBlack)}, ${c(G.sandGrey)}, smoothstep(0.02, 0.3, kind));
  col = mix(col, ${c(G.sandGold)}, smoothstep(0.28, 0.55, kind));
  return mix(col, ${c(G.sandWhite)}, smoothstep(0.62, 0.96, kind));
}
`;

/** Lighting: Lambert plus the few shiny things (wet sand, fresh glassy lava, streams, sparkles, caustics). */
const LIGHT_GLSL = /* glsl */ `
varying vec3 vViewPosition;
struct LambertMaterial {
  vec3 diffuseColor;
  float specularStrength;
};
// Set per pixel by the ground code before lighting.
float gSpec;
float gShine;
float gSpark;
float gCaustic;
void RE_Direct_Ground(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  float dotNL = saturate(dot(geometryNormal, directLight.direction));
  vec3 irradiance = dotNL * directLight.color;
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
  float nh = saturate(dot(geometryNormal, normalize(directLight.direction + geometryViewDir)));
  float shine = gSpec * pow(nh, gShine) * (gShine + 8.0) * 0.012 + gSpark * pow(nh, 6.0);
  reflectedLight.directDiffuse += irradiance * (shine + gCaustic * ${c(G.caustic)} * 0.55);
}
void RE_IndirectDiffuse_Lambert(const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert(material.diffuseColor);
}
#define RE_Direct RE_Direct_Ground
#define RE_IndirectDiffuse RE_IndirectDiffuse_Lambert
`;

/** Fragment samplers and the per-pixel surface. */
const FRAGMENT_PARS_GLSL = /* glsl */ `
uniform sampler2D uGroundTex;
uniform sampler2D uCoverATex;
uniform sampler2D uCoverBTex;
uniform sampler2D uCoverCTex;
varying vec3 vWorldPos;
varying vec4 vNoiseBig;
varying vec4 vNoiseMid;
varying vec4 vFlow;
// Height and slope at a pixel from the four surrounding columns (cheap; its slope creases between
// columns, so it is used where a column is only a pixel or two across, or under deep water).
void tgSurfaceCoarse(vec2 t, out float h, out vec3 n, out vec4 q) {
  vec2 fl = floor(t);
  ivec2 i = ivec2(fl);
  vec2 f = t - fl;
  q = vec4(tgTexel(i), tgTexel(i + ivec2(1, 0)), tgTexel(i + ivec2(0, 1)), tgTexel(i + ivec2(1, 1)));
  h = mix(mix(q.x, q.y, f.x), mix(q.z, q.w, f.x), f.y);
  float dx = mix(q.y - q.x, q.w - q.z, f.y);
  float dz = mix(q.z - q.x, q.w - q.y, f.x);
  n = normalize(vec3(-dx, TG_CELL, -dz));
}
// Smooth slope: central differences at each column, blended across the pixel (the same as central
// differences of the bilinear surface). Eight more fetches.
vec3 tgNormalFine(vec2 t, vec4 q) {
  vec2 fl = floor(t);
  ivec2 i = ivec2(fl);
  vec2 f = t - fl;
  float hm0 = tgTexel(i + ivec2(-1, 0));
  float hm1 = tgTexel(i + ivec2(-1, 1));
  float h20 = tgTexel(i + ivec2(2, 0));
  float h21 = tgTexel(i + ivec2(2, 1));
  float h0m = tgTexel(i + ivec2(0, -1));
  float h1m = tgTexel(i + ivec2(1, -1));
  float h02 = tgTexel(i + ivec2(0, 2));
  float h12 = tgTexel(i + ivec2(1, 2));
  float dx = mix(mix(q.y - hm0, h20 - q.x, f.x), mix(q.w - hm1, h21 - q.z, f.x), f.y);
  float dz = mix(mix(q.z - h0m, q.w - h1m, f.x), mix(h02 - q.x, h12 - q.y, f.x), f.y);
  return normalize(vec3(-dx, 2.0 * TG_CELL, -dz));
}
`;

/**
 * The ground colour and shine for this pixel. Runs at three's color_fragment, so everything it declares
 * (tgN, tgEmit, ...) is still in scope for the lighting and fog code spliced in later.
 */
const GROUND_GLSL = /* glsl */ `
vec3 tgP = vWorldPos;
float tgDist = length(vViewPosition);
vec2 tgT = tgTexelPos(tgP.xz);
float tgOut = tgFall(tgT);
// How much the world position changes from one pixel to the next (taken here, outside any branch):
// for the slope outside the zone, for bump detail, and to know how big things look on screen.
vec3 tgDpx = dFdx(tgP);
vec3 tgDpy = dFdy(tgP);
float tgFootLo = max(min(length(tgDpx), length(tgDpy)), 1e-5);   // a pixel's size (m) across the view
float tgFootHi = max(max(length(tgDpx), length(tgDpy)), 1e-5);   // ... and along it
float tgCellPx = TG_CELL / tgFootLo;                              // pixels one 2 m column spans

// ---- the surface: height and slope from the height map ----
// Outside the zone the land is a smooth fall to the deep: the drawn triangles' own slope will do.
float tgH = tgP.y;
vec3 tgN = normalize(cross(tgDpx, tgDpy));
vec4 tgQ4 = vec4(0.0);
if (tgOut <= 0.0) tgSurfaceCoarse(tgT, tgH, tgN, tgQ4);
float tgAbove = tgH - uSeaLevel;
float tgDepth = -tgAbove;
// The smooth slope wherever a column spans a few pixels (the cheap slope's creases would show there)
// and the sea above doesn't blur it anyway. Blended in, so there is no ring where it starts.
float tgFineN = tgOut > 0.0 ? 0.0 : smoothstep(2.0, 4.0, tgCellPx) * (1.0 - smoothstep(8.0, 12.0, tgDepth));
if (tgFineN > 0.0) tgN = normalize(mix(tgN, tgNormalFine(tgT, tgQ4), tgFineN));

// Deep sea floor, and all of the deep beyond the zone: the sea above is close to opaque, so it is one
// plain colour (below). Shallower floor fades into that same colour, so there is never an edge.
float tgAbyss = max(smoothstep(${f1(ABYSS_FROM)}, ${f1(ABYSS_AT)}, tgDepth), step(1.0, tgOut));

// ---- shape ----
float tgUp = tgN.y;
float tgSteep = 1.0 - smoothstep(0.55, 0.78, tgUp);
float tgFlat = smoothstep(0.78, 0.93, tgUp);
float tgLand = smoothstep(-0.3, 0.5, tgAbove);
float tgSub = 1.0 - smoothstep(-0.6, 0.15, tgAbove);

// ---- noise: patches from the vertices; fine detail hashed near the camera ----
vec4 tgB = vNoiseBig;                                        // ~50 m + ~12 m
vec4 tgM = vNoiseMid;                                        // ~4 m (neutral further off)
float tgNear = 1.0 - smoothstep(${f1(NEAR_DETAIL * 0.65)}, ${f1(NEAR_DETAIL)}, tgDist);
// Where the slope (or the way a cliff faces) is in between, irregular blotches decide which way the
// fine noise is projected, so the change never draws a straight seam or regular stripes.
float tgDith = (tgM.x - 0.5) * 0.8 + (tgB.x - 0.5) * 0.6 + (tgWave(tgP.y * 0.37 + (tgP.x - tgP.z) * 0.29) - 0.5) * 0.2;
vec4 tgF = vec4(0.5);                                        // ~50 cm (on cliffs ~1 m wide, ~3 m tall)
if (tgNear > 0.0 && tgAbyss < 1.0) {
  // From above on gentle ground; on cliffs from the side they face (east/west faces onto the z-y
  // plane, north/south faces onto the x-y plane), so the pattern keeps its shape on a face 40 m tall
  // and 2 m wide instead of stretching from top to bottom. On cliffs it is drawn taller than wide:
  // the drips, stains and weathered flutes of a real rock face.
  vec2 tgO2 = uNoiseOrigin.xz;
  vec2 tgQ = tgP.xz;
  mat2 tgTurn = TG_FINE_TURN;
  if (tgSteep + tgDith * 0.6 > 0.5) {
    tgTurn = TG_SIDE_TURN;
    if (abs(tgN.x) + tgDith * 0.3 > abs(tgN.z)) {
      tgO2 = vec2(uNoiseOrigin.z, 0.0);
      tgQ = vec2(tgP.z, tgP.y * 0.36);
    } else {
      tgO2 = vec2(uNoiseOrigin.x, 0.0);
      tgQ = vec2(tgP.x, tgP.y * 0.36);
    }
  }
  // The lattice is turned off the world axes and bent by the medium noise, so its squares never line
  // up into visible grids at patch edges.
  vec2 tgFq = tgTurn * (tgQ - tgO2) + (tgM.zw - 0.5) * 1.5;
  tgF = mix(vec4(0.5), tgValue4(tgFq, ivec2(tgTurn * tgO2)), tgNear);
}
// On cliffs the vertex noise is the same over the whole face (one triangle spans its height), so
// rock and patch outlines there lean on the side-projected fine noise instead.
float tgSW = tgSteep * tgNear;

// Fine texture up close: the fine noise as gentle relief, plus crisp knobs and dips where it crosses
// two sharp levels (pebbles and clods, rock knobs and cracks). It also makes tiny bumps in the lighting.
float tgClose = 1.0 - smoothstep(16.0, 36.0, tgDist);
float tgCrisp = 1.0 - smoothstep(30.0, 60.0, tgDist);
float tgFw = fwidth(tgF.w) + 1e-3;
float tgKnob = smoothstep(0.74 - tgFw, 0.74 + tgFw, tgF.w) * tgCrisp;
float tgDip = (1.0 - smoothstep(0.26 - tgFw, 0.26 + tgFw, tgF.w)) * tgCrisp;
float tgTex = mix(0.5, tgF.w, tgClose) + (0.06 * tgKnob - 0.04 * tgDip) * tgClose;
float tgDhx = dFdx(tgTex);
float tgDhy = dFdy(tgTex);
// Grains in two sizes, 4 cm and 16 cm cells (sand grains and shell bits, crumbs, tufts), each drawn
// only while one of its cells spans about 1 to 16 pixels along the view, and only near the camera.
// Pixels of the gentle ground near the camera see at most both (two hashes).
float tgGrainPx = ${(1 / 24).toFixed(5)} / tgFootHi;
float tgGrain4 = tgGrainShow(tgGrainPx) * (1.0 - tgSteep) * tgNear;
float tgGrain16 = tgGrainShow(tgGrainPx * 4.0) * (1.0 - tgSteep) * tgNear;

gSpec = 0.0;
gShine = 30.0;
gSpark = 0.0;
gCaustic = 0.0;
// Patch edges are crisper close to the camera, except on cliffs, where crisp blotches look like camouflage.
gPatchSoft = mix(0.45, 1.0, max(smoothstep(8.0, 60.0, tgDist), tgSteep));
vec3 tgEmit = vec3(0.0);
float tgGlowKeep = 0.0;
float tgLava = 0.0;
float tgHeat = 0.0;
float tgSandW = 0.0;
float tgGrassW = 0.0;
vec2 tgFlow2 = vec2(0.5);
vec3 tgCol = ${c(G.seabedFloor)};

if (tgAbyss < 1.0) {
  // ---- world data at this pixel (maps without mipmaps, so reading them inside a branch is safe) ----
  vec4 tgG = textureLod(uGroundTex, (tgT + 0.5) / vec2(float(TG_NX), float(TG_NZ)), 0.0);
  tgLava = tgG.r * 12.75;         // molten lava thickness (m)
  tgHeat = tgG.g;                 // lava temperature 0..1 (it freezes at 0.3)
  float tgSed = tgG.b * 5.1;      // sand thickness (m)

  // Lava and stream water: the two flow-map copies from the vertices, cross-faded as each restarts.
  tgFlow2 = mix(vFlow.xy, vFlow.zw, abs(fract(uTime * 0.25) * 2.0 - 1.0));

  // The life maps are 4 m squares; reading them a few metres off, wobbled by the noise, turns their
  // stair-step edges into natural outlines. Far away (a column only a few pixels wide) the vertices
  // are too far apart to carry a wobble that fine, so there a small one comes from two bent waves at
  // odd angles (no hashes). Close up it would comb sharp edges into a regular fringe, so it fades out.
  vec2 tgWob = vec2(
    tgWave(dot(tgP.xz, vec2(0.121, 0.047)) + 0.6 * tgWave(dot(tgP.xz, vec2(-0.043, 0.109)) + 0.3)),
    tgWave(dot(tgP.xz, vec2(0.052, -0.117)) + 0.6 * tgWave(dot(tgP.xz, vec2(0.097, 0.068)) + 0.7))) - 0.5;
  vec2 tgWarp = (tgB.xy - 0.5) * 8.0 + (tgM.zw - 0.5) * 5.0 + tgWob * 3.5 * (1.0 - smoothstep(5.0, 10.0, tgCellPx));
  vec2 tgCuv = (tgP.xz + tgWarp - uZone.xy) / uZone.zw;
  vec4 tgCB = textureLod(uCoverBTex, tgCuv, 0.0);   // weathering/soil, guano, moisture, burn
  vec4 tgCC = textureLod(uCoverCTex, tgCuv, 0.0);   // coral, seagrass, coralline, stream/marsh
  vec4 tgCA = vec4(0.0);                            // lichen, moss, grass, forest floor: land only
  if (tgLand > 0.0) tgCA = textureLod(uCoverATex, tgCuv, 0.0);

  // Which kinds of sand and rock: the nearest column, nudged by the fine noise so kind edges look natural.
  vec2 tgJit = (tgF.zw - 0.5) * 1.6 + (tgM.xy - 0.5) * 1.2;
  float tgKinds = texelFetch(uGroundTex, clamp(ivec2(floor(tgT + 0.5 + tgJit)), ivec2(0), ivec2(TG_NX - 1, TG_NZ - 1)), 0).a * 255.0 + 0.5;
  float tgRockKind = mod(floor(tgKinds), 4.0);
  float tgSandKind = floor(floor(tgKinds) / 4.0) * (4.0 / 255.0);
  float tgIsStone = step(0.5, tgRockKind) * step(tgRockKind, 1.5);
  float tgIsLime = step(1.5, tgRockKind);
  float tgIsBasalt = 1.0 - tgIsStone - tgIsLime;

  float tgDry = 1.0 - smoothstep(0.2, 0.65, tgCB.b);   // dry side: the lee, the rain shadow
  float tgWth = tgCB.r;                               // 0 fresh rock .. 1 soil
  tgSandW = smoothstep(0.02, 0.22, tgSed) * (1.0 - 0.7 * tgSteep);
  vec2 tgWdir = normalize(uWind.xy + vec2(1e-4, 0.0));

  // ---- rock, by kind and age ----
  float tgRockN = tgSpread(mix(0.45 * tgB.y + 0.35 * tgM.y + 0.2 * tgF.y, 0.25 * tgB.y + 0.75 * tgF.y, tgSW));
  vec3 basalt = mix(${c(G.basaltFresh)}, ${c(G.basaltMatte)}, smoothstep(0.03, 0.16, tgWth));
  basalt = mix(basalt, ${c(G.basaltWeathered)}, smoothstep(0.16, 0.4, tgWth));
  basalt = mix(basalt, ${c(G.basaltRust)}, smoothstep(0.32, 0.55, tgWth) * smoothstep(0.3, 0.7, tgCB.b) * smoothstep(0.55, 0.8, mix(tgM.z, tgF.z, tgSW)) * 0.75);
  basalt = mix(basalt, ${c(G.basaltOld)}, smoothstep(0.5, 0.9, tgWth) * (0.35 + 0.65 * tgSteep));
  vec3 stone = mix(${c(G.stone)}, ${c(G.stoneDark)}, tgRockN) * mix(1.0, 0.88, smoothstep(0.3, 0.9, tgWth));
  vec3 lime = mix(${c(G.limestone)}, ${c(G.limestoneOld)}, smoothstep(0.2, 0.8, tgWth));
  vec3 rock = basalt * tgIsBasalt + stone * tgIsStone + lime * tgIsLime;
  rock *= (0.82 + 0.36 * tgRockN) * (1.0 + (tgTex - 0.5) * 0.4) * (1.0 + 0.1 * tgKnob - 0.14 * tgDip);
  // Cliffs, seen from the side: level bands (the stacked lava flows of a sea cliff) and upright
  // joints, each drawn on the plane the face looks along and blended by how it faces. They fade out
  // before they get too thin to draw.
  float tgFaceX = abs(tgN.x) / (abs(tgN.x) + abs(tgN.z) + 1e-4);
  float tgJoint = mix(tgWave(tgP.x * 0.43 + 0.8 * tgWave(tgP.y * 0.13 + tgP.x * 0.07)), tgWave(tgP.z * 0.43 + 0.8 * tgWave(tgP.y * 0.13 + tgP.z * 0.07)), tgFaceX);
  float tgBand = tgWave(tgP.y * 0.36 + tgM.x * 1.2 + tgB.z + 0.12 * tgJoint);
  rock *= 1.0 + tgSteep * smoothstep(1.0, 3.0, tgCellPx) * ((tgBand - 0.5) * 0.32 + (tgJoint - 0.5) * 0.2);
  // Fresh basalt is glassy.
  gSpec = tgIsBasalt * (1.0 - smoothstep(0.02, 0.14, tgWth)) * 0.6;
  gShine = 36.0;
  // Salt crust in the splash zone of windward rock shores (wind comes from the east, +x).
  float tgSplash = smoothstep(0.2, 0.9, tgAbove) * (1.0 - smoothstep(2.2, 3.6, tgAbove)) * smoothstep(0.15, 0.6, tgN.x);
  rock = mix(rock, ${c(G.saltCrust)}, tgSplash * (0.2 + 0.2 * tgF.z));

  // ---- soil on flat, weathered ground: redder in the lee, dark humus under forest, crumbly up close ----
  float tgSoilW = smoothstep(0.55, 0.8, tgWth) * tgFlat;
  vec3 soil = mix(${c(G.soilYoung)}, ${c(G.soilRed)}, tgDry * 0.85);
  soil = mix(soil, ${c(G.soilHumus)}, smoothstep(0.2, 0.7, tgCA.a)) * (0.86 + 0.28 * tgSpread(0.5 * tgM.x + 0.5 * tgF.x)) * (1.0 + (tgTex - 0.5) * 0.5);
  soil *= 1.0 - 0.16 * tgKnob;
  tgCol = mix(rock, soil, tgSoilW);
  float tgBare = 1.0 - tgSoilW;

  // ---- sand: black, grey, gold or coral white; wet and dark at the waterline ----
  vec3 sand = tgSandColor(tgSandKind) * (0.94 + 0.12 * tgSpread(0.6 * tgM.z + 0.4 * tgF.z)) * (1.0 + (tgTex - 0.5) * 0.1);
  sand *= 1.0 + 0.07 * tgKnob - 0.05 * tgDip;
  // Wet in the swash (dark and glossy), damp a little higher up; storms throw the sea further up.
  // Under water both apply in full.
  float tgWetSea = 1.0 - smoothstep(0.05, 0.55 + 0.8 * uStorm, tgAbove);
  float tgDamp = 1.0 - smoothstep(0.3, 1.5 + 0.8 * uStorm, tgAbove);
  // Under water and in the swash the sea combs the sand into ripples.
  float tgRipple = tgWave(dot(tgP.xz, tgWdir) * 1.3 + 1.6 * tgM.y + 2.0 * tgF.x) * tgWetSea * tgNear;
  sand *= 1.0 - 0.08 * tgRipple;
  sand = mix(sand, sand * vec3(0.84, 0.82, 0.78), max(tgDamp, uWet * 0.7 * tgLand));
  sand = mix(sand, sand * vec3(0.66, 0.64, 0.62), tgWetSea);
  tgCol = mix(tgCol, sand, tgSandW);
  tgBare *= 1.0 - tgSandW;
  gSpec = mix(gSpec, 0.35 * smoothstep(0.4, 1.0, tgWetSea) * tgLand, tgSandW);
  gShine = mix(gShine, 70.0, tgSandW);

  // ---- living cover on land, as patches that grow outward ----
  float tgMoss = 0.0;
  if (tgLand > 0.0) {
    // Lichen speckle (sage and pale yellow; orange where seabirds sit), and a dusky crust on old sand.
    float tgLichen = tgPatch(tgCA.r, tgSpread(mix(0.6 * tgB.x + 0.4 * tgM.x, 0.55 * tgB.x + 0.45 * tgF.x, tgSW)), 0.12, tgF.x) * tgLand;
    vec3 lichenCol = mix(${c(G.lichenSage)}, ${c(G.lichenYellow)}, tgF.y * tgNear + tgM.y * (1.0 - tgNear));
    lichenCol = mix(lichenCol, ${c(G.lichenOrange)}, smoothstep(0.12, 0.45, tgCB.g) * smoothstep(0.5, 0.65, tgSpread(0.7 * tgF.w + 0.3 * tgM.w)));
    tgCol = mix(tgCol, lichenCol, tgLichen * 0.75 * tgBare);
    tgCol = mix(tgCol, ${c(G.crust)}, tgLichen * 0.12 * tgSandW);
    // Moss velvet: brighter when moist.
    tgMoss = tgPatch(tgCA.g, tgSpread(mix(0.6 * tgB.y + 0.4 * tgM.y, 0.55 * tgB.y + 0.45 * tgF.y, tgSW)), 0.13, tgF.z) * tgLand;
    vec3 mossCol = mix(${c(G.mossDry)}, ${c(G.mossWet)}, smoothstep(0.2, 0.85, tgCB.b)) * (0.9 + 0.2 * tgF.w) * (1.0 - 0.1 * tgDip);
    tgCol = mix(tgCol, mossCol, tgMoss * (1.0 - 0.8 * tgSandW));
    // Grass on gentle ground: green, golden in the lee in the dry season, with wind waves rolling
    // over it, and crisp darker and lighter tufts up close.
    float tgGrass = tgPatch(tgCA.b, tgSpread(0.65 * tgB.z + 0.35 * tgM.z), 0.14, tgF.x) * smoothstep(0.5, 0.75, tgUp) * tgLand;
    vec3 grassCol = mix(${c(G.grass)}, ${c(G.grassLight)}, tgSpread(0.6 * tgM.w + 0.4 * tgB.w));
    vec3 goldCol = mix(${c(G.grassGold)}, ${c(G.grassGoldLight)}, tgM.w);
    grassCol = mix(grassCol, goldCol, clamp(uDry * (0.2 + 0.8 * tgDry), 0.0, 1.0));
    grassCol *= 1.0 + (0.04 + 0.08 * length(uWind.xy)) * (tgWave(dot(tgP.xz, tgWdir) * 0.028 - uTime * 0.125 + 0.4 * tgB.w) - 0.5);
    grassCol *= (0.9 + 0.2 * tgF.y) * (1.0 + (tgTex - 0.5) * 0.4) * (1.0 + 0.04 * tgKnob - 0.06 * tgDip);
    tgCol = mix(tgCol, grassCol, tgGrass);
    tgGrassW = tgGrass;
    gSpec *= 1.0 - max(tgGrass, tgMoss);
    // Forest floor: leaf litter and the canopy's shade. Far away (where the trees themselves are not
    // drawn) the forest shows as its canopy colour, so the island still reads green from above.
    float tgForest = tgCA.a * tgLand;
    vec3 litter = mix(${c(G.litter)}, ${c(G.litterDark)}, tgM.x);
    tgCol = mix(tgCol, litter, smoothstep(0.3, 0.8, tgForest) * tgFlat * 0.45);
    tgCol *= 1.0 - 0.25 * tgForest;
    vec3 canopy = mix(${c(G.canopyDry)}, mix(${c(G.canopy)}, ${c(G.canopyWet)}, smoothstep(0.6, 0.9, tgCB.b)), smoothstep(0.2, 0.55, tgCB.b));
    canopy *= 0.78 + 0.44 * tgB.w;
    tgCol = mix(tgCol, canopy, smoothstep(0.15, 0.55, tgForest) * smoothstep(300.0, 520.0, tgDist));
    // Guano whitewash on cliffs and ledges below seabird colonies (upright streaks on cliffs).
    float tgGuano = tgPatch(tgCB.g, tgSpread(mix(0.6 * tgM.z + 0.4 * tgB.x, 0.55 * tgB.x + 0.45 * tgF.w, tgSW)), 0.14, tgF.w) * tgLand;
    tgCol = mix(tgCol, ${c(G.guano)}, tgGuano * 0.75);
    // Burn scars.
    tgCol = mix(tgCol, ${c(G.char)} * (0.8 + 0.4 * tgM.y), tgPatch(tgCB.a, tgSpread(mix(0.6 * tgM.y + 0.4 * tgB.x, 0.55 * tgB.x + 0.45 * tgF.y, tgSW)), 0.12, tgF.y) * 0.85 * tgLand);
    // Streams and marsh: glossy ribbons with ripples running downhill.
    float tgStream = smoothstep(0.32, 0.6, tgCC.a + (tgM.w - 0.5) * 0.35) * tgLand;
    if (tgStream > 0.0) {
      float tgRun = tgSpread(0.6 * tgFlow2.x + 0.4 * tgFlow2.y);
      vec3 water = mix(${c(G.streamWater)}, ${c(G.marshGreen)}, tgFlat * smoothstep(0.4, 0.8, tgCA.b + tgCA.g) * 0.6);
      tgCol = mix(tgCol, water * (0.85 + 0.3 * tgRun), tgStream);
      gSpec = mix(gSpec, 0.9, tgStream);
      gShine = mix(gShine, 90.0, tgStream);
    }
  }

  // Grains and crumbs up close; a few dry sand grains catch the sun.
  if (tgGrain4 > 0.0) {
    vec2 tgGr = tgGrains(tgP.xz, 24.0, tgGrainPx);
    tgCol *= 1.0 + tgGr.x * mix(0.16, 0.36, tgSandW) * tgGrain4;
    gSpark = tgGr.y * tgSandW * (1.0 - max(tgGrassW, tgMoss)) * (1.0 - tgWetSea) * (1.0 - uWet) * tgGrain4 * 1.6;
  }
  if (tgGrain16 > 0.0) {
    vec2 tgGr = tgGrains(tgP.xz, 6.0, tgGrainPx * 4.0);
    tgCol *= 1.0 + tgGr.x * mix(0.14, 0.22, tgSandW) * tgGrain16;
  }

  // ---- under the sea: seagrass meadows, coral heads, pink coralline crust ----
  float tgSeagrass = tgPatch(tgCC.g, tgSpread(0.55 * tgB.w + 0.45 * tgM.w), 0.12, tgF.z) * tgSub;
  tgCol = mix(tgCol, mix(${c(G.seagrass)}, ${c(G.seagrassDark)}, tgSpread(0.5 * tgM.x + 0.5 * tgF.x)), tgSeagrass * 0.85);
  float tgCoral = tgPatch(tgCC.r, tgSpread(0.45 * tgB.x + 0.55 * tgM.x), 0.1, tgF.y) * tgSub;
  vec3 coralCol = mix(mix(${c(G.coralPink)}, ${c(G.coralOchre)}, tgM.y), mix(${c(G.coralPurple)}, ${c(G.coralOlive)}, tgB.y), smoothstep(0.4, 0.6, tgM.z));
  tgCol = mix(tgCol, coralCol * (0.8 + 0.4 * tgF.w), tgCoral);
  tgCol = mix(tgCol, ${c(G.coralline)}, tgPatch(tgCC.b, tgSpread(0.5 * tgM.y + 0.5 * tgB.y), 0.12, tgF.z) * 0.55 * (1.0 - tgSandW));

  // Sunlight dancing on the shallow sea floor (only close and shallow, where it can be seen).
  if (tgDepth > 0.0 && tgDepth < 6.0 && tgDist < 80.0) {
    vec2 tgCp = tgP.xz * 0.55 + (tgM.xy - 0.5) * 2.5 + (tgF.zw - 0.5) * 0.6;
    gCaustic = tgCaustics(tgCp, uTime) * 0.7 * smoothstep(0.0, 0.4, tgDepth) * (1.0 - tgDepth / 6.0) * (1.0 - smoothstep(50.0, 80.0, tgDist));
  }

  // Deeper floor fades into the plain deep colour.
  tgCol = mix(tgCol, ${c(G.seabedFloor)}, tgAbyss);
}

// ---- lava: glowing, flowing downhill, crusting over with glowing cracks as it cools ----
float tgLavaW = smoothstep(0.0, 0.06, tgLava);
if (tgLavaW > 0.0) {
  float heat = clamp((tgHeat - 0.3) / 0.7, 0.0, 1.0);          // 0 about to freeze .. 1 fresh
  // Brighter and darker melt sliding downhill.
  float flowN = tgSpread(0.75 * tgFlow2.x + 0.25 * tgFlow2.y);
  // Crust plates with glowing cracks that narrow as it cools: the borders of a grid bent by the noise
  // into irregular plates (far away, where cracks are smaller than a pixel, their average glow).
  float crackW = mix(0.015, 0.12, heat);
  vec2 tgPlate = tgP.xz * 0.45 + (tgF.xy - 0.5) * 1.1 + (tgM.xy - 0.5) * 1.4 + (tgB.zw - 0.5) * 2.0;
  vec2 tgPd = abs(fract(tgPlate) - 0.5);
  float crack = (1.0 - smoothstep(0.0, crackW, 0.5 - max(tgPd.x, tgPd.y))) * tgNear + 0.25 * (1.0 - tgNear);
  float molten = smoothstep(0.32, 0.62, heat);
  // Hot crust still glows a dull red between the cracks.
  float glow = heat * mix(max(crack * (0.55 + 0.45 * heat), 0.18 * heat), 0.6 + 0.4 * flowN, molten);
  float breathe = 0.88 + 0.12 * tgWave(uTime * 0.2 + tgB.x);
  vec3 crustCol = mix(${c(G.crustCool)}, ${c(G.crustHot)}, smoothstep(0.0, 0.5, heat));
  tgCol = mix(tgCol, mix(crustCol, ${c(G.lavaDeep)} * 0.6, molten), tgLavaW);
  // Lava under water quenches: it glows dimly through the sea.
  float tgUnder = exp(-max(tgDepth, 0.0) * 0.6);
  tgEmit = tgLavaRamp(glow) * glow * (1.1 + 1.4 * glow) * breathe * tgLavaW * tgUnder;
  tgGlowKeep = tgLavaW * smoothstep(0.0, 0.4, glow);
  // Cooling crust is glossy (pahoehoe skin).
  gSpec = mix(gSpec, 0.45 * (1.0 - molten), tgLavaW);
  gShine = mix(gShine, 55.0, tgLavaW);
  gSpark = 0.0;
}

// Up close, the fine texture as tiny bumps (surface-gradient bump mapping from screen derivatives):
// rough on rock, crumbly on soil, soft on sand, none on lava.
if (tgClose > 0.0) {
  float tgAmp = tgClose * mix(mix(0.06, 0.035, tgGrassW), 0.01, tgSandW) * (1.0 - tgLavaW);
  vec3 r1 = cross(tgDpy, tgN);
  vec3 r2 = cross(tgN, tgDpx);
  float det = dot(tgDpx, r1);
  vec3 grad = sign(det) * (tgDhx * r1 + tgDhy * r2);
  if (abs(det) > 1e-9) tgN = normalize(abs(det) * tgN - grad * tgAmp);
}

// Wet after rain: everything darkens a little and takes a sheen (sand was darkened above).
float tgRainWet = uWet * tgLand * (1.0 - tgLavaW);
tgCol *= 1.0 - 0.22 * tgRainWet * (1.0 - tgSandW);
gSpec = max(gSpec, 0.3 * tgRainWet);

// The sea swallows colour with depth: reds first, then everything fades toward deep teal.
if (tgDepth > 0.0) {
  tgCol *= exp(-tgDepth * vec3(0.2, 0.055, 0.04));
  tgCol = mix(tgCol, ${c(G.deepWater)}, 1.0 - exp(-tgDepth * 0.065));
  gSpec *= exp(-tgDepth * 2.0);
}

// Warm light thrown on the ground by the biggest molten area (strongest at night).
float tgGlowD = distance(tgP.xz, uLavaGlow.xy);
float tgGlowFall = 1.0 - smoothstep(uLavaGlow.z * 0.4, uLavaGlow.z * 1.8 + 12.0, tgGlowD);
vec3 tgLavaLight = ${c(G.lavaLight)} * uLavaGlow.w * tgGlowFall * tgGlowFall * (0.6 + 1.8 * uNight);

diffuseColor.rgb = tgCol;
`;

/**
 * The ground material. One instance draws all the land; the meshes using it must sit at the world
 * origin with no transform (positions are world coordinates).
 */
export function createTerrainMaterial(u: WorldUniforms, tu: TerrainUniforms): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  // Fog is applied by hand from the shared uniforms (so molten lava can shine through it).
  material.fog = false;
  material.onBeforeCompile = (shader) => {
    addWorldUniforms(shader, u);
    shader.uniforms.uLod = tu.uLod;
    shader.uniforms.uNoiseOrigin = tu.uNoiseOrigin;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WORLD_UNIFORMS_GLSL}\n${HEIGHT_GLSL}\n${HASH_GLSL}\n${VERTEX_GLSL}\n${VERTEX_NOISE_GLSL}`)
      .replace('#include <beginnormal_vertex>', 'vec3 tgPos;\nvec3 objectNormal;\ntgTerrainVertex(tgPos, objectNormal);\ntgVertexNoise(tgPos, objectNormal);')
      .replace('#include <begin_vertex>', 'vec3 transformed = tgPos;\nvWorldPos = tgPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WORLD_UNIFORMS_GLSL}\n${HEIGHT_GLSL}\n${HASH_GLSL}\n${WAVE_GLSL}\n${NOISE_GLSL}\n${FRAGMENT_PARS_GLSL}`)
      .replace('#include <lights_lambert_pars_fragment>', LIGHT_GLSL)
      .replace('#include <color_fragment>', GROUND_GLSL)
      .replace(
        '#include <normal_fragment_begin>',
        'float faceDirection = gl_FrontFacing ? 1.0 : -1.0;\nvec3 normal = normalize((viewMatrix * vec4(tgN, 0.0)).xyz);\nvec3 nonPerturbedNormal = normal;',
      )
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += tgEmit;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse += tgLavaLight * diffuseColor.rgb;')
      .replace(
        '#include <fog_fragment>',
        'gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, smoothstep(uFogNear, uFogFar, vViewPosition.z) * (1.0 - 0.85 * tgGlowKeep));',
      );
  };
  return material;
}

/** The matching shadow-pass material: same vertex placement, plain depth. */
export function createTerrainDepthMaterial(u: WorldUniforms, tu: TerrainUniforms): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial();
  material.onBeforeCompile = (shader) => {
    addWorldUniforms(shader, u);
    shader.uniforms.uLod = tu.uLodShadow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WORLD_UNIFORMS_GLSL}\n${HEIGHT_GLSL}\n${VERTEX_GLSL}`)
      .replace('#include <begin_vertex>', 'vec3 tgPos;\nvec3 tgNrm;\ntgTerrainVertex(tgPos, tgNrm);\nvec3 transformed = tgPos;');
  };
  return material;
}
