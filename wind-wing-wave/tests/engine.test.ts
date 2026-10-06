/**
 * Engine hub tests: streams, save format edge cases, undo through messages, the message
 * order the page relies on, pausing, and the worker-with-page-fallback host.
 * (The bigger end-to-end checks live in src/checks/engineChecks.ts and run via checks.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NP, NX, NZ, PACE_YPS } from '../src/config';
import { PatchGrid } from '../src/eco/patches';
import { ChangeFlag, Columns } from '../src/engine/columns';
import { Engine, TICK_ACTIVE, TICK_IDLE } from '../src/engine/engine';
import { Geo } from '../src/engine/geo/geo';
import { startEngine } from '../src/engine/host';
import type { FromEngine, ToEngine } from '../src/engine/protocol';
import { SAVE_ERRORS, SaveError, applyFields, crc32, decodeRaw, decodeSave, encodeRaw } from '../src/engine/save';
import { DirtyTiles, RateLimit } from '../src/engine/streams';
import { UndoStack } from '../src/engine/undo';
import { Mirror, Rig, scriptLava, scriptedGrid, scriptedSaveSource } from '../src/checks/engineChecks';

const SLOPE = { x: 110, z: 10 };

async function deflate(raw: Uint8Array): Promise<ArrayBuffer> {
  return new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
}

/** Re-stamp the checksum after editing a raw save on purpose (the SUM section is the last 12 bytes). */
function reseal(raw: Uint8Array): Uint8Array {
  new DataView(raw.buffer, raw.byteOffset, raw.byteLength).setUint32(raw.length - 4, crc32(raw.subarray(0, raw.length - 12)), true);
  return raw;
}

async function saveError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SaveError);
    return (err as Error).message;
  }
  throw new Error('expected the save to be refused');
}

describe('dirty tiles', () => {
  it('keeps distant changes apart and joins a full row into one band', () => {
    const t = new DirtyTiles(NX, NZ);
    t.mark(3, 3, 5, 5);
    t.mark(500, 3, 505, 4);
    const rects: number[][] = [];
    t.flush((...r) => rects.push(r), Infinity);
    expect(rects).toEqual([
      [3, 3, 3, 3],
      [500, 3, 6, 2],
    ]);
    t.mark(0, 32, NX - 1, 63);
    rects.length = 0;
    t.flush((...r) => rects.push(r), Infinity);
    expect(rects).toEqual([[0, 32, NX, 32]]);
  });

  it('joins neighbouring tiles only when little is wasted', () => {
    const t = new DirtyTiles(NX, NZ);
    // Two small changes either side of a tile edge: joined.
    t.mark(30, 10, 33, 12);
    // Two thin changes in neighbouring tiles at opposite ends of the row: kept apart.
    t.mark(64, 64, 65, 64);
    t.mark(126, 95, 127, 95);
    const rects: number[][] = [];
    t.flush((...r) => rects.push(r), Infinity);
    expect(rects).toEqual([
      [30, 10, 4, 3],
      [64, 64, 2, 1],
      [126, 95, 2, 1],
    ]);
  });

  it('clamps to the grid and ignores empty rectangles', () => {
    const t = new DirtyTiles(NP, NP);
    t.mark(-10, -10, 2, 2);
    t.mark(300, 300, 400, 400);
    t.mark(5, 5, 4, 4);
    const rects: number[][] = [];
    t.flush((...r) => rects.push(r), Infinity);
    expect(rects).toEqual([[0, 0, 3, 3]]);
  });

  it('sends at least one piece when out of time, and resumes where it stopped', () => {
    const t = new DirtyTiles(NX, NZ);
    for (let row = 0; row < 4; row++) t.mark(0, row * 32, 10, row * 32);
    const sent: number[] = [];
    expect(t.flush((_x, z) => sent.push(z), 0)).toBe(1);
    expect(t.dirtyTiles).toBe(3);
    t.flush((_x, z) => sent.push(z), 0);
    t.flush((_x, z) => sent.push(z), Infinity);
    expect(sent).toEqual([0, 32, 64, 96]);
    expect(t.dirtyTiles).toBe(0);
  });

  it('rate limit: at most once per interval, ready again after a quiet spell', () => {
    const r = new RateLimit();
    expect(r.ready(0.25)).toBe(true);
    r.sent();
    r.advance(0.1);
    expect(r.ready(0.25)).toBe(false);
    r.advance(0.15);
    expect(r.ready(0.25)).toBe(true);
  });
});

