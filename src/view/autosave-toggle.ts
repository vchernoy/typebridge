/**
 * The Autosave preference in this window: turning it on flushes unsaved text; turning it off
 * stops saving and, from local Settings, offers to delete the saved copy (#114). Changes shared
 * from the host or another window apply without that prompt (#175 step 7). While a change is in
 * flight, document switches wait on `gate()` and a shared change is queued.
 */
import { autosaveEnabled, setAutosaveEnabled } from '../editor/drafts';
import { deleteStoredDraft, EditOwnershipLostError } from '../editor/indexeddb';
import { AUTOSAVE_OFF } from '../editor/status';
import { askConfirmChoice } from '../ui/confirm-dialog';
import type { StatusLine } from '../ui/status-line';
import type { EditorState } from './editor-state';
import { notifyPrefsChanged } from './prefs-sync';
import type { SaveResult } from './saver';
import type { DocumentSignal } from './signals';
import type { Workspace } from './workspace';

export type AutosaveToggleDeps = {
  autosave: HTMLInputElement;
  workspace: Workspace;
  viewMode: boolean;
  embedded: boolean;
  /** Origin tag for the shared-preference notification. */
  prefsOrigin: string;
  /** Frozen for an ownership transfer. */
  transferFrozen: () => boolean;
  /** Viewers and non-owners cannot change Autosave here. */
  controlBlocked: () => boolean;
  preferenceSaved: (name: string, saved: boolean) => void;
  journalEdit: () => void;
  persist: () => Promise<SaveResult>;
  saver: { cancel: () => void; inFlight: () => Promise<SaveResult> | undefined };
  postSignal: (type: DocumentSignal['type'], documentId: string, revision: number) => void;
  refreshDrafts: () => Promise<void>;
  loseOwnership: () => void;
};

