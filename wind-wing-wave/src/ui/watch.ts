/**
 * Watch mode: the "sit and watch trees pop up" mode. After a minute without touching, the
 * buttons fade, the screen is kept awake, and (if the setting allows) the camera drifts
 * toward where life is happening and circles it slowly, framed at 60-120 m where pops,
 * birds and crabs are visible.
 *
 * The WatchDirector remembers recent activity (arrivals, places recognised, plants popping,
 * colonies, lava) and picks where to look. It stays on one place for a while so the view is
 * calm, but a fresh, bigger event can pull it away sooner.
 */
import type { DriftFocus } from '../input/camera';

export type ActivityKind = 'arrival' | 'place' | 'growth' | 'colony' | 'lava';

/** How interesting each kind is, and how far away to frame it from (m). */
const WEIGHT: Record<ActivityKind, number> = { arrival: 1, place: 0.9, growth: 0.7, colony: 0.5, lava: 1.2 };
const FRAME: Record<ActivityKind, number> = { arrival: 80, place: 100, growth: 65, colony: 115, lava: 120 };
/** Interest halves every this many seconds. */
const HALF_LIFE = 150;
/** Stay on a place at least this long before wandering on (s). */
const STAY = 50;
const MAX_NOTES = 24;

interface Note {
  kind: ActivityKind;
  x: number;
  z: number;
  t: number;
  w: number;
}

export class WatchDirector {
  private notes: Note[] = [];
  private current: Note | null = null;
  private chosenAt = -1e9;
  private readonly out: DriftFocus = { x: 0, z: 0, dist: 100 };

  /** Something happened at (x, z). `strength` scales its interest (e.g. many plants at once). */
  note(kind: ActivityKind, x: number, z: number, now: number, strength = 1): void {
    const w = WEIGHT[kind] * strength;
    for (const n of this.notes) {
      if (n.kind === kind && Math.hypot(n.x - x, n.z - z) < 25) {
        n.t = now;
        n.w = Math.max(n.w, w);
        n.x = (n.x + x) / 2;
        n.z = (n.z + z) / 2;
        return;
      }
    }
    this.notes.push({ kind, x, z, t: now, w });
    if (this.notes.length > MAX_NOTES) {
      // Forget the least interesting.
      let worst = 0;
      for (let i = 1; i < this.notes.length; i++) if (this.score(this.notes[i], now) < this.score(this.notes[worst], now)) worst = i;
      const [gone] = this.notes.splice(worst, 1);
      if (gone === this.current) this.current = null;
    }
  }

  forget(): void {
    this.notes.length = 0;
    this.current = null;
    this.chosenAt = -1e9;
  }

  private score(n: Note, now: number): number {
    return n.w * Math.pow(0.5, Math.max(0, now - n.t) / HALF_LIFE);
  }

  /** Where to drift now. Falls back to `fallback` (e.g. the biggest island) when nothing is happening. */
  focus(now: number, fallback: DriftFocus | null): DriftFocus | null {
    const cur = this.current;
    const settled = now - this.chosenAt >= STAY;
    let best: Note | null = null;
    let bestScore = 0.05;
    for (const n of this.notes) {
      // Once a place has been watched for a while, it is half as interesting: the view wanders on.
      const s = this.score(n, now) * (n === cur && settled ? 0.5 : 1);
      if (s > bestScore) {
        best = n;
        bestScore = s;
      }
    }
    if (best && best !== cur) {
      const exciting = !cur || (best.t > this.chosenAt && bestScore > 1.6 * this.score(cur, now));
      if (settled || exciting) {
        this.current = best;
        this.chosenAt = now;
      }
    }
    const c = this.current;
    if (c && this.score(c, now) > 0.05) {
      this.out.x = c.x;
      this.out.z = c.z;
      this.out.dist = FRAME[c.kind];
      return this.out;
    }
    this.current = null;
    return fallback;
  }
}

/** Whether keeping the screen on works here: it did, the browser said no, or it can't at all. */
export type WakeProbe = 'granted' | 'refused' | 'unavailable';

/** Keeps the screen on while watching (where the browser allows it). */
export class ScreenAwake {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  constructor() {
    // The browser drops the lock when the page is hidden; take it again on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wanted) this.request();
    });
  }

  static get available(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  /**
   * For the checks page: does keeping the screen on actually work here? The feature can exist
   * and still be refused (battery saver, a page opened from a file, browser policy), so this
   * asks for it once and lets go at once.
   */
  static async probe(): Promise<WakeProbe> {
    if (!ScreenAwake.available) return 'unavailable';
    return Promise.race([
      navigator.wakeLock.request('screen').then(
        (s) => {
          void s.release().catch(() => undefined);
          return 'granted' as const;
        },
        () => 'refused' as const,
      ),
      // No answer at all counts as a no (a late yes still lets go of the lock above).
      new Promise<'refused'>((resolve) => setTimeout(() => resolve('refused'), 3000)),
    ]);
  }

  set(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.request();
    else if (this.sentinel) {
      void this.sentinel.release().catch(() => undefined);
      this.sentinel = null;
    }
  }

  private request(): void {
    if (!ScreenAwake.available || this.sentinel) return;
    navigator.wakeLock.request('screen').then(
      (s) => {
        if (!this.wanted) {
          void s.release().catch(() => undefined);
          return;
        }
        this.sentinel = s;
        s.addEventListener('release', () => {
          if (this.sentinel === s) this.sentinel = null;
        });
      },
      () => undefined, // refused (battery saver, no permission): watching still works
    );
  }
}
