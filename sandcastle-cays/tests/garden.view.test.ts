// Checks for the garden models (src/render/garden.ts, gardenPlants.ts, wateringCan.ts) and the
// watering can in your hands (src/render/held.ts): every crop builds at every stage, within the
// phone budget; null clears a plant; the pot, bed, barrel and sign are their real sizes and at most
// two draw calls; HeldView switches to the can and back, and pours.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BARREL,
  BED,
  CROP_KINDS,
  DECK_POT_SCALE,
  GARDEN_SOIL,
  PLANT_STAGES,
  POT,
  PlantView,
  THIRST_STEPS,
  barrelModel,
  bedModel,
  potModel,
  signModel,
  type CropKind,
} from '../src/render/garden';
import { HeldView } from '../src/render/held';
import { canModel, canTriangles } from '../src/render/wateringCan';
import { createSloop } from '../src/render/sloop';

function meshes(o: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
  });
  return out;
}
const visibleMeshes = (o: THREE.Object3D): THREE.Mesh[] => meshes(o).filter((m) => m.visible);
const tris = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
const triangles = (o: THREE.Object3D): number => visibleMeshes(o).reduce((n, m) => n + tris(m.geometry), 0);

/** Positions finite and normals unit length. */
function sane(o: THREE.Object3D): boolean {
  for (const m of visibleMeshes(o)) {
    const p = m.geometry.getAttribute('position');
    const n = m.geometry.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) return false;
      if (n && Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) > 1e-3) return false;
    }
  }
  return true;
}

/** Share of a mesh's (non-degenerate) triangles whose winding agrees with their vertex normals: the side you see is the front. */
function facingOut(m: THREE.Mesh): number {
  const g = m.geometry;
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const idx = g.index!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const vn = new THREE.Vector3();
  let good = 0;
  let all = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const [i, j, k] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, j);
    c.fromBufferAttribute(p, k);
    fn.subVectors(b, a).cross(c.sub(a));
    if (fn.lengthSq() < 1e-14) continue;
    vn.set(n.getX(i) + n.getX(j) + n.getX(k), n.getY(i) + n.getY(j) + n.getY(k), n.getZ(i) + n.getZ(j) + n.getZ(k));
    all++;
    if (fn.dot(vn) > 0) good++;
  }
  return all ? good / all : 1;
}

const stages = Array.from({ length: PLANT_STAGES }, (_, s) => s / (PLANT_STAGES - 1));

