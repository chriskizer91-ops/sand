/**
 * Baked choruses ("beds", WP-G): dense textures rendered once, in code, with an
 * OfflineAudioContext (off the main thread), then played as seamless loops. A whole night of
 * crickets, a coqui chorus, a seabird colony or rain on leaves then costs about one playing
 * sound instead of hundreds. Each bed is rendered the first time it is needed; nothing is
 * stored. Beds render at 24 kHz (everything in them sits well below 12 kHz), stereo.
 */
import { mulberry32 } from '../engine/noise';
import { fillBrown, fillPink, fillWhite } from './graph';
import { schedulePhrase } from './play';
import { repeatPhrase, voicePhrase } from './voices';

export type BedId = 'crickets' | 'coqui' | 'cicadas' | 'colony' | 'rainLeaves' | 'crackle' | 'surf' | 'surfRock';

export const BED_RATE = 24000;
/** Loop lengths (s): different lengths keep beds from lining up audibly. */
export const BED_SECONDS: Record<BedId, number> = { crickets: 10, coqui: 11, cicadas: 13, colony: 10, rainLeaves: 8, crackle: 6, surf: 12, surfRock: 13 };
/** The last second of each render is folded into its start, so the loop has no seam. */
const FADE = 1;

/**
 * Fold the tail of `src` (loopLen + fadeLen samples) into its head with an equal-power
 * crossfade. Played as a loop of loopLen samples, the result runs on without a click.
 */
export function crossfadeLoop(src: Float32Array, loopLen: number, fadeLen: number, out: Float32Array): Float32Array {
  for (let i = 0; i < loopLen; i++) {
    if (i < fadeLen) {
      const a = i / fadeLen;
      out[i] = src[i] * Math.sqrt(a) + src[loopLen + i] * Math.sqrt(1 - a);
    } else out[i] = src[i];
  }
  return out;
}

type Rand = () => number;
type Recipe = (ctx: OfflineAudioContext, seconds: number, rand: Rand) => void;

function buffer(ctx: BaseAudioContext, seconds: number, fill: (out: Float32Array, rand: Rand) => Float32Array, rand: Rand): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  fill(b.getChannelData(0), rand);
  return b;
}

function panner(ctx: BaseAudioContext, pan: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(ctx.destination);
  return p;
}

/** Call times for one individual: roughly every `period` s with a little drift. */
function callTimes(seconds: number, period: number, jitter: number, rand: Rand): number[] {
  const out: number[] = [];
  for (let t = rand() * period; t < seconds - 0.5; t += period * (1 - jitter / 2 + jitter * rand())) out.push(t);
  return out;
}

/** Sparse random grains written straight into a buffer (rain pings, lava crackle). */
function grainBuffer(ctx: BaseAudioContext, seconds: number, perSecond: number, grainSec: [number, number], rand: Rand): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  const n = Math.floor(seconds * perSecond);
  for (let g = 0; g < n; g++) {
    const at = Math.floor(rand() * d.length);
    const len = Math.max(1, Math.floor(ctx.sampleRate * (grainSec[0] + (grainSec[1] - grainSec[0]) * rand())));
    const amp = (0.2 + 0.8 * rand() * rand()) * (rand() < 0.5 ? -1 : 1);
    for (let i = 0; i < len && at + i < d.length; i++) d[at + i] += amp * (rand() * 2 - 1) * Math.exp((-5 * i) / len);
  }
  return b;
}

