import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BASKET_CAPACITY, DAY } from '../src/config';
import { LagoonTerrain } from '../src/engine/terrain';
import { Beach, MAX_ON_SAND } from '../src/game/beach';
import { Player, type Deck, type PlayerWorld } from '../src/player/player';
import { advanceClock } from '../src/render/daylight';
import { swellAt } from '../src/render/ocean';
import { ANCHORAGE, HomeCayTerrain } from '../src/world/homeCay';

const terrain = new HomeCayTerrain();

describe('Home Cay: the island', () => {
  it('is exactly the old lagoon beach on the editable sand (so saved castles stay put)', () => {
    const lagoon = new LagoonTerrain();
    const r = terrain.region;
    let worst = 0;
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 30; j++) {
        const x = r.x0 + ((r.x1 - r.x0) * i) / 40;
        const z = r.z0 + ((r.z1 - r.z0) * j) / 30;
        worst = Math.max(worst, Math.abs(terrain.heightAt(x, z) - lagoon.heightAt(x, z)));
      }
    }
    expect(worst).toBe(0);
  });

  it('has a sensible shape: land, a lagoon for the boat, a reef, deep water beyond', () => {
    const anchorage = terrain.heightAt(ANCHORAGE.x, ANCHORAGE.z);
    expect(anchorage).toBeLessThan(-2.2);
    expect(anchorage).toBeGreaterThan(-4.2);
    expect(terrain.heightAt(4, 30)).toBeGreaterThan(1); // the middle of the island
    expect(terrain.heightAt(34, 44)).toBeGreaterThan(5); // the hill
    // Going south from the cove: lagoon, then the reef is shallower, then deep sea.
    const lagoon = terrain.heightAt(0, -60);
    let reef = -Infinity;
    for (let z = -80; z > -120; z -= 1) reef = Math.max(reef, terrain.heightAt(0, z));
    const deep = terrain.heightAt(0, -170);
    expect(reef).toBeGreaterThan(lagoon + 1);
    expect(deep).toBeLessThan(-10);
  });

  it('has no holes or spikes (no NaN, gentle steps on the beaches)', () => {
    for (let x = -150; x <= 160; x += 3.7) {
      for (let z = -150; z <= 150; z += 3.3) {
        const h = terrain.heightAt(x, z);
        expect(Number.isFinite(h)).toBe(true);
        expect(Math.abs(terrain.heightAt(x + 0.5, z) - h)).toBeLessThan(1.2);
      }
    }
  });

  it('has a tideline all round the beaches, on sand just above the water', () => {
    const line = terrain.tideline(0.7);
    expect(line.length).toBeGreaterThan(150);
    for (const p of line) {
      const h = terrain.heightAt(p.x, p.z);
      expect(h).toBeGreaterThan(0.05);
      expect(h).toBeLessThan(1.0);
      expect(terrain.groundAt(p.x, p.z)).not.toBe('rock');
    }
  });
});

describe('the sea', () => {
  it('is still over the beach (holes hold calm water) and livelier out deep', () => {
    expect(swellAt(0.4)).toBe(0);
    expect(swellAt(-3)).toBeGreaterThan(0.3);
    expect(swellAt(-20)).toBeGreaterThan(swellAt(-3));
  });
});

describe('the clock', () => {
  it('a whole day takes about 24 real minutes, and the day number moves on at midnight', () => {
    const c = { day: 1, hour: 0 };
    let t = 0;
    while (c.day === 1) {
      advanceClock(c, 0.5);
      t += 0.5;
    }
    expect(t / 60).toBeGreaterThan(20);
    expect(t / 60).toBeLessThan(28);
    expect(c.hour).toBeLessThan(0.1);
    expect(DAY.washUpHour).toBeLessThan(DAY.start);
  });
});

