import { expect, test } from '@playwright/test';

test('find navigates forwards and backwards with wrap-around', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('Alpha beta alpha');
  await page.getByLabel('Find', { exact: true }).fill('alpha');
  await page.getByRole('button', { name: 'Next' }).click();
  expect(await field.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([0, 5]);
  await page.getByRole('button', { name: 'Next' }).click();
  expect(await field.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(11);
  await page.getByRole('button', { name: 'Next' }).click();
  expect(await field.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(0);
  await page.getByRole('button', { name: 'Previous' }).click();
  expect(await field.evaluate(el => (el as HTMLTextAreaElement).selectionStart)).toBe(11);
});

test('replace and replace all support undo, redo, case matching and literal punctuation', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('ETF etf ETF (test)');
  await page.getByLabel('Find', { exact: true }).fill('ETF');
  await page.getByLabel('Replace', { exact: true }).fill('fund');
  await page.getByRole('checkbox', { name: 'Match case' }).check();
  await page.getByRole('button', { name: 'Replace all' }).click();
  await expect(field).toHaveValue('fund etf fund (test)');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('ETF etf ETF (test)');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('fund etf fund (test)');
  await page.getByLabel('Find', { exact: true }).fill('(test)');
  await page.getByLabel('Replace', { exact: true }).fill('done');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(field).toHaveValue('fund etf fund done');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('fund etf fund (test)');
});

test('exports a Unicode draft and imports a JSON draft as a new document', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('Привет, мир!\\nВторая строка.');
  await page.getByRole('textbox', { name: 'Draft title' }).fill('Русский пост');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ]);
  expect(download.suggestedFilename().replaceAll('_', ' ')).toBe('Русский пост.typebridge.json');
  const fs = await import('node:fs/promises');
  const payload = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  expect(payload.draft.text).toBe('Привет, мир!\\nВторая строка.');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#import-file').setInputFiles({
    name: 'backup.typebridge.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(field).toHaveValue('Привет, мир!\\nВторая строка.');
  await expect(page.getByRole('textbox', { name: 'Draft title' })).toHaveValue('Русский пост');
  await expect(page.locator('#find-status')).not.toContainText('Import failed');
});
