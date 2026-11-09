/**
 * Edit access (#159 W4, #175): whether this window may edit the shown document. It acquires and
 * installs edit ownership, loses it when another window takes over, freezes the editors for an
 * ownership transfer, and parks/resumes ownership during a focus handoff. The rules for what a
 * block means are pure functions in view/ownership.ts.
 */
import type { Editor } from '../editor/editor';
import { acquireEditOwnership, type EditOwnership } from '../editor/edit-ownership';
import { getStoredDraft } from '../editor/indexeddb';
import type { StatusLine } from '../ui/status-line';
import type { EditAccess } from './documents';
import type { EditorState } from './editor-state';
import { testKnob } from './embed-api';
import { editBlockGuidance } from './ownership';
import type { createSinglePaneWorkspace } from './workspace';

/** Controls that change the displayed document; New, Import and switching stay available. */
export const OWNER_ONLY_CONTROLS = ['delete-draft', 'convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'];

export type EditAccessDeps = {
  viewMode: boolean;
  instanceId: string;
  webLocks: LockManager | undefined;
  workspace: ReturnType<typeof createSinglePaneWorkspace>;
  editor: Editor;
  titleEditor: Editor;
  ownershipNotice: HTMLElement;
  undo: HTMLButtonElement;
  redo: HTMLButtonElement;
  autosave: HTMLInputElement;
  writingPosition: { save: () => void };
  quietReader: () => boolean;
  syncHistory: () => void;
  syncMutationControls: () => void;
  updateSaveIndicator: () => void;
  /** #175 step 7: pick up host Autosave changes made while this window was read-only. */
  syncAutosaveCheckboxFromStorage: () => void;
  showDraft: () => void;
  cancelSave: () => void;
  saveSoon: () => void;
};

