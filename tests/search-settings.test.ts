import { describe, expect, it } from 'vitest';
import { CASE_KEY, FIND_KEY, REPLACE_KEY, clearLegacySearchText, readSearchOption } from '../src/editor/search-settings';

describe('search settings', () => {
  it('uses a safe default for missing or invalid options', () => {
    const fake = { getItem: () => 'corrupt' } as unknown as Storage;
    expect(readSearchOption(fake, CASE_KEY)).toBe(false);
  });
  it('restores explicitly enabled options and Unicode text', () => {
    const fake = { getItem: (key: string) => key === CASE_KEY ? 'true' : 'ёж 🙂' } as unknown as Storage;
    expect(readSearchOption(fake, CASE_KEY)).toBe(true);
  });
});

it('removes obsolete search-content keys without removing settings or document reload backups', () => {
  const map = new Map([[FIND_KEY, 'old find'], [REPLACE_KEY + '::w:main', 'old replacement'], [CASE_KEY, 'true'], ['typebridge.pendingDraft.v1', '{document backup}']]);
  clearLegacySearchText({ get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, removeItem: key => { map.delete(key); } } as Storage);
  expect([...map.entries()]).toEqual([[CASE_KEY, 'true'], ['typebridge.pendingDraft.v1', '{document backup}']]);
});
