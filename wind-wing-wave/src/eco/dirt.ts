/**
 * Which part of the life grid changed since the page was last sent it.
 *
 * The contract with the engine hub (ARCHITECTURE §5.3) is one rectangle: takeDirty() hands
 * over everything changed since the last take and forgets it, and the hub's own stream cuts it
 * into tiles and sends them within its budget. To keep that rectangle small, the life
 * simulation only marks a patch when the bytes it packs for the page would really change
 * (succession.ts keeps a fingerprint of them), never because something invisible moved.
 */
import { NP } from '../config';

export type PatchRect = [number, number, number, number];

export class Dirt {
  private x0 = NP;
  private z0 = NP;
  private x1 = -1;
  private z1 = -1;

  /** Note a changed patch rectangle (inclusive; clamped to the grid). */
  mark(i0: number, k0: number, i1: number, k1: number): void {
    if (i0 < 0) i0 = 0;
    if (k0 < 0) k0 = 0;
    if (i1 > NP - 1) i1 = NP - 1;
    if (k1 > NP - 1) k1 = NP - 1;
    if (i1 < i0 || k1 < k0) return;
    if (i0 < this.x0) this.x0 = i0;
    if (k0 < this.z0) this.z0 = k0;
    if (i1 > this.x1) this.x1 = i1;
    if (k1 > this.z1) this.z1 = k1;
  }

  /** Note one changed patch. */
  markPatch(pi: number, pk: number): void {
    if (pi < this.x0) this.x0 = pi;
    if (pk < this.z0) this.z0 = pk;
    if (pi > this.x1) this.x1 = pi;
    if (pk > this.z1) this.z1 = pk;
  }

  /** Everything changed and not yet taken, as one rectangle (or null). */
  bounds(): PatchRect | null {
    return this.x1 < this.x0 ? null : [this.x0, this.z0, this.x1, this.z1];
  }

  /** Hand over everything changed since the last take, and forget it. */
  take(): PatchRect | null {
    const r = this.bounds();
    this.clear();
    return r;
  }

  clear(): void {
    this.x0 = NP;
    this.z0 = NP;
    this.x1 = -1;
    this.z1 = -1;
  }
}
