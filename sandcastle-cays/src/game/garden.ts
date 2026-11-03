/**
 * The garden: pots on the boat's cabin top and raised beds on Home Cay.
 *
 * Plant from the seed tin, water every day (pots from the boat's tank, beds
 * from the rain barrel by the garden), and the plants grow; rain waters them
 * for you. A plant only grows on days it has water, starts to droop after
 * most of a day without, and withers after three dry days. Harvest when
 * ripe: food for the larder, and seeds for next time. Callaloo grows back
 * after you cut it.
 *
 * Every crop is a real Caribbean garden plant; the facts are true. No
 * drawing in here.
 */

export type CropKind = 'callaloo' | 'tomato' | 'sweetpotato';

export interface CropInfo {
  name: string;
  /** "Harvest the …" */
  plural: string;
  /** Watered days from planting to ripe. */
  days: number;
  /** Days of food a harvest gives. */
  food: number;
  /** Seeds (or slips) you get back: at least, at most. */
  seeds: [number, number];
  /** Cut and come again: growth left after harvesting (0 = the plant is used up). */
  regrow: number;
  seedName: string;
  fact: string;
}

export const CROPS: Record<CropKind, CropInfo> = {
  callaloo: {
    name: 'callaloo',
    plural: 'callaloo',
    days: 2,
    food: 0.5,
    seeds: [0, 1],
    regrow: 0.5,
    seedName: 'callaloo seeds',
    fact: 'In Jamaica callaloo means leafy amaranth, steamed like spinach. Elsewhere in the Caribbean the same name is used for dasheen leaves, or for a soup made with them. Cut it and it grows back.',
  },
  tomato: {
    name: 'cherry tomato',
    plural: 'cherry tomatoes',
    days: 3,
    food: 1,
    seeds: [1, 2],
    regrow: 0,
    seedName: 'tomato seeds',
    fact: 'Tomatoes first came from western South America, where wild ones still grow with fruit no bigger than a pea.',
  },
  sweetpotato: {
    name: 'sweet potato',
    plural: 'sweet potatoes',
    days: 4,
    food: 2,
    seeds: [1, 1],
    regrow: 0,
    seedName: 'sweet potato slips',
    fact: 'Sweet potatoes aren’t potatoes at all: they are the roots of a vine in the morning-glory family, and they grow well in poor, sandy soil.',
  },
};

export const CROP_KINDS = Object.keys(CROPS) as CropKind[];

export const GARDEN = {
  /** Watering lasts this long (game days) before the plant wants more. */
  waterLasts: 1,
  /** You can water again once it's been this long. */
  rewater: 0.3,
  /** It starts to droop after this long dry, and withers after `wither` days. */
  droopAfter: 0.75,
  wither: 3,
  /** The rain barrel: waterings it holds, and seconds of heavy rain to add one. */
  barrelMax: 12,
  barrelPerRain: 15,
  /** Watering a pot aboard takes this much from the tank (days of water). */
  potWater: 0.05,
  /** Pots you start with, and the most the cabin-top trays hold. */
  potsStart: 2,
  potsMax: 4,
  beds: 4,
};

export interface Plot {
  crop: CropKind | null;
  /** 0 just planted .. 1 ripe. */
  growth: number;
  /** Game day it was planted, and last watered (by you or the rain). */
  planted: number;
  watered: number;
}

export interface GardenState {
  plots: Record<string, Plot>;
  seeds: Record<CropKind, number>;
  /** Waterings in the rain barrel. */
  barrel: number;
  /** Harvests of each crop (for the logbook). */
  grown: Partial<Record<CropKind, number>>;
}

export const POT_IDS = ['pot0', 'pot1', 'pot2', 'pot3'];
export const BED_IDS = ['bed0', 'bed1', 'bed2', 'bed3'];

export function isPot(id: string): boolean {
  return id.startsWith('pot');
}

export function newGarden(): GardenState {
  return { plots: {}, seeds: { callaloo: 3, tomato: 3, sweetpotato: 2 }, barrel: 4, grown: {} };
}

export function restoreGarden(raw: unknown): GardenState {
  const g = newGarden();
  if (!raw || typeof raw !== 'object') return g;
  const r = raw as Partial<GardenState>;
  const fin = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  if (r.seeds && typeof r.seeds === 'object') for (const k of CROP_KINDS) g.seeds[k] = Math.max(0, Math.floor(fin((r.seeds as Record<string, unknown>)[k], g.seeds[k])));
  g.barrel = Math.max(0, Math.min(GARDEN.barrelMax, fin(r.barrel, g.barrel)));
  if (r.grown && typeof r.grown === 'object') for (const k of CROP_KINDS) {
    const n = (r.grown as Record<string, unknown>)[k];
    if (typeof n === 'number' && n > 0) g.grown[k] = Math.floor(n);
  }
  if (r.plots && typeof r.plots === 'object') {
    for (const id of [...POT_IDS, ...BED_IDS]) {
      const p = (r.plots as Record<string, Partial<Plot>>)[id];
      if (!p || !p.crop || !(p.crop in CROPS)) continue;
      g.plots[id] = { crop: p.crop, growth: Math.max(0, Math.min(1, fin(p.growth, 0))), planted: fin(p.planted, 0), watered: fin(p.watered, -99) };
    }
  }
  return g;
}

