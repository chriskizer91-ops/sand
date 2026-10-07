/**
 * Checks for the engine hub: undo, saving, the streams that keep the screen's copy of the
 * world up to date, and the tick's time budget. They run in vitest (npm test) and on the
 * in-game checks page.
 *
 * Most checks drive a real Engine through its messages, the way the page does. Some of
 * them also write "scripted lava" straight into the columns (touching blocks and reporting
 * changes exactly as geology must), so the hub's own rules are tested whatever the geology
 * does; with the real geology the strokes in these checks also pour real lava and sand.
 */
import { CELL, NX, NZ, type ToolId } from '../config';
import { PatchGrid } from '../eco/patches';
import { ChangeFlag, Columns, BLOCKS_X, RockKind } from '../engine/columns';
import { Engine, LOADING_TICK_BUDGET_MS, TICK_ACTIVE, WORKER_TICK_BUDGET_MS } from '../engine/engine';
import { DEMO_ISLANDS } from '../engine/fixtures';
import { mulberry32 } from '../engine/noise';
import type { DebugOp, FromEngine, ToEngine } from '../engine/protocol';
import { SAVE_FORMAT, SaveError, applyFields, decodeSave, encodeSave, patchesHash, type DecodedSave, type SaveSource } from '../engine/save';
import { DirtyTiles } from '../engine/streams';
import { UndoStack } from '../engine/undo';
import { registerChecks } from './registry';

// ---------- rigs shared with tests/engine.test.ts ----------

type Msg<T extends FromEngine['t']> = Extract<FromEngine, { t: T }>;

/** An Engine driven directly (no thread), with every message it sends collected. */
export class Rig {
  readonly msgs: FromEngine[] = [];
  readonly engine: Engine;
  private nextId = 1000;

  constructor(page = false) {
    this.engine = new Engine((m) => this.msgs.push(m));
    this.engine.setPageMode(page);
  }

  /** A new sea (optionally the demo chain of islands), ready to play. */
  static start(opts: { seed?: number; demo?: boolean; page?: boolean } = {}): Rig {
    const rig = new Rig(opts.page);
    rig.send({ t: 'init', save: null, seed: opts.seed ?? 1, settings: { pace: 'normal', gentleStorms: false } });
    rig.load();
    if (opts.demo) {
      rig.debug('demoChain');
      rig.debug('settle');
    }
    return rig;
  }

  get cols(): Columns {
    const c = this.engine.columns;
    if (!c) throw new Error('no world yet');
    return c;
  }

  get grid(): PatchGrid {
    const g = this.engine.patches;
    if (!g) throw new Error('no world yet');
    return g;
  }

  send(m: ToEngine): void {
    this.engine.handle(m);
  }

  /** Tick through a (re)load until ready. */
  load(): void {
    for (let i = 0; i < 500 && !this.engine.isReady; i++) this.engine.tick(TICK_ACTIVE, LOADING_TICK_BUDGET_MS);
    if (!this.engine.isReady) throw new Error('the engine never became ready');
  }

  /** Wait (for real) for an asynchronous load to be decoded, then tick it through. */
  async loadAsync(): Promise<void> {
    for (let i = 0; i < 400 && !this.engine.isReady; i++) {
      await new Promise((r) => setTimeout(r, 5));
      this.engine.tick(TICK_ACTIVE, LOADING_TICK_BUDGET_MS);
    }
    if (!this.engine.isReady) throw new Error('the engine never became ready');
  }

  /** Run `seconds` of ticks at `dt`, calling `each` before every tick. */
  run(seconds: number, dt = TICK_ACTIVE, each?: (t: number) => void): void {
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      each?.(t);
      this.engine.tick(dt, WORKER_TICK_BUDGET_MS);
    }
  }

  /** A debug op (answered synchronously). */
  debug(op: DebugOp, extra: Partial<Extract<ToEngine, { t: 'debug' }>> = {}): Record<string, unknown> {
    const id = this.nextId++;
    this.send({ t: 'debug', id, op, ...extra });
    const r = this.msgs.find((m): m is Msg<'debugResult'> => m.t === 'debugResult' && m.id === id);
    if (!r) throw new Error(`no answer to debug ${op}`);
    return r.data as Record<string, unknown>;
  }

  stroke(phase: 'start' | 'move' | 'end' | 'cancel', tool: ToolId, x: number, z: number, radius = 8): void {
    this.send({ t: 'stroke', phase, tool, x, z, radius, strength: 1 });
  }

  of<T extends FromEngine['t']>(t: T): Msg<T>[] {
    return this.msgs.filter((m): m is Msg<T> => m.t === t);
  }

  /** The undo count in the latest tick message. */
  get undoCount(): number {
    const ticks = this.of('tick');
    return ticks.length ? ticks[ticks.length - 1].undo : 0;
  }
}

