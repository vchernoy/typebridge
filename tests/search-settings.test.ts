import { describe, expect, it } from 'vitest';
import { CASE_KEY, FIND_KEY, readSearchOption, readSearchText } from '../src/editor/search-settings';

describe('search settings', () => {
  it('uses a safe default for missing or invalid options', () => {
    const fake = { getItem: () => 'corrupt' } as unknown as Storage;
    expect(readSearchOption(fake, CASE_KEY)).toBe(false);
    expect(readSearchText({ getItem: () => null } as unknown as Storage, FIND_KEY)).toBe('');
  });
  it('restores explicitly enabled options and Unicode text', () => {
    const fake = { getItem: (key: string) => key === CASE_KEY ? 'true' : 'ёж 🙂' } as unknown as Storage;
    expect(readSearchOption(fake, CASE_KEY)).toBe(true);
    expect(readSearchText(fake, FIND_KEY)).toBe('ёж 🙂');
  });
});
