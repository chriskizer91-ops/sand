/**
 * The galley (below decks): your stores, the cool box of fresh fish, and
 * coconuts from the locker. Cook the fish to fill the larder.
 */
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export interface GalleyView {
  food: number;
  foodMax: number;
  water: number;
  waterMax: number;
  /** Fish in the cool box: name and how long until it spoils (hours). */
  fish: { name: string; hoursLeft: number }[];
  /** Days of food the fish will make. */
  fishFood: number;
  coconuts: number;
  /** One line about the rain catcher and the fish trap. */
  extras: string;
  hungry: boolean;
  thirsty: boolean;
  /** The bait box (once the notebook has taught you to cut bait). */
  bait?: { known: boolean; have: number; max: number; perFish: number };
}

export interface GalleyActions {
  cook(): void;
  coconut(): void;
  cutBait?(): void;
  close(): void;
  click(): void;
}

const days = (d: number) => (d < 1 ? `${d.toFixed(1)} days` : `${d.toFixed(d < 10 ? 1 : 0)} days`);

export class Galley {
  readonly panel: HTMLDivElement;
  private body: HTMLDivElement;

  constructor(private actions: GalleyActions) {
    this.panel = el('div', { class: 'panel hidden', id: 'galley', role: 'dialog', 'aria-label': 'Galley' });
    const h = el('h2', {}, 'The galley');
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => actions.close());
    h.appendChild(close);
    this.body = el('div');
    this.panel.append(h, this.body);
    document.body.appendChild(this.panel);
  }

  get open(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  show(on: boolean): void {
    this.panel.classList.toggle('hidden', !on);
  }

  render(v: GalleyView): void {
    const b = this.body;
    b.innerHTML = '';
    const bar = (cls: string, x: number, max: number) => `<div class="storebar ${cls}"><div style="width:${Math.round((100 * x) / max)}%"></div></div>`;
    b.appendChild(el('h3', {}, 'Stores'));
    b.appendChild(el('p', {}, `<b>Food:</b> ${days(v.food)} of ${v.foodMax}${v.hungry ? ' · <b class="bad">you’re hungry</b>' : ''}`));
    b.insertAdjacentHTML('beforeend', bar('food', v.food, v.foodMax));
    b.appendChild(el('p', {}, `<b>Water:</b> ${days(v.water)} of ${v.waterMax}${v.thirsty ? ' · <b class="bad">you’re thirsty</b>' : ''}`));
    b.insertAdjacentHTML('beforeend', bar('water', v.water, v.waterMax));
    b.appendChild(el('p', { class: 'small' }, `You eat a day’s food and drink a day’s water each day. ${v.extras}`));

    b.appendChild(el('h3', {}, 'Cool box'));
    if (v.fish.length) {
      const list = v.fish.map((f) => `${f.name} <span class="small">(keeps ${Math.max(1, Math.round(f.hoursLeft))} more hours)</span>`).join('<br>');
      b.appendChild(el('p', {}, list));
      const cook = el('button', { class: 'wide' }, `Cook the fish (+${days(v.fishFood)} of food)`);
      cook.addEventListener('click', () => {
        this.actions.click();
        this.actions.cook();
      });
      b.appendChild(cook);
    } else b.appendChild(el('p', { class: 'small' }, 'Empty. Fish from the deck, the shore or the dinghy: tap the rod button (G on a laptop).'));

    if (v.bait?.known) {
      b.appendChild(el('h3', {}, 'Bait box'));
      b.appendChild(el('p', {}, `${v.bait.have} of ${v.bait.max} pieces of bait. <span class="small">Throw one to a curious shark and it goes after that instead of you.</span>`));
      const cut = el('button', { class: 'wide' }, v.fish.length ? `Cut a fish into bait (${v.bait.perFish} pieces)` : 'No fish to cut up');
      cut.disabled = !v.fish.length || v.bait.have >= v.bait.max;
      cut.addEventListener('click', () => {
        this.actions.click();
        this.actions.cutBait?.();
      });
      b.appendChild(cut);
    }

    b.appendChild(el('h3', {}, 'Coconuts'));
    const c = el('button', { class: 'wide' }, v.coconuts ? `Open a coconut (${v.coconuts} in the locker)` : 'No coconuts in the locker');
    c.disabled = !v.coconuts;
    c.addEventListener('click', () => {
      this.actions.click();
      this.actions.coconut();
    });
    b.appendChild(c);
    b.appendChild(el('p', { class: 'small' }, 'Coconuts wash up on the beaches, and you can shake them down from the palms.'));
  }
}
