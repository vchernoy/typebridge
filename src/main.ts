import { setupAppearance } from './ui/appearance';
import { setupWindowLayoutSetting } from './ui/window-layout-setting';
import { setupResetSettings } from './ui/reset-settings';
import { watchForUpdates } from './ui/update-notice';
import { SHORTCUTS } from './editor/keyboard-shortcuts';
import { setupKeyboardShortcuts } from './ui/keyboard-shortcuts';
import './style.css';
import { Editor } from './editor/editor';
import { indentEdit } from './editor/indent';
import { EDITABLE_HERE, STORAGE_UNAVAILABLE } from './editor/status';
import { createStatusLine } from './ui/status-line';
import { createReloadBackup, sameContent } from './view/reload-backup';
import { createEditorState } from './view/editor-state';
import { createViewerMode } from './view/viewer-mode';
import { createSaver } from './view/saver';
import { createAutosaveToggle, type AutosaveToggle } from './view/autosave-toggle';
import { createDocumentActions, type EditAccess } from './view/documents';
import { createRecovery } from './view/recovery';
import { draftMatchesQuery, draftPickerLabel } from './editor/draft-list';
import {
  ACTIVE_DRAFT_KEY_BASE,
  UNTITLED_TITLE,
  autosaveEnabled,
  configureActiveDraftKey,
  newDraft,
  readActiveDraftId,
  setActiveDraftId,
} from './editor/drafts';
import { nextUntitledTitle } from './editor/untitled-title';
import { moveReadOnlyCaret } from './ui/readonly-caret';
import { nextCharacterBoundary, previousCharacterBoundary } from './editor/characters';
import { FIND_KEY, REPLACE_KEY } from './editor/search-settings';
import { askConfirmChoice } from './ui/confirm-dialog';
import { openDraftDatabase, listStoredDrafts, getStoredDraft, commitOrCreateConflictCopy, type StoredDraft } from './editor/indexeddb';
import { acquireEditOwnership, type EditOwnership } from './editor/edit-ownership';
import { editBlockGuidance, mayRetryEditOwnership } from './view/ownership';
import { bufferInsertFromKeyboard, handoffRefuseGuidance, mapSelectionAcrossTextChange, replayBufferedInsert, type BufferedInsert, type HandoffRefuseReason, type HandoffSnapshot } from './view/handoff';
import { installFocusHandoff, type FocusHandoffController } from './view/focus-handoff';
import type { EditorHistory } from './editor/editor';
import { createSinglePaneWorkspace, PRIMARY_PANE_ID } from './view/workspace';
import {
  commandAllowedOnPane,
  contentCommandStillCurrent,
  type CommandGeneration,
} from './view/session';
import { clearRecovery, writeRecovery } from './editor/recovery';
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
import { isDocumentId, parseComparisonRoute } from './view/route';
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
/** Core document state shared with the split-out modules (view/editor-state.ts). */
const state = createEditorState();
/** True only during the post-flush ownership acquire/reread window (not while flushing). */
let transferFrozen = false;
/** Suppress scheduleSave while applying handoff snapshots (not a content edit). */
let suppressEditTracking = false;
/**
 * The Autosave change handler (view/autosave-toggle.ts), created once its dependencies exist.
 * Declared here because syncAutosaveControl runs during module init, before that point.
 */
// eslint-disable-next-line prefer-const -- assigned once later; a const here would be read before it is set.
let autosaveToggle: AutosaveToggle | undefined;
const webLocks: LockManager | undefined = typeof navigator.locks?.request === 'function' ? navigator.locks : undefined;
/** True while this window must not change the displayed document. */
/** True when the UI must refuse mutations (viewer, non-owner, or frozen for ownership transfer). */
const readOnlyNow = (): boolean => viewMode || state.editBlock !== '' || transferFrozen;
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
const quietReader = (): boolean => !viewMode && state.editBlock === 'busy' && !workspace.dirty() && !deletedElsewhere;
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

