/** Numeric reader state only; immutable payload/source and editable drafts are never changed. */
import { openDraftDatabase } from './indexeddb';
import { readerStorageAllowed, SHARED_ITEMS, type SharedItem } from './shared-library';
import { sharedRemovalToken } from './shared-invalidation';
export const INPUT_LIMIT = 256;
export const INPUT_BYTES = 64 * 1024;
export type InputRecord = { id: string; version: 1; revision: number; inputs: [string, number][] };
export function numericInputs(value: unknown): Map<string, number> | undefined {
  if (!Array.isArray(value) || value.length > INPUT_LIMIT) return;
  const result = new Map<string, number>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || entry[0].length > 128
        || typeof entry[1] !== 'number' || !Number.isFinite(entry[1]) || result.has(entry[0])) return;
    result.set(entry[0], entry[1]);
  }
  return new TextEncoder().encode(JSON.stringify([...result])).byteLength <= INPUT_BYTES ? result : undefined;
}
function record(value: unknown, id: string): InputRecord | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as InputRecord;
  if (row.id !== id || id.length > 135 || row.version !== 1 || !Number.isSafeInteger(row.revision) || row.revision < 1 || !numericInputs(row.inputs)) return;
  return new TextEncoder().encode(JSON.stringify({ id, version: 1, revision: row.revision, inputs: row.inputs })).byteLength <= INPUT_BYTES ? row : undefined;
}
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Reader state transaction aborted'));
});
export type InputSave = 'saved' | 'conflict' | 'cancelled';
export async function openSharedInputs(payload: string, current: () => boolean, invalidated: () => void) {
  const removal = sharedRemovalToken();
  const allowed = () => current() && readerStorageAllowed() && removal !== undefined && sharedRemovalToken() === removal;
  if (!allowed()) return;
  let ended = false;
  const db = await openDraftDatabase(() => { ended = true; invalidated(); });
  const valid = () => !ended && allowed();
  try {
    if (!valid()) { db.close(); return; }
    const tx = db.transaction([SHARED_ITEMS, 'readerStates']); const done = finished(tx); void done.catch(() => undefined);
    const items = await request(tx.objectStore(SHARED_ITEMS).getAll()) as SharedItem[];
    const item = items.find(row => row.payload === payload);
    if (!item || item.id.length > 128) { await done; db.close(); return; }
    const id = 'shared:' + item.id;
    const raw = await request(tx.objectStore('readerStates').get(id)); await done;
    if (!valid()) { db.close(); return; }
    let saved = record(raw, id);
    if (raw !== undefined && !saved) throw new Error('Saved reader state is incompatible');
    let revision = saved?.revision ?? 0;
    const read = async (): Promise<Map<string, number>> => {
      if (!valid()) throw new Error('Reader storage ended');
      const tx = db.transaction([SHARED_ITEMS, 'readerStates']); const done = finished(tx); void done.catch(() => undefined);
      const itemNow = await request(tx.objectStore(SHARED_ITEMS).get(item.id)) as SharedItem | undefined;
      const rawNow = await request(tx.objectStore('readerStates').get(id)); await done;
      if (!valid() || itemNow?.payload !== payload) throw new Error('Shared item was removed');
      const next = record(rawNow, id);
      if (rawNow !== undefined && !next) throw new Error('Saved reader state is incompatible');
      saved = next; revision = next?.revision ?? 0;
      return new Map(next?.inputs ?? []);
    };
    return {
      id: item.id, get revision() { return revision; }, inputs: new Map(saved?.inputs ?? []), read,
      async save(inputs: ReadonlyMap<string, number>): Promise<InputSave> {
        const values = [...inputs];
        if (!numericInputs(values)) throw new Error('Reader inputs exceed the storage limit');
        if (!valid()) return 'cancelled';
        const tx = db.transaction([SHARED_ITEMS, 'readerStates'], 'readwrite'); const done = finished(tx); void done.catch(() => undefined);
        try {
          const itemNow = await request(tx.objectStore(SHARED_ITEMS).get(item.id)) as SharedItem | undefined;
          const store = tx.objectStore('readerStates'); const rawNow = await request(store.get(id));
          const next = record(rawNow, id);
          if (!valid() || itemNow?.payload !== payload) { await done; return 'cancelled'; }
          if ((rawNow !== undefined && !next) || (next?.revision ?? 0) !== revision) { await done; return 'conflict'; }
          const written = revision + 1;
          if (!Number.isSafeInteger(written)) throw new Error('Reader revision exhausted');
          const row: InputRecord = { id, version: 1, revision: written, inputs: values };
          if (!record(row, id)) throw new Error('Reader state exceeds the storage limit');
          await request(store.put(row));
          if (!valid()) { tx.abort(); await done; return 'cancelled'; }
          await done; revision = written; return 'saved';
        } catch (error) { try { tx.abort(); } catch { /* Settled. */ } throw error; }
      },
      close() { ended = true; db.close(); },
    };
  } catch (error) { db.close(); throw error; }
}
export type SharedInputs = NonNullable<Awaited<ReturnType<typeof openSharedInputs>>>;
