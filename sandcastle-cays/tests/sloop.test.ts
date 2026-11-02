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
  it('builds within the phone budget (<= 50k triangles, <= 13 draw calls, rig, motor and lights included)', () => {
    let tris = 0;
    for (const m of meshes) {
      const g = m.geometry;
      tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    }
    console.log(`sloop: ${tris} triangles in ${meshes.length} meshes`);
    expect(tris).toBe(boat.triangles);
    expect(boat.triangles).toBeLessThanOrEqual(50000);
    expect(meshes.length).toBeLessThanOrEqual(13);
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

  it('casts shadows (all but the light glows), and the deck receives them', () => {
    for (const m of meshes) if (m.name !== 'sloop-nav-lights') expect(m.castShadow, m.name).toBe(true);
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

describe('rig (sailing)', () => {
  const rig = boat.rig;
  const mesh = (name: string) => boat.group.getObjectByName(name) as THREE.Mesh;
  /** Boat-local positions of a mesh's vertices (its own transform applied, not the boat's). */
  const localVerts = (m: THREE.Mesh): THREE.Vector3[] => {
    boat.group.updateMatrixWorld(true);
    const toBoat = new THREE.Matrix4().copy(boat.group.matrixWorld).invert().multiply(m.matrixWorld);
    const p = m.geometry.getAttribute('position');
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(toBoat));
    return out;
  };
  const restVerts = (m: THREE.Mesh): THREE.Vector3[] => {
    const p = m.geometry.getAttribute('position');
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i));
    return out;
  };
  const reset = () => {
    rig.setSail(0);
    rig.setBoom(0);
    rig.setJib(0);
    rig.setFill(1, 0);
    rig.setRudder(0);
    rig.setAnchored(true);
  };

  it('exists with all its controls', () => {
    for (const k of ['setSail', 'setBoom', 'setJib', 'setFill', 'setRudder', 'setAnchored', 'status'] as const) expect(typeof rig[k]).toBe('function');
    for (const n of ['sloop-boom', 'sloop-sails', 'sloop-rig-lines', 'sloop-rudder']) expect(mesh(n), n).toBeTruthy();
  });

  it('setSail(0) keeps the furled look: cover on, no hoisted sail', () => {
    reset();
    const st = rig.status();
    expect(st.coverShown).toBe(true);
    expect(st.mainShown).toBe(false);
    expect(mesh('sloop-sails').visible).toBe(false);
    expect(st.mainHead.y).toBeLessThan(3);
  });

  it('setSail(1) shows both sails: main up to the masthead, jib along the forestay', () => {
    reset();
    rig.setSail(1);
    rig.setBoom(-0.7);
    rig.setJib(-0.45);
    const st = rig.status();
    expect(st.coverShown).toBe(false);
    expect(st.mainShown && st.jibShown).toBe(true);
    const sails = mesh('sloop-sails');
    expect(sails.visible).toBe(true);
    const v = localVerts(sails);
    expect(Math.max(...v.map((p) => p.y))).toBeGreaterThan(10); // main head near the masthead
    expect(v.some((p) => p.x > 3.5 && p.y < 2)).toBe(true); // jib tack at the bow
    expect(v.some((p) => p.z < -1.5)).toBe(true); // sails out to port with the boom
    expect(st.jibClew.z).toBeLessThan(-0.5);
    // Half way: the main is half up, the jib half out.
    rig.setSail(0.5);
    const half = rig.status();
    expect(half.mainHead.y).toBeGreaterThan(5);
    expect(half.mainHead.y).toBeLessThan(8);
    expect(Math.abs(half.jibClew.z)).toBeLessThan(Math.abs(st.jibClew.z));
    reset();
  });

  it('setBoom swings the boom end out to the side asked, clear of a standing head', () => {
    reset();
    const boomMesh = mesh('sloop-boom');
    const endLocal = restVerts(boomMesh).reduce((a, b) => (b.x < a.x ? b : a)); // the aft end, boom amidships
    for (const [angle, sign] of [
      [0.8, 1],
      [-0.8, -1],
    ]) {
      rig.setBoom(angle);
      boat.group.updateMatrixWorld(true);
      const end = endLocal.clone().applyMatrix4(new THREE.Matrix4().copy(boat.group.matrixWorld).invert().multiply(boomMesh.matrixWorld));
      expect(end.z * sign, `boom ${angle}`).toBeGreaterThan(1.5);
      expect(rig.status().boomEnd.z * sign).toBeGreaterThan(1.5);
    }
    // Over the cockpit the boom stays above a 1.75 m person standing on the sole.
    for (const angle of [-0.6, 0, 0.6]) {
      rig.setBoom(angle);
      const aft = localVerts(boomMesh).filter((p) => p.x < -1.5);
      expect(Math.min(...aft.map((p) => p.y))).toBeGreaterThan(points.helm.y + 1.75);
    }
    reset();
  });

  it('setRudder(0.4) moves the rudder trailing edge to starboard and the tiller to port', () => {
    reset();
    const rudder = mesh('sloop-rudder');
    const rest = restVerts(rudder);
    const te = rest.filter((p) => p.y < 0).reduce((a, b) => (b.x < a.x ? b : a));
    const tiller = rest.reduce((a, b) => (b.x > a.x ? b : a));
    rig.setRudder(0.4);
    boat.group.updateMatrixWorld(true);
    const toBoat = new THREE.Matrix4().copy(boat.group.matrixWorld).invert().multiply(rudder.matrixWorld);
    expect(te.clone().applyMatrix4(toBoat).z).toBeGreaterThan(0.1);
    expect(tiller.clone().applyMatrix4(toBoat).z).toBeLessThan(-0.3);
    const st = rig.status();
    expect(st.rudderTrailingEdge.z).toBeGreaterThan(0.1);
    expect(st.tillerEnd.z).toBeLessThan(-0.3);
    rig.setRudder(-0.4);
    expect(rig.status().rudderTrailingEdge.z).toBeLessThan(-0.1);
    reset();
  });

  it('setAnchored(false) takes the line out of the water and stows the anchor', () => {
    reset();
    const lines = mesh('sloop-rig-lines');
    expect(Math.min(...localVerts(lines).map((p) => p.y))).toBeLessThan(-1);
    rig.setAnchored(false);
    expect(Math.min(...localVerts(lines).map((p) => p.y))).toBeGreaterThan(0.5);
    expect(rig.status().rodeShown).toBe(false);
    expect(rig.status().anchorStowedShown).toBe(true);
    reset();
  });

  it('luffing sails ripple over time; full sails hold their shape', () => {
    reset();
    rig.setSail(1);
    rig.setBoom(-0.7);
    rig.setJib(-0.45);
    const sails = mesh('sloop-sails');
    const snap = () => Float32Array.from(sails.geometry.getAttribute('position').array);
    const diff = (a: Float32Array, b: Float32Array) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);
    rig.setFill(1, 0);
    const a = snap();
    rig.setFill(1, 0.5);
    expect(diff(a, snap())).toBeLessThan(1e-6);
    rig.setFill(0, 0);
    const b = snap();
    rig.setFill(0, 0.4);
    expect(diff(b, snap())).toBeGreaterThan(0.02);
    reset();
  });

  it('stays within budget in every pose', () => {
    rig.setSail(1);
    rig.setBoom(1.4);
    rig.setJib(1);
    rig.setFill(0.2, 3);
    rig.setRudder(0.6);
    rig.setAnchored(false);
    let tris = 0;
    let n = 0;
    boat.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      n++;
      tris += (m.geometry.index as THREE.BufferAttribute).count / 3;
      const p = m.geometry.getAttribute('position').array;
      for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) throw new Error(`${m.name} has a bad vertex`);
    });
    expect(n).toBeLessThanOrEqual(13);
    expect(tris).toBeLessThanOrEqual(50000);
    reset();
  });
});

