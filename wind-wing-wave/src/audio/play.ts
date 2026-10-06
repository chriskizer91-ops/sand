/**
 * Turning phrases, chimes and thunder into WebAudio nodes (WP-G).
 *
 * Each player builds a few nodes, schedules every change ahead of time with AudioParam
 * automation, starts and stops its sources, and returns them so the caller can route the
 * sound (bus, stereo position, reverb) and let it clean up after itself. They work on any
 * BaseAudioContext, so the same code renders the baked choruses offline (beds.ts).
 */
import { midiHz, type ChimeNote } from './chimes';
import { phraseLength, type PhraseSpec } from './voices';

/** A sound scheduled to play: its output, every node it made, and the source that ends last. */
export interface Scheduled {
  out: GainNode;
  nodes: AudioNode[];
  src: AudioScheduledSourceNode;
  end: number;
}

/** Quietest level used as "silent" in exponential fades (WebAudio cannot fade exactly to zero). */
const QUIET = 0.0001;

/**
 * Schedule a phrase at `when` (context time, s) at `level` (linear). `noise` feeds noise voices;
 * `offset` (s) picks where in the noise buffer it starts, so repeated calls never sound identical.
 */
export function schedulePhrase(ctx: BaseAudioContext, p: PhraseSpec, when: number, level: number, noise: AudioBuffer, offset: number): Scheduled {
  const end = when + phraseLength(p) + 0.05;
  const env = ctx.createGain();
  env.gain.value = 0;
  const nodes: AudioNode[] = [env];
  let src: AudioScheduledSourceNode;
  let head: AudioNode;
  let pitch: AudioParam | null = null;
  if (p.source === 'noise') {
    const b = ctx.createBufferSource();
    b.buffer = noise;
    b.loop = true;
    b.start(when, offset % Math.max(0.01, noise.duration - 0.1));
    src = b;
    head = b;
  } else {
    const o = ctx.createOscillator();
    o.type = p.source;
    o.frequency.value = p.syllables[0].f0;
    o.start(when);
    src = o;
    head = o;
    pitch = o.frequency;
  }
  src.stop(end);
  nodes.push(src);

  if (p.filter) {
    const f = ctx.createBiquadFilter();
    f.type = p.filter.type;
    f.frequency.value = p.filter.freq;
    f.Q.value = p.filter.q;
    head.connect(f);
    head = f;
    nodes.push(f);
    if (p.filter.follow) pitch = f.frequency;
  }
  if (p.am) {
    // Flutter: a gain swinging around 1 - depth/2 by +-depth/2, before the envelope.
    const amp = ctx.createGain();
    amp.gain.value = 1 - p.am.depth / 2;
    const lfo = ctx.createOscillator();
    lfo.type = p.am.square ? 'square' : 'sine';
    lfo.frequency.value = p.am.rate;
    const depth = ctx.createGain();
    depth.gain.value = p.am.depth / 2;
    lfo.connect(depth).connect(amp.gain);
    lfo.start(when);
    lfo.stop(end);
    head.connect(amp);
    head = amp;
    nodes.push(amp, lfo, depth);
  }
  head.connect(env);

  if (p.source !== 'noise' && (p.fm || p.vibrato)) {
    const carrier = (src as OscillatorNode).frequency;
    if (p.fm) {
      const mod = ctx.createOscillator();
      const dev = ctx.createGain();
      dev.gain.value = p.fm.depth;
      mod.connect(dev).connect(carrier);
      for (const s of p.syllables) {
        mod.frequency.setValueAtTime(s.f0 * p.fm.ratio, when + s.t);
        mod.frequency.exponentialRampToValueAtTime(s.f1 * p.fm.ratio, when + s.t + s.dur);
      }
      mod.start(when);
      mod.stop(end);
      nodes.push(mod, dev);
    }
    if (p.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = p.vibrato.rate;
      const dev = ctx.createGain();
      dev.gain.value = p.vibrato.depth * p.syllables[0].f0;
      lfo.connect(dev).connect(carrier);
      lfo.start(when);
      lfo.stop(end);
      nodes.push(lfo, dev);
    }
  }

  const peakScale = level * p.gain;
  for (const s of p.syllables) {
    const t0 = when + s.t;
    const t1 = t0 + s.dur;
    if (pitch) {
      pitch.setValueAtTime(s.f0, t0);
      if (s.fMid !== undefined) {
        pitch.exponentialRampToValueAtTime(s.fMid, t0 + s.dur / 2);
        pitch.exponentialRampToValueAtTime(s.f1, t1);
      } else if (s.f1 !== s.f0) pitch.exponentialRampToValueAtTime(s.f1, t1);
    }
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(Math.max(QUIET * 2, s.peak * peakScale), t0 + s.attack);
    env.gain.exponentialRampToValueAtTime(QUIET, t1);
  }
  return { out: env, nodes, src, end };
}

/** Partials of the bell and marimba voices: [ratio, level, decay seconds]. */
const BELL: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [2.756, 0.3, 0.42],
];
const MARIMBA: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [4, 0.25, 0.17],
];

