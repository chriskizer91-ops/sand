import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FISH_KINDS, FISH_LENGTH, disposeFish, fishModel, fishTriangles, prepareFish, wiggle } from '../src/render/fish';
import { FishingLine, ROD_LENGTH, bentRodPoint, rodModel, rodTriangles } from '../src/render/fishingGear';
import { HeldView } from '../src/render/held';
import { disposeFindCache } from '../src/render/finds';
import { palm } from '../src/render/scenery';
import { createIslandLife, palmCrown } from '../src/render/islandLife';
import { WorldTerrain } from '../src/world/world';
import { mulberry32 } from '../src/engine/noise';

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
  });
  return out;
}
const tris = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
function materials(o: THREE.Object3D): Set<THREE.Material> {
  const out = new Set<THREE.Material>();
  for (const m of meshes(o)) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) out.add(mat);
  return out;
}
function finite(o: THREE.Object3D): boolean {
  for (const m of meshes(o)) {
    const p = m.geometry.getAttribute('position');
    const n = m.geometry.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) return false;
      if (n && Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) > 1e-3) return false;
    }
  }
  return true;
}

const LIGHT = { walking: 0, hide: false, sunDir: new THREE.Vector3(0.3, 0.8, 0.5).normalize(), sunColor: new THREE.Color(1, 0.95, 0.85), sunIntensity: 3, hemiIntensity: 0.5, env: null };

describe('fish models', () => {
  it('there are five Caribbean fish', () => {
    expect(FISH_KINDS).toEqual(['grunt', 'snapper', 'jack', 'bonefish', 'mahi']);
  });

  const real = { grunt: 0.25, snapper: 0.35, jack: 0.35, bonefish: 0.45, mahi: 0.9 };
  for (const kind of FISH_KINDS) {
    it(`${kind}: real length, head at +x, within budget, two materials`, () => {
      const f = fishModel(kind);
      const box = new THREE.Box3().setFromObject(f);
      const size = box.getSize(new THREE.Vector3());
      const n = fishTriangles(kind);
      console.log(`${kind.padEnd(9)} ${n} triangles, ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)} m`);
      // length along x, the real size within 15%
      expect(Math.abs(size.x - real[kind]) / real[kind]).toBeLessThan(0.15);
      expect(FISH_LENGTH[kind]).toBe(real[kind]);
      expect(size.x).toBeGreaterThan(size.y * 2);
      expect(size.y).toBeGreaterThan(size.z);
      // the snout (mouth) is the front end, at +x
      expect(f.userData.mouth.x).toBeCloseTo(box.max.x, 2);
      expect(f.userData.length).toBe(real[kind]);
      // centred on its bounding box
      expect(Math.abs(box.min.x + box.max.x)).toBeLessThan(0.002);
      expect(Math.abs(box.min.z + box.max.z)).toBeLessThan(0.002);
      expect(n).toBeGreaterThanOrEqual(800);
      expect(n).toBeLessThanOrEqual(2500);
      expect(n).toBe(meshes(f).reduce((a, m) => a + tris(m.geometry), 0));
      expect(materials(f).size).toBeLessThanOrEqual(2);
      expect(meshes(f).length).toBeLessThanOrEqual(2);
      expect(finite(f)).toBe(true);
    });
  }

  it('shares geometry between fish of a kind, but each fish wiggles on its own', () => {
    const a = fishModel('jack');
    const b = fishModel('jack');
    expect(meshes(a)[0].geometry).toBe(meshes(b)[0].geometry);
    expect(meshes(a)[0].material).not.toBe(meshes(b)[0].material);
    wiggle(a, 1, 1);
    wiggle(a, 1.05, 1);
    const wa = a.userData.wiggle as THREE.Vector4;
    const wb = b.userData.wiggle as THREE.Vector4;
    expect(wa.y).toBe(1);
    expect(wa.x).toBeGreaterThan(0);
    expect(wb.y).toBe(0);
    wiggle(a, 1.1, 0);
    expect(wa.y).toBe(0);
    disposeFish(a);
    disposeFish(b);
  });

  it('can be built ahead of time', () => {
    expect(() => prepareFish()).not.toThrow();
  });
});

