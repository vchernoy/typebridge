import { expect, test } from '@playwright/test';

const valid = { id: 'good', title: 'Важный пост', text: 'Длинный текст 🙂', updatedAt: 100 };
for (const [name, raw] of [
  ['invalid record and missing id', JSON.stringify([valid, { id: 'odd', text: 'keep', title: 'bad' }, { title: 'missing', text: 'keep', updatedAt: 2 }])],
  ['duplicate ids', JSON.stringify([valid, { id: 'dup', title: 'one', text: 'one', updatedAt: 1 }, { id: 'dup', title: 'two', text: 'two', updatedAt: 2 }])],
  ['malformed JSON', '{bad'],
  ['non-array JSON', '{"draft":"keep"}'],
] as const) {
  test(`quarantines ${name} without blocking editing`, async ({ page }) => {
    await page.addInitScript(raw => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('typebridge.drafts.v1', raw);
        sessionStorage.setItem('seeded', '1');
      }
    }, raw);
    await page.goto('/typebridge/');
    const editor = page.locator('#editor');
    await expect(editor).toBeEnabled();
    await expect(page.getByRole('alert')).toContainText('could not be imported');
    if (raw.startsWith('[')) await expect(editor).toHaveValue(valid.text);
    await editor.fill('Новые изменения');
    await expect(page.locator('#status')).toContainText('Saved locally');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export legacy backup' }).click()]);
    const fs = await import('node:fs/promises');
    expect(JSON.parse(await fs.readFile((await download.path())!, 'utf8'))[0].raw).toBe(raw);
    await page.reload();
    await expect(editor).toHaveValue('Новые изменения');
    expect(await page.evaluate(() => localStorage.getItem('typebridge.drafts.v1'))).toBe(raw);
  });
}

test('old tab changes create one visible recovery copy without overwriting the current document', async ({ page, context }) => {
  const initial = JSON.stringify([valid]);
  await page.addInitScript(raw => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('typebridge.drafts.v1', raw); sessionStorage.setItem('seeded', '1'); } }, initial);
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toHaveValue(valid.text);
  await page.locator('#editor').fill('Новая версия');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const oldTab = await context.newPage();
  await oldTab.goto('/typebridge/');
  await expect(oldTab.locator('#editor')).toBeEnabled();
  const changed = JSON.stringify([{ ...valid, text: 'Правка старой вкладки', updatedAt: 200 }]);
  await oldTab.evaluate(raw => localStorage.setItem('typebridge.drafts.v1', raw), changed);
  await expect(page.getByRole('alert')).toContainText('older TypeBridge tab');
  await expect(page.locator('#drafts option')).toHaveCount(2);
  await expect(page.locator('#editor')).toHaveValue('Новая версия');
  await page.reload();
  await expect(page.locator('#drafts option')).toHaveCount(2);
  await page.locator('#drafts').selectOption({ label: 'Важный пост (legacy recovery)' });
  await expect(page.locator('#editor')).toHaveValue('Правка старой вкладки');
  expect(await page.evaluate(() => localStorage.getItem('typebridge.drafts.v1'))).toBe(changed);
});

for (const saved of [false, true]) for (const delay of [0, 800]) {
  test(`delete pending edits: saved=${saved}, confirmation delay=${delay}`, async ({ page }) => {
    await page.goto('/typebridge/');
    const editor = page.locator('#editor');
    await expect(editor).toBeEnabled();
    if (saved) { await editor.fill('Saved'); await expect(page.locator('#status')).toContainText('Saved locally'); }
    await editor.fill('Pending');
    page.once('dialog', async dialog => { if (delay) await new Promise(resolve => setTimeout(resolve, delay)); await dialog.accept(); });
    await page.locator('#delete-draft').click();
    await expect(page.locator('#status')).toHaveText('Draft deleted');
    await page.waitForTimeout(600);
    await expect(editor).toHaveValue('');
    await expect(page.locator('#drafts option')).toHaveCount(1);
    await page.reload();
    await expect(editor).toHaveValue('');
    await expect(page.locator('#drafts option')).toHaveCount(1);
  });
}