describe('save format', () => {
  it('rounds every lava temperature step exactly, clamps wild values, and re-saves identically', () => {
    const src = scriptedSaveSource();
    for (let q = 0; q < 256; q++) src.cols.temp[q] = q / 255;
    src.cols.rock[300] = 1000;
    src.cols.rock[301] = Number.NaN;
    src.cols.sed[302] = -2;
    const d = decodeRaw(encodeRaw(src));
    for (let q = 0; q < 256; q++) expect(Math.round(d.cols.temp[q] * 255)).toBe(q);
    expect(d.cols.rock[300]).toBeCloseTo(32767 / 128, 6);
    expect(d.cols.rock[301]).toBe(-256);
    expect(d.cols.sed[302]).toBe(0);
    const second = encodeRaw({ header: d.header, cols: d.cols, grid: withFields(d.fields), eco: d.eco });
    const d2 = decodeRaw(second);
    const third = encodeRaw({ header: d2.header, cols: d2.cols, grid: withFields(d2.fields), eco: d2.eco });
    expect(Buffer.from(second).equals(Buffer.from(third))).toBe(true);
  });

  it('refuses foreign, newer, cut-short and odd-sized files with plain messages', async () => {
    const raw = encodeRaw(scriptedSaveSource());
    expect(await saveError(decodeSave(await deflate(new TextEncoder().encode('{"not":"a save"}'))))).toBe(SAVE_ERRORS.notASave);
    expect(await saveError(decodeSave(new Uint8Array([1, 2, 3, 4, 5, 6]).buffer))).toBe(SAVE_ERRORS.notASave);
    const newer = raw.slice();
    newer[4] = 99;
    expect(await saveError(decodeSave(await deflate(newer)))).toBe(SAVE_ERRORS.newer);
    for (const cut of [8, 40, 300, raw.length >> 1, raw.length - 1]) {
      expect(() => decodeRaw(raw.subarray(0, cut))).toThrow(SaveError);
    }
    // nx stored as 256 instead of 512.
    const dv = new DataView(raw.buffer);
    const headerLen = dv.getUint32(6, true);
    const other = raw.slice();
    new DataView(other.buffer).setUint32(10 + headerLen + 8, 256, true);
    expect(() => decodeRaw(other)).toThrow(SAVE_ERRORS.damaged);
    expect(() => decodeRaw(reseal(other))).toThrow(SAVE_ERRORS.otherSize);
  });

  it('refuses a file whose bytes changed anywhere, even when everything else still fits', () => {
    const raw = encodeRaw(scriptedSaveSource());
    // One bit in the middle of the ground, in the life fields, and in the checksum itself.
    for (const at of [raw.length >> 1, raw.length - 40, raw.length - 2]) {
      const bad = raw.slice();
      bad[at] ^= 8;
      expect(() => decodeRaw(bad)).toThrow(SAVE_ERRORS.damaged);
    }
    // The checksum section missing altogether (a file from before it, or cut exactly there).
    expect(() => decodeRaw(raw.subarray(0, raw.length - 12))).toThrow(SAVE_ERRORS.damaged);
  });

  it('skips sections it does not know (added by later versions)', () => {
    const raw = encodeRaw(scriptedSaveSource());
    // An extra section goes before the checksum, which is always last.
    const body = raw.length - 12;
    const extra = new Uint8Array(raw.length + 8 + 5);
    extra.set(raw.subarray(0, body));
    const dv = new DataView(extra.buffer);
    dv.setUint32(body, 0x57454e21, true);
    dv.setUint32(body + 4, 5, true);
    extra.set(raw.subarray(body), body + 8 + 5);
    const d = decodeRaw(reseal(extra));
    expect(d.header.seed).toBe(42);
  });

  it('a save without page state opens, with no page state', () => {
    const src = scriptedSaveSource();
    const header = { ...src.header } as Partial<typeof src.header>;
    delete header.page; // as JSON.stringify writes a header whose page is undefined
    const d = decodeRaw(encodeRaw({ ...src, header: header as typeof src.header }));
    expect(d.header.page).toBeNull();
    expect(d.header.seed).toBe(42);
  });

  it('refuses a file that unpacks to something enormous', async () => {
    const huge = await deflate(new Uint8Array(100 * 1024 * 1024));
    expect(await saveError(decodeSave(huge))).toBe(SAVE_ERRORS.tooBig);
  }, 30_000);

  it('life fields: unknown ones are ignored, mismatched ones refused before anything is copied', () => {
    const src = scriptedSaveSource();
    const d = decodeRaw(encodeRaw(src));
    const fewer = new PatchGrid();
    const cover = fewer.add('cover', (n) => new Float32Array(n));
    applyFields(fewer, d.fields);
    expect(Array.from(cover.subarray(0, 4))).toEqual(Array.from(src.grid.get<Float32Array>('cover').subarray(0, 4)));
    const wrong = new PatchGrid();
    const a = wrong.add('cover', (n) => new Float32Array(n));
    wrong.add('species', (n) => new Uint16Array(n), true, 3);
    expect(() => applyFields(wrong, d.fields)).toThrow(SAVE_ERRORS.lifeMismatch);
    expect(a.every((v) => v === 0)).toBe(true);
  });
});

