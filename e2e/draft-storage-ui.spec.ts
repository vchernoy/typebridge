import { expect, test } from '@playwright/test';

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

test('old localStorage drafts are ignored and left untouched while IndexedDB saves', async ({ page, context }) => {
  const old = '[{"id":"old","title":"Старый","text":"Старый пост","updatedAt":1},invalid]';
  await page.addInitScript(raw => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('typebridge.drafts.v1', raw);
      sessionStorage.setItem('seeded', 'yes');
    }
  }, old);
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('');
  await field.fill('Новый пост 🙂\nВторая строка');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('Новый пост 🙂\nВторая строка');
  expect(await page.evaluate(() => localStorage.getItem('typebridge.drafts.v1'))).toBe(old);
  const other = await context.newPage();
  await other.goto('/typebridge/');
  await expect(other.locator('#editor')).toBeEnabled();
  const changed = '[{"id":"other","title":"Old tab","text":"Ignored","updatedAt":2}]';
  await other.evaluate(raw => localStorage.setItem('typebridge.drafts.v1', raw), changed);
  await expect(page.locator('#drafts option')).toHaveCount(1);
  await expect(field).toHaveValue('Новый пост 🙂\nВторая строка');
  await page.reload();
  await expect(field).toHaveValue('Новый пост 🙂\nВторая строка');
  expect(await page.evaluate(() => localStorage.getItem('typebridge.drafts.v1'))).toBe(changed);
});

for (const operation of ['reload', 'navigation'] as const) {
  test(`immediate ${operation} starts saving the pending edit`, async ({ page }) => {
    await page.goto('/typebridge/');
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    await field.fill('Начало поста');
    await expect(page.locator('#status')).toContainText('Saved locally');
    await field.fill('Начало поста — последняя фраза 🙂');
    page.once('dialog', dialog => dialog.accept());
    if (operation === 'reload') await page.reload();
    else await page.goto('/typebridge/?navigation=1');
    await expect(field).toHaveValue('Начало поста — последняя фраза 🙂');
  });
}

test('a committed save stays successful if refreshing the draft list fails', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.getAll;
    (window as unknown as { restoreGetAll: () => void }).restoreGetAll = () => { IDBObjectStore.prototype.getAll = original; };
    IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore['getAll']>) {
      if (this.name === 'documents') throw new Error('list unavailable');
      return original.apply(this, args);
    };
  });
  await field.fill('Текст ещё');
  await expect(page.locator('#status')).toContainText('Saved locally — draft list could not be refreshed');
  await page.locator('#new-draft').click();
  await expect(field).toHaveValue('');
  await page.evaluate(() => (window as unknown as { restoreGetAll: () => void }).restoreGetAll());
  await page.reload();
  await expect(field).toHaveValue('Текст ещё');
});

test('JSON export and import round trip preserves Cyrillic, newlines and emoji', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  const content = 'Русский пост 🙂\nВторая строка\nТретья строка 🌍';
  await field.fill(content);
  await page.locator('#draft-title').fill('Проверка');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-json').click()]);
  const fs = await import('node:fs/promises');
  const bytes = await fs.readFile((await download.path())!);
  expect(JSON.parse(bytes.toString()).draft.text).toBe(content);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#import-file').setInputFiles({ name: 'post.typebridge.json', mimeType: 'application/json', buffer: bytes });
  await expect(page.locator('#status')).toContainText('Imported as a new draft');
  await expect(field).toHaveValue(content);
  await page.reload();
  await expect(field).toHaveValue(content);
});

test('long editing history survives draft switching and reload', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#enabled').uncheck();
  const original = 'Длинный русский текст 🙂\n'.repeat(200);
  await field.fill(original);
  await field.fill(original + 'Первая правка');
  await field.fill(original + 'Вторая правка');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.locator('#draft-title').fill('Длинный пост');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.locator('#new-draft').click();
  await expect(field).toHaveValue('');
  await page.locator('#drafts').selectOption({ label: 'Длинный пост' });
  await expect(field).toHaveValue(original + 'Вторая правка');
  await page.locator('#undo').click();
  await expect(field).toHaveValue(original + 'Первая правка');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue(original + 'Первая правка');
  await page.locator('#redo').click();
  await expect(field).toHaveValue(original + 'Вторая правка');
});

test('closing a tab immediately after editing starts a save', async ({ page, context }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Начало');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await field.fill('Начало — последняя фраза');
  page.once('dialog', dialog => dialog.accept());
  const closed = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await closed;
  const next = await context.newPage();
  await next.goto('/typebridge/');
  await expect(next.locator('#editor')).toHaveValue('Начало — последняя фраза');
});

test('reload recovery preserves another tab’s newer revision', async ({ page, context }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Исходный документ');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const pending = await page.evaluate(() => new Promise<{ id: string; title: string; text: string; updatedAt: number; revision: number }>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('documents'); const get = tx.objectStore('documents').getAll(); get.onsuccess = () => { db.close(); resolve({ ...get.result[0], text: 'Несохранённый вариант 🙂', history: undefined }); }; get.onerror = () => reject(get.error); };
  }));
  const other = await context.newPage();
  await other.goto('/typebridge/');
  await expect(other.locator('#editor')).toHaveValue('Исходный документ');
  await other.locator('#editor').fill('Новая версия другой вкладки');
  await expect(other.locator('#status')).toContainText('Saved locally');
  await page.evaluate(draft => sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify(draft)), pending);
  await page.reload();
  await expect(field).toHaveValue('Несохранённый вариант 🙂');
  await expect(page.locator('#status')).toContainText('conflict copy');
  await expect(page.locator('#drafts option')).toHaveCount(2);
  await other.reload();
  await expect(other.locator('#editor')).toHaveValue('Новая версия другой вкладки');
});
