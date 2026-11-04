/**
 * The garden, in the game: pots on the cabin-top trays and the beds on Home
 * Cay, with their plants drawn as they grow; planting, watering (pots from
 * the boat's tank, beds from the rain barrel) and harvesting. The rules are
 * in game/garden.ts.
 */
import * as THREE from 'three';
import {
  BED_IDS,
  CROPS,
  CROP_KINDS,
  GARDEN,
  POT_IDS,
  fillBarrel,
  growGarden,
  harvest,
  isPot,
  newGarden,
  plant,
  plot,
  plotLabel,
  potCount,
  restoreGarden,
  ripe,
  thirst,
  water,
  type CropKind,
  type GardenState,
} from './game/garden';
import { PlantPanel } from './ui/plantPanel';

export interface PlantViewLike {
  readonly group: THREE.Object3D;
  set(crop: CropKind | null, growth: number, thirsty: number, ripe: boolean): void;
  update(time: number): void;
}

/** The models (from render/garden.ts), if they're there. */
export interface GardenViews {
  plant(size: 'pot' | 'bed'): PlantViewLike;
  pot(): THREE.Object3D;
  bed(): THREE.Object3D;
  barrel(): { group: THREE.Object3D; setLevel(level: number): void };
  sign(text: string): THREE.Object3D;
  /** Height of the soil above the pot's or bed's base (m). */
  soil: { pot: number; bed: number };
}

export interface GardeningCtx {
  /** Boat-local spots on the cabin-top trays, and the boat's model (pots ride on it). */
  potSpots: THREE.Vector3[];
  boatGroup: THREE.Object3D;
  scene: THREE.Scene;
  beds: { x: number; z: number; rot: number }[];
  barrelAt: { x: number; z: number };
  signAt: { x: number; z: number };
  groundAt(x: number, z: number): number;
  views: GardenViews | null;
  /** The player: mode, and position (on the boat's grid when on deck). */
  player(): { mode: string; x: number; y: number; z: number };
  dayNow(): number;
  /** Draw from the boat's tank (days of water); false if there isn't enough. */
  useTankWater(days: number): boolean;
  addFood(days: number): number;
  toast(msg: string, ms?: number): void;
  card(title: string, text: string, ms?: number): void;
  sound: { splash(size: number): void; chime(first: boolean): void; click(): void };
  /** Show the watering can for a moment. */
  pour(): void;
  changed(): void;
  closeOtherPanels(): void;
  unlockPointer(): void;
}

export type GardenAction = { kind: 'garden'; id: string; label: string };

export class Gardening {
  state: GardenState = newGarden();
  readonly panel: PlantPanel;
  private plants = new Map<string, PlantViewLike>();
  private pots: THREE.Object3D[] = [];
  private barrel: { group: THREE.Object3D; setLevel(l: number): void } | null = null;
  private shown = new Map<string, string>();
  private pending: string | null = null;
  private rand = Math.random;
  private planters = 0;

  constructor(private ctx: GardeningCtx) {
    this.panel = new PlantPanel(
      (crop) => this.plantHere(crop as CropKind),
      () => this.panel.show(false),
      () => ctx.sound.click(),
    );
    this.build();
  }

  get panelOpen(): boolean {
    return this.panel.open;
  }

  closePanels(): void {
    this.panel.show(false);
  }

  /** Put the pots, beds, barrel and sign in the world (once the models exist). */
  private build(): void {
    const v = this.ctx.views;
    if (!v) return;
    const c = this.ctx;
    // Beds on the island, each with its plant.
    BED_IDS.forEach((id, i) => {
      const b = c.beds[i];
      const y = c.groundAt(b.x, b.z);
      const bed = v.bed();
      bed.position.set(b.x, y, b.z);
      bed.rotation.y = b.rot;
      c.scene.add(bed);
      const pl = v.plant('bed');
      pl.group.position.set(b.x, y + v.soil.bed, b.z);
      pl.group.rotation.y = b.rot;
      c.scene.add(pl.group);
      this.plants.set(id, pl);
    });
    this.barrel = v.barrel();
    this.barrel.group.position.set(c.barrelAt.x, c.groundAt(c.barrelAt.x, c.barrelAt.z), c.barrelAt.z);
    c.scene.add(this.barrel.group);
    const sign = v.sign('Home garden');
    sign.position.set(c.signAt.x, c.groundAt(c.signAt.x, c.signAt.z), c.signAt.z);
    sign.rotation.y = Math.PI; // facing the cove
    c.scene.add(sign);
    // Pots on the boat (all four made; the ones you don't have yet are hidden).
    POT_IDS.forEach((id, i) => {
      const at = c.potSpots[i];
      if (!at) return;
      const pot = v.pot();
      pot.position.copy(at);
      c.boatGroup.add(pot);
      this.pots.push(pot);
      const pl = v.plant('pot');
      pl.group.position.set(at.x, at.y + v.soil.pot, at.z);
      c.boatGroup.add(pl.group);
      this.plants.set(id, pl);
    });
    this.showPots();
  }

