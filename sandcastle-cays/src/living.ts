/**
 * Living aboard, in the game: the stores going down day by day, rain filling
 * the tank, the hull leaking and the bilge pump, sails wearing, fishing with
 * the rod, the galley and the workbench, and shaking coconuts from the palms.
 * The rules themselves are in game/aboard.ts and game/fishing.ts; this file
 * connects them to the world, the screen and the sounds.
 */
import * as THREE from 'three';
import {
  BAIT,
  RECIPES,
  STORES,
  UPKEEP,
  bilgeDrag,
  catchRain,
  cookFish,
  cutBait,
  leak,
  make,
  newAboard,
  openCoconut,
  pumpStroke,
  recipeKnown,
  restoreAboard,
  sailCondition,
  spoilFish,
  useStores,
  vigour,
  waterMax,
  wearSails,
  whyNot,
  type AboardState,
} from './game/aboard';
import { FISH, FISHING, FISH_KINDS, cast, fishFood, fishHere, fishKg, fishSize, newFishing, reelIn, stepFishing, type FishKind, type FishingEvent } from './game/fishing';
import { FINDS, FIND_KINDS, type FindKind } from './content/finds';
import type { BoatState } from './game/sailing';
import type { Beach, BeachView } from './game/beach';
import type { Player } from './player/player';
import type { Hud } from './ui/hud';
import { Galley } from './ui/galley';
import { Workbench } from './ui/workbench';
import type { SandAudio } from './audio/audio';
import type { FpInput } from './input/fpInput';

/** What the held-item view can do with a rod (the fish-model agent's HeldView). */
export interface RodView {
  setHolding?(what: 'basket' | 'rod' | 'fish', kind?: string): void;
  cast?(): void;
  bend?(amount: number): void;
  reelTurn?(speed: number): void;
  showCatch?(kind: string): void;
}

/** The fishing line and float in the world. */
export interface LineView {
  setOut(on: boolean): void;
  update(tipWorld: THREE.Vector3, floatWorld: THREE.Vector3, time: number, tension: number): void;
  bite(strength: number): void;
  landed(): void;
  fighting?(amount: number): void;
}

/** The parts of the boat model this needs (all optional, so an older model still works). */
export interface LivingRig {
  setAwning?(shown: number, big: boolean): void;
  setPump?(stroke: number): void;
  setBilge?(level: number, time?: number): void;
  setHatch?(open: number): void;
  setTrap?(set: boolean): void;
  setRodStowed?(shown: boolean): void;
  setGalleyLight?(on: boolean): void;
}

export interface LivingCtx {
  boat(): BoatState;
  player: Player;
  beach: Beach;
  beachView: BeachView;
  hud: Hud;
  toast(msg: string, ms?: number): void;
  audio: SandAudio;
  input: FpInput;
  isTouch: boolean;
  /** Spots on the boat (boat-local), where you stand. */
  points: { galley?: THREE.Vector3; workbench?: THREE.Vector3; pump?: THREE.Vector3; locker: THREE.Vector3 };
  rig(): LivingRig | null;
  /** The sea floor (or land) height, and the water surface now. */
  floorAt(x: number, z: number): number;
  seaHeight(x: number, z: number): number;
  openness(x: number, z: number): number;
  camera: THREE.PerspectiveCamera;
  held: RodView;
  line: LineView | null;
  /** Where the rod's tip is in the world. */
  tipWorld(out: THREE.Vector3): THREE.Vector3;
  /** Get the fish models ready (so the first catch doesn't stutter). */
  prepare?(): void;
  /** Is this world spot clear of the boat (open water to cast into)? */
  clearOfBoat?(x: number, z: number): boolean;
  palms: { x: number; z: number }[];
  /** The game day now, with the hour as a fraction (day 3, noon = 3.5). */
  dayNow(): number;
  atHelm(): boolean;
  changed(): void;
  closeOtherPanels(): void;
  unlockPointer(): void;
  /** How risky the shark waters are here (0 = none): bigger fish where it's riskier. */
  riskAt?(x: number, z: number): number;
  /** Seated in the dinghy: how fast it's going (null when you're not in it). */
  seatedSpeed?(): number | null;
  /** Have you learned to cut bait (from the notebook)? */
  baitKnown?(): boolean;
  /** You landed a fish (kind, weight, how risky the water was), or cooked. */
  onCatch?(kind: FishKind, kg: number, risk: number): void;
  onCook?(): void;
  /** You made or mended something at the workbench; you opened the galley. */
  onMake?(): void;
  onGalley?(): void;
}

