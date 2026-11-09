import { expect, test } from '@playwright/test';

test('Settings opens a side panel with every setting, and Escape or × closes it (#123)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const open = page.getByRole('button', { name: 'Settings', exact: true });
  const panel = page.getByRole('dialog', { name: 'Settings' });
  // The settings no longer clutter the page.
  await expect(panel).toBeHidden();
  await expect(page.locator('details')).toHaveCount(0);
  await expect(page.locator('#autosave')).toBeHidden();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();
  await expect(panel).toBeVisible();
  await expect(open).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeFocused();
  for (const name of ['Transliteration shortcut', 'Transliteration rules', 'Saving', 'Editor']) {
    await expect(panel.getByRole('group', { name })).toBeVisible();
  }
  await expect(panel.getByLabel('Shortcut', { exact: true })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Transliteration mappings' })).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: 'Autosave' })).toBeChecked();
  await expect(panel.getByRole('checkbox', { name: 'Tab indents' })).toBeChecked();
  // Escape closes it, returns focus to Settings and does not enter Focus mode.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  // The close button closes it too.
  await open.click();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(panel).toBeHidden();
  await expect(open).toBeFocused();
});

test('Settings stays open while you try a rule in the editor (#123)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await expect(field).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const mappings = page.getByRole('textbox', { name: 'Transliteration mappings' });
  await mappings.fill((await mappings.inputValue()).replace(/^w = щ$/m, 'w = в'));
  await page.getByRole('button', { name: 'Save rules' }).click();
  await field.pressSequentially('w');
  await expect(field).toHaveValue('в');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
});

test('Focus mode hides Settings, and an open panel comes back after leaving it (#123)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await field.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('#settings-panel')).toBeHidden();
  await expect(page.locator('#settings-open')).toBeHidden();
  await field.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(page.locator('#settings-panel')).toBeVisible();
});
