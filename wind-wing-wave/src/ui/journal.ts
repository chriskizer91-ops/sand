/**
 * The journal: a full-screen field notebook with three tabs (time stops while it is open).
 *
 *   Story          everything that happened, newest first, each with its year and a button
 *                  that glides the camera there. Firsts and Ages are stamps. Filters: All,
 *                  Firsts, Storms. A gentle "keep a copy" note appears when a new Age begins.
 *   Life & Places  the field guide (guide.ts).
 *   Chart          the map of your sea (chart.ts).
 *
 * The year is shown here and on the cards, nowhere else.
 */
import { FIRSTS, ageName, entryText, firstName } from '../content/stories';
import type { SpeciesDef } from '../content/speciesTypes';
import type { JournalEntry, LifeInfo } from '../engine/protocol';
import type { WorldFields } from '../render/fields';
import { ChartPage } from './chart';
import { el, iconButton, pills, text } from './dom';
import { GuidePage } from './guide';
import { ICONS, roadIcon } from './icons';
import { formatYear, yearNumber } from './text';

export type JournalTab = 'story' | 'guide' | 'chart';
export type StoryFilter = 'all' | 'firsts' | 'storms';

/** How many story rows are drawn at once ("Show older pages" adds more). */
const PAGE_ROWS = 120;

export function isStamp(e: JournalEntry): boolean {
  return e.kind === 'first' || e.kind === 'first-land' || e.kind === 'age' || e.kind === 'ending';
}

/** Story entries for a filter, newest first. */
export function storyEntries(entries: readonly JournalEntry[], filter: StoryFilter): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (filter === 'firsts' && !isStamp(e)) continue;
    if (filter === 'storms' && e.kind !== 'storm') continue;
    out.push(e);
  }
  return out;
}

/** The year each First was earned (from 'first' entries, plus first land). */
export function firstYears(entries: readonly JournalEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    const key = e.kind === 'first-land' ? 'first-land' : e.kind === 'first' ? e.first : undefined;
    if (key && !out.has(key)) out.set(key, e.year);
  }
  return out;
}

/** The icon beside a story line. */
export function entryIcon(e: JournalEntry): string {
  if (e.road) return roadIcon(e.road);
  switch (e.kind) {
    case 'storm':
      return ICONS.storm;
    case 'age':
    case 'ending':
      return ICONS.age;
    case 'first':
    case 'milestone':
    case 'moment':
      return ICONS.star;
    case 'place':
      return ICONS.pin;
    case 'first-land':
    case 'new-island':
    case 'islands-joined':
    case 'island-lost':
    case 'lava-buried':
      return ICONS.land;
    default:
      return ICONS.journal;
  }
}

export interface JournalActions {
  close(): void;
  glideTo(x: number, z: number): void;
  flyTo(x: number, z: number): void;
  rename(island: number, name: string): void;
  saveFile(): void;
  pageTurn(): void;
}

export class Journal {
  readonly root: HTMLDivElement;
  private sub: HTMLParagraphElement;
  private tabs = new Map<JournalTab, HTMLButtonElement>();
  private pages = new Map<JournalTab, HTMLElement>();
  private story: HTMLDivElement;
  private nudgeEl: HTMLDivElement;
  private stampsEl: HTMLDivElement;
  private listEl: HTMLDivElement;
  private moreBtn: HTMLButtonElement;
  readonly guide: GuidePage;
  readonly chart: ChartPage;
  private tab: JournalTab = 'story';
  private filter: StoryFilter = 'all';
  private rows = PAGE_ROWS;
  private dirty = true;
  private isOpen = false;

  // What the pages draw from (kept up to date by the Ui).
  entries: JournalEntry[] = [];
  life: LifeInfo | null = null;
  year = 0;
  yps = 2;
  camX = 0;
  camZ = 0;
  camYaw = 0;

  constructor(
    parent: HTMLElement,
    private species: readonly SpeciesDef[],
    fields: WorldFields,
    private actions: JournalActions,
  ) {
    this.root = el('div', 'journal');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Journal');
    const head = el('header', 'j-head');
    const title = el('div', 'j-title');
    title.appendChild(text('h1', '', 'Journal'));
    this.sub = text('p', 'j-sub', '');
    title.appendChild(this.sub);
    const nav = el('nav', 'j-tabs');
    const tabNames: [JournalTab, string, string][] = [
      ['story', 'Story', ICONS.journal],
      ['guide', 'Life & Places', ICONS.look],
      ['chart', 'Chart', ICONS.chart],
    ];
    for (const [t, name, icon] of tabNames) {
      const b = el('button', 'j-tab', icon);
      b.appendChild(text('span', '', name));
      b.type = 'button';
      b.addEventListener('click', () => this.show(t));
      this.tabs.set(t, b);
      nav.appendChild(b);
    }
    const close = iconButton('round j-close', ICONS.close, 'Back to the island', () => actions.close());
    head.append(title, nav, close);

    // Story.
    this.story = el('div', 'j-page story');
    this.nudgeEl = el('div', 'nudge');
    this.nudgeEl.appendChild(text('p', '', 'A new age began. Keep a copy of your sea, in case this browser forgets it.'));
    this.nudgeEl.appendChild(iconButton('wide-btn', ICONS.save, 'Save a copy to a file', () => actions.saveFile(), true));
    this.stampsEl = el('div', 'stamps');
    const filters = pills<StoryFilter>(
      [
        ['all', 'All'],
        ['firsts', 'Firsts'],
        ['storms', 'Storms'],
      ],
      'all',
      (f) => {
        this.filter = f;
        this.rows = PAGE_ROWS;
        this.renderStory();
      },
    );
    filters.row.classList.add('filters');
    this.listEl = el('div', 'entries');
    this.moreBtn = text('button', 'more-btn', 'Show older pages');
    this.moreBtn.type = 'button';
    this.moreBtn.addEventListener('click', () => {
      this.rows += PAGE_ROWS;
      this.renderStory();
    });
    this.story.append(this.nudgeEl, this.stampsEl, filters.row, this.listEl, this.moreBtn);

    this.guide = new GuidePage(species);
    this.chart = new ChartPage(fields, { flyTo: actions.flyTo, rename: actions.rename });
    this.pages.set('story', this.story);
    this.pages.set('guide', this.guide.root);
    this.pages.set('chart', this.chart.root);
    const pagesBox = el('div', 'j-pages');
    pagesBox.append(this.story, this.guide.root, this.chart.root);
    this.root.append(head, pagesBox);
    parent.appendChild(this.root);
    this.show('story', false);
  }

