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

/**
 * The quickest and the middle of a set of step timings. The speed checks judge the quickest:
 * the computer may be busy with other work, which only ever adds time, so the quickest step is
 * the fairest measure of what the code itself costs. The middle one is reported alongside. If
 * the machine is very busy, a check takes a short pause and measures again (up to SPEED_ROUNDS).
 */
function timing(ms: number[]): { best: number; middle: number } {
  if (ms.length === 0) return { best: Infinity, middle: Infinity };
  const sorted = ms.slice().sort((a, b) => a - b);
  return { best: sorted[0], middle: sorted[sorted.length >> 1] };
}

const SPEED_ROUNDS = 5;
const SPEED_PAUSE_MS = 300;
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

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
    async run() {
      const per: number[] = [];
      for (let round = 0; round < SPEED_ROUNDS && timing(per).best > 2; round++) {
        if (round > 0) await pause(SPEED_PAUSE_MS);
        // A hot sheet of 100 x 100 columns flowing down a gentle slope.
        const geo = testWorld((x) => 30 - x * 0.05);
        const i0 = at(-100, -100) % NX;
        const k0 = (at(-100, -100) / NX) | 0;
        placeLava(geo, i0, k0, i0 + 99, k0 + 99, 2);
        for (let s = 0; s < 120; s++) {
          const st = geo.step(PHYS_STEP, 1000);
          if (s >= 20) per.push((st.ms / st.lavaCols) * 10000);
        }
      }
      const { best, middle } = timing(per);
      return { pass: best <= 2, detail: `${best.toFixed(2)} ms per step for 10,000 molten columns at best, ${middle.toFixed(2)} ms typical (2 ms allowed).` };
    },
  },
  {
    id: 'speed-sand',
    label: 'Sand speed: 20,000 settling columns in under 1.5 ms a step (this computer)',
    quick: false,
    async run() {
      const per: number[] = [];
      for (let round = 0; round < SPEED_ROUNDS && timing(per).best > 1.5; round++) {
        if (round > 0) await pause(SPEED_PAUSE_MS);
        // A big dune poured with a wide brush, then settling: a realistic mix of resting and
        // sliding columns. The cost is measured per listed column and scaled to 20,000.
        const geo = testWorld(
          () => 5,
          () => 0.3,
        );
        for (let s = 0; s < 450; s++) {
          if (s < 240) geo.applyTool('sand', 0, 0, 40, PHYS_STEP, 1);
          const st = geo.step(PHYS_STEP, 1000);
          if (st.sandCols >= 1000) per.push((st.ms / st.sandCols) * 20000);
        }
      }
      const { best, middle } = timing(per);
      return { pass: best <= 1.5, detail: `${best.toFixed(2)} ms per step for 20,000 sand columns at best, ${middle.toFixed(2)} ms typical (1.5 ms allowed).` };
    },
  },
]);
