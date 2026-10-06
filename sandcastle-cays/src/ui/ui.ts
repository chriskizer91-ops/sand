/** The on-screen buttons, panels and messages (plain HTML on top of the 3D view). */
import { GAME_VERSION, LITRES_PER_CELL, type BrushSize, type DryingSpeed, type ToolId } from '../config';
import type { CheckResult } from '../checks/sandChecks';
import { wetnessWord } from '../engine/material';
import { ICONS, sizeIcon } from './icons';
import type { Settings } from '../storage/storage';

export interface UiActions {
  start(): void;
  selectTool(t: ToolId): void;
  setSize(s: BrushSize): void;
  undo(): void;
  home(): void;
  photo(): void;
  saveFile(): void;
  loadFile(): void;
  newBeach(): void;
  setDrying(d: DryingSpeed): void;
  setSound(on: boolean): void;
  setQuality(q: Settings['quality']): void;
  runChecks(): void;
  click(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (html) e.innerHTML = html;
  return e;
}

const TOOL_LABEL: Record<ToolId, string> = { dig: 'Dig', pile: 'Pile', pat: 'Pat' };
const TOOL_HINT: Record<ToolId, string> = {
  dig: 'Drag on the sand to scoop it into your hands. Near the water the sand is wet and sticky.',
  pile: 'Drag to pour the sand you’re holding: wet sand holds its shape, dry sand slides.',
  pat: 'Tap to pat sand firm (packed sand stands tall). Rub to smooth it.',
};

export class Ui {
  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private sizeBtn!: HTMLButtonElement;
  private handFill!: HTMLDivElement;
  private handLabel!: HTMLSpanElement;
  private toastEl!: HTMLDivElement;
  private toastTimer = 0;
  private hintEl!: HTMLDivElement;
  private undoBtn!: HTMLButtonElement;
  private startEl!: HTMLDivElement;
  private startBtn!: HTMLButtonElement;
  private progressBar!: HTMLDivElement;
  private progressText!: HTMLDivElement;
  private menu!: HTMLDivElement;
  private help!: HTMLDivElement;
  private checks!: HTMLDivElement;
  private checksList!: HTMLDivElement;
  private checksSummary!: HTMLParagraphElement;
  readonly fpsEl: HTMLDivElement;
  private size: BrushSize = 1;
  private lastHand = -1;
  private lastWetWord = '';

  constructor(
    private actions: UiActions,
    private settings: Settings,
  ) {
    const hud = el('div', { id: 'hud' });
    document.body.appendChild(hud);

    // Top bar: what you're holding, undo, camera home, menu.
    const top = el('div', { id: 'topbar' });
    const hand = el('div', { id: 'hand', 'aria-live': 'polite' });
    hand.innerHTML = `${ICONS.bucket}<div class="meter"><div class="fill"></div></div><span class="label"><b>Hands empty</b></span>`;
    this.handFill = hand.querySelector('.fill') as HTMLDivElement;
    this.handLabel = hand.querySelector('.label') as HTMLSpanElement;
    top.appendChild(hand);
    top.appendChild(el('div', { class: 'spacer' }));
    this.undoBtn = this.roundButton(top, ICONS.undo, 'Undo', () => actions.undo());
    this.undoBtn.disabled = true;
    this.roundButton(top, ICONS.home, 'Show the whole beach', () => actions.home());
    this.roundButton(top, ICONS.camera, 'Take a photo', () => actions.photo());
    this.roundButton(top, ICONS.menu, 'Menu', () => this.togglePanel(this.menu));
    hud.appendChild(top);

    // Tool tray.
    const bar = el('div', { id: 'toolbar', role: 'toolbar', 'aria-label': 'Tools' });
    for (const t of ['dig', 'pile', 'pat'] as ToolId[]) {
      const b = el('button', { class: 'tool', 'aria-label': TOOL_LABEL[t] }, `${ICONS[t]}<span>${TOOL_LABEL[t]}</span>`);
      b.addEventListener('click', () => {
        actions.click();
        actions.selectTool(t);
      });
      this.toolButtons.set(t, b);
      bar.appendChild(b);
    }
    this.sizeBtn = el('button', { class: 'tool size', 'aria-label': 'Brush size' });
    this.sizeBtn.addEventListener('click', () => {
      actions.click();
      this.setSize(((this.size + 1) % 3) as BrushSize);
      actions.setSize(this.size);
    });
    bar.appendChild(this.sizeBtn);
    hud.appendChild(bar);
    this.setSize(1);

    this.toastEl = el('div', { id: 'toast', role: 'status' });
    hud.appendChild(this.toastEl);
    this.hintEl = el('div', { id: 'hint', class: 'hide' });
    hud.appendChild(this.hintEl);
    this.fpsEl = el('div', { id: 'fps' });
    document.body.appendChild(this.fpsEl);

    this.buildStart();
    this.buildMenu();
    this.buildHelp();
    this.buildChecks();
  }

