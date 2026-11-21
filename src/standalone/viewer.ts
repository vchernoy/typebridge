import { renderDocument } from '../view/active-renderer';
import { keepShareFragment } from '../read/local-anchors';
import { decodeDocument } from './document';

const status = document.querySelector<HTMLElement>('#status')!;
const root = document.querySelector<HTMLElement>('#document')!;
try {
  const value = decodeDocument(document.querySelector('#standalone-data')?.textContent ?? '');
  document.title = value.title || 'Exported document';
  document.querySelector('#title')!.textContent = value.title;
  if (value.format === 'plain') {
    const pre = document.createElement('pre'); pre.textContent = value.text; root.append(pre);
  } else {
    const live = renderDocument(root, value.text, navigator.language);
    const reset = document.querySelector<HTMLButtonElement>('#reset')!;
    reset.hidden = false; reset.addEventListener('click', () => live.resetInputs());
    window.addEventListener('pagehide', event => { if (!event.persisted) live.destroy(); });
    if (live.messages.length) status.textContent = 'Some source expressions have rendering problems.';
  }
  keepShareFragment(root);
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href]:not([href^="#"])')) {
    link.target = '_blank'; link.rel = 'noopener noreferrer';
  }
  if (!status.textContent) status.hidden = true;
} catch {
  status.textContent = 'No valid document. Open export-demo.html to create an exported file from the template.';
}
