/**
 * Find and Go to line bars (#123): they open on demand from their toolbar buttons or with
 * Cmd/Ctrl+F and Cmd/Ctrl+G, one at a time; Escape or × closes a bar and returns to the
 * editor. The search engine itself is set up by ui/search.ts.
 */
import type { Editor } from '../editor/editor';
import { offsetForLineColumn, parseGotoInput } from '../editor/goto-line';
import { SHORTCUTS } from '../editor/keyboard-shortcuts';
import { FIND_KEY } from '../editor/search-settings';
import { registerEscapeLayer } from './escape-layers';

export type FindGotoDeps = {
  field: HTMLTextAreaElement;
  editor: Editor;
  findInput: HTMLInputElement;
  findEditor: Editor;
  showMatchCount: () => void;
  /** Leave Focus mode before showing a bar (bars are hidden in Focus). */
  leaveFocusMode: () => void;
  updateCaretPosition: () => void;
};

export function setupFindGotoBars(deps: FindGotoDeps): { openFind: () => void; openGoto: () => void } {
  const gotoInput = document.querySelector<HTMLInputElement>('#goto-line')!;
  const gotoStatus = document.querySelector<HTMLElement>('#goto-status')!;
  // Find and Go to line open on demand (#123): from their toolbar buttons or with
  // Cmd/Ctrl+F and Cmd/Ctrl+G. One bar at a time; Escape or × closes it and returns to the editor.
  const findBar = document.querySelector<HTMLElement>('#find-bar')!;
  const gotoBar = document.querySelector<HTMLElement>('#goto-bar')!;
  const findOpen = document.querySelector<HTMLButtonElement>('#find-open')!;
  const gotoOpen = document.querySelector<HTMLButtonElement>('#goto-open')!;
  function setBar(bar: HTMLElement, button: HTMLButtonElement, open: boolean): void {
    bar.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  }
  function openFind(): void {
    deps.leaveFocusMode();
    setBar(gotoBar, gotoOpen, false);
    setBar(findBar, findOpen, true);
    // Re-read the shared last search so another window's query is visible immediately.
    try {
      const shared = sessionStorage.getItem(FIND_KEY);
      if (shared !== null && deps.findInput.value !== shared) {
        deps.findInput.value = shared;
        deps.findEditor.syncFromField();
      }
    } catch { /* Optional restore. */ }
    deps.showMatchCount();
    deps.findInput.focus();
    deps.findInput.select();
  }
  function openGoto(): void {
    deps.leaveFocusMode();
    setBar(findBar, findOpen, false);
    setBar(gotoBar, gotoOpen, true);
    gotoInput.focus();
    gotoInput.select();
  }
  function closeBar(bar: HTMLElement, button: HTMLButtonElement): void {
    setBar(bar, button, false);
    deps.field.focus({ preventScroll: true });
  }
  findOpen.addEventListener('click', () => { if (findBar.hidden) openFind(); else closeBar(findBar, findOpen); });
  gotoOpen.addEventListener('click', () => { if (gotoBar.hidden) openGoto(); else closeBar(gotoBar, gotoOpen); });
  document.querySelector<HTMLButtonElement>('#find-close')!.addEventListener('click', () => closeBar(findBar, findOpen));
  document.querySelector<HTMLButtonElement>('#goto-close')!.addEventListener('click', () => closeBar(gotoBar, gotoOpen));
  for (const [bar, button] of [[findBar, findOpen], [gotoBar, gotoOpen]] as const) {
    registerEscapeLayer(bar, 10, () => closeBar(bar, button));
  }
  function goToLine(): void {
    const parsed = parseGotoInput(gotoInput.value);
    if (!parsed) {
      gotoStatus.textContent = gotoInput.value.trim() ? 'Use line or line:column' : 'Enter a line number';
      return;
    }
    const surface = deps.field;
    const surfaceEditor = deps.editor;
    const target = offsetForLineColumn(surface.value, parsed.line, parsed.column ?? 1);
    surface.focus({ preventScroll: true });
    surface.setSelectionRange(target.offset, target.offset);
    surfaceEditor.revealSelection();
    deps.updateCaretPosition();
    gotoStatus.textContent = target.line === parsed.line && (parsed.column === undefined || target.column === parsed.column)
      ? `Line ${target.line}, column ${target.column}`
      : `Clamped to line ${target.line}, column ${target.column}`;
  }
  document.querySelector<HTMLButtonElement>('#goto-go')!.addEventListener('click', goToLine);
  gotoInput.addEventListener('keydown', event => {
    // Skip IME confirmation Enter; composition must not navigate (#88 review).
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.repeat || event.isComposing || event.defaultPrevented) return;
    event.preventDefault();
    goToLine();
  });
  document.addEventListener('keydown', event => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat || event.isComposing) return;
    const key = event.key.toLowerCase();
    if (key === SHORTCUTS.find.key && !event.shiftKey) {
      event.preventDefault(); openFind();
    } else if (key === SHORTCUTS.goto.key && !event.shiftKey) {
      // Cmd/Ctrl+G: go to line. May also be reserved by the browser's Find UI.
      event.preventDefault();
      openGoto();
    }
  });
  return { openFind, openGoto };
}
