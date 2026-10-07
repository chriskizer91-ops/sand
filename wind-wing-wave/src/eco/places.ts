/**
 * Reading the shape of the land: cliffs, beaches, dunes, lagoons, reefs, the Sound…
 *
 * Every feature here comes from the ground alone (heights, sand, rock, water), so it can be
 * recognised the moment the land settles (feedback guarantee 1: "places are recognised
 * within 3 s"). Living things come later and are judged against these.
 *
 * Sea patches look along 8 rays to find how enclosed they are by land:
 * - shelter: the share of directions blocked within 240 m (the east, upwind ray counts double);
 * - lagoon: shallow water blocked on most sides;
 * - the Sound: deep water (6 m or more) ringed within 400 m by three or more islands.
 * Rays are cast from a coarse 16 m lattice and shared with the patches around each point:
 * shelter changes slowly across open water, and this keeps the job cheap on a phone.
 */
import { NP, PATCH_M } from '../config';
import { Habitat, Substrate, type PlaceKind } from '../content/speciesTypes';
import type { PeakInfo } from '../engine/protocol';
import { PLACE_KINDS } from './catalog';
import { CLOUD_BASE, CLOUD_TOP } from './climate';
import { Flag, LAYERS, NPATCH, habBit, patchAt, patchX, patchZ, type ZoneFields } from './fields';
import { ANNOUNCE_AREA, ISLET_AREA, type IslandRec } from './islands';

const HYDRO_FLAGS = Flag.Pond | Flag.SaltPond | Flag.Marsh | Flag.Stream | Flag.Mouth | Flag.Basin;
const RAY_SHELTER = 60; // patches (240 m)
const RAY_SOUND = 100; // patches (400 m)
/** Ray lattice spacing (patches). */
const RS = 4;
const SOUND_ISLAND_AREA = 2000;
const SOUND_MIN_PATCHES = 40;
const STACK_AREA = 12 * PATCH_M * PATCH_M;
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DZ = [0, 1, 1, 1, 0, -1, -1, -1];

/** Patches needed before each kind of place is recognised on an island. */
const NEED: Record<PlaceKind, number> = {
  'lava-field': 25,
  'sea-cliff': 3,
  'sea-stack': 1,
  beach: 4,
  'turtle-beach': 8,
  dune: 6,
  'rock-shore': 8,
  'rock-basin': 3,
  pond: 2,
  'salt-pond': 2,
  stream: 4,
  lagoon: 25,
  reef: 12,
  seagrass: 12,
  'mangrove-shore': 6,
  'cloud-peak': 1,
  'rain-shadow': 20,
  summit: 3,
  'warm-ground': 4,
  islet: 1,
  spit: 5,
  sound: 1,
};
const NK = PLACE_KINDS.length;
const K = (k: PlaceKind): number => PLACE_KINDS.indexOf(k);
const K_LAVA = K('lava-field');
const K_CLIFF = K('sea-cliff');
const K_STACK = K('sea-stack');
const K_BEACH = K('beach');
const K_TURTLE = K('turtle-beach');
const K_DUNE = K('dune');
const K_ROCKSHORE = K('rock-shore');
const K_BASIN = K('rock-basin');
const K_POND = K('pond');
const K_SALT = K('salt-pond');
const K_STREAM = K('stream');
const K_LAGOON = K('lagoon');
const K_REEF = K('reef');
const K_SEAGRASS = K('seagrass');
const K_MANGROVE = K('mangrove-shore');
const K_CLOUD = K('cloud-peak');
const K_SHADOW = K('rain-shadow');
const K_SUMMIT = K('summit');
const K_WARM = K('warm-ground');
const K_ISLET = K('islet');
const K_SPIT = K('spit');
const K_SOUND = K('sound');

export interface SoundRec {
  x: number;
  z: number;
  r: number;
  /** Islands around it. */
  islands: number[];
}