describe('beachcombing', () => {
  const line = terrain.tideline(0.6);

  it('the sea leaves new finds each morning, the same ones for the same day', () => {
    const a = new Beach(line);
    const b = new Beach(line);
    const n = a.washUp(3);
    b.washUp(3);
    expect(n).toBeGreaterThanOrEqual(10);
    expect(a.state.ground.map((g) => g.kind)).toEqual(b.state.ground.map((g) => g.kind));
    expect(a.state.lastWash).toBe(3);
  });

  it('never leaves more than a set number lying about (the tide takes the oldest back)', () => {
    const beach = new Beach(line);
    for (let d = 1; d <= 20; d++) beach.washUp(d);
    expect(beach.state.ground.length).toBeLessThanOrEqual(MAX_ON_SAND);
    expect(beach.state.ground[beach.state.ground.length - 1].day).toBe(20);
  });

  it('picking up fills the basket, says when something is new, and stops when the basket is full', () => {
    const beach = new Beach(line);
    for (let d = 1; d <= 3; d++) beach.washUp(d);
    const first = beach.state.ground[0];
    const r = beach.pickUp(first.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.first).toBe(true);
    expect(beach.pickUp(first.id)).toEqual({ ok: false, reason: 'gone' });
    while (beach.state.basket.length < BASKET_CAPACITY) beach.pickUp(beach.state.ground[0].id);
    expect(beach.pickUp(beach.state.ground[0].id)).toEqual({ ok: false, reason: 'full' });
    const total = Object.values(beach.state.found).reduce((a, b) => a + (b ?? 0), 0);
    expect(total).toBe(BASKET_CAPACITY);
  });

  it('emptying the basket puts every find in the locker', () => {
    const beach = new Beach(line);
    beach.washUp(1);
    for (let i = 0; i < 5; i++) beach.pickUp(beach.state.ground[0].id);
    expect(beach.emptyBasket()).toBe(5);
    expect(beach.state.basket.length).toBe(0);
    expect(Object.values(beach.state.locker).reduce((a, b) => a + (b ?? 0), 0)).toBe(5);
  });

  it('a saved beach comes back the same, and junk in a save is ignored', () => {
    const beach = new Beach(line);
    beach.washUp(2);
    beach.pickUp(beach.state.ground[0].id);
    const copy = Beach.restore(JSON.parse(JSON.stringify(beach.state)));
    expect(copy).toEqual(beach.state);
    const junk = Beach.restore({ ground: [{ kind: 'dragon', x: 1, z: 2 }], basket: ['nope', 'cowrie'], locker: { cowrie: 'x' }, nextId: 'q' });
    expect(junk.ground.length).toBe(0);
    expect(junk.basket).toEqual(['cowrie']);
    expect(junk.locker).toEqual({});
  });
});

describe('you (first person)', () => {
  // A simple test world: a flat sandy shore at x < 0 sloping into the sea, and a box-shaped boat out at x = 20.
  const boatObj = new THREE.Object3D();
  boatObj.position.set(20, 0, 0);
  boatObj.updateMatrixWorld(true);
  const deck: Deck = {
    heightAt: (lx, lz) => (Math.abs(lx) < 3 && Math.abs(lz) < 1 ? 0.8 : null),
    blocked: () => false,
    insideLifelines: (lx, lz) => Math.abs(lx) < 2.6 && Math.abs(lz) < 0.8,
    halfBeam: (lx) => (Math.abs(lx) < 3 ? 1 : 0),
  };
  const world: PlayerWorld = {
    groundAt: (x) => (x < 0 ? 0.3 : 0.3 - x * 0.3),
    waterAt: () => 0,
    trunks: [],
    boat: { obj: boatObj, deck, ladderTop: new THREE.Vector3(-2.4, 0.8, 0), ladderBottom: new THREE.Vector3(-3.4, -0.5, 0), length: 6 },
    bounds: { cx: 0, cz: 0, r: 100 },
  };
  const east = -Math.PI / 2; // facing +x

  it('walks on land, wades, then swims once the water is deep', () => {
    const p = new Player(world);
    p.placeWorld(-2, 0, east);
    expect(p.mode).toBe('land');
    let swam = false;
    for (let i = 0; i < 600 && !swam; i++) {
      p.update(1 / 60, { x: 0, y: 1 }, false, false);
      if (p.mode === 'swim') swam = true;
    }
    expect(swam).toBe(true);
    // Swimming: the eye is just above the water.
    expect(p.eye.y).toBeGreaterThan(0.05);
    expect(p.eye.y).toBeLessThan(0.5);
  });

  it('walks back out of the water onto the beach', () => {
    const p = new Player(world);
    p.placeWorld(8, 0, Math.PI / 2); // facing -x, toward the shore
    expect(p.mode).toBe('swim');
    for (let i = 0; i < 900 && p.mode !== 'land'; i++) p.update(1 / 60, { x: 0, y: 1 }, false, false);
    expect(p.mode).toBe('land');
  });

  it('climbs the ladder aboard, rides the deck, and climbs down again at the stern', () => {
    const p = new Player(world);
    p.placeWorld(20 - 3.4, 0, east);
    expect(p.nearLadder()).toBe(true);
    expect(p.climbAboard()).toBe(true);
    for (let i = 0; i < 120; i++) p.update(1 / 60, { x: 0, y: 0 }, false, false);
    expect(p.mode).toBe('deck');
    expect(p.feet.y).toBeCloseTo(0.8, 1);
    // Walk forward along the deck: the lifelines stop you at the bow.
    for (let i = 0; i < 300; i++) p.update(1 / 60, { x: 0, y: 1 }, false, false);
    expect(p.mode).toBe('deck');
    expect(p.pos.x).toBeLessThan(2.7);
    // Turn round and walk to the stern: down the ladder into the water.
    p.yaw = Math.PI / 2;
    for (let i = 0; i < 400 && p.mode !== 'swim'; i++) p.update(1 / 60, { x: 0, y: 1 }, false, false);
    expect(p.mode).toBe('swim');
  });

  it('stays aboard while the boat moves (you ride with it)', () => {
    const obj = new THREE.Object3D();
    obj.position.set(20, 0, 0);
    obj.updateMatrixWorld(true);
    const w2 = { ...world, boat: { ...world.boat, obj } };
    const p = new Player(w2);
    p.placeAboard(new THREE.Vector3(0, 0, 0), east);
    obj.position.set(25, 0.3, 4);
    obj.updateMatrixWorld(true);
    p.update(1 / 60, { x: 0, y: 0 }, false, false);
    expect(p.feet.x).toBeCloseTo(25, 1);
    expect(p.feet.z).toBeCloseTo(4, 1);
  });
});

