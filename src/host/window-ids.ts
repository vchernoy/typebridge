/**
 * Stable window ids for the #175 host page (step 3).
 * Layout persistence (positions) arrives in step 5; here we only keep ids.
 */

const STORAGE_KEY = 'typebridge.host.windows.v1';
const FALLBACK_ID = 'main';

export type HostWindowRecord = { id: string };

export function readHostWindowIds(storage: Storage | undefined = localStorage): string[] {
  if (!storage) return [];
  try {
    const raw: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { windows?: unknown }).windows)) {
      return [];
    }
    const windows = (raw as { windows: unknown[] }).windows;
    const ids: string[] = [];
    for (const entry of windows) {
      if (!entry || typeof entry !== 'object') continue;
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) ids.push(id);
    }
    return ids;
  } catch {
    return [];
  }
}

/** Prefer a persisted id; on blocked/full storage still return a usable default. */
export function ensurePrimaryWindowId(storage?: Storage): string {
  let store: Storage | undefined = storage;
  if (store === undefined) {
    try { store = localStorage; } catch { store = undefined; }
  }
  const existing = readHostWindowIds(store);
  if (existing[0]) return existing[0];
  if (store) {
    try {
      store.setItem(STORAGE_KEY, JSON.stringify({ version: 1, windows: [{ id: FALLBACK_ID } satisfies HostWindowRecord] }));
    } catch { /* Keep editing with an in-memory id. */ }
  }
  return FALLBACK_ID;
}
