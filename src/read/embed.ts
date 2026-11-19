/** Standalone, storage-free shared-document iframe. Never runs authored JavaScript. */
import '../style.css';
import '../styles/read.css';
import './embed.css';
import { decodeSharePayload, sharePayloadFromHash, type DecodeFailure } from '../editor/share-link';
import { keepShareFragment } from './local-anchors';
import { readingView } from './view';

const heading = document.querySelector<HTMLElement>('#embed-title')!;
const content = document.querySelector<HTMLElement>('#embed-content')!;
const notice = document.querySelector<HTMLElement>('#embed-notice')!;
let mounted: ReturnType<typeof import('../view/active-renderer').renderDocument> | undefined;
let generation = 0;

const FAILURE_MESSAGES: Record<DecodeFailure, string> = {
  missing: 'This shared document cannot be opened.',
  version: 'This document was made by a newer version of TypeBridge. Reload this page to update.',
  'too-large': 'This document is too large to open.',
  malformed: 'This shared document cannot be opened.',
};

// Local anchors scroll inside the frame; any other link opens outside it, never inside the frame.
keepShareFragment(content);
content.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
  if (!anchor || !content.contains(anchor) || anchor.getAttribute('href')?.startsWith('#')) return;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
});

function showNotice(text: string | undefined): void {
  notice.textContent = text ?? '';
  notice.hidden = !text;
}

async function render(): Promise<void> {
  const current = ++generation;
  mounted?.destroy();
  mounted = undefined;
  heading.hidden = true;
  showNotice(undefined);
  content.className = 'read-text';
  content.textContent = 'Opening document…';
  const result = await decodeSharePayload(sharePayloadFromHash(location.hash), { inputSnapshots: true });
  if (current !== generation) return;
  if (!result.ok) {
    content.textContent = FAILURE_MESSAGES[result.reason];
    return;
  }
  const doc = result.document;
  const title = doc.title.trim() || 'Untitled document';
  document.title = title + ' · TypeBridge';
  heading.textContent = title;
  heading.hidden = doc.heading === false;
  if (!result.knownFormat) {
    showNotice(`This document uses a format this version of TypeBridge cannot show yet (“${doc.format}”). Showing its text as written.`);
  }
  // Same rule as the reading page: only Markdown shared for rendering is rendered.
  if (readingView(doc) !== 'rendered') {
    content.textContent = doc.text;
    return;
  }
  content.className = 'active-reading';
  try {
    const { renderDocument, renderTitle } = await import('../view/active-renderer');
    if (current !== generation) return;
    if (doc.heading !== false && title.includes('$')) renderTitle(heading, title);
    mounted = renderDocument(content, doc.text, navigator.language, doc.inputs ? new Map(doc.inputs.values) : undefined);
    await mounted.settled();
  } catch {
    if (current !== generation) return;
    mounted?.destroy();
    mounted = undefined;
    content.className = 'read-text';
    content.textContent = doc.text;
    showNotice('Could not render this document. Showing its text as written.');
  }
}
window.addEventListener('hashchange', () => { void render(); });
window.addEventListener('pagehide', () => { ++generation; mounted?.destroy(); });
void render();
