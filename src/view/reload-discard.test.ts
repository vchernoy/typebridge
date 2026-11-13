import { afterEach, describe, expect, it } from 'vitest';
import {
  clearReloadDiscardIntent,
  readReloadDiscardIntent,
  reloadDiscardIntentKey,
  setReloadDiscardIntent,
} from './reload-discard';

afterEach(() => {
  try { sessionStorage.clear(); } catch { /* node may lack sessionStorage */ }
});

describe('reload discard session intent (#255)', () => {
  it('stores and clears intent by instance id', () => {
    if (typeof sessionStorage === 'undefined') return;
    setReloadDiscardIntent('inst-a', 'doc-1');
    expect(readReloadDiscardIntent('inst-a')).toBe('doc-1');
    expect(sessionStorage.getItem(reloadDiscardIntentKey('inst-a'))).toBe('doc-1');
    clearReloadDiscardIntent('inst-a');
    expect(readReloadDiscardIntent('inst-a')).toBeUndefined();
  });

  it('keeps another instance intent when clearing one', () => {
    if (typeof sessionStorage === 'undefined') return;
    setReloadDiscardIntent('inst-a', 'doc-1');
    setReloadDiscardIntent('inst-b', 'doc-2');
    clearReloadDiscardIntent('inst-a');
    expect(readReloadDiscardIntent('inst-b')).toBe('doc-2');
  });
});
