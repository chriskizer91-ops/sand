/**
 * Your boat at anchor: it rides the same waves you see (sampled at bow,
 * stern and both sides), and swings gently on its anchor line as the wind
 * shifts a little.
 */
import type * as THREE from 'three';

export class BoatMotion {
  private y = 0;
  private pitch = 0;
  private roll = 0;
  heading: number;
  /** Current roll, so the view can lean a little with the boat. */
  get rollAngle(): number {
    return this.roll;
  }

  constructor(
    private boat: THREE.Object3D,
    private x: number,
    private z: number,
    private baseHeading: number,
    private length: number,
    private beam: number,
    private sea: (x: number, z: number, t: number) => number,
  ) {
    this.heading = baseHeading;
    boat.position.set(x, 0, z);
  }

  update(t: number, dt: number): void {
    // Swinging at anchor: slow, small changes of heading.
    this.heading = this.baseHeading + 0.12 * Math.sin(t * 0.031) + 0.05 * Math.sin(t * 0.083 + 1.3);
    const ch = Math.cos(this.heading);
    const sh = Math.sin(this.heading);
    const at = (lx: number, lz: number) => this.sea(this.x + lx * ch - lz * sh, this.z + lx * sh + lz * ch, t);
    const half = this.length * 0.38;
    const side = this.beam * 0.42;
    const hb = at(half, 0);
    const hs = at(-half, 0);
    const hp = at(0, side);
    const hst = at(0, -side);
    const k = 1 - Math.exp(-dt * 3.2);
    this.y += ((hb + hs + hp + hst) / 4 - this.y) * k;
    this.pitch += (Math.atan2(hb - hs, half * 2) * 1.2 - this.pitch) * k;
    this.roll += (Math.atan2(hst - hp, side * 2) * 1.1 + 0.022 * Math.sin(t * 0.63) - this.roll) * k;
    this.boat.position.set(this.x, this.y, this.z);
    this.boat.rotation.set(0, 0, 0);
    this.boat.rotateY(-this.heading);
    this.boat.rotateZ(this.pitch);
    this.boat.rotateX(this.roll);
    this.boat.updateMatrixWorld(true);
  }
}
