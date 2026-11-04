import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/engine/noise';
import { SHARKS, SHARK_INFO, finUp, newSharks, riskAt, stepSharks, zoneAt, type Shark, type SharkEvent, type SharkWorld, type SharkZone, type YouHow } from '../src/game/sharks';
import { WorldTerrain } from '../src/world/world';
import { BANK } from '../src/world/sharkBank';

const deep = (_x: number, _z: number): number => -16;

const ZONES: SharkZone[] = [
  { id: 'gap', name: 'the reef gap', x: 0, z: 0, r: 50, kind: 'reef', count: 1, risk: 1 },
  { id: 'buoy', name: 'the sea buoy', x: 1000, z: 0, r: 150, kind: 'reef', count: 2, risk: 2 },
  { id: 'bank', name: 'Shark Bank', x: -1000, z: 0, r: 90, kind: 'nurse', count: 6, risk: 3 },
];

function world(you: { x: number; z: number; how: YouHow }, floorAt: (x: number, z: number) => number = deep): SharkWorld {
  return { floorAt, you, bait: [] };
}

function run(sharks: Shark[], w: SharkWorld, seconds: number, rand: () => number, each?: (t: number) => void): SharkEvent[] {
  const all: SharkEvent[] = [];
  for (let t = 0; t < seconds; t += 0.1) {
    each?.(t);
    for (const b of w.bait) b.age += 0.1;
    all.push(...stepSharks(sharks, ZONES, w, 0.1, rand));
  }
  return all;
}

