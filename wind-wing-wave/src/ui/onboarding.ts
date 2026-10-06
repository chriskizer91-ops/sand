/**
 * The first minute, taught one short line at a time (docs/design-notes/player-experience.md §9):
 *
 *   "Touch the glow."              while the sea has no land (a soft pulsing marker shows where)
 *   "Your island."                 the moment land first breaks the surface
 *   "Keep building, or just watch." once the full tray has arrived (the first land has cooled)
 *   one line the first time each tool is chosen, one line for the journal's first story,
 *   and a tiny drawn hand showing two-finger moves if the camera hasn't moved after ~30 s.
 *
 * Each line is shown once. Lines about this sea are remembered in the save; lines about the
 * game itself (tools, journal, gestures) are remembered in the player's settings.
 * There are no timers that unlock anything: the whole tray arrives as soon as land cools.
 */
import { el, text } from './dom';
import type { Projector } from './labels';
import { TOOL_LINES } from './text';
import type { ToolId } from '../config';

export const GLOW_LINE = 'Touch the glow.';
export const ISLAND_LINE = 'Your island.';
export const KEEP_LINE = 'Keep building, or just watch.';
export const JOURNAL_LINE = 'Every visitor is written in your journal.';
/** Seconds of play on an island before the two-finger hint appears. */
export const HANDS_AFTER = 30;

/** First-minute steps already done in this sea (saved with the sea). */
export interface SeaSteps {
  island: boolean;
  keep: boolean;
}

export interface OnboardingState {
  started: boolean;
  firstLand: boolean;
  trayFull: boolean;
  /** The player has moved the camera themselves. */
  cameraMoved: boolean;
}

export interface OnboardingView {
  /** The line to show (null: none). `key` changes whenever a new line starts. */
  line: string | null;
  key: number;
  glow: boolean;
  hands: boolean;
}

/** Timing and order, free of the page so it can be tested. */
export class Onboarding {
  sea: SeaSteps = { island: false, keep: false };
  private queue: string[] = [];
  private current: string | null = null;
  private left = 0;
  private gapLeft = 0;
  private key = 0;
  private handsTime = 0;
  private handsOn = false;

  constructor(
    private seen: Set<string>,
    /** Called when a game-wide hint has been used up (so settings can remember it). */
    private onSeen: (key: string) => void,
  ) {}

  /** A new or loaded sea: its own first-minute steps; anything queued belongs to the old sea. */
  setSea(steps: SeaSteps): void {
    this.sea = { ...steps };
    this.queue.length = 0;
    this.current = null;
    this.left = 0;
  }

  /** "Show the first-minute hints again": the game-wide hints may show once more. */
  forgetSeen(): void {
    this.seen.clear();
    this.handsTime = 0;
  }

  toolChosen(t: ToolId): void {
    this.once(`tool-${t}`, TOOL_LINES[t]);
  }

  /** The journal got a story worth a card. */
  journalStory(firstLand: boolean): void {
    if (firstLand) this.once('journal', JOURNAL_LINE);
  }

  private once(key: string, line: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.onSeen(key);
    this.queue.push(line);
  }

