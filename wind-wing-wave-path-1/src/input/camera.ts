/**
 * The orbit camera: it looks at a target point on the ground from a distance, a compass
 * heading (yaw) and a tilt (pitch). See docs/ARCHITECTURE.md §6.9.
 *
 * - Distance runs from 8 m (eye level with a crab) to 1,600 m (the whole zone). Zoom is
 *   exponential and pulls toward the point under the fingers or pointer.
 * - The tilt follows the zoom, like a maps app: nearly top-down from far away (a map of your
 *   islands), low and cinematic close in. The player can add their own tilt on top.
 * - Gestures move "goal" values; the drawn camera follows them a little behind, so every move
 *   is soft. Glides (tap a card, right-click, home) are slow eased arcs that rise a little
 *   when they travel far, like a bird hopping between islands.
 * - A sight-line lift keeps the camera above any hill between it and the target, so the land
 *   never hides what you are looking at, and the camera never dips under the sea.
 * - Near and far clip planes scale with distance, so close-ups stay crisp and the god view
 *   keeps its depth precision.
 * - Gentle bounds: the target can wander a little past the zone edge and eases back.
 * - Watch mode: drift() moves the camera slowly toward where life is happening and circles it.
 */
import * as THREE from 'three';
import { CELL, NX, NZ, ORIGIN_X, ORIGIN_Z, SEA_LEVEL } from '../config';
import type { CamState } from '../render/shared';

