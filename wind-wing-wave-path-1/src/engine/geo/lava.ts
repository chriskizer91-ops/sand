/**
 * Lava: a thick, glowing fluid that runs downhill on top of the columns, crusts as it cools
 * and freezes into black rock (WP-B, ARCHITECTURE §5.2).
 *
 * How it flows. Each physics step is split into short substeps. In a substep every molten
 * column works out how much lava it sends to each lower neighbour (8 neighbours), all from the
 * same "before" picture, and only then is anything moved. That keeps the flow even-handed: a
 * pour on a symmetric cone spreads symmetrically, whatever order the columns are visited in.
 *  - Lava behaves like thick honey that sets as it cools (a "Bingham" fluid): it only moves
 *    where it is thick enough for its slope (thickness x slope above its yield strength), and
 *    that strength grows as it cools. Hot lava runs down slopes in thin sheets; cooling lava
 *    stalls into thick lobes and domes.
 *  - Like a heap of grain, it also needs some slope to keep going: about 1° when fresh, rising
 *    to about 7° as its crust thickens. So lava poured in one place builds a low, rounded
 *    shield (gentle on top, steeper toward its cooler edges), not a flat-topped lava pond.
 *  - Mobility (how freely the rest moves) drops steeply as it cools.
 *  - A column never gives away more than its moving part, and never more than a small share
 *    of the height difference to any one neighbour, so the surface can never see-saw.
 *  - Heat travels with the lava (temperatures mix by volume).
 *
 * How it cools (per second): a little everywhere, much faster when thin, a bit faster at the
 * edges of a flow, and very fast in the sea. A 0.5 m sheet sets in about 5 s, a 3 m lobe in
 * about 12 s, an 8 m pool in about 17 s, and lava in the sea in about 1 s with a burst of steam.
 *
 * Freezing (below LAVA_FREEZE): the lava becomes basalt rock, and any sand it was lying on is
 * baked into that rock. Lava that freezes under the sea shatters: 30% of it becomes black sand,
 * which is how lava entering the sea makes black beaches.
 */
import { CELL, LAVA_FREEZE, NX, NZ, ORIGIN_X, ORIGIN_Z, SEA_LEVEL } from '../../config';
import { ChangeFlag, RockKind, type Columns } from '../columns';
import { ActiveSet, blockOf, EDGE, mixKind, NB_DIST, NB_OFF, qSed, type ChangeTracker, type Sand } from './sand';

/** 1 / distance to each neighbour. */
const NB_INV_DIST = NB_DIST.map((d) => 1 / d);

// ---------- flow ----------

/**
 * Yield strength of fresh lava, in metres of thickness times slope. Lava toward a neighbour
 * moves only above a yield thickness of strength / slope, so fresh lava runs down even a gentle
 * slope in a sheet a few tens of centimetres thick, like warm honey.
 */
const YIELD_HOT = 0.01;
/**
 * Yield strength grows as it cools: YIELD_HOT + YIELD_COOL * (1 - T)^4. It stays runny while
 * hot, then stiffens sharply as it nears setting, so flows stall into lobes and levees.
 */
const YIELD_COOL = 10;
/**
 * The slope lava needs to keep moving: FRICTION_HOT when fresh, plus FRICTION_COOL x (1 - T) as
 * it cools (so about 0.015 rising to 0.12, or 1° to 7°). It acts like extra yield strength that
 * grows with thickness, so even a deep pool holds a gentle slope instead of levelling flat.
 */
const FRICTION_HOT = 0.015;
const FRICTION_COOL = 0.15;
/** Slopes gentler than this count as this (no dividing by a flat surface's zero slope). */
const MIN_SLOPE = 0.01;
/** Mobility of fresh lava. Flux = mobility * moving^2 * slope * dt. */
const MOBILITY = 200;
/** Mobility falls as exp(MOBILITY_FALL * (T - 1)) while it cools. */
const MOBILITY_FALL = 3;
/** Largest share of the surface drop sent to one neighbour in one substep (keeps it steady). */
const PAIR_CAP = 1 / 12;
/** Longest substep (s). A 1/30 s physics step is done as two. */
const SUBSTEP = 1 / 60;

