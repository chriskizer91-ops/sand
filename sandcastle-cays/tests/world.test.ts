import { describe, expect, it } from 'vitest';
import { FINDS } from '../src/content/finds';
import { Beach } from '../src/game/beach';
import { SAILING, touchesBottom } from '../src/game/sailing';
import { reefChannel } from '../src/world/homeCay';
import { WorldTerrain } from '../src/world/world';

const world = new WorldTerrain();
const home = world.home;
const pink = world.pink;
const sea = { floorAt: (x: number, z: number) => world.heightAt(x, z) };

describe('Pink Sand Cay', () => {
  it('is a real island out beyond the reef, with pink beaches and an anchorage', () => {
    expect(pink.heightAt(-210, -300)).toBeGreaterThan(1);
    const a = pink.anchorage;
    const depth = -world.heightAt(a.x, a.z);
    expect(depth).toBeGreaterThan(SAILING.draft + 0.8);
    expect(depth).toBeLessThan(SAILING.anchorDepth);
    const line = pink.tideline(0.7);
    expect(line.length).toBeGreaterThan(60);
    expect(line.every((p) => p.island === 'pink')).toBe(true);
    expect(line.filter((p) => pink.groundAt(p.x, p.z) === 'pinksand').length).toBeGreaterThan(line.length * 0.8);
  });

  it('joins the open sea floor without a step', () => {
    // Along the edge of its area the ground matches Home Cay's deep floor.
    const b = pink.bounds;
    for (let i = 0; i <= 20; i++) {
      const x = b.x0 + ((b.x1 - b.x0) * i) / 20;
      expect(Math.abs(world.heightAt(x, b.z1 + 0.01) - world.heightAt(x, b.z1 - 0.01))).toBeLessThan(0.3);
    }
  });
});

describe('the passage between the cays', () => {
  const ch = reefChannel(home);
  const legs: [string, { x: number; z: number }, { x: number; z: number }][] = [
    ['Home Cay anchorage → inside the reef gap', home.anchorage, ch.inside],
    ['through the gap in the reef', ch.inside, ch.outside],
    ['outside the reef → Pink Sand Cay anchorage', ch.outside, pink.anchorage],
  ];
  for (const [name, a, b] of legs) {
    it(`${name}: deep enough for the keel all the way`, () => {
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const h = Math.atan2(b.z - a.z, b.x - a.x);
      for (let d = 6; d < len - 6; d += 2) {
        const x = a.x + Math.cos(h) * d;
        const z = a.z + Math.sin(h) * d;
        expect(touchesBottom(sea, x, z, h), `aground ${d.toFixed(0)} m along at (${x.toFixed(0)}, ${z.toFixed(0)})`).toBe(false);
      }
    });
  }

  it('the reef really blocks the way elsewhere (straight south from the anchorage)', () => {
    let hit = false;
    for (let z = home.anchorage.z; z > home.anchorage.z - 140; z -= 1) if (touchesBottom(sea, home.anchorage.x, z, -Math.PI / 2)) hit = true;
    expect(hit).toBe(true);
  });
});

describe('finds on each island', () => {
  it('pink-only shells wash up on Pink Sand Cay and never on Home Cay', () => {
    const beach = new Beach([...home.tideline(0.6), ...pink.tideline(0.6)]);
    for (let d = 1; d <= 30; d++) beach.washUp(d);
    // Tell which island each find lies on by distance to each island's middle.
    for (const g of beach.state.ground) {
      const onPink = Math.hypot(g.x + 210, g.z + 300) < 120;
      const only = FINDS[g.kind].islands;
      if (only) expect(only.includes(onPink ? 'pink' : 'home'), `${g.kind} on ${onPink ? 'pink' : 'home'}`).toBe(true);
    }
    expect(beach.state.ground.some((g) => Math.hypot(g.x + 210, g.z + 300) < 120)).toBe(true);
  });
});
