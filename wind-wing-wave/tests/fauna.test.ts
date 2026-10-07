/**
 * Animals (WP-F2): the body plans, and the real simulation run on the demo chain of islands.
 * - behaviour speeds stay within each species' range (and are lively, not frozen);
 * - agents that walk or swim stay on their habitats;
 * - agent, member and triangle caps hold on phone and laptop;
 * - the same seed spawns the same animals;
 * - nothing pops in or out in view while the camera is still (judged by what is drawn: size on
 *   screen times the creature shader's presence, which may only change as a fade);
 * - night, dawn, storm, brush and lava behaviour; colonies keep their ledges; the speck flock;
 * - the arrival scenes (vignettes) and their markers, and that their actors never pop either.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CELL, NP, NX, NZ, ORIGIN_X, ORIGIN_Z } from '../src/config';
import { SPECIES } from '../src/content/species';
import { ANIMAL_MODEL_COUNT, AnimalModel, Habitat, type Behaviour, type Road } from '../src/content/speciesTypes';
import { Columns } from '../src/engine/columns';
import { buildDemoChain, demoEco, demoLife } from '../src/engine/fixtures';
import { PLANT_BYTES, type LifeInfo, type StormState } from '../src/engine/protocol';
import { FaunaSim, GROUNDED, GROUP_SIZE, Life, SPECK_SIZE, T_HATCH, TRI_BUDGET, activityLevel, shelterLevel, speedLimit, viewFromCamera, type FaunaClock, type FaunaView } from '../src/render/fauna';
import { WorldFields } from '../src/render/fields';
import { HATCHLING_PLAN, Part, buildAnimalGeometries, planTriangles } from '../src/render/models/animals';
import { MARKER_SECONDS, VignetteSim, sceneFor, type Scene, type SceneKind } from '../src/render/vignettes';

// ---------- the demo world, built once ----------

function demoWorld(): { fields: WorldFields; life: LifeInfo } {
  const cols = new Columns();
  buildDemoChain(cols, 1);
  const fields = new WorldFields();
  const surf = new Float32Array(NX * NZ);
  const ground = new Uint8Array(NX * NZ * 4);
  cols.packRect(0, 0, NX, NZ, surf, ground);
  fields.apply({ t: 'cols', x0: 0, z0: 0, w: NX, h: NZ, surf, ground });
  const n = NP * NP;
  const out = { a: new Uint8Array(n * 4), b: new Uint8Array(n * 4), c: new Uint8Array(n * 4), plants: new Uint8Array(n * PLANT_BYTES), habitat: new Uint8Array(n) };
  demoEco(cols, SPECIES, out, 1);
  fields.apply({ t: 'eco', x0: 0, z0: 0, w: NP, h: NP, ...out });
  return { fields, life: demoLife(cols, SPECIES) };
}

const world = demoWorld();
const fields = world.fields;
/** The stub's life puts every animal on island 1 only; this one has them on all three islands. */
const lifeAll: LifeInfo = { ...world.life, pops: world.life.islands.flatMap((isl) => world.life.pops.map((p) => ({ ...p, island: isl.id }))) };
const geoms = buildAnimalGeometries();
const tris = planTriangles(geoms);

// ---------- a camera, a clock, a rig ----------

const DAY = 0.3;
const NIGHT = 0.85;
const DAWN = 0.05;
const CALM: StormState = { phase: 'none', t: 0, level: 0, great: false };

interface Rig {
  sim: FaunaSim;
  view: FaunaView;
  clock: FaunaClock;
  camera: THREE.PerspectiveCamera;
  target: THREE.Vector3;
}

function makeRig(seed: number, opts: { phone?: boolean; life?: LifeInfo; phase?: number } = {}): Rig {
  const phone = opts.phone ?? false;
  const sim = new FaunaSim(SPECIES, fields, { seed, phone, density: phone ? 0.8 : 1.2 }, tris);
  sim.setLife(opts.life ?? lifeAll);
  const camera = new THREE.PerspectiveCamera(50, phone ? 412 / 915 : 1280 / 760, 0.5, 16000);
  const view: FaunaView = { tx: 0, tz: 0, cx: 0, cy: 0, cz: 0, dist: 1, pxPerRad: 800, frustum: new THREE.Frustum() };
  const clock: FaunaClock = { t: 0, dt: 1 / 30, phase: opts.phase ?? DAY, wet: 0.7, storm: CALM, sunX: 0.45, sunZ: -0.35, brush: null, stroking: false };
  return { sim, view, clock, camera, target: new THREE.Vector3() };
}

const mat = new THREE.Matrix4();
function aim(r: Rig, x: number, z: number, dist: number, yaw = -0.6, pitch = 0.75, phone = false): void {
  r.target.set(x, Math.max(0, fields.heightAt(x, z)), z);
  const cp = Math.cos(pitch);
  r.camera.position.set(x + Math.sin(yaw) * cp * dist, r.target.y + Math.sin(pitch) * dist, z + Math.cos(yaw) * cp * dist);
  r.camera.near = Math.max(0.5, dist * 0.01);
  r.camera.updateProjectionMatrix();
  r.camera.lookAt(r.target);
  viewFromCamera(r.camera, r.target, dist, phone ? 915 * 2.625 : 760, r.view, mat);
}

function run(r: Rig, seconds: number, each?: () => void): void {
  const steps = Math.round(seconds / r.clock.dt);
  for (let s = 0; s < steps; s++) {
    r.clock.t += r.clock.dt;
    r.sim.step(r.clock, r.view);
    each?.();
  }
}

// Places on the demo chain (the volcano is centred at (40, -20), radius ~170).
const PLACES = {
  beach: { x: -330, z: 250, d: 25 }, // the white cay's west beach (island 2)
  cay: { x: -260, z: 250, d: 120 },
  cliff: { x: 175, z: -20, d: 120 }, // the seabird colony on the east cliff
  pond: { x: 20, z: -10, d: 40 }, // the crater pond
  reef: { x: -90, z: -25, d: 60 }, // the reef ring off the volcano's west shore
  forest: { x: 60, z: -60, d: 40 },
  overview: { x: 40, z: -20, d: 420 },
} as const;
type Place = keyof typeof PLACES;

function kindIndex(r: Rig, beh: Behaviour): number[] {
  return r.sim.kinds.flatMap((k, i) => (k.look.behaviour === beh ? [i] : []));
}

function liveOf(r: Rig, beh: Behaviour): number[] {
  const ks = new Set(kindIndex(r, beh));
  const out: number[] = [];
  for (let i = 0; i < r.sim.A.cap; i++) if (r.sim.A.life[i] !== Life.Free && ks.has(r.sim.A.kind[i])) out.push(i);
  return out;
}

// ---------- body plans ----------

