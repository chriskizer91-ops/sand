/**
 * You, seen from your own eyes: walking the deck of the rocking boat, wading,
 * swimming, walking the island, and climbing the stern ladder.
 *
 * Aboard, your position is kept relative to the boat, so you ride its motion.
 * Ashore and in the water it is in world coordinates.
 */
import * as THREE from 'three';
import { PLAYER } from '../config';
import type { Trunk } from '../render/islandLife';

/**
 * The boat's walkable surfaces, in boat-local metres. A boat can have several
 * levels (a catamaran's hull cabins, saloon and flybridge): `y` is the height
 * of your feet, so each question is asked at your own level. A one-level boat
 * can ignore it.
 */
export interface Deck {
  /** Standing height at lx, lz for feet at y: the highest surface no higher than a stair step above y; null if there's nothing to stand on. */
  heightAt(lx: number, lz: number, y?: number): number | null;
  /** A wall or solid fitting in the way at your level. */
  blocked(lx: number, lz: number, r: number, y?: number): boolean;
  /** Inside the rails (false = over the side). */
  insideLifelines(lx: number, lz: number, y?: number): boolean;
  /** Overall half-width at lx (at deck level or the waterline). */
  halfBeam(lx: number, atDeck: boolean): number;
  /** For swimmers: how far lx, lz is inside the boat's footprint (plus a little room); 0 when clear. */
  footprintPen?(lx: number, lz: number): number;
  /** The ceiling above feet at y (null in the open air). */
  ceilingAt?(lx: number, lz: number, y: number): number | null;
}

export interface BoatRef {
  obj: THREE.Object3D;
  deck: Deck;
  /** Boat-local points. */
  ladderTop: THREE.Vector3;
  ladderBottom: THREE.Vector3;
  length: number;
}

export interface PlayerWorld {
  groundAt(x: number, z: number): number;
  waterAt(x: number, z: number): number;
  trunks: Trunk[];
  boat: BoatRef;
  /** Keep within this distance of (cx, cz). */
  bounds: { cx: number; cz: number; r: number };
}

export type PlayerMode = 'deck' | 'land' | 'swim' | 'climb';
export type StepSurface = 'deck' | 'sand' | 'water' | 'shallows';

export interface PlayerEvents {
  steps: StepSurface[];
  splash: number;
  climbed: 'up' | 'down' | null;
  tooFar: boolean;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

export class Player {
  /** 1 normally; less when you're hungry or thirsty (see game/aboard.ts). */
  vigour = 1;
  mode: PlayerMode = 'deck';
  /** Aboard: boat-local feet position. Otherwise: world feet position. */
  pos = new THREE.Vector3();
  yaw = 0;
  pitch = -0.1;
  private vy = 0;
  private airborne = false;
  private bobPhase = 0;
  private bob = 0;
  private stride = 0;
  private launch: { x: number; z: number } | null = null;
  private climb: { t: number; dir: 'up' | 'down'; from: THREE.Vector3; to: THREE.Vector3 } | null = null;
  /** World position of the eye, updated each frame. */
  readonly eye = new THREE.Vector3();
  /** World position of the feet, updated each frame. */
  readonly feet = new THREE.Vector3();
  speed = 0;
  /** How deep the water is at your feet (0 on land or aboard). */
  waterDepth = 0;

  constructor(private world: PlayerWorld) {}

  /** Start aboard at a boat-local spot, facing the given world yaw. */
  placeAboard(local: THREE.Vector3, yaw: number): void {
    this.mode = 'deck';
    this.pos.copy(local);
    // The spot's own height says which level it's on.
    const h = this.world.boat.deck.heightAt(local.x, local.z, local.y);
    if (h !== null) this.pos.y = h;
    this.yaw = yaw;
    this.vy = 0;
    this.climb = null;
    this.refresh();
  }

  /** Put the player at a world spot (ashore or swimming). */
  placeWorld(x: number, z: number, yaw: number): void {
    this.pos.set(x, this.world.groundAt(x, z), z);
    this.yaw = yaw;
    this.vy = 0;
    this.climb = null;
    this.mode = 'land';
    this.settleWater();
    this.refresh();
  }

