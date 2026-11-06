import { expect, test } from '@playwright/test';

/** Renaming is reachable without knowing the title is a text field. */

test('host title bar ✎ button and Documents → Rename… both start renaming', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/host.html');
  const frame = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await frame.locator('#editor').fill('текст');
  await expect(frame.locator('#save-indicator')).toHaveText('Saved');
  const title = page.locator('.host-window[data-window-id="main"] .host-window-title');
  await expect(title).toBeEditable({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Rename document' }).click();
  await expect(title).toBeFocused();
  await page.keyboard.type('Pervyj');
  await page.keyboard.press('Enter');
  await expect(title).toHaveValue('Первый');
  await expect(frame.locator('#draft-title')).toHaveValue('Первый');

  await frame.getByRole('button', { name: 'Documents', exact: true }).click();
  await frame.getByRole('button', { name: 'Rename…' }).click();
  await expect(title).toBeFocused();
  await page.keyboard.type('Vtoroj');
  await page.keyboard.press('Enter');
  await expect(title).toHaveValue('Второй');
  await expect(frame.locator('#save-indicator')).toHaveText('Saved');
});

test('Documents → Rename… focuses the title on the standalone page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page.getByRole('button', { name: 'Rename…' }).click();
  const title = page.getByRole('textbox', { name: 'Document title' });
  await expect(title).toBeFocused();
  await page.keyboard.type('Novoe');
  await expect(title).toHaveValue('Новое');
});
