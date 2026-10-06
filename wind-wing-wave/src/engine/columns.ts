/**
 * The ground: a grid of 2 m columns. Each column is a stack:
 *   rock (rigid)  ->  sediment (loose sand)  ->  lava (molten, on top)
 * See docs/ARCHITECTURE.md §2. There are no caves or overhangs (DECISIONS 2).
 *
 * Every write must:
 *   1. call touch(c) (or touchRect) BEFORE changing a column (undo copies), and
 *   2. call markChanged(...) AFTER (re-send to the page, tell ecology).
 */
import { CELL, COL_BLOCK, NX, NZ, ORIGIN_X, ORIGIN_Z, SEA_LEVEL } from '../config';

export const RockKind = { Basalt: 0, Stone: 1, Limestone: 2 } as const;
export type RockKind = (typeof RockKind)[keyof typeof RockKind];

/** Change flags passed to markChanged. */
export const ChangeFlag = {
  /** Height changed (rock, sediment or lava). */
  Geom: 1,
  /** Look changed only (lava temperature, sand kind, rock kind). */
  Look: 2,
  /** Lava covered this ground: life here burns. */
  Burn: 4,
  /** A tool (not physics) changed it: used by ecology to tell burial from slow drift. */
  Tool: 8,
} as const;

export interface ChangeListener {
  (i0: number, k0: number, i1: number, k1: number, flags: number): void;
}

/** Blocks of COL_BLOCK x COL_BLOCK columns, used by undo. */
export const BLOCKS_X = NX / COL_BLOCK;
export const BLOCKS_Z = NZ / COL_BLOCK;

export class Columns {
  readonly nx = NX;
  readonly nz = NZ;
  readonly n = NX * NZ;
  /** Top of rigid rock (m). */
  readonly rock = new Float32Array(NX * NZ);
  /** Loose sediment thickness on the rock (m). */
  readonly sed = new Float32Array(NX * NZ);
  /** Molten lava thickness on top (m). */
  readonly lava = new Float32Array(NX * NZ);
  /** Lava temperature 0..1 (meaningful only where lava > 0). */
  readonly temp = new Float32Array(NX * NZ);
  /** 0 black (volcanic) .. 128 golden .. 255 coral-white. */
  readonly sandKind = new Uint8Array(NX * NZ);
  /** RockKind of the rock top. */
  readonly rockKind = new Uint8Array(NX * NZ);

  /** Called once per undo record before a block is first modified (block = bx + bz * BLOCKS_X). */
  beforeModify: ((block: number) => void) | null = null;
  /** Undo record stamp per block. */
  readonly blockStamp = new Int32Array(BLOCKS_X * BLOCKS_Z).fill(-1);
  /** Current undo record id (-1 = none). */
  recordId = -1;
  private listeners: ChangeListener[] = [];

  // ---------- coordinates ----------

  index(i: number, k: number): number {
    return i + k * NX;
  }
  inside(i: number, k: number): boolean {
    return i >= 0 && k >= 0 && i < NX && k < NZ;
  }
  /** Column index under a world point (clamped to the zone). */
  colAt(x: number, z: number): number {
    const i = Math.max(0, Math.min(NX - 1, Math.floor((x - ORIGIN_X) / CELL)));
    const k = Math.max(0, Math.min(NZ - 1, Math.floor((z - ORIGIN_Z) / CELL)));
    return i + k * NX;
  }
  /** World x of column i's centre. */
  cx(i: number): number {
    return ORIGIN_X + (i + 0.5) * CELL;
  }
  /** World z of column k's centre. */
  cz(k: number): number {
    return ORIGIN_Z + (k + 0.5) * CELL;
  }

  // ---------- heights ----------

  /** Solid surface (rock + sediment). */
  top(c: number): number {
    return this.rock[c] + this.sed[c];
  }
  /** Visible surface (solid + molten lava). */
  surf(c: number): number {
    return this.rock[c] + this.sed[c] + this.lava[c];
  }
  isLand(c: number): boolean {
    return this.surf(c) > SEA_LEVEL;
  }

