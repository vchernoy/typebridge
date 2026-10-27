import { expect, test } from '@playwright/test';

test('converts only selection in both directions with undo and redo', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('Hello privet мир');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(6, 12));
  await page.getByRole('button', { name: '→ АБВ' }).click();
  await expect(field).toHaveValue('Hello привет мир');
  expect(await field.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([6, 12]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('Hello privet мир');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('Hello привет мир');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(6, 12));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(field).toHaveValue('Hello privet мир');
});

test('shortcut converts selection and empty selection does not change document', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('zhuk');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 4));
  await field.press('Control+Shift+L');
  await expect(field).toHaveValue('жук');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(field).toHaveValue('жук');
  await expect(page.locator('#status')).toContainText('Select text to convert');
});
