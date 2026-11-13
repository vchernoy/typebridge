import { documentFields, sameFields, type DocumentFields, type DocumentFieldsInput } from './document-fields';
import { replayDocument, type ChangeRecord } from './change-log';
import type { EditorHistory } from './editor';
import { EDIT_OWNERSHIP_STORE, nextOwnershipFence, ownershipFenceAllowsWrite, type EditOwnershipRecord } from '../view/ownership';

export type StoredDraft = {
  id: string;
  title: string;
  text: string;
  /** Missing on pre-v6 rows means empty; UI binding is step 2b. */
  find?: string;
  replace?: string;
  /** Reserved per-field histories; existing Undo/Redo behavior is unchanged in 2a. */
  titleHistory?: EditorHistory;
  findHistory?: EditorHistory;
  replaceHistory?: EditorHistory;
  updatedAt: number;
  history?: EditorHistory;
  revision: number;
  /**
   * Change-id of the last change-log record these four fields already contain (#37 R2c). Records of
   * this document after it continue this text; missing means 0 (rows from before the log).
   */
  upTo?: number;
  /**
   * When true, this document is private (#257): content/history typed while private are never
   * written. Missing means false. The flag is metadata written when going private so the
   * document reopens private.
   */
  private?: boolean;
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
 * Version 4 (#256, reverted) added a discardMarkers store; version 5 removes it again, so
 * browsers that already upgraded to 4 keep opening the database (#257).
 * Version 6 replaces the text/title log with field-tagged value-or-change records.
 * No log migration: clear changes during upgrade. Missing find/replace in rows means empty.
 */
export const DATABASE_VERSION = 6;
/** Store added by version 4 and removed by version 5. */
const REMOVED_DISCARD_MARKERS = 'discardMarkers';
const STORE = 'documents';
const OWNERSHIP = EDIT_OWNERSHIP_STORE;
/** Change-log records, keyed [documentId, seq]. */
export const CHANGES_STORE = 'changes';
const CHANGES = CHANGES_STORE;

/**
 * After a save of `documentId` at `upTo`: delete every record another run wrote (it can never
 * continue this text) and `keepRun`'s records up to `upTo` (the text contains them).
 */
async function pruneChanges(store: IDBObjectStore, documentId: string, upTo: number, keepRun: string): Promise<void> {
  await request(store.delete(changesOf(documentId, upTo)));
  const records = await request(store.getAll(changesOf(documentId))) as ChangeRecord[];
  for (const record of records) {
    if (record.run !== keepRun) await request(store.delete([documentId, record.seq]));
  }
}

/** All four fields at the consistent prefix another run adds to the stored row. */
type LostState = DocumentFields;

/**
 * Crash recovery from the change log (#37 R2c): what other runs' records (not `keepRun`'s) add to
 * the stored row `current`. Undefined when they add nothing (or only reproduce the row's text and
 * title/find/replace). Recovery must compare every field, including search-only changes.
 */
async function replayOtherRuns(tx: IDBTransaction, current: StoredDraft | undefined, keepRun: string | undefined): Promise<LostState | undefined> {
  if (!current) return undefined;
  const records = (await request(tx.objectStore(CHANGES).getAll(changesOf(current.id))) as ChangeRecord[])
    .filter(record => record.run !== keepRun);
  const replay = replayDocument(current.id, current, current.upTo ?? 0, records);
  if (replay.applied === 0 || sameFields(replay, current)) return undefined;
  return documentFields(replay);
}

/** Keep all four recovered fields as a new document "<title> (recovered)". */
async function addRecoveredCopy(tx: IDBTransaction, lost: LostState, recoveryId: string, now: number): Promise<StoredDraft> {
  const copy: StoredDraft = { ...lost, id: recoveryId, title: lost.title + ' (recovered)', updatedAt: now, revision: 1, upTo: 0 };
  await request(tx.objectStore(STORE).add(copy));
  return copy;
}

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
      else open.transaction!.objectStore(CHANGES).clear();
      if (db.objectStoreNames.contains(REMOVED_DISCARD_MARKERS)) db.deleteObjectStore(REMOVED_DISCARD_MARKERS);
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
  return drafts.map(draft => ({ ...draft, ...documentFields(draft) })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getStoredDraft(db: IDBDatabase, id: string): Promise<StoredDraft | undefined> {
  const tx = db.transaction(STORE, 'readonly');
  const done = finished(tx);
  const draft = await request(tx.objectStore(STORE).get(id)) as StoredDraft | undefined;
  await done;
  return draft ? { ...draft, ...documentFields(draft) } : undefined;
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
    const next: StoredDraft = { ...draft, ...documentFields(draft), revision: expectedRevision + 1 };
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
  /**
   * The editing run that continues this text (#37 R2c): the commit keeps only its records
   * after `upTo`, and first saves what other runs' records add to the stored text as a recovered
   * copy with id `recoveryId`. Without it (a new document from import or a share link), only
   * records up to `upTo` are removed.
   */
  changes?: { keepRun: string; recoveryId: string },
): Promise<{ draft: StoredDraft; conflict: boolean; recovered?: StoredDraft }> {
  if (!copyId || copyId === draft.id) throw new Error('Conflict copy requires a distinct ID');
  const tx = db.transaction(owner ? [STORE, OWNERSHIP, CHANGES] : [STORE, CHANGES], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, draft.id, owner);
    const store = tx.objectStore(STORE);
    const current = await request(store.get(draft.id)) as StoredDraft | undefined;
    const conflict = (current?.revision ?? 0) !== expectedRevision;
    const next: StoredDraft = conflict
      ? { ...draft, ...documentFields(draft), id: copyId, title: draft.title + ' (conflict copy)', revision: 1, upTo: 0 }
      : { ...draft, ...documentFields(draft), revision: expectedRevision + 1, upTo: draft.upTo ?? 0 };
    let recovered: StoredDraft | undefined;
    if (conflict) await request(store.add(next));
    else {
      await request(store.put(next));
      if (changes) {
        // Other runs' lost state is kept as a copy before their records go, unless this very
        // commit stores all four fields (same transaction, so it is durable either way).
        const lost = await replayOtherRuns(tx, current, changes.keepRun);
        if (current && lost !== undefined && !sameFields(lost, next)) {
          recovered = await addRecoveredCopy(tx, lost, changes.recoveryId, draft.updatedAt);
        }
        await pruneChanges(tx.objectStore(CHANGES), next.id, next.upTo ?? 0, changes.keepRun);
      } else if (next.upTo) await request(tx.objectStore(CHANGES).delete(changesOf(next.id, next.upTo)));
    }
    await done;
    return recovered ? { draft: next, conflict, recovered } : { draft: next, conflict };
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}


/**
 * Ownership-fenced update of only the `private` flag (#257). Never changes text, title,
 * history or upTo. Never overrides a revision conflict (CAS). Used when the last full save
 * before going private failed but the flag must still become durable.
 */
export async function updateDocumentPrivateFlag(
  db: IDBDatabase,
  documentId: string,
  privateFlag: boolean,
  expectedRevision: number,
  owner: WriteFence,
): Promise<
  | { ok: true; draft: StoredDraft }
  | { ok: false; reason: 'conflict' | 'missing'; current: StoredDraft | undefined }
> {
  if (!owner?.instanceId || !Number.isSafeInteger(owner.fence)) throw new EditOwnershipLostError();
  const tx = db.transaction([STORE, OWNERSHIP], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, documentId, owner);
    const store = tx.objectStore(STORE);
    const current = await request(store.get(documentId)) as StoredDraft | undefined;
    if (!current) {
      await done;
      return { ok: false, reason: 'missing', current: undefined };
    }
    if (current.revision !== expectedRevision) {
      await done;
      return { ok: false, reason: 'conflict', current };
    }
    // Missing means false — omit the field when clearing rather than storing false.
    const next: StoredDraft = { ...current };
    if (privateFlag) next.private = true;
    else delete next.private;
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
 * Remove every change-log record for `documentId` (#37 R2c 2d-2 / #254). Used when the user
 * explicitly discards unsaved edits so salvage cannot resurrect them. Requires the ownership
 * fence: never clears without it, so a stale window cannot wipe another owner's log. Clears all
 * runs of this document — the fence holder is the only live writer; crashed runs were salvaged
 * at ownership, and open-time kept records match the text being discarded.
 */
export async function clearDocumentChanges(
  db: IDBDatabase, documentId: string, owner: WriteFence,
): Promise<void> {
  // Require a fence at runtime too: a missing owner must not fall through assertEditOwner's no-op.
  if (!owner?.instanceId || !Number.isSafeInteger(owner.fence)) throw new EditOwnershipLostError();
  const tx = db.transaction([CHANGES, OWNERSHIP], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, documentId, owner);
    await request(tx.objectStore(CHANGES).delete(changesOf(documentId)));
    await done;
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

/**
 * When a window starts editing `documentId` (#37 R2c): changes another run left after the stored
 * row (a window that crashed or was killed) are replayed and kept as a recovered copy, and those
 * records are removed, in one transaction under the ownership fence. `keepRun` is this window's
 * own run, if it has one. Returns the copy, or undefined when nothing was lost or the lost text
 * and title are what this window shows (then the records stay until a save commits them).
 */
export async function salvageChanges(
  db: IDBDatabase, documentId: string, owner: WriteFence, recoveryId: string, keepRun: string | undefined, now: number,
  /**
   * All four fields this window shows (e.g. a reload backup or a handoff). When the lost state is
   * exactly the same, no copy is made and the records are kept: shown state is not stored yet.
   */
  shown?: DocumentFieldsInput,
): Promise<StoredDraft | undefined> {
  const tx = db.transaction([STORE, OWNERSHIP, CHANGES], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, documentId, owner);
    const current = await request(tx.objectStore(STORE).get(documentId)) as StoredDraft | undefined;
    const lost = await replayOtherRuns(tx, current, keepRun);
    // Shown fields are not durable (a reload backup, a handoff): when they are the lost
    // state, keep the records; the save that commits them removes them (#252 review, #37 2d-1).
    if (lost !== undefined && shown !== undefined && sameFields(lost, shown)) {
      await done;
      return undefined;
    }
    const recovered = current && lost !== undefined ? await addRecoveredCopy(tx, lost, recoveryId, now) : undefined;
    const store = tx.objectStore(CHANGES);
    const records = await request(store.getAll(changesOf(documentId))) as ChangeRecord[];
    for (const record of records) {
      if (record.run !== keepRun) await request(store.delete([documentId, record.seq]));
    }
    await done;
    return recovered;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}
