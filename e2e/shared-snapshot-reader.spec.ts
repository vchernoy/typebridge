import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { encodeSharePayload } from '../src/editor/share-link';
import type * as Fixture from './fixtures/shared-snapshot-reader';
let bundle: string | undefined;
async function fixtureCode() {
  if (bundle) return bundle;
  const built = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('e2e/fixtures/shared-snapshot-reader.ts'), name: 'SnapshotReaderFixture', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const outputs = Array.isArray(built) ? built : [built];
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!code || code.type !== 'chunk') throw new Error('No fixture');
  return bundle = code.code;
}
async function setup(page: Page) {
  const encoded = await encodeSharePayload({ title: 'Snapshot boundary', text: 'Plain source', format: 'plain', view: 'source', edit: false });
  if (!encoded.ok) throw new Error('Encoding failed');
  await page.goto('/read.html#doc=' + encoded.payload);
  await expect(page.locator('#shared-memory-status')).toContainText('Remembered');
  await page.addScriptTag({ content: await fixtureCode() });
  return encoded.payload;
}
async function mount(page: Page, payload: string, values: [string, number][] = [['x', 5], ['seed', 7]]) {
  return page.evaluate(({ payload, values }) => {
    const fixture = (window as unknown as { SnapshotReaderFixture: typeof Fixture }).SnapshotReaderFixture;
    return fixture.mount(payload, { version: 1, values });
  }, { payload, values });
}
async function rows(page: Page) {
  return page.evaluate(() => new Promise<{ id: string; version: number; revision: number; inputs: [string, number][] }[]>((resolve, reject) => {
    const r = indexedDB.open('typebridge'); r.onerror = () => reject(r.error);
    r.onsuccess = () => { const db = r.result; const tx = db.transaction('readerStates'); const q = tx.objectStore('readerStates').getAll();
      tx.oncomplete = () => { db.close(); resolve(q.result.filter(row => row.id.startsWith('shared:'))); }; tx.onabort = () => reject(tx.error); };
  }));
}
test('incoming first render, whole local precedence and durable empty reset without write-on-restore', async ({ page }) => {
  const payload = await setup(page);
  expect(await mount(page, payload)).toEqual({ input: '5', output: '12', math: '12', conditional: true });
  expect(await rows(page)).toEqual([]);
  await page.locator('#snapshot-root input').fill('9');
  await expect(page.locator('#snapshot-status')).toHaveText('Inputs saved on this device.');
  const saved = await rows(page);
  // A missing local seed must use its authored default, not incoming seed=7.
  await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
    const db = r.result; const tx = db.transaction('readerStates', 'readwrite'); const q = tx.objectStore('readerStates').getAll();
    q.onsuccess = () => { const row = q.result.find(row => row.id.startsWith('shared:')); tx.objectStore('readerStates').put({ ...row, inputs: [['x', 9]] }); };
    tx.oncomplete = () => { db.close(); resolve(); };
  }; }));
  expect(await mount(page, payload)).toEqual({ input: '9', output: '12', math: '12', conditional: true });
  expect((await rows(page))[0].revision).toBe(saved[0].revision);
  await page.locator('#snapshot-reset').click();
  await expect.poll(async () => (await rows(page))[0].inputs).toEqual([]);
  const reset = await rows(page);
  expect(await mount(page, payload)).toEqual({ input: '2', output: '5', math: '5', conditional: false });
  expect(await rows(page)).toEqual(reset);
});
test('runtime validates incoming ranges/names and accepts model-only values without initial writes', async ({ page }) => {
  const payload = await setup(page);
  expect(await mount(page, payload, [['x', 99], ['seed', 7], ['missing', 42]])).toEqual({ input: '2', output: '9', math: '9', conditional: false });
  expect(await rows(page)).toEqual([]);
  expect(await mount(page, payload, [])).toEqual({ input: '2', output: '5', math: '5', conditional: false });
  expect(await rows(page)).toEqual([]);
});
for (const mode of ['corrupt', 'private', 'opt-out', 'read-failure'] as const) {
  test(`${mode} uses incoming temporary values and cannot overwrite a saved snapshot`, async ({ page }) => {
    const payload = await setup(page);
    await mount(page, payload); await page.locator('#snapshot-root input').fill('8');
    await expect(page.locator('#snapshot-status')).toHaveText('Inputs saved on this device.');
    if (mode === 'corrupt') await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
      const db = r.result; const tx = db.transaction('readerStates', 'readwrite'); const q = tx.objectStore('readerStates').getAll();
      q.onsuccess = () => { const row = q.result.find(row => row.id.startsWith('shared:')); tx.objectStore('readerStates').put({ ...row, version: 99 }); };
      tx.oncomplete = () => { db.close(); resolve(); };
    }; }));
    const before = await rows(page);
    if (mode === 'private') await page.evaluate(() => localStorage.setItem('typebridge.autosave.v1', 'off'));
    if (mode === 'opt-out') await page.evaluate(() => localStorage.setItem('typebridge.rememberShared.v1', 'off'));
    if (mode === 'read-failure') await page.evaluate(() => {
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        if (this.name === 'readerStates') throw new Error('Unavailable');
        return get.call(this, key);
      };
    });
    expect(await mount(page, payload)).toEqual({ input: '5', output: '12', math: '12', conditional: true });
    await expect(page.locator('#snapshot-status')).toContainText(mode === 'private' || mode === 'opt-out' ? 'temporary' : 'Saved inputs are unavailable');
    await page.locator('#snapshot-root input').fill('6');
    await page.locator('#snapshot-reset').click();
    await expect(page.locator('#snapshot-root input')).toHaveValue('2');
    await expect(page.locator('#snapshot-status')).toContainText('authored defaults');
    // Past the save debounce: temporary edits/reset must leave even an incompatible row intact.
    await page.waitForTimeout(650);
    expect(await rows(page)).toEqual(before);
  });
}
