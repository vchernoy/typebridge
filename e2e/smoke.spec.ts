import { expect, test } from '@playwright/test';

test('editor types transliteration, edits selections and supports history', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
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
  await expect(page.locator('#editor')).toBeEnabled();
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

test('paste and undo preserve clipboard content and caret', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await page.evaluate(() => { const seed = document.createElement('textarea'); seed.id = 'clipboard-seed'; seed.value = 'ABC 🙂'; document.body.append(seed); });
  const seed = page.locator('#clipboard-seed');
  await seed.selectText();
  await seed.press('ControlOrMeta+c');
  await seed.evaluate(el => el.remove());
  await field.pressSequentially('privet');
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
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('yozh');
  await expect(field).toHaveValue('ёж');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('composition keyboard undo is not intercepted by editor', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await expect(field).toBeEnabled();
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

test('cut and selection replacement are undoable with selections intact', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
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
  await expect(page.locator('#editor')).toBeEnabled();
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
  await expect(page.locator('#editor')).toBeEnabled();
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
  await expect(page.locator('#editor')).toBeEnabled();
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
  await expect(page.locator('#editor')).toBeEnabled();
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
  await expect(page.locator('#editor')).toBeEnabled();
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

test('toolbar Undo and Redo track multiple edits, preserve selection and keyboard history', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  await field.pressSequentially('abc');
  await expect(field).toHaveValue('абц');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(field).toHaveValue('аб');
  await expect(field).toBeFocused();
  await undo.click();
  await expect(field).toHaveValue('а');
  await redo.click();
  await expect(field).toHaveValue('аб');
  await field.press('ControlOrMeta+Shift+z');
  await expect(field).toHaveValue('абц');
  await expect(redo).toBeDisabled();
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 2));
  await field.pressSequentially('sh');
  await expect(field).toHaveValue('шц');
  await undo.click();
  await expect(field).toHaveValue('сц');
  await undo.click();
  await expect(field).toHaveValue('абц');
  expect(await field.evaluate(el => [(el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([0, 2]);
  await redo.click();
  await expect(field).toHaveValue('сц');
  await field.pressSequentially('x');
  await expect(redo).toBeDisabled();
});

test('toolbar history undoes block clear and supports multiple steps', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('privet');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(field).toHaveValue('');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('привет');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(field).toHaveValue('');
});

test('autosave restores text after reload and opens latest draft in a new tab', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('privet');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('привет');
  const second = await context.newPage();
  await second.goto('/typebridge/');
  await expect(second.getByRole('textbox', { name: 'Your text' })).toHaveValue('привет');
  await second.getByRole('button', { name: 'New draft' }).click();
  await second.getByRole('textbox', { name: 'Your text' }).pressSequentially('mir');
  await expect(second.getByRole('status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('привет');
  await expect(page.getByRole('combobox', { name: 'Drafts' }).locator('option')).toHaveCount(2);
  await second.close();
});

test('draft rename, reopen, delete and autosave toggle', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('privet');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.getByRole('textbox', { name: 'Draft title' }).fill('First post');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'New draft' }).click();
  await expect(field).toHaveValue('');
  await field.pressSequentially('mir');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.getByRole('combobox', { name: 'Drafts' }).selectOption({ label: 'First post' });
  await expect(field).toHaveValue('привет');
  page.once('dialog', d => d.dismiss());
  await page.getByRole('checkbox', { name: 'Autosave' }).uncheck();
  await field.pressSequentially('a');
  page.once('dialog', d => d.accept());
  await page.reload();
  await expect(field).toHaveValue('привет');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Delete draft' }).click();
  await expect(field).toHaveValue('');
});

test('undo and redo survive refresh and stay isolated per draft', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const redo = page.getByRole('button', { name: 'Redo', exact: true });
  await field.pressSequentially('privet');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('привет');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(field).toHaveValue('приве');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.reload();
  await expect(field).toHaveValue('приве');
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(field).toHaveValue('привет');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.getByRole('textbox', { name: 'Draft title' }).fill('First');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'New draft' }).click();
  await expect(undo).toBeDisabled();
  await field.pressSequentially('mir');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.getByRole('combobox', { name: 'Drafts' }).selectOption({ label: 'First' });
  await expect(field).toHaveValue('привет');
  await expect(undo).toBeEnabled();
});

test('editor can shrink to five lines and resize horizontally', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  const sizes = await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    const initial = node.getBoundingClientRect();
    const styles = getComputedStyle(node);
    node.style.height = '160px';
    node.style.width = '1200px';
    const resized = node.getBoundingClientRect();
    return { initialHeight: initial.height, height: resized.height, width: resized.width, resize: styles.resize };
  });
  expect(sizes.initialHeight).toBeGreaterThan(sizes.height);
  expect(sizes.height).toBeLessThan(200);
  expect(sizes.width).toBeGreaterThan(1000);
  expect(sizes.resize).toBe('both');
});

test('fresh page opens latest saved draft, reload keeps current tab selection', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('First draft');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'New draft' }).click();
  await field.fill('Latest draft');
  await expect(page.getByRole('status')).toContainText('Saved locally');
  const fresh = await context.newPage();
  await fresh.goto('/typebridge/');
  await expect(fresh.getByRole('textbox', { name: 'Your text' })).toHaveValue('Latest draft');
  await page.reload();
  await expect(field).toHaveValue('Latest draft');
  await fresh.close();
});
