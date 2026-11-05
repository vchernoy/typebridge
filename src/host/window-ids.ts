/**
 * Stable window ids for the #175 host page (step 3).
 * Layout persistence (positions) arrives in step 5; here we only keep ids.
 */

const STORAGE_KEY = 'typebridge.host.windows.v1';

export type HostWindowRecord = { id: string };

export function readHostWindowIds(storage: Storage = localStorage): string[] {
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

export function ensurePrimaryWindowId(storage: Storage = localStorage): string {
  const existing = readHostWindowIds(storage);
  if (existing[0]) return existing[0];
  const id = 'main';
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, windows: [{ id }] satisfies HostWindowRecord[] }));
  return id;
}
