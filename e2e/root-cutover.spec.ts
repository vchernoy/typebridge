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

test('a tab that used the single editor at / keeps its open document after the cutover reload', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('старый документ');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  await page.locator('#new-draft').click();
  await field.fill('новый документ');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  // Reopen the older document, so it is not the most recently edited one.
  await page.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await page.locator('#drafts option', { hasText: 'старый документ' }).getAttribute('value');
  await page.locator('#drafts').dispatchEvent('pointerdown');
  await page.locator('#drafts').selectOption(value!);
  await expect(field).toHaveValue('старый документ');
  // Same tab, now served the host: its session hints are unscoped single-editor keys.
  await page.goto('/');
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(main.locator('#editor')).toHaveValue('старый документ', { timeout: 30_000 });
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.activeDraft.v1'))).toBeNull();
});
