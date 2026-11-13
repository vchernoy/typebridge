/**
 * Per-document Autosave / private switch for the shown document (#257 step 1).
 *
 * Unchecked means this document is private. The global private session is a separate Settings
 * control (`typebridge.autosave.v1`); while it is on, this checkbox is forced off and disabled.
 * Prefs sync shares only the global value; document switches update the checkbox from the
 * target document's flag.
 */
import {
  documentAutosaveChecked,
  PRIVATE_SWITCH_FLAG_FAILED,
  PRIVATE_SWITCH_SAVE_FAILED,
  privateNow,
  privateSessionOn,
} from '../editor/privacy';
import {
  EditOwnershipLostError,
  updateDocumentPrivateFlag,
  type StoredDraft,
} from '../editor/indexeddb';
import { AUTOSAVE_OFF } from '../editor/status';
import type { StatusLine } from '../ui/status-line';
import type { EditorState } from './editor-state';
import type { SaveResult } from './saver';
import type { Workspace } from './workspace';

export type AutosaveToggleDeps = {
  autosave: HTMLInputElement;
  privateMarker: HTMLElement;
  workspace: Workspace;
  viewMode: boolean;
  embedded: boolean;
  transferFrozen: () => boolean;
  controlBlocked: () => boolean;
  journalEdit: () => void;
  persist: () => Promise<SaveResult>;
  /** One last full save of a frozen pre-private snapshot (includes `private: true`). */
  persistLastBeforePrivate: (frozen: StoredDraft) => Promise<SaveResult>;
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
  /** Re-evaluate disabled state after a toggle (session / ownership / transitioning). */
  syncAutosaveControl: () => void;
};

export function createAutosaveToggle(state: EditorState, status: StatusLine, deps: AutosaveToggleDeps) {
  let active = false;
  let autosaveToggleGate: Promise<void> | undefined;
  let releaseAutosaveToggleGate: (() => void) | undefined;
  let pendingSession: boolean | undefined;

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

  /** Global private-session preference changed (Settings / host prefs sync). */
  async function applySessionChange(sessionOn: boolean): Promise<void> {
    if (active) {
      pendingSession = sessionOn;
      if (sessionOn) {
        deps.autosave.checked = false;
        deps.saver.cancel();
        syncPrivateMarker();
      }
      return;
    }
    active = true;
    beginGate();
    try {
      mirrorFromDocument();
      if (sessionOn) {
        deps.saver.cancel();
        if (!deps.controlBlocked()) {
          status.clearNotices();
          announce(AUTOSAVE_OFF);
        } else {
          status.showSaveState();
        }
        return;
      }
      // Session turned off: per-document flag decides.
      if (!deps.autosave.checked) {
        status.showSaveState();
        return;
      }
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
      finish(false);
    }
  }

  async function goPrivate(): Promise<void> {
    const wasDirty = deps.workspace.dirty();
    const changeLogCovered = deps.changeLogProtects();
    const frozen = deps.snapshot();
    // 1. Switch immediately.
    state.active = { ...state.active, private: true };
    deps.autosave.checked = false;
    deps.saver.cancel();
    syncPrivateMarker();
    deps.renderDrafts();
    // Drop stale conflict/action chrome; an in-flight save may re-announce after await.
    status.clearNotices();

    // Never-saved clean docs: nothing pre-private to keep (step 3 covers creation-time no-trace).
    if (frozen.revision < 1 && !wasDirty) {
      announce(AUTOSAVE_OFF);
      return;
    }

    const pending = deps.saver.inFlight();
    if (pending) await pending;
    state.active = { ...state.active, private: true };
    deps.autosave.checked = false;
    syncPrivateMarker();
    try { await deps.saver.drainChanges(); } catch { /* may already be failing */ }

    const result = await deps.persistLastBeforePrivate({
      ...frozen,
      private: true,
      updatedAt: Date.now(),
    });
    deps.abandonChangeRun();

    if (result.saved) {
      announce(AUTOSAVE_OFF);
      return;
    }

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
          state.active = flag.draft;
          flagOk = true;
        }
      }
    } catch (error) {
      if (error instanceof EditOwnershipLostError) deps.loseOwnership();
    }

    if (!flagOk) {
      status.announceAction(PRIVATE_SWITCH_FLAG_FAILED, { keepConflict: true });
      return;
    }
    if (wasDirty && !changeLogCovered && !state.storageProblem) {
      status.announceAction(PRIVATE_SWITCH_SAVE_FAILED, { keepConflict: true });
      return;
    }
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

  /** After showDraft / document switch: mirror the shown document (and session). */
  function syncFromDocument(): void {
    if (active) return;
    mirrorFromDocument();
    if (!deps.autosave.checked) deps.saver.cancel();
  }

  /** Re-read global session after host/prefs sync, then mirror the shown document. */
  function syncFromStorage(): void {
    if (active) {
      pendingSession = privateSessionOn();
      return;
    }
    void applySessionChange(privateSessionOn());
  }

  return {
    applyDocumentChange,
    applySessionChange,
    syncFromDocument,
    syncFromStorage,
    syncPrivateMarker,
    isPrivateNow: (): boolean => privateNow(state.active),
    isActive: (): boolean => active,
    gate: (): Promise<void> | undefined => autosaveToggleGate,
  };
}

export type AutosaveToggle = ReturnType<typeof createAutosaveToggle>;
