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
  payload.draft.text = 'Импортировано 🙂';
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#import-file').setInputFiles({
    name: 'backup.typebridge.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(payload)),
  });
  await expect(page.locator('#status')).toContainText('Imported as a new draft');
  await expect(field).toHaveValue('Импортировано 🙂');
  await page.reload();
  await expect(field).toHaveValue('Импортировано 🙂');
  await expect(page.locator('#drafts option')).toHaveCount(2);
});

test('word statistics count Cyrillic, Latin, punctuation and update on undo', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('Привет, мир! Hello 2026.');
  await expect(page.locator('#count')).toHaveText('24 characters · 4 words · 1 min read');
  await field.fill('');
  await expect(page.locator('#count')).toHaveText('0 characters · 0 words · 0 min read');
});

test('regex find and replace supports captures, named groups, undo and invalid patterns', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('2026-10-27 and 2026-11-03');
  await page.getByRole('checkbox', { name: 'Regex (.*)' }).check();
  await page.getByLabel('Find', { exact: true }).fill('(?<year>\\d{4})-(\\d{2})-(\\d{2})');
  await page.getByLabel('Replace', { exact: true }).fill('$3/$2/$<year>');
  await page.getByRole('button', { name: 'Replace all' }).click();
  await expect(field).toHaveValue('27/10/2026 and 03/11/2026');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('2026-10-27 and 2026-11-03');
  await page.getByLabel('Find', { exact: true }).fill('(');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#find-status')).toContainText('Invalid regex');
});

test('focus mode preserves text, selection and editor undo history', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('Привет, мир');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(2, 5));
  await page.getByRole('button', { name: 'Focus mode', exact: true }).click();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('.find-bar')).toBeHidden();
  expect(await field.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([2, 5]);
  await field.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(field).toHaveValue('Привет, мир');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});

test('Find and Replace share the global transliteration mode, in Regex mode too', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const find = page.locator('#find-text');
  const replacement = page.locator('#replace-text');
  await find.pressSequentially('privet');
  await replacement.pressSequentially('mir');
  await expect(find).toHaveValue('привет');
  await expect(replacement).toHaveValue('мир');
  await page.locator('#enabled').uncheck();
  await find.focus();
  await find.press('End');
  await find.pressSequentially(' xyz');
  await expect(find).toHaveValue('привет xyz');
  await page.locator('#enabled').check();
  await page.locator('#regex-mode').check();
  await find.fill('');
  await find.pressSequentially('sh');
  await replacement.fill('$1');
  await expect(find).toHaveValue('ш');
  await expect(replacement).toHaveValue('$1');
});

test('a Regex pattern can mix Russian letters and Latin syntax by toggling the shortcut (#102)', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#enabled').uncheck();
  await field.fill('привет   мир, привет мир');
  await page.locator('#enabled').check();
  await page.locator('#regex-mode').check();
  const find = page.locator('#find-text');
  await find.click();
  await find.pressSequentially('privet');
  await find.press('Control+Shift+Space');
  await expect(page.locator('#enabled')).not.toBeChecked();
  await find.pressSequentially('\\s+');
  await find.press('Control+Shift+Space');
  await expect(page.locator('#enabled')).toBeChecked();
  await find.pressSequentially('mir');
  await expect(find).toHaveValue('привет\\s+мир');
  await page.locator('#replace-all').click();
  await expect(page.locator('#find-status')).toHaveText('Replaced 2 matches');
  await expect(field).toHaveValue(', ');
});

test('Find supports selection replacement and leaves IME composition untouched', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const find = page.locator('#find-text');
  await find.pressSequentially('mir');
  await find.evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 2));
  await page.keyboard.type('sh');
  await expect(find).toHaveValue('шр');
  await find.evaluate((el: HTMLInputElement) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value += '日本';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  await expect(find).toHaveValue('шр日本');
});
