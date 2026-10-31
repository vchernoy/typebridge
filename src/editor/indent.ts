/** One indentation unit. Spaces survive pasting into social posts better than tab characters. */
export const INDENT_UNIT = '    ';

export type IndentEdit = { start: number; end: number; text: string; selectionStart: number; selectionEnd: number };

/**
 * Tab/Shift+Tab editing for a textarea value (#56). A caret Tab inserts one unit;
 * a selection indents every line it touches; Shift+Tab removes up to one unit
 * (a tab or up to `unit.length` spaces) from the start of each touched line.
 * Returns the range to replace and the selection afterwards, or null when
 * nothing changes. A selection ending at the start of a line excludes that line.
 */
export function indentEdit(value: string, selStart: number, selEnd: number, outdent: boolean, unit = INDENT_UNIT): IndentEdit | null {
  if (!outdent && selStart === selEnd) {
    const caret = selStart + unit.length;
    return { start: selStart, end: selStart, text: unit, selectionStart: caret, selectionEnd: caret };
  }
  const first = value.lastIndexOf('\n', selStart - 1) + 1;
  const lastPos = selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd;
  const lastBreak = value.indexOf('\n', Math.max(lastPos, first));
  const last = lastBreak === -1 ? value.length : lastBreak;
  const lines = value.slice(first, last).split('\n');
  const changes: { lineStart: number; added: number; removed: number }[] = [];
  let offset = first;
  const text = lines.map(line => {
    const lineStart = offset;
    offset += line.length + 1;
    if (!outdent) {
      // Leave empty lines alone when indenting several lines.
      if (!line && lines.length > 1) return line;
      changes.push({ lineStart, added: unit.length, removed: 0 });
      return unit + line;
    }
    const removed = line.startsWith('\t') ? 1 : line.length - line.replace(new RegExp(`^ {1,${unit.length}}`), '').length;
    if (removed) changes.push({ lineStart, added: 0, removed });
    return line.slice(removed);
  }).join('\n');
  if (!changes.length) return null;
  const map = (p: number): number => {
    let mapped = p;
    for (const { lineStart, added, removed } of changes) {
      if (added && lineStart < p) mapped += added;
      if (removed) mapped -= Math.min(removed, Math.max(0, p - lineStart));
    }
    return mapped;
  };
  return { start: first, end: last, text, selectionStart: map(selStart), selectionEnd: map(selEnd) };
}
