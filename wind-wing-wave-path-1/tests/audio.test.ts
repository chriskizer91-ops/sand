/** Sound rules (WP-G): pure functions only (WebAudio itself is not available in tests). */
import { describe, expect, it } from 'vitest';
import { NP, NX, NZ, ORIGIN_X, ORIGIN_Z, PATCH_M } from '../src/config';
import { Habitat, HABITAT_COUNT, type VoiceKind } from '../src/content/speciesTypes';
import { mulberry32 } from '../src/engine/noise';
import { PLANT_BYTES, type LifeInfo } from '../src/engine/protocol';
import { BED_SECONDS, crossfadeLoop } from '../src/audio/beds';
import { habitatPresence, makeCensus, popsNear, takeCensus, type CensusFields } from '../src/audio/census';
import { chimeLength, chimeNotes, inScale, midiHz, popNote, tinkleNote, type ChimeKind } from '../src/audio/chimes';
import { NODE_HARD_CAP, NODE_SOFT_CAP, fillBrown, fillImpulse, fillPink, fillWhite, nodeRoom, routeNodes, type AudioGraph } from '../src/audio/graph';
import { Layer, layerNodes, type LayerDef } from '../src/audio/layers';
import * as mix from '../src/audio/mix';
import { THUNDER_NODES, chimeNodes, phraseNodes, scheduleChime, schedulePhrase, scheduleThunder } from '../src/audio/play';
import * as sfx from '../src/audio/sfx';
import { BED_KINDS, MAX_HZ, MIN_HZ, VOICE_KINDS, phraseLength, repeatPhrase, voicePhrase, type PhraseSpec } from '../src/audio/voices';

/** Every voice kind in the contract (speciesTypes.ts), listed by hand to catch drift. */
const CONTRACT_KINDS: VoiceKind[] = [
  'trill', 'coo', 'kee', 'honk', 'wail', 'peep', 'whistle', 'squawk', 'hoot', 'chirp', 'cricket', 'cicada',
  'frog-coqui', 'frog-croak', 'gecko', 'bat', 'whale', 'seal', 'buzz', 'colony', 'clatter', 'quack', 'click', 'rustle',
];

/** A phrase WebAudio can schedule without errors, and that sounds like a short call. */
function expectValidPhrase(p: PhraseSpec, maxLength = 8): void {
  expect(p.syllables.length).toBeGreaterThan(0);
  expect(p.gain).toBeGreaterThan(0);
  expect(p.gain).toBeLessThanOrEqual(1);
  expect(p.reverb).toBeGreaterThanOrEqual(0);
  expect(p.reverb).toBeLessThanOrEqual(1);
  let end = 0;
  for (const s of p.syllables) {
    expect(s.t).toBeGreaterThanOrEqual(end - 1e-9); // in order, never overlapping
    expect(s.dur).toBeGreaterThan(0);
    expect(s.attack).toBeGreaterThan(0);
    expect(s.attack).toBeLessThan(s.dur);
    expect(s.peak).toBeGreaterThan(0);
    expect(s.peak).toBeLessThanOrEqual(1);
    for (const f of [s.f0, s.f1, s.fMid ?? s.f0]) {
      expect(f).toBeGreaterThanOrEqual(MIN_HZ);
      expect(f).toBeLessThanOrEqual(MAX_HZ);
    }
    end = s.t + s.dur;
  }
  expect(phraseLength(p)).toBeLessThan(maxLength);
  if (p.filter) {
    expect(p.filter.freq).toBeGreaterThan(0);
    expect(p.filter.q).toBeGreaterThan(0);
  }
  if (p.fm) expect(p.fm.ratio).toBeGreaterThan(0);
  if (p.am) expect(p.am.depth).toBeLessThanOrEqual(1);
  if (p.source === 'noise') expect(p.fm).toBeUndefined();
}

/** f is non-decreasing over xs. */
function rising(f: (x: number) => number, xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) if (f(xs[i]) < f(xs[i - 1]) - 1e-12) return false;
  return true;
}
const range = (a: number, b: number, n = 50) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

