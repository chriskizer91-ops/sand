/**
 * The shaping tools (WP-B, ARCHITECTURE §5.2): Lava, Rock, Sand, Hands and Scoop.
 *
 * The engine hub calls apply() every physics step while a stroke is held, at the stroke's
 * latest point. Brushes are round with soft edges.
 *  - Pours are measured by VOLUME per second, in proportion to the brush's area: a big brush
 *    covers more ground at the same build-up speed, rather than piling impossibly fast.
 *  - Every tool fades out near the top of the building range (BUILD_FADE..BUILD_MAX) and
 *    within EDGE_FADE of the zone's edge, so there is never a hard wall to bump into.
 *  - Lava pours molten at full heat and then flows (lava.ts). Rock is set steeply where it
 *    lands and never moves. Sand is poured and then slides (sand.ts). Hands smooth. Scoop
 *    carves away: lava first, then sand, then rock (slowly).
 */
import {
  BRUSH_MAX,
  BUILD_FADE,
  BUILD_MAX,
  BUILD_MIN,
  CELL,
  EDGE_FADE,
  NX,
  NZ,
  ORIGIN_X,
  ORIGIN_Z,
  type ToolId,
} from '../../config';
import { ChangeFlag, RockKind, type Columns } from '../columns';
import { smoothstep } from '../noise';
import { BURN_ABOVE, type Lava } from './lava';
import { ChangeTracker, hashInt, mixKind, PATCH_BITS, qSed, type Reporter, type Sand } from './sand';

export interface ToolResult {
  /** Volume added (+) or removed (-) this call, m^3. */
  volume: number;
  /** Column rectangle touched (inclusive), or null if nothing changed. */
  rect: [number, number, number, number] | null;
}

/**
 * Lava pours this many cubic metres per second for each square metre of brush (so 0.9 m of
 * depth per second averaged over the brush). Tuned so the medium brush seen from 300 m
 * (radius 18 m) lifts a 60 m-wide island out of the sea from a -2.5 m knoll in 20-30 s.
 */
export const LAVA_RATE = 0.9;
/** Rock is placed at a third of lava's rate: it is for cliffs and stacks, not bulk land. */
export const ROCK_RATE = LAVA_RATE / 3;
/** Sand pours at half of lava's rate. */
export const SAND_RATE = LAVA_RATE / 2;
/** Scoop carves sand at half of lava's rate (rock at half that). */
export const SCOOP_RATE = LAVA_RATE / 2;
/** Lava never heaps more than this deep under the brush (m). */
const LAVA_HEAP = 12;
/** Poured sand is golden. */
const POUR_KIND = 150;
/** Hands move the surface this share of the way to the local average per second (brush centre). */
const HANDS_RATE = 0.8;
/** On bare rock, Hands work at this share of their speed (like weathering). */
const HANDS_ROCK = 0.06;
/** Hands never move one column by more than this per second (m), so small smoothing stays small. */
const HANDS_MAX = 0.6;
/** Rock lands as tumbling boulders: each column gets a random share of 65%-135% each step. */
const ROCK_LUMP = 0.7;
/** Every tool change is reported with these flags (plus Burn where lava newly covers ground). */
const TOOL_CHANGE = ChangeFlag.Tool | ChangeFlag.Geom | ChangeFlag.Look;
const TOOL_BURN = TOOL_CHANGE | ChangeFlag.Burn;

/** Scratch size: the widest brush plus a 2-column margin for the Hands average, per side. */
const BOX = 2 * Math.ceil(BRUSH_MAX / CELL) + 8;

export class Tools {
  /** Brush weight per column of the brush box. */
  private readonly weight = new Float32Array(BOX * BOX);
  /** Hands: the surface, its 5-wide row sums and the planned change per column. */
  private readonly surf = new Float32Array(BOX * BOX);
  private readonly rowSum = new Float32Array(BOX * BOX);
  private readonly want = new Float32Array(BOX * BOX);
  /** What one call changed. */
  private readonly rect = new Rect();
  /**
   * Where one call newly covered ground with lava, gathered per patch: a pour's round edge then
   * burns only the patches the lava really reached, not the corners of the square around it.
   */
  private readonly burns = new ChangeTracker(PATCH_BITS);
  private rockPlaced = 0;
  private tick = 0;

