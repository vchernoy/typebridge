import { expect, test } from '@playwright/test';

test('Find and Go to line stay hidden until opened, one at a time (#123)', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  const findBar = page.getByRole('search', { name: 'Find and replace' });
  const gotoBar = page.getByRole('navigation', { name: 'Go to line' });
  const findButton = page.getByRole('button', { name: 'Find', exact: true });
  const gotoButton = page.getByRole('button', { name: 'Go to line', exact: true });
  await expect(findBar).toBeHidden();
  await expect(gotoBar).toBeHidden();
  await expect(findButton).toHaveAttribute('aria-expanded', 'false');
  // The Find button opens the bar and focuses the query.
  await findButton.click();
  await expect(findBar).toBeVisible();
  await expect(findButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#find-text')).toBeFocused();
  await expect(findBar.getByRole('checkbox', { name: 'Match case' })).toBeVisible();
  await expect(findBar.getByRole('checkbox', { name: 'Regex (.*)' })).toBeVisible();
  await page.locator('#find-text').fill('query');
  // Escape closes it, returns to the editor and does not enter Focus mode.
  await page.keyboard.press('Escape');
  await expect(findBar).toBeHidden();
  await expect(findButton).toHaveAttribute('aria-expanded', 'false');
  await expect(field).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  // Cmd/Ctrl+F reopens it with the query kept; Cmd/Ctrl+G swaps it for Go to line.
  await field.press('ControlOrMeta+f');
  await expect(findBar).toBeVisible();
  await expect(page.locator('#find-text')).toHaveValue('query');
  await expect(page.locator('#find-text')).toBeFocused();
  await page.locator('#find-text').press('ControlOrMeta+g');
  await expect(gotoBar).toBeVisible();
  await expect(findBar).toBeHidden();
  await expect(page.locator('#goto-line')).toBeFocused();
  await expect(gotoButton).toHaveAttribute('aria-expanded', 'true');
  // × closes Go to line; the button toggles Find closed again.
  await page.getByRole('button', { name: 'Close go to line' }).click();
  await expect(gotoBar).toBeHidden();
  await expect(field).toBeFocused();
  await findButton.click();
  await findButton.click();
  await expect(findBar).toBeHidden();
  await findButton.click();
  await page.getByRole('button', { name: 'Close find' }).click();
  await expect(findBar).toBeHidden();
});

test('Cmd/Ctrl+F in Focus mode leaves Focus mode and opens Find (#123)', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await field.press('ControlOrMeta+f');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(page.locator('#find-bar')).toBeVisible();
  await expect(page.locator('#find-text')).toBeFocused();
});
