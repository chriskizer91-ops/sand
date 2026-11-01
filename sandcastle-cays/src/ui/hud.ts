/**
 * The first-person screen: a small dot in the middle, the clock, your basket,
 * what you can do right now ("Pick up the cowrie"), the logbook, and on a
 * phone the thumb stick and the action and jump buttons.
 */
import { BASKET_CAPACITY } from '../config';
import { FINDS, FIND_KINDS, type FindKind } from '../content/finds';
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

/** Capitalise the first letter. */
export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface HudActions {
  action(): void;
  jump(): void;
  logbook(): void;
  standUp(): void;
  click(): void;
}

export class Hud {
  private root: HTMLDivElement;
  private dot: HTMLDivElement;
  private prompt: HTMLDivElement;
  private clockEl: HTMLDivElement;
  private basketEl: HTMLDivElement;
  private actionBtn: HTMLButtonElement;
  private jumpBtn: HTMLButtonElement;
  private standBtn: HTMLButtonElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private lookHint: HTMLDivElement;
  private card: HTMLDivElement;
  private cardTimer = 0;
  readonly logbook: HTMLDivElement;
  private logList: HTMLDivElement;
  private logSummary: HTMLParagraphElement;
  private lastPrompt = '';
  private lastClock = '';
  private lastBasket = -1;