/** The page's copy of the ground, rebuilt only from 'clear' and 'cols' messages. */
export class Mirror {
  readonly surf = new Float32Array(NX * NZ);
  readonly ground = new Uint8Array(NX * NZ * 4);

  apply(m: FromEngine): void {
    if (m.t === 'clear') {
      this.surf.fill(-30);
      this.ground.fill(0);
    } else if (m.t === 'cols') {
      for (let z = 0; z < m.h; z++) {
        const row = (m.z0 + z) * NX + m.x0;
        this.surf.set(m.surf.subarray(z * m.w, z * m.w + m.w), row);
        this.ground.set(m.ground.subarray(z * m.w * 4, (z * m.w + m.w) * 4), row * 4);
      }
    }
  }

  /** Columns where the copy differs from the engine. */
  diff(cols: Columns): number {
    const surf = new Float32Array(NX * NZ);
    const ground = new Uint8Array(NX * NZ * 4);
    cols.packRect(0, 0, NX, NZ, surf, ground);
    let n = 0;
    for (let c = 0; c < NX * NZ; c++) {
      const g = c * 4;
      if (
        surf[c] !== this.surf[c] ||
        ground[g] !== this.ground[g] ||
        ground[g + 1] !== this.ground[g + 1] ||
        ground[g + 2] !== this.ground[g + 2] ||
        ground[g + 3] !== this.ground[g + 3]
      )
        n++;
    }
    return n;
  }
}

/** Column rectangle of a disc (inclusive, clamped). */
function discRect(cols: Columns, x: number, z: number, r: number): [number, number, number, number] {
  const c = cols.colAt(x, z);
  const ci = c % NX;
  const ck = (c / NX) | 0;
  const R = Math.ceil(r / CELL) + 1;
  return [Math.max(0, ci - R), Math.max(0, ck - R), Math.min(NX - 1, ci + R), Math.min(NZ - 1, ck + R)];
}

/**
 * Scripted lava: add molten lava in a disc, touching blocks first and reporting the change
 * afterwards, exactly as geology must. Returns the rectangle changed.
 */
export function scriptLava(cols: Columns, x: number, z: number, r: number, depth: number): [number, number, number, number] {
  const [i0, k0, i1, k1] = discRect(cols, x, z, r);
  for (let k = k0; k <= k1; k++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(cols.cx(i) - x, cols.cz(k) - z) / r;
      if (d >= 1) continue;
      const c = cols.index(i, k);
      cols.touch(c);
      cols.lava[c] += depth * (1 - d * d);
      cols.temp[c] = 1;
    }
  }
  cols.markChanged(i0, k0, i1, k1, ChangeFlag.Geom | ChangeFlag.Look | ChangeFlag.Burn | ChangeFlag.Tool);
  return [i0, k0, i1, k1];
}

/** Scripted cooling: all molten lava in a disc turns into basalt. */
export function scriptFreeze(cols: Columns, x: number, z: number, r: number): void {
  const [i0, k0, i1, k1] = discRect(cols, x, z, r);
  for (let k = k0; k <= k1; k++) {
    for (let i = i0; i <= i1; i++) {
      const c = cols.index(i, k);
      if (cols.lava[c] <= 0) continue;
      cols.touch(c);
      cols.rock[c] += cols.sed[c] + cols.lava[c];
      cols.sed[c] = 0;
      cols.lava[c] = 0;
      cols.temp[c] = 0;
      cols.rockKind[c] = RockKind.Basalt;
    }
  }
  cols.markChanged(i0, k0, i1, k1, ChangeFlag.Geom | ChangeFlag.Look);
}

/** A spot on the demo volcano's eastern slope, and one on the islet. */
const SLOPE = { x: DEMO_ISLANDS[0].x + 70, z: DEMO_ISLANDS[0].z + 30 };
const ISLET = { x: DEMO_ISLANDS[2].x, z: DEMO_ISLANDS[2].z };

/** Pause the year clock (as when the journal is open), so nothing but our strokes changes the world. */
function holdYears(rig: Rig): void {
  rig.send({ t: 'pause', on: true, hidden: false });
}

