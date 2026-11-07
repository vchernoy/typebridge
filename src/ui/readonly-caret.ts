import { nextCharacterBoundary, previousCharacterBoundary } from '../editor/characters';

/**
 * Caret keys in a read-only text input. Browsers (Chromium) ignore Home/End/arrows there,
 * but a title waiting for editing to move to its window still needs a caret the user can
 * place before typing (#175 follow-up). Pure selection change: the value never changes.
 */
export function moveReadOnlyCaret(input: HTMLInputElement, event: KeyboardEvent): boolean {
  if (!input.readOnly || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
  const length = input.value.length;
  const start = input.selectionStart ?? length;
  const end = input.selectionEnd ?? length;
  const backward = input.selectionDirection === 'backward';
  const focus = backward ? start : end;
  const anchor = backward ? end : start;
  let next: number;
  if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = length;
  // Step whole characters, so the caret never lands inside an emoji or surrogate pair.
  else if (event.key === 'ArrowLeft') next = !event.shiftKey && start !== end ? start : focus > 0 ? previousCharacterBoundary(input.value, focus) : 0;
  else if (event.key === 'ArrowRight') next = !event.shiftKey && start !== end ? end : focus < length ? nextCharacterBoundary(input.value, focus) : length;
  else return false;
  event.preventDefault();
  if (event.shiftKey) {
    if (next < anchor) input.setSelectionRange(next, anchor, 'backward');
    else input.setSelectionRange(anchor, next, 'forward');
  } else {
    input.setSelectionRange(next, next);
  }
  return true;
}
