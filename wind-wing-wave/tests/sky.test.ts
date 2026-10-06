/** Sky, light and weather rules (WP-G): pure functions only, no WebGL. */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { StormState } from '../src/engine/protocol';
import {
  GOLDEN,
  NOON,
  START_PHASE,
  SUNRISE,
  SUNSET,
  applyMood,
  dayLookAt,
  dryMood,
  makeDayLook,
  moonDirection,
  moonPhase,
  moonShare,
  seasonOf,
  sunDirection,
  type DayLook,
} from '../src/render/daylight';
import { assignCaps, type CapSlot } from '../src/render/sky';
import { CALM_WIND, boltAt, flashAt, gustAt, makeStormCurve, nextStrikeDelay, rainbowAt, stormCurve, windVeer } from '../src/render/weather';

const COLORS = ['zenith', 'horizon', 'fog', 'sun', 'hemiSky', 'hemiGround', 'glow'] as const;
const NUMBERS = ['sunI', 'hemiI', 'glowI', 'night', 'stars'] as const;

/** Biggest change of any colour channel or number between two looks. */
function lookDelta(a: DayLook, b: DayLook): number {
  let d = 0;
  for (const c of COLORS) d = Math.max(d, Math.abs(a[c].r - b[c].r), Math.abs(a[c].g - b[c].g), Math.abs(a[c].b - b[c].b));
  for (const n of NUMBERS) d = Math.max(d, Math.abs(a[n] - b[n]) / 3);
  return d;
}

const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('day colours', () => {
  it('change smoothly through the whole day, with no jumps (including midnight to dawn)', () => {
    const a = makeDayLook();
    const b = makeDayLook();
    let worst = 0;
    const steps = 20000;
    dayLookAt(0, a);
    for (let i = 1; i <= steps; i++) {
      dayLookAt(i / steps, b);
      worst = Math.max(worst, lookDelta(a, b));
      dayLookAt(i / steps, a);
    }
    expect(worst).toBeLessThan(0.006);
  });

  it('stay smooth with the season, the warning amber and the storm grey on top', () => {
    const a = makeDayLook();
    const b = makeDayLook();
    let worst = 0;
    for (const phase of [0.02, NOON, GOLDEN, 0.72, 0.9]) {
      for (let i = 0; i < 200; i++) {
        const k0 = i / 200;
        const k1 = (i + 1) / 200;
        applyMood(dayLookAt(phase, a), k0, k0, k0);
        applyMood(dayLookAt(phase, b), k1, k1, k1);
        worst = Math.max(worst, lookDelta(a, b));
      }
    }
    expect(worst).toBeLessThan(0.02);
  });

  it('is bright at noon, warm at golden hour and dark but readable at night', () => {
    const noon = dayLookAt(NOON, makeDayLook());
    const golden = dayLookAt(GOLDEN, makeDayLook());
    const night = dayLookAt(0.875, makeDayLook());
    expect(noon.sunI).toBeGreaterThan(2.5);
    expect(noon.night).toBe(0);
    expect(golden.sun.r).toBeGreaterThan(golden.sun.b * 1.5);
    expect(night.night).toBe(1);
    expect(night.stars).toBe(1);
    // Night is dim but never black: the fill light still shows the island.
    expect(luminance(night.hemiSky) * night.hemiI).toBeGreaterThan(0.1);
  });

  it('storms darken the day and never brighten the night', () => {
    for (const phase of [NOON, 0.875, 0.02]) {
      const clear = applyMood(dayLookAt(phase, makeDayLook()), 0, 0, 0);
      const storm = applyMood(dayLookAt(phase, makeDayLook()), 0, 0, 1);
      expect(storm.sunI).toBeLessThan(clear.sunI);
      for (const c of ['zenith', 'fog', 'hemiSky'] as const) {
        if (clear.night > 0.9) expect(luminance(storm[c])).toBeLessThanOrEqual(luminance(clear[c]) + 1e-6);
      }
      expect(storm.stars).toBe(0);
    }
  });
});

describe('sun, moon and seasons', () => {
  it('the sun rises in the east, is high at noon, sets in the west and is down at night', () => {
    const v = new THREE.Vector3();
    expect(sunDirection(SUNRISE + 0.01, v).x).toBeGreaterThan(0.9);
    expect(sunDirection(NOON, v).y).toBeGreaterThan(0.9);
    expect(sunDirection(SUNSET - 0.01, v).x).toBeLessThan(-0.9);
    expect(sunDirection(0.875, v).y).toBeLessThan(-0.5);
    expect(sunDirection(START_PHASE, v).y).toBeGreaterThan(0.4);
  });

  it('sun and moon move smoothly (no jumps anywhere in the day)', () => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (const dir of [sunDirection, moonDirection]) {
      let worst = 0;
      dir(0, a);
      for (let i = 1; i <= 5000; i++) {
        dir(i / 5000, b);
        worst = Math.max(worst, a.distanceTo(b));
        a.copy(b);
      }
      expect(worst).toBeLessThan(0.01);
    }
  });

  it('the moon is up at night, and the light hands over from sun to moon smoothly', () => {
    const v = new THREE.Vector3();
    expect(moonDirection(0.875, v).y).toBeGreaterThan(0.5);
    expect(moonDirection(NOON, v).y).toBeLessThan(0);
    expect(moonShare(NOON)).toBe(0);
    expect(moonShare(0.875)).toBe(1);
    let worst = 0;
    for (let i = 1; i <= 10000; i++) worst = Math.max(worst, Math.abs(moonShare(i / 10000) - moonShare((i - 1) / 10000)));
    expect(worst).toBeLessThan(0.01);
  });

  it('the moon is full every 4th night and new two nights before', () => {
    for (const night of [3, 7, 11]) expect(moonPhase(night + 0.875)).toBeCloseTo(0.5, 5);
    expect(moonPhase(1.875)).toBeCloseTo(0, 5);
  });

  it('seasons alternate each day, and the dry mood changes gently around dawn', () => {
    expect(seasonOf(0)).toBe('wet');
    expect(seasonOf(1)).toBe('dry');
    expect(seasonOf(2)).toBe('wet');
    expect(dryMood(0.5)).toBe(0);
    expect(dryMood(1.5)).toBe(1);
    let worst = 0;
    for (let i = 1; i <= 40000; i++) worst = Math.max(worst, Math.abs(dryMood(i / 10000) - dryMood((i - 1) / 10000)));
    expect(worst).toBeLessThan(0.002);
  });
});

