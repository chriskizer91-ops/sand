/**
 * The sand engine: the world, its physics, your hands, undo, meshing and saving.
 * It talks to the page only through messages, so it can run on a background thread.
 */
import {
  BRUSH_RADIUS,
  CELL,
  CHUNK,
  DRYING_RATE,
  GAME_VERSION,
  LAGOON_DIMS,
  TILE_CHUNKS,
  type BrushSize,
  type EngineSettings,
  type ToolId,
} from '../config';
import { runSandChecks } from '../checks/sandChecks';
import { Mesher, mergeMeshes, type ChunkMesh } from './mesher';
import type { FromEngine, HitInfo, Ray, TickEvents, ToEngine } from './protocol';
import { compress, decodeWorld, decompress, encodeWorld, type SaveHeader } from './save';
import { Sim } from './sim';
import { LagoonTerrain } from './terrain';
import { Hand, dig, pat, pile, raycast, type Hit } from './tools';
import { UndoStack } from './undo';
import { World, type Chunk } from './world';

type Post = (msg: FromEngine, transfer?: Transferable[]) => void;

const PILE_RATE: [number, number, number] = [14, 45, 130]; // cells per second
const STEP = 1 / 30;

function emptyEvents(): TickEvents {
  return { dug: 0, poured: 0, pats: 0, rubbed: 0, slid: 0, fell: 0, landed: 0, handFull: false, handEmpty: false };
}

interface Stroke {
  tool: ToolId;
  size: BrushSize;
  ray: Ray | null;
  moved: boolean;
  lastRub: number;
  lastHit: Hit | null;
}

export class Engine {
  world!: World;
  sim!: Sim;
  hand = new Hand();
  private mesher!: Mesher;
  private undo!: UndoStack;
  private settings: EngineSettings = { drying: 'normal' };
  private focus: [number, number, number] = [0, 0, 0];
  private stroke: Stroke | null = null;
  private hoverRay: Ray | null = null;
  private hoverHit: HitInfo | null = null;
  private events = emptyEvents();
  private time = 0;
  private stepAccum = 0;

  // Meshing bookkeeping.
  private dirty = new Set<number>();
  private visualDirty = new Set<number>();
  private lastVisualPass = 0;
  private chunkMeshes = new Map<number, ChunkMesh>();
  private tileDirtyCount!: Int32Array;
  private tilesToSend = new Set<number>();
  private ntx = 0;
  private ntz = 0;
  private initialTotal = 0;
  private ready = false;
  private perf = { simMs: 0, meshMs: 0 };

  /** On the page (no background thread) the physics works in smaller slices per step. */
  private pageMode = false;

  constructor(private post: Post) {}

  setPageMode(on: boolean): void {
    this.pageMode = on;
    if (this.sim) this.sim.maxCellsPerStep = on ? 12000 : 60000;
  }

  get isReady(): boolean {
    return this.ready;
  }

  // ---------- setup ----------

  private build(save: Uint8Array | null): SaveHeader | null {
    this.world = new World(LAGOON_DIMS, new LagoonTerrain());
    this.sim = new Sim(this.world);
    this.sim.dryRate = DRYING_RATE[this.settings.drying];
    this.sim.maxCellsPerStep = this.pageMode ? 12000 : 60000;
    this.mesher = new Mesher(this.world);
    this.undo = new UndoStack(this.world);
    this.hand = new Hand();
    this.stroke = null;
    this.chunkMeshes.clear();
    this.dirty.clear();
    this.visualDirty.clear();
    this.tilesToSend.clear();
    this.ntx = Math.ceil(this.world.ncx / TILE_CHUNKS);
    this.ntz = Math.ceil(this.world.ncz / TILE_CHUNKS);
    this.tileDirtyCount = new Int32Array(this.ntx * this.ntz);
    let header: SaveHeader | null = null;
    if (save) {
      header = decodeWorld(this.world, save);
      this.hand.amount = Math.max(0, Math.min(this.hand.capacity, header.hand?.amount ?? 0));
      this.hand.wetSum = Math.max(0, header.hand?.wetSum ?? 0);
    }
    this.world.onChunkChanged = (c, lx, ly, lz) => this.markDirty(c, lx, ly, lz);
    this.sim.onWetVisual = (c) => this.visualDirty.add(c.key);
    // Everything with a surface needs a first mesh.
    const w = this.world;
    for (let cy = 0; cy < w.ncy; cy++) {
      for (let cz = 0; cz < w.ncz; cz++) {
        for (let cx = 0; cx < w.ncx; cx++) {
          if (w.getChunk(cx, cy, cz) || w.procUniform(cx, cy, cz) === 'mixed') this.addDirty(w.chunkKey(cx, cy, cz));
        }
      }
    }
    // Wake stored sand so anything saved mid-slide settles.
    for (const c of w.list) {
      for (let li = 0; li < 4096; li++) {
        if (c.fill[li] > 0 && c.fill[li] < 255) {
          this.sim.enqueue(c.cx * 16 + (li & 15), c.cy * 16 + (li >> 8), c.cz * 16 + ((li >> 4) & 15));
        }
      }
    }
    this.initialTotal = this.dirty.size;
    this.ready = false;
    return header;
  }

