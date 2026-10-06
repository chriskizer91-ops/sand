/**
 * How loud each layer of the soundscape is (WP-G). Pure functions, so they can be tested
 * without WebAudio (tests/audio.test.ts checks that each one moves the right way).
 *
 * Every layer's level is (what lives near the listener) x (time of day) x (season) x (weather)
 * x (how high the camera is). The listener is the camera target. Close up you hear the detail of
 * the island; from the god view life fades to a faint hum and a high, airy wind opens up.
 * Levels are linear amplitudes (1 = full scale; the busiest moments stay well below that).
 */
import type { VoiceSpec } from '../content/speciesTypes';
import { smoothstep } from '../engine/noise';
import { DAY_START, DUSK_START, NIGHT_START, SUNRISE, SUNSET } from '../render/daylight';

const frac = (x: number) => x - Math.floor(x);

// ---------- the listener's height ----------

/** Life layers (birds, insects, frogs, leaves) fade as the camera rises; a faint hum remains. */
export function lifeAltitude(camDist: number): number {
  return 0.1 + 0.9 * (1 - smoothstep(60, 380, camDist));
}

/** The high-altitude air layer opens as the camera rises to the god view. */
export function airAltitude(camDist: number): number {
  return smoothstep(150, 900, camDist);
}

/** Cut-off (Hz) of the low-pass on ambience, life and weather: things sound far away from high up. */
export function fieldCutoff(camDist: number): number {
  return 16000 - 13000 * smoothstep(80, 900, camDist);
}

/** A sound source's level by its distance from the listener (m). */
export function distanceGain(d: number): number {
  return 1 / (1 + Math.max(0, d) / 15);
}

/** The player's own tools stay audible from far away, just softer (camera to the brush, m). */
export function toolDistanceGain(d: number): number {
  return 1 / (1 + Math.max(0, d) / 350);
}

// ---------- time of day ----------

/** How active a voice is at a day phase (0..1), by when it calls. Smooth through the whole day. */
export function activity(when: VoiceSpec['when'], phase: number): number {
  const p = frac(phase);
  const day = smoothstep(SUNRISE - 0.01, DAY_START + 0.01, p) * (1 - smoothstep(DUSK_START, SUNSET, p));
  const night = smoothstep(SUNSET, NIGHT_START + 0.02, p) + (1 - smoothstep(0, SUNRISE + 0.02, p));
  switch (when) {
    case 'day':
      return day;
    case 'night':
      return night;
    case 'dusk':
      return Math.max(smoothstep(DUSK_START - 0.02, SUNSET, p) * (1 - smoothstep(NIGHT_START + 0.02, NIGHT_START + 0.12, p)), 0.3 * night);
    case 'dawn':
      return Math.max(smoothstep(0, SUNRISE, p) * (1 - smoothstep(DAY_START + 0.02, DAY_START + 0.1, p)), 0.15 * day);
    default:
      return 1;
  }
}

/** The dawn chorus: day birds sing up to nearly twice as often just after sunrise. */
export function dawnChorus(phase: number): number {
  const p = frac(phase);
  return 1 + 0.8 * smoothstep(SUNRISE, DAY_START, p) * (1 - smoothstep(DAY_START + 0.04, DAY_START + 0.12, p));
}

/** Birds and insects hush as a storm builds and come back as it clears (storm 0..1). */
export function weatherQuiet(storm: number): number {
  return 1 - 0.85 * smoothstep(0.2, 0.9, storm);
}

// ---------- ambience ----------

/**
 * Wind over the land. exposure 0..1 (bare, high or open ground is exposed), strength 0..1,
 * gust 0..1, storm 0..1.
 */
export function windLevel(exposure: number, strength: number, gust: number, storm: number): number {
  return 0.12 * (0.5 + 0.5 * exposure) * (0.4 + 0.6 * strength) * (1 + 0.8 * gust) * (1 + 0.6 * storm);
}

/** Whistles through cracks in bare rock, tied to gusts; they fade as shrubs and trees soften the land. */
export function whistleLevel(bare: number, gust: number, woody: number): number {
  return (0.015 + 0.035 * gust) * bare * (1 - woody);
}

/** Leaves rustling: needs plants and wind. */
export function rustleLevel(green: number, strength: number, gust: number): number {
  return 0.07 * green * (0.3 + 0.7 * strength) * (0.6 + 0.6 * gust);
}

/** Surf: louder near the shore (m) and in storms. */
export function surfLevel(shoreDist: number, storm: number): number {
  return (0.45 / (1 + Math.max(0, shoreDist) / 35)) * (1 + 0.4 * storm);
}

/** The god view's high air: a soft, slowly swelling wind. */
export function airLevel(air: number, storm: number): number {
  return 0.045 * air * (1 + 0.5 * storm);
}

// ---------- weather ----------

export function rainLevel(rain: number): number {
  return 0.09 * rain;
}

/** The extra patter of rain on leaves (green 0..1 near the listener). */
export function leafRainLevel(rain: number, green: number): number {
  return 0.12 * rain * green;
}

// ---------- life ----------

/** A chorus bed (crickets, cicadas, frogs, a colony): abundance x activity x season mood. */
export function chorusLevel(abundance: number, act: number, mood: number): number {
  return 0.45 * Math.min(1, Math.max(0, abundance)) * act * mood;
}

/** A seabird colony heard from the listener: its size n (0..1), distance to its edge (m). */
export function colonyLevel(n: number, edgeDist: number): number {
  return n / (1 + Math.max(0, edgeDist) / 40);
}

// ---------- lava ----------

/** Hiss and crackle grow with the molten area (m^2), levelling off for big flows. */
export function lavaLevel(area: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, area)) / 45);
}

/** Glassy cooling pings per second: sparse, more while lots of lava is crusting over. */
export function tinkleRate(area: number, coolRate: number): number {
  if (area <= 0) return 0;
  return 0.7 + 2.3 * Math.min(1, Math.max(0, coolRate) / 150);
}
