import { describe, expect, it } from 'vitest';
import { SAILING, sailPower, autopilot, boomAngle, drive, dropAnchor, newBoat, pointOfSail, sailFill, stepBoat, weighAnchor, windAngle, windAt, wrap, type Course, type SeaBed, type WindState } from '../src/game/sailing';

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
  it('on a beam reach with full sail she picks up to about 8 knots', () => {
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
      b.throttle = ap.throttle;
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

  it('beats a long way upwind by tacking (sailing, not motoring), then motors the last short stretch', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    const course: Course = { waypoints: [{ x: 420, z: 0 }], tack: 1, name: 'upwind' };
    let tacks = 0;
    let lastTack = course.tack;
    let motorFar = 0;
    let arrived = false;
    for (let t = 0; t < 1200 && !arrived; t += 1 / 30) {
      const ap = autopilot(b, steady, course);
      b.sailSet = ap.sailSet;
      b.throttle = ap.throttle;
      // Far from the mark she sails: the motor only helps out of a stall.
      if (Math.hypot(420 - b.x, b.z) > 200 && ap.throttle > 0) motorFar++;
      stepBoat(b, steady, { steer: ap.steer, attended: true }, deep, 1 / 30);
      if (course.tack !== lastTack) {
        tacks++;
        lastTack = course.tack;
      }
      arrived = ap.arrived;
    }
    expect(arrived).toBe(true);
    expect(tacks).toBeGreaterThan(1);
    expect(motorFar / 30).toBeLessThan(20); // seconds of motor while far off: just the odd stall
  });

  it('passes its waypoints in order', () => {
    const b = newBoat(0, 0, Math.PI);
    weighAnchor(b);
    const course: Course = { waypoints: [{ x: -80, z: -80 }, { x: -200, z: -60 }], tack: 1, name: 'dogleg' };
    let passedFirst = false;
    for (let t = 0; t < 500; t += 1 / 30) {
      const ap = autopilot(b, steady, course);
      b.sailSet = ap.sailSet;
      b.throttle = ap.throttle;
      stepBoat(b, steady, { steer: ap.steer, attended: true }, deep, 1 / 30);
      if (Math.hypot(b.x + 80, b.z + 80) < 25) passedFirst = true;
      if (ap.arrived) break;
    }
    expect(passedFirst).toBe(true);
    expect(Math.hypot(b.x + 200, b.z + 60)).toBeLessThan(45);
  });
});

describe('the outboard', () => {
  it('with the sails down, full ahead motors her at about 5 knots, even straight into the wind', () => {
    const b = newBoat(0, 0, 0); // bow straight into the east wind: in irons for sails
    weighAnchor(b);
    b.throttle = 1;
    sail(b, 20);
    expect(b.speed).toBeGreaterThan(SAILING.motorAhead * 0.9);
    expect(b.x).toBeGreaterThan(25);
  });

  it('under motor you can steer even when slow', () => {
    const b = newBoat(0, 0, 0);
    weighAnchor(b);
    b.throttle = 0.3;
    sail(b, 1.5);
    const h0 = b.heading;
    sail(b, 3, 1);
    expect(Math.abs(wrap(b.heading - h0))).toBeGreaterThan(25 * DEG);
  });

  it('astern she goes backwards, and the bow swings the opposite way to ahead', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    b.throttle = -1;
    sail(b, 10);
    expect(b.speed).toBeLessThan(-0.8);
    expect(b.z).toBeLessThan(-3); // moved backwards (heading +z)
    const h0 = b.heading;
    sail(b, 2, 1);
    expect(wrap(b.heading - h0)).toBeLessThan(0);
  });

  it('astern gets her off when she has run aground', () => {
    const bar: SeaBed = { floorAt: (_x, z) => (z > 60 && z < 80 ? -0.6 : -6) };
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    b.sailSet = 1;
    sail(b, 40, 0, bar);
    expect(b.aground).toBe(true);
    b.sailSet = 0;
    b.throttle = -1;
    const evs = sail(b, 12, 0, bar);
    expect(evs.some((e) => e.floated)).toBe(true);
    expect(b.aground).toBe(false);
    expect(b.z).toBeLessThan(52);
  });

  it('dropping the anchor stops the motor', () => {
    const b = newBoat(0, 0, 0);
    weighAnchor(b);
    b.throttle = 0.4;
    sail(b, 2);
    b.throttle = 0;
    sail(b, 6);
    expect(dropAnchor(b, deep)).toBeNull();
    expect(b.throttle).toBe(0);
  });

  it('the autopilot motors a short way upwind instead of tacking, and anchors close to the spot', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    const course: Course = { waypoints: [{ x: 130, z: 0 }], tack: 1, name: 'short upwind' };
    let usedMotor = false;
    let arrived = false;
    for (let t = 0; t < 300 && !arrived; t += 1 / 30) {
      const ap = autopilot(b, steady, course);
      b.sailSet = ap.sailSet;
      b.throttle = ap.throttle;
      if (ap.throttle > 0) usedMotor = true;
      stepBoat(b, steady, { steer: ap.steer, attended: true }, deep, 1 / 30);
      arrived = ap.arrived;
    }
    expect(usedMotor).toBe(true);
    expect(arrived).toBe(true);
    expect(Math.hypot(b.x - 130, b.z)).toBeLessThan(20);
  });
});

