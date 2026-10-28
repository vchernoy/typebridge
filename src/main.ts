import './style.css';
import { Editor } from './editor/editor';
import { autosaveEnabled, deleteDraft, getActiveDraftId, getDraft, listDrafts, newDraft, saveDraft, setActiveDraftId, setAutosaveEnabled } from './editor/drafts';
const field = document.querySelector<HTMLTextAreaElement>('#editor')!;
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
  const words = (value.match(/[\\p{L}\\p{N}]+(?:['’\u2010-\u2015-][\\p{L}\\p{N}]+)*/gu) ?? []).length;
  const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 180));
  count.textContent = `${characters} characters · ${words} words · ${minutes} min read`;
}
field.addEventListener('input', updateStats);
field.addEventListener('historychange', updateStats);
enabled.addEventListener('change', () => { editor.setEnabled(enabled.checked); });
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
const findStatus = document.querySelector<HTMLElement>('#find-status')!;
function matches(): Array<[number, number]> {
  const query = findInput.value;
  if (!query) return [];
  const flags = matchCase.checked ? 'g' : 'gi';
  const escaped = Array.from(query, char => '\\^$.*+?()[]{}|'.includes(char) ? '\\' + char : char).join('');
  const pattern = new RegExp(escaped, flags);
  return Array.from(field.value.matchAll(pattern), m => [m.index, m.index + m[0].length]);
}
function findNext(backwards = false): void {
  const found = matches();
  if (!found.length) { findStatus.textContent = findInput.value ? 'No matches' : 'Enter search text'; return; }
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
  if (!found.length) { findStatus.textContent = 'No matches'; return; }
  const match = found.find(([start, end]) => start === field.selectionStart && end === field.selectionEnd)
    ?? found.find(([start]) => start >= field.selectionEnd) ?? found[0];
  editor.replaceRange(match[0], match[1], replaceInput.value);
  findStatus.textContent = 'Replaced 1 match';
  field.focus({ preventScroll: true });
});
document.querySelector<HTMLButtonElement>('#replace-all')!.addEventListener('click', () => {
  const found = matches();
  if (!found.length) { findStatus.textContent = 'No matches'; return; }
  const original = field.value;
  let result = '';
  let offset = 0;
  for (const [start, end] of found) {
    result += original.slice(offset, start) + replaceInput.value;
    offset = end;
  }
  result += original.slice(offset);
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
window.addEventListener('pagehide', () => { clearTimeout(saveTimer); persist(); });
showDraft();
updateStats();