export type LivingAction =
  | { kind: 'fish'; label: string }
  | { kind: 'galley'; label: string }
  | { kind: 'workbench'; label: string }
  | { kind: 'pump'; label: string }
  | { kind: 'palm'; index: number; label: string };

/** A repeatable random number source (so a save brings back the same thing). */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fishName = (k: string) => FISH[k as FishKind]?.name ?? k;
const foodOf = (k: string, size = 1) => fishFood(k, size);

export class Living {
  aboard: AboardState = newAboard();
  readonly fishing = newFishing();
  rodHeld = false;
  /** Coconut palms you've shaken: palm number → the day. */
  palms: Record<number, number> = {};
  readonly galley: Galley;
  readonly bench: Workbench;
  private rand = mulberry32(Date.now() & 0xffff);
  private lastDay = -1;
  private castAt = new THREE.Vector3();
  private castFrom = new THREE.Vector3();
  private float = new THREE.Vector3();
  private tip = new THREE.Vector3();
  private spoilTimer = 0;
  private pumpAnim = 0;
  private pumpHoldT = 0;
  private notes = { leak: -999, rain: -999, full: -999, torn: false, worn: false, hungryCard: false, thirstyCard: false };
  private clock = 0;
  private hatch = 0;
  private prepared = false;

  constructor(private ctx: LivingCtx) {
    this.galley = new Galley({
      cook: () => this.cook(),
      coconut: () => this.coconut(),
      cutBait: () => this.cutBait(),
      close: () => this.showGalley(false),
      click: () => ctx.audio.click(),
    });
    this.bench = new Workbench({
      make: (id) => this.make(id),
      close: () => this.showBench(false),
      click: () => ctx.audio.click(),
    });
  }

  get panelOpen(): boolean {
    return this.galley.open || this.bench.open;
  }

  closePanels(): void {
    this.galley.show(false);
    this.bench.show(false);
  }

  // ---------- saving ----------

  save(): { aboard: AboardState; palms: Record<number, number> } {
    return { aboard: this.aboard, palms: { ...this.palms } };
  }

  restore(raw: unknown): void {
    const r = (raw ?? {}) as { aboard?: unknown; palms?: Record<string, unknown> };
    this.aboard = restoreAboard(r.aboard);
    this.palms = {};
    if (r.palms && typeof r.palms === 'object') for (const [k, v] of Object.entries(r.palms)) if (Number.isFinite(Number(k)) && typeof v === 'number') this.palms[Number(k)] = v;
    this.putRodAway(true);
    this.lastDay = -1;
  }

  /** A new game. */
  reset(): void {
    this.aboard = newAboard();
    this.palms = {};
    this.putRodAway(true);
    this.lastDay = -1;
  }

  // ---------- the boat's handling ----------

  /** For the sailing: worn sails push less, a full bilge slows her. */
  get sailCondition(): number {
    return sailCondition(this.aboard);
  }

  get drag(): number {
    return bilgeDrag(this.aboard);
  }

  // ---------- each frame ----------