describe('animal body plans', () => {
  it('every body plan is built (fireflies are points) within its triangle budget', () => {
    const limits: Record<number, number> = {
      [AnimalModel.Seabird]: 80,
      [AnimalModel.Frigatebird]: 110,
      [AnimalModel.SmallBird]: 80,
      [AnimalModel.Wader]: 100,
      [AnimalModel.Shorebird]: 80,
      [AnimalModel.Duck]: 100,
      [AnimalModel.Bat]: 80,
      [AnimalModel.Crab]: 70,
      [AnimalModel.Lizard]: 80,
      [AnimalModel.Tortoise]: 140,
      [AnimalModel.SeaTurtle]: 130,
      [AnimalModel.FishShoal]: 16,
      [AnimalModel.Ray]: 40,
      [AnimalModel.Dolphin]: 160,
      [AnimalModel.Whale]: 320,
      [AnimalModel.Butterfly]: 16,
      [AnimalModel.Dragonfly]: 32,
      [AnimalModel.Bee]: 24,
      [AnimalModel.Seal]: 130,
      [AnimalModel.Spider]: 60,
      [AnimalModel.Shark]: 100,
      [AnimalModel.Snail]: 70,
      [HATCHLING_PLAN]: 40,
    };
    for (let plan = 0; plan < ANIMAL_MODEL_COUNT; plan++) {
      if (plan === AnimalModel.Firefly) {
        expect(geoms[plan]).toBeNull();
        continue;
      }
      expect(geoms[plan], `plan ${plan}`).not.toBeNull();
      expect(tris[plan], `plan ${plan} triangles`).toBeGreaterThan(4);
      expect(tris[plan], `plan ${plan} triangles`).toBeLessThanOrEqual(limits[plan]);
    }
    expect(tris[HATCHLING_PLAN]).toBeLessThanOrEqual(limits[HATCHLING_PLAN]);
  });

  it('every vertex has a valid rig and paint', () => {
    for (const g of geoms) {
      if (!g) continue;
      const rig = g.getAttribute('aRig');
      const paint = g.getAttribute('aPaint');
      for (let v = 0; v < rig.count; v++) {
        const part = rig.getX(v);
        expect(Number.isInteger(part) && part >= Part.Body && part <= Part.RayWing).toBe(true);
        const w = paint.getX(v) + paint.getY(v) + paint.getZ(v);
        expect(w).toBeGreaterThanOrEqual(-1e-6);
        expect(w).toBeLessThanOrEqual(1 + 1e-6);
        expect(paint.getW(v)).toBeGreaterThan(0);
      }
      // Normals are finite everywhere (no degenerate faces left unhandled).
      const n = g.getAttribute('normal');
      for (let v = 0; v < n.count; v++) expect(Number.isFinite(n.getX(v) + n.getY(v) + n.getZ(v))).toBe(true);
    }
  });
});

// ---------- the rules of the day ----------

describe('time of day and storms', () => {
  it('day, night and dusk animals keep their hours', () => {
    expect(activityLevel('day', DAY)).toBe(1);
    expect(activityLevel('day', NIGHT)).toBe(0);
    expect(activityLevel('night', NIGHT)).toBe(1);
    expect(activityLevel('night', DAY)).toBe(0);
    expect(activityLevel('dusk', 0.7)).toBe(1);
    expect(activityLevel('dusk', DAY)).toBe(0);
    expect(activityLevel('dusk', NIGHT)).toBeGreaterThan(0.3);
    expect(activityLevel('any', NIGHT)).toBe(1);
  });

  it('shelter rises through the warning, holds at the peak and lifts as it clears', () => {
    expect(shelterLevel(CALM)).toBe(0);
    expect(shelterLevel({ phase: 'warning', t: 1, level: 0.1, great: false })).toBe(0);
    expect(shelterLevel({ phase: 'warning', t: 30, level: 0.5, great: false })).toBe(1);
    expect(shelterLevel({ phase: 'peak', t: 10, level: 1, great: false })).toBe(1);
    expect(shelterLevel({ phase: 'clearing', t: 28, level: 0.1, great: false })).toBe(0);
  });
});

// ---------- the simulation ----------