function withFields(fields: ReturnType<typeof decodeRaw>['fields']): PatchGrid {
  const g = scriptedGrid();
  applyFields(g, fields);
  return g;
}

describe('engine messages', () => {
  it('a new sea: clear, progress bands, the journal, then ready', () => {
    const rig = Rig.start();
    const kinds = rig.msgs.map((m) => m.t);
    expect(kinds[0]).toBe('clear');
    expect(kinds[kinds.length - 1]).toBe('ready');
    expect(rig.of('cols').length).toBe(NZ / 32);
    expect(rig.of('eco').length).toBe(NP / 32);
    const progress = rig.of('progress');
    expect(progress[0].done).toBe(0);
    expect(progress[progress.length - 1].done).toBe(progress[0].total);
    const journal = rig.of('journal');
    expect(journal.length).toBe(1);
    expect(journal[0].reset).toBe(true);
    const ready = rig.of('ready')[0];
    expect(ready.resumed).toBe(false);
    expect(ready.year).toBe(0);
    // The full resend covers every column exactly once.
    const covered = rig.of('cols').reduce((s, m) => s + m.w * m.h, 0);
    expect(covered).toBe(NX * NZ);
  });

  it('strokes before ready, and Look strokes, never make undo records', () => {
    const rig = new Rig();
    rig.send({ t: 'init', save: null, seed: 1, settings: { pace: 'normal', gentleStorms: false } });
    rig.stroke('start', 'lava', 0, 0);
    rig.load();
    rig.stroke('start', 'look', 0, 0);
    rig.run(0.2);
    rig.stroke('end', 'look', 0, 0);
    rig.run(0.2);
    expect(rig.undoCount).toBe(0);
    expect(rig.of('tick').every((m) => m.events.pour === null)).toBe(true);
  });

  it('cancel undoes the stroke; undo while holding ends the stroke', () => {
    const rig = Rig.start({ demo: true });
    rig.send({ t: 'pause', on: true, hidden: false });
    const before = rig.cols.hash();
    rig.stroke('start', 'lava', SLOPE.x, SLOPE.z);
    scriptLava(rig.cols, SLOPE.x, SLOPE.z, 8, 1);
    rig.run(0.3);
    expect(rig.engine.tickInterval()).toBe(TICK_ACTIVE);
    rig.stroke('cancel', 'lava', SLOPE.x, SLOPE.z);
    expect(rig.cols.hash()).toBe(before);
    rig.run(0.2);
    expect(rig.undoCount).toBe(0);

    rig.stroke('start', 'sand', SLOPE.x, SLOPE.z);
    scriptLava(rig.cols, SLOPE.x, SLOPE.z, 8, 1);
    rig.run(0.2);
    rig.send({ t: 'undo' });
    expect(rig.cols.hash()).toBe(before);
    // The stroke is over: later moves do nothing and nothing more is recorded.
    rig.stroke('move', 'sand', SLOPE.x + 5, SLOPE.z);
    rig.msgs.length = 0;
    rig.run(0.2);
    expect(rig.undoCount).toBe(0);
    expect(rig.of('tick').every((m) => m.events.pour === null)).toBe(true);
    rig.send({ t: 'debug', id: 1, op: 'settle' });
    expect(rig.engine.tickInterval()).toBe(TICK_IDLE);
  });

  it('a held stroke is reported for pour visuals and its burned ground counted', () => {
    const rig = Rig.start({ demo: true });
    rig.stroke('start', 'lava', SLOPE.x, SLOPE.z, 9);
    rig.msgs.length = 0;
    scriptLava(rig.cols, SLOPE.x, SLOPE.z, 8, 0.5);
    rig.run(TICK_ACTIVE);
    const tick = rig.of('tick')[0];
    expect(tick.events.pour?.tool).toBe('lava');
    expect(tick.events.pour?.r).toBe(9);
    expect(tick.events.pour?.y).toBeCloseTo(rig.cols.heightAt(SLOPE.x, SLOPE.z), 5);
    expect(tick.events.burned).toBeGreaterThan(0);
  });

  it('undo brings back life the stroke buried (through the ecology merge)', () => {
    const rig = Rig.start({ demo: true });
    rig.send({ t: 'pause', on: true, hidden: false });
    const life = rig.grid.add('test-cover', (n) => new Float32Array(n));
    const p = PatchGrid.ofColumn(rig.cols.colAt(SLOPE.x, SLOPE.z) % NX, (rig.cols.colAt(SLOPE.x, SLOPE.z) / NX) | 0);
    life[p] = 0.8;
    rig.stroke('start', 'lava', SLOPE.x, SLOPE.z);
    scriptLava(rig.cols, SLOPE.x, SLOPE.z, 8, 1);
    life[p] = 0; // burned
    rig.stroke('end', 'lava', SLOPE.x, SLOPE.z);
    rig.debug('settle');
    rig.send({ t: 'undo' });
    expect(life[p]).toBeCloseTo(0.8, 6);
  });

  it('pause: the year clock stops when paused, physics stops when hidden, pace follows settings', () => {
    const rig = Rig.start({ demo: true });
    rig.run(1);
    const y1 = rig.of('tick').at(-1)!.year;
    expect(y1).toBeGreaterThan(0);
    rig.send({ t: 'pause', on: true, hidden: false });
    rig.run(1);
    expect(rig.of('tick').at(-1)!.year).toBe(y1);
    expect(rig.of('tick').at(-1)!.paused).toBe(true);
    rig.send({ t: 'pause', on: false, hidden: false });
    rig.send({ t: 'settings', settings: { pace: 'brisk', gentleStorms: false } });
    const before = rig.of('tick').at(-1)!.year;
    rig.run(2);
    expect(rig.of('tick').at(-1)!.year - before).toBeGreaterThanOrEqual(PACE_YPS.brisk * 2 - 1);
    rig.send({ t: 'pause', on: true, hidden: true });
    rig.stroke('start', 'lava', SLOPE.x, SLOPE.z);
    expect(rig.engine.tickInterval()).toBe(TICK_IDLE);
  });

  it('page mode hands over fresh event objects every tick; a worker reuses them', () => {
    for (const page of [false, true]) {
      const rig = Rig.start({ page });
      rig.msgs.length = 0;
      rig.run(TICK_ACTIVE * 2);
      const [a, b] = rig.of('tick');
      expect(a.events === b.events).toBe(!page);
      expect(a.perf === b.perf).toBe(!page);
    }
  });

  it('every debug op answers, and inspect answers with its id', () => {
    const rig = Rig.start({ demo: true });
    for (const op of ['advanceYears', 'stormNow', 'stats', 'hash', 'pour', 'settle', 'demoChain'] as const) {
      const r = rig.debug(op, op === 'pour' ? { tool: 'sand', x: SLOPE.x, z: SLOPE.z, radius: 6, seconds: 0.5 } : {});
      expect(r.ok, op).toBe(true);
    }
    const stats = rig.debug('stats') as { memoryMB: { columns: number } };
    expect(stats.memoryMB.columns).toBeGreaterThan(4);
    rig.send({ t: 'inspect', id: 77, x: SLOPE.x, z: SLOPE.z });
    expect(rig.of('inspected').find((m) => m.id === 77)?.info.height).toBeCloseTo(rig.cols.heightAt(SLOPE.x, SLOPE.z), 5);
  });

  it('save while loading is refused; a reset during a slow load wins and the load is answered', async () => {
    const rig = Rig.start({ demo: true });
    rig.send({ t: 'save', id: 1, header: { camera: [], dayPhase: 0 } });
    const saved = await new Promise<ArrayBuffer>((resolve) => {
      const wait = (): void => {
        const s = rig.of('saved').find((m) => m.id === 1);
        if (s?.data) resolve(s.data);
        else setTimeout(wait, 5);
      };
      wait();
    });
    rig.send({ t: 'reset', seed: 9 });
    rig.send({ t: 'save', id: 2, header: { camera: [], dayPhase: 0 } });
    expect(rig.of('saved').find((m) => m.id === 2)?.error).toBeTruthy();
    rig.load();
    rig.send({ t: 'load', id: 3, data: saved });
    rig.send({ t: 'reset', seed: 10 });
    await rig.loadAsync();
    await new Promise((r) => setTimeout(r, 300));
    const loaded = rig.of('loaded').find((m) => m.id === 3);
    expect(loaded?.ok).toBe(false);
    expect(rig.of('ready').at(-1)?.resumed).toBe(false);
  });

  it('streams quiet ground changes to the page copy', () => {
    const rig = new Rig();
    const mirror = new Mirror();
    rig.send({ t: 'init', save: null, seed: 1, settings: { pace: 'normal', gentleStorms: false } });
    rig.load();
    const c = rig.cols;
    for (const [i, k] of [
      [3, 3],
      [400, 9],
      [250, 500],
    ]) {
      c.rock[c.index(i, k)] = 12;
      c.markChanged(i, k, i, k, ChangeFlag.Geom);
    }
    rig.run(0.5);
    for (const m of rig.msgs) mirror.apply(m);
    expect(mirror.diff(c)).toBe(0);
    // Three small messages, not one covering the sea between them.
    const last = rig.msgs.filter((m): m is Extract<FromEngine, { t: 'cols' }> => m.t === 'cols').slice(-3);
    expect(last.every((m) => m.w * m.h === 1)).toBe(true);
  });
});

