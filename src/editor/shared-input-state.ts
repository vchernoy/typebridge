/** Numeric reader state only; immutable payload/source and editable drafts are never changed. */
import { openDraftDatabase } from './indexeddb';
import { readerStorageAllowed, SHARED_ITEMS, type SharedItem } from './shared-library';
import { sharedRemovalToken } from './shared-invalidation';
import { inputRecord, numericInputs, type InputRecord } from './numeric-inputs';
export { INPUT_LIMIT, INPUT_BYTES, numericInputs } from './numeric-inputs';
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Reader state transaction aborted'));
});
export type InputSave = 'saved' | 'conflict' | 'cancelled';
export async function openSharedInputs(payload: string, current: () => boolean, invalidated: () => void) {
  const removal = sharedRemovalToken();
  let ended = false;
  const allowed = (): boolean => {
    if (ended || !current()) return false;
    if (!readerStorageAllowed() || removal === undefined || sharedRemovalToken() !== removal) {
      ended = true; invalidated(); return false;
    }
    return true;
  };
  if (!allowed()) return;
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
    let saved = inputRecord(raw, id);
    if (raw !== undefined && !saved) throw new Error('Saved reader state is incompatible');
    let revision = saved?.revision ?? 0;
    const read = async (): Promise<Map<string, number>> => {
      if (!valid()) throw new Error('Reader storage ended');
      const tx = db.transaction([SHARED_ITEMS, 'readerStates']); const done = finished(tx); void done.catch(() => undefined);
      const itemNow = await request(tx.objectStore(SHARED_ITEMS).get(item.id)) as SharedItem | undefined;
      const rawNow = await request(tx.objectStore('readerStates').get(id)); await done;
      if (!valid() || itemNow?.payload !== payload) throw new Error('Shared item was removed');
      const next = inputRecord(rawNow, id);
      if (rawNow !== undefined && !next) throw new Error('Saved reader state is incompatible');
      saved = next; revision = next?.revision ?? 0;
      return new Map(next?.inputs ?? []);
    };
    return {
      id: item.id, get revision() { return revision; }, get hasSnapshot() { return revision > 0; }, inputs: new Map(saved?.inputs ?? []), read,
      async save(inputs: ReadonlyMap<string, number>): Promise<InputSave> {
        const values = [...inputs];
        if (!numericInputs(values)) throw new Error('Reader inputs exceed the storage limit');
        if (!valid()) return 'cancelled';
        const tx = db.transaction([SHARED_ITEMS, 'readerStates'], 'readwrite'); const done = finished(tx); void done.catch(() => undefined);
        try {
          const itemNow = await request(tx.objectStore(SHARED_ITEMS).get(item.id)) as SharedItem | undefined;
          const store = tx.objectStore('readerStates'); const rawNow = await request(store.get(id));
          const next = inputRecord(rawNow, id);
          if (!valid() || itemNow?.payload !== payload) { await done; return 'cancelled'; }
          if ((rawNow !== undefined && !next) || (next?.revision ?? 0) !== revision) { await done; return 'conflict'; }
          const written = revision + 1;
          if (!Number.isSafeInteger(written)) throw new Error('Reader revision exhausted');
          const row: InputRecord = { id, version: 1, revision: written, inputs: values };
          if (!inputRecord(row, id)) throw new Error('Reader state exceeds the storage limit');
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