  private roundButton(parent: HTMLElement, icon: string, label: string, fn: () => void): HTMLButtonElement {
    const b = el('button', { class: 'round', 'aria-label': label, title: label }, icon);
    b.addEventListener('click', () => {
      this.actions.click();
      fn();
    });
    parent.appendChild(b);
    return b;
  }

  // ---------- start screen ----------

  private buildStart(): void {
    this.startEl = el('div', { id: 'start', class: 'screen' });
    const card = el('div', { class: 'card' });
    card.innerHTML = `
      <h1>Sandcastle Cays</h1>
      <p class="sub">The Calm Lagoon · v${GAME_VERSION}</p>
      <p>Dig wet sand near the water, pile it up, pat it firm. Build anything, as big as you like.</p>
      <p class="small">One finger: use the tool · Two fingers: move the camera<br>Trackpad: click to build · two-finger swipe to look around · pinch to zoom</p>`;
    const prog = el('div', { class: 'progress' }, '<div></div>');
    this.progressBar = prog.firstElementChild as HTMLDivElement;
    this.progressText = el('div', { class: 'small' }, 'Shaping the beach…');
    this.startBtn = el('button', { class: 'big' }, 'Start building') as HTMLButtonElement;
    this.startBtn.disabled = true;
    this.startBtn.addEventListener('click', () => this.actions.start());
    card.append(prog, this.progressText, this.startBtn);
    this.startEl.appendChild(card);
    document.body.appendChild(this.startEl);
  }

  setProgress(done: number, total: number): void {
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    this.progressBar.style.width = `${pct}%`;
    this.progressText.textContent = pct < 100 ? `Shaping the beach… ${pct}%` : 'Ready!';
  }

  setReady(resumed: boolean): void {
    this.setProgress(1, 1);
    this.progressText.textContent = resumed ? 'Your beach is just as you left it.' : 'Ready!';
    this.startBtn.disabled = false;
    this.startBtn.textContent = resumed ? 'Keep building' : 'Start building';
  }

  hideStart(): void {
    this.startEl.classList.add('gone');
    setTimeout(() => (this.startEl.style.display = 'none'), 600);
  }

  // ---------- menu ----------

