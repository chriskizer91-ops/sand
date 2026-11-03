/**
 * The weather you can see, for the open sea and its squalls:
 *  1. squalls: dark shower clouds with grey rain curtains, from the horizon
 *     to right inside one (squallFx.ts);
 *  2. rain falling around you (rainFx.ts);
 *  3. spray bursting over the bow (sprayFx.ts).
 * Everything is made in code; the only texture is a little noise painted at
 * startup. Three draw calls at most (one each), about 10,000 triangles.
 *
 * Wiring (in the game loop, after the camera has moved):
 *   fx.update(squalls, camera, time, dt, light, windX, windZ);
 *   fx.setLocalRain(rainHere);
 *   fx.spray(bow.x, bow.y, bow.z, headingX, headingZ, strength, time, boatSpeed); // when the bow slams a wave
 * and on resize fx.setViewport(drawingBufferHeightInPixels). Add `fx.group` to
 * the scene (and to the list the under-water picture skips).
 *
 * A squall's rain meets the sea centred on its x, z (where weatherAt() puts
 * its rain: densest within about half its radius, gone a little beyond it);
 * the cloud sits a little upwind, so the rain slants downwind as it falls.
 *
 * The rain curtain leaves the first SQUALL_FX.nearStart (30) metres around the
 * camera to the scene's fog, so when you're inside a squall the game's own
 * fog should grey and thicken (daylight.ts does this from the rain where you are).
 */
import * as THREE from 'three';
import { SquallFx, SQUALL_FX, type SquallInfo } from './squallFx';
import { RainFx, RAIN_FX } from './rainFx';
import { SprayFx, SPRAY_FX } from './sprayFx';
import { makeFxUniforms, type FxUniforms } from './weatherCommon';

export type { SquallInfo } from './squallFx';
export { SQUALL_FX, RAIN_FX, SPRAY_FX };

/** The light this frame (daylight.ts's numbers and the shared SKY colours). */
export interface WeatherLight {
  /** 1 by day, 0 at night. */
  daylight: number;
  /** 0 by day, 1 at night. */
  night: number;
  /** Where the light comes from (unit): the sun by day, the moon by night. */
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  horizon: THREE.Color;
  zenith: THREE.Color;
}

export class WeatherFx {
  /** Everything drawn: add it to the scene. */
  readonly group = new THREE.Group();
  private u: FxUniforms = makeFxUniforms();
  private squalls: SquallFx;
  private rain: RainFx;
  private sprayFx: SprayFx;
  private cam = new THREE.Vector3();
  private lastCam = new THREE.Vector3();
  private hasLast = false;
  /** The camera's velocity (m/s), smoothed: rain streaks slant with your own motion. */
  private camVel = new THREE.Vector3();

  constructor(opts: { phone: boolean }) {
    this.group.name = 'weatherFx';
    this.squalls = new SquallFx(this.u, opts.phone);
    this.rain = new RainFx(this.u, opts.phone);
    this.sprayFx = new SprayFx(this.u, opts.phone);
    this.group.add(this.squalls.mesh, this.rain.mesh, this.sprayFx.mesh);
  }

  /**
   * Once a frame, after the camera has moved. Wind is the air's velocity where
   * you are (m/s, the way it blows toward).
   */
  update(
    squalls: readonly SquallInfo[],
    camera: THREE.PerspectiveCamera,
    time: number,
    dt: number,
    light: WeatherLight,
    windX: number,
    windZ: number,
  ): void {
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.cam);
    // Your own speed through the rain (ignore jumps, such as loading a save).
    if (this.hasLast && dt > 1e-4) {
      const moved = this.cam.distanceTo(this.lastCam);
      if (moved < 20) {
        const vx = (this.cam.x - this.lastCam.x) / dt;
        const vy = (this.cam.y - this.lastCam.y) / dt;
        const vz = (this.cam.z - this.lastCam.z) / dt;
        const k = 1 - Math.exp(-dt / 0.2);
        this.camVel.x += (vx - this.camVel.x) * k;
        this.camVel.y += (vy - this.camVel.y) * k;
        this.camVel.z += (vz - this.camVel.z) * k;
        if (this.camVel.length() > 20) this.camVel.setLength(20);
      } else this.camVel.set(0, 0, 0);
    }
    this.lastCam.copy(this.cam);
    this.hasLast = true;

    const u = this.u;
    u.uTime.value = time;
    u.uSunDir.value.copy(light.sunDir).normalize();
    u.uSunColor.value.copy(light.sunColor);
    u.uHorizon.value.copy(light.horizon);
    u.uZenith.value.copy(light.zenith);
    u.uDay.value = light.daylight;
    u.uNight.value = light.night;
    u.uCamVel.value.copy(this.camVel);
    u.uAspect.value = camera.aspect;

    this.squalls.update(squalls, this.cam, dt, windX, windZ);
    this.rain.update(time, windX, windZ, u);
    this.sprayFx.update(camera, time, windX, windZ, u.uSunDir.value);
  }

  /**
   * Rain falling where you are, 0..1 (0.2 is a few streaks, 1 is a downpour).
   * The rain slants with the wind given to update(); wind passed here is ignored.
   */
  setLocalRain(rain: number, _windX?: number, _windZ?: number): void {
    this.rain.set(rain);
  }

  /**
   * A burst of spray off the bow at (x, y, z). dir = the boat's heading (unit,
   * horizontal); strength 0..1; boatSpeed in m/s (if left out, the camera's
   * own speed is used, which is right when you're aboard).
   */
  spray(x: number, y: number, z: number, dirX: number, dirZ: number, strength: number, time: number, boatSpeed?: number): void {
    const speed = boatSpeed ?? Math.max(0, this.camVel.x * dirX + this.camVel.z * dirZ);
    this.sprayFx.burst(x, y, z, dirX, dirZ, strength, time, speed, this.cam);
  }

  /** Height of the drawing area in device pixels (keeps the thinnest streaks about a pixel wide). */
  setViewport(heightPx: number): void {
    this.u.uPixel.value = 2 / Math.max(100, heightPx);
  }

  /** What is drawn this frame: draw calls, triangles, squalls, rain streaks. */
  stats(): { drawCalls: number; triangles: number; squalls: number; streaks: number } {
    let drawCalls = 0;
    let triangles = 0;
    for (const o of this.group.children) {
      const m = o as THREE.Mesh;
      if (!m.visible) continue;
      const g = m.geometry;
      const n = Math.min(g.drawRange.count, g.index ? g.index.count : g.getAttribute('position').count);
      if (n <= 0) continue;
      drawCalls++;
      triangles += n / 3;
    }
    return { drawCalls, triangles, squalls: this.squalls.drawn, streaks: this.rain.streaks };
  }

  /** The farthest any squall vertex lands from the camera this frame (metres; for the checks). */
  farthestDrawn(): number {
    return this.squalls.farthestDrawn(this.cam);
  }

  dispose(): void {
    this.squalls.dispose();
    this.rain.dispose();
    this.sprayFx.dispose();
  }
}
