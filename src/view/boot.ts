/**
 * Startup of an editing window: open storage, choose which document to show, take edit
 * ownership of it under the fence, restore unsaved reload text, then enable editing. The
 * choice itself is the pure `chooseBootDocument`, so its rules are unit-tested.
 */
import { readActiveDraftId } from '../editor/drafts';
import { getStoredDraft, listStoredDrafts, openDraftDatabase, type StoredDraft } from '../editor/indexeddb';
import { STORAGE_UNAVAILABLE } from '../editor/status';
import type { StatusLine } from '../ui/status-line';
import type { EditAccess } from './documents';
import type { EditorState } from './editor-state';
import { sameContent } from './reload-backup';
import { isDocumentId } from './route';
import type { SaveResult } from './saver';
import type { Workspace } from './workspace';

export type BootChoiceInput = {
  /** Saved documents, newest first. */
  drafts: StoredDraft[];
  /** This window's remembered document id (session), or a `?doc=` id from the host. */
  selected: string | null;
  /** The reload backup, if any. */
  pending: StoredDraft | undefined;
  /** A host window other than the first one. */
  secondaryHostWindow: boolean;
  /** A new, unsaved document with a distinct Untitled name. */
  allocateNew: () => StoredDraft;
  /** The placeholder shown before boot (used when there are no documents). */
  fallback: StoredDraft;
};

export type BootChoice = { chosen: StoredDraft; restorePending: boolean; clearPendingCopy: boolean };

/**
 * Which document a window opens at startup:
 * - a reload backup that differs from its saved row wins (restore unsaved text);
 * - else the remembered/linked document when it is saved;
 * - else, in a secondary host window, a fresh document (keeping a remembered unsaved id), so
 *   it does not take over the document the first window is editing;
 * - else the newest saved document, else the placeholder.
 */
export function chooseBootDocument(input: BootChoiceInput): BootChoice {
  const { drafts, selected, pending } = input;
  const committed = pending && drafts.find(d => d.id === pending.id);
  const clearPendingCopy = !!(pending && committed && sameContent(pending, committed));
  const restorePending = !!pending && (!committed || !sameContent(pending, committed));
  const listed = selected ? drafts.find(d => d.id === selected) : undefined;
  const openFresh = input.secondaryHostWindow && !listed && !restorePending;
  const chosen = restorePending
    ? pending!
    : listed
      ?? (openFresh
        ? (() => {
            // Distinct Untitled defaults across host windows (#175 step 8).
            const fresh = input.allocateNew();
            return selected && isDocumentId(selected) ? { ...fresh, id: selected } : fresh;
          })()
        : drafts[0])
      ?? input.fallback;
  return { chosen, restorePending, clearPendingCopy };
}

export type BootDeps = {
  embedded: boolean;
  windowId: string | undefined;
  autosave: HTMLInputElement;
  field: HTMLTextAreaElement;
  draftSelect: HTMLSelectElement;
  draftTitle: HTMLInputElement;
  workspace: Workspace;
  writingPosition: { restore: (id: string) => void; prune: (ids: Iterable<string>) => void };
  ownerReady: Promise<void>;
  onDatabaseUpgrade: () => void;
  readPending: () => StoredDraft | undefined;
  clearPending: (saved: StoredDraft) => void;
  allocateNewDraft: () => StoredDraft;
  acquireFor: (documentId: string) => Promise<EditAccess>;
  installOwnership: (access: EditAccess) => void;
  applyEditAccess: () => void;
  rememberActive: () => void;
  showDraft: (options?: { restorePosition?: boolean }) => void;
  renderDrafts: () => void;
  updateStats: () => void;
  persist: () => Promise<SaveResult>;
  restoreFocusMode: () => void;
  renderRecovery: () => Promise<void>;
  finishInitialization: () => void;
};

