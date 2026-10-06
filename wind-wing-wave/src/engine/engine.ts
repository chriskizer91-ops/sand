/**
 * The engine hub: the world (ground columns, geology, life grid, ecology), your strokes,
 * undo, saving, and the streams that keep the page's copy of the world up to date.
 * It talks to the page only through messages (protocol.ts), so it can run on a background
 * thread, or on the page when the browser won't allow one (host.ts).
 *
 * One tick (ARCHITECTURE §5.1), each step with its own time budget:
 *   1. input: the held stroke is applied at its latest point, once per physics step;
 *   2. geology: lava and sand, in fixed 1/30 s steps, at most 2 per tick. Under load it
 *      runs slower instead of skipping ahead;
 *   3. ecology: the year clock and a slice of life simulation;
 *   4. streams: changed ground (faster while something moves), changed life, the life
 *      summary, new journal entries;
 *   5. a 'tick' message for the page's sounds and effects.
 *
 * Loading (a new sea, a reset or a saved sea) builds the new world in fresh objects and
 * swaps it in only when it is complete, then re-sends everything in row bands with
 * progress messages, then says 'ready'.
 */
import { GAME_VERSION, NP, NX, NZ, PACE_YPS, PATCH, PHYS_STEP, type Season, type ToolId } from '../config';
import { SPECIES } from '../content/species';
import { Ecology } from '../eco/ecology';
import { PatchGrid } from '../eco/patches';
import { runChecks } from '../checks/registry';
import '../checks/all';
import { ChangeFlag, Columns, type ChangeListener } from './columns';
import { buildDemoChain } from './fixtures';
import { Geo } from './geo/geo';
import type { EngineSettings, JournalEntry, PageSaveHeader, PerfStats, StormState, TickEvents, ToEngine } from './protocol';
import { SAVE_FORMAT, SaveError, applyFields, decodeSave, encodeSave, patchesHash, type DecodedSave, type SaveHeader } from './save';
import { BAND_ROWS, ColsStream, EcoStream, RateLimit, now, type Post } from './streams';
import { UndoStack } from './undo';

// ---------- timing ----------

/** Worker tick interval while lava, sand or a stroke is moving, and while all is quiet (seconds). */
export const TICK_ACTIVE = 1 / 30;
export const TICK_IDLE = 1 / 10;
/** Time the worker allows one tick (the engine splits it between geology, ecology and packing). */
export const WORKER_TICK_BUDGET_MS = 14;
/** Time the page allows the engine per frame when it runs on the page. */
export const PAGE_TICK_BUDGET_MS = 6;
/** While loading, the world is re-sent in bands until this much of the tick is used. */
export const LOADING_TICK_BUDGET_MS = 40;

/** Physics steps per tick at most. */
const MAX_STEPS = 2;
/** The longest tick we account for (after a stall or a hidden spell). */
const MAX_DT = 0.25;
/** A stroke's undo record closes at the latest this long after the stroke ended (seconds of physics). */
const RECORD_MAX_WAIT = 40;
/** Scripted pours and 'settle' stop after this much simulated physics (seconds). */
const SETTLE_LIMIT = 120;
/** Budget for synchronous scripted physics (ms): effectively unlimited. */
const UNLIMITED_MS = 1e6;
/** A geology step always gets at least this much time, so it can make progress. */
const MIN_STEP_MS = 0.25;
/** Fastest life-summary resend (seconds). */
const LIFE_INTERVAL = 1;
/** Errors with the same message are reported at most this often (ms). */
const ERROR_REPEAT_MS = 10_000;

/** Time budgets (ms per tick) for each part of the tick. */
interface Budgets {
  geo: number;
  eco: number;
  pack: number;
}

/**
 * Budgets (ARCHITECTURE §5.1). A phone is roughly twice as slow, so it gets twice the time
 * for the same work; on the page (no background thread) everything is smaller, because the
 * engine shares the frame with drawing.
 */
const BUDGETS: Record<'worker' | 'workerPhone' | 'page' | 'pagePhone', Budgets> = {
  worker: { geo: 4, eco: 2, pack: 1 },
  workerPhone: { geo: 8, eco: 4, pack: 1 },
  page: { geo: 2.5, eco: 1, pack: 0.5 },
  pagePhone: { geo: 3.5, eco: 1.5, pack: 0.75 },
};

