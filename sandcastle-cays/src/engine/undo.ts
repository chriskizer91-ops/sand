/**
 * Undo: each stroke opens a record. The first time any chunk changes while the
 * record is open (from the tool, or from sand sliding afterwards), we keep a copy
 * of it. Undo puts those copies back, along with what was in your hands.
 */
import type { Chunk, ChunkSnapshot, World } from './world';

interface UndoRecord {
  id: number;
  snaps: Map<number, ChunkSnapshot>;
  handAmount: number;
  handWetSum: number;
  bytes: number;
}

export class UndoStack {
  private records: UndoRecord[] = [];
  private nextId = 1;
  /** Keep at most this many strokes, and at most this much memory. */
  maxRecords = 30;
  maxBytes = 48 * 1024 * 1024;

  constructor(private world: World) {
    world.onBeforeModify = (c) => this.capture(c);
  }

  get count(): number {
    return this.records.length;
  }

  get currentId(): number {
    return this.world.undoRecordId;
  }

  begin(handAmount: number, handWetSum: number): number {
    const rec: UndoRecord = { id: this.nextId++, snaps: new Map(), handAmount, handWetSum, bytes: 0 };
    this.records.push(rec);
    this.world.undoRecordId = rec.id;
    this.trim();
    return rec.id;
  }

  private capture(c: Chunk): void {
    const rec = this.records[this.records.length - 1];
    if (!rec || rec.id !== this.world.undoRecordId || rec.snaps.has(c.key)) return;
    rec.snaps.set(c.key, this.world.snapshot(c));
    rec.bytes += c.fill.length * 3;
    if (rec.bytes > this.maxBytes / 2) {
      // A single enormous change: stop tracking rather than run out of memory.
      this.records = [];
      this.world.undoRecordId = -1;
    }
  }

  private trim(): void {
    let total = 0;
    for (const r of this.records) total += r.bytes;
    while (this.records.length > this.maxRecords || (total > this.maxBytes && this.records.length > 1)) {
      total -= this.records[0].bytes;
      this.records.shift();
    }
  }

  /**
   * Undo the latest record. Returns the record id and the cells that changed
   * (so the physics can look at them), or null if there is nothing to undo.
   */
  undo(): { id: number; handAmount: number; handWetSum: number; changed: number[] } | null {
    const rec = this.records.pop();
    if (!rec) return null;
    const w = this.world;
    const changed: number[] = [];
    // Stop recording while we restore.
    w.undoRecordId = -1;
    for (const [key, snap] of rec.snaps) {
      const [cx, cy, cz] = w.keyToCoords(key);
      const c = w.ensureChunk(cx, cy, cz);
      for (let li = 0; li < snap.fill.length; li++) {
        if (c.fill[li] !== snap.fill[li] || c.wet[li] !== snap.wet[li] || c.pack[li] !== snap.pack[li]) {
          c.fill[li] = snap.fill[li];
          c.wet[li] = snap.wet[li];
          c.pack[li] = snap.pack[li];
          changed.push(key * 4096 + li);
          w.changed(c, li);
        }
      }
    }
    // Further changes (until the next stroke) belong to no record.
    w.undoRecordId = -1;
    return { id: rec.id, handAmount: rec.handAmount, handWetSum: rec.handWetSum, changed };
  }

  clear(): void {
    this.records = [];
    this.world.undoRecordId = -1;
  }
}