/** Run a still camera at a place and check every rule frame by frame. */
function watch(place: Place, opts: { phase?: number; seconds?: number; phone?: boolean; seed?: number; storm?: StormState } = {}) {
  const p = PLACES[place];
  const r = makeRig(opts.seed ?? 11, { phone: opts.phone, phase: opts.phase });
  if (opts.storm) r.clock.storm = opts.storm;
  aim(r, p.x, p.z, p.d, -0.6, 0.75, opts.phone);
  const A = r.sim.A;
  const M = r.sim.M;
  const n = A.cap;
  const prevSerial = new Uint32Array(n);
  const prevX = new Float64Array(n);
  const prevY = new Float64Array(n);
  const prevZ = new Float64Array(n);
  const prevSeen = new Uint8Array(n);
  const prevPresence = new Float32Array(n);
  const prevFramed = new Uint8Array(n);
  const prevBeh: string[] = new Array<string>(n).fill('');
  const mPrev = new Float32Array(M.blocks * GROUP_SIZE * 3);
  const mOwner = new Int32Array(M.blocks * GROUP_SIZE).fill(-1);
  const report = {
    speedFails: [] as string[],
    habitatFails: [] as string[],
    pops: [] as string[],
    capFails: [] as string[],
    maxSpeed: new Map<number, number>(),
    spawned: new Set<number>(),
    frames: 0,
  };
  const dt = r.clock.dt;
  run(r, opts.seconds ?? 120, () => {
    report.frames++;
    const first = report.frames === 1;
    if (r.sim.liveCount() > r.sim.cap) report.capFails.push(`${r.sim.liveCount()} agents > cap ${r.sim.cap}`);
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      const live = A.life[i] !== Life.Free;
      if (!live) {
        // An agent vanished: it must not have been on screen.
        if (prevSerial[i] && prevSeen[i] && !first) report.pops.push(`vanished in view: ${prevBeh[i]}`);
        prevSerial[i] = 0;
        continue;
      }
      const k = r.sim.kinds[A.kind[i]];
      // What is drawn: on-screen size times presence (the shader's screen-door fade).
      const seen = r.sim.seen(i, k);
      const presence = A.presence(i);
      const framed = r.sim.visiblePx(i, k, false) >= 1;
      if (A.serial[i] !== prevSerial[i]) {
        // A new agent: it must not be drawn visibly on its first frame (it starts out of view, too
        // small, hidden, or fading in), unless the camera just cut.
        report.spawned.add(A.kind[i]);
        if (prevSerial[i] && prevSeen[i] && !first) report.pops.push(`replaced in view: ${k.look.behaviour}`);
        if (seen && !first) report.pops.push(`appeared in view: ${k.look.behaviour} state ${A.st[i]} presence ${presence.toFixed(2)}`);
      } else {
        // In frame, presence may only change as a fade (a pop would be a jump within one frame).
        if (framed && prevFramed[i] && Math.abs(presence - prevPresence[i]) > dt * MAX_FADE_RATE + 1e-4) report.pops.push(`presence jumped in view: ${k.look.behaviour} st${A.st[i]} ${prevPresence[i].toFixed(2)} -> ${presence.toFixed(2)}`);
        // Speed since last frame.
        const dx = A.x[i] - prevX[i];
        const dy = A.y[i] - prevY[i];
        const dz = A.z[i] - prevZ[i];
        const onGround = A.y[i] <= Math.max(fields.heightAt(A.x[i], A.z[i]), 0) + 0.05;
        const v = (onGround ? Math.hypot(dx, dz) : Math.hypot(dx, dy, dz)) / dt;
        const lim = speedLimit(k.look) * 1.02 + 0.02;
        if (v > lim) report.speedFails.push(`${k.look.behaviour} st${A.st[i]} ${v.toFixed(2)} > ${lim.toFixed(2)} m/s`);
        report.maxSpeed.set(A.kind[i], Math.max(report.maxSpeed.get(A.kind[i]) ?? 0, v));
      }
      // Walkers and swimmers stay on their habitats (flyers may cross anything).
      if (GROUNDED.has(k.look.behaviour) && !k.group) {
        // Herons, sandpipers and ducks also fly between spots: only check them standing or afloat.
        const surf = Math.max(fields.heightAt(A.x[i], A.z[i]), r.sim.surface(A.x[i], A.z[i]));
        const airborne = A.y[i] > surf + 0.05 && (k.look.behaviour === 'wade' || k.look.behaviour === 'run-shore' || k.look.behaviour === 'paddle');
        const p = fields.patchIndex(A.x[i], A.z[i]);
        const h = p < 0 ? 0 : fields.habitat[p];
        if (!airborne && !(k.look.behaviour === 'nest-beach' && A.st[i] === T_HATCH) && !((k.allowed >>> h) & 1)) report.habitatFails.push(`${k.look.behaviour} st${A.st[i]} on habitat ${h}`);
      }
      if (k.group && A.group[i] >= 0) {
        const p = fields.patchIndex(A.x[i], A.z[i]);
        if (k.look.behaviour === 'shoal' && !((k.allowed >>> fields.habitat[p]) & 1)) report.habitatFails.push(`shoal centre on habitat ${fields.habitat[p]}`);
      }
      // Triangles actually drawn.
      if (A.hide[i] < 0.999 && !k.group && !(k.look.behaviour === 'nest-beach' && A.st[i] === T_HATCH)) drawn += tris[k.plan];
      if (A.group[i] >= 0 && (k.group || A.st[i] === T_HATCH)) {
        const m0 = A.group[i] * GROUP_SIZE;
        for (let m = m0; m < m0 + A.members[i]; m++) {
          if (k.look.behaviour === 'shoal') drawn += tris[AnimalModel.FishShoal];
          else if (A.st[i] === T_HATCH) drawn += tris[HATCHLING_PLAN];
          // Member speeds.
          if (mOwner[m] === A.serial[i]) {
            const v = Math.hypot(M.x[m] - mPrev[m * 3], M.y[m] - mPrev[m * 3 + 1], M.z[m] - mPrev[m * 3 + 2]) / dt;
            const lim = speedLimit(k.look) * 1.02 + 0.02;
            if (v > lim && M.hide[m] < 0.99) report.speedFails.push(`${k.look.behaviour} member ${v.toFixed(2)} > ${lim.toFixed(2)} m/s`);
            if (k.look.behaviour === 'shoal') report.maxSpeed.set(A.kind[i], Math.max(report.maxSpeed.get(A.kind[i]) ?? 0, v));
            if (k.look.behaviour === 'shoal' && Math.hypot(M.x[m] - A.x[i], M.z[m] - A.z[i]) > 8) report.habitatFails.push(`fish strayed from its shoal: ${Math.hypot(M.x[m] - A.x[i], M.z[m] - A.z[i]).toFixed(1)} m, fish depth ${(-fields.heightAt(M.x[m], M.z[m])).toFixed(2)}, centre depth ${(-fields.heightAt(A.x[i], A.z[i])).toFixed(2)} life ${A.life[i]} v ${A.v[i].toFixed(2)}`);
          }
          mOwner[m] = A.serial[i];
          mPrev[m * 3] = M.x[m];
          mPrev[m * 3 + 1] = M.y[m];
          mPrev[m * 3 + 2] = M.z[m];
        }
      }
      prevSerial[i] = A.serial[i];
      prevX[i] = A.x[i];
      prevY[i] = A.y[i];
      prevZ[i] = A.z[i];
      prevSeen[i] = seen ? 1 : 0;
      prevPresence[i] = presence;
      prevFramed[i] = framed ? 1 : 0;
      prevBeh[i] = k.look.behaviour;
    }
    if (drawn > TRI_BUDGET) report.capFails.push(`${drawn} animal triangles > ${TRI_BUDGET}`);
  });
  return { r, report };
}

/** Fades must take at least a quarter of a second (presence change per second, while in frame). */
const MAX_FADE_RATE = 4;

const SCENARIOS: [Place, number, boolean][] = [
  ['beach', DAY, false],
  ['beach', NIGHT, true],
  ['cliff', DAY, false],
  ['cliff', NIGHT, true],
  ['pond', DAY, true],
  ['reef', DAY, false],
  ['forest', DAY, false],
  ['forest', NIGHT, false],
  ['cay', DAY, true],
  ['overview', DAY, false],
];

