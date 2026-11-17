import { expect, test } from '@playwright/test';
import { decodeSharePayload, sharePayloadFromHash } from '../src/editor/share-link';
const source = '# Direct share\n\n```calc\ninput x = 2\n```\n\n:input[x]';

test('Documents Tools fits a short phone after format controls wrap', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  const panel = page.locator('#doc-menu');
  await expect.poll(() => panel.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  await page.locator('#more-open').click(); await page.keyboard.press('End');
  await expect(page.locator('#keyboard-shortcuts')).toBeFocused();
  expect(await page.locator('#keyboard-shortcuts').evaluate(element => {
    const r = element.getBoundingClientRect(), p = element.closest('#doc-menu')!.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom && r.bottom <= innerHeight;
  })).toBe(true);
});

test('Go to line shortcut does not open the relocated Tools panel', async ({ page }) => {
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').press('ControlOrMeta+g');
  await expect(page.locator('#goto-bar')).toBeVisible();
  await expect(page.locator('#goto-line')).toBeFocused();
  await expect(page.locator('#doc-menu')).toBeHidden();
});

for (const width of [320, 1440]) for (const rendered of [false, true]) {
  test(`direct Share needs two activations at ${width}px rendered=${rendered}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 568 });
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} } }));
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#editor').fill(source);
    await page.locator('#doc-menu-open').click(); await page.locator('#document-format').selectOption('markdown');
    await page.locator('#doc-menu-open').click();
    if (rendered) await page.locator('#document-view-preview').click();
    const share = page.getByRole('button', { name: 'Share document', exact: true });
    await expect(share).toBeInViewport();
    const rect = await share.boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(44); expect(rect!.height).toBeGreaterThanOrEqual(44);
    // First activation opens; second copies. No Documents menu or manual scroll.
    await share.click();
    const sheet = page.getByRole('dialog', { name: 'Share link', exact: true });
    await expect(sheet.locator('#share-copy')).toBeInViewport();
    await sheet.locator('#share-copy').click();
    await expect(sheet.locator('.share-status')).toHaveText('Link copied.');
    const url = new URL(await sheet.locator('#share-url').inputValue());
    expect(await decodeSharePayload(sharePayloadFromHash(url.hash))).toMatchObject({ ok: true, document: { text: source, format: 'markdown' } });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `/tmp/direct-share-${width}-${rendered}.png`, fullPage: true });
    await page.keyboard.press('Escape'); await expect(share).toBeFocused();
  });
}

for (const comparison of [false, true]) {
  test(`read-only Share preserves source ownership comparison=${comparison}`, async ({ page, context }) => {
    await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#editor').fill(source);
    await page.locator('#doc-menu-open').click(); await page.locator('#document-format').selectOption('markdown');
    await page.locator('#doc-menu-open').click(); await expect(page.locator('#save-indicator')).toHaveText('Saved');
    const id = await page.locator('#drafts').inputValue();
    const other = await context.newPage(); await other.goto(`/editor.html?doc=${id}${comparison ? '&mode=view' : ''}`);
    await expect(other.locator('#editor')).toHaveAttribute('readonly', '');
    await other.locator('#document-view-preview').click();
    const read = () => page.evaluate(id => new Promise(resolve => {
      const r = indexedDB.open('typebridge'); r.onsuccess = () => {
        const db = r.result; const tx = db.transaction(['documents', 'editOwnership']);
        const doc = tx.objectStore('documents').get(id), owner = tx.objectStore('editOwnership').get(id);
        tx.oncomplete = () => { resolve({ document: doc.result, owner: owner.result }); db.close(); };
      };
    }), id);
    const before = await read();
    await other.locator('#share-open').focus(); await other.keyboard.press('Enter');
    const sheet = other.getByRole('dialog', { name: 'Share link', exact: true });
    await expect(sheet.locator('#share-url')).not.toHaveValue('');
    expect(await read()).toEqual(before);
    await expect(page.locator('#editor')).toHaveValue(source);
    await other.keyboard.press('Escape'); await expect(other.locator('#share-open')).toBeFocused();
  });
}

test('Share remains available in standalone Focus and embedded host windows', async ({ page }) => {
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await page.locator('#share-open').click();
  await expect(page.getByRole('dialog', { name: 'Share link', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#share-open')).toBeFocused();
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  const editor = page.frameLocator('.host-window iframe').first();
  await expect(editor.locator('#editor')).toBeEnabled();
  await editor.locator('#share-open').click();
  const sheet = editor.getByRole('dialog', { name: 'Share link', exact: true });
  await expect(sheet.locator('#share-copy')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(editor.locator('#share-open')).toBeFocused();
});
