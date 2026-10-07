/**
 * Islands: connected land, with ids that stay the same while you keep building.
 *
 * - A patch counts as new land above +0.5 m and stays land until it sinks below 0 m
 *   (hysteresis), so a sandbar at the waterline does not flicker in and out.
 * - Ids are matched to the previous labelling by overlap: the biggest overlap keeps its id.
 *   When two islands join, the one with more shared land keeps its id; when one splits, the
 *   larger part keeps it and the smaller part revives the id it had before joining, if any.
 * - An island is "announced" (journal, chart) once it reaches 400 m², so a few stray rocks
 *   never fill the journal.
 *
 * Labelling runs inside the zone job and is staged: the new map and records are committed at
 * the next step boundary, so one eco step never sees two different island maps.
 */
import { NP, PATCH_M } from '../config';
import { FloodScratch, NPATCH, patchX, patchZ, type ZoneFields } from './fields';

export const ANNOUNCE_AREA = 400;
/** Below this area a land component is a rock, not shown on the chart. */
export const CHART_AREA = 64;
/** Islands smaller than this are islets (seabird cities). */
export const ISLET_AREA = 4000;

export interface IslandRec {
  id: number;
  name: string;
  /** The player chose the name. */
  named: boolean;
  /** Year it first broke the surface. */
  founded: number;
  announced: boolean;
  area: number;
  patches: number;
  peak: [number, number, number];
  centroid: [number, number];
  bbox: [number, number, number, number];
  /** Recognised places (bit per PLACE_KINDS index). */
  places: number;
  /** Mean sand kind of sandy patches (0 black .. 255 white) and the share of sandy land. */
  sandKind: number;
  sandShare: number;
  /** Shoreline length (m). */
  shore: number;
  /** Seabird colony species living here (for the default name), or -1. */
  colonySp: number;
}

export interface IslandEvent {
  kind: 'new' | 'joined' | 'lost';
  id: number;
  /** For joined: the island that was absorbed (and whether the journal had told of it). */
  other?: number;
  otherName?: string;
  otherAnnounced?: boolean;
}

/** Island ids absorbed by a join, remembered so a later split can bring them back. */
interface Absorbed {
  rec: IslandRec;
  into: number;
}

export interface IslandLabelResult {
  map: Uint16Array;
  recs: Map<number, IslandRec>;
  events: IslandEvent[];
}

/**
 * Label land into islands (staged). `prev` is the committed map; `recs` the committed records.
 * Writes the new labelling into `out` and returns the new record set and events.
 */
export class IslandLabeller {
  nextId = 1;
  private absorbed: Absorbed[] = [];

  constructor(private readonly scratch = new FloodScratch()) {}

