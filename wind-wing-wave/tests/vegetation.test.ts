/**
 * Plants (WP-F1): the models, stable placement with hysteresis, the detail tiers and caps, and
 * the small packing formats the plant shader reads.
 */
import { describe, expect, it } from 'vitest';
import { NP, ORIGIN_X, ORIGIN_Z, PATCH_M } from '../src/config';
import { PLANT_MODEL_COUNT, PlantModel, type PlantLook, type SpeciesDef } from '../src/content/speciesTypes';
import { PLANT_BYTES, type PondInfo, type StormState } from '../src/engine/protocol';
import { ARCHETYPES, FAR_SHAPE_COUNT, buildFarShape, buildPlant, triangles, type FarShape } from '../src/render/models/plants';
import { Part } from '../src/render/models/plantKit';
import { WorldFields } from '../src/render/fields';
import {
  DeathKind,
  HIDE_MARGIN,
  LAYER_SLOT,
  NB,
  NT,
  SPOTS,
  TIER_RANGE,
  PlantField,
  SpeciesTable,
  assignLods,
  buildModels,
  capsFor,
  packColours,
  packSeedDry,
  packYawScale,
  spotThreshold,
  spotWanted,
  spotX,
  spotZ,
  tierOf,
  type FieldConditions,
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
function world(h = 5): { fields: WorldFields; field: PlantField } {
  const fields = new WorldFields();
  fields.surf.fill(h);
  const field = new PlantField(fields, new SpeciesTable(testSpecies()), models.tris);
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

function evaluate(field: PlantField, c = conditions()): void {
  field.tracked[TILE] = 1;
  field.evaluate(TILE, c);
}

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
          for (const name of ['position', 'normal', 'color', 'aPlant', 'aAttach']) {
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

  it('puts mangroves at the waterline and lilies only on ponds', () => {
    const shore = world(0.3);
    setLayer(shore.fields, P, 0, PlantModel.Mangrove, 1);
    evaluate(shore.field);
    expect(shore.field.sp[P * SPOTS]).toBe(PlantModel.Mangrove + 1);

    const dry = world(5);
    setLayer(dry.fields, P, 2, PlantModel.Lily, 1);
    evaluate(dry.field);
    expect(shownSpots(dry.field, P)).toEqual([]);
    const x = spotX(P, 3);
    const z = spotZ(P, 3);
    const pond: PondInfo = { id: 1, level: 5.6, x0: x - 10, z0: z - 10, x1: x + 10, z1: z + 10, salt: false };
    evaluate(dry.field, conditions(1, calm, [pond]));
    expect(shownSpots(dry.field, P).length).toBe(3);
    expect(dry.field.baseY[P * SPOTS + 3]).toBeCloseTo(5.605, 3);
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
    for (let i = 0; i < 3; i++) expect(b.field.dead[i * 12 + 7] % 16).toBe(DeathKind.Burial);

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
});

// ---------- tiers and caps ----------

describe('detail tiers and caps', () => {
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
    expect(phone.tris[0] + phone.tris[1] + phone.tris[2]).toBeCloseTo(120000, 0);
    const lighter = capsFor({ phone: true, density: 0.8, tier: 0 });
    expect(lighter.count[0]).toBeLessThan(600);
  });

  it('fills caps nearest first and hands overflow down a tier', () => {
    const n = 10;
    const order = Array.from({ length: n }, (_, i) => i);
    const tier = new Uint8Array(n); // all LOD0 tiles
    const cnt = new Int32Array(n * 3);
    const tri = new Float32Array(n * 3);
    for (let b = 0; b < n; b++) {
      cnt.set([100, 40, 10], b * 3);
      tri.set([5000, 1000, 200], b * 3);
    }
    const caps = { count: [300, 200, 1000] as [number, number, number], tris: [1e9, 1e9, 1e9] as [number, number, number] };
    const out = new Uint8Array(n);
    assignLods(order, n, tier, cnt, tri, caps, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 2, 2]);
    // Triangle caps bind too.
    const tight = { count: [1e9, 1e9, 1e9] as [number, number, number], tris: [12000, 1e9, 1e9] as [number, number, number] };
    assignLods(order, n, tier, cnt, tri, tight, out);
    expect(Array.from(out.slice(0, 3))).toEqual([0, 0, 1]);
  });

  it('never draws a block past its tile tier', () => {
    const order = [0, 1, 2];
    const tier = new Uint8Array([1, 2, 3]);
    const cnt = new Int32Array([5, 5, 5, 5, 5, 5, 5, 5, 5]);
    const tri = new Float32Array(9).fill(10);
    const out = new Uint8Array(3);
    assignLods(order, 3, tier, cnt, tri, capsFor({ phone: true, density: 1, tier: 1 }), out);
    expect(Array.from(out)).toEqual([1, 2, 3]);
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
