/**
 * The storyteller: turns what happens into journal entries, firsts, Ages, milestones, the
 * ending, and gentle hints when the island has plateaued (ARCHITECTURE §4, critique-fun §2).
 *
 * Keys the journal uses (content/stories.ts writes their names and lines):
 * - firsts: FIRST_KEYS below;
 * - milestones: params.key = 'species-10' | 'species-25' | 'species-50' | 'species-75' | 'rakata' | 'islands-3';
 * - moments: params.moment = 'kipuka';
 * - hints: params.hint = 'island-east' | 'more-islands' | 'sound' | a ReasonCode the player can build.
 */
import type { AgeId, PlaceKind, Road } from '../content/speciesTypes';
import type { JournalEntry } from '../engine/protocol';
import type { ReasonCode } from './needs';
import { isBuildableReason } from './catalog';
import { ANNOUNCE_AREA, ISLET_AREA, type IslandEvent } from './islands';
import { JournalBook, type EntryDraft, type Want } from './journal';
import type { EcoWorld } from './world';

/** Every first stamp, in the order they are usually earned. */
export const FIRST_KEYS = [
  'first-land',
  'first-life',
  'first-animal',
  'first-flower',
  'first-seed',
  'first-nest',
  'first-tree',
  'first-storm',
  'first-castaway',
  'first-forest',
  'first-cloud',
  'first-pond',
  'first-stream',
  'first-song',
  'first-reef',
  'first-turtle-nest',
  'second-island',
  'first-island-hopper',
  'first-seabird-city',
  'first-lagoon',
  'first-sound',
  'first-whale',
] as const;
export type FirstKey = (typeof FIRST_KEYS)[number];

export const AGE_ORDER: AgeId[] = ['stone', 'lichen', 'green', 'wings', 'forest', 'chain', 'song'];

const PLACE_FIRSTS: Partial<Record<PlaceKind, FirstKey>> = {
  'cloud-peak': 'first-cloud',
  pond: 'first-pond',
  stream: 'first-stream',
  lagoon: 'first-lagoon',
  sound: 'first-sound',
};

/** Found share of the catalogue needed (with the Sound and 3 forested islands) for the whales. */
export const ENDING_SHARE = 0.6;

export interface EstablishInfo {
  first: boolean;
  returned: boolean;
  afterLost: boolean;
  hopFrom: number;
  castaway: boolean;
}

export interface DirectorSave {
  firsts: string[];
  age: AgeId;
  milestones: string[];
  ending: boolean;
  placesSeen: string[];
  kipukas: string[];
  lastHint: number;
  hints: string[];
}

export class Director {
  readonly firsts = new Set<string>();
  age: AgeId = 'stone';
  readonly milestones = new Set<string>();
  ending = false;
  /** Place kinds seen anywhere in this sea (first-in-sea flags). */
  readonly placesSeen = new Set<string>();
  readonly kipukas = new Set<string>();
  private lastHint = -1e9;
  private hints = new Set<string>();
  /** Lava burned living ground since the last zone job: per island id -> [patches, forest, x, z]. */
  private burns = new Map<number, [number, number, number, number]>();

  constructor(
    private w: EcoWorld,
    readonly book: JournalBook,
  ) {}

  private add(d: EntryDraft, want: Want): JournalEntry | null {
    return this.book.add(d, want, this.w.play);
  }

  /** Claim a first stamp (true if it is new). */
  claim(key: FirstKey): boolean {
    if (this.firsts.has(key)) return false;
    this.firsts.add(key);
    return true;
  }

  firstEntry(key: FirstKey, x?: number, z?: number, island?: number): void {
    if (!this.claim(key)) return;
    this.add({ year: this.w.year, kind: 'first', first: key, x, z, island }, 'always');
  }

  // ---------- events ----------

  onFirstLand(x: number, z: number): void {
    this.claim('first-land');
    this.book.openedAt = this.w.play;
    this.add({ year: 0, kind: 'first-land', first: 'first-land', x, z }, 'always');
  }

