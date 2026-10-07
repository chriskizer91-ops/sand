/**
 * The life grid: 256 x 256 patches of 4 m (2 x 2 columns each).
 *
 * A PatchGrid is a bag of named typed arrays. The ecology registers every array it
 * keeps (derived fields and live state); undo and save handle them generically, so
 * they never need to know what the fields mean. See docs/ARCHITECTURE.md §5.3.
 */
import { NP, PATCH, PATCH_BLOCK } from '../config';

export type PatchArray = Float32Array | Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array;

export interface PatchField {
  name: string;
  arr: PatchArray;
  /** Saved in the save file and restored by undo. Derived fields (recomputed from terrain) set this false. */
  persistent: boolean;
}

export const PBLOCKS = NP / PATCH_BLOCK;

export interface PatchBlock {
  block: number;
  data: { name: string; arr: PatchArray }[];
}

export class PatchGrid {
  readonly np = NP;
  readonly n = NP * NP;
  private fields = new Map<string, PatchField>();
  readonly order: PatchField[] = [];
  /** Undo stamps per block. */
  readonly blockStamp = new Int32Array(PBLOCKS * PBLOCKS).fill(-1);
  recordId = -1;
  beforeModify: ((block: number) => void) | null = null;

  /** Register (or fetch) a field of `NP*NP*stride` elements. */
  add<T extends PatchArray>(name: string, make: (n: number) => T, persistent = true, stride = 1): T {
    const f = this.fields.get(name);
    if (f) return f.arr as T;
    const arr = make(this.n * stride);
    const field: PatchField = { name, arr, persistent };
    this.fields.set(name, field);
    this.order.push(field);
    return arr;
  }

  get<T extends PatchArray>(name: string): T {
    const f = this.fields.get(name);
    if (!f) throw new Error(`PatchGrid has no field "${name}"`);
    return f.arr as T;
  }

  has(name: string): boolean {
    return this.fields.has(name);
  }

  /** Patch index under a column. */
  static ofColumn(i: number, k: number): number {
    return ((i / PATCH) | 0) + ((k / PATCH) | 0) * NP;
  }

  /** Block index of a patch (PATCH_BLOCK x PATCH_BLOCK patches). */
  static blockOf(p: number): number {
    const pi = p % NP;
    const pk = (p / NP) | 0;
    return ((pi / PATCH_BLOCK) | 0) + ((pk / PATCH_BLOCK) | 0) * PBLOCKS;
  }

  /** Call before modifying persistent state of patch p while an undo record may be open. */
  touch(p: number): void {
    const b = PatchGrid.blockOf(p);
    if (this.blockStamp[b] !== this.recordId) {
      this.blockStamp[b] = this.recordId;
      if (this.recordId >= 0 && this.beforeModify) this.beforeModify(b);
    }
  }

  /** Copy a block of every persistent field. */
  snapshotBlock(block: number): PatchBlock {
    const bx = block % PBLOCKS;
    const bz = (block / PBLOCKS) | 0;
    const data: PatchBlock['data'] = [];
    for (const f of this.order) {
      if (!f.persistent) continue;
      const stride = f.arr.length / this.n;
      const Ctor = f.arr.constructor as new (n: number) => PatchArray;
      const out = new Ctor(PATCH_BLOCK * PATCH_BLOCK * stride);
      for (let z = 0; z < PATCH_BLOCK; z++) {
        const p0 = (bx * PATCH_BLOCK + (bz * PATCH_BLOCK + z) * NP) * stride;
        out.set(f.arr.subarray(p0, p0 + PATCH_BLOCK * stride), z * PATCH_BLOCK * stride);
      }
      data.push({ name: f.name, arr: out });
    }
    return { block, data };
  }

  /** Write a block back. `merge` (optional) decides per element: return the value to keep. */
  restoreBlock(s: PatchBlock, merge?: (name: string, snapshot: number, current: number) => number): void {
    const bx = s.block % PBLOCKS;
    const bz = (s.block / PBLOCKS) | 0;
    for (const d of s.data) {
      const f = this.fields.get(d.name);
      if (!f) continue;
      const stride = f.arr.length / this.n;
      for (let z = 0; z < PATCH_BLOCK; z++) {
        const p0 = (bx * PATCH_BLOCK + (bz * PATCH_BLOCK + z) * NP) * stride;
        const o0 = z * PATCH_BLOCK * stride;
        if (!merge) {
          f.arr.set(d.arr.subarray(o0, o0 + PATCH_BLOCK * stride), p0);
        } else {
          for (let e = 0; e < PATCH_BLOCK * stride; e++) f.arr[p0 + e] = merge(d.name, d.arr[o0 + e], f.arr[p0 + e]);
        }
      }
    }
  }

  /** Patch rectangle of a block (inclusive). */
  static blockRect(block: number): [number, number, number, number] {
    const bx = block % PBLOCKS;
    const bz = (block / PBLOCKS) | 0;
    return [bx * PATCH_BLOCK, bz * PATCH_BLOCK, bx * PATCH_BLOCK + PATCH_BLOCK - 1, bz * PATCH_BLOCK + PATCH_BLOCK - 1];
  }

  /** Every persistent field, for saving. */
  persistentFields(): PatchField[] {
    return this.order.filter((f) => f.persistent);
  }
}
