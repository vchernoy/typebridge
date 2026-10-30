import { describe, expect, it } from 'vitest';
import { lineColumnAtOffset, lineStarts, offsetForLineColumn, parseGotoInput } from '../src/editor/goto-line';

describe('parseGotoInput', () => {
  it('accepts line and optional column with colon or comma', () => {
    expect(parseGotoInput('12')).toEqual({ line: 12, column: undefined });
    expect(parseGotoInput(' 12:3 ')).toEqual({ line: 12, column: 3 });
    expect(parseGotoInput('12,4')).toEqual({ line: 12, column: 4 });
    expect(parseGotoInput('1:1')).toEqual({ line: 1, column: 1 });
  });

  it('rejects empty, zero, and malformed input', () => {
    expect(parseGotoInput('')).toBeNull();
    expect(parseGotoInput('0')).toBeNull();
    expect(parseGotoInput('1:0')).toBeNull();
    expect(parseGotoInput('ab')).toBeNull();
    expect(parseGotoInput('1:2:3')).toBeNull();
    expect(parseGotoInput('-2')).toBeNull();
  });
});

describe('lineStarts and offsets', () => {
  it('counts LF, CRLF and trailing empty lines', () => {
    expect(lineStarts('a\nb')).toEqual([0, 2]);
    expect(lineStarts('a\r\nb')).toEqual([0, 3]);
    expect(lineStarts('a\rb')).toEqual([0, 2]);
    expect(lineStarts('a\n')).toEqual([0, 2]);
    expect(lineStarts('')).toEqual([0]);
  });

  it('maps line and column with clamping', () => {
    const text = 'ab\ncde\n🙂x';
    expect(offsetForLineColumn(text, 1, 1)).toMatchObject({ offset: 0, line: 1, column: 1, lineCount: 3 });
    expect(offsetForLineColumn(text, 2, 2)).toMatchObject({ offset: 4, line: 2, column: 2 });
    expect(offsetForLineColumn(text, 2)).toMatchObject({ offset: 3, line: 2, column: 1 });
    expect(offsetForLineColumn(text, 99, 99)).toMatchObject({ offset: text.length, line: 3, column: 4 });
    // Columns use textarea UTF-16 offsets, so an emoji occupies two columns.
    expect(offsetForLineColumn(text, 3, 2)).toMatchObject({ offset: 8, line: 3, column: 2 });
    expect(offsetForLineColumn(text, 3, 3)).toMatchObject({ offset: text.indexOf('x'), line: 3, column: 3 });
  });

  it('reports line and column for an offset', () => {
    const text = 'ab\ncde\n';
    expect(lineColumnAtOffset(text, 0)).toEqual({ line: 1, column: 1, lineCount: 3 });
    expect(lineColumnAtOffset(text, 3)).toEqual({ line: 2, column: 1, lineCount: 3 });
    expect(lineColumnAtOffset(text, text.length)).toEqual({ line: 3, column: 1, lineCount: 3 });
  });
});