describe('voices', () => {
  it('cover every voice kind in the contract', () => {
    expect([...VOICE_KINDS].sort()).toEqual([...CONTRACT_KINDS].sort());
    for (const k of BED_KINDS) expect(CONTRACT_KINDS).toContain(k);
  });

  it('every kind makes a valid phrase at many pitches', () => {
    const rand = mulberry32(7);
    for (const kind of VOICE_KINDS) {
      for (const pitch of [120, 380, 1150, 3000, 6800]) {
        for (let n = 0; n < 5; n++) expectValidPhrase(voicePhrase(kind, pitch, rand));
      }
    }
  });

  it('pitch follows the species: a higher voice makes a higher phrase', () => {
    for (const kind of VOICE_KINDS) {
      const lo = voicePhrase(kind, 300, mulberry32(3));
      const hi = voicePhrase(kind, 600, mulberry32(3));
      expect(hi.syllables[0].f0).toBeGreaterThan(lo.syllables[0].f0);
    }
  });

  it('a repeated call is one phrase of non-overlapping calls', () => {
    const p = voicePhrase('cricket', 4600, mulberry32(1));
    const len = phraseLength(p);
    const r = repeatPhrase(p, [0, len + 0.1, 2 * len + 0.3]);
    expect(r.syllables.length).toBe(p.syllables.length * 3);
    expectValidPhrase(r, 20);
  });

  it('tool and lava sounds are valid phrases', () => {
    const rand = mulberry32(5);
    for (let i = 0; i < 20; i++) {
      for (const p of [
        sfx.clatterPhrase(rand() * 10, rand),
        sfx.thudPhrase(rand() * 10),
        sfx.rubPhrase(rand),
        sfx.scoopPhrase(rand),
        sfx.steamHissPhrase(rand),
        sfx.bubblePhrase(rand),
        sfx.tinklePhrase(rand),
        sfx.popPhrase(Math.floor(rand() * 3), rand),
        sfx.burnPhrase(rand),
        sfx.clickPhrase(),
        sfx.pagePhrase(),
      ])
        expectValidPhrase(p);
    }
  });
});

describe('chimes', () => {
  const kinds: ChimeKind[] = ['wind', 'wave', 'wing', 'species', 'milestone', 'age', 'first', 'ending'];

  it('every note is in A major pentatonic (A, B, C#, E, F#)', () => {
    expect(inScale(69)).toBe(true); // A4
    expect(inScale(70)).toBe(false); // A#4
    for (const k of kinds) {
      const notes = chimeNotes(k);
      expect(notes.length).toBeGreaterThan(0);
      for (const n of notes) {
        expect(inScale(n.midi)).toBe(true);
        if (n.to !== undefined) expect(inScale(n.to)).toBe(true);
      }
      expect(chimeLength(notes)).toBeLessThan(10);
    }
    const rand = mulberry32(9);
    for (let i = 0; i < 200; i++) {
      expect(inScale(popNote(i % 3, rand))).toBe(true);
      expect(inScale(tinkleNote(rand))).toBe(true);
    }
  });

  it('each road has its own voice: rising bells for wind, falling marimba for sea, glides for wings', () => {
    const wind = chimeNotes('wind').filter((n) => n.voice === 'bell');
    expect(wind[wind.length - 1].midi).toBeGreaterThan(wind[0].midi);
    const sea = chimeNotes('wave').filter((n) => n.voice === 'marimba');
    expect(sea[sea.length - 1].midi).toBeLessThan(sea[0].midi);
    expect(chimeNotes('wing').every((n) => n.voice === 'glide' && n.to! > n.midi)).toBe(true);
    expect(chimeNotes('species').length).toBe(5);
    expect(midiHz(69)).toBeCloseTo(440, 6);
  });

  it('trees pop lower than herbs', () => {
    const rand = mulberry32(2);
    const avg = (layer: number) => {
      let s = 0;
      for (let i = 0; i < 100; i++) s += popNote(layer, rand);
      return s / 100;
    };
    expect(avg(0)).toBeLessThan(avg(1));
    expect(avg(1)).toBeLessThan(avg(2));
  });
});

