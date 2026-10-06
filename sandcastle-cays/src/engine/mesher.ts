/**
 * Turns sand cells into a smooth surface ("surface nets").
 *
 * Imagine a point at the centre of every cell, valued 0 (air) to 1 (full of sand).
 * The surface runs where that value crosses 0.5. Each little cube between 8
 * neighbouring centres that the surface passes through gets one vertex, placed
 * at the average of the crossing points, so the result is smooth, with no
 * blocks. Neighbouring vertices are joined into quads.
 */
import { CELL, CHUNK } from '../config';
import type { World } from './world';

export interface ChunkMesh {
  positions: Float32Array;
  /** Normals as signed bytes (-127..127). */
  normals: Int8Array;
  /** Per vertex: wetness, compaction, ambient occlusion (0..255), spare. */
  attrs: Uint8Array;
  indices: Uint16Array;
}

const P = 3; // padding (cells) sampled around the chunk
const W = CHUNK + 2 * P; // window size
const W2 = W * W;
const NC = CHUNK + 1; // cubes per axis that may own a vertex (-1..15)

// Corner offsets: bit0 = x, bit1 = y, bit2 = z.
const CORNER = [0, 1, W2, 1 + W2, W, 1 + W, W + W2, 1 + W + W2];
const EDGES: [number, number][] = [];
for (let a = 0; a < 8; a++) {
  for (let b = a + 1; b < 8; b++) {
    const diff = a ^ b;
    if (diff === 1 || diff === 2 || diff === 4) EDGES.push([a, b]);
  }
}
const EA = Int8Array.from(EDGES.map((e) => e[0]));
// Sample directions for ambient occlusion: 6 axes and 8 diagonals, 1.5 cells out.
const AO_DIRS: number[] = [];
for (const [dx, dy, dz] of [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1],
]) {
  const l = Math.hypot(dx, dy, dz);
  AO_DIRS.push((dx / l) * 1.5, (dy / l) * 1.5, (dz / l) * 1.5);
}
const EB = Int8Array.from(EDGES.map((e) => e[1]));

export class Mesher {
  private fill = new Uint8Array(W * W * W);
  private wet = new Uint8Array(W * W * W);
  private pack = new Uint8Array(W * W * W);
  private stored = new Uint8Array(W * W * W);
  private layer = new Int8Array(W);
  /** Signed vertical distance to the surface at each cell centre (in cells, + inside the sand). */
  private sdf = new Float32Array(W * W * W);
  private tmp = new Float32Array(W * W * W);
  private vIndex = new Int32Array(NC * NC * NC);
  private pos = new Float32Array(NC * NC * NC * 3);
  private nrm = new Int8Array(NC * NC * NC * 3);
  private att = new Uint8Array(NC * NC * NC * 4);
  private idx = new Uint16Array(NC * NC * NC * 18);

  constructor(private world: World) {}

  /** Smoothly interpolated fill (0..1) at a point in window coordinates. */
  private fillAt(x: number, y: number, z: number): number {
    const f = this.fill;
    const ix = Math.max(0, Math.min(W - 2, Math.floor(x)));
    const iy = Math.max(0, Math.min(W - 2, Math.floor(y)));
    const iz = Math.max(0, Math.min(W - 2, Math.floor(z)));
    const fx = Math.max(0, Math.min(1, x - ix));
    const fy = Math.max(0, Math.min(1, y - iy));
    const fz = Math.max(0, Math.min(1, z - iz));
    const o = ix + iz * W + iy * W2;
    const c00 = f[o] + (f[o + 1] - f[o]) * fx;
    const c10 = f[o + W2] + (f[o + W2 + 1] - f[o + W2]) * fx;
    const c01 = f[o + W] + (f[o + W + 1] - f[o + W]) * fx;
    const c11 = f[o + W + W2] + (f[o + W + W2 + 1] - f[o + W + W2]) * fx;
    const c0 = c00 + (c10 - c00) * fy;
    const c1 = c01 + (c11 - c01) * fy;
    return (c0 + (c1 - c0) * fz) / 255;
  }

