/**
 * Arrival chimes and other pitched little sounds (WP-G), as pure note lists.
 *
 * Everything pitched sits in one key, A major pentatonic (A, B, C#, E, F#), so chimes that
 * overlap each other, the plant pops and the cooling-lava pings always sound consonant.
 * Each road has its own voice: rising glass bells for the wind, a soft falling marimba for
 * the sea, a two-glide call for wings; a new species gets a 5-note motif, and milestones,
 * ages and firsts a slow pad chord (look-and-sound §9.5). play.ts turns these into sound.
 */

/** Pitch classes of A major pentatonic (C = 0): A, B, C#, E, F#. */
export const PENTATONIC: readonly number[] = [9, 11, 1, 4, 6];

export function inScale(midi: number): boolean {
  return Number.isInteger(midi) && PENTATONIC.includes(((midi % 12) + 12) % 12);
}

export function midiHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * bell: glass bell (sine partials 1 and 2.756, long decay). marimba: soft wooden bar.
 * glide: a sliding call from `midi` to `to`. pad: a slow, warm chord tone. breath: airy noise
 * centred on the note. pop: a short woody tick.
 */
export type ChimeVoice = 'bell' | 'marimba' | 'glide' | 'pad' | 'breath' | 'pop';

export interface ChimeNote {
  /** Start (s) from the start of the chime. */
  t: number;
  midi: number;
  /** For glides: the note it slides to. */
  to?: number;
  voice: ChimeVoice;
  /** Relative level 0..1. */
  gain: number;
  /** How long the note rings (s). */
  dur: number;
}

export type ChimeKind = 'wind' | 'wave' | 'wing' | 'species' | 'milestone' | 'age' | 'first' | 'ending';

const note = (t: number, midi: number, voice: ChimeVoice, gain: number, dur: number, to?: number): ChimeNote =>
  to === undefined ? { t, midi, voice, gain, dur } : { t, midi, to, voice, gain, dur };

const pad = (midis: number[], dur: number): ChimeNote[] => midis.map((m, i) => note(i * 0.08, m, 'pad', 0.7, dur));

/** The notes of a chime. */
export function chimeNotes(kind: ChimeKind): ChimeNote[] {
  switch (kind) {
    case 'wind': // E5, F#5, A5 rising, with an airy breath around B7 (~4 kHz)
      return [note(0, 107, 'breath', 0.5, 0.6), note(0, 76, 'bell', 1, 2.4), note(0.16, 78, 'bell', 0.9, 2.4), note(0.32, 81, 'bell', 0.85, 2.6)];
    case 'wave': // A4, F#4, E4 falling on a soft marimba, and a little bubble
      return [note(0, 69, 'marimba', 1, 0.8), note(0.2, 66, 'marimba', 0.9, 0.8), note(0.4, 64, 'marimba', 0.85, 1), note(0.62, 93, 'pop', 0.4, 0.1)];
    case 'wing': // two quick glides like a bird call: C#6 to E6, then E6 to A6
      return [note(0, 85, 'glide', 1, 0.18, 88), note(0.26, 88, 'glide', 0.9, 0.22, 93)];
    case 'species': // a new species: a gentle 5-note rise
      return [note(0, 76, 'bell', 0.9, 2.2), note(0.14, 81, 'bell', 0.85, 2.2), note(0.28, 83, 'bell', 0.8, 2.2), note(0.42, 85, 'bell', 0.8, 2.4), note(0.6, 88, 'bell', 0.9, 3)];
    case 'milestone':
      return pad([57, 61, 64, 69], 5);
    case 'age':
      return pad([54, 57, 61, 64], 6);
    case 'first':
      return pad([57, 64, 71, 73], 4.5);
    case 'ending':
      return pad([45, 52, 61, 66, 71], 8);
  }
}

/** How long a chime lasts (s), including its ring. */
export function chimeLength(notes: readonly ChimeNote[]): number {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.t + n.dur);
  return end;
}

/** A plant pop's note: trees lower, shrubs in the middle, herbs and ferns higher (layer 0, 1, 2). */
export function popNote(layer: number, rand: () => number): number {
  const notes = layer === 0 ? [76, 78] : layer === 1 ? [81, 83] : [85, 88, 90];
  return notes[Math.floor(rand() * notes.length)];
}

/** A cooling-lava ping: glassy, high (E7 .. C#8, about 2.6-4.4 kHz). */
export function tinkleNote(rand: () => number): number {
  const notes = [100, 102, 105, 107, 109];
  return notes[Math.floor(rand() * notes.length)];
}
