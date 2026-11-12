import { setupAppearance } from './ui/appearance';
import { setupWindowLayoutSetting } from './ui/window-layout-setting';
import { setupResetSettings } from './ui/reset-settings';
import { createPreferenceWarning } from './ui/preference-warning';
import { setupTabIndent } from './ui/tab-indent';
import { applyPrefs } from './view/prefs-apply';
import { watchForUpdates } from './ui/update-notice';
import { SHORTCUTS } from './editor/keyboard-shortcuts';
import { setupKeyboardShortcuts } from './ui/keyboard-shortcuts';
import './style.css';
import { Editor } from './editor/editor';
import { createStatusLine } from './ui/status-line';
import { createReloadBackup } from './view/reload-backup';
import { createEditorState } from './view/editor-state';
import { createViewerMode } from './view/viewer-mode';
import { createSaver } from './view/saver';
import { createChangeWriter } from './view/change-writer';
import { createAutosaveToggle, type AutosaveToggle } from './view/autosave-toggle';
import { createDocumentActions } from './view/documents';
import { createRecovery } from './view/recovery';
import { initializeDrafts } from './view/boot';
import { createDocumentSync } from './view/document-sync';
import { createLeaveGuards } from './view/leave-guards';
import { createEditAccess } from './view/edit-access';
import { createTakeover } from './view/takeover';
import { createTitleEditing } from './ui/title-edits';
import { setupDeletedInput } from './view/deleted-input';
import { createHeldEdits } from './view/held-edits';
import { installEmbedHooks } from './view/embed-hooks';
import { draftMatchesQuery, draftPickerLabel } from './editor/draft-list';
import {
  ACTIVE_DRAFT_KEY_BASE,
  UNTITLED_TITLE,
  autosaveEnabled,
  configureActiveDraftKey,
  newDraft,
  setActiveDraftId,
} from './editor/drafts';
import { nextUntitledTitle } from './editor/untitled-title';
import { FIND_KEY, REPLACE_KEY } from './editor/search-settings';
import { askConfirmChoice } from './ui/confirm-dialog';
import { listStoredDrafts, getStoredDraft, commitOrCreateConflictCopy, appendChange, type StoredDraft } from './editor/indexeddb';
import { installFocusHandoff, type FocusHandoffController } from './view/focus-handoff';
import { createSinglePaneWorkspace, PRIMARY_PANE_ID } from './view/workspace';
import {
  commandAllowedOnPane,
  contentCommandStillCurrent,
  type CommandGeneration,
} from './view/session';
import { writeRecovery } from './editor/recovery';
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
import { parseComparisonRoute } from './view/route';
import { parseWindowId, scopeSessionKey, writingPositionNamespace } from './view/window-id';
import { editorWindowApi, exposeEditorWindowApi, hostPageApi, testKnob } from './view/embed-api';
import { setupExportImport } from './ui/export-import';
import { openShareDialog } from './ui/share-dialog';
import { setupComparisonOpen } from './ui/comparison-open';
import { setupFindGotoBars } from './ui/find-goto-bars';
import { parseEmbedMode } from './view/embed';
import { onPrefsChanged } from './view/prefs-sync';
import { SIGNAL_POLL_INTERVAL_MS } from './view/signals';
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
/** This window's origin on shared preference broadcasts, so it ignores its own echo. */
const prefsOrigin = embedded ? `window:${windowId ?? 'main'}` : 'standalone';
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
/**
 * The Autosave change handler (view/autosave-toggle.ts), created once its dependencies exist.
 * Declared here because syncAutosaveControl runs during module init, before that point.
 */