const RECIPES: Record<BedId, Recipe> = {
  // Twelve crickets, each a single oscillator chirping on its own slightly different beat.
  crickets: (ctx, sec, rand) => {
    const noise = buffer(ctx, 1, fillWhite, rand);
    for (let c = 0; c < 12; c++) {
      const spec = voicePhrase('cricket', 4600 + (rand() - 0.5) * 300, rand);
      const s = schedulePhrase(ctx, repeatPhrase(spec, callTimes(sec, 0.55 + rand() * 0.15, 0.1, rand)), 0, 0.25 + 0.75 * rand(), noise, 0);
      s.out.connect(panner(ctx, rand() * 1.6 - 0.8));
    }
  },
  // Eight coqui-like frogs calling "ko-KEE" every two or three seconds.
  coqui: (ctx, sec, rand) => {
    const noise = buffer(ctx, 1, fillWhite, rand);
    for (let c = 0; c < 8; c++) {
      const spec = voicePhrase('frog-coqui', 1150 * (0.94 + 0.12 * rand()), rand);
      const s = schedulePhrase(ctx, repeatPhrase(spec, callTimes(sec, 1.6 + rand() * 1.4, 0.3, rand)), 0, 0.3 + 0.7 * rand(), noise, 0);
      s.out.connect(panner(ctx, rand() * 1.6 - 0.8));
    }
  },
  // Three cicadas swelling in turn.
  cicadas: (ctx, sec, rand) => {
    const noise = buffer(ctx, 2, fillWhite, rand);
    for (let c = 0; c < 3; c++) {
      const spec = voicePhrase('cicada', 5500 * (0.9 + 0.2 * rand()), rand);
      const at = (c * sec) / 3 + rand() * 1.5;
      const s = schedulePhrase(ctx, repeatPhrase(spec, [at]), 0, 0.6 + 0.4 * rand(), noise, rand());
      s.out.connect(panner(ctx, rand() * 1.4 - 0.7));
    }
  },
  // A seabird colony: dozens of overlapping honks, kee-calls and grunts, softened by distance.
  colony: (ctx, sec, rand) => {
    const noise = buffer(ctx, 1, fillWhite, rand);
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 3500;
    soften.connect(ctx.destination);
    for (let c = 0; c < 45; c++) {
      const pick = rand();
      const spec = pick < 0.45 ? voicePhrase('colony', 600 + rand() * 800, rand) : pick < 0.75 ? voicePhrase('honk', 300 + rand() * 150, rand) : voicePhrase('kee', 1800 + rand() * 800, rand);
      const s = schedulePhrase(ctx, spec, rand() * (sec - 1), 0.2 + 0.8 * rand() * rand(), noise, 0);
      const p = ctx.createStereoPanner();
      p.pan.value = rand() * 1.8 - 0.9;
      s.out.connect(p).connect(soften);
    }
  },
  // Rain on leaves: a few hundred drops a second ringing three resonant filters, plus a soft wash.
  rainLeaves: (ctx, sec, rand) => {
    for (const side of [-0.6, 0.6]) {
      const drops = ctx.createBufferSource();
      drops.buffer = grainBuffer(ctx, sec, 110, [0.0004, 0.001], rand);
      const out = panner(ctx, side);
      for (const [f, q, g] of [
        [1900, 60, 0.9],
        [2900, 80, 0.7],
        [4300, 100, 0.5],
      ] as const) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f * (0.95 + 0.1 * rand());
        bp.Q.value = q;
        const gain = ctx.createGain();
        gain.gain.value = g * 2.5;
        drops.connect(bp).connect(gain).connect(out);
      }
      drops.start(0);
    }
    const wash = ctx.createBufferSource();
    wash.buffer = buffer(ctx, sec, fillWhite, rand);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    wash.connect(hp).connect(g).connect(ctx.destination);
    wash.start(0);
  },
  // Lava crackle: a Poisson train of tiny noise grains through two band-passes.
  crackle: (ctx, sec, rand) => {
    for (const side of [-0.4, 0.4]) {
      const src = ctx.createBufferSource();
      src.buffer = grainBuffer(ctx, sec, 12, [0.002, 0.008], rand);
      const out = panner(ctx, side);
      for (const [f, q] of [
        [1500, 2],
        [3200, 2.5],
      ] as const) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = q;
        bp.connect(out);
        src.connect(bp);
      }
      src.start(0);
    }
  },
  // Waves washing onto sand: each one builds, breaks, fizzes up the beach and drains away.
  surf: (ctx, sec, rand) => waves(ctx, sec, rand, false),
  // Waves on rock: the same wash, shorter, with a thump and a splash as each one hits.
  surfRock: (ctx, sec, rand) => waves(ctx, sec, rand, true),
};

