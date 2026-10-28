import { describe, expect, it } from 'vitest';
import { clearRecovery, listRecovery, recoveryKey, writeRecovery, type RecoverySnapshot } from '../src/editor/recovery';

function storage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, clear: () => map.clear(), getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null, removeItem: key => { map.delete(key); },
    setItem: (key, value) => { map.set(key, value); } };
}
const sample: RecoverySnapshot = { token: 'one', tab: 'tab', documentId: 'doc', revision: 3, timestamp: 12, title: 'Пост', text: 'Привет 🙂\nмир' };
describe('emergency journal', () => {
  it('isolates tabs and preserves Unicode without undo history', () => {
    const store = storage(); writeRecovery(store, sample); writeRecovery(store, { ...sample, tab: 'other', token: 'two' });
    expect(listRecovery(store)).toEqual([sample, { ...sample, tab: 'other', token: 'two' }]);
    expect(store.getItem(recoveryKey('tab', 'doc'))).not.toContain('history');
  });
  it('never clears a newer snapshot after an earlier commit', () => {
    const store = storage(); writeRecovery(store, sample); const newer = { ...sample, token: 'next', text: 'Новая версия' };
    writeRecovery(store, newer); clearRecovery(store, sample); expect(listRecovery(store)).toEqual([newer]);
    clearRecovery(store, newer); expect(listRecovery(store)).toEqual([]);
  });
  it('ignores malformed entries without deleting them', () => {
    const store = storage(); store.setItem(recoveryKey('x', 'y'), '{');
    expect(listRecovery(store)).toEqual([]); expect(store.getItem(recoveryKey('x', 'y'))).toBe('{');
  });
});
