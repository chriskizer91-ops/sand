/**
 * Pink Sand Cay: a small, low island out beyond Home Cay's reef, to the
 * south-west. Its beaches are pink: in the Caribbean, pink sand gets its
 * colour from the broken red-pink shells of tiny sea creatures (forams)
 * mixed in with the white coral sand.
 *
 * It rises from the deep sea floor on its own shelf, with a sheltered
 * anchorage on its west (downwind) side. Rocky only at its north-east tip.
 */
import { Noise2D, clamp, smoothstep } from '../engine/noise';
import type { Ground, IslandTerrain, Rect, TidePoint } from './islands';

const CX = -210;
const CZ = -300;
const AX = 44;
const AZ = 26;
/** The island's long axis turns this far from east-west. */
const TURN = 0.45;

export class PinkCayTerrain implements IslandTerrain {
  readonly id = 'pink' as const;
  readonly name = 'Pink Sand Cay';
  readonly waterLevel = 0;
  /** No sandcastle sand here (yet). */
  readonly region: Rect = { x0: 1e6, x1: 1e6, z0: 1e6, z1: 1e6 };
  readonly bounds: Rect = { x0: CX - 176, x1: CX + 176, z0: CZ - 160, z1: CZ + 160 };
  readonly land: Rect = { x0: CX - 50, x1: CX + 50, z0: CZ - 42, z1: CZ + 42 };
  /** On the north-west side, sheltered from the trade wind by the island, in about 4.5 m of water. */
  readonly anchorage = { x: -258, z: -258, heading: 0 };
  private noise = new Noise2D(2718);
  private noise2 = new Noise2D(3141);

  /** @param base the sea floor around it (Home Cay's deep water) */
  constructor(private base: (x: number, z: number) => number) {}

  private local(x: number, z: number): [number, number] {
    const dx = x - CX;
    const dz = z - CZ;
    const c = Math.cos(-TURN);
    const s = Math.sin(-TURN);
    return [dx * c - dz * s, dx * s + dz * c];
  }

  coastRadius(th: number): number {
    const c = Math.cos(th);
    const s = Math.sin(th);
    const ell = 1 / Math.sqrt((c / AX) ** 2 + (s / AZ) ** 2);
    return ell + 2.6 * Math.sin(3 * th + 1.1) + 1.4 * Math.sin(5 * th + 0.4);
  }

  inland(x: number, z: number): number {
    const [lx, lz] = this.local(x, z);
    return this.coastRadius(Math.atan2(lz, lx)) - Math.hypot(lx, lz);
  }

  rockiness(x: number, z: number): number {
    const [lx, lz] = this.local(x, z);
    // The north-east tip faces the trade wind and is rocky.
    const tip = 1 - smoothstep(10, 22, Math.hypot(lx - AX * 0.85, lz - AZ * 0.35));
    return clamp(tip + 0.12 * this.noise2.noise(x * 0.09, z * 0.09), 0, 1);
  }

  private own(x: number, z: number): number {
    const s = this.inland(x, z);
    let h: number;
    if (s >= 0) {
      h = 0.5 * (1 - Math.exp(-s / 3.5)) + 0.012 * s;
      // A low dune ridge along the middle.
      h += 1.8 * smoothstep(6, 16, s) * (0.8 + 0.3 * this.noise.fbm(x * 0.05, z * 0.05, 2));
      h += this.rockiness(x, z) * (0.5 * smoothstep(-0.5, 2.5, s) + 0.25 * this.noise2.fbm(x * 0.7, z * 0.7, 2));
    } else {
      // A gentle sandy shelf, then down to the deep floor.
      h = -0.85 * (1 - Math.exp(s / 5.0));
      if (s < -6) h -= 0.12 * (-s - 6);
      h += 0.04 * this.noise2.noise(x * 0.9, z * 0.35) * smoothstep(-2, -10, s);
    }
    h += this.noise.fbm(x * 0.32, z * 0.32, 3) * 0.03;
    // Fade out toward the edge of its area, so it meets the open sea floor without a step.
    const b = this.bounds;
    const edge = Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z);
    h -= 40 * (1 - smoothstep(0, 30, edge));
    return Math.max(h, -40);
  }

  heightAt(x: number, z: number): number {
    return Math.max(this.own(x, z), this.base(x, z));
  }

  wetAt(_x: number, y: number): number {
    return y < 0 ? 255 : 60;
  }

  packAt(): number {
    return 150;
  }

  groundAt(x: number, z: number, h = this.heightAt(x, z)): Ground {
    const s = this.inland(x, z);
    if (h < -0.6) {
      const grass = this.noise2.fbm(x * 0.05, z * 0.05, 3);
      return grass > 0.25 && h < -2 && h > -9 ? 'seagrass' : 'sand';
    }
    if (this.rockiness(x, z) > 0.55 && s > -3 && s < 8) return 'rock';
    const grassLine = 8 + 2.5 * this.noise.noise(x * 0.12, z * 0.12);
    if (s > grassLine) return 'grass';
    return 'pinksand';
  }

  tideline(spacing = 0.7): TidePoint[] {
    const out: TidePoint[] = [];
    const steps = 1600;
    let carry = 0;
    let px = NaN;
    let pz = NaN;
    const c = Math.cos(TURN);
    const sn = Math.sin(TURN);
    for (let i = 0; i < steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      const r = this.coastRadius(th) - 2.4;
      const lx = Math.cos(th) * r;
      const lz = Math.sin(th) * r;
      const wx = CX + lx * c - lz * sn;
      const wz = CZ + lx * sn + lz * c;
      const nx = Math.cos(th) * c - Math.sin(th) * sn;
      const nz = Math.cos(th) * sn + Math.sin(th) * c;
      if (!Number.isNaN(px)) carry += Math.hypot(wx - px, wz - pz);
      px = wx;
      pz = wz;
      if (carry < spacing) continue;
      carry = 0;
      if (this.rockiness(wx, wz) > 0.4) continue;
      const h = this.heightAt(wx, wz);
      if (h < 0.08 || h > 0.9) continue;
      out.push({ x: wx, z: wz, nx, nz, island: 'pink' });
    }
    return out;
  }
}