describe('layer levels move the right way', () => {
  it('altitude: life fades and the high air opens as the camera rises', () => {
    expect(rising((d) => -mix.lifeAltitude(d), range(0, 1600))).toBe(true);
    expect(rising(mix.airAltitude, range(0, 1600))).toBe(true);
    expect(rising((d) => -mix.fieldCutoff(d), range(0, 1600))).toBe(true);
    expect(mix.lifeAltitude(1600)).toBeGreaterThan(0); // a faint hum from above
    expect(rising((d) => -mix.distanceGain(d), range(0, 500))).toBe(true);
    expect(rising((d) => -mix.toolDistanceGain(d), range(0, 2000))).toBe(true);
  });

  it('wind rises with exposure, strength, gusts and storms', () => {
    const r = range(0, 1, 20);
    expect(rising((x) => mix.windLevel(x, 0.5, 0.5, 0.5), r)).toBe(true);
    expect(rising((x) => mix.windLevel(0.5, x, 0.5, 0.5), r)).toBe(true);
    expect(rising((x) => mix.windLevel(0.5, 0.5, x, 0.5), r)).toBe(true);
    expect(rising((x) => mix.windLevel(0.5, 0.5, 0.5, x), r)).toBe(true);
  });

  it('crack whistles need bare rock and fade as shrubs grow; leaves rustle with plants and wind', () => {
    const r = range(0, 1, 20);
    expect(rising((x) => mix.whistleLevel(x, 0.5, 0.2), r)).toBe(true);
    expect(rising((x) => mix.whistleLevel(0.5, x, 0.2), r)).toBe(true);
    expect(rising((x) => -mix.whistleLevel(0.5, 0.5, x), r)).toBe(true);
    expect(mix.whistleLevel(0.5, 0.5, 1)).toBe(0);
    expect(rising((x) => mix.rustleLevel(x, 0.5, 0.5), r)).toBe(true);
    expect(rising((x) => mix.rustleLevel(0.5, x, 0.5), r)).toBe(true);
    expect(rising((x) => mix.rustleLevel(0.5, 0.5, x), r)).toBe(true);
    expect(mix.rustleLevel(0, 1, 1)).toBe(0);
  });

  it('surf fades away from the shore and grows in storms; rain grows with rain and leaves', () => {
    expect(rising((d) => -mix.surfLevel(d, 0.3), range(0, 400))).toBe(true);
    expect(rising((s) => mix.surfLevel(50, s), range(0, 1))).toBe(true);
    expect(rising(mix.rainLevel, range(0, 1))).toBe(true);
    expect(rising((x) => mix.leafRainLevel(x, 0.5), range(0, 1))).toBe(true);
    expect(rising((x) => mix.leafRainLevel(0.5, x), range(0, 1))).toBe(true);
    expect(rising((x) => mix.airLevel(x, 0.2), range(0, 1))).toBe(true);
  });

  it('choruses grow with abundance, activity and season; colonies with size and nearness', () => {
    const r = range(0, 1, 20);
    expect(rising((x) => mix.chorusLevel(x, 0.7, 0.7), r)).toBe(true);
    expect(rising((x) => mix.chorusLevel(0.7, x, 0.7), r)).toBe(true);
    expect(rising((x) => mix.chorusLevel(0.7, 0.7, x), r)).toBe(true);
    expect(mix.chorusLevel(0, 1, 1)).toBe(0);
    expect(rising((n) => mix.colonyLevel(n, 50), r)).toBe(true);
    expect(rising((d) => -mix.colonyLevel(0.8, d), range(0, 500))).toBe(true);
    expect(rising((s) => -mix.weatherQuiet(s), r)).toBe(true);
  });

  it('lava hiss grows with the molten area; cooling pings with the cooling', () => {
    expect(rising(mix.lavaLevel, range(0, 5000))).toBe(true);
    expect(mix.lavaLevel(0)).toBe(0);
    expect(rising((c) => mix.tinkleRate(500, c), range(0, 300))).toBe(true);
    expect(mix.tinkleRate(0, 100)).toBe(0);
  });

  it('time of day: crickets at night, birds by day, bats at dusk, all smooth', () => {
    expect(mix.activity('night', 0.875)).toBe(1);
    expect(mix.activity('night', 0.375)).toBe(0);
    expect(mix.activity('day', 0.375)).toBe(1);
    expect(mix.activity('day', 0.875)).toBe(0);
    expect(mix.activity('dusk', 0.71)).toBeGreaterThan(0.8);
    expect(mix.activity('dusk', 0.375)).toBe(0);
    expect(mix.activity('dawn', 0.06)).toBeGreaterThan(0.8);
    expect(mix.activity('any', 0.5)).toBe(1);
    for (const when of ['day', 'night', 'dusk', 'dawn', 'any'] as const) {
      let worst = 0;
      for (let i = 1; i <= 10000; i++) worst = Math.max(worst, Math.abs(mix.activity(when, i / 10000) - mix.activity(when, (i - 1) / 10000)));
      expect(worst).toBeLessThan(0.01);
    }
    expect(mix.dawnChorus(0.08)).toBeGreaterThan(1.5);
    expect(mix.dawnChorus(0.4)).toBe(1);
  });
});

