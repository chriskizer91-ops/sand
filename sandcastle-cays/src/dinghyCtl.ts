/**
 * The dinghy, in the game: it hangs in the davits between the catamaran's
 * sterns; you lower it from a swim step and climb in, row it or run the
 * outboard, step out onto a beach or a sand flat, and come back aboard at
 * the stern (then it follows the big boat on its painter). The rules are in
 * game/dinghy.ts; the model is render/dinghy.ts.
 */
import * as THREE from 'three';
import { DINGHY, dinghySave, endOf, idleDinghy, motorRunning, newDinghy, restoreDinghy, startMotor, stepDinghy, stopMotor, towDinghy, towPoint, type DinghyState } from './game/dinghy';
import type { BoatState } from './game/sailing';
import { BoatMotion } from './render/boatMotion';
import { createDinghy, type Dinghy } from './render/dinghy';
import { Wake } from './render/wake';
import type { Player } from './player/player';
import type { SandAudio } from './audio/audio';

export interface CatForDinghy {
  group: THREE.Object3D;
  points: { davit?: THREE.Vector3; davitYaw?: number; dinghyBoard?: THREE.Vector3; ladderBottom: THREE.Vector3 };
  length: number;
  rig?: { setFalls?(f: number): void; status?(): { dinghyOrigin?: THREE.Vector3 } };
}

export interface DinghyCtx {
  scene: THREE.Scene;
  cat: CatForDinghy;
  boat(): BoatState;
  player: Player;
  seaHeight(x: number, z: number): number;
  /** Sea floor (or land) height. */
  floorAt(x: number, z: number): number;
  /** Ground height for standing (land, sand flats). */
  groundAt(x: number, z: number): number;
  /** The wind now, the way it blows toward (m/s). */
  wind(): { x: number; z: number };
  /** The dinghy's condition 0..100. */
  condition(): number;
  audio: SandAudio;
  toast(msg: string, ms?: number): void;
  tip(id: string): void;
  changed(): void;
  /** The dinghy has been launched and rowed a little way (for the notebook). */
  onRowed(): void;
}

export type DinghyAction =
  | { kind: 'lower'; board: boolean; label: string }
  | { kind: 'hoist'; label: string }
  | { kind: 'board'; label: string }
  | { kind: 'climbAboard'; label: string }
  | { kind: 'stepOut'; label: string };

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

export class DinghyCtl {
  state: DinghyState = newDinghy();
  readonly model: Dinghy;
  private motion: BoatMotion;
  private wake = new Wake();
  /** Lowering or hoisting in the davits: 0 = up .. 1 = on the water. */
  private falls = 0;
  private fallsDir: 0 | 1 | -1 = 0;
  /** Climb in once it's down. */
  private boardWhenDown = false;
  /** You're in it: at the oars (middle thwart) or by the tiller. */
  private place: 'oars' | 'tiller' = 'oars';
  private lastHeading = 0;
  private rowed = 0;
  private rowedNoted = false;
  steer = 0;

  constructor(private ctx: DinghyCtx) {
    this.model = createDinghy();
    this.model.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.motion = new BoatMotion(this.model.group, this.model.length, this.model.beam, (x, z) => ctx.seaHeight(x, z), 0);
    ctx.scene.add(this.wake.mesh);
    this.hang();
  }

  get wakeMesh(): THREE.Object3D {
    return this.wake.mesh;
  }

  /** Are you sitting in it? */
  get inIt(): boolean {
    return this.ctx.player.mode === 'seat';
  }

  get busy(): boolean {
    return this.fallsDir !== 0;
  }

  /** On the water, near enough to reach from (x, z)? */
  near(x: number, z: number, reach = DINGHY.reach): boolean {
    return this.state.where === 'water' && Math.hypot(this.state.x - x, this.state.z - z) < reach;
  }

  save(): unknown {
    return dinghySave(this.state);
  }

  restore(raw: unknown, seated: boolean): void {
    this.state = restoreDinghy(raw);
    this.falls = this.state.where === 'water' ? 1 : 0;
    this.fallsDir = 0;
    if (this.state.where === 'water') this.float();
    else this.hang();
    if (seated && this.state.where === 'water') this.sit('oars');
  }

  // ---------- where the model is ----------

  /** Hung in the davits (or partway down), riding the big boat. */
  private hang(): void {
    const cat = this.ctx.cat;
    const g = this.model.group;
    if (g.parent !== cat.group) cat.group.add(g);
    cat.rig?.setFalls?.(this.falls);
    const origin = cat.rig?.status?.().dinghyOrigin ?? cat.points.davit ?? new THREE.Vector3(-6, 1.1, 0);
    g.position.copy(origin);
    g.rotation.set(0, cat.points.davitYaw ?? -Math.PI / 2, 0);
    this.model.rig.setStowed(this.falls < 0.98);
    this.model.rig.setOars(0, false);
  }