/** A world for save checks: a scripted island with lava, sand kinds and rock kinds, and some life fields. */
export function scriptedSaveSource(): SaveSource {
  const cols = new Columns();
  const rand = mulberry32(7);
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const c = cols.index(i, k);
      const d = Math.hypot(cols.cx(i) - 30, cols.cz(k) + 10) / 160;
      cols.rock[c] = -30 + 1.3 * Math.sin(i * 0.05) + Math.max(0, 1 - d) * 95.123 + rand() * 0.01;
      cols.sed[c] = d > 0.8 && d < 1.1 ? 1.7 * (1 - Math.abs(d - 0.95) / 0.15) + rand() * 0.003 : 0.4;
      cols.sandKind[c] = (i * 7 + k * 3) & 255;
      cols.rockKind[c] = d < 0.3 ? RockKind.Stone : d > 1.4 ? RockKind.Limestone : RockKind.Basalt;
      if (d < 0.12) {
        cols.lava[c] = 2.5 * (1 - d / 0.12) + rand() * 0.01;
        cols.temp[c] = 0.3 + 0.7 * rand();
      }
    }
  }
  const grid = scriptedGrid();
  const cover = grid.get<Float32Array>('cover');
  const sp = grid.get<Uint8Array>('species');
  const age = grid.get<Int16Array>('age');
  for (let p = 0; p < grid.n; p += 3) {
    cover[p] = rand();
    sp[p * 3 + (p % 3)] = (p * 13) & 255;
    age[p] = ((p * 31) % 60000) - 30000;
  }
  return {
    header: { format: SAVE_FORMAT, gameVersion: 'test', savedAt: '2026-01-01T00:00:00.000Z', seed: 42, glow: { x: 12.5, z: -40 }, year: 321, page: { camera: [1, 2, 3, 4, 5, 6], dayPhase: 0.4, ui: { seen: ['lava'] } } },
    cols,
    grid,
    eco: { version: 2, state: { year: 321.25, islands: [{ id: 1, name: 'High Island' }], rng: [123456789, 42], journal: [] } },
  };
}

/** A life grid with three saved fields and one derived field. */
export function scriptedGrid(): PatchGrid {
  const g = new PatchGrid();
  g.add('cover', (n) => new Float32Array(n));
  g.add('species', (n) => new Uint8Array(n), true, 3);
  g.add('derived', (n) => new Float32Array(n), false);
  g.add('age', (n) => new Int16Array(n));
  return g;
}

/**
 * Two saved records are "the same" when every text, flag and whole number matches and every
 * measured height is within 2 cm. The save stores ground heights to 1/128 m, so a figure the
 * life simulation measured from the live ground (an island's peak) comes back from the
 * rounded ground a hair different. On a flat cay two patches can be equally high, so the
 * peak's position may land one patch (4 m) away.
 */
function closeJson(a: unknown, b: unknown, eps = 0.02): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.abs(a - b) <= eps;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => closeJson(x, b[i], eps));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && closeJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], k === 'peak' ? 4.01 : eps));
  }
  return a === b;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Load a decoded scripted world into fresh objects and save it again. */
async function reencode(d: DecodedSave): Promise<Uint8Array> {
  const grid = scriptedGrid();
  applyFields(grid, d.fields);
  return new Uint8Array(await encodeSave({ header: d.header, cols: d.cols, grid, eco: d.eco }));
}