describe('the census around the listener', () => {
  /** A made-up world: an island of radius 100 m at the origin, sandy on its west half. */
  function world(): CensusFields {
    const surf = new Float32Array(NX * NZ).fill(-30);
    const ground = new Uint8Array(NX * NZ * 4);
    const coverA = new Uint8Array(NP * NP * 4);
    const plants = new Uint8Array(NP * NP * PLANT_BYTES);
    const habitat = new Uint8Array(NP * NP).fill(Habitat.OpenSea);
    for (let k = 0; k < NZ; k++) {
      for (let i = 0; i < NX; i++) {
        const x = ORIGIN_X + (i + 0.5) * 2;
        const z = ORIGIN_Z + (k + 0.5) * 2;
        const d = Math.hypot(x, z);
        const c = i + k * NX;
        surf[c] = 10 - d * 0.12;
        if (x < 0) ground[c * 4 + 2] = 100; // 2 m of sand
      }
    }
    for (let pk = 0; pk < NP; pk++) {
      for (let pi = 0; pi < NP; pi++) {
        const x = ORIGIN_X + (pi + 0.5) * PATCH_M;
        const z = ORIGIN_Z + (pk + 0.5) * PATCH_M;
        const p = pi + pk * NP;
        if (Math.hypot(x, z) > 82) continue;
        // Forest on the north half (z < 0), bare rock on the south.
        if (z < 0) {
          plants[p * PLANT_BYTES] = 1;
          plants[p * PLANT_BYTES + 1] = 230;
          habitat[p] = Habitat.Forest;
        } else habitat[p] = Habitat.BareRock;
      }
    }
    return { surf, ground, coverA, plants, habitat };
  }

  it('counts land, plants, habitats and finds the nearest shore', () => {
    const w = world();
    const c = makeCensus();
    const rand = mulberry32(4);
    takeCensus(w, 0, -40, c, rand);
    expect(c.land).toBeGreaterThan(0.6);
    expect(c.green).toBeGreaterThan(0.4);
    expect(c.habCount[Habitat.Forest]).toBeGreaterThan(100);
    expect(c.shoreDist).toBeGreaterThan(30);
    expect(c.shoreDist).toBeLessThan(60);
    // Out at sea: no land within reach, the shore is ahead.
    takeCensus(w, 0, 160, c, rand);
    expect(c.land).toBeLessThan(0.2);
    expect(c.shoreDist).toBeGreaterThan(50);
    expect(c.shoreDist).toBeLessThan(90);
    // South is bare rock: it whistles.
    takeCensus(w, 0, 50, c, rand);
    expect(c.bare).toBeGreaterThan(0.5);
    let total = 0;
    for (let h = 0; h < HABITAT_COUNT; h++) total += c.habCount[h];
    expect(total).toBeGreaterThan(1000);
  });

  it('tells a sandy shore from a rocky one', () => {
    const w = world();
    const c = makeCensus();
    takeCensus(w, -95, 0, c, mulberry32(1));
    expect(c.shoreRock).toBeLessThan(0.5);
    takeCensus(w, 95, 0, c, mulberry32(1));
    expect(c.shoreRock).toBeGreaterThan(0.5);
  });

  it('a species is present where its habitats are, more with more habitat', () => {
    const c = makeCensus();
    expect(habitatPresence([Habitat.Forest], c)).toBe(0);
    c.habCount[Habitat.Forest] = 3;
    const some = habitatPresence([Habitat.Forest], c);
    c.habCount[Habitat.Forest] = 30;
    expect(habitatPresence([Habitat.Forest], c)).toBeGreaterThan(some);
    expect(habitatPresence([Habitat.Forest], c)).toBeLessThanOrEqual(1);
  });

  it('island populations are heard near their island and fade offshore', () => {
    const life: LifeInfo = {
      islands: [{ id: 1, name: 'A', area: 1, peak: [0, 50, 0], centroid: [0, 0], bbox: [-100, -100, 100, 100], founded: 0, species: 1, forest: 0 }],
      ponds: [],
      peaks: [],
      pops: [{ species: 2, island: 1, n: 0.7 }],
      colonies: [],
      sound: null,
      found: 1,
      total: 3,
      age: 'green',
      ending: false,
    };
    const out = new Float32Array(3);
    expect(popsNear(life, 0, 0, out)[2]).toBeCloseTo(0.7, 6);
    expect(popsNear(life, 250, 0, out)[2]).toBeGreaterThan(0);
    expect(popsNear(life, 250, 0, out)[2]).toBeLessThan(0.7);
    expect(popsNear(life, 600, 0, out)[2]).toBe(0);
    expect(popsNear(null, 0, 0, out)[2]).toBe(0);
  });
});

