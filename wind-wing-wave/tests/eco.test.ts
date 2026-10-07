/** Unit tests for the life simulation's building blocks (the big behaviours are in src/checks/ecoChecks.ts). */
import { describe, expect, it } from 'vitest';
import { NP, NX, NZ } from '../src/config';
import { Habitat, Substrate } from '../src/content/speciesTypes';
import { ChangeFlag, Columns } from '../src/engine/columns';
import { SpeciesTable, habitatReason, requireReason, substrateReason } from '../src/eco/catalog';
import { Dirty, LocalDerive } from '../src/eco/derive';
import { Ecology } from '../src/eco/ecology';
import { EcoFields, Flag, NPATCH, type ZoneFields } from '../src/eco/fields';
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
    expect(substrateReason(t, id('coconut'), Substrate.Basalt)).toBe('no-beach');
    expect(substrateReason(t, id('coconut'), Substrate.HotLava)).toBe('hot-lava');
  });
  it('tells a rock plant on all-sand ground that there is no rock, not that the ground is crowded', () => {
    expect(substrateReason(t, id('lichen'), Substrate.Sand)).toBe('no-rock-shore');
  });
});

describe('journal pacing', () => {
  it('rations cards: ordinary stories one per gap, visits one a minute and only into a quiet moment', () => {
    const b = new JournalBook();
    b.openedAt = -1000;
    expect(b.add({ year: 1, kind: 'arrival' }, 'normal', 0, 1)?.headline).toBe(true);
    expect(b.add({ year: 2, kind: 'arrival' }, 'normal', 10, 2)?.headline).toBe(false);
    // A visit right after another card stays in the journal.
    expect(b.add({ year: 3, kind: 'visit' }, 'visit', 20, 3)?.headline).toBe(false);
    expect(b.add({ year: 4, kind: 'visit' }, 'visit', 40, 4)?.headline).toBe(true);
    expect(b.add({ year: 5, kind: 'visit' }, 'visit', 90, 5)?.headline).toBe(false);
    expect(b.add({ year: 6, kind: 'visit' }, 'visit', 101, 6)?.headline).toBe(true);
  });
  it('stamps always get their card, at least 15 s apart, written in order with the year they are shown', () => {
    const b = new JournalBook();
    b.openedAt = -1000;
    expect(b.add({ year: 10, kind: 'first', first: 'first-tree' }, 'normal', 0, 10)?.headline).toBe(true);
    expect(b.add({ year: 11, kind: 'age', age: 'green' }, 'always', 2, 11)).toBeNull();
    b.tick(14, 14);
    expect(b.entries.length).toBe(1);
    b.tick(15, 15);
    expect(b.entries.length).toBe(2);
    expect(b.entries[1].headline).toBe(true);
    expect(b.entries[1].year).toBe(15);
  });
  it('cards wait in the order things happened', () => {
    const b = new JournalBook();
    b.openedAt = 0;
    b.add({ year: 1, kind: 'arrival', species: 1 }, 'first', 1, 1);
    expect(b.add({ year: 2, kind: 'arrival', species: 2 }, 'first', 2, 2)).toBeNull();
    expect(b.add({ year: 3, kind: 'first', first: 'first-tree', species: 2 }, 'always', 3, 3)).toBeNull();
    b.tick(16, 16);
    b.tick(31, 31);
    expect(b.entries.map((e) => e.kind)).toEqual(['arrival', 'arrival', 'first']);
  });
  it('a visitor coming back always gets a card, waiting for a quiet moment', () => {
    const b = new JournalBook();
    b.openedAt = -1000;
    b.add({ year: 1, kind: 'arrival' }, 'normal', 0, 1);
    expect(b.add({ year: 2, kind: 'return', species: 3 }, 'return', 10, 2)).toBeNull();
    b.tick(30, 30);
    expect(b.entries.length).toBe(1);
    b.tick(35, 35);
    expect(b.entries[1].kind).toBe('return');
    expect(b.entries[1].headline).toBe(true);
  });
  it('holds a first arrival for a gap, and writes it journal-only if none comes', () => {
    const b = new JournalBook();
    b.openedAt = -1000;
    b.add({ year: 1, kind: 'arrival' }, 'normal', 0, 1);
    expect(b.add({ year: 2, kind: 'arrival', species: 3 }, 'first', 5, 2)).toBeNull();
    b.tick(20, 20);
    expect(b.entries.length).toBe(1);
    b.tick(36, 36);
    expect(b.entries[1].headline).toBe(true);
    b.add({ year: 40, kind: 'storm' }, 'always', 40, 40);
    b.add({ year: 41, kind: 'arrival', species: 4 }, 'first', 41, 41);
    b.tick(60, 60);
    b.tick(82, 82);
    expect(b.entries[b.entries.length - 1].headline).toBe(false);
  });
  it('in the opening minutes a first arrival needs only 15 s; those that wait too long are folded into the next card', () => {
    const b = new JournalBook();
    b.openedAt = 0;
    expect(b.add({ year: 1, kind: 'arrival' }, 'first', 1, 1)?.headline).toBe(true);
    expect(b.add({ year: 2, kind: 'arrival' }, 'first', 2, 2)).toBeNull();
    b.tick(16, 16);
    expect(b.entries[1].headline).toBe(true);
    // Four arrive at once: a card each 15 s (at 31 and 46); the last two wait past their 40 s
    // and are written journal-only, and the next arrival card says two more came.
    for (let i = 0; i < 4; i++) b.add({ year: 20, kind: 'arrival', species: 10 + i }, 'first', 20, 20);
    for (let now = 21; now <= 70; now++) b.tick(now, now);
    expect(b.entries.filter((e) => e.headline).length).toBe(4);
    expect(b.entries.filter((e) => !e.headline).length).toBe(2);
    expect(b.folded).toBe(2);
    b.add({ year: 80, kind: 'arrival', species: 30 }, 'first', 80, 80);
    expect(b.entries[b.entries.length - 1].params?.more).toBe(2);
    expect(b.folded).toBe(0);
  });
});

