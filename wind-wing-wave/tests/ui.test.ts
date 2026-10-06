/**
 * The interface's own logic, without a browser: card pacing, field-guide hints, the first
 * minute, watch mode's choice of view, frame pacing and sharpness, the chart painter, the
 * story filters, the checks page wording, and the save-slot rules.
 */
import { describe, expect, it } from 'vitest';
import { NX, NZ, ORIGIN_X, ORIGIN_Z, PACE_YPS } from '../src/config';
import type { JournalEntry } from '../src/engine/protocol';
import { WorldFields } from '../src/render/fields';
import { CardQueue, type CardEvent, type CardItem } from '../src/ui/cards';
import { chartToWorld, paintChart, worldToChart } from '../src/ui/chart';
import { pageCheckRows } from '../src/ui/checks';
import { DIRECT_HINT_MINUTES, hintLevel, placeYears, speciesRecords } from '../src/ui/guide';
import { firstYears, storyEntries } from '../src/ui/journal';
import { GLOW_LINE, HANDS_AFTER, ISLAND_LINE, JOURNAL_LINE, KEEP_LINE, Onboarding, type OnboardingView } from '../src/ui/onboarding';
import { FramePacer, ResolutionGovernor } from '../src/ui/pacing';
import { TOOL_LINES, formatYear } from '../src/ui/text';
import { WatchDirector } from '../src/ui/watch';
import { fromBase64, isSaveData, nextSlot, orderSlots, sanitizeSettings, toBase64 } from '../src/storage/storage';

const card = (id: number): CardItem => ({ id, year: id * 10, text: `story ${id}`, icon: '', grand: false });

/** Run the queue for `seconds` in small steps, collecting what it shows. */
function run(q: CardQueue, seconds: number, hold = false): { shown: number[]; more: number[]; hides: number } {
  const ev: CardEvent = { more: 0, hide: false };
  const shown: number[] = [];
  const more: number[] = [];
  let hides = 0;
  for (let t = 0; t < seconds; t += 0.05) {
    q.update(0.05, hold, ev);
    if (ev.show) {
      shown.push(ev.show.id);
      more.push(ev.more);
    }
    if (ev.hide) hides++;
  }
  return { shown, more, hides };
}

describe('arrival cards', () => {
  it('show one at a time for about 8 seconds', () => {
    const q = new CardQueue();
    q.push(card(1));
    const a = run(q, 7.5);
    expect(a.shown).toEqual([1]);
    expect(a.hides).toBe(0);
    const b = run(q, 1);
    expect(b.hides).toBe(1);
  });

  it('queue a few, shorten the wait when busy, and fold the rest into "more in your journal"', () => {
    const q = new CardQueue();
    for (let i = 1; i <= 6; i++) q.push(card(i));
    const r = run(q, 60);
    expect(r.shown).toEqual([4, 5, 6]); // the newest three; the older three are folded
    expect(r.more).toEqual([0, 0, 3]);
  });

  it('wait while the journal or menu is open', () => {
    const q = new CardQueue();
    q.push(card(1));
    expect(run(q, 20, true).shown).toEqual([]);
    expect(run(q, 1).shown).toEqual([1]);
  });

  it('a tapped card goes at once and the next follows after a short pause', () => {
    const q = new CardQueue();
    q.push(card(1));
    q.push(card(2));
    run(q, 0.2);
    expect(q.dismiss()).toBe(true);
    const r = run(q, 2);
    expect(r.shown).toEqual([2]);
  });
});

const E = (e: Partial<JournalEntry> & Pick<JournalEntry, 'kind' | 'year'>): JournalEntry => ({ id: 0, headline: false, ...e });