export interface PlacesNow {
  bits: number;
  /** Sums of x, z and counts per place kind (centre = sum / count). */
  x: Float64Array;
  z: Float64Array;
  n: Float64Array;
}

/** What one run of the features finds; made current by commit() with the rest of the zone job. */
interface FeatureSet {
  sound: SoundRec | null;
  peaks: PeakInfo[];
  placesNow: Map<number, PlacesNow>;
  kipukas: { key: string; island: number; x: number; z: number }[];
}

/** Ground-made features for the whole zone. Scratch arrays are kept between runs. */
export class Features {
  private ray240 = new Uint8Array(NPATCH);
  private ray400 = new Uint8Array(NPATCH);
  private rayEast = new Uint8Array(NPATCH);
  private rayDistinct = new Uint8Array(NPATCH);
  private hitIsl = new Int32Array(8);
  private comp = new Int32Array(NPATCH);
  private queue = new Int32Array(NPATCH);
  private oldVeg = new Uint8Array(NPATCH);
  private areaOf = new Float32Array(65536);
  private peakOf = new Float32Array(65536);
  private index = new Int32Array(65536);
  sound: SoundRec | null = null;
  peaks: PeakInfo[] = [];
  /** Per island id: recognised places now and where. */
  placesNow = new Map<number, PlacesNow>();
  /** Kipukas found by the last run (rounded centre key, island and position). */
  kipukas: { key: string; island: number; x: number; z: number }[] = [];
  /** The running job's results, waiting for commit(). */
  private next: FeatureSet = { sound: null, peaks: [], placesNow: new Map(), kipukas: [] };

  /** Make the last finished run current (between ecology steps, with the islands). */
  commit(): void {
    const n = this.next;
    this.sound = n.sound;
    this.peaks = n.peaks;
    this.placesNow = n.placesNow;
    this.kipukas = n.kipukas;
    this.next = { sound: null, peaks: [], placesNow: new Map(), kipukas: [] };
  }

