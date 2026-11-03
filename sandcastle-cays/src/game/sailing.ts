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
  /**
   * Speed through the water (m/s) on the best point of sail, full sail, in the
   * usual trade wind: about 8.4 knots. A little quicker than a real boat this
   * size, so sailing always beats the motor by a long way (the owner's choice).
   * Stronger wind adds a little more; surfing down waves adds a lot.
   */
  topSpeed: 4.3,
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
  /** The outboard (about 6 hp): full ahead about 5 knots, full astern about 2.5 knots (m/s). It gets her moving quickly. */
  motorAhead: 2.6,
  motorAstern: 1.3,
  motorBite: 1.2,
  /** Past this much heel (radians, about 24°) she's overpowered: she slows, and fights to turn up into the wind. */
  overHeel: 0.42,
  /** The most she leans (radians, about 40°). */
  maxHeel: 0.7,
  /** Surfing: extra speed (m/s) for each unit of downhill slope of the sea under her, running or reaching fast. */
  surf: 32,
  surfMax: 2.6,
};

/**
 * How much of her top speed the sails give for a given push (sail area times
 * wind strength): more push always helps, but less and less, since a hull
 * can only go so fast through the water. 1 at full sail in the usual wind.
 */
export function sailPower(push: number): number {
  return (1 - Math.exp(-1.8 * push)) / (1 - Math.exp(-1.8));
}

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
  /** Slope of the sea under her along the bow (+ = downhill ahead, a wave lifting her stern). */
  slope?: number;
}

export interface SailEvents {
  /** Speed (m/s) at which she just touched bottom, if she did. */
  grounded: number;
  /** She was aground and has just come free. */
  floated: boolean;
  /** How overpowered she is (0 = fine; above 0 she's leaning too far for this wind). */
  over: number;
  /** Extra speed from surfing down a wave right now (m/s). */
  surfing: number;
}

export interface SeaBed {
  /** Height of the sea floor or land (m, sea level 0). */
  floorAt(x: number, z: number): number;
}

/** The true wind angle: where the wind comes from, relative to the bow (+ = from starboard). */
export function windAngle(b: BoatState, w: WindState): number {
  return wrap(w.from - b.heading);
}

/**
 * How far the keel is into the bottom at x, z, heading h (metres): above 0
 * she's touching; below 0 it's how much water there is to spare under her.
 * Checks along the keel, which is deepest amidships; the bow and stern sit higher.
 */
export function keelShortfall(sea: SeaBed, x: number, z: number, h: number): number {
  const c = Math.cos(h);
  const s = Math.sin(h);
  let worst = -Infinity;
  for (const along of [-1.6, 0, 1.4, 3.4]) {
    const depth = Math.abs(along) < 1.7 ? SAILING.draft : along > 0 ? 0.65 : 0.9;
    worst = Math.max(worst, sea.floorAt(x + c * along, z + s * along) + depth);
  }
  return worst;
}

/** Is the boat touching bottom at x, z, heading h? */
export function touchesBottom(sea: SeaBed, x: number, z: number, h: number): boolean {
  return keelShortfall(sea, x, z, h) > 0;
}

/**
 * The nearest spot (and heading) with water to spare under the keel: where
 * she ends up when you push her off. Searches outward in rings; null if
 * there's nowhere within `reach` metres.
 */
export function deepWaterNear(sea: SeaBed, x: number, z: number, h: number, reach = 60, spare = 0.35): { x: number; z: number; heading: number } | null {
  for (let r = 0; r <= reach; r += r < 6 ? 1 : 2) {
    const n = r === 0 ? 1 : Math.max(12, Math.round(r * 3));
    let best: { x: number; z: number; heading: number; score: number } | null = null;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      // Point her away from the shallows if that works (so she doesn't sail straight back on).
      for (const hh of r === 0 ? [h] : [wrap(a), wrap(a + Math.PI / 2), wrap(a - Math.PI / 2), h]) {
        const sf = keelShortfall(sea, px, pz, hh);
        if (sf < -spare) {
          const score = sf;
          if (!best || score < best.score) best = { x: px, z: pz, heading: hh, score };
          break;
        }
      }
    }
    if (best) return { x: best.x, z: best.z, heading: best.heading };
  }
  return null;
}

