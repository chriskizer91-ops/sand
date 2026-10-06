/** Unit tests for the life simulation's building blocks (the big behaviours are in src/checks/ecoChecks.ts). */
import { describe, expect, it } from 'vitest';
import { NP } from '../src/config';
import { Habitat, Substrate } from '../src/content/speciesTypes';
import { Columns } from '../src/engine/columns';
import { SpeciesTable, habitatReason, requireReason, substrateReason } from '../src/eco/catalog';
import { Ecology } from '../src/eco/ecology';
import { EcoFields, Flag, NPATCH } from '../src/eco/fields';
import { Hydro } from '../src/eco/hydro';
import { IslandLabeller, characterName, type IslandRec } from '../src/eco/islands';
import { JournalBook } from '../src/eco/journal';
import { band, chance, growRate, hrand, logistic, relax, trapezoid } from '../src/eco/maths';
import { PatchGrid } from '../src/eco/patches';
import { ScriptGeo, cone, flatSea } from '../src/eco/scenarios';
import { TEST_SPECIES, testCatalogue } from '../src/eco/testSpecies';

describe('exact maths', () => {
  it('logistic growth gives the same answer in one big step or many small ones', () => {
    const r = growRate(60);
    let c = 0.05;
    for (let i = 0; i < 8; i++) c = logistic(c, 0.9, r, 1);
    expect(logistic(0.05, 0.9, r, 8)).toBeCloseTo(c, 9);
    expect(logistic(0.05, 0.9, r, 1e6)).toBeCloseTo(0.9, 9);
  });
  it('takes about `grow` years from 5% to 95%', () => {
    expect(logistic(0.05, 1, growRate(100), 100)).toBeCloseTo(0.95, 2);
  });
  it('decline relaxes toward its target and never past it', () => {
    let c = 0.8;
    for (let i = 0; i < 50; i++) c = relax(c, 0.2, 6, 3);
    expect(c).toBeGreaterThanOrEqual(0.2);
    expect(relax(0.8, 0.2, 6, 1e9)).toBeCloseTo(0.2, 9);
  });
  it('chances compose exactly across step sizes', () => {
    const one = chance(0.03, 1);
    expect(1 - Math.pow(1 - one, 8)).toBeCloseTo(chance(0.03, 8), 12);
    expect(chance(0, 5)).toBe(0);
  });
  it('trapezoids and bands', () => {
    expect(trapezoid(0.1, 0.2, 0.4, 0.8, 1)).toBe(0);
    expect(trapezoid(0.3, 0.2, 0.4, 0.8, 1)).toBeCloseTo(0.5);
    expect(trapezoid(0.6, 0.2, 0.4, 0.8, 1)).toBe(1);
    expect(trapezoid(0.9, 0.2, 0.4, 0.8, 1)).toBeCloseTo(0.5);
    expect(trapezoid(1, 1, 1, 1, 1)).toBe(1);
    expect(band(5, 0, 4, 2)).toBeCloseTo(0.5);
  });
  it('hashed rolls are stable and spread out', () => {
    expect(hrand(10, 20, 3, 7)).toBe(hrand(10, 20, 3, 7));
    let sum = 0;
    for (let i = 0; i < 10000; i++) sum += hrand(i, 5, 1, 9);
    expect(sum / 10000).toBeGreaterThan(0.48);
    expect(sum / 10000).toBeLessThan(0.52);
  });
});

describe('catalogue', () => {
  const t = new SpeciesTable(TEST_SPECIES);
  const id = (k: string): number => t.id(k);
  it('reads optional needs as "no requirement"', () => {
    const spider = id('spider');
    expect(t.isPlant[spider]).toBe(0);
    expect(t.saltMax[spider]).toBe(1);
    expect(t.habMask[spider]).toBe(0);
  });
  it('land plants default to land ground, never sea, ponds or hot lava', () => {
    const fern = id('amau');
    expect(t.subMask[fern] & (1 << Substrate.Basalt)).toBeTruthy();
    expect(t.subMask[fern] & (1 << Substrate.Sea)).toBe(0);
    expect(t.subMask[fern] & (1 << Substrate.Pond)).toBe(0);
    expect(t.subMask[fern] & (1 << Substrate.HotLava)).toBe(0);
  });
  it('marine plants read substrate as the sea bottom', () => {
    const grass = id('turtlegrass');
    expect(t.subMask[grass]).toBe(1 << Substrate.Sand);
    expect(t.marine[grass]).toBe(1);
  });
  it('resolves required species and explains missing ones', () => {
    const turtle = id('turtle');
    const grass = id('turtlegrass');
    expect(Array.from(t.req.slice(t.reqStart[turtle], t.reqStart[turtle + 1]))).toEqual([grass]);
    expect(requireReason(t, grass)).toBe('no-seagrass');
    expect(requireReason(t, id('fig'))).toBe('no-fruit');
  });
  it('prefers a buildable main need for stories', () => {
    expect(habitatReason(t, id('pintail'))).toBe('no-fresh-water');
    expect(substrateReason(t, id('coconut'), false)).toBe('no-beach');
    expect(substrateReason(t, id('coconut'), true)).toBe('hot-lava');
  });
});