describe('sound sources made in code', () => {
  it('noise buffers stay in range; brown is deep and pink is in between', () => {
    const rand = mulberry32(11);
    const n = 48000;
    const roughness = (a: Float32Array) => {
      let s = 0;
      let e = 0;
      for (let i = 1; i < a.length; i++) {
        s += Math.abs(a[i] - a[i - 1]);
        e += Math.abs(a[i]);
      }
      return s / e;
    };
    const white = fillWhite(new Float32Array(n), rand);
    const pink = fillPink(new Float32Array(n), rand);
    const brown = fillBrown(new Float32Array(n), rand);
    for (const a of [white, pink, brown]) for (const v of a) expect(Math.abs(v)).toBeLessThanOrEqual(1.5);
    expect(roughness(brown)).toBeLessThan(roughness(pink));
    expect(roughness(pink)).toBeLessThan(roughness(white));
  });

  it('the reverb impulse dies away and ends darker', () => {
    const rate = 24000;
    const l = new Float32Array(rate);
    const r = new Float32Array(rate);
    fillImpulse(l, r, rate, 1, mulberry32(3));
    const energy = (a: Float32Array, from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += a[i] * a[i];
      return s;
    };
    expect(energy(l, l.length - 2400, l.length)).toBeLessThan(energy(l, 0, 2400) * 0.001);
    expect(l).not.toEqual(r); // a little different in each ear
  });

  it('baked loops join without a click', () => {
    const loopLen = 24000;
    const fade = 2400;
    const src = new Float32Array(loopLen + fade);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin(i * 0.0123) * 0.5 + Math.sin(i * 0.0071) * 0.3;
    const out = crossfadeLoop(src, loopLen, fade, new Float32Array(loopLen));
    let step = 0;
    for (let i = 1; i < loopLen; i++) step = Math.max(step, Math.abs(out[i] - out[i - 1]));
    expect(Math.abs(out[0] - out[loopLen - 1])).toBeLessThanOrEqual(step * 1.5);
    for (const s of Object.values(BED_SECONDS)) expect(s).toBeGreaterThan(4);
  });
});

