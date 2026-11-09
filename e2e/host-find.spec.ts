import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { fillHostEditor } from './settings-helpers';

/** #175 step 9: shared Find query; Replace disabled in read-only host windows. */

async function openHost(page: Page): Promise<FrameLocator> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  await page.goto('/');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  return frame;
}

async function openDocMenu(frame: FrameLocator): Promise<void> {
  const panel = frame.locator('#doc-menu');
  if (await panel.isHidden()) await frame.locator('#doc-menu-open').click();
  await expect(panel).toBeVisible();
}

test('host windows share the last Find query; Replace stays per window', async ({ page }) => {
  test.setTimeout(90_000);
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  // Free layout stacks windows; tile so both Find controls are clickable.
  await page.getByRole('button', { name: 'Tile side by side' }).click();

  await main.locator('#find-open').click();
  await expect(main.locator('#find-bar')).toBeVisible();
  await main.locator('#find-text').fill('shared-query');
  await main.locator('#replace-text').fill('main-replace');

  await second.locator('#find-open').click();
  await expect(second.locator('#find-bar')).toBeVisible();
  await expect(second.locator('#find-text')).toHaveValue('shared-query');
  await second.locator('#replace-text').fill('second-replace');

  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.query.v1'))).toBe('shared-query');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.replace.v1::w:main'))).toBe('main-replace');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.replace.v1::w:w2'))).toBe('second-replace');
});

test('host window that is not editing keeps Find, and Replace takes over editing', async ({ page }) => {
  test.setTimeout(90_000);
  const main = await openHost(page);
  await fillHostEditor(main, 'shared body for find');
  await expect(main.locator('#save-indicator')).toHaveText('Saved');
  const docId = await main.locator('#drafts').inputValue();

  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Tile side by side' }).click();

  await openDocMenu(second);
  await second.locator('#drafts').selectOption(docId);
  await expect(second.locator('#editor')).toHaveJSProperty('readOnly', true);
  if (await second.locator('#doc-menu').isVisible()) await second.locator('#doc-menu-open').click();
  await expect(second.locator('#doc-menu')).toBeHidden();

  // Host title mirrors iframe editability on focus; then Ctrl/⌘+F must still open Find.
  const secondTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await secondTitle.focus();
  await expect(secondTitle).toHaveJSProperty('readOnly', true);
  await page.keyboard.press('Control+f');
  await expect(second.locator('#find-bar')).toBeVisible();
  await expect(second.locator('#find-text')).toBeFocused();
  await second.locator('#find-text').fill('shared');
  await expect(second.locator('#find-status')).toContainText(/match/i);
  // Any window may edit: Replace stays enabled, takes over editing, then replaces.
  await expect(second.locator('#replace-one')).toBeEnabled();
  await expect(second.locator('#replace-all')).toBeEnabled();
  await second.locator('#replace-text').fill('общий');
  await second.locator('#replace-all').click();
  await expect(second.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(second.locator('#editor')).toHaveValue('общий body for find');
  await expect(main.locator('#editor')).toHaveValue('общий body for find', { timeout: 10_000 });
});

test('Ctrl+F from the host title opens Find in that window', async ({ page }) => {
  const main = await openHost(page);
  const hostTitle = page.locator('.host-window[data-window-id="main"] .host-window-title');
  await expect(hostTitle).toBeEditable({ timeout: 15_000 });
  await hostTitle.focus();
  await page.keyboard.press('Control+f');
  await expect(main.locator('#find-bar')).toBeVisible();
  await expect(main.locator('#find-text')).toBeFocused();
});
