/**
 * The sea and its effects (WP-E2): the CPU sea surface must match what the ocean shader draws,
 * the swell must die away over new land, and the effect pools and hands must behave.
 */
import { describe, expect, it } from 'vitest';
import { SEA_LEVEL } from '../src/config';
import { PARTICLE_LAYOUT, Particles } from '../src/render/effects';
import { createHandsState, makeHandsGeometry, makePileGeometry, poseFor, poseHands, PourTracker, readHands } from '../src/render/hands';
import { HotSpots, OCEAN_GRID, gridOffset, steamLevel } from '../src/render/ocean';
import { wrapTime, type FrameCtx } from '../src/render/shared';
import {
  CREST_VAR,
  Q_MAX,
  SEA_TIME_WRAP,
  SWASH_PERIOD,
  SWELL,
  seaHeight,
  swashLift,
  swellAmpScale,
  swellGLSL,
  swellSteepScale,
} from '../src/render/waves';

const NUM = '(-?\\d+(?:\\.\\d+)?(?:e-?\\d+)?)';

/** One swell train as the shader's vertex code spells it, read back out of the generated GLSL. */
interface GlslTrain {
  amp: number;
  crestVar: number;
  crestK: number;
  crestDir: [number, number];
  crestPhase: number;
  k: number;
  dir: [number, number];
  omega: number;
  phase: number;
  steep: number;
  qMax: number;
  n: number;
  kQ: number;
}

function parseGlsl(): { trains: GlslTrain[]; ampFn: number[]; steepFn: number[]; swash: number[]; swashPhase: number[]; swashOmega: number } {
  const glsl = swellGLSL();
  const vertex = glsl.slice(glsl.indexOf('vec3 ww_swell('), glsl.indexOf('vec3 ww_swellNormal('));
  const block = new RegExp(
    [
      `A = \\(1\\.0 - smoothstep\\(${NUM}, ${NUM}, spacing\\)\\) \\* amp \\* ${NUM} \\* \\(1\\.0 \\+ ${NUM} \\* sin\\(${NUM} \\* dot\\(vec2\\(${NUM}, ${NUM}\\), p\\) \\+ ${NUM}\\)\\);`,
      `\\s*ph = ${NUM} \\* dot\\(vec2\\(${NUM}, ${NUM}\\), p\\) - ${NUM} \\* t \\+ ${NUM};`,
      `\\s*Q = min\\(${NUM} \\* steepK, ${NUM} / \\(${NUM} \\* ${NUM} \\* A \\+ 1e-6\\)\\);`,
    ].join(''),
    'g',
  );
  const trains: GlslTrain[] = [];
  for (const m of vertex.matchAll(block)) {
    const v = m.slice(1).map(Number);
    trains.push({
      amp: v[2],
      crestVar: v[3],
      crestK: v[4],
      crestDir: [v[5], v[6]],
      crestPhase: v[7],
      k: v[8],
      dir: [v[9], v[10]],
      omega: v[11],
      phase: v[12],
      steep: v[13],
      qMax: v[14],
      n: v[15],
      kQ: v[16],
    });
  }
  const nums = (src: string) => [...src.matchAll(new RegExp(NUM, 'g'))].map((m) => Number(m[1]));
  const fn = (name: string) => {
    const start = glsl.indexOf(name);
    return nums(glsl.slice(start + name.length, glsl.indexOf('}', start)));
  };
  const omega = glsl.match(new RegExp(`const float WW_SWASH_OMEGA = ${NUM};`));
  return {
    trains,
    ampFn: fn('float ww_swellAmp(float storm, float depth) {'),
    steepFn: fn('float ww_swellSteep(float depth) {'),
    swash: fn('float ww_swash(vec2 p, float t, float storm, float depth) {'),
    swashPhase: fn('float ww_swashPhase(vec2 p) {'),
    swashOmega: Number(omega?.[1]),
  };
}

