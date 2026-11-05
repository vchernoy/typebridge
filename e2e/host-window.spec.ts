import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { moreAction } from './settings-helpers';

/** #175 step 3: host page embeds one editor window; update notice lives on the host. */

async function openHost(page: Page): Promise<FrameLocator> {
  await page.goto('/host.html');
  const frame = page.frameLocator('#editor-window');
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(frame.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(frame.locator('html')).toHaveAttribute('data-window-id', 'main');
  return frame;
}

test('host single window matches standalone editor typing and save', async ({ page }) => {
  const editor = await openHost(page);
  await editor.locator('#editor').pressSequentially('privet');
  await expect(editor.locator('#save-indicator')).toHaveText('Saved');
  await expect(editor.locator('#editor')).toHaveValue('привет');
});

test('host keeps Settings in the iframe so delayed lookups still work', async ({ page }) => {
  const editor = await openHost(page);
  await expect(editor.locator('#settings-panel')).toHaveCount(1);
  await expect(page.locator('#settings-panel')).toHaveCount(0);

  await editor.locator('#settings-open').click();
  await expect(editor.locator('#settings-panel')).toBeVisible();
  await editor.locator('#settings-close').click();
  await expect(editor.locator('#settings-panel')).toBeHidden();

  // Keyboard shortcuts reads #tab-indent at click time — must stay in the iframe document.
  await moreAction(editor as unknown as Page, '#keyboard-shortcuts');
  await expect(editor.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })).toBeVisible();
});

test('embedded editor does not mount its own update notice', async ({ page }) => {
  const editor = await openHost(page);
  await expect(editor.locator('#update-notice')).toHaveCount(0);
});
