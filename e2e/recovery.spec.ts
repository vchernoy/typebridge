import { expect, test } from '@playwright/test';

test('interrupted write and immediate tab close leave a recoverable Unicode copy', async ({ page, context }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await editor.fill('Начало');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('test failure', 'QuotaExceededError'); };
  });
  await editor.fill('Начало — последняя фраза 🙂\nВторая строка');
  page.once('dialog', dialog => dialog.accept());
  await page.close({ runBeforeUnload: true });
  const next = await context.newPage();
  await next.goto('/typebridge/');
  const recover = next.getByRole('button', { name: /Recover Untitled draft/ });
  await expect(recover).toBeVisible();
  await recover.click();
  await expect(next.locator('#status')).toContainText('Recovered a copy');
  await next.locator('#drafts').selectOption({ label: 'Untitled draft (recovered)' });
  await expect(next.locator('#editor')).toHaveValue('Начало — последняя фраза 🙂\nВторая строка');
  await next.reload();
  await expect(next.locator('#editor')).toHaveValue('Начало — последняя фраза 🙂\nВторая строка');
});

test('recovery keeps a newer version from another tab and does not clear a newer journal', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await page.locator('#editor').fill('Оригинал');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const other = await context.newPage(); await other.goto('/typebridge/');
  await other.locator('#editor').fill('Новая версия');
  await expect(other.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new Error('interrupted'); }; });
  await page.locator('#editor').fill('Несохранённая версия');
  await expect(page.locator('#status')).toContainText('Save failed');
  const third = await context.newPage(); await third.goto('/typebridge/');
  await third.getByRole('button', { name: /Recover Untitled draft/ }).click();
  await expect(third.locator('#status')).toContainText('Recovered a copy');
  await third.locator('#drafts').selectOption({ label: 'Untitled draft (recovered)' });
  await expect(third.locator('#editor')).toHaveValue('Несохранённая версия');
  await other.reload(); await expect(other.locator('#editor')).toHaveValue('Новая версия');
});

test('autosave off does not create an emergency journal for new edits', async ({ page }) => {
  await page.goto('/typebridge/');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#autosave').uncheck();
  await page.locator('#editor').fill('Только в памяти');
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('typebridge.recovery.v1.')))).toEqual([]);
});

test('journal quota failures are visible while editing remains available', async ({ page }) => {
  await page.goto('/typebridge/');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('typebridge.recovery.v1.')) throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.locator('#editor').fill('Мой текст');
  await expect(page.getByRole('alert').filter({ hasText: 'Emergency backup unavailable' })).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('Мой текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
});
