/**
 * Starts the island engine. Prefers a background thread (Web Worker) so the
 * screen stays smooth; if the browser won't allow one (it can refuse when the
 * game is opened as a local file), runs the engine on the page instead.
 */
import { Engine } from './engine';
import type { FromEngine, ToEngine } from './protocol';

declare const __WORKER_SOURCE__: string;

export interface EngineHost {
  mode: 'worker' | 'page';
  send(msg: ToEngine, transfer?: Transferable[]): void;
  /** Page mode only: run the engine for a slice of the frame. */
  tick(dt: number): void;
}

export function startEngine(onMessage: (msg: FromEngine) => void): Promise<EngineHost> {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = (why: string) => {
      if (settled) return;
      settled = true;
      console.warn('Island engine running on the page (no background thread):', why);
      const engine = new Engine((msg) => onMessage(msg));
      engine.setPageMode(true);
      resolve({
        mode: 'page',
        send: (msg) => engine.handle(msg),
        // While the world is loading use most of the frame; then keep it light.
        tick: (dt) => engine.tick(dt, engine.isReady ? 6 : 45),
      });
    };
    let worker: Worker;
    try {
      if (typeof location !== 'undefined' && location.hash.includes('noworker')) throw new Error('turned off for testing (#noworker)');
      if (typeof __WORKER_SOURCE__ !== 'string' || typeof Worker === 'undefined') throw new Error('no worker support');
      const url = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (err) {
      fallback(String(err));
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      fallback('worker did not start in time');
    }, 4000);
    worker.onerror = (e) => {
      if (!settled) {
        clearTimeout(timer);
        worker.terminate();
        fallback(e.message || 'worker error');
      } else {
        onMessage({ t: 'error', message: `Island engine error: ${e.message}` });
      }
    };
    worker.onmessage = (e: MessageEvent<FromEngine>) => {
      if (e.data.t === 'hello' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          mode: 'worker',
          send: (msg, transfer) => worker.postMessage(msg, transfer ?? []),
          tick: () => {},
        });
        return;
      }
      onMessage(e.data);
    };
  });
}
