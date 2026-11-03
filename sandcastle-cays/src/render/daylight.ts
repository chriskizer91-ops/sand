/**
 * The clock and the light (adapted from the raft game's weather). Every frame
 * this moves the sun and moon, and rewrites the shared SKY colours, the sun
 * and sky lights, the haze and the water's night glow. Weather (rain, storms)
 * comes in a later version; for now the trade-wind clouds come and go.
 */
import * as THREE from 'three';
import { DAY } from '../config';
import { SKY, type SkyDome } from './sky';
import type { Ocean } from './ocean';

const C = (hex: number) => new THREE.Color(hex);
const PAL = {
  zenithDay: C(0x2b78cf),
  zenithNight: C(0x070d1c),
  horizonDay: C(0xc4e2ee),
  horizonNight: C(0x101b2c),
  groundDay: C(0x2a8a96),
  groundNight: C(0x03111a),
  sunNoon: C(0xfff0d8),
  sunLow: C(0xff9248),
  moon: C(0x8aa0d8),
  sunsetGlow: C(0xffa877),
  duskZenith: C(0x3e5f9e),
};

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface Clock {
  day: number;
  hour: number;
}

export interface LightInfo {
  daylight: number;
  night: number;
  /** 0..1, how high the sun is. */
  sunHeight: number;
}

/** Daylight runs 6:00-20:00 over the top of the sky; the night half goes under. */
function sunAngle(h: number): number {
  if (h >= 6 && h < 20) return (Math.PI * (h - 6)) / 14;
  const n = ((h - 20 + 24) % 24) / 10;
  return Math.PI * (1 + n);
}

/** Advance the clock by dt real seconds. Returns true when a new day starts. */
export function advanceClock(clock: Clock, dt: number): boolean {
  const perHour = clock.hour >= 6 && clock.hour < 20 ? DAY.secondsPerHourDay : DAY.secondsPerHourNight;
  clock.hour += dt / perHour;
  if (clock.hour >= 24) {
    clock.hour -= 24;
    clock.day++;
    return true;
  }
  return false;
}

export function formatClock(clock: Clock): string {
  const h = Math.floor(clock.hour);
  const m = Math.floor((clock.hour - h) * 60);
  const ampm = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `Day ${clock.day} · ${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export class Daylight {
  /** Seconds between sky-lighting refreshes (the browser checks raise this). */
  envInterval = 2.5;
  private envTimer = 0;
  private tmp = new THREE.Color();
  readonly info: LightInfo = { daylight: 1, night: 0, sunHeight: 1 };
  /** The weather where you are: rain falling (0..1) and how close a squall's cloud is overhead (0..1). */
  readonly weather = { rain: 0, overhead: 0 };
  private rainGrey = C(0x7f8d95);

  constructor(
    private scene: THREE.Scene,
    private sun: THREE.DirectionalLight,
    private hemi: THREE.HemisphereLight,
    private sky: SkyDome,
    private ocean: Ocean,
    private onEnvironment: (env: THREE.Texture) => void,
  ) {}

  /** Force a sky-lighting refresh on the next update (after a jump in time). */
  refresh(): void {
    this.envTimer = 0;
  }

  update(dt: number, time: number, clock: Clock): LightInfo {
    const a = sunAngle(clock.hour);
    // The sun crosses a little south of overhead (the islands are about 18° north).
    SKY.trueSun.set(Math.cos(a), Math.sin(a) * 0.95, -0.32).normalize();
    SKY.moonDir.set(-Math.cos(a), -Math.sin(a) * 0.95, 0.3).normalize();
    const sy = SKY.trueSun.y;
    const daylight = smoothstep(-0.08, 0.15, sy);
    const night = 1 - smoothstep(-0.14, 0.04, sy);
    const sunset = (1 - smoothstep(0.0, 0.3, sy)) * smoothstep(-0.18, 0.0, sy);
    // Clouds build in the afternoon and thin out overnight.
    const cover = 0.12 + 0.18 * Math.max(0, Math.sin(((clock.hour - 9) / 24) * Math.PI * 2)) + 0.06 * Math.sin(clock.day * 2.3);
    SKY.night = night;
    // Under a squall the sky closes over and darkens.
    const wet = this.weather.rain;
    const over = Math.max(wet, this.weather.overhead);
    SKY.cover = Math.max(0, cover) * (1 - over) + 0.95 * over;
    SKY.storm = 0.85 * over;
    SKY.flash = 0;

    if (sy > 0.02) {
      SKY.sunDir.copy(SKY.trueSun);
      if (SKY.sunDir.y < 0.08) {
        SKY.sunDir.y = 0.08;
        SKY.sunDir.normalize();
      }
      SKY.sunColor.copy(PAL.sunLow).lerp(PAL.sunNoon, smoothstep(0.12, 0.5, sy));
    } else {
      SKY.sunDir.copy(SKY.moonDir);
      if (SKY.sunDir.y < 0.1) {
        SKY.sunDir.y = 0.1;
        SKY.sunDir.normalize();
      }
      SKY.sunColor.copy(PAL.moon).multiplyScalar(0.55);
    }

    SKY.zenith.copy(PAL.zenithNight).lerp(PAL.zenithDay, daylight);
    SKY.horizon.copy(PAL.horizonNight).lerp(PAL.horizonDay, daylight);
    // Golden hour: the horizon warms toward peach and the high sky deepens.
    SKY.horizon.lerp(PAL.sunsetGlow, sunset * 0.72);
    SKY.zenith.lerp(PAL.duskZenith, sunset * 0.45);
    SKY.ground.copy(PAL.groundNight).lerp(PAL.groundDay, daylight);
    // Rain greys the haze.
    if (over > 0) SKY.horizon.lerp(this.tmp.copy(this.rainGrey).multiplyScalar(0.25 + 0.75 * daylight), 0.65 * over);

    // Under a squall's cloud the sun is hidden: its light and its glitter on the water fade.
    SKY.sunColor.multiplyScalar(1 - 0.7 * over);
    const dim = (1 - 0.5 * SKY.cover) * (1 - 0.25 * over);
    this.sun.color.copy(SKY.sunColor);
    this.sun.intensity = sy > 0.02 ? 3.3 * smoothstep(0.0, 0.18, sy) * dim : 1.5 * night;
    // Golden hour: less cool sky-fill, so the low warm sun shows.
    this.hemi.intensity = 0.55 * (0.55 + 0.45 * daylight) * (1 - 0.35 * sunset) * (1 - 0.25 * over);
    this.hemi.color.copy(SKY.horizon).lerp(PAL.horizonDay, 0.5 * (1 - sunset));
    this.hemi.groundColor.copy(this.tmp.setRGB(0.78, 0.7, 0.55).multiplyScalar(0.3 + 0.7 * daylight));

    const fog = this.scene.fog as THREE.FogExp2;
    fog.color.copy(SKY.horizon);
    // In heavy rain you can see a couple of hundred metres.
    fog.density = 0.0026 + night * 0.002 + 0.0042 * wet;
    this.ocean.setLight(daylight * (1 - 0.35 * SKY.cover), night, fog.density);

    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = this.envInterval;
      this.onEnvironment(this.sky.capture(time));
    }
    this.info.daylight = daylight;
    this.info.night = night;
    this.info.sunHeight = Math.max(0, sy);
    return this.info;
  }
}
