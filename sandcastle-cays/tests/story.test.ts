import { describe, expect, it } from 'vitest';
import { CHAPTERS, TIPS, atLeast, checkStory, chapterNow, doneKeys, howTo, newStory, nextGoal, note, restoreStory, takeTip, tipText } from '../src/game/story';
import { Beach } from '../src/game/beach';
import { FINDS } from '../src/content/finds';
import { BAIT, DINGHY_UPKEEP, RECIPES, cutBait, dentDinghy, make, newAboard, restoreAboard, whyNot, wearSails } from '../src/game/aboard';
import { FISH, cast, fishFood, fishHere, fishKg, fishSize, newFishing, stepFishing } from '../src/game/fishing';
import { mulberry32 } from '../src/engine/noise';

describe('the notebook', () => {
  it('has four chapters, each with goals and a reward', () => {
    expect(CHAPTERS.map((c) => c.id)).toEqual(['settle', 'live', 'further', 'sharks']);
    for (const c of CHAPTERS) {
      expect(c.goals.length).toBeGreaterThanOrEqual(4);
      expect(c.note.length).toBeGreaterThan(80);
      for (const g of c.goals) expect(g.how.length).toBeGreaterThan(20);
    }
    expect(CHAPTERS.map((c) => c.reward.kind).sort()).toEqual(['recipe', 'seeds', 'upgrade', 'upgrade']);
  });

  it('always shows the next step, and ticks goals off in any order', () => {
    const s = newStory();
    const seen = doneKeys(s);
    expect(nextGoal(s)?.fact).toBe('ashore');
    note(s, 'finds', 3);
    let n = checkStory(s, seen);
    expect(n.ticked.map((g) => g.fact)).toEqual(['finds']);
    expect(nextGoal(s)?.fact).toBe('ashore');
    note(s, 'ashore');
    n = checkStory(s, seen);
    expect(n.ticked.map((g) => g.fact)).toEqual(['ashore']);
    // Ticks are reported once.
    expect(checkStory(s, seen).ticked).toHaveLength(0);
    expect(nextGoal(s)?.fact).toBe('stowed');
  });

  it('finishing a chapter opens the next, with goals you already did ticked', () => {
    const s = newStory();
    const seen = doneKeys(s);
    note(s, 'fish', 2); // caught a fish on day one
    for (const g of CHAPTERS[0].goals) atLeast(s, g.fact, g.n);
    const n = checkStory(s, seen);
    expect(n.finished?.id).toBe('settle');
    expect(chapterNow(s)?.id).toBe('live');
    expect(nextGoal(s)?.fact).toBe('cooked');
    // The fish goal is not reported again as a fresh tick.
    expect(checkStory(s, seen).ticked).toHaveLength(0);
  });

  it('runs out when the notebook is finished', () => {
    const s = newStory();
    const seen = doneKeys(s);
    for (const c of CHAPTERS) for (const g of c.goals) atLeast(s, g.fact, g.n);
    for (let i = 0; i < 4; i++) checkStory(s, seen);
    expect(s.chapter).toBe(CHAPTERS.length);
    expect(nextGoal(s)).toBeNull();
    expect(chapterNow(s)).toBeNull();
  });

  it('saves and loads, ignoring nonsense', () => {
    const s = newStory();
    s.chapter = 2;
    note(s, 'slept', 3);
    s.seen.push('welcome');
    const r = restoreStory(JSON.parse(JSON.stringify(s)));
    expect(r.chapter).toBe(2);
    expect(r.facts.slept).toBe(3);
    expect(r.seen).toEqual(['welcome']);
    expect(restoreStory({ chapter: 99, facts: { slept: 'x' } }).chapter).toBe(CHAPTERS.length);
    expect(restoreStory(null).chapter).toBe(0);
  });

  it('tips are shown once each, with the right keys for phone or laptop', () => {
    const s = newStory();
    expect(takeTip(s, 'ladder')?.id).toBe('ladder');
    expect(takeTip(s, 'ladder')).toBeNull();
    expect(tipText(TIPS.ladder, false)).toContain('Press E to climb down');
    expect(tipText(TIPS.ladder, true)).toContain('Tap the hand button');
    for (const t of Object.values(TIPS)) {
      expect(tipText(t, false)).not.toMatch(/\{\w+\}/);
      expect(tipText(t, true)).not.toMatch(/\{\w+\}/);
    }
    for (const c of CHAPTERS)
      for (const g of c.goals) {
        expect(howTo(g.how, false)).not.toMatch(/\{\w+\}/);
        expect(howTo(g.how, true)).not.toMatch(/\{\w+\}/);
      }
  });
});