describe('journal pacing', () => {
  it('rations cards: one per gap, visits one a minute, firsts always', () => {
    const b = new JournalBook();
    b.openedAt = -1000;
    expect(b.add({ year: 1, kind: 'arrival' }, 'normal', 0)?.headline).toBe(true);
    expect(b.add({ year: 2, kind: 'arrival' }, 'normal', 10)?.headline).toBe(false);
    expect(b.add({ year: 3, kind: 'first', first: 'first-tree' }, 'normal', 12)?.headline).toBe(true);
    expect(b.add({ year: 4, kind: 'visit' }, 'visit', 30)?.headline).toBe(true);
    expect(b.add({ year: 5, kind: 'visit' }, 'visit', 80)?.headline).toBe(false);
    expect(b.add({ year: 6, kind: 'visit' }, 'visit', 100)?.headline).toBe(true);
  });
  it('holds a first arrival for a gap instead of losing its card', () => {
    const b = new JournalBook();
    b.openedAt = -1000;
    b.add({ year: 1, kind: 'arrival' }, 'normal', 0);
    expect(b.add({ year: 2, kind: 'arrival', species: 3 }, 'first', 5)).toBeNull();
    b.tick(20);
    expect(b.entries.length).toBe(1);
    b.tick(36);
    expect(b.entries.length).toBe(2);
    expect(b.entries[1].headline).toBe(true);
  });
  it('every first arrival is a card in the opening minutes', () => {
    const b = new JournalBook();
    b.openedAt = 0;
    expect(b.add({ year: 1, kind: 'arrival' }, 'first', 1)?.headline).toBe(true);
    expect(b.add({ year: 2, kind: 'arrival' }, 'first', 2)?.headline).toBe(true);
  });
});

describe('islands', () => {
  const grid = new PatchGrid();
  const f = new EcoFields(grid);
  const lab = new IslandLabeller();
  const prev = new Uint16Array(NPATCH);
  const out = new Uint16Array(NPATCH);
  const blob = (ci: number, ck: number, r: number, h: number): void => {
    for (let k = ck - r; k <= ck + r; k++) for (let i = ci - r; i <= ci + r; i++) if ((i - ci) ** 2 + (k - ck) ** 2 <= r * r) f.h[i + k * NP] = h;
  };
  let recs = new Map<number, IslandRec>();
  const relabel = (): ReturnType<IslandLabeller['label']> => {
    const res = lab.label(f, prev, recs, out, 0, () => 128);
    prev.set(out);
    recs = res.recs;
    return res;
  };
  it('labels, joins and splits with stable ids', () => {
    f.h.fill(-10);
    blob(60, 128, 12, 5);
    blob(120, 128, 12, 5);
    relabel();
    const a = prev[60 + 128 * NP];
    const b = prev[120 + 128 * NP];
    expect(a).not.toBe(b);
    for (let i = 60; i <= 120; i++) f.h[i + 128 * NP] = 2;
    const joined = relabel();
    expect(prev[60 + 128 * NP]).toBe(prev[120 + 128 * NP]);
    expect(joined.events.some((e) => e.kind === 'joined')).toBe(true);
    for (let i = 75; i <= 105; i++) f.h[i + 128 * NP] = -3;
    relabel();
    expect(prev[60 + 128 * NP]).toBe(a);
    expect(prev[120 + 128 * NP]).toBe(b);
  });
  it('a sandbar at the waterline does not flicker (hysteresis)', () => {
    f.h.fill(-10);
    blob(200, 60, 3, 0.3);
    prev.fill(0);
    recs = new Map();
    relabel();
    expect(prev[200 + 60 * NP]).toBe(0);
    blob(200, 60, 3, 0.8);
    relabel();
    const id = prev[200 + 60 * NP];
    expect(id).not.toBe(0);
    blob(200, 60, 3, 0.2);
    relabel();
    expect(prev[200 + 60 * NP]).toBe(id);
  });
  it('names islands by character and keeps names apart', () => {
    const rec: IslandRec = {
      id: 1, name: '', named: false, founded: 0, announced: true, area: 90000, patches: 5600, peak: [0, 110, 0], centroid: [0, -100],
      bbox: [-170, -270, 170, 70], places: 0, sandKind: 0, sandShare: 0, shore: 1000, colonySp: -1,
    };
    expect(characterName(rec, false, null, new Set())).toBe('Cloud Mountain');
    expect(characterName(rec, false, null, new Set(['Cloud Mountain']))).toBe('North Cloud Mountain');
    const cay = { ...rec, peak: [0, 5, 0] as [number, number, number], sandShare: 0.9, sandKind: 240 };
    expect(characterName(cay, false, null, new Set())).toBe('White Cay');
    const rock = { ...rec, area: 900, peak: [0, 12, 0] as [number, number, number] };
    expect(characterName(rock, true, 'Booby', new Set())).toBe('Booby Rock');
  });
});

