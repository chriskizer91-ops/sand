/**
 * The ground of Home Cay outside the editable sand: beaches, grass, ironshore,
 * and the lagoon floor seen through the water. Drawn with the same sand
 * material as the cove (so the two match), tinted for grass, rock, seagrass
 * and reef.
 *
 * The ground is cut into 16 m squares. Squares on land or in the shallows are
 * finely meshed (0.75 m; 0.25 m around the cove's edge, where it meets the
 * editable sand); the lagoon floor is coarser and the deep sea coarser still.
 * Squares are merged into 64 m tiles so the graphics chip gets few draw
 * calls, and each square hangs a short "skirt" so different detail levels
 * never show a crack.
 */
import * as THREE from 'three';
import { PALETTE } from './colors';
import { createSandMaterial, type SandUniforms } from './sandMaterial';
import { Noise2D } from '../engine/noise';
import type { IslandTerrain } from '../world/islands';

const SQUARE = 16;
const TILE_SQUARES = 4;

const color = new THREE.Color();
function rgb(hex: number): [number, number, number] {
  color.setHex(hex);
  return [color.r, color.g, color.b];
}

export interface IslandBounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export function createIslandGround(terrain: IslandTerrain, sandUniforms: SandUniforms, bounds: IslandBounds = terrain.bounds): THREE.Group {
  const group = new THREE.Group();
  const { material } = createSandMaterial(true, sandUniforms);
  const region = terrain.region;
  const noise = new Noise2D(77);
  const grass = rgb(PALETTE.grass);
  const grassDark = rgb(PALETTE.grassDark);
  const rock = rgb(0x8f8a80);
  const rockDark = rgb(0x5f5b55);
  const seagrass = rgb(0x4f6b3a);
  const reefA = rgb(0xb08a5e);
  const reefB = rgb(0x8b6a7a);
  const pink = rgb(0xf6a493);
  const overlap = 0.09;

  const nearRegion = (x0: number, z0: number, x1: number, z1: number, m: number) =>
    x1 > region.x0 - m && x0 < region.x1 + m && z1 > region.z0 - m && z0 < region.z1 + m;
  const insideRegion = (x: number, z: number, m: number) => x > region.x0 + m && x < region.x1 - m && z > region.z0 + m && z < region.z1 - m;

  type Part = { pos: number[]; nrm: number[]; attr: number[]; tint: number[]; idx: number[] };
  const tiles = new Map<string, Part>();
  const standIn: Part = { pos: [], nrm: [], attr: [], tint: [], idx: [] };

  const nsx = Math.ceil((bounds.x1 - bounds.x0) / SQUARE);
  const nsz = Math.ceil((bounds.z1 - bounds.z0) / SQUARE);
  // First pass: how finely to mesh each square, and whether it is all dry land.
  const steps = new Float32Array(nsx * nsz);
  const dry = new Uint8Array(nsx * nsz);
  for (let sz = 0; sz < nsz; sz++) {
    for (let sx = 0; sx < nsx; sx++) {
      const x0 = bounds.x0 + sx * SQUARE;
      const z0 = bounds.z0 + sz * SQUARE;
      let maxH = -Infinity;
      let minH = Infinity;
      for (let j = 0; j <= 6; j++) {
        for (let i = 0; i <= 6; i++) {
          const h = terrain.heightAt(x0 + (i / 6) * SQUARE, z0 + (j / 6) * SQUARE);
          maxH = Math.max(maxH, h);
          minH = Math.min(minH, h);
        }
      }
      // Fine where you walk; coarser under the water (seen through it), coarsest in the deep.
      steps[sx + sz * nsx] = nearRegion(x0, z0, x0 + SQUARE, z0 + SQUARE, 1.5) ? 0.25 : maxH > -0.7 ? 0.8 : maxH > -3.2 ? 2.0 : maxH > -9 ? SQUARE / 6 : 8.0;
      dry[sx + sz * nsx] = minH > 0.35 ? 1 : 0;
    }
  }
  const stepAt = (sx: number, sz: number) => (sx < 0 || sz < 0 || sx >= nsx || sz >= nsz ? -1 : steps[sx + sz * nsx]);

