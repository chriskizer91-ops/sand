/**
 * Hands-on tools: find where a finger points at the sand, and dig, pile or pat there.
 */
import { CELL, HAND_CAPACITY } from '../config';
import { mulberry32 } from './noise';
import type { Sim } from './sim';
import type { World } from './world';

export interface Hit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  dist: number;
}

/** Sand carried in your hands. Amounts are in fill units (255 = one 3 cm cell). */
export class Hand {
  amount = 0;
  wetSum = 0;
  capacity = HAND_CAPACITY;
  get wet(): number {
    return this.amount > 0 ? this.wetSum / this.amount : 0;
  }
  add(amount: number, wet: number): void {
    this.amount += amount;
    this.wetSum += amount * wet;
  }
  take(amount: number): number {
    const a = Math.min(amount, this.amount);
    const w = this.wet;
    this.amount -= a;
    this.wetSum = this.amount > 0 ? Math.max(0, this.wetSum - a * w) : 0;
    return a;
  }
  get space(): number {
    return Math.max(0, this.capacity - this.amount);
  }
}

/** Smoothed sand density (0..1) at a point: cells are sampled at their centres. */
export function densityAt(world: World, x: number, y: number, z: number): number {
  const u = (x - world.originX) / CELL - 0.5;
  const v = (y - world.originY) / CELL - 0.5;
  const w = (z - world.originZ) / CELL - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const k = Math.floor(w);
  const fu = u - i;
  const fv = v - j;
  const fw = w - k;
  const c000 = world.fillAt(i, j, k);
  const c100 = world.fillAt(i + 1, j, k);
  const c010 = world.fillAt(i, j + 1, k);
  const c110 = world.fillAt(i + 1, j + 1, k);
  const c001 = world.fillAt(i, j, k + 1);
  const c101 = world.fillAt(i + 1, j, k + 1);
  const c011 = world.fillAt(i, j + 1, k + 1);
  const c111 = world.fillAt(i + 1, j + 1, k + 1);
  const a = c000 + (c100 - c000) * fu;
  const b = c010 + (c110 - c010) * fu;
  const c = c001 + (c101 - c001) * fu;
  const d = c011 + (c111 - c011) * fu;
  const e = a + (b - a) * fv;
  const f = c + (d - c) * fv;
  return (e + (f - e) * fw) / 255;
}

/** Find where a ray first meets the sand surface inside the editable area. */
export function raycast(
  world: World,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist = 80,
): Hit | null {
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len;
  dy /= len;
  dz /= len;
  const bmin = [world.originX, world.originY, world.originZ];
  const bmax = [world.originX + world.nx * CELL, world.originY + world.ny * CELL, world.originZ + world.nz * CELL];
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  let t0 = 0;
  let t1 = maxDist;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < bmin[a] || o[a] > bmax[a]) return null;
      continue;
    }
    let ta = (bmin[a] - o[a]) / d[a];
    let tb = (bmax[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return null;
  }
  const h = CELL * 0.5;
  let prevT = t0;
  for (let t = t0; t <= t1; t += h) {
    const den = densityAt(world, ox + dx * t, oy + dy * t, oz + dz * t);
    if (den >= 0.5) {
      // Refine the crossing between the previous and current sample.
      let lo = prevT;
      let hi = t;
      for (let it = 0; it < 7; it++) {
        const mid = (lo + hi) / 2;
        if (densityAt(world, ox + dx * mid, oy + dy * mid, oz + dz * mid) >= 0.5) hi = mid;
        else lo = mid;
      }
      const x = ox + dx * hi;
      const y = oy + dy * hi;
      const z = oz + dz * hi;
      const e = CELL * 0.75;
      let nx = densityAt(world, x - e, y, z) - densityAt(world, x + e, y, z);
      let ny = densityAt(world, x, y - e, z) - densityAt(world, x, y + e, z);
      let nz = densityAt(world, x, y, z - e) - densityAt(world, x, y, z + e);
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-6) {
        nx = 0;
        ny = 1;
        nz = 0;
      } else {
        nx /= nl;
        ny /= nl;
        nz /= nl;
      }
      return { x, y, z, nx, ny, nz, dist: hi };
    }
    prevT = t;
  }
  return null;
}

/** How fast the centre of the brush empties (fraction of a cell per second). */
const DIG_SPEED = 3.5;

