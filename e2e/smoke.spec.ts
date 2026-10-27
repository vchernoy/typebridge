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

test('cut and selection replacement are undoable with selections intact', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await page.getByLabel('Transliteration on').uncheck();
  await field.pressSequentially('abcdef');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(1, 4));
  await field.press('ControlOrMeta+x');
  await expect(field).toHaveValue('aef');
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('abcdef');
  expect(await field.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([1,4]);
  await field.pressSequentially('X');
  await expect(field).toHaveValue('aXef');
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('abcdef');
});

test('non-cancelable input records actual mutation and ignores no-op beforeinput', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('a');
  await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:false, inputType:'insertText', data:'b' }));
    node.value += 'b';
    node.setSelectionRange(node.value.length,node.value.length);
    node.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:'b' }));
    node.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:true, inputType:'deleteContentBackward' }));
  });
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('а');
  await field.press('ControlOrMeta+Shift+z');
  await expect(field).toHaveValue('аb');
});

test('composition updates form one undoable edit', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name:'Your text' });
  await field.pressSequentially('a');
  await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles:true }));
    node.value += '漢';
    node.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertCompositionText', data:'漢', isComposing:true }));
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles:true, data:'漢' }));
    node.setSelectionRange(node.value.length,node.value.length);
  });
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('а');
  await field.press('ControlOrMeta+Shift+z');
  await expect(field).toHaveValue('а漢');
});

test('non-cancelable native history discards stale custom snapshots', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('ab');
  await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:false, inputType:'historyUndo' }));
    node.value = 'а';
    node.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'historyUndo' }));
  });
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('а');
});

test('toggle while editing and undo clear', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('sh');
  await expect(field).toHaveValue('ш');
  await page.getByLabel('Transliteration on').uncheck();
  await field.pressSequentially('ab');
  await expect(field).toHaveValue('шab');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(field).toHaveValue('');
  await field.focus();
  await field.press('ControlOrMeta+z');
  await expect(field).toHaveValue('шab');
  await field.press('ControlOrMeta+Shift+z');
  await expect(field).toHaveValue('');
});

test('touch interactions on a narrow viewport', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 667 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.tap();
  await field.pressSequentially('yo');
  await expect(field).toHaveValue('ё');
  await page.getByLabel('Transliteration on').tap();
  await field.tap();
  await field.pressSequentially('x');
  await expect(field).toHaveValue('ёx');
  await context.close();
});
