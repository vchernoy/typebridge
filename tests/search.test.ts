import { describe, expect, it } from 'vitest';
import { expandReplacement } from '../src/editor/search';

describe('regex replacement contract', () => {
  for (const [original, pattern] of [
    ['before a after', /(a)/g],
    ['ab', /(a)(b)?(c)?/g],
    ['a', /(?<letter>a)(?<optional>b)?/g],
    ['abcdefghijkl', /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)(l)/g],
    ['🙂a', /(?=a)|$/g],
  ] as const) {
    it(`matches native substitution semantics for ${pattern}`, () => {
      for (const replacement of ['$$', '$&', '$`', "$'", '$0', '$00', '$01', '$09', '$1', '$12', '$19', '$20', '$99', '$123', '$<letter>', '$<optional>', '$<missing>', '$1:$2:$3']) {
        const matches = Array.from(original.matchAll(pattern));
        let offset = 0;
        let result = '';
        for (const match of matches) {
          result += original.slice(offset, match.index) + expandReplacement(replacement, match, original);
          offset = match.index + match[0].length;
        }
        result += original.slice(offset);
        expect(result, replacement).toBe(original.replace(pattern, replacement));
      }
    });
  }
});
