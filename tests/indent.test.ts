import { describe, expect, it } from 'vitest';
import { INDENT_UNIT as U, indentEdit } from '../src/editor/indent';

function run(value: string, start: number, end: number, outdent: boolean) {
  const edit = indentEdit(value, start, end, outdent);
  if (!edit) return null;
  return { value: value.slice(0, edit.start) + edit.text + value.slice(edit.end), selection: [edit.selectionStart, edit.selectionEnd] };
}

describe('indentEdit', () => {
  it('inserts one unit at a caret', () => {
    expect(run('Привет', 3, 3, false)).toEqual({ value: 'При' + U + 'вет', selection: [3 + U.length, 3 + U.length] });
  });
  it('indents every selected line and keeps the selection on the same text', () => {
    const value = 'один\nдва\nтри';
    expect(run(value, 1, 6, false)).toEqual({ value: U + 'один\n' + U + 'два\nтри', selection: [1 + U.length, 6 + 2 * U.length] });
  });
  it('does not indent the line after a selection that ends at its start', () => {
    expect(run('a\nb\nc', 0, 2, false)).toEqual({ value: U + 'a\nb\nc', selection: [0, 2 + U.length] });
  });
  it('leaves empty lines alone in a multi-line indent', () => {
    expect(run('a\n\nb', 0, 4, false)?.value).toBe(U + 'a\n\n' + U + 'b');
  });
  it('outdents the caret line by up to one unit, a tab, or fewer spaces', () => {
    expect(run(U + U + 'x', 9, 9, true)).toEqual({ value: U + 'x', selection: [5, 5] });
    expect(run('\tx', 2, 2, true)).toEqual({ value: 'x', selection: [1, 1] });
    expect(run('  x', 0, 0, true)).toEqual({ value: 'x', selection: [0, 0] });
  });
  it('outdents each selected line and never deletes non-indentation text', () => {
    expect(run(U + 'a\nb\n  c', 0, 9 + U.length - 4, true)?.value).toBe('a\nb\nc');
  });
  it('returns null when there is nothing to outdent', () => {
    expect(indentEdit('plain', 2, 2, true)).toBeNull();
  });
  it('keeps surrogate pairs and the last line intact', () => {
    expect(run('🙂\n🙂', 0, 5, false)?.value).toBe(U + '🙂\n' + U + '🙂');
  });
});