const statusLine = createStatusLine({
  conflictNotice,
  statusSep,
  status,
  afterRender: () => { updateSaveIndicator(); },
  risk: () => ({
    storageProblem: state.storageProblem,
    dirty: workspace.dirty(),
    blocked: state.editBlock !== '',
    saveFailed: state.saveFailed,
    autosaveOn: autosave.checked,
  }),
  editBlock: () => state.editBlock,
  quietReader: () => quietReader(),
});
const {
  updateStatus, clearNotices, setSaveStatus, setRiskStatus,
  announceAction, showSaveState, readOnlyStatus,
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
  return state.editBlock !== '';
}
function syncAutosaveControl(): void {
  if (viewMode || autosaveToggle?.isActive()) return;
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
/** Document-identity counter lives on the workspace as sessionGeneration (formerly viewGeneration). */
const saveIndicator = document.querySelector<HTMLElement>('#save-indicator')!;
/** Persistence state, independent of action feedback retained in the live status line. */
function updateSaveIndicator(): void {
  const indicator = state.storageProblem || state.saveFailed ? 'failed'
    : deletedElsewhere ? 'unsaved'
    : quietReader() ? (!autosave.checked || !state.db ? 'unsaved' : 'saved')
    : state.editBlock ? (workspace.dirty() ? 'unsaved' : 'readonly')
    : !autosave.checked || !state.db ? 'unsaved' : workspace.dirty() ? 'saving' : 'saved';
  const label = { failed: 'Save failed', readonly: 'Read-only', unsaved: 'Not saved', saving: 'Saving…', saved: 'Saved' }[indicator];
  if (saveIndicator.textContent !== label) saveIndicator.textContent = label;
  saveIndicator.dataset.state = indicator;
}
// Viewers use their own key namespace so they never overwrite an editor's saved offsets.
// Window id scopes positions when multiple instances share one tab's sessionStorage (#175).
const writingPosition = setupWritingPosition(
  field,
  () => state.loadingDraft || field.disabled || state.viewMissing ? undefined : state.active.id,
  writingPositionNamespace(windowId, viewMode),
);
const recovery = createRecovery(state, statusLine, {
  viewMode, autosave, field, draftTitle,
  anchor: status.parentElement!,
  postSignal: (type, documentId, revision) => { postSignal(type, documentId, revision); },
  refreshDrafts: () => refreshDrafts(),
});
const { ownerReady, journalEdit, renderRecovery } = recovery;

field.disabled = true;
draftSelect.disabled = true;
draftTitle.disabled = true;
autosave.checked = true;
try { autosave.checked = autosaveEnabled(); } catch { /* Keep editing available if preferences are blocked. */ }
// A tab-scoped emergency snapshot is not the committed draft. It only bridges
// navigation/reload when the browser aborts an IndexedDB transaction on unload.
const PENDING_KEY = scopeSessionKey('typebridge.pendingDraft.v1', windowId);
function snapshot(): StoredDraft {
  return { ...state.active, text: field.value, title: draftTitle.value.trim() || UNTITLED_TITLE, history: editor.exportHistory(), updatedAt: Date.now() };
}
const reloadBackup = createReloadBackup({
  key: PENDING_KEY,
  snapshot,
  mayBackUp: () => !viewMode && workspace.dirty() && autosave.checked && !state.deleting,
  // Keep any conflict notice and the current risk; only replace the primary.
  // Trailing period stays; renderStatusBody joins risk with a space after it.
  onFailed: () => { setRiskStatus('Unsaved text could not be backed up for reload. Copy or export it.', 'failure'); },
});
const readPending = reloadBackup.read;
const savePending = reloadBackup.save;
const clearPending = reloadBackup.clear;
function rememberActive(): void {
  if (viewMode) return;
  try { setActiveDraftId(state.active.id); } catch { /* Selection is only a hint. */ }
  // Tell the #175 host so layout persistence can record this window's document id / title.
  if (embedded && window.parent !== window) {
    try {
      // Post the raw field value (may be empty while renaming). The host applies
      // the Untitled fallback for chrome metadata without clobbering in-progress edits.
      window.parent.postMessage({
        type: 'typebridge-active-draft',
        windowId,
        documentId: state.active.id,
        title: draftTitle.value,
      }, window.location.origin);
    } catch { /* Cross-origin parent — host will probe on unload. */ }
  }
}

/** #175 step 8: never reuse an existing Untitled document / Untitled document N name. */
function allocateNewDraft(text = ''): StoredDraft {
  const titles = state.drafts.map(draft => draft.title);
  titles.push(state.active.title, draftTitle.value.trim() || UNTITLED_TITLE);
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
  const visibleBase = state.viewMissing || state.drafts.some(d => d.id === state.active.id) ? state.drafts : [state.active, ...state.drafts];
  const displayTitle = draftTitle.value.trim() || UNTITLED_TITLE;
  const elsewhere = openDocumentIdsElsewhere();
  const visible = visibleBase.filter(draft => draftMatchesQuery({
    title: draft.id === state.active.id ? displayTitle : draft.title,
    text: draft.id === state.active.id ? field.value : draft.text,
    query: docSearchQuery,
  }));
  for (const picker of documentPickers) {
    picker.replaceChildren();
    for (const draft of visible) {
      const option = document.createElement('option');
      option.value = draft.id;
      const isCurrent = draft.id === state.active.id;
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
    picker.value = state.viewMissing ? '' : state.active.id;
  }
  // Shown as a list inside the document menu: at least two rows, at most eight.
  draftSelect.size = Math.min(8, Math.max(2, draftSelect.options.length || 2));
}
async function refreshDrafts(): Promise<void> {
  const delayMs = testKnob('__typebridgeDelayRefreshMs');
  if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  if (state.db) state.drafts = await listStoredDrafts(state.db);
  renderDrafts();
  if (statusLine.message().draftListRefreshFailed) updateStatus({ draftListRefreshFailed: false });
}
function showDraft(): void {
  clearDeletedElsewhere();
  // Callers decide post-load status; clearing through updateStatus keeps the DOM in sync.
  workspace.bumpSessionGeneration();
  workspace.setDocumentId(state.active.id);
  clearVersionNotice();
  clearNotices();
  state.loadingDraft = true;
  try {
    editor.load(state.active.text);
    if (!viewMode) editor.restoreHistory(state.active.history);
    draftTitle.value = state.active.title;
    syncTitleTooltip();
    workspace.setDirty(false);
    state.saveFailed = false; // The editor no longer holds the unsaved text.
  } finally { state.loadingDraft = false; }
  writingPosition.restore(state.active.id);
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
  if (!held || held.documentId !== state.active.id || draftTitle.readOnly) return;
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
  if (!pendingAction || pendingAction.documentId !== state.active.id || readOnlyNow()) return;
  const { button } = pendingAction;
  if (button.isConnected && !button.disabled) button.click();
}
/** Reflect ownership + transfer freeze in the editors, controls and guidance (ordinary windows only). */
function applyEditAccess(): void {
  if (viewMode) return;
  // Must match readOnlyNow: stay frozen for the whole switch/delete interval even if
  // installOwnership runs before the handler finishes (e.g. refreshDrafts after delete).
  const blocked = state.editBlock !== '' || transferFrozen;
  workspace.setPaneRole(blocked ? 'readonly' : 'editable');
  if (editor.readOnly !== blocked) editor.setReadOnly(blocked);
  if (titleEditor.readOnly !== blocked) titleEditor.setReadOnly(blocked);
  // A quiet reader keeps its controls enabled; a click takes over editing first (below).
  const controlsBlocked = blocked && !(quietReader() && !transferFrozen);
  for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = controlsBlocked;
  document.documentElement.dataset.role = state.editBlock !== '' ? 'reader' : 'editor';
  // Temporary transfer freeze must not announce "another window is editing".
  const guidance = transferFrozen || quietReader() || deletedElsewhere ? '' : editBlockGuidance(state.editBlock, workspace.dirty());
  if (ownershipNotice.textContent !== guidance) ownershipNotice.textContent = guidance;
  ownershipNotice.hidden = !guidance;
  syncHistory();
  syncMutationControls();
  updateSaveIndicator();
}
/** Bumped on IndexedDB versionchange so in-flight acquires cannot install after storage dies. */
let storageGeneration = 0;

/** Try to own `documentId` without waiting; pass `steal` only for #175 suspended-owner handoff. */
async function acquireFor(documentId: string, options: { steal?: boolean } = {}): Promise<EditAccess> {
  // Without storage nothing can be written, so there is nothing to own.
  if (viewMode || !state.db) return { block: '', generation: storageGeneration };
  const generation = storageGeneration;
  // E2E may set a delay to assert mutations are frozen during ownership transfer (#159 W4).
  const delayMs = testKnob('__typebridgeDelayAcquireMs');
  if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  if (generation !== storageGeneration || !state.db) return { block: 'error', generation: storageGeneration };
  let held: EditOwnership | undefined;
  try {
    const result = await acquireEditOwnership({
      db: state.db, locks: webLocks, documentId, instanceId,
      onLost: () => { if (held && state.ownership === held) loseOwnership(); },
      steal: options.steal,
    });
    // E2E: hold the lock briefly before returning so a mid-flight versionchange can be asserted.
    const afterMs = testKnob('__typebridgeDelayAfterAcquireMs');
    if (typeof afterMs === 'number' && afterMs > 0 && result.status === 'acquired') {
      await new Promise(resolve => setTimeout(resolve, afterMs));
    }
    if (generation !== storageGeneration || !state.db) {
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
  if (access.ownership && (access.generation !== storageGeneration || !state.db)) {
    void access.ownership.release();
    next = { block: access.block === '' ? 'error' : access.block, generation: storageGeneration };
  }
  const previous = state.ownership;
  state.ownership = next.ownership;
  state.editBlock = next.block;
  if (previous && previous !== state.ownership) void previous.release();
  applyEditAccess();
  // #175 step 7: pick up host Autosave changes that arrived while this window was read-only.
  if (state.editBlock === '') syncAutosaveCheckboxFromStorage();
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
  const previous = state.ownership;
  state.ownership = undefined;
  state.editBlock = 'lost';
  saver.cancel();
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
  parkReleaseHandle = state.ownership;
  state.ownership = undefined;
  state.editBlock = 'busy';
  saver.cancel();
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
  if (viewMode || state.active.id !== documentId || !workspace.dirty() || !state.db) return;
  try {
    const fresh = await getStoredDraft(state.db, documentId);
    if (fresh) {
      writingPosition.save();
      state.active = fresh;
      showDraft();
      workspace.setDirty(false);
    }
  } catch { /* Keep the parked snapshot read-only if IndexedDB is unavailable. */ }
  applyEditAccess();
  showSaveState();
}
/** Failed/timed-out takeover: try to re-acquire while keeping parked text intact. */
async function recoverParkedHandoffOwnership(documentId: string): Promise<void> {
  if (viewMode || state.ownership || state.active.id !== documentId) return;
  const access = await acquireFor(documentId);
  if (access.ownership) {
    installOwnership(access);
    announceAction('Editing stayed in this window — the other window could not take over.', { keepConflict: true });
    if (workspace.dirty() && autosave.checked) {
      saver.saveSoon();
    }
    return;
  }
  state.editBlock = access.block || 'lost';
  applyEditAccess();
  showSaveState();
}
function captureHandoffSnapshot(): HandoffSnapshot {
  return {
    text: field.value,
    title: draftTitle.value.trim() || UNTITLED_TITLE,
    history: editor.exportHistory(),
    dirty: workspace.dirty(),
    revision: state.active.revision,
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
      saver.saveSoon();
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
  if (focusHandoff?.pending()) return;
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
    if (workspace.dirty() && autosave.checked) { saver.saveSoon(); }
  })().finally(() => {
    ownershipRetry = undefined;
    if (!rereadAfterOwnershipRetry) return;
    rereadAfterOwnershipRetry = false;
    void rereadDisplayed();
  });
}
/** Read-only pane B retries ownership when focused or the tab becomes visible again. */
const saver = createSaver(state, statusLine, {
  viewMode, autosave, draftTitle, workspace, writingPosition,
  snapshot: () => snapshot(),
  currentJournal: () => recovery.currentJournal(),
  suppressEditTracking: () => suppressEditTracking,
  readOnlyNow: () => readOnlyNow(),
  clearPending: saved => { clearPending(saved); },
  clearVersionNotice: () => { clearVersionNotice(); },
  postSignal: (type, documentId, revision) => { postSignal(type, documentId, revision); },
  journalEdit: () => { journalEdit(); },
  rememberActive: () => { rememberActive(); },
  updateSaveIndicator: () => { updateSaveIndicator(); },
  syncTitleTooltip: () => { syncTitleTooltip(); },
  takeOwnership: documentId => takeOwnership(documentId),
  loseOwnership: () => { loseOwnership(); },
  refreshDrafts: () => refreshDrafts(),
  renderDrafts: () => { renderDrafts(); },
});
const { persist, scheduleSave } = saver;
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
autosaveToggle = createAutosaveToggle(state, statusLine, {
  autosave, workspace, viewMode, embedded,
  prefsOrigin: embedded ? `window:${windowId ?? 'main'}` : 'standalone',
  transferFrozen: () => transferFrozen,
  controlBlocked: () => autosaveControlBlocked(),
  preferenceSaved,
  journalEdit: () => { journalEdit(); },
  persist: () => persist(),
  saver,
  postSignal: (type, documentId, revision) => { postSignal(type, documentId, revision); },
  refreshDrafts: () => refreshDrafts(),
  loseOwnership: () => { loseOwnership(); },
});
const applyAutosaveChange = autosaveToggle.apply;
const syncAutosaveCheckboxFromStorage = autosaveToggle.syncFromStorage;
autosave.addEventListener('change', () => {
  void applyAutosaveChange(autosave.checked, {
    promptDeleteSavedCopy: !embedded,
    persistPreference: true,
  });
});
const documents = createDocumentActions(state, statusLine, {
  viewMode, autosave, workspace, writingPosition, saver,
  persist: () => persist(),
  autosaveGate: () => autosaveToggle?.gate(),
  focusHandoff: () => focusHandoff,
  clearHeldEdits: () => { replayButton = undefined; titleBuffer = undefined; },
  readOnlyNow: () => readOnlyNow(),
  freezeEditorsForTransition: () => { freezeEditorsForTransition(); },
  unfreezeEditorsAfterTransition: () => { unfreezeEditorsAfterTransition(); },
  allocateNewDraft: () => allocateNewDraft(),
  acquireFor: documentId => acquireFor(documentId),
  installOwnership: access => { installOwnership(access); },
  loseOwnership: () => { loseOwnership(); },
  rememberActive: () => { rememberActive(); },
  showDraft: () => { showDraft(); },
  renderDrafts: () => { renderDrafts(); },
  refreshDrafts: () => refreshDrafts(),
  openDocumentIdsElsewhere: () => openDocumentIdsElsewhere(),
  postSignal: (type, documentId, revision) => { postSignal(type, documentId, revision); },
});
const switchDraft = documents.switchDraft;
document.querySelector<HTMLButtonElement>('#new-draft')!.addEventListener('click', () => { void switchDraft(); });
for (const picker of documentPickers) {
  picker.addEventListener('change', () => { void (viewMode ? viewer.open(picker.value) : switchDraft(picker.value)); });
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
document.querySelector<HTMLButtonElement>('#delete-draft')!.addEventListener('click', () => { void documents.deleteActive(); });
const recoveryNotice = document.createElement('div');
recoveryNotice.setAttribute('role', 'alert');
recoveryNotice.hidden = true;
status.parentElement?.before(recoveryNotice);
function handleDatabaseUpgrade(): void {
  // Invalidate in-flight acquires, then free any installed Web Lock so an upgraded tab can own.
  storageGeneration++;
  const previous = state.ownership;
  state.ownership = undefined;
  saver.cancel();
  void previous?.release();
  state.db = undefined;
  state.storageProblem = 'Storage was upgraded in another tab. Copy or export unsaved text, then reload.';
  recoveryNotice.hidden = false;
  recoveryNotice.textContent = state.storageProblem;
  // A later upgrade must not erase an earlier conflict-copy notice (#66).
  setRiskStatus('', 'failure');
  applyEditAccess();
  syncMutationControls();
}
async function initializeDrafts(): Promise<void> {
  await ownerReady;
  let bootAccess: EditAccess | undefined;
  try {
    state.db = await openDraftDatabase(handleDatabaseUpgrade);
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
    const pending = readPending();
    const committed = pending && state.drafts.find(d => d.id === pending.id);
    if (pending && committed && sameContent(pending, committed)) clearPending(pending);
    const restorePending = !!pending && (!committed || !sameContent(pending, committed));
    // A new host window must not inherit main's drafts[0] — that steals ownership and
    // makes "Saved" text disappear when the primary window still owns the document.
    // Also: session may already hold a never-saved blank id from rememberActive(); if that
    // id is not in IndexedDB yet, keep a fresh document instead of falling through to drafts[0].
    const listed = selected ? state.drafts.find(d => d.id === selected) : undefined;
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
          : state.drafts[0])
        ?? state.active;
    // A fresh blank document (new host window) is not stored yet; only a stored one can vanish.
    const chosenWasStored = state.drafts.some(draft => draft.id === chosen.id);
    // First acquirer among cooperating windows edits; the others open this document read-only.
    bootAccess = await acquireFor(chosen.id);
    // The list was read before this window owned the document; reread under the fence.
    if (bootAccess.ownership && !restorePending) {
      const fresh = await getStoredDraft(state.db, chosen.id);
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
    state.active = chosen;
    rememberActive();
    showDraft();
    installOwnership(bootAccess);
    bootAccess = undefined;
    if (restorePending) {
      workspace.setDirty(true); workspace.bumpContentRevision();
      applyEditAccess();
      // Another window owns the document: keep the recovered text here (and its reload backup) for copy/export.
      if (state.editBlock) setSaveStatus('Recovered unsaved text, but another window is editing this document, so it was not saved. Copy or export it.', 'failure');
      else if (autosave.checked) { setSaveStatus('Recovered unsaved text; saving…'); await persist(); }
      else setSaveStatus('Recovered unsaved text; autosave is off');
    } else if (state.editBlock) showSaveState();
  } catch (error) {
    void bootAccess?.ownership?.release();
    state.db?.close(); state.db = undefined;
    const pending = readPending();
    if (pending) { state.active = pending; showDraft(); workspace.setDirty(true); workspace.bumpContentRevision(); state.saveFailed = true; }
    state.storageProblem = error instanceof Error && error.message.startsWith('Database upgrade blocked.') ? error.message : STORAGE_UNAVAILABLE;
    setSaveStatus(state.storageProblem, 'failure');
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
  writingPosition.restore(state.active.id);
  void renderRecovery();
  finishInitialization();
}



/** Restore a pane-B reload snapshot after the primary session is live. */

const viewer = createViewerMode(state, {
  field, draftTitle, draftSelect, editor, workspace, saveIndicator, autosave,
  windowId: windowId ?? undefined,
  requestedViewId,
  writingPosition,
  syncTitleTooltip: () => { syncTitleTooltip(); },
  showDraft: () => { showDraft(); },
  renderDrafts: () => { renderDrafts(); },
  refreshDrafts: () => refreshDrafts(),
  updateStats: () => { updateStats(); },
  setSaveStatus: (text, kind) => { setSaveStatus(text, kind); },
  restoreFocusMode: () => { restoreFocusMode(); },
  finishInitialization: () => { finishInitialization(); },
  onDatabaseUpgrade: () => { handleDatabaseUpgrade(); },
});
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
    if (!deletedElsewhere || viewMode || state.transitioning) return false;
    // Reserve the transition so Close / New / the picker cannot switch documents while the
    // copy takes ownership (they no-op while transitioning).
    const originalId = state.active.id;
    state.transitioning = true;
    const copy = allocateNewDraft(field.value);
    const title = draftTitle.value.trim();
    if (title) copy.title = title;
    copy.history = editor.exportHistory();
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const access = await acquireFor(copy.id);
    if (!access.ownership) {
      state.transitioning = false;
      announceAction('Could not keep this document here — your text is still shown; copy or export it.', { kind: 'failure' });
      return false;
    }
    if (state.active.id !== originalId || !deletedElsewhere) {
      void access.ownership.release();
      state.transitioning = false;
      return false;
    }
    writingPosition.save();
    state.active = copy;
    clearDeletedElsewhere();
    showDraft();
    installOwnership(access);
    try { field.setSelectionRange(start, end); } catch { /* Field not focusable. */ }
    workspace.setDirty(true);
    workspace.bumpContentRevision();
    rememberActive();
    state.transitioning = false;
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
    if (state.transitioning && deletedElsewhere) state.transitioning = false;
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
  if (!state.db || state.loadingDraft || (viewMode && state.viewMissing)) return;
  // A local commit may be mid-flight; wait so the displayed revision is current.
  while (!viewMode && saver.inFlight()) await saver.inFlight()!.catch(() => undefined);
  const id = state.active.id;
  const generationAtStart = workspace.sessionGeneration();
  const seq = ++rereadSeq;
  let stored: StoredDraft | undefined;
  try { stored = await getStoredDraft(state.db, id); } catch { return; }
  if (seq !== rereadSeq || generationAtStart !== workspace.sessionGeneration() || state.active.id !== id) return;
  if (!viewMode && saver.inFlight()) { void rereadDisplayed(); return; }
  // A clean read-only ordinary window follows the saved version like a viewer; unsaved text is never replaced.
  const reader = !viewMode && state.editBlock !== '' && !workspace.dirty();
  const action = decideReread({
    role: viewMode || reader ? 'viewer' : 'editor',
    displayedRevision: state.active.revision,
    displayedUpdatedAt: state.active.updatedAt,
    stored,
  });
  if (action === 'refresh' && stored) {
    writingPosition.save();
    if (viewMode) {
      viewer.showDocument(stored);
      setSaveStatus('Updated to the latest saved version. Nothing is saved from this window.');
    } else {
      state.active = stored;
      showDraft();
      applyEditAccess();
      if (quietReader()) showSaveState();
      else setSaveStatus('Updated to the latest saved version. ' + readOnlyStatus());
    }
    scheduleListRefresh();
  } else if (action === 'missing') {
    if (viewMode) viewer.showMissing(viewer.MISSING);
    else if (state.active.revision >= 1) markDeletedElsewhere();
    scheduleListRefresh();
  } else if (action === 'notice-newer') showVersionNotice(NEWER_VERSION_NOTICE);
  else if (action === 'notice-deleted') markDeletedElsewhere();
}
let listRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleListRefresh(): void {
  if (!viewMode || !state.db) return;
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(() => { void refreshDrafts().catch(() => { /* The list is advisory in a read-only view. */ }); }, 250);
}
signalChannel?.addEventListener('message', event => {
  const signal = parseDocumentSignal(event.data);
  if (!signal) return;
  // While loading, `active` is not the represented document yet; reread once it is.
  if (field.disabled) { rereadAfterInit = true; return; }
  scheduleListRefresh();
  if (shouldApplyDocumentSignal(signal, state.active.id, state.active.revision)) {
    // Do not bump sessionGeneration under an in-flight ownership acquire (stillHere would release).
    if (ownershipRetry) rereadAfterOwnershipRetry = true;
    else void rereadDisplayed();
  }
});
function reconcileSignals(): void {
  if (document.visibilityState !== 'visible') return;
  scheduleListRefresh();
  // Readers: single-flight reread+acquire. Owners/viewers: still reread so missed signals surface.
  if (mayRetryEditOwnership(state.editBlock)) retryOwnership();
  else void rereadDisplayed();
}
// #175 step 4: pointer on a read-only field runs cooperative handoff (steal only via Edit here).
// Plain retry still runs for visibility/window focus when the lock was freed without a handoff.
field.addEventListener('focus', () => {
  if (focusHandoff?.pending()) return;
  if (state.editBlock === 'busy' || state.editBlock === 'lost' || state.editBlock === 'error') return;
  retryOwnership();
});
window.addEventListener('focus', reconcileSignals);
document.addEventListener('visibilitychange', reconcileSignals);

if (!viewMode) {
  focusHandoff = installFocusHandoff({
    field,
    windowId,
    instanceId,
    getDocumentId: () => state.active.id,
    isViewMode: () => viewMode,
    isOwner: () => !!state.ownership && state.editBlock === '',
    editBlock: () => state.editBlock,
    isComposing: () => editor.composing,
    isTransitioning: () => state.transitioning || state.deleting || transferFrozen || !!ownershipRetry,
    isSaving: () => !!saver.inFlight(),
    saveFailed: () => state.saveFailed,
    isDirty: () => workspace.dirty(),
    autosaveOn: () => autosave.checked,
    confirmDiscardDirtyForHandoff: async () => {
      const discard = await askConfirmChoice({
        title: 'Discard unsaved changes?',
        message: state.editBlock
          ? 'Another window is editing this document, so this window cannot save these changes. Copy or export them first to keep them. Taking over editing replaces them with the other window’s text (or the last saved copy).'
          : 'Copy or export unsaved changes first to keep them. Taking over editing replaces them with the other window’s text (or the last saved copy).',
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        returnFocus: field,
      });
      if (!discard) return false;
      // Apply the discard immediately (same as the switch path) so a failed takeover
      // cannot resurrect the private text the user already agreed to drop.
      if (state.db) {
        try {
          const fresh = await getStoredDraft(state.db, state.active.id);
          if (fresh) {
            writingPosition.save();
            state.active = fresh;
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
    if (!quietReader() || state.transitioning || state.deleting || transferFrozen) return;
    if (focusHandoff?.pending()) return;
    focusHandoff?.requestHandoff();
  };
  /**
   * Hold a title edit made while this window cannot edit yet, and start the takeover.
   * Returns false when the title is editable (the edit should run normally).
   */
  const bufferTitleEdit = (op: TitleOp, start: number, end: number, fromHost: boolean): boolean => {
    if (!draftTitle.readOnly || !quietReader()) return false;
    if (!titleBuffer || titleBuffer.documentId !== state.active.id) {
      titleBuffer = { documentId: state.active.id, baseValue: draftTitle.value, ops: [], fromHost };
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
    const other = state.drafts.find(draft => draft.id !== state.active.id);
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
    replayButton = { button, documentId: state.active.id };
    requestEditHere();
  }, true);
  editHereButton.addEventListener('click', () => {
    if (editHereDocumentId && state.active.id !== editHereDocumentId) {
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
void (viewMode ? viewer.initialize() : initializeDrafts());

setupComparisonOpen({
  embedded,
  isBusy: () => viewMode || field.disabled || state.transitioning || state.deleting,
  hasStorage: () => !!state.db,
  activeDocument: () => ({ id: state.active.id, revision: state.active.revision }),
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
    if (!state.db) throw new Error('browser storage cannot be used');
    const result = await commitOrCreateConflictCopy(state.db, imported, 0, crypto.randomUUID());
    postSignal('saved', result.draft.id, result.draft.revision);
    return switchDraft(result.draft.id);
  },
});
if (!viewMode) window.addEventListener('pagehide', () => {
  if (reloadBackup.suppressed()) return;
  savePending();
  saver.cancel();
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
  const discardedJournal = recovery.takeCurrentJournal();
  if (discardedJournal) {
    try { clearRecovery(localStorage, discardedJournal); } catch { /* Optional backup. */ }
  }
}

async function prepareLeaveWithUnsaved(kind: 'reload' | 'close'): Promise<boolean> {
  if (state.transitioning || state.deleting || field.disabled) return false;
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
      privateReloadChoice = { id: state.active.id, generation: workspace.contentRevision() };
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
  if (state.transitioning || state.deleting || field.disabled || document.querySelector('.confirm-backdrop')) throw new Error('Finish the current action first');
  if (workspace.dirty()) {
    if (!autosave.checked) {
      if (privateReloadChoice?.id !== state.active.id || privateReloadChoice.generation !== workspace.contentRevision()) {
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
    saver.cancel();
    void persist();
    if (!allowUpdateReload) { event.preventDefault(); event.returnValue = ''; }
  }
});
if (!viewMode) document.addEventListener('visibilitychange', () => {
  if (reloadBackup.suppressed()) return;
  if (document.visibilityState === 'hidden') {
    saver.cancel();
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