describe('outboard and navigation lights', () => {
  const rig = boat.rig;
  const mesh = (name: string) => boat.group.getObjectByName(name) as THREE.Mesh;
  let clock = 100;
  /** Runs the motor at this throttle for a while, a frame at a time, as the game does. */
  const runMotor = (throttle: number, seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 30) rig.setMotor(throttle, (clock += 1 / 30));
  };
  /** Exact boat-local box of a mesh's vertices (optionally only some of them). */
  const boxOf = (m: THREE.Mesh, keep: (p: THREE.Vector3) => boolean = () => true) => {
    boat.group.updateMatrixWorld(true);
    const toBoat = new THREE.Matrix4().copy(boat.group.matrixWorld).invert().multiply(m.matrixWorld);
    const p = m.geometry.getAttribute('position');
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (keep(v)) box.expandByPoint(v.clone().applyMatrix4(toBoat));
    }
    return box;
  };

  it('starts tilted up, prop out of the water', () => {
    runMotor(0, 1.2);
    const st = rig.status();
    expect(st.motorDown).toBe(0);
    expect(st.propTip.y).toBeGreaterThan(0.2);
    expect(st.propTip.z).toBeLessThan(-0.3); // port side
    expect(boxOf(mesh('sloop-outboard')).min.y).toBeGreaterThan(0);
  });

  it('tilts down smoothly when running, prop about half a metre under, and back up at 0', () => {
    runMotor(0, 1.2);
    runMotor(1, 0.4);
    const mid = rig.status().motorDown;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    runMotor(1, 1.0);
    const st = rig.status();
    expect(st.motorDown).toBe(1);
    expect(st.propTip.y).toBeLessThan(-0.3);
    expect(st.propTip.y).toBeGreaterThan(-0.7);
    expect(boxOf(mesh('sloop-outboard')).min.y).toBeLessThan(-0.4);
    // the propeller spins while running
    const prop = () => Float32Array.from(mesh('sloop-outboard').geometry.getAttribute('position').array);
    const a = prop();
    runMotor(-0.5, 0.1);
    const b = prop();
    expect(a.some((x, i) => Math.abs(x - b[i]) > 0.005)).toBe(true);
    runMotor(0, 1.2);
    expect(rig.status().motorDown).toBe(0);
    expect(rig.status().propTip.y).toBeGreaterThan(0.2);
  });

  it('keeps clear of the swim ladder and the rudder blade, up or down', () => {
    const ladder = new THREE.Box3(
      new THREE.Vector3(points.ladderBottom.x - 0.08, points.ladderBottom.y - 0.2, points.ladderTop.z - 0.22),
      new THREE.Vector3(points.ladderTop.x + 0.15, points.ladderTop.y + 0.6, points.ladderTop.z + 0.22),
    );
    for (const throttle of [0, 1]) {
      runMotor(throttle, 1.2);
      const motor = boxOf(mesh('sloop-outboard'));
      expect(motor.intersectsBox(ladder), `ladder, throttle ${throttle}`).toBe(false);
      for (const r of [-0.6, 0, 0.6]) {
        rig.setRudder(r);
        const blade = boxOf(mesh('sloop-rudder'), (p) => p.y < 0.9); // the blade, below the tiller and rudder head
        expect(motor.intersectsBox(blade), `rudder ${r}, throttle ${throttle}`).toBe(false);
      }
      rig.setRudder(0);
    }
    runMotor(0, 1.2);
  });

  it('does not change the walkable deck', () => {
    const p = rig.status().propTip;
    expect(deck.heightAt(p.x, p.z)).toBeNull();
    expect(deck.heightAt(-4.5, -0.55)).toBeNull();
    expect(deck.insideLifelines(-4.5, -0.55)).toBe(false);
    expect(deck.heightAt(points.ladderTop.x, points.ladderTop.z)).toBeCloseTo(points.ladderTop.y, 2);
    expect(deck.insideLifelines(points.ladderTop.x, points.ladderTop.z)).toBe(true);
  });

  it('lights the right lamps for the mode, and only at night', () => {
    const lights = mesh('sloop-nav-lights');
    const col = () => lights.geometry.getAttribute('color').array as Float32Array;
    const lit = (test: (r: number, g: number, b: number) => boolean) => {
      const c = col();
      for (let i = 0; i < c.length; i += 4) if (c[i + 3] > 0.99 && test(c[i], c[i + 1], c[i + 2])) return true;
      return false;
    };
    rig.setLights('anchor', 0);
    expect(lit((r, g, b) => Math.max(r, g, b) > 1.01)).toBe(false); // daytime: plain lenses
    rig.setLights('anchor', 1);
    let st = rig.status().lights;
    expect(st.anchorOn && !st.sidelightsOn && !st.sternOn).toBe(true);
    expect(lit((r, g, b) => r > 2 && g > 2 && b > 2)).toBe(true); // white masthead light glowing
    expect(lit((r, g) => r > 2 && g < r / 3)).toBe(false);
    rig.setLights('underway', 1);
    st = rig.status().lights;
    expect(!st.anchorOn && st.sidelightsOn && st.sternOn).toBe(true);
    expect(lit((r, g) => r > 2 && g < r / 3)).toBe(true); // red to port
    expect(lit((r, g) => g > 2 && r < g / 3)).toBe(true); // green to starboard
    rig.setLights('anchor', 0);
  });
});