  get open(): boolean {
    return this.isOpen;
  }
  get currentTab(): JournalTab {
    return this.tab;
  }

  setOpen(on: boolean, tab?: JournalTab): void {
    this.isOpen = on;
    this.root.classList.toggle('open', on);
    if (on) {
      if (tab) this.show(tab, false);
      this.dirty = true;
      this.refresh();
    }
  }

  /** Something the pages show has changed. */
  touch(): void {
    this.dirty = true;
  }

  setNudge(on: boolean): void {
    this.nudgeEl.classList.toggle('on', on);
  }

  show(t: JournalTab, sound = true): void {
    if (sound && t !== this.tab) this.actions.pageTurn();
    this.tab = t;
    for (const [k, b] of this.tabs) {
      b.classList.toggle('on', k === t);
      b.setAttribute('aria-selected', String(k === t));
    }
    for (const [k, p] of this.pages) p.classList.toggle('on', k === t);
    this.dirty = true;
    this.refresh();
  }

  /** Redraw the open page if anything changed (called a few times a second at most). */
  refresh(): void {
    if (!this.isOpen || !this.dirty) return;
    this.dirty = false;
    const age = this.life ? ageName(this.life.age) : '';
    this.sub.textContent = age ? `${formatYear(this.year)} · ${age}` : formatYear(this.year);
    if (this.tab === 'story') this.renderStory();
    else if (this.tab === 'guide') this.guide.render(this.entries, this.life, this.year, this.yps);
    else this.chart.render(this.life?.islands ?? [], this.camX, this.camZ, this.camYaw);
  }

  private islandName = (id: number): string => this.life?.islands.find((i) => i.id === id)?.name ?? 'your island';

  private renderStory(): void {
    // Firsts: a row of stamps, faint until earned.
    const years = firstYears(this.entries);
    this.stampsEl.textContent = '';
    const keys = new Set(FIRSTS.map((f) => f.key));
    const all = [...FIRSTS.map((f) => f.key), ...[...years.keys()].filter((k) => !keys.has(k))];
    for (const key of all) {
      const y = years.get(key);
      const s = el('div', `stamp-badge${y !== undefined ? ' earned' : ''}`);
      s.appendChild(text('b', '', firstName(key)));
      s.appendChild(text('span', '', y !== undefined ? yearNumber(y) : '—'));
      this.stampsEl.appendChild(s);
    }

    const list = storyEntries(this.entries, this.filter);
    this.listEl.textContent = '';
    if (!list.length) {
      this.listEl.appendChild(
        text('p', 'empty', this.filter === 'storms' ? 'No storms yet. They come in the wet season, once plants have taken hold.' : 'Nothing written yet. Touch the glow to begin.'),
      );
    }
    const n = Math.min(list.length, this.rows);
    for (let i = 0; i < n; i++) this.listEl.appendChild(this.row(list[i]));
    this.moreBtn.style.display = list.length > n ? '' : 'none';
  }

  private row(e: JournalEntry): HTMLElement {
    const line = entryText(e, this.species, this.islandName);
    if (e.kind === 'age' || e.kind === 'ending') {
      const ch = el('div', 'chapter');
      ch.appendChild(text('span', 'ch-year', formatYear(e.year)));
      ch.appendChild(text('h2', '', e.age ? ageName(e.age) : line));
      if (e.age) ch.appendChild(text('p', '', line));
      return ch;
    }
    const r = el('div', `entry${isStamp(e) ? ' stamped' : ''}${e.kind === 'visit' ? ' visit' : ''}`);
    r.appendChild(text('div', 'e-year', yearNumber(e.year)));
    r.appendChild(el('div', 'e-icon', entryIcon(e)));
    r.appendChild(text('p', 'e-line', line));
    if (e.x !== undefined && e.z !== undefined) {
      const x = e.x;
      const z = e.z;
      r.appendChild(iconButton('e-go', ICONS.glide, 'Go there', () => this.actions.glideTo(x, z)));
    }
    return r;
  }
}