  onEstablish(s: number, island: number, x: number, z: number, road: Road, info: EstablishInfo): void {
    const t = this.w.t;
    const keys: FirstKey[] = [];
    if (info.first) {
      if (!this.firsts.has('first-life')) keys.push('first-life');
      if (!t.isPlant[s] && !this.firsts.has('first-animal')) keys.push('first-animal');
      if (t.isTree[s] && !this.firsts.has('first-tree')) keys.push('first-tree');
      if (t.isBird[s] && !this.firsts.has('first-nest')) keys.push('first-nest');
      if (t.isSongbird[s] && !this.firsts.has('first-song')) keys.push('first-song');
      if (t.isTurtle[s] && !this.firsts.has('first-turtle-nest')) keys.push('first-turtle-nest');
      if (t.hasFlower[s] && !this.firsts.has('first-flower')) keys.push('first-flower');
      if (t.isPlant[s] && road === 'bird' && !this.firsts.has('first-seed')) keys.push('first-seed');
    }
    if (info.castaway && !this.firsts.has('first-castaway')) keys.push('first-castaway');
    if (info.hopFrom > 0 && !this.firsts.has('first-island-hopper')) keys.push('first-island-hopper');
    const params: Record<string, string | number> = { first: info.first ? 1 : 0 };
    if (info.hopFrom > 0) params.from = info.hopFrom;
    if (info.afterLost) params.after = 'lost';
    if (info.castaway) params.storm = 1;
    const kind = info.returned || info.afterLost ? 'return' : 'arrival';
    const lead = keys.shift();
    if (lead) this.claim(lead);
    // A visitor coming back is the payoff the player built for: always a card.
    this.add({ year: this.w.year, kind, species: s, island, x, z, road, params, first: lead }, info.returned || info.afterLost ? 'always' : info.first ? 'first' : 'normal');
    // At most one more stamp from the same moment, as its own entry.
    const extra = keys.shift();
    if (extra) this.firstEntry(extra, x, z, island);
  }

  onVisit(s: number, island: number, x: number, z: number, road: Road, reason: ReasonCode): void {
    this.add({ year: this.w.year, kind: 'visit', species: s, island, x, z, road, params: { reason } }, 'visit');
  }

  onLost(s: number): void {
    this.add({ year: this.w.year, kind: 'lost', species: s }, 'never');
  }

  onIslandEvents(events: IslandEvent[]): void {
    const recs = this.w.islands.recs;
    for (const e of events) {
      const rec = recs.get(e.id);
      if (e.kind === 'new') {
        if (!rec || rec.announced) continue;
        rec.announced = true;
        let announced = 0;
        for (const r of recs.values()) if (r.announced) announced++;
        // The very first island is already "first land".
        if (announced <= 1) continue;
        const first: FirstKey | undefined = this.claim('second-island') ? 'second-island' : undefined;
        this.add({ year: this.w.year, kind: 'new-island', island: e.id, x: rec.centroid[0], z: rec.centroid[1], params: { area: Math.round(rec.area) }, first }, 'normal');
      } else if (e.kind === 'joined') {
        // Only islands the journal has told of are worth a story when they join.
        if (!rec || !rec.announced || !e.otherAnnounced || e.otherName === undefined) continue;
        this.add({ year: this.w.year, kind: 'islands-joined', island: e.id, x: rec.centroid[0], z: rec.centroid[1], params: { name: e.otherName, other: e.other ?? 0 } }, 'normal');
      } else if (e.kind === 'lost') {
        this.add({ year: this.w.year, kind: 'island-lost', island: e.id, params: { name: e.otherName ?? '' } }, 'normal');
      }
    }
  }

  /** A place recognised on an island for the first time. */
  onPlace(kind: PlaceKind, island: number, x: number, z: number): boolean {
    const firstInSea = !this.placesSeen.has(kind);
    this.placesSeen.add(kind);
    const fk = PLACE_FIRSTS[kind];
    const first = fk && this.claim(fk) ? fk : undefined;
    this.add({ year: this.w.year, kind: 'place', place: kind, island, x, z, params: { first: firstInSea ? 1 : 0 }, first }, firstInSea ? 'normal' : 'never');
    return firstInSea;
  }

