/**
 * Day and season clock -> sun, sky colours, fog, shared uniforms (WP-G).
 * STUB (lead): fixed late morning. WP-G replaces the body; keep the factory signature.
 */
import * as THREE from 'three';
import { DAY_SECONDS, SEASON_DAYS, dayPart } from '../config';
import type { DayState, FrameCtx, PageSystem, SystemDeps } from './shared';

export interface DaylightSystem extends PageSystem {
  readonly day: DayState;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  /** Jump the clock (load, tests, "always day" setting). */
  setPhase(phase: number, dayCount?: number): void;
  /** 'cycle' (default), 'day' (always midday), 'golden' (always golden hour). */
  setMode(mode: 'cycle' | 'day' | 'golden'): void;
}

export function createDaylight(deps: SystemDeps): DaylightSystem {
  const { scene, u } = deps;
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.6);
  sun.castShadow = deps.quality.shadows;
  sun.shadow.mapSize.set(deps.quality.phone ? 1024 : 2048, deps.quality.phone ? 1024 : 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 1.3);
  scene.add(hemi);
  scene.background = new THREE.Color(0xbfe3f2);
  scene.fog = new THREE.Fog(0xd9f1ff, 600, 6000);
  const day: DayState = { phase: 0.3, part: 'day', season: 'wet', seasonPhase: 0, day: 0, moon: 0.5 };
  let phaseSeconds = 0.3 * DAY_SECONDS;
  return {
    name: 'daylight',
    day,
    sun,
    hemi,
    setPhase(phase: number, dayCount = 0) {
      phaseSeconds = (dayCount + phase) * DAY_SECONDS;
    },
    setMode() {},
    update(f: FrameCtx) {
      phaseSeconds += 0; // STUB: the clock stands still
      const total = phaseSeconds / DAY_SECONDS;
      day.day = Math.floor(total);
      day.phase = total - day.day;
      day.part = dayPart(day.phase);
      day.season = day.day % SEASON_DAYS === 0 ? 'wet' : 'dry';
      u.uSunDir.value.set(0.45, 0.8, -0.35).normalize();
      // Keep the shadow box around the camera target.
      const half = Math.min(300, Math.max(40, f.cam.dist * 0.8));
      const sc = sun.shadow.camera;
      sc.left = -half;
      sc.right = half;
      sc.top = half;
      sc.bottom = -half;
      sc.near = 1;
      sc.far = 2000;
      sc.updateProjectionMatrix();
      sun.target.position.copy(f.cam.target);
      sun.position.copy(f.cam.target).addScaledVector(u.uSunDir.value, 800);
      const fog = scene.fog as THREE.Fog;
      fog.near = u.uFogNear.value = f.cam.dist * 1.5 + 400;
      fog.far = u.uFogFar.value = 7000;
    },
  };
}
