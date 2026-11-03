/**
 * The workbench: mend the boat and make useful things from what the sea
 * washes up. Recipes appear once you've found every kind of thing they need.
 */
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export interface BenchRecipe {
  id: string;
  name: string;
  text: string;
  /** Known yet? Unknown ones show only as a hint. */
  known: boolean;
  needs: { name: string; have: number; need: number }[];
  /** Why it can't be made now, or null. */
  why: string | null;
}

export interface BenchView {
  hull: number;
  sails: number;
  bilge: number;
  recipes: BenchRecipe[];
}

export interface BenchActions {
  make(id: string): void;
  close(): void;
  click(): void;
}

export class Workbench {
  readonly panel: HTMLDivElement;
  private body: HTMLDivElement;

  constructor(private actions: BenchActions) {
    this.panel = el('div', { class: 'panel hidden', id: 'workbench', role: 'dialog', 'aria-label': 'Workbench' });
    const h = el('h2', {}, 'Workbench');
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

  render(v: BenchView): void {
    const b = this.body;
    b.innerHTML = '';
    const word = (x: number) => (x >= 95 ? 'sound' : x >= 70 ? 'worn' : x >= 40 ? 'badly worn' : 'in a bad way');
    b.appendChild(
      el(
        'p',
        { class: 'small' },
        `Hull: <b>${Math.round(v.hull)}%</b> (${word(v.hull)}) · Sails: <b>${Math.round(v.sails)}%</b> (${v.sails < 40 ? 'torn' : word(v.sails)})${v.bilge > 0.02 ? ` · Bilge: <b>${Math.round(v.bilge * 100)}% full</b>` : ''}`,
      ),
    );
    b.appendChild(el('p', { class: 'small' }, 'Everything here is made from finds in the locker aboard. Empty your basket into it first.'));
    let unknown = 0;
    for (const r of v.recipes) {
      if (!r.known) {
        unknown++;
        continue;
      }
      const row = el('div', { class: 'recipe' });
      row.innerHTML = `<div class="name">${r.name}</div><div class="text">${r.text}</div><div class="needs">${r.needs
        .map((n) => `<span class="${n.have >= n.need ? '' : 'short'}">${n.need} × ${n.name} (${n.have} aboard)</span>`)
        .join(' · ')}</div>`;
      const btn = el('button', { class: 'wide' }, r.why ?? 'Make it');
      btn.disabled = !!r.why;
      btn.addEventListener('click', () => {
        this.actions.click();
        this.actions.make(r.id);
      });
      row.appendChild(btn);
      b.appendChild(row);
    }
    if (unknown) b.appendChild(el('div', { class: 'recipe unknown' }, `<div class="name">${unknown} more thing${unknown === 1 ? '' : 's'} to work out</div><div class="text">Keep beachcombing: new finds give you new ideas.</div>`));
  }
}