/** A phone or tablet (from the browser's own description; good enough to pick time budgets). */
function isPhone(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent ?? '');
}

// ---------- the world ----------

/** Everything that makes up one sea. Replaced as a whole on load and reset. */
interface World {
  cols: Columns;
  geo: Geo;
  grid: PatchGrid;
  eco: Ecology;
  seed: number;
  glow: { x: number; z: number };
}

/** A brand-new sea: the starting seabed, no life yet. */
function newSea(seed: number): World {
  const cols = new Columns();
  const geo = new Geo(cols, seed);
  geo.generateSeabed();
  const grid = new PatchGrid();
  const eco = new Ecology(cols, grid, geo, seed, SPECIES);
  return { cols, geo, grid, eco, seed, glow: { x: geo.seabed.glow.x, z: geo.seabed.glow.z } };
}

/** A saved sea, rebuilt in fresh objects (throws if the save doesn't fit; nothing live is touched). */
function worldFromSave(d: DecodedSave): World {
  const seed = d.header.seed;
  const geo = new Geo(d.cols, seed);
  const grid = new PatchGrid();
  const eco = new Ecology(d.cols, grid, geo, seed, SPECIES);
  applyFields(grid, d.fields);
  eco.restore(d.eco);
  return { cols: d.cols, geo, grid, eco, seed, glow: { x: d.header.glow.x, z: d.header.glow.z } };
}

/** Rows of 32 when the whole world is re-sent. */
const COLS_BANDS = NZ / BAND_ROWS;
const ECO_BANDS = NP / BAND_ROWS;

interface Loader {
  /** Next band to send (ground bands first, then life bands). */
  next: number;
  total: number;
  resumed: boolean;
  header: PageSaveHeader | undefined;
}

interface Stroke {
  tool: ToolId;
  x: number;
  z: number;
  radius: number;
  strength: number;
  /** The undo record this stroke opened. */
  record: number;
}

function emptyEvents(): TickEvents {
  return { steam: [], pour: null, lavaArea: 0, lavaGlow: [0, 0, 0, 0], sliding: 0, rockPlaced: 0, burned: 0, arrivals: [], places: [] };
}

