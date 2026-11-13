/**
 * Leaving an editing window safely: reload after an app update, closing a host window, and
 * the browser's own unload. Unsaved text is saved or backed up first; with Autosave off the
 * user confirms discarding it, and that choice is bound to the exact text it was made for.
 *
 * Window-close discard clears the journal and change log on commit (deferred so cancel can thaw
 * without wiping recovery). Update-reload writes a durable discard marker at consent (#255);
 * assert → location.reload() stays synchronous; records are cleared on the next load.
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
  saver: {
    cancel: () => void;
    /** In-flight persist, if any — cancel() only clears the debounce timer. */
    inFlight: () => Promise<SaveResult> | undefined;
  };
  persist: () => Promise<SaveResult>;
  snapshot: () => StoredDraft;
  reloadBackup: {
    save: () => void;
    read: () => StoredDraft | undefined;
    remove: () => void;
    take: () => StoredDraft | undefined;
    put: (draft: StoredDraft) => void;
    suppressed: () => boolean;
    setSuppressed: (next: boolean) => void;
  };
  recovery: { takeCurrentJournal: () => RecoverySnapshot | undefined };
  /**
   * After the user confirms discarding unsaved edits: clear the journal entry and the change-log
   * records for this document so a later owner does not recover what was discarded (#37 R2c 2d-2).
   */
  discardUnsavedRecovery: () => Promise<void>;
  /**
   * Update-reload discard consent (#255): write the IndexedDB marker + sessionStorage intent.
   * Throws (or rejects) when the marker cannot be written — prepare must then return false.
   */
  markReloadDiscard: () => Promise<void>;
  /** Cancel update-reload: drop session intent and best-effort remove the IDB marker. */
  clearReloadDiscard: () => void;
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
  /**
   * Discard consent for update-reload: document id + content revision + exact text/title.
   * Freeze sets transferFrozen so scheduleSave will not bump contentRevision; assert must
   * still reject a mutated field value before navigation (#256 CI host-window).
   */
  let privateReloadChoice: { id: string; generation: number; text: string; title: string } | undefined;
  /** True after a successful close prepare that left editors frozen pending host commit/cancel. */
  let closeFreezeArmed = false;
  /**
   * Close prepare confirmed discard but deferred the destructive clear until commit, so a host
   * cancel can thaw without wiping journal/change-log recovery (#254 Codex P1).
   */
  let pendingCloseDiscard = false;
  /**
   * Reload-discard prepare removed this window's pendingDraft so boot cannot restore discarded
   * text (#256 Codex P0). Restored on cancelUpdateReload if the reload does not proceed.
   */
  let stashedReloadBackup: StoredDraft | undefined;
  /**
   * True only when this prepare armed transferFrozen for reload-discard. Cancel must not thaw an
   * unrelated switch/delete/takeover freeze (#256 Codex P1).
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
   * Confirm close discard. Consent is bound to the content revision shown in the dialog.
   * Destructive journal/change-log clear is deferred until host commit so cancel keeps recovery.
   */
  async function confirmCloseDiscard(prompt: {
    title: string; message: string; confirmLabel: string;
  }): Promise<boolean> {
    const contentAtPrompt = deps.workspace.contentRevision();
    const discard = await askConfirmChoice({
      ...prompt,
      cancelLabel: 'Keep editing',
      returnFocus: updateReloadReturnFocus(),
    });
    if (!discard) return false;
    // Edits while the dialog was open: do not clear recovery for a newer, unconsented version.
    if (deps.workspace.contentRevision() !== contentAtPrompt) return false;
    deps.freezeForDiscard();
    pendingCloseDiscard = true;
    closeFreezeArmed = true;
    return true;
  }

  async function prepareLeaveWithUnsaved(kind: 'reload' | 'close'): Promise<boolean> {
    // transferFrozen (not only field.disabled): takeover freeze uses readOnly, not disabled.
    if (state.transitioning || state.deleting || deps.field.disabled || state.transferFrozen) return false;
    privateReloadChoice = undefined;
    if (deps.workspace.dirty() && !deps.autosave.checked) {
      if (kind === 'close') {
        const contentAtPrompt = deps.workspace.contentRevision();
        const discarded = await confirmCloseDiscard({
          title: 'Close without saving?',
          message: 'Autosave is off. Text and title changes will be lost. Copy or export them first if you want to keep them.',
          confirmLabel: 'Discard changes and close',
        });
        if (discarded) {
          const snap = deps.snapshot();
          privateReloadChoice = {
            id: state.active.id,
            generation: contentAtPrompt,
            text: snap.text,
            title: snap.title,
          };
        }
        return discarded;
      }
      // Update-reload: consent + durable marker; assert → reload stays sync (#255).
      const contentAtPrompt = deps.workspace.contentRevision();
      const discard = await askConfirmChoice({
        title: 'Reload without saving?',
        message: 'Autosave is off. Text and title changes will be lost. Copy or export them first if you want to keep them.',
        confirmLabel: 'Discard changes and reload',
        cancelLabel: 'Keep editing',
        returnFocus: updateReloadReturnFocus(),
      });
      if (!discard) return false;
      if (deps.workspace.contentRevision() !== contentAtPrompt) return false;
      // Dialog await: Autosave may have flipped on and started persist — refuse privacy discard
      // so an in-flight commit cannot land the discarded text (#256 Codex P1 / residual P2).
      deps.saver.cancel();
      if (deps.autosave.checked || state.transferFrozen) return false;
      // Freeze before the inFlight check so a prefs-sync cannot start a new persist under us;
      // cancel() does not abort a save already past its guards.
      deps.freezeForDiscard();
      reloadFreezeArmed = true;
      if (deps.saver.inFlight() || deps.autosave.checked) {
        reloadFreezeArmed = false;
        deps.unfreezeAfterDiscard();
        return false;
      }
      // Suppress before the next await so unload cannot recreate pendingDraft mid-marker write.
      // Only this arm is thawed on cancel.
      stashedReloadBackup = deps.reloadBackup.take();
      deps.reloadBackup.setSuppressed(true);
      try {
        await deps.markReloadDiscard();
      } catch {
        // Marker write failed: refuse prepare so the host cancels every window.
        deps.clearReloadDiscard();
        deps.reloadBackup.setSuppressed(false);
        if (stashedReloadBackup) {
          deps.reloadBackup.put(stashedReloadBackup);
          stashedReloadBackup = undefined;
        }
        reloadFreezeArmed = false;
        deps.unfreezeAfterDiscard();
        return false;
      }
      {
        const snap = deps.snapshot();
        privateReloadChoice = {
          id: state.active.id,
          generation: contentAtPrompt,
          text: snap.text,
          title: snap.title,
        };
      }
      return true;
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
    return confirmCloseDiscard({
      title: 'Close and discard unsaved changes?',
      message: 'The latest save could not finish. Closing this window discards the unsaved text. Copy or export it first if you want to keep it.',
      confirmLabel: 'Discard changes and close',
    });
  }
  async function prepareUpdateReload(): Promise<boolean> {
    return prepareLeaveWithUnsaved('reload');
  }
  async function prepareWindowClose(): Promise<boolean> {
    return prepareLeaveWithUnsaved('close');
  }
  /** Validate and arm reload; throws to abort. Does not navigate (host reloads the top page). */
  function assertSafeToReloadAfterUpdate(): void {
    // Discard-reload freeze disables the field on purpose; do not treat that as "busy".
    if (state.transitioning || state.deleting || document.querySelector('.confirm-backdrop')) throw new Error('Finish the current action first');
    if (deps.field.disabled && !state.transferFrozen) throw new Error('Finish the current action first');
    if (deps.workspace.dirty()) {
      // Consented discard stays on the private-revision path even if Autosave flips on mid-prepare
      // (#256 review P0): never recreate pendingDraft or ignore the content binding.
      if (!deps.autosave.checked || privateReloadChoice) {
        const now = deps.snapshot();
        // Generation alone is not enough after discard freeze: readOnly/transferFrozen
        // skips scheduleSave, so value can change without a revision bump.
        if (
          !privateReloadChoice
          || privateReloadChoice.id !== state.active.id
          || privateReloadChoice.generation !== deps.workspace.contentRevision()
          || privateReloadChoice.text !== now.text
          || privateReloadChoice.title !== now.title
        ) {
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
    /** The update reload was cancelled: drop discard intent/marker and re-enable unload backups. */
    cancelUpdateReload(): void {
      allowUpdateReload = false;
      deps.reloadBackup.setSuppressed(false);
      // Session intent first so a leftover IDB marker cannot delete records on a later load (#255).
      deps.clearReloadDiscard();
      if (stashedReloadBackup) {
        deps.reloadBackup.put(stashedReloadBackup);
        stashedReloadBackup = undefined;
      }
      // Only thaw a freeze this prepare armed — never a switch/delete/takeover freeze (#256 P1).
      if (reloadFreezeArmed) {
        reloadFreezeArmed = false;
        deps.unfreezeAfterDiscard();
      }
    },
  };
}
