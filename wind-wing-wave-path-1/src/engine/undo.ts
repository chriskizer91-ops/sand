/**
 * Undo: each stroke opens a record. The first time a 16 x 16 block of columns changes
 * while the record is open (from the tool itself, or from the lava and sand it sets moving),
 * we keep a copy of that block, and of the life in the same 32 m square, taken before
 * anything is written. Undo puts those copies back, so a lava mistake brings the forest
 * back too.
 *
 * - A record closes when its stroke has ended and everything has settled (the engine
 *   decides, ARCHITECTURE §5.4). After that, nothing more is added to it: natural changes
 *   made later are never undone.
 * - A record that changed no ground (Hands on ground that is already smooth, Scoop at the
 *   lowest it may dig, a stroke faded to nothing at the edge of the sea) is dropped when it
 *   closes and isn't counted while open. So pressing Undo always takes back something you
 *   can see, and empty records never push real ones out of the 20 kept.
 * - Only the stroke is recorded. While the ecology works (soil, coast, reef, storms), the
 *   engine pauses recording, so those writes never enter a record.
 * - The life grid is never recorded on its own (its own `recordId` stays -1): the ecology
 *   writes to it all the time, and recording that would copy the whole grid every stroke.
 *   Instead the life blocks are copied when the ground under them is first touched, and
 *   also under any changed rectangle the engine reports (capturePatchRect), before the
 *   ecology reacts: whatever the stroke burns or buries is copied first.
 * - Limits: 20 records or 32 MB; the oldest are dropped first. The open record is never
 *   dropped (one record can't exceed the size of the whole world, about 10 MB).
 */
import { COL_BLOCK, PATCH, PATCH_BLOCK } from '../config';
import { PatchGrid, PBLOCKS, type PatchBlock } from '../eco/patches';
import { Columns, type ColumnBlock } from './columns';

export const UNDO_MAX_RECORDS = 20;
export const UNDO_MAX_BYTES = 32 * 1024 * 1024;

/** Bytes kept for one column block: four Float32 arrays and two Uint8 arrays. */
const COL_BLOCK_BYTES = COL_BLOCK * COL_BLOCK * (4 * 4 + 2);

/** How the ecology wants a life value restored: given the copy and the current value, the value to keep. */
export type UndoMerge = (name: string, snapshot: number, current: number) => number;

interface UndoRecord {
  id: number;
  cols: ColumnBlock[];
  patches: PatchBlock[];
  /** Column and life blocks already copied (by block index). */
  colSeen: Set<number>;
  patchSeen: Set<number>;
  bytes: number;
}

export class UndoStack {
  private records: UndoRecord[] = [];
  private open: UndoRecord | null = null;
  /** Record ids are never reused, so block stamps from older records never match a new one. */
  private nextId = 1;
  private totalBytes = 0;

  constructor(
    private readonly cols: Columns,
    private readonly grid: PatchGrid,
    private readonly maxRecords = UNDO_MAX_RECORDS,
    private readonly maxBytes = UNDO_MAX_BYTES,
  ) {
    cols.recordId = -1;
    cols.beforeModify = (block) => this.capture(block);
    grid.recordId = -1;
    grid.beforeModify = null;
  }

  /** Records that can be undone (including the open one once it has changed some ground). */
  get count(): number {
    const n = this.records.length;
    return this.open && this.open.cols.length === 0 ? n - 1 : n;
  }

  /** Memory held by all records (bytes). */
  get bytes(): number {
    return this.totalBytes;
  }

  get isOpen(): boolean {
    return this.open !== null;
  }

  /** Id of the open record, or -1. */
  get openId(): number {
    return this.open ? this.open.id : -1;
  }

  /** Id of the newest record (open or closed), or -1. */
  get latestId(): number {
    return this.records.length ? this.records[this.records.length - 1].id : -1;
  }

  /** Open a new record (closing any open one). Returns its id. */
  begin(): number {
    this.close();
    const rec: UndoRecord = { id: this.nextId++, cols: [], patches: [], colSeen: new Set(), patchSeen: new Set(), bytes: 0 };
    this.records.push(rec);
    this.open = rec;
    this.cols.recordId = rec.id;
    return rec.id;
  }

