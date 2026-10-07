/**
 * Frame pacing and dynamic resolution (docs/ARCHITECTURE.md §7, DECISIONS 12).
 *
 * FramePacer holds a frame-rate cap: 45 fps on phones (every second frame of the Pixel's
 * 90 Hz screen), 30 fps in watch mode, uncapped on laptops. It keeps a running budget so a
 * 60 Hz screen still averages the cap instead of halving it.
 *
 * ResolutionGovernor watches how long frames really take and trades sharpness for
 * smoothness: it lowers the pixel ratio (down to 1.0) when frames run long, raises it again
 * after a good stretch, and backs off when raising keeps failing, so it never pumps.
 * On "auto" graphics, when it is already at 1.0 and frames stay slow for a while, it lowers
 * the detail tier too, and brings it back after a long good stretch (with the same kind of
 * back-off), so one heavy moment never leaves the game looking poorer for the whole session.
 * It never switches the renderer's shadow map off (that would recompile every material);
 * at the lightest tier main.ts only stops things casting shadows.
 */

export class FramePacer {
  /** Seconds per frame (0 = draw every animation frame). */
  cap = 0;
  /** Real time between the last two drawn frames (s), before any clamping. */
  interval = 0;
  private budget = 0;
  private elapsed = 0;

  /**
   * Feed the time since the last animation frame. Returns the step to draw with, or -1 to
   * skip this one. `force` draws now whatever the cap says (a new window size or setting).
   */
  tick(rawDt: number, force = false): number {
    this.elapsed += rawDt;
    if (this.cap > 0) {
      this.budget += rawDt;
      if (!force && this.budget + 0.002 < this.cap) return -1;
      this.budget = Math.max(0, Math.min(this.budget - this.cap, this.cap));
    } else this.budget = 0;
    this.interval = this.elapsed;
    this.elapsed = 0;
    return Math.min(0.1, this.interval);
  }
}

export type GovernorChange = 'sharper' | 'softer' | 'lighter' | 'richer' | null;

/** Seconds of frames judged together. */
const WINDOW = 2;
/** Slow windows in a row, already at the lowest sharpness, before the detail steps down... */
const LIGHTER_AFTER = 3;
/** ...and a longer run of them before it steps down to the lightest detail (no shadows). */
const LIGHTEST_AFTER = 10;
/** Good windows in a row before stepped-down detail is tried again (after the back-off too). */
const RICHER_AFTER = 5;
/** At least this long between two detail steps (s). */
const TIER_GAP = 15;

export class ResolutionGovernor {
  ratio: number;
  private sum = 0;
  private n = 0;
  private good = 0;
  private sinceSofter = 1e9;
  private sinceSharper = 1e9;
  private backoff = 20;
  private warmup = 3;
  /** The detail tier the graphics setting asks for, and how far below it the governor may go. */
  private base: 0 | 1 | 2 = 2;
  private maxDrop = 0;
  /** How far below the chosen tier it has stepped to keep things smooth. */
  private drop = 0;
  private slowAtFloor = 0;
  private sinceTier = 1e9;
  private sinceRicher = 1e9;
  private tierBackoff = 45;

  constructor(
    public min: number,
    public cap: number,
  ) {
    this.ratio = cap;
  }

  /** The detail tier to draw at now. */
  get tier(): 0 | 1 | 2 {
    return (this.base - this.drop) as 0 | 1 | 2;
  }

  /** The tier the graphics setting asks for (the governor may be below it for now). */
  get chosenTier(): 0 | 1 | 2 {
    return this.base;
  }

  /**
   * A graphics setting: its detail tier, and whether the governor may step below it while
   * frames run long ("auto"). "Lighter" and "richer" are the player's choice and stay put.
   */
  setTier(base: 0 | 1 | 2, adaptive: boolean): void {
    this.base = base;
    this.maxDrop = adaptive ? base : 0;
    this.drop = 0;
    this.slowAtFloor = 0;
    this.sinceTier = 1e9;
    this.sinceRicher = 1e9;
    this.tierBackoff = 45;
  }

  /** Start judging afresh (after loading, a pause, or a settings change). Stepped-down detail stays stepped down. */
  reset(ratio = this.ratio): void {
    this.ratio = Math.max(this.min, Math.min(this.cap, ratio));
    this.sum = 0;
    this.n = 0;
    this.good = 0;
    this.slowAtFloor = 0;
    this.warmup = 3;
  }

  /**
   * One drawn frame: `interval` is the real time since the previous drawn frame and `target`
   * the interval we aim for (both in seconds). Returns what changed, if anything:
   * 'softer' and 'sharper' change `ratio`, 'lighter' and 'richer' change `tier`.
   */
  frame(interval: number, target: number): GovernorChange {
    if (interval <= 0 || interval > 0.25) return null; // a hitch or a tab switch: not a measurement
    this.sinceSofter += interval;
    this.sinceSharper += interval;
    this.sinceTier += interval;
    this.sinceRicher += interval;
    if (this.warmup > 0) {
      this.warmup -= interval;
      return null;
    }
    this.sum += interval;
    this.n++;
    if (this.sum < WINDOW) return null;
    const avg = this.sum / this.n;
    this.sum = 0;
    this.n = 0;
    if (avg > target * 1.25) {
      this.good = 0;
      if (this.ratio > this.min + 0.01) {
        // A raise that failed soon after: wait longer before trying again.
        if (this.sinceSharper < 12) this.backoff = Math.min(240, this.backoff * 2);
        this.ratio = Math.max(this.min, this.ratio - (avg > target * 1.6 ? 0.35 : 0.2));
        this.sinceSofter = 0;
        return 'softer';
      }
      // Already at the lowest sharpness: only a sustained strain lowers the detail, and the
      // lightest tier (no shadows) needs a longer one. A short heavy moment never does.
      this.slowAtFloor++;
      const need = this.tier === 1 ? LIGHTEST_AFTER : LIGHTER_AFTER;
      if (this.drop < this.maxDrop && this.slowAtFloor >= need && this.sinceTier >= TIER_GAP) {
        // A richer try that failed soon after: wait longer before the next one.
        if (this.sinceRicher < 2 * TIER_GAP) this.tierBackoff = Math.min(600, this.tierBackoff * 2);
        this.drop++;
        this.slowAtFloor = 0;
        this.sinceTier = 0;
        return 'lighter';
      }
      return null;
    }
    this.slowAtFloor = 0;
    if (avg < target * 1.08) {
      this.good++;
      // Detail comes back first, then sharpness: the reverse of the order they went.
      if (this.drop > 0) {
        if (this.good >= RICHER_AFTER && this.sinceTier >= this.tierBackoff) {
          this.drop--;
          this.good = 0;
          this.sinceTier = 0;
          this.sinceRicher = 0;
          return 'richer';
        }
        return null;
      }
      if (this.good >= 3 && this.ratio < this.cap - 0.01 && this.sinceSofter >= this.backoff) {
        this.ratio = Math.min(this.cap, this.ratio + 0.1);
        this.good = 0;
        this.sinceSharper = 0;
        return 'sharper';
      }
    } else this.good = 0;
    return null;
  }
}