  /**
   * @param dt real seconds; simDt game seconds (dt × the game speed)
   * @param rainAtBoat rain falling where the boat is (0..1)
   * @param over how overpowered she was this frame; flogging: sails flapping hard in a strong wind
   */
  update(dt: number, simDt: number, time: number, rainAtBoat: number, over: number, flogging: boolean, night: number): void {
    const a = this.aboard;
    const ctx = this.ctx;
    const boat = ctx.boat();
    this.clock = time;
    // Eat and drink as the days pass.
    const now = ctx.dayNow();
    if (this.lastDay < 0 || now < this.lastDay || now - this.lastDay > 2) this.lastDay = now;
    const days = now - this.lastDay;
    this.lastDay = now;
    if (days > 0) {
      const news = useStores(a, days);
      if (news.lowFood) ctx.toast('Food is getting low: about 3 days left. Catch fish, or open a coconut in the galley.', 4500);
      if (news.lowWater) ctx.toast('Water is getting low: about 3 days left. Rain fills the tank at anchor.', 4500);
      if (news.outFood) ctx.hud.showCard('Out of food', 'You’re hungry, so you’re slower until you eat. Catch fish and cook them in the galley, or open a coconut.', 8000);
      if (news.outWater) ctx.hud.showCard('Out of water', 'You’re thirsty, so you’re slower until you drink. Rain fills the tank at anchor (sail into a squall and anchor), and coconuts help.', 8000);
    }
    ctx.player.vigour = vigour(a);

    // Rain into the tank: the awning at anchor, off the mainsail under sail, or just the deck.
    if (rainAtBoat > 0.05) {
      const how = boat.anchored ? 'anchored' : boat.sail > 0.3 ? 'sailing' : 'deck';
      const before = a.water;
      catchRain(a, rainAtBoat, simDt, how);
      if (a.water > before && ctx.player.aboard && time - this.notes.rain > 150 && rainAtBoat > 0.4) {
        this.notes.rain = time;
        ctx.toast(boat.anchored ? 'Rain is running off the awning into the water tank.' : 'Rain is running off the mainsail into the tank.', 3500);
      }
      if (before < waterMax(a) && a.water >= waterMax(a) && time - this.notes.full > 120) {
        this.notes.full = time;
        ctx.toast('The water tank is full.', 2500);
      }
    }

    // Fish goes off after a day and a half.
    this.spoilTimer -= dt;
    if (this.spoilTimer <= 0) {
      this.spoilTimer = 1;
      const n = spoilFish(a, now);
      if (n) ctx.toast(`${n === 1 ? 'A fish' : `${n} fish`} in the cool box went off, over the side. The gulls are pleased.`, 4000);
    }

    // The hull leaks when it's badly worn; the sails wear in a blow.
    leak(a, boat.hull, simDt);
    if (a.bilge > 0.3 && time - this.notes.leak > 150) {
      this.notes.leak = time;
      ctx.hud.showCard('She’s leaking', 'The hull is badly worn and water is coming into the bilge. Pump it out with the pump in the cockpit, and patch the hull at the workbench.', 8000);
    }
    const s0 = a.sails;
    if (!boat.anchored) wearSails(a, over, flogging, simDt);
    if (s0 >= 70 && a.sails < 70 && !this.notes.worn) {
      this.notes.worn = true;
      ctx.toast('The sails are getting worn. Sailcloth and rope at the workbench will patch them.', 4000);
    }
    if (s0 >= UPKEEP.torn && a.sails < UPKEEP.torn) ctx.hud.showCard('A sail has torn', 'She won’t sail as well until you patch it: a scrap of sailcloth and some rope, at the workbench.', 7000);

    // The boat's bits.
    const rig = ctx.rig();
    rig?.setAwning?.(boat.anchored ? 1 : 0, (a.made.catcher ?? 0) > 0);
    rig?.setTrap?.((a.made.trap ?? 0) > 0 && boat.anchored);
    rig?.setRodStowed?.(!this.rodHeld);
    rig?.setBilge?.(a.bilge, time);
    // The hatch slides open while you're below in the galley.
    this.hatch += ((this.galley.open ? 1 : 0) - this.hatch) * Math.min(1, dt * 4);
    rig?.setHatch?.(this.hatch);
    rig?.setGalleyLight?.(night > 0.5);
    this.pumpAnim = Math.max(0, this.pumpAnim - dt * 2.5);
    rig?.setPump?.(Math.sin(Math.min(1, this.pumpAnim) * Math.PI));
    // Holding the use key at the pump keeps pumping.
    if (this.pumpHoldT > 0) {
      this.pumpHoldT -= dt;
      if (this.useHeld() && this.nearPump()) {
        if (this.pumpHoldT <= 0) this.pump();
      } else this.pumpHoldT = 0;
    }

    this.updateFishing(dt, time);

    ctx.hud.setStores(a.food, a.water, STORES.foodMax, waterMax(a));
    ctx.hud.setRod(this.rodHeld || this.canFish(), this.rodHeld);
    if (this.galley.open && Math.floor(time * 2) !== Math.floor((time - dt) * 2)) this.renderGalley();
  }

