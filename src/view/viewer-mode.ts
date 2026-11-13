/**
 * Comparison viewer (#159 W2): a read-only window that shows the last saved version of one
 * document (`/editor.html?doc=…&mode=view`). It never saves; it can switch to other saved
 * documents and shows a missing state when the document is gone or the link is invalid.
 */
import { newDraft } from '../editor/drafts';
import type { Editor } from '../editor/editor';
import { getStoredDraft, listStoredDrafts, openDraftDatabase, type StoredDraft } from '../editor/indexeddb';
import { STORAGE_UNAVAILABLE, type StatusKind } from '../editor/status';
import type { EditorState } from './editor-state';
import { comparisonViewerHref } from './route';
import type { Workspace } from './workspace';

export type ViewerDeps = {
  clearSearch?: () => void;
  field: HTMLTextAreaElement;
  draftTitle: HTMLInputElement;
  draftSelect: HTMLSelectElement;
  editor: Editor;
  workspace: Workspace;
  saveIndicator: HTMLElement;
  autosave: HTMLInputElement;
  windowId: string | undefined;
  /** The document id from the link (undefined when the link has none or is invalid). */
  requestedViewId: string | undefined;
  writingPosition: { save: () => void; restore: (id: string) => void; prune: (ids: Iterable<string>) => void };
  syncTitleTooltip: () => void;
  showDraft: (options?: { restorePosition?: boolean }) => void;
  renderDrafts: () => void;
  refreshDrafts: () => Promise<void>;
  updateStats: () => void;
  setSaveStatus: (text: string, kind?: Exclude<StatusKind, 'action'>) => void;
  restoreFocusMode: () => void;
  finishInitialization: () => void;
  onDatabaseUpgrade: () => void;
};

