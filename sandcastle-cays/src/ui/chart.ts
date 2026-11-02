/**
 * The chart: a map of the waters you know, drawn by code from the shape of
 * the sea floor (deep blue, lagoon turquoise, the reef, the beaches), with
 * your boat, the wind, and buttons to sail somewhere by itself.
 */
import { ICONS } from './icons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

export interface ChartPlace {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Where the label goes relative to the place (metres on the chart). */
  labelDx?: number;
  labelDz?: number;
}

export interface ChartWorld {
  heightAt(x: number, z: number): number;
  groundAt(x: number, z: number, h: number): string;
}

export interface ChartActions {
  sailTo(id: string): void;
  stop(): void;
  close(): void;
  click(): void;
}

/** The area the chart shows (metres): x left to right, z bottom (south) to top (north). */
const AREA = { x0: -470, x1: 330, z0: -520, z1: 280 };
const RES = 320;

function hex(c: number): [number, number, number] {
  return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
const COL = {
  deep: hex(0x2a6f9e),
  mid: hex(0x3c9cbd),
  shallow: hex(0x86d8d8),
  reef: hex(0xc79b6b),
  sand: hex(0xf1e0b8),
  pink: hex(0xf3c4b4),
  grass: hex(0x7fb35e),
  rock: hex(0xa79f92),
};

export class Chart {
  readonly panel: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private base: HTMLCanvasElement | null = null;
  private buttons: HTMLDivElement;
  private note: HTMLParagraphElement;

  constructor(
    private world: ChartWorld,
    private places: ChartPlace[],
    private reefChannel: { x: number; z: number },
    private actions: ChartActions,
  ) {
    this.panel = el('div', { class: 'panel hidden', id: 'chart', role: 'dialog', 'aria-label': 'Chart' });
    const h = el('h2', {}, 'Chart');
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => actions.close());
    h.appendChild(close);
    this.canvas = el('canvas', { class: 'chartmap' });
    this.note = el('p', { class: 'small' });
    this.buttons = el('div', { class: 'chartbtns' });
    this.panel.append(h, this.canvas, this.note, this.buttons);
    document.body.appendChild(this.panel);
  }

  get open(): boolean {
    return !this.panel.classList.contains('hidden');
  }

  show(on: boolean): void {
    this.panel.classList.toggle('hidden', !on);
  }

  /** The sea floor, coloured, drawn once (it never changes). */
  private drawBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = RES;
    c.height = RES;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(RES, RES);
    for (let py = 0; py < RES; py++) {
      for (let px = 0; px < RES; px++) {
        const x = AREA.x0 + ((px + 0.5) / RES) * (AREA.x1 - AREA.x0);
        const z = AREA.z1 - ((py + 0.5) / RES) * (AREA.z1 - AREA.z0);
        const h = this.world.heightAt(x, z);
        let col: [number, number, number];
        if (h < -0.4) {
          const g = this.world.groundAt(x, z, h);
          if (g === 'reef') col = COL.reef;
          else if (h < -9) col = COL.deep;
          else if (h < -3) col = COL.mid;
          else col = COL.shallow;
        } else {
          const g = this.world.groundAt(x, z, h);
          col = g === 'grass' ? COL.grass : g === 'rock' ? COL.rock : g === 'pinksand' ? COL.pink : COL.sand;
        }
        const i = (px + py * RES) * 4;
        img.data[i] = col[0];
        img.data[i + 1] = col[1];
        img.data[i + 2] = col[2];
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private toPx(x: number, z: number, size: number): [number, number] {
    return [((x - AREA.x0) / (AREA.x1 - AREA.x0)) * size, ((AREA.z1 - z) / (AREA.z1 - AREA.z0)) * size];
  }

  /**
   * Redraw with the boat (heading in radians, +x = east) and the wind (blowing from, radians).
   * `courseTo` is the place being sailed to, if any; `aboard` decides whether you can sail from here.
   */
  render(boat: { x: number; z: number; heading: number }, windFrom: number, courseTo: string | null, aboard: boolean, you: { x: number; z: number } | null): void {
    if (!this.base) this.base = this.drawBase();
    const css = Math.min(340, window.innerWidth - 52);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = `${css}px`;
    this.canvas.style.height = `${css}px`;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    const ctx = this.canvas.getContext('2d')!;
    const S = this.canvas.width;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, S, S);
    const k = S / css;
    ctx.font = `${Math.round(12 * k)}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    // Places.
    for (const p of this.places) {
      const [px, py] = this.toPx(p.x + (p.labelDx ?? 0), p.z + (p.labelDz ?? 0), S);
      ctx.fillStyle = 'rgba(30,50,60,.85)';
      ctx.fillText(p.name, px, py);
    }
    // The reef channel.
    {
      const [px, py] = this.toPx(this.reefChannel.x, this.reefChannel.z, S);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.font = `${Math.round(10.5 * k)}px ui-rounded, system-ui, sans-serif`;
      ctx.fillText('gap in the reef', px - 26 * k, py + 4 * k);
    }
    // Wind arrow (top right).
    {
      const cx = S - 30 * k;
      const cy = 30 * k;
      ctx.save();
      ctx.translate(cx, cy);
      // Wind blows FROM windFrom; on the chart east is right and north is up.
      ctx.rotate(-windFrom + Math.PI);
      ctx.strokeStyle = '#157e93';
      ctx.lineWidth = 3 * k;
      ctx.beginPath();
      ctx.moveTo(-14 * k, 0);
      ctx.lineTo(12 * k, 0);
      ctx.moveTo(5 * k, -6 * k);
      ctx.lineTo(12 * k, 0);
      ctx.lineTo(5 * k, 6 * k);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#157e93';
      ctx.font = `${Math.round(10 * k)}px ui-rounded, system-ui, sans-serif`;
      ctx.fillText('wind', cx, cy + 22 * k);
      ctx.fillStyle = 'rgba(30,50,60,.75)';
      ctx.fillText('N ↑', 22 * k, 20 * k);
    }
    // You (when not aboard) and your boat.
    if (you) {
      const [px, py] = this.toPx(you.x, you.z, S);
      ctx.fillStyle = '#f07a55';
      ctx.beginPath();
      ctx.arc(px, py, 4 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    {
      const [px, py] = this.toPx(boat.x, boat.z, S);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-boat.heading);
      ctx.fillStyle = '#fffcf5';
      ctx.strokeStyle = '#3b3a36';
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.moveTo(9 * k, 0);
      ctx.lineTo(-6 * k, -5 * k);
      ctx.lineTo(-6 * k, 5 * k);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    // Buttons: sail to each place (from aboard), or stop.
    this.buttons.innerHTML = '';
    if (courseTo) {
      this.note.textContent = `Sailing for ${courseTo} by herself. Take the helm, or stop, whenever you like.`;
      const b = el('button', { class: 'wide' }, 'Stop sailing there');
      b.addEventListener('click', () => {
        this.actions.click();
        this.actions.stop();
      });
      this.buttons.appendChild(b);
    } else {
      this.note.textContent = aboard
        ? 'Tap a place to sail there by yourself. She finds the gap in the reef and tacks if she has to.'
        : 'Go aboard your boat to set sail.';
      for (const p of this.places) {
        if (Math.hypot(p.x - boat.x, p.z - boat.z) < 60) continue;
        const b = el('button', { class: 'wide' }, `Sail to ${p.name}`);
        b.disabled = !aboard;
        b.addEventListener('click', () => {
          this.actions.click();
          this.actions.sailTo(p.id);
        });
        this.buttons.appendChild(b);
      }
    }
  }
}