describe('a stronger motor, faster sails (v0.4)', () => {
  it('the motor gets her moving quickly: most of its speed within 4 seconds', () => {
    const b = newBoat(0, 0, 0);
    weighAnchor(b);
    b.throttle = 1;
    sail(b, 4);
    expect(b.speed).toBeGreaterThan(SAILING.motorAhead * 0.7);
    expect(SAILING.motorAhead * 1.944).toBeGreaterThan(4.8); // about 5 knots
  });

  it('sailing on a reach is much faster than motoring', () => {
    const s = newBoat(0, 0, 90 * DEG);
    weighAnchor(s);
    s.sailSet = 1;
    sail(s, 40);
    const m = newBoat(0, 0, 90 * DEG);
    weighAnchor(m);
    m.throttle = 1;
    sail(m, 40);
    expect(s.speed).toBeGreaterThan(m.speed * 1.5);
  });

  it('more wind always helps a little, but less and less', () => {
    expect(sailPower(1)).toBeCloseTo(1, 5);
    expect(sailPower(1.5)).toBeGreaterThan(sailPower(1));
    expect(sailPower(2) - sailPower(1.5)).toBeLessThan(sailPower(1.5) - sailPower(1));
    expect(sailPower(0.5)).toBeGreaterThan(0.5);
  });
});

describe('strong wind', () => {
  const strong: WindState = { from: 0, speed: 13, gust: 0 }; // about 25 knots, a squall

  it('full sail in a squall: she leans hard, is overpowered and tries to turn up into the wind', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    b.sailSet = 1;
    b.sail = 1;
    b.speed = 3;
    let maxHeel = 0;
    const evs = [];
    for (let t = 0; t < 20; t += 1 / 30) {
      evs.push(stepBoat(b, strong, { steer: 0, attended: true }, deep, 1 / 30));
      maxHeel = Math.max(maxHeel, Math.abs(b.heel));
    }
    expect(evs.some((e) => e.over > 0.1)).toBe(true);
    expect(maxHeel).toBeGreaterThan(SAILING.overHeel + 0.1);
    // She has turned toward the wind (from the beam, 90°, toward the no-go zone).
    expect(Math.abs(windAngle(b, strong))).toBeLessThan(70 * DEG);
  });

  it('half sail in the same wind: she stays under control and goes faster', () => {
    const run = (sailSet: number) => {
      const b = newBoat(0, 0, 90 * DEG);
      weighAnchor(b);
      b.sailSet = sailSet;
      b.sail = sailSet;
      b.speed = 3;
      let speedSum = 0;
      let n = 0;
      for (let t = 0; t < 40; t += 1 / 30) {
        // Steer to hold the beam reach, as a sailor would.
        const err = wrap(90 * DEG - b.heading);
        stepBoat(b, strong, { steer: Math.max(-1, Math.min(1, err * 3)), attended: true }, deep, 1 / 30);
        if (t > 15) {
          speedSum += b.speed;
          n++;
        }
      }
      return { speed: speedSum / n, heel: Math.abs(b.heel), heading: b.heading };
    };
    const full = run(1);
    const half = run(0.5);
    expect(half.heel).toBeLessThan(SAILING.overHeel);
    expect(half.speed).toBeGreaterThan(full.speed);
    expect(Math.abs(wrap(half.heading - 90 * DEG))).toBeLessThan(8 * DEG);
  });

  it('surfing: running fast down the face of a wave sends her well past her usual top speed', () => {
    const b = newBoat(0, 0, 150 * DEG); // broad reach, wind from the east over the starboard quarter
    weighAnchor(b);
    b.sailSet = 1;
    b.sail = 1;
    b.speed = 4;
    let top = 0;
    let surfed = 0;
    for (let t = 0; t < 8; t += 1 / 30) {
      const ev = stepBoat(b, { from: 0, speed: 9, gust: 0 }, { steer: 0, attended: true, slope: 0.07 }, deep, 1 / 30);
      top = Math.max(top, b.speed);
      surfed = Math.max(surfed, ev.surfing);
    }
    expect(surfed).toBeGreaterThan(1.5);
    expect(top * 1.944).toBeGreaterThan(11); // over 11 knots
    // Climbing the back of a wave (uphill) gives nothing extra.
    const ev = stepBoat(b, { from: 0, speed: 9, gust: 0 }, { steer: 0, attended: true, slope: -0.07 }, deep, 1 / 30);
    expect(ev.surfing).toBe(0);
  });

  it('the autopilot reefs (half sail) when the wind is strong', () => {
    const b = newBoat(0, 0, 90 * DEG);
    weighAnchor(b);
    const c: Course = { waypoints: [{ x: 0, z: 2000 }], tack: 1, name: 'far' };
    expect(autopilot(b, steady, c).sailSet).toBe(1);
    expect(autopilot(b, strong, c).sailSet).toBe(0.5);
  });
});