  private buildMenu(): void {
    this.menu = el('div', { class: 'panel hidden', role: 'dialog', 'aria-label': 'Menu' });
    const s = this.settings;
    const pills = (name: string, opts: [string, string][], current: string, fn: (v: string) => void) => {
      const row = el('div', { class: 'row', 'data-group': name });
      for (const [v, label] of opts) {
        const b = el('button', { class: `pill${v === current ? ' on' : ''}`, 'data-v': v }, label);
        b.addEventListener('click', () => {
          this.actions.click();
          row.querySelectorAll('.pill').forEach((p) => p.classList.toggle('on', p === b));
          fn(v);
        });
        row.appendChild(b);
      }
      return row;
    };
    const h = el('h2', {}, `Menu`);
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => this.togglePanel(this.menu, false));
    h.appendChild(close);
    this.menu.appendChild(h);
    this.menu.appendChild(el('h3', {}, 'Your beach'));
    const save = el('button', { class: 'wide' }, 'Save beach to a file');
    save.addEventListener('click', () => this.actions.saveFile());
    const load = el('button', { class: 'wide' }, 'Load beach from a file');
    load.addEventListener('click', () => this.actions.loadFile());
    this.menu.append(save, load);
    this.menu.appendChild(el('p', { class: 'small' }, 'The game also saves by itself every minute. A file is a safe backup you can keep.'));
    this.menu.appendChild(el('h3', {}, 'Sun (how fast sand dries)'));
    this.menu.appendChild(
      pills('drying', [['off', 'Off'], ['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']], s.drying, (v) =>
        this.actions.setDrying(v as DryingSpeed),
      ),
    );
    this.menu.appendChild(el('h3', {}, 'Sound'));
    this.menu.appendChild(pills('sound', [['on', 'On'], ['off', 'Off']], s.sound ? 'on' : 'off', (v) => this.actions.setSound(v === 'on')));
    this.menu.appendChild(el('h3', {}, 'Graphics'));
    this.menu.appendChild(
      pills('quality', [['auto', 'Auto'], ['fast', 'Smooth'], ['pretty', 'Pretty']], s.quality, (v) =>
        this.actions.setQuality(v as Settings['quality']),
      ),
    );
    this.menu.appendChild(el('h3', {}, 'More'));
    const helpBtn = el('button', { class: 'wide' }, 'How to play');
    helpBtn.addEventListener('click', () => {
      this.togglePanel(this.menu, false);
      this.togglePanel(this.help, true);
    });
    const checkBtn = el('button', { class: 'wide' }, 'Run the checks on this device');
    checkBtn.addEventListener('click', () => {
      this.togglePanel(this.menu, false);
      this.togglePanel(this.checks, true);
      this.actions.runChecks();
    });
    const fresh = el('button', { class: 'wide danger' }, 'Start a fresh beach');
    fresh.addEventListener('click', () => {
      if (confirm('Smooth the whole beach back to how it started? Your current beach will be gone (save it to a file first if you want to keep it).')) {
        this.togglePanel(this.menu, false);
        this.actions.newBeach();
      }
    });
    this.menu.append(helpBtn, checkBtn, fresh);
    this.menu.appendChild(el('p', { class: 'small' }, `Sandcastle Cays v${GAME_VERSION} · made entirely in code`));
    document.body.appendChild(this.menu);
  }