describe('fishing rod', () => {
  it('fits the budget, with one material, and its tip is at the end', () => {
    const rod = rodModel();
    const n = rodTriangles();
    console.log(`rod and reel ${n} triangles`);
    expect(n).toBeLessThanOrEqual(3000);
    expect(meshes(rod.group).reduce((a, m) => a + tris(m.geometry), 0)).toBe(n);
    expect(materials(rod.group).size).toBe(1);
    expect(finite(rod.group)).toBe(true);
    const box = new THREE.Box3().setFromObject(rod.group);
    expect(box.max.x).toBeGreaterThan(ROD_LENGTH - 0.01);
    expect(box.max.x).toBeLessThan(ROD_LENGTH + 0.02);
    // the reel hangs below
    expect(box.min.y).toBeLessThan(-0.08);
    const tip = rod.tipLocal();
    expect(tip.x).toBeCloseTo(ROD_LENGTH, 1);
    expect(Math.abs(tip.y)).toBeLessThan(0.01);
  });

  it('bows toward the line as a fish pulls, the tip coming down and in', () => {
    const rod = rodModel();
    const straight = rod.tipLocal().clone();
    rod.setBend(1);
    const bent = rod.tipLocal().clone();
    expect(bent.y).toBeLessThan(straight.y - 0.3);
    expect(bent.x).toBeLessThan(straight.x);
    // about the same length along the curve: the tip doesn't stretch away
    expect(bent.length()).toBeLessThan(ROD_LENGTH + 0.01);
    // the grip and reel don't move
    const grip = bentRodPoint(0.27, -0.06, 1);
    expect(grip.x).toBeCloseTo(0.27, 6);
    expect(grip.y).toBeCloseTo(-0.06, 6);
    // and the bend is smooth along the rod
    let prev = bentRodPoint(0.45, 0, 1);
    for (let x = 0.5; x <= ROD_LENGTH; x += 0.05) {
      const p = bentRodPoint(x, 0, 1);
      expect(Math.hypot(p.x - prev.x, p.y - prev.y)).toBeCloseTo(0.05, 2);
      prev = p;
    }
  });
});

describe('held view (no renderer)', () => {
  it('switches between the basket, the rod and a fish', () => {
    const held = new HeldView();
    held.camera.aspect = 16 / 9;
    held.setContents(['cowrie', 'sand-dollar']);
    const step = (n: number) => {
      for (let i = 0; i < n; i++) held.update(1 / 30, LIGHT);
    };
    step(10);
    const visible = () => {
      const v: string[] = [];
      held.scene.traverseVisible((o) => {
        if (o.name === 'basket') v.push('basket');
        if (o.name === 'rod') v.push('rod');
        if (o.name.startsWith('fish:')) v.push(o.name);
      });
      return v;
    };
    expect(held.holdingNow).toBe('basket');
    expect(visible()).toEqual(['basket']);

    held.setHolding('rod');
    step(60);
    expect(held.holdingNow).toBe('rod');
    expect(visible()).toEqual(['rod']);
    const t = held.cast();
    expect(t).toBeGreaterThan(0.1);
    expect(t).toBeLessThan(1);
    held.bend(0.8);
    held.reelTurn(1.5);
    step(30);
    held.showCatch('snapper');
    expect(held.showingCatch).toBe(true);
    step(20);
    expect(visible()).toContain('fish:snapper');
    expect(visible()).toContain('rod');
    step(120);
    expect(held.showingCatch).toBe(false);
    expect(visible()).toEqual(['rod']);

    held.setHolding('fish', 'mahi');
    step(60);
    expect(visible()).toEqual(['fish:mahi']);

    held.setHolding('basket');
    step(60);
    expect(visible()).toEqual(['basket']);
    // the basket still takes finds and reaches for them
    held.setContents(['cowrie', 'sand-dollar', 'net', 'bottle', 'sailcloth']);
    held.pickupNudge();
    expect(() => step(5)).not.toThrow();
  });

  it('keeps the basket exactly where it always was while you hold it', () => {
    const held = new HeldView();
    held.camera.aspect = 16 / 9;
    const holder = (held as unknown as { holder: THREE.Group }).holder;
    held.update(1 / 30, { ...LIGHT, walking: 0.5 });
    // the formula from before the rod was added, after one frame
    const sway = (1 / 30) * (4.5 + 0.5 * 2.5);
    const dip = 0.5 * (1 - Math.exp((-1 / 30) * 4));
    const y = -0.56 + Math.sin(sway) * 0.01 * dip + Math.abs(Math.cos(sway * 0.5)) * 0.006 * dip;
    expect(holder.position.x).toBeCloseTo(-0.3 * Math.min(1.5, 16 / 9), 6);
    expect(holder.position.y).toBeCloseTo(y, 6);
    expect(holder.position.z).toBeCloseTo(-0.95, 6);
    expect(holder.rotation.z).toBeCloseTo(0.1 + Math.sin(sway * 0.5) * 0.03 * dip, 6);
    expect(holder.visible).toBe(true);
  });

  it('puts the rod tip in the world where it shows on screen', () => {
    const held = new HeldView();
    const aspect = 16 / 9;
    held.camera.aspect = aspect;
    held.camera.updateProjectionMatrix();
    held.setHolding('rod');
    for (let i = 0; i < 60; i++) held.update(1 / 30, LIGHT);
    const cam = new THREE.PerspectiveCamera(72, aspect, 0.05, 2500);
    cam.position.set(3, 2, 5);
    cam.lookAt(10, 0, -20);
    for (const depth of [0.6, 1.2, 3]) {
      const w = held.rodTipWorld(cam, new THREE.Vector3(), depth);
      expect(Number.isFinite(w.x + w.y + w.z)).toBe(true);
      // at that depth in front of the main camera...
      const inView = w.clone().applyMatrix4(cam.matrixWorldInverse);
      expect(-inView.z).toBeCloseTo(depth, 4);
      // ...and on the same spot of the screen as the drawn tip
      const onScreen = w.clone().project(cam);
      const drawn = held.rodTipHeld().applyMatrix4(held.camera.matrixWorldInverse).applyMatrix4(held.camera.projectionMatrix);
      expect(onScreen.x).toBeCloseTo(drawn.x, 4);
      expect(onScreen.y).toBeCloseTo(drawn.y, 4);
      // the tip is up and to the right of the middle, on screen
      expect(drawn.x).toBeGreaterThan(-0.2);
      expect(drawn.y).toBeGreaterThan(-0.2);
      expect(Math.abs(drawn.x)).toBeLessThan(1);
      expect(Math.abs(drawn.y)).toBeLessThan(1);
    }
  });
});

