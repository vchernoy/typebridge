import { expect, test, type Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { encodeSharePayload } from '../src/editor/share-link';
import type * as Fixture from './fixtures/shared-group-removal';
let bundle: string | undefined;
async function fixtureCode() {
  if (bundle) return bundle;
  const built = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('e2e/fixtures/shared-group-removal.ts'), name: 'GroupRemovalFixture', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const outputs = Array.isArray(built) ? built : [built];
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!code || code.type !== 'chunk') throw new Error('No fixture');
  return bundle = code.code;
}
async function payload(edit = false, title = 'Atomic fixture', heading?: false) {
  const encoded = await encodeSharePayload({ title, text: 'Same source', format: 'plain', view: 'source', edit, heading });
  if (!encoded.ok) throw new Error('Fixture refused'); return encoded.payload;
}
async function remember(page: Page, encoded: string) {
  await page.goto('/read.html#doc=' + encoded); await expect(page.locator('#shared-memory-status')).toContainText('Remembered');
}
async function rows(page: Page, store = 'sharedItems') {
  return page.evaluate(store => new Promise<Record<string, unknown>[]>(resolve => {
    const r = indexedDB.open('typebridge'); r.onsuccess = () => { const db = r.result;
      const tx = db.transaction(store), q = tx.objectStore(store).getAll();
      tx.oncomplete = () => { db.close(); resolve(q.result); };
    };
  }), store);
}
async function setup(page: Page) {
  await remember(page, await payload()); await remember(page, await payload(true)); await remember(page, await payload(false, 'Other'));
  await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
    const db = r.result; const tx = db.transaction(['sharedItems', 'readerStates'], 'readwrite'); const q = tx.objectStore('sharedItems').getAll();
    q.onsuccess = () => { for (const item of q.result) tx.objectStore('readerStates').put({ id: 'shared:' + item.id, version: 1, revision: 1, inputs: [['x', 7]] }); };
    tx.oncomplete = () => { db.close(); resolve(); };
  }; }));
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Independent editable source'); await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.locator('#doc-menu-open').click(); await page.locator('#shared-library > summary').click();
  const group = page.locator('#shared-library .shared-group'); await group.locator(':scope > summary').click();
  return group;
}
test('confirmed group removal is cancellable and preserves unrelated links, sidecars and editable source at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const group = await setup(page); const before = await rows(page), states = await rows(page, 'readerStates'), documents = await rows(page, 'documents');
  await group.getByLabel('Group actions for Atomic fixture', { exact: true }).click();
  const remove = group.getByRole('button', { name: 'Remove all 2 received links' }); await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove received links?', exact: true }); await expect(dialog).toContainText('saved reader inputs will also be removed. Editable copies stay unchanged.');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(remove).toBeFocused();
  expect(await rows(page)).toEqual(before); expect(await rows(page, 'readerStates')).toEqual(states);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    (window as unknown as { restoreGroupProof: () => void }).restoreGroupProof = () => { Storage.prototype.setItem = set; };
    Storage.prototype.setItem = function (key, value) { if (key === 'typebridge.sharedRemoval.v1') throw new Error('Denied'); return set.call(this, key, value); };
  });
  await remove.click(); await dialog.getByRole('button', { name: 'Remove 2 links', exact: true }).click();
  await expect(page.locator('#shared-library [role="status"]')).toContainText('No partial removal was committed');
  await expect(remove).toBeEnabled(); await expect(remove).toBeFocused();
  expect(await rows(page)).toEqual(before); expect(await rows(page, 'readerStates')).toEqual(states);
  await page.evaluate(() => (window as unknown as { restoreGroupProof: () => void }).restoreGroupProof());
  await remove.click(); await dialog.getByRole('button', { name: 'Remove 2 links', exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Other (shared, opens a new tab)', exact: true })).toBeFocused();
  const kept = await rows(page); expect(kept).toHaveLength(1); expect(kept[0].payload).toBe(await payload(false, 'Other'));
  expect((await rows(page, 'readerStates')).filter(row => String(row.id).startsWith('shared:'))).toEqual([
    states.find(row => row.id === 'shared:' + kept[0].id),
  ]);
  expect(await rows(page, 'readerStates')).toContainEqual({ id: 'libraryEpoch', revision: 1 });
  expect(await rows(page, 'documents')).toEqual(documents);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
test('a new member arriving during confirmation requires a fresh decision and deletes nothing', async ({ page, context }) => {
  const group = await setup(page); const states = await rows(page, 'readerStates');
  await group.getByLabel('Group actions for Atomic fixture', { exact: true }).click();
  await group.getByRole('button', { name: 'Remove all 2 received links' }).click();
  const reader = await context.newPage(); await remember(reader, await payload(false, 'Atomic fixture', false));
  await page.getByRole('dialog', { name: 'Remove received links?', exact: true }).getByRole('button', { name: 'Remove 2 links', exact: true }).click();
  await expect(page.locator('#shared-library [role="status"]')).toContainText('changed. Review the group');
  await expect(group.locator(':scope > summary')).toContainText('3 received links');
  await expect(group.locator(':scope > summary')).toBeFocused();
  expect(await rows(page)).toHaveLength(4); expect(await rows(page, 'readerStates')).toEqual(states);
});
for (const mode of ['rollback', 'arrival', 'metadata'] as const) {
  test(`atomic group transaction handles ${mode} and invalidates stale writers`, async ({ page }) => {
    await setup(page); const before = await rows(page), states = await rows(page, 'readerStates'), documents = await rows(page, 'documents');
    await page.addScriptTag({ content: await fixtureCode() });
    const target = await payload(), second = await payload(true), incoming = await payload(false, 'Atomic fixture', false);
    const result = await page.evaluate(async ({ mode, target, second, incoming }) => {
      const api = (window as unknown as { GroupRemovalFixture: typeof Fixture }).GroupRemovalFixture;
      const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => resolve(r.result); });
      const all = await new Promise<{ id: string; payload: string; lastOpenedAt: number }[]>(resolve => {
        const tx = db.transaction('sharedItems'), q = tx.objectStore('sharedItems').getAll(); tx.oncomplete = () => resolve(q.result);
      });
      const confirmed = all.filter(row => row.payload === target || row.payload === second).map(({ id, payload }) => ({ id, payload }));
      const unrelated = all.find(row => row.payload !== target && row.payload !== second)!;
      const old = (await api.openSharedInputs(target, () => true, () => {}))!;
      const del = IDBObjectStore.prototype.delete, transaction = IDBDatabase.prototype.transaction;
      let attempted = 0, injected = false;
      if (mode === 'rollback') IDBObjectStore.prototype.delete = function (key) {
        if (this.name === 'sharedItems' && ++attempted === 2) throw new Error('Synthetic delete failure');
        return del.call(this, key);
      };
      else IDBDatabase.prototype.transaction = function (stores, access, options) {
        if (!injected && access === 'readwrite' && Array.isArray(stores) && stores.includes('sharedItems') && stores.includes('readerStates')) {
          injected = true;
          const tx = transaction.call(this, 'sharedItems', 'readwrite');
          tx.objectStore('sharedItems').put(mode === 'arrival'
            ? { id: 'arrival', digest: 'synthetic', payload: incoming, bytes: incoming.length, createdAt: 1, lastOpenedAt: 1 }
            : { ...unrelated, lastOpenedAt: 1000000 });
        }
        return transaction.call(this, stores, access, options);
      };
      let outcome: string;
      try { outcome = await api.removeSharedGroup(db, { title: 'Atomic fixture', text: 'Same source', format: 'plain' }, confirmed); }
      catch { outcome = 'failed'; }
      finally { IDBObjectStore.prototype.delete = del; IDBDatabase.prototype.transaction = transaction; db.close(); }
      const stale = await old.save(new Map([['x', 9]])); old.close();
      return { outcome, stale, attempted, injected };
    }, { mode, target, second, incoming });
    expect(result.outcome).toBe(mode === 'rollback' ? 'failed' : mode === 'arrival' ? 'changed' : 'removed');
    expect(result.stale).toBe('cancelled');
    if (mode === 'rollback') { expect(result.attempted).toBe(2); expect(await rows(page)).toEqual(before); expect(await rows(page, 'readerStates')).toEqual(states); }
    if (mode === 'arrival') { expect(result.injected).toBe(true); expect(await rows(page)).toHaveLength(4); expect(await rows(page, 'readerStates')).toEqual(states); }
    if (mode === 'metadata') { const kept = await rows(page); expect(kept).toHaveLength(1); expect(kept[0]).toMatchObject({ payload: await payload(false, 'Other'), lastOpenedAt: 1000000 }); }
    expect(await rows(page, 'documents')).toEqual(documents);
  });
}