describe('shark waters', () => {
  it('puts the right sharks in each zone', () => {
    const r = mulberry32(1);
    const s = newSharks(ZONES, world({ x: 0, z: 0, how: 'safe' }), r);
    expect(s.filter((x) => x.zone === 'gap')).toHaveLength(1);
    expect(s.filter((x) => x.zone === 'buoy')).toHaveLength(2);
    expect(s.filter((x) => x.zone === 'bank')).toHaveLength(6);
    expect(s.filter((x) => x.zone === 'bank').every((x) => x.kind === 'nurse')).toBe(true);
    for (const sh of s) {
      const z = ZONES.find((zz) => zz.id === sh.zone)!;
      expect(Math.hypot(sh.x - z.x, sh.z - z.z)).toBeLessThanOrEqual(z.r);
    }
  });

  it('says which zone you are in, and how risky it is', () => {
    expect(zoneAt(ZONES, 10, 10)?.id).toBe('gap');
    expect(riskAt(ZONES, -1000, 50)).toBe(3);
    expect(riskAt(ZONES, 500, 500)).toBe(0);
  });

  it('sharks keep to their own water when nobody is about', () => {
    const r = mulberry32(2);
    const w = world({ x: 5000, z: 5000, how: 'safe' });
    const s = newSharks(ZONES, w, r);
    let worst = 0;
    run(s, w, 600, r, () => {
      for (const sh of s) {
        const z = ZONES.find((zz) => zz.id === sh.zone)!;
        worst = Math.max(worst, Math.hypot(sh.x - z.x, sh.z - z.z) - z.r);
      }
    });
    expect(worst).toBeLessThan(15);
  });

  it('never bump you while you are aboard the big boat', () => {
    const r = mulberry32(3);
    const w = world({ x: 0, z: 0, how: 'safe' });
    const s = newSharks(ZONES, w, r);
    const ev = run(s, w, 900, r);
    expect(ev.filter((e) => e.type === 'bump' || e.type === 'circling')).toHaveLength(0);
  });

  it('a reef shark comes to look at a swimmer, circles, and sometimes bumps', () => {
    let circles = 0;
    let bumps = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = mulberry32(seed * 31);
      const w = world({ x: 5, z: 0, how: 'swim' });
      const s = newSharks(ZONES.filter((z) => z.id === 'gap'), w, r);
      s[0].x = 15;
      s[0].z = 0;
      s[0].cool = 0;
      const ev = run(s, w, 240, r);
      circles += ev.filter((e) => e.type === 'circling').length;
      bumps += ev.filter((e) => e.type === 'bump').length;
    }
    expect(circles).toBeGreaterThan(10);
    expect(bumps).toBeGreaterThan(0);
    // Not every look ends in a bump.
    expect(bumps).toBeLessThan(circles);
  });

  it('after a bump it swims away and leaves you be for a while', () => {
    const r = mulberry32(5);
    const w = world({ x: 5, z: 0, how: 'dinghy' });
    const s = newSharks(ZONES.filter((z) => z.id === 'gap'), w, r);
    const sh = s[0];
    sh.x = 8;
    sh.mood = 'bump';
    sh.t = 0;
    sh.until = 8;
    let bumped = -1;
    let again = -1;
    run(s, w, 60, r, (t) => {
      const ev = stepSharks(s, ZONES, w, 0, r);
      void ev;
      if (bumped < 0 && sh.mood === 'leave') bumped = t;
      else if (bumped >= 0 && again < 0 && sh.mood === 'bump') again = t;
    });
    expect(bumped).toBeGreaterThanOrEqual(0);
    expect(again).toBe(-1);
    expect(sh.cool).toBeGreaterThan(0);
  });

  it('bait draws sharks away from you', () => {
    const r = mulberry32(7);
    const w = world({ x: 5, z: 0, how: 'swim' });
    const s = newSharks(ZONES.filter((z) => z.id === 'gap'), w, r);
    const sh = s[0];
    sh.x = 9;
    sh.mood = 'curious';
    sh.until = 60;
    w.bait.push({ x: -20, z: 10, age: 0 });
    const ev = run(s, w, 25, r);
    expect(ev.some((e) => e.type === 'baited')).toBe(true);
    expect(ev.some((e) => e.type === 'bump')).toBe(false);
    expect(Math.hypot(sh.x + 20, sh.z - 10)).toBeLessThan(6);
  });

  it('walking up to a resting nurse shark startles it', () => {
    const r = mulberry32(9);
    const flats = (x: number, z: number) => (Math.hypot(x + 1000, z) < 200 ? -1 : -16);
    const w = world({ x: -1000, z: 0, how: 'wade' }, flats);
    const s = newSharks(ZONES.filter((z) => z.id === 'bank'), w, r);
    const sh = s[0];
    sh.mood = 'rest';
    sh.until = 999;
    sh.x = -1000.8;
    sh.z = 0;
    const ev = stepSharks(s, ZONES, w, 0.1, r);
    expect(ev.some((e) => e.type === 'startled' && e.shark === sh)).toBe(true);
    expect(sh.mood).toBe('leave');
  });

  it('nurse sharks rest on the sand much of the time, and swim slowly', () => {
    const r = mulberry32(11);
    const flats = (x: number, z: number) => (Math.hypot(x + 1000, z) < 200 ? -1.2 : -16);
    const w = world({ x: 5000, z: 0, how: 'safe' }, flats);
    const s = newSharks(ZONES.filter((z) => z.id === 'bank'), w, r);
    let resting = 0;
    let n = 0;
    let fastest = 0;
    run(s, w, 600, r, () => {
      for (const sh of s) {
        n++;
        if (sh.mood === 'rest') resting++;
        fastest = Math.max(fastest, sh.speed);
        // Never below the sand, never out of the water.
        expect(sh.y).toBeGreaterThan(flats(sh.x, sh.z));
        expect(sh.y).toBeLessThan(0);
      }
    });
    expect(resting / n).toBeGreaterThan(0.4);
    expect(fastest).toBeLessThanOrEqual(SHARK_INFO.nurse.fast + 1e-6);
  });

  it('reef sharks keep off the shallows', () => {
    const r = mulberry32(13);
    // Half the zone is a 1 m sand flat.
    const floor = (x: number) => (x > 10 ? -1 : -10);
    const w = world({ x: 5000, z: 0, how: 'safe' }, floor);
    const s = newSharks(ZONES.filter((z) => z.id === 'gap'), w, r);
    run(s, w, 600, r, () => {
      for (const sh of s) expect(floor(sh.x)).toBeLessThanOrEqual(-SHARK_INFO.reef.minDepth);
    });
  });

  it('a circling reef shark shows its fin', () => {
    const r = mulberry32(17);
    const w = world({ x: 5, z: 0, how: 'swim' });
    const s = newSharks(ZONES.filter((z) => z.id === 'gap'), w, r);
    s[0].mood = 'curious';
    s[0].until = 60;
    s[0].x = 12;
    run(s, w, 15, r);
    expect(finUp(s[0])).toBe(true);
  });

  it('the cooldown is shorter in riskier water', () => {
    expect(SHARKS.bumpChance[3]).toBeGreaterThan(SHARKS.bumpChance[1]);
  });

  it('Shark Bank: a dry bar, knee-deep flats round it, too shallow for the catamaran, deep water at the anchorage', () => {
    const w = new WorldTerrain();
    expect(w.heightAt(BANK.x, BANK.z)).toBeGreaterThan(0.1);
    // 30 m off the bar: wading depth.
    const flat = w.heightAt(BANK.x, BANK.z + 30);
    expect(flat).toBeLessThan(-0.3);
    expect(flat).toBeGreaterThan(-1.25);
    const a = w.bank.anchorage;
    expect(w.heightAt(a.x, a.z)).toBeLessThan(-3);
    expect(w.bank.tideline(0.6).length).toBeGreaterThan(40);
    expect(w.islandAt(BANK.x, BANK.z).id).toBe('bank');
    // Nurse sharks have room: plenty of flats deep enough for them.
    let ok = 0;
    for (let i = 0; i < 400; i++) {
      const a2 = (i / 400) * Math.PI * 2;
      const d = -w.heightAt(BANK.x + Math.cos(a2) * 40, BANK.z + Math.sin(a2) * 40);
      if (d >= SHARK_INFO.nurse.minDepth) ok++;
    }
    expect(ok).toBeGreaterThan(300);
  });
});
