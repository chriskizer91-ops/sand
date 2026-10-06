/**
 * Arrival scenes (WP-F): a coconut washing ashore, a raft with lizards, a bird gliding in to perch,
 * spores glinting on the wind, a spider on a silk thread. Driven by tick arrival events.
 * STUB (lead): nothing. WP-F replaces the body; keep the factory signature.
 */
import type { FromEngine } from '../engine/protocol';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createVignettes(deps: SystemDeps): PageSystem {
  void deps;
  return { name: 'vignettes', onEngine(m: FromEngine) { void m; }, update(f: FrameCtx) { void f; } };
}
