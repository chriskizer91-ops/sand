/**
 * The sky clock and the light (WP-G).
 *
 * The sky keeps its own calm 16-minute day (dawn 1.5 min, day 9, dusk 1.5, night 4) that runs
 * in real time whatever the year speed, so the light never strobes (DECISIONS 5). This file owns:
 * - the clock: day phase, day count, the wet/dry season (alternating each day), the moon phase
 *   (full every 4th night);
 * - the light: the sun (the moon at night) as one DirectionalLight with a shadow box that follows
 *   the camera, and the hemisphere fill;
 * - the colours every material reads (the shared uniforms) and the scene fog;
 * - the sky look (zenith, horizon, sun and moon) that sky.ts paints.
 *
 * Colours come from keys (dawn, day, golden, dusk, night, and a storm key) taken from the
 * look-and-sound notes (§8) and blended smoothly through the day, so nothing ever jumps.
 *
 * Uniform convention: uSunColor, uSkyColor and uGroundColor are light colours scaled so that
 * midday equals the key colour (#fff2d6, #cfe9ff, #e8d4a8); they dim and tint through the day.
 * uFogColor is the haze colour at the horizon (the sky and the far sea meet in it).
 */
import * as THREE from 'three';
import { DAY_PARTS, DAY_SECONDS, SEASON_DAYS, dayPart, type Season } from '../config';
import { smoothstep } from '../engine/noise';
import type { DayState, FrameCtx, PageSystem, SystemDeps, WorldUniforms } from './shared';
import { weatherOf } from './weather';

export interface DaylightSystem extends PageSystem {
  readonly day: DayState;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Jump the clock (load, tests, "always day" setting). `phase` may include whole days. */
  setPhase(phase: number, dayCount?: number): void;
  /** 'cycle' (default), 'day' (always midday), 'golden' (always golden hour). */
  setMode(mode: 'cycle' | 'day' | 'golden'): void;
}

// ---------- landmarks of the day (phase 0 = start of dawn) ----------

export const DAY_START = DAY_PARTS.dawn;
export const DUSK_START = DAY_PARTS.dawn + DAY_PARTS.day;
export const NIGHT_START = DUSK_START + DAY_PARTS.dusk;
/** The sun rises halfway through dawn and sets halfway through dusk. */
export const SUNRISE = DAY_PARTS.dawn * 0.45;
export const SUNSET = DUSK_START + DAY_PARTS.dusk * 0.55;
/** Midday: the light held by the "always day" setting. */
export const NOON = (SUNRISE + SUNSET) / 2;
/** Golden hour, about 20 degrees of sun: the light held by the "always golden" setting. */
export const GOLDEN = SUNSET - 0.082;
/** A new sea starts mid-morning. */
export const START_PHASE = DAY_START + DAY_PARTS.day * 0.2;
/** The sky day a brand-new sea starts on: day 1, the first dry day (see createDaylight). */
export const NEW_SEA_DAY = 1;
/** The moon crosses the night sky from just after sunset to just after sunrise. */
const MOONRISE = SUNSET + 0.01;
const MOONSET = 1 + SUNRISE + 0.01;
/** The sun's path leans this far toward the south (+z); the moon's a little more. */
const SUN_TILT = 0.35;
const MOON_TILT = 0.55;
/** Lowest angle the light comes from (sin of ~7 degrees), so slopes are never lit from below. */
const MIN_LIGHT_Y = 0.12;

const frac = (x: number) => x - Math.floor(x);

/** Wet on even days, dry on odd days (day 0 is wet). */
export function seasonOf(dayCount: number): Season {
  return ((dayCount % SEASON_DAYS) + SEASON_DAYS) % SEASON_DAYS === 0 ? 'wet' : 'dry';
}

/** The dry-season mood (0 wet .. 1 dry): it changes over the first 2 minutes of each day. */
export function dryMood(totalDays: number): number {
  const d = Math.floor(totalDays);
  const now = seasonOf(d) === 'dry' ? 1 : 0;
  const before = seasonOf(d - 1) === 'dry' ? 1 : 0;
  return before + (now - before) * smoothstep(0, 2 / 16, totalDays - d);
}

