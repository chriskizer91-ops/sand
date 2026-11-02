import { describe, expect, it } from 'vitest';
import { SAILING, autopilot, boomAngle, drive, dropAnchor, newBoat, pointOfSail, sailFill, stepBoat, weighAnchor, windAngle, windAt, wrap, type Course, type SeaBed, type WindState } from '../src/game/sailing';

const DEG = Math.PI / 180;
const deep: SeaBed = { floorAt: () => -10 };
const steady: WindState = { from: 0, speed: SAILING.windSpeed, gust: 0 };

function sail(b: ReturnType<typeof newBoat>, seconds: number, steer = 0, sea: SeaBed = deep, wind: WindState = steady, attended = true) {
  const evs = [];
  for (let t = 0; t < seconds; t += 1 / 30) evs.push(stepBoat(b, wind, { steer, attended }, sea, 1 / 30));
  return evs;
}

describe('the points of sail', () => {
  it('no push at all in the no-go zone, most with the wind on the beam, a little less running', () => {
    expect(drive(0)).toBe(0);
    expect(drive(30 * DEG)).toBe(0);
    expect(drive(-30 * DEG)).toBe(0);
    expect(drive(90 * DEG)).toBeGreaterThan(0.95);
    expect(drive(180 * DEG)).toBeLessThan(drive(90 * DEG));
    expect(drive(180 * DEG)).toBeGreaterThan(0.6);
    expect(drive(50 * DEG)).toBeGreaterThan(0.6);
    expect(pointOfSail(0)).toBe('in irons');
    expect(pointOfSail(90 * DEG)).toBe('beam reach');
    expect(pointOfSail(-170 * DEG)).toBe('running');
  });

  it('the boom goes out on the side away from the wind, further when running', () => {
    expect(boomAngle(60 * DEG)).toBeLessThan(0); // wind from starboard: boom to port
    expect(boomAngle(-60 * DEG)).toBeGreaterThan(0);
    expect(Math.abs(boomAngle(170 * DEG))).toBeGreaterThan(Math.abs(boomAngle(50 * DEG)));
    expect(sailFill(10 * DEG)).toBe(0);
    expect(sailFill(90 * DEG)).toBe(1);
  });

  it('the trade wind blows from the east, shifts a little and gusts', () => {
    let minFrom = 9;
    let maxFrom = -9;
    let maxSpeed = 0;
    for (let t = 0; t < 1200; t += 0.5) {
      const w = windAt(t);
      minFrom = Math.min(minFrom, w.from);
      maxFrom = Math.max(maxFrom, w.from);
      maxSpeed = Math.max(maxSpeed, w.speed);
    }
    expect(minFrom).toBeGreaterThan(-25 * DEG);
    expect(maxFrom).toBeLessThan(25 * DEG);
    expect(maxSpeed).toBeGreaterThan(SAILING.windSpeed * 1.05);
    expect(windAt(42).from).toBe(windAt(42).from);
  });
});

describe('sailing the sloop', () => {
  it('on a beam reach with full sail she picks up to about 6 knots', () => {
    const b = newBoat(0, 0, 90 * DEG); // heading north (+z); wind from the east is on the beam
    weighAnchor(b);
    b.sailSet = 1;
    sail(b, 30);
    expect(b.speed).toBeGreaterThan(SAILING.topSpeed * 0.85);
    expect(b.speed).toBeLessThanOrEqual(SAILING.topSpeed * 1.05);
    expect(b.z).toBeGreaterThan(40);
  });

  it('pointing into the wind (in irons) she stops, sails flapping', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    b.sailSet = 1;
    sail(b, 25);
    b.heading = 0; // straight into the east wind
    sail(b, 25);
    expect(b.speed).toBeLessThan(0.3);
  });

  it('turning needs way on: she turns slowly when stopped and briskly when moving', () => {
    const stopped = newBoat(0, 0, 90 * DEG);
    weighAnchor(stopped);
    sail(stopped, 3, 1);
    const moving = newBoat(0, 0, 90 * DEG);
    weighAnchor(moving);
    moving.sailSet = 1;
    sail(moving, 25);
    const h0 = moving.heading;
    sail(moving, 3, 1);
    expect(Math.abs(wrap(stopped.heading - 90 * DEG))).toBeLessThan(22 * DEG);
    expect(Math.abs(wrap(moving.heading - h0))).toBeGreaterThan(40 * DEG);
  });

  it('steering right turns the bow to starboard (the heading goes up)', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    b.sailSet = 1;
    sail(b, 20);
    const h0 = b.heading;
    sail(b, 1, 1);
    expect(wrap(b.heading - h0)).toBeGreaterThan(0);
  });

  it('she heels away from the wind and slips a little to leeward', () => {
    const b = newBoat(0, 0, 90 * DEG); // wind from starboard (east) when heading north
    weighAnchor(b);
    b.sailSet = 1;
    sail(b, 30);
    // Heading +z with the wind from +x: the wind is on the port side (starboard is -x when facing +z).
    expect(windAngle(b, steady)).toBeLessThan(0);
    expect(b.heel).toBeGreaterThan(0.05); // leaning to starboard, away from the wind
    expect(b.x).toBeLessThan(-0.5); // slipped a little downwind
  });

  it('left alone with sails up, she rounds up into the wind and stops', () => {
    const b = newBoat(0, 0, 100 * DEG);
    weighAnchor(b);
    b.sailSet = 1;
    sail(b, 20);
    sail(b, 90, 0, deep, steady, false);
    expect(b.speed).toBeLessThan(0.6);
    expect(Math.abs(windAngle(b, steady))).toBeLessThan(SAILING.noGo + 10 * DEG);
  });

  it('running onto a shallow bar puts her aground and scrapes the hull; steering away floats her off', () => {
    // A sand bar 60 m north of the start, everywhere else deep.
    const bar: SeaBed = { floorAt: (_x, z) => (z > 60 && z < 80 ? -0.6 : -6) };
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    b.sailSet = 1;
    const evs = sail(b, 40, 0, bar);
    expect(evs.some((e) => e.grounded > 0)).toBe(true);
    expect(b.aground).toBe(true);
    expect(b.hull).toBeLessThan(100);
    expect(b.z).toBeLessThan(62);
    // Turn away (to starboard, toward the south-east) and sail off.
    const hull = b.hull;
    expect(evs.filter((e) => e.grounded > 0).length).toBe(1); // one knock, not a scrape every second
    const out = sail(b, 40, 1, bar);
    expect(out.some((e) => e.floated)).toBe(true);
    expect(b.aground).toBe(false);
    expect(b.hull).toBeGreaterThanOrEqual(hull - 15); // at most one more light knock while turning off
    expect(b.z).toBeLessThan(60);
  });
});

