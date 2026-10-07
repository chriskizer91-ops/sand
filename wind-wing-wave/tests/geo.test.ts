/** Unit tests for the geology package (WP-B): seabed, tools, physics bookkeeping and the coast. */
import { describe, expect, it, vi } from 'vitest';
import { BUILD_MIN, CELL, NX, NZ, PATCH, PHYS_STEP, SEA_LEVEL } from '../src/config';
import { ChangeFlag, Columns, RockKind, type ColumnBlock } from '../src/engine/columns';
import { Geo } from '../src/engine/geo/geo';
import { mixKind } from '../src/engine/geo/sand';
import { seabedLayout } from '../src/engine/geo/seabed';
import { LAVA_RATE, ROCK_RATE, SAND_RATE } from '../src/engine/geo/tools';
import { hold, runFor, settle, testWorld } from '../src/checks/geoChecks';

vi.setConfig({ testTimeout: 60_000 });

/** Column index at world (x, z). */
const col = (cols: Columns, x: number, z: number) => cols.colAt(x, z);

/** Record every change report. */
function recordChanges(cols: Columns): { i0: number; k0: number; i1: number; k1: number; flags: number }[] {
  const seen: { i0: number; k0: number; i1: number; k1: number; flags: number }[] = [];
  cols.addListener((i0, k0, i1, k1, flags) => seen.push({ i0, k0, i1, k1, flags }));
  return seen;
}

function totals(cols: Columns): { rock: number; sed: number; lava: number } {
  let rock = 0;
  let sed = 0;
  let lava = 0;
  for (let c = 0; c < cols.n; c++) {
    rock += cols.rock[c];
    sed += cols.sed[c];
    lava += cols.lava[c];
  }
  return { rock, sed, lava };
}

describe('seabed', () => {
  it('is the same for the same seed and different for another', () => {
    const a = new Geo(new Columns(), 99);
    const b = new Geo(new Columns(), 99);
    const c = new Geo(new Columns(), 100);
    a.generateSeabed();
    b.generateSeabed();
    c.generateSeabed();
    expect(a.cols.hash()).toBe(b.cols.hash());
    expect(a.cols.hash()).not.toBe(c.cols.hash());
    expect(a.seabed.glow).toEqual(b.seabed.glow);
  });

  it('knows where the glow is from the seed alone (for loaded games)', () => {
    const geo = new Geo(new Columns(), 4242);
    expect(geo.seabed.glow).toEqual(seabedLayout(4242).glow);
    geo.generateSeabed();
    const top = geo.cols.top(col(geo.cols, geo.seabed.glow.x, geo.seabed.glow.z));
    expect(top).toBeGreaterThan(-4);
    expect(top).toBeLessThan(SEA_LEVEL);
  });

  it('has sand everywhere, no lava, and nothing sliding at the start', () => {
    const geo = new Geo(new Columns(), 7);
    geo.generateSeabed();
    const cols = geo.cols;
    let minSed = Infinity;
    for (let c = 0; c < cols.n; c++) {
      minSed = Math.min(minSed, cols.sed[c]);
      expect(cols.lava[c]).toBe(0);
    }
    expect(minSed).toBeGreaterThanOrEqual(0.5);
    // Telling Geo the whole sea changed (as loading a save does) wakes nothing.
    cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom);
    expect(geo.isSettled()).toBe(true);
  });
});

