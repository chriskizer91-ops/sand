/**
 * The land's CPU side: the shared grid patch, the height bounds, the per-frame node selection
 * (coverage without gaps, triangle budgets at many camera poses, stable choices, no cracks between
 * detail levels) and the pond basin fill.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CELL, NP, NX, NZ, ORIGIN_X, ORIGIN_Z, PATCH } from '../src/config';
import { Habitat, type SpeciesDef } from '../src/content/speciesTypes';
import { Columns } from '../src/engine/columns';
import { buildDemoChain } from '../src/engine/fixtures';
import type { LifeInfo, PondInfo } from '../src/engine/protocol';
import { fillBasin, pondTint } from '../src/render/ponds';
import type { Quality } from '../src/render/shared';
import {
  DEEP_Y,
  FALL,
  FrustumCuller,
  GRID_N,
  GRID_X0,
  GRID_Z0,
  LEAF_SIZE,
  MORPH_START,
  OUTER_SIZE,
  ROOT_SIZE,
  SHADOW_TRIANGLES,
  TRIS_PER_NODE,
  TerrainLod,
  buildPatchGeometry,
  finestRange,
  makeNodeList,
  triangleBudget,
  type NodeList,
} from '../src/render/terrain';

// ---------- helpers ----------

function demoSurf(): Float32Array {
  const cols = new Columns();
  buildDemoChain(cols, 1);
  const surf = new Float32Array(NX * NZ);
  const ground = new Uint8Array(NX * NZ * 4);
  cols.packRect(0, 0, NX, NZ, surf, ground);
  return surf;
}

const SURF = demoSurf();

function readyLod(surf = SURF): TerrainLod {
  const lod = new TerrainLod();
  lod.refresh(surf);
  return lod;
}

interface Node {
  x0: number;
  z0: number;
  size: number;
  level: number;
  skirt: number;
}

function nodesOf(list: NodeList): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < list.count; i++) {
    const o = i * 4;
    out.push({ x0: list.nodes[o], z0: list.nodes[o + 1], size: list.nodes[o + 2], level: list.nodes[o + 3], skirt: list.skirts[i] });
  }
  return out;
}

/** An orbit camera placed like the game's (target, distance, yaw, pitch), with its view frustum. */
function orbit(cam: THREE.PerspectiveCamera, tx: number, tz: number, dist: number, yaw: number, pitch: number, culler: FrustumCuller): THREE.Vector3 {
  const ty = Math.max(0, groundAt(tx, tz));
  const cp = Math.cos(pitch);
  cam.position.set(tx + Math.sin(yaw) * cp * dist, ty + Math.sin(pitch) * dist, tz + Math.cos(yaw) * cp * dist);
  cam.position.y = Math.max(cam.position.y, groundAt(cam.position.x, cam.position.z) + 3);
  cam.near = Math.max(0.5, dist * 0.01);
  cam.updateProjectionMatrix();
  cam.lookAt(tx, ty, tz);
  cam.updateMatrixWorld();
  culler.setFromMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  return cam.position;
}

