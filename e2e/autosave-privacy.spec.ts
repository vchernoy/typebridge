import { expect, test, type Page } from '@playwright/test';
import { openDocuments, openSettings, setAutosave } from './settings-helpers';

const AUTOSAVE_OFF = 'Autosave off — text and title are not saved and will be lost on reload';
const status = (page: Page) => page.locator('#status-line');

async function chooseSavedCopy(page: Page, choice: 'keep' | 'delete'): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Delete the saved copy?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {
    name: choice === 'delete' ? 'Delete saved copy' : 'Keep saved copy',
  }).click();
  await expect(dialog).toBeHidden();
}

test('status line states privacy consequences when autosave is off', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await openSettings(page);
  await expect(page.locator('#autosave-hint')).toContainText('privacy mode');
  await page.locator('#autosave').uncheck();
  await chooseSavedCopy(page, 'keep');
  await expect(page.locator('#autosave')).toBeEnabled();
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

test('delete-saved-copy dialog Keep and Delete choices work with keyboard', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.locator('#editor');
  await field.fill('Оставить');
  await expect(status(page)).toHaveText('Saved locally');

  await openSettings(page);
  const autosaveToggle = page.getByRole('checkbox', { name: 'Autosave' });
  await autosaveToggle.focus();
  await autosaveToggle.uncheck();
  const dialog = page.getByRole('dialog', { name: 'Delete the saved copy?' });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep saved copy' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(autosaveToggle).toBeEnabled();
  await expect(autosaveToggle).toBeFocused();
  await expect(autosaveToggle).not.toBeChecked();
  await expect(status(page)).toHaveText(AUTOSAVE_OFF);
  await expect.poll(async () => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const all = db.transaction('documents').objectStore('documents').getAll();
      all.onsuccess = () => { db.close(); resolve(all.result.length); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  }))).toBe(1);

  await autosaveToggle.check();
  await expect(status(page)).toHaveText('Autosave on');
  await autosaveToggle.focus();
  await autosaveToggle.uncheck();
  await expect(dialog).toBeVisible();
  // Wait for Cancel focus before Tab — otherwise the trap may land on Keep when
  // Tab races the dialog open (Chromium CI flake).
  await expect(page.getByRole('button', { name: 'Keep saved copy' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Delete saved copy' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(autosaveToggle).toBeEnabled();
  await expect(autosaveToggle).toBeFocused();
  await expect(status(page)).toHaveText(AUTOSAVE_OFF);
  await expect.poll(async () => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const all = db.transaction('documents').objectStore('documents').getAll();
      all.onsuccess = () => { db.close(); resolve(all.result.length); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  }))).toBe(0);
});
