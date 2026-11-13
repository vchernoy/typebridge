import { replayText, type ChangeRecord } from './change-log';
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
 * Version 4 adds discardMarkers for update-reload discard (#255).
 * Documents rows are unchanged; rows without `upTo` mean 0.
 */
export const DATABASE_VERSION = 4;
const STORE = 'documents';
const OWNERSHIP = EDIT_OWNERSHIP_STORE;
/** Change-log records, keyed [documentId, seq]. */
export const CHANGES_STORE = 'changes';
const CHANGES = CHANGES_STORE;
/** Reload-discard intent, keyed by documentId (#255). */
export const DISCARD_MARKERS_STORE = 'discardMarkers';
const DISCARD_MARKERS = DISCARD_MARKERS_STORE;

/** Written at "Discard changes and reload" consent; applied on the next load under a live fence. */
export type ReloadDiscardMarker = {
  documentId: string;
  /** Highest change-id present for the document when the marker was written (0 if none). */
  upToSeq: number;
  /** Consenting window's instance id (pairs with sessionStorage intent). */
  instanceId: string;
  /** Ownership fence at write time (informational; apply uses the live fence). */
  fence: number;
};

/**
 * After a save of `documentId` at `upTo`: delete every record another run wrote (it can never
 * continue this text) and `keepRun`'s records up to `upTo` (the text contains them).
 */
async function pruneChanges(store: IDBObjectStore, documentId: string, upTo: number, keepRun: string): Promise<void> {
  const records = await request(store.getAll(changesOf(documentId))) as ChangeRecord[];
  for (const record of records) {
    if (record.run !== keepRun || record.seq <= upTo) await request(store.delete([documentId, record.seq]));
  }
}

/** Lost state another run's records add to the stored row: text and the title that goes with it. */
type LostState = { text: string; title: string };

/**
 * Crash recovery from the change log (#37 R2c): what other runs' records (not `keepRun`'s) add to
 * the stored row `current`. Undefined when they add nothing (or only reproduce the row's text and
 * title). The title is the last one an applied record set, else the stored title (#37 R2c 2d-1).
 */
async function replayOtherRuns(tx: IDBTransaction, current: StoredDraft | undefined, keepRun: string | undefined): Promise<LostState | undefined> {
  if (!current) return undefined;
  const records = (await request(tx.objectStore(CHANGES).getAll(changesOf(current.id))) as ChangeRecord[])
    .filter(record => record.run !== keepRun);
  const replay = replayText(current.id, current.text, current.upTo ?? 0, records);
  const title = replay.title ?? current.title;
  if (replay.applied === 0 || (replay.text === current.text && title === current.title)) return undefined;
  return { text: replay.text, title };
}

/** Keep recovered text (and title) as a new document "<title> (recovered)". */
async function addRecoveredCopy(tx: IDBTransaction, lost: LostState, recoveryId: string, now: number): Promise<StoredDraft> {
  const copy: StoredDraft = { id: recoveryId, title: lost.title + ' (recovered)', text: lost.text, updatedAt: now, revision: 1, upTo: 0 };
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
      if (!db.objectStoreNames.contains(DISCARD_MARKERS)) db.createObjectStore(DISCARD_MARKERS, { keyPath: 'documentId' });
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
      ? { ...draft, id: copyId, title: draft.title + ' (conflict copy)', revision: 1, upTo: 0 }
      : { ...draft, revision: expectedRevision + 1, upTo: draft.upTo ?? 0 };
    let recovered: StoredDraft | undefined;
    if (conflict) await request(store.add(next));
    else {
      await request(store.put(next));
      if (changes) {
        // Other runs' lost state is kept as a copy before their records go, unless this very
        // commit stores the same text and title (same transaction, so it is durable either way).
        const lost = await replayOtherRuns(tx, current, changes.keepRun);
        if (current && lost !== undefined && (lost.text !== next.text || lost.title !== next.title)) {
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

/** Read the reload-discard marker for `documentId`, if any. */
export async function getReloadDiscardMarker(
  db: IDBDatabase, documentId: string,
): Promise<ReloadDiscardMarker | undefined> {
  const tx = db.transaction(DISCARD_MARKERS, 'readonly');
  const done = finished(tx);
  const marker = await request(tx.objectStore(DISCARD_MARKERS).get(documentId)) as ReloadDiscardMarker | undefined;
  await done;
  return marker;
}

/**
 * At update-reload discard consent (#255): record the highest change-id under the live fence so
 * the next load can delete those records after navigation (no await before location.reload()).
 */
export async function writeReloadDiscardMarker(
  db: IDBDatabase, documentId: string, owner: WriteFence,
): Promise<ReloadDiscardMarker> {
  if (!owner?.instanceId || !Number.isSafeInteger(owner.fence)) throw new EditOwnershipLostError();
  const tx = db.transaction([CHANGES, OWNERSHIP, DISCARD_MARKERS], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, documentId, owner);
    const records = await request(tx.objectStore(CHANGES).getAll(changesOf(documentId))) as ChangeRecord[];
    let upToSeq = 0;
    for (const record of records) {
      if (record.seq > upToSeq) upToSeq = record.seq;
    }
    const marker: ReloadDiscardMarker = {
      documentId,
      upToSeq,
      instanceId: owner.instanceId,
      fence: owner.fence,
    };
    await request(tx.objectStore(DISCARD_MARKERS).put(marker));
    await done;
    return marker;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}

/**
 * Cancel path (#255): drop the marker under the fence. Idempotent — missing marker or lost
 * ownership is a no-op so cancel never throws into the host's cancelReload loop.
 */
export async function clearReloadDiscardMarker(
  db: IDBDatabase, documentId: string, owner: WriteFence,
): Promise<void> {
  if (!owner?.instanceId || !Number.isSafeInteger(owner.fence)) return;
  const tx = db.transaction([OWNERSHIP, DISCARD_MARKERS], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, documentId, owner);
    await request(tx.objectStore(DISCARD_MARKERS).delete(documentId));
    await done;
  } catch {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
  }
}

/**
 * Next load under a new fence (#255): if `reloadConsented`, delete change records with
 * `seq <= marker.upToSeq` and the marker; otherwise delete only a stale marker. Callers must not
 * pass `reloadConsented=false` while a cross-tab pending reload is still active — that would let
 * a foreign tab consume the marker and then salvage discarded records (#256 Codex P0). Never
 * deletes records without consent (sessionStorage intent must have survived the reload).
 */
export async function applyReloadDiscardMarker(
  db: IDBDatabase, documentId: string, owner: WriteFence, reloadConsented: boolean,
): Promise<{ applied: boolean; upToSeq: number }> {
  if (!owner?.instanceId || !Number.isSafeInteger(owner.fence)) throw new EditOwnershipLostError();
  const tx = db.transaction([CHANGES, OWNERSHIP, DISCARD_MARKERS], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, documentId, owner);
    const markers = tx.objectStore(DISCARD_MARKERS);
    const marker = await request(markers.get(documentId)) as ReloadDiscardMarker | undefined;
    if (!marker) {
      await done;
      return { applied: false, upToSeq: 0 };
    }
    if (reloadConsented) {
      await request(tx.objectStore(CHANGES).delete(changesOf(documentId, marker.upToSeq)));
      await request(markers.delete(documentId));
      await done;
      return { applied: true, upToSeq: marker.upToSeq };
    }
    await request(markers.delete(documentId));
    await done;
    return { applied: false, upToSeq: marker.upToSeq };
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
   * Text and title this window shows (e.g. a reload backup or a handoff). When the lost state is
   * exactly both, no copy is made and the records are kept: shown state is not stored yet.
   */
  shownText?: string,
  shownTitle?: string,
): Promise<StoredDraft | undefined> {
  const tx = db.transaction([STORE, OWNERSHIP, CHANGES], 'readwrite');
  const done = finished(tx);
  try {
    await assertEditOwner(tx, documentId, owner);
    const current = await request(tx.objectStore(STORE).get(documentId)) as StoredDraft | undefined;
    const lost = await replayOtherRuns(tx, current, keepRun);
    // Shown text/title are not durable (a reload backup, a handoff): when they are the lost
    // state, keep the records; the save that commits them removes them (#252 review, #37 2d-1).
    if (lost !== undefined && shownText !== undefined && lost.text === shownText && lost.title === shownTitle) {
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
