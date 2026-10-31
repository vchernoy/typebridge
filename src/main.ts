import { russianPack } from './core/russian';
import { effectivePack, exportRules, importRules, loadOverrides, saveOverrides, type Overrides } from './core/custom-rules';
import './style.css';
import { Editor } from './editor/editor';
import { indentEdit } from './editor/indent';
import { CONFLICT_COPY, CONFLICT_COPY_LEFT, statusLineParts, withDraftListRefreshFailure, type StatusMessage } from './editor/status';
import { autosaveEnabled, newDraft, setActiveDraftId, setAutosaveEnabled } from './editor/drafts';
import { openDraftDatabase, listStoredDrafts, getStoredDraft, commitDraft, commitOrCreateConflictCopy, deleteStoredDraft, type StoredDraft } from './editor/indexeddb';
import { clearRecovery, listRecovery, writeRecovery, RECOVERY_PREFIX, type RecoverySnapshot } from './editor/recovery';
import { lineColumnAtOffset, offsetForLineColumn, parseGotoInput } from './editor/goto-line';
import { setupLayout } from './ui/layout';
import { setupSearch } from './ui/search';
import { setupWritingPosition } from './editor/writing-position';
const field = document.querySelector<HTMLTextAreaElement>('#editor')!;
const { setFocusMode, restoreFocusMode } = setupLayout(field);
const editor = new Editor(field);
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
// One status line carries both save state and action feedback (#52).
// 'progress' is save state that a later save may replace; 'action' is
// feedback the user caused; 'conflict' and 'failure' come from saving and
// must not be hidden by a later background success.
type StatusKind = 'progress' | 'action' | 'conflict' | 'failure';
const SAVE_FAILED = 'Save failed — your text is unsaved. Copy or export it, then retry by editing.';
const SAVE_FAILED_NO_STORAGE = 'Save failed — browser storage is unavailable. Copy or export your text before closing.';
const STORAGE_UNAVAILABLE = 'Storage unavailable. Copy or export unsaved text before closing.';
const AUTOSAVE_OFF_UNSAVED = 'Autosave off — changes are unsaved';
let statusKind: StatusKind = 'progress';
let statusMessage: StatusMessage = { conflict: '', primary: '', risk: '', draftListRefreshFailed: false };
type PersistResult = { saved: boolean; conflict: boolean };
type SwitchResult = { opened: boolean; conflict: boolean };
/** Cancels a pending deferred conflict write so a newer setConflict/clear wins. */
let conflictAnnounceToken = 0;
/** True between clearing the live region and the rAF rewrite for an identical conflict. */
let conflictReannouncePending = false;
/** Body/separator only — conflict live region is owned by setConflict. */
function renderStatus(): void {
  const { sep, body } = statusLineParts(statusMessage, conflictNotice.textContent ?? '');
  if (statusSep.textContent !== sep) statusSep.textContent = sep;
  if (status.textContent !== body) status.textContent = body;
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
    if (!dirty) return storageProblem;
    return storageProblem === STORAGE_UNAVAILABLE ? SAVE_FAILED_NO_STORAGE : 'Changes are unsaved. ' + storageProblem;
  }
  if (saveFailed && autosave.checked) return SAVE_FAILED;
  if (dirty && !autosave.checked) return AUTOSAVE_OFF_UNSAVED;
  return '';
}
function setRiskStatus(primary: string, kind: StatusKind, risk = riskText()): void {
  updateStatus({ primary, risk }, kind);
}
function statusKindForRisk(risk: string): Exclude<StatusKind, 'action' | 'conflict'> {
  return risk === AUTOSAVE_OFF_UNSAVED ? 'progress' : 'failure';
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
  else setSaveStatus(autosave.checked ? 'Saved locally' : 'Autosave off');
}
function markDraftListRefreshFailed(): void {
  updateStatus(withDraftListRefreshFailure(statusMessage, riskText()));
}
/** Same gate for persist and switch refresh failures — never attach to newer action feedback. */
function shouldAttachDraftListRefreshFailure(): boolean {
  return !dirty && (statusKind === 'progress' || statusKind === 'failure' || statusKind === 'conflict');
}
const count = document.querySelector<HTMLElement>('#count')!;
const caretPosition = document.querySelector<HTMLElement>('#caret-position')!;
const undo = document.querySelector<HTMLButtonElement>('#undo')!;
const redo = document.querySelector<HTMLButtonElement>('#redo')!;
const syncHistory = () => { undo.disabled = !editor.canUndo; redo.disabled = !editor.canRedo; };
field.addEventListener('historychange', syncHistory);
for (const [button, action] of [[undo, () => editor.undo()], [redo, () => editor.redo()]] as const) {
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => { action(); field.focus({ preventScroll: true }); });
}
syncHistory();
for (const [id, direction] of [['convert-cyrillic', 'to-cyrillic'], ['convert-latin', 'to-latin']] as const) {
  const button = document.querySelector<HTMLButtonElement>('#' + id)!;
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!editor.convertSelection(direction)) announceAction('Select text to convert');
  });
}
field.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== 'l' && key !== 'k') return;
  if (field.selectionStart === field.selectionEnd) return;
  event.preventDefault();
  editor.convertSelection(key === 'l' ? 'to-cyrillic' : 'to-latin');
});
function updateCaretPosition(): void {
  const { line, column } = lineColumnAtOffset(field.value, field.selectionStart);
  caretPosition.textContent = `Ln ${line}, Col ${column}`;
}
// Tab and Shift+Tab indent lines (#56). Keyboard users are never trapped: the
// "Tab indents" setting turns this off, and Shift+Tab on a line with nothing to
// outdent moves focus as usual.
const TAB_INDENT_KEY = 'typebridge.editor.tabIndent.v1';
const tabIndent = document.querySelector<HTMLInputElement>('#tab-indent')!;
try { tabIndent.checked = localStorage.getItem(TAB_INDENT_KEY) !== 'off'; } catch { /* Keep the default. */ }
tabIndent.addEventListener('change', () => {
  try { localStorage.setItem(TAB_INDENT_KEY, tabIndent.checked ? 'on' : 'off'); } catch { /* The choice still applies to this page. */ }
});
field.addEventListener('keydown', event => {
  if (event.key !== 'Tab' || !tabIndent.checked || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || field.readOnly) return;
  const change = indentEdit(field.value, field.selectionStart, field.selectionEnd, event.shiftKey);
  // Only Shift+Tab with nothing to outdent leaves the editor; a forward Tab that changes nothing stays put.
  if (!change && event.shiftKey) return;
  event.preventDefault();
  if (!change) return;
  editor.replaceAndSelect(change.start, change.end, change.text, change.selectionStart, change.selectionEnd);
});
function updateStats(): void {
  const value = field.value;
  const characters = Array.from(value).length;
  const words = (value.match(/[\p{L}\p{N}]+(?:['’\u2010-\u2015-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 180));
  count.textContent = `${characters} characters · ${words} words · ${minutes} min read`;
  updateCaretPosition();
}
field.addEventListener('input', updateStats);
field.addEventListener('historychange', updateStats);
field.addEventListener('keyup', updateCaretPosition);
field.addEventListener('click', updateCaretPosition);
field.addEventListener('select', updateCaretPosition);
// Plain-text writing is a first-class mode. Remember the choice per browser.
const TRANSLITERATION_KEY = 'typebridge.transliteration.enabled.v1';
try { enabled.checked = localStorage.getItem(TRANSLITERATION_KEY) !== 'off'; }
catch { /* Storage may be unavailable; keep the default enabled mode. */ }
editor.setEnabled(enabled.checked);
const shortcutSelect = document.querySelector<HTMLSelectElement>('#translit-shortcut')!;
const shortcutLabel = document.querySelector<HTMLElement>('#shortcut-label')!;
const modeAnnouncement = document.querySelector<HTMLElement>('#mode-announcement')!;
const shortcutStatus = document.querySelector<HTMLElement>('#shortcut-status')!;
const SHORTCUT_KEY = 'typebridge.transliteration.shortcut.v1';
const shortcutOptions = ['default', 'f7', 'f8', 'f9', 'off'] as const;
type Shortcut = typeof shortcutOptions[number];
let shortcut: Shortcut = 'default';
try {
  const stored = localStorage.getItem(SHORTCUT_KEY);
  if (shortcutOptions.some(value => value === stored)) shortcut = stored as Shortcut;
} catch { /* Keep the default if preferences are unavailable. */ }
shortcutSelect.value = shortcut;
function renderShortcut(): void {
  // The default uses Control on every platform: Command+Shift+Space can invoke Siri.
  // Keep the established Command modifier for explicitly saved macOS F-key choices.
  const modifier = shortcut !== 'default' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const label = shortcut === 'off' ? 'Shortcut disabled' : `${modifier}+Shift+${shortcut === 'default' ? 'Space' : shortcut.toUpperCase()}`;
  shortcutLabel.textContent = `(${label})`;
  enabled.title = label;
}
renderShortcut();
function saveShortcut(value: Shortcut): void {
  shortcut = value; shortcutSelect.value = value; renderShortcut();
  try { localStorage.setItem(SHORTCUT_KEY, value); shortcutStatus.textContent = 'Shortcut saved'; }
  catch { shortcutStatus.textContent = 'Shortcut could not be saved'; }
}
shortcutSelect.addEventListener('change', () => {
  const value = shortcutSelect.value;
  if (shortcutOptions.some(option => option === value)) saveShortcut(value as Shortcut);
});
document.querySelector<HTMLButtonElement>('#shortcut-reset')!.addEventListener('click', () => saveShortcut('default'));
document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || !event.shiftKey || shortcut === 'off') return;
  const usesCommand = shortcut !== 'default' && /Mac|iPhone|iPad/.test(navigator.platform);
  if (usesCommand ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return;
  if (event.code !== (shortcut === 'default' ? 'Space' : shortcut.toUpperCase())) return;
  if (!(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) return;
  if (!['editor', 'find-text', 'replace-text', 'draft-title'].includes(event.target.id)) return;
  event.preventDefault();
  enabled.checked = !enabled.checked;
  enabled.dispatchEvent(new Event('change', { bubbles: true }));
});
enabled.addEventListener('change', () => {
  editor.setEnabled(enabled.checked);
  syncSearchEditors();
  modeAnnouncement.textContent = enabled.checked ? 'Transliteration on' : 'Transliteration off';
  // Editing continues even when browser storage is blocked.
  try { localStorage.setItem(TRANSLITERATION_KEY, enabled.checked ? 'on' : 'off'); preferenceSaved('transliteration', true); }
  catch { preferenceSaved('transliteration', false); }
});
document.querySelector<HTMLButtonElement>('#copy')!.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(field.value); announceAction('Copied'); }
  catch { field.focus(); field.select(); announceAction('Copy unavailable. Text selected; use your device’s copy command.'); }
});
document.querySelector<HTMLButtonElement>('#clear')!.addEventListener('click', () => {
  if (field.value && window.confirm('Clear the text? You can undo this action.')) { editor.clear(); field.focus(); announceAction('Cleared'); }
});


