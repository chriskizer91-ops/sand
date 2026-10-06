/**
 * Tool, lava and interface sounds as phrases (WP-G), in the same form as the animal voices
 * (voices.ts): one source, one envelope, scheduled automation. A rock clatter of a dozen
 * stones is one noise source whose filter and loudness jump from grain to grain.
 * Pure, so tests can check them; play.ts makes them audible. Recipes: look-and-sound §9.3-9.4.
 */
import { midiHz, popNote, tinkleNote } from './chimes';
import type { PhraseSpec, Syllable } from './voices';

type Rand = () => number;

/** A train of short noise grains, each at its own pitch, never overlapping. */
function grains(n: number, pitch: () => number, dur: () => number, gap: () => number, rand: Rand): Syllable[] {
  const out: Syllable[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    const d = dur();
    const f = pitch();
    out.push({ t, dur: d, f0: f, f1: f * 0.92, peak: 0.6 + 0.4 * rand(), attack: Math.min(0.003, d * 0.3) });
    t += d + gap();
  }
  return out;
}

/** Rock placed: a clatter of stones, lower and longer for bigger placements (m^3). */
export function clatterPhrase(volume: number, rand: Rand): PhraseSpec {
  const big = Math.min(1, Math.max(0, volume) / 6);
  const n = 6 + Math.floor(rand() * 4 + big * 3);
  const centre = 1500 - 900 * big;
  return {
    source: 'noise',
    syllables: grains(n, () => centre * (0.6 + 0.8 * rand()), () => 0.04 + 0.08 * rand(), () => 0.004 + 0.03 * rand(), rand),
    filter: { type: 'bandpass', freq: centre, q: 3, follow: true },
    gain: 0.5,
    reverb: 0.05,
  };
}

/** A rock landing: a low thud, deeper for bigger rocks. */
export function thudPhrase(volume: number): PhraseSpec {
  const big = Math.min(1, Math.max(0, volume) / 6);
  const f = 85 - 25 * big;
  return { source: 'sine', syllables: [{ t: 0, dur: 0.2 + 0.1 * big, f0: f, f1: f * 0.75, peak: 1, attack: 0.004 }], gain: 0.6, reverb: 0 };
}

/** Smoothing with the hands: soft rubbing. */
export function rubPhrase(rand: Rand): PhraseSpec {
  return {
    source: 'noise',
    syllables: grains(2 + Math.floor(rand() * 2), () => 900 + 500 * rand(), () => 0.08 + 0.04 * rand(), () => 0.02 + 0.03 * rand(), rand),
    filter: { type: 'bandpass', freq: 1100, q: 0.8, follow: true },
    gain: 0.25,
    reverb: 0,
  };
}

/** Scooping: a crunch of grains. */
export function scoopPhrase(rand: Rand): PhraseSpec {
  return {
    source: 'noise',
    syllables: grains(3 + Math.floor(rand() * 3), () => 700 + 800 * rand(), () => 0.02 + 0.03 * rand(), () => 0.006 + 0.02 * rand(), rand),
    filter: { type: 'bandpass', freq: 1000, q: 1.2, follow: true },
    gain: 0.4,
    reverb: 0,
  };
}

/** Steam: a sharp hiss as lava meets the sea. */
export function steamHissPhrase(rand: Rand): PhraseSpec {
  const dur = 0.08 + 0.12 * rand();
  return {
    source: 'noise',
    syllables: [{ t: 0, dur, f0: 4500, f1: 4000, peak: 1, attack: 0.005 }],
    filter: { type: 'highpass', freq: 4000, q: 0.7, follow: false },
    gain: 0.3,
    reverb: 0.05,
  };
}

/** A bubble bursting in the hot water: a quick upward chirp. */
export function bubblePhrase(rand: Rand): PhraseSpec {
  const k = 0.8 + 0.4 * rand();
  return { source: 'sine', syllables: [{ t: 0, dur: 0.03, f0: 300 * k, f1: 900 * k, peak: 1, attack: 0.002 }], gain: 0.3, reverb: 0 };
}

/** Lava crusting over: a glassy little ping (cooling lava really tinkles). */
export function tinklePhrase(rand: Rand): PhraseSpec {
  const f = midiHz(tinkleNote(rand));
  return { source: 'sine', syllables: [{ t: 0, dur: 0.08, f0: f, f1: f, peak: 1, attack: 0.001 }], gain: 0.12, reverb: 0.3 };
}

/** A plant popping up: a soft woody tick in key, lower for trees (layer 0) than for herbs (2). */
export function popPhrase(layer: number, rand: Rand): PhraseSpec {
  const f = midiHz(popNote(layer, rand));
  return { source: 'triangle', syllables: [{ t: 0, dur: 0.07, f0: f, f1: f * 0.85, peak: 1, attack: 0.003 }], gain: 0.22, reverb: 0.15 };
}

/** Lava burning plants: a short fizzing crackle. */
export function burnPhrase(rand: Rand): PhraseSpec {
  return {
    source: 'noise',
    syllables: grains(6 + Math.floor(rand() * 5), () => 1800 + 2200 * rand(), () => 0.004 + 0.008 * rand(), () => 0.015 + 0.035 * rand(), rand),
    filter: { type: 'bandpass', freq: 2500, q: 2, follow: true },
    gain: 0.35,
    reverb: 0,
  };
}

/** Interface tap: a tiny wooden click. */
export function clickPhrase(): PhraseSpec {
  return {
    source: 'noise',
    syllables: [{ t: 0, dur: 0.025, f0: 2400, f1: 2200, peak: 1, attack: 0.001 }],
    filter: { type: 'bandpass', freq: 2400, q: 3, follow: true },
    gain: 0.5,
    reverb: 0,
  };
}

/** Journal page turn: a soft paper swish. */
export function pagePhrase(): PhraseSpec {
  return {
    source: 'noise',
    syllables: [{ t: 0, dur: 0.28, f0: 1200, f1: 3500, peak: 1, attack: 0.1 }],
    filter: { type: 'bandpass', freq: 2000, q: 0.9, follow: true },
    gain: 0.35,
    reverb: 0,
  };
}
