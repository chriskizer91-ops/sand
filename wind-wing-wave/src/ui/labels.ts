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
    this.labels.push({ el: e, x, y: y + 4, z, life: LABEL_SECONDS, fading: false, sx: NaN, sy: NaN });
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
    this.bubble = { el: e, x, y: y + 1, z, life: 10, fading: false, sx: NaN, sy: NaN };
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
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i];
      l.life -= dt;
      if (l.life <= 0) {
        this.drop(l);
        this.labels.splice(i, 1);
      } else this.place(l);
    }
    const b = this.bubble;
    if (b) {
      b.life -= dt;
      if (b.life <= 0) this.closeLook();
      else this.place(b);
    }
  }

  private place(p: Pinned): void {
    if (this.project(p.x, p.y, p.z, this.p)) {
      // (Written as "not close" so the first placement, from NaN, always happens.)
      if (!(Math.abs(this.p.x - p.sx) <= 0.4 && Math.abs(this.p.y - p.sy) <= 0.4)) {
        p.sx = this.p.x;
        p.sy = this.p.y;
        // The point is the bottom centre of the label or bubble.
        p.el.style.transform = `translate3d(${p.sx.toFixed(1)}px, ${p.sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
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
