import { setupAppearance } from './ui/appearance';
import { setupResetSettings } from './ui/reset-settings';
import { watchForUpdates } from './ui/update-notice';
import { SHORTCUTS } from './editor/keyboard-shortcuts';
import { setupKeyboardShortcuts } from './ui/keyboard-shortcuts';
import './style.css';
import { Editor } from './editor/editor';
import { indentEdit } from './editor/indent';
import { AUTOSAVE_OFF, CONFLICT_COPY, CONFLICT_COPY_LEFT, statusLineParts, withDraftListRefreshFailure, type StatusMessage } from './editor/status';
import { draftOptionLabel } from './editor/draft-list';
import { UNTITLED_TITLE, autosaveEnabled, newDraft, setActiveDraftId, setAutosaveEnabled } from './editor/drafts';
import { askConfirmChoice } from './ui/confirm-dialog';
import { openDraftDatabase, listStoredDrafts, getStoredDraft, commitDraft, commitOrCreateConflictCopy, deleteStoredDraft, EditOwnershipLostError, type StoredDraft } from './editor/indexeddb';
import { acquireEditOwnership, type EditOwnership } from './editor/edit-ownership';
import { editBlockGuidance, mayRetryEditOwnership, type EditBlock } from './view/ownership';
import { createSinglePaneWorkspace, PRIMARY_PANE_ID, SECOND_PANE_ID } from './view/workspace';
import {
  commandAllowedOnPane,
  contentCommandStillCurrent,
  localPaneTransferBlock,
  paneCloseBlock,
  resolveSessionForDocument,
  type CommandGeneration,
} from './view/session';
import {
  createBoundSession,
  createSessionRegistry,
  snapshotBoundSession,
  type BoundSession,
} from './view/bound-session';
import { mirrorTextarea } from './view/mirror';
import { clearRecovery, listRecovery, writeRecovery, RECOVERY_PREFIX, type RecoverySnapshot } from './editor/recovery';
import { lineColumnAtOffset, offsetForLineColumn, parseGotoInput } from './editor/goto-line';
import { setupLayout } from './ui/layout';
import { setupSplitPane } from './ui/split-pane';
import { setupSearch } from './ui/search';
import { setupRules } from './ui/rules';
import { setupTransliteration } from './ui/transliteration';
import { setupSettings } from './ui/settings';
import { setupDocumentMenu } from './ui/document-menu';
import { setupMoreMenu } from './ui/more-menu';
import { installEscapeLayers, registerEscapeLayer } from './ui/escape-layers';
import { setupWritingPosition, VIEWER_POSITION_NAMESPACE } from './editor/writing-position';
import { comparisonViewerHref, parseComparisonRoute } from './view/route';
import { DOCUMENT_SIGNAL_CHANNEL, SIGNAL_POLL_INTERVAL_MS, createDocumentSignal, decideReread, parseDocumentSignal, shouldApplyDocumentSignal, type DocumentSignal } from './view/signals';
import { formatDocumentStats } from './editor/document-stats';
// Companion routing is parsed before any ordinary open/restore path (#159 W2).
// Only an absent mode is ordinary boot; invalid mode/doc takes the no-write viewer path.
const route = parseComparisonRoute(window.location.search);
const viewMode = route.kind !== 'ordinary';
const requestedViewId = route.kind === 'viewer' ? route.documentId : undefined;
// Minted per page load and never read from sessionStorage, which duplicated tabs can clone.
const instanceId = crypto.randomUUID();
document.documentElement.dataset.instanceId = instanceId;
// Single editing owner per document (#159 W4): an ordinary window edits only while it holds the
// document's Web Lock and IndexedDB fence. Viewers never acquire.
let editBlock: EditBlock = '';
let ownership: EditOwnership | undefined;
/** Declared early so readOnlyNow() can gate Undo/Convert listeners registered before draft state. */
let transitioning = false;
let deleting = false;
/** True only during the post-flush ownership acquire/reread window (not while flushing). */
let transferFrozen = false;
/** True while a pane-B document open is awaiting storage/ownership (#159 S5). */
let companionOpenBusy = false;
/** Suppress scheduleSave while moving Editor history between panes (not a content edit). */
let suppressEditTracking = false;
/** True for the whole Autosave change handler (including awaits); keeps the checkbox disabled. */
let autosaveToggleActive = false;
const webLocks: LockManager | undefined = typeof navigator.locks?.request === 'function' ? navigator.locks : undefined;
/** True while this window must not change the displayed document. */
/** True when the UI must refuse mutations (viewer, non-owner, or frozen for ownership transfer). */
const readOnlyNow = (): boolean => viewMode || editBlock !== '' || transferFrozen;
// Do not delete pendingDraft/activeDraft on viewer boot: same-tab navigation from an editor
// writes those keys on pagehide for reload restore, and wiping them here would discard that
// backup. Cloned private keys for a new companion are stripped in openComparisonWindow before
// navigation; initializeViewer never reads pending/active hints.
const field = document.querySelector<HTMLTextAreaElement>('#editor')!;
const companionField = document.querySelector<HTMLTextAreaElement>('#editor-b')!;
const workspaceRoot = document.querySelector<HTMLElement>('main.workspace')!;
const editorSplit = document.querySelector<HTMLElement>('#editor-split')!;
const splitDivider = document.querySelector<HTMLElement>('#split-divider')!;
const companionPane = document.querySelector<HTMLElement>('.editor-pane-companion')!;
const primaryPane = document.querySelector<HTMLElement>('.editor-pane-primary')!;
const splitReset = document.querySelector<HTMLButtonElement>('#split-reset')!;
const toggleSplit = document.querySelector<HTMLButtonElement>('#toggle-split')!;
const workspace = createSinglePaneWorkspace({
  root: workspaceRoot,
  paneSurface: field,
  companionSurface: companionField,
});

// Escape layers must listen before Focus so editor Escape closes Settings/Find first (#132).
installEscapeLayers();
const { setFocusMode, restoreFocusMode, resetLayout } = setupLayout(field, {
  getFocusTarget: () => workspace.activePaneId() === SECOND_PANE_ID ? companionField : field,
  focusToggleSurfaces: () => [field, companionField],
});
setupSettings();
setupDocumentMenu();
setupMoreMenu();
setupKeyboardShortcuts();
const editor = new Editor(field);
const companionEditor = new Editor(companionField);
companionEditor.setReadOnly(true);
const draftTitleB = document.querySelector<HTMLInputElement>('#draft-title-b')!;
const paneBDrafts = document.querySelector<HTMLSelectElement>('#pane-b-drafts')!;
const saveIndicatorB = document.querySelector<HTMLElement>('#save-indicator-b')!;
const companionBadge = document.querySelector<HTMLElement>('#companion-badge')!;
const primaryLiveBadge = document.querySelector<HTMLElement>('#primary-live-badge')!;
const primaryPaneChrome = document.querySelector<HTMLElement>('.pane-chrome-primary')!;
const editInPaneA = document.querySelector<HTMLButtonElement>('#edit-in-pane-a')!;
const editInPaneB = document.querySelector<HTMLButtonElement>('#edit-in-pane-b')!;
/** Declared early: syncMutationControls runs during module init before draft locals. */
const autosave = document.querySelector<HTMLInputElement>('#autosave')!;
if (viewMode) {
  editor.setReadOnly(true);
  workspace.setPaneRole('readonly');
}

/** Second independent document session when pane B shows a different document (#159 S4). */
let secondary: BoundSession | undefined;
/** Guard: setupSplitPane may reopen before draft locals exist. */
let draftsInitialized = false;

function dualDocumentSplit(): boolean {
  return !!secondary && secondary.draft.id !== active.id && workspace.splitOpen();
}

/** Same-document editable role currently lives in pane B (S5). Dual-doc uses BoundSession instead. */
function sameDocEditableInB(): boolean {
  return !!workspace.splitOpen() && !dualDocumentSplit() && workspace.editablePaneId() === SECOND_PANE_ID;
}

/** Keep the companion text current even while hidden so position restore uses the right length. */
function mirrorCompanion(force = false): void {
  if (!force && !workspace.splitOpen()) return;
  if (dualDocumentSplit()) return;
  // Mirror editable → read-only so local Edit-in-this-pane flips the direction.
  if (sameDocEditableInB()) mirrorTextarea(companionField, field);
  else mirrorTextarea(field, companionField);
}

function syncCompanionChrome(): void {
  const dual = dualDocumentSplit();
  const split = workspace.splitOpen();
  const editableInB = sameDocEditableInB();
  companionBadge.hidden = dual || editableInB;
  primaryLiveBadge.hidden = !split || dual || viewMode || !editableInB;
  primaryPaneChrome.hidden = !split || dual || viewMode || !editableInB;
  editInPaneA.hidden = !split || dual || viewMode || !editableInB || readOnlyNow() || companionOpenBusy;
  editInPaneB.hidden = !split || dual || viewMode || editableInB || readOnlyNow() || companionOpenBusy;
  draftTitleB.hidden = !dual;
  saveIndicatorB.hidden = !dual;
  paneBDrafts.hidden = !split || viewMode;
  if (!dual) {
    companionBadge.textContent = 'Live view · Read-only';
    primaryLiveBadge.textContent = 'Live view · Read-only';
    if (!editableInB) draftTitleB.value = '';
  }
}

const resizeGrip = document.querySelector<HTMLButtonElement>('#resize-editor')!;
/** Filled after mutation chrome exists; split open/close runs before those listeners are wired. */
const paneChrome = { syncMutations: (): void => {} };
/** Bumped on open/close so a detached close cannot tear down a reopened secondary. */
let splitCloseGeneration = 0;
const splitControls = setupSplitPane({
  shell: editorSplit,
  divider: splitDivider,
  primaryPane,
  companionPane,
  resetButton: splitReset,
  allowOpen: !viewMode,
  onOpenChange: open => {
    // Do not tear down pane B while promotion is flushing/confirming the primary.
    if (!open && transitioning) {
      splitControls.setOpen(true);
      return;
    }
    if (!open && draftsInitialized) {
      const closeBlock = paneCloseBlock({
        composing: editor.composing || companionEditor.composing,
        transitioning,
      });
      if (closeBlock) {
        splitControls.setOpen(true);
        announceAction(closeBlock === 'composing'
          ? 'Finish composing text before closing the split.'
          : 'Finish the current action before closing the split.');
        return;
      }
      // Move history back to pane A before workspace forgets B held the editable role.
      if (sameDocEditableInB()) transferSameDocumentEdit(PRIMARY_PANE_ID, { silent: true });
    }
    workspace.setSplitOpen(open);
    toggleSplit.setAttribute('aria-pressed', open ? 'true' : 'false');
    toggleSplit.textContent = open ? 'Close split' : 'Split editor';
    // Grip still writes inline width while split forces width:100%; hide it until closed.
    resizeGrip.hidden = open;
    resizeGrip.tabIndex = open ? -1 : 0;
    if (open) {
      splitCloseGeneration++;
      mirrorCompanion();
      syncCompanionChrome();
      if (draftsInitialized) renderPaneBDrafts();
      paneChrome.syncMutations();
      return;
    }
    const closeGeneration = ++splitCloseGeneration;
    const stillClosing = (): boolean => closeGeneration === splitCloseGeneration && !workspace.splitOpen();
    // Retarget shared commands off the companion before awaiting teardown; otherwise
    // Replace/Copy can still target the hidden pane-B field while dualDocumentSplit is false.
    const previousPane = workspace.activePaneId();
    workspace.setActivePane(PRIMARY_PANE_ID);
    paneChrome.syncMutations();
    void (async () => {
      // Initial closed restore runs before titleEditorB / draft locals exist.
      if (!draftsInitialized) return;
      const released = await releaseSecondarySession(stillClosing);
      if (released === 'cancelled') {
        // Keep the split open when the user cancels discarding pane B.
        splitControls.setOpen(true);
        if (secondary && previousPane === SECOND_PANE_ID) {
          workspace.setActivePane(SECOND_PANE_ID);
          paneChrome.syncMutations();
        }
        return;
      }
      if (released === 'aborted' || !stillClosing()) return;
      syncCompanionChrome();
      paneChrome.syncMutations();
    })();
  },
});
if (viewMode) {
  toggleSplit.disabled = true;
  splitControls.setOpen(false);
} else {
  toggleSplit.addEventListener('click', () => {
    splitControls.setOpen(!splitControls.isOpen());
  });
}
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const conflictNotice = document.querySelector<HTMLElement>('#conflict-notice')!;
const statusSep = document.querySelector<HTMLElement>('#status-sep')!;
const status = document.querySelector<HTMLElement>('#status')!;
// Preference write failures are shown apart from the document status line, so a
// later successful draft save cannot hide them. Each clears only when that
// preference is saved successfully (#57).
const preferenceWarning = document.querySelector<HTMLElement>('#preference-warning')!;
const failedPreferences = new Set<string>();
function preferenceSaved(name: string, saved: boolean): void {
  if (saved) failedPreferences.delete(name); else failedPreferences.add(name);
  const names = [...failedPreferences];
  preferenceWarning.textContent = names.length === 0 ? ''
    : names.length === 1 ? `Could not save the ${names[0]} setting; it may reset on reload.`
    : `Could not save the ${names.join(' and ')} settings; they may reset on reload.`;
  preferenceWarning.hidden = names.length === 0;
}
const appearanceSettings = setupAppearance(preferenceSaved);

// One status line carries both save state and action feedback (#52).
// 'progress' is save state that a later save may replace; 'action' is
// feedback the user caused; 'conflict' and 'failure' come from saving and
// must not be hidden by a later background success.
type StatusKind = 'progress' | 'action' | 'conflict' | 'failure';
const SAVE_FAILED = 'Save failed — your text is unsaved. Copy or export it, then retry by editing.';
const SAVE_FAILED_NO_STORAGE = 'Save failed — browser storage is unavailable. Copy or export your text before closing.';
const STORAGE_UNAVAILABLE = 'Storage unavailable. Copy or export unsaved text before closing.';
const NOT_OWNER_UNSAVED = 'Changes here are not saved — another window is editing this document. Copy or export them.';
const READ_ONLY_HERE = 'Read-only here — another window is editing this document.';
const READ_ONLY_UNSUPPORTED = 'Read-only — this browser cannot coordinate editing between windows.';
let statusKind: StatusKind = 'progress';
let statusMessage: StatusMessage = { conflict: '', primary: '', risk: '', draftListRefreshFailed: false };
type PersistResult = { saved: boolean; conflict: boolean };
type SwitchResult = { opened: boolean; conflict: boolean };
/** Cancels a pending deferred conflict write so a newer setConflict/clear wins. */
let conflictAnnounceToken = 0;
/** True between clearing the live region and the rAF rewrite for an identical conflict. */
let conflictReannouncePending = false;
/** Routine save progress that the top-bar indicator already shows (#156). */
function isRoutineSaveAnnouncement(body: string): boolean {
  return body === 'Saved locally' || body === 'Saving…';
}
/** Body/separator only — conflict live region is owned by setConflict. */
function renderStatus(): void {
  const { sep, body } = statusLineParts(statusMessage, conflictNotice.textContent ?? '');
  if (statusSep.textContent !== sep) statusSep.textContent = sep;
  if (status.textContent !== body) status.textContent = body;
  // Keep announcing save progress, but show it once in the top bar (#156).
  status.classList.toggle('status--announced-only', isRoutineSaveAnnouncement(body));
  updateSaveIndicator();
}
let saveFailed = false;
// Non-empty while browser storage cannot be used (failed or blocked
// initialization, or an upgrade in another tab). Nothing in this page
// restores it; only a reload can.
let storageProblem = '';
/** Single writer for status fields so clears/resets cannot skip a part. */
function updateStatus(patch: Partial<StatusMessage>, kind?: StatusKind): void {
  statusMessage = { ...statusMessage, ...patch };
  if (kind !== undefined) statusKind = kind;
  renderStatus();
}
/**
 * Write the conflict live region. Identical wording re-announces on a later frame
 * so assistive tech sees a clear change. Switch flushes that defer announcement
 * leave the model empty until switchDraft calls this.
 */
