/**
 * Sky dome, sun and moon discs, stars, clouds (trade cumulus, peak cap clouds, storm deck), rainbow (WP-G).
 * STUB (lead): nothing; the scene background colour stands in. WP-G replaces the body; keep the factory signature.
 */
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createSky(deps: SystemDeps): PageSystem {
  void deps;
  return { name: 'sky', update(f: FrameCtx) { void f; } };
}
