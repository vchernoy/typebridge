import type { ChangeRecord } from './change-log';
import type { EditorHistory } from './editor';
import { EDIT_OWNERSHIP_STORE, nextOwnershipFence, ownershipFenceAllowsWrite, type EditOwnershipRecord } from '../view/ownership';

export type StoredDraft = {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  history?: EditorHistory;
  revision: number;
  /**
   * Change-id of the last change-log record this text already contains (#37 R2c). Records of
   * this document after it continue this text; missing means 0 (rows from before the log).
   */
  upTo?: number;
};
export type CommitResult =
  | { ok: true; draft: StoredDraft }
  | { ok: false; reason: 'conflict'; current: StoredDraft | undefined };

/** Credentials an editing owner presents to the write gate (#159 W4). */
export type WriteFence = { instanceId: string; fence: number };

/** The fence for this document no longer belongs to this window; nothing was written. */
export class EditOwnershipLostError extends Error {
  constructor() { super('Another window owns editing for this document'); this.name = 'EditOwnershipLostError'; }
}

const DATABASE = 'typebridge';
/**
 * Version 2 adds the editOwnership store; version 3 adds the changes store (#37 R2c).
 * Documents rows are unchanged; rows without `upTo` mean 0.
 */
export const DATABASE_VERSION = 3;
const STORE = 'documents';
const OWNERSHIP = EDIT_OWNERSHIP_STORE;
/** Change-log records, keyed [documentId, seq]. */
export const CHANGES_STORE = 'changes';
const CHANGES = CHANGES_STORE;

/** All change records of `documentId` with change-id at most `upTo` (all when omitted). */
function changesOf(documentId: string, upTo = Number.MAX_SAFE_INTEGER): IDBKeyRange {
  return IDBKeyRange.bound([documentId, 0], [documentId, upTo]);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

export function openDraftDatabase(onVersionChange?: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const open = indexedDB.open(DATABASE, DATABASE_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(OWNERSHIP)) db.createObjectStore(OWNERSHIP, { keyPath: 'documentId' });
      if (!db.objectStoreNames.contains(CHANGES)) db.createObjectStore(CHANGES, { keyPath: ['documentId', 'seq'] });
    };
    open.onsuccess = () => {
      const db = open.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); onVersionChange?.(); };
      resolve(db);
    };
    open.onerror = () => reject(open.error ?? new Error('Cannot open IndexedDB'));
    open.onblocked = () => { blocked = true; reject(new Error('Database upgrade blocked. Close other TypeBridge tabs, then reload.')); };
  });
}

