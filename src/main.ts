import { russianPack } from './core/russian';
import { effectivePack, exportRules, importRules, loadOverrides, saveOverrides, type Overrides } from './core/custom-rules';
import './style.css';
import { Editor } from './editor/editor';
import { autosaveEnabled, deleteDraft, getActiveDraftId, getDraft, listDrafts, newDraft, saveDraft, setActiveDraftId, setAutosaveEnabled } from './editor/drafts';
const field = document.querySelector<HTMLTextAreaElement>('#editor')!;
const focusButton = document.querySelector<HTMLButtonElement>('#focus-mode')!;
const exitFocusButton = document.querySelector<HTMLButtonElement>('#exit-focus')!;
function setFocusMode(enabled: boolean): void {
  document.body.classList.toggle('focus-mode', enabled);
  focusButton.setAttribute('aria-pressed', String(enabled));
  exitFocusButton.hidden = !enabled;
  field.focus({ preventScroll: true });
}
focusButton.addEventListener('click', () => setFocusMode(!document.body.classList.contains('focus-mode')));
exitFocusButton.addEventListener('click', () => setFocusMode(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.body.classList.contains('focus-mode')) {
    event.preventDefault();
    setFocusMode(false);
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    setFocusMode(!document.body.classList.contains('focus-mode'));
  }
});
const editor = new Editor(field);
const enabled = document.querySelector<HTMLInputElement>('#enabled')!;
const status = document.querySelector<HTMLElement>('#status')!;
const count = document.querySelector<HTMLElement>('#count')!;
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
    if (!editor.convertSelection(direction)) status.textContent = 'Select text to convert';
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
function updateStats(): void {
  const value = field.value;
  const characters = Array.from(value).length;
  const words = (value.match(/[\p{L}\p{N}]+(?:['’\u2010-\u2015-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 180));
  count.textContent = `${characters} characters · ${words} words · ${minutes} min read`;
}
field.addEventListener('input', updateStats);
field.addEventListener('historychange', updateStats);
// Plain-text writing is a first-class mode. Remember the choice per browser.
const TRANSLITERATION_KEY = 'typebridge.transliteration.enabled.v1';
try { enabled.checked = localStorage.getItem(TRANSLITERATION_KEY) !== 'off'; }
catch { /* Storage may be unavailable; keep the default enabled mode. */ }
editor.setEnabled(enabled.checked);
enabled.addEventListener('change', () => {
  editor.setEnabled(enabled.checked);
  try { localStorage.setItem(TRANSLITERATION_KEY, enabled.checked ? 'on' : 'off'); }
  catch { /* Editing must continue even when browser storage is blocked. */ }
});
document.querySelector<HTMLButtonElement>('#copy')!.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(field.value); status.textContent = 'Copied'; }
  catch { field.focus(); field.select(); status.textContent = 'Copy unavailable. Text selected; use your device’s copy command.'; }
});
document.querySelector<HTMLButtonElement>('#clear')!.addEventListener('click', () => {
  if (field.value && window.confirm('Clear the text? You can undo this action.')) { editor.clear(); field.focus(); status.textContent = 'Cleared'; }
});


const findInput = document.querySelector<HTMLInputElement>('#find-text')!;
const replaceInput = document.querySelector<HTMLInputElement>('#replace-text')!;
const matchCase = document.querySelector<HTMLInputElement>('#match-case')!;
const regexMode = document.querySelector<HTMLInputElement>('#regex-mode')!;
const findStatus = document.querySelector<HTMLElement>('#find-status')!;
function searchPattern(): RegExp | null {
  const query = findInput.value;
  if (!query) { findStatus.textContent = ''; return null; }
  const flags = matchCase.checked ? 'g' : 'gi';
  const escaped = Array.from(query, char => '\\^$.*+?()[]{}|'.includes(char) ? '\\' + char : char).join('');
  try {
    const pattern = new RegExp(regexMode.checked ? query : escaped, flags);
    findStatus.textContent = '';
    return pattern;
  } catch (error) {
    findStatus.textContent = 'Invalid regex: ' + (error instanceof Error ? error.message : String(error));
    return null;
  }
}
function matches(): Array<[number, number]> {
  const pattern = searchPattern();
  if (!pattern) return [];
  return Array.from(field.value.matchAll(pattern), m => [m.index, m.index + m[0].length]);
}
function replacementFor(match: RegExpExecArray, original: string): string {
  if (!regexMode.checked) return replaceInput.value;
  const start = match.index;
  const end = start + match[0].length;
  return replaceInput.value.replace(/\$\$|\$&|\$\x60|\$'|\$<([^>]+)>|\$(\d{1,2})/g, (token, name: string | undefined, index: string | undefined) => {
    if (token === '$$') return '$';
    if (token === '$&') return match[0];
    if (token === '$\x60') return original.slice(0, start);
    if (token === "$'") return original.slice(end);
    if (name !== undefined) return match.groups ? (name in match.groups ? match.groups[name] ?? '' : token) : token;
    if (index !== undefined) {
      const n = Number(index);
      if (n > 0 && n < match.length) return match[n] ?? '';
    }
    return token;
  });
}
function findNext(backwards = false): void {
  const found = matches();
  if (!found.length) { if (!findStatus.textContent.startsWith('Invalid regex')) findStatus.textContent = findInput.value ? 'No matches' : 'Enter search text'; return; }
  const position = backwards ? field.selectionStart : field.selectionEnd;
  const match = backwards
    ? [...found].reverse().find(([start]) => start < position) ?? found[found.length - 1]
    : found.find(([start]) => start >= position) ?? found[0];
  field.focus({ preventScroll: true });
  field.setSelectionRange(match[0], match[1]);
  // The browser scrolls textarea contents to the selected match.
  findStatus.textContent = `${found.length} match${found.length === 1 ? '' : 'es'}`;
}
document.querySelector<HTMLButtonElement>('#find-next')!.addEventListener('click', () => findNext());
document.querySelector<HTMLButtonElement>('#find-prev')!.addEventListener('click', () => findNext(true));
document.querySelector<HTMLButtonElement>('#replace-one')!.addEventListener('click', () => {
  const found = matches();
  if (!found.length) { if (!findStatus.textContent.startsWith('Invalid regex')) findStatus.textContent = 'No matches'; return; }
  const match = found.find(([start, end]) => start === field.selectionStart && end === field.selectionEnd)
    ?? found.find(([start]) => start >= field.selectionEnd) ?? found[0];
  const pattern = searchPattern()!;
  pattern.lastIndex = match[0];
  const capture = pattern.exec(field.value);
  if (!capture || capture.index !== match[0]) return;
  editor.replaceRange(match[0], match[1], replacementFor(capture, field.value));
  findStatus.textContent = 'Replaced 1 match';
  field.focus({ preventScroll: true });
});
document.querySelector<HTMLButtonElement>('#replace-all')!.addEventListener('click', () => {
  const pattern = searchPattern();
  if (!pattern) return;
  const original = field.value;
  const found = Array.from(original.matchAll(pattern));
  if (!found.length) { findStatus.textContent = 'No matches'; return; }
  const result = original.replace(pattern, (...args) => {
    const text = args[0] as string;
    const offset = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null ? args[args.length - 3] as number : args[args.length - 2] as number;
    const groups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null ? args[args.length - 1] as Record<string, string> : undefined;
    const captures = args.slice(1, groups ? -3 : -2) as string[];
    const match = Object.assign([text, ...captures], { index: offset, input: original, groups }) as RegExpExecArray;
    return replacementFor(match, original);
  });
  editor.replaceRange(0, original.length, result);
  findStatus.textContent = `Replaced ${found.length} matches`;
  field.focus({ preventScroll: true });
});
findInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); findNext(event.shiftKey); }
});
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault(); findInput.focus(); findInput.select();
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
    editor.setRules(overrides);
    renderRules();
    rulesStatus.textContent = 'Rules saved locally';
  } catch (error) { rulesStatus.textContent = error instanceof Error ? error.message : 'Invalid rules'; }
});
document.querySelector<HTMLButtonElement>('#rules-reset')!.addEventListener('click', () => {
  try { saveOverrides({}); overrides = {}; editor.setRules(overrides); renderRules(); rulesStatus.textContent = 'Default rules restored'; }
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
    saveOverrides(next); overrides = next; editor.setRules(overrides); renderRules();
    rulesStatus.textContent = 'Rules imported';
  } catch (error) { rulesStatus.textContent = error instanceof Error ? error.message : 'Import failed'; }
  finally { input.value = ''; }
});
renderRules();