describe('fishing line', () => {
  it('is two draw calls in the world, and survives a whole fishing trip', () => {
    const line = new FishingLine();
    expect(meshes(line.group).length).toBe(2);
    expect(line.overWater.length).toBe(1);
    expect(line.group.visible).toBe(false);
    line.setOut(true);
    line.waterAt = (x, z) => 0.05 * Math.sin(x * 0.7 + z * 0.3);
    const tip = new THREE.Vector3(0, 2, 0);
    const fl = new THREE.Vector3(0, 0, -9);
    let t = 0;
    const run = (secs: number, tension: number) => {
      for (let i = 0; i < secs * 30; i++) {
        t += 1 / 30;
        fl.y = line.waterAt!(fl.x, fl.z);
        line.update(tip, fl, t, tension);
      }
    };
    line.landed();
    run(1, 0.1);
    line.bite(0.4);
    run(0.5, 0.2);
    line.bite(1);
    run(0.2, 0.3);
    // a strong bite pulls the float down under the water's surface
    expect(line.float.position.y).toBeLessThan(fl.y);
    line.fighting(1);
    for (let i = 0; i < 60; i++) {
      fl.z += 0.05; // reeling in
      run(1 / 30, 1);
    }
    line.fighting(0);
    run(1, 1);
    for (const m of meshes(line.group)) {
      const p = m.geometry.getAttribute('position');
      for (let i = 0; i < p.count; i++) expect(Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))).toBe(true);
    }
    // the line starts at the tip
    const fx = meshes(line.group).find((m) => m.name === 'fishingLineFx')!;
    const p0 = new THREE.Vector3().fromBufferAttribute(fx.geometry.getAttribute('position') as THREE.BufferAttribute, 0);
    expect(p0.distanceTo(tip)).toBeLessThan(1e-4);
    line.setOut(false);
    expect(line.group.visible).toBe(false);
  });
});

describe('palms and their coconuts', () => {
  it('each palm has a bunch of 3-5 coconuts, and builds from the same random numbers as before', () => {
    for (const seed of [1, 2, 3, 7, 11, 23]) {
      let calls = 0;
      const r = mulberry32(seed);
      const counted = () => {
        calls++;
        return r();
      };
      const first = mulberry32(seed)();
      const fronds = 9 + Math.floor(first * 3);
      const g = palm(4.5 + seed * 0.3, 0.2 + seed * 0.01, counted);
      // palm() asks for random numbers only for its fronds (4 each, plus 1 for how many),
      // so every plant and rock on the islands stays where it was
      expect(calls).toBe(1 + 4 * fronds);
      // trunk (17 x 8 vertices) + fronds (45 each) + coconuts (48 each)
      const nuts = (g.getAttribute('position').count - 136 - fronds * 45) / 48;
      expect(Number.isInteger(nuts)).toBe(true);
      expect(nuts).toBeGreaterThanOrEqual(3);
      expect(nuts).toBeLessThanOrEqual(5);
      // and no more than a few dozen triangles more than the old four plain spheres
      expect(tris(g)).toBeLessThanOrEqual(224 + 56 * 4 + fronds * 56 + 56);
    }
  });

  it('tells the game where each island palm crown is', () => {
    const world = new WorldTerrain();
    for (const island of [world.home, world.pink]) {
      const life = createIslandLife(island, { value: 0 });
      const palms = life.trunks.filter((t) => t.crown);
      expect(palms.length).toBeGreaterThan(10);
      for (const t of palms) {
        const c = t.crown!;
        const ground = island.heightAt(t.x, t.z);
        expect(c.y - ground).toBeGreaterThan(3);
        expect(c.y - ground).toBeLessThan(8.5);
        expect(Math.hypot(c.x - t.x, c.z - t.z)).toBeLessThan(0.6 * 8);
      }
    }
  });

  it('palmCrown follows the palm geometry when it is turned and moved', () => {
    const g = palm(6, 0.3, mulberry32(4));
    g.rotateY(1.1);
    g.translate(10, 1, -5);
    const c = palmCrown(6, 0.3, 1.1, 10, 1, -5);
    // the trunk's top ring sits round the crown point
    const p = g.getAttribute('position');
    let best = Infinity;
    for (let i = 0; i < 136; i++) best = Math.min(best, Math.hypot(p.getX(i) - c.x, p.getY(i) - c.y, p.getZ(i) - c.z));
    expect(best).toBeLessThan(0.2);
  });
});

afterAll(() => disposeFindCache());