describe('anchoring', () => {
  it('only when slow, and not in deep water; at anchor she lies head to wind near the anchor', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    b.sailSet = 1;
    sail(b, 30);
    expect(dropAnchor(b, deep)).toMatch(/Too fast/);
    b.sailSet = 0;
    sail(b, 40);
    expect(dropAnchor({ ...b }, { floorAt: () => -40 })).toMatch(/Too deep/);
    expect(dropAnchor(b, deep)).toBeNull();
    expect(b.anchored).toBe(true);
    const ax = b.ax;
    const az = b.az;
    sail(b, 120);
    expect(Math.hypot(b.x - ax, b.z - az)).toBeLessThan(12);
    expect(Math.abs(wrap(b.heading - steady.from))).toBeLessThan(25 * DEG);
  });
});

describe('sail there for me (the autopilot)', () => {
  function run(course: Course, b: ReturnType<typeof newBoat>, seconds: number) {
    let inNoGo = 0;
    let steps = 0;
    let arrived = false;
    for (let t = 0; t < seconds && !arrived; t += 1 / 30) {
      const ap = autopilot(b, steady, course);
      b.sailSet = ap.sailSet;
      stepBoat(b, steady, { steer: ap.steer, attended: true }, deep, 1 / 30);
      steps++;
      if (Math.abs(windAngle(b, steady)) < SAILING.noGo) inNoGo++;
      if (ap.arrived) arrived = true;
    }
    return { arrived, noGoShare: inNoGo / steps };
  }

  it('gets to a mark downwind and stops there', () => {
    const b = newBoat(0, 0, Math.PI);
    weighAnchor(b);
    const r = run({ waypoints: [{ x: -300, z: 40 }], tack: 1, name: 'downwind' }, b, 400);
    expect(r.arrived).toBe(true);
    expect(Math.hypot(b.x + 300, b.z - 40)).toBeLessThan(45);
  });

  it('beats to a mark straight upwind by tacking, only crossing the no-go zone to tack', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    const r = run({ waypoints: [{ x: 250, z: 0 }], tack: 1, name: 'upwind' }, b, 900);
    expect(r.arrived).toBe(true);
    // Only the moments of turning through the wind (tacks, and heading up to stop at the end) are spent in the no-go zone.
    expect(r.noGoShare).toBeLessThan(0.15);
  });

  it('passes its waypoints in order', () => {
    const b = newBoat(0, 0, Math.PI);
    weighAnchor(b);
    const course: Course = { waypoints: [{ x: -80, z: -80 }, { x: -200, z: -60 }], tack: 1, name: 'dogleg' };
    let passedFirst = false;
    for (let t = 0; t < 500; t += 1 / 30) {
      const ap = autopilot(b, steady, course);
      b.sailSet = ap.sailSet;
      stepBoat(b, steady, { steer: ap.steer, attended: true }, deep, 1 / 30);
      if (Math.hypot(b.x + 80, b.z + 80) < 25) passedFirst = true;
      if (ap.arrived) break;
    }
    expect(passedFirst).toBe(true);
    expect(Math.hypot(b.x + 200, b.z + 60)).toBeLessThan(45);
  });
});
