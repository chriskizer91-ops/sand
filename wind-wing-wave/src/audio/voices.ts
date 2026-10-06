/**
 * Animal voices as "phrases" (WP-G): one sound source, one envelope, a few automated
 * parameters. A 20-note bird trill is a single oscillator whose pitch and loudness are
 * scheduled ahead, not 20 separate sounds, which keeps the phone's audio work tiny.
 *
 * This file is pure: voicePhrase() turns a species' voice (SpeciesDef.voice) into a list of
 * syllables and settings, so every VoiceKind can be checked in tests without WebAudio.
 * play.ts turns a phrase into WebAudio nodes. Recipes follow look-and-sound §9.3.
 */
import type { VoiceKind } from '../content/speciesTypes';

export type SourceKind = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise';

/** One note or call within a phrase. */
export interface Syllable {
  /** Start (s) from the start of the phrase. */
  t: number;
  /** Length (s). */
  dur: number;
  /** Pitch (Hz) at the start, optionally halfway, and at the end. For noise it steers the filter. */
  f0: number;
  fMid?: number;
  f1: number;
  /** Peak level 0..1 and the time to reach it (s). */
  peak: number;
  attack: number;
}

export interface PhraseSpec {
  source: SourceKind;
  /** In time order, never overlapping. */
  syllables: Syllable[];
  /** Frequency modulation: a modulator at ratio x pitch, swinging the pitch by `depth` Hz. */
  fm?: { ratio: number; depth: number };
  /** Slow pitch wobble: rate (Hz) and depth (fraction of the pitch). */
  vibrato?: { rate: number; depth: number };
  /** Amplitude flutter (rasps and croaks): rate (Hz), depth 0..1, square or smooth. */
  am?: { rate: number; depth: number; square: boolean };
  /** A filter after the source. `follow`: its centre tracks the syllable pitch (noise voices). */
  filter?: { type: 'lowpass' | 'highpass' | 'bandpass'; freq: number; q: number; follow: boolean };
  /** Overall level before the species' loudness and distance. */
  gain: number;
  /** Share sent to the reverb (airy, distant, eerie calls get more). */
  reverb: number;
}

type Rand = () => number;
type Recipe = (pitch: number, rand: Rand) => PhraseSpec;

function syl(t: number, dur: number, f0: number, f1: number, peak = 1, attack = Math.min(0.02, dur * 0.3), fMid?: number): Syllable {
  return fMid === undefined ? { t, dur, f0, f1, peak, attack } : { t, dur, f0, fMid, f1, peak, attack };
}

/** n syllables, each `gap(i)` seconds after the previous one started. */
function series(n: number, gap: (i: number) => number, make: (i: number, t: number) => Syllable): Syllable[] {
  const out: Syllable[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push(make(i, t));
    t += gap(i);
  }
  return out;
}

