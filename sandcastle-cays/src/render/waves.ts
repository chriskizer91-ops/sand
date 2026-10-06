/**
 * The waves on the lagoon. The same numbers drive the water surface you see (in
 * the GPU shader) and the boat's bobbing (here on the CPU), so the boat rides
 * exactly the waves on screen.
 */

export interface Wave {
  /** Direction of travel (normalised x, z). */
  dx: number;
  dz: number;
  /** Height in metres. */
  amp: number;
  /** Wavelength in metres. */
  length: number;
  /** Gerstner steepness 0..1 (how much crests sharpen). */
  steep: number;
}

function wave(dirX: number, dirZ: number, amp: number, length: number, steep: number): Wave {
  const l = Math.hypot(dirX, dirZ);
  return { dx: dirX / l, dz: dirZ / l, amp, length, steep };
}

/** Gentle lagoon swell rolling toward the beach (+z), plus a cross swell. */
export const LAGOON_WAVES: Wave[] = [wave(0.15, 1, 0.028, 6.5, 0.5), wave(-0.45, 1, 0.014, 3.1, 0.45), wave(0.7, 0.7, 0.007, 1.9, 0.35)];

const G = 9.81;

/** Water surface height (metres above the still level) at x, z and time t. */
export function waveHeight(waves: Wave[], x: number, z: number, t: number, ampScale = 1): number {
  let y = 0;
  for (const w of waves) {
    const k = (2 * Math.PI) / w.length;
    const c = Math.sqrt(G / k);
    const phase = k * (w.dx * x + w.dz * z - c * t);
    y += w.amp * ampScale * Math.sin(phase);
  }
  return y;
}

/** GLSL for the same waves: returns displaced position offset and normal. */
export function wavesGLSL(waves: Wave[]): string {
  let body = '';
  for (const w of waves) {
    const k = (2 * Math.PI) / w.length;
    const c = Math.sqrt(G / k);
    body += `
  {
    vec2 D = vec2(${w.dx.toFixed(5)}, ${w.dz.toFixed(5)});
    float k = ${k.toFixed(5)};
    float A = ${w.amp.toFixed(5)} * ampScale;
    float Q = ${w.steep.toFixed(4)};
    float ph = k * (dot(D, p) - ${c.toFixed(5)} * t);
    float s = sin(ph);
    float co = cos(ph);
    off.x += Q * A * D.x * co;
    off.z += Q * A * D.y * co;
    off.y += A * s;
    dydx += k * A * D.x * co;
    dydz += k * A * D.y * co;
  }`;
  }
  return `
vec3 gerstner(vec2 p, float t, float ampScale, out vec3 nrm) {
  vec3 off = vec3(0.0);
  float dydx = 0.0;
  float dydz = 0.0;${body}
  nrm = normalize(vec3(-dydx, 1.0, -dydz));
  return off;
}`;
}
