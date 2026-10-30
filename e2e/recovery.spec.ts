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
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new Error('interrupted'); }; IDBObjectStore.prototype.add = function () { throw new Error('interrupted'); }; });
  await page.locator('#editor').fill('Несохранённая версия');
  await expect(page.locator('#status')).toContainText('Save failed');
  await page.close();
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

test('retry after committed recovery with failed journal cleanup does not duplicate copies', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new Error('interrupted'); }; IDBObjectStore.prototype.add = function () { throw new Error('interrupted'); }; });
  await page.locator('#editor').fill('Сохранить эту запись');
  await expect(page.locator('#status')).toContainText('Save failed');
  await page.close();
  const other = await context.newPage(); await other.goto('/typebridge/');
  await other.evaluate(() => {
    const original = Storage.prototype.removeItem;
    (window as unknown as { restoreRemove: () => void }).restoreRemove = () => { Storage.prototype.removeItem = original; };
    Storage.prototype.removeItem = function (key) {
      if (key.startsWith('typebridge.recovery.v1.')) throw new Error('interrupted cleanup');
      return original.call(this, key);
    };
  });
  const recover = other.getByRole('button', { name: /Recover Untitled draft/ });
  await recover.click();
  await expect(other.locator('#status')).toContainText('Recovery failed');
  await other.evaluate(() => (window as unknown as { restoreRemove: () => void }).restoreRemove());
  await recover.click();
  await expect(other.locator('#status')).toContainText('Recovered a copy');
  await expect(other.locator('#drafts option')).toHaveCount(2);
});

test('immediate reload recovers text after a failed IndexedDB save', async ({ page }) => {
  await page.addInitScript(() => {
    IDBObjectStore.prototype.put = function () { throw new Error('interrupted'); };
  });
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await editor.fill('Быстрая строка 🙂');
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(editor).toHaveValue('Быстрая строка 🙂');
  await expect(page.locator('#status')).toContainText('Save failed');
});

test('already committed emergency snapshot is removed without a duplicate', async ({ page }) => {
  await page.goto('/typebridge/');
  await page.locator('#editor').fill('Сохранённая запись 🙂');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    const id = sessionStorage.getItem('typebridge.activeDraft.v1')!;
    localStorage.setItem(`typebridge.recovery.v1.closed.${id}`, JSON.stringify({ token: 'saved-token', tab: 'closed', documentId: id, revision: 0, timestamp: Date.now(), title: 'Untitled draft', text: 'Сохранённая запись 🙂' }));
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.closed.')).length)).toBe(0);
  await expect(page.getByRole('button', { name: /Recover Untitled draft/ })).toHaveCount(0);
  await expect(page.locator('#drafts option')).toHaveCount(1);
});

test('confirmed discard removes only the selected unsaved snapshot', async ({ page }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await editor.fill('Текущий черновик');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    for (const token of ['a', 'b']) localStorage.setItem(`typebridge.recovery.v1.closed.${token}`, JSON.stringify({ token, tab: 'closed', documentId: token, revision: 0, timestamp: Date.now(), title: token, text: 'Несохранённый текст ' + token }));
  });
  const backupText = (token: string) => page.evaluate(key => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as { text: string }).text;
  }, `typebridge.recovery.v1.closed.${token}`);
  await page.reload();
  // The recovery panel renders asynchronously; wait for either its ownership prompt or the backups.
  const check = page.getByRole('button', { name: 'Check emergency backups' });
  const discardA = page.getByRole('button', { name: 'Discard backup for a' });
  await expect(check.or(discardA)).toBeVisible();
  if (await check.isVisible()) await check.click();
  page.once('dialog', dialog => dialog.dismiss());
  await discardA.click();
  await expect(discardA).toBeVisible();
  expect(await backupText('a')).toBe('Несохранённый текст a');
  page.once('dialog', dialog => dialog.accept());
  await discardA.click();
  await expect(discardA).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Discard backup for b' })).toBeVisible();
  expect(await backupText('a')).toBeNull();
  expect(await backupText('b')).toBe('Несохранённый текст b');
  await expect(editor).toHaveValue('Текущий черновик');
  await expect(page.locator('#drafts option')).toHaveCount(1);
});

test('active tab snapshots are not presented as lost; closing exposes them', async ({ page, context }) => {
  await page.goto('/typebridge/');
  const other = await context.newPage(); await other.goto('/typebridge/');
  await expect(other.locator('#editor')).toBeEnabled();
  await other.evaluate(() => {
    const observed = document.querySelector('[aria-label="Recover unsaved drafts"]')!;
    (window as unknown as { recoveryMutations: number }).recoveryMutations = 0;
    new MutationObserver(() => { (window as unknown as { recoveryMutations: number }).recoveryMutations++; }).observe(observed, { childList: true, subtree: true });
  });
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new Error('interrupted'); };
    IDBObjectStore.prototype.add = function () { throw new Error('interrupted'); };
  });
  await page.locator('#editor').fill('Важный черновик');
  await expect(page.locator('#status')).toContainText('Save failed');
  await other.waitForTimeout(1600); // Allow the coalesced journal notification to be processed.
  await expect(other.getByRole('button', { name: /Recover Untitled draft/ })).toHaveCount(0);
  expect(await other.evaluate(() => (window as unknown as { recoveryMutations: number }).recoveryMutations)).toBe(0);
  await page.close();
  const check = other.getByRole('button', { name: 'Check emergency backups' });
  await expect.poll(async () => await check.isVisible() || await other.getByRole('button', { name: /Recover Untitled draft/ }).isVisible(), { timeout: 10000 }).toBe(true);
  if (await check.isVisible()) await check.click();
  await expect(other.getByRole('button', { name: /Recover Untitled draft/ })).toBeVisible();
});
