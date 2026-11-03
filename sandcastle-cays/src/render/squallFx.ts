/**
 * Squalls, seen from afar and from inside. Each one is:
 *  - a shower cloud: a flat, dark base about 400 m up and towering tops lit by
 *    the sun, drawn as a few dozen soft "puffs" (camera-facing sprites shaded
 *    like lumpy balls of cloud, with ragged edges from a noise texture);
 *  - a rain curtain from the cloud base down to the sea: a soft grey column,
 *    densest in the middle, streaky, with ragged edges. It is worked out per
 *    pixel as the amount of rain the view ray passes through (a smooth column
 *    of rain integrated exactly along the ray), so it looks the same from
 *    5 km, from its edge and from right inside it: no walls, no hard edges.
 *
 * All four squalls are ONE mesh (one draw call). Each frame the CPU decides the
 * drawing order (farthest squall first, and within it the farthest puffs
 * first, then its rain) by rewriting the small index buffer.
 *
 * Everything stays within SQUALL_FX.maxDistance of the camera: geometry further
 * away is pulled toward the camera along its own line of sight, which keeps
 * exactly the same look on screen. Squalls fade out with distance.
 *
 * The rain leaves the first `nearStart` metres around the camera to the game's
 * own fog, so the boat and things close by are never hazed by it.
 */
import * as THREE from 'three';
import { GLSL_ERF, rng, weatherNoise, type FxUniforms } from './weatherCommon';

export interface SquallInfo {
  id: number;
  x: number;
  z: number;
  /** Radius of the rain curtain at sea level (metres). */
  radius: number;
  /** 0..1; 0 = not formed yet or gone (nothing drawn). */
  strength: number;
}

export const SQUALL_FX = {
  maxSqualls: 4,
  /** Cloud puffs per squall. */
  puffs: 28,
  /** Nothing is drawn further than this from the camera (the sky dome is 1800 m away). */
  maxDistance: 1690,
  /** A squall fades out as its middle goes from this far away... */
  fadeFrom: 1350,
  /** ...to this far (metres). */
  fadeTo: 1690,
  /** The rain haze starts this far from the camera; nearer is the game's fog's job. */
  nearStart: 30,
  /** Cloud base height range (metres); each squall picks its own. */
  baseMin: 360,
  baseMax: 440,
  /** The cloud reaches out to about cloudK * radius + cloudAdd from its middle. */
  cloudK: 1.2,
  cloudAdd: 30,
  /** How far out the invisible box around each rain curtain reaches (x radius). */
  proxy: 1.6,
  /** Squalls weaker than this are not drawn. */
  minStrength: 0.002,
};

const SIDES = 28;
const RINGS = 4;
const CAP_RINGS = 3;
/** Bottom of the curtain's box, a little under the sea (metres). */
const BOTTOM = -6;
/** How much the towers lean downwind with height (metres per metre). */
const SHEAR = 0.22;
/** Aerial haze: how quickly distant cloud fades into the horizon colour (metres). */
const HAZE_L = 3400;

const f = (n: number) => n.toFixed(4);

const COLUMN_GLSL = /* glsl */ `
// The rain's axis is at the squall's middle c at sea level and leans upwind by
// lean (metres) at the cloud base, so the rain slants downwind as it falls.
// Where a ray (from o along unit d) enters a squall's rain box: a leaning
// cylinder of radius rp around that axis, from just under the sea up to the cloud base.
float columnEnter(vec3 o, vec3 d, vec2 c, vec2 lean, float H, float rp) {
  vec2 A = o.xz - c + lean * (o.y / H);
  vec2 B = d.xz + lean * (d.y / H);
  float bb = max(dot(B, B), 1e-9);
  float ab = dot(A, B);
  float disc = ab * ab - bb * (dot(A, A) - rp * rp);
  float tc = disc > 0.0 ? (-ab - sqrt(disc)) / bb : 0.0;
  float dy = abs(d.y) < 1e-5 ? 1e-5 : d.y;
  float ta = (${f(BOTTOM)} - o.y) / dy;
  float tb = (H - o.y) / dy;
  return max(0.0, max(tc, min(ta, tb)));
}`;