/** Moon phase (0 new .. 0.5 full .. 1): a 4-day cycle with the full moon on every 4th night. */
export function moonPhase(totalDays: number): number {
  return frac((totalDays - 1.875) / 4);
}

/** Point along a tilted arc: east horizon at a = 0, highest at a = pi/2, west horizon at a = pi. */
function arc(a: number, tilt: number, out: THREE.Vector3): THREE.Vector3 {
  const s = Math.sin(a);
  return out.set(Math.cos(a), s * Math.cos(tilt), s * Math.sin(tilt));
}

/** Direction to the sun (unit; below the horizon at night). Rises in the east, sets in the west. */
export function sunDirection(phase: number, out: THREE.Vector3): THREE.Vector3 {
  const p = frac(phase);
  if (p >= SUNRISE && p <= SUNSET) return arc((Math.PI * (p - SUNRISE)) / (SUNSET - SUNRISE), SUN_TILT, out);
  const night = 1 - (SUNSET - SUNRISE);
  const q = p > SUNSET ? p - SUNSET : p + 1 - SUNSET;
  return arc(Math.PI + (Math.PI * q) / night, SUN_TILT, out);
}

/** Direction to the moon (unit): up from just after sunset to just after sunrise. */
export function moonDirection(phase: number, out: THREE.Vector3): THREE.Vector3 {
  let p = frac(phase);
  if (p < MOONRISE - 0.5) p += 1;
  const up = MOONSET - MOONRISE;
  if (p >= MOONRISE && p <= MOONSET) return arc((Math.PI * (p - MOONRISE)) / up, MOON_TILT, out);
  const q = p > MOONSET ? p - MOONSET : p + 1 - MOONSET;
  return arc(Math.PI + (Math.PI * q) / (1 - up), MOON_TILT, out);
}

/** The light passes from the sun to the moon just after sunset, and back around sunrise. */
const DUSK_HANDOVER: readonly [number, number] = [SUNSET + 0.007, SUNSET + 0.047];
const DAWN_HANDOVER: readonly [number, number] = [SUNRISE - 0.017, SUNRISE + 0.028];

/**
 * Which body lights the world: 0 the sun .. 1 the moon. The handovers happen while the
 * light is at its dimmest, so the swing of the light direction is never noticed.
 */
export function moonShare(phase: number): number {
  const p = frac(phase);
  const [e0, e1] = DUSK_HANDOVER;
  const [m0, m1] = DAWN_HANDOVER;
  if (p >= e0 && p <= e1) return smoothstep(e0, e1, p);
  if (p >= m0 && p <= m1) return 1 - smoothstep(m0, m1, p);
  return p > m1 && p < e0 ? 0 : 1;
}

// ---------- the light keys ----------

/** Everything the light needs at one moment (colours are linear, as shaders use them). */
export interface DayLook {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  /** Sun colour by day, moon colour by night. */
  sun: THREE.Color;
  sunI: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiI: number;
  /** Warm glow around the sun near the horizon. */
  glow: THREE.Color;
  glowI: number;
  night: number;
  stars: number;
}

/** A key as written in the table: colours as sRGB hex numbers, the rest as plain numbers. */
type KeyHex = Record<keyof DayLook, number>;

function key(k: KeyHex): DayLook {
  return {
    zenith: new THREE.Color(k.zenith),
    horizon: new THREE.Color(k.horizon),
    fog: new THREE.Color(k.fog),
    sun: new THREE.Color(k.sun),
    sunI: k.sunI,
    hemiSky: new THREE.Color(k.hemiSky),
    hemiGround: new THREE.Color(k.hemiGround),
    hemiI: k.hemiI,
    glow: new THREE.Color(k.glow),
    glowI: k.glowI,
    night: k.night,
    stars: k.stars,
  };
}

const COLOR_KEYS = ['zenith', 'horizon', 'fog', 'sun', 'hemiSky', 'hemiGround', 'glow'] as const;
const NUMBER_KEYS = ['sunI', 'hemiI', 'glowI', 'night', 'stars'] as const;

