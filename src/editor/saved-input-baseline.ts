/** Explicit saved-value choice only; never a substitute for accepted current memory. */
import { inputRecord } from './numeric-inputs';
import { inspectInputSnapshot, type InputSnapshot } from './input-snapshot';
import type { StoredDraft } from './indexeddb';
export type SavedInputBaseline = { kind: 'saved'; snapshot: InputSnapshot; documentRevision: number; inputRevision: number };
/** The caller's current guard must retire on navigation, source or privacy-generation changes. */
export async function readSavedInputBaseline(db: IDBDatabase, documentId: string, epoch: string,
  current: () => boolean, allowed: () => boolean): Promise<SavedInputBaseline | undefined> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!documentId || documentId.length > 128 || epoch.length > 128 || !current() || !allowed()) return;
    const tx = db.transaction(['documents', 'readerStates'], 'readonly');
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Saved input read aborted'));
    });
    void done.catch(() => undefined);
    const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const values = Promise.all([
      read(tx.objectStore('documents').get(documentId)) as Promise<StoredDraft | undefined>,
      read(tx.objectStore('readerStates').get('editable:' + documentId)),
    ]);
    const loaded = (async () => { const rows = await values; await done; return rows; })();
    const [draft, raw] = await Promise.race([loaded, new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        try { tx.abort(); } catch { /* Already settled; its late result is still discarded. */ }
        reject(new Error('Saved input read timed out'));
      }, 2000);
    })]);
    if (!current() || !allowed() || !draft || draft.id !== documentId || (draft.private !== undefined && draft.private !== false) ||
        !Number.isSafeInteger(draft.revision) || draft.revision < 1 || (draft.inputEpoch ?? '') !== epoch) return;
    if (draft.inputEpoch !== undefined && (typeof draft.inputEpoch !== 'string' || !draft.inputEpoch || draft.inputEpoch.length > 128)) return;
    const saved = inputRecord(raw, 'editable:' + documentId);
    if (!saved) return;
    const checked = inspectInputSnapshot({ version: 1, values: saved.inputs });
    return checked.ok ? { kind: 'saved', snapshot: checked.snapshot, documentRevision: draft.revision, inputRevision: saved.revision } : undefined;
  } catch { return; /* Failed proof leaves source-only sharing available. */ }
  finally { clearTimeout(deadline); }
}
