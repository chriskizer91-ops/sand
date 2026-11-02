/**
 * Plants and rocks across Home Cay (the cove keeps its own, from scenery.ts):
 * coconut palms along the top of the beaches leaning toward the sea, sea-grape
 * and buttonwood scrub inland, grass at the edges, boulders on the ironshore
 * and coral heads in the lagoon. Merged into 32 m patches, so the graphics
 * chip skips the ones out of view.
 *
 * Also returns what you can bump into: palm trunks and rocks.
 */
import * as THREE from 'three';
import { boulder, bush, grassTuft, mergeWithSway, palm, paint, rgb, swayMaterial, type RockBlob } from './scenery';
import { mergeGeometries } from './sky';
import { mulberry32 } from '../engine/noise';
import type { IslandTerrain } from '../world/islands';

export interface Trunk {
  x: number;
  z: number;
  r: number;
}

const PATCH = 32;

function patchKey(x: number, z: number): string {
  return `${Math.floor(x / PATCH)},${Math.floor(z / PATCH)}`;
}

export function createIslandLife(
  terrain: IslandTerrain,
  time: { value: number },
): { group: THREE.Group; trunks: Trunk[]; rocks: RockBlob[] } {
  const rand = mulberry32(terrain.id === 'home' ? 1311 : 2207);
  const B = terrain.bounds;
  const L = terrain.land;
  const region = terrain.region;
  const group = new THREE.Group();
  const plants = new Map<string, THREE.BufferGeometry[]>();
  const stones = new Map<string, THREE.BufferGeometry[]>();
  const trunks: Trunk[] = [];
  const rocks: RockBlob[] = [];
  const add = (map: Map<string, THREE.BufferGeometry[]>, x: number, z: number, g: THREE.BufferGeometry) => {
    const k = patchKey(x, z);
    let list = map.get(k);
    if (!list) map.set(k, (list = []));
    list.push(g);
  };
  // The cove already has its own plants and rocks.
  const nearCove = (x: number, z: number, m: number) => x > region.x0 - m && x < region.x1 + m && z > region.z0 - m && z < region.z1 + 9;

  // ---- palms along the top of the beaches, leaning toward the water ----
  const line = terrain.tideline(1.0);
  let next = 0;
  for (let i = 0; i < line.length; i++) {
    if (i < next) continue;
    next = i + 5 + Math.floor(rand() * 7);
    const p = line[i];
    const back = 3.5 + rand() * 5;
    const x = p.x - p.nx * back + (rand() - 0.5) * 2;
    const z = p.z - p.nz * back + (rand() - 0.5) * 2;
    if (nearCove(x, z, 3)) continue;
    if (terrain.groundAt(x, z) === 'rock') continue;
    const h = 4.5 + rand() * 3;
    const g = palm(h, 0.2 + rand() * 0.3, rand);
    // Lean toward the sea.
    g.rotateY(-Math.atan2(p.nz, p.nx) + (rand() - 0.5) * 0.8);
    g.translate(x, terrain.heightAt(x, z) - 0.05, z);
    add(plants, x, z, g);
    trunks.push({ x, z, r: 0.2 });
    // Sometimes a second palm close by.
    if (rand() < 0.35) {
      const x2 = x + (rand() - 0.5) * 3;
      const z2 = z + (rand() - 0.5) * 3;
      const g2 = palm(h * (0.7 + rand() * 0.3), 0.3 + rand() * 0.3, rand);
      g2.rotateY(rand() * Math.PI * 2);
      g2.translate(x2, terrain.heightAt(x2, z2) - 0.05, z2);
      add(plants, x2, z2, g2);
      trunks.push({ x: x2, z: z2, r: 0.2 });
    }
  }

  // ---- scrub inland: sea grape near the beach, denser bushes further in ----
  for (let n = 0; n < 2600 && trunks.length < 400; n++) {
    const x = L.x0 + rand() * (L.x1 - L.x0);
    const z = L.z0 + rand() * (L.z1 - L.z0);
    const s = terrain.inland(x, z);
    if (s < 6 || nearCove(x, z, 2)) continue;
    const kind = terrain.groundAt(x, z);
    if (kind === 'rock' && rand() < 0.8) continue;
    const dense = Math.min(1, (s - 6) / 14);
    if (rand() > 0.07 + 0.1 * dense) continue;
    const size = 0.5 + rand() * (0.6 + dense * 0.9);
    const g = bush(rand, size);
    g.translate(x, terrain.heightAt(x, z) - 0.1, z);
    add(plants, x, z, g);
    // A few palms scattered inland too.
    if (rand() < 0.06) {
      const h = 5 + rand() * 3;
      const gp = palm(h, 0.12 + rand() * 0.2, rand);
      gp.rotateY(rand() * Math.PI * 2);
      const px = x + 1.5;
      gp.translate(px, terrain.heightAt(px, z) - 0.05, z);
      add(plants, px, z, gp);
      trunks.push({ x: px, z, r: 0.2 });
    }
  }
  // Beach grass along the edge of the vegetation.
  for (let n = 0; n < 1600; n++) {
    const p = line[Math.floor(rand() * line.length)];
    if (!p) break;
    const back = 4 + rand() * 6;
    const x = p.x - p.nx * back + (rand() - 0.5) * 1.5;
    const z = p.z - p.nz * back + (rand() - 0.5) * 1.5;
    if (nearCove(x, z, 2) || terrain.groundAt(x, z) === 'rock') continue;
    if (rand() > 0.25) continue;
    const g = grassTuft(rand);
    g.translate(x, terrain.heightAt(x, z) - 0.02, z);
    add(plants, x, z, g);
  }

  // ---- boulders on the ironshore ----
  for (let n = 0; n < 4000 && rocks.length < 70; n++) {
    const x = L.x0 + rand() * (L.x1 - L.x0);
    const z = L.z0 + rand() * (L.z1 - L.z0);
    if (nearCove(x, z, 0.5)) continue;
    const s = terrain.inland(x, z);
    if (s < -4 || s > 9) continue;
    if (terrain.rockiness(x, z) < 0.6 || rand() > 0.12) continue;
    const size = 0.4 + rand() * 1.3;
    const g = boulder(rand, size, size > 1 ? 2 : 1);
    g.rotateY(rand() * Math.PI * 2);
    const y = terrain.heightAt(x, z) + size * 0.05;
    g.translate(x, y, z);
    add(stones, x, z, g);
    rocks.push({ x, y, z, rx: size * 0.95, ry: size * 0.6, rz: size * 0.95 });
  }
  // ---- coral heads in the lagoon (you see them through the water) ----
  const coralCols = [rgb(0xc49a6c), rgb(0x9b7a8f), rgb(0xb7a26a), rgb(0x8f9c6c)];
  for (let n = 0; n < 3000 && rocks.length < 130; n++) {
    const x = B.x0 + 40 + rand() * (B.x1 - B.x0 - 80);
    const z = B.z0 + 40 + rand() * (B.z1 - B.z0 - 80);
    const h = terrain.heightAt(x, z);
    if (h > -1.8 || h < -6) continue;
    if (Math.hypot(x - terrain.anchorage.x, z - terrain.anchorage.z) < 16) continue; // keep the anchorage clear
    if (rand() > 0.03) continue;
    const size = 0.4 + rand() * 1.1;
    const g = boulder(rand, size, 1);
    const col = coralCols[Math.floor(rand() * coralCols.length)];
    paint(g, (_x, y) => {
      const k = 0.75 + 0.25 * Math.min(1, Math.max(0, y / size + 0.5));
      return [col[0] * k, col[1] * k, col[2] * k];
    });
    g.translate(x, h + size * 0.25, z);
    add(stones, x, z, g);
    rocks.push({ x, y: h + size * 0.25, z, rx: size * 0.95, ry: size * 0.6, rz: size * 0.95 });
  }

  const swayMat = swayMaterial(time);
  for (const parts of plants.values()) {
    const mesh = new THREE.Mesh(mergeWithSway(parts), swayMat);
    mesh.userData.dry = true; // plants are never seen through the water
    mesh.geometry.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  for (const parts of stones.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), rockMat);
    mesh.geometry.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, trunks, rocks };
}