const count = (rand: Rand, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const RECIPES: Record<VoiceKind, Recipe> = {
  // Bananaquit-like: 12-20 quick notes hopping between four pitches, each gliding up a little.
  trill: (p, r) => {
    const steps = [0.91, 1, 1.09, 1.18];
    return {
      source: 'sine',
      syllables: series(count(r, 12, 20), () => 0.055, (_i, t) => {
        const f = p * steps[Math.floor(r() * 4)];
        return syl(t, 0.04, f, f * 1.04, 0.7 + 0.3 * r(), 0.006);
      }),
      gain: 0.5,
      reverb: 0.15,
    };
  },
  // Ground dove: "coo-OO-oo", soft and falling.
  coo: (p, r) => ({
    source: 'sine',
    syllables: series(count(r, 3, 5), () => 0.38, (i, t) => {
      const f = p * (1 - 0.02 * i);
      return syl(t, i === 1 ? 0.34 : 0.26, f, f * 0.9, i === 1 ? 1 : 0.75, 0.07);
    }),
    filter: { type: 'lowpass', freq: 1200, q: 0.7, follow: false },
    gain: 0.6,
    reverb: 0.2,
  }),
  // Tern or tropicbird: a shrill falling "kee-arr".
  kee: (p, r) => ({
    source: 'sawtooth',
    syllables: series(count(r, 1, 3), () => 0.45, (_i, t) => syl(t, 0.25, p, p * 0.64, 1, 0.02)),
    filter: { type: 'bandpass', freq: p * 0.9, q: 1.5, follow: false },
    gain: 0.35,
    reverb: 0.25,
  }),
  // Booby: a nasal honk that drops in pitch.
  honk: (p, r) => ({
    source: 'square',
    syllables: series(count(r, 1, 3), () => 0.3, (_i, t) => syl(t, 0.2, p, p * 0.85, 1, 0.015)),
    filter: { type: 'bandpass', freq: p * 2.4, q: 3, follow: false },
    gain: 0.5,
    reverb: 0.2,
  }),
  // Shearwater at night: an eerie rising and falling wail.
  wail: (p) => ({
    source: 'sawtooth',
    syllables: [syl(0, 1.2, p, p * 0.93, 1, 0.25, p * 1.5)],
    filter: { type: 'bandpass', freq: p * 2, q: 2.5, follow: false },
    vibrato: { rate: 5, depth: 0.015 },
    gain: 0.35,
    reverb: 0.6,
  }),
  // Sandpiper: quick "peep" pairs.
  peep: (p, r) => ({
    source: 'sine',
    syllables: series(count(r, 2, 4), () => 0.11 + r() * 0.04, (_i, t) => syl(t, 0.06, p * 1.05, p * 0.93, 1, 0.006)),
    gain: 0.45,
    reverb: 0.1,
  }),
  // Plover-like two-note whistle.
  whistle: (p) => ({
    source: 'sine',
    syllables: [syl(0, 0.3, p, p * 1.28, 1, 0.04), syl(0.38, 0.26, p * 1.12, p * 0.92, 0.8, 0.03)],
    gain: 0.4,
    reverb: 0.25,
  }),
  // Parrot: a rough, buzzy squawk.
  squawk: (p, r) => ({
    source: 'sawtooth',
    syllables: series(count(r, 1, 2), () => 0.35, (_i, t) => syl(t, 0.18, p * 1.05, p * 0.9, 1, 0.01)),
    fm: { ratio: 2.3, depth: p * 0.66 },
    filter: { type: 'bandpass', freq: p * 2, q: 1, follow: false },
    gain: 0.4,
    reverb: 0.15,
  }),
  // Owl: soft hoots with a slight waver, the last one lower.
  hoot: (p, r) => {
    const n = count(r, 2, 3);
    return {
      source: 'sine',
      syllables: series(n, () => 0.6, (i, t) => {
        const f = p * (i === n - 1 ? 0.94 : 1);
        return syl(t, 0.35, f, f * 0.97, 1, 0.06);
      }),
      vibrato: { rate: 6, depth: 0.012 },
      filter: { type: 'lowpass', freq: 800, q: 0.7, follow: false },
      gain: 0.6,
      reverb: 0.35,
    };
  },
  // Small bird chips, irregular.
  chirp: (p, r) => ({
    source: 'sine',
    syllables: series(count(r, 4, 8), () => 0.08 + r() * 0.12, (_i, t) => syl(t, 0.03, p * 0.8, p * 1.25, 0.8 + 0.2 * r(), 0.004)),
    gain: 0.4,
    reverb: 0.1,
  }),
  // One cricket chirp: 3-5 pulses at 30 Hz.
  cricket: (p, r) => ({
    source: 'sine',
    syllables: series(count(r, 3, 5), () => 1 / 30, (_i, t) => syl(t, 0.018, p, p, 1, 0.003)),
    gain: 0.25,
    reverb: 0,
  }),
  // Cicada: a buzzing rasp that swells, holds and stops.
  cicada: (p) => ({
    source: 'noise',
    syllables: [syl(0, 4, p * 0.95, p * 1.03, 1, 1.6)],
    filter: { type: 'bandpass', freq: p, q: 3, follow: true },
    am: { rate: 200, depth: 0.8, square: true },
    gain: 0.18,
    reverb: 0,
  }),
  // Coqui-like tree frog: "ko-KEE".
  'frog-coqui': (p) => ({
    source: 'sine',
    syllables: [syl(0, 0.09, p, p * 0.98, 0.8, 0.005), syl(0.12, 0.14, p * 1.7, p * 2.13, 1, 0.008)],
    gain: 0.45,
    reverb: 0.2,
  }),
  // Pond frog: a throaty "grunk".
  'frog-croak': (p, r) => ({
    source: 'square',
    syllables: series(count(r, 1, 3), () => 0.45, (_i, t) => syl(t, 0.25, p, p * 0.95, 1, 0.02)),
    filter: { type: 'bandpass', freq: p * 3.3, q: 4, follow: false },
    am: { rate: 25, depth: 0.9, square: false },
    gain: 0.55,
    reverb: 0.1,
  }),
  // Gecko: "chuck-chuck-chuck", slowing down.
  gecko: (p, r) => ({
    source: 'triangle',
    syllables: series(count(r, 5, 8), (i) => 0.13 + i * 0.02, (_i, t) => syl(t, 0.05, p * 1.2, p * 0.8, 1, 0.004)),
    filter: { type: 'bandpass', freq: p * 1.4, q: 2, follow: false },
    gain: 0.45,
    reverb: 0.1,
  }),
  // Bats squabbling: tiny squeaks in bursts.
  bat: (p, r) => ({
    source: 'noise',
    syllables: series(count(r, 3, 6), () => 0.06 + r() * 0.04, (_i, t) => syl(t, 0.025, p * 1.15, p * 0.9, 1, 0.003)),
    filter: { type: 'bandpass', freq: p, q: 6, follow: true },
    gain: 0.4,
    reverb: 0.05,
  }),
  // Whale song fragment: long, slow glides with a gentle waver, far away.
  whale: (p, r) => {
    const n = count(r, 2, 3);
    const out: Syllable[] = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      const dur = 1.6 + r();
      const pick = () => p * (0.5 + 1.5 * r());
      out.push(syl(t, dur, pick(), pick(), 0.8 + 0.2 * r(), 0.4, pick()));
      t += dur + 0.4 + 0.4 * r();
    }
    return { source: 'sine', syllables: out, vibrato: { rate: 4, depth: 0.02 }, filter: { type: 'lowpass', freq: 1000, q: 0.7, follow: false }, gain: 0.45, reverb: 0.85 };
  },
  // Seal: a low moaning bark.
  seal: (p, r) => ({
    source: 'sawtooth',
    syllables: series(count(r, 1, 2), () => 0.9, (_i, t) => syl(t, 0.7, p, p * 0.9, 1, 0.08, p * 1.6)),
    filter: { type: 'lowpass', freq: 900, q: 1, follow: false },
    vibrato: { rate: 7, depth: 0.03 },
    gain: 0.4,
    reverb: 0.2,
  }),
  // A bee passing by.
  buzz: (p) => ({
    source: 'sawtooth',
    syllables: [syl(0, 1.4, p, p * 1.04, 1, 0.4)],
    vibrato: { rate: 6, depth: 0.027 },
    filter: { type: 'lowpass', freq: 900, q: 0.7, follow: false },
    gain: 0.18,
    reverb: 0,
  }),
  // One bird in a seabird colony (the murmur bed is made of many of these).
  colony: (p) => ({
    source: 'sawtooth',
    syllables: [syl(0, 0.18, p * 1.2, p * 0.85, 1, 0.01)],
    filter: { type: 'bandpass', freq: p * 2, q: 2, follow: false },
    gain: 0.3,
    reverb: 0.1,
  }),
  // Frigatebird bill clatter: a quick rattle of clicks.
  clatter: (p, r) => ({
    source: 'noise',
    syllables: series(count(r, 8, 12), () => 0.05, (_i, t) => {
      const f = p * (0.7 + 0.7 * r());
      return syl(t, 0.03, f, f, 0.7 + 0.3 * r(), 0.002);
    }),
    filter: { type: 'bandpass', freq: p, q: 3, follow: true },
    gain: 0.4,
    reverb: 0.1,
  }),
  // Duck: nasal quacks.
  quack: (p, r) => ({
    source: 'sawtooth',
    syllables: series(count(r, 2, 4), () => 0.22, (_i, t) => syl(t, 0.15, p * 1.05, p * 0.82, 1, 0.01)),
    filter: { type: 'bandpass', freq: p * 2, q: 3, follow: false },
    gain: 0.4,
    reverb: 0.1,
  }),
  // Dolphin or crab clicks.
  click: (p, r) => ({
    source: 'noise',
    syllables: series(count(r, 6, 12), () => 0.03 + r() * 0.03, (_i, t) => syl(t, 0.006, p, p, 1, 0.001)),
    filter: { type: 'bandpass', freq: p, q: 2, follow: true },
    gain: 0.5,
    reverb: 0.05,
  }),
  // Something moving through leaves or leaf litter.
  rustle: (p, r) => {
    const n = count(r, 1, 2);
    const out: Syllable[] = [];
    let t = 0;
    for (let i = 0; i < n; i++) {
      const dur = 0.4 + 0.4 * r();
      out.push(syl(t, dur, p * 0.8, p * 1.1, 1, dur * 0.45));
      t += dur + 0.1 + 0.2 * r();
    }
    return { source: 'noise', syllables: out, filter: { type: 'bandpass', freq: p, q: 0.6, follow: true }, gain: 0.25, reverb: 0 };
  },
};

