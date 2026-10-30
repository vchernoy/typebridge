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
