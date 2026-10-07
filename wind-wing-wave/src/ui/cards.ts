/**
 * Arrival cards: small journal slips at the top of the screen (away from thumbs) for the
 * journal's headline entries. Each has a little ink year stamp, the story line and a
 * code-drawn road icon (wind, wave or wing). Tap one to glide the camera there; swipe it
 * sideways to put it away. They fade after about 8 seconds.
 *
 * Calm pacing: one card at a time, with a short queue. If news bunches up (a storm's
 * aftermath), the extras fold into "+2 more in your journal" on the last card shown.
 * The ecology already spaces its headline stories; this queue only stops them stacking.
 */
import { el, text } from './dom';
import { formatYear } from './text';

export interface CardItem {
  id: number;
  year: number;
  text: string;
  /** Trusted SVG from icons.ts. */
  icon: string;
  x?: number;
  z?: number;
  /** A first or an Age: drawn a little grander. */
  grand: boolean;
}

export interface CardEvent {
  show?: CardItem;
  /** How many more stories were folded into this card. */
  more: number;
  hide: boolean;
}

/** Card timing, kept free of the page so it can be tested. Times in seconds. */
export class CardQueue {
  private waiting: CardItem[] = [];
  private current: CardItem | null = null;
  private left = 0;
  private gapLeft = 0;
  private folded = 0;

  constructor(
    readonly showFor = 8,
    /** Shown for less when others are waiting. */
    readonly showForBusy = 5.5,
    /** Pause between one card fading and the next appearing. */
    readonly gap = 0.9,
    readonly maxWaiting = 3,
  ) {}

  get showing(): CardItem | null {
    return this.current;
  }
  get queued(): number {
    return this.waiting.length;
  }

  push(item: CardItem): void {
    this.waiting.push(item);
    while (this.waiting.length > this.maxWaiting) {
      this.waiting.shift();
      this.folded++;
    }
  }

  /** Put the current card away now (tapped or swiped). */
  dismiss(): boolean {
    if (!this.current) return false;
    this.current = null;
    this.gapLeft = this.gap;
    return true;
  }

  /** Forget everything (a new sea). */
  clear(): void {
    this.waiting.length = 0;
    this.current = null;
    this.folded = 0;
    this.gapLeft = 0;
  }

  /** Advance the clock. `hold` freezes it (journal or menu open). */
  update(dt: number, hold: boolean, out: CardEvent): CardEvent {
    out.show = undefined;
    out.more = 0;
    out.hide = false;
    if (hold) return out;
    if (this.current) {
      this.left -= dt;
      if (this.waiting.length && this.left > this.showForBusy) this.left = this.showForBusy;
      if (this.left <= 0) {
        this.current = null;
        this.gapLeft = this.gap;
        out.hide = true;
      }
      return out;
    }
    if (this.gapLeft > 0) {
      this.gapLeft -= dt;
      return out;
    }
    const next = this.waiting.shift();
    if (!next) return out;
    this.current = next;
    this.left = this.waiting.length ? this.showForBusy : this.showFor;
    out.show = next;
    if (!this.waiting.length) {
      out.more = this.folded;
      this.folded = 0;
    }
    return out;
  }
}

export interface CardActions {
  glideTo(x: number, z: number): void;
  openJournal(): void;
  click(): void;
}

/** The cards on screen. */
export class Cards {
  readonly queue = new CardQueue();
  private box: HTMLDivElement;
  private shown: HTMLElement | null = null;
  private ev: CardEvent = { more: 0, hide: false };

  constructor(
    parent: HTMLElement,
    private actions: CardActions,
  ) {
    this.box = el('div', 'cards');
    this.box.setAttribute('aria-live', 'polite');
    parent.appendChild(this.box);
  }

  push(item: CardItem): void {
    this.queue.push(item);
  }

  clear(): void {
    this.queue.clear();
    this.fadeOut();
  }

  update(dt: number, hold: boolean): void {
    const e = this.queue.update(dt, hold, this.ev);
    if (e.hide) this.fadeOut();
    if (e.show) this.show(e.show, e.more);
  }

  private show(item: CardItem, more: number): void {
    this.fadeOut();
    const card = el('div', `card-slip${item.grand ? ' grand' : ''}`);
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    const icon = el('div', 'slip-icon', item.icon);
    const body = el('div', 'slip-body');
    body.appendChild(text('div', 'stamp', formatYear(item.year)));
    body.appendChild(text('div', 'slip-line', item.text));
    if (more > 0) body.appendChild(text('div', 'slip-more', `+${more} more in your journal`));
    card.append(icon, body);
    // Tap glides there; a sideways swipe just puts the card away.
    let downX = 0;
    let downY = 0;
    card.addEventListener('pointerdown', (e) => {
      downX = e.clientX;
      downY = e.clientY;
    });
    card.addEventListener('pointerup', (e) => {
      const dx = e.clientX - downX;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - downY)) {
        card.classList.add(dx > 0 ? 'swipe-right' : 'swipe-left');
        this.queue.dismiss();
        this.fadeOut();
        return;
      }
      this.actions.click();
      if (item.x !== undefined && item.z !== undefined) this.actions.glideTo(item.x, item.z);
      else this.actions.openJournal();
      this.queue.dismiss();
      this.fadeOut();
    });
    this.box.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));
    this.shown = card;
  }

  private fadeOut(): void {
    const c = this.shown;
    if (!c) return;
    this.shown = null;
    c.classList.remove('in');
    c.classList.add('out');
    setTimeout(() => c.remove(), 700);
  }
}
