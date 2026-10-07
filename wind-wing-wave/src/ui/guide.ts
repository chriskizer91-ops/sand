/**
 * The journal's "Life & Places" page: the field guide.
 *
 * Species are grouped as in the guide (plants, birds, sea life, small creatures, land
 * animals), each group with a modest "found 7 of 31". A found species shows its name, how it
 * came, where it lives now, the year it was first seen, one true fact and what it needs.
 * One not yet found shows a grey silhouette and a hint that sharpens over time:
 *   a riddle -> the plain need (once it has visited and left) -> a direct line (about twenty
 *   minutes of play after that visit), so a calm game never leaves the player stuck.
 * Places list what makes each one and who it brings.
 *
 * Everything here is worked out from the journal (which is append-only and complete) and
 * the latest life summary. The one thing it remembers itself is which hints have reached the
 * direct line (HintMemo, kept in the save), because "twenty minutes" is counted in years at
 * the current pace, and a hint must never blur again when the player changes the pace.
 */
import { ALL_PLACES, placeInfo, roadWord } from '../content/stories';
import type { GuideGroup, PlaceKind, Road, SpeciesDef } from '../content/speciesTypes';
import type { JournalEntry, LifeInfo } from '../engine/protocol';
import { el, text } from './dom';
import { silhouette, silhouetteFor, speciesColor } from './icons';
import { capitalise, formatYear } from './text';

export const GROUPS: readonly (readonly [GuideGroup, string])[] = [
  ['plants', 'Plants'],
  ['birds', 'Birds'],
  ['sea', 'Sea life'],
  ['small', 'Small creatures'],
  ['land', 'Land animals'],
];

/** Real minutes of play after a visit before the hint becomes a direct line. */
export const DIRECT_HINT_MINUTES = 20;

export interface SpeciesRecord {
  /** Established on an island at least once. */
  found: boolean;
  /** Year it first established. */
  firstYear: number;
  /** How it first came. */
  road?: Road;
  /** Year of its first visit that didn't stay. */
  visitYear?: number;
  /** Year it was last lost from every island (only if after its latest arrival). */
  goneSince?: number;
}

/** What the journal says about each species. */
export function speciesRecords(entries: readonly JournalEntry[]): Map<number, SpeciesRecord> {
  const out = new Map<number, SpeciesRecord>();
  const latestArrival = new Map<number, number>();
  const get = (id: number) => {
    let r = out.get(id);
    if (!r) {
      r = { found: false, firstYear: Infinity };
      out.set(id, r);
    }
    return r;
  };
  for (const e of entries) {
    if (e.species === undefined) continue;
    const r = get(e.species);
    if (e.kind === 'arrival' || e.kind === 'return') {
      r.found = true;
      if (e.year < r.firstYear) {
        r.firstYear = e.year;
        if (e.road) r.road = e.road;
      } else if (!r.road && e.road) r.road = e.road;
      latestArrival.set(e.species, Math.max(latestArrival.get(e.species) ?? -1, e.year));
    } else if (e.kind === 'visit') {
      if (r.visitYear === undefined || e.year < r.visitYear) r.visitYear = e.year;
      if (!r.road && e.road) r.road = e.road;
    }
  }
  for (const e of entries) {
    if (e.kind !== 'lost' || e.species === undefined) continue;
    const r = out.get(e.species);
    if (r && e.year >= (latestArrival.get(e.species) ?? Infinity)) r.goneSince = Math.max(r.goneSince ?? 0, e.year);
  }
  return out;
}

/** 0 riddle, 1 plain need (it visited and left), 2 direct line (~20 minutes of play after). */
export function hintLevel(r: SpeciesRecord | undefined, year: number, yearsPerSecond: number): 0 | 1 | 2 {
  if (!r || r.visitYear === undefined) return 0;
  return year - r.visitYear >= DIRECT_HINT_MINUTES * 60 * yearsPerSecond ? 2 : 1;
}

/**
 * Hints only ever sharpen. Once a species' hint has reached the direct line it stays there,
 * even if a slower-to-faster pace change would make the years since its visit count for
 * fewer minutes. Kept per sea, in the save.
 */
export class HintMemo {
  private direct = new Set<number>();

  /** The level to show for a species now (and remember it if it is the direct line). */
  level(id: number, r: SpeciesRecord | undefined, year: number, yearsPerSecond: number): 0 | 1 | 2 {
    if (this.direct.has(id)) return 2;
    const l = hintLevel(r, year, yearsPerSecond);
    if (l === 2) this.direct.add(id);
    return l;
  }

  /** Species whose hints have reached the direct line (for the save). */
  get ids(): number[] {
    return [...this.direct];
  }

  /** A new or loaded sea: its own remembered hints (anything that isn't a species id is ignored). */
  restore(list: readonly unknown[]): void {
    this.direct.clear();
    for (const v of list) if (typeof v === 'number' && Number.isInteger(v) && v >= 0) this.direct.add(v);
  }
}

/** The first year each kind of place was recognised. */
export function placeYears(entries: readonly JournalEntry[]): Map<PlaceKind, number> {
  const out = new Map<PlaceKind, number>();
  for (const e of entries) if (e.kind === 'place' && e.place && !out.has(e.place)) out.set(e.place, e.year);
  return out;
}

/** Islands a species lives on now, by name. */
export function homes(sp: SpeciesDef, life: LifeInfo | null): string[] {
  if (!life) return [];
  const names: string[] = [];
  for (const p of life.pops) {
    if (p.species !== sp.id || p.n <= 0.01) continue;
    const isl = life.islands.find((i) => i.id === p.island);
    if (isl && !names.includes(isl.name)) names.push(isl.name);
  }
  return names;
}

