/**
 * Sand: loose sediment sliding to its angle of repose (WP-B, ARCHITECTURE §5.2).
 *
 * Rules:
 *  - Dry sand (above +1.2 m) holds about 34°, sand under water about 28°.
 *  - In the swash band (-1.5 to +1.2 m), where waves wash up and down a beach, sand relaxes
 *    toward a gentle 1:8 face. That is what turns a mound poured at the shore into a beach.
 *    During a storm the band widens and the face flattens further.
 *  - Sand never slides into molten lava, and sand under lava stays put until it freezes.
 *  - Sand is never created or destroyed here: every move takes an exact amount from one
 *    column and gives the same amount to its neighbour.
 *
 * Only "active" columns (ones that just changed or sit next to a change) cost anything; sand
 * at rest is free. A sweep visits every active column once; a long sweep can be split over
 * several physics steps when time runs out, so the sand slows down rather than skipping.
 *
 * This file also holds the small pieces every geology module shares (the active-set list,
 * the change tracker, the neighbour tables, the sediment grid). Sand is the base layer the
 * others build on: lava wakes sand when it freezes, and the tools and the coast wake both.
 */
import { CELL, COL_BLOCK, NX, NZ, PHYS_STEP, SEA_LEVEL } from '../../config';
import { mulberry32 } from '../noise';
import { ChangeFlag, type Columns } from '../columns';

// ---------- shared: neighbours, the zone wall, the sediment grid ----------

/** The 8 neighbours of a column (east, west, south, north, then the diagonals). */
const NB_DI: readonly number[] = [1, -1, 0, 0, 1, 1, -1, -1];
const NB_DK: readonly number[] = [0, 0, 1, -1, 1, -1, 1, -1];
/** Index offset of each neighbour (c + NB_OFF[d]). */
export const NB_OFF = Int32Array.from(NB_DI, (di, d) => di + NB_DK[d] * NX);
/** Centre-to-centre distance of each neighbour in metres (diagonals are √2 further). */
export const NB_DIST = Float64Array.from(NB_DI, (di, d) => (di !== 0 && NB_DK[d] !== 0 ? Math.SQRT2 : 1) * CELL);

/**
 * 1 on the outermost ring of columns. Lava and sand treat that ring as a wall: nothing flows
 * into it and nothing on it moves. That way every column that does move has all 8 neighbours
 * inside the grid, and the hot loops need no bounds checks.
 */
export const EDGE: Uint8Array = (() => {
  const e = new Uint8Array(NX * NZ);
  for (let i = 0; i < NX; i++) {
    e[i] = 1;
    e[i + (NZ - 1) * NX] = 1;
  }
  for (let k = 0; k < NZ; k++) {
    e[k * NX] = 1;
    e[NX - 1 + k * NX] = 1;
  }
  return e;
})();

/**
 * Sediment thickness is kept on a grid of 1/65536 m. Sums and differences of such numbers are
 * exact in 32-bit floats up to 256 m, so sliding sand from column to column conserves volume
 * exactly, however many millions of moves a long game makes. Every sediment write in the
 * geology modules goes through this.
 */
const SED_Q = 65536;
export function qSed(x: number): number {
  return Math.round(x * SED_Q) / SED_Q;
}

