/**
 * Gestures and the camera, checked with synthetic pointer sequences (no browser needed).
 * The big promise: camera gestures (two fingers, wheel, right-drag) never shape the land,
 * and a tap never leaves a mark.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GestureTracker, STROKE_DELAY, TWIST_UNLOCK, type GestureSink, type PointerKind } from '../src/input/controls';
import { CAM_MAX_DIST, CAM_MIN_DIST, OrbitCamera, autoPitch, farFor, nearFor } from '../src/input/camera';

type Ev = { kind: string; args: number[] | string[] };

function recorder(): { sink: GestureSink; log: Ev[]; strokes: () => string[]; count: (k: string) => number } {
  const log: Ev[] = [];
  const sink: GestureSink = {
    stroke: (phase, x, y) => log.push({ kind: 'stroke', args: [phase, String(x), String(y)] }),
    tap: (x, y) => log.push({ kind: 'tap', args: [x, y] }),
    pan: (fx, fy, tx, ty) => log.push({ kind: 'pan', args: [fx, fy, tx, ty] }),
    zoom: (f, x, y) => log.push({ kind: 'zoom', args: [f, x, y] }),
    rotate: (r) => log.push({ kind: 'rotate', args: [r] }),
    tilt: (r) => log.push({ kind: 'tilt', args: [r] }),
    glideTo: (x, y) => log.push({ kind: 'glide', args: [x, y] }),
  };
  return {
    sink,
    log,
    strokes: () => log.filter((e) => e.kind === 'stroke').map((e) => e.args[0] as string),
    count: (k) => log.filter((e) => e.kind === k).length,
  };
}

const p = (id: number, x: number, y: number, t: number, kind: PointerKind = 'touch', button = 0) => ({ id, kind, x, y, button, t });

describe('touch: one finger', () => {
  it('a quick tap is a tap, never a stroke', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 100, 0));
    g.move(p(1, 102, 101, 30));
    g.up(p(1, 102, 101, 60));
    expect(r.strokes()).toEqual([]);
    expect(r.count('tap')).toBe(1);
    expect(r.log.find((e) => e.kind === 'tap')!.args).toEqual([100, 100]);
  });

  it('holding still starts a stroke after the delay, where the finger went down', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 100, 0));
    g.tick(STROKE_DELAY - 10);
    expect(r.strokes()).toEqual([]);
    g.tick(STROKE_DELAY + 1);
    expect(r.strokes()).toEqual(['start']);
    expect(r.log[0].args.slice(1)).toEqual(['100', '100']);
    g.up(p(1, 100, 100, 400));
    expect(r.strokes()).toEqual(['start', 'end']);
    expect(r.count('tap')).toBe(0);
  });

  it('on a busy page a late hold timer cannot turn a quick tap into a stroke', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 100, 0));
    g.tick(300); // the timer ran late...
    g.up(p(1, 100, 100, 40)); // ...but the finger had lifted after 40 ms
    expect(r.strokes()).toEqual(['start', 'cancel']);
    expect(r.count('tap')).toBe(1);
  });

  it('moving a little starts the stroke at once and follows the finger', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 100, 0));
    g.move(p(1, 112, 100, 20));
    expect(r.strokes()).toEqual(['start', 'move']);
    g.move(p(1, 140, 110, 40));
    g.up(p(1, 140, 110, 80));
    expect(r.strokes()).toEqual(['start', 'move', 'move', 'end']);
  });

  it('a second finger landing before the stroke began means a camera gesture: no stroke at all', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 300, 0));
    g.down(p(2, 200, 300, 40));
    g.tick(500);
    g.move(p(1, 130, 300, 80));
    g.move(p(2, 230, 300, 80));
    g.up(p(1, 130, 300, 600));
    g.up(p(2, 230, 300, 610));
    expect(r.strokes()).toEqual([]);
    expect(r.count('pan')).toBeGreaterThan(0);
  });

  it('a second finger landing during a stroke cancels it (the engine undoes it)', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 300, 0));
    g.move(p(1, 130, 300, 30));
    expect(r.strokes()).toEqual(['start', 'move']);
    g.down(p(2, 250, 300, 200));
    g.move(p(1, 160, 300, 230));
    g.move(p(2, 280, 300, 230));
    g.up(p(1, 160, 300, 300));
    g.up(p(2, 280, 300, 310));
    expect(r.strokes()).toEqual(['start', 'move', 'cancel']);
  });
});

describe('touch: two fingers', () => {
  it('dragging pans with the fingers and never shapes', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 400, 0));
    g.down(p(2, 200, 400, 10));
    for (let i = 1; i <= 10; i++) {
      g.move(p(1, 100 + i * 10, 400 - i * 5, 10 + i * 16));
      g.move(p(2, 200 + i * 10, 400 - i * 5, 10 + i * 16));
    }
    g.up(p(1, 200, 350, 400));
    g.up(p(2, 300, 350, 410));
    expect(r.strokes()).toEqual([]);
    // The pans add up to the centroid's path: 100 px right, 50 px up.
    let dx = 0;
    let dy = 0;
    for (const e of r.log.filter((x) => x.kind === 'pan')) {
      const [fx, fy, tx, ty] = e.args as number[];
      dx += tx - fx;
      dy += ty - fy;
    }
    expect(dx).toBeCloseTo(100, 5);
    expect(dy).toBeCloseTo(-50, 5);
    expect(r.count('rotate')).toBe(0);
    expect(r.count('glide')).toBe(0);
  });

  it('spreading the fingers zooms in toward them', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 150, 450, 0));
    g.down(p(2, 250, 450, 5));
    for (let i = 1; i <= 10; i++) {
      g.move(p(1, 150 - i * 6, 450, 5 + i * 16));
      g.move(p(2, 250 + i * 6, 450, 5 + i * 16));
    }
    g.up(p(1, 90, 450, 400));
    g.up(p(2, 310, 450, 400));
    const total = r.log.filter((e) => e.kind === 'zoom').reduce((acc, e) => acc * (e.args[0] as number), 1);
    expect(total).toBeCloseTo(100 / 220, 5);
    const last = r.log.filter((e) => e.kind === 'zoom').pop()!;
    expect(last.args[1]).toBeCloseTo(200, 5); // toward the middle of the fingers
    expect(r.strokes()).toEqual([]);
  });

  it('a small twist does nothing; a real twist turns the view by the same angle', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    const at = (a: number, t: number) => {
      g.move(p(1, 200 - 60 * Math.cos(a), 400 - 60 * Math.sin(a), t));
      g.move(p(2, 200 + 60 * Math.cos(a), 400 + 60 * Math.sin(a), t));
    };
    g.down(p(1, 140, 400, 0));
    g.down(p(2, 260, 400, 5));
    at(TWIST_UNLOCK * 0.6, 20);
    expect(r.count('rotate')).toBe(0);
    for (let i = 1; i <= 10; i++) at(TWIST_UNLOCK * 0.6 + i * 0.05, 20 + i * 16);
    const turned = r.log.filter((e) => e.kind === 'rotate').reduce((acc, e) => acc + (e.args[0] as number), 0);
    expect(r.count('rotate')).toBeGreaterThan(0);
    // Clockwise on screen (y points down) is positive: the world follows the fingers.
    expect(turned).toBeGreaterThan(0.3);
    expect(turned).toBeLessThan(0.5 + 1e-9);
    expect(r.strokes()).toEqual([]);
  });

  it('a quick two-finger tap glides to the middle of the fingers', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 200, 0));
    g.down(p(2, 140, 220, 20));
    g.up(p(1, 100, 200, 150));
    g.up(p(2, 140, 220, 160));
    expect(r.count('glide')).toBe(1);
    expect(r.log.find((e) => e.kind === 'glide')!.args).toEqual([120, 210]);
    expect(r.strokes()).toEqual([]);
  });

  it('a slow two-finger hold is not a glide tap', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 200, 0));
    g.down(p(2, 140, 220, 20));
    g.up(p(1, 100, 200, 900));
    g.up(p(2, 140, 220, 910));
    expect(r.count('glide')).toBe(0);
  });

  it('after a two-finger gesture, the last finger keeps panning and never starts a stroke', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 100, 200, 0));
    g.down(p(2, 200, 200, 10));
    g.up(p(2, 200, 200, 300));
    g.tick(1000);
    g.move(p(1, 150, 200, 1010));
    g.up(p(1, 150, 200, 1100));
    expect(r.strokes()).toEqual([]);
    const lastPan = r.log.filter((e) => e.kind === 'pan').pop()!;
    expect(lastPan.args).toEqual([100, 200, 150, 200]);
  });

  it('a touch that only woke the screen does nothing at all', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.swallow(p(1, 100, 100, 0));
    g.tick(500);
    g.move(p(1, 160, 100, 520));
    g.up(p(1, 160, 100, 600));
    expect(r.log).toEqual([]);
    // ...and the next touch works normally.
    g.down(p(2, 100, 100, 1000));
    g.tick(1200);
    expect(r.strokes()).toEqual(['start']);
  });
});

describe('mouse and trackpad', () => {
  it('click-drag uses the tool straight away', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 300, 300, 0, 'mouse', 0));
    g.move(p(1, 320, 300, 16, 'mouse', 0));
    g.up(p(1, 320, 300, 40, 'mouse', 0));
    expect(r.strokes()).toEqual(['start', 'move', 'end']);
  });

  it('right-drag turns and tilts without shaping; a right-click glides there', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.down(p(1, 300, 300, 0, 'mouse', 2));
    g.move(p(1, 340, 320, 20, 'mouse', 2));
    g.move(p(1, 380, 340, 40, 'mouse', 2));
    g.up(p(1, 380, 340, 60, 'mouse', 2));
    expect(r.count('rotate')).toBeGreaterThan(0);
    expect(r.count('tilt')).toBeGreaterThan(0);
    expect(r.count('glide')).toBe(0);
    expect(r.strokes()).toEqual([]);

    const r2 = recorder();
    const g2 = new GestureTracker(r2.sink);
    g2.down(p(1, 300, 300, 0, 'mouse', 2));
    g2.move(p(1, 301, 301, 20, 'mouse', 2));
    g2.up(p(1, 301, 301, 60, 'mouse', 2));
    expect(r2.log.find((e) => e.kind === 'glide')!.args).toEqual([301, 301]);
  });

  it('pinch (ctrl + wheel) zooms toward the pointer', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.wheel({ dx: 0, dy: -8, mode: 0, ctrl: true, x: 500, y: 300, t: 0 });
    const z = r.log[0];
    expect(z.kind).toBe('zoom');
    expect(z.args[0] as number).toBeLessThan(1);
    expect(z.args.slice(1)).toEqual([500, 300]);
  });

  it('a mouse wheel notch zooms; a two-finger trackpad swipe pans', () => {
    const r = recorder();
    const g = new GestureTracker(r.sink);
    g.wheel({ dx: 0, dy: 100, mode: 0, ctrl: false, x: 400, y: 300, t: 0 });
    expect(r.log[0].kind).toBe('zoom');
    expect(r.log[0].args[0] as number).toBeGreaterThan(1);
    g.wheel({ dx: 0, dy: 3, mode: 1, ctrl: false, x: 400, y: 300, t: 2000 });
    expect(r.log[1].kind).toBe('zoom');

    const r2 = recorder();
    const g2 = new GestureTracker(r2.sink);
    g2.wheel({ dx: 4.5, dy: -12.25, mode: 0, ctrl: false, x: 400, y: 300, t: 0 });
    expect(r2.log[0]).toEqual({ kind: 'pan', args: [400, 300, 395.5, 312.25] });
    // A big whole-number delta in the middle of a swipe stays a pan.
    g2.wheel({ dx: 0, dy: 60, mode: 0, ctrl: false, x: 400, y: 300, t: 100 });
    expect(r2.log[1].kind).toBe('pan');
  });
});

// ---------- the camera ----------

function makeCam(ground: (x: number, z: number) => number = () => -30) {
  const c = new THREE.PerspectiveCamera(50, 1.6, 1, 16000);
  return new OrbitCamera(c, ground);
}

describe('camera', () => {
  it('tilt follows zoom: steeper far away, lower close in', () => {
    expect(autoPitch(CAM_MIN_DIST)).toBeLessThan(autoPitch(100));
    expect(autoPitch(100)).toBeLessThan(autoPitch(800));
    expect(autoPitch(CAM_MAX_DIST)).toBeGreaterThan(1.0);
    expect(autoPitch(CAM_MIN_DIST)).toBeLessThan(0.4);
  });

  it('near and far planes scale with distance', () => {
    expect(nearFor(8)).toBeLessThan(nearFor(1600));
    expect(nearFor(1600)).toBeLessThanOrEqual(12);
    expect(farFor(8)).toBeGreaterThanOrEqual(16000);
    expect(farFor(1600)).toBeGreaterThan(farFor(8));
  });

  it('saves and restores its pose exactly', () => {
    const cam = makeCam();
    cam.state = [120, 0, -80, 333, 1.1, 0.6];
    const s = cam.state;
    expect(s[0]).toBeCloseTo(120);
    expect(s[2]).toBeCloseTo(-80);
    expect(s[3]).toBeCloseTo(333);
    expect(s[4]).toBeCloseTo(1.1);
    expect(s[5]).toBeCloseTo(0.6);
    expect(cam.pitch).toBeCloseTo(0.6);
    // Broken values are ignored.
    cam.state = [NaN, 0, 0, 1, 1, 1];
    expect(cam.state[0]).toBeCloseTo(120);
  });

  it('zoom stays in range and pulls toward the point', () => {
    const cam = makeCam();
    cam.state = [0, 0, 0, 400, 0, 1];
    cam.zoomAt(0.5, { x: 100, z: 0 });
    for (let i = 0; i < 120; i++) cam.update(1 / 30);
    expect(cam.dist).toBeCloseTo(200, 0);
    expect(cam.target.x).toBeCloseTo(50, 0);
    cam.zoomAt(0.0001);
    expect(cam.state[3]).toBe(CAM_MIN_DIST);
    cam.zoomAt(1e6);
    expect(cam.state[3]).toBe(CAM_MAX_DIST);
  });

  it('a positive turn rotates the world clockwise on screen', () => {
    const cam = makeCam(() => 0);
    cam.state = [0, 0, 0, 300, 0, 1.2];
    const east = new THREE.Vector3(100, 0, 0);
    const before = east.clone().project(cam.camera);
    cam.rotate(0.3);
    for (let i = 0; i < 120; i++) cam.update(1 / 30);
    const after = east.clone().project(cam.camera);
    // A point east of the target (right of centre) moves down the screen when the world turns clockwise.
    expect(before.x).toBeGreaterThan(0.1);
    expect(after.y).toBeLessThan(before.y - 0.02);
  });

  it('panning in world units keeps within gentle bounds', () => {
    const cam = makeCam();
    cam.state = [0, 0, 0, 300, 0, 1];
    cam.panWorld(5000, 0);
    expect(cam.state[0]).toBeLessThanOrEqual(512 + 320);
    for (let i = 0; i < 300; i++) cam.update(1 / 30);
    // ...and eases back toward the zone edge.
    expect(cam.state[0]).toBeLessThan(512 + 70);
  });

  it('the sight line lifts the camera over a hill between it and the target', () => {
    // A wall 60 m high runs east-west at z = 40 (between the target at z = 0 and a camera to the south).
    const wall = (_x: number, z: number) => (Math.abs(z - 40) < 8 ? 60 : 0);
    const cam = makeCam(wall);
    cam.state = [0, 0, 0, 120, 0, 0.25];
    const t = cam.target;
    const pos = cam.camera.position;
    expect(pos.z).toBeGreaterThan(40);
    // At z = 40 the line of sight must clear the wall.
    const s = (40 - t.z) / (pos.z - t.z);
    const sightY = t.y + (pos.y - t.y) * s;
    expect(sightY).toBeGreaterThan(60);
  });

  it('close-ups over flat ground stay low: the drawn tilt is the asked-for tilt', () => {
    // Flat land at 20 m (a beach or a cooled lava plain) and flat sea: nothing is in the way,
    // so the sight-line lift must leave the low, cinematic close-up alone.
    for (const ground of [() => 20, () => -30]) {
      const cam = makeCam(ground);
      for (const dist of [8, 12, 15, 20, 30, 60]) {
        for (const yaw of [0, 1.3, -2.4]) {
          cam.state = [-300, 0, 255, dist, yaw, autoPitch(dist)];
          for (let i = 0; i < 30; i++) cam.update(1 / 30);
          const t = cam.target;
          const pos = cam.camera.position;
          const drawn = Math.atan2(pos.y - t.y, Math.hypot(pos.x - t.x, pos.z - t.z));
          expect(Math.abs(drawn - autoPitch(dist))).toBeLessThan((1 * Math.PI) / 180);
        }
      }
    }
  });

  it('a slope rising toward the camera lifts it just enough to see over the slope', () => {
    // Ground rising 0.5 m per metre toward the south (+z), where a yaw-0 camera sits.
    const cam = makeCam((_x, z) => Math.max(0, z * 0.5));
    cam.state = [0, 0, 0, 20, 0, autoPitch(20)];
    for (let i = 0; i < 30; i++) cam.update(1 / 30);
    const pos = cam.camera.position;
    // Every point of ground between the camera and the target is under the line of sight.
    for (let s = 0.2; s < 1; s += 0.05) {
      const z = pos.z * s;
      expect(cam.target.y + (pos.y - cam.target.y) * s).toBeGreaterThan(z * 0.5);
    }
    // ...but not by much: the view still looks along the slope, not straight down.
    expect(Math.atan2(pos.y - cam.target.y, pos.z)).toBeLessThan(Math.atan(0.5) + 0.25);
  });

  it('never sits below the sea', () => {
    const cam = makeCam(() => -30);
    cam.state = [0, 0, 0, 8, 0, 0.06];
    expect(cam.camera.position.y).toBeGreaterThan(0.5);
  });

  it('glides end where they were asked to, slowly', () => {
    const cam = makeCam();
    cam.state = [0, 0, 0, 300, 0, 1];
    cam.glideTo(300, -200, 150);
    cam.update(0.5);
    expect(cam.gliding).toBe(true);
    expect(Math.hypot(cam.target.x, cam.target.z)).toBeLessThan(150);
    for (let i = 0; i < 300 && cam.gliding; i++) cam.update(1 / 30);
    expect(cam.gliding).toBe(false);
    expect(cam.target.x).toBeCloseTo(300, 3);
    expect(cam.target.z).toBeCloseTo(-200, 3);
    expect(cam.dist).toBeCloseTo(150, 3);
    // Any player move cancels a glide.
    cam.glideTo(0, 0, 400);
    cam.panWorld(1, 0);
    expect(cam.gliding).toBe(false);
  });

  it('watch-mode drift moves toward the focus calmly and circles it', () => {
    const cam = makeCam();
    cam.state = [0, 0, 0, 300, 0, 1];
    const yaw0 = cam.state[4];
    let maxStep = 0;
    let prev = cam.state[0];
    for (let i = 0; i < 30 * 120; i++) {
      cam.drift(1 / 30, { x: 200, z: 0, dist: 80 });
      cam.update(1 / 30);
      maxStep = Math.max(maxStep, cam.state[0] - prev);
      prev = cam.state[0];
    }
    expect(maxStep * 30).toBeLessThanOrEqual(7.01); // never faster than 7 m/s
    expect(cam.target.x).toBeGreaterThan(190);
    expect(cam.dist).toBeLessThan(100);
    expect(cam.state[4]).toBeGreaterThan(yaw0 + 3);
  });
});
