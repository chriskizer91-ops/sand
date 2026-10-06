/**
 * Freshwater and salt ponds from life.ponds (WP-E).
 * STUB (lead): nothing. WP-E replaces the body; keep the factory signature.
 */
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createPonds(deps: SystemDeps): PageSystem {
  void deps;
  return { name: 'ponds', update(f: FrameCtx) { void f; } };
}
