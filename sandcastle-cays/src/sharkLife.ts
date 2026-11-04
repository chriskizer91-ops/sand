/**
 * The sharks, in the game: their models swimming about the three shark
 * waters, the V of ripples where a fin cuts the surface, bait you throw, and
 * what a bump does. The rules are in game/sharks.ts; the models are
 * render/shark.ts.
 */
import * as THREE from 'three';
import { SHARKS, SHARK_INFO, finUp, newSharks, stepSharks, zoneAt, type Shark, type SharkEvent, type SharkKind, type SharkWorld, type SharkZone, type YouHow } from './game/sharks';
import { BaitCloud, FinWake, baitModel, prepareSharks, sharkModel, swim, type FinState } from './render/shark';

export interface SharkCtx {
  scene: THREE.Scene;
  seaHeight(x: number, z: number): number;
  /** Sea floor height. */
  floorAt(x: number, z: number): number;
  /** Something happened worth showing (a bump, a shark circling, one going for the bait). */
  onEvent(e: SharkEvent): void;
  /** You threw bait but have none. */
  noBait(): void;
  /** Take a piece of bait from the bait box (false if it's empty). */
  takeBait(): boolean;
  /** You saw a shark of this kind up close for the first time in a while. */
  onSeen(kind: SharkKind, zone: SharkZone): void;
}

interface Thrown {
  obj: THREE.Object3D;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** In the water (and how long ago it landed). */
  wet: boolean;
  age: number;
}

const SHOW_WITHIN = 140;

export class SharkLife {
  sharks: Shark[] = [];
  /** Sharks you've seen close up, by kind (for the logbook). */
  seen: Record<SharkKind, number> = { reef: 0, nurse: 0 };
  private models: THREE.Object3D[] = [];
  readonly finWake = new FinWake();
  readonly cloud = new BaitCloud();
  private thrown: Thrown[] = [];
  private world: SharkWorld;
  private rand: () => number;
  private near = new Set<number>();
  private fins: FinState[] = [];
  private prepared = false;

  constructor(
    readonly zones: SharkZone[],
    private ctx: SharkCtx,
    seed = 9137,
  ) {
    let a = seed >>> 0;
    this.rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.world = { floorAt: (x, z) => ctx.floorAt(x, z), you: { x: 1e6, z: 1e6, how: 'safe' }, bait: [] };
    this.sharks = newSharks(zones, this.world, this.rand);
    ctx.scene.add(this.finWake.mesh, this.cloud.mesh);
    this.finWake.waterAt = (x, z) => ctx.seaHeight(x, z);
  }

  /** Things that never go under the water (the under-water picture can skip them). */
  get overWater(): THREE.Object3D[] {
    return [this.finWake.mesh];
  }

  save(): unknown {
    return { seen: { ...this.seen } };
  }

  restore(raw: unknown): void {
    const r = raw as { seen?: Partial<Record<SharkKind, unknown>> } | null;
    for (const k of ['reef', 'nurse'] as SharkKind[]) {
      const v = r?.seen?.[k];
      this.seen[k] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    }
  }

  /** The shark waters you're in (if any). */
  zoneAt(x: number, z: number): SharkZone | null {
    return zoneAt(this.zones, x, z);
  }

