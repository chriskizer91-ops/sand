/**
 * Living aboard: your food and water stores, the boat's upkeep (hull, sails,
 * the bilge) and what you can make at the workbench from what the sea washes
 * up.
 *
 * Stores are counted in days. You eat a day's food and drink a day's water
 * each game day (about 24 real minutes), a little at a time. Full stores last
 * about a month. Running out is the worst that can happen: you're hungry or
 * thirsty, and slow, until you top up. Fish (cooked in the galley), coconuts
 * and rain caught in the awning top them up.
 *
 * No drawing in here, so the checks can run it directly.
 */
import type { FindKind } from '../content/finds';

export const STORES = {
  /** Most the larder holds (days of food). */
  foodMax: 30,
  /** The water tank (days of water); jugs made at the workbench add to it. */
  waterMax: 20,
  jugDays: 5,
  /** A new game starts with this much. */
  startFood: 10,
  startWater: 8,
  /** Below this many days, you're told it's getting low. */
  low: 3,
  /** Opening a coconut: food and water (days). */
  coconut: { food: 0.2, water: 0.3 },
  /** Fresh fish keeps this long (game days) in the cool box before it spoils. */
  fishKeeps: 1.5,
  /** Days of water caught per second of heavy rain: in the awning at anchor (×2 with the bigger catcher), off the mainsail under sail, or just the deck. */
  rainAtAnchor: 1 / 55,
  rainUnderSail: 0.5 / 55,
  rainDeck: 0.15 / 55,
};

export const UPKEEP = {
  /** Below this hull condition (%) she starts to leak. */
  leakFrom: 60,
  /** Seconds to fill the bilge with the hull at 0% (slower the better the hull). */
  leakFill: 300,
  /** A bilge fuller than this makes her sluggish. */
  sluggishFrom: 0.4,
  /** One stroke of the pump. */
  pumpStroke: 0.05,
  /** Sail wear (% per second) when badly overpowered, and when flogging in a strong wind. */
  wearOver: 0.6,
  wearFlog: 0.12,
  /** Below this the sails are torn (and the logbook says so). */
  torn: 40,
};

/** Made at the workbench, or (the last two) given by the notebook's old owner. */
export type Upgrade = 'catcher' | 'jugs' | 'lure' | 'trap' | 'planter' | 'goodSails' | 'strongReel';
const UPGRADES: Upgrade[] = ['catcher', 'jugs', 'lure', 'trap', 'planter', 'goodSails', 'strongReel'];

export const DINGHY_UPKEEP = {
  /** A shark's bump dents the dinghy this much (%). */
  bump: 25,
  /** Mending it at the workbench puts this much back (%). */
  mend: 50,
};

/** Pieces of bait cut from one fish, and the most you can carry. */
export const BAIT = { perFish: 3, max: 12 };

export interface AboardState {
  /** Days of food in the larder and of water in the tank. */
  food: number;
  water: number;
  /** Fresh fish waiting to be cooked: kind, the game day it was caught, and how big (1 = typical). */
  coolBox: { kind: string; caught: number; size?: number }[];
  /** Sail condition, 0..100. */
  sails: number;
  /** Water in the bilge, 0 (dry) .. 1 (full). */
  bilge: number;
  /** Things made at the workbench that stay made (how many of each). */
  made: Partial<Record<Upgrade, number>>;
  /** Fish you've caught, by kind (for the logbook). */
  fishLog: Record<string, number>;
  /** The last morning the fish trap was checked (game day). */
  trapDay: number;
  /** The dinghy's condition, 0..100 (sharks' bumps dent it). */
  dinghy: number;
  /** Pieces of bait in the bait box. */
  bait: number;
  /** The heaviest of each kind of fish you've caught (kg). */
  biggest: Record<string, number>;
}

export function newAboard(): AboardState {
  return { food: STORES.startFood, water: STORES.startWater, coolBox: [], sails: 100, bilge: 0, made: {}, fishLog: {}, trapDay: 0, dinghy: 100, bait: 0, biggest: {} };
}

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** Load from a save (anything missing or odd falls back to a sensible value). */
export function restoreAboard(raw: unknown): AboardState {
  const a = newAboard();
  if (!raw || typeof raw !== 'object') return a;
  const r = raw as Partial<AboardState>;
  a.made = {};
  for (const k of UPGRADES) {
    const n = (r.made as Record<string, unknown> | undefined)?.[k];
    if (typeof n === 'number' && n > 0) a.made[k] = Math.min(k === 'jugs' || k === 'planter' ? 2 : 1, Math.floor(n));
  }
  a.food = num(r.food, a.food, 0, STORES.foodMax);
  a.water = num(r.water, a.water, 0, waterMax(a));
  a.sails = num(r.sails, 100, 0, 100);
  a.bilge = num(r.bilge, 0, 0, 1);
  a.trapDay = num(r.trapDay, 0, 0, 1e6);
  a.dinghy = num(r.dinghy, 100, 0, 100);
  a.bait = Math.floor(num(r.bait, 0, 0, BAIT.max));
  if (Array.isArray(r.coolBox))
    a.coolBox = r.coolBox
      .filter((f) => f && typeof f.kind === 'string' && Number.isFinite(f.caught))
      .slice(0, 30)
      .map((f) => ({ kind: f.kind, caught: f.caught, ...(typeof f.size === 'number' && Number.isFinite(f.size) ? { size: Math.max(0.5, Math.min(3, f.size)) } : {}) }));
  if (r.biggest && typeof r.biggest === 'object') for (const [k, v] of Object.entries(r.biggest)) if (typeof v === 'number' && v > 0 && Number.isFinite(v)) a.biggest[k] = v;
  if (r.fishLog && typeof r.fishLog === 'object') for (const [k, v] of Object.entries(r.fishLog)) if (typeof v === 'number' && v > 0) a.fishLog[k] = Math.floor(v);
  return a;
}

