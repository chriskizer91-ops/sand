/**
 * The sand world: a grid of 3 cm cells, stored in 16x16x16 chunks.
 *
 * Only chunks that have been changed (or that the physics is looking at) are
 * stored ("materialized"). Every other cell is computed from the terrain
 * formula, so memory grows with what you build, not with the size of the beach.
 *
 * Cell (i, j, k): i along x, j up (y), k along z.
 * Inside a chunk, local index = lx | (lz << 4) | (ly << 8).
 */
import { CELL, CHUNK, CHUNK_VOL, type WorldDims } from '../config';
import type { Terrain } from './terrain';

export class Chunk {
  readonly fill = new Uint8Array(CHUNK_VOL);
  readonly wet = new Uint8Array(CHUNK_VOL);
  readonly pack = new Uint8Array(CHUNK_VOL);
  /** 1 while the cell is waiting in the physics queue. */
  readonly queued = new Uint8Array(CHUNK_VOL);
  /** Id of the undo record that already holds a copy of this chunk. */
  undoStamp = -1;
  /** Position in World.list, for fast removal. */
  listIndex = -1;
  /** Cached list of cells exposed to the air (for drying). */
  surface: Int32Array | null = null;
  /** Sim time this chunk was last dried (-1 = never). */
  lastDry = -1;
  /** May hold soaked sand above the water table (which drains). */
  maybeSoaked = false;
  constructor(
    readonly key: number,
    readonly cx: number,
    readonly cy: number,
    readonly cz: number,
  ) {}
}

export interface ChunkSnapshot {
  fill: Uint8Array;
  wet: Uint8Array;
  pack: Uint8Array;
}

export class World {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly ncx: number;
  readonly ncy: number;
  readonly ncz: number;
  readonly ncxz: number;
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly chunks: (Chunk | undefined)[];
  /** All materialized chunks (order is arbitrary). */
  readonly list: Chunk[] = [];
  /** Untouched ground height (metres) for every column in the region. */
  readonly heights: Float32Array;
  /** Same, for a 4-cell margin around the region (scenery side of the edges). */
  private heightsExt: Float32Array;
  private tmpColH = new Float32Array(0);
  /** Cached top-of-sand height per column, refreshed only where cells changed. */
  private topCache: Float32Array;
  private topDirty: Uint8Array;
  private static readonly MARGIN = 4;
  private colMin: Float32Array;
  private colMax: Float32Array;

  /** Called before a chunk is changed for the first time in the current undo record. */
  onBeforeModify: ((chunk: Chunk) => void) | null = null;
  /** Called whenever cells in a chunk change (to schedule re-meshing). */
  onChunkChanged: ((c: Chunk, lx: number, ly: number, lz: number) => void) | null = null;
  /** Current undo record id (-1 = none). */
  undoRecordId = -1;

  constructor(
    readonly dims: WorldDims,
    readonly terrain: Terrain,
  ) {
    this.ncx = dims.cx;
    this.ncy = dims.cy;
    this.ncz = dims.cz;
    this.ncxz = dims.cx * dims.cz;
    this.nx = dims.cx * CHUNK;
    this.ny = dims.cy * CHUNK;
    this.nz = dims.cz * CHUNK;
    this.originX = dims.originX;
    this.originY = dims.originY;
    this.originZ = dims.originZ;
    this.chunks = new Array(this.ncxz * this.ncy);
    this.heights = new Float32Array(this.nx * this.nz);
    for (let k = 0; k < this.nz; k++) {
      const z = this.originZ + (k + 0.5) * CELL;
      for (let i = 0; i < this.nx; i++) {
        this.heights[i + k * this.nx] = terrain.heightAt(this.originX + (i + 0.5) * CELL, z);
      }
    }
    this.topCache = this.heights.slice();
    this.topDirty = new Uint8Array(this.nx * this.nz);
    const M = World.MARGIN;
    const ex = this.nx + 2 * M;
    this.heightsExt = new Float32Array(ex * (this.nz + 2 * M));
    for (let k = -M; k < this.nz + M; k++) {
      for (let i = -M; i < this.nx + M; i++) {
        this.heightsExt[i + M + (k + M) * ex] =
          i >= 0 && k >= 0 && i < this.nx && k < this.nz
            ? this.heights[i + k * this.nx]
            : terrain.heightAt(this.originX + (i + 0.5) * CELL, this.originZ + (k + 0.5) * CELL);
      }
    }
    // Height range of each chunk column (with a 3-cell margin) to skip uniform chunks quickly.
    this.colMin = new Float32Array(this.ncxz).fill(Infinity);
    this.colMax = new Float32Array(this.ncxz).fill(-Infinity);
    for (let k = -3; k < this.nz + 3; k++) {
      for (let i = -3; i < this.nx + 3; i++) {
        const h = this.columnHeight(i, k);
        const cx0 = Math.max(0, Math.min(this.ncx - 1, (i - 3) >> 4));
        const cx1 = Math.max(0, Math.min(this.ncx - 1, (i + 3) >> 4));
        const cz0 = Math.max(0, Math.min(this.ncz - 1, (k - 3) >> 4));
        const cz1 = Math.max(0, Math.min(this.ncz - 1, (k + 3) >> 4));
        for (let cz = cz0; cz <= cz1; cz++) {
          for (let cx = cx0; cx <= cx1; cx++) {
            const c = cx + cz * this.ncx;
            if (h < this.colMin[c]) this.colMin[c] = h;
            if (h > this.colMax[c]) this.colMax[c] = h;
          }
        }
      }
    }
  }