/** Every voice kind (the Record above makes TypeScript insist that none is missing). */
export const VOICE_KINDS = Object.keys(RECIPES) as VoiceKind[];

/** Kinds heard as a baked chorus (a bed) rather than as single calls. */
export const BED_KINDS: readonly VoiceKind[] = ['cricket', 'cicada', 'frog-coqui', 'colony'];

export function isBedKind(kind: VoiceKind): boolean {
  return BED_KINDS.includes(kind);
}

/** The lowest and highest pitch any phrase may use (Hz): audible on a phone, below the beds' Nyquist. */
export const MIN_HZ = 40;
export const MAX_HZ = 11000;

/** A phrase for a species voice at its base pitch (Hz), with natural variation from `rand`. */
export function voicePhrase(kind: VoiceKind, pitch: number, rand: Rand): PhraseSpec {
  const spec = RECIPES[kind](pitch, rand);
  for (const s of spec.syllables) {
    s.f0 = Math.min(MAX_HZ, Math.max(MIN_HZ, s.f0));
    s.f1 = Math.min(MAX_HZ, Math.max(MIN_HZ, s.f1));
    if (s.fMid !== undefined) s.fMid = Math.min(MAX_HZ, Math.max(MIN_HZ, s.fMid));
  }
  return spec;
}

/** How long a phrase lasts (s). */
export function phraseLength(p: PhraseSpec): number {
  let end = 0;
  for (const s of p.syllables) end = Math.max(end, s.t + s.dur);
  return end;
}

/**
 * One individual calling again and again (start times in seconds, at least one phrase length
 * apart): a single phrase, so a whole night of one cricket is still one oscillator.
 */
export function repeatPhrase(p: PhraseSpec, times: readonly number[]): PhraseSpec {
  const syllables: Syllable[] = [];
  for (const at of times) for (const s of p.syllables) syllables.push({ ...s, t: s.t + at });
  return { ...p, syllables };
}
