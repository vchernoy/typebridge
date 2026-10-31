import { expect, test } from '@playwright/test';

test('Go to line moves the caret, reveals a distant line and updates the position label', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Transliteration on').uncheck();
  const field = page.getByRole('textbox', { name: 'Your text' });
  const lines = Array.from({ length: 250 }, (_, i) => `Line ${i + 1} content`);
  await field.fill(lines.join('\n'));
  await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.setSelectionRange(0, 0);
    node.scrollTop = 0;
  });
  await page.locator('#goto-line').fill('241:3');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const result = await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { start: node.selectionStart, end: node.selectionEnd, top: node.scrollTop, focused: document.activeElement === node };
  });
  const expected = await field.evaluate(el => {
    const lines = (el as HTMLTextAreaElement).value.split('\n');
    const start = lines.slice(0, 240).join('\n').length + 1;
    return start + 2; // column 3 on "Line 241 content"
  });
  expect(result).toMatchObject({ start: expected, end: expected, focused: true });
  expect(result.top).toBeGreaterThan(100);
  await expect(page.locator('#caret-position')).toHaveText('Ln 241, Col 3');
  await expect(page.locator('#goto-status')).toHaveText('Line 241, column 3');
});

test('Cmd/Ctrl+G focuses Go to line and Enter jumps without changing text', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Transliteration on').uncheck();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('one\ntwo\nthree');
  await field.focus();
  await page.keyboard.press('ControlOrMeta+g');
  await expect(page.locator('#goto-line')).toBeFocused();
  await page.locator('#goto-line').fill('2');
  await page.locator('#goto-line').press('Enter');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('one\ntwo\nthree');
  const start = await field.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
  expect(start).toBe('one\n'.length);
  await expect(page.locator('#caret-position')).toHaveText('Ln 2, Col 1');
});

test('Go to line clamps past the end of the document', async ({ page }) => {
  await page.goto('/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('only\ntwo');
  await page.locator('#goto-line').fill('99:99');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(field).toHaveValue('only\ntwo');
  const start = await field.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
  expect(start).toBe('only\ntwo'.length);
  await expect(page.locator('#goto-status')).toHaveText('Clamped to line 2, column 4');
  await expect(page.locator('#caret-position')).toHaveText('Ln 2, Col 4');
});

test('Go to a column inside an emoji snaps to a safe boundary so typing cannot split it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Transliteration on')).toBeChecked();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('🙂x');
  await page.locator('#goto-line').fill('1:2');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.locator('#goto-status')).toHaveText('Clamped to line 1, column 3');
  await expect(page.locator('#caret-position')).toHaveText('Ln 1, Col 3');
  await field.press('a');
  await expect(field).toHaveValue('🙂аx');
});

test('Enter during IME composition in Go to line does not navigate', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Transliteration on').uncheck();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('one\ntwo\nthree');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  const goto = page.locator('#goto-line');
  await goto.fill('2');
  await goto.focus();
  await goto.evaluate(el => {
    const input = el as HTMLInputElement;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    Object.defineProperty(enter, 'isComposing', { get: () => true });
    input.dispatchEvent(enter);
  });
  await expect(goto).toBeFocused();
  const start = await field.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
  expect(start).toBe(0);
  await expect(page.locator('#caret-position')).toHaveText('Ln 1, Col 1');
});
