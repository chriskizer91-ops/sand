/**
 * Puts your boat where the sailing says it is, riding the same waves you see
 * (sampled at bow, stern and both sides), and leaning with the wind (heel).
 */
import type * as THREE from 'three';

export interface BoatPose {
  x: number;
  z: number;
  heading: number;
  /** Lean from the wind (radians, + = starboard side down). */
  heel: number;
}

export class BoatMotion {
  private y = 0;
  private pitch = 0;
  private roll = 0;
  heading = 0;
  /** Current roll (waves and heel), so the view can lean a little with the boat. */
  get rollAngle(): number {
    return this.roll;
  }

  constructor(
    private boat: THREE.Object3D,
    private length: number,
    private beam: number,
    private sea: (x: number, z: number, t: number) => number,
    /** How much of the wind's lean she shows (a catamaran hardly leans). */
    private heelScale = 1,
  ) {}

  update(t: number, dt: number, pose: BoatPose): void {
    this.heading = pose.heading;
    const ch = Math.cos(pose.heading);
    const sh = Math.sin(pose.heading);
    const at = (lx: number, lz: number) => this.sea(pose.x + lx * ch - lz * sh, pose.z + lx * sh + lz * ch, t);
    const half = this.length * 0.38;
    const side = this.beam * 0.42;
    const hb = at(half, 0);
    const hs = at(-half, 0);
    const hp = at(0, side);
    const hst = at(0, -side);
    const k = 1 - Math.exp(-dt * 3.2);
    this.y += ((hb + hs + hp + hst) / 4 - this.y) * k;
    this.pitch += (Math.atan2(hb - hs, half * 2) * 1.2 - this.pitch) * k;
    const waveRoll = Math.atan2(hst - hp, side * 2) * 1.1 + 0.022 * Math.sin(t * 0.63);
    this.roll += (waveRoll + pose.heel * this.heelScale - this.roll) * k;
    this.boat.position.set(pose.x, this.y, pose.z);
    this.boat.rotation.set(0, 0, 0);
    this.boat.rotateY(-pose.heading);
    this.boat.rotateZ(this.pitch);
    this.boat.rotateX(this.roll);
    this.boat.updateMatrixWorld(true);
  }
}