// sRGB colours from the look-and-sound table (§8). Night stays readable: a bright blue fill.
const DAWN = key({ zenith: 0x6f8fc8, horizon: 0xf6c7a1, fog: 0xf0d2bc, sun: 0xffd3a0, sunI: 1.4, hemiSky: 0xbcd0f0, hemiGround: 0xc8a88a, hemiI: 1.15, glow: 0xffb98a, glowI: 0.55, night: 0.45, stars: 0.12 });
const DAY = key({ zenith: 0x3d9be9, horizon: 0xd9f1ff, fog: 0xd9f1ff, sun: 0xfff2d6, sunI: 2.9, hemiSky: 0xcfe9ff, hemiGround: 0xe8d4a8, hemiI: 1.3, glow: 0xfff4dc, glowI: 0.12, night: 0, stars: 0 });
const GOLDEN_KEY = key({ zenith: 0x4a86d4, horizon: 0xffe0b0, fog: 0xf4e2c8, sun: 0xffc98a, sunI: 2.2, hemiSky: 0xd6e2f5, hemiGround: 0xe8c89a, hemiI: 1.25, glow: 0xffcf8a, glowI: 0.4, night: 0.05, stars: 0 });
const DUSK = key({ zenith: 0x3b4a8c, horizon: 0xf59a7a, fog: 0xc89a9a, sun: 0xff8a5c, sunI: 0.9, hemiSky: 0x8a90c0, hemiGround: 0xa07a6a, hemiI: 1.05, glow: 0xff8a5c, glowI: 0.75, night: 0.55, stars: 0.2 });
const NIGHT = key({ zenith: 0x0e1a3a, horizon: 0x2b3d66, fog: 0x24324f, sun: 0xc9d8ff, sunI: 0.55, hemiSky: 0x4a62a0, hemiGround: 0x2e3040, hemiI: 1.7, glow: 0x000000, glowI: 0, night: 1, stars: 1 });
const STORM = key({ zenith: 0x4d5966, horizon: 0x9aa6ad, fog: 0x8b969c, sun: 0xe0e4e8, sunI: 0.6, hemiSky: 0x9aa6b0, hemiGround: 0x6a6a62, hemiI: 1.5, glow: 0x9aa6ad, glowI: 0, night: 0, stars: 0 });

/** The day's key moments: [phase, key]. Between them the look blends with an eased curve. */
const TIMELINE: readonly (readonly [number, DayLook])[] = [
  [0, NIGHT],
  [SUNRISE, DAWN],
  [DAY_START + 0.03, DAY],
  [GOLDEN - 0.06, DAY],
  [GOLDEN, GOLDEN_KEY],
  [SUNSET, DUSK],
  [NIGHT_START + 0.02, NIGHT],
  [1, NIGHT],
];

/** Midday intensities: the shared light uniforms are scaled relative to these. */
export const DAY_SUN_I = DAY.sunI;
export const DAY_HEMI_I = DAY.hemiI;

export function makeDayLook(): DayLook {
  return key({ zenith: 0, horizon: 0, fog: 0, sun: 0, sunI: 0, hemiSky: 0, hemiGround: 0, hemiI: 0, glow: 0, glowI: 0, night: 0, stars: 0 });
}

function blendLook(a: DayLook, b: DayLook, t: number, out: DayLook): void {
  for (const c of COLOR_KEYS) out[c].lerpColors(a[c], b[c], t);
  for (const n of NUMBER_KEYS) out[n] = a[n] + (b[n] - a[n]) * t;
}

/** The clear-weather look at a day phase (0..1, wraps), blended smoothly between the keys. */
export function dayLookAt(phase: number, out: DayLook): DayLook {
  const p = frac(phase);
  let i = 0;
  while (i < TIMELINE.length - 2 && p >= TIMELINE[i + 1][0]) i++;
  const [p0, a] = TIMELINE[i];
  const [p1, b] = TIMELINE[i + 1];
  blendLook(a, b, smoothstep(p0, p1, p), out);
  return out;
}

const DRY_HAZE = new THREE.Color(0xf3e3c3);
const DRY_GROUND = new THREE.Color(0xe8c890);
const AMBER_SKY = new THREE.Color(0xe8b27a);
const AMBER_SUN = new THREE.Color(0xffad5a);
const tmpColor = new THREE.Color();

/**
 * Season and weather on top of the clear look: a warm haze in the dry season, the amber light
 * of a storm warning, then storm grey. By day the storm key takes over; by night a storm only
 * greys and dims the colours, so a night storm never brightens the dark.
 */