describe('the node budget', () => {
  /**
   * Just enough of a WebAudio context to count the nodes a player makes (WebAudio itself is not
   * available in tests): every create call is counted, params and connections do nothing.
   */
  function countingContext() {
    const made = { n: 0 };
    const param = () => ({
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      exponentialRampToValueAtTime() {},
      setTargetAtTime() {},
      cancelScheduledValues() {},
    });
    const node = (extra: Record<string, unknown>) => {
      made.n++;
      return { connect: (to: unknown) => to, disconnect() {}, start() {}, stop() {}, ...extra };
    };
    const ctx = {
      currentTime: 0,
      sampleRate: 24000,
      createGain: () => node({ gain: param() }),
      createOscillator: () => node({ type: 'sine', frequency: param() }),
      createBufferSource: () => node({ buffer: null, loop: false }),
      createBiquadFilter: () => node({ type: 'lowpass', frequency: param(), Q: param() }),
      createStereoPanner: () => node({ pan: param() }),
    };
    return { ctx: ctx as unknown as BaseAudioContext, made };
  }
  const noise = { duration: 2 } as AudioBuffer;

  it('new calls give way first; chimes and thunder may use the reserve; nothing passes the hard cap', () => {
    expect(NODE_SOFT_CAP).toBeLessThan(NODE_HARD_CAP);
    expect(nodeRoom(NODE_SOFT_CAP - 6, 6, false)).toBe(true);
    expect(nodeRoom(NODE_SOFT_CAP - 5, 6, false)).toBe(false);
    expect(nodeRoom(NODE_SOFT_CAP - 5, 6, true)).toBe(true);
    expect(nodeRoom(NODE_HARD_CAP - 5, 6, true)).toBe(false);
    expect(routeNodes(0)).toBe(1);
    expect(routeNodes(0.3)).toBe(2);
  });

  it('a sound costs what it is counted at: every voice, tool sound, chime and thunder', () => {
    const rand = mulberry32(21);
    const phrases: PhraseSpec[] = [];
    for (const kind of VOICE_KINDS) for (const pitch of [300, 1200, 4000]) phrases.push(voicePhrase(kind, pitch, rand));
    phrases.push(sfx.clatterPhrase(3, rand), sfx.thudPhrase(3), sfx.rubPhrase(rand), sfx.scoopPhrase(rand), sfx.steamHissPhrase(rand));
    phrases.push(sfx.bubblePhrase(rand), sfx.tinklePhrase(rand), sfx.popPhrase(1, rand), sfx.burnPhrase(rand), sfx.clickPhrase(), sfx.pagePhrase());
    for (const p of phrases) {
      const { ctx, made } = countingContext();
      const s = schedulePhrase(ctx, p, 0, 0.5, noise, 0);
      expect(made.n).toBe(phraseNodes(p));
      expect(s.nodes.length).toBe(phraseNodes(p));
    }
    for (const kind of ['wind', 'wave', 'wing', 'species', 'milestone', 'age', 'first', 'ending'] as ChimeKind[]) {
      const { ctx, made } = countingContext();
      const notes = chimeNotes(kind);
      const s = scheduleChime(ctx, notes, 0, 0.1, noise);
      expect(made.n, kind).toBe(chimeNodes(notes));
      expect(s.nodes.length, kind).toBe(chimeNodes(notes));
    }
    const { ctx, made } = countingContext();
    scheduleThunder(ctx, 0, 1500, noise, rand);
    expect(made.n).toBe(THUNDER_NODES);
  });

  it('a running layer counts its nodes into the budget, and gives them back when it stops', () => {
    const { ctx, made } = countingContext();
    const graph = { ctx, bus: { ambience: {}, life: {}, weather: {}, tools: {}, chimes: {} }, layerNodes: 0 } as unknown as AudioGraph;
    const defs: LayerDef[] = [
      { bus: 'tools', source: 'brown', filters: [{ type: 'lowpass', freq: 160, q: 0.9 }], am: { rate: 4.5, depth: 0.6 }, pan: true, prio: 10, tau: 0.12 },
      { bus: 'weather', source: 'white', filters: [{ type: 'highpass', freq: 1000, q: 0.5 }, { type: 'lowpass', freq: 9000, q: 0.5 }], prio: 8, tau: 1 },
      { bus: 'life', source: 'crickets', prio: 3, tau: 2 },
    ];
    for (const def of defs) {
      made.n = 0;
      const layer = new Layer(def);
      layer.start(graph, noise, 0);
      expect(graph.layerNodes).toBe(made.n);
      expect(graph.layerNodes).toBe(layerNodes(def));
      layer.stop();
      expect(graph.layerNodes).toBe(0);
    }
    expect(layerNodes(defs[0])).toBe(7); // source, filter, flutter (gain, LFO, depth), gain, panner
  });

  it('a layer that loses its slot fades out and stops within a second, not after the usual quiet wait', () => {
    const { ctx } = countingContext();
    const graph = { ctx, bus: { ambience: {}, life: {}, weather: {}, tools: {}, chimes: {} }, layerNodes: 0 } as unknown as AudioGraph;
    const layer = new Layer({ bus: 'ambience', source: 'pink', filters: [{ type: 'lowpass', freq: 500, q: 0.8 }], prio: 6, tau: 1.5 });
    layer.start(graph, noise, 0);
    layer.target = 0.3;
    for (let i = 0; i < 150; i++) layer.update(i / 15, 1 / 15);
    expect(layer.level).toBeGreaterThan(0.25);
    layer.evicted = true;
    let t = 0;
    while (!layer.spent && t < 5) {
      layer.update(10 + t, 1 / 15);
      t += 1 / 15;
    }
    expect(t).toBeLessThan(1.2);
    // A layer that is only quiet (still owning its slot) waits a while before it stops.
    layer.evicted = false;
    layer.target = 0;
    expect(layer.spent).toBe(false);
  });
});

