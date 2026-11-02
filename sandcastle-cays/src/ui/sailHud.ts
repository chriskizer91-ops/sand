/**
 * Sailing on screen: a little dial (your boat pointing up, where the wind
 * comes from, and the shaded no-go zone), your speed and point of sail, and
 * at the helm a row of buttons for the sails, the anchor, the chart and
 * letting go of the tiller.
 */
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export interface SailHudActions {
  sailUp(): void;
  sailDown(): void;
  anchor(): void;
  chart(): void;
  leaveHelm(): void;
  click(): void;
}

export interface SailReadout {
  /** Where the wind comes from relative to the bow (radians, + = from starboard). */
  windRel: number;
  /** Compass heading in degrees (0 = north, 90 = east). */
  compass: number;
  knots: number;
  windKnots: number;
  point: string;
  sail: number;
  sailSet: number;
  anchored: boolean;
  aground: boolean;
  course: string | null;
}

const NOGO_DEG = 38;

function compassWord(deg: number): string {
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return words[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export class SailHud {
  private panel: HTMLDivElement;
  private dial: SVGSVGElement;
  private windArrow: SVGGElement;
  private wedge: SVGPathElement;
  private line1: HTMLDivElement;
  private line2: HTMLDivElement;
  private bar: HTMLDivElement;
  private sailLabel: HTMLSpanElement;
  private anchorLabel: HTMLSpanElement;
  private last = '';

  constructor(
    private actions: SailHudActions,
    private touch: boolean,
  ) {
    this.panel = el('div', { id: 'sailhud', class: 'hide' });
    this.panel.innerHTML = `
      <svg viewBox="-50 -50 100 100" width="64" height="64" aria-hidden="true">
        <circle r="46" fill="rgba(255,255,255,.55)" stroke="rgba(30,60,70,.25)" stroke-width="2"/>
        <path class="wedge" fill="rgba(240,122,85,.28)"/>
        <path d="M0 -26 C9 -12 10 8 7 24 L-7 24 C-10 8 -9 -12 0 -26z" fill="#fffcf5" stroke="#3b3a36" stroke-width="2.4"/>
        <line x1="0" y1="-14" x2="0" y2="16" stroke="#3b3a36" stroke-width="2"/>
        <g class="wind"><path d="M0 -46 L0 -30 M-6 -38 L0 -30 L6 -38" stroke="#157e93" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>
      </svg>
      <div class="txt"><div class="l1"></div><div class="l2"></div></div>`;
    this.dial = this.panel.querySelector('svg')!;
    this.windArrow = this.panel.querySelector('g.wind')!;
    this.wedge = this.panel.querySelector('path.wedge')!;
    this.line1 = this.panel.querySelector('.l1')!;
    this.line2 = this.panel.querySelector('.l2')!;
    document.body.appendChild(this.panel);

    // The helm buttons.
    this.bar = el('div', { id: 'helmbar', class: 'hide', role: 'toolbar', 'aria-label': 'Helm' });
    const button = (icon: string, label: string, key: string, fn: () => void): HTMLSpanElement => {
      const b = el('button', { class: 'tool' }, `${icon}<span>${label}</span>${touch ? '' : `<kbd>${key}</kbd>`}`);
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', () => {
        actions.click();
        fn();
      });
      this.bar.appendChild(b);
      return b.querySelector('span') as HTMLSpanElement;
    };
    button(ICONS.sailDown, 'Less sail', 'S', () => actions.sailDown());
    this.sailLabel = button(ICONS.sailUp, 'More sail', 'W', () => actions.sailUp());
    this.anchorLabel = button(ICONS.anchor, 'Anchor', 'X', () => actions.anchor());
    button(ICONS.chart, 'Chart', 'M', () => actions.chart());
    button(ICONS.stand, 'Let go', 'E', () => actions.leaveHelm());
    document.body.appendChild(this.bar);
  }

  /** Show the dial (aboard, or whenever the boat is under way) and the helm buttons (at the helm). */
  show(dial: boolean, helm: boolean): void {
    this.panel.classList.toggle('hide', !dial);
    this.bar.classList.toggle('hide', !helm);
    document.body.classList.toggle('athelm', helm);
  }

  update(r: SailReadout): void {
    const deg = (r.windRel * 180) / Math.PI;
    // The wind arrow sits on the dial's rim where the wind comes from (bow = up, starboard = right).
    this.windArrow.setAttribute('transform', `rotate(${deg.toFixed(1)})`);
    const a0 = ((deg - NOGO_DEG - 90) * Math.PI) / 180;
    const a1 = ((deg + NOGO_DEG - 90) * Math.PI) / 180;
    this.wedge.setAttribute('d', `M0 0 L${(46 * Math.cos(a0)).toFixed(1)} ${(46 * Math.sin(a0)).toFixed(1)} A46 46 0 0 1 ${(46 * Math.cos(a1)).toFixed(1)} ${(46 * Math.sin(a1)).toFixed(1)} Z`);
    let l1: string;
    if (r.anchored) l1 = '<b>At anchor</b>';
    else if (r.aground) l1 = '<b class="bad">Aground!</b> Steer for deeper water';
    else l1 = `<b>${r.knots.toFixed(1)} knots</b> · ${r.point === 'in irons' ? '<b class="bad">in irons</b> (sails flapping)' : r.point}`;
    const heading = `heading ${compassWord(r.compass)}`;
    const l2 = r.course ? `Sailing for ${r.course} · ${heading}` : `${heading} · wind ${r.windKnots.toFixed(0)} knots`;
    const key = l1 + l2;
    if (key !== this.last) {
      this.last = key;
      this.line1.innerHTML = l1;
      this.line2.textContent = l2;
    }
    const sails = r.sailSet <= 0.01 ? 'Sails down' : r.sailSet < 0.99 ? 'Half sail' : 'Full sail';
    this.sailLabel.textContent = r.sailSet >= 0.99 ? sails : 'More sail';
    this.anchorLabel.textContent = r.anchored ? 'Raise anchor' : 'Drop anchor';
    void this.dial;
  }
}
