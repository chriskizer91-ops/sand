/**
 * The engine hub. STUB (lead): a minimal stand-in so the page can be built and tested.
 * It serves the demo chain from fixtures.ts with synthetic life, applies tools crudely,
 * and fakes storms. WP-C replaces this file with the real hub (Geo + Ecology + undo + save).
 * The message contract (protocol.ts) is what matters.
 */
import { CELL, NP, NX, NZ, SEA_LEVEL, type ToolId } from '../config';
import { SPECIES } from '../content/species';
import { Columns } from './columns';
import { buildDemoChain, demoEco, demoLife, DEMO_ISLANDS } from './fixtures';
import { PLANT_BYTES, type FromEngine, type JournalEntry, type StormState, type TickEvents, type ToEngine } from './protocol';
import { runChecks } from '../checks/registry';
import '../checks/all';

type Post = (msg: FromEngine, transfer?: Transferable[]) => void;

function emptyEvents(): TickEvents {
  return { steam: [], pour: null, lavaArea: 0, lavaGlow: [0, 0, 0, 0], sliding: 0, rockPlaced: 0, burned: 0, arrivals: [], places: [] };
}

export class Engine {
  private cols = new Columns();
  private ready = false;
  private year = 0;
  private paused = false;
  private stroke: { tool: ToolId; x: number; z: number; radius: number; strength: number } | null = null;
  private dirty: [number, number, number, number] | null = null;
  private storm: StormState = { phase: 'none', t: 0, level: 0, great: false };
  private events = emptyEvents();
  private journalId = 1;
  private pageMode = false;
  private sendAcc = 0;
  private arrivalTimer = 6;

  constructor(private post: Post) {}

  setPageMode(on: boolean): void {
    this.pageMode = on;
  }
  get isReady(): boolean {
    return this.ready;
  }

