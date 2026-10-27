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
field.addEventListener('input', () => { count.textContent = `${Array.from(field.value).length} characters`; });
enabled.addEventListener('change', () => { editor.setEnabled(enabled.checked); });
document.querySelector<HTMLButtonElement>('#copy')!.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(field.value); status.textContent = 'Copied'; }
  catch { field.focus(); field.select(); status.textContent = 'Copy unavailable. Text selected; use your device’s copy command.'; }
});
document.querySelector<HTMLButtonElement>('#clear')!.addEventListener('click', () => {
  if (field.value && window.confirm('Clear the text? You can undo this action.')) { editor.clear(); field.focus(); status.textContent = 'Cleared'; }
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
  draftTitle.value = active.title;
  renderDrafts();
}
function persist(): void {
  if (!autosave.checked) return;
  active = { ...active, text: field.value, title: draftTitle.value.trim() || 'Untitled draft', updatedAt: Date.now() };
  try { saveDraft(active); status.textContent = 'Saved locally'; renderDrafts(); }
  catch { status.textContent = 'Save failed — check browser storage'; }
}
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(): void {
  clearTimeout(saveTimer);
  if (autosave.checked) { status.textContent = 'Saving…'; saveTimer = setTimeout(persist, 300); }
}
field.addEventListener('input', scheduleSave);
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