export function createEditAccess(state: EditorState, statusLine: StatusLine, deps: EditAccessDeps) {
  const {
    viewMode, instanceId, webLocks, workspace, editor, titleEditor, ownershipNotice, undo, redo, autosave,
    writingPosition, quietReader, syncHistory, syncMutationControls, updateSaveIndicator,
    syncAutosaveCheckboxFromStorage, showDraft, cancelSave, saveSoon,
  } = deps;
  const { showSaveState, announceAction } = statusLine;
  /** Reflect ownership + transfer freeze in the editors, controls and guidance (ordinary windows only). */
  function applyEditAccess(): void {
    if (viewMode) return;
    // Must match readOnlyNow: stay frozen for the whole switch/delete interval even if
    // installOwnership runs before the handler finishes (e.g. refreshDrafts after delete).
    const blocked = state.editBlock !== '' || state.transferFrozen;
    workspace.setPaneRole(blocked ? 'readonly' : 'editable');
    if (editor.readOnly !== blocked) editor.setReadOnly(blocked);
    if (titleEditor.readOnly !== blocked) titleEditor.setReadOnly(blocked);
    // A quiet reader keeps its controls enabled; a click takes over editing first (below).
    const controlsBlocked = blocked && !(quietReader() && !state.transferFrozen);
    for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = controlsBlocked;
    document.documentElement.dataset.role = state.editBlock !== '' ? 'reader' : 'editor';
    // Temporary transfer freeze must not announce "another window is editing".
    const guidance = state.transferFrozen || quietReader() || state.deletedElsewhere ? '' : editBlockGuidance(state.editBlock, workspace.dirty());
    if (ownershipNotice.textContent !== guidance) ownershipNotice.textContent = guidance;
    ownershipNotice.hidden = !guidance;
    syncHistory();
    syncMutationControls();
    updateSaveIndicator();
  }

  /** Try to own `documentId` without waiting; pass `steal` only for #175 suspended-owner handoff. */
  async function acquireFor(documentId: string, options: { steal?: boolean } = {}): Promise<EditAccess> {
    // Without storage nothing can be written, so there is nothing to own.
    if (viewMode || !state.db) return { block: '', generation: state.storageGeneration };
    const generation = state.storageGeneration;
    // E2E may set a delay to assert mutations are frozen during ownership transfer (#159 W4).
    const delayMs = testKnob('__typebridgeDelayAcquireMs');
    if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (generation !== state.storageGeneration || !state.db) return { block: 'error', generation: state.storageGeneration };
    let held: EditOwnership | undefined;
    try {
      const result = await acquireEditOwnership({
        db: state.db, locks: webLocks, documentId, instanceId,
        onLost: () => { if (held && state.ownership === held) loseOwnership(); },
        steal: options.steal,
      });
      // E2E: hold the lock briefly before returning so a mid-flight versionchange can be asserted.
      const afterMs = testKnob('__typebridgeDelayAfterAcquireMs');
      if (typeof afterMs === 'number' && afterMs > 0 && result.status === 'acquired') {
        await new Promise(resolve => setTimeout(resolve, afterMs));
      }
      if (generation !== state.storageGeneration || !state.db) {
        if (result.status === 'acquired') void result.ownership.release();
        return { block: 'error', generation: state.storageGeneration };
      }
      if (result.status !== 'acquired') return { block: result.status, generation };
      held = result.ownership;
      return { ownership: held, block: '', generation };
    } catch { return { block: 'error', generation: state.storageGeneration }; }
  }

  /** Freeze Editor + title gates and mutation controls for the ownership-transfer window. */
  function freezeEditorsForTransition(): void {
    state.transferFrozen = true;
    workspace.setPaneRole('readonly');
    editor.setReadOnly(true);
    titleEditor.setReadOnly(true);
    for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = true;
    undo.disabled = true;
    redo.disabled = true;
    autosave.disabled = true;
  }

  function unfreezeEditorsAfterTransition(): void {
    state.transferFrozen = false;
    applyEditAccess();
  }
  /** Make `access` current and release whatever this window owned before. */
  function installOwnership(access: EditAccess): void {
    let next = access;
    // Drop a handle acquired before storage was invalidated (versionchange mid-switch/boot).
    if (access.ownership && (access.generation !== state.storageGeneration || !state.db)) {
      void access.ownership.release();
      next = { block: access.block === '' ? 'error' : access.block, generation: state.storageGeneration };
    }
    const previous = state.ownership;
    state.ownership = next.ownership;
    state.editBlock = next.block;
    if (previous && previous !== state.ownership) void previous.release();
    applyEditAccess();
    // #175 step 7: pick up host Autosave changes that arrived while this window was read-only.
    if (state.editBlock === '') syncAutosaveCheckboxFromStorage();
  }
  async function takeOwnership(documentId: string): Promise<void> {
    installOwnership(await acquireFor(documentId));
  }
  /**
   * Another window owns this document now (fence mismatch or lock taken). Stop writing, keep the
   * text, title and history in memory for copy/export, and become read-only.
   */
  function loseOwnership(): void {
    if (viewMode) return;
    const previous = state.ownership;
    state.ownership = undefined;
    state.editBlock = 'lost';
    cancelSave();
    void previous?.release();
    applyEditAccess();
    showSaveState();
  }
  /**
   * Two-phase #175 handoff park: freeze the UI synchronously, then release the lock
   * while keeping text/title/history/dirty until the requester confirms takeover.
   */
  let parkReleaseHandle: EditOwnership | undefined;
  function beginParkFreeze(): void {
    if (viewMode) return;
    parkReleaseHandle = state.ownership;
    state.ownership = undefined;
    state.editBlock = 'busy';
    cancelSave();
    // Freeze before any await so typing cannot land outside the snapshot.
    applyEditAccess();
    showSaveState();
  }
  async function finishParkRelease(): Promise<void> {
    const previous = parkReleaseHandle;
    parkReleaseHandle = undefined;
    await previous?.release();
  }
  /** Confirmed takeover: show last saved text when this window had transferred private edits. */
  async function discardParkedHandoffText(documentId: string): Promise<void> {
    // Must still be viewing the yielded document — never wipe a different draft after a switch.
    if (viewMode || state.active.id !== documentId || !workspace.dirty() || !state.db) return;
    try {
      const fresh = await getStoredDraft(state.db, documentId);
      if (fresh) {
        writingPosition.save();
        state.active = fresh;
        showDraft();
        workspace.setDirty(false);
      }
    } catch { /* Keep the parked snapshot read-only if IndexedDB is unavailable. */ }
    applyEditAccess();
    showSaveState();
  }
  /** Failed/timed-out takeover: try to re-acquire while keeping parked text intact. */
  async function recoverParkedHandoffOwnership(documentId: string): Promise<void> {
    if (viewMode || state.ownership || state.active.id !== documentId) return;
    const access = await acquireFor(documentId);
    if (access.ownership) {
      installOwnership(access);
      announceAction('Editing stayed in this window — the other window could not take over.', { keepConflict: true });
      if (workspace.dirty() && autosave.checked) {
        saveSoon();
      }
      return;
    }
    state.editBlock = access.block || 'lost';
    applyEditAccess();
    showSaveState();
  }

  return {
    applyEditAccess,
    acquireFor,
    freezeEditorsForTransition,
    unfreezeEditorsAfterTransition,
    installOwnership,
    takeOwnership,
    loseOwnership,
    beginParkFreeze,
    finishParkRelease,
    discardParkedHandoffText,
    recoverParkedHandoffOwnership,
  };
}

export type EditAccessControl = ReturnType<typeof createEditAccess>;
