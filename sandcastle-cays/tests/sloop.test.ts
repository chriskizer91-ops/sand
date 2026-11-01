// Checks for the sloop model (src/render/sloop.ts): it builds within the phone budget, and the
// walkable-deck description matches the surfaces you can see.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSloop } from '../src/render/sloop';

const boat = createSloop();
const { deck, points } = boat;
boat.group.updateMatrixWorld(true);

const meshes: THREE.Mesh[] = [];
boat.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
});
// Surfaces you stand on (not the boom, sail cover, rigging or lines overhead).
const standable = meshes.filter((m) => ['sloop-teak', 'sloop-gelcoat', 'sloop-nonskid', 'sloop-varnish'].includes(m.name));

/** Height of the first standable surface straight below (x, 6, z), or null. */
function visibleSurface(x: number, z: number): number | null {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 6, z), new THREE.Vector3(0, -1, 0), 0, 20);
  const hits = ray.intersectObjects(standable, false);
  return hits.length ? hits[0].point.y : null;
}

function expectStandable(x: number, z: number, label: string): number {
  const h = deck.heightAt(x, z);
  const seen = visibleSurface(x, z);
  expect(h, `${label}: heightAt`).not.toBeNull();
  expect(seen, `${label}: visible surface`).not.toBeNull();
  expect(Math.abs((h as number) - (seen as number)), `${label}: heightAt ${h} vs visible ${seen}`).toBeLessThan(0.03);
  return h as number;
}

describe('sloop model', () => {
  it('builds within the phone budget (<= 40k triangles, <= 8 draw calls)', () => {
    let tris = 0;
    for (const m of meshes) {
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    }
    console.log(`sloop: ${tris} triangles in ${meshes.length} meshes`);
    expect(tris).toBe(boat.triangles);
    expect(boat.triangles).toBeLessThanOrEqual(40000);
    expect(meshes.length).toBeLessThanOrEqual(8);
    expect(boat.group.children.length).toBe(meshes.length);
  });

  it('has the agreed size: about 8.4 m long, 2.8 m beam, with a keel below', () => {
    expect(boat.length).toBeCloseTo(8.4, 1);
    expect(boat.beam).toBeCloseTo(2.8, 1);
    expect(boat.draft).toBeGreaterThan(1);
    const box = new THREE.Box3();
    for (const m of meshes.filter((m) => m.name === 'sloop-hull')) box.expandByObject(m);
    expect(box.max.x - box.min.x).toBeGreaterThan(8.2);
    expect(box.max.z - box.min.z).toBeCloseTo(2.8, 1);
    expect(box.min.y).toBeCloseTo(-boat.draft, 1);
  });

  it('casts shadows, and the deck receives them', () => {
    for (const m of meshes) expect(m.castShadow, m.name).toBe(true);
    const teak = meshes.find((m) => m.name === 'sloop-teak');
    expect(teak?.receiveShadow).toBe(true);
  });

  it('has clean geometry (no NaNs, unit normals)', () => {
    for (const m of meshes) {
      const p = m.geometry.getAttribute('position').array;
      const n = m.geometry.getAttribute('normal').array;
      for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i]), m.name).toBe(true);
      for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
        if (Math.abs(l - 1) > 0.01) throw new Error(`${m.name}: normal ${i / 3} has length ${l}`);
      }
    }
  });
});

