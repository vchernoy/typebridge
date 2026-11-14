/**
 * Per-document Autosave / private switch for the shown document (#257 step 1).
 *
 * Unchecked means this document is private. The global private session is a separate Settings
 * control (`typebridge.autosave.v1`); while it is on, this checkbox is forced off and disabled.
 * Prefs sync shares only the global value; document switches update the checkbox from the
 * target document's flag. Going private offers Keep/Delete of the saved copy (#257 follow-up).
 */
import {
  documentAutosaveChecked,
  PRIVATE_SWITCH_FLAG_FAILED,
  PRIVATE_SWITCH_SAVE_FAILED,
  privateNow,
  privateSessionOn,
} from '../editor/privacy';
import {
  deleteStoredDraft,
  EditOwnershipLostError,
  updateDocumentPrivateFlag,
  type StoredDraft,
} from '../editor/indexeddb';
import { AUTOSAVE_OFF } from '../editor/status';
import { askConfirmChoice } from '../ui/confirm-dialog';
import type { StatusLine } from '../ui/status-line';
import type { EditorState } from './editor-state';
import type { LastBeforePrivacyOptions, SaveResult } from './saver';
import type { DocumentSignal } from './signals';
import type { Workspace } from './workspace';

export type AutosaveToggleDeps = {
  syncIdentity?: () => void;
  documentCleared?: (id: string) => void;
  autosave: HTMLInputElement;
  privateMarker: HTMLElement;
  workspace: Workspace;
  viewMode: boolean;
  embedded: boolean;
  transferFrozen: () => boolean;
  controlBlocked: () => boolean;
  journalEdit: () => void;
  persist: () => Promise<SaveResult>;
  /**
   * One last full save of a frozen pre-privacy snapshot. Pass the content revision from the
   * freeze moment, not after awaits. `markPrivate` true for the per-document toggle; false for
   * the global private session (#257 follow-up).
   */
  persistLastBeforePrivate: (
    frozen: StoredDraft,
    frozenContentRevision: number,
    options?: LastBeforePrivacyOptions,
  ) => Promise<SaveResult>;
  snapshot: () => StoredDraft;
  changeLogProtects: () => boolean;
  saver: {
    cancel: () => void;
    inFlight: () => Promise<SaveResult> | undefined;
    drainChanges: () => Promise<void>;
  };
  abandonChangeRun: () => void;
  refreshDrafts: () => Promise<void>;
  renderDrafts: () => void;
  loseOwnership: () => void;
  postSignal: (type: DocumentSignal['type'], documentId: string, revision: number) => void;
  /** Drop journal and reload-backup entries for this document after Delete saved copy. */
  clearDocumentBackups: (documentId: string) => void;
  /** Re-evaluate disabled state after a toggle (session / ownership / transitioning). */
  syncAutosaveControl: () => void;
};

