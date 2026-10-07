/**
 * "Run the checks on this device": the same land and life checks as `npm test` (run by the
 * engine), plus checks only the real device can answer: 3D graphics, the background thread,
 * saving, how smooth it runs, whether the screen can stay awake (asked for for real, since a
 * browser can have the feature and still say no), and the detail level. Everything is reported
 * in plain words so the owner can send a screenshot if something fails.
 */
import type { CheckResult } from '../checks/registry';
import type { StorageTest } from '../storage/storage';
import { el, text } from './dom';
import { capitalise } from './text';
import type { WakeProbe } from './watch';

export interface CheckRow {
  label: string;
  /** null = for information only (neither pass nor fail). */
  pass: boolean | null;
  detail: string;
}

/** Facts gathered on the page (main.ts measures them). */
export interface PageFacts {
  webgl2: boolean;
  gpu: string;
  engine: 'worker' | 'page' | 'none';
  storage: StorageTest;
  /** Measured frames per second over a few seconds. */
  fps: number;
  /** The frame rate the game aims for on this device. */
  fpsTarget: number;
  /** What happened when the checks asked to keep the screen on. */
  wakeLock: WakeProbe;
  pixelRatio: number;
  screen: string;
  /** The detail tier drawn now, and the one the Graphics setting asks for (0 light .. 2 rich). */
  tier: 0 | 1 | 2;
  chosenTier: 0 | 1 | 2;
}

const TIER_WORDS = ['light', 'standard', 'rich'] as const;

const WAKE_WORDS: Record<WakeProbe, string> = {
  granted: 'Yes: the browser agreed to keep the screen on.',
  refused: 'The browser said no just now (battery saver, or not allowed for a page opened this way). The screen may dim while you watch.',
  unavailable: 'Not in this browser: the screen may dim while you watch.',
};

export function pageCheckRows(f: PageFacts): CheckRow[] {
  const mb = (f.storage.bytes / (1 << 20)).toFixed(1);
  const fps = Math.round(f.fps);
  return [
    {
      label: '3D graphics work',
      pass: f.webgl2,
      detail: f.webgl2 ? `WebGL 2 on ${f.gpu}` : `This browser has no WebGL 2 (${f.gpu}). The game needs it.`,
    },
    {
      label: 'The island runs on a background thread',
      pass: f.engine === 'worker' ? true : f.engine === 'page' ? null : false,
      detail:
        f.engine === 'worker'
          ? 'Yes, which keeps the screen smooth.'
          : f.engine === 'page'
            ? 'No: it runs on the page here. It still works, but may be less smooth.'
            : 'The island engine did not start.',
    },
    {
      label: 'Saving works in this browser',
      pass: f.storage.where !== 'none',
      detail:
        f.storage.where === 'browser'
          ? `Yes: wrote and read back ${mb} MB in ${Math.round(f.storage.ms)} ms.`
          : f.storage.where === 'backup'
            ? `Yes, in the smaller backup storage (${mb} MB in ${Math.round(f.storage.ms)} ms). Save to a file now and then to be safe.`
            : 'No. Use "Save to a file" in the menu to keep your sea.',
    },
    {
      label: 'Smooth on this device',
      pass: fps >= 25,
      detail: `About ${fps} frames a second (it aims for ${Math.round(f.fpsTarget)} here; 30 or more feels smooth).`,
    },
    {
      label: 'The screen can stay on while you watch',
      pass: null,
      detail: WAKE_WORDS[f.wakeLock],
    },
    {
      label: 'Detail level',
      pass: null,
      detail:
        f.tier === f.chosenTier
          ? `${capitalise(TIER_WORDS[f.tier])}, as the Graphics setting asks.`
          : `${capitalise(TIER_WORDS[f.tier])} for now: lowered from ${TIER_WORDS[f.chosenTier]} to keep things smooth. It goes back up by itself when the device keeps up.`,
    },
    {
      label: 'Graphics chip and screen',
      pass: null,
      detail: `${f.gpu} · ${f.screen} · sharpness ${f.pixelRatio.toFixed(2)}×`,
    },
  ];
}

export function engineCheckRows(results: readonly CheckResult[]): CheckRow[] {
  return results.map((r) => ({ label: r.label, pass: r.pass, detail: r.detail }));
}

export class ChecksPage {
  readonly root: HTMLDivElement;
  private summary: HTMLParagraphElement;
  private list: HTMLDivElement;
  private again: HTMLButtonElement;
  private running = false;

  constructor(run: () => void) {
    this.root = el('div', 'sheet-page checks');
    this.summary = text('p', 'checks-summary', '');
    this.list = el('div', 'checks-list');
    this.again = text('button', 'wide-btn', 'Run again');
    this.again.type = 'button';
    this.again.addEventListener('click', () => {
      if (!this.running) run();
    });
    this.root.append(this.summary, this.list, this.again);
  }

  get busy(): boolean {
    return this.running;
  }

  showRunning(): void {
    this.running = true;
    this.summary.className = 'checks-summary wait';
    this.summary.textContent = 'Checking… (about 10 seconds; keep the game open)';
    this.list.textContent = '';
    this.again.disabled = true;
  }

  show(rows: readonly CheckRow[]): void {
    this.running = false;
    this.again.disabled = false;
    const failed = rows.filter((r) => r.pass === false).length;
    const counted = rows.filter((r) => r.pass !== null).length;
    this.summary.className = `checks-summary ${failed ? 'bad' : 'ok'}`;
    this.summary.textContent = failed
      ? `${failed} of ${counted} checks failed. Please send a screenshot of this page.`
      : `All ${counted} checks passed on this device.`;
    this.list.textContent = '';
    for (const r of rows) {
      const row = el('div', 'check-row');
      const mark = text('span', `mark ${r.pass === null ? 'info' : r.pass ? 'ok' : 'bad'}`, r.pass === null ? 'i' : r.pass ? '✓' : '✗');
      const body = el('div');
      body.append(text('div', 'check-label', r.label), text('div', 'check-detail', r.detail));
      row.append(mark, body);
      this.list.appendChild(row);
    }
  }
}
