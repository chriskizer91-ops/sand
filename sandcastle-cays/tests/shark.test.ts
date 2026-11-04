import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BaitCloud, FinWake, SHARK_KINDS, SHARK_LENGTH, baitModel, disposeShark, prepareSharks, sharkModel, sharkTriangles, swim, type FinState } from '../src/render/shark';

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
  });
  return out;
}
const tris = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** Triangles wound against their vertex normals (they would be drawn inside out, or not at all). */
function insideOut(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const idx = g.index!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const vn = new THREE.Vector3();
  let bad = 0;
  for (let t = 0; t < idx.count; t += 3) {
    a.fromBufferAttribute(p, idx.getX(t));
    b.fromBufferAttribute(p, idx.getX(t + 1)).sub(a);
    c.fromBufferAttribute(p, idx.getX(t + 2)).sub(a);
    const face = b.cross(c);
    if (face.lengthSq() < 1e-16) continue;
    vn.set(0, 0, 0);
    for (let k = 0; k < 3; k++) vn.add(new THREE.Vector3().fromBufferAttribute(n, idx.getX(t + k)));
    if (face.dot(vn) <= 0) bad++;
  }
  return bad;
}

describe('shark models', () => {
  it('there are two sharks: a Caribbean reef shark and a nurse shark', () => {
    expect(SHARK_KINDS).toEqual(['reef', 'nurse']);
  });

  const real = { reef: 2.2, nurse: 2.6 };
  for (const kind of SHARK_KINDS) {
    it(`${kind}: real length, head at +x, within budget, one draw call`, () => {
      const s = sharkModel(kind);
      const box = new THREE.Box3().setFromObject(s);
      const size = box.getSize(new THREE.Vector3());
      const n = sharkTriangles(kind);
      console.log(`${kind.padEnd(6)} ${n} triangles, ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m`);
      expect(Math.abs(size.x - real[kind]) / real[kind]).toBeLessThan(0.15);
      expect(SHARK_LENGTH[kind]).toBe(real[kind]);
      expect(s.userData.length).toBe(real[kind]);
      expect(n).toBeGreaterThanOrEqual(2500);
      expect(n).toBeLessThanOrEqual(4000);
      expect(meshes(s).length).toBeLessThanOrEqual(2);
      expect(meshes(s).reduce((a, m) => a + tris(m.geometry), 0)).toBe(n);
      // the head end is +x: the snout is in front of the dorsal fin, the tail well behind it
      const fin = s.userData.finTip as THREE.Vector3;
      expect(fin.x).toBeLessThan(box.max.x - 0.2 * real[kind]);
      expect(fin.x).toBeGreaterThan(box.min.x + 0.3 * real[kind]);
      // the first dorsal fin's tip is the top of the shark (the wake starts there)
      expect(fin.y).toBeCloseTo(box.max.y, 1);
      expect(Math.abs(fin.z)).toBeLessThan(0.01);
      // lifting it by `rest` sets its lowest point on the sand
      expect(box.min.y + s.userData.rest).toBeCloseTo(0, 5);
      // no holes: every number finite, every normal a unit vector, every triangle facing out
      const g = meshes(s)[0].geometry;
      for (const a of Object.values(g.attributes)) for (const x of (a as THREE.BufferAttribute).array as Float32Array) expect(Number.isFinite(x)).toBe(true);
      const nrm = g.getAttribute('normal');
      for (let i = 0; i < nrm.count; i++) expect(Math.abs(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1)).toBeLessThan(1e-3);
      expect(insideOut(g)).toBeLessThanOrEqual(2);
      disposeShark(s);
    });
  }

  it('the nurse shark is the stocky one, with its dorsal fins far back', () => {
    const reef = sharkModel('reef');
    const nurse = sharkModel('nurse');
    const rf = (reef.userData.finTip as THREE.Vector3).x / 1.1; // as a share of half the length, from the middle
    const nf = (nurse.userData.finTip as THREE.Vector3).x / 1.3;
    expect(nf).toBeLessThan(rf - 0.15);
  });

  it('swims at any speed and turn without trouble, each shark on its own', () => {
    const a = sharkModel('reef');
    const b = sharkModel('nurse');
    const wa = a.userData.swim as THREE.Vector4;
    const wb = b.userData.swim as THREE.Vector4;
    let t = 0;
    for (const speed of [0, 0.3, 1, 1.5, 3, 6, 50, -2, NaN, Infinity]) {
      for (const turn of [0, 0.8, -2, NaN]) {
        for (let i = 0; i < 10; i++) {
          t += 1 / 30;
          expect(() => swim(a, t, speed, turn)).not.toThrow();
          for (const v of [wa.x, wa.y, wa.z, wa.w]) expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
    expect(() => swim(a, NaN, 1, 0)).not.toThrow();
    // a resting nurse shark barely moves; a dashing reef shark beats its tail hard and fast
    for (let i = 0; i < 30; i++) swim(b, i / 30, 0, 0);
    const rest = wb.y;
    const phase0 = wb.x;
    swim(b, 1.0 + 1 / 30, 0, 0);
    const restStep = wb.x - phase0;
    for (let i = 0; i < 30; i++) swim(a, 100 + i / 30, 3, 0);
    const fast = (a.userData.swim as THREE.Vector4).y;
    const phase1 = wa.x;
    swim(a, 101 + 1 / 30, 3, 0);
    expect(rest).toBeLessThan(0.06);
    expect(fast).toBeGreaterThan(2 * rest);
    expect(wa.x - phase1).toBeGreaterThan(3 * restStep);
    // it bends into a turn, and straightens out again
    for (let i = 0; i < 60; i++) swim(a, 200 + i / 30, 1, 1.2);
    expect((a.userData.swim2 as THREE.Vector4).x).toBeGreaterThan(0.6);
    for (let i = 0; i < 60; i++) swim(a, 210 + i / 30, 1, 0);
    expect(Math.abs((a.userData.swim2 as THREE.Vector4).x)).toBeLessThan(0.1);
  });

  it('can be built ahead of time', () => {
    expect(() => prepareSharks()).not.toThrow();
  });
});

describe('fin wake', () => {
  it('is one draw call for up to 8 sharks, and only shows where a fin breaks the water', () => {
    const wake = new FinWake();
    expect(meshes(wake.mesh).length).toBe(1);
    const fins: FinState[] = [];
    for (let i = 0; i < 10; i++) fins.push({ x: i * 3, y: 0.15, z: 0, heading: 0.3 * i, speed: 1.2 });
    let t = 0;
    for (let f = 0; f < 60; f++) {
      t += 1 / 30;
      for (const fin of fins) {
        fin.x += Math.cos(fin.heading) * fin.speed / 30;
        fin.z += Math.sin(fin.heading) * fin.speed / 30;
      }
      wake.update(fins, t);
    }
    expect(wake.mesh.visible).toBe(true);
    const g = wake.mesh.geometry;
    for (const name of ['position', 'rgba', 'offs']) for (const x of (g.getAttribute(name) as THREE.BufferAttribute).array as Float32Array) expect(Number.isFinite(x)).toBe(true);
    // fins under the water leave nothing; after the old wake fades, the mesh hides
    for (const fin of fins) fin.y = -0.4;
    for (let f = 0; f < 60; f++) wake.update(fins, (t += 1 / 30));
    expect(wake.mesh.visible).toBe(false);
    // the water's height is followed if given
    wake.waterAt = (x, z) => 0.3 + 0.01 * Math.sin(x + z);
    for (const fin of fins) fin.y = 0.2;
    for (let f = 0; f < 10; f++) wake.update(fins, (t += 1 / 30));
    expect(wake.mesh.visible).toBe(false);
    for (const fin of fins) fin.y = 0.45;
    for (let f = 0; f < 10; f++) wake.update(fins, (t += 1 / 30));
    expect(wake.mesh.visible).toBe(true);
    // bad input doesn't break it
    expect(() => wake.update([{ x: NaN, y: 1, z: 0, heading: 0, speed: 1 }, { x: 0, y: 1, z: 0, heading: 0, speed: NaN }], t + 1)).not.toThrow();
    expect(() => wake.update([], t + 2)).not.toThrow();
  });
});

describe('bait', () => {
  it('is a small chunk of fish, and its cloud of bits sinks and fades', () => {
    const b = baitModel();
    const size = new THREE.Box3().setFromObject(b).getSize(new THREE.Vector3());
    expect(Math.max(size.x, size.y, size.z)).toBeGreaterThan(0.03);
    expect(Math.max(size.x, size.y, size.z)).toBeLessThan(0.1);
    expect(meshes(b).reduce((a, m) => a + tris(m.geometry), 0)).toBeLessThan(400);
    expect(insideOut(meshes(b)[0].geometry)).toBeLessThanOrEqual(2); // (at the very centre of the cut faces)
    const cloud = new BaitCloud();
    expect(meshes(cloud.mesh).length).toBe(1);
    cloud.drop(new THREE.Vector3(0, 0, 0));
    cloud.update(0);
    cloud.update(0.05);
    expect(cloud.mesh.visible).toBe(true);
    const pos = cloud.mesh.geometry.getAttribute('position');
    const y0 = pos.getY(0);
    for (let i = 1; i < 60; i++) cloud.update(0.05 + i / 30);
    expect(pos.getY(0)).toBeLessThan(y0);
    for (let i = 0; i < 400; i++) cloud.update(3 + i / 30);
    expect(cloud.mesh.visible).toBe(false);
  });
});
