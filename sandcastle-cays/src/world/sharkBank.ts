/**
 * Shark Bank: a sandbar out to the north-west of Home Cay. A narrow strip of
 * bare white sand, just above the water, sits in the middle of wide sand
 * flats that are only knee to waist deep for 60 metres all round. Then the
 * bank drops away to the deep blue.
 *
 * The flats are too shallow for the catamaran (she draws 1.3 m), so you
 * anchor off the west side and take the dinghy in. Nurse sharks spend the
 * day resting on the flats. The sea leaves its rarest finds on the bar.
 *
 * Real sandbars like this form where currents meet and drop their sand. The
 * water over them is so clear and shallow that it glows pale turquoise.
 */
import { Noise2D, smoothstep } from '../engine/noise';
import type { Ground, IslandTerrain, Rect, TidePoint } from './islands';

export const BANK = { x: -330, z: 210 };
const CX = BANK.x;
const CZ = BANK.z;
/** Half the bar's length and width (metres). */
const AX = 24;
const AZ = 6.5;
/** The bar's long axis turns this far from east-west. */
const TURN = 0.3;
/** The flats reach this far out from the bar, then the bank drops away. */
const FLATS = 60;

export class SharkBankTerrain implements IslandTerrain {
  readonly id = 'bank' as const;
  readonly name = 'Shark Bank';
  readonly waterLevel = 0;
  readonly region: Rect = { x0: 1e6, x1: 1e6, z0: 1e6, z1: 1e6 };
  readonly bounds: Rect = { x0: CX - 160, x1: CX + 160, z0: CZ - 150, z1: CZ + 150 };
  readonly land: Rect = { x0: CX - AX - 4, x1: CX + AX + 4, z0: CZ - 16, z1: CZ + 16 };
  /** Off the west (downwind) side, in about 4 m of water, clear of the flats. */
  readonly anchorage: { x: number; z: number; heading: number };
  private noise = new Noise2D(4242);
  private noise2 = new Noise2D(5151);

  constructor(private base: (x: number, z: number) => number) {
    const r = AX + FLATS + 14;
    this.anchorage = { x: CX - r * Math.cos(TURN), z: CZ - r * Math.sin(TURN), heading: 0 };
  }

  private local(x: number, z: number): [number, number] {
    const dx = x - CX;
    const dz = z - CZ;
    const c = Math.cos(-TURN);
    const s = Math.sin(-TURN);
    return [dx * c - dz * s, dx * s + dz * c];
  }

  /** The bar's outline: a long, slightly bent lozenge. */
  coastRadius(th: number): number {
    const c = Math.cos(th);
    const s = Math.sin(th);
    const ell = 1 / Math.sqrt((c / AX) ** 2 + (s / AZ) ** 2);
    return ell + 0.8 * Math.sin(3 * th + 0.7) + 0.5 * Math.sin(5 * th + 2.1);
  }

  /**
   * Signed distance from the bar's edge (positive on the sand). Close to the
   * bar it follows the outline; far out it is the plain distance, so the
   * flats make an even ring round it.
   */
  inland(x: number, z: number): number {
    const [lx, lz] = this.local(x, z);
    // Distance to a segment along the long axis, less the half-width: a stadium shape.
    const ex = Math.max(0, Math.abs(lx) - (AX - AZ));
    const stadium = AZ - Math.hypot(ex, lz);
    const near = this.coastRadius(Math.atan2(lz, lx)) - Math.hypot(lx, lz);
    const k = smoothstep(4, 20, -stadium);
    return near * (1 - k) + stadium * k;
  }

  rockiness(): number {
    return 0;
  }

  private own(x: number, z: number): number {
    const s = this.inland(x, z);
    let h: number;
    if (s >= 0) {
      // A low, smooth bar of sand, never more than knee-high above the sea.
      h = 0.42 * (1 - Math.exp(-s / 2.2)) + 0.02 * this.noise.noise(x * 0.3, z * 0.3);
    } else if (s > -FLATS) {
      // The flats: shelving gently from ankle to waist deep, with sand ripples and a few shallow hollows.
      h = -0.9 * (1 - Math.exp(s / 16));
      h += 0.05 * Math.sin(x * 1.3 + this.noise2.noise(x * 0.05, z * 0.05) * 3) * smoothstep(-2, -10, s);
      h -= 0.35 * smoothstep(0.35, 0.7, this.noise.fbm(x * 0.03, z * 0.03, 2)) * smoothstep(-8, -20, s);
    } else {
      // Over the edge: down to the deep.
      const edge = -0.9 * (1 - Math.exp(-FLATS / 16));
      h = edge - 0.28 * (-s - FLATS) - 0.004 * (-s - FLATS) ** 2;
    }
    h += this.noise.fbm(x * 0.32, z * 0.32, 3) * 0.02;
    const b = this.bounds;
    const edge = Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z);
    h -= 40 * (1 - smoothstep(0, 30, edge));
    return Math.max(h, -40);
  }

  heightAt(x: number, z: number): number {
    return Math.max(this.own(x, z), this.base(x, z));
  }

  wetAt(_x: number, y: number): number {
    return y < 0 ? 255 : 90;
  }

  packAt(): number {
    return 170;
  }

  groundAt(x: number, z: number, h = this.heightAt(x, z)): Ground {
    if (h < -2) {
      const grass = this.noise2.fbm(x * 0.05, z * 0.05, 3);
      return grass > 0.2 && h > -10 ? 'seagrass' : 'sand';
    }
    return 'sand';
  }

  tideline(spacing = 0.7): TidePoint[] {
    const out: TidePoint[] = [];
    const steps = 900;
    let carry = 0;
    let px = NaN;
    let pz = NaN;
    const c = Math.cos(TURN);
    const sn = Math.sin(TURN);
    for (let i = 0; i < steps; i++) {
      const th = (i / steps) * Math.PI * 2;
      const r = this.coastRadius(th) - 1.6;
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
      const h = this.heightAt(wx, wz);
      if (h < 0.08 || h > 0.9) continue;
      out.push({ x: wx, z: wz, nx, nz, island: 'bank' });
    }
    return out;
  }

  /** How far (metres) from the middle of the bar: for the sharks' water. */
  get centre(): { x: number; z: number } {
    return { x: CX, z: CZ };
  }
}

export const BANK_FLATS = FLATS;
