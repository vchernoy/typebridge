import { describe, expect, it, test } from 'vitest';
import { countCodePoints, countDocumentStats, formatDocumentStats } from './document-stats';

test('formatDocumentStats uses singular forms for one (#156)', () => {
  expect(formatDocumentStats('a')).toBe('1 character · 1 word · 1 min read');
  expect(formatDocumentStats('привет')).toBe('6 characters · 1 word · 1 min read');
});

test('formatDocumentStats uses plural forms for zero and many (#156)', () => {
  expect(formatDocumentStats('')).toBe('0 characters · 0 words · 0 min read');
  expect(formatDocumentStats('one two')).toBe('7 characters · 2 words · 1 min read');
});

test('countDocumentStats keeps hyphenated and apostrophe words together', () => {
  expect(countDocumentStats("well-known it's")).toEqual({ characters: 15, words: 2, minutes: 1 });
});

describe('countCodePoints', () => {
  it('matches Array.from for emoji, combining marks, Cyrillic and lone surrogates', () => {
    for (const text of ['', 'abc', 'Привет', '🙂', 'a🙂b', '👩‍💻', 'é', '\ud83d', '\ude42', 'x\ud83dy', '\ude42\ud83d', '🙂\ud83d', 'Ёж 🙂\n\tтекст']) {
      expect(countCodePoints(text)).toBe(Array.from(text).length);
    }
  });
});
