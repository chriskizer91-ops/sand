/**
 * Animal agents near the camera, at real-world pace (WP-F).
 * STUB (lead): nothing. WP-F replaces the body; keep the factory signature.
 */
import type { FromEngine } from '../engine/protocol';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createFauna(deps: SystemDeps): PageSystem {
  void deps;
  return { name: 'fauna', onEngine(m: FromEngine) { void m; }, update(f: FrameCtx) { void f; } };
}