export async function initializeDrafts(state: EditorState, status: StatusLine, deps: BootDeps): Promise<void> {
  await deps.ownerReady;
  let shown = false;
  let bootAccess: EditAccess | undefined;
  try {
    state.db = await openDraftDatabase(deps.onDatabaseUpgrade);
    state.drafts = await listStoredDrafts(state.db);
    let selected: string | null = null;
    try { selected = readActiveDraftId(); } catch { /* Optional hint. */ }
    // #175 host restores each window with ?doc= when session hints are cold (fresh tab).
    if (!selected) {
      try {
        const doc = new URLSearchParams(window.location.search).get('doc');
        if (doc && isDocumentId(doc)) selected = doc;
      } catch { /* Malformed search — fall through. */ }
    }
    const pending = deps.readPending();
    // A new host window must not inherit main's drafts[0] — that steals ownership and
    // makes "Saved" text disappear when the primary window still owns the document.
    // Also: session may already hold a never-saved blank id from rememberActive(); if that
    // id is not in IndexedDB yet, keep a fresh document instead of falling through to drafts[0].
    const choice = chooseBootDocument({
      drafts: state.drafts,
      selected,
      pending,
      secondaryHostWindow: deps.embedded && !!deps.windowId && deps.windowId !== 'main',
      allocateNew: deps.allocateNewDraft,
      fallback: state.active,
    });
    if (choice.clearPendingCopy && pending) deps.clearPending(pending);
    const { restorePending } = choice;
    let chosen = choice.chosen;
    // A fresh blank document (new host window) is not stored yet; only a stored one can vanish.
    const chosenWasStored = state.drafts.some(draft => draft.id === chosen.id);
    // First acquirer among cooperating windows edits; the others open this document read-only.
    bootAccess = await deps.acquireFor(chosen.id);
    // The list was read before this window owned the document; reread under the fence.
    if (bootAccess.ownership && !restorePending) {
      const fresh = await getStoredDraft(state.db, chosen.id);
      if (!fresh && chosenWasStored) {
        // Deleted while we acquired — do not install ownership over the stale list snapshot.
        void bootAccess.ownership.release();
        bootAccess = undefined;
        chosen = deps.allocateNewDraft();
        bootAccess = await deps.acquireFor(chosen.id);
      } else if (fresh) {
        chosen = fresh;
      }
    }
    state.active = chosen;
    deps.rememberActive();
    deps.showDraft({ restorePosition: false });
    shown = true;
    deps.writingPosition.prune([...state.drafts.map(draft => draft.id), state.active.id]);
    deps.installOwnership(bootAccess);
    bootAccess = undefined;
    if (restorePending) {
      deps.workspace.setDirty(true); deps.workspace.bumpContentRevision();
      deps.applyEditAccess();
      // Another window owns the document: keep the recovered text here (and its reload backup) for copy/export.
      if (state.editBlock) status.setSaveStatus('Recovered unsaved text, but another window is editing this document, so it was not saved. Copy or export it.', 'failure');
      else if (deps.autosave.checked) { status.setSaveStatus('Recovered unsaved text; saving…'); await deps.persist(); }
      else status.setSaveStatus('Recovered unsaved text; autosave is off');
    } else if (state.editBlock) status.showSaveState();
  } catch (error) {
    void bootAccess?.ownership?.release();
    state.db?.close(); state.db = undefined;
    const pending = deps.readPending();
    if (pending) { state.active = pending; deps.showDraft({ restorePosition: false }); shown = true; deps.workspace.setDirty(true); deps.workspace.bumpContentRevision(); state.saveFailed = true; }
    state.storageProblem = error instanceof Error && error.message.startsWith('Database upgrade blocked.') ? error.message : STORAGE_UNAVAILABLE;
    status.setSaveStatus(state.storageProblem, 'failure');
    deps.renderDrafts();
  } finally {
    if (!shown) deps.updateStats();
  }
  deps.field.disabled = false;
  deps.draftSelect.disabled = false;
  deps.draftTitle.disabled = false;
  deps.applyEditAccess();
  // Focus mode must restore after the textarea is enabled — focus() is a no-op while disabled.
  deps.restoreFocusMode();
  deps.writingPosition.restore(state.active.id);
  void deps.renderRecovery();
  deps.finishInitialization();
}
