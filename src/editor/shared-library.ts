/** Immutable received links, separate from editable drafts and future reader-input sidecars. */
import { openDraftDatabase } from './indexeddb';
import { decodeSharePayload, SHARE_PAYLOAD_MAX_CHARS } from './share-link';
import { AUTOSAVE_PREF_KEY } from './drafts';
import { sharedRemovalToken, invalidateSharedRemembering } from './shared-invalidation';
export { SHARED_REMOVAL_KEY, sharedRemovalToken } from './shared-invalidation';
export const REMEMBER_SHARED_EVENT = 'typebridge-remember-shared';
export const REMEMBER_SHARED_KEY = 'typebridge.rememberShared.v1';
export const SHARED_ITEMS = 'sharedItems';
export const SHARED_MAX_ITEMS = 100;
export const SHARED_MAX_BYTES = 10 * 1024 * 1024;
export type SharedItem = { id: string; digest: string; payload: string; bytes: number; createdAt: number; lastOpenedAt: number };
/** Do not reuse privacy.ts's cached fallback as proof that this preference read succeeded. */
export function readerStorageAllowed(storage?: Pick<Storage, 'getItem'>): boolean {
  try { storage ??= localStorage; return storage.getItem(AUTOSAVE_PREF_KEY) !== 'off' && storage.getItem(REMEMBER_SHARED_KEY) !== 'off'; }
  catch { return false; }
}
export function rememberPreference(storage?: Pick<Storage, 'getItem'>): boolean {
  try { storage ??= localStorage; return storage.getItem(REMEMBER_SHARED_KEY) !== 'off'; } catch { return false; }
}
export function setRememberPreference(on: boolean): void {
  localStorage.setItem(REMEMBER_SHARED_KEY, on ? 'on' : 'off');
  window.dispatchEvent(new Event(REMEMBER_SHARED_EVENT));
}
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted'));
});
function validItem(value: unknown): value is SharedItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as SharedItem;
  return typeof v.id === 'string' && !!v.id && typeof v.digest === 'string' && typeof v.payload === 'string'
    && v.payload.length <= SHARE_PAYLOAD_MAX_CHARS + 2 && Number.isFinite(v.bytes) && v.bytes >= 0
    && Number.isFinite(v.createdAt) && Number.isFinite(v.lastOpenedAt);
}
export type RememberResult = 'remembered' | 'full' | 'disabled' | 'invalid' | 'cancelled';
export async function rememberShared(payload: string, current: () => boolean, invalidated: () => void, removal = { token: sharedRemovalToken() }): Promise<RememberResult> {
  const removalToken = removal.token;
  if (!current() || !readerStorageAllowed() || removalToken === undefined) return 'disabled';
  const cancelled = () => !current() || sharedRemovalToken() !== removalToken;
  if (cancelled()) return 'cancelled';
  if (!(await decodeSharePayload(payload)).ok) return 'invalid';
  const bytes = new TextEncoder().encode(payload);
  if (!current() || !readerStorageAllowed()) return 'disabled';
  if (cancelled()) return 'cancelled';
  const db = await openDraftDatabase(invalidated);
  try {
    if (cancelled()) return 'cancelled';
    if (!readerStorageAllowed()) return 'disabled';
    const initial = db.transaction('readerStates'); const initialDone = finished(initial); void initialDone.catch(() => undefined);
    const epoch = await request(initial.objectStore('readerStates').get('libraryEpoch')); await initialDone;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (cancelled()) return 'cancelled';
    if (!readerStorageAllowed()) return 'disabled';
    const tx = db.transaction([SHARED_ITEMS, 'readerStates'], 'readwrite'); const done = finished(tx);
    try {
      const store = tx.objectStore(SHARED_ITEMS);
      const all = await request(store.getAll()) as SharedItem[];
      const nowEpoch = await request(tx.objectStore('readerStates').get('libraryEpoch'));
      if (cancelled() || epoch?.revision !== nowEpoch?.revision) { await done; return 'cancelled'; }
      if (!readerStorageAllowed()) { await done; return 'disabled'; }
      const match = all.find(item => validItem(item) && item.digest === digest && item.payload === payload);
      if (match) store.put({ ...match, lastOpenedAt: Date.now() });
      else {
        // No silent eviction of received sources or future answers. Corrupt rows still count toward capacity.
        const total = all.reduce((n, item) => n + (typeof item.payload === 'string' ? new TextEncoder().encode(item.payload).byteLength : SHARED_MAX_BYTES), 0);
        if (all.length >= SHARED_MAX_ITEMS || total + bytes.byteLength > SHARED_MAX_BYTES) { await done; return 'full'; }
        store.add({ id: crypto.randomUUID(), digest, payload, bytes: bytes.byteLength, createdAt: Date.now(), lastOpenedAt: Date.now() } satisfies SharedItem);
      }
      await done; return 'remembered';
    } catch (error) { try { tx.abort(); } catch { /* Already settled. */ } void done.catch(() => undefined); throw error; }
  } finally { db.close(); }
}
/** Editor UI uses its existing lifecycle-owned connection; it never reopens storage after clear. */
export async function listSharedItems(db: IDBDatabase): Promise<SharedItem[]> {
  const tx = db.transaction(SHARED_ITEMS); const done = finished(tx); void done.catch(() => undefined);
  const rows = await request(tx.objectStore(SHARED_ITEMS).getAll()); await done;
  return rows.filter(validItem).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export async function removeSharedItem(db: IDBDatabase, id: string): Promise<void> {
  // Publish before any await: work still decoding/opening must not adopt the new epoch.
  // If this write fails, refuse removal rather than promising invalidation we cannot enforce.
  invalidateSharedRemembering();
  const tx = db.transaction([SHARED_ITEMS, 'readerStates'], 'readwrite'); const done = finished(tx); void done.catch(() => undefined);
  try {
    const epochs = tx.objectStore('readerStates');
    const epoch = await request(epochs.get('libraryEpoch'));
    epochs.put({ id: 'libraryEpoch', revision: (epoch?.revision ?? 0) + 1 });
    tx.objectStore(SHARED_ITEMS).delete(id); epochs.delete('shared:' + id); await done;
  } catch (error) { try { tx.abort(); } catch { /* Already settled. */ } throw error; }
}
