/**
 * Scripted islands for the life simulation's checks and the tuning simulator
 * (tools/simulate.ts). They are shaped straight into the columns, no physics: a tall volcanic
 * cone with a crater basin, a low sandy cay, a chain of islands around a sound, and small
 * test shapes. A tiny stand-in for geology (ScriptGeo) lets reefs grow.
 */
import { NX, NZ } from '../config';
import { ChangeFlag, RockKind, type Columns } from '../engine/columns';
import { buildPlainSeabed } from '../engine/fixtures';
import type { GeoForEco } from '../engine/geo/geo';
import { smooth } from './maths';

export interface ConeOpts {
  /** Crater: radius (m) and depth (m), offset toward the windward side by `craterOff` m. */
  crater?: { r: number; depth: number; off?: number };
  /** Sand beaches on the lee (west) and south shores. */
  beaches?: boolean;
  /** Sea cliffs on the windward (east) shore. */
  cliffs?: boolean;
  /** Rock kind (Basalt by default: fresh lava). */
  rock?: RockKind;
}

/** Height of a cone at normalised distance u (1 = shoreline). Below the shoreline it plunges to the floor. */
function coneHeight(u: number, peak: number): number {
  return u < 1 ? peak * Math.pow(1 - u, 1.35) : -20 * ((u - 1) / 0.4);
}

/** A volcanic cone island centred at (x, z), shoreline radius r, peak height `peak`. */
export function cone(cols: Columns, x: number, z: number, r: number, peak: number, o: ConeOpts = {}): void {
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const cx = cols.cx(i);
      const cz = cols.cz(k);
      const dx = cx - x;
      const dz = cz - z;
      const d = Math.hypot(dx, dz);
      const u = d / r;
      if (u > 1.6) continue;
      const c = i + k * NX;
      let h = coneHeight(u, peak);
      if (o.cliffs && dx > 0 && u > 0.55 && u < 1.06) {
        // Windward sea cliffs: a 16 m shelf that drops straight into the sea within about 4 m,
        // so the ground within a patch or two of the water stands well above 8 m.
        const drop = Math.max(0.02, 4 / r);
        const shelf = 16 * smooth(1.04, 1.04 - drop, u) * smooth(0.2, 0.6, dx / d);
        h = Math.max(h, shelf);
      }
      if (o.crater) {
        // A bowl: inside the rim the ground drops below the rim's height.
        const off = o.crater.off ?? 0;
        const cd = Math.hypot(dx - off, dz);
        const rim = o.crater.r;
        if (cd < rim * 1.3) {
          const rimH = coneHeight(Math.hypot(rim + off, 0) / r, peak);
          const bowl = rimH - o.crater.depth * (1 - (cd / rim) * (cd / rim));
          const t = smooth(rim * 1.3, rim, cd);
          h = h * (1 - t) + Math.min(h, cd < rim ? bowl : rimH) * t;
        }
      }
      const top = cols.rock[c] + cols.sed[c];
      if (h <= top) continue;
      cols.rock[c] = h;
      cols.sed[c] = 0;
      cols.rockKind[c] = o.rock ?? RockKind.Basalt;
    }
  }
  if (o.beaches) beachApron(cols, x, z, r);
}

/** Sand aprons at the waterline on the lee and south of a cone at (x, z) with shoreline radius r (as if poured). */
export function beachApron(cols: Columns, x: number, z: number, r: number): void {
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const dx = cols.cx(i) - x;
      const u = Math.hypot(dx, cols.cz(k) - z) / r;
      if (dx >= 0.2 * r || u <= 0.84 || u >= 1.12) continue;
      const t = 1 - Math.abs(u - 0.98) / 0.14;
      if (t <= 0) continue;
      const c = i + k * NX;
      cols.rock[c] = Math.min(cols.rock[c], 1.6) - 1.5 * t;
      cols.sed[c] = 1.5 * t + 0.4;
      cols.sandKind[c] = 120;
    }
  }
}

/** A low sand cay (white coral sand). */
export function cay(cols: Columns, x: number, z: number, r: number, h: number, sandKind = 240): void {
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const d = Math.hypot(cols.cx(i) - x, cols.cz(k) - z) / r;
      if (d > 1.8) continue;
      const c = i + k * NX;
      const top = h * (1 - smooth(0.15, 1, d)) - 5 * smooth(0.85, 1.6, d);
      const cur = cols.rock[c] + cols.sed[c];
      if (top <= cur) continue;
      cols.sed[c] += top - cur;
      cols.sandKind[c] = sandKind;
    }
  }
}

/** Raise (or lower) a disc of rock to height `h` with soft edges. */
export function disc(cols: Columns, x: number, z: number, r: number, h: number, kind: RockKind = RockKind.Basalt): void {
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const d = Math.hypot(cols.cx(i) - x, cols.cz(k) - z);
      if (d > r) continue;
      const c = i + k * NX;
      cols.rock[c] = h;
      cols.sed[c] = 0;
      cols.rockKind[c] = kind;
    }
  }
}

