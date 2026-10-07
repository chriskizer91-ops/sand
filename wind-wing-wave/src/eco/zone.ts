/**
 * The zone job: everything that needs the whole sea at once, re-run about a second after the
 * land settles (and now and then while the years run, for slow changes like soil and age).
 *
 * Order: islands -> distances to the coast -> wind, rain, fog and salt -> ponds and streams ->
 * places. It is a generator, so the work is sliced across engine ticks within the time budget.
 *
 * Nothing the rest of the simulation reads changes while the job runs: it writes the derived
 * fields into its own staged copies (ZoneOut), and the islands, ponds and places it finds wait
 * too. commit() then installs the whole new picture between two ecology steps, itself in a few
 * short slices: the expensive parts are prepared first, and only the final, quick slices change
 * what others see. So one step never sees two different island maps, and the page never sees a
 * stream or a pond vanish for a moment.
 */
import { NP, NX, PATCH } from '../config';
import { Habitat, Substrate } from '../content/speciesTypes';
import type { PlaceEvent } from '../engine/protocol';
import { PLACE_KINDS } from './catalog';
import { coastDistances, smoothClimate, windMarch, windwardness } from './climate';
import type { Director } from './director';
import { Flag, LAYERS, NPATCH, type EcoFields, type ZoneFields } from './fields';
import { Hydro } from './hydro';
import { ISLET_AREA, IslandLabeller, characterName, type IslandLabelResult } from './islands';
import { Features } from './places';
import type { Sweep } from './succession';
import type { EcoWorld } from './world';

/** Shallow sea ring (patches) kept active around land. */
const RING = 2;
/** Rows of patches per slice in the commit's preparation passes. */
const BAND = 64;

/** The zone job's own copies of the derived fields it writes. */
class ZoneOut {
  readonly coast = new Float32Array(NPATCH);
  readonly rain = new Float32Array(NPATCH);
  readonly fog = new Float32Array(NPATCH);
  readonly salt = new Float32Array(NPATCH);
  readonly wind = new Float32Array(NPATCH);
  readonly pondLvl = new Float32Array(NPATCH);
  readonly pondId = new Uint16Array(NPATCH);
  readonly flow = new Float32Array(NPATCH);
  readonly shelter = new Float32Array(NPATCH);
  readonly flags = new Uint32Array(NPATCH);
  readonly geoMask = new Uint32Array(NPATCH);
  readonly sub = new Uint8Array(NPATCH);
}

/** Per-island patch lists, built ahead of the install. */
interface Lists {
  landStart: Int32Array;
  land: Int32Array;
  shoreStart: Int32Array;
  shore: Int32Array;
  seaStart: Int32Array;
  sea: Int32Array;
}

/** Called with the shoreline columns (for the surf and the years-time coast) at install. */
export type ShoreSink = (cols: Int32Array, isles: Uint16Array, n: number) => void;

export class ZoneJob {
  readonly islNew = new Uint16Array(NPATCH);
  readonly nearNew = new Uint16Array(NPATCH);
  private dLand = new Float32Array(NPATCH);
  readonly labeller = new IslandLabeller();
  readonly hydro = new Hydro();
  readonly features = new Features();
  private readonly out = new ZoneOut();
  private view: ZoneFields | null = null;
  private result: IslandLabelResult | null = null;
  private mask = new Uint8Array(NPATCH);
  /** Per patch: a fingerprint of its surroundings at the last install (to wake only what changed). */
  private envSig = new Uint32Array(NPATCH);
  private envNext = new Uint32Array(NPATCH);
  private list = new Int32Array(NPATCH);
  private listN = 0;

  /** A finished run is waiting to be installed. */
  get ready(): boolean {
    return this.result !== null;
  }

  /** The job reads the ground and life live, and writes its own staged copies. */
  private viewOf(f: EcoFields): ZoneFields {
    if (!this.view) {
      const o = this.out;
      this.view = {
        h: f.h,
        hmin: f.hmin,
        hmax: f.hmax,
        slope: f.slope,
        sand: f.sand,
        bot: f.bot,
        born: f.born,
        soil: f.soil,
        warm: f.warm,
        sp: f.sp,
        cov: f.cov,
        coast: o.coast,
        rain: o.rain,
        fog: o.fog,
        salt: o.salt,
        wind: o.wind,
        pondLvl: o.pondLvl,
        pondId: o.pondId,
        flow: o.flow,
        shelter: o.shelter,
        flags: o.flags,
        geoMask: o.geoMask,
      };
    }
    return this.view;
  }

