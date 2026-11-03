import { describe, expect, it } from 'vitest';
import { SAILING } from '../src/game/sailing';
import { OPEN_FULL, SEA_CENTRE, SHELTERS, SQUALLS, newWeather, openness, squallsAt, weatherAt, windWord, type Squall } from '../src/game/weather';
import { WorldTerrain } from '../src/world/world';

describe('the open sea', () => {
  const world = new WorldTerrain();

  it('is sheltered at both anchorages and between the two cays', () => {
    expect(openness(world.home.anchorage.x, world.home.anchorage.z)).toBe(0);
    expect(openness(world.pink.anchorage.x, world.pink.anchorage.z)).toBe(0);
    const mid = { x: (SHELTERS[0].x + SHELTERS[1].x) / 2, z: (SHELTERS[0].z + SHELTERS[1].z) / 2 };
    expect(openness(mid.x, mid.z)).toBeLessThan(0.05);
  });

  it('opens up well beyond the reefs, in every direction', () => {
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      const x = SEA_CENTRE.x + Math.cos(th) * 950;
      const z = SEA_CENTRE.z + Math.sin(th) * 950;
      expect(openness(x, z)).toBeGreaterThan(0.6);
    }
    expect(openness(SHELTERS[0].x + SHELTERS[0].r + OPEN_FULL + 10, SHELTERS[0].z)).toBe(1);
  });

  it('the wind out there is about half as strong again', () => {
    const none: Squall[] = [];
    for (const t of [10, 300, 1234]) {
      const home = weatherAt(t, 2, -31, newWeather(), none);
      const open = weatherAt(t, 900, -140, newWeather(), none);
      expect(open.speed / home.speed).toBeGreaterThan(1.45);
      expect(open.speed / home.speed).toBeLessThan(1.8);
      expect(home.rain).toBe(0);
    }
  });
});

describe('squalls', () => {
  it('come and go: never more than four, always the same at the same time', () => {
    let max = 0;
    let seen = 0;
    for (let t = 0; t < 7200; t += 37) {
      const s = squallsAt(t);
      max = Math.max(max, s.length);
      seen += s.length > 0 ? 1 : 0;
      expect(squallsAt(t)).toEqual(s);
    }
    expect(max).toBeLessThanOrEqual(4);
    expect(seen).toBeGreaterThan(150); // there is nearly always one somewhere to sail to
  });

  it('drift west with the trade wind, growing and then fading', () => {
    const a = squallsAt(1000);
    const b = squallsAt(1060);
    for (const s of a) {
      const later = b.find((q) => q.id === s.id);
      if (later) expect(later.x).toBeCloseTo(s.x - SQUALLS.drift * 60, 0);
    }
    // One squall over its life: strength rises from nothing, peaks, and fades away.
    const id = squallsAt(5000)[0].id;
    const life: number[] = [];
    for (let t = 4000; t < 6400; t += 10) life.push(squallsAt(t).find((q) => q.id === id)?.strength ?? 0);
    expect(life[0]).toBe(0);
    expect(Math.max(...life)).toBeGreaterThan(0.5);
    expect(life[life.length - 1]).toBe(0);
  });

  it('under a squall on the open sea: strong wind, rain, and the wind shifts as you pass through', () => {
    const s: Squall = { id: 1, x: 800, z: -140, radius: 180, strength: 1, vx: -6, vz: 0 };
    const list = [s];
    const clear = weatherAt(100, 800, -140, newWeather(), []);
    const heart = weatherAt(100, 800, -140, newWeather(), list);
    expect(heart.rain).toBeGreaterThan(0.9);
    expect(heart.speed - clear.speed).toBeGreaterThan(3.5);
    expect(heart.speed * 1.944).toBeGreaterThan(24); // a strong breeze, gusting toward a near gale
    const north = weatherAt(100, 800, -140 + 120, newWeather(), list);
    const south = weatherAt(100, 800, -140 - 120, newWeather(), list);
    // Wind blows out of the squall: from one side of the trade wind on one side, the other on the other.
    expect(Math.abs(north.from - south.from)).toBeGreaterThan(0.25);
    expect(north.rain).toBeGreaterThan(0.2);
    const outside = weatherAt(100, 800, -140 + 400, newWeather(), list);
    expect(outside.rain).toBe(0);
    expect(outside.squall).toBe(0);
  });

  it('is much milder inside the reef', () => {
    const at = (x: number, z: number) => {
      const s: Squall = { id: 1, x, z, radius: 180, strength: 1, vx: -6, vz: 0 };
      return weatherAt(100, x, z, newWeather(), [s]).speed - weatherAt(100, x, z, newWeather(), []).speed;
    };
    expect(at(2, -31)).toBeLessThan(at(900, -140) * 0.6);
  });

  it('names the wind in plain words', () => {
    expect(windWord(SAILING.windSpeed * 1.944)).toBe('moderate breeze');
    expect(windWord(19)).toBe('fresh breeze');
    expect(windWord(26)).toBe('strong breeze');
  });
});
