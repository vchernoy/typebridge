/**
 * Reload backup: a window-scoped sessionStorage copy of unsaved text (with title and Undo
 * history). It is not the committed document; it only bridges a reload or navigation when the
 * browser aborts an IndexedDB write on unload. The parse/compare rules are pure functions.
 */
import type { StoredDraft } from '../editor/indexeddb';

/** A stored backup, or undefined when it is missing or malformed. */
export function parsePendingDraft(raw: string | null): StoredDraft | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const draft = value as Partial<StoredDraft>;
    if (typeof draft.id !== 'string' || !draft.id || typeof draft.title !== 'string' ||
        typeof draft.text !== 'string' || typeof draft.updatedAt !== 'number' ||
        !Number.isSafeInteger(draft.revision) || (draft.revision ?? -1) < 0) return undefined;
    return draft as StoredDraft;
  } catch { return undefined; }
}

/** Same document, title, text and Undo history. */
export function sameContent(a: StoredDraft, b: StoredDraft): boolean {
  return a.id === b.id && a.title === b.title && a.text === b.text && JSON.stringify(a.history) === JSON.stringify(b.history);
}

/** A save of `saved` makes `pending` redundant when it holds the same content or is not newer. */
export function savedCoversBackup(pending: StoredDraft, saved: StoredDraft): boolean {
  return pending.id === saved.id && (sameContent(pending, saved) || saved.updatedAt >= pending.updatedAt);
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
      try { sessionStorage.setItem(deps.key, JSON.stringify(deps.snapshot())); }
      catch { deps.onFailed(); }
    },
    /** Remove the backup once `saved` covers it. */
    clear(saved: StoredDraft): void {
      try { const pending = read(); if (pending && savedCoversBackup(pending, saved)) sessionStorage.removeItem(deps.key); }
      catch { /* A stale backup is safer than removing one we cannot verify. */ }
    },
    remove(): void {
      try { sessionStorage.removeItem(deps.key); } catch { /* Optional backup. */ }
    },
    suppressed: (): boolean => suppressed,
    setSuppressed(next: boolean): void { suppressed = next; },
  };
}
