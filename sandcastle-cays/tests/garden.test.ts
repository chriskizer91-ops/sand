import { describe, expect, it } from 'vitest';
import { CROPS, CROP_KINDS, GARDEN, fillBarrel, growGarden, harvest, newGarden, plant, plot, plotLabel, potCount, restoreGarden, thirst, water } from '../src/game/garden';
import { RECIPES, make, newAboard, restoreAboard } from '../src/game/aboard';

const rand = () => 0.5;
/** Let `days` pass in small steps, watering every morning if asked. */
function days(g: ReturnType<typeof newGarden>, from: number, n: number, waterIds: string[] = [], rain = false): number {
  let now = from;
  const step = 0.05;
  for (let t = 0; t < n; t += step) {
    if (waterIds.length && Math.abs((now % 1) - 0.3) < step / 2) for (const id of waterIds) water(g, id, now);
    growGarden(g, step, now, () => rain);
    now += step;
  }
  return now;
}

describe('the garden', () => {
  it('starts with a seed tin and two pots; planting uses a seed', () => {
    const g = newGarden();
    expect(g.seeds.callaloo).toBeGreaterThan(0);
    expect(g.seeds.tomato).toBeGreaterThan(0);
    expect(g.seeds.sweetpotato).toBeGreaterThan(0);
    expect(potCount(0)).toBe(2);
    expect(potCount(5)).toBe(GARDEN.potsMax);
    const n = g.seeds.tomato;
    expect(plant(g, 'pot0', 'tomato', 1)).toBeNull();
    expect(g.seeds.tomato).toBe(n - 1);
    expect(plant(g, 'pot0', 'callaloo', 1)).toMatch(/already/);
    g.seeds.sweetpotato = 0;
    expect(plant(g, 'bed0', 'sweetpotato', 1)).toMatch(/No sweet potato/);
  });

  it('watered every day, each crop ripens in its time', () => {
    for (const k of CROP_KINDS) {
      const g = newGarden();
      plant(g, 'bed0', k, 1);
      water(g, 'bed0', 1);
      days(g, 1, CROPS[k].days + 0.3, ['bed0']);
      expect(plot(g, 'bed0')!.growth, k).toBe(1);
      expect(plotLabel(g, 'bed0', 9).does).toBe('harvest');
    }
  });

  it('it only grows with water: dry, it droops, then withers after three days', () => {
    const g = newGarden();
    plant(g, 'pot0', 'tomato', 1);
    water(g, 'pot0', 1);
    days(g, 1, 0.5);
    const grew = plot(g, 'pot0')!.growth;
    expect(grew).toBeGreaterThan(0.1);
    days(g, 1.5, 0.8); // watering runs out at day 2
    const stalled = plot(g, 'pot0')!.growth;
    days(g, 2.3, 0.5);
    expect(plot(g, 'pot0')!.growth).toBeCloseTo(stalled, 5); // no water, no growth
    expect(thirst(plot(g, 'pot0')!, 2.8)).toBeGreaterThan(0);
    days(g, 2.8, 2);
    expect(plot(g, 'pot0')).toBeNull(); // withered
  });

  it('rain waters the plants for you', () => {
    const g = newGarden();
    plant(g, 'bed1', 'callaloo', 1);
    days(g, 1, 2.3, [], true);
    expect(plot(g, 'bed1')!.growth).toBe(1);
  });

  it('harvesting gives food and seeds; callaloo grows back, tomatoes are done', () => {
    const g = newGarden();
    plant(g, 'bed0', 'callaloo', 1);
    plant(g, 'bed1', 'tomato', 1);
    g.plots.bed0.growth = 1;
    g.plots.bed1.growth = 1;
    const t0 = g.seeds.tomato;
    const a = harvest(g, 'bed0', rand)!;
    expect(a.food).toBe(CROPS.callaloo.food);
    expect(plot(g, 'bed0')!.growth).toBe(CROPS.callaloo.regrow);
    const b = harvest(g, 'bed1', rand)!;
    expect(b.food).toBe(CROPS.tomato.food);
    expect(g.seeds.tomato).toBeGreaterThan(t0);
    expect(plot(g, 'bed1')).toBeNull();
    expect(harvest(g, 'bed1', rand)).toBeNull();
    expect(g.grown.tomato).toBe(1);
  });

  it('the rain barrel fills in the rain, up to its brim', () => {
    const g = newGarden();
    g.barrel = 0;
    fillBarrel(g, 1, GARDEN.barrelPerRain * 3);
    expect(g.barrel).toBeCloseTo(3, 5);
    fillBarrel(g, 1, 10000);
    expect(g.barrel).toBe(GARDEN.barrelMax);
  });

  it('a garden that grows for a while feeds you: a full garden makes more than a day of food a day', () => {
    // Four beds and four pots of callaloo, watered each day: food per day once it's going.
    const g = newGarden();
    g.seeds.callaloo = 8;
    const ids = ['pot0', 'pot1', 'pot2', 'pot3', 'bed0', 'bed1', 'bed2', 'bed3'];
    for (const id of ids) plant(g, id, 'callaloo', 1);
    let now = 1;
    let food = 0;
    for (let d = 0; d < 10; d++) {
      now = days(g, now, 1, ids);
      for (const id of ids) food += harvest(g, id, rand)?.food ?? 0;
    }
    expect(food / 10).toBeGreaterThan(1);
  });

  it('a save brings the garden back; a broken one starts fresh', () => {
    const g = newGarden();
    plant(g, 'pot1', 'sweetpotato', 2);
    water(g, 'pot1', 2.2);
    g.grown.callaloo = 3;
    expect(restoreGarden(JSON.parse(JSON.stringify(g)))).toEqual(g);
    expect(restoreGarden(42)).toEqual(newGarden());
    expect(restoreGarden({ plots: { pot0: { crop: 'weeds' } } }).plots).toEqual({});
  });

  it('the workbench makes more deck pots, up to four in all', () => {
    const a = newAboard();
    const r = RECIPES.find((x) => x.id === 'planter')!;
    const locker: Record<string, number> = { plank: 3, driftwood: 9 };
    make(r, a, 100, locker);
    make(r, a, 100, locker);
    make(r, a, 100, locker);
    expect(a.made.planter).toBe(2);
    expect(potCount(a.made.planter ?? 0)).toBe(4);
    expect(restoreAboard(JSON.parse(JSON.stringify(a))).made.planter).toBe(2);
  });

  it('every crop has a true-sounding fact and sensible numbers', () => {
    for (const k of CROP_KINDS) {
      const c = CROPS[k];
      expect(c.fact.length).toBeGreaterThan(40);
      expect(c.days).toBeGreaterThan(1);
      expect(c.food).toBeGreaterThan(0);
    }
  });
});
