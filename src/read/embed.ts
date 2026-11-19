/** Standalone, storage-free shared-document iframe. Never runs authored JavaScript. */
import '../style.css';
import '../styles/read.css';
import './embed.css';
import { decodeSharePayload, sharePayloadFromHash } from '../editor/share-link';

const heading = document.querySelector<HTMLElement>('#embed-title')!;
const content = document.querySelector<HTMLElement>('#embed-content')!;
let mounted: ReturnType<typeof import('../view/active-renderer').renderDocument> | undefined;
let generation = 0;

async function render(): Promise<void> {
  const current = ++generation;
  mounted?.destroy();
  mounted = undefined;
  heading.hidden = true;
  content.className = 'read-text';
  content.textContent = 'Opening document…';
  const result = await decodeSharePayload(sharePayloadFromHash(location.hash), { inputSnapshots: true });
  if (current !== generation) return;
  if (!result.ok) {
    content.textContent = result.reason === 'too-large' ? 'This document is too large to open.' : 'This shared document cannot be opened.';
    return;
  }
  const doc = result.document;
  document.title = (doc.title.trim() || 'Untitled document') + ' · TypeBridge';
  heading.textContent = doc.title.trim() || 'Untitled document';
  heading.hidden = doc.heading === false;
  if (doc.format !== 'markdown') {
    content.textContent = doc.text;
    return;
  }
  content.className = 'active-reading';
  try {
    const { renderDocument } = await import('../view/active-renderer');
    if (current !== generation) return;
    mounted = renderDocument(content, doc.text, navigator.language, doc.inputs ? new Map(doc.inputs.values) : undefined);
    await mounted.settled();
  } catch {
    if (current !== generation) return;
    mounted?.destroy();
    mounted = undefined;
    content.className = 'read-text';
    content.textContent = doc.text;
  }
}
window.addEventListener('hashchange', () => { void render(); });
window.addEventListener('pagehide', () => { ++generation; mounted?.destroy(); });
void render();