const draftSelect = document.querySelector<HTMLSelectElement>('#drafts')!;
const draftTitle = document.querySelector<HTMLInputElement>('#draft-title')!;
const autosave = document.querySelector<HTMLInputElement>('#autosave')!;
let active = (getActiveDraftId() && getDraft(getActiveDraftId()!)) || newDraft();
setActiveDraftId(active.id);
autosave.checked = autosaveEnabled();
function renderDrafts(): void {
  draftSelect.replaceChildren();
  const drafts = listDrafts();
  if (!drafts.some(d => d.id === active.id)) drafts.unshift(active);
  for (const draft of drafts) {
    const option = document.createElement('option');
    option.value = draft.id;
    option.textContent = draft.title + (draft.id === active.id ? ' (current)' : '');
    draftSelect.append(option);
  }
  draftSelect.value = active.id;
}
function showDraft(): void {
  editor.load(active.text);
  editor.restoreHistory(active.history);
  draftTitle.value = active.title;
  renderDrafts();
}
function persist(): void {
  if (!autosave.checked) return;
  active = { ...active, text: field.value, title: draftTitle.value.trim() || 'Untitled draft', history: editor.exportHistory(), updatedAt: Date.now() };
  try { saveDraft(active); status.textContent = 'Saved locally'; renderDrafts(); }
  catch { status.textContent = 'Save failed — check browser storage'; }
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  if (autosave.checked) { status.textContent = 'Saving…'; saveTimer = setTimeout(persist, 300); }
}
field.addEventListener('input', scheduleSave);
field.addEventListener('historychange', scheduleSave);
draftTitle.addEventListener('input', scheduleSave);
autosave.addEventListener('change', () => {
  setAutosaveEnabled(autosave.checked);
  if (autosave.checked) persist();
  else {
    clearTimeout(saveTimer);
    if (window.confirm('Delete the saved copy of this draft? Cancel keeps it in your Drafts list.')) {
      try { deleteDraft(active.id); renderDrafts(); }
      catch { status.textContent = 'Could not delete saved draft'; }
    }
    status.textContent = 'Autosave off';
  }
});
function switchDraft(draft: typeof active): void {
  clearTimeout(saveTimer);
  persist();
  active = draft;
  setActiveDraftId(active.id);
  showDraft();
updateStats();
}
document.querySelector<HTMLButtonElement>('#new-draft')!.addEventListener('click', () => switchDraft(newDraft()));
draftSelect.addEventListener('change', () => {
  const draft = getDraft(draftSelect.value);
  if (draft) switchDraft(draft);
});
document.querySelector<HTMLButtonElement>('#delete-draft')!.addEventListener('click', () => {
  if (!window.confirm('Permanently delete this saved draft?')) return;
  try {
    deleteDraft(active.id);
    active = newDraft();
    setActiveDraftId(active.id);
    showDraft();
    status.textContent = 'Draft deleted';
  } catch { status.textContent = 'Could not delete draft'; }
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
  return (title.trim().split('').map(char => char.charCodeAt(0) < 32 || '/\\\\:*?"<>|'.includes(char) ? '-' : char).join('').slice(0, 80) || 'draft');
}
document.querySelector<HTMLButtonElement>('#export-txt')!.addEventListener('click', () => {
  downloadText(safeFilename(draftTitle.value) + '.txt', field.value, 'text/plain;charset=utf-8');
  status.textContent = 'Text exported';
});
document.querySelector<HTMLButtonElement>('#export-json')!.addEventListener('click', () => {
  const draft = { title: draftTitle.value.trim() || 'Untitled draft', text: field.value };
  downloadText(safeFilename(draft.title) + '.typebridge.json', JSON.stringify({ format: 'typebridge-draft', version: 1, draft }, null, 2), 'application/json;charset=utf-8');
  status.textContent = 'Draft exported';
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
    let title = file.name.replace(/(\\.typebridge)?\\.(json|txt)$/i, '');
    let text = content;
    if (/\\.json$/i.test(file.name)) {
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object' || !('format' in parsed) || parsed.format !== 'typebridge-draft' || !('version' in parsed) || parsed.version !== 1 || !('draft' in parsed) || !parsed.draft || typeof parsed.draft !== 'object' || !('title' in parsed.draft) || typeof parsed.draft.title !== 'string' || !('text' in parsed.draft) || typeof parsed.draft.text !== 'string') throw new Error('Not a supported TypeBridge draft');
      title = parsed.draft.title;
      text = parsed.draft.text;
    } else if (!/\\.txt$/i.test(file.name)) throw new Error('Choose a .txt or .typebridge.json file');
    if (!window.confirm('Import as a new draft? Your current draft will be kept.')) return;
    const imported = { ...newDraft(text), title: title.trim().slice(0, 150) || 'Imported draft' };
    // Save even when autosave is off: importing is an explicit save action.
    saveDraft(imported);
    switchDraft(imported);
    status.textContent = 'Imported as a new draft';
  } catch (error) {
    status.textContent = 'Import failed: ' + (error instanceof Error ? error.message : String(error));
  }
});

window.addEventListener('pagehide', () => { clearTimeout(saveTimer); persist(); });
showDraft();
updateStats();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/typebridge/sw.js', { scope: '/typebridge/' })
      .catch(() => { /* Editor remains usable without service worker support. */ });
  });
}