  private showPots(): void {
    const n = potCount(this.planters);
    this.pots.forEach((p, i) => (p.visible = i < n));
    POT_IDS.forEach((id, i) => {
      const pl = this.plants.get(id);
      if (pl) pl.group.visible = i < n;
    });
  }

  /** Planters made at the workbench (each adds a pot). */
  setPlanters(n: number): void {
    if (n === this.planters) return;
    this.planters = n;
    this.showPots();
  }

  // ---------- saving ----------

  save(): GardenState {
    return this.state;
  }

  restore(raw: unknown): void {
    this.state = restoreGarden(raw);
    this.shown.clear();
    this.lastDay = -1;
  }

  reset(): void {
    this.state = newGarden();
    this.shown.clear();
    this.lastDay = -1;
  }

  // ---------- each frame ----------

  private lastDay = -1;

  update(dt: number, simDt: number, time: number, rainBoat: number, rainGarden: number): void {
    const now = this.ctx.dayNow();
    if (this.lastDay < 0 || now < this.lastDay || now - this.lastDay > 2) this.lastDay = now;
    const days = now - this.lastDay;
    this.lastDay = now;
    const g = this.state;
    if (days > 0) {
      const gone = growGarden(g, days, now, (id) => (isPot(id) ? rainBoat : rainGarden) > 0.3);
      for (const id of gone) this.ctx.toast(`The plant in ${isPot(id) ? 'a pot' : 'a garden bed'} withered: three days without water.`, 4000);
    } else {
      // Rain still waters them while the clock is stopped.
      for (const [id, p] of Object.entries(g.plots)) if (p.crop && (isPot(id) ? rainBoat : rainGarden) > 0.3) p.watered = now;
    }
    fillBarrel(g, rainGarden, simDt);
    this.barrel?.setLevel(g.barrel / GARDEN.barrelMax);
    // The plants' looks (rebuilt only when they change noticeably).
    for (const id of [...POT_IDS, ...BED_IDS]) {
      const pl = this.plants.get(id);
      if (!pl) continue;
      const p = plot(g, id);
      const th = p ? thirst(p, now) : 0;
      const key = p ? `${p.crop}|${Math.round(p.growth * 40)}|${Math.round(th * 10)}|${ripe(p)}` : '';
      if (this.shown.get(id) !== key) {
        this.shown.set(id, key);
        pl.set(p ? p.crop : null, p ? p.growth : 0, th, p ? ripe(p) : false);
      }
      if (p) pl.update(time);
    }
    void dt;
  }

  // ---------- what you can do ----------

  /** On deck: the pots, with how far each is (on the boat's grid). */
  deckOptions(): [number, GardenAction][] {
    const pl = this.ctx.player();
    if (pl.mode !== 'deck') return [];
    const n = potCount(this.planters);
    const now = this.ctx.dayNow();
    const out: [number, GardenAction][] = [];
    POT_IDS.slice(0, n).forEach((id, i) => {
      const at = this.ctx.potSpots[i];
      if (!at) return;
      if (Math.abs(pl.y - at.y) > 0.8) return;
      out.push([Math.hypot(pl.x - at.x, pl.z - at.z), { kind: 'garden', id, label: plotLabel(this.state, id, now).label }]);
    });
    return out;
  }

