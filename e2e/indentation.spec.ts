import { expect, test } from '@playwright/test';

const U = '    ';
const selection = (el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd];

test.beforeEach(async ({ page }) => {
  await page.goto('/typebridge/');
  await page.locator('#enabled').uncheck();
  await expect(page.locator('#editor')).toBeEnabled();
});

test('Tab at a caret inserts one indentation unit as one undo step', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('Привет');
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await editor.press('Tab');
  await expect(editor).toHaveValue(U + 'Привет');
  await expect(editor).toBeFocused();
  expect(await editor.evaluate(selection)).toEqual([4, 4]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveValue('Привет');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(editor).toHaveValue(U + 'Привет');
});

test('Tab and Shift+Tab indent and outdent every selected line', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('один\nдва\nтри');
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 8));
  await editor.press('Tab');
  await expect(editor).toHaveValue(U + 'один\n' + U + 'два\nтри');
  expect(await editor.evaluate(selection)).toEqual([0, 16]);
  await editor.press('Shift+Tab');
  await expect(editor).toHaveValue('один\nдва\nтри');
  expect(await editor.evaluate(selection)).toEqual([0, 8]);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveValue(U + 'один\n' + U + 'два\nтри');
});

test('keyboard users can always leave the editor', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('plain line');
  // Shift+Tab with nothing to outdent moves focus backward as usual.
  await editor.press('Shift+Tab');
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveValue('plain line');
  // Turning the setting off restores normal Tab navigation, and it survives reload.
  await page.locator('#tab-indent').uncheck();
  await editor.focus();
  await editor.press('Tab');
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveValue('plain line');
  await page.reload();
  await expect(page.locator('#tab-indent')).not.toBeChecked();
});

test('Tab over blank lines keeps focus in the editor', async ({ page }) => {
  const editor = page.locator('#editor');
  await editor.fill('a\n\n\nb');
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 4));
  await editor.press('Tab');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('a\n\n\nb');
});
