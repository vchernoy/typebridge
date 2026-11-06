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

test('Rename in a window that is not editing selects the whole name once it can edit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('typebridge.host.layoutMode.v1', 'free'); });
  await page.goto('/host.html');
  const a = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(a.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await a.locator('#editor').fill('общий');
  await expect(a.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const b = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(b.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await b.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await b.locator('#drafts option', { hasText: 'общий' }).getAttribute('value');
  await b.locator('#drafts').dispatchEvent('pointerdown');
  await b.locator('#drafts').selectOption(value!);
  await expect(b.locator('html')).toHaveAttribute('data-role', 'reader');

  // The editing window renames without saving yet, so the takeover carries a newer title.
  const aTitle = page.locator('.host-window[data-window-id="main"] .host-window-title');
  await expect(aTitle).toBeEditable({ timeout: 15_000 });
  await aTitle.fill('Свежее');
  const bTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await page.locator('.host-window[data-window-id="w2"]').getByRole('button', { name: 'Rename document' }).click();
  await expect(b.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(bTitle).toBeEditable();
  await expect(bTitle).toHaveValue('Свежее');
  await expect.poll(() => bTitle.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([0, 'Свежее'.length]);
});

test('Rename… in a tab that is not editing selects the newer name once it can edit', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('тело');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'reader');
  // The editing tab renames; the takeover brings that newer title along.
  await page.getByRole('textbox', { name: 'Document title' }).fill('Свежее');
  await other.getByRole('button', { name: 'Documents', exact: true }).click();
  await other.getByRole('button', { name: 'Rename…' }).click();
  const title = other.getByRole('textbox', { name: 'Document title' });
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue('Свежее');
  await expect(title).toBeFocused();
  await expect.poll(() => title.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]))
    .toEqual([0, 'Свежее'.length]);
});