const { findInput, findEditor, replaceEditor, syncSearchEditors } = setupSearch(field, editor, enabled);
const gotoInput = document.querySelector<HTMLInputElement>('#goto-line')!;
const gotoStatus = document.querySelector<HTMLElement>('#goto-status')!;
function openGoto(): void {
  if (document.body.classList.contains('focus-mode')) setFocusMode(false);
  gotoInput.focus();
  gotoInput.select();
}
function goToLine(): void {
  const parsed = parseGotoInput(gotoInput.value);
  if (!parsed) {
    gotoStatus.textContent = gotoInput.value.trim() ? 'Use line or line:column' : 'Enter a line number';
    return;
  }
  const target = offsetForLineColumn(field.value, parsed.line, parsed.column ?? 1);
  field.focus({ preventScroll: true });
  field.setSelectionRange(target.offset, target.offset);
  editor.revealSelection();
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
  if (key === 'f' && !event.shiftKey) {
    event.preventDefault(); findInput.focus(); findInput.select();
  } else if (key === 'g' && !event.shiftKey) {
    // Cmd/Ctrl+G: go to line. May also be reserved by the browser's Find UI.
    event.preventDefault();
    openGoto();
  }
});


const rulesText = document.querySelector<HTMLTextAreaElement>('#rules-text')!;
const rulesStatus = document.querySelector<HTMLElement>('#rules-status')!;
let overrides: Overrides = loadOverrides();
function renderRules(): void {
  rulesText.value = effectivePack(overrides).mappings.map(rule => rule.input + ' = ' + rule.output).join('\n');
}
function parseRules(text: string): Overrides {
  const proposed: Overrides = Object.create(null) as Overrides;
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*([^=]+?)\s*=\s*([^=]+?)\s*$/.exec(line);
    if (!match) throw new Error('Use Latin = Cyrillic, one rule per line');
    const input = match[1].trim(), output = match[2].trim();
    if (seen.has(input)) throw new Error('Duplicate rule: ' + input);
    seen.add(input);
    proposed[input] = output;
  }
  // Missing default rules retain their built-in mapping; explicit edits override it.
  const defaults = new Map(russianPack.mappings.map(rule => [rule.input, rule.output]));
  const changes: Overrides = Object.create(null) as Overrides;
  for (const [input, output] of Object.entries(proposed)) {
    if (defaults.get(input) !== output) changes[input] = output;
  }
  return changes;
}
document.querySelector<HTMLButtonElement>('#rules-save')!.addEventListener('click', () => {
  try {
    const next = parseRules(rulesText.value);
    saveOverrides(next);
    overrides = next;
    editor.setRules(overrides); findEditor.setRules(overrides); replaceEditor.setRules(overrides); titleEditor.setRules(overrides);
    renderRules();
    rulesStatus.textContent = 'Rules saved locally';
  } catch (error) { rulesStatus.textContent = error instanceof Error ? error.message : 'Invalid rules'; }
});
document.querySelector<HTMLButtonElement>('#rules-reset')!.addEventListener('click', () => {
  try { saveOverrides({}); overrides = {}; editor.setRules(overrides); findEditor.setRules(overrides); replaceEditor.setRules(overrides); titleEditor.setRules(overrides); renderRules(); rulesStatus.textContent = 'Default rules restored'; }
  catch { rulesStatus.textContent = 'Unable to save rules'; }
});
document.querySelector<HTMLButtonElement>('#rules-export')!.addEventListener('click', () => {
  const blob = new Blob([exportRules(overrides)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'typebridge-rules.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.querySelector<HTMLInputElement>('#rules-import')!.addEventListener('change', async event => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 65536) throw new Error('Rules file is too large');
    const next = importRules(await file.text());
    saveOverrides(next); overrides = next; editor.setRules(overrides); findEditor.setRules(overrides); replaceEditor.setRules(overrides); titleEditor.setRules(overrides); renderRules();
    rulesStatus.textContent = 'Rules imported';
  } catch (error) { rulesStatus.textContent = error instanceof Error ? error.message : 'Import failed'; }
  finally { input.value = ''; }
});
renderRules();

const draftSelect = document.querySelector<HTMLSelectElement>('#drafts')!;
const draftTitle = document.querySelector<HTMLInputElement>('#draft-title')!;
// The draft title follows the global transliteration mode and rules (#89).
const titleEditor = new Editor(draftTitle);
titleEditor.setEnabled(enabled.checked);
enabled.addEventListener('change', () => titleEditor.setEnabled(enabled.checked));
const autosave = document.querySelector<HTMLInputElement>('#autosave')!;
let db: IDBDatabase | undefined;
let active: StoredDraft = { ...newDraft(), revision: 0 };
let drafts: StoredDraft[] = [];
let dirty = false;
let generation = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<PersistResult> | undefined;
let transitioning = false;
let deleting = false;
let loadingDraft = false;
const writingPosition = setupWritingPosition(field, () => loadingDraft || field.disabled ? undefined : active.id);
const journalTab = crypto.randomUUID();
const OWNER_LOCK = 'typebridge-recovery-owner:';
let ownershipAvailable = false;
const ownerReady = new Promise<void>(resolve => {
  if (!navigator.locks) { resolve(); return; }
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
recoveryPanel.setAttribute('aria-label', 'Recover unsaved drafts');
status.parentElement?.before(recoveryPanel);

field.disabled = true;
draftSelect.disabled = true;
draftTitle.disabled = true;
autosave.checked = true;
try { autosave.checked = autosaveEnabled(); } catch { /* Keep editing available if preferences are blocked. */ }
// A tab-scoped emergency snapshot is not the committed draft. It only bridges
// navigation/reload when the browser aborts an IndexedDB transaction on unload.
const PENDING_KEY = 'typebridge.pendingDraft.v1';
function readPending(): StoredDraft | undefined {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return undefined;
    const draft = value as Partial<StoredDraft>;
    if (typeof draft.id !== 'string' || !draft.id || typeof draft.title !== 'string' ||
        typeof draft.text !== 'string' || typeof draft.updatedAt !== 'number' ||
        !Number.isSafeInteger(draft.revision) || (draft.revision ?? -1) < 0) return undefined;
    return draft as StoredDraft;
  } catch { return undefined; }
}
function snapshot(): StoredDraft {
  return { ...active, text: field.value, title: draftTitle.value.trim() || 'Untitled draft', history: editor.exportHistory(), updatedAt: Date.now() };
}
function journalEdit(): void {
  if (!autosave.checked) return;
  const entry: RecoverySnapshot = { token: crypto.randomUUID(), tab: journalTab, documentId: active.id, revision: active.revision, timestamp: Date.now(), title: draftTitle.value.trim() || 'Untitled draft', text: field.value };
  try { writeRecovery(localStorage, entry); currentJournal = entry; journalWarning.hidden = true; }
  catch { journalWarning.textContent = 'Emergency backup unavailable. Keep this tab open until saved, or copy or export your text.'; journalWarning.hidden = false; }
}
function sameContent(a: StoredDraft, b: StoredDraft): boolean {
  return a.id === b.id && a.title === b.title && a.text === b.text && JSON.stringify(a.history) === JSON.stringify(b.history);
}
function savePending(): void {
  if (!dirty || !autosave.checked || deleting) return;
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
function rememberActive(): void { try { setActiveDraftId(active.id); } catch { /* Selection is only a hint. */ } }
function renderDrafts(): void {
  draftSelect.replaceChildren();
  const visible = drafts.some(d => d.id === active.id) ? drafts : [active, ...drafts];
  for (const draft of visible) {
    const option = document.createElement('option');
    option.value = draft.id;
    option.textContent = draft.title + (draft.id === active.id ? ' (current)' : '');
    draftSelect.append(option);
  }
  draftSelect.value = active.id;
}
async function refreshDrafts(): Promise<void> {
  if (db) drafts = await listStoredDrafts(db);
  renderDrafts();
  if (statusMessage.draftListRefreshFailed) updateStatus({ draftListRefreshFailed: false });
}
function showDraft(): void {
  // Callers decide post-load status; clearing through updateStatus keeps the DOM in sync.
  clearNotices();
  loadingDraft = true;
  try {
    editor.load(active.text);
    editor.restoreHistory(active.history);
    draftTitle.value = active.title;
    dirty = false;
    saveFailed = false; // The editor no longer holds the unsaved text.
  } finally { loadingDraft = false; }
  writingPosition.restore(active.id);
  renderDrafts();
  updateStats();
}
async function persist(): Promise<PersistResult> {
  clearTimeout(saveTimer);
  if (deleting || !autosave.checked || !dirty) return { saved: !dirty, conflict: false };
  if (saving) return saving;
  saving = (async () => {
    let createdConflict = false;
    try {
      if (!db) throw new Error('Storage unavailable');
      while (dirty && autosave.checked) {
        const version = generation;
        const saved = snapshot();
        const journal = currentJournal && currentJournal.documentId === saved.id && currentJournal.revision === active.revision && currentJournal.text === saved.text && currentJournal.title === saved.title ? currentJournal : undefined;
        const result = await commitOrCreateConflictCopy(db, saved, active.revision, crypto.randomUUID());
        clearPending(saved);
        if (journal) { try { clearRecovery(localStorage, journal); } catch { /* Retain a recoverable entry on storage errors. */ } }
        active = result.draft;
        writingPosition.save();
        if (generation !== version && autosave.checked) journalEdit();
        rememberActive();
        saveFailed = false;
        dirty = generation !== version;
        if (result.conflict) {
          // Retain new edits typed while the transaction was in flight.
          if ((draftTitle.value.trim() || 'Untitled draft') === saved.title) draftTitle.value = active.title;
          // Storage may have become unusable while the copy was written.
          createdConflict = true;
          // While switching, leave announcement to switchDraft so early returns and
          // the success path each announce once (avoids CONFLICT_COPY then LEFT).
          if (!transitioning) setConflict(CONFLICT_COPY, true);
          updateStatus({
            primary: dirty && !storageProblem ? 'Saving…' : '',
            risk: riskText(),
          }, transitioning ? statusKind : 'conflict');
        }
        // A background save must not replace newer action feedback or a conflict
        // notice, but it must replace progress and an earlier failure it resolved.
        // Use statusKind (not merely a pending conflict string) so an action that
        // kept a conflict notice — e.g. a failed draft switch — is not wiped.
        if (!dirty && !result.conflict && (statusKind === 'progress' || statusKind === 'failure' || statusKind === 'conflict')) {
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
      return { saved: !dirty, conflict: createdConflict };
    } catch {
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
    if (!deleting && dirty && autosave.checked && !saveFailed) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { void persist(); }, 300);
    }
  }
}
function scheduleSave(): void {
  if (loadingDraft) return;
  dirty = true;
  generation++;
  journalEdit();
  clearTimeout(saveTimer);
  if (autosave.checked) { showSaving(); saveTimer = setTimeout(() => { void persist(); }, 300); }
  else showSaveState();
}
field.addEventListener('input', scheduleSave);
field.addEventListener('historychange', scheduleSave);
draftTitle.addEventListener('input', scheduleSave);
autosave.addEventListener('change', async () => {
  autosave.disabled = true;
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
    if (dirty) showSaving(); else announce('Autosave on');
    if (dirty) { journalEdit(); void persist(); }
  }
  else {
    clearTimeout(saveTimer);
    // Await an in-flight save without clearing first — it may create a conflict copy
    // that the delete prompt then targets, and the user must see that notice.
    // Older conflict notices still clear when the toggle did not itself create one.
    const inFlight = saving ? await saving : undefined;
    if (!inFlight?.conflict) clearNotices();
    if (window.confirm('Delete the saved copy of this draft? Cancel keeps it in your Drafts list.')) {
      try {
        if (!db || !await deleteStoredDraft(db, active.id, active.revision)) throw new Error('Draft changed');
        active = { ...active, revision: 0 };
        dirty = true;
        clearNotices();
        await refreshDrafts();
      } catch {
        announceAction('Could not delete saved draft; current text is kept', { keepConflict: true });
        return;
      }
    }
    announce(dirty ? 'Autosave off — changes are unsaved' : 'Autosave off');
  }
  } finally { autosave.disabled = false; }
});
async function switchDraft(id?: string): Promise<SwitchResult> {
  if (transitioning) return { opened: false, conflict: false };
  if (id === active.id) { renderDrafts(); return { opened: true, conflict: false }; }
  transitioning = true;
  let flushConflict = false;
  /** Announce a flush conflict when the switch does not open another draft. */
  const announceAbortedFlushConflict = (): void => {
    if (flushConflict) setConflict(CONFLICT_COPY);
  };
  try {
    clearTimeout(saveTimer);
    let next: StoredDraft | undefined;
    while (true) {
      while (dirty && autosave.checked) {
        const result = await persist();
        if (result.conflict) flushConflict = true;
        if (!result.saved && saveFailed) {
          announceAbortedFlushConflict();
          return { opened: false, conflict: flushConflict };
        }
      }
      if (dirty && !autosave.checked && !window.confirm('Discard unsaved changes? Copy or export them first to keep them.')) {
        announceAbortedFlushConflict();
        return { opened: false, conflict: flushConflict };
      }
      const version = generation;
      next = id && db ? await getStoredDraft(db, id) : undefined;
      if (id && !next) throw new Error('Draft no longer exists');
      if (generation === version) break;
    }
    writingPosition.save();
    active = next ?? { ...newDraft(), revision: 0 };
    rememberActive();
    showDraft();
    // Always show the opened draft's save state — pre-switch action feedback must not stick.
    showSaveState();
    // Flush announced nothing while transitioning; name the draft that was left once.
    if (flushConflict) setConflict(CONFLICT_COPY_LEFT);
    void refreshDrafts().catch(() => {
      if (shouldAttachDraftListRefreshFailure()) markDraftListRefreshFailed();
    });
    return { opened: true, conflict: flushConflict };
  } catch {
    announceAbortedFlushConflict();
    announceAction('Could not open draft — current text was kept', { keepConflict: flushConflict });
    return { opened: false, conflict: flushConflict };
  }
  finally { transitioning = false; renderDrafts(); }
}
document.querySelector<HTMLButtonElement>('#new-draft')!.addEventListener('click', () => { void switchDraft(); });
draftSelect.addEventListener('change', () => { void switchDraft(draftSelect.value); });
document.querySelector<HTMLButtonElement>('#delete-draft')!.addEventListener('click', async () => {
  if (transitioning) return;
  clearTimeout(saveTimer);
  const requestedId = active.id;
  if (!window.confirm('Permanently delete this saved draft?')) {
    if (dirty && autosave.checked) saveTimer = setTimeout(() => { void persist(); }, 300);
    return;
  }
  transitioning = true;
  field.readOnly = true;
  draftTitle.readOnly = true;
  let committed = false;
  let savedBeforeDelete = false;
  try {
    if (saving && !(await saving).saved) throw new Error('Save failed');
    if (dirty && autosave.checked) {
      if (!(await persist()).saved) throw new Error('Save failed');
      savedBeforeDelete = true;
    }
    if (active.id !== requestedId) {
      announceAction('Could not delete original — your changes were saved as a conflict copy.');
      return;
    }
    deleting = true;
    if (!db || !await deleteStoredDraft(db, active.id, active.revision)) throw new Error('Draft changed in another tab');
    committed = true;
    clearTimeout(saveTimer);
    writingPosition.save();
    active = { ...newDraft(), revision: 0 };
    rememberActive();
    // The deletion is durable; clear the editor before a fallible list refresh.
    showDraft();
    try { await refreshDrafts(); announceAction('Draft deleted'); }
    catch { announceAction('Draft deleted, but the draft list could not be refreshed'); }
  } catch {
    // Without storage, announceAction() adds the storage warning; no save will follow.
    // Explicit delete failures clear conflict feedback; these two messages already
    // state the save situation, so they do not also append riskText().
    if (dirty && !saveFailed && autosave.checked && !storageProblem) {
      announceAction('Could not delete draft — your changes are unsaved; saving again…', { kind: 'progress', omitRisk: true });
    } else if (dirty && !autosave.checked && !storageProblem) {
      announceAction('Could not delete draft — your changes are unsaved; autosave is off', { kind: 'progress', omitRisk: true });
    } else announceAction(savedBeforeDelete ? 'Could not delete draft — Saved locally; your text is kept.' : 'Could not delete draft — your text is kept.');
  } finally {
    field.readOnly = false; draftTitle.readOnly = false; transitioning = false; deleting = false;
    if (!committed && dirty && autosave.checked) {
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
  heading.textContent = ownershipAvailable ? 'Emergency backups found. Recover a copy without changing your current draft:' : 'Ownership cannot be verified; these backups may belong to open tabs. Recover a copy without changing your current draft:';
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
        clearRecovery(localStorage, item);
        await refreshDrafts();
        announceAction('Recovered a copy in Drafts. Your current draft was kept.');
        panelSignature = ''; await renderRecovery();
      } catch { announceAction('Recovery failed. The emergency backup was kept; retry or copy your text.'); button.disabled = false; }
    });
    const discard = document.createElement('button');
    discard.type = 'button'; discard.textContent = `Discard backup for ${item.title}`;
    discard.addEventListener('click', async () => {
      if (await ownerIsActive(item.tab) === true) { announceAction('The original tab is still open; backup kept.'); queueRecovery(); return; }
      if (!window.confirm('Discard this emergency backup? Unsaved text in this backup will be lost.')) return;
      try { clearRecovery(localStorage, item); panelSignature = ''; await renderRecovery(); }
      catch { announceAction('Could not discard backup; it was kept.'); }
    });
    group.append(button, discard); recoveryPanel.append(group);
  }
}
window.addEventListener('storage', event => { if (event.key?.startsWith(RECOVERY_PREFIX)) queueRecovery(); });
setInterval(queueRecovery, 5000);
async function initializeDrafts(): Promise<void> {
  await ownerReady;
  try {
    db = await openDraftDatabase(() => {
      db = undefined;
      storageProblem = 'Storage was upgraded in another tab. Copy or export unsaved text, then reload.';
      recoveryNotice.hidden = false;
      recoveryNotice.textContent = storageProblem;
      // A later upgrade must not erase an earlier conflict-copy notice (#66).
      setRiskStatus('', 'failure');
    });
    drafts = await listStoredDrafts(db);
    let selected: string | null = null;
    try { selected = sessionStorage.getItem('typebridge.activeDraft.v1'); } catch { /* Optional hint. */ }
    const pending = readPending();
    const committed = pending && drafts.find(d => d.id === pending.id);
    if (pending && committed && sameContent(pending, committed)) clearPending(pending);
    const restorePending = !!pending && (!committed || !sameContent(pending, committed));
    active = restorePending ? pending! : drafts.find(d => d.id === selected) ?? drafts[0] ?? active;
    rememberActive();
    showDraft();
    if (restorePending) {
      dirty = true; generation++;
      if (autosave.checked) { setSaveStatus('Recovered unsaved text; saving…'); await persist(); }
      else setSaveStatus('Recovered unsaved text; autosave is off');
    }
  } catch (error) {
    db?.close(); db = undefined;
    const pending = readPending();
    if (pending) { active = pending; showDraft(); dirty = true; generation++; saveFailed = true; }
    storageProblem = error instanceof Error && error.message.startsWith('Database upgrade blocked.') ? error.message : STORAGE_UNAVAILABLE;
    setSaveStatus(storageProblem, 'failure');
    renderDrafts();
  } finally {
    field.disabled = false; draftSelect.disabled = false; draftTitle.disabled = false;
    restoreFocusMode();
    writingPosition.restore(active.id);
    updateStats();
    void renderRecovery();
  }
}
void initializeDrafts();

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
  return (title.trim().split('').map(char => char.charCodeAt(0) < 32 || '/\\\\:*?"<>|'.includes(char) ? '-' : char).join('').slice(0, 80) || 'draft');
}
document.querySelector<HTMLButtonElement>('#export-txt')!.addEventListener('click', () => {
  downloadText(safeFilename(draftTitle.value) + '.txt', field.value, 'text/plain;charset=utf-8');
  announceAction('Text exported');
});
document.querySelector<HTMLButtonElement>('#export-json')!.addEventListener('click', () => {
  const draft = { title: draftTitle.value.trim() || 'Untitled draft', text: field.value };
  downloadText(safeFilename(draft.title) + '.typebridge.json', JSON.stringify({ format: 'typebridge-draft', version: 1, draft }, null, 2), 'application/json;charset=utf-8');
  announceAction('Draft exported');
});
const importFile = document.querySelector<HTMLInputElement>('#import-file')!;
document.querySelector<HTMLButtonElement>('#import-draft')!.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
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
      if (!parsed || typeof parsed !== 'object' || !('format' in parsed) || parsed.format !== 'typebridge-draft' || !('version' in parsed) || parsed.version !== 1 || !('draft' in parsed) || !parsed.draft || typeof parsed.draft !== 'object' || !('title' in parsed.draft) || typeof parsed.draft.title !== 'string' || !('text' in parsed.draft) || typeof parsed.draft.text !== 'string') throw new Error('Not a supported TypeBridge draft');
      title = parsed.draft.title;
      text = parsed.draft.text;
    } else if (!/\.txt$/i.test(file.name)) throw new Error('Choose a .txt or .typebridge.json file');
    if (!window.confirm('Import as a new draft? Your current draft will be kept.')) return;
    const imported = { ...newDraft(text), title: title.trim().slice(0, 150) || 'Imported draft' };
    // Save even when autosave is off: importing is an explicit save action.
    if (!db) throw new Error('browser storage cannot be used');
    const result = await commitOrCreateConflictCopy(db, imported, 0, crypto.randomUUID());
    const switched = await switchDraft(result.draft.id);
    // Always confirm the import; keep a conflict notice that the switch flush created.
    announceAction(
      switched.opened ? 'Imported as a new draft' : 'Import saved in Drafts; current text was kept',
      { keepConflict: switched.conflict },
    );
  } catch (error) {
    announceAction('Import failed: ' + (error instanceof Error ? error.message : String(error)));
  }
});

window.addEventListener('pagehide', () => { savePending(); clearTimeout(saveTimer); void persist(); });
window.addEventListener('beforeunload', event => {
  if (dirty) { savePending(); clearTimeout(saveTimer); void persist(); event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { clearTimeout(saveTimer); void persist(); } });
updateStats();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/typebridge/sw.js', { scope: '/typebridge/' })
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
