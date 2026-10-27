import { describe, expect, it } from 'vitest';
import { createTransliterator } from '../src/core/transliterate';
import { russianPack } from '../src/core/russian';

describe('incremental mapping examples', () => {
  const convert = createTransliterator(russianPack);
  it('recomputes a growing input sequence for multi-letter mappings', () => {
    expect(['s','sh','shc','shch'].map(convert)).toEqual(['с','ш','шц','щ']);
  });
});
