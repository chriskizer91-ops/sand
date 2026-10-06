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
 * - Only the stroke is recorded. While the ecology works (soil, coast, reef, storms), the
 *   engine pauses recording, so those writes never enter a record.
 * - The life grid is never recorded on its own (its own `recordId` stays -1): the ecology
 *   writes to it all the time, and recording that would copy the whole grid every stroke.
 *   Instead the life blocks are copied exactly when the ground under them is first touched.
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

  /** Records that can be undone (including the open one). */
  get count(): number {
    return this.records.length;
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
    this.trim();
    return rec.id;
  }

  /** Close the open record: later changes belong to no record. */
  close(): void {
    this.open = null;
    this.cols.recordId = -1;
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
   * Undo the newest record (closing it first if it is still open). Returns the column
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

  /** Columns.beforeModify: copy a column block, and the life blocks over it, before the first write. */
  private capture(block: number): void {
    const rec = this.open;
    if (!rec || this.cols.recordId !== rec.id) return;
    // A block can come back here after recording was paused and resumed; the first copy wins.
    if (rec.colSeen.has(block)) return;
    rec.colSeen.add(block);
    rec.cols.push(this.cols.snapshotBlock(block));
    let bytes = COL_BLOCK_BYTES;
    const [i0, k0, i1, k1] = Columns.blockRect(block);
    const pb0x = Math.floor(i0 / PATCH / PATCH_BLOCK);
    const pb1x = Math.floor(i1 / PATCH / PATCH_BLOCK);
    const pb0z = Math.floor(k0 / PATCH / PATCH_BLOCK);
    const pb1z = Math.floor(k1 / PATCH / PATCH_BLOCK);
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
    this.trim();
  }

  /** Drop the oldest records until within the limits (the open record is always the newest, so it stays). */
  private trim(): void {
    while (this.records.length > 1 && (this.records.length > this.maxRecords || this.totalBytes > this.maxBytes)) {
      const old = this.records.shift()!;
      this.totalBytes -= old.bytes;
    }
  }
}
