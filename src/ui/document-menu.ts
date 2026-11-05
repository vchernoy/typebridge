/**
 * Document menu (#123, step 3 / #175 step 8): the ▾ button next to the document title
 * opens a panel with search, the document list and New, Import, Export and Delete.
 * Escape, a click outside or an action closes it; Escape and actions return focus to ▾.
 * Picking a document with the pointer closes it; arrow keys in the list keep it open.
 */
import { registerEscapeLayer } from './escape-layers';

export function setupDocumentMenu(deps?: {
  /** Re-render the list when the search query changes (#175 step 8). */
  onSearch?: (query: string) => void;
}): void {
  const panel = document.querySelector<HTMLElement>('#doc-menu')!;
  const button = document.querySelector<HTMLButtonElement>('#doc-menu-open')!;
  const list = document.querySelector<HTMLSelectElement>('#drafts')!;
  const search = document.querySelector<HTMLInputElement>('#doc-search');
  function open(): void {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (search) {
      search.value = '';
      deps?.onSearch?.('');
      search.focus();
    } else {
      list.focus();
    }
  }
  function close(returnFocus: boolean): void {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (search) {
      search.value = '';
      deps?.onSearch?.('');
    }
    if (returnFocus) button.focus();
  }
  button.addEventListener('click', () => { if (panel.hidden) open(); else close(true); });
  registerEscapeLayer(panel, 20, () => close(true));
  document.addEventListener('pointerdown', event => {
    const target = event.target as Node | null;
    if (!panel.hidden && target && !panel.contains(target) && !button.contains(target)) close(false);
  });
  // An action hides the panel holding the focused button, so give focus back to ▾;
  // an action that opens a document may then move it to the editor itself.
  for (const action of panel.querySelectorAll<HTMLButtonElement>('.doc-actions button')) {
    action.addEventListener('click', () => close(true));
  }
  let pointerPick = false;
  list.addEventListener('pointerdown', () => { pointerPick = true; });
  list.addEventListener('keydown', () => { pointerPick = false; });
  list.addEventListener('change', () => { if (pointerPick) close(false); pointerPick = false; });
  search?.addEventListener('input', () => { deps?.onSearch?.(search.value); });
  search?.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      list.focus();
    }
  });
}
