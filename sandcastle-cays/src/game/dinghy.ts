/**
 * The dinghy: a little wooden tender that hangs in davits between the
 * catamaran's sterns. Lower it, climb down into it, and row it, or start the
 * old outboard on its transom and zip along. It floats in water a hand's
 * depth deep, so it can cross shallows and sand flats the big boat can't, and
 * you can run it right up on a beach.
 *
 * - Rowing (W/S, or the stick): slow and quiet, and it works anywhere.
 * - The outboard: about three times as fast, but its propeller needs a bit
 *   of water under it. In the shallows it tilts up and you row the rest.
 * - Dents from sharks' bumps make it slower until you mend it.
 * - Left tied to the big boat's stern, it follows her on its painter.
 *   Left anywhere else, it stays where you left it.
 *
 * Headings: like the big boat, the bow points along (cos h, sin h) in x, z,
 * and a positive steer turns the bow to starboard. No drawing in here.
 */

export const DINGHY = {
  length: 3.0,
  beam: 1.35,
  /** It floats in this much water (metres). */
  draft: 0.22,
  /** Rowing: top speed ahead and astern (m/s), and how fast it picks up. */
  rowSpeed: 1.25,
  rowAstern: 0.6,
  rowAccel: 0.55,
  /** One stroke of the oars (seconds). */
  strokeTime: 1.5,
  /** The outboard: top speed ahead and astern (m/s), and how fast it picks up. */
  motorSpeed: 3.4,
  motorAstern: 1.0,
  motorAccel: 1.0,
  /** The propeller needs this much water under the stern (metres). */
  motorDepth: 0.55,
  /** Seconds to pull-start the outboard. */
  motorStart: 1.2,
  /** Turning (radians a second): rowing can spin it on the spot; the outboard needs a bit of way on. */
  turnRow: 0.65,
  turnMotor: 0.8,
  /** Slowing down when nobody rows (m/s each second). */
  drag: 0.35,
  /** Drifting with the wind when nobody rows (fraction of the wind speed). */
  drift: 0.012,
  /** Dents: at 0% condition it goes this much slower. */
  dentSlow: 0.4,
  /** Towed behind the big boat on a rope this long (metres, from her stern). */
  painter: 7,
  /** You can climb in from this far away (metres from its middle). */
  reach: 2.4,
};

export type DinghyWhere = 'davits' | 'water';

export interface DinghyState {
  where: DinghyWhere;
  x: number;
  z: number;
  heading: number;
  /** Speed along the bow (m/s; negative astern). */
  speed: number;
  /** How hard it's turning (radians a second), for the look of it. */
  yawRate: number;
  /** Tied to the big boat's stern (it follows her). */
  tied: boolean;
  /** The outboard: running (or starting), and the throttle (-1 astern .. 1 ahead). */
  motor: boolean;
  motorT: number;
  throttle: number;
  /** The oars: where in the stroke (0..1), and whether you're pulling. */
  stroke: number;
  rowing: boolean;
  /** Its bow (or stern) is on the sand. */
  aground: boolean;
}

export function newDinghy(): DinghyState {
  return { where: 'davits', x: 0, z: 0, heading: 0, speed: 0, yawRate: 0, tied: true, motor: false, motorT: 0, throttle: 0, stroke: 0, rowing: false, aground: false };
}

const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function restoreDinghy(raw: unknown): DinghyState {
  const d = newDinghy();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<DinghyState>;
  d.where = r.where === 'water' ? 'water' : 'davits';
  d.x = fin(r.x, 0);
  d.z = fin(r.z, 0);
  d.heading = fin(r.heading, 0);
  d.tied = r.tied !== false;
  return d;
}

/** What gets saved: where it is, not how it's moving. */
export function dinghySave(d: DinghyState): Partial<DinghyState> {
  return { where: d.where, x: d.x, z: d.z, heading: d.heading, tied: d.tied };
}

export interface DinghyInput {
  /** -1 astern .. 1 ahead (rowing, or the throttle with the outboard running). */
  ahead: number;
  /** -1 port .. 1 starboard. */
  steer: number;
}

export interface DinghySea {
  /** How deep the water is here (metres; 0 or less on dry land). */
  depthAt(x: number, z: number): number;
  /** The wind (m/s, the way it blows toward). */
  windX: number;
  windZ: number;
  /** Dinghy condition 0..100. */
  condition: number;
}