  /**
   * Close the open record: later changes belong to no record. A record that changed no
   * ground is dropped here, so only the open record can ever be empty.
   */
  close(): void {
    const rec = this.open;
    this.open = null;
    this.cols.recordId = -1;
    if (rec && rec.cols.length === 0) {
      this.records.pop();
      this.totalBytes -= rec.bytes;
    }
  }

  /** Stop recording for a moment (the ecology is about to write). */
  pauseRecording(): void {
    this.cols.recordId = -1;
  }

  /** Carry on recording into the open record, if any. */
  resumeRecording(): void {
    this.cols.recordId = this.open ? this.open.id : -1;
  }

  /**
   * Undo the newest record (closing it first if it is still open; an open record that
   * changed nothing is dropped, so this undoes the stroke before it). Returns the column
   * blocks that were restored, or null if there is nothing to undo. The caller reports the
   * restored blocks as changed (so the page and the ecology catch up).
   */
  undo(merge: UndoMerge): number[] | null {
    this.close();
    const rec = this.records.pop();
    if (!rec) return null;
    this.totalBytes -= rec.bytes;
    for (const snap of rec.cols) this.cols.restoreBlock(snap);
    for (const snap of rec.patches) this.grid.restoreBlock(snap, merge);
    return rec.cols.map((s) => s.block);
  }

  /** Forget every record (the world was replaced). */
  clear(): void {
    this.close();
    this.records = [];
    this.totalBytes = 0;
  }

  /**
   * Copy the life under a changed column rectangle (inclusive) that isn't copied yet, if a
   * record is recording. The engine calls this for every reported change before the
   * ecology reacts to it, so life is safe even where a change is reported over a wider
   * rectangle than the column blocks actually written.
   */
  capturePatchRect(i0: number, k0: number, i1: number, k1: number): void {
    const rec = this.recording();
    if (!rec) return;
    if (this.copyLife(rec, i0, k0, i1, k1)) this.trim();
  }

  /** The open record, if writes are being recorded into it right now. */
  private recording(): UndoRecord | null {
    const rec = this.open;
    return rec && this.cols.recordId === rec.id ? rec : null;
  }

  /** Columns.beforeModify: copy a column block, and the life blocks over it, before the first write. */
  private capture(block: number): void {
    const rec = this.recording();
    // A block can come back here after recording was paused and resumed; the first copy wins.
    if (!rec || rec.colSeen.has(block)) return;
    rec.colSeen.add(block);
    rec.cols.push(this.cols.snapshotBlock(block));
    rec.bytes += COL_BLOCK_BYTES;
    this.totalBytes += COL_BLOCK_BYTES;
    const [i0, k0, i1, k1] = Columns.blockRect(block);
    this.copyLife(rec, i0, k0, i1, k1);
    this.trim();
  }

  /** Copy the not-yet-copied life blocks over a column rectangle into a record. Returns whether any were copied. */
  private copyLife(rec: UndoRecord, i0: number, k0: number, i1: number, k1: number): boolean {
    const side = PATCH * PATCH_BLOCK; // columns per life block side
    const pb0x = Math.max(0, Math.floor(i0 / side));
    const pb1x = Math.min(PBLOCKS - 1, Math.floor(i1 / side));
    const pb0z = Math.max(0, Math.floor(k0 / side));
    const pb1z = Math.min(PBLOCKS - 1, Math.floor(k1 / side));
    let bytes = 0;
    for (let bz = pb0z; bz <= pb1z; bz++) {
      for (let bx = pb0x; bx <= pb1x; bx++) {
        const pb = bx + bz * PBLOCKS;
        if (rec.patchSeen.has(pb)) continue;
        rec.patchSeen.add(pb);
        const snap = this.grid.snapshotBlock(pb);
        for (const d of snap.data) bytes += d.arr.byteLength;
        rec.patches.push(snap);
      }
    }
    rec.bytes += bytes;
    this.totalBytes += bytes;
    return bytes > 0;
  }

  /**
   * Drop the oldest records until within the limits. The open record is always the newest,
   * so it stays; while it is still empty it doesn't count against the 20.
   */
  private trim(): void {
    while (this.records.length > 1 && (this.count > this.maxRecords || this.totalBytes > this.maxBytes)) {
      const old = this.records.shift()!;
      this.totalBytes -= old.bytes;
    }
  }
}
