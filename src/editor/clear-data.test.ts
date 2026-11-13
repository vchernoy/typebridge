import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearContentMetadata, clearDocumentMetadata, parseStorageClear, deleteContentDatabase } from './clear-data';
afterEach(() => vi.unstubAllGlobals());
function storage(data: Record<string, string>, failingKey?: string): Storage {
  const value = { ...data };
  Object.defineProperties(value, {
    getItem: { value: (key: string) => value[key] ?? null },
    setItem: { value: (key: string, raw: string) => { value[key] = raw; } },
    removeItem: { value: (key: string) => { if (key === failingKey) throw new Error('Removal denied'); delete value[key]; } },
  });
  return value as unknown as Storage;
}
describe('content erasure', () => {
  it('removes all content metadata while retaining settings, the private switch and unrelated data', () => {
    const data = storage({ 'typebridge.autosave.v1': 'off', 'typebridge.find.matchCase.v1': 'on', 'typebridge.find.regex.v1': 'on',
      'typebridge.rules.v1': 'rules', unrelated: 'keep', 'typebridge.host.windows.v1': 'layout',
      'typebridge.recovery.v1.tab': 'secret', 'typebridge.pendingDraft.v1::w:main': 'secret', 'typebridge.activeDraft.v1::w:main': 'id',
      'typebridge.writingPosition.v1.w:main.id': 'position', 'typebridge.find.query.v1': 'query', 'typebridge.find.replace.v1::w:main': 'replacement',
      'typebridge.drafts.v1': 'old content' });
    clearContentMetadata(data);
    expect(Object.keys(data).sort()).toEqual(['typebridge.autosave.v1', 'typebridge.find.matchCase.v1', 'typebridge.find.regex.v1', 'typebridge.rules.v1', 'unrelated'].sort());
  });
  it('document clearing removes all window backups/hints/positions and only that layout identity', () => {
    const data = storage({ 'typebridge.pendingDraft.v1': JSON.stringify({ id: 'a', text: 'secret' }),
      'typebridge.pendingDraft.v1::w:other': JSON.stringify({ id: 'b', text: 'keep' }),
      'typebridge.recovery.v1.owner': JSON.stringify({ documentId: 'a' }),
      'typebridge.activeDraft.v1': 'a', 'typebridge.activeDraft.v1::w:other': 'b',
      'typebridge.writingPosition.v1.view:a': '{}', 'typebridge.writingPosition.v1.b': '{}',
      'typebridge.host.windows.v1': JSON.stringify({ windows: [{ id: 'main', documentId: 'a', x: 20 }, { id: 'w2', documentId: 'b' }] }) });
    clearDocumentMetadata(data, 'a');
    expect(data.getItem('typebridge.pendingDraft.v1')).toBeNull(); expect(data.getItem('typebridge.recovery.v1.owner')).toBeNull();
    expect(data.getItem('typebridge.activeDraft.v1')).toBeNull(); expect(data.getItem('typebridge.writingPosition.v1.view:a')).toBeNull();
    expect(data.getItem('typebridge.activeDraft.v1::w:other')).toBe('b');
    expect(JSON.parse(data.getItem('typebridge.host.windows.v1')!)).toEqual({ windows: [{ id: 'main', x: 20 }, { id: 'w2', documentId: 'b' }] });
  });
  it('accepts metadata-only notifications and rejects malformed ones', () => {
    expect(parseStorageClear({ nonce: 'n', documentId: 'a', text: 'discard' })).toEqual({ nonce: 'n', documentId: 'a' });
    expect(parseStorageClear({ nonce: 'n' })).toEqual({ nonce: 'n' });
    expect(parseStorageClear({ nonce: 'n', failed: true })).toEqual({ nonce: 'n', failed: true });
    expect(parseStorageClear({ nonce: 'n', failed: 'yes' })).toBeUndefined();
    expect(parseStorageClear({ nonce: '' })).toBeUndefined(); expect(parseStorageClear({ nonce: 'n', documentId: 4 })).toBeUndefined();
  });
});

it('database deletion waits through blocking and resolves only after actual deletion succeeds', async () => {
  const request = {} as IDBOpenDBRequest;
  const remove = vi.fn(() => request); vi.stubGlobal('indexedDB', { deleteDatabase: remove });
  const blocked = vi.fn(); let done = false;
  const promise = deleteContentDatabase(blocked).then(() => { done = true; });
  request.onblocked!(new Event('blocked') as IDBVersionChangeEvent);
  await Promise.resolve(); expect(done).toBe(false); expect(blocked).toHaveBeenCalledOnce();
  request.onsuccess!(new Event('success')); await promise;
  expect(done).toBe(true); expect(remove).toHaveBeenCalledWith('typebridge');
});
it('database deletion failures reject rather than claiming erasure', async () => {
  const request = { error: new Error('blocked') } as unknown as IDBOpenDBRequest;
  vi.stubGlobal('indexedDB', { deleteDatabase: () => request });
  const promise = deleteContentDatabase(() => {});
  request.onerror!(new Event('error'));
  await expect(promise).rejects.toThrow('blocked');
});

it.each(['typebridge.pendingDraft.v1', 'typebridge.recovery.v1.owner'])('propagates removal failure for matching backup %s', key => {
  const raw = JSON.stringify({ id: 'a', documentId: 'a', text: 'retained backup' });
  const data = storage({ [key]: raw }, key);
  expect(() => clearDocumentMetadata(data, 'a')).toThrow('Removal denied');
  expect(data.getItem(key)).toBe(raw);
});
