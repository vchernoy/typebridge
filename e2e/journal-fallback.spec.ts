import { expect, test } from '@playwright/test';

/** Keys for the emergency localStorage journal (#53 / #37 R2c). */
async function journalKeys(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('typebridge.recovery.v1.')));
}

async function journalPayloads(page: import('@playwright/test').Page): Promise<Array<{ title: string; text: string }>> {
  return page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('typebridge.recovery.v1.'))
    .map(key => {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) as { title: string; text: string } : { title: '', text: '' };
      return { title: parsed.title, text: parsed.text };
    }));
}

test('after the first committed save, normal typing writes no recovery journal (#37 R2c 2d-2)', async ({ page }) => {
  // Fails on old code: every edit writes typebridge.recovery.v1.* while Autosave is on.
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первая сохранённая');
  await expect(page.locator('#status')).toContainText('Saved locally');
  // Drop any journal left from the pre-first-save window; exact-version cleanup may already have.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
  });
  await field.press('End');
  await page.keyboard.type(' и ещё');
  await expect(field).toHaveValue('Первая сохранённая и ещё');
  // Give a stray journal write every chance to land.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  expect(await journalKeys(page)).toEqual([]);
});

test('before the first save, the journal holds the latest text (#37 R2c 2d-2)', async ({ page }) => {
  // Fails if the journal is never written before a run starts (over-eager skip).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  // Hold full saves so the first commit never starts a change-log run.
  await page.evaluate(() => { (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 60_000; });
  await field.fill('До первого сохранения');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'До первого сохранения' })]),
  );
});

test('when change-log writes fail, the journal holds the latest text and title (#37 R2c 2d-2)', async ({ page }) => {
  // Fails on old code that keeps journaling every keystroke even when the log works, or that
  // does not journal immediately when only the `changes` store rejects (no onUnprotected path).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#draft-title').fill('Заголовок');
  await field.fill('Основа');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
    const put = IDBObjectStore.prototype.put;
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'changes') throw new Error('change log full');
      return put.apply(this, args);
    };
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'changes') throw new Error('change log full');
      return add.apply(this, args);
    };
  });
  await page.locator('#draft-title').fill('Новое имя');
  await field.click();
  await field.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Новое имя', text: 'Основа!' })]),
  );
});

test('when all IndexedDB writes fail, the journal still holds the unsaved edit (#37 R2c 2d-2)', async ({ page }) => {
  // Same meaning as today's recovery suite: a total IDB failure still journals (fails if the
  // gate skips journaling whenever a run once existed, ignoring IndexedDB unusable / failed appends).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Оригинал');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
    IDBObjectStore.prototype.put = function () { throw new Error('storage dead'); };
    IDBObjectStore.prototype.add = function () { throw new Error('storage dead'); };
  });
  await field.fill('Несохранённое');
  await expect(page.locator('#status')).toContainText('Save failed');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Несохранённое' })]),
  );
});

test('a stale journal warning clears once the change log protects edits (#37 R2c 2d-2)', async ({ page }) => {
  // Fails if the protected path returns without clearing journalWarning (#254 Codex P2).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { __typebridgeRestoreSetItem?: () => void }).__typebridgeRestoreSetItem = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('typebridge.recovery.v1.')) throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await field.fill('Пока без журнала');
  await expect(page.getByRole('alert').filter({ hasText: 'Emergency backup unavailable' })).toBeVisible();
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    (window as unknown as { __typebridgeRestoreSetItem?: () => void }).__typebridgeRestoreSetItem?.();
  });
  await field.press('End');
  await page.keyboard.type('!');
  await expect(page.getByRole('alert').filter({ hasText: 'Emergency backup unavailable' })).toHaveCount(0);
});
