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

test('paste and undo preserve clipboard content and caret', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('privet');
  await page.evaluate(() => navigator.clipboard.writeText('ABC 🙂'));
  await field.press('ControlOrMeta+v');
  await expect(field).toHaveValue('приветABC 🙂');
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('привет');
  await field.press('ControlOrMeta+Shift+z');
  await expect(field).toHaveValue('приветABC 🙂');
});

test('small screen retains an accessible editor and toggle', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 650 });
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('yozh');
  await expect(field).toHaveValue('ёж');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('composition keyboard undo is not intercepted by editor', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('a');
  const result = await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles:true }));
    const event = new KeyboardEvent('keydown', { key:'z', ctrlKey:true, isComposing:true, bubbles:true, cancelable:true });
    node.dispatchEvent(event);
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles:true }));
    return { prevented:event.defaultPrevented, value:node.value };
  });
  expect(result).toEqual({ prevented:false, value:'а' });
});
