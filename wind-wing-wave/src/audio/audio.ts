/**
 * All sound (WP-G): soundscape layers, species voices, arrival chimes, tool and lava sounds, storm.
 * Everything synthesised with WebAudio. STUB (lead): silent. WP-G replaces the body; keep the API.
 */
import type { FromEngine } from '../engine/protocol';
import type { FrameCtx, PageSystem, SystemDeps } from '../render/shared';

export interface AudioSystem extends PageSystem {
  /** Call from a user gesture (browsers only allow sound after one). */
  start(): void;
  setEnabled(on: boolean): void;
  /** UI tap sound. */
  click(): void;
  /** A soft page-turn for the journal. */
  page(): void;
}

export function createAudio(deps: SystemDeps): AudioSystem {
  void deps;
  return {
    name: 'audio',
    start() {},
    setEnabled() {},
    click() {},
    page() {},
    onEngine(m: FromEngine) { void m; },
    update(f: FrameCtx) { void f; },
  };
}