/** Schedule a chime (notes from chimes.ts) at `when`, at `level`. */
export function scheduleChime(ctx: BaseAudioContext, notes: readonly ChimeNote[], when: number, level: number, noise: AudioBuffer): Scheduled {
  const out = ctx.createGain();
  out.gain.value = level;
  const nodes: AudioNode[] = [out];
  // The source that stops last carries the clean-up for the whole chime.
  const latest: { src: AudioScheduledSourceNode | null; end: number } = { src: null, end: when };
  let padFilter: BiquadFilterNode | null = null;
  const track = (s: AudioScheduledSourceNode, end: number) => {
    s.stop(end);
    if (end >= latest.end) {
      latest.end = end;
      latest.src = s;
    }
  };
  const tone = (type: OscillatorType, hz: number, t0: number, gain: number, attack: number, decay: number, dest: AudioNode) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(QUIET, t0 + attack + decay);
    o.connect(g).connect(dest);
    o.start(t0);
    track(o, t0 + attack + decay + 0.05);
    nodes.push(o, g);
    return o;
  };
  for (const n of notes) {
    const t0 = when + n.t;
    const hz = midiHz(n.midi);
    if (n.voice === 'bell' || n.voice === 'marimba') {
      const parts = n.voice === 'bell' ? BELL : MARIMBA;
      for (const [ratio, g, decay] of parts) tone('sine', hz * ratio, t0, n.gain * g * 0.5, 0.004, n.dur * decay, out);
    } else if (n.voice === 'glide') {
      const o = tone('sine', hz, t0, n.gain * 0.45, 0.02, n.dur + 0.6, out);
      o.frequency.setValueAtTime(hz, t0);
      o.frequency.exponentialRampToValueAtTime(midiHz(n.to ?? n.midi), t0 + n.dur);
    } else if (n.voice === 'pop') {
      const o = tone('triangle', hz, t0, n.gain * 0.4, 0.003, n.dur, out);
      o.frequency.setValueAtTime(hz, t0);
      o.frequency.exponentialRampToValueAtTime(hz * 0.85, t0 + n.dur);
    } else if (n.voice === 'pad') {
      // A slow swell: two slightly detuned soft tones per note through one warm low-pass.
      if (!padFilter) {
        padFilter = ctx.createBiquadFilter();
        padFilter.type = 'lowpass';
        padFilter.frequency.value = 1500;
        padFilter.connect(out);
        nodes.push(padFilter);
      }
      for (const cents of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = hz * Math.pow(2, cents / 1200);
        const g = ctx.createGain();
        const swell = Math.min(2.5, n.dur * 0.45);
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(n.gain * 0.12, t0 + swell);
        g.gain.setTargetAtTime(0, t0 + swell + 0.4, (n.dur - swell) / 4);
        o.connect(g).connect(padFilter);
        o.start(t0);
        track(o, t0 + n.dur + 0.5);
        nodes.push(o, g);
      }
    } else {
      // Breath: airy noise around the note.
      const b = ctx.createBufferSource();
      b.buffer = noise;
      b.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = hz;
      f.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(n.gain * 0.25, t0 + n.dur * 0.4);
      g.gain.linearRampToValueAtTime(0, t0 + n.dur);
      b.connect(f).connect(g).connect(out);
      b.start(t0, (n.midi % 7) * 0.13);
      track(b, t0 + n.dur + 0.05);
      nodes.push(b, f, g);
    }
  }
  if (!latest.src) throw new Error('A chime needs at least one note');
  return { out, nodes, src: latest.src, end: latest.end };
}

/**
 * Far thunder (look-and-sound §9.3): deep noise through a low-pass that sweeps down from 900
 * to 90 Hz, a slow attack for a distant strike, a long decay with two or three re-swells.
 */
export function scheduleThunder(ctx: BaseAudioContext, when: number, distance: number, brown: AudioBuffer, rand: () => number): Scheduled {
  const near = distance < 900;
  const src = ctx.createBufferSource();
  src.buffer = brown;
  src.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.7;
  lp.frequency.setValueAtTime(near ? 1400 : 900, when);
  lp.frequency.exponentialRampToValueAtTime(90, when + 3.5);
  const env = ctx.createGain();
  const peak = near ? 0.55 : 0.4;
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(peak, when + (near ? 0.03 : 0.4));
  let t = when + (near ? 0.03 : 0.4);
  const swells = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < swells; i++) {
    t += 0.6 + rand() * 0.9;
    env.gain.linearRampToValueAtTime(peak * (0.3 + 0.15 * rand()), t);
    t += 0.3 + rand() * 0.4;
    env.gain.linearRampToValueAtTime(peak * (0.55 - 0.12 * i), t);
  }
  env.gain.setTargetAtTime(0, t, 1.2);
  const end = t + 5;
  src.connect(lp).connect(env);
  src.start(when, rand() * 1.5);
  src.stop(end);
  return { out: env, nodes: [src, lp, env], src, end };
}
