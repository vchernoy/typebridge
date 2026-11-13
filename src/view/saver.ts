/**
 * Saving the shown document (#159 W4 fence): debounced Autosave writes under this window's
 * edit ownership, conflict copies when another tab changed the document, and the status that
 * follows. One save runs at a time; later edits are saved by the same loop or the next timer.
 */
import { UNTITLED_TITLE } from '../editor/drafts';
import type { DocumentSignal } from './signals';
import { commitOrCreateConflictCopy, EditOwnershipLostError, type StoredDraft } from '../editor/indexeddb';
import { clearRecovery, type RecoverySnapshot } from '../editor/recovery';
import { CONFLICT_COPY, SAVE_FAILED } from '../editor/status';
import type { StatusLine } from '../ui/status-line';
import type { EditorState } from './editor-state';
import { testKnob } from './embed-api';
import { isReloadDiscardPendingActive } from './reload-discard';
import type { Workspace } from './workspace';

export type SaveResult = { saved: boolean; conflict: boolean };

export type SaverDeps = {
  viewMode: boolean;
  autosave: HTMLInputElement;
  draftTitle: HTMLInputElement;
  workspace: Workspace;
  writingPosition: { save: () => void };
  /** Text, title and history to save now. */
  snapshot: () => StoredDraft;
  /** The emergency journal entry for the unsaved text, if any. */
  currentJournal: () => RecoverySnapshot | undefined;
  /** Applying a handoff snapshot is not an edit. */
  suppressEditTracking: () => boolean;
  readOnlyNow: () => boolean;
  preparePendingClear: (saved: StoredDraft) => () => void;
  clearVersionNotice: () => void;
  postSignal: (type: DocumentSignal['type'], documentId: string, revision: number) => void;
  journalEdit: () => void;
  /** Change log of the shown document (#37 R2c). */
  changes: {
    edit: () => void;
    idle: () => Promise<void>;
    upToForSave: (documentId: string, savedText: string, savedTitle: string) => { upTo: number; keepRun: string };
    /** Whether the save prepared by upToForSave for `run` committed its text. */
    saved: (run: string, ok: boolean) => void;
  };
  /** A save kept what a crashed run had typed as a recovered copy (#37 R2c). */
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
  async function persist(): Promise<SaveResult> {
    if (deps.viewMode) return { saved: true, conflict: false };
    clearTimeout(saveTimer);
    if (state.deleting || state.transferFrozen || !deps.autosave.checked || !deps.workspace.dirty()) {
      return { saved: !deps.workspace.dirty(), conflict: false };
    }
    if (state.editBlock) return { saved: false, conflict: false };
    if (saving) return saving;
    saving = (async () => {
      // E2E may delay the in-flight save so Autosave-off can race a document switch (#159 W4).
      const delayMs = testKnob('__typebridgeDelayPersistMs');
      if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      let createdConflict = false;
      /** The change-log run of the save in flight, until its outcome is reported. */
      let preparedRun: string | undefined;
      try {
        if (!state.db) throw new Error('Storage unavailable');
        while (deps.workspace.dirty() && deps.autosave.checked && !state.editBlock && !state.transferFrozen) {
          // Queued change records land first, so this save's cleanup covers every one of them.
          await deps.changes.idle();
          // Waiting yielded: Autosave may be off now, with private text typed since (#251 review).
          // Never capture text unless every saving guard still holds — including discard/takeover freeze.
          if (state.deleting || state.transferFrozen || !deps.workspace.dirty() || !deps.autosave.checked || state.editBlock) break;
          const version = deps.workspace.contentRevision();
          const saved = deps.snapshot();
          // Taken with the text and title: the row says which change records it already contains (#37 R2c).
          const log = deps.changes.upToForSave(saved.id, saved.text, saved.title);
          preparedRun = log.keepRun;
          saved.upTo = log.upTo;
          // E2e may type while the run is anchored (protects false) before the row commits (#254).
          const afterUpToMs = testKnob('__typebridgeDelayAfterUpToMs');
          if (typeof afterUpToMs === 'number' && afterUpToMs > 0) {
            await new Promise(resolve => setTimeout(resolve, afterUpToMs));
          }
          const clearPendingAfterCommit = deps.preparePendingClear(saved);
          if (state.ownership?.documentId !== saved.id) throw new EditOwnershipLostError();
          const owner = await state.ownership.writeFence();
          const current = deps.currentJournal();
          const journal = current && current.documentId === saved.id && current.revision === state.active.revision && current.text === saved.text && current.title === saved.title ? current : undefined;
          // While a cross-tab reload-discard is in flight, do not replay discarded records into a
          // "(recovered)" copy on save (#256 Codex P0). The consenting tab applies the marker.
          const changeRecovery = isReloadDiscardPendingActive(saved.id)
            ? undefined
            : { keepRun: log.keepRun, recoveryId: crypto.randomUUID() };
          const result = await commitOrCreateConflictCopy(state.db, saved, state.active.revision, crypto.randomUUID(), owner, changeRecovery);
          // A conflict copy is a new document: this document's row did not take the text.
          deps.changes.saved(log.keepRun, !result.conflict);
          preparedRun = undefined;
          clearPendingAfterCommit();
          const titleOnly = !result.conflict && saved.title !== state.active.title && saved.text === state.active.text;
          if (journal) { try { clearRecovery(localStorage, journal); } catch { /* Retain a recoverable entry on storage errors. */ } }
          state.active = result.draft;
          deps.clearVersionNotice();
          deps.postSignal(titleOnly ? 'renamed' : 'saved', result.draft.id, result.draft.revision);
          if (result.recovered) deps.onRecovered(result.recovered, result.draft.id);
          deps.writingPosition.save();
          if (deps.workspace.contentRevision() !== version && deps.autosave.checked) deps.journalEdit();
          deps.rememberActive();
          state.saveFailed = false;
          deps.workspace.setDirty(deps.workspace.contentRevision() !== version);
          deps.updateSaveIndicator();
          if (result.conflict) {
            // Conflict copy is a new document id; keep the workspace identity in sync
            // without bumping sessionGeneration mid-persist (same in-flight save stream).
            deps.workspace.setDocumentId(result.draft.id);
            // Retain new edits typed while the transaction was in flight.
            if ((deps.draftTitle.value.trim() || UNTITLED_TITLE) === saved.title) {
              deps.draftTitle.value = state.active.title;
              deps.syncTitleTooltip();
            }
            // Storage may have become unusable while the copy was written.
            createdConflict = true;
            // While switching, leave announcement to switchDraft so early returns and
            // the success path each announce once (avoids CONFLICT_COPY then LEFT).
            if (!state.transitioning) status.setConflict(CONFLICT_COPY, true);
            status.updateStatus({
              primary: deps.workspace.dirty() && !state.storageProblem ? 'Saving…' : '',
              risk: status.riskText(),
            }, state.transitioning ? status.kind() : 'conflict');
            // The copy is a new document; later saves in this loop need its fence.
            await deps.takeOwnership(result.draft.id);
          }
          // A background save must not replace newer action feedback or a conflict
          // notice, but it must replace progress and an earlier failure it resolved.
          // Use the status kind (not merely a pending conflict string) so an action that
          // kept a conflict notice — e.g. a failed draft switch — is not wiped.
          if (!deps.workspace.dirty() && !result.conflict && (status.kind() === 'progress' || status.kind() === 'failure' || status.kind() === 'conflict')) {
            // Storage can become unusable while this save was in flight (an
            // upgrade in another tab); never replace that warning.
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
        // Keep newer action feedback that already carries this exact warning;
        // keep a conflict notice in front of the warning; otherwise show risk alone.
        const risk = status.riskText() || SAVE_FAILED;
        if (status.message().primary && status.message().risk === risk) status.updateStatus({}, 'failure');
        else status.setRiskStatus('', 'failure', risk);
        return { saved: false, conflict: createdConflict };
      }
    })();
    try { return await saving; } finally {
      saving = undefined;
      // An edit can arrive while the post-commit draft list is loading.
      if (
        !state.deleting && !state.transferFrozen && deps.workspace.dirty()
        && deps.autosave.checked && !state.saveFailed && !state.editBlock
      ) {
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
    // With Autosave off nothing is committed, so refresh the Documents label from the
    // on-screen title (and mark unsaved) without waiting for a save (#114).
    if (!deps.autosave.checked && (becameDirty || fromTitle)) deps.renderDrafts();
    clearTimeout(saveTimer);
    if (deps.autosave.checked) { status.showSaving(); saveTimer = setTimeout(() => { void persist(); }, 300); }
    else status.showSaveState();
  }
  return {
    persist,
    /** Record an edit and save it after the Autosave delay (or show it is unsaved). */
    scheduleSave,
    /** Drop a pending timed save. */
    cancel(): void { clearTimeout(saveTimer); },
    /** Save after the Autosave delay, replacing a pending timed save. */
    saveSoon(): void {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persist(); }, 300);
    },
    /** The save that is running now, if any. */
    inFlight: (): Promise<SaveResult> | undefined => saving,
    /** Resolves once every queued change-log record was written or skipped (#37 R2c). */
    drainChanges: (): Promise<void> => deps.changes.idle(),
  };
}
