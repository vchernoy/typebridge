import { SHORTCUTS } from '../editor/keyboard-shortcuts';
import { Editor } from '../editor/editor';
import { replaceMatchAt } from '../editor/search';
import { CASE_KEY, FIND_KEY, REGEX_KEY, REPLACE_KEY, readSearchOption, readSearchText } from '../editor/search-settings';

export type SearchTarget = { field: HTMLTextAreaElement; editor: Editor };

/**
 * Find & Replace: query/replacement persistence, Match case/Regex options, transliterating
 * Find/Replace inputs, navigation (including zero-width matches) and Replace/Replace all.
 * Find follows `getFindTarget` (any visible active pane). Replace uses the same
 * target after `canMutate` so read-only companions stay protected.
 */
export function setupSearch(
  primary: SearchTarget,
  enabled: HTMLInputElement,
  options: {
    canMutate?: () => boolean;
    getFindTarget?: () => SearchTarget;
    /** Editor surfaces whose edits refresh the open Find match total (active pane may change). */
    matchSurfaces?: HTMLTextAreaElement[];
    /** sessionStorage keys for Find/Replace text (#175 window scoping). */
    findTextKey?: string;
    replaceTextKey?: string;
  } = {},
): {
  findInput: HTMLInputElement;
  findEditor: Editor;
  replaceEditor: Editor;
  syncSearchEditors: () => void;
  showMatchCount: () => void;
  resetOptions: () => boolean;
} {
  const field = primary.field;
  const canMutate = options.canMutate ?? (() => true);
  const getFindTarget = options.getFindTarget ?? (() => primary);
  const matchSurfaces = options.matchSurfaces ?? [field];
  const findInput = document.querySelector<HTMLInputElement>('#find-text')!;
  const replaceInput = document.querySelector<HTMLInputElement>('#replace-text')!;
  const matchCase = document.querySelector<HTMLInputElement>('#match-case')!;
  const regexMode = document.querySelector<HTMLInputElement>('#regex-mode')!;
  const findStatus = document.querySelector<HTMLElement>('#find-status')!;
  const findBar = document.querySelector<HTMLElement>('#find-bar')!;
  const searchStorageWarning = document.createElement('span');
  searchStorageWarning.setAttribute('aria-live', 'polite');
  findStatus.before(searchStorageWarning);
  const failedSearchKeys = new Set<string>();
  function searchStorageResult(key: string, success: boolean): void {
    if (success) failedSearchKeys.delete(key); else failedSearchKeys.add(key);
    searchStorageWarning.textContent = failedSearchKeys.size ? 'Find settings could not be saved or restored in this browser.' : '';
  }
  const findTextKey = options.findTextKey ?? FIND_KEY;
  const replaceTextKey = options.replaceTextKey ?? REPLACE_KEY;
  for (const [input, key] of [[findInput, findTextKey], [replaceInput, replaceTextKey]] as const) {
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
  function matches(text: string): Array<[number, number]> {
    const pattern = searchPattern();
    if (!pattern) return [];
    return Array.from(text.matchAll(pattern), m => [m.index, m.index + m[0].length]);
  }
  let lastZeroWidthMatch: {
    field: HTMLTextAreaElement;
    position: number;
    text: string;
    query: string;
    matchCase: boolean;
    regex: boolean;
  } | undefined;
  function resetSearchPosition(): void { lastZeroWidthMatch = undefined; }
  // Caret moves and edits are caught by the position and text checks in findNext.
  for (const surface of matchSurfaces) surface.addEventListener('input', resetSearchPosition);
  function findNext(backwards = false): void {
    const target = getFindTarget();
    const found = matches(target.field.value);
    if (!found.length) { if (!findStatus.textContent.startsWith('Invalid regex')) findStatus.textContent = findInput.value ? 'No matches' : 'Enter search text'; return; }
    const position = backwards ? target.field.selectionStart : target.field.selectionEnd;
    // Zero-width skip state is per pane: mirrored text alone must not skip the first hit.
    const skipCurrent = lastZeroWidthMatch?.field === target.field && lastZeroWidthMatch.position === position
      && target.field.selectionStart === target.field.selectionEnd
      && lastZeroWidthMatch.text === target.field.value && lastZeroWidthMatch.query === findInput.value
      && lastZeroWidthMatch.matchCase === matchCase.checked && lastZeroWidthMatch.regex === regexMode.checked;
    const match = backwards
      ? [...found].reverse().find(([start]) => start < position) ?? found[found.length - 1]
      : found.find(([start]) => skipCurrent ? start > position : start >= position) ?? found[0];
    target.field.focus({ preventScroll: true });
    target.field.setSelectionRange(match[0], match[1]);
    lastZeroWidthMatch = match[0] === match[1]
      ? {
        field: target.field,
        position: match[0],
        text: target.field.value,
        query: findInput.value,
        matchCase: matchCase.checked,
        regex: regexMode.checked,
      }
      : undefined;
    target.editor.revealSelection();
    findStatus.textContent = `${found.indexOf(match) + 1} of ${found.length}`;
  }
  function showMatchCount(): void {
    // Closed Find must not scan on every keystroke — retained regex queries can
    // catastrophic-backtrack and freeze typing (#140 Codex P2).
    if (findBar.hidden || findBar.getClientRects().length === 0) return;
    // Do not reset zero-width skip state here: openFind/Ctrl+F refreshes totals and
    // must keep advancing past the current zero-width hit (#140 review P1).
    const found = matches(getFindTarget().field.value);
    if (findStatus.textContent.startsWith('Invalid regex')) return;
    findStatus.textContent = !findInput.value ? '' : found.length
      ? `${found.length} match${found.length === 1 ? '' : 'es'}` : 'No matches';
  }
  findInput.addEventListener('input', showMatchCount);
  for (const surface of matchSurfaces) surface.addEventListener('input', showMatchCount);
  for (const input of [matchCase, regexMode]) input.addEventListener('change', showMatchCount);
  // Sibling host windows share FIND_KEY; pick up live updates without reload (#175 step 9).
  if (findTextKey === FIND_KEY) {
    window.addEventListener('storage', event => {
      if (event.storageArea !== sessionStorage || event.key !== FIND_KEY) return;
      const next = event.newValue ?? '';
      if (findInput.value === next) return;
      findInput.value = next;
      // Drop pending transliteration from the previous local query (#175 Codex P2).
      findEditor.syncFromField();
      showMatchCount();
    });
  }
  document.querySelector<HTMLButtonElement>('#find-next')!.addEventListener('click', () => findNext());
  document.querySelector<HTMLButtonElement>('#find-prev')!.addEventListener('click', () => findNext(true));
  document.querySelector<HTMLButtonElement>('#replace-one')!.addEventListener('click', () => {
    if (!canMutate()) return;
    const target = getFindTarget();
    const found = matches(target.field.value);
    if (!found.length) { if (!findStatus.textContent.startsWith('Invalid regex')) findStatus.textContent = 'No matches'; return; }
    const match = found.find(([start, end]) => start === target.field.selectionStart && end === target.field.selectionEnd)
      ?? found.find(([start]) => start >= target.field.selectionEnd) ?? found[0];
    const result = regexMode.checked
      ? replaceMatchAt(searchPattern()!, target.field.value, match[0], replaceInput.value)
      : { end: match[1], text: replaceInput.value };
    if (!result || result.end !== match[1]) return;
    target.editor.replaceRange(match[0], match[1], result.text);
    findStatus.textContent = 'Replaced 1 match';
    target.field.focus({ preventScroll: true });
  });
  document.querySelector<HTMLButtonElement>('#replace-all')!.addEventListener('click', () => {
    if (!canMutate()) return;
    const target = getFindTarget();
    const pattern = searchPattern();
    if (!pattern) return;
    const original = target.field.value;
    const count = Array.from(original.matchAll(pattern)).length;
    if (!count) { findStatus.textContent = 'No matches'; return; }
    // Native substitution in regex mode; literal mode inserts the replacement text as is.
    const result = regexMode.checked ? original.replace(pattern, replaceInput.value) : original.replace(pattern, () => replaceInput.value);
    target.editor.replaceRange(0, original.length, result);
    findStatus.textContent = `Replaced ${count} matches`;
    target.field.focus({ preventScroll: true });
  });
  findInput.addEventListener('keydown', event => {
    if (event.key === SHORTCUTS.nextMatch.key && !event.metaKey && !event.ctrlKey) { event.preventDefault(); findNext(event.shiftKey); }
  });
  function resetOptions(): boolean {
    let saved = true;
    for (const [input, key] of [[regexMode, REGEX_KEY], [matchCase, CASE_KEY]] as const) {
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      try { if (readSearchOption(localStorage, key)) saved = false; }
      catch { searchStorageResult(key, false); saved = false; }
    }
    return saved;
  }
  return { findInput, findEditor, replaceEditor, syncSearchEditors, showMatchCount, resetOptions };
}