describe('fauna simulation', () => {
  const results = SCENARIOS.map(([place, phase, phone]) => ({ place, phase, phone, ...watch(place, { phase, phone, seconds: 150 }) }));

  for (const { place, phase, phone, report, r } of results) {
    const label = `${place} ${phase === DAY ? 'day' : 'night'} ${phone ? 'phone' : 'laptop'}`;
    it(`${label}: animals appear`, () => {
      expect(report.spawned.size, label).toBeGreaterThan(place === 'overview' ? 0 : 2);
      expect(r.sim.liveCount()).toBeGreaterThan(0);
    });
    it(`${label}: speeds stay within each species' range`, () => {
      expect(report.speedFails.slice(0, 5), label).toEqual([]);
    });
    it(`${label}: walkers and swimmers stay on their habitats`, () => {
      expect(report.habitatFails.slice(0, 5), label).toEqual([]);
    });
    it(`${label}: caps hold (agents, triangles)`, () => {
      expect(report.capFails.slice(0, 3), label).toEqual([]);
      expect(r.sim.cap).toBe(phone ? 60 : 120);
    });
    it(`${label}: nothing pops in or out in view`, () => {
      expect(report.pops.slice(0, 5), label).toEqual([]);
    });
  }

  it('animals move at a real, lively pace (not frozen)', () => {
    const lively: Behaviour[] = ['colony', 'soar', 'flit', 'scuttle', 'glide-sea', 'shoal', 'paddle', 'night-fly', 'flutter', 'hover', 'buzz', 'run-shore', 'bask'];
    const best = new Map<string, number>();
    for (const { report, r } of results) {
      for (const [ki, v] of report.maxSpeed) {
        const k = r.sim.kinds[ki];
        if (!lively.includes(k.look.behaviour)) continue;
        best.set(k.look.behaviour, Math.max(best.get(k.look.behaviour) ?? 0, v / k.look.speed));
      }
    }
    for (const b of lively) {
      if (!best.has(b)) continue;
      expect(best.get(b)!, b).toBeGreaterThan(0.4);
    }
    expect(best.size).toBeGreaterThan(8);
  });

  it('the same seed spawns the same animals; another seed does not', () => {
    const a = watch('cliff', { seed: 5, seconds: 20 }).r.sim.A;
    const b = watch('cliff', { seed: 5, seconds: 20 }).r.sim.A;
    const c = watch('cliff', { seed: 6, seconds: 20 }).r.sim.A;
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.kind)).toEqual(Array.from(b.kind));
    expect(Array.from(a.x)).not.toEqual(Array.from(c.x));
  });

  it('colony seabirds wheel over the cliff and land on ledges', () => {
    const { r } = results.find((x) => x.place === 'cliff' && x.phase === DAY)!;
    const birds = liveOf(r, 'colony');
    expect(birds.length).toBeGreaterThan(8);
    const perched = birds.filter((i) => r.sim.A.st[i] === 3).length;
    const flying = birds.filter((i) => r.sim.A.st[i] === 0).length;
    expect(perched).toBeGreaterThan(0);
    expect(flying).toBeGreaterThan(0);
  });

  it('night brings bats and fireflies; day birds are gone and seabirds roost', () => {
    const forest = results.find((x) => x.place === 'forest' && x.phase === NIGHT)!.r;
    expect(liveOf(forest, 'night-fly').length).toBeGreaterThan(0);
    const swarms = liveOf(forest, 'glow');
    expect(swarms.length).toBeGreaterThan(0);
    expect(swarms.some((i) => forest.sim.A.hide[i] < 0.5)).toBe(true);
    expect(liveOf(forest, 'flit').length).toBe(0);
    expect(liveOf(forest, 'flutter').length).toBe(0);
    const cliff = results.find((x) => x.place === 'cliff' && x.phase === NIGHT)!.r;
    const birds = liveOf(cliff, 'colony');
    expect(birds.length).toBeGreaterThan(0);
    expect(birds.filter((i) => cliff.sim.A.st[i] === 3).length / birds.length).toBeGreaterThan(0.6);
  });

  it('a sea turtle crawls up the beach at night to dig her nest', () => {
    const { r } = watch('beach', { phase: NIGHT, seconds: 420, seed: 3 });
    let reached = false;
    const states: number[] = [];
    for (const i of liveOf(r, 'nest-beach')) {
      states.push(r.sim.A.st[i]);
      if (r.sim.A.st[i] >= 2 && r.sim.A.st[i] <= 6) reached = true;
    }
    // Run on until one has come ashore (it takes a few minutes, like the real thing).
    for (let s = 0; s < 6 && !reached; s++) {
      run(r, 60);
      for (const i of liveOf(r, 'nest-beach')) if (r.sim.A.st[i] >= 2 && r.sim.A.st[i] <= 6) reached = true;
    }
    expect(reached, `turtle states ${states.join(',')}`).toBe(true);
  });

  it('hatchlings dash to the sea at dawn when there is a turtle beach', () => {
    const r = makeRig(4, { phase: DAWN });
    aim(r, PLACES.beach.x, PLACES.beach.z, 40);
    run(r, 2);
    let clutch = -1;
    run(r, 30, () => {
      for (const i of liveOf(r, 'nest-beach')) if (r.sim.A.st[i] === T_HATCH) clutch = i;
    });
    expect(clutch).toBeGreaterThanOrEqual(0);
  });

  it('storms: seabirds shelter in the lee, crabs hide, insects go', () => {
    const peak: StormState = { phase: 'peak', t: 10, level: 1, great: false };
    const cliff = watch('cliff', { storm: peak, seconds: 90 }).r;
    const birds = liveOf(cliff, 'colony');
    const sheltered = birds.filter((i) => cliff.sim.A.st[i] === 8 || cliff.sim.A.st[i] === 7);
    expect(birds.length).toBeGreaterThan(0);
    expect(sheltered.length / birds.length).toBeGreaterThan(0.8);
    // Each sits out the storm on the west (lee) side of the island it is on: the wind blows from the east.
    const landed = sheltered.filter((i) => cliff.sim.A.st[i] === 8);
    const A = cliff.sim.A;
    expect(landed.length, sheltered.map((i) => A.st[i] + ' at ' + A.x[i].toFixed(0) + ',' + A.y[i].toFixed(0) + ',' + A.z[i].toFixed(0) + ' to ' + A.tx[i].toFixed(0) + ',' + A.ty[i].toFixed(0) + ',' + A.tz[i].toFixed(0) + ' v' + A.v[i].toFixed(1)).join(' | ')).toBeGreaterThan(0);
    for (const i of landed) {
      const x = cliff.sim.A.x[i];
      const z = cliff.sim.A.z[i];
      const isl = lifeAll.islands.reduce((a, b) => (Math.hypot(a.centroid[0] - x, a.centroid[1] - z) < Math.hypot(b.centroid[0] - x, b.centroid[1] - z) ? a : b));
      expect(x).toBeLessThan(isl.centroid[0]);
    }
    const beach = watch('beach', { storm: peak, seconds: 40 }).r;
    for (const i of liveOf(beach, 'scuttle')) expect(beach.sim.A.hide[i]).toBe(1);
    expect(liveOf(beach, 'flutter').concat(liveOf(beach, 'buzz')).every((i) => beach.sim.A.life[i] === Life.Leaving)).toBe(true);
  });

  it('animals move away from the working brush', () => {
    const { r } = watch('cliff', { seconds: 30 });
    const perched = liveOf(r, 'colony').filter((i) => r.sim.A.st[i] === 3);
    expect(perched.length).toBeGreaterThan(0);
    const i = perched[0];
    r.clock.brush = { x: r.sim.A.x[i], y: r.sim.A.y[i], z: r.sim.A.z[i], nx: 0, ny: 1, nz: 0, r: 6 };
    r.clock.stroking = true;
    run(r, 1.5);
    expect(r.sim.A.st[i]).not.toBe(3);
  });

  it('a camera far from any animal habitat shows nothing and keeps nothing', () => {
    const r = makeRig(9);
    aim(r, -450, -450, 30);
    run(r, 10);
    const left: string[] = [];
    for (let i = 0; i < r.sim.A.cap; i++) if (r.sim.A.life[i] !== Life.Free) left.push(r.sim.kinds[r.sim.A.kind[i]].look.behaviour + '@' + r.sim.A.x[i].toFixed(0) + ',' + r.sim.A.z[i].toFixed(0));
    expect(left).toEqual([]);
  });

  it('per-island populations: no beach animals on an island where none live', () => {
    const r = makeRig(12, { life: world.life }); // the stub: everything on island 1 only
    aim(r, PLACES.beach.x, PLACES.beach.z, PLACES.beach.d);
    run(r, 20);
    expect(liveOf(r, 'scuttle').length).toBe(0);
    expect(liveOf(r, 'run-shore').length).toBe(0);
  });
});

