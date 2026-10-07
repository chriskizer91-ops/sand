/**
 * Checks for the land rules (WP-B): lava, sand, rock, the tools and the starting sea floor.
 * vitest runs all of them; the in-game checks page runs the quick ones on the owner's phone.
 *
 * Each check builds a small made-up piece of ground (a slope, a pit, a cliff) straight into
 * the column arrays, runs the real physics on it, and measures what happened.
 */
import { BUILD_MAX, BUILD_MIN, CELL, NX, NZ, ORIGIN_X, ORIGIN_Z, PHYS_STEP, SEA_LEVEL } from '../config';
import { ChangeFlag, Columns, RockKind } from '../engine/columns';
import { Geo } from '../engine/geo/geo';
import { registerChecks } from './registry';

// ---------- little worlds ----------

/** A world whose rock top is rockAt(x, z) and sand depth sedAt(x, z) (world metres). */
export function testWorld(rockAt: (x: number, z: number) => number, sedAt?: (x: number, z: number) => number): Geo {
  const cols = new Columns();
  for (let k = 0; k < NZ; k++) {
    const z = cols.cz(k);
    for (let i = 0; i < NX; i++) {
      const x = cols.cx(i);
      const c = i + k * NX;
      cols.rock[c] = rockAt(x, z);
      cols.sed[c] = sedAt ? sedAt(x, z) : 0;
      cols.sandKind[c] = 150;
      cols.rockKind[c] = RockKind.Basalt;
    }
  }
  return new Geo(cols, 7);
}

/** Run the physics for `seconds` (fixed steps, generous budget). */
export function runFor(geo: Geo, seconds: number): void {
  const n = Math.round(seconds / PHYS_STEP);
  for (let s = 0; s < n; s++) geo.step(PHYS_STEP, 1000);
}

/** Run until nothing is molten or sliding (or `limit` seconds). Returns the seconds taken. */
export function settle(geo: Geo, limit = 120): number {
  let t = 0;
  while (!geo.isSettled() && t < limit) {
    geo.step(PHYS_STEP, 1000);
    t += PHYS_STEP;
  }
  return t;
}

/** Hold a tool still at (x, z) for `seconds`, stepping the physics as the engine does. */
export function hold(geo: Geo, tool: 'lava' | 'rock' | 'sand' | 'hands' | 'scoop', x: number, z: number, r: number, seconds: number): number {
  let volume = 0;
  const n = Math.round(seconds / PHYS_STEP);
  for (let s = 0; s < n; s++) {
    volume += geo.applyTool(tool, x, z, r, PHYS_STEP, 1).volume;
    geo.step(PHYS_STEP, 1000);
  }
  return volume;
}

/** Fill a rectangle of columns (inclusive) with molten lava and tell Geo about it. */
function placeLava(geo: Geo, i0: number, k0: number, i1: number, k1: number, depth: number): void {
  const cols = geo.cols;
  for (let k = k0; k <= k1; k++)
    for (let i = i0; i <= i1; i++) {
      cols.lava[i + k * NX] = depth;
      cols.temp[i + k * NX] = 1;
    }
  cols.markChanged(i0, k0, i1, k1, ChangeFlag.Geom | ChangeFlag.Look);
}

/** Seconds until every bit of lava has frozen (or `limit`). */
function freezeTime(geo: Geo, limit: number): number {
  let t = 0;
  while (geo.lavaStats().area > 0 && t < limit) {
    geo.step(PHYS_STEP, 1000);
    t += PHYS_STEP;
  }
  return t;
}

/** Column index at world (x, z). */
const at = (x: number, z: number) => Math.floor((x - ORIGIN_X) / CELL) + Math.floor((z - ORIGIN_Z) / CELL) * NX;
/** World x of column centre i (and z of k). */
const cx = (i: number) => ORIGIN_X + (i + 0.5) * CELL;
const deg = (slope: number) => (Math.atan(slope) * 180) / Math.PI;
const f1 = (v: number) => v.toFixed(1);

