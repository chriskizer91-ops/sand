/**
 * Fresh water: ponds and streams.
 *
 * 1. Priority-flood the land from the sea: every hollow is filled up to the height where it
 *    would spill. Each patch remembers which neighbour reached it first ("parent"), which is
 *    the way water runs off it, even across flat filled hollows.
 * 2. Rain is summed downhill along those links (flow accumulation): big totals are streams.
 * 3. Each hollow is a basin. Whether it holds water is a water balance: rain caught by its
 *    whole catchment, against evaporation and leakage through its floor. Rock and old soil
 *    hold water; sand and fresh cracked lava drain it away. So a rock crater in the rain
 *    becomes a pond, a sand hollow never does, and a basin in the dry lee may stay empty.
 * 4. A pond within two patches of the sea on a low, dry island turns salty.
 */
import { NP, PATCH_M } from '../config';
import { Substrate } from '../content/speciesTypes';
import { Flag, NPATCH, patchX, patchZ, type EcoFields } from './fields';

/** Rain-patches upstream that make a stream. */
const STREAM_FLOW = 60;
const EVAP = 0.4;
/** A basin holds water when its catchment brings at least this share of what it loses. */
const HOLD = 0.35;

export interface PondRec {
  id: number;
  island: number;
  level: number;
  /** World bbox. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  salt: boolean;
  patches: number;
  cx: number;
  cz: number;
}

export interface BasinRec {
  island: number;
  /** Holds (or would hold) rain: rock or old-soil floor, deep enough. */
  rock: boolean;
  filled: boolean;
  cx: number;
  cz: number;
  /** Why a dry basin stays dry, for Look. */
  dry: 'sand' | 'young-lava' | 'little-rain' | null;
}

class MinHeap {
  keys: Float32Array;
  vals: Int32Array;
  n = 0;
  constructor(cap: number) {
    this.keys = new Float32Array(cap);
    this.vals = new Int32Array(cap);
  }
  push(k: number, v: number): void {
    let i = this.n++;
    const K = this.keys;
    const V = this.vals;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (K[par] <= k) break;
      K[i] = K[par];
      V[i] = V[par];
      i = par;
    }
    K[i] = k;
    V[i] = v;
  }
  /** Pops the smallest; its key is left in `top`. */
  top = 0;
  pop(): number {
    const K = this.keys;
    const V = this.vals;
    const v = V[0];
    this.top = K[0];
    const n = --this.n;
    const k = K[n];
    const x = V[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && K[c + 1] < K[c]) c++;
      if (K[c] >= k) break;
      K[i] = K[c];
      V[i] = V[c];
      i = c;
    }
    K[i] = k;
    V[i] = x;
    return v;
  }
}

export class Hydro {
  readonly filled = new Float32Array(NPATCH);
  private parent = new Int32Array(NPATCH);
  private order = new Int32Array(NPATCH);
  private seen = new Uint8Array(NPATCH);
  private basinOf = new Int32Array(NPATCH);
  private queue = new Int32Array(NPATCH);
  private heap = new MinHeap(NPATCH + 8);
  ponds: PondRec[] = [];
  basins: BasinRec[] = [];

  /** The basin a patch lies in (for Look), or null. */
  basinAt(p: number): BasinRec | null {
    const b = this.basinOf[p];
    return b >= 0 ? (this.basins[b] ?? null) : null;
  }

