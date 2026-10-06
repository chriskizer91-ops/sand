/**
 * Plants from the patch layers (WP-F): stable placement, LOD tiers, pop and death animations, sway.
 * STUB (lead): nothing. WP-F replaces the body; keep the factory signature.
 */
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createVegetation(deps: SystemDeps): PageSystem {
  void deps;
  return { name: 'vegetation', update(f: FrameCtx) { void f; } };
}