  onKipuka(key: string, island: number, x: number, z: number): void {
    if (this.kipukas.has(key)) return;
    this.kipukas.add(key);
    this.add({ year: this.w.year, kind: 'moment', island, x, z, params: { moment: 'kipuka' } }, 'normal');
  }

  /** Lava burned a patch with life (collected, told once the land settles). */
  burned(island: number, canopy: number, x: number, z: number): void {
    if (island === 0) return;
    const b = this.burns.get(island) ?? [0, 0, 0, 0];
    b[0]++;
    if (canopy >= 0.3) b[1]++;
    b[2] += x;
    b[3] += z;
    this.burns.set(island, b);
  }

  /** Tell the burns gathered since the last settle. */
  tellBurns(): void {
    for (const [island, b] of this.burns) {
      if (b[0] < 10) continue;
      this.add(
        { year: this.w.year, kind: 'lava-buried', island, x: b[2] / b[0], z: b[3] / b[0], params: { patches: b[0], forest: b[1] >= 6 ? 1 : 0 } },
        'normal',
      );
    }
    this.burns.clear();
  }

  onStorm(params: Record<string, string | number>, castaway: number, x: number, z: number): void {
    const first = this.claim('first-storm') ? ('first-storm' as const) : undefined;
    this.add({ year: this.w.year, kind: 'storm', params, species: castaway >= 0 ? castaway : undefined, x, z, first }, 'always');
  }

  // ---------- once per step: ages, milestones, ending, hints ----------

  /** Checks after each step. `foundCount`, `total` from the catalogue; `plateau` play seconds since the last new species. */
  stepChecks(
    foundCount: number,
    total: number,
    birds: number,
    voiced: number,
    sinceNew: number,
    nearMisses: ReasonCode[],
    lowReachWaiting: boolean,
    colonies: readonly { island: number; x: number; z: number; n: number }[],
  ): void {
    const w = this.w;
    const T = w.cur;
    const isl = w.islands;
    // Firsts made of many patches.
    for (let slot = 0; slot < isl.count; slot++) {
      const rec = isl.rec(slot);
      if (T.forest[slot] >= 150) this.firstEntry('first-forest', rec.centroid[0], rec.centroid[1], rec.id);
      if (T.coral[slot] >= 6) this.firstEntry('first-reef', rec.centroid[0], rec.centroid[1], rec.id);
    }
    // A seabird city: a big colony on an islet, or several seabird kinds crowding one island.
    const byIsland = new Map<number, number>();
    for (const c of colonies) {
      const rec = w.islands.recs.get(c.island);
      if (!rec) continue;
      const sum = (byIsland.get(c.island) ?? 0) + c.n;
      byIsland.set(c.island, sum);
      if ((rec.area < ISLET_AREA && c.n >= 0.5) || sum >= 1.5) this.firstEntry('first-seabird-city', c.x, c.z, c.island);
    }
    // Ages: one step at a time, in order.
    const next = AGE_ORDER[AGE_ORDER.indexOf(this.age) + 1];
    if (next && this.ageReached(next, foundCount, total, birds, voiced)) {
      this.age = next;
      this.add({ year: w.year, kind: 'age', age: next }, 'always');
    }
    // Milestones.
    for (const n of [10, 25, 50, 75]) if (foundCount >= n) this.milestone(`species-${n}`, foundCount);
    let plantsMax = 0;
    for (let slot = 0; slot < isl.count; slot++) {
      let k = 0;
      for (let s = 0; s < w.t.n; s++) if (w.t.isPlant[s] && w.present[slot * w.t.n + s]) k++;
      plantsMax = Math.max(plantsMax, k);
    }
    if (plantsMax >= 26) this.milestone('rakata', plantsMax);
    let announced = 0;
    for (const r of isl.recs.values()) if (r.announced && r.area >= ANNOUNCE_AREA) announced++;
    if (announced >= 3) this.milestone('islands-3', announced);
    // Gentle hints once the islands have plateaued (no new species for 6 minutes, after 30).
    if (w.play - this.book.openedAt > 1800 && sinceNew > 360 && w.play - this.lastHint > 600) {
      let hint: string | null = null;
      for (const r of nearMisses) {
        if (isBuildableReason(r) && !this.hints.has(r)) {
          hint = r;
          break;
        }
      }
      if (!hint && lowReachWaiting && !this.hints.has('island-east')) hint = 'island-east';
      if (!hint && announced < 3 && !this.hints.has('more-islands')) hint = 'more-islands';
      if (!hint && announced >= 3 && !w.features.sound && !this.hints.has('sound')) hint = 'sound';
      if (hint) {
        this.hints.add(hint);
        this.lastHint = w.play;
        this.add({ year: w.year, kind: 'hint', params: { hint } }, 'normal');
      }
    }
  }