export function createAutosaveToggle(state: EditorState, status: StatusLine, deps: AutosaveToggleDeps) {
  /** True for the whole change handler (including awaits); keeps the checkbox disabled. */
  let active = false;
  /** While Autosave is toggling (including delete-saved-copy), document switches wait. */
  let autosaveToggleGate: Promise<void> | undefined;
  let releaseAutosaveToggleGate: (() => void) | undefined;
  function beginAutosaveToggleGate(): void {
    if (autosaveToggleGate) return;
    autosaveToggleGate = new Promise(resolve => {
      releaseAutosaveToggleGate = () => {
        autosaveToggleGate = undefined;
        releaseAutosaveToggleGate = undefined;
        resolve();
      };
    });
  }
  function endAutosaveToggleGate(): void {
    releaseAutosaveToggleGate?.();
  }
  /** Latest host/shared Autosave value dropped while a local toggle was in flight. */
  let pendingRemoteAutosave: boolean | undefined;

  /**
   * Apply an Autosave preference change to this window.
   * Local Settings uses prompts; host/shared sync applies without the delete-copy dialog (#175 step 7).
   * Remote sync always updates `autosave.checked` (and clears save timers when turning off), even in
   * read-only windows, so a later ownership handoff cannot save text the user opted out of storing.
   */
  async function applyAutosaveChange(
    enabled: boolean,
    opts: { promptDeleteSavedCopy: boolean; persistPreference: boolean },
  ): Promise<void> {
    const remote = !opts.persistPreference;
    if (active) {
      if (remote) {
        pendingRemoteAutosave = enabled;
        // Still mirror the checkbox immediately so a mid-toggle handoff sees the shared choice.
        deps.autosave.checked = enabled;
        if (!enabled) deps.saver.cancel();
      }
      return;
    }
    if (!remote && deps.controlBlocked()) return;
    const alreadyMatching = deps.autosave.checked === enabled;
    // Remote no-op when nothing changed and there is no dirty text left to flush.
    if (remote && alreadyMatching && !(enabled && deps.workspace.dirty() && !deps.controlBlocked())) {
      deps.autosave.checked = enabled;
      return;
    }
    const blocked = deps.controlBlocked();
    active = true;
    if (!blocked) deps.autosave.disabled = true;
    beginAutosaveToggleGate();
    try {
      deps.autosave.checked = enabled;
      if (opts.persistPreference) {
        try {
          setAutosaveEnabled(enabled);
          deps.preferenceSaved('autosave', true);
          notifyPrefsChanged({
            name: 'autosave',
            origin: deps.prefsOrigin,
          });
        } catch { deps.preferenceSaved('autosave', false); }
      }
      // Always show the accurate save state. Without storage, no save can succeed: keep saying so.
      const announce = (text: string): void => {
        // storageProblem, not !db: db is also unset while initialization runs.
        if (state.storageProblem) status.setSaveStatus(status.riskText(), 'failure');
        else status.setSaveStatus(text);
      };
      if (enabled) {
        const primaryCanSave = !deps.viewMode && !deps.transferFrozen() && state.editBlock === '';
        if (!primaryCanSave) return;
        status.clearNotices();
        if (deps.workspace.dirty()) {
          status.showSaving();
          deps.journalEdit();
          void deps.persist();
        } else {
          announce('Autosave on');
        }
        return;
      }
      deps.saver.cancel();
      if (blocked || !opts.promptDeleteSavedCopy) {
        if (!blocked) status.clearNotices();
        if (!blocked) announce(AUTOSAVE_OFF);
        else status.showSaveState();
        return;
      }
      // Bind deletion to this document before any await — defense if a switch somehow races the gate.
      const startedId = state.active.id;
      const startedOwnership = state.ownership;
      // Await an in-flight save without clearing first — it may create a conflict copy
      // that the delete prompt then targets, and the user must see that notice.
      // Older conflict notices still clear when the toggle did not itself create one.
      const pendingSave = deps.saver.inFlight();
      const inFlight = pendingSave ? await pendingSave : undefined;
      if (!inFlight?.conflict) status.clearNotices();
      const stayed = state.active.id === startedId && state.ownership === startedOwnership;
      const conflictCopy = !!(inFlight?.conflict && state.ownership && state.ownership !== startedOwnership && state.active.id !== startedId);
      // Navigated away during the wait: do not offer to delete a different document's saved copy.
      if (!stayed && !conflictCopy) {
        announce(AUTOSAVE_OFF);
        return;
      }
      const targetId = state.active.id;
      const targetRevision = state.active.revision;
      const targetOwnership = state.ownership!;
      // returnFocus is the checkbox itself: it is disabled for this handler, so
      // capture it here and let askConfirmChoice restore after finally re-enables.
      const deleteSaved = await askConfirmChoice({
        title: 'Delete the saved copy?',
        message: 'Delete the saved copy of this document? Keep saved copy leaves it in your Documents list.',
        confirmLabel: 'Delete saved copy',
        cancelLabel: 'Keep saved copy',
        returnFocus: deps.autosave,
      });
      if (deleteSaved) {
        try {
          // Keep the fence: this window goes on editing the same id privately.
          if (!state.db || targetOwnership.documentId !== targetId) throw new Error('Storage unavailable');
          if (state.active.id !== targetId || state.ownership !== targetOwnership || state.editBlock || deps.transferFrozen() || state.transitioning) {
            throw new Error('Document changed');
          }
          if (!await deleteStoredDraft(state.db, targetId, targetRevision, await targetOwnership.writeFence())) throw new Error('Draft changed');
          if (targetRevision >= 1) deps.postSignal('deleted', targetId, targetRevision);
          if (state.active.id === targetId) {
            state.active = { ...state.active, revision: 0 };
            deps.workspace.setDirty(true);
          }
          status.clearNotices();
          await deps.refreshDrafts();
        } catch (error) {
          if (error instanceof EditOwnershipLostError) deps.loseOwnership();
          status.announceAction('Could not delete saved document; current text is kept', { keepConflict: true });
          return;
        }
      }
      announce(AUTOSAVE_OFF);
    } finally {
      endAutosaveToggleGate();
      active = false;
      // A remote change can finish mid-switch; the checkbox stays disabled until it ends (#97).
      deps.autosave.disabled = deps.controlBlocked() || state.transitioning;
      // Re-focus after re-enabling only for local Settings (host owns focus on shared toggles).
      if (opts.promptDeleteSavedCopy || opts.persistPreference) {
        if (!deps.embedded) deps.autosave.focus({ preventScroll: true });
      }
      const queued = pendingRemoteAutosave;
      pendingRemoteAutosave = undefined;
      if (queued !== undefined) {
        void applyAutosaveChange(queued, { promptDeleteSavedCopy: false, persistPreference: false });
      }
    }
  }

  /** Re-read shared Autosave before this window can save again (handoff / ownership). */
  function syncAutosaveCheckboxFromStorage(): void {
    try {
      const next = autosaveEnabled();
      const changed = deps.autosave.checked !== next;
      deps.autosave.checked = next;
      if (!next) {
        deps.saver.cancel();
        if (changed) status.showSaveState();
        return;
      }
      // Autosave turned on while we were read-only: flush dirty text now that we can edit.
      if (changed && deps.workspace.dirty() && !deps.controlBlocked()) {
        status.showSaving();
        deps.journalEdit();
        void deps.persist();
      } else if (changed) {
        status.showSaveState();
      }
    } catch { /* Keep the current control state. */ }
  }
  return {
    /** Apply a change from local Settings (persist + prompt) or from shared sync. */
    apply: applyAutosaveChange,
    syncFromStorage: syncAutosaveCheckboxFromStorage,
    isActive: (): boolean => active,
    /** Resolves when an in-flight change finishes (undefined when none). */
    gate: (): Promise<void> | undefined => autosaveToggleGate,
  };
}

export type AutosaveToggle = ReturnType<typeof createAutosaveToggle>;
