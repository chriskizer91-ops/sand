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
const EB = Int8Array.from(EDGES.map((e) => e[1]));

export class Mesher {
  private fill = new Uint8Array(W * W * W);
  private wet = new Uint8Array(W * W * W);
  private pack = new Uint8Array(W * W * W);
  private stored = new Uint8Array(W * W * W);
  private layer = new Int8Array(W);
  private vIndex = new Int32Array(NC * NC * NC);
  private pos = new Float32Array(NC * NC * NC * 3);
  private nrm = new Int8Array(NC * NC * NC * 3);
  private att = new Uint8Array(NC * NC * NC * 4);
  private idx = new Uint16Array(NC * NC * NC * 18);

  constructor(private world: World) {}

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

    // Quick exit: no inside/outside change anywhere near the chunk.
    let anyIn = false;
    let anyOut = false;
    for (let y = P - 1; y <= P + CHUNK && !(anyIn && anyOut); y++) {
      for (let z = P - 1; z <= P + CHUNK && !(anyIn && anyOut); z++) {
        let o = P - 1 + z * W + y * W2;
        for (let x = P - 1; x <= P + CHUNK; x++, o++) {
          if (fill[o] >= 128) anyIn = true;
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
          const v = fill[o] >= 128 ? 1 : 0;
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
            (fill[base] >= 128 ? 1 : 0) |
            (fill[base + 1] >= 128 ? 2 : 0) |
            (fill[base + W2] >= 128 ? 4 : 0) |
            (fill[base + 1 + W2] >= 128 ? 8 : 0) |
            (fill[base + W] >= 128 ? 16 : 0) |
            (fill[base + 1 + W] >= 128 ? 32 : 0) |
            (fill[base + W + W2] >= 128 ? 64 : 0) |
            (fill[base + 1 + W + W2] >= 128 ? 128 : 0);
          if (mask === 0 || mask === 255) continue;
          for (let c = 0; c < 8; c++) d[c] = fill[base + CORNER[c]] / 255;
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
            const t = Math.abs(db - da) < 1e-6 ? 0.5 : (0.5 - da) / (db - da);
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
          for (let c = 0; c < 8; c++) {
            const o = base + CORNER[c];
            gx[c] = fill[o + 1] - fill[o - 1];
            gy[c] = fill[o + W2] - fill[o - W2];
            gz[c] = fill[o + W] - fill[o - W];
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
            wetSum += wet[o] * f;
            packSum += pack[o] * f;
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
          // Ambient occlusion: how buried this spot is (corners plus a wider ring of samples).
          let outer = 0;
          for (let c = 0; c < 8; c++) {
            const o = base + (c & 1 ? 2 : -1) + ((c >> 2) & 1 ? 2 : -1) * W + ((c >> 1) & 1 ? 2 : -1) * W2;
            outer += fill[o];
          }
          const buried = (fillSum / 8 + outer / 8) / 2 / 255;
          const ao = Math.max(0.3, Math.min(1.08, 1 - (buried - 0.45) * 1.5));

          const vi = nv++;
          vIndex[x + 1 + (z + 1) * NC + (y + 1) * NC * NC] = vi;
          pos[vi * 3] = ox + (x + fx) * CELL;
          pos[vi * 3 + 1] = oy + (y + fy) * CELL;
          pos[vi * 3 + 2] = oz + (z + fz) * CELL;
          nrm[vi * 3] = Math.round((nx / nl) * 127);
          nrm[vi * 3 + 1] = Math.round((ny / nl) * 127);
          nrm[vi * 3 + 2] = Math.round((nz / nl) * 127);
          att[vi * 4] = fillSum > 0 ? Math.round(wetSum / fillSum) : 0;
          att[vi * 4 + 1] = fillSum > 0 ? Math.round(packSum / fillSum) : 0;
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
          const inside = fill[o] >= 128;
          // Edge along +x.
          if (inside !== fill[o + 1] >= 128) {
            quad(V(x, y - 1, z - 1), V(x, y, z - 1), V(x, y, z), V(x, y - 1, z), !inside);
          }
          // Edge along +y.
          if (inside !== fill[o + W2] >= 128) {
            quad(V(x - 1, y, z - 1), V(x - 1, y, z), V(x, y, z), V(x, y, z - 1), !inside);
          }
          // Edge along +z.
          if (inside !== fill[o + W] >= 128) {
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