describe('plants', () => {
  for (const size of ['pot', 'bed'] as const) {
    for (const crop of CROP_KINDS) {
      it(`${crop} in a ${size}: within budget when fully grown`, () => {
        for (const ripe of [false, true]) {
          const p = new PlantView(size, 7);
          p.set(crop, 1, 0, ripe);
          const n = triangles(p.group);
          console.log(`${crop.padEnd(12)} ${size} ${ripe ? 'ripe    ' : 'growing '} ${n} triangles, ${p.drawCalls} draw calls`);
          expect(p.triangles).toBe(n);
          expect(n).toBeGreaterThan(400);
          expect(n).toBeLessThanOrEqual(2000);
          expect(visibleMeshes(p.group).length).toBeLessThanOrEqual(2);
          expect(p.drawCalls).toBe(visibleMeshes(p.group).length);
          // the solid parts are drawn one-sided, so they must face out
          for (const m of visibleMeshes(p.group)) if (m.name === 'plant-fruit') expect(facingOut(m)).toBeGreaterThan(0.97);
          p.dispose();
        }
      });

      it(`${crop} in a ${size}: builds at every growth step, thirsty or not, ripe or not`, () => {
        let last = 0;
        for (const g of stages) {
          for (let t = 0; t < THIRST_STEPS; t++) {
            for (const ripe of [false, true]) {
              const p = new PlantView(size, 3);
              p.set(crop, g, t / (THIRST_STEPS - 1), ripe);
              expect(p.triangles).toBeGreaterThan(0);
              expect(p.triangles).toBeLessThanOrEqual(2000);
              expect(p.drawCalls).toBeGreaterThanOrEqual(1);
              expect(p.drawCalls).toBeLessThanOrEqual(2);
              expect(sane(p.group)).toBe(true);
              if (t === 0 && !ripe) {
                // it grows: more to draw at each step
                expect(p.triangles).toBeGreaterThan(last);
                last = p.triangles;
              }
              p.dispose();
            }
          }
        }
      });
    }
  }

  it('fits: a pot plant over its pot, a bed plant over its bed', () => {
    for (const crop of CROP_KINDS) {
      const pot = new PlantView('pot', 5);
      pot.set(crop, 1, 0, true);
      const a = new THREE.Box3().setFromObject(pot.group);
      // spreads out a little past the rim, and not too tall for the cabin top (the boom is about 1.1 m up)
      expect(Math.max(-a.min.x, a.max.x, -a.min.z, a.max.z)).toBeLessThan(0.4);
      expect(a.max.y).toBeLessThan(0.75);
      // trailing vines hang no lower than the foot of the pot
      expect(a.min.y).toBeGreaterThan(-GARDEN_SOIL.pot);
      const bed = new PlantView('bed', 5);
      bed.set(crop, 1, 0, true);
      const b = new THREE.Box3().setFromObject(bed.group);
      // (sweet potato leaves spill a hand's width over the sides)
      const over = crop === 'sweetpotato' ? 0.16 : 0.06;
      expect(b.max.x).toBeLessThan(BED.length / 2 + over);
      expect(b.min.x).toBeGreaterThan(-BED.length / 2 - over);
      expect(b.max.z).toBeLessThan(BED.width / 2 + over);
      expect(b.min.z).toBeGreaterThan(-BED.width / 2 - over);
      expect(b.min.y).toBeGreaterThan(-GARDEN_SOIL.bed);
      expect(b.max.y).toBeLessThan(1.15);
    }
  });

  it('null is bare soil: nothing drawn', () => {
    for (const crop of CROP_KINDS) {
      const p = new PlantView('pot');
      p.set(crop, 0.5, 0, false);
      expect(p.drawCalls).toBeGreaterThan(0);
      p.set(null, 0.5, 0, false);
      expect(p.drawCalls).toBe(0);
      expect(p.triangles).toBe(0);
      expect(visibleMeshes(p.group).length).toBe(0);
      // and it can grow again
      p.set(crop, 1, 0, true);
      expect(p.drawCalls).toBeGreaterThan(0);
    }
    const fresh = new PlantView('bed');
    fresh.set(null, 0, 0, false);
    expect(fresh.drawCalls).toBe(0);
  });

  it('only rebuilds when the step changes; odd numbers are safe', () => {
    const p = new PlantView('pot', 2);
    p.set('tomato', 0.5, 0, false);
    const geo = meshes(p.group)[0].geometry;
    p.set('tomato', 0.52, 0.04, false); // same steps
    expect(meshes(p.group)[0].geometry).toBe(geo);
    p.set('tomato', 0.75, 0, false);
    expect(meshes(p.group)[0].geometry).not.toBe(geo);
    for (const [g, t] of [
      [NaN, 0],
      [-3, 9],
      [Infinity, -Infinity],
    ]) {
      p.set('callaloo', g, t, false);
      expect(sane(p.group)).toBe(true);
      expect(p.triangles).toBeGreaterThan(0);
    }
  });

  it('thirsty plants droop and yellow', () => {
    const tipHeight = (o: THREE.Object3D): number => {
      let sum = 0;
      let n = 0;
      for (const m of meshes(o)) {
        if (m.name !== 'plant-leaves' || !m.visible) continue;
        const p = m.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i++) {
          sum += p.getY(i);
          n++;
        }
      }
      return sum / n;
    };
    const yellow = (o: THREE.Object3D): number => {
      const m = meshes(o).find((x) => x.name === 'plant-leaves')!;
      const y = m.geometry.getAttribute('yellow');
      let s = 0;
      for (let i = 0; i < y.count; i++) s += y.getX(i);
      return s / y.count;
    };
    for (const crop of CROP_KINDS) {
      const wet = new PlantView('pot', 9);
      wet.set(crop, 1, 0, false);
      const dry = new PlantView('pot', 9);
      dry.set(crop, 1, 1, false);
      expect(tipHeight(dry.group)).toBeLessThan(tipHeight(wet.group) - 0.005);
      expect(yellow(wet.group)).toBe(0);
      expect(yellow(dry.group)).toBeGreaterThan(0.3);
    }
  });

  it('ripe tomatoes are red, growing ones green; ripe sweet potatoes show their tubers', () => {
    const redFruit = (o: THREE.Object3D): number => {
      const m = meshes(o).find((x) => x.name === 'plant-fruit')!;
      const c = m.geometry.getAttribute('color');
      let n = 0;
      for (let i = 0; i < c.count; i++) if (c.getX(i) > 0.3 && c.getX(i) > c.getY(i) * 4) n++;
      return n;
    };
    const green = new PlantView('pot', 4);
    green.set('tomato', 1, 0, false);
    const red = new PlantView('pot', 4);
    red.set('tomato', 1, 0, true);
    expect(redFruit(green.group)).toBe(0);
    expect(redFruit(red.group)).toBeGreaterThan(50);
    const sp = new PlantView('pot', 4);
    sp.set('sweetpotato', 1, 0, false);
    const spRipe = new PlantView('pot', 4);
    spRipe.set('sweetpotato', 1, 0, true);
    expect(spRipe.triangles).toBeGreaterThan(sp.triangles + 100);
    // the callaloo's plume is bigger once ripe
    const cal = new PlantView('pot', 4);
    cal.set('callaloo', 1, 0, false);
    const calRipe = new PlantView('pot', 4);
    calRipe.set('callaloo', 1, 0, true);
    const top = (o: THREE.Object3D): number => new THREE.Box3().setFromObject(o).max.y;
    expect(top(calRipe.group)).toBeGreaterThan(top(cal.group) + 0.02);
  });

  it('sways: update sets the breeze clock the plants share', () => {
    const p = new PlantView('pot');
    p.set('callaloo', 1, 0, false);
    p.update(12.5);
    const m = meshes(p.group)[0].material as THREE.MeshStandardMaterial;
    const shader = { uniforms: {} as Record<string, { value: number }>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <color_fragment>' };
    m.onBeforeCompile(shader as never, null as never);
    expect(shader.uniforms.uGardenTime.value).toBe(12.5);
    expect(shader.vertexShader).toContain('attribute float sway');
    expect(shader.fragmentShader).toContain('vYellow');
  });
});

