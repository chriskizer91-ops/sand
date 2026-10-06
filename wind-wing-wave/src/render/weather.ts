/**
 * Storm visuals and weather uniforms: rain, gusts, lightning, wet surfaces (WP-G).
 * Writes u.uStorm, u.uRain, u.uWet, u.uWind from FrameCtx.storm.
 * STUB (lead): copies the storm level. WP-G replaces the body; keep the factory signature.
 */
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createWeather(deps: SystemDeps): PageSystem {
  const { u } = deps;
  return {
    name: 'weather',
    update(f: FrameCtx) {
      u.uStorm.value = f.storm.level;
      u.uRain.value = f.storm.phase === 'peak' ? 1 : 0;
    },
  };
}
