import { expect, test, type Page } from '@playwright/test';
import { setAutosave, setPrivateSession } from './settings-helpers';

const status = (page: Page) => page.locator('#status-line');

async function storageSnapshot(page: Page): Promise<{
  docs: Array<{ text: string; title: string; private?: boolean }>;
  changeTexts: string[];
  recovery: string[];
  pending: string | null;
}> {
  return page.evaluate(async () => {
    const docs = await new Promise<Array<{ text: string; title: string; private?: boolean }>>((resolve, reject) => {
      const open = indexedDB.open('typebridge');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const req = db.transaction('documents').objectStore('documents').getAll();
        req.onsuccess = () => { db.close(); resolve(req.result as Array<{ text: string; title: string; private?: boolean }>); };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    });
    const changeTexts = await new Promise<string[]>((resolve, reject) => {
      const open = indexedDB.open('typebridge');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (![...db.objectStoreNames].includes('changes')) {
          db.close();
          resolve([]);
          return;
        }
        const req = db.transaction('changes').objectStore('changes').getAll();
        req.onsuccess = () => {
          db.close();
          const rows = req.result as Array<{ text?: string; title?: string }>;
          resolve(rows.flatMap(row => [row.text ?? '', row.title ?? '']).filter(Boolean));
        };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    });
    const recovery: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('typebridge.recovery.v1.')) {
        recovery.push(localStorage.getItem(key) ?? '');
      }
    }
    let pending: string | null = null;
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('typebridge.pendingDraft.v1')) {
        pending = sessionStorage.getItem(key);
        break;
      }
    }
    return { docs, changeTexts, recovery, pending };
  });
}

test('typing while private leaves no post-switch storage trace after reload (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Before private');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Switch title');
  await expect(status(page)).toHaveText('Saved locally');

  await setAutosave(page, false);
  await expect(page.locator('#private-marker')).toBeVisible();

  await page.locator('#editor').fill('Before private SECRET after');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Secret title');
  await expect(status(page)).toHaveText(/Autosave off/);

  // Force a reload-backup opportunity, then reload without discarding UI text first.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const before = await storageSnapshot(page);
  expect(before.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(before.docs.every(doc => doc.title !== 'Secret title')).toBe(true);
  expect(before.changeTexts.every(text => !text.includes('SECRET') && text !== 'Secret title')).toBe(true);
  expect(before.recovery.every(raw => !raw.includes('SECRET') && !raw.includes('Secret title'))).toBe(true);
  expect(before.pending === null || (!before.pending.includes('SECRET') && !before.pending.includes('Secret title'))).toBe(true);
  expect(before.docs.some(doc => doc.private === true && doc.text === 'Before private')).toBe(true);

  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#editor')).toHaveValue('Before private');
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Switch title');
  await expect(page.locator('#autosave')).not.toBeChecked();
  await expect(page.locator('#private-marker')).toBeVisible();
  const after = await storageSnapshot(page);
  expect(after.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(after.docs.every(doc => !(doc.title ?? '').includes('Secret'))).toBe(true);
});

test('global private session blocks writes for a normal document (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Session base');
  await expect(status(page)).toHaveText('Saved locally');
  await setPrivateSession(page, true);
  await expect(page.locator('#autosave')).toBeDisabled();
  await page.locator('#editor').fill('Session base SECRET');
  await expect(status(page)).toHaveText(/Autosave off/);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const snap = await storageSnapshot(page);
  expect(snap.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(snap.changeTexts.every(text => !text.includes('SECRET'))).toBe(true);
  expect(snap.recovery.every(raw => !raw.includes('SECRET'))).toBe(true);
});