/** Pick out the 'saved' answer to a save request. */
async function saveVia(rig: Rig, id: number): Promise<ArrayBuffer> {
  rig.send({ t: 'save', id, header: { camera: [0, 0, 0, 300, -0.6, 0.75], dayPhase: 0.4 } });
  for (let i = 0; i < 400; i++) {
    const s = rig.of('saved').find((m) => m.id === id);
    if (s) {
      if (!s.data) throw new Error(s.error ?? 'save failed');
      return s.data;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no answer to save');
}

async function loadVia(rig: Rig, id: number, data: ArrayBuffer): Promise<Msg<'loaded'>> {
  rig.send({ t: 'load', id, data });
  for (let i = 0; i < 400; i++) {
    const l = rig.of('loaded').find((m) => m.id === id);
    if (l) return l;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('no answer to load');
}

interface TickTimes {
  median: number;
  /** 99% of ticks took at most this long (the worst 1% set aside). */
  p99: number;
  worst: number;
}

/**
 * Time `count` ticks of pouring lava on the volcano's slope. Every tick also writes fresh
 * lava (what the physics does while pouring), so the streams and the ecology have real
 * changes to handle; with the real geology the stroke pours lava of its own too.
 */
function benchTicks(rig: Rig, count: number): TickTimes {
  const times: number[] = [];
  rig.stroke('start', 'lava', SLOPE.x, SLOPE.z, 14);
  for (let n = 0; n < count + 10; n++) {
    const x = SLOPE.x - (n % 60) * 0.3;
    const z = SLOPE.z + (n % 60) * 0.2;
    if (n % 10 === 0) rig.stroke('move', 'lava', x, z, 14);
    const t0 = performance.now();
    scriptLava(rig.cols, x, z, 12, 0.02);
    rig.engine.tick(TICK_ACTIVE, WORKER_TICK_BUDGET_MS);
    if (n >= 10) times.push(performance.now() - t0); // the first ticks warm up
    if (n % 30 === 0) rig.msgs.length = 0;
  }
  rig.stroke('end', 'lava', SLOPE.x, SLOPE.z, 14);
  rig.debug('settle');
  times.sort((a, b) => a - b);
  return { median: times[times.length >> 1], p99: times[times.length - 1 - Math.floor(times.length / 100)], worst: times[times.length - 1] };
}

// ---------- the checks ----------

registerChecks('engine', [
  {
    id: 'undo-lava-exact',
    label: 'Undo after a lava pour has cooled puts the ground back exactly',
    quick: false,
    run() {
      const rig = Rig.start({ demo: true });
      holdYears(rig);
      rig.run(0.5);
      const before = rig.cols.hash();
      rig.stroke('start', 'lava', SLOPE.x, SLOPE.z, 10);
      rig.run(2, TICK_ACTIVE, (t) => {
        rig.stroke('move', 'lava', SLOPE.x + t * 4, SLOPE.z, 10);
        scriptLava(rig.cols, SLOPE.x + t * 4, SLOPE.z, 8, 0.05);
      });
      scriptFreeze(rig.cols, SLOPE.x + 4, SLOPE.z, 20);
      rig.stroke('end', 'lava', SLOPE.x + 8, SLOPE.z, 10);
      const settled = rig.debug('settle');
      rig.run(0.5);
      const poured = rig.cols.hash();
      const records = rig.undoCount;
      rig.send({ t: 'undo' });
      const after = rig.cols.hash();
      rig.run(0.5);
      const pass = settled.settled === true && poured !== before && after === before && records === 1 && rig.undoCount === 0;
      return {
        pass,
        detail: `settled ${String(settled.settled)} after ${Number(settled.seconds).toFixed(1)} s, ground ${poured !== before ? 'changed' : 'unchanged'} by the pour, ${after === before ? 'identical' : 'different'} after undo (${records} record before, ${rig.undoCount} after)`,
      };
    },
  },
  {
    id: 'undo-later-kept',
    label: 'Undo never takes back changes made after a stroke settled, and brings back buried life',
    quick: true,
    run() {
      const cols = new Columns();
      const grid = scriptedGrid();
      const cover = grid.get<Float32Array>('cover');
      const undo = new UndoStack(cols, grid);
      const A = cols.index(20, 20); // block 1,1
      const pA = PatchGrid.ofColumn(20, 20);
      const pA2 = PatchGrid.ofColumn(28, 28); // same block, untouched patch
      const C = cols.index(300, 300); // a far block
      const pB = PatchGrid.ofColumn(400, 40); // a far life block
      const D = cols.index(200, 20); // written while recording is paused
      cover[pA] = 0.5;
      undo.begin();
      cols.touch(A);
      cols.rock[A] = 5;
      cover[pA] = 0; // the lava burned it (after the ground was first touched)
      undo.pauseRecording();
      cols.touch(D);
      cols.rock[D] = 3; // a coast change during the stroke: not the stroke's doing
      undo.resumeRecording();
      undo.close();
      // After the record closed: life grows nearby, the coast moves far away, life grows far away.
      cover[pA2] = 0.7;
      cols.touch(C);
      cols.rock[C] = 7;
      cover[pB] = 0.9;
      const blocks = undo.undo((name, s, c) => (name === 'cover' ? Math.max(s, c) : s)) ?? [];
      const pass =
        cols.rock[A] === 0 &&
        Math.abs(cover[pA] - 0.5) < 1e-6 &&
        Math.abs(cover[pA2] - 0.7) < 1e-6 &&
        cols.rock[C] === 7 &&
        cols.rock[D] === 3 &&
        Math.abs(cover[pB] - 0.9) < 1e-6 &&
        blocks.length === 1 &&
        undo.count === 0;
      return {
        pass,
        detail: `stroke ground ${cols.rock[A]} m, burned life ${cover[pA].toFixed(2)}, later growth ${cover[pA2].toFixed(2)}, later coast ${cols.rock[C]} m, paused write ${cols.rock[D]} m, far life ${cover[pB].toFixed(2)}, ${blocks.length} block restored`,
      };
    },
  },
  {
    id: 'undo-limits',
    label: 'Undo keeps the last 20 strokes and stays within its memory limit',
    quick: true,
    run() {
      const cols = new Columns();
      const grid = scriptedGrid();
      const undo = new UndoStack(cols, grid);
      for (let s = 0; s < 25; s++) {
        undo.begin();
        const c = cols.index((s % BLOCKS_X) * 16, 0);
        cols.touch(c);
        cols.rock[c] = s + 1;
      }
      undo.close();
      const count = undo.count;
      // Undo everything that is left: the five oldest strokes were dropped, so they stay.
      let restored = 0;
      while (undo.undo((_n, snap) => snap)) restored++;
      const dropped = cols.rock[cols.index(4 * 16, 0)];
      const undone = cols.rock[cols.index(5 * 16, 0)];
      // A memory limit of three strokes' worth (one ground block and one life block each).
      const perStroke = 16 * 16 * 18 + 8 * 8 * 9;
      const smallCols = new Columns();
      const small = new UndoStack(smallCols, scriptedGrid(), 20, 3 * perStroke);
      for (let s = 0; s < 6; s++) {
        small.begin();
        smallCols.touch(smallCols.index(s * 16, 16));
      }
      const pass = count === 20 && restored === 20 && dropped === 5 && undone === 0 && small.count === 3 && small.bytes === 3 * perStroke;
      return { pass, detail: `${count} of 25 strokes kept and ${restored} undone (oldest dropped stroke left at ${dropped} m, first kept one back to ${undone} m); a 3-stroke memory limit kept ${small.count}` };
    },
  },
  {
    id: 'save-identical',
    label: 'Save, load and save again gives the same file, byte for byte',
    quick: true,
    async run() {
      const src = scriptedSaveSource();
      const first = new Uint8Array(await encodeSave(src));
      const d1 = await decodeSave(first.slice().buffer);
      const second = await reencode(d1);
      const d2 = await decodeSave(second.slice().buffer);
      const third = await reencode(d2);
      let maxRock = 0;
      let maxLava = 0;
      for (let c = 0; c < NX * NZ; c++) {
        maxRock = Math.max(maxRock, Math.abs(d1.cols.rock[c] - src.cols.rock[c]));
        maxLava = Math.max(maxLava, Math.abs(d1.cols.lava[c] - src.cols.lava[c]));
      }
      const lifeGrid = scriptedGrid();
      applyFields(lifeGrid, d1.fields);
      const lifeExact = d1.fields.length === 3 && patchesHash(lifeGrid) === patchesHash(src.grid);
      const identical = same(second, third) && same(first, second);
      const pass = identical && maxRock <= 1 / 256 + 1e-6 && maxLava <= 1 / 512 + 1e-6 && lifeExact && JSON.stringify(d1.eco) === JSON.stringify(src.eco);
      return {
        pass,
        detail: `${(first.length / 1024).toFixed(0)} KB file, ${identical ? 'identical' : 'DIFFERENT'} after reloading; heights within ${(maxRock * 1000).toFixed(1)} mm, life fields ${lifeExact ? 'exact' : 'changed'}`,
      };
    },
  },
  {
    id: 'save-engine-roundtrip',
    label: 'A saved sea reloads exactly, with the same ground, life and years',
    quick: false,
    async run() {
      const rig = Rig.start({ demo: true });
      holdYears(rig);
      rig.debug('advanceYears', { arg: 40 });
      scriptLava(rig.cols, SLOPE.x, SLOPE.z, 12, 1.5); // molten lava is saved as is
      rig.run(0.5);
      // The life simulation waits for new land to settle before it recognises its shape. A save
      // taken in that wait keeps the old island labels and a reload labels them at once, which
      // is harmless but not byte-identical; so let it finish first.
      rig.engine.ecology?.flushJobs();
      const before = rig.debug('hash');
      const a = await saveVia(rig, 1);
      const loaded = await loadVia(rig, 2, a.slice(0));
      await rig.loadAsync();
      const after = rig.debug('hash');
      const b = await saveVia(rig, 3);
      const da = await decodeSave(a);
      const db = await decodeSave(b);
      const fa = da.fields.map((f) => f.bytes);
      const fb = db.fields.map((f) => f.bytes);
      const fieldsSame = fa.length === fb.length && fa.every((x, i) => same(x, fb[i]));
      const ready = rig.of('ready');
      const resumed = ready[ready.length - 1]?.resumed === true;
      const pass =
        loaded.ok &&
        resumed &&
        da.cols.hash() === db.cols.hash() &&
        closeJson(da.eco, db.eco) &&
        fieldsSame &&
        da.header.year === db.header.year &&
        da.header.seed === db.header.seed &&
        rig.cols.hash() === da.cols.hash() &&
        after.patches === before.patches;
      return {
        pass,
        detail: `loaded ${loaded.ok ? 'fine' : 'FAILED: ' + loaded.error}; second save ${da.cols.hash() === db.cols.hash() && fieldsSame ? 'matches' : 'differs from'} the first; year ${db.header.year}; life ${after.patches === before.patches ? 'exact' : 'CHANGED'}`,
      };
    },
  },
  {
    id: 'save-damaged',
    label: 'A damaged or foreign save file is refused and the game carries on',
    quick: false,
    async run() {
      const rig = Rig.start({ demo: true });
      holdYears(rig);
      const good = await saveVia(rig, 1);
      const before = rig.cols.hash();
      const bad: [string, ArrayBuffer][] = [
        ['cut short', good.slice(0, Math.floor(good.byteLength / 2))],
        ['random bytes', (() => {
          const r = mulberry32(3);
          return new Uint8Array(4000).map(() => Math.floor(r() * 256)).buffer;
        })()],
        ['empty', new ArrayBuffer(0)],
        ['another file', await new Response(new Blob([new TextEncoder().encode('{"hello":"world"}')]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()],
      ];
      const refused: string[] = [];
      let id = 10;
      for (const [name, data] of bad) {
        const l = await loadVia(rig, id++, data);
        if (!l.ok && l.error) refused.push(name);
      }
      // The game still works: a stroke changes the ground and can be undone.
      const still = rig.engine.isReady && rig.cols.hash() === before;
      rig.stroke('start', 'rock', ISLET.x, ISLET.z, 6);
      scriptLava(rig.cols, ISLET.x, ISLET.z, 6, 0.5);
      rig.run(0.3);
      rig.stroke('end', 'rock', ISLET.x, ISLET.z, 6);
      rig.debug('settle');
      const changed = rig.cols.hash() !== before;
      rig.send({ t: 'undo' });
      const undone = rig.cols.hash() === before;
      // A damaged save at start-up starts a new sea instead.
      const boot = new Rig();
      boot.send({ t: 'init', save: bad[0][1], seed: 5, settings: { pace: 'normal', gentleStorms: false } });
      await boot.loadAsync();
      const bootOk = boot.of('error').length === 1 && boot.of('ready')[0]?.resumed === false;
      const pass = refused.length === bad.length && still && changed && undone && bootOk;
      return {
        pass,
        detail: `refused ${refused.length}/${bad.length} (${refused.join(', ')}); game ${still ? 'untouched' : 'CHANGED'}; stroke and undo ${changed && undone ? 'work' : 'BROKEN'}; damaged save at start ${bootOk ? 'starts a new sea' : 'FAILED'}`,
      };
    },
  },
  {
    id: 'save-bit-flips',
    label: 'A save damaged by even one wrong bit is refused, never opened as a different sea',
    quick: false,
    async run() {
      const src = scriptedSaveSource();
      const good = new Uint8Array(await encodeSave(src));
      const ref = await decodeSave(good.slice().buffer);
      const refFields = ref.fields.map((f) => f.bytes);
      const rand = mulberry32(21);
      const flips = 60;
      let refused = 0;
      let identical = 0;
      let wrong = 0;
      let crashed = 0;
      for (let n = 0; n < flips; n++) {
        const bad = good.slice();
        const bit = Math.floor(rand() * bad.length * 8);
        bad[bit >> 3] ^= 1 << (bit & 7);
        try {
          const d = await decodeSave(bad.buffer);
          // Only a flip that changes nothing that is read (a spare bit at the very end) may load.
          const unchanged =
            d.cols.hash() === ref.cols.hash() &&
            d.fields.length === refFields.length &&
            d.fields.every((f, i) => f.name === ref.fields[i].name && same(f.bytes, refFields[i])) &&
            JSON.stringify([d.header, d.eco]) === JSON.stringify([ref.header, ref.eco]);
          if (unchanged) identical++;
          else wrong++;
        } catch (err) {
          if (err instanceof SaveError) refused++;
          else crashed++;
        }
      }
      return {
        pass: wrong === 0 && crashed === 0 && refused >= flips - 3,
        detail: `${flips} single-bit flips: ${refused} refused with a plain message, ${identical} changed nothing, ${wrong} opened a different sea, ${crashed} failed without a plain message`,
      };
    },
  },
  {
    id: 'eco-fault',
    label: 'If the life simulation fails, the ground keeps updating and undo still works exactly',
    quick: false,
    run() {
      const rig = Rig.start({ demo: true });
      holdYears(rig);
      const mirror = new Mirror();
      for (const m of rig.msgs) mirror.apply(m);
      rig.msgs.length = 0;
      const eco = rig.engine.ecology;
      if (!eco) throw new Error('no ecology');
      // The life simulation fails on its first 19 work slices and terrain reports.
      const work = eco.work.bind(eco);
      const changed = eco.onTerrainChanged.bind(eco);
      let faults = 19;
      let terrainFaults = 19;
      eco.work = (ms) => {
        if (faults-- > 0) throw new Error('test fault in the life simulation');
        return work(ms);
      };
      eco.onTerrainChanged = (i0, k0, i1, k1, flags) => {
        if (terrainFaults-- > 0) throw new Error('test fault in the life simulation');
        changed(i0, k0, i1, k1, flags);
      };
      const before = rig.cols.hash();
      const ticks = 30;
      rig.stroke('start', 'lava', SLOPE.x, SLOPE.z, 10);
      let thrown = 0;
      for (let n = 0; n < ticks; n++) {
        scriptLava(rig.cols, SLOPE.x + n * 0.5, SLOPE.z, 8, 0.05);
        try {
          rig.engine.tick(TICK_ACTIVE, WORKER_TICK_BUDGET_MS);
        } catch {
          thrown++;
        }
      }
      rig.stroke('end', 'lava', SLOPE.x, SLOPE.z, 10);
      const tickMsgs = rig.of('tick').length;
      const errors = rig.of('error').length;
      // The real lava keeps flowing for a while and the stream sends changes in small, throttled
      // pieces, so let the lava settle and give the stream time to catch up before comparing.
      rig.debug('settle');
      let mirrored = false;
      for (let s = 0; s < 12 && !mirrored; s++) {
        rig.run(1);
        for (const m of rig.msgs) mirror.apply(m);
        rig.msgs.length = 0;
        mirrored = mirror.diff(rig.cols) === 0;
      }
      const poured = rig.cols.hash() !== before;
      rig.send({ t: 'undo' });
      const undone = rig.cols.hash() === before;
      eco.work = work;
      eco.onTerrainChanged = changed;
      const pass = thrown === 0 && tickMsgs === ticks && errors >= 1 && mirrored && poured && undone;
      return {
        pass,
        detail: `${thrown} ticks failed, ${tickMsgs} of ${ticks} tick messages sent, ${errors} error reported; screen copy ${mirrored ? 'matches' : 'DIFFERS'}; ground ${poured ? 'changed' : 'UNCHANGED'} by the pour and ${undone ? 'exactly restored' : 'NOT restored'} by undo`,
      };
    },
  },
  {
    id: 'mirror',
    label: "The screen's copy of the ground matches the engine after many strokes",
    quick: false,
    run() {
      const rig = new Rig();
      const mirror = new Mirror();
      rig.send({ t: 'init', save: null, seed: 3, settings: { pace: 'normal', gentleStorms: false } });
      rig.load();
      rig.debug('demoChain');
      rig.debug('settle');
      holdYears(rig);
      const rand = mulberry32(11);
      const tools: ToolId[] = ['lava', 'rock', 'sand', 'hands', 'scoop'];
      const consume = (): void => {
        for (const m of rig.msgs) mirror.apply(m);
        rig.msgs.length = 0;
      };
      for (let s = 0; s < 12; s++) {
        const isl = DEMO_ISLANDS[Math.floor(rand() * DEMO_ISLANDS.length)];
        const a = rand() * Math.PI * 2;
        const x = isl.x + Math.cos(a) * isl.r * 0.7 * rand();
        const z = isl.z + Math.sin(a) * isl.r * 0.7 * rand();
        const tool = tools[Math.floor(rand() * tools.length)];
        rig.stroke('start', tool, x, z, 4 + rand() * 10);
        rig.run(0.2 + rand() * 0.8, TICK_ACTIVE, (t) => {
          rig.stroke('move', tool, x + t * 6, z - t * 3, 6);
          if (tool === 'lava') scriptLava(rig.cols, x + t * 6, z - t * 3, 5, 0.04);
          consume();
        });
        rig.stroke('end', tool, x, z, 6);
        rig.run(0.3, TICK_ACTIVE, consume);
      }
      rig.debug('settle');
      // Freeze everything (as when the page is hidden) and let the streams catch up.
      rig.send({ t: 'pause', on: true, hidden: true });
      rig.run(3, TICK_ACTIVE, consume);
      consume();
      const diff = mirror.diff(rig.cols);
      return { pass: diff === 0, detail: `${diff} of ${NX * NZ} columns differ after 12 random strokes` };
    },
  },
  {
    id: 'lava-stream-rate',
    label: 'Flowing lava keeps the screen updated at least twice a second, and quiet changes at most 4 times',
    quick: false,
    run() {
      const rig = Rig.start({ demo: true });
      holdYears(rig);
      rig.run(1);
      rig.msgs.length = 0;
      const covers = (m: Msg<'cols'>, x: number, z: number): boolean => {
        const c = rig.cols.colAt(x, z);
        const i = c % NX;
        const k = (c / NX) | 0;
        return i >= m.x0 && i < m.x0 + m.w && k >= m.z0 && k < m.z0 + m.h;
      };
      const seconds = 6;
      rig.stroke('start', 'lava', SLOPE.x, SLOPE.z, 12);
      rig.run(seconds, TICK_ACTIVE, (t) => scriptLava(rig.cols, SLOPE.x + 3 * Math.sin(t * 2), SLOPE.z, 10, 0.03));
      rig.stroke('end', 'lava', SLOPE.x, SLOPE.z, 12);
      const active = rig.of('cols').filter((m) => covers(m, SLOPE.x, SLOPE.z)).length / seconds;
      rig.debug('settle');
      rig.run(1);
      rig.msgs.length = 0;
      // Quiet changes (nothing moving, no stroke): at most 4 sends a second.
      rig.run(seconds, TICK_ACTIVE, () => {
        const c = rig.cols.colAt(ISLET.x, ISLET.z);
        rig.cols.sandKind[c] = (rig.cols.sandKind[c] + 4) & 255;
        const i = c % NX;
        const k = (c / NX) | 0;
        rig.cols.markChanged(i, k, i, k, ChangeFlag.Look);
      });
      const quiet = rig.of('cols').filter((m) => covers(m, ISLET.x, ISLET.z)).length / seconds;
      return { pass: active >= 2 && quiet <= 4.01 && quiet >= 2, detail: `${active.toFixed(1)} updates a second over flowing lava; ${quiet.toFixed(1)} a second for quiet changes` };
    },
  },
  {
    id: 'stream-tiles',
    label: 'Changes far apart are sent as small separate pieces, never one huge rectangle',
    quick: true,
    run() {
      const t = new DirtyTiles(NX, NZ);
      t.mark(10, 10, 14, 13);
      t.mark(480, 490, 482, 491);
      const rects: number[][] = [];
      t.flush((x0, z0, w, h) => rects.push([x0, z0, w, h]), Number.POSITIVE_INFINITY);
      const area = rects.reduce((s, r) => s + r[2] * r[3], 0);
      // A whole row of tiles goes as one band.
      t.mark(0, 64, NX - 1, 95);
      const bands: number[][] = [];
      t.flush((x0, z0, w, h) => bands.push([x0, z0, w, h]), Number.POSITIVE_INFINITY);
      const pass = rects.length === 2 && area === 5 * 4 + 3 * 2 && bands.length === 1 && bands[0][2] === NX && bands[0][3] === 32;
      return { pass, detail: `${rects.length} pieces covering ${area} columns; a full row went as ${bands.length} message` };
    },
  },
  {
    id: 'tick-budget',
    timing: true,
    label: 'One engine tick stays within its time budget on a busy scene',
    quick: false,
    run() {
      const rig = Rig.start({ demo: true });
      rig.debug('advanceYears', { arg: 50 });
      rig.run(1);
      // The tick's own budgets (geology + ecology + packing) plus 4 ms of slack, judged at
      // the 99th percentile of 200 ticks. A rare pause from the JavaScript memory clean-up
      // (garbage collection) or from the operating system giving the processor to another
      // program is outside the engine's control; a tick that is slow because of the engine's
      // own work is slow every time. For the same reason a run spoiled by a busy machine is
      // tried again, up to three runs: a really slow engine fails all three.
      const limit = rig.engine.tickBudgetMs + 4;
      const runs: TickTimes[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = benchTicks(rig, 200);
        runs.push(r);
        if (r.p99 <= limit) break;
      }
      const last = runs[runs.length - 1];
      const shown = runs.map((r) => `median ${r.median.toFixed(2)} ms, 99% under ${r.p99.toFixed(2)} ms, worst ${r.worst.toFixed(2)} ms`).join('; then ');
      return {
        pass: last.p99 <= limit,
        detail: `${shown} (200 ticks per run; limit ${limit} ms = budget ${rig.engine.tickBudgetMs} ms + 4)`,
      };
    },
  },
]);
