import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/**
 * Picking a document with a real pointer click must open it. selectOption() skips
 * pointerdown, so the close-and-rerender path that broke picking was never exercised.
 */

async function clickOption(scope: Page | FrameLocator, title: string): Promise<void> {
  const option = scope.locator('#drafts option', { hasText: title });
  await expect(option).toHaveCount(1);
  const value = await option.getAttribute('value');
  // A pointer pick: pointerdown on the list, then the selection change. WebKit cannot
  // click <option> rows in a list box, so send the same two events on every engine.
  await scope.locator('#drafts').dispatchEvent('pointerdown');
  await scope.locator('#drafts').selectOption(value!);
}

test('clicking a document in the list opens it and Delete removes that document', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  const title = page.getByRole('textbox', { name: 'Document title' });
  await expect(field).toBeEnabled();
  await title.fill('Первый');
  await field.fill('первый текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page.locator('#new-draft').click();
  await title.fill('Второй');
  await field.fill('второй текст');
  await expect(page.locator('#status')).toContainText('Saved locally');

  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await clickOption(page, 'Первый');
  await expect(field).toHaveValue('первый текст');
  await expect(title).toHaveValue('Первый');
  await expect(page.locator('#doc-menu')).toBeHidden();

  // Delete acts on the document that was picked, not the one open before.
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page.locator('#delete-draft').click();
  await page.getByRole('button', { name: 'Delete document' }).click();
  await expect(page.locator('#status')).toContainText('Document deleted');
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(page.locator('#drafts option', { hasText: 'Второй' })).toHaveCount(1);
  await expect(page.locator('#drafts option', { hasText: 'Первый' })).toHaveCount(0);
});

test('clicking a document after searching opens the match', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  const title = page.getByRole('textbox', { name: 'Document title' });
  await expect(field).toBeEnabled();
  await title.fill('Яблоко');
  await field.fill('яблоко текст');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page.locator('#new-draft').click();
  await title.fill('Банан');
  await field.fill('банан текст');
  await expect(page.locator('#status')).toContainText('Saved locally');

  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search documents' }).fill('Ябло');
  await clickOption(page, 'Яблоко');
  await expect(field).toHaveValue('яблоко текст');
  await expect(title).toHaveValue('Яблоко');
});

test('host windows list documents saved in another window and open them by click', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('typebridge.host.layoutMode.v1', 'free'); });
  await page.goto('/host.html');
  const first = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(first.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await first.locator('#editor').fill('альфа текст');
  await expect(first.locator('#save-indicator')).toHaveText('Saved');

  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await second.locator('#editor').fill('бета текст');
  await expect(second.locator('#save-indicator')).toHaveText('Saved');

  // The first window's list was rendered before the second document existed.
  await first.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(first.locator('#drafts option', { hasText: 'бета текст' })).toHaveCount(1);

  // Picking the other document by click opens it here as well.
  await second.getByRole('button', { name: 'Documents', exact: true }).click();
  await clickOption(second, 'альфа текст');
  await expect(second.locator('#editor')).toHaveValue('альфа текст');
});
