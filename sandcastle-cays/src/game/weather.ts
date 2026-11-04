/**
 * The weather at sea: where the open sea begins, how the wind builds out
 * there, and the squalls (passing rain showers with a burst of wind) that
 * drift across the cays on the trade wind.
 *
 * - Inside the reefs and between the two cays the water is sheltered: the
 *   steady trade wind and small waves you already know.
 * - Beyond, on the open sea, the wind is about half as strong again, gusts
 *   harder, and a long ocean swell rolls in from the east.
 * - Squalls form far to the east, drift west with the wind for nine minutes
 *   or so, and fade. Under one: rain, a burst of wind blowing out from its
 *   middle (so the wind shifts as you pass through), and rough water. They
 *   are a lot milder inside the reefs.
 *
 * Everything is a smooth function of time and place, so it's the same after
 * loading a save, and the checks can predict it. No drawing in here.
 */
import { SAILING, wrap, windAt, type WindState } from './sailing';

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The sheltered water around each cay: its centre and how far its reef reaches (metres). */
export const SHELTERS = [
  { x: 4, z: 30, r: 150 }, // Home Cay inside its reef
  { x: -210, z: -300, r: 120 }, // Pink Sand Cay
  { x: -330, z: 210, r: 95 }, // Shark Bank: the swell breaks on the edge of its flats
];
/** The open sea starts this far beyond the shelters and is fully open this far out (metres). */
export const OPEN_FROM = 60;
export const OPEN_FULL = 380;

/** 0 in sheltered water, rising to 1 out on the open sea. */
export function openness(x: number, z: number): number {
  let d = Infinity;
  for (const s of SHELTERS) d = Math.min(d, Math.hypot(x - s.x, z - s.z) - s.r);
  return smoothstep(OPEN_FROM, OPEN_FULL, d);
}

/** The middle of the waters you can sail, and how far out you may go. */
export const SEA_CENTRE = { x: -100, z: -140 };
export const SEA_RADIUS = 1050;

// ---------- squalls ----------

export interface Squall {
  id: number;
  x: number;
  z: number;
  /** Radius of the rain at sea level (metres). */
  radius: number;
  /** 0 (not yet formed, or gone) .. 1 (at its height). */
  strength: number;
  /** Drift (m/s). */
  vx: number;
  vz: number;
}

export const SQUALLS = {
  /** A new squall forms about this often (seconds). */
  every: 200,
  /** Each one lasts this long (seconds). */
  life: 540,
  /** How fast they drift west with the trade wind (m/s). */
  drift: 6,
  /** Extra wind under the heart of a strong squall (m/s), out on the open sea. */
  gust: 4.5,
  /** Wind blowing out from its middle, strongest near the edge of the rain (m/s). */
  outflow: 4.5,
};

/** A repeatable pseudo-random number in 0..1 for squall k, draw j. */
function hash(k: number, j: number): number {
  const s = Math.sin(k * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function squallK(k: number, t: number, out: Squall): Squall | null {
  const born = k * SQUALLS.every + (hash(k, 1) - 0.5) * 80;
  const age = t - born;
  if (age < 0 || age > SQUALLS.life) return null;
  const tau = age / SQUALLS.life;
  const peak = 0.55 + 0.45 * hash(k, 2);
  // Builds over the first quarter of its life, fades over the last third.
  out.strength = peak * smoothstep(0, 0.25, tau) * (1 - smoothstep(0.66, 1, tau));
  out.radius = 120 + 120 * hash(k, 3);
  out.vx = -SQUALLS.drift;
  out.vz = (hash(k, 4) - 0.5) * 1.2;
  out.x = SEA_CENTRE.x + 1650 + out.vx * age;
  out.z = SEA_CENTRE.z + (hash(k, 5) - 0.5) * 2100 + out.vz * age;
  out.id = k;
  return out;
}

/** The squalls that exist at time t (at most four). */
export function squallsAt(t: number, out: Squall[] = []): Squall[] {
  out.length = 0;
  const k1 = Math.floor((t + 40) / SQUALLS.every);
  const k0 = Math.max(0, Math.floor((t - SQUALLS.life - 40) / SQUALLS.every));
  for (let k = k0; k <= k1; k++) {
    const s = squallK(k, t, { id: 0, x: 0, z: 0, radius: 0, strength: 0, vx: 0, vz: 0 });
    if (s && s.strength > 0.001) out.push(s);
  }
  return out;
}

// ---------- the wind and rain where you are ----------

export interface Weather extends WindState {
  /** 0 sheltered .. 1 open sea. */
  open: number;
  /** Rain falling here, 0..1. */
  rain: number;
  /** How deep into a squall's wind you are, 0..1. */
  squall: number;
}

export function newWeather(): Weather {
  return { from: 0, speed: SAILING.windSpeed, gust: 0, open: 0, rain: 0, squall: 0 };
}

/**
 * The wind and rain at x, z at time t: the trade wind, stronger and gustier
 * on the open sea, plus any squall nearby.
 */
export function weatherAt(t: number, x: number, z: number, out: Weather = newWeather(), squalls?: Squall[]): Weather {
  windAt(t, out);
  const open = openness(x, z);
  out.open = open;
  // Out on the open sea: half as strong again, and the gusts hit harder.
  const gustMore = 1 + 0.18 * open * out.gust;
  let speed = out.speed * (1 + 0.5 * open) * gustMore;
  // The air's movement (it blows toward from + pi).
  let vx = -Math.cos(out.from) * speed;
  let vz = -Math.sin(out.from) * speed;
  let rain = 0;
  let squall = 0;
  const shelter = 0.45 + 0.55 * open;
  for (const s of squalls ?? squallsAt(t)) {
    const dx = x - s.x;
    const dz = z - s.z;
    const d = Math.hypot(dx, dz);
    const R = s.radius;
    if (d > R * 1.4) continue;
    // The gust front runs a little ahead of the rain.
    const core = 1 - smoothstep(0.5 * R, 1.35 * R, d);
    const ring = smoothstep(0.1 * R, 0.75 * R, d) * core;
    const k = s.strength * shelter;
    vx += -Math.cos(out.from) * SQUALLS.gust * k * core + (d > 0.01 ? (dx / d) * SQUALLS.outflow * k * ring : 0);
    vz += -Math.sin(out.from) * SQUALLS.gust * k * core + (d > 0.01 ? (dz / d) * SQUALLS.outflow * k * ring : 0);
    rain = Math.max(rain, s.strength * (1 - smoothstep(0.55 * R, 1.0 * R, d)));
    squall = Math.max(squall, s.strength * core);
  }
  speed = Math.hypot(vx, vz);
  out.speed = speed;
  out.from = wrap(Math.atan2(-vz, -vx));
  out.rain = rain;
  out.squall = squall;
  return out;
}

/** Wind in plain words, by its speed in knots (the Beaufort scale's names). */
export function windWord(knots: number): string {
  if (knots < 4) return 'light air';
  if (knots < 7) return 'light breeze';
  if (knots < 11) return 'gentle breeze';
  if (knots < 17) return 'moderate breeze';
  if (knots < 22) return 'fresh breeze';
  if (knots < 28) return 'strong breeze';
  if (knots < 34) return 'near gale';
  return 'gale';
}
