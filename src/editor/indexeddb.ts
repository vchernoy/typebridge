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

export function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(RECOVERY)) db.createObjectStore(RECOVERY, { keyPath: ['tabId', 'documentId'] });
      if (!db.objectStoreNames.contains(MIGRATION)) db.createObjectStore(MIGRATION);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('Cannot open IndexedDB'));
    open.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
  });
}

function isLegacyDraft(value: unknown): value is Omit<StoredDraft, 'revision'> {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.id === 'string' && !!d.id &&
    typeof d.title === 'string' && typeof d.text === 'string' &&
    typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt);
}

/**
 * Imports once, without ever removing the legacy key.
 * The migration marker and imported records commit in one transaction.
 * If a legacy record is invalid, fail closed rather than silently discard it.
 */
export async function migrateLegacyDrafts(db: IDBDatabase): Promise<number> {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (raw === null) return 0;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isLegacyDraft)) {
    throw new Error('Legacy drafts are malformed; original data was not changed');
  }
  const tx = db.transaction([STORE, MIGRATION], 'readwrite');
  const done = finished(tx);
  try {
    const marker = await request(tx.objectStore(MIGRATION).get(MIGRATION_KEY));
    if (marker) { await done; return 0; }
    const documents = tx.objectStore(STORE);
    let imported = 0;
    for (const legacy of parsed) {
      const existing = await request(documents.get(legacy.id)) as StoredDraft | undefined;
      if (!existing) {
        await request(documents.add({ ...legacy, revision: 1 }));
        imported++;
      }
    }
    await request(tx.objectStore(MIGRATION).put({ completedAt: Date.now() }, MIGRATION_KEY));
    await done;
    return imported;
  } catch (error) {
    if (tx.readyState === 'active') tx.abort();
    void done.catch(() => undefined);
    throw error;
  }
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
    if (tx.readyState === 'active') tx.abort();
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
