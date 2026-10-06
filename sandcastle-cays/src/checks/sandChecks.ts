/**
 * Automatic checks of the sand rules. They run in the test suite (on the
 * computer that builds the game) and on the in-game Checks page (on your phone).
 * Each one sets up a small test beach, does something, and measures the result.
 */
import type { WorldDims } from '../config';
import { CELL, LAGOON_DIMS } from '../config';
import { Mesher, mergeMeshes } from '../engine/mesher';
import { decodeWorld, encodeWorld } from '../engine/save';
import { Sim } from '../engine/sim';
import { FlatTerrain, LagoonTerrain } from '../engine/terrain';
import { Hand, dig, pat, pile, raycast } from '../engine/tools';
import { UndoStack } from '../engine/undo';
import { World } from '../engine/world';

export interface CheckResult {
  id: string;
  name: string;
  /** What the check proves, in plain words. */
  description: string;
  pass: boolean;
  /** What was measured. */
  detail: string;
  ms: number;
}

const TEST_DIMS: WorldDims = { cx: 6, cy: 4, cz: 6, originX: 0, originY: 0, originZ: 0 };
const GROUND = 0.3; // metres (10 cells)
const GROUND_CELLS = 10;

function makeWorld(wet: number, pack: number, ground = GROUND, dims = TEST_DIMS) {
  const world = new World(dims, new FlatTerrain(ground, wet, pack));
  const sim = new Sim(world);
  sim.dryRate = 0;
  return { world, sim };
}

/** Run the physics until nothing moves. Returns the number of steps taken. */
function settle(sim: Sim, maxSteps = 4000): number {
  for (let s = 0; s < maxSteps; s++) {
    sim.step(1 / 30);
    if (!sim.busy) return s + 1;
  }
  return maxSteps;
}

/** Top surface height of a column, in cells. */
function surfaceCells(world: World, i: number, k: number): number {
  for (let j = world.ny - 1; j >= 0; j--) {
    const f = world.fillAt(i, j, k);
    if (f > 0) return j + f / 255;
  }
  return 0;
}

function fillBox(world: World, sim: Sim, i0: number, i1: number, j0: number, j1: number, k0: number, k1: number, fill: number, wet: number, pack: number): number {
  let n = 0;
  for (let j = j0; j <= j1; j++) {
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        world.setCell(i, j, k, fill, wet, pack);
        if (fill > 0) n++;
      }
    }
  }
  sim.wakeBox(i0 - 1, j0 - 1, k0 - 1, i1 + 1, j1 + 1, k1 + 1);
  return n;
}

function countSand(world: World, i0: number, i1: number, j0: number, j1: number, k0: number, k1: number): number {
  let total = 0;
  for (let j = j0; j <= j1; j++) {
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) total += world.fillAt(i, j, k);
    }
  }
  return total / 255;
}

/** Fingerprint of every cell, to compare two states exactly. */
function fingerprint(world: World): string {
  let h1 = 2166136261;
  let h2 = 0;
  for (let j = 0; j < world.ny; j++) {
    for (let k = 0; k < world.nz; k++) {
      for (let i = 0; i < world.nx; i++) {
        const f = world.fillAt(i, j, k);
        const v = f === 0 ? 0 : f | (world.wetAt(i, j, k) << 8) | (world.packAt(i, j, k) << 16);
        h1 = Math.imul(h1 ^ v, 16777619);
        h2 = (h2 + v * (i + 7 * j + 13 * k + 1)) % 1000000007;
      }
    }
  }
  return `${h1 >>> 0}:${h2}`;
}

