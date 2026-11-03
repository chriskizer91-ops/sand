/**
 * Dev tools: a small window for trying things out quickly. Press T on a
 * laptop, or Menu → Dev tools on the phone. It shows what the game is doing
 * (frame rate, the boat, the wind) and has buttons to jump the boat around,
 * call up a squall, change the wind, the time of day and the game's speed.
 * The game keeps running while it's open.
 */
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export interface DevActions {
  goTo(id: 'home' | 'pink' | 'gap' | 'open' | 'buoy'): void;
  pushOff(): void;
  repairHull(): void;
  stopBoat(): void;
  squallHere(): void;
  squallComing(): void;
  setSqualls(on: boolean): void;
  setWind(k: number): void;
  setHour(h: number): void;
  nextMorning(): void;
  setClockRunning(on: boolean): void;
  setSpeed(k: number): void;
  setFps(on: boolean): void;
  fillStores(): void;
  lowStores(): void;
  giveMaterials(): void;
  biteNow(): void;
  growGarden(): void;
  waterGarden(): void;
  moreSeeds(): void;
  scrapeHull(): void;
  click(): void;
}

export class DevTools {
  readonly panel: HTMLDivElement;
  private info: HTMLDivElement;
  private lastInfo = '';

  constructor(
    private actions: DevActions,
    touch: boolean,
  ) {
    this.panel = el('div', { id: 'devtools', class: 'hidden', role: 'dialog', 'aria-label': 'Dev tools' });
    // Touches and clicks here are for the panel, not the game.
    for (const ev of ['pointerdown', 'touchstart', 'wheel'] as const) this.panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    const h = el('h2', {}, `Dev tools <span class="small">${touch ? '' : 'T to close'}</span>`);
    const close = el('button', { class: 'round', style: 'width:30px;height:30px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => this.toggle(false));
    h.appendChild(close);
    this.info = el('div', { class: 'devinfo' });
    this.panel.append(h, this.info);

    const section = (title: string) => this.panel.appendChild(el('h3', {}, title));
    const row = (buttons: [string, () => void][]) => {
      const r = el('div', { class: 'row' });
      for (const [label, fn] of buttons) {
        const b = el('button', { class: 'pill' }, label);
        b.addEventListener('click', () => {
          actions.click();
          fn();
        });
        r.appendChild(b);
      }
      this.panel.appendChild(r);
    };
    /** A row where one choice is lit up. */
    const choice = (opts: [string, () => void][], on: number) => {
      const r = el('div', { class: 'row' });
      opts.forEach(([label, fn], i) => {
        const b = el('button', { class: `pill${i === on ? ' on' : ''}` }, label);
        b.addEventListener('click', () => {
          actions.click();
          r.querySelectorAll('.pill').forEach((p) => p.classList.toggle('on', p === b));
          fn();
        });
        r.appendChild(b);
      });
      this.panel.appendChild(r);
    };

    section('Move the boat (you go too)');
    row([
      ['Home Cay', () => actions.goTo('home')],
      ['Pink Sand Cay', () => actions.goTo('pink')],
      ['Reef gap', () => actions.goTo('gap')],
      ['Open sea', () => actions.goTo('open')],
      ['Sea buoy', () => actions.goTo('buoy')],
    ]);
    section('Boat');
    row([
      ['Push off', () => actions.pushOff()],
      ['Mend the hull', () => actions.repairHull()],
      ['Stop her', () => actions.stopBoat()],
    ]);
    section('Living aboard');
    row([
      ['Fill the stores', () => actions.fillStores()],
      ['Stores nearly out', () => actions.lowStores()],
      ['3 of every find', () => actions.giveMaterials()],
      ['A fish bites now', () => actions.biteNow()],
      ['Scrape the hull', () => actions.scrapeHull()],
    ]);
    section('Garden');
    row([
      ['Ripen everything', () => actions.growGarden()],
      ['Water everything', () => actions.waterGarden()],
      ['5 more of each seed', () => actions.moreSeeds()],
    ]);
    section('Weather');
    row([
      ['Squall here', () => actions.squallHere()],
      ['Squall coming', () => actions.squallComing()],
    ]);
    choice(
      [
        ['Squalls on', () => actions.setSqualls(true)],
        ['No squalls', () => actions.setSqualls(false)],
      ],
      0,
    );
    choice(
      [
        ['Light wind', () => actions.setWind(0.5)],
        ['Normal wind', () => actions.setWind(1)],
        ['Strong wind', () => actions.setWind(1.6)],
      ],
      1,
    );
    section('Time');
    row([
      ['Dawn', () => actions.setHour(6.4)],
      ['Noon', () => actions.setHour(12)],
      ['Sunset', () => actions.setHour(19.3)],
      ['Night', () => actions.setHour(22.5)],
      ['Next morning', () => actions.nextMorning()],
    ]);
    choice(
      [
        ['Clock runs', () => actions.setClockRunning(true)],
        ['Clock stopped', () => actions.setClockRunning(false)],
      ],
      0,
    );
    section('Game speed');
    choice(
      [
        ['×1', () => actions.setSpeed(1)],
        ['×2', () => actions.setSpeed(2)],
        ['×4', () => actions.setSpeed(4)],
      ],
      0,
    );
    section('Screen');
    choice(
      [
        ['Frame rate off', () => actions.setFps(false)],
        ['Frame rate on', () => actions.setFps(true)],
      ],
      0,
    );
    document.body.appendChild(this.panel);
  }

  get open(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  toggle(on?: boolean): void {
    this.panel.classList.toggle('hidden', !(on ?? !this.open));
  }

  /** The live readout: label and value pairs. */
  setInfo(rows: [string, string][]): void {
    const html = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    if (html !== this.lastInfo) {
      this.lastInfo = html;
      this.info.innerHTML = html;
    }
  }
}
