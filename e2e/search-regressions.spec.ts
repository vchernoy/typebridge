import { expect, test } from '@playwright/test';

test('Find reveals a distant match inside the editor', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill(Array.from({ length: 250 }, (_, i) => i === 240 ? 'TARGET' : `Line ${i}`).join('\n'));
  await field.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(0, 0); el.scrollTop = 0; });
  await page.locator('#find-text').fill('TARGET');
  await page.locator('#find-next').click();
  const result = await field.evaluate((el: HTMLTextAreaElement) => ({
    selected: el.value.slice(el.selectionStart, el.selectionEnd),
    top: el.scrollTop, height: el.clientHeight,
    lineTop: 240 * parseFloat(getComputedStyle(el).lineHeight) + parseFloat(getComputedStyle(el).paddingTop),
  }));
  expect(result.selected).toBe('TARGET');
  expect(result.top).toBeGreaterThan(0);
  expect(result.lineTop).toBeGreaterThanOrEqual(result.top);
  expect(result.lineTop).toBeLessThan(result.top + result.height);
});

for (const [text, query, positions] of [
  ['Line one\nLine two', '(?=Line)|$', [0, 9, 17]],
  ['🙂🙂', '(?=🙂)|$', [0, 2, 4]],
] as const) {
  test(`zero-width Find advances and wraps in UTF-16 offsets: ${query}`, async ({ page }) => {
    await page.goto('/typebridge/');
    const field = page.locator('#editor');
    await field.fill(text);
    await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
    await page.locator('#regex-mode').check();
    await page.locator('#find-text').fill(query);
    for (const position of [...positions, positions[0]]) {
      await page.locator('#find-next').click();
      expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([position, position]);
    }
    for (const position of [...positions].reverse()) {
      await page.locator('#find-prev').click();
      expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(position);
    }
    // A changed query starts at the current caret, even at the same zero-width offset.
    await page.locator('#find-text').fill('^');
    await page.locator('#find-next').click();
    expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(0);
    await expect(field).toHaveValue(text);
  });
}

for (const button of ['#replace-one', '#replace-all']) {
  test(`${button} uses numeric capture fallback and preserves undo`, async ({ page }) => {
    await page.goto('/typebridge/');
    await page.locator('#enabled').uncheck();
    const field = page.locator('#editor');
    await field.fill('a');
    await page.locator('#regex-mode').check();
    await page.locator('#find-text').fill('(a)');
    await page.locator('#replace-text').fill('$12');
    await page.locator(button).click();
    await expect(field).toHaveValue('a2');
    await page.locator('#undo').click();
    await expect(field).toHaveValue('a');
    await page.locator('#redo').click();
    await expect(field).toHaveValue('a2');
  });
}
