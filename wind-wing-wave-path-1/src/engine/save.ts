/**
 * Save files: the whole sea, ground and life, in one small file.
 *
 * Layout before compression (numbers little-endian):
 *
 *   "WWWS" | u16 format | u32 header length | header JSON
 *   then sections, each  [u32 tag][u32 length][bytes]:
 *     COLS  u32 nx, u32 nz, then six arrays of nx*nz values, each row delta-encoded:
 *           rock top (int16, 1/128 m), sand (uint16, 1/256 m), molten lava (uint16, 1/256 m),
 *           lava temperature (uint8, 1/255), sand kind (uint8), rock kind (uint8)
 *     ECO   u32 length + the ecology's own state as JSON, then u32 field count and, for every
 *           persistent life-grid field: u16 name length, name, u8 element type,
 *           u32 byte length, raw bytes
 *     SUM   always last: u32 CRC-32 of every byte before this section
 *
 * The whole thing is compressed with deflate (CompressionStream 'deflate-raw'); a sea is
 * typically well under 2 MB.
 *
 * Why it is built this way:
 * - The whole column grid is stored, so a loaded sea never depends on the seabed formula
 *   (which may change between versions).
 * - Heights are rounded to fixed steps ("quantised") and loading leaves them on those steps,
 *   so load -> save -> load -> save gives the same bytes. Delta-encoding each row turns
 *   smooth ground into runs of small numbers that compress very well.
 * - Loading builds a brand-new world and only swaps it in when everything checked out, so
 *   a damaged or foreign file can never leave a half-loaded sea.
 * - 'deflate-raw' has no checksum of its own: a file damaged by a single flipped bit often
 *   still unpacks to the right length, just with wrong ground or life in it. The SUM
 *   section catches that (and a file cut short), so a damaged save is refused instead of
 *   quietly opening a different sea.
 * - Life-grid fields are stored by name, so the ecology can add fields in later versions;
 *   fields a save doesn't have keep their fresh values.
 */
import { NX, NZ } from '../config';
import type { EcoSave } from '../eco/ecology';
import type { PatchArray, PatchGrid } from '../eco/patches';
import { Columns } from './columns';
import type { PageSaveHeader } from './protocol';

export const SAVE_FORMAT = 1;
const MAGIC = 'WWWS';
const TAG_COLS = tag('COLS');
const TAG_ECO = tag('ECO ');
const TAG_SUM = tag('SUM ');
/** The SUM section: tag, length, CRC-32. */
const SUM_BYTES = 12;
/** Magic, format and header length: the smallest start a save can have. */
const START_BYTES = 10;
/** Bytes per column in the COLS section: rock 2, sand 2, lava 2, temperature 1, sand kind 1, rock kind 1. */
const COL_BYTES = 9;
/**
 * The most a save may unpack to. A real sea is about 7 MB unpacked; anything far bigger
 * is refused before it can fill the phone's memory.
 */
const MAX_RAW_BYTES = 96 * 1024 * 1024;

/** Plain messages for the owner. */
export const SAVE_ERRORS = {
  notASave: "This file isn't a saved sea from Wind, Wing & Wave, or it is damaged.",
  damaged: "This saved sea is damaged (it may have been cut short), so it can't be opened.",
  newer: 'This sea was saved by a newer version of the game. Open it with the newest version.',
  otherSize: 'This sea was saved by a version of the game with a different size of sea.',
  lifeMismatch: "The life in this saved sea doesn't match this version of the game.",
  tooBig: "This file is far too big to be a saved sea, so it wasn't opened.",
  noCompression: "This browser can't pack or unpack saved seas.",
} as const;

/** A save problem with a plain message (shown to the owner as is). */
export class SaveError extends Error {}

export interface SaveHeader {
  format: number;
  gameVersion: string;
  /** ISO time the save was made. */
  savedAt: string;
  seed: number;
  /** Where the first-minute glow sits (kept here so a loaded sea never re-runs the seabed formula). */
  glow: { x: number; z: number };
  /** Completed eco year at the time of saving (for lists of saves). */
  year: number;
  /** The page's own state (camera, sky clock, small UI state). */
  page: PageSaveHeader | null;
}

/** What a save is made from. */
export interface SaveSource {
  header: SaveHeader;
  cols: Columns;
  grid: PatchGrid;
  eco: EcoSave;
}

/** One stored life-grid field. */
export interface SavedField {
  name: string;
  /** Element type code (see typeCode). */
  type: number;
  bytes: Uint8Array;
}

/** A decoded save: a fresh, filled Columns plus everything needed to rebuild the life. */
export interface DecodedSave {
  header: SaveHeader;
  cols: Columns;
  eco: EcoSave;
  fields: SavedField[];
}