/** Pour sand onto the middle of the test beach, like a slow stream from a hand. */
function pourPile(wet: number, groundWet: number, cells: number) {
  const { world, sim } = makeWorld(groundWet, 60);
  const ci = 48;
  const ck = 48;
  const batch = 20;
  for (let poured = 0; poured < cells; poured += batch) {
    const top = Math.floor(surfaceCells(world, ci, ck));
    sim.deposit(ci, top, ck, batch * 255, wet);
    for (let s = 0; s < 4; s++) sim.step(1 / 30);
  }
  settle(sim);
  const peak = surfaceCells(world, ci, ck) - GROUND_CELLS;
  // Average radius where the pile meets the ground, along 8 directions.
  let rSum = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  for (const [dx, dz] of dirs) {
    const step = Math.hypot(dx, dz);
    let r = 0;
    for (let s = 1; s < 45; s++) {
      if (surfaceCells(world, ci + dx * s, ck + dz * s) - GROUND_CELLS < 0.5) {
        r = s * step;
        break;
      }
    }
    rSum += r;
  }
  const radius = rSum / dirs.length;
  const angle = (Math.atan2(peak, radius) * 180) / Math.PI;
  return { peak, radius, angle };
}

type CheckFn = () => { pass: boolean; detail: string };

const CHECKS: { id: string; name: string; description: string; run: CheckFn }[] = [
  {
    id: 'dry-cone',
    name: 'Dry sand pours into a cone',
    description: 'A stream of dry sand settles into a cone with gentle sides, like a real pile (about 25 to 40 degrees).',
    run: () => {
      const r = pourPile(5, 5, 1200);
      return {
        pass: r.angle >= 22 && r.angle <= 40 && r.peak > 4,
        detail: `slope ${r.angle.toFixed(1)}°, height ${(r.peak * CELL * 100).toFixed(0)} cm, radius ${(r.radius * CELL * 100).toFixed(0)} cm`,
      };
    },
  },
  {
    id: 'damp-steeper',
    name: 'Damp sand piles steeper than dry sand',
    description: 'The same amount of damp sand makes a taller, steeper heap than dry sand.',
    run: () => {
      const dry = pourPile(5, 5, 1200);
      const damp = pourPile(130, 130, 1200);
      return {
        pass: damp.angle >= dry.angle + 8 && damp.peak > dry.peak,
        detail: `damp ${damp.angle.toFixed(0)}° vs dry ${dry.angle.toFixed(0)}°`,
      };
    },
  },
  {
    id: 'packed-wall',
    name: 'A packed damp wall stands',
    description: 'A 75 cm wall of well-packed damp sand keeps its shape.',
    run: () => {
      const { world, sim } = makeWorld(130, 150);
      const before = fillBox(world, sim, 40, 47, GROUND_CELLS, GROUND_CELLS + 24, 30, 65, 255, 130, 255);
      const steps = settle(sim);
      const after = countSand(world, 40, 47, GROUND_CELLS, GROUND_CELLS + 24, 30, 65);
      const kept = after / before;
      return { pass: kept >= 0.98, detail: `${(kept * 100).toFixed(1)}% of the wall still standing after ${steps} steps` };
    },
  },
  {
    id: 'dry-wall',
    name: 'A dry wall slumps',
    description: 'The same wall built from dry, loose sand slumps into a low ridge.',
    run: () => {
      const { world, sim } = makeWorld(5, 40);
      fillBox(world, sim, 40, 47, GROUND_CELLS, GROUND_CELLS + 24, 30, 65, 255, 5, 0);
      settle(sim);
      let peak = 0;
      for (let k = 30; k <= 65; k++) for (let i = 30; i <= 57; i++) peak = Math.max(peak, surfaceCells(world, i, k) - GROUND_CELLS);
      return { pass: peak <= 25 * 0.6, detail: `tallest point ${(peak * CELL * 100).toFixed(0)} cm (was 75 cm)` };
    },
  },
  {
    id: 'tunnel-holds',
    name: 'A tunnel holds in packed damp sand',
    description: 'A 24 cm wide tunnel dug through a block of packed damp sand keeps its roof.',
    run: () => {
      const { world, sim } = makeWorld(130, 150);
      fillBox(world, sim, 33, 62, GROUND_CELLS, GROUND_CELLS + 19, 33, 62, 255, 130, 230);
      settle(sim);
      const roofBefore = countSand(world, 44, 51, GROUND_CELLS + 6, GROUND_CELLS + 19, 33, 62);
      fillBox(world, sim, 44, 51, GROUND_CELLS, GROUND_CELLS + 5, 33, 62, 0, 0, 0);
      settle(sim);
      const roofAfter = countSand(world, 44, 51, GROUND_CELLS + 6, GROUND_CELLS + 19, 33, 62);
      const kept = roofAfter / roofBefore;
      return { pass: kept >= 0.95, detail: `${(kept * 100).toFixed(1)}% of the roof still up` };
    },
  },
  {
    id: 'tunnel-collapses',
    name: 'A tunnel caves in when the sand is dry',
    description: 'The same tunnel in dry sand collapses and fills with sand.',
    run: () => {
      const { world, sim } = makeWorld(5, 40);
      fillBox(world, sim, 33, 62, GROUND_CELLS, GROUND_CELLS + 19, 33, 62, 255, 5, 0);
      fillBox(world, sim, 44, 51, GROUND_CELLS, GROUND_CELLS + 5, 33, 62, 0, 0, 0);
      settle(sim);
      const inTunnel = countSand(world, 44, 51, GROUND_CELLS, GROUND_CELLS + 5, 40, 55);
      const volume = 8 * 6 * 16;
      return { pass: inTunnel / volume >= 0.5, detail: `${((inTunnel / volume) * 100).toFixed(0)}% of the tunnel filled in` };
    },
  },
  {
    id: 'overhang-limit',
    name: 'Overhangs only reach so far',
    description: 'A short shelf of packed damp sand holds; a long one breaks off at the end.',
    run: () => {
      const { world, sim } = makeWorld(130, 150);
      // A pillar with a 4-cell shelf and one with a 16-cell shelf.
      fillBox(world, sim, 20, 25, GROUND_CELLS, GROUND_CELLS + 20, 20, 25, 255, 130, 255);
      fillBox(world, sim, 26, 29, GROUND_CELLS + 18, GROUND_CELLS + 20, 20, 25, 255, 130, 255);
      fillBox(world, sim, 60, 65, GROUND_CELLS, GROUND_CELLS + 20, 60, 65, 255, 130, 255);
      fillBox(world, sim, 66, 81, GROUND_CELLS + 18, GROUND_CELLS + 20, 60, 65, 255, 130, 255);
      settle(sim);
      const shortShelf = countSand(world, 26, 29, GROUND_CELLS + 18, GROUND_CELLS + 20, 20, 25) / (4 * 3 * 6);
      const longTip = countSand(world, 76, 81, GROUND_CELLS + 18, GROUND_CELLS + 20, 60, 65) / (6 * 3 * 6);
      return {
        pass: shortShelf >= 0.95 && longTip <= 0.1,
        detail: `short shelf ${(shortShelf * 100).toFixed(0)}% kept, end of long shelf ${(longTip * 100).toFixed(0)}% kept`,
      };
    },
  },
  {
    id: 'conservation',
    name: 'Sand is never created or destroyed',
    description: 'After digging, piling, patting and slumping, every grain is accounted for (beach + hands + falling).',
    run: () => {
      const { world, sim } = makeWorld(100, 120);
      const hand = new Hand();
      const total0 = world.totalSand();
      const down = (x: number, z: number) => raycast(world, x, 1.5, z, 0, -1, 0);
      for (let n = 0; n < 40; n++) {
        const hit = down(1.2 + (n % 5) * 0.02, 1.2);
        if (hit) dig(sim, hand, hit, 0.09, 1 / 30);
        sim.step(1 / 30);
      }
      for (let n = 0; n < 60; n++) {
        const hit = down(1.7, 1.5);
        if (hit) pile(sim, hand, hit, 0.08, 45, 1 / 30);
        sim.step(1 / 30);
      }
      const p = down(1.7, 1.5);
      if (p) pat(sim, p, 0.12, 1);
      settle(sim);
      const total1 = world.totalSand() + hand.amount + sim.particles.totalSand();
      return { pass: total0 === total1 && hand.amount >= 0, detail: `before ${total0}, after ${total1} (units of 1/255 cell)` };
    },
  },
  {
    id: 'undo',
    name: 'Undo puts everything back exactly',
    description: 'Dig a hole, let it slump, then undo: every cell and your hands are exactly as before.',
    run: () => {
      const { world, sim } = makeWorld(20, 60);
      const undo = new UndoStack(world);
      const hand = new Hand();
      fillBox(world, sim, 40, 50, GROUND_CELLS, GROUND_CELLS + 6, 40, 50, 255, 140, 200);
      settle(sim);
      const before = fingerprint(world);
      undo.begin(hand.amount, hand.wetSum);
      for (let n = 0; n < 30; n++) {
        const hit = raycast(world, 1.35, 1.5, 1.35, 0, -1, 0);
        if (hit) dig(sim, hand, hit, 0.09, 1 / 30);
        sim.step(1 / 30);
      }
      settle(sim);
      const changed = fingerprint(world) !== before;
      const res = undo.undo();
      if (res) {
        hand.amount = res.handAmount;
        hand.wetSum = res.handWetSum;
        sim.removeParticlesFrom(res.id);
      }
      const after = fingerprint(world);
      return { pass: changed && after === before && hand.amount === 0, detail: changed ? (after === before ? 'identical' : 'different') : 'digging changed nothing' };
    },
  },
  {
    id: 'save-load',
    name: 'Saving and loading gives the same beach',
    description: 'A beach with a castle and a hole is saved and loaded back cell for cell.',
    run: () => {
      const { world, sim } = makeWorld(60, 100);
      const hand = new Hand();
      fillBox(world, sim, 20, 30, GROUND_CELLS, GROUND_CELLS + 15, 20, 30, 255, 150, 255);
      for (let n = 0; n < 20; n++) {
        const hit = raycast(world, 2.0, 1.5, 2.0, 0, -1, 0);
        if (hit) dig(sim, hand, hit, 0.09, 1 / 30);
        sim.step(1 / 30);
      }
      settle(sim);
      const raw = encodeWorld(world, { savedAt: '', gameVersion: 'test', beach: 'test', hand: { amount: hand.amount, wetSum: hand.wetSum } });
      const world2 = new World(TEST_DIMS, world.terrain);
      const header = decodeWorld(world2, raw);
      const same = fingerprint(world) === fingerprint(world2) && header.hand.amount === hand.amount;
      return { pass: same, detail: `${(raw.length / 1024).toFixed(0)} KB before compression, ${same ? 'identical' : 'different'}` };
    },
  },
  {
    id: 'drying',
    name: 'Damp sand dries in the sun, from the outside in',
    description: 'The outside of a damp mound dries while sand a few centimetres inside stays damp.',
    run: () => {
      const { world, sim } = makeWorld(130, 150);
      fillBox(world, sim, 40, 55, GROUND_CELLS, GROUND_CELLS + 10, 40, 55, 255, 130, 200);
      settle(sim);
      sim.dryRate = 6;
      for (let s = 0; s < 900; s++) sim.step(1 / 30);
      const skin = world.wetAt(47, GROUND_CELLS + 10, 47);
      const inside = world.wetAt(47, GROUND_CELLS + 6, 47);
      return { pass: skin < 60 && inside >= 120, detail: `outside moisture ${skin}, 12 cm inside ${inside} (start 130)` };
    },
  },
  {
    id: 'mesh-closed',
    name: 'The sand surface has no holes or cracks',
    description: 'A ball of sand crossing eight chunks becomes one closed surface with no gaps at the seams.',
    run: () => {
      const world = new World(TEST_DIMS, new FlatTerrain(-1, 0, 0));
      const c = 32;
      for (let j = c - 12; j <= c + 12; j++) {
        for (let k = c - 12; k <= c + 12; k++) {
          for (let i = c - 12; i <= c + 12; i++) {
            const d = Math.hypot(i - c + 0.5, j - c + 0.5, k - c + 0.5);
            const f = Math.max(0, Math.min(255, Math.round((10.3 - d) * 255)));
            if (f > 0) world.setCell(i, j, k, f, 100, 100);
          }
        }
      }
      const mesher = new Mesher(world);
      const parts = [];
      for (let cy = 0; cy < 4; cy++) for (let cz = 0; cz < 4; cz++) for (let cx = 0; cx < 4; cx++) {
        const m = mesher.meshChunk(cx, cy, cz);
        if (m) parts.push(m);
      }
      const merged = mergeMeshes(parts);
      // Weld identical positions, then every edge must be shared by exactly two triangles.
      const ids = new Map<string, number>();
      const weld: number[] = [];
      const P = merged.positions;
      for (let v = 0; v < P.length / 3; v++) {
        const key = `${Math.round(P[v * 3] * 1e4)},${Math.round(P[v * 3 + 1] * 1e4)},${Math.round(P[v * 3 + 2] * 1e4)}`;
        let id = ids.get(key);
        if (id === undefined) ids.set(key, (id = ids.size));
        weld.push(id);
      }
      const edges = new Map<string, number>();
      const I = merged.indices;
      for (let t = 0; t < I.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = weld[I[t + e]];
          const b = weld[I[t + ((e + 1) % 3)]];
          const key = a < b ? `${a},${b}` : `${b},${a}`;
          edges.set(key, (edges.get(key) ?? 0) + 1);
        }
      }
      let bad = 0;
      for (const n of edges.values()) if (n !== 2) bad++;
      return { pass: bad === 0 && I.length > 0, detail: `${I.length / 3} triangles, ${bad} open edges` };
    },
  },
  {
    id: 'speed-sim',
    name: 'The sand physics keeps up',
    description: 'A 75 cm wall of dry sand collapsing (7,000 cells moving) settles quickly without slowing the game.',
    run: () => {
      const { world, sim } = makeWorld(5, 40);
      fillBox(world, sim, 40, 47, GROUND_CELLS, GROUND_CELLS + 24, 30, 65, 255, 5, 0);
      const t0 = now();
      const steps = settle(sim, 1500);
      const ms = (now() - t0) / steps;
      return { pass: ms < 20 && steps < 1500, detail: `${ms.toFixed(2)} ms per step, settled in ${(steps / 30).toFixed(1)} s of game time` };
    },
  },
  {
    id: 'speed-mesh',
    name: 'The beach surface builds fast enough',
    description: 'Turning sand into a smooth surface takes only a few milliseconds per piece of beach.',
    run: () => {
      const world = new World(LAGOON_DIMS, new LagoonTerrain());
      const mesher = new Mesher(world);
      let n = 0;
      const t0 = now();
      for (let cz = 8; cz < 16 && n < 48; cz++) {
        for (let cx = 10; cx < 22 && n < 48; cx++) {
          for (let cy = 0; cy < world.ncy; cy++) {
            if (world.procUniform(cx, cy, cz) === 'mixed') {
              mesher.meshChunk(cx, cy, cz);
              n++;
            }
          }
        }
      }
      const ms = (now() - t0) / Math.max(1, n);
      return { pass: ms < 6, detail: `${ms.toFixed(2)} ms per chunk (${n} chunks)` };
    },
  },
];

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export const CHECK_LIST = CHECKS.map(({ id, name, description }) => ({ id, name, description }));

export function runSandCheck(id: string): CheckResult {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown check ${id}`);
  const t0 = now();
  let res: { pass: boolean; detail: string };
  try {
    res = c.run();
  } catch (err) {
    res = { pass: false, detail: `crashed: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { id: c.id, name: c.name, description: c.description, pass: res.pass, detail: res.detail, ms: now() - t0 };
}

export function runSandChecks(): CheckResult[] {
  return CHECKS.map((c) => runSandCheck(c.id));
}
