/**
 * The coast over the years and in storms (WP-B, ARCHITECTURE §5.2). The ecology calls these:
 * it knows which columns are shoreline, when storms blow and where reefs grow.
 *
 *  - Storm surf (real time): on beaches, mostly windward ones, waves drag sand off the berm
 *    (the dry top of the beach, +0.5 to +2.5 m) and drop it offshore at -2 to -4 m.
 *  - Calm years: gentle waves carry that sand back up and rebuild the berm.
 *  - Windward sea cliffs taller than about 4 m are slowly undercut and fall back, dropping
 *    sand (black from basalt) at their foot. A widening rock platform at their base slows them.
 *  - Reefs make white coral sand that washes onto lee beaches and slowly whitens them, and
 *    their limestone grows up toward (but never above) half a metre under the surface.
 *
 * None of this counts as a tool change (it is nature, not the player). Rock never changes in
 * storms; only sand moves.
 */
import { CELL, NX, NZ, SEA_LEVEL, WIND_TO_X, WIND_TO_Z } from '../../config';
import { ChangeFlag, RockKind, type Columns } from '../columns';
import { EDGE, qSed, type ChangeTracker, type Reporter, type Sand } from './sand';

/** Berm sand (m above sea) that storm waves drag away. */
const BERM_LO = SEA_LEVEL + 0.5;
const BERM_HI = SEA_LEVEL + 2.5;
/** Storm waves drop it on the first column offshore deeper than this (usually -2 to -4 m). */
const BAR_HI = SEA_LEVEL - 2;
/** Berm sand removed per second at full storm on a fully windward beach (m). */
const STORM_RATE = 0.012;
/** Beach faces are woken each time the storm level has grown by this much. */
const STORM_WAKE_STEP = 0.1;
/** Lee beaches still get this share of the storm. */
const LEE_STORM = 0.2;
/** Calm years carry sand from the shallows (-4.5..-1.2 m) up to the berm at this rate (m/yr). */
const REBUILD_RATE = 0.04;
const SHALLOW_LO = SEA_LEVEL - 4.5;
const SHALLOW_HI = SEA_LEVEL - 1.2;
/** The berm is rebuilt up to this height (m). */
const BERM_TOP = SEA_LEVEL + 1.8;
/** Calm-weather beach face the rebuild never steepens beyond (1:8, the swash slope). */
const BEACH_FACE = 1 / 8;
/** A sea cliff is at least this tall (m) and steeper than 45°. */
const CLIFF_MIN = 4;
/**
 * How fast the top of a sea cliff's face column wears down, on a coast facing straight into
 * the wind / only just facing it (m/yr). A 20 m cliff gives up one column (2 m of coast) in a
 * few centuries: something you notice over the journal's years, not while you watch.
 */
const CLIFF_FAST = 0.08;
const CLIFF_SLOW = 0.02;
/** Coasts facing the wind less than this don't wear back. */
const CLIFF_EXPOSURE = 0.3;
/** A rock platform this wide (m) at a cliff's foot cuts its retreat to about a third. */
const PLATFORM_DAMP = 12;
/** Cliffs are cut down to this level, leaving a wave-cut platform (m). */
const PLATFORM_LEVEL = SEA_LEVEL - 0.5;
/** Share of fallen cliff that stays as sand at its foot (the rest washes out to sea). */
const CLIFF_SAND = 0.6;
/** Reef limestone never grows above this (m). */
const REEF_TOP = SEA_LEVEL - 0.5;
/** Sand thinner than this is built into a growing reef; thicker sand stays on top of it. */
const REEF_BURY = 0.3;
/** Coral sand is nearly white. */
const CORAL_KIND = 250;
/** The colour of sand a cliff breaks into, by rock kind (basalt, placed stone, limestone). */
const CLIFF_KIND = [0, 96, 235];

export class Coast {
  /** Scratch: the columns along one shore line (landward first), and their count. */
  private readonly line = new Int32Array(24);
  private lineAt = 0;
  private lineLen = 0;
  /** Storm level at which the beach faces were last woken. */
  private wokenAt = 0;

  constructor(
    private readonly cols: Columns,
    private readonly sand: Sand,
    private readonly changes: ChangeTracker,
    private readonly report: Reporter,
  ) {}

  /**
   * Storm surf for dt real seconds at storm `level` (0..1): pull berm sand off the listed
   * shoreline columns' beaches down to the offshore bar. Windward beaches lose the most.
   */
  stormPulse(level: number, dt: number, shore: Int32Array, n: number): void {
    if (!(dt > 0)) return;
    // As the storm builds, the band the waves work widens and flattens: wake the beach faces
    // (each time the storm has grown a little), so sand that was at rest starts to move.
    const wake = level >= this.wokenAt + STORM_WAKE_STEP;
    if (wake || level < this.wokenAt) this.wokenAt = level;
    if (!(level > 0)) return;
    const { sed } = this.cols;
    for (let j = 0; j < n; j++) {
      const exposure = this.traceLine(shore[j], 4, 14);
      if (exposure < 0) continue;
      if (wake) for (let p = 0; p < this.lineLen; p++) this.sand.wake(this.line[p]);
      const berm = this.find(-1, BERM_LO, BERM_HI, true);
      const bar = this.findBelow(1, BAR_HI);
      if (berm < 0 || bar < 0) continue;
      const amount = STORM_RATE * level * (LEE_STORM + (1 - LEE_STORM) * exposure) * dt;
      const mv = Math.min(sed[berm], qSed(amount));
      if (mv <= 0) continue;
      this.moveSand(berm, bar, mv);
      this.sand.wakeAround(berm);
      this.sand.wakeAround(bar);
    }
    this.changes.flush(this.report);
  }