describe('undo records', () => {
  it('a stroke that changed no ground leaves no record, and never pushes out a real one', () => {
    const cols = new Columns();
    const undo = new UndoStack(cols, scriptedGrid(), 3);
    const c = cols.index(40, 40);
    undo.begin();
    cols.touch(c);
    cols.rock[c] = 2;
    for (let s = 0; s < 5; s++) {
      undo.begin();
      expect(undo.count).toBe(1); // the open, still-empty record isn't counted
    }
    undo.close();
    expect(undo.count).toBe(1);
    expect(undo.bytes).toBeGreaterThan(0);
    // One press undoes the real stroke, even straight after an empty one.
    undo.begin();
    expect(undo.undo((_n, snap) => snap)).toEqual([2 + 2 * 32]);
    expect(cols.rock[c]).toBe(0);
    expect(undo.count).toBe(0);
    expect(undo.bytes).toBe(0);
  });

  it('copies the life under a reported change wider than the ground written', () => {
    const rig = Rig.start({ demo: true });
    rig.send({ t: 'pause', on: true, hidden: false });
    const life = rig.grid.add('test-cover', (n) => new Float32Array(n));
    // Stand-in for an ecology that burns life over the whole reported rectangle.
    rig.cols.addListener((i0, k0, i1, k1, flags) => {
      if (!(flags & ChangeFlag.Burn)) return;
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) life[PatchGrid.ofColumn(i, k)] = 0;
    });
    const c = rig.cols.colAt(SLOPE.x, SLOPE.z);
    const [ci, ck] = [c % NX, (c / NX) | 0];
    const far = PatchGrid.ofColumn(ci + 40, ck + 40); // two blocks away: the stroke never writes there
    life[far] = 0.6;
    rig.stroke('start', 'lava', SLOPE.x, SLOPE.z);
    rig.cols.touch(c);
    rig.cols.lava[c] += 1;
    rig.cols.markChanged(ci, ck, ci + 40, ck + 40, ChangeFlag.Geom | ChangeFlag.Burn | ChangeFlag.Tool);
    expect(life[far]).toBe(0);
    rig.stroke('end', 'lava', SLOPE.x, SLOPE.z);
    rig.debug('settle');
    rig.send({ t: 'undo' });
    expect(life[far]).toBeCloseTo(0.6, 6);
  });

  it('through messages: empty strokes are not counted, and cancelling one keeps the stroke before it', () => {
    const rig = Rig.start({ demo: true });
    rig.send({ t: 'pause', on: true, hidden: false });
    const before = rig.cols.hash();
    rig.stroke('start', 'sand', SLOPE.x, SLOPE.z);
    scriptLava(rig.cols, SLOPE.x, SLOPE.z, 8, 1);
    rig.stroke('end', 'sand', SLOPE.x, SLOPE.z);
    rig.run(0.2);
    const poured = rig.cols.hash();
    for (let s = 0; s < 3; s++) {
      rig.stroke('start', 'hands', SLOPE.x, SLOPE.z);
      rig.run(0.2);
      rig.stroke('end', 'hands', SLOPE.x, SLOPE.z);
      rig.run(0.2);
    }
    expect(rig.undoCount).toBe(1);
    rig.stroke('start', 'scoop', SLOPE.x, SLOPE.z);
    rig.run(0.1);
    rig.stroke('cancel', 'scoop', SLOPE.x, SLOPE.z);
    expect(rig.cols.hash()).toBe(poured);
    rig.send({ t: 'undo' });
    expect(rig.cols.hash()).toBe(before);
  });
});

