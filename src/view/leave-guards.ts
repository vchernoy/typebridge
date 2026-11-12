/**
 * Leaving an editing window safely: reload after an app update, closing a host window, and
 * the browser's own unload. Unsaved text is saved or backed up first; with Autosave off the
 * user confirms discarding it, and that choice is bound to the exact text it was made for.
 */
import type { StoredDraft } from '../editor/indexeddb';
import { clearRecovery, type RecoverySnapshot } from '../editor/recovery';
import { askConfirmChoice } from '../ui/confirm-dialog';
import type { EditorState } from './editor-state';
import { sameContent } from './reload-backup';
import type { SaveResult } from './saver';
import type { Workspace } from './workspace';

export type LeaveGuardDeps = {
  viewMode: boolean;
  field: HTMLTextAreaElement;
  autosave: HTMLInputElement;
  workspace: Workspace;
  saver: { cancel: () => void };
  persist: () => Promise<SaveResult>;
  snapshot: () => StoredDraft;
  reloadBackup: {
    save: () => void;
    read: () => StoredDraft | undefined;
    remove: () => void;
    suppressed: () => boolean;
    setSuppressed: (next: boolean) => void;
  };
  recovery: { takeCurrentJournal: () => RecoverySnapshot | undefined };
  /**
   * After the user confirms discarding unsaved edits: clear the journal entry and the change-log
   * records for this document so a later owner does not recover what was discarded (#37 R2c 2d-2).
   */
  discardUnsavedRecovery: () => Promise<void>;
};

export function createLeaveGuards(state: EditorState, deps: LeaveGuardDeps) {
  if (!deps.viewMode) window.addEventListener('pagehide', () => {
    if (deps.reloadBackup.suppressed()) return;
    deps.reloadBackup.save();
    deps.saver.cancel();
    void deps.persist();
  });
  let allowUpdateReload = false;
  let privateReloadChoice: { id: string; generation: number } | undefined;
  function updateReloadReturnFocus(): HTMLElement {
    const local = document.querySelector<HTMLButtonElement>('#update-reload');
    if (local) return local;
    try {
      const host = window.parent !== window
        ? window.parent.document.querySelector<HTMLButtonElement>('#update-reload')
        : null;
      if (host) return host;
    } catch { /* Cross-origin parent. */ }
    return deps.field;
  }
  function clearPendingBackups(): void {
    deps.reloadBackup.remove();
  }

  /**
   * Host calls this immediately before removing the iframe. Arming suppress here — not during
   * prepare — keeps reload/close consent cancellable without disabling backups for the session.
   */
  function commitWindowClose(): void {
    deps.reloadBackup.setSuppressed(true);
    clearPendingBackups();
    // Confirmed discard must forget this window's emergency journals so another
    // window's recovery poll does not re-offer text the user chose to discard.
    const discardedJournal = deps.recovery.takeCurrentJournal();
    if (discardedJournal) {
      try { clearRecovery(localStorage, discardedJournal); } catch { /* Optional backup. */ }
    }
  }

  async function prepareLeaveWithUnsaved(kind: 'reload' | 'close'): Promise<boolean> {
    if (state.transitioning || state.deleting || deps.field.disabled) return false;
    privateReloadChoice = undefined;
    if (deps.workspace.dirty() && !deps.autosave.checked) {
      const discard = await askConfirmChoice({
        title: kind === 'close' ? 'Close without saving?' : 'Reload without saving?',
        message: 'Autosave is off. Text and title changes will be lost. Copy or export them first if you want to keep them.',
        confirmLabel: kind === 'close' ? 'Discard changes and close' : 'Discard changes and reload',
        cancelLabel: 'Keep editing',
        returnFocus: updateReloadReturnFocus(),
      });
      if (discard) {
        privateReloadChoice = { id: state.active.id, generation: deps.workspace.contentRevision() };
        await deps.discardUnsavedRecovery();
      }
      return discard;
    }
    deps.reloadBackup.save();
    if (deps.workspace.dirty()) await deps.persist();
    if (!deps.workspace.dirty()) return true;
    deps.reloadBackup.save();
    const pending = deps.reloadBackup.read();
    const primaryOk = !deps.workspace.dirty() || (!!pending && sameContent(pending, deps.snapshot()));
    if (kind === 'reload') return primaryOk;
    // Close: a session backup is not enough — closing removes the iframe and must not
    // silently destroy the only copy after a failed save. Ask for explicit discard.
    const discard = await askConfirmChoice({
      title: 'Close and discard unsaved changes?',
      message: 'The latest save could not finish. Closing this window discards the unsaved text. Copy or export it first if you want to keep it.',
      confirmLabel: 'Discard changes and close',
      cancelLabel: 'Keep editing',
      returnFocus: updateReloadReturnFocus(),
    });
    if (discard) await deps.discardUnsavedRecovery();
    return discard;
  }
  async function prepareUpdateReload(): Promise<boolean> {
    return prepareLeaveWithUnsaved('reload');
  }
  async function prepareWindowClose(): Promise<boolean> {
    return prepareLeaveWithUnsaved('close');
  }
  /** Validate and arm reload; throws to abort. Does not navigate (host reloads the top page). */
  function assertSafeToReloadAfterUpdate(): void {
    if (state.transitioning || state.deleting || deps.field.disabled || document.querySelector('.confirm-backdrop')) throw new Error('Finish the current action first');
    if (deps.workspace.dirty()) {
      if (!deps.autosave.checked) {
        if (privateReloadChoice?.id !== state.active.id || privateReloadChoice.generation !== deps.workspace.contentRevision()) {
          throw new Error('Private edits changed');
        }
      } else {
        deps.reloadBackup.save();
        const pending = deps.reloadBackup.read();
        if (!pending || !sameContent(pending, deps.snapshot())) throw new Error('Reload backup unavailable');
      }
    }
    allowUpdateReload = true;
  }
  function reloadAfterUpdate(): void {
    assertSafeToReloadAfterUpdate();
    try { window.location.reload(); } catch (error) { allowUpdateReload = false; throw error; }
  }
  if (!deps.viewMode) window.addEventListener('beforeunload', event => {
    if (deps.reloadBackup.suppressed()) return;
    if (deps.workspace.dirty()) {
      deps.reloadBackup.save();
      deps.saver.cancel();
      void deps.persist();
      if (!allowUpdateReload) { event.preventDefault(); event.returnValue = ''; }
    }
  });
  if (!deps.viewMode) document.addEventListener('visibilitychange', () => {
    if (deps.reloadBackup.suppressed()) return;
    if (document.visibilityState === 'hidden') {
      deps.saver.cancel();
      void deps.persist();
    }
  });
  return {
    prepareUpdateReload,
    prepareWindowClose,
    assertSafeToReloadAfterUpdate,
    reloadAfterUpdate,
    commitWindowClose,
    /** The update reload was cancelled: re-enable the unload warning and backups. */
    cancelUpdateReload(): void {
      allowUpdateReload = false;
      deps.reloadBackup.setSuppressed(false);
    },
  };
}
