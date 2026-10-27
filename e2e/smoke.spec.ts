import { expect, test } from '@playwright/test';

test('editor types transliteration, edits selections and supports history', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('privet');
  await expect(field).toHaveValue('привет');
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('приве');
  await field.press('ControlOrMeta+Shift+z');
  await expect(field).toHaveValue('привет');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 3));
  await field.pressSequentially('sh');
  await expect(field).toHaveValue('швет');
  await field.press('Backspace');
  await expect(field).toHaveValue('вет');
  await field.press('Delete');
  await expect(field).toHaveValue('ет');
});

test('toggle, paste and composition preserve text', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await page.getByLabel('Transliteration on').uncheck();
  await field.pressSequentially('hello');
  await expect(field).toHaveValue('hello');
  await page.getByLabel('Transliteration on').check();
  await field.evaluate(el => { const node = el as HTMLTextAreaElement; node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles:true })); node.value += '漢'; node.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertCompositionText', data:'漢', isComposing:true })); node.dispatchEvent(new CompositionEvent('compositionend', { bubbles:true, data:'漢' })); });
  await expect(field).toHaveValue('hello漢');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name:'Clear' }).click();
  await expect(field).toHaveValue('');
});