describe('pot, bed, barrel and sign', () => {
  const box = (o: THREE.Object3D): THREE.Vector3 => new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());

  it('the pot: 28 cm across, 24 cm tall, dark soil, two draw calls', () => {
    const pot = potModel();
    const s = box(pot);
    expect(Math.abs(s.x - POT.diameter)).toBeLessThan(0.01);
    expect(Math.abs(s.z - POT.diameter)).toBeLessThan(0.01);
    expect(Math.abs(s.y - POT.height)).toBeLessThan(0.005);
    expect(new THREE.Box3().setFromObject(pot).min.y).toBeCloseTo(0, 3);
    expect(meshes(pot).length).toBeLessThanOrEqual(2);
    expect(sane(pot)).toBe(true);
    for (const m of meshes(pot)) expect(facingOut(m)).toBeGreaterThan(0.97);
    // the soil's top is where plants stand
    const soil = meshes(pot).find((m) => m.name === 'pot-soil')!;
    soil.geometry.computeBoundingBox();
    expect(Math.abs(soil.geometry.boundingBox!.min.y - GARDEN_SOIL.pot)).toBeLessThan(0.006);
    // a smaller one shares nothing odd: just scaled
    const small = potModel(DECK_POT_SCALE);
    expect(box(small).x).toBeCloseTo(POT.diameter * DECK_POT_SCALE, 2);
    expect(small.userData.soil).toBeCloseTo(GARDEN_SOIL.pot * DECK_POT_SCALE, 6);
    console.log(`pot ${triangles(pot)} triangles`);
  });

  it('the boat: two 28 cm pots per tray overlap; the deck-sized pots fit', () => {
    const boat = createSloop();
    const spots = boat.points.potShelf;
    expect(spots.length).toBe(4);
    const gap = Math.min(spots[0].distanceTo(spots[1]), spots[2].distanceTo(spots[3]));
    console.log(`pot spots ${gap.toFixed(3)} m apart: 28 cm pots overlap by ${(POT.diameter - gap).toFixed(3)} m; deck pots (${(POT.diameter * DECK_POT_SCALE).toFixed(3)} m) leave ${(gap - POT.diameter * DECK_POT_SCALE).toFixed(3)} m`);
    expect(POT.diameter).toBeGreaterThan(gap);
    expect(POT.diameter * DECK_POT_SCALE).toBeLessThan(gap - 0.01);
  });

  it('the bed: 1.7 x 0.9 m of driftwood, 30 cm high, full of soil, two draw calls', () => {
    const bed = bedModel();
    const s = box(bed);
    expect(Math.abs(s.x - BED.length)).toBeLessThan(0.02);
    expect(Math.abs(s.z - BED.width)).toBeLessThan(0.02);
    // the corner stakes stand a little proud of the planks
    expect(s.y).toBeGreaterThan(BED.height);
    expect(s.y).toBeLessThan(BED.height + 0.08);
    expect(meshes(bed).length).toBeLessThanOrEqual(2);
    expect(sane(bed)).toBe(true);
    for (const m of meshes(bed)) expect(facingOut(m)).toBeGreaterThan(0.97);
    const soil = meshes(bed).find((m) => m.name === 'bed-soil')!;
    soil.geometry.computeBoundingBox();
    const sb = soil.geometry.boundingBox!;
    expect(sb.min.y).toBeGreaterThan(GARDEN_SOIL.bed - 0.015);
    expect(sb.max.y).toBeLessThan(GARDEN_SOIL.bed + 0.015);
    console.log(`bed ${triangles(bed)} triangles`);
  });

  it('the barrel: about 86 cm tall, water rising with setLevel, two draw calls (one when empty)', () => {
    const b = barrelModel();
    const s = box(b.group);
    expect(Math.abs(s.y - BARREL.height)).toBeLessThan(0.05);
    expect(s.x).toBeGreaterThan(0.5);
    expect(s.x).toBeLessThan(0.65);
    expect(meshes(b.group).length).toBeLessThanOrEqual(2);
    expect(sane(b.group)).toBe(true);
    const body = meshes(b.group).find((m) => m.name === 'barrel-body')!;
    expect(facingOut(body)).toBeGreaterThan(0.97);
    const water = meshes(b.group).find((m) => m.name === 'barrel-water')!;
    b.setLevel(0);
    expect(water.visible).toBe(false);
    expect(visibleMeshes(b.group).length).toBe(1);
    b.setLevel(0.2);
    const low = water.position.y;
    expect(water.visible).toBe(true);
    b.setLevel(0.9);
    expect(water.position.y).toBeGreaterThan(low + 0.3);
    expect(water.position.y).toBeLessThan(BARREL.height);
    // the water fills the barrel (out to the staves) at every level
    for (const l of [0.1, 0.5, 1]) {
      b.setLevel(l);
      expect(water.scale.x).toBeGreaterThan(0.18);
      expect(water.scale.x).toBeLessThan(BARREL.bilge - BARREL.stave);
    }
    b.setLevel(7);
    expect(water.position.y).toBeLessThan(BARREL.height);
    b.setLevel(NaN);
    expect(water.visible).toBe(false);
    console.log(`barrel ${triangles(b.group)} triangles (with water)`);
  });

  it('the sign: a board on a post, words facing +z, two draw calls', () => {
    const sign = signModel('Home garden');
    expect(meshes(sign).length).toBeLessThanOrEqual(2);
    expect(sane(sign)).toBe(true);
    expect(sign.userData.text).toBe('Home garden');
    const board = meshes(sign).find((m) => m.name === 'sign-board')!;
    expect(facingOut(board)).toBeGreaterThan(0.97);
    // the board is in front of the post (+z), at about eye-to-waist height
    const bb = new THREE.Box3().setFromObject(board);
    const pb = new THREE.Box3().setFromObject(meshes(sign).find((m) => m.name === 'sign-post')!);
    expect(bb.max.z).toBeGreaterThan(pb.max.z);
    expect(bb.min.y).toBeGreaterThan(0.6);
    expect(bb.max.y).toBeLessThan(1);
    expect(pb.min.y).toBeLessThan(0);
    console.log(`sign ${triangles(sign)} triangles`);
  });
});