  get aboard(): boolean {
    return this.mode === 'deck' || (this.mode === 'climb' && this.climb?.dir === 'up' && this.climb.t > 0.5);
  }

  /** In the water near the foot of the ladder? */
  nearLadder(): boolean {
    if (this.mode !== 'swim') return false;
    this.world.boat.obj.localToWorld(tmp.copy(this.world.boat.ladderBottom));
    return Math.hypot(tmp.x - this.pos.x, tmp.z - this.pos.z) < 1.3;
  }

  /** Aboard, standing by the top of the swim ladder? */
  atLadderTop(): boolean {
    if (this.mode !== 'deck') return false;
    const lt = this.world.boat.ladderTop;
    return Math.hypot(this.pos.x - lt.x, this.pos.z - lt.z) < 0.9;
  }

  /** Climb down the stern ladder into the water. */
  climbDown(): boolean {
    if (!this.atLadderTop()) return false;
    this.startClimbDown();
    return true;
  }

  /** Climb the stern ladder (up from the water). */
  climbAboard(): boolean {
    if (!this.nearLadder()) return false;
    const b = this.world.boat;
    const from = b.obj.worldToLocal(tmp.copy(this.pos)).clone();
    this.climb = { t: 0, dir: 'up', from, to: b.ladderTop.clone() };
    this.mode = 'climb';
    return true;
  }

  look(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.max(-1.45, Math.min(1.35, this.pitch + dPitch));
  }

