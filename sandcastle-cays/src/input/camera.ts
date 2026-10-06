/**
 * Orbit camera: it circles a target point on the sand. Every move is smoothed
 * so the view glides rather than jumps.
 */
import * as THREE from 'three';

export interface CameraLimits {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class OrbitCamera {
  /** Smoothed (current) and goal values. */
  yaw = 0.18;
  pitch = 0.4;
  dist = 7.5;
  target = new THREE.Vector3(0, 0.25, -0.4);
  private goalYaw = 0.18;
  private goalPitch = 0.4;
  private goalDist = 7.5;
  private goalTarget = new THREE.Vector3(0, 0.25, -0.4);

  minDist = 0.45;
  maxDist = 22;
  minPitch = 0.08;
  maxPitch = 1.45;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private limits: CameraLimits,
    private groundAt: (x: number, z: number) => number,
  ) {}

  /** Swing around the target (radians). */
  orbit(dYaw: number, dPitch: number): void {
    this.goalYaw += dYaw;
    this.goalPitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.goalPitch + dPitch));
  }

  /** Zoom by a factor (<1 = closer), pulling toward a point on the sand if given. */
  zoom(factor: number, toward?: THREE.Vector3): void {
    const before = this.goalDist;
    this.goalDist = Math.min(this.maxDist, Math.max(this.minDist, this.goalDist * factor));
    const actual = this.goalDist / before;
    if (toward && actual !== 1) {
      // Keep the point under the fingers in place while zooming.
      this.goalTarget.lerp(toward, 1 - actual);
      this.clampTarget();
    }
  }

  /** Slide the target across the beach, relative to the view (metres). */
  pan(right: number, forward: number): void {
    const s = Math.sin(this.goalYaw);
    const c = Math.cos(this.goalYaw);
    this.goalTarget.x += right * c - forward * s;
    this.goalTarget.z += -right * s - forward * c;
    this.clampTarget();
  }

  /** Glide to look at a point. */
  glideTo(p: THREE.Vector3): void {
    this.goalTarget.copy(p);
    this.clampTarget();
  }

  /** Reset to a view of the whole cove. */
  home(): void {
    this.goalTarget.set(0, 0.25, -0.4);
    this.goalYaw = 0.18;
    this.goalPitch = 0.4;
    this.goalDist = 7.5;
  }

  get state(): number[] {
    return [this.goalYaw, this.goalPitch, this.goalDist, this.goalTarget.x, this.goalTarget.y, this.goalTarget.z];
  }

  setState(s: number[]): void {
    if (s.length < 6 || s.some((v) => !Number.isFinite(v))) return;
    [this.goalYaw, this.goalPitch, this.goalDist] = s;
    this.goalTarget.set(s[3], s[4], s[5]);
    this.goalPitch = Math.min(this.maxPitch, Math.max(this.minPitch, this.goalPitch));
    this.goalDist = Math.min(this.maxDist, Math.max(this.minDist, this.goalDist));
    this.clampTarget();
    this.snap();
  }

  snap(): void {
    this.yaw = this.goalYaw;
    this.pitch = this.goalPitch;
    this.dist = this.goalDist;
    this.target.copy(this.goalTarget);
    this.apply();
  }

  private clampTarget(): void {
    const t = this.goalTarget;
    t.x = Math.min(this.limits.maxX, Math.max(this.limits.minX, t.x));
    t.z = Math.min(this.limits.maxZ, Math.max(this.limits.minZ, t.z));
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 10);
    this.yaw += (this.goalYaw - this.yaw) * k;
    this.pitch += (this.goalPitch - this.pitch) * k;
    this.dist += (this.goalDist - this.dist) * k;
    // The target rides on the sand surface (gently).
    const ground = Math.max(this.groundAt(this.goalTarget.x, this.goalTarget.z), -0.6);
    this.goalTarget.y += (ground + 0.05 - this.goalTarget.y) * (1 - Math.exp(-dt * 3));
    this.target.lerp(this.goalTarget, k);
    this.apply();
  }

  private apply(): void {
    const cp = Math.cos(this.pitch);
    const pos = new THREE.Vector3(
      this.target.x + this.dist * cp * Math.sin(this.yaw),
      this.target.y + this.dist * Math.sin(this.pitch),
      this.target.z + this.dist * cp * Math.cos(this.yaw),
    );
    // Never go under the sand or the sea.
    const floor = Math.max(this.groundAt(pos.x, pos.z), 0) + 0.12;
    if (pos.y < floor) pos.y = floor;
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }
}
