/**
 * Document menu (#123, step 3): the ▾ button next to the document title opens a panel
 * with the document list and New, Import, Export and Delete. Escape, a click outside
 * or an action closes it. Picking a document with the pointer closes it; arrow keys in
 * the list keep it open so keyboard users can move through documents.
 */
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
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.isComposing || event.repeat || event.defaultPrevented) return;
    // Marked handled so the page's Escape handler does not also toggle Focus mode.
    event.preventDefault();
    close(true);
  });
  document.addEventListener('pointerdown', event => {
    const target = event.target as Node | null;
    if (!panel.hidden && target && !panel.contains(target) && !button.contains(target)) close(false);
  });
  for (const action of panel.querySelectorAll<HTMLButtonElement>('.doc-actions button')) {
    action.addEventListener('click', () => close(false));
  }
  let pointerPick = false;
  list.addEventListener('pointerdown', () => { pointerPick = true; });
  list.addEventListener('keydown', () => { pointerPick = false; });
  list.addEventListener('change', () => { if (pointerPick) close(false); pointerPick = false; });
}
