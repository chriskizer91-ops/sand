/**
 * The storyteller: turns what happens into journal entries, firsts, Ages, milestones, the
 * ending, and gentle hints when the island has plateaued (ARCHITECTURE §4, critique-fun §2).
 *
 * Every entry is filled in the way content/stories.ts reads it (see the table at the top of
 * that file), so each kind gets its own words:
 * - firsts: FIRST_KEYS below, exactly the stamps in stories.ts FIRSTS;
 * - arrival/visit/return/lost: species, island, the place it landed (when it is a recognised
 *   place) and road; params.from = the island it hopped from; visit params.reason;
 * - new-island params.count; islands-joined params.other (the other island's name);
 * - storm: island, the castaway as species, its road, params.great / fallen / raft;
 * - place params.waiting = a visitor that needed exactly this place;
 * - milestone params.milestone (a stories.ts MILESTONES key) and params.count;
 * - lava-buried: species (the plant it covered), island; params.kipuka = 1 for a kīpuka;
 * - hint: a waiting species and params.level (which of its field-guide hints), or params.reason.
 */
import type { AgeId, PlaceKind, Road } from '../content/speciesTypes';
import type { ColonyInfo, JournalEntry } from '../engine/protocol';
import type { ReasonCode } from './needs';
import { LAYERS, L_CANOPY, patchX, patchZ } from './fields';
import { ANNOUNCE_AREA, ISLET_AREA, type IslandEvent } from './islands';
import { JournalBook, type EntryDraft, type Want } from './journal';
import type { EcoWorld } from './world';

/** Every first stamp, in the order they are usually earned (the keys of stories.ts FIRSTS). */
export const FIRST_KEYS = [
  'first-land',
  'first-life',
  'first-animal',
  'first-drift-seed',
  'first-fern',
  'first-flower',
  'first-nest',
  'first-tree',
  'first-return',
  'first-storm',
  'first-castaway',
  'first-forest',
  'first-song',
  'first-cloud',
  'first-pond',
  'first-night-chorus',
  'first-reef',
  'first-turtle-nest',
  'second-island',
  'first-island-hopper',
  'first-seabird-city',
  'first-lagoon',
  'first-kipuka',
  'first-whale',
] as const;
export type FirstKey = (typeof FIRST_KEYS)[number];

export const AGE_ORDER: AgeId[] = ['stone', 'lichen', 'green', 'wings', 'forest', 'chain', 'song'];

const PLACE_FIRSTS: Partial<Record<PlaceKind, FirstKey>> = {
  'cloud-peak': 'first-cloud',
  pond: 'first-pond',
  lagoon: 'first-lagoon',
};

/** Found share of the catalogue needed (with the Sound and 3 forested islands) for the whales. */
export const ENDING_SHARE = 0.65;
/** A new Age waits at least this long (play seconds) after the last, so each chapter is felt. */
export const AGE_GAP = 150;
/** Real-forest patches (on real soil) on one island for the first-forest stamp (1,600 m²). */
const FIRST_FOREST = 100;
/** Real-forest patches across the zone for the Age of Forests. */
const AGE_FOREST = 300;
/** An island ringing the Sound counts as forested with this much real forest (patches, and share of its land)… */
const ENDING_FOREST = 150;
const ENDING_FOREST_SHARE = 0.3;
/** …kept for this long (play seconds): a mature forest, not a first flush of trees. */
const FOREST_SETTLE = 900;
/** The Sound has to have been there this long (play seconds) before the whales find it. */
const SOUND_SETTLE = 2700;
/** Hints: only after this much play, after this long without a new species, and this far apart (play s). */
const HINT_AFTER = 1800;
const HINT_PLATEAU = 360;
const HINT_GAP = 600;
/** Milestones: stories.ts MILESTONES keys, and when this engine marks them. */
const KINDS_AT = [10, 25, 50, 75];
const RAKATA_AT = 26;
const HAWAII_AT = 30;
const ISLANDS_AT = [3, 5];

