/**
 * Sand physics. Each step looks only at cells that might move ("the queue"),
 * so sand at rest costs nothing.
 *
 * Rules (see docs/DECISIONS.md, decision 2):
 *  1. Settling: sand rests on the sand below it. Loose sand above a gap falls.
 *  2. Slumping: sand slides to a lower neighbour when the slope is steeper than it can hold.
 *  3. Overhangs: cohesive sand may hang sideways off supported sand for `span` cells.
 *     Anything unsupported breaks off and falls as crumbs (particles).
 *  4. Drying: exposed surfaces slowly lose moisture; sand below the water table is soaked.
 *
 * Sand is never created or destroyed: every change moves an exact amount.
 */
import { CELL } from '../config';
import { HOLDS_VERTICAL, MAX_SLOPE, MAX_SPAN, SPAN, COHESION } from './material';
import { mulberry32 } from './noise';
import type { Chunk, World } from './world';

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const DIST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/** Moisture thresholds where sand behaviour changes noticeably (re-check cells crossing them). */
const WET_STEPS = [215, 120, 60, 40, 25];

class IntList {
  data: Int32Array;
  length = 0;
  constructor(cap = 1024) {
    this.data = new Int32Array(cap);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const d = new Int32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.length++] = v;
  }
  clear(): void {
    this.length = 0;
  }
}

/** Falling sand and cosmetic spray. Structure-of-arrays for speed. */
export class Particles {
  n = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Sand carried (fill units). 0 for cosmetic spray. */
  readonly amt: Int32Array;
  readonly wet: Uint8Array;
  readonly life: Float32Array;
  readonly rec: Int32Array;
  constructor(readonly cap: number) {
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.amt = new Int32Array(cap);
    this.wet = new Uint8Array(cap);
    this.life = new Float32Array(cap);
    this.rec = new Int32Array(cap);
  }
  add(x: number, y: number, z: number, vx: number, vy: number, vz: number, amt: number, wet: number, life: number, rec: number): boolean {
    if (this.n >= this.cap) return false;
    const p = this.n++;
    this.x[p] = x;
    this.y[p] = y;
    this.z[p] = z;
    this.vx[p] = vx;
    this.vy[p] = vy;
    this.vz[p] = vz;
    this.amt[p] = amt;
    this.wet[p] = wet;
    this.life[p] = life;
    this.rec[p] = rec;
    return true;
  }
  remove(p: number): void {
    const last = --this.n;
    if (p !== last) {
      this.x[p] = this.x[last];
      this.y[p] = this.y[last];
      this.z[p] = this.z[last];
      this.vx[p] = this.vx[last];
      this.vy[p] = this.vy[last];
      this.vz[p] = this.vz[last];
      this.amt[p] = this.amt[last];
      this.wet[p] = this.wet[last];
      this.life[p] = this.life[last];
      this.rec[p] = this.rec[last];
    }
  }
  /** Sand currently in the air (fill units). */
  totalSand(): number {
    let t = 0;
    for (let p = 0; p < this.n; p++) t += this.amt[p];
    return t;
  }
}

export interface SimStats {
  /** Sand moved by sliding this step (fill units). */
  moved: number;
  /** Sand that broke off and started falling. */
  fell: number;
  /** Sand that landed. */
  landed: number;
  /** Cells processed. */
  cells: number;
}

export class Sim {
  readonly particles = new Particles(12000);
  private cur = new IntList(4096);
  private next = new IntList(4096);
  private support = new Set<number>();
  private rng = mulberry32(99);
  /** Drying speed: moisture lost per second by a fully exposed cell. */
  dryRate = 0.2;
  time = 0;
  private dryAccum = 0;
  private dryCursor = 0;
  /** Max cells handled per step; the rest wait for the next step. */
  maxCellsPerStep = 60000;
  stats: SimStats = { moved: 0, fell: 0, landed: 0, cells: 0 };
  /** Called when a chunk's moisture changed enough to be visible. */
  onWetVisual: ((c: Chunk) => void) | null = null;