function tag(s: string): number {
  return (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
}

// ---------- element types ----------

/**
 * Element type codes for life-grid fields, stored in the file (so never reorder):
 * 0 Float32, 1 Uint8, 2 Int8, 3 Uint16, 4 Int16, 5 Uint32, 6 Int32.
 */
function typeCode(a: PatchArray): number {
  if (a instanceof Float32Array) return 0;
  if (a instanceof Uint8Array) return 1;
  if (a instanceof Int8Array) return 2;
  if (a instanceof Uint16Array) return 3;
  if (a instanceof Int16Array) return 4;
  if (a instanceof Uint32Array) return 5;
  return 6;
}

/** Bytes per element, by type code. */
const ELEMENT_BYTES = [4, 1, 1, 2, 2, 4, 4];

/** The bytes of a typed array (no copy). Raw bytes are little-endian, as on every phone and laptop the game runs on. */
function bytesOf(a: PatchArray): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

// ---------- encoding ----------

/** Build the uncompressed save. */
export function encodeRaw(src: SaveSource): Uint8Array {
  const enc = new TextEncoder();
  const header = enc.encode(JSON.stringify(src.header));
  const ecoJson = enc.encode(JSON.stringify(src.eco));
  const fields = src.grid.persistentFields();
  const names = fields.map((f) => enc.encode(f.name));
  const n = NX * NZ;
  const colsLen = 8 + n * COL_BYTES;
  let ecoLen = 4 + ecoJson.length + 4;
  for (let f = 0; f < fields.length; f++) ecoLen += 2 + names[f].length + 1 + 4 + fields[f].arr.byteLength;
  const out = new Uint8Array(START_BYTES + header.length + 8 + colsLen + 8 + ecoLen + SUM_BYTES);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < 4; i++) out[o++] = MAGIC.charCodeAt(i);
  dv.setUint16(o, SAVE_FORMAT, true);
  dv.setUint32(o + 2, header.length, true);
  o += 6;
  out.set(header, o);
  o += header.length;

  // COLS
  dv.setUint32(o, TAG_COLS, true);
  dv.setUint32(o + 4, colsLen, true);
  dv.setUint32(o + 8, NX, true);
  dv.setUint32(o + 12, NZ, true);
  o += 16;
  const c = src.cols;
  o = putRows16(dv, o, c.rock, 128, -32768, 32767);
  o = putRows16(dv, o, c.sed, 256, 0, 65535);
  o = putRows16(dv, o, c.lava, 256, 0, 65535);
  o = putTempRows(out, o, c.temp);
  o = putRows8(out, o, c.sandKind);
  o = putRows8(out, o, c.rockKind);

  // ECO
  dv.setUint32(o, TAG_ECO, true);
  dv.setUint32(o + 4, ecoLen, true);
  dv.setUint32(o + 8, ecoJson.length, true);
  o += 12;
  out.set(ecoJson, o);
  o += ecoJson.length;
  dv.setUint32(o, fields.length, true);
  o += 4;
  for (let f = 0; f < fields.length; f++) {
    const arr = fields[f].arr;
    dv.setUint16(o, names[f].length, true);
    o += 2;
    out.set(names[f], o);
    o += names[f].length;
    out[o++] = typeCode(arr);
    dv.setUint32(o, arr.byteLength, true);
    o += 4;
    out.set(bytesOf(arr), o);
    o += arr.byteLength;
  }

  // SUM
  dv.setUint32(o, TAG_SUM, true);
  dv.setUint32(o + 4, 4, true);
  dv.setUint32(o + 8, crc32(out.subarray(0, o)), true);
  return out;
}

/** Heights to fixed steps (`scale` per metre), clamped, each row stored as differences. */
function putRows16(dv: DataView, o: number, src: Float32Array, scale: number, min: number, max: number): number {
  for (let k = 0; k < NZ; k++) {
    let prev = 0;
    const row = k * NX;
    for (let i = 0; i < NX; i++) {
      let q = Math.round(src[row + i] * scale);
      if (!(q >= min)) q = min; // also catches NaN
      else if (q > max) q = max;
      dv.setUint16(o, (q - prev) & 0xffff, true);
      o += 2;
      prev = q;
    }
  }
  return o;
}

/** Lava temperature 0..1 to 0..255, rows as differences. */
function putTempRows(out: Uint8Array, o: number, src: Float32Array): number {
  for (let k = 0; k < NZ; k++) {
    let prev = 0;
    const row = k * NX;
    for (let i = 0; i < NX; i++) {
      const t = src[row + i];
      const q = t > 0 ? Math.round(Math.min(1, t) * 255) : 0;
      out[o++] = (q - prev) & 0xff;
      prev = q;
    }
  }
  return o;
}