  *run(w: EcoWorld): Generator<void, void, void> {
    const f = w.f;
    const v = this.viewOf(f);
    const cols = w.cols;
    const sandKindAt = (p: number): number => cols.sandKind[(p % NP) * PATCH + ((p / NP) | 0) * PATCH * NX];
    this.result = null;
    const res = yield* this.labeller.labelSliced(v, f.isl, w.islands.recs, this.islNew, w.year, sandKindAt);
    yield;
    yield* coastDistances(v, this.islNew, this.nearNew, this.dLand);
    yield;
    yield* windMarch(v, this.islNew);
    yield;
    yield* smoothClimate(v, this.islNew);
    yield;
    yield* windwardness(
      v,
      this.islNew,
      (id) => res.recs.get(id)?.centroid[0] ?? 0,
      (id) => Math.sqrt((res.recs.get(id)?.area ?? 0) / Math.PI),
    );
    yield;
    yield* this.hydro.run(v, this.islNew, w.year, (id) => res.recs.get(id)?.peak[1] ?? 0);
    yield;
    yield* this.features.run(v, this.islNew, this.nearNew, res.recs, w.year);
    this.result = res;
  }

  /**
   * Install the finished run (between steps), in slices. The first slices only prepare (patch
   * lists, the active set, what changed around each patch); the last two swap the new picture
   * in. Place and island stories go to the director (unless `silent`, for a fresh world or a
   * loaded save) and the place events into `events`.
   */
  *commit(w: EcoWorld, sweep: Sweep, director: Director, silent: boolean, events: PlaceEvent[], shore: ShoreSink): Generator<void, void, void> {
    const res = this.result;
    if (!res) return;
    const f = w.f;
    const o = this.out;
    const isl = w.islands;
    // ---------- prepare: nothing anyone reads changes yet ----------
    const ids = [...res.recs.keys()].sort((a, b) => a - b);
    const slotOf = new Map<number, number>();
    ids.forEach((id, slot) => slotOf.set(id, slot));
    const lists = this.buildLists(ids.length, slotOf);
    yield;
    yield* this.buildActive(f);
    // Water inside a pond is pond ground; dry land is its own material; the rest is sea.
    for (let p = 0; p < NPATCH; p++) {
      const h = f.h[p];
      o.sub[p] = h <= 0 ? Substrate.Sea : o.flags[p] & Flag.Pond && h < o.pondLvl[p] ? Substrate.Pond : f.bot[p];
    }
    yield;
    yield* this.signatures();
    const [shoreCols, shoreIsles, shoreN] = this.buildShore(f);
    yield;
    // ---------- install the derived fields ----------
    f.coast.set(o.coast);
    f.rain.set(o.rain);
    f.fog.set(o.fog);
    f.salt.set(o.salt);
    f.wind.set(o.wind);
    f.pondLvl.set(o.pondLvl);
    f.pondId.set(o.pondId);
    f.flow.set(o.flow);
    f.shelter.set(o.shelter);
    f.flags.set(o.flags);
    f.geoMask.set(o.geoMask);
    f.sub.set(o.sub);
    this.hydro.commit();
    this.features.commit();
    yield;
    // ---------- install the islands ----------
    this.result = null;
    f.isl.set(this.islNew);
    f.near.set(this.nearNew);
    const oldIds = isl.ids.slice();
    for (const id of oldIds) isl.slotOf[id] = -1;
    ids.forEach((id, slot) => (isl.slotOf[id] = slot));
    isl.ids = ids;
    isl.recs = res.recs;
    const joins: [number, number][] = [];
    for (const e of res.events) if (e.kind === 'joined' && e.other !== undefined) joins.push([e.id, e.other]);
    w.remapSlots(oldIds, ids.length, joins);
    isl.landStart = lists.landStart;
    isl.land = lists.land;
    isl.shoreStart = lists.shoreStart;
    isl.shore = lists.shore;
    isl.seaStart = lists.seaStart;
    isl.sea = lists.sea;
    isl.placesNow = new Uint32Array(Math.max(1, ids.length));
    for (let slot = 0; slot < ids.length; slot++) isl.placesNow[slot] = this.features.placesNow.get(ids[slot])?.bits ?? 0;
    this.installActive(f, sweep);
    // Wake the patches whose surroundings changed.
    const sig = this.envSig;
    const next = this.envNext;
    for (let p = 0; p < NPATCH; p++) {
      if (sig[p] !== next[p]) sweep.wake(p);
    }
    this.envSig = next;
    this.envNext = sig;
    sweep.recountDue = true;
    shore(shoreCols, shoreIsles, shoreN);
    this.name(w);
    // ---------- stories ----------
    if (silent) {
      for (const r of isl.recs.values()) {
        r.places |= this.features.placesNow.get(r.id)?.bits ?? 0;
        if (r.area >= 400) r.announced = true;
      }
      for (const k of this.features.kipukas) director.kipukas.add(k.key);
      return;
    }
    director.onIslandEvents(res.events);
    for (const r of isl.recs.values()) {
      const now = this.features.placesNow.get(r.id);
      if (!now) continue;
      const fresh = now.bits & ~r.places;
      if (fresh === 0) continue;
      r.places |= fresh;
      for (let k = 0; k < PLACE_KINDS.length; k++) {
        if (!(fresh & (1 << k))) continue;
        const at = this.features.spot(r.id, k) ?? [r.centroid[0], r.centroid[1]];
        const first = director.onPlace(PLACE_KINDS[k], r.id, at[0], at[1]);
        events.push({ kind: PLACE_KINDS[k], x: at[0], z: at[1], island: r.id, first });
      }
    }
    for (const k of this.features.kipukas) director.onKipuka(k.key, k.island, k.x, k.z);
    director.tellBurns();
  }