function setConflict(text: string, reannounce = false): void {
  statusMessage = { ...statusMessage, conflict: text };
  if (text) statusKind = 'conflict';
  if (!text) {
    conflictAnnounceToken++;
    conflictReannouncePending = false;
    if (conflictNotice.textContent) conflictNotice.textContent = '';
    renderStatus();
    return;
  }
  if (reannounce && conflictNotice.textContent === text) {
    const token = ++conflictAnnounceToken;
    conflictReannouncePending = true;
    conflictNotice.textContent = '';
    renderStatus();
    // Microtask: a later turn than this clear (so live regions observe a change), and
    // not a timer — Playwright's paused fake clock would otherwise leave the notice blank.
    queueMicrotask(() => {
      if (token !== conflictAnnounceToken) return;
      conflictReannouncePending = false;
      if (statusMessage.conflict !== text) return;
      conflictNotice.textContent = text;
      renderStatus();
    });
    return;
  }
  conflictAnnounceToken++;
  conflictReannouncePending = false;
  if (conflictNotice.textContent !== text) conflictNotice.textContent = text;
  renderStatus();
}
function clearNotices(): void {
  conflictAnnounceToken++;
  conflictReannouncePending = false;
  if (conflictNotice.textContent) conflictNotice.textContent = '';
  updateStatus({ conflict: '', draftListRefreshFailed: false });
}
function setSaveStatus(text: string, kind: Exclude<StatusKind, 'action'> = 'progress'): void {
  // Save-state updates drop a stale list-refresh suffix; conflict is preserved.
  updateStatus({ primary: text, risk: '', draftListRefreshFailed: false }, kind);
}
/** The warning that must stay visible while text or storage is at risk. */
function riskText(): string {
  const secondaryDirty = dualDocumentSplit() && !!secondary?.dirty;
  const secondaryFailed = dualDocumentSplit() && !!secondary?.saveFailed;
  const secondaryBlockedDirty = dualDocumentSplit() && !!secondary?.editBlock && !!secondary?.dirty;
  if (storageProblem) {
    if (!workspace.dirty() && !secondaryDirty) return storageProblem;
    return storageProblem === STORAGE_UNAVAILABLE ? SAVE_FAILED_NO_STORAGE : 'Changes are unsaved. ' + storageProblem;
  }
  if ((editBlock && workspace.dirty()) || secondaryBlockedDirty) return NOT_OWNER_UNSAVED;
  if ((saveFailed || secondaryFailed) && autosave.checked) return SAVE_FAILED;
  if ((workspace.dirty() || secondaryDirty) && !autosave.checked) return AUTOSAVE_OFF;
  return '';
}
function setRiskStatus(primary: string, kind: StatusKind, risk = riskText()): void {
  updateStatus({ primary, risk }, kind);
}
function statusKindForRisk(risk: string): Exclude<StatusKind, 'action' | 'conflict'> {
  return risk === AUTOSAVE_OFF ? 'progress' : 'failure';
}
/** Explicit action/failure feedback: one place for conflict reset, risk join and kind. */
function announceAction(text: string, options: {
  kind?: StatusKind;
  /** Keep the current conflict string. */
  keepConflict?: boolean;
  /** Messages that already describe save state must not also append riskText(). */
  omitRisk?: boolean;
} = {}): void {
  const kind = options.kind ?? 'action';
  if (!options.keepConflict) setConflict('');
  else if (statusMessage.conflict && !conflictReannouncePending && conflictNotice.textContent !== statusMessage.conflict) {
    // Sync a deferred model-only write without cancelling a pending re-announce.
    setConflict(statusMessage.conflict);
  }
  const risk = options.omitRisk ? '' : riskText();
  if (risk) updateStatus({ draftListRefreshFailed: false, primary: text.replace(/[.…]$/, ''), risk }, statusKindForRisk(risk));
  else updateStatus({ draftListRefreshFailed: false, primary: text, risk: '' }, kind);
}
const RETRYING = 'Saving again… The last save failed; your text stays unsaved until a save succeeds.';
/** Save progress that never hides a known failure (#52 review of 6a5d4c5). */
function showSaving(): void {
  if (storageProblem) setSaveStatus(riskText(), 'failure'); // No save can succeed.
  else if (saveFailed) setSaveStatus(RETRYING, 'failure');  // Cleared only by a commit.
  else setSaveStatus('Saving…');
}
/** Show the save state alone, e.g. after loading a draft. */
function showSaveState(): void {
  const risk = riskText();
  if (risk) setSaveStatus(risk, statusKindForRisk(risk));
  else if (editBlock) setSaveStatus(readOnlyStatus());
  else setSaveStatus(autosave.checked ? 'Saved locally' : AUTOSAVE_OFF);
}
function readOnlyStatus(): string {
  if (editBlock === 'unsupported') return READ_ONLY_UNSUPPORTED;
  if (editBlock === 'error') return 'Read-only — this window could not confirm it may edit this document.';
  return READ_ONLY_HERE;
}
function markDraftListRefreshFailed(): void {
  updateStatus(withDraftListRefreshFailure(statusMessage, riskText()));
}
/** Same gate for persist and switch refresh failures — never attach to newer action feedback. */
function shouldAttachDraftListRefreshFailure(): boolean {
  return !workspace.dirty() && (statusKind === 'progress' || statusKind === 'failure' || statusKind === 'conflict');
}
const count = document.querySelector<HTMLElement>('#count')!;
const caretPosition = document.querySelector<HTMLElement>('#caret-position')!;
const undo = document.querySelector<HTMLButtonElement>('#undo')!;
const redo = document.querySelector<HTMLButtonElement>('#redo')!;
/** Active editable session for shared chrome (#159 S3–S5). */
function activeEditableSession(): { paneId: typeof PRIMARY_PANE_ID | typeof SECOND_PANE_ID; role: 'editable' | 'readonly'; editor: Editor; field: HTMLTextAreaElement; canUndo: boolean; canRedo: boolean } {
  if (workspace.activePaneId() === SECOND_PANE_ID && dualDocumentSplit() && secondary) {
    const blocked = viewMode || secondary.editBlock !== '';
    return {
      paneId: SECOND_PANE_ID,
      role: blocked ? 'readonly' : 'editable',
      editor: secondary.editor,
      field: secondary.field,
      canUndo: secondary.editor.canUndo,
      canRedo: secondary.editor.canRedo,
    };
  }
  // Same-document: editable role may live in pane B after Edit in this pane.
  if (sameDocEditableInB()) {
    const blocked = readOnlyNow();
    return {
      paneId: SECOND_PANE_ID,
      role: blocked ? 'readonly' : 'editable',
      editor: companionEditor,
      field: companionField,
      canUndo: companionEditor.canUndo,
      canRedo: companionEditor.canRedo,
    };
  }
  return {
    paneId: PRIMARY_PANE_ID,
    role: readOnlyNow() ? 'readonly' : 'editable',
    editor,
    field,
    canUndo: editor.canUndo,
    canRedo: editor.canRedo,
  };
}
/** Live token for delayed toolbar commands after Edit-in-this-pane / content edits. */
function liveCommandState(): {
  sessionId: typeof workspace.sessionId;
  paneId: ReturnType<typeof workspace.activePaneId>;
  paneGeneration: number;
  sessionGeneration: number;
  contentRevision: number;
} {
  return {
    sessionId: workspace.sessionId,
    paneId: workspace.activePaneId(),
    paneGeneration: workspace.paneGeneration(),
    sessionGeneration: workspace.sessionGeneration(),
    contentRevision: workspace.contentRevision(),
  };
}
/**
 * Same-document local Edit in this pane (#159 S5). Moves the editable role and
 * canonical Editor history between panes without save, reload, or session bump.
 */
function transferSameDocumentEdit(
  target: typeof PRIMARY_PANE_ID | typeof SECOND_PANE_ID,
  options: { silent?: boolean; /** Bypass companion-open busy (parking before picker load). */ force?: boolean } = {},
): boolean {
  if (viewMode || !workspace.splitOpen() || dualDocumentSplit()) {
    if (!options.silent) announceAction('Edit in this pane is only available for the same-document companion.');
    return false;
  }
  const block = localPaneTransferBlock({
    sameSession: true,
    targetAlreadyEditable: workspace.editablePaneId() === target,
    composing: editor.composing || companionEditor.composing,
    transitioning: transitioning || (!options.force && companionOpenBusy),
    externallyBlocked: readOnlyNow(),
  });
  if (block) {
    if (!options.silent) {
      const message = {
        'already-editable': 'This pane is already editable.',
        composing: 'Finish composing text before moving editing to the other pane.',
        busy: 'Finish the current action before moving editing.',
        external: 'Another window is editing this document.',
        'different-session': 'Open the same document in both panes to move editing here.',
      }[block];
      announceAction(message);
    }
    return false;
  }
  const fromB = workspace.editablePaneId() === SECOND_PANE_ID;
  const fromEditor = fromB ? companionEditor : editor;
  const toEditor = target === SECOND_PANE_ID ? companionEditor : editor;
  const fromField = fromB ? companionField : field;
  const toField = target === SECOND_PANE_ID ? companionField : field;
  const fromSel = {
    start: fromField.selectionStart,
    end: fromField.selectionEnd,
    direction: fromField.selectionDirection,
  };
  const toSel = {
    start: toField.selectionStart,
    end: toField.selectionEnd,
    direction: toField.selectionDirection,
  };
  const fromScroll = { top: fromField.scrollTop, left: fromField.scrollLeft };
  const toScroll = { top: toField.scrollTop, left: toField.scrollLeft };
  // Keep both surfaces on the same text before moving history.
  toField.value = fromField.value;
  const history = fromEditor.exportHistory();
  // restoreHistory emits historychange; that must not mark dirty or schedule a save.
  suppressEditTracking = true;
  try {
    fromEditor.setReadOnly(true);
    fromEditor.restoreHistory({ v: 1, undo: [], redo: [], current: fromField.value });
    const blocked = readOnlyNow();
    toEditor.setReadOnly(blocked);
    toEditor.restoreHistory(history);
    workspace.setEditablePaneId(target);
    sessionRegistry.primary.editablePaneId = target;
  } finally {
    suppressEditTracking = false;
  }
  try {
    fromField.setSelectionRange(fromSel.start, fromSel.end, fromSel.direction);
    toField.setSelectionRange(toSel.start, toSel.end, toSel.direction);
  } catch { /* Selection restore is best-effort. */ }
  fromField.scrollTop = fromScroll.top;
  fromField.scrollLeft = fromScroll.left;
  toField.scrollTop = toScroll.top;
  toField.scrollLeft = toScroll.left;
  mirrorCompanion(true);
  syncCompanionChrome();
  syncMutationControls();
  if (!options.silent) {
    activatePane(target);
    toField.focus({ preventScroll: true });
    announceAction(target === SECOND_PANE_ID
      ? 'Editing moved to the other pane.'
      : 'Editing moved to this pane.');
  }
  return true;
}
/** Shared chrome mutates the active editable pane; refuse while a same-doc companion is active. */
function canMutatePrimary(): boolean {
  const target = activeEditableSession();
  return commandAllowedOnPane({
    activePaneId: workspace.activePaneId(),
    targetPaneId: target.paneId,
    role: target.role,
    mutatesDocument: true,
  });
}
/** Autosave follows the active editable session (pane B may own a different document). */
function autosaveControlBlocked(): boolean {
  // Viewers never own the preference; keep the change handler gated too.
  if (viewMode || transferFrozen) return true;
  if (workspace.activePaneId() === SECOND_PANE_ID && dualDocumentSplit() && secondary) {
    return secondary.editBlock !== '';
  }
  return editBlock !== '';
}
function syncAutosaveControl(): void {
  if (viewMode || autosaveToggleActive) return;
  autosave.disabled = autosaveControlBlocked();
}
function syncMutationControls(): void {
  // Comparison viewers own these attributes via applyViewerChrome; do not fight tests that
  // temporarily re-enable controls to prove handlers still refuse mutations.
  if (viewMode) return;
  const blocked = !canMutatePrimary();
  const target = activeEditableSession();
  undo.disabled = blocked || !target.canUndo;
  redo.disabled = blocked || !target.canRedo;
  for (const id of ['convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'] as const) {
    document.querySelector<HTMLButtonElement>('#' + id)!.disabled = blocked;
  }
  syncAutosaveControl();
}
const syncHistory = () => { syncMutationControls(); };
paneChrome.syncMutations = syncMutationControls;
field.addEventListener('historychange', syncHistory);
for (const [button, kind] of [[undo, 'undo'], [redo, 'redo']] as const) {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!canMutatePrimary()) return;
    const target = activeEditableSession();
    if (kind === 'undo') target.editor.undo();
    else target.editor.redo();
    target.field.focus({ preventScroll: true });
  });
}
syncHistory();
for (const [id, direction] of [['convert-cyrillic', 'to-cyrillic'], ['convert-latin', 'to-latin']] as const) {
  const button = document.querySelector<HTMLButtonElement>('#' + id)!;
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!canMutatePrimary()) return;
    const target = activeEditableSession();
    if (!target.editor.convertSelection(direction)) announceAction('Select text to convert');
  });
}
field.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== SHORTCUTS.convertCyrillic.key && key !== SHORTCUTS.convertLatin.key) return;
  if (!canMutatePrimary() || field.selectionStart === field.selectionEnd) return;
  event.preventDefault();
  editor.convertSelection(key === SHORTCUTS.convertCyrillic.key ? 'to-cyrillic' : 'to-latin');
});
companionField.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
  if (!dualDocumentSplit() && !sameDocEditableInB()) return;
  const key = event.key.toLowerCase();
  if (key !== SHORTCUTS.convertCyrillic.key && key !== SHORTCUTS.convertLatin.key) return;
  if (!canMutatePrimary() || companionField.selectionStart === companionField.selectionEnd) return;
  event.preventDefault();
  companionEditor.convertSelection(key === SHORTCUTS.convertCyrillic.key ? 'to-cyrillic' : 'to-latin');
});
function updateCaretPosition(): void {
  const surface = workspace.activePaneId() === SECOND_PANE_ID ? companionField : field;
  const { line, column } = lineColumnAtOffset(surface.value, surface.selectionStart);
  caretPosition.textContent = `Ln ${line}, Col ${column}`;
}
/** Switch the active pane; refresh Find totals only when the target pane changes. */
function activatePane(paneId: typeof PRIMARY_PANE_ID | typeof SECOND_PANE_ID): void {
  const previous = workspace.activePaneId();
  workspace.setActivePane(paneId);
  syncMutationControls();
  updateStats();
  // Same-pane refocus (e.g. Replace all returning to the editor) must keep "Replaced N".
  if (previous !== paneId) {
    showMatchCount();
    syncVersionNoticeDisplay();
  }
}
field.addEventListener('focus', () => { activatePane(PRIMARY_PANE_ID); });
companionField.addEventListener('focus', () => { activatePane(SECOND_PANE_ID); });
// Tab and Shift+Tab indent lines (#56). Keyboard users are never trapped: the
// "Tab indents" setting turns this off, and Shift+Tab on a line with nothing to
// outdent moves focus as usual.
const TAB_INDENT_KEY = 'typebridge.editor.tabIndent.v1';
const tabIndent = document.querySelector<HTMLInputElement>('#tab-indent')!;
try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { /* Keep the default. */ }
function saveTabIndent(): boolean {
  try { localStorage.setItem(TAB_INDENT_KEY, tabIndent.checked ? 'on' : 'off'); return true; } catch { return false; }
}
tabIndent.addEventListener('change', saveTabIndent);
function handleTabIndent(event: KeyboardEvent, surface: HTMLTextAreaElement, surfaceEditor: Editor): void {
  if (event.key !== SHORTCUTS.indent.key || !tabIndent.checked || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || surface.readOnly || !canMutatePrimary()) return;
  const change = indentEdit(surface.value, surface.selectionStart, surface.selectionEnd, event.shiftKey);
  // Only Shift+Tab with nothing to outdent leaves the editor; a forward Tab that changes nothing stays put.
  if (!change && event.shiftKey) return;
  event.preventDefault();
  if (!change) return;
  surfaceEditor.replaceAndSelect(change.start, change.end, change.text, change.selectionStart, change.selectionEnd);
}
field.addEventListener('keydown', event => { handleTabIndent(event, field, editor); });
companionField.addEventListener('keydown', event => {
  if (!dualDocumentSplit() && !sameDocEditableInB()) return;
  handleTabIndent(event, companionField, companionEditor);
});
function updateStats(): void {
  const surface = workspace.activePaneId() === SECOND_PANE_ID
    ? companionField
    : field;
  count.textContent = formatDocumentStats(surface.value);
  updateCaretPosition();
}
field.addEventListener('input', updateStats);
field.addEventListener('historychange', updateStats);
companionField.addEventListener('input', updateStats);
companionField.addEventListener('historychange', updateStats);
field.addEventListener('keyup', updateCaretPosition);
field.addEventListener('click', updateCaretPosition);
field.addEventListener('select', updateCaretPosition);
companionField.addEventListener('keyup', updateCaretPosition);
companionField.addEventListener('click', updateCaretPosition);
companionField.addEventListener('select', updateCaretPosition);
const typingSettings = setupTransliteration(enabled, editor, {
  syncSearchEditors: () => syncSearchEditors(),
  preferenceSaved,
  extraEditors: () => [companionEditor],
});
document.querySelector<HTMLButtonElement>('#copy')!.addEventListener('click', async () => {
  // Capture before the await so a focus change cannot redirect fallback selection.
  const target = workspace.activePaneId() === SECOND_PANE_ID ? companionField : field;
  const text = target.value;
  try { await navigator.clipboard.writeText(text); announceAction('Copied'); }
  catch {
    target.focus();
    target.select();
    announceAction('Copy unavailable. Text selected; use your device’s copy command.');
  }
});
document.querySelector<HTMLButtonElement>('#clear')!.addEventListener('click', async () => {
  if (!canMutatePrimary()) return;
  const started = workspace.captureCommandGeneration({ contentRevision: workspace.contentRevision() });
  const target = activeEditableSession();
  if (!target.field.value) return;
  const returnFocusField = target.field;
  if (await askConfirmChoice({ title: 'Clear text?', message: 'Clear the text? You can undo this action.', confirmLabel: 'Clear text', cancelLabel: 'Keep editing', returnFocus: accepted => accepted ? returnFocusField : document.querySelector<HTMLButtonElement>('#more-open')! })) {
    if (!('contentRevision' in started) || !contentCommandStillCurrent(started as CommandGeneration & { contentRevision: number }, liveCommandState())) {
      announceAction('Clear cancelled — the pane or text changed.');
      return;
    }
    if (!canMutatePrimary()) return;
    const current = activeEditableSession();
    if (current.paneId !== started.paneId) return;
    current.editor.clear();
    current.field.focus();
    announceAction('Cleared');
  }
});
editInPaneA.addEventListener('click', () => { transferSameDocumentEdit(PRIMARY_PANE_ID); });
editInPaneB.addEventListener('click', () => { transferSameDocumentEdit(SECOND_PANE_ID); });


