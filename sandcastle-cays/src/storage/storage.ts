/**
 * Keeping your beach: automatic saves in the browser (IndexedDB, with
 * localStorage as a fallback), small settings, and save/load files.
 */
import type { DryingSpeed } from '../config';

const DB_NAME = 'sandcastle-cays';
const STORE = 'saves';
const KEY = 'calm-lagoon';
const LS_SAVE = 'sandcastle-cays:save:calm-lagoon';
const LS_SETTINGS = 'sandcastle-cays:settings';

export interface Settings {
  drying: DryingSpeed;
  sound: boolean;
  quality: 'auto' | 'fast' | 'pretty';
  seenHelp: boolean;
}

export const DEFAULT_SETTINGS: Settings = { drying: 'normal', sound: true, quality: 'auto', seenHelp: false };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* storage blocked: use defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => reject(new Error('IndexedDB timed out')), 3000);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(timer);
      reject(req.error);
    };
  });
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): ArrayBuffer {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Where the last autosave went ('browser' storage, 'backup' storage, or 'none'). */
export let lastSaveWhere: 'browser' | 'backup' | 'none' = 'none';

export async function saveAutosave(data: ArrayBuffer): Promise<boolean> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    lastSaveWhere = 'browser';
    try {
      localStorage.removeItem(LS_SAVE);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    try {
      localStorage.setItem(LS_SAVE, toBase64(data));
      lastSaveWhere = 'backup';
      return true;
    } catch {
      lastSaveWhere = 'none';
      return false;
    }
  }
}

export async function loadAutosave(): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    const data = await new Promise<ArrayBuffer | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (data) return data;
  } catch {
    /* fall through to localStorage */
  }
  try {
    const s = localStorage.getItem(LS_SAVE);
    if (s) return fromBase64(s);
  } catch {
    /* ignore */
  }
  return null;
}

export async function clearAutosave(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(LS_SAVE);
  } catch {
    /* ignore */
  }
}

export function downloadFile(data: ArrayBuffer | Blob, name: string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

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
    document.body.appendChild(input);
    input.click();
  });
}

/** Can this browser keep saves? (Writes and removes a tiny test entry.) */
export async function testStorage(): Promise<'browser' | 'backup' | 'none'> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(new ArrayBuffer(8), 'storage-test');
      tx.objectStore(STORE).delete('storage-test');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return 'browser';
  } catch {
    try {
      localStorage.setItem('sandcastle-cays:test', '1');
      localStorage.removeItem('sandcastle-cays:test');
      return 'backup';
    } catch {
      return 'none';
    }
  }
}
