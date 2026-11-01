import { expect, test } from '@playwright/test';
import { closeDocuments, documentAction, openDocuments } from './settings-helpers';

test('documents are called documents throughout the page (#108)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Untitled document');
  await openDocuments(page);
  const menu = page.getByRole('dialog', { name: 'Documents' });
  await expect(menu.getByRole('listbox', { name: 'Documents' })).toBeVisible();
  await expect(page.locator('#drafts option')).toHaveText(['Untitled document (current)']);
  for (const name of ['New document', 'Delete document', 'Import document']) {
    await expect(menu.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await closeDocuments(page);
  await expect(page.getByText('Documents are saved in this browser only.')).toBeVisible();
  // A title the user typed, including the old default wording, is kept as is.
  await page.getByRole('textbox', { name: 'Document title' }).fill('Untitled draft');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Untitled draft');
});

test('the ▾ document menu opens the list and actions, and closes cleanly (#123)', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первый');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Первый');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const toggle = page.getByRole('button', { name: 'Documents', exact: true });
  const menu = page.getByRole('dialog', { name: 'Documents' });
  // The big header is gone; the page heading is the small TypeBridge name in the top bar.
  await expect(page.getByRole('heading', { level: 1, name: 'TypeBridge' })).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(menu).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#drafts')).toBeFocused();
  // Escape closes it, returns focus to ▾ and does not enter Focus mode.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  // An action closes it.
  await toggle.click();
  await menu.getByRole('button', { name: 'New document' }).click();
  await expect(menu).toBeHidden();
  await expect(field).toHaveValue('');
  // Picking a document with the pointer opens it and closes the menu; a click outside closes it too.
  await toggle.click();
  await expect(page.locator('#drafts option')).toHaveCount(2);
  const option = await page.locator('#drafts option', { hasText: 'Первый' }).boundingBox();
  if (!option) throw new Error('Document option has no bounding box');
  await page.mouse.click(option.x + option.width / 2, option.y + option.height / 2);
  await expect(field).toHaveValue('Первый');
  await expect(menu).toBeHidden();
  await toggle.click();
  await field.click();
  await expect(menu).toBeHidden();
});

test('arrow keys move through documents without closing the menu (#123)', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Один');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await documentAction(page, '#new-draft');
  await field.fill('Два');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await openDocuments(page);
  await page.locator('#drafts').press('ArrowDown');
  await expect(field).toHaveValue('Один');
  await expect(page.getByRole('dialog', { name: 'Documents' })).toBeVisible();
});
