import { setupAppearance } from './ui/appearance';
import { setupWindowLayoutSetting } from './ui/window-layout-setting';
import { setupResetSettings } from './ui/reset-settings';
import { watchForUpdates } from './ui/update-notice';
import { SHORTCUTS } from './editor/keyboard-shortcuts';
import { setupKeyboardShortcuts } from './ui/keyboard-shortcuts';
import './style.css';
import { Editor } from './editor/editor';
import { indentEdit } from './editor/indent';
import { AUTOSAVE_OFF, CONFLICT_COPY, CONFLICT_COPY_LEFT, statusLineParts, withDraftListRefreshFailure, type StatusMessage } from './editor/status';
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
import { FIND_KEY, REPLACE_KEY } from './editor/search-settings';
import { askConfirmChoice } from './ui/confirm-dialog';
import { openDraftDatabase, listStoredDrafts, getStoredDraft, commitDraft, commitOrCreateConflictCopy, deleteStoredDraft, EditOwnershipLostError, type StoredDraft } from './editor/indexeddb';
import { acquireEditOwnership, type EditOwnership } from './editor/edit-ownership';
import { editBlockGuidance, mayRetryEditOwnership, type EditBlock } from './view/ownership';
import { handoffRefuseGuidance, mapSelectionAcrossTextChange, type HandoffRefuseReason, type HandoffSnapshot } from './view/handoff';
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
import { lineColumnAtOffset, offsetForLineColumn, parseGotoInput } from './editor/goto-line';
import { setupLayout } from './ui/layout';
import { setupSearch } from './ui/search';
import { setupRules } from './ui/rules';
import { setupTransliteration } from './ui/transliteration';
import { setupSettings } from './ui/settings';
import { setupDocumentMenu } from './ui/document-menu';
import { setupMoreMenu } from './ui/more-menu';
import { installEscapeLayers, registerEscapeLayer } from './ui/escape-layers';
import { setupWritingPosition } from './editor/writing-position';
import { comparisonViewerHref, isDocumentId, parseComparisonRoute } from './view/route';
import { parseWindowId, scopeSessionKey, writingPositionNamespace } from './view/window-id';
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
      const host = window.parent as Window & {
        __typebridgeHostFocusMode?: (on: boolean, sourceWindowId?: string) => void;
      };
      host.__typebridgeHostFocusMode?.(enabled, windowId ?? undefined);
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
  if (storageProblem) {
    if (!workspace.dirty()) return storageProblem;
    return storageProblem === STORAGE_UNAVAILABLE ? SAVE_FAILED_NO_STORAGE : 'Changes are unsaved. ' + storageProblem;
  }
  if (editBlock && workspace.dirty()) return NOT_OWNER_UNSAVED;
  if (saveFailed && autosave.checked) return SAVE_FAILED;
  if (workspace.dirty() && !autosave.checked) return AUTOSAVE_OFF;
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
  undo.disabled = blocked || !target.canUndo;
  redo.disabled = blocked || !target.canRedo;
  for (const id of ['convert-cyrillic', 'convert-latin', 'clear', 'replace-one', 'replace-all'] as const) {
    document.querySelector<HTMLButtonElement>('#' + id)!.disabled = blocked;
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
  setFocusMode(false);
  syncMutationControls();
}
function openFind(): void {
  leaveFocusPreservingActivePane();
  setBar(gotoBar, gotoOpen, false);
  setBar(findBar, findOpen, true);
  // Re-read the shared last search so another window's query is visible immediately.
  try {
    const shared = sessionStorage.getItem(FIND_KEY);
    if (shared !== null && findInput.value !== shared) {
      findInput.value = shared;
      findEditor.syncFromField();
    }
  } catch { /* Optional restore. */ }
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
  return field;
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
  const surfaceEditor = editor;
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
function snapshot(): StoredDraft {
  return { ...active, text: field.value, title: draftTitle.value.trim() || UNTITLED_TITLE, history: editor.exportHistory(), updatedAt: Date.now() };
}
function journalEdit(): void {
  if (viewMode || !autosave.checked) return;
  const entry: RecoverySnapshot = { token: crypto.randomUUID(), tab: journalTab, documentId: active.id, revision: active.revision, timestamp: Date.now(), title: draftTitle.value.trim() || UNTITLED_TITLE, text: field.value };
  try { writeRecovery(localStorage, entry); currentJournal = entry; journalWarning.hidden = true; }
  catch { journalWarning.textContent = 'Emergency backup unavailable. Keep this tab open until saved, or copy or export your text.'; journalWarning.hidden = false; }
}
function sameContent(a: StoredDraft, b: StoredDraft): boolean {
  return a.id === b.id && a.title === b.title && a.text === b.text && JSON.stringify(a.history) === JSON.stringify(b.history);
}
/** Set when the user confirms discarding this window so unload must not recreate backups. */
let suppressPendingBackup = false;
function savePending(): void {
  if (suppressPendingBackup || viewMode || !workspace.dirty() || !autosave.checked || deleting) return;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(snapshot())); }
  catch {
    // Keep any conflict notice and the current risk; only replace the primary.
    // Trailing period stays; renderStatusBody joins risk with a space after it.
    setRiskStatus('Unsaved text could not be backed up for reload. Copy or export it.', 'failure');
  }
}
function clearPending(saved: StoredDraft): void {
  try { const pending = readPending(); if (pending && pending.id === saved.id && (sameContent(pending, saved) || saved.updatedAt >= pending.updatedAt)) sessionStorage.removeItem(PENDING_KEY); }
  catch { /* A stale backup is safer than removing one we cannot verify. */ }
}
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
      const host = window.parent as Window & { __typebridgeOpenTitles?: (exceptWindowId?: string) => string[] };
      titles.push(...(host.__typebridgeOpenTitles?.(windowId ?? undefined) ?? []));
    } catch { /* Parent unavailable. */ }
  }
  return { ...newDraft(text, nextUntitledTitle(titles)), revision: 0 };
}