const primarySearch: { field: HTMLTextAreaElement; editor: Editor } = { field, editor };
const companionSearch: { field: HTMLTextAreaElement; editor: Editor } = { field: companionField, editor: companionEditor };
const { findInput, findEditor, replaceEditor, syncSearchEditors, showMatchCount, resetOptions } = setupSearch(
  primarySearch,
  enabled,
  {
    canMutate: canMutatePrimary,
    // Find is read-only: follow any visible active companion (same-doc mirror or dual-doc).
    // Mutations stay gated by canMutate; split close retargets activePane to primary first.
    getFindTarget: () => workspace.activePaneId() === SECOND_PANE_ID && workspace.splitOpen()
      ? companionSearch
      : primarySearch,
    matchSurfaces: [field, companionField],
  },
);
const gotoInput = document.querySelector<HTMLInputElement>('#goto-line')!;
const gotoStatus = document.querySelector<HTMLElement>('#goto-status')!;
// Find and Go to line open on demand (#123): from their toolbar buttons or with
// Cmd/Ctrl+F and Cmd/Ctrl+G. One bar at a time; Escape or × closes it and returns to the editor.
const findBar = document.querySelector<HTMLElement>('#find-bar')!;
const gotoBar = document.querySelector<HTMLElement>('#goto-bar')!;
const findOpen = document.querySelector<HTMLButtonElement>('#find-open')!;
const gotoOpen = document.querySelector<HTMLButtonElement>('#goto-open')!;
function setBar(bar: HTMLElement, button: HTMLButtonElement, open: boolean): void {
  bar.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}
function leaveFocusPreservingActivePane(): void {
  if (!document.body.classList.contains('focus-mode')) return;
  // setFocusMode focuses #editor and would otherwise steal activePane to pane-a.
  const pane = workspace.activePaneId();
  setFocusMode(false);
  workspace.setActivePane(pane);
  syncMutationControls();
}
function openFind(): void {
  leaveFocusPreservingActivePane();
  setBar(gotoBar, gotoOpen, false);
  setBar(findBar, findOpen, true);
  showMatchCount();
  findInput.focus();
  findInput.select();
}
function openGoto(): void {
  leaveFocusPreservingActivePane();
  setBar(findBar, findOpen, false);
  setBar(gotoBar, gotoOpen, true);
  gotoInput.focus();
  gotoInput.select();
}
function activeEditorSurface(): HTMLTextAreaElement {
  return workspace.activePaneId() === SECOND_PANE_ID ? companionField : field;
}
function closeBar(bar: HTMLElement, button: HTMLButtonElement): void {
  setBar(bar, button, false);
  activeEditorSurface().focus({ preventScroll: true });
}
findOpen.addEventListener('click', () => { if (findBar.hidden) openFind(); else closeBar(findBar, findOpen); });
gotoOpen.addEventListener('click', () => { if (gotoBar.hidden) openGoto(); else closeBar(gotoBar, gotoOpen); });
document.querySelector<HTMLButtonElement>('#find-close')!.addEventListener('click', () => closeBar(findBar, findOpen));
document.querySelector<HTMLButtonElement>('#goto-close')!.addEventListener('click', () => closeBar(gotoBar, gotoOpen));
for (const [bar, button] of [[findBar, findOpen], [gotoBar, gotoOpen]] as const) {
  registerEscapeLayer(bar, 10, () => closeBar(bar, button));
}
function goToLine(): void {
  const parsed = parseGotoInput(gotoInput.value);
  if (!parsed) {
    gotoStatus.textContent = gotoInput.value.trim() ? 'Use line or line:column' : 'Enter a line number';
    return;
  }
  const surface = activeEditorSurface();
  const surfaceEditor = surface === companionField ? companionEditor : editor;
  const target = offsetForLineColumn(surface.value, parsed.line, parsed.column ?? 1);
  surface.focus({ preventScroll: true });
  surface.setSelectionRange(target.offset, target.offset);
  surfaceEditor.revealSelection();
  updateCaretPosition();
  gotoStatus.textContent = target.line === parsed.line && (parsed.column === undefined || target.column === parsed.column)
    ? `Line ${target.line}, column ${target.column}`
    : `Clamped to line ${target.line}, column ${target.column}`;
}
document.querySelector<HTMLButtonElement>('#goto-go')!.addEventListener('click', goToLine);
gotoInput.addEventListener('keydown', event => {
  // Skip IME confirmation Enter; composition must not navigate (#88 review).
  if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.repeat || event.isComposing || event.defaultPrevented) return;
  event.preventDefault();
  goToLine();
});
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat || event.isComposing) return;
  const key = event.key.toLowerCase();
  if (key === SHORTCUTS.find.key && !event.shiftKey) {
    event.preventDefault(); openFind();
  } else if (key === SHORTCUTS.goto.key && !event.shiftKey) {
    // Cmd/Ctrl+G: go to line. May also be reserved by the browser's Find UI.
    event.preventDefault();
    openGoto();
  }
});


const resetRules = setupRules(() => [editor, companionEditor, findEditor, replaceEditor, titleEditor, titleEditorB]);

const draftSelect = document.querySelector<HTMLSelectElement>('#drafts')!;
// One document list, in the ▾ menu; Focus mode shows the same title bar (#104).
const documentPickers = [draftSelect];
const draftTitle = document.querySelector<HTMLInputElement>('#draft-title')!;
// The draft title follows the global transliteration mode and rules (#89).
const titleEditor = new Editor(draftTitle);
titleEditor.setEnabled(enabled.checked);
if (viewMode) titleEditor.setReadOnly(true);
enabled.addEventListener('change', () => {
  titleEditor.setEnabled(enabled.checked);
  titleEditorB.setEnabled(enabled.checked);
});
const titleEditorB = new Editor(draftTitleB);
titleEditorB.setEnabled(enabled.checked);
titleEditorB.setReadOnly(true);
let db: IDBDatabase | undefined;
let active: StoredDraft = { ...newDraft(), revision: 0 };
const sessionRegistry = createSessionRegistry(createBoundSession({
  sessionId: 'session-1',
  editablePaneId: PRIMARY_PANE_ID,
  draft: active,
  editor,
  field,
  title: draftTitle,
}));
let drafts: StoredDraft[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<PersistResult> | undefined;
let loadingDraft = false;
/** Companion window shows the missing-document state (nothing to save or restore). */
let viewMissing = false;
/** Document-identity counter lives on the workspace as sessionGeneration (formerly viewGeneration). */
const saveIndicator = document.querySelector<HTMLElement>('#save-indicator')!;
/** Persistence state, independent of action feedback retained in the live status line. */
function updateSaveIndicator(): void {
  const state = storageProblem || saveFailed ? 'failed'
    : editBlock ? (workspace.dirty() ? 'unsaved' : 'readonly')
    : !autosave.checked || !db ? 'unsaved' : workspace.dirty() ? 'saving' : 'saved';
  const label = { failed: 'Save failed', readonly: 'Read-only', unsaved: 'Not saved', saving: 'Saving…', saved: 'Saved' }[state];
  if (saveIndicator.textContent !== label) saveIndicator.textContent = label;
  saveIndicator.dataset.state = state;
}
// Viewers use their own key namespace so they never overwrite an editor's saved offsets.
const writingPosition = setupWritingPosition(
  field,
  () => loadingDraft || field.disabled || viewMissing ? undefined : active.id,
  viewMode ? VIEWER_POSITION_NAMESPACE : '',
);
// Companion pane keeps an independent scroll/selection namespace (#159 S3).
const companionWritingPosition = setupWritingPosition(
  companionField,
  () => loadingDraft || viewMissing || !workspace.splitOpen()
    ? undefined
    : (secondary?.draft.id ?? active.id),
  viewMode ? VIEWER_POSITION_NAMESPACE + 'pane-b:' : 'pane:pane-b:',
);
const journalTab = crypto.randomUUID();
const OWNER_LOCK = 'typebridge-recovery-owner:';
let ownershipAvailable = false;
const ownerReady = new Promise<void>(resolve => {
  // Viewers write no recovery journals, so they never take recovery ownership.
  if (!navigator.locks || viewMode) { resolve(); return; }
  void navigator.locks.request(OWNER_LOCK + journalTab, async () => {
    ownershipAvailable = true; resolve();
    await new Promise<void>(() => { /* The browser releases this lock with the page. */ });
  }).catch(() => { resolve(); });
});
let currentJournal: RecoverySnapshot | undefined;
const journalWarning = document.createElement('p');
journalWarning.setAttribute('role', 'alert');
journalWarning.hidden = true;
status.parentElement?.before(journalWarning);
const recoveryPanel = document.createElement('section');
recoveryPanel.setAttribute('aria-label', 'Recover unsaved documents');
recoveryPanel.className = 'recovery-panel'; // Hidden by CSS while empty (#118).
status.parentElement?.before(recoveryPanel);

field.disabled = true;
draftSelect.disabled = true;
draftTitle.disabled = true;
autosave.checked = true;
try { autosave.checked = autosaveEnabled(); } catch { /* Keep editing available if preferences are blocked. */ }
// A tab-scoped emergency snapshot is not the committed draft. It only bridges
// navigation/reload when the browser aborts an IndexedDB transaction on unload.
const PENDING_KEY = 'typebridge.pendingDraft.v1';
const PENDING_KEY_B = 'typebridge.pendingDraft.paneB.v1';
function parsePendingDraft(raw: string | null): StoredDraft | undefined {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const draft = value as Partial<StoredDraft>;
    if (typeof draft.id !== 'string' || !draft.id || typeof draft.title !== 'string' ||
        typeof draft.text !== 'string' || typeof draft.updatedAt !== 'number' ||
        !Number.isSafeInteger(draft.revision) || (draft.revision ?? -1) < 0) return undefined;
    return draft as StoredDraft;
  } catch { return undefined; }
}
function readPending(): StoredDraft | undefined {
  try { return parsePendingDraft(sessionStorage.getItem(PENDING_KEY)); }
  catch { return undefined; }
}
function readPendingB(): StoredDraft | undefined {
  try { return parsePendingDraft(sessionStorage.getItem(PENDING_KEY_B)); }
  catch { return undefined; }
}
function snapshot(): StoredDraft {
  if (sameDocEditableInB()) {
    return {
      ...active,
      text: companionField.value,
      title: draftTitle.value.trim() || UNTITLED_TITLE,
      history: companionEditor.exportHistory(),
      updatedAt: Date.now(),
    };
  }
  return { ...active, text: field.value, title: draftTitle.value.trim() || UNTITLED_TITLE, history: editor.exportHistory(), updatedAt: Date.now() };
}
let currentJournalSecondary: RecoverySnapshot | undefined;
function journalEdit(): void {
  if (viewMode || !autosave.checked) return;
  const text = sameDocEditableInB() ? companionField.value : field.value;
  const entry: RecoverySnapshot = { token: crypto.randomUUID(), tab: journalTab, documentId: active.id, revision: active.revision, timestamp: Date.now(), title: draftTitle.value.trim() || UNTITLED_TITLE, text };
  try { writeRecovery(localStorage, entry); currentJournal = entry; journalWarning.hidden = true; }
  catch { journalWarning.textContent = 'Emergency backup unavailable. Keep this tab open until saved, or copy or export your text.'; journalWarning.hidden = false; }
}
function journalEditSecondary(): void {
  if (viewMode || !autosave.checked || !secondary) return;
  const entry: RecoverySnapshot = {
    token: crypto.randomUUID(),
    tab: journalTab,
    documentId: secondary.draft.id,
    revision: secondary.draft.revision,
    timestamp: Date.now(),
    title: draftTitleB.value.trim() || UNTITLED_TITLE,
    text: companionField.value,
  };
  try { writeRecovery(localStorage, entry); currentJournalSecondary = entry; journalWarning.hidden = true; }
  catch { journalWarning.textContent = 'Emergency backup unavailable. Keep this tab open until saved, or copy or export your text.'; journalWarning.hidden = false; }
}
function sameContent(a: StoredDraft, b: StoredDraft): boolean {
  return a.id === b.id && a.title === b.title && a.text === b.text && JSON.stringify(a.history) === JSON.stringify(b.history);
}
function savePending(): void {
  if (viewMode || !workspace.dirty() || !autosave.checked || deleting) return;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(snapshot())); }
  catch {
    // Keep any conflict notice and the current risk; only replace the primary.
    // Trailing period stays; renderStatusBody joins risk with a space after it.
    setRiskStatus('Unsaved text could not be backed up for reload. Copy or export it.', 'failure');
  }
}
function savePendingSecondary(): void {
  if (viewMode || !secondary?.dirty || !autosave.checked) return;
  try { sessionStorage.setItem(PENDING_KEY_B, JSON.stringify(snapshotBoundSession(secondary, UNTITLED_TITLE))); }
  catch {
    setRiskStatus('Unsaved text could not be backed up for reload. Copy or export it.', 'failure');
  }
}
function clearPending(saved: StoredDraft): void {
  try { const pending = readPending(); if (pending && pending.id === saved.id && (sameContent(pending, saved) || saved.updatedAt >= pending.updatedAt)) sessionStorage.removeItem(PENDING_KEY); }
  catch { /* A stale backup is safer than removing one we cannot verify. */ }
}
function clearPendingSecondary(saved: StoredDraft): void {
  try {
    const pending = readPendingB();
    if (pending && pending.id === saved.id && (sameContent(pending, saved) || saved.updatedAt >= pending.updatedAt)) {
      sessionStorage.removeItem(PENDING_KEY_B);
    }
  } catch { /* A stale backup is safer than removing one we cannot verify. */ }
}
function flushSecondaryOnUnload(): void {
  if (!secondary) return;
  savePendingSecondary();
  clearTimeout(secondary.saveTimer);
  void persistSecondary();
}
function rememberActive(): void { if (viewMode) return; try { setActiveDraftId(active.id); } catch { /* Selection is only a hint. */ } }
function renderDrafts(): void {
  const visible = viewMissing || drafts.some(d => d.id === active.id) ? drafts : [active, ...drafts];
  const displayTitle = draftTitle.value.trim() || UNTITLED_TITLE;
  for (const picker of documentPickers) {
    picker.replaceChildren();
    for (const draft of visible) {
      const option = document.createElement('option');
      option.value = draft.id;
      const isCurrent = draft.id === active.id;
      option.textContent = draftOptionLabel({
        savedTitle: draft.title,
        displayTitle,
        isCurrent,
        unsaved: isCurrent && workspace.dirty(),
      });
      picker.append(option);
    }
    picker.value = viewMissing ? '' : active.id;
  }
  // Shown as a list inside the document menu: at least two rows, at most eight.
  draftSelect.size = Math.min(8, Math.max(2, draftSelect.options.length));
  renderPaneBDrafts();
}
function renderPaneBDrafts(): void {
  if (viewMode || !draftsInitialized) return;
  const selectedId = dualDocumentSplit() && secondary ? secondary.draft.id : active.id;
  const displayTitle = dualDocumentSplit() && secondary
    ? (secondary.title.value.trim() || UNTITLED_TITLE)
    : (draftTitle.value.trim() || UNTITLED_TITLE);
  // Always surface the in-memory primary (and secondary) when they are not yet in drafts,
  // so an unsaved New document remains selectable to return to live-mirror mode.
  const extras: StoredDraft[] = [];
  if (!drafts.some(d => d.id === active.id)) extras.push(active);
  const companion = dualDocumentSplit() ? secondary : undefined;
  if (companion && !drafts.some(d => d.id === companion.draft.id)
    && !extras.some(d => d.id === companion.draft.id)) {
    extras.push(companion.draft);
  }
  const visible = extras.length ? [...extras, ...drafts] : drafts;
  paneBDrafts.replaceChildren();
  for (const draft of visible) {
    const option = document.createElement('option');
    option.value = draft.id;
    const isCurrent = draft.id === selectedId;
    option.textContent = draftOptionLabel({
      savedTitle: draft.title,
      displayTitle,
      isCurrent,
      unsaved: isCurrent && (dualDocumentSplit() && secondary ? secondary.dirty : workspace.dirty()),
    });
    paneBDrafts.append(option);
  }
  paneBDrafts.value = selectedId;
  syncCompanionChrome();
}
function updateSaveIndicatorB(): void {
  if (!secondary) return;
  const state = storageProblem || secondary.saveFailed ? 'failed'
    : secondary.editBlock ? (secondary.dirty ? 'unsaved' : 'readonly')
    : !autosave.checked || !db ? 'unsaved' : secondary.dirty ? 'saving' : 'saved';
  const label = { failed: 'Save failed', readonly: 'Read-only', unsaved: 'Not saved', saving: 'Saving…', saved: 'Saved' }[state];
  if (saveIndicatorB.textContent !== label) saveIndicatorB.textContent = label;
  saveIndicatorB.dataset.state = state;
}
/**
 * Flush or confirm-discard the secondary session.
 * `stillWanted` abort checks let a reopen win over a detached close.
 */
