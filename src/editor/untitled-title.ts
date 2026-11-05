import { UNTITLED_TITLE } from './drafts';

/**
 * #175 step 8: distinct default names for new documents.
 * First blank uses "Untitled document"; further ones "Untitled document 2", "3", …
 * Existing titles that match the pattern are skipped so New never collides.
 */
export function nextUntitledTitle(existingTitles: Iterable<string>): string {
  const taken = new Set<string>();
  for (const title of existingTitles) {
    const trimmed = title.trim();
    if (trimmed) taken.add(trimmed);
  }
  if (!taken.has(UNTITLED_TITLE)) return UNTITLED_TITLE;
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${UNTITLED_TITLE} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${UNTITLED_TITLE} ${Date.now()}`;
}