function waves(ctx: OfflineAudioContext, sec: number, rand: Rand, rocky: boolean): void {
  const pink = buffer(ctx, 3, fillPink, rand);
  const white = buffer(ctx, 2, fillWhite, rand);
  const brown = buffer(ctx, 3, fillBrown, rand);
  for (let t = rand() * 1.5; t < sec - 0.5; t += 5.2 + rand() * 2) {
    const crash = t + 1.6 + rand() * 0.6;
    const out = panner(ctx, rand() * 0.8 - 0.4);
    const wash = ctx.createBufferSource();
    wash.buffer = rocky ? brown : pink;
    wash.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(250, t);
    lp.frequency.exponentialRampToValueAtTime(rocky ? 1800 : 1300, crash);
    lp.frequency.exponentialRampToValueAtTime(400, crash + (rocky ? 2.4 : 3.6));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, crash - 0.3);
    g.gain.linearRampToValueAtTime(rocky ? 0.75 : 0.55, crash);
    g.gain.linearRampToValueAtTime(0.14, crash + 1.4);
    g.gain.linearRampToValueAtTime(0, crash + (rocky ? 2.6 : 3.8));
    wash.connect(lp).connect(g).connect(out);
    wash.start(t, rand());
    wash.stop(crash + 4);
    // Fizz of bubbles in the swash.
    const fizz = ctx.createBufferSource();
    fizz.buffer = white;
    fizz.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const fg = ctx.createGain();
    fg.gain.setValueAtTime(0, crash);
    fg.gain.linearRampToValueAtTime(rocky ? 0.06 : 0.09, crash + 0.4);
    fg.gain.linearRampToValueAtTime(0, crash + (rocky ? 2 : 3.2));
    fizz.connect(hp).connect(fg).connect(out);
    fizz.start(crash, rand());
    fizz.stop(crash + 3.5);
    if (rocky) {
      const thump = ctx.createOscillator();
      thump.frequency.setValueAtTime(60, crash);
      thump.frequency.exponentialRampToValueAtTime(45, crash + 0.35);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0, crash);
      tg.gain.linearRampToValueAtTime(0.35, crash + 0.01);
      tg.gain.exponentialRampToValueAtTime(0.0001, crash + 0.35);
      thump.connect(tg).connect(out);
      thump.start(crash);
      thump.stop(crash + 0.4);
      const splash = ctx.createBufferSource();
      splash.buffer = white;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.9;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0, crash);
      sg.gain.linearRampToValueAtTime(0.3, crash + 0.03);
      sg.gain.exponentialRampToValueAtTime(0.0001, crash + 0.45);
      splash.connect(bp).connect(sg).connect(out);
      splash.start(crash, rand());
      splash.stop(crash + 0.5);
    }
  }
}

/** Render one bed (async, off the main thread) into a seamless stereo loop. */
export async function renderBed(id: BedId): Promise<AudioBuffer> {
  const sec = BED_SECONDS[id];
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil((sec + FADE) * BED_RATE), sampleRate: BED_RATE });
  let seed = 0;
  for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) | 0;
  RECIPES[id](ctx, sec + FADE, mulberry32(seed));
  const raw = await ctx.startRendering();
  const loopLen = Math.floor(sec * BED_RATE);
  const out = ctx.createBuffer(2, loopLen, BED_RATE);
  for (let ch = 0; ch < 2; ch++) crossfadeLoop(raw.getChannelData(ch), loopLen, Math.floor(FADE * BED_RATE), out.getChannelData(ch));
  return out;
}

/** Beds made on first use, one at a time so a phone never renders two at once. */
export class BedStore {
  private ready = new Map<BedId, AudioBuffer>();
  private queue: BedId[] = [];
  private busy = false;
  private failed = false;

  /** The bed if it is ready; otherwise it is queued for rendering and null is returned. */
  get(id: BedId): AudioBuffer | null {
    const b = this.ready.get(id);
    if (b) return b;
    if (!this.failed && !this.queue.includes(id)) {
      this.queue.push(id);
      this.pump();
    }
    return null;
  }

  private pump(): void {
    if (this.busy || this.queue.length === 0) return;
    const id = this.queue[0];
    this.busy = true;
    renderBed(id)
      .then((b) => {
        this.ready.set(id, b);
        this.queue.shift();
      })
      .catch(() => {
        // No offline rendering on this browser: the beds stay silent, everything else plays.
        this.failed = true;
        this.queue.length = 0;
      })
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }
}