  /** Bilinear visible surface height at a world point (outside the zone: clamped edge). */
  heightAt(x: number, z: number): number {
    const fx = (x - ORIGIN_X) / CELL - 0.5;
    const fz = (z - ORIGIN_Z) / CELL - 0.5;
    const i0 = Math.max(0, Math.min(NX - 1, Math.floor(fx)));
    const k0 = Math.max(0, Math.min(NZ - 1, Math.floor(fz)));
    const i1 = Math.min(NX - 1, i0 + 1);
    const k1 = Math.min(NZ - 1, k0 + 1);
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - k0));
    const a = this.surf(i0 + k0 * NX);
    const b = this.surf(i1 + k0 * NX);
    const c = this.surf(i0 + k1 * NX);
    const d = this.surf(i1 + k1 * NX);
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  // ---------- change tracking ----------

  /** Must be called before modifying column c (undo copy-on-first-write). */
  touch(c: number): void {
    const b = ((c % NX) >> 4) + ((((c / NX) | 0) >> 4) * BLOCKS_X);
    if (this.blockStamp[b] !== this.recordId) {
      this.blockStamp[b] = this.recordId;
      if (this.recordId >= 0 && this.beforeModify) this.beforeModify(b);
    }
  }

  /** touch() every block overlapping a column rectangle (inclusive bounds, clamped). */
  touchRect(i0: number, k0: number, i1: number, k1: number): void {
    const bx0 = Math.max(0, i0) >> 4;
    const bz0 = Math.max(0, k0) >> 4;
    const bx1 = Math.min(NX - 1, i1) >> 4;
    const bz1 = Math.min(NZ - 1, k1) >> 4;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const b = bx + bz * BLOCKS_X;
        if (this.blockStamp[b] !== this.recordId) {
          this.blockStamp[b] = this.recordId;
          if (this.recordId >= 0 && this.beforeModify) this.beforeModify(b);
        }
      }
    }
  }

  addListener(fn: ChangeListener): void {
    this.listeners.push(fn);
  }
  removeListener(fn: ChangeListener): void {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }

  /** Report a changed column rectangle (inclusive bounds; clamped). */
  markChanged(i0: number, k0: number, i1: number, k1: number, flags: number): void {
    i0 = Math.max(0, i0);
    k0 = Math.max(0, k0);
    i1 = Math.min(NX - 1, i1);
    k1 = Math.min(NZ - 1, k1);
    if (i1 < i0 || k1 < k0) return;
    for (const fn of this.listeners) fn(i0, k0, i1, k1, flags);
  }

  // ---------- page data ----------

  /**
   * Pack a rectangle for the page (ARCHITECTURE §2):
   * surf (Float32, w*h) and ground RGBA8 (w*h*4):
   *   R lava thickness x20, G lava temperature x255, B sediment x50, A (sandKind>>2)<<2 | rockKind.
   */
  packRect(x0: number, z0: number, w: number, h: number, surf: Float32Array, ground: Uint8Array): void {
    let o = 0;
    for (let k = z0; k < z0 + h; k++) {
      let c = x0 + k * NX;
      for (let i = 0; i < w; i++, c++, o++) {
        const lv = this.lava[c];
        surf[o] = this.rock[c] + this.sed[c] + lv;
        const g = o * 4;
        ground[g] = lv <= 0 ? 0 : Math.min(255, Math.max(1, Math.round(lv * 20)));
        ground[g + 1] = lv <= 0 ? 0 : Math.min(255, Math.round(this.temp[c] * 255));
        ground[g + 2] = Math.min(255, Math.round(this.sed[c] * 50));
        ground[g + 3] = ((this.sandKind[c] >> 2) << 2) | (this.rockKind[c] & 3);
      }
    }
  }

  // ---------- snapshots (undo, save, checks) ----------

  /** Copy one undo block's data out. */
  snapshotBlock(block: number): ColumnBlock {
    const bx = block % BLOCKS_X;
    const bz = (block / BLOCKS_X) | 0;
    const N = COL_BLOCK * COL_BLOCK;
    const s: ColumnBlock = {
      block,
      rock: new Float32Array(N),
      sed: new Float32Array(N),
      lava: new Float32Array(N),
      temp: new Float32Array(N),
      sandKind: new Uint8Array(N),
      rockKind: new Uint8Array(N),
    };
    for (let z = 0; z < COL_BLOCK; z++) {
      const c0 = bx * COL_BLOCK + (bz * COL_BLOCK + z) * NX;
      const o = z * COL_BLOCK;
      s.rock.set(this.rock.subarray(c0, c0 + COL_BLOCK), o);
      s.sed.set(this.sed.subarray(c0, c0 + COL_BLOCK), o);
      s.lava.set(this.lava.subarray(c0, c0 + COL_BLOCK), o);
      s.temp.set(this.temp.subarray(c0, c0 + COL_BLOCK), o);
      s.sandKind.set(this.sandKind.subarray(c0, c0 + COL_BLOCK), o);
      s.rockKind.set(this.rockKind.subarray(c0, c0 + COL_BLOCK), o);
    }
    return s;
  }

  /** Write a block back (does not call touch or markChanged; the caller does). */
  restoreBlock(s: ColumnBlock): void {
    const bx = s.block % BLOCKS_X;
    const bz = (s.block / BLOCKS_X) | 0;
    for (let z = 0; z < COL_BLOCK; z++) {
      const c0 = bx * COL_BLOCK + (bz * COL_BLOCK + z) * NX;
      const o = z * COL_BLOCK;
      this.rock.set(s.rock.subarray(o, o + COL_BLOCK), c0);
      this.sed.set(s.sed.subarray(o, o + COL_BLOCK), c0);
      this.lava.set(s.lava.subarray(o, o + COL_BLOCK), c0);
      this.temp.set(s.temp.subarray(o, o + COL_BLOCK), c0);
      this.sandKind.set(s.sandKind.subarray(o, o + COL_BLOCK), c0);
      this.rockKind.set(s.rockKind.subarray(o, o + COL_BLOCK), c0);
    }
  }

  /** Column rectangle covered by a block (inclusive). */
  static blockRect(block: number): [number, number, number, number] {
    const bx = block % BLOCKS_X;
    const bz = (block / BLOCKS_X) | 0;
    return [bx * COL_BLOCK, bz * COL_BLOCK, bx * COL_BLOCK + COL_BLOCK - 1, bz * COL_BLOCK + COL_BLOCK - 1];
  }

  /** A quick fingerprint of the whole grid (for checks and e2e "same world" tests). */
  hash(): number {
    let h = 2166136261 >>> 0;
    const f32 = [this.rock, this.sed, this.lava];
    for (const a of f32) {
      const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
      for (let i = 0; i < u.length; i += 1) h = Math.imul(h ^ u[i], 16777619) >>> 0;
    }
    for (let i = 0; i < this.n; i++) h = Math.imul(h ^ (this.sandKind[i] | (this.rockKind[i] << 8)), 16777619) >>> 0;
    return h >>> 0;
  }

  /** Total sediment volume (m^3), for conservation checks. */
  totalSediment(): number {
    let t = 0;
    for (let c = 0; c < this.n; c++) t += this.sed[c];
    return t * CELL * CELL;
  }
}

export interface ColumnBlock {
  block: number;
  rock: Float32Array;
  sed: Float32Array;
  lava: Float32Array;
  temp: Float32Array;
  sandKind: Uint8Array;
  rockKind: Uint8Array;
}