  handle(msg: ToEngine): void {
    try {
      this.handleInner(msg);
    } catch (err) {
      this.post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleInner(msg: ToEngine): void {
    switch (msg.t) {
      case 'init':
      case 'reset':
        this.build();
        return;
      case 'stroke':
        if (msg.phase === 'end' || msg.phase === 'cancel') this.stroke = null;
        else this.stroke = { tool: msg.tool, x: msg.x, z: msg.z, radius: msg.radius, strength: msg.strength };
        return;
      case 'pause':
        this.paused = msg.on;
        return;
      case 'inspect':
        this.post({
          t: 'inspected',
          id: msg.id,
          info: {
            x: msg.x,
            z: msg.z,
            island: 1,
            islandName: 'High Island',
            height: this.cols.heightAt(msg.x, msg.z),
            depth: Math.max(0, SEA_LEVEL - this.cols.heightAt(msg.x, msg.z)),
            substrate: 1,
            groundAge: 300,
            rain: 0.5,
            moist: 0.5,
            salt: 0.2,
            soil: 0.2,
            windward: 0.5,
            habitat: 15,
            layers: { canopy: -1, shrub: -1, herb: -1, ground: -1 },
          },
        });
        return;
      case 'save':
        this.post({ t: 'saved', id: msg.id, data: new ArrayBuffer(8) });
        return;
      case 'load':
        this.post({ t: 'loaded', id: msg.id, ok: false, error: 'Saving is not built yet (stub engine).' });
        return;
      case 'checks':
        void runChecks({ quick: msg.quick }).then((results) => this.post({ t: 'checks', id: msg.id, results }));
        return;
      case 'debug':
        if (msg.op === 'stormNow') this.storm = { phase: 'warning', t: 0, level: 0, great: true };
        if (msg.op === 'advanceYears') this.year += msg.arg ?? 100;
        if (msg.op === 'demoChain') this.build();
        this.post({ t: 'debugResult', id: msg.id, data: { ok: true, year: this.year } });
        return;
      default:
        return;
    }
  }

  private build(): void {
    buildDemoChain(this.cols, 1);
    this.post({ t: 'clear' });
    this.sendCols(0, 0, NX, NZ);
    this.sendEco();
    this.post({ t: 'life', life: demoLife(this.cols, SPECIES) });
    const e: JournalEntry = { id: this.journalId++, year: 0, kind: 'first-land', headline: true, island: 1, x: DEMO_ISLANDS[0].x, z: DEMO_ISLANDS[0].z };
    this.post({ t: 'journal', entries: [e], reset: true });
    this.ready = true;
    this.post({ t: 'ready', resumed: false, year: this.year, firstLand: true, glow: { x: DEMO_ISLANDS[0].x, z: DEMO_ISLANDS[0].z } });
  }

  private sendCols(x0: number, z0: number, w: number, h: number): void {
    // Send in row bands so messages stay small.
    for (let z = z0; z < z0 + h; z += 64) {
      const hh = Math.min(64, z0 + h - z);
      const surf = new Float32Array(w * hh);
      const ground = new Uint8Array(w * hh * 4);
      this.cols.packRect(x0, z, w, hh, surf, ground);
      this.post({ t: 'cols', x0, z0: z, w, h: hh, surf, ground }, [surf.buffer, ground.buffer]);
    }
  }

  private sendEco(): void {
    const n = NP * NP;
    const out = { a: new Uint8Array(n * 4), b: new Uint8Array(n * 4), c: new Uint8Array(n * 4), plants: new Uint8Array(n * PLANT_BYTES), habitat: new Uint8Array(n) };
    demoEco(this.cols, SPECIES, out, 1);
    this.post({ t: 'eco', x0: 0, z0: 0, w: NP, h: NP, ...out }, [out.a.buffer, out.b.buffer, out.c.buffer, out.plants.buffer, out.habitat.buffer]);
  }

  tick(dt: number, budgetMs: number): void {
    void budgetMs;
    if (!this.ready) return;
    dt = Math.min(dt, 0.25);
    if (!this.paused) this.year += dt * 2;
    // Crude tools: raise/lower columns under the brush.
    const s = this.stroke;
    if (s && s.tool !== 'look') {
      const r = s.radius;
      const i0 = Math.max(0, Math.floor((s.x - r - this.cols.cx(0)) / CELL));
      const k0 = Math.max(0, Math.floor((s.z - r - this.cols.cz(0)) / CELL));
      const i1 = Math.min(NX - 1, i0 + Math.ceil((2 * r) / CELL) + 1);
      const k1 = Math.min(NZ - 1, k0 + Math.ceil((2 * r) / CELL) + 1);
      const rate = s.tool === 'scoop' ? -3 : s.tool === 'hands' ? 0 : 3;
      for (let k = k0; k <= k1; k++) {
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(this.cols.cx(i) - s.x, this.cols.cz(k) - s.z) / r;
          if (d >= 1) continue;
          const w = (1 - d * d) * (1 - d * d);
          const c = i + k * NX;
          if (s.tool === 'lava') {
            this.cols.lava[c] += rate * w * dt;
            this.cols.temp[c] = 1;
          } else if (s.tool === 'sand') this.cols.sed[c] += rate * w * dt;
          else this.cols.rock[c] += rate * w * dt;
        }
      }
      this.markDirty(i0, k0, i1, k1);
      this.events.pour = { tool: s.tool, x: s.x, y: this.cols.heightAt(s.x, s.z), z: s.z, r };
    }
    // Lava in the stub just cools in place.
    let lavaArea = 0;
    for (let c = 0; c < this.cols.n; c++) {
      if (this.cols.lava[c] <= 0) continue;
      lavaArea += CELL * CELL;
      this.cols.temp[c] -= dt / 12;
      if (this.cols.temp[c] < 0.3) {
        this.cols.rock[c] += this.cols.lava[c];
        this.cols.lava[c] = 0;
        this.cols.temp[c] = 0;
      }
      const i = c % NX;
      const k = (c / NX) | 0;
      this.markDirty(i, k, i, k);
    }
    this.events.lavaArea = lavaArea;
    // Fake storm cycle.
    if (this.storm.phase !== 'none') {
      this.storm.t += dt;
      const p = this.storm.phase;
      if (p === 'warning') {
        this.storm.level = Math.min(1, this.storm.t / 40) * 0.6;
        if (this.storm.t > 40) this.storm = { phase: 'peak', t: 0, level: 1, great: this.storm.great };
      } else if (p === 'peak') {
        this.storm.level = 1;
        if (this.storm.t > 60) this.storm = { phase: 'clearing', t: 0, level: 1, great: this.storm.great };
      } else if (p === 'clearing') {
        this.storm.level = Math.max(0, 1 - this.storm.t / 30);
        if (this.storm.t > 30) this.storm = { phase: 'none', t: 0, level: 0, great: false };
      }
    }
    // A fake arrival every so often (for cards, chimes and vignettes).
    this.arrivalTimer -= dt;
    if (this.arrivalTimer <= 0) {
      this.arrivalTimer = 25;
      const sp = SPECIES[Math.floor(Math.random() * SPECIES.length)];
      const isl = DEMO_ISLANDS[0];
      const a = Math.random() * Math.PI * 2;
      const x = isl.x + Math.cos(a) * isl.r * 0.9;
      const z = isl.z + Math.sin(a) * isl.r * 0.9;
      const ok = Math.random() < 0.7;
      const road = sp.roads[0];
      this.events.arrivals.push({ species: sp.id, road, x, z, island: 1, ok, first: true, returned: false });
      this.post({ t: 'journal', entries: [{ id: this.journalId++, year: Math.floor(this.year), kind: ok ? 'arrival' : 'visit', species: sp.id, island: 1, x, z, road, headline: true }] });
    }
    // Throttled column sends (about 10 Hz).
    this.sendAcc += dt;
    if (this.dirty && this.sendAcc > 0.1) {
      this.sendAcc = 0;
      const [i0, k0, i1, k1] = this.dirty;
      this.dirty = null;
      this.sendCols(i0, k0, i1 - i0 + 1, k1 - k0 + 1);
    }
    this.post({
      t: 'tick',
      year: Math.floor(this.year),
      firstLand: true,
      paused: this.paused,
      storm: { ...this.storm },
      events: this.events,
      undo: 0,
      perf: { geoMs: 0, ecoMs: 0, packMs: 0, activeLava: 0, activeSand: 0, activePatches: 0, tickHz: this.pageMode ? 60 : 30 },
    });
    this.events = emptyEvents();
  }

  private markDirty(i0: number, k0: number, i1: number, k1: number): void {
    if (!this.dirty) this.dirty = [i0, k0, i1, k1];
    else {
      const d = this.dirty;
      d[0] = Math.min(d[0], i0);
      d[1] = Math.min(d[1], k0);
      d[2] = Math.max(d[2], i1);
      d[3] = Math.max(d[3], k1);
    }
  }
}
