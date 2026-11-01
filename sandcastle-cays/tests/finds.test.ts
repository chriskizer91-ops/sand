import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FINDS, FIND_KINDS } from '../src/content/finds';
import { basketModel, basketSlots, disposeFindCache, findModel, findTriangles } from '../src/render/finds';

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
  });
  return out;
}

function triangles(o: THREE.Object3D): number {
  return meshes(o).reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3, 0);
}

function materials(o: THREE.Object3D): Set<THREE.Material> {
  const out = new Set<THREE.Material>();
  for (const m of meshes(o)) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) out.add(mat);
  return out;
}

describe('beachcombing catalogue', () => {
  it('lists all 17 kinds, once each', () => {
    expect(FIND_KINDS.length).toBe(17);
    expect(new Set(FIND_KINDS).size).toBe(FIND_KINDS.length);
  });
  for (const kind of FIND_KINDS) {
    it(`${kind}: has logbook info`, () => {
      const info = FINDS[kind];
      expect(info.kind).toBe(kind);
      expect(info.name.trim()).not.toBe('');
      expect(info.plural.trim()).not.toBe('');
      expect(info.fact.trim().length).toBeGreaterThan(20);
      expect(info.firstLine.trim()).not.toBe('');
      expect(info.rarity).toBeGreaterThan(0);
      expect(info.size).toBeGreaterThan(0);
    });
  }
});

describe('find models', () => {
  for (const kind of FIND_KINDS) {
    it(`${kind}: builds at real size, rests on the sand, and fits the budget`, () => {
      const model = findModel(kind);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z);
      const want = FINDS[kind].size;
      const tris = findTriangles(kind);
      console.log(
        `${kind.padEnd(15)} ${String(tris).padStart(3)} triangles, ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} m (catalogue size ${want} m)`,
      );
      expect(longest).toBeGreaterThan(want / 2);
      expect(longest).toBeLessThan(want * 2);
      expect(Math.abs(box.min.y)).toBeLessThanOrEqual(0.01);
      // origin under the middle of the find
      expect(Math.abs((box.min.x + box.max.x) / 2)).toBeLessThan(0.01);
      expect(Math.abs((box.min.z + box.max.z) / 2)).toBeLessThan(0.01);
      expect(tris).toBe(triangles(model));
      expect(tris).toBeLessThanOrEqual(700);
      expect(materials(model).size).toBeLessThanOrEqual(2);
    });

    it(`${kind}: has finite positions and unit normals`, () => {
      for (const m of meshes(findModel(kind))) {
        const pos = m.geometry.getAttribute('position');
        const nrm = m.geometry.getAttribute('normal');
        expect(nrm).toBeDefined();
        for (let i = 0; i < pos.count; i++) {
          expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
          const l = Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
          expect(Math.abs(l - 1)).toBeLessThan(1e-3);
        }
      }
    });
  }

  it('gives a new object each time but shares geometry and materials', () => {
    const a = findModel('cowrie');
    const b = findModel('cowrie');
    expect(a).not.toBe(b);
    expect(meshes(a)[0]).not.toBe(meshes(b)[0]);
    expect(meshes(a)[0].geometry).toBe(meshes(b)[0].geometry);
    expect(meshes(a)[0].material).toBe(meshes(b)[0].material);
  });

  it('rebuilds after the cache is freed', () => {
    const before = meshes(findModel('rope'))[0].geometry;
    disposeFindCache();
    const after = meshes(findModel('rope'))[0].geometry;
    expect(after).not.toBe(before);
    expect(findTriangles('rope')).toBeGreaterThan(0);
  });
});

describe('basket', () => {
  it('is about 0.38 m across, rests on the sand, and fits the budget', () => {
    const basket = basketModel();
    const box = new THREE.Box3().setFromObject(basket);
    const size = box.getSize(new THREE.Vector3());
    console.log(`basket ${triangles(basket)} triangles, ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} m`);
    expect(triangles(basket)).toBeLessThanOrEqual(2500);
    expect(size.x).toBeGreaterThan(0.33);
    expect(size.x).toBeLessThan(0.43);
    expect(size.z).toBeGreaterThan(0.33);
    expect(size.z).toBeLessThan(0.43);
    expect(Math.abs(box.min.y)).toBeLessThanOrEqual(0.005);
    expect(materials(basket).size).toBeLessThanOrEqual(2);
  });

  it('has 12 slots inside it, filled from the bottom up', () => {
    const box = new THREE.Box3().setFromObject(basketModel());
    const slots = basketSlots();
    expect(slots.length).toBe(12);
    for (const s of slots) {
      expect(box.containsPoint(s)).toBe(true);
      // inside the wall, not just inside the bounding box
      expect(Math.hypot(s.x, s.z)).toBeLessThan(0.14);
      expect(s.y).toBeLessThan(0.2);
    }
    for (let i = 1; i < slots.length; i++) expect(slots[i].y).toBeGreaterThanOrEqual(slots[i - 1].y);
  });
});

afterAll(() => disposeFindCache());
