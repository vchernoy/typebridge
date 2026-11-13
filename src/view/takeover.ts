/**
 * Taking over editing (#175): become this document's editing owner after another window yields
 * (focus handoff), retry when the lock may be free, and show the Edit here bar when the other
 * window refuses. Ownership itself is acquired and installed by view/edit-access.ts.
 */
import { UNTITLED_TITLE } from '../editor/drafts';
import type { Editor, EditorHistory } from '../editor/editor';
import { getStoredDraft, type StoredDraft } from '../editor/indexeddb';
import { documentAutosaveChecked } from '../editor/privacy';
import type { EditAccessControl } from './edit-access';
import type { EditorState } from './editor-state';
import type { FocusHandoffController } from './focus-handoff';
import { handoffRefuseGuidance, mapSelectionAcrossTextChange, type HandoffRefuseReason, type HandoffSnapshot } from './handoff';
import { mayRetryEditOwnership } from './ownership';
import type { createSinglePaneWorkspace } from './workspace';

export type TakeoverDeps = {
  viewMode: boolean;
  field: HTMLTextAreaElement;
  draftTitle: HTMLInputElement;
  editor: Editor;
  workspace: ReturnType<typeof createSinglePaneWorkspace>;
  autosave: HTMLInputElement;
  privateMarker: HTMLElement;
  writingPosition: { save: () => void };
  editHereBar: HTMLElement;
  editHereWarning: HTMLElement;
  editAccess: Pick<EditAccessControl, 'acquireFor' | 'installOwnership' | 'freezeEditorsForTransition' | 'unfreezeEditorsAfterTransition'>;
  focusHandoff: () => FocusHandoffController | undefined;
  showDraft: () => void;
  syncTitleTooltip: () => void;
  updateSaveIndicator: () => void;
  saveSoon: () => void;
  /** Editing moved to this window: show the save state and finish a pending control. */
  onEditableHere: () => void;
  rereadDisplayed: () => Promise<void>;
  markDeletedElsewhere: () => void;
};