// ---------- cooling (temperature units per second; 1 = fresh, freezes below LAVA_FREEZE) ----------

const COOL_BASE = 0.035;
/** Thin lava loses heat faster: COOL_THIN / max(thickness, 0.4 m). */
const COOL_THIN = 0.06;
/** Extra cooling at the edge of a flow, times the share of neighbours without lava. */
const COOL_EDGE = 0.03;
/** Lava whose surface is below this is in the sea. */
const QUENCH_LEVEL = SEA_LEVEL + 0.3;
/** Cooling in the sea. */
const COOL_SEA = 0.8;
/** Share of lava frozen under the sea that shatters into black sand. */
const BLACK_SAND = 0.3;
/** Shattered lava tumbles to a neighbour at least this much lower (m). */
const TALUS_DROP = 0.5;
/** Less lava than this in a column just becomes part of the rock. */
const TRACE = 1e-5;
/** Lava newly covering ground higher than this burns the life on it (the tools use it too). */
export const BURN_ABOVE = SEA_LEVEL - 1;

// Local copies of shared values used in the hot loops (module lookups cost time in some hosts).
const FREEZE = LAVA_FREEZE;
const COLUMN_AREA = CELL * CELL;
const MOVED = ChangeFlag.Geom | ChangeFlag.Look;
const BURNT = ChangeFlag.Geom | ChangeFlag.Look | ChangeFlag.Burn;

// ---------- steam and glow ----------

/** Steam is gathered on a 16 m grid (8 columns). */
const STEAM_CELL = 8;
const STEAM_NX = NX / STEAM_CELL;
const STEAM_CELLS = STEAM_NX * (NZ / STEAM_CELL);
/** At most this many steam emitters per takeSteam call. */
const STEAM_MAX = 32;
/** Quenching this much lava per second (m^3 times temperature drop) makes full-strength steam. */
const STEAM_FULL = 20;
/** The glow statistics use a 32 m grid (16 columns). */
const STAT_CELL = 16;
const STAT_NX = NX / STAT_CELL;
const STAT_CELLS = STAT_NX * (NZ / STAT_CELL);
/** A molten area this big (m^2, at full heat) glows at full strength. */
const GLOW_FULL = 600;

/** Mobility by temperature (index = floor(T * 256)), so the hot loop never calls exp(). */
const MOBILITY_TABLE = Float64Array.from({ length: 257 }, (_, j) => MOBILITY * Math.exp(MOBILITY_FALL * (j / 256 - 1)));

export interface LavaStats {
  /** Molten area (m^2). */
  area: number;
  /** Biggest molten area: x, z, radius (m), strength 0..1. All zero when nothing is molten. */
  glow: [number, number, number, number];
}

export class Lava {
  readonly set = new ActiveSet();
  /**
   * Lava arriving in each column this substep ([2c]) and the heat it brings ([2c + 1]); side by
   * side so one memory fetch serves both. Scratch, kept at 0 between substeps.
   */
  private readonly inflow = new Float32Array(2 * NX * NZ);
  /** Per listed column: total outflow, cooling rate, sea cooling rate. */
  private outQ = new Float32Array(4096);
  private coolRate = new Float32Array(4096);
  private seaRate = new Float32Array(4096);
  /** One column's fluxes to its 8 neighbours. */
  private readonly q8 = new Float64Array(8);

  private readonly steamW = new Float64Array(STEAM_CELLS);
  private readonly steamX = new Float64Array(STEAM_CELLS);
  private readonly steamZ = new Float64Array(STEAM_CELLS);
  private readonly steamList = new Int32Array(STEAM_CELLS);
  private steamCount = 0;
  /** Physics seconds simulated since the last takeSteam. */
  private steamTime = 0;