/** Scoop sand from around the hit point into your hands. Returns the amount dug. */
export function dig(sim: Sim, hand: Hand, hit: Hit, radius: number, dt: number): number {
  const world = sim.world;
  if (hand.space <= 0) return 0;
  const cx = hit.x - hit.nx * radius * 0.35;
  const cy = hit.y - hit.ny * radius * 0.35;
  const cz = hit.z - hit.nz * radius * 0.35;
  const r = radius;
  const ci0 = Math.floor((cx - r - world.originX) / CELL);
  const ci1 = Math.floor((cx + r - world.originX) / CELL);
  const cj0 = Math.max(1, Math.floor((cy - r - world.originY) / CELL));
  const cj1 = Math.floor((cy + r - world.originY) / CELL);
  const ck0 = Math.floor((cz - r - world.originZ) / CELL);
  const ck1 = Math.floor((cz + r - world.originZ) / CELL);
  let total = 0;
  // Work from the top down so the scoop follows the surface.
  for (let j = cj1; j >= cj0; j--) {
    for (let k = ck0; k <= ck1; k++) {
      for (let i = ci0; i <= ci1; i++) {
        if (!world.inRegion(i, j, k)) continue;
        const ddx = world.cellX(i) - cx;
        const ddy = world.cellY(j) - cy;
        const ddz = world.cellZ(k) - cz;
        const d2 = (ddx * ddx + ddy * ddy + ddz * ddz) / (r * r);
        if (d2 >= 1) continue;
        const f = world.fillAt(i, j, k);
        if (f === 0) continue;
        const wgt = 1 - d2;
        let take = Math.min(f, Math.ceil(255 * wgt * DIG_SPEED * dt));
        if (take > hand.space) take = Math.floor(hand.space);
        if (take <= 0) continue;
        const c = world.chunkForCell(i, j, k);
        const li = (i & 15) | ((k & 15) << 4) | ((j & 15) << 8);
        world.touch(c);
        const wet = c.wet[li];
        const nf = f - take;
        c.fill[li] = nf;
        if (nf === 0) {
          c.wet[li] = 0;
          c.pack[li] = 0;
        }
        world.changed(c, li);
        hand.add(take, wet);
        total += take;
      }
    }
  }
  if (total > 0) {
    sim.wakeBox(ci0 - 1, cj0 - 1, ck0 - 1, ci1 + 1, cj1 + 2, ck1 + 1);
    sprayFrom(sim, hit, Math.min(14, 2 + total / 120), hand.wet);
  }
  return total;
}

const sprayRng = mulberry32(7);

/** Little puffs of grains thrown up by digging (just for show; they carry no sand). */
function sprayFrom(sim: Sim, hit: Hit, count: number, wet: number): void {
  for (let n = 0; n < count; n++) {
    const a = sprayRng() * Math.PI * 2;
    const s = 0.4 + sprayRng() * 0.9;
    sim.particles.add(
      hit.x + hit.nx * 0.01,
      hit.y + hit.ny * 0.01,
      hit.z + hit.nz * 0.01,
      hit.nx * s + Math.cos(a) * 0.5 * s,
      hit.ny * s * 1.4 + 0.6,
      hit.nz * s + Math.sin(a) * 0.5 * s,
      0,
      Math.round(wet),
      0.35 + sprayRng() * 0.3,
      -1,
    );
  }
}

/** Pour sand from your hands so it falls onto the hit point. Returns the amount poured. */
export function pile(sim: Sim, hand: Hand, hit: Hit, radius: number, ratePerSecond: number, dt: number): number {
  if (hand.amount <= 0) return 0;
  const world = sim.world;
  const want = Math.min(hand.amount, Math.round(ratePerSecond * 255 * dt));
  if (want <= 0) return 0;
  const wet = Math.round(hand.wet);
  const poured = hand.take(want);
  const dropHeight = 0.12 + radius * 1.2;
  let left = poured;
  while (left > 0) {
    const amt = Math.min(left, 96);
    left -= amt;
    const a = sprayRng() * Math.PI * 2;
    const r = Math.sqrt(sprayRng()) * radius * 0.55;
    const ok = sim.particles.add(
      hit.x + Math.cos(a) * r,
      hit.y + dropHeight + sprayRng() * 0.03,
      hit.z + Math.sin(a) * r,
      (sprayRng() - 0.5) * 0.12,
      -0.4 - sprayRng() * 0.3,
      (sprayRng() - 0.5) * 0.12,
      amt,
      wet,
      0,
      world.undoRecordId,
    );
    if (!ok) {
      // No room for more falling grains this moment: put the rest back in your hands.
      hand.add(amt + left, wet);
      return poured - (amt + left);
    }
  }
  return poured;
}

/**
 * Pat the sand: packs it firmer and evens out small bumps.
 * `strength` 1 = a pat, smaller = a gentle rub.
 */
