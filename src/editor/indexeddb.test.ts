import { describe, expect, it } from 'vitest';
import { parseLegacyDrafts } from './indexeddb';

describe('legacy draft validation', () => {
  it('preserves Unicode and undo metadata', () => {
    const draft = { id: 'a', title: 'Запись', text: 'Привет 🙂', updatedAt: 1, history: { undo: [] } };
    expect(parseLegacyDrafts(JSON.stringify([draft]))).toEqual([draft]);
  });
  it('rejects malformed collections and duplicate IDs without filtering', () => {
    const draft = { id: 'same', title: 'a', text: 'keep', updatedAt: 1 };
    expect(() => parseLegacyDrafts('{')).toThrow();
    expect(() => parseLegacyDrafts(JSON.stringify([draft, { id: 'bad' }]))).toThrow();
    expect(() => parseLegacyDrafts(JSON.stringify([draft, { ...draft, text: 'other' }]))).toThrow(/duplicate/i);
  });
});
