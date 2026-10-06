/**
 * Particles and small effects: steam where lava meets the sea, lava spatter, the pour streams
 * (lava ribbon, sand stream, tumbling boulders), dust, spray (WP-E). Reads tick events via onEngine.
 * STUB (lead): nothing. WP-E replaces the body; keep the factory signature.
 */
import type { FromEngine } from '../engine/protocol';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createEffects(deps: SystemDeps): PageSystem {
  void deps;
  return { name: 'effects', onEngine(m: FromEngine) { void m; }, update(f: FrameCtx) { void f; } };
}
