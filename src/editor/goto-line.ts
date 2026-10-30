/** 1-based line and optional column from user input such as `12`, `12:3` or `12,3`. */
export function parseGotoInput(raw: string): { line: number; column: number | undefined } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^(\d+)\s*(?:[:,]\s*(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const line = Number(match[1]);
  const column = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1)) return null;
  return { line, column };
}

/** UTF-16 offsets of each logical line start (`\n`, `\r\n`, or lone `\r`). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      starts.push(i + 1);
    } else if (ch === '\n') starts.push(i + 1);
  }
  return starts;
}

function lineContentEnd(text: string, starts: number[], lineIndex: number): number {
  if (lineIndex + 1 >= starts.length) return text.length;
  const next = starts[lineIndex + 1];
  if (text[next - 1] === '\n') return text[next - 2] === '\r' ? next - 2 : next - 1;
  if (text[next - 1] === '\r') return next - 1;
  return next;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Move a UTF-16 offset off the middle of a surrogate pair so inserts cannot
 * split an emoji or other non-BMP character. Mid-pair offsets snap forward
 * to after the pair (still within document bounds).
 */
export function snapToCodePointBoundary(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  if (
    clamped > 0 &&
    clamped < text.length &&
    isHighSurrogate(text.charCodeAt(clamped - 1)) &&
    isLowSurrogate(text.charCodeAt(clamped))
  ) {
    return clamped + 1;
  }
  return clamped;
}

/**
 * Map a 1-based line/column to a textarea UTF-16 caret offset.
 * Out-of-range lines clamp to the last line; columns clamp to the end of that line.
 * The returned offset is never in the middle of a surrogate pair.
 */
export function offsetForLineColumn(
  text: string,
  line: number,
  column = 1
): { offset: number; line: number; column: number; lineCount: number } {
  const starts = lineStarts(text);
  const lineCount = starts.length;
  const targetLine = Math.min(Math.max(1, line), lineCount);
  const start = starts[targetLine - 1];
  const end = lineContentEnd(text, starts, targetLine - 1);
  const maxColumn = end - start + 1;
  const targetColumn = Math.min(Math.max(1, column), maxColumn);
  const offset = snapToCodePointBoundary(text, start + (targetColumn - 1));
  return { offset, line: targetLine, column: offset - start + 1, lineCount };
}

/** 1-based line/column for a UTF-16 offset (clamped to the document). */
export function lineColumnAtOffset(
  text: string,
  offset: number
): { line: number; column: number; lineCount: number } {
  const starts = lineStarts(text);
  const lineCount = starts.length;
  const clamped = Math.max(0, Math.min(offset, text.length));
  let lineIndex = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    if (starts[i] <= clamped) { lineIndex = i; break; }
  }
  return { line: lineIndex + 1, column: clamped - starts[lineIndex] + 1, lineCount };
}
