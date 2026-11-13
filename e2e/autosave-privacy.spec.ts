import { expect, test, type Page } from '@playwright/test';
import { openDocuments, openSettings, setAutosave, setPrivateSession } from './settings-helpers';

const AUTOSAVE_OFF = 'Autosave off — text and title are not saved and will be lost on reload';
const status = (page: Page) => page.locator('#status-line');

test('status line states privacy consequences when a document is private (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await openSettings(page);
  await expect(page.locator('#private-session-hint')).toContainText('private');
  await page.locator('#settings-close').click();
  await setAutosave(page, false);
  await expect(page.locator('#private-marker')).toBeVisible();
  await expect(status(page)).toHaveText(AUTOSAVE_OFF);
  await page.locator('#editor').press('End');
  await page.locator('#editor').pressSequentially(' правка');
  await expect(status(page)).toHaveText(AUTOSAVE_OFF);
});

test('Documents list shows the on-screen rename with autosave off', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Текст');
  await expect(status(page)).toHaveText('Saved locally');
  await page.getByRole('textbox', { name: 'Document title' }).fill('My title');
  await expect(status(page)).toHaveText('Saved locally');
  await openDocuments(page);
  await expect(page.locator('#drafts option:checked')).toHaveText(/My title \(current\)/);
  await setAutosave(page, false);
  await expect(page.locator('#autosave')).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document title' }).fill('New title');
  await openDocuments(page);
  await expect(page.locator('#drafts option:checked')).toHaveText(/New title \(current, unsaved\)/);
});

test('private session locks the per-document Autosave checkbox (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Сессия');
  await expect(status(page)).toHaveText('Saved locally');
  await setPrivateSession(page, true);
  await expect(page.locator('#autosave')).not.toBeChecked();
  await expect(page.locator('#autosave')).toBeDisabled();
  await expect(page.locator('#private-marker')).toBeVisible();
  await expect(status(page)).toHaveText(AUTOSAVE_OFF);
  await setPrivateSession(page, false);
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(page.locator('#autosave')).toBeChecked();
});

test('a private document reopens private (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Private reopen');
  await expect(status(page)).toHaveText('Saved locally');
  await setAutosave(page, false);
  await expect(page.locator('#private-marker')).toBeVisible();
  await expect.poll(async () => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const all = db.transaction('documents').objectStore('documents').getAll();
      all.onsuccess = () => {
        db.close();
        const docs = all.result as Array<{ private?: boolean; text?: string }>;
        resolve(docs.some(doc => doc.private === true && doc.text === 'Private reopen'));
      };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  }))).toBe(true);
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#editor')).toHaveValue('Private reopen');
  await expect(page.locator('#autosave')).not.toBeChecked();
  await expect(page.locator('#private-marker')).toBeVisible();
});