export function createAutosaveToggle(state: EditorState, status: StatusLine, deps: AutosaveToggleDeps) {
  let active = false;
  let autosaveToggleGate: Promise<void> | undefined;
  let releaseAutosaveToggleGate: (() => void) | undefined;
  let pendingSession: boolean | undefined;
  /** Session value currently being applied via `applySessionChange` (not document go-private). */
  let sessionApplyTarget: boolean | undefined;
  /** Last session preference that finished applying (for CustomEvent + storage dedupe). */
  let appliedSessionOn: boolean | undefined;
  /**
   * Last text/title/history (+ content revision) taken while `mayWrite` / !privateNow.
   * Cross-tab `storage` can arrive after localStorage already flipped; live snapshot() then
   * can include post-private typing. Prefer this boundary for the session last-save (#260 P1).
   */
  let lastWritable: { draft: StoredDraft; contentRevision: number } | undefined;

  function beginGate(): void {
    if (autosaveToggleGate) return;
    autosaveToggleGate = new Promise(resolve => {
      releaseAutosaveToggleGate = () => {
        autosaveToggleGate = undefined;
        releaseAutosaveToggleGate = undefined;
        resolve();
      };
    });
  }
  function endGate(): void {
    releaseAutosaveToggleGate?.();
  }

  function syncPrivateMarker(): void {
    deps.privateMarker.hidden = deps.autosave.checked;
    deps.syncIdentity?.();
  }

  function mirrorFromDocument(): void {
    const session = privateSessionOn();
    deps.autosave.checked = documentAutosaveChecked(state.active, session);
    syncPrivateMarker();
  }

  function announce(text: string): void {
    if (state.storageProblem) status.setSaveStatus(status.riskText(), 'failure');
    else status.setSaveStatus(text);
  }

  function finish(refocus: boolean): void {
    endGate();
    active = false;
    sessionApplyTarget = undefined;
    deps.syncAutosaveControl();
    if (refocus && !deps.embedded) {
      try { deps.autosave.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    const queued = pendingSession;
    pendingSession = undefined;
    if (queued !== undefined) void applySessionChange(queued);
  }

  /**
   * Apply a per-document Autosave change (local UI). `enabled` true = leave private.
   */
  async function applyDocumentChange(enabled: boolean): Promise<void> {
    if (active) return;
    if (deps.controlBlocked()) return;
    if (privateSessionOn()) {
      // Global session owns privacy; checkbox cannot enable saving.
      mirrorFromDocument();
      deps.syncAutosaveControl();
      return;
    }
    const wantPrivate = !enabled;
    if (wantPrivate && state.active.private) {
      mirrorFromDocument();
      return;
    }
    if (!wantPrivate && !state.active.private && deps.autosave.checked) return;

    active = true;
    deps.autosave.disabled = true;
    beginGate();
    try {
      if (wantPrivate) await goPrivate();
      else await leavePrivate();
    } finally {
      finish(true);
    }
  }

  /**
   * Record the current editor surface while writes are still allowed. Call from input /
   * title / history paths **after** `scheduleSave()` bumps `contentRevision` (and after
   * showing a writable document) so a delayed cross-tab Private session notification can
   * last-save this boundary instead of post-private text, and so the freeze matches the
   * post-edit revision (#260 / #262).
   */
  function noteWritableSnapshot(): void {
    if (privateNow(state.active)) return;
    lastWritable = {
      draft: deps.snapshot(),
      contentRevision: deps.workspace.contentRevision(),
    };
  }

  /**
   * Last save of dirty text typed while writes were still allowed, without setting the
   * document `private` flag (#257 switching steps / follow-up item 1).
   * Returns whether that last save failed so callers can warn instead of announcing a clean
   * Autosave-off (#260 Codex P1).
   */
  async function lastSaveBeforeSession(): Promise<{ saveFailed: boolean }> {
    if (state.active.revision === 0) {
      // A cancelled/aborted first save has no post-commit identity callback. Wait so the
      // session finally can release its reservation/fence after saver.inFlight clears.
      const pending = deps.saver.inFlight();
      if (pending) await pending;
      return { saveFailed: false };
    }
    if (state.active.private || !deps.workspace.dirty()) return { saveFailed: false };
    const canSave = !deps.viewMode && !deps.transferFrozen() && state.editBlock === '';
    if (!canSave) return { saveFailed: false };
    // Prefer the last may-write boundary: delayed `storage` can run after post-private typing
    // already landed in the field while mayWrite() already returned false (#260 P1).
    const boundary = lastWritable;
    const frozen = boundary?.draft ?? deps.snapshot();
    const frozenContentRevision = boundary?.contentRevision ?? deps.workspace.contentRevision();
    lastWritable = undefined;
    const pending = deps.saver.inFlight();
    if (pending) await pending;
    let freezeTarget = frozen;
    if (state.active.id !== frozen.id) {
      freezeTarget = {
        ...frozen,
        id: state.active.id,
        revision: state.active.revision,
      };
    }
    try { await deps.saver.drainChanges(); } catch { /* may already be failing */ }
    const result = await deps.persistLastBeforePrivate({
      ...freezeTarget,
      updatedAt: Date.now(),
    }, frozenContentRevision, { markPrivate: false });
    deps.abandonChangeRun();
    return { saveFailed: !result.saved };
  }

  /** Global private-session preference changed (Settings / host prefs sync). */
  async function applySessionChange(sessionOn: boolean): Promise<void> {
    if (active) {
      if (sessionOn) {
        deps.autosave.checked = false;
        deps.saver.cancel();
        syncPrivateMarker();
      }
      // Same-tab host fan-out + storage can both arrive while the first last-save awaits.
      // Do not queue a replay of the same target — that would re-snapshot post-session typing (#260 P1).
      // A same-target reassertion after an opposite queue must cancel that stale pending first
      // (on → off → on while in flight), or finish() would apply the stale value (#260 P1).
      if (sessionApplyTarget === sessionOn) {
        if (pendingSession !== undefined && pendingSession !== sessionOn) {
          pendingSession = undefined;
        }
        return;
      }
      if (pendingSession === sessionOn) return;
      pendingSession = sessionOn;
      return;
    }
    // Echo after the transition already finished (second of CustomEvent / storage).
    if (appliedSessionOn === sessionOn) {
      mirrorFromDocument();
      deps.syncAutosaveControl();
      return;
    }
    active = true;
    sessionApplyTarget = sessionOn;
    beginGate();
    try {
      mirrorFromDocument();
      if (sessionOn) {
        deps.saver.cancel();
        // Lock the per-document control while the last pre-session save runs (same as goPrivate).
        if (!deps.controlBlocked()) deps.autosave.disabled = true;
        if (!deps.controlBlocked()) {
          status.clearNotices();
          const { saveFailed } = await lastSaveBeforeSession();
          // Match goPrivate: do not paper over a failed last-save with AUTOSAVE_OFF (#260 P1).
          if (saveFailed) {
            status.announceAction(PRIVATE_SWITCH_SAVE_FAILED, { keepConflict: true });
          } else {
            announce(AUTOSAVE_OFF);
          }
        } else {
          status.showSaveState();
        }
        return;
      }
      // Session turned off: per-document flag decides.
      lastWritable = undefined;
      if (!deps.autosave.checked) {
        status.showSaveState();
        return;
      }
      noteWritableSnapshot();
      const canSave = !deps.viewMode && !deps.transferFrozen() && state.editBlock === '';
      if (!canSave) {
        status.showSaveState();
        return;
      }
      status.clearNotices();
      if (deps.workspace.dirty()) {
        status.showSaving();
        deps.journalEdit();
        void deps.persist();
      } else {
        announce('Autosave on');
      }
    } finally {
      deps.syncIdentity?.();
      appliedSessionOn = sessionOn;
      finish(false);
    }
  }

  /**
   * Offer Keep/Delete after going private. When true, `skipAutosaveOff` means a status message
   * was already announced that must not be replaced by AUTOSAVE_OFF (#260 Codex P1 / P2).
   */
  async function offerDeleteSavedCopy(confirmed = false): Promise<{ skipAutosaveOff: boolean }> {
    if (state.active.revision < 1) return { skipAutosaveOff: false };
    // Bind deletion to this document before any await — defense if a switch somehow races the gate.
    const targetId = state.active.id;
    const targetRevision = state.active.revision;
    const targetOwnership = state.ownership;
    if (!targetOwnership || targetOwnership.documentId !== targetId) return { skipAutosaveOff: false };
    const deleteSaved = confirmed || await askConfirmChoice({
      title: 'Delete the saved copy?',
      message: 'Delete the saved copy of this document? Keep saved copy leaves it in your Documents list.',
      confirmLabel: 'Delete saved copy',
      cancelLabel: 'Keep saved copy',
      returnFocus: deps.autosave,
    });
    if (!deleteSaved) return { skipAutosaveOff: false };
    try {
      if (!state.db || targetOwnership.documentId !== targetId) throw new Error('Storage unavailable');
      if (state.active.id !== targetId || state.ownership !== targetOwnership || state.editBlock || deps.transferFrozen() || state.transitioning) {
        throw new Error('Document changed');
      }
      // Stop new records and drain already queued appends before erasing them (#270 P0).
      deps.abandonChangeRun();
      await deps.saver.drainChanges();
      // Keep the fence until deletion commits; the clear action then releases it.
      if (!await deleteStoredDraft(state.db, targetId, targetRevision, await targetOwnership.writeFence())) {
        throw new Error('Draft changed');
      }
      deps.clearDocumentBackups(targetId);
      if (targetRevision >= 1) deps.postSignal('deleted', targetId, targetRevision);
      if (state.active.id === targetId) {
        state.active = { ...state.active, revision: 0, private: true };
        deps.workspace.setDirty(true);
      }
      status.clearNotices();
      if (confirmed) deps.documentCleared?.(targetId);
      // Deletion is durable; list refresh failure must not look like a failed delete (#260 Codex P2).
      try {
        await deps.refreshDrafts();
      } catch {
        status.announceAction('Saved copy deleted, but the document list could not be refreshed', { keepConflict: true });
        return { skipAutosaveOff: true };
      }
      return { skipAutosaveOff: false };
    } catch (error) {
      if (error instanceof EditOwnershipLostError) deps.loseOwnership();
      status.announceAction('Could not delete saved document; current text is kept', { keepConflict: true });
      return { skipAutosaveOff: true };
    }
  }

  async function goPrivate(): Promise<void> {
    const wasDirty = deps.workspace.dirty();
    const changeLogCovered = deps.changeLogProtects();
    const frozen = deps.snapshot();
    // Capture with the freeze: awaits below can bump the revision via private typing (#257 P0).
    const frozenContentRevision = deps.workspace.contentRevision();
    // 1. Switch immediately.
    state.active = { ...state.active, private: true };
    deps.autosave.checked = false;
    deps.saver.cancel();
    syncPrivateMarker();
    deps.renderDrafts();
    // Drop stale conflict/action chrome; an in-flight save may re-announce after await.
    status.clearNotices();

    // A first transaction may already have committed even though our frozen revision is zero.
    // Preserve its fence until it settles, then decide whether this is still a never-saved document.
    const pending = deps.saver.inFlight();
    if (pending) await pending;
    state.active = { ...state.active, private: true };
    deps.autosave.checked = false;
    syncPrivateMarker();
    if (state.active.revision < 1) {
      deps.abandonChangeRun();
      announce(AUTOSAVE_OFF);
      return;
    }
    // Only the identity/revision follow the completed commit; fields and content revision stay frozen.
    const freezeTarget = { ...frozen, id: state.active.id, revision: state.active.revision };
    try { await deps.saver.drainChanges(); } catch { /* may already be failing */ }

    const result = await deps.persistLastBeforePrivate({
      ...freezeTarget,
      private: true,
      updatedAt: Date.now(),
    }, frozenContentRevision, { markPrivate: true });
    deps.abandonChangeRun();

    let warnSave = false;
    let warnFlag = false;

    if (!result.saved) {
      // Flag-only update under the ownership fence when the full save failed.
      let flagOk = false;
      try {
        if (state.db && state.ownership && state.ownership.documentId === state.active.id
          && state.active.revision >= 1) {
          const fence = await state.ownership.writeFence();
          const flag = await updateDocumentPrivateFlag(
            state.db, state.active.id, true, state.active.revision, fence,
          );
          if (flag.ok) {
            // A flag-only commit carries the old stored content, not newer private format actions.
            state.active = { ...flag.draft, format: state.active.format };
            flagOk = true;
          }
        }
      } catch (error) {
        if (error instanceof EditOwnershipLostError) deps.loseOwnership();
      }

      if (!flagOk) {
        warnFlag = true;
      } else if (wasDirty && (!changeLogCovered || !deps.changeLogProtects()) && !state.storageProblem) {
        // Re-check after awaits: a conflict copy drops held change records (#257 P1).
        warnSave = true;
      }
    }

    const { skipAutosaveOff } = await offerDeleteSavedCopy();

    if (warnFlag) {
      status.announceAction(PRIVATE_SWITCH_FLAG_FAILED, { keepConflict: true });
      return;
    }
    if (warnSave) {
      status.announceAction(PRIVATE_SWITCH_SAVE_FAILED, { keepConflict: true });
      return;
    }
    // Keep delete-failure / list-refresh feedback visible (#260 Codex P1).
    if (skipAutosaveOff) return;
    announce(AUTOSAVE_OFF);
  }

  async function leavePrivate(): Promise<void> {
    const contentDirty = deps.workspace.dirty();
    state.active = { ...state.active, private: false };
    deps.autosave.checked = true;
    syncPrivateMarker();

    const canSave = !deps.viewMode && !deps.transferFrozen() && state.editBlock === '';
    if (!canSave) {
      status.showSaveState();
      return;
    }
    status.clearNotices();
    if (state.active.revision >= 1 || contentDirty) {
      deps.workspace.setDirty(true);
      status.showSaving();
      deps.journalEdit();
      // Do not hold the toggle gate for the whole save — same as historical Autosave-on.
      void deps.persist().then(result => {
        if (result.saved && !contentDirty) announce('Autosave on');
        else if (!result.saved) status.showSaveState();
      });
      return;
    }
    announce('Autosave on');
  }

  async function clearSavedData(): Promise<void> {
    if (active || deps.controlBlocked() || state.active.revision < 1) return;
    active = true; beginGate(); deps.autosave.disabled = true;
    const id = state.active.id;
    try {
      if (!await askConfirmChoice({ title: 'Clear this document’s saved data?',
        message: 'Permanently delete this document’s saved copy, change records, crash and reload backups, and saved view metadata on this device? This cannot be undone. The text stays privately in this window until you leave.',
        confirmLabel: 'Clear saved data', cancelLabel: 'Cancel',
        returnFocus: () => deps.autosave.ownerDocument?.querySelector<HTMLElement>('#doc-menu-open') ?? deps.autosave })) return;
      if (state.active.id !== id) return;
      state.active = { ...state.active, private: true }; deps.autosave.checked = false;
      deps.saver.cancel(); syncPrivateMarker();
      const pending = deps.saver.inFlight(); if (pending) await pending;
      if (state.active.id !== id) return;
      await offerDeleteSavedCopy(true);
      if (state.active.id === id && state.active.revision === 0) {
        // Kept text is a new private scratch document, never a resurrection of the erased identity.
        const held = state.ownership; state.ownership = undefined; await held?.release();
        state.active = { ...state.active, id: crypto.randomUUID() };
        deps.workspace.bumpSessionGeneration(); deps.workspace.setDocumentId(state.active.id);
        deps.renderDrafts();
      }
      syncPrivateMarker();
    } finally { finish(false); }
  }

  /** After showDraft / document switch: mirror the shown document (and session). */
  function syncFromDocument(): void {
    if (active) return;
    lastWritable = undefined;
    mirrorFromDocument();
    if (!deps.autosave.checked) deps.saver.cancel();
    else noteWritableSnapshot();
  }

  /** Re-read global session after host/prefs sync, then mirror the shown document. */
  function syncFromStorage(): void {
    void applySessionChange(privateSessionOn());
  }

  return {
    clearSavedData,
    applyDocumentChange,
    applySessionChange,
    noteWritableSnapshot,
    syncFromDocument,
    syncFromStorage,
    syncPrivateMarker,
    isPrivateNow: (): boolean => privateNow(state.active),
    isActive: (): boolean => active,
    gate: (): Promise<void> | undefined => autosaveToggleGate,
  };
}

export type AutosaveToggle = ReturnType<typeof createAutosaveToggle>;
