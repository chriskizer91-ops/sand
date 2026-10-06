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
 * Noise is plain arithmetic with integer hashes (no sin, no stored pattern), in three sizes:
 * - big (~12 m) and medium (~4 m) patches are worked out per VERTEX and handed to the pixels, which is
 *   nearly free (there are ~20 times fewer vertices than pixels);
 * - fine (~50 cm) detail is one 4-hash value noise per pixel, near the camera only, measured from a point
 *   near the camera so it stays sharp anywhere in the 1 km zone; sand grains add one more hash up close.
 * So: at most 5 hashes per pixel near the camera and none far away. Regular things (rock layers,
 * ripples, wind waves over grass, caustics) use cheap smooth "waves" made from folded lines.
 * Heavy work (fine slope, detail, caustics) is skipped where it can't be seen.
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
  // Geomorph: near the far end of its level's range, every odd vertex slides onto its even
  // neighbour, so the grid smoothly becomes the next coarser one. If that completes, the coarser
  // level may itself be morphing here (its own nodes do, across a shared edge), so carry on: each
  // vertex lands exactly where any coarser neighbour puts it, and no crack can open between them.
  // The distance is to the main camera (uCamPos), also in the shadow pass.
  for (int i = 0; i < 4; i++) {
    float d = distance(uCamPos, vec3(p.x, tgGridHeight(p), p.y));
    float k = clamp((d - range * uLod.y) / (range * (1.0 - uLod.y)), 0.0, 1.0);
    vec2 odd = mod(floor((p - TG_GRID0) / spacing + 0.5), 2.0);
    p -= odd * spacing * k;
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

/** Big and medium patch noise and the flowing noise of lava and streams, worked out per vertex (main pass only). */
const VERTEX_NOISE_GLSL = /* glsl */ `
uniform sampler2D uGroundTex;
uniform sampler2D uCoverCTex;
varying vec3 vWorldPos;
varying vec4 vNoiseBig;
varying vec4 vNoiseMid;
varying vec4 vFlow;
void tgVertexNoise(vec3 pos, vec3 nrm) {
  vNoiseBig = tgValue4(pos.xz * 0.08, ivec2(0));
  // Medium patches need closely spaced vertices; where the grid is coarse they fade to neutral
  // (sampling them sparsely would only make false patterns).
  float near = 1.0 - smoothstep(uLod.x * 0.6, uLod.x * 1.2, distance(uCamPos, pos));
  vNoiseMid = mix(vec4(0.5), tgValue4(pos.xz * 0.25 + 17.0, ivec2(0)), near);
  // Molten lava and running water: two copies of a noise field sliding downhill, each restarting
  // while the other is fully shown (a "flow map"), so they keep moving without ever stretching.
  // Close up the blobs are small; lava far away (where vertices are sparse) gets big slow ones.
  vFlow = vec4(0.5);
  vec2 t = tgTexelPos(pos.xz);
  bool lava = texelFetch(uGroundTex, clamp(ivec2(floor(t + 0.5)), ivec2(0), ivec2(TG_NX - 1, TG_NZ - 1)), 0).r > 0.0;
  bool water = texture(uCoverCTex, (pos.xz - uZone.xy) / uZone.zw).a > 0.1;
  if (lava || (water && near > 0.0)) {
    float slope = 1.0 - nrm.y;
    vec2 down = normalize(nrm.xz + vec2(1e-4, 0.0)) * (lava ? 0.6 + 3.0 * slope : 1.5 + 5.0 * slope);
    float ph0 = fract(uTime * 0.25);
    float ph1 = fract(uTime * 0.25 + 0.5);
    vec4 fine = vec4(0.5);
    vec4 coarse = vec4(0.5);
    if (near > 0.0) {
      float freq = lava ? 0.35 : 0.6;
      fine = vec4(tgValue4((pos.xz - down * ph0 * 3.0) * freq, ivec2(0)).xy, tgValue4((pos.xz - down * ph1 * 3.0) * freq + 7.3, ivec2(0)).xy);
    }
    if (lava && near < 1.0) {
      coarse = vec4(tgValue4((pos.xz - down * ph0 * 8.0) * 0.1, ivec2(0)).xy, tgValue4((pos.xz - down * ph1 * 8.0) * 0.1 + 3.1, ivec2(0)).xy);
    }
    vFlow = mix(coarse, fine, near);
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
#define TG_FINE_TURN mat2(1.75, 0.96875, -0.96875, 1.75)
// Spread a blend of noise channels (which bunch up around 0.5) back over 0..1.
float tgSpread(float n) {
  return clamp((n - 0.5) * 1.9 + 0.5, 0.0, 1.0);
}
// Cover grows outward as patches: it shows where its amount beats the local (big + medium) noise.
// The fine noise then frays the patch edges into specks, strongest right at the edge, so cover
// spreads like real lichen or moss rather than like a stain.
float tgPatch(float amount, float n, float soft, float fine) {
  float p = smoothstep(n - soft, n + soft, amount * 1.15 - 0.08);
  return clamp(p + (fine - 0.5) * 3.2 * p * (1.0 - p), 0.0, 1.0);
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
// Height and slope at a pixel from the four surrounding columns (cheap; used far away and on deep sea floor).
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
// Smooth slope near the camera: central differences at each column, blended across the pixel
// (the same as central differences of the bilinear surface). Eight more fetches.
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
// Slope of the drawn triangles: only used outside the zone, where the land is a smooth fall to the deep.
vec3 tgGeoN = normalize(cross(dFdx(tgP), dFdy(tgP)));
float tgH;
vec3 tgN;
vec4 tgQ4;
tgSurfaceCoarse(clamp(tgT, vec2(0.0), vec2(float(TG_NX - 1), float(TG_NZ - 1))), tgH, tgN, tgQ4);
if (tgOut > 0.0) {
  tgH = tgP.y;
  tgN = tgGeoN;
}
float tgAbove = tgH - uSeaLevel;
float tgDepth = -tgAbove;
if (tgOut <= 0.0 && tgDist < 240.0 && tgDepth < 10.0) tgN = tgNormalFine(tgT, tgQ4);

// ---- world data at this pixel ----
vec4 tgG = texture(uGroundTex, (tgT + 0.5) / vec2(float(TG_NX), float(TG_NZ)));
float tgLava = tgG.r * 12.75;     // molten lava thickness (m)
float tgHeat = tgG.g;             // lava temperature 0..1 (it freezes at 0.3)
float tgSed = tgG.b * 5.1;        // sand thickness (m)

// ---- noise: big and medium patches from the vertices; fine detail hashed near the camera ----
vec4 tgB = vNoiseBig;                                        // ~12 m
vec4 tgM = vNoiseMid;                                        // ~4 m (neutral far away)
float tgNear = 1.0 - smoothstep(${f1(NEAR_DETAIL * 0.65)}, ${f1(NEAR_DETAIL)}, tgDist);
vec4 tgF = vec4(0.5);                                        // ~50 cm
if (tgDist < ${f1(NEAR_DETAIL)}) {
  // The lattice (2 cells per metre) is turned about 29 degrees off the world axes and bent by the
  // medium noise, so its squares never line up into visible grids at patch edges. The matrix
  // entries are whole 256ths (1.75 = 448/256, 0.96875 = 248/256; 1.75^2 + 0.96875^2 = 4), so the
  // snapped origin (a multiple of 256 m) still lands exactly on lattice cells.
  vec2 tgFq = TG_FINE_TURN * (tgP.xz - uNoiseOrigin.xz) + (tgM.zw - 0.5) * 1.5;
  tgF = mix(vec4(0.5), tgValue4(tgFq, ivec2(TG_FINE_TURN * uNoiseOrigin.xz)), tgNear);
}

// Lava and stream water: the two flow-map copies from the vertices, cross-faded as each restarts.
vec2 tgFlow2 = mix(vFlow.xy, vFlow.zw, abs(fract(uTime * 0.25) * 2.0 - 1.0));

// The life maps are 4 m squares; reading them a few metres off, wobbled by the noise, turns their
// stair-step edges into natural outlines.
vec2 tgWarp = (tgB.xy - 0.5) * 8.0 + (tgM.zw - 0.5) * 5.0;
vec2 tgCuv = (tgP.xz + tgWarp - uZone.xy) / uZone.zw;
vec4 tgCA = texture(uCoverATex, tgCuv);   // lichen, moss, grass, forest floor
vec4 tgCB = texture(uCoverBTex, tgCuv);   // weathering/soil, guano, moisture, burn
vec4 tgCC = texture(uCoverCTex, tgCuv);   // coral, seagrass, coralline, stream/marsh

// Which kinds of sand and rock: the nearest column, nudged by the fine noise so kind edges look natural.
vec2 tgJit = (tgF.zw - 0.5) * 1.6 + (tgM.xy - 0.5) * 1.2;
float tgKinds = texelFetch(uGroundTex, clamp(ivec2(floor(tgT + 0.5 + tgJit)), ivec2(0), ivec2(TG_NX - 1, TG_NZ - 1)), 0).a * 255.0 + 0.5;
float tgRockKind = mod(floor(tgKinds), 4.0);
float tgSandKind = floor(floor(tgKinds) / 4.0) * (4.0 / 255.0);
float tgIsStone = step(0.5, tgRockKind) * step(tgRockKind, 1.5);
float tgIsLime = step(1.5, tgRockKind);
float tgIsBasalt = 1.0 - tgIsStone - tgIsLime;

// Fine texture up close (pebbles, crumbs, tufts): the fine noise, which also makes tiny bumps in
// the lighting (below). Derivatives are taken here, outside any branch.
float tgClose = 1.0 - smoothstep(16.0, 36.0, tgDist);
float tgTex = mix(0.5, tgF.w, tgClose);
vec3 tgDpx = dFdx(tgP);
vec3 tgDpy = dFdy(tgP);
float tgDhx = dFdx(tgTex);
float tgDhy = dFdy(tgTex);

// Sand grains are 4 cm cells: only drawn while a cell is about one pixel (no blocks up close, no shimmer far).
float tgGrainPx = 1.0 / max(fwidth((tgP.x + tgP.z) * 24.0), 1e-4);
float tgGrainFade = smoothstep(0.5, 1.0, tgGrainPx) * (1.0 - smoothstep(1.4, 2.2, tgGrainPx));

// ---- shape ----
float tgUp = tgN.y;
float tgSteep = 1.0 - smoothstep(0.55, 0.78, tgUp);
float tgFlat = smoothstep(0.78, 0.93, tgUp);
float tgLand = smoothstep(-0.3, 0.5, tgAbove);
float tgSub = 1.0 - smoothstep(-0.6, 0.15, tgAbove);
float tgDry = 1.0 - smoothstep(0.2, 0.65, tgCB.b);   // dry side: the lee, the rain shadow
float tgWth = tgCB.r;                               // 0 fresh rock .. 1 soil
float tgSandW = smoothstep(0.02, 0.22, tgSed) * (1.0 - 0.7 * tgSteep);
vec2 tgWdir = normalize(uWind.xy + vec2(1e-4, 0.0));

gSpec = 0.0;
gShine = 30.0;
gSpark = 0.0;
gCaustic = 0.0;
vec3 tgEmit = vec3(0.0);
float tgGlowKeep = 0.0;
float tgGrassW = 0.0;
vec3 tgCol;

if (tgDepth > 10.0 && tgLava <= 0.0) {
  // Deep sea floor: the sea is nearly opaque here, so keep it plain and cheap.
  vec3 rock = mix(mix(${c(G.basaltWeathered)}, ${c(G.stone)}, tgIsStone), ${c(G.limestone)}, tgIsLime);
  tgCol = mix(rock, tgSandColor(tgSandKind), tgSandW) * (0.86 + 0.28 * tgB.x);
  tgCol = mix(tgCol, ${c(G.seagrassDark)}, tgPatch(tgCC.g, tgSpread(0.6 * tgB.w + 0.4 * tgM.w), 0.15, 0.5) * 0.7);
  tgCol = mix(tgCol, mix(${c(G.coralPurple)}, ${c(G.coralOchre)}, tgB.y), tgPatch(tgCC.r, tgSpread(0.5 * tgB.x + 0.5 * tgM.x), 0.15, 0.5) * 0.6);
} else {
  // ---- rock, by kind and age. Medium noise is projected straight down, so on cliffs it runs in
  // upright streaks (like rain stains); level bands show the stacked lava flows of a sea cliff. ----
  float tgRockN = tgSpread(0.45 * tgB.y + 0.35 * tgM.y + 0.2 * tgF.y);
  vec3 basalt = mix(${c(G.basaltFresh)}, ${c(G.basaltMatte)}, smoothstep(0.03, 0.16, tgWth));
  basalt = mix(basalt, ${c(G.basaltWeathered)}, smoothstep(0.16, 0.4, tgWth));
  basalt = mix(basalt, ${c(G.basaltRust)}, smoothstep(0.32, 0.55, tgWth) * smoothstep(0.3, 0.7, tgCB.b) * smoothstep(0.55, 0.8, tgM.z) * 0.75);
  basalt = mix(basalt, ${c(G.basaltOld)}, smoothstep(0.5, 0.9, tgWth) * (0.35 + 0.65 * tgSteep));
  vec3 stone = mix(${c(G.stone)}, ${c(G.stoneDark)}, tgRockN) * mix(1.0, 0.88, smoothstep(0.3, 0.9, tgWth));
  vec3 lime = mix(${c(G.limestone)}, ${c(G.limestoneOld)}, smoothstep(0.2, 0.8, tgWth));
  vec3 rock = basalt * tgIsBasalt + stone * tgIsStone + lime * tgIsLime;
  rock *= (0.82 + 0.36 * tgRockN) * (1.0 + (tgTex - 0.5) * 0.4);
  rock *= 1.0 + tgSteep * (tgWave(tgP.y * 0.36 + tgM.x * 1.2 + tgB.z) - 0.5) * 0.32;
  // Fresh basalt is glassy.
  gSpec = tgIsBasalt * (1.0 - smoothstep(0.02, 0.14, tgWth)) * 0.6;
  gShine = 36.0;
  // Salt crust in the splash zone of windward rock shores (wind comes from the east, +x).
  float tgSplash = smoothstep(0.2, 0.9, tgAbove) * (1.0 - smoothstep(2.2, 3.6, tgAbove)) * smoothstep(0.15, 0.6, tgN.x);
  rock = mix(rock, ${c(G.saltCrust)}, tgSplash * (0.2 + 0.2 * tgF.z));

  // ---- soil on flat, weathered ground: redder in the lee, dark humus under forest ----
  float tgSoilW = smoothstep(0.55, 0.8, tgWth) * tgFlat;
  vec3 soil = mix(${c(G.soilYoung)}, ${c(G.soilRed)}, tgDry * 0.85);
  soil = mix(soil, ${c(G.soilHumus)}, smoothstep(0.2, 0.7, tgCA.a)) * (0.86 + 0.28 * tgSpread(0.5 * tgM.x + 0.5 * tgF.x)) * (1.0 + (tgTex - 0.5) * 0.5);
  tgCol = mix(rock, soil, tgSoilW);
  float tgBare = 1.0 - tgSoilW;

  // ---- sand: black, grey, gold or coral white; wet and dark at the waterline ----
  vec3 sand = tgSandColor(tgSandKind) * (0.94 + 0.12 * tgSpread(0.6 * tgM.z + 0.4 * tgF.z)) * (1.0 + (tgTex - 0.5) * 0.1);
  // Wet in the swash (dark and glossy), damp a little higher up; storms throw the sea further up.
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

  // ---- living cover, as patches that grow outward ----
  // Lichen speckle (sage and pale yellow; orange where seabirds sit), and a dusky crust on old sand.
  float tgLichen = tgPatch(tgCA.r, tgSpread(0.6 * tgB.x + 0.4 * tgM.x), 0.12, tgF.x) * tgLand;
  vec3 lichenCol = mix(${c(G.lichenSage)}, ${c(G.lichenYellow)}, tgF.y * tgNear + tgM.y * (1.0 - tgNear));
  lichenCol = mix(lichenCol, ${c(G.lichenOrange)}, smoothstep(0.12, 0.45, tgCB.g) * smoothstep(0.5, 0.65, tgSpread(0.7 * tgF.w + 0.3 * tgM.w)));
  tgCol = mix(tgCol, lichenCol, tgLichen * 0.75 * tgBare);
  tgCol = mix(tgCol, ${c(G.crust)}, tgLichen * 0.12 * tgSandW);
  // Moss velvet: brighter when moist.
  float tgMoss = tgPatch(tgCA.g, tgSpread(0.6 * tgB.y + 0.4 * tgM.y), 0.13, tgF.z) * tgLand;
  vec3 mossCol = mix(${c(G.mossDry)}, ${c(G.mossWet)}, smoothstep(0.2, 0.85, tgCB.b)) * (0.9 + 0.2 * tgF.w);
  tgCol = mix(tgCol, mossCol, tgMoss * (1.0 - 0.8 * tgSandW));
  // Grass on gentle ground: green, golden in the lee in the dry season, with wind waves rolling over it.
  float tgGrass = tgPatch(tgCA.b, tgSpread(0.65 * tgB.z + 0.35 * tgM.z), 0.14, tgF.x) * smoothstep(0.5, 0.75, tgUp) * tgLand;
  vec3 grassCol = mix(${c(G.grass)}, ${c(G.grassLight)}, tgSpread(0.6 * tgM.w + 0.4 * tgB.w));
  vec3 goldCol = mix(${c(G.grassGold)}, ${c(G.grassGoldLight)}, tgM.w);
  grassCol = mix(grassCol, goldCol, clamp(uDry * (0.2 + 0.8 * tgDry), 0.0, 1.0));
  grassCol *= 1.0 + (0.04 + 0.08 * length(uWind.xy)) * (tgWave(dot(tgP.xz, tgWdir) * 0.028 - uTime * 0.125 + 0.4 * tgB.w) - 0.5);
  grassCol *= 0.86 + 0.28 * tgF.y;   // lighter and darker tufts up close
  grassCol *= 1.0 + (tgTex - 0.5) * 0.4;
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
  float tgGuano = tgPatch(tgCB.g, tgSpread(0.6 * tgM.z + 0.4 * tgB.x), 0.14, tgF.w) * tgLand;
  tgCol = mix(tgCol, ${c(G.guano)}, tgGuano * 0.75);
  // Burn scars.
  tgCol = mix(tgCol, ${c(G.char)} * (0.8 + 0.4 * tgM.y), tgPatch(tgCB.a, tgSpread(0.6 * tgM.y + 0.4 * tgB.x), 0.12, tgF.y) * 0.85);
  // Streams and marsh: glossy ribbons with ripples running downhill.
  float tgStream = smoothstep(0.32, 0.6, tgCC.a + (tgM.w - 0.5) * 0.35) * tgLand;
  if (tgStream > 0.0) {
    float tgRun = tgSpread(0.6 * tgFlow2.x + 0.4 * tgFlow2.y);
    vec3 water = mix(${c(G.streamWater)}, ${c(G.marshGreen)}, tgFlat * smoothstep(0.4, 0.8, tgCA.b + tgCA.g) * 0.6);
    tgCol = mix(tgCol, water * (0.85 + 0.3 * tgRun), tgStream);
    gSpec = mix(gSpec, 0.9, tgStream);
    gShine = mix(gShine, 90.0, tgStream);
  }

  // Grains and tiny pebbles up close; a few dry sand grains catch the sun (one hash gives both).
  if (tgDist < 14.0 && tgGrainFade > 0.0) {
    vec4 tgGrain = tgHash4(ivec2(floor((tgP.xz - uNoiseOrigin.xz) * 24.0)) + ivec2(uNoiseOrigin.xz * 24.0));
    tgCol *= 1.0 + (tgGrain.x - 0.5) * 0.16 * tgGrainFade;
    gSpark = step(0.985, tgGrain.y) * tgSandW * (1.0 - max(tgGrass, tgMoss)) * (1.0 - tgWetSea) * (1.0 - uWet) * tgGrainFade * 1.6;
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
