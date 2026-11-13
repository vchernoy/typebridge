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
  await page.goto('/editor.html');
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
  // Quiet reader: no visible read-only notice; the next edit gesture takes over.
  await expect(beta.locator('#ownership-notice')).toBeHidden();
  await expect(beta.locator('#save-indicator')).toHaveText('Saved');

  await openDocMenu(beta);
  await beta.locator('#new-draft').click();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor');
  await beta.locator('#editor').fill('Beta document');
  await expect(beta.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'Beta document')).toBe(true);

  // #175 step 9: Find query is shared across windows; Replace text stays per-window.
  await alpha.locator('#find-open').click();
  await expect(alpha.locator('#find-bar')).toBeVisible();
  await alpha.locator('#find-text').fill('shared-find');
  await alpha.locator('#replace-text').fill('alpha-replace');
  await beta.locator('#find-open').click();
  await expect(beta.locator('#find-bar')).toBeVisible();
  await expect(beta.locator('#find-text')).toHaveValue('');
  await beta.locator('#find-text').fill('shared-find-2');
  await beta.locator('#replace-text').fill('beta-replace');

  const keys = await sessionKeys(page);
  expect(keys).toContain('typebridge.activeDraft.v1::w:alpha');
  expect(keys).toContain('typebridge.activeDraft.v1::w:beta');
  expect(keys).not.toContain('typebridge.find.query.v1');
  expect(keys).not.toContain('typebridge.find.query.v1::w:alpha');
  expect(keys).not.toContain('typebridge.find.query.v1::w:beta');
  expect(keys).not.toContain('typebridge.activeDraft.v1');
  await expect(alpha.locator('#find-text')).toHaveValue('shared-find');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.query.v1'))).toBeNull();
  expect(keys).not.toContain('typebridge.find.replace.v1::w:alpha');
  expect(keys).not.toContain('typebridge.find.replace.v1::w:beta');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.replace.v1::w:alpha'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.replace.v1::w:beta'))).toBeNull();

  // Reload each iframe: active-document hints stay independent.
  await reloadFrame(page, '#win-alpha');
  await reloadFrame(page, '#win-beta');
  await waitReady(alpha);
  await waitReady(beta);
  await expect(alpha.locator('#editor')).toHaveValue('Alpha document');
  await expect(beta.locator('#editor')).toHaveValue('Beta document');
});

test('pending unsaved backups stay isolated per window after reload', async ({ page }) => {
  test.setTimeout(90_000);
  // Shared sessionStorage flag so every same-tab iframe's put stub sees the same switch.
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await page.goto('/window-identity-harness.html');
  const alpha = page.frameLocator('#win-alpha');
  const beta = page.frameLocator('#win-beta');
  await waitReady(alpha);
  await waitReady(beta);

  await alpha.locator('#editor').fill('Alpha committed');
  await expect(alpha.locator('#save-indicator')).toHaveText('Saved');

  await openDocMenu(beta);
  await beta.locator('#new-draft').click();
  await expect(beta.locator('html')).toHaveAttribute('data-role', 'editor');
  await beta.locator('#editor').fill('Beta committed');
  await expect(beta.locator('#save-indicator')).toHaveText('Saved');
  await expect(alpha.locator('#save-indicator')).toHaveText('Saved');
  await page.waitForTimeout(500);

  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));

  // Serialize failed saves: Firefox flakes when both iframes hit IndexedDB errors together.
  await alpha.locator('#editor').click();
  await alpha.locator('#editor').fill('Alpha pending only');
  await expect(alpha.locator('#save-indicator')).toHaveText('Save failed');
  await page.locator('#win-alpha').evaluate((el: HTMLIFrameElement) => {
    el.contentWindow!.dispatchEvent(new Event('pagehide'));
  });
  await expect.poll(async () => page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1::w:alpha') ?? '')).toContain('Alpha pending only');

  await beta.locator('#editor').click();
  await beta.locator('#editor').fill('Beta pending only');
  await expect(beta.locator('#save-indicator')).toHaveText('Save failed');
  await page.locator('#win-beta').evaluate((el: HTMLIFrameElement) => {
    el.contentWindow!.dispatchEvent(new Event('pagehide'));
  });
  await expect.poll(async () => page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1::w:beta') ?? '')).toContain('Beta pending only');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1'))).toBeNull();

  // Reloading one frame recovers only that window's pending text.
  await reloadFrame(page, '#win-alpha');
  await waitReady(alpha);
  await expect(alpha.locator('#editor')).toHaveValue('Alpha pending only');
  await expect(beta.locator('#editor')).toHaveValue('Beta pending only');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1::w:beta') ?? '')).toContain('Beta pending only');
});

test('viewer document switches keep the window id in the URL', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('First saved');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const firstId = (await readStoredDocs(page)).find(row => row.text === 'First saved')!.id;

  await page.locator('#doc-menu-open').click();
  await page.locator('#new-draft').click();
  await page.locator('#editor').fill('Second saved');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const secondId = (await readStoredDocs(page)).find(row => row.text === 'Second saved')!.id;

  await page.goto(`/editor.html?window=alpha&mode=view&doc=${firstId}`);
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-window-id', 'alpha');
  await expect(page.locator('#editor')).toHaveValue('First saved');

  await page.locator('#doc-menu-open').click();
  await page.locator('#drafts').selectOption(secondId);
  await expect(page.locator('#editor')).toHaveValue('Second saved');
  await expect.poll(() => {
    const url = new URL(page.url());
    return url.searchParams.get('window');
  }).toBe('alpha');
  expect(new URL(page.url()).searchParams.get('doc')).toBe(secondId);
  expect(new URL(page.url()).searchParams.get('mode')).toBe('view');
});
