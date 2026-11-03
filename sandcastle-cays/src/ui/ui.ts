/** The on-screen buttons, panels and messages (plain HTML on top of the 3D view). */
import { BASKET_CAPACITY, GAME_VERSION, LITRES_PER_CELL, type BrushSize, type DryingSpeed, type ToolId } from '../config';
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
  logbook(): void;
  chart(): void;
  newGame(): void;
  devTools(): void;
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
    this.undoBtn.dataset.build = '1';
    this.roundButton(top, ICONS.home, 'Show the whole beach', () => actions.home()).dataset.build = '1';
    this.roundButton(top, ICONS.chart, 'Chart', () => actions.chart()).dataset.fp = '1';
    this.roundButton(top, ICONS.book, 'Logbook', () => actions.logbook()).dataset.fp = '1';
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
      <p class="sub">First passage · v${GAME_VERSION}</p>
      <p>You live aboard a little sailboat at anchor off Home Cay. Swim ashore, comb the beaches for what the sea washed up, build in the sand, and sail out through the reef to Pink Sand Cay.</p>
      <p class="small">Phone: left thumb to walk · right thumb to look · tap things to pick them up<br>Laptop: W A S D to walk · mouse or trackpad to look · E to pick up · Space to jump</p>`;
    const prog = el('div', { class: 'progress' }, '<div></div>');
    this.progressBar = prog.firstElementChild as HTMLDivElement;
    this.progressText = el('div', { class: 'small' }, 'Shaping the island…');
    this.startBtn = el('button', { class: 'big' }, 'Go aboard') as HTMLButtonElement;
    this.startBtn.disabled = true;
    this.startBtn.addEventListener('click', () => this.actions.start());
    card.append(prog, this.progressText, this.startBtn);
    this.startEl.appendChild(card);
    document.body.appendChild(this.startEl);
  }

  setProgress(done: number, total: number): void {
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    this.progressBar.style.width = `${pct}%`;
    this.progressText.textContent = pct < 100 ? `Shaping the island… ${pct}%` : 'Ready!';
  }

  setReady(resumed: boolean): void {
    this.setProgress(1, 1);
    this.progressText.textContent = resumed ? 'Everything is just as you left it.' : 'Ready!';
    this.startBtn.disabled = false;
    this.startBtn.textContent = resumed ? 'Carry on' : 'Go aboard';
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
    this.menu.appendChild(el('h3', {}, 'Your game'));
    const save = el('button', { class: 'wide' }, 'Save to a file');
    save.addEventListener('click', () => this.actions.saveFile());
    const load = el('button', { class: 'wide' }, 'Load from a file');
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
    const fresh = el('button', { class: 'wide danger' }, 'Smooth the cove’s sand');
    fresh.addEventListener('click', () => {
      this.askSure('Smooth the cove’s sand back to how it started? Your sandcastles will be gone (your finds and logbook stay).', 'Smooth it', () => {
        this.togglePanel(this.menu, false);
        this.actions.newBeach();
      });
    });
    const over = el('button', { class: 'wide danger' }, 'Start over completely');
    over.addEventListener('click', () => {
      this.askSure('Start a whole new game? Your castles, finds and logbook will all be gone (save to a file first if you want to keep them).', 'Start over', () => {
        this.togglePanel(this.menu, false);
        this.actions.newGame();
      });
    });
    const devBtn = el('button', { class: 'wide' }, 'Dev tools (for trying things out)');
    devBtn.addEventListener('click', () => {
      this.togglePanel(this.menu, false);
      this.actions.devTools();
    });
    this.menu.append(helpBtn, checkBtn, devBtn, fresh, over);
    this.menu.appendChild(el('p', { class: 'small' }, `Sandcastle Cays v${GAME_VERSION} · made entirely in code`));
    document.body.appendChild(this.menu);
  }

  private buildHelp(): void {
    this.help = el('div', { class: 'panel hidden', role: 'dialog', 'aria-label': 'How to play' });
    this.help.innerHTML = `
      <h2>How to play</h2>
      <h3>Getting about</h3>
      <ul>
        <li><b>Phone</b>: put your left thumb down anywhere on the left and slide it to walk (push it all the way to run). Drag with your right thumb to look. Tap a find to pick it up. The round button does what the label says; the arrow jumps.</li>
        <li><b>Laptop</b>: click once so the mouse turns your head (Esc lets go). W A S D or arrows to walk, Shift to run, Space to jump, E (or click) to pick up and use, L for the logbook.</li>
        <li><b>Leaving the boat</b>: walk to the swim ladder at the stern (the back of the boat). Climb back up the same ladder. You can also jump over the side.</li>
      </ul>
      <h3>Sailing</h3>
      <ul>
        <li><b>Take the helm</b> in the cockpit (E, or the round button). Steer with A and D (phone: your left thumb). W and S raise and lower the sails (phone: “More sail” and “Less sail”). X drops or raises the anchor. E lets go.</li>
        <li><b>The outboard</b>: R for more motor, F for less (and on into reverse). It does about 5 knots, much slower than sailing. Use it to get out of irons, through the gap in the reef, up to an anchorage, or backwards off a sandbank. It goes off when you let go of the tiller.</li>
        <li>You can’t sail straight into the wind. If the sails flap and you slow down (“in irons”), turn away from the wind. To go upwind, zig-zag. The little dial shows where the wind comes from; the red wedge is where you can’t sail.</li>
        <li>You’re fastest with the wind from the side. The reef around Home Cay has one gap, to the south-west: hitting the reef scrapes the hull.</li>
        <li><b>Aground?</b> Motor astern and steer for deeper water, or tap “Push off” (X on a laptop; it’s the anchor button while you’re aground) and you’ll push her off into deeper water.</li>
        <li><b>The chart</b> (M, or the map button) shows where you are. Tap a place and she sails there by herself and anchors.</li>
        <li><b>The open sea</b>: out past the reefs the wind is stronger and a long swell rolls in. Run before the waves with the wind behind you and she surfs. If she leans too far and turns up into the wind by herself, she’s overpowered: take in sail (half sail) or steer away from the wind.</li>
        <li><b>Squalls</b> are the dark clouds with rain hanging under them, drifting west. Sail into one for a burst of wind and rain (take in sail first!). They pass in a minute or two.</li>
        <li><b>The sea buoy</b> is the red-and-white buoy out to the south-east. Sail out round it and back to anchor at Home Cay, and your time goes in the logbook.</li>
      </ul>
      <h3>Living aboard</h3>
      <ul>
        <li><b>Stores</b>: the bowl and the drop at the top show how many days of food and water you have. You use a day of each every day. Run out and you’re slower until you top up. Tap them (or go below to the galley) for more.</li>
        <li><b>Fishing</b>: tap the rod button (G on a laptop) on deck or on the shore, face the water and cast. When the float dips, strike quickly! Then hold to reel in, and ease off when the line goes red or it snaps. Different fish bite in different places: try the shallow flats, the lagoon, and out on the open sea.</li>
        <li><b>The galley</b> is down the companionway, at the front of the cockpit. Cook your fish there (fresh fish keeps a day and a half), and open coconuts from the locker.</li>
        <li><b>Water</b>: rain runs off the awning into the tank at anchor (and off the mainsail when sailing). Sail to meet a squall and anchor under it!</li>
        <li><b>Coconuts</b>: shake a palm on the beach and one or two fall. Pick them up like any find.</li>
        <li><b>Upkeep</b>: a badly scraped hull leaks, so pump the bilge (the pump is in the cockpit). Sailing hard when she’s overpowered wears the sails. Mend both at the <b>workbench</b> on the stern, with finds from the locker. New finds give you new ideas there: a bigger rain catcher, water jugs, a lure, a fish trap.</li>
      </ul>
      <h3>The garden</h3>
      <ul>
        <li><b>Pots</b> on the cabin top, and <b>beds</b> in the Home Cay garden (just up the grass from the sandcastle cove). Walk up to one and press E (or tap) to plant from your seed tin.</li>
        <li>Water every day: pots from the boat’s tank, beds from the rain barrel. Rain waters them too. A plant only grows on days it has water, and withers after three dry days.</li>
        <li>Harvest when ripe: food for the larder and seeds back. Callaloo grows back after you cut it. Make more pots at the workbench.</li>
      </ul>
      <h3>Dev tools</h3>
      <ul>
        <li>Press T on a laptop (or Menu → Dev tools) for a window that shows what the game is doing, with buttons to move the boat, call up a squall, change the wind, the time and the game’s speed.</li>
      </ul>
      <h3>Beachcombing</h3>
      <ul>
        <li>Every morning the sea leaves new things along the high-tide line: shells, sea glass, driftwood, rope, sea beans and more.</li>
        <li>Your basket holds ${BASKET_CAPACITY}. Empty it into the locker in the boat’s cockpit. The logbook keeps every kind you’ve found.</li>
      </ul>
      <h3>Building (kneel on the cove’s sand)</h3>
      <ul>
        <li><b>Dig</b>: drag on the sand to scoop it into your hands. Dig near the water, or dig down a little, for damp sand.</li>
        <li><b>Pile</b>: drag to pour what you're holding. Damp sand holds its shape, dry sand slides into soft cones.</li>
        <li><b>Pat</b>: tap to pack sand firm (packed damp sand stands tall and holds tunnels). Rub to smooth.</li>
        <li><b>Size</b>: small, medium or large hands.</li>
      </ul>
      <h3>Phone, while building</h3>
      <ul>
        <li>One finger: use the tool</li>
        <li>Two fingers: drag to swing around, pinch to zoom</li>
        <li>Quick two-finger tap: glide over to that spot</li>
      </ul>
      <h3>Laptop, while building</h3>
      <ul>
        <li>Click and drag: use the tool</li>
        <li>Two-finger swipe (or right-drag): swing around</li>
        <li>Pinch or mouse wheel: zoom · Right-click: glide there</li>
        <li>Keys: W A S D to move, Q E to turn, 1 2 3 tools, [ ] size, Ctrl+Z undo, Esc or B to stand up</li>
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

  /** An "are you sure?" box drawn in the page (browser pop-ups are blocked inside the claude.ai link). */
  askSure(question: string, yesLabel: string, yes: () => void): void {
    const back = el('div', { class: 'screen sure', role: 'dialog', 'aria-label': 'Are you sure?' });
    const card = el('div', { class: 'card' });
    card.appendChild(el('p', {}, question));
    const row = el('div', { class: 'row', style: 'justify-content:center;margin-top:12px' });
    const no = el('button', { class: 'pill' }, 'Keep it');
    const ok = el('button', { class: 'pill on' }, yesLabel);
    no.addEventListener('click', () => {
      this.actions.click();
      back.remove();
    });
    ok.addEventListener('click', () => {
      this.actions.click();
      back.remove();
      yes();
    });
    row.append(no, ok);
    card.appendChild(row);
    back.appendChild(card);
    document.body.appendChild(back);
  }

  get panelOpen(): boolean {
    return [this.menu, this.help, this.checks].some((p) => !p.classList.contains('hidden'));
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
