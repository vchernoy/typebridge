/**
 * Document menu (#123, step 3): the ▾ button next to the document title opens a panel
 * with the document list and New, Import, Export and Delete. Escape, a click outside
 * or an action closes it; Escape and actions return focus to ▾. Picking a document with the pointer closes it; arrow keys in
 * the list keep it open so keyboard users can move through documents.
 */
import { registerEscapeLayer } from './escape-layers';

export function setupDocumentMenu(): void {
  const panel = document.querySelector<HTMLElement>('#doc-menu')!;
  const button = document.querySelector<HTMLButtonElement>('#doc-menu-open')!;
  const list = document.querySelector<HTMLSelectElement>('#drafts')!;
  function open(): void {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    list.focus();
  }
  function close(returnFocus: boolean): void {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
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
}