  update(dt: number, s: OnboardingState, out: OnboardingView): OnboardingView {
    if (s.firstLand && !this.sea.island) {
      this.sea.island = true;
      if (s.started) this.queue.unshift(ISLAND_LINE);
    }
    if (s.trayFull && this.sea.island && !this.sea.keep) {
      this.sea.keep = true;
      if (s.started) this.queue.push(KEEP_LINE);
    }

    const glow = s.started && !s.firstLand;
    if (glow) {
      // The glow line stays until land appears; other lines wait behind it.
      if (this.current !== GLOW_LINE) {
        this.current = GLOW_LINE;
        this.key++;
      }
      this.left = 0.5;
    } else if (s.started) {
      if (this.current === GLOW_LINE) {
        // Land appeared: the glow line goes at once and "Your island." follows.
        this.current = null;
        this.gapLeft = 0.3;
      } else if (this.current) {
        this.left -= dt;
        if (this.left <= 0) {
          this.current = null;
          this.gapLeft = 0.7;
        }
      } else if (this.gapLeft > 0) this.gapLeft -= dt;
      else if (this.queue.length) {
        this.current = this.queue.shift()!;
        this.left = Math.min(6.5, 2.8 + this.current.split(' ').length * 0.28);
        this.key++;
      }
    }

    // The two-finger hint: only on an island, only if the player hasn't found the moves yet.
    if (s.cameraMoved && !this.seen.has('hands')) {
      this.seen.add('hands');
      this.onSeen('hands');
    }
    if (this.seen.has('hands')) this.handsOn = false;
    else if (s.started && s.firstLand && s.trayFull) {
      this.handsTime += dt;
      if (this.handsTime >= HANDS_AFTER) this.handsOn = true;
    }

    out.line = this.current;
    out.key = this.key;
    out.glow = glow;
    out.hands = this.handsOn;
    return out;
  }
}

/** The coach line, the glow marker and the hand hint on screen. */
export class Coach {
  private lineEl: HTMLDivElement;
  private glowEl: HTMLDivElement;
  private handsEl: HTMLDivElement;
  private shownKey = -1;
  /** Last states written to the page (it is only touched when something changes). */
  private glowOn = false;
  private handsOn = false;
  private glowLine = false;
  private glowX = 0;
  private glowZ = 0;
  private readonly p = { x: 0, y: 0 };

  constructor(
    parent: HTMLElement,
    private project: Projector,
    touch: boolean,
  ) {
    this.lineEl = el('div', 'coach');
    this.lineEl.setAttribute('aria-live', 'polite');
    this.glowEl = el('div', 'glow-marker', '<i></i><i></i><i></i>');
    this.handsEl = el('div', `hands-hint ${touch ? 'touch' : 'pad'}`);
    // Two fingers sliding together (pan), then spreading apart (pinch), sketched in code.
    this.handsEl.innerHTML = `<svg viewBox="0 0 120 70" aria-hidden="true">
      <rect x="6" y="6" width="108" height="46" rx="12" class="pad"/>
      <g class="tip a"><rect x="40" y="22" width="15" height="52" rx="7.5"/><path d="M44 29h7" class="nail"/></g>
      <g class="tip b"><rect x="65" y="22" width="15" height="52" rx="7.5"/><path d="M69 29h7" class="nail"/></g></svg>`;
    this.handsEl.appendChild(
      text('span', '', touch ? 'Two fingers: drag to move, pinch to zoom, twist to turn' : 'Two-finger swipe to move · pinch to zoom · right-drag to turn'),
    );
    parent.append(this.glowEl, this.lineEl, this.handsEl);
  }

  setGlow(x: number, z: number): void {
    this.glowX = x;
    this.glowZ = z;
  }

  update(v: OnboardingView): void {
    if (v.key !== this.shownKey) {
      this.shownKey = v.key;
      this.lineEl.classList.remove('in');
      if (v.line) {
        this.lineEl.textContent = v.line;
        void this.lineEl.offsetWidth; // restart the fade-in
        this.lineEl.classList.add('in');
      }
    } else if (!v.line && this.lineEl.classList.contains('in')) this.lineEl.classList.remove('in');
    const glowLine = v.line !== null && v.glow;
    if (glowLine !== this.glowLine) {
      this.glowLine = glowLine;
      this.lineEl.classList.toggle('glow-line', glowLine);
    }

    let glowVisible = false;
    if (v.glow && this.project(this.glowX, 0, this.glowZ, this.p)) {
      glowVisible = true;
      this.glowEl.style.transform = `translate3d(${this.p.x.toFixed(1)}px, ${this.p.y.toFixed(1)}px, 0)`;
    }
    if (glowVisible !== this.glowOn) {
      this.glowOn = glowVisible;
      this.glowEl.classList.toggle('on', glowVisible);
    }
    if (v.hands !== this.handsOn) {
      this.handsOn = v.hands;
      this.handsEl.classList.toggle('on', v.hands);
    }
  }
}
