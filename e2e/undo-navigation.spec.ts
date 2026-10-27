import { expect, test } from '@playwright/test';

test('Undo reveals a distant edit inside a long textarea and preserves selection', async ({ page }) => {
  await page.goto('/typebridge/');
  await page.getByLabel('Transliteration on').uncheck();
  const field = page.getByRole('textbox', { name: 'Your text' });
  const lines = Array.from({ length: 250 }, (_, i) => 'Paragraph ' + i + ': ' + 'wrapped text '.repeat(8));
  const text = lines.join('\n');
  await field.fill(text);
  await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    node.setSelectionRange(0, 0);
  });
  await field.pressSequentially('X');
  await expect(field).toHaveValue('X' + text);

  await field.evaluate(el => { (el as HTMLTextAreaElement).scrollTop = (el as HTMLTextAreaElement).scrollHeight; });
  const before = await field.evaluate(el => (el as HTMLTextAreaElement).scrollTop);
  expect(before).toBeGreaterThan(100);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue(text);
  const result = await field.evaluate(el => {
    const node = el as HTMLTextAreaElement;
    return { top: node.scrollTop, start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node };
  });
  expect(result.top).toBeLessThan(before / 2);
  expect(result).toMatchObject({ start: 0, end: 0, focused: true });
});

test('Undo does not scroll when the edited line is already visible', async ({ page }) => {
  await page.goto('/typebridge/');
  await page.getByLabel('Transliteration on').uncheck();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('First line\nSecond line\nThird line');
  await field.press('End');
  await field.pressSequentially('X');
  await field.evaluate(el => { (el as HTMLTextAreaElement).scrollTop = 0; });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(field).toHaveValue('First line\nSecond line\nThird line');
  expect(await field.evaluate(el => (el as HTMLTextAreaElement).scrollTop)).toBe(0);
});
