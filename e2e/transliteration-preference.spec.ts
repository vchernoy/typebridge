import { expect, test } from '@playwright/test';

test('remembers plain-text mode across reload and allows switching transliteration back on', async ({ page }) => {
  await page.goto('/typebridge/');
  const mode = page.getByRole('checkbox', { name: 'Transliteration on' });
  const field = page.getByRole('textbox', { name: 'Your text' });
  await expect(mode).toBeChecked();
  await mode.uncheck();
  await page.reload();
  await expect(mode).not.toBeChecked();
  await field.fill('');
  await field.pressSequentially('privet ');
  await expect(field).toHaveValue('privet ');
  await mode.check();
  await page.reload();
  await expect(mode).toBeChecked();
});

test('loads previously saved plain-text preference without altering draft text', async ({ page }) => {
  await page.goto('/typebridge/');
  await page.evaluate(() => localStorage.setItem('typebridge.transliteration.enabled.v1', 'off'));
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Transliteration on' })).not.toBeChecked();
  const field = page.getByRole('textbox', { name: 'Your text' });
  await field.fill('Это готовый русский пост');
  await expect(field).toHaveValue('Это готовый русский пост');
});