  // Reusable buffers for the support check.
  private bufFill = new Uint8Array(0);
  private bufWet = new Uint8Array(0);
  private bufPack = new Uint8Array(0);
  private bufSpan = new Uint8Array(0);
  private bufCost = new Uint8Array(0);
  private buckets: IntList[] = [];

  constructor(readonly world: World) {
    for (let c = 0; c <= MAX_SPAN; c++) this.buckets.push(new IntList(1024));
  }

  /** Is anything still moving? */
  get busy(): boolean {
    return this.next.length > 0 || this.support.size > 0 || this.particles.n > 0;
  }

  get queueLength(): number {
    return this.next.length;
  }

  // ---------- queue ----------

  enqueue(i: number, j: number, k: number): void {
    const w = this.world;
    if (i < 0 || j < 0 || k < 0 || i >= w.nx || j >= w.ny || k >= w.nz) return;
    let c = w.chunks[(i >> 4) + (k >> 4) * w.ncx + (j >> 4) * w.ncxz];
    if (!c) {
      // Untouched air never needs work; untouched sand must be stored before it can move.
      if (w.procFillH(w.heights[i + k * w.nx], j) === 0) return;
      c = w.ensureChunk(i >> 4, j >> 4, k >> 4);
    }
    const li = (i & 15) | ((k & 15) << 4) | ((j & 15) << 8);
    if (c.queued[li]) return;
    c.queued[li] = 1;
    this.next.push(i | (k << 10) | (j << 20));
  }

  /** Wake a cell and everything that might slide into the space it left. */
  wakeAround(i: number, j: number, k: number): void {
    this.enqueue(i, j, k);
    this.enqueue(i, j + 1, k);
    for (let d = 0; d < 8; d++) {
      this.enqueue(i + DX[d], j, k + DZ[d]);
      this.enqueue(i + DX[d], j + 1, k + DZ[d]);
    }
  }

  /** Wake every cell in a box (used after tools change an area). */
  wakeBox(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): void {
    const w = this.world;
    for (let j = Math.max(0, j0); j <= Math.min(w.ny - 1, j1); j++) {
      for (let k = Math.max(0, k0); k <= Math.min(w.nz - 1, k1); k++) {
        for (let i = Math.max(0, i0); i <= Math.min(w.nx - 1, i1); i++) {
          if (w.fillAt(i, j, k) > 0) this.enqueue(i, j, k);
        }
      }
    }
  }

  markSupport(i: number, j: number, k: number): void {
    this.support.add(i | (k << 10) | (j << 20));
  }

  // ---------- step ----------

  step(dt: number): SimStats {
    this.time += dt;
    this.stats = { moved: 0, fell: 0, landed: 0, cells: 0 };
    const q = this.next;
    this.next = this.cur;
    this.cur = q;
    this.next.clear();

    const w = this.world;
    const n = Math.min(q.length, this.maxCellsPerStep);
    // Alternate direction each step so no side is favoured.
    const reverse = (this.time * 30) & 1;
    for (let s = 0; s < n; s++) {
      const key = q.data[reverse ? n - 1 - s : s];
      const i = key & 1023;
      const k = (key >> 10) & 1023;
      const j = key >>> 20;
      const c = w.chunks[(i >> 4) + (k >> 4) * w.ncx + (j >> 4) * w.ncxz];
      if (!c) continue;
      c.queued[(i & 15) | ((k & 15) << 4) | ((j & 15) << 8)] = 0;
      this.processCell(c, i, j, k);
    }
    // Leftovers stay queued for the next step.
    for (let s = n; s < q.length; s++) this.next.push(q.data[s]);
    this.stats.cells = n;

    this.processSupport();
    this.updateParticles(dt);
    this.drying(dt);
    return this.stats;
  }

  // ---------- rules 1 and 2: settling and slumping ----------