  constructor(
    private readonly cols: Columns,
    private readonly lava: Lava,
    private readonly sand: Sand,
    private readonly report: Reporter,
  ) {}

  /** Rock volume placed since the last call (m^3), for clatter sounds. */
  takeRockPlaced(): number {
    const v = this.rockPlaced;
    this.rockPlaced = 0;
    return v;
  }

  /** Apply `tool` for dt seconds at world (x, z) with brush radius `radius` (m) and strength 0..1. */
  apply(tool: ToolId, x: number, z: number, radius: number, dt: number, strength: number): ToolResult {
    if (tool === 'look' || !(dt > 0) || !(strength > 0)) return { volume: 0, rect: null };
    const r = Math.max(1.5, Math.min(BRUSH_MAX, radius));
    // Columns whose centres are inside the brush (never the zone's outer ring, which is a wall).
    const i0 = Math.max(1, Math.ceil((x - r - ORIGIN_X) / CELL - 0.5));
    const i1 = Math.min(NX - 2, Math.floor((x + r - ORIGIN_X) / CELL - 0.5));
    const k0 = Math.max(1, Math.ceil((z - r - ORIGIN_Z) / CELL - 0.5));
    const k1 = Math.min(NZ - 2, Math.floor((z + r - ORIGIN_Z) / CELL - 0.5));
    if (i1 < i0 || k1 < k0) return { volume: 0, rect: null };
    this.tick++;
    this.rect.reset();
    const total = this.weigh(tool, x, z, r, i0, k0, i1, k1);
    if (total <= 0) return { volume: 0, rect: null };
    strength = Math.min(1, strength);
    const area = Math.PI * r * r;
    switch (tool) {
      case 'lava':
        return this.pourLava((LAVA_RATE * area * strength * dt) / (total * CELL * CELL), i0, k0, i1, k1);
      case 'rock':
        return this.placeRock((ROCK_RATE * area * strength * dt) / (total * CELL * CELL), i0, k0, i1, k1);
      case 'sand':
        return this.pourSand((SAND_RATE * area * strength * dt) / (total * CELL * CELL), i0, k0, i1, k1);
      case 'scoop':
        return this.scoop((SCOOP_RATE * area * strength * dt) / (total * CELL * CELL), i0, k0, i1, k1);
      case 'hands':
        return this.smooth(HANDS_RATE * strength * dt, HANDS_MAX * dt, i0, k0, i1, k1);
    }
  }

  /**
   * Fill the brush weights and return their sum. Most tools use a soft dome (1 - (d/r)^2)^2;
   * rock uses a flat-topped, steep-sided shape with a lumpy random spread, so holding still
   * builds a pillar and dragging builds a wall.
   */
  private weigh(tool: ToolId, x: number, z: number, r: number, i0: number, k0: number, i1: number, k1: number): number {
    const w = this.weight;
    const bw = i1 - i0 + 1;
    const inv = 1 / (r * r);
    let total = 0;
    for (let k = k0; k <= k1; k++) {
      const dz = ORIGIN_Z + (k + 0.5) * CELL - z;
      for (let i = i0; i <= i1; i++) {
        const dx = ORIGIN_X + (i + 0.5) * CELL - x;
        const t2 = (dx * dx + dz * dz) * inv;
        let v = 0;
        if (t2 < 1) {
          if (tool === 'rock') {
            const u = hashInt(i + k * NX, this.tick) / 4294967296;
            v = (1 - smoothstep(0.35, 0.8, Math.sqrt(t2))) * (1 - ROCK_LUMP / 2 + ROCK_LUMP * u);
          } else {
            const u = 1 - t2;
            v = u * u;
          }
        }
        w[i - i0 + (k - k0) * bw] = v;
        total += v;
      }
    }
    return total;
  }

