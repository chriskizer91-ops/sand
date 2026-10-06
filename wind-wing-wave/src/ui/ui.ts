/**
 * The on-screen interface (WP-H): tool tray, cards, journal (Story / Life & Places / Chart),
 * menu, settings, onboarding, watch-mode fade, Look results, checks page.
 * STUB (lead): a bare tool row, a loading line, toasts and cards. WP-H replaces it (and main.ts wiring).
 */
import { GAME_TITLE, type ToolId } from '../config';
import type { SpeciesDef } from '../content/speciesTypes';
import { entryText } from '../content/stories';
import type { JournalEntry } from '../engine/protocol';

export interface UiActions {
  start(): void;
  selectTool(t: ToolId): void;
  undo(): void;
  glideTo(x: number, z: number): void;
}

const TOOLS: ToolId[] = ['lava', 'rock', 'sand', 'hands', 'scoop', 'look'];

export class Ui {
  private root: HTMLDivElement;
  private status: HTMLDivElement;
  private cards: HTMLDivElement;
  private buttons = new Map<ToolId, HTMLButtonElement>();

  constructor(
    private actions: UiActions,
    private species: readonly SpeciesDef[],
  ) {
    this.root = document.getElementById('hud') as HTMLDivElement;
    this.status = document.createElement('div');
    this.status.style.cssText = 'position:absolute;top:12px;left:12px;padding:8px 12px;border-radius:12px;background:rgba(255,252,245,.9);font:600 14px system-ui';
    this.status.textContent = `${GAME_TITLE}: loading…`;
    this.root.appendChild(this.status);
    this.cards = document.createElement('div');
    this.cards.style.cssText = 'position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;max-width:90vw';
    this.root.appendChild(this.cards);
    const tray = document.createElement('div');
    tray.style.cssText = 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;gap:6px;padding:6px;border-radius:20px;background:rgba(255,252,245,.92)';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.textContent = t;
      b.style.cssText = 'padding:10px 12px;border-radius:14px;font:700 13px system-ui';
      b.onclick = () => actions.selectTool(t);
      this.buttons.set(t, b);
      tray.appendChild(b);
    }
    const undo = document.createElement('button');
    undo.textContent = 'undo';
    undo.style.cssText = 'padding:10px 12px;border-radius:14px;font:700 13px system-ui';
    undo.onclick = () => actions.undo();
    tray.appendChild(undo);
    this.root.appendChild(tray);
  }

  setProgress(done: number, total: number): void {
    this.status.textContent = `${GAME_TITLE}: loading ${Math.round((100 * done) / Math.max(1, total))}%`;
  }

  setReady(): void {
    this.status.textContent = GAME_TITLE;
    this.actions.start();
  }

  setTool(t: ToolId): void {
    for (const [k, b] of this.buttons) b.style.background = k === t ? '#2fb5b0' : '';
  }

  setYear(year: number): void {
    this.status.textContent = `${GAME_TITLE} · Year ${year}`;
  }

  journal(entries: JournalEntry[]): void {
    for (const e of entries) {
      if (!e.headline) continue;
      const c = document.createElement('button');
      c.style.cssText = 'padding:8px 12px;border-radius:12px;background:#fffcf5;font:14px system-ui;text-align:left;box-shadow:0 4px 12px rgba(0,0,0,.15)';
      c.textContent = `Year ${e.year} · ${entryText(e, this.species, () => 'your island')}`;
      c.onclick = () => {
        if (e.x !== undefined && e.z !== undefined) this.actions.glideTo(e.x, e.z);
        c.remove();
      };
      this.cards.prepend(c);
      setTimeout(() => c.remove(), 8000);
    }
  }

  toast(text: string): void {
    this.journal([{ id: -1, year: 0, kind: 'hint', headline: true, params: { text } }]);
  }
}