export function applyMood(look: DayLook, dry: number, amber: number, gloom: number): DayLook {
  const dayness = 1 - look.night;
  const h = 0.14 * dry * dayness;
  look.horizon.lerp(DRY_HAZE, h);
  look.fog.lerp(DRY_HAZE, h);
  look.hemiGround.lerp(DRY_GROUND, 0.15 * dry * dayness);
  const a = amber * dayness;
  look.horizon.lerp(AMBER_SKY, 0.45 * a);
  look.fog.lerp(AMBER_SKY, 0.4 * a);
  look.sun.lerp(AMBER_SUN, 0.6 * a);
  look.hemiGround.lerp(AMBER_SKY, 0.2 * a);
  if (gloom > 0) {
    const byDay = 0.92 * gloom * dayness;
    const byNight = gloom * (1 - dayness);
    for (const c of COLOR_KEYS) {
      const col = look[c];
      col.lerp(STORM[c], byDay);
      const grey = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b;
      col.lerp(tmpColor.setRGB(grey, grey, grey), 0.6 * byNight).multiplyScalar(1 - 0.25 * byNight);
    }
    look.sunI += (STORM.sunI - look.sunI) * byDay;
    look.sunI *= 1 - 0.7 * byNight;
    look.hemiI += (STORM.hemiI - look.hemiI) * byDay;
    look.hemiI *= 1 - 0.1 * byNight;
    look.glowI *= 1 - gloom;
    look.stars *= 1 - gloom;
  }
  return look;
}

// ---------- the sky look shared with sky.ts ----------

/** What sky.ts paints (computed here so the sky and the light always agree). */
export interface SkyLook {
  zenith: THREE.Color;
  horizon: THREE.Color;
  glow: THREE.Color;
  glowI: number;
  /** True directions (unclamped; below the horizon when set). */
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** Sun disc colour (bright) and visibility 0..1 (set, or hidden by the storm deck). */
  sunDisc: THREE.Color;
  sunVis: number;
  moonPhase: number;
  moonVis: number;
  stars: number;
  /** How far the star field has turned (radians): one turn per day around the pole star. */
  starTurn: number;
}

const skyLooks = new WeakMap<WorldUniforms, SkyLook>();

/** The sky look shared by the systems of this world (created on first use). */
export function skyLookOf(u: WorldUniforms): SkyLook {
  let s = skyLooks.get(u);
  if (!s) {
    s = {
      zenith: new THREE.Color(0x3d9be9),
      horizon: new THREE.Color(0xd9f1ff),
      glow: new THREE.Color(),
      glowI: 0,
      sunDir: new THREE.Vector3(0.45, 0.8, -0.35).normalize(),
      moonDir: new THREE.Vector3(0, -1, 0),
      sunDisc: new THREE.Color(1, 1, 1),
      sunVis: 1,
      moonPhase: 0.5,
      moonVis: 0,
      stars: 0,
      starTurn: 0,
    };
    skyLooks.set(u, s);
  }
  return s;
}

// ---------- the system ----------

const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Shadows fade out between these camera distances (the god view has none). */
const SHADOW_FADE_START = 240;
const SHADOW_FADE_END = 330;

/** Shortest signed difference between two phases, in (-0.5, 0.5]. */
function phaseDiff(to: number, from: number): number {
  const d = frac(to - from);
  return d > 0.5 ? d - 1 : d;
}

/** Keep a light direction at least MIN_LIGHT_Y above the horizon. */
function liftLight(v: THREE.Vector3): THREE.Vector3 {
  if (v.y >= MIN_LIGHT_Y) return v;
  const h = Math.hypot(v.x, v.z) || 1;
  const s = Math.sqrt(1 - MIN_LIGHT_Y * MIN_LIGHT_Y) / h;
  return v.set(v.x * s, MIN_LIGHT_Y, v.z * s);
}

