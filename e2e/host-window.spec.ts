import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/** #175 step 3: host page embeds one editor window; Settings + update notice live on the host. */

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

test('host adopts Settings panel and opens it from the embedded chrome', async ({ page }) => {
  const editor = await openHost(page);
  // Panel is moved onto the host document after the iframe loads.
  await expect.poll(async () => page.locator('#host-settings-root #settings-panel').count()).toBe(1);
  await expect(editor.locator('#settings-panel')).toHaveCount(0);

  await editor.locator('#settings-open').click();
  const panel = page.locator('#host-settings-root #settings-panel');
  await expect(panel).toBeVisible();
  await page.locator('#settings-close').click();
  await expect(panel).toBeHidden();
});

test('embedded editor does not mount its own update notice', async ({ page }) => {
  const editor = await openHost(page);
  await expect(editor.locator('#update-notice')).toHaveCount(0);
});