  /** Each morning: the fish trap, if she was at anchor with it set. */
  morning(day: number): void {
    const a = this.aboard;
    const boat = this.ctx.boat();
    if (!(a.made.trap ?? 0) || !boat.anchored || a.trapDay >= day) return;
    a.trapDay = day;
    const r = mulberry32(day * 131 + 7);
    const n = 1 + (r() < 0.5 ? 1 : 0);
    const depth = -this.ctx.floorAt(boat.x, boat.z);
    const got: string[] = [];
    for (let i = 0; i < n; i++) {
      let k = fishHere({ depth: Math.max(2, depth), open: this.ctx.openness(boat.x, boat.z) }, r());
      if (FISH[k].release) k = 'grunt';
      a.coolBox.push({ kind: k, caught: this.ctx.dayNow() });
      a.fishLog[k] = (a.fishLog[k] ?? 0) + 1;
      got.push(`a ${FISH[k].name}`);
    }
    this.ctx.hud.showCard('The fish trap', `Overnight it caught ${got.join(' and ')}. ${got.length === 1 ? 'It’s' : 'They’re'} in the cool box.`, 6000);
    this.ctx.changed();
  }

  // ---------- what you can do here ----------

  private useHeld(): boolean {
    const i = this.ctx.input;
    return i.isDown('KeyE') || i.isDown('Use') || i.isDown('Action');
  }