describe('surf', () => {
  it('swells and brightens on its own rhythm, so the baked loop never repeats exactly', () => {
    let worstStep = 0;
    const apart = [0, 0];
    let n = 0;
    for (let t = 0; t < 900; t += 0.1) {
      const v = mix.surfSwell(t);
      expect(v).toBeGreaterThanOrEqual(0.7);
      expect(v).toBeLessThanOrEqual(1.1);
      worstStep = Math.max(worstStep, Math.abs(mix.surfSwell(t + 0.1) - v));
      // Compare each moment with the same moment one loop later (the surf beds are 12 and 13 s).
      apart[0] += Math.abs(mix.surfSwell(t + BED_SECONDS.surf) - v);
      apart[1] += Math.abs(mix.surfSwell(t + BED_SECONDS.surfRock) - v);
      n++;
    }
    expect(worstStep).toBeLessThan(0.03); // smooth: no audible steps
    expect(apart[0] / n).toBeGreaterThan(0.05);
    expect(apart[1] / n).toBeGreaterThan(0.05);
    for (let t = 0; t < 300; t += 0.7) {
      expect(mix.surfCutoff(t, 0)).toBeGreaterThanOrEqual(1800);
      expect(mix.surfCutoff(t, 1)).toBeGreaterThanOrEqual(mix.surfCutoff(t, 0));
      expect(mix.surfCutoff(t, 1)).toBeLessThanOrEqual(8000);
    }
  });
});