export const CAM_MIN_DIST = 8;
export const CAM_MAX_DIST = 1600;
/** Pitch (radians above the horizon) with no player tilt, at the nearest and farthest zoom. */
const PITCH_NEAR = 0.3;
const PITCH_FAR = 1.18;
const PITCH_MIN = 0.06;
const PITCH_MAX = 1.45;
/** Field of view (degrees): a little wider close in, which makes close-ups feel intimate. */
const FOV_NEAR = 56;
const FOV_FAR = 46;
/** The zone, and how far past its edge the target may go (soft: eases back; hard: never). */
const ZX0 = ORIGIN_X;
const ZZ0 = ORIGIN_Z;
const ZX1 = ORIGIN_X + NX * CELL;
const ZZ1 = ORIGIN_Z + NZ * CELL;
const SOFT_MARGIN = 60;
const HARD_MARGIN = 320;
/** How quickly the drawn camera catches up with gestures (per second). */
const FOLLOW_RATE = 14;
/** Sight-line samples between the target and the camera. */
const SIGHT_SAMPLES = 24;
/** Ground this close to the target (m, across the ground) never lifts the camera. */
const SIGHT_SKIP = 3;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 0 at the nearest zoom .. 1 at the farthest, eased, measured on a log scale of distance. */
export function zoomLevel(dist: number): number {
  const t = clamp((Math.log(dist) - Math.log(CAM_MIN_DIST)) / (Math.log(CAM_MAX_DIST) - Math.log(CAM_MIN_DIST)), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The tilt the camera takes at a distance when the player hasn't tilted it themselves. */
export function autoPitch(dist: number): number {
  return PITCH_NEAR + (PITCH_FAR - PITCH_NEAR) * zoomLevel(dist);
}

/** Near clip plane: a small fraction of the distance (never so small that depth precision suffers). */
export function nearFor(dist: number): number {
  return clamp(dist * 0.012, 0.15, 12);
}

/** Far clip plane: never under 16 km, so the sky and the horizon sea are never clipped. */
export function farFor(dist: number): number {
  return 16000 + dist * 4;
}

interface Glide {
  x0: number;
  z0: number;
  d0: number;
  x1: number;
  z1: number;
  d1: number;
  tilt0: number;
  tilt1: number;
  /** How much the glide rises in the middle (0 = straight). */
  lift: number;
  t: number;
  dur: number;
}

/** Somewhere to aim the camera in watch mode. */
export interface DriftFocus {
  x: number;
  z: number;
  /** How far to frame it from (m). */
  dist: number;
}

export class OrbitCamera implements CamState {
  // What is drawn (systems read these).
  readonly target = new THREE.Vector3(40, 0, -20);
  dist = 420;
  yaw = -0.6;
  pitch = 0.75;

  // What gestures change.
  private goal = new THREE.Vector3(40, 0, -20);
  private goalDist = 420;
  private goalYaw = -0.6;
  /** The player's own tilt on top of the automatic one (radians). */
  private tilt = 0;
  private goalTilt = 0;

  private glide: Glide | null = null;
  private lift = 0;
  private targetYReady = false;
  /** Counts player camera moves (pan, zoom, turn, tilt), for the "two fingers to move" hint. */
  userMoves = 0;

  private readonly pos = new THREE.Vector3();
  private readonly ray = new THREE.Vector3();

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly ground: (x: number, z: number) => number,
  ) {
    this.state = [40, 0, -20, 420, -0.6, 0.75];
  }

  // ---------- player moves ----------

  /** Slide the target over the ground by a world-space offset (m). */
  panWorld(dx: number, dz: number): void {
    this.glide = null;
    this.goal.x = clamp(this.goal.x + dx, ZX0 - HARD_MARGIN, ZX1 + HARD_MARGIN);
    this.goal.z = clamp(this.goal.z + dz, ZZ0 - HARD_MARGIN, ZZ1 + HARD_MARGIN);
    this.userMoves++;
  }

  /** Slide relative to the view: right and forward in metres. */
  panView(right: number, forward: number): void {
    const s = Math.sin(this.goalYaw);
    const c = Math.cos(this.goalYaw);
    this.panWorld(right * c - forward * s, -right * s - forward * c);
  }

  /** Zoom by a factor (< 1 = closer), pulling toward a ground point if given. */
  zoomAt(factor: number, toward: { x: number; z: number } | null = null): void {
    this.glide = null;
    const before = this.goalDist;
    this.goalDist = clamp(before * factor, CAM_MIN_DIST, CAM_MAX_DIST);
    const kept = this.goalDist / before;
    if (toward && kept !== 1) {
      // Keep the point under the fingers where it is while the distance changes.
      this.goal.x = clamp(this.goal.x + (toward.x - this.goal.x) * (1 - kept), ZX0 - HARD_MARGIN, ZX1 + HARD_MARGIN);
      this.goal.z = clamp(this.goal.z + (toward.z - this.goal.z) * (1 - kept), ZZ0 - HARD_MARGIN, ZZ1 + HARD_MARGIN);
    }
    this.userMoves++;
  }

  /** Turn around the target (radians; positive turns the world clockwise on screen). */
  rotate(dYaw: number): void {
    this.glide = null;
    this.goalYaw += dYaw;
    this.userMoves++;
  }

  /** Tilt (radians; positive looks more steeply down). */
  tiltBy(dPitch: number): void {
    this.glide = null;
    const auto = autoPitch(this.goalDist);
    this.goalTilt = clamp(this.goalTilt + dPitch, PITCH_MIN - auto, PITCH_MAX - auto);
    this.userMoves++;
  }

  // ---------- glides ----------

  /**
   * Glide slowly to look at (x, z) from `dist` metres. Long glides take longer and rise a
   * little in the middle. `level` also eases the player's own tilt away.
   */
  glideTo(x: number, z: number, dist = this.goalDist, seconds?: number, level = false): void {
    const d1 = clamp(dist, CAM_MIN_DIST, CAM_MAX_DIST);
    const x1 = clamp(x, ZX0 - SOFT_MARGIN, ZX1 + SOFT_MARGIN);
    const z1 = clamp(z, ZZ0 - SOFT_MARGIN, ZZ1 + SOFT_MARGIN);
    const travel = Math.hypot(x1 - this.target.x, z1 - this.target.z);
    const span = Math.max(this.dist, d1);
    const zoomChange = Math.abs(Math.log(d1 / this.dist));
    this.glide = {
      x0: this.target.x,
      z0: this.target.z,
      d0: this.dist,
      x1,
      z1,
      d1,
      tilt0: this.tilt,
      tilt1: level ? 0 : this.tilt,
      lift: clamp(travel / (2.5 * span) - 0.15, 0, 1.2) * 0.7,
      t: 0,
      dur: seconds ?? clamp(2.0 + travel / 450 + zoomChange * 0.45, 2.0, 5.0),
    };
  }

  /** Glide so a world rectangle (x0, z0, x1, z1) fills the view. */
  frameBox(x0: number, z0: number, x1: number, z1: number, seconds?: number): void {
    const w = Math.max(40, x1 - x0);
    const h = Math.max(40, z1 - z0);
    const half = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const aspect = Math.max(0.3, this.camera.aspect || 1);
    const dist = (0.75 * Math.max(w / aspect, h)) / Math.tan(half);
    this.glideTo((x0 + x1) / 2, (z0 + z1) / 2, clamp(dist, 140, CAM_MAX_DIST), seconds, true);
  }

  get gliding(): boolean {
    return this.glide !== null;
  }

  /**
   * Watch mode: ease toward `focus` and circle it slowly. Called every frame while watching.
   * Movement is capped at a walking-bird pace so it never feels like a cut.
   */
  drift(dt: number, focus: DriftFocus): void {
    this.glide = null;
    const dx = focus.x - this.goal.x;
    const dz = focus.z - this.goal.z;
    const len = Math.hypot(dx, dz);
    if (len > 0.01) {
      const step = Math.min(len * (1 - Math.exp(-dt / 9)), 7 * dt);
      this.goal.x += (dx / len) * step;
      this.goal.z += (dz / len) * step;
    }
    const kd = 1 - Math.exp(-dt / 10);
    this.goalDist = Math.exp(Math.log(this.goalDist) + (Math.log(clamp(focus.dist, CAM_MIN_DIST, CAM_MAX_DIST)) - Math.log(this.goalDist)) * kd);
    this.goalYaw += 0.035 * dt;
    this.goalTilt *= Math.exp(-dt / 6);
  }

  // ---------- state ----------

  /** [targetX, targetY, targetZ, distance, yaw, pitch]: for saves and the screenshot tools. */
  get state(): number[] {
    return [this.goal.x, this.goal.y, this.goal.z, this.goalDist, this.goalYaw, clamp(autoPitch(this.goalDist) + this.goalTilt, PITCH_MIN, PITCH_MAX)];
  }

  /** Jump straight to a saved view (no glide). Ignores broken values. */
  set state(s: number[]) {
    if (s.length < 6 || s.some((v) => !Number.isFinite(v))) return;
    this.glide = null;
    this.goal.set(clamp(s[0], ZX0 - HARD_MARGIN, ZX1 + HARD_MARGIN), s[1], clamp(s[2], ZZ0 - HARD_MARGIN, ZZ1 + HARD_MARGIN));
    this.goalDist = clamp(s[3], CAM_MIN_DIST, CAM_MAX_DIST);
    this.goalYaw = s[4];
    this.goalTilt = clamp(s[5], PITCH_MIN, PITCH_MAX) - autoPitch(this.goalDist);
    this.snap();
  }

  /** Make the drawn camera match the goals at once. */
  snap(): void {
    this.target.x = this.goal.x;
    this.target.z = this.goal.z;
    this.dist = this.goalDist;
    this.yaw = this.goalYaw;
    this.tilt = this.goalTilt;
    this.targetYReady = false;
    this.lift = 0;
    this.apply(0);
  }

  // ---------- picking helpers ----------

  /**
   * Where a screen point (normalised -1..1) meets the flat plane at height `y`. Used for
   * panning, so the ground under the fingers follows them exactly. Returns false for rays
   * that miss (above the horizon) or land absurdly far away.
   */
  planePoint(ndcX: number, ndcY: number, y: number, out: { x: number; z: number }): boolean {
    const c = this.camera;
    this.ray.set(ndcX, ndcY, 0.5).unproject(c).sub(c.position).normalize();
    if (this.ray.y > -0.02) return false;
    const t = (y - c.position.y) / this.ray.y;
    if (t < 0 || t > this.dist * 12 + 2000) return false;
    out.x = c.position.x + this.ray.x * t;
    out.z = c.position.z + this.ray.z * t;
    return true;
  }

  // ---------- per frame ----------

  update(dt: number): void {
    const g = this.glide;
    if (g) {
      g.t += dt;
      const k = Math.min(1, g.t / g.dur);
      const e = k * k * k * (k * (k * 6 - 15) + 10); // smootherstep: no jolt at either end
      this.goal.x = g.x0 + (g.x1 - g.x0) * e;
      this.goal.z = g.z0 + (g.z1 - g.z0) * e;
      this.goalDist = Math.exp(Math.log(g.d0) + (Math.log(g.d1) - Math.log(g.d0)) * e) * (1 + g.lift * Math.sin(Math.PI * e));
      this.goalTilt = g.tilt0 + (g.tilt1 - g.tilt0) * e;
      this.target.x = this.goal.x;
      this.target.z = this.goal.z;
      this.dist = this.goalDist;
      this.tilt = this.goalTilt;
      this.yaw = this.goalYaw;
      if (k >= 1) this.glide = null;
    } else {
      // Gentle bounds: a target past the zone edge eases back.
      const kb = 1 - Math.exp(-dt * 2.5);
      const bx = clamp(this.goal.x, ZX0 - SOFT_MARGIN, ZX1 + SOFT_MARGIN);
      const bz = clamp(this.goal.z, ZZ0 - SOFT_MARGIN, ZZ1 + SOFT_MARGIN);
      this.goal.x += (bx - this.goal.x) * kb;
      this.goal.z += (bz - this.goal.z) * kb;
      const k = 1 - Math.exp(-dt * FOLLOW_RATE);
      this.target.x += (this.goal.x - this.target.x) * k;
      this.target.z += (this.goal.z - this.target.z) * k;
      this.dist = Math.exp(Math.log(this.dist) + (Math.log(this.goalDist) - Math.log(this.dist)) * k);
      this.yaw += (this.goalYaw - this.yaw) * k;
      this.tilt += (this.goalTilt - this.tilt) * k;
    }
    this.apply(dt);
  }

  /** Place the three.js camera from the drawn values. No allocations. */
  private apply(dt: number): void {
    const t = this.target;
    // The target rides on the ground (or the sea), easing over cliffs instead of jumping.
    const gy = Math.max(this.ground(t.x, t.z), SEA_LEVEL);
    if (!this.targetYReady || dt <= 0) {
      t.y = gy;
      this.targetYReady = true;
    } else t.y += (gy - t.y) * (1 - Math.exp(-dt * 5));
    this.goal.y = t.y;

    this.pitch = clamp(autoPitch(this.dist) + this.tilt, PITCH_MIN, PITCH_MAX);
    const cp = Math.cos(this.pitch);
    const p = this.pos.set(t.x + Math.sin(this.yaw) * cp * this.dist, t.y + Math.sin(this.pitch) * this.dist, t.z + Math.cos(this.yaw) * cp * this.dist);

    // Sight-line lift: the lowest camera height from which the ground between the camera and
    // the target stays under the line of sight. The clearance grows from nothing at the target
    // (which sits on the ground by definition) to `margin` at the camera, so over flat ground a
    // close-up keeps its low, cinematic angle, while a hill in between still lifts the view.
    // Samples right next to the target are skipped: there the ground is the target's own
    // ground, and the target's eased height can lag it for a moment.
    const margin = 0.6 + this.dist * 0.01;
    const reach = Math.hypot(p.x - t.x, p.z - t.z);
    let need = Math.max(this.ground(p.x, p.z), SEA_LEVEL) + 1.2 + this.dist * 0.02;
    for (let i = 1; i <= SIGHT_SAMPLES; i++) {
      const s = i / (SIGHT_SAMPLES + 1);
      if (s * reach < SIGHT_SKIP) continue;
      const gx = t.x + (p.x - t.x) * s;
      const gz = t.z + (p.z - t.z) * s;
      const req = t.y + (Math.max(this.ground(gx, gz), SEA_LEVEL) - t.y) / s + margin;
      if (req > need) need = req;
    }
    const want = Math.max(0, need - p.y);
    // Rise at once (never look through a hill), settle back down slowly.
    this.lift = want >= this.lift || dt <= 0 ? want : this.lift + (want - this.lift) * (1 - Math.exp(-dt * 2));
    p.y += this.lift;

    const c = this.camera;
    c.position.copy(p);
    c.lookAt(t);
    c.near = nearFor(this.dist);
    c.far = farFor(this.dist);
    c.fov = FOV_NEAR + (FOV_FAR - FOV_NEAR) * zoomLevel(this.dist);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }
}
