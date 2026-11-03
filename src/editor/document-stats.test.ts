import { expect, test } from 'vitest';
import { countDocumentStats, formatDocumentStats } from './document-stats';

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