  update(dt: number, move: { x: number; y: number }, run: boolean, jump: boolean): PlayerEvents {
    const ev: PlayerEvents = { steps: [], splash: 0, climbed: null, tooFar: false };
    const w = this.world;
    // Desired movement in world space.
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const rz = -Math.sin(this.yaw);
    let vx = fx * move.y + rx * move.x;
    let vz = fz * move.y + rz * move.x;
    const amount = Math.min(1, Math.hypot(move.x, move.y));

    if (this.mode === 'climb' && this.climb) {
      const c = this.climb;
      c.t += dt / 1.3;
      if (c.t >= 1) {
        if (c.dir === 'up') {
          this.mode = 'deck';
          this.pos.copy(c.to);
          const h = w.boat.deck.heightAt(c.to.x, c.to.z, c.to.y);
          if (h !== null) this.pos.y = h;
          ev.climbed = 'up';
        } else {
          w.boat.obj.localToWorld(this.pos.copy(c.to));
          this.mode = 'swim';
          this.settleWater();
          ev.climbed = 'down';
          ev.splash = 0.4;
        }
        this.climb = null;
      } else {
        // Up the ladder: rise first, then step forward onto the deck.
        const k = c.t;
        const up = c.dir === 'up' ? Math.min(1, k / 0.7) : 1 - Math.min(1, (1 - k) / 0.7);
        const across = c.dir === 'up' ? Math.max(0, (k - 0.6) / 0.4) : Math.min(1, k / 0.4);
        tmp.set(c.from.x + (c.to.x - c.from.x) * across, c.from.y + (c.to.y - c.from.y) * up, c.from.z + (c.to.z - c.from.z) * across);
        this.pos.copy(tmp);
        // Climbing frames are boat-local; convert for the eye.
        this.refresh(true);
        return ev;
      }
    }

    // Hungry or thirsty, you're slower and can't run.
    if (this.vigour < 1) run = false;
    if (this.mode === 'deck') {
      const speed = (run ? PLAYER.run * 0.75 : PLAYER.walk * 0.85) * amount * this.vigour;
      this.speed = speed;
      const deck = w.boat.deck;
      // Convert the world move to boat-local with the boat's turn.
      const q = w.boat.obj.getWorldQuaternion(tmpQ).invert();
      tmp.set(vx, 0, vz).applyQuaternion(q);
      tmp.y = 0;
      if (tmp.lengthSq() > 0) tmp.normalize().multiplyScalar(speed * dt);
      const tryMove = (dx: number, dz: number): boolean => {
        const nx = this.pos.x + dx;
        const nz = this.pos.z + dz;
        const y = this.pos.y;
        const h = deck.heightAt(nx, nz, y);
        const high = this.airborne && y - (deck.heightAt(this.pos.x, this.pos.z, y) ?? y) > 0.4;
        const outside = h === null || !deck.insideLifelines(nx, nz, y);
        if (outside) {
          // The gap in the lifelines is at the ladder: step through it and climb down.
          const lt = w.boat.ladderTop;
          if (Math.hypot(nx - lt.x, nz - lt.z) < 0.75 && !this.airborne) {
            this.startClimbDown();
            return true;
          }
          // Already standing outside the lifelines (on the edge of the deck)? Step off into the sea.
          const onEdge = !deck.insideLifelines(this.pos.x, this.pos.z, y);
          if (h === null && (high || onEdge)) {
            this.leaveBoat(nx, nz, ev);
            return true;
          }
          // Anywhere else, only by jumping clear of the lifelines.
          if (!high) return false;
        }
        if (h === null) return false;
        if (deck.blocked(nx, nz, PLAYER.radius * 0.8, y)) return false;
        if (!this.airborne && h - y > PLAYER.step) return false;
        this.pos.x = nx;
        this.pos.z = nz;
        return true;
      };
      if (tmp.lengthSq() > 0 && !tryMove(tmp.x, tmp.z)) {
        if (!tryMove(tmp.x, 0)) tryMove(0, tmp.z);
      }
      if (this.mode !== 'deck') {
        this.refresh();
        return ev;
      }
      const floor = deck.heightAt(this.pos.x, this.pos.z, this.pos.y) ?? this.pos.y;
      this.verticalStep(dt, floor, jump, deck.ceilingAt?.(this.pos.x, this.pos.z, floor) ?? null);
      this.walkBob(dt, speed, ev, 'deck');
      this.refresh();
      return ev;
    }

    // ---- ashore or in the water (world coordinates) ----
    const ground = w.groundAt(this.pos.x, this.pos.z);
    const water = w.waterAt(this.pos.x, this.pos.z);
    this.waterDepth = Math.max(0, water - ground);
    let speed: number;
    if (this.mode === 'swim') speed = (run ? PLAYER.swimFast : PLAYER.swim) * amount;
    else {
      speed = (run ? PLAYER.run : PLAYER.walk) * amount;
      if (this.waterDepth > PLAYER.wadeDepth) speed *= 0.55;
      else if (this.waterDepth > 0.08) speed *= 0.8;
    }
    speed *= this.vigour;
    this.speed = speed;
    const l = Math.hypot(vx, vz);
    if (l > 0) {
      vx = (vx / l) * speed * dt;
      vz = (vz / l) * speed * dt;
    }
    const canGo = (nx: number, nz: number): boolean => {
      const gNew = w.groundAt(nx, nz);
      if (this.mode !== 'swim' && !this.airborne && gNew - this.pos.y > PLAYER.step) return false;
      if (this.mode === 'swim' && gNew - (water - 0.2) > PLAYER.step) return false;
      for (const t of w.trunks) {
        if (Math.abs(t.x - nx) < 1 && Math.abs(t.z - nz) < 1 && Math.hypot(t.x - nx, t.z - nz) < t.r + PLAYER.radius) return false;
      }
      // The hull is solid, but moving away from it is always allowed.
      const penNew = this.hullPen(nx, nz);
      if (penNew > 0 && !this.airborne && penNew >= this.hullPen(this.pos.x, this.pos.z) - 1e-4) return false;
      return true;
    };
    // Flying off the boat: keep going out over the water, clear of the hull.
    if (this.launch && this.airborne) {
      this.pos.x += this.launch.x * dt;
      this.pos.z += this.launch.z * dt;
    }
    if (!this.airborne) this.launch = null;
    if (l > 0) {
      const nx = this.pos.x + vx;
      const nz = this.pos.z + vz;
      if (canGo(nx, nz)) {
        this.pos.x = nx;
        this.pos.z = nz;
      } else if (canGo(this.pos.x + vx, this.pos.z)) this.pos.x += vx;
      else if (canGo(this.pos.x, this.pos.z + vz)) this.pos.z += vz;
    }
    if (!this.airborne) this.pushOutOfHull(dt);
    // Stay within reach of home.
    const b = w.bounds;
    const dx = this.pos.x - b.cx;
    const dz = this.pos.z - b.cz;
    const d = Math.hypot(dx, dz);
    if (d > b.r) {
      this.pos.x = b.cx + (dx / d) * b.r;
      this.pos.z = b.cz + (dz / d) * b.r;
      ev.tooFar = true;
    }

    const g2 = w.groundAt(this.pos.x, this.pos.z);
    const wat2 = w.waterAt(this.pos.x, this.pos.z);
    const depth = wat2 - g2;
    this.waterDepth = Math.max(0, depth);
    if (this.mode === 'land') {
      if (depth > PLAYER.swimDepth && !this.airborne) {
        this.mode = 'swim';
        ev.splash = 0.25;
      } else {
        this.verticalStep(dt, g2, jump);
        this.walkBob(dt, speed, ev, depth > 0.05 ? 'shallows' : 'sand');
      }
    }
    if (this.mode === 'swim') {
      if (depth < PLAYER.swimDepth - 0.15) {
        this.mode = 'land';
        this.pos.y = g2;
        this.vy = 0;
      } else {
        // Float with the head just above the waves.
        const target = wat2 + PLAYER.swimEye - PLAYER.eye;
        if (this.airborne) {
          this.vy -= PLAYER.gravity * dt;
          this.pos.y += this.vy * dt;
          if (this.pos.y <= target) {
            ev.splash = Math.max(ev.splash, Math.min(1, -this.vy / 6));
            this.airborne = false;
            this.vy = 0;
          }
        } else this.pos.y += (target - this.pos.y) * (1 - Math.exp(-dt * 6));
        this.stride += speed * dt;
        if (this.stride > 1.4) {
          this.stride = 0;
          ev.steps.push('water');
        }
        this.bob = 0;
      }
    }
    this.refresh();
    return ev;
  }