describe('field guide', () => {
  const entries: JournalEntry[] = [
    E({ kind: 'first-land', year: 0 }),
    E({ kind: 'visit', year: 40, species: 3, road: 'sea' }),
    E({ kind: 'arrival', year: 90, species: 5, road: 'wind' }),
    E({ kind: 'visit', year: 120, species: 7, road: 'flight' }),
    E({ kind: 'return', year: 300, species: 3, road: 'sea' }),
    E({ kind: 'lost', year: 500, species: 5 }),
    E({ kind: 'place', year: 60, place: 'beach' }),
    E({ kind: 'place', year: 200, place: 'beach' }),
    E({ kind: 'place', year: 210, place: 'sea-cliff' }),
  ];
  const recs = speciesRecords(entries);

  it('knows who was found, how they came, and who has gone', () => {
    expect(recs.get(3)).toMatchObject({ found: true, firstYear: 300, road: 'sea', visitYear: 40 });
    expect(recs.get(5)).toMatchObject({ found: true, firstYear: 90, road: 'wind', goneSince: 500 });
    expect(recs.get(7)).toMatchObject({ found: false, visitYear: 120 });
    expect(recs.get(9)).toBeUndefined();
  });

  it('hints sharpen: riddle, then the plain need after a visit, then a direct line ~20 minutes later', () => {
    const yps = PACE_YPS.normal;
    expect(hintLevel(recs.get(9), 1000, yps)).toBe(0);
    expect(hintLevel(recs.get(7), 130, yps)).toBe(1);
    expect(hintLevel(recs.get(7), 120 + DIRECT_HINT_MINUTES * 60 * yps - 1, yps)).toBe(1);
    expect(hintLevel(recs.get(7), 120 + DIRECT_HINT_MINUTES * 60 * yps, yps)).toBe(2);
  });

  it('places remember the year they were first recognised', () => {
    const p = placeYears(entries);
    expect(p.get('beach')).toBe(60);
    expect(p.get('sea-cliff')).toBe(210);
    expect(p.has('pond')).toBe(false);
  });
});

describe('story', () => {
  const entries: JournalEntry[] = [
    E({ kind: 'first-land', year: 0 }),
    E({ kind: 'arrival', year: 20, species: 1 }),
    E({ kind: 'storm', year: 400 }),
    E({ kind: 'first', year: 410, first: 'first-tree' }),
    E({ kind: 'age', year: 420, age: 'green' }),
  ];
  it('lists newest first and filters firsts and storms', () => {
    expect(storyEntries(entries, 'all').map((e) => e.year)).toEqual([420, 410, 400, 20, 0]);
    expect(storyEntries(entries, 'firsts').map((e) => e.kind)).toEqual(['age', 'first', 'first-land']);
    expect(storyEntries(entries, 'storms').map((e) => e.year)).toEqual([400]);
  });
  it('stamps firsts with the year they were earned', () => {
    const f = firstYears(entries);
    expect(f.get('first-land')).toBe(0);
    expect(f.get('first-tree')).toBe(410);
  });
  it('writes years plainly', () => {
    expect(formatYear(1204.7)).toBe('Year 1,204');
  });
});

describe('the first minute', () => {
  const view = (): OnboardingView => ({ line: null, key: 0, glow: false, hands: false });
  const step = (o: Onboarding, seconds: number, s: { started: boolean; firstLand: boolean; trayFull: boolean; cameraMoved: boolean }) => {
    const v = view();
    const lines: string[] = [];
    let last = -1;
    for (let t = 0; t < seconds; t += 0.1) {
      o.update(0.1, s, v);
      if (v.line && v.key !== last) lines.push(v.line);
      last = v.key;
    }
    return { lines, v };
  };

  it('glow, then "Your island.", then "Keep building" once the tray is full, each once', () => {
    const seen = new Set<string>();
    const o = new Onboarding(seen, () => undefined);
    let r = step(o, 5, { started: true, firstLand: false, trayFull: false, cameraMoved: false });
    expect(r.lines).toEqual([GLOW_LINE]);
    expect(r.v.glow).toBe(true);
    r = step(o, 6, { started: true, firstLand: true, trayFull: false, cameraMoved: false });
    expect(r.lines).toEqual([ISLAND_LINE]);
    expect(r.v.glow).toBe(false);
    r = step(o, 10, { started: true, firstLand: true, trayFull: true, cameraMoved: true });
    expect(r.lines).toEqual([KEEP_LINE]);
    r = step(o, 10, { started: true, firstLand: true, trayFull: true, cameraMoved: true });
    expect(r.lines).toEqual([]);
    expect(o.sea).toEqual({ island: true, keep: true });
  });

  it('a sea that already has land skips the first lines', () => {
    const o = new Onboarding(new Set(), () => undefined);
    o.setSea({ island: true, keep: true });
    expect(step(o, 10, { started: true, firstLand: true, trayFull: true, cameraMoved: true }).lines).toEqual([]);
  });

  it('one line per tool and one for the journal, the first time only, remembered across seas', () => {
    const remembered: string[] = [];
    const seen = new Set<string>();
    const o = new Onboarding(seen, (k) => remembered.push(k));
    o.setSea({ island: true, keep: true });
    o.toolChosen('sand');
    o.toolChosen('sand');
    o.journalStory(true);
    o.journalStory(true);
    const r = step(o, 20, { started: true, firstLand: true, trayFull: true, cameraMoved: true });
    expect(r.lines).toEqual([TOOL_LINES.sand, JOURNAL_LINE]);
    expect(remembered).toContain('tool-sand');
    expect(remembered).toContain('journal');
    const o2 = new Onboarding(seen, () => undefined);
    o2.setSea({ island: true, keep: true });
    o2.toolChosen('sand');
    expect(step(o2, 5, { started: true, firstLand: true, trayFull: true, cameraMoved: true }).lines).toEqual([]);
  });

  it('shows the two-finger hint after ~30 s if the camera has not moved, and drops it when it does', () => {
    const o = new Onboarding(new Set(), () => undefined);
    o.setSea({ island: true, keep: true });
    let r = step(o, HANDS_AFTER - 2, { started: true, firstLand: true, trayFull: true, cameraMoved: false });
    expect(r.v.hands).toBe(false);
    r = step(o, 3, { started: true, firstLand: true, trayFull: true, cameraMoved: false });
    expect(r.v.hands).toBe(true);
    r = step(o, 0.2, { started: true, firstLand: true, trayFull: true, cameraMoved: true });
    expect(r.v.hands).toBe(false);
  });
});

