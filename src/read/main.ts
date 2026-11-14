/**
 * Reading page for share links (#39): `/#doc=…` forwards here (inline script in index.html).
 * It looks like a plain read-only web page: the title, the text and a quiet label. Nothing is
 * stored until the reader chooses Edit a copy, which saves a new document and opens it in the
 * full editor. Source text is never parsed as HTML; only the lazy renderer’s sanitized output is inserted.
 */
import '../style.css';
import '../styles/read.css';
import { documentFormat } from '../editor/document-fields';
import { readingView } from './view';
import { newDraft } from '../editor/drafts';
import { commitOrCreateConflictCopy, openDraftDatabase } from '../editor/indexeddb';
import { decodeSharePayload, sharePayloadFromHash, type DecodeFailure, type SharedDocument } from '../editor/share-link';
import { createDocumentSignal, DOCUMENT_SIGNAL_CHANNEL } from '../view/signals';

const viewToggle = document.querySelector<HTMLButtonElement>('#read-view')!;
let live: ReturnType<typeof import('../view/active-renderer').renderDocument> | undefined;
let viewGeneration = 0;
function stopLive(): void { viewGeneration++; live?.destroy(); live = undefined; }

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
  stopLive(); viewToggle.hidden = true;
  document.title = 'Shared document · TypeBridge';
  title.textContent = 'This shared document cannot be opened';
  body.textContent = FAILURE_MESSAGES[reason];
  body.className = 'read-text read-text--message';
  // A notice from an earlier link (e.g. an unknown format) must not stay with this failure.
  notice.hidden = true;
  notice.textContent = '';
  editCopy.hidden = true;
}

function showDocument(shared: SharedDocument, knownFormat: boolean): void {
  const heading = shared.title.trim() || 'Untitled document';
  document.title = `${heading} · TypeBridge`;
  title.textContent = heading;
  let view = readingView(shared);
  const setView = async (): Promise<void> => {
    stopLive();
    const generation = viewGeneration;
    const rendered = view === 'rendered';
    viewToggle.textContent = rendered ? 'Show source' : 'Show page';
    body.className = rendered ? 'active-reading' : 'read-text';
    if (!rendered) { body.textContent = shared.text; return; }
    body.textContent = 'Rendering…';
    try {
      const { renderDocument } = await import('../view/active-renderer');
      if (generation !== viewGeneration) return;
      live = renderDocument(body, shared.text, navigator.language);
    } catch {
      if (generation === viewGeneration) body.textContent = 'Could not render this document. Choose Show source to read it.';
    }
  };
  viewToggle.hidden = shared.format !== 'markdown';
  viewToggle.onclick = () => { view = view === 'rendered' ? 'source' : 'rendered'; void setView(); };
  void setView();
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

// Local Markdown anchors must not replace the fragment carrying the share payload.
body.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest<HTMLAnchorElement>('a[href^="#"]');
  if (!anchor || !body.contains(anchor)) return;
  event.preventDefault();
  let id: string;
  try {
    id = decodeURIComponent(anchor.hash.slice(1));
  } catch {
    return;
  }
  const target = Array.from(body.querySelectorAll("[id]")).find((element) => element.id === id);
  target?.scrollIntoView();
});

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
      const copy = { ...newDraft(shared.text), format: documentFormat(shared), title: shared.title.trim() || newDraft().title };
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

/** Bumped on every render: a slow decode of an earlier link must not replace a newer one. */
let renderGeneration = 0;
async function render(): Promise<void> {
  stopLive(); viewToggle.hidden = true;
  const generation = ++renderGeneration;
  const hash = location.hash;
  // Never leave the previous document's Edit a copy armed while another link decodes.
  editCopy.hidden = true;
  editCopy.onclick = null;
  const result = await decodeSharePayload(sharePayloadFromHash(hash));
  if (generation !== renderGeneration || location.hash !== hash) return;
  if (result.ok) showDocument(result.document, result.knownFormat);
  else showFailure(result.reason);
}

// Back from the editor can restore this page from the back-forward cache mid-"Saving a copy…":
// the copy was saved and opened, so make the page usable again (#246 review).
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  saving = false;
  editCopy.disabled = false;
  status.textContent = '';
  void render();
});
// Pasting another share link into the address bar only changes the fragment.
window.addEventListener('pagehide', stopLive);
window.addEventListener('hashchange', () => { status.textContent = ''; void render(); });
void render();
