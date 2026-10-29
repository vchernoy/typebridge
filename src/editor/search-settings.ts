/** Search text is tab-scoped; options are separate profile preferences. */
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