export interface DinghyEvents {
  /** Just ran up on the sand. */
  beached: boolean;
  /** Just floated off again. */
  floated: boolean;
  /** The outboard just tilted up (too shallow) or was stopped. */
  motorUp: boolean;
  /** The outboard just caught and started. */
  motorStarted: boolean;
  /** A stroke of the oars just bit the water (for the sound). */
  stroke: boolean;
}

/** Where its bow (s = 1) or stern (s = -1) is. */
export function endOf(d: { x: number; z: number; heading: number }, s: number): { x: number; z: number } {
  const k = DINGHY.length * 0.45 * s;
  return { x: d.x + Math.cos(d.heading) * k, z: d.z + Math.sin(d.heading) * k };
}

/** Is there water enough for the outboard here? */
export function motorWater(d: DinghyState, sea: DinghySea): boolean {
  const st = endOf(d, -1);
  return sea.depthAt(st.x, st.z) >= DINGHY.motorDepth;
}

/** Pull the cord: start the outboard. Returns why not, or null. */
export function startMotor(d: DinghyState, sea: DinghySea): string | null {
  if (d.motor) return null;
  if (!motorWater(d, sea)) return 'Too shallow for the outboard: the propeller would hit the sand. Row out into deeper water first.';
  d.motor = true;
  d.motorT = 0;
  d.throttle = 0;
  return null;
}

export function stopMotor(d: DinghyState): void {
  d.motor = false;
  d.motorT = 0;
  d.throttle = 0;
}

/** Is the outboard actually driving (started, not still being pull-started)? */
export function motorRunning(d: DinghyState): boolean {
  return d.motor && d.motorT >= DINGHY.motorStart;
}

/** Top speed with the dents it has (a factor, 1 = as new). */
export function dentFactor(condition: number): number {
  return 1 - DINGHY.dentSlow * (1 - Math.max(0, Math.min(100, condition)) / 100);
}

/** You're in it: row or motor for dt seconds. */
export function stepDinghy(d: DinghyState, input: DinghyInput, sea: DinghySea, dt: number): DinghyEvents {
  const ev: DinghyEvents = { beached: false, floated: false, motorUp: false, motorStarted: false, stroke: false };
  const k = dentFactor(sea.condition);
  const ahead = Math.max(-1, Math.min(1, input.ahead));
  const steer = Math.max(-1, Math.min(1, input.steer));

  if (d.motor) {
    const was = d.motorT;
    d.motorT += dt;
    if (was < DINGHY.motorStart && d.motorT >= DINGHY.motorStart) ev.motorStarted = true;
    if (!motorWater(d, sea)) {
      stopMotor(d);
      ev.motorUp = true;
    }
  }

  let target = 0;
  let accel = DINGHY.drag;
  if (motorRunning(d)) {
    // The throttle follows the stick a little slowly, like a twist grip.
    d.throttle += Math.max(-dt * 1.5, Math.min(dt * 1.5, ahead - d.throttle));
    target = d.throttle >= 0 ? d.throttle * DINGHY.motorSpeed * k : d.throttle * DINGHY.motorAstern * k;
    accel = DINGHY.motorAccel;
    d.rowing = false;
  } else if (!d.motor && (Math.abs(ahead) > 0.05 || Math.abs(steer) > 0.05)) {
    // Rowing: a surge with each stroke.
    d.rowing = true;
    const before = d.stroke;
    d.stroke = (d.stroke + dt / DINGHY.strokeTime) % 1;
    if (before < 0.1 && d.stroke >= 0.1) ev.stroke = true;
    const power = d.stroke < 0.45 ? 1.6 : 0.35;
    target = ahead >= 0 ? ahead * DINGHY.rowSpeed * k : ahead * DINGHY.rowAstern * k;
    accel = DINGHY.rowAccel * power;
  } else {
    d.rowing = false;
    // Oars resting: let the stroke finish so they settle.
    if (d.stroke > 0) d.stroke = Math.min(1, d.stroke + dt / DINGHY.strokeTime) % 1;
  }
  if (Math.abs(target) < Math.abs(d.speed) && Math.sign(target) === Math.sign(d.speed)) accel = Math.max(accel, DINGHY.drag);
  d.speed += Math.max(-accel * dt, Math.min(accel * dt, target - d.speed));

  // Turning.
  const way = Math.min(1, Math.abs(d.speed) / 1.2);
  const turn = motorRunning(d) ? steer * DINGHY.turnMotor * (0.25 + 0.75 * way) * Math.sign(d.speed || 1) : d.rowing ? steer * DINGHY.turnRow : 0;
  const h0 = d.heading;
  const ends0 = Math.min(depthEnd(d, sea, 1), depthEnd(d, sea, -1));
  d.heading += turn * dt;
  const ends1 = Math.min(depthEnd(d, sea, 1), depthEnd(d, sea, -1));
  // Don't swing an end up onto the sand.
  if (ends1 < DINGHY.draft && ends1 < ends0 - 1e-4) d.heading = h0;
  d.yawRate += ((d.heading - h0) / Math.max(dt, 1e-6) - d.yawRate) * Math.min(1, dt * 4);

  // Moving, unless that runs the bow (or the stern, going astern) up on the sand.
  const nx = d.x + Math.cos(d.heading) * d.speed * dt + sea.windX * DINGHY.drift * dt * (d.rowing || motorRunning(d) ? 0.3 : 1);
  const nz = d.z + Math.sin(d.heading) * d.speed * dt + sea.windZ * DINGHY.drift * dt * (d.rowing || motorRunning(d) ? 0.3 : 1);
  const lead = d.speed >= 0 ? 1 : -1;
  const dNow = depthEnd(d, sea, lead);
  const next = endOf({ x: nx, z: nz, heading: d.heading }, lead);
  const dNext = sea.depthAt(next.x, next.z);
  const wasAground = d.aground;
  if (dNext < DINGHY.draft && dNext <= dNow) {
    // On the sand: it stops (you can always back off the way you came).
    d.speed = 0;
    d.aground = true;
  } else {
    d.x = nx;
    d.z = nz;
    d.aground = Math.min(depthEnd(d, sea, 1), depthEnd(d, sea, -1)) < DINGHY.draft;
  }
  if (d.aground && !wasAground) ev.beached = true;
  if (!d.aground && wasAground) ev.floated = true;
  return ev;
}

