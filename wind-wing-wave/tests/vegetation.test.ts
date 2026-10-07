/**
 * Plants (WP-F1): the models and their pop, stable placement with hysteresis, the detail levels
 * and caps, the small packing formats the plant shader reads, and the running system (clock
 * rebase, level cross-fades, partial uploads, pops at mid range).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NP, ORIGIN_X, ORIGIN_Z, PATCH_M } from '../src/config';
import { Habitat, PLANT_MODEL_COUNT, PlantModel, type PlantLook, type SpeciesDef } from '../src/content/speciesTypes';
import { PLANT_BYTES, type PondInfo, type StormState } from '../src/engine/protocol';
import { ARCHETYPES, FAR_SHAPE_COUNT, buildFarShape, buildPlant, triangles, type FarShape } from '../src/render/models/plants';
import { FIXED, Part, PlantBuilder, blob, dome, fan, sideOf, tube } from '../src/render/models/plantKit';
import { WorldFields } from '../src/render/fields';
import { createWorldUniforms, type FrameCtx, type PageSystem, type Quality, type SystemDeps } from '../src/render/shared';
import {
  DEAD,
  DeathKind,
  HIDE_MARGIN,
  LAYER_SLOT,
  LOD_HYSTERESIS,
  LodPicker,
  NB,
  NT,
  POP_RANGE,
  REVEAL,
  SPOTS,
  TIER_RANGE,
  PlantField,
  SpeciesTable,
  buildModels,
  capsFor,
  createVegetation,
  deathSpan,
  packColours,
  packSeedDry,
  packYawScale,
  spotThreshold,
  spotWanted,
  spotX,
  spotZ,
  tierOf,
  type FieldConditions,
  type FieldsView,
  type VegCaps,
} from '../src/render/vegetation';

// ---------- helpers ----------

/** A tiny test catalogue: one species per archetype (id = model), plus a marine seagrass and coral. */
function testSpecies(): SpeciesDef[] {
  const list: SpeciesDef[] = [];
  for (let m = 0; m < PLANT_MODEL_COUNT; m++) {
    const plant: PlantLook = { model: m as PlantModel, leaf: 0x4f8f36, leaf2: 0x9ccc5a, size: 1 };
    const marine = m === PlantModel.Seagrass || m === PlantModel.Coral;
    list.push({ id: m, key: `p${m}`, kind: 'plant', plant, marine } as unknown as SpeciesDef);
  }
  return list;
}

const models = buildModels();
const calm: StormState = { phase: 'none', t: 0, level: 0, great: false };

function conditions(now = 1, storm: StormState = calm, ponds: PondInfo[] | null = null): FieldConditions {
  return { now, storm, ponds, windAngle: Math.PI };
}

/** A world of flat land at `h` metres, with a field watching it from close by. */
function world(h = 5, view?: (f: WorldFields) => FieldsView): { fields: WorldFields; field: PlantField } {
  const fields = new WorldFields();
  fields.surf.fill(h);
  const field = new PlantField(view ? view(fields) : fields, new SpeciesTable(testSpecies()), models.tris);
  return { fields, field };
}

/** Patch index near the world origin, and its tile. */
const P = 128 + 128 * NP;
const TILE = ((P % NP) / 16 | 0) + (((P / NP) | 0) / 16 | 0) * NT;

function setLayer(fields: WorldFields, p: number, layer: number, species: number, cover: number): void {
  fields.plants[p * PLANT_BYTES + layer * 2] = species + 1;
  fields.plants[p * PLANT_BYTES + layer * 2 + 1] = Math.round(cover * 255);
}

function shownSpots(field: PlantField, p: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < SPOTS; s++) if (field.sp[p * SPOTS + s] > 0) out.push(s);
  return out;
}

/** The ground changed everywhere (the engine sends column rectangles for that). */
function groundChanged(field: PlantField): void {
  field.markPatches(0, 0, NP, NP, true);
}

