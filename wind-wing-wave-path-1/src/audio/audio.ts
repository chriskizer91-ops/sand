/**
 * All sound (WP-G): the soundscape, animal voices, arrival chimes, tool and lava sounds,
 * storms. Everything is synthesised in code with WebAudio; nothing is loaded.
 *
 * The soundscape is the scoreboard you hear. A new island has only wind over bare rock
 * (whistling in the cracks), surf and the hiss of lava. As life arrives the wind softens into
 * leaves, insects start by day and crickets by night, frogs call after dark, seabird colonies
 * murmur on their cliffs and each species near the camera sings its own call at its own time
 * of day. From high up it all fades to a faint hum under a wide, airy wind.
 *
 * How it stays light on a phone (look-and-sound §9.1):
 * - continuous sounds are at most 10 looping layers (layers.ts), each started only while audible;
 * - dense choruses are baked once into loops (beds.ts), so a chorus costs one playing sound;
 * - calls are phrases: one source with scheduled automation (voices.ts, play.ts);
 * - at most 12 new sounds a second and 6 bird phrases at once, and every live node is counted
 *   (graph, layers and one-shots): new calls give way at 70 nodes, nothing passes 90;
 * - the control work runs 15 times a second, the census of the surroundings twice a second;
 * - the audio context is suspended while the game is hidden or the sound is off.
 */
import { NP, type ToolId } from '../config';
import { Habitat, roadFamily, type SpeciesDef, type VoiceKind, type VoiceSpec } from '../content/speciesTypes';
import { mulberry32 } from '../engine/noise';
import { PLANT_BYTES, type ArrivalEvent, type FromEngine } from '../engine/protocol';
import type { FrameCtx, PageSystem, SystemDeps } from '../render/shared';
import { weatherOf } from '../render/weather';
import { BedStore } from './beds';
import { habitatPresence, makeCensus, patchX, patchZ, popsNear, SAMPLES, takeCensus } from './census';
import { chimeNotes, type ChimeKind } from './chimes';
import { AudioGraph, nodeRoom, routeNodes, type BusId } from './graph';
import { Layer, layerNodes, ON_LEVEL, type LayerDef } from './layers';
import * as mix from './mix';
import { chimeNodes, phraseNodes, scheduleChime, schedulePhrase, scheduleThunder, THUNDER_NODES, type Scheduled } from './play';
import * as sfx from './sfx';
import { isBedKind, voicePhrase, type PhraseSpec } from './voices';

export interface AudioSystem extends PageSystem {
  /** Call from a user gesture (browsers only allow sound after one). */
  start(): void;
  setEnabled(on: boolean): void;
  /** UI tap sound. */
  click(): void;
  /** A soft page-turn for the journal. */
  page(): void;
}

// ---------- limits and rates ----------

const CONTROL_DT = 1 / 15;
const CENSUS_DT = 0.5;
const MAX_LOOPS = 10;
const MAX_BIRDS = 6;
const VOICES_PER_SECOND = 12;
/** Plants popping up further than this from the listener make no sound (m). */
const POP_RADIUS = 120;
const POP_QUEUE = 8;
const CHIME_QUEUE = 6;

// ---------- the layers ----------

type LayerId =
  | 'wind'
  | 'whistle'
  | 'rustle'
  | 'surf'
  | 'surfRock'
  | 'stormSurf'
  | 'air'
  | 'rain'
  | 'rainLeaves'
  | 'cicadas'
  | 'crickets'
  | 'frogs'
  | 'colony'
  | 'lavaHiss'
  | 'lavaCrackle'
  | 'lavaRumble'
  | 'steam'
  | 'sand';