/** Advance the boat by dt seconds. */
export function stepBoat(b: BoatState, w: WindState, helm: HelmInput, sea: SeaBed, dt: number): SailEvents {
  const ev: SailEvents = { grounded: 0, floated: false, over: 0, surfing: 0 };
  // Sails go up and down at a steady rate.
  const hoist = dt / SAILING.hoistTime;
  b.sail += Math.max(-hoist, Math.min(hoist, b.sailSet - b.sail));
  const twa = windAngle(b, w);
  const windK = Math.min(3, Math.max(0.3, w.speed / SAILING.windSpeed));
  // Leaning too far for the wind: the sails spill it and the rudder loses its grip.
  const over = Math.max(0, Math.abs(b.heel) - SAILING.overHeel);
  ev.over = over;

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
    const nx = b.x + (tx - b.x) * (1 - Math.exp(-dt * 0.08));
    const nz = b.z + (tz - b.z) * (1 - Math.exp(-dt * 0.08));
    const nh = wrap(b.heading + wrap(w.from - b.heading) * (1 - Math.exp(-dt * 0.12)));
    // She swings to the wind, but never onto the shallows.
    const now = keelShortfall(sea, b.x, b.z, b.heading);
    if (keelShortfall(sea, nx, nz, nh) <= Math.max(0, now)) {
      b.x = nx;
      b.z = nz;
      b.heading = nh;
    }
  } else {
    // Speed eases toward what the wind, the sails and the motor give.
    const overpowered = Math.max(0.45, 1 - 1.6 * over);
    const sailTarget = SAILING.topSpeed * drive(twa) * sailPower(b.sail * windK) * overpowered;
    const motorTarget = motor >= 0 ? motor * SAILING.motorAhead : motor * SAILING.motorAstern;
    let target = sailTarget + motorTarget * (motor > 0 ? 1 - 0.35 * Math.min(1, sailTarget / SAILING.topSpeed) : 1);
    target = Math.min(target, SAILING.topSpeed * 1.3);
    // Surfing: running or reaching fast, a wave lifting her stern sends her racing down its face.
    const downwind = smoothstep(100 * DEG, 135 * DEG, Math.abs(twa));
    const surf = Math.min(SAILING.surfMax, SAILING.surf * Math.max(0, helm.slope ?? 0)) * downwind * smoothstep(2.4, 3.6, b.speed) * Math.min(1, b.sail * 2);
    target += surf;
    ev.surfing = surf;
    // Way carries her through a tack: she coasts slowly when the sails are only flapping.
    let k = target > b.speed ? SAILING.accel : drive(twa) === 0 ? SAILING.decel * 0.4 : SAILING.decel;
    if (surf > 0.2 && target > b.speed) k = 0.9;
    k = Math.max(k, SAILING.motorBite * Math.abs(motor));
    b.speed += (target - b.speed) * (1 - Math.exp(-dt * k));
    // Turning needs way on (a little turn is always possible, to get out of irons).
    // Going astern, the stern goes the way the rudder points, so the bow swings the other way.
    const dir = b.speed < -0.05 ? -1 : 1;
    const h0 = b.heading;
    b.heading = wrap(b.heading + dir * (b.rudder / SAILING.rudderMax) * SAILING.turnRate * grip * (1 - 0.5 * Math.min(1, over * 3)) * dt);
    // Overpowered, she tries to turn up into the wind ("rounding up"); steer away, or take in sail.
    if (over > 0 && Math.abs(twa) > SAILING.noGo) b.heading = wrap(b.heading + Math.sign(twa) * 1.5 * over * dt);
    // Turning can't swing her keel further into the bottom.
    const before = keelShortfall(sea, b.x, b.z, h0);
    if (keelShortfall(sea, b.x, b.z, b.heading) > Math.max(0, before) + 1e-4) b.heading = h0;
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
    const shortNow = keelShortfall(sea, b.x, b.z, b.heading);
    const shortNext = keelShortfall(sea, nx, nz, b.heading);
    if (shortNext > 0 && b.aground && shortNext <= Math.max(0, shortNow) + 1e-4) {
      // Stuck, but heading for deeper water (or no shallower): she drags slowly over the bottom.
      b.speed = Math.max(-0.5, Math.min(0.5, b.speed));
      b.agroundTime = (b.agroundTime ?? 0) + dt;
      b.x = b.x + (nx - b.x) * Math.min(1, 0.5 / Math.max(0.5, Math.hypot(vx, vz)));
      b.z = b.z + (nz - b.z) * Math.min(1, 0.5 / Math.max(0.5, Math.hypot(vx, vz)));
    } else if (shortNext > 0) {
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
  // The push on the sails grows faster than the wind does, so a strong wind leans her a lot.
  let heelTarget = b.anchored ? 0 : -Math.sign(twa) * b.sail * Math.pow(windK, 1.6) * (0.06 + 0.16 * Math.sin(Math.min(Math.PI, Math.abs(twa) * 1.35))) * (Math.abs(twa) < SAILING.noGo ? 0.2 : 1);
  heelTarget = Math.max(-SAILING.maxHeel, Math.min(SAILING.maxHeel, heelTarget));
  b.heelV += (6 * (heelTarget - b.heel) - 1.6 * b.heelV) * dt;
  b.heel = Math.max(-SAILING.maxHeel, Math.min(SAILING.maxHeel, b.heel + b.heelV * dt));
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
  /** Where she anchors at the end, if it's not `name` (a round trip). */
  arrive?: string;
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
  // Ease off near the final mark, and reef (half sail) when the wind is strong.
  const sailSet = (last && dist < 90) || w.speed > SAILING.windSpeed * 1.3 ? 0.5 : 1;
  return { steer: steerTo(want), sailSet, throttle: stalled ? 0.6 : 0, arrived: false };
}