const ss = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** The shader's vertex displacement (at full grid detail), evaluated with the numbers read from the GLSL. */
function shaderSurface(px: number, pz: number, t: number, storm: number, depth: number): [number, number, number] {
  const { trains, ampFn, steepFn, swash, swashPhase, swashOmega } = parseGlsl();
  // ww_swellAmp: 1 + SHOAL_GAIN * (1 - ss(D0, D1)), damp ss(0, DAMP_D + DAMP_STORM * storm), (1 + STORM_GAIN * storm)
  const [, shoalGain, , shoalD0, shoalD1, , dampD, dampStorm, , stormGain] = ampFn;
  const amp = (1 + stormGain * storm) * (1 + shoalGain * (1 - ss(shoalD0, shoalD1, depth))) * ss(0, dampD + dampStorm * storm, depth);
  const [, steepGain, , steepD0, steepD1] = steepFn;
  const steepK = 1 + steepGain * (1 - ss(steepD0, steepD1, depth));
  const tw = wrapTime(t);
  let ox = 0;
  let oy = 0;
  let oz = 0;
  for (const w of trains) {
    const a = amp * w.amp * (1 + w.crestVar * Math.sin(w.crestK * (w.crestDir[0] * px + w.crestDir[1] * pz) + w.crestPhase));
    const ph = w.k * (w.dir[0] * px + w.dir[1] * pz) - w.omega * tw + w.phase;
    const q = Math.min(w.steep * steepK, w.qMax / (w.n * w.kQ * a + 1e-6));
    ox += q * a * w.dir[0] * Math.cos(ph);
    oz += q * a * w.dir[1] * Math.cos(ph);
    oy += a * Math.sin(ph);
  }
  // ww_swash: band 1 - ss(D0, D1), (AMP + STORM * storm) * (0.35 + 0.65 sin(omega t + phase(p)))
  const [, swD0, swD1, swAmp, swStorm, swMean, swVar] = swash;
  const [a1, k1x, k1z, a2, k2z, k2x] = swashPhase;
  const th = swashOmega * tw + a1 * Math.sin(px * k1x + pz * k1z) + a2 * Math.sin(pz * k2z - px * k2x);
  const lift = (1 - ss(swD0, swD1, depth)) * (swAmp + swStorm * storm) * (swMean + swVar * Math.sin(th));
  return [px + ox, SEA_LEVEL + oy + lift, pz + oz];
}

describe('sea surface: CPU matches the shader', () => {
  it('the shader carries exactly the swell constants of waves.ts', () => {
    const { trains, ampFn } = parseGlsl();
    expect(trains.length).toBe(SWELL.length);
    SWELL.forEach((w, i) => {
      const g = trains[i];
      expect(g.amp).toBeCloseTo(w.amp, 12);
      expect(g.k).toBeCloseTo(w.k, 12);
      expect(g.kQ).toBeCloseTo(w.k, 12);
      expect(g.omega).toBeCloseTo(w.omega, 12);
      expect(g.phase).toBeCloseTo(w.phase, 12);
      expect(g.dir[0]).toBeCloseTo(w.dx, 12);
      expect(g.dir[1]).toBeCloseTo(w.dz, 12);
      expect(g.crestDir[0]).toBeCloseTo(-w.dz, 12);
      expect(g.crestDir[1]).toBeCloseTo(w.dx, 12);
      expect(g.crestK).toBeCloseTo(w.crestK, 12);
      expect(g.crestPhase).toBeCloseTo(w.crestPhase, 12);
      expect(g.crestVar).toBe(CREST_VAR);
      expect(g.steep).toBe(w.steep);
      expect(g.qMax).toBe(Q_MAX);
      expect(g.n).toBe(SWELL.length);
    });
    expect(ampFn.length).toBeGreaterThanOrEqual(10);
  });

  it('seaHeight lands on the surface the shader draws (calm and storm, deep and shallow)', () => {
    let worst = 0;
    for (const storm of [0, 0.5, 1]) {
      for (const depth of [0, 0.4, 1.2, 3, 8, 30]) {
        for (let i = 0; i < 40; i++) {
          const px = -400 + i * 23.7;
          const pz = 300 - i * 17.3;
          const t = 12.5 + i * 91.3;
          const [x, y, z] = shaderSurface(px, pz, t, storm, depth);
          worst = Math.max(worst, Math.abs(seaHeight(x, z, t, storm, depth) - y));
        }
      }
    }
    expect(worst).toBeLessThan(0.002);
  });

  it('every wave period divides the hour the shader clock wraps at, so the sea never jumps', () => {
    expect(SEA_TIME_WRAP).toBe(3600);
    expect(wrapTime(3600.5)).toBeCloseTo(0.5, 9);
    for (const w of SWELL) expect(Math.abs(SEA_TIME_WRAP / w.period - Math.round(SEA_TIME_WRAP / w.period))).toBeLessThan(1e-9);
    expect(Math.abs(SEA_TIME_WRAP / SWASH_PERIOD - Math.round(SEA_TIME_WRAP / SWASH_PERIOD))).toBeLessThan(1e-9);
    // Just before and at the wrap the surface is continuous.
    for (const [x, z] of [[10, 20], [-300, 140], [250, -410]]) {
      const before = seaHeight(x, z, 3599.9999, 0.3, 12);
      const after = seaHeight(x, z, 3600, 0.3, 12);
      expect(Math.abs(before - after)).toBeLessThan(0.001);
    }
  });

  it('wavelengths are sized for a 1 km sea and the swell comes from the east', () => {
    for (const w of SWELL) {
      expect(w.length).toBeGreaterThan(15);
      expect(w.length).toBeLessThan(70);
      expect(w.dx).toBeLessThan(-0.5);
      expect(w.amp).toBeLessThanOrEqual(0.3);
    }
  });
});