async function releaseSecondarySession(
  stillWanted: () => boolean = () => true,
): Promise<'released' | 'cancelled' | 'aborted'> {
  if (!secondary) {
    companionEditor.setReadOnly(true);
    titleEditorB.setReadOnly(true);
    syncCompanionChrome();
    return 'released';
  }
  clearTimeout(secondary.saveTimer);
  if (secondary.saving) await secondary.saving;
  if (!stillWanted()) return 'aborted';
  if (!secondary) return 'released';
  while (secondary.dirty && autosave.checked && !secondary.editBlock) {
    const result = await persistSecondary();
    if (!result.saved && secondary.saveFailed) break;
    if (!stillWanted()) return 'aborted';
  }
  if (secondary.dirty && (!autosave.checked || secondary.editBlock || secondary.saveFailed)) {
    if (!await askConfirmChoice({
      title: 'Discard unsaved changes in the other pane?',
      message: secondary.editBlock
        ? 'Another window is editing that document, so this pane cannot save these changes. Copy or export them first to keep them.'
        : 'Copy or export unsaved changes in the other pane first to keep them.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      returnFocus: companionField,
    })) {
      renderPaneBDrafts();
      return 'cancelled';
    }
  }
  if (!stillWanted()) return 'aborted';
  if (!secondary) return 'released';
  const previous = secondary;
  const discardedJournal = currentJournalSecondary;
  secondary = undefined;
  sessionRegistry.setSecondary(undefined);
  currentJournalSecondary = undefined;
  try { sessionStorage.removeItem(PENDING_KEY_B); } catch { /* Optional backup. */ }
  // Confirmed discard / teardown must forget the localStorage recovery entry so a
  // reload does not resurface text the user already discarded.
  if (discardedJournal) {
    try { clearRecovery(localStorage, discardedJournal); } catch { /* Optional backup. */ }
  }
  clearOwnershipLost(previous.ownership);
  // E2E may delay release so a reopen can race the close generation check.
  const delayReleaseMs = (window as Window & { __typebridgeDelaySecondaryReleaseMs?: number }).__typebridgeDelaySecondaryReleaseMs;
  if (typeof delayReleaseMs === 'number' && delayReleaseMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayReleaseMs));
  }
  // Await fence/Web Lock cleanup so a quick re-open of the same document does not
  // observe ifAvailable:true as busy while this tab still holds the lock.
  if (previous.ownership) await previous.ownership.release();
  // Split may have reopened during the await. Finish live-mirror read-only cleanup
  // unless a new secondary session was installed meanwhile.
  if (secondary) return stillWanted() ? 'released' : 'aborted';
  clearVersionNotice('secondary');
  companionEditor.setReadOnly(true);
  titleEditorB.setReadOnly(true);
  companionField.value = field.value;
  draftTitleB.value = '';
  syncCompanionChrome();
  mirrorCompanion(true);
  syncMutationControls();
  return stillWanted() ? 'released' : 'aborted';
}
/**
 * When the primary opens the document already editable in pane B, promote B's
 * in-memory session (text/title/history/ownership) instead of re-acquiring and mirroring.
 */
function rescheduleSecondaryAutosave(): void {
  if (!secondary || viewMode || !secondary.dirty || !autosave.checked || secondary.editBlock) return;
  clearTimeout(secondary.saveTimer);
  updateSaveIndicatorB();
  secondary.saveTimer = setTimeout(() => { void persistSecondary(); }, 300);
}
async function promoteSecondaryToPrimary(): Promise<boolean> {
  if (!secondary) return true;
  const promoting = secondary;
  clearTimeout(secondary.saveTimer);
  const restoreSecondaryTimer = secondary.dirty && autosave.checked && !secondary.editBlock;
  const abortPromote = (): false => {
    if (restoreSecondaryTimer && secondary === promoting) rescheduleSecondaryAutosave();
    return false;
  };
  if (secondary.saving) await secondary.saving;
  // Companion may have been released/replaced while awaiting (close split / picker).
  if (secondary !== promoting) return abortPromote();
  // Flush the document being left in the primary pane first.
  while (workspace.dirty() && autosave.checked && !editBlock) {
    const result = await persist();
    if (secondary !== promoting) return abortPromote();
    if (!result.saved && saveFailed) {
      if (!await askConfirmChoice({
        title: 'Discard unsaved changes?',
        message: 'Copy or export unsaved changes first to keep them.',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')!,
      })) return abortPromote();
      if (secondary !== promoting) return abortPromote();
      break;
    }
  }
  if (workspace.dirty() && (!autosave.checked || editBlock)) {
    if (!await askConfirmChoice({
      title: 'Discard unsaved changes?',
      message: editBlock
        ? 'Another window is editing this document, so this window cannot save these changes. Copy or export them first to keep them.'
        : 'Copy or export unsaved changes first to keep them.',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')!,
    })) return abortPromote();
    if (secondary !== promoting) return abortPromote();
  }
  if (secondary !== promoting) return abortPromote();
  writingPosition.save();
  companionWritingPosition.save();
  const promoted = snapshotBoundSession(promoting, UNTITLED_TITLE);
  const promotedDirty = promoting.dirty;
  const promotedOwnership = promoting.ownership;
  const promotedBlock = promoting.editBlock;
  promoting.ownership = undefined;
  secondary = undefined;
  sessionRegistry.setSecondary(undefined);
  const promotedJournal = currentJournalSecondary;
  currentJournalSecondary = undefined;
  if (promotedJournal) {
    try { clearRecovery(localStorage, promotedJournal); } catch { /* Optional backup. */ }
  }
  // Retire both reload backups: the discarded primary snapshot must not resurrect on
  // the next boot, and pane-B's key must not reopen pre-promotion text.
  try {
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY_B);
  } catch { /* Optional backup. */ }
  // Handle was acquired for pane B; after promote, loss must freeze the primary session.
  clearOwnershipLost(promotedOwnership);
  const displaced = ownership;
  ownership = promotedOwnership;
  // Await displaced primary lock cleanup so a quick reopen of that document in pane B
  // does not observe ifAvailable:true as busy while this tab still holds it.
  if (displaced) await displaced.release();
  editBlock = promotedBlock;
  active = promoted;
  workspace.setDocumentId(promoted.id);
  workspace.bumpSessionGeneration();
  workspace.setDirty(promotedDirty);
  loadingDraft = true;
  try {
    editor.load(promoted.text);
    if (promoted.history) editor.restoreHistory(promoted.history);
    draftTitle.value = promoted.title;
    syncTitleTooltip();
  } finally {
    loadingDraft = false;
  }
  rememberActive();
  companionEditor.setReadOnly(true);
  titleEditorB.setReadOnly(true);
  draftTitleB.value = '';
  syncCompanionChrome();
  mirrorCompanion(true);
  companionWritingPosition.restore(promoted.id);
  writingPosition.restore(promoted.id);
  // Discarded primary failure/notices must not stick to the promoted session.
  saveFailed = false;
  clearNotices();
  clearVersionNotice();
  applyEditAccess();
  showSaveState();
  if (workspace.dirty() && autosave.checked && !editBlock) {
    journalEdit();
    savePending();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void persist(); }, 300);
    showSaving();
  }
  renderDrafts();
  syncMutationControls();
  return true;
}
async function persistSecondary(): Promise<{ saved: boolean; conflict: boolean }> {
  if (!secondary || viewMode) return { saved: true, conflict: false };
  clearTimeout(secondary.saveTimer);
  if (!autosave.checked || !secondary.dirty) return { saved: !secondary.dirty, conflict: false };
  if (secondary.editBlock) return { saved: false, conflict: false };
  if (secondary.saving) return secondary.saving;
  const session = secondary;
  session.saving = (async () => {
    const delayMs = (window as Window & { __typebridgeDelayPersistSecondaryMs?: number }).__typebridgeDelayPersistSecondaryMs;
    if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    let createdConflict = false;
    try {
      if (!db) throw new Error('Storage unavailable');
      while (session.dirty && autosave.checked && !session.editBlock) {
        const version = session.contentRevision;
        const saved = snapshotBoundSession(session, UNTITLED_TITLE);
        if (session.ownership?.documentId !== saved.id) throw new EditOwnershipLostError();
        const owner = await session.ownership.writeFence();
        const journal = currentJournalSecondary
          && currentJournalSecondary.documentId === saved.id
          && currentJournalSecondary.revision === session.draft.revision
          && currentJournalSecondary.text === saved.text
          && currentJournalSecondary.title === saved.title
          ? currentJournalSecondary
          : undefined;
        const result = await commitOrCreateConflictCopy(db, saved, session.draft.revision, crypto.randomUUID(), owner);
        clearPendingSecondary(saved);
        const titleOnly = !result.conflict && saved.title !== session.draft.title && saved.text === session.draft.text;
        if (journal) { try { clearRecovery(localStorage, journal); } catch { /* Retain a recoverable entry on storage errors. */ } }
        session.draft = result.draft;
        clearVersionNotice('secondary');
        postSignal(titleOnly ? 'renamed' : 'saved', result.draft.id, result.draft.revision);
        if (session.contentRevision !== version && autosave.checked) journalEditSecondary();
        session.saveFailed = false;
        session.dirty = session.contentRevision !== version;
        updateSaveIndicatorB();
        if (result.conflict) {
          createdConflict = true;
          // Retain a title typed while the conflict-copy commit was in flight.
          if ((draftTitleB.value.trim() || UNTITLED_TITLE) === saved.title) {
            draftTitleB.value = session.draft.title;
          }
          setConflict(CONFLICT_COPY, true);
          updateStatus({
            primary: session.dirty && !storageProblem ? 'Saving…' : '',
            risk: riskText(),
          }, 'conflict');
          const access = await acquireFor(result.draft.id);
          clearOwnershipLost(session.ownership);
          if (session.ownership) void session.ownership.release();
          session.ownership = access.ownership;
          session.editBlock = access.block;
          bindOwnershipLost(access.ownership, () => {
            if (access.ownership) loseSecondaryOwnership(access.ownership);
          });
          if (access.block) {
            companionEditor.setReadOnly(true);
            titleEditorB.setReadOnly(true);
          }
          renderPaneBDrafts();
          syncMutationControls();
        }
      }
      try { await refreshDrafts(); } catch { /* List is advisory. */ }
      return { saved: !session.dirty, conflict: createdConflict };
    } catch (error) {
      if (error instanceof EditOwnershipLostError) {
        const lost = session.ownership;
        session.ownership = undefined;
        session.editBlock = 'lost';
        clearOwnershipLost(lost);
        void lost?.release();
        companionEditor.setReadOnly(true);
        titleEditorB.setReadOnly(true);
        updateSaveIndicatorB();
        syncMutationControls();
        return { saved: false, conflict: createdConflict };
      }
      session.saveFailed = true;
      updateSaveIndicatorB();
      return { saved: false, conflict: createdConflict };
    }
  })();
  try { return await session.saving; }
  finally {
    session.saving = undefined;
    if (session.dirty && autosave.checked && !session.saveFailed && !session.editBlock) {
      clearTimeout(session.saveTimer);
      session.saveTimer = setTimeout(() => { void persistSecondary(); }, 300);
    }
  }
}
function scheduleSaveSecondary(fromTitle = false): void {
  if (!secondary || viewMode || secondary.editBlock) return;
  const becameDirty = !secondary.dirty;
  secondary.dirty = true;
  secondary.contentRevision += 1;
  clearTimeout(secondary.saveTimer);
  if (autosave.checked) {
    journalEditSecondary();
    updateSaveIndicatorB();
    secondary.saveTimer = setTimeout(() => { void persistSecondary(); }, 300);
  } else {
    updateSaveIndicatorB();
    if (becameDirty || fromTitle) renderPaneBDrafts();
  }
}
/** Serializes pane-B document opens so overlapping picks cannot orphan locks. */
let companionOpenGeneration = 0;
let companionOpenInFlight: Promise<void> | undefined;
/** True while boot is restoring pane-B pending; keeps the picker disabled. */
let bootRestoringSecondary = false;
async function openCompanionDocument(id: string): Promise<void> {
  if (viewMode || !workspace.splitOpen() || !db || transitioning) return;
  const generation = ++companionOpenGeneration;
  paneBDrafts.disabled = true;
  companionOpenBusy = true;
  syncCompanionChrome();
  const run = (async () => {
    if (companionOpenInFlight) await companionOpenInFlight.catch(() => undefined);
    if (generation !== companionOpenGeneration || !workspace.splitOpen()) return;
    // Dual-doc and picker restores reuse #editor-b; park same-doc history on A first.
    // Refuse the whole open if IME/busy blocks parking — do not load over live history.
    if (sameDocEditableInB()) {
      if (!transferSameDocumentEdit(PRIMARY_PANE_ID, { silent: true, force: true })) {
        announceAction('Finish composing text before opening another document in the other pane.');
        return;
      }
    }
    if (id === active.id) {
      if ((await releaseSecondarySession()) === 'cancelled') { renderPaneBDrafts(); return; }
      if (generation !== companionOpenGeneration) return;
      mirrorCompanion(true);
      companionWritingPosition.restore(active.id);
      renderPaneBDrafts();
      return;
    }
    const represented = resolveSessionForDocument(id, [
      { sessionId: 'session-1', documentId: active.id },
      ...(secondary ? [{ sessionId: secondary.sessionId, documentId: secondary.draft.id }] : []),
    ]);
    if (represented === 'session-1') {
      if ((await releaseSecondarySession()) === 'cancelled') { renderPaneBDrafts(); return; }
      return;
    }
    if (secondary?.draft.id === id) return;
    let next: StoredDraft | undefined;
    try {
      next = await getStoredDraft(db!, id);
    } catch {
      announceAction('Could not open that document in the other pane.');
      renderPaneBDrafts();
      return;
    }
    if (generation !== companionOpenGeneration || !workspace.splitOpen()) return;
    // Primary may have switched to this document while we awaited storage.
    if (active.id === id) {
      if ((await releaseSecondarySession()) === 'cancelled') { renderPaneBDrafts(); return; }
      if (generation !== companionOpenGeneration) return;
      mirrorCompanion(true);
      companionWritingPosition.restore(active.id);
      renderPaneBDrafts();
      return;
    }
    if (!next || next.revision < 1) {
      announceAction('Could not open that document in the other pane.');
      renderPaneBDrafts();
      return;
    }
    if ((await releaseSecondarySession()) === 'cancelled') { renderPaneBDrafts(); return; }
    if (generation !== companionOpenGeneration || !workspace.splitOpen()) return;
    if (active.id === id) {
      mirrorCompanion(true);
      companionWritingPosition.restore(active.id);
      renderPaneBDrafts();
      return;
    }
    const access = await acquireFor(next.id);
    if (generation !== companionOpenGeneration || !workspace.splitOpen() || active.id === id) {
      void access.ownership?.release();
      if (active.id === id && generation === companionOpenGeneration && workspace.splitOpen()) {
        mirrorCompanion(true);
        companionWritingPosition.restore(active.id);
        renderPaneBDrafts();
      }
      return;
    }
    // Reread after release/acquire even for busy/read-only opens: the pre-prompt
    // snapshot may be stale if another tab saved while the discard dialog was up.
    let target = next;
    if (db) {
      let fresh: StoredDraft | undefined;
      try {
        fresh = await getStoredDraft(db, next.id);
      } catch {
        void access.ownership?.release();
        announceAction('Could not open that document in the other pane.');
        renderPaneBDrafts();
        return;
      }
      if (generation !== companionOpenGeneration || !workspace.splitOpen() || active.id === id) {
        void access.ownership?.release();
        if (active.id === id && generation === companionOpenGeneration && workspace.splitOpen()) {
          mirrorCompanion(true);
          companionWritingPosition.restore(active.id);
          renderPaneBDrafts();
        }
        return;
      }
      if (!fresh) {
        void access.ownership?.release();
        announceAction('Could not open that document in the other pane.');
        renderPaneBDrafts();
        return;
      }
      target = fresh;
    }
    if (active.id === target.id) {
      void access.ownership?.release();
      mirrorCompanion(true);
      companionWritingPosition.restore(active.id);
      renderPaneBDrafts();
      return;
    }
    companionWritingPosition.save();
    loadingDraft = true;
    try {
      companionEditor.setReadOnly(false);
      titleEditorB.setReadOnly(false);
      companionEditor.load(target.text);
      if (target.history) companionEditor.restoreHistory(target.history);
      draftTitleB.value = target.title;
      draftTitleB.hidden = false;
    } finally {
      loadingDraft = false;
    }
    secondary = createBoundSession({
      sessionId: 'session-2',
      editablePaneId: SECOND_PANE_ID,
      draft: target,
      editor: companionEditor,
      field: companionField,
      title: draftTitleB,
    });
    secondary.ownership = access.ownership;
    secondary.editBlock = access.block;
    bindOwnershipLost(access.ownership, () => {
      if (access.ownership) loseSecondaryOwnership(access.ownership);
    });
    if (access.block) {
      companionEditor.setReadOnly(true);
      titleEditorB.setReadOnly(true);
    }
    sessionRegistry.setSecondary(secondary);
    companionWritingPosition.restore(target.id);
    updateSaveIndicatorB();
    syncCompanionChrome();
    renderPaneBDrafts();
    syncMutationControls();
    workspace.setActivePane(SECOND_PANE_ID);
    companionField.focus({ preventScroll: true });
  })();
  companionOpenInFlight = run;
  try { await run; }
  finally {
    if (companionOpenInFlight === run) companionOpenInFlight = undefined;
    if (generation === companionOpenGeneration) {
      companionOpenBusy = false;
      if (!bootRestoringSecondary) paneBDrafts.disabled = false;
      syncCompanionChrome();
    }
  }
}
async function refreshDrafts(): Promise<void> {
  const delayMs = (window as Window & { __typebridgeDelayRefreshMs?: number }).__typebridgeDelayRefreshMs;
  if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  if (db) drafts = await listStoredDrafts(db);
  renderDrafts();
  if (statusMessage.draftListRefreshFailed) updateStatus({ draftListRefreshFailed: false });
}
function showDraft(): void {
  // Callers decide post-load status; clearing through updateStatus keeps the DOM in sync.
  workspace.bumpSessionGeneration();
  workspace.setDocumentId(active.id);
  clearVersionNotice('primary');
  clearNotices();
  loadingDraft = true;
  try {
    // Document switches always rebind the same-document editable role to pane A.
    if (workspace.splitOpen() && !dualDocumentSplit() && workspace.editablePaneId() === SECOND_PANE_ID) {
      workspace.setEditablePaneId(PRIMARY_PANE_ID);
      sessionRegistry.primary.editablePaneId = PRIMARY_PANE_ID;
    }
    editor.load(active.text);
    if (!viewMode) editor.restoreHistory(active.history);
    draftTitle.value = active.title;
    syncTitleTooltip();
    workspace.setDirty(false);
    saveFailed = false; // The editor no longer holds the unsaved text.
    // Same-document mirror only — dual-document B keeps its own BoundSession text/history.
    if (!dualDocumentSplit()) {
      companionEditor.load(active.text);
      companionEditor.restoreHistory({ v: 1, undo: [], redo: [], current: active.text });
      if (!viewMode) companionEditor.setReadOnly(true);
      mirrorCompanion(true);
    }
    // Dual-document B keeps its own position key; do not apply the primary's offsets.
    companionWritingPosition.restore(
      dualDocumentSplit() && secondary ? secondary.draft.id : active.id,
    );
  } finally { loadingDraft = false; }
  writingPosition.restore(active.id);
  syncCompanionChrome();
  renderDrafts();
  updateStats();
  updateSaveIndicator();
}
const ownershipNotice = document.querySelector<HTMLElement>('#ownership-notice')!;
/** Controls that change the displayed document; New, Import and switching stay available. */
const OWNER_ONLY_CONTROLS = ['delete-draft', 'convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'];
/** Reflect ownership + transfer freeze in the editors, controls and guidance (ordinary windows only). */
function applyEditAccess(): void {
  if (viewMode) return;
  // Must match readOnlyNow: stay frozen for the whole switch/delete interval even if
  // installOwnership runs before the handler finishes (e.g. refreshDrafts after delete).
  const blocked = editBlock !== '' || transferFrozen;
  workspace.setPaneRole(blocked ? 'readonly' : 'editable');
  const editableInB = sameDocEditableInB();
  const primaryBlocked = blocked || editableInB;
  const companionBlocked = dualDocumentSplit()
    ? (secondary ? secondary.editBlock !== '' : true)
    : blocked || !editableInB;
  if (editor.readOnly !== primaryBlocked) editor.setReadOnly(primaryBlocked);
  if (!dualDocumentSplit() && companionEditor.readOnly !== companionBlocked) {
    companionEditor.setReadOnly(companionBlocked);
  }
  if (titleEditor.readOnly !== blocked) titleEditor.setReadOnly(blocked);
  for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = blocked;
  document.documentElement.dataset.role = editBlock !== '' ? 'reader' : 'editor';
  // Temporary transfer freeze must not announce "another window is editing".
  const guidance = transferFrozen ? '' : editBlockGuidance(editBlock, workspace.dirty());
  if (ownershipNotice.textContent !== guidance) ownershipNotice.textContent = guidance;
  ownershipNotice.hidden = !guidance;
  syncCompanionChrome();
  syncHistory();
  syncMutationControls();
  updateSaveIndicator();
}
/** Bumped on IndexedDB versionchange so in-flight acquires cannot install after storage dies. */
let storageGeneration = 0;
type EditAccess = { ownership?: EditOwnership; block: EditBlock; generation: number };
/**
 * Loss callbacks are rebound when a handle moves between sessions (promote B→A).
 * Without this, a secondary-acquired handle would keep ignoring primary loss after promote.
 */