describe('ponds', () => {
  const bowl = (floor: number): { hydro: Hydro; f: EcoFields } => {
    const grid = new PatchGrid();
    const f = new EcoFields(grid);
    const isl = new Uint16Array(NPATCH);
    f.h.fill(-10);
    for (let k = 100; k < 156; k++) {
      for (let i = 100; i < 156; i++) {
        const d = Math.hypot(i - 128, k - 128);
        if (d > 26) continue;
        const p = i + k * NP;
        f.h[p] = d < 6 ? 20 + d * 0.2 : 30 - d * 0.9;
        isl[p] = 1;
        f.bot[p] = d < 8 ? floor : Substrate.Basalt;
        f.born[p] = -500;
        f.rain[p] = 0.6;
        f.coast[p] = 40;
      }
    }
    const hydro = new Hydro();
    const job = hydro.run(f, isl, 0, () => 30);
    while (!job.next().done);
    return { hydro, f };
  };
  it('a rock bowl in the rain holds a pond', () => {
    const { hydro, f } = bowl(Substrate.Basalt);
    expect(hydro.ponds.length).toBe(1);
    expect(f.flags[128 + 128 * NP] & Flag.Pond).toBeTruthy();
  });
  it('a sand bowl drains', () => {
    const { hydro } = bowl(Substrate.Sand);
    expect(hydro.ponds.length).toBe(0);
    expect(hydro.basinAt(128 + 128 * NP)?.dry).toBe('sand');
  });
});

describe('ecology facade', () => {
  const cols = new Columns();
  flatSea(cols, 12);
  cone(cols, 0, 0, 80, 30);
  const eco = new Ecology(cols, new PatchGrid(), new ScriptGeo(cols), 1, testCatalogue(['lichen', 'spider']));
  it('starts its year clock at first land and logs it', () => {
    expect(eco.firstLand).toBe(true);
    expect(eco.journalAll()[0].kind).toBe('first-land');
  });
  it('undo merge keeps growth but restores what a stroke cleared', () => {
    expect(eco.undoMerge('eco.cov', 0.7, 0)).toBe(0.7);
    expect(eco.undoMerge('eco.cov', 0.3, 0.6)).toBe(0.6);
    expect(eco.undoMerge('eco.sp', 4, 0)).toBe(4);
    expect(eco.undoMerge('eco.soil', 0.1, 0)).toBe(0.1);
    expect(eco.undoMerge('eco.born', 10, 400)).toBe(10);
    expect(eco.undoMerge('eco.refH', 3, 9)).toBe(3);
    expect(eco.undoMerge('eco.isl', 2, 5)).toBe(5);
  });
  it('packs eco bytes for the page', () => {
    eco.debugAdvance(300);
    const n = 48 * 48;
    const out = { a: new Uint8Array(n * 4), b: new Uint8Array(n * 4), c: new Uint8Array(n * 4), plants: new Uint8Array(n * 6), habitat: new Uint8Array(n) };
    eco.packEco(104, 104, 48, 48, out);
    expect(out.habitat.some((h) => h !== Habitat.None)).toBe(true);
    expect(out.a.some((v) => v > 0)).toBe(true);
    expect(eco.takeDirty()).not.toBeNull();
  }, 60_000);
  it('renames islands but keeps the id', () => {
    const life = eco.takeLife();
    const id = life?.islands[0]?.id ?? 0;
    eco.renameIsland(id, '  Home  ');
    expect(eco.takeLife()?.islands.find((i) => i.id === id)?.name).toBe('Home');
  });
});
