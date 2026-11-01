import { expect, test } from '@playwright/test';

test('the Latin ⬤ Кириллица switch shows and sets the typing mode (#123)', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  const topbar = page.locator('header.topbar');
  const mode = topbar.getByRole('switch', { name: 'Кириллица' });
  await expect(mode).toBeChecked();
  await expect(mode).toHaveAccessibleDescription('(Ctrl+Shift+Space)');
  await expect(topbar.getByText('Latin', { exact: true })).toBeVisible();
  // The words choose a side; they do not toggle.
  await topbar.getByText('Latin', { exact: true }).click();
  await expect(mode).not.toBeChecked();
  await expect(page.locator('#mode-announcement')).toHaveText('Transliteration off');
  await topbar.getByText('Latin', { exact: true }).click();
  await expect(mode).not.toBeChecked();
  await field.pressSequentially('privet');
  await expect(field).toHaveValue('privet');
  await topbar.getByText('Кириллица', { exact: true }).click();
  await expect(mode).toBeChecked();
  await topbar.getByText('Кириллица', { exact: true }).click();
  await expect(mode).toBeChecked();
  await expect(mode).toBeFocused();
  // Space on the focused switch toggles it, like any switch.
  await page.keyboard.press('Space');
  await expect(mode).not.toBeChecked();
  await page.keyboard.press('Space');
  await expect(mode).toBeChecked();
  await field.fill('');
  await field.pressSequentially('mir');
  await expect(field).toHaveValue('мир');
  // The choice persists across reload, as before.
  await topbar.getByText('Latin', { exact: true }).click();
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.getByRole('switch', { name: 'Кириллица' })).not.toBeChecked();
});
