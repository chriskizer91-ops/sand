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
  /** Tapped the stores readout. */
  stores(): void;
  /** Tapped the rod button. */
  rod(): void;
  /** The round action button is held down (true) or let go (false). */
  hold?(on: boolean): void;
}

export class Hud {
  private root: HTMLDivElement;
  private dot: HTMLDivElement;
  private prompt: HTMLDivElement;
  private clockEl: HTMLDivElement;
  private basketEl: HTMLDivElement;
  private storesEl: HTMLDivElement;
  private lastStores = '';
  private rodBtn: HTMLButtonElement;
  private fishPanel: HTMLDivElement;
  private fishLine: HTMLDivElement;
  private fishTension: HTMLDivElement;
  private fishProgress: HTMLDivElement;
  private lastFish = '';
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
    // Food and water stores, in days. Tap for the galley.
    this.storesEl = el('button', { id: 'stores', 'aria-label': 'Stores' }) as unknown as HTMLDivElement;
    this.storesEl.innerHTML = `<span class="st food">${ICONS.food}<b></b></span><span class="st water">${ICONS.water}<b></b></span>`;
    this.storesEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.storesEl.addEventListener('click', () => {
      actions.click();
      actions.stores();
    });
    // The fishing rod: pick it up or put it away.
    this.rodBtn = el('button', { id: 'rodbtn', class: 'hide', 'aria-label': 'Fishing rod' }, `${ICONS.rod}<span>Fish</span>`);
    this.rodBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      actions.rod();
    });
    // While fishing: what's happening, the line's tension and how close the fish is.
    this.fishPanel = el('div', { id: 'fishpanel', class: 'hide' });
    this.fishLine = el('div', { class: 'l' });
    this.fishTension = el('div', { class: 'bar tension' }, '<div></div><span>line</span>');
    this.fishProgress = el('div', { class: 'bar progress' }, '<div></div><span>fish</span>');
    this.fishPanel.append(this.fishLine, this.fishTension, this.fishProgress);
    this.stickBase = el('div', { id: 'stick', class: 'hide' });
    this.stickKnob = el('div', { class: 'knob' });
    this.stickBase.appendChild(this.stickKnob);
    this.actionBtn = el('button', { id: 'actionbtn', class: 'hide', 'aria-label': 'Use' }, `${ICONS.grab}<span></span>`);
    this.actionBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      actions.action();
      actions.hold?.(true);
    });
    // Holding the button (reeling in a fish).
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) this.actionBtn.addEventListener(ev, () => actions.hold?.(false));
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
    this.root.append(this.dot, this.prompt, this.clockEl, this.basketEl, this.storesEl, this.stickBase, this.actionBtn, this.jumpBtn, this.rodBtn, this.fishPanel, this.lookHint, this.card);
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

  /** The stores (days of food and water); `low` marks one that's nearly out. */
  setStores(food: number, water: number, foodMax: number, waterMax: number): void {
    const f = food < 1 ? food.toFixed(1) : Math.floor(food).toString();
    const w = water < 1 ? water.toFixed(1) : Math.floor(water).toString();
    const key = `${f}|${w}`;
    if (key === this.lastStores) return;
    this.lastStores = key;
    const [fe, we] = this.storesEl.querySelectorAll('b');
    fe.textContent = `${f} d`;
    we.textContent = `${w} d`;
    this.storesEl.querySelector('.food')!.classList.toggle('low', food < 3);
    this.storesEl.querySelector('.water')!.classList.toggle('low', water < 3);
    this.storesEl.setAttribute('aria-label', `Stores: ${f} of ${foodMax} days of food, ${w} of ${waterMax} days of water`);
  }

  /** The rod button: shown when you could fish here (or are fishing), lit while the rod is in your hands. */
  setRod(show: boolean, holding: boolean): void {
    this.rodBtn.classList.toggle('hide', !show);
    this.rodBtn.classList.toggle('on', holding);
    (this.rodBtn.querySelector('span') as HTMLSpanElement).textContent = holding ? 'Put away' : 'Fish';
  }

  /** While fishing: a line of text, and (reeling) the line's tension and how near the fish is. Null hides it. */
  setFishing(f: { text: string; tension: number | null; progress: number | null } | null): void {
    const key = f ? `${f.text}|${f.tension?.toFixed(2)}|${f.progress?.toFixed(2)}` : '';
    if (key === this.lastFish) return;
    this.lastFish = key;
    this.fishPanel.classList.toggle('hide', !f);
    if (!f) return;
    this.fishLine.innerHTML = f.text;
    const reeling = f.tension !== null;
    this.fishTension.style.display = reeling ? '' : 'none';
    this.fishProgress.style.display = reeling ? '' : 'none';
    if (reeling) {
      const t = this.fishTension.firstElementChild as HTMLDivElement;
      t.style.width = `${Math.round(Math.min(1, f.tension!) * 100)}%`;
      this.fishTension.classList.toggle('danger', f.tension! > 0.7);
      (this.fishProgress.firstElementChild as HTMLDivElement).style.width = `${Math.round(Math.min(1, f.progress ?? 0) * 100)}%`;
    }
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
  renderLogbook(
    found: Partial<Record<FindKind, number>>,
    locker: Partial<Record<FindKind, number>>,
    basket: FindKind[],
    clock: string,
    boat?: { hull: number; where: string; sailing?: string; rows?: { name: string; value: string; text: string }[] },
    fish?: { name: string; count: number; fact: string }[],
    garden?: { rows: { name: string; count: number; fact: string }[]; seeds: string },
  ): void {
    const kinds = FIND_KINDS;
    const nFound = kinds.filter((k) => found[k]).length;
    const aboard = Object.values(locker).reduce((a, b) => a + (b ?? 0), 0);
    this.logSummary.innerHTML = `${clock} · <b>${nFound}</b> of ${kinds.length} kinds found · <b>${aboard}</b> finds in the locker aboard · <b>${basket.length}</b> in your basket`;
    this.logList.innerHTML = '';
    if (boat) {
      this.logList.appendChild(el('h3', {}, 'Your boat'));
      const hull = Math.round(boat.hull);
      const word = hull >= 95 ? 'sound' : hull >= 70 ? 'a few scrapes' : hull >= 40 ? 'badly scraped' : 'in a bad way';
      this.logList.appendChild(el('div', { class: 'logrow' }, `<div class="name">Hull: ${word}<span>${hull}%</span></div><div class="fact">${boat.where}. Running aground on the reef or a beach scrapes the hull.</div>`));
      for (const r of boat.rows ?? []) this.logList.appendChild(el('div', { class: 'logrow' }, `<div class="name">${r.name}<span>${r.value}</span></div><div class="fact">${r.text}</div>`));
      if (boat.sailing) this.logList.appendChild(el('div', { class: 'logrow' }, `<div class="name">The sea buoy</div><div class="fact">${boat.sailing}</div>`));
    }
    if (garden) {
      this.logList.appendChild(el('h3', {}, 'Garden'));
      this.logList.appendChild(el('div', { class: 'logrow' }, `<div class="name">Seed tin</div><div class="fact">${garden.seeds}. Harvests give you seeds back.</div>`));
      for (const g of garden.rows) {
        const row = el('div', { class: `logrow${g.count ? '' : ' unknown'}` });
        row.innerHTML = g.count
          ? `<div class="name">${cap(g.name)}<span>harvested ${g.count === 1 ? 'once' : `${g.count} times`}</span></div><div class="fact">${g.fact}</div>`
          : `<div class="name">${cap(g.name)}<span>not grown yet</span></div>`;
        this.logList.appendChild(row);
      }
    }
    if (fish) {
      this.logList.appendChild(el('h3', {}, 'Fish'));
      for (const f of fish) {
        const row = el('div', { class: `logrow${f.count ? '' : ' unknown'}` });
        row.innerHTML = f.count
          ? `<div class="name">${cap(f.name)}<span>caught ${f.count === 1 ? 'once' : `${f.count} times`}</span></div><div class="fact">${f.fact}</div>`
          : `<div class="name">Not caught yet<span>fish</span></div>`;
        this.logList.appendChild(row);
      }
    }
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