  // ---------- coordinates ----------

  chunkKey(cx: number, cy: number, cz: number): number {
    return cx + cz * this.ncx + cy * this.ncxz;
  }

  inRegion(i: number, j: number, k: number): boolean {
    return i >= 0 && j >= 0 && k >= 0 && i < this.nx && j < this.ny && k < this.nz;
  }

  inRegionXZ(i: number, k: number): boolean {
    return i >= 0 && k >= 0 && i < this.nx && k < this.nz;
  }

  cellX(i: number): number {
    return this.originX + (i + 0.5) * CELL;
  }
  cellY(j: number): number {
    return this.originY + (j + 0.5) * CELL;
  }
  cellZ(k: number): number {
    return this.originZ + (k + 0.5) * CELL;
  }

  // ---------- untouched ground ----------

  columnHeight(i: number, k: number): number {
    if (i >= 0 && k >= 0 && i < this.nx && k < this.nz) return this.heights[i + k * this.nx];
    const M = World.MARGIN;
    if (i >= -M && k >= -M && i < this.nx + M && k < this.nz + M) {
      return this.heightsExt[i + M + (k + M) * (this.nx + 2 * M)];
    }
    return this.terrain.heightAt(this.cellX(i), this.cellZ(k));
  }

  /** Starting moisture and compaction of untouched sand (packed as wet | pack << 8). */
  procProps(i: number, j: number, k: number): number {
    const h = this.columnHeight(i, k);
    const yc = this.cellY(j);
    const x = this.cellX(i);
    const z = this.cellZ(k);
    return this.terrain.wetAt(x, yc, z, h - yc) | (this.terrain.packAt(x, yc, z, h - yc) << 8);
  }

  procFillH(h: number, j: number): number {
    const f = (h - (this.originY + j * CELL)) / CELL;
    return f <= 0 ? 0 : f >= 1 ? 255 : Math.round(f * 255);
  }

  procFill(i: number, j: number, k: number): number {
    if (j < 0) return 255;
    return this.procFillH(this.columnHeight(i, k), j);
  }

  /** Is this untouched chunk all air or all sand (so it has no surface)? */
  procUniform(cx: number, cy: number, cz: number): 'empty' | 'full' | 'mixed' {
    const c = cx + cz * this.ncx;
    const y0 = this.originY + (cy * CHUNK - 3) * CELL;
    const y1 = this.originY + ((cy + 1) * CHUNK + 3) * CELL;
    if (this.colMax[c] < y0) return 'empty';
    if (this.colMin[c] > y1) return 'full';
    return 'mixed';
  }

  // ---------- chunks ----------

  getChunk(cx: number, cy: number, cz: number): Chunk | undefined {
    return this.chunks[cx + cz * this.ncx + cy * this.ncxz];
  }