describe('walkable deck', () => {
  it('heightAt matches the visible surface at the spawn, locker, helm, mast and bow', () => {
    expect(expectStandable(points.spawn.x, points.spawn.z, 'spawn')).toBeCloseTo(points.spawn.y, 2);
    expect(expectStandable(points.locker.x, points.locker.z, 'locker')).toBeCloseTo(points.locker.y, 2);
    expect(expectStandable(points.helm.x, points.helm.z, 'helm')).toBeCloseTo(points.helm.y, 2);
    expectStandable(points.mastBase.x - 0.35, 0.15, 'cabin top behind the mast');
    expect(deck.heightAt(points.mastBase.x, points.mastBase.z)).toBeCloseTo(points.mastBase.y, 2);
    expectStandable(points.bow.x - 0.8, 0, 'foredeck by the bow');
    expectStandable(0, 1.15, 'starboard side deck');
    expectStandable(0, -1.15, 'port side deck');
    expectStandable(2.8, 0.3, 'foredeck');
    expectStandable(-3.95, -0.4, 'stern deck');
    for (const p of points.potShelf) expect(expectStandable(p.x, p.z, 'pot shelf')).toBeCloseTo(p.y, 2);
  });

  it('is null well outside the hull', () => {
    expect(deck.heightAt(0, 2.5)).toBeNull();
    expect(deck.heightAt(0, -2.5)).toBeNull();
    expect(deck.heightAt(6, 0)).toBeNull();
    expect(deck.heightAt(-5, 0)).toBeNull();
    expect(deck.heightAt(3.9, 0.6)).toBeNull();
  });

  it('has the cockpit sole about 0.4 m below the side decks, and the cabin top a step above them', () => {
    const sole = deck.heightAt(points.spawn.x, 0) as number;
    const side = deck.heightAt(points.spawn.x, 1.15) as number;
    const cabin = deck.heightAt(0, 0) as number;
    const sideByCabin = deck.heightAt(0, 1.15) as number;
    expect(side - sole).toBeGreaterThan(0.3);
    expect(side - sole).toBeLessThan(0.5);
    expect(cabin - sideByCabin).toBeGreaterThan(0.3);
    expect(cabin - sideByCabin).toBeLessThan(0.45);
  });

  it('knows where the lifelines are', () => {
    expect(deck.insideLifelines(points.spawn.x, points.spawn.z)).toBe(true);
    expect(deck.insideLifelines(2.8, 0)).toBe(true);
    expect(deck.insideLifelines(0, 1.15)).toBe(true);
    for (const x of [-3.5, -2, 0, 1.5, 3]) {
      for (const s of [-1, 1]) expect(deck.insideLifelines(x, s * (deck.halfBeam(x, true) + 0.3)), `x ${x}`).toBe(false);
    }
    expect(deck.insideLifelines(4.6, 0)).toBe(false);
    // The stern rail is closed except at the ladder gap.
    expect(deck.insideLifelines(-4.17, -0.5)).toBe(false);
    expect(deck.insideLifelines(-4.17, points.ladderTop.z)).toBe(true);
  });

  it('puts the swim ladder at the stern, from the deck down into the water', () => {
    const { ladderTop: t, ladderBottom: b } = points;
    expect(t.x).toBeLessThan(-3.9);
    expect(b.x).toBeLessThan(t.x);
    expect(b.x).toBeGreaterThan(-4.8);
    expect(Math.abs(t.z - b.z)).toBeLessThan(0.05);
    expect(b.y).toBeLessThan(-0.3);
    expect(b.y).toBeGreaterThan(-0.8);
    expect(deck.heightAt(t.x, t.z)).toBeCloseTo(t.y, 2);
    expect(deck.insideLifelines(t.x, t.z)).toBe(true);
    expect(t.z).toBeGreaterThan(deck.sternGap.z0);
    expect(t.z).toBeLessThan(deck.sternGap.z1);
  });

  it('gives a hull outline for the water: positive along the hull, 0 beyond the ends', () => {
    for (let x = -4.1; x <= 4.1; x += 0.2) expect(deck.halfBeam(x, true), `deck at ${x}`).toBeGreaterThan(0);
    for (let x = -3.4; x <= 3.2; x += 0.2) {
      const wl = deck.halfBeam(x, false);
      expect(wl, `waterline at ${x}`).toBeGreaterThan(0);
      expect(wl).toBeLessThanOrEqual(deck.halfBeam(x, true));
    }
    for (const x of [-4.6, -4.3, 4.3, 4.6]) {
      expect(deck.halfBeam(x, true)).toBe(0);
      expect(deck.halfBeam(x, false)).toBe(0);
    }
    expect(deck.halfBeam(-0.2, true)).toBeCloseTo(1.4, 1);
    expect(deck.halfBeam(0, false)).toBeGreaterThan(1.0);
  });

  it('blocks the mast and the cabin sides but not the open deck', () => {
    expect(deck.blocked(points.mastBase.x, 0, 0.25)).toBe(true);
    expect(deck.blocked(0, 0.75, 0.2)).toBe(true); // against the cabin side
    expect(deck.blocked(points.spawn.x, points.spawn.z, 0.25)).toBe(false);
    expect(deck.blocked(0, 1.15, 0.2)).toBe(false);
    expect(deck.blocked(2.8, 0, 0.25)).toBe(false);
  });

  it('lets a person walk from the cockpit to the foredeck, the cabin top and the ladder', () => {
    // Flood-fill over a 5 cm grid: steps up to 0.42 m, radius 0.25 m, inside the lifelines.
    const R = 0.25;
    const STEP = 0.42;
    const g = 0.05;
    const nx = Math.round(8.6 / g);
    const nz = Math.round(3.0 / g);
    const X = (i: number) => -4.3 + i * g;
    const Z = (k: number) => -1.5 + k * g;
    const h = new Float32Array(nx * nz).fill(NaN);
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        const y = deck.heightAt(X(i), Z(k));
        if (y !== null && deck.insideLifelines(X(i), Z(k)) && !deck.blocked(X(i), Z(k), R)) h[i * nz + k] = y;
      }
    }
    const cell = (x: number, z: number) => Math.round((x + 4.3) / g) * nz + Math.round((z + 1.5) / g);
    const seen = new Uint8Array(nx * nz);
    const start = cell(points.spawn.x, points.spawn.z);
    expect(Number.isNaN(h[start])).toBe(false);
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const c = queue.pop() as number;
      const i = Math.floor(c / nz);
      const k = c % nz;
      for (const [di, dk] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ii = i + di;
        const kk = k + dk;
        if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
        const n = ii * nz + kk;
        if (seen[n] || Number.isNaN(h[n]) || Math.abs(h[n] - h[c]) > STEP) continue;
        seen[n] = 1;
        queue.push(n);
      }
    }
    const reach = (x: number, z: number) => seen[cell(x, z)] === 1;
    expect(reach(points.locker.x, points.locker.z), 'locker').toBe(true);
    expect(reach(points.helm.x, points.helm.z), 'helm').toBe(true);
    expect(reach(points.ladderTop.x, points.ladderTop.z), 'ladder top').toBe(true);
    expect(reach(0, 1.15), 'starboard side deck').toBe(true);
    expect(reach(0, -1.15), 'port side deck').toBe(true);
    expect(reach(2.8, 0), 'foredeck').toBe(true);
    expect(reach(points.mastBase.x - 0.35, 0), 'cabin top behind the mast').toBe(true);
  });
});