  /** Default names: they follow an island's character while it is young (unless the player named it). */
  private name(w: EcoWorld): void {
    const isl = w.islands;
    const taken = new Set<string>();
    for (const r of isl.recs.values()) if (r.named || r.name) taken.add(r.name);
    for (const r of isl.recs.values()) {
      if (r.named) continue;
      // A seabird islet becomes "<Bird> Rock".
      const colonyRock = r.colonySp >= 0 && r.area < ISLET_AREA && !r.name.endsWith(' Rock');
      if (r.name !== '' && w.year - r.founded >= 300 && !colonyRock) continue;
      taken.delete(r.name);
      const sea = this.features.placesNow.get(r.id)?.bits ?? 0;
      const cliffs = (sea & (1 << PLACE_KINDS.indexOf('sea-cliff'))) !== 0;
      const colonyWord = r.colonySp >= 0 ? lastWord(w.t.defs[r.colonySp].name) : null;
      r.name = characterName(r, cliffs, colonyWord, taken);
      taken.add(r.name);
    }
  }

  /** Land, shore and nearby-sea patch lists per island (new slot numbering). */
  private buildLists(n: number, slotOf: Map<number, number>): Lists {
    const flags = this.out.flags;
    const isl = this.islNew;
    const near = this.nearNew;
    const slot = new Int32Array(65536).fill(-1);
    for (const [id, s] of slotOf) slot[id] = s;
    const landC = new Int32Array(n + 1);
    const shoreC = new Int32Array(n + 1);
    const seaC = new Int32Array(n + 1);
    for (let p = 0; p < NPATCH; p++) {
      const id = isl[p];
      if (id !== 0) {
        const s = slot[id];
        landC[s + 1]++;
        if (flags[p] & Flag.Shore) shoreC[s + 1]++;
      } else if (flags[p] & Flag.NearSea && near[p] !== 0 && slot[near[p]] >= 0) seaC[slot[near[p]] + 1]++;
    }
    for (let s = 0; s < n; s++) {
      landC[s + 1] += landC[s];
      shoreC[s + 1] += shoreC[s];
      seaC[s + 1] += seaC[s];
    }
    const out: Lists = {
      landStart: landC.slice(),
      shoreStart: shoreC.slice(),
      seaStart: seaC.slice(),
      land: new Int32Array(landC[n]),
      shore: new Int32Array(shoreC[n]),
      sea: new Int32Array(seaC[n]),
    };
    for (let p = 0; p < NPATCH; p++) {
      const id = isl[p];
      if (id !== 0) {
        const s = slot[id];
        out.land[landC[s]++] = p;
        if (flags[p] & Flag.Shore) out.shore[shoreC[s]++] = p;
      } else if (flags[p] & Flag.NearSea && near[p] !== 0 && slot[near[p]] >= 0) out.sea[seaC[slot[near[p]]]++] = p;
    }
    return out;
  }

