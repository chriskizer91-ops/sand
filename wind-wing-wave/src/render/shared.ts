/**
 * Shared page-side contracts: the frame context, page systems, shared shader uniforms
 * and quality settings. Lead-owned (docs/ARCHITECTURE.md §6).
 */
import * as THREE from 'three';
import { NX, NZ, CELL, ORIGIN_X, ORIGIN_Z, SEA_LEVEL, type QualityId, type Season, type ToolId } from '../config';
import type { SpeciesDef } from '../content/speciesTypes';
import type { FromEngine, LifeInfo, StormState } from '../engine/protocol';
import type { WorldFields } from './fields';

/** Shared uniforms. Daylight (WP-G) and weather write them; every material reads them by reference. */
export interface WorldUniforms {
  /** Real time in seconds, wrapped to [0, 3600) so shaders keep precision over long sessions. */
  uTime: { value: number };
  /** Direction TO the sun (or moon at night), world space, unit. */
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSkyColor: { value: THREE.Color };
  uGroundColor: { value: THREE.Color };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  /** 0 day .. 1 night */
  uNight: { value: number };
  /** 0 calm .. 1 storm peak */
  uStorm: { value: number };
  /** xy = wind direction * strength (0..1), z = gust 0..1, w = storm */
  uWind: { value: THREE.Vector4 };
  /** 0..1 rain intensity */
  uRain: { value: number };
  /** 0..1 surfaces still wet after rain */
  uWet: { value: number };
  /** 0..1 dry-season mood */
  uDry: { value: number };
  /** originX, originZ, sizeX, sizeZ */
  uZone: { value: THREE.Vector4 };
  uSeaLevel: { value: number };
  uCamPos: { value: THREE.Vector3 };
  /** x, z, radius, strength 0..1 of the biggest molten lava area */
  uLavaGlow: { value: THREE.Vector4 };
  /** World data textures (see WorldFields). */
  uHeightTex: { value: THREE.DataTexture };
  uGroundTex: { value: THREE.DataTexture };
  uCoverATex: { value: THREE.DataTexture };
  uCoverBTex: { value: THREE.DataTexture };
  uCoverCTex: { value: THREE.DataTexture };
}

export function createWorldUniforms(fields: WorldFields): WorldUniforms {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.45, 0.8, -0.35).normalize() },
    uSunColor: { value: new THREE.Color(0xfff2d6) },
    uSkyColor: { value: new THREE.Color(0xcfe9ff) },
    uGroundColor: { value: new THREE.Color(0xe8d4a8) },
    uFogColor: { value: new THREE.Color(0xd9f1ff) },
    uFogNear: { value: 600 },
    uFogFar: { value: 6000 },
    uNight: { value: 0 },
    uStorm: { value: 0 },
    uWind: { value: new THREE.Vector4(-0.35, 0, 0.5, 0) },
    uRain: { value: 0 },
    uWet: { value: 0 },
    uDry: { value: 0 },
    uZone: { value: new THREE.Vector4(ORIGIN_X, ORIGIN_Z, NX * CELL, NZ * CELL) },
    uSeaLevel: { value: SEA_LEVEL },
    uCamPos: { value: new THREE.Vector3() },
    uLavaGlow: { value: new THREE.Vector4(0, 0, 0, 0) },
    uHeightTex: { value: fields.heightTex },
    uGroundTex: { value: fields.groundTex },
    uCoverATex: { value: fields.coverATex },
    uCoverBTex: { value: fields.coverBTex },
    uCoverCTex: { value: fields.coverCTex },
  };
}

/** GLSL declarations matching WorldUniforms (paste into shaders that use them). */
export const WORLD_UNIFORMS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uNight;
uniform float uStorm;
uniform vec4 uWind;
uniform float uRain;
uniform float uWet;
uniform float uDry;
uniform vec4 uZone;
uniform float uSeaLevel;
uniform vec3 uCamPos;
uniform vec4 uLavaGlow;
`;

/** Rendering quality, decided by main.ts from the setting, device and measured frame time. */
export interface Quality {
  setting: QualityId;
  /** Phone-class device (touch, small screen). */
  phone: boolean;
  /** 0 lighter .. 2 richer (auto picks 1 on phone, 2 on laptop, and may step down). */
  tier: 0 | 1 | 2;
  /** Multiplier for agent and instance caps (0.5..1.5). */
  density: number;
  shadows: boolean;
}

/** The day clock (owned by daylight, WP-G; read by everyone). */
export interface DayState {
  /** 0..1 within the 16-minute day; 0 = start of dawn. */
  phase: number;
  part: 'dawn' | 'day' | 'dusk' | 'night';
  season: Season;
  /** 0..1 how far into the season cycle. */
  seasonPhase: number;
  /** Day count since the game started. */
  day: number;
  /** Moon phase 0..1 (0 new, 0.5 full). */
  moon: number;
}

/** Orbit camera state (read-only for systems). */
export interface CamState {
  target: THREE.Vector3;
  dist: number;
  yaw: number;
  pitch: number;
}

export interface FrameCtx {
  /** Seconds since start (unwrapped, double precision). Use u.uTime in shaders. */
  t: number;
  dt: number;
  camera: THREE.PerspectiveCamera;
  cam: CamState;
  fields: WorldFields;
  u: WorldUniforms;
  quality: Quality;
  day: DayState;
  year: number;
  firstLand: boolean;
  storm: StormState;
  life: LifeInfo | null;
  /** Current tool and whether a stroke is happening (for hands, cursor and sound). */
  tool: ToolId;
  stroking: boolean;
  /** UI is faded (watch mode). */
  watching: boolean;
  /** Where the brush is (hover or stroke), or null. */
  brush: BrushInfo | null;
  isTouch: boolean;
}

export interface BrushInfo {
  x: number;
  y: number;
  z: number;
  /** Surface normal. */
  nx: number;
  ny: number;
  nz: number;
  /** Radius in metres. */
  r: number;
}

/** Every page system implements this. main.ts calls update() once per rendered frame. */
export interface PageSystem {
  readonly name: string;
  onEngine?(m: FromEngine): void;
  update(f: FrameCtx): void;
  dispose?(): void;
}

/** What every system factory receives. */
export interface SystemDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  fields: WorldFields;
  u: WorldUniforms;
  quality: Quality;
  species: readonly SpeciesDef[];
  isTouch: boolean;
}

/** Add the shared uniforms (by reference) to a shader in onBeforeCompile. */
export function addWorldUniforms(shader: { uniforms: Record<string, THREE.IUniform> }, u: WorldUniforms): void {
  for (const [k, v] of Object.entries(u)) shader.uniforms[k] = v as THREE.IUniform;
}

/** Wrap real time for shader precision (period 3600 s; periodic shader motions should use periods that divide it). */
export function wrapTime(t: number): number {
  return t % 3600;
}
