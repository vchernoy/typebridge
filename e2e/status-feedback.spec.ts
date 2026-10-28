import { expect, test, type Page } from '@playwright/test';

// Status-line races from #52. Timers are controlled with Playwright's clock and
// saves are observed in IndexedDB, so no test depends on sleeps or retries.
function storedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const all = db.transaction('documents').objectStore('documents').getAll();
      all.onsuccess = () => { db.close(); resolve(all.result.map((draft: { text: string }) => draft.text)); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  }));
}
const status = (page: Page) => page.locator('#status');

test('a background autosave does not replace newer conversion guidance', async ({ page }) => {
  await page.clock.install();
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await expect(field).toBeEnabled();
  await field.fill('zhuk');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('zhuk');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 4));
  await field.press('Control+Shift+L');
  await expect(field).toHaveValue('жук');
  await expect(status(page)).toHaveText('Saving…');
  // The conversion's autosave is still pending when the guidance appears.
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(status(page)).toHaveText('Select text to convert');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('жук');
  await expect(status(page)).toHaveText('Select text to convert');
  // The next edit returns the line to save progress.
  await field.press('End');
  await field.pressSequentially('i');
  await page.clock.runFor(400);
  await expect(status(page)).toHaveText('Saved locally');
});

test('a failed save stays visible after later action feedback until a save succeeds', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  });
  await field.press('End');
  await field.pressSequentially(' несохранено');
  await expect(status(page)).toContainText('Save failed');
  await page.locator('#export-txt').click();
  await expect(status(page)).toContainText('Text exported');
  await expect(status(page)).toContainText('Save failed — your text is unsaved');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(status(page)).toContainText('Select text to convert');
  await expect(status(page)).toContainText('Save failed');
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await field.press('End');
  await field.pressSequentially('!');
  await expect(status(page)).toHaveText('Saved locally');
  await expect.poll(() => storedTexts(page)).toContain('Сохранено несохранено!');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported');
});

test('save progress messages are replaced when the save they announce succeeds', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave off');
  await field.press('End');
  await field.pressSequentially(' правка');
  await expect(status(page)).toHaveText('Autosave off — changes are unsaved');
  await page.locator('#autosave').check();
  await expect.poll(() => storedTexts(page)).toContain('Сохранено правка');
  await expect(status(page)).toHaveText('Saved locally');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await page.locator('#autosave').check();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave on');
});

test('recovered text reports a completed save', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', 'yes');
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({
      id: 'pending-status', title: 'Черновик', text: 'Восстановленный текст', updatedAt: 1, revision: 0,
    }));
  });
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toHaveValue('Восстановленный текст');
  await expect.poll(() => storedTexts(page)).toContain('Восстановленный текст');
  await expect(status(page)).toHaveText('Saved locally');
});

test('discarding text after a failed save stops reporting unsaved text', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  });
  await field.press('End');
  await field.pressSequentially(' несохранено');
  await expect(status(page)).toContainText('Save failed');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); // Discard unsaved changes.
  await page.locator('#new-draft').click();
  await expect(field).toHaveValue('');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported');
});