  constructor(
    private actions: HudActions,
    readonly touch: boolean,
  ) {
    this.root = el('div', { id: 'fphud' });
    document.body.appendChild(this.root);
    this.dot = el('div', { id: 'dot' });
    this.prompt = el('div', { id: 'prompt', class: 'hide' });
    this.clockEl = el('div', { id: 'clock' });
    this.basketEl = el('div', { id: 'basket' });
    this.basketEl.innerHTML = `${ICONS.basket}<span></span>`;
    this.stickBase = el('div', { id: 'stick', class: 'hide' });
    this.stickKnob = el('div', { class: 'knob' });
    this.stickBase.appendChild(this.stickKnob);
    this.actionBtn = el('button', { id: 'actionbtn', class: 'hide', 'aria-label': 'Use' }, `${ICONS.grab}<span></span>`);
    this.actionBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      actions.action();
    });
    this.jumpBtn = el('button', { id: 'jumpbtn', 'aria-label': 'Jump' }, ICONS.up);
    this.jumpBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      actions.jump();
    });
    this.standBtn = el('button', { id: 'standbtn', class: 'hide' }, `${ICONS.stand}<span>Stand up</span>`);
    this.standBtn.addEventListener('click', () => {
      actions.click();
      actions.standUp();
    });
    this.lookHint = el('div', { id: 'lookhint', class: 'hide' }, 'Click to look around · <b>Esc</b> to let go of the pointer');
    this.card = el('div', { id: 'findcard', role: 'status' });
    this.root.append(this.dot, this.prompt, this.clockEl, this.basketEl, this.stickBase, this.actionBtn, this.jumpBtn, this.lookHint, this.card);
    document.body.appendChild(this.standBtn);
    if (!touch) {
      this.jumpBtn.style.display = 'none';
    }

    // The logbook.
    this.logbook = el('div', { class: 'panel hidden', id: 'logbook', role: 'dialog', 'aria-label': 'Logbook' });
    const h = el('h2', {}, 'Logbook');
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => this.showLogbook(false));
    h.appendChild(close);
    this.logSummary = el('p', { class: 'small' });
    this.logList = el('div', { class: 'loglist' });
    this.logbook.append(h, this.logSummary, this.logList);
    document.body.appendChild(this.logbook);
  }

  /** 'fp' when walking about, 'build' when kneeling at the sand, 'none' on the start screen. */
  setMode(mode: 'fp' | 'build' | 'none'): void {
    document.body.dataset.mode = mode;
    this.standBtn.classList.toggle('hide', mode !== 'build');
  }

  setClock(text: string): void {
    if (text === this.lastClock) return;
    this.lastClock = text;
    this.clockEl.textContent = text;
  }

  setBasket(n: number): void {
    if (n === this.lastBasket) return;
    this.lastBasket = n;
    (this.basketEl.querySelector('span') as HTMLSpanElement).innerHTML = `<b>${n}</b> / ${BASKET_CAPACITY}`;
    this.basketEl.classList.toggle('full', n >= BASKET_CAPACITY);
  }

  /** What you can do right now (null for nothing). `key` is the laptop key to show. */
  setPrompt(text: string | null, key = 'E'): void {
    const s = text ? `${key}|${text}` : '';
    if (s === this.lastPrompt) return;
    this.lastPrompt = s;
    if (!text) {
      this.prompt.classList.add('hide');
      this.actionBtn.classList.add('hide');
      this.dot.classList.remove('live');
      return;
    }
    this.prompt.innerHTML = this.touch ? text : `<kbd>${key}</kbd> ${text}`;
    this.prompt.classList.remove('hide');
    this.dot.classList.add('live');
    if (this.touch) {
      (this.actionBtn.querySelector('span') as HTMLSpanElement).textContent = text.split(' ')[0];
      this.actionBtn.classList.remove('hide');
    }
  }

  setLookHint(show: boolean): void {
    this.lookHint.classList.toggle('hide', !show);
  }

  setStick(v: { ox: number; oy: number; x: number; y: number } | null): void {
    if (!v) {
      this.stickBase.classList.add('hide');
      return;
    }
    this.stickBase.classList.remove('hide');
    this.stickBase.style.transform = `translate(${v.ox - 60}px, ${v.oy - 60}px)`;
    const dx = Math.max(-55, Math.min(55, v.x - v.ox));
    const dy = Math.max(-55, Math.min(55, v.y - v.oy));
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** A little card for something new (first of a kind). */
  showCard(title: string, line: string, ms = 5200): void {
    this.card.innerHTML = `<b>${title}</b><span>${line}</span>`;
    this.card.classList.add('show');
    clearTimeout(this.cardTimer);
    this.cardTimer = window.setTimeout(() => this.card.classList.remove('show'), ms);
  }

  showLogbook(show: boolean): void {
    this.logbook.classList.toggle('hidden', !show);
  }

  get logbookOpen(): boolean {
    return !this.logbook.classList.contains('hidden');
  }

  /** Fill the logbook: what you've found, what's aboard, and hints for the rest. */
  renderLogbook(found: Partial<Record<FindKind, number>>, locker: Partial<Record<FindKind, number>>, basket: FindKind[], clock: string): void {
    const kinds = FIND_KINDS;
    const nFound = kinds.filter((k) => found[k]).length;
    const aboard = Object.values(locker).reduce((a, b) => a + (b ?? 0), 0);
    this.logSummary.innerHTML = `${clock} · <b>${nFound}</b> of ${kinds.length} kinds found · <b>${aboard}</b> finds in the locker aboard · <b>${basket.length}</b> in your basket`;
    this.logList.innerHTML = '';
    const groups: [string, string][] = [
      ['shell', 'Shells'],
      ['sea glass', 'Sea glass'],
      ['wood', 'Wood and rope'],
      ['drift', 'Drifted here'],
    ];
    for (const [g, title] of groups) {
      const list = kinds.filter((k) => FINDS[k].group === g);
      if (!list.length) continue;
      this.logList.appendChild(el('h3', {}, title));
      for (const k of list) {
        const info = FINDS[k];
        const row = el('div', { class: `logrow${found[k] ? '' : ' unknown'}` });
        if (found[k]) {
          const n = locker[k] ?? 0;
          const b = basket.filter((x) => x === k).length;
          const where = [n ? `${n} aboard` : '', b ? `${b} in your basket` : ''].filter(Boolean).join(', ');
          row.innerHTML = `<div class="name">${cap(info.name)}<span>${where || 'none kept'}</span></div><div class="fact">${info.fact}</div>`;
        } else {
          row.innerHTML = `<div class="name">Not found yet<span>${info.group}</span></div>`;
        }
        this.logList.appendChild(row);
      }
    }
  }
}
