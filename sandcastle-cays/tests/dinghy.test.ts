// Checks for the dinghy (src/render/dinghy.ts) and the catamaran's davits that carry it.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createDinghy } from '../src/render/dinghy';
import { createCatamaran } from '../src/render/catamaran';

const dinghy = createDinghy();
const { deck, points, rig } = dinghy;
const R = 0.224; // the game's player radius times the 0.8 it uses for blocked()
const meshes: THREE.Mesh[] = [];
dinghy.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
});
const mesh = (name: string) => dinghy.group.getObjectByName(name) as THREE.Mesh;

function visibleBelow(x: number, from: number, z: number): number | null {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0), 0, 3);
  const hits = ray.intersectObjects([mesh('dinghy-wood')], false);
  return hits.length ? hits[0].point.y : null;
}
function verts(m: THREE.Mesh): THREE.Vector3[] {
  const p = m.geometry.getAttribute('position');
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i));
  return out;
}
function checkFinite(): void {
  for (const m of meshes) {
    const p = m.geometry.getAttribute('position').array;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) throw new Error(`${m.name}: bad vertex`);
  }
}
/** Runs the motor a frame at a time, as the game does. */
let clock = 0;
function runMotor(throttle: number, seconds: number): void {
  for (let t = 0; t < seconds; t += 1 / 30) rig.setMotor(throttle, (clock += 1 / 30));
}