  private tileOf(cx: number, cz: number): number {
    return Math.floor(cx / TILE_CHUNKS) + Math.floor(cz / TILE_CHUNKS) * this.ntx;
  }

  private addDirty(key: number): void {
    if (this.dirty.has(key)) return;
    this.dirty.add(key);
    const w = this.world;
    const cx = key % w.ncx;
    const cz = Math.floor(key / w.ncx) % w.ncz;
    this.tileDirtyCount[this.tileOf(cx, cz)]++;
  }

  private markDirty(c: Chunk, lx: number, ly: number, lz: number): void {
    this.addDirty(c.key);
    // Meshes look 3 cells past their edges, so changes near an edge affect neighbours too.
    const x0 = lx < 3 ? -1 : 0;
    const x1 = lx > 12 ? 1 : 0;
    const y0 = ly < 3 ? -1 : 0;
    const y1 = ly > 12 ? 1 : 0;
    const z0 = lz < 3 ? -1 : 0;
    const z1 = lz > 12 ? 1 : 0;
    if (x0 === 0 && x1 === 0 && y0 === 0 && y1 === 0 && z0 === 0 && z1 === 0) return;
    const w = this.world;
    for (let dy = y0; dy <= y1; dy++) {
      for (let dz = z0; dz <= z1; dz++) {
        for (let dx = x0; dx <= x1; dx++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const cx = c.cx + dx;
          const cy = c.cy + dy;
          const cz = c.cz + dz;
          if (cx < 0 || cy < 0 || cz < 0 || cx >= w.ncx || cy >= w.ncy || cz >= w.ncz) continue;
          this.addDirty(w.chunkKey(cx, cy, cz));
        }
      }
    }
  }

  // ---------- messages ----------