  /** The nearest shark to (x, z), and how far. */
  nearest(x: number, z: number): { shark: Shark; d: number } | null {
    let best: { shark: Shark; d: number } | null = null;
    for (const s of this.sharks) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (!best || d < best.d) best = { shark: s, d };
    }
    return best;
  }

  /** Is a shark circling or coming in at you right now? */
  get threatened(): boolean {
    return this.sharks.some((s) => s.mood === 'curious' || s.mood === 'bump');
  }

  /** Throw a piece of bait from the eye, along the look direction. Returns false if there's none. */
  throwBait(eye: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (!this.ctx.takeBait()) {
      this.ctx.noBait();
      return false;
    }
    const d = new THREE.Vector3(dir.x, 0, dir.z);
    if (d.lengthSq() < 1e-6) d.set(1, 0, 0);
    d.normalize();
    const obj = baitModel();
    this.ctx.scene.add(obj);
    this.thrown.push({ obj, x: eye.x + d.x * 0.4, y: eye.y - 0.2, z: eye.z + d.z * 0.4, vx: d.x * 7, vy: 3.2, vz: d.z * 7, wet: false, age: 0 });
    if (this.thrown.length > 6) {
      const old = this.thrown.shift()!;
      this.ctx.scene.remove(old.obj);
    }
    return true;
  }

  /** Every frame. `you`: where you are and how exposed (swimming, wading, in the dinghy, or safe aboard). */
  update(dt: number, simDt: number, time: number, you: { x: number; z: number; how: YouHow }, camera: THREE.Vector3, day: number): void {
    const ctx = this.ctx;
    this.world.you = you;
    // Bait in flight, then in the water.
    this.world.bait.length = 0;
    for (const b of this.thrown) {
      if (!b.wet) {
        b.vy -= 9.8 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        const sea = ctx.seaHeight(b.x, b.z);
        if (b.y <= sea) {
          b.wet = true;
          b.y = sea;
          this.cloud.drop(new THREE.Vector3(b.x, sea, b.z));
        }
      } else {
        b.age += simDt;
        // It sinks slowly to the bottom.
        const floor = ctx.floorAt(b.x, b.z) + 0.03;
        b.y = Math.max(floor, b.y - 0.12 * simDt);
        this.world.bait.push({ x: b.x, z: b.z, age: b.age });
      }
      b.obj.position.set(b.x, b.y, b.z);
      b.obj.rotation.set(time * 3, time * 2, 0);
    }
    // Gone once the sharks have had it.
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      if (this.thrown[i].age > SHARKS.baitLife) {
        ctx.scene.remove(this.thrown[i].obj);
        this.thrown.splice(i, 1);
      }
    }

    // The sharks: a few small steps if the game's sped up.
    const n = Math.max(1, Math.ceil(simDt / 0.1));
    for (let i = 0; i < n; i++) {
      const ev = stepSharks(this.sharks, this.zones, this.world, simDt / n, this.rand);
      for (const e of ev) ctx.onEvent(e);
    }

    // Draw the ones near enough to see.
    const anyNear = this.sharks.some((s) => Math.hypot(s.x - camera.x, s.z - camera.z) < SHOW_WITHIN);
    if (anyNear && !this.prepared) {
      this.prepared = true;
      prepareSharks();
      for (const s of this.sharks) {
        const m = sharkModel(s.kind);
        m.visible = false;
        ctx.scene.add(m);
        this.models[s.id] = m;
      }
    }
    this.fins.length = 0;
    const byDist: [number, FinState, number][] = [];
    for (const s of this.sharks) {
      const m = this.models[s.id];
      const d = Math.hypot(s.x - camera.x, s.z - camera.z);
      if (m) {
        m.visible = d < SHOW_WITHIN;
        if (m.visible) {
          const rest = (m.userData.rest as number | undefined) ?? 0.15;
          const y = Math.max(s.y, ctx.floorAt(s.x, s.z) + rest);
          m.position.set(s.x, y, s.z);
          m.rotation.set(0, -s.heading, 0);
          swim(m, time, s.speed, s.turning);
          const ft = m.userData.finTip as THREE.Vector3 | undefined;
          if (ft) {
            const c = Math.cos(s.heading);
            const sn = Math.sin(s.heading);
            byDist.push([d, { x: s.x + ft.x * c - ft.z * sn, y: y + ft.y, z: s.z + ft.x * sn + ft.z * c, heading: s.heading, speed: s.speed }, s.id]);
          }
        }
      }
      // Seen up close (once each time it comes near).
      const zn = this.zones.find((z) => z.id === s.zone)!;
      if (d < 22 && !this.near.has(s.id)) {
        this.near.add(s.id);
        this.seen[s.kind]++;
        ctx.onSeen(s.kind, zn);
      } else if (d > 60) this.near.delete(s.id);
    }
    // The nearest eight, kept in a steady order so each wake stays with its own fin.
    byDist.sort((a, b) => a[0] - b[0]);
    for (const [, f] of byDist.slice(0, 8).sort((a, b) => a[2] - b[2])) this.fins.push(f);
    this.finWake.setDaylight(day);
    this.finWake.update(this.fins, time);
    this.cloud.update(time);
  }

  /** For the logbook. */
  logRows(): { name: string; count: number; fact: string; where: string }[] {
    return [
      { name: SHARK_INFO.reef.name, count: this.seen.reef, fact: SHARK_INFO.reef.fact, where: 'One patrols the gap in Home Cay’s reef; two cruise the deep water round the sea buoy.' },
      { name: SHARK_INFO.nurse.name, count: this.seen.nurse, fact: SHARK_INFO.nurse.fact, where: 'A crowd of them rests on the sand flats of Shark Bank, north-west of Home Cay.' },
    ];
  }

  /** Dev tools: is any fin showing? */
  get finsUp(): number {
    return this.sharks.filter((s) => finUp(s)).length;
  }

  /** Dev tools: make a shark of the waters you're in come and look at you now. False if you're not in shark waters. */
  devCurious(x: number, z: number): boolean {
    const zn = this.zoneAt(x, z);
    if (!zn) return false;
    const mine = this.sharks.filter((s) => s.zone === zn.id).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    const s = mine[0];
    if (!s) return false;
    s.mood = 'curious';
    s.t = 0;
    s.until = 12;
    s.cool = 0;
    return true;
  }
}
