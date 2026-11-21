/**
 * First-run welcome (#390): a first visit with no saved documents shows a working example
 * instead of an empty editor. The example runs in the storage-free embed reader, so looking
 * at it writes nothing; only **Make my copy** saves it, as a normal Markdown document.
 */
import exampleSource from './welcome-example.md?raw';
import { ACTIVE_DRAFT_KEY_BASE, newDraft } from '../editor/drafts';
import { listStoredDrafts, openDraftDatabase, reuseOrCreateSharedCopy } from '../editor/indexeddb';
import { encodeSharePayload } from '../editor/share-link';
import { sharedCopyFields } from '../editor/shared-copy';
import { scopeSessionKey } from '../view/window-id';
import { sharedCopyRecoveryExclusions } from '../read/shared-copy-recovery';

/** Set once the visitor has made a choice (or already has documents); a preference, kept by Clear. */
export const WELCOME_SEEN_KEY = 'typebridge.welcomeSeen.v1';
export const WELCOME_EXAMPLE_TITLE = 'Which phone plan is cheaper?';
export const WELCOME_EXAMPLE_SOURCE = exampleSource;
/** The main window's Edit/Preview preference (view/markdown-view.ts), so the copy opens rendered. */
const MAIN_VIEW_KEY = scopeSessionKey('typebridge.documentView.v1', 'main');
/** One-shot, this tab only: the copy Make my copy is opening (see consumeWelcomeCopy). */
const WELCOME_COPY_KEY = 'typebridge.welcomeCopy.v1';

function seen(): boolean {
  try { return localStorage.getItem(WELCOME_SEEN_KEY) === '1'; } catch { return true; }
}
function markSeen(): void {
  try { localStorage.setItem(WELCOME_SEEN_KEY, '1'); } catch { /* Shown again next visit. */ }
}

/** Whether this browser has any saved document; unknown (storage failure) counts as yes. */
async function hasDocuments(): Promise<boolean> {
  try {
    const db = await openDraftDatabase();
    try { return (await listStoredDrafts(db)).length > 0; } finally { db.close(); }
  } catch {
    return true;
  }
}

/** Save the example as a new Markdown document (or reuse an identical unowned one). */
async function makeCopy(): Promise<string> {
  const db = await openDraftDatabase();
  try {
    const fields = sharedCopyFields({ title: WELCOME_EXAMPLE_TITLE, text: WELCOME_EXAMPLE_SOURCE, format: 'markdown' });
    const result = await reuseOrCreateSharedCopy(db, { ...newDraft(fields.text), ...fields }, sharedCopyRecoveryExclusions());
    return result.draft.id;
  } finally {
    db.close();
  }
}

/**
 * Show the welcome when this is a first visit: not seen before and no saved documents.
 * Resolves once it is shown or skipped; never throws.
 */
/**
 * Called first thing by the host on `/?open=<id>`. When this tab's Make my copy is opening that
 * id, drop what the welcome visit recorded for its blank placeholder (the window layout and the
 * main window's remembered document), so the host's first-visit path loads the copy into the main
 * window instead of beside an empty one. The placeholder was never saved. Only the tab that made
 * the copy holds the token, so a crafted link cannot reset anyone's windows.
 */
export function consumeWelcomeCopy(openId: string | null): void {
  let token: string | null;
  try { token = sessionStorage.getItem(WELCOME_COPY_KEY); sessionStorage.removeItem(WELCOME_COPY_KEY); } catch { return; }
  if (!token || token !== openId) return;
  try {
    for (const key of Object.keys(localStorage)) {
      if (key === 'typebridge.host.windows.v1' || key.startsWith('typebridge.host.windows.v1.')) localStorage.removeItem(key);
    }
  } catch { /* The copy then opens in a second window. */ }
  try { sessionStorage.removeItem(scopeSessionKey(ACTIVE_DRAFT_KEY_BASE, 'main')); } catch { /* As above. */ }
}

export async function maybeShowWelcome(): Promise<void> {
  if (seen()) return;
  if (await hasDocuments()) { markSeen(); return; }
  if (seen()) return; // Another tab chose meanwhile.
  const encoded = await encodeSharePayload({ title: WELCOME_EXAMPLE_TITLE, text: WELCOME_EXAMPLE_SOURCE, format: 'markdown', view: 'rendered', edit: false });
  if (!encoded.ok) return;

  const dialog = document.createElement('dialog');
  dialog.id = 'welcome-dialog';
  dialog.className = 'welcome-dialog';
  dialog.setAttribute('aria-labelledby', 'welcome-title');
  dialog.setAttribute('aria-describedby', 'welcome-intro');
  const title = document.createElement('h2');
  title.id = 'welcome-title';
  title.textContent = 'Write documents that calculate';
  const intro = document.createElement('p');
  intro.id = 'welcome-intro';
  intro.textContent = 'This example is a TypeBridge document. Move the slider or change a price: the bills and the verdict update. Make your own copy to see how it is written, or start with a blank document.';
  const frame = document.createElement('iframe');
  frame.className = 'welcome-example';
  frame.title = 'Example: ' + WELCOME_EXAMPLE_TITLE;
  frame.src = '/embed.html#doc=' + encoded.payload;
  const status = document.createElement('p');
  status.className = 'welcome-status';
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'welcome-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.id = 'welcome-copy';
  copy.textContent = 'Make my copy';
  const blank = document.createElement('button');
  blank.type = 'button';
  blank.id = 'welcome-blank';
  blank.textContent = 'Start with a blank document';
  actions.append(copy, blank);
  dialog.append(title, intro, frame, status, actions);

  // While Make my copy is saving, the dialog cannot be dismissed: the save then always ends
  // either in opening the copy or in an error shown here, never after the visitor chose blank.
  let saving = false;
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    markSeen();
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  const dismiss = (): void => { if (!saving) finish(); };
  blank.addEventListener('click', dismiss);
  // Escape is the same as Start with a blank document, also while focus is in the example.
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  // Browsers may close a modal on a repeated Escape despite cancel being prevented (close
  // watcher rules). Keep it open while saving; any other close is the blank choice.
  dialog.addEventListener('close', () => {
    if (done) return;
    if (saving) { dialog.showModal(); return; }
    finish();
  });
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow?.addEventListener('keydown', event => {
        if (event.key === 'Escape' && dialog.open) { event.preventDefault(); dismiss(); }
      });
    } catch { /* Same-origin embed; Escape outside the frame still works. */ }
  });
  copy.addEventListener('click', () => {
    if (saving) return;
    saving = true;
    copy.disabled = true;
    blank.disabled = true;
    status.textContent = 'Saving your copy…';
    void makeCopy().then(id => {
      try { sessionStorage.setItem(MAIN_VIEW_KEY, 'rendered'); } catch { /* Opens in Edit instead. */ }
      try { sessionStorage.setItem(WELCOME_COPY_KEY, id); } catch { /* Opens beside the blank window. */ }
      finish();
      // The host's Edit a copy path (main.ts) opens it in the main window and reports it.
      location.assign('/?open=' + encodeURIComponent(id));
    }, () => {
      saving = false;
      copy.disabled = false;
      blank.disabled = false;
      status.textContent = 'Could not save a copy in this browser. You can still start with a blank document.';
    });
  });
  document.body.append(dialog);
  dialog.showModal();
  copy.focus();
}
