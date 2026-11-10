/** Options that shape a Find query (#35, #46, #62). */
export type SearchOptions = { matchCase: boolean; regex: boolean };

/**
 * The RegExp for a Find query, or the reason it is invalid. Literal queries escape regex
 * punctuation. `u` keeps matches, including zero-width ones, on code point boundaries;
 * without Match case, matching is JavaScript case-insensitive (`i`): simple one-to-one case
 * mapping, no Unicode normalization and no multi-character folds (see docs/SEARCH.md).
 */
export function buildSearchPattern(query: string, options: SearchOptions): { pattern: RegExp } | { error: string } | null {
  if (!query) return null;
  const flags = options.matchCase ? 'gu' : 'giu';
  const escaped = Array.from(query, char => '\\^$.*+?()[]{}|'.includes(char) ? '\\' + char : char).join('');
  try {
    return { pattern: new RegExp(options.regex ? query : escaped, flags) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Every match of `pattern` in `text` as UTF-16 [start, end) offsets, in order. */
export function findMatches(text: string, pattern: RegExp): Array<[number, number]> {
  return Array.from(text.matchAll(pattern), m => [m.index, m.index + m[0].length]);
}

/** Find bar text after Replace all. */
export function replacedAllStatus(count: number): string {
  return `Replaced ${count} match${count === 1 ? '' : 'es'}`;
}

/**
 * Replace the single match of `pattern` that starts at `index`, using native
 * String.prototype.replace substitution ($$, $&, $`, $', $n, $<name>) so that
 * Replace matches Replace All exactly. Returns null when no match starts there.
 */
export function replaceMatchAt(pattern: RegExp, original: string, index: number, replacement: string): { end: number; text: string } | null {
  const sticky = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '') + 'y');
  sticky.lastIndex = index;
  const match = sticky.exec(original);
  if (!match) return null;
  const end = index + match[0].length;
  sticky.lastIndex = index;
  const replaced = original.replace(sticky, replacement);
  return { end, text: replaced.slice(index, replaced.length - (original.length - end)) };
}
