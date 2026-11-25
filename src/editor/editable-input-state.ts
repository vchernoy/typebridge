/** Editable reader sidecars never modify the authoritative source or its revision. */
import { inputRecord, numericInputs, type InputRecord } from './numeric-inputs';
import type { InputSave } from './shared-input-state';
import type { StoredDraft } from './indexeddb';
const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Input transaction aborted'));
});
export async function openEditableInputs(db: IDBDatabase, documentId: string, current: () => boolean, canEditInputs: () => boolean) {
  const id = 'editable:' + documentId;
  let ended = false;
  const valid = () => { if (!current()) ended = true; return !ended; };
  if (!valid()) return;
  const tx = db.transaction(['documents', 'readerStates']); const done = finished(tx); void done.catch(() => undefined);
  const draft = await request(tx.objectStore('documents').get(documentId)) as StoredDraft | undefined;
  const raw = await request(tx.objectStore('readerStates').get(id)); await done;
  if (!valid()) return;
  if (!draft || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || draft.private) throw new Error('Document inputs are not persistable');
  const saved = inputRecord(raw, id);
  if (raw !== undefined && !saved) throw new Error('Incompatible reader state');
  if (draft.inputEpoch !== undefined && (typeof draft.inputEpoch !== 'string' || !draft.inputEpoch || draft.inputEpoch.length > 128)) throw new Error('Invalid document input policy');
  const epoch = draft.inputEpoch ?? '';
  let revision = saved?.revision ?? 0;
  return {
    inputs: new Map(saved?.inputs ?? []),
    epoch,
    get revision() { return revision; },
    async save(values: ReadonlyMap<string, number>, expectedRevision = revision): Promise<InputSave> {
      if (!valid() || !canEditInputs()) return 'cancelled';
      const inputs = [...values];
      if (!numericInputs(inputs)) throw new Error('Reader inputs exceed limits');
      const tx = db.transaction(['documents', 'readerStates'], 'readwrite');
      const done = finished(tx); void done.catch(() => undefined);
      try {
        const row = await request(tx.objectStore('documents').get(documentId)) as StoredDraft | undefined;
        const store = tx.objectStore('readerStates'); const raw = await request(store.get(id)); const previous = inputRecord(raw, id);
        if (!row || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.private || (row.inputEpoch ?? '') !== epoch) { ended = true; await done; return 'cancelled'; }
        if (!valid() || !canEditInputs()) { await done; return 'cancelled'; }
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (raw !== undefined && !previous) || (previous?.revision ?? 0) !== expectedRevision) { await done; return 'conflict'; }
        const next: InputRecord = { id, version: 1, revision: expectedRevision + 1, inputs };
        if (!inputRecord(next, id)) throw new Error('Reader state exceeds limits');
        await request(store.put(next));
        if (!valid() || !canEditInputs()) { tx.abort(); await done; return 'cancelled'; }
        await done; revision = next.revision; return 'saved';
      } catch (error) { try { tx.abort(); } catch { /* Settled. */ } throw error; }
    },
    close() { ended = true; },
  };
}