describe('tools', () => {
  it('pour by volume in proportion to the brush area', () => {
    for (const [tool, rate] of [
      ['lava', LAVA_RATE],
      ['rock', ROCK_RATE],
      ['sand', SAND_RATE],
    ] as const) {
      for (const r of [4, 18, 50]) {
        const geo = testWorld(() => 10);
        const res = geo.applyTool(tool, 3, -7, r, PHYS_STEP, 0.5);
        const expected = rate * Math.PI * r * r * PHYS_STEP * 0.5;
        expect(res.volume / expected).toBeGreaterThan(0.99);
        expect(res.volume / expected).toBeLessThan(1.01);
        expect(res.rect).not.toBeNull();
      }
    }
  });

  it('report tool changes with the Tool flag, and burning only on (near) land', () => {
    const land = testWorld(() => 2);
    const seen = recordChanges(land.cols);
    land.applyTool('lava', 0, 0, 6, PHYS_STEP, 1);
    expect(seen.some((s) => s.flags === (ChangeFlag.Tool | ChangeFlag.Geom | ChangeFlag.Look))).toBe(true);
    expect(seen.some((s) => (s.flags & ChangeFlag.Burn) !== 0 && (s.flags & ChangeFlag.Tool) !== 0)).toBe(true);
    const sea = testWorld(() => -10);
    const seaSeen = recordChanges(sea.cols);
    sea.applyTool('lava', 0, 0, 6, PHYS_STEP, 1);
    runFor(sea, 1);
    expect(seaSeen.some((s) => (s.flags & ChangeFlag.Burn) !== 0)).toBe(false);
  });

  it('burn only the patches the poured lava lands on, not the square around the brush', () => {
    const geo = testWorld(() => 2);
    const cols = geo.cols;
    const seen = recordChanges(cols);
    const r = 10;
    geo.applyTool('lava', 0, 0, r, PHYS_STEP, 1);
    const burns = seen.filter((s) => (s.flags & ChangeFlag.Burn) !== 0);
    expect(burns.length).toBeGreaterThan(10);
    for (const b of burns) {
      // Within one patch, holding lava, and inside the brush (give or take a column).
      expect(Math.floor(b.i0 / PATCH)).toBe(Math.floor(b.i1 / PATCH));
      expect(Math.floor(b.k0 / PATCH)).toBe(Math.floor(b.k1 / PATCH));
      let lava = false;
      for (let k = b.k0; k <= b.k1; k++) {
        for (let i = b.i0; i <= b.i1; i++) {
          if (cols.lava[i + k * NX] > 0) lava = true;
          expect(Math.hypot(cols.cx(i), cols.cz(k))).toBeLessThan(r + CELL);
        }
      }
      expect(lava).toBe(true);
    }
  });

  it('flowing lava burns the ground it newly covers, without the Tool flag', () => {
    const geo = testWorld((x) => 20 - x * 0.2);
    const seen = recordChanges(geo.cols);
    hold(geo, 'lava', 0, 0, 4, 1);
    seen.length = 0;
    runFor(geo, 2);
    const burns = seen.filter((s) => (s.flags & ChangeFlag.Burn) !== 0);
    expect(burns.length).toBeGreaterThan(0);
    expect(burns.every((s) => (s.flags & ChangeFlag.Tool) === 0)).toBe(true);
    // Burn rectangles hug the lava front: every one contains lava.
    for (const b of burns) {
      let any = false;
      for (let k = b.k0; k <= b.k1 && !any; k++) for (let i = b.i0; i <= b.i1; i++) if (geo.cols.lava[i + k * NX] > 0) any = true;
      expect(any).toBe(true);
    }
  });

  it('rock buries the sand it lands on, is placed stone, and is counted for sounds', () => {
    const geo = testWorld(
      () => 1,
      () => 0.8,
    );
    const res = geo.applyTool('rock', 0, 0, 6, PHYS_STEP, 1);
    const c = col(geo.cols, 0, 0);
    expect(geo.cols.sed[c]).toBe(0);
    expect(geo.cols.rockKind[c]).toBe(RockKind.Stone);
    expect(geo.cols.rock[c]).toBeGreaterThan(1.8);
    expect(geo.takeRockPlaced()).toBeCloseTo(res.volume, 6);
    expect(geo.takeRockPlaced()).toBe(0);
  });

  it('rock held still builds a steep pillar', () => {
    const geo = testWorld(() => -3);
    hold(geo, 'rock', 0, 0, 10, 20);
    const cols = geo.cols;
    const top = cols.top(col(cols, 0, 0));
    expect(top).toBeGreaterThan(8);
    // Steep sides: most of the height is gone within the outer half of the brush.
    expect(cols.top(col(cols, 9, 0))).toBeLessThan(-3 + (top + 3) * 0.2);
  });

  it('mixes sand colours fairly: many tiny additions add up instead of rounding away', () => {
    // 1 mm of white (250) sand at a time onto golden (150) sand, 500 times, on 200 columns.
    let sum = 0;
    for (let c = 0; c < 200; c++) {
      let kind = 150;
      let had = 1;
      for (let n = 0; n < 500; n++) {
        kind = mixKind(kind, had, 0.001, 250, c, n);
        had += 0.001;
      }
      sum += kind;
    }
    // The exact mix into the top half metre: each addition moves the colour 0.001 / 0.501 of the way.
    const exact = 250 - 100 * Math.pow(1 - 0.001 / 0.501, 500);
    expect(Math.abs(sum / 200 - exact)).toBeLessThan(2);
    // Plain rounding would never have moved it: each step is a fifth of a colour step.
    expect(Math.round(150 + (100 * 0.001) / 0.501)).toBe(150);
  });

  it('sand mixes its golden colour with the sand already there', () => {
    const geo = testWorld(
      () => 5,
      () => 1,
    );
    const c = col(geo.cols, 0, 0);
    geo.cols.sandKind.fill(0);
    geo.applyTool('sand', 0, 0, 6, PHYS_STEP * 10, 1);
    expect(geo.cols.sandKind[c]).toBeGreaterThan(10);
    expect(geo.cols.sandKind[c]).toBeLessThan(150);
  });

  it('scoop takes lava first, then sand, then rock at half speed, never below the floor', () => {
    const geo = testWorld(
      () => 0,
      () => 0.05,
    );
    const cols = geo.cols;
    const c = col(cols, 0, 0);
    cols.lava[c] = 0.05;
    cols.temp[c] = 0.9;
    // One small scoop: only lava goes.
    geo.applyTool('scoop', cols.cx(c % NX), cols.cz((c / NX) | 0), 3, PHYS_STEP * 0.1, 1);
    expect(cols.lava[c]).toBeLessThan(Math.fround(0.05));
    expect(cols.sed[c]).toBe(Math.fround(0.05));
    expect(cols.rock[c]).toBe(0);
    for (let s = 0; s < 400; s++) geo.applyTool('scoop', 0, 0, 6, PHYS_STEP, 1);
    let lowest = Infinity;
    for (let j = 0; j < cols.n; j++) lowest = Math.min(lowest, cols.top(j));
    expect(lowest).toBeGreaterThanOrEqual(BUILD_MIN - 1e-6);
    expect(cols.lava[c]).toBe(0);
  });

  it('hands smooth without making or losing material', () => {
    const geo = testWorld(
      (x, z) => 2 + 0.5 * Math.sin(x * 0.9) * Math.cos(z * 0.7),
      (x, z) => 1 + 0.6 * Math.sin(x * 1.3 + z),
    );
    const cols = geo.cols;
    const before = totals(cols);
    const rough = (): number => {
      let r = 0;
      for (let k = 245; k < 267; k++) for (let i = 245; i < 267; i++) r += Math.abs(cols.top(i + k * NX) - cols.top(i + 1 + k * NX));
      return r;
    };
    const r0 = rough();
    for (let s = 0; s < 90; s++) geo.applyTool('hands', 0, 0, 20, PHYS_STEP, 1);
    const after = totals(cols);
    expect(Math.abs(after.rock + after.sed + after.lava - (before.rock + before.sed + before.lava))).toBeLessThan(1e-2);
    expect(Math.abs(after.sed - before.sed)).toBeLessThan(1e-2);
    expect(rough()).toBeLessThan(r0 * 0.8);
  });

  it('hands barely touch bare rock (it smooths like weathering)', () => {
    const geo = testWorld((x) => (Math.round(x / 2) % 2 === 0 ? 3 : 2));
    const cols = geo.cols;
    const before = cols.rock.slice();
    geo.applyTool('hands', 0, 0, 10, PHYS_STEP, 1);
    let most = 0;
    for (let c = 0; c < cols.n; c++) most = Math.max(most, Math.abs(cols.rock[c] - before[c]));
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(0.005);
  });

  it('fade out at the zone edge and never touch the outer ring', () => {
    const geo = testWorld(() => 0);
    const cols = geo.cols;
    const edgeX = -512 + 1;
    const res = geo.applyTool('rock', edgeX, 0, 10, PHYS_STEP, 1);
    const inner = geo.applyTool('rock', 0, 0, 10, PHYS_STEP, 1);
    expect(res.volume).toBeLessThan(inner.volume * 0.05);
    for (let k = 0; k < NZ; k++) expect(cols.rock[k * NX]).toBe(0);
  });

  it('does nothing for Look, zero strength or zero time', () => {
    const geo = testWorld(() => 0);
    expect(geo.applyTool('look', 0, 0, 10, PHYS_STEP, 1).rect).toBeNull();
    expect(geo.applyTool('lava', 0, 0, 10, PHYS_STEP, 0).rect).toBeNull();
    expect(geo.applyTool('lava', 0, 0, 10, 0, 1).rect).toBeNull();
    expect(geo.isSettled()).toBe(true);
  });
});