// ---------- changing the world for a test (always put back afterwards) ----------

/** Pour molten lava `thick` m deep within r of (x, z), straight into the mirrors. Returns the undo. */
function pourLava(x: number, z: number, r: number, thick: number): () => void {
  const saved: number[] = [];
  const i0 = Math.max(0, Math.floor((x - r - ORIGIN_X) / CELL));
  const i1 = Math.min(NX - 1, Math.floor((x + r - ORIGIN_X) / CELL));
  const k0 = Math.max(0, Math.floor((z - r - ORIGIN_Z) / CELL));
  const k1 = Math.min(NZ - 1, Math.floor((z + r - ORIGIN_Z) / CELL));
  for (let k = k0; k <= k1; k++) {
    for (let i = i0; i <= i1; i++) {
      if (Math.hypot(ORIGIN_X + (i + 0.5) * CELL - x, ORIGIN_Z + (k + 0.5) * CELL - z) > r) continue;
      const c = i + k * NX;
      saved.push(c, fields.surf[c], fields.ground[c * 4], fields.ground[c * 4 + 1]);
      fields.surf[c] += thick;
      fields.ground[c * 4] = Math.min(255, Math.round(thick * 20));
      fields.ground[c * 4 + 1] = 255;
    }
  }
  return () => {
    for (let s = saved.length - 4; s >= 0; s -= 4) {
      const c = saved[s];
      fields.surf[c] = saved[s + 1];
      fields.ground[c * 4] = saved[s + 2];
      fields.ground[c * 4 + 1] = saved[s + 3];
    }
  };
}

/** Send a columns message over a rectangle (as the engine would), its heights changed by `edit`. Returns the undo. */
function sendCols(x0: number, z0: number, w: number, h: number, edit: (x: number, z: number, y: number) => number): () => void {
  const pack = (fn: (x: number, z: number, y: number) => number) => {
    const surf = new Float32Array(w * h);
    const ground = new Uint8Array(w * h * 4);
    for (let k = 0; k < h; k++) {
      for (let i = 0; i < w; i++) {
        const c = x0 + i + (z0 + k) * NX;
        surf[i + k * w] = fn(ORIGIN_X + (x0 + i + 0.5) * CELL, ORIGIN_Z + (z0 + k + 0.5) * CELL, fields.surf[c]);
        ground.set(fields.ground.subarray(c * 4, c * 4 + 4), (i + k * w) * 4);
      }
    }
    return { surf, ground };
  };
  const before = pack((_x, _z, y) => y);
  fields.apply({ t: 'cols', x0, z0, w, h, ...pack(edit) });
  return () => fields.apply({ t: 'cols', x0, z0, w, h, ...before });
}

/** Set the habitat of every patch within r of (x, z), except the one at the centre. Returns the undo. */
function paintHabitat(x: number, z: number, r: number, h: number): () => void {
  const saved: number[] = [];
  const own = fields.patchIndex(x, z);
  for (let dz = -r; dz <= r; dz += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      if (Math.hypot(dx, dz) > r) continue;
      const p = fields.patchIndex(x + dx, z + dz);
      if (p < 0 || p === own || saved.includes(p)) continue;
      saved.push(p, fields.habitat[p]);
      fields.habitat[p] = h;
    }
  }
  return () => {
    for (let s = saved.length - 2; s >= 0; s -= 2) fields.habitat[saved[s]] = saved[s + 1];
  };
}

interface ColonyView {
  uid: number;
  x: number;
  z: number;
  r: number;
  y: number;
  yDraw: number;
  ledges: Float32Array;
  ledgeCount: number;
  taken: Uint8Array;
}
const coloniesOf = (r: Rig): ColonyView[] => (r.sim as unknown as { colonies: ColonyView[] }).colonies;

