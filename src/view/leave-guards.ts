/**
 * Leaving an editing window safely: reload after an app update, closing a host window, and
 * the browser's own unload. Unsaved text is saved or backed up first; with Autosave off the
 * user confirms discarding it, and that choice is bound to the exact text it was made for.
 */
import type { StoredDraft } from '../editor/indexeddb';
import { clearRecovery, type RecoverySnapshot } from '../editor/recovery';
import { askConfirmChoice } from '../ui/confirm-dialog';
import { testKnob } from './embed-api';
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
  /** Freeze body + title editors (and mutation controls) for the discard-cleanup window. */
  freezeForDiscard: () => void;
  /** Undo freezeForDiscard when the leave aborts after cleanup. */
  unfreezeAfterDiscard: () => void;
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
  /** True after a successful close prepare that left editors frozen pending host commit/cancel. */
  let closeFreezeArmed = false;
  /**
   * Close prepare confirmed discard but deferred the destructive clear until commit, so a host
   * cancel can thaw without wiping journal/change-log recovery (#254 Codex P1).
   */
  let pendingCloseDiscard = false;
  /**
   * Update-reload prepare confirmed discard but deferred clear until commitUpdateReload, so
   * cancelUpdateReload keeps recovery if another window refuses or navigation stalls (#254).
   */
  let pendingReloadDiscard = false;
  /**
   * Host/standalone froze editors after the final assert and before awaited commit; thaw on
   * cancel so a stalled or aborted reload restores editing (#254 owner-account P1).
   */
  let reloadFreezeArmed = false;

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
   * Destructive discard cleanup runs here when prepare deferred it (#254 Codex P1).
   */
  async function commitWindowClose(): Promise<void> {
    closeFreezeArmed = false;
    const shouldDiscard = pendingCloseDiscard;
    pendingCloseDiscard = false;
    deps.reloadBackup.setSuppressed(true);
    clearPendingBackups();
    // Confirmed discard must forget this window's emergency journals so another
    // window's recovery poll does not re-offer text the user chose to discard.
    const discardedJournal = deps.recovery.takeCurrentJournal();
    if (discardedJournal) {
      try { clearRecovery(localStorage, discardedJournal); } catch { /* Optional backup. */ }
    }
    if (shouldDiscard) await deps.discardUnsavedRecovery();
  }

  /**
   * Host prepared a close that left editors frozen, then aborted (e.g. another close finished
   * first and this would have been the last window). Thaw without wiping recovery so the
   * surviving dirty editor stays protected (#254 Codex P1).
   */
  function cancelWindowClose(): void {
    if (!closeFreezeArmed && !pendingCloseDiscard) return;
    closeFreezeArmed = false;
    pendingCloseDiscard = false;
    deps.unfreezeAfterDiscard();
  }

  /**
   * Freeze body + title (and mutation controls) after every window has asserted and before any
   * awaited commit/navigation, so private edits cannot sneak in during discard cleanup (#254).
   */
  function freezeForUpdateReload(): void {
    if (reloadFreezeArmed) return;
    deps.freezeForDiscard();
    reloadFreezeArmed = true;
  }

  /** Run deferred update-reload discard after every window has prepared and assert passed. */
  async function commitUpdateReload(): Promise<void> {
    if (!pendingReloadDiscard) return;
    pendingReloadDiscard = false;
    // Optional e2e hold (reuses the change-append delay knob) so freeze can be probed (#254).
    const delayMs = testKnob('__typebridgeDelayChangeAppendMs');
    if (typeof delayMs === 'number' && delayMs > 0) {
      await new Promise<void>(resolve => { window.setTimeout(resolve, delayMs); });
    }
    await deps.discardUnsavedRecovery();
  }

  /**
   * Confirm discard. Consent is bound to the content revision shown in the dialog.
   * Destructive journal/change-log clear is deferred until host commit (close) or
   * commitUpdateReload (update), so cancel keeps recovery (#254 Codex P1).
   */
  async function confirmDiscardAndClear(
    prompt: { title: string; message: string; confirmLabel: string },
    mode: 'close' | 'reload',
  ): Promise<boolean> {
    const contentAtPrompt = deps.workspace.contentRevision();
    const discard = await askConfirmChoice({
      ...prompt,
      cancelLabel: 'Keep editing',
      returnFocus: updateReloadReturnFocus(),
    });
    if (!discard) return false;
    // Edits while the dialog was open: do not clear recovery for a newer, unconsented version.
    if (deps.workspace.contentRevision() !== contentAtPrompt) return false;
    if (mode === 'close') {
      deps.freezeForDiscard();
      pendingCloseDiscard = true;
      closeFreezeArmed = true;
      return true;
    }
    // Reload: stay editable so a later private edit bumps contentRevision and fails the assert.
    pendingReloadDiscard = true;
    return true;
  }

  async function prepareLeaveWithUnsaved(kind: 'reload' | 'close'): Promise<boolean> {
    if (state.transitioning || state.deleting || deps.field.disabled) return false;
    privateReloadChoice = undefined;
    if (deps.workspace.dirty() && !deps.autosave.checked) {
      const contentAtPrompt = deps.workspace.contentRevision();
      const discarded = await confirmDiscardAndClear({
        title: kind === 'close' ? 'Close without saving?' : 'Reload without saving?',
        message: 'Autosave is off. Text and title changes will be lost. Copy or export them first if you want to keep them.',
        confirmLabel: kind === 'close' ? 'Discard changes and close' : 'Discard changes and reload',
      }, kind);
      if (discarded) {
        privateReloadChoice = { id: state.active.id, generation: contentAtPrompt };
      }
      return discarded;
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
    return confirmDiscardAndClear({
      title: 'Close and discard unsaved changes?',
      message: 'The latest save could not finish. Closing this window discards the unsaved text. Copy or export it first if you want to keep it.',
      confirmLabel: 'Discard changes and close',
    }, 'close');
  }
  async function prepareUpdateReload(): Promise<boolean> {
    // Drop a prior deferred discard that never committed (e.g. another window refused)
    // so a later Autosave-on retry cannot wipe recovery with stale consent (#254 Codex P1).
    pendingReloadDiscard = false;
    const ok = await prepareLeaveWithUnsaved('reload');
    if (!ok) pendingReloadDiscard = false;
    return ok;
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
    cancelWindowClose,
    freezeForUpdateReload,
    commitUpdateReload,
    /** The update reload was cancelled: re-enable the unload warning and backups; keep recovery. */
    cancelUpdateReload(): void {
      allowUpdateReload = false;
      pendingReloadDiscard = false;
      deps.reloadBackup.setSuppressed(false);
      if (reloadFreezeArmed) {
        reloadFreezeArmed = false;
        deps.unfreezeAfterDiscard();
      }
    },
  };
}