describe('watch mode', () => {
  it('drifts to fresh activity and stays a while before wandering', () => {
    const d = new WatchDirector();
    const fallback = { x: 0, z: 0, dist: 120 };
    expect(d.focus(0, fallback)).toBe(fallback);
    d.note('arrival', 100, 50, 0);
    expect(d.focus(1, fallback)).toMatchObject({ x: 100, z: 50, dist: 80 });
    // A slightly more interesting thing elsewhere doesn't pull the view away at once...
    d.note('place', -200, 0, 10);
    expect(d.focus(11, fallback)).toMatchObject({ x: 100, z: 50 });
    // ...but after a while it moves on.
    expect(d.focus(70, fallback)).toMatchObject({ x: -200, z: 0, dist: 100 });
    // Lava is exciting enough to pull it over sooner.
    d.note('lava', 300, 300, 75, 1);
    expect(d.focus(76, fallback)).toMatchObject({ x: 300, z: 300, dist: 120 });
  });

  it('forgets old news and falls back to the island', () => {
    const d = new WatchDirector();
    const fallback = { x: 5, z: 6, dist: 120 };
    d.note('growth', 10, 10, 0, 0.5);
    expect(d.focus(1, fallback)).not.toBe(fallback);
    expect(d.focus(2000, fallback)).toBe(fallback);
  });
});

describe('frame pacing and sharpness', () => {
  it('holds 45 fps on a 90 Hz screen and averages it on a 60 Hz one', () => {
    const p = new FramePacer();
    p.cap = 1 / 45;
    let drawn = 0;
    for (let i = 0; i < 90; i++) if (p.tick(1 / 90) >= 0) drawn++;
    expect(drawn).toBe(45);
    drawn = 0;
    for (let i = 0; i < 600; i++) if (p.tick(1 / 60) >= 0) drawn++;
    expect(drawn / 10).toBeGreaterThan(43);
    expect(drawn / 10).toBeLessThan(47);
    p.cap = 0;
    expect(p.tick(1 / 120)).toBeCloseTo(1 / 120);
  });

  it('softens when frames run long, then asks for a lighter tier at the floor', () => {
    const g = new ResolutionGovernor(1, 1.75);
    const changes: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const c = g.frame(0.04, 1 / 45);
      if (c) changes.push(c);
    }
    expect(g.ratio).toBe(1);
    expect(changes[0]).toBe('softer');
    expect(changes).toContain('lighter');
  });

  it('sharpens again after a good stretch, but backs off when that keeps failing', () => {
    const g = new ResolutionGovernor(1, 1.75);
    g.reset(1);
    const runFor = (seconds: number, interval: number): string[] => {
      const changes: string[] = [];
      for (let s = 0; s < seconds; s += interval) {
        const c = g.frame(interval, 1 / 45);
        if (c) changes.push(c);
      }
      return changes;
    };
    expect(runFor(40, 1 / 45)).toContain('sharper');
    const r1 = g.ratio;
    expect(r1).toBeGreaterThan(1);
    expect(runFor(3, 0.05)).toContain('softer'); // a raise that failed soon after
    expect(g.ratio).toBeLessThan(r1);
    // The back-off now waits longer than this before trying to sharpen again.
    expect(runFor(25, 1 / 45)).not.toContain('sharper');
  });

  it('ignores hitches', () => {
    const g = new ResolutionGovernor(1, 2);
    for (let i = 0; i < 100; i++) expect(g.frame(1.5, 1 / 60)).toBeNull();
    expect(g.ratio).toBe(2);
  });
});