  /**
   * dtYears of calm coast: berms rebuild from the shallows, windward sea cliffs wear back, and
   * reef sand (white sand per listed column, m/yr; `reefSand[j]` belongs to `shore[j]`) lands
   * on the beaches.
   */
  coastYears(dtYears: number, shore: Int32Array, n: number, reefSand: Float32Array | null): void {
    if (!(dtYears > 0)) return;
    const { rock, sed, lava } = this.cols;
    for (let j = 0; j < n; j++) {
      const c0 = shore[j];
      const exposure = this.traceLine(c0, 4, 14);
      if (exposure < 0) continue;

      // 1. Calm waves carry sand from the shallows back up onto the berm.
      const beachAt = this.findBeachTop();
      const beach = beachAt >= 0 ? this.line[beachAt] : -1;
      const src = this.find(1, SHALLOW_LO, SHALLOW_HI, true);
      if (beach >= 0 && src >= 0) {
        const room = this.bermRoom(beachAt);
        const mv = Math.min(sed[src], qSed(Math.min(room, REBUILD_RATE * dtYears)));
        if (mv > 0) {
          this.moveSand(src, beach, mv);
          this.sand.wakeIfUnstable(src);
          this.sand.wakeIfUnstable(beach);
        }
      }

      // 2. Windward sea cliffs wear back slowly.
      if (exposure >= CLIFF_EXPOSURE) {
        const face = this.findCliff(c0);
        if (face >= 0) {
          const t = (exposure - CLIFF_EXPOSURE) / (1 - CLIFF_EXPOSURE);
          const damp = Math.exp((-this.platformWidth() * CELL) / PLATFORM_DAMP);
          const wear = (CLIFF_SLOW + (CLIFF_FAST - CLIFF_SLOW) * t) * damp * dtYears;
          const fromSand = Math.min(sed[face], qSed(wear));
          const fromRock = fromSand < sed[face] ? 0 : Math.min(wear - fromSand, Math.max(0, rock[face] - PLATFORM_LEVEL));
          if (fromSand + fromRock <= 0) continue;
          this.cols.touch(face);
          sed[face] -= fromSand;
          rock[face] -= fromRock;
          this.changes.mark(face, ChangeFlag.Geom | ChangeFlag.Look);
          const fallen = qSed(CLIFF_SAND * (fromSand + fromRock));
          if (fallen > 0 && lava[c0] <= 0) {
            this.addSand(c0, fallen, CLIFF_KIND[this.cols.rockKind[face]] ?? 0);
            this.sand.wakeIfUnstable(c0);
          }
          this.sand.wakeIfUnstable(face);
        }
      }

      // 3. White coral sand from the reef washes onto the beach.
      if (reefSand) {
        const add = qSed(reefSand[j] * dtYears);
        if (add > 0) {
          const at = beach >= 0 ? beach : c0;
          if (lava[at] <= 0) {
            this.addSand(at, add, CORAL_KIND);
            this.sand.wakeIfUnstable(at);
          }
        }
      }
    }
    this.changes.flush(this.report);
  }

  /** Raise reef limestone on the listed columns by `amounts` (m), never above REEF_TOP. */
  growReef(list: Int32Array, amounts: Float32Array, n: number): void {
    const cols = this.cols;
    const { rock, sed, lava, rockKind } = cols;
    for (let j = 0; j < n; j++) {
      const c = list[j];
      if (c < 0 || c >= cols.n || lava[c] > 0) continue;
      const top = rock[c] + sed[c];
      const a = Math.min(amounts[j], REEF_TOP - top);
      if (!(a > 0)) continue;
      cols.touch(c);
      if (sed[c] <= REEF_BURY) {
        // Thin sand is cemented into the reef.
        rock[c] += sed[c] + a;
        sed[c] = 0;
      } else {
        rock[c] += a;
      }
      rockKind[c] = RockKind.Limestone;
      this.changes.mark(c, ChangeFlag.Geom | ChangeFlag.Look);
    }
    this.changes.flush(this.report);
  }

  // ---------- helpers ----------