describe('fauna and the changing world', () => {
  it('lava: walkers hurry off a flow, crabs dig in elsewhere; none stays on molten lava, none vanishes in view', () => {
    for (const place of ['reef', 'beach'] as const) {
      const p = PLACES[place];
      const r = makeRig(31, { phone: true });
      aim(r, p.x, p.z, p.d, -0.6, 0.75, true);
      run(r, 60);
      const A = r.sim.A;
      const tracked: { i: number; serial: number; beh: string }[] = [];
      const undo: (() => void)[] = [];
      for (const beh of ['bask', 'graze', 'scuttle'] as Behaviour[]) {
        for (const i of liveOf(r, beh)) {
          if (beh === 'scuttle' && A.hide[i] >= 1) continue; // underground: never seen again, nothing to show
          tracked.push({ i, serial: A.serial[i], beh });
          undo.push(pourLava(A.x[i], A.z[i], 6, 1.5));
        }
      }
      const fails: string[] = [];
      try {
        expect(tracked.length, place).toBeGreaterThan(2);
        const wasSeen = tracked.map(() => false);
        const reachedSafety = tracked.map(() => false);
        run(r, 75, () => {
          tracked.forEach((t, n) => {
            const same = A.serial[t.i] === t.serial && A.life[t.i] !== Life.Free;
            if (!same && wasSeen[n]) fails.push(`${t.beh} vanished in view`);
            wasSeen[n] = same && r.sim.seen(t.i, r.sim.kinds[A.kind[t.i]]);
            if (same && A.esc[t.i] <= 0 && !r.sim.lavaNear(A.x[t.i], A.z[t.i], 3)) reachedSafety[n] = true;
          });
        });
        for (const t of tracked) {
          if (A.serial[t.i] !== t.serial || A.life[t.i] === Life.Free) continue; // let go later, out of sight
          const lava = fields.lavaAt(A.x[t.i], A.z[t.i]);
          if (lava > 0.02) fails.push(`${t.beh} still on ${lava.toFixed(2)} m of lava (escaping ${A.esc[t.i].toFixed(0)} s)`);
        }
        // They got away on their own feet (out of sight, one may since have been let go as usual).
        // Most got away on their own feet; the rest were let go out of sight, as animals out of frame are.
        const safe = reachedSafety.filter(Boolean).length;
        expect(safe, `${place}: ${safe} of ${tracked.length} reached safe ground`).toBeGreaterThanOrEqual(tracked.length * 0.5);
      } finally {
        for (let u = undo.length - 1; u >= 0; u--) undo[u]();
      }
      expect(fails, place).toEqual([]);
    }
  });

  it('a tortoise overrun by lava plods off it, in view, and settles clear of the flow', () => {
    const r = makeRig(33);
    aim(r, PLACES.reef.x, PLACES.reef.z, PLACES.reef.d);
    run(r, 40);
    const A = r.sim.A;
    const i = liveOf(r, 'graze').find((j) => r.sim.seen(j, r.sim.kinds[A.kind[j]]))!;
    expect(i).toBeDefined();
    const serial = A.serial[i];
    aim(r, A.x[i], A.z[i], 45);
    const undo = pourLava(A.x[i], A.z[i], 6, 1.5);
    let offLava = -1;
    let t = 0;
    try {
      run(r, 90, () => {
        t += r.clock.dt;
        expect(A.serial[i], 'still the same tortoise').toBe(serial);
        if (offLava < 0 && fields.lavaAt(A.x[i], A.z[i]) < 0.02) offLava = t;
      });
      expect(fields.lavaAt(A.x[i], A.z[i])).toBeLessThan(0.02);
      expect(r.sim.lavaNear(A.x[i], A.z[i], 4)).toBe(false);
    } finally {
      undo();
    }
    // Six metres of lava at a tortoise's hurry (0.3 m/s): off it in well under a minute.
    expect(offLava).toBeGreaterThan(0);
    expect(offLava).toBeLessThan(35);
  });

  it('colony ledges stay put through ecology and life updates; only changed ground moves them', () => {
    const r = makeRig(21, { phone: true });
    aim(r, PLACES.cliff.x, PLACES.cliff.z, PLACES.cliff.d, -0.6, 0.75, true);
    run(r, 40);
    const A = r.sim.A;
    const holders = (c: ColonyView) => {
      let n = 0;
      for (let i = 0; i < A.cap; i++) if (A.life[i] !== Life.Free && A.col[i] === c.uid && A.a3[i] >= 0) n++;
      return n;
    };
    const taken = (c: ColonyView) => c.taken.reduce((a, b) => a + b, 0);
    const snap = () => coloniesOf(r).map((c) => ({ uid: c.uid, ledges: Array.from(c.ledges.subarray(0, c.ledgeCount * 4)), y: c.y }));
    const consistent: string[] = [];
    const check = () => {
      for (const c of coloniesOf(r)) if (taken(c) !== holders(c)) consistent.push(`colony ${c.uid}: ${taken(c)} ledges taken, ${holders(c)} birds hold one`);
    };
    const before = snap();
    expect(before.length).toBeGreaterThan(0);
    expect(coloniesOf(r).some((c) => holders(c) > 0)).toBe(true);
    // Ecology at 2 Hz and life at 1 Hz, for 20 s: nothing about the colony moves.
    const ys: number[] = [];
    let frame = 0;
    run(r, 20, () => {
      if (frame % 15 === 0) fields.ecoVersion++;
      if (frame % 30 === 0) r.sim.setLife({ ...lifeAll });
      frame++;
      ys.push(coloniesOf(r)[0].yDraw);
      check();
    });
    expect(snap()).toEqual(before);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6);
    // The same ground sent again (a columns message over the colony): exactly the same ledges.
    const c0 = coloniesOf(r)[0];
    const half = Math.ceil((c0.r + 20) / CELL);
    const ci = Math.floor((c0.x - ORIGIN_X) / CELL) - half;
    const ck = Math.floor((c0.z - ORIGIN_Z) / CELL) - half;
    sendCols(ci, ck, half * 2, half * 2, (_x, _z, y) => y);
    run(r, 3, check);
    expect(snap()).toEqual(before);
    // Raise the ground on one side of the colony: ledges there change, and every claim stays consistent.
    const undo = sendCols(ci, ck, half * 2, half * 2, (x, _z, y) => (x > c0.x && y > 2 ? y + 4 : y));
    try {
      run(r, 4, check);
      expect(snap()).not.toEqual(before);
    } finally {
      undo();
    }
    run(r, 4, check);
    expect(snap()).toEqual(before);
    // The colony grows (a new life message with a bigger radius): its birds move over with their ledges.
    const holding = coloniesOf(r).reduce((n, c) => n + holders(c), 0);
    r.sim.setLife({ ...lifeAll, colonies: lifeAll.colonies.map((c) => ({ ...c, r: c.r + 3 })) });
    run(r, 0.1, check);
    expect(coloniesOf(r).every((c) => before.every((b) => b.uid !== c.uid))).toBe(true);
    expect(coloniesOf(r).reduce((n, c) => n + holders(c), 0)).toBeGreaterThanOrEqual(Math.floor(holding * 0.5));
    run(r, 10, check);
    expect(consistent.slice(0, 3)).toEqual([]);
  });

  it('the speck flock only shows far, small birds, and roosts at night and in storms', () => {
    for (const phone of [true, false]) {
      const r = makeRig(5, { phone });
      aim(r, PLACES.cliff.x, PLACES.cliff.z, PLACES.cliff.d, -0.6, 0.75, phone);
      const near: string[] = [];
      run(r, 10, () => {
        const S = r.sim.specks;
        for (let s = 0; s < r.sim.speckCount; s++) {
          const eye = Math.hypot(S[s * 8] - r.view.cx, S[s * 8 + 1] - r.view.cy, S[s * 8 + 2] - r.view.cz);
          const px = (SPECK_SIZE * r.view.pxPerRad) / eye;
          if (eye < 150 || px > 12) near.push(`speck at ${eye.toFixed(0)} m, ${px.toFixed(1)} px`);
        }
      });
      expect(near.slice(0, 3), phone ? 'phone' : 'laptop').toEqual([]);
    }
    const flock = (phase: number, storm: StormState) => {
      const r = makeRig(5, { phase });
      r.clock.storm = storm;
      aim(r, PLACES.overview.x, PLACES.overview.z, PLACES.overview.d);
      run(r, 5);
      return r.sim.speckCount;
    };
    expect(flock(DAY, CALM)).toBeGreaterThan(20);
    expect(flock(NIGHT, CALM)).toBe(0);
    expect(flock(DAY, { phase: 'peak', t: 10, level: 1, great: false })).toBe(0);
  });

  it('a nesting turtle blocked on her way down crawls to the water; she never swims on dry sand', () => {
    const r = makeRig(14, { phase: NIGHT });
    // A spot on the cay's west beach, about 0.7 m above the sea.
    let bx = PLACES.cay.x;
    while (fields.heightAt(bx, PLACES.cay.z) > 0.7) bx -= 0.25;
    const bz = PLACES.cay.z;
    aim(r, bx, bz, 20);
    run(r, 1);
    const ki = kindIndex(r, 'nest-beach')[0];
    const k = r.sim.kinds[ki];
    const A = r.sim.A;
    const i = A.alloc(ki);
    expect(i).toBeGreaterThanOrEqual(0);
    A.x[i] = bx;
    A.z[i] = bz;
    A.y[i] = fields.heightAt(bx, bz);
    A.scale[i] = k.size;
    A.st[i] = 6; // crawling back down to the sea
    A.tm[i] = 300;
    // Rock shore all round her (not a turtle's ground): the way straight down is blocked.
    const undo = paintHabitat(bx, bz, 8, Habitat.RockShore);
    const serial = A.serial[i];
    const wrong: string[] = [];
    let swam = false;
    try {
      run(r, 150, () => {
        if (A.serial[i] !== serial || A.life[i] === Life.Free) return;
        const depth = r.sim.surface(A.x[i], A.z[i]) - fields.heightAt(A.x[i], A.z[i]);
        if (A.st[i] === 0 && depth < 0.3) wrong.push(`swimming in ${depth.toFixed(2)} m of water`);
        if (A.st[i] === 0) swam = true;
      });
    } finally {
      undo();
    }
    expect(wrong.slice(0, 3)).toEqual([]);
    expect(swam).toBe(true);
  });

  it('a seabird caught by a storm mid-dive keeps its wheeling height', () => {
    const r = makeRig(8);
    aim(r, PLACES.cliff.x, PLACES.cliff.z, PLACES.cliff.d);
    run(r, 30);
    const A = r.sim.A;
    const i = liveOf(r, 'colony').find((j) => A.st[j] === 0)!;
    expect(i).toBeDefined();
    const height = A.a1[i];
    const serial = A.serial[i];
    A.st[i] = 5; // climb for a plunge dive
    A.tm[i] = 0;
    run(r, 3);
    r.clock.storm = { phase: 'peak', t: 10, level: 1, great: false };
    run(r, 2);
    r.clock.storm = CALM;
    let checked = 0;
    run(r, 40, () => {
      if (A.serial[i] !== serial || A.life[i] === Life.Free) return;
      expect(A.a1[i]).toBe(height);
      checked++;
    });
    expect(checked).toBeGreaterThan(0);
  });
});