  private processCell(cA: Chunk, i: number, j: number, k: number): void {
    const w = this.world;
    const liA = (i & 15) | ((k & 15) << 4) | ((j & 15) << 8);
    let fa = cA.fill[liA];
    if (fa === 0) return;
    const prop = (cA.wet[liA] << 8) | cA.pack[liA];
    const coh = COHESION[prop];

    // Rule 1: settle onto the sand below.
    const fb = j > 0 ? w.fillAt(i, j - 1, k) : 255;
    if (fb < 255) {
      if (coh < 0.05 || fb >= 96) {
        if (fb < 24 && coh < 0.05) {
          const fbb = j > 1 ? w.fillAt(i, j - 2, k) : 255;
          if (fbb < 200) {
            this.dropCell(i, j, k);
            return;
          }
        }
        const m = Math.min(fa, 255 - fb);
        this.transfer(i, j, k, i, j - 1, k, m, false);
        fa -= m;
        if (fa === 0) return;
      } else {
        // Cohesive sand bridging a gap: is it held up by its neighbours?
        this.markSupport(i, j, k);
        return;
      }
    }

    // Rule 2: slump toward lower neighbours.
    const maxSlope = MAX_SLOPE[prop];
    if (maxSlope >= HOLDS_VERTICAL) return;
    const fAbove = j + 1 < w.ny ? w.fillAt(i, j + 1, k) : 0;
    const start = (this.rng() * 8) | 0;
    for (let n = 0; n < 8 && fa > 0; n++) {
      const d = (start + n) & 7;
      const ni = i + DX[d];
      const nk = k + DZ[d];
      if (ni < 0 || nk < 0 || ni >= w.nx || nk >= w.nz) continue; // the edge of the beach acts as a wall
      if (d >= 4 && w.fillAt(ni, j, k) === 255 && w.fillAt(i, j, nk) === 255) continue; // no squeezing through corners
      const fn = w.fillAt(ni, j, nk);
      if (fn === 255) continue;
      let hN: number;
      let tj: number;
      if (fn > 0) {
        if (j > 0 && w.fillAt(ni, j - 1, nk) < 96) continue; // neighbour isn't resting on anything
        hN = fn / 255;
        tj = j;
      } else {
        const fd = j > 0 ? w.fillAt(ni, j - 1, nk) : 255;
        if (fd === 255) {
          hN = 0;
          tj = j;
        } else if (fd > 0) {
          hN = -1 + fd / 255;
          tj = j - 1;
        } else {
          // A steep drop: find the neighbour's surface further down (up to 6 cells),
          // so sand on a tall face slides all the way down instead of trickling.
          let jj = j - 2;
          while (jj >= 0 && jj > j - 7 && w.fillAt(ni, jj, nk) === 0) jj--;
          if (jj < 0) {
            hN = -j;
            tj = 0;
          } else {
            const fs = w.fillAt(ni, jj, nk);
            hN = -(j - jj) + fs / 255;
            tj = fs === 255 ? jj + 1 : jj;
          }
        }
      }
      const hA = fAbove >= 128 ? 1 : fa / 255;
      const slope = (hA - hN) / DIST[d];
      if (slope <= maxSlope) continue;
      let m = Math.floor((slope - maxSlope) * DIST[d] * 127.5);
      if (m > fa) m = fa;
      const ft = tj === j ? fn : w.fillAt(ni, tj, nk);
      if (m > 255 - ft) m = 255 - ft;
      if (m < 3) continue;
      this.transfer(i, j, k, ni, tj, nk, m, true);
      fa -= m;
    }
  }

