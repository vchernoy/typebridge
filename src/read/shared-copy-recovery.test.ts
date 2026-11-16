import { expect, it } from 'vitest';
import { sharedCopyRecoveryExclusions } from './shared-copy-recovery';

function storage(entries: Record<string, string>): Storage {
  const keys = Object.keys(entries);
  return { length: keys.length, key: i => keys[i] ?? null, getItem: key => entries[key] ?? null,
    setItem: () => { throw new Error('Must not write'); }, removeItem: () => { throw new Error('Must not remove'); }, clear: () => { throw new Error('Must not clear'); } };
}
it('excludes observed emergency and scoped/unscoped reload backups without modifying bytes', () => {
  const local = storage({ 'typebridge.recovery.v1.tab.doc': '{"documentId":"doc","text":"unsaved"}', setting: 'keep' });
  const session = storage({ 'typebridge.pendingDraft.v1': '{"id":"first"}', 'typebridge.pendingDraft.v1::w:other': '{"id":"second"}', unrelated: '{"id":"ignored"}' });
  expect([...sharedCopyRecoveryExclusions(() => [local, session])!]).toEqual(['doc', 'first', 'second']);
  expect(local.getItem('typebridge.recovery.v1.tab.doc')).toBe('{"documentId":"doc","text":"unsaved"}');
});
it('disables reuse on unavailable or malformed recovery inspection', () => {
  expect(sharedCopyRecoveryExclusions(() => { throw new Error('Denied'); })).toBeUndefined();
  expect(sharedCopyRecoveryExclusions(() => [storage({ 'typebridge.recovery.v1.bad': 'invalid' }), storage({})])).toBeUndefined();
  expect(sharedCopyRecoveryExclusions(() => [storage({}), storage({ 'typebridge.pendingDraft.v1': '{}' })])).toBeUndefined();
  expect(sharedCopyRecoveryExclusions(() => [storage({}), storage({})])?.size).toBe(0);
});
