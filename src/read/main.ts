import { openShareDialog } from '../ui/share-dialog';
import { inspectInputSnapshot } from '../editor/input-snapshot';
import { prepareSharedInputs } from './shared-inputs';
import { setupSharedEdit } from './edit-shared';
import { setupRememberShared } from './remember-shared';
/**
 * Reading page for share links (#39): `/#doc=…` forwards here (inline script in index.html).
 * It shows the title, text and a quiet Edit link. Valid links are remembered locally when permitted.
 * Edit reuses a safe exact copy or saves a new document and opens it in the
 * full editor. Source text is never parsed as HTML; only the lazy renderer’s sanitized output is inserted.
 */
import '../style.css';
import '../styles/read.css';
import { readingView } from './view';
import { keepShareFragment } from './local-anchors';
import { decodeSharePayload, sharePayloadFromHash, type DecodeFailure, type SharedDocument } from '../editor/share-link';

let live: ReturnType<typeof import('../view/active-renderer').renderDocument> | undefined;
let inputs: Awaited<ReturnType<typeof prepareSharedInputs>> | undefined;
let viewGeneration = 0;
let currentShared: SharedDocument | undefined;
let readyToShare = false;
let sharing = false;
const shareButton = document.querySelector<HTMLButtonElement>('#read-share')!;
let focusInputReset: string | undefined;
function stopLive(): void { readyToShare = false; shareButton.hidden = true; document.querySelector('#reader-input-state')?.setAttribute('hidden', ''); viewGeneration++; inputs?.destroy(); inputs = undefined; live?.destroy(); live = undefined; }

const title = document.querySelector<HTMLElement>('#read-title')!;
const notice = document.querySelector<HTMLElement>('#read-notice')!;
const body = document.querySelector<HTMLElement>('#read-text')!;
const status = document.querySelector<HTMLElement>('#read-status')!;
const editCopy = document.querySelector<HTMLAnchorElement>('#edit-copy')!;
const editActions = setupSharedEdit({ edit: editCopy, status,
  actions: document.querySelector<HTMLElement>('#read-edit-actions')!,
  check: document.querySelector<HTMLButtonElement>('#check-owner-status')!,
  copy: document.querySelector<HTMLButtonElement>('#create-new-copy')!,
});

/** What to tell the reader when a link cannot be opened. */
const FAILURE_MESSAGES: Record<DecodeFailure, string> = {
  missing: 'This link does not contain a shared document.',
  version: 'This link was made by a newer version of TypeBridge. Reload this page to update, then open the link again.',
  'too-large': 'This shared document is too large to open.',
  malformed: 'This link is incomplete or damaged. Messengers sometimes cut long links; ask the sender to share it again.',
};

function showFailure(reason: DecodeFailure): void {
  stopLive();
  document.title = 'Shared document · TypeBridge';
  title.classList.remove('visually-hidden');
  title.textContent = 'This shared document cannot be opened';
  body.textContent = FAILURE_MESSAGES[reason];
  body.className = 'read-text read-text--message';
  // A notice from an earlier link (e.g. an unknown format) must not stay with this failure.
  notice.hidden = true;
  notice.textContent = '';
  editCopy.hidden = true;
}