  private buildHelp(): void {
    this.help = el('div', { class: 'panel hidden', role: 'dialog', 'aria-label': 'How to play' });
    this.help.innerHTML = `
      <h2>How to play</h2>
      <h3>Tools</h3>
      <ul>
        <li><b>Dig</b>: drag on the sand to scoop it into your hands. Dig near the water, or dig down a little, for damp sand.</li>
        <li><b>Pile</b>: drag to pour what you're holding. Damp sand holds its shape, dry sand slides into soft cones.</li>
        <li><b>Pat</b>: tap to pack sand firm (packed damp sand stands tall and holds tunnels). Rub to smooth.</li>
        <li><b>Size</b>: small, medium or large hands.</li>
      </ul>
      <h3>Phone</h3>
      <ul>
        <li>One finger: use the tool</li>
        <li>Two fingers: drag to swing around, pinch to zoom</li>
        <li>Quick two-finger tap: glide over to that spot</li>
      </ul>
      <h3>Laptop</h3>
      <ul>
        <li>Click and drag: use the tool</li>
        <li>Two-finger swipe (or right-drag): swing around</li>
        <li>Pinch or mouse wheel: zoom · Right-click: glide there</li>
        <li>Keys: W A S D to move, Q E to turn, 1 2 3 tools, [ ] size, Ctrl+Z undo</li>
      </ul>
      <h3>Sand tips</h3>
      <ul>
        <li>The sun dries the outside of your castle. Dried edges crumble unless they were patted firm.</li>
        <li>Holes dug below the sea level fill with water.</li>
        <li>Tunnels hold in packed, damp sand. In dry sand they cave in.</li>
      </ul>`;
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => this.togglePanel(this.help, false));
    this.help.querySelector('h2')!.appendChild(close);
    document.body.appendChild(this.help);
  }

  private buildChecks(): void {
    this.checks = el('div', { class: 'panel hidden', role: 'dialog', 'aria-label': 'Checks' });
    const h = el('h2', {}, 'Checks on this device');
    const close = el('button', { class: 'round', style: 'width:36px;height:36px;box-shadow:none', 'aria-label': 'Close' }, ICONS.close);
    close.addEventListener('click', () => this.togglePanel(this.checks, false));
    h.appendChild(close);
    this.checksSummary = el('p', {}, '');
    this.checksList = el('div', {});
    const again = el('button', { class: 'wide' }, 'Run again');
    again.addEventListener('click', () => this.actions.runChecks());
    this.checks.append(h, this.checksSummary, this.checksList, again);
    document.body.appendChild(this.checks);
  }

  showChecksRunning(): void {
    this.checksSummary.innerHTML = '<span class="wait">Running… (about 20 seconds)</span>';
    this.checksList.innerHTML = '';
  }

  showChecks(results: CheckResult[], extra: { label: string; pass: boolean | null; detail: string }[]): void {
    const all = [...results.map((r) => ({ label: r.name, pass: r.pass as boolean | null, detail: r.detail })), ...extra];
    const failed = all.filter((r) => r.pass === false).length;
    this.checksSummary.innerHTML =
      failed === 0
        ? `<b class="ok">All ${all.length} checks passed on this device.</b>`
        : `<b class="bad">${failed} of ${all.length} checks failed.</b> Please send a screenshot of this list.`;
    this.checksList.innerHTML = '';
    for (const r of all) {
      const row = el('div', { class: 'check' });
      const mark = r.pass === null ? '<span class="mark wait">…</span>' : r.pass ? '<span class="mark ok">✓</span>' : '<span class="mark bad">✗</span>';
      row.innerHTML = `${mark}<div>${r.label}<div class="d">${r.detail}</div></div>`;
      this.checksList.appendChild(row);
    }
  }

  togglePanel(p: HTMLDivElement, show?: boolean): void {
    const willShow = show ?? p.classList.contains('hidden');
    for (const other of [this.menu, this.help, this.checks]) if (other !== p) other.classList.add('hidden');
    p.classList.toggle('hidden', !willShow);
  }

  closePanels(): void {
    for (const p of [this.menu, this.help, this.checks]) p.classList.add('hidden');
  }

  // ---------- live state ----------

  setTool(t: ToolId): void {
    for (const [k, b] of this.toolButtons) {
      b.classList.toggle('on', k === t);
      b.setAttribute('aria-pressed', String(k === t));
    }
  }

  setSize(s: BrushSize): void {
    this.size = s;
    this.sizeBtn.innerHTML = `${sizeIcon(s)}<span>${['Small', 'Medium', 'Large'][s]}</span>`;
  }

  setHand(amount: number, capacity: number, wet: number): void {
    const litres = (amount / 255) * LITRES_PER_CELL;
    const rounded = Math.round(litres * 10);
    const word = wetnessWord(wet);
    if (rounded === this.lastHand && word === this.lastWetWord) return;
    this.lastHand = rounded;
    this.lastWetWord = word;
    const pct = Math.min(100, (amount / capacity) * 100);
    this.handFill.style.width = `${pct}%`;
    this.handFill.style.background = wet > 150 ? '#b8975f' : wet > 60 ? '#cfb07a' : '#ecd9ae';
    if (amount < 1) this.handLabel.innerHTML = '<b>Hands empty</b>';
    else {
      const l = litres < 1 ? litres.toFixed(1) : Math.round(litres).toString();
      this.handLabel.innerHTML = `<b>${l} L</b> of ${word} sand${pct >= 99.5 ? ' (full)' : ''}`;
    }
  }

  setUndo(count: number): void {
    this.undoBtn.disabled = count === 0;
  }

  toast(msg: string, ms = 2200): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), ms);
  }

  hint(t: ToolId | null): void {
    if (!t) {
      this.hintEl.classList.add('hide');
      return;
    }
    this.hintEl.textContent = TOOL_HINT[t];
    this.hintEl.classList.remove('hide');
  }
}