describe('physics bookkeeping', () => {
  it('touches every block it changes before changing it (undo restores exactly)', () => {
    const geo = testWorld(
      (x) => 6 - x * 0.08,
      () => 0.6,
    );
    const cols = geo.cols;
    const original = cols.hash();
    const snaps: ColumnBlock[] = [];
    cols.beforeModify = (b) => snaps.push(cols.snapshotBlock(b));
    cols.recordId = 1;
    hold(geo, 'lava', -20, 0, 8, 2);
    hold(geo, 'sand', 30, 10, 8, 2);
    hold(geo, 'rock', 0, -30, 6, 1);
    hold(geo, 'hands', 30, 10, 10, 1);
    hold(geo, 'scoop', 70, 0, 6, 1);
    settle(geo);
    expect(cols.hash()).not.toBe(original);
    for (const s of snaps) cols.restoreBlock(s);
    expect(cols.hash()).toBe(original);
  });

  it('picks up molten lava that something else wrote (undo or loading)', () => {
    const cols = new Columns();
    cols.rock.fill(5);
    const c = col(cols, 0, 0);
    cols.lava[c] = 2;
    cols.temp[c] = 1;
    // Built before Geo: found when Geo starts.
    const geo = new Geo(cols, 1);
    expect(geo.isSettled()).toBe(false);
    settle(geo);
    expect(geo.isSettled()).toBe(true);
    // Written later and reported: found too.
    const d = col(cols, 40, 40);
    cols.lava[d] = 3;
    cols.temp[d] = 1;
    cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom);
    expect(geo.isSettled()).toBe(false);
    expect(settle(geo)).toBeLessThan(30);
  });

  it('picks up sand left too steep in a world built before it (a save taken mid-slide)', () => {
    const cols = new Columns();
    cols.rock.fill(5);
    for (let k = 250; k < 262; k++) for (let i = 250; i < 262; i++) cols.sed[i + k * NX] = 12;
    const geo = new Geo(cols, 3);
    expect(geo.isSettled()).toBe(false);
    settle(geo, 300);
    expect(geo.isSettled()).toBe(true);
  });

  it('keeps going across steps when out of time, and still conserves sand', () => {
    const geo = testWorld(
      () => 5,
      (x, z) => (Math.hypot(x, z) < 10 ? 25 : 0),
    );
    const cols = geo.cols;
    const before = cols.totalSediment();
    cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom);
    let steps = 0;
    while (!geo.isSettled() && steps < 20000) {
      geo.step(PHYS_STEP, 0);
      steps++;
    }
    expect(geo.isSettled()).toBe(true);
    expect(Math.abs(cols.totalSediment() - before)).toBeLessThan(1e-3);
  });

  it('reports sliding sand as ground changes, never as tool changes', () => {
    const geo = testWorld(
      () => 5,
      (x, z) => (Math.hypot(x, z) < 6 ? 12 : 0),
    );
    const seen = recordChanges(geo.cols);
    geo.cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom);
    seen.length = 0;
    const st = geo.step(PHYS_STEP, 1000);
    expect(st.slid).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => (s.flags & ChangeFlag.Tool) === 0 && (s.flags & ChangeFlag.Geom) !== 0)).toBe(true);
  });

  it('gives steam in at most 32 places, then starts again', () => {
    const geo = testWorld(() => -5);
    for (let s = 0; s < 20; s++) {
      for (let j = 0; j < 40; j++) geo.applyTool('lava', -400 + j * 20, -300 + (j % 7) * 90, 6, PHYS_STEP, 1);
      geo.step(PHYS_STEP, 1000);
    }
    const out: number[] = [];
    geo.takeSteam(out);
    expect(out.length).toBe(32 * 3);
    for (let j = 2; j < out.length; j += 3) {
      expect(out[j]).toBeGreaterThan(0);
      expect(out[j]).toBeLessThanOrEqual(1);
    }
    const again: number[] = [];
    geo.takeSteam(again);
    expect(again.length).toBe(0);
  });

  it('describes the biggest molten area for the lava light', () => {
    const geo = testWorld(() => 10);
    hold(geo, 'lava', 100, -50, 20, 1);
    hold(geo, 'lava', -200, 100, 5, 0.2);
    const s = geo.lavaStats();
    expect(s.area).toBeGreaterThan(Math.PI * 15 * 15);
    expect(Math.hypot(s.glow[0] - 100, s.glow[1] + 50)).toBeLessThan(5);
    expect(s.glow[2]).toBeGreaterThan(12);
    expect(s.glow[3]).toBeGreaterThan(0.5);
    settle(geo);
    expect(geo.lavaStats()).toEqual({ area: 0, glow: [0, 0, 0, 0] });
  });

  it('keeps settled sand asleep when a storm has not reached it', () => {
    const geo = testWorld(
      (x) => -x * 0.1,
      () => 1,
    );
    geo.setStorm(1);
    geo.step(PHYS_STEP, 1000);
    expect(geo.isSettled()).toBe(true);
  });
});