  private readonly statHeat = new Float64Array(STAT_CELLS);
  private readonly statX = new Float64Array(STAT_CELLS);
  private readonly statZ = new Float64Array(STAT_CELLS);
  private readonly statXX = new Float64Array(STAT_CELLS);
  private readonly statZZ = new Float64Array(STAT_CELLS);
  private readonly statSeen = new Uint8Array(STAT_CELLS);
  private readonly statStack = new Int32Array(STAT_CELLS);
  private readonly glow: [number, number, number, number] = [0, 0, 0, 0];
  /** The glow is worked out only when asked for, and only after the lava has changed. */
  private glowStale = false;
  /** Counts freezes, to vary the colour rounding of the black sand they make (see mixKind). */
  private freezes = 0;

  constructor(
    private readonly cols: Columns,
    private readonly changes: ChangeTracker,
    private readonly burns: ChangeTracker,
    private readonly sand: Sand,
  ) {}

  get molten(): number {
    return this.set.count;
  }

  /** Forget all molten lava (a new sea). */
  clear(): void {
    this.set.clear();
    this.resetSteam();
    this.steamTime = 0;
    this.glowStale = true;
  }

  /** List column c if it holds lava (call after adding lava to it). */
  wake(c: number): void {
    if (this.cols.lava[c] > 0 && !EDGE[c]) this.set.add(c);
  }

