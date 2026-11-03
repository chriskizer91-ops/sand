import { describe, expect, it } from 'vitest';
import { RECIPES, STORES, UPKEEP, bilgeDrag, catchRain, cookFish, leak, make, newAboard, openCoconut, pumpStroke, recipeKnown, restoreAboard, sailCondition, spoilFish, useStores, vigour, waterMax, wearSails, whyNot } from '../src/game/aboard';
import { FISH, FISHING, FISH_KINDS, cast, fishHere, newFishing, stepFishing, type FishKind } from '../src/game/fishing';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

describe('the stores', () => {
  it('a full larder and tank last about a month; a new game starts with enough for a while', () => {
    const a = newAboard();
    a.food = STORES.foodMax;
    a.water = STORES.waterMax;
    let days = 0;
    while (a.food > 0) {
      useStores(a, 0.1);
      days += 0.1;
    }
    expect(days).toBeGreaterThan(29);
    expect(STORES.waterMax).toBeGreaterThanOrEqual(20);
    expect(newAboard().food).toBeGreaterThanOrEqual(7);
    expect(newAboard().water).toBeGreaterThanOrEqual(5);
  });

  it('you hear when it gets low and when it runs out; running out slows you, it never kills you', () => {
    const a = newAboard();
    a.food = 3.05;
    a.water = 10;
    expect(useStores(a, 0.1).lowFood).toBe(true);
    expect(useStores(a, 0.1).lowFood).toBe(false); // only once
    a.food = 0.05;
    expect(useStores(a, 0.1).outFood).toBe(true);
    expect(vigour(a)).toBe(0.8);
    a.water = 0;
    expect(vigour(a)).toBe(0.65);
    useStores(a, 5);
    expect(a.food).toBe(0);
    expect(vigour(a)).toBeGreaterThan(0.5);
  });

  it('rain fills the tank: most in the awning at anchor, twice that with the bigger catcher, some under sail', () => {
    const a = newAboard();
    a.water = 0;
    catchRain(a, 1, 60, 'anchored');
    const anchored = a.water;
    expect(anchored).toBeGreaterThan(0.9);
    expect(anchored).toBeLessThan(1.4);
    const b = newAboard();
    b.water = 0;
    b.made.catcher = 1;
    catchRain(b, 1, 60, 'anchored');
    expect(b.water).toBeCloseTo(anchored * 2, 5);
    const c = newAboard();
    c.water = 0;
    catchRain(c, 1, 60, 'sailing');
    expect(c.water).toBeLessThan(anchored * 0.6);
    // Never more than the tank holds; jugs add room.
    a.water = waterMax(a);
    catchRain(a, 1, 600, 'anchored');
    expect(a.water).toBe(STORES.waterMax);
    a.made.jugs = 1;
    expect(waterMax(a)).toBe(STORES.waterMax + STORES.jugDays);
  });

  it('a coconut from the locker is a little food and a little water', () => {
    const a = newAboard();
    const locker: Record<string, number> = { coconut: 1 };
    const f = a.food;
    const w = a.water;
    expect(openCoconut(a, locker)).toBe(true);
    expect(locker.coconut).toBe(0);
    expect(a.food).toBeCloseTo(f + STORES.coconut.food);
    expect(a.water).toBeCloseTo(w + STORES.coconut.water);
    expect(openCoconut(a, locker)).toBe(false);
  });

  it('fish keeps a day and a half in the cool box; cooking it fills the larder', () => {
    const a = newAboard();
    a.food = 2;
    a.coolBox = [
      { kind: 'snapper', caught: 10 },
      { kind: 'mahi', caught: 11.4 },
    ];
    expect(spoilFish(a, 11.8)).toBe(1); // the snapper has gone off
    const added = cookFish(a, (k) => FISH[k as FishKind].food);
    expect(added).toBeCloseTo(FISH.mahi.food);
    expect(a.coolBox.length).toBe(0);
    expect(a.food).toBeCloseTo(2 + FISH.mahi.food);
  });
});

describe('upkeep', () => {
  it('a badly scraped hull leaks; the bilge fills; pumping empties it; a full bilge slows her', () => {
    const a = newAboard();
    leak(a, 80, 600);
    expect(a.bilge).toBe(0); // a sound hull doesn't leak
    leak(a, 15, 120);
    expect(a.bilge).toBeGreaterThan(0.2);
    leak(a, 15, 600);
    expect(a.bilge).toBe(1);
    expect(bilgeDrag(a)).toBeLessThan(0.75);
    for (let i = 0; i < 25; i++) pumpStroke(a);
    expect(a.bilge).toBe(0);
    expect(bilgeDrag(a)).toBe(1);
  });

  it('sails wear when she is overpowered or flogging, and worn sails drive her less', () => {
    const a = newAboard();
    wearSails(a, 0, false, 60);
    expect(a.sails).toBe(100);
    wearSails(a, 0.2, false, 30);
    expect(a.sails).toBeLessThan(85);
    wearSails(a, 0, true, 60);
    expect(a.sails).toBeLessThan(80);
    expect(sailCondition(a)).toBeLessThan(sailCondition(newAboard()));
    a.sails = 0;
    expect(sailCondition(a)).toBeGreaterThan(0.5); // torn sails still get you home
    expect(UPKEEP.torn).toBeGreaterThan(0);
  });
});