describe('the dinghy', () => {
  it('fits the phone budget (<= 4 draw calls, <= 12,000 triangles)', () => {
    let tris = 0;
    for (const m of meshes) tris += (m.geometry.index as THREE.BufferAttribute).count / 3;
    console.log(`dinghy: ${tris} triangles in ${meshes.length} meshes`);
    expect(meshes.length).toBeLessThanOrEqual(4);
    expect(tris).toBeLessThanOrEqual(12000);
    expect(tris).toBe(dinghy.triangles);
  });

  it('is a little 3 m tender, 1.35 m wide, floating on its waterline', () => {
    expect(dinghy.length).toBeCloseTo(3.0, 1);
    expect(dinghy.beam).toBeCloseTo(1.35, 2);
    const box = new THREE.Box3().setFromObject(mesh('dinghy-hull'), true);
    expect(box.max.x - box.min.x).toBeGreaterThan(2.9);
    expect(box.max.z - box.min.z).toBeGreaterThan(1.3);
    expect(box.max.z - box.min.z).toBeLessThan(1.42);
    expect(box.min.y).toBeLessThan(-0.1); // the keel is in the water
    expect(box.min.y).toBeGreaterThan(-0.3);
    expect(dinghy.draft).toBeGreaterThan(0.1);
  });

  it('casts shadows from the boat but not from its invisible water mask', () => {
    for (const m of meshes) {
      if (m.name === 'dinghy-water-mask') expect(m.customDepthMaterial).toBeTruthy();
      else expect(m.castShadow, m.name).toBe(true);
    }
  });

  it('has clean geometry (no NaNs, unit normals)', () => {
    checkFinite();
    for (const m of meshes) {
      const n = m.geometry.getAttribute('normal').array;
      for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
        if (Math.abs(l - 1) > 0.02) throw new Error(`${m.name}: normal ${i / 3} has length ${l}`);
      }
    }
  });

  it('has its spots on the floorboards and thwarts, inside the hull, with room to sit', () => {
    for (const k of ['seat', 'helm', 'board'] as const) {
      const p = points[k];
      expect(deck.heightAt(p.x, p.z, p.y), k).toBeCloseTo(p.y, 2);
      expect(deck.insideLifelines(p.x, p.z, p.y), k).toBe(true);
      expect(deck.blocked(p.x, p.z, R, p.y), k).toBe(false);
      expect(Math.abs(p.z)).toBeLessThan(deck.halfBeam(p.x, true) - 0.2);
      const seen = visibleBelow(p.x, p.y + 0.5, p.z);
      expect(seen, `${k}: something underfoot`).not.toBeNull();
      expect(Math.abs((seen as number) - p.y), `${k}: heightAt ${p.y} vs visible ${seen}`).toBeLessThan(0.03);
    }
    expect(points.board.y).toBeLessThan(0.05); // the floorboards
    expect(points.seat.y).toBeGreaterThan(points.board.y + 0.2); // a thwart, a seat's height above them
    expect(points.seatYaw).toBeCloseTo(Math.PI / 2, 5); // rowers face aft
    expect(points.helmYaw).toBeCloseTo(-Math.PI / 2, 5); // facing the bow to motor
    expect(points.helm.x).toBeLessThan(-0.8); // at the stern by the tiller
    expect(points.bow.x).toBeGreaterThan(1.4);
    expect(points.stern.x).toBeLessThan(-1.4);
    expect(deck.heightAt(0, 1.2)).toBeNull();
    expect(deck.heightAt(2.5, 0)).toBeNull();
    expect(deck.insideLifelines(0, 0.9)).toBe(false);
    expect(deck.ceilingAt(0, 0, 0)).toBeNull();
  });

  it('gives swimmers a footprint and the water an outline', () => {
    expect(deck.footprintPen(0, 0)).toBeGreaterThan(0.5);
    expect(deck.footprintPen(0, 1.2)).toBe(0);
    expect(deck.footprintPen(3, 0)).toBe(0);
    for (let x = -1.4; x <= 1.3; x += 0.2) expect(deck.halfBeam(x, true), `x ${x}`).toBeGreaterThan(0);
    expect(deck.halfBeam(0, false)).toBeGreaterThan(0.4);
    expect(deck.halfBeam(0, false)).toBeLessThan(deck.halfBeam(0, true));
    expect(deck.halfBeam(1.8, true)).toBe(0);
    expect(deck.halfBeam(-1.8, false)).toBe(0);
  });

  it('sweeps the oars through a stroke, and ships them inboard when not rowing', () => {
    rig.setOars(0, false);
    for (const t of rig.status().bladeTips) {
      expect(Math.abs(t.z)).toBeLessThan(deck.halfBeam(t.x, true));
      expect(t.y).toBeGreaterThan(0.1);
    }
    rig.setOars(0.0, true);
    const catchTips = rig.status().bladeTips.map((t) => t.clone());
    rig.setOars(0.3, true);
    const drive = rig.status();
    rig.setOars(0.7, true);
    const recovery = rig.status();
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(catchTips[i].z)).toBeGreaterThan(1.2); // reaching out over the water
      expect(catchTips[i].x - drive.bladeTips[i].x, 'the blade sweeps aft in the drive').toBeGreaterThan(0.6);
      expect(drive.bladeTips[i].y, 'blade in the water in the drive').toBeLessThan(0.0);
      expect(recovery.bladeTips[i].y, 'blade out of the water on the recovery').toBeGreaterThan(0.0);
    }
    // the two oars mirror each other
    expect(drive.bladeTips[0].x).toBeCloseTo(drive.bladeTips[1].x, 3);
    expect(drive.bladeTips[0].z).toBeCloseTo(-drive.bladeTips[1].z, 3);
    // the handles stay inboard, in reach of the rower
    for (const h of drive.handles) {
      expect(Math.abs(h.z)).toBeLessThan(0.4);
      expect(Math.abs(h.x - points.seat.x)).toBeLessThan(0.8);
    }
    rig.setOars(0, false);
    checkFinite();
  });

  it('tilts the outboard down to run and up when off, spins the prop and steers', () => {
    runMotor(0, 1.2);
    let st = rig.status();
    expect(st.motorDown).toBe(0);
    expect(st.propTip.y, 'tilted up, out of the water').toBeGreaterThan(0.2);
    expect(st.propTip.x).toBeLessThan(-1.5);
    runMotor(1, 0.4);
    expect(rig.status().motorDown).toBeGreaterThan(0.3);
    expect(rig.status().motorDown).toBeLessThan(0.7);
    runMotor(1, 1.0);
    st = rig.status();
    expect(st.motorDown).toBe(1);
    expect(st.propTip.y, 'prop under water').toBeLessThan(-0.1);
    const a = Float32Array.from(mesh('dinghy-fittings').geometry.getAttribute('position').array);
    runMotor(-0.6, 0.15);
    const b = mesh('dinghy-fittings').geometry.getAttribute('position').array;
    expect(a.some((v, i) => Math.abs(v - b[i]) > 0.005), 'the prop spins').toBe(true);
    rig.setRudder(0.4);
    st = rig.status();
    expect(st.propTip.z, 'prop to starboard').toBeGreaterThan(0.03);
    expect(st.tillerEnd.z, 'tiller to port').toBeLessThan(-0.03);
    rig.setRudder(0);
    runMotor(0, 1.2);
    expect(rig.status().propTip.y).toBeGreaterThan(0.2);
    // stowed: tilted down and turned along the transom, whatever the throttle
    rig.setStowed(true);
    st = rig.status();
    expect(st.motorDown).toBe(1);
    expect(st.stowed).toBe(true);
    rig.setStowed(false);
    checkFinite();
  });

  it('wears and gets patched with damage', () => {
    rig.setDamage(0.6);
    expect(rig.status().damage).toBeCloseTo(0.6, 5);
    rig.setDamage(2);
    expect(rig.status().damage).toBe(1);
    rig.setDamage(0);
    expect(rig.status().damage).toBe(0);
  });
});

