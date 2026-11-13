/** Match case / Regex stay app-wide settings. Search content is document data (#257 2b). */
export const FIND_KEY = 'typebridge.find.query.v1';
export const REPLACE_KEY = 'typebridge.find.replace.v1';
export const CASE_KEY = 'typebridge.find.matchCase.v1';
export const REGEX_KEY = 'typebridge.find.regex.v1';

/** Remove obsolete content keys (including scoped Replace); no content migration. */
export function clearLegacySearchText(storage: Storage): void {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key === FIND_KEY || key?.startsWith(FIND_KEY + '::') || key === REPLACE_KEY || key?.startsWith(REPLACE_KEY + '::')) storage.removeItem(key);
  }
}
export function readSearchOption(storage: Storage, key: string): boolean {
  return storage.getItem(key) === 'true';
}
