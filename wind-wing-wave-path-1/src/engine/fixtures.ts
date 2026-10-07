/**
 * Test fixtures (lead-owned): a scripted chain of islands, plus synthetic life data for it.
 *
 * - buildDemoChain() shapes the columns directly (no physics): a tall volcanic island with
 *   a windward sea cliff, a crater pond and beaches; a low white-sand cay on the Shallows;
 *   a small rocky islet. Used by the stub engine, the `demoChain` debug op, screenshots
 *   and tests that need "a finished-looking world".
 * - demoEco()/demoLife() make plausible life data from the shape alone, so renderers and
 *   sound can be built before the real ecology runs. The real game never uses them.
 */
import { CELL, NP, NX, NZ, ORIGIN_X, ORIGIN_Z, PATCH, SEA_LEVEL } from '../config';
import { Habitat, PlantModel, type SpeciesDef } from '../content/speciesTypes';
import { Columns, RockKind } from './columns';
import { fbm2, hash2, smoothstep } from './noise';
import { PLANT_BYTES, type LifeInfo } from './protocol';

/** Flat-ish seabed with a north-south ridge and a sandy bank (a simple stand-in for geo's seabed). */
export function buildPlainSeabed(cols: Columns, seed = 1): void {
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const x = cols.cx(i);
      const z = cols.cz(k);
      let h = -30 + 1.5 * fbm2(x * 0.004, z * 0.004, 3, seed);
      const ridgeX = 40 * Math.sin(z * 0.004) + 20;
      const d = Math.abs(x - ridgeX);
      h = Math.max(h, -7 - 23 * smoothstep(0, 130, d) + 2 * fbm2(x * 0.01, z * 0.01, 2, seed + 7));
      // the Shallows (south-west)
      const sw = Math.hypot(x + 260, z - 250);
      h = Math.max(h, -4.5 - 26 * smoothstep(60, 220, sw));
      const c = i + k * NX;
      cols.rock[c] = h - 1.2;
      cols.sed[c] = 1.2;
      cols.sandKind[c] = 150;
      cols.rockKind[c] = RockKind.Basalt;
      cols.lava[c] = 0;
      cols.temp[c] = 0;
    }
  }
}

interface Island {
  x: number;
  z: number;
  r: number;
  h: number;
  kind: 'volcano' | 'cay' | 'islet';
}

export const DEMO_ISLANDS: Island[] = [
  { x: 40, z: -20, r: 170, h: 110, kind: 'volcano' },
  { x: -260, z: 250, r: 90, h: 6, kind: 'cay' },
  { x: 210, z: 150, r: 35, h: 22, kind: 'islet' },
];

/** Shape the demo chain into the columns (overwrites everything). */
export function buildDemoChain(cols: Columns, seed = 1): void {
  buildPlainSeabed(cols, seed);
  for (let k = 0; k < NZ; k++) {
    for (let i = 0; i < NX; i++) {
      const x = cols.cx(i);
      const z = cols.cz(k);
      const c = i + k * NX;
      let rock = cols.rock[c];
      let sed = cols.sed[c];
      let sandKind = cols.sandKind[c];
      for (const isl of DEMO_ISLANDS) {
        const dx = x - isl.x;
        const dz = z - isl.z;
        const wob = 1 + 0.12 * fbm2(x * 0.02, z * 0.02, 3, seed + 3);
        const d = Math.hypot(dx, dz) / (isl.r * wob);
        if (d > 1.6) continue;
        if (isl.kind === 'volcano') {
          // Cone with a crater, steeper (cliffed) on the windward (east, +x) side.
          let h = isl.h * Math.pow(Math.max(0, 1 - d), 1.35) - 26 * d;
          const crater = Math.hypot(dx + 20, dz - 10);
          h -= 14 * (1 - smoothstep(10, 26, crater)) * smoothstep(0.0, 0.3, 1 - d);
          if (dx > 0 && d > 0.62 && d < 0.95) h = Math.max(h, 18 * smoothstep(0.95, 0.85, d)); // cliff shelf
          h += 3 * fbm2(x * 0.03, z * 0.03, 3, seed + 11);
          if (h > rock) {
            rock = h;
            sed = 0;
          }
          // Beaches on the lee (west) and south.
          if (dx < 0 && d > 0.78 && d < 1.12) {
            const beach = 2.2 * (1 - Math.abs(d - 0.95) / 0.17);
            if (beach > 0) {
              sed = Math.max(sed, beach);
              sandKind = 110;
            }
          }
        } else if (isl.kind === 'cay') {
          const h = isl.h * (1 - smoothstep(0.2, 1.0, d)) - 4.5 * smoothstep(0.8, 1.4, d);
          const top = Math.max(rock + sed, h);
          if (top > rock + sed) {
            sed = top - rock;
            sandKind = 245;
          }
        } else {
          const h = isl.h * Math.pow(Math.max(0, 1 - d), 0.6) - 30 * smoothstep(0.9, 1.5, d);
          if (h > rock + sed) {
            rock = h;
            sed = 0;
          }
        }
      }
      cols.rock[c] = rock;
      cols.sed[c] = sed;
      cols.sandKind[c] = sandKind;
      cols.rockKind[c] = RockKind.Basalt;
    }
  }
}