/** Spread sand `depth` m thick over a disc (beaches, burial). */
export function sandDisc(cols: Columns, x: number, z: number, r: number, depth: number, sandKind = 150): void {
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const d = Math.hypot(cols.cx(i) - x, cols.cz(k) - z);
      if (d > r) continue;
      const c = i + k * NX;
      cols.sed[c] += depth;
      cols.sandKind[c] = sandKind;
    }
  }
}

/** A flat sea floor `depth` metres down, sand over rock (for small, exact test shapes). */
export function flatSea(cols: Columns, depth = 12): void {
  for (let c = 0; c < NX * NZ; c++) {
    cols.rock[c] = -depth - 1;
    cols.sed[c] = 1;
    cols.lava[c] = 0;
    cols.temp[c] = 0;
    cols.sandKind[c] = 150;
    cols.rockKind[c] = RockKind.Basalt;
  }
}

/** Plain seabed (the lead's fixture: a north–south ridge and a sandy bank). */
export function seabed(cols: Columns, seed = 1): void {
  buildPlainSeabed(cols, seed);
}

/** Report the whole zone as changed by a tool. */
export function markAll(cols: Columns, burn = false): void {
  cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Tool | (burn ? ChangeFlag.Burn : 0));
}

// ---------- scenarios ----------

/** The tall volcanic island: crater basin near the summit, beaches on the lee (unless `beaches` is false), cliffs to windward. */
export function highIsland(cols: Columns, scale = 1, beaches = true): void {
  seabed(cols);
  cone(cols, 40, -20, 170 * scale, 110 * Math.min(1, 0.4 + 0.6 * scale), { crater: { r: 22 * scale, depth: 9, off: 10 }, beaches, cliffs: true });
}

/** The high island's lee beaches, poured later (the simulator's player-paced run). */
export function highIslandBeaches(cols: Columns, scale = 1): void {
  beachApron(cols, 40, -20, 170 * scale);
}

/** A low white-sand cay on the Shallows. */
export function lowCay(cols: Columns, r = 90): void {
  seabed(cols);
  cay(cols, -260, 250, r, 5);
}

/** Three islands around deep water: a sound. Plus a small islet for seabirds. */
export function chain(cols: Columns): void {
  seabed(cols);
  for (let n = 0; n < 4; n++) chainIsland(cols, n);
}

/**
 * One island of the chain: 0 the big one (crater, windward cliffs), 1 and 2 the two that close
 * the sound with it, 3 the seabird islet. The simulator's player-paced run raises them in turn.
 */
export function chainIsland(cols: Columns, n: number): void {
  if (n === 3) {
    cone(cols, 330, -240, 22, 18, { cliffs: true });
    return;
  }
  const D = 205;
  const a = (n / 3) * Math.PI * 2 + Math.PI / 2;
  cone(cols, 20 + Math.cos(a) * D, Math.sin(a) * D, 150, n === 0 ? 95 : 55, { beaches: true, cliffs: n === 0, crater: n === 0 ? { r: 18, depth: 8, off: 8 } : undefined });
}

/**
 * A minimal stand-in for geology: reefs grow as limestone, and storm surf pulls a little sand
 * off the beaches (so the storm path through the ecology is exercised); calm-years coasts do
 * nothing.
 */
export class ScriptGeo implements GeoForEco {
  level = 0;
  constructor(private cols: Columns) {}
  setStorm(level: number): void {
    this.level = level;
  }
  /** Surf takes up to 1 cm of sand a second at full storm from shore columns near the waterline. */
  stormPulse(level: number, dt: number, shore: Int32Array, n: number): void {
    const C = this.cols;
    const take = 0.01 * level * dt;
    if (take <= 0) return;
    let i0 = NX;
    let k0 = NZ;
    let i1 = -1;
    let k1 = -1;
    for (let j = 0; j < n; j++) {
      const c = shore[j];
      const top = C.rock[c] + C.sed[c];
      if (C.sed[c] <= 0 || top < -1.5 || top > 2.5) continue;
      C.touch(c);
      C.sed[c] = Math.max(0, C.sed[c] - take);
      const i = c % NX;
      const k = (c / NX) | 0;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
    }
    if (i1 >= i0) C.markChanged(i0, k0, i1, k1, ChangeFlag.Geom | ChangeFlag.Look);
  }
  coastYears(): void {}
  growReef(cols: Int32Array, amounts: Float32Array, n: number): void {
    if (n === 0) return;
    const C = this.cols;
    let i0 = NX;
    let k0 = NZ;
    let i1 = -1;
    let k1 = -1;
    for (let j = 0; j < n; j++) {
      const c = cols[j];
      if (C.rock[c] + C.sed[c] >= -0.5) continue;
      C.touch(c);
      C.rock[c] += amounts[j];
      C.rockKind[c] = RockKind.Limestone;
      const i = c % NX;
      const k = (c / NX) | 0;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (k < k0) k0 = k;
      if (k > k1) k1 = k;
    }
    if (i1 >= i0) C.markChanged(i0, k0, i1, k1, ChangeFlag.Geom | ChangeFlag.Look);
  }
}