test('database version change closes the old connection and warns the editor', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const second = await context.newPage();
  await second.goto('/typebridge/');
  await expect(second.locator('#editor')).toBeEnabled();
  const upgraded = await second.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('typebridge', 2);
    request.onsuccess = () => { request.result.close(); resolve(true); };
    request.onerror = () => reject(request.error);
  }));
  expect(upgraded).toBe(true);
  await expect(page.getByRole('alert')).toContainText('upgraded in another tab');
});

test('canceling deletion retains pending edits and autosave', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Оставить текст');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#delete-draft').click();
  await expect(page.locator('#editor')).toHaveValue('Оставить текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue('Оставить текст');
});

test('failed deletion keeps the text and allows retry', async ({ page }) => {
  await page.goto('/typebridge/');
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
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-draft').click();
  await expect(page.locator('#status')).toContainText('Could not delete draft');
  await expect(editor).toHaveValue('Не потерять');
  await page.evaluate(() => (window as unknown as { restoreDelete: () => void }).restoreDelete());
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-draft').click();
  await expect(page.locator('#status')).toHaveText('Draft deleted');
  await expect(editor).toHaveValue('');
});

test('stale deletion retries saving pending edits as a conflict copy', async ({ page, context }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Исходный длинный пост');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const other = await context.newPage();
  await other.goto('/typebridge/');
  await expect(other.locator('#editor')).toHaveValue('Исходный длинный пост');
  await other.locator('#editor').fill('Версия другой вкладки');
  await expect(other.locator('#status')).toContainText('Saved locally');
  await editor.fill('Важная правка первой вкладки 🙂');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-draft').click();
  await expect(page.locator('#status')).toContainText('conflict copy');
  await page.reload();
  await expect(editor).toHaveValue('Важная правка первой вкладки 🙂');
  await expect(page.locator('#drafts option')).toHaveCount(2);
});

test('selecting current draft preserves pending text and undo history', async ({ page }) => {
  await page.goto('/typebridge/');
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
  await page.goto('/typebridge/');
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
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-draft').click();
  await expect(page.locator('#status')).toContainText('Draft deleted, but');
  await expect(editor).toHaveValue('');
  await page.evaluate(() => (window as unknown as { restoreGetAll: () => void }).restoreGetAll());
  await page.reload();
  await expect(editor).toHaveValue('');
});

test('repeated old-tab writes reuse one recovery draft and preserve intermediate versions', async ({ page, context }) => {
  const malformed = { id: 'bad', text: 'невалидный' };
  const original = { ...valid, text: 'Оригинал', updatedAt: 1 };
  await page.addInitScript(raw => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('typebridge.drafts.v1', raw); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify([original, malformed]));
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toHaveValue('Оригинал');
  const old = await context.newPage();
  await old.goto('/typebridge/');
  await expect(old.locator('#editor')).toBeEnabled();
  for (let i = 1; i <= 10; i++) {
    await old.evaluate(([record, bad, n]) => localStorage.setItem('typebridge.drafts.v1', JSON.stringify([{ ...record, text: `Русский вариант ${n} 🙂`, updatedAt: n + 1 }, bad])), [original, malformed, i] as const);
  }
  await expect.poll(async () => page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction('documents'); const req = tx.objectStore('documents').getAll(); req.onsuccess = () => { db.close(); resolve(req.result.map((d: { text: string }) => d.text)); }; req.onerror = () => reject(req.error); };
  }))).toContain('Русский вариант 10 🙂');
  await expect(page.locator('#drafts option')).toHaveCount(2);
  await expect(page.getByRole('alert')).toContainText('1 legacy record(s)');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export legacy backup' }).click()]);
  const fs = await import('node:fs/promises');
  const archive = JSON.parse(await fs.readFile((await download.path())!, 'utf8')) as Array<{ kind: string; draft?: { text: string } }>;
  expect(archive.filter(item => item.kind === 'legacy-backup')).toHaveLength(1);
  for (let i = 1; i < 10; i++) expect(archive.some(item => item.draft?.text === `Русский вариант ${i} 🙂`)).toBe(true);
  await expect(page.locator('#editor')).toHaveValue('Оригинал');
});