describe('the workbench', () => {
  it('a recipe shows once you have found every kind of thing it needs', () => {
    const patch = RECIPES.find((r) => r.id === 'patch')!;
    expect(recipeKnown(patch, { plank: 1 })).toBe(false);
    expect(recipeKnown(patch, { plank: 1, rope: 2 })).toBe(true);
    for (const r of RECIPES) expect(Object.keys(r.needs).length).toBeGreaterThan(0);
  });

  it('patching the hull uses up a plank and some rope, and mends the hull', () => {
    const a = newAboard();
    const patch = RECIPES.find((r) => r.id === 'patch')!;
    const locker: Record<string, number> = { plank: 1, rope: 1 };
    expect(whyNot(patch, a, 100, locker)).toMatch(/sound/);
    expect(whyNot(patch, a, 50, { plank: 1 })).toMatch(/Not enough/);
    expect(whyNot(patch, a, 50, locker)).toBeNull();
    expect(make(patch, a, 50, locker)).toBe(85);
    expect(locker.plank).toBe(0);
    expect(locker.rope).toBe(0);
  });

  it('upgrades stay made, and only as many as allowed', () => {
    const a = newAboard();
    const jugs = RECIPES.find((r) => r.id === 'jugs')!;
    const locker: Record<string, number> = { bottle: 9, rope: 3 };
    make(jugs, a, 100, locker);
    make(jugs, a, 100, locker);
    expect(whyNot(jugs, a, 100, locker)).toMatch(/Already/);
    expect(a.made.jugs).toBe(2);
    expect(waterMax(a)).toBe(STORES.waterMax + 2 * STORES.jugDays);
    const sails = RECIPES.find((r) => r.id === 'sails')!;
    a.sails = 30;
    make(sails, a, 100, { sailcloth: 1, rope: 1 });
    expect(a.sails).toBe(70);
  });

  it('a save brings it all back, and a broken save gives a fresh start', () => {
    const a = newAboard();
    a.food = 12.5;
    a.made.catcher = 1;
    a.coolBox.push({ kind: 'grunt', caught: 3.2 });
    a.fishLog.grunt = 2;
    const b = restoreAboard(JSON.parse(JSON.stringify(a)));
    expect(b).toEqual(a);
    expect(restoreAboard('nonsense')).toEqual(newAboard());
    expect(restoreAboard({ food: 1e9, sails: -5, made: { jugs: 99 } }).food).toBe(STORES.foodMax);
  });
});

describe('fishing', () => {
  it('what bites depends on where: bonefish on the flats, mahi-mahi only out on the open sea', () => {
    const kinds = (place: { depth: number; open: number }) => new Set(Array.from({ length: 200 }, (_, i) => fishHere(place, i / 200)));
    const flats = kinds({ depth: 1, open: 0 });
    const lagoon = kinds({ depth: 3.5, open: 0 });
    const sea = kinds({ depth: 30, open: 1 });
    expect(flats.has('bonefish')).toBe(true);
    expect(lagoon.has('bonefish')).toBe(false);
    expect(lagoon.has('mahi')).toBe(false);
    expect(sea.has('mahi')).toBe(true);
    for (const k of FISH_KINDS) expect(FISH[k].fact.length).toBeGreaterThan(40);
  });

  it('a bite comes in a while (sooner with a lure); miss the strike and another nibble comes', () => {
    const r = rng(7);
    const s = newFishing();
    cast(s, 'grunt', false, r);
    expect(s.wait).toBeGreaterThanOrEqual(FISHING.waitMin);
    const plain = s.wait;
    let ev = null;
    for (let t = 0; t < 40 && ev !== 'bite'; t += 0.1) ev = stepFishing(s, 0.1, { strike: false, reel: false }, r);
    expect(ev).toBe('bite');
    for (let t = 0; t < 3 && ev !== 'missed'; t += 0.1) ev = stepFishing(s, 0.1, { strike: false, reel: false }, r);
    expect(ev).toBe('missed');
    expect(s.phase).toBe('waiting');
    const lured = newFishing();
    cast(lured, 'grunt', true, rng(7));
    expect(lured.wait).toBeLessThan(plain);
  });

  /** Play a fish: strike at the bite, then reel, easing off when the line gets tight (or never, if greedy). */
  function play(kind: FishKind, seed: number, careful: boolean): string {
    const r = rng(seed);
    const s = newFishing();
    cast(s, kind, false, r);
    for (let t = 0; t < 120; t += 1 / 30) {
      const strike = s.phase === 'bite';
      const reel = s.phase === 'reeling' && (!careful || (s.tension < 0.6 && !(s.running && s.tension > 0.35)));
      const ev = stepFishing(s, 1 / 30, { strike, reel }, r);
      if (ev === 'caught' || ev === 'snapped') return ev;
    }
    return 'timeout';
  }

  it('reeling with care lands every kind of fish', () => {
    for (const k of FISH_KINDS) for (let seed = 1; seed <= 5; seed++) expect(play(k, seed, true), `${k} #${seed}`).toBe('caught');
  });

  it('reeling flat out against a strong fish snaps the line', () => {
    let snapped = 0;
    for (let seed = 1; seed <= 10; seed++) if (play('mahi', seed, false) === 'snapped') snapped++;
    expect(snapped).toBeGreaterThan(6);
    // A little grunt you can just wind in.
    let grunts = 0;
    for (let seed = 1; seed <= 10; seed++) if (play('grunt', seed, false) === 'caught') grunts++;
    expect(grunts).toBeGreaterThan(6);
  });
});