describe('loading order and failures', () => {
  const settings = { pace: 'normal', gentleStorms: false } as const;

  it('a bad load while the starting save decodes never leaves the game without a sea', async () => {
    const src = Rig.start({ demo: true });
    src.send({ t: 'save', id: 1, header: { camera: [], dayPhase: 0 } });
    await vi.waitFor(() => expect(src.of('saved')[0]?.data).toBeTruthy());
    const good = src.of('saved')[0].data!;
    const rig = new Rig();
    rig.send({ t: 'init', save: good, seed: 2, settings });
    rig.send({ t: 'load', id: 5, data: new Uint8Array([9, 9, 9, 9, 9, 9, 9]).buffer });
    await rig.loadAsync();
    expect(rig.of('loaded').find((m) => m.id === 5)?.ok).toBe(false);
    expect(rig.of('ready').at(-1)?.resumed).toBe(true);
    expect(rig.cols.hash()).toBe((await decodeSave(good)).cols.hash());
  });

  it('a later good load wins over a starting save that finishes after it', async () => {
    const a = Rig.start({ demo: true });
    a.send({ t: 'save', id: 1, header: { camera: [1], dayPhase: 0 } });
    const b = Rig.start({ seed: 7 });
    b.send({ t: 'save', id: 1, header: { camera: [2], dayPhase: 0 } });
    await vi.waitFor(() => expect(a.of('saved')[0]?.data && b.of('saved')[0]?.data).toBeTruthy());
    const rig = new Rig();
    rig.send({ t: 'init', save: a.of('saved')[0].data!, seed: 2, settings });
    rig.send({ t: 'load', id: 6, data: b.of('saved')[0].data! });
    await vi.waitFor(() => expect(rig.of('loaded').length).toBe(1));
    await rig.loadAsync();
    await new Promise((r) => setTimeout(r, 50));
    rig.load();
    expect(rig.of('loaded')[0].ok).toBe(true);
    expect(rig.of('ready').at(-1)?.header?.camera).toEqual([2]);
    expect(rig.cols.hash()).toBe((await decodeSave(b.of('saved')[0].data!)).cols.hash());
  });

  it('a save made with no page header can be opened again', async () => {
    const rig = Rig.start({ demo: true });
    rig.send({ t: 'save', id: 1, header: undefined as unknown as { camera: number[]; dayPhase: number } });
    await vi.waitFor(() => expect(rig.of('saved')[0]).toBeTruthy());
    const data = rig.of('saved')[0].data;
    expect(data).toBeTruthy();
    const d = await decodeSave(data!);
    expect(d.header.page).toBeNull();
  });

  it('a first sea that cannot be built is fatal when asked (a worker hands over to the page), otherwise reported', () => {
    const spy = vi.spyOn(Geo.prototype, 'generateSeabed').mockImplementation(() => {
      throw new Error('no memory for the seabed');
    });
    try {
      const fatal: unknown[] = [];
      const msgs: FromEngine[] = [];
      const e = new Engine((m) => msgs.push(m), { onFatal: (err) => fatal.push(err) });
      e.handle({ t: 'init', save: null, seed: 1, settings });
      expect(fatal.length).toBe(1);
      expect(msgs.some((m) => m.t === 'clear' || m.t === 'ready')).toBe(false);
      const page: FromEngine[] = [];
      new Engine((m) => page.push(m)).handle({ t: 'init', save: null, seed: 1, settings });
      expect(page.map((m) => m.t)).toEqual(['error']);
    } finally {
      spy.mockRestore();
    }
  });

  it('after the first sea, a reset that cannot be built keeps the current sea (and is not fatal)', () => {
    const fatal: unknown[] = [];
    const msgs: FromEngine[] = [];
    const e = new Engine((m) => msgs.push(m), { onFatal: (err) => fatal.push(err) });
    e.handle({ t: 'init', save: null, seed: 1, settings });
    for (let i = 0; i < 50 && !e.isReady; i++) e.tick(TICK_ACTIVE, 40);
    e.handle({ t: 'debug', id: 1, op: 'demoChain' });
    const hash = e.columns!.hash();
    const spy = vi.spyOn(Geo.prototype, 'generateSeabed').mockImplementation(() => {
      throw new Error('no memory for the seabed');
    });
    try {
      e.handle({ t: 'reset', seed: 4 });
    } finally {
      spy.mockRestore();
    }
    expect(fatal.length).toBe(0);
    expect(e.isReady).toBe(true);
    expect(e.columns!.hash()).toBe(hash);
    expect(msgs.filter((m) => m.t === 'error').length).toBe(1);
  });
});

