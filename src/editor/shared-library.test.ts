import { afterEach, describe, expect, it, vi } from 'vitest';
import { readerStorageAllowed, rememberPreference, rememberShared, sharedRemovalToken, SHARED_REMOVAL_KEY, removeSharedItem } from './shared-library';
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


afterEach(() => vi.unstubAllGlobals());
describe('removal cancellation before asynchronous remembering', () => {
  it('rejects a stale marker before decoding or opening storage', async () => {
    let token = 'before';
    vi.stubGlobal('localStorage', { getItem: (key: string) => key === SHARED_REMOVAL_KEY ? token : null });
    const open = vi.fn(); vi.stubGlobal('indexedDB', { open });
    const captured = sharedRemovalToken(); token = 'after';
    expect(await rememberShared('invalid', () => true, () => {}, { token: captured })).toBe('cancelled');
    expect(open).not.toHaveBeenCalled();
  });
  it('does not replace a failed initial token read with a later successful baseline', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const open = vi.fn(); vi.stubGlobal('indexedDB', { open });
    expect(await rememberShared('invalid', () => true, () => {}, { token: undefined })).toBe('disabled');
    expect(open).not.toHaveBeenCalled();
  });
  it('refuses removal if cancellation cannot be published, without deleting anything', async () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('Denied'); } });
    const transaction = vi.fn();
    await expect(removeSharedItem({ transaction } as unknown as IDBDatabase, 'kept')).rejects.toThrow('Denied');
    expect(transaction).not.toHaveBeenCalled();
  });
});