function speciesWithModel(species: readonly SpeciesDef[], model: number, layer?: string): number {
  const s = species.find((x) => x.plant?.model === model && (!layer || x.layer === layer));
  return s ? s.id : -1;
}

export interface EcoPackOut {
  a: Uint8Array;
  b: Uint8Array;
  c: Uint8Array;
  plants: Uint8Array;
  habitat: Uint8Array;
}

/** Synthetic life for the whole patch grid, from the shape alone (renderer testing only). */
export function demoEco(cols: Columns, species: readonly SpeciesDef[], out: EcoPackOut, seed = 1): void {
  const palm = speciesWithModel(species, PlantModel.Palm);
  const ohia = speciesWithModel(species, PlantModel.PomTree);
  const fig = speciesWithModel(species, PlantModel.Fig);
  const cloud = speciesWithModel(species, PlantModel.CloudTree);
  const treefern = speciesWithModel(species, PlantModel.TreeFern);
  const shrub = speciesWithModel(species, PlantModel.Shrub);
  const seagrape = speciesWithModel(species, PlantModel.SeaGrape);
  const cactus = speciesWithModel(species, PlantModel.Cactus);
  const fern = speciesWithModel(species, PlantModel.Fern);
  const grass = speciesWithModel(species, PlantModel.Grass);
  const vine = speciesWithModel(species, PlantModel.Vine);
  const seagrass = speciesWithModel(species, PlantModel.Seagrass);
  const coral = speciesWithModel(species, PlantModel.Coral);
  const pandanus = speciesWithModel(species, PlantModel.Pandanus);
  const sedge = speciesWithModel(species, PlantModel.Sedge);
  for (let pk = 0; pk < NP; pk++) {
    for (let pi = 0; pi < NP; pi++) {
      const p = pi + pk * NP;
      const c = pi * PATCH + pk * PATCH * NX;
      const h = cols.surf(c);
      const x = ORIGIN_X + (pi + 0.5) * PATCH * CELL;
      const z = ORIGIN_Z + (pk + 0.5) * PATCH * CELL;
      const hx = cols.surf(Math.min(NX - 1, pi * PATCH + 2) + pk * PATCH * NX) - cols.surf(Math.max(0, pi * PATCH - 2) + pk * PATCH * NX);
      const hz = cols.surf(pi * PATCH + Math.min(NZ - 1, pk * PATCH + 2) * NX) - cols.surf(pi * PATCH + Math.max(0, pk * PATCH - 2) * NX);
      const slope = Math.hypot(hx, hz) / (4 * CELL);
      const sand = cols.sed[c] > 0.3;
      const windward = hx < 0 ? 1 : 0; // ground rising toward the west faces the east wind
      const wet = h > 0 ? Math.min(1, 0.35 + 0.5 * windward + h / 150) : 0;
      const n = fbm2(x * 0.03, z * 0.03, 2, seed + 5) * 0.5 + 0.5;
      const o4 = p * 4;
      const op = p * PLANT_BYTES;
      out.a.fill(0, o4, o4 + 4);
      out.b.fill(0, o4, o4 + 4);
      out.c.fill(0, o4, o4 + 4);
      out.plants.fill(0, op, op + PLANT_BYTES);
      let hab: number = h < -12 ? Habitat.DeepSea : h < 0 ? Habitat.OpenSea : Habitat.BareRock;
      const set = (layer: number, sp: number, cover: number) => {
        if (sp < 0) return;
        out.plants[op + layer * 2] = sp + 1;
        out.plants[op + layer * 2 + 1] = Math.round(Math.max(0, Math.min(1, cover)) * 255);
      };
      if (h < 0) {
        if (h > -8 && sand) {
          out.c[o4 + 1] = Math.round(200 * n);
          set(2, seagrass, 0.6 * n);
          hab = Habitat.Seagrass;
        }
        if (h > -10 && !sand && h < -1) {
          out.c[o4] = Math.round(220 * n);
          set(1, coral, 0.7 * n);
          hab = Habitat.Reef;
        }
      } else if (slope > 1.4) {
        hab = Habitat.Cliff;
        out.a[o4] = 150;
        out.b[o4 + 1] = h > 6 && windward ? 180 : 0;
        out.b[o4] = 80;
      } else if (sand && h < 3) {
        hab = Habitat.Beach;
        set(2, vine, 0.5 * n);
        if (h > 1.2) set(0, palm, 0.35 * n);
        out.a[o4 + 2] = Math.round(60 * n);
      } else {
        const lee = 1 - windward;
        out.b[o4] = Math.round(120 + 100 * wet);
        out.b[o4 + 2] = Math.round(255 * wet);
        out.a[o4] = 140;
        out.a[o4 + 1] = Math.round(200 * wet);
        out.a[o4 + 2] = Math.round(200 * (0.3 + 0.7 * n));
        if (h > 85) {
          hab = Habitat.CloudForest;
          set(0, cloud, 0.8);
          set(1, treefern, 0.6);
          set(2, fern, 0.8);
          out.a[o4 + 3] = 220;
        } else if (wet > 0.6) {
          hab = Habitat.WetForest;
          set(0, hash2(pi, pk, 9) < 0.3 ? fig : ohia, 0.75);
          set(1, treefern, 0.5);
          set(2, fern, 0.7);
          out.a[o4 + 3] = 200;
        } else if (lee > 0.5 && h > 8) {
          hab = Habitat.Scrub;
          set(1, hash2(pi, pk, 3) < 0.5 ? cactus : shrub, 0.5 * n);
          set(2, grass, 0.7);
          out.a[o4 + 2] = 230;
        } else {
          hab = Habitat.Grass;
          set(0, hash2(pi, pk, 4) < 0.2 ? pandanus : -1, 0.3);
          set(1, seagrape, 0.4 * n);
          set(2, grass, 0.8);
        }
      }
      out.habitat[p] = hab;
    }
  }
  // A pond in the volcano's crater.
  const v = DEMO_ISLANDS[0];
  for (let pk = 0; pk < NP; pk++) {
    for (let pi = 0; pi < NP; pi++) {
      const x = ORIGIN_X + (pi + 0.5) * PATCH * CELL;
      const z = ORIGIN_Z + (pk + 0.5) * PATCH * CELL;
      const d = Math.hypot(x - (v.x - 20), z - (v.z + 10));
      const p = pi + pk * NP;
      if (d < 16) {
        out.habitat[p] = Habitat.Pond;
        out.c[p * 4 + 3] = 255;
        out.plants.fill(0, p * PLANT_BYTES, p * PLANT_BYTES + 4);
        out.plants[p * PLANT_BYTES + 4] = d > 11 && sedge >= 0 ? sedge + 1 : 0;
        out.plants[p * PLANT_BYTES + 5] = d > 11 ? 200 : 0;
      }
    }
  }
}

