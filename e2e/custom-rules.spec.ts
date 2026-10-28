import { expect, test } from '@playwright/test';

test('custom rules affect new typing, persist, and leave existing text intact', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await expect(field).toBeEnabled();
  await field.pressSequentially('w');
  await expect(field).toHaveValue('щ');
  await page.locator('.rules-panel summary').click();
  const mappings = page.getByRole('textbox', { name: 'Transliteration mappings' });
  await mappings.fill((await mappings.inputValue()).replace(/^w = щ$/m, 'w = в'));
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.locator('#rules-status')).toContainText('Rules saved');
  await expect(field).toHaveValue('щ');
  await field.pressSequentially(' w');
  await expect(field).toHaveValue('щ в');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  const restored = page.getByRole('textbox', { name: 'Your text' });
  await expect(restored).toHaveValue('щ в');
  await expect(restored).toBeEnabled();
  await restored.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange((el as HTMLTextAreaElement).value.length, (el as HTMLTextAreaElement).value.length));
  await restored.pressSequentially(' w');
  await expect(restored).toHaveValue('щ в в');
  await page.locator('.rules-panel summary').click();
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.locator('#rules-status')).toContainText('Default rules restored');
});

test('invalid rules are rejected without affecting conversion', async ({ page }) => {
  await page.goto('/typebridge/');
  await page.locator('.rules-panel summary').click();
  const mappings = page.getByRole('textbox', { name: 'Transliteration mappings' });
  await mappings.fill('w = hello');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.locator('#rules-status')).toContainText('Rules must map');
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.pressSequentially('w');
  await expect(field).toHaveValue('щ');
});
