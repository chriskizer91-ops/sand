// Checks for the catamaran (src/render/catamaran.ts): it builds within the phone budget, every spot
// aboard is where it says at the right level, the stairs and walls work, and the rig moves.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCatamaran } from '../src/render/catamaran';

const boat = createCatamaran();
const { deck, points, rig } = boat;
boat.group.updateMatrixWorld(true);

const R = 0.224; // the game's player radius (0.28) times the 0.8 it uses for blocked()
const STEP = 0.45;
const meshes: THREE.Mesh[] = [];
boat.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
});
const mesh = (name: string) => boat.group.getObjectByName(name) as THREE.Mesh;
/** Fixed surfaces you can stand on (not glass, net, water, lines or moving parts). */
const standable = ['cat-teak', 'cat-gelcoat', 'cat-varnish', 'cat-nonskid', 'cat-cloth', 'cat-decals', 'cat-cabins'].map(mesh);

/** The first standable surface straight below (x, from, z). */
function visibleBelow(x: number, from: number, z: number): number | null {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0), 0, 6);
  const hits = ray.intersectObjects(standable, false);
  return hits.length ? hits[0].point.y : null;
}
/** Boat-local positions of a mesh's vertices (its own transform applied). */
function verts(m: THREE.Mesh, keep: (p: THREE.Vector3) => boolean = () => true): THREE.Vector3[] {
  boat.group.updateMatrixWorld(true);
  const toBoat = new THREE.Matrix4().copy(boat.group.matrixWorld).invert().multiply(m.matrixWorld);
  const p = m.geometry.getAttribute('position');
  const out: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(toBoat);
    if (keep(v)) out.push(v.clone());
  }
  return out;
}
function checkFinite(): void {
  for (const m of meshes) {
    const p = m.geometry.getAttribute('position').array;
    for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) throw new Error(`${m.name}: bad vertex`);
  }
}

const STANDING = ['spawn', 'helm', 'locker', 'galley', 'chart', 'pump', 'workbench', 'bunk', 'ladderTop'] as const;