// ---------- arrival scenes ----------

describe('arrival scenes', () => {
  const ROADS: Road[] = ['wind', 'sea', 'raft', 'bird', 'flight', 'storm'];
  const KINDS: SceneKind[] = ['motes', 'silk', 'coconut', 'seeds', 'raft', 'bird', 'flyers', 'swim', 'crab'];

  it('every species on every road has a scene that fits it', () => {
    for (const s of SPECIES) {
      for (const road of ROADS) {
        const k = sceneFor(s, road);
        expect(KINDS).toContain(k);
        if (!s.animal) expect(['motes', 'coconut', 'seeds', 'raft', 'bird']).toContain(k);
      }
    }
    const palm = SPECIES.find((s) => s.plant?.model === 9)!;
    expect(sceneFor(palm, 'sea')).toBe('coconut');
    const lizard = SPECIES.find((s) => s.animal?.model === AnimalModel.Lizard)!;
    expect(sceneFor(lizard, 'raft')).toBe('raft');
    const spider = SPECIES.find((s) => s.animal?.model === AnimalModel.Spider)!;
    expect(sceneFor(spider, 'wind')).toBe('silk');
  });

  function vignetteRig(lookAway = false): { sim: VignetteSim; view: FaunaView; step: (s: number) => void; clock: { t: number; dt: number; storm: number } } {
    const sim = new VignetteSim(SPECIES, fields, 3);
    const cam = new THREE.PerspectiveCamera(50, 1280 / 760, 0.5, 16000);
    const target = new THREE.Vector3(-334, 0.5, 250);
    cam.position.set(-306, 12, 250);
    cam.lookAt(lookAway ? new THREE.Vector3(-306, 40, 300) : target);
    const view: FaunaView = { tx: 0, tz: 0, cx: 0, cy: 0, cz: 0, dist: 30, pxPerRad: 800, frustum: new THREE.Frustum() };
    viewFromCamera(cam, target, 30, 760, view, mat);
    const clock = { t: 0, dt: 1 / 30, storm: 0 };
    return {
      sim,
      view,
      clock,
      step: (seconds: number) => {
        for (let s = 0; s < seconds * 30; s++) {
          clock.t += clock.dt;
          sim.step(clock, view);
        }
      },
    };
  }

  const cases: [string, Road, boolean][] = [
    ['palm', 'sea', true],
    ['palm', 'sea', false],
    ['vine', 'sea', true],
    ['anole', 'raft', true],
    ['anole', 'raft', false],
    ['booby', 'flight', true],
    ['booby', 'flight', false],
    ['fig', 'bird', true],
    ['lichen', 'wind', true],
    ['lichen', 'wind', false],
    ['spider', 'wind', true],
    ['butterfly', 'flight', true],
    ['turtle', 'sea', true],
    ['whale', 'flight', false],
    ['ghostcrab', 'sea', true],
    ['tortoise', 'sea', true],
  ];
  for (const [key, road, ok] of cases) {
    it(`${key} by ${road} (${ok ? 'stays' : 'leaves'}) plays a calm scene that ends quietly`, () => {
      const s = SPECIES.find((x) => x.key === key)!;
      const { sim, view, step } = vignetteRig();
      sim.arrive({ species: s.id, road, x: -332, z: 250, island: 2, ok, first: true, returned: false }, view);
      const sc = sim.scenes.find((x) => x.on && !x.waiting)!;
      expect(sc).toBeDefined();
      step(8);
      expect(sc.on, 'still playing after 8 s').toBe(true);
      // Let it run its course; the camera then looks away so the last actors can quietly go.
      step(120);
      const away = vignetteRig(true);
      for (let t = 0; t < 400 * 30 && sc.on; t++) {
        away.clock.t += away.clock.dt;
        sim.step(away.clock, away.view);
      }
      expect(sc.on, 'finished').toBe(false);
    });
  }

  it('wind-blown spores settle on the ground at the spot when they stay, and blow past when not', () => {
    for (const ok of [true, false]) {
      const { sim, view, step } = vignetteRig();
      sim.arrive({ species: SPECIES.find((x) => x.key === 'lichen')!.id, road: 'wind', x: -320, z: 250, island: 2, ok, first: true, returned: false }, view);
      const sc = sim.scenes.find((x) => x.on && !x.waiting)!;
      step(29);
      let near = 0;
      for (let m = 0; m < sc.m; m++) if (Math.hypot(sc.mx[m] + 320, sc.mz[m] - 250) < 6.5) near++;
      if (ok) expect(near / sc.m).toBeGreaterThan(0.9);
      else expect(near / sc.m).toBeLessThan(0.1);
    }
  });

  it('a coconut that stays rolls up onto the beach; one that cannot stay washes back out', () => {
    for (const ok of [true, false]) {
      const { sim, view, step } = vignetteRig();
      sim.arrive({ species: SPECIES.find((x) => x.key === 'palm')!.id, road: 'sea', x: -332, z: 250, island: 2, ok, first: true, returned: false }, view);
      const sc = sim.scenes.find((x) => x.on && !x.waiting)!;
      step(30);
      const h = fields.heightAt(sc.x0[0], sc.z0[0]);
      if (ok) expect(h).toBeGreaterThan(0);
      else expect(h).toBeLessThan(0);
    }
  });

  it('every arrival leaves a glowing marker for about 30 s, even far away', () => {
    const { sim, step } = vignetteRig();
    sim.arrive({ species: 0, road: 'wind', x: 200, z: 150, island: 3, ok: true, first: true, returned: false }, null);
    expect(sim.markers.filter((m) => m.on).length).toBe(1);
    expect(sim.activeScenes()).toBe(0);
    step(MARKER_SECONDS - 1);
    expect(sim.markers.filter((m) => m.on).length).toBe(1);
    step(2);
    expect(sim.markers.filter((m) => m.on).length).toBe(0);
  });

  it('a far arrival plays when the camera glides there while its marker still glows', () => {
    const { sim, view, step } = vignetteRig();
    sim.arrive({ species: SPECIES.find((x) => x.key === 'booby')!.id, road: 'flight', x: 180, z: -20, island: 1, ok: true, first: true, returned: false }, view);
    expect(sim.activeScenes()).toBe(0);
    step(1);
    expect(sim.activeScenes()).toBe(0);
    const cam = new THREE.PerspectiveCamera(50, 1280 / 760, 0.5, 16000);
    cam.position.set(220, 40, -20);
    cam.lookAt(180, 10, -20);
    viewFromCamera(cam, new THREE.Vector3(180, 10, -20), 60, 760, view, mat);
    step(1);
    expect(sim.activeScenes()).toBe(1);
  });

  it('arrival actors never pop: each starts out of sight or fades in, fades only gradually, and goes only unseen', () => {
    const scenes: [string, Road, boolean][] = [
      ['turtle', 'sea', true],
      ['whale', 'flight', true],
      ['tortoise', 'sea', true],
      ['shark', 'sea', false],
      ['seal', 'sea', true],
      ['dolphin', 'sea', true],
      ['anole', 'raft', true],
      ['anole', 'raft', false],
      ['palm', 'sea', true],
      ['palm', 'sea', false],
      ['booby', 'flight', true],
      ['fig', 'bird', true],
      ['ghostcrab', 'sea', true],
      ['ghostcrab', 'sea', false],
      ['butterfly', 'flight', true],
      ['spider', 'wind', true],
    ];
    const spot = { x: -332, z: 250 };
    const pops: string[] = [];
    let drawnActors = 0;
    for (const phone of [true, false]) {
      for (const yaw of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const cam = new THREE.PerspectiveCamera(50, phone ? 412 / 915 : 1280 / 760, 0.5, 16000);
        const target = new THREE.Vector3(spot.x, Math.max(0, fields.heightAt(spot.x, spot.z)), spot.z);
        cam.position.set(spot.x + Math.sin(yaw) * 38, target.y + 14, spot.z + Math.cos(yaw) * 38);
        cam.lookAt(target);
        const view: FaunaView = { tx: 0, tz: 0, cx: 0, cy: 0, cz: 0, dist: 40, pxPerRad: 800, frustum: new THREE.Frustum() };
        viewFromCamera(cam, target, 40, phone ? 915 * 2.625 : 760, view, mat);
        for (const [key, road, ok] of scenes) {
          const label = `${key}/${road}/${ok ? 'stays' : 'leaves'} ${phone ? 'phone' : 'laptop'} yaw ${yaw.toFixed(1)}`;
          const sim = new VignetteSim(SPECIES, fields, 3);
          const clock = { t: 0, dt: 1 / 30, storm: 0 };
          sim.arrive({ species: SPECIES.find((x) => x.key === key)!.id, road, x: spot.x, z: spot.z, island: 2, ok, first: true, returned: false }, view);
          const sc: Scene | undefined = sim.scenes.find((x) => x.on && !x.waiting);
          if (!sc) continue; // nothing to play here (a crab with no shore)
          const drawn = new Uint8Array(sc.n);
          const prevP = new Float32Array(sc.n);
          const prevFramed = new Uint8Array(sc.n);
          for (let f = 0; f < 150 * 30 && sc.on; f++) {
            clock.t += clock.dt;
            sim.step(clock, view);
            for (let i = 0; i < sc.n; i++) {
              const p = sc.presence(i);
              const px = sim.visiblePx(sc, i, false);
              if (sc.gone[i]) {
                if (drawn[i] === 1) {
                  // It was just let go: it must have been out of sight at that moment.
                  if (px * p >= 1) pops.push(`${label}: actor ${i} went while ${(px * p).toFixed(1)} px`);
                  drawn[i] = 2;
                }
                continue;
              }
              if (p < 0.001) continue;
              if (!drawn[i]) {
                drawn[i] = 1;
                drawnActors++;
                if (px * p >= 1) pops.push(`${label}: actor ${i} appeared at ${(px * p).toFixed(1)} px (presence ${p.toFixed(2)})`);
              } else if (px >= 1 && prevFramed[i] && Math.abs(p - prevP[i]) > clock.dt * MAX_FADE_RATE + 1e-4) {
                pops.push(`${label}: actor ${i} presence jumped ${prevP[i].toFixed(2)} -> ${p.toFixed(2)}`);
              }
              prevP[i] = p;
              prevFramed[i] = px >= 1 ? 1 : 0;
            }
          }
        }
      }
    }
    expect(drawnActors).toBeGreaterThan(50);
    expect(pops.slice(0, 6)).toEqual([]);
  });
});