function texel(i: number, k: number): number {
  return SURF[Math.max(0, Math.min(NX - 1, i)) + Math.max(0, Math.min(NZ - 1, k)) * NX];
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The drawn ground (same rule as the shader's tgHeight): bilinear, falling away outside the zone. */
function groundAt(x: number, z: number): number {
  const tx = (x - ORIGIN_X) / CELL - 0.5;
  const tz = (z - ORIGIN_Z) / CELL - 0.5;
  const cx = Math.max(0, Math.min(NX - 1, tx));
  const cz = Math.max(0, Math.min(NZ - 1, tz));
  const i = Math.floor(cx);
  const k = Math.floor(cz);
  const fx = cx - i;
  const fz = cz - k;
  const h = (texel(i, k) * (1 - fx) + texel(i + 1, k) * fx) * (1 - fz) + (texel(i, k + 1) * (1 - fx) + texel(i + 1, k + 1) * fx) * fz;
  const out = Math.hypot(tx - cx, tz - cz) * CELL;
  const f = smoothstep(0, FALL, out);
  return h + (DEEP_Y - h) * f;
}

/** Height on a column centre (the shader's tgGridHeight). */
function gridHeightAt(x: number, z: number): number {
  const tx = (x - ORIGIN_X) / CELL - 0.5;
  const tz = (z - ORIGIN_Z) / CELL - 0.5;
  const h = texel(Math.floor(tx + 0.5), Math.floor(tz + 0.5));
  const out = Math.hypot(tx - Math.max(0, Math.min(NX - 1, tx)), tz - Math.max(0, Math.min(NZ - 1, tz))) * CELL;
  return h + (DEEP_Y - h) * smoothstep(0, FALL, out);
}

/** The shader's geomorph (tgTerrainVertex), replayed on the CPU: where a grid vertex ends up. */
function morphed(x: number, z: number, node: Node, cam: THREE.Vector3, r0: number): [number, number] {
  let spacing = node.size / GRID_N;
  let range = r0 * 2 ** node.level;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(cam.x - x, cam.y - gridHeightAt(x, z), cam.z - z);
    const k = Math.max(0, Math.min(1, (d - range * MORPH_START) / (range * (1 - MORPH_START))));
    const ox = ((Math.floor((x - GRID_X0) / spacing + 0.5) % 2) + 2) % 2;
    const oz = ((Math.floor((z - GRID_Z0) / spacing + 0.5) % 2) + 2) % 2;
    x -= ox * spacing * k;
    z -= oz * spacing * k;
    if (k < 1) break;
    spacing *= 2;
    range *= 2;
  }
  return [x, z];
}

const PHONE: Quality = { setting: 'auto', phone: true, tier: 1, density: 0.8, shadows: true };
const LAPTOP: Quality = { setting: 'auto', phone: false, tier: 2, density: 1.2, shadows: true };

/** Camera poses across the game's range: god view, island views, beach and cliff close-ups, horizon views. */
const POSES: [number, number, number, number, number][] = [];
for (const [tx, tz] of [
  [40, -20],
  [-260, 250],
  [210, 150],
  [-480, 480],
]) {
  for (const dist of [8, 20, 40, 60, 120, 250, 420, 800, 1600]) {
    for (const pitch of [0.12, 0.35, 0.75, 1.3]) {
      for (let yaw = 0; yaw < 6.28; yaw += 0.785) POSES.push([tx, tz, dist, yaw, pitch]);
    }
  }
}

// ---------- tests ----------

describe('terrain patch', () => {
  const { positions, index } = buildPatchGeometry();
  const N = GRID_N;
  const tri = (t: number): THREE.Vector3[] =>
    [0, 1, 2].map((j) => {
      const v = index[t * 3 + j];
      // Skirt vertices (y = 1) hang down: draw them 1 m below for the winding test.
      return new THREE.Vector3(positions[v * 3], -positions[v * 3 + 1], positions[v * 3 + 2]);
    });

  it('has the expected size', () => {
    expect(positions.length / 3).toBe((N + 1) * (N + 1) + 4 * N);
    expect(index.length / 3).toBe(TRIS_PER_NODE);
  });

  it('faces up, and its skirts face outward', () => {
    let up = 0;
    let out = 0;
    for (let t = 0; t < index.length / 3; t++) {
      const [a, b, c] = tri(t);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      if (t < N * N * 2) {
        if (n.y > 0) up++;
      } else {
        // Outward: away from the patch centre.
        const mid = a.clone().add(b).add(c).multiplyScalar(1 / 3);
        if (n.x * (mid.x - 0.5) + n.z * (mid.z - 0.5) > 0 && Math.abs(n.y) < 1e-9) out++;
      }
    }
    expect(up).toBe(N * N * 2);
    expect(out).toBe(4 * N * 2);
  });
});

describe('terrain height bounds', () => {
  it('match a brute-force scan, also after a local change', () => {
    const surf = SURF.slice();
    const lod = readyLod(surf);
    const check = (level: number, ix: number, iz: number): void => {
      const span = GRID_N << level;
      let lo = Infinity;
      let hi = -Infinity;
      for (let z = iz * span; z <= Math.min(NZ - 1, iz * span + span); z++) {
        for (let x = ix * span; x <= Math.min(NX - 1, ix * span + span); x++) {
          lo = Math.min(lo, surf[x + z * NX]);
          hi = Math.max(hi, surf[x + z * NX]);
        }
      }
      const [blo, bhi] = lod.bounds(level, ix, iz);
      expect(blo).toBeCloseTo(lo, 4);
      expect(bhi).toBeCloseTo(hi, 4);
    };
    for (const [level, ix, iz] of [
      [0, 0, 0],
      [0, 8, 7],
      [0, 15, 15],
      [1, 4, 3],
      [2, 1, 2],
      [4, 0, 0],
    ]) check(level, ix, iz);
    // A tall new column on the shared edge of four level-0 nodes (sample 256, 256).
    surf[256 + 256 * NX] = 150;
    lod.markCols(256, 256, 1, 1);
    lod.refresh(surf);
    for (const [ix, iz] of [
      [7, 7],
      [8, 7],
      [7, 8],
      [8, 8],
    ]) {
      check(0, ix, iz);
      expect(lod.bounds(0, ix, iz)[1]).toBe(150);
    }
    check(4, 0, 0);
  });
});

describe('terrain node selection', () => {
  it('covers the zone and its surroundings out to the horizon exactly once, from any camera', () => {
    const lod = readyLod();
    const list = makeNodeList(4096);
    const cells = (3 * ROOT_SIZE + 2 * OUTER_SIZE) / LEAF_SIZE;
    const x0 = GRID_X0 - ROOT_SIZE - OUTER_SIZE;
    const z0 = GRID_Z0 - ROOT_SIZE - OUTER_SIZE;
    for (const cam of [
      [40, 60, -20],
      [40, 8, -20],
      [-500, 30, 500],
      [900, 200, -900],
      [0, 1500, 0],
      [3000, 50, 0],
    ]) {
      lod.select(cam[0], cam[1], cam[2], 120, null, list);
      expect(list.overflow).toBe(false);
      const hits = new Uint8Array(cells * cells);
      for (const n of nodesOf(list)) {
        const s = n.size / LEAF_SIZE;
        const ci = (n.x0 - x0) / LEAF_SIZE;
        const ck = (n.z0 - z0) / LEAF_SIZE;
        expect(Number.isInteger(ci) && Number.isInteger(ck)).toBe(true);
        expect(n.size === OUTER_SIZE || n.size === LEAF_SIZE * 2 ** n.level).toBe(true);
        for (let k = ck; k < ck + s; k++) for (let i = ci; i < ci + s; i++) hits[i + k * cells]++;
      }
      expect(Math.min(...hits)).toBe(1);
      expect(Math.max(...hits)).toBe(1);
    }
  });

  it('gives the finest detail near the camera and coarser far away', () => {
    const lod = readyLod();
    const list = makeNodeList(4096);
    lod.select(40, 30, -20, 120, null, list);
    const nodes = nodesOf(list);
    const under = nodes.find((n) => 40 >= n.x0 && 40 < n.x0 + n.size && -20 >= n.z0 && -20 < n.z0 + n.size);
    expect(under?.level).toBe(0);
    const far = nodes.find((n) => 450 >= n.x0 && 450 < n.x0 + n.size && 450 >= n.z0 && 450 < n.z0 + n.size);
    expect(far?.level).toBeGreaterThanOrEqual(2);
  });

  it('stays within the triangle budget on the phone and the laptop, at every pose', () => {
    const lod = readyLod();
    const list = makeNodeList(4096);
    const culler = new FrustumCuller();
    // Screen heights in device pixels, as the game measures them (CSS height x pixel ratio, at most 2).
    for (const [q, w, h, px] of [
      [PHONE, 412, 915, 915 * 2],
      [{ ...PHONE, tier: 2 }, 412, 915, 915 * 2],
      [LAPTOP, 1280, 760, 760],
      [LAPTOP, 1440, 900, 900 * 2],
    ] as [Quality, number, number, number][]) {
      const cam = new THREE.PerspectiveCamera(50, w / h, 1, 16000);
      const r0 = finestRange(q, px, 50);
      let worst = 0;
      for (const [tx, tz, d, yaw, pitch] of POSES) {
        const p = orbit(cam, tx, tz, d, yaw, pitch, culler);
        lod.select(p.x, p.y, p.z, r0, culler, list);
        worst = Math.max(worst, list.count * TRIS_PER_NODE);
      }
      expect(worst, `${q.phone ? 'phone' : 'laptop'} at ${px} px: worst ${worst} triangles`).toBeLessThanOrEqual(triangleBudget(q));
    }
  });

  it('keeps the sun-shadow selection within its budget, coarsening only as much as needed', () => {
    const lod = readyLod();
    const list = makeNodeList(4096);
    const r0 = finestRange(LAPTOP, 900 * 1.5, 50);
    // The sun's box as daylight sets it: up to 300 m either side of the camera target.
    const sun = new THREE.OrthographicCamera(-300, 300, 300, -300, 1, 2000);
    const culler = new FrustumCuller();
    let worst = 0;
    for (const [tx, tz] of [
      [40, -20],
      [-260, 250],
    ]) {
      for (const d of [40, 120, 420, 900]) {
        const half = Math.min(300, Math.max(40, d * 0.8));
        sun.left = -half;
        sun.right = half;
        sun.top = half;
        sun.bottom = -half;
        sun.updateProjectionMatrix();
        sun.position.set(tx + 0.45 * 800, 0.8 * 800, tz - 0.35 * 800);
        sun.lookAt(tx, 0, tz);
        sun.updateMatrixWorld();
        culler.setFromMatrix(new THREE.Matrix4().multiplyMatrices(sun.projectionMatrix, sun.matrixWorldInverse));
        const used = lod.selectWithin(tx + 0.4 * d, 0.7 * d, tz + 0.5 * d, r0, culler, list, Math.floor(SHADOW_TRIANGLES / TRIS_PER_NODE));
        expect(used).toBeGreaterThan(r0 * 0.3);
        worst = Math.max(worst, list.count * TRIS_PER_NODE);
      }
    }
    expect(worst).toBeLessThanOrEqual(SHADOW_TRIANGLES);
  });

  it('is stable: the same view gives the same nodes, and a small move changes only a few', () => {
    const lod = readyLod();
    const a = makeNodeList(4096);
    const b = makeNodeList(4096);
    lod.select(12.3, 45.6, -78.9, 140, null, a);
    lod.select(12.3, 45.6, -78.9, 140, null, b);
    expect(Array.from(b.nodes.subarray(0, b.count * 4))).toEqual(Array.from(a.nodes.subarray(0, a.count * 4)));
    const key = (n: Node): string => `${n.x0},${n.z0},${n.size}`;
    let maxChanged = 0;
    for (let step = 0; step < 40; step++) {
      lod.select(12.3 + step, 45.6, -78.9, 140, null, a);
      lod.select(12.3 + step + 1, 45.6, -78.9, 140, null, b);
      const sa = new Set(nodesOf(a).map(key));
      const changed = nodesOf(b).filter((n) => !sa.has(key(n))).length;
      maxChanged = Math.max(maxChanged, changed);
    }
    // Moving 1 m can split or merge a node or two (four children each), never reshuffle the view.
    expect(maxChanged).toBeLessThanOrEqual(8);
  });

  it('leaves no cracks: where detail levels meet, both sides put their edge vertices in the same places', () => {
    const lod = readyLod();
    const list = makeNodeList(4096);
    for (const [cx, cy, cz, r0] of [
      [40, 25, -20, 70],
      [40, 120, -20, 100],
      [-260, 12, 250, 60],
      [300, 40, -300, 150],
      [-520, 30, 0, 90],
    ]) {
      const cam = new THREE.Vector3(cx, cy, cz);
      lod.select(cx, cy, cz, r0, null, list);
      const nodes = nodesOf(list);
      let shared = 0;
      for (const a of nodes) {
        for (const b of nodes) {
          if (a.size > b.size || a === b) continue;
          if (b.size === OUTER_SIZE) {
            // The flat floor out to the horizon only meets flat apron ground: both sides lie exactly
            // at the deep floor, so their edges coincide whatever their vertex spacing.
            const sx0 = Math.max(a.x0, b.x0);
            const sx1 = Math.min(a.x0 + a.size, b.x0 + b.size);
            const sz0 = Math.max(a.z0, b.z0);
            const sz1 = Math.min(a.z0 + a.size, b.z0 + b.size);
            if (sx1 < sx0 || sz1 < sz0) continue;
            for (let t = 0; t <= 1; t += 1 / 16) expect(groundAt(sx0 + (sx1 - sx0) * t, sz0 + (sz1 - sz0) * t)).toBe(DEEP_Y);
            continue;
          }
          // a is the finer (or equal) node; look for an edge it shares with b.
          for (const axis of [0, 1]) {
            const aLo = axis === 0 ? a.x0 : a.z0;
            const bLo = axis === 0 ? b.x0 : b.z0;
            let edge: number | null = null;
            if (aLo + a.size === bLo) edge = bLo;
            else if (bLo + b.size === aLo) edge = aLo;
            if (edge === null) continue;
            const aAlong = axis === 0 ? a.z0 : a.x0;
            const bAlong = axis === 0 ? b.z0 : b.x0;
            const s0 = Math.max(aAlong, bAlong);
            const s1 = Math.min(aAlong + a.size, bAlong + b.size);
            if (s1 <= s0) continue;
            shared++;
            const along = (n: Node): Set<string> => {
              const out = new Set<string>();
              const step = n.size / GRID_N;
              for (let s = s0; s <= s1 + 1e-6; s += step) {
                const [mx, mz] = axis === 0 ? morphed(edge as number, s, n, cam, r0) : morphed(s, edge as number, n, cam, r0);
                out.add(`${mx.toFixed(4)},${mz.toFixed(4)}`);
              }
              return out;
            };
            const va = along(a);
            const vb = along(b);
            expect([...va].sort(), `edge at ${edge} between levels ${a.level} and ${b.level}`).toEqual([...vb].sort());
          }
        }
      }
      expect(shared).toBeGreaterThan(0);
    }
  });
});

describe('ponds', () => {
  // A bowl at 20 m with its floor at 10 m, its rim at 20 m, on a slope that falls to 0 m beside it.
  const surf = new Float32Array(NX * NZ).fill(-30);
  const habitat = new Uint8Array(NP * NP);
  const ci = 200;
  const ck = 200;
  for (let k = ck - 20; k <= ck + 20; k++) {
    for (let i = ci - 20; i <= ci + 20; i++) {
      const r = Math.hypot(i - ci, k - ck);
      surf[i + k * NX] = r < 6 ? 10 : r < 8 ? 20 : 20 - (r - 8) * 2;
    }
  }
  const cx = ORIGIN_X + (ci + 0.5) * CELL;
  const cz = ORIGIN_Z + (ck + 0.5) * CELL;
  for (let k = ck - 4; k <= ck + 4; k++) for (let i = ci - 4; i <= ci + 4; i++) habitat[((i / PATCH) | 0) + ((k / PATCH) | 0) * NP] = Habitat.Pond;
  // The reported box is generous: it also covers the low slope outside the rim.
  const pond: PondInfo = { id: 1, level: 15, x0: cx - 30, z0: cz - 30, x1: cx + 30, z1: cz + 30, salt: false };

  it('fills the basin but never the lower ground outside its rim', () => {
    const b = fillBasin(pond, surf, habitat);
    let wetInside = 0;
    let wetOutside = 0;
    for (let k = 0; k < b.h; k++) {
      for (let i = 0; i < b.w; i++) {
        if (!b.data[i + k * b.w]) continue;
        const r = Math.hypot(b.i0 + i - ci, b.k0 + k - ck);
        if (r < 6) wetInside++;
        else wetOutside++;
      }
    }
    expect(wetOutside).toBe(0);
    expect(wetInside).toBeGreaterThan(90);
    expect(b.wet).toBe(wetInside);
  });

  it('finds the basin from the middle of the box before the life map marks it', () => {
    const b = fillBasin(pond, surf, new Uint8Array(NP * NP));
    expect(b.wet).toBeGreaterThan(90);
    expect(b.data[ci - b.i0 + (ck - b.k0) * b.w]).toBe(255);
  });

  it('turns salt ponds pink or red only when the right creatures live on that island', () => {
    const species = [{ effect: 'pink-pond' }, { effect: 'red-pond' }, {}] as unknown as SpeciesDef[];
    const effectOf = (id: number): string | undefined => species[id]?.effect;
    const life = (pops: { species: number; island: number; n: number }[]): LifeInfo => ({
      islands: [
        { id: 1, name: 'A', area: 1, peak: [0, 0, 0], centroid: [0, 0], bbox: [cx - 100, cz - 100, cx + 100, cz + 100], founded: 0, species: 1, forest: 0 },
        { id: 2, name: 'B', area: 1, peak: [0, 0, 0], centroid: [0, 0], bbox: [500, 500, 600, 600], founded: 0, species: 1, forest: 0 },
      ],
      ponds: [pond],
      peaks: [],
      pops,
      colonies: [],
      sound: null,
      found: 0,
      total: 3,
      age: 'stone',
      ending: false,
    });
    const salt = { ...pond, salt: true };
    expect(pondTint(pond, life([{ species: 0, island: 1, n: 0.5 }]), effectOf)).toBe('fresh');
    expect(pondTint(salt, life([]), effectOf)).toBe('salt');
    expect(pondTint(salt, life([{ species: 0, island: 2, n: 0.5 }]), effectOf)).toBe('salt');
    expect(pondTint(salt, life([{ species: 1, island: 1, n: 0.5 }]), effectOf)).toBe('red');
    expect(pondTint(salt, life([{ species: 1, island: 1, n: 0.5 }, { species: 0, island: 1, n: 0.2 }]), effectOf)).toBe('pink');
  });
});