export function createTakeover(state: EditorState, deps: TakeoverDeps) {
  const {
    viewMode, field, draftTitle, editor, workspace, autosave, privateMarker, writingPosition, editHereBar, editHereWarning,
    showDraft, syncTitleTooltip, updateSaveIndicator, saveSoon, onEditableHere, rereadDisplayed, markDeletedElsewhere,
  } = deps;
  const { acquireFor, installOwnership, freezeEditorsForTransition, unfreezeEditorsAfterTransition } = deps.editAccess;
  function captureHandoffSnapshot(): HandoffSnapshot {
    return {
      text: field.value,
      title: draftTitle.value.trim() || UNTITLED_TITLE,
      history: editor.exportHistory(),
      dirty: workspace.dirty(),
      private: state.active.private === true,
      revision: state.active.revision,
    };
  }
  function mirrorPrivacyChrome(): void {
    autosave.checked = documentAutosaveChecked(state.active);
    privateMarker.hidden = autosave.checked;
  }
  let editHereReason: HandoffRefuseReason | undefined;
  let editHereDocumentId: string | undefined;
  function hideEditHereBar(): void {
    editHereBar.hidden = true;
    editHereWarning.textContent = '';
    editHereReason = undefined;
    editHereDocumentId = undefined;
  }
  function showEditHereBar(reason: HandoffRefuseReason): void {
    editHereReason = reason;
    editHereDocumentId = state.active.id;
    editHereWarning.textContent = handoffRefuseGuidance(reason);
    editHereBar.hidden = false;
  }
  /**
   * After a cooperative yield (or steal), become the editing owner.
   * Same-tab may supply an in-memory snapshot; otherwise reread IndexedDB.
   */
  async function takeOverFromHandoff(input: {
    documentId: string;
    snapshot: HandoffSnapshot | undefined;
    selectionStart: number;
    selectionEnd: number;
    fromText: string;
    steal: boolean;
  }): Promise<boolean> {
    if (viewMode || !state.db || state.transitioning || state.deleting) return false;
    if (state.active.id !== input.documentId) return false;
    freezeEditorsForTransition();
    try {
      if (state.active.id !== input.documentId) {
        unfreezeEditorsAfterTransition();
        return false;
      }
      const access = await acquireFor(input.documentId, { steal: input.steal });
      if (!access.ownership) {
        unfreezeEditorsAfterTransition();
        return false;
      }
      if (state.active.id !== input.documentId) {
        void access.ownership.release();
        unfreezeEditorsAfterTransition();
        return false;
      }
      // After consent (before the request), always install the owner's state — never keep
      // this window's prior dirty text across a successful takeover.
      if (input.snapshot) {
        writingPosition.save();
        state.active = {
          ...state.active,
          text: input.snapshot.text,
          title: input.snapshot.title,
          history: input.snapshot.history as EditorHistory | undefined,
          revision: input.snapshot.revision,
          // Carry the source document flag — never invent private from dirty (#257 P1).
          private: input.snapshot.private,
        };
        state.suppressEditTracking = true;
        try {
          field.value = input.snapshot.text;
          draftTitle.value = input.snapshot.title;
          syncTitleTooltip();
          if (input.snapshot.history) editor.restoreHistory(input.snapshot.history as EditorHistory);
          else editor.restoreHistory(undefined);
        } finally {
          state.suppressEditTracking = false;
        }
        workspace.setDirty(input.snapshot.dirty);
        workspace.setDocumentId(state.active.id);
      } else {
        try {
          const fresh = await getStoredDraft(state.db, input.documentId);
          if (fresh === undefined) {
            void access.ownership.release();
            unfreezeEditorsAfterTransition();
            return false;
          }
          if (fresh) {
            writingPosition.save();
            state.active = fresh;
            showDraft();
          }
        } catch {
          void access.ownership.release();
          unfreezeEditorsAfterTransition();
          return false;
        }
      }
      installOwnership(access);
      // Mirror chrome from document flag + current session; dirty alone must not force private (#257).
      if (input.snapshot) {
        mirrorPrivacyChrome();
        updateSaveIndicator();
      }
      const mapped = mapSelectionAcrossTextChange(
        input.fromText,
        field.value,
        input.selectionStart,
        input.selectionEnd,
      );
      field.setSelectionRange(mapped.start, mapped.end);
      unfreezeEditorsAfterTransition();
      // Only schedule save for non-private takeovers (saved reread / clean yield).
      if (workspace.dirty() && autosave.checked && !state.active.private && !input.snapshot?.dirty) {
        saveSoon();
      }
      return true;
    } catch {
      unfreezeEditorsAfterTransition();
      return false;
    }
  }
  let ownershipRetry: Promise<void> | undefined;
  /** A BroadcastChannel reread arrived while ownershipRetry held the transition; run after it finishes. */
  let rereadAfterOwnershipRetry = false;
  /**
   * A read-only ordinary window tries again when shown or focused; it becomes editor only if the lock is free.
   * Always rereads first (single-flight with the acquire): a concurrent refresh must not bump sessionGeneration
   * under an in-flight acquire and force a release that leaves the window stuck read-only.
   */
  function retryOwnership(): void {
    const store = state.db;
    if (deps.focusHandoff()?.pending()) return;
    if (viewMode || !store || !mayRetryEditOwnership(state.editBlock) || ownershipRetry || state.transitioning || state.deleting || field.disabled) return;
    ownershipRetry = (async () => {
      await rereadDisplayed();
      if (!mayRetryEditOwnership(state.editBlock) || state.transitioning || state.deleting || field.disabled) return;
      const id = state.active.id;
      // Capture the view only after the preliminary reread so applying a missed revision does not
      // look like "the user navigated away" to stillHere().
      const view = workspace.sessionGeneration();
      const stillHere = (): boolean => state.active.id === id && workspace.sessionGeneration() === view && !state.transitioning && !state.deleting && mayRetryEditOwnership(state.editBlock);
      if (!stillHere()) return;
      const access = await acquireFor(id);
      if (!access.ownership) return;
      // null = skipped (dirty); undefined = authoritative absence after a clean reread.
      let fresh: StoredDraft | undefined | null = null;
      try { if (stillHere() && !workspace.dirty()) fresh = await getStoredDraft(store, id); }
      catch { void access.ownership.release(); return; }
      if (!stillHere()) { void access.ownership.release(); return; }
      if (fresh === undefined) {
        // Another window deleted this row and released the lock; do not edit a ghost snapshot.
        void access.ownership.release();
        if (state.active.revision >= 1) markDeletedElsewhere();
        return;
      }
      // Authoritative snapshot under the new fence; unsaved text in memory is never replaced.
      // Always install when clean: Delete saved copy can recreate the same revision with new content.
      if (fresh) {
        writingPosition.save();
        state.active = fresh;
        showDraft();
      }
      installOwnership(access);
      onEditableHere();
      if (workspace.dirty() && autosave.checked && !state.active.private) { saveSoon(); }
    })().finally(() => {
      ownershipRetry = undefined;
      if (!rereadAfterOwnershipRetry) return;
      rereadAfterOwnershipRetry = false;
      void rereadDisplayed();
    });
  }
  /** Edit here clicked: ask the editing window to hand over (stealing when it cannot answer). */
  function editHere(): void {
    if (editHereDocumentId && state.active.id !== editHereDocumentId) {
      hideEditHereBar();
      return;
    }
    // Explicit Edit here is consent: steal for unresponsive or cross-tab private warnings.
    const steal = editHereReason === 'unresponsive'
      || editHereReason === 'cross-tab-private'
      || editHereReason === 'private';
    hideEditHereBar();
    deps.focusHandoff()?.requestHandoff({ steal });
  }

  return {
    captureHandoffSnapshot,
    hideEditHereBar,
    showEditHereBar,
    editHere,
    takeOverFromHandoff,
    retryOwnership,
    ownershipRetryPending: (): boolean => !!ownershipRetry,
    /** A BroadcastChannel reread arrived during a retry; run it once the retry finishes. */
    rereadAfterOwnershipRetry(): void { rereadAfterOwnershipRetry = true; },
  };
}