describe('chart', () => {
  it('maps world and chart coordinates both ways', () => {
    const w = chartToWorld(0.25, 0.75);
    const c = worldToChart(w.x, w.z);
    expect(c.fx).toBeCloseTo(0.25);
    expect(c.fz).toBeCloseTo(0.75);
    expect(chartToWorld(0, 0)).toEqual({ x: ORIGIN_X, z: ORIGIN_Z });
  });

  it('paints sea blue, land earthy, an ink coast, and every pixel opaque', () => {
    const f = new WorldFields();
    // A round island in the middle.
    for (let k = 0; k < NZ; k++)
      for (let i = 0; i < NX; i++) {
        const d = Math.hypot(i - 256, k - 256);
        f.surf[i + k * NX] = d < 40 ? 20 - d * 0.4 : -20;
      }
    const out = new Uint8ClampedArray(NX * NZ * 4);
    paintChart(f, out);
    const px = (i: number, k: number) => Array.from(out.slice((i + k * NX) * 4, (i + k * NX) * 4 + 4));
    const sea = px(20, 20);
    const land = px(256, 256);
    expect(sea[2]).toBeGreaterThan(sea[0]); // blue over red
    expect(land[0]).toBeGreaterThan(land[2]); // red over blue (earth)
    const coast = px(256 + 39, 256); // the last land pixel, with sea to its right
    expect(coast[0] + coast[1] + coast[2]).toBeLessThan(land[0] + land[1] + land[2]);
    for (let i = 3; i < out.length; i += 4 * 997) expect(out[i]).toBe(255);
  });
});

describe('checks page', () => {
  it('reports in plain words, with information rows that neither pass nor fail', () => {
    const rows = pageCheckRows({
      webgl2: true,
      gpu: 'Mali-G710',
      engine: 'page',
      storage: { where: 'backup', ms: 40, bytes: 1 << 20 },
      fps: 44.6,
      fpsTarget: 45,
      wakeLock: false,
      pixelRatio: 1.5,
      screen: '412×915 at 2.63×',
    });
    expect(rows.find((r) => r.label.includes('3D'))!.pass).toBe(true);
    expect(rows.find((r) => r.label.includes('background thread'))!.pass).toBeNull();
    expect(rows.find((r) => r.label.includes('Saving'))!.detail).toMatch(/backup/);
    expect(rows.find((r) => r.label.includes('Smooth'))!.detail).toMatch(/About 45 frames a second/);
    expect(rows.find((r) => r.label.includes('screen can stay on'))!.pass).toBeNull();
  });
});

describe('saving', () => {
  it('cleans up stored settings from older or edited copies', () => {
    const s = sanitizeSettings({ pace: 'warp', volume: 7, sound: 'yes', quality: 'richer', seen: ['a', 3] });
    expect(s.pace).toBe('normal');
    expect(s.volume).toBe(1);
    expect(s.sound).toBe(true);
    expect(s.quality).toBe('richer');
    expect(s.seen).toEqual(['a']);
  });

  it('only accepts real saves (the engine marks them "WWWS")', () => {
    const good = new Uint8Array(32);
    good.set([0x57, 0x57, 0x57, 0x53]);
    expect(isSaveData(good.buffer)).toBe(true);
    expect(isSaveData(new ArrayBuffer(32))).toBe(false);
    expect(isSaveData(new ArrayBuffer(3))).toBe(false);
    expect(isSaveData(null)).toBe(false);
  });

  it('writes the older slot, so the newest good copy always survives a failed save', () => {
    expect(nextSlot([])).toBe('A');
    expect(nextSlot([{ slot: 'A', time: 5, bytes: 1, year: 0 }])).toBe('B');
    expect(nextSlot([{ slot: 'A', time: 5, bytes: 1, year: 0 }, { slot: 'B', time: 9, bytes: 1, year: 0 }])).toBe('A');
    expect(nextSlot([{ slot: 'A', time: 9, bytes: 1, year: 0 }, { slot: 'B', time: 5, bytes: 1, year: 0 }])).toBe('B');
    const order = orderSlots([{ slot: 'A', time: 5, bytes: 1, year: 0 }, null, { slot: 'B', time: 9, bytes: 1, year: 0 }]);
    expect(order.map((m) => m.slot)).toEqual(['B', 'A']);
  });

  it('round-trips the backup copy through text', () => {
    const b = new Uint8Array(70000);
    for (let i = 0; i < b.length; i++) b[i] = (i * 31) & 255;
    const back = new Uint8Array(fromBase64(toBase64(b.buffer)));
    expect(back.length).toBe(b.length);
    expect(back[69999]).toBe(b[69999]);
    expect(back[12345]).toBe(b[12345]);
  });
});