  /** Move `m` units of sand from cell A to cell B, mixing moisture (and compaction unless loosened). */
  transfer(ai: number, aj: number, ak: number, bi: number, bj: number, bk: number, m: number, loosen: boolean): void {
    if (m <= 0) return;
    const w = this.world;
    const cA = w.chunkForCell(ai, aj, ak);
    const cB = w.chunkForCell(bi, bj, bk);
    const la = (ai & 15) | ((ak & 15) << 4) | ((aj & 15) << 8);
    const lb = (bi & 15) | ((bk & 15) << 4) | ((bj & 15) << 8);
    w.touch(cA);
    if (cB !== cA) w.touch(cB);
    const fb = cB.fill[lb];
    const nf = fb + m;
    cB.wet[lb] = Math.round((cB.wet[lb] * fb + cA.wet[la] * m) / nf);
    cB.pack[lb] = Math.round((cB.pack[lb] * fb + (loosen ? 0 : cA.pack[la]) * m) / nf);
    cB.fill[lb] = nf;
    const fa = cA.fill[la] - m;
    cA.fill[la] = fa;
    if (fa === 0) {
      cA.wet[la] = 0;
      cA.pack[la] = 0;
    }
    w.changed(cA, la);
    w.changed(cB, lb);
    this.stats.moved += m;
    this.wakeAround(ai, aj, ak);
    this.enqueue(bi, bj, bk);
    this.enqueue(bi, bj + 1, bk);
  }

  // ---------- falling sand ----------

  /** Turn a cell into a falling crumb. */
  dropCell(i: number, j: number, k: number): void {
    const w = this.world;
    const c = w.chunkForCell(i, j, k);
    const li = (i & 15) | ((k & 15) << 4) | ((j & 15) << 8);
    const f = c.fill[li];
    if (f === 0) return;
    const vx = (this.rng() - 0.5) * 0.25;
    const vz = (this.rng() - 0.5) * 0.25;
    if (!this.particles.add(w.cellX(i), w.cellY(j), w.cellZ(k), vx, 0, vz, f, c.wet[li], 0, w.undoRecordId)) {
      // Too many crumbs in the air: drop it straight down instead.
      let jj = j - 1;
      while (jj >= 0 && w.fillAt(i, jj, k) < 128) jj--;
      const wet = c.wet[li];
      w.touch(c);
      c.fill[li] = 0;
      c.wet[li] = 0;
      c.pack[li] = 0;
      w.changed(c, li);
      this.deposit(i, jj + 1, k, f, wet);
      this.wakeAround(i, j, k);
      return;
    }
    w.touch(c);
    c.fill[li] = 0;
    c.wet[li] = 0;
    c.pack[li] = 0;
    w.changed(c, li);
    this.stats.fell += f;
    this.wakeAround(i, j, k);
  }

  /** Put sand into a column, starting at cell (i, j, k) and stacking upward. */
  deposit(i: number, j: number, k: number, amount: number, wet: number): void {
    const w = this.world;
    if (i < 0) i = 0;
    if (k < 0) k = 0;
    if (i >= w.nx) i = w.nx - 1;
    if (k >= w.nz) k = w.nz - 1;
    if (j < 0) j = 0;
    let m = amount;
    while (m > 0 && j < w.ny) {
      const c = w.chunkForCell(i, j, k);
      const li = (i & 15) | ((k & 15) << 4) | ((j & 15) << 8);
      const f = c.fill[li];
      if (f < 255) {
        const put = Math.min(m, 255 - f);
        w.touch(c);
        const nf = f + put;
        c.wet[li] = Math.round((c.wet[li] * f + wet * put) / nf);
        c.pack[li] = Math.round((c.pack[li] * f) / nf);
        c.fill[li] = nf;
        w.changed(c, li);
        m -= put;
        this.wakeAround(i, j, k);
      }
      j++;
    }
    this.stats.landed += amount - m;
    if (m > 0) {
      // The column is full to the sky (should never happen); spread to a neighbour.
      this.deposit(i + 1 < w.nx ? i + 1 : i - 1, 0, k, m, wet);
    }
  }

