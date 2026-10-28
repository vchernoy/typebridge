import type { EditorHistory } from './editor';

export type StoredDraft = {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
  history?: EditorHistory;
  revision: number;
};
export type CommitResult =
  | { ok: true; draft: StoredDraft }
  | { ok: false; reason: 'conflict'; current: StoredDraft | undefined };

const DATABASE = 'typebridge';
const LEGACY_KEY = 'typebridge.drafts.v1';
const STORE = 'documents';
const RECOVERY = 'recovery';
const MIGRATION = 'metadata';
const MIGRATION_KEY = 'localStorage-v1';

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
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(RECOVERY)) db.createObjectStore(RECOVERY, { keyPath: ['tabId', 'documentId'] });
      if (!db.objectStoreNames.contains(MIGRATION)) db.createObjectStore(MIGRATION);
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

function isLegacyDraft(value: unknown): value is Omit<StoredDraft, 'revision'> {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.id === 'string' && !!d.id &&
    typeof d.title === 'string' && typeof d.text === 'string' &&
    typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt);
}

/** Validate the complete legacy payload before making any database changes. */
export function parseLegacyDrafts(raw: string): Array<Omit<StoredDraft, 'revision'>> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isLegacyDraft)) {
    throw new Error('Legacy drafts are malformed; original data was not changed');
  }
  const ids = new Set(parsed.map(draft => draft.id));
  if (ids.size !== parsed.length) throw new Error('Legacy drafts have duplicate IDs; original data was not changed');
  return parsed;
}

type LegacyRecord = Omit<StoredDraft, 'revision'>;
type LegacyMarker = { raw?: string | null; seen?: string[]; rejected?: number; olderChanges?: number };
export type LegacyBackup = { kind: 'legacy-backup'; raw: string; rejected: number[]; createdAt: number };

/** Import safe records and retain every unparseable payload for export, atomically. */
export async function migrateLegacyDrafts(db: IDBDatabase): Promise<number> {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (raw === null) {
    const tx = db.transaction(MIGRATION, 'readwrite');
    const done = finished(tx);
    const store = tx.objectStore(MIGRATION);
    if (!await request(store.get(MIGRATION_KEY))) await request(store.put({ raw: null, seen: [], rejected: 0, olderChanges: 0 }, MIGRATION_KEY));
    await done;
    return 0;
  }
  let values: unknown;
  try { values = JSON.parse(raw); } catch { values = null; }
  const entries = Array.isArray(values) ? values : [];
  const counts = new Map<string, number>();
  for (const entry of entries) if (isLegacyDraft(entry)) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  const rejected = Array.isArray(values)
    ? entries.flatMap((entry, i) => !isLegacyDraft(entry) || (counts.get(entry.id) ?? 0) > 1 ? [i] : [])
    : [-1];
  const valid = entries.filter((entry): entry is LegacyRecord => isLegacyDraft(entry) && counts.get(entry.id) === 1);
  const tx = db.transaction([STORE, MIGRATION], 'readwrite');
  const done = finished(tx);
  try {
    const metadata = tx.objectStore(MIGRATION);
    const marker = await request(metadata.get(MIGRATION_KEY)) as LegacyMarker | undefined;
    if (marker?.raw === raw) { await done; return 0; }
    const seen = new Set(marker?.seen ?? []);
    const documents = tx.objectStore(STORE);
    let imported = 0;
    let olderChanges = marker?.olderChanges ?? 0;
    for (const legacy of valid) {
      const signature = JSON.stringify(legacy);
      if (seen.has(signature)) continue;
      const existing = await request(documents.get(legacy.id)) as StoredDraft | undefined;
      const same = existing && existing.title === legacy.title && existing.text === legacy.text &&
        existing.updatedAt === legacy.updatedAt && JSON.stringify(existing.history) === JSON.stringify(legacy.history);
      if (!existing) {
        await request(documents.add({ ...legacy, revision: 1 }));
        imported++;
      } else if (!same) {
        await request(documents.add({ ...legacy, id: crypto.randomUUID(), title: legacy.title + ' (legacy recovery)', revision: 1 }));
        imported++;
      }
      if (marker && !same) olderChanges++;
      seen.add(signature);
    }
    if (rejected.length) {
      const backup: LegacyBackup = { kind: 'legacy-backup', raw, rejected, createdAt: Date.now() };
      await request(metadata.add(backup, 'legacy-backup:' + crypto.randomUUID()));
    }
    await request(metadata.put({ raw, seen: [...seen], rejected: (marker?.rejected ?? 0) + rejected.length, olderChanges }, MIGRATION_KEY));
    await done;
    return imported;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}

export async function legacyRecoveryInfo(db: IDBDatabase): Promise<{ rejected: number; olderChanges: number; backups: LegacyBackup[] }> {
  const tx = db.transaction(MIGRATION, 'readonly');
  const done = finished(tx);
  const store = tx.objectStore(MIGRATION);
  const marker = await request(store.get(MIGRATION_KEY)) as LegacyMarker | undefined;
  const records = await request(store.getAll()) as Array<LegacyMarker | LegacyBackup>;
  await done;
  return { rejected: marker?.rejected ?? 0, olderChanges: marker?.olderChanges ?? 0,
    backups: records.filter((record): record is LegacyBackup => 'kind' in record && record.kind === 'legacy-backup') };
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

/** Keep a conflicting tab's text in a separate durable record, never overwrite the document. */
export async function saveRecoveryCopy(
  db: IDBDatabase, tabId: string, documentId: string, text: string
): Promise<void> {
  const tx = db.transaction(RECOVERY, 'readwrite');
  const done = finished(tx);
  await request(tx.objectStore(RECOVERY).put({ tabId, documentId, text, updatedAt: Date.now() }));
  await done;
}

/** Commit the expected revision or atomically preserve the entire edit as a new draft. */
export async function commitOrCreateConflictCopy(
  db: IDBDatabase,
  draft: Omit<StoredDraft, 'revision'>,
  expectedRevision: number,
  copyId: string
): Promise<{ draft: StoredDraft; conflict: boolean }> {
  if (!copyId || copyId === draft.id) throw new Error('Conflict copy requires a distinct ID');
  const tx = db.transaction(STORE, 'readwrite');
  const done = finished(tx);
  try {
    const store = tx.objectStore(STORE);
    const current = await request(store.get(draft.id)) as StoredDraft | undefined;
    const conflict = (current?.revision ?? 0) !== expectedRevision;
    const next: StoredDraft = conflict
      ? { ...draft, id: copyId, title: draft.title + ' (conflict copy)', revision: 1 }
      : { ...draft, revision: expectedRevision + 1 };
    if (conflict) await request(store.add(next));
    else await request(store.put(next));
    await done;
    return { draft: next, conflict };
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}


/** Delete only the exact revision selected by the user. */
export async function deleteStoredDraft(db: IDBDatabase, id: string, revision: number): Promise<boolean> {
  const tx = db.transaction(STORE, 'readwrite');
  const done = finished(tx);
  try {
    const store = tx.objectStore(STORE);
    const current = await request(store.get(id)) as StoredDraft | undefined;
    if ((current?.revision ?? 0) !== revision) { await done; return false; }
    if (current) await request(store.delete(id));
    await done;
    return true;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished or aborted. */ }
    void done.catch(() => undefined);
    throw error;
  }
}
