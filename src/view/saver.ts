/**
 * Saving the shown document (#159 W4 fence): debounced Autosave writes under this window's
 * edit ownership, conflict copies when another tab changed the document, and the status that
 * follows. One save runs at a time; later edits are saved by the same loop or the next timer.
 *
 * Write decisions use `mayWrite` (= !privateNow) from #257 — not the checkbox alone.
 */
import { sameFields, type DocumentFieldsInput } from '../editor/document-fields';
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
    upToForSave: (documentId: string, saved: DocumentFieldsInput) => { upTo: number; keepRun: string };
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

export type LastBeforePrivacyOptions = {
  /**
   * When true (per-document go-private), the committed row includes `private: true` and
   * in-memory state stays private. When false (global private session), only the frozen
   * text/title are committed — the document flag is left alone (#257 follow-up).
   */
  markPrivate: boolean;
};

export function createSaver(state: EditorState, status: StatusLine, deps: SaverDeps) {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<SaveResult> | undefined;

  /**
   * Shared IndexedDB commit + post-commit bookkeeping for ordinary persist and the last
   * pre-private / pre-session save (#257). Callers prepare `saved` (including `upTo`) and
   * own `preparedRun` reporting on failure.
   */
  async function commitPrepared(
    saved: StoredDraft,
    keepRun: string,
    options: {
      contentRevision: number;
      resolveActive: (draft: StoredDraft) => StoredDraft;
      /** Chosen after the commit so title-only can stay `saved` on conflict. */
      signal: (conflict: boolean) => DocumentSignal['type'];
      /** Re-journal when still dirty after and mayWrite (ordinary Autosave loop only). */
      journalIfStillDirty: boolean;
      /** Ordinary persist updates the Saving… primary on conflict; last-before-private does not. */
      conflictSavingStatus: boolean;
    },
  ): Promise<{ conflict: boolean }> {
    const clearPendingAfterCommit = deps.preparePendingClear(saved);
    // Privacy can change while a first save waits for its fence. A never-saved private
    // document must not be created by that already-started save (#257 step 3).
    const cancelledNewSave = (): boolean => {
      if (state.active.revision !== 0 || deps.mayWrite()) return false;
      deps.changes.saved(keepRun, false);
      return true;
    };
    if (cancelledNewSave()) return { conflict: false };
    // New private documents never claimed ownership; the first real save must claim before writing.
    if (!state.ownership && state.active.revision === 0) await deps.takeOwnership(saved.id);
    if (cancelledNewSave()) return { conflict: false };
    if (state.ownership?.documentId !== saved.id) throw new EditOwnershipLostError();
    const owner = await state.ownership.writeFence();
    if (cancelledNewSave()) return { conflict: false };
    const current = deps.currentJournal();
    const journal = current && current.documentId === saved.id && current.revision === state.active.revision
      && sameFields(current, saved) ? current : undefined;
    const result = await commitOrCreateConflictCopy(
      state.db!, saved, state.active.revision, crypto.randomUUID(), owner,
      { keepRun, recoveryId: crypto.randomUUID() },
    );
    // A conflict copy is a new document: this document's row did not take the text.
    deps.changes.saved(keepRun, !result.conflict);
    clearPendingAfterCommit();
    if (journal) { try { clearRecovery(localStorage, journal); } catch { /* Retain a recoverable entry on storage errors. */ } }
    state.active = options.resolveActive(result.draft);
    deps.clearVersionNotice();
    deps.postSignal(options.signal(result.conflict), result.draft.id, result.draft.revision);
    if (result.recovered) deps.onRecovered(result.recovered, result.draft.id);
    deps.writingPosition.save();
    if (options.journalIfStillDirty
      && deps.workspace.contentRevision() !== options.contentRevision
      && deps.mayWrite()) {
      deps.journalEdit();
    }
    // Session hint / host metadata must follow a conflict copy (#257).
    deps.rememberActive();
    state.saveFailed = false;
    deps.workspace.setDirty(deps.workspace.contentRevision() !== options.contentRevision);
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
      // While switching, leave announcement to switchDraft so early returns and
      // the success path each announce once (avoids CONFLICT_COPY then LEFT).
      if (!state.transitioning) status.setConflict(CONFLICT_COPY, true);
      if (options.conflictSavingStatus) {
        status.updateStatus({
          primary: deps.workspace.dirty() && !state.storageProblem ? 'Saving…' : '',
          risk: status.riskText(),
        }, state.transitioning ? status.kind() : 'conflict');
      }
      // The copy is a new document; later saves in this loop need its fence.
      await deps.takeOwnership(result.draft.id);
    }
    return { conflict: result.conflict };
  }

  /**
   * Last pre-privacy commit after the gate has already switched (#257).
   * Uses a frozen snapshot so later private typing cannot ride along. Ignores mayWrite
   * (already false) and may write even when clean so a per-document `private` flag becomes durable.
   * `frozenContentRevision` is the workspace content revision at the freeze moment — not
   * after awaits — so private typing during drain cannot make dirty look false.
   */
  async function persistLastBeforePrivate(
    frozen: StoredDraft,
    frozenContentRevision: number,
    options: LastBeforePrivacyOptions = { markPrivate: true },
  ): Promise<SaveResult> {
    if (deps.viewMode) return { saved: true, conflict: false };
    clearTimeout(saveTimer);
    if (state.deleting || state.editBlock) return { saved: false, conflict: false };
    if (saving) await saving;
    saving = (async () => {
      // E2E may delay the in-flight save so Autosave-off can race a document switch (#159 W4).
      const delayMs = testKnob('__typebridgeDelayPersistMs');
      if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      let createdConflict = false;
      /** The change-log run of the save in flight, until its outcome is reported. */
      let preparedRun: string | undefined;
      try {
        if (!state.db) throw new Error('Storage unavailable');
        if (state.deleting || state.editBlock) return { saved: false, conflict: false };
        await deps.changes.idle();
        if (state.deleting || state.editBlock) return { saved: false, conflict: false };
        const saved: StoredDraft = options.markPrivate
          ? { ...frozen, private: true, updatedAt: Date.now() }
          : { ...frozen, updatedAt: Date.now() };
        const log = deps.changes.upToForSave(saved.id, saved);
        preparedRun = log.keepRun;
        saved.upTo = log.upTo;
        const outcome = await commitPrepared(saved, log.keepRun, {
          contentRevision: frozenContentRevision,
          resolveActive: draft => (options.markPrivate ? { ...draft, private: true } : draft),
          signal: () => 'saved',
          journalIfStillDirty: false,
          conflictSavingStatus: false,
        });
        preparedRun = undefined;
        createdConflict = outcome.conflict;
        try { await deps.refreshDrafts(); }
        catch {
          if (status.shouldAttachDraftListRefreshFailure()) status.markDraftListRefreshFailed();
        }
        // A conflict copy still stored the frozen snapshot — treat as saved (#257 P2).
        return { saved: true, conflict: createdConflict };
      } catch (error) {
        if (preparedRun) deps.changes.saved(preparedRun, false);
        if (error instanceof EditOwnershipLostError) {
          // Going private deliberately releases an unsaved identity; this is not a competing editor.
          if (state.active.revision === 0 && !deps.mayWrite()) return { saved: false, conflict: createdConflict };
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
      // E2E may delay the in-flight save so Autosave-off can race a document switch (#159 W4).
      const delayMs = testKnob('__typebridgeDelayPersistMs');
      if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      let createdConflict = false;
      /** The change-log run of the save in flight, until its outcome is reported. */
      let preparedRun: string | undefined;
      try {
        if (!state.db) throw new Error('Storage unavailable');
        while (deps.workspace.dirty() && deps.mayWrite() && !state.editBlock) {
          // Queued change records land first, so this save's cleanup covers every one of them.
          await deps.changes.idle();
          // Waiting yielded: privacy may be on now, with private text typed since (#251 / #257).
          // Never capture text unless every saving guard still holds.
          if (state.deleting || !deps.workspace.dirty() || !deps.mayWrite() || state.editBlock) break;
          const version = deps.workspace.contentRevision();
          const saved = deps.snapshot();
          // Taken with the text and title: the row says which change records it already contains (#37 R2c).
          const log = deps.changes.upToForSave(saved.id, saved);
          preparedRun = log.keepRun;
          saved.upTo = log.upTo;
          // E2e may type while the run is anchored (protects false) before the row commits (#254).
          const afterUpToMs = testKnob('__typebridgeDelayAfterUpToMs');
          if (typeof afterUpToMs === 'number' && afterUpToMs > 0) {
            await new Promise(resolve => setTimeout(resolve, afterUpToMs));
          }
          // Title-only uses the pre-commit active title/text (same as before the shared helper).
          const titleOnlyCandidate = saved.title !== state.active.title && saved.text === state.active.text;
          const outcome = await commitPrepared(saved, log.keepRun, {
            contentRevision: version,
            // Keep an in-memory private flag across an in-flight pre-private commit (#257):
            // result.draft may still say private:false, and re-assigning that would reopen mayWrite
            // and let the loop snapshot text typed after the switch.
            resolveActive: draft => (state.active.private ? { ...draft, private: true } : draft),
            signal: conflict => (!conflict && titleOnlyCandidate ? 'renamed' : 'saved'),
            journalIfStillDirty: true,
            conflictSavingStatus: true,
          });
          preparedRun = undefined;
          if (outcome.conflict) createdConflict = true;
          // A background save must not replace newer action feedback or a conflict
          // notice, but it must replace progress and an earlier failure it resolved.
          // Use the status kind (not merely a pending conflict string) so an action that
          // kept a conflict notice — e.g. a failed draft switch — is not wiped.
          if (!deps.workspace.dirty() && !outcome.conflict
            && (status.kind() === 'progress' || status.kind() === 'failure' || status.kind() === 'conflict')) {
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
          // Going private deliberately releases an unsaved identity; this is not a competing editor.
          if (state.active.revision === 0 && !deps.mayWrite()) return { saved: false, conflict: createdConflict };
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
    // With writes gated off nothing is committed, so refresh the Documents label from the
    // on-screen title (and mark unsaved) without waiting for a save (#114 / #257).
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