  private verticalStep(dt: number, floor: number, jump: boolean, ceiling: number | null = null): void {
    if (jump && !this.airborne) {
      this.vy = PLAYER.jump;
      this.airborne = true;
    }
    if (this.airborne || this.pos.y > floor + 0.02) {
      this.vy -= PLAYER.gravity * dt;
      this.pos.y += this.vy * dt;
      this.airborne = true;
      // Indoors you bump your head on the ceiling rather than jumping through it.
      if (ceiling !== null && this.pos.y + PLAYER.eye + 0.15 > ceiling) {
        this.pos.y = Math.max(floor, ceiling - PLAYER.eye - 0.15);
        this.vy = Math.min(0, this.vy);
      }
      if (this.pos.y <= floor) {
        this.pos.y = floor;
        this.vy = 0;
        this.airborne = false;
      }
    } else {
      // Walking down slopes and steps: follow the floor smoothly.
      this.pos.y += (floor - this.pos.y) * (1 - Math.exp(-dt * 18));
      if (Math.abs(this.pos.y - floor) < 0.002) this.pos.y = floor;
    }
  }

  private walkBob(dt: number, speed: number, ev: PlayerEvents, surface: StepSurface): void {
    if (speed > 0.2 && !this.airborne) {
      this.bobPhase += dt * (5.2 + speed * 1.6);
      this.bob = Math.sin(this.bobPhase) * 0.028 * Math.min(1, speed / 2);
      this.stride += speed * dt;
      const strideLen = speed > 2.5 ? 1.3 : 0.75;
      if (this.stride > strideLen) {
        this.stride = 0;
        ev.steps.push(surface);
      }
    } else {
      this.bob *= Math.exp(-dt * 8);
    }
  }

  /** How far x, z is inside the hull's footprint (plus a little room), in metres; 0 when clear. */
  private hullPen(x: number, z: number): number {
    const b = this.world.boat;
    b.obj.worldToLocal(tmp2.set(x, 0, z));
    return this.localPen(tmp2.x, tmp2.z);
  }

  private localPen(lx: number, lz: number): number {
    const d = this.world.boat.deck;
    if (d.footprintPen) return d.footprintPen(lx, lz);
    const hb = d.halfBeam(lx, true);
    if (hb <= 0) return 0;
    return Math.max(0, hb + 0.3 - Math.abs(lz));
  }