function openDocumentIdsElsewhere(): Set<string> {
  if (!embedded || window.parent === window) return new Set();
  try {
    const host = window.parent as Window & { __typebridgeOpenDocumentIds?: (exceptWindowId?: string) => string[] };
    // exceptWindowId already omits this window; keep ids open in *other* windows,
    // including the active document when it is duplicated (#175 step 8).
    const ids = host.__typebridgeOpenDocumentIds?.(windowId ?? undefined) ?? [];
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
/** Reflect ownership + transfer freeze in the editors, controls and guidance (ordinary windows only). */
function applyEditAccess(): void {
  if (viewMode) return;
  // Must match readOnlyNow: stay frozen for the whole switch/delete interval even if
  // installOwnership runs before the handler finishes (e.g. refreshDrafts after delete).
  const blocked = editBlock !== '' || transferFrozen;
  workspace.setPaneRole(blocked ? 'readonly' : 'editable');
  if (editor.readOnly !== blocked) editor.setReadOnly(blocked);
  if (titleEditor.readOnly !== blocked) titleEditor.setReadOnly(blocked);
  for (const id of OWNER_ONLY_CONTROLS) document.querySelector<HTMLButtonElement>('#' + id)!.disabled = blocked;
  document.documentElement.dataset.role = editBlock !== '' ? 'reader' : 'editor';
  // Temporary transfer freeze must not announce "another window is editing".
  const guidance = transferFrozen ? '' : editBlockGuidance(editBlock, workspace.dirty());
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
  const delayMs = (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs;
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
document.querySelector<HTMLButtonElement>('#delete-draft')!.addEventListener('click', async () => {
  if (readOnlyNow() || transitioning) return;
  focusHandoff?.cancel();
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
const VIEWER_DISABLED_CONTROLS = ['new-draft', 'import-draft', 'delete-draft', 'open-comparison', 'undo', 'redo',
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
const DELETED_NOTICE = 'This saved document was deleted in another window. Your text here has not been changed.';
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
    announce: text => announceAction(text, { keepConflict: true }),
    showEditHere: showEditHereBar,
    hideEditHere: hideEditHereBar,
  });
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
if (embedded) {
  openComparison.hidden = true;
  openComparison.disabled = true;
}
openComparison.addEventListener('click', () => {
  if (viewMode || embedded || field.disabled || transitioning || deleting) return;
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
    ? 'Opened the last saved version in another window. Unsaved typing was not sent.'
    : 'Opened the last saved version in another window.');
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
  if (suppressPendingBackup) return;
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
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* Optional backup. */ }
}

/**
 * Host calls this immediately before removing the iframe. Arming suppress here — not during
 * prepare — keeps reload/close consent cancellable without disabling backups for the session.
 */
function commitWindowClose(): void {
  suppressPendingBackup = true;
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
  if (suppressPendingBackup) return;
  if (workspace.dirty()) {
    savePending();
    clearTimeout(saveTimer);
    void persist();
    if (!allowUpdateReload) { event.preventDefault(); event.returnValue = ''; }
  }
});
if (!viewMode) document.addEventListener('visibilitychange', () => {
  if (suppressPendingBackup) return;
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
        cancelReload: () => { allowUpdateReload = false; suppressPendingBackup = false; },
        dismissedKey: updateDismissKey,
      }))
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
if (embedded) {
  const hooks = window as Window & {
    __typebridgePrepareUpdateReload?: () => Promise<boolean>;
    __typebridgeAssertSafeUpdateReload?: () => void;
    __typebridgeCancelUpdateReload?: () => void;
    /** Host window manager asks before removing this iframe (#175 step 5). */
    __typebridgePrepareWindowClose?: () => Promise<boolean>;
    /** Host calls immediately before removing the iframe after prepareClose succeeds. */
    __typebridgeCommitWindowClose?: () => void;
    __typebridgeSetFocusMode?: (enabled: boolean) => void;
    /** #175 step 7: host Settings asks every window to apply a shared preference. */
    __typebridgeApplyPrefs?: (name: PrefName, origin?: string) => void;
    /** #175 step 8: host title bar rename write-through. */
    __typebridgeSetTitle?: (title: string) => void;
    __typebridgeGetTitle?: () => string;
    /** Host title beforeinput — runs through the title Editor (transliteration). */
    __typebridgeTitleEdit?: (payload: {
      inputType: string;
      data: string | null;
      start: number;
      end: number;
    }) => { value: string; start: number; end: number } | null;
    /** Host title IME/delete commit — records one undoable edit in the title Editor. */
    __typebridgeTitleCommit?: (
      value: string,
      start?: number,
      end?: number,
    ) => { value: string; start: number; end: number } | null;
    __typebridgeToggleTransliteration?: () => void;
    /** #175 step 9: host title bar Ctrl/⌘+F opens this window's Find. */
    __typebridgeOpenFind?: () => void;
  };
  hooks.__typebridgePrepareUpdateReload = prepareUpdateReload;
  hooks.__typebridgeAssertSafeUpdateReload = assertSafeToReloadAfterUpdate;
  hooks.__typebridgeCancelUpdateReload = () => { allowUpdateReload = false; suppressPendingBackup = false; };
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
  hooks.__typebridgeTitleEdit = payload => {
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
        if (start === end && start > 0) draftTitle.setRangeText('', start - 1, start, 'end');
        else draftTitle.setRangeText('', start, end, 'end');
        draftTitle.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: payload.inputType }));
      } else if (payload.inputType === 'deleteContentForward') {
        if (start === end && start < draftTitle.value.length) draftTitle.setRangeText('', start, start + 1, 'end');
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
  };
  // Catch prefs the host broadcast before this iframe finished booting.
  syncAutosaveCheckboxFromStorage();
  try { applyTabIndentFromStorage(); } catch { /* optional */ }
  try { appearanceSettings.applyFromStorage(); } catch { /* optional */ }
  try { typingSettings.applyFromStorage(); } catch { /* optional */ }
  // Do not rememberActive() here: initializeDrafts() still needs the prior
  // session/?doc= selection. Publishing the temporary blank id early would
  // overwrite it and leave secondary host windows blank after reload (#175 s8).
}