  /** Afloat on its own. */
  private float(): void {
    const g = this.model.group;
    if (g.parent !== this.ctx.scene) this.ctx.scene.add(g);
    // Its falls are hauled back up out of the way.
    this.ctx.cat.rig?.setFalls?.(0);
    this.model.rig.setStowed(false);
  }

  // ---------- what you can do ----------

  /** Things to do aboard the catamaran (boat-local player position): at the swim step, or at the back of the cockpit. */
  deckOptions(pl: THREE.Vector3): [number, number, DinghyAction][] {
    const pts = this.ctx.cat.points;
    const out: [number, number, DinghyAction][] = [];
    if (this.busy) return out;
    const s = this.state;
    const b = pts.dinghyBoard;
    if (b && Math.abs(pl.y - b.y) < 0.6) {
      const d = Math.hypot(pl.x - b.x, pl.z - b.z);
      if (s.where === 'davits') out.push([d, 1.2, { kind: 'lower', board: true, label: 'Lower the dinghy and climb in' }]);
      else if (s.tied) out.push([d, 1.2, { kind: 'board', label: 'Climb into the dinghy' }]);
    }
    // At the back of the cockpit, by the davits: lower or hoist it without getting in.
    const w = this.winchSpot();
    if (w && Math.abs(pl.y - w.y) < 0.6) {
      const d = Math.hypot(pl.x - w.x, pl.z - w.z);
      if (s.where === 'davits') out.push([d, 1.1, { kind: 'lower', board: false, label: 'Lower the dinghy' }]);
      else if (s.tied) out.push([d, 1.1, { kind: 'hoist', label: 'Hoist the dinghy into the davits' }]);
    }
    return out;
  }

  /** The aft edge of the cockpit, between the davit arms. */
  private winchSpot(): THREE.Vector3 | null {
    const dv = this.ctx.cat.points.davit;
    if (!dv) return null;
    return new THREE.Vector3(dv.x + 1.1, 1.93, 0);
  }

  /** In the water or ashore (world position): climb in if it's within reach. */
  outsideAction(x: number, z: number): DinghyAction | null {
    if (this.busy || !this.near(x, z)) return null;
    return { kind: 'board', label: 'Climb into the dinghy' };
  }

  /** Sitting in it. */
  seatedAction(): DinghyAction | null {
    if (!this.inIt) return null;
    if (this.byTheStern()) return { kind: 'climbAboard', label: 'Climb aboard' };
    const depth = this.ctx.seaHeight(this.state.x, this.state.z) - this.sideGround().h;
    return { kind: 'stepOut', label: depth < 1.05 ? 'Step out' : 'Slip over the side for a swim' };
  }

  /** Close to the catamaran's stern steps? */
  private byTheStern(): boolean {
    const cat = this.ctx.cat;
    const pts = [cat.points.dinghyBoard, cat.points.ladderBottom].filter(Boolean) as THREE.Vector3[];
    for (const p of pts) {
      cat.group.localToWorld(tmp.copy(p));
      if (Math.hypot(tmp.x - this.state.x, tmp.z - this.state.z) < 4.2) return true;
    }
    return false;
  }

  doAction(a: DinghyAction): void {
    const ctx = this.ctx;
    if (a.kind === 'lower') {
      if (!this.ctx.boat().anchored && Math.abs(this.ctx.boat().speed) > 0.6) {
        ctx.toast('Slow her down or anchor first: you can’t launch the dinghy at speed.', 3000);
        return;
      }
      this.fallsDir = 1;
      this.boardWhenDown = a.board;
      ctx.audio.anchorChain(false);
    } else if (a.kind === 'hoist') {
      if (ctx.player.mode === 'seat') return;
      // Bring it in under the davits first.
      this.state.where = 'davits';
      this.falls = 1;
      this.fallsDir = -1;
      stopMotor(this.state);
      this.hang();
      ctx.audio.anchorChain(false);
      ctx.changed();
    } else if (a.kind === 'board') this.climbIn();
    else if (a.kind === 'climbAboard') this.climbAboard();
    else if (a.kind === 'stepOut') this.stepOut();
  }

  /** Pull it alongside and sit down at the oars. */
  private climbIn(): void {
    const ctx = this.ctx;
    const pl = ctx.player;
    if (pl.mode === 'deck') {
      // From the swim step: pull it in on its painter till its stern touches the step, bow pointing away.
      const b = ctx.cat.points.dinghyBoard!;
      const boat = ctx.boat();
      tmp.set(b.x - 0.35 - DINGHY.length * 0.5, 0, b.z);
      ctx.cat.group.localToWorld(tmp);
      this.state.x = tmp.x;
      this.state.z = tmp.z;
      this.state.heading = boat.heading + Math.PI;
      this.state.speed = 0;
      this.motion.update(0, 1, { x: this.state.x, z: this.state.z, heading: this.state.heading, heel: 0 });
    }
    this.state.tied = false;
    this.sit('oars');
    ctx.audio.thud(0.12);
    ctx.tip('dinghyIn');
    ctx.changed();
  }

