/**
 * Which parts of the life grid changed since the page was last sent them.
 *
 * The eco stream asks for one rectangle at a time (Ecology.takeDirty). If every change since
 * the last send went into one bounding box, a chain of islands growing at once would re-send
 * the whole chain twice a second (about 1 MB/s). So changes are kept per 32 x 32-patch tile,
 * and each take hands over one neighbourhood (at most 3 x 3 tiles) in turn, round the zone.
 * What the player just did (a stroke, an arrival they are watching) is "urgent" and goes first.
 */
import { NP } from '../config';

const TILE = 32;
const TX = NP / TILE;
const TILES = TX * TX;
/** Tiles per side of the neighbourhood one take hands over. */
const SPAN = 3;

export type PatchRect = [number, number, number, number];

export class Dirt {
  private readonly x0 = new Int16Array(TILES).fill(-1);
  private readonly z0 = new Int16Array(TILES);
  private readonly x1 = new Int16Array(TILES);
  private readonly z1 = new Int16Array(TILES);
  private readonly urgent = new Uint8Array(TILES);
  private count = 0;
  private urgentN = 0;
  private cursor = 0;

  /** Note a changed patch rectangle (inclusive; clamped to the grid). */
  mark(i0: number, k0: number, i1: number, k1: number, urgent: boolean): void {
    i0 = Math.max(0, i0);
    k0 = Math.max(0, k0);
    i1 = Math.min(NP - 1, i1);
    k1 = Math.min(NP - 1, k1);
    if (i1 < i0 || k1 < k0) return;
    const tz1 = (k1 / TILE) | 0;
    const tx1 = (i1 / TILE) | 0;
    for (let tz = (k0 / TILE) | 0; tz <= tz1; tz++) {
      const a0 = Math.max(k0, tz * TILE);
      const a1 = Math.min(k1, tz * TILE + TILE - 1);
      for (let tx = (i0 / TILE) | 0; tx <= tx1; tx++) {
        this.add(tx + tz * TX, Math.max(i0, tx * TILE), a0, Math.min(i1, tx * TILE + TILE - 1), a1, urgent);
      }
    }
  }

  /** Note one changed patch. */
  markPatch(pi: number, pk: number, urgent: boolean): void {
    this.add(((pi / TILE) | 0) + ((pk / TILE) | 0) * TX, pi, pk, pi, pk, urgent);
  }

  private add(t: number, x0: number, z0: number, x1: number, z1: number, urgent: boolean): void {
    if (this.x0[t] < 0) {
      this.x0[t] = x0;
      this.z0[t] = z0;
      this.x1[t] = x1;
      this.z1[t] = z1;
      this.count++;
    } else {
      if (x0 < this.x0[t]) this.x0[t] = x0;
      if (z0 < this.z0[t]) this.z0[t] = z0;
      if (x1 > this.x1[t]) this.x1[t] = x1;
      if (z1 > this.z1[t]) this.z1[t] = z1;
    }
    if (urgent && !this.urgent[t]) {
      this.urgent[t] = 1;
      this.urgentN++;
    }
  }

  /** Everything changed and not yet taken, as one rectangle (or null). */
  bounds(): PatchRect | null {
    if (this.count === 0) return null;
    let x0 = NP;
    let z0 = NP;
    let x1 = -1;
    let z1 = -1;
    for (let t = 0; t < TILES; t++) {
      if (this.x0[t] < 0) continue;
      x0 = Math.min(x0, this.x0[t]);
      z0 = Math.min(z0, this.z0[t]);
      x1 = Math.max(x1, this.x1[t]);
      z1 = Math.max(z1, this.z1[t]);
    }
    return [x0, z0, x1, z1];
  }

  /**
   * Hand over the next rectangle to send and forget it: all urgent tiles if there are any,
   * else the next changed neighbourhood round the zone.
   */
  take(): PatchRect | null {
    if (this.count === 0) return null;
    const r: PatchRect = [NP, NP, -1, -1];
    if (this.urgentN > 0) {
      for (let t = 0; t < TILES; t++) if (this.urgent[t]) this.takeTile(t, r);
      return r;
    }
    let first = -1;
    for (let k = 0; k < TILES && first < 0; k++) {
      const t = (this.cursor + k) % TILES;
      if (this.x0[t] >= 0) first = t;
    }
    const fx = first % TX;
    const fz = (first / TX) | 0;
    for (let tz = fz; tz < Math.min(TX, fz + SPAN); tz++) {
      for (let tx = Math.max(0, fx - 1); tx < Math.min(TX, fx - 1 + SPAN); tx++) {
        const t = tx + tz * TX;
        if (this.x0[t] >= 0) this.takeTile(t, r);
      }
    }
    this.cursor = (first + 1) % TILES;
    return r;
  }

  private takeTile(t: number, r: PatchRect): void {
    if (this.x0[t] >= 0) {
      r[0] = Math.min(r[0], this.x0[t]);
      r[1] = Math.min(r[1], this.z0[t]);
      r[2] = Math.max(r[2], this.x1[t]);
      r[3] = Math.max(r[3], this.z1[t]);
      this.x0[t] = -1;
      this.count--;
    }
    if (this.urgent[t]) {
      this.urgent[t] = 0;
      this.urgentN--;
    }
  }

  clear(): void {
    this.x0.fill(-1);
    this.urgent.fill(0);
    this.count = 0;
    this.urgentN = 0;
    this.cursor = 0;
  }
}
