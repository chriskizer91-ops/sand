/**
 * WorldFields: the page's copy of the world data the engine streams over
 * (ARCHITECTURE §6.2). CPU mirrors for queries, plus DataTextures for shaders.
 *
 * Textures (world data maps, not pictures):
 *   heightTex  R32F  512x512  visible surface height (m)        NEAREST (use texelFetch + manual bilinear)
 *   groundTex  RGBA8 512x512  lava x20, lava temp, sediment x50, sandKind|rockKind   LINEAR
 *   coverATex  RGBA8 256x256  lichen/crust, moss, grass/herb, forest floor           LINEAR
 *   coverBTex  RGBA8 256x256  weathering/soil, guano, moisture, burn                 LINEAR
 *   coverCTex  RGBA8 256x256  coral, seagrass, coralline/reef crest, stream/marsh    LINEAR
 *
 * Upload: apply() copies rectangles into the mirrors; flush() (once per frame) uploads only
 * the changed rows of each texture (three's updateRanges), or the whole texture if most changed.
 */
import * as THREE from 'three';
import { CELL, NP, NX, NZ, ORIGIN_X, ORIGIN_Z, PATCH_M, SEA_LEVEL } from '../config';
import { PLANT_BYTES, type FromEngine } from '../engine/protocol';

interface DirtyRows {
  /** Per row: min x and max x (inclusive) changed; -1 = clean. */
  x0: Int32Array;
  x1: Int32Array;
  any: boolean;
  count: number;
}

function makeDirty(rows: number): DirtyRows {
  return { x0: new Int32Array(rows).fill(-1), x1: new Int32Array(rows).fill(-1), any: false, count: 0 };
}

function markRows(d: DirtyRows, x0: number, z0: number, w: number, h: number): void {
  for (let z = z0; z < z0 + h; z++) {
    if (d.x0[z] < 0) {
      d.x0[z] = x0;
      d.x1[z] = x0 + w - 1;
      d.count++;
    } else {
      d.x0[z] = Math.min(d.x0[z], x0);
      d.x1[z] = Math.max(d.x1[z], x0 + w - 1);
    }
  }
  d.any = true;
}

/** Upload the dirty rows of a texture. Ranges are in units of 4 per pixel (three's convention). */
function flushTexture(tex: THREE.DataTexture, d: DirtyRows, width: number): void {
  if (!d.any) return;
  const rows = d.x0.length;
  if (d.count > rows / 3) {
    tex.clearUpdateRanges();
    tex.needsUpdate = true; // whole texture
  } else {
    for (let z = 0; z < rows; z++) {
      if (d.x0[z] < 0) continue;
      tex.addUpdateRange((z * width + d.x0[z]) * 4, (d.x1[z] - d.x0[z] + 1) * 4);
    }
    tex.needsUpdate = true;
  }
  d.x0.fill(-1);
  d.x1.fill(-1);
  d.any = false;
  d.count = 0;
}

export type RectListener = (x0: number, z0: number, w: number, h: number) => void;

export class WorldFields {
  // CPU mirrors
  readonly surf = new Float32Array(NX * NZ);
  readonly ground = new Uint8Array(NX * NZ * 4);
  readonly coverA = new Uint8Array(NP * NP * 4);
  readonly coverB = new Uint8Array(NP * NP * 4);
  readonly coverC = new Uint8Array(NP * NP * 4);
  readonly plants = new Uint8Array(NP * NP * PLANT_BYTES);
  readonly habitat = new Uint8Array(NP * NP);

  readonly heightTex: THREE.DataTexture;
  readonly groundTex: THREE.DataTexture;
  readonly coverATex: THREE.DataTexture;
  readonly coverBTex: THREE.DataTexture;
  readonly coverCTex: THREE.DataTexture;

  private dHeight = makeDirty(NZ);
  private dGround = makeDirty(NZ);
  private dCover = makeDirty(NP);

  /** Fired after column data changed (rectangle in columns). */
  readonly onCols: RectListener[] = [];
  /** Fired after eco data (cover, plants, habitat) changed (rectangle in patches). */
  readonly onEco: RectListener[] = [];
  /** Bumped on every change (cheap "has anything changed" test). */
  colsVersion = 0;
  ecoVersion = 0;