const ownershipLostHandlers = new WeakMap<EditOwnership, () => void>();
function bindOwnershipLost(held: EditOwnership | undefined, handler: () => void): void {
  if (held) ownershipLostHandlers.set(held, handler);
}
function clearOwnershipLost(held: EditOwnership | undefined): void {
  if (held) ownershipLostHandlers.delete(held);
}
function handleHeldOwnershipLost(held: EditOwnership): void {
  const handler = ownershipLostHandlers.get(held);
  if (handler) { handler(); return; }
  if (ownership === held) loseOwnership();
}
function loseSecondaryOwnership(held: EditOwnership): void {
  if (!secondary || secondary.ownership !== held) return;
  secondary.ownership = undefined;
  secondary.editBlock = 'lost';
  clearTimeout(secondary.saveTimer);
  clearOwnershipLost(held);
  void held.release();
  companionEditor.setReadOnly(true);
  titleEditorB.setReadOnly(true);
  updateSaveIndicatorB();
  syncMutationControls();
}
/** Try to own `documentId` without waiting; never steals from a live owner. */
async function acquireFor(documentId: string): Promise<EditAccess> {
  // Without storage nothing can be written, so there is nothing to own.
  if (viewMode || !db) return { block: '', generation: storageGeneration };
  const generation = storageGeneration;
  // E2E may set a delay to assert mutations are frozen during ownership transfer (#159 W4).
  const delayMs = (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs;
  if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  if (generation !== storageGeneration || !db) return { block: 'error', generation: storageGeneration };
  let held: EditOwnership | undefined;
  try {
    const result = await acquireEditOwnership({
      db, locks: webLocks, documentId, instanceId,
      onLost: () => { if (held) handleHeldOwnershipLost(held); },
    });
    // E2E: hold the lock briefly before returning so a mid-flight versionchange can be asserted.
    const afterMs = (window as Window & { __typebridgeDelayAfterAcquireMs?: number }).__typebridgeDelayAfterAcquireMs;
    if (typeof afterMs === 'number' && afterMs > 0 && result.status === 'acquired') {
      await new Promise(resolve => setTimeout(resolve, afterMs));
    }
    if (generation !== storageGeneration || !db) {
      if (result.status === 'acquired') void result.ownership.release();
      return { block: 'error', generation: storageGeneration };
    }
    if (result.status !== 'acquired') return { block: result.status, generation };
    held = result.ownership;
    return { ownership: held, block: '', generation };
  } catch { return { block: 'error', generation: storageGeneration }; }
}

/** Freeze Editor + title gates and mutation controls for the ownership-transfer window. */
function freezeEditorsForTransition(): void {
  transferFrozen = true;
  workspace.setPaneRole('readonly');
  editor.setReadOnly(true);
  titleEditor.setReadOnly(true);
  // Same-document editable may live in B; freeze both surfaces so mid-switch typing is not lost.
  if (!dualDocumentSplit()) companionEditor.setReadOnly(true);
  for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = true;
  undo.disabled = true;
  redo.disabled = true;
  autosave.disabled = true;
  syncCompanionChrome();
}

function unfreezeEditorsAfterTransition(): void {
  transferFrozen = false;
  applyEditAccess();
}
/** Make `access` current and release whatever this window owned before. */
function installOwnership(access: EditAccess): void {
  let next = access;
  // Drop a handle acquired before storage was invalidated (versionchange mid-switch/boot).
  if (access.ownership && (access.generation !== storageGeneration || !db)) {
    void access.ownership.release();
    next = { block: access.block === '' ? 'error' : access.block, generation: storageGeneration };
  }
  const previous = ownership;
  ownership = next.ownership;
  editBlock = next.block;
  if (previous && previous !== ownership) void previous.release();
  applyEditAccess();
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
  const previous = ownership;
  ownership = undefined;
  editBlock = 'lost';
  clearTimeout(saveTimer);
  void previous?.release();
  applyEditAccess();
  showSaveState();
}
let ownershipRetry: Promise<void> | undefined;
/** A BroadcastChannel reread arrived while ownershipRetry held the transition; run after it finishes. */
let rereadAfterOwnershipRetry = false;
let secondaryOwnershipRetry: Promise<void> | undefined;
let rereadAfterSecondaryOwnershipRetry = false;
/**
 * A read-only ordinary window tries again when shown or focused; it becomes editor only if the lock is free.
 * Always rereads first (single-flight with the acquire): a concurrent refresh must not bump sessionGeneration
 * under an in-flight acquire and force a release that leaves the window stuck read-only.
 */
function retryOwnership(): void {
  const store = db;
  if (viewMode || !store || !mayRetryEditOwnership(editBlock) || ownershipRetry || transitioning || deleting || field.disabled) return;
  ownershipRetry = (async () => {
    await rereadDisplayed();
    if (!mayRetryEditOwnership(editBlock) || transitioning || deleting || field.disabled) return;
    const id = active.id;
    // Capture the view only after the preliminary reread so applying a missed revision does not
    // look like "the user navigated away" to stillHere().
    const view = workspace.sessionGeneration();
    const stillHere = (): boolean => active.id === id && workspace.sessionGeneration() === view && !transitioning && !deleting && mayRetryEditOwnership(editBlock);
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
      if (active.revision >= 1) showVersionNotice(DELETED_NOTICE);
      return;
    }
    // Authoritative snapshot under the new fence; unsaved text in memory is never replaced.
    // Always install when clean: Delete saved copy can recreate the same revision with new content.
    if (fresh) {
      writingPosition.save();
      active = fresh;
      showDraft();
    }
    installOwnership(access);
    announceAction('You can edit this document in this window now.', { keepConflict: true });
    if (workspace.dirty() && autosave.checked) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void persist(); }, 300); }
  })().finally(() => {
    ownershipRetry = undefined;
    if (!rereadAfterOwnershipRetry) return;
    rereadAfterOwnershipRetry = false;
    void rereadDisplayed();
  });
}
/** Read-only pane B retries ownership when focused or the tab becomes visible again. */
function retrySecondaryOwnership(): void {
  const store = db;
  const session = secondary;
  if (viewMode || !store || !session || !dualDocumentSplit() || !mayRetryEditOwnership(session.editBlock)
    || secondaryOwnershipRetry || companionOpenInFlight || field.disabled) return;
  secondaryOwnershipRetry = (async () => {
    await rereadSecondary();
    if (!secondary || secondary !== session || !mayRetryEditOwnership(session.editBlock) || !dualDocumentSplit()) return;
    const id = session.draft.id;
    const view = session.sessionGeneration;
    const stillHere = (): boolean => !!secondary && secondary === session && secondary.draft.id === id
      && secondary.sessionGeneration === view && mayRetryEditOwnership(secondary.editBlock) && dualDocumentSplit();
    if (!stillHere()) return;
    const access = await acquireFor(id);
    if (!access.ownership) return;
    let fresh: StoredDraft | undefined | null = null;
    try { if (stillHere() && !session.dirty) fresh = await getStoredDraft(store, id); }
    catch { void access.ownership.release(); return; }
    if (!stillHere()) { void access.ownership.release(); return; }
    if (fresh === undefined) {
      void access.ownership.release();
      if (session.draft.revision >= 1) showVersionNotice(DELETED_NOTICE, 'secondary');
      return;
    }
    if (fresh) {
      companionWritingPosition.save();
      loadingDraft = true;
      try {
        session.draft = fresh;
        companionEditor.load(fresh.text);
        if (fresh.history) companionEditor.restoreHistory(fresh.history);
        draftTitleB.value = fresh.title;
      } finally { loadingDraft = false; }
      companionWritingPosition.restore(fresh.id);
      clearVersionNotice('secondary');
    }
    session.ownership = access.ownership;
    session.editBlock = access.block;
    bindOwnershipLost(access.ownership, () => loseSecondaryOwnership(access.ownership!));
    companionEditor.setReadOnly(!!access.block);
    titleEditorB.setReadOnly(!!access.block);
    updateSaveIndicatorB();
    syncMutationControls();
    announceAction('You can edit this document in the other pane now.', { keepConflict: true });
    if (session.dirty && autosave.checked) {
      clearTimeout(session.saveTimer);
      session.saveTimer = setTimeout(() => { void persistSecondary(); }, 300);
    }
  })().finally(() => {
    secondaryOwnershipRetry = undefined;
    if (!rereadAfterSecondaryOwnershipRetry) return;
    rereadAfterSecondaryOwnershipRetry = false;
    void rereadSecondary();
  });
}
async function persist(): Promise<PersistResult> {
  if (viewMode) return { saved: true, conflict: false };
  clearTimeout(saveTimer);
  if (deleting || !autosave.checked || !workspace.dirty()) return { saved: !workspace.dirty(), conflict: false };
  if (editBlock) return { saved: false, conflict: false };
  if (saving) return saving;
  saving = (async () => {
    // E2E may delay the in-flight save so Autosave-off can race a document switch (#159 W4).
    const delayMs = (window as Window & { __typebridgeDelayPersistMs?: number }).__typebridgeDelayPersistMs;
    if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    let createdConflict = false;
    try {
      if (!db) throw new Error('Storage unavailable');
      while (workspace.dirty() && autosave.checked && !editBlock) {
        const version = workspace.contentRevision();
        const saved = snapshot();
        if (ownership?.documentId !== saved.id) throw new EditOwnershipLostError();
        const owner = await ownership.writeFence();
        const journal = currentJournal && currentJournal.documentId === saved.id && currentJournal.revision === active.revision && currentJournal.text === saved.text && currentJournal.title === saved.title ? currentJournal : undefined;
        const result = await commitOrCreateConflictCopy(db, saved, active.revision, crypto.randomUUID(), owner);
        clearPending(saved);
        const titleOnly = !result.conflict && saved.title !== active.title && saved.text === active.text;
        if (journal) { try { clearRecovery(localStorage, journal); } catch { /* Retain a recoverable entry on storage errors. */ } }
        active = result.draft;
        clearVersionNotice('primary');
        postSignal(titleOnly ? 'renamed' : 'saved', result.draft.id, result.draft.revision);
        writingPosition.save();
        if (workspace.contentRevision() !== version && autosave.checked) journalEdit();
        rememberActive();
        saveFailed = false;
        workspace.setDirty(workspace.contentRevision() !== version);
        updateSaveIndicator();
        if (result.conflict) {
          // Conflict copy is a new document id; keep the workspace identity in sync
          // without bumping sessionGeneration mid-persist (same in-flight save stream).
          workspace.setDocumentId(result.draft.id);
          // Retain new edits typed while the transaction was in flight.
          if ((draftTitle.value.trim() || UNTITLED_TITLE) === saved.title) {
            draftTitle.value = active.title;
            syncTitleTooltip();
          }
          // Storage may have become unusable while the copy was written.
          createdConflict = true;
          // While switching, leave announcement to switchDraft so early returns and
          // the success path each announce once (avoids CONFLICT_COPY then LEFT).
          if (!transitioning) setConflict(CONFLICT_COPY, true);
          updateStatus({
            primary: workspace.dirty() && !storageProblem ? 'Saving…' : '',
            risk: riskText(),
          }, transitioning ? statusKind : 'conflict');
          // The copy is a new document; later saves in this loop need its fence.
          await takeOwnership(result.draft.id);
        }
        // A background save must not replace newer action feedback or a conflict
        // notice, but it must replace progress and an earlier failure it resolved.
        // Use statusKind (not merely a pending conflict string) so an action that
        // kept a conflict notice — e.g. a failed draft switch — is not wiped.
        if (!workspace.dirty() && !result.conflict && (statusKind === 'progress' || statusKind === 'failure' || statusKind === 'conflict')) {
          // Storage can become unusable while this save was in flight (an
          // upgrade in another tab); never replace that warning.
          const risk = riskText();
          if (risk) setRiskStatus('', 'failure', risk);
          else setSaveStatus('Saved locally');
        }
      }
      try { await refreshDrafts(); }
      catch {
        if (shouldAttachDraftListRefreshFailure()) markDraftListRefreshFailed();
      }
      return { saved: !workspace.dirty(), conflict: createdConflict };
    } catch (error) {
      if (error instanceof EditOwnershipLostError) {
        loseOwnership();
        return { saved: false, conflict: createdConflict };
      }
      saveFailed = true;
      // Keep newer action feedback that already carries this exact warning;
      // keep a conflict notice in front of the warning; otherwise show risk alone.
      const risk = riskText() || SAVE_FAILED;
      if (statusMessage.primary && statusMessage.risk === risk) updateStatus({}, 'failure');
      else setRiskStatus('', 'failure', risk);
      return { saved: false, conflict: createdConflict };
    }
  })();
  try { return await saving; } finally {
    saving = undefined;
    // An edit can arrive while the post-commit draft list is loading.
    if (!deleting && workspace.dirty() && autosave.checked && !saveFailed && !editBlock) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persist(); }, 300);
    }
  }
}
function scheduleSave(fromTitle = false): void {
  if (readOnlyNow() || loadingDraft || suppressEditTracking) return;
  const becameDirty = !workspace.dirty();
  workspace.setDirty(true);
  workspace.bumpContentRevision();
  journalEdit();
  // With autosave off nothing is committed, so refresh the Documents label from the
  // on-screen title (and mark unsaved) without waiting for a save (#114).
  if (!autosave.checked && (becameDirty || fromTitle)) renderDrafts();
  clearTimeout(saveTimer);
  if (autosave.checked) { showSaving(); saveTimer = setTimeout(() => { void persist(); }, 300); }
  else showSaveState();
}
field.addEventListener('input', () => {
  if (sameDocEditableInB()) return;
  scheduleSave();
  mirrorCompanion();
});
field.addEventListener('historychange', () => {
  if (sameDocEditableInB()) return;
  scheduleSave();
  mirrorCompanion();
});
companionField.addEventListener('input', () => {
  if (dualDocumentSplit()) scheduleSaveSecondary();
  else if (sameDocEditableInB()) { scheduleSave(); mirrorCompanion(); }
});
companionField.addEventListener('historychange', () => {
  if (dualDocumentSplit()) { scheduleSaveSecondary(); syncHistory(); }
  else if (sameDocEditableInB()) { scheduleSave(); mirrorCompanion(); syncHistory(); }
});
draftTitleB.addEventListener('focus', () => {
  if (!dualDocumentSplit()) return;
  activatePane(SECOND_PANE_ID);
});
draftTitleB.addEventListener('input', () => {
  if (dualDocumentSplit()) scheduleSaveSecondary(true);
});
draftTitle.addEventListener('focus', () => {
  activatePane(PRIMARY_PANE_ID);
});
function syncTitleTooltip(): void {
  // Ellipsis may clip the field; the value and tooltip keep the full title (#156).
  draftTitle.title = draftTitle.value.trim() || UNTITLED_TITLE;
}
syncTitleTooltip();
draftTitle.addEventListener('input', () => { syncTitleTooltip(); scheduleSave(true); });
/** While Autosave is toggling (including delete-saved-copy), document switches wait. */
let autosaveToggleGate: Promise<void> | undefined;
let releaseAutosaveToggleGate: (() => void) | undefined;
function beginAutosaveToggleGate(): void {
  if (autosaveToggleGate) return;
  autosaveToggleGate = new Promise(resolve => {
    releaseAutosaveToggleGate = () => {
      autosaveToggleGate = undefined;
      releaseAutosaveToggleGate = undefined;
      resolve();
    };
  });
}
function endAutosaveToggleGate(): void {
  releaseAutosaveToggleGate?.();
}
autosave.addEventListener('change', async () => {
  if (autosaveControlBlocked() || autosaveToggleActive) return;
  autosaveToggleActive = true;
  autosave.disabled = true;
  beginAutosaveToggleGate();
  try {
  try { setAutosaveEnabled(autosave.checked); preferenceSaved('autosave', true); }
  catch { preferenceSaved('autosave', false); }
  // Always show the accurate save state. Without storage, no save can succeed: keep saying so.
  const announce = (text: string): void => {
    // storageProblem, not !db: db is also unset while initialization runs.
    if (storageProblem) setSaveStatus(riskText(), 'failure');
    else setSaveStatus(text);
  };
  if (autosave.checked) {
    clearNotices();
    if (workspace.dirty()) showSaving(); else announce('Autosave on');
    if (workspace.dirty()) { journalEdit(); void persist(); }
    if (secondary?.dirty && !secondary.editBlock) {
      updateSaveIndicatorB();
      void persistSecondary();
    }
  }
  else {
    clearTimeout(saveTimer);
    if (secondary) {
      clearTimeout(secondary.saveTimer);
      updateSaveIndicatorB();
    }
    const companionActive = workspace.activePaneId() === SECOND_PANE_ID
      && dualDocumentSplit() && !!secondary && secondary.editBlock === '';
    if (companionActive && secondary) {
      // Bind deletion to the companion document before any await.
      const startedSession = secondary;
      const startedId = secondary.draft.id;
      const startedOwnership = secondary.ownership;
      const inFlight = secondary.saving ? await secondary.saving : undefined;
      if (!inFlight?.conflict) clearNotices();
      const stayed = secondary === startedSession && secondary.draft.id === startedId
        && secondary.ownership === startedOwnership;
      // Conflict copies update draft/ownership in place on the same session object.
      const conflictCopy = !!(inFlight?.conflict && secondary && secondary.ownership
        && secondary.ownership !== startedOwnership && secondary.draft.id !== startedId);
      if (!stayed && !conflictCopy) {
        updateSaveIndicatorB();
        announce(AUTOSAVE_OFF);
        return;
      }
      const targetId = secondary.draft.id;
      const targetRevision = secondary.draft.revision;
      const targetOwnership = secondary.ownership!;
      const deleteSaved = await askConfirmChoice({
        title: 'Delete the saved copy?',
        message: 'Delete the saved copy of this document? Keep saved copy leaves it in your Documents list.',
        confirmLabel: 'Delete saved copy',
        cancelLabel: 'Keep saved copy',
        returnFocus: autosave,
      });
      if (deleteSaved) {
        try {
          if (!db || !secondary || targetOwnership.documentId !== targetId) throw new Error('Storage unavailable');
          if (secondary.draft.id !== targetId || secondary.ownership !== targetOwnership
            || secondary.editBlock || transferFrozen || transitioning) {
            throw new Error('Document changed');
          }
          if (!await deleteStoredDraft(db, targetId, targetRevision, await targetOwnership.writeFence())) {
            throw new Error('Draft changed');
          }
          if (targetRevision >= 1) postSignal('deleted', targetId, targetRevision);
          if (secondary && secondary.draft.id === targetId) {
            secondary.draft = { ...secondary.draft, revision: 0 };
            secondary.dirty = true;
          }
          clearNotices();
          await refreshDrafts();
        } catch (error) {
          if (error instanceof EditOwnershipLostError && secondary?.ownership) {
            loseSecondaryOwnership(secondary.ownership);
          }
          announceAction('Could not delete saved document; current text is kept', { keepConflict: true });
          return;
        }
      }
      updateSaveIndicatorB();
      announce(AUTOSAVE_OFF);
      return;
    }
    // Bind deletion to this document before any await — defense if a switch somehow races the gate.
    const startedId = active.id;
    const startedOwnership = ownership;
    // Await an in-flight save without clearing first — it may create a conflict copy
    // that the delete prompt then targets, and the user must see that notice.
    // Older conflict notices still clear when the toggle did not itself create one.
    const inFlight = saving ? await saving : undefined;
    if (!inFlight?.conflict) clearNotices();
    const stayed = active.id === startedId && ownership === startedOwnership;
    const conflictCopy = !!(inFlight?.conflict && ownership && ownership !== startedOwnership && active.id !== startedId);
    // Navigated away during the wait: do not offer to delete a different document's saved copy.
    if (!stayed && !conflictCopy) {
      updateSaveIndicatorB();
      announce(AUTOSAVE_OFF);
      return;
    }
    const targetId = active.id;
    const targetRevision = active.revision;
    const targetOwnership = ownership!;
    // returnFocus is the checkbox itself: it is disabled for this handler, so
    // capture it here and let askConfirmChoice restore after finally re-enables.
    const deleteSaved = await askConfirmChoice({
      title: 'Delete the saved copy?',
      message: 'Delete the saved copy of this document? Keep saved copy leaves it in your Documents list.',
      confirmLabel: 'Delete saved copy',
      cancelLabel: 'Keep saved copy',
      returnFocus: autosave,
    });
    if (deleteSaved) {
      try {
        // Keep the fence: this window goes on editing the same id privately.
        if (!db || targetOwnership.documentId !== targetId) throw new Error('Storage unavailable');
        if (active.id !== targetId || ownership !== targetOwnership || editBlock || transferFrozen || transitioning) {
          throw new Error('Document changed');
        }
        if (!await deleteStoredDraft(db, targetId, targetRevision, await targetOwnership.writeFence())) throw new Error('Draft changed');
        if (targetRevision >= 1) postSignal('deleted', targetId, targetRevision);
        if (active.id === targetId) {
          active = { ...active, revision: 0 };
          workspace.setDirty(true);
        }
        clearNotices();
        await refreshDrafts();
      } catch (error) {
        if (error instanceof EditOwnershipLostError) loseOwnership();
        announceAction('Could not delete saved document; current text is kept', { keepConflict: true });
        return;
      }
    }
    updateSaveIndicatorB();
    announce(AUTOSAVE_OFF);
  }
  } finally {
    endAutosaveToggleGate();
    autosaveToggleActive = false;
    updateSaveIndicatorB();
    // Match syncAutosaveControl — companion-active sessions can toggle while A is blocked.
    autosave.disabled = autosaveControlBlocked();
    // Re-focus after re-enabling: the dialog cannot restore while this control
    // is disabled, and a delete may await before this finally runs (#114 review).
    autosave.focus({ preventScroll: true });
  }
});
async function switchDraft(id?: string): Promise<SwitchResult> {
  if (viewMode || transitioning) return { opened: false, conflict: false };
  if (autosaveToggleGate) await autosaveToggleGate;
  if (transitioning) return { opened: false, conflict: false };
  if (id && secondary && id === secondary.draft.id) {
    transitioning = true;
    try {
      if (!(await promoteSecondaryToPrimary())) return { opened: false, conflict: false };
      return { opened: true, conflict: false };
    } finally {
      transitioning = false;
      unfreezeEditorsAfterTransition();
      renderDrafts();
    }
  }
  if (id === active.id) { renderDrafts(); return { opened: true, conflict: false }; }
  transitioning = true;
  let flushConflict = false;
  /** Announce a flush conflict when the switch does not open another draft. */
  const announceAbortedFlushConflict = (): void => {
    if (flushConflict) setConflict(CONFLICT_COPY);
  };
  let acquired: EditOwnership | undefined;
  try {
    clearTimeout(saveTimer);
    let next: StoredDraft | undefined;
    while (true) {
      while (workspace.dirty() && autosave.checked && !editBlock) {
        const result = await persist();
        if (result.conflict) flushConflict = true;
        if (!result.saved && saveFailed) {
          announceAbortedFlushConflict();
          return { opened: false, conflict: flushConflict };
        }
      }
      // Text this window cannot save (Autosave off, or another window owns the document) needs consent to drop.
      if (workspace.dirty() && (!autosave.checked || editBlock) && !await askConfirmChoice({ title: 'Discard unsaved changes?', message: editBlock
        ? 'Another window is editing this document, so this window cannot save these changes. Copy or export them first to keep them.'
        : 'Copy or export unsaved changes first to keep them.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! })) {
        announceAbortedFlushConflict();
        return { opened: false, conflict: flushConflict };
      }
      const version = workspace.contentRevision();
      next = id && db ? await getStoredDraft(db, id) : undefined;
      if (id && !next) throw new Error('Draft no longer exists');
      if (workspace.contentRevision() === version) break;
    }
    // Freeze Editor mutation gates (not only DOM readOnly) for the whole acquire/reread window.
    freezeEditorsForTransition();
    let target = next ?? { ...newDraft(), revision: 0 };
    const access = await acquireFor(target.id);
    acquired = access.ownership;
    if (acquired && next && db) {
      // Reread under the new fence: the previous owner may have saved just before releasing.
      const fresh = await getStoredDraft(db, next.id);
      if (!fresh) throw new Error('Draft no longer exists');
      target = fresh;
    }
    writingPosition.save();
    active = target;
    rememberActive();
    showDraft();
    installOwnership(access);
    acquired = undefined;
    // Always show the opened draft's save state — pre-switch action feedback must not stick.
    showSaveState();
    // Flush announced nothing while transitioning; name the draft that was left once.
    if (flushConflict) setConflict(CONFLICT_COPY_LEFT);
    void refreshDrafts().catch(() => {
      if (shouldAttachDraftListRefreshFailure()) markDraftListRefreshFailed();
    });
    return { opened: true, conflict: flushConflict };
  } catch {
    void acquired?.release();
    announceAbortedFlushConflict();
    announceAction('Could not open document — current text was kept', { keepConflict: flushConflict });
    return { opened: false, conflict: flushConflict };
  }
  finally {
    transitioning = false;
    unfreezeEditorsAfterTransition();
    renderDrafts();
  }
}
document.querySelector<HTMLButtonElement>('#new-draft')!.addEventListener('click', () => { void switchDraft(); });
for (const picker of documentPickers) {
  picker.addEventListener('change', () => { void (viewMode ? viewerOpen(picker.value) : switchDraft(picker.value)); });
}
paneBDrafts.addEventListener('change', () => {
  if (transitioning) { renderPaneBDrafts(); return; }
  void openCompanionDocument(paneBDrafts.value);
});
document.querySelector<HTMLButtonElement>('#delete-draft')!.addEventListener('click', async () => {
  if (readOnlyNow() || transitioning) return;
  clearTimeout(saveTimer);
  const requestedId = active.id;
  if (!await askConfirmChoice({ title: 'Delete document?', message: 'Permanently delete this saved document?', confirmLabel: 'Delete document', cancelLabel: 'Keep document', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! })) {
    if (workspace.dirty() && autosave.checked) saveTimer = setTimeout(() => { void persist(); }, 300);
    return;
  }
  transitioning = true;
  freezeEditorsForTransition();
  let committed = false;
  let savedBeforeDelete = false;
  try {
    if (saving && !(await saving).saved) throw new Error('Save failed');
    if (workspace.dirty() && autosave.checked) {
      if (!(await persist()).saved) throw new Error('Save failed');
      savedBeforeDelete = true;
    }
    if (active.id !== requestedId) {
      announceAction('Could not delete original — your changes were saved as a conflict copy.');
      return;
    }
    deleting = true;
    const deletedRevision = active.revision;
    if (!db) throw new Error('Storage unavailable');
    if (!ownership || ownership.documentId !== active.id) throw new EditOwnershipLostError();
    if (!await deleteStoredDraft(db, active.id, active.revision, await ownership.writeFence(), true)) throw new Error('Draft changed in another tab');
    committed = true;
    if (deletedRevision >= 1) postSignal('deleted', active.id, deletedRevision);
    clearTimeout(saveTimer);
    writingPosition.save();
    const replacement: StoredDraft = { ...newDraft(), revision: 0 };
    const access = await acquireFor(replacement.id);
    active = replacement;
    rememberActive();
    // The deletion is durable; clear the editor before a fallible list refresh.
    showDraft();
    installOwnership(access);
    try { await refreshDrafts(); announceAction('Document deleted'); }
    catch { announceAction('Document deleted, but the document list could not be refreshed'); }
  } catch (error) {
    if (error instanceof EditOwnershipLostError) loseOwnership();
    // Without storage, announceAction() adds the storage warning; no save will follow.
    // Explicit delete failures clear conflict feedback; these two messages already
    // state the save situation, so they do not also append riskText().
    if (editBlock) {
      announceAction('Could not delete document — another window is editing it. Your text is kept.', { kind: 'failure' });
    } else if (workspace.dirty() && !saveFailed && autosave.checked && !storageProblem) {
      announceAction('Could not delete document — your changes are unsaved; saving again…', { kind: 'progress', omitRisk: true });
    } else if (workspace.dirty() && !autosave.checked && !storageProblem) {
      announceAction('Could not delete document — your changes are unsaved; autosave is off', { kind: 'progress', omitRisk: true });
    } else announceAction(savedBeforeDelete ? 'Could not delete document — Saved locally; your text is kept.' : 'Could not delete document — your text is kept.');
  } finally {
    transitioning = false;
    deleting = false;
    unfreezeEditorsAfterTransition();
    if (!committed && workspace.dirty() && autosave.checked && !editBlock) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persist(); }, 300);
    }
  }
});
const recoveryNotice = document.createElement('div');
recoveryNotice.setAttribute('role', 'alert');
recoveryNotice.hidden = true;
status.parentElement?.before(recoveryNotice);
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryRenderVersion = 0;
let panelSignature = '';
let inspectUnknownOwners = false;
async function ownerIsActive(tab: string): Promise<boolean | undefined> {
  if (!ownershipAvailable) return undefined;
  try { return (await navigator.locks.query()).held?.some(lock => lock.name === OWNER_LOCK + tab) ?? false; }
  catch { return undefined; }
}
function queueRecovery(): void {
  if (recoveryTimer) return;
  recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void renderRecovery(); }, 1200);
}
async function renderRecovery(): Promise<void> {
  const version = ++recoveryRenderVersion;
  let entries: RecoverySnapshot[];
  try { entries = listRecovery(localStorage).filter(item => item.tab !== journalTab); }
  catch { journalWarning.textContent = 'Emergency backups cannot be read. Copy or export unsaved text.'; journalWarning.hidden = false; return; }
  const candidates: { item: RecoverySnapshot; unknown: boolean }[] = [];
  for (const item of entries) {
    const activeOwner = await ownerIsActive(item.tab);
    if (activeOwner === true) continue;
    // A committed exact document or idempotent recovery copy makes only this
    // precise journal version redundant; newer revisions are never overwritten.
    try {
      if (db) {
        const original = await getStoredDraft(db, item.documentId);
        const recovered = await getStoredDraft(db, 'recovery-' + item.token);
        if ((original?.title === item.title && original.text === item.text) ||
            (recovered?.title === item.title + ' (recovered)' && recovered.text === item.text)) {
          clearRecovery(localStorage, item);
          continue;
        }
      }
    } catch { /* A failed check must never discard a potentially unsaved snapshot. */ }
    candidates.push({ item, unknown: activeOwner === undefined });
  }
  if (version !== recoveryRenderVersion) return;
  const signature = JSON.stringify({ candidates, inspectUnknownOwners });
  if (signature === panelSignature) return;
  panelSignature = signature;
  recoveryPanel.replaceChildren();
  if (!ownershipAvailable && !inspectUnknownOwners) {
    const inspect = document.createElement('button');
    inspect.type = 'button'; inspect.textContent = 'Check emergency backups';
    inspect.addEventListener('click', () => { inspectUnknownOwners = true; panelSignature = ''; void renderRecovery(); });
    recoveryPanel.append(inspect); return;
  }
  if (!candidates.length) return;
  const heading = document.createElement('p');
  heading.textContent = ownershipAvailable ? 'Emergency backups found. Recover a copy without changing your current document:' : 'Ownership cannot be verified; these backups may belong to open tabs. Recover a copy without changing your current document:';
  recoveryPanel.append(heading);
  for (const { item, unknown } of candidates) {
    const group = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Recover ${item.title} (${new Date(item.timestamp).toLocaleString()})`;
    if (unknown) button.title = 'Tab ownership could not be verified; the original tab may still be open.';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        if (await ownerIsActive(item.tab) === true) throw new Error('The original tab is still open');
        if (!db) throw new Error('Storage unavailable');
        const copy = { id: 'recovery-' + item.token, title: item.title + ' (recovered)', text: item.text, updatedAt: item.timestamp };
        const result = await commitDraft(db, copy, 0);
        if (!result.ok && (!result.current || result.current.title !== copy.title || result.current.text !== copy.text)) throw new Error('Recovery copy already changed');
        if (result.ok) postSignal('saved', result.draft.id, result.draft.revision);
        clearRecovery(localStorage, item);
        await refreshDrafts();
        announceAction('Recovered a copy in Documents. Your current document was kept.');
        panelSignature = ''; await renderRecovery();
      } catch { announceAction('Recovery failed. The emergency backup was kept; retry or copy your text.'); button.disabled = false; }
    });
    const discard = document.createElement('button');
    discard.type = 'button'; discard.textContent = `Discard backup for ${item.title}`;
    discard.addEventListener('click', async () => {
      if (await ownerIsActive(item.tab) === true) { announceAction('The original tab is still open; backup kept.'); queueRecovery(); return; }
      if (!await askConfirmChoice({ title: 'Discard emergency backup?', message: 'Unsaved text in this backup will be lost.', confirmLabel: 'Discard backup', cancelLabel: 'Keep backup', returnFocus: accepted => accepted ? field : discard })) return;
      try { clearRecovery(localStorage, item); panelSignature = ''; await renderRecovery(); }
      catch { announceAction('Could not discard backup; it was kept.'); }
    });
    group.append(button, discard); recoveryPanel.append(group);
  }
}
if (!viewMode) {
  window.addEventListener('storage', event => { if (event.key?.startsWith(RECOVERY_PREFIX)) queueRecovery(); });
  setInterval(queueRecovery, 5000);
}
function handleDatabaseUpgrade(): void {
  // Invalidate in-flight acquires, then free any installed Web Lock so an upgraded tab can own.
  storageGeneration++;
  const previous = ownership;
  ownership = undefined;
  clearTimeout(saveTimer);
  void previous?.release();
  if (secondary) {
    clearTimeout(secondary.saveTimer);
    const secondaryOwnership = secondary.ownership;
    secondary.ownership = undefined;
    secondary.editBlock = 'error';
    void secondaryOwnership?.release();
    companionEditor.setReadOnly(true);
    titleEditorB.setReadOnly(true);
    updateSaveIndicatorB();
  }
  db = undefined;
  storageProblem = 'Storage was upgraded in another tab. Copy or export unsaved text, then reload.';
  recoveryNotice.hidden = false;
  recoveryNotice.textContent = storageProblem;
  // A later upgrade must not erase an earlier conflict-copy notice (#66).
  setRiskStatus('', 'failure');
  applyEditAccess();
  syncMutationControls();
}
async function initializeDrafts(): Promise<void> {
  await ownerReady;
  let bootAccess: EditAccess | undefined;
  try {
    db = await openDraftDatabase(handleDatabaseUpgrade);
    drafts = await listStoredDrafts(db);
    let selected: string | null = null;
    try { selected = sessionStorage.getItem('typebridge.activeDraft.v1'); } catch { /* Optional hint. */ }
    const pending = readPending();
    const committed = pending && drafts.find(d => d.id === pending.id);
    if (pending && committed && sameContent(pending, committed)) clearPending(pending);
    const restorePending = !!pending && (!committed || !sameContent(pending, committed));
    let chosen = restorePending ? pending! : drafts.find(d => d.id === selected) ?? drafts[0] ?? active;
    // First acquirer among cooperating windows edits; the others open this document read-only.
    bootAccess = await acquireFor(chosen.id);
    // The list was read before this window owned the document; reread under the fence.
    if (bootAccess.ownership && !restorePending) {
      const fresh = await getStoredDraft(db, chosen.id);
      if (!fresh) {
        // Deleted while we acquired — do not install ownership over the stale list snapshot.
        void bootAccess.ownership.release();
        bootAccess = undefined;
        chosen = { ...newDraft(), revision: 0 };
        bootAccess = await acquireFor(chosen.id);
      } else {
        chosen = fresh;
      }
    }
    active = chosen;
    rememberActive();
    showDraft();
    installOwnership(bootAccess);
    bootAccess = undefined;
    if (restorePending) {
      workspace.setDirty(true); workspace.bumpContentRevision();
      applyEditAccess();
      // Another window owns the document: keep the recovered text here (and its reload backup) for copy/export.
      if (editBlock) setSaveStatus('Recovered unsaved text, but another window is editing this document, so it was not saved. Copy or export it.', 'failure');
      else if (autosave.checked) { setSaveStatus('Recovered unsaved text; saving…'); await persist(); }
      else setSaveStatus('Recovered unsaved text; autosave is off');
    } else if (editBlock) showSaveState();
  } catch (error) {
    void bootAccess?.ownership?.release();
    db?.close(); db = undefined;
    const pending = readPending();
    if (pending) { active = pending; showDraft(); workspace.setDirty(true); workspace.bumpContentRevision(); saveFailed = true; }
    storageProblem = error instanceof Error && error.message.startsWith('Database upgrade blocked.') ? error.message : STORAGE_UNAVAILABLE;
    setSaveStatus(storageProblem, 'failure');
    renderDrafts();
  } finally {
    draftsInitialized = true;
    updateStats();
    // Keep primary+companion disabled until pending-B restore finishes so it cannot
    // overwrite edits the user makes in a ready UI.
    paneBDrafts.disabled = true;
  }
  try {
    await restorePendingSecondary();
  } finally {
    field.disabled = false;
    draftSelect.disabled = false;
    draftTitle.disabled = false;
    paneBDrafts.disabled = false;
    applyEditAccess();
    // Focus mode must restore after the textarea is enabled — focus() is a no-op while disabled.
    restoreFocusMode();
    writingPosition.restore(active.id);
    renderPaneBDrafts();
    void renderRecovery();
    finishInitialization();
  }
}

/**
 * Install a recovery-only pane-B session from a pending snapshot (no ownership / optional no DB).
 * Keeps the unsaved text reachable for copy/export even when storage is unavailable.
 */
function installRecoveryOnlySecondary(pending: StoredDraft, access?: EditAccess): boolean {
  if (viewMode || pending.id === active.id) return false;
  if (!workspace.splitOpen()) splitControls.setOpen(true);
  if (pending.id === active.id || !workspace.splitOpen()) {
    void access?.ownership?.release();
    return false;
  }
  companionWritingPosition.save();
  loadingDraft = true;
  try {
    companionEditor.setReadOnly(false);
    titleEditorB.setReadOnly(false);
    companionEditor.load(pending.text);
    if (pending.history) companionEditor.restoreHistory(pending.history);
    draftTitleB.value = pending.title;
    draftTitleB.hidden = false;
  } finally {
    loadingDraft = false;
  }
  secondary = createBoundSession({
    sessionId: 'session-2',
    editablePaneId: SECOND_PANE_ID,
    draft: { ...pending },
    editor: companionEditor,
    field: companionField,
    title: draftTitleB,
  });
  secondary.ownership = access?.ownership;
  secondary.editBlock = access?.block ?? '';
  secondary.dirty = true;
  secondary.contentRevision = 1;
  if (access?.ownership) {
    bindOwnershipLost(access.ownership, () => {
      if (access.ownership) loseSecondaryOwnership(access.ownership);
    });
  }
  if (access?.block) {
    companionEditor.setReadOnly(true);
    titleEditorB.setReadOnly(true);
  }
  sessionRegistry.setSecondary(secondary);
  companionWritingPosition.restore(pending.id);
  updateSaveIndicatorB();
  syncCompanionChrome();
  renderPaneBDrafts();
  syncMutationControls();
  return true;
}

/**
 * Install a pane-B session from a pending snapshot when its IndexedDB row is gone.
 * Keeps the unsaved text reachable for copy/export/recovery even without a backing document.
 */
async function installOrphanPendingSecondary(pending: StoredDraft): Promise<boolean> {
  if (viewMode || !db || pending.id === active.id) return false;
  if ((await releaseSecondarySession()) === 'cancelled') return false;
  if (pending.id === active.id || !workspace.splitOpen()) return false;
  const access = await acquireFor(pending.id);
  return installRecoveryOnlySecondary(pending, access);
}

/** Restore a pane-B reload snapshot after the primary session is live. */
async function restorePendingSecondary(): Promise<void> {
  if (viewMode) return;
  const pending = readPendingB();
  if (!pending) return;
  // Same document as primary cannot be a second editable session; keep recovery journal only.
  if (pending.id === active.id) return;
  bootRestoringSecondary = true;
  paneBDrafts.disabled = true;
  try {
    if (!db) {
      if (installRecoveryOnlySecondary(pending)) {
        setSaveStatus(
          'Recovered unsaved text in the other pane; browser storage is unavailable. Copy or export it.',
          'failure',
        );
      }
      return;
    }
    // E2E may delay the IDB read so a concurrent open can race the restore.
    const delayMs = (window as Window & { __typebridgeDelayPendingSecondaryMs?: number }).__typebridgeDelayPendingSecondaryMs;
    if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    let committed: StoredDraft | undefined;
    try { committed = await getStoredDraft(db, pending.id); }
    catch { committed = undefined; }
    if (committed && sameContent(pending, committed)) {
      clearPendingSecondary(pending);
      return;
    }
    if (!workspace.splitOpen()) splitControls.setOpen(true);
    const generationBeforeOpen = companionOpenGeneration;
    let openedExisting = false;
    if (committed && committed.revision >= 1) {
      await openCompanionDocument(pending.id);
      // A newer user pick (generation advanced past this open) wins over boot restore.
      if (companionOpenGeneration !== generationBeforeOpen + 1) return;
      openedExisting = !!secondary && secondary.draft.id === pending.id;
    }
    if (!openedExisting) {
      if (!(await installOrphanPendingSecondary(pending))) return;
    } else {
      // Never clobber a session the user already dirtied while restore awaited.
      if (!secondary || secondary.dirty || secondary.contentRevision !== 0) return;
      const sessionId = secondary.sessionId;
      const contentAtOpen = secondary.contentRevision;
      companionWritingPosition.save();
      loadingDraft = true;
      try {
        if (!secondary || secondary.sessionId !== sessionId || secondary.draft.id !== pending.id) return;
        if (secondary.dirty || secondary.contentRevision !== contentAtOpen) return;
        companionEditor.load(pending.text);
        if (pending.history) companionEditor.restoreHistory(pending.history);
        draftTitleB.value = pending.title;
        secondary.draft = { ...pending };
        secondary.dirty = true;
        secondary.contentRevision += 1;
      } finally {
        loadingDraft = false;
      }
      if (!secondary || secondary.sessionId !== sessionId) return;
      companionWritingPosition.restore(pending.id);
      updateSaveIndicatorB();
      syncMutationControls();
    }
    if (!secondary) return;
    if (secondary.editBlock) {
      setSaveStatus('Recovered unsaved text in the other pane, but another window is editing that document, so it was not saved. Copy or export it.', 'failure');
    } else if (autosave.checked) {
      setSaveStatus('Recovered unsaved text in the other pane; saving…');
      await persistSecondary();
    } else {
      setSaveStatus('Recovered unsaved text in the other pane; autosave is off');
    }
  } finally {
    bootRestoringSecondary = false;
  }
}

const viewerBadge = document.querySelector<HTMLElement>('#viewer-badge')!;
const viewerNotice = document.querySelector<HTMLElement>('#viewer-notice')!;
const VIEWER_STATUS = 'Read-only view of the saved version. Nothing is saved from this window.';
const VIEWER_MISSING = 'This saved document is no longer available, or the link is not valid. Choose another saved document from Documents. Nothing was created.';
const VIEWER_STORAGE = 'Browser storage is unavailable in this window, so the saved document cannot be shown. Nothing was changed.';
const VIEWER_DISABLED_CONTROLS = ['new-draft', 'import-draft', 'delete-draft', 'open-comparison', 'toggle-split', 'undo', 'redo',
  'convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'];
/** Controls that only make sense while a saved document is shown. */
const VIEWER_NEEDS_DOCUMENT = ['export-txt', 'export-json', 'copy'];
function applyViewerChrome(): void {
  document.body.classList.add('viewer');
  document.documentElement.dataset.role = 'viewer';
  document.title = 'Comparison · TypeBridge';
  saveIndicator.hidden = true;
  viewerBadge.hidden = false;
  field.readOnly = true;
  draftTitle.readOnly = true;
  autosave.disabled = true;
  for (const id of VIEWER_DISABLED_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = true;
}
function showViewerStatus(): void {
  if (storageProblem) setSaveStatus(storageProblem, 'failure');
  else setSaveStatus(viewMissing ? '' : VIEWER_STATUS);
}
function showViewerMissing(message: string): void {
  workspace.bumpSessionGeneration();
  workspace.setDocumentId('');
  viewMissing = true;
  loadingDraft = true;
  try { editor.load(''); draftTitle.value = ''; syncTitleTooltip(); }
  finally { loadingDraft = false; }
  active = { ...newDraft(), revision: 0 };
  workspace.setDirty(false);
  viewerNotice.textContent = message;
  viewerNotice.hidden = false;
  viewerBadge.textContent = 'Read-only comparison view';
  for (const id of VIEWER_NEEDS_DOCUMENT) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = true;
  renderDrafts();
  updateStats();
  showViewerStatus();
}
function showViewerDocument(draft: StoredDraft): void {
  viewMissing = false;
  active = draft;
  showDraft();
  viewerNotice.hidden = true;
  viewerNotice.textContent = '';
  viewerBadge.textContent = 'Saved version · Read-only';
  viewerBadge.dataset.revision = String(draft.revision);
  viewerBadge.title = `Saved revision ${draft.revision}`;
  for (const id of VIEWER_NEEDS_DOCUMENT) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = false;
  showViewerStatus();
}
function syncViewerUrl(id: string): void {
  const href = comparisonViewerHref(import.meta.env.BASE_URL || '/', id);
  if (!href) return;
  // Keep the hash: it is reserved for portable share links (#39).
  try { history.replaceState(null, '', href + window.location.hash); } catch { /* The address bar is optional. */ }
}
let viewerLoad = 0;
async function viewerOpen(id: string): Promise<void> {
  const load = ++viewerLoad;
  workspace.bumpSessionGeneration();
  try {
    if (!db) throw new Error('Storage unavailable');
    const next = await getStoredDraft(db, id);
    if (load !== viewerLoad) return;
    if (!next || next.revision < 1) {
      showViewerMissing(VIEWER_MISSING);
      // Keep the address on the requested id so a reload shows the same missing state.
      syncViewerUrl(id);
    } else {
      writingPosition.save();
      showViewerDocument(next);
      syncViewerUrl(next.id);
    }
  } catch {
    if (load !== viewerLoad) return;
    renderDrafts();
    setSaveStatus('Could not open that document. The document shown is unchanged.', 'failure');
    return;
  }
  void refreshDrafts().catch(() => { /* The list is advisory in a read-only view. */ });
}
async function initializeViewer(): Promise<void> {
  applyViewerChrome();
  try {
    db = await openDraftDatabase(handleDatabaseUpgrade);
    // Only the requested id is loaded for display; the list feeds the Documents menu.
    const requested = requestedViewId ? await getStoredDraft(db, requestedViewId) : undefined;
    drafts = await listStoredDrafts(db);
    if (requested && requested.revision >= 1) showViewerDocument(requested);
    else showViewerMissing(VIEWER_MISSING);
  } catch (error) {
    db?.close(); db = undefined;
    storageProblem = error instanceof Error && error.message.startsWith('Database upgrade blocked.') ? error.message : STORAGE_UNAVAILABLE;
    showViewerMissing(VIEWER_STORAGE);
  } finally {
    field.disabled = false; draftSelect.disabled = false; draftTitle.disabled = false;
    restoreFocusMode();
    if (!viewMissing) writingPosition.restore(active.id);
    updateStats();
    finishInitialization();
  }
}
// Cross-window saved-version signals (#159 W3). Messages carry only ids/revisions; every
// receiver rereads IndexedDB, and handlers never save, so signals cannot loop.
const signalChannel: BroadcastChannel | undefined = (() => {
  try { return typeof BroadcastChannel === 'function' ? new BroadcastChannel(DOCUMENT_SIGNAL_CHANNEL) : undefined; }
  catch { return undefined; }
})();
function postSignal(type: DocumentSignal['type'], documentId: string, revision: number): void {
  if (viewMode || !signalChannel) return;
  try { signalChannel.postMessage(createDocumentSignal(type, documentId, revision, Date.now())); }
  catch { /* Signals are advisory; reconcile on focus covers a missed one. */ }
}
const versionNotice = document.querySelector<HTMLElement>('#version-notice')!;
const NEWER_VERSION_NOTICE = 'A newer saved version of this document exists in another window. Your text here has not been changed.';
const DELETED_NOTICE = 'This saved document was deleted in another window. Your text here has not been changed.';
/** Per-session version warnings so a primary save/switch does not erase pane-B feedback. */
let primaryVersionNotice = '';
let secondaryVersionNotice = '';
function syncVersionNoticeDisplay(): void {
  const preferSecondary = workspace.activePaneId() === SECOND_PANE_ID && dualDocumentSplit();
  const text = preferSecondary
    ? (secondaryVersionNotice || primaryVersionNotice)
    : (primaryVersionNotice || secondaryVersionNotice);
  if (!text) {
    if (versionNotice.hidden && !versionNotice.textContent) return;
    versionNotice.hidden = true;
    versionNotice.textContent = '';
    return;
  }
  if (versionNotice.textContent !== text) versionNotice.textContent = text;
  versionNotice.hidden = false;
}
function showVersionNotice(text: string, target: 'primary' | 'secondary' = 'primary'): void {
  if (target === 'secondary') secondaryVersionNotice = text;
  else primaryVersionNotice = text;
  syncVersionNoticeDisplay();
}
function clearVersionNotice(target?: 'primary' | 'secondary'): void {
  if (target === 'secondary') secondaryVersionNotice = '';
  else if (target === 'primary') primaryVersionNotice = '';
  else {
    primaryVersionNotice = '';
    secondaryVersionNotice = '';
  }
  syncVersionNoticeDisplay();
}
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
  if (field.disabled) { rereadAfterInit = true; return; }
  if (!db || loadingDraft || (viewMode && viewMissing)) return;
  // A local commit may be mid-flight; wait so the displayed revision is current.
  while (!viewMode && saving) await saving.catch(() => undefined);
  const id = active.id;
  const generationAtStart = workspace.sessionGeneration();
  const seq = ++rereadSeq;
  let stored: StoredDraft | undefined;
  try { stored = await getStoredDraft(db, id); } catch { return; }
  if (seq !== rereadSeq || generationAtStart !== workspace.sessionGeneration() || active.id !== id) return;
  if (!viewMode && saving) { void rereadDisplayed(); return; }
  // A clean read-only ordinary window follows the saved version like a viewer; unsaved text is never replaced.
  const reader = !viewMode && editBlock !== '' && !workspace.dirty();
  const action = decideReread({
    role: viewMode || reader ? 'viewer' : 'editor',
    displayedRevision: active.revision,
    displayedUpdatedAt: active.updatedAt,
    stored,
  });
  if (action === 'refresh' && stored) {
    writingPosition.save();
    if (viewMode) {
      showViewerDocument(stored);
      setSaveStatus('Updated to the latest saved version. Nothing is saved from this window.');
    } else {
      active = stored;
      showDraft();
      applyEditAccess();
      setSaveStatus('Updated to the latest saved version. ' + readOnlyStatus());
    }
    scheduleListRefresh();
  } else if (action === 'missing') {
    if (viewMode) showViewerMissing(VIEWER_MISSING);
    else if (active.revision >= 1) showVersionNotice(DELETED_NOTICE);
    scheduleListRefresh();
  } else if (action === 'notice-newer') showVersionNotice(NEWER_VERSION_NOTICE);
  else if (action === 'notice-deleted') showVersionNotice(DELETED_NOTICE);
}
let rereadSecondarySeq = 0;
/** Authoritative reread of the dual-document companion session. */
async function rereadSecondary(): Promise<void> {
  if (!secondary || !db || loadingDraft || !dualDocumentSplit()) return;
  while (secondary.saving) await secondary.saving.catch(() => undefined);
  if (!secondary || !dualDocumentSplit()) return;
  const id = secondary.draft.id;
  const generationAtStart = secondary.sessionGeneration;
  const seq = ++rereadSecondarySeq;
  let stored: StoredDraft | undefined;
  try { stored = await getStoredDraft(db, id); } catch { return; }
  if (!secondary || seq !== rereadSecondarySeq || secondary.sessionGeneration !== generationAtStart || secondary.draft.id !== id) return;
  if (secondary.saving) { void rereadSecondary(); return; }
  const reader = secondary.editBlock !== '' && !secondary.dirty;
  const action = decideReread({
    role: reader ? 'viewer' : 'editor',
    displayedRevision: secondary.draft.revision,
    displayedUpdatedAt: secondary.draft.updatedAt,
    stored,
  });
  if (action === 'refresh' && stored) {
    companionWritingPosition.save();
    loadingDraft = true;
    try {
      secondary.draft = stored;
      companionEditor.load(stored.text);
      if (stored.history) companionEditor.restoreHistory(stored.history);
      draftTitleB.value = stored.title;
    } finally { loadingDraft = false; }
    companionWritingPosition.restore(stored.id);
    clearVersionNotice('secondary');
    updateSaveIndicatorB();
    renderPaneBDrafts();
  } else if (action === 'missing') {
    if (secondary.draft.revision >= 1) showVersionNotice(DELETED_NOTICE, 'secondary');
    renderPaneBDrafts();
  } else if (action === 'notice-newer') showVersionNotice(NEWER_VERSION_NOTICE, 'secondary');
  else if (action === 'notice-deleted') showVersionNotice(DELETED_NOTICE, 'secondary');
}
let listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleListRefresh(): void {
  if (!viewMode || !db) return;
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => { void refreshDrafts().catch(() => { /* The list is advisory in a read-only view. */ }); }, 250);
}
signalChannel?.addEventListener('message', event => {
  const signal = parseDocumentSignal(event.data);
  if (!signal) return;
  // While loading, `active` is not the represented document yet; reread once it is.
  if (field.disabled) { rereadAfterInit = true; return; }
  scheduleListRefresh();
  if (shouldApplyDocumentSignal(signal, active.id, active.revision)) {
    // Do not bump sessionGeneration under an in-flight ownership acquire (stillHere would release).
    if (ownershipRetry) rereadAfterOwnershipRetry = true;
    else void rereadDisplayed();
  }
  if (secondary && shouldApplyDocumentSignal(signal, secondary.draft.id, secondary.draft.revision)) {
    if (mayRetryEditOwnership(secondary.editBlock)) {
      if (secondaryOwnershipRetry) rereadAfterSecondaryOwnershipRetry = true;
      else retrySecondaryOwnership();
    } else if (secondaryOwnershipRetry) rereadAfterSecondaryOwnershipRetry = true;
    else void rereadSecondary();
  }
});
function reconcileSignals(): void {
  if (document.visibilityState !== 'visible') return;
  scheduleListRefresh();
  // Readers: single-flight reread+acquire. Owners/viewers: still reread so missed signals surface.
  if (mayRetryEditOwnership(editBlock)) retryOwnership();
  else void rereadDisplayed();
  if (secondary && dualDocumentSplit()) {
    if (mayRetryEditOwnership(secondary.editBlock)) retrySecondaryOwnership();
    else void rereadSecondary();
  }
}
// Focusing the text is the clearest sign the user wants to edit here; it never steals a held lock.
field.addEventListener('focus', retryOwnership);
companionField.addEventListener('focus', retrySecondaryOwnership);
window.addEventListener('focus', reconcileSignals);
document.addEventListener('visibilitychange', reconcileSignals);
// Without BroadcastChannel, focus/visibility reread is the baseline; a slow poll only runs for a visible viewer.
if (viewMode && !signalChannel) setInterval(reconcileSignals, SIGNAL_POLL_INTERVAL_MS);
void (viewMode ? initializeViewer() : initializeDrafts());

const openComparison = document.querySelector<HTMLButtonElement>('#open-comparison')!;
async function explainNoComparison(message: string): Promise<void> {
  await askConfirmChoice({
    title: 'Cannot open comparison window',
    message,
    cancelLabel: 'Cancel',
    returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')!,
  });
}
type ComparisonOpenResult =
  | { ok: true; window: Window }
  | { ok: false; reason: 'blocked' | 'cleanup' };

/**
 * Open a same-origin companion without inheriting the source tab's sessionStorage.
 * Some browsers (notably Firefox) clone sessionStorage into window.open targets when an
 * opener relationship exists, which would copy private pending text. Opening about:blank,
 * stripping TypeBridge session keys, then navigating preserves popup-blocked detection
 * (unlike noopener, which returns null even on success) without clearing the source.
 * If inherited-session cleanup throws, fail closed: close the blank window and do not
 * navigate (private keys may still be present).
 */
function openComparisonWindow(href: string): ComparisonOpenResult {
  const opened = window.open('about:blank', '_blank');
  if (!opened) return { ok: false, reason: 'blocked' };
  try {
    const doomed: string[] = [];
    for (let i = 0; i < opened.sessionStorage.length; i++) {
      const key = opened.sessionStorage.key(i);
      if (key?.startsWith('typebridge.')) doomed.push(key);
    }
    for (const key of doomed) opened.sessionStorage.removeItem(key);
  } catch {
    try { opened.close(); } catch { /* Ignore. */ }
    return { ok: false, reason: 'cleanup' };
  }
  try { opened.opener = null; } catch { /* Optional severance. */ }
  try {
    opened.location.replace(new URL(href, window.location.href).href);
  } catch {
    try { opened.close(); } catch { /* Ignore. */ }
    return { ok: false, reason: 'blocked' };
  }
  return { ok: true, window: opened };
}

// window.open must run inside this click, so eligibility uses the in-memory IndexedDB revision
// rather than an async read; the companion verifies the row itself on load. Document text is
// never part of the URL, postMessage or sessionStorage.
openComparison.addEventListener('click', () => {
  if (viewMode || field.disabled || transitioning || deleting) return;
  if (!db || active.revision < 1) {
    void explainNoComparison(!db
      ? 'Browser storage is unavailable, so there is no saved copy to open. Copy or export your text instead. Nothing was changed.'
      : 'There is no saved copy of this document to open. Save or export it first if you want a second window; your text stays in this window. Opening a comparison window never turns on Autosave or saves your text.');
    return;
  }
  const href = comparisonViewerHref(import.meta.env.BASE_URL || '/', active.id);
  if (!href) {
    void explainNoComparison('This document cannot be opened in a comparison window yet. Export it and import it as a regular document first. Your text stays in this window.');
    return;
  }
  const opened = openComparisonWindow(href);
  if (!opened.ok) {
    if (opened.reason === 'cleanup') {
      announceAction('Could not open a private comparison window safely. Your text is still only in this window; try again or export a copy.', { kind: 'failure' });
    } else {
      announceAction('The comparison window was blocked. Allow pop-ups for TypeBridge and try again. Your text is still here.', { kind: 'failure' });
    }
    return;
  }
  announceAction(workspace.dirty()
    ? 'Opened the last saved version in a comparison window. Unsaved typing was not sent.'
    : 'Opened the last saved version in a comparison window.');
});

function downloadText(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeFilename(title: string): string {
  return (title.trim().split('').map(char => char.charCodeAt(0) < 32 || '/\\\\:*?"<>|'.includes(char) ? '-' : char).join('').slice(0, 80) || 'document');
}
function exportSurface(): { title: string; text: string } {
  if (dualDocumentSplit() && workspace.activePaneId() === SECOND_PANE_ID && secondary) {
    return {
      title: draftTitleB.value.trim() || UNTITLED_TITLE,
      text: companionField.value,
    };
  }
  if (sameDocEditableInB() || workspace.activePaneId() === SECOND_PANE_ID) {
    return {
      title: draftTitle.value.trim() || UNTITLED_TITLE,
      text: companionField.value,
    };
  }
  return {
    title: draftTitle.value.trim() || UNTITLED_TITLE,
    text: field.value,
  };
}
document.querySelector<HTMLButtonElement>('#export-txt')!.addEventListener('click', () => {
  const { title, text } = exportSurface();
  downloadText(safeFilename(title) + '.txt', text, 'text/plain;charset=utf-8');
  announceAction('Text exported');
});
document.querySelector<HTMLButtonElement>('#export-json')!.addEventListener('click', () => {
  const { title, text } = exportSurface();
  const draft = { title, text };
  downloadText(safeFilename(draft.title) + '.typebridge.json', JSON.stringify({ format: 'typebridge-draft', version: 1, draft }, null, 2), 'application/json;charset=utf-8');
  announceAction('Document exported');
});
const importFile = document.querySelector<HTMLInputElement>('#import-file')!;
document.querySelector<HTMLButtonElement>('#import-draft')!.addEventListener('click', () => { if (!viewMode) importFile.click(); });
importFile.addEventListener('change', async () => {
  if (viewMode) { importFile.value = ''; return; }
  const file = importFile.files?.[0];
  importFile.value = '';
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('File exceeds 5 MB');
    const content = await file.text();
    let title = file.name.replace(/(\.typebridge)?\.(json|txt)$/i, '');
    let text = content;
    if (/\.json$/i.test(file.name)) {
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || !('format' in parsed) || parsed.format !== 'typebridge-draft' || !('version' in parsed) || parsed.version !== 1 || !('draft' in parsed) || !parsed.draft || typeof parsed.draft !== 'object' || !('title' in parsed.draft) || typeof parsed.draft.title !== 'string' || !('text' in parsed.draft) || typeof parsed.draft.text !== 'string') throw new Error('Not a supported TypeBridge document');
      title = parsed.draft.title;
      text = parsed.draft.text;
    } else if (!/\.txt$/i.test(file.name)) throw new Error('Choose a .txt or .typebridge.json file');
    if (!await askConfirmChoice({ title: 'Import document?', message: 'Import as a new document? Your current document will be kept.', confirmLabel: 'Import document', cancelLabel: 'Cancel import', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! })) return;
    const imported = { ...newDraft(text), title: title.trim().slice(0, 150) || 'Imported document' };
    // Save even when autosave is off: importing is an explicit save action.
    if (!db) throw new Error('browser storage cannot be used');
    const result = await commitOrCreateConflictCopy(db, imported, 0, crypto.randomUUID());
    postSignal('saved', result.draft.id, result.draft.revision);
    const switched = await switchDraft(result.draft.id);
    // Always confirm the import; keep a conflict notice that the switch flush created.
    announceAction(
      switched.opened ? 'Imported as a new document' : 'Import saved in Documents; current text was kept',
      { keepConflict: switched.conflict },
    );
  } catch (error) {
    announceAction('Import failed: ' + (error instanceof Error ? error.message : String(error)));
  }
});

if (!viewMode) window.addEventListener('pagehide', () => {
  savePending();
  flushSecondaryOnUnload();
  clearTimeout(saveTimer);
  void persist();
});
let allowUpdateReload = false;
let privateReloadChoice: { id: string; generation: number } | undefined;
let privateReloadChoiceB: { id: string; generation: number } | undefined;
async function prepareUpdateReload(): Promise<boolean> {
  if (transitioning || deleting || field.disabled) return false;
  privateReloadChoice = undefined;
  privateReloadChoiceB = undefined;
  const secondaryDirty = !!secondary?.dirty;
  if ((workspace.dirty() || secondaryDirty) && !autosave.checked) {
    const discard = await askConfirmChoice({ title: 'Reload without saving?', message: 'Autosave is off. Text and title changes will be lost. Copy or export them first if you want to keep them.', confirmLabel: 'Discard changes and reload', cancelLabel: 'Keep editing', returnFocus: document.querySelector<HTMLButtonElement>('#update-reload')! });
    if (discard) {
      privateReloadChoice = { id: active.id, generation: workspace.contentRevision() };
      if (secondary) privateReloadChoiceB = { id: secondary.draft.id, generation: secondary.contentRevision };
    }
    return discard;
  }
  savePending();
  savePendingSecondary();
  if (workspace.dirty()) await persist();
  if (secondary?.dirty) await persistSecondary();
  if (!workspace.dirty() && !secondary?.dirty) return true;
  savePending();
  savePendingSecondary();
  const pending = readPending();
  const pendingB = readPendingB();
  const primaryOk = !workspace.dirty() || (!!pending && sameContent(pending, snapshot()));
  const secondaryOk = !secondary?.dirty || (!!pendingB && secondary && sameContent(pendingB, snapshotBoundSession(secondary, UNTITLED_TITLE)));
  return primaryOk && secondaryOk;
}
function reloadAfterUpdate(): void {
  if (transitioning || deleting || field.disabled || document.querySelector('.confirm-backdrop')) throw new Error('Finish the current action first');
  if (workspace.dirty() || secondary?.dirty) {
    if (!autosave.checked) {
      if (workspace.dirty() && (privateReloadChoice?.id !== active.id || privateReloadChoice.generation !== workspace.contentRevision())) {
        throw new Error('Private edits changed');
      }
      if (secondary?.dirty && (privateReloadChoiceB?.id !== secondary.draft.id || privateReloadChoiceB.generation !== secondary.contentRevision)) {
        throw new Error('Private edits changed');
      }
    } else {
      savePending();
      savePendingSecondary();
      const pending = readPending();
      const pendingB = readPendingB();
      if (workspace.dirty() && (!pending || !sameContent(pending, snapshot()))) throw new Error('Reload backup unavailable');
      if (secondary?.dirty && (!pendingB || !sameContent(pendingB, snapshotBoundSession(secondary, UNTITLED_TITLE)))) {
        throw new Error('Reload backup unavailable');
      }
    }
  }
  allowUpdateReload = true;
  try { window.location.reload(); } catch (error) { allowUpdateReload = false; throw error; }
}
if (!viewMode) window.addEventListener('beforeunload', event => {
  if (workspace.dirty() || secondary?.dirty) {
    savePending();
    flushSecondaryOnUnload();
    clearTimeout(saveTimer);
    void persist();
    if (!allowUpdateReload) { event.preventDefault(); event.returnValue = ''; }
  }
});
if (!viewMode) document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(saveTimer);
    void persist();
    flushSecondaryOnUnload();
  }
});
updateStats();

setupResetSettings({ actions: [
  ['appearance', appearanceSettings.reset], ['typing mode/shortcut', typingSettings.reset], ['custom rules', resetRules], ['Find options', resetOptions],
  ['Tab indents', () => { tabIndent.checked = true; return saveTabIndent(); }], ['editor layout', resetLayout],
], announce: announceAction });

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => watchForUpdates(registration, { prepareReload: prepareUpdateReload, reload: reloadAfterUpdate, cancelReload: () => { allowUpdateReload = false; } }))
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