  private updateParticles(dt: number): void {
    const P = this.particles;
    const w = this.world;
    const ox0 = w.originX;
    const oy0 = w.originY;
    const oz0 = w.originZ;
    const xMax = ox0 + w.nx * CELL - 1e-4;
    const zMax = oz0 + w.nz * CELL - 1e-4;
    const stepLen = CELL * 0.7;
    for (let p = 0; p < P.n; ) {
      const cosmetic = P.amt[p] === 0;
      if (cosmetic) {
        P.life[p] -= dt;
        if (P.life[p] <= 0) {
          P.remove(p);
          continue;
        }
      }
      P.vy[p] = Math.max(-7, P.vy[p] - 9.8 * dt);
      if (cosmetic) {
        P.vx[p] *= 0.97;
        P.vz[p] *= 0.97;
      }
      const sx = P.x[p];
      const sy = P.y[p];
      const sz = P.z[p];
      const dx = P.vx[p] * dt;
      const dy = P.vy[p] * dt;
      const dz = P.vz[p] * dt;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const steps = Math.max(1, Math.ceil(len / stepLen));
      let px = sx;
      let py = sy;
      let pz = sz;
      let landed = false;
      for (let s = 1; s <= steps; s++) {
        let qx = sx + (dx * s) / steps;
        const qy = sy + (dy * s) / steps;
        let qz = sz + (dz * s) / steps;
        if (qx < ox0 || qx > xMax) {
          qx = qx < ox0 ? ox0 + 1e-4 : xMax;
          P.vx[p] = 0;
        }
        if (qz < oz0 || qz > zMax) {
          qz = qz < oz0 ? oz0 + 1e-4 : zMax;
          P.vz[p] = 0;
        }
        const ci = Math.floor((qx - ox0) / CELL);
        const cj = Math.floor((qy - oy0) / CELL);
        const ck = Math.floor((qz - oz0) / CELL);
        if (cj < 0) {
          landed = true;
          break;
        }
        if (cj < w.ny) {
          const f = w.fillAt(ci, cj, ck);
          if (f > 0 && qy < oy0 + (cj + f / 255) * CELL) {
            landed = true;
            break;
          }
        }
        px = qx;
        py = qy;
        pz = qz;
      }
      if (landed) {
        if (!cosmetic) {
          const ci = Math.floor((px - ox0) / CELL);
          const cj = Math.max(0, Math.floor((py - oy0) / CELL));
          const ck = Math.floor((pz - oz0) / CELL);
          this.deposit(ci, Math.min(cj, w.ny - 1), ck, P.amt[p], P.wet[p]);
        }
        P.remove(p);
        continue;
      }
      P.x[p] = px;
      P.y[p] = py;
      P.z[p] = pz;
      p++;
    }
  }

  /** Remove crumbs created after an undo point (their sand is restored by the undo). */
  removeParticlesFrom(recordId: number): void {
    const P = this.particles;
    for (let p = 0; p < P.n; ) {
      if (P.rec[p] >= recordId && P.amt[p] > 0) P.remove(p);
      else p++;
    }
  }

  /** Land every crumb immediately (used by the checks to finish quickly). */
  landAllParticles(): void {
    for (let guard = 0; guard < 2000 && this.particles.n > 0; guard++) this.updateParticles(1 / 30);
  }

  // ---------- rule 3: overhangs ----------

  private processSupport(): void {
    if (this.support.size === 0) return;
    // Group candidates by chunk so each region stays small.
    const groups = new Map<number, number[]>();
    const w = this.world;
    for (const key of this.support) {
      const i = key & 1023;
      const k = (key >> 10) & 1023;
      const j = key >>> 20;
      const g = (i >> 4) + (k >> 4) * w.ncx + (j >> 4) * w.ncxz;
      let list = groups.get(g);
      if (!list) groups.set(g, (list = []));
      list.push(key);
    }
    this.support.clear();
    for (const cells of groups.values()) this.supportRegion(cells);
  }