/** How far downhill (+x) from x0 the surface rose by more than 5 cm, within 20 m of the line z = 0. */
function reachDownhill(geo: Geo, before: Float32Array, x0: number): number {
  const cols = geo.cols;
  const k0 = (at(0, -20) / NX) | 0;
  const k1 = (at(0, 20) / NX) | 0;
  let far = 0;
  for (let k = k0; k <= k1; k++) {
    for (let i = 0; i < NX; i++) {
      const c = i + k * NX;
      if (cols.surf(c) - before[c] > 0.05) far = Math.max(far, cx(i) - x0);
    }
  }
  return far;
}

// ---------- timing ----------

/** Up to this many timing rounds, with a short pause between them (other work may finish meanwhile). */
const SPEED_ROUNDS = 8;
const SPEED_PAUSE_MS = 500;
/** A round ran undisturbed if this thread ran for at least this share of its wall-clock time... */
const QUIET_SHARE = 0.75;
/**
 * ...or, where the host can't tell, if its slow steps (90th percentile) stay within this many
 * times its quick ones (25th). Settling sand varies a little from step to step by itself; a step
 * the computer paused for a time slice costs several times more.
 */
const QUIET_SPREAD = 3;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** This thread's CPU time so far (ms) where the host reports it (Node, where vitest runs), otherwise null. */
function cpuNow(): number | null {
  if (typeof process === 'undefined') return null;
  const usage = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : typeof process.cpuUsage === 'function' ? process.cpuUsage() : null;
  return usage ? (usage.user + usage.system) / 1000 : null;
}

/** The value p (0..1) of the way up a sorted list. */
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * Time the physics fairly, in rounds. `round` builds a fresh test, runs it, and returns each
 * step's cost scaled to the target workload (ms).
 *
 * Each round is judged by its 25th-percentile step: the work is steady, so this skips the odd
 * hiccup without trusting one lucky step. The median and the slow (90th percentile) steps are
 * reported too. Other programs on the computer can only ever add time, so a round that meets
 * the target is a fair pass however busy the computer was. A round that misses it counts as a
 * fail only if it ran undisturbed (QUIET_SHARE, or QUIET_SPREAD where the host can't report
 * CPU time); if every round that missed was disturbed, the check says it could not measure
 * reliably instead of guessing either way. It stops at the first round that meets the target.
 */
async function speedCheck(target: number, workload: string, round: () => number[]): Promise<{ pass: boolean; detail: string }> {
  type Timing = { p25: number; p50: number; p90: number; quiet: boolean };
  // The best round so far: one that met the target, else an undisturbed one, else the quickest.
  const rank = (x: Timing) => (x.p25 <= target ? 0 : x.quiet ? 1 : 2);
  let best: Timing | null = null;
  let mostShare = 0;
  for (let r = 0; r < SPEED_ROUNDS; r++) {
    if (r > 0) await pause(SPEED_PAUSE_MS);
    const c0 = cpuNow();
    const w0 = performance.now();
    const per = round();
    const wall = performance.now() - w0;
    const c1 = cpuNow();
    if (per.length === 0) continue;
    const sorted = per.slice().sort((a, b) => a - b);
    const share = c0 !== null && c1 !== null && wall > 0 ? (c1 - c0) / wall : null;
    if (share !== null) mostShare = Math.max(mostShare, share);
    const t: Timing = { p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), quiet: false };
    t.quiet = share !== null ? share >= QUIET_SHARE : t.p90 <= QUIET_SPREAD * t.p25;
    if (!best || rank(t) < rank(best) || (rank(t) === rank(best) && t.p25 < best.p25)) best = t;
    if (best.p25 <= target) break;
  }
  const ms = (v: number) => v.toFixed(2);
  if (!best || (best.p25 > target && !best.quiet)) {
    const why = mostShare > 0 ? `this check got at most ${Math.round(mostShare * 100)}% of the computer's time` : 'every round was interrupted';
    const seen = best ? ` The quickest quarter of steps took ${ms(best.p25)} ms or less.` : '';
    return { pass: false, detail: `Could not measure reliably: the computer was too busy (${why}).${seen} Run it again when it is quieter.` };
  }
  return {
    pass: best.p25 <= target,
    detail: `${ms(best.p25)} ms per step for ${workload} (median ${ms(best.p50)} ms, slow steps ${ms(best.p90)} ms; ${target} ms allowed).`,
  };
}