const VERT = /* glsl */ `
attribute float aSlot;
attribute float aKind;
attribute vec4 aPuff;
attribute float aSeed;
uniform vec4 uSq[4];
uniform vec4 uSq2[4];
uniform vec2 uWindDir;
uniform vec3 uSunDir;
uniform float uMaxDist, uNearStart;
varying vec3 vWorld;
varying vec4 vSq;
varying vec4 vSq2;
varying vec4 vA;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vBack;
varying float vKind;
${COLUMN_GLSL}

void main() {
  int s = int(aSlot + 0.5);
  vec4 sq = uSq[s];   // x, z, curtain radius, strength
  vec4 sq2 = uSq2[s]; // cloud base height, lean (how far upwind the cloud sits, m), fade, seed
  vSq = sq;
  vSq2 = sq2;
  vKind = aKind;
  vRight = vec3(0.0);
  vUp = vec3(0.0);
  vBack = vec3(0.0);
  vA = vec4(0.0);
  float H = sq2.x;
  vec3 world;
  if (aKind < 0.5) {
    // A cloud puff: a sprite facing the camera, kept upright (so it doesn't turn as the boat rolls).
    // A young (or dying) squall's cloud is smaller all over, not just thinner.
    float rc = (sq.z * ${f(SQUALL_FX.cloudK)} + ${f(SQUALL_FX.cloudAdd)}) * (0.6 + 0.4 * sq.w);
    float lift = aPuff.y * (0.45 + 0.55 * sq.w);
    vec2 top = sq.xy - uWindDir * sq2.y;
    vec3 c = vec3(top.x + aPuff.x * rc + uWindDir.x * lift * ${f(SHEAR)}, H + lift, top.y + aPuff.z * rc + uWindDir.y * lift * ${f(SHEAR)});
    float size = aPuff.w * rc;
    vec3 toC = c - cameraPosition;
    float dist = length(toC);
    vec3 d = toC / dist;
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 r1 = cross(d, vec3(0.0, 1.0, 0.0));
    vec3 right = normalize(r1 + cross(d, camUp) * (1.0 - smoothstep(0.1, 0.4, length(r1))));
    vec3 up = cross(right, d);
    vec3 corner = c + (right * position.x + up * position.y) * size;
    vWorld = corner;
    // Too far? Shrink the whole sprite toward the camera: same look on screen, nearer.
    float k = min(1.0, uMaxDist / (dist + size * 1.42));
    world = cameraPosition + (corner - cameraPosition) * k;
    vRight = right;
    vUp = up;
    vBack = -d;
    vec2 sunH = normalize(uSunDir.xz + vec2(1e-4, 0.0));
    vA = vec4(position.xy, aSeed, dot(vec2(aPuff.x, aPuff.z), sunH));
  } else {
    // The rain curtain's box. Only its far side is drawn (one fragment per pixel),
    // pulled toward the camera to where the view ray enters the box (but at
    // least nearStart away, so whatever is near stays in front of it).
    float rp = sq.z * ${f(SQUALL_FX.proxy)};
    float y = mix(${f(BOTTOM)}, H, position.y);
    vec2 lean = uWindDir * sq2.y;
    vec2 axis = sq.xy - lean * (y / H);
    vec3 p = vec3(axis.x + position.x * rp, y, axis.y + position.z * rp);
    // How deep the camera is in this rain (0..1): from inside, the rain closes in all around.
    vec2 qc = cameraPosition.xz - sq.xy + lean * (clamp(cameraPosition.y, 0.0, H) / H);
    float rc2 = dot(qc, qc) / (sq.z * sq.z);
    float dog = 1.6 * exp(-rc2 / 0.3844) - 0.6 * exp(-rc2 / 0.1296);
    vA = vec4(clamp(dog, 0.0, 1.0) * smoothstep(0.1, 0.5, sq.w) * step(cameraPosition.y, H), 0.0, 0.0, 0.0);
    vec3 toP = p - cameraPosition;
    float dist = length(toP);
    vec3 d = toP / dist;
    float tIn = columnEnter(cameraPosition, d, sq.xy, lean, H, rp);
    float pull = min(dist, min(max(tIn, uNearStart), uMaxDist));
    world = cameraPosition + d * pull;
    vWorld = world;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D tNoise;
uniform vec3 uSunDir, uSunColor, uHorizon, uZenith;
uniform vec2 uWindDir;
uniform float uDay, uNight, uTime, uNearStart;
varying vec3 vWorld;
varying vec4 vSq;
varying vec4 vSq2;
varying vec4 vA;
varying vec3 vRight;
varying vec3 vUp;
varying vec3 vBack;
varying float vKind;
${GLSL_ERF}

// How much of a soft round column of rain (strength falling off as exp(-r^2/s^2)
// from its middle m) a ray passes through between t0 and t1. The ray is A + t B in
// the squall's leaning frame (horizontal plane), t in metres along the real ray.
float lobe(vec2 A, vec2 B, float bb, float t0, float t1, vec2 m, float s) {
  vec2 a = A - m;
  float ab = dot(a, B);
  float tc = -ab / bb;
  float b2 = max(dot(a, a) - ab * ab / bb, 0.0);
  float k = sqrt(bb) / s;
  if (k * (t1 - t0) < 1e-3) {
    float dm = 0.5 * (t0 + t1) - tc;
    return exp(-(b2 + bb * dm * dm) / (s * s)) * (t1 - t0);
  }
  return exp(-b2 / (s * s)) * 0.8862269 / k * (erfA(k * (t1 - tc)) - erfA(k * (t0 - tc)));
}

vec4 curtain() {
  vec3 o = cameraPosition;
  vec3 rd = normalize(vWorld - o);
  float H = vSq2.x;
  float R = vSq.z;
  float str = vSq.w;
  vec2 lean = uWindDir * vSq2.y;
  vec2 A = o.xz - vSq.xy + lean * (o.y / H);
  vec2 B = rd.xz + lean * (rd.y / H);
  float bb = max(dot(B, B), 1e-9);
  // Rain fills the air from the sea up to the cloud base.
  float dy = abs(rd.y) < 1e-5 ? 1e-5 : rd.y;
  float ta = -o.y / dy;
  float tb = (H - o.y) / dy;
  float t0 = max(min(ta, tb), uNearStart);
  float t1 = min(max(ta, tb), 6000.0);
  if (t1 <= t0) return vec4(0.0);
  // A flat-topped column: broad soft lobe minus a narrow one (still never negative).
  float tau = 1.6 * lobe(A, B, bb, t0, t1, vec2(0.0), 0.62 * R) - 0.6 * lobe(A, B, bb, t0, t1, vec2(0.0), 0.36 * R);
#ifndef PHONE
  // A second, smaller shaft to one side, so no two squalls look alike.
  float ang = vSq2.w * 6.2831853;
  tau += 0.5 * lobe(A, B, bb, t0, t1, vec2(cos(ang), sin(ang)) * 0.5 * R, 0.3 * R);
#endif
  tau = max(tau, 0.0);

  // The point on the ray nearest the column's middle stands in for the whole ray.
  float tm = clamp(-dot(A, B) / bb, t0, t1);
  vec2 a = A + tm * B;
  float y = o.y + rd.y * tm;
  vec2 Bn = B * inversesqrt(bb);
  float u = (Bn.x * a.y - Bn.y * a.x) / R; // across the shaft, as you see it
  float v = clamp(y / H, 0.0, 1.0);
  float seed = vSq2.w;
  // Broad soft streaks of heavier rain and a finer grain, falling slowly; ragged, uneven edges.
#ifdef PHONE
  float wob = 0.0;
  float fine = 0.5;
#else
  float wob = texture2D(tNoise, vec2(v * 0.35 + seed, u * 0.05)).g - 0.5;
  float fine = texture2D(tNoise, vec2(u * 0.4 + wob * 0.12 + seed * 1.3, v * 1.6 + uTime * 0.007)).b;
#endif
  float broad = texture2D(tNoise, vec2(u * 0.1 + wob * 0.06 + seed * 3.1, v * 0.7 + uTime * 0.003 + seed)).b;
  float edgeN = texture2D(tNoise, vec2(v * 0.8 + seed * 1.7, u * 0.25 + seed * 0.3)).a;
  float edge = smoothstep(0.25, 0.95, abs(u));
  tau *= mix(0.55, 1.45, broad * 0.75 + fine * 0.25) * mix(1.0, 0.25 + 1.5 * edgeN, edge);
  // A young squall's rain hangs from the cloud before it reaches the sea (from strength 0.3 it does).
  float reach = H * 0.55 * (1.0 - smoothstep(0.05, 0.3, str)) - 80.0;
  tau *= smoothstep(reach - 30.0, reach + 60.0, y);
  float rho = 0.0084 * sqrt(180.0 / R) * pow(str, 1.2) * (1.0 + 1.4 * vA.x);
  float alpha = (1.0 - exp(-tau * rho)) * vSq2.z;
  if (alpha < 0.002) return vec4(0.0);

  // Colour: grey air full of rain, in the cloud's shadow; lighter on the sunny
  // side, silvery looking toward the sun, warm when the sun is low.
  float lum = dot(uHorizon, vec3(0.2126, 0.7152, 0.0722));
  vec3 grey = mix(mix(uHorizon, uZenith, 0.3), vec3(lum), 0.6);
  // Darkest just under the cloud, a little lighter low down where light gets in from the sides.
  vec3 col = grey * (0.47 - 0.15 * str) * mix(1.05, 0.88, v);
  vec2 sunH = normalize(uSunDir.xz + vec2(1e-4, 0.0));
  float sunSide = dot(normalize(a + vec2(1e-3, 0.0)), sunH) * smoothstep(0.2, 0.9, length(a) / R);
  float lowSun = 1.0 - smoothstep(0.15, 0.6, uSunDir.y);
  col *= 1.0 + 0.25 * sunSide * uDay;
  // (Only a low sun shines in under the cloud and through the rain.)
  col += uSunColor * (max(sunSide, 0.0) * 0.12 * lowSun + pow(max(dot(rd, uSunDir), 0.0), 5.0) * 0.3 * mix(0.1, 1.0, lowSun)) * uDay;
  // Distance haze toward the horizon colour.
  float elev = clamp((y - o.y) / max(tm, 1.0), 0.0, 1.0);
  float haze = (1.0 - exp(-tm / ${f(HAZE_L)})) * (1.0 - 0.45 * smoothstep(0.05, 0.6, elev));
  col = mix(col, uHorizon, haze);
  return vec4(col, alpha);
}

vec4 puff() {
  vec2 uv = vA.xy;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) return vec4(0.0);
  vec2 so = vec2(vA.z * 7.13, vA.z * 3.71);
  float n1 = texture2D(tNoise, uv * 0.3 + so + vec2(uTime * 0.0012, 0.0)).r;
  float n2 = texture2D(tNoise, uv * 0.7 + so.yx - vec2(0.0, uTime * 0.0017)).g;
  float n = n1 * 0.65 + n2 * 0.35;
  // Billowy, ragged edges, always fading to nothing at the sprite's rim.
  float rr = sqrt(r2);
  float dens = (1.0 - rr) * 1.6 + (n - 0.5) * 1.2 * sqrt(1.0 - rr);
  float a = smoothstep(0.05, 0.55, dens) * smoothstep(1.0, 0.8, rr);
  // The flat cloud base.
  float H = vSq2.x;
  a *= smoothstep(H - 22.0, H + 30.0, vWorld.y + (n2 - 0.5) * 44.0);
  a *= smoothstep(0.0, 0.3, vSq.w) * vSq2.z;
  if (a < 0.004) return vec4(0.0);

  // Lit as one big mass (light scatters all through a cloud): its top faces up, its base down, its
  // flanks sideways; each puff adds a gentle lump and the noise its small bumps.
  float above = vWorld.y - H;
  float h01 = clamp(above / 520.0, 0.0, 1.0);
  float str = vSq.w;
  vec2 top = vSq.xy - uWindDir * vSq2.y;
  vec3 massN = normalize(vWorld - vec3(top.x, H + 170.0 * (0.45 + 0.55 * str), top.y));
  vec3 N = normalize(massN + vBack * 0.25 + (vRight * uv.x + vUp * uv.y) * 0.35 + (vRight * (n1 - 0.5) + vUp * (n2 - 0.5)) * 0.7);
  float diff = clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  // Lower down the cloud sits in its own shadow; so does the side away from the sun.
  float lit = diff * mix(0.12, 1.0, smoothstep(0.02, 0.7, h01)) * (0.85 + 0.25 * clamp(vA.w, -0.6, 0.6));
  vec3 sun = uSunColor * lit * (uDay + 0.08 * uNight) * 1.6;
  // Shadowed cloud is lit by the sky: cooler, from the high sky more than the (sometimes golden) horizon.
  vec3 skyC = mix(uHorizon, uZenith, 0.55 - 0.15 * N.y);
  skyC = mix(skyC, vec3(dot(skyC, vec3(0.2126, 0.7152, 0.0722))), 0.35);
  vec3 sky = skyC * (0.32 + 0.14 * N.y) * (0.6 + 0.5 * h01);
  vec3 col = (sun + sky) * mix(1.0, 0.85, str);
  // The flat base and the underside: dark grey, darker in a strong squall.
  float low = 1.0 - smoothstep(0.0, 200.0, above);
  col *= 1.0 - low * (0.35 + 0.3 * str);
  // Thin edges glow when the sun is behind the cloud.
  float behind = pow(max(dot(-vBack, uSunDir), 0.0), 8.0);
  col += uSunColor * behind * (1.0 - smoothstep(0.1, 0.6, dens)) * 1.4 * uDay;
  // Seen through a kilometre or more of sea air.
  vec3 toF = vWorld - cameraPosition;
  float dist = length(toF);
  float elev = clamp(toF.y / max(dist, 1.0), 0.0, 1.0);
  float haze = (1.0 - exp(-dist / ${f(HAZE_L)})) * (1.0 - 0.5 * smoothstep(0.05, 0.6, elev));
  col = mix(col, uHorizon, haze);
  return vec4(col, a);
}

void main() {
  vec4 c = vKind < 0.5 ? puff() : curtain();
  if (c.a < 0.003) discard;
  gl_FragColor = c;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Puff {
  ox: number;
  oy: number;
  oz: number;
  size: number;
  seed: number;
}

/** One squall's cloud: a broad, flat-based body of big puffs with a main tower and a smaller one rising from it. */
function layoutPuffs(id: number, radius: number): Puff[] {
  const r = rng(id * 7919 + 13);
  const out: Puff[] = [];
  const rc = radius * SQUALL_FX.cloudK + SQUALL_FX.cloudAdd;
  const body = 14;
  for (let i = 0; i < body; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.72 * Math.sqrt((i + r()) / body);
    const size = 0.32 + 0.13 * r();
    // Low enough that every body puff reaches below the base and is cut flat there.
    out.push({ ox: Math.cos(a) * d, oz: Math.sin(a) * d, oy: size * rc * (0.2 + 0.35 * r()), size, seed: r() });
  }
  const towers = [
    { n: 8, top: 400 + 140 * r(), s0: 0.44, s1: 0.3 },
    { n: SQUALL_FX.puffs - body - 8, top: 260 + 120 * r(), s0: 0.38, s1: 0.27 },
  ];
  const a0 = r() * Math.PI * 2;
  towers.forEach((t, ti) => {
    const a = a0 + ti * (2.2 + r());
    const d = ti === 0 ? 0.08 + 0.15 * r() : 0.3 + 0.2 * r();
    const bx = Math.cos(a) * d;
    const bz = Math.sin(a) * d;
    for (let i = 0; i < t.n; i++) {
      const k = t.n > 1 ? i / (t.n - 1) : 1;
      const ja = r() * Math.PI * 2;
      // The crown spreads out wider than the stem (cauliflower tops).
      const jr = (0.06 + 0.12 * r()) * (k > 0.6 ? 1.8 : 1);
      out.push({ ox: bx + Math.cos(ja) * jr, oz: bz + Math.sin(ja) * jr, oy: 150 + k * (t.top - 150), size: t.s0 + (t.s1 - t.s0) * k + 0.05 * r(), seed: r() });
    }
  });
  return out;
}

/** A repeatable 0..1 number for squall `id`, draw `j`. */
function hash(id: number, j: number): number {
  const s = Math.sin(id * 91.37 + j * 17.13) * 43758.5453;
  return s - Math.floor(s);
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The unit curtain box (radius 1, y 0..1, side and both caps), wound to face outward. */
function unitColumn(): { pos: number[]; idx: number[] } {
  const pos: number[] = [];
  const idx: number[] = [];
  const add = (x: number, y: number, z: number) => {
    pos.push(x, y, z);
    return pos.length / 3 - 1;
  };
  const tri = (a: number, b: number, c: number, out: [number, number, number]) => {
    // Face outward (counter-clockwise seen from outside), whatever order we built it in.
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const e1 = [pos[b * 3] - ax, pos[b * 3 + 1] - ay, pos[b * 3 + 2] - az];
    const e2 = [pos[c * 3] - ax, pos[c * 3 + 1] - ay, pos[c * 3 + 2] - az];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) idx.push(a, c, b);
    else idx.push(a, b, c);
  };
  // Side.
  const side: number[][] = [];
  for (let j = 0; j <= RINGS; j++) {
    const row: number[] = [];
    for (let i = 0; i < SIDES; i++) {
      const t = (i / SIDES) * Math.PI * 2;
      row.push(add(Math.cos(t), j / RINGS, Math.sin(t)));
    }
    side.push(row);
  }
  for (let j = 0; j < RINGS; j++) {
    for (let i = 0; i < SIDES; i++) {
      const i2 = (i + 1) % SIDES;
      const t = ((i + 0.5) / SIDES) * Math.PI * 2;
      const o: [number, number, number] = [Math.cos(t), 0, Math.sin(t)];
      tri(side[j][i], side[j][i2], side[j + 1][i2], o);
      tri(side[j][i], side[j + 1][i2], side[j + 1][i], o);
    }
  }
  // Caps: concentric rings down to a middle point (small triangles, so pulling vertices toward the camera stays smooth).
  for (const [y, row, dir] of [
    [1, side[RINGS], 1],
    [0, side[0], -1],
  ] as [number, number[], number][]) {
    const o: [number, number, number] = [0, dir, 0];
    let outer = row;
    for (let k = CAP_RINGS - 1; k >= 1; k--) {
      const rr = k / CAP_RINGS;
      const inner: number[] = [];
      for (let i = 0; i < SIDES; i++) {
        const t = (i / SIDES) * Math.PI * 2;
        inner.push(add(Math.cos(t) * rr, y, Math.sin(t) * rr));
      }
      for (let i = 0; i < SIDES; i++) {
        const i2 = (i + 1) % SIDES;
        tri(outer[i], outer[i2], inner[i2], o);
        tri(outer[i], inner[i2], inner[i], o);
      }
      outer = inner;
    }
    const mid = add(0, y, 0);
    for (let i = 0; i < SIDES; i++) tri(outer[i], outer[(i + 1) % SIDES], mid, o);
  }
  return { pos, idx };
}

const COLUMN = unitColumn();
const PUFF_VERTS = SQUALL_FX.puffs * 4;
const SLOT_VERTS = PUFF_VERTS + COLUMN.pos.length / 3;
const SLOT_INDICES = SQUALL_FX.puffs * 6 + COLUMN.idx.length;

interface Slot {
  id: number | null;
  puffs: Puff[];
  /** Drawn this frame. */
  on: boolean;
  dist: number;
  /** Cloud base height and lean (metres), for the CPU copies of the shader's maths. */
  base: number;
  lean: number;
  order: number[];
}

export class SquallFx {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private slots: Slot[] = [];
  private uSq = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  private uSq2 = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
  private windDir = new THREE.Vector2(-1, 0);
  private windSpeed = 8;
  private index: Uint16Array;
  private puffAttr: THREE.BufferAttribute;
  private seedAttr: THREE.BufferAttribute;
  private dist = new Float32Array(SQUALL_FX.puffs);

  constructor(shared: FxUniforms, phone: boolean) {
    const nv = SLOT_VERTS * SQUALL_FX.maxSqualls;
    const position = new Float32Array(nv * 3);
    const slot = new Float32Array(nv);
    const kind = new Float32Array(nv);
    const puff = new Float32Array(nv * 4);
    const seed = new Float32Array(nv);
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let s = 0; s < SQUALL_FX.maxSqualls; s++) {
      const v0 = s * SLOT_VERTS;
      for (let p = 0; p < SQUALL_FX.puffs; p++) {
        for (let c = 0; c < 4; c++) {
          const v = v0 + p * 4 + c;
          position[v * 3] = corners[c * 2];
          position[v * 3 + 1] = corners[c * 2 + 1];
          slot[v] = s;
          kind[v] = 0;
        }
      }
      for (let k = 0; k < COLUMN.pos.length / 3; k++) {
        const v = v0 + PUFF_VERTS + k;
        position.set(COLUMN.pos.slice(k * 3, k * 3 + 3), v * 3);
        slot[v] = s;
        kind[v] = 1;
      }
      this.slots.push({ id: null, puffs: [], on: false, dist: 0, base: 400, lean: 0, order: [] });
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
    this.geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    this.puffAttr = new THREE.BufferAttribute(puff, 4);
    this.seedAttr = new THREE.BufferAttribute(seed, 1);
    this.geo.setAttribute('aPuff', this.puffAttr);
    this.geo.setAttribute('aSeed', this.seedAttr);
    this.index = new Uint16Array(SLOT_INDICES * SQUALL_FX.maxSqualls);
    this.geo.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...shared,
        tNoise: { value: weatherNoise() },
        uSq: { value: this.uSq },
        uSq2: { value: this.uSq2 },
        uWindDir: { value: this.windDir },
        uMaxDist: { value: SQUALL_FX.maxDistance },
        uNearStart: { value: SQUALL_FX.nearStart },
      },
      defines: phone ? { PHONE: '' } : {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      // Only far sides: each pixel is shaded once per squall, inside or out.
      side: THREE.BackSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'squalls';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
  }

  /** Squalls in, camera position, seconds since the last frame, the wind (m/s, toward). */
  update(squalls: readonly SquallInfo[], cam: THREE.Vector3, dt: number, windX: number, windZ: number): void {
    // The lean of the rain and the towers follows the wind slowly (not every gust).
    const ws = Math.hypot(windX, windZ);
    const k = 1 - Math.exp(-Math.max(0, dt) / 20);
    if (ws > 0.5) {
      this.windDir.x += (windX / ws - this.windDir.x) * k;
      this.windDir.y += (windZ / ws - this.windDir.y) * k;
      const l = this.windDir.length();
      if (l > 1e-3) this.windDir.multiplyScalar(1 / l);
      else this.windDir.set(windX / ws, windZ / ws);
    }
    this.windSpeed += (ws - this.windSpeed) * k;

    // Keep each squall in the same slot for its whole life (its cloud keeps its shape).
    const live = squalls.filter((q) => q.strength > SQUALL_FX.minStrength).slice(0, SQUALL_FX.maxSqualls);
    for (const s of this.slots) if (s.id !== null && !live.some((q) => q.id === s.id)) s.id = null;
    for (const q of live) {
      if (this.slots.some((s) => s.id === q.id)) continue;
      const i = this.slots.findIndex((s) => s.id === null);
      if (i >= 0) this.claim(i, q.id, q.radius);
    }

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const q = s.id === null ? undefined : live.find((x) => x.id === s.id);
      s.on = false;
      if (!q) {
        this.uSq[i].set(0, 0, 100, 0);
        continue;
      }
      s.dist = Math.hypot(q.x - cam.x, q.z - cam.z);
      const fade = 1 - smoothstep(SQUALL_FX.fadeFrom, SQUALL_FX.fadeTo, s.dist);
      s.base = SQUALL_FX.baseMin + (SQUALL_FX.baseMax - SQUALL_FX.baseMin) * hash(q.id, 1);
      s.lean = (0.15 * q.radius + 25) * Math.min(1.4, Math.max(0.6, this.windSpeed / 9));
      this.uSq[i].set(q.x, q.z, Math.max(20, q.radius), Math.min(1, q.strength));
      this.uSq2[i].set(s.base, s.lean, fade, hash(q.id, 2));
      s.on = fade > 0.001;
      if (s.on) this.sortPuffs(i, cam);
    }
    this.writeIndex();
  }

  private claim(i: number, id: number, radius: number): void {
    const s = this.slots[i];
    s.id = id;
    s.puffs = layoutPuffs(id, radius);
    const v0 = i * SLOT_VERTS;
    for (let p = 0; p < SQUALL_FX.puffs; p++) {
      const pf = s.puffs[p];
      for (let c = 0; c < 4; c++) {
        this.puffAttr.setXYZW(v0 + p * 4 + c, pf.ox, pf.oy, pf.oz, pf.size);
        this.seedAttr.setX(v0 + p * 4 + c, pf.seed);
      }
    }
    this.puffAttr.needsUpdate = true;
    this.seedAttr.needsUpdate = true;
  }

  /** Where puff p of slot i is this frame (the same sums as the shader). */
  private puffCentre(i: number, p: number, out: THREE.Vector3): { size: number } {
    const q = this.uSq[i];
    const pf = this.slots[i].puffs[p];
    const rc = (q.z * SQUALL_FX.cloudK + SQUALL_FX.cloudAdd) * (0.6 + 0.4 * q.w);
    const lift = pf.oy * (0.45 + 0.55 * q.w);
    const lean = this.slots[i].lean;
    out.set(
      q.x - this.windDir.x * lean + pf.ox * rc + this.windDir.x * lift * SHEAR,
      this.slots[i].base + lift,
      q.y - this.windDir.y * lean + pf.oz * rc + this.windDir.y * lift * SHEAR,
    );
    return { size: pf.size * rc };
  }

  private sortPuffs(i: number, cam: THREE.Vector3): void {
    const s = this.slots[i];
    const c = tmpA;
    for (let p = 0; p < SQUALL_FX.puffs; p++) {
      this.puffCentre(i, p, c);
      this.dist[p] = c.distanceToSquared(cam);
    }
    if (s.order.length !== SQUALL_FX.puffs) s.order = Array.from({ length: SQUALL_FX.puffs }, (_, p) => p);
    s.order.sort((a, b) => this.dist[b] - this.dist[a]);
  }

  /** Farthest squall first; within each, its puffs far to near, then its rain over them. */
  private writeIndex(): void {
    const order = this.slots
      .map((s, i) => ({ s, i }))
      .filter((e) => e.s.on)
      .sort((a, b) => b.s.dist - a.s.dist);
    let n = 0;
    const idx = this.index;
    let changed = false;
    const put = (v: number) => {
      if (idx[n] !== v) {
        idx[n] = v;
        changed = true;
      }
      n++;
    };
    for (const { s, i } of order) {
      const v0 = i * SLOT_VERTS;
      for (const p of s.order) {
        const b = v0 + p * 4;
        // Wound clockwise: the material draws far sides only (see the curtain).
        put(b);
        put(b + 2);
        put(b + 1);
        put(b);
        put(b + 3);
        put(b + 2);
      }
      const c0 = v0 + PUFF_VERTS;
      for (let k = 0; k < COLUMN.idx.length; k++) put(c0 + COLUMN.idx[k]);
    }
    if (changed || this.geo.drawRange.count !== n) {
      const attr = this.geo.getIndex()!;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n);
      attr.needsUpdate = true;
    }
    this.geo.setDrawRange(0, n);
    this.mesh.visible = n > 0;
  }

  /** How many squalls are drawn this frame. */
  get drawn(): number {
    return this.slots.filter((s) => s.on).length;
  }

  /**
   * Every vertex as the shader places it this frame (a CPU copy of the vertex
   * shader, for the checks): returns the farthest distance from `cam`.
   */
  farthestDrawn(cam: THREE.Vector3): number {
    let far = 0;
    const p = tmpA;
    const right = tmpB;
    const up = tmpC;
    const Y = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.on) continue;
      const q = this.uSq[i];
      for (let k = 0; k < SQUALL_FX.puffs; k++) {
        const { size } = this.puffCentre(i, k, p);
        const dist = p.distanceTo(cam);
        const d = p.clone().sub(cam).normalize();
        right.crossVectors(d, Y);
        if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
        right.normalize();
        up.crossVectors(right, d);
        const kk = Math.min(1, SQUALL_FX.maxDistance / (dist + size * 1.42));
        for (const [cx, cy] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ]) {
          const corner = p.clone().addScaledVector(right, cx * size).addScaledVector(up, cy * size);
          far = Math.max(far, corner.sub(cam).length() * kk);
        }
      }
      const rp = q.z * SQUALL_FX.proxy;
      const H = s.base;
      for (let v = 0; v < COLUMN.pos.length; v += 3) {
        const y = BOTTOM + (H - BOTTOM) * COLUMN.pos[v + 1];
        const ax = q.x - this.windDir.x * s.lean * (y / H);
        const az = q.y - this.windDir.y * s.lean * (y / H);
        const dist = Math.hypot(ax + COLUMN.pos[v] * rp - cam.x, y - cam.y, az + COLUMN.pos[v + 2] * rp - cam.z);
        // The pull toward the camera only ever shortens this; the cap is what matters here.
        far = Math.max(far, Math.min(dist, SQUALL_FX.maxDistance));
      }
    }
    return far;
  }

  /** Triangles drawn this frame. */
  get triangles(): number {
    return this.mesh.visible ? this.geo.drawRange.count / 3 : 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