  /** How far a spot on the boat is (Infinity if it's on another level: the hull cabins, the saloon, the flybridge). */
  private distTo(p: THREE.Vector3 | undefined): number {
    if (!p) return Infinity;
    const pl = this.ctx.player;
    if (Math.abs(pl.pos.y - p.y) > 0.7) return Infinity;
    return Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z);
  }

  private nearPump(): boolean {
    return this.ctx.player.mode === 'deck' && this.distTo(this.ctx.points.pump) < 1.1;
  }

  /** Something to do right here (null if nothing). The rod in hand comes first. */
  action(): LivingAction | null {
    const ctx = this.ctx;
    const pl = ctx.player;
    if (this.rodHeld) {
      const ph = this.fishing.phase;
      const tap = ctx.isTouch ? 'tap' : 'E';
      if (ph === 'idle') return { kind: 'fish', label: 'Cast' };
      if (ph === 'waiting') return { kind: 'fish', label: 'Reel in' };
      if (ph === 'bite') return { kind: 'fish', label: 'Strike!' };
      return { kind: 'fish', label: ctx.isTouch ? 'Hold to reel' : `Hold ${tap} to reel` };
    }
    if (pl.mode === 'land') {
      // Under a coconut palm.
      let best = -1;
      let bd = 1.6;
      ctx.palms.forEach((p, i) => {
        const d = Math.hypot(pl.pos.x - p.x, pl.pos.z - p.z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (best >= 0) return { kind: 'palm', index: best, label: this.palmReady(best) ? 'Shake the palm' : 'No ripe coconuts on this palm yet' };
    }
    return null;
  }

  /** Things to do on deck, each with how far away its spot is (main.ts picks the nearest, with the locker and the helm). */
  deckOptions(): [number, LivingAction][] {
    const ctx = this.ctx;
    if (ctx.player.mode !== 'deck' || ctx.atHelm() || this.rodHeld) return [];
    const opts: [number, LivingAction][] = [];
    const a = this.aboard;
    // Still offered for a moment after it's dry, so an extra press doesn't open the galley next to it.
    if (a.bilge > 0.03 || this.clock - this.lastStroke < 2.5) opts.push([this.distTo(ctx.points.pump), { kind: 'pump', label: a.bilge > 0.005 ? `Pump the bilge (${Math.round(a.bilge * 100)}% full)` : 'The bilge is dry' }]);
    opts.push([this.distTo(ctx.points.galley), { kind: 'galley', label: 'Use the galley' }]);
    opts.push([this.distTo(ctx.points.workbench), { kind: 'workbench', label: 'Use the workbench' }]);
    return opts;
  }

  /** Do it (pressed E, clicked or tapped). */
  doAction(a: LivingAction): void {
    if (a.kind === 'fish') this.fishPress();
    else if (a.kind === 'galley') this.showGalley(true);
    else if (a.kind === 'workbench') this.showBench(true);
    else if (a.kind === 'pump') this.pump();
    else if (a.kind === 'palm') this.shakePalm(a.index);
  }

  // ---------- the galley and the workbench ----------

  showGalley(on: boolean): void {
    if (on) {
      this.ctx.onGalley?.();
      this.ctx.closeOtherPanels();
      this.bench.show(false);
      this.renderGalley();
      this.ctx.unlockPointer();
    }
    this.galley.show(on);
  }

  private renderGalley(): void {
    const a = this.aboard;
    const now = this.ctx.dayNow();
    const trap = (a.made.trap ?? 0) > 0 ? ' The fish trap is set whenever she’s at anchor.' : '';
    this.galley.render({
      food: a.food,
      foodMax: STORES.foodMax,
      water: a.water,
      waterMax: waterMax(a),
      fish: a.coolBox.map((f) => ({ name: fishName(f.kind), hoursLeft: (STORES.fishKeeps - (now - f.caught)) * 24 })),
      fishFood: a.coolBox.reduce((s, f) => s + foodOf(f.kind, f.size ?? 1), 0),
      bait: { known: this.ctx.baitKnown?.() ?? false, have: a.bait, max: BAIT.max, perFish: BAIT.perFish },
      coconuts: this.ctx.beach.state.locker.coconut ?? 0,
      extras: `Rain fills the tank: most at anchor, under the awning${(a.made.catcher ?? 0) > 0 ? ' (the bigger catcher doubles it)' : ''}.${trap}`,
      hungry: a.food <= 0,
      thirsty: a.water <= 0,
    });
  }

  private cook(): void {
    if (!this.ctx.player.aboard) {
      this.ctx.toast('Go aboard to cook: the galley is below decks.', 2500);
      return;
    }
    const had = this.aboard.coolBox.length;
    const added = cookFish(this.aboard, foodOf);
    if (had) this.ctx.onCook?.();
    this.ctx.audio.chime(false);
    this.ctx.toast(added > 0 ? `Fish supper: +${added.toFixed(1)} days of food in the larder.` : 'The larder is full.', 3000);
    this.ctx.changed();
    this.renderGalley();
  }

  private cutBait(): void {
    if (!this.ctx.player.aboard) return;
    const n = cutBait(this.aboard);
    if (!n) {
      this.ctx.toast(this.aboard.bait >= BAIT.max ? 'The bait box is full.' : 'No fish in the cool box to cut up.', 2500);
      return;
    }
    this.ctx.audio.thud(0.12);
    this.ctx.toast(`You cut a fish into ${n} pieces of bait (${this.aboard.bait} in the bait box).`, 3000);
    this.ctx.changed();
    this.renderGalley();
  }

  private coconut(): void {
    if (!openCoconut(this.aboard, this.ctx.beach.state.locker)) return;
    this.ctx.audio.thud(0.15);
    this.ctx.toast('You crack it open: sweet coconut water and the white meat.', 2500);
    this.ctx.changed();
    this.renderGalley();
  }

  showBench(on: boolean): void {
    if (on) {
      this.ctx.closeOtherPanels();
      this.galley.show(false);
      this.renderBench();
      this.ctx.unlockPointer();
    }
    this.bench.show(on);
  }

  private renderBench(): void {
    const a = this.aboard;
    const st = this.ctx.beach.state;
    const boat = this.ctx.boat();
    this.bench.render({
      hull: boat.hull,
      sails: a.sails,
      bilge: a.bilge,
      recipes: RECIPES.map((r) => ({
        id: r.id,
        name: r.name,
        text: r.text,
        known: recipeKnown(r, st.found),
        needs: Object.entries(r.needs).map(([k, n]) => ({ name: (FINDS[k as FindKind]?.name ?? k).replace(/^(piece of |tangle of |scrap of )/, ''), have: st.locker[k as FindKind] ?? 0, need: n })),
        why: whyNot(r, a, boat.hull, st.locker),
      })),
    });
  }

  private make(id: string): void {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return;
    const boat = this.ctx.boat();
    if (whyNot(r, this.aboard, boat.hull, this.ctx.beach.state.locker)) return;
    boat.hull = make(r, this.aboard, boat.hull, this.ctx.beach.state.locker);
    this.ctx.onMake?.();
    // A few mallet taps.
    for (let i = 0; i < 4; i++) setTimeout(() => this.ctx.audio.thud(0.12), i * 180);
    this.ctx.toast(`Done: ${r.name.toLowerCase()}.`, 2500);
    this.ctx.changed();
    this.renderBench();
  }

  private lastStroke = -99;

  private pump(): void {
    this.lastStroke = this.clock;
    if (this.aboard.bilge <= 0) {
      this.ctx.toast('The bilge is dry.', 1500);
      return;
    }
    pumpStroke(this.aboard);
    this.pumpAnim = 1;
    this.pumpHoldT = 0.35;
    this.ctx.audio.splash(0.12);
    if (this.aboard.bilge <= 0) this.ctx.toast('The bilge is dry.', 2000);
    this.ctx.changed();
  }

  // ---------- coconut palms ----------

  private palmReady(i: number): boolean {
    const last = this.palms[i];
    return last === undefined || this.ctx.dayNow() - last >= 2;
  }

  private shakePalm(i: number): void {
    const ctx = this.ctx;
    if (!this.palmReady(i)) {
      ctx.toast('No ripe coconuts on this one yet. Try another palm, or come back in a couple of days.', 3000);
      return;
    }
    const p = ctx.palms[i];
    this.palms[i] = ctx.dayNow();
    const n = 1 + (this.rand() < 0.45 ? 1 : 0);
    const pl = ctx.player.pos;
    for (let k = 0; k < n; k++) {
      // They thump down beside the trunk, toward you.
      const a = Math.atan2(pl.z - p.z, pl.x - p.x) + (this.rand() - 0.5) * 1.6;
      const r = 0.7 + this.rand() * 0.6;
      ctx.beach.drop('coconut', p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, Math.floor(ctx.dayNow()), this.rand() * 6.3);
      setTimeout(() => ctx.audio.thud(0.2), 350 + k * 260);
    }
    ctx.beachView.sync();
    ctx.toast(n === 1 ? 'A coconut thumps down.' : 'Two coconuts thump down.', 2200);
    ctx.changed();
  }

  // ---------- fishing ----------

  /** Can you fish from here? Aboard (not steering, not racing along), or on the shore. */
  canFish(): boolean {
    const pl = this.ctx.player;
    if (this.ctx.atHelm()) return false;
    if (pl.mode === 'deck') return Math.abs(this.ctx.boat().speed) < 1.5;
    if (pl.mode === 'seat') return Math.abs(this.ctx.seatedSpeed?.() ?? 0) < 1.2;
    return pl.mode === 'land';
  }

  toggleRod(): void {
    if (this.rodHeld) this.putRodAway();
    else if (this.canFish()) {
      this.rodHeld = true;
      this.ctx.held.setHolding?.('rod');
      if (!this.prepared) {
        this.prepared = true;
        this.ctx.prepare?.();
      }
      this.ctx.audio.click();
      this.ctx.toast(this.ctx.isTouch ? 'Face the water and tap “Cast”.' : 'Face the water and press E to cast.', 2600);
    } else
      this.ctx.toast(
        this.ctx.player.mode === 'swim' ? 'You can’t fish while swimming.' : this.ctx.player.mode === 'seat' ? 'Slow down to fish from the dinghy.' : 'Not from here: fish from the deck (not at the helm), the shore or the dinghy.',
        2600,
      );
  }

  putRodAway(quiet = false): void {
    if (!this.rodHeld && this.fishing.phase === 'idle') return;
    this.rodHeld = false;
    reelIn(this.fishing);
    this.ctx.line?.setOut(false);
    this.ctx.held.setHolding?.('basket');
    this.ctx.hud.setFishing(null);
    if (!quiet) this.ctx.audio.click();
  }

  private fishPress(): void {
    const s = this.fishing;
    const ctx = this.ctx;
    if (s.phase === 'idle') {
      // Cast about 9 m ahead, onto water.
      const cam = ctx.camera;
      const dir = new THREE.Vector3();
      cam.getWorldDirection(dir);
      dir.y = 0;
      if (dir.lengthSq() < 1e-4) return;
      dir.normalize();
      // Where you stand in the world (on deck, player.pos is on the boat's own grid).
      const pl = ctx.player.feet;
      let hit: THREE.Vector3 | null = null;
      for (const d of [FISHING.castDistance, 7, 5]) {
        const x = pl.x + dir.x * d;
        const z = pl.z + dir.z * d;
        const depth = -ctx.floorAt(x, z);
        const boat = ctx.boat();
        const clearOfBoat = ctx.clearOfBoat ? ctx.clearOfBoat(x, z) : Math.hypot(x - boat.x, z - boat.z) > 3.5;
        if (depth > 0.5 && clearOfBoat) {
          hit = new THREE.Vector3(x, 0, z);
          break;
        }
      }
      if (!hit) {
        ctx.toast('Face open water to cast.', 2000);
        return;
      }
      const depth = -ctx.floorAt(hit.x, hit.z);
      const risk = ctx.riskAt?.(hit.x, hit.z) ?? 0;
      const kind = fishHere({ depth, open: ctx.openness(hit.x, hit.z), risk }, this.rand());
      cast(s, kind, (this.aboard.made.lure ?? 0) > 0, this.rand, { size: fishSize(risk, this.rand()), strong: (this.aboard.made.strongReel ?? 0) > 0 });
      this.castRisk = risk;
      this.castAt.copy(hit);
      this.castFrom.copy(ctx.player.mode === 'deck' ? ctx.player.pos : pl);
      ctx.held.cast?.();
      ctx.line?.setOut(true);
      setTimeout(() => {
        if (this.fishing.phase !== 'idle') {
          ctx.line?.landed();
          ctx.audio.splash(0.15);
        }
      }, 550);
      ctx.audio.click();
    } else if (s.phase === 'waiting') {
      reelIn(s);
      ctx.line?.setOut(false);
    } else if (s.phase === 'bite') this.strikeQueued = true;
    // While reeling, holding the button is read in updateFishing.
  }

  private strikeQueued = false;
  private castRisk = 0;

  private updateFishing(dt: number, time: number): void {
    const s = this.fishing;
    const ctx = this.ctx;
    if (this.rodHeld && !this.canFish() && !(ctx.player.mode === 'deck' && !ctx.atHelm())) {
      this.putRodAway();
      return;
    }
    if (!this.rodHeld) return;
    // Walked away from where you cast, or the boat got going: reel in.
    // (On deck that's measured on the boat's own grid, so her swinging at anchor doesn't count.)
    if (s.phase !== 'idle' && (Math.hypot(ctx.player.pos.x - this.castFrom.x, ctx.player.pos.z - this.castFrom.z) > 5 || Math.abs(ctx.boat().speed) > 1.5)) {
      reelIn(s);
      ctx.line?.setOut(false);
      ctx.toast('You reel in the line.', 1800);
    }
    const reel = s.phase === 'reeling' && this.useHeld();
    const ev: FishingEvent = stepFishing(s, dt, { strike: this.strikeQueued, reel }, this.rand);
    this.strikeQueued = false;
    if (ev) this.onFishEvent(ev);
    // The float: where it landed, pulled toward you as you reel.
    if (s.phase !== 'idle') {
      const k = s.phase === 'reeling' ? s.progress * 0.75 : 0;
      const me = ctx.player.feet;
      this.float.set(this.castAt.x + (me.x - this.castAt.x) * k, 0, this.castAt.z + (me.z - this.castAt.z) * k);
      this.float.y = ctx.seaHeight(this.float.x, this.float.z);
      ctx.tipWorld(this.tip);
      ctx.line?.update(this.tip, this.float, time, s.phase === 'reeling' ? s.tension : 0);
      ctx.line?.fighting?.(s.phase === 'reeling' ? (s.running ? 1 : 0.4) : 0);
    }
    ctx.held.bend?.(s.phase === 'reeling' ? Math.min(1, 0.3 + s.tension * 0.8) : s.phase === 'bite' ? 0.25 : 0);
    ctx.held.reelTurn?.(reel ? 1 : 0);
    // The panel.
    const t = ctx.isTouch;
    // (The prompt under the dot says which key; this says what's happening.)
    if (s.phase === 'idle') ctx.hud.setFishing({ text: 'Face the water to cast', tension: null, progress: null });
    else if (s.phase === 'waiting') ctx.hud.setFishing({ text: 'Waiting for a bite…', tension: null, progress: null });
    else if (s.phase === 'bite') ctx.hud.setFishing({ text: `<b>A bite!</b> ${t ? 'Tap quick!' : 'Quick!'}`, tension: null, progress: null });
    else ctx.hud.setFishing({ text: s.tension > 0.7 ? '<b>Ease off!</b> The line’s tight' : s.running ? 'It’s running: careful…' : 'Reeling it in…', tension: s.tension, progress: s.progress });
  }

  private onFishEvent(ev: FishingEvent): void {
    const ctx = this.ctx;
    const s = this.fishing;
    if (ev === 'bite') {
      ctx.line?.bite(FISH[s.kind].strength);
      ctx.audio.splash(0.08);
      if (navigator.vibrate) navigator.vibrate(40);
    } else if (ev === 'missed') ctx.toast('Too slow: it stole the bait. Wait for the next bite.', 2200);
    else if (ev === 'hooked') {
      ctx.audio.splash(0.2);
      if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
    } else if (ev === 'run') {
      if (navigator.vibrate) navigator.vibrate(15);
    } else if (ev === 'snapped') {
      ctx.line?.setOut(false);
      ctx.audio.thud(0.1);
      ctx.toast('Snap! The line broke and the fish got away. You tie on a new hook.', 3000);
    } else if (ev === 'caught') {
      ctx.line?.setOut(false);
      const k = s.kind;
      const info = FISH[k];
      const a = this.aboard;
      const first = !(a.fishLog[k] ?? 0);
      a.fishLog[k] = (a.fishLog[k] ?? 0) + 1;
      const kg = fishKg(k, s.size);
      const record = kg > (a.biggest[k] ?? 0) && !first;
      a.biggest[k] = Math.max(a.biggest[k] ?? 0, kg);
      const big = s.size >= 1.4 ? `A big one: ${kg} kg! ` : `${kg} kg. `;
      ctx.held.showCatch?.(k);
      ctx.audio.chime(first || record);
      if (info.release) ctx.hud.showCard(`A ${info.name}!`, `${big}You let it go. ${info.fact}`, 8000);
      else {
        a.coolBox.push({ kind: k, caught: ctx.dayNow(), size: s.size });
        if (first) ctx.hud.showCard(`New: ${info.name}`, `${big}${info.fact} It’s in the cool box: cook it in the galley.`, 8000);
        else if (record) ctx.hud.showCard(`Your biggest ${info.name} yet`, `${kg} kg, into the cool box.`, 4500);
        else ctx.toast(`A ${info.name}, ${kg} kg, into the cool box.`, 2500);
      }
      ctx.onCatch?.(k, kg, this.castRisk);
      ctx.changed();
    }
  }

  // ---------- for the logbook and the dev tools ----------

  logRows(): { name: string; value: string; text: string }[] {
    const a = this.aboard;
    const made = (Object.keys(a.made) as (keyof AboardState['made'])[]).filter((k) => (a.made[k] ?? 0) > 0);
    const names: Record<string, string> = { catcher: 'the bigger rain catcher', jugs: 'water jugs', lure: 'a feather lure', trap: 'a fish trap', planter: 'more deck pots', goodSails: 'Ida’s heavy sails', strongReel: 'Ida’s strong reel' };
    return [
      { name: 'Sails', value: `${Math.round(a.sails)}%`, text: a.sails < UPKEEP.torn ? 'Torn: patch them at the workbench (sailcloth and rope).' : 'Sailing hard when she’s overpowered, or letting the sails flog in a strong wind, wears them.' },
      { name: 'Bilge', value: a.bilge > 0.02 ? `${Math.round(a.bilge * 100)}% full` : 'dry', text: 'A badly scraped hull leaks. The pump is in the cockpit.' },
      { name: 'Stores', value: `${a.food.toFixed(1)} days food · ${a.water.toFixed(1)} days water`, text: `The larder holds ${STORES.foodMax} days, the tank ${waterMax(a)}. ${made.length ? `Aboard: ${made.map((k) => names[k]).join(', ')}.` : ''}` },
      { name: 'Dinghy', value: `${Math.round(a.dinghy)}%`, text: a.dinghy < 99.5 ? 'Sharks’ bumps have dented it, so it’s slower. Mend it at the workbench (driftwood and rope).' : 'Sound. It hangs in the davits between the sterns.' },
      { name: 'Bait box', value: `${a.bait} of ${BAIT.max}`, text: 'Throw a piece to a curious shark and it leaves you be. Cut a fish into bait in the galley.' },
    ];
  }

  logFish(): { name: string; count: number; fact: string }[] {
    return FISH_KINDS.map((k) => ({ name: FISH[k].name, count: this.aboard.fishLog[k] ?? 0, fact: FISH[k].fact, best: this.aboard.biggest[k] ? `biggest ${this.aboard.biggest[k]} kg` : '' }));
  }

  devFill(): void {
    this.aboard.food = STORES.foodMax;
    this.aboard.water = waterMax(this.aboard);
  }

  devLow(): void {
    this.aboard.food = 1;
    this.aboard.water = 1;
  }

  devMaterials(): void {
    const st = this.ctx.beach.state;
    for (const k of FIND_KINDS) {
      st.locker[k] = (st.locker[k] ?? 0) + 3;
      st.found[k] = Math.max(1, st.found[k] ?? 0);
    }
  }

  devBite(): void {
    if (this.fishing.phase === 'waiting') this.fishing.wait = 0;
  }

  /** For the checks: the time now (the clock this file last saw). */
  get seenTime(): number {
    return this.clock;
  }
}
