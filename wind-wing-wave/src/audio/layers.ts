/**
 * Continuous sound layers (WP-G): wind, surf, rain, insect choruses, lava hiss and so on.
 * Each one is a looping source (a noise buffer or a baked bed), a few filters and a gain.
 * A layer only exists while it is audible: it starts when its level rises above silence and
 * stops (freeing its nodes, so the phone does no work for it) after a few silent seconds.
 */
import type { BedId } from './beds';
import type { AudioGraph, BusId } from './graph';

export interface LayerDef {
  bus: BusId;
  /** Continuous noise of one colour, or a baked bed. */
  source: 'white' | 'pink' | 'brown' | BedId;
  filters?: readonly { type: BiquadFilterType; freq: number; q: number }[];
  /** Slow amplitude throb (the glug of pouring lava). */
  am?: { rate: number; depth: number };
  /** Placed in stereo (the shore, a colony, the lava). */
  pan?: boolean;
  /** When too many layers want to play, the higher priority ones keep playing. */
  prio: number;
  /** How quickly the level follows its target (s): quick for tools, slow for weather. */
  tau: number;
}

/** Levels below this count as silent. */
export const ON_LEVEL = 0.0008;
/** A layer that has been silent this long stops. */
const QUIET_SECONDS = 2.5;

export class Layer {
  /** Level wanted now (linear), and the stereo position (-1..1). */
  target = 0;
  pan = 0;
  /** Estimate of the level actually playing (it follows the target like the WebAudio ramp). */
  level = 0;
  readonly filters: BiquadFilterNode[] = [];
  private quiet = 0;
  private sent = -1;
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private nodes: AudioNode[] = [];
  /** The looping source and any modulator: a playing source lives on until stopped. */
  private sources: AudioScheduledSourceNode[] = [];

  constructor(readonly def: LayerDef) {}

  get running(): boolean {
    return this.src !== null;
  }

  /** Silent for long enough to stop. */
  get spent(): boolean {
    return this.quiet > QUIET_SECONDS;
  }

  start(g: AudioGraph, buffer: AudioBuffer, offset: number): void {
    const ctx = g.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    this.nodes.push(src);
    let head: AudioNode = src;
    for (const f of this.def.filters ?? []) {
      const b = ctx.createBiquadFilter();
      b.type = f.type;
      b.frequency.value = f.freq;
      b.Q.value = f.q;
      head.connect(b);
      head = b;
      this.filters.push(b);
      this.nodes.push(b);
    }
    if (this.def.am) {
      const amp = ctx.createGain();
      amp.gain.value = 1 - this.def.am.depth / 2;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = this.def.am.rate;
      const depth = ctx.createGain();
      depth.gain.value = this.def.am.depth / 2;
      lfo.connect(depth).connect(amp.gain);
      lfo.start();
      this.sources.push(lfo);
      head.connect(amp);
      head = amp;
      this.nodes.push(amp, lfo, depth);
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    head.connect(gain);
    this.nodes.push(gain);
    let out: AudioNode = gain;
    if (this.def.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = this.pan;
      gain.connect(p);
      out = p;
      this.panner = p;
      this.nodes.push(p);
    }
    out.connect(g.bus[this.def.bus]);
    src.start(ctx.currentTime, offset % buffer.duration);
    this.sources.push(src);
    this.src = src;
    this.gain = gain;
    this.level = 0;
    this.quiet = 0;
    this.sent = -1;
  }

  /** Move toward the target (called ~15 times a second while running). */
  update(now: number, dt: number): void {
    if (!this.gain) return;
    // Only touch the AudioParam when the change is audible (keeps the automation queue short).
    if (Math.abs(this.target - this.sent) > 0.02 * Math.max(this.target, this.sent, ON_LEVEL)) {
      this.gain.gain.setTargetAtTime(this.target, now, this.def.tau);
      this.sent = this.target;
    }
    if (this.panner) this.panner.pan.setTargetAtTime(this.pan, now, 0.3);
    this.level += (this.target - this.level) * (1 - Math.exp(-dt / this.def.tau));
    this.quiet = this.target < ON_LEVEL && this.level < ON_LEVEL ? this.quiet + dt : 0;
  }

  stop(): void {
    for (const s of this.sources) s.stop();
    for (const n of this.nodes) n.disconnect();
    this.sources = [];
    this.nodes = [];
    this.filters.length = 0;
    this.src = null;
    this.gain = null;
    this.panner = null;
    this.level = 0;
  }
}