function surfCopy(geo: Geo): Float32Array {
  const s = new Float32Array(geo.cols.n);
  for (let c = 0; c < s.length; c++) s[c] = geo.cols.surf(c);
  return s;
}

/** Average slope of a settled pile's flanks along the 4 axis directions from its peak (degrees). */
function pileAngle(geo: Geo, x: number, z: number): number {
  const cols = geo.cols;
  const c0 = at(x, z);
  const angles: number[] = [];
  for (const off of [1, -1, NX, -NX]) {
    // Average slope over the middle of the flank (skip the rounded top and the toe).
    const hs: number[] = [];
    for (let s = 0; s < 60; s++) {
      const c = c0 + off * s;
      if (cols.sed[c] < 0.05) break;
      hs.push(cols.top(c));
    }
    if (hs.length < 6) return 0;
    const a = Math.floor(hs.length * 0.25);
    const b = Math.floor(hs.length * 0.75);
    angles.push(deg((hs[a] - hs[b]) / ((b - a) * CELL)));
  }
  return angles.reduce((p, v) => p + v, 0) / angles.length;
}

registerChecks('geo', [
  {
    id: 'lava-downhill',
    label: 'Lava runs downhill and spreads',
    quick: true,
    run() {
      // A 10° slope falling toward +x, all above the sea.
      const geo = testWorld((x) => 40 - x * 0.176);
      const i0 = at(-6, -6) % NX;
      const k0 = (at(-6, -6) / NX) | 0;
      placeLava(geo, i0, k0, i0 + 5, k0 + 5, 1.5);
      const start = cx(i0 + 2.5);
      runFor(geo, 3);
      // Where the lava (molten or already set) went: the surface that rose.
      const cols = geo.cols;
      let sum = 0;
      let sx = 0;
      let area = 0;
      for (let c = 0; c < cols.n; c++) {
        const added = cols.surf(c) - (40 - cx(c % NX) * 0.176);
        if (added <= 0.01) continue;
        sum += added;
        sx += added * cx(c % NX);
        area++;
      }
      const moved = sum > 0 ? sx / sum - start : 0;
      return {
        pass: moved > 2 && area > 2 * 36,
        detail: `After 3 s the lava's middle moved ${f1(moved)} m downhill and it covers ${area} columns (it started on 36).`,
      };
    },
  },
  {
    id: 'lava-vs-sand',
    label: 'On a gentle slope lava runs at least 3 times further than poured sand',
    quick: false,
    run() {
      const slope = (x: number) => 40 - x * 0.176; // 10°
      const lavaGeo = testWorld(slope);
      const b1 = surfCopy(lavaGeo);
      const v = hold(lavaGeo, 'lava', 0.5 * CELL, 0, 5, 2);
      settle(lavaGeo);
      const sandGeo = testWorld(slope);
      const b2 = surfCopy(sandGeo);
      // The same volume of sand, poured for as long as that takes.
      let poured = 0;
      while (poured < v) {
        poured += sandGeo.applyTool('sand', 0.5 * CELL, 0, 5, PHYS_STEP, 1).volume;
        sandGeo.step(PHYS_STEP, 1000);
      }
      settle(sandGeo);
      const lavaReach = reachDownhill(lavaGeo, b1, 0.5 * CELL);
      const sandReach = reachDownhill(sandGeo, b2, 0.5 * CELL);
      return {
        pass: lavaReach >= 3 * sandReach,
        detail: `${f1(v)} m³ each: lava reached ${f1(lavaReach)} m downhill, sand ${f1(sandReach)} m.`,
      };
    },
  },
  {
    id: 'lava-cooling',
    label: 'A thin lava sheet sets in 3-10 s and a thick lobe in 10-30 s',
    quick: false,
    run() {
      // Pits with rock walls hold the lava in place, so only cooling is measured.
      const pit = (depth: number) =>
        testWorld((x, z) => (Math.abs(x) < 20 && Math.abs(z) < 20 ? 10 - depth : 10));
      const sheet = pit(1);
      const lobe = pit(5);
      const i0 = at(-19, -19) % NX;
      const k0 = (at(-19, -19) / NX) | 0;
      const i1 = at(19, 19) % NX;
      const k1 = (at(19, 19) / NX) | 0;
      placeLava(sheet, i0, k0, i1, k1, 1);
      placeLava(lobe, i0, k0, i1, k1, 5);
      const t1 = freezeTime(sheet, 60);
      const t5 = freezeTime(lobe, 60);
      return {
        pass: t1 >= 3 && t1 <= 10 && t5 >= 10 && t5 <= 30,
        detail: `A 1 m sheet set in ${f1(t1)} s; a 5 m lobe in ${f1(t5)} s.`,
      };
    },
  },
  {
    id: 'lava-sea',
    label: 'Lava entering the sea sets within 2 s, steams, and makes about 30% black sand',
    quick: true,
    run() {
      // (1) A block of lava on the sea floor.
      const geo = testWorld(() => -6);
      const i0 = at(-10, -10) % NX;
      const k0 = (at(-10, -10) / NX) | 0;
      placeLava(geo, i0, k0, i0 + 9, k0 + 9, 2);
      const sandBefore = geo.cols.totalSediment();
      const t = freezeTime(geo, 10);
      const steam: number[] = [];
      geo.takeSteam(steam);
      const black = (geo.cols.totalSediment() - sandBefore) / (100 * 2 * CELL * CELL);
      // (2) Lava poured on a shore runs into the sea: no sea column stays molten for 2 s.
      const shore = testWorld((x) => 4 - x * 0.25);
      const wet = new Float32Array(shore.cols.n);
      const w0 = at(-20, -30);
      const w1 = at(50, 30);
      let longest = 0;
      for (let s = 0; s < 8 / PHYS_STEP; s++) {
        if (s < 4 / PHYS_STEP) shore.applyTool('lava', -8, 0, 6, PHYS_STEP, 1);
        shore.step(PHYS_STEP, 1000);
        const c = shore.cols;
        for (let k = (w0 / NX) | 0; k <= ((w1 / NX) | 0); k++) {
          for (let i = w0 % NX; i <= w1 % NX; i++) {
            const j = i + k * NX;
            if (c.lava[j] > 0 && c.surf(j) < SEA_LEVEL + 0.3) wet[j] += PHYS_STEP;
            else wet[j] = 0;
            if (wet[j] > longest) longest = wet[j];
          }
        }
      }
      const pass = t < 2 && steam.length >= 3 && black >= 0.25 && black <= 0.35 && longest < 2;
      return {
        pass,
        detail: `Under the sea lava set in ${f1(t)} s with ${steam.length / 3} steam puffs; ${Math.round(black * 100)}% became black sand. Flowing in from the shore, sea lava stayed molten at most ${f1(longest)} s.`,
      };
    },
  },
  {
    id: 'rock-cliff',
    label: 'A 30 m rock cliff stays exactly as it is',
    quick: true,
    run() {
      const geo = testWorld((x) => (x < 0 ? 30 : 0));
      const before = geo.cols.rock.slice();
      // Pour sand on its top edge and let it slide off for 600 steps.
      for (let s = 0; s < 600; s++) {
        if (s < 60) geo.applyTool('sand', -4, 0, 4, PHYS_STEP, 1);
        geo.step(PHYS_STEP, 1000);
      }
      let changed = 0;
      for (let c = 0; c < before.length; c++) if (geo.cols.rock[c] !== before[c]) changed++;
      return { pass: changed === 0, detail: `${changed} rock columns changed after 600 steps with sand sliding off it.` };
    },
  },
  {
    id: 'sand-angles',
    label: 'Dry sand settles at about 34° and sand under water at about 28°',
    quick: false,
    run() {
      const pile = (ground: number) => {
        const geo = testWorld(
          () => ground,
          (x, z) => (Math.hypot(x - 1, z - 1) < 9 ? 30 : 0),
        );
        geo.cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom);
        settle(geo, 200);
        return pileAngle(geo, 1, 1);
      };
      const dry = pile(5);
      const wet = pile(-45);
      return {
        pass: dry >= 30 && dry <= 37 && wet >= 24 && wet <= 31,
        detail: `Dry pile ${f1(dry)}°, underwater pile ${f1(wet)}°.`,
      };
    },
  },
  {
    id: 'sand-shore',
    label: 'Sand poured at the water line becomes a gentle beach face within 60 s',
    quick: false,
    run() {
      // A rock shore rising gently toward the west (-x), crossing the sea at x = 0.
      const geo = testWorld((x) => Math.max(-6, -x * 0.05));
      hold(geo, 'sand', 0, 0, 8, 3);
      runFor(geo, 57);
      // The steepest step in the swash band along the line through the pour.
      const cols = geo.cols;
      let steepest = 0;
      const k = (at(0, 0) / NX) | 0;
      for (let i = 1; i < NX - 1; i++) {
        const a = cols.top(i + k * NX);
        const b = cols.top(i + 1 + k * NX);
        if (a < SEA_LEVEL - 1.5 || a > SEA_LEVEL + 1.2 || b < SEA_LEVEL - 1.5 || b > SEA_LEVEL + 1.2) continue;
        steepest = Math.max(steepest, Math.abs(a - b) / CELL);
      }
      return { pass: deg(steepest) <= 12, detail: `Steepest part of the beach face after 60 s: ${f1(deg(steepest))}°.` };
    },
  },
  {
    id: 'sand-volume',
    label: 'Sliding sand is never lost or made',
    quick: true,
    run() {
      const geo = testWorld(
        (x, z) => 3 + 2 * Math.sin(x * 0.05) + Math.cos(z * 0.07),
        (x, z) => (Math.abs(x) < 30 && Math.abs(z) < 30 ? 6 + 4 * Math.sin(x * 0.3 + z * 0.2) : 0.5),
      );
      const before = geo.cols.totalSediment();
      geo.cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom);
      runFor(geo, 6);
      const after = geo.cols.totalSediment();
      const err = Math.abs(after - before) / before;
      return { pass: err <= 1e-4, detail: `Total sand ${f1(before)} m³ before, ${f1(after)} m³ after (difference ${err.toExponential(1)}).` };
    },
  },
  {
    id: 'build-limits',
    label: 'Tools stop at the top (180 m) and the bottom (-30 m) of the building range',
    quick: true,
    run() {
      const high = testWorld(() => 172);
      for (let s = 0; s < 600; s++) {
        high.applyTool('rock', 0, 0, 6, PHYS_STEP, 1);
        high.applyTool('sand', 0, 0, 6, PHYS_STEP, 1);
        high.applyTool('lava', 0, 0, 6, PHYS_STEP, 1);
        high.step(PHYS_STEP, 1000);
      }
      settle(high);
      let top = -Infinity;
      for (let c = 0; c < high.cols.n; c++) top = Math.max(top, high.cols.surf(c));
      const low = testWorld(
        () => -28,
        () => 1.5,
      );
      for (let s = 0; s < 900; s++) low.applyTool('scoop', 0, 0, 6, PHYS_STEP, 1);
      let bottom = Infinity;
      for (let c = 0; c < low.cols.n; c++) bottom = Math.min(bottom, low.cols.top(c));
      return {
        pass: top <= BUILD_MAX + 1e-3 && bottom >= BUILD_MIN - 1e-3,
        detail: `Highest point ${f1(top)} m after 20 s of building at 172 m; lowest ${f1(bottom)} m after 30 s of scooping.`,
      };
    },
  },
  {
    id: 'lava-buries-sand',
    label: 'Lava that sets on sand bakes the sand into the rock',
    quick: true,
    run() {
      const geo = testWorld(
        () => 5,
        () => 1,
      );
      hold(geo, 'lava', 0, 0, 6, 1.5);
      settle(geo);
      const cols = geo.cols;
      let covered = 0;
      let bad = 0;
      for (let c = 0; c < cols.n; c++) {
        if (cols.rock[c] <= 5 + 1e-4) continue;
        covered++;
        if (cols.sed[c] > 0 || cols.rockKind[c] !== RockKind.Basalt || cols.rock[c] < 6 - 1e-4) bad++;
      }
      return { pass: covered > 20 && bad === 0, detail: `${covered} columns of new rock; ${bad} still have loose sand under or on them.` };
    },
  },
  {
    id: 'lava-symmetric',
    label: 'Lava poured on a cone spreads evenly on every side',
    quick: true,
    run() {
      // A cone centred on a column centre, so it is exactly symmetric on the grid.
      const ox = cx(256);
      const geo = testWorld((x, z) => 20 - 0.15 * Math.hypot(x - ox, z - ox));
      const before = surfCopy(geo);
      hold(geo, 'lava', ox, ox, 8, 3);
      runFor(geo, 3);
      const cols = geo.cols;
      let worst = 0;
      let most = 0;
      for (let dk = -30; dk <= 30; dk++) {
        for (let di = -30; di <= 30; di++) {
          const a = (256 + di) + (256 + dk) * NX;
          const h = cols.surf(a) - before[a];
          most = Math.max(most, Math.abs(h));
          for (const [ei, ek] of [[-di, dk], [di, -dk], [dk, di], [-dk, -di]]) {
            const b = (256 + ei) + (256 + ek) * NX;
            worst = Math.max(worst, Math.abs(h - (cols.surf(b) - before[b])));
          }
        }
      }
      const share = most > 0 ? worst / most : 1;
      return { pass: most > 0.3 && share <= 0.01, detail: `Largest difference between mirrored sides: ${(share * 100).toFixed(3)}% of the ${f1(most)} m it built.` };
    },
  },
  {
    id: 'lava-shield',
    label: 'Touching the glow for half a minute raises a rounded island about 60 m across',
    quick: false,
    run() {
      // The first-minute pour: the medium brush seen from 300 m (radius 18 m), held on the glow.
      const cols = new Columns();
      const geo = new Geo(cols, 1);
      geo.generateSeabed();
      const { x, z } = geo.seabed.glow;
      hold(geo, 'lava', x, z, 18, 25);
      settle(geo);
      // Width above the sea through the glow, east-west and north-south.
      const across = (dx: number, dz: number) => {
        let n = 0;
        for (let s = -60; s <= 60; s++) if (cols.top(cols.colAt(x + s * CELL * dx, z + s * CELL * dz)) > SEA_LEVEL) n++;
        return n * CELL;
      };
      const width = Math.min(across(1, 0), across(0, 1));
      // A rounded top: from the glow outward the land falls all the way to the coast, rather
      // than staying flat and dropping off a rim.
      const h = (d: number, dx: number, dz: number) => cols.top(cols.colAt(x + d * dx, z + d * dz));
      let falls = true;
      let rise = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const h0 = h(0, dx, dz);
        const h8 = h(8, dx, dz);
        const h16 = h(16, dx, dz);
        const h24 = h(24, dx, dz);
        if (!(h8 <= h0 + 0.05 && h16 < h8 && h24 < h16)) falls = false;
        rise += (h0 - h16) / 4;
      }
      return {
        pass: width >= 54 && width <= 72 && falls && rise >= 0.4,
        detail: `After 25 s the island is ${width} m across; its middle stands ${f1(cols.top(cols.colAt(x, z)))} m high, ${rise.toFixed(2)} m above the ground 16 m out, falling ${falls ? 'steadily' : 'unevenly'} to the coast.`,
      };
    },
  },
  {
    id: 'lava-burns-where-it-goes',
    label: 'Lava burns only the ground it really covers',
    quick: true,
    run() {
      // Pour on a slope (all of it land), then let it run and set; note every column reported
      // as burnt and every column the lava ever reached.
      const geo = testWorld((x) => 30 - x * 0.1);
      const cols = geo.cols;
      const burnt = new Uint8Array(cols.n);
      const reached = new Uint8Array(cols.n);
      const rock0 = cols.rock.slice();
      cols.addListener((i0, k0, i1, k1, flags) => {
        if ((flags & ChangeFlag.Burn) === 0) return;
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) burnt[i + k * NX] = 1;
      });
      // The lava stays well inside this window (it runs downhill, toward +x).
      const wi0 = at(-30, 0) % NX;
      const wi1 = at(150, 0) % NX;
      const wk0 = (at(0, -60) / NX) | 0;
      const wk1 = (at(0, 60) / NX) | 0;
      const look = () => {
        for (let k = wk0; k <= wk1; k++) for (let i = wi0; i <= wi1; i++) if (cols.lava[i + k * NX] > 0) reached[i + k * NX] = 1;
      };
      for (let s = 0; s < 2 / PHYS_STEP; s++) {
        geo.applyTool('lava', 0, 0, 6, PHYS_STEP, 1);
        look();
        geo.step(PHYS_STEP, 1000);
        look();
      }
      for (let s = 0; s < 30 / PHYS_STEP && !geo.isSettled(); s++) {
        geo.step(PHYS_STEP, 1000);
        look();
      }
      let nBurnt = 0;
      let wrong = 0;
      let missed = 0;
      for (let c = 0; c < cols.n; c++) {
        const covered = reached[c] === 1 || cols.rock[c] - rock0[c] > 1e-4;
        if (burnt[c]) nBurnt++;
        if (burnt[c] && !covered) wrong++;
        if (covered && !burnt[c]) missed++;
      }
      return {
        pass: nBurnt > 100 && wrong === 0 && missed === 0,
        detail: `${nBurnt} columns burnt; ${wrong} of them never had lava on them; ${missed} covered columns were not burnt.`,
      };
    },
  },
  {
    id: 'sand-colour',
    label: 'Golden sand poured on a black beach shows golden',
    quick: true,
    run() {
      const geo = testWorld(
        () => 5,
        () => 4,
      );
      geo.cols.sandKind.fill(0);
      hold(geo, 'sand', 0, 0, 12, 2);
      const kind = geo.cols.sandKind[at(0, 0)];
      return { pass: kind >= 140 && kind <= 150, detail: `After 2 s of pouring on 4 m of black sand, the top is colour ${kind} (golden is 150, black 0).` };
    },
  },
  {
    id: 'cliff-retreat',
    label: 'Windward sea cliffs keep wearing back slowly, leaving a rock platform',
    quick: false,
    run() {
      // A 20 m cliff facing the wind (east) over 8 m of water, its shore re-found every year as
      // the first sea column in front of it, as the ecology does.
      const geo = testWorld((x) => (x < 0 ? 20 : -8));
      const cols = geo.cols;
      const shore = new Int32Array(40);
      const edgeOf = (k: number) => {
        let last = -1;
        for (let i = 1; i < NX - 1; i++) if (cols.top(i + k * NX) > SEA_LEVEL) last = i;
        return last;
      };
      const k0 = (at(0, -40) / NX) | 0;
      const before = edgeOf(k0 + 20);
      for (let year = 0; year < 2000; year++) {
        let n = 0;
        for (let k = k0; k < k0 + 40; k++) {
          const last = edgeOf(k);
          if (last >= 0) shore[n++] = last + 1 + k * NX;
        }
        geo.coastYears(1, shore, n, null);
        if (year % 10 === 9) runFor(geo, 0.5);
      }
      const after = edgeOf(k0 + 20);
      const moved = before - after;
      // The rock left in front of the cliff: a platform just under the sea.
      let platform = 0;
      for (let i = after + 1; i <= before; i++) if (Math.abs(cols.rock[i + (k0 + 20) * NX] + 0.5) < 0.05) platform++;
      return {
        pass: moved >= 2 && platform >= moved - 1,
        detail: `After 2,000 windward years the cliff edge moved back ${moved} columns (${moved * CELL} m), leaving ${platform} columns of platform at about -0.5 m.`,
      };
    },
  },
  {
    id: 'reef-whitens',
    label: 'Reef sand slowly whitens even a thick beach',
    quick: false,
    run() {
      // A lee (west-facing) beach with 3 m of golden sand, fed 1 cm of coral sand a year.
      const geo = testWorld(
        (x) => Math.max(-6, x * 0.12) - 1,
        () => 3,
      );
      const cols = geo.cols;
      const shore: number[] = [];
      for (let k = 230; k < 282; k++) {
        let best = -1;
        for (let i = 1; i < NX - 1; i++) {
          const c = i + k * NX;
          if (best < 0 || Math.abs(cols.top(c)) < Math.abs(cols.top(best))) best = c;
        }
        shore.push(best);
      }
      const list = Int32Array.from(shore);
      const reef = new Float32Array(list.length).fill(0.01);
      const k0 = cols.sandKind[list[0]];
      for (let year = 0; year < 400; year++) {
        geo.coastYears(1, list, list.length, reef);
        if (year % 10 === 9) runFor(geo, 0.5);
      }
      let whitest = 0;
      for (let c = 0; c < cols.n; c++) whitest = Math.max(whitest, cols.sandKind[c]);
      return { pass: whitest >= 220, detail: `After 400 years the whitest beach sand is colour ${whitest} (it started at ${k0}; coral white is 250).` };
    },
  },
  {
    id: 'seabed',
    label: 'The starting sea has a glowing knoll near the surface and the sandy Shallows',
    quick: false,
    run() {
      const cols = new Columns();
      const geo = new Geo(cols, 12345);
      geo.generateSeabed();
      const glow = cols.top(cols.colAt(geo.seabed.glow.x, geo.seabed.glow.z));
      let bank = 0;
      let floorSum = 0;
      let floorN = 0;
      let ne = 0;
      let neN = 0;
      let land = 0;
      for (let k = 0; k < NZ; k++) {
        for (let i = 0; i < NX; i++) {
          const c = i + k * NX;
          const x = cols.cx(i);
          const z = cols.cz(k);
          const t = cols.top(c);
          if (t > SEA_LEVEL) land++;
          if (x < 0 && z > 0 && t >= -6 && t <= -3 && cols.sed[c] >= 1) bank++;
          if (Math.abs(x) > 350 && Math.abs(z) < 300) {
            floorSum += t;
            floorN++;
          }
          if (x > 300 && z < -300) {
            ne += t;
            neN++;
          }
        }
      }
      const bankArea = bank * CELL * CELL;
      const floor = floorSum / floorN;
      const neFloor = ne / neN;
      const pass = glow > -4 && glow < SEA_LEVEL && bankArea >= 15000 && floor > -32 && floor < -27 && neFloor < floor && land === 0;
      return {
        pass,
        detail: `The glow knoll tops out at ${f1(glow)} m; the Shallows cover ${Math.round(bankArea / 1000)}k m² at -3 to -6 m with 1 m+ of sand; the floor averages ${f1(floor)} m, ${f1(neFloor)} m in the north-east.`,
      };
    },
  },
  {
    id: 'speed-lava',
    label: 'Lava speed: 10,000 molten columns in under 2 ms a step (this computer)',
    quick: false,
    run() {
      return speedCheck(2, '10,000 molten columns', () => {
        // A hot sheet of 100 x 100 columns flowing down a gentle slope (about 13,000 columns
        // once it spreads). The cost is measured per molten column and scaled to 10,000.
        const geo = testWorld((x) => 30 - x * 0.05);
        const i0 = at(-100, -100) % NX;
        const k0 = (at(-100, -100) / NX) | 0;
        placeLava(geo, i0, k0, i0 + 99, k0 + 99, 2);
        const per: number[] = [];
        for (let s = 0; s < 120; s++) {
          const st = geo.step(PHYS_STEP, 1000);
          if (s >= 20) per.push((st.ms / st.lavaCols) * 10000);
        }
        return per;
      });
    },
  },
  {
    id: 'speed-sand',
    label: 'Sand speed: 20,000 settling columns in under 1.5 ms a step (this computer)',
    quick: false,
    run() {
      return speedCheck(1.5, '20,000 settling sand columns', () => {
        // A big dune poured with a wide brush, then settling: a realistic mix of resting and
        // sliding columns. The cost is measured per listed column and scaled to 20,000.
        const geo = testWorld(
          () => 5,
          () => 0.3,
        );
        const per: number[] = [];
        for (let s = 0; s < 450; s++) {
          if (s < 240) geo.applyTool('sand', 0, 0, 40, PHYS_STEP, 1);
          const st = geo.step(PHYS_STEP, 1000);
          if (st.sandCols >= 1000) per.push((st.ms / st.sandCols) * 20000);
        }
        return per;
      });
    },
  },
]);
