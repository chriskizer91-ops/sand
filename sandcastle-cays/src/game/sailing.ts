/**
 * Sailing: the wind, and how your sloop moves through the water.
 *
 * The feel comes from the owner's airship game (speed and steering that ease
 * in, turning that needs way on, heel that springs back, gusts). On top of
 * that are the rules of a real sailboat:
 *  - you can't sail within about 40° of the wind (the "no-go zone": the sails
 *    flap and you slow to a stop); to go upwind you zig-zag (tack);
 *  - you're fastest with the wind from the side (a beam reach);
 *  - the boat heels away from the wind and slips a little sideways (leeway);
 *  - the keel draws 1.45 m: shallower than that and you run aground.
 *
 * Angles: a heading h points the bow along (cos h, sin h) in world x, z.
 * The wind's direction is where it blows FROM, in the same terms (the trade
 * wind from the east is 0). This file has no drawing in it, so the checks can
 * run it directly.
 */

export const TAU = Math.PI * 2;

export function wrap(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const DEG = Math.PI / 180;

export const SAILING = {
  /** Fastest speed through the water (m/s) on the best point of sail, full sail, in the usual trade wind. About 6.6 knots. */
  topSpeed: 3.4,
  /** How quickly speed builds and fades (per second). */
  accel: 0.3,
  decel: 0.45,
  /** Most the rudder turns (radians) and the fastest turn at full speed (radians per second). */
  rudderMax: 0.55,
  turnRate: 0.36,
  /** Hoisting or lowering the sails takes about this many seconds end to end. */
  hoistTime: 3.2,
  /** The keel's depth below the waterline (m). */
  draft: 1.45,
  /** Edge of the no-go zone, and where the sails are fully drawing. */
  noGo: 38 * DEG,
  closeHauled: 50 * DEG,
  /** Anchoring: only slowly, and in water no deeper than this (m). */
  anchorSpeed: 1.2,
  anchorDepth: 16,
  /** Usual trade-wind strength (m/s, about 13 knots). */
  windSpeed: 6.5,
  /** The little outboard: full ahead about 4.5 knots, full astern about 2 knots (m/s). */
  motorAhead: 2.3,
  motorAstern: 1.05,
};

/** How hard the sails drive the boat at a given angle off the wind (0 .. 1). */
export function drive(twa: number): number {
  const a = Math.abs(twa);
  if (a < SAILING.noGo) return 0;
  if (a < SAILING.closeHauled) return 0.72 * smoothstep(SAILING.noGo, SAILING.closeHauled, a);
  if (a < 95 * DEG) return 0.72 + 0.28 * smoothstep(SAILING.closeHauled, 95 * DEG, a);
  if (a < 150 * DEG) return 1 - 0.15 * smoothstep(95 * DEG, 150 * DEG, a);
  return 0.85 - 0.13 * smoothstep(150 * DEG, Math.PI, a);
}

export type PointOfSail = 'in irons' | 'close-hauled' | 'close reach' | 'beam reach' | 'broad reach' | 'running';

export function pointOfSail(twa: number): PointOfSail {
  const a = Math.abs(twa) / DEG;
  if (a < 38) return 'in irons';
  if (a < 55) return 'close-hauled';
  if (a < 75) return 'close reach';
  if (a < 115) return 'beam reach';
  if (a < 155) return 'broad reach';
  return 'running';
}

// ---------- the wind ----------

export interface WindState {
  /** Where the wind blows from (radians, 0 = from the east). */
  from: number;
  /** Strength (m/s), including any gust. */
  speed: number;
  /** 0..1: how much of a gust is blowing right now. */
  gust: number;
}

/**
 * The trade wind: steady from the east, shifting a few degrees now and then,
 * with gusts every so often. A smooth function of time, so it's the same
 * after loading a save and the checks can predict it.
 */
export function windAt(t: number, out: WindState = { from: 0, speed: SAILING.windSpeed, gust: 0 }): WindState {
  out.from = wrap(0.16 * Math.sin(t / 97) + 0.08 * Math.sin(t / 31 + 1.3));
  const g = Math.max(0, Math.sin(t * 0.21) * Math.sin(t * 0.083 + 0.7));
  out.gust = g * g;
  out.speed = SAILING.windSpeed * (0.9 + 0.12 * Math.sin(t / 53)) * (1 + 0.28 * out.gust);
  return out;
}

// ---------- the boat ----------

export interface BoatState {
  x: number;
  z: number;
  heading: number;
  /** Speed through the water along the bow (m/s). */
  speed: number;
  /** Sail setting asked for (0 furled, 0.5 half, 1 full) and how far the sails are actually up. */
  sailSet: number;
  sail: number;
  /** Rudder angle now (radians); positive turns the bow to starboard (right). */
  rudder: number;
  /** Heel (radians); positive leans the starboard side down. */
  heel: number;
  heelV: number;
  anchored: boolean;
  /** Where the anchor lies (when anchored). */
  ax: number;
  az: number;
  aground: boolean;
  /** Hull condition, 100 = sound. Scrapes on the reef or a beach wear it down (repairs come in v0.4). */
  hull: number;
  /** The outboard: throttle asked for (-1 astern .. 0 off .. 1 ahead) and what it's actually giving (it takes a moment to start and tilt down). */
  throttle?: number;
  motor?: number;
  /** Seconds before another knock can scrape the hull, and how long she's been stuck. */
  scrapeCool?: number;
  agroundTime?: number;
}

export function newBoat(x: number, z: number, heading: number): BoatState {
  return { x, z, heading, speed: 0, sailSet: 0, sail: 0, rudder: 0, heel: 0, heelV: 0, anchored: true, ax: x + Math.cos(heading) * 6, az: z + Math.sin(heading) * 6, aground: false, hull: 100, throttle: 0, motor: 0 };
}

export interface HelmInput {
  /** -1..1: turn the bow left (port) or right (starboard). */
  steer: number;
  /** Is anyone (or the autopilot) steering? Unattended, she rounds up into the wind and stops. */
  attended: boolean;
}

export interface SailEvents {
  /** Speed (m/s) at which she just touched bottom, if she did. */
  grounded: number;
  /** She was aground and has just come free. */
  floated: boolean;
}

export interface SeaBed {
  /** Height of the sea floor or land (m, sea level 0). */
  floorAt(x: number, z: number): number;
}

/** The true wind angle: where the wind comes from, relative to the bow (+ = from starboard). */
export function windAngle(b: BoatState, w: WindState): number {
  return wrap(w.from - b.heading);
}

/** Is the boat touching bottom at x, z, heading h? (Checks along the keel.) */
export function touchesBottom(sea: SeaBed, x: number, z: number, h: number): boolean {
  const c = Math.cos(h);
  const s = Math.sin(h);
  for (const along of [-1.6, 0, 1.4, 3.4]) {
    // The keel is deepest amidships; the bow and stern sit higher.
    const depth = Math.abs(along) < 1.7 ? SAILING.draft : along > 0 ? 0.65 : 0.9;
    if (sea.floorAt(x + c * along, z + s * along) > -depth) return true;
  }
  return false;
}

/** Advance the boat by dt seconds. */
export function stepBoat(b: BoatState, w: WindState, helm: HelmInput, sea: SeaBed, dt: number): SailEvents {
  const ev: SailEvents = { grounded: 0, floated: false };
  // Sails go up and down at a steady rate.
  const hoist = dt / SAILING.hoistTime;
  b.sail += Math.max(-hoist, Math.min(hoist, b.sailSet - b.sail));
  const twa = windAngle(b, w);
  const windK = Math.min(1.3, Math.max(0.4, w.speed / SAILING.windSpeed));

  // The outboard eases toward its throttle (a second or so to start and bite).
  b.throttle = Math.max(-1, Math.min(1, b.throttle ?? 0));
  b.motor = (b.motor ?? 0) + (b.throttle - (b.motor ?? 0)) * (1 - Math.exp(-dt * 2.2));
  if (Math.abs(b.motor) < 0.002 && b.throttle === 0) b.motor = 0;
  const motor = b.anchored ? 0 : b.motor;

  // Steering: the rudder eases toward where you push it; unattended, the helm
  // drifts so she rounds up into the wind (as a real sloop does).
  let steer = helm.steer;
  if (!helm.attended) steer = b.sail > 0.05 && Math.abs(twa) > SAILING.noGo * 0.8 ? Math.sign(twa) * 0.35 : 0;
  b.rudder += (steer * SAILING.rudderMax - b.rudder) * (1 - Math.exp(-dt * 3));
  // Aground you can still pole her round toward deeper water.
  // Under motor the propeller's push lets you steer even when slow.
  const grip = b.aground ? 0.6 : Math.max(0.3 + 0.7 * Math.min(1, Math.abs(b.speed) / 1.6), 0.8 * Math.abs(motor));

  if (b.anchored) {
    // At anchor: the boat lies back on her line, bow into the wind, swinging a little.
    b.speed += (0 - b.speed) * (1 - Math.exp(-dt * 1.5));
    const lieTo = w.from + Math.PI; // downwind of the anchor
    const rode = 7;
    const tx = b.ax + Math.cos(lieTo) * rode;
    const tz = b.az + Math.sin(lieTo) * rode;
    b.x += (tx - b.x) * (1 - Math.exp(-dt * 0.08));
    b.z += (tz - b.z) * (1 - Math.exp(-dt * 0.08));
    b.heading = wrap(b.heading + wrap(w.from - b.heading) * (1 - Math.exp(-dt * 0.12)));
  } else {
    // Speed eases toward what the wind, the sails and the motor give.
    const sailTarget = SAILING.topSpeed * drive(twa) * b.sail * windK;
    const motorTarget = motor >= 0 ? motor * SAILING.motorAhead : motor * SAILING.motorAstern;
    let target = sailTarget + motorTarget * (motor > 0 ? 1 - 0.35 * Math.min(1, sailTarget / SAILING.topSpeed) : 1);
    target = Math.min(target, SAILING.topSpeed * 1.05);
    // Way carries her through a tack: she coasts slowly when the sails are only flapping.
    let k = target > b.speed ? SAILING.accel : drive(twa) === 0 ? SAILING.decel * 0.4 : SAILING.decel;
    k = Math.max(k, 0.7 * Math.abs(motor));
    b.speed += (target - b.speed) * (1 - Math.exp(-dt * k));
    // Turning needs way on (a little turn is always possible, to get out of irons).
    // Going astern, the stern goes the way the rudder points, so the bow swings the other way.
    const dir = b.speed < -0.05 ? -1 : 1;
    b.heading = wrap(b.heading + dir * (b.rudder / SAILING.rudderMax) * SAILING.turnRate * grip * dt);
    // Leeway: she slips a little sideways, away from the wind, when sailing across or into it.
    const side = Math.abs(twa) < 120 * DEG ? 4 * DEG * drive(twa) * b.sail : 0;
    const leeSign = twa >= 0 ? -1 : 1; // wind from starboard pushes her to port
    const c = Math.cos(b.heading);
    const s = Math.sin(b.heading);
    // Starboard (to the right of the bow) is (-sin h, cos h).
    const vx = c * b.speed + -s * leeSign * b.speed * Math.tan(side);
    const vz = s * b.speed + c * leeSign * b.speed * Math.tan(side);
    const nx = b.x + vx * dt;
    const nz = b.z + vz * dt;
    b.scrapeCool = Math.max(0, (b.scrapeCool ?? 0) - dt);
    if (touchesBottom(sea, nx, nz, b.heading)) {
      // She stops against the bottom. A real knock (not a gentle nudge) scrapes the hull.
      if (Math.abs(b.speed) > 0.5 && b.scrapeCool <= 0) {
        ev.grounded = Math.abs(b.speed);
        b.hull = Math.max(0, b.hull - Math.min(25, 6 + 8 * Math.abs(b.speed)));
        b.scrapeCool = 4;
      }
      if (!b.aground) b.agroundTime = 0;
      b.aground = true;
      b.agroundTime = (b.agroundTime ?? 0) + dt;
      b.speed = 0;
    } else {
      // Free to move: if she'd been stuck a while, she has just come off.
      if (b.aground && (b.agroundTime ?? 0) > 0.5 && Math.abs(b.speed) > 0.15) ev.floated = true;
      if (!b.aground || Math.abs(b.speed) > 0.15) b.aground = false;
      b.x = nx;
      b.z = nz;
    }
  }

  // Heel: the wind leans her away from it; a spring brings her back.
  const heelTarget = b.anchored ? 0 : -Math.sign(twa) * b.sail * windK * (0.06 + 0.16 * Math.sin(Math.min(Math.PI, Math.abs(twa) * 1.35))) * (Math.abs(twa) < SAILING.noGo ? 0.2 : 1);
  b.heelV += (6 * (heelTarget - b.heel) - 1.6 * b.heelV) * dt;
  b.heel += b.heelV * dt;
  return ev;
}

/** Try to drop the anchor. Returns why not, or null when it's down. */
export function dropAnchor(b: BoatState, sea: SeaBed): string | null {
  if (b.anchored) return null;
  if (Math.abs(b.speed) > SAILING.anchorSpeed) return 'Too fast to anchor. Lower the sails and slow down first.';
  const depth = -sea.floorAt(b.x, b.z);
  if (depth > SAILING.anchorDepth) return 'Too deep to anchor here. Find water under 16 m deep, near an island.';
  b.anchored = true;
  b.ax = b.x + Math.cos(b.heading) * 6;
  b.az = b.z + Math.sin(b.heading) * 6;
  b.sailSet = 0;
  b.throttle = 0;
  return null;
}

export function weighAnchor(b: BoatState): void {
  b.anchored = false;
}

/** Where the boom swings for a wind angle: out to the side away from the wind, further the more downwind (radians, + = starboard). */
export function boomAngle(twa: number): number {
  const a = Math.abs(twa);
  const out = 0.12 + 1.15 * smoothstep(SAILING.noGo, 165 * DEG, a);
  return twa >= 0 ? -out : out;
}

/** How full the sails are (0 = flapping in the no-go zone, 1 = drawing). */
export function sailFill(twa: number): number {
  return smoothstep(SAILING.noGo - 8 * DEG, SAILING.noGo + 6 * DEG, Math.abs(twa));
}

// ---------- the autopilot ("sail there for me") ----------

export interface Course {
  /** Points to pass through in order; the last is where to anchor. */
  waypoints: { x: number; z: number }[];
  /** Current tack when beating upwind: +1 or -1. */
  tack: number;
  name: string;
}

/**
 * Steer for the next waypoint. Upwind, it zig-zags 52° off the wind on each
 * side, tacking when the other tack points clearly closer to the mark.
 * Returns the steer input (-1..1) and whether the course is finished.
 */
export function autopilot(b: BoatState, w: WindState, c: Course): { steer: number; sailSet: number; throttle: number; arrived: boolean } {
  let wp = c.waypoints[0];
  while (c.waypoints.length > 1 && Math.hypot(wp.x - b.x, wp.z - b.z) < 22) {
    c.waypoints.shift();
    wp = c.waypoints[0];
  }
  const dist = Math.hypot(wp.x - b.x, wp.z - b.z);
  const last = c.waypoints.length === 1;
  const bearing = Math.atan2(wp.z - b.z, wp.x - b.x);
  const steerTo = (h: number) => Math.max(-1, Math.min(1, wrap(h - b.heading) * 2.5));
  if (last && dist < 45) {
    // Arriving: sails down and motor gently to the spot, then stop and anchor.
    if (dist > 9) return { steer: steerTo(bearing), sailSet: 0, throttle: 0.45, arrived: false };
    return { steer: 0, sailSet: 0, throttle: 0, arrived: Math.abs(b.speed) < SAILING.anchorSpeed * 0.9 };
  }
  let want = bearing;
  const off = wrap(bearing - w.from);
  const tackAngle = 52 * DEG;
  if (Math.abs(off) < tackAngle) {
    // The mark is upwind. A short way: just motor there with the sails down.
    if (dist < 160) return { steer: steerTo(bearing), sailSet: 0, throttle: 0.85, arrived: false };
    // Further: beat toward it on one tack or the other.
    const hA = wrap(w.from + tackAngle);
    const hB = wrap(w.from - tackAngle);
    const cur = c.tack > 0 ? hA : hB;
    const other = c.tack > 0 ? hB : hA;
    if (Math.abs(wrap(bearing - other)) + 25 * DEG < Math.abs(wrap(bearing - cur))) c.tack = -c.tack;
    want = c.tack > 0 ? hA : hB;
  }
  // Stalled head to wind (in irons)? A burst of motor gets her moving again.
  const stalled = Math.abs(b.speed) < 0.4 && Math.abs(wrap(w.from - b.heading)) < SAILING.noGo;
  // Ease off near the final mark.
  const sailSet = last && dist < 90 ? 0.5 : 1;
  return { steer: steerTo(want), sailSet, throttle: stalled ? 0.6 : 0, arrived: false };
}