/** A cheap integer hash (for per-column, per-step random choices that must be repeatable). */
export function hashInt(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** Report a changed column rectangle (inclusive) with ChangeFlag bits. */
export type Reporter = (i0: number, k0: number, i1: number, k1: number, flags: number) => void;

// ---------- shared: the active set ----------

/**
 * Columns that need work: a flag per column (so nothing is listed twice) plus a packed list.
 * The list grows when needed and never shrinks, so steady play allocates nothing.
 */
export class ActiveSet {
  readonly flag = new Uint8Array(NX * NZ);
  list = new Int32Array(4096);
  count = 0;

  /** List column c (no-op if already listed). */
  add(c: number): void {
    if (this.flag[c]) return;
    this.flag[c] = 1;
    if (this.count === this.list.length) {
      const l = new Int32Array(this.list.length * 2);
      l.set(this.list);
      this.list = l;
    }
    this.list[this.count++] = c;
  }

  clear(): void {
    for (let j = 0; j < this.count; j++) this.flag[this.list[j]] = 0;
    this.count = 0;
  }
}

// ---------- shared: change reporting ----------

const BLOCKS_X = NX / COL_BLOCK;
const BLOCKS = BLOCKS_X * (NZ / COL_BLOCK);
/** The grid and block sizes are powers of two, so block numbers come from cheap bit shifts. */
const NX_BITS = Math.log2(NX);
const BLOCK_BITS = Math.log2(COL_BLOCK);
if (!Number.isInteger(NX_BITS) || !Number.isInteger(BLOCK_BITS)) throw new Error('NX and COL_BLOCK must be powers of two');

const NX_MASK = NX - 1;
const ROW_BLOCK_SHIFT = NX_BITS + BLOCK_BITS;
const BLOCK_ROW_BITS = NX_BITS - BLOCK_BITS;

/** The 16 x 16 undo block holding column c (the same numbering as Columns.touch). */
export function blockOf(c: number): number {
  return ((c & NX_MASK) >> BLOCK_BITS) + ((c >> ROW_BLOCK_SHIFT) << BLOCK_ROW_BITS);
}

/**
 * Collects changed columns per 16 x 16 block (the undo block size) and reports one tight
 * rectangle per block. Two pours far apart then send two small rectangles to the page and
 * the ecology, not one huge one.
 */
export class ChangeTracker {
  private readonly i0 = new Int16Array(BLOCKS);
  private readonly k0 = new Int16Array(BLOCKS);
  private readonly i1 = new Int16Array(BLOCKS);
  private readonly k1 = new Int16Array(BLOCKS);
  private readonly flags = new Uint8Array(BLOCKS);
  private readonly list = new Int32Array(BLOCKS);
  private count = 0;

  /** Note that column c changed (flags must be non-zero). */
  mark(c: number, flags: number): void {
    const i = c & NX_MASK;
    const k = c >> NX_BITS;
    const b = blockOf(c);
    if (this.flags[b] === 0) {
      this.list[this.count++] = b;
      this.i0[b] = this.i1[b] = i;
      this.k0[b] = this.k1[b] = k;
    } else {
      if (i < this.i0[b]) this.i0[b] = i;
      else if (i > this.i1[b]) this.i1[b] = i;
      if (k < this.k0[b]) this.k0[b] = k;
      else if (k > this.k1[b]) this.k1[b] = k;
    }
    this.flags[b] |= flags;
  }

  /** Note that column c and possibly its 8 neighbours changed. */
  markAround(c: number, flags: number): void {
    this.mark(c, flags);
    const i = c & NX_MASK;
    const k = c >> NX_BITS;
    const b = blockOf(c);
    if (i > 0 && i - 1 < this.i0[b]) this.i0[b] = i - 1;
    if (i < NX - 1 && i + 1 > this.i1[b]) this.i1[b] = i + 1;
    if (k > 0 && k - 1 < this.k0[b]) this.k0[b] = k - 1;
    if (k < NZ - 1 && k + 1 > this.k1[b]) this.k1[b] = k + 1;
  }

  get pending(): boolean {
    return this.count > 0;
  }

  /** Report every changed block and start again. */
  flush(report: Reporter): void {
    for (let j = 0; j < this.count; j++) {
      const b = this.list[j];
      report(this.i0[b], this.k0[b], this.i1[b], this.k1[b], this.flags[b]);
      this.flags[b] = 0;
    }
    this.count = 0;
  }
}

// ---------- sand ----------

/** tan(34°): dry sand. */
const TAN_DRY = 0.6745;
/** tan(28°): sand under water. */
const TAN_WET = 0.5317;
/** Calm swash band and its 1:8 face. */
const SWASH_LO = SEA_LEVEL - 1.5;
const SWASH_HI = SEA_LEVEL + 1.2;
const TAN_SWASH = 1 / 8;
/** At full storm the band widens to -4..+3 m and the face flattens to 1:14. */
const STORM_LO = SEA_LEVEL - 4;
const STORM_HI = SEA_LEVEL + 3;
const TAN_STORM = 1 / 14;
/**
 * In the swash band sand creeps (waves nudge it) rather than avalanches, so it moves at this
 * share of the normal rate. A mound poured at the shore visibly eases into a beach face over
 * about 10-30 s, well within the minute the "shore face" check allows.
 */
const SWASH_RATE = 0.1;
/** Storm waves work the beach this many times harder at full storm. */
const STORM_SURF = 4;
/** Share of the excess drop moved per pair per step (half of it, as both columns change). */
const MOVE_SHARE = 0.45 / 2;
/** Largest move between two columns in one step (m). */
const MAX_MOVE = 0.5;
/** Drops within this of the allowed slope count as settled (m). */
const SETTLE_EPS = 0.002;
/**
 * The slow creep in the swash band stops a little earlier (2 cm over a 2 m step is under a
 * degree), so a finished beach goes quiet instead of creeping by millimetres for a minute.
 */
const SWASH_EPS = 0.02;
/** Number of shuffled neighbour orders to pick from. */
const PERMS = 32;
/** Sliding sand changes the ground's shape (never a tool change). */
const SLID = ChangeFlag.Geom;

export class Sand {
  readonly set = new ActiveSet();
  /** Sweep number in which each column last changed or was woken. */
  private readonly stamp = new Int32Array(NX * NZ);
  private sweep = 1;
  /** Position in the current sweep, or -1 between sweeps. */
  private cursor = -1;
  /** Number of listed columns when the current sweep began. */
  private sweepEnd = 0;
  private storm = 0;
  /** PERMS shuffled orders of the 8 neighbours (seeded), so sand has no favourite direction. */
  private readonly perms = new Uint8Array(PERMS * 8);
  /** Scratch: the solid top of each neighbour of the column being worked on. */
  private readonly tops = new Float64Array(8);

  constructor(
    private readonly cols: Columns,
    private readonly changes: ChangeTracker,
    seed: number,
  ) {
    const rnd = mulberry32(seed ^ 0x5a17d);
    for (let p = 0; p < PERMS; p++) {
      const o = p * 8;
      for (let d = 0; d < 8; d++) this.perms[o + d] = d;
      for (let d = 7; d > 0; d--) {
        const e = Math.floor(rnd() * (d + 1));
        const t = this.perms[o + d];
        this.perms[o + d] = this.perms[o + e];
        this.perms[o + e] = t;
      }
    }
  }

  /** Storm level 0..1 (widens and flattens the swash band). */
  setStorm(level: number): void {
    this.storm = Math.max(0, Math.min(1, level));
  }

  /** Forget everything that was sliding (a new sea). */
  clear(): void {
    this.set.clear();
    this.cursor = -1;
  }

  /** Put column c on the list if it has loose sand that could move. */
  wake(c: number): void {
    const cols = this.cols;
    if (EDGE[c] || cols.sed[c] <= 0 || cols.lava[c] > 0) return;
    this.stamp[c] = this.sweep;
    this.set.add(c);
  }

  /** Wake c and its 8 neighbours. */
  wakeAround(c: number): void {
    this.wake(c);
    if (EDGE[c]) return;
    for (let d = 0; d < 8; d++) this.wake(c + NB_OFF[d]);
  }

  /** Wake every sandy column in a rectangle (inclusive; clamped to the zone). */
  wakeRect(i0: number, k0: number, i1: number, k1: number): void {
    i0 = Math.max(0, i0);
    k0 = Math.max(0, k0);
    i1 = Math.min(NX - 1, i1);
    k1 = Math.min(NZ - 1, k1);
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) this.wake(i + k * NX);
  }

  /**
   * Wake only the columns in a rectangle whose sand is actually steeper than it can hold.
   * Used after big outside changes (undo, loading) so settled sand stays asleep.
   */
  wakeUnstableRect(i0: number, k0: number, i1: number, k1: number): void {
    i0 = Math.max(0, i0);
    k0 = Math.max(0, k0);
    i1 = Math.min(NX - 1, i1);
    k1 = Math.min(NZ - 1, k1);
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const c = i + k * NX;
        if (this.unstable(c)) this.wake(c);
      }
    }
  }

  /** Wake c and its neighbours, but only the ones that are steeper than they can hold. */
  wakeIfUnstable(c: number): void {
    if (this.unstable(c)) this.wake(c);
    if (EDGE[c]) return;
    for (let d = 0; d < 8; d++) {
      const n = c + NB_OFF[d];
      if (this.unstable(n)) this.wake(n);
    }
  }

  /** Could sand slide off column c right now? */
  unstable(c: number): boolean {
    const { rock, sed, lava } = this.cols;
    if (EDGE[c] || sed[c] <= 0 || lava[c] > 0) return false;
    const top = rock[c] + sed[c];
    const s = this.storm;
    const lo = SWASH_LO + (STORM_LO - SWASH_LO) * s;
    const hi = SWASH_HI + (STORM_HI - SWASH_HI) * s;
    const tanSwash = TAN_SWASH + (TAN_STORM - TAN_SWASH) * s;
    for (let d = 0; d < 8; d++) {
      const n = c + NB_OFF[d];
      if (EDGE[n] || lava[n] > 0) continue;
      const tn = rock[n] + sed[n];
      const drop = top - tn;
      if (drop <= SETTLE_EPS) continue;
      const mid = (top + tn) * 0.5;
      if (mid > hi ? drop - NB_DIST[d] * TAN_DRY > SETTLE_EPS : mid >= lo ? drop - NB_DIST[d] * tanSwash > SWASH_EPS : drop - NB_DIST[d] * TAN_WET > SETTLE_EPS) return true;
    }
    return false;
  }

  /**
   * Slide sand for one physics step of dt seconds. Works through the current sweep until it is
   * done or `deadline` (performance.now() time) passes; an unfinished sweep continues next step.
   * Returns the volume moved (m^3).
   */
  step(dt: number, deadline: number): number {
    const set = this.set;
    if (this.cursor < 0) {
      if (set.count === 0) return 0;
      this.sweepEnd = set.count;
      this.cursor = (this.sweep & 1) === 1 ? this.sweepEnd - 1 : 0;
    }
    const { rock, sed, lava, sandKind } = this.cols;
    const cols = this.cols;
    const changes = this.changes;
    const stamp = this.stamp;
    const perms = this.perms;
    const sweep = this.sweep;
    const share = MOVE_SHARE * Math.min(1, dt / PHYS_STEP);
    const s = this.storm;
    const lo = SWASH_LO + (STORM_LO - SWASH_LO) * s;
    const hi = SWASH_HI + (STORM_HI - SWASH_HI) * s;
    const tanSwash = TAN_SWASH + (TAN_STORM - TAN_SWASH) * s;
    const swashRate = SWASH_RATE * (1 + STORM_SURF * s);
    const backward = (sweep & 1) === 1;
    const dir = backward ? -1 : 1;
    const end = backward ? -1 : this.sweepEnd;
    // Entries before sweepEnd never move during a sweep, so this array stays valid for them
    // even if the list grows (new entries go after sweepEnd).
    const list = set.list;
    const flag = set.flag;
    const tops = this.tops;
    let cur = this.cursor;
    let moved = 0;
    let done = 0;

    for (; cur !== end; cur += dir) {
      if ((++done & 255) === 0 && performance.now() > deadline) {
        this.cursor = cur;
        return moved * CELL * CELL;
      }
      const c = list[cur];
      if (lava[c] > 0) continue;
      let have = sed[c];
      if (have <= 0) continue;
      let top = rock[c] + have;
      // Look at the neighbours first (most listed columns turn out to be at rest).
      let steep = false;
      for (let d = 0; d < 8; d++) {
        const n = c + NB_OFF[d];
        if (EDGE[n] || lava[n] > 0) {
          tops[d] = Infinity;
          continue;
        }
        const tn = rock[n] + sed[n];
        tops[d] = tn;
        const drop = top - tn;
        if (steep || drop <= SETTLE_EPS) continue;
        const mid = (top + tn) * 0.5;
        if (mid > hi ? drop - NB_DIST[d] * TAN_DRY > SETTLE_EPS : mid >= lo ? drop - NB_DIST[d] * tanSwash > SWASH_EPS : drop - NB_DIST[d] * TAN_WET > SETTLE_EPS) steep = true;
      }
      if (!steep) continue;
      // Too steep somewhere: slide, visiting the neighbours in a shuffled order.
      let changed = false;
      const po = (hashInt(c, sweep) & (PERMS - 1)) * 8;
      for (let t = 0; t < 8 && have > 0; t++) {
        const d = perms[po + t];
        const tn = tops[d];
        const drop = top - tn;
        if (drop <= SETTLE_EPS) continue;
        const mid = (top + tn) * 0.5;
        let tan = TAN_WET;
        let rate = 1;
        let eps = SETTLE_EPS;
        if (mid > hi) tan = TAN_DRY;
        else if (mid >= lo) {
          tan = tanSwash;
          rate = swashRate;
          eps = SWASH_EPS;
        }
        const excess = drop - NB_DIST[d] * tan;
        if (excess <= eps) continue;
        let mv = share * rate * excess;
        if (mv > MAX_MOVE) mv = MAX_MOVE;
        if (mv > have) mv = have;
        mv = Math.floor(mv * SED_Q) / SED_Q;
        if (mv <= 0) continue;
        const n = c + NB_OFF[d];
        if (!changed) {
          cols.touch(c);
          changed = true;
        }
        cols.touch(n);
        // Sand colour mixes by volume where it lands.
        const sn = sed[n];
        const kn = sandKind[n];
        const kc = sandKind[c];
        if (kn !== kc) sandKind[n] = sn > 0 ? Math.round((sn * kn + mv * kc) / (sn + mv)) : kc;
        have -= mv;
        sed[n] = sn + mv;
        tops[d] = tn + mv;
        top -= mv;
        moved += mv;
        stamp[n] = sweep;
        if (flag[n] === 0) set.add(n);
      }
      if (changed) {
        sed[c] = have;
        stamp[c] = sweep;
        changes.markAround(c, SLID);
        // Sandy columns above c may now be too steep.
        for (let d = 0; d < 8; d++) {
          if (tops[d] <= top || tops[d] === Infinity) continue;
          const u = c + NB_OFF[d];
          if (sed[u] > 0) {
            stamp[u] = sweep;
            if (flag[u] === 0) set.add(u);
          }
        }
      }
    }

    // Sweep finished: keep only columns that changed or were woken during it.
    let w = 0;
    const all = set.list;
    for (let j = 0; j < set.count; j++) {
      const c = all[j];
      if (stamp[c] === sweep) all[w++] = c;
      else flag[c] = 0;
    }
    set.count = w;
    this.sweep = sweep + 1;
    this.cursor = -1;
    return moved * CELL * CELL;
  }
}
