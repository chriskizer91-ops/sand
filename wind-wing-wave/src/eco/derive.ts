/**
 * Patch fields straight from the columns, recomputed only where the ground changed.
 *
 * This is also where shaping touches life (DECISIONS 8):
 * - Lava burns everything it covers. When it cools, the patch is fresh basalt, age 0.
 * - Burial: sand or rock piled more than 0.5 m deep buries the low plants; shrubs survive up
 *   to about 1.2 m and trees up to about 3 m.
 * - Digging more than 0.5 m away removes what grew there.
 * - A change of material (sand over rock, rock over sand) starts the surface afresh.
 * - Small smoothing never resets life: changes are measured against the height the surface
 *   had when it formed (refH), not against the last edit.
 * - Slow changes made by the ecology's own coast and reef processes ("drift") never reset
 *   life unless they are large.
 */
import { NP, NX, PATCH } from '../config';
import { RockKind, type Columns } from '../engine/columns';
import { Substrate } from '../content/speciesTypes';
import { Flag, L_CANOPY, L_HERB, L_SHRUB, LAYERS, NPATCH, type EcoFields } from './fields';
import { clamp01 } from './maths';

/** Why a patch is waiting for a re-derive (bits). */
export const Dirty = { Geom: 1, Burn: 2, Tool: 4, Drift: 8 } as const;

/** What the derive reports back when it resets life. */
export interface ResetSink {
  readonly year: number;
  /** Before changing persistent state because of the player's stroke (undo snapshot). */
  touch(p: number): void;
  /** Life burned under lava (for the journal: forest share, cover). */
  burned(p: number, canopy: number, total: number): void;
  /** Any reset of a patch's life (wakes it and its neighbours). */
  reset(p: number): void;
}

const ROCK_SUB = [Substrate.Basalt, Substrate.Stone, Substrate.Limestone];

export class LocalDerive {
  readonly dirty = new Uint8Array(NPATCH);
  private queue = new Int32Array(NPATCH);
  private n = 0;

  get pending(): number {
    return this.n;
  }

  /** Queue a column rectangle (inclusive) for re-derive. */
  mark(i0: number, k0: number, i1: number, k1: number, why: number): void {
    const pi0 = Math.max(0, (i0 / PATCH) | 0);
    const pk0 = Math.max(0, (k0 / PATCH) | 0);
    const pi1 = Math.min(NP - 1, (i1 / PATCH) | 0);
    const pk1 = Math.min(NP - 1, (k1 / PATCH) | 0);
    for (let pk = pk0; pk <= pk1; pk++) {
      for (let pi = pi0; pi <= pi1; pi++) {
        const p = pi + pk * NP;
        if (this.dirty[p] === 0) this.queue[this.n++] = p;
        this.dirty[p] |= why;
      }
    }
  }

  markAll(): void {
    this.n = 0;
    for (let p = 0; p < NPATCH; p++) {
      this.dirty[p] = Dirty.Geom;
      this.queue[this.n++] = p;
    }
  }

  /**
   * Re-derive every queued patch. Without a sink, fields are recomputed but no change is
   * judged and no live state is touched (a fresh world or a loaded save).
   */
  apply(cols: Columns, f: EcoFields, sink: ResetSink | null): number {
    const n = this.n;
    if (n === 0) return 0;
    const q = this.queue;
    for (let i = 0; i < n; i++) this.columnsToPatch(cols, f, q[i]);
    for (let i = 0; i < n; i++) {
      const p = q[i];
      this.slopeAt(f, p);
      const pi = p % NP;
      const pk = (p / NP) | 0;
      if (pi > 0 && this.dirty[p - 1] === 0) this.slopeAt(f, p - 1);
      if (pi < NP - 1 && this.dirty[p + 1] === 0) this.slopeAt(f, p + 1);
      if (pk > 0 && this.dirty[p - NP] === 0) this.slopeAt(f, p - NP);
      if (pk < NP - 1 && this.dirty[p + NP] === 0) this.slopeAt(f, p + NP);
    }
    for (let i = 0; i < n; i++) {
      const p = q[i];
      if (sink) this.judge(f, p, this.dirty[p], sink);
      this.dirty[p] = 0;
    }
    this.n = 0;
    return n;
  }

