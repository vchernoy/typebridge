/** User-perceived character boundaries (emoji, combining marks, surrogate pairs) for caret moves and deletes. */
/** Start of the user-perceived character before `pos` (emoji, combining marks, surrogate pairs). */
export function previousCharacterBoundary(text: string, pos: number): number {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    let boundary = 0;
    for (const { index } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(0, pos))) boundary = index;
    return boundary;
  }
  const low = text.charCodeAt(pos - 1);
  const high = text.charCodeAt(pos - 2);
  return pos >= 2 && low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? pos - 2 : pos - 1;
}
/** End of the user-perceived character starting at `pos`. */
export function nextCharacterBoundary(text: string, pos: number): number {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) {
    const first = new Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(pos))[Symbol.iterator]().next();
    return first.done ? pos : pos + first.value.segment.length;
  }
  const high = text.charCodeAt(pos);
  const low = text.charCodeAt(pos + 1);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? pos + 2 : pos + 1;
}