export function waterMax(a: AboardState): number {
  return STORES.waterMax + STORES.jugDays * (a.made.jugs ?? 0);
}

export interface StoreNews {
  /** Just dropped below the "low" line, or just ran out. */
  lowFood: boolean;
  lowWater: boolean;
  outFood: boolean;
  outWater: boolean;
}

/** Eat and drink for `days` of game time. */
export function useStores(a: AboardState, days: number): StoreNews {
  const f0 = a.food;
  const w0 = a.water;
  a.food = Math.max(0, a.food - days);
  a.water = Math.max(0, a.water - days);
  return {
    lowFood: f0 >= STORES.low && a.food < STORES.low,
    lowWater: w0 >= STORES.low && a.water < STORES.low,
    outFood: f0 > 0 && a.food === 0,
    outWater: w0 > 0 && a.water === 0,
  };
}

/** How fast you can move (1 = normally): hungry or thirsty slows you; both slows you more. */
export function vigour(a: AboardState): number {
  const out = (a.food <= 0 ? 1 : 0) + (a.water <= 0 ? 1 : 0);
  return out === 0 ? 1 : out === 1 ? 0.8 : 0.65;
}

export type RainCatch = 'anchored' | 'sailing' | 'deck';

/** Rain falling (0..1) for dt seconds: how much water the tank catches (days). */
export function catchRain(a: AboardState, rain: number, dt: number, how: RainCatch): number {
  if (rain <= 0.05) return 0;
  let rate = how === 'anchored' ? STORES.rainAtAnchor * ((a.made.catcher ?? 0) > 0 ? 2 : 1) : how === 'sailing' ? STORES.rainUnderSail : STORES.rainDeck;
  rate *= rain;
  const before = a.water;
  a.water = Math.min(waterMax(a), a.water + rate * dt);
  return a.water - before;
}

/** Open a coconut from the locker. Returns false if there are none. */
export function openCoconut(a: AboardState, locker: Partial<Record<FindKind, number>>): boolean {
  const n = locker.coconut ?? 0;
  if (n <= 0) return false;
  locker.coconut = n - 1;
  a.food = Math.min(STORES.foodMax, a.food + STORES.coconut.food);
  a.water = Math.min(waterMax(a), a.water + STORES.coconut.water);
  return true;
}

/** Throw out fish that has gone off (older than STORES.fishKeeps days). Returns how many. */
export function spoilFish(a: AboardState, today: number): number {
  const n = a.coolBox.length;
  a.coolBox = a.coolBox.filter((f) => today - f.caught <= STORES.fishKeeps);
  return n - a.coolBox.length;
}

/** Cook everything in the cool box: food (days) for each fish (a bigger fish gives more). Returns the days added. */
export function cookFish(a: AboardState, foodOf: (kind: string, size: number) => number): number {
  let add = 0;
  for (const f of a.coolBox) add += foodOf(f.kind, f.size ?? 1);
  a.coolBox = [];
  const before = a.food;
  a.food = Math.min(STORES.foodMax, a.food + add);
  return a.food - before;
}

/** Cut the smallest fish in the cool box into bait. Returns the pieces cut (0 if no fish, or the bait box is full). */
export function cutBait(a: AboardState): number {
  if (!a.coolBox.length || a.bait >= BAIT.max) return 0;
  let i = 0;
  for (let j = 1; j < a.coolBox.length; j++) if ((a.coolBox[j].size ?? 1) < (a.coolBox[i].size ?? 1)) i = j;
  a.coolBox.splice(i, 1);
  const n = Math.min(BAIT.perFish, BAIT.max - a.bait);
  a.bait += n;
  return n;
}

/** A shark bumped the dinghy. */
export function dentDinghy(a: AboardState): void {
  a.dinghy = Math.max(0, a.dinghy - DINGHY_UPKEEP.bump);
}

// ---------- the boat's upkeep ----------

/** The hull lets in water when it's worn (below UPKEEP.leakFrom %). */
export function leak(a: AboardState, hull: number, dt: number): void {
  if (hull >= UPKEEP.leakFrom) return;
  const k = (UPKEEP.leakFrom - hull) / UPKEEP.leakFrom;
  a.bilge = Math.min(1, a.bilge + (k * dt) / UPKEEP.leakFill);
}

