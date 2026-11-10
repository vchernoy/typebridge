import { expect, test } from '@playwright/test';
import { openFind } from './settings-helpers';

// Each engine has its own RegExp implementation, so the case and Unicode policy in
// docs/SEARCH.md is checked in Chromium, Firefox and WebKit (#62).
const CASES: Array<[text: string, query: string, matchCase: boolean, status: string]> = [
  ['Hello HELLO hello', 'hello', false, '3 matches'],
  ['Hello HELLO hello', 'hello', true, '1 match'],
  ['Привет ПРИВЕТ привет', 'привет', false, '3 matches'],
  ['Привет ПРИВЕТ привет', 'привет', true, '1 match'],
  ['ЁЛКА Ёлка ёлка', 'ёлка', false, '3 matches'],
  ['ёлка', 'елка', false, 'No matches'],
  ['ПРИВЕТ WORLD', 'Привет world', false, '1 match'],
  ['a🙂b🙂', '🙂', false, '2 matches'],
  ['é', 'é', false, 'No matches'],
  ['SS', 'ß', false, 'No matches'],
  ['ẞ', 'ß', false, '1 match'],
];

test('Find applies one case policy to English, Russian, emoji and the documented Unicode limits', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await openFind(page);
  const query = page.locator('#find-text');
  const status = page.locator('#find-status');
  for (const [text, search, matchCase, expected] of CASES) {
    await field.fill(text);
    await page.locator('#match-case').setChecked(matchCase);
    await query.fill(search);
    await expect(status, `${search} in ${text}, Match case ${matchCase}`).toHaveText(expected);
  }
});

test('Replace all reports one match in the singular and Undo restores a large document', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Один ЦЕЛЬ здесь');
  await openFind(page);
  await page.locator('#find-text').fill('цель');
  await page.locator('#replace-text').fill('мишень');
  await page.locator('#replace-all').click();
  await expect(page.locator('#find-status')).toHaveText('Replaced 1 match');
  await expect(field).toHaveValue('Один мишень здесь');
  // About 200 KB with 2,000 matches across Cyrillic, Latin and emoji: one undoable edit.
  const large = Array.from({ length: 2000 }, (_, i) => `Строка ${i}: ЦЕЛЬ target 🙂 ёлка\n`).join('');
  // Set directly: typing 200 KB through fill() is far slower than the feature under test.
  await field.evaluate((el, value) => {
    const area = el as HTMLTextAreaElement;
    area.value = value;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, large);
  await page.locator('#find-text').fill('цель');
  await expect(page.locator('#find-status')).toHaveText('2000 matches');
  await page.locator('#replace-all').click();
  await expect(page.locator('#find-status')).toHaveText('Replaced 2000 matches');
  expect(await field.evaluate(el => (el as HTMLTextAreaElement).value.includes('ЦЕЛЬ'))).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await field.evaluate(el => (el as HTMLTextAreaElement).value)).toBe(large);
});
