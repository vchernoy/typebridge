import { describe, expect, it } from 'vitest';
import { readerStorageAllowed, rememberPreference } from './shared-library';
describe('reader persistence policy', () => {
  it('requires successful reads of both gates, including after a previous non-private result', () => {
    const saved = { getItem: () => null };
    expect(readerStorageAllowed(saved)).toBe(true);
    expect(readerStorageAllowed({ getItem: () => { throw new Error('Denied'); } })).toBe(false);
    for (const off of ['typebridge.autosave.v1', 'typebridge.rememberShared.v1']) {
      expect(readerStorageAllowed({ getItem: key => key === off ? 'off' : null })).toBe(false);
    }
  });
  it('keeps remembering enabled by default but fails closed if its preference cannot be read', () => {
    expect(rememberPreference({ getItem: () => null })).toBe(true);
    expect(rememberPreference({ getItem: () => 'off' })).toBe(false);
    expect(rememberPreference({ getItem: () => { throw new Error('Denied'); } })).toBe(false);
  });
});