export function pat(sim: Sim, hit: Hit, radius: number, strength: number): number {
  const world = sim.world;
  const r = radius;
  const ci0 = Math.floor((hit.x - r - world.originX) / CELL);
  const ci1 = Math.floor((hit.x + r - world.originX) / CELL);
  const ck0 = Math.floor((hit.z - r - world.originZ) / CELL);
  const ck1 = Math.floor((hit.z + r - world.originZ) / CELL);
  const hj = Math.floor((hit.y - world.originY) / CELL);
  const reach = Math.ceil(r / CELL) + 2;
  // 1. Pack: press the sand under the hand firmer, a few cells deep.
  let packed = 0;
  for (let j = Math.max(0, hj - reach); j <= Math.min(world.ny - 1, hj + reach); j++) {
    for (let k = ck0; k <= ck1; k++) {
      for (let i = ci0; i <= ci1; i++) {
        if (!world.inRegion(i, j, k)) continue;
        const ddx = world.cellX(i) - hit.x;
        const ddy = world.cellY(j) - hit.y;
        const ddz = world.cellZ(k) - hit.z;
        const d2 = (ddx * ddx + ddy * ddy * 0.5 + ddz * ddz) / (r * r);
        if (d2 >= 1) continue;
        // Only sand near the surface, on the side the hand presses from.
        const along = -(ddx * hit.nx + ddy * hit.ny + ddz * hit.nz);
        if (along > CELL * 4 || along < -CELL * 1.5) continue;
        const f = world.fillAt(i, j, k);
        if (f === 0) continue;
        const c = world.chunkForCell(i, j, k);
        const li = (i & 15) | ((k & 15) << 4) | ((j & 15) << 8);
        const p = c.pack[li];
        const np = Math.min(255, Math.round(p + 75 * strength * (1 - d2)));
        if (np !== p) {
          world.touch(c);
          c.pack[li] = np;
          world.changed(c, li);
          packed++;
        }
      }
    }
  }
  // 2. Smooth: move a little sand from higher columns to lower neighbours under the hand.
  const nI = ci1 - ci0 + 1;
  const nK = ck1 - ck0 + 1;
  const topJ = new Int32Array(nI * nK).fill(-1);
  const height = new Float32Array(nI * nK);
  for (let k = ck0; k <= ck1; k++) {
    for (let i = ci0; i <= ci1; i++) {
      if (!world.inRegionXZ(i, k)) continue;
      const ddx = world.cellX(i) - hit.x;
      const ddz = world.cellZ(k) - hit.z;
      if (ddx * ddx + ddz * ddz >= r * r) continue;
      // Surface cell near the hand: has sand, and the cell above has little.
      for (let j = Math.min(world.ny - 2, hj + reach); j >= Math.max(1, hj - reach); j--) {
        const f = world.fillAt(i, j, k);
        if (f > 0 && world.fillAt(i, j + 1, k) === 0 && world.fillAt(i, j - 1, k) >= 128) {
          const o = i - ci0 + (k - ck0) * nI;
          topJ[o] = j;
          height[o] = j + f / 255;
          break;
        }
      }
    }
  }
  const kappa = 0.45 * strength;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = ck0; k <= ck1; k++) {
      for (let i = ci0; i <= ci1; i++) {
        const o = i - ci0 + (k - ck0) * nI;
        if (topJ[o] < 0) continue;
        for (let dir = 0; dir < 2; dir++) {
          const i2 = dir === 0 ? i + 1 : i;
          const k2 = dir === 0 ? k : k + 1;
          if (i2 > ci1 || k2 > ck1) continue;
          const o2 = i2 - ci0 + (k2 - ck0) * nI;
          if (topJ[o2] < 0) continue;
          const diff = height[o] - height[o2];
          if (Math.abs(diff) < 0.04 || Math.abs(diff) > 2.5) continue;
          const ddx = world.cellX(i) - hit.x;
          const ddz = world.cellZ(k) - hit.z;
          const wgt = 1 - (ddx * ddx + ddz * ddz) / (r * r);
          const hiO = diff > 0 ? o : o2;
          const loO = diff > 0 ? o2 : o;
          const hiI = diff > 0 ? i : i2;
          const hiK = diff > 0 ? k : k2;
          const loI = diff > 0 ? i2 : i;
          const loK = diff > 0 ? k2 : k;
          const fHi = world.fillAt(hiI, topJ[hiO], hiK);
          let m = Math.min(fHi, Math.floor(Math.abs(diff) * 0.5 * kappa * wgt * 255));
          if (m < 2) continue;
          let loJ = topJ[loO];
          if (world.fillAt(loI, loJ, loK) === 255) loJ++;
          if (loJ >= world.ny) continue;
          m = Math.min(m, 255 - world.fillAt(loI, loJ, loK));
          if (m <= 0) continue;
          sim.transfer(hiI, topJ[hiO], hiK, loI, loJ, loK, m, false);
          height[hiO] -= m / 255;
          height[loO] += m / 255;
          if (loJ !== topJ[loO]) topJ[loO] = loJ;
        }
      }
    }
  }
  sim.wakeBox(ci0 - 1, hj - reach, ck0 - 1, ci1 + 1, hj + reach, ck1 + 1);
  return packed;
}
