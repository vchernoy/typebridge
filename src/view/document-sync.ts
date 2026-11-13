/**
 * Cross-window document sync (#159 W3, #175): saved/renamed/deleted signals over a
 * BroadcastChannel (ids and revisions only), the authoritative reread they trigger, the
 * "newer version elsewhere" notice, and the deleted-elsewhere state with Keep as new document.
 */
import type { Editor } from '../editor/editor';
import { getStoredDraft, type StoredDraft } from '../editor/indexeddb';
import type { StatusLine } from '../ui/status-line';
import type { EditAccess } from './documents';
import type { EditorState } from './editor-state';
import { mayRetryEditOwnership } from './ownership';
import type { SaveResult } from './saver';
import { DOCUMENT_SIGNAL_CHANNEL, createDocumentSignal, decideReread, parseDocumentSignal, shouldApplyDocumentSignal, type DocumentSignal } from './signals';
import type { Workspace } from './workspace';

export type DocumentSyncDeps = {
  captureFields?: () => Pick<StoredDraft, 'find' | 'replace' | 'titleHistory' | 'findHistory' | 'replaceHistory'>;
  viewMode: boolean;
  field: HTMLTextAreaElement;
  draftTitle: HTMLInputElement;
  editor: Editor;
  workspace: Workspace;
  /** False while privateNow() — prefer over reading the checkbox (#257). */
  mayWrite: () => boolean;
  writingPosition: { save: () => void };
  saver: { inFlight: () => Promise<SaveResult> | undefined };
  viewer: { documentId: () => string | undefined; showDocument: (draft: StoredDraft) => void; showMissing: (message: string) => void; MISSING: string };
  focusHandoff: () => { cancel: () => void; pending: () => boolean } | undefined;
  hideEditHereBar: () => void;
  applyEditAccess: () => void;
  deletedBar: () => HTMLElement;
  allocateNewDraft: (text?: string) => StoredDraft;
  acquireFor: (documentId: string) => Promise<EditAccess>;
  showDraft: () => void;
  installOwnership: (access: EditAccess) => void;
  rememberActive: () => void;
  /** Apply keys held while a deleted document is kept as a new one. */
  drainDeletedInput: () => void;
  refreshDrafts: () => Promise<void>;
  persist: () => Promise<SaveResult>;
  quietReader: () => boolean;
  retryOwnership: () => void;
  /** An ownership retry holds the transition; rereads wait for it. */
  ownershipRetryPending: () => boolean;
  rereadAfterOwnershipRetry: () => void;
};

