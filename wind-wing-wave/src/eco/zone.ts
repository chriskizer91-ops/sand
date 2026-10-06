/**
 * The zone job: everything that needs the whole sea at once, re-run about a second after the
 * land settles (and now and then while the years run, for slow changes like soil and age).
 *
 * Order: islands -> distances to the coast -> wind, rain, fog and salt -> ponds and streams ->
 * places. It is a generator, so the work is sliced across engine ticks within the time budget.
 * Its island results are staged and committed between ecology steps, so one step never sees
 * two different island maps.
 */
import { NP, NX, PATCH } from '../config';
import { Habitat, Substrate } from '../content/speciesTypes';
import type { PlaceEvent } from '../engine/protocol';
import { PLACE_KINDS } from './catalog';
import { coastDistances, smoothClimate, windMarch, windwardness } from './climate';
import type { Director } from './director';
import { Flag, LAYERS, NPATCH, type EcoFields } from './fields';
import { Hydro } from './hydro';
import { ISLET_AREA, IslandLabeller, characterName, type IslandLabelResult } from './islands';
import { Features } from './places';
import type { Sweep } from './succession';
import type { EcoWorld } from './world';

/** Shallow sea ring (patches) kept active around land. */
const RING = 2;

export class ZoneJob {
  readonly islNew = new Uint16Array(NPATCH);
  readonly nearNew = new Uint16Array(NPATCH);
  private dLand = new Float32Array(NPATCH);
  readonly labeller = new IslandLabeller();
  readonly hydro = new Hydro();
  readonly features = new Features();
  result: IslandLabelResult | null = null;
  private mask = new Uint8Array(NPATCH);
  /** Per patch: a fingerprint of its surroundings at the last commit (to wake only what changed). */
  private envSig = new Uint32Array(NPATCH);
  private list = new Int32Array(NPATCH);

  *run(w: EcoWorld): Generator<void, void, void> {
    const f = w.f;
    const cols = w.cols;
    const sandKindAt = (p: number): number => cols.sandKind[(p % NP) * PATCH + ((p / NP) | 0) * PATCH * NX];
    const res = this.labeller.label(f, f.isl, w.islands.recs, this.islNew, w.year, sandKindAt);
    yield;
    coastDistances(f, this.islNew, this.nearNew, this.dLand);
    yield;
    windMarch(f, this.islNew);
    yield;
    smoothClimate(f, this.islNew);
    windwardness(
      f,
      this.islNew,
      (id) => res.recs.get(id)?.centroid[0] ?? 0,
      (id) => Math.sqrt((res.recs.get(id)?.area ?? 0) / Math.PI),
    );
    yield;
    yield* this.hydro.run(f, this.islNew, w.year, (id) => res.recs.get(id)?.peak[1] ?? 0);
    for (let p = 0; p < NPATCH; p++) {
      const h = f.h[p];
      f.sub[p] = h <= 0 ? Substrate.Sea : f.flags[p] & Flag.Pond && h < f.pondLvl[p] ? Substrate.Pond : f.bot[p];
    }
    yield;
    yield* this.features.run(f, this.islNew, this.nearNew, res.recs, w.year);
    this.result = res;
  }

