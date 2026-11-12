/**
 * Document actions in an editing window: switching to another saved document or a new one, and
 * deleting the shown document. Both flush or discard unsaved text first, freeze editing for the
 * ownership transfer, and acquire the next document under this window's edit lock (#159 W4).
 */
import type { EditOwnership } from '../editor/edit-ownership';
import { deleteStoredDraft, EditOwnershipLostError, getStoredDraft, type StoredDraft } from '../editor/indexeddb';
import { CONFLICT_COPY, CONFLICT_COPY_LEFT } from '../editor/status';
import { askConfirmChoice } from '../ui/confirm-dialog';
import type { StatusLine } from '../ui/status-line';
import type { EditorState } from './editor-state';
import type { EditBlock } from './ownership';
import type { SaveResult } from './saver';
import { sessionPersistStillCurrent } from './session';
import type { DocumentSignal } from './signals';
import type { Workspace } from './workspace';

export type SwitchResult = { opened: boolean; conflict: boolean };
export type EditAccess = { ownership?: EditOwnership; block: EditBlock; generation: number };

export type DocumentActionsDeps = {
  viewMode: boolean;
  autosave: HTMLInputElement;
  workspace: Workspace;
  writingPosition: { save: () => void; remove: (id: string) => void };
  saver: { cancel: () => void; saveSoon: () => void; inFlight: () => Promise<SaveResult> | undefined; drainChanges: () => Promise<void> };
  persist: () => Promise<SaveResult>;
  /** Resolves when an in-flight Autosave change finishes. */
  autosaveGate: () => Promise<void> | undefined;
  focusHandoff: () => { cancel: () => void } | undefined;
  /** Drop a held control click and held title edits (they belong to the document left). */
  clearHeldEdits: () => void;
  readOnlyNow: () => boolean;
  freezeEditorsForTransition: () => void;
  unfreezeEditorsAfterTransition: () => void;
  /** Re-evaluate whether the Autosave checkbox may be used (disabled while transitioning). */
  syncAutosaveControl: () => void;
  allocateNewDraft: () => StoredDraft;
  acquireFor: (documentId: string) => Promise<EditAccess>;
  installOwnership: (access: EditAccess) => void;
  loseOwnership: () => void;
  rememberActive: () => void;
  showDraft: () => void;
  renderDrafts: () => void;
  refreshDrafts: () => Promise<void>;
  openDocumentIdsElsewhere: () => Set<string>;
  postSignal: (type: DocumentSignal['type'], documentId: string, revision: number) => void;
};

