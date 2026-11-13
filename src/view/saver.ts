/**
 * Saving the shown document (#159 W4 fence): debounced Autosave writes under this window's
 * edit ownership, conflict copies when another tab changed the document, and the status that
 * follows. One save runs at a time; later edits are saved by the same loop or the next timer.
 *
 * Write decisions use `mayWrite` (= !privateNow) from #257 — not the checkbox alone.
 */
import { UNTITLED_TITLE } from '../editor/drafts';
import type { DocumentSignal } from './signals';
import { commitOrCreateConflictCopy, EditOwnershipLostError, type StoredDraft } from '../editor/indexeddb';
import { clearRecovery, type RecoverySnapshot } from '../editor/recovery';
import { CONFLICT_COPY, SAVE_FAILED } from '../editor/status';
import type { StatusLine } from '../ui/status-line';
import type { EditorState } from './editor-state';
import { testKnob } from './embed-api';
import type { Workspace } from './workspace';

export type SaveResult = { saved: boolean; conflict: boolean };

export type SaverDeps = {
  viewMode: boolean;
  /** False while privateNow() — the single write gate (#257). */
  mayWrite: () => boolean;
  draftTitle: HTMLInputElement;
  workspace: Workspace;
  writingPosition: { save: () => void };
  snapshot: () => StoredDraft;
  currentJournal: () => RecoverySnapshot | undefined;
  suppressEditTracking: () => boolean;
  readOnlyNow: () => boolean;
  preparePendingClear: (saved: StoredDraft) => () => void;
  clearVersionNotice: () => void;
  postSignal: (type: DocumentSignal['type'], documentId: string, revision: number) => void;
  journalEdit: () => void;
  changes: {
    edit: () => void;
    idle: () => Promise<void>;
    upToForSave: (documentId: string, savedText: string, savedTitle: string) => { upTo: number; keepRun: string };
    saved: (run: string, ok: boolean) => void;
  };
  onRecovered: (copy: StoredDraft, sourceId: string) => void;
  rememberActive: () => void;
  updateSaveIndicator: () => void;
  syncTitleTooltip: () => void;
  takeOwnership: (documentId: string) => Promise<void>;
  loseOwnership: () => void;
  refreshDrafts: () => Promise<void>;
  renderDrafts: () => void;
};

