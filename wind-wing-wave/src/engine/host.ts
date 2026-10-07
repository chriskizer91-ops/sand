/**
 * Starts the island engine. Prefers a background thread (Web Worker) so the screen stays
 * smooth. If the browser won't allow one (it can refuse when the game is opened as a local
 * file), or the background thread fails before the sea is ready, the engine runs on the
 * page instead: a little slower, but the game still works.
 */
import { Engine, LOADING_TICK_BUDGET_MS, PAGE_TICK_BUDGET_MS } from './engine';
import type { FromEngine, ToEngine } from './protocol';

declare const __WORKER_SOURCE__: string;

export interface EngineHost {
  readonly mode: 'worker' | 'page';
  send(msg: ToEngine, transfer?: Transferable[]): void;
  /** Page mode only: run the engine for a slice of the frame. */
  tick(dt: number): void;
}

/** How long the background thread gets to say hello before we give up on it (ms). */
const HELLO_TIMEOUT_MS = 4000;

/** Slack when comparing summed frame times with the engine's tick interval (s): frames are never exactly on time. */
const PACE_SLACK = 0.002;

/**
 * An engine running on the page itself. While the sea loads it ticks every frame (with most
 * of the frame), so the world arrives quickly. After that it keeps the pace it would keep on
 * a background thread (30 ticks a second while something moves, 10 when quiet): frame
 * times are added up and the engine ticks once they reach its interval, so a quiet island
 * costs the page as little as it would cost a background thread.
 */
function pageEngine(onMessage: (msg: FromEngine) => void): { send(msg: ToEngine): void; tick(dt: number): void } {
  const engine = new Engine((msg) => onMessage(msg));
  engine.setPageMode(true);
  /** Frame time since the engine last ticked (s). */
  let owed = 0;
  return {
    send: (msg) => engine.handle(msg),
    tick: (dt) => {
      try {
        if (!engine.isReady) {
          owed = 0;
          engine.tick(dt, LOADING_TICK_BUDGET_MS);
          return;
        }
        owed += dt;
        if (owed + PACE_SLACK < engine.tickInterval()) return;
        const elapsed = owed;
        owed = 0;
        engine.tick(elapsed, PAGE_TICK_BUDGET_MS);
      } catch (err) {
        engine.reportError(err);
      }
    },
  };
}

export function startEngine(onMessage: (msg: FromEngine) => void): Promise<EngineHost> {
  return new Promise((resolve) => {
    let worker: Worker | null = null;
    let page: ReturnType<typeof pageEngine> | null = null;
    /** The background thread has delivered a ready sea at least once. */
    let workerReady = false;
    /**
     * What the page has told the engine that defines the game so far, so a page engine can
     * take over if the background thread fails while loading: the first 'init', the latest
     * 'reset' after it, and the latest settings, pause and focus.
     */
    const replay: Record<'init' | 'reset' | 'settings' | 'pause' | 'focus', ToEngine | null> = {
      init: null,
      reset: null,
      settings: null,
      pause: null,
      focus: null,
    };

    const host: EngineHost = {
      get mode() {
        return page ? 'page' : 'worker';
      },
      send(msg, transfer) {
        if (!page && !workerReady) {
          if (msg.t === 'init') {
            replay.init = msg;
            replay.reset = null;
          } else if (msg.t === 'reset' || msg.t === 'settings' || msg.t === 'pause' || msg.t === 'focus') {
            replay[msg.t] = msg;
          }
        }
        if (page) page.send(msg);
        // A saved sea in 'init' is copied rather than handed over, so it can be replayed.
        else if (worker) worker.postMessage(msg, msg.t === 'init' ? [] : (transfer ?? []));
      },
      tick(dt) {
        page?.tick(dt);
      },
    };

    let settled = false;
    const toPage = (why: string): void => {
      if (worker) {
        worker.terminate();
        worker = null;
      }
      console.warn('Island engine running on the page (no background thread):', why);
      page = pageEngine(onMessage);
      for (const m of [replay.init, replay.reset, replay.settings, replay.pause, replay.focus]) if (m) page.send(m);
      if (!settled) {
        settled = true;
        resolve(host);
      }
    };

    try {
      if (typeof location !== 'undefined' && location.hash.includes('noworker')) throw new Error('turned off for testing (#noworker)');
      if (typeof __WORKER_SOURCE__ !== 'string' || typeof Worker === 'undefined') throw new Error('no worker support');
      const url = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (err) {
      toPage(String(err));
      return;
    }
    const w = worker;
    const timer = setTimeout(() => toPage('the background thread did not start in time'), HELLO_TIMEOUT_MS);
    const failed = (why: string): void => {
      clearTimeout(timer);
      if (worker !== w) return; // already replaced
      if (!workerReady) toPage(why);
      else onMessage({ t: 'error', message: `Island engine error: ${why}` });
    };
    w.onerror = (e) => {
      e.preventDefault();
      failed(e.message || 'background thread error');
    };
    w.onmessageerror = () => failed('a message from the background thread could not be read');
    w.onmessage = (e: MessageEvent<FromEngine>) => {
      if (worker !== w) return;
      const m = e.data;
      if (m.t === 'hello') {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(host);
        }
        return;
      }
      if (m.t === 'ready' && !workerReady) {
        // The background thread works: the replay copy (which may hold a saved sea) is no longer needed.
        workerReady = true;
        replay.init = replay.reset = replay.settings = replay.pause = replay.focus = null;
      }
      onMessage(m);
    };
  });
}
