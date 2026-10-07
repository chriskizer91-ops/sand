/**
 * The journal's Chart: a hand-coloured map of the whole zone, painted from the world data the
 * page already holds (heights, ground and plant cover). Sea is tinted by depth, land by what
 * it is made of and how green it has become, with soft hill shading, faint 20 m contour lines
 * and an ink coastline, so it reads like a sketch in a field notebook.
 *
 * Island names sit on the map; tap one to rename it. Tap anywhere else to fly there.
 * The old islands, where most life comes from, lie off the east edge, upwind.
 */
import { CELL, NP, NX, NZ, ORIGIN_X, ORIGIN_Z, SEA_LEVEL, ZONE_SIZE } from '../config';
import type { IslandInfo } from '../engine/protocol';
import type { WorldFields } from '../render/fields';
import { el, text } from './dom';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Colours (0..255 RGB). */
const SHALLOW = [150, 220, 210];
const MID = [104, 186, 198];
const DEEP = [72, 136, 168];
const PAPER = [243, 234, 214];
const INK = [59, 51, 40];
const BASALT = [92, 84, 78];
const STONE = [150, 146, 136];
const LIME = [214, 204, 178];
const SAND_BLACK = [96, 90, 86];
const SAND_GOLD = [222, 196, 140];
const SAND_WHITE = [245, 238, 220];
const LICHEN = [170, 176, 140];
const MOSS = [118, 158, 72];
const GRASS = [150, 176, 88];
const FOREST = [62, 106, 56];
const LAVA = [236, 112, 52];
/** Half the camera mark's size on the chart (px; see .chart-cam in index.html), plus a little air. */
const MARK_R = 10;

/**
 * Paint the zone into an RGBA buffer of NX x NZ pixels (one per column; north at the top,
 * east to the right).
 */
export function paintChart(fields: WorldFields, out: Uint8ClampedArray): void {
  const s = fields.surf;
  const g = fields.ground;
  const ca = fields.coverA;
  let r = 0;
  let gg = 0;
  let b = 0;
  const set3 = (c: number[]) => {
    r = c[0];
    gg = c[1];
    b = c[2];
  };
  const toward = (c: number[], t: number) => {
    r = mix(r, c[0], t);
    gg = mix(gg, c[1], t);
    b = mix(b, c[2], t);
  };
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const c = i + k * NX;
      const h = s[c];
      const hl = s[i > 0 ? c - 1 : c];
      const hr = s[i < NX - 1 ? c + 1 : c];
      const hu = s[k > 0 ? c - NX : c];
      const hd = s[k < NZ - 1 ? c + NX : c];
      const land = h >= SEA_LEVEL;
      if (!land) {
        const t = Math.sqrt(clamp01((SEA_LEVEL - h) / 30));
        if (t < 0.5) {
          set3(SHALLOW);
          toward(MID, t * 2);
        } else {
          set3(MID);
          toward(DEEP, (t - 0.5) * 2);
        }
        // Gentle shading of the sea floor so ridges and banks show through.
        const shade = 1 + ((hr - hl) + (hd - hu)) * 0.03;
        const f = shade < 0.9 ? 0.9 : shade > 1.1 ? 1.1 : shade;
        r *= f;
        gg *= f;
        b *= f;
      } else {
        const lava = g[c * 4] / 20;
        const heat = g[c * 4 + 1] / 255;
        const sed = g[c * 4 + 2] / 50;
        const kinds = g[c * 4 + 3];
        if (lava > 0.05 && heat > 0.3) set3(LAVA);
        else if (sed > 0.25) {
          const sk = kinds & 0xfc;
          if (sk < 128) {
            set3(SAND_BLACK);
            toward(SAND_GOLD, sk / 128);
          } else {
            set3(SAND_GOLD);
            toward(SAND_WHITE, (sk - 128) / 127);
          }
        } else {
          const rk = kinds & 3;
          set3(rk === 1 ? STONE : rk === 2 ? LIME : BASALT);
        }
        // Life greens the land: lichen, moss, grass, then forest.
        const p = ((i >> 1) + (k >> 1) * NP) * 4;
        toward(LICHEN, (ca[p] / 255) * 0.35);
        toward(MOSS, (ca[p + 1] / 255) * 0.6);
        toward(GRASS, (ca[p + 2] / 255) * 0.7);
        toward(FOREST, (ca[p + 3] / 255) * 0.85);
        // Higher ground a little paler; light from the north-west.
        toward(PAPER, clamp01(h / 180) * 0.25);
        const shade = 1 + ((hr - hl) + (hd - hu)) * 0.045;
        const f = shade < 0.72 ? 0.72 : shade > 1.22 ? 1.22 : shade;
        r *= f;
        gg *= f;
        b *= f;
        // Faint contour every 20 m.
        if (Math.floor(h / 20) !== Math.floor(hr / 20) || Math.floor(h / 20) !== Math.floor(hd / 20)) toward(INK, 0.22);
      }
      // Ink coastline.
      if (land !== hr >= SEA_LEVEL || land !== hd >= SEA_LEVEL) toward(INK, 0.75);
      // A wash of paper over everything.
      toward(PAPER, 0.16);
      const o = c * 4;
      out[o] = r;
      out[o + 1] = gg;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
}

/** World x/z for a point on the chart given as fractions 0..1 across and down. */
export function chartToWorld(fx: number, fz: number): { x: number; z: number } {
  return { x: ORIGIN_X + fx * NX * CELL, z: ORIGIN_Z + fz * NZ * CELL };
}

