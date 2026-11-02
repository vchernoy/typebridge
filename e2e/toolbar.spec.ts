import { answerNextConfirmation } from './settings-helpers';
import { expect, test } from '@playwright/test';

test('the toolbar holds editing actions; Focus and Settings sit in the top bar (#123)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  const toolbar = page.getByRole('toolbar', { name: 'Editing' });
  for (const name of ['Undo', 'Redo', 'To Cyrillic', 'To Latin', 'Find', 'Copy', 'More actions']) {
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();
  }
  const topbar = page.locator('header.topbar');
  await expect(topbar.getByRole('button', { name: 'Focus mode' })).toBeVisible();
  await expect(topbar.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  // Go to line and Clear are no longer on the toolbar itself.
  await expect(page.getByRole('menuitem', { name: 'Go to line…' })).toBeHidden();
  await expect(page.getByRole('menuitem', { name: 'Clear text…' })).toBeHidden();
});

test('the ⋯ menu works with the keyboard and closes cleanly (#123)', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Текст');
  const more = page.getByRole('button', { name: 'More actions' });
  const menu = page.getByRole('menu', { name: 'More actions' });
  await more.click();
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitem', { name: 'Go to line…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Clear text…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Go to line…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  // Go to line… opens the go-to bar.
  await more.click();
  await page.getByRole('menuitem', { name: 'Go to line…' }).click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#goto-bar')).toBeVisible();
  await expect(page.locator('#goto-line')).toBeFocused();
  // Clear text… asks first; Cancel keeps the text, OK clears it.
  const confirmation1 = answerNextConfirmation(page, false);
  await more.click();
  await page.getByRole('menuitem', { name: 'Clear text…' }).click();
  await confirmation1;
  await expect(field).toHaveValue('Текст');
  await expect(more).toBeFocused();
  const confirmation2 = answerNextConfirmation(page, true);
  await more.click();
  await page.getByRole('menuitem', { name: 'Clear text…' }).click();
  await confirmation2;
  await expect(field).toHaveValue('');
  // A click outside closes it.
  await more.click();
  await field.click();
  await expect(menu).toBeHidden();
});