  private supportRegion(cells: number[]): void {
    const w = this.world;
    let i0 = 1e9, j0 = 1e9, k0 = 1e9, i1 = -1, j1 = -1, k1 = -1;
    for (const key of cells) {
      const i = key & 1023;
      const k = (key >> 10) & 1023;
      const j = key >>> 20;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
    }
    const M = MAX_SPAN + 1;
    const ri0 = Math.max(0, i0 - M);
    const ri1 = Math.min(w.nx - 1, i1 + M);
    const rk0 = Math.max(0, k0 - M);
    const rk1 = Math.min(w.nz - 1, k1 + M);
    const rj0 = Math.max(0, j0 - M);
    const rj1 = Math.min(w.ny - 1, j1 + 12);
    const rx = ri1 - ri0 + 1;
    const ry = rj1 - rj0 + 1;
    const rz = rk1 - rk0 + 1;
    const N = rx * ry * rz;
    if (this.bufFill.length < N) {
      this.bufFill = new Uint8Array(N);
      this.bufWet = new Uint8Array(N);
      this.bufPack = new Uint8Array(N);
      this.bufSpan = new Uint8Array(N);
      this.bufCost = new Uint8Array(N);
    }
    const fill = this.bufFill;
    const span = this.bufSpan;
    const cost = this.bufCost;
    w.sampleBlock(ri0, rj0, rk0, rx, ry, rz, fill, this.bufWet, this.bufPack);
    const sxz = rx * rz;
    for (let o = 0; o < N; o++) {
      span[o] = SPAN[(this.bufWet[o] << 8) | this.bufPack[o]];
      cost[o] = 255;
    }
    const B = this.buckets;
    for (const b of B) b.clear();
    // Sources: sand standing on solid ground below the region, and the region's outer shell
    // (assumed to be held up from outside; the shell is far enough away not to matter).
    for (let y = 0; y < ry; y++) {
      for (let z = 0; z < rz; z++) {
        for (let x = 0; x < rx; x++) {
          const o = x + z * rx + y * sxz;
          if (fill[o] < 128) continue;
          let src = x === 0 || z === 0 || x === rx - 1 || z === rz - 1 || y === ry - 1;
          if (!src && y === 0) src = rj0 === 0 || w.fillAt(ri0 + x, rj0 - 1, rk0 + z) >= 128;
          if (src) {
            cost[o] = 0;
            B[0].push(o);
          }
        }
      }
    }
    // Cheapest-path search: resting on supported sand is free; reaching sideways or hanging costs 1.
    for (let c = 0; c <= MAX_SPAN; c++) {
      const list = B[c];
      for (let n = 0; n < list.length; n++) {
        const o = list.data[n];
        if (cost[o] !== c) continue;
        const y = Math.floor(o / sxz);
        const rem = o - y * sxz;
        const z = Math.floor(rem / rx);
        const x = rem - z * rx;
        if (y + 1 < ry) {
          const u = o + sxz;
          if (fill[u] >= 128 && cost[u] > c) {
            cost[u] = c;
            list.push(u);
          }
        }
        const c1 = c + 1;
        if (c1 > MAX_SPAN || span[o] < c1) continue;
        const nb = B[c1];
        if (x > 0) this.relax(o - 1, c1, nb);
        if (x < rx - 1) this.relax(o + 1, c1, nb);
        if (z > 0) this.relax(o - rx, c1, nb);
        if (z < rz - 1) this.relax(o + rx, c1, nb);
        if (y > 0) this.relax(o - sxz, c1, nb);
      }
    }
    // Anything left unreached has nothing holding it up.
    for (let y = 0; y < ry - 1; y++) {
      for (let z = 1; z < rz - 1; z++) {
        for (let x = 1; x < rx - 1; x++) {
          const o = x + z * rx + y * sxz;
          const f = fill[o];
          if (f === 0) continue;
          let held: boolean;
          if (f >= 128) held = cost[o] !== 255;
          else if (y > 0) held = fill[o - sxz] >= 128 && cost[o - sxz] !== 255;
          else held = rj0 === 0 || w.fillAt(ri0 + x, rj0 - 1, rk0 + z) >= 128;
          if (!held) this.dropCell(ri0 + x, rj0 + y, rk0 + z);
        }
      }
    }
  }

  private relax(o: number, c: number, list: IntList): void {
    if (this.bufFill[o] >= 128 && this.bufCost[o] > c && this.bufSpan[o] >= c) {
      this.bufCost[o] = c;
      list.push(o);
    }
  }

  // ---------- rule 4: drying ----------

