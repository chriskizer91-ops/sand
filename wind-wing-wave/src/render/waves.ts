/**
 * The sea surface as a function (WP-E2 owns the body): the same Gerstner swell the ocean shader
 * draws, so floating things (coconuts, rafts, birds resting on the water) ride the visible waves.
 * STUB (lead): flat sea. WP-E2 replaces the body; keep the signature.
 */
import { SEA_LEVEL } from '../config';

/**
 * Water surface height at world (x, z) and time t (seconds, unwrapped), for storm level 0..1
 * and local water depth (m, positive; small depths damp the swell).
 */
export function seaHeight(x: number, z: number, t: number, storm: number, depth: number): number {
  void x;
  void z;
  void t;
  void storm;
  void depth;
  return SEA_LEVEL;
}