describe('catamaran model', () => {
  it('builds within the phone budget (<= 20 draw calls, <= 90k triangles)', () => {
    let tris = 0;
    for (const m of meshes) tris += (m.geometry.index as THREE.BufferAttribute).count / 3;
    console.log(`catamaran: ${tris} triangles in ${meshes.length} meshes`);
    expect(tris).toBe(boat.triangles);
    expect(meshes.length).toBeLessThanOrEqual(20);
    expect(tris).toBeLessThanOrEqual(90000);
  });

  it('is a 45 ft catamaran: 13.7 m long, hulls 2.75 m either side, about 1.3 m draft', () => {
    expect(boat.length).toBeCloseTo(13.7, 1);
    expect(boat.beam).toBeGreaterThan(7);
    expect(boat.beam).toBeLessThan(8);
    const box = new THREE.Box3().setFromObject(mesh('cat-hulls'), true);
    expect(box.max.x - box.min.x).toBeGreaterThan(13.5);
    expect(box.min.y).toBeCloseTo(-boat.draft, 1);
    expect(box.max.z).toBeCloseTo(3.75, 1);
    expect(box.min.z).toBeCloseTo(-3.75, 1);
  });

  it('casts shadows from its solid parts, never from glass, glows, water or the net', () => {
    const seeThrough = ['cat-glass', 'cat-lights', 'cat-water', 'cat-water-mask', 'cat-trampoline'];
    for (const m of meshes) {
      if (seeThrough.includes(m.name)) expect(m.customDepthMaterial, m.name).toBeTruthy();
      else expect(m.castShadow, m.name).toBe(true);
    }
    expect(mesh('cat-teak').receiveShadow).toBe(true);
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
});

describe('the multi-level deck', () => {
  it('has every spot on a walkable surface at its own level, inside the rails and clear', () => {
    for (const k of STANDING) {
      const p = points[k];
      expect(deck.heightAt(p.x, p.z, p.y), k).toBeCloseTo(p.y, 2);
      expect(deck.insideLifelines(p.x, p.z, p.y), k).toBe(true);
      expect(deck.blocked(p.x, p.z, R, p.y), k).toBe(false);
      const seen = visibleBelow(p.x, p.y + 0.9, p.z);
      expect(seen, `${k}: something visible underfoot`).not.toBeNull();
      expect(Math.abs((seen as number) - p.y), `${k}: heightAt ${p.y} vs visible ${seen}`).toBeLessThan(0.03);
    }
    // the levels are the ones promised
    expect(points.spawn.y).toBeCloseTo(1.5, 2);
    expect(points.galley.y).toBeCloseTo(1.5, 2);
    expect(points.chart.y).toBeCloseTo(1.5, 2);
    expect(points.helm.y).toBeGreaterThan(3.3);
    expect(points.bunk.y).toBeLessThan(0);
    expect(points.workbench.y).toBeLessThan(0);
    expect(points.ladderTop.y).toBeLessThan(0.6);
    expect(points.ladderBottom.y).toBeLessThan(-0.3);
    expect(Math.hypot(points.ladderTop.x - points.ladderBottom.x, points.ladderTop.z - points.ladderBottom.z)).toBeLessThan(0.7);
  });

  it('puts each spot next to the thing it is for', () => {
    const f = boat.fittings;
    const near = (p: THREE.Vector3, b: THREE.Box3, d: number) => b.distanceToPoint(new THREE.Vector3(p.x, Math.min(Math.max(p.y + 1, b.min.y), b.max.y), p.z)) < d;
    expect(near(points.galley, f.galley, 0.7), 'galley').toBe(true);
    expect(near(points.chart, f.chartTable, 0.7), 'chart table').toBe(true);
    expect(near(points.workbench, f.workbench, 0.6), 'workbench').toBe(true);
    expect(near(points.bunk, f.bunk, 0.7), 'bunk').toBe(true);
    expect(near(points.pump, f.pump, 0.7), 'pump').toBe(true);
    expect(near(points.helm, f.helm, 0.8), 'helm').toBe(true);
    expect(f.locker.containsPoint(points.locker.clone().add(new THREE.Vector3(0, -0.02, 0))), 'locker lid').toBe(true);
    // the workbench is at a comfortable height above the workshop floor
    expect(f.workbench.max.y - points.workbench.y).toBeGreaterThan(0.75);
  });

  it('has four pot spots that each fit a 28 cm pot on the planter shelf, in the sun', () => {
    const shelf = boat.fittings.potShelf;
    expect(points.potShelf.length).toBe(4);
    for (const p of points.potShelf) {
      expect(deck.heightAt(p.x, p.z, p.y)).toBeCloseTo(p.y, 2);
      for (let a = 0; a < 8; a++) {
        const x = p.x + 0.14 * Math.cos((a * Math.PI) / 4);
        const z = p.z + 0.14 * Math.sin((a * Math.PI) / 4);
        expect(deck.heightAt(x, z, p.y), 'the whole pot base is on the shelf').toBeCloseTo(p.y, 2);
      }
      expect(deck.ceilingAt(p.x, p.z, p.y), 'open sky above').toBeNull();
      expect(shelf.containsPoint(new THREE.Vector3(p.x, shelf.min.y + 0.01, p.z))).toBe(true);
    }
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(points.potShelf[i].distanceTo(points.potShelf[j])).toBeGreaterThan(0.3);
  });

  it('lets you walk step by step from the cockpit to every level and spot (no step over 0.45 m, never through a ceiling)', () => {
    // Flood fill over a 5 cm grid, carrying the height of your feet: you move only where heightAt (asked at your
    // level) gives a surface within a step up or down, inside the rails and not blocked.
    const g = 0.05;
    const X0 = -7.2;
    const Z0 = -4;
    const nx = Math.round(14.4 / g) + 1;
    const nz = Math.round(8 / g) + 1;
    const X = (i: number) => X0 + i * g;
    const Z = (k: number) => Z0 + k * g;
    const seen = new Set<string>();
    const key = (i: number, k: number, h: number) => `${i},${k},${Math.round(h * 100)}`;
    const reached = new Map<number, Set<number>>(); // cell -> heights (cm)
    const cellOf = (x: number, z: number) => [Math.round((x - X0) / g), Math.round((z - Z0) / g)];
    const [si, sk] = cellOf(points.spawn.x, points.spawn.z);
    const queue: [number, number, number][] = [[si, sk, points.spawn.y]];
    seen.add(key(si, sk, points.spawn.y));
    let worstStep = 0;
    while (queue.length) {
      const [i, k, y] = queue.pop() as [number, number, number];
      const c = i * nz + k;
      if (!reached.has(c)) reached.set(c, new Set());
      (reached.get(c) as Set<number>).add(Math.round(y * 100));
      for (const [di, dk] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ii = i + di;
        const kk = k + dk;
        if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
        const x = X(ii);
        const z = Z(kk);
        const h = deck.heightAt(x, z, y);
        if (h === null || Math.abs(h - y) > STEP) continue;
        if (!deck.insideLifelines(x, z, y) || deck.blocked(x, z, R, y)) continue;
        const ceil = deck.ceilingAt(X(i), Z(k), y);
        if (ceil !== null && h > ceil) throw new Error(`rose through a ceiling at ${x.toFixed(2)}, ${z.toFixed(2)}: ${y} -> ${h}`);
        const kh = key(ii, kk, h);
        if (seen.has(kh)) continue;
        seen.add(kh);
        worstStep = Math.max(worstStep, Math.abs(h - y));
        queue.push([ii, kk, h]);
      }
    }
    expect(worstStep).toBeLessThanOrEqual(STEP);
    const reach = (p: THREE.Vector3) => {
      const [i, k] = cellOf(p.x, p.z);
      const hs = reached.get(i * nz + k);
      return !!hs && [...hs].some((h) => Math.abs(h / 100 - p.y) < 0.05);
    };
    for (const k of STANDING) expect(reach(points[k]), k).toBe(true);
    const at = (x: number, z: number, y: number) => new THREE.Vector3(x, deck.heightAt(x, z, y) as number, z);
    expect(reach(at(5.3, 1.2, 1.5)), 'the trampoline').toBe(true);
    expect(reach(at(5.6, -2.75, 1.7)), 'the port bow').toBe(true);
    expect(reach(new THREE.Vector3(-6.62, 0.35, -2.75)), 'the port swim platform').toBe(true);
    expect(reach(new THREE.Vector3(0.5, 3.66, -1.5)), 'the flybridge').toBe(true);
    expect(reach(new THREE.Vector3(3.1, -0.5, 2.75)), 'the starboard forward cabin, by its berth').toBe(true);
  });

  it('has hull stairs of comfortable treads (no rise over 0.3 m) and steep steps up to the flybridge', () => {
    for (const z of [-2.62, 2.62]) {
      let prev = 1.5;
      let steps = 0;
      for (let x = -1.0; x <= 1.6; x += 0.02) {
        const h = deck.heightAt(x, z, prev) as number;
        expect(h, `hull stairs at x ${x.toFixed(2)}`).not.toBeNull();
        expect(prev - h).toBeLessThanOrEqual(0.3);
        if (h < prev - 0.01) steps++;
        prev = h;
      }
      expect(prev).toBeCloseTo(-0.5, 2);
      expect(steps).toBeGreaterThanOrEqual(6);
    }
    let prev = 1.5;
    for (let x = -4.4; x <= -2.2; x += 0.02) {
      const h = deck.heightAt(x, -2.15, prev) as number;
      expect(h - prev).toBeLessThanOrEqual(0.35);
      prev = h;
    }
    expect(prev).toBeCloseTo(3.66, 2);
  });

  it('never pops you up through a floor or ceiling', () => {
    for (let x = 1.4; x <= 3.3; x += 0.1) {
      for (const z of [-2.75, 2.75]) {
        expect(deck.heightAt(x, z, -0.5), 'in a hull cabin, under the saloon floor').toBeCloseTo(-0.5, 2);
        expect(deck.ceilingAt(x, z, -0.5)).not.toBeNull();
      }
    }
    for (let x = -1.2; x <= 3.0; x += 0.2) {
      for (let z = -1.0; z <= 1.0; z += 0.2) {
        const h = deck.heightAt(x, z, 1.5);
        if (h !== null) expect(h, 'in the saloon, under the flybridge').toBeLessThan(2.0);
      }
    }
    // with no y given, the highest surface: the roof over the saloon
    expect(deck.heightAt(0, 0)).toBeGreaterThan(3.3);
  });

  it('has standing headroom in the saloon, the cockpit and both hull cabins', () => {
    for (let x = -1.2; x <= 3.0; x += 0.3) {
      for (let z = -2.6; z <= 2.6; z += 0.4) {
        const h = deck.heightAt(x, z, 1.5);
        if (h === null || h < 1.4) continue;
        expect((deck.ceilingAt(x, z, h) as number) - h, `saloon at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeGreaterThanOrEqual(1.9);
      }
    }
    expect((deck.ceilingAt(points.spawn.x, points.spawn.z, 1.5) as number) - 1.5).toBeGreaterThanOrEqual(1.9);
    for (let x = 1.3; x <= 3.3; x += 0.2) {
      for (const z of [-2.75, 2.75]) expect((deck.ceilingAt(x, z, -0.5) as number) + 0.5, `hull cabin at ${x.toFixed(1)}`).toBeGreaterThanOrEqual(1.9);
    }
    expect(deck.ceilingAt(points.helm.x, points.helm.z, points.helm.y)).toBeNull();
  });

  it('stops you at the saloon walls, but not up on the roof', () => {
    expect(deck.blocked(-1.4, 2.0, R, 1.5), 'aft wall, beside the door').toBe(true);
    expect(deck.blocked(-1.4, 2.0, R, 3.66), 'on the roof above it').toBe(false);
    expect(deck.blocked(1.0, 2.9, R, 1.5), 'side wall').toBe(true);
    expect(deck.blocked(0.0, -1.5, R, 3.66), 'the flybridge').toBe(false);
    expect(deck.blocked(0.0, -2.7, R, 3.66), 'the flybridge rail').toBe(true);
    expect(deck.blocked(2.05, 0, R, 1.5), 'the dinette table').toBe(true);
    // the big sliding door: open by default, closed it stops you
    expect(rig.status().hatchOpen).toBe(1);
    expect(deck.blocked(-1.4, 0, R, 1.5)).toBe(false);
    rig.setHatch(0);
    expect(deck.blocked(-1.4, 0, R, 1.5)).toBe(true);
    rig.setHatch(1);
    expect(deck.blocked(-1.4, 0, R, 1.5)).toBe(false);
    // in a hull, its sides are walls
    expect(deck.blocked(2.8, -2.75 - 0.5, R, -0.5)).toBe(true);
    expect(deck.blocked(2.8, -2.75, R, -0.5)).toBe(false);
  });

  it('knows where the rails are, level by level', () => {
    expect(deck.insideLifelines(0, 3.3, 1.5), 'side deck').toBe(true);
    expect(deck.insideLifelines(0, 4.2, 1.5), 'over the side').toBe(false);
    expect(deck.insideLifelines(5.3, 1.2, 1.5), 'trampoline').toBe(true);
    expect(deck.insideLifelines(0.0, 0.5, 3.66), 'inside the flybridge rails').toBe(true);
    expect(deck.insideLifelines(2.5, 0.5, 3.66), 'the roof forward of the flybridge rails').toBe(false);
    expect(deck.heightAt(0, 0, 0.5), 'open water between the hulls').toBeNull();
    expect(deck.heightAt(0, 6, 1.5)).toBeNull();
    expect(deck.heightAt(9, 0, 1.5)).toBeNull();
  });

  it('gives swimmers a footprint covering both hulls and the water under the bridgedeck', () => {
    for (let z = -3.4; z <= 3.4; z += 0.2) expect(deck.footprintPen(0, z), `x 0, z ${z.toFixed(1)}`).toBeGreaterThan(0);
    expect(deck.footprintPen(0, 2.75)).toBeGreaterThan(0.9);
    expect(deck.footprintPen(-3, -2.75)).toBeGreaterThan(0.9);
    expect(deck.footprintPen(0, 0)).toBeGreaterThan(0.5);
    expect(deck.footprintPen(0, 4.5)).toBe(0);
    expect(deck.footprintPen(-8.5, 0)).toBe(0);
    expect(deck.footprintPen(8.5, 2.75)).toBe(0);
    expect(deck.footprintPen(points.ladderBottom.x - 0.3, points.ladderBottom.z)).toBe(0);
  });

  it('keeps halfBeam as the overall half-width (both hulls)', () => {
    expect(deck.halfBeam(0, true)).toBeCloseTo(3.75, 1);
    expect(deck.halfBeam(0, false)).toBeGreaterThan(3.4);
    expect(deck.halfBeam(0, false)).toBeLessThanOrEqual(deck.halfBeam(0, true));
    for (const x of [-7.5, 7.5]) {
      expect(deck.halfBeam(x, true)).toBe(0);
      expect(deck.halfBeam(x, false)).toBe(0);
    }
  });
});

describe('the rig', () => {
  const reset = () => {
    rig.setSail(0);
    rig.setBoom(0);
    rig.setJib(0);
    rig.setFill(1, 0);
    rig.setRudder(0);
    rig.setAnchored(true);
    rig.setLights('anchor', 0);
    rig.setGalleyLight(false);
    rig.setAwning(0, false);
    rig.setTrap(false);
    rig.setRodStowed(true);
    rig.setBilge(0);
    rig.setPump(0);
  };

  it('furls and hoists the sails', () => {
    reset();
    let st = rig.status();
    expect(st.coverShown).toBe(true);
    expect(mesh('cat-sails').visible).toBe(false);
    rig.setSail(1);
    rig.setBoom(-0.6);
    rig.setJib(-0.45);
    st = rig.status();
    expect(st.coverShown).toBe(false);
    expect(mesh('cat-sails').visible).toBe(true);
    expect(st.mainHead.y).toBeGreaterThan(20);
    expect(st.jibClew.z).toBeLessThan(-1);
    rig.setSail(0.5);
    expect(rig.status().mainHead.y).toBeGreaterThan(12);
    expect(rig.status().mainHead.y).toBeLessThan(16);
    rig.setFill(0, 0);
    const a = Float32Array.from(mesh('cat-sails').geometry.getAttribute('position').array);
    rig.setFill(0, 0.4);
    const b = mesh('cat-sails').geometry.getAttribute('position').array;
    expect(a.some((v, i) => Math.abs(v - b[i]) > 0.02), 'luffing ripples').toBe(true);
    checkFinite();
    reset();
  });

  it('swings the boom about the gooseneck, clear of the flybridge crew', () => {
    reset();
    rig.setBoom(0.8);
    expect(rig.status().boomEnd.z).toBeGreaterThan(2);
    rig.setBoom(-0.8);
    expect(rig.status().boomEnd.z).toBeLessThan(-2);
    for (const a of [-1.2, 0, 1.2]) {
      rig.setBoom(a);
      // the part of the boom over the flybridge (not the vang, which runs down to the mast forward of it)
      const low = Math.min(...verts(mesh('cat-boom'), (p) => p.x < 1.2 && Math.abs(p.z) < 2.6).map((p) => p.y));
      expect(low - 3.66, 'boom above a standing person on the flybridge').toBeGreaterThan(1.85);
    }
    reset();
  });

  it('turns both rudders and the wheel together', () => {
    reset();
    const wheelVerts = () => verts(mesh('cat-woodwork'), (p) => p.y > 4.0 && p.x > 0.4 && p.x < 0.95);
    const w0 = wheelVerts();
    rig.setRudder(0.4);
    const st = rig.status();
    expect(st.rudderTrailingEdges[0].z).toBeGreaterThan(-2.75 + 0.1);
    expect(st.rudderTrailingEdges[1].z).toBeGreaterThan(2.75 + 0.1);
    expect(st.wheelAngle).toBeGreaterThan(1);
    const w1 = wheelVerts();
    expect(w1.length).toBe(w0.length);
    expect(w0.some((p, i) => p.distanceTo(w1[i]) > 0.1), 'the wheel turned').toBe(true);
    // the blades themselves moved to starboard at their trailing edges
    const blades = verts(mesh('cat-woodwork'), (p) => p.y < -0.5 && p.x < -5.7);
    expect(blades.filter((p) => p.z > 0).every((p) => p.z > 2.75 + 0.05)).toBe(true);
    rig.setRudder(-0.4);
    expect(rig.status().rudderTrailingEdges[1].z).toBeLessThan(2.75 - 0.1);
    reset();
  });

  it('spins the two saildrive propellers under the hulls', () => {
    reset();
    const st0 = rig.status();
    for (const p of st0.propTips) expect(p.y).toBeLessThan(-0.5);
    expect(st0.propTips[0].z).toBeLessThan(0);
    expect(st0.propTips[1].z).toBeGreaterThan(0);
    const props = () => Float32Array.from(mesh('cat-moving-metal').geometry.getAttribute('position').array);
    rig.setMotor(0, 10);
    const a = props();
    for (let t = 10; t < 10.5; t += 1 / 30) rig.setMotor(1, t);
    const b = props();
    expect(rig.status().throttle).toBe(1);
    expect(a.some((v, i) => Math.abs(v - b[i]) > 0.01), 'props and levers moved').toBe(true);
    const angle = rig.status().propAngle;
    for (let t = 10.5; t < 10.7; t += 1 / 30) rig.setMotor(-1, t);
    expect(rig.status().propAngle).not.toBeCloseTo(angle, 3);
    rig.setMotor(0, 11);
    checkFinite();
  });

  it('shows the anchor light at anchor and the sidelights and sternlights underway', () => {
    reset();
    rig.setLights('anchor', 1);
    let l = rig.status().lights;
    expect(l.anchorOn && !l.sidelightsOn && !l.sternOn).toBe(true);
    rig.setLights('underway', 1);
    l = rig.status().lights;
    expect(!l.anchorOn && l.sidelightsOn && l.sternOn).toBe(true);
    const c = mesh('cat-lights').geometry.getAttribute('color').array as Float32Array;
    const lit = (f: (r: number, g: number, b: number) => boolean) => {
      for (let i = 0; i < c.length; i += 4) if (c[i + 3] > 0.99 && f(c[i], c[i + 1], c[i + 2])) return true;
      return false;
    };
    expect(lit((r, g) => r > 2 && g < r / 3), 'red to port').toBe(true);
    expect(lit((r, g) => g > 2 && r < g / 3), 'green to starboard').toBe(true);
    rig.setGalleyLight(true);
    expect(rig.status().lights.interiorOn).toBe(true);
    expect(lit((r, g, b) => r > 1 && b < r * 0.5), 'warm lamps inside').toBe(true);
    reset();
  });

  it('works the anchor, pump, bilge, rain gutters and catcher, trap and rod', () => {
    reset();
    const lines = mesh('cat-rig-lines');
    expect(Math.min(...verts(lines).map((p) => p.y))).toBeLessThan(-1);
    rig.setAnchored(false);
    expect(Math.min(...verts(lines).map((p) => p.y))).toBeGreaterThan(0);
    expect(rig.status().anchorStowedShown).toBe(true);
    rig.setPump(0);
    const p0 = Float32Array.from(mesh('cat-moving-metal').geometry.getAttribute('position').array);
    rig.setPump(1);
    const p1 = mesh('cat-moving-metal').geometry.getAttribute('position').array;
    expect(p0.some((v, i) => Math.abs(v - p1[i]) > 0.1), 'pump handle swings').toBe(true);
    const water = () => verts(mesh('cat-water'), (p) => p.y < 0);
    rig.setBilge(0.5);
    expect(water().length).toBe(0);
    rig.setBilge(0.9, 2);
    expect(water().length).toBeGreaterThan(0);
    rig.setAwning(1, false);
    expect(verts(mesh('cat-water'), (p) => p.y > 3.5).length, 'water in the gutters').toBeGreaterThan(0);
    expect(rig.status().awning.clothBox).toBeNull();
    rig.setAwning(1, true);
    const cb = rig.status().awning.clothBox as THREE.Box3;
    expect(cb.min.y - 1.5, 'the canvas catcher is above head height in the cockpit').toBeGreaterThan(1.85);
    rig.setTrap(true);
    const trap = verts(mesh('cat-woodwork'), (p) => p.y < -0.6 && p.z > 3.8);
    expect(trap.length).toBeGreaterThan(0);
    rig.setRodStowed(false);
    expect(verts(mesh('cat-woodwork'), (p) => p.y > 2.2 && p.z < -3.3).length).toBe(0);
    rig.setRodStowed(true);
    expect(verts(mesh('cat-woodwork'), (p) => p.y > 2.2 && p.z < -3.3).length).toBeGreaterThan(0);
    checkFinite();
    reset();
  });

  it('stays within budget with everything out', () => {
    rig.setSail(1);
    rig.setBoom(1.2);
    rig.setJib(1);
    rig.setFill(0.2, 3);
    rig.setRudder(0.6);
    rig.setAnchored(false);
    rig.setMotor(0.8, 20);
    rig.setLights('underway', 1);
    rig.setGalleyLight(true);
    rig.setBilge(1, 2);
    rig.setAwning(1, true);
    rig.setTrap(true);
    let tris = 0;
    for (const m of meshes) tris += (m.geometry.index as THREE.BufferAttribute).count / 3;
    expect(meshes.length).toBeLessThanOrEqual(20);
    expect(tris).toBeLessThanOrEqual(90000);
    checkFinite();
    reset();
  });
});
