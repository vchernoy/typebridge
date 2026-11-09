import { setupAppearance } from './ui/appearance';
import { setupWindowLayoutSetting } from './ui/window-layout-setting';
import { setupResetSettings } from './ui/reset-settings';
import { watchForUpdates } from './ui/update-notice';
import { SHORTCUTS } from './editor/keyboard-shortcuts';
import { setupKeyboardShortcuts } from './ui/keyboard-shortcuts';
import './style.css';
import { Editor } from './editor/editor';
import { indentEdit } from './editor/indent';
import { AUTOSAVE_OFF, CONFLICT_COPY, CONFLICT_COPY_LEFT, EDITABLE_HERE, SAVE_FAILED, STORAGE_UNAVAILABLE } from './editor/status';
import { createStatusLine } from './ui/status-line';
import { createReloadBackup, sameContent } from './view/reload-backup';
import { draftMatchesQuery, draftPickerLabel } from './editor/draft-list';
import {
  ACTIVE_DRAFT_KEY_BASE,
  UNTITLED_TITLE,
  autosaveEnabled,
  configureActiveDraftKey,
  newDraft,
  readActiveDraftId,
  setActiveDraftId,
  setAutosaveEnabled,
} from './editor/drafts';
import { nextUntitledTitle } from './editor/untitled-title';
import { moveReadOnlyCaret } from './ui/readonly-caret';
import { nextCharacterBoundary, previousCharacterBoundary } from './editor/characters';
import { FIND_KEY, REPLACE_KEY } from './editor/search-settings';
import { askConfirmChoice } from './ui/confirm-dialog';
import { openDraftDatabase, listStoredDrafts, getStoredDraft, commitDraft, commitOrCreateConflictCopy, deleteStoredDraft, EditOwnershipLostError, type StoredDraft } from './editor/indexeddb';
import { acquireEditOwnership, type EditOwnership } from './editor/edit-ownership';
import { editBlockGuidance, mayRetryEditOwnership, type EditBlock } from './view/ownership';
import { bufferInsertFromKeyboard, handoffRefuseGuidance, mapSelectionAcrossTextChange, replayBufferedInsert, type BufferedInsert, type HandoffRefuseReason, type HandoffSnapshot } from './view/handoff';
import { installFocusHandoff, type FocusHandoffController } from './view/focus-handoff';
import type { EditorHistory } from './editor/editor';
import { createSinglePaneWorkspace, PRIMARY_PANE_ID } from './view/workspace';
import {
  commandAllowedOnPane,
  contentCommandStillCurrent,
  sessionPersistStillCurrent,
  type CommandGeneration,
} from './view/session';
import { clearRecovery, listRecovery, writeRecovery, RECOVERY_PREFIX, type RecoverySnapshot } from './editor/recovery';
import { lineColumnAtOffset } from './editor/goto-line';
import { setupLayout } from './ui/layout';
import { setupSearch } from './ui/search';
import { setupRules } from './ui/rules';
import { setupTransliteration } from './ui/transliteration';
import { setupSettings } from './ui/settings';
import { setupDocumentMenu } from './ui/document-menu';
import { setupMoreMenu } from './ui/more-menu';
import { installEscapeLayers } from './ui/escape-layers';
import { setupWritingPosition } from './editor/writing-position';
import { comparisonViewerHref, isDocumentId, parseComparisonRoute } from './view/route';
import { parseWindowId, scopeSessionKey, writingPositionNamespace } from './view/window-id';
import { editorWindowApi, exposeEditorWindowApi, hostPageApi, testKnob, type EditorWindow } from './view/embed-api';
import { setupExportImport } from './ui/export-import';
import { setupComparisonOpen } from './ui/comparison-open';
import { setupFindGotoBars } from './ui/find-goto-bars';
import { parseEmbedMode } from './view/embed';
import { notifyPrefsChanged, onPrefsChanged, PREFS_EVENT, type PrefName } from './view/prefs-sync';
import { DOCUMENT_SIGNAL_CHANNEL, SIGNAL_POLL_INTERVAL_MS, createDocumentSignal, decideReread, parseDocumentSignal, shouldApplyDocumentSignal, type DocumentSignal } from './view/signals';
import { formatDocumentStats } from './editor/document-stats';
// Companion routing is parsed before any ordinary open/restore path (#159 W2).
// Only an absent mode is ordinary boot; invalid mode/doc takes the no-write viewer path.
const route = parseComparisonRoute(window.location.search);
const viewMode = route.kind !== 'ordinary';
const requestedViewId = route.kind === 'viewer' ? route.documentId : undefined;
/** #175 step 2: same-tab iframe instances share sessionStorage — scope keys by window id. */
const windowId = parseWindowId(window.location.search);
if (windowId) document.documentElement.dataset.windowId = windowId;
/** #175 step 3: host page owns Settings panel + update notice; editor runs embedded. */
const embedded = parseEmbedMode(window.location.search);
if (embedded) document.documentElement.dataset.embed = '1';
// Host windows (#175 follow-up): one compact row (▾, Saved, editing tools, Focus) so the
// text gets the window's height. The window title bar already names the document.
if (embedded) {
  const topbar = document.querySelector<HTMLElement>('.topbar');
  const toolbar = document.querySelector<HTMLElement>('.toolbar');
  const topActions = topbar?.querySelector<HTMLElement>('.top-actions');
  if (topbar && toolbar && topActions) topbar.insertBefore(toolbar, topActions);
}

/**
 * #175 step 10: drop obsolete split prefs; migrate pane-B text backups to the
 * recovery journal before removing them so an update reload cannot destroy the
 * only copy of unsaved pane-B text. Never touch IndexedDB documents.
 */
try { localStorage.removeItem('typebridge.split.v1'); } catch { /* Optional. */ }
try {
  const doomed: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key === 'typebridge.pendingDraft.paneB.v1' || key?.startsWith('typebridge.pendingDraft.paneB.v1::')) {
      doomed.push(key);
    }
  }
  for (const key of doomed) {
    let remove = false;
    try {
      const raw = sessionStorage.getItem(key);
      const value: unknown = JSON.parse(raw ?? 'null');
      if (!value || typeof value !== 'object') {
        remove = true;
      } else {
        const draft = value as Partial<StoredDraft>;
        const usable = typeof draft.id === 'string' && !!draft.id
          && typeof draft.title === 'string'
          && typeof draft.text === 'string'
          && typeof draft.updatedAt === 'number' && Number.isFinite(draft.updatedAt)
          && Number.isSafeInteger(draft.revision) && (draft.revision ?? -1) >= 0;
        if (!usable || draft.text!.length === 0) {
          // Empty or unparseable leftovers are safe to drop.
          remove = true;
        } else {
          writeRecovery(localStorage, {
            token: crypto.randomUUID(),
            tab: `split-pane-b-migrate.${crypto.randomUUID()}`,
            documentId: draft.id!,
            revision: draft.revision!,
            timestamp: draft.updatedAt!,
            title: draft.title!.trim() || UNTITLED_TITLE,
            text: draft.text!,
          });
          remove = true;
        }
      }
    } catch {
      // Migration failed — keep the sessionStorage key so text is not lost.
      remove = false;
    }
    if (remove) sessionStorage.removeItem(key);
  }
} catch { /* Optional. */ }
configureActiveDraftKey(scopeSessionKey(ACTIVE_DRAFT_KEY_BASE, windowId));
// #175 step 9: Find query is shared across windows; Replace text stays per-window.
const findSessionKey = FIND_KEY;
const replaceSessionKey = scopeSessionKey(REPLACE_KEY, windowId);
const updateDismissKey = scopeSessionKey('typebridge.updateNotice.dismissed.v1', windowId);
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
/** Suppress scheduleSave while applying handoff snapshots (not a content edit). */
let suppressEditTracking = false;
/** True for the whole Autosave change handler (including awaits); keeps the checkbox disabled. */
let autosaveToggleActive = false;
const webLocks: LockManager | undefined = typeof navigator.locks?.request === 'function' ? navigator.locks : undefined;
/** True while this window must not change the displayed document. */
/** True when the UI must refuse mutations (viewer, non-owner, or frozen for ownership transfer). */
const readOnlyNow = (): boolean => viewMode || editBlock !== '' || transferFrozen;
/**
 * A clean window whose document another window or tab is editing. It looks like a normal
 * editor: no Read-only badge or notice; clicking, typing or using a control takes over
 * editing (focus handoff). Unsaved text here, Edit here warnings and real errors still show.
 */
/** The displayed document was deleted in another window (see markDeletedElsewhere). */
let deletedElsewhere = false;
/** Replays keys held while a deleted document is kept as a new one (set up with the input handlers). */
let drainDeletedInput: (() => void) | undefined;
const deletedBarElement = (): HTMLElement => document.querySelector<HTMLElement>('#deleted-bar')!;
const quietReader = (): boolean => !viewMode && editBlock === 'busy' && !workspace.dirty() && !deletedElsewhere;
// Do not delete pendingDraft/activeDraft on viewer boot: same-tab navigation from an editor
// writes those keys on pagehide for reload restore, and wiping them here would discard that
// backup. Cloned private keys for a new companion are stripped in openComparisonWindow before
// navigation; initializeViewer never reads pending/active hints.
const field = document.querySelector<HTMLTextAreaElement>('#editor')!;
const workspaceRoot = document.querySelector<HTMLElement>('main.workspace')!;
const workspace = createSinglePaneWorkspace({
  root: workspaceRoot,
  paneSurface: field,
});