describe('storms', () => {
  const at = (phase: StormState['phase'], t: number, level: number) => stormCurve({ phase, t, level }, makeStormCurve());

  it('the warning only builds: wind, gloom, swell and rain never go back down', () => {
    let prev = at('warning', 0, 0);
    for (let t = 0.5; t <= 40; t += 0.5) {
      const c = at('warning', t, (0.6 * t) / 40);
      for (const k of ['storm', 'gloom', 'wind', 'rain'] as const) expect(c[k]).toBeGreaterThanOrEqual(prev[k] - 1e-9);
      prev = c;
    }
    expect(at('warning', 5, 0.08).amber).toBeGreaterThan(0.5);
  });

  it('the peak is full storm with lightning; the clearing only eases', () => {
    const p = at('peak', 30, 1);
    expect(p.storm).toBe(1);
    expect(p.gloom).toBe(1);
    expect(p.rain).toBe(1);
    expect(p.lightning).toBe(true);
    let prev = at('clearing', 0, 1);
    for (let t = 0.5; t <= 30; t += 0.5) {
      const c = at('clearing', t, 1 - t / 30);
      for (const k of ['storm', 'gloom', 'wind', 'rain'] as const) expect(c[k]).toBeLessThanOrEqual(prev[k] + 1e-9);
      expect(c.lightning).toBe(false);
      prev = c;
    }
    expect(at('clearing', 30, 0).wind).toBeCloseTo(CALM_WIND, 6);
  });

  it('the phases meet without jumps', () => {
    const pairs: [ReturnType<typeof at>, ReturnType<typeof at>][] = [
      [at('none', 0, 0), at('warning', 0, 0)],
      [at('warning', 40, 0.6), at('peak', 0, 1)],
      [at('peak', 60, 1), at('clearing', 0, 1)],
      [at('clearing', 30, 0), at('none', 0, 0)],
    ];
    for (const [a, b] of pairs) for (const k of ['storm', 'gloom', 'wind', 'rain'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.01);
  });

  it('the rainbow fades in after the rain, holds, then fades', () => {
    expect(rainbowAt(0)).toBe(0);
    for (let t = 12; t <= 40; t += 2) expect(rainbowAt(t)).toBeGreaterThan(0.99);
    expect(rainbowAt(60)).toBe(0);
  });

  it('lightning is photosensitivity-safe: at least 6 s apart, small and brief sky flashes', () => {
    for (let i = 0; i <= 10; i++) expect(nextStrikeDelay(() => i / 10)).toBeGreaterThanOrEqual(6);
    let peak = 0;
    for (let t = -0.1; t < 1; t += 0.001) peak = Math.max(peak, flashAt(t));
    expect(peak).toBeLessThanOrEqual(0.35);
    expect(flashAt(0.45)).toBe(0);
    expect(boltAt(0.25)).toBe(0);
    // "Fewer flashes": the bolt is one soft pulse that only rises then falls.
    let prev = 0;
    let falling = false;
    for (let t = 0; t <= 0.2; t += 0.005) {
      const v = boltAt(t, true);
      expect(v).toBeLessThanOrEqual(0.5);
      if (v < prev - 1e-9) falling = true;
      else if (falling) expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });

  it('gusts and wind veer stay in range', () => {
    for (let t = 0; t < 600; t += 0.37) {
      for (const s of [0, 0.5, 1]) {
        const g = gustAt(t, s);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(1);
        expect(Math.abs(windVeer(t, s))).toBeLessThanOrEqual(0.45 + 1e-9);
      }
    }
  });
});

describe('cap clouds', () => {
  const slots = (): CapSlot[] => Array.from({ length: 3 }, () => ({ x: 0, z: 0, h: 0, tx: 0, tz: 0, th: 0, presence: 0, want: 0 }));

  it('every capped peak gets a cap, the tallest first; uncapped peaks get none', () => {
    const s = slots();
    assignCaps(s, [
      { x: 0, z: 0, h: 70, cap: true },
      { x: 300, z: 0, h: 120, cap: true },
      { x: -300, z: 0, h: 40, cap: false },
    ]);
    const wanted = s.filter((c) => c.want > 0).sort((a, b) => b.th - a.th);
    expect(wanted.length).toBe(2);
    expect(wanted[0].tx).toBe(300);
    expect(wanted[0].want).toBe(1);
  });

  it('a cap stays with its peak as the island changes, and fades when the peak is lost', () => {
    const s = slots();
    assignCaps(s, [{ x: 0, z: 0, h: 90, cap: true }]);
    const slot = s.find((c) => c.want > 0)!;
    slot.presence = 1;
    assignCaps(s, [{ x: 20, z: 10, h: 95, cap: true }]);
    expect(slot.tx).toBe(20);
    expect(slot.want).toBeGreaterThan(0);
    assignCaps(s, []);
    expect(slot.want).toBe(0);
  });
});
