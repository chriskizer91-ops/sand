/**
 * The coast over the years and in storms (WP-B, ARCHITECTURE §5.2). The ecology calls these:
 * it knows which columns are shoreline, when storms blow and where reefs grow.
 *
 *  - Storm surf (real time): on beaches, mostly windward ones, waves drag sand off the berm
 *    (the dry top of the beach, +0.5 to +2.5 m) and drop it offshore at -2 to -4 m.
 *  - Calm years: gentle waves carry that sand back up and rebuild the berm.
 *  - Windward sea cliffs taller than about 4 m are slowly undercut and fall back, column by
 *    column, leaving a flat rock platform just under the sea. The wider that platform grows,
 *    the more it breaks the waves before they reach the cliff, so the retreat slows down over
 *    time. What falls becomes sand (black from basalt) that the waves sweep off the platform:
 *    it settles at the cliff's foot, or at the platform's edge once there is one.
 *  - Reefs make white coral sand that washes onto lee beaches and slowly whitens them, and
 *    their limestone grows up toward (but never above) half a metre under the surface.
 *
 * None of this counts as a tool change (it is nature, not the player). Rock never changes in
 * storms; only sand moves.
 */
import { CELL, NX, NZ, SEA_LEVEL, WIND_TO_X, WIND_TO_Z } from '../../config';
import { ChangeFlag, RockKind, type Columns } from '../columns';
import { EDGE, mixKind, qSed, type ChangeTracker, type Reporter, type Sand } from './sand';

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
/** Waves work the beach up to this far landward of the shore column (m). */
const BEACH_REACH = 8;
/**
 * The line through a shore column reaches this many columns landward and seaward. Storms only
 * need the beach (STORM_BACK columns covers BEACH_REACH even on a diagonal coast, where the
 * line's steps are shorter); calm years also look behind it for cliffs.
 */
const STORM_BACK = 6;
const LINE_BACK = 10;
const LINE_OUT = 14;
/** A sea cliff rises at least this far above the sea (m)... */
const CLIFF_MIN = 4;
/** ...within this many columns behind its face, steeper than 45° on average from its foot. */
const CLIFF_SEARCH = 6;
/** The cliff face is looked for this many columns landward of the shore column. */
const FACE_SEARCH = 3;
/**
 * How fast the face column of a sea cliff is worn down, on a coast facing straight into the
 * wind / only just facing it (m/yr). A face column is worn all the way down to the platform
 * before the next one starts, so a 20 m cliff gives up one column (2 m of coast) in about
 * 250 years at first: at normal pace, a windward cliff backs off about 20 m in an hour of play
 * and 35 m in four, slowing as its platform widens. Something the journal's years show, not
 * something you watch happen.
 */
