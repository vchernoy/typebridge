import { describe, expect, it } from 'vitest';
import { effectivePack, exportRules, importRules, validateOverrides } from './custom-rules';
import { createTransliterator } from './transliterate';

describe('custom rules', () => {
  it('overrides defaults and preserves longest matches', () => {
    const convert = createTransliterator(effectivePack({ w: 'в', sh: 'ж' }));
    expect(convert('w sh shch')).toBe('в ж щ');
  });
  it('roundtrips portable JSON and rejects malformed settings', () => {
    expect(importRules(exportRules({ w: 'в' }))).toEqual({ w: 'в' });
    expect(() => validateOverrides({ sh: '' })).toThrow();
    expect(() => validateOverrides({ W: 'в' })).toThrow();
    expect(() => importRules('{"version":2,"overrides":{}}')).toThrow();
  });
});
