// Checks for the weather effects (src/render/weatherFx.ts): squalls, rain around you and bow spray.
// They fit the phone budget (draw calls, triangles), a squall at strength 0 draws nothing, and
// nothing lands beyond 1700 m from the camera (squalls fade out before that).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { WeatherFx, SQUALL_FX, RAIN_FX, SPRAY_FX, type SquallInfo, type WeatherLight } from '../src/render/weatherFx';

const light: WeatherLight = {
  daylight: 1,
  night: 0,
  sunDir: new THREE.Vector3(0, 0.95, -0.32).normalize(),
  sunColor: new THREE.Color(1, 0.9, 0.75),
  horizon: new THREE.Color(0.55, 0.76, 0.85),
  zenith: new THREE.Color(0.03, 0.18, 0.6),
};

function camera(x: number, y: number, z: number, tx: number, ty: number, tz: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(72, 16 / 9, 0.05, 2500);
  c.position.set(x, y, z);
  c.lookAt(tx, ty, tz);
  c.updateMatrixWorld();
  return c;
}

/** Draw calls and triangles as the renderer would count them: each visible mesh with something in its draw range. */
function drawn(group: THREE.Group): { calls: number; triangles: number } {
  let calls = 0;
  let triangles = 0;
  group.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const n = Math.min(g.drawRange.count, g.index ? g.index.count : g.getAttribute('position').count);
    if (n <= 0) return;
    calls++;
    triangles += n / 3;
  });
  return { calls, triangles };
}

/** The distance fade the squall shader is given for each squall slot this frame. */
function fades(fx: WeatherFx): number[] {
  const mesh = fx.group.getObjectByName('squalls') as THREE.Mesh;
  const u = (mesh.material as THREE.ShaderMaterial).uniforms;
  return (u.uSq2.value as THREE.Vector4[]).map((v, i) => ((u.uSq.value as THREE.Vector4[])[i].w > 0 ? v.z : 0));
}

const FOUR: SquallInfo[] = [
  { id: 1, x: 600, z: -150, radius: 260, strength: 1 },
  { id: 2, x: 1400, z: 300, radius: 260, strength: 1 },
  { id: 3, x: -900, z: 400, radius: 200, strength: 0.6 },
  // The camera is inside this one.
  { id: 4, x: 0, z: 0, radius: 240, strength: 1 },
];

describe('weather effects budget', () => {
  for (const phone of [false, true]) {
    it(`4 squalls + heavy rain + spray fit in 6 draw calls and 30,000 triangles (${phone ? 'phone' : 'laptop'})`, () => {
      const fx = new WeatherFx({ phone });
      const cam = camera(0, 2.5, 0, 100, 5, 0);
      fx.setLocalRain(1);
      fx.update(FOUR, cam, 100, 1 / 60, light, -10, 0);
      fx.spray(3, 1.5, 0, 1, 0, 1, 100, 5);
      fx.spray(3, 1.5, 0, 1, 0, 0.8, 100.3, 5);
      fx.update(FOUR, cam, 100.4, 1 / 60, light, -10, 0);
      const d = drawn(fx.group);
      console.log(`weather (${phone ? 'phone' : 'laptop'}): ${d.calls} draw calls, ${d.triangles} triangles`);
      expect(d.calls).toBe(3);
      expect(d.calls).toBeLessThanOrEqual(6);
      expect(d.triangles).toBeLessThanOrEqual(30000);
      expect(fx.stats()).toMatchObject({ drawCalls: d.calls, triangles: d.triangles, squalls: 4 });
      expect(fx.stats().streaks).toBe(phone ? RAIN_FX.phoneStreaks : RAIN_FX.streaks);
    });
  }

  it('has no image files: its only texture is noise painted in code', () => {
    const fx = new WeatherFx({ phone: false });
    fx.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
      if (!m?.uniforms) return;
      for (const u of Object.values(m.uniforms)) {
        if (u.value instanceof THREE.Texture) expect(u.value).toBeInstanceOf(THREE.DataTexture);
      }
    });
  });
});

