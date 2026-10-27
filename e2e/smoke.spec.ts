import { expect, test } from '@playwright/test';

test('production build loads at the GitHub Pages project path', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  await page.goto('/typebridge/');
  await expect(page).toHaveTitle('TypeBridge');
  await expect(page.getByRole('heading', { level: 1, name: 'TypeBridge' })).toBeVisible();
  await expect(page.getByText('The editor is under development.')).toBeVisible();
  expect(failures).toEqual([]);
});