// eslint-disable-next-line prefer-const -- assigned once later; a const here would be read before it is set.
let autosaveToggle: AutosaveToggle | undefined;
const webLocks: LockManager | undefined = typeof navigator.locks?.request === 'function' ? navigator.locks : undefined;
/** True while this window must not change the displayed document. */
/** True when the UI must refuse mutations (viewer, non-owner, or frozen for ownership transfer). */
const readOnlyNow = (): boolean => viewMode || state.editBlock !== '' || state.transferFrozen;
/** Replays keys held while a deleted document is kept as a new one (set up with the input handlers). */
let drainDeletedInput: (() => void) | undefined;
const deletedBarElement = (): HTMLElement => document.querySelector<HTMLElement>('#deleted-bar')!;
/**
 * A clean window whose document another window or tab is editing. It looks like a normal
 * editor: no Read-only badge or notice; clicking, typing or using a control takes over
 * editing (focus handoff). Unsaved text here, Edit here warnings and real errors still show.
 */
const quietReader = (): boolean => !viewMode && state.editBlock === 'busy' && !workspace.dirty() && !state.deletedElsewhere;
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
/** Shown until each preference that failed to save is saved (ui/preference-warning.ts, #57). */
const preferenceSaved = createPreferenceWarning(document.querySelector<HTMLElement>('#preference-warning')!);
const appearanceSettings = setupAppearance(preferenceSaved, { prefsOrigin });
const windowLayoutSettings = setupWindowLayoutSetting(preferenceSaved, { prefsOrigin });

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
  announceAction, showSaveState,
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
  if (viewMode || state.transferFrozen) return true;
  return state.editBlock !== '';
}
function syncAutosaveControl(): void {
  if (viewMode || autosaveToggle?.isActive()) return;
  // Also disabled for a whole document switch, flush included (#97).
  autosave.disabled = autosaveControlBlocked() || state.transitioning;
}
function syncMutationControls(): void {
  // Comparison viewers own these attributes via applyViewerChrome; do not fight tests that
  // temporarily re-enable controls to prove handlers still refuse mutations.
  if (viewMode) return;
  const blocked = !canMutatePrimary();
  const target = activeEditableSession();
  // A quiet reader keeps these enabled; the click takes over editing, then runs.
  const controlsBlocked = blocked && !(quietReader() && !state.transferFrozen);
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
    sync.syncVersionNoticeDisplay();
  }
}
field.addEventListener('focus', () => { activatePane(PRIMARY_PANE_ID); });
// Tab and Shift+Tab indent lines (ui/tab-indent.ts, #56).
const tabIndent = setupTabIndent({
  checkbox: document.querySelector<HTMLInputElement>('#tab-indent')!,
  prefsOrigin,
  canIndent: () => canMutatePrimary(),
});
const applyTabIndentFromStorage = tabIndent.applyFromStorage;
field.addEventListener('keydown', event => { tabIndent.handleKeydown(event, field, editor); });
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
  prefsOrigin,
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
  { prefsOrigin },
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
    : state.deletedElsewhere ? 'unsaved'
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
  if (state.db) {
    state.drafts = await listStoredDrafts(state.db);
    writingPosition.prune(state.drafts.map(draft => draft.id));
  }
  renderDrafts();
  if (statusLine.message().draftListRefreshFailed) updateStatus({ draftListRefreshFailed: false });
}
function showDraft(options?: { restorePosition?: boolean }): void {
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
  if (options?.restorePosition !== false) writingPosition.restore(state.active.id);
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
const { applyTitleEdit, applyHeldTitleOps, setTitle, commitTitle } = createTitleEditing({
  viewMode, draftTitle, titleEditor,
  syncTitleTooltip: () => { syncTitleTooltip(); },
  rememberActive: () => { rememberActive(); },
  scheduleTitleSave: () => { scheduleSave(true); },
});
const heldEdits = createHeldEdits(state, statusLine, {
  draftTitle, applyHeldTitleOps,
  quietReader: () => quietReader(),
  readOnlyNow: () => readOnlyNow(),
  focusHandoff: () => focusHandoff,
});
const { onEditableHere } = heldEdits;
const editAccess = createEditAccess(state, statusLine, {
  viewMode, instanceId, webLocks, workspace, editor, titleEditor, ownershipNotice, undo, redo, autosave,
  writingPosition, quietReader,
  syncHistory: () => { syncHistory(); },
  syncMutationControls: () => { syncMutationControls(); },
  updateSaveIndicator: () => { updateSaveIndicator(); },
  syncAutosaveCheckboxFromStorage: () => { syncAutosaveCheckboxFromStorage(); },
  showDraft: () => { showDraft(); },
  cancelSave: () => { saver.cancel(); },
  saveSoon: () => { saver.saveSoon(); },
});
const {
  applyEditAccess, acquireFor, freezeEditorsForTransition, unfreezeEditorsAfterTransition, installOwnership,
  takeOwnership, loseOwnership, beginParkFreeze, finishParkRelease, discardParkedHandoffText,
  recoverParkedHandoffOwnership,
} = editAccess;
const takeover = createTakeover(state, {
  viewMode, field, draftTitle, editor, workspace, autosave, writingPosition, editHereBar, editHereWarning, editAccess,
  focusHandoff: () => focusHandoff,
  showDraft: () => { showDraft(); },
  syncTitleTooltip: () => { syncTitleTooltip(); },
  updateSaveIndicator: () => { updateSaveIndicator(); },
  saveSoon: () => { saver.saveSoon(); },
  onEditableHere: () => { onEditableHere(); },
  rereadDisplayed: () => rereadDisplayed(),
  markDeletedElsewhere: () => { markDeletedElsewhere(); },
});
const { captureHandoffSnapshot, hideEditHereBar, showEditHereBar, takeOverFromHandoff, retryOwnership } = takeover;
/** Read-only pane B retries ownership when focused or the tab becomes visible again. */
// Change log for crash recovery (#37 R2c): one small record per edit while Autosave is on.
const changeWriter = createChangeWriter({
  mayRecord: () => !viewMode && autosave.checked && !state.suppressEditTracking && !state.loadingDraft,
  shown: () => ({ id: state.active.id, generation: workspace.sessionGeneration() }),
  text: () => field.value,
  append: async record => {
    if (!state.db || state.ownership?.documentId !== record.documentId) throw new Error('Not editing this document');
    const delayMs = testKnob('__typebridgeDelayChangeAppendMs');
    if (typeof delayMs === 'number' && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    await appendChange(state.db, record, await state.ownership.writeFence());
  },
  newRunId: () => crypto.randomUUID(),
});
const saver = createSaver(state, statusLine, {
  viewMode, autosave, draftTitle, workspace, writingPosition,
  snapshot: () => snapshot(),
  currentJournal: () => recovery.currentJournal(),
  suppressEditTracking: () => state.suppressEditTracking,
  readOnlyNow: () => readOnlyNow(),
  preparePendingClear: saved => reloadBackup.prepareClear(saved),
  clearVersionNotice: () => { clearVersionNotice(); },
  postSignal: (type, documentId, revision) => { postSignal(type, documentId, revision); },
  journalEdit: () => { journalEdit(); },
  changes: changeWriter,
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
  prefsOrigin,
  transferFrozen: () => state.transferFrozen,
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
  clearHeldEdits: () => { heldEdits.clear(); },
  readOnlyNow: () => readOnlyNow(),
  freezeEditorsForTransition: () => { freezeEditorsForTransition(); },
  unfreezeEditorsAfterTransition: () => { unfreezeEditorsAfterTransition(); },
  syncAutosaveControl: () => { syncAutosaveControl(); },
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
draftTitle.addEventListener('blur', () => { heldEdits.selectTitleWhenEditable(false); });
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
  heldEdits.selectTitleWhenEditable(draftTitle.readOnly);
  editorWindowApi(window)?.__typebridgeRequestEdit?.();
});
document.querySelector<HTMLButtonElement>('#delete-draft')!.addEventListener('click', () => { void documents.deleteActive(); });
const recoveryNotice = document.createElement('div');
recoveryNotice.setAttribute('role', 'alert');
recoveryNotice.hidden = true;
status.parentElement?.before(recoveryNotice);
function handleDatabaseUpgrade(): void {
  // Invalidate in-flight acquires, then free any installed Web Lock so an upgraded tab can own.
  state.storageGeneration++;
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



/** Restore a pane-B reload snapshot after the primary session is live. */

const viewer = createViewerMode(state, {
  field, draftTitle, draftSelect, editor, workspace, saveIndicator, autosave,
  windowId: windowId ?? undefined,
  requestedViewId,
  writingPosition,
  syncTitleTooltip: () => { syncTitleTooltip(); },
  showDraft: options => { showDraft(options); },
  renderDrafts: () => { renderDrafts(); },
  refreshDrafts: () => refreshDrafts(),
  updateStats: () => { updateStats(); },
  setSaveStatus: (text, kind) => { setSaveStatus(text, kind); },
  restoreFocusMode: () => { restoreFocusMode(); },
  finishInitialization: () => { finishInitialization(); },
  onDatabaseUpgrade: () => { handleDatabaseUpgrade(); },
});
const sync = createDocumentSync(state, statusLine, {
  viewMode, field, draftTitle, editor, workspace, autosave, writingPosition, saver, viewer,
  focusHandoff: () => focusHandoff,
  hideEditHereBar: () => { hideEditHereBar(); },
  applyEditAccess: () => { applyEditAccess(); },
  deletedBar: () => deletedBarElement(),
  allocateNewDraft: text => allocateNewDraft(text),
  acquireFor: documentId => acquireFor(documentId),
  showDraft: () => { showDraft(); },
  installOwnership: access => { installOwnership(access); },
  rememberActive: () => { rememberActive(); },
  drainDeletedInput: () => { drainDeletedInput?.(); },
  refreshDrafts: () => refreshDrafts(),
  persist: () => persist(),
  quietReader: () => quietReader(),
  retryOwnership: () => { retryOwnership(); },
  ownershipRetryPending: () => takeover.ownershipRetryPending(),
  rereadAfterOwnershipRetry: () => { takeover.rereadAfterOwnershipRetry(); },
});
const {
  postSignal, markDeletedElsewhere, clearDeletedElsewhere, keepDeletedAsNew, clearVersionNotice,
  finishInitialization, rereadDisplayed, reconcileSignals,
} = sync;

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
    isTransitioning: () => state.transitioning || state.deleting || state.transferFrozen || takeover.ownershipRetryPending(),
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
    announce: text => { heldEdits.onHandoffAnnouncement(text); },
    showEditHere: showEditHereBar,
    hideEditHere: hideEditHereBar,
  });
  const { requestEditHere, bufferTitleEdit } = heldEdits;
  heldEdits.installTitleListeners();
  // Host title bar (#175 step 8) edits this window's title: let it start a takeover too,
  // and hold what was typed there the same way.
  exposeEditorWindowApi({
    __typebridgeRequestEdit: requestEditHere,
    __typebridgeBufferTitleEdit: (op, start, end) => {
      // Deleted elsewhere: typing in the title keeps the text as a new document, then applies.
      if (state.deletedElsewhere) {
        deletedInput.holdTitleOp(op, start, end, true);
        deletedInput.keepThenApply();
        return true;
      }
      return bufferTitleEdit(op, start, end, true);
    },
  });

  // Deleted elsewhere (#175 follow-up): Keep as new document or Close (view/deleted-input.ts).
  const deletedInput = setupDeletedInput(state, {
    field, draftTitle, applyHeldTitleOps,
    isKeepingDeleted: () => sync.isKeepingDeleted(),
    keepDeletedAsNew: () => keepDeletedAsNew(),
    switchDraft: id => switchDraft(id),
  });
  drainDeletedInput = deletedInput.drain;
  heldEdits.installControlReplay();
  editHereButton.addEventListener('click', () => { takeover.editHere(); });
}
// Without BroadcastChannel, focus/visibility reread is the baseline; a slow poll only runs for a visible viewer.
if (viewMode && !sync.hasChannel) setInterval(reconcileSignals, SIGNAL_POLL_INTERVAL_MS);
void (viewMode ? viewer.initialize() : initializeDrafts(state, statusLine, {
  embedded,
  windowId: windowId ?? undefined,
  autosave, field, draftSelect, draftTitle, workspace, writingPosition, ownerReady,
  onDatabaseUpgrade: () => { handleDatabaseUpgrade(); },
  readPending: () => readPending(),
  clearPending: saved => { clearPending(saved); },
  allocateNewDraft: () => allocateNewDraft(),
  acquireFor: documentId => acquireFor(documentId),
  installOwnership: access => { installOwnership(access); },
  applyEditAccess: () => { applyEditAccess(); },
  rememberActive: () => { rememberActive(); },
  showDraft: options => { showDraft(options); },
  renderDrafts: () => { renderDrafts(); },
  updateStats: () => { updateStats(); },
  persist: () => persist(),
  restoreFocusMode: () => { restoreFocusMode(); },
  renderRecovery: () => renderRecovery(),
  finishInitialization: () => { finishInitialization(); },
}));

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
// Documents → Share link… (#39): the shown title and text, like Export.
document.querySelector<HTMLButtonElement>('#share-link')!.addEventListener('click', () => {
  void openShareDialog({
    surface: () => ({
    title: draftTitle.value.trim() || UNTITLED_TITLE,
    text: field.value,
  }),
    base: () => new URL('/', location.href).toString(),
    returnFocus: () => document.querySelector<HTMLButtonElement>('#doc-menu-open')!,
  });
});
const leaveGuards = createLeaveGuards(state, {
  viewMode, field, autosave, workspace, saver, reloadBackup, recovery,
  persist: () => persist(),
  snapshot: () => snapshot(),
});
const { prepareUpdateReload, reloadAfterUpdate } = leaveGuards;
updateStats();