  /**
   * Recompute ponds, streams, basins and marsh into f.flags / f.pondLvl / f.pondId / f.flow.
   * `isl` is the (staged) island map; `year` dates fresh lava; `peakOf` gives an island's peak.
   */
  *run(f: EcoFields, isl: Uint16Array, year: number, peakOf: (id: number) => number): Generator<void, void, void> {
    const h = f.h;
    const filled = this.filled;
    const parent = this.parent;
    const order = this.order;
    const seen = this.seen;
    const heap = this.heap;
    const CLEAR = ~(Flag.Pond | Flag.SaltPond | Flag.Marsh | Flag.Stream | Flag.Mouth | Flag.Basin);
    seen.fill(0);
    heap.n = 0;
    for (let p = 0; p < NPATCH; p++) {
      f.flags[p] &= CLEAR;
      f.pondId[p] = 0;
      f.pondLvl[p] = 0;
      f.flow[p] = 0;
      parent[p] = -1;
      const land = isl[p] !== 0 || h[p] > 0;
      if (!land) {
        seen[p] = 1;
        filled[p] = 0;
      }
    }
    // Seeds: the sea next to land, and land on the zone edge (water runs off the map).
    for (let pk = 0; pk < NP; pk++) {
      for (let pi = 0; pi < NP; pi++) {
        const p = pi + pk * NP;
        if (seen[p] === 1) {
          const nextToLand =
            (pi > 0 && seen[p - 1] === 0) || (pi < NP - 1 && seen[p + 1] === 0) || (pk > 0 && seen[p - NP] === 0) || (pk < NP - 1 && seen[p + NP] === 0);
          if (nextToLand) heap.push(0, p);
        } else if (seen[p] === 0 && (pi === 0 || pk === 0 || pi === NP - 1 || pk === NP - 1)) {
          seen[p] = 1;
          filled[p] = h[p];
          heap.push(h[p], p);
        }
      }
    }
    let nOrder = 0;
    while (heap.n > 0) {
      const p = heap.pop();
      const L = heap.top;
      order[nOrder++] = p;
      const pi = p % NP;
      const pk = (p / NP) | 0;
      for (let k = 0; k < 4; k++) {
        let q: number;
        if (k === 0) {
          if (pi === 0) continue;
          q = p - 1;
        } else if (k === 1) {
          if (pi === NP - 1) continue;
          q = p + 1;
        } else if (k === 2) {
          if (pk === 0) continue;
          q = p - NP;
        } else {
          if (pk === NP - 1) continue;
          q = p + NP;
        }
        if (seen[q]) continue;
        seen[q] = 1;
        const fq = h[q] > L ? h[q] : L;
        filled[q] = fq;
        parent[q] = p;
        heap.push(fq, q);
      }
    }
    yield;
    // ---------- flow accumulation (downstream = toward the parent) ----------
    const flow = f.flow;
    // Water caught per patch: rain, plus fog dripping from the cloud belt.
    for (let i = 0; i < nOrder; i++) {
      const p = order[i];
      if (isl[p] !== 0 || h[p] > 0) flow[p] = f.rain[p] + 0.5 * f.fog[p];
    }
    for (let i = nOrder - 1; i >= 0; i--) {
      const p = order[i];
      const par = parent[p];
      if (par >= 0) flow[par] += flow[p];
    }
    yield;
    // ---------- basins ----------
    const basinOf = this.basinOf;
    basinOf.fill(-1);
    this.ponds = [];
    this.basins = [];
    const q = this.queue;
    let pondCount = 0;
    for (let p0 = 0; p0 < NPATCH; p0++) {
      if (basinOf[p0] !== -1 || seen[p0] === 0) continue;
      if (!(isl[p0] !== 0 || h[p0] > 0) || filled[p0] - h[p0] < 0.25) continue;
      // Flood the connected hollow.
      const bi = this.basins.length;
      let head = 0;
      let tail = 0;
      q[tail++] = p0;
      basinOf[p0] = bi;
      let floor = 1e9;
      let spill = -1e9;
      let exitFlow = 0;
      const visit = (nb: number): void => {
        if (basinOf[nb] !== -1 || !(isl[nb] !== 0 || h[nb] > 0) || filled[nb] - h[nb] < 0.25) return;
        basinOf[nb] = bi;
        q[tail++] = nb;
      };
      while (head < tail) {
        const p = q[head++];
        if (h[p] < floor) floor = h[p];
        if (filled[p] > spill) spill = filled[p];
        const par = parent[p];
        if (par < 0 || filled[par] - h[par] < 0.25 || !(isl[par] !== 0 || h[par] > 0)) exitFlow = Math.max(exitFlow, flow[p]);
        const pi = p % NP;
        const pk = (p / NP) | 0;
        if (pi > 0) visit(p - 1);
        if (pi < NP - 1) visit(p + 1);
        if (pk > 0) visit(p - NP);
        if (pk < NP - 1) visit(p + NP);
      }
      const n = tail;
      // Floor leakiness from the lower half of the hollow.
      const mid = floor + 0.5 * (spill - floor);
      let perm = 0;
      let pn = 0;
      let sandN = 0;
      let youngN = 0;
      let sx = 0;
      let sz = 0;
      let island = 0;
      let minCoast = 1e9;
      for (let i = 0; i < n; i++) {
        const p = q[i];
        sx += patchX(p);
        sz += patchZ(p);
        if (isl[p] !== 0) island = isl[p];
        if (f.coast[p] < minCoast) minCoast = f.coast[p];
        if (h[p] > mid) continue;
        const b = f.bot[p];
        let k: number;
        if (b === Substrate.Sand) {
          k = 3;
          sandN++;
        } else if (b === Substrate.HotLava) {
          k = 3;
          youngN++;
        } else if (b === Substrate.Basalt && year - f.born[p] < 40) {
          k = 1.2;
          youngN++;
        } else if (b === Substrate.Limestone) k = 0.25;
        else if (b === Substrate.Stone) k = 0.06;
        else k = 0.1;
        if (f.soil[p] > 0.1) k *= 0.6;
        perm += k;
        pn++;
      }
      perm /= Math.max(1, pn);
      const depth = spill - floor;
      const fill = exitFlow / (n * (EVAP + 1.5 * perm));
      // A hollow with a rock floor is a "rock basin" even while it is too young or dry to hold water.
      const rock = sandN * 2 < pn && depth >= 0.8 && n >= 3;
      // Sand and fresh, cracked lava floors never hold water, however much rain falls.
      const leaky = (sandN + youngN) * 2 >= pn;
      const holds = !leaky && fill >= HOLD && depth >= 0.3;
      const level = holds ? floor + depth * Math.pow(Math.min(1, fill), 0.7) : floor;
      const rec: BasinRec = {
        island,
        rock,
        filled: false,
        cx: sx / n,
        cz: sz / n,
        dry: holds ? null : sandN * 2 >= pn ? 'sand' : youngN * 2 >= pn ? 'young-lava' : 'little-rain',
      };
      this.basins.push(rec);
      if (rock) for (let i = 0; i < n; i++) f.flags[q[i]] |= Flag.Basin;
      if (!holds || level - floor < 0.3) continue;
      // Salty if it sits by the sea on a low, dry island.
      let rainSum = 0;
      for (let i = 0; i < n; i++) rainSum += f.rain[q[i]];
      const salt = minCoast <= 2 * PATCH_M + 0.1 && (peakOf(island) < 20 || rainSum / n < 0.3);
      const id = ++pondCount;
      let x0 = 1e9;
      let z0 = 1e9;
      let x1 = -1e9;
      let z1 = -1e9;
      let pondN = 0;
      for (let i = 0; i < n; i++) {
        const p = q[i];
        if (h[p] >= level) continue;
        pondN++;
        f.flags[p] |= salt ? Flag.Pond | Flag.SaltPond : Flag.Pond;
        f.pondLvl[p] = level;
        f.pondId[p] = id;
        const x = patchX(p);
        const z = patchZ(p);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      if (pondN === 0) continue;
      rec.filled = true;
      const half = PATCH_M / 2;
      this.ponds.push({ id, island, level, x0: x0 - half, z0: z0 - half, x1: x1 + half, z1: z1 + half, salt, patches: pondN, cx: rec.cx, cz: rec.cz });
    }
    yield;
    // ---------- streams and marsh ----------
    for (let pk = 1; pk < NP - 1; pk++) {
      for (let pi = 1; pi < NP - 1; pi++) {
        const p = pi + pk * NP;
        if (!(isl[p] !== 0 || h[p] > 0)) continue;
        const fl = f.flags[p];
        if (fl & Flag.Pond) continue;
        if (flow[p] >= STREAM_FLOW) {
          f.flags[p] |= Flag.Stream;
          if (f.slope[p] < 4 && flow[p] >= 2 * STREAM_FLOW) f.flags[p] |= Flag.Marsh;
          if (f.coast[p] <= PATCH_M + 0.1) f.flags[p] |= Flag.Mouth;
        }
        // Wet margins round fresh ponds.
        const nbPond = (f.flags[p - 1] | f.flags[p + 1] | f.flags[p - NP] | f.flags[p + NP]) & Flag.Pond;
        if (nbPond && !(fl & Flag.SaltPond)) {
          const lvl = Math.max(f.pondLvl[p - 1], f.pondLvl[p + 1], f.pondLvl[p - NP], f.pondLvl[p + NP]);
          if (h[p] - lvl < 1.2 && f.slope[p] < 14) f.flags[p] |= Flag.Marsh;
        }
      }
    }
    // Silt off stream mouths: mark the sea next to them.
    for (let pk = 2; pk < NP - 2; pk++) {
      for (let pi = 2; pi < NP - 2; pi++) {
        const p = pi + pk * NP;
        if (!(f.flags[p] & Flag.Mouth) || !(isl[p] !== 0 || h[p] > 0)) continue;
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (h[p + dx + dz * NP] <= 0) f.flags[p + dx + dz * NP] |= Flag.Mouth;
      }
    }
  }
}