export interface EstablishInfo {
  first: boolean;
  /** A visitor that couldn't stay came back and stayed. */
  returned: boolean;
  /** Back after being lost from every island (only the first time is told). */
  afterLost: boolean;
  /** Island it hopped from (0: from the old islands). */
  hopFrom: number;
  /** Brought by a storm. */
  castaway: boolean;
  /** Recognised place it landed in, if any. */
  place: PlaceKind | null;
  /** Its first time on this island (other arrivals are not news). */
  newHere: boolean;
}

/** What the director needs to know about the waiting visitors, for hints and place stories. */
export interface HintSource {
  /** A never-established visitor that couldn't stay for want of something buildable (species id), or -1. */
  buildableWait(skip: (s: number) => boolean): number;
  /** A weak traveller that could live here but has not come yet (species id), or -1. */
  farWait(): number;
  /** A species held back by the islands themselves (another island nearby, a stack, an islet), or -1. */
  islandWait(skip: (s: number) => boolean): number;
  /** The visitor that needed exactly this new place (on this island if possible), or -1. */
  placeWaiting(kind: PlaceKind, island: number): number;
}

/** Each step's facts from the ecology, for Ages, milestones, hints and the ending. */
export interface StepFacts {
  found: number;
  total: number;
  /** Species living now, by kind. */
  nesters: number;
  voiced: number;
  nightSingers: number;
  plants: number;
  /** Play seconds since the last new species. */
  sinceNew: number;
  /** Seabird colonies, and the island of each. */
  colonies: readonly ColonyInfo[];
  colonyIslands: readonly number[];
}

export interface DirectorSave {
  firsts: string[];
  age: AgeId;
  ageAt: number;
  milestones: string[];
  ending: boolean;
  placesSeen: string[];
  kipukas: string[];
  lastHint: number;
  hints: string[];
  /** Field-guide hint level given per species key. */
  hintLevels: Record<string, number>;
  soundSince: number;
  /** Island id and the play time its forest became mature enough for the ending. */
  forestSince: [number, number][];
}

export class Director {
  readonly firsts = new Set<string>();
  age: AgeId = 'stone';
  /** Play time the current Age began. */
  private ageAt = -1e9;
  readonly milestones = new Set<string>();
  ending = false;
  /** Place kinds seen anywhere in this sea (first-in-sea flags). */
  readonly placesSeen = new Set<string>();
  readonly kipukas = new Set<string>();
  private lastHint = -1e9;
  private hints = new Set<string>();
  private hintLevels = new Map<string, number>();
  /** Play time the Sound was first seen (-1: no Sound now). */
  private soundSince = -1;
  /** Per island id: play time its forest has been big enough for the ending since. */
  private forestSince = new Map<number, number>();
  /** Set by the ecology once the arrivals exist. */
  source: HintSource | null = null;
  /** Lava burned living ground since the last zone job: per island id -> [patches, forest, x sum, z sum]. */
  private burns = new Map<number, [number, number, number, number]>();
  /** ...and which plants it covered (species id -> patches), per island. */
  private burnedSp = new Map<number, Map<number, number>>();

  constructor(
    private w: EcoWorld,
    readonly book: JournalBook,
  ) {}

  private add(d: EntryDraft, want: Want): JournalEntry | null {
    return this.book.add(d, want, this.w.realPlay, this.w.year);
  }

  /** Claim a first stamp (true if it is new). */
  claim(key: FirstKey): boolean {
    if (this.firsts.has(key)) return false;
    this.firsts.add(key);
    return true;
  }

  /** A stamp earned on its own (not by an arrival), as a 'first' entry. */
  firstEntry(key: FirstKey, x?: number, z?: number, island?: number, species?: number): void {
    if (!this.claim(key)) return;
    this.add({ year: this.w.year, kind: 'first', first: key, x, z, island, species }, 'always');
  }

  // ---------- events ----------

  onFirstLand(x: number, z: number): void {
    this.claim('first-land');
    this.book.openedAt = this.w.realPlay;
    this.add({ year: 0, kind: 'first-land', first: 'first-land', x, z }, 'always');
  }