  for (let sz = 0; sz < nsz; sz++) {
    for (let sx = 0; sx < nsx; sx++) {
      const x0 = bounds.x0 + sx * SQUARE;
      const z0 = bounds.z0 + sz * SQUARE;
      const step = steps[sx + sz * nsx];
      const n = Math.round(SQUARE / step);
      const key = `${Math.floor(sx / TILE_SQUARES)},${Math.floor(sz / TILE_SQUARES)},${dry[sx + sz * nsx]}`;
      let tile = tiles.get(key);
      if (!tile) {
        tile = { pos: [], nrm: [], attr: [], tint: [], idx: [] };
        tiles.set(key, tile);
      }
      const t = tile;
      const vertex = (p: Part, x: number, z: number, drop: number) => {
        let h = terrain.heightAt(x, z);
        if (insideRegion(x, z, 0)) h -= 0.015; // tuck under the editable sand
        const e = Math.max(0.05, step * 0.5);
        const hx = terrain.heightAt(x + e, z) - terrain.heightAt(x - e, z);
        const hz = terrain.heightAt(x, z + e) - terrain.heightAt(x, z - e);
        const l = Math.hypot(hx, 2 * e, hz);
        p.pos.push(x, h - drop, z);
        p.nrm.push(-hx / l, (2 * e) / l, -hz / l);
        const wet = h < -0.01 ? 255 : h < 0.12 ? 200 : h < 0.3 ? 120 : 20;
        p.attr.push(wet, 150, 240, 0);
        // Ground colour.
        const kind = terrain.groundAt(x, z, h);
        const nz = noise.fbm(x * 0.4, z * 0.4, 2) * 0.5 + 0.5;
        let c: [number, number, number] = [0, 0, 0];
        let a = 0;
        if (kind === 'grass') {
          c = nz > 0.5 ? grass : grassDark;
          a = 0.92;
        } else if (kind === 'rock') {
          c = nz > 0.45 ? rock : rockDark;
          a = 0.9;
        } else if (kind === 'seagrass') {
          c = seagrass;
          a = 0.75;
        } else if (kind === 'pinksand') {
          // Pink sand: the red-pink of crushed shells mixed through white sand, a touch richer where it's wet.
          c = pink;
          a = 0.55 + 0.1 * nz;
        } else if (kind === 'reef') {
          c = nz > 0.5 ? reefA : reefB;
          a = 0.85;
        }
        p.tint.push(c[0], c[1], c[2], a);
      };
      const touchesRegion = nearRegion(x0, z0, x0 + SQUARE, z0 + SQUARE, 0.2);
      for (const part of touchesRegion ? [t, standIn] : [t]) {
        const base = part.pos.length / 3;
        for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertex(part, x0 + (i / n) * SQUARE, z0 + (j / n) * SQUARE, 0);
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const cx = x0 + ((i + 0.5) / n) * SQUARE;
            const cz = z0 + ((j + 0.5) / n) * SQUARE;
            // The editable sand covers the cove; its stand-in (drawn only from far away) covers just that.
            const inside = insideRegion(cx, cz, overlap);
            if (part === t ? inside : !insideRegion(cx, cz, -0.05)) continue;
            const a = base + i + j * (n + 1);
            const b = a + 1;
            const c = a + n + 1;
            const d = c + 1;
            part.idx.push(a, c, b, b, c, d);
          }
        }
      }
      // Skirts hide cracks where a neighbouring square has a different level of detail.
      const edges: [number, number, number, number, number, number][] = [
        [0, 0, 1, 0, 0, -1],
        [n, 0, 0, 1, 1, 0],
        [n, n, -1, 0, 0, 1],
        [0, n, 0, -1, -1, 0],
      ];
      for (const [si, sj, di, dj, nx, nz] of edges) {
        const other = stepAt(sx + nx, sz + nz);
        if (other === step || other < 0) continue;
        const drop = step >= 2 || other >= 2 ? 1.5 : 0.5;
        const top0 = t.pos.length / 3;
        for (let k = 0; k <= n; k++) vertex(t, x0 + ((si + di * k) / n) * SQUARE, z0 + ((sj + dj * k) / n) * SQUARE, 0);
        const bot0 = t.pos.length / 3;
        for (let k = 0; k <= n; k++) vertex(t, x0 + ((si + di * k) / n) * SQUARE, z0 + ((sj + dj * k) / n) * SQUARE, drop);
        for (let k = 0; k < n; k++) {
          const a = top0 + k;
          const b = top0 + k + 1;
          const c = bot0 + k;
          const d = bot0 + k + 1;
          t.idx.push(a, b, c, b, d, c, a, c, b, b, c, d);
        }
      }
    }
  }

  const build = (t: Part): THREE.Mesh => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(t.nrm, 3));
    g.setAttribute('sandAttr', new THREE.BufferAttribute(new Uint8Array(t.attr), 4, true));
    g.setAttribute('landTint', new THREE.Float32BufferAttribute(t.tint, 4));
    const nv = t.pos.length / 3;
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(t.idx, 1) : new THREE.Uint16BufferAttribute(t.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, material);
    mesh.receiveShadow = true;
    return mesh;
  };
  for (const [key, t] of tiles) {
    if (t.idx.length === 0) continue;
    const mesh = build(t);
    // All-dry tiles are never seen through the water (the water picture skips them).
    if (key.endsWith(',1')) mesh.userData.dry = true;
    group.add(mesh);
  }
  if (standIn.idx.length) {
    const stand = build(standIn);
    stand.name = 'standIn';
    stand.visible = false;
    group.userData.standIn = stand;
    group.add(stand);
  }
  return group;
}
