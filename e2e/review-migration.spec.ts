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