export function createSaver(state: EditorState, status: StatusLine, deps: SaverDeps) {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<SaveResult> | undefined;

  /**
   * Last pre-private commit after the document has already switched (#257).
   * Uses a frozen snapshot so later private typing cannot ride along. Ignores mayWrite
   * (already false) and may write even when clean so the `private` flag becomes durable.
   */
  async function persistLastBeforePrivate(frozen: StoredDraft): Promise<SaveResult> {
    if (deps.viewMode) return { saved: true, conflict: false };
    clearTimeout(saveTimer);
    if (state.deleting || state.editBlock) return { saved: false, conflict: false };
    if (saving) await saving;
    saving = (async () => {
      const delayMs = testKnob('__typebridgeDelayPersistMs');
      if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      let createdConflict = false;
      let preparedRun: string | undefined;
      try {
        if (!state.db) throw new Error('Storage unavailable');
        if (state.deleting || state.editBlock) return { saved: false, conflict: false };
        await deps.changes.idle();
        if (state.deleting || state.editBlock) return { saved: false, conflict: false };
        const version = deps.workspace.contentRevision();
        const saved: StoredDraft = { ...frozen, private: true, updatedAt: Date.now() };
        const log = deps.changes.upToForSave(saved.id, saved.text, saved.title);
        preparedRun = log.keepRun;
        saved.upTo = log.upTo;
        const clearPendingAfterCommit = deps.preparePendingClear(saved);
        if (state.ownership?.documentId !== saved.id) throw new EditOwnershipLostError();
        const owner = await state.ownership.writeFence();
        const current = deps.currentJournal();
        const journal = current && current.documentId === saved.id && current.revision === state.active.revision
          && current.text === saved.text && current.title === saved.title ? current : undefined;
        const result = await commitOrCreateConflictCopy(
          state.db, saved, state.active.revision, crypto.randomUUID(), owner,
          { keepRun: log.keepRun, recoveryId: crypto.randomUUID() },
        );
        deps.changes.saved(log.keepRun, !result.conflict);
        preparedRun = undefined;
        clearPendingAfterCommit();
        if (journal) { try { clearRecovery(localStorage, journal); } catch { /* keep */ } }
        state.active = { ...result.draft, private: true };
        deps.clearVersionNotice();
        deps.postSignal('saved', result.draft.id, result.draft.revision);
        if (result.recovered) deps.onRecovered(result.recovered, result.draft.id);
        deps.writingPosition.save();
        state.saveFailed = false;
        deps.workspace.setDirty(deps.workspace.contentRevision() !== version);
        deps.updateSaveIndicator();
        if (result.conflict) {
          deps.workspace.setDocumentId(result.draft.id);
          if ((deps.draftTitle.value.trim() || UNTITLED_TITLE) === saved.title) {
            deps.draftTitle.value = state.active.title;
            deps.syncTitleTooltip();
          }
          createdConflict = true;
          if (!state.transitioning) status.setConflict(CONFLICT_COPY, true);
          await deps.takeOwnership(result.draft.id);
        }
        try { await deps.refreshDrafts(); }
        catch {
          if (status.shouldAttachDraftListRefreshFailure()) status.markDraftListRefreshFailed();
        }
        return { saved: !result.conflict, conflict: createdConflict };
      } catch (error) {
        if (preparedRun) deps.changes.saved(preparedRun, false);
        if (error instanceof EditOwnershipLostError) {
          deps.loseOwnership();
          return { saved: false, conflict: createdConflict };
        }
        state.saveFailed = true;
        return { saved: false, conflict: createdConflict };
      }
    })();
    try { return await saving; } finally { saving = undefined; }
  }

  async function persist(): Promise<SaveResult> {
    if (deps.viewMode) return { saved: true, conflict: false };
    clearTimeout(saveTimer);
    if (state.deleting || !deps.mayWrite() || !deps.workspace.dirty()) {
      return { saved: !deps.workspace.dirty(), conflict: false };
    }
    if (state.editBlock) return { saved: false, conflict: false };
    if (saving) return saving;
    saving = (async () => {
      const delayMs = testKnob('__typebridgeDelayPersistMs');
      if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      let createdConflict = false;
      let preparedRun: string | undefined;
      try {
        if (!state.db) throw new Error('Storage unavailable');
        while (deps.workspace.dirty() && deps.mayWrite() && !state.editBlock) {
          await deps.changes.idle();
          // Waiting yielded: privacy may be on now, with private text typed since (#251 / #257).
          if (state.deleting || !deps.workspace.dirty() || !deps.mayWrite() || state.editBlock) break;
          const version = deps.workspace.contentRevision();
          const saved = deps.snapshot();
          const log = deps.changes.upToForSave(saved.id, saved.text, saved.title);
          preparedRun = log.keepRun;
          saved.upTo = log.upTo;
          const afterUpToMs = testKnob('__typebridgeDelayAfterUpToMs');
          if (typeof afterUpToMs === 'number' && afterUpToMs > 0) {
            await new Promise(resolve => setTimeout(resolve, afterUpToMs));
          }
          const clearPendingAfterCommit = deps.preparePendingClear(saved);
          if (state.ownership?.documentId !== saved.id) throw new EditOwnershipLostError();
          const owner = await state.ownership.writeFence();
          const current = deps.currentJournal();
          const journal = current && current.documentId === saved.id && current.revision === state.active.revision
            && current.text === saved.text && current.title === saved.title ? current : undefined;
          const result = await commitOrCreateConflictCopy(
            state.db, saved, state.active.revision, crypto.randomUUID(), owner,
            { keepRun: log.keepRun, recoveryId: crypto.randomUUID() },
          );
          deps.changes.saved(log.keepRun, !result.conflict);
          preparedRun = undefined;
          clearPendingAfterCommit();
          const titleOnly = !result.conflict && saved.title !== state.active.title && saved.text === state.active.text;
          if (journal) { try { clearRecovery(localStorage, journal); } catch { /* keep */ } }
          state.active = result.draft;
          deps.clearVersionNotice();
          deps.postSignal(titleOnly ? 'renamed' : 'saved', result.draft.id, result.draft.revision);
          if (result.recovered) deps.onRecovered(result.recovered, result.draft.id);
          deps.writingPosition.save();
          if (deps.workspace.contentRevision() !== version && deps.mayWrite()) deps.journalEdit();
          deps.rememberActive();
          state.saveFailed = false;
          deps.workspace.setDirty(deps.workspace.contentRevision() !== version);
          deps.updateSaveIndicator();
          if (result.conflict) {
            deps.workspace.setDocumentId(result.draft.id);
            if ((deps.draftTitle.value.trim() || UNTITLED_TITLE) === saved.title) {
              deps.draftTitle.value = state.active.title;
              deps.syncTitleTooltip();
            }
            createdConflict = true;
            if (!state.transitioning) status.setConflict(CONFLICT_COPY, true);
            status.updateStatus({
              primary: deps.workspace.dirty() && !state.storageProblem ? 'Saving…' : '',
              risk: status.riskText(),
            }, state.transitioning ? status.kind() : 'conflict');
            await deps.takeOwnership(result.draft.id);
          }
          if (!deps.workspace.dirty() && !result.conflict
            && (status.kind() === 'progress' || status.kind() === 'failure' || status.kind() === 'conflict')) {
            const risk = status.riskText();
            if (risk) status.setRiskStatus('', 'failure', risk);
            else status.setSaveStatus('Saved locally');
          }
        }
        try { await deps.refreshDrafts(); }
        catch {
          if (status.shouldAttachDraftListRefreshFailure()) status.markDraftListRefreshFailed();
        }
        return { saved: !deps.workspace.dirty(), conflict: createdConflict };
      } catch (error) {
        if (preparedRun) deps.changes.saved(preparedRun, false);
        if (error instanceof EditOwnershipLostError) {
          deps.loseOwnership();
          return { saved: false, conflict: createdConflict };
        }
        state.saveFailed = true;
        const risk = status.riskText() || SAVE_FAILED;
        if (status.message().primary && status.message().risk === risk) status.updateStatus({}, 'failure');
        else status.setRiskStatus('', 'failure', risk);
        return { saved: false, conflict: createdConflict };
      }
    })();
    try { return await saving; } finally {
      saving = undefined;
      if (!state.deleting && deps.workspace.dirty() && deps.mayWrite() && !state.saveFailed && !state.editBlock) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { void persist(); }, 300);
      }
    }
  }

  function scheduleSave(fromTitle = false): void {
    if (deps.readOnlyNow() || state.loadingDraft || deps.suppressEditTracking()) return;
    const becameDirty = !deps.workspace.dirty();
    deps.workspace.setDirty(true);
    deps.workspace.bumpContentRevision();
    deps.journalEdit();
    deps.changes.edit();
    if (!deps.mayWrite() && (becameDirty || fromTitle)) deps.renderDrafts();
    clearTimeout(saveTimer);
    if (deps.mayWrite()) {
      status.showSaving();
      saveTimer = setTimeout(() => { void persist(); }, 300);
    } else {
      status.showSaveState();
    }
  }

  return {
    persist,
    persistLastBeforePrivate,
    scheduleSave,
    cancel(): void { clearTimeout(saveTimer); },
    saveSoon(): void {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persist(); }, 300);
    },
    inFlight: (): Promise<SaveResult> | undefined => saving,
    drainChanges: (): Promise<void> => deps.changes.idle(),
  };
}