  constructor() {
    this.surf.fill(-30);
    this.heightTex = new THREE.DataTexture(this.surf, NX, NZ, THREE.RedFormat, THREE.FloatType);
    this.heightTex.minFilter = THREE.NearestFilter;
    this.heightTex.magFilter = THREE.NearestFilter;
    this.heightTex.generateMipmaps = false;
    this.heightTex.needsUpdate = true;
    const rgba = (data: Uint8Array, n: number) => {
      const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      return t;
    };
    this.groundTex = rgba(this.ground, NX);
    this.coverATex = rgba(this.coverA, NP);
    this.coverBTex = rgba(this.coverB, NP);
    this.coverCTex = rgba(this.coverC, NP);
  }

  /** Apply an engine message (cols, eco, clear). Other messages are ignored. */
  apply(m: FromEngine): void {
    if (m.t === 'cols') {
      const { x0, z0, w, h } = m;
      for (let z = 0; z < h; z++) {
        const row = (z0 + z) * NX + x0;
        this.surf.set(m.surf.subarray(z * w, z * w + w), row);
        this.ground.set(m.ground.subarray(z * w * 4, (z * w + w) * 4), row * 4);
      }
      markRows(this.dHeight, x0, z0, w, h);
      markRows(this.dGround, x0, z0, w, h);
      this.colsVersion++;
      for (const fn of this.onCols) fn(x0, z0, w, h);
    } else if (m.t === 'eco') {
      const { x0, z0, w, h } = m;
      for (let z = 0; z < h; z++) {
        const row = (z0 + z) * NP + x0;
        this.coverA.set(m.a.subarray(z * w * 4, (z * w + w) * 4), row * 4);
        this.coverB.set(m.b.subarray(z * w * 4, (z * w + w) * 4), row * 4);
        this.coverC.set(m.c.subarray(z * w * 4, (z * w + w) * 4), row * 4);
        this.plants.set(m.plants.subarray(z * w * PLANT_BYTES, (z * w + w) * PLANT_BYTES), row * PLANT_BYTES);
        this.habitat.set(m.habitat.subarray(z * w, z * w + w), row);
      }
      markRows(this.dCover, x0, z0, w, h);
      this.ecoVersion++;
      for (const fn of this.onEco) fn(x0, z0, w, h);
    } else if (m.t === 'clear') {
      this.surf.fill(-30);
      this.ground.fill(0);
      this.coverA.fill(0);
      this.coverB.fill(0);
      this.coverC.fill(0);
      this.plants.fill(0);
      this.habitat.fill(0);
      markRows(this.dHeight, 0, 0, NX, NZ);
      markRows(this.dGround, 0, 0, NX, NZ);
      markRows(this.dCover, 0, 0, NP, NP);
      this.colsVersion++;
      this.ecoVersion++;
      for (const fn of this.onCols) fn(0, 0, NX, NZ);
      for (const fn of this.onEco) fn(0, 0, NP, NP);
    }
  }

  /** Upload changed rows to the GPU. Call once per frame before rendering. */
  flush(): void {
    flushTexture(this.heightTex, this.dHeight, NX);
    flushTexture(this.groundTex, this.dGround, NX);
    if (this.dCover.any) {
      // The three cover textures always change together; share the dirty rows.
      const d = this.dCover;
      const copy = (): DirtyRows => ({ x0: d.x0.slice(), x1: d.x1.slice(), any: d.any, count: d.count });
      const b = copy();
      const c = copy();
      flushTexture(this.coverBTex, b, NP);
      flushTexture(this.coverCTex, c, NP);
      flushTexture(this.coverATex, d, NP);
    }
  }

  // ---------- queries ----------

