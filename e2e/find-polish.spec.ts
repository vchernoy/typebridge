import { expect, test } from '@playwright/test';
import { openFind } from './settings-helpers';

test('Find reports totals, position, wrap and edited query state (#137 U3)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('text TEXT text');
  await openFind(page);
  const query = page.locator('#find-text');
  const status = page.locator('#find-status');
  await query.fill('text');
  await expect(status).toHaveText('3 matches');
  await page.locator('#editor').evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(status).toHaveText('1 of 3');
  await page.locator('#find-next').click();
  await expect(status).toHaveText('2 of 3');
  await page.locator('#find-prev').click();
  await expect(status).toHaveText('1 of 3');
  await page.locator('#find-prev').click();
  await expect(status).toHaveText('3 of 3');
  await page.locator('#match-case').check();
  await expect(status).toHaveText('2 matches');
  await query.fill('missing');
  await expect(status).toHaveText('No matches');
  await query.fill('');
  await expect(status).toHaveText('');
  await page.locator('#regex-mode').check();
  await query.fill('[');
  await expect(status).toContainText('Invalid regex');
});

test('Find position includes zero-width regex navigation (#137 U3)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('ab');
  await openFind(page);
  await page.locator('#regex-mode').check();
  await page.locator('#find-text').fill('(?=.)');
  await page.locator('#editor').evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await expect(page.locator('#find-status')).toHaveText('2 matches');
  await page.locator('#find-next').click();
  await expect(page.locator('#find-status')).toHaveText('1 of 2');
  await page.locator('#find-next').click();
  await expect(page.locator('#find-status')).toHaveText('2 of 2');
});

test('closed Find does not recount matches on editor input (#137 U3)', async ({ page }) => {
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('aaa');
  await openFind(page);
  await page.locator('#regex-mode').check();
  await page.locator('#find-text').fill('a+');
  await expect(page.locator('#find-status')).toHaveText('1 match');
  await page.locator('#find-close').click();
  await expect(page.locator('#find-bar')).toBeHidden();
  const status = await page.locator('#find-status').textContent();
  await editor.focus();
  await editor.pressSequentially('!');
  await expect(editor).toHaveValue('aaa!');
  await expect(page.locator('#find-status')).toHaveText(status ?? '');
  await openFind(page);
  await expect(page.locator('#find-status')).toHaveText('1 match');
});

test('closed Find skips match enumeration and reopening refreshes totals (#137 U3)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('text');
  await openFind(page);
  await page.locator('#find-text').fill('text');
  await expect(page.locator('#find-status')).toHaveText('1 match');
  await page.locator('#find-close').click();
  await page.evaluate(() => {
    const original = RegExp.prototype[Symbol.matchAll];
    const state = { matchEnumerations: 0 };
    Object.assign(window, state);
    RegExp.prototype[Symbol.matchAll] = function (text) {
      (window as unknown as typeof state).matchEnumerations++;
      return original.call(this, text);
    };
  });
  await page.locator('#editor').fill('text text');
  expect(await page.evaluate(() => (window as unknown as { matchEnumerations: number }).matchEnumerations)).toBe(0);
  await openFind(page);
  await expect(page.locator('#find-status')).toHaveText('2 matches');
  expect(await page.evaluate(() => (window as unknown as { matchEnumerations: number }).matchEnumerations)).toBeGreaterThan(0);
});