describe('sea surface: depth and storms', () => {
  /** Largest swell height (above the swash) over a patch of sea and a minute of time. */
  function maxSwell(storm: number, depth: number): number {
    let m = 0;
    for (let i = 0; i < 300; i++) {
      const x = (i * 37.1) % 200;
      const z = (i * 53.7) % 200;
      const t = i * 0.37;
      m = Math.max(m, Math.abs(seaHeight(x, z, t, storm, depth) - SEA_LEVEL - swashLift(x, z, wrapTime(t), storm, depth)));
    }
    return m;
  }

  it('dies away over the shallows, so new land is never swamped', () => {
    expect(swellAmpScale(0, 0)).toBe(0);
    expect(swellAmpScale(1, 0)).toBe(0);
    expect(maxSwell(0, 0)).toBeLessThan(0.02);
    expect(maxSwell(1, 0.2)).toBeLessThan(0.05);
    expect(maxSwell(0, 0.3)).toBeLessThan(maxSwell(0, 20) * 0.1);
  });

  it('grows and steepens in a few metres of water (shoaling), then is open swell in deep water', () => {
    expect(swellAmpScale(0, 4)).toBeGreaterThan(swellAmpScale(0, 30));
    expect(swellSteepScale(2)).toBeGreaterThan(swellSteepScale(30));
    expect(swellAmpScale(0, 30)).toBeCloseTo(1, 6);
  });

  it('is three times higher at the peak of a storm', () => {
    expect(swellAmpScale(1, 30)).toBeCloseTo(3 * swellAmpScale(0, 30), 6);
    expect(maxSwell(1, 30)).toBeGreaterThan(maxSwell(0, 30) * 2.5);
  });

  it('never folds over itself (crest sharpening stays below one)', () => {
    for (const storm of [0, 1]) {
      for (const depth of [0.5, 1, 2, 3, 5, 10, 30]) {
        const amp = swellAmpScale(storm, depth);
        const steepK = swellSteepScale(depth);
        let sum = 0;
        for (const w of SWELL) {
          const a = w.amp * amp * (1 + CREST_VAR);
          sum += Math.min(w.steep * steepK, Q_MAX / (SWELL.length * w.k * a + 1e-6)) * w.k * a;
        }
        expect(sum).toBeLessThan(1);
      }
    }
  });

  it('is deterministic and laps at the waterline', () => {
    const a = seaHeight(123.4, -56.7, 789.1, 0.4, 2.5);
    expect(seaHeight(123.4, -56.7, 789.1, 0.4, 2.5)).toBe(a);
    // At the waterline only the swash moves, rising and falling over a swash period.
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < SWASH_PERIOD; t += 0.1) {
      const h = seaHeight(5, 5, t, 0, 0);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    expect(hi - lo).toBeGreaterThan(0.15);
    expect(hi - lo).toBeLessThan(0.3);
  });
});

describe('sea grid', () => {
  it('reaches the horizon, is even near the middle and grows outward, within the triangle budget', () => {
    const { M, M0, EXTENT, STEPS, RATIOS } = OCEAN_GRID;
    expect(2 * (2 * M) * (2 * M)).toBeLessThanOrEqual(40000);
    STEPS.forEach((step, i) => {
      const r = RATIOS[i];
      expect(gridOffset(M, step, r)).toBeCloseTo(EXTENT, -1);
      expect(gridOffset(-M, step, r)).toBeCloseTo(-EXTENT, -1);
      expect(gridOffset(M0, step, r)).toBeCloseTo(M0 * step, 9);
      let prev = 0;
      let prevGap = 0;
      for (let k = 1; k <= M; k++) {
        const o = gridOffset(k, step, r);
        const gap = o - prev;
        expect(gap).toBeGreaterThanOrEqual(prevGap - 1e-9);
        prev = o;
        prevGap = gap;
      }
    });
  });
});

describe('hot water', () => {
  it('merges nearby contacts, keeps four spots, replaces the weakest, and cools', () => {
    const h = new HotSpots();
    h.add(0, 0, 0.5, 10);
    h.add(5, 0, 0.8, 10);
    expect(h.data[3]).toBeCloseTo(0.8, 6);
    expect(h.data[7]).toBe(0);
    h.add(100, 0, 0.3, 10);
    h.add(200, 0, 0.4, 10);
    h.add(300, 0, 0.6, 10);
    h.add(400, 0, 0.9, 10);
    const strengths = [3, 7, 11, 15].map((i) => h.data[i]);
    expect(strengths).not.toContain(0.3);
    expect(Math.min(...strengths)).toBeCloseTo(0.4, 6);
    h.cool(3.5);
    expect(h.data[3]).toBeCloseTo(0.8 * Math.exp(-1), 5);
    expect(steamLevel(0)).toBe(0);
    expect(steamLevel(100)).toBeCloseTo(1, 6);
  });
});