type Tab = GuideGroup | 'places';

export class GuidePage {
  readonly root: HTMLDivElement;
  private chips: HTMLDivElement;
  private body: HTMLDivElement;
  private tab: Tab = 'plants';
  readonly hints = new HintMemo();

  constructor(private species: readonly SpeciesDef[]) {
    this.root = el('div', 'j-page guide');
    this.chips = el('div', 'chips');
    this.body = el('div', 'guide-body');
    this.root.append(this.chips, this.body);
  }

  render(entries: readonly JournalEntry[], life: LifeInfo | null, year: number, yps: number): void {
    const recs = speciesRecords(entries);
    const places = placeYears(entries);
    this.chips.textContent = '';
    for (const [g, name] of GROUPS) {
      const all = this.species.filter((s) => s.guide === g);
      if (!all.length) continue;
      const found = all.filter((s) => recs.get(s.id)?.found).length;
      this.chips.appendChild(this.chip(g, name, `${found} of ${all.length}`, entries, life, year, yps));
    }
    this.chips.appendChild(this.chip('places', 'Places', `${places.size} of ${ALL_PLACES.length}`, entries, life, year, yps));

    this.body.textContent = '';
    if (this.tab === 'places') {
      this.body.appendChild(text('p', 'guide-intro', 'Shapes the island recognises. Each one brings its own life.'));
      const grid = el('div', 'guide-grid');
      for (const kind of ALL_PLACES) grid.appendChild(this.placeCard(kind, places.get(kind)));
      this.body.appendChild(grid);
      return;
    }
    const list = this.species.filter((s) => s.guide === this.tab);
    const found = list.filter((s) => recs.get(s.id)?.found);
    const missing = list.filter((s) => !recs.get(s.id)?.found);
    const groupName = GROUPS.find(([g]) => g === this.tab)?.[1] ?? '';
    this.body.appendChild(text('p', 'guide-intro', `${groupName}: found ${found.length} of ${list.length}.`));
    const grid = el('div', 'guide-grid');
    for (const s of found) grid.appendChild(this.foundCard(s, recs.get(s.id)!, life));
    for (const s of missing) grid.appendChild(this.missingCard(s, this.hints.level(s.id, recs.get(s.id), year, yps)));
    this.body.appendChild(grid);
  }

  private chip(tab: Tab, name: string, count: string, entries: readonly JournalEntry[], life: LifeInfo | null, year: number, yps: number): HTMLButtonElement {
    const b = el('button', `chip${tab === this.tab ? ' on' : ''}`);
    b.type = 'button';
    b.append(text('span', 'chip-name', name), text('span', 'chip-count', count));
    b.addEventListener('click', () => {
      this.tab = tab;
      this.render(entries, life, year, yps);
      this.root.scrollTop = 0;
    });
    return b;
  }

  private foundCard(s: SpeciesDef, r: SpeciesRecord, life: LifeInfo | null): HTMLElement {
    const c = el('article', 'gcard found');
    const pic = el('div', 'gpic', silhouette(silhouetteFor(s)));
    pic.style.color = speciesColor(s);
    const body = el('div', 'gbody');
    const h = el('h3');
    h.appendChild(document.createTextNode(s.name));
    if (s.sci) h.appendChild(text('i', 'sci', ` ${s.sci}`));
    body.appendChild(h);
    const came = r.road ? `Came ${roadWord(r.road)}` : 'Came on its own';
    body.appendChild(text('p', 'gmeta', `${came} · first seen ${formatYear(r.firstYear)}`));
    const where = homes(s, life);
    if (r.goneSince !== undefined) body.appendChild(text('p', 'gwhere', `Not seen on your islands since ${formatYear(r.goneSince)}. It may come back.`));
    else if (where.length) body.appendChild(text('p', 'gwhere', `Lives on ${where.join(', ')}`));
    body.appendChild(text('p', 'gfact', s.fact));
    if (s.needs) body.appendChild(text('p', 'gneeds', `Needs: ${s.needs}`));
    c.append(pic, body);
    return c;
  }

  private missingCard(s: SpeciesDef, level: 0 | 1 | 2): HTMLElement {
    const c = el('article', `gcard missing level-${level}`);
    const pic = el('div', 'gpic', silhouette(silhouetteFor(s)));
    const body = el('div', 'gbody');
    body.appendChild(text('h3', '', level === 2 ? s.name : 'Not found yet'));
    const lead = level === 0 ? 'A riddle' : level === 1 ? 'It came and left' : 'What it needs';
    body.appendChild(text('p', 'gmeta', lead));
    body.appendChild(text('p', 'ghint', s.hint[level]));
    c.append(pic, body);
    return c;
  }

  private placeCard(kind: PlaceKind, year: number | undefined): HTMLElement {
    const info = placeInfo(kind);
    const c = el('article', `gcard place ${year !== undefined ? 'found' : 'missing'}`);
    const body = el('div', 'gbody');
    body.appendChild(text('h3', '', capitalise(info.name)));
    body.appendChild(text('p', 'gmeta', year !== undefined ? `Found ${formatYear(year)}` : 'Not found yet'));
    if (info.makes) body.appendChild(text('p', 'gfact', `Made by: ${info.makes}`));
    if (info.brings) body.appendChild(text('p', 'gneeds', `Brings: ${info.brings}`));
    c.appendChild(body);
    return c;
  }
}