export function createViewerMode(state: EditorState, deps: ViewerDeps) {
  const viewerBadge = document.querySelector<HTMLElement>('#viewer-badge')!;
  const viewerNotice = document.querySelector<HTMLElement>('#viewer-notice')!;
  const VIEWER_STATUS = 'Read-only view of the saved version. Nothing is saved from this window.';
  const VIEWER_MISSING = 'This saved document is no longer available, or the link is not valid. Choose another saved document from Documents. Nothing was created.';
  const VIEWER_STORAGE = 'Browser storage is unavailable in this window, so the saved document cannot be shown. Nothing was changed.';
  const VIEWER_DISABLED_CONTROLS = ['rename-draft', 'new-draft', 'import-draft', 'delete-draft', 'open-comparison', 'undo', 'redo',
    'convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'];
  /** Controls that only make sense while a saved document is shown. */
  const VIEWER_NEEDS_DOCUMENT = ['export-txt', 'export-json', 'copy'];
  function applyViewerChrome(): void {
    document.body.classList.add('viewer');
    document.documentElement.dataset.role = 'viewer';
    document.title = 'Comparison · TypeBridge';
    deps.saveIndicator.hidden = true;
    viewerBadge.hidden = false;
    deps.field.readOnly = true;
    deps.draftTitle.readOnly = true;
    deps.autosave.disabled = true;
    for (const id of VIEWER_DISABLED_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = true;
  }
  function showViewerStatus(): void {
    if (state.storageProblem) deps.setSaveStatus(state.storageProblem, 'failure');
    else deps.setSaveStatus(state.viewMissing ? '' : VIEWER_STATUS);
  }
  function showViewerMissing(message: string): void {
    deps.workspace.bumpSessionGeneration();
    deps.workspace.setDocumentId('');
    state.viewMissing = true;
    state.loadingDraft = true;
    try { deps.editor.load(''); deps.draftTitle.value = ''; deps.syncTitleTooltip(); }
    finally { state.loadingDraft = false; }
    state.active = { ...newDraft(), revision: 0 };
    deps.clearSearch?.();
    deps.workspace.setDirty(false);
    viewerNotice.textContent = message;
    viewerNotice.hidden = false;
    viewerBadge.textContent = 'Read-only comparison view';
    for (const id of VIEWER_NEEDS_DOCUMENT) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = true;
    deps.renderDrafts();
    deps.updateStats();
    showViewerStatus();
  }
  function showViewerDocument(draft: StoredDraft, restorePosition = true): void {
    state.viewMissing = false;
    state.active = draft;
    deps.showDraft({ restorePosition });
    viewerNotice.hidden = true;
    viewerNotice.textContent = '';
    viewerBadge.textContent = 'Saved version · Read-only';
    viewerBadge.dataset.revision = String(draft.revision);
    viewerBadge.title = `Saved revision ${draft.revision}`;
    for (const id of VIEWER_NEEDS_DOCUMENT) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = false;
    showViewerStatus();
  }
  function syncViewerUrl(id: string): void {
    // Preserve ?window= so a viewer iframe keeps scoped sessionStorage across doc switches (#175).
    const href = comparisonViewerHref(import.meta.env.BASE_URL || '/', id, deps.windowId);
    if (!href) return;
    // Keep the hash: it is reserved for portable share links (#39).
    try { history.replaceState(null, '', href + window.location.hash); } catch { /* The address bar is optional. */ }
  }
  // Keep the requested identity while the missing screen clears the displayed snapshot.
  let requestedId = deps.requestedViewId;
  let viewerLoad = 0;
  async function viewerOpen(id: string): Promise<void> {
    const load = ++viewerLoad;
    deps.workspace.bumpSessionGeneration();
    try {
      if (!state.db) throw new Error('Storage unavailable');
      const next = await getStoredDraft(state.db, id);
      if (load !== viewerLoad) return;
      // Commit identity only after the read succeeds; a failed navigation still represents the old view.
      requestedId = id;
      if (!next || next.revision < 1) {
        showViewerMissing(VIEWER_MISSING);
        // Keep the address on the requested id so a reload shows the same missing state.
        syncViewerUrl(id);
      } else {
        deps.writingPosition.save();
        showViewerDocument(next);
        syncViewerUrl(next.id);
      }
    } catch {
      if (load !== viewerLoad) return;
      deps.renderDrafts();
      deps.setSaveStatus('Could not open that document. The document shown is unchanged.', 'failure');
      return;
    }
    void deps.refreshDrafts().catch(() => { /* The list is advisory in a read-only view. */ });
  }
  async function initializeViewer(): Promise<void> {
    applyViewerChrome();
    try {
      state.db = await openDraftDatabase(deps.onDatabaseUpgrade);
      // Only the requested id is loaded for display; the list feeds the Documents menu.
      const requested = deps.requestedViewId ? await getStoredDraft(state.db, deps.requestedViewId) : undefined;
      state.drafts = await listStoredDrafts(state.db);
      if (requested && requested.revision >= 1) showViewerDocument(requested, false);
      else showViewerMissing(VIEWER_MISSING);
      deps.writingPosition.prune(state.drafts.map(draft => draft.id));
    } catch (error) {
      state.db?.close(); state.db = undefined;
      state.storageProblem = error instanceof Error && error.message.startsWith('Database upgrade blocked.') ? error.message : STORAGE_UNAVAILABLE;
      showViewerMissing(VIEWER_STORAGE);
    } finally {
      deps.field.disabled = false; deps.draftSelect.disabled = false; deps.draftTitle.disabled = false;
      deps.restoreFocusMode();
      if (!state.viewMissing) deps.writingPosition.restore(state.active.id);
      deps.finishInitialization();
    }
  }
  return {
    documentId: (): string | undefined => requestedId,
    /** Show another saved document (Documents picker). */
    open: viewerOpen,
    initialize: initializeViewer,
    showDocument: showViewerDocument,
    showMissing: showViewerMissing,
    MISSING: VIEWER_MISSING,
  };
}