/** One stroke of the bilge pump. */
export function pumpStroke(a: AboardState): void {
  a.bilge = Math.max(0, a.bilge - UPKEEP.pumpStroke);
}

/** A full bilge makes her slow: a factor on her speed (1 = no effect). */
export function bilgeDrag(a: AboardState): number {
  return 1 - 0.5 * Math.max(0, a.bilge - UPKEEP.sluggishFrom);
}

/** Sails wear when she's badly overpowered, or when they flog in a strong wind. */
export function wearSails(a: AboardState, over: number, flogging: boolean, dt: number): void {
  let w = 0;
  if (over > 0.08) w += UPKEEP.wearOver * Math.min(1.5, over / 0.2);
  if (flogging) w += UPKEEP.wearFlog;
  // The old owner's spare sails are heavier cloth, and wear half as fast.
  if ((a.made.goodSails ?? 0) > 0) w *= 0.5;
  a.sails = Math.max(0, a.sails - w * dt);
}

/** Worn sails don't drive her as well: a factor on the sails' push (1 = as new). */
export function sailCondition(a: AboardState): number {
  return 0.55 + 0.45 * (a.sails / 100);
}

// ---------- the workbench ----------

export interface Recipe {
  id: string;
  name: string;
  /** What it does, in a few plain words. */
  text: string;
  /** Finds it uses up (from the locker aboard). */
  needs: Record<string, number>;
  /** An upgrade that stays made (and how many you can make). */
  upgrade?: Upgrade;
  max?: number;
}

export const RECIPES: Recipe[] = [
  { id: 'caulk', name: 'Caulk the seams', text: 'Hull +15%. Driftwood splinters and a rub of pumice stop the small leaks.', needs: { driftwood: 2, pumice: 1 } },
  { id: 'patch', name: 'Patch the hull', text: 'Hull +35%. A plank, shaped and lashed over the worst scrape.', needs: { plank: 1, rope: 1 } },
  { id: 'sails', name: 'Patch the sails', text: 'Sails +40%. A sailcloth patch, stitched with twine from old rope.', needs: { sailcloth: 1, rope: 1 } },
  { id: 'catcher', name: 'Bigger rain catcher', text: 'The awning catches twice as much rain at anchor.', needs: { sailcloth: 2, rope: 1 }, upgrade: 'catcher', max: 1 },
  { id: 'jugs', name: 'Water jugs', text: `Carry ${STORES.jugDays} more days of water (you can make two sets).`, needs: { bottle: 3, rope: 1 }, upgrade: 'jugs', max: 2 },
  { id: 'lure', name: 'Feather lure', text: 'Fish bite sooner.', needs: { feather: 1, float: 1 }, upgrade: 'lure', max: 1 },
  { id: 'trap', name: 'Fish trap', text: 'At anchor overnight it catches a fish or two by morning.', needs: { net: 1, driftwood: 3 }, upgrade: 'trap', max: 1 },
  { id: 'planter', name: 'Another deck pot', text: 'A pot for the cabin-top trays, to grow more (up to four pots).', needs: { plank: 1, driftwood: 2 }, upgrade: 'planter', max: 2 },
  { id: 'dinghy', name: 'Mend the dinghy', text: `Dinghy +${DINGHY_UPKEEP.mend}%. Beat the dents out and seal the seams with driftwood and twine.`, needs: { driftwood: 1, rope: 1 } },
];

/** A recipe shows once you've found every kind of thing it needs at least once. */
export function recipeKnown(r: Recipe, found: Partial<Record<string, number>>): boolean {
  return Object.keys(r.needs).every((k) => (found[k] ?? 0) > 0);
}

/** Why you can't make it now (null if you can). */
export function whyNot(r: Recipe, a: AboardState, hull: number, locker: Partial<Record<string, number>>): string | null {
  if (r.upgrade && (a.made[r.upgrade] ?? 0) >= (r.max ?? 1)) return 'Already made';
  if (r.id === 'caulk' || r.id === 'patch') if (hull >= 99.5) return 'The hull is sound';
  if (r.id === 'sails' && a.sails >= 99.5) return 'The sails are fine';
  if (r.id === 'dinghy' && a.dinghy >= 99.5) return 'The dinghy is sound';
  for (const [k, n] of Object.entries(r.needs)) if ((locker[k] ?? 0) < n) return 'Not enough in the locker';
  return null;
}

/** Make it: uses the finds from the locker. Returns the new hull condition (or the same). */
export function make(r: Recipe, a: AboardState, hull: number, locker: Partial<Record<string, number>>): number {
  if (whyNot(r, a, hull, locker)) return hull;
  for (const [k, n] of Object.entries(r.needs)) locker[k] = (locker[k] ?? 0) - n;
  if (r.upgrade) a.made[r.upgrade] = (a.made[r.upgrade] ?? 0) + 1;
  if (r.id === 'caulk') return Math.min(100, hull + 15);
  if (r.id === 'patch') return Math.min(100, hull + 35);
  if (r.id === 'sails') a.sails = Math.min(100, a.sails + 40);
  if (r.id === 'dinghy') a.dinghy = Math.min(100, a.dinghy + DINGHY_UPKEEP.mend);
  return hull;
}