describe('islands', () => {
  const grid = new PatchGrid();
  const f: ZoneFields = { ...new EcoFields(grid), life: new Uint8Array(NPATCH) };
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
  const bowl = (floor: number): { hydro: Hydro; f: ZoneFields } => {
    const grid = new PatchGrid();
    const f: ZoneFields = { ...new EcoFields(grid), life: new Uint8Array(NPATCH) };
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
    const job = hydro.run(f, isl, 0, () => 30, new Float32Array(NPATCH));
    while (!job.next().done);
    hydro.commit();
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

describe('reshaped ground', () => {
  it('is re-derived in slices that keep to a deadline, oldest first, and the rest waits', () => {
    const cols = new Columns();
    flatSea(cols, 12);
    cone(cols, 0, 0, 80, 30);
    const f = new EcoFields(new PatchGrid());
    const d = new LocalDerive();
    d.all(cols, f);
    const sink = { year: 0, touch: () => undefined, burned: () => undefined, reset: () => undefined };
    d.mark(0, 0, NX - 1, NZ - 1, Dirty.Geom | Dirty.Tool);
    expect(d.pending).toBe(NPATCH);
    // A deadline already past: one slice, no more.
    const left = d.apply(cols, f, sink, -Infinity, () => 0);
    expect(left).toBeGreaterThan(NPATCH - 1000);
    expect(left).toBeLessThan(NPATCH);
    expect(d.apply(cols, f, sink, Infinity, () => 0)).toBe(0);
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
    eco.debugAdvance(800);
    const n = 48 * 48;
    const out = { a: new Uint8Array(n * 4), b: new Uint8Array(n * 4), c: new Uint8Array(n * 4), plants: new Uint8Array(n * 6), habitat: new Uint8Array(n) };
    eco.packEco(104, 104, 48, 48, out);
    expect(out.habitat.some((h) => h !== Habitat.None)).toBe(true);
    expect(out.a.some((v) => v > 0)).toBe(true);
  }, 60_000);
  it('hands over everything changed in one rectangle, and forgets it', () => {
    eco.takeDirty();
    expect(eco.isDirtyRect()).toBeNull();
    // A stroke on two far-apart spots: one rectangle covering both.
    eco.onTerrainChanged(100, 100, 103, 103, ChangeFlag.Geom | ChangeFlag.Tool);
    eco.onTerrainChanged(400, 300, 401, 301, ChangeFlag.Geom | ChangeFlag.Tool);
    const r = eco.isDirtyRect();
    expect(r).not.toBeNull();
    const d = eco.takeDirty() as [number, number, number, number];
    expect(d[0]).toBeLessThanOrEqual(50);
    expect(d[1]).toBeLessThanOrEqual(50);
    expect(d[2]).toBeGreaterThanOrEqual(200);
    expect(d[3]).toBeGreaterThanOrEqual(150);
    expect(eco.isDirtyRect()).toBeNull();
    expect(eco.takeDirty()).toBeNull();
  });
  it("tells the sea's own slow work from the player's (sand slumping long after a stroke is not urgent)", () => {
    eco.takeDirty();
    // Ground moving without a tool, seconds after the last stroke: the sea's work.
    eco.setClock({ paused: true, yps: 2, dayPhase: 0.3, season: 'dry', gentleStorms: false });
    eco.advance(10);
    eco.onTerrainChanged(200, 200, 210, 210, ChangeFlag.Geom);
    expect(eco.isDirtyRect()).toBeNull();
    // The same change from a tool is the player's: the page hears of it at once.
    eco.onTerrainChanged(200, 200, 210, 210, ChangeFlag.Geom | ChangeFlag.Tool);
    expect(eco.isDirtyRect()).not.toBeNull();
    // And what it sets moving straight after still counts as theirs.
    eco.takeDirty();
    eco.advance(0.5);
    eco.onTerrainChanged(220, 220, 225, 225, ChangeFlag.Geom);
    expect(eco.isDirtyRect()).not.toBeNull();
  });
  it('renames islands but keeps the id', () => {
    const life = eco.takeLife();
    const id = life?.islands[0]?.id ?? 0;
    eco.renameIsland(id, '  Home  ');
    expect(eco.takeLife()?.islands.find((i) => i.id === id)?.name).toBe('Home');
  });
});