  /**
   * Make the staged picture current (between steps). Returns the place events to send.
   */
  commit(w: EcoWorld, sweep: Sweep, director: Director, silent: boolean, shore: (cols: Int32Array, isles: Uint16Array, n: number) => void): PlaceEvent[] {
    const res = this.result;
    if (!res) return [];
    this.result = null;
    const f = w.f;
    const isl = w.islands;
    f.isl.set(this.islNew);
    f.near.set(this.nearNew);
    // ---------- slots ----------
    const oldIds = isl.ids.slice();
    for (const id of oldIds) isl.slotOf[id] = -1;
    const ids = [...res.recs.keys()].sort((a, b) => a - b);
    ids.forEach((id, slot) => (isl.slotOf[id] = slot));
    isl.ids = ids;
    isl.recs = res.recs;
    const joins: [number, number][] = [];
    for (const e of res.events) if (e.kind === 'joined' && e.other !== undefined) joins.push([e.id, e.other]);
    w.remapSlots(oldIds, ids.length, joins);
    // ---------- per-island patch lists ----------
    this.buildLists(w);
    // ---------- places recognised now ----------
    isl.placesNow = new Uint32Array(Math.max(1, ids.length));
    for (let slot = 0; slot < ids.length; slot++) isl.placesNow[slot] = this.features.placesNow.get(ids[slot])?.bits ?? 0;
    // ---------- the active set ----------
    this.buildActive(w, sweep);
    this.wakeChanged(f, sweep);
    // ---------- shoreline columns for the surf and the coast ----------
    this.buildShore(f, shore);
    // ---------- names ----------
    const taken = new Set<string>();
    for (const r of isl.recs.values()) if (r.named || r.name) taken.add(r.name);
    for (const r of isl.recs.values()) {
      if (r.named) continue;
      // Names follow the island's character while it is young; a seabird islet becomes "<Bird> Rock".
      const colonyRock = r.colonySp >= 0 && r.area < ISLET_AREA && !r.name.endsWith(' Rock');
      if (r.name !== '' && w.year - r.founded >= 300 && !colonyRock) continue;
      taken.delete(r.name);
      const sea = this.features.placesNow.get(r.id)?.bits ?? 0;
      const cliffs = (sea & (1 << PLACE_KINDS.indexOf('sea-cliff'))) !== 0;
      const colonyWord = r.colonySp >= 0 ? lastWord(w.t.defs[r.colonySp].name) : null;
      r.name = characterName(r, cliffs, colonyWord, taken);
      taken.add(r.name);
    }
    // ---------- stories ----------
    const events: PlaceEvent[] = [];
    if (silent) {
      for (const r of isl.recs.values()) {
        r.places |= this.features.placesNow.get(r.id)?.bits ?? 0;
        if (r.area >= 400) r.announced = true;
      }
      for (const k of this.features.kipukas) director.kipukas.add(k.key);
      return events;
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
    return events;
  }

  private buildLists(w: EcoWorld): void {
    const f = w.f;
    const isl = w.islands;
    const n = isl.ids.length;
    const landC = new Int32Array(n + 1);
    const shoreC = new Int32Array(n + 1);
    const seaC = new Int32Array(n + 1);
    for (let p = 0; p < NPATCH; p++) {
      const id = f.isl[p];
      if (id !== 0) {
        const s = isl.slotOf[id];
        landC[s + 1]++;
        if (f.flags[p] & Flag.Shore) shoreC[s + 1]++;
      } else if (f.flags[p] & Flag.NearSea && f.near[p] !== 0) seaC[isl.slotOf[f.near[p]] + 1]++;
    }
    for (let s = 0; s < n; s++) {
      landC[s + 1] += landC[s];
      shoreC[s + 1] += shoreC[s];
      seaC[s + 1] += seaC[s];
    }
    isl.landStart = landC.slice();
    isl.shoreStart = shoreC.slice();
    isl.seaStart = seaC.slice();
    isl.land = new Int32Array(landC[n]);
    isl.shore = new Int32Array(shoreC[n]);
    isl.sea = new Int32Array(seaC[n]);
    for (let p = 0; p < NPATCH; p++) {
      const id = f.isl[p];
      if (id !== 0) {
        const s = isl.slotOf[id];
        isl.land[landC[s]++] = p;
        if (f.flags[p] & Flag.Shore) isl.shore[shoreC[s]++] = p;
      } else if (f.flags[p] & Flag.NearSea && f.near[p] !== 0) {
        const s = isl.slotOf[f.near[p]];
        isl.sea[seaC[s]++] = p;
      }
    }
  }

  /** Wake the patches whose surroundings (island, places, climate) changed. */
  private wakeChanged(f: EcoFields, sweep: Sweep): void {
    for (let p = 0; p < NPATCH; p++) {
      let h = Math.imul(f.flags[p] ^ (f.isl[p] << 7) ^ (f.near[p] << 13), 0x9e3779b1) ^ f.geoMask[p];
      h = Math.imul(h ^ ((f.rain[p] * 32) | 0) ^ (((f.fog[p] * 32) | 0) << 6) ^ (((f.salt[p] * 32) | 0) << 12) ^ (f.sub[p] << 20), 0x85ebca6b);
      h = (h ^ (h >>> 15)) >>> 0;
      if (h !== this.envSig[p]) {
        this.envSig[p] = h;
        sweep.wake(p);
      }
    }
  }

  /** Land, shallow sea near islands, and a ring around the land: the patches that live. */
  private buildActive(w: EcoWorld, sweep: Sweep): void {
    const f = w.f;
    const mask = this.mask;
    mask.fill(0);
    for (let p = 0; p < NPATCH; p++) {
      if (f.isl[p] === 0 && f.h[p] <= 0) {
        // Shallow sea near an island lives; so does anything still growing where an island was.
        const o = p * LAYERS;
        if (f.flags[p] & Flag.NearSea || f.sp[o] | f.sp[o + 1] | f.sp[o + 2] | f.sp[o + 3]) mask[p] = 1;
        continue;
      }
      const pi = p % NP;
      const pk = (p / NP) | 0;
      for (let dz = -RING; dz <= RING; dz++) {
        const kk = pk + dz;
        if (kk < 0 || kk >= NP) continue;
        for (let dx = -RING; dx <= RING; dx++) {
          const ii = pi + dx;
          if (ii >= 0 && ii < NP) mask[ii + kk * NP] = 1;
        }
      }
    }
    let n = 0;
    for (let p = 0; p < NPATCH; p++) {
      if (mask[p]) this.list[n++] = p;
      else {
        // Open water nobody simulates still tells the page what it is.
        const hab = f.h[p] < -25 ? Habitat.DeepSea : Habitat.OpenSea;
        if (f.hab[p] !== hab) {
          f.hab[p] = hab;
          f.lifeMask[p] = f.geoMask[p];
          sweep.markChanged(p);
        }
      }
    }
    sweep.setActive(this.list, n);
  }

  /** Columns along every shore (land within 8 m of the sea, and the shallow water beside it). */
  private buildShore(f: EcoFields, shore: (cols: Int32Array, isles: Uint16Array, n: number) => void): void {
    let n = 0;
    for (let p = 0; p < NPATCH; p++) if (this.isShore(f, p)) n++;
    const cols = new Int32Array(n * PATCH * PATCH);
    const isles = new Uint16Array(n * PATCH * PATCH);
    let k = 0;
    for (let p = 0; p < NPATCH; p++) {
      if (!this.isShore(f, p)) continue;
      const c0 = (p % NP) * PATCH + ((p / NP) | 0) * PATCH * NX;
      const id = f.isl[p] || f.near[p];
      for (let dz = 0; dz < PATCH; dz++) {
        for (let dx = 0; dx < PATCH; dx++) {
          cols[k] = c0 + dx + dz * NX;
          isles[k++] = id;
        }
      }
    }
    shore(cols, isles, k);
  }

  private isShore(f: EcoFields, p: number): boolean {
    if (f.isl[p] !== 0) return (f.flags[p] & Flag.Shore) !== 0 && f.h[p] < 6;
    return f.h[p] > -4 && f.coast[p] <= 2 * PATCH * 2 + 0.1 && f.near[p] !== 0;
  }
}

function lastWord(name: string): string {
  const parts = name.trim().split(/\s+/);
  const w = parts[parts.length - 1] ?? name;
  return w.charAt(0).toUpperCase() + w.slice(1);
}