  /** How much of a tool's strength reaches column (i, k): fades near the zone's edge. */
  private edgeFade(i: number, k: number): number {
    const e = Math.min(i + 0.5, NX - 0.5 - i, k + 0.5, NZ - 0.5 - k) * CELL;
    return smoothstep(0, EDGE_FADE, e);
  }

  /** Adding tools fade out between BUILD_FADE and BUILD_MAX. */
  private static heightFade(h: number): number {
    return 1 - smoothstep(BUILD_FADE, BUILD_MAX, h);
  }

  private pourLava(depth: number, i0: number, k0: number, i1: number, k1: number): ToolResult {
    const { rock, sed, lava, temp } = this.cols;
    const w = this.weight;
    const bw = i1 - i0 + 1;
    const rect = this.rect;
    let volume = 0;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const wt = w[i - i0 + (k - k0) * bw];
        if (wt <= 0) continue;
        const c = i + k * NX;
        const top = rock[c] + sed[c];
        const L = lava[c];
        let add = depth * wt * this.edgeFade(i, k) * Tools.heightFade(top + L);
        add = Math.min(add, LAVA_HEAP - L, BUILD_MAX - top - L);
        if (add <= 1e-6) continue;
        this.cols.touch(c);
        if (L <= 0 && top > BURN_ABOVE) this.burns.mark(c, TOOL_BURN);
        temp[c] = L > 0 ? (L * temp[c] + add) / (L + add) : 1;
        lava[c] = L + add;
        this.lava.wake(c);
        rect.add(i, k);
        volume += add;
      }
    }
    return this.finish(volume * CELL * CELL, false);
  }

  private placeRock(depth: number, i0: number, k0: number, i1: number, k1: number): ToolResult {
    const { rock, sed, lava, rockKind } = this.cols;
    const w = this.weight;
    const bw = i1 - i0 + 1;
    const rect = this.rect;
    let volume = 0;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const wt = w[i - i0 + (k - k0) * bw];
        if (wt <= 0) continue;
        const c = i + k * NX;
        const s = rock[c] + sed[c] + lava[c];
        const add = Math.min(depth * wt * this.edgeFade(i, k) * Tools.heightFade(s), BUILD_MAX - s);
        if (add <= 1e-6) continue;
        this.cols.touch(c);
        // Sand under the new rock is buried into it.
        rock[c] += sed[c] + add;
        sed[c] = 0;
        rockKind[c] = RockKind.Stone;
        rect.add(i, k);
        volume += add;
      }
    }
    this.rockPlaced += volume * CELL * CELL;
    return this.finish(volume * CELL * CELL, false);
  }

  private pourSand(depth: number, i0: number, k0: number, i1: number, k1: number): ToolResult {
    const { rock, sed, lava, sandKind } = this.cols;
    const w = this.weight;
    const bw = i1 - i0 + 1;
    const rect = this.rect;
    let volume = 0;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const wt = w[i - i0 + (k - k0) * bw];
        if (wt <= 0) continue;
        const c = i + k * NX;
        const s = rock[c] + sed[c] + lava[c];
        const add = qSed(Math.min(depth * wt * this.edgeFade(i, k) * Tools.heightFade(s), BUILD_MAX - s));
        if (add <= 0) continue;
        this.cols.touch(c);
        const had = sed[c];
        // Poured sand is golden; it mixes with the top of the sand already there.
        sandKind[c] = mixKind(sandKind[c], had, add, POUR_KIND, c, this.tick);
        sed[c] = had + add;
        rect.add(i, k);
        volume += add;
      }
    }
    return this.finish(volume * CELL * CELL, true);
  }

  private scoop(depth: number, i0: number, k0: number, i1: number, k1: number): ToolResult {
    const { rock, sed, lava } = this.cols;
    const w = this.weight;
    const bw = i1 - i0 + 1;
    const rect = this.rect;
    let volume = 0;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const wt = w[i - i0 + (k - k0) * bw];
        if (wt <= 0) continue;
        const c = i + k * NX;
        let left = depth * wt * this.edgeFade(i, k);
        // Lava first, then sand, then rock at half speed; never below BUILD_MIN.
        const L = lava[c];
        const takeLava = Math.min(L, left);
        left -= takeLava;
        const S = sed[c];
        const takeSand = Math.min(S, qSed(Math.min(left, Math.max(0, rock[c] + S - BUILD_MIN))));
        left -= takeSand;
        const takeRock = takeSand >= S ? Math.min(left / 2, Math.max(0, rock[c] - BUILD_MIN)) : 0;
        if (takeLava + takeSand + takeRock <= 1e-6) continue;
        this.cols.touch(c);
        lava[c] = L - takeLava;
        if (lava[c] <= 0) {
          lava[c] = 0;
          this.cols.temp[c] = 0;
        }
        sed[c] = S - takeSand;
        rock[c] -= takeRock;
        rect.add(i, k);
        volume += takeLava + takeSand + takeRock;
      }
    }
    return this.finish(-volume * CELL * CELL, true);
  }

  /**
   * Hands: move the surface toward the average of the 5 x 5 columns around it. Material is
   * kept: what comes off the bumps (lava first, then sand, then a little rock) is laid into
   * the hollows, so smoothing never makes or destroys land.
   */
  private smooth(rate: number, maxStep: number, i0: number, k0: number, i1: number, k1: number): ToolResult {
    const cols = this.cols;
    const { rock, sed, lava, temp, sandKind } = cols;
    const w = this.weight;
    const bw = i1 - i0 + 1;
    // The surface over the brush plus a 2-column margin, and its 5 x 5 average.
    const m0 = Math.max(0, i0 - 2);
    const m1 = Math.min(NX - 1, i1 + 2);
    const n0 = Math.max(0, k0 - 2);
    const n1 = Math.min(NZ - 1, k1 + 2);
    const sw = m1 - m0 + 1;
    const surf = this.surf;
    const rows = this.rowSum;
    for (let k = n0; k <= n1; k++) {
      for (let i = m0; i <= m1; i++) surf[i - m0 + (k - n0) * sw] = cols.surf(i + k * NX);
      for (let i = m0; i <= m1; i++) {
        let sum = 0;
        for (let a = Math.max(m0, i - 2); a <= Math.min(m1, i + 2); a++) sum += surf[a - m0 + (k - n0) * sw];
        rows[i - m0 + (k - n0) * sw] = sum / (Math.min(m1, i + 2) - Math.max(m0, i - 2) + 1);
      }
    }
    // Plan each column's change; work out how much can actually come off the high ones.
    const want = this.want;
    let canGive = 0;
    let wanted = 0;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const o = i - i0 + (k - k0) * bw;
        const wt = w[o];
        want[o] = 0;
        if (wt <= 0) continue;
        let sum = 0;
        for (let b = Math.max(n0, k - 2); b <= Math.min(n1, k + 2); b++) sum += rows[i - m0 + (b - n0) * sw];
        const mean = sum / (Math.min(n1, k + 2) - Math.max(n0, k - 2) + 1);
        const c = i + k * NX;
        let d = rate * wt * this.edgeFade(i, k) * (mean - surf[i - m0 + (k - n0) * sw]);
        d = Math.max(-maxStep, Math.min(maxStep, d));
        if (d > 0) {
          want[o] = d;
          wanted += d;
        } else if (d < 0) {
          const loose = lava[c] + sed[c];
          const fromLoose = Math.min(-d, loose);
          const fromRock = Math.min((-d - fromLoose) * HANDS_ROCK, Math.max(0, rock[c] - BUILD_MIN));
          want[o] = -(fromLoose + fromRock);
          canGive += fromLoose + fromRock;
        }
      }
    }
    if (canGive <= 1e-6 || wanted <= 1e-6) return { volume: 0, rect: null };
    const giveShare = Math.min(1, wanted / canGive);
    const takeShare = Math.min(1, canGive / wanted);
    const rect = this.rect;
    // Take from the bumps (lava, then sand, then rock), keeping each material in its own pool.
    let poolLava = 0;
    let poolHeat = 0;
    let poolSand = 0;
    let poolKind = 0;
    let poolRock = 0;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const o = i - i0 + (k - k0) * bw;
        if (want[o] >= 0) continue;
        const c = i + k * NX;
        let left = -want[o] * giveShare;
        cols.touch(c);
        const L = lava[c];
        const tl = Math.min(L, left);
        left -= tl;
        const S = sed[c];
        const ts = Math.min(S, qSed(left));
        left -= ts;
        const tr = ts >= S ? Math.min(left, Math.max(0, rock[c] - BUILD_MIN)) : 0;
        poolLava += tl;
        poolHeat += tl * temp[c];
        poolSand += ts;
        poolKind += ts * sandKind[c];
        poolRock += tr;
        lava[c] = L - tl;
        if (lava[c] <= 0) {
          lava[c] = 0;
          temp[c] = 0;
        }
        sed[c] = S - ts;
        rock[c] -= tr;
        rect.add(i, k);
      }
    }
    const moved = poolLava + poolSand + poolRock;
    if (moved <= 0) return this.finish(0, true);
    // Lay exactly what came off into the hollows, in the same proportions of each material.
    const fill = moved / Math.min(canGive, wanted);
    const heat = poolLava > 0 ? poolHeat / poolLava : 0;
    const kind = poolSand > 0 ? poolKind / poolSand : POUR_KIND;
    let sandLeft = poolSand;
    let last = -1;
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const o = i - i0 + (k - k0) * bw;
        if (want[o] <= 0) continue;
        const c = i + k * NX;
        const a = want[o] * takeShare * fill;
        const al = (a * poolLava) / moved;
        const as = Math.min(sandLeft, qSed((a * poolSand) / moved));
        const ar = (a * poolRock) / moved;
        cols.touch(c);
        if (al > 0) {
          const L = lava[c];
          if (L <= 0 && rock[c] + sed[c] > BURN_ABOVE) this.burns.mark(c, TOOL_BURN);
          temp[c] = L > 0 ? (L * temp[c] + al * heat) / (L + al) : heat;
          lava[c] = L + al;
          this.lava.wake(c);
        }
        if (as > 0) {
          const S = sed[c];
          sandKind[c] = mixKind(sandKind[c], S, as, kind, c, this.tick);
          sed[c] = S + as;
          sandLeft -= as;
        }
        rock[c] += ar;
        rect.add(i, k);
        last = c;
      }
    }
    // Rounding leftovers of sand go to the last hollow, so no sand is lost.
    if (sandLeft > 0 && last >= 0) sed[last] += sandLeft;
    return this.finish(0, true);
  }

  /** Report the change (and any burning) and wake sand around it. */
  private finish(volume: number, wakeSand: boolean): ToolResult {
    const rect = this.rect;
    if (rect.empty) return { volume: 0, rect: null };
    this.report(rect.i0, rect.k0, rect.i1, rect.k1, TOOL_CHANGE);
    if (this.burns.pending) this.burns.flush(this.report);
    if (wakeSand) this.sand.wakeRect(rect.i0 - 1, rect.k0 - 1, rect.i1 + 1, rect.k1 + 1);
    return { volume, rect: [rect.i0, rect.k0, rect.i1, rect.k1] };
  }
}

/** A growing column rectangle (inclusive). */
class Rect {
  i0 = NX;
  k0 = NZ;
  i1 = -1;
  k1 = -1;
  get empty(): boolean {
    return this.i1 < this.i0;
  }
  reset(): void {
    this.i0 = NX;
    this.k0 = NZ;
    this.i1 = -1;
    this.k1 = -1;
  }
  add(i: number, k: number): void {
    if (i < this.i0) this.i0 = i;
    if (i > this.i1) this.i1 = i;
    if (k < this.k0) this.k0 = k;
    if (k > this.k1) this.k1 = k;
  }
}
