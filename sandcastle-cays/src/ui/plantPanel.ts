/**
 * Choosing what to plant in an empty pot or bed: the seeds in your tin.
 */
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export interface SeedChoice {
  id: string;
  name: string;
  /** "3 seeds" */
  have: string;
  /** "ripe in 2 days; cut it and it grows back" */
  note: string;
  ok: boolean;
}

export class PlantPanel {
  readonly panel: HTMLDivElement;
  private body: HTMLDivElement;
  private title: HTMLHeadingElement;

  constructor(
    private onPick: (crop: string) => void,
    private onClose: () => void,
    private click: () => void,
  ) {
    this.panel = el('div', { class: 'panel hidden', id: 'plantpanel', role: 'dialog', 'aria-label': 'Plant' });
    this.title = el('h2', {}, 'Plant');
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => onClose());
    this.title.appendChild(close);
    this.body = el('div');
    this.panel.append(this.title, this.body);
    document.body.appendChild(this.panel);
  }

  get open(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  show(on: boolean, where = '', seeds: SeedChoice[] = []): void {
    this.panel.classList.toggle('hidden', !on);
    if (!on) return;
    this.title.firstChild!.textContent = `Plant in ${where}`;
    const b = this.body;
    b.innerHTML = '';
    b.appendChild(el('p', { class: 'small' }, 'From your seed tin. Water it every day (rain does it for you), and harvest when it’s ripe.'));
    for (const s of seeds) {
      const row = el('div', { class: 'recipe' });
      row.innerHTML = `<div class="name">${s.name}<span class="small">${s.have}</span></div><div class="text">${s.note}</div>`;
      const btn = el('button', { class: 'wide' }, s.ok ? `Plant ${s.name.toLowerCase()}` : 'No seeds left');
      btn.disabled = !s.ok;
      btn.addEventListener('click', () => {
        this.click();
        this.onPick(s.id);
      });
      row.appendChild(btn);
      b.appendChild(row);
    }
  }
}
