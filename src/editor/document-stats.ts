/** Word and character counts for the status bar (#156). */
export function countDocumentStats(value: string): { characters: number; words: number; minutes: number } {
  const characters = Array.from(value).length;
  const words = (value.match(/[\p{L}\p{N}]+(?:['’\u2010-\u2015-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 180));
  return { characters, words, minutes };
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Human-readable count line with singular/plural forms (#156). */
export function formatDocumentStats(value: string): string {
  const { characters, words, minutes } = countDocumentStats(value);
  return `${pluralize(characters, 'character', 'characters')} · ${pluralize(words, 'word', 'words')} · ${minutes} min read`;
}
