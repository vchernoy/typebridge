/**
 * Stable window ids for the #175 host page.
 * Layout geometry lives in `layout.ts` (step 5); this module keeps the id helpers.
 */
import { readHostLayout, writeHostLayout, type HostWindowLayout } from './layout';

const FALLBACK_ID = 'main';

export type HostWindowRecord = { id: string };

export function readHostWindowIds(storage: Storage | undefined = localStorage): string[] {
  return readHostLayout(storage)?.windows.map(win => win.id) ?? [];
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
    const primary: HostWindowLayout = {
      id: FALLBACK_ID,
      x: 0,
      y: 0,
      w: 800,
      h: 600,
      z: 1,
    };
    writeHostLayout({ version: 1, windows: [primary] }, store);
  }
  return FALLBACK_ID;
}
