import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/typebridge/');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
});

test('grouped typing, undo, redo and persistence after reload', async ({ page }) => {
  const field = page.locator('#editor');
  await page.locator('#enabled').uncheck();
  await field.fill('');
  await field.focus();
  await page.keyboard.type('hello', { delay: 25 });
  await expect(field).toHaveValue('hello');
  await page.locator('#undo').click();
  await expect(field).toHaveValue('');
  await page.locator('#redo').click();
  await expect(field).toHaveValue('hello');
  await page.waitForTimeout(500);
  await page.reload();
  await expect(field).toHaveValue('hello');
  await page.locator('#undo').click();
  await expect(field).toHaveValue('');
});

test('paste, delete and selection are reversible', async ({ page }) => {
  const field = page.locator('#editor');
  await page.locator('#enabled').uncheck();
  await field.fill('one two three');
  // fill is an input event, and is saved as an edit.
  await field.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(4, 7); });
  await page.keyboard.insertText('FOUR');
  await expect(field).toHaveValue('one FOUR three');
  await page.locator('#undo').click();
  await expect(field).toHaveValue('one two three');
  await expect(field).toHaveJSProperty('selectionStart', 4);
  await expect(field).toHaveJSProperty('selectionEnd', 7);
  await page.locator('#redo').click();
  await expect(field).toHaveValue('one FOUR three');
});