  /**
   * Lay out the line of columns through shore column c, across the shore: `back` columns
   * landward, c itself, then `out` columns seaward. Returns how squarely the shore faces the
   * wind (0 lee .. 1 straight into the wind), or -1 if c is not a usable shore column.
   */
  private traceLine(c: number, back: number, out: number): number {
    const cols = this.cols;
    if (c < 0 || c >= cols.n || EDGE[c]) return -1;
    const i = c % NX;
    const k = (c - i) / NX;
    // Seaward = downhill.
    const gx = this.topAt(i + 2, k) - this.topAt(i - 2, k);
    const gz = this.topAt(i, k + 2) - this.topAt(i, k - 2);
    const g = Math.hypot(gx, gz);
    if (g < 1e-3) return -1;
    const sx = -gx / g;
    const sz = -gz / g;
    // Step one whole column along the main axis each time, so no column is listed twice.
    const m = Math.max(Math.abs(sx), Math.abs(sz));
    const ux = sx / m;
    const uz = sz / m;
    let len = 0;
    for (let s = -back; s <= out; s++) {
      const a = Math.round(i + ux * s);
      const b = Math.round(k + uz * s);
      if (a < 1 || b < 1 || a > NX - 2 || b > NZ - 2) {
        if (s < 0) continue;
        break;
      }
      if (s === 0) this.lineAt = len;
      this.line[len++] = a + b * NX;
    }
    this.lineLen = len;
    // The wind blows toward (WIND_TO_X, WIND_TO_Z); a shore faces it when seaward points the other way.
    return Math.max(0, -(sx * WIND_TO_X + sz * WIND_TO_Z));
  }

  /** Solid top at column (i, k), clamped to the zone. */
  private topAt(i: number, k: number): number {
    return this.cols.top(Math.max(0, Math.min(NX - 1, i)) + Math.max(0, Math.min(NZ - 1, k)) * NX);
  }

  /**
   * The first column along the line from the shore column going `dir` (-1 landward, 1 seaward)
   * whose solid top is within [lo, hi] (and which has sand, if `sandy`). -1 if none.
   */
  private find(dir: number, lo: number, hi: number, sandy: boolean): number {
    const { sed, lava } = this.cols;
    for (let p = this.lineAt; p >= 0 && p < this.lineLen; p += dir) {
      const c = this.line[p];
      if (lava[c] > 0) return -1;
      const t = this.cols.top(c);
      if (t >= lo && t <= hi && (!sandy || sed[c] > 0)) return c;
    }
    return -1;
  }

  /** The first column seaward of the shore whose top is below `level` (where surf drops sand). */
  private findBelow(dir: number, level: number): number {
    for (let p = this.lineAt + dir; p >= 0 && p < this.lineLen; p += dir) {
      const c = this.line[p];
      if (this.cols.lava[c] > 0) return -1;
      if (this.cols.top(c) < level) return c;
    }
    return -1;
  }

  /**
   * Line position of the top of the beach (the column calm waves build up): the first column
   * at or above the sea going landward from the shore. -1 if none, or if it is already high.
   */
  private findBeachTop(): number {
    for (let p = this.lineAt; p >= 0; p--) {
      const c = this.line[p];
      if (this.cols.lava[c] > 0) return -1;
      const t = this.cols.top(c);
      if (t >= SEA_LEVEL) return t < BERM_TOP ? p : -1;
    }
    return -1;
  }

  /** How much sand the berm (line position p) can take before passing BERM_TOP or a 1:8 face to the sea. */
  private bermRoom(p: number): number {
    const top = this.cols.top(this.line[p]);
    const seaward = p + 1 < this.lineLen ? this.cols.top(this.line[p + 1]) : -Infinity;
    return Math.max(0, Math.min(BERM_TOP - top, seaward + CELL * BEACH_FACE - top));
  }

  /** The cliff face above shore column c: a column within 3 landward that stands CLIFF_MIN above the sea, steeper than 45°. */
  private findCliff(c0: number): number {
    const base = Math.max(SEA_LEVEL, this.cols.top(c0));
    let prev = this.cols.top(c0);
    for (let p = this.lineAt - 1; p >= 0 && p >= this.lineAt - 3; p--) {
      const c = this.line[p];
      if (this.cols.lava[c] > 0) return -1;
      const t = this.cols.top(c);
      if (t - prev > CELL && t - base >= CLIFF_MIN) return c;
      prev = t;
    }
    return -1;
  }

  /** Width (in columns) of the low rock platform seaward of the shore column. */
  private platformWidth(): number {
    let w = 0;
    for (let p = this.lineAt + 1; p < this.lineLen; p++) {
      if (this.cols.top(this.line[p]) < PLATFORM_LEVEL - 1) break;
      w++;
    }
    return w;
  }

  private moveSand(from: number, to: number, mv: number): void {
    const { sed, sandKind } = this.cols;
    this.cols.touch(from);
    this.cols.touch(to);
    const k = sandKind[from];
    sed[from] -= mv;
    this.addSand(to, mv, k);
    this.changes.mark(from, ChangeFlag.Geom | ChangeFlag.Look);
  }

  /** Add sand of a colour to a column, mixing colours by volume. */
  private addSand(c: number, amount: number, kind: number): void {
    const { sed, sandKind } = this.cols;
    this.cols.touch(c);
    const had = sed[c];
    sandKind[c] = Math.round((had * sandKind[c] + amount * kind) / (had + amount));
    sed[c] = had + amount;
    this.changes.mark(c, ChangeFlag.Geom | ChangeFlag.Look);
  }
}
