/**
 * Keeping your sea: player settings, automatic saves in the browser, and save files.
 *
 * Autosaves go to IndexedDB in two slots, A and B, each stamped with the time it was written.
 * Every autosave writes the OLDER slot, so if the browser crashes or the phone dies halfway
 * through a save, the other slot still holds the previous good copy. Loading picks the newest
 * slot that looks like a real save (it starts with the "WWWS" mark the engine writes).
 *
 * If IndexedDB is missing or blocked (some phones, when the file is opened from Downloads),
 * one copy goes to localStorage instead. Every storage call has a timeout, because a stuck
 * browser database must never freeze the game.
 *
 * Settings are small and live in localStorage.
 */
import { STORAGE_ID, type PaceId, type QualityId } from '../config';

// ---------- settings ----------

export type DayMode = 'cycle' | 'day' | 'golden';

export interface Settings {
  /** How fast the years go (gentle 1, normal 2, brisk 5 years a second). */
  pace: PaceId;
  gentleStorms: boolean;
  /** Softer lightning, no sky flashes. */
  fewerFlashes: boolean;
  sound: boolean;
  /** Master volume 0..1. */
  volume: number;
  quality: QualityId;
  /** In watch mode the camera drifts toward where life is happening. */
  cameraDrift: boolean;
  /** Buzz the phone gently while pouring. */
  vibration: boolean;
  /** Sky clock: day and night, always day, or always golden hour. */
  dayMode: DayMode;
  /** One-time hints the player has already seen (tool lines, journal line, gesture hint). */
  seen: string[];
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  pace: 'normal',
  gentleStorms: false,
  fewerFlashes: false,
  sound: true,
  volume: 0.8,
  quality: 'auto',
  cameraDrift: true,
  vibration: true,
  dayMode: 'cycle',
  seen: [],
};

const LS_SETTINGS = `${STORAGE_ID}:settings`;

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

/** Turn whatever was stored (maybe from an older version, maybe hand-edited) into valid settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const bool = (v: unknown, f: boolean) => (typeof v === 'boolean' ? v : f);
  const vol = typeof r.volume === 'number' && Number.isFinite(r.volume) ? Math.max(0, Math.min(1, r.volume)) : d.volume;
  return {
    pace: oneOf<PaceId>(r.pace, ['gentle', 'normal', 'brisk'], d.pace),
    gentleStorms: bool(r.gentleStorms, d.gentleStorms),
    fewerFlashes: bool(r.fewerFlashes, d.fewerFlashes),
    sound: bool(r.sound, d.sound),
    volume: vol,
    quality: oneOf<QualityId>(r.quality, ['auto', 'lighter', 'richer'], d.quality),
    cameraDrift: bool(r.cameraDrift, d.cameraDrift),
    vibration: bool(r.vibration, d.vibration),
    dayMode: oneOf<DayMode>(r.dayMode, ['cycle', 'day', 'golden'], d.dayMode),
    seen: Array.isArray(r.seen) ? r.seen.filter((s): s is string => typeof s === 'string').slice(0, 64) : [],
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) return sanitizeSettings(JSON.parse(raw));
  } catch {
    /* storage blocked or unreadable: use defaults */
  }
  return sanitizeSettings(null);
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  } catch {
    /* storage blocked: settings last for this visit only */
  }
}

// ---------- helpers ----------

/** Reject if a promise takes longer than `ms` (a stuck database must never hang the game). */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Does this look like a save the engine wrote? (It starts with the four letters "WWWS".) */
export function isSaveData(buf: ArrayBuffer | null | undefined): buf is ArrayBuffer {
  if (!buf || buf.byteLength < 16) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x57 && b[1] === 0x57 && b[2] === 0x57 && b[3] === 0x53;
}

export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ---------- autosave slots ----------

export type SlotId = 'A' | 'B' | 'LS';

/** What is stored next to each slot's data, so slots can be compared without reading the data. */
export interface SlotMeta {
  slot: SlotId;
  /** When it was written (ms since 1970). */
  time: number;
  bytes: number;
  /** The island's year when saved (shown nowhere; handy when checking saves by hand). */
  year: number;
}

export interface Autosave extends SlotMeta {
  data: ArrayBuffer;
}

/** Newest first; slots missing or broken are left out. */
export function orderSlots<T extends SlotMeta>(slots: (T | null | undefined)[]): T[] {
  return slots.filter((s): s is T => !!s && Number.isFinite(s.time)).sort((a, b) => b.time - a.time);
}

/** The slot to write next: never the newest good one. */
export function nextSlot(metas: (SlotMeta | null | undefined)[]): 'A' | 'B' {
  const a = metas.find((m) => m?.slot === 'A');
  const b = metas.find((m) => m?.slot === 'B');
  if (!a) return 'A';
  if (!b) return 'B';
  return a.time <= b.time ? 'A' : 'B';
}

const DB_NAME = STORAGE_ID;
const STORE = 'saves';
const LS_SAVE = `${STORAGE_ID}:autosave`;
const LS_META = `${STORAGE_ID}:autosave-meta`;
const OPEN_MS = 3000;
const TX_MS = 8000;

function openDB(): Promise<IDBDatabase> {
  return withTimeout(
    new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('no IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB would not open'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
    }),
    OPEN_MS,
    'Opening browser storage',
  );
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('storage write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('storage write aborted'));
  });
}