  /**
   * Pick up molten lava in a rectangle that something else wrote (undo, loading a save).
   * Lava on the zone's outer ring cannot flow, so it is set into rock on the spot.
   */
  wakeRect(i0: number, k0: number, i1: number, k1: number): void {
    const lava = this.cols.lava;
    i0 = Math.max(0, i0);
    k0 = Math.max(0, k0);
    i1 = Math.min(NX - 1, i1);
    k1 = Math.min(NZ - 1, k1);
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const c = i + k * NX;
        if (lava[c] <= 0) continue;
        if (EDGE[c]) this.freeze(c);
        else this.set.add(c);
      }
    }
  }

  /**
   * Flow and cool for dt seconds. The first substep always runs; later ones give up if the
   * deadline (a performance.now() time) passes, so a heavy load slows lava down instead of
   * making it jump ahead.
   */
  step(dt: number, deadline: number): void {
    if (this.set.count === 0) return;
    this.glowStale = true;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP - 1e-6));
    const dts = dt / n;
    let reported = false;
    for (let s = 0; s < n; s++) {
      const last = s === n - 1;
      if (s > 0 && performance.now() > deadline) break;
      if (!this.substep(dts, s === 0 ? Infinity : deadline, last)) break;
      this.steamTime += dts;
      reported = last;
    }
    // Out of time before the last substep: still report what the earlier ones changed.
    if (!reported) for (let j = 0; j < this.set.count; j++) this.changes.mark(this.set.list[j], MOVED);
  }

  /**
   * One substep. Returns false if it gave up because time ran out (it then leaves everything
   * exactly as it found it). `report` marks the changed columns (once per physics step is enough).
   */
  private substep(dts: number, deadline: number, report: boolean): boolean {
    const set = this.set;
    const cols = this.cols;
    const { rock, sed, lava, temp } = cols;
    const n1 = set.count;
    this.reserve(n1);
    const outQ = this.outQ;
    const coolRate = this.coolRate;
    const seaRate = this.seaRate;
    const inflow = this.inflow;
    const q8 = this.q8;
    const flag = set.flag;
    // Entries before n1 stay put even if the list grows, so this array is safe to read for them.
    const first = set.list;
    // Local names for the shared tables keep the hot loops free of module lookups.
    const off = NB_OFF;
    const edge = EDGE;
    const invDist = NB_INV_DIST;
    const minSlope = MIN_SLOPE;
    const pairCap = PAIR_CAP;

    // 1. From the same "before" picture, work out what each column sends to each lower
    //    neighbour, and gather what every receiver will get (and the heat it brings).
    //    Nothing in the columns changes yet.
    for (let j = 0; j < n1; j++) {
      if ((j & 255) === 255 && performance.now() > deadline) {
        this.undoGather(j, n1);
        return false;
      }
      const c = first[j];
      const L = lava[c];
      if (L <= 0) {
        outQ[j] = 0;
        coolRate[j] = 0;
        seaRate[j] = 0;
        continue;
      }
      const T = temp[c];
      const S = rock[c] + sed[c] + L;
      const u = 1 - T;
      const u2 = u * u;
      const strength = YIELD_HOT + YIELD_COOL * u2 * u2 + (FRICTION_HOT + FRICTION_COOL * u) * L;
      const k = MOBILITY_TABLE[T >= 1 ? 256 : (T * 256) | 0] * dts;
      let out = 0;
      let most = 0;
      let dry = 0;
      for (let d = 0; d < 8; d++) {
        const n = c + off[d];
        const Ln = lava[n];
        if (Ln <= 0) dry++;
        let q = 0;
        const drop = S - (rock[n] + sed[n] + Ln);
        if (drop > 0 && edge[n] === 0) {
          const slope = drop * invDist[d];
          const s = slope > minSlope ? slope : minSlope;
          // Thick enough to move (L above the yield thickness strength / s)? Tested without a
          // division, as most neighbours of a stalled or crusting flow fail here.
          const moving = L * s > strength ? L - strength / s : 0;
          if (moving > 0) {
            q = k * moving * moving * slope;
            const cap = drop * pairCap;
            if (q > cap) q = cap;
            out += q;
            if (moving > most) most = moving;
          }
        }
        q8[d] = q;
      }
      // Never give away more than the part that can move. Specks smaller than TRACE are not
      // sent at all: they would only become a film of rock (and burn life) beyond the flow.
      const scale = out > most ? most / out : 1;
      let sent = 0;
      if (out > 0) {
        for (let d = 0; d < 8; d++) {
          const q = q8[d] * scale;
          if (q < TRACE) continue;
          const n = c + off[d];
          inflow[2 * n] += q;
          inflow[2 * n + 1] += q * T;
          sent += q;
          if (flag[n] === 0) set.add(n);
        }
      }
      outQ[j] = sent;
      const sea = S < QUENCH_LEVEL ? COOL_SEA : 0;
      seaRate[j] = sea;
      coolRate[j] = COOL_BASE + COOL_THIN / (L > 0.4 ? L : 0.4) + (COOL_EDGE * dry) / 8 + sea;
    }

    // 2. Each column gives, takes in what arrived, cools, and maybe freezes (newly listed
    //    receivers too). Columns that are left with no lava drop off the list.
    const list = set.list;
    const count = set.count;
    const burns = this.burns;
    const changes = this.changes;
    const block = blockOf;
    let w = 0;
    // Undo copies whole 16 x 16 blocks, so one touch per block run is enough.
    let touched = -1;
    for (let j = 0; j < count; j++) {
      const c = list[j];
      const b = block(c);
      if (b !== touched) {
        cols.touch(c);
        touched = b;
      }
      let L = lava[c];
      let T = temp[c];
      if (j < n1) L -= outQ[j];
      // A column that had no lava (it only just got listed as a receiver).
      const bare = L <= 0;
      const add = inflow[2 * c];
      if (add > 0) {
        const heat = inflow[2 * c + 1];
        T = L > 0 ? (L * T + heat) / (L + add) : heat / add;
        L += add;
        inflow[2 * c] = 0;
        inflow[2 * c + 1] = 0;
      }
      if (L <= TRACE) {
        // A trace left behind (or lava removed by something else): it just joins the rock.
        if (L > 0) rock[c] += L;
        lava[c] = 0;
        temp[c] = 0;
        set.flag[c] = 0;
        changes.mark(c, MOVED);
        continue;
      }
      // Lava has really reached this ground: anything living on it burns (or is buried).
      if (bare && rock[c] + sed[c] > BURN_ABOVE) burns.mark(c, BURNT);
      if (j < n1) {
        T -= coolRate[j] * dts;
        const sea = seaRate[j];
        if (sea > 0) this.addSteam(c, sea * dts * L * COLUMN_AREA);
      }
      lava[c] = L;
      temp[c] = T;
      if (T < FREEZE) {
        this.freeze(c);
        set.flag[c] = 0;
        continue;
      }
      if (report) changes.mark(c, MOVED);
      list[w++] = c;
    }
    set.count = w;
    return true;
  }

  /**
   * Time ran out part-way through gathering: clear what the first `done` columns sent, and
   * unlist the receivers added this substep (they sit after the first `listed` entries).
   */
  private undoGather(done: number, listed: number): void {
    const set = this.set;
    for (let j = 0; j < done; j++) {
      const c = set.list[j];
      for (let d = 0; d < 8; d++) {
        const n = c + NB_OFF[d];
        this.inflow[2 * n] = 0;
        this.inflow[2 * n + 1] = 0;
      }
    }
    for (let j = listed; j < set.count; j++) set.flag[set.list[j]] = 0;
    set.count = listed;
  }

  /** Turn the lava in column c into rock (and black sand where it froze under the sea). */
  private freeze(c: number): void {
    const cols = this.cols;
    const { rock, sed, lava, sandKind } = cols;
    const L = lava[c];
    const top = rock[c] + sed[c];
    const underSea = Math.min(L, Math.max(0, SEA_LEVEL - top));
    const black = qSed(BLACK_SAND * underSea);
    cols.touch(c);
    // The sand the lava lay on is baked into the new rock.
    const rockTop = top + L - black;
    rock[c] = rockTop;
    sed[c] = 0;
    cols.rockKind[c] = RockKind.Basalt;
    lava[c] = 0;
    cols.temp[c] = 0;
    this.changes.mark(c, MOVED);
    if (black > 0) {
      // The shattered lava tumbles off the front onto the lowest open neighbour (if there is
      // a drop), so a lava delta grows a black-sand slope instead of a sheer wall.
      let to = c;
      let low = rockTop - TALUS_DROP;
      for (let d = 0; d < 8 && !EDGE[c]; d++) {
        const n = c + NB_OFF[d];
        if (EDGE[n] || lava[n] > 0) continue;
        const t = rock[n] + sed[n];
        if (t < low) {
          low = t;
          to = n;
        }
      }
      if (to !== c) cols.touch(to);
      const had = sed[to];
      sandKind[to] = mixKind(sandKind[to], had, black, 0, to, ++this.freezes);
      sed[to] = had + black;
      this.changes.mark(to, MOVED);
      this.sand.wakeAround(to);
    }
    this.sand.wakeAround(c);
  }

  /** Make sure the per-column scratch arrays can hold n listed columns. */
  private reserve(n: number): void {
    if (n <= this.outQ.length) return;
    let cap = this.outQ.length;
    while (cap < n) cap *= 2;
    this.outQ = new Float32Array(cap);
    this.coolRate = new Float32Array(cap);
    this.seaRate = new Float32Array(cap);
  }

  // ---------- steam ----------

  private addSteam(c: number, amount: number): void {
    const i = c % NX;
    const k = (c - i) / NX;
    const s = ((i / STEAM_CELL) | 0) + ((k / STEAM_CELL) | 0) * STEAM_NX;
    if (this.steamW[s] === 0) this.steamList[this.steamCount++] = s;
    this.steamW[s] += amount;
    this.steamX[s] += amount * (ORIGIN_X + (i + 0.5) * CELL);
    this.steamZ[s] += amount * (ORIGIN_Z + (k + 0.5) * CELL);
  }

  private resetSteam(): void {
    for (let j = 0; j < this.steamCount; j++) {
      const s = this.steamList[j];
      this.steamW[s] = 0;
      this.steamX[s] = 0;
      this.steamZ[s] = 0;
    }
    this.steamCount = 0;
  }

  /**
   * Append x, z, strength (0..1) for the strongest places where lava met the sea since the
   * last call (at most 32, one per 16 m square), then start collecting again.
   */
  takeSteam(out: number[]): void {
    const t = this.steamTime;
    this.steamTime = 0;
    if (t <= 0 || this.steamCount === 0) {
      this.resetSteam();
      return;
    }
    const list = this.steamList;
    const w = this.steamW;
    const n = this.steamCount;
    // Partial selection: move the strongest cells to the front of the list.
    const take = Math.min(STEAM_MAX, n);
    for (let a = 0; a < take; a++) {
      let best = a;
      for (let b = a + 1; b < n; b++) if (w[list[b]] > w[list[best]]) best = b;
      const s = list[best];
      list[best] = list[a];
      list[a] = s;
      const W = w[s];
      out.push(this.steamX[s] / W, this.steamZ[s] / W, Math.min(1, Math.sqrt(W / t / STEAM_FULL)));
    }
    this.resetSteam();
  }

  // ---------- glow ----------

  /**
   * Find the biggest molten area (by heat) on a 32 m grid: its heat-weighted centre, a radius
   * that covers it, and a strength for the page's lava light.
   */
  private updateGlow(): void {
    this.glowStale = false;
    const g = this.glow;
    g.fill(0);
    const set = this.set;
    if (set.count === 0) return;
    const { lava, temp } = this.cols;
    const heat = this.statHeat;
    const sx = this.statX;
    const sz = this.statZ;
    const sxx = this.statXX;
    const szz = this.statZZ;
    heat.fill(0);
    sx.fill(0);
    sz.fill(0);
    sxx.fill(0);
    szz.fill(0);
    for (let j = 0; j < set.count; j++) {
      const c = set.list[j];
      if (lava[c] <= 0) continue;
      const i = c % NX;
      const k = (c - i) / NX;
      const h = Math.max(0.02, (temp[c] - LAVA_FREEZE) / (1 - LAVA_FREEZE));
      const x = ORIGIN_X + (i + 0.5) * CELL;
      const z = ORIGIN_Z + (k + 0.5) * CELL;
      const s = ((i / STAT_CELL) | 0) + ((k / STAT_CELL) | 0) * STAT_NX;
      heat[s] += h;
      sx[s] += h * x;
      sz[s] += h * z;
      sxx[s] += h * x * x;
      szz[s] += h * z * z;
    }
    // Join touching grid cells into areas (8-connected) and keep the hottest area.
    const seen = this.statSeen;
    seen.fill(0);
    const stack = this.statStack;
    let best = 0;
    for (let s0 = 0; s0 < STAT_CELLS; s0++) {
      if (heat[s0] <= 0 || seen[s0]) continue;
      let H = 0;
      let X = 0;
      let Z = 0;
      let XX = 0;
      let ZZ = 0;
      let top = 0;
      stack[top++] = s0;
      seen[s0] = 1;
      while (top > 0) {
        const s = stack[--top];
        H += heat[s];
        X += sx[s];
        Z += sz[s];
        XX += sxx[s];
        ZZ += szz[s];
        const si = s % STAT_NX;
        const sk = (s - si) / STAT_NX;
        for (let dk = -1; dk <= 1; dk++) {
          for (let di = -1; di <= 1; di++) {
            const ni = si + di;
            const nk = sk + dk;
            if (ni < 0 || nk < 0 || ni >= STAT_NX || nk >= STAT_NX) continue;
            const t = ni + nk * STAT_NX;
            if (heat[t] > 0 && !seen[t]) {
              seen[t] = 1;
              stack[top++] = t;
            }
          }
        }
      }
      if (H > best) {
        best = H;
        const cx = X / H;
        const cz = Z / H;
        const spread = Math.max(0, XX / H - cx * cx) + Math.max(0, ZZ / H - cz * cz);
        g[0] = cx;
        g[1] = cz;
        g[2] = Math.max(CELL, Math.sqrt(2 * spread + (CELL * CELL) / 3));
        g[3] = Math.min(1, Math.sqrt((H * CELL * CELL) / GLOW_FULL));
      }
    }
  }

  /** Molten area and the biggest molten area (see LavaStats). */
  stats(): LavaStats {
    if (this.glowStale) this.updateGlow();
    const g = this.glow;
    return { area: this.set.count * CELL * CELL, glow: [g[0], g[1], g[2], g[3]] };
  }
}