  onEstablish(s: number, island: number, x: number, z: number, road: Road, info: EstablishInfo): void {
    const t = this.w.t;
    const keys: FirstKey[] = [];
    const want = (k: FirstKey, yes: boolean): void => {
      if (yes && !this.firsts.has(k)) keys.push(k);
    };
    if (info.first) {
      // First life is something the player can see on their land, not a coral under the sea.
      want('first-life', !t.marine[s] && !t.marineAnimal[s]);
      want('first-animal', !t.isPlant[s]);
      want('first-drift-seed', t.isPlant[s] === 1 && (road === 'sea' || road === 'raft'));
      want('first-fern', t.isFern[s] === 1);
      want('first-flower', t.hasFlower[s] === 1);
      want('first-nest', t.nester[s] === 1);
      want('first-song', t.isSongbird[s] === 1);
      want('first-turtle-nest', t.isTurtle[s] === 1);
    }
    want('first-return', info.returned);
    want('first-castaway', info.castaway);
    want('first-island-hopper', info.hopFrom > 0);
    const back = info.returned || info.afterLost;
    // Only news is told: a first arrival, a return, a castaway, or a species new to this island.
    if (!info.first && !back && !info.castaway && !info.newHere && keys.length === 0) return;
    // A visitor coming back is the payoff the player built for: always told as a card, in turn.
    // A species back after being lost is good news too, told when the moment is quiet.
    const card: Want = info.returned ? 'return' : info.afterLost ? 'normal' : info.first || info.castaway ? 'first' : 'never';
    const params: Record<string, string | number> = { first: info.first ? 1 : 0 };
    if (info.hopFrom > 0) params.from = info.hopFrom;
    const lead = keys.shift();
    if (lead) this.claim(lead);
    const draft: EntryDraft = { year: this.w.year, kind: back ? 'return' : 'arrival', species: s, island, x, z, road, params };
    if (info.place) draft.place = info.place;
    if (lead) draft.first = lead;
    this.add(draft, card);
    // At most one more stamp from the same moment, as its own entry.
    const extra = keys.shift();
    if (extra) this.firstEntry(extra, x, z, island, s);
  }