function showDocument(shared: SharedDocument, knownFormat: boolean, ready?: Promise<void>): void {
  const heading = shared.title.trim() || 'Untitled document';
  document.title = `${heading} · TypeBridge`;
  title.textContent = heading;
  title.classList.toggle('visually-hidden', shared.heading === false);
  const view = readingView(shared);
  const setView = async (): Promise<void> => {
    stopLive();
    const generation = viewGeneration;
    currentShared = shared;
    const rendered = view === 'rendered';
    body.className = rendered ? 'active-reading' : 'read-text';
    document.querySelector<HTMLElement>('#reader-input-state')!.hidden = true;
    if (!rendered) { body.textContent = shared.text; readyToShare = true; shareButton.hidden = false; return; }
    body.textContent = 'Rendering…';
    try {
      const { renderDocument } = await import('../view/active-renderer');
      if (generation !== viewGeneration) return;
      const attachment = await prepareSharedInputs(sharePayloadFromHash(location.hash) ?? '', ready,
        () => generation === viewGeneration, remembered.canStoreInputs, {
          panel: document.querySelector<HTMLElement>('#reader-input-state')!, status: document.querySelector<HTMLElement>('#reader-input-status')!,
          reset: document.querySelector<HTMLButtonElement>('#reader-input-reset')!, load: document.querySelector<HTMLButtonElement>('#reader-input-load')!,
          keep: document.querySelector<HTMLButtonElement>('#reader-input-keep')!,
        }, () => { focusInputReset = location.hash; void render(); }, shared.inputs);
      if (generation !== viewGeneration) { attachment.destroy(); return; }
      inputs = attachment;
      const stage = document.createElement('div'); stage.style.visibility = 'hidden'; body.replaceChildren(stage);
      const mounted = renderDocument(stage, shared.text, navigator.language, attachment.initialInputs);
      live = mounted;
      await mounted.settled();
      if (generation !== viewGeneration) return;
      attachment.bind(mounted); stage.style.removeProperty('visibility');
      readyToShare = true; shareButton.hidden = false;
      if (focusInputReset === location.hash && document.activeElement === document.body) document.querySelector<HTMLButtonElement>('#reader-input-reset')!.focus({ preventScroll: true });
      focusInputReset = undefined;
    } catch {
      if (generation === viewGeneration) {
        inputs?.destroy(); inputs = undefined; live?.destroy(); live = undefined;
        document.querySelector<HTMLElement>('#reader-input-state')!.hidden = true;
        body.className = 'read-text';
        body.textContent = shared.text;
        readyToShare = true; shareButton.hidden = false;
        notice.textContent = 'Could not render this document. Showing its text as written.';
        notice.hidden = false;
      }
    }
  };
  void setView();
  if (shared.heading !== false && knownFormat && shared.format === 'markdown' && heading.includes('$')) {
    const generation = viewGeneration;
    void import('../view/active-renderer').then(({ renderTitle }) => {
      if (generation === viewGeneration) renderTitle(title, heading);
    }).catch(() => { /* The plain title already provides the fallback. */ });
  }
  body.classList.remove('read-text--message');
  if (!knownFormat) {
    notice.textContent = `This document uses a format this version of TypeBridge cannot show yet (“${shared.format}”). Showing its text as written.`;
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
  editActions.show(shared);
}

// Capture accepted runtime values synchronously; never consult a saved row or mutate the URL.
shareButton.addEventListener('click', () => {
  if (sharing || !readyToShare || !currentShared) return;
  sharing = true;
  const generation = viewGeneration;
  const hash = location.hash;
  const shared = currentShared;
  const accepted = live && inspectInputSnapshot({ version: 1, values: [...live.session.inputValues()] });
  void openShareDialog({ surface: () => ({ ...shared,
    inputs: accepted && accepted.ok ? accepted.snapshot : undefined }),
    editLocked: !shared.edit,
    base: () => new URL('/', location.href).toString(), returnFocus: () => shareButton, current: () => generation === viewGeneration && hash === location.hash })
    .finally(() => { sharing = false; });
});

// Local Markdown anchors must not replace the fragment carrying the share payload.
keepShareFragment(body);

const remembered = setupRememberShared(() => { editActions.pause(); stopLive(); });

/** Bumped on every render: a slow decode of an earlier link must not replace a newer one. */
let renderGeneration = 0;
async function render(): Promise<void> {
  stopLive();
  const generation = ++renderGeneration;
  const hash = location.hash;
  if (focusInputReset !== hash) focusInputReset = undefined;
  editActions.show(undefined, hash);
  remembered.show();
  // Never leave the previous document's Edit a copy armed while another link decodes.
  editCopy.hidden = true;

  const result = await decodeSharePayload(sharePayloadFromHash(hash), { inputSnapshots: true });
  if (generation !== renderGeneration || location.hash !== hash) return;
  if (result.ok) { const ready = remembered.show(sharePayloadFromHash(hash)); showDocument(result.document, result.knownFormat, ready); }
  else showFailure(result.reason);
}

// Back from the editor can restore this page from the back-forward cache mid-"Saving a copy…":
// the copy was saved and opened, so make the page usable again (#246 review).
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  editCopy.removeAttribute('aria-disabled');
  status.textContent = '';
  void render();
});
// Pasting another share link into the address bar only changes the fragment.
window.addEventListener('pagehide', stopLive);
window.addEventListener('hashchange', () => { status.textContent = ''; void render(); });
void render();
