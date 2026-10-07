/**
 * Patch fields straight from the columns, recomputed only where the ground changed.
 *
 * This is also where shaping touches life (DECISIONS 8):
 * - Lava burns everything it covers. When it cools, the patch is fresh basalt, age 0.
 * - Burial: sand or rock piled on buries the low plants; shrubs survive up to about 1.2 m and
 *   trees up to about 3 m, counted over every pour (sand added a little at a time adds up),
 *   and a tree that survives keeps its soil.
 * - Digging more than 0.5 m away removes what grew there.
 * - A change of material (sand over rock, rock over sand) starts the surface afresh.
 * - Small smoothing never resets life: changes are measured against the height the surface
 *   had when it formed (refH), not against the last edit.
 * - Slow changes made by the sea itself ("drift": the years-time coast, reefs, storm surf and
 *   the sand slides they set off) never reset life unless they are large.
 * - When ground turns from land to sea or back (an undo, a scoop), plants that cannot live in
 *   the new place go at once rather than lingering as land plants under water.
 *
 * The work is sliced: apply() re-derives queued patches in arrival order until its deadline
 * and keeps the rest for the next call, so a big pour, an undo or a coast pass never blows a
 * tick's budget.
 */
import { NP, NX, PATCH } from '../config';
import { RockKind, type Columns } from '../engine/columns';
import { Substrate } from '../content/speciesTypes';
import { Flag, L_CANOPY, L_HERB, L_SHRUB, LAYERS, NPATCH, type EcoFields } from './fields';
import { clamp01 } from './maths';

/** Why a patch is waiting for a re-derive (bits). */
export const Dirty = { Geom: 1, Burn: 2, Tool: 4, Drift: 8 } as const;

/** Where a plant species can live: on land, in the sea, or both (mangroves at the waterline). */
export const Medium = { Land: 1, Sea: 2 } as const;

/** What the derive reports back when it resets life. */
export interface ResetSink {
  readonly year: number;
  /** Before changing persistent state because of the player's stroke (undo snapshot). */
  touch(p: number): void;
  /** Life is about to burn under lava at p (called before it is cleared, for the journal). */
  burned(p: number): void;
  /** Any reset of a patch's life (wakes it and its neighbours). `byPlayer`: a stroke or an undo did it. */
  reset(p: number, byPlayer: boolean): void;
}

const ROCK_SUB = [Substrate.Basalt, Substrate.Stone, Substrate.Limestone];
/** Patches per slice of apply() (each slice is a few tens of microseconds). */
const SLICE = 256;
/** A drift change smaller than this (m) only moves the reference height along. */
const DRIFT_EPS = 0.01;
/** Burial (m) that shrubs and trees survive. */
const SHRUB_BURY = 1.2;
const TREE_BURY = 3;

export class LocalDerive {
  readonly dirty = new Uint8Array(NPATCH);
  /** Queued patches, a ring in arrival order. */
  private queue = new Int32Array(NPATCH);
  private head = 0;
  private n = 0;
  /** The current slice (patches still to judge, -1 = skipped). */
  private slice = new Int32Array(SLICE);