/** How many pots are on the trays (more are made at the workbench). */
export function potCount(planters: number): number {
  return Math.min(GARDEN.potsMax, GARDEN.potsStart + planters);
}

export function plot(g: GardenState, id: string): Plot | null {
  const p = g.plots[id];
  return p && p.crop ? p : null;
}

/** 0 = fine; rising to 1 the longer it's been dry. */
export function thirst(p: Plot, now: number): number {
  const dry = now - Math.max(p.watered, p.planted);
  return Math.max(0, Math.min(1, (dry - GARDEN.droopAfter) / (GARDEN.wither - GARDEN.droopAfter)));
}

export function ripe(p: Plot): boolean {
  return p.growth >= 1;
}

/** Could you water it now? (Not if you did a few hours ago.) */
export function wantsWater(p: Plot, now: number): boolean {
  return now - p.watered >= GARDEN.rewater;
}

/** Plant a seed from the tin. Returns why not, or null. */
export function plant(g: GardenState, id: string, crop: CropKind, now: number): string | null {
  if (plot(g, id)) return 'Something is already growing here';
  if ((g.seeds[crop] ?? 0) <= 0) return `No ${CROPS[crop].seedName} left`;
  g.seeds[crop]--;
  g.plots[id] = { crop, growth: 0, planted: now, watered: -99 };
  return null;
}

export function water(g: GardenState, id: string, now: number): void {
  const p = plot(g, id);
  if (p) p.watered = now;
}

/**
 * Time passes: plants with water grow; ones left dry too long wither.
 * `rained(id)` says whether rain is falling on that plot now (it waters it).
 * Returns the ids that withered.
 */
export function growGarden(g: GardenState, dtDays: number, now: number, rained: (id: string) => boolean): string[] {
  const gone: string[] = [];
  for (const [id, p] of Object.entries(g.plots)) {
    if (!p.crop) continue;
    if (rained(id)) p.watered = now;
    if (now - p.watered < GARDEN.waterLasts) p.growth = Math.min(1, p.growth + dtDays / CROPS[p.crop].days);
    else if (now - Math.max(p.watered, p.planted) > GARDEN.wither) {
      gone.push(id);
      delete g.plots[id];
    }
  }
  return gone;
}

/** Pick it: food (days) and seeds back. Returns null if it isn't ripe. */
export function harvest(g: GardenState, id: string, rand: () => number): { crop: CropKind; food: number; seeds: number } | null {
  const p = plot(g, id);
  if (!p || !ripe(p)) return null;
  const c = CROPS[p.crop!];
  const seeds = c.seeds[0] + Math.floor(rand() * (c.seeds[1] - c.seeds[0] + 1));
  const crop = p.crop!;
  g.seeds[crop] += seeds;
  g.grown[crop] = (g.grown[crop] ?? 0) + 1;
  if (c.regrow > 0) p.growth = c.regrow;
  else delete g.plots[id];
  return { crop, food: c.food, seeds };
}

/** Rain falling on the barrel for dt seconds (0..1 heavy). */
export function fillBarrel(g: GardenState, rain: number, dt: number): void {
  if (rain <= 0.05) return;
  g.barrel = Math.min(GARDEN.barrelMax, g.barrel + (rain * dt) / GARDEN.barrelPerRain);
}

/** What the prompt says, and what pressing does, at a plot. */
export function plotLabel(g: GardenState, id: string, now: number): { label: string; does: 'plant' | 'water' | 'harvest' | 'none' } {
  const p = plot(g, id);
  const where = isPot(id) ? 'the pot' : 'the bed';
  if (!p) return { label: `Plant something in ${where}`, does: 'plant' };
  const c = CROPS[p.crop!];
  if (ripe(p)) return { label: `Harvest the ${c.plural}`, does: 'harvest' };
  if (wantsWater(p, now)) return { label: `Water the ${c.name}${thirst(p, now) > 0 ? ' (it’s thirsty)' : ''}`, does: 'water' };
  const left = Math.max(0.1, (1 - p.growth) * c.days);
  return { label: `${cap(c.name)}: watered, about ${left < 1 ? `${Math.round(left * 24)} hours` : `${left.toFixed(1)} days`} to go`, does: 'none' };
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
