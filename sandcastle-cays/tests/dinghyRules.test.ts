import { describe, expect, it } from 'vitest';
import { DINGHY, dentFactor, endOf, idleDinghy, motorRunning, newDinghy, restoreDinghy, startMotor, stepDinghy, stopMotor, towDinghy, towPoint, type DinghySea, type DinghyState } from '../src/game/dinghy';

const sea = (depthAt: (x: number, z: number) => number = () => 5, condition = 100): DinghySea => ({ depthAt, windX: 0, windZ: 0, condition });

function afloat(): DinghyState {
  const d = newDinghy();
  d.where = 'water';
  d.tied = false;
  return d;
}

function go(d: DinghyState, s: DinghySea, seconds: number, ahead: number, steer = 0) {
  const evs = [];
  for (let t = 0; t < seconds; t += 1 / 30) evs.push(stepDinghy(d, { ahead, steer }, s, 1 / 30));
  return evs;
}

describe('the dinghy', () => {
  it('rows at a walking pace, with a surge each stroke', () => {
    const d = afloat();
    const evs = go(d, sea(), 20, 1);
    expect(d.speed).toBeGreaterThan(DINGHY.rowSpeed * 0.8);
    expect(d.speed).toBeLessThan(DINGHY.rowSpeed * 1.2);
    expect(d.x).toBeGreaterThan(15);
    expect(evs.filter((e) => e.stroke).length).toBeGreaterThan(8);
  });

  it('the outboard is about three times as fast as rowing', () => {
    const d = afloat();
    expect(startMotor(d, sea())).toBeNull();
    const evs = go(d, sea(), 15, 1);
    expect(evs.some((e) => e.motorStarted)).toBe(true);
    expect(motorRunning(d)).toBe(true);
    expect(d.speed).toBeGreaterThan(DINGHY.motorSpeed * 0.9);
    expect(DINGHY.motorSpeed / DINGHY.rowSpeed).toBeGreaterThan(2.5);
  });

  it('rowing can spin it round on the spot', () => {
    const d = afloat();
    go(d, sea(), 3, 0, 1);
    expect(d.heading).toBeGreaterThan(1.5);
    expect(Math.hypot(d.x, d.z)).toBeLessThan(0.5);
  });

  it('runs up on the sand and stops, and can always back off', () => {
    // Deep to the west, a beach from x = 20.
    const depth = (x: number) => (x < 20 ? 3 : -0.2);
    const d = afloat();
    const evs = go(d, sea(depth), 40, 1);
    expect(evs.some((e) => e.beached)).toBe(true);
    expect(d.aground).toBe(true);
    expect(endOf(d, 1).x).toBeLessThan(20.2);
    expect(d.speed).toBe(0);
    const evs2 = go(d, sea(depth), 6, -1);
    expect(evs2.some((e) => e.floated)).toBe(true);
    expect(d.aground).toBe(false);
  });

  it('floats over shallows the catamaran never could', () => {
    const d = afloat();
    go(d, sea(() => 0.4), 10, 1);
    expect(d.x).toBeGreaterThan(8);
    expect(d.aground).toBe(false);
  });

  it('the outboard won’t start in the shallows, and tilts up when it gets too shallow', () => {
    const d = afloat();
    expect(startMotor(d, sea(() => 0.3))).toMatch(/shallow/i);
    const depth = (x: number) => (x < 15 ? 2 : 0.35);
    expect(startMotor(d, sea(depth))).toBeNull();
    const evs = go(d, sea(depth), 20, 1);
    expect(evs.some((e) => e.motorUp)).toBe(true);
    expect(d.motor).toBe(false);
    // You can still row on over the flats.
    const x0 = d.x;
    go(d, sea(depth), 10, 1);
    expect(d.x).toBeGreaterThan(x0 + 5);
  });

  it('dents slow it down', () => {
    expect(dentFactor(100)).toBe(1);
    expect(dentFactor(0)).toBeCloseTo(1 - DINGHY.dentSlow);
    const a = afloat();
    const b = afloat();
    go(a, sea(() => 5, 100), 15, 1);
    go(b, sea(() => 5, 0), 15, 1);
    expect(b.x).toBeLessThan(a.x * 0.8);
  });

  it('towed, it follows the big boat on its painter', () => {
    const d = afloat();
    d.tied = true;
    d.x = -8;
    const boat = { x: 0, z: 0, heading: 0 };
    for (let t = 0; t < 60; t += 1 / 30) {
      boat.x += 3 * (1 / 30);
      towDinghy(d, towPoint(boat, -6), sea(), 1 / 30);
    }
    const tp = towPoint(boat, -6);
    expect(Math.hypot(d.x - tp.x, d.z - tp.z)).toBeLessThanOrEqual(DINGHY.painter + 1e-6);
    expect(d.x).toBeLessThan(tp.x);
    expect(Math.abs(Math.atan2(Math.sin(d.heading), Math.cos(d.heading)))).toBeLessThan(0.1);
  });

  it('left alone it stays put', () => {
    const d = afloat();
    d.speed = 1;
    for (let t = 0; t < 30; t += 1 / 30) idleDinghy(d, sea(), 1 / 30);
    expect(d.speed).toBeLessThan(0.01);
    expect(d.x).toBeLessThan(2);
  });

  it('saves where it is, and loads anything odd as stowed', () => {
    const d = restoreDinghy({ where: 'water', x: 3, z: 4, heading: 1, tied: false });
    expect(d.where).toBe('water');
    expect(d.x).toBe(3);
    expect(d.tied).toBe(false);
    expect(restoreDinghy('nonsense').where).toBe('davits');
    stopMotor(d);
    expect(d.motor).toBe(false);
  });
});