describe('effect pools', () => {
  it('keeps alive particles packed, respects the cap, and reports landings', () => {
    const landed: number[] = [];
    const pool = new Particles(4, (p, o) => landed.push(p.s[o]));
    for (let i = 0; i < 6; i++) pool.spawn(i, 10, 0, 0, 0, 0, i < 2 ? 0.5 : 5);
    expect(pool.n).toBe(4);
    // Particles 2 and 3 fall onto a floor at y = 9.
    for (const i of [2, 3]) {
      pool.s[i * PARTICLE_LAYOUT.STRIDE + PARTICLE_LAYOUT.GRAV] = 9.81;
      pool.s[i * PARTICLE_LAYOUT.STRIDE + PARTICLE_LAYOUT.FLOOR] = 9;
    }
    pool.step(0.6, 0, 0);
    expect(pool.n).toBe(0);
    expect(landed.sort()).toEqual([2, 3]);
    pool.spawn(1, 2, 3, 0, 0, 0, 1);
    pool.upload();
    expect(pool.geometry.instanceCount).toBe(1);
  });
});

describe('hands', () => {
  it('are two mirrored low-poly hands of about 220 triangles each, posed without gaps or NaNs', () => {
    const g = makeHandsGeometry();
    const tris = g.getIndex()!.count / 3;
    expect(tris / 2).toBeGreaterThan(180);
    expect(tris / 2).toBeLessThan(260);
    const pos = g.getAttribute('position').array as Float32Array;
    const nrm = g.getAttribute('normal').array as Float32Array;
    for (const tool of ['lava', 'sand', 'rock', 'hands', 'scoop'] as const) {
      for (const stroking of [false, true]) {
        poseHands(poseFor(tool, stroking), pos, nrm);
        const half = pos.length / 2;
        for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i]) && Number.isFinite(nrm[i])).toBe(true);
        for (let i = 0; i < half; i += 3) {
          expect(pos[half + i]).toBeCloseTo(-pos[i], 6);
          expect(pos[half + i + 1]).toBeCloseTo(pos[i + 1], 6);
          expect(Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2])).toBeCloseTo(1, 4);
        }
      }
    }
    expect(makePileGeometry().getIndex()!.count / 3).toBeLessThanOrEqual(80);
  });

  it('hover clear of the brush, follow the live stroke, and hide for Look and watch mode', () => {
    const fields = { heightAt: () => -10 };
    const frame = (over: Partial<FrameCtx>): FrameCtx =>
      ({
        t: 1,
        dt: 1 / 60,
        cam: { target: null, dist: 100, yaw: 0, pitch: 0.75 },
        camera: { aspect: 1.6 },
        fields,
        tool: 'lava',
        stroking: false,
        watching: false,
        brush: { x: 10, y: -10, z: 20, nx: 0, ny: 1, nz: 0, r: 6 },
        ...over,
      }) as unknown as FrameCtx;
    const pour = new PourTracker();
    const hs = createHandsState();
    readHands(frame({}), pour, hs);
    expect(hs.shown).toBe(true);
    expect(hs.pouring).toBe(false);
    // Above the sea surface (the brush is on the sea floor), by more than the brush.
    expect(hs.ay).toBeGreaterThan(SEA_LEVEL + hs.r);
    expect(readHands(frame({ tool: 'look' }), pour, hs).shown).toBe(false);
    expect(readHands(frame({ watching: true }), pour, hs).shown).toBe(false);
    expect(readHands(frame({ brush: null }), pour, hs).shown).toBe(false);
    // A stroke reported by the engine (no pointer brush) still shows the hands pouring there.
    pour.onEngine({
      t: 'tick',
      year: 0,
      firstLand: true,
      paused: false,
      storm: { phase: 'none', t: 0, level: 0, great: false },
      events: { steam: [], pour: { tool: 'sand', x: -50, y: 2, z: 30, r: 4 }, lavaArea: 0, lavaGlow: [0, 0, 0, 0], sliding: 0, rockPlaced: 0, burned: 0, arrivals: [], places: [] },
      undo: 0,
      perf: { geoMs: 0, ecoMs: 0, packMs: 0, activeLava: 0, activeSand: 0, activePatches: 0, tickHz: 30 },
    });
    readHands(frame({ brush: null }), pour, hs);
    expect(hs.shown && hs.pouring && hs.tool === 'sand' && hs.x === -50).toBe(true);
    pour.advance(1);
    expect(readHands(frame({ brush: null }), pour, hs).shown).toBe(false);
  });
});