/** Fractions 0..1 across and down the chart for a world point. */
export function worldToChart(x: number, z: number): { fx: number; fz: number } {
  return { fx: (x - ORIGIN_X) / ZONE_SIZE, fz: (z - ORIGIN_Z) / ZONE_SIZE };
}

export interface ChartActions {
  flyTo(x: number, z: number): void;
  rename(island: number, name: string): void;
}

export class ChartPage {
  readonly root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private names: HTMLDivElement;
  private camMark: HTMLDivElement;
  private image: ImageData | null = null;
  private paintedCols = -1;
  private paintedEco = -1;
  private renaming = false;
  /** What the name labels were last built from (rebuilt only when islands change, so a tap is never lost). */
  private namesKey = '';
  /** Each name label and where it sits on the chart (fractions across and down). */
  private labels: { b: HTMLButtonElement; fx: number; fz: number }[] = [];

  constructor(
    private fields: WorldFields,
    private actions: ChartActions,
  ) {
    this.root = el('div', 'j-page chart');
    const wrap = el('div', 'chart-wrap');
    this.canvas = el('canvas', 'chart-canvas');
    this.canvas.width = NX;
    this.canvas.height = NZ;
    this.canvas.setAttribute('aria-label', 'Map of your sea');
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const w = chartToWorld((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      this.actions.flyTo(w.x, w.z);
    });
    this.names = el('div', 'chart-names');
    this.camMark = el('div', 'chart-cam');
    const compass = el(
      'div',
      'chart-compass',
      '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17"/><path d="M20 5l5 15h-10z" class="n"/><path d="M20 35l-5-15h10z"/></svg><b>N</b>',
    );
    const east = el('div', 'chart-east');
    east.textContent = 'Old islands, upwind →';
    // The camera mark sits under the names, so a name (and its rename tap) is never covered.
    wrap.append(this.canvas, this.camMark, this.names, compass, east);
    this.root.append(wrap, text('p', 'chart-caption', 'Tap the sea or an island to fly there. Tap a name to rename it.'));
  }

  /** Repaint if the world changed since last time, and place names and the camera mark. */
  render(islands: readonly IslandInfo[], camX: number, camZ: number, camYaw: number): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    if (this.paintedCols !== this.fields.colsVersion || this.paintedEco !== this.fields.ecoVersion || !this.image) {
      this.image ??= ctx.createImageData(NX, NZ);
      paintChart(this.fields, this.image.data);
      ctx.putImageData(this.image, 0, 0);
      this.paintedCols = this.fields.colsVersion;
      this.paintedEco = this.fields.ecoVersion;
    }
    const cam = worldToChart(camX, camZ);
    this.camMark.style.left = `${(cam.fx * 100).toFixed(2)}%`;
    this.camMark.style.top = `${(cam.fz * 100).toFixed(2)}%`;
    // The view looks from the camera toward the target: draw the mark pointing that way.
    this.camMark.style.transform = `translate(-50%, -50%) rotate(${(-camYaw * 180) / Math.PI}deg)`;
    if (this.renaming) return;
    const key = islands.map((i) => `${i.id}:${i.name}:${Math.round(i.centroid[0])}:${Math.round(i.centroid[1])}`).join('|');
    if (key !== this.namesKey) {
      this.namesKey = key;
      this.names.textContent = '';
      this.labels.length = 0;
      for (const isl of islands) {
        const p = worldToChart(isl.centroid[0], isl.centroid[1]);
        const b = el('button', 'chart-name');
        b.type = 'button';
        b.textContent = isl.name;
        b.title = 'Rename this island';
        b.style.left = `${(p.fx * 100).toFixed(2)}%`;
        b.style.top = `${(p.fz * 100).toFixed(2)}%`;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          this.startRename(b, isl);
        });
        this.names.appendChild(b);
        this.labels.push({ b, fx: p.fx, fz: p.fz });
      }
    }
    this.clearMark(cam.fx, cam.fz);
  }

  /**
   * The camera usually looks at an island's middle, which is where its name sits: slide any
   * name the mark would hide down just below it, so both can be seen.
   */
  private clearMark(fx: number, fz: number): void {
    const size = this.canvas.clientWidth;
    for (const { b, fx: lx, fz: lz } of this.labels) {
      const dx = (lx - fx) * size;
      const dy = (lz - fz) * size;
      const halfW = b.offsetWidth / 2 + MARK_R;
      const halfH = b.offsetHeight / 2 + MARK_R;
      const shift = size > 0 && Math.abs(dx) < halfW && Math.abs(dy) < halfH ? halfH - dy + 2 : 0;
      b.style.transform = shift ? `translate(-50%, calc(-50% + ${shift.toFixed(1)}px))` : '';
    }
  }

  private startRename(b: HTMLButtonElement, isl: IslandInfo): void {
    this.renaming = true;
    const input = el('input', 'chart-rename');
    input.type = 'text';
    input.maxLength = 28;
    input.value = isl.name;
    input.style.left = b.style.left;
    input.style.top = b.style.top;
    input.setAttribute('aria-label', 'New name for this island');
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.replace(/\s+/g, ' ').trim();
      this.renaming = false;
      if (keep && name && name !== isl.name) {
        b.textContent = name;
        this.actions.rename(isl.id, name);
      }
      input.replaceWith(b);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    b.replaceWith(input);
    input.focus();
    input.select();
  }
}