const LAYERS: Record<LayerId, LayerDef> = {
  // Wind over the land: soft pink noise whose low-pass opens with gusts and storms.
  wind: { bus: 'ambience', source: 'pink', filters: [{ type: 'lowpass', freq: 500, q: 0.8 }], prio: 6, tau: 0.6 },
  // Whistles through cracks in bare rock: a narrow, wandering band.
  whistle: { bus: 'ambience', source: 'white', filters: [{ type: 'bandpass', freq: 1150, q: 8 }], prio: 2, tau: 0.8 },
  // Leaves rustling.
  rustle: { bus: 'ambience', source: 'white', filters: [{ type: 'bandpass', freq: 2500, q: 0.6 }], prio: 3, tau: 0.6 },
  // Surf on sand and on rock: baked waves through a low-pass that wanders, so passes differ.
  surf: { bus: 'ambience', source: 'surf', filters: [{ type: 'lowpass', freq: 5000, q: 0.5 }], pan: true, prio: 6, tau: 1 },
  surfRock: { bus: 'ambience', source: 'surfRock', filters: [{ type: 'lowpass', freq: 5000, q: 0.5 }], pan: true, prio: 5, tau: 1 },
  // Storm surf: deep rumbling waves whose low-pass opens with each breaker.
  stormSurf: { bus: 'weather', source: 'brown', filters: [{ type: 'lowpass', freq: 600, q: 0.7 }], prio: 7, tau: 0.8 },
  // High-altitude air at the god view.
  air: { bus: 'ambience', source: 'pink', filters: [{ type: 'lowpass', freq: 600, q: 0.5 }], prio: 4, tau: 1.2 },
  rain: { bus: 'weather', source: 'white', filters: [{ type: 'highpass', freq: 1000, q: 0.5 }, { type: 'lowpass', freq: 9000, q: 0.5 }], prio: 8, tau: 1 },
  rainLeaves: { bus: 'weather', source: 'rainLeaves', prio: 5, tau: 1 },
  cicadas: { bus: 'life', source: 'cicadas', prio: 3, tau: 2 },
  crickets: { bus: 'life', source: 'crickets', prio: 3, tau: 2 },
  frogs: { bus: 'life', source: 'coqui', prio: 3, tau: 2 },
  colony: { bus: 'life', source: 'colony', pan: true, prio: 4, tau: 1.5 },
  lavaHiss: { bus: 'tools', source: 'white', filters: [{ type: 'highpass', freq: 3000, q: 0.5 }, { type: 'bandpass', freq: 5000, q: 0.5 }], pan: true, prio: 9, tau: 0.25 },
  lavaCrackle: { bus: 'tools', source: 'crackle', pan: true, prio: 9, tau: 0.25 },
  lavaRumble: { bus: 'tools', source: 'brown', filters: [{ type: 'lowpass', freq: 160, q: 0.9 }], am: { rate: 4.5, depth: 0.6 }, pan: true, prio: 10, tau: 0.12 },
  steam: { bus: 'tools', source: 'white', filters: [{ type: 'bandpass', freq: 1500, q: 0.7 }], pan: true, prio: 9, tau: 0.2 },
  sand: { bus: 'tools', source: 'white', filters: [{ type: 'bandpass', freq: 3000, q: 0.8 }], pan: true, prio: 9, tau: 0.08 },
};

/** Chorus kinds heard as beds, in the order of the abundance array. */
const CHORUS_KINDS: readonly VoiceKind[] = ['cricket', 'cicada', 'frog-coqui', 'colony'];
const CRICKET = 0;
const CICADA = 1;
const COQUI = 2;
const COLONY = 3;

/** A species that calls in single phrases. */
interface Caller {
  sp: SpeciesDef;
  voice: VoiceSpec;
}

