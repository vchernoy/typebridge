import { expect, test } from '@playwright/test';
import { openFind, setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

for (const channel of [true, false]) {
  test(`missing viewer follows same-ID revision-one recreation via ${channel ? 'signal' : 'focus'} (#261)`, async ({ page, context }) => {
    await page.goto('/editor.html');
    await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
    await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#editor').fill('Before deletion');
    await openFind(page); await page.locator('#find-text').fill('saved query');
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    const id = await page.locator('#drafts').inputValue();
    const viewer = await context.newPage();
    if (!channel) await viewer.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
    await viewer.goto(`/editor.html?doc=${id}&mode=view`);
    await expect(viewer.locator('#editor')).toHaveValue('Before deletion');
    await setAutosave(page, false, 'delete');
    if (!channel) await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(viewer.locator('#viewer-notice')).toBeVisible();
    await expect(viewer.locator('#editor')).toHaveValue('');
    await page.locator('#editor').fill('Recreated content');
    await page.locator('#find-text').fill('recreated query');
    await setAutosave(page, true);
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    const row = (await readStoredDocs(page)).find(row => row.id === id)!;
    expect(row.revision).toBe(1);
    if (!channel) await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(viewer.locator('#viewer-notice')).toBeHidden();
    await expect(viewer.locator('#editor')).toHaveValue('Recreated content');
    await expect(viewer.locator('#editor')).toHaveAttribute('readonly', '');
    await expect(viewer.locator('html')).toHaveAttribute('data-role', 'viewer');
    await openFind(viewer); await expect(viewer.locator('#find-text')).toHaveValue('recreated query');
  });
}

test('pending restore last-save leaves no stale dirty revision when another tab goes private (#263)', async ({ page, context }) => {
  await page.goto('/editor.html');
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Saved baseline');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const saved = (await readStoredDocs(page))[0];
  await page.evaluate(row => sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({ ...row, text: 'Recovered pending content' })), saved);
  await page.addInitScript(() => { (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 2000; });
  const other = await context.newPage(); await other.goto('/editor.html?mode=view');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#editor')).toHaveValue('Recovered pending content');
  await expect(page.locator('#editor')).toBeDisabled();
  await other.evaluate(() => localStorage.setItem('typebridge.autosave.v1', 'off'));
  await expect(page.locator('#private-marker')).toBeVisible();
  await expect(page.locator('#editor')).toBeEnabled({ timeout: 15_000 });
  await expect.poll(async () => (await readStoredDocs(page)).find(row => row.id === saved.id)?.text).toBe('Recovered pending content');
  // The private-session gate completes after its frozen last-save; then dirty should be clear.
  await expect.poll(() => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(false);
});