/** New life data arrived for the whole world, then the test tile is worked out. */
function evaluate(field: PlantField, c = conditions()): void {
  field.markPatches(0, 0, NP, NP, false);
  field.tracked[TILE] = 1;
  field.evaluate(TILE, c);
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** The shader's reveal (see vegReveal in vegetation.ts). */
const reveal = (g: number, x: number): number => smooth(g * REVEAL.slope, g * REVEAL.slope + REVEAL.width, x);

// ---------- models ----------

describe('plant models', () => {
  it('has an archetype entry for every PlantModel, in order', () => {
    expect(ARCHETYPES.length).toBe(PLANT_MODEL_COUNT);
    ARCHETYPES.forEach((a, i) => expect(a.model).toBe(i));
  });

  for (const a of ARCHETYPES) {
    if (a.model === PlantModel.Tint) continue;
    it(`${a.name} builds at LOD0 and LOD1 within its triangle limits`, () => {
      for (let v = 0; v < a.variants; v++) {
        const g0 = buildPlant(a.model, 0, v);
        const g1 = buildPlant(a.model, 1, v);
        expect(triangles(g0)).toBeGreaterThan(0);
        expect(triangles(g0)).toBeLessThanOrEqual(a.limit);
        expect(triangles(g1)).toBeGreaterThanOrEqual(12);
        expect(triangles(g1)).toBeLessThanOrEqual(40);
        for (const g of [g0, g1]) {
          for (const name of ['position', 'normal', 'color', 'aPlant', 'aAttach', 'aHub']) {
            const attr = g.getAttribute(name);
            expect(attr, name).toBeTruthy();
            for (const x of attr.array as Float32Array) expect(Number.isFinite(x), `${name} finite`).toBe(true);
          }
          // Every vertex says which palette colour it takes.
          const plant = g.getAttribute('aPlant');
          for (let i = 0; i < plant.count; i++) {
            const part = Math.floor(plant.getW(i) + 1e-3);
            expect(part).toBeGreaterThanOrEqual(Part.Trunk);
            expect(part).toBeLessThanOrEqual(Part.Own);
          }
        }
      }
    });
  }

  it('keeps small plants at 60 triangles and trees at 250 (one hero at 400)', () => {
    const small = [PlantModel.Fern, PlantModel.Grass, PlantModel.DuneGrass, PlantModel.Sedge, PlantModel.Vine, PlantModel.Mat, PlantModel.Herb, PlantModel.Seagrass, PlantModel.Lily, PlantModel.Epiphyte];
    for (const m of small) expect(ARCHETYPES[m].limit).toBe(60);
    const heroes = ARCHETYPES.filter((a) => a.limit > 250);
    expect(heroes.map((a) => a.model)).toEqual([PlantModel.Fig]);
    expect(heroes[0].limit).toBeLessThanOrEqual(400);
  });

  it('has a small far canopy family', () => {
    for (let s = 0; s < FAR_SHAPE_COUNT; s++) expect(triangles(buildFarShape(s as FarShape))).toBeLessThanOrEqual(30);
  });

  it('roots models at the ground with no sway at the base', () => {
    for (const a of ARCHETYPES) {
      if (a.model === PlantModel.Tint) continue;
      const g = buildPlant(a.model, 0, 0);
      const pos = g.getAttribute('position');
      const plant = g.getAttribute('aPlant');
      let minY = Infinity;
      for (let i = 0; i < pos.count; i++) {
        minY = Math.min(minY, pos.getY(i));
        if (pos.getY(i) <= 0.01) expect(plant.getX(i), a.name).toBeLessThan(0.05);
      }
      expect(minY).toBeLessThan(0.6);
    }
  });

  it('draws trees with closed crowns front faces only, and leafy plants double-sided', () => {
    for (const m of [PlantModel.Broadleaf, PlantModel.Fig, PlantModel.Mangrove, PlantModel.PomTree, PlantModel.CloudTree, PlantModel.Shrub]) {
      expect(sideOf(buildPlant(m, 0)), ARCHETYPES[m].name).toBe(THREE.FrontSide);
      expect(sideOf(buildPlant(m, 1)), ARCHETYPES[m].name).toBe(THREE.FrontSide);
    }
    for (const m of [PlantModel.Fern, PlantModel.Grass, PlantModel.Palm, PlantModel.TreeFern, PlantModel.SheOak]) {
      expect(sideOf(buildPlant(m, 0)), ARCHETYPES[m].name).toBe(THREE.DoubleSide);
    }
  });

  it('winds every closed shape outward, so drawing front faces only shows its outside', () => {
    // Each closed kit shape on its own, centred on (0, 1, 0): every triangle must face away from
    // the centre (tubes: away from their axis). Thin pieces are left out of a front-sided model's
    // check: they get a reversed copy.
    const paint = { part: Part.Leaf } as const;
    const shapes: [string, (b: PlantBuilder) => void, (p: THREE.Vector3) => THREE.Vector3][] = [
      ['tube', (b) => tube(b, [[0, 0, 0], [0, 1, 0], [0, 2, 0]], [0.3, 0.25, 0], 5, paint), (p) => new THREE.Vector3(0, p.y, 0)],
      ['octa blob', (b) => blob(b, [0, 1, 0], [1, 0.6, 0.8], 'octa', 0.1, 3, paint), () => new THREE.Vector3(0, 1, 0)],
      ['ico blob', (b) => blob(b, [0, 1, 0], [1, 0.6, 0.8], 'ico', 0.1, 3, paint), () => new THREE.Vector3(0, 1, 0)],
      ['dome', (b) => dome(b, [0, 1, 0], 0.6, 0.5, 7, 2, paint), () => new THREE.Vector3(0, 0.9, 0)],
      [
        'lens',
        (b) => {
          fan(b, { centre: [0, 1, 0], normal: [0, 0, 1], start: [0, 1, 0], r: 0.4, n: 6, peak: 0.2, solid: true, paint });
          fan(b, { centre: [0, 1, 0], normal: [0, 0, -1], start: [0, 1, 0], r: 0.4, n: 6, peak: 0.2, solid: true, paint });
        },
        () => new THREE.Vector3(0, 1, 0),
      ],
    ];
    for (const [name, make, centreOf] of shapes) {
      const b = new PlantBuilder();
      make(b);
      const g = b.finish(() => 0);
      expect(sideOf(g), name).toBe(THREE.FrontSide);
      const pos = g.getAttribute('position');
      const idx = g.getIndex()!;
      const a = new THREE.Vector3();
      const v1 = new THREE.Vector3();
      const v2 = new THREE.Vector3();
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(pos, idx.getX(i));
        v1.fromBufferAttribute(pos, idx.getX(i + 1));
        v2.fromBufferAttribute(pos, idx.getX(i + 2));
        const mid = a.clone().add(v1).add(v2).multiplyScalar(1 / 3);
        const face = v1.clone().sub(a).cross(v2.clone().sub(a));
        expect(face.dot(mid.clone().sub(centreOf(mid))), `${name} triangle ${i / 3}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every piece attached to its growing parent all through the pop', () => {
    // During the pop a piece opens from its join while its parent is still being revealed. The
    // join must ride along: its distance to the parent never grows past the finished plant's.
    for (const a of ARCHETYPES) {
      if (a.model === PlantModel.Tint) continue;
      for (const lod of [0, 1] as const) {
        const g = buildPlant(a.model, lod, 0);
        const pos = g.getAttribute('position');
        const pl = g.getAttribute('aPlant');
        const at = g.getAttribute('aAttach');
        const hub = g.getAttribute('aHub');
        const n = pos.count;
        // Vertices with the same join and ride belong to one piece (or a set of alike pieces).
        const keys = Array.from({ length: n }, (_, i) => [at.getX(i), at.getY(i), at.getZ(i), at.getW(i), hub.getX(i), hub.getY(i), hub.getZ(i), hub.getW(i)].map((x) => x.toFixed(3)).join(','));
        const key = (i: number) => keys[i];
        const joinAt = (i: number, x: number, out: THREE.Vector3) => {
          const kh = reveal(hub.getW(i), x);
          const ka = reveal(at.getW(i), x);
          return out.set(hub.getX(i) * kh + (at.getX(i) - hub.getX(i)) * ka, hub.getY(i) * kh + (at.getY(i) - hub.getY(i)) * ka, hub.getZ(i) * kh + (at.getZ(i) - hub.getZ(i)) * ka);
        };
        const posAt = (i: number, x: number, out: THREE.Vector3) => {
          joinAt(i, x, out);
          const k = reveal(pl.getZ(i), x);
          return out.set(out.x + (pos.getX(i) - at.getX(i)) * k, out.y + (pos.getY(i) - at.getY(i)) * k, out.z + (pos.getZ(i) - at.getZ(i)) * k);
        };
        const tol = Math.max(0.3, 0.05 * a.height);
        const done = new Set<string>();
        const j = new THREE.Vector3();
        const q = new THREE.Vector3();
        for (let i = 0; i < n; i++) {
          const k = key(i);
          if (at.getW(i) === FIXED || done.has(k)) continue;
          done.add(k);
          // The parent at the join: the nearest vertex of another piece revealed no later than it.
          const A = new THREE.Vector3(at.getX(i), at.getY(i), at.getZ(i));
          let best = -1;
          let bestD = Infinity;
          for (let v = 0; v < n; v++) {
            if (pl.getZ(v) > at.getW(i) + 0.02 || key(v) === k) continue;
            const d = A.distanceTo(q.fromBufferAttribute(pos, v));
            if (d < bestD) {
              bestD = d;
              best = v;
            }
          }
          if (best < 0) continue;
          for (let x = 0; x <= 1.4; x += 0.02) {
            const gap = joinAt(i, x, j).distanceTo(posAt(best, x, q));
            expect(gap, `${a.name} LOD${lod} join ${k} at ${x.toFixed(2)}`).toBeLessThanOrEqual(bestD + tol);
          }
        }
      }
    }
  });

  it('grows tree crowns up from the trunk instead of hanging them above it (the pop reveal)', () => {
    // At every moment of the pop, the lowest visible bit of the crown sits no further above the
    // top of the trunk so far than it does on the grown tree (plus 25 cm). Drooping crowns hang
    // below the trunk top when grown and may rise as a spear while opening, but never float.
    for (const m of [PlantModel.Broadleaf, PlantModel.PomTree, PlantModel.Palm, PlantModel.TreeFern, PlantModel.Fig, PlantModel.Mangrove]) {
      const g = buildPlant(m, 0);
      const pos = g.getAttribute('position');
      const pl = g.getAttribute('aPlant');
      const at = g.getAttribute('aAttach');
      const hub = g.getAttribute('aHub');
      const gapAt = (x: number): number => {
        let trunkTop = 0;
        let crownLow = Infinity;
        for (let i = 0; i < pos.count; i++) {
          const join = hub.getY(i) * reveal(hub.getW(i), x) + (at.getY(i) - hub.getY(i)) * reveal(at.getW(i), x);
          const k = reveal(pl.getZ(i), x);
          const y = join + (pos.getY(i) - at.getY(i)) * k;
          const part = Math.floor(pl.getW(i) + 1e-3);
          if (part === Part.Trunk && at.getW(i) === FIXED) trunkTop = Math.max(trunkTop, y);
          else if (part === Part.Leaf && k > 0.05) crownLow = Math.min(crownLow, y);
        }
        return crownLow - trunkTop;
      };
      const grown = Math.max(0, gapAt(2));
      for (let x = 0.05; x <= 1; x += 0.05) {
        const gap = gapAt(x);
        if (Number.isFinite(gap)) expect(gap, `${ARCHETYPES[m].name} at ${x.toFixed(2)}`).toBeLessThanOrEqual(grown + 0.25);
      }
    }
  });
});

// ---------- placement ----------

describe('plant placement', () => {
  it('spreads spots inside their patch, the same way every time', () => {
    for (let slot = 0; slot < SPOTS; slot++) {
      const x = spotX(P, slot);
      const z = spotZ(P, slot);
      const x0 = ORIGIN_X + (P % NP) * PATCH_M;
      const z0 = ORIGIN_Z + ((P / NP) | 0) * PATCH_M;
      expect(x).toBeGreaterThan(x0);
      expect(x).toBeLessThan(x0 + PATCH_M);
      expect(z).toBeGreaterThan(z0);
      expect(z).toBeLessThan(z0 + PATCH_M);
      expect(spotX(P, slot)).toBe(x);
      expect(spotThreshold(P, slot)).toBe(spotThreshold(P, slot));
    }
  });

  it('splits each layer into threshold bands (cover 0.34 shows about one herb per patch)', () => {
    let herbs = 0;
    for (let p = 0; p < 2000; p++) for (let k = 0; k < 3; k++) if (spotWanted(0.34, spotThreshold(p, LAYER_SLOT[2] + k), false)) herbs++;
    expect(herbs / 2000).toBeGreaterThan(0.85);
    expect(herbs / 2000).toBeLessThan(1.15);
  });

  it('shows at the threshold and hides only HIDE_MARGIN below it', () => {
    const t = 0.5;
    expect(spotWanted(0.5, t, false)).toBe(true);
    expect(spotWanted(0.49, t, false)).toBe(false);
    expect(spotWanted(0.49, t, true)).toBe(true);
    expect(spotWanted(t - HIDE_MARGIN + 0.001, t, true)).toBe(true);
    expect(spotWanted(t - HIDE_MARGIN - 0.001, t, true)).toBe(false);
    // No cover at all hides every plant, however low its threshold.
    expect(spotWanted(0, 0.04, true)).toBe(false);
  });

  it('places the same plants in the same places from the same data', () => {
    const a = world();
    const b = world();
    for (const w of [a, b]) {
      for (let k = 0; k < 16; k++) {
        setLayer(w.fields, P + k, 0, PlantModel.Broadleaf, 0.8);
        setLayer(w.fields, P + k, 2, PlantModel.Fern, 0.7);
      }
      evaluate(w.field);
    }
    expect(a.field.recN[TILE]).toBeGreaterThan(0);
    expect(Array.from(a.field.recs[TILE].subarray(0, a.field.recN[TILE] * 8))).toEqual(Array.from(b.field.recs[TILE].subarray(0, b.field.recN[TILE] * 8)));
  });

  it('only ever adds plants as cover rises, and keeps them through a small dip', () => {
    const { fields, field } = world();
    let prev: number[] = [];
    for (let c = 0; c <= 1.0001; c += 0.05) {
      setLayer(fields, P, 2, PlantModel.Grass, c);
      evaluate(field);
      const now = shownSpots(field, P);
      for (const s of prev) expect(now).toContain(s);
      prev = now;
    }
    expect(prev.length).toBe(3);
    // A dip smaller than the margin keeps every plant.
    setLayer(fields, P, 2, PlantModel.Grass, 0.98 - HIDE_MARGIN + 0.01);
    evaluate(field);
    expect(shownSpots(field, P).length).toBe(3);
  });

  it('replaces the plants of a layer whose species changes (old ones die, new ones are born)', () => {
    const { fields, field } = world();
    setLayer(fields, P, 1, PlantModel.Shrub, 1);
    evaluate(field, conditions(1));
    for (let s = 1; s <= 2; s++) field.birth[P * SPOTS + s] = 1; // shown
    setLayer(fields, P, 1, PlantModel.SeaGrape, 1);
    evaluate(field, conditions(2));
    expect(field.sp[P * SPOTS + 1]).toBe(PlantModel.SeaGrape + 1);
    expect(field.deadN).toBe(2);
    expect(field.dead[7] % 16).toBe(DeathKind.Wither);
  });

  it('keeps land plants out of the sea and sea plants out of the air', () => {
    const sea = world(-3);
    setLayer(sea.fields, P, 0, PlantModel.Palm, 1);
    setLayer(sea.fields, P, 2, PlantModel.Seagrass, 1);
    evaluate(sea.field);
    expect(sea.field.sp[P * SPOTS]).toBe(0);
    expect(shownSpots(sea.field, P).length).toBe(3);
    const land = world(5);
    setLayer(land.fields, P, 2, PlantModel.Seagrass, 1);
    setLayer(land.fields, P, 1, PlantModel.Mangrove, 1);
    evaluate(land.field);
    expect(shownSpots(land.field, P)).toEqual([]);
  });

  it('puts mangroves at the waterline and lilies only on pond patches', () => {
    const shore = world(0.3);
    setLayer(shore.fields, P, 0, PlantModel.Mangrove, 1);
    evaluate(shore.field);
    expect(shore.field.sp[P * SPOTS]).toBe(PlantModel.Mangrove + 1);

    const dry = world(5);
    setLayer(dry.fields, P, 2, PlantModel.Lily, 1);
    setLayer(dry.fields, P + 1, 0, PlantModel.Broadleaf, 1);
    evaluate(dry.field);
    expect(shownSpots(dry.field, P)).toEqual([]);
    // A pond box with water above the ground: only the patch the habitat calls a pond is water.
    // The tree next to it stands, though it is inside the box and below the level.
    const x = spotX(P, 3);
    const z = spotZ(P, 3);
    const pond: PondInfo = { id: 1, level: 5.6, x0: x - 10, z0: z - 10, x1: x + 10, z1: z + 10, salt: false };
    evaluate(dry.field, conditions(1, calm, [pond]));
    expect(shownSpots(dry.field, P)).toEqual([]);
    expect(dry.field.sp[(P + 1) * SPOTS]).toBe(PlantModel.Broadleaf + 1);
    dry.fields.habitat[P] = Habitat.Pond;
    groundChanged(dry.field);
    evaluate(dry.field, conditions(1, calm, [pond]));
    expect(shownSpots(dry.field, P).length).toBe(3);
    expect(dry.field.baseY[P * SPOTS + 3]).toBeCloseTo(5.605, 3);
    expect(dry.field.sp[(P + 1) * SPOTS]).toBe(PlantModel.Broadleaf + 1);
    expect(dry.field.deadN).toBe(0);
  });

  it('never stands land plants on pond patches, but lets reeds stand in the shallow edge', () => {
    const { fields, field } = world(5);
    fields.habitat[P] = Habitat.Pond;
    setLayer(fields, P, 0, PlantModel.Broadleaf, 1);
    setLayer(fields, P, 2, PlantModel.Sedge, 1);
    const pond: PondInfo = { id: 1, level: 5.3, x0: -50, z0: -50, x1: 50, z1: 50, salt: false };
    evaluate(field, conditions(1, calm, [pond]));
    expect(shownSpots(field, P)).toEqual([3, 4, 5]);
  });

  it('perches epiphytes in the canopy of their own patch, never on the ground', () => {
    const { fields, field } = world(5);
    setLayer(fields, P, 2, PlantModel.Epiphyte, 1);
    evaluate(field);
    expect(shownSpots(field, P)).toEqual([]);
    setLayer(fields, P, 0, PlantModel.Broadleaf, 1);
    evaluate(field);
    expect(shownSpots(field, P)).toEqual([0, 3, 4, 5]);
    for (let s = 3; s < 6; s++) expect(field.baseY[P * SPOTS + s]).toBeGreaterThan(5 + 3);
  });

  it('burns plants the moment molten lava reaches them, and blooms nothing on it', () => {
    const { fields, field } = world(5);
    setLayer(fields, P, 0, PlantModel.PomTree, 1);
    evaluate(field);
    field.birth[P * SPOTS] = 1;
    // Molten lava (1 m) under the whole patch area.
    const i0 = (P % NP) * 2 - 2;
    const k0 = ((P / NP) | 0) * 2 - 2;
    for (let k = k0; k < k0 + 6; k++) for (let i = i0; i < i0 + 6; i++) fields.ground[(i + k * 512) * 4] = 20;
    groundChanged(field);
    evaluate(field, conditions(3));
    expect(field.sp[P * SPOTS]).toBe(0);
    expect(field.deadN).toBe(1);
    expect(field.dead[7] % 16).toBe(DeathKind.Lava);
  });

  it('topples trees in a storm, buries plants under sand, and lets plants nobody saw go quietly', () => {
    const storm: StormState = { phase: 'peak', t: 5, level: 1, great: false };
    const a = world(5);
    setLayer(a.fields, P, 0, PlantModel.Broadleaf, 1);
    evaluate(a.field);
    a.field.birth[P * SPOTS] = 1;
    setLayer(a.fields, P, 0, PlantModel.Broadleaf, 0);
    evaluate(a.field, conditions(2, storm));
    expect(a.field.dead[7] % 16).toBe(DeathKind.Storm);

    const b = world(5);
    setLayer(b.fields, P, 2, PlantModel.Grass, 1);
    evaluate(b.field);
    for (let s = 3; s < 6; s++) b.field.birth[P * SPOTS + s] = 1;
    b.fields.surf.fill(5.8); // sand poured over them
    groundChanged(b.field);
    setLayer(b.fields, P, 2, PlantModel.Grass, 0);
    evaluate(b.field, conditions(2));
    expect(b.field.deadN).toBe(3);
    for (let i = 0; i < 3; i++) expect(b.field.dead[i * DEAD + 7] % 16).toBe(DeathKind.Burial);

    const c = world(5);
    setLayer(c.fields, P, 2, PlantModel.Grass, 1);
    evaluate(c.field);
    setLayer(c.fields, P, 2, PlantModel.Grass, 0);
    evaluate(c.field, conditions(2));
    expect(c.field.deadN).toBe(0); // still waiting for their pop: no death to show
  });

  it('lets living plants ride down with the ground but not up (they get buried instead)', () => {
    const { fields, field } = world(5);
    setLayer(fields, P, 0, PlantModel.Palm, 1);
    evaluate(field);
    const s = P * SPOTS;
    const y0 = field.baseY[s];
    fields.surf.fill(4);
    groundChanged(field);
    evaluate(field);
    expect(field.baseY[s]).toBeLessThan(y0 - 0.9);
    const y1 = field.baseY[s];
    fields.surf.fill(5);
    groundChanged(field);
    evaluate(field);
    expect(field.baseY[s]).toBeCloseTo(y1, 5);
  });

  it('re-checks footing only when the ground changed (life updates leave standing plants alone)', () => {
    const { fields, field } = world(5);
    setLayer(fields, P, 0, PlantModel.Palm, 0.9);
    evaluate(field);
    const s = P * SPOTS;
    const y0 = field.baseY[s];
    fields.surf.fill(3); // not announced as a ground change
    setLayer(fields, P, 0, PlantModel.Palm, 0.95);
    evaluate(field);
    expect(field.baseY[s]).toBe(y0);
    groundChanged(field);
    evaluate(field);
    expect(field.baseY[s]).toBeLessThan(y0 - 1.5);
  });

  it('works out only the blocks and patches whose data changed', () => {
    let calls = 0;
    const counting = (f: WorldFields): FieldsView => ({
      plants: f.plants,
      habitat: f.habitat,
      coverB: f.coverB,
      heightAt: (x: number, z: number) => {
        calls++;
        return f.heightAt(x, z);
      },
      lavaAt: (x: number, z: number) => f.lavaAt(x, z),
    });
    const { fields, field } = world(5, counting);
    // A forest over the whole 64 m tile.
    const p0 = TILE % NT * 16 + ((TILE / NT) | 0) * 16 * NP;
    for (let pz = 0; pz < 16; pz++) for (let px = 0; px < 16; px++) setLayer(fields, p0 + px + pz * NP, 0, PlantModel.Broadleaf, 1);
    field.tracked[TILE] = 1;
    field.evaluate(TILE, conditions());
    const all = Array.from(field.recs[TILE].subarray(0, field.recN[TILE] * 8));
    expect(field.recN[TILE]).toBe(256);
    // Life news for one patch only (its cover dips, so its tree stays): nothing needs placing.
    calls = 0;
    setLayer(fields, p0 + 5, 0, PlantModel.Broadleaf, 0.97);
    field.markPatches((p0 + 5) % NP, ((p0 + 5) / NP) | 0, 1, 1, false);
    field.evaluate(TILE, conditions());
    expect(calls).toBe(0);
    // A new species in one patch: only that patch's tree is placed (5 height samples for a tree).
    setLayer(fields, p0 + 5, 0, PlantModel.PomTree, 1);
    field.markPatches((p0 + 5) % NP, ((p0 + 5) / NP) | 0, 1, 1, false);
    field.evaluate(TILE, conditions());
    expect(calls).toBeLessThanOrEqual(10);
    // The ground moved under one 16 m block: its 16 trees get new footing, the other 15 blocks don't.
    calls = 0;
    field.markPatches(p0 % NP + 4, ((p0 / NP) | 0) + 4, 4, 4, true);
    field.evaluate(TILE, conditions());
    expect(calls).toBe(16 * 5);
    // Everything else is exactly as it was.
    const now = Array.from(field.recs[TILE].subarray(0, field.recN[TILE] * 8));
    expect(now.length).toBe(all.length);
    let differ = 0;
    for (let r = 0; r < 256; r++) if (now.slice(r * 8, r * 8 + 8).join() !== all.slice(r * 8, r * 8 + 8).join()) differ++;
    expect(differ).toBe(1); // the pom tree
  });

  it('spreads a big first look over frames when short of time, keeping finished blocks', () => {
    const { fields, field } = world(5);
    const p0 = TILE % NT * 16 + ((TILE / NT) | 0) * 16 * NP;
    for (let pz = 0; pz < 16; pz++) for (let px = 0; px < 16; px++) setLayer(fields, p0 + px + pz * NP, 2, PlantModel.Fern, 1);
    field.tracked[TILE] = 1;
    field.dirty[TILE] = 1;
    field.evaluate(TILE, conditions(), -1); // already past the deadline: one block only
    expect(field.recN[TILE]).toBe(16 * 3);
    expect(field.dirty[TILE]).toBe(1);
    while (field.dirty[TILE]) field.evaluate(TILE, conditions(), -1);
    expect(field.recN[TILE]).toBe(256 * 3);
  });

  it('drops dying plants once their animation has played', () => {
    const { fields, field } = world(5);
    setLayer(fields, P, 2, PlantModel.Grass, 1);
    evaluate(field);
    for (let s = 3; s < 6; s++) field.birth[P * SPOTS + s] = 1;
    setLayer(fields, P, 2, PlantModel.Grass, 0);
    evaluate(field, conditions(10));
    expect(field.deadN).toBe(3);
    expect(field.expireDead(11)).toBe(false);
    expect(field.expireDead(20)).toBe(true);
    expect(field.deadN).toBe(0);
  });

  it('keeps storm logs and bare palm trunks a while, but flattened small plants only briefly', () => {
    expect(deathSpan(DeathKind.Storm, PlantModel.Grass)).toBeLessThan(2.5);
    expect(deathSpan(DeathKind.Storm, PlantModel.Palm)).toBeGreaterThan(40);
    expect(deathSpan(DeathKind.Storm, PlantModel.Broadleaf)).toBeGreaterThan(40);
    const storm: StormState = { phase: 'peak', t: 5, level: 1, great: false };
    const { fields, field } = world(5);
    setLayer(fields, P, 2, PlantModel.Grass, 1);
    evaluate(field);
    for (let s = 3; s < 6; s++) field.birth[P * SPOTS + s] = 1;
    setLayer(fields, P, 2, PlantModel.Grass, 0);
    evaluate(field, conditions(10, storm));
    expect(field.dead[7] % 16).toBe(DeathKind.Storm);
    expect(field.expireDead(11.5)).toBe(false);
    expect(field.expireDead(12.5)).toBe(true);
  });
});

// ---------- tiers and caps ----------

describe('detail levels and caps', () => {
  it('picks tiers by distance with a little hysteresis', () => {
    expect(tierOf(10)).toBe(0);
    expect(tierOf(TIER_RANGE[0] + 1)).toBe(1);
    expect(tierOf(TIER_RANGE[1] + 1)).toBe(2);
    expect(tierOf(TIER_RANGE[2] + 1)).toBe(3);
    // A tile already at full detail keeps it just past the boundary, but not far past.
    expect(tierOf(TIER_RANGE[0] + 2, 0)).toBe(0);
    expect(tierOf(TIER_RANGE[0] + 20, 0)).toBe(1);
  });

  it('uses the phone caps from the architecture', () => {
    const phone = capsFor({ phone: true, density: 1, tier: 1 });
    expect(phone.count).toEqual([600, 2500, 4000]);
    expect(phone.tris).toBeCloseTo(120000, 0);
    expect(phone.keep[0] + phone.keep[1]).toBeLessThan(phone.tris * 0.3);
    expect(phone.shadowTris).toBeLessThanOrEqual(50000);
    const lighter = capsFor({ phone: true, density: 0.8, tier: 0 });
    expect(lighter.count[0]).toBeLessThan(600);
  });

  /** n blocks in a row, 10 m apart, all allowed full detail, each costing cnt/tri per level. */
  function row(n: number, cnt: [number, number, number], tri: [number, number, number]) {
    const order = Array.from({ length: n }, (_, i) => i);
    const c = new Int32Array(n * 3);
    const t = new Float32Array(n * 3);
    for (let b = 0; b < n; b++) {
      c.set(cnt, b * 3);
      t.set(tri, b * 3);
    }
    return { order, tier: new Uint8Array(n), cnt: c, tri: t, dist: Float32Array.from(order, (i) => i * 10), shown: new Uint8Array(n).fill(3), out: new Uint8Array(n) };
  }
  const open = (count: [number, number, number], tris = 1e9, keep: [number, number] = [0, 0]): VegCaps => ({ count, tris, keep, shadowTris: 0 });

  it('fills levels nearest first and hands overflow down a level', () => {
    const r = row(10, [100, 40, 10], [5000, 1000, 200]);
    new LodPicker().assign(r.order, 10, r.tier, r.cnt, r.tri, r.dist, r.shown, open([300, 200, 1000]), r.out);
    expect(Array.from(r.out)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 2, 2]);
  });

  it('shares one triangle pool: full detail may use what the far levels leave, minus their keep', () => {
    const r = row(20, [10, 10, 10], [5000, 1000, 200]);
    const picker = new LodPicker();
    // 60k triangles and nothing kept back: full detail may take all of it (12 blocks).
    picker.assign(r.order, 20, r.tier, r.cnt, r.tri, r.dist, r.shown, open([1e9, 1e9, 1e9], 60000), r.out);
    expect(Array.from(r.out)).toEqual([...Array<number>(12).fill(0), ...Array<number>(8).fill(3)]);
    // With 22k kept for LOD1 and LOD2, full detail stops at 38k (7 blocks) and the rest still show.
    picker.assign(r.order, 20, r.tier, r.cnt, r.tri, r.dist, r.shown, open([1e9, 1e9, 1e9], 60000, [20000, 2000]), r.out);
    expect(Array.from(r.out)).toEqual([...Array<number>(7).fill(0), ...Array<number>(13).fill(1)]);
  });

  it('keeps a block at its level until it is LOD_HYSTERESIS past the cut', () => {
    const r = row(4, [10, 10, 10], [1000, 100, 10]);
    const caps = open([20, 1e9, 1e9]); // room for two blocks at full detail
    const picker = new LodPicker();
    picker.assign(r.order, 4, r.tier, r.cnt, r.tri, r.dist, r.shown, caps, r.out);
    expect(Array.from(r.out)).toEqual([0, 0, 1, 1]);
    r.shown.set(r.out);
    // The camera pans: block 2 comes a little nearer than block 1. Block 1 keeps full detail...
    r.dist.set([0, 12, 9, 30]);
    r.order.splice(0, 4, 0, 2, 1, 3);
    picker.assign(r.order, 4, r.tier, r.cnt, r.tri, r.dist, r.shown, caps, r.out);
    expect(Array.from(r.out)).toEqual([0, 0, 1, 1]);
    // ...until block 2 is more than LOD_HYSTERESIS nearer.
    r.dist.set([0, 12, 12 - LOD_HYSTERESIS - 0.5, 30]);
    picker.assign(r.order, 4, r.tier, r.cnt, r.tri, r.dist, r.shown, caps, r.out);
    expect(Array.from(r.out)).toEqual([0, 1, 0, 1]);
  });

  it('never draws a block past its tile tier', () => {
    const r = row(3, [5, 5, 5], [10, 10, 10]);
    r.tier.set([1, 2, 3]);
    new LodPicker().assign(r.order, 3, r.tier, r.cnt, r.tri, r.dist, r.shown, capsFor({ phone: true, density: 1, tier: 1 }), r.out);
    expect(Array.from(r.out)).toEqual([1, 2, 3]);
  });

  it('works out tiles near the camera and forgets far ones', () => {
    const { field } = world(5);
    field.track(0, 50, 0);
    expect(field.tracked[TILE]).toBe(1);
    expect(field.nextDirty()).toBeGreaterThanOrEqual(0);
    field.track(5000, 50, 5000);
    expect(field.tracked[TILE]).toBe(0);
    expect(NB).toBe(64);
  });
});

// ---------- packing ----------

describe('instance packing', () => {
  it('packs yaw and scale into one float', () => {
    const w = packYawScale(Math.PI / 2, 2.5);
    expect(Math.floor(w) / 128).toBeCloseTo(2.5, 2);
    expect((w - Math.floor(w)) * Math.PI * 2).toBeCloseTo(Math.PI / 2, 2);
    const far = packYawScale(-0.5, 40);
    expect(Math.floor(far) / 128).toBeCloseTo(40, 1);
    expect(Math.fround(far)).toBeCloseTo(far, 2);
  });

  it('packs seed and dryness into one float', () => {
    const v = packSeedDry(0.37, 0.6);
    expect(Math.floor(v) / 15).toBeCloseTo(0.6, 1);
    expect(v - Math.floor(v)).toBeCloseTo(0.37, 5);
  });

  it('packs five colours at 6 bits a channel, exactly in float32', () => {
    const out = new Float32Array(4);
    const cols: [number, number, number, number, number] = [0x4f8f36, 0x9ccc5a, 0x8b7257, 0xe0262a, 0x7a5a32];
    packColours(cols, out, 0);
    // Decode the way the shader does (floor/mod by 64).
    const ch: number[] = [];
    for (const f of out) {
      let x = f;
      for (let j = 0; j < 4; j++) {
        ch.push(x % 64);
        x = Math.floor(x / 64);
      }
    }
    cols.forEach((c, i) => {
      const rgb = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
      rgb.forEach((v, k) => expect(Math.abs((ch[i * 3 + k] / 63) * 255 - v)).toBeLessThanOrEqual(2.1));
    });
  });
});

// ---------- the running system ----------

/**
 * The vegetation system on a flat 5 m island with a forest of broadleaf trees, sea-grape shrubs
 * and ferns over the 64 m tile at the world origin, watched by a camera.
 */
function running(trees = true, q: Partial<Quality> = {}) {
  const fields = new WorldFields();
  fields.surf.fill(5);
  const p0 = 128 + 128 * NP;
  for (let pz = 0; pz < 16; pz++) {
    for (let px = 0; px < 16; px++) {
      const p = p0 + px + pz * NP;
      if (trees) setLayer(fields, p, 0, PlantModel.Broadleaf, 0.9);
      setLayer(fields, p, 1, PlantModel.SeaGrape, 0.5);
      setLayer(fields, p, 2, PlantModel.Fern, 0.6);
    }
  }
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 0.5, 0.5, 5000);
  const quality: Quality = { setting: 'auto', phone: true, tier: 1, density: 1, shadows: true, ...q };
  const deps = {
    renderer: { domElement: { height: 800 } } as unknown as THREE.WebGLRenderer,
    scene,
    camera,
    fields,
    u: createWorldUniforms(fields),
    quality,
    species: testSpecies(),
    isTouch: true,
    prefs: { fewerFlashes: false, sound: false, dayMode: 'cycle', vibration: false, volume: 1 },
  } as SystemDeps;
  const sys: PageSystem = createVegetation(deps);
  /** Look at the forest centre (32, 5, 32) from a distance, along -z. */
  const look = (dist: number, height = dist * 0.4) => {
    camera.position.set(32, 5 + height, 32 + dist);
    camera.lookAt(32, 5, 32);
    camera.updateMatrixWorld();
  };
  let t = 0;
  /** Run frames at 30 fps, calling `each` after every one. */
  const frames = (seconds: number, each?: () => void) => {
    const dt = 1 / 30;
    for (let k = 0; k < Math.round(seconds / dt); k++) {
      t += dt;
      sys.update({ t, dt, camera, storm: calm } as unknown as FrameCtx);
      each?.();
    }
  };
  const jump = (to: number) => {
    t = to;
  };
  const now = () => (scene.children.find((o) => o instanceof THREE.Points) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>).material.uniforms.uNow.value as number;
  /** Visible instanced meshes, with what they draw. */
  const meshes = () =>
    scene.children
      .filter((o): o is THREE.Mesh<THREE.InstancedBufferGeometry, THREE.Material> => o instanceof THREE.Mesh)
      .map((m) => ({
        mesh: m,
        tris: m.geometry.getIndex()!.count / 3,
        anim: 'PLANT_ANIM' in ((m.material as THREE.MeshLambertMaterial).defines ?? {}),
        n: m.geometry.instanceCount,
        life: m.geometry.getAttribute('iLife') as THREE.InterleavedBufferAttribute,
      }));
  /** The life data of every patch in the 16 m block under (x, z) changed (to nothing). */
  const clearBlock = (x: number, z: number) => {
    const bx = Math.floor((x - ORIGIN_X) / 16) * 4;
    const bz = Math.floor((z - ORIGIN_Z) / 16) * 4;
    for (let pz = bz; pz < bz + 4; pz++) for (let px = bx; px < bx + 4; px++) for (let L = 0; L < 3; L++) setLayer(fields, px + pz * NP, L, PlantModel.Fern, 0);
    fields.onEco.forEach((fn) => fn(bx, bz, 4, 4));
  };
  return { sys, scene, camera, fields, look, frames, jump, now, meshes, clearBlock };
}

const tris0 = (m: PlantModel) => triangles(buildPlant(m, 0));
const tris1 = (m: PlantModel) => triangles(buildPlant(m, 1));

describe('the vegetation system', () => {
  it('keeps every plant showing across the hourly clock rebase', () => {
    const r = running();
    r.look(30);
    // The forest comes up within the hour before the rebase, so every plant's birth time moves.
    r.jump(500);
    r.frames(4);
    const shown = r.meshes().reduce((a, m) => a + m.n, 0);
    expect(shown).toBeGreaterThan(100);
    // Just before the clock moves back an hour (at 4000 s) a fern is born close by, so the
    // buffers are rebuilt a moment before the move: they must be rebuilt again right at it.
    r.jump(3999.85);
    const p = 128 + 8 + (128 + 15) * NP;
    setLayer(r.fields, p, 2, PlantModel.Fern, 1);
    r.fields.onEco.forEach((fn) => fn(p % NP, (p / NP) | 0, 1, 1));
    let frames = 0;
    r.frames(0.8, () => {
      const now = r.now();
      let unborn = 0;
      for (const m of r.meshes()) for (let i = 0; i < m.n; i++) if (m.life.getX(i) > now + 1e-3) unborn++;
      expect(unborn, `frame ${frames++} at ${now.toFixed(3)}`).toBe(0);
    });
    expect(r.now()).toBeLessThan(500);
    expect(r.meshes().reduce((a, m) => a + m.n, 0)).toBeGreaterThanOrEqual(shown * 0.9);
  });

  it('cross-fades a block that changes level instead of swapping models', () => {
    const r = running();
    r.look(20, 10);
    r.frames(3);
    const lod0 = () => r.meshes().filter((m) => !m.anim && m.tris === tris0(PlantModel.Broadleaf));
    const lod1 = () => r.meshes().filter((m) => !m.anim && m.tris === tris1(PlantModel.Broadleaf));
    expect(lod0().reduce((a, m) => a + m.n, 0)).toBeGreaterThan(0);
    // Back off to ~120 m: the trees switch to LOD1. Right after, both are there: the old ones
    // shrinking away (a death time) and the new ones growing in (a fresh birth).
    r.look(150, 60);
    r.frames(0.3);
    const now = r.now();
    const old = lod0()[0];
    expect(old.n).toBeGreaterThan(0);
    for (let i = 0; i < old.n; i++) expect(old.life.getY(i)).toBeLessThan(now + 1);
    const fresh = lod1()[0];
    expect(fresh.n).toBeGreaterThan(0);
    let growing = 0;
    for (let i = 0; i < fresh.n; i++) if (now - fresh.life.getX(i) < 0.6) growing++;
    expect(growing).toBeGreaterThan(fresh.n * 0.5);
    // A moment later the old level is gone.
    r.frames(2);
    expect(lod0().reduce((a, m) => a + m.n, 0)).toBe(0);
  });

  it('uploads only the instance buffers whose contents changed', () => {
    const r = running();
    r.look(30);
    r.frames(4);
    const versions = new Map(r.meshes().map((m) => [m.mesh, (m.life.data as THREE.InstancedInterleavedBuffer).version]));
    // One more fern at the forest's near edge.
    const p = 128 + 8 + (128 + 15) * NP;
    setLayer(r.fields, p, 2, PlantModel.Fern, 1);
    r.fields.onEco.forEach((fn) => fn(p % NP, (p / NP) | 0, 1, 1));
    r.frames(2);
    const changed = r.meshes().filter((m) => (m.life.data as THREE.InstancedInterleavedBuffer).version !== versions.get(m.mesh));
    const trees = r.meshes().find((m) => !m.anim && m.tris === tris0(PlantModel.Broadleaf))!;
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.map((m) => m.mesh)).not.toContain(trees.mesh);
  });

  it('plays a death with the model the plant was drawn with, and none for plants that were not drawn', () => {
    // A small budget: the nearest block at full detail, the next few as simple models, so blocks
    // within 60 m of the camera draw trees and shrubs at LOD1 and no ferns at all.
    const r = running(true, { density: 0.2, shadows: false });
    r.look(30);
    r.frames(3);
    const simple = r.meshes().find((m) => !m.anim && m.tris === tris1(PlantModel.Broadleaf) && m.n > 0)!;
    expect(simple).toBeTruthy();
    // The simple tree nearest the camera, within 60 m: every plant in its block dies.
    const pos = simple.mesh.geometry.getAttribute('iPos') as THREE.InterleavedBufferAttribute;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < simple.n; i++) {
      const d = Math.hypot(pos.getX(i) - r.camera.position.x, pos.getY(i) - r.camera.position.y, pos.getZ(i) - r.camera.position.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    expect(bestD).toBeLessThan(TIER_RANGE[0]);
    r.clearBlock(pos.getX(best), pos.getZ(best));
    r.frames(0.4);
    const now = r.now();
    const dying = (tris: number) => r.meshes().filter((m) => m.anim && m.tris === tris).reduce((a, m) => {
      let k = 0;
      for (let i = 0; i < m.n; i++) if (m.life.getY(i) <= now && now - m.life.getY(i) < 1) k++;
      return a + k;
    }, 0);
    // The block's trees fall as the simple trees they were; its ferns were never drawn.
    expect(dying(tris1(PlantModel.Broadleaf))).toBeGreaterThan(0);
    expect(dying(tris0(PlantModel.Broadleaf))).toBe(0);
    expect(dying(tris0(PlantModel.Fern))).toBe(0);
  });

  it('keeps each block in the same place in the buffers wherever the camera stands', () => {
    // Without shadows every block goes in a fixed order, so a camera on the other side of the
    // forest (every distance changed) leaves the plants it still draws in the same order.
    const r = running(true, { shadows: false });
    const order = () => {
      const m = r.meshes().find((x) => !x.anim && x.tris === tris1(PlantModel.Broadleaf))!;
      const pos = m.mesh.geometry.getAttribute('iPos') as THREE.InterleavedBufferAttribute;
      return Array.from({ length: m.n }, (_, i) => `${pos.getX(i).toFixed(2)},${pos.getZ(i).toFixed(2)}`);
    };
    r.look(120, 60);
    r.frames(3);
    const a = order();
    r.camera.position.set(32, 65, 32 - 120);
    r.camera.lookAt(32, 5, 32);
    r.camera.updateMatrixWorld();
    r.frames(3);
    const b = order();
    const common = new Set(a.filter((k) => b.includes(k)));
    expect(common.size).toBeGreaterThan(50);
    expect(a.filter((k) => common.has(k))).toEqual(b.filter((k) => common.has(k)));
  });

  it('pops new trees out at mid range, where watch mode looks from', () => {
    const r = running(false);
    r.look(100, 50);
    r.frames(3);
    // A tree comes up in the middle of the scrub, about 100 m away.
    const p = 128 + 8 + (128 + 8) * NP;
    setLayer(r.fields, p, 0, PlantModel.Broadleaf, 1);
    r.fields.onEco.forEach((fn) => fn(p % NP, (p / NP) | 0, 1, 1));
    r.frames(0.6);
    const popping = r.meshes().filter((m) => m.anim && m.tris === tris1(PlantModel.Broadleaf) && m.n > 0);
    expect(popping.length).toBe(1);
    expect(POP_RANGE).toBeGreaterThan(TIER_RANGE[0]);
  });
});