  /**
   * Recompute every ground feature into the job's staged fields (a generator: yields between
   * slices of work). The results become current at commit().
   */
  *run(f: ZoneFields, isl: Uint16Array, near: Uint16Array, recs: Map<number, IslandRec>, year: number): Generator<void, void, void> {
    const h = f.h;
    const areaOf = this.areaOf;
    const peakOf = this.peakOf;
    let bigIslands = 0;
    for (const r of recs.values()) {
      areaOf[r.id] = r.area;
      peakOf[r.id] = r.peak[1];
      if (r.area >= SOUND_ISLAND_AREA) bigIslands++;
    }
    // ---------- land features ----------
    let freshLava = 0;
    for (let p = 0; p < NPATCH; p++) {
      if ((p & 16383) === 16383) yield;
      let fl = f.flags[p] & HYDRO_FLAGS;
      const id = isl[p];
      if (id !== 0) {
        const pi = p % NP;
        const pk = (p / NP) | 0;
        const hp = h[p];
        const coast = f.coast[p];
        const bot = f.bot[p];
        const rock = bot === Substrate.Basalt || bot === Substrate.Stone || bot === Substrate.Limestone;
        if (coast <= 2 * PATCH_M + 0.1) fl |= Flag.Shore;
        if (hp >= CLOUD_TOP) fl |= Flag.Summit;
        else if (hp >= CLOUD_BASE && f.fog[p] >= 0.2) fl |= Flag.CloudBelt;
        if (f.slope[p] >= 50 && f.hmax[p] - f.hmin[p] >= 2.5) fl |= Flag.Cliff;
        if (coast <= 2 * PATCH_M + 0.1 && f.hmax[p] >= 8 && rock) {
          let low = 1e9;
          for (let dz = -2; dz <= 2; dz++) {
            const kk = pk + dz;
            if (kk < 0 || kk >= NP) continue;
            for (let dx = -2; dx <= 2; dx++) {
              const ii = pi + dx;
              if (ii < 0 || ii >= NP) continue;
              const v = h[ii + kk * NP];
              if (v < low) low = v;
            }
          }
          if (f.hmax[p] - Math.max(0, low) >= 8 && low <= 1) fl |= Flag.SeaCliff | Flag.Cliff;
        }
        if (bot === Substrate.Sand) {
          if (hp <= 3.2 && f.slope[p] <= 14 && coast <= 3 * PATCH_M + 0.1) fl |= Flag.Beach;
          else if (hp >= 2 && f.sand[p] >= 0.8 && coast <= 80) fl |= Flag.Dune;
          if (coast <= 3 * PATCH_M + 0.1 && seaBothSides(h, isl, pi, pk)) fl |= Flag.Spit;
        } else if (rock && coast <= PATCH_M + 0.1 && hp <= 5 && !(fl & Flag.SeaCliff)) fl |= Flag.RockShore;
        if (bot === Substrate.HotLava || (bot === Substrate.Basalt && year - f.born[p] < 50)) freshLava++;
        if (f.warm[p] >= 0.25) fl |= Flag.Warm;
        const a = areaOf[id];
        if (a < ISLET_AREA) fl |= Flag.Islet;
        if (a <= STACK_AREA && peakOf[id] >= 5) fl |= Flag.Stack;
        if (peakOf[id] >= CLOUD_BASE && f.wind[p] < -0.15 && f.rain[p] < 0.3) fl |= Flag.RainShadow;
      }
      f.flags[p] = fl;
    }
    yield;
    // Turtle beaches: beach that runs inland, gentle and sandy, at least 12 m deep.
    for (let p = 0; p < NPATCH; p++) {
      if (!(f.flags[p] & Flag.Beach)) continue;
      const pi = p % NP;
      const pk = (p / NP) | 0;
      let wide = false;
      for (let dz = -3; dz <= 3 && !wide; dz++) {
        const kk = pk + dz;
        if (kk < 0 || kk >= NP) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const ii = pi + dx;
          if (ii < 0 || ii >= NP) continue;
          const q = ii + kk * NP;
          if (isl[q] === isl[p] && f.bot[q] === Substrate.Sand && f.coast[q] >= f.coast[p] + 2 * PATCH_M && h[q] <= 6 && f.slope[q] <= 10) {
            wide = true;
            break;
          }
        }
      }
      if (wide) f.flags[p] |= Flag.TurtleBeach;
    }
    yield;
    // ---------- sea: rays for shelter, lagoons and the Sound ----------
    const reach = bigIslands >= 3 ? RAY_SOUND : RAY_SHELTER;
    const ray240 = this.ray240;
    const ray400 = this.ray400;
    const rayEast = this.rayEast;
    const rayDistinct = this.rayDistinct;
    const hitIsl = this.hitIsl;
    for (let pk = 0; pk < NP; pk += RS) {
      for (let pi = 0; pi < NP; pi += RS) {
        const p = pi + pk * NP;
        ray240[p] = 0;
        ray400[p] = 0;
        rayEast[p] = 0;
        rayDistinct[p] = 0;
        if (isl[p] !== 0 || f.coast[p] > reach * PATCH_M) continue;
        // Nothing can be hit closer than the nearest land.
        const skip = Math.max(0, Math.floor(f.coast[p] / (PATCH_M * Math.SQRT2)) - 1);
        let hits240 = 0;
        let hits400 = 0;
        for (let d = 0; d < 8; d++) {
          const dx = DX[d];
          const dz = DZ[d];
          hitIsl[d] = 0;
          let ii = pi + dx * skip;
          let kk = pk + dz * skip;
          for (let st = skip + 1; st <= reach; st++) {
            ii += dx;
            kk += dz;
            if (ii < 0 || kk < 0 || ii >= NP || kk >= NP) break;
            const id = isl[ii + kk * NP];
            if (id === 0) continue;
            hitIsl[d] = id;
            const dist = dx !== 0 && dz !== 0 ? st * 1.414 : st;
            if (dist <= RAY_SHELTER) {
              hits240++;
              if (d === 0) rayEast[p] = 1;
            }
            if (dist <= RAY_SOUND) hits400++;
            break;
          }
        }
        ray240[p] = hits240;
        ray400[p] = hits400;
        if (bigIslands >= 3 && hits400 >= 6) {
          let distinct = 0;
          for (let d = 0; d < 8; d++) {
            const id = hitIsl[d];
            if (id === 0 || areaOf[id] < SOUND_ISLAND_AREA) continue;
            let seen = false;
            for (let e = 0; e < d; e++) if (hitIsl[e] === id) seen = true;
            if (!seen) distinct++;
          }
          rayDistinct[p] = distinct;
        }
      }
      if ((pk & 15) === 12) yield;
    }
    for (let p = 0; p < NPATCH; p++) {
      if ((p & 16383) === 16383) yield;
      f.shelter[p] = 0;
      if (isl[p] !== 0 || h[p] > 0) continue;
      const pi = p % NP;
      const pk = (p / NP) | 0;
      // The nearest lattice point (rounded), clamped into the zone.
      const ri = Math.min(NP - RS, ((pi + (RS >> 1)) / RS) | 0) * RS;
      const rk = Math.min(NP - RS, ((pk + (RS >> 1)) / RS) | 0) * RS;
      const r = ri + rk * NP;
      const near240 = ray240[r];
      const eastNear = rayEast[r];
      const shelter = (near240 + eastNear) / 9;
      f.shelter[p] = shelter;
      const depth = -h[p];
      let fl = f.flags[p];
      if (near[p] !== 0 && depth <= 25) fl |= Flag.NearSea;
      if (depth <= 15 && (near240 >= 6 || (near240 >= 5 && eastNear))) fl |= Flag.Lagoon;
      if (depth >= 6 && ray400[r] >= 6 && rayDistinct[r] >= 3) fl |= Flag.Sound;
      if (fl & Flag.NearSea) {
        const bot = f.bot[p];
        const hard = bot === Substrate.Basalt || bot === Substrate.Stone || bot === Substrate.Limestone;
        const young = bot === Substrate.HotLava || (bot === Substrate.Basalt && year - f.born[p] < 30);
        if (hard && !young && depth >= 0.3 && !(fl & Flag.Mouth)) fl |= Flag.ReefZone;
        if (bot === Substrate.Sand && depth >= 0.5 && depth <= 12 && (shelter >= 0.3 || (depth >= 4 && shelter >= 0.15))) fl |= Flag.SeagrassZone;
        if (depth <= 1.2 && shelter >= 0.45 && f.slope[p] <= 8) fl |= Flag.MangroveZone;
      }
      f.flags[p] = fl;
    }
    // Low sheltered shore next to mangrove water is mangrove shore too.
    for (let pk = 1; pk < NP - 1; pk++) {
      for (let pi = 1; pi < NP - 1; pi++) {
        const p = pi + pk * NP;
        if (isl[p] === 0 || h[p] > 0.6 || f.slope[p] > 8) continue;
        const nb = f.flags[p - 1] | f.flags[p + 1] | f.flags[p - NP] | f.flags[p + NP];
        if (nb & Flag.MangroveZone) f.flags[p] |= Flag.MangroveZone;
      }
    }
    yield;
    const next = this.next;
    next.sound = bigIslands >= 3 ? this.findSound(f, isl) : null;
    next.kipukas = [];
    yield;
    if (freshLava > 0) this.findKipukas(f, isl, year, next.kipukas);
    yield;
    this.writeGeoMask(f, isl);
    yield;
    next.peaks = this.findPeaks(f, isl, recs);
    yield;
    next.placesNow = this.recognise(f, isl, near, recs, year, next.sound);
  }

  /** The largest connected stretch of Sound water, and the islands around it. */
  private findSound(f: ZoneFields, isl: Uint16Array): SoundRec | null {
    const comp = this.comp;
    const q = this.queue;
    comp.fill(0);
    let best: SoundRec | null = null;
    let bestN = 0;
    let cid = 0;
    for (let p0 = 0; p0 < NPATCH; p0++) {
      if (!(f.flags[p0] & Flag.Sound) || comp[p0]) continue;
      cid++;
      let head = 0;
      let tail = 0;
      q[tail++] = p0;
      comp[p0] = cid;
      let sx = 0;
      let sz = 0;
      while (head < tail) {
        const p = q[head++];
        sx += patchX(p);
        sz += patchZ(p);
        const pi = p % NP;
        const pk = (p / NP) | 0;
        for (let k = 0; k < 4; k++) {
          const nb = k === 0 ? (pi > 0 ? p - 1 : -1) : k === 1 ? (pi < NP - 1 ? p + 1 : -1) : k === 2 ? (pk > 0 ? p - NP : -1) : pk < NP - 1 ? p + NP : -1;
          if (nb < 0 || comp[nb] || !(f.flags[nb] & Flag.Sound)) continue;
          comp[nb] = cid;
          q[tail++] = nb;
        }
      }
      if (tail < SOUND_MIN_PATCHES) {
        for (let i = 0; i < tail; i++) f.flags[q[i]] &= ~Flag.Sound;
        continue;
      }
      if (tail <= bestN) continue;
      bestN = tail;
      const cx = sx / tail;
      const cz = sz / tail;
      // Which islands ring it: the first land in 8 directions from its centre.
      const ids: number[] = [];
      const pc = patchAt(cx, cz);
      for (let d = 0; d < 8; d++) {
        let ii = pc % NP;
        let kk = (pc / NP) | 0;
        for (let s = 0; s < RAY_SOUND * 1.5; s++) {
          ii += DX[d];
          kk += DZ[d];
          if (ii < 0 || kk < 0 || ii >= NP || kk >= NP) break;
          const id = isl[ii + kk * NP];
          if (id !== 0) {
            if (!ids.includes(id)) ids.push(id);
            break;
          }
        }
      }
      best = { x: cx, z: cz, r: Math.sqrt((tail * PATCH_M * PATCH_M) / Math.PI), islands: ids };
    }
    return best;
  }

  /** Old living ground ringed by new lava: a kīpuka (a seed source, and a story). */
  private findKipukas(f: ZoneFields, isl: Uint16Array, year: number, out: FeatureSet['kipukas']): void {
    const comp = this.comp;
    const q = this.queue;
    const old = this.oldVeg;
    comp.fill(0);
    for (let p = 0; p < NPATCH; p++) {
      const o = p * LAYERS;
      old[p] = isl[p] !== 0 && year - f.born[p] >= 60 && f.cov[o] + f.cov[o + 1] + f.cov[o + 2] + f.cov[o + 3] >= 0.5 ? 1 : 0;
    }
    let cid = 0;
    for (let p0 = 0; p0 < NPATCH; p0++) {
      if (comp[p0] || !old[p0]) continue;
      cid++;
      let head = 0;
      let tail = 0;
      q[tail++] = p0;
      comp[p0] = cid;
      let border = 0;
      let lava = 0;
      while (head < tail && tail <= 600) {
        const p = q[head++];
        const pi = p % NP;
        const pk = (p / NP) | 0;
        for (let k = 0; k < 4; k++) {
          const nb = k === 0 ? (pi > 0 ? p - 1 : -1) : k === 1 ? (pi < NP - 1 ? p + 1 : -1) : k === 2 ? (pk > 0 ? p - NP : -1) : pk < NP - 1 ? p + NP : -1;
          if (nb < 0 || comp[nb] === cid) continue;
          if (old[nb]) {
            if (comp[nb] === 0) {
              comp[nb] = cid;
              q[tail++] = nb;
            }
          } else {
            border++;
            const b = f.bot[nb];
            if (b === Substrate.HotLava || (b === Substrate.Basalt && isl[nb] !== 0 && year - f.born[nb] < 50)) lava++;
          }
        }
      }
      if (tail > 600 || tail < 2 || border === 0 || lava / border < 0.7) continue;
      let sx = 0;
      let sz = 0;
      for (let i = 0; i < tail; i++) {
        f.flags[q[i]] |= Flag.Kipuka;
        sx += patchX(q[i]);
        sz += patchZ(q[i]);
      }
      const x = sx / tail;
      const z = sz / tail;
      out.push({ key: `${Math.round(x / 24)},${Math.round(z / 24)}`, island: isl[q[0]], x, z });
    }
  }

  private writeGeoMask(f: ZoneFields, isl: Uint16Array): void {
    for (let p = 0; p < NPATCH; p++) {
      const fl = f.flags[p];
      let m = 0;
      if (isl[p] !== 0 || f.h[p] > 0) {
        if (fl & Flag.Beach) m |= habBit(Habitat.Beach);
        if (fl & Flag.Dune) m |= habBit(Habitat.Dune);
        if (fl & Flag.RockShore) m |= habBit(Habitat.RockShore);
        if (fl & Flag.Cliff) m |= habBit(Habitat.Cliff);
        if (fl & Flag.SaltPond) m |= habBit(Habitat.SaltPond);
        else if (fl & Flag.Pond) m |= habBit(Habitat.Pond);
        if (fl & Flag.Marsh) m |= habBit(Habitat.Marsh);
        if (fl & Flag.Stream) m |= habBit(Habitat.Stream);
        if (fl & Flag.Summit) m |= habBit(Habitat.Summit);
        if (fl & Flag.MangroveZone) m |= habBit(Habitat.Mangrove);
        const b = f.bot[p];
        if (b === Substrate.HotLava) m |= habBit(Habitat.HotLava);
        else if (b !== Substrate.Sand && !(fl & Flag.Pond)) m |= habBit(Habitat.BareRock);
      } else {
        m |= habBit(f.h[p] < -25 ? Habitat.DeepSea : Habitat.OpenSea);
        if (fl & Flag.Lagoon) m |= habBit(Habitat.Lagoon);
        if (fl & Flag.Sound) m |= habBit(Habitat.Sound);
        if (fl & Flag.ReefZone) m |= habBit(Habitat.Reef);
        if (fl & Flag.SeagrassZone) m |= habBit(Habitat.Seagrass);
        if (fl & Flag.MangroveZone) m |= habBit(Habitat.Mangrove);
      }
      f.geoMask[p] = m;
    }
  }

  private findPeaks(f: ZoneFields, isl: Uint16Array, recs: Map<number, IslandRec>): PeakInfo[] {
    const peaks: PeakInfo[] = [];
    for (const rec of recs.values()) {
      if (rec.peak[1] < 10) continue;
      peaks.push({ x: rec.peak[0], z: rec.peak[2], h: rec.peak[1], cap: rec.peak[1] >= CLOUD_BASE });
    }
    // Second summits on big islands also catch clouds if they stand apart.
    const h = f.h;
    for (let pk = 3; pk < NP - 3; pk++) {
      for (let pi = 3; pi < NP - 3; pi++) {
        const p = pi + pk * NP;
        if (isl[p] === 0 || h[p] < CLOUD_BASE) continue;
        let top = true;
        for (let dz = -3; dz <= 3 && top; dz++) for (let dx = -3; dx <= 3; dx++) if (h[p + dx + dz * NP] > h[p]) top = false;
        if (!top) continue;
        const x = patchX(p);
        const z = patchZ(p);
        let apart = true;
        for (const k of peaks) if (Math.hypot(k.x - x, k.z - z) < 120) apart = false;
        if (apart) peaks.push({ x, z, h: h[p], cap: true });
      }
    }
    return peaks;
  }

  /** Which places each island has right now, and where. */
  private recognise(f: ZoneFields, isl: Uint16Array, near: Uint16Array, recs: Map<number, IslandRec>, year: number, sound: SoundRec | null): Map<number, PlacesNow> {
    const index = this.index;
    const list: IslandRec[] = [...recs.values()];
    list.forEach((r, i) => (index[r.id] = i));
    const n = list.length;
    const sx = new Float64Array(n * NK);
    const sz = new Float64Array(n * NK);
    const cnt = new Float64Array(n * NK);
    const add = (i: number, k: number, p: number): void => {
      const j = i * NK + k;
      sx[j] += patchX(p);
      sz[j] += patchZ(p);
      cnt[j]++;
    };
    for (let p = 0; p < NPATCH; p++) {
      const fl = f.flags[p];
      const id = isl[p];
      if (id !== 0) {
        const i = index[id];
        const b = f.bot[p];
        if (b === Substrate.HotLava || (b === Substrate.Basalt && year - f.born[p] < 120)) add(i, K_LAVA, p);
        if (fl === 0) continue;
        if (fl & Flag.SeaCliff) add(i, K_CLIFF, p);
        if (fl & Flag.Beach) add(i, K_BEACH, p);
        if (fl & Flag.TurtleBeach) add(i, K_TURTLE, p);
        if (fl & Flag.Dune) add(i, K_DUNE, p);
        if (fl & Flag.RockShore) add(i, K_ROCKSHORE, p);
        if (fl & Flag.Basin) add(i, K_BASIN, p);
        if (fl & Flag.SaltPond) add(i, K_SALT, p);
        else if (fl & Flag.Pond) add(i, K_POND, p);
        if (fl & Flag.Stream) add(i, K_STREAM, p);
        if (fl & Flag.MangroveZone) add(i, K_MANGROVE, p);
        if (fl & Flag.RainShadow) add(i, K_SHADOW, p);
        if (fl & Flag.Summit) add(i, K_SUMMIT, p);
        if (fl & Flag.Warm) add(i, K_WARM, p);
        if (fl & Flag.Spit) add(i, K_SPIT, p);
      } else {
        const nid = near[p];
        if (nid === 0 || fl === 0 || !recs.has(nid)) continue;
        const i = index[nid];
        if (fl & Flag.Lagoon) add(i, K_LAGOON, p);
        if (fl & Flag.ReefZone && f.shelter[p] >= 0.2) add(i, K_REEF, p);
        if (fl & Flag.SeagrassZone) add(i, K_SEAGRASS, p);
        if (fl & Flag.MangroveZone) add(i, K_MANGROVE, p);
      }
    }
    const placesNow = new Map<number, PlacesNow>();
    for (let i = 0; i < n; i++) {
      const rec = list[i];
      const e: PlacesNow = { bits: 0, x: sx.slice(i * NK, i * NK + NK), z: sz.slice(i * NK, i * NK + NK), n: cnt.slice(i * NK, i * NK + NK) };
      for (let k = 0; k < NK; k++) if (e.n[k] >= NEED[PLACE_KINDS[k]]) e.bits |= 1 << k;
      if (rec.peak[1] >= CLOUD_BASE) setSpot(e, K_CLOUD, rec.peak[0], rec.peak[2]);
      // An islet: a small island with a bigger one nearby.
      if (rec.area < ISLET_AREA && rec.patches >= 2) {
        for (const o of list) {
          if (o.id !== rec.id && o.area >= 2 * rec.area && o.area >= ANNOUNCE_AREA && Math.hypot(o.centroid[0] - rec.centroid[0], o.centroid[1] - rec.centroid[1]) < 600) {
            setSpot(e, K_ISLET, rec.centroid[0], rec.centroid[1]);
            break;
          }
        }
      }
      placesNow.set(rec.id, e);
    }
    // Sea stacks: credit the stack and the nearest bigger island within 80 m.
    for (const rec of list) {
      if (rec.area > STACK_AREA || rec.peak[1] < 5) continue;
      const own = placesNow.get(rec.id);
      if (own) setSpot(own, K_STACK, rec.peak[0], rec.peak[2]);
      let best = -1;
      let bestD = 80;
      for (const o of list) {
        if (o.id === rec.id || o.area <= rec.area) continue;
        const dx = Math.max(o.bbox[0] - rec.peak[0], 0, rec.peak[0] - o.bbox[2]);
        const dz = Math.max(o.bbox[1] - rec.peak[2], 0, rec.peak[2] - o.bbox[3]);
        const d = Math.hypot(dx, dz);
        if (d < bestD) {
          bestD = d;
          best = o.id;
        }
      }
      const host = best >= 0 ? placesNow.get(best) : undefined;
      if (host) setSpot(host, K_STACK, rec.peak[0], rec.peak[2]);
    }
    // The Sound: every island around it has it.
    if (sound) {
      for (const id of sound.islands) {
        const e = placesNow.get(id);
        if (e) setSpot(e, K_SOUND, sound.x, sound.z);
      }
    }
    return placesNow;
  }

  /** Centre of a recognised place on an island (k = PLACE_KINDS index). */
  spot(island: number, k: number): [number, number] | null {
    const e = this.placesNow.get(island);
    if (!e || !(e.bits & (1 << k)) || e.n[k] <= 0) return null;
    return [e.x[k] / e.n[k], e.z[k] / e.n[k]];
  }
}