  /** Heights and materials of one patch from its 2 x 2 columns. */
  private columnsToPatch(cols: Columns, f: EcoFields, p: number): void {
    const pi = p % NP;
    const pk = (p / NP) | 0;
    const c0 = pi * PATCH + pk * PATCH * NX;
    let sum = 0;
    let mn = 1e9;
    let mx = -1e9;
    let sed = 0;
    let lava = 0;
    let molten = false;
    let basalt = 0;
    let stone = 0;
    let lime = 0;
    for (let dz = 0; dz < PATCH; dz++) {
      for (let dx = 0; dx < PATCH; dx++) {
        const c = c0 + dx + dz * NX;
        const top = cols.rock[c] + cols.sed[c];
        const lv = cols.lava[c];
        const s = top + lv;
        sum += s;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
        sed += cols.sed[c];
        lava += lv;
        if (lv > 0.05) molten = true;
        const rk = cols.rockKind[c];
        if (rk === RockKind.Stone) stone++;
        else if (rk === RockKind.Limestone) lime++;
        else basalt++;
      }
    }
    const k = 1 / (PATCH * PATCH);
    const h = sum * k;
    f.h[p] = h;
    f.hmin[p] = mn;
    f.hmax[p] = mx;
    f.sand[p] = sed * k;
    f.lava[p] = lava * k;
    let bot: number;
    const sandLimit = f.refSub[p] === Substrate.Sand ? 0.15 : 0.3;
    if (molten) bot = Substrate.HotLava;
    else if (sed * k >= sandLimit) bot = Substrate.Sand;
    else bot = ROCK_SUB[stone > basalt && stone >= lime ? 1 : lime > basalt ? 2 : 0];
    f.bot[p] = bot;
    if (h <= 0) f.sub[p] = Substrate.Sea;
    else if (f.flags[p] & Flag.Pond && h < f.pondLvl[p]) f.sub[p] = Substrate.Pond;
    else f.sub[p] = bot;
  }

  /** Steepest slope (degrees) from neighbouring patches and the relief inside the patch. */
  private slopeAt(f: EcoFields, p: number): void {
    const pi = p % NP;
    const pk = (p / NP) | 0;
    const h = f.h;
    const w = h[pi > 0 ? p - 1 : p];
    const e = h[pi < NP - 1 ? p + 1 : p];
    const n = h[pk > 0 ? p - NP : p];
    const s = h[pk < NP - 1 ? p + NP : p];
    const span = PATCH * 2 * 2; // 8 m between the neighbours' centres
    const g = Math.hypot(e - w, s - n) / span;
    const inner = (f.hmax[p] - f.hmin[p]) / (PATCH * 2 * Math.SQRT2);
    f.slope[p] = (Math.atan(Math.max(g, inner)) * 180) / Math.PI;
  }

