/**
 * Save files. Layout (before compression):
 *   "SCSV" | u16 format | u16 generator | u32 headerLength | header JSON
 *   u32 chunkCount | per chunk: u32 key, 4096 fill, 4096 wet, 4096 pack
 * Then compressed with deflate. Only chunks that differ from untouched ground are stored.
 */
import { CHUNK_VOL, GENERATOR_VERSION } from '../config';
import type { World } from './world';

export const SAVE_FORMAT = 1;

export interface SaveHeader {
  savedAt: string;
  gameVersion: string;
  beach: string;
  hand: { amount: number; wetSum: number };
  camera?: number[];
  generator?: number;
}

function chunkDiffersFromGround(world: World, key: number): boolean {
  const c = world.chunks[key];
  if (!c) return false;
  const [cx, cy, cz] = world.keyToCoords(key);
  for (let ly = 0; ly < 16; ly++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const i = cx * 16 + lx;
        const j = cy * 16 + ly;
        const k = cz * 16 + lz;
        const li = lx | (lz << 4) | (ly << 8);
        const f = world.procFillH(world.heights[i + k * world.nx], j);
        if (c.fill[li] !== f) return true;
        if (f > 0) {
          const h = world.heights[i + k * world.nx];
          const yc = world.cellY(j);
          if (c.wet[li] !== world.terrain.wetAt(world.cellX(i), yc, world.cellZ(k), h - yc)) return true;
          if (c.pack[li] !== world.terrain.packAt(world.cellX(i), yc, world.cellZ(k), h - yc)) return true;
        }
      }
    }
  }
  return false;
}

export function encodeWorld(world: World, header: SaveHeader): Uint8Array {
  const keys: number[] = [];
  for (const c of world.list) if (chunkDiffersFromGround(world, c.key)) keys.push(c.key);
  keys.sort((a, b) => a - b);
  const json = new TextEncoder().encode(JSON.stringify({ ...header, generator: GENERATOR_VERSION }));
  const size = 4 + 2 + 2 + 4 + json.length + 4 + keys.length * (4 + CHUNK_VOL * 3);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set([83, 67, 83, 86], 0); // "SCSV"
  dv.setUint16(4, SAVE_FORMAT, true);
  dv.setUint16(6, GENERATOR_VERSION, true);
  dv.setUint32(8, json.length, true);
  out.set(json, 12);
  let o = 12 + json.length;
  dv.setUint32(o, keys.length, true);
  o += 4;
  for (const key of keys) {
    const c = world.chunks[key]!;
    dv.setUint32(o, key, true);
    o += 4;
    out.set(c.fill, o);
    o += CHUNK_VOL;
    out.set(c.wet, o);
    o += CHUNK_VOL;
    out.set(c.pack, o);
    o += CHUNK_VOL;
  }
  return out;
}

export function decodeHeader(raw: Uint8Array): SaveHeader {
  if (raw.length < 12 || raw[0] !== 83 || raw[1] !== 67 || raw[2] !== 83 || raw[3] !== 86) {
    throw new Error('This is not a Sandcastle Cays save file.');
  }
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const fmt = dv.getUint16(4, true);
  if (fmt > SAVE_FORMAT) throw new Error('This save comes from a newer version of the game.');
  const hl = dv.getUint32(8, true);
  return JSON.parse(new TextDecoder().decode(raw.subarray(12, 12 + hl))) as SaveHeader;
}

/** Put the saved chunks into a (fresh) world. Returns the header. */
export function decodeWorld(world: World, raw: Uint8Array): SaveHeader {
  const header = decodeHeader(raw);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const hl = dv.getUint32(8, true);
  let o = 12 + hl;
  const count = dv.getUint32(o, true);
  o += 4;
  for (let n = 0; n < count; n++) {
    const key = dv.getUint32(o, true);
    o += 4;
    const [cx, cy, cz] = world.keyToCoords(key);
    if (cx >= world.ncx || cy >= world.ncy || cz >= world.ncz) throw new Error('Save file is damaged.');
    const c = world.ensureChunk(cx, cy, cz);
    c.fill.set(raw.subarray(o, o + CHUNK_VOL));
    o += CHUNK_VOL;
    c.wet.set(raw.subarray(o, o + CHUNK_VOL));
    o += CHUNK_VOL;
    c.pack.set(raw.subarray(o, o + CHUNK_VOL));
    o += CHUNK_VOL;
    c.surface = null;
    world.markColumnsDirty(cx, cz);
  }
  return header;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([data as BlobPart]);
  const res = new Response(blob.stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** Compress with deflate when the browser supports it (prefixed with a 1-byte flag). */
export async function compress(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    const out = new Uint8Array(raw.length + 1);
    out[0] = 0;
    out.set(raw, 1);
    return out;
  }
  const z = await pipe(raw, new CompressionStream('deflate-raw'));
  const out = new Uint8Array(z.length + 1);
  out[0] = 1;
  out.set(z, 1);
  return out;
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  if (data[0] === 0) return data.subarray(1);
  if (data[0] !== 1) throw new Error('Save file is damaged.');
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open compressed saves.');
  return pipe(data.subarray(1), new DecompressionStream('deflate-raw'));
}