  /** Land, shallow sea near islands, and a ring around the land: the patches that live (into this.list). */
  private *buildActive(f: EcoFields): Generator<void, void, void> {
    const mask = this.mask;
    const isl = this.islNew;
    const flags = this.out.flags;
    mask.fill(0);
    for (let pk = 0; pk < NP; pk++) {
      if (pk % BAND === BAND - 1) yield;
      for (let pi = 0; pi < NP; pi++) {
        const p = pi + pk * NP;
        if (isl[p] === 0 && f.h[p] <= 0) {
          // Shallow sea near an island lives; so does anything still growing where an island was.
          const o = p * LAYERS;
          if (flags[p] & Flag.NearSea || f.sp[o] | f.sp[o + 1] | f.sp[o + 2] | f.sp[o + 3]) mask[p] = 1;
          continue;
        }
        for (let dz = -RING; dz <= RING; dz++) {
          const kk = pk + dz;
          if (kk < 0 || kk >= NP) continue;
          for (let dx = -RING; dx <= RING; dx++) {
            const ii = pi + dx;
            if (ii >= 0 && ii < NP) mask[ii + kk * NP] = 1;
          }
        }
      }
    }
    let n = 0;
    for (let p = 0; p < NPATCH; p++) if (mask[p]) this.list[n++] = p;
    this.listN = n;
  }

  /** Make the prepared active set current; open water nobody simulates still tells the page what it is. */
  private installActive(f: EcoFields, sweep: Sweep): void {
    const mask = this.mask;
    for (let p = 0; p < NPATCH; p++) {
      if (mask[p]) continue;
      const hab = f.h[p] < -25 ? Habitat.DeepSea : Habitat.OpenSea;
      if (f.hab[p] !== hab) {
        f.hab[p] = hab;
        f.lifeMask[p] = f.geoMask[p];
        sweep.markChanged(p);
      }
    }
    sweep.setActive(this.list, this.listN);
  }

  /** Fingerprints of each patch's new surroundings (island, places, climate) into envNext. */
  private *signatures(): Generator<void, void, void> {
    const o = this.out;
    const isl = this.islNew;
    const near = this.nearNew;
    const next = this.envNext;
    for (let p = 0; p < NPATCH; p++) {
      if ((p & 16383) === 16383) yield;
      let h = Math.imul(o.flags[p] ^ (isl[p] << 7) ^ (near[p] << 13), 0x9e3779b1) ^ o.geoMask[p];
      h = Math.imul(h ^ ((o.rain[p] * 32) | 0) ^ (((o.fog[p] * 32) | 0) << 6) ^ (((o.salt[p] * 32) | 0) << 12) ^ (o.sub[p] << 20), 0x85ebca6b);
      next[p] = (h ^ (h >>> 15)) >>> 0;
    }
  }

  /** Columns along every shore (land within 8 m of the sea, and the shallow water beside it). */
  private buildShore(f: EcoFields): [Int32Array, Uint16Array, number] {
    let n = 0;
    for (let p = 0; p < NPATCH; p++) if (this.isShore(f, p)) n++;
    const cols = new Int32Array(n * PATCH * PATCH);
    const isles = new Uint16Array(n * PATCH * PATCH);
    let k = 0;
    for (let p = 0; p < NPATCH; p++) {
      if (!this.isShore(f, p)) continue;
      const c0 = (p % NP) * PATCH + ((p / NP) | 0) * PATCH * NX;
      const id = this.islNew[p] || this.nearNew[p];
      for (let dz = 0; dz < PATCH; dz++) {
        for (let dx = 0; dx < PATCH; dx++) {
          cols[k] = c0 + dx + dz * NX;
          isles[k++] = id;
        }
      }
    }
    return [cols, isles, k];
  }

  private isShore(f: EcoFields, p: number): boolean {
    if (this.islNew[p] !== 0) return (this.out.flags[p] & Flag.Shore) !== 0 && f.h[p] < 6;
    return f.h[p] > -4 && this.out.coast[p] <= 2 * PATCH * 2 + 0.1 && this.nearNew[p] !== 0;
  }
}

function lastWord(name: string): string {
  const parts = name.trim().split(/\s+/);
  const w = parts[parts.length - 1] ?? name;
  return w.charAt(0).toUpperCase() + w.slice(1);
}