  private sit(place: 'oars' | 'tiller'): void {
    const pts = this.model.points;
    this.place = place;
    const local = place === 'oars' ? pts.seat : pts.helm;
    const yaw = pts.helmYaw - this.state.heading;
    this.float();
    this.model.group.updateMatrixWorld(true);
    const keep = this.ctx.player.mode === 'seat' ? this.ctx.player.yaw : yaw;
    this.ctx.player.sitIn(this.model.group, local, keep, 0.78);
    this.lastHeading = this.state.heading;
  }

  private climbAboard(): void {
    const ctx = this.ctx;
    stopMotor(this.state);
    this.state.tied = true;
    const b = ctx.cat.points.dinghyBoard ?? ctx.cat.points.ladderBottom;
    ctx.player.placeAboard(b.clone(), ctx.player.yaw);
    ctx.audio.ladder();
    ctx.changed();
  }

  /** The side of the dinghy with the lower ground (for stepping out), and that ground's height. */
  private sideGround(): { x: number; z: number; h: number } {
    const s = this.state;
    let best = { x: s.x, z: s.z, h: Infinity };
    for (const side of [1, -1]) {
      const x = s.x - Math.sin(s.heading) * side * 1.1;
      const z = s.z + Math.cos(s.heading) * side * 1.1;
      const h = this.ctx.groundAt(x, z);
      if (h < best.h) best = { x, z, h };
    }
    // Run up on a beach: step off the bow onto the sand.
    if (s.aground) {
      const p = endOf(s, 1);
      const x = p.x + Math.cos(s.heading) * 0.6;
      const z = p.z + Math.sin(s.heading) * 0.6;
      const h = this.ctx.groundAt(x, z);
      if (h > best.h - 0.6) best = { x, z, h };
    }
    return best;
  }

  private stepOut(): void {
    const ctx = this.ctx;
    stopMotor(this.state);
    const g = this.sideGround();
    ctx.player.placeWorld(g.x, g.z, ctx.player.yaw);
    this.state.tied = false;
    ctx.audio.splash(0.25);
    ctx.changed();
  }

  /** Start or stop the outboard (R / F, or the button). */
  toggleMotor(on?: boolean): void {
    if (!this.inIt) return;
    const s = this.state;
    const want = on ?? !s.motor;
    if (want && !s.motor) {
      const why = startMotor(s, this.sea());
      if (why) {
        this.ctx.toast(why, 3200);
        return;
      }
      this.ctx.audio.motorStart();
      this.sit('tiller');
    } else if (!want && s.motor) {
      stopMotor(s);
      this.sit('oars');
    }
  }

  private sea() {
    const w = this.ctx.wind();
    return {
      depthAt: (x: number, z: number) => this.ctx.seaHeight(x, z) - this.ctx.floorAt(x, z),
      windX: w.x,
      windZ: w.z,
      condition: this.ctx.condition(),
    };
  }

  /** Bring it back to the stern (dev tools). */
  fetch(): void {
    if (this.inIt) return;
    if (this.state.where === 'davits') return;
    const boat = this.ctx.boat();
    const tp = towPoint(boat, -this.ctx.cat.length * 0.5);
    this.state.x = tp.x - Math.cos(boat.heading) * DINGHY.painter * 0.8;
    this.state.z = tp.z - Math.sin(boat.heading) * DINGHY.painter * 0.8;
    this.state.heading = boat.heading;
    this.state.tied = true;
    this.ctx.changed();
  }

  // ---------- every frame ----------

