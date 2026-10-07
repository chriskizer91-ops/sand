/**
 * Streams: which parts of the world the page needs re-sent, and how often.
 *
 * The page keeps its own copy of the ground (512 x 512 columns) and of the life grid
 * (256 x 256 patches) to draw them. Re-sending everything after each change would swamp
 * the phone, so the engine remembers what changed in a coarse map of "dirty tiles"
 * (32 x 32 cells each). Each tile keeps the smallest rectangle inside it that changed, so
 * lava on one island and sand on another become two small messages, never one rectangle
 * spanning the sea between them. When it is time to send, neighbouring dirty tiles in the
 * same row are joined into one message when that wastes little, which keeps the message
 * count low for big pours.
 *
 * How often (ARCHITECTURE §5.1): the ground is sent at most 15 times a second while lava,
 * sand or a stroke is moving and 4 times a second otherwise; the life grid at most twice a
 * second. Packing has a time budget; whatever doesn't fit waits for the next send, resuming
 * where it stopped so no part of the world is starved.
 */
import { NP, NX, NZ } from '../config';
import type { EcoPack, Ecology } from '../eco/ecology';
import type { Columns } from './columns';
import { PLANT_BYTES, type FromEngine } from './protocol';

/** How the engine talks to the page. Buffers in `transfer` are handed over, not copied. */
export type Post = (msg: FromEngine, transfer?: Transferable[]) => void;

/** Cells per dirty-tile side (columns for the ground, patches for the life grid). */
export const STREAM_TILE = 32;
/** Rows per message while the whole world is (re)sent after a load or reset. */
export const BAND_ROWS = 32;

/** Fastest ground resend while something is moving, and while all is quiet (seconds). */
export const COLS_INTERVAL_ACTIVE = 1 / 15;
export const COLS_INTERVAL_IDLE = 1 / 4;
/** Fastest life-grid resend (seconds). */
export const ECO_INTERVAL = 1 / 2;

/** Milliseconds from a steady clock (worker, page and Node all have `performance`). */
export function now(): number {
  return performance.now();
}

export type RectSink = (x0: number, z0: number, w: number, h: number) => void;

/**
 * A map of dirty tiles over a width x height grid. Each tile stores the inclusive rectangle
 * that changed inside it (-1 = clean).
 */
export class DirtyTiles {
  readonly tilesX: number;
  readonly tilesZ: number;
  private readonly x0: Int16Array;
  private readonly z0: Int16Array;
  private readonly x1: Int16Array;
  private readonly z1: Int16Array;
  private count = 0;
  /** Tile row to resume from when the last flush ran out of time. */
  private cursor = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly tile = STREAM_TILE,
  ) {
    this.tilesX = Math.ceil(width / tile);
    this.tilesZ = Math.ceil(height / tile);
    const n = this.tilesX * this.tilesZ;
    this.x0 = new Int16Array(n).fill(-1);
    this.z0 = new Int16Array(n);
    this.x1 = new Int16Array(n);
    this.z1 = new Int16Array(n);
  }

  /** Number of dirty tiles. */
  get dirtyTiles(): number {
    return this.count;
  }

  /** Note a changed rectangle (inclusive bounds; clamped to the grid). */
  mark(i0: number, k0: number, i1: number, k1: number): void {
    i0 = Math.max(0, i0);
    k0 = Math.max(0, k0);
    i1 = Math.min(this.width - 1, i1);
    k1 = Math.min(this.height - 1, k1);
    if (i1 < i0 || k1 < k0) return;
    const T = this.tile;
    const tx0 = (i0 / T) | 0;
    const tx1 = (i1 / T) | 0;
    const tz0 = (k0 / T) | 0;
    const tz1 = (k1 / T) | 0;
    for (let tz = tz0; tz <= tz1; tz++) {
      const a0 = Math.max(k0, tz * T);
      const a1 = Math.min(k1, tz * T + T - 1);
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = tx + tz * this.tilesX;
        const b0 = Math.max(i0, tx * T);
        const b1 = Math.min(i1, tx * T + T - 1);
        if (this.x0[t] < 0) {
          this.x0[t] = b0;
          this.x1[t] = b1;
          this.z0[t] = a0;
          this.z1[t] = a1;
          this.count++;
        } else {
          if (b0 < this.x0[t]) this.x0[t] = b0;
          if (b1 > this.x1[t]) this.x1[t] = b1;
          if (a0 < this.z0[t]) this.z0[t] = a0;
          if (a1 > this.z1[t]) this.z1[t] = a1;
        }
      }
    }
  }

  clear(): void {
    this.x0.fill(-1);
    this.count = 0;
    this.cursor = 0;
  }

  /**
   * Hand dirty rectangles to `sink`, joining neighbouring tiles of a row when the joined
   * rectangle is at most twice the area it covers. Stops once `deadline` (from now()) has
   * passed, but always sends at least one rectangle so progress never stalls. Returns the
   * number of rectangles sent.
   */
  flush(sink: RectSink, deadline: number): number {
    let sent = 0;
    const W = this.tilesX;
    for (let r = 0; r < this.tilesZ && this.count > 0; r++) {
      const row = (this.cursor + r) % this.tilesZ;
      let tx = 0;
      while (tx < W) {
        const t = tx + row * W;
        if (this.x0[t] < 0) {
          tx++;
          continue;
        }
        let x0 = this.x0[t];
        let x1 = this.x1[t];
        let z0 = this.z0[t];
        let z1 = this.z1[t];
        let area = (x1 - x0 + 1) * (z1 - z0 + 1);
        this.take(t);
        let end = tx + 1;
        while (end < W) {
          const u = end + row * W;
          if (this.x0[u] < 0) break;
          const nz0 = Math.min(z0, this.z0[u]);
          const nz1 = Math.max(z1, this.z1[u]);
          const a = (this.x1[u] - this.x0[u] + 1) * (this.z1[u] - this.z0[u] + 1);
          if ((this.x1[u] - x0 + 1) * (nz1 - nz0 + 1) > 2 * (area + a)) break;
          x1 = this.x1[u];
          z0 = nz0;
          z1 = nz1;
          area += a;
          this.take(u);
          end++;
        }
        sink(x0, z0, x1 - x0 + 1, z1 - z0 + 1);
        sent++;
        tx = end;
        if (now() >= deadline && this.count > 0) {
          this.cursor = row;
          return sent;
        }
      }
    }
    return sent;
  }

  private take(t: number): void {
    this.x0[t] = -1;
    this.count--;
  }
}

