/**
 * The whole sea you sail: Home Cay (with its reef and lagoon) and Pink Sand
 * Cay, on one shared sea floor. Anything that asks "how high is the ground
 * here?" anywhere at sea asks this.
 */
import type { Terrain } from '../engine/terrain';
import { HomeCayTerrain } from './homeCay';
import type { IslandTerrain, Rect } from './islands';
import { PinkCayTerrain } from './pinkCay';
import { SharkBankTerrain } from './sharkBank';

function inside(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

export class WorldTerrain implements Terrain {
  readonly waterLevel = 0;
  readonly home = new HomeCayTerrain();
  readonly pink: PinkCayTerrain;
  readonly bank: SharkBankTerrain;
  readonly islands: IslandTerrain[];

  constructor() {
    this.pink = new PinkCayTerrain((x, z) => this.home.heightAt(x, z));
    this.bank = new SharkBankTerrain((x, z) => this.home.heightAt(x, z));
    this.islands = [this.home, this.pink, this.bank];
  }

  /** The island whose area this is (or Home Cay, which owns the open sea). */
  islandAt(x: number, z: number): IslandTerrain {
    return inside(this.pink.bounds, x, z) ? this.pink : inside(this.bank.bounds, x, z) ? this.bank : this.home;
  }

  heightAt(x: number, z: number): number {
    return this.islandAt(x, z).heightAt(x, z);
  }

  wetAt(x: number, y: number, z: number, depth: number): number {
    return this.home.wetAt(x, y, z, depth);
  }

  packAt(x: number, y: number, z: number, depth: number): number {
    return this.home.packAt(x, y, z, depth);
  }

  /** The nearest island to x, z and how far its coast is. */
  nearest(x: number, z: number): { island: IslandTerrain; coast: number } {
    let best = this.home as IslandTerrain;
    let d = -this.home.inland(x, z);
    for (const isl of [this.pink, this.bank]) {
      const di = -isl.inland(x, z);
      if (di < d) {
        best = isl;
        d = di;
      }
    }
    return { island: best, coast: d };
  }
}