  /** Decide whether this change resets life, and how much. */
  private judge(f: EcoFields, p: number, why: number, sink: ResetSink): void {
    const h = f.h[p];
    const bot = f.bot[p];
    const ref = f.refSub[p];
    const year = sink.year;
    const drift = (why & Dirty.Drift) !== 0 && (why & (Dirty.Tool | Dirty.Burn)) === 0;
    const o = p * LAYERS;
    // ---------- lava ----------
    if (bot === Substrate.HotLava) {
      if (ref !== Substrate.HotLava) {
        sink.touch(p);
        let total = 0;
        for (let L = 0; L < LAYERS; L++) total += f.cov[o + L];
        if (total > 0) sink.burned(p, f.cov[o + L_CANOPY], total);
        this.clear(f, p, 0, LAYERS - 1);
        f.soil[p] = 0;
        f.fert[p] = 0.1;
        f.guano[p] = 0;
        f.logs[p] = 0;
        f.char[p] = 1;
        f.wthr[p] = 0;
        f.born[p] = year;
        f.refSub[p] = Substrate.HotLava;
        // refH stays at the pre-lava height until it cools (to measure how thick it is).
        sink.reset(p);
      }
      return;
    }
    if (ref === Substrate.HotLava) {
      // Cooled into fresh basalt (or limestone/stone if something else replaced it).
      sink.touch(p);
      const thick = h - f.refH[p];
      f.warm[p] = clamp01((thick - 1.5) / 6);
      f.born[p] = year;
      f.refH[p] = h;
      f.refSub[p] = bot;
      f.soil[p] = 0;
      f.wthr[p] = 0;
      f.fert[p] = 0.15;
      this.clear(f, p, 0, LAYERS - 1);
      sink.reset(p);
      return;
    }
    if (why & Dirty.Burn) {
      // Lava passed over (and maybe already set): burned ground.
      sink.touch(p);
      let total = 0;
      for (let L = 0; L < LAYERS; L++) total += f.cov[o + L];
      if (total > 0) sink.burned(p, f.cov[o + L_CANOPY], total);
      this.clear(f, p, 0, LAYERS - 1);
      f.soil[p] = 0;
      f.char[p] = 1;
      f.born[p] = year;
      f.refH[p] = h;
      f.refSub[p] = bot;
      sink.reset(p);
      return;
    }
    const dh = h - f.refH[p];
    if (drift) {
      // The sea's own slow work: follow it, and only big changes disturb the low plants.
      if (dh > 0.8 || dh < -0.8) {
        this.clear(f, p, 0, L_HERB);
        sink.reset(p);
      }
      f.refH[p] = h;
      f.refSub[p] = bot;
      return;
    }
    if (bot !== ref) {
      sink.touch(p);
      if (dh > 0.3) this.bury(f, p, dh);
      else this.scour(f, p, -dh);
      if (dh <= 0.3) this.clear(f, p, 0, L_SHRUB);
      f.wthr[p] = 0;
      f.born[p] = year;
      f.refH[p] = h;
      f.refSub[p] = bot;
      sink.reset(p);
      return;
    }
    if (dh > 0.5) {
      sink.touch(p);
      this.bury(f, p, dh);
      f.born[p] = year;
      f.refH[p] = h;
      sink.reset(p);
    } else if (dh < -0.5) {
      sink.touch(p);
      this.scour(f, p, -dh);
      f.wthr[p] = 0;
      f.born[p] = year;
      f.refH[p] = h;
      sink.reset(p);
    }
  }

  /** Buried `d` metres deep: low plants go; trees survive shallow burial (and keep their soil). */
  private bury(f: EcoFields, p: number, d: number): void {
    this.clear(f, p, 0, L_HERB);
    if (d > 1.2) this.clear(f, p, L_SHRUB, L_SHRUB);
    if (d > 3) this.clear(f, p, L_CANOPY, L_CANOPY);
    if (f.sp[p * LAYERS + L_CANOPY] === 0) f.soil[p] = 0;
  }

  /** Dug `d` metres away. */
  private scour(f: EcoFields, p: number, d: number): void {
    this.clear(f, p, 0, L_HERB);
    if (d > 1) this.clear(f, p, L_SHRUB, L_SHRUB);
    if (d > 2) this.clear(f, p, L_CANOPY, L_CANOPY);
    f.soil[p] = 0;
  }

  private clear(f: EcoFields, p: number, from: number, to: number): void {
    for (let L = from; L <= to; L++) {
      f.sp[p * LAYERS + L] = 0;
      f.cov[p * LAYERS + L] = 0;
    }
  }
}
