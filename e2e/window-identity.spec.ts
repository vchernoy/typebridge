import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { readStoredDocs } from './storage-helpers';

/** #175 step 2: two same-tab iframes with distinct ?window= ids behave like two tabs. */

async function waitReady(frame: FrameLocator): Promise<void> {
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
}

async function sessionKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(sessionStorage).sort());
}

async function openDocMenu(frame: FrameLocator): Promise<void> {
  const panel = frame.locator('#doc-menu');
  if (await panel.isHidden()) await frame.locator('#doc-menu-open').click();
  await expect(panel).toBeVisible();
}

async function reloadFrame(page: Page, iframeSelector: string): Promise<void> {
  await page.locator(iframeSelector).evaluate((el: HTMLIFrameElement) => {
    el.contentWindow!.location.reload();
  });
}

test('unscoped / keeps legacy sessionStorage key names', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('html')).not.toHaveAttribute('data-window-id');
  await page.locator('#editor').fill('Unscoped only');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const keys = await sessionKeys(page);
  expect(keys).toContain('typebridge.activeDraft.v1');
  expect(keys.some(key => key.includes('::w:'))).toBe(false);
});

test('two iframe windows isolate session hints and share document ownership', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/window-identity-harness.html');
  const alpha = page.frameLocator('#win-alpha');
  const beta = page.frameLocator('#win-beta');
  await waitReady(alpha);
  await waitReady(beta);

  await expect(alpha.locator('html')).toHaveAttribute('data-window-id', 'alpha');
  await expect(beta.locator('html')).toHaveAttribute('data-window-id', 'beta');

  await alpha.locator('#editor').fill('Alpha document');
  await expect(alpha.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'Alpha document')).toBe(true);
  const alphaId = (await readStoredDocs(page)).find(row => row.text === 'Alpha document')!.id;

  // Reload beta so its draft list is read from IndexedDB (same as opening a second tab after a save).
  await reloadFrame(page, '#win-beta');
  await waitReady(beta);

  await openDocMenu(beta);
  await beta.locator('#drafts').selectOption(alphaId);
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(beta.locator('#editor')).toHaveValue('Alpha document');
  await expect(beta.locator('#editor')).toHaveJSProperty('readOnly', true);
  await expect(beta.locator('#ownership-notice')).toBeVisible();

  await openDocMenu(beta);
  await beta.locator('#new-draft').click();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor');
  await beta.locator('#editor').fill('Beta document');
  await expect(beta.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'Beta document')).toBe(true);

  // Find text is per-window session state (CASE/REGEX stay in localStorage).
  await alpha.locator('#find-open').click();
  await expect(alpha.locator('#find-bar')).toBeVisible();
  await alpha.locator('#find-text').fill('alpha-find');
  await beta.locator('#find-open').click();
  await expect(beta.locator('#find-bar')).toBeVisible();
  await beta.locator('#find-text').fill('beta-find');

  const keys = await sessionKeys(page);
  expect(keys).toContain('typebridge.activeDraft.v1::w:alpha');
  expect(keys).toContain('typebridge.activeDraft.v1::w:beta');
  expect(keys).toContain('typebridge.find.query.v1::w:alpha');
  expect(keys).toContain('typebridge.find.query.v1::w:beta');
  expect(keys).not.toContain('typebridge.activeDraft.v1');
  expect(keys).not.toContain('typebridge.find.query.v1');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.query.v1::w:alpha'))).toBe('alpha-find');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.query.v1::w:beta'))).toBe('beta-find');

  // Reload each iframe: active-document hints stay independent.
  await reloadFrame(page, '#win-alpha');
  await reloadFrame(page, '#win-beta');
  await waitReady(alpha);
  await waitReady(beta);
  await expect(alpha.locator('#editor')).toHaveValue('Alpha document');
  await expect(beta.locator('#editor')).toHaveValue('Beta document');
});
