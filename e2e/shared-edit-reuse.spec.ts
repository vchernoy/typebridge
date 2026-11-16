import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';
import { readStoredDocs } from './storage-helpers';

const fields = { title: 'Reusable share', text: 'Exact original text\n', format: 'plain' as const };
const id1 = '00000000-0000-4000-8000-000000000001';
const id2 = '00000000-0000-4000-8000-000000000002';
async function link() {
  const result = await encodeSharePayload({ ...fields, edit: true, view: 'source' });
  if (!result.ok) throw new Error('Encoding failed');
  return '/read.html#doc=' + result.payload;
}
async function prepare(page: Page, rows: Record<string, unknown>[], owner = '', pending = false) {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.evaluate(async ({ rows, owner, pending, fields }) => {
    const open = indexedDB.open('typebridge');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction(['documents', 'editOwnership', 'changes'], 'readwrite');
    for (const row of rows) tx.objectStore('documents').put({ ...fields, revision: 1, upTo: 0, updatedAt: 1, ...row });
    const id = rows[0]?.id;
    if (owner) tx.objectStore('editOwnership').put({ documentId: id, ownerInstanceId: owner, fence: 1, updatedAt: 0 });
    if (pending) tx.objectStore('changes').put({ documentId: id, seq: 1 });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
  }, { rows, owner, pending, fields });
  await page.goto(await link());
  await expect(page.locator('#read-text')).toHaveText(fields.text, { useInnerText: false });
}

async function rawRow(page: Page, id: string) {
  return page.evaluate(id => new Promise<Record<string, unknown>>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const get = db.transaction('documents').objectStore('documents').get(id);
      get.onsuccess = () => { db.close(); resolve(get.result); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
  }), id);
}

test('Edit reuses an exact unowned copy with deterministic matching and preserves its metadata', async ({ page }) => {
  await prepare(page, [{ id: id2 }, { id: id1, find: 'keep search', replace: 'keep replacement' }]);
  const before = await readStoredDocs(page);
  await page.locator('#edit-copy').click();
  await expect(page.locator('.host-status')).toHaveText('Opened an existing document from your Documents.');
  await expect(page.frameLocator(`iframe[src*="doc=${id1}"]`).locator('#editor')).toHaveValue(fields.text);
  const after = await readStoredDocs(page);
  expect(after).toHaveLength(before.length);
  expect(await rawRow(page, id1)).toMatchObject({ find: 'keep search', replace: 'keep replacement' });
  expect(after.find(d => d.id === id1)?.revision).toBe(1);
  expect(page.url()).not.toContain('reused=');
});

for (const variant of ['text', 'title', 'format', 'private', 'owned', 'pending'] as const) {
  test(`Edit creates a new copy when candidate is ${variant}`, async ({ page }) => {
    const row = { id: id1, ...(variant === 'text' ? { text: 'Changed' } : variant === 'title' ? { title: 'Changed' } : variant === 'format' ? { format: 'markdown' } : variant === 'private' ? { private: true } : {}) };
    await prepare(page, [row], variant === 'owned' ? 'suspended-owner' : '', variant === 'pending');
    const before = await readStoredDocs(page);
    await page.locator('#edit-copy').click();
    await expect(page.locator('.host-status')).toHaveText('Saved as a new document in your Documents.');
    const after = await readStoredDocs(page);
    expect(after).toHaveLength(before.length + 1);
    expect(after.find(d => d.id === id1)).toEqual(before.find(d => d.id === id1));
    expect(after.some(d => d.id !== id1 && d.text === fields.text && d.title === fields.title)).toBe(true);
  });
}

test('concurrent Edit clicks reuse the atomically created copy', async ({ page, context }) => {
  await prepare(page, []);
  const second = await context.newPage();
  await second.goto(await link());
  await expect(second.locator('#edit-copy')).toBeVisible();
  const before = await readStoredDocs(page);
  await Promise.all([page.locator('#edit-copy').click(), second.locator('#edit-copy').click()]);
  await expect(page).toHaveURL(/\/$/);
  await expect(second).toHaveURL(/\/$/);
  const after = await readStoredDocs(page);
  expect(after).toHaveLength(before.length + 1);
  expect(after.filter(d => d.text === fields.text && d.title === fields.title)).toHaveLength(1);
});
