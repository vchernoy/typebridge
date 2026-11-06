import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/**
 * Same document in two host windows: the window that is not editing looks like a normal
 * editor (no Read-only badge or notice), and any edit gesture there takes over editing.
 */

async function openSameDocument(page: Page): Promise<{ a: FrameLocator; b: FrameLocator }> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('typebridge.host.layoutMode.v1', 'free'); });
  await page.goto('/host.html');
  const a = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(a.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await a.locator('#editor').fill('общий текст');
  await expect(a.locator('#save-indicator')).toHaveText('Saved');

  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const b = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(b.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await b.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await b.locator('#drafts option', { hasText: 'общий текст' }).getAttribute('value');
  // Pointer pick (WebKit cannot click <option> rows in a list box).
  await b.locator('#drafts').dispatchEvent('pointerdown');
  await b.locator('#drafts').selectOption(value!);
  await expect(b.locator('#editor')).toHaveValue('общий текст');
  return { a, b };
}

async function expectLooksEditable(frame: FrameLocator): Promise<void> {
  await expect(frame.locator('#save-indicator')).toHaveText('Saved');
  await expect(frame.locator('#ownership-notice')).toBeHidden();
  await expect(frame.locator('#status')).not.toContainText('Read-only');
}

test('the window that is not editing shows no read-only state', async ({ page }) => {
  const { a, b } = await openSameDocument(page);
  await expectLooksEditable(b);

  await b.locator('#editor').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' plus');
  await expect(b.locator('#editor')).toHaveValue('общий текст плус');
  await expect(a.locator('#editor')).toHaveValue('общий текст плус');
  await expectLooksEditable(a);
  await expectLooksEditable(b);
  await expect(b.locator('#status')).not.toContainText('You can edit this document');
});

test('renaming from the title of the window that is not editing works', async ({ page }) => {
  const { a } = await openSameDocument(page);
  const bTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await bTitle.click();
  await expect(bTitle).toBeEditable({ timeout: 10_000 });
  await bTitle.fill('Общее имя');
  await bTitle.press('Enter');
  await expect(page.locator('.host-window[data-window-id="main"] .host-window-title')).toHaveValue('Общее имя', { timeout: 10_000 });
  await expectLooksEditable(a);
});

test('Delete from the window that is not editing takes over and asks first', async ({ page }) => {
  const { a, b } = await openSameDocument(page);
  await b.getByRole('button', { name: 'Documents', exact: true }).click();
  await expect(b.locator('#delete-draft')).toBeEnabled();
  await b.locator('#delete-draft').click();
  await expect(b.getByRole('button', { name: 'Delete document' })).toBeVisible({ timeout: 10_000 });
  await b.getByRole('button', { name: 'Keep document' }).click();
  await expect(b.locator('#editor')).toHaveValue('общий текст');
  await expectLooksEditable(a);
});
