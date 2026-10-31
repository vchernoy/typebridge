import { Editor } from '../editor/editor';
import { replaceMatchAt } from '../editor/search';
import { CASE_KEY, FIND_KEY, REGEX_KEY, REPLACE_KEY, readSearchOption, readSearchText } from '../editor/search-settings';

/**
 * Find & Replace: query/replacement persistence, Match case/Regex options, transliterating
 * Find/Replace inputs, navigation (including zero-width matches) and Replace/Replace all.
 */
export function setupSearch(field: HTMLTextAreaElement, editor: Editor, enabled: HTMLInputElement): {
  findInput: HTMLInputElement;
  findEditor: Editor;
  replaceEditor: Editor;
  syncSearchEditors: () => void;
} {
  const findInput = document.querySelector<HTMLInputElement>('#find-text')!;
  const replaceInput = document.querySelector<HTMLInputElement>('#replace-text')!;
  const matchCase = document.querySelector<HTMLInputElement>('#match-case')!;
  const regexMode = document.querySelector<HTMLInputElement>('#regex-mode')!;
  const findStatus = document.querySelector<HTMLElement>('#find-status')!;
  const searchStorageWarning = document.createElement('span');
  searchStorageWarning.setAttribute('aria-live', 'polite');
  findStatus.before(searchStorageWarning);
  const failedSearchKeys = new Set<string>();
  function searchStorageResult(key: string, success: boolean): void {
    if (success) failedSearchKeys.delete(key); else failedSearchKeys.add(key);
    searchStorageWarning.textContent = failedSearchKeys.size ? 'Find settings could not be saved or restored in this browser.' : '';
  }
  for (const [input, key] of [[findInput, FIND_KEY], [replaceInput, REPLACE_KEY]] as const) {
    try { input.value = readSearchText(sessionStorage, key); } catch { searchStorageResult(key, false); }
    const save = (): void => {
      try { sessionStorage.setItem(key, input.value); searchStorageResult(key, true); }
      catch { searchStorageResult(key, false); }
    };
    input.addEventListener('input', save);
    input.addEventListener('compositionend', save);
  }
  for (const [input, key] of [[matchCase, CASE_KEY], [regexMode, REGEX_KEY]] as const) {
    try { input.checked = readSearchOption(localStorage, key); } catch { searchStorageResult(key, false); }
    input.addEventListener('change', () => {
      try { localStorage.setItem(key, String(input.checked)); searchStorageResult(key, true); }
      catch { searchStorageResult(key, false); }
    });
  }
  const findEditor = new Editor(findInput);
  const replaceEditor = new Editor(replaceInput);
  // Find and Replace follow the transliteration toggle in literal and Regex mode alike, so a
  // pattern can mix Russian letters with Latin syntax by toggling while typing (#102).
  function syncSearchEditors(): void {
    findEditor.setEnabled(enabled.checked);
    replaceEditor.setEnabled(enabled.checked);
  }
  syncSearchEditors();
  function searchPattern(): RegExp | null {
    const query = findInput.value;
    if (!query) { findStatus.textContent = ''; return null; }
    // `u` keeps matches, including zero-width ones, on code point boundaries.
    const flags = matchCase.checked ? 'gu' : 'giu';
    const escaped = Array.from(query, char => '\\^$.*+?()[]{}|'.includes(char) ? '\\' + char : char).join('');
    try {
      const pattern = new RegExp(regexMode.checked ? query : escaped, flags);
      findStatus.textContent = '';
      return pattern;
    } catch (error) {
      findStatus.textContent = 'Invalid regex: ' + (error instanceof Error ? error.message : String(error));
      return null;
    }
  }
  function matches(): Array<[number, number]> {
    const pattern = searchPattern();
    if (!pattern) return [];
    return Array.from(field.value.matchAll(pattern), m => [m.index, m.index + m[0].length]);
  }
  let lastZeroWidthMatch: { position: number; text: string; query: string; matchCase: boolean; regex: boolean } | undefined;
  function resetSearchPosition(): void { lastZeroWidthMatch = undefined; }
  // Caret moves and edits are caught by the position and text checks in findNext.
  field.addEventListener('input', resetSearchPosition);
  function findNext(backwards = false): void {
    const found = matches();
    if (!found.length) { if (!findStatus.textContent.startsWith('Invalid regex')) findStatus.textContent = findInput.value ? 'No matches' : 'Enter search text'; return; }
    const position = backwards ? field.selectionStart : field.selectionEnd;
    const skipCurrent = lastZeroWidthMatch?.position === position && field.selectionStart === field.selectionEnd &&
      lastZeroWidthMatch.text === field.value && lastZeroWidthMatch.query === findInput.value &&
      lastZeroWidthMatch.matchCase === matchCase.checked && lastZeroWidthMatch.regex === regexMode.checked;
    const match = backwards
      ? [...found].reverse().find(([start]) => start < position) ?? found[found.length - 1]
      : found.find(([start]) => skipCurrent ? start > position : start >= position) ?? found[0];
    field.focus({ preventScroll: true });
    field.setSelectionRange(match[0], match[1]);
    lastZeroWidthMatch = match[0] === match[1]
      ? { position: match[0], text: field.value, query: findInput.value, matchCase: matchCase.checked, regex: regexMode.checked }
      : undefined;
    editor.revealSelection();
    findStatus.textContent = `${found.length} match${found.length === 1 ? '' : 'es'}`;
  }
  document.querySelector<HTMLButtonElement>('#find-next')!.addEventListener('click', () => findNext());
  document.querySelector<HTMLButtonElement>('#find-prev')!.addEventListener('click', () => findNext(true));
  document.querySelector<HTMLButtonElement>('#replace-one')!.addEventListener('click', () => {
    const found = matches();
    if (!found.length) { if (!findStatus.textContent.startsWith('Invalid regex')) findStatus.textContent = 'No matches'; return; }
    const match = found.find(([start, end]) => start === field.selectionStart && end === field.selectionEnd)
      ?? found.find(([start]) => start >= field.selectionEnd) ?? found[0];
    const result = regexMode.checked
      ? replaceMatchAt(searchPattern()!, field.value, match[0], replaceInput.value)
      : { end: match[1], text: replaceInput.value };
    if (!result || result.end !== match[1]) return;
    editor.replaceRange(match[0], match[1], result.text);
    findStatus.textContent = 'Replaced 1 match';
    field.focus({ preventScroll: true });
  });
  document.querySelector<HTMLButtonElement>('#replace-all')!.addEventListener('click', () => {
    const pattern = searchPattern();
    if (!pattern) return;
    const original = field.value;
    const count = Array.from(original.matchAll(pattern)).length;
    if (!count) { findStatus.textContent = 'No matches'; return; }
    // Native substitution in regex mode; literal mode inserts the replacement text as is.
    const result = regexMode.checked ? original.replace(pattern, replaceInput.value) : original.replace(pattern, () => replaceInput.value);
    editor.replaceRange(0, original.length, result);
    findStatus.textContent = `Replaced ${count} matches`;
    field.focus({ preventScroll: true });
  });
  findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); findNext(event.shiftKey); }
  });
  return { findInput, findEditor, replaceEditor, syncSearchEditors };
}