export function createDaylight(deps: SystemDeps): DaylightSystem {
  const { scene, u, quality, prefs } = deps;
  const weather = weatherOf(u);
  const sky = skyLookOf(u);

  const sun = new THREE.DirectionalLight(0xfff2d6, DAY_SUN_I);
  // Decided once at load: toggling shadow casting later would recompile every material.
  sun.castShadow = quality.shadows;
  const mapSize = () => (quality.tier === 2 && !quality.phone ? 2048 : 1024);
  sun.shadow.mapSize.set(mapSize(), mapSize());
  sun.shadow.bias = -0.0002;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, DAY_HEMI_I);
  scene.add(hemi);
  const background = new THREE.Color(0xd9f1ff);
  scene.background = background;
  const fog = new THREE.Fog(0xd9f1ff, 600, 6000);
  scene.fog = fog;

  // A new sea begins in the dry season (day 1), so its first wet season opens about 13 minutes in.
  // The first storm needs 15 minutes of play on the island and a wet season: starting wet would
  // let the first wet day run out first and push the first storm back to about minute 33.
  const day: DayState = { phase: START_PHASE, part: dayPart(START_PHASE), season: seasonOf(NEW_SEA_DAY), seasonPhase: 0, day: NEW_SEA_DAY, moon: moonPhase(NEW_SEA_DAY + START_PHASE) };
  /** Total days since the sea began (the real clock; keeps running when the light is held). */
  let clock = NEW_SEA_DAY + START_PHASE;
  /** The phase being shown (eases to a held phase, or back to the clock, when the mode changes). */
  let shown = START_PHASE;
  let mode: 'cycle' | 'day' | 'golden' = prefs.dayMode;
  let seenPrefMode = prefs.dayMode;

  const look = makeDayLook();
  const sunTrue = new THREE.Vector3();
  const moonTrue = new THREE.Vector3();
  const lightDir = new THREE.Vector3();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const right = new THREE.Vector3();
  const upL = new THREE.Vector3();
  const snapped = new THREE.Vector3();

  function setPhase(phase: number, dayCount = 0): void {
    clock = dayCount + phase;
    shown = frac(clock);
  }

  const system: DaylightSystem = {
    name: 'daylight',
    day,
    sun,
    hemi,
    setPhase,
    setMode(m) {
      mode = m;
    },
    update(f: FrameCtx) {
      // ----- clock -----
      if (prefs.dayMode !== seenPrefMode) {
        seenPrefMode = prefs.dayMode;
        mode = prefs.dayMode;
      }
      const natural = f.dt / DAY_SECONDS;
      clock += natural;
      const target = mode === 'day' ? NOON : mode === 'golden' ? GOLDEN : frac(clock);
      const diff = phaseDiff(target, shown);
      // A held light or a return to the clock sweeps there in a couple of seconds, easing in.
      const step = Math.min(0.3, 0.04 + Math.abs(diff) * 1.5) * f.dt + (mode === 'cycle' ? natural : 0);
      shown = Math.abs(diff) <= step ? target : frac(shown + Math.sign(diff) * step);

      day.phase = shown;
      day.part = dayPart(shown);
      day.day = Math.floor(clock);
      day.season = seasonOf(day.day);
      day.seasonPhase = frac(clock / SEASON_DAYS);
      day.moon = moonPhase(clock);
      const dry = dryMood(clock);

      // ----- colours -----
      dayLookAt(shown, look);
      applyMood(look, dry, weather.amber, weather.gloom);

      // ----- sun and moon -----
      sunDirection(shown, sunTrue);
      moonDirection(shown, moonTrue);
      const ms = moonShare(shown);
      liftLight(tmpA.copy(sunTrue));
      liftLight(tmpB.copy(moonTrue));
      // During a handover the light swings over the top (dim, so it is never noticed).
      lightDir.lerpVectors(tmpA, tmpB, ms);
      lightDir.y += 0.6 * Math.sin(Math.PI * ms);
      lightDir.normalize();
      const dip = 1 - 0.8 * Math.sin(Math.PI * ms);
      const moonFull = 1 - Math.abs(day.moon - 0.5) * 2;
      const lightI = look.sunI * (1 + (0.5 + 0.5 * moonFull - 1) * ms) * dip;

      sun.color.copy(look.sun);
      sun.intensity = lightI;
      hemi.color.copy(look.hemiSky);
      hemi.groundColor.copy(look.hemiGround);
      hemi.intensity = look.hemiI;

      u.uSunDir.value.copy(lightDir);
      u.uSunColor.value.copy(look.sun).multiplyScalar(lightI / DAY_SUN_I);
      u.uSkyColor.value.copy(look.hemiSky).multiplyScalar(look.hemiI / DAY_HEMI_I);
      u.uGroundColor.value.copy(look.hemiGround).multiplyScalar(look.hemiI / DAY_HEMI_I);
      u.uFogColor.value.copy(look.fog);
      u.uNight.value = look.night;
      u.uDry.value = dry;

      // ----- fog: scales with the camera, so the island always shows from the god view -----
      const g = weather.gloom;
      const near = f.cam.dist * (1.5 - 0.6 * g) + 400 - 250 * g;
      const far = near + 4400 - 2300 * g;
      u.uFogNear.value = near;
      u.uFogFar.value = far;
      fog.color.copy(look.fog);
      fog.near = near;
      fog.far = far;
      background.copy(look.fog);

      // ----- the sky look -----
      sky.zenith.copy(look.zenith);
      sky.horizon.copy(look.horizon);
      sky.glow.copy(look.glow);
      sky.glowI = look.glowI;
      sky.sunDir.copy(sunTrue);
      sky.moonDir.copy(moonTrue);
      sky.sunDisc.copy(look.sun).multiplyScalar(3);
      sky.sunVis = (1 - 0.97 * g) * smoothstep(-0.03, 0.03, sunTrue.y);
      sky.moonPhase = day.moon;
      sky.moonVis = (1 - 0.95 * g) * smoothstep(-0.03, 0.04, moonTrue.y);
      sky.stars = look.stars;
      sky.starTurn = shown * Math.PI * 2;

      // ----- shadows: a texel-snapped box around the camera target, fading out from far away -----
      if (sun.castShadow) {
        const want = mapSize();
        if (sun.shadow.mapSize.x !== want) {
          sun.shadow.mapSize.set(want, want);
          sun.shadow.map?.dispose();
          sun.shadow.map = null;
        }
        const fade = quality.shadows ? 1 - smoothstep(SHADOW_FADE_START, SHADOW_FADE_END, f.cam.dist) : 0;
        // Off at the god view and when quality drops: the map simply stops being redrawn. It is
        // still drawn once if it does not exist yet, because materials sample it either way.
        sun.shadow.autoUpdate = fade > 0;
        if (sun.shadow.map === null) sun.shadow.needsUpdate = true;
        sun.shadow.intensity = fade * (1 - 0.7 * g) * (1 - 0.4 * ms) * dip;
        // Half-size in quarter-octave steps, so zooming keeps texels stable between steps.
        const raw = Math.min(300, Math.max(30, f.cam.dist * 0.9));
        const half = Math.pow(2, Math.round(Math.log2(raw) * 4) / 4);
        const texel = (2 * half) / want;
        const sc = sun.shadow.camera;
        if (sc.right !== half) {
          sc.left = -half;
          sc.right = half;
          sc.top = half;
          sc.bottom = -half;
          sc.near = 500;
          sc.far = 1500;
          sc.updateProjectionMatrix();
        }
        sun.shadow.normalBias = texel * 1.5;
        // Snap the box to whole texels in light space, so shadows never shimmer when panning.
        right.crossVectors(WORLD_UP, lightDir).normalize();
        upL.crossVectors(lightDir, right);
        const t = f.cam.target;
        const lx = t.dot(right);
        const ly = t.dot(upL);
        snapped
          .copy(t)
          .addScaledVector(right, Math.round(lx / texel) * texel - lx)
          .addScaledVector(upL, Math.round(ly / texel) * texel - ly);
        sun.target.position.copy(snapped);
        sun.position.copy(snapped).addScaledVector(lightDir, 1000);
      } else {
        sun.target.position.copy(f.cam.target);
        sun.position.copy(f.cam.target).addScaledVector(lightDir, 1000);
      }
      sun.target.updateMatrixWorld();
    },
    dispose() {
      scene.remove(sun, sun.target, hemi);
      sun.dispose();
      hemi.dispose();
    },
  };

  // A small hook for screenshots and browser checks: window.__daylight.setPhase(0.85) shows night.
  if (typeof window !== 'undefined') (window as unknown as { __daylight: DaylightSystem }).__daylight = system;
  return system;
}