  /**
   * The ending: the Sound, three or more forested islands, and most of the catalogue found.
   * Returns true once, when the whales come.
   */
  checkEnding(foundCount: number, total: number): boolean {
    if (this.ending) return false;
    const w = this.w;
    const sound = w.features.sound;
    if (!sound) return false;
    let forested = 0;
    for (let slot = 0; slot < w.islands.count; slot++) {
      const land = w.cur.land[slot];
      if (w.cur.forest[slot] >= 40 && w.cur.forest[slot] >= 0.15 * land) forested++;
    }
    if (forested < 3 || foundCount < ENDING_SHARE * total) return false;
    this.ending = true;
    const first = this.claim('first-whale') ? ('first-whale' as const) : undefined;
    this.add({ year: w.year, kind: 'ending', x: sound.x, z: sound.z, first }, 'always');
    return true;
  }

  private milestone(key: string, count: number): void {
    if (this.milestones.has(key)) return;
    this.milestones.add(key);
    this.add({ year: this.w.year, kind: 'milestone', params: { key, count } }, 'normal');
  }

  private ageReached(age: AgeId, found: number, total: number, birds: number, voiced: number): boolean {
    const T = this.w.cur;
    switch (age) {
      case 'lichen':
        return found >= 1;
      case 'green':
        return T.herbTotal >= 40;
      case 'wings':
        return birds >= 2;
      case 'forest':
        return T.forestTotal >= 300;
      case 'chain': {
        let n = 0;
        const isl = this.w.islands;
        for (let slot = 0; slot < isl.count; slot++) {
          if (isl.rec(slot).area < 1500) continue;
          let k = 0;
          for (let s = 0; s < this.w.t.n; s++) if (this.w.present[slot * this.w.t.n + s]) k++;
          if (k >= 5) n++;
        }
        return n >= 3;
      }
      case 'song':
        return voiced >= 4 && found >= 0.4 * total;
      default:
        return false;
    }
  }

  // ---------- save ----------

  save(): DirectorSave {
    return {
      firsts: [...this.firsts],
      age: this.age,
      milestones: [...this.milestones],
      ending: this.ending,
      placesSeen: [...this.placesSeen],
      kipukas: [...this.kipukas],
      lastHint: this.lastHint,
      hints: [...this.hints],
    };
  }

  load(s: DirectorSave): void {
    this.firsts.clear();
    for (const k of s.firsts) this.firsts.add(k);
    this.age = s.age;
    this.milestones.clear();
    for (const k of s.milestones) this.milestones.add(k);
    this.ending = s.ending;
    this.placesSeen.clear();
    for (const k of s.placesSeen) this.placesSeen.add(k);
    this.kipukas.clear();
    for (const k of s.kipukas) this.kipukas.add(k);
    this.lastHint = s.lastHint;
    this.hints = new Set(s.hints);
    this.burns.clear();
  }
}
