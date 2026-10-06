/**
 * The orbit camera (WP-H): target on the ground, distance, yaw, pitch; pitch follows zoom;
 * sight-line lift; slow eased glides. STUB (lead): basic orbit. WP-H replaces the body; keep the API.
 */
import * as THREE from 'three';
import { NX, CELL, ORIGIN_X, ORIGIN_Z } from '../config';
import type { CamState } from '../render/shared';

export const CAM_MIN_DIST = 8;
export const CAM_MAX_DIST = 1600;

export class OrbitCamera implements CamState {
  target = new THREE.Vector3(0, 0, 0);
  dist = 420;
  yaw = -0.6;
  pitch = 0.75;
  private glide: { from: number[]; to: number[]; t: number; dur: number } | null = null;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private ground: (x: number, z: number) => number,
  ) {}

  /** Move the target by a world-space offset. */
  pan(dx: number, dz: number): void {
    this.glide = null;
    const lim = (NX * CELL) / 2 + 200;
    this.target.x = Math.max(ORIGIN_X - 200, Math.min(ORIGIN_X + 2 * lim, this.target.x + dx));
    this.target.z = Math.max(ORIGIN_Z - 200, Math.min(ORIGIN_Z + 2 * lim, this.target.z + dz));
  }
  rotate(dYaw: number): void {
    this.glide = null;
    this.yaw += dYaw;
  }
  tilt(dPitch: number): void {
    this.glide = null;
    this.pitch = Math.max(0.12, Math.min(1.45, this.pitch + dPitch));
  }
  zoom(factor: number): void {
    this.glide = null;
    this.dist = Math.max(CAM_MIN_DIST, Math.min(CAM_MAX_DIST, this.dist * factor));
  }
  glideTo(x: number, z: number, dist = this.dist, seconds = 2.5): void {
    this.glide = { from: [this.target.x, this.target.z, this.dist], to: [x, z, dist], t: 0, dur: seconds };
  }
  home(): void {
    this.glideTo(0, 0, 900);
  }
  get gliding(): boolean {
    return !!this.glide;
  }
  get state(): number[] {
    return [this.target.x, this.target.y, this.target.z, this.dist, this.yaw, this.pitch];
  }
  set state(s: number[]) {
    if (s.length < 6) return;
    this.target.set(s[0], s[1], s[2]);
    this.dist = s[3];
    this.yaw = s[4];
    this.pitch = s[5];
  }

  update(dt: number): void {
    if (this.glide) {
      const g = this.glide;
      g.t += dt;
      const k = Math.min(1, g.t / g.dur);
      const e = k * k * (3 - 2 * k);
      this.target.x = g.from[0] + (g.to[0] - g.from[0]) * e;
      this.target.z = g.from[1] + (g.to[1] - g.from[1]) * e;
      this.dist = g.from[2] + (g.to[2] - g.from[2]) * e;
      if (k >= 1) this.glide = null;
    }
    this.target.y = Math.max(0, this.ground(this.target.x, this.target.z));
    const cp = Math.cos(this.pitch);
    const pos = new THREE.Vector3(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    const g = this.ground(pos.x, pos.z);
    if (pos.y < g + 3) pos.y = g + 3;
    this.camera.position.copy(pos);
    this.camera.near = Math.max(0.5, this.dist * 0.01);
    this.camera.far = 16000;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(this.target);
  }
}