  /** Ashore: the nearest garden bed within reach. */
  landAction(): GardenAction | null {
    const pl = this.ctx.player();
    if (pl.mode !== 'land') return null;
    let best: GardenAction | null = null;
    let bd = 1.5;
    BED_IDS.forEach((id, i) => {
      const b = this.ctx.beds[i];
      const d = Math.hypot(pl.x - b.x, pl.z - b.z);
      if (d < bd) {
        bd = d;
        best = { kind: 'garden', id, label: plotLabel(this.state, id, this.ctx.dayNow()).label };
      }
    });
    if (!best) {
      const b = this.ctx.barrelAt;
      if (Math.hypot(pl.x - b.x, pl.z - b.z) < 1.2) best = { kind: 'garden', id: 'barrel', label: `Rain barrel: ${Math.floor(this.state.barrel)} watering${Math.floor(this.state.barrel) === 1 ? '' : 's'} in it` };
    }
    return best;
  }

  doAction(a: GardenAction): void {
    const c = this.ctx;
    const g = this.state;
    if (a.id === 'barrel') {
      c.toast('The barrel fills when it rains. Each watering of a bed uses some.', 2500);
      return;
    }
    const now = c.dayNow();
    const what = plotLabel(g, a.id, now).does;
    if (what === 'plant') {
      this.pending = a.id;
      c.closeOtherPanels();
      c.unlockPointer();
      this.panel.show(
        true,
        isPot(a.id) ? 'the pot' : 'the bed',
        CROP_KINDS.map((k) => ({
          id: k,
          name: cap(CROPS[k].name),
          have: `${g.seeds[k]} ${CROPS[k].seedName.split(' ').pop()}`,
          note: `Ripe in about ${CROPS[k].days} watered days; ${CROPS[k].food} day${CROPS[k].food === 1 ? '' : 's'} of food${CROPS[k].regrow ? ', and it grows back after you cut it' : ''}.`,
          ok: g.seeds[k] > 0,
        })),
      );
    } else if (what === 'water') {
      if (isPot(a.id)) {
        if (!c.useTankWater(GARDEN.potWater)) {
          c.toast('The water tank is empty. Rain will fill it.', 2500);
          return;
        }
      } else if (g.barrel < 1) {
        c.toast('The rain barrel is empty. Wait for rain (a squall fills it fast).', 3000);
        return;
      } else g.barrel -= 1;
      water(g, a.id, now);
      c.pour();
      c.sound.splash(0.12);
      c.changed();
    } else if (what === 'harvest') {
      const first = !(g.grown[plot(g, a.id)?.crop ?? 'callaloo'] ?? 0);
      const r = harvest(g, a.id, this.rand);
      if (!r) return;
      const added = c.addFood(r.food);
      const crop = CROPS[r.crop];
      c.sound.chime(first);
      if (first) c.card(`Your first ${crop.plural}`, `${crop.fact} (+${added.toFixed(1)} days of food${r.seeds ? `, ${r.seeds} ${crop.seedName.split(' ').pop()} for the tin` : ''}.)`, 8000);
      else c.toast(`${cap(crop.plural)}: +${added.toFixed(1)} days of food${r.seeds ? `, and ${r.seeds} ${crop.seedName.split(' ').pop()} saved` : ''}.`, 3000);
      c.changed();
    }
  }

  private plantHere(crop: CropKind): void {
    const id = this.pending;
    if (!id) return;
    const why = plant(this.state, id, crop, this.ctx.dayNow());
    if (why) {
      this.ctx.toast(why, 2000);
      return;
    }
    this.panel.show(false);
    this.ctx.toast(`Planted ${CROPS[crop].name}. Now water it!`, 2500);
    this.ctx.changed();
  }

  // ---------- logbook and dev tools ----------

  logRows(): { name: string; count: number; fact: string }[] {
    return CROP_KINDS.map((k) => ({ name: CROPS[k].plural, count: this.state.grown[k] ?? 0, fact: CROPS[k].fact }));
  }

  seedLine(): string {
    const g = this.state;
    return CROP_KINDS.map((k) => `${g.seeds[k]} ${CROPS[k].seedName}`).join(', ');
  }

  devGrow(): void {
    for (const p of Object.values(this.state.plots)) if (p.crop) p.growth = 1;
  }

  devWater(): void {
    const now = this.ctx.dayNow();
    for (const p of Object.values(this.state.plots)) if (p.crop) p.watered = now;
    this.state.barrel = GARDEN.barrelMax;
  }

  devSeeds(): void {
    for (const k of CROP_KINDS) this.state.seeds[k] += 5;
  }
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