// Escape layers must listen before Focus so editor Escape closes Settings/Find first (#132).
installEscapeLayers();
const { setFocusMode, restoreFocusMode, resetLayout, applyFocusModeOnly } = setupLayout(field, {
  getFocusTarget: () => field,
  focusToggleSurfaces: () => [field],
  onFocusModeChange: enabled => {
    if (!embedded || window.parent === window) return;
    try {
      hostPageApi()?.__typebridgeHostFocusMode?.(enabled, windowId ?? undefined);
    } catch { /* Cross-origin parent is out of scope. */ }
  },
});
setupSettings({ embedded });
let docSearchQuery = '';
setupDocumentMenu({
  onSearch: query => {
    docSearchQuery = query;
    renderDrafts();
  },
  onOpen: () => {
    void refreshDrafts().catch(() => { /* Keep the last list; the menu still works. */ });
  },
});
setupMoreMenu();
setupKeyboardShortcuts();
const editor = new Editor(field);
/** Declared early: syncMutationControls runs during module init before draft locals. */
const autosave = document.querySelector<HTMLInputElement>('#autosave')!;
if (viewMode) {
  editor.setReadOnly(true);
  workspace.setPaneRole('readonly');
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
const appearanceSettings = setupAppearance(preferenceSaved, { prefsOrigin: embedded ? `window:${windowId ?? 'main'}` : 'standalone' });
const windowLayoutSettings = setupWindowLayoutSetting(preferenceSaved, {
  prefsOrigin: embedded ? `window:${windowId ?? 'main'}` : 'standalone',
});

type PersistResult = { saved: boolean; conflict: boolean };
type SwitchResult = { opened: boolean; conflict: boolean };
let saveFailed = false;
// Non-empty while browser storage cannot be used (failed or blocked
// initialization, or an upgrade in another tab). Nothing in this page
// restores it; only a reload can.
let storageProblem = '';
const statusLine = createStatusLine({
  conflictNotice,
  statusSep,
  status,
  afterRender: () => { updateSaveIndicator(); },
  risk: () => ({
    storageProblem,
    dirty: workspace.dirty(),
    blocked: editBlock !== '',
    saveFailed,
    autosaveOn: autosave.checked,
  }),
  editBlock: () => editBlock,
  quietReader: () => quietReader(),
});
const {
  updateStatus, setConflict, clearNotices, setSaveStatus, riskText, setRiskStatus,
  announceAction, showSaving, showSaveState, readOnlyStatus,
  markDraftListRefreshFailed, shouldAttachDraftListRefreshFailure,
} = statusLine;
const count = document.querySelector<HTMLElement>('#count')!;
const caretPosition = document.querySelector<HTMLElement>('#caret-position')!;
const undo = document.querySelector<HTMLButtonElement>('#undo')!;
const redo = document.querySelector<HTMLButtonElement>('#redo')!;
/** Active editable session for shared chrome. */
function activeEditableSession(): { paneId: typeof PRIMARY_PANE_ID; role: 'editable' | 'readonly'; editor: Editor; field: HTMLTextAreaElement; canUndo: boolean; canRedo: boolean } {
  return {
    paneId: PRIMARY_PANE_ID,
    role: readOnlyNow() ? 'readonly' : 'editable',
    editor,
    field,
    canUndo: editor.canUndo,
    canRedo: editor.canRedo,
  };
}
/** Live token for delayed toolbar commands after content edits. */
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
/** Shared chrome mutates the primary editable surface. */
function canMutatePrimary(): boolean {
  const target = activeEditableSession();
  return commandAllowedOnPane({
    activePaneId: workspace.activePaneId(),
    targetPaneId: target.paneId,
    role: target.role,
    mutatesDocument: true,
  });
}
/** Autosave is blocked for viewers and non-owners. */
function autosaveControlBlocked(): boolean {
  // Viewers never own the preference; keep the change handler gated too.
  if (viewMode || transferFrozen) return true;
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
  // A quiet reader keeps these enabled; the click takes over editing, then runs.
  const controlsBlocked = blocked && !(quietReader() && !transferFrozen);
  undo.disabled = controlsBlocked || !target.canUndo;
  redo.disabled = controlsBlocked || !target.canRedo;
  for (const id of ['convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'] as const) {
    document.querySelector<HTMLButtonElement>('#' + id)!.disabled = controlsBlocked;
  }
  syncAutosaveControl();
}
const syncHistory = () => { syncMutationControls(); };
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
function updateCaretPosition(): void {
  const { line, column } = lineColumnAtOffset(field.value, field.selectionStart);
  caretPosition.textContent = `Ln ${line}, Col ${column}`;
}
/** Keep shared chrome routed to the primary pane; refresh Find totals when needed. */
function activatePane(paneId: typeof PRIMARY_PANE_ID = PRIMARY_PANE_ID): void {
  const previous = workspace.activePaneId();
  workspace.setActivePane(paneId);
  syncMutationControls();
  updateStats();
  if (previous !== paneId) {
    showMatchCount();
    syncVersionNoticeDisplay();
  }
}
field.addEventListener('focus', () => { activatePane(PRIMARY_PANE_ID); });
// Tab and Shift+Tab indent lines (#56). Keyboard users are never trapped: the
// "Tab indents" setting turns this off, and Shift+Tab on a line with nothing to
// outdent moves focus as usual.
const TAB_INDENT_KEY = 'typebridge.editor.tabIndent.v1';
const tabIndent = document.querySelector<HTMLInputElement>('#tab-indent')!;
try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { /* Keep the default. */ }
function saveTabIndent(): boolean {
  try {
    localStorage.setItem(TAB_INDENT_KEY, tabIndent.checked ? 'on' : 'off');
    notifyPrefsChanged({
      name: 'tabIndent',
      origin: embedded ? `window:${windowId ?? 'main'}` : 'standalone',
    });
    return true;
  } catch { return false; }
}
let applyingTabIndentRemote = false;
tabIndent.addEventListener('change', () => {
  if (applyingTabIndentRemote) return;
  saveTabIndent();
});
function applyTabIndentFromStorage(): void {
  applyingTabIndentRemote = true;
  try {
    try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { /* keep */ }
  } finally {
    applyingTabIndentRemote = false;
  }
}
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
function updateStats(): void {
  count.textContent = formatDocumentStats(field.value);
  updateCaretPosition();
}
field.addEventListener('input', updateStats);
field.addEventListener('historychange', updateStats);
field.addEventListener('keyup', updateCaretPosition);
field.addEventListener('click', updateCaretPosition);
field.addEventListener('select', updateCaretPosition);
const typingSettings = setupTransliteration(enabled, editor, {
  syncSearchEditors: () => syncSearchEditors(),
  preferenceSaved,
  prefsOrigin: embedded ? `window:${windowId ?? 'main'}` : 'standalone',
});
document.querySelector<HTMLButtonElement>('#copy')!.addEventListener('click', async () => {
  const text = field.value;
  try { await navigator.clipboard.writeText(text); announceAction('Copied'); }
  catch {
    field.focus();
    field.select();
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


const primarySearch: { field: HTMLTextAreaElement; editor: Editor } = { field, editor };
const { findInput, findEditor, replaceEditor, syncSearchEditors, showMatchCount, resetOptions } = setupSearch(
  primarySearch,
  enabled,
  {
    canMutate: canMutatePrimary,
    getFindTarget: () => primarySearch,
    matchSurfaces: [field],
    findTextKey: findSessionKey,
    replaceTextKey: replaceSessionKey,
  },
);
const { openFind } = setupFindGotoBars({
  field,
  editor,
  findInput,
  findEditor,
  showMatchCount,
  leaveFocusMode: () => {
    if (!document.body.classList.contains('focus-mode')) return;
    setFocusMode(false);
    syncMutationControls();
  },
  updateCaretPosition,
});


const resetRules = setupRules(
  () => [editor, findEditor, replaceEditor, titleEditor],
  { prefsOrigin: embedded ? `window:${windowId ?? 'main'}` : 'standalone' },
);

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
});
let db: IDBDatabase | undefined;
let active: StoredDraft = { ...newDraft(), revision: 0 };
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
    : deletedElsewhere ? 'unsaved'
    : quietReader() ? (!autosave.checked || !db ? 'unsaved' : 'saved')
    : editBlock ? (workspace.dirty() ? 'unsaved' : 'readonly')
    : !autosave.checked || !db ? 'unsaved' : workspace.dirty() ? 'saving' : 'saved';
  const label = { failed: 'Save failed', readonly: 'Read-only', unsaved: 'Not saved', saving: 'Saving…', saved: 'Saved' }[state];
  if (saveIndicator.textContent !== label) saveIndicator.textContent = label;
  saveIndicator.dataset.state = state;
}
// Viewers use their own key namespace so they never overwrite an editor's saved offsets.
// Window id scopes positions when multiple instances share one tab's sessionStorage (#175).
const writingPosition = setupWritingPosition(
  field,
  () => loadingDraft || field.disabled || viewMissing ? undefined : active.id,
  writingPositionNamespace(windowId, viewMode),
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
const PENDING_KEY = scopeSessionKey('typebridge.pendingDraft.v1', windowId);
function snapshot(): StoredDraft {
  return { ...active, text: field.value, title: draftTitle.value.trim() || UNTITLED_TITLE, history: editor.exportHistory(), updatedAt: Date.now() };
}
function journalEdit(): void {
  if (viewMode || !autosave.checked) return;
  const entry: RecoverySnapshot = { token: crypto.randomUUID(), tab: journalTab, documentId: active.id, revision: active.revision, timestamp: Date.now(), title: draftTitle.value.trim() || UNTITLED_TITLE, text: field.value };
  try { writeRecovery(localStorage, entry); currentJournal = entry; journalWarning.hidden = true; }
  catch { journalWarning.textContent = 'Emergency backup unavailable. Keep this tab open until saved, or copy or export your text.'; journalWarning.hidden = false; }
}
const reloadBackup = createReloadBackup({
  key: PENDING_KEY,
  snapshot,
  mayBackUp: () => !viewMode && workspace.dirty() && autosave.checked && !deleting,
  // Keep any conflict notice and the current risk; only replace the primary.
  // Trailing period stays; renderStatusBody joins risk with a space after it.
  onFailed: () => { setRiskStatus('Unsaved text could not be backed up for reload. Copy or export it.', 'failure'); },
});
const readPending = reloadBackup.read;
const savePending = reloadBackup.save;
const clearPending = reloadBackup.clear;
function rememberActive(): void {
  if (viewMode) return;
  try { setActiveDraftId(active.id); } catch { /* Selection is only a hint. */ }
  // Tell the #175 host so layout persistence can record this window's document id / title.
  if (embedded && window.parent !== window) {
    try {
      // Post the raw field value (may be empty while renaming). The host applies
      // the Untitled fallback for chrome metadata without clobbering in-progress edits.
      window.parent.postMessage({
        type: 'typebridge-active-draft',
        windowId,
        documentId: active.id,
        title: draftTitle.value,
      }, window.location.origin);
    } catch { /* Cross-origin parent — host will probe on unload. */ }
  }
}

/** #175 step 8: never reuse an existing Untitled document / Untitled document N name. */
function allocateNewDraft(text = ''): StoredDraft {
  const titles = drafts.map(draft => draft.title);
  titles.push(active.title, draftTitle.value.trim() || UNTITLED_TITLE);
  // Other host windows may hold unsaved Untitled titles not yet in IndexedDB.
  if (embedded && window.parent !== window) {
    try {
      titles.push(...(hostPageApi()?.__typebridgeOpenTitles?.(windowId ?? undefined) ?? []));
    } catch { /* Parent unavailable. */ }
  }
  return { ...newDraft(text, nextUntitledTitle(titles)), revision: 0 };
}

function openDocumentIdsElsewhere(): Set<string> {
  if (!embedded || window.parent === window) return new Set();
  try {
    // exceptWindowId already omits this window; keep ids open in *other* windows,
    // including the active document when it is duplicated (#175 step 8).
    const ids = hostPageApi()?.__typebridgeOpenDocumentIds?.(windowId ?? undefined) ?? [];
    return new Set(ids.filter(id => !!id));
  } catch {
    return new Set();
  }
}

function renderDrafts(): void {
  const visibleBase = viewMissing || drafts.some(d => d.id === active.id) ? drafts : [active, ...drafts];
  const displayTitle = draftTitle.value.trim() || UNTITLED_TITLE;
  const elsewhere = openDocumentIdsElsewhere();
  const visible = visibleBase.filter(draft => draftMatchesQuery({
    title: draft.id === active.id ? displayTitle : draft.title,
    text: draft.id === active.id ? field.value : draft.text,
    query: docSearchQuery,
  }));
  for (const picker of documentPickers) {
    picker.replaceChildren();
    for (const draft of visible) {
      const option = document.createElement('option');
      option.value = draft.id;
      const isCurrent = draft.id === active.id;
      option.textContent = draftPickerLabel({
        savedTitle: draft.title,
        displayTitle,
        isCurrent,
        unsaved: isCurrent && workspace.dirty(),
        text: isCurrent ? field.value : draft.text,
        updatedAt: isCurrent ? (workspace.dirty() ? Date.now() : draft.updatedAt) : draft.updatedAt,
        openElsewhere: elsewhere.has(draft.id),
      });
      picker.append(option);
    }
    picker.value = viewMissing ? '' : active.id;
  }
  // Shown as a list inside the document menu: at least two rows, at most eight.
  draftSelect.size = Math.min(8, Math.max(2, draftSelect.options.length || 2));
}
async function refreshDrafts(): Promise<void> {
  const delayMs = testKnob('__typebridgeDelayRefreshMs');
  if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  if (db) drafts = await listStoredDrafts(db);
  renderDrafts();
  if (statusLine.message().draftListRefreshFailed) updateStatus({ draftListRefreshFailed: false });
}
function showDraft(): void {
  clearDeletedElsewhere();
  // Callers decide post-load status; clearing through updateStatus keeps the DOM in sync.
  workspace.bumpSessionGeneration();
  workspace.setDocumentId(active.id);
  clearVersionNotice();
  clearNotices();
  loadingDraft = true;
  try {
    editor.load(active.text);
    if (!viewMode) editor.restoreHistory(active.history);
    draftTitle.value = active.title;
    syncTitleTooltip();
    workspace.setDirty(false);
    saveFailed = false; // The editor no longer holds the unsaved text.
  } finally { loadingDraft = false; }
  writingPosition.restore(active.id);
  renderDrafts();
  updateStats();
  updateSaveIndicator();
  rememberActive();
}
const ownershipNotice = document.querySelector<HTMLElement>('#ownership-notice')!;
const editHereBar = document.querySelector<HTMLElement>('#edit-here-bar')!;
const editHereWarning = document.querySelector<HTMLElement>('#edit-here-warning')!;
const editHereButton = document.querySelector<HTMLButtonElement>('#edit-here')!;
let focusHandoff: FocusHandoffController | undefined;
/** Controls that change the displayed document; New, Import and switching stay available. */
const OWNER_ONLY_CONTROLS = ['delete-draft', 'convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'];
/** A control clicked in a quiet reader; it runs once this window can edit that document. */
let replayButton: { button: HTMLButtonElement; documentId: string } | undefined;
/** A title edit typed or pasted while editing moved here; replayed once it arrives. */
type TitleOp = { inputType: string; data: string | null };
/** A held title edit with the selection it was made at, in the (unchanged) field's coordinates. */
type HeldTitleOp = TitleOp & { start: number; end: number };
/** Title edits held during a takeover, tied to their document (#197). */
let titleBuffer: { documentId: string; baseValue: string; ops: HeldTitleOp[]; fromHost: boolean } | undefined;
/** One title edit through the title Editor (transliteration, undo); host title bar and held edits. */
function applyTitleEdit(payload: { inputType: string; data: string | null; start: number; end: number }): { value: string; start: number; end: number } | null {
  if (viewMode || draftTitle.readOnly || draftTitle.disabled) return null;
  const length = draftTitle.value.length;
  const start = Math.max(0, Math.min(payload.start, length));
  const end = Math.max(start, Math.min(payload.end, length));
  // Do not focus the hidden embed #draft-title — that steals caret from the host
  // title bar (especially on Firefox) and drops later keystrokes.
  try { draftTitle.setSelectionRange(start, end); } catch { /* Not focused. */ }
  const event = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: payload.inputType,
    data: payload.data ?? undefined,
  });
  draftTitle.dispatchEvent(event);
  if (!event.defaultPrevented) {
    if (payload.inputType === 'insertText' && payload.data) {
      const room = Math.max(0, 150 - (draftTitle.value.length - (end - start)));
      draftTitle.setRangeText(payload.data.slice(0, room), start, end, 'end');
      draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType, data: payload.data }));
    } else if (
      (payload.inputType === 'insertFromPaste' || payload.inputType === 'insertFromDrop')
      && payload.data
    ) {
      const room = Math.max(0, 150 - (draftTitle.value.length - (end - start)));
      draftTitle.setRangeText(payload.data.slice(0, room), start, end, 'end');
      draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType, data: payload.data }));
    } else if (payload.inputType === 'deleteContentBackward') {
      if (start === end && start > 0) draftTitle.setRangeText('', previousCharacterBoundary(draftTitle.value, start), start, 'end');
      else draftTitle.setRangeText('', start, end, 'end');
      draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType }));
    } else if (payload.inputType === 'deleteContentForward') {
      if (start === end && start < draftTitle.value.length) draftTitle.setRangeText('', start, nextCharacterBoundary(draftTitle.value, start), 'end');
      else draftTitle.setRangeText('', start, end, 'end');
      draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType }));
    } else if (payload.inputType === 'deleteByCut') {
      draftTitle.setRangeText('', start, end, 'end');
      draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType }));
    } else if (payload.inputType === 'historyUndo') {
      titleEditor.undo();
      try { draftTitle.blur(); } catch { /* Hidden embed field. */ }
    } else if (payload.inputType === 'historyRedo') {
      titleEditor.redo();
      try { draftTitle.blur(); } catch { /* Hidden embed field. */ }
    }
    if (draftTitle.value.length > 150) {
      draftTitle.value = draftTitle.value.slice(0, 150);
      draftTitle.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  syncTitleTooltip();
  rememberActive();
  return {
    value: draftTitle.value,
    start: draftTitle.selectionStart ?? 0,
    end: draftTitle.selectionEnd ?? 0,
  };
}
/**
 * Apply held title edits in order. Each edit's selection is in the coordinates of the
 * title shown while waiting; map it past earlier held edits. When `changed` (a newer
 * title arrived meanwhile), keep that title and add the edits at its end.
 */