describe('the watering can in your hands', () => {
  const LIGHT = { walking: 0, hide: false, sunDir: new THREE.Vector3(0.3, 0.8, 0.5).normalize(), sunColor: new THREE.Color(1, 0.95, 0.85), sunIntensity: 3, hemiIntensity: 0.5, env: null };
  const seen = (held: HeldView): string[] => {
    const v: string[] = [];
    held.scene.traverseVisible((o) => {
      if (o.name === 'basket' || o.name === 'rod' || o.name === 'can' || o.name === 'can-stream') v.push(o.name);
    });
    return v;
  };
  const step = (held: HeldView, seconds: number): void => {
    for (let t = 0; t < seconds; t += 1 / 30) held.update(1 / 30, LIGHT);
  };

  it('the can model: one draw call, sane, a rose for the water', () => {
    const can = canModel();
    expect(meshes(can.group).length).toBe(1);
    expect(sane(can.group)).toBe(true);
    expect(facingOut(meshes(can.group)[0])).toBeGreaterThan(0.95);
    expect(canTriangles()).toBeLessThan(2000);
    const s = new THREE.Box3().setFromObject(can.group).getSize(new THREE.Vector3());
    expect(s.y).toBeGreaterThan(0.25);
    expect(s.y).toBeLessThan(0.33);
    expect(can.roseDir.length()).toBeCloseTo(1, 5);
    expect(can.rose.x).toBeGreaterThan(0.25);
  });

  it('switches to the can and back to the basket', () => {
    const held = new HeldView();
    held.camera.aspect = 16 / 9;
    step(held, 0.5);
    expect(seen(held)).toEqual(['basket']);
    held.setHolding('can');
    expect(held.holdingNow).toBe('can');
    step(held, 1.5);
    expect(seen(held)).toEqual(['can']);
    held.setHolding('basket');
    step(held, 1.5);
    expect(seen(held)).toEqual(['basket']);
    // and to the rod and back, as before
    held.setHolding('rod');
    step(held, 1.5);
    expect(seen(held)).toEqual(['rod']);
    held.setHolding('can');
    step(held, 1.5);
    expect(seen(held)).toEqual(['can']);
    held.setHolding('basket');
    step(held, 1.5);
    expect(seen(held)).toEqual(['basket']);
  });

  it('pours: tips, the water runs, then it comes level; hidden while swimming', () => {
    const held = new HeldView();
    held.camera.aspect = 16 / 9;
    held.setHolding('can');
    step(held, 1.5);
    const dur = held.pour(1);
    expect(dur).toBeGreaterThan(1);
    expect(held.pouring).toBe(true);
    step(held, 0.8);
    expect(seen(held)).toContain('can-stream');
    step(held, dur);
    expect(held.pouring).toBe(false);
    expect(seen(held)).toEqual(['can']);
    expect(held.holdingNow).toBe('can');
    // hidden (swimming, climbing): nothing in your hands shows
    for (let t = 0; t < 1.5; t += 1 / 30) held.update(1 / 30, { ...LIGHT, hide: true });
    expect(seen(held)).toEqual([]);
  });

  it('pour() from the basket brings the can up for it, then goes back to the basket', () => {
    const held = new HeldView();
    held.camera.aspect = 9 / 19;
    step(held, 0.5);
    const dur = held.pour();
    expect(held.holdingNow).toBe('can');
    step(held, 1.2);
    expect(seen(held)).toContain('can');
    step(held, dur + 0.3);
    expect(held.pouring).toBe(false);
    expect(held.holdingNow).toBe('basket');
    step(held, 1.5);
    expect(seen(held)).toEqual(['basket']);
  });

  it('choosing something else during a pour wins', () => {
    const held = new HeldView();
    held.camera.aspect = 16 / 9;
    held.pour(2);
    step(held, 0.5);
    held.setHolding('rod');
    step(held, 4);
    expect(held.pouring).toBe(false);
    expect(held.holdingNow).toBe('rod');
    expect(seen(held)).toEqual(['rod']);
  });
});

// keep the type import used
const _crop: CropKind = 'callaloo';
void _crop;
