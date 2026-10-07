/**
 * Things pinned to a spot in the world: the soft place labels ("A sea cliff") that appear
 * on the land when the island recognises a place, and the Look bubble.
 *
 * Each frame they are moved to where their world point lands on screen (a CSS transform,
 * no layout work), and hidden while the point is behind the camera or off screen.
 */
import { el, text } from './dom';

/** Screen position of a world point. Writes into `out`; false when not visible. */
export type Projector = (x: number, y: number, z: number, out: { x: number; y: number }) => boolean;

interface Pinned {
  el: HTMLElement;
  x: number;
  y: number;
  z: number;
  /** Seconds left before it fades. */
  life: number;
  fading: boolean;
  /** Last screen position written (style writes are skipped while it stays put). */
  sx: number;
  sy: number;
  /** How far (px) it was last lifted to clear another label. */
  oy: number;
}

/** Rough size of a place label on screen (18 px italic serif), for keeping two apart. */
const LABEL_CHAR_PX = 9;
const LABEL_STACK_PX = 28;

/** A label already placed on screen: where its bottom centre is, and about how wide it is (px). */
export interface TakenLabel {
  x: number;
  y: number;
  w: number;
}

/**
 * How far (px) a label whose bottom centre is at (x, y), and which is `w` wide, must be lifted so
 * it doesn't print over the labels already `taken`. Each lift is one label's height; after a few
 * the label is left where it is (a crowded sky is better than a label thrown off the land).
 */
export function liftToClear(taken: readonly TakenLabel[], x: number, y: number, w: number): number {
  let oy = 0;
  for (let tries = 0; tries < 4; tries++) {
    const clash = taken.some((t) => Math.abs(t.x - x) < (t.w + w) / 2 && Math.abs(t.y - (y - oy)) < LABEL_STACK_PX - 2);
    if (!clash) break;
    oy += LABEL_STACK_PX;
  }
  return oy;
}

/** Keep a label of width `w` (centred on x) wholly inside a screen `screenW` wide, with a small margin. */
export function clampToScreen(x: number, w: number, screenW: number): number {
  const half = w / 2 + 8;
  if (screenW <= half * 2) return screenW / 2;
  return Math.min(Math.max(x, half), screenW - half);
}

/** Rough on-screen width of a place label's words. */
export function labelWidth(words: string): number {
  return words.length * LABEL_CHAR_PX;
}

const LABEL_SECONDS = 5;
const MAX_LABELS = 3;

export class WorldPins {
  private labels: Pinned[] = [];
  private bubble: Pinned | null = null;
  private box: HTMLDivElement;
  private readonly p = { x: 0, y: 0 };

  constructor(
    parent: HTMLElement,
    private project: Projector,
  ) {
    this.box = el('div', 'pins');
    parent.appendChild(this.box);
  }

  /** A soft label on the land for a few seconds. */
  label(words: string, x: number, y: number, z: number): void {
    // Don't stack the same words twice near each other.
    for (const l of this.labels) if (l.el.textContent === words && Math.hypot(l.x - x, l.z - z) < 60) return;
    while (this.labels.length >= MAX_LABELS) this.drop(this.labels.shift()!);
    const e = text('div', 'place-label', words);
    this.box.appendChild(e);
    requestAnimationFrame(() => e.classList.add('in'));
    this.labels.push({ el: e, x, y: y + 4, z, life: LABEL_SECONDS, fading: false, sx: NaN, sy: NaN, oy: 0 });
  }

  /** The Look bubble: a sentence, plus what grows there. One at a time. */
  look(sentence: string, growing: string[], x: number, y: number, z: number): void {
    this.closeLook();
    const e = el('div', 'look-bubble');
    e.appendChild(text('p', 'look-line', sentence));
    if (growing.length) e.appendChild(text('p', 'look-here', `Growing here: ${growing.join(' · ')}`));
    e.addEventListener('click', () => this.closeLook());
    this.box.appendChild(e);
    requestAnimationFrame(() => e.classList.add('in'));
    this.bubble = { el: e, x, y: y + 1, z, life: 10, fading: false, sx: NaN, sy: NaN, oy: 0 };
  }

  closeLook(): void {
    if (this.bubble) this.drop(this.bubble);
    this.bubble = null;
  }

  get lookOpen(): boolean {
    return this.bubble !== null;
  }

  clear(): void {
    for (const l of this.labels) this.drop(l);
    this.labels.length = 0;
    this.closeLook();
  }

  update(dt: number): void {
    // Oldest first: a newer label that would print over an older one is lifted clear of it.
    const taken: TakenLabel[] = [];
    for (let i = 0; i < this.labels.length; i++) {
      const l = this.labels[i];
      l.life -= dt;
      if (l.life <= 0) {
        this.drop(l);
        this.labels.splice(i, 1);
        i--;
      } else this.place(l, taken);
    }
    const b = this.bubble;
    if (b) {
      b.life -= dt;
      if (b.life <= 0) this.closeLook();
      else this.place(b);
    }
  }

  private place(p: Pinned, taken?: TakenLabel[]): void {
    if (this.project(p.x, p.y, p.z, this.p)) {
      let oy = 0;
      if (taken) {
        const w = labelWidth(p.el.textContent ?? '');
        // A label near the edge of the screen slides inward rather than being cut off.
        this.p.x = clampToScreen(this.p.x, w, window.innerWidth);
        oy = liftToClear(taken, this.p.x, this.p.y, w);
        taken.push({ x: this.p.x, y: this.p.y - oy, w });
      }
      // (Written as "not close" so the first placement, from NaN, always happens.)
      if (!(Math.abs(this.p.x - p.sx) <= 0.4 && Math.abs(this.p.y - p.sy) <= 0.4 && oy === p.oy)) {
        p.sx = this.p.x;
        p.sy = this.p.y;
        p.oy = oy;
        // The point is the bottom centre of the label or bubble.
        p.el.style.transform = `translate3d(${p.sx.toFixed(1)}px, ${(p.sy - oy).toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
      p.el.style.visibility = '';
    } else p.el.style.visibility = 'hidden';
  }

  private drop(p: Pinned): void {
    if (p.fading) return;
    p.fading = true;
    p.el.classList.remove('in');
    setTimeout(() => p.el.remove(), 800);
  }
}