  /** Label in one go (tests and tools). */
  label(f: ZoneFields, prev: Uint16Array, recs: Map<number, IslandRec>, out: Uint16Array, year: number, sandKindAt: (p: number) => number): IslandLabelResult {
    const gen = this.labelSliced(f, prev, recs, out, year, sandKindAt);
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
    }
  }

  /** Label, yielding between slices of work (the zone job). */
  *labelSliced(f: ZoneFields, prev: Uint16Array, recs: Map<number, IslandRec>, out: Uint16Array, year: number, sandKindAt: (p: number) => number): Generator<void, IslandLabelResult, void> {
    const h = f.h;
    const comp = this.scratch.comp;
    comp.fill(0);
    const q = this.scratch.queue;
    // ---------- connected components (4-neighbour) ----------
    interface Comp {
      n: number;
      sx: number;
      sz: number;
      peakH: number;
      peakP: number;
      x0: number;
      z0: number;
      x1: number;
      z1: number;
      sandN: number;
      sandK: number;
      shore: number;
    }
    const comps: Comp[] = [{ n: 0, sx: 0, sz: 0, peakH: 0, peakP: 0, x0: 0, z0: 0, x1: 0, z1: 0, sandN: 0, sandK: 0, shore: 0 }];
    const isLand = (p: number): boolean => h[p] > 0.5 || (h[p] > 0 && prev[p] !== 0);
    let work = 0;
    for (let p0 = 0; p0 < NPATCH; p0++) {
      if (++work >= 16384) {
        work = 0;
        yield;
      }
      if (comp[p0] !== 0 || !isLand(p0)) continue;
      const id = comps.length;
      const c: Comp = { n: 0, sx: 0, sz: 0, peakH: -1e9, peakP: p0, x0: 1e9, z0: 1e9, x1: -1e9, z1: -1e9, sandN: 0, sandK: 0, shore: 0 };
      comps.push(c);
      let head = 0;
      let tail = 0;
      q[tail++] = p0;
      comp[p0] = id;
      while (head < tail) {
        const p = q[head++];
        const pi = p % NP;
        const pk = (p / NP) | 0;
        c.n++;
        c.sx += pi;
        c.sz += pk;
        if (pi < c.x0) c.x0 = pi;
        if (pi > c.x1) c.x1 = pi;
        if (pk < c.z0) c.z0 = pk;
        if (pk > c.z1) c.z1 = pk;
        if (h[p] > c.peakH) {
          c.peakH = h[p];
          c.peakP = p;
        }
        if (f.sand[p] >= 0.3) {
          c.sandN++;
          c.sandK += sandKindAt(p);
        }
        let seaSides = 0;
        if (pi > 0) {
          const nb = p - 1;
          if (isLand(nb)) {
            if (comp[nb] === 0) {
              comp[nb] = id;
              q[tail++] = nb;
            }
          } else seaSides++;
        }
        if (pi < NP - 1) {
          const nb = p + 1;
          if (isLand(nb)) {
            if (comp[nb] === 0) {
              comp[nb] = id;
              q[tail++] = nb;
            }
          } else seaSides++;
        }
        if (pk > 0) {
          const nb = p - NP;
          if (isLand(nb)) {
            if (comp[nb] === 0) {
              comp[nb] = id;
              q[tail++] = nb;
            }
          } else seaSides++;
        }
        if (pk < NP - 1) {
          const nb = p + NP;
          if (isLand(nb)) {
            if (comp[nb] === 0) {
              comp[nb] = id;
              q[tail++] = nb;
            }
          } else seaSides++;
        }
        c.shore += seaSides;
      }
      work += tail;
    }
    yield;

    // ---------- overlap with the previous labelling ----------
    const overlap = new Map<number, number>(); // comp * 65536 + oldId -> patches
    for (let p = 0; p < NPATCH; p++) {
      if ((p & 16383) === 16383) yield;
      const c = comp[p];
      const o = prev[p];
      if (c !== 0 && o !== 0) {
        const key = c * 65536 + o;
        overlap.set(key, (overlap.get(key) ?? 0) + 1);
      }
    }
    const pairs = [...overlap.entries()].map(([k, n]) => ({ c: Math.floor(k / 65536), o: k % 65536, n }));
    // Biggest overlap first; ties go to the older (smaller) id, so merges keep the elder name.
    pairs.sort((a, b) => b.n - a.n || a.o - b.o || a.c - b.c);
    const compId = new Int32Array(comps.length);
    const oldTaken = new Set<number>();
    for (const pr of pairs) {
      if (compId[pr.c] !== 0 || oldTaken.has(pr.o) || !recs.has(pr.o)) continue;
      compId[pr.c] = pr.o;
      oldTaken.add(pr.o);
    }
    const events: IslandEvent[] = [];
    const newRecs = new Map<number, IslandRec>();
    // Joins: an old id overlapping a component that kept a different id.
    for (const pr of pairs) {
      const keeper = compId[pr.c];
      if (keeper === 0 || keeper === pr.o || oldTaken.has(pr.o)) continue;
      const lostRec = recs.get(pr.o);
      oldTaken.add(pr.o);
      if (!lostRec) continue;
      this.absorbed.push({ rec: lostRec, into: keeper });
      if (this.absorbed.length > 32) this.absorbed.shift();
      events.push({ kind: 'joined', id: keeper, other: pr.o, otherName: lostRec.name, otherAnnounced: lostRec.announced });
    }
    // New components: revive an absorbed island whose old outline they mostly fill, else a new id.
    for (let c = 1; c < comps.length; c++) {
      if (compId[c] !== 0) continue;
      const cc = comps[c];
      const x0 = patchX(cc.x0);
      const x1 = patchX(cc.x1);
      const z0 = patchZ(cc.z0 * NP);
      const z1 = patchZ(cc.z1 * NP);
      let revived = -1;
      for (let a = this.absorbed.length - 1; a >= 0; a--) {
        const ab = this.absorbed[a];
        if (oldTaken.has(ab.rec.id) || newRecs.has(ab.rec.id)) continue;
        const b = ab.rec.bbox;
        const ix = Math.max(0, Math.min(x1, b[2]) - Math.max(x0, b[0]));
        const iz = Math.max(0, Math.min(z1, b[3]) - Math.max(z0, b[1]));
        const own = Math.max(PATCH_M * PATCH_M, (x1 - x0) * (z1 - z0));
        if ((ix * iz) / own >= 0.5) {
          revived = a;
          break;
        }
      }
      if (revived >= 0) {
        const ab = this.absorbed.splice(revived, 1)[0];
        compId[c] = ab.rec.id;
        oldTaken.add(ab.rec.id);
        newRecs.set(ab.rec.id, { ...ab.rec });
      } else {
        compId[c] = this.nextId++;
        if (this.nextId > 65535) this.nextId = 1;
      }
    }
    // Lost: old ids with no component at all.
    for (const [id, rec] of recs) {
      if (!oldTaken.has(id) && rec.announced) events.push({ kind: 'lost', id, otherName: rec.name });
    }

    yield;
    // ---------- write the staged map and records ----------
    for (let p = 0; p < NPATCH; p++) out[p] = comp[p] === 0 ? 0 : compId[comp[p]];
    yield;
    for (let c = 1; c < comps.length; c++) {
      const cc = comps[c];
      const id = compId[c];
      const old = recs.get(id) ?? newRecs.get(id);
      const area = cc.n * PATCH_M * PATCH_M;
      const rec: IslandRec = old
        ? { ...old }
        : {
            id,
            name: '',
            named: false,
            founded: year,
            announced: false,
            area,
            patches: 0,
            peak: [0, 0, 0],
            centroid: [0, 0],
            bbox: [0, 0, 0, 0],
            places: 0,
            sandKind: 0,
            sandShare: 0,
            shore: 0,
            colonySp: -1,
          };
      rec.area = area;
      rec.patches = cc.n;
      rec.peak = [patchX(cc.peakP), cc.peakH, patchZ(cc.peakP)];
      rec.centroid = [patchX(0) + (cc.sx / cc.n) * PATCH_M, patchZ(0) + (cc.sz / cc.n) * PATCH_M];
      rec.bbox = [patchX(0) + cc.x0 * PATCH_M - PATCH_M / 2, patchZ(0) + cc.z0 * PATCH_M - PATCH_M / 2, patchX(0) + cc.x1 * PATCH_M + PATCH_M / 2, patchZ(0) + cc.z1 * PATCH_M + PATCH_M / 2];
      rec.sandShare = cc.sandN / cc.n;
      rec.sandKind = cc.sandN > 0 ? cc.sandK / cc.sandN : 0;
      rec.shore = cc.shore * PATCH_M;
      newRecs.set(id, rec);
      if (!rec.announced && area >= ANNOUNCE_AREA) events.push({ kind: 'new', id });
    }
    return { map: out, recs: newRecs, events };
  }

  /** Saved state for the labeller (absorbed islands and the id counter). */
  save(): { nextId: number; absorbed: { rec: IslandRec; into: number }[] } {
    return { nextId: this.nextId, absorbed: this.absorbed.map((a) => ({ rec: a.rec, into: a.into })) };
  }
  load(s: { nextId: number; absorbed: { rec: IslandRec; into: number }[] }): void {
    this.nextId = s.nextId;
    this.absorbed = s.absorbed.map((a) => ({ rec: a.rec, into: a.into }));
  }
}