export function createAudio(deps: SystemDeps): AudioSystem {
  const { fields, u, species, prefs, quality } = deps;
  const rand = mulberry32(0xa0d10);
  const beds = new BedStore();
  let graph: AudioGraph | null = null;
  let started = false;
  let enabled = prefs.sound;
  let seenPrefSound = prefs.sound;
  let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  let sentVolume = -1;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;

  const layers = {} as Record<LayerId, Layer>;
  for (const id of Object.keys(LAYERS) as LayerId[]) layers[id] = new Layer(LAYERS[id]);
  const byPrio = Object.values(layers).sort((a, b) => b.def.prio - a.def.prio);

  // ----- who can call -----
  const callers: Caller[] = [];
  const chorusSpecies: SpeciesDef[][] = CHORUS_KINDS.map(() => []);
  let whalePitch = 0;
  for (const sp of species) {
    const v = sp.voice;
    if (!v) continue;
    if (v.kind === 'whale') whalePitch = v.pitch;
    else if (isBedKind(v.kind)) chorusSpecies[CHORUS_KINDS.indexOf(v.kind)].push(sp);
    else callers.push({ sp, voice: v });
  }
  const presence = new Float32Array(callers.length);
  const abundance = new Float32Array(CHORUS_KINDS.length);
  const popN = new Float32Array(species.length);
  const census = makeCensus();
  let whaleNear = false;
  let colonyLevel = 0;
  let colonyX = 0;
  let colonyZ = 0;

  // ----- events from the engine, gathered between control ticks -----
  let pourTool: ToolId | null = null;
  let pourAge = 99;
  let pourX = 0;
  let pourY = 0;
  let pourZ = 0;
  let lavaArea = 0;
  let lavaPrev = 0;
  let lavaX = 0;
  let lavaZ = 0;
  let coolRate = 0;
  let steamSum = 0;
  let steamRate = 0;
  let steamX = 0;
  let steamZ = 0;
  let slideSum = 0;
  let slideRate = 0;
  let rockAcc = 0;
  let burnAcc = 0;
  let clatterCd = 0;
  let rubCd = 0;
  let burnCd = 0;
  let chimeGap = 0;
  let popCd = 0;
  let whaleCd = 10;
  let seenStrikes = weatherOf(u).strikes;
  let budget = VOICES_PER_SECOND;
  let controlAcc = 0;
  let censusAcc = CENSUS_DT;
  const chimeQueue: { kind: ChimeKind; level: number }[] = [];
  /** Plants that popped up near the listener: x, z, layer. */
  const pops = new Float32Array(POP_QUEUE * 3);
  let popCount = 0;
  const birds: { out: GainNode; end: number }[] = [];

  // ----- plant pops: diff the plants mirror as eco rectangles arrive -----
  const prevPlants = new Uint8Array(fields.plants.length);
  let primed = false;
  let listenerX = 0;
  let listenerZ = 0;
  const onEco = (x0: number, z0: number, w: number, h: number) => {
    const plants = fields.plants;
    const listen = primed && audible();
    for (let pk = z0; pk < z0 + h; pk++) {
      for (let pi = x0; pi < x0 + w; pi++) {
        const o = (pi + pk * NP) * PLANT_BYTES;
        if (listen) {
          for (let layer = 0; layer < 3; layer++) {
            const sp = plants[o + layer * 2];
            if (sp === 0) continue;
            const grew = (plants[o + layer * 2 + 1] >> 6) > (prevPlants[o + layer * 2 + 1] >> 6);
            if (sp !== prevPlants[o + layer * 2] || grew) notePop(pi, pk, layer);
          }
        }
        for (let b = 0; b < PLANT_BYTES; b++) prevPlants[o + b] = plants[o + b];
      }
    }
  };
  fields.onEco.push(onEco);

  function notePop(pi: number, pk: number, layer: number): void {
    if (popCount >= POP_QUEUE) return;
    const p = pi + pk * NP;
    const x = patchX(p);
    const z = patchZ(p);
    if (Math.hypot(x - listenerX, z - listenerZ) > POP_RADIUS) return;
    pops[popCount * 3] = x;
    pops[popCount * 3 + 1] = z;
    pops[popCount * 3 + 2] = layer;
    popCount++;
  }

  function queueChime(kind: ChimeKind, level: number): void {
    if (audible() && chimeQueue.length < CHIME_QUEUE) chimeQueue.push({ kind, level });
  }

  /** While silent (muted, hidden, not started) nothing is saved up to burst out later. */
  function dropEvents(): void {
    steamSum = 0;
    slideSum = 0;
    rockAcc = 0;
    burnAcc = 0;
    popCount = 0;
    chimeQueue.length = 0;
    seenStrikes = weatherOf(u).strikes;
  }

  function arrivalChime(a: ArrivalEvent): void {
    const fam = roadFamily(a.road);
    if (a.ok && a.first) queueChime('species', 1);
    else queueChime(fam === 'wind' ? 'wind' : fam === 'wave' ? 'wave' : 'wing', a.ok ? 1 : 0.55);
  }

  // ----- starting, stopping, volume -----
  function audible(): boolean {
    return graph !== null && enabled && !hidden;
  }

  function ensureGraph(): void {
    if (graph || typeof window === 'undefined') return;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'balanced' });
    graph = new AudioGraph(ctx, quality.phone ? 1.0 : 1.3, rand);
    // Bake the surf first: it is the first thing anyone hears.
    beds.get('surf');
  }

  function refreshRunning(): void {
    const g = graph;
    if (!g) return;
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer);
      suspendTimer = null;
    }
    if (audible()) {
      if (g.ctx.state === 'suspended') void g.ctx.resume();
    } else {
      // Fade out, then suspend so a hidden or muted game costs no audio work at all.
      g.master.gain.setTargetAtTime(0, g.ctx.currentTime, 0.05);
      sentVolume = 0;
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        if (!audible()) void g.ctx.suspend();
      }, 400);
    }
  }

  const onVisibility = () => {
    hidden = document.visibilityState === 'hidden';
    refreshRunning();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  function setEnabled(on: boolean): void {
    enabled = on;
    seenPrefSound = prefs.sound;
    if (on && started) ensureGraph();
    refreshRunning();
  }

  // ----- helpers -----
  /** Stereo position (-1..1) of a world point, from where the camera looks. */
  function panOf(f: FrameCtx, x: number, z: number): number {
    const vx = x - f.camera.position.x;
    const vz = z - f.camera.position.z;
    const len = Math.hypot(vx, vz);
    if (len < 1) return 0;
    return (0.85 * (vx * Math.cos(f.cam.yaw) - vz * Math.sin(f.cam.yaw))) / len;
  }

  function camDistTo(f: FrameCtx, x: number, y: number, z: number): number {
    const c = f.camera.position;
    return Math.hypot(x - c.x, y - c.y, z - c.z);
  }

  /** Nodes a phrase costs once routed with this share of its reverb. */
  function phraseCost(spec: PhraseSpec, reverb: number): number {
    return phraseNodes(spec) + routeNodes(reverb * spec.reverb);
  }

  /** A new one-shot of `cost` nodes may start: within 12 a second, and below the soft node cap. */
  function takeVoice(cost: number): boolean {
    if (budget < 1 || !graph || !nodeRoom(graph.live, cost, false)) return false;
    budget -= 1;
    return true;
  }

  /** Play a phrase now; `reverb` scales the phrase's own reverb share. Nothing passes the hard node cap. */
  function play(spec: PhraseSpec, bus: BusId, level: number, pan: number, reverb: number, delay = 0.02): Scheduled | null {
    const g = graph;
    if (!g || level <= 0 || !nodeRoom(g.live, phraseCost(spec, reverb), true)) return null;
    const s = schedulePhrase(g.ctx, spec, g.ctx.currentTime + delay, level, g.white, rand() * 1.5);
    g.route(s, bus, pan, reverb * spec.reverb);
    return s;
  }

  /** A species calls from one of the places it lives near the listener. */
  function call(f: FrameCtx, c: Caller, lifeAlt: number): void {
    const where = c.sp.animal?.where;
    let x = listenerX + (rand() - 0.5) * 80;
    let z = listenerZ + (rand() - 0.5) * 80;
    if (where && where.length) {
      let total = 0;
      for (const h of where) total += Math.min(SAMPLES, census.habCount[h]);
      if (total > 0) {
        let k = Math.floor(rand() * total);
        for (const h of where) {
          const n = Math.min(SAMPLES, census.habCount[h]);
          if (k < n) {
            const p = census.habSample[h * SAMPLES + k];
            x = patchX(p) + (rand() - 0.5) * 4;
            z = patchZ(p) + (rand() - 0.5) * 4;
            break;
          }
          k -= n;
        }
      }
    }
    const d = Math.hypot(x - listenerX, z - listenerZ);
    const level = c.voice.loud * mix.distanceGain(d) * lifeAlt * 0.9;
    if (level < 0.008) return;
    const spec = voicePhrase(c.voice.kind, c.voice.pitch * (0.96 + 0.08 * rand()), rand);
    const reverb = 0.4 + 0.6 * (d / (d + 40));
    if (!takeVoice(phraseCost(spec, reverb))) return;
    const now = graph!.ctx.currentTime;
    for (let i = birds.length - 1; i >= 0; i--) if (birds[i].end < now) birds.splice(i, 1);
    if (birds.length >= MAX_BIRDS) {
      // Too many singing: the oldest fades out to make room.
      const oldest = birds.shift()!;
      oldest.out.gain.cancelScheduledValues(now);
      oldest.out.gain.setTargetAtTime(0, now, 0.05);
    }
    const s = play(spec, 'life', level, panOf(f, x, z), reverb);
    if (s) birds.push({ out: s.out, end: s.end });
  }

  // ----- the census: what lives around the listener (twice a second) -----
  function takeStock(f: FrameCtx): void {
    takeCensus(fields, listenerX, listenerZ, census, rand);
    popsNear(f.life, listenerX, listenerZ, popN);
    for (let i = 0; i < callers.length; i++) presence[i] = popN[callers[i].sp.id] * habitatPresence(callers[i].sp.animal?.where, census);
    const landGreen = census.green * census.land;
    for (let k = 0; k < CHORUS_KINDS.length; k++) {
      const list = chorusSpecies[k];
      let a = 0;
      for (const sp of list) a += popN[sp.id] * habitatPresence(sp.animal?.where, census) * (sp.voice?.loud ?? 1) * 1.5;
      // A catalogue without a species for this chorus still gets one from the plant life.
      if (list.length === 0) {
        if (k === CRICKET) a = landGreen * 0.8;
        else if (k === CICADA) a = landGreen * 0.6;
        else if (k === COQUI) {
          const h = census.habCount;
          a = (h[Habitat.Pond] + h[Habitat.Marsh] + h[Habitat.WetForest] + h[Habitat.CloudForest]) / 40;
        }
      }
      abundance[k] = Math.min(1, a);
    }
    // Seabird colonies: the loudest one within earshot.
    colonyLevel = 0;
    for (const c of f.life?.colonies ?? []) {
      const lv = mix.colonyLevel(c.n, Math.hypot(c.x - listenerX, c.z - listenerZ) - c.r);
      if (lv > colonyLevel) {
        colonyLevel = lv;
        colonyX = c.x;
        colonyZ = c.z;
      }
    }
    colonyLevel = Math.max(colonyLevel, abundance[COLONY]);
    const snd = f.life?.sound;
    whaleNear = !!snd && snd.whales && Math.hypot(snd.x - listenerX, snd.z - listenerZ) < snd.r + 200;
  }

  // ----- the control tick (15 times a second) -----
  function control(f: FrameCtx, dt: number): void {
    const g = graph!;
    const now = g.ctx.currentTime;
    budget = Math.min(VOICES_PER_SECOND, budget + VOICES_PER_SECOND * dt);
    const ws = weatherOf(u);
    const camDist = f.cam.dist;
    const lifeAlt = mix.lifeAltitude(camDist);
    const air = mix.airAltitude(camDist);
    const phase = f.day.phase;
    const dry = u.uDry.value;
    const quiet = mix.weatherQuiet(ws.storm);
    const landGreen = census.green * census.land;
    const bareLand = census.bare * census.land;
    g.field.frequency.setTargetAtTime(mix.fieldCutoff(camDist), now, 0.3);

    const L = layers;
    // Ambience.
    const exposure = Math.min(1, bareLand + (1 - census.land) * 0.6 + air * 0.2);
    L.wind.target = mix.windLevel(exposure, ws.wind, ws.gust, ws.storm);
    L.wind.filters[0]?.frequency.setTargetAtTime(350 + 650 * ws.gust + 700 * ws.storm + 250 * air, now, 0.3);
    L.whistle.target = mix.whistleLevel(bareLand, ws.gust, census.woody) * (1 - 0.7 * air);
    L.whistle.filters[0]?.frequency.setTargetAtTime(1150 + 250 * Math.sin(f.t * 0.19) + 200 * ws.gust, now, 0.5);
    L.rustle.target = mix.rustleLevel(landGreen, ws.wind, ws.gust) * lifeAlt;
    const coast = census.shoreDist < 220 ? 1 : 0;
    const surf = (mix.surfLevel(census.shoreDist, ws.storm) * (0.35 + 0.65 * (1 - air)) + 0.03 * air * coast) * mix.surfSwell(f.t);
    L.surf.target = surf * (1 - census.shoreRock);
    L.surfRock.target = surf * census.shoreRock;
    L.surf.pan = L.surfRock.pan = 0.6 * panOf(f, census.shoreX, census.shoreZ);
    const surfCut = mix.surfCutoff(f.t, ws.storm);
    L.surf.filters[0]?.frequency.setTargetAtTime(surfCut, now, 0.5);
    L.surfRock.filters[0]?.frequency.setTargetAtTime(surfCut, now, 0.5);
    L.stormSurf.target = (0.05 * ws.storm) / (1 + census.shoreDist / 60);
    const breaker = Math.max(0, Math.sin((f.t * Math.PI * 2) / 7));
    L.stormSurf.filters[0]?.frequency.setTargetAtTime(400 + 1400 * breaker * breaker, now, 0.4);
    L.air.target = mix.airLevel(air, ws.storm) * (0.8 + 0.2 * Math.sin(f.t * 0.07));

    // Weather.
    L.rain.target = mix.rainLevel(ws.rain);
    L.rain.filters[1]?.frequency.setTargetAtTime(9000 - 5000 * (1 - census.land), now, 0.5);
    L.rainLeaves.target = mix.leafRainLevel(ws.rain, landGreen) * lifeAlt;

    // Life choruses.
    const day = mix.activity('day', phase);
    const night = mix.activity('night', phase);
    L.cicadas.target = mix.chorusLevel(abundance[CICADA], day, 0.45 + 0.55 * dry) * lifeAlt * quiet;
    L.crickets.target = mix.chorusLevel(abundance[CRICKET], night, 1) * lifeAlt * quiet;
    L.frogs.target = mix.chorusLevel(abundance[COQUI], night, 0.5 + 0.5 * (1 - dry)) * lifeAlt * quiet;
    L.colony.target = 0.4 * colonyLevel * Math.max(lifeAlt, 0.35) * (0.4 + 0.6 * day) * quiet;
    L.colony.pan = panOf(f, colonyX, colonyZ);

    // Lava, steam and the tools.
    pourAge += dt;
    const pouring = pourAge < 0.35 ? pourTool : null;
    const pourGain = mix.toolDistanceGain(camDistTo(f, pourX, pourY, pourZ));
    const lava = mix.lavaLevel(lavaArea);
    const lavaGain = mix.toolDistanceGain(camDistTo(f, lavaX, 0, lavaZ));
    const lavaPan = panOf(f, lavaX, lavaZ);
    coolRate += (Math.max(0, (lavaPrev - lavaArea) / dt) - coolRate) * (1 - Math.exp(-dt / 1.5));
    lavaPrev = lavaArea;
    L.lavaHiss.target = 0.15 * lava * lavaGain;
    L.lavaCrackle.target = 0.5 * lava * lavaGain;
    L.lavaHiss.pan = L.lavaCrackle.pan = lavaPan;
    L.lavaRumble.target = pouring === 'lava' ? 0.25 * pourGain : 0;
    L.lavaRumble.pan = panOf(f, pourX, pourZ);
    steamRate += (steamSum / dt - steamRate) * (1 - Math.exp(-dt / 0.5));
    steamSum = 0;
    const steam = Math.min(1, steamRate / 3);
    L.steam.target = 0.2 * steam * mix.toolDistanceGain(camDistTo(f, steamX, 0, steamZ));
    L.steam.pan = panOf(f, steamX, steamZ);
    slideRate += (slideSum / dt - slideRate) * (1 - Math.exp(-dt / 0.4));
    slideSum = 0;
    L.sand.target = ((pouring === 'sand' ? 0.25 : 0) + 0.15 * Math.min(1, slideRate / 10)) * pourGain;
    L.sand.pan = panOf(f, pourX, pourZ);
    L.sand.filters[0]?.frequency.setTargetAtTime(pouring === 'sand' ? 3200 : 2200, now, 0.1);

    // Run the layers: the highest priorities get the ten slots; a running layer left without
    // one fades out quickly and stops.
    let slots = MAX_LOOPS;
    for (const l of byPrio) {
      const wants = l.target > ON_LEVEL;
      if (!wants && !l.running) continue;
      l.evicted = slots <= 0;
      if (l.evicted) continue;
      slots--;
      // A new layer also keeps to the hard node cap (it tries again next tick).
      if (wants && !l.running && nodeRoom(g.live, layerNodes(l.def), true)) {
        const src = l.def.source;
        const buf = src === 'white' ? g.white : src === 'pink' ? g.pink : src === 'brown' ? g.brown : beds.get(src);
        if (buf) l.start(g, buf, rand() * 8);
      }
    }
    for (const l of byPrio) {
      if (!l.running) continue;
      l.update(now, dt);
      if (l.spent) l.stop();
    }

    // One-shots from the tools. Sounds that build up (rock, rubbing, burning) and find no room
    // wait for the next tick; chance sounds (pings, steam) are simply skipped.
    clatterCd -= dt;
    if (rockAcc > 0.02 && clatterCd <= 0) {
      const clatter = sfx.clatterPhrase(rockAcc, rand);
      const thud = sfx.thudPhrase(rockAcc);
      if (takeVoice(phraseCost(clatter, 1) + phraseCost(thud, 0))) {
        const pan = panOf(f, pourX, pourZ);
        play(clatter, 'tools', 0.8 * pourGain, pan, 1);
        play(thud, 'tools', 0.8 * pourGain, pan, 0);
        rockAcc = 0;
        clatterCd = 0.14;
      }
    }
    rubCd -= dt;
    if ((pouring === 'hands' || pouring === 'scoop') && rubCd <= 0) {
      const spec = pouring === 'hands' ? sfx.rubPhrase(rand) : sfx.scoopPhrase(rand);
      if (takeVoice(phraseCost(spec, 0))) {
        play(spec, 'tools', 0.8 * pourGain, panOf(f, pourX, pourZ), 0);
        rubCd = pouring === 'hands' ? 0.22 + 0.1 * rand() : 0.16 + 0.05 * rand();
      }
    }
    burnCd -= dt;
    if (burnAcc > 0 && burnCd <= 0) {
      const spec = sfx.burnPhrase(rand);
      if (takeVoice(phraseCost(spec, 0))) {
        play(spec, 'tools', 0.7 * lavaGain, lavaPan, 0);
        burnAcc = 0;
        burnCd = 0.5;
      }
    }
    const tinkles = mix.tinkleRate(pouring === 'lava' ? 0 : lavaArea, coolRate);
    if (rand() < 1 - Math.exp(-tinkles * dt)) {
      const spec = sfx.tinklePhrase(rand);
      if (takeVoice(phraseCost(spec, 1))) play(spec, 'tools', lavaGain, lavaPan + (rand() - 0.5) * 0.3, 1);
    }
    if (rand() < 1 - Math.exp(-2.5 * steam * dt)) {
      const spec = rand() < 0.5 ? sfx.steamHissPhrase(rand) : sfx.bubblePhrase(rand);
      if (takeVoice(phraseCost(spec, 1))) play(spec, 'tools', 0.8 * mix.toolDistanceGain(camDistTo(f, steamX, 0, steamZ)), L.steam.pan, 1);
    }

    // Animal calls, each at its own time of day, quieter in storms and from high up.
    const chorus = mix.dawnChorus(phase);
    for (let i = 0; i < callers.length; i++) {
      const pres = presence[i];
      if (pres <= 0) continue;
      const v = callers[i].voice;
      const act = mix.activity(v.when, phase) * (v.when === 'day' ? chorus : 1);
      const rate = (v.rate / 60) * pres * act * quiet * (0.25 + 0.75 * lifeAlt);
      if (rate > 0 && rand() < 1 - Math.exp(-rate * dt)) call(f, callers[i], lifeAlt);
    }
    whaleCd -= dt;
    if (whaleNear && whalePitch > 0 && camDist < 500 && whaleCd <= 0) {
      const spec = voicePhrase('whale', whalePitch, rand);
      if (takeVoice(phraseCost(spec, 1))) {
        whaleCd = 25 + 20 * rand();
        play(spec, 'life', 0.35 * Math.max(lifeAlt, 0.4), (rand() - 0.5) * 0.8, 1);
      }
    }

    // Thunder: after the flash, by the time sound takes to travel (capped at 8 s). It may use
    // the node reserve; if even that is full, this one rumble is let go.
    if (ws.strikes !== seenStrikes) {
      seenStrikes = ws.strikes;
      if (nodeRoom(g.live, THUNDER_NODES + routeNodes(0.5), true)) {
        const s = scheduleThunder(g.ctx, now + Math.min(8, ws.strikeDist / 343), ws.strikeDist, g.brown, rand);
        g.route(s, 'weather', 0.7 * panOf(f, ws.strikeX, ws.strikeZ), 0.5);
      }
    }

    // Chimes, spaced so they never pile up. They may use the node reserve, and wait their turn
    // if even that is full.
    chimeGap -= dt;
    if (chimeQueue.length > 0 && chimeGap <= 0) {
      const c = chimeQueue[0];
      const notes = chimeNotes(c.kind);
      if (nodeRoom(g.live, chimeNodes(notes) + routeNodes(0.45), true)) {
        chimeQueue.shift();
        const s = scheduleChime(g.ctx, notes, now + 0.05, 0.11 * c.level, g.white);
        g.route(s, 'chimes', 0, 0.45);
        chimeGap = c.kind === 'milestone' || c.kind === 'age' || c.kind === 'first' || c.kind === 'ending' ? 3 : 1.4;
      }
    }

    // Plant pops: soft woody ticks, at most about three a second.
    popCd -= dt;
    if (popCount > 0 && popCd <= 0) {
      const i = (popCount - 1) * 3;
      const spec = sfx.popPhrase(pops[i + 2], rand);
      if (takeVoice(phraseCost(spec, 1))) {
        popCount--;
        const x = pops[i];
        const z = pops[i + 1];
        const d = Math.hypot(x - listenerX, z - listenerZ);
        play(spec, 'life', 0.8 * mix.distanceGain(d * 0.3) * lifeAlt, panOf(f, x, z), 1);
        popCd = 0.34;
      }
    }
  }

  // A small hook for the browser checks: window.__audio.stats() reports what is playing.
  if (typeof window !== 'undefined') {
    (window as unknown as { __audio: { stats(): object } }).__audio = {
      stats: () => ({
        state: graph ? graph.ctx.state : 'none',
        layers: (Object.keys(layers) as LayerId[]).filter((id) => layers[id].running).map((id) => `${id} ${layers[id].level.toFixed(4)}`),
        // Every live node: the graph's own, the running layers' and the one-shots' (budget 70/90).
        liveNodes: graph ? graph.live : 0,
        nodes: graph ? { graph: graph.fixed, layers: graph.layerNodes, oneShots: graph.oneShots } : null,
        birds: birds.length,
        census: { land: census.land, green: census.green, bare: census.bare, shore: Math.round(census.shoreDist), rock: census.shoreRock },
      }),
    };
  }

  return {
    name: 'audio',
    start() {
      started = true;
      if (enabled) ensureGraph();
      if (audible() && graph?.ctx.state === 'suspended') void graph.ctx.resume();
    },
    setEnabled,
    click() {
      if (audible()) play(sfx.clickPhrase(), 'tools', 0.5, 0, 0, 0);
    },
    page() {
      if (audible()) play(sfx.pagePhrase(), 'tools', 0.5, 0, 0, 0);
    },
    onEngine(m: FromEngine) {
      if (m.t === 'tick') {
        const e = m.events;
        lavaArea = e.lavaArea;
        if (e.lavaArea > 0) {
          lavaX = e.lavaGlow[0];
          lavaZ = e.lavaGlow[1];
        }
        if (e.pour) {
          pourTool = e.pour.tool;
          pourX = e.pour.x;
          pourY = e.pour.y;
          pourZ = e.pour.z;
          pourAge = 0;
        }
        for (let i = 0; i + 2 < e.steam.length; i += 3) {
          steamX = e.steam[i];
          steamZ = e.steam[i + 1];
          steamSum += e.steam[i + 2];
        }
        slideSum += e.sliding;
        rockAcc += e.rockPlaced;
        burnAcc += e.burned;
        for (const a of e.arrivals) arrivalChime(a);
      } else if (m.t === 'journal') {
        if (m.reset) return;
        for (const j of m.entries) {
          if (j.kind === 'age' || j.kind === 'milestone' || j.kind === 'first' || j.kind === 'ending') queueChime(j.kind, 1);
        }
      } else if (m.t === 'ready') {
        primed = true;
      } else if (m.t === 'clear') {
        primed = false;
      }
    },
    update(f: FrameCtx) {
      if (prefs.sound !== seenPrefSound) setEnabled(prefs.sound);
      listenerX = f.cam.target.x;
      listenerZ = f.cam.target.z;
      const g = graph;
      if (!g || !audible() || g.ctx.state !== 'running') {
        dropEvents();
        return;
      }
      const vol = Math.max(0, Math.min(1, prefs.volume)) * 0.9;
      if (Math.abs(vol - sentVolume) > 0.001) {
        g.master.gain.setTargetAtTime(vol, g.ctx.currentTime, 0.15);
        sentVolume = vol;
      }
      censusAcc += f.dt;
      if (censusAcc >= CENSUS_DT) {
        censusAcc = 0;
        takeStock(f);
      }
      controlAcc += f.dt;
      if (controlAcc >= CONTROL_DT) {
        control(f, controlAcc);
        controlAcc = 0;
      }
    },
    dispose() {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      const i = fields.onEco.indexOf(onEco);
      if (i >= 0) fields.onEco.splice(i, 1);
      if (suspendTimer !== null) clearTimeout(suspendTimer);
      for (const l of byPrio) if (l.running) l.stop();
      void graph?.ctx.close();
      graph = null;
    },
  };
}