function putRows8(out: Uint8Array, o: number, src: Uint8Array): number {
  for (let k = 0; k < NZ; k++) {
    let prev = 0;
    const row = k * NX;
    for (let i = 0; i < NX; i++) {
      const q = src[row + i];
      out[o++] = (q - prev) & 0xff;
      prev = q;
    }
  }
  return o;
}

/** Build and compress a save. The returned buffer is fresh (safe to transfer). */
export async function encodeSave(src: SaveSource): Promise<ArrayBuffer> {
  return deflate(encodeRaw(src));
}

// ---------- decoding ----------

/** Reads a byte range; any read past its end means the file was cut short or damaged. */
class Reader {
  private readonly dv: DataView;
  pos: number;

  constructor(
    readonly bytes: Uint8Array,
    readonly start = 0,
    readonly end = bytes.length,
  ) {
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = start;
  }

  get left(): number {
    return this.end - this.pos;
  }
  private need(n: number): void {
    if (n < 0 || this.pos + n > this.end) throw new SaveError(SAVE_ERRORS.damaged);
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.pos++];
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** The next n bytes (a view, no copy). */
  take(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  /** A reader over the next n bytes. */
  sub(n: number): Reader {
    this.need(n);
    const r = new Reader(this.bytes, this.pos, this.pos + n);
    this.pos += n;
    return r;
  }
}

/** Decode an uncompressed save into fresh objects. Throws SaveError with a plain message. */
export function decodeRaw(raw: Uint8Array): DecodedSave {
  if (raw.length < START_BYTES) throw new SaveError(SAVE_ERRORS.notASave);
  for (let i = 0; i < 4; i++) if (raw[i] !== MAGIC.charCodeAt(i)) throw new SaveError(SAVE_ERRORS.notASave);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const format = dv.getUint16(4, true);
  if (format > SAVE_FORMAT) throw new SaveError(SAVE_ERRORS.newer);
  if (format < 1) throw new SaveError(SAVE_ERRORS.notASave);
  // Nothing is read until the checksum confirms every byte is as it was saved.
  const end = raw.length - SUM_BYTES;
  if (end < START_BYTES || dv.getUint32(end, true) !== TAG_SUM || dv.getUint32(end + 4, true) !== 4) throw new SaveError(SAVE_ERRORS.damaged);
  if (dv.getUint32(end + 8, true) !== crc32(raw.subarray(0, end))) throw new SaveError(SAVE_ERRORS.damaged);
  const r = new Reader(raw, 6, end);
  const header = parseHeader(r.take(r.u32()));
  let cols: Columns | null = null;
  let eco: { eco: EcoSave; fields: SavedField[] } | null = null;
  while (r.left > 0) {
    const t = r.u32();
    const body = r.sub(r.u32());
    if (t === TAG_COLS) cols = readCols(body);
    else if (t === TAG_ECO) eco = readEco(body);
    // Unknown sections (from a later format with additions) are skipped.
  }
  if (!cols || !eco) throw new SaveError(SAVE_ERRORS.damaged);
  return { header, cols, eco: eco.eco, fields: eco.fields };
}

/** Decompress and decode a save file. Throws SaveError with a plain message. */
export async function decodeSave(file: ArrayBuffer): Promise<DecodedSave> {
  let raw: Uint8Array;
  try {
    raw = await inflate(new Uint8Array(file));
  } catch (err) {
    if (err instanceof SaveError) throw err;
    throw new SaveError(SAVE_ERRORS.notASave);
  }
  return decodeRaw(raw);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SaveError(SAVE_ERRORS.damaged);
  return v;
}

function parseHeader(bytes: Uint8Array): SaveHeader {
  let h: unknown;
  try {
    h = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new SaveError(SAVE_ERRORS.damaged);
  }
  if (!isRecord(h) || !isRecord(h.glow)) throw new SaveError(SAVE_ERRORS.damaged);
  // A save made without page state has none (older or scripted saves may leave the key out).
  const page = h.page ?? null;
  if (page !== null && !isRecord(page)) throw new SaveError(SAVE_ERRORS.damaged);
  return {
    format: finite(h.format),
    gameVersion: String(h.gameVersion),
    savedAt: String(h.savedAt),
    seed: finite(h.seed),
    glow: { x: finite(h.glow.x), z: finite(h.glow.z) },
    year: finite(h.year),
    page: page as PageSaveHeader | null,
  };
}

function readCols(r: Reader): Columns {
  if (r.u32() !== NX || r.u32() !== NZ) throw new SaveError(SAVE_ERRORS.otherSize);
  if (r.left !== NX * NZ * COL_BYTES) throw new SaveError(SAVE_ERRORS.damaged);
  const cols = new Columns();
  getRows16(r, cols.rock, 1 / 128, true);
  getRows16(r, cols.sed, 1 / 256, false);
  getRows16(r, cols.lava, 1 / 256, false);
  getTempRows(r, cols.temp);
  getRows8(r, cols.sandKind);
  getRows8(r, cols.rockKind);
  return cols;
}

function getRows16(r: Reader, dst: Float32Array, step: number, signed: boolean): void {
  for (let k = 0; k < NZ; k++) {
    let q = 0;
    const row = k * NX;
    for (let i = 0; i < NX; i++) {
      q = (q + r.u16()) & 0xffff;
      dst[row + i] = (signed ? (q << 16) >> 16 : q) * step;
    }
  }
}

function getTempRows(r: Reader, dst: Float32Array): void {
  for (let k = 0; k < NZ; k++) {
    let q = 0;
    const row = k * NX;
    for (let i = 0; i < NX; i++) {
      q = (q + r.u8()) & 0xff;
      dst[row + i] = q / 255;
    }
  }
}

function getRows8(r: Reader, dst: Uint8Array): void {
  for (let k = 0; k < NZ; k++) {
    let q = 0;
    const row = k * NX;
    for (let i = 0; i < NX; i++) {
      q = (q + r.u8()) & 0xff;
      dst[row + i] = q;
    }
  }
}

function readEco(r: Reader): { eco: EcoSave; fields: SavedField[] } {
  let eco: unknown;
  try {
    eco = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(r.take(r.u32())));
  } catch {
    throw new SaveError(SAVE_ERRORS.damaged);
  }
  if (!isRecord(eco) || typeof eco.version !== 'number' || !('state' in eco)) throw new SaveError(SAVE_ERRORS.damaged);
  const count = r.u32();
  const fields: SavedField[] = [];
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (let f = 0; f < count; f++) {
    let name: string;
    try {
      name = dec.decode(r.take(r.u16()));
    } catch (err) {
      if (err instanceof SaveError) throw err;
      throw new SaveError(SAVE_ERRORS.damaged);
    }
    const type = r.u8();
    const len = r.u32();
    if (type >= ELEMENT_BYTES.length || len % ELEMENT_BYTES[type] !== 0) throw new SaveError(SAVE_ERRORS.damaged);
    fields.push({ name, type, bytes: r.take(len) });
  }
  if (r.left !== 0) throw new SaveError(SAVE_ERRORS.damaged);
  return { eco: { version: eco.version, state: eco.state }, fields };
}