function depthEnd(d: DinghyState, sea: DinghySea, s: number): number {
  const p = endOf(d, s);
  return sea.depthAt(p.x, p.z);
}

/** Nobody in it: it sits where you left it (it swings gently to the wind, and a beached one stays put). */
export function idleDinghy(d: DinghyState, sea: DinghySea, dt: number): void {
  d.speed *= Math.max(0, 1 - dt * 0.8);
  d.rowing = false;
  if (d.motor) stopMotor(d);
  if (Math.abs(d.speed) > 0.01) {
    const nx = d.x + Math.cos(d.heading) * d.speed * dt;
    const nz = d.z + Math.sin(d.heading) * d.speed * dt;
    const p = endOf({ x: nx, z: nz, heading: d.heading }, Math.sign(d.speed));
    if (sea.depthAt(p.x, p.z) >= DINGHY.draft) {
      d.x = nx;
      d.z = nz;
    } else d.speed = 0;
  }
}

/** Where the painter is made fast: the middle of the big boat's stern. */
export function towPoint(boat: { x: number; z: number; heading: number }, sternX: number): { x: number; z: number } {
  return { x: boat.x + Math.cos(boat.heading) * sternX, z: boat.z + Math.sin(boat.heading) * sternX };
}

/**
 * Tied astern: it follows the big boat on its painter. When she moves away
 * the rope pulls it after her, bow first; when she stops it drifts back to
 * lie downwind of her.
 */
export function towDinghy(d: DinghyState, at: { x: number; z: number }, sea: DinghySea, dt: number): void {
  const dx = d.x - at.x;
  const dz = d.z - at.z;
  const dist = Math.hypot(dx, dz) || 1e-6;
  d.rowing = false;
  if (d.motor) stopMotor(d);
  if (dist > DINGHY.painter) {
    // The rope is taut: pull it in to painter's length, bow toward the stern.
    const k = DINGHY.painter / dist;
    const ox = d.x;
    const oz = d.z;
    d.x = at.x + dx * k;
    d.z = at.z + dz * k;
    const moved = Math.hypot(d.x - ox, d.z - oz);
    d.speed = moved / Math.max(dt, 1e-6);
    const want = Math.atan2(at.z - d.z, at.x - d.x);
    let diff = want - d.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    d.heading += diff * Math.min(1, dt * 2.5);
  } else {
    // Slack: drift downwind a little, and slow down.
    d.speed *= Math.max(0, 1 - dt);
    const w = Math.hypot(sea.windX, sea.windZ);
    if (w > 0.1) {
      d.x += (sea.windX / w) * 0.15 * dt;
      d.z += (sea.windZ / w) * 0.15 * dt;
      const want = Math.atan2(-sea.windZ, -sea.windX);
      let diff = want - d.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      d.heading += diff * Math.min(1, dt * 0.3);
    }
  }
  d.aground = false;
}
