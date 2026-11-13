import { afterEach, expect, it, vi } from 'vitest';
import { ACTIVE_DRAFT_KEY_BASE, clearActiveDraftId, configureActiveDraftKey, setActiveDraftId } from './drafts';

afterEach(() => { configureActiveDraftKey(ACTIVE_DRAFT_KEY_BASE); vi.unstubAllGlobals(); });
it('clears only this window’s active hint and permits normal recording again after saving', () => {
  const data = new Map<string, string>([[ACTIVE_DRAFT_KEY_BASE + '::other', 'other-doc']]);
  vi.stubGlobal('sessionStorage', { setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  const key = ACTIVE_DRAFT_KEY_BASE + '::main'; configureActiveDraftKey(key);
  setActiveDraftId('new-private'); clearActiveDraftId();
  expect(data.has(key)).toBe(false); expect(data.get(ACTIVE_DRAFT_KEY_BASE + '::other')).toBe('other-doc');
  setActiveDraftId('saved'); expect(data.get(key)).toBe('saved');
});