/** A plain message from anything thrown. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Engine {
  private world: World | null = null;
  private undo: UndoStack | null = null;
  private readonly colsStream: ColsStream;
  private readonly ecoStream: EcoStream;
  private readonly lifeRate = new RateLimit();
  private ready = false;
  private loader: Loader | null = null;
  /** Bumped whenever the world is replaced, so a slow save decode that finishes late is dropped. */
  private generation = 0;
  private pageMode = false;
  private readonly phone = isPhone();
  private readonly budget: Budgets = { geo: 0, eco: 0, pack: 0 };

  // Clock inputs for the ecology (from the page).
  private settings: EngineSettings = { pace: 'normal', gentleStorms: false };
  private pauseOn = false;
  private hidden = false;
  private dayPhase = 0.3;
  private season: Season = 'wet';
  private clockDirty = true;

  // Physics state.
  private stroke: Stroke | null = null;
  private physAcc = 0;
  /** Seconds of physics since the stroke ended while its record waits for things to settle. */
  private settleWait = 0;
  private physicsActive = false;
  private lavaCols = 0;
  private sandCols = 0;

  // Event tallies for the next 'tick' message.
  private slid = 0;
  private burned = 0;
  private readonly events = emptyEvents();
  private readonly pourOut = { tool: 'lava' as ToolId, x: 0, y: 0, z: 0, r: 0 };
  private readonly perf: PerfStats = { geoMs: 0, ecoMs: 0, packMs: 0, activeLava: 0, activeSand: 0, activePatches: 0, tickHz: 0 };
  private readonly journalOut: JournalEntry[] = [];

  private lastError = '';
  private lastErrorAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly post: Post) {
    this.colsStream = new ColsStream(post);
    this.ecoStream = new EcoStream(post);
  }

  /** On the page (no background thread) the engine uses smaller time budgets. */
  setPageMode(on: boolean): void {
    this.pageMode = on;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** The live column grid (for checks and debug tools; null before the first sea exists). */
  get columns(): Columns | null {
    return this.world?.cols ?? null;
  }

  /** The live life grid (for checks and debug tools). */
  get patches(): PatchGrid | null {
    return this.world?.grid ?? null;
  }

  /** How long the worker should wait before the next tick (seconds). */
  tickInterval(): number {
    if (this.loader) return TICK_ACTIVE;
    if (!this.ready || this.hidden) return TICK_IDLE;
    return this.stroke || this.physicsActive ? TICK_ACTIVE : TICK_IDLE;
  }

  /** Tell the page about a problem (the same message at most once every 10 s). */
  reportError(err: unknown): void {
    const message = messageOf(err);
    const t = now();
    if (message === this.lastError && t - this.lastErrorAt < ERROR_REPEAT_MS) return;
    this.lastError = message;
    this.lastErrorAt = t;
    this.post({ t: 'error', message });
  }

  // ---------- messages ----------

  handle(msg: ToEngine): void {
    try {
      this.handleInner(msg);
    } catch (err) {
      this.reportError(err);
    }
  }

  private handleInner(msg: ToEngine): void {
    switch (msg.t) {
      case 'init':
        this.settings = { ...msg.settings };
        this.clockDirty = true;
        if (msg.save) this.openSave(msg.save, msg.seed, null);
        else this.install(newSea(msg.seed), false, undefined);
        return;
      case 'reset':
        this.install(newSea(msg.seed), false, undefined);
        return;
      case 'load':
        this.openSave(msg.data, null, msg.id);
        return;
      case 'stroke':
        this.onStroke(msg);
        return;
      case 'focus':
        if (msg.dayPhase !== this.dayPhase || msg.season !== this.season) {
          this.dayPhase = msg.dayPhase;
          this.season = msg.season;
          this.clockDirty = true;
        }
        return;
      case 'settings':
        this.settings = { ...msg.settings };
        this.clockDirty = true;
        return;
      case 'pause':
        this.pauseOn = msg.on;
        this.hidden = msg.hidden;
        this.clockDirty = true;
        return;
      case 'undo':
        if (!this.ready) return;
        // A held stroke ends here: it must not keep pouring with no record to undo it.
        this.stroke = null;
        this.undoLatest();
        return;
      case 'inspect':
        if (this.world) this.post({ t: 'inspected', id: msg.id, info: this.world.eco.inspect(msg.x, msg.z) });
        return;
      case 'rename':
        this.world?.eco.renameIsland(msg.island, msg.name);
        return;
      case 'save':
        this.save(msg.id, msg.header);
        return;
      case 'checks':
        runChecks({ quick: msg.quick }).then(
          (results) => this.post({ t: 'checks', id: msg.id, results }),
          (err) => this.reportError(err),
        );
        return;
      case 'debug':
        this.debug(msg);
        return;
    }
  }

  // ---------- building and loading ----------

  /** Swap in a complete world and start re-sending it to the page. */
  private install(w: World, resumed: boolean, header: PageSaveHeader | undefined): void {
    this.generation++;
    this.world = w;
    this.undo = new UndoStack(w.cols, w.grid);
    w.cols.addListener(this.listenerFor(w));
    this.stroke = null;
    this.physAcc = 0;
    this.settleWait = 0;
    this.physicsActive = !w.geo.isSettled();
    this.lavaCols = 0;
    this.sandCols = 0;
    this.slid = 0;
    this.burned = 0;
    this.colsStream.attach(w.cols);
    this.ecoStream.attach(w.eco);
    this.lifeRate.reset();
    this.pushClock(w.eco);
    // Everything is about to be sent in full, so pending changes are already covered.
    w.eco.takeDirty();
    this.ready = false;
    this.loader = { next: 0, total: COLS_BANDS + ECO_BANDS, resumed, header };
    this.post({ t: 'clear' });
    this.post({ t: 'progress', done: 0, total: this.loader.total });
  }

  /** Columns listener: remember what to re-send, count burned ground, and tell the ecology. */
  private listenerFor(w: World): ChangeListener {
    return (i0, k0, i1, k1, flags) => {
      this.colsStream.mark(i0, k0, i1, k1);
      if (flags & ChangeFlag.Burn) this.burned += (((i1 / PATCH) | 0) - ((i0 / PATCH) | 0) + 1) * (((k1 / PATCH) | 0) - ((k0 / PATCH) | 0) + 1);
      w.eco.onTerrainChanged(i0, k0, i1, k1, flags);
    };
  }

  /**
   * Open a saved sea. It is decoded into fresh objects in the background; the current
   * game keeps running and is only replaced if everything checks out.
   * - 'load' (loadId set): on failure the page is told and the current game carries on.
   * - 'init' with a save (newSeaSeed set): on failure the page is told and a new sea starts.
   */
  private openSave(data: ArrayBuffer, newSeaSeed: number | null, loadId: number | null): void {
    const gen = ++this.generation;
    /** Something newer replaced the world while this was decoding: drop it (a load request still gets its answer). */
    const overtaken = (): boolean => {
      if (gen === this.generation) return false;
      if (loadId !== null) this.post({ t: 'loaded', id: loadId, ok: false, error: 'Another sea was opened before this one finished loading.' });
      return true;
    };
    const fail = (err: unknown): void => {
      if (overtaken()) return;
      const why = err instanceof SaveError ? err.message : `This saved sea couldn't be opened (${messageOf(err)}).`;
      if (loadId !== null) {
        this.post({ t: 'loaded', id: loadId, ok: false, error: why });
        return;
      }
      this.post({ t: 'error', message: `${why} Starting a new sea instead.` });
      this.install(newSea(newSeaSeed ?? 1), false, undefined);
    };
    decodeSave(data)
      .then((decoded) => {
        if (overtaken()) return;
        let world: World;
        try {
          world = worldFromSave(decoded);
        } catch (err) {
          fail(err);
          return;
        }
        const header = decoded.header.page ?? undefined;
        if (loadId !== null) this.post({ t: 'loaded', id: loadId, ok: true, header });
        this.install(world, true, header);
      }, fail)
      .catch((err) => this.reportError(err));
  }

  /** Send the next bands of the full resend; say 'ready' after the last one. */
  private runLoader(L: Loader, budgetMs: number): void {
    const end = now() + budgetMs;
    do {
      const band = L.next++;
      if (band < COLS_BANDS) this.colsStream.sendRect(0, band * BAND_ROWS, NX, BAND_ROWS);
      else this.ecoStream.sendRect(0, (band - COLS_BANDS) * BAND_ROWS, NP, BAND_ROWS);
      this.post({ t: 'progress', done: L.next, total: L.total });
    } while (L.next < L.total && now() < end);
    if (L.next < L.total) return;
    const w = this.world!;
    this.loader = null;
    const life = w.eco.takeLife();
    if (life) this.post({ t: 'life', life });
    this.post({ t: 'journal', entries: w.eco.journalAll(), reset: true });
    // Entries waiting to be streamed are already in the full journal just sent.
    w.eco.takeJournal(this.journalOut);
    this.journalOut.length = 0;
    this.ready = true;
    this.post({ t: 'ready', resumed: L.resumed, year: w.eco.year, firstLand: w.eco.firstLand, glow: { x: w.glow.x, z: w.glow.z }, header: L.header });
  }

  // ---------- strokes and undo ----------

  private onStroke(m: Extract<ToEngine, { t: 'stroke' }>): void {
    const w = this.world;
    const undo = this.undo;
    if (!w || !undo || !this.ready) return;
    const s = this.stroke;
    switch (m.phase) {
      case 'start': {
        this.stroke = null;
        if (m.tool === 'look') return; // looking shapes nothing
        const record = undo.begin();
        this.settleWait = 0;
        this.stroke = { tool: m.tool, x: m.x, z: m.z, radius: m.radius, strength: m.strength, record };
        // Act once straight away, so even the quickest tap leaves a mark.
        w.geo.applyTool(m.tool, m.x, m.z, m.radius, PHYS_STEP, m.strength);
        this.physicsActive = true;
        return;
      }
      case 'move':
        if (s) {
          s.x = m.x;
          s.z = m.z;
          s.radius = m.radius;
          s.strength = m.strength;
        }
        return;
      case 'end':
        // The record stays open until what the stroke set moving has settled.
        if (s) {
          this.stroke = null;
          this.settleWait = 0;
        }
        return;
      case 'cancel':
        this.stroke = null;
        if (s && undo.latestId === s.record) this.undoLatest();
        return;
    }
  }

  /** Undo the newest record and report the restored ground as changed. */
  private undoLatest(): void {
    const w = this.world;
    const undo = this.undo;
    if (!w || !undo) return;
    const eco = w.eco;
    const blocks = undo.undo((name, snapshot, current) => eco.undoMerge(name, snapshot, current));
    this.settleWait = 0;
    if (!blocks) return;
    for (const b of blocks) {
      const [i0, k0, i1, k1] = Columns.blockRect(b);
      w.cols.markChanged(i0, k0, i1, k1, ChangeFlag.Geom | ChangeFlag.Look);
    }
  }

  // ---------- saving ----------

  private saveHeader(w: World, page: PageSaveHeader | null): SaveHeader {
    return {
      format: SAVE_FORMAT,
      gameVersion: GAME_VERSION,
      savedAt: new Date().toISOString(),
      seed: w.seed,
      glow: { x: w.glow.x, z: w.glow.z },
      year: w.eco.year,
      page,
    };
  }

  private save(id: number, page: PageSaveHeader): void {
    const w = this.world;
    if (!w || !this.ready) {
      this.post({ t: 'saved', id, data: null, error: "The sea is still loading, so it can't be saved yet." });
      return;
    }
    // The world is copied out right now (synchronously); only the packing happens later.
    encodeSave({ header: this.saveHeader(w, page), cols: w.cols, grid: w.grid, eco: w.eco.serialize() }).then(
      (data) => this.post({ t: 'saved', id, data }, [data]),
      (err) => this.post({ t: 'saved', id, data: null, error: err instanceof SaveError ? err.message : `Saving failed (${messageOf(err)}).` }),
    );
  }

  // ---------- the tick ----------

  /** Advance the world by dt seconds, using at most about budgetMs of time. */
  tick(dt: number, budgetMs: number): void {
    if (this.loader) {
      this.runLoader(this.loader, budgetMs);
      return;
    }
    const w = this.world;
    const undo = this.undo;
    if (!w || !undo || !this.ready) return;
    dt = Math.min(Math.max(dt, 0), MAX_DT);
    const b = this.budgets(budgetMs);
    const t0 = now();

    // 1-2. The held stroke and the physics (paused while the page is hidden).
    if (!this.hidden) {
      this.physAcc += dt;
      const geoEnd = t0 + b.geo;
      let steps = 0;
      while (this.physAcc >= PHYS_STEP && steps < MAX_STEPS) {
        if (steps > 0 && now() >= geoEnd) break;
        this.physAcc -= PHYS_STEP;
        steps++;
        const s = this.stroke;
        if (s) w.geo.applyTool(s.tool, s.x, s.z, s.radius, PHYS_STEP, s.strength);
        const st = w.geo.step(PHYS_STEP, Math.max(MIN_STEP_MS, geoEnd - now()));
        this.slid += st.slid;
        this.lavaCols = st.lavaCols;
        this.sandCols = st.sandCols;
      }
      // Under load the physics runs slower rather than skipping ahead.
      if (this.physAcc > PHYS_STEP) this.physAcc = PHYS_STEP;
      this.physicsActive = !w.geo.isSettled();
      if (undo.isOpen && !this.stroke) {
        this.settleWait += dt;
        if (!this.physicsActive || this.settleWait >= RECORD_MAX_WAIT) undo.close();
      }
    }
    const t1 = now();

    // 3. The ecology. Its own writes (soil, coast, reef, storms) never go into an undo record.
    if (this.clockDirty) this.pushClock(w.eco);
    undo.pauseRecording();
    w.eco.advance(dt);
    if (!this.hidden) w.eco.work(b.eco);
    undo.resumeRecording();
    const t2 = now();

    // 4. Streams.
    const packEnd = t2 + b.pack;
    this.colsStream.flush(dt, this.stroke !== null || this.physicsActive, packEnd);
    this.ecoStream.flush(dt, packEnd);
    this.lifeRate.advance(dt);
    if (this.lifeRate.ready(LIFE_INTERVAL)) {
      const life = w.eco.takeLife();
      if (life) {
        this.post({ t: 'life', life });
        this.lifeRate.sent();
      }
    }
    w.eco.takeJournal(this.journalOut);
    if (this.journalOut.length) {
      this.post({ t: 'journal', entries: this.journalOut.slice() });
      this.journalOut.length = 0;
    }
    const t3 = now();

    // 5. The tick message.
    this.notePerf(w, dt, t1 - t0, t2 - t1, t3 - t2);
    this.sendTick(w, undo);
  }

  /** This tick's budgets: the mode's own, scaled down if the caller allows less time. */
  private budgets(budgetMs: number): Budgets {
    const base = this.pageMode ? (this.phone ? BUDGETS.pagePhone : BUDGETS.page) : this.phone ? BUDGETS.workerPhone : BUDGETS.worker;
    const s = Math.min(1, budgetMs / (base.geo + base.eco + base.pack));
    this.budget.geo = base.geo * s;
    this.budget.eco = base.eco * s;
    this.budget.pack = base.pack * s;
    return this.budget;
  }

  private pushClock(eco: Ecology): void {
    eco.setClock({
      paused: this.pauseOn || this.hidden,
      yps: PACE_YPS[this.settings.pace] ?? PACE_YPS.normal,
      dayPhase: this.dayPhase,
      season: this.season,
      gentleStorms: this.settings.gentleStorms,
    });
    this.clockDirty = false;
  }

  private notePerf(w: World, dt: number, geoMs: number, ecoMs: number, packMs: number): void {
    const p = this.perf;
    const k = 0.1;
    p.geoMs += (geoMs - p.geoMs) * k;
    p.ecoMs += (ecoMs - p.ecoMs) * k;
    p.packMs += (packMs - p.packMs) * k;
    p.activeLava = this.lavaCols;
    p.activeSand = this.sandCols;
    p.activePatches = w.eco.activePatches;
    if (dt > 0) p.tickHz += (1 / dt - p.tickHz) * k;
  }

  private sendTick(w: World, undo: UndoStack): void {
    // In a worker the message is copied as it is sent, so the same objects are reused every
    // tick. On the page the receiver gets our objects themselves, so it gets new ones.
    const fresh = this.pageMode;
    const ev = fresh ? emptyEvents() : this.events;
    ev.steam.length = 0;
    w.geo.takeSteam(ev.steam);
    const s = this.stroke;
    if (s) {
      const pour = fresh ? { tool: s.tool, x: 0, y: 0, z: 0, r: 0 } : this.pourOut;
      pour.tool = s.tool;
      pour.x = s.x;
      pour.y = w.cols.heightAt(s.x, s.z);
      pour.z = s.z;
      pour.r = s.radius;
      ev.pour = pour;
    } else {
      ev.pour = null;
    }
    const lava = w.geo.lavaStats();
    ev.lavaArea = lava.area;
    for (let i = 0; i < 4; i++) ev.lavaGlow[i] = lava.glow[i];
    ev.sliding = this.slid;
    this.slid = 0;
    ev.rockPlaced = w.geo.takeRockPlaced();
    ev.burned = this.burned;
    this.burned = 0;
    ev.arrivals.length = 0;
    w.eco.takeArrivals(ev.arrivals);
    ev.places.length = 0;
    w.eco.takePlaces(ev.places);
    const storm: StormState = w.eco.storm;
    this.post({
      t: 'tick',
      year: w.eco.year,
      firstLand: w.eco.firstLand,
      paused: this.pauseOn || this.hidden,
      storm: fresh ? { ...storm } : storm,
      events: ev,
      undo: undo.count,
      perf: fresh ? { ...this.perf } : this.perf,
    });
  }

  // ---------- debug and test operations ----------

  private debug(m: Extract<ToEngine, { t: 'debug' }>): void {
    const answer = (data: unknown): void => this.post({ t: 'debugResult', id: m.id, data });
    const w = this.world;
    const undo = this.undo;
    if (!w || !undo || !this.ready) {
      answer({ ok: false, error: 'The sea is still loading.' });
      return;
    }
    switch (m.op) {
      case 'advanceYears':
        undo.pauseRecording();
        w.eco.debugAdvance(m.arg ?? 100);
        undo.resumeRecording();
        answer({ ok: true, year: w.eco.year });
        return;
      case 'stormNow':
        w.eco.debugStormNow();
        answer({ ok: true, storm: { ...w.eco.storm } });
        return;
      case 'stats':
        answer(this.stats(w, undo));
        return;
      case 'hash':
        answer(this.hashes(w));
        return;
      case 'pour':
        answer(this.scriptedPour(w, undo, m.tool ?? 'lava', m.x ?? w.glow.x, m.z ?? w.glow.z, m.radius ?? 10, m.seconds ?? 5));
        return;
      case 'settle': {
        const r = this.runUntilSettled(w);
        if (r.settled && !this.stroke) undo.close();
        answer({ ok: true, ...r });
        return;
      }
      case 'demoChain':
        // The whole ground is replaced: old undo records would mix two worlds.
        this.stroke = null;
        undo.clear();
        buildDemoChain(w.cols);
        w.cols.markChanged(0, 0, NX - 1, NZ - 1, ChangeFlag.Geom | ChangeFlag.Look | ChangeFlag.Tool);
        answer({ ok: true });
        return;
    }
  }

  /**
   * Pour with a tool for `seconds` of physics at once, then keep stepping until everything
   * settles (at most 120 s of physics). It is one undo record, like a stroke.
   */
  private scriptedPour(w: World, undo: UndoStack, tool: ToolId, x: number, z: number, radius: number, seconds: number): unknown {
    this.stroke = null;
    if (tool === 'look') return { ok: false, error: 'Look shapes nothing.' };
    undo.begin();
    this.settleWait = 0;
    let t = 0;
    for (; t < seconds; t += PHYS_STEP) {
      w.geo.applyTool(tool, x, z, radius, PHYS_STEP, 1);
      w.geo.step(PHYS_STEP, UNLIMITED_MS);
    }
    const r = this.runUntilSettled(w);
    if (r.settled) undo.close();
    return { ok: true, settled: r.settled, seconds: t + r.seconds, hash: w.cols.hash(), undo: undo.count };
  }

  /** Step the physics until nothing moves (or 120 s of physics have passed). */
  private runUntilSettled(w: World): { settled: boolean; seconds: number } {
    let t = 0;
    while (!w.geo.isSettled() && t < SETTLE_LIMIT) {
      w.geo.step(PHYS_STEP, UNLIMITED_MS);
      t += PHYS_STEP;
    }
    const settled = w.geo.isSettled();
    this.physicsActive = !settled;
    return { settled, seconds: t };
  }

  /** Fingerprints of the ground, of the saved life fields, and of both together ("same world?"). */
  private hashes(w: World): { ok: true; cols: number; patches: number; hash: number } {
    const cols = w.cols.hash();
    const patches = patchesHash(w.grid);
    return { ok: true, cols, patches, hash: (Math.imul(cols ^ 0x9e3779b9, 16777619) ^ patches) >>> 0 };
  }

  private stats(w: World, undo: UndoStack): unknown {
    const MB = 1024 * 1024;
    const c = w.cols;
    const colBytes = c.rock.byteLength + c.sed.byteLength + c.lava.byteLength + c.temp.byteLength + c.sandKind.byteLength + c.rockKind.byteLength;
    let patchBytes = 0;
    for (const f of w.grid.order) patchBytes += f.arr.byteLength;
    return {
      ok: true,
      perf: { ...this.perf },
      year: w.eco.year,
      firstLand: w.eco.firstLand,
      storm: { ...w.eco.storm },
      activeLava: this.lavaCols,
      activeSand: this.sandCols,
      activePatches: w.eco.activePatches,
      undo: { records: undo.count, open: undo.isOpen },
      memoryMB: {
        columns: colBytes / MB,
        patches: patchBytes / MB,
        undo: undo.bytes / MB,
        total: (colBytes + patchBytes + undo.bytes) / MB,
      },
      pageMode: this.pageMode,
      phone: this.phone,
      tickInterval: this.tickInterval(),
    };
  }
}
