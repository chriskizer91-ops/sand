/**
 * The code-made cupped hands that hover over the brush and pour (WP-E).
 * STUB (lead): nothing. WP-E replaces the body; keep the factory signature.
 */
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createHands(deps: SystemDeps): PageSystem {
  void deps;
  return { name: 'hands', update(f: FrameCtx) { void f; } };
}