  onVisit(s: number, island: number, x: number, z: number, road: Road, reason: ReasonCode, place: PlaceKind | null): void {
    const d: EntryDraft = { year: this.w.year, kind: 'visit', species: s, island, x, z, road, params: { reason } };
    if (place) d.place = place;
    this.add(d, 'visit');
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
        this.add({ year: this.w.year, kind: 'new-island', island: e.id, x: rec.centroid[0], z: rec.centroid[1], params: { count: announced }, first }, 'normal');
      } else if (e.kind === 'joined') {
        // Only islands the journal has told of are worth a story when they join.
        if (!rec || !rec.announced || !e.otherAnnounced || e.otherName === undefined) continue;
        this.add({ year: this.w.year, kind: 'islands-joined', island: e.id, x: rec.centroid[0], z: rec.centroid[1], params: { other: e.otherName } }, 'normal');
      } else if (e.kind === 'lost') {
        this.add({ year: this.w.year, kind: 'island-lost', island: e.id, params: { name: e.otherName ?? '' } }, 'normal');
      }
    }
  }

  /** A place recognised on an island for the first time. Returns true if it is new to this sea. */
  onPlace(kind: PlaceKind, island: number, x: number, z: number): boolean {
    const firstInSea = !this.placesSeen.has(kind);
    this.placesSeen.add(kind);
    const fk = PLACE_FIRSTS[kind];
    const first = fk && this.claim(fk) ? fk : undefined;
    const params: Record<string, string | number> = { first: firstInSea ? 1 : 0 };
    const waiting = this.source ? this.source.placeWaiting(kind, island) : -1;
    if (waiting >= 0) params.waiting = waiting;
    this.add({ year: this.w.year, kind: 'place', place: kind, island, x, z, params, first }, firstInSea || waiting >= 0 ? 'normal' : 'never');
    return firstInSea;
  }

  /** Living ground ringed by new lava: a kīpuka. */
  onKipuka(key: string, island: number, x: number, z: number): void {
    if (this.kipukas.has(key)) return;
    this.kipukas.add(key);
    const first = this.claim('first-kipuka') ? ('first-kipuka' as const) : undefined;
    this.add({ year: this.w.year, kind: 'lava-buried', island, x, z, params: { kipuka: 1 }, first }, 'normal');
  }

  /** Lava is about to burn the life of patch p (collected, told once the land settles). */
  burned(p: number): void {
    const w = this.w;
    const island = w.f.isl[p];
    if (island === 0) return;
    const b = this.burns.get(island) ?? [0, 0, 0, 0];
    b[0]++;
    if (w.f.cov[p * LAYERS + L_CANOPY] >= 0.3) b[1]++;
    b[2] += patchX(p);
    b[3] += patchZ(p);
    this.burns.set(island, b);
    // The tallest living plant there is the one the story names.
    for (let L = LAYERS - 1; L >= 0; L--) {
      const s1 = w.f.sp[p * LAYERS + L];
      if (s1 === 0) continue;
      const m = this.burnedSp.get(island) ?? new Map<number, number>();
      m.set(s1 - 1, (m.get(s1 - 1) ?? 0) + 1);
      this.burnedSp.set(island, m);
      break;
    }
  }

  /** Tell the burns gathered since the last settle. */
  tellBurns(): void {
    for (const [island, b] of this.burns) {
      if (b[0] < 10) continue;
      let sp = -1;
      let most = 0;
      for (const [s, n] of this.burnedSp.get(island) ?? []) {
        if (n > most) {
          most = n;
          sp = s;
        }
      }
      const d: EntryDraft = { year: this.w.year, kind: 'lava-buried', island, x: b[2] / b[0], z: b[3] / b[0], params: { patches: b[0], forest: b[1] >= 6 ? 1 : 0 } };
      if (sp >= 0) d.species = sp;
      this.add(d, 'normal');
    }
    this.burns.clear();
    this.burnedSp.clear();
  }

  /** The storm's one journal line, at clearing ("the storm of Year N"). */
  onStorm(params: Record<string, string | number>, castaway: number, road: Road | null, island: number, x: number, z: number): void {
    const first = this.claim('first-storm') ? ('first-storm' as const) : undefined;
    const d: EntryDraft = { year: this.w.year, kind: 'storm', params, x, z, first };
    if (island > 0) d.island = island;
    if (castaway >= 0) d.species = castaway;
    if (road) d.road = road;
    this.add(d, 'always');
  }

  // ---------- once per step: stamps, ages, milestones, hints ----------

  stepChecks(facts: StepFacts): void {
    const w = this.w;
    const T = w.cur;
    const isl = w.islands;
    // Firsts made of many patches.
    if (T.treeTotal > 0 && !this.firsts.has('first-tree')) this.firstTree();
    for (let slot = 0; slot < isl.count; slot++) {
      const rec = isl.rec(slot);
      if (T.realForest[slot] >= FIRST_FOREST) this.firstEntry('first-forest', rec.centroid[0], rec.centroid[1], rec.id);
      if (T.coral[slot] >= 6) this.firstEntry('first-reef', rec.centroid[0], rec.centroid[1], rec.id);
    }
    if (facts.nightSingers >= 2) this.firstEntry('first-night-chorus');
    // A seabird city: a big colony on an islet, or several seabird kinds crowding one island.
    if (!this.firsts.has('first-seabird-city')) {
      const cs = facts.colonies;
      const ci = facts.colonyIslands;
      for (let i = 0; i < cs.length; i++) {
        const c = cs[i];
        const rec = isl.recs.get(ci[i]);
        if (!rec) continue;
        let sum = 0;
        for (let j = 0; j < cs.length; j++) if (ci[j] === ci[i]) sum += cs[j].n;
        if ((rec.area < ISLET_AREA && c.n >= 0.5) || sum >= 1.5) {
          this.firstEntry('first-seabird-city', c.x, c.z, ci[i]);
          break;
        }
      }
    }
    // Ages: one at a time, in order, each given its moment.
    const next = AGE_ORDER[AGE_ORDER.indexOf(this.age) + 1];
    if (next && w.realPlay - this.ageAt >= AGE_GAP && this.ageReached(next, facts)) {
      this.age = next;
      this.ageAt = w.realPlay;
      this.add({ year: w.year, kind: 'age', age: next }, 'always');
    }
    this.milestonesNow(facts);
    // The Sound has to stay a while before the whales find it.
    if (!w.features.sound) this.soundSince = -1;
    else if (this.soundSince < 0) this.soundSince = w.realPlay;
    this.hint(facts);
  }

  /** The first full-grown tree: told with its species and where it stands. */
  private firstTree(): void {
    const w = this.w;
    const isl = w.islands;
    const f = w.f;
    for (let slot = 0; slot < isl.count; slot++) {
      if (w.cur.trees[slot] <= 0) continue;
      for (let i = isl.landStart[slot]; i < isl.landStart[slot + 1]; i++) {
        const p = isl.land[i];
        const s1 = f.sp[p * LAYERS + L_CANOPY];
        if (s1 !== 0 && w.t.isTree[s1 - 1] && f.cov[p * LAYERS + L_CANOPY] >= 0.5) {
          this.firstEntry('first-tree', patchX(p), patchZ(p), isl.ids[slot], s1 - 1);
          return;
        }
      }
    }
  }

  private milestonesNow(facts: StepFacts): void {
    for (const n of KINDS_AT) if (facts.found >= n) this.milestone(`kinds-${n}`, 'kinds', facts.found);
    if (facts.plants >= RAKATA_AT) this.milestone('rakata', 'rakata', facts.plants);
    if (facts.plants >= HAWAII_AT) this.milestone('hawaii', 'hawaii', facts.plants);
    if (facts.found * 2 >= facts.total) this.milestone('half', 'half', facts.found);
    let announced = 0;
    for (const r of this.w.islands.recs.values()) if (r.announced && r.area >= ANNOUNCE_AREA) announced++;
    for (const n of ISLANDS_AT) if (announced >= n) this.milestone(`islands-${n}`, 'islands', announced);
  }

  /**
   * Gentle hints once the islands have plateaued (no new species for 6 minutes, after the first
   * half hour). They point at what the player could build, and then outward: a visitor that
   * needs a beach, a weak traveller that needs stepping stones to the east, a species that needs
   * another island nearby, the whales that need a Sound.
   */
  private hint(facts: StepFacts): void {
    const w = this.w;
    const src = this.source;
    if (!src || w.realPlay - this.book.openedAt < HINT_AFTER || facts.sinceNew < HINT_PLATEAU || w.realPlay - this.lastHint < HINT_GAP) return;
    const t = w.t;
    const spent = (s: number): boolean => (this.hintLevels.get(t.defs[s].key) ?? 0) >= 2;
    let species = src.buildableWait(spent);
    let reason: ReasonCode | null = null;
    if (species < 0 && !this.hints.has('too-far') && src.farWait() >= 0) reason = 'too-far';
    if (species < 0 && !reason) species = src.islandWait(spent);
    if (species < 0 && !reason && !w.features.sound) {
      let announced = 0;
      for (const r of w.islands.recs.values()) if (r.announced && r.area >= ANNOUNCE_AREA) announced++;
      if (announced >= 3) for (let s = 0; s < t.n && species < 0; s++) if (t.isWhale[s] && !spent(s)) species = s;
    }
    if (species >= 0) {
      const key = t.defs[species].key;
      const level = Math.min(2, (this.hintLevels.get(key) ?? 0) + 1);
      this.hintLevels.set(key, level);
      this.lastHint = w.realPlay;
      this.add({ year: w.year, kind: 'hint', species, params: { level } }, 'normal');
    } else if (reason) {
      this.hints.add(reason);
      this.lastHint = w.realPlay;
      this.add({ year: w.year, kind: 'hint', params: { reason } }, 'normal');
    }
  }

  /**
   * The ending: the Sound, standing for 45 minutes of play; three or more of the islands
   * around it under mature real forest (a good share of their land, kept for 15 minutes); the
   * islands' story told through to the Age of Song; and most of the catalogue found. Returns
   * true once, when the whales come.
   */
  checkEnding(found: number, total: number): boolean {
    if (this.ending) return false;
    const w = this.w;
    const sound = w.features.sound;
    // Which islands carry a big enough forest, and since when.
    const isl = w.islands;
    for (let slot = 0; slot < isl.count; slot++) {
      const id = isl.ids[slot];
      const real = w.cur.realForest[slot];
      if (real >= ENDING_FOREST && real >= ENDING_FOREST_SHARE * w.cur.land[slot]) {
        if (!this.forestSince.has(id)) this.forestSince.set(id, w.realPlay);
      } else this.forestSince.delete(id);
    }
    if (!sound || this.soundSince < 0 || w.realPlay - this.soundSince < SOUND_SETTLE || found < ENDING_SHARE * total || this.age !== 'song') return false;
    let forested = 0;
    for (const id of sound.islands) {
      const since = this.forestSince.get(id);
      if (since !== undefined && w.realPlay - since >= FOREST_SETTLE) forested++;
    }
    if (forested < 3) return false;
    this.ending = true;
    const first = this.claim('first-whale') ? ('first-whale' as const) : undefined;
    this.add({ year: w.year, kind: 'ending', x: sound.x, z: sound.z, first }, 'always');
    return true;
  }

  private milestone(id: string, key: string, count: number): void {
    if (this.milestones.has(id)) return;
    this.milestones.add(id);
    this.add({ year: this.w.year, kind: 'milestone', params: { milestone: key, count } }, 'normal');
  }

  private ageReached(age: AgeId, facts: StepFacts): boolean {
    const T = this.w.cur;
    switch (age) {
      case 'lichen':
        return facts.found >= 1;
      case 'green':
        return T.herbTotal >= 40;
      case 'wings':
        return facts.nesters >= 2;
      case 'forest':
        return T.realForestTotal >= AGE_FOREST;
      case 'chain': {
        let n = 0;
        const isl = this.w.islands;
        const nS = this.w.t.n;
        for (let slot = 0; slot < isl.count; slot++) {
          if (isl.rec(slot).area < 1500) continue;
          let k = 0;
          for (let s = 0; s < nS; s++) if (this.w.present[slot * nS + s]) k++;
          if (k >= 5) n++;
        }
        return n >= 3;
      }
      case 'song':
        return facts.voiced >= 4 && facts.found >= 0.4 * facts.total;
      default:
        return false;
    }
  }

  // ---------- save ----------

  save(): DirectorSave {
    const hintLevels: Record<string, number> = {};
    for (const [k, v] of this.hintLevels) hintLevels[k] = v;
    return {
      firsts: [...this.firsts],
      age: this.age,
      ageAt: this.ageAt,
      milestones: [...this.milestones],
      ending: this.ending,
      placesSeen: [...this.placesSeen],
      kipukas: [...this.kipukas],
      lastHint: this.lastHint,
      hints: [...this.hints],
      hintLevels,
      soundSince: this.soundSince,
      forestSince: [...this.forestSince.entries()],
    };
  }

  load(s: DirectorSave): void {
    this.firsts.clear();
    for (const k of s.firsts) this.firsts.add(k);
    this.age = s.age;
    this.ageAt = s.ageAt;
    this.milestones.clear();
    for (const k of s.milestones) this.milestones.add(k);
    this.ending = s.ending;
    this.placesSeen.clear();
    for (const k of s.placesSeen) this.placesSeen.add(k);
    this.kipukas.clear();
    for (const k of s.kipukas) this.kipukas.add(k);
    this.lastHint = s.lastHint;
    this.hints = new Set(s.hints);
    this.hintLevels = new Map(Object.entries(s.hintLevels));
    this.soundSince = s.soundSince;
    this.forestSince = new Map(s.forestSince);
    this.burns.clear();
    this.burnedSp.clear();
  }
}
