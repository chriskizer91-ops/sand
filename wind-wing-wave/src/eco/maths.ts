/**
 * Small exact-maths helpers for the life simulation (DECISIONS 6).
 *
 * Why these shapes:
 * - Growth uses the exact logistic solution, so a big time step never overshoots and a
 *   1-year step and eight 1-year steps give the same answer.
 * - Decline uses exponential relaxation, which can never go below its target.
 * - Every chance is p = 1 - e^(-rate * dt), so a rate that is "once a century" stays
 *   honest whatever the step size.
 * - Random rolls for patches come from a hash of (patch, step, purpose), so the result
 *   does not depend on how the work was sliced across frames.
 */

/** Exact logistic growth of cover `c` toward capacity `K` at rate `r` per year, over `dt` years. */
export function logistic(c: number, K: number, r: number, dt: number): number {
  if (c <= 0 || K <= 0) return 0;
  return K / (1 + (K / c - 1) * Math.exp(-r * dt));
}

/** Exponential relaxation of `c` toward `K` with time constant `tau` years. */
export function relax(c: number, K: number, tau: number, dt: number): number {
  return K + (c - K) * Math.exp(-dt / tau);
}

/** Chance that a Poisson event with `rate` per year happens within `dt` years. */
export function chance(rate: number, dt: number): number {
  return rate <= 0 ? 0 : 1 - Math.exp(-rate * dt);
}

/** Logistic rate that takes cover from 5% to 95% of capacity in `years`. */
export function growRate(years: number): number {
  return 5.889 / Math.max(1, years); // ln(19 * 19) = 5.889
}

/**
 * A hashed random number in [0, 1) for patch `p` at step `step` for purpose `salt`.
 * Integer-only (no Math.sin), so it is identical on every device.
 */
export function hrand(p: number, step: number, salt: number, seed: number): number {
  let h = Math.imul(p ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((step + Math.imul(salt, 0x632be5ab)) | 0, 0xc2b2ae35) ^ seed;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 1 inside [lo, hi], falling linearly to 0 over `soft` beyond either edge. */
export function band(x: number, lo: number, hi: number, soft: number): number {
  if (x < lo) return x <= lo - soft ? 0 : 1 - (lo - x) / soft;
  if (x > hi) return x >= hi + soft ? 0 : 1 - (x - hi) / soft;
  return 1;
}

/** Trapezoid: 0 below a, rising to 1 at b, 1 until c, falling to 0 at d. */
export function trapezoid(x: number, a: number, b: number, c: number, d: number): number {
  if (x < b) return x <= a ? 0 : (x - a) / (b - a);
  if (x > c) return x >= d ? 0 : (d - x) / (d - c);
  return 1;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Performance clock that works in a worker, on the page and in node. */
export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
