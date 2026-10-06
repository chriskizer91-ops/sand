/**
 * Sounds, all synthesised in code with the Web Audio API (no sound files):
 * lapping waves, a breeze, distant gulls and rigging, and the sand itself:
 * crunchy digging, pouring hiss, soft pats, trickles when sand slumps.
 * Dry sand sounds bright and crisp; wet sand sounds low and soft.
 */
import { mulberry32 } from '../engine/noise';
import type { TickEvents } from '../engine/protocol';

export class SandAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private brown!: AudioBuffer;
  private waveGain!: GainNode;
  private waveFilter!: BiquadFilterNode;
  private pourGain!: GainNode;
  private pourFilter!: BiquadFilterNode;
  private slideGain!: GainNode;
  private rand = mulberry32(3);
  private nextGull = 8;
  private nextClink = 5;
  private grainBudget = 0;
  enabled = true;

  /** Must be called from a user gesture (tap/click). */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? 0.8 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    // Noise sources.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last * 3.5;
    }

    // Lapping waves: brown noise through a filter that opens as each wave washes in.
    this.waveFilter = ctx.createBiquadFilter();
    this.waveFilter.type = 'lowpass';
    this.waveFilter.frequency.value = 500;
    this.waveGain = ctx.createGain();
    this.waveGain.gain.value = 0.1;
    this.loop(this.brown).connect(this.waveFilter).connect(this.waveGain).connect(this.master);

    // Breeze.
    const wind = ctx.createBiquadFilter();
    wind.type = 'bandpass';
    wind.frequency.value = 700;
    wind.Q.value = 0.5;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.018;
    this.loop(this.noise).connect(wind).connect(windGain).connect(this.master);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.012;
    lfo.connect(lfoAmt).connect(windGain.gain);
    lfo.start();

    // Pouring hiss and slumping trickle (volume follows the sand).
    this.pourFilter = ctx.createBiquadFilter();
    this.pourFilter.type = 'bandpass';
    this.pourFilter.frequency.value = 3200;
    this.pourFilter.Q.value = 0.8;
    this.pourGain = ctx.createGain();
    this.pourGain.gain.value = 0;
    this.loop(this.noise).connect(this.pourFilter).connect(this.pourGain).connect(this.master);
    const slideFilter = ctx.createBiquadFilter();
    slideFilter.type = 'bandpass';
    slideFilter.frequency.value = 2200;
    slideFilter.Q.value = 0.6;
    this.slideGain = ctx.createGain();
    this.slideGain.gain.value = 0;
    this.loop(this.noise).connect(slideFilter).connect(this.slideGain).connect(this.master);
  }

  private loop(buf: AudioBuffer): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start(0, Math.random() * buf.duration);
    return src;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05);
  }

  /** A tiny burst of filtered noise: one "grain" of sand sound. */
  private grain(freq: number, q: number, amp: number, dur: number, when = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  /** Soft thump of a hand patting sand. */
  pat(wet: number): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.2);
    this.grain(700 + (1 - wet) * 900, 0.7, 0.18, 0.06);
    if (wet > 0.5) this.grain(1400, 2.5, 0.12 * wet, 0.05, 0.01); // wet slap
  }

  click(): void {
    if (!this.ctx || !this.enabled) return;
    this.grain(2400, 3, 0.12, 0.025);
  }

  private gull(): void {
    const ctx = this.ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = this.rand() * 1.6 - 0.8;
    pan.connect(this.master);
    const calls = 2 + Math.floor(this.rand() * 3);
    for (let c = 0; c < calls; c++) {
      const t = ctx.currentTime + c * 0.32 + this.rand() * 0.05;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const base = 1100 + this.rand() * 300;
      o.frequency.setValueAtTime(base * 1.35, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.75, t + 0.24);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1900;
      f.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.022, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      o.connect(f).connect(g).connect(pan);
      o.start(t);
      o.stop(t + 0.3);
    }
  }

  private clink(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    for (const [freq, amp] of [
      [2350, 0.012],
      [3870, 0.007],
    ]) {
      const o = ctx.createOscillator();
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.75);
    }
  }

  /**
   * Per frame. `lap` = how far the last wave has washed up (0..1),
   * `wet` = wetness of the sand being worked (0..1).
   */
  update(dt: number, lap: number, ev: TickEvents | null, wet: number): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.waveGain.gain.setTargetAtTime(0.05 + 0.13 * lap, now, 0.25);
    this.waveFilter.frequency.setTargetAtTime(350 + 900 * lap, now, 0.3);
    this.nextGull -= dt;
    if (this.nextGull <= 0) {
      this.gull();
      this.nextGull = 14 + this.rand() * 30;
    }
    this.nextClink -= dt;
    if (this.nextClink <= 0) {
      this.clink();
      this.nextClink = 6 + this.rand() * 14;
    }
    if (!ev) return;
    // Digging: a crunch made of many tiny grains; wetter sand is lower and softer.
    if (ev.dug > 0) {
      this.grainBudget += Math.min(6, ev.dug / 220);
      while (this.grainBudget >= 1) {
        this.grainBudget -= 1;
        const f = (wet > 0.5 ? 700 : 1800) + this.rand() * (wet > 0.5 ? 600 : 2600);
        this.grain(f, wet > 0.5 ? 1.2 : 2.2, 0.05 + this.rand() * 0.07, 0.02 + this.rand() * 0.04, this.rand() * 0.03);
      }
    }
    const pour = Math.min(1, ev.poured / 900);
    this.pourGain.gain.setTargetAtTime(pour * (wet > 0.5 ? 0.05 : 0.11), now, 0.05);
    this.pourFilter.frequency.setTargetAtTime(wet > 0.5 ? 1100 : 3400, now, 0.1);
    const slide = Math.min(1, (ev.slid + ev.landed * 0.5) / 4000);
    this.slideGain.gain.setTargetAtTime(slide * 0.07, now, 0.08);
    if (ev.rubbed > 0) this.grain(900 + this.rand() * 500, 0.8, 0.05, 0.08);
  }
}