function reqResult<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('storage read failed'));
  });
}

async function readMetas(db: IDBDatabase): Promise<SlotMeta[]> {
  const tx = db.transaction(STORE, 'readonly');
  const st = tx.objectStore(STORE);
  const [a, b] = await withTimeout(
    Promise.all([reqResult<SlotMeta | undefined>(st.get('meta-A')), reqResult<SlotMeta | undefined>(st.get('meta-B'))]),
    TX_MS,
    'Reading saves',
  );
  return orderSlots([a, b]);
}

/**
 * Keep an automatic copy. Writes the older of the two slots (data and its time stamp in one
 * transaction, so they can never disagree). Falls back to localStorage. Returns where it went:
 * the browser database, the smaller backup storage, or nowhere.
 */
export async function saveAutosave(data: ArrayBuffer, year: number): Promise<'browser' | 'backup' | 'none'> {
  const meta = (slot: SlotId): SlotMeta => ({ slot, time: Date.now(), bytes: data.byteLength, year });
  try {
    const db = await openDB();
    try {
      const slot = nextSlot(await readMetas(db));
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      st.put(data, `slot-${slot}`);
      st.put(meta(slot), `meta-${slot}`);
      await withTimeout(txDone(tx), TX_MS, 'Saving');
    } finally {
      db.close();
    }
    try {
      localStorage.removeItem(LS_SAVE);
      localStorage.removeItem(LS_META);
    } catch {
      /* nothing to tidy */
    }
    return 'browser';
  } catch {
    try {
      localStorage.setItem(LS_SAVE, toBase64(data));
      localStorage.setItem(LS_META, JSON.stringify(meta('LS')));
      return 'backup';
    } catch {
      return 'none';
    }
  }
}

/** Every good autosave, newest first (usually two: the latest and the one before it). */
export async function loadAutosaves(): Promise<Autosave[]> {
  const found: Autosave[] = [];
  try {
    const db = await openDB();
    try {
      for (const m of await readMetas(db)) {
        const tx = db.transaction(STORE, 'readonly');
        const data = await withTimeout(reqResult<ArrayBuffer | undefined>(tx.objectStore(STORE).get(`slot-${m.slot}`)), TX_MS, 'Reading a save');
        if (isSaveData(data)) found.push({ ...m, data });
      }
    } finally {
      db.close();
    }
  } catch {
    /* fall through to the backup copy */
  }
  try {
    const s = localStorage.getItem(LS_SAVE);
    const m = localStorage.getItem(LS_META);
    if (s && m) {
      const meta = JSON.parse(m) as SlotMeta;
      const data = fromBase64(s);
      if (isSaveData(data)) found.push({ ...meta, slot: 'LS', data });
    }
  } catch {
    /* no backup copy */
  }
  return orderSlots(found);
}

// ---------- files ----------

/** Hand the player a file (a save, or a photo they took). */
export function downloadFile(data: ArrayBuffer | Blob, name: string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Ask the player for a file; resolves with its bytes, or null if they cancelled. */
export function pickFile(accept: string): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      f.arrayBuffer().then(resolve, () => resolve(null));
    };
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** A file name with the date, e.g. "wind-wing-wave-2026-10-06-1432.wwwsave". */
export function saveFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `wind-wing-wave-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.wwwsave`;
}

// ---------- the checks page ----------

export interface StorageTest {
  where: 'browser' | 'backup' | 'none';
  /** Milliseconds for the write and read back. */
  ms: number;
  bytes: number;
}

/**
 * Can this browser keep a sea? Writes about `bytes` of test data, reads it back, compares it
 * and removes it. Tries the browser database first, then the smaller backup storage.
 */
export async function testStorage(bytes = 1 << 20): Promise<StorageTest> {
  const data = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) data[i] = (i * 2654435761) >>> 24;
  const same = (b: ArrayBuffer | undefined) => {
    if (!b || b.byteLength !== bytes) return false;
    const v = new Uint8Array(b);
    for (let i = 0; i < bytes; i += 997) if (v[i] !== data[i]) return false;
    return v[bytes - 1] === data[bytes - 1];
  };
  const t0 = performance.now();
  try {
    const db = await openDB();
    try {
      const w = db.transaction(STORE, 'readwrite');
      w.objectStore(STORE).put(data.buffer, 'storage-test');
      await withTimeout(txDone(w), TX_MS, 'Test write');
      const r = db.transaction(STORE, 'readonly');
      const back = await withTimeout(reqResult<ArrayBuffer | undefined>(r.objectStore(STORE).get('storage-test')), TX_MS, 'Test read');
      const d = db.transaction(STORE, 'readwrite');
      d.objectStore(STORE).delete('storage-test');
      await withTimeout(txDone(d), TX_MS, 'Test tidy');
      if (same(back)) return { where: 'browser', ms: performance.now() - t0, bytes };
    } finally {
      db.close();
    }
  } catch {
    /* try the backup storage */
  }
  const key = `${STORAGE_ID}:storage-test`;
  try {
    localStorage.setItem(key, toBase64(data.buffer));
    const back = localStorage.getItem(key);
    localStorage.removeItem(key);
    if (back && same(fromBase64(back))) return { where: 'backup', ms: performance.now() - t0, bytes };
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to tidy */
    }
  }
  return { where: 'none', ms: performance.now() - t0, bytes };
}