describe('the davits on the catamaran', () => {
  const cat = createCatamaran();
  const hung = createDinghy();
  hung.rig.setStowed(true);
  hung.group.position.copy(cat.points.davit);
  hung.group.rotation.y = cat.points.davitYaw;
  cat.group.add(hung.group);
  cat.group.updateMatrixWorld(true);
  const hungVerts = (): THREE.Vector3[] => {
    cat.group.updateMatrixWorld(true);
    const out: THREE.Vector3[] = [];
    hung.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.name === 'dinghy-water-mask') return;
      for (const v of verts(m)) out.push(v.applyMatrix4(m.matrixWorld));
    });
    return out;
  };
  /** Points on the stern steps' surfaces (x, height, z). */
  const stepSpots: THREE.Vector3[] = [];
  for (let x = -6.84; x < -5.2; x += 0.05) {
    for (let z = -3.8; z <= 3.8; z += 0.05) {
      for (const y of [0.35, 0.6, 0.9, 1.2]) {
        const h = cat.deck.heightAt(x, z, y);
        if (h !== null && Math.abs(h - y) < 0.01) stepSpots.push(new THREE.Vector3(x, h, z));
      }
    }
  }

  it('has the new spots: where the dinghy hangs, its turn, and where to step down into it', () => {
    const p = cat.points;
    expect(p.davit.x).toBeLessThan(-5.3); // aft of the crossbeam
    expect(Math.abs(p.davit.z)).toBeLessThan(0.3); // between the sterns
    expect(Math.abs(p.davitYaw)).toBeCloseTo(Math.PI / 2, 5); // athwartships
    const b = p.dinghyBoard;
    expect(cat.deck.heightAt(b.x, b.z, b.y)).toBeCloseTo(b.y, 2);
    expect(cat.deck.insideLifelines(b.x, b.z, b.y)).toBe(true);
    expect(cat.deck.blocked(b.x, b.z, R, b.y)).toBe(false);
    expect(b.y).toBeLessThan(0.5); // the swim platform, a step above the launched dinghy
    // and well away from the ladder's top, so stepping toward the dinghy never starts the ladder climb
    expect(Math.hypot(b.x - p.ladderTop.x, b.z - p.ladderTop.z)).toBeGreaterThan(1.5);
  });

  it('leave the swim ladder and the stern steps clear', () => {
    expect(stepSpots.length).toBeGreaterThan(500);
    for (const s of stepSpots) {
      if (cat.deck.blocked(s.x, s.z, R, s.y)) throw new Error(`blocked on the steps at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}`);
    }
    const lt = cat.points.ladderTop;
    expect(cat.deck.blocked(lt.x, lt.z, R, lt.y)).toBe(false);
    // no davit within a person's reach of anyone standing on a step
    for (const arm of cat.fittings.davits) {
      for (const s of stepSpots) {
        const col = new THREE.Box3(new THREE.Vector3(s.x - R, s.y, s.z - R), new THREE.Vector3(s.x + R, s.y + 2, s.z + R));
        if (arm.intersectsBox(col)) throw new Error(`a davit is in the way on the step at ${s.x.toFixed(2)}, ${s.z.toFixed(2)}`);
      }
    }
  });

  it('hang the dinghy clear of the water and of anyone on the stern steps', () => {
    const vs = hungVerts();
    expect(Math.min(...vs.map((v) => v.y)), 'clear of the water').toBeGreaterThan(0.5);
    let worst = Infinity;
    for (const s of stepSpots) {
      for (const v of vs) {
        if (v.y < s.y || v.y > s.y + 2) continue;
        worst = Math.min(worst, Math.hypot(v.x - s.x, v.z - s.z));
      }
    }
    expect(worst, 'nearest the dinghy comes to a spot on the steps').toBeGreaterThan(R);
  });

  it('lower the dinghy on its falls to float at the waterline', () => {
    expect(cat.rig.status().falls).toBe(0);
    expect(cat.rig.status().dinghyOrigin.distanceTo(cat.points.davit)).toBeLessThan(1e-6);
    cat.rig.setFalls(0.5);
    expect(cat.rig.status().dinghyOrigin.y).toBeCloseTo(cat.points.davit.y / 2, 3);
    cat.rig.setFalls(1);
    const o = cat.rig.status().dinghyOrigin;
    expect(o.y).toBeCloseTo(0, 3);
    expect(o.x).toBeCloseTo(cat.points.davit.x, 3);
    // the falls reach down to the dinghy's lifting eyes wherever it is
    const lines = cat.group.getObjectByName('cat-rig-lines') as THREE.Mesh;
    const low = Math.min(...verts(lines).filter((v) => Math.abs(v.x - o.x) < 0.1 && Math.abs(v.z) < 1.4 && v.y > 0).map((v) => v.y));
    expect(low).toBeLessThan(0.5);
    cat.rig.setFalls(0);
    let tris = 0;
    let n = 0;
    cat.group.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh || m.name.startsWith('dinghy')) return;
      n++;
      tris += (m.geometry.index as THREE.BufferAttribute).count / 3;
    });
    expect(n).toBeLessThanOrEqual(20);
    expect(tris).toBeLessThanOrEqual(90000);
  });
});
