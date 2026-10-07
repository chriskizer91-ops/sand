/**
 * The settings sheet: a short list in plain words. Every change is saved at once and passed
 * to main.ts, which tells the engine (pace, storms) or updates the live preferences that the
 * sky, weather and sound read every frame.
 */
import type { PaceId, QualityId } from '../config';
import type { DayMode, Settings } from '../storage/storage';
import { el, pills, text } from './dom';

export interface SettingsActions {
  changed(key: keyof Settings): void;
  /** Show the first-minute hints again. */
  replayHints(): void;
}

export class SettingsPanel {
  readonly root: HTMLDivElement;
  private refreshers: (() => void)[] = [];

  constructor(
    private s: Settings,
    private actions: SettingsActions,
    touch: boolean,
  ) {
    this.root = el('div', 'sheet-page settings');
    const row = (title: string, help: string, control: HTMLElement) => {
      const r = el('div', 'set-row');
      r.appendChild(text('h3', '', title));
      if (help) r.appendChild(text('p', 'set-help', help));
      r.appendChild(control);
      this.root.appendChild(r);
    };
    const choice = <T extends string>(key: keyof Settings, options: readonly (readonly [T, string])[], get: () => T, put: (v: T) => void) => {
      const p = pills<T>(options, get(), (v) => {
        put(v);
        actions.changed(key);
      });
      this.refreshers.push(() => p.set(get()));
      return p.row;
    };
    const onOff = (key: 'fewerFlashes' | 'sound' | 'cameraDrift' | 'vibration') =>
      choice<'on' | 'off'>(
        key,
        [
          ['on', 'On'],
          ['off', 'Off'],
        ],
        () => (s[key] ? 'on' : 'off'),
        (v) => (s[key] = v === 'on'),
      );

    row(
      'Pace of years',
      'How fast the island’s history runs. Animals and waves always move at real speed.',
      choice<PaceId>(
        'pace',
        [
          ['gentle', 'Gentle · 1 a second'],
          ['normal', 'Normal · 2 a second'],
          ['brisk', 'Brisk · 5 a second'],
        ],
        () => s.pace,
        (v) => (s.pace = v),
      ),
    );
    row(
      'Storms',
      'Storms come in the wet season. Gentle storms knock down less.',
      choice<'normal' | 'gentle'>(
        'gentleStorms',
        [
          ['normal', 'Normal'],
          ['gentle', 'Gentle'],
        ],
        () => (s.gentleStorms ? 'gentle' : 'normal'),
        (v) => (s.gentleStorms = v === 'gentle'),
      ),
    );
    row('Fewer flashes', 'Softer lightning with no bright sky flashes.', onOff('fewerFlashes'));

    const vol = el('input', 'volume');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '100';
    vol.value = String(Math.round(s.volume * 100));
    vol.setAttribute('aria-label', 'Volume');
    vol.addEventListener('input', () => {
      s.volume = Number(vol.value) / 100;
      actions.changed('volume');
    });
    this.refreshers.push(() => (vol.value = String(Math.round(s.volume * 100))));
    const sound = el('div', 'sound-row');
    sound.append(onOff('sound'), vol);
    row('Sound', '', sound);

    row(
      'Sky',
      'Day and night follow a calm 16-minute day.',
      choice<DayMode>(
        'dayMode',
        [
          ['cycle', 'Day and night'],
          ['day', 'Always day'],
          ['golden', 'Golden hour'],
        ],
        () => s.dayMode,
        (v) => (s.dayMode = v),
      ),
    );
    row(
      'Graphics',
      'Lighter runs cooler on a phone. Richer adds detail on a strong device.',
      choice<QualityId>(
        'quality',
        [
          ['auto', 'Auto'],
          ['lighter', 'Lighter'],
          ['richer', 'Richer'],
        ],
        () => s.quality,
        (v) => (s.quality = v),
      ),
    );
    row('Camera drift when idle', 'After a minute without touching, the view drifts to where life is happening.', onOff('cameraDrift'));
    if (touch) row('Vibration', 'A gentle buzz while you pour.', onOff('vibration'));

    const again = text('button', 'wide-btn', 'Show the first-minute hints again');
    again.type = 'button';
    again.addEventListener('click', () => {
      actions.replayHints();
      again.textContent = 'The hints will show again';
    });
    this.root.appendChild(again);
  }

  /** Bring the controls in line with the settings (they can change from elsewhere). */
  refresh(): void {
    for (const r of this.refreshers) r();
  }
}