const CLIFF_FAST = 0.08;
const CLIFF_SLOW = 0.02;
/** Coasts facing the wind less than this don't wear back. */
const CLIFF_EXPOSURE = 0.3;
/** A rock platform this wide (m) in front of a cliff cuts its retreat to about a third. */
const PLATFORM_DAMP = 12;
/** Cliffs are cut down to this level, leaving a wave-cut platform (m). */
const PLATFORM_LEVEL = SEA_LEVEL - 0.5;
/** Rock within this of the platform level counts as platform (m). */
const PLATFORM_EPS = 0.01;
/** Share of fallen cliff that stays as sand near its foot (the rest washes out to sea). */
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
  private readonly line = new Int32Array(LINE_BACK + 1 + LINE_OUT);
  /**
   * gap[p]: how far apart line[p] and line[p + 1] are, measured across the shore (m). The line
   * steps to a side neighbour each time, so on a diagonal coast the gaps are shorter than CELL.
   */
  private readonly gap = new Float64Array(LINE_BACK + 1 + LINE_OUT);
  /** Position of the shore column in `line`. */
  private lineAt = 0;
  private lineLen = 0;
  /** Scratch for tracing the landward and seaward halves of a line. */
  private readonly halfCells = new Int32Array(Math.max(LINE_BACK, LINE_OUT));
  private readonly halfGaps = new Float64Array(Math.max(LINE_BACK, LINE_OUT));
  /** Storm level at which the beach faces were last woken. */
  private wokenAt = 0;
  /** Counts sand landings, to vary their colour rounding (see mixKind). */
  private landings = 0;

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
      const exposure = this.traceLine(shore[j], STORM_BACK, LINE_OUT);
      if (exposure < 0) continue;
      if (wake) for (let p = 0; p < this.lineLen; p++) this.sand.wake(this.line[p]);
      const berm = this.find(-1, BERM_LO, BERM_HI, true, BEACH_REACH);
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
    const { sed, lava } = this.cols;
    for (let j = 0; j < n; j++) {
      const c0 = shore[j];
      const exposure = this.traceLine(c0, LINE_BACK, LINE_OUT);
      if (exposure < 0) continue;

      // A windward sea cliff behind this shore? Its face is not a beach, even when it has been
      // cut down low: the waves there wear rock away rather than build a berm.
      const cliffAt = exposure >= CLIFF_EXPOSURE ? this.findCliff() : -1;

      // 1. Calm waves carry sand from the shallows back up onto the berm.
      let beachAt = this.findBeachTop();
      if (beachAt === cliffAt) beachAt = -1;
      const beach = beachAt >= 0 ? this.line[beachAt] : -1;
      const src = beach >= 0 ? this.find(1, SHALLOW_LO, SHALLOW_HI, true, Infinity) : -1;
      if (src >= 0) {
        const room = this.bermRoom(beachAt);
        const mv = Math.min(sed[src], qSed(Math.min(room, REBUILD_RATE * dtYears)));
        if (mv > 0) {
          this.moveSand(src, beach, mv);
          this.sand.wakeIfUnstable(src);
          this.sand.wakeIfUnstable(beach);
        }
      }

      // 2. Windward sea cliffs wear back slowly.
      if (cliffAt >= 0) this.wearCliff(cliffAt, exposure, dtYears);

      // 3. White coral sand from the reef washes onto the beach (or, with no beach, settles at
      //    the water's edge: never on top of a cliff the shore column happens to be).
      if (reefSand) {
        const add = qSed(reefSand[j] * dtYears);
        if (add > 0) {
          const at = beach >= 0 ? beach : this.findBelow(0, SEA_LEVEL);
          if (at >= 0 && lava[at] <= 0) {
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
      // The sand riding on the reef (and its neighbours' sand) may now be too steep.
      this.sand.wakeIfUnstable(c);
    }
    this.changes.flush(this.report);
  }

  // ---------- helpers ----------

  /**
   * Lay out the line of columns through shore column c, across the shore: up to `back` columns
   * landward, c itself, then up to `out` columns seaward. Returns how squarely the shore faces
   * the wind (0 lee .. 1 straight into the wind), or -1 if c is not a usable shore column.
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
    const line = this.line;
    const gap = this.gap;
    const cells = this.halfCells;
    const gaps = this.halfGaps;
    // Landward half (traced outward from the shore, stored nearest-last), the shore, then seaward.
    let len = 0;
    for (let b = this.walk(i, k, -sx, -sz, back) - 1; b >= 0; b--) {
      line[len] = cells[b];
      gap[len++] = gaps[b];
    }
    this.lineAt = len;
    line[len] = c;
    const n = this.walk(i, k, sx, sz, out);
    for (let s = 0; s < n; s++) {
      gap[len++] = gaps[s];
      line[len] = cells[s];
    }
    this.lineLen = len + 1;
    // The wind blows toward (WIND_TO_X, WIND_TO_Z); a shore faces it when seaward points the other way.
    return Math.max(0, -(sx * WIND_TO_X + sz * WIND_TO_Z));
  }

  /**
   * Walk from column (i, k) in direction (dx, dz) (a unit vector), one side neighbour at a
   * time, for up to `max` columns (stopping before the zone's outer ring). Fills halfCells with
   * the columns and halfGaps with how far each one is from the one before, across the shore.
   * Stepping only to side neighbours means a diagonal coast's corner columns are never skipped.
   */
  private walk(i: number, k: number, dx: number, dz: number, max: number): number {
    const ax = Math.abs(dx);
    const az = Math.abs(dz);
    const di = dx > 0 ? 1 : -1;
    const dk = dz > 0 ? 1 : -1;
    // Distance along the direction to the next column edge in x and in z (in columns).
    let tx = ax > 0 ? 0.5 / ax : Infinity;
    let tz = az > 0 ? 0.5 / az : Infinity;
    let n = 0;
    while (n < max) {
      let step: number;
      if (tx <= tz) {
        i += di;
        tx += 1 / ax;
        step = ax * CELL;
      } else {
        k += dk;
        tz += 1 / az;
        step = az * CELL;
      }
      if (i < 1 || k < 1 || i > NX - 2 || k > NZ - 2) break;
      this.halfCells[n] = i + k * NX;
      this.halfGaps[n++] = step;
    }
    return n;
  }

  /** Solid top at column (i, k), clamped to the zone. */
  private topAt(i: number, k: number): number {
    return this.cols.top(Math.max(0, Math.min(NX - 1, i)) + Math.max(0, Math.min(NZ - 1, k)) * NX);
  }

  /**
   * The first column along the line from the shore column going `dir` (-1 landward, 1 seaward),
   * within `reach` metres of it, whose solid top is within [lo, hi] (and which has sand, if
   * `sandy`). -1 if none.
   */
  private find(dir: number, lo: number, hi: number, sandy: boolean, reach: number): number {
    const { sed, lava } = this.cols;
    let dist = 0;
    for (let p = this.lineAt; p >= 0 && p < this.lineLen && dist <= reach; p += dir) {
      const c = this.line[p];
      if (lava[c] > 0) return -1;
      const t = this.cols.top(c);
      if (t >= lo && t <= hi && (!sandy || sed[c] > 0)) return c;
      // How far the next column along is.
      if (dir < 0 ? p > 0 : p + 1 < this.lineLen) dist += this.gap[dir < 0 ? p - 1 : p];
    }
    return -1;
  }

  /**
   * The first column seaward of the shore column (`from` 1), or from the shore column itself
   * (`from` 0), whose top is below `level`. -1 if none, or if lava is in the way.
   */
  private findBelow(from: number, level: number): number {
    for (let p = this.lineAt + from; p < this.lineLen; p++) {
      const c = this.line[p];
      if (this.cols.lava[c] > 0) return -1;
      if (this.cols.top(c) < level) return c;
    }
    return -1;
  }

  /**
   * Line position of the top of the beach (the column calm waves build up): the first column
   * at or above the sea going landward from the shore (within BEACH_REACH). -1 if none, or if
   * it is already high.
   */
  private findBeachTop(): number {
    let dist = 0;
    for (let p = this.lineAt; p >= 0 && dist <= BEACH_REACH; p--) {
      const c = this.line[p];
      if (this.cols.lava[c] > 0) return -1;
      const t = this.cols.top(c);
      if (t >= SEA_LEVEL) return t < BERM_TOP ? p : -1;
      if (p > 0) dist += this.gap[p - 1];
    }
    return -1;
  }

  /** How much sand the berm (line position p) can take before passing BERM_TOP or a 1:8 face to the sea. */
  private bermRoom(p: number): number {
    const top = this.cols.top(this.line[p]);
    const seaward = p + 1 < this.lineLen ? this.cols.top(this.line[p + 1]) : -Infinity;
    return Math.max(0, Math.min(BERM_TOP - top, seaward + this.gap[p] * BEACH_FACE - top));
  }

  /**
   * Wear back the sea cliff whose face is at line position pf for dtYears: loose sand on the
   * face column goes first, then the rock, down to the platform level. 60% of what falls stays
   * as sand where the water deepens past the platform (right at the cliff's foot while there
   * is no platform yet; lost out to sea if the platform runs past the end of the line). Left
   * on the platform, it would pile into a beach that hides the cliff from the waves for good.
   */
  private wearCliff(pf: number, exposure: number, dtYears: number): void {
    const cols = this.cols;
    const { rock, sed, lava, sandKind, rockKind } = cols;
    const face = this.line[pf];
    const t = (exposure - CLIFF_EXPOSURE) / (1 - CLIFF_EXPOSURE);
    // The platform in front: how many columns, and how wide across the shore (m).
    let width = 0;
    let metres = 0;
    for (let p = pf + 1; p < this.lineLen && this.cols.top(this.line[p]) >= PLATFORM_LEVEL - 1; p++) {
      width++;
      metres += this.gap[p - 1];
    }
    const damp = Math.exp(-metres / PLATFORM_DAMP);
    const wear = (CLIFF_SLOW + (CLIFF_FAST - CLIFF_SLOW) * t) * damp * dtYears;
    const fromSand = Math.min(sed[face], qSed(wear));
    let fromRock = 0;
    if (fromSand >= sed[face]) {
      const above = rock[face] - PLATFORM_LEVEL;
      fromRock = Math.max(0, Math.min(wear - fromSand, above));
      // The last sliver goes at once, so a worn face ends exactly on the platform.
      if (above - fromRock < PLATFORM_EPS) fromRock = Math.max(0, above);
    }
    if (fromSand + fromRock <= 0) return;
    // What falls is the face's sand and broken rock (black from basalt), mixed by amount.
    const kind = (fromSand * sandKind[face] + fromRock * (CLIFF_KIND[rockKind[face]] ?? 0)) / (fromSand + fromRock);
    cols.touch(face);
    sed[face] -= fromSand;
    rock[face] -= fromRock;
    this.changes.mark(face, ChangeFlag.Geom | ChangeFlag.Look);
    const fallen = qSed(CLIFF_SAND * (fromSand + fromRock));
    const p = pf + 1 + width;
    if (fallen > 0 && p < this.lineLen && lava[this.line[p]] <= 0) {
      this.addSand(this.line[p], fallen, kind);
      this.sand.wakeIfUnstable(this.line[p]);
    }
    this.sand.wakeIfUnstable(face);
  }

  /**
   * Line position of the face of a sea cliff at the shore column, or -1 if there is none.
   * The face is the first column (from just seaward of the shore, going landward) whose rock
   * still stands above the platform level; it is a cliff if, within CLIFF_SEARCH columns behind
   * it, the land rises CLIFF_MIN above the sea and is steeper than 45° on average from the
   * face's foot. Sand lying on the platform in front is not a face (the waves just wash it
   * about). Starting one column out means a face cut down to just under the sea is finished
   * off even when the shore column given is the land behind it.
   */
  private findCliff(): number {
    const { rock, lava } = this.cols;
    let pf = -1;
    for (let p = Math.min(this.lineAt + 1, this.lineLen - 1); p >= 0 && p >= this.lineAt - FACE_SEARCH; p--) {
      const c = this.line[p];
      if (lava[c] > 0) return -1;
      if (rock[c] > PLATFORM_LEVEL + PLATFORM_EPS) {
        pf = p;
        break;
      }
    }
    if (pf < 0 || pf + 1 >= this.lineLen) return -1;
    const base = this.cols.top(this.line[pf + 1]);
    // Distance across the shore from the foot to the column being looked at.
    let run = 0;
    for (let q = 0; q <= CLIFF_SEARCH && pf - q >= 0; q++) {
      const c = this.line[pf - q];
      if (lava[c] > 0) return -1;
      run += this.gap[pf - q];
      const t = this.cols.top(c);
      if (t - SEA_LEVEL >= CLIFF_MIN && t - base >= run) return pf;
    }
    return -1;
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

  /** Add sand of a colour to a column, mixing it into the top of the sand already there. */
  private addSand(c: number, amount: number, kind: number): void {
    const { sed, sandKind } = this.cols;
    this.cols.touch(c);
    const had = sed[c];
    sandKind[c] = mixKind(sandKind[c], had, amount, kind, c, ++this.landings);
    sed[c] = had + amount;
    this.changes.mark(c, ChangeFlag.Geom | ChangeFlag.Look);
  }
}