describe('shark-water rewards', () => {
  it('Shark Bank’s sand has the rare finds, and its own', () => {
    const line = Array.from({ length: 200 }, (_, i) => ({ x: i, z: 0, nx: 0, nz: -1, island: 'bank' as const }));
    const b = new Beach(line);
    const seen: Record<string, number> = {};
    for (let d = 1; d <= 40; d++) {
      b.state.ground = [];
      b.washUp(d);
      for (const g of b.state.ground) seen[g.kind] = (seen[g.kind] ?? 0) + 1;
    }
    expect(seen['shark-tooth']).toBeGreaterThan(0);
    expect(seen['queen-conch']).toBeGreaterThan(0);
    // Home Cay never gets them.
    const home = new Beach(line.map((p) => ({ ...p, island: 'home' as const })));
    for (let d = 1; d <= 20; d++) home.washUp(d);
    expect(home.state.ground.some((g) => FINDS[g.kind].islands?.includes('bank'))).toBe(false);
    // Rare things are a bigger share on the bank than at home.
    const share = (isl: 'home' | 'bank', k: 'glass-blue' | 'cowrie') => Beach.weight(k, isl) / Object.keys(FINDS).reduce((a, kk) => a + Math.max(0, Beach.weight(kk as 'cowrie', isl)), 0);
    expect(share('bank', 'cowrie')).toBeGreaterThan(share('home', 'cowrie'));
  });

  it('a dropped basket washes up on the next tide', () => {
    const line = Array.from({ length: 100 }, (_, i) => ({ x: i, z: 0, nx: 0, nz: -1, island: 'home' as const }));
    const b = new Beach(line);
    b.state.basket = ['cowrie', 'glass-blue'];
    expect(b.lose('home')).toBe(2);
    expect(b.state.basket).toHaveLength(0);
    b.washUp(2);
    const kinds = b.state.ground.map((g) => g.kind);
    expect(kinds).toContain('glass-blue');
    expect(kinds).toContain('cowrie');
    expect(b.state.adrift).toHaveLength(0);
    // And it survives saving.
    b.state.basket = ['plank'];
    b.lose('bank');
    expect(Beach.restore(JSON.parse(JSON.stringify(b.state))).adrift).toEqual([{ kind: 'plank', island: 'bank' }]);
  });

  it('fish run bigger in shark waters, feed you longer and fight harder', () => {
    expect(fishSize(0, 0.5)).toBeCloseTo(1);
    expect(fishSize(3, 0.5)).toBeGreaterThan(1.8);
    expect(fishKg('mahi', 2)).toBeCloseTo(FISH.mahi.kg * 2);
    expect(fishFood('mahi', 2)).toBeCloseTo(FISH.mahi.food * 2);
    let bigKinds = 0;
    for (let i = 0; i < 100; i++) if (['mahi', 'jack'].includes(fishHere({ depth: 12, open: 0, risk: 2 }, i / 100))) bigKinds++;
    expect(bigKinds).toBeGreaterThan(60);
  });

  it('the strong reel lets you land a big fish you’d otherwise snap', () => {
    const trial = (strong: boolean) => {
      let landed = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const r = mulberry32(seed);
        const s = newFishing();
        cast(s, 'mahi', false, r, { size: 2, strong });
        let ev = null;
        for (let t = 0; t < 60 && ev !== 'bite'; t += 1 / 30) ev = stepFishing(s, 1 / 30, { strike: false, reel: false }, r);
        stepFishing(s, 1 / 30, { strike: true, reel: false }, r);
        // A real person: glances at the line every half second, and eases off when it's getting tight.
        let reel = true;
        let f = 0;
        for (let t = 0; t < 120; t += 1 / 30) {
          if (f++ % 15 === 0) reel = s.tension < 0.5;
          ev = stepFishing(s, 1 / 30, { strike: false, reel }, r);
          if (ev === 'caught') landed++;
          if (ev === 'caught' || ev === 'snapped') break;
        }
      }
      return landed;
    };
    expect(trial(true)).toBeGreaterThan(trial(false));
  });

  it('bait, dinghy dents and the new upgrades', () => {
    const a = newAboard();
    expect(cutBait(a)).toBe(0);
    a.coolBox.push({ kind: 'grunt', caught: 1, size: 0.8 }, { kind: 'mahi', caught: 1, size: 1.6 });
    expect(cutBait(a)).toBe(BAIT.perFish);
    // It cuts the smallest fish.
    expect(a.coolBox.map((f) => f.kind)).toEqual(['mahi']);
    dentDinghy(a);
    expect(a.dinghy).toBe(100 - DINGHY_UPKEEP.bump);
    const mend = RECIPES.find((r) => r.id === 'dinghy')!;
    const locker: Record<string, number> = { driftwood: 1, rope: 1 };
    expect(whyNot(mend, a, 100, locker)).toBeNull();
    make(mend, a, 100, locker);
    expect(a.dinghy).toBe(100);
    expect(whyNot(mend, a, 100, { driftwood: 5, rope: 5 })).toMatch(/sound/);
    // Ida's spare sails wear half as fast.
    const b = newAboard();
    const c = newAboard();
    c.made.goodSails = 1;
    wearSails(b, 0.3, false, 10);
    wearSails(c, 0.3, false, 10);
    expect(100 - c.sails).toBeCloseTo((100 - b.sails) / 2);
    const r = restoreAboard(JSON.parse(JSON.stringify({ ...c, bait: 5, dinghy: 40, made: { goodSails: 1, strongReel: 1 } })));
    expect(r.bait).toBe(5);
    expect(r.dinghy).toBe(40);
    expect(r.made.strongReel).toBe(1);
  });
});