  private drying(dt: number): void {
    this.dryAccum += dt;
    if (this.dryAccum < 0.1) return;
    const elapsed = this.dryAccum;
    this.dryAccum = 0;
    const list = this.world.list;
    if (list.length === 0) return;
    // Visit every stored chunk about every 2 seconds.
    const count = Math.min(list.length, Math.max(1, Math.ceil((list.length * elapsed) / 2)));
    for (let n = 0; n < count; n++) {
      if (this.dryCursor >= list.length) this.dryCursor = 0;
      this.dryChunk(list[this.dryCursor++]);
    }
  }

  private dryChunk(c: Chunk): void {
    const w = this.world;
    const dtc = c.lastDry < 0 ? 0 : Math.min(10, this.time - c.lastDry);
    c.lastDry = this.time;
    if (!c.surface) c.surface = this.computeSurface(c);
    const surf = c.surface;
    if (surf.length === 0) return;
    const wl = w.terrain.waterLevel;
    let visual = false;
    for (let s = 0; s < surf.length; s++) {
      const li = surf[s] & 0xffff;
      if (c.fill[li] === 0) continue;
      const exposure = surf[s] >> 16 ? 1 : 0.5;
      const j = c.cy * 16 + (li >> 8);
      const y = w.cellY(j);
      const old = c.wet[li];
      let nw = old;
      if (y < wl - 0.015) {
        nw = 255;
      } else {
        const above = y - wl;
        // Near the water table, water wicks up and keeps the surface damp.
        const cap = above < 0.3 ? (235 + (120 - 235) * (above / 0.3)) * 0.9 : 0;
        const loss = this.dryRate * exposure * dtc;
        let target = old - loss;
        if (loss > 0) {
          const whole = Math.floor(target);
          target = whole + (this.rng() < target - whole ? 1 : 0);
        }
        if (target < cap) target = Math.min(cap, old + 2 * dtc);
        nw = Math.max(0, Math.min(255, Math.round(target)));
      }
      if (nw === old) continue;
      c.wet[li] = nw;
      if (old >> 4 !== nw >> 4) visual = true;
      for (const t of WET_STEPS) {
        if ((old >= t) !== (nw >= t)) {
          const i = c.cx * 16 + (li & 15);
          const k = c.cz * 16 + ((li >> 4) & 15);
          this.enqueue(i, j, k);
          break;
        }
      }
    }
    if (visual && this.onWetVisual) this.onWetVisual(c);
  }

  /** Cells touching the air. Bit 16 set = open to the sky (dries fastest). */
  private computeSurface(c: Chunk): Int32Array {
    const w = this.world;
    const out: number[] = [];
    const i0 = c.cx * 16;
    const j0 = c.cy * 16;
    const k0 = c.cz * 16;
    for (let li = 0; li < 4096; li++) {
      if (c.fill[li] === 0) continue;
      const lx = li & 15;
      const lz = (li >> 4) & 15;
      const ly = li >> 8;
      const above = ly < 15 ? c.fill[li + 256] : w.fillAt(i0 + lx, j0 + 16, k0 + lz);
      if (above < 128) {
        out.push(li | (1 << 16));
        continue;
      }
      const xm = lx > 0 ? c.fill[li - 1] : w.fillAt(i0 - 1, j0 + ly, k0 + lz);
      const xp = lx < 15 ? c.fill[li + 1] : w.fillAt(i0 + 16, j0 + ly, k0 + lz);
      const zm = lz > 0 ? c.fill[li - 16] : w.fillAt(i0 + lx, j0 + ly, k0 - 1);
      const zp = lz < 15 ? c.fill[li + 16] : w.fillAt(i0 + lx, j0 + ly, k0 + 16);
      const below = ly > 0 ? c.fill[li - 256] : w.fillAt(i0 + lx, j0 - 1, k0 + lz);
      if (xm < 64 || xp < 64 || zm < 64 || zp < 64 || below < 64) out.push(li);
    }
    return Int32Array.from(out);
  }
}