function applyHeldTitleOps(ops: HeldTitleOp[], changed: boolean): { start: number; end: number } {
  // A newer title may have arrived with the takeover: keep it and add the edits at its end.
  // The field showed the old title while edits were held, so each edit's selection is in
  // old-title coordinates. Map it past earlier held edits: shifts made at or before a
  // position move it along (End, 1, Home, 2 on "Имя" gives "2Имя1").
  const shifts: { at: number; by: number }[] = [];
  const mapPos = (pos: number): number => pos + shifts.reduce((sum, shift) => sum + (shift.at <= pos ? shift.by : 0), 0);
  let start = draftTitle.value.length;
  let end = start;
  let previous: HeldTitleOp | undefined;
  for (const op of ops) {
    const sameSpot = previous && previous.start === op.start && previous.end === op.end;
    if (!changed && !sameSpot) {
      start = mapPos(op.start);
      end = Math.max(start, mapPos(op.end));
    }
    const before = draftTitle.value.length;
    const result = applyTitleEdit({ inputType: op.inputType, data: op.data, start, end });
    if (!result) break;
    if (!changed) shifts.push({ at: op.start, by: result.value.length - before });
    ({ start, end } = result);
    previous = op;
  }
  return { start, end };
}
/** Apply held title edits through the title Editor (transliteration, undo) at the user's caret. */
function replayTitleBuffer(): void {
  const held = titleBuffer;
  titleBuffer = undefined;
  if (!held || held.documentId !== active.id || draftTitle.readOnly) return;
  const { start, end } = applyHeldTitleOps(held.ops, draftTitle.value !== held.baseValue);
  // Leave focus where the user put it; only place the caret if the title still has it.
  if (!held.fromHost && document.activeElement === draftTitle) {
    try { draftTitle.setSelectionRange(start, end); } catch { /* Not focusable. */ }
  }
}
/** Rename… started while read-only: select the (possibly newer) title once editable. */
let selectTitleWhenEditable = false;
/** Editing moved to this window: show the normal save state and finish a pending control. */
function onEditableHere(): void {
  showSaveState();
  replayTitleBuffer();
  if (selectTitleWhenEditable) {
    selectTitleWhenEditable = false;
    if (document.activeElement === draftTitle) draftTitle.select();
  }
  const pendingAction = replayButton;
  replayButton = undefined;
  if (!pendingAction || pendingAction.documentId !== active.id || readOnlyNow()) return;
  const { button } = pendingAction;
  if (button.isConnected && !button.disabled) button.click();
}
/** Reflect ownership + transfer freeze in the editors, controls and guidance (ordinary windows only). */
function applyEditAccess(): void {
  if (viewMode) return;
  // Must match readOnlyNow: stay frozen for the whole switch/delete interval even if
  // installOwnership runs before the handler finishes (e.g. refreshDrafts after delete).
  const blocked = editBlock !== '' || transferFrozen;
  workspace.setPaneRole(blocked ? 'readonly' : 'editable');
  if (editor.readOnly !== blocked) editor.setReadOnly(blocked);
  if (titleEditor.readOnly !== blocked) titleEditor.setReadOnly(blocked);
  // A quiet reader keeps its controls enabled; a click takes over editing first (below).
  const controlsBlocked = blocked && !(quietReader() && !transferFrozen);
  for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = controlsBlocked;
  document.documentElement.dataset.role = editBlock !== '' ? 'reader' : 'editor';
  // Temporary transfer freeze must not announce "another window is editing".
  const guidance = transferFrozen || quietReader() || deletedElsewhere ? '' : editBlockGuidance(editBlock, workspace.dirty());
  if (ownershipNotice.textContent !== guidance) ownershipNotice.textContent = guidance;
  ownershipNotice.hidden = !guidance;
  syncHistory();
  syncMutationControls();
  updateSaveIndicator();
}
/** Bumped on IndexedDB versionchange so in-flight acquires cannot install after storage dies. */
let storageGeneration = 0;
type EditAccess = { ownership?: EditOwnership; block: EditBlock; generation: number };
/** Try to own `documentId` without waiting; pass `steal` only for #175 suspended-owner handoff. */
async function acquireFor(documentId: string, options: { steal?: boolean } = {}): Promise<EditAccess> {
  // Without storage nothing can be written, so there is nothing to own.
  if (viewMode || !db) return { block: '', generation: storageGeneration };
  const generation = storageGeneration;
  // E2E may set a delay to assert mutations are frozen during ownership transfer (#159 W4).
  const delayMs = testKnob('__typebridgeDelayAcquireMs');
  if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  if (generation !== storageGeneration || !db) return { block: 'error', generation: storageGeneration };
  let held: EditOwnership | undefined;
  try {
    const result = await acquireEditOwnership({
      db, locks: webLocks, documentId, instanceId,
      onLost: () => { if (held && ownership === held) loseOwnership(); },
      steal: options.steal,
    });
    // E2E: hold the lock briefly before returning so a mid-flight versionchange can be asserted.
    const afterMs = testKnob('__typebridgeDelayAfterAcquireMs');
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
  for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = true;
  undo.disabled = true;
  redo.disabled = true;
  autosave.disabled = true;
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
  // #175 step 7: pick up host Autosave changes that arrived while this window was read-only.
  if (editBlock === '') syncAutosaveCheckboxFromStorage();
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
/**
 * Two-phase #175 handoff park: freeze the UI synchronously, then release the lock
 * while keeping text/title/history/dirty until the requester confirms takeover.
 */
let parkReleaseHandle: EditOwnership | undefined;
function beginParkFreeze(): void {
  if (viewMode) return;
  parkReleaseHandle = ownership;
  ownership = undefined;
  editBlock = 'busy';
  clearTimeout(saveTimer);
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
  if (viewMode || active.id !== documentId || !workspace.dirty() || !db) return;
  try {
    const fresh = await getStoredDraft(db, documentId);
    if (fresh) {
      writingPosition.save();
      active = fresh;
      showDraft();
      workspace.setDirty(false);
    }
  } catch { /* Keep the parked snapshot read-only if IndexedDB is unavailable. */ }
  applyEditAccess();
  showSaveState();
}
/** Failed/timed-out takeover: try to re-acquire while keeping parked text intact. */
async function recoverParkedHandoffOwnership(documentId: string): Promise<void> {
  if (viewMode || ownership || active.id !== documentId) return;
  const access = await acquireFor(documentId);
  if (access.ownership) {
    installOwnership(access);
    announceAction('Editing stayed in this window — the other window could not take over.', { keepConflict: true });
    if (workspace.dirty() && autosave.checked) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persist(); }, 300);
    }
    return;
  }
  editBlock = access.block || 'lost';
  applyEditAccess();
  showSaveState();
}
function captureHandoffSnapshot(): HandoffSnapshot {
  return {
    text: field.value,
    title: draftTitle.value.trim() || UNTITLED_TITLE,
    history: editor.exportHistory(),
    dirty: workspace.dirty(),
    revision: active.revision,
  };
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
  editHereDocumentId = active.id;
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
  if (viewMode || !db || transitioning || deleting) return false;
  if (active.id !== input.documentId) return false;
  freezeEditorsForTransition();
  try {
    if (active.id !== input.documentId) {
      unfreezeEditorsAfterTransition();
      return false;
    }
    const access = await acquireFor(input.documentId, { steal: input.steal });
    if (!access.ownership) {
      unfreezeEditorsAfterTransition();
      return false;
    }
    if (active.id !== input.documentId) {
      void access.ownership.release();
      unfreezeEditorsAfterTransition();
      return false;
    }
    // After consent (before the request), always install the owner's state — never keep
    // this window's prior dirty text across a successful takeover.
    if (input.snapshot) {
      writingPosition.save();
      active = {
        ...active,
        text: input.snapshot.text,
        title: input.snapshot.title,
        history: input.snapshot.history as EditorHistory | undefined,
        revision: input.snapshot.revision,
      };
      suppressEditTracking = true;
      try {
        field.value = input.snapshot.text;
        draftTitle.value = input.snapshot.title;
        syncTitleTooltip();
        if (input.snapshot.history) editor.restoreHistory(input.snapshot.history as EditorHistory);
        else editor.restoreHistory(undefined);
      } finally {
        suppressEditTracking = false;
      }
      workspace.setDirty(input.snapshot.dirty);
      workspace.setDocumentId(active.id);
    } else {
      try {
        const fresh = await getStoredDraft(db, input.documentId);
        if (fresh === undefined) {
          void access.ownership.release();
          unfreezeEditorsAfterTransition();
          return false;
        }
        if (fresh) {
          writingPosition.save();
          active = fresh;
          showDraft();
        }
      } catch {
        void access.ownership.release();
        unfreezeEditorsAfterTransition();
        return false;
      }
    }
    installOwnership(access);
    // Private/unsaved transfer must not silently persist even if shared Autosave is on.
    if (input.snapshot?.dirty && autosave.checked) {
      autosave.checked = false;
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
    if (workspace.dirty() && autosave.checked && !input.snapshot?.dirty) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persist(); }, 300);
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
  const store = db;
  if (focusHandoff?.pending()) return;
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
      if (active.revision >= 1) markDeletedElsewhere();
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
    onEditableHere();
    if (workspace.dirty() && autosave.checked) { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void persist(); }, 300); }
  })().finally(() => {
    ownershipRetry = undefined;
    if (!rereadAfterOwnershipRetry) return;
    rereadAfterOwnershipRetry = false;
    void rereadDisplayed();
  });
}
/** Read-only pane B retries ownership when focused or the tab becomes visible again. */
async function persist(): Promise<PersistResult> {
  if (viewMode) return { saved: true, conflict: false };
  clearTimeout(saveTimer);
  if (deleting || !autosave.checked || !workspace.dirty()) return { saved: !workspace.dirty(), conflict: false };
  if (editBlock) return { saved: false, conflict: false };
  if (saving) return saving;
  saving = (async () => {
    // E2E may delay the in-flight save so Autosave-off can race a document switch (#159 W4).
    const delayMs = testKnob('__typebridgeDelayPersistMs');
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
        clearVersionNotice();
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
          }, transitioning ? statusLine.kind() : 'conflict');
          // The copy is a new document; later saves in this loop need its fence.
          await takeOwnership(result.draft.id);
        }
        // A background save must not replace newer action feedback or a conflict
        // notice, but it must replace progress and an earlier failure it resolved.
        // Use the status kind (not merely a pending conflict string) so an action that
        // kept a conflict notice — e.g. a failed draft switch — is not wiped.
        if (!workspace.dirty() && !result.conflict && (statusLine.kind() === 'progress' || statusLine.kind() === 'failure' || statusLine.kind() === 'conflict')) {
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
      if (statusLine.message().primary && statusLine.message().risk === risk) updateStatus({}, 'failure');
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
  scheduleSave();
});
field.addEventListener('historychange', () => {
  scheduleSave();
});
draftTitle.addEventListener('focus', () => {
  activatePane(PRIMARY_PANE_ID);
});
function syncTitleTooltip(): void {
  // Ellipsis may clip the field; the value and tooltip keep the full title (#156).
  draftTitle.title = draftTitle.value.trim() || UNTITLED_TITLE;
}
syncTitleTooltip();
draftTitle.addEventListener('input', () => {
  syncTitleTooltip();
  rememberActive();
  scheduleSave(true);
});
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
/** Latest host/shared Autosave value dropped while a local toggle was in flight. */
let pendingRemoteAutosave: boolean | undefined;

