import { describe, expect, it } from 'vitest';
import { buildSearchPattern, findMatches, replacedAllStatus, type SearchOptions } from './search';

const literal: SearchOptions = { matchCase: false, regex: false };
function count(query: string, text: string, options: SearchOptions = literal): number {
  const built = buildSearchPattern(query, options);
  if (!built || 'error' in built) throw new Error('no pattern');
  return findMatches(text, built.pattern).length;
}

describe('Find case policy (#62)', () => {
  it('ignores case for English and Russian unless Match case is on', () => {
    expect(count('hello', 'Hello HELLO hello')).toBe(3);
    expect(count('привет', 'Привет ПРИВЕТ привет')).toBe(3);
    expect(count('ёлка', 'ЁЛКА Ёлка ёлка')).toBe(3);
    expect(count('hello', 'Hello HELLO hello', { matchCase: true, regex: false })).toBe(1);
    expect(count('привет', 'Привет ПРИВЕТ привет', { matchCase: true, regex: false })).toBe(1);
  });
  it('applies the same policy in Regex mode', () => {
    expect(count('прив\\S+', 'Привет ПРИВЕТ', { matchCase: false, regex: true })).toBe(2);
    expect(count('прив\\S+', 'Привет ПРИВЕТ', { matchCase: true, regex: true })).toBe(0);
    expect(count('\\p{Lu}', 'Ёж и Еж', { matchCase: true, regex: true })).toBe(2);
  });
  it('matches mixed-script text and emoji', () => {
    expect(count('Привет world', 'ПРИВЕТ WORLD')).toBe(1);
    expect(count('🙂', 'a🙂b🙂')).toBe(2);
  });
});

describe('documented Unicode limits (docs/SEARCH.md)', () => {
  it('treats Е and Ё as different letters', () => {
    expect(count('елка', 'ёлка')).toBe(0);
    expect(count('ёлка', 'елка')).toBe(0);
  });
  it('does not normalize composed and decomposed text', () => {
    expect(count('é', 'é')).toBe(0);
    expect(count('é', 'é')).toBe(0);
  });
  it('uses simple one-to-one case folding only', () => {
    expect(count('ß', 'SS')).toBe(0); // no multi-character fold
    expect(count('ß', 'ẞ')).toBe(1); // capital sharp s folds to ß
    expect(count('σ', 'ς')).toBe(1); // final sigma
    expect(count('k', 'K')).toBe(1); // Kelvin sign
    expect(count('i', 'İ')).toBe(0); // no Turkish dotted capital I
    expect(count('I', 'ı')).toBe(0); // no Turkish dotless i
  });
});

describe('literal queries and invalid patterns', () => {
  it('escapes regex punctuation in literal mode', () => {
    expect(count('a.b', 'a.b axb')).toBe(1);
    expect(count('(1+1)?', 'x (1+1)? y')).toBe(1);
  });
  it('reports an invalid regex instead of throwing', () => {
    const built = buildSearchPattern('(', { matchCase: false, regex: true });
    expect(built && 'error' in built).toBe(true);
    expect(buildSearchPattern('', literal)).toBeNull();
  });
});

describe('replacedAllStatus', () => {
  it('uses the singular for one match', () => {
    expect(replacedAllStatus(1)).toBe('Replaced 1 match');
    expect(replacedAllStatus(2)).toBe('Replaced 2 matches');
  });
});
