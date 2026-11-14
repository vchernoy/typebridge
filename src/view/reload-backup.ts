/**
 * Reload backup: a window-scoped sessionStorage copy of unsaved text (with title and Undo
 * history). It is not the committed document; it only bridges a reload or navigation when the
 * browser aborts an IndexedDB write on unload. The parse/compare rules are pure functions.
 */
import { sameFields } from '../editor/document-fields';
import type { StoredDraft } from '../editor/indexeddb';

/** A stored backup, or undefined when it is missing or malformed. */
export function parsePendingDraft(raw: string | null): StoredDraft | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const draft = { ...value } as Partial<StoredDraft> & { reloadBackupToken?: unknown };
    // Private write identity is not document content and must never reach IndexedDB.
    delete draft.reloadBackupToken;
    if (typeof draft.id !== 'string' || !draft.id || typeof draft.title !== 'string' ||
        typeof draft.text !== 'string' || (draft.format !== undefined && draft.format !== 'plain' && draft.format !== 'markdown') || (draft.find !== undefined && typeof draft.find !== 'string') ||
        (draft.replace !== undefined && typeof draft.replace !== 'string') || typeof draft.updatedAt !== 'number' ||
        !Number.isSafeInteger(draft.revision) || (draft.revision ?? -1) < 0) return undefined;
    return draft as StoredDraft;
  } catch { return undefined; }
}

/** Same document, title, text and Undo history. */
export function sameContent(a: StoredDraft, b: StoredDraft): boolean {
  return a.id === b.id && sameFields(a, b) && ['history', 'titleHistory', 'findHistory', 'replaceHistory'].every(key =>
    JSON.stringify(a[key as keyof StoredDraft]) === JSON.stringify(b[key as keyof StoredDraft]));
}

/** Matching content/history proves coverage; wall-clock timestamps do not. */
export function savedCoversBackup(pending: StoredDraft, saved: StoredDraft): boolean {
  return sameContent(pending, saved);
}

export type ReloadBackupDeps = {
  /** sessionStorage key, scoped to this window. */
  key: string;
  /** The text, title and history to back up now. */
  snapshot: () => StoredDraft;
  /** False when there is nothing to protect (viewer, clean, Autosave off, deleting). */
  mayBackUp: () => boolean;
  /** The backup could not be written. */
  onFailed: () => void;
};

export function createReloadBackup(deps: ReloadBackupDeps) {
  /** Set when the user confirmed discarding this window, so unload must not recreate a backup. */
  let suppressed = false;
  const read = (): StoredDraft | undefined => {
    try { return parsePendingDraft(sessionStorage.getItem(deps.key)); }
    catch { return undefined; }
  };
  return {
    read,
    save(): void {
      if (suppressed || !deps.mayBackUp()) return;
      try { sessionStorage.setItem(deps.key, JSON.stringify({ ...deps.snapshot(), reloadBackupToken: crypto.randomUUID() })); }
      catch { deps.onFailed(); }
    },
    /** Remove the backup once `saved` covers it. */
    clear(saved: StoredDraft): void {
      try { const pending = read(); if (pending && savedCoversBackup(pending, saved)) sessionStorage.removeItem(deps.key); }
      catch { /* A stale backup is safer than removing one we cannot verify. */ }
    },
    /** Capture before any save awaits; call the returned cleanup only after commit. */
    prepareClear(saved: StoredDraft): () => void {
      let observed: string | null = null;
      try { observed = sessionStorage.getItem(deps.key); } catch { /* Retain on uncertainty. */ }
      const prior = parsePendingDraft(observed);
      return () => {
        try {
          const raw = sessionStorage.getItem(deps.key);
          const pending = parsePendingDraft(raw);
          if (!pending) return;
          // An unchanged backup observed before the snapshot's save is superseded.
          // A backup written during the save must match the committed content/history.
          if (savedCoversBackup(pending, saved) || (prior?.id === saved.id && raw === observed)) {
            sessionStorage.removeItem(deps.key);
          }
        } catch { /* A retained duplicate is safer than deleting an uncertain backup. */ }
      };
    },
    remove(): void {
      try { sessionStorage.removeItem(deps.key); } catch { /* Optional backup. */ }
    },
    suppressed: (): boolean => suppressed,
    setSuppressed(next: boolean): void { suppressed = next; },
  };
}
