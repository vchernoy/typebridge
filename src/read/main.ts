/**
 * Reading page for share links (#39): `/#doc=…` forwards here (inline script in index.html).
 * It looks like a plain read-only web page: the title, the text and a quiet label. Nothing is
 * stored until the reader chooses Edit a copy, which saves a new document and opens it in the
 * full editor. The shared text is always written with textContent, never parsed as HTML.
 */
import '../style.css';
import '../styles/read.css';
import { newDraft } from '../editor/drafts';
import { commitOrCreateConflictCopy, openDraftDatabase } from '../editor/indexeddb';
import { decodeSharePayload, sharePayloadFromHash, type DecodeFailure, type SharedDocument } from '../editor/share-link';
import { createDocumentSignal, DOCUMENT_SIGNAL_CHANNEL } from '../view/signals';

const title = document.querySelector<HTMLElement>('#read-title')!;
const notice = document.querySelector<HTMLElement>('#read-notice')!;
const body = document.querySelector<HTMLElement>('#read-text')!;
const status = document.querySelector<HTMLElement>('#read-status')!;
const editCopy = document.querySelector<HTMLButtonElement>('#edit-copy')!;

/** What to tell the reader when a link cannot be opened. */
const FAILURE_MESSAGES: Record<DecodeFailure, string> = {
  missing: 'This link does not contain a shared document.',
  version: 'This link was made by a newer version of TypeBridge. Reload this page to update, then open the link again.',
  'too-large': 'This shared document is too large to open.',
  malformed: 'This link is incomplete or damaged. Messengers sometimes cut long links; ask the sender to share it again.',
};

function showFailure(reason: DecodeFailure): void {
  document.title = 'Shared document · TypeBridge';
  title.textContent = 'This shared document cannot be opened';
  body.textContent = FAILURE_MESSAGES[reason];
  body.classList.add('read-text--message');
  editCopy.hidden = true;
}

function showDocument(shared: SharedDocument, knownFormat: boolean): void {
  const heading = shared.title.trim() || 'Untitled document';
  document.title = `${heading} · TypeBridge`;
  title.textContent = heading;
  // Plain text is shown exactly as written; v1 renders no other format (#244).
  body.textContent = shared.text;
  body.classList.remove('read-text--message');
  if (!knownFormat) {
    notice.textContent = `This document uses a format this version of TypeBridge cannot show yet (“${shared.format}”). Showing its text as written.`;
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
  editCopy.hidden = !shared.edit;
  editCopy.onclick = () => { void saveCopy(shared); };
}

let saving = false;
/** Save the shared text as a new document (never overwriting one), then open it in the editor. */
async function saveCopy(shared: SharedDocument): Promise<void> {
  if (saving) return;
  saving = true;
  editCopy.disabled = true;
  status.textContent = 'Saving a copy…';
  try {
    const db = await openDraftDatabase();
    try {
      const copy = { ...newDraft(shared.text), title: shared.title.trim() || newDraft().title };
      const result = await commitOrCreateConflictCopy(db, copy, 0, crypto.randomUUID());
      try {
        const channel = new BroadcastChannel(DOCUMENT_SIGNAL_CHANNEL);
        channel.postMessage(createDocumentSignal('saved', result.draft.id, result.draft.revision, Date.now()));
        channel.close();
      } catch { /* Open windows reread their list on focus anyway. */ }
      location.assign('/?open=' + encodeURIComponent(result.draft.id));
    } finally {
      db.close();
    }
  } catch {
    status.textContent = 'Could not save a copy: browser storage is unavailable here. You can still select and copy the text.';
    editCopy.disabled = false;
    saving = false;
  }
}

async function render(): Promise<void> {
  const result = await decodeSharePayload(sharePayloadFromHash(location.hash));
  if (result.ok) showDocument(result.document, result.knownFormat);
  else showFailure(result.reason);
}

// Pasting another share link into the address bar only changes the fragment.
window.addEventListener('hashchange', () => { status.textContent = ''; void render(); });
void render();