/**
 * Copy saved life-grid fields into a freshly built grid (the ecology registers its fields
 * when it is constructed). Fields the save has but this version no longer keeps are
 * ignored; a field whose type or size differs means the save doesn't fit this version.
 * Everything is checked before anything is copied.
 */
export function applyFields(grid: PatchGrid, fields: SavedField[]): void {
  const live = new Map<string, PatchArray>();
  for (const f of grid.persistentFields()) live.set(f.name, f.arr);
  for (const f of fields) {
    const arr = live.get(f.name);
    if (arr && (typeCode(arr) !== f.type || arr.byteLength !== f.bytes.length)) throw new SaveError(SAVE_ERRORS.lifeMismatch);
  }
  for (const f of fields) {
    const arr = live.get(f.name);
    if (arr) bytesOf(arr).set(f.bytes);
  }
}

/** A fingerprint of every persistent life-grid field (what a save stores), for "same world?" checks. */
export function patchesHash(grid: PatchGrid): number {
  let h = 2166136261 >>> 0;
  for (const f of grid.persistentFields()) {
    for (let i = 0; i < f.name.length; i++) h = Math.imul(h ^ f.name.charCodeAt(i), 16777619) >>> 0;
    const b = bytesOf(f.arr);
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619) >>> 0;
  }
  return h >>> 0;
}

// ---------- checksum ----------

/** CRC-32 lookup table (the common IEEE polynomial), built on first use. */
let crcTable: Uint32Array | null = null;

/** CRC-32 of a byte range: any single damaged byte, or burst of damage, changes it. */
export function crc32(bytes: Uint8Array): number {
  let t = crcTable;
  if (!t) {
    t = crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- compression ----------

async function deflate(raw: Uint8Array): Promise<ArrayBuffer> {
  if (typeof CompressionStream === 'undefined') throw new SaveError(SAVE_ERRORS.noCompression);
  return new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new SaveError(SAVE_ERRORS.noCompression);
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RAW_BYTES) {
      await reader.cancel();
      throw new SaveError(SAVE_ERRORS.tooBig);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
