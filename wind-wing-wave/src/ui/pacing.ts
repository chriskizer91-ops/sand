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
 * When it is already at 1.0 and still slow, it asks for a lighter quality tier instead.
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

  /** Feed the time since the last animation frame. Returns the step to draw with, or -1 to skip this one. */
  tick(rawDt: number): number {
    this.elapsed += rawDt;
    if (this.cap > 0) {
      this.budget += rawDt;
      if (this.budget + 0.002 < this.cap) return -1;
      this.budget = Math.max(0, Math.min(this.budget - this.cap, this.cap));
    } else this.budget = 0;
    this.interval = this.elapsed;
    this.elapsed = 0;
    return Math.min(0.1, this.interval);
  }
}

export type GovernorChange = 'sharper' | 'softer' | 'lighter' | null;

/** Seconds of frames judged together. */
const WINDOW = 2;

export class ResolutionGovernor {
  ratio: number;
  private sum = 0;
  private n = 0;
  private good = 0;
  private sinceSofter = 1e9;
  private sinceSharper = 1e9;
  private sinceLighter = 1e9;
  private backoff = 20;
  private warmup = 3;

  constructor(
    public min: number,
    public cap: number,
  ) {
    this.ratio = cap;
  }

  /** Start judging afresh (after loading, a pause, or a settings change). */
  reset(ratio = this.ratio): void {
    this.ratio = Math.max(this.min, Math.min(this.cap, ratio));
    this.sum = 0;
    this.n = 0;
    this.good = 0;
    this.warmup = 3;
  }

  /**
   * One drawn frame: `interval` is the real time since the previous drawn frame and `target`
   * the interval we aim for (both in seconds). Returns what changed, if anything.
   */
  frame(interval: number, target: number): GovernorChange {
    if (interval <= 0 || interval > 0.25) return null; // a hitch or a tab switch: not a measurement
    this.sinceSofter += interval;
    this.sinceSharper += interval;
    this.sinceLighter += interval;
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
      if (this.sinceLighter > 15) {
        this.sinceLighter = 0;
        return 'lighter';
      }
      return null;
    }
    if (avg < target * 1.08) {
      this.good++;
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
