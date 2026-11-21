import { expect, test } from '@playwright/test';
import { documentAction } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

// Documents → New from template… (#390): bundled starters become normal new documents.
test('a template becomes a new Markdown document; the current one is kept', async ({ page }) => {
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('My existing note');
  await expect.poll(async () => (await readStoredDocs(page)).length).toBe(1);
  await documentAction(page, '#new-from-template');
  const dialog = page.getByRole('dialog', { name: 'New from template' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button')).toHaveCount(4);
  await expect(page.locator('#template-price-quote')).toBeFocused();
  await page.locator('#template-price-quote').click();
  await expect(dialog).toHaveCount(0);
  await expect(editor).toHaveValue(/^# Price quote\n/);
  await expect(page.locator('#draft-title')).toHaveValue('Price quote');
  await expect.poll(async () => (await readStoredDocs(page, true)).length).toBe(2);
  const docs = await readStoredDocs(page, true);
  expect(docs.find(row => row.title === 'Price quote')).toMatchObject({ format: 'markdown' });
  expect(docs.find(row => row.text === 'My existing note')).toBeDefined();
  // It renders as a working form.
  await page.locator('#document-view-preview').click();
  await expect(page.locator('#rendered-document').getByRole('spinbutton', { name: 'Quantity' })).toHaveValue('3');
  await page.locator('#rendered-document').getByRole('spinbutton', { name: 'Quantity' }).fill('5');
  await expect(page.locator('#rendered-document')).toContainText('194.40');
});

test('Cancel or Escape closes the chooser without creating a document', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Only note');
  await expect.poll(async () => (await readStoredDocs(page)).length).toBe(1);
  for (const close of ['cancel', 'escape'] as const) {
    await documentAction(page, '#new-from-template');
    const dialog = page.getByRole('dialog', { name: 'New from template' });
    await expect(dialog).toBeVisible();
    if (close === 'cancel') await page.locator('#template-cancel').click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#doc-menu-open')).toBeFocused();
  }
  expect(await readStoredDocs(page)).toHaveLength(1);
  await expect(page.locator('#editor')).toHaveValue('Only note');
});