describe('squalls', () => {
  const cam = camera(0, 2.5, 0, 100, 5, 0);

  it('draws nothing for a squall at strength 0 (not formed yet, or gone)', () => {
    const fx = new WeatherFx({ phone: false });
    fx.update([{ id: 7, x: 600, z: 0, radius: 200, strength: 0 }], cam, 10, 1 / 60, light, -8, 0);
    expect(drawn(fx.group).calls).toBe(0);
    expect(fx.stats().squalls).toBe(0);

    fx.update([{ id: 7, x: 600, z: 0, radius: 200, strength: 0.8 }], cam, 11, 1 / 60, light, -8, 0);
    const one = drawn(fx.group);
    expect(one.calls).toBe(1);
    expect(fx.stats().squalls).toBe(1);

    // A second squall at strength 0 adds nothing.
    fx.update(
      [
        { id: 7, x: 600, z: 0, radius: 200, strength: 0.8 },
        { id: 8, x: 900, z: 200, radius: 220, strength: 0 },
      ],
      cam,
      12,
      1 / 60,
      light,
      -8,
      0,
    );
    expect(drawn(fx.group)).toEqual(one);
    expect(fx.stats().squalls).toBe(1);

    // When it fades back to 0, it is gone again.
    fx.update([{ id: 7, x: 594, z: 0, radius: 200, strength: 0 }], cam, 13, 1 / 60, light, -8, 0);
    expect(drawn(fx.group).calls).toBe(0);
  });

  it('keeps everything within 1700 m of the camera, and fades squalls out smoothly before that', () => {
    const fx = new WeatherFx({ phone: false });
    const look = camera(0, 2.5, 0, 1, 0.05, 0);
    let last = 1;
    for (let d = 0; d <= 2600; d += 50) {
      fx.update([{ id: 1, x: d, z: 40, radius: 260, strength: 1 }], look, d, 1 / 60, light, -8, 0);
      const far = fx.farthestDrawn();
      expect(far, `squall ${d} m away`).toBeLessThanOrEqual(1700);
      const fade = fades(fx)[0];
      // The fade only ever goes down with distance, and in small steps (no popping).
      expect(fade).toBeLessThanOrEqual(last + 1e-9);
      expect(last - fade).toBeLessThan(0.25);
      last = fade;
      if (Math.hypot(d, 40) >= SQUALL_FX.fadeTo) expect(fx.stats().squalls, `squall ${d} m away`).toBe(0);
      if (Math.hypot(d, 40) <= SQUALL_FX.fadeFrom) expect(fade).toBe(1);
    }
    // The squall drawing limit is inside the sky dome (1800 m) with room to spare.
    expect(SQUALL_FX.maxDistance).toBeLessThanOrEqual(1700);
    // Rain falls within its box around the camera.
    const [bx, by, bz] = RAIN_FX.far;
    expect(Math.hypot(bx, by * 1.4, bz) / 2).toBeLessThan(60);
  });

  it('keeps each squall in its own slot and shape while it lives', () => {
    const fx = new WeatherFx({ phone: false });
    const mesh = fx.group.getObjectByName('squalls') as THREE.Mesh;
    const puffs = () => Array.from((mesh.geometry.getAttribute('aPuff') as THREE.BufferAttribute).array as Float32Array).join(',');
    fx.update([{ id: 1, x: 600, z: 0, radius: 200, strength: 0.5 }], cam, 1, 1 / 60, light, -8, 0);
    const before = puffs();
    fx.update(
      [
        { id: 1, x: 594, z: 0, radius: 200, strength: 0.6 },
        { id: 2, x: 1200, z: 0, radius: 180, strength: 0.1 },
      ],
      cam,
      2,
      1 / 60,
      light,
      -8,
      0,
    );
    // Squall 1's cloud kept its shape; squall 2 got its own.
    const after = puffs();
    const per = SQUALL_FX.puffs * 4 * 4;
    expect(after.split(',').slice(0, per)).toEqual(before.split(',').slice(0, per));
    expect(after).not.toEqual(before);
  });
});

describe('rain and spray', () => {
  const cam = camera(0, 2.5, 0, 100, 0, 0);

  it('light rain is a few streaks, heavy rain is many, none is nothing', () => {
    const fx = new WeatherFx({ phone: false });
    fx.setLocalRain(0);
    fx.update([], cam, 1, 1 / 60, light, -8, 0);
    expect(drawn(fx.group).calls).toBe(0);
    fx.setLocalRain(0.2);
    const light2 = fx.stats().streaks;
    fx.setLocalRain(1);
    const heavy = fx.stats().streaks;
    expect(light2).toBeGreaterThan(0);
    expect(light2).toBeLessThan(heavy * 0.2);
    expect(heavy).toBeLessThanOrEqual(RAIN_FX.streaks);
  });

  it('spray bursts are short-lived, from a pool of a few hundred droplets, and far-off bursts are skipped', () => {
    const fx = new WeatherFx({ phone: false });
    fx.update([], cam, 50, 1 / 60, light, -8, 0);
    fx.spray(4, 1.5, 0, 1, 0, 1, 50, 5);
    fx.update([], cam, 50.1, 1 / 60, light, -8, 0);
    expect(drawn(fx.group).calls).toBe(1);
    const mesh = fx.group.getObjectByName('spray') as THREE.Mesh;
    expect(mesh.geometry.index!.count / 6).toBe(SPRAY_FX.pool);
    // Gone two seconds later.
    fx.update([], cam, 52.5, 1 / 60, light, -8, 0);
    expect(drawn(fx.group).calls).toBe(0);
    // A burst 2 km away is ignored.
    fx.spray(2000, 1.5, 0, 1, 0, 1, 53, 5);
    fx.update([], cam, 53.1, 1 / 60, light, -8, 0);
    expect(drawn(fx.group).calls).toBe(0);
    // Weak bursts throw fewer droplets than strong ones.
    const info = mesh.geometry.getAttribute('aInfo') as THREE.BufferAttribute;
    const alive = (t: number) => {
      let n = 0;
      for (let i = 0; i < info.count; i += 4) if (t - info.getX(i) >= -0.1 && t - info.getX(i) < info.getY(i)) n++;
      return n;
    };
    fx.spray(4, 1.5, 0, 1, 0, 0.2, 60, 5);
    const weak = alive(60.05);
    fx.spray(4, 1.5, 0, 1, 0, 1, 70, 5);
    const strong = alive(70.05);
    expect(weak).toBeGreaterThan(0);
    expect(strong).toBeGreaterThan(weak * 1.8);
  });
});