export async function listStoredDrafts(db: IDBDatabase): Promise<StoredDraft[]> {
  const tx = db.transaction(STORE, 'readonly');
  const done = finished(tx);
  const drafts = await request(tx.objectStore(STORE).getAll()) as StoredDraft[];
  await done;
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getStoredDraft(db: IDBDatabase, id: string): Promise<StoredDraft | undefined> {
  const tx = db.transaction(STORE, 'readonly');
  const done = finished(tx);
  const draft = await request(tx.objectStore(STORE).get(id)) as StoredDraft | undefined;
  await done;
  return draft;
}

/** Atomic compare-and-swap; expectedRevision=0 means a new document. */
export async function commitDraft(
  db: IDBDatabase,
  draft: Omit<StoredDraft, 'revision'>,
  expectedRevision: number
): Promise<CommitResult> {
  const tx = db.transaction(STORE, 'readwrite');
  const done = finished(tx);
  try {
    const store = tx.objectStore(STORE);
    const current = await request(store.get(draft.id)) as StoredDraft | undefined;
    if ((current?.revision ?? 0) !== expectedRevision) {
      await done;
      return { ok: false, reason: 'conflict', current };
    }
    const next: StoredDraft = { ...draft, revision: expectedRevision + 1 };
    await request(store.put(next));
    await done;
    return { ok: true, draft: next };
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}

/**
 * Fence check inside a write transaction (#159 W4): an editing owner's write commits only while
 * the stored fence still names this window and fence value. Throws to abort the whole transaction.
 */
async function assertEditOwner(tx: IDBTransaction, documentId: string, owner: WriteFence | undefined): Promise<void> {
  if (!owner) return;
  const record = await request(tx.objectStore(OWNERSHIP).get(documentId)) as EditOwnershipRecord | undefined;
  if (!ownershipFenceAllowsWrite(record, owner.instanceId, owner.fence)) throw new EditOwnershipLostError();
}

/**
 * Commit the expected revision or atomically preserve the entire edit as a new draft.
 * With `owner`, the fence for `draft.id` is verified in the same transaction; a mismatch writes nothing.
 * Revision CAS still guards against app versions that do not take part in ownership.
 * A commit also deletes the document's change records up to its `upTo`, which the text now
 * contains (#37 R2c). A conflict copy is a new document with no change log (`upTo` 0).
 */
export async function commitOrCreateConflictCopy(
  db: IDBDatabase,
  draft: Omit<StoredDraft, 'revision'>,
  expectedRevision: number,
  copyId: string,
  owner?: WriteFence,
  /** Remove the document's whole change log: no run continues this text (#37 R2c). */
  clearChanges = false,
): Promise<{ draft: StoredDraft; conflict: boolean }> {
  if (!copyId || copyId === draft.id) throw new Error('Conflict copy requires a distinct ID');
  const tx = db.transaction(owner ? [STORE, OWNERSHIP, CHANGES] : [STORE, CHANGES], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, draft.id, owner);
    const store = tx.objectStore(STORE);
    const current = await request(store.get(draft.id)) as StoredDraft | undefined;
    const conflict = (current?.revision ?? 0) !== expectedRevision;
    const next: StoredDraft = conflict
      ? { ...draft, id: copyId, title: draft.title + ' (conflict copy)', revision: 1, upTo: 0 }
      : { ...draft, revision: expectedRevision + 1, upTo: draft.upTo ?? 0 };
    if (conflict) await request(store.add(next));
    else {
      await request(store.put(next));
      if (clearChanges) await request(tx.objectStore(CHANGES).delete(changesOf(next.id)));
      else if (next.upTo) await request(tx.objectStore(CHANGES).delete(changesOf(next.id, next.upTo)));
    }
    await done;
    return { draft: next, conflict };
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}


/**
 * Delete only the exact revision selected by the user, with its change log. With `owner`, the fence is verified in the
 * same transaction. `dropOwnership` also removes the fence record (the document is gone for good);
 * keep it when this window goes on editing the same id privately.
 */
export async function deleteStoredDraft(
  db: IDBDatabase,
  id: string,
  revision: number,
  owner?: WriteFence,
  dropOwnership = false,
): Promise<boolean> {
  const tx = db.transaction(owner ? [STORE, OWNERSHIP, CHANGES] : [STORE, CHANGES], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, id, owner);
    const store = tx.objectStore(STORE);
    const current = await request(store.get(id)) as StoredDraft | undefined;
    if ((current?.revision ?? 0) !== revision) { await done; return false; }
    if (current) await request(store.delete(id));
    // The change log continued the deleted text; it must never be replayed onto a later one.
    await request(tx.objectStore(CHANGES).delete(changesOf(id)));
    if (owner && dropOwnership) await request(tx.objectStore(OWNERSHIP).delete(id));
    await done;
    return true;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}

/**
 * Record this window as the editing owner of `documentId` with the next fence value. Call only
 * while holding the document's edit-owner Web Lock, so cooperating windows cannot interleave.
 */
export async function claimEditOwnership(db: IDBDatabase, documentId: string, instanceId: string, now: number): Promise<number> {
  const tx = db.transaction(OWNERSHIP, 'readwrite');
  const done = finished(tx);
  try {
    const store = tx.objectStore(OWNERSHIP);
    const current = await request(store.get(documentId)) as EditOwnershipRecord | undefined;
    const record: EditOwnershipRecord = { documentId, ownerInstanceId: instanceId, fence: nextOwnershipFence(current), updatedAt: now };
    await request(store.put(record));
    await done;
    return record.fence;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}

/**
 * Give up a fence this window still holds, so a late write from it cannot land. A record that
 * names another owner is left alone. For a document with no stored row the record is removed;
 * otherwise the fence value is kept so the next owner's fence keeps increasing.
 */
export async function releaseEditOwnership(db: IDBDatabase, documentId: string, owner: WriteFence, now: number): Promise<void> {
  const tx = db.transaction([STORE, OWNERSHIP], 'readwrite');
  const done = finished(tx);
  try {
    const store = tx.objectStore(OWNERSHIP);
    const current = await request(store.get(documentId)) as EditOwnershipRecord | undefined;
    if (ownershipFenceAllowsWrite(current, owner.instanceId, owner.fence)) {
      const row = await request(tx.objectStore(STORE).getKey(documentId));
      if (row === undefined) await request(store.delete(documentId));
      else await request(store.put({ ...current!, ownerInstanceId: '', updatedAt: now }));
    }
    await done;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}

/**
 * Append one change record (#37 R2c). With `owner`, the fence is verified in the same
 * transaction, so a window that lost editing cannot extend the log. `put` replaces a record a
 * crashed earlier run left at the same change-id: replay never mixes runs.
 */
export async function appendChange(db: IDBDatabase, record: ChangeRecord, owner?: WriteFence): Promise<void> {
  const tx = db.transaction(owner ? [CHANGES, OWNERSHIP] : CHANGES, 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, record.documentId, owner);
    await request(tx.objectStore(CHANGES).put(record));
    await done;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}

/** The change records of `documentId`, in change-id order. */
export async function listChanges(db: IDBDatabase, documentId: string): Promise<ChangeRecord[]> {
  const tx = db.transaction(CHANGES, 'readonly');
  const done = finished(tx);
  const records = await request(tx.objectStore(CHANGES).getAll(changesOf(documentId))) as ChangeRecord[];
  await done;
  return records;
}