  /** Per plant species: Medium bits (set by the ecology once the catalogue is compiled). */
  medium: Uint8Array = new Uint8Array(0);

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
        if (this.dirty[p] === 0) {
          this.queue[(this.head + this.n) % NPATCH] = p;
          this.n++;
        }
        this.dirty[p] |= why;
      }
    }
  }

  /**
   * Derive every patch from scratch (a fresh world or a loaded save): fields are recomputed but
   * no change is judged and no live state is touched.
   */
  all(cols: Columns, f: EcoFields): void {
    this.n = 0;
    this.head = 0;
    this.dirty.fill(0);
    for (let p = 0; p < NPATCH; p++) this.columnsToPatch(cols, f, p);
    for (let p = 0; p < NPATCH; p++) this.slopeAt(f, p);
  }

  /**
   * Re-derive queued patches, oldest first, and judge what each change did to its life, until
   * `deadline` (on the `now` clock). Returns the number of patches still waiting.
   *
   * Slices keep the result the same however they fall: a patch's slope is recomputed whenever a
   * neighbour is re-derived later, and the judgement of a change reads only the patch itself.
   */
  apply(cols: Columns, f: EcoFields, sink: ResetSink, deadline: number, now: () => number): number {
    const q = this.queue;
    const sl = this.slice;
    const dirty = this.dirty;
    while (this.n > 0) {
      // ---------- take a slice and bring its heights up to date ----------
      const m = Math.min(SLICE, this.n);
      for (let i = 0; i < m; i++) {
        const p = q[this.head];
        this.head = (this.head + 1) % NPATCH;
        const why = dirty[p];
        if (why & Dirty.Drift && !(why & (Dirty.Tool | Dirty.Burn))) {
          // The sea's own slow work: where the ground barely moved, only follow it.
          const h0 = f.h[p];
          const lo0 = f.hmin[p];
          const hi0 = f.hmax[p];
          const b0 = f.bot[p];
          this.columnsToPatch(cols, f, p);
          if (f.bot[p] === b0 && Math.abs(f.h[p] - h0) < DRIFT_EPS && Math.abs(f.hmin[p] - lo0) < DRIFT_EPS && Math.abs(f.hmax[p] - hi0) < DRIFT_EPS) {
            if (b0 !== Substrate.HotLava && f.refSub[p] !== Substrate.HotLava) f.refH[p] = f.h[p];
            dirty[p] = 0;
            sl[i] = -1;
            continue;
          }
        } else this.columnsToPatch(cols, f, p);
        sl[i] = p;
      }
      this.n -= m;
      // ---------- slopes: the slice, and settled neighbours whose view changed ----------
      for (let i = 0; i < m; i++) {
        const p = sl[i];
        if (p < 0) continue;
        this.slopeAt(f, p);
        const pi = p % NP;
        const pk = (p / NP) | 0;
        if (pi > 0 && dirty[p - 1] === 0) this.slopeAt(f, p - 1);
        if (pi < NP - 1 && dirty[p + 1] === 0) this.slopeAt(f, p + 1);
        if (pk > 0 && dirty[p - NP] === 0) this.slopeAt(f, p - NP);
        if (pk < NP - 1 && dirty[p + NP] === 0) this.slopeAt(f, p + NP);
      }
      // ---------- what the change did to life ----------
      for (let i = 0; i < m; i++) {
        const p = sl[i];
        if (p < 0) continue;
        this.judge(f, p, dirty[p], sink);
        dirty[p] = 0;
      }
      if (now() >= deadline) break;
    }
    return this.n;
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
    let molten = false;
    let basalt = 0;
    let stone = 0;
    let lime = 0;
    for (let dz = 0; dz < PATCH; dz++) {
      for (let dx = 0; dx < PATCH; dx++) {
        const c = c0 + dx + dz * NX;
        const s = cols.rock[c] + cols.sed[c] + cols.lava[c];
        sum += s;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
        sed += cols.sed[c];
        if (cols.lava[c] > 0.05) molten = true;
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
    const rock = ROCK_SUB[stone > basalt && stone >= lime ? 1 : lime > basalt ? 2 : 0];
    f.under[p] = rock;
    let bot: number;
    // A little hysteresis, so sand smoothed thin does not flip the ground back and forth.
    const sandLimit = f.refSub[p] === Substrate.Sand ? 0.15 : 0.3;
    if (molten) bot = Substrate.HotLava;
    else if (sed * k >= sandLimit) bot = Substrate.Sand;
    else bot = rock;
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
    // ---------- lava ----------
    if (bot === Substrate.HotLava) {
      if (ref !== Substrate.HotLava) {
        sink.touch(p);
        if (this.alive(f, p)) sink.burned(p);
        this.clear(f, p, 0, LAYERS - 1);
        f.soil[p] = 0;
        f.fert[p] = 0.1;
        f.guano[p] = 0;
        f.logs[p] = 0;
        f.char[p] = 1;
        f.wthr[p] = 0;
        f.buried[p] = 0;
        f.born[p] = year;
        f.refSub[p] = Substrate.HotLava;
        // refH stays at the pre-lava height until it cools (to measure how thick it is).
        sink.reset(p, true);
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
      f.buried[p] = 0;
      this.clear(f, p, 0, LAYERS - 1);
      sink.reset(p, true);
      return;
    }
    if (why & Dirty.Burn) {
      // Lava passed over (and maybe already set): burned ground.
      sink.touch(p);
      if (this.alive(f, p)) sink.burned(p);
      this.clear(f, p, 0, LAYERS - 1);
      f.soil[p] = 0;
      f.char[p] = 1;
      f.buried[p] = 0;
      f.born[p] = year;
      f.refH[p] = h;
      f.refSub[p] = bot;
      sink.reset(p, true);
      return;
    }
    const dh = h - f.refH[p];
    if (drift) {
      // The sea's own slow work: follow it, and only big changes disturb the low plants.
      if (dh > 0.8 || dh < -0.8) {
        this.clear(f, p, 0, L_HERB);
        sink.reset(p, false);
      }
      f.refH[p] = h;
      f.refSub[p] = bot;
      this.misplaced(f, p, sink, false);
      return;
    }
    if (bot !== ref) {
      // A new material on top (sand over rock, rock over sand) or the old one uncovered.
      sink.touch(p);
      if (dh >= 0) this.bury(f, p, dh);
      else this.scour(f, p, -dh);
      f.wthr[p] = 0;
      f.born[p] = year;
      f.refH[p] = h;
      f.refSub[p] = bot;
      sink.reset(p, true);
    } else if (dh > 0.5) {
      sink.touch(p);
      this.bury(f, p, dh);
      f.born[p] = year;
      f.refH[p] = h;
      sink.reset(p, true);
    } else if (dh < -0.5) {
      sink.touch(p);
      this.scour(f, p, -dh);
      f.wthr[p] = 0;
      f.born[p] = year;
      f.refH[p] = h;
      sink.reset(p, true);
    }
    this.misplaced(f, p, sink, true);
  }

  /**
   * Buried `d` metres deeper: low plants go; shrubs and trees survive shallow burial, counted
   * over every pour, and a surviving tree keeps the soil its roots hold.
   */
  private bury(f: EcoFields, p: number, d: number): void {
    const o = p * LAYERS;
    this.clear(f, p, 0, L_HERB);
    const depth = f.buried[p] + d;
    if (depth > SHRUB_BURY) this.clear(f, p, L_SHRUB, L_SHRUB);
    if (depth > TREE_BURY) this.clear(f, p, L_CANOPY, L_CANOPY);
    const woody = f.sp[o + L_SHRUB] !== 0 || f.sp[o + L_CANOPY] !== 0;
    f.buried[p] = woody ? depth : 0;
    if (f.sp[o + L_CANOPY] === 0) f.soil[p] = 0;
  }

  /** Dug `d` metres away: low plants go, then shrubs (over 1 m) and trees (over 2 m). */
  private scour(f: EcoFields, p: number, d: number): void {
    const o = p * LAYERS;
    this.clear(f, p, 0, L_HERB);
    if (d > 1) this.clear(f, p, L_SHRUB, L_SHRUB);
    if (d > 2) this.clear(f, p, L_CANOPY, L_CANOPY);
    // Digging out a buried tree uncovers it; its soil goes with anything deeper than a scrape.
    f.buried[p] = Math.max(0, f.buried[p] - d);
    if (f.sp[o + L_CANOPY] === 0 || d > 0.5) f.soil[p] = 0;
    if (f.sp[o + L_SHRUB] === 0 && f.sp[o + L_CANOPY] === 0) f.buried[p] = 0;
  }

  /** Plants that cannot live where this patch now is (land plants under the sea, sea plants on dry land) go at once. */
  private misplaced(f: EcoFields, p: number, sink: ResetSink, byPlayer: boolean): void {
    const need = f.h[p] > 0 ? Medium.Land : Medium.Sea;
    const o = p * LAYERS;
    let gone = false;
    for (let L = 0; L < LAYERS; L++) {
      const s1 = f.sp[o + L];
      if (s1 === 0 || this.medium[s1 - 1] & need) continue;
      if (!gone && byPlayer) sink.touch(p);
      f.sp[o + L] = 0;
      f.cov[o + L] = 0;
      gone = true;
    }
    if (gone) sink.reset(p, byPlayer);
  }

  private alive(f: EcoFields, p: number): boolean {
    const o = p * LAYERS;
    return (f.sp[o] | f.sp[o + 1] | f.sp[o + 2] | f.sp[o + 3]) !== 0;
  }

  private clear(f: EcoFields, p: number, from: number, to: number): void {
    for (let L = from; L <= to; L++) {
      f.sp[p * LAYERS + L] = 0;
      f.cov[p * LAYERS + L] = 0;
    }
  }
}
