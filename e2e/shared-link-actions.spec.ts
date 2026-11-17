import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';
const source = '```calc\ninput x = 2 in 1..10\ny = x * 3\n```\n\n:input[x] :value[y]';
async function link(text = source, title = 'Original fixture', format = 'markdown', view: 'source' | 'rendered' = 'rendered') {
  const encoded = await encodeSharePayload({ title, text, format, view, edit: false });
  if (!encoded.ok) throw new Error('Fixture refused'); return encoded.payload;
}
async function receive(page: Page, payload: string) {
  await page.goto('/read.html#doc=' + payload); await expect(page.locator('#shared-memory-status')).toContainText('Remembered');
}
async function library(page: Page) {
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#doc-menu-open').click(); await page.locator('#shared-library > summary').click();
  await page.locator('#shared-library .shared-actions > summary').click();
}
async function records(page: Page) {
  return page.evaluate(() => new Promise<Record<string, unknown>[][]>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
    const db = r.result; const tx = db.transaction(['sharedItems', 'readerStates', 'documents']);
    const all = ['sharedItems', 'readerStates', 'documents'].map(name => tx.objectStore(name).getAll());
    tx.oncomplete = () => { db.close(); resolve(all.map(q => q.result)); };
  }; }));
}
for (const privateSession of [false, true]) {
  test(`copy preserves the exact original link rather than local inputs/private editor state: private=${privateSession}`, async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as unknown as { copiedOriginal: string }).copiedOriginal = value; },
    } }));
    const payload = await link(); await receive(page, payload);
    await page.locator('#read-text input').fill('7'); await expect(page.locator('#reader-input-status')).toHaveText('Inputs saved on this device.');
    if (privateSession) await page.evaluate(() => localStorage.setItem('typebridge.autosave.v1', 'off'));
    await library(page); await page.locator('#editor').fill('Unshared local editor source');
    if (privateSession) await expect(page.locator('#autosave')).not.toBeChecked();
    else await expect(page.locator('#save-indicator')).toHaveText('Saved');
    const before = await records(page);
    expect(before[2]).toHaveLength(privateSession ? 0 : 1);
    await page.getByRole('button', { name: 'Copy original link for Original fixture', exact: true }).click();
    await expect(page.locator('#shared-library [role="status"]')).toHaveText('Original link copied.');
    expect(await page.evaluate(() => (window as unknown as { copiedOriginal: string }).copiedOriginal))
      .toBe(new URL('/read.html#doc=' + payload, page.url()).href);
    expect(await records(page)).toEqual(before);
    expect(before[1].find(row => String(row.id).startsWith('shared:'))).toMatchObject({ inputs: [['x', 7]] });
  });
}
test('clipboard denial offers a selected original URL and retry works without storage writes at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async () => { if (!(window as unknown as { allowCopy?: boolean }).allowCopy) throw new Error('Denied'); },
  } }));
  const payload = await link('Plain original', 'Original fixture', 'plain', 'source'); await receive(page, payload); await library(page);
  const before = await records(page), copy = page.getByRole('button', { name: 'Copy original link for Original fixture', exact: true });
  await copy.click(); const manual = page.getByRole('textbox', { name: 'Original link for Original fixture', exact: true });
  await expect(manual).toBeVisible(); await expect(manual).toBeFocused();
  await expect(manual).toHaveValue(new URL('/read.html#doc=' + payload, page.url()).href);
  expect(await manual.evaluate((el: HTMLInputElement) => [el.readOnly, el.selectionStart, el.selectionEnd])).toEqual([true, 0, (await manual.inputValue()).length]);
  await expect(page.locator('#shared-library [role="status"]')).toContainText('Could not copy automatically');
  expect(await manual.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.evaluate(() => { (window as unknown as { allowCopy: boolean }).allowCopy = true; });
  await copy.click(); await expect(page.locator('#shared-library [role="status"]')).toHaveText('Original link copied.');
  await expect(manual).toBeHidden(); expect(await records(page)).toEqual(before);
});
test('a stale clipboard rejection cannot replace search feedback or move its focus', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: () => new Promise<void>((_resolve, reject) => { (window as unknown as { rejectOriginalCopy: () => void }).rejectOriginalCopy = () => reject(new Error('Denied')); }),
  } }));
  await receive(page, await link('Plain original', 'Original fixture', 'plain', 'source')); await library(page);
  await page.getByRole('button', { name: 'Copy original link for Original fixture', exact: true }).click();
  const search = page.locator('#shared-search'); await search.fill('no match');
  await expect(page.locator('#shared-library [role="status"]')).toHaveText('No matching shared documents.');
  await page.evaluate(() => (window as unknown as { rejectOriginalCopy: () => void }).rejectOriginalCopy());
  await expect(search).toBeFocused(); await expect(page.locator('#shared-library [role="status"]')).toHaveText('No matching shared documents.');
  await expect(page.getByRole('textbox', { name: /Original link for/ })).toHaveCount(0);
});
test('individual removal cancels safely and refuses a payload changed while the dialog was open', async ({ page }) => {
  const original = await link('Plain original', 'Original fixture', 'plain', 'source'); await receive(page, original);
  await page.evaluate(() => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
    const db = r.result; const tx = db.transaction(['sharedItems', 'readerStates'], 'readwrite'), q = tx.objectStore('sharedItems').getAll();
    q.onsuccess = () => tx.objectStore('readerStates').put({ id: 'shared:' + q.result[0].id, version: 1, revision: 1, inputs: [['x', 7]] });
    tx.oncomplete = () => { db.close(); resolve(); };
  }; }));
  await library(page);
  const before = await records(page), token = await page.evaluate(() => localStorage.getItem('typebridge.sharedRemoval.v1'));
  const remove = page.getByRole('button', { name: 'Remove shared document Original fixture', exact: true }); await remove.click();
  const dialog = page.getByRole('dialog', { name: 'Remove received link?', exact: true });
  await expect(dialog).toContainText('Other received links and editable copies stay unchanged.');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(remove).toBeFocused();
  expect(await records(page)).toEqual(before); expect(await page.evaluate(() => localStorage.getItem('typebridge.sharedRemoval.v1'))).toBe(token);
  await remove.click();
  const replacement = await link('Changed source', 'Changed received', 'plain', 'source');
  await page.evaluate(payload => new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => {
    const db = r.result; const tx = db.transaction('sharedItems', 'readwrite'); const q = tx.objectStore('sharedItems').getAll();
    q.onsuccess = () => tx.objectStore('sharedItems').put({ ...q.result[0], payload });
    tx.oncomplete = () => { db.close(); resolve(); };
  }; }), replacement);
  await dialog.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(page.locator('#shared-library [role="status"]')).toContainText('changed. Review it');
  await expect(page.getByRole('link', { name: 'Changed received (shared, opens a new tab)', exact: true })).toBeVisible();
  const after = await records(page); expect(after[0]).toHaveLength(1); expect(after[0][0].payload).toBe(replacement);
  expect(after.slice(1)).toEqual(before.slice(1));
});
