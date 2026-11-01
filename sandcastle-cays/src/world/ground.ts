/**
 * "How high is the ground here?" for anything that walks, stands or rests on
 * it: the editable sand (kept up to date from the sand engine, so you stand on
 * top of your castles), the rest of the island, and rocks.
 */
import type { Terrain } from '../engine/terrain';
import { rockTop, type RockBlob } from '../render/scenery';

export class GroundMap {
  /** Top sand height on the editable beach, at 2-cell (6 cm) resolution. */
  regionHeights: Float32Array | null = null;
  regionW = 0;
  regionH = 0;
  regionCell = 0.06;
  regionX = 0;
  regionZ = 0;
  rocks: RockBlob[] = [];

  constructor(private terrain: Terrain) {}

  /** Set up the height map of the editable beach (when the engine is ready). */
  setRegion(w: number, h: number, cell: number, originX: number, originZ: number): void {
    this.regionW = w;
    this.regionH = h;
    this.regionCell = cell;
    this.regionX = originX;
    this.regionZ = originZ;
    if (!this.regionHeights || this.regionHeights.length !== w * h) {
      this.regionHeights = new Float32Array(w * h);
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          this.regionHeights[x + z * w] = this.terrain.heightAt(originX + (x + 0.5) * cell, originZ + (z + 0.5) * cell);
        }
      }
    }
  }

  /** Update part of the map after the sand changed. */
  patch(hx: number, hz: number, span: number, heights: Float32Array): void {
    if (!this.regionHeights) return;
    for (let z = 0; z < span; z++) {
      for (let x = 0; x < span; x++) {
        const gx = hx + x;
        const gz = hz + z;
        if (gx >= this.regionW || gz >= this.regionH) continue;
        this.regionHeights[gx + gz * this.regionW] = heights[x + z * span];
      }
    }
  }

  /** True if x, z is on the editable sand. */
  inRegion(x: number, z: number): boolean {
    if (!this.regionHeights) return false;
    const gx = (x - this.regionX) / this.regionCell;
    const gz = (z - this.regionZ) / this.regionCell;
    return gx >= 0 && gz >= 0 && gx < this.regionW && gz < this.regionH;
  }

  /** Sand or ground height only (no rocks). */
  sandAt(x: number, z: number): number {
    if (this.regionHeights) {
      const gx = Math.floor((x - this.regionX) / this.regionCell);
      const gz = Math.floor((z - this.regionZ) / this.regionCell);
      if (gx >= 0 && gz >= 0 && gx < this.regionW && gz < this.regionH) return this.regionHeights[gx + gz * this.regionW];
    }
    return this.terrain.heightAt(x, z);
  }

  /** The top of whatever is underfoot: sand, ground or rock. */
  heightAt(x: number, z: number): number {
    return Math.max(this.sandAt(x, z), rockTop(this.rocks, x, z));
  }
}