describe('you, aboard the real sloop', async () => {
  const { createSloop } = await import('../src/render/sloop');
  const sloop = createSloop();
  sloop.group.position.set(0, 0, 0);
  sloop.group.updateMatrixWorld(true);
  const world: PlayerWorld = {
    groundAt: () => -3,
    waterAt: () => 0,
    trunks: [],
    boat: { obj: sloop.group, deck: sloop.deck, ladderTop: sloop.points.ladderTop, ladderBottom: sloop.points.ladderBottom, length: sloop.length },
    bounds: { cx: 0, cz: 0, r: 100 },
  };

  it('from the cockpit you can walk aft, through the gap, and down the ladder', () => {
    const p = new Player(world);
    p.placeAboard(sloop.points.spawn, 0);
    // Face the ladder from where you stand.
    const lt = sloop.points.ladderTop;
    p.yaw = Math.atan2(-(lt.x - p.pos.x), -(lt.z - p.pos.z));
    let mode = p.mode;
    for (let i = 0; i < 60 * 8 && mode !== 'swim'; i++) {
      // Steer for a spot just past the ladder top, off the back of the boat.
      if (p.mode === 'deck') p.yaw = Math.atan2(-(lt.x - 0.6 - p.pos.x), -(lt.z - p.pos.z));
      p.update(1 / 60, { x: 0, y: 1 }, false, false);
      mode = p.mode;
    }
    expect(mode).toBe('swim');
  });

  it('you can climb back aboard from the water by the ladder', () => {
    const p = new Player(world);
    const lb = sloop.points.ladderBottom.clone();
    sloop.group.localToWorld(lb);
    p.placeWorld(lb.x - 0.4, lb.z, Math.PI / 2);
    expect(p.mode).toBe('swim');
    expect(p.nearLadder()).toBe(true);
    expect(p.climbAboard()).toBe(true);
    for (let i = 0; i < 120; i++) p.update(1 / 60, { x: 0, y: 0 }, false, false);
    expect(p.mode).toBe('deck');
  });

  it('you can walk forward along a side deck to the bow (and the lifelines keep you aboard)', () => {
    const p = new Player(world);
    p.placeAboard(sloop.points.spawn, -Math.PI / 2); // facing the bow (+x)
    let maxX = p.pos.x;
    for (let i = 0; i < 60 * 12; i++) {
      // Aim for the starboard side deck, then the bow.
      const target = p.pos.x < 1 ? { x: p.pos.x + 1, z: 1.2 } : { x: 4, z: 0 };
      p.yaw = Math.atan2(-(target.x - p.pos.x), -(target.z - p.pos.z));
      p.update(1 / 60, { x: 0, y: 1 }, false, false);
      maxX = Math.max(maxX, p.pos.x);
    }
    expect(p.mode).toBe('deck');
    expect(maxX).toBeGreaterThan(2.5);
  });
});

describe('the ladder from the deck', async () => {
  const { createSloop } = await import('../src/render/sloop');
  const sloop = createSloop();
  sloop.group.updateMatrixWorld(true);
  it('standing at the top of the ladder, you can choose to climb down', () => {
    const world: PlayerWorld = { groundAt: () => -3, waterAt: () => 0, trunks: [], boat: { obj: sloop.group, deck: sloop.deck, ladderTop: sloop.points.ladderTop, ladderBottom: sloop.points.ladderBottom, length: sloop.length }, bounds: { cx: 0, cz: 0, r: 100 } };
    const p = new Player(world);
    p.placeAboard(sloop.points.ladderTop.clone(), Math.PI / 2);
    expect(p.atLadderTop()).toBe(true);
    expect(p.climbDown()).toBe(true);
    for (let i = 0; i < 120; i++) p.update(1 / 60, { x: 0, y: 0 }, false, false);
    expect(p.mode).toBe('swim');
  });
});