if (!embedded) {
  setupResetSettings({ actions: [
    ['appearance', appearanceSettings.reset], ['window layout', windowLayoutSettings.reset],
    ['typing mode/shortcut', typingSettings.reset], ['custom rules', resetRules], ['Find options', resetOptions],
    ['Tab indents', tabIndent.reset], ['editor layout', resetLayout],
  ], announce: announceAction });
}

function applyAutosaveFromStorage(): void {
  let next: boolean;
  try { next = autosaveEnabled(); }
  catch { return; }
  void applyAutosaveChange(next, { promptDeleteSavedCopy: false, persistPreference: false });
}

// A shared preference changed in another window: re-read it here (view/prefs-apply.ts).
onPrefsChanged(detail => {
  applyPrefs(detail.name, {
    appearance: () => { appearanceSettings.applyFromStorage(); },
    typing: () => { typingSettings.applyFromStorage(); },
    tabIndent: () => { applyTabIndentFromStorage(); },
    autosave: () => { applyAutosaveFromStorage(); },
    findOptions: () => { resetOptions(); },
    layout: () => { resetLayout(); },
  });
}, { skipOrigin: prefsOrigin });

// Host page registers the service worker and shows the update notice once (#175 step 3).
if (!embedded && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(registration => watchForUpdates(registration, {
        prepareReload: prepareUpdateReload,
        reload: reloadAfterUpdate,
        cancelReload: () => { leaveGuards.cancelUpdateReload(); },
        dismissedKey: updateDismissKey,
      }))
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
if (embedded) {
  // This window's side of the host↔window contract (view/embed-hooks.ts, view/embed-api.ts).
  installEmbedHooks({
    prefsOrigin,
    leaveGuards,
    setFocusMode: applyFocusModeOnly,
    getTitle: () => draftTitle.value.trim() || UNTITLED_TITLE,
    setTitle, commitTitle, applyTitleEdit, openFind,
    toggleTransliteration: () => {
      enabled.checked = !enabled.checked;
      enabled.dispatchEvent(new Event('change', { bubbles: true }));
    },
  });
  // Catch prefs the host broadcast before this iframe finished booting.
  syncAutosaveCheckboxFromStorage();
  try { applyTabIndentFromStorage(); } catch { /* optional */ }
  try { appearanceSettings.applyFromStorage(); } catch { /* optional */ }
  try { typingSettings.applyFromStorage(); } catch { /* optional */ }
  // Do not rememberActive() here: initializeDrafts() still needs the prior
  // session/?doc= selection. Publishing the temporary blank id early would
  // overwrite it and leave secondary host windows blank after reload (#175 s8).
}