describe('coast', () => {
  /** A straight beach: land to the west (-x), sea to the east, with a sandy berm and shallows. */
  function beach(facingEast: boolean): { geo: Geo; shore: Int32Array } {
    const sign = facingEast ? 1 : -1;
    const geo = testWorld(
      (x) => Math.max(-6, -sign * x * 0.12) - 1,
      () => 1,
    );
    const cols = geo.cols;
    const shore: number[] = [];
    for (let k = 200; k < 312; k++) {
      // The column on each row nearest the water line.
      let best = -1;
      for (let i = 1; i < NX - 1; i++) {
        const c = i + k * NX;
        if (best < 0 || Math.abs(cols.top(c)) < Math.abs(cols.top(best))) best = c;
      }
      shore.push(best);
    }
    return { geo, shore: Int32Array.from(shore) };
  }

  function sandAbove(cols: Columns, level: number): number {
    let v = 0;
    for (let c = 0; c < cols.n; c++) if (cols.top(c) > level) v += cols.sed[c];
    return v * CELL * CELL;
  }

  it('storm surf pulls berm sand offshore, most on windward beaches', () => {
    const wind = beach(true);
    const lee = beach(false);
    const w0 = sandAbove(wind.geo.cols, 0.5);
    const l0 = sandAbove(lee.geo.cols, 0.5);
    const seen = recordChanges(wind.geo.cols);
    for (let s = 0; s < 60 * 30; s++) {
      wind.geo.stormPulse(1, PHYS_STEP, wind.shore, wind.shore.length);
      lee.geo.stormPulse(1, PHYS_STEP, lee.shore, lee.shore.length);
    }
    const windLoss = w0 - sandAbove(wind.geo.cols, 0.5);
    const leeLoss = l0 - sandAbove(lee.geo.cols, 0.5);
    expect(windLoss).toBeGreaterThan(0);
    expect(windLoss).toBeGreaterThan(2 * leeLoss);
    expect(seen.every((s) => (s.flags & ChangeFlag.Tool) === 0)).toBe(true);
  });

  it('calm years carry the sand back up to the berm', () => {
    const { geo, shore } = beach(true);
    for (let s = 0; s < 60 * 30; s++) geo.stormPulse(1, PHYS_STEP, shore, shore.length);
    settle(geo);
    const stormed = sandAbove(geo.cols, 0);
    for (let y = 0; y < 30; y++) geo.coastYears(1, shore, shore.length, null);
    settle(geo);
    expect(sandAbove(geo.cols, 0)).toBeGreaterThan(stormed);
  });

  it('windward sea cliffs wear back slowly and drop sand at their foot', () => {
    const geo = testWorld((x) => (x < 0 ? 20 : -8));
    const cols = geo.cols;
    const shore: number[] = [];
    const ifoot = col(cols, 1, 0) % NX;
    for (let k = 230; k < 280; k++) shore.push(ifoot + k * NX);
    const list = Int32Array.from(shore);
    const face = ifoot - 1 + 250 * NX;
    const h0 = cols.top(face);
    for (let y = 0; y < 20; y++) geo.coastYears(1, list, list.length, null);
    const worn = h0 - cols.top(face);
    expect(worn).toBeGreaterThan(20 * 0.02 * 0.5);
    expect(worn).toBeLessThan(20 * 0.08 * 1.01);
    expect(cols.sed[ifoot + 250 * NX]).toBeGreaterThan(0);
    expect(cols.sandKind[ifoot + 250 * NX]).toBeLessThan(10);
    // A lee cliff (facing west, away from the wind) stays put.
    const lee = testWorld((x) => (x > 0 ? 20 : -8));
    const leeShore: number[] = [];
    const ilee = col(lee.cols, -1, 0) % NX;
    for (let k = 230; k < 280; k++) leeShore.push(ilee + k * NX);
    const before = lee.cols.rock.slice();
    for (let y = 0; y < 20; y++) lee.coastYears(1, Int32Array.from(leeShore), leeShore.length, null);
    expect(lee.cols.rock).toEqual(before);
  });

  it('reef sand whitens the beach it lands on', () => {
    const { geo, shore } = beach(false);
    const reef = new Float32Array(shore.length).fill(0.01);
    const k0 = geo.cols.sandKind[shore[50]];
    for (let y = 0; y < 100; y++) geo.coastYears(1, shore, shore.length, reef);
    let whitest = 0;
    for (let c = 0; c < geo.cols.n; c++) whitest = Math.max(whitest, geo.cols.sandKind[c]);
    expect(whitest).toBeGreaterThan(k0 + 20);
  });

  it('wear a cliff down to its platform whichever side of the water line the shore column is', () => {
    // The ecology may list the last land column (the cliff top) rather than the first sea one.
    const geo = testWorld((x) => (x < 0 ? 20 : -8));
    const cols = geo.cols;
    const face = col(cols, -1, 0) % NX;
    const shore = new Int32Array(50);
    for (let y = 0; y < 600; y++) {
      for (let j = 0; j < 50; j++) {
        const k = 230 + j;
        let last = 0;
        for (let i = 1; i < NX - 1; i++) if (cols.top(i + k * NX) > SEA_LEVEL) last = i;
        shore[j] = last + k * NX;
      }
      geo.coastYears(1, shore, 50, null);
    }
    expect(cols.rock[face + 255 * NX]).toBeCloseTo(-0.5, 3);
    expect(cols.top(face - 1 + 255 * NX)).toBeLessThan(20);
    expect(cols.top(face - 2 + 255 * NX)).toBe(20);
  });

  it('still land reef sand on a cliff shore in a year the cliff barely wears', () => {
    const geo = testWorld(
      (x) => (x < 0 ? 20 : -8),
      (x) => (x < 0 ? 1 : 0),
    );
    const cols = geo.cols;
    const foot = col(cols, 1, 0);
    const shore = Int32Array.from([foot]);
    // So short a time that the cliff's wear rounds to nothing, but the reef sand does not.
    geo.coastYears(1e-5, shore, 1, Float32Array.from([2]));
    expect(cols.sed[foot]).toBeGreaterThan(0);
    expect(cols.sandKind[foot]).toBeGreaterThan(200);
  });

  it('wake the sand a growing reef lifts', () => {
    const geo = testWorld(() => -3);
    const cols = geo.cols;
    const c = col(cols, 0, 0);
    // Half a metre of sand: too thick to be cemented in, so it rides up on the reef.
    cols.sed[c] = 0.5;
    expect(geo.isSettled()).toBe(true);
    geo.growReef(Int32Array.from([c]), Float32Array.from([1.5]), 1);
    expect(cols.rock[c]).toBeCloseTo(-1.5, 5);
    expect(geo.isSettled()).toBe(false);
    settle(geo);
    expect(geo.isSettled()).toBe(true);
  });

  it('reefs grow limestone up to half a metre below the surface, never above', () => {
    const geo = testWorld(() => -3);
    const cols = geo.cols;
    const list = Int32Array.from([col(cols, 0, 0), col(cols, 10, 0)]);
    const amounts = Float32Array.from([0.5, 10]);
    geo.growReef(list, amounts, 2);
    expect(cols.top(list[0])).toBeCloseTo(-2.5, 5);
    expect(cols.top(list[1])).toBeCloseTo(-0.5, 5);
    expect(cols.rockKind[list[0]]).toBe(RockKind.Limestone);
    geo.growReef(list, amounts, 2);
    expect(cols.top(list[1])).toBeCloseTo(-0.5, 5);
  });

  it('storms flatten beaches that are steeper than storm waves allow', () => {
    const { geo, shore } = beach(true);
    const cols = geo.cols;
    /** Average slope of the sandy beach between -3 and +2 m along the middle row. */
    const beachSlope = (): number => {
      let sum = 0;
      let n = 0;
      for (let i = 1; i < NX - 1; i++) {
        const a = cols.top(i + 256 * NX);
        const b = cols.top(i + 1 + 256 * NX);
        if (a > -3 && a < 2 && b > -3 && b < 2) {
          sum += Math.abs(a - b) / CELL;
          n++;
        }
      }
      return sum / n;
    };
    const calm = beachSlope();
    geo.setStorm(1);
    for (let s = 0; s < 30 * 30; s++) {
      geo.stormPulse(1, PHYS_STEP, shore, shore.length);
      geo.step(PHYS_STEP, 1000);
    }
    const stormy = beachSlope();
    expect(calm).toBeGreaterThan(0.11);
    expect(stormy).toBeLessThan(calm * 0.85);
  });
});