  /** `drive`: the stick or keys while you're sitting in it (ahead -1..1, steer -1..1). */
  update(dt: number, simDt: number, time: number, drive: { ahead: number; steer: number }, night: number, day: number): { motorLevel: number; stroke: boolean } {
    const ctx = this.ctx;
    const s = this.state;
    const out = { motorLevel: 0, stroke: false };

    // Lowering or hoisting.
    if (this.fallsDir !== 0) {
      this.falls = Math.max(0, Math.min(1, this.falls + (this.fallsDir * dt) / 3.5));
      this.hang();
      if (this.fallsDir > 0 && this.falls >= 1) {
        this.fallsDir = 0;
        // It's afloat: let go of the falls.
        this.model.group.getWorldPosition(tmp);
        const boat = ctx.boat();
        s.where = 'water';
        s.tied = true;
        s.x = tmp.x;
        s.z = tmp.z;
        s.heading = boat.heading - (ctx.cat.points.davitYaw ?? -Math.PI / 2);
        s.speed = 0;
        this.float();
        this.motion.update(time, 1, { x: s.x, z: s.z, heading: s.heading, heel: 0 });
        ctx.audio.splash(0.35);
        if (this.boardWhenDown && ctx.player.mode === 'deck') this.climbIn();
        ctx.changed();
      } else if (this.fallsDir < 0 && this.falls <= 0) {
        this.fallsDir = 0;
        ctx.toast('The dinghy is up in the davits.', 2000);
        ctx.changed();
      }
    }

    if (s.where === 'davits') {
      if (this.fallsDir === 0) this.hang();
      this.wake.update(dt, 0, 0, 0, 0, (x, z) => ctx.seaHeight(x, z), night, day);
      return out;
    }

    const sea = this.sea();
    if (this.inIt) {
      const ev = stepDinghy(s, drive, sea, simDt);
      this.steer = drive.steer;
      if (ev.stroke) {
        out.stroke = true;
        ctx.audio.splash(0.05);
      }
      if (ev.motorStarted) ctx.audio.splash(0.08);
      if (ev.motorUp) {
        ctx.toast('Too shallow: the outboard tilts up so the propeller doesn’t hit the sand. Row from here.', 3500);
        ctx.tip('shallowMotor');
        this.sit('oars');
      }
      if (ev.beached) {
        ctx.audio.thud(0.15);
        ctx.tip('beached');
      }
      if (s.rowing || motorRunning(s)) {
        this.rowed += Math.abs(s.speed) * simDt;
        if (!this.rowedNoted && this.rowed > 15) {
          this.rowedNoted = true;
          ctx.onRowed();
        }
      }
      // The view turns with the dinghy.
      const dh = Math.atan2(Math.sin(s.heading - this.lastHeading), Math.cos(s.heading - this.lastHeading));
      ctx.player.yaw -= dh;
      this.lastHeading = s.heading;
    } else if (s.tied) {
      const boat = ctx.boat();
      towDinghy(s, towPoint(boat, -ctx.cat.length * 0.5), sea, simDt);
    } else {
      idleDinghy(s, sea, simDt);
      // Back aboard with it floating close astern: you make it fast.
      if (ctx.player.aboard) {
        const tp = towPoint(ctx.boat(), -ctx.cat.length * 0.5);
        if (Math.hypot(s.x - tp.x, s.z - tp.z) < 10) {
          s.tied = true;
          ctx.toast('You make the dinghy fast astern.', 2200);
          ctx.changed();
        }
      }
    }

    this.motion.update(time, dt, { x: s.x, z: s.z, heading: s.heading, heel: -this.steer * 0.04 * Math.min(1, Math.abs(s.speed)) });
    const rig = this.model.rig;
    rig.setOars(s.stroke, s.rowing);
    rig.setMotor(motorRunning(s) ? (s.throttle === 0 ? 0.05 : s.throttle) : 0, time);
    rig.setRudder(motorRunning(s) ? -this.steer * 0.5 : 0);
    rig.setDamage(1 - ctx.condition() / 100);
    // A little wake when it's moving.
    const back = DINGHY.length * 0.48;
    this.wake.update(dt, s.x - Math.cos(s.heading) * back, s.z - Math.sin(s.heading) * back, s.heading, Math.abs(s.speed), (x, z) => ctx.seaHeight(x, z), night, day);
    out.motorLevel = motorRunning(s) ? 0.35 + 0.65 * Math.abs(s.throttle) : 0;
    if (!this.inIt) this.steer = 0;
    return out;
  }

  /** Where your eye is relative to the water (for the camera roll): the dinghy's roll. */
  get roll(): number {
    return this.motion.rollAngle;
  }

  /** World position of the dinghy's middle. */
  worldPos(out: THREE.Vector3): THREE.Vector3 {
    return this.model.group.getWorldPosition(out);
  }

  /** Is the player in the water beside it? (for the prompt) */
  playerBeside(): boolean {
    const p = this.ctx.player;
    return (p.mode === 'swim' || p.mode === 'land') && this.near(p.feet.x, p.feet.z);
  }

  /** Line for the dev tools. */
  info(): string {
    const s = this.state;
    const where = s.where === 'davits' ? (this.busy ? 'in the falls' : 'in the davits') : this.inIt ? (motorRunning(s) ? 'motoring' : 'rowing') : s.tied ? 'towed astern' : 'left afloat';
    tmp2.set(s.x, 0, s.z);
    return `${where} · ${Math.round(s.x)}, ${Math.round(s.z)} · ${(Math.abs(s.speed) * 1.944).toFixed(1)} kn${s.aground ? ' · on the sand' : ''}`;
  }
}
