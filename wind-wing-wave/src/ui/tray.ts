/**
 * The tool tray, at the bottom within thumb reach (on a landscape phone it moves to the side).
 *
 *   [Look] | [Lava] [Rock] [Sand] [Hands] [Scoop] | [size] [Undo]
 *
 * Look (the eye) comes first: it explains anything you tap, so it should never feel hidden.
 * The size button cycles three named sizes (Pinch, Handful, Armful) that also scale with
 * zoom: zoom out for big land, zoom in for detail. Undo shows how many steps it can take back.
 *
 * Before the first land has cooled the tray holds Lava alone ("Touch the glow"); the rest
 * slides in as soon as it cools. Nothing ever unlocks on a timer.
 */
import type { BrushSize, ToolId } from '../config';
import { el, iconButton, text } from './dom';
import { ICONS, TOOL_ICON, sizeIcon } from './icons';
import { SIZE_NAMES, TOOL_NAMES } from './text';

export interface TrayActions {
  selectTool(t: ToolId): void;
  cycleSize(): void;
  undo(): void;
  click(): void;
}

const KEYS: Record<ToolId, string> = { lava: '1', rock: '2', sand: '3', hands: '4', scoop: '5', look: '6 or hold Space' };
const LAYOUT: readonly (ToolId | '|')[] = ['look', '|', 'lava', 'rock', 'sand', 'hands', 'scoop'];

export class Tray {
  readonly root: HTMLDivElement;
  private tools = new Map<ToolId, HTMLButtonElement>();
  private sizeBtn: HTMLButtonElement;
  private undoBtn: HTMLButtonElement;
  private undoCount: HTMLSpanElement;
  private lastUndo = -1;

  constructor(
    parent: HTMLElement,
    private actions: TrayActions,
  ) {
    this.root = el('div', 'tray');
    this.root.setAttribute('role', 'toolbar');
    this.root.setAttribute('aria-label', 'Tools');
    const tools = el('div', 'tray-tools');
    for (const t of LAYOUT) {
      if (t === '|') {
        tools.appendChild(el('span', 'tray-gap'));
        continue;
      }
      const b = el('button', `tool tool-${t}`, TOOL_ICON[t]);
      b.type = 'button';
      b.title = `${TOOL_NAMES[t]} (${KEYS[t]})`;
      b.setAttribute('aria-label', TOOL_NAMES[t]);
      b.appendChild(text('span', '', TOOL_NAMES[t]));
      b.addEventListener('click', () => {
        actions.click();
        actions.selectTool(t);
      });
      this.tools.set(t, b);
      tools.appendChild(b);
    }
    const side = el('div', 'tray-side');
    this.sizeBtn = el('button', 'tool size');
    this.sizeBtn.type = 'button';
    this.sizeBtn.title = 'Brush size ([ and ])';
    this.sizeBtn.setAttribute('aria-label', 'Brush size');
    this.sizeBtn.addEventListener('click', () => {
      actions.click();
      actions.cycleSize();
    });
    this.undoBtn = iconButton('tool undo', ICONS.undo, 'Undo (Ctrl+Z)', () => {
      actions.click();
      actions.undo();
    });
    this.undoBtn.appendChild(text('span', '', 'Undo'));
    this.undoCount = el('span', 'count');
    this.undoBtn.appendChild(this.undoCount);
    side.append(this.sizeBtn, this.undoBtn);
    this.root.append(tools, side);
    parent.appendChild(this.root);
  }

  setTool(t: ToolId): void {
    for (const [k, b] of this.tools) {
      b.classList.toggle('on', k === t);
      b.setAttribute('aria-pressed', String(k === t));
    }
  }

  setSize(s: BrushSize): void {
    this.sizeBtn.innerHTML = sizeIcon(s);
    this.sizeBtn.appendChild(text('span', '', SIZE_NAMES[s]));
  }

  setUndo(n: number): void {
    if (n === this.lastUndo) return;
    this.lastUndo = n;
    this.undoBtn.disabled = n === 0;
    this.undoCount.textContent = n > 0 ? String(n) : '';
  }

  /** false: Lava alone (before the first land cools); true: every tool, which slide in one by one. */
  setFull(full: boolean): void {
    const arriving = full && this.root.classList.contains('lava-only');
    this.root.classList.toggle('lava-only', !full);
    if (arriving) {
      this.root.classList.add('arrived');
      setTimeout(() => this.root.classList.remove('arrived'), 2000);
    }
  }
}
