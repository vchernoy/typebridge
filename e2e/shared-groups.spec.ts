import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

async function receive(page: Page, edit = false, format = 'plain') {
  const encoded = await encodeSharePayload({ title: 'Group fixture', text: 'Exact shared source', format, view: 'source', edit });
  if (!encoded.ok) throw new Error('Fixture refused');
  await page.goto('/read.html#doc=' + encoded.payload);
  await expect(page.locator('#shared-memory-status')).toContainText('Remembered');
  return encoded.payload;
}
async function library(page: Page) {
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#doc-menu-open').click(); await page.locator('#shared-library > summary').click();
}
async function rows(page: Page, store = 'sharedItems') {
  return page.evaluate(store => new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const r = indexedDB.open('typebridge'); r.onerror = () => reject(r.error);
    r.onsuccess = () => { const db = r.result; const tx = db.transaction(store); const q = tx.objectStore(store).getAll();
      tx.oncomplete = () => { db.close(); resolve(q.result); }; tx.onabort = () => reject(tx.error); };
  }), store);
}
for (const width of [320, 1440]) {
  test(`groups real original links, filters hints and restores expansion at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const first = await receive(page), second = await receive(page, true);
    await receive(page, false, 'markdown'); // Same title/source, different format is a singleton.
    await library(page);
    const group = page.locator('#shared-library .shared-group');
    const summary = group.locator(':scope > summary');
    await expect(group).toHaveCount(1); await expect(summary).toContainText('2 received links');
    await expect(group).not.toHaveAttribute('open');
    await expect(page.getByRole('button', { name: /Remove shared document/ })).toHaveCount(0);
    const search = page.locator('#shared-search'); await search.focus(); await page.keyboard.press('Tab');
    // Most recently opened Markdown singleton can precede the group; direct focus
    // then proves native keyboard expansion and the hidden group's link Tab order.
    await summary.focus(); await page.keyboard.press('Space');
    await expect(group).toHaveAttribute('open', ''); await page.keyboard.press('Tab');
    await expect(group.getByRole('link').first()).toBeFocused();
    await page.screenshot({ path: `/tmp/350-grouped-${testInfo.project.name}-${width}.png`, fullPage: true });
    expect((await group.getByRole('link').evaluateAll(links => links.map(a => a.getAttribute('href')))).sort())
      .toEqual(['/read.html#doc=' + first, '/read.html#doc=' + second].sort());
    // Both original presentation variants remain independently usable.
    for (const [payload, canEdit] of [[first, false], [second, true]] as const) {
      const opened = context.waitForEvent('page'); await group.locator(`a[href="/read.html#doc=${payload}"]`).click();
      const reader = await opened; await expect(reader.locator('#read-text')).toHaveText('Exact shared source');
      if (canEdit) await expect(reader.locator('#edit-copy')).toBeVisible(); else await expect(reader.locator('#edit-copy')).toBeHidden();
      await reader.close();
    }
    await search.fill('Editing allowed');
    await expect(group.locator(':scope > summary')).toContainText('1 of 2 received links');
    await expect(group.getByRole('link')).toHaveCount(1); await expect(search).toBeFocused();
    await search.fill('Exact shared source'); await expect(group.getByRole('link')).toHaveCount(2);
    await search.fill('missing phrase'); await expect(page.locator('#shared-library [role="status"]')).toHaveText('No matching shared documents.');
    await search.fill(''); await expect(group).toHaveAttribute('open', '');
    await summary.focus(); await page.keyboard.press('Enter'); await expect(group).not.toHaveAttribute('open');
    await search.fill('editing'); await expect(group).toHaveAttribute('open', '');
    await search.fill(''); await expect(group).not.toHaveAttribute('open');
    await summary.click();
    const original = group.getByRole('link').first(); await original.focus();
    await search.dispatchEvent('input'); await expect(original).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const targets = await page.locator('#shared-library a, #shared-library summary').evaluateAll(els => els.filter(el => el.checkVisibility()).map(el => el.getBoundingClientRect().height));
    expect(targets.every(height => height >= 44)).toBe(true);
    await page.addStyleTag({ content: ':root { font-size: 200%; }' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await rows(page)).toHaveLength(3);
  });
}
test('individual removal preserves sibling sidecar/editable source and focuses the surviving singleton', async ({ page }) => {
  await receive(page); await receive(page, true);
  const before = await rows(page);
  await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
    const db = r.result; const tx = db.transaction(['sharedItems', 'readerStates'], 'readwrite'); const q = tx.objectStore('sharedItems').getAll();
    q.onsuccess = () => { for (const item of q.result) tx.objectStore('readerStates').put({ id: 'shared:' + item.id, version: 1, revision: 1, inputs: [['x', 7]] }); };
    tx.oncomplete = () => { db.close(); resolve(); };
  }; }));
  await library(page); await page.locator('#editor').fill('Independent source'); await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const documents = await rows(page, 'documents');
  const group = page.locator('#shared-library .shared-group'); await group.locator(':scope > summary').click();
  const variant = group.locator('li').first(); const href = await variant.locator('a').getAttribute('href');
  const removed = before.find(row => href === '/read.html#doc=' + row.payload)!;
  await variant.locator('.shared-actions > summary').click();
  const remove = variant.getByRole('button', { name: /Remove shared document/ });
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    (window as unknown as { restoreRemovalStorage: () => void }).restoreRemovalStorage = () => { Storage.prototype.setItem = set; };
    Storage.prototype.setItem = function (key, value) { if (key === 'typebridge.sharedRemoval.v1') throw new Error('Denied'); return set.call(this, key, value); };
  });
  await remove.click();
  await expect(page.locator('#shared-library [role="status"]')).toHaveText('Could not remove this item.');
  await expect(remove).toBeEnabled(); await expect(remove).toBeFocused();
  expect(await rows(page)).toHaveLength(2);
  await page.evaluate(() => (window as unknown as { restoreRemovalStorage: () => void }).restoreRemovalStorage());
  await remove.click();
  await expect(group).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Group fixture (shared, opens a new tab)', exact: true })).toBeFocused();
  expect(await rows(page)).toHaveLength(1);
  expect((await rows(page, 'readerStates')).filter(row => String(row.id).startsWith('shared:'))).toEqual([
    expect.objectContaining({ id: 'shared:' + before.find(row => row.id !== removed.id)!.id, inputs: [['x', 7]] }),
  ]);
  expect(await rows(page, 'documents')).toEqual(documents);
});
test('incompatible stored payloads remain visible and individually removable without exposing raw content', async ({ page }) => {
  await receive(page);
  await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
    const db = r.result; const tx = db.transaction('sharedItems', 'readwrite');
    tx.objectStore('sharedItems').put({ id: 'incompatible', digest: 'synthetic', payload: '99.privateMarker', bytes: 20, createdAt: 1, lastOpenedAt: 1 });
    tx.oncomplete = () => { db.close(); resolve(); };
  }; }));
  await library(page);
  await expect(page.locator('#shared-library')).toContainText('Unavailable received link');
  await expect(page.locator('#shared-library')).not.toContainText('privateMarker');
  const row = page.locator('#shared-library li').filter({ hasText: 'Unavailable received link' });
  await row.locator('summary').click(); await row.getByRole('button', { name: 'Remove shared document Unavailable received link' }).click();
  await expect(row).toHaveCount(0); expect(await rows(page)).toHaveLength(1);
});