describe('host', () => {
  const g = globalThis as unknown as { Worker?: unknown; __WORKER_SOURCE__?: string };
  afterEach(() => {
    delete g.Worker;
    delete g.__WORKER_SOURCE__;
  });

  it('runs the engine on the page when there is no background thread', async () => {
    const got: FromEngine[] = [];
    const host = await startEngine((m) => got.push(m));
    expect(host.mode).toBe('page');
    host.send({ t: 'init', save: null, seed: 1, settings: { pace: 'normal', gentleStorms: false } });
    for (let i = 0; i < 100 && !got.some((m) => m.t === 'ready'); i++) host.tick(1 / 60);
    expect(got.some((m) => m.t === 'ready')).toBe(true);
  });

  it('on the page, the engine keeps its own pace once the sea is ready (not every frame)', async () => {
    const got: FromEngine[] = [];
    const host = await startEngine((m) => got.push(m));
    host.send({ t: 'init', save: null, seed: 1, settings: { pace: 'normal', gentleStorms: false } });
    for (let i = 0; i < 100 && !got.some((m) => m.t === 'ready'); i++) host.tick(1 / 60);
    const ticks = (): number => got.filter((m) => m.t === 'tick').length;
    const idle0 = ticks();
    for (let f = 0; f < 120; f++) host.tick(1 / 60); // two quiet seconds
    expect(ticks() - idle0).toBeGreaterThanOrEqual(18);
    expect(ticks() - idle0).toBeLessThanOrEqual(21);
    host.send({ t: 'stroke', phase: 'start', tool: 'lava', x: 0, z: 0, radius: 8, strength: 1 });
    const busy0 = ticks();
    for (let f = 0; f < 60; f++) host.tick(1 / 60); // one second holding a stroke
    expect(ticks() - busy0).toBeGreaterThanOrEqual(28);
    expect(ticks() - busy0).toBeLessThanOrEqual(31);
  });

  it('falls back to the page if the background thread fails before the sea is ready', async () => {
    const sent: ToEngine[] = [];
    let live: FakeWorker | null = null;
    class FakeWorker {
      onmessage: ((e: { data: FromEngine }) => void) | null = null;
      onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() {
        live = this;
        queueMicrotask(() => this.onmessage?.({ data: { t: 'hello' } }));
      }
      postMessage(m: ToEngine): void {
        sent.push(m);
      }
      terminate(): void {
        this.terminated = true;
      }
    }
    g.Worker = FakeWorker;
    g.__WORKER_SOURCE__ = '/* worker */';
    const got: FromEngine[] = [];
    const host = await startEngine((m) => got.push(m));
    expect(host.mode).toBe('worker');
    host.send({ t: 'init', save: null, seed: 4, settings: { pace: 'gentle', gentleStorms: true } });
    host.send({ t: 'focus', x: 0, z: 0, dist: 300, dayPhase: 0.5, season: 'dry' });
    expect(sent.map((m) => m.t)).toEqual(['init', 'focus']);
    const w = live as unknown as FakeWorker;
    w.onmessage?.({ data: { t: 'progress', done: 1, total: 24 } });
    w.onerror?.({ message: 'out of memory', preventDefault() {} });
    expect(w.terminated).toBe(true);
    expect(host.mode).toBe('page');
    for (let i = 0; i < 100 && !got.some((m) => m.t === 'ready'); i++) host.tick(1 / 60);
    const ready = got.find((m) => m.t === 'ready');
    expect(ready).toBeTruthy();
    // Late messages from the failed thread are ignored.
    const n = got.length;
    w.onmessage?.({ data: { t: 'progress', done: 2, total: 24 } });
    expect(got.length).toBe(n);
  });
});
