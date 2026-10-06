/** Messages between the page and the sand engine (which may run on a background thread). */
import type { BrushSize, EngineSettings, ToolId } from '../config';
import type { CheckResult } from '../checks/sandChecks';
import type { SaveHeader } from './save';

export interface Ray {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface HitInfo {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

export type ToEngine =
  | { t: 'init'; save: ArrayBuffer | null; settings: EngineSettings; focus: [number, number, number] }
  | { t: 'focus'; x: number; y: number; z: number }
  | { t: 'stroke'; phase: 'begin' | 'move' | 'end' | 'cancel'; tool: ToolId; size: BrushSize; ray: Ray | null }
  | { t: 'hover'; ray: Ray | null }
  | { t: 'undo' }
  | { t: 'settings'; settings: EngineSettings }
  | { t: 'save'; id: number; header: Partial<SaveHeader> }
  | { t: 'load'; id: number; data: ArrayBuffer }
  | { t: 'reset' }
  | { t: 'checks'; id: number };

export interface TickEvents {
  dug: number;
  poured: number;
  pats: number;
  rubbed: number;
  slid: number;
  fell: number;
  landed: number;
  handFull: boolean;
  handEmpty: boolean;
}

export type FromEngine =
  | { t: 'hello' }
  | {
      t: 'tile';
      tile: number;
      positions: Float32Array;
      normals: Int8Array;
      attrs: Uint8Array;
      indices: Uint32Array;
      /** Top sand height for a 32x32 patch of the water-depth map. */
      heights: Float32Array;
      hx: number;
      hz: number;
    }
  | { t: 'clear' }
  | { t: 'progress'; done: number; total: number }
  | { t: 'ready'; mapW: number; mapH: number; mapCell: number; originX: number; originZ: number; sizeX: number; sizeZ: number }
  | {
      t: 'tick';
      hand: { amount: number; capacity: number; wet: number };
      hit: HitInfo | null;
      events: TickEvents;
      undo: number;
      particles: Float32Array;
      np: number;
      perf: { simMs: number; meshMs: number; queue: number; chunks: number; dirty: number };
    }
  | { t: 'saved'; id: number; data: ArrayBuffer | null; error?: string }
  | { t: 'loaded'; id: number; ok: boolean; error?: string; header?: SaveHeader }
  | { t: 'checks'; id: number; results: CheckResult[] }
  | { t: 'error'; message: string };