/**
 * The kind of place a patch belongs to, for stories ("High Island's beach"), from its flags,
 * or null. Callers check the island has that place recognised.
 */
export function placeOfFlags(flags: number, land: boolean): PlaceKind | null {
  if (land) {
    if (flags & Flag.SeaCliff) return 'sea-cliff';
    if (flags & Flag.Stack) return 'sea-stack';
    if (flags & Flag.SaltPond) return 'salt-pond';
    if (flags & Flag.Pond) return 'pond';
    if (flags & Flag.Stream) return 'stream';
    if (flags & Flag.MangroveZone) return 'mangrove-shore';
    if (flags & Flag.TurtleBeach) return 'turtle-beach';
    if (flags & Flag.Beach) return 'beach';
    if (flags & Flag.Dune) return 'dune';
    if (flags & Flag.RockShore) return 'rock-shore';
    if (flags & Flag.Summit) return 'summit';
    if (flags & Flag.Warm) return 'warm-ground';
    return null;
  }
  if (flags & Flag.Sound) return 'sound';
  if (flags & Flag.Lagoon) return 'lagoon';
  if (flags & Flag.ReefZone) return 'reef';
  if (flags & Flag.SeagrassZone) return 'seagrass';
  return null;
}

function setSpot(e: PlacesNow, k: number, x: number, z: number): void {
  e.bits |= 1 << k;
  e.x[k] = x;
  e.z[k] = z;
  e.n[k] = 1;
}

/** Sea within three patches on both sides (east and west, or north and south): a spit. */
function seaBothSides(h: Float32Array, isl: Uint16Array, pi: number, pk: number): boolean {
  return (seaWithin(h, isl, pi, pk, 1, 0) && seaWithin(h, isl, pi, pk, -1, 0)) || (seaWithin(h, isl, pi, pk, 0, 1) && seaWithin(h, isl, pi, pk, 0, -1));
}

function seaWithin(h: Float32Array, isl: Uint16Array, pi: number, pk: number, dx: number, dz: number): boolean {
  for (let s = 1; s <= 3; s++) {
    const ii = pi + dx * s;
    const kk = pk + dz * s;
    if (ii < 0 || kk < 0 || ii >= NP || kk >= NP) return false;
    const q = ii + kk * NP;
    if (isl[q] === 0 && h[q] <= 0) return true;
  }
  return false;
}
