import type { Page } from '@playwright/test';

export type StoredRow = { id: string; title: string; text: string; revision: number; updatedAt: number };
export type OwnershipRow = { documentId: string; ownerInstanceId: string; fence: number; updatedAt: number };

/** Every stored document, sorted by id; text fields only (no history). */
export async function readStoredDocs(page: Page): Promise<StoredRow[]> {
  return page.evaluate(() => new Promise<StoredRow[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('documents', 'readonly').objectStore('documents').getAll();
      request.onsuccess = () => {
        const rows = (request.result as StoredRow[]).map(({ id, title, text, revision, updatedAt }) => ({ id, title, text, revision, updatedAt }));
        db.close();
        resolve(rows.sort((a, b) => a.id.localeCompare(b.id)));
      };
      request.onerror = () => reject(request.error);
    };
  }));
}

export async function readOwnership(page: Page, documentId: string): Promise<OwnershipRow | undefined> {
  return page.evaluate(documentId => new Promise<OwnershipRow | undefined>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('editOwnership', 'readonly').objectStore('editOwnership').get(documentId);
      request.onsuccess = () => { db.close(); resolve(request.result as OwnershipRow | undefined); };
      request.onerror = () => reject(request.error);
    };
  }), documentId);
}

/**
 * Commit a newer revision straight into IndexedDB, ignoring edit ownership and sending no signal.
 * This is what an older TypeBridge build without ownership does, so revision CAS must still
 * turn the owner's next save into a conflict copy. Without `id`, the most recent row is used.
 */
export async function writeForeignRevision(page: Page, patch: { text?: string; title?: string }, id?: string): Promise<number> {
  return page.evaluate(({ id, patch }) => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');
      const all = store.getAll();
      let revision = 0;
      all.onsuccess = () => {
        const rows = all.result as (StoredRow & Record<string, unknown>)[];
        const row = id ? rows.find(r => r.id === id) : rows.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (!row) { tx.abort(); return; }
        revision = row.revision + 1;
        store.put({ ...row, ...patch, history: undefined, revision, updatedAt: Date.now() });
      };
      tx.oncomplete = () => { db.close(); resolve(revision); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error('No document to change')); };
    };
  }), { id, patch });
}

/** Overwrite the fence as if another window had claimed the document (a stale owner then wakes). */
export async function claimFenceElsewhere(page: Page, documentId: string, ownerInstanceId = 'another-window'): Promise<void> {
  await page.evaluate(({ documentId, ownerInstanceId }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('editOwnership', 'readwrite');
      const store = tx.objectStore('editOwnership');
      const get = store.get(documentId);
      get.onsuccess = () => {
        const fence = ((get.result as { fence?: number } | undefined)?.fence ?? 0) + 1;
        store.put({ documentId, ownerInstanceId, fence, updatedAt: Date.now() });
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), { documentId, ownerInstanceId });
}

/** Names of edit-owner Web Locks currently held anywhere in this origin. */
export async function heldEditLocks(page: Page): Promise<string[]> {
  return page.evaluate(async () => ((await navigator.locks.query()).held ?? [])
    .map(lock => lock.name ?? '')
    .filter(name => name.startsWith('typebridge-edit-owner:'))
    .sort());
}