  /** Bilinear visible surface height at a world point (ground or lava). Outside the zone: deep floor. */
  heightAt(x: number, z: number): number {
    const fx = (x - ORIGIN_X) / CELL - 0.5;
    const fz = (z - ORIGIN_Z) / CELL - 0.5;
    if (fx < -1 || fz < -1 || fx > NX || fz > NZ) return -30;
    const i0 = Math.max(0, Math.min(NX - 1, Math.floor(fx)));
    const k0 = Math.max(0, Math.min(NZ - 1, Math.floor(fz)));
    const i1 = Math.min(NX - 1, i0 + 1);
    const k1 = Math.min(NZ - 1, k0 + 1);
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - k0));
    const s = this.surf;
    const a = s[i0 + k0 * NX];
    const b = s[i1 + k0 * NX];
    const c = s[i0 + k1 * NX];
    const d = s[i1 + k1 * NX];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /** Molten lava thickness (m) at the column under a point. */
  lavaAt(x: number, z: number): number {
    const c = this.colIndex(x, z);
    return c < 0 ? 0 : this.ground[c * 4] / 20;
  }

  /** Solid ground height (surface minus molten lava). */
  solidAt(x: number, z: number): number {
    return this.heightAt(x, z) - this.lavaAt(x, z);
  }

  /** Water depth above the surface (0 on land). */
  waterDepthAt(x: number, z: number): number {
    return Math.max(0, SEA_LEVEL - this.heightAt(x, z));
  }

  /** Column index under a world point, or -1 outside the zone. */
  colIndex(x: number, z: number): number {
    const i = Math.floor((x - ORIGIN_X) / CELL);
    const k = Math.floor((z - ORIGIN_Z) / CELL);
    if (i < 0 || k < 0 || i >= NX || k >= NZ) return -1;
    return i + k * NX;
  }

  /** Patch index under a world point, or -1 outside the zone. */
  patchIndex(x: number, z: number): number {
    const i = Math.floor((x - ORIGIN_X) / PATCH_M);
    const k = Math.floor((z - ORIGIN_Z) / PATCH_M);
    if (i < 0 || k < 0 || i >= NP || k >= NP) return -1;
    return i + k * NP;
  }

  /** Surface normal (unit, world space) at a point, from central differences. */
  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = CELL;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  /**
   * Ray against the visible surface. Marches in steps of about one column (growing with
   * distance), then refines with bisection. Returns the hit point and distance, or null.
   * Water is NOT a hit: rays pass through the sea to the sea floor.
   */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist = 4000): { x: number; y: number; z: number; t: number } | null {
    let tPrev = 0;
    let prevAbove = o.y - this.heightAt(o.x, o.z);
    if (prevAbove < 0) return { x: o.x, y: this.heightAt(o.x, o.z), z: o.z, t: 0 };
    let t = 0;
    while (t < maxDist) {
      const step = Math.max(CELL * 0.5, Math.min(prevAbove * 0.5, 40));
      t += step;
      const x = o.x + d.x * t;
      const y = o.y + d.y * t;
      const z = o.z + d.z * t;
      const above = y - this.heightAt(x, z);
      if (above <= 0) {
        // Bisect between tPrev and t.
        let lo = tPrev;
        let hi = t;
        for (let n = 0; n < 12; n++) {
          const mid = (lo + hi) * 0.5;
          const mx = o.x + d.x * mid;
          const mz = o.z + d.z * mid;
          if (o.y + d.y * mid - this.heightAt(mx, mz) > 0) lo = mid;
          else hi = mid;
        }
        const tt = (lo + hi) * 0.5;
        const hx = o.x + d.x * tt;
        const hz = o.z + d.z * tt;
        return { x: hx, y: this.heightAt(hx, hz), z: hz, t: tt };
      }
      // Leaving the zone upward or far below everything: stop early.
      if (d.y > 0 && y > 400) return null;
      tPrev = t;
      prevAbove = above;
    }
    return null;
  }

  /** Plants bytes for a patch: [canopySp, canopyCov, shrubSp, shrubCov, herbSp, herbCov]. Species byte = id + 1. */
  plantAt(p: number, layer: 0 | 1 | 2): { species: number; cover: number } {
    const o = p * PLANT_BYTES + layer * 2;
    return { species: this.plants[o] - 1, cover: this.plants[o + 1] / 255 };
  }
}
