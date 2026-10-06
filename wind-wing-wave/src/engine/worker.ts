/** Background-thread entry point for the island engine. */
import { Engine } from './engine';
import type { FromEngine, ToEngine } from './protocol';

const scope = self as unknown as {
  postMessage(msg: FromEngine, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToEngine>) => void) | null;
};

const engine = new Engine((msg, transfer) => scope.postMessage(msg, transfer ?? []));
scope.onmessage = (e) => engine.handle(e.data);
scope.postMessage({ t: 'hello' });

let last = performance.now();
function loop(): void {
  const start = performance.now();
  engine.tick((start - last) / 1000, 12);
  last = start;
  const spent = performance.now() - start;
  setTimeout(loop, Math.max(0, 1000 / 30 - spent));
}
loop();
