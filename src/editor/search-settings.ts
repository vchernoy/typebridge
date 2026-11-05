/**
 * Find query is shared across all windows in the tab (#175 step 9).
 * Replace text stays per-window via scopeSessionKey(REPLACE_KEY, windowId).
 * Match case / Regex are profile preferences in localStorage.
 */
export const FIND_KEY = 'typebridge.find.query.v1';
export const REPLACE_KEY = 'typebridge.find.replace.v1';
export const CASE_KEY = 'typebridge.find.matchCase.v1';
export const REGEX_KEY = 'typebridge.find.regex.v1';

export function readSearchText(storage: Storage, key: string): string {
  return storage.getItem(key) ?? '';
}
export function readSearchOption(storage: Storage, key: string): boolean {
  return storage.getItem(key) === 'true';
}
