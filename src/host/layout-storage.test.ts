import { expect, it } from 'vitest';
import { advanceLayoutEpoch, captureLayoutStorage, LAYOUT_EPOCH_KEY } from './layout-storage';
import { HOST_WINDOWS_KEY, readHostLayout, writeHostLayout } from './layout';
import { clearContentMetadata } from '../editor/clear-data';
function memory(): Storage {
  const data: Record<string, string> = {};
  return Object.defineProperties(data, {
    getItem: { value: (key: string) => data[key] ?? null },
    setItem: { value: (key: string, value: string) => { data[key] = value; }, writable: true },
    removeItem: { value: (key: string) => { delete data[key]; } },
  }) as unknown as Storage;
}
const layout = { version: 1 as const, windows: [{ id: 'main', x: 0, y: 0, w: 640, h: 480, z: 1 }] };
it('rejects multiple old hosts after erasure and preserves the fresh layout', () => {
  const store = memory(); const a = captureLayoutStorage(store), b = captureLayoutStorage(store);
  writeHostLayout(layout, a); advanceLayoutEpoch(store); clearContentMetadata(store);
  const fresh = captureLayoutStorage(store); writeHostLayout(layout, fresh);
  const before = JSON.stringify(store);
  writeHostLayout({ ...layout, windows: [] }, a); writeHostLayout({ ...layout, windows: [] }, b);
  expect(JSON.stringify(store)).toBe(before); expect(readHostLayout(fresh)).toEqual(layout);
  expect(readHostLayout(a)).toBeUndefined();
});
it('isolates an old write racing epoch advancement from the new layout slot', () => {
  const store = memory(); const old = captureLayoutStorage(store);
  const set = store.setItem.bind(store); let raced = false;
  store.setItem = (key, value) => {
    if (key === HOST_WINDOWS_KEY && !raced) {
      raced = true; advanceLayoutEpoch(store); clearContentMetadata(store);
      writeHostLayout(layout, captureLayoutStorage(store));
    }
    set(key, value);
  };
  writeHostLayout({ ...layout, windows: [] }, old);
  expect(store.getItem(HOST_WINDOWS_KEY)).toBeNull();
  expect(readHostLayout(captureLayoutStorage(store))).toEqual(layout);
});
it('advances again on retry and retains epoch through cleanup', () => {
  const store = memory(); advanceLayoutEpoch(store); const first = store.getItem(LAYOUT_EPOCH_KEY);
  advanceLayoutEpoch(store); clearContentMetadata(store);
  expect(store.getItem(LAYOUT_EPOCH_KEY)).not.toBe(first);
});
it('does not persist when epoch reads are denied', () => {
  const store = memory(); const writes: string[] = [];
  const denied = { getItem: () => { throw new Error('Denied'); }, setItem: (key: string) => writes.push(key) } as unknown as Storage;
  expect(writeHostLayout(layout, captureLayoutStorage(denied))).toBe(false);
  expect(writes).toEqual([]); expect(Object.keys(store)).toEqual([]);
});