  /** Mesh one chunk. Returns null if there is no surface in it. */
  meshChunk(cx: number, cy: number, cz: number): ChunkMesh | null {
    const world = this.world;
    const i0 = cx * CHUNK - P;
    const j0 = cy * CHUNK - P;
    const k0 = cz * CHUNK - P;
    const fill = this.fill;
    const wet = this.wet;
    const pack = this.pack;
    const stored = this.stored;
    world.sampleBlock(i0, j0, k0, W, W, W, fill, wet, pack, stored);

    // Turn "how full is each cell" into "how far is the surface, up or down" (in cells).
    // A part-filled cell resting on sand has its surface at exactly its fill level,
    // so heights come out exact and gentle slopes are smooth (no terraces).
    const sdf = this.sdf;
    for (let y = 0; y < W; y++) {
      for (let z = 0; z < W; z++) {
        let o = z * W + y * W2;
        for (let x = 0; x < W; x++, o++) {
          const f = fill[o] / 255;
          let v: number;
          if (f >= 1) {
            const fa = y + 1 < W ? fill[o + W2] / 255 : 1;
            if (fa >= 1) v = 1.5 + (y + 2 < W ? fill[o + 2 * W2] / 255 : 1);
            else v = 0.5 + fa;
          } else if (f <= 0) {
            const fb = y > 0 ? fill[o - W2] / 255 : 0;
            if (fb >= 1) v = -0.5;
            else if (fb > 0) v = fb - 1.5;
            else v = (y > 1 ? fill[o - 2 * W2] / 255 : 0) - 2.5;
          } else {
            v = f - 0.5;
          }
          sdf[o] = v;
        }
      }
    }

    // Soften steep stair-steps: blend each cell with its sideways neighbours (1-2-1).
    // An even slope is unchanged by this, so gentle ground stays exact.
    const tmp = this.tmp;
    for (let y = 0; y < W; y++) {
      for (let z = 0; z < W; z++) {
        const row = z * W + y * W2;
        for (let x = 1; x < W - 1; x++) tmp[row + x] = 0.25 * sdf[row + x - 1] + 0.5 * sdf[row + x] + 0.25 * sdf[row + x + 1];
        tmp[row] = sdf[row];
        tmp[row + W - 1] = sdf[row + W - 1];
      }
    }
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        for (let z = 1; z < W - 1; z++) {
          const o = x + z * W + y * W2;
          sdf[o] = 0.25 * tmp[o - W] + 0.5 * tmp[o] + 0.25 * tmp[o + W];
        }
        sdf[x + y * W2] = tmp[x + y * W2];
        sdf[x + (W - 1) * W + y * W2] = tmp[x + (W - 1) * W + y * W2];
      }
    }

    // Quick exit: no inside/outside change anywhere near the chunk.
    let anyIn = false;
    let anyOut = false;
    for (let y = P - 1; y <= P + CHUNK && !(anyIn && anyOut); y++) {
      for (let z = P - 1; z <= P + CHUNK && !(anyIn && anyOut); z++) {
        let o = P - 1 + z * W + y * W2;
        for (let x = P - 1; x <= P + CHUNK; x++, o++) {
          if (sdf[o] > 0) anyIn = true;
          else anyOut = true;
        }
      }
    }
    if (!anyIn || !anyOut) return null;

    const vIndex = this.vIndex;
    vIndex.fill(-1);
    const pos = this.pos;
    const nrm = this.nrm;
    const att = this.att;
    let nv = 0;
    const ox = world.originX + (cx * CHUNK + 0.5) * CELL;
    const oy = world.originY + (cy * CHUNK + 0.5) * CELL;
    const oz = world.originZ + (cz * CHUNK + 0.5) * CELL;
    const d = new Float32Array(8);
    const gx = new Float32Array(8);
    const gy = new Float32Array(8);
    const gz = new Float32Array(8);

    // Which horizontal layers are entirely sand (1), entirely air (0) or mixed (2).
    const layer = this.layer;
    for (let yw = 0; yw < W; yw++) {
      let st = -1;
      for (let z = P - 1; z <= P + CHUNK && st !== 2; z++) {
        let o = P - 1 + z * W + yw * W2;
        for (let x = P - 1; x <= P + CHUNK; x++, o++) {
          const v = sdf[o] > 0 ? 1 : 0;
          if (st === -1) st = v;
          else if (st !== v) {
            st = 2;
            break;
          }
        }
      }
      layer[yw] = st;
    }

    // Pass 1: one vertex per cube the surface passes through.
    for (let y = -1; y < CHUNK; y++) {
      const yw = y + P;
      if (layer[yw] !== 2 && layer[yw] === layer[yw + 1]) continue;
      for (let z = -1; z < CHUNK; z++) {
        for (let x = -1; x < CHUNK; x++) {
          const base = x + P + (z + P) * W + (y + P) * W2;
          // Which of the 8 corners are inside the sand (bit0 = x, bit1 = y, bit2 = z).
          const mask =
            (sdf[base] > 0 ? 1 : 0) |
            (sdf[base + 1] > 0 ? 2 : 0) |
            (sdf[base + W2] > 0 ? 4 : 0) |
            (sdf[base + 1 + W2] > 0 ? 8 : 0) |
            (sdf[base + W] > 0 ? 16 : 0) |
            (sdf[base + 1 + W] > 0 ? 32 : 0) |
            (sdf[base + W + W2] > 0 ? 64 : 0) |
            (sdf[base + 1 + W + W2] > 0 ? 128 : 0);
          if (mask === 0 || mask === 255) continue;
          for (let c = 0; c < 8; c++) d[c] = sdf[base + CORNER[c]];
          // Average of the edge crossings.
          let sx = 0;
          let sy = 0;
          let sz = 0;
          let cnt = 0;
          for (let e = 0; e < 12; e++) {
            const a = EA[e];
            const b = EB[e];
            const ia = (mask >> a) & 1;
            const ib = (mask >> b) & 1;
            if (ia === ib) continue;
            const da = d[a];
            const db = d[b];
            const t = Math.abs(db - da) < 1e-6 ? 0.5 : da / (da - db);
            sx += (a & 1) + ((b & 1) - (a & 1)) * t;
            sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
            sz += ((a >> 2) & 1) + (((b >> 2) & 1) - ((a >> 2) & 1)) * t;
            cnt++;
          }
          const fx = sx / cnt;
          const fy = sy / cnt;
          const fz = sz / cnt;
          // Smooth normal: gradient at each corner (central differences), blended to the vertex.
          let wetSum = 0;
          let packSum = 0;
          let fillSum = 0;
          let nearSum = 0;
          for (let c = 0; c < 8; c++) {
            const o = base + CORNER[c];
            gx[c] = sdf[o + 1] - sdf[o - 1];
            gy[c] = sdf[o + W2] - sdf[o - W2];
            gz[c] = sdf[o + W] - sdf[o - W];
            const f = fill[o];
            if (f > 0 && !stored[o]) {
              // Untouched sand: look up its starting moisture and compaction now.
              const props = world.procProps(
                i0 + (o % W),
                j0 + Math.floor(o / W2),
                k0 + (Math.floor(o / W) % W),
              );
              wet[o] = props & 255;
              pack[o] = props >> 8;
              stored[o] = 1;
            }
            fillSum += f;
            const near = f * Math.max(0.04, 1 - Math.abs(sdf[o]) / 1.6);
            nearSum += near;
            wetSum += wet[o] * near;
            packSum += pack[o] * near;
          }
          if (nearSum < 0.05) {
            // Smoothing put this point just outside the sand: borrow wetness from a wider block.
            for (let oy = -1; oy <= 2; oy++) {
              for (let oz = -1; oz <= 2; oz++) {
                for (let ox = -1; ox <= 2; ox++) {
                  const o = base + ox + oz * W + oy * W2;
                  const f = fill[o];
                  if (f === 0) continue;
                  if (!stored[o]) {
                    const props = world.procProps(i0 + (o % W), j0 + Math.floor(o / W2), k0 + (Math.floor(o / W) % W));
                    wet[o] = props & 255;
                    pack[o] = props >> 8;
                    stored[o] = 1;
                  }
                  const near = f * Math.max(0.04, 1 - Math.abs(sdf[o]) / 2.5);
                  nearSum += near;
                  wetSum += wet[o] * near;
                  packSum += pack[o] * near;
                }
              }
            }
          }
          let nx = 0;
          let ny = 0;
          let nz = 0;
          for (let c = 0; c < 8; c++) {
            const wx = c & 1 ? fx : 1 - fx;
            const wy = (c >> 1) & 1 ? fy : 1 - fy;
            const wz = (c >> 2) & 1 ? fz : 1 - fz;
            const wgt = wx * wy * wz;
            nx -= gx[c] * wgt;
            ny -= gy[c] * wgt;
            nz -= gz[c] * wgt;
          }
          const nl = Math.hypot(nx, ny, nz) || 1;
          // Ambient occlusion: how much sand surrounds this exact spot (smoothly sampled),
          // compared with a flat beach (half sand, half air).
          const px = x + P + fx;
          const py = y + P + fy;
          const pz = z + P + fz;
          let around = 0;
          for (let a = 0; a < AO_DIRS.length; a += 3) {
            around += this.fillAt(px + AO_DIRS[a], py + AO_DIRS[a + 1], pz + AO_DIRS[a + 2]);
          }
          const buried = around / (AO_DIRS.length / 3);
          const ao = Math.max(0.3, Math.min(1.08, 1 - (buried - 0.5) * 1.7));

          const vi = nv++;
          vIndex[x + 1 + (z + 1) * NC + (y + 1) * NC * NC] = vi;
          pos[vi * 3] = ox + (x + fx) * CELL;
          pos[vi * 3 + 1] = oy + (y + fy) * CELL;
          pos[vi * 3 + 2] = oz + (z + fz) * CELL;
          nrm[vi * 3] = Math.round((nx / nl) * 127);
          nrm[vi * 3 + 1] = Math.round((ny / nl) * 127);
          nrm[vi * 3 + 2] = Math.round((nz / nl) * 127);
          att[vi * 4] = nearSum > 0 ? Math.round(wetSum / nearSum) : 0;
          att[vi * 4 + 1] = nearSum > 0 ? Math.round(packSum / nearSum) : 0;
          att[vi * 4 + 2] = Math.round((ao / 1.08) * 255);
          att[vi * 4 + 3] = 0;
        }
      }
    }
    if (nv === 0) return null;

    // Pass 2: join the vertices around every edge the surface crosses.
    const idx = this.idx;
    let ni = 0;
    const V = (x: number, y: number, z: number) => vIndex[x + 1 + (z + 1) * NC + (y + 1) * NC * NC];
    const quad = (a: number, b: number, c: number, e: number, flip: boolean) => {
      if (a < 0 || b < 0 || c < 0 || e < 0) return;
      if (flip) {
        idx[ni++] = a;
        idx[ni++] = c;
        idx[ni++] = b;
        idx[ni++] = a;
        idx[ni++] = e;
        idx[ni++] = c;
      } else {
        idx[ni++] = a;
        idx[ni++] = b;
        idx[ni++] = c;
        idx[ni++] = a;
        idx[ni++] = c;
        idx[ni++] = e;
      }
    };
    for (let y = 0; y < CHUNK; y++) {
      if (layer[y + P] !== 2 && layer[y + P] === layer[y + P + 1]) continue;
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const o = x + P + (z + P) * W + (y + P) * W2;
          const inside = sdf[o] > 0;
          // Edge along +x.
          if (inside !== sdf[o + 1] > 0) {
            quad(V(x, y - 1, z - 1), V(x, y, z - 1), V(x, y, z), V(x, y - 1, z), !inside);
          }
          // Edge along +y.
          if (inside !== sdf[o + W2] > 0) {
            quad(V(x - 1, y, z - 1), V(x - 1, y, z), V(x, y, z), V(x, y, z - 1), !inside);
          }
          // Edge along +z.
          if (inside !== sdf[o + W] > 0) {
            quad(V(x - 1, y - 1, z), V(x, y - 1, z), V(x, y, z), V(x - 1, y, z), !inside);
          }
        }
      }
    }
    if (ni === 0) return null;
    return {
      positions: pos.slice(0, nv * 3),
      normals: nrm.slice(0, nv * 3),
      attrs: att.slice(0, nv * 4),
      indices: idx.slice(0, ni),
    };
  }
}

export interface MergedMesh {
  positions: Float32Array;
  normals: Int8Array;
  attrs: Uint8Array;
  indices: Uint32Array;
}

/** Join several chunk meshes into one (fewer draw calls). */
export function mergeMeshes(meshes: ChunkMesh[]): MergedMesh {
  let nv = 0;
  let ni = 0;
  for (const m of meshes) {
    nv += m.positions.length / 3;
    ni += m.indices.length;
  }
  const positions = new Float32Array(nv * 3);
  const normals = new Int8Array(nv * 3);
  const attrs = new Uint8Array(nv * 4);
  const indices = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    const cnt = m.positions.length / 3;
    positions.set(m.positions, vo * 3);
    normals.set(m.normals, vo * 3);
    attrs.set(m.attrs, vo * 4);
    for (let n = 0; n < m.indices.length; n++) indices[io + n] = m.indices[n] + vo;
    vo += cnt;
    io += m.indices.length;
  }
  return { positions, normals, attrs, indices };
}
