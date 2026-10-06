/**
 * The sound system's wiring (WP-G), after look-and-sound §9.1:
 *
 *   ambience, life, weather buses -> "field" low-pass (far away from high up) -\
 *   tools bus, chimes bus ---------------------------------------------------- +-> master -> compressor -> speakers
 *   reverb send -> convolver (impulse made in code) -> reverb return ---------/
 *
 * Also the noise buffers every noisy sound starts from (white, pink, brown), made once in code,
 * and the bookkeeping that disconnects one-shot sounds when they end and counts the live nodes.
 */
import type { Scheduled } from './play';

export type BusId = 'ambience' | 'life' | 'weather' | 'tools' | 'chimes';

// ---------- noise and impulse buffers (pure fills, tested) ----------

export function fillWhite(out: Float32Array, rand: () => number): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2 - 1;
  return out;
}

/** Brown (red) noise: a leaky random walk, deep like surf and far thunder. */
export function fillBrown(out: Float32Array, rand: () => number): Float32Array {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    last = (last + 0.02 * (rand() * 2 - 1)) / 1.02;
    out[i] = last * 3.5;
  }
  return out;
}

/** Pink noise (equal energy per octave, soft like wind), Paul Kellet's economy filter. */
export function fillPink(out: Float32Array, rand: () => number): Float32Array {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    out[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return out;
}

/**
 * A reverb impulse response: decaying noise (about 60 dB over `seconds`), slightly different
 * in each ear, and growing darker toward the tail like a real outdoor space.
 */
export function fillImpulse(left: Float32Array, right: Float32Array, sampleRate: number, seconds: number, rand: () => number): void {
  const n = left.length;
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const decay = Math.exp((-6.9 * t) / seconds);
    // One-pole low-pass whose cut-off falls along the tail.
    const k = 0.9 - 0.75 * (i / n);
    lpL += k * (rand() * 2 - 1 - lpL);
    lpR += k * (rand() * 2 - 1 - lpR);
    const fadeIn = Math.min(1, i / (sampleRate * 0.004));
    left[i] = lpL * decay * fadeIn;
    right[i] = lpR * decay * fadeIn;
  }
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number, fill: (out: Float32Array, rand: () => number) => Float32Array, rand: () => number): AudioBuffer {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  fill(b.getChannelData(0), rand);
  return b;
}

/** White, pink and brown noise buffers for a context. */
export function makeNoises(ctx: BaseAudioContext, seconds: number, rand: () => number): { white: AudioBuffer; pink: AudioBuffer; brown: AudioBuffer } {
  return { white: noiseBuffer(ctx, seconds, fillWhite, rand), pink: noiseBuffer(ctx, seconds, fillPink, rand), brown: noiseBuffer(ctx, seconds, fillBrown, rand) };
}

// ---------- the graph ----------

export class AudioGraph {
  readonly master: GainNode;
  readonly field: BiquadFilterNode;
  readonly bus: Record<BusId, GainNode>;
  /** Everything sent here comes back as reverb. */
  readonly reverb: GainNode;
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  /** Nodes belonging to one-shot sounds that are still playing. */
  live = 0;

  constructor(
    readonly ctx: AudioContext,
    reverbSeconds: number,
    rand: () => number,
  ) {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    comp.knee.value = 6;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    this.master.connect(comp).connect(ctx.destination);

    this.field = ctx.createBiquadFilter();
    this.field.type = 'lowpass';
    this.field.frequency.value = 16000;
    this.field.Q.value = 0.5;
    this.field.connect(this.master);

    const bus = (to: AudioNode) => {
      const g = ctx.createGain();
      g.connect(to);
      return g;
    };
    this.bus = { ambience: bus(this.field), life: bus(this.field), weather: bus(this.field), tools: bus(this.master), chimes: bus(this.master) };

    const ir = ctx.createBuffer(2, Math.floor(ctx.sampleRate * reverbSeconds), ctx.sampleRate);
    fillImpulse(ir.getChannelData(0), ir.getChannelData(1), ctx.sampleRate, reverbSeconds, rand);
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = ir;
    const ret = ctx.createGain();
    ret.gain.value = 0.55;
    this.reverb = ctx.createGain();
    this.reverb.connect(conv).connect(ret).connect(this.master);

    const n = makeNoises(ctx, 2, rand);
    this.white = n.white;
    this.pink = n.pink;
    this.brown = n.brown;
  }

  /**
   * Send a scheduled sound into a bus at a stereo position (-1..1) with some reverb, and
   * disconnect all of its nodes when it has finished.
   */
  route(s: Scheduled, bus: BusId, pan: number, reverb: number): void {
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    s.out.connect(p).connect(this.bus[bus]);
    s.nodes.push(p);
    if (reverb > 0) {
      const g = this.ctx.createGain();
      g.gain.value = reverb;
      s.out.connect(g).connect(this.reverb);
      s.nodes.push(g);
    }
    const nodes = s.nodes;
    this.live += nodes.length;
    s.src.onended = () => {
      for (const node of nodes) node.disconnect();
      this.live -= nodes.length;
    };
  }
}