/** Synthetic life info for the demo chain. */
export function demoLife(cols: Columns, species: readonly SpeciesDef[]): LifeInfo {
  const v = DEMO_ISLANDS[0];
  const pondLevel = cols.heightAt(v.x - 20, v.z + 10) + 2;
  const islands = DEMO_ISLANDS.map((isl, id) => ({
    id: id + 1,
    name: ['High Island', 'White Cay', 'Booby Rock'][id],
    area: Math.PI * isl.r * isl.r,
    peak: [isl.x, cols.heightAt(isl.x, isl.z), isl.z] as [number, number, number],
    centroid: [isl.x, isl.z] as [number, number],
    bbox: [isl.x - isl.r, isl.z - isl.r, isl.x + isl.r, isl.z + isl.r] as [number, number, number, number],
    founded: id * 300,
    species: 30 - id * 8,
    forest: id === 0 ? 0.6 : 0.1,
  }));
  const pops = species.filter((s) => s.kind === 'animal').map((s) => ({ species: s.id, island: 1, n: 0.6 }));
  return {
    islands,
    ponds: [{ id: 1, level: pondLevel, x0: v.x - 38, z0: v.z - 8, x1: v.x - 2, z1: v.z + 28, salt: false }],
    peaks: islands.map((i) => ({ x: i.peak[0], z: i.peak[2], h: i.peak[1], cap: i.peak[1] > 60 })),
    pops,
    colonies: [{ species: species.find((s) => s.animal?.behaviour === 'colony')?.id ?? 0, x: v.x + 120, z: v.z, r: 40, n: 0.8 }],
    sound: null,
    found: species.length,
    total: species.length,
    age: 'forest',
    ending: false,
  };
}

/** World x/z of patch centre. */
export function patchCentre(pi: number, pk: number): [number, number] {
  return [ORIGIN_X + (pi + 0.5) * PATCH * CELL, ORIGIN_Z + (pk + 0.5) * PATCH * CELL];
}

export const DEMO_SEA_LEVEL = SEA_LEVEL;
