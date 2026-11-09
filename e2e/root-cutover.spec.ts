import { expect, test } from '@playwright/test';
import { readStoredDocs } from './storage-helpers';

/**
 * #175 cutover: `/` is the multi-window host. Each window (and the comparison popup) runs
 * /editor.html; /host.html and pre-cutover editor links keep working.
 */

test('the root page is the multi-window host with editor.html windows', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/host-page/);
  await expect(page.getByRole('button', { name: 'New window' })).toBeVisible();
  const frame = page.locator('.host-window[data-window-id="main"] iframe.host-editor');
  await expect(frame).toHaveAttribute('src', /^\/editor\.html\?/);
  const editor = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(editor.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(editor.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://typebridge.vchernoy.xyz/');
});

test('the old host address opens the root host', async ({ page }) => {
  await page.goto('/host.html');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeVisible({ timeout: 30_000 });
});

test('a pre-cutover comparison link on the root opens the editor viewer, not the host', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('сравнение');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id = (await readStoredDocs(page)).find(row => row.text === 'сравнение')!.id;
  const viewer = await page.context().newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await expect.poll(() => new URL(viewer.url()).pathname).toBe('/editor.html');
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(id);
  await expect(viewer.locator('#editor')).toHaveValue('сравнение');
  await expect(viewer.locator('.host-window')).toHaveCount(0);
});
