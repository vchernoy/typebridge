import { expect, test } from '@playwright/test';

test('documents are called documents throughout the page (#108)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.getByRole('combobox', { name: 'Documents' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Documents' }).locator('option')).toHaveText(['Untitled document (current)']);
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Untitled document');
  for (const name of ['New document', 'Delete document', 'Import document']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText('Documents are saved in this browser only.')).toBeVisible();
  // A title the user typed, including the old default wording, is kept as is.
  await page.getByRole('textbox', { name: 'Document title' }).fill('Untitled draft');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Untitled draft');
});
