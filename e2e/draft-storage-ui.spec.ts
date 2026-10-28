import { expect, test } from '@playwright/test';

test('legacy draft is migrated into the editor without changing its source', async ({ page }) => {
  const legacy = JSON.stringify([{ id: 'legacy-ui', title: 'Старый', text: 'Привет 🙂', updatedAt: 42,
    history: { current: 'Привет 🙂', undo: [{ value: 'Привет', start: 6, end: 6 }], redo: [] } }]);
  await page.addInitScript(raw => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('typebridge.drafts.v1', raw);
      sessionStorage.setItem('typebridge.activeDraft.v1', 'legacy-ui');
      sessionStorage.setItem('seeded', 'yes');
    }
  }, legacy);
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toHaveValue('Привет 🙂');
  await page.locator('#undo').click();
  await expect(field).toHaveValue('Привет');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('Привет');
  await expect(page.locator('#redo')).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('typebridge.drafts.v1'))).toBe(legacy);
});

test('a stale tab saves a visible conflict copy without overwriting the newer draft', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await page.locator('#editor').fill('Исходный текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const other = await context.newPage();
  await other.goto('/typebridge/');
  await expect(other.locator('#editor')).toHaveValue('Исходный текст');
  await page.locator('#editor').fill('Новое содержание');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await other.locator('#editor').fill('Другой вариант 🙂');
  await expect(other.locator('#status')).toContainText('conflict copy');
  await expect(other.locator('#drafts option')).toHaveCount(2);
  await other.reload();
  await expect(other.locator('#editor')).toHaveValue('Другой вариант 🙂');
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue('Новое содержание');
});

test('failed database initialization keeps text editable and reports unsaved state', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
  });
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(page.locator('#status')).toContainText('Storage unavailable');
  await field.fill('Нельзя потерять');
  await expect(page.locator('#status')).toContainText('Save failed');
  await expect(field).toHaveValue('Нельзя потерять');
  await page.locator('#new-draft').click();
  await expect(field).toHaveValue('Нельзя потерять');
});

test('switching immediately after typing saves the previous document', async ({ page }) => {
  await page.goto('/typebridge/');
  await page.locator('#editor').fill('Быстрый набор 🙂');
  await page.locator('#new-draft').click();
  await expect(page.locator('#editor')).toHaveValue('');
  await page.locator('#drafts').selectOption({ label: 'Untitled draft' });
  await expect(page.locator('#editor')).toHaveValue('Быстрый набор 🙂');
});

test('failed writes keep current text and can be retried without switching away', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'documents') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await page.locator('#editor').fill('Сохраните мои изменения');
  await expect(page.locator('#status')).toContainText('Save failed');
  await page.locator('#new-draft').click();
  await expect(page.locator('#editor')).toHaveValue('Сохраните мои изменения');
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await page.locator('#editor').fill('Сохраните мои изменения!');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue('Сохраните мои изменения!');
});

test('repeated edits during autosave persist the latest text', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  for (const text of ['Раз', 'Раз два', 'Раз два три 🙂']) {
    await field.fill(text);
    await page.waitForTimeout(180);
  }
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('Раз два три 🙂');
});

test('imports a text file into its own saved document', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#import-file').setInputFiles({
    name: 'post.txt', mimeType: 'text/plain', buffer: Buffer.from('Русский текст 🙂\nВторая строка'),
  });
  await expect(page.locator('#status')).toContainText('Imported as a new draft');
  await expect(page.locator('#editor')).toHaveValue('Русский текст 🙂\nВторая строка');
  await expect(page.locator('#draft-title')).toHaveValue('post');
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue('Русский текст 🙂\nВторая строка');
});
