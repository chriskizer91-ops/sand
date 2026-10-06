/**
 * Background-thread entry point for the island engine.
 *
 * Ticks at the pace the engine asks for: 30 times a second while something is moving (lava,
 * sliding sand, a held stroke) and 10 times a second when the island is quiet, so a resting
 * phone isn't kept busy. A message that needs the fast pace (a stroke starting) brings the
 * next tick forward instead of waiting out a quiet-time pause.
 */
import { Engine, LOADING_TICK_BUDGET_MS, WORKER_TICK_BUDGET_MS } from './engine';
import type { FromEngine, ToEngine } from './protocol';

const scope = self as unknown as {
  postMessage(msg: FromEngine, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToEngine>) => void) | null;
};

const engine = new Engine((msg, transfer) => scope.postMessage(msg, transfer ?? []));

/** Start of the last tick (ms), when the next one is due, and its timer. */
let last = performance.now();
let due = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** The sea has been ready at least once. Before that, a failure is a crash the page recovers from. */
let everReady = false;

function arm(at: number): void {
  due = at;
  timer = setTimeout(loop, Math.max(0, at - performance.now()));
}

function loop(): void {
  timer = null;
  const start = performance.now();
  const dt = (start - last) / 1000;
  last = start;
  try {
    engine.tick(dt, engine.isReady ? WORKER_TICK_BUDGET_MS : LOADING_TICK_BUDGET_MS);
  } catch (err) {
    // Before the first ready, let it fail loudly: the page then runs the engine itself.
    if (!everReady) throw err;
    engine.reportError(err);
  }
  everReady ||= engine.isReady;
  arm(start + engine.tickInterval() * 1000);
}

scope.onmessage = (e) => {
  engine.handle(e.data);
  const want = last + engine.tickInterval() * 1000;
  if (timer !== null && want < due) {
    clearTimeout(timer);
    arm(want);
  }
};
scope.postMessage({ t: 'hello' });
arm(last);
