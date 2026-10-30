import { describe, expect, it } from 'vitest';
import { replaceMatchAt } from '../src/editor/search';

describe('single-match replacement', () => {
  for (const [original, pattern] of [
    ['before a after', /(a)/gu],
    ['ab', /(a)(b)?(c)?/gu],
    ['a', /(?<letter>a)(?<optional>b)?/gu],
    ['abcdefghijkl', /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)/gu],
    ['🙂a', /(?=a)|$/gu],
    ['🙂🙂', /x*/gu],
    ['xa', /(?<=x)a/gu],
  ] as const) {
    it(`matches native Replace All substitution for ${pattern}`, () => {
      for (const replacement of ['$$', '$&', '$`', "$'", '$0', '$00', '$01', '$09', '$1', '$12', '$19', '$20', '$99', '$123', '$<letter>', '$<optional>', '$<missing>', '$<>', '$<x$1>', '$<', '$1:$2:$3']) {
        let offset = 0;
        let result = '';
        for (const match of original.matchAll(pattern)) {
          const replaced = replaceMatchAt(pattern, original, match.index, replacement)!;
          expect(replaced.end, replacement).toBe(match.index + match[0].length);
          result += original.slice(offset, match.index) + replaced.text;
          offset = replaced.end;
        }
        result += original.slice(offset);
        expect(result, replacement).toBe(original.replace(pattern, replacement));
      }
    });
  }

  it('returns null when no match starts at the index', () => {
    expect(replaceMatchAt(/a/gu, 'ba', 0, 'x')).toBeNull();
  });
});
