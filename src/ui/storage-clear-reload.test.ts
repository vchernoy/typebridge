import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { CLEARED_NOTICE_KEY, clearedNoticeText, installStorageClearReload, takeClearedNotice } from './storage-clear-reload';
import type { StorageClear } from '../editor/clear-data';
const { listeners, failed } = vi.hoisted(() => ({ listeners: [] as Array<(detail: StorageClear & { local: boolean }) => void>, failed: vi.fn() }));
vi.mock('../editor/clear-data', async original => ({ ...await original<typeof import('../editor/clear-data')>(),
  onStorageClear: (fn: (detail: StorageClear & { local: boolean }) => void) => listeners.push(fn), notifyStorageClear: failed }));
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { listeners.length = 0; failed.mockReset(); });
function storage(data: Record<string, string>, log: string[] = [], fail = false): Storage {
  return Object.defineProperties({ ...data }, {
    getItem: { value: function (this: Record<string, string>, k: string) { return this[k] ?? null; } },
    setItem: { value: function (this: Record<string, string>, k: string, v: string) { log.push('set:' + k); this[k] = v; } },
    removeItem: { value: function (this: Record<string, string>, k: string) { if (fail && k.startsWith('typebridge.pendingDraft')) throw new Error('Denied'); log.push('remove:' + k); delete this[k]; } },
  }) as unknown as Storage;
}
it.each([true, false])('stops the old page, clears metadata, flags and reloads once (here=%s)', here => {
  const log: string[] = []; const data = storage({ 'typebridge.pendingDraft.v1': 'old', setting: 'keep' }, log);
  vi.stubGlobal('sessionStorage', data);
  const reload = vi.fn(() => { log.push('reload'); });
  installStorageClearReload({ stop: () => { log.push('stop'); }, reload });
  listeners[0]({ nonce: 'n', local: here }); listeners[0]({ nonce: 'n2', local: here });
  expect(log).toEqual(['stop', 'remove:typebridge.pendingDraft.v1', 'set:' + CLEARED_NOTICE_KEY, 'reload']);
  expect(reload).toHaveBeenCalledOnce(); expect(data.getItem(CLEARED_NOTICE_KEY)).toBe(here ? 'here' : 'elsewhere');
  expect(takeClearedNotice(data)).toBe(here ? 'here' : 'elsewhere');
  expect(takeClearedNotice(data)).toBeUndefined(); expect(data.getItem('setting')).toBe('keep');
});
it('does not reload on partial failure or document-only notifications', () => {
  const stop = vi.fn(), reload = vi.fn(); installStorageClearReload({ stop, reload });
  listeners[0]({ nonce: 'n', local: false, failed: true }); listeners[0]({ nonce: 'd', local: true, documentId: 'doc' });
  expect(stop).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled();
});
it('reports a session cleanup failure without setting a notice or reloading', () => {
  const data = storage({ 'typebridge.pendingDraft.v1': 'old' }, [], true); vi.stubGlobal('sessionStorage', data);
  const reload = vi.fn(); installStorageClearReload({ stop: () => {}, reload }); listeners[0]({ nonce: 'n', local: true });
  expect(reload).not.toHaveBeenCalled(); expect(data.getItem(CLEARED_NOTICE_KEY)).toBeNull();
  expect(failed).toHaveBeenCalledWith(undefined, true);
});
it('delegates an embedded editor to its host after stopping it', () => {
  const log: string[] = []; const reload = vi.fn();
  installStorageClearReload({ stop: () => { log.push('stop'); }, delegate: here => { log.push('host:' + here); return true; }, reload });
  listeners[0]({ nonce: 'n', local: true }); expect(log).toEqual(['stop', 'host:true']); expect(reload).not.toHaveBeenCalled();
});
it('consumes invalid one-shot notices without showing a success message', () => {
  const data = storage({ [CLEARED_NOTICE_KEY]: 'invalid' }); expect(takeClearedNotice(data)).toBeUndefined(); expect(data.getItem(CLEARED_NOTICE_KEY)).toBeNull();
  expect(clearedNoticeText('here')).toBe('All local data was cleared'); expect(clearedNoticeText('elsewhere')).toBe('Storage was cleared in another tab');
});