/**
 * Apply an Autosave preference change to this window.
 * Local Settings uses prompts; host/shared sync applies without the delete-copy dialog (#175 step 7).
 * Remote sync always updates `autosave.checked` (and clears save timers when turning off), even in
 * read-only windows, so a later ownership handoff cannot save text the user opted out of storing.
 */
async function applyAutosaveChange(
  enabled: boolean,
  opts: { promptDeleteSavedCopy: boolean; persistPreference: boolean },
): Promise<void> {
  const remote = !opts.persistPreference;
  if (autosaveToggleActive) {
    if (remote) {
      pendingRemoteAutosave = enabled;
      // Still mirror the checkbox immediately so a mid-toggle handoff sees the shared choice.
      autosave.checked = enabled;
      if (!enabled) clearTimeout(saveTimer);
    }
    return;
  }
  if (!remote && autosaveControlBlocked()) return;
  const alreadyMatching = autosave.checked === enabled;
  // Remote no-op when nothing changed and there is no dirty text left to flush.
  if (remote && alreadyMatching && !(enabled && workspace.dirty() && !autosaveControlBlocked())) {
    autosave.checked = enabled;
    return;
  }
  const blocked = autosaveControlBlocked();
  autosaveToggleActive = true;
  if (!blocked) autosave.disabled = true;
  beginAutosaveToggleGate();
  try {
    autosave.checked = enabled;
    if (opts.persistPreference) {
      try {
        setAutosaveEnabled(enabled);
        preferenceSaved('autosave', true);
        notifyPrefsChanged({
          name: 'autosave',
          origin: embedded ? `window:${windowId ?? 'main'}` : 'standalone',
        });
      } catch { preferenceSaved('autosave', false); }
    }
    // Always show the accurate save state. Without storage, no save can succeed: keep saying so.
    const announce = (text: string): void => {
      // storageProblem, not !db: db is also unset while initialization runs.
      if (storageProblem) setSaveStatus(riskText(), 'failure');
      else setSaveStatus(text);
    };
    if (enabled) {
      const primaryCanSave = !viewMode && !transferFrozen && editBlock === '';
      if (!primaryCanSave) return;
      clearNotices();
      if (workspace.dirty()) {
        showSaving();
        journalEdit();
        void persist();
      } else {
        announce('Autosave on');
      }
      return;
    }
    clearTimeout(saveTimer);
    if (blocked || !opts.promptDeleteSavedCopy) {
      if (!blocked) clearNotices();
      if (!blocked) announce(AUTOSAVE_OFF);
      else showSaveState();
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
    announce(AUTOSAVE_OFF);
  } finally {
    endAutosaveToggleGate();
    autosaveToggleActive = false;
    autosave.disabled = autosaveControlBlocked();
    // Re-focus after re-enabling only for local Settings (host owns focus on shared toggles).
    if (opts.promptDeleteSavedCopy || opts.persistPreference) {
      if (!embedded) autosave.focus({ preventScroll: true });
    }
    const queued = pendingRemoteAutosave;
    pendingRemoteAutosave = undefined;
    if (queued !== undefined) {
      void applyAutosaveChange(queued, { promptDeleteSavedCopy: false, persistPreference: false });
    }
  }
}

/** Re-read shared Autosave before this window can save again (handoff / ownership). */
function syncAutosaveCheckboxFromStorage(): void {
  try {
    const next = autosaveEnabled();
    const changed = autosave.checked !== next;
    autosave.checked = next;
    if (!next) {
      clearTimeout(saveTimer);
      if (changed) showSaveState();
      return;
    }
    // Autosave turned on while we were read-only: flush dirty text now that we can edit.
    if (changed && workspace.dirty() && !autosaveControlBlocked()) {
      showSaving();
      journalEdit();
      void persist();
    } else if (changed) {
      showSaveState();
    }
  } catch { /* Keep the current control state. */ }
}

autosave.addEventListener('change', () => {
  void applyAutosaveChange(autosave.checked, {
    promptDeleteSavedCopy: !embedded,
    persistPreference: true,
  });
});
async function switchDraft(id?: string): Promise<SwitchResult> {
  if (viewMode || transitioning) return { opened: false, conflict: false };
  if (autosaveToggleGate) await autosaveToggleGate;
  if (transitioning) return { opened: false, conflict: false };
  replayButton = undefined;
  titleBuffer = undefined;
  focusHandoff?.cancel();
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
      if (workspace.dirty() && (!autosave.checked || editBlock)) {
        const persistToken = workspace.capturePersistGeneration();
        const contentAtPrompt = workspace.contentRevision();
        if (!await askConfirmChoice({ title: 'Discard unsaved changes?', message: editBlock
          ? 'Another window is editing this document, so this window cannot save these changes. Copy or export them first to keep them.'
          : 'Copy or export unsaved changes first to keep them.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! })) {
          announceAbortedFlushConflict();
          return { opened: false, conflict: flushConflict };
        }
        // Edit-in-this-pane must not cancel discard (persist token ignores paneGeneration),
        // but a document-identity change during the dialog must.
        if (!sessionPersistStillCurrent(persistToken, {
          sessionId: workspace.sessionId,
          sessionGeneration: workspace.sessionGeneration(),
        }) || workspace.contentRevision() !== contentAtPrompt) {
          announceAction('Discard cancelled — the document changed while the dialog was open.');
          announceAbortedFlushConflict();
          return { opened: false, conflict: flushConflict };
        }
      }
      const version = workspace.contentRevision();
      next = id && db ? await getStoredDraft(db, id) : undefined;
      if (id && !next) throw new Error('Draft no longer exists');
      if (workspace.contentRevision() === version) break;
    }
    // Freeze Editor mutation gates (not only DOM readOnly) for the whole acquire/reread window.
    freezeEditorsForTransition();
    let target = next ?? allocateNewDraft();
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
draftTitle.addEventListener('blur', () => { selectTitleWhenEditable = false; });
// Documents → Rename…: in a host window the title lives in the window's title bar.
document.querySelector<HTMLButtonElement>('#rename-draft')!.addEventListener('click', () => {
  if (viewMode) return;
  if (embedded && windowId && window.parent !== window) {
    try {
      const host = hostPageApi();
      if (host?.__typebridgeHostRename) { host.__typebridgeHostRename(windowId); return; }
    } catch { /* Cross-origin parent is out of scope. */ }
  }
  draftTitle.focus();
  draftTitle.select();
  // If editing must move here first, the takeover reloads the title: select it again then.
  selectTitleWhenEditable = draftTitle.readOnly;
  editorWindowApi(window)?.__typebridgeRequestEdit?.();
});
document.querySelector<HTMLButtonElement>('#delete-draft')!.addEventListener('click', async () => {
  if (readOnlyNow() || transitioning) return;
  focusHandoff?.cancel();
  clearTimeout(saveTimer);
  const requestedId = active.id;
  // Warn when another host window shows it; that window keeps its text and can keep a copy.
  const openElsewhere = openDocumentIdsElsewhere().has(active.id);
  const deleteMessage = openElsewhere
    ? 'Permanently delete this saved document? It is also open in another window, which will keep its text until you close it there.'
    : 'Permanently delete this saved document?';
  if (!await askConfirmChoice({ title: 'Delete document?', message: deleteMessage, confirmLabel: 'Delete document', cancelLabel: 'Keep document', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! })) {
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
    const replacement: StoredDraft = allocateNewDraft();
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
    try { selected = readActiveDraftId(); } catch { /* Optional hint. */ }
    // #175 host restores each window with ?doc= when session hints are cold (fresh tab).
    if (!selected) {
      try {
        const doc = new URLSearchParams(window.location.search).get('doc');
        if (doc && isDocumentId(doc)) selected = doc;
      } catch { /* Malformed search — fall through. */ }
    }
    const pending = readPending();
    const committed = pending && drafts.find(d => d.id === pending.id);
    if (pending && committed && sameContent(pending, committed)) clearPending(pending);
    const restorePending = !!pending && (!committed || !sameContent(pending, committed));
    // A new host window must not inherit main's drafts[0] — that steals ownership and
    // makes "Saved" text disappear when the primary window still owns the document.
    // Also: session may already hold a never-saved blank id from rememberActive(); if that
    // id is not in IndexedDB yet, keep a fresh document instead of falling through to drafts[0].
    const listed = selected ? drafts.find(d => d.id === selected) : undefined;
    const openFresh = embedded && !!windowId && windowId !== 'main' && !listed && !restorePending;
    let chosen = restorePending
      ? pending!
      : listed
        ?? (openFresh
          ? (() => {
              // Distinct Untitled defaults across host windows (#175 step 8).
              const fresh = allocateNewDraft();
              return selected && isDocumentId(selected) ? { ...fresh, id: selected } : fresh;
            })()
          : drafts[0])
        ?? active;
    // A fresh blank document (new host window) is not stored yet; only a stored one can vanish.
    const chosenWasStored = drafts.some(draft => draft.id === chosen.id);
    // First acquirer among cooperating windows edits; the others open this document read-only.
    bootAccess = await acquireFor(chosen.id);
    // The list was read before this window owned the document; reread under the fence.
    if (bootAccess.ownership && !restorePending) {
      const fresh = await getStoredDraft(db, chosen.id);
      if (!fresh && chosenWasStored) {
        // Deleted while we acquired — do not install ownership over the stale list snapshot.
        void bootAccess.ownership.release();
        bootAccess = undefined;
        chosen = allocateNewDraft();
        bootAccess = await acquireFor(chosen.id);
      } else if (fresh) {
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
    updateStats();
  }
  field.disabled = false;
  draftSelect.disabled = false;
  draftTitle.disabled = false;
  applyEditAccess();
  // Focus mode must restore after the textarea is enabled — focus() is a no-op while disabled.
  restoreFocusMode();
  writingPosition.restore(active.id);
  void renderRecovery();
  finishInitialization();
}



/** Restore a pane-B reload snapshot after the primary session is live. */

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
  // Preserve ?window= so a viewer iframe keeps scoped sessionStorage across doc switches (#175).
  const href = comparisonViewerHref(import.meta.env.BASE_URL || '/', id, windowId);
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
/**
 * The displayed document was deleted in another window or tab. This window holds the
 * last copy of its text: offer Keep as new document / Close, never a takeover (there is
 * no owner left to hand over), and treat typing as Keep (#175 follow-up).
 */
function markDeletedElsewhere(): void {
  if (viewMode) return;
  deletedElsewhere = true;
  focusHandoff?.cancel();
  hideEditHereBar();
  clearVersionNotice();
  deletedBarElement().hidden = false;
  applyEditAccess();
  setSaveStatus('Deleted in another window — keep it as a new document or close it.');
}
function clearDeletedElsewhere(): void {
  const bar = deletedBarElement();
  if (!deletedElsewhere && bar.hidden) return;
  deletedElsewhere = false;
  bar.hidden = true;
}
let keepingDeleted: Promise<boolean> | undefined;
/** Save the text shown here as a new document that this window edits. */
function keepDeletedAsNew(): Promise<boolean> {
  if (keepingDeleted) return keepingDeleted;
  keepingDeleted = (async () => {
    if (!deletedElsewhere || viewMode || transitioning) return false;
    // Reserve the transition so Close / New / the picker cannot switch documents while the
    // copy takes ownership (they no-op while transitioning).
    const originalId = active.id;
    transitioning = true;
    const copy = allocateNewDraft(field.value);
    const title = draftTitle.value.trim();
    if (title) copy.title = title;
    copy.history = editor.exportHistory();
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const access = await acquireFor(copy.id);
    if (!access.ownership) {
      transitioning = false;
      announceAction('Could not keep this document here — your text is still shown; copy or export it.', { kind: 'failure' });
      return false;
    }
    if (active.id !== originalId || !deletedElsewhere) {
      void access.ownership.release();
      transitioning = false;
      return false;
    }
    writingPosition.save();
    active = copy;
    clearDeletedElsewhere();
    showDraft();
    installOwnership(access);
    try { field.setSelectionRange(start, end); } catch { /* Field not focusable. */ }
    workspace.setDirty(true);
    workspace.bumpContentRevision();
    rememberActive();
    transitioning = false;
    // Apply keys held while the copy was made before anything else can edit (keeps order).
    drainDeletedInput?.();
    void refreshDrafts().catch(() => { /* The list refreshes on next open. */ });
    if (autosave.checked) {
      const result = await persist();
      announceAction(result.saved ? 'Kept as a new document.' : 'Kept as a new document; it is not saved yet.');
    } else {
      announceAction('Kept as a new document. Autosave is off, so it is not saved yet.');
    }
    return true;
  })().finally(() => {
    keepingDeleted = undefined;
    if (transitioning && deletedElsewhere) transitioning = false;
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
      if (quietReader()) showSaveState();
      else setSaveStatus('Updated to the latest saved version. ' + readOnlyStatus());
    }
    scheduleListRefresh();
  } else if (action === 'missing') {
    if (viewMode) showViewerMissing(VIEWER_MISSING);
    else if (active.revision >= 1) markDeletedElsewhere();
    scheduleListRefresh();
  } else if (action === 'notice-newer') showVersionNotice(NEWER_VERSION_NOTICE);
  else if (action === 'notice-deleted') markDeletedElsewhere();
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
});
function reconcileSignals(): void {
  if (document.visibilityState !== 'visible') return;
  scheduleListRefresh();
  // Readers: single-flight reread+acquire. Owners/viewers: still reread so missed signals surface.
  if (mayRetryEditOwnership(editBlock)) retryOwnership();
  else void rereadDisplayed();
}
// #175 step 4: pointer on a read-only field runs cooperative handoff (steal only via Edit here).
// Plain retry still runs for visibility/window focus when the lock was freed without a handoff.
field.addEventListener('focus', () => {
  if (focusHandoff?.pending()) return;
  if (editBlock === 'busy' || editBlock === 'lost' || editBlock === 'error') return;
  retryOwnership();
});
window.addEventListener('focus', reconcileSignals);
document.addEventListener('visibilitychange', reconcileSignals);

if (!viewMode) {
  focusHandoff = installFocusHandoff({
    field,
    windowId,
    instanceId,
    getDocumentId: () => active.id,
    isViewMode: () => viewMode,
    isOwner: () => !!ownership && editBlock === '',
    editBlock: () => editBlock,
    isComposing: () => editor.composing,
    isTransitioning: () => transitioning || deleting || transferFrozen || !!ownershipRetry,
    isSaving: () => !!saving,
    saveFailed: () => saveFailed,
    isDirty: () => workspace.dirty(),
    autosaveOn: () => autosave.checked,
    confirmDiscardDirtyForHandoff: async () => {
      const discard = await askConfirmChoice({
        title: 'Discard unsaved changes?',
        message: editBlock
          ? 'Another window is editing this document, so this window cannot save these changes. Copy or export them first to keep them. Taking over editing replaces them with the other window’s text (or the last saved copy).'
          : 'Copy or export unsaved changes first to keep them. Taking over editing replaces them with the other window’s text (or the last saved copy).',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        returnFocus: field,
      });
      if (!discard) return false;
      // Apply the discard immediately (same as the switch path) so a failed takeover
      // cannot resurrect the private text the user already agreed to drop.
      if (db) {
        try {
          const fresh = await getStoredDraft(db, active.id);
          if (fresh) {
            writingPosition.save();
            active = fresh;
            showDraft();
            workspace.setDirty(false);
          }
        } catch { /* Keep editing; takeover will reread under the new fence. */ }
      }
      applyEditAccess();
      showSaveState();
      return true;
    },
    flushSave: async () => { await persist(); },
    captureSnapshot: captureHandoffSnapshot,
    beginParkFreeze,
    finishParkRelease,
    discardParkedText: discardParkedHandoffText,
    recoverParkedOwnership: recoverParkedHandoffOwnership,
    takeOver: takeOverFromHandoff,
    announce: text => {
      if (text === EDITABLE_HERE) onEditableHere();
      else {
        replayButton = undefined;
        if (titleBuffer) {
          titleBuffer = undefined;
          announceAction('Your title change was not applied.', { keepConflict: true });
        }
        announceAction(text, { keepConflict: true });
      }
    },
    showEditHere: showEditHereBar,
    hideEditHere: hideEditHereBar,
  });
  // A quiet reader takes over editing from any edit gesture, not only the text field:
  // the title and document-changing controls. Plain focus (Tab, F6, programmatic) does
  // not take over; the text field starts a takeover on pointer or typing (focus-handoff).
  const requestEditHere = (): void => {
    if (!quietReader() || transitioning || deleting || transferFrozen) return;
    if (focusHandoff?.pending()) return;
    focusHandoff?.requestHandoff();
  };
  /**
   * Hold a title edit made while this window cannot edit yet, and start the takeover.
   * Returns false when the title is editable (the edit should run normally).
   */
  const bufferTitleEdit = (op: TitleOp, start: number, end: number, fromHost: boolean): boolean => {
    if (!draftTitle.readOnly || !quietReader()) return false;
    if (!titleBuffer || titleBuffer.documentId !== active.id) {
      titleBuffer = { documentId: active.id, baseValue: draftTitle.value, ops: [], fromHost };
    }
    titleBuffer.ops.push({ ...op, start, end });
    // Typed edits replace the selection themselves; do not reselect afterwards.
    selectTitleWhenEditable = false;
    requestEditHere();
    return true;
  };
  /** The title edit a key stands for, if any (printable, Backspace, Delete; no shortcuts). */
  const titleOpForKey = (event: KeyboardEvent): TitleOp | undefined => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return undefined;
    if (event.key.length === 1) return { inputType: 'insertText', data: event.key };
    if (event.key === 'Backspace') return { inputType: 'deleteContentBackward', data: null };
    if (event.key === 'Delete') return { inputType: 'deleteContentForward', data: null };
    return undefined;
  };
  draftTitle.addEventListener('pointerdown', requestEditHere);
  draftTitle.addEventListener('beforeinput', requestEditHere);
  draftTitle.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text && bufferTitleEdit({ inputType: 'insertFromPaste', data: text },
      draftTitle.selectionStart ?? draftTitle.value.length, draftTitle.selectionEnd ?? draftTitle.value.length, false)) {
      event.preventDefault();
    } else requestEditHere();
  });
  // A read-only input fires no beforeinput, so start from keyboard intent; focus alone does not.
  // The key itself is held and applied once editing arrives, so nothing typed is lost (#197).
  draftTitle.addEventListener('keydown', event => {
    // Read-only inputs ignore caret keys; place the caret so held edits land where intended.
    if (moveReadOnlyCaret(draftTitle, event)) return;
    const op = titleOpForKey(event);
    if (!op) return;
    if (bufferTitleEdit(op, draftTitle.selectionStart ?? draftTitle.value.length,
      draftTitle.selectionEnd ?? draftTitle.value.length, false)) event.preventDefault();
  });
  // Host title bar (#175 step 8) edits this window's title: let it start a takeover too,
  // and hold what was typed there the same way.
  exposeEditorWindowApi({
    __typebridgeRequestEdit: requestEditHere,
    __typebridgeBufferTitleEdit: (op, start, end) => {
      // Deleted elsewhere: typing in the title keeps the text as a new document, then applies.
      if (deletedElsewhere) {
        holdTitleOp(op, start, end, true);
        keepThenApply();
        return true;
      }
      return bufferTitleEdit(op, start, end, true);
    },
  });

  // Deleted elsewhere (#175 follow-up): no takeover (nobody owns it any more). Keep as new
  // document or Close; typing or pasting into the text or title keeps it, then applies.
  document.querySelector<HTMLButtonElement>('#keep-deleted')!.addEventListener('click', () => {
    void keepDeletedAsNew().then(kept => { if (kept) field.focus(); });
  });
  document.querySelector<HTMLButtonElement>('#close-deleted')!.addEventListener('click', () => {
    const other = drafts.find(draft => draft.id !== active.id);
    void switchDraft(other?.id);
  });
  // Held while the copy is created, then replayed through the editors (transliteration, undo)
  // as soon as it is editable, before any later key or the first save.
  let heldText: BufferedInsert[] = [];
  let heldTitle: HeldTitleOp[] = [];
  let heldTitleBase = '';
  let heldTitleFromHost = false;
  const holdTitleOp = (op: TitleOp, start: number, end: number, fromHost: boolean): void => {
    if (heldTitle.length === 0) { heldTitleBase = draftTitle.value; heldTitleFromHost = fromHost; }
    heldTitle.push({ ...op, start, end });
  };
  drainDeletedInput = (): void => {
    const text = heldText;
    const title = heldTitle;
    heldText = [];
    heldTitle = [];
    // Focus first: Firefox can drop an unfocused textarea's caret between replayed edits.
    if (text.length) {
      const caretStart = field.selectionStart;
      const caretEnd = field.selectionEnd;
      field.focus();
      try { field.setSelectionRange(caretStart, caretEnd); } catch { /* Not focusable. */ }
    }
    for (const item of text) replayBufferedInsert(field, item);
    if (title.length) {
      const at = applyHeldTitleOps(title, draftTitle.value !== heldTitleBase);
      if (!heldTitleFromHost) {
        draftTitle.focus();
        try { draftTitle.setSelectionRange(at.start, at.end); } catch { /* Not focusable. */ }
      }
    }
  };
  const keepThenApply = (): void => {
    void keepDeletedAsNew().then(kept => {
      if (!kept) { heldText = []; heldTitle = []; }
    });
  };
  const deletedTarget = (event: Event): HTMLTextAreaElement | HTMLInputElement | undefined => {
    if (!deletedElsewhere) return undefined;
    return event.target === field ? field : event.target === draftTitle ? draftTitle : undefined;
  };
  // While Keep is making the copy (usually a few ms), the caret and selection must not move:
  // held edits replay at the selection captured when it started.
  const keepPending = (): boolean => !!keepingDeleted || heldText.length > 0 || heldTitle.length > 0;
  const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  // Capture on the document so these run before the takeover listeners on the field.
  document.addEventListener('pointerdown', event => {
    if (!deletedTarget(event)) return;
    event.stopImmediatePropagation();
    if (keepPending()) event.preventDefault();
  }, true);
  document.addEventListener('keydown', event => {
    const target = deletedTarget(event);
    if (!target) return;
    if (keepPending() && CARET_KEYS.has(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (target === field) {
      const insert = bufferInsertFromKeyboard(event);
      if (!insert) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      heldText.push(insert);
    } else {
      const op = titleOpForKey(event);
      if (!op) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      holdTitleOp(op, draftTitle.selectionStart ?? draftTitle.value.length, draftTitle.selectionEnd ?? draftTitle.value.length, false);
    }
    keepThenApply();
  }, true);
  document.addEventListener('paste', event => {
    const target = deletedTarget(event);
    if (!target) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!text) return;
    if (target === field) heldText.push({ kind: 'paste', text });
    else holdTitleOp({ inputType: 'insertFromPaste', data: text }, draftTitle.selectionStart ?? draftTitle.value.length, draftTitle.selectionEnd ?? draftTitle.value.length, false);
    keepThenApply();
  }, true);
  const replayAfterTakeover = new Set(['undo', 'redo', 'delete-draft', 'convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all']);
  document.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest?.('button');
    if (!button || !replayAfterTakeover.has(button.id) || !quietReader()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    replayButton = { button, documentId: active.id };
    requestEditHere();
  }, true);
  editHereButton.addEventListener('click', () => {
    if (editHereDocumentId && active.id !== editHereDocumentId) {
      hideEditHereBar();
      return;
    }
    // Explicit Edit here is consent: steal for unresponsive or cross-tab private warnings.
    const steal = editHereReason === 'unresponsive'
      || editHereReason === 'cross-tab-private'
      || editHereReason === 'private';
    hideEditHereBar();
    focusHandoff?.requestHandoff({ steal });
  });
}
// Without BroadcastChannel, focus/visibility reread is the baseline; a slow poll only runs for a visible viewer.
if (viewMode && !signalChannel) setInterval(reconcileSignals, SIGNAL_POLL_INTERVAL_MS);
void (viewMode ? initializeViewer() : initializeDrafts());

setupComparisonOpen({
  embedded,
  isBusy: () => viewMode || field.disabled || transitioning || deleting,
  hasStorage: () => !!db,
  activeDocument: () => ({ id: active.id, revision: active.revision }),
  isDirty: () => workspace.dirty(),
  announce: announceAction,
});

setupExportImport({
  exportSurface: () => ({
    title: draftTitle.value.trim() || UNTITLED_TITLE,
    text: field.value,
  }),
  announce: announceAction,
  isViewMode: () => viewMode,
  confirmImport: () => askConfirmChoice({ title: 'Import document?', message: 'Import as a new document? Your current document will be kept.', confirmLabel: 'Import document', cancelLabel: 'Cancel import', returnFocus: document.querySelector<HTMLButtonElement>('#doc-menu-open')! }),
  importDocument: async ({ title, text }) => {
    const imported = { ...newDraft(text), title };
    // Save even when autosave is off: importing is an explicit save action.
    if (!db) throw new Error('browser storage cannot be used');
    const result = await commitOrCreateConflictCopy(db, imported, 0, crypto.randomUUID());
    postSignal('saved', result.draft.id, result.draft.revision);
    return switchDraft(result.draft.id);
  },
});
if (!viewMode) window.addEventListener('pagehide', () => {
  if (reloadBackup.suppressed()) return;
  savePending();
  clearTimeout(saveTimer);
  void persist();
});
let allowUpdateReload = false;
let privateReloadChoice: { id: string; generation: number } | undefined;
function updateReloadReturnFocus(): HTMLElement {
  const local = document.querySelector<HTMLButtonElement>('#update-reload');
  if (local) return local;
  try {
    const host = window.parent !== window
      ? window.parent.document.querySelector<HTMLButtonElement>('#update-reload')
      : null;
    if (host) return host;
  } catch { /* Cross-origin parent. */ }
  return field;
}
function clearPendingBackups(): void {
  reloadBackup.remove();
}

/**
 * Host calls this immediately before removing the iframe. Arming suppress here — not during
 * prepare — keeps reload/close consent cancellable without disabling backups for the session.
 */
function commitWindowClose(): void {
  reloadBackup.setSuppressed(true);
  clearPendingBackups();
  // Confirmed discard must forget this window's emergency journals so another
  // window's recovery poll does not re-offer text the user chose to discard.
  const discardedJournal = currentJournal;
  currentJournal = undefined;
  if (discardedJournal) {
    try { clearRecovery(localStorage, discardedJournal); } catch { /* Optional backup. */ }
  }
}

async function prepareLeaveWithUnsaved(kind: 'reload' | 'close'): Promise<boolean> {
  if (transitioning || deleting || field.disabled) return false;
  privateReloadChoice = undefined;
  if (workspace.dirty() && !autosave.checked) {
    const discard = await askConfirmChoice({
      title: kind === 'close' ? 'Close without saving?' : 'Reload without saving?',
      message: 'Autosave is off. Text and title changes will be lost. Copy or export them first if you want to keep them.',
      confirmLabel: kind === 'close' ? 'Discard changes and close' : 'Discard changes and reload',
      cancelLabel: 'Keep editing',
      returnFocus: updateReloadReturnFocus(),
    });
    if (discard) {
      privateReloadChoice = { id: active.id, generation: workspace.contentRevision() };
    }
    return discard;
  }
  savePending();
  if (workspace.dirty()) await persist();
  if (!workspace.dirty()) return true;
  savePending();
  const pending = readPending();
  const primaryOk = !workspace.dirty() || (!!pending && sameContent(pending, snapshot()));
  if (kind === 'reload') return primaryOk;
  // Close: a session backup is not enough — closing removes the iframe and must not
  // silently destroy the only copy after a failed save. Ask for explicit discard.
  return askConfirmChoice({
    title: 'Close and discard unsaved changes?',
    message: 'The latest save could not finish. Closing this window discards the unsaved text. Copy or export it first if you want to keep it.',
    confirmLabel: 'Discard changes and close',
    cancelLabel: 'Keep editing',
    returnFocus: updateReloadReturnFocus(),
  });
}
async function prepareUpdateReload(): Promise<boolean> {
  return prepareLeaveWithUnsaved('reload');
}
async function prepareWindowClose(): Promise<boolean> {
  return prepareLeaveWithUnsaved('close');
}
/** Validate and arm reload; throws to abort. Does not navigate (host reloads the top page). */
function assertSafeToReloadAfterUpdate(): void {
  if (transitioning || deleting || field.disabled || document.querySelector('.confirm-backdrop')) throw new Error('Finish the current action first');
  if (workspace.dirty()) {
    if (!autosave.checked) {
      if (privateReloadChoice?.id !== active.id || privateReloadChoice.generation !== workspace.contentRevision()) {
        throw new Error('Private edits changed');
      }
    } else {
      savePending();
      const pending = readPending();
      if (!pending || !sameContent(pending, snapshot())) throw new Error('Reload backup unavailable');
    }
  }
  allowUpdateReload = true;
}
function reloadAfterUpdate(): void {
  assertSafeToReloadAfterUpdate();
  try { window.location.reload(); } catch (error) { allowUpdateReload = false; throw error; }
}
if (!viewMode) window.addEventListener('beforeunload', event => {
  if (reloadBackup.suppressed()) return;
  if (workspace.dirty()) {
    savePending();
    clearTimeout(saveTimer);
    void persist();
    if (!allowUpdateReload) { event.preventDefault(); event.returnValue = ''; }
  }
});
if (!viewMode) document.addEventListener('visibilitychange', () => {
  if (reloadBackup.suppressed()) return;
  if (document.visibilityState === 'hidden') {
    clearTimeout(saveTimer);
    void persist();
  }
});
updateStats();

if (!embedded) {
  setupResetSettings({ actions: [
    ['appearance', appearanceSettings.reset], ['window layout', windowLayoutSettings.reset],
    ['typing mode/shortcut', typingSettings.reset], ['custom rules', resetRules], ['Find options', resetOptions],
    ['Tab indents', () => { tabIndent.checked = true; return saveTabIndent(); }], ['editor layout', resetLayout],
  ], announce: announceAction });
}

function applyAutosaveFromStorage(): void {
  let next: boolean;
  try { next = autosaveEnabled(); }
  catch { return; }
  void applyAutosaveChange(next, { promptDeleteSavedCopy: false, persistPreference: false });
}

function applyPrefs(name: PrefName): void {
  if (name === 'appearance' || name === 'reset') appearanceSettings.applyFromStorage();
  if (name === 'transliteration' || name === 'shortcut' || name === 'reset') typingSettings.applyFromStorage();
  if (name === 'tabIndent' || name === 'reset') applyTabIndentFromStorage();
  if (name === 'autosave' || name === 'reset') applyAutosaveFromStorage();
  if (name === 'reset') {
    try { resetOptions(); } catch { /* Find bar may be closed. */ }
    try { resetLayout(); } catch { /* Layout reset is best-effort. */ }
  }
}

onPrefsChanged(detail => {
  applyPrefs(detail.name);
}, { skipOrigin: embedded ? `window:${windowId ?? 'main'}` : 'standalone' });

// Host page registers the service worker and shows the update notice once (#175 step 3).
if (!embedded && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => watchForUpdates(registration, {
        prepareReload: prepareUpdateReload,
        reload: reloadAfterUpdate,
        cancelReload: () => { allowUpdateReload = false; reloadBackup.setSuppressed(false); },
        dismissedKey: updateDismissKey,
      }))
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
if (embedded) {
  // This window's side of the host↔window contract (see view/embed-api.ts).
  const hooks: EditorWindow = window;
  hooks.__typebridgePrepareUpdateReload = prepareUpdateReload;
  hooks.__typebridgeAssertSafeUpdateReload = assertSafeToReloadAfterUpdate;
  hooks.__typebridgeCancelUpdateReload = () => { allowUpdateReload = false; reloadBackup.setSuppressed(false); };
  hooks.__typebridgePrepareWindowClose = prepareWindowClose;
  hooks.__typebridgeCommitWindowClose = commitWindowClose;
  hooks.__typebridgeSetFocusMode = applyFocusModeOnly;
  hooks.__typebridgeApplyPrefs = (name, origin) => {
    if (origin && origin === `window:${windowId ?? 'main'}`) return;
    // Re-dispatch in this window with iframe-local primitives so every module
    // listener runs (rules, appearance, …). Avoid host-realm detail objects.
    window.dispatchEvent(new CustomEvent(PREFS_EVENT, {
      detail: {
        name: String(name) as PrefName,
        origin: origin !== undefined ? String(origin) : undefined,
      },
    }));
  };
  hooks.__typebridgeGetTitle = () => draftTitle.value.trim() || UNTITLED_TITLE;
  hooks.__typebridgeSetTitle = title => {
    if (viewMode || draftTitle.readOnly || draftTitle.disabled) return;
    const next = title.slice(0, 150);
    if (draftTitle.value === next) return;
    draftTitle.value = next;
    syncTitleTooltip();
    rememberActive();
    scheduleSave(true);
  };
  hooks.__typebridgeToggleTransliteration = () => {
    enabled.checked = !enabled.checked;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
  };
  hooks.__typebridgeOpenFind = openFind;
  hooks.__typebridgeTitleCommit = (value, start, end) => {
    if (viewMode || draftTitle.readOnly || draftTitle.disabled) return null;
    const next = value.slice(0, 150);
    if (draftTitle.value !== next) {
      draftTitle.value = next;
      // Dispatch input so titleEditor records a single undoable edit.
      draftTitle.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const caret = Math.max(0, Math.min(start ?? next.length, next.length));
    const caretEnd = Math.max(caret, Math.min(end ?? caret, next.length));
    syncTitleTooltip();
    rememberActive();
    scheduleSave(true);
    return { value: draftTitle.value, start: caret, end: caretEnd };
  };
  hooks.__typebridgeTitleEdit = applyTitleEdit;
  // Catch prefs the host broadcast before this iframe finished booting.
  syncAutosaveCheckboxFromStorage();
  try { applyTabIndentFromStorage(); } catch { /* optional */ }
  try { appearanceSettings.applyFromStorage(); } catch { /* optional */ }
  try { typingSettings.applyFromStorage(); } catch { /* optional */ }
  // Do not rememberActive() here: initializeDrafts() still needs the prior
  // session/?doc= selection. Publishing the temporary blank id early would
  // overwrite it and leave secondary host windows blank after reload (#175 s8).
}