  /** If you're pressed into the hull, ease you out the shortest way (so you can never get stuck against it). */
  private pushOutOfHull(dt: number): void {
    const pen = this.hullPen(this.pos.x, this.pos.z);
    if (pen <= 0) return;
    const b = this.world.boat;
    b.obj.worldToLocal(tmp2.set(this.pos.x, 0, this.pos.z));
    // Whichever way (out to the side, or off the bow or stern) clears it soonest.
    const step = Math.min(pen, Math.max(0.02, 2.5 * dt));
    let best = { dx: 0, dz: tmp2.z >= 0 ? step : -step, pen: Infinity };
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const p = this.localPen(tmp2.x + dx * 0.6, tmp2.z + dz * 0.6);
      if (p < best.pen) best = { dx: dx * step, dz: dz * step, pen: p };
    }
    tmp2.x += best.dx;
    tmp2.z += best.dz;
    tmp2.y = 0;
    b.obj.localToWorld(tmp2);
    this.pos.x = tmp2.x;
    this.pos.z = tmp2.z;
  }

  private startClimbDown(): void {
    const b = this.world.boat;
    this.climb = { t: 0, dir: 'down', from: this.pos.clone(), to: b.ladderBottom.clone() };
    this.mode = 'climb';
  }

  private leaveBoat(lx: number, lz: number, ev: PlayerEvents): void {
    const b = this.world.boat;
    // Which way is "away from the boat" here? Out to the side, or off the bow or stern.
    const hb = b.deck.halfBeam(lx, true);
    const outLocal = hb > 0.3 ? new THREE.Vector3(0, 0, lz >= 0 ? 1 : -1) : new THREE.Vector3(lx >= 0 ? 1 : -1, 0, 0);
    tmp.set(lx, this.pos.y, lz);
    b.obj.localToWorld(tmp);
    this.pos.copy(tmp);
    const q = b.obj.getWorldQuaternion(tmpQ);
    outLocal.applyQuaternion(q);
    outLocal.y = 0;
    outLocal.normalize().multiplyScalar(2.2);
    this.launch = { x: outLocal.x, z: outLocal.z };
    this.mode = 'swim';
    this.airborne = true;
    this.vy = Math.max(this.vy, 1.5);
    ev.splash = 0.2;
  }

  /** After being placed in the water, float at the surface. */
  private settleWater(): void {
    const w = this.world;
    const g = w.groundAt(this.pos.x, this.pos.z);
    const water = w.waterAt(this.pos.x, this.pos.z);
    if (water - g > PLAYER.swimDepth) {
      this.mode = 'swim';
      this.pos.y = water + PLAYER.swimEye - PLAYER.eye;
    } else {
      this.mode = 'land';
      this.pos.y = g;
    }
  }

  /** Recompute the world feet and eye positions. */
  refresh(climbing = false): void {
    const b = this.world.boat;
    if (this.mode === 'deck' || climbing) {
      this.feet.copy(this.pos);
      b.obj.localToWorld(this.feet);
      // The eye rides the boat, so you feel it rock.
      tmp.copy(this.pos);
      tmp.y += PLAYER.eye + this.bob;
      b.obj.localToWorld(this.eye.copy(tmp));
    } else {
      this.feet.copy(this.pos);
      this.eye.copy(this.pos);
      this.eye.y += PLAYER.eye + this.bob;
    }
  }

  applyCamera(cam: THREE.Camera, boatRoll = 0): void {
    cam.position.copy(this.eye);
    cam.rotation.order = 'YXZ';
    // The view leans with the boat, but less and less as she heels hard (you keep your head up).
    cam.rotation.set(this.pitch, this.yaw, this.mode === 'deck' ? (boatRoll * 0.6) / (1 + Math.abs(boatRoll) * 1.2) : 0);
  }

  /** For saving. */
  get state(): { mode: PlayerMode; pos: number[]; yaw: number; pitch: number } {
    const mode = this.mode === 'climb' ? (this.aboard ? 'deck' : 'swim') : this.mode;
    if (mode === 'deck' && this.mode === 'climb' && this.climb) return { mode, pos: this.climb.to.toArray(), yaw: this.yaw, pitch: this.pitch };
    if (mode === 'swim' && this.mode === 'climb') return { mode, pos: this.feet.toArray(), yaw: this.yaw, pitch: this.pitch };
    return { mode, pos: this.pos.toArray(), yaw: this.yaw, pitch: this.pitch };
  }
}
