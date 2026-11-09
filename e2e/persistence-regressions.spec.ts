import { answerNextConfirmation } from './settings-helpers';
import { expect, test } from '@playwright/test';
import { documentAction } from './settings-helpers';
import { writeForeignRevision } from './storage-helpers';

for (const saved of [false, true]) for (const delay of [0, 800]) {
  test(`delete pending edits: saved=${saved}, confirmation delay=${delay}`, async ({ page }) => {
    await page.goto('/editor.html');
    const editor = page.locator('#editor');
    await expect(editor).toBeEnabled();
    if (saved) { await editor.fill('Saved'); await expect(page.locator('#status')).toContainText('Saved locally'); }
    await editor.fill('Pending');
    const confirmation1 = answerNextConfirmation(page, true, delay);
    await documentAction(page, '#delete-draft');
    await confirmation1;
    await expect(page.locator('#status')).toHaveText('Document deleted');
    await page.waitForTimeout(600);
    await expect(editor).toHaveValue('');
    await expect(page.locator('#drafts option')).toHaveCount(1);
    await page.reload();
    await expect(editor).toHaveValue('');
    await expect(page.locator('#drafts option')).toHaveCount(1);
  });
}

test('database version change closes the old connection and warns the editor', async ({ page, context }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const second = await context.newPage();
  await second.goto('/editor.html');
  await expect(second.locator('#editor')).toBeEnabled();
  const upgraded = await second.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('typebridge', 3);
    request.onsuccess = () => { request.result.close(); resolve(true); };
    request.onerror = () => reject(request.error);
  }));
  expect(upgraded).toBe(true);
  await expect(page.getByRole('alert')).toContainText('upgraded in another tab');
});

test('canceling deletion retains pending edits and autosave', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Оставить текст');
  const confirmation2 = answerNextConfirmation(page, false);
  await documentAction(page, '#delete-draft');
  await confirmation2;
  await expect(page.locator('#editor')).toHaveValue('Оставить текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue('Оставить текст');
});

test('failed deletion keeps the text and allows retry', async ({ page }) => {
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Не потерять');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    (window as unknown as { restoreDelete: () => void }).restoreDelete = () => { IDBObjectStore.prototype.delete = original; };
    IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
      if (this.name === 'documents') throw new DOMException('write failed', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  const confirmation3 = answerNextConfirmation(page, true);
  await documentAction(page, '#delete-draft');
  await confirmation3;
  await expect(page.locator('#status')).toContainText('Could not delete document');
  await expect(editor).toHaveValue('Не потерять');
  await page.evaluate(() => (window as unknown as { restoreDelete: () => void }).restoreDelete());
  const confirmation4 = answerNextConfirmation(page, true);
  await documentAction(page, '#delete-draft');
  await confirmation4;
  await expect(page.locator('#status')).toHaveText('Document deleted');
  await expect(editor).toHaveValue('');
});

test('stale deletion retries saving pending edits as a conflict copy', async ({ page }) => {
  // install() alone lets fake time flow; pause so only runFor() fires timers (#132 CI).
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/editor.html');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Исходный длинный пост');
  await page.clock.runFor(400);
  await expect(page.locator('#status')).toContainText('Saved locally');
  // A newer revision from a build without edit ownership (#159 W4 keeps current tabs read-only).
  await writeForeignRevision(page, { text: 'Версия другой вкладки' });
  // Leave the pending edit's 300ms autosave unfired so Delete still sees dirty text
  // and must flush a conflict copy (slow Documents menu must not win the race).
  await editor.fill('Важная правка первой вкладки 🙂');
  const confirmation5 = answerNextConfirmation(page, true);
  await documentAction(page, '#delete-draft');
  await confirmation5;
  await expect(page.locator('#status-line')).toContainText('conflict copy');
  await page.reload();
  await expect(editor).toHaveValue('Важная правка первой вкладки 🙂');
  await expect(page.locator('#drafts option')).toHaveCount(2);
});

test('selecting current draft preserves pending text and undo history', async ({ page }) => {
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await page.locator('#enabled').uncheck();
  await editor.fill('Первая версия');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await editor.fill('Первая версия плюс новое');
  await page.locator('#drafts').dispatchEvent('change');
  await expect(editor).toHaveValue('Первая версия плюс новое');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.locator('#undo').click();
  await expect(editor).toHaveValue('Первая версия');
});

test('post-delete list failure does not pretend deleted text is still saved', async ({ page }) => {
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Русский пост и история');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.getAll;
    (window as unknown as { restoreGetAll: () => void }).restoreGetAll = () => { IDBObjectStore.prototype.getAll = original; };
    IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore['getAll']>) {
      if (this.name === 'documents') throw new Error('list unavailable');
      return original.apply(this, args);
    };
  });
  const confirmation6 = answerNextConfirmation(page, true);
  await documentAction(page, '#delete-draft');
  await confirmation6;
  await expect(page.locator('#status')).toContainText('Document deleted, but');
  await expect(editor).toHaveValue('');
  await page.evaluate(() => (window as unknown as { restoreGetAll: () => void }).restoreGetAll());
  await page.reload();
  await expect(editor).toHaveValue('');
});

test('a failed IndexedDB deletion retries pending autosave without further typing', async ({ page }) => {
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Сохранённый текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.delete;
    (window as unknown as { restoreDelete: () => void }).restoreDelete = () => { IDBObjectStore.prototype.delete = original; };
    IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
      if (this.name === 'documents') throw new DOMException('write failed', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await editor.fill('Новая несохранённая правка 🙂');
  const confirmation7 = answerNextConfirmation(page, true);
  await documentAction(page, '#delete-draft');
  await confirmation7;
  await expect(page.locator('#status')).toContainText('Could not delete document');
  await page.evaluate(() => (window as unknown as { restoreDelete: () => void }).restoreDelete());
  await page.reload();
  await expect(editor).toHaveValue('Новая несохранённая правка 🙂');
});