  handle(msg: ToEngine): void {
    try {
      this.handleInner(msg);
    } catch (err) {
      this.post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleInner(msg: ToEngine): void {
    switch (msg.t) {
      case 'init': {
        this.settings = msg.settings;
        this.focus = msg.focus;
        let save: Uint8Array | null = null;
        if (msg.save) {
          // Saves arrive compressed; decompress then build (async), else build now.
          decompress(new Uint8Array(msg.save))
            .then((raw) => {
              try {
                this.build(raw);
              } catch (err) {
                this.post({ t: 'error', message: 'Could not read the saved beach: ' + (err as Error).message });
                this.build(null);
              }
            })
            .catch((err) => {
              this.post({ t: 'error', message: 'Could not read the saved beach: ' + (err as Error).message });
              this.build(null);
            });
          return;
        }
        this.build(save);
        return;
      }
      case 'focus':
        this.focus = [msg.x, msg.y, msg.z];
        return;
      case 'hover':
        this.hoverRay = msg.ray;
        return;
      case 'stroke':
        this.onStroke(msg.phase, msg.tool, msg.size, msg.ray);
        return;
      case 'undo':
        if (this.stroke) this.stroke = null;
        this.doUndo();
        return;
      case 'settings':
        this.settings = msg.settings;
        if (this.sim) this.sim.dryRate = DRYING_RATE[msg.settings.drying];
        return;
      case 'save':
        this.doSave(msg.id, msg.header);
        return;
      case 'load':
        decompress(new Uint8Array(msg.data))
          .then((raw) => {
            const header = this.build(raw);
            this.post({ t: 'clear' });
            this.post({ t: 'loaded', id: msg.id, ok: true, header: header ?? undefined });
          })
          .catch((err) => {
            this.post({ t: 'loaded', id: msg.id, ok: false, error: (err as Error).message });
          });
        return;
      case 'reset':
        this.build(null);
        this.post({ t: 'clear' });
        return;
      case 'checks': {
        const results = runSandChecks();
        this.post({ t: 'checks', id: msg.id, results });
        return;
      }
      case 'demo':
        if (this.world) buildDemo(this.world, this.sim);
        return;
    }
  }

  private onStroke(phase: 'begin' | 'move' | 'end' | 'cancel', tool: ToolId, size: BrushSize, ray: Ray | null): void {
    if (!this.world) return;
    if (phase === 'begin') {
      this.undo.begin(this.hand.amount, this.hand.wetSum);
      this.stroke = { tool, size, ray, moved: false, lastRub: this.time, lastHit: null };
      // Act once right away so a quick tap does something.
      if (tool === 'pat') {
        const hit = ray ? this.cast(ray) : null;
        if (hit) {
          pat(this.sim, hit, BRUSH_RADIUS.pat[size], 1);
          this.events.pats++;
          this.stroke.lastHit = hit;
        }
      } else {
        this.applyTool(STEP);
      }
      return;
    }
    if (!this.stroke) return;
    if (phase === 'move') {
      if (ray) this.stroke.ray = ray;
      this.stroke.moved = true;
      return;
    }
    if (phase === 'end') {
      if (ray) this.stroke.ray = ray;
      this.stroke = null;
      return;
    }
    if (phase === 'cancel') {
      this.stroke = null;
      this.doUndo();
    }
  }

  private cast(ray: Ray): Hit | null {
    return raycast(this.world, ray.ox, ray.oy, ray.oz, ray.dx, ray.dy, ray.dz);
  }

  private applyTool(dt: number): void {
    const s = this.stroke;
    if (!s || !s.ray) return;
    const hit = this.cast(s.ray);
    s.lastHit = hit;
    if (!hit) return;
    if (s.tool === 'dig') {
      if (this.hand.space <= 0) {
        this.events.handFull = true;
        return;
      }
      this.events.dug += dig(this.sim, this.hand, hit, BRUSH_RADIUS.dig[s.size], dt);
    } else if (s.tool === 'pile') {
      if (this.hand.amount <= 0) {
        this.events.handEmpty = true;
        return;
      }
      this.events.poured += pile(this.sim, this.hand, hit, BRUSH_RADIUS.pile[s.size], PILE_RATE[s.size], dt);
    } else if (s.tool === 'pat') {
      if (s.moved && this.time - s.lastRub >= 0.1) {
        s.lastRub = this.time;
        s.moved = false;
        pat(this.sim, hit, BRUSH_RADIUS.pat[s.size], 0.35);
        this.events.rubbed++;
      }
    }
  }

  private doUndo(): void {
    if (!this.undo) return;
    const res = this.undo.undo();
    if (!res) return;
    this.hand.amount = res.handAmount;
    this.hand.wetSum = res.handWetSum;
    this.sim.removeParticlesFrom(res.id);
    const w = this.world;
    for (const code of res.changed) {
      const key = Math.floor(code / 4096);
      const li = code - key * 4096;
      const [cx, cy, cz] = w.keyToCoords(key);
      this.sim.enqueue(cx * 16 + (li & 15), cy * 16 + (li >> 8), cz * 16 + ((li >> 4) & 15));
    }
  }

  private doSave(id: number, extra: Partial<SaveHeader>): void {
    if (!this.world) {
      this.post({ t: 'saved', id, data: null, error: 'The beach is still loading.' });
      return;
    }
    // Land anything still in the air first, so no sand is lost from the save.
    const inAir = this.sim.particles.totalSand();
    if (inAir > 0) this.sim.landAllParticles();
    const header: SaveHeader = {
      savedAt: new Date().toISOString(),
      gameVersion: GAME_VERSION,
      beach: 'calm-lagoon',
      hand: { amount: this.hand.amount, wetSum: this.hand.wetSum },
      ...extra,
    };
    const raw = encodeWorld(this.world, header);
    compress(raw)
      .then((data) => {
        const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        this.post({ t: 'saved', id, data: buf }, [buf]);
      })
      .catch((err) => this.post({ t: 'saved', id, data: null, error: (err as Error).message }));
  }

  // ---------- the loop ----------

  /** Advance time. `budgetMs` limits how long meshing may take this call. */
  tick(dt: number, budgetMs: number): void {
    if (!this.world) return;
    dt = Math.min(dt, 0.25);
    this.time += dt;
    this.stepAccum += dt;
    const t0 = now();
    let steps = 0;
    while (this.stepAccum >= STEP && steps < 2) {
      this.stepAccum -= STEP;
      steps++;
      if (this.ready) this.applyTool(STEP);
      const st = this.sim.step(STEP);
      this.events.slid += st.moved;
      this.events.fell += st.fell;
      this.events.landed += st.landed;
    }
    if (this.stepAccum > STEP * 2) this.stepAccum = 0; // don't spiral if the device is slow
    const t1 = now();
    if (steps > 0) this.perf.simMs = this.perf.simMs * 0.9 + (t1 - t0) * 0.1;
    this.meshSome(Math.max(2, budgetMs - (t1 - t0)));
    this.perf.meshMs = this.perf.meshMs * 0.9 + (now() - t1) * 0.1;
    if (steps > 0) this.sendTick();
  }

  private meshSome(budgetMs: number): void {
    const w = this.world;
    // Moisture-only changes are refreshed at a gentle pace when nothing else is waiting.
    if (this.dirty.size === 0 && this.visualDirty.size > 0 && this.time - this.lastVisualPass > 1) {
      this.lastVisualPass = this.time;
      let n = 0;
      for (const key of this.visualDirty) {
        this.addDirty(key);
        this.visualDirty.delete(key);
        if (++n >= 24) break;
      }
    }
    if (this.dirty.size > 0) {
      const start = now();
      let keys = Array.from(this.dirty);
      if (keys.length > 1) {
        const [fx, fy, fz] = this.focus;
        const dist = new Map<number, number>();
        for (const key of keys) {
          const [cx, cy, cz] = w.keyToCoords(key);
          const x = w.originX + (cx + 0.5) * CHUNK * CELL - fx;
          const y = w.originY + (cy + 0.5) * CHUNK * CELL - fy;
          const z = w.originZ + (cz + 0.5) * CHUNK * CELL - fz;
          dist.set(key, x * x + y * y * 4 + z * z);
        }
        keys = keys.sort((a, b) => dist.get(a)! - dist.get(b)!);
      }
      for (const key of keys) {
        if (now() - start > budgetMs) break;
        const [cx, cy, cz] = w.keyToCoords(key);
        const m = this.mesher.meshChunk(cx, cy, cz);
        if (m) this.chunkMeshes.set(key, m);
        else this.chunkMeshes.delete(key);
        this.dirty.delete(key);
        const tile = this.tileOf(cx, cz);
        this.tileDirtyCount[tile]--;
        this.tilesToSend.add(tile);
      }
    }
    for (const tile of this.tilesToSend) {
      if (this.tileDirtyCount[tile] > 0) continue;
      this.sendTile(tile);
      this.tilesToSend.delete(tile);
    }
    if (!this.ready) {
      const done = this.initialTotal - this.dirty.size;
      this.post({ t: 'progress', done, total: this.initialTotal });
      if (this.dirty.size === 0 && this.tilesToSend.size === 0) {
        this.ready = true;
        this.post({
          t: 'ready',
          mapW: w.nx / 2,
          mapH: w.nz / 2,
          mapCell: CELL * 2,
          originX: w.originX,
          originZ: w.originZ,
          sizeX: w.nx * CELL,
          sizeZ: w.nz * CELL,
        });
      }
    }
  }

  private sendTile(tile: number): void {
    const w = this.world;
    const tx = tile % this.ntx;
    const tz = Math.floor(tile / this.ntx);
    const meshes: ChunkMesh[] = [];
    for (let cz = tz * TILE_CHUNKS; cz < Math.min(w.ncz, (tz + 1) * TILE_CHUNKS); cz++) {
      for (let cx = tx * TILE_CHUNKS; cx < Math.min(w.ncx, (tx + 1) * TILE_CHUNKS); cx++) {
        for (let cy = 0; cy < w.ncy; cy++) {
          const m = this.chunkMeshes.get(w.chunkKey(cx, cy, cz));
          if (m) meshes.push(m);
        }
      }
    }
    const merged = mergeMeshes(meshes);
    // Water-depth map patch: top sand height every 2 cells.
    const span = (TILE_CHUNKS * CHUNK) / 2;
    const heights = new Float32Array(span * span);
    const hx = tx * span;
    const hz = tz * span;
    for (let z = 0; z < span; z++) {
      for (let x = 0; x < span; x++) {
        heights[x + z * span] = w.topHeight((hx + x) * 2, (hz + z) * 2);
      }
    }
    this.post(
      {
        t: 'tile',
        tile,
        positions: merged.positions,
        normals: merged.normals,
        attrs: merged.attrs,
        indices: merged.indices,
        heights,
        hx,
        hz,
      },
      [merged.positions.buffer, merged.normals.buffer, merged.attrs.buffer, merged.indices.buffer, heights.buffer],
    );
  }

  private sendTick(): void {
    let hit: HitInfo | null = null;
    if (this.stroke && this.stroke.lastHit) {
      hit = this.stroke.lastHit;
    } else if (this.hoverRay && this.ready) {
      const h = this.cast(this.hoverRay);
      hit = h ? { x: h.x, y: h.y, z: h.z, nx: h.nx, ny: h.ny, nz: h.nz } : null;
    }
    this.hoverHit = hit;
    const P = this.sim.particles;
    const np = P.n;
    const parts = new Float32Array(Math.max(1, np * 5));
    for (let p = 0; p < np; p++) {
      const o = p * 5;
      parts[o] = P.x[p];
      parts[o + 1] = P.y[p];
      parts[o + 2] = P.z[p];
      parts[o + 3] = P.amt[p] > 0 ? CELL * 0.62 * Math.cbrt(P.amt[p] / 255) : 0.005;
      parts[o + 4] = P.wet[p] / 255;
    }
    this.post(
      {
        t: 'tick',
        hand: { amount: this.hand.amount, capacity: this.hand.capacity, wet: this.hand.wet },
        hit,
        events: this.events,
        undo: this.undo.count,
        particles: parts,
        np,
        perf: {
          simMs: this.perf.simMs,
          meshMs: this.perf.meshMs,
          queue: this.sim.queueLength,
          chunks: this.world.list.length,
          dirty: this.dirty.size,
        },
      },
      [parts.buffer],
    );
    this.events = emptyEvents();
  }
}

/** A sample castle for screenshots and visual checks (not reachable from the game's buttons). */
function buildDemo(w: World, sim: Sim): void {
  const cellAt = (x: number, z: number) => [Math.floor((x - w.originX) / CELL), Math.floor((z - w.originZ) / CELL)];
  const groundJ = (i: number, k: number) => Math.floor((w.heights[i + k * w.nx] - w.originY) / CELL);
  const shape = (x0: number, z0: number, r: number, h: number, test: (dx: number, dz: number, y: number) => boolean, wet: number, pack: number) => {
    const [ci, ck] = cellAt(x0, z0);
    const R = Math.ceil(r / CELL) + 1;
    const H = Math.ceil(h / CELL);
    for (let k = ck - R; k <= ck + R; k++) {
      for (let i = ci - R; i <= ci + R; i++) {
        if (!w.inRegionXZ(i, k)) continue;
        const g = groundJ(i, k);
        for (let y = -2; y < H; y++) {
          const dx = (i - ci) * CELL;
          const dz = (k - ck) * CELL;
          if (test(dx, dz, y * CELL)) w.setCell(i, g + y, k, 255, wet, pack);
        }
      }
    }
    const gj = groundJ(Math.max(0, Math.min(w.nx - 1, ci)), Math.max(0, Math.min(w.nz - 1, ck)));
    sim.wakeBox(ci - R - 1, gj - 4, ck - R - 1, ci + R + 1, gj + H + 4, ck + R + 1);
  };
  // A packed tower with battlements.
  shape(-0.9, 1.0, 0.16, 0.5, (dx, dz, y) => {
    const d = Math.hypot(dx, dz);
    if (d > 0.15) return false;
    if (y < 0.42) return true;
    const a = Math.atan2(dz, dx);
    return d > 0.09 && Math.cos(a * 4) > 0;
  }, 150, 255);
  // A wall with a tunnel through it.
  shape(0.2, 1.5, 0.75, 0.33, (dx, dz, y) => {
    if (Math.abs(dz) > 0.07 || Math.abs(dx) > 0.7) return false;
    if (Math.abs(dx) < 0.08 && y < 0.14) return false;
    return y < 0.3;
  }, 150, 240);
  // Loose damp heap and a dry heap (they slump to their natural slopes).
  shape(1.3, 0.7, 0.3, 0.45, (dx, dz, y) => Math.hypot(dx, dz) < 0.28 * (1 - y / 0.45), 140, 0);
  shape(2.1, 1.3, 0.3, 0.45, (dx, dz, y) => Math.hypot(dx, dz) < 0.28 * (1 - y / 0.45), 10, 0);
  // A hole dug near the water (it fills with water).
  const [hi, hk] = cellAt(0.4, -0.6);
  for (let k = hk - 8; k <= hk + 8; k++) {
    for (let i = hi - 8; i <= hi + 8; i++) {
      const r = Math.hypot(i - hi, k - hk);
      if (r > 7.5) continue;
      const g = groundJ(i, k);
      const depth = Math.round(6 * (1 - (r / 7.5) ** 2));
      for (let y = 0; y <= depth; y++) w.setCell(i, g - y + 1, k, 0, 0, 0);
    }
  }
  const hg = groundJ(hi, hk);
  sim.wakeBox(hi - 9, hg - 8, hk - 9, hi + 9, hg + 3, hk + 9);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