// ---------- names ----------

const COMPASS = ['North', 'South', 'East', 'West'];

/** A pleasant default name from the island's character (the player can rename it). */
export function characterName(rec: IslandRec, hasCliffs: boolean, colonyWord: string | null, taken: Set<string>): string {
  const peak = rec.peak[1];
  const w = rec.bbox[2] - rec.bbox[0];
  const d = rec.bbox[3] - rec.bbox[1];
  const long = Math.max(w, d) > 2.6 * Math.max(8, Math.min(w, d));
  let base: string;
  if (rec.area < ISLET_AREA && colonyWord) base = `${colonyWord} Rock`;
  else if (peak >= 90) base = 'Cloud Mountain';
  else if (peak >= 60) base = 'High Island';
  else if (rec.area < 1500 && peak >= 6) base = 'Stack Rock';
  else if (rec.sandShare >= 0.55 && peak < 12) base = rec.sandKind >= 190 ? 'White Cay' : rec.sandKind <= 80 ? 'Black Sand Cay' : 'Golden Cay';
  else if (hasCliffs && peak >= 15) base = 'Cliff Island';
  else if (long) base = 'Long Island';
  else if (peak >= 25) base = 'Green Hill';
  else if (rec.area < ISLET_AREA) base = 'Little Rock';
  else base = 'Low Island';
  if (!taken.has(base)) return base;
  // Same character as another island: tell them apart by where they lie.
  const [cx, cz] = rec.centroid;
  const order = Math.abs(cz) >= Math.abs(cx) ? (cz < 0 ? [0, 2, 3, 1] : [1, 2, 3, 0]) : cx > 0 ? [2, 0, 1, 3] : [3, 0, 1, 2];
  for (const o of order) {
    const name = `${COMPASS[o]} ${base}`;
    if (!taken.has(name)) return name;
  }
  for (let i = 2; i < 99; i++) {
    const name = `${base} ${i}`;
    if (!taken.has(name)) return name;
  }
  return base;
}