  /** Get a chunk, creating it from the untouched ground if needed. */
  ensureChunk(cx: number, cy: number, cz: number): Chunk {
    const key = cx + cz * this.ncx + cy * this.ncxz;
    let c = this.chunks[key];
    if (c) return c;
    c = new Chunk(key, cx, cy, cz);
    this.fillProcedural(c);
    this.chunks[key] = c;
    c.listIndex = this.list.length;
    this.list.push(c);
    return c;
  }

  /** Forget a stored chunk (it goes back to untouched ground). */
  dropChunk(key: number): void {
    const c = this.chunks[key];
    if (!c) return;
    const last = this.list.pop()!;
    if (last !== c) {
      this.list[c.listIndex] = last;
      last.listIndex = c.listIndex;
    }
    this.chunks[key] = undefined;
  }

  keyToCoords(key: number): [number, number, number] {
    const cy = Math.floor(key / this.ncxz);
    const rem = key - cy * this.ncxz;
    const cz = Math.floor(rem / this.ncx);
    const cx = rem - cz * this.ncx;
    return [cx, cy, cz];
  }

  private fillProcedural(c: Chunk): void {
    const i0 = c.cx * CHUNK;
    const j0 = c.cy * CHUNK;
    const k0 = c.cz * CHUNK;
    const t = this.terrain;
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const i = i0 + lx;
        const k = k0 + lz;
        const h = this.columnHeight(i, k);
        const x = this.cellX(i);
        const z = this.cellZ(k);
        for (let ly = 0; ly < CHUNK; ly++) {
          const j = j0 + ly;
          const f = this.procFillH(h, j);
          if (f === 0) continue;
          const li = lx | (lz << 4) | (ly << 8);
          const yc = this.cellY(j);
          const depth = h - yc;
          c.fill[li] = f;
          c.wet[li] = t.wetAt(x, yc, z, depth);
          c.pack[li] = t.packAt(x, yc, z, depth);
        }
      }
    }
  }

  /** Must be called before changing a chunk's cells (undo copies + change tracking). */
  touch(c: Chunk): void {
    if (c.undoStamp !== this.undoRecordId) {
      c.undoStamp = this.undoRecordId;
      if (this.undoRecordId >= 0 && this.onBeforeModify) this.onBeforeModify(c);
    }
  }

  changed(c: Chunk, li: number): void {
    const lx = li & 15;
    const lz = (li >> 4) & 15;
    const ly = li >> 8;
    c.surface = null;
    this.topDirty[c.cx * 16 + lx + (c.cz * 16 + lz) * this.nx] = 1;
    // A change on a chunk's border can expose cells in the neighbouring chunk.
    if (lx === 0 && c.cx > 0) this.clearSurface(c.cx - 1, c.cy, c.cz);
    if (lx === 15 && c.cx < this.ncx - 1) this.clearSurface(c.cx + 1, c.cy, c.cz);
    if (lz === 0 && c.cz > 0) this.clearSurface(c.cx, c.cy, c.cz - 1);
    if (lz === 15 && c.cz < this.ncz - 1) this.clearSurface(c.cx, c.cy, c.cz + 1);
    if (ly === 0 && c.cy > 0) this.clearSurface(c.cx, c.cy - 1, c.cz);
    if (ly === 15 && c.cy < this.ncy - 1) this.clearSurface(c.cx, c.cy + 1, c.cz);
    if (this.onChunkChanged) this.onChunkChanged(c, lx, ly, lz);
  }

  /** Forget cached top heights for a chunk column (after loading). */
  markColumnsDirty(cx: number, cz: number): void {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) this.topDirty[cx * CHUNK + lx + (cz * CHUNK + lz) * this.nx] = 1;
    }
  }

  private clearSurface(cx: number, cy: number, cz: number): void {
    const n = this.chunks[cx + cz * this.ncx + cy * this.ncxz];
    if (n) n.surface = null;
  }

  snapshot(c: Chunk): ChunkSnapshot {
    return { fill: c.fill.slice(), wet: c.wet.slice(), pack: c.pack.slice() };
  }

  // ---------- cell access ----------

  /** Amount of sand in a cell (0-255). Below the world counts as solid, above as air. */
  fillAt(i: number, j: number, k: number): number {
    if (j < 0) return 255;
    if (j >= this.ny) return 0;
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return this.procFill(i, j, k);
    const c = this.chunks[(i >> 4) + (k >> 4) * this.ncx + (j >> 4) * this.ncxz];
    if (c) return c.fill[(i & 15) | ((k & 15) << 4) | ((j & 15) << 8)];
    return this.procFillH(this.heights[i + k * this.nx], j);
  }

  wetAt(i: number, j: number, k: number): number {
    if (!this.inRegion(i, j, k)) return 0;
    const c = this.chunks[(i >> 4) + (k >> 4) * this.ncx + (j >> 4) * this.ncxz];
    if (c) return c.wet[(i & 15) | ((k & 15) << 4) | ((j & 15) << 8)];
    const h = this.columnHeight(i, k);
    const yc = this.cellY(j);
    return this.procFillH(h, j) > 0 ? this.terrain.wetAt(this.cellX(i), yc, this.cellZ(k), h - yc) : 0;
  }

  packAt(i: number, j: number, k: number): number {
    if (!this.inRegion(i, j, k)) return 0;
    const c = this.chunks[(i >> 4) + (k >> 4) * this.ncx + (j >> 4) * this.ncxz];
    if (c) return c.pack[(i & 15) | ((k & 15) << 4) | ((j & 15) << 8)];
    const h = this.columnHeight(i, k);
    const yc = this.cellY(j);
    return this.procFillH(h, j) > 0 ? this.terrain.packAt(this.cellX(i), yc, this.cellZ(k), h - yc) : 0;
  }

  /** Chunk holding a cell, creating it if needed. Caller must check inRegion. */
  chunkForCell(i: number, j: number, k: number): Chunk {
    return this.ensureChunk(i >> 4, j >> 4, k >> 4);
  }

  /** Set a cell directly (used by tools and checks). Values are clamped. */
  setCell(i: number, j: number, k: number, fill: number, wet: number, pack: number): void {
    if (!this.inRegion(i, j, k)) return;
    const c = this.chunkForCell(i, j, k);
    const li = (i & 15) | ((k & 15) << 4) | ((j & 15) << 8);
    this.touch(c);
    c.fill[li] = fill;
    c.wet[li] = fill > 0 ? wet : 0;
    c.pack[li] = fill > 0 ? pack : 0;
    this.changed(c, li);
  }

  /**
   * Copy a block of cells (fill, wet, pack) into flat arrays, index x + z*sx + y*sx*sz.
   * Cells outside the world come from the terrain formula.
   */
  sampleBlock(
    i0: number,
    j0: number,
    k0: number,
    sx: number,
    sy: number,
    sz: number,
    outFill: Uint8Array,
    outWet: Uint8Array,
    outPack: Uint8Array,
    /** If given, untouched cells get wet/pack 0 and stored[o] = 0; the caller fills them in on demand. */
    stored?: Uint8Array,
  ): void {
    const t = this.terrain;
    const sxz = sx * sz;
    const lazy = stored !== undefined;
    if (lazy) stored.fill(0, 0, sx * sy * sz);
    // Untouched ground first, one horizontal layer at a time.
    if (this.tmpColH.length < sxz) this.tmpColH = new Float32Array(sxz);
    const colH = this.tmpColH;
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) colH[x + z * sx] = this.columnHeight(i0 + x, k0 + z);
    }
    for (let y = 0; y < sy; y++) {
      const j = j0 + y;
      let o = y * sxz;
      if (j < 0 || j >= this.ny) {
        const f = j < 0 ? 255 : 0;
        outFill.fill(f, o, o + sxz);
        outWet.fill(j < 0 ? 255 : 0, o, o + sxz);
        outPack.fill(j < 0 ? 255 : 0, o, o + sxz);
        continue;
      }
      const yb = this.originY + j * CELL;
      const yc = yb + CELL * 0.5;
      for (let c = 0; c < sxz; c++, o++) {
        const fr = (colH[c] - yb) / CELL;
        const f = fr <= 0 ? 0 : fr >= 1 ? 255 : Math.round(fr * 255);
        outFill[o] = f;
        if (f > 0 && !lazy) {
          const x = c % sx;
          const z = (c - x) / sx;
          const wx = this.cellX(i0 + x);
          const wz = this.cellZ(k0 + z);
          const depth = colH[c] - yc;
          outWet[o] = t.wetAt(wx, yc, wz, depth);
          outPack[o] = t.packAt(wx, yc, wz, depth);
        } else {
          outWet[o] = 0;
          outPack[o] = 0;
        }
      }
    }
    // Then overwrite with stored chunks.
    const cx0 = Math.max(0, i0 >> 4);
    const cy0 = Math.max(0, j0 >> 4);
    const cz0 = Math.max(0, k0 >> 4);
    const cx1 = Math.min(this.ncx - 1, (i0 + sx - 1) >> 4);
    const cy1 = Math.min(this.ncy - 1, (j0 + sy - 1) >> 4);
    const cz1 = Math.min(this.ncz - 1, (k0 + sz - 1) >> 4);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = this.chunks[cx + cz * this.ncx + cy * this.ncxz];
          if (!c) continue;
          const bi0 = Math.max(i0, cx * CHUNK);
          const bi1 = Math.min(i0 + sx, (cx + 1) * CHUNK);
          const bj0 = Math.max(j0, cy * CHUNK);
          const bj1 = Math.min(j0 + sy, (cy + 1) * CHUNK);
          const bk0 = Math.max(k0, cz * CHUNK);
          const bk1 = Math.min(k0 + sz, (cz + 1) * CHUNK);
          for (let j = bj0; j < bj1; j++) {
            for (let k = bk0; k < bk1; k++) {
              let li = ((bi0 & 15) | ((k & 15) << 4) | ((j & 15) << 8));
              let o = bi0 - i0 + (k - k0) * sx + (j - j0) * sxz;
              for (let i = bi0; i < bi1; i++, li++, o++) {
                outFill[o] = c.fill[li];
                outWet[o] = c.wet[li];
                outPack[o] = c.pack[li];
                if (lazy) stored[o] = 1;
              }
            }
          }
        }
      }
    }
  }

  /** Total sand in the world (in fill units), for the "nothing created or destroyed" check. */
  totalSand(): number {
    let total = 0;
    for (let cy = 0; cy < this.ncy; cy++) {
      for (let cz = 0; cz < this.ncz; cz++) {
        for (let cx = 0; cx < this.ncx; cx++) {
          const c = this.getChunk(cx, cy, cz);
          if (c) {
            for (let li = 0; li < CHUNK_VOL; li++) total += c.fill[li];
          } else {
            for (let lz = 0; lz < CHUNK; lz++) {
              for (let lx = 0; lx < CHUNK; lx++) {
                const h = this.columnHeight(cx * CHUNK + lx, cz * CHUNK + lz);
                for (let ly = 0; ly < CHUNK; ly++) total += this.procFillH(h, cy * CHUNK + ly);
              }
            }
          }
        }
      }
    }
    return total;
  }

  /** Height of the top sand surface in a column (metres), used for water depth and the camera. */
  topHeight(i: number, k: number): number {
    if (!this.inRegionXZ(i, k)) return this.columnHeight(i, k);
    const ci = i + k * this.nx;
    if (!this.topDirty[ci]) return this.topCache[ci];
    this.topDirty[ci] = 0;
    return (this.topCache[ci] = this.scanTop(i, k));
  }

  private scanTop(i: number, k: number): number {
    const cx = i >> 4;
    const cz = k >> 4;
    // Start from the highest stored chunk in this column; untouched chunks above it are empty.
    let startCy = -1;
    for (let cy = this.ncy - 1; cy >= 0; cy--) {
      if (this.chunks[cx + cz * this.ncx + cy * this.ncxz]) {
        startCy = cy;
        break;
      }
    }
    const procH = this.heights[i + k * this.nx];
    if (startCy < 0) return procH;
    const procTopJ = Math.floor((procH - this.originY) / CELL);
    const startJ = Math.max(startCy * CHUNK + CHUNK - 1, procTopJ);
    for (let j = Math.min(startJ, this.ny - 1); j >= 0; j--) {
      const f = this.fillAt(i, j, k);
      if (f > 0) return this.originY + (j + f / 255) * CELL;
    }
    return this.originY;
  }
}