export function createDocumentSync(state: EditorState, status: StatusLine, deps: DocumentSyncDeps) {
  // Cross-window saved-version signals (#159 W3). Messages carry only ids/revisions; every
  // receiver rereads IndexedDB, and handlers never save, so signals cannot loop.
  const signalChannel: BroadcastChannel | undefined = (() => {
    try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(DOCUMENT_SIGNAL_CHANNEL) : undefined; }
    catch { return undefined; }
  })();
  function postSignal(type: DocumentSignal['type'], documentId: string, revision: number): void {
    if (deps.viewMode || !signalChannel) return;
    try { signalChannel.postMessage(createDocumentSignal(type, documentId, revision, Date.now())); }
    catch { /* Signals are advisory; reconcile on focus covers a missed one. */ }
  }
  const versionNotice = document.querySelector<HTMLElement>('#version-notice')!;
  const NEWER_VERSION_NOTICE = 'A newer saved version of this document exists in another window. Your text here has not been changed.';
  /**
   * The displayed document was deleted in another window or tab. This window holds the
   * last copy of its text: offer Keep as new document / Close, never a takeover (there is
   * no owner left to hand over), and treat typing as Keep (#175 follow-up).
   */
  function markDeletedElsewhere(): void {
    if (deps.viewMode) return;
    state.deletedElsewhere = true;
    deps.focusHandoff()?.cancel();
    deps.hideEditHereBar();
    clearVersionNotice();
    deps.deletedBar().hidden = false;
    deps.applyEditAccess();
    status.setSaveStatus('Deleted in another window — keep it as a new document or close it.');
  }
  function clearDeletedElsewhere(): void {
    const bar = deps.deletedBar();
    if (!state.deletedElsewhere && bar.hidden) return;
    state.deletedElsewhere = false;
    bar.hidden = true;
  }
  let keepingDeleted: Promise<boolean> | undefined;
  /** Save the text shown here as a new document that this window edits. */
  function keepDeletedAsNew(): Promise<boolean> {
    if (keepingDeleted) return keepingDeleted;
    keepingDeleted = (async () => {
      if (!state.deletedElsewhere || deps.viewMode || state.transitioning) return false;
      // Reserve the transition so Close / New / the picker cannot switch documents while the
      // copy takes ownership (they no-op while transitioning).
      const originalId = state.active.id;
      state.transitioning = true;
      const copy = deps.allocateNewDraft(deps.field.value);
      const title = deps.draftTitle.value.trim();
      if (title) copy.title = title;
      copy.history = deps.editor.exportHistory();
      Object.assign(copy, deps.captureFields?.());
      const start = deps.field.selectionStart;
      const end = deps.field.selectionEnd;
      const access = await deps.acquireFor(copy.id);
      if (!access.ownership) {
        state.transitioning = false;
        status.announceAction('Could not keep this document here — your text is still shown; copy or export it.', { kind: 'failure' });
        return false;
      }
      if (state.active.id !== originalId || !state.deletedElsewhere) {
        void access.ownership.release();
        state.transitioning = false;
        return false;
      }
      deps.writingPosition.save();
      state.active = copy;
      clearDeletedElsewhere();
      deps.showDraft();
      deps.installOwnership(access);
      try { deps.field.setSelectionRange(start, end); } catch { /* Field not focusable. */ }
      deps.workspace.setDirty(true);
      deps.workspace.bumpContentRevision();
      deps.rememberActive();
      state.transitioning = false;
      // Apply keys held while the copy was made before anything else can edit (keeps order).
      deps.drainDeletedInput();
      void deps.refreshDrafts().catch(() => { /* The list refreshes on next open. */ });
      if (deps.mayWrite()) {
        const result = await deps.persist();
        status.announceAction(result.saved ? 'Kept as a new document.' : 'Kept as a new document; it is not saved yet.');
      } else {
        status.announceAction('Kept as a new document. Autosave is off, so it is not saved yet.');
      }
      return true;
    })().finally(() => {
      keepingDeleted = undefined;
      if (state.transitioning && state.deletedElsewhere) state.transitioning = false;
    });
    return keepingDeleted;
  }
  let primaryVersionNotice = '';
  function syncVersionNoticeDisplay(): void {
    const text = primaryVersionNotice;
    if (!text) {
      if (versionNotice.hidden && !versionNotice.textContent) return;
      versionNotice.hidden = true;
      versionNotice.textContent = '';
      return;
    }
    if (versionNotice.textContent !== text) versionNotice.textContent = text;
    versionNotice.hidden = false;
  }
  function showVersionNotice(text: string): void {
    primaryVersionNotice = text;
    syncVersionNoticeDisplay();
  }
  function clearVersionNotice(): void {
    primaryVersionNotice = '';
    syncVersionNoticeDisplay();
  }
  const representedId = (): string | undefined => deps.viewMode ? deps.viewer.documentId() : state.active.id;
  let rereadSeq = 0;
  /** Authoritative reread of the displayed document; signals and focus only decide when to run it. */
  /** A signal or focus arrived while the window was still loading; reread once it has. */
  let rereadAfterInit = false;
  function finishInitialization(): void {
    if (!rereadAfterInit) return;
    rereadAfterInit = false;
    void rereadDisplayed();
  }
  async function rereadDisplayed(): Promise<void> {
    if (deps.field.disabled) { rereadAfterInit = true; return; }
    if (!state.db || state.loadingDraft) return;
    // A local commit may be mid-flight; wait so the displayed revision is current.
    while (!deps.viewMode && deps.saver.inFlight()) await deps.saver.inFlight()!.catch(() => undefined);
    const id = representedId();
    if (!id) return;
    const generationAtStart = deps.workspace.sessionGeneration();
    const seq = ++rereadSeq;
    let stored: StoredDraft | undefined;
    try { stored = await getStoredDraft(state.db, id); } catch { return; }
    if (seq !== rereadSeq || generationAtStart !== deps.workspace.sessionGeneration() || representedId() !== id) return;
    if (!deps.viewMode && deps.saver.inFlight()) { void rereadDisplayed(); return; }
    // A clean read-only ordinary window follows the saved version like a viewer; unsaved text is never replaced.
    const reader = !deps.viewMode && state.editBlock !== '' && !deps.workspace.dirty();
    const action = decideReread({
      role: deps.viewMode || reader ? 'viewer' : 'editor',
      displayedRevision: state.active.revision,
      displayedUpdatedAt: state.active.updatedAt,
      stored,
    });
    if (action === 'refresh' && stored) {
      deps.writingPosition.save();
      if (deps.viewMode) {
        deps.viewer.showDocument(stored);
        status.setSaveStatus('Updated to the latest saved version. Nothing is saved from this window.');
      } else {
        state.active = stored;
        deps.showDraft();
        deps.applyEditAccess();
        if (deps.quietReader()) status.showSaveState();
        else status.setSaveStatus('Updated to the latest saved version. ' + status.readOnlyStatus());
      }
      scheduleListRefresh();
    } else if (action === 'missing') {
      if (deps.viewMode) deps.viewer.showMissing(deps.viewer.MISSING);
      else if (state.active.revision >= 1) markDeletedElsewhere();
      scheduleListRefresh();
    } else if (action === 'notice-newer') showVersionNotice(NEWER_VERSION_NOTICE);
    else if (action === 'notice-deleted') markDeletedElsewhere();
  }
  let listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleListRefresh(): void {
    if (!deps.viewMode || !state.db) return;
    clearTimeout(listRefreshTimer);
    listRefreshTimer = setTimeout(() => { void deps.refreshDrafts().catch(() => { /* The list is advisory in a read-only view. */ }); }, 250);
  }
  signalChannel?.addEventListener('message', event => {
    const signal = parseDocumentSignal(event.data);
    if (!signal) return;
    // While loading, `active` is not the represented document yet; reread once it is.
    if (deps.field.disabled) { rereadAfterInit = true; return; }
    scheduleListRefresh();
    if (shouldApplyDocumentSignal(signal, representedId() ?? '', state.active.revision, deps.viewMode && state.viewMissing)) {
      // Do not bump sessionGeneration under an in-flight ownership acquire (stillHere would release).
      if (deps.ownershipRetryPending()) deps.rereadAfterOwnershipRetry();
      else void rereadDisplayed();
    }
  });
  function reconcileSignals(): void {
    if (document.visibilityState !== 'visible') return;
    scheduleListRefresh();
    // Readers: single-flight reread+acquire. Owners/viewers: still reread so missed signals surface.
    if (mayRetryEditOwnership(state.editBlock)) deps.retryOwnership();
    else void rereadDisplayed();
  }
  // #175 step 4: pointer on a read-only field runs cooperative handoff (steal only via Edit here).
  // Plain retry still runs for visibility/window focus when the lock was freed without a handoff.
  deps.field.addEventListener('focus', () => {
    if (deps.focusHandoff()?.pending()) return;
    if (state.editBlock === 'busy' || state.editBlock === 'lost' || state.editBlock === 'error') return;
    deps.retryOwnership();
  });
  window.addEventListener('focus', reconcileSignals);
  document.addEventListener('visibilitychange', reconcileSignals);
  return {
    postSignal,
    markDeletedElsewhere,
    clearDeletedElsewhere,
    keepDeletedAsNew,
    /** A Keep as new document is in progress. */
    isKeepingDeleted: (): boolean => !!keepingDeleted,
    clearVersionNotice,
    /** Re-apply the newer-version notice to the shown pane. */
    syncVersionNoticeDisplay,
    finishInitialization,
    rereadDisplayed,
    reconcileSignals,
    /** Signals arrive over BroadcastChannel (false: focus/visibility rereads only). */
    hasChannel: !!signalChannel,
  };
}
