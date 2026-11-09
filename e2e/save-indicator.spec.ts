import { expect, test } from '@playwright/test';
import { setAutosave } from './settings-helpers';

test('compact save state follows commits without replacing action feedback (#131)', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const indicator = page.locator('#save-indicator');
  await expect(indicator).toHaveText('Saved');
  await expect(indicator).not.toHaveAttribute('aria-live');
  await page.locator('#editor').fill('Текст');
  await expect(indicator).toHaveText('Saving…');
  await page.getByRole('button', { name: 'To Latin', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Select text to convert');
  await page.clock.runFor(400);
  await expect(indicator).toHaveText('Saved');
  await expect(page.locator('#status')).toHaveText('Select text to convert');
  await page.locator('#draft-title').fill('Название');
  await expect(indicator).toHaveText('Saving…');
  await page.clock.runFor(400);
  await expect(indicator).toHaveText('Saved');
  await setAutosave(page, false);
  await expect(indicator).toHaveText('Not saved');
  await expect(page.locator('#status')).toContainText('text and title are not saved and will be lost on reload');
  await setAutosave(page, true);
  await expect(indicator).toHaveText('Saved');
  // Focus mode keeps the title bar, including the save state (#104).
  await page.locator('#focus-mode').click();
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveText('Saved');
});

test('compact failure stays until a retry commits (#131)', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    Object.assign(window, { restorePut: () => { IDBObjectStore.prototype.put = put; } });
    IDBObjectStore.prototype.put = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  });
  await page.locator('#editor').fill('Текст');
  await page.clock.runFor(400);
  await expect(page.locator('#save-indicator')).toHaveText('Save failed');
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await page.locator('#editor').fill('Правка');
  await expect(page.locator('#save-indicator')).toHaveText('Save failed');
  await page.clock.runFor(400);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
});

for (const width of [320, 390, 1280]) {
  test(`save label and long title fit at ${width}px (#131)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#draft-title').fill('Очень длинное название документа '.repeat(10));
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const id of ['#draft-title', '#doc-menu-open', '#save-indicator']) {
      const box = (await page.locator(id).boundingBox())!;
      expect(box.width).toBeGreaterThan(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  });
}