export function createDocumentActions(state: EditorState, status: StatusLine, deps: DocumentActionsDeps) {
  async function switchDraft(id?: string): Promise<SwitchResult> {
    if (deps.viewMode || state.transitioning) return { opened: false, conflict: false };
    { const toggling = deps.autosaveGate(); if (toggling) await toggling; }
    if (state.transitioning) return { opened: false, conflict: false };
    deps.clearHeldEdits();
    deps.focusHandoff()?.cancel();
    if (id === state.active.id) { deps.renderDrafts(); return { opened: true, conflict: false }; }
    // Update-reload freeze: New / picker / import must not change identity mid-commit (#254).
    if (state.reloadFrozen) return { opened: false, conflict: false };
    state.transitioning = true;
    // Autosave cannot change mid-switch: turning it off would offer to delete a conflict copy
    // whose notice is only shown once the switch finishes (#97). Re-enabled on unfreeze.
    deps.syncAutosaveControl();
    let flushConflict = false;
    /** Announce a flush conflict when the switch does not open another draft. */
    const announceAbortedFlushConflict = (): void => {
      // Re-announce when the same wording is already shown: this is a new conflict copy (#97).
      if (flushConflict) status.setConflict(CONFLICT_COPY, true);
    };
    let acquired: EditOwnership | undefined;
    try {
      deps.saver.cancel();
      let next: StoredDraft | undefined;
      while (true) {
        while (deps.workspace.dirty() && deps.autosave.checked && !state.editBlock) {
          const result = await deps.persist();
          if (result.conflict) flushConflict = true;
          if (!result.saved && state.saveFailed) {
            announceAbortedFlushConflict();
            return { opened: false, conflict: flushConflict };
          }
        }
        // Text this window cannot save (Autosave off, or another window owns the document) needs consent to drop.
        if (deps.workspace.dirty() && (!deps.autosave.checked || state.editBlock)) {
          const persistToken = deps.workspace.capturePersistGeneration();
          const contentAtPrompt = deps.workspace.contentRevision();
          if (!await askConfirmChoice({ title: 'Discard unsaved changes?', message: state.editBlock
            ? 'Another window is editing this document, so this window cannot save these changes. Copy or export them first to keep them.'
            : 'Copy or export unsaved changes first to keep them.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! })) {
            announceAbortedFlushConflict();
            return { opened: false, conflict: flushConflict };
          }
          // Edit-in-this-pane must not cancel discard (persist token ignores paneGeneration),
          // but a document-identity change during the dialog must.
          if (!sessionPersistStillCurrent(persistToken, {
            sessionId: deps.workspace.sessionId,
            sessionGeneration: deps.workspace.sessionGeneration(),
          }) || deps.workspace.contentRevision() !== contentAtPrompt) {
            status.announceAction('Discard cancelled — the document changed while the dialog was open.');
            announceAbortedFlushConflict();
            return { opened: false, conflict: flushConflict };
          }
        }
        const version = deps.workspace.contentRevision();
        next = id && state.db ? await getStoredDraft(state.db, id) : undefined;
        if (id && !next) throw new Error('Draft no longer exists');
        if (deps.workspace.contentRevision() === version) break;
      }
      // Freeze Editor mutation gates (not only DOM readOnly) for the whole acquire/reread window.
      deps.freezeEditorsForTransition();
      let target = next ?? deps.allocateNewDraft();
      const access = await deps.acquireFor(target.id);
      acquired = access.ownership;
      if (acquired && next && state.db) {
        // Reread under the new fence: the previous owner may have saved just before releasing.
        const fresh = await getStoredDraft(state.db, next.id);
        if (!fresh) throw new Error('Draft no longer exists');
        target = fresh;
      }
      deps.writingPosition.save();
      state.active = target;
      deps.rememberActive();
      deps.showDraft();
      deps.installOwnership(access);
      acquired = undefined;
      // Always show the opened draft's save state — pre-switch action feedback must not stick.
      status.showSaveState();
      // Flush announced nothing while transitioning; name the draft that was left once.
      if (flushConflict) status.setConflict(CONFLICT_COPY_LEFT, true);
      void deps.refreshDrafts().catch(() => {
        if (status.shouldAttachDraftListRefreshFailure()) status.markDraftListRefreshFailed();
      });
      return { opened: true, conflict: flushConflict };
    } catch {
      void acquired?.release();
      announceAbortedFlushConflict();
      status.announceAction('Could not open document — current text was kept', { keepConflict: flushConflict });
      return { opened: false, conflict: flushConflict };
    }
    finally {
      state.transitioning = false;
      deps.unfreezeEditorsAfterTransition();
      deps.renderDrafts();
    }
  }
  async function deleteActive(): Promise<void> {
    if (deps.readOnlyNow() || state.transitioning || state.reloadFrozen) return;
    deps.focusHandoff()?.cancel();
    deps.saver.cancel();
    const requestedId = state.active.id;
    // Warn when another host window shows it; that window keeps its text and can keep a copy.
    const openElsewhere = deps.openDocumentIdsElsewhere().has(state.active.id);
    const deleteMessage = openElsewhere
      ? 'Permanently delete this saved document? It is also open in another window, which will keep its text until you close it there.'
      : 'Permanently delete this saved document?';
    if (!await askConfirmChoice({ title: 'Delete document?', message: deleteMessage, confirmLabel: 'Delete document', cancelLabel: 'Keep document', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! })) {
      if (deps.workspace.dirty() && deps.autosave.checked) deps.saver.saveSoon();
      return;
    }
    state.transitioning = true;
    deps.freezeEditorsForTransition();
    let committed = false;
    let savedBeforeDelete = false;
    try {
      { const pendingSave = deps.saver.inFlight(); if (pendingSave && !(await pendingSave).saved) throw new Error('Save failed'); }
      if (deps.workspace.dirty() && deps.autosave.checked) {
        if (!(await deps.persist()).saved) throw new Error('Save failed');
        savedBeforeDelete = true;
      }
      if (state.active.id !== requestedId) {
        status.announceAction('Could not delete original — your changes were saved as a conflict copy.');
        return;
      }
      state.deleting = true;
      const deletedRevision = state.active.revision;
      if (!state.db) throw new Error('Storage unavailable');
      if (!state.ownership || state.ownership.documentId !== state.active.id) throw new EditOwnershipLostError();
      // Queued change records must land before the delete removes them, never after (#251 review).
      await deps.saver.drainChanges();
      if (!await deleteStoredDraft(state.db, state.active.id, state.active.revision, await state.ownership.writeFence(), true)) throw new Error('Draft changed in another tab');
      committed = true;
      deps.writingPosition.remove(requestedId);
      if (deletedRevision >= 1) deps.postSignal('deleted', state.active.id, deletedRevision);
      deps.saver.cancel();
      const replacement: StoredDraft = deps.allocateNewDraft();
      const access = await deps.acquireFor(replacement.id);
      state.active = replacement;
      deps.rememberActive();
      // The deletion is durable; clear the editor before a fallible list refresh.
      deps.showDraft();
      deps.installOwnership(access);
      try { await deps.refreshDrafts(); status.announceAction('Document deleted'); }
      catch { status.announceAction('Document deleted, but the document list could not be refreshed'); }
    } catch (error) {
      if (error instanceof EditOwnershipLostError) deps.loseOwnership();
      // Without storage, announceAction() adds the storage warning; no save will follow.
      // Explicit delete failures clear conflict feedback; these two messages already
      // state the save situation, so they do not also append riskText().
      if (state.editBlock) {
        status.announceAction('Could not delete document — another window is editing it. Your text is kept.', { kind: 'failure' });
      } else if (deps.workspace.dirty() && !state.saveFailed && deps.autosave.checked && !state.storageProblem) {
        status.announceAction('Could not delete document — your changes are unsaved; saving again…', { kind: 'progress', omitRisk: true });
      } else if (deps.workspace.dirty() && !deps.autosave.checked && !state.storageProblem) {
        status.announceAction('Could not delete document — your changes are unsaved; autosave is off', { kind: 'progress', omitRisk: true });
      } else status.announceAction(savedBeforeDelete ? 'Could not delete document — Saved locally; your text is kept.' : 'Could not delete document — your text is kept.');
    } finally {
      state.transitioning = false;
      state.deleting = false;
      deps.unfreezeEditorsAfterTransition();
      if (!committed && deps.workspace.dirty() && deps.autosave.checked && !state.editBlock) {
        deps.saver.saveSoon();
      }
    }
  }
  return { switchDraft, deleteActive };
}