/**
 * "At most this often": a stream may send again once `interval` seconds have passed since
 * it last sent. Time keeps counting while there is nothing to send, so the first change
 * after a quiet spell goes out on the very next tick.
 */
export class RateLimit {
  private since = Number.POSITIVE_INFINITY;

  advance(dt: number): void {
    this.since += dt;
  }
  ready(interval: number): boolean {
    return this.since >= interval - 1e-6;
  }
  sent(): void {
    this.since = 0;
  }
  reset(): void {
    this.since = Number.POSITIVE_INFINITY;
  }
}

/** The ground stream: 'cols' messages (visible height and ground bytes for a column rectangle). */
export class ColsStream {
  readonly dirty = new DirtyTiles(NX, NZ);
  private readonly rate = new RateLimit();
  private cols: Columns | null = null;

  constructor(private readonly post: Post) {}

  /** Start streaming a (new) world: forget everything pending. */
  attach(cols: Columns): void {
    this.cols = cols;
    this.dirty.clear();
    this.rate.reset();
  }

  mark(i0: number, k0: number, i1: number, k1: number): void {
    this.dirty.mark(i0, k0, i1, k1);
  }

  /** Pack and send one rectangle now (fresh buffers, transferred to the page). */
  sendRect(x0: number, z0: number, w: number, h: number): void {
    const cols = this.cols;
    if (!cols) return;
    const surf = new Float32Array(w * h);
    const ground = new Uint8Array(w * h * 4);
    cols.packRect(x0, z0, w, h, surf, ground);
    this.post({ t: 'cols', x0, z0, w, h, surf, ground }, [surf.buffer, ground.buffer]);
  }

  /**
   * Called every tick: send what changed if the rate allows (faster while `active`), within
   * the packing deadline.
   */
  flush(dt: number, active: boolean, deadline: number): void {
    this.rate.advance(dt);
    if (this.dirty.dirtyTiles === 0 || !this.rate.ready(active ? COLS_INTERVAL_ACTIVE : COLS_INTERVAL_IDLE)) return;
    this.dirty.flush(this.sink, deadline);
    this.rate.sent();
  }

  private readonly sink: RectSink = (x0, z0, w, h) => this.sendRect(x0, z0, w, h);
}

/** The life-grid stream: 'eco' messages (cover, plants and habitat bytes for a patch rectangle). */
export class EcoStream {
  readonly dirty = new DirtyTiles(NP, NP);
  private readonly rate = new RateLimit();
  private eco: Ecology | null = null;

  constructor(private readonly post: Post) {}

  attach(eco: Ecology): void {
    this.eco = eco;
    this.dirty.clear();
    this.rate.reset();
  }

  /** Pack and send one patch rectangle now. */
  sendRect(x0: number, z0: number, w: number, h: number): void {
    const eco = this.eco;
    if (!eco) return;
    const n = w * h;
    const out: EcoPack = {
      a: new Uint8Array(n * 4),
      b: new Uint8Array(n * 4),
      c: new Uint8Array(n * 4),
      plants: new Uint8Array(n * PLANT_BYTES),
      habitat: new Uint8Array(n),
    };
    eco.packEco(x0, z0, w, h, out);
    this.post({ t: 'eco', x0, z0, w, h, ...out }, [out.a.buffer, out.b.buffer, out.c.buffer, out.plants.buffer, out.habitat.buffer]);
  }

  /** Called every tick: at most twice a second, collect the ecology's changes and send them. */
  flush(dt: number, deadline: number): void {
    this.rate.advance(dt);
    if (!this.eco || !this.rate.ready(ECO_INTERVAL)) return;
    const d = this.eco.takeDirty();
    if (d) this.dirty.mark(d[0], d[1], d[2], d[3]);
    if (this.dirty.dirtyTiles === 0) return;
    this.dirty.flush(this.sink, deadline);
    this.rate.sent();
  }

  private readonly sink: RectSink = (x0, z0, w, h) => this.sendRect(x0, z0, w, h);
}
