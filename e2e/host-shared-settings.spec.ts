import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { setHostAutosave } from './settings-helpers';

/** #175 step 7: one host Settings panel; prefs apply live to every window. */

async function openHost(page: Page): Promise<FrameLocator> {
  await page.goto('/host.html');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  return frame;
}

async function openHostSettings(page: Page): Promise<void> {
  const panel = page.locator('#settings-panel');
  if (await panel.isHidden()) await page.locator('#settings-open').click();
  await expect(panel).toBeVisible();
}

test('host Settings appearance and typing mode apply to every window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  await openHostSettings(page);
  await page.locator('#appearance').selectOption('dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe('dark');
  await expect.poll(async () => main.locator('html').getAttribute('data-color-scheme')).toBe('dark');
  await expect.poll(async () => second.locator('html').getAttribute('data-color-scheme')).toBe('dark');

  await page.locator('#tab-indent').uncheck();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('typebridge.editor.tabIndent.v1'))).toBe('off');

  await page.locator('#translit-shortcut').selectOption('f8');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('typebridge.transliteration.shortcut.v1'))).toBe('f8');
  await expect.poll(async () => main.locator('#shortcut-label').textContent()).toMatch(/F8/i);
  await expect.poll(async () => second.locator('#shortcut-label').textContent()).toMatch(/F8/i);

  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-panel')).toBeHidden();

  // Mode switch stays in window chrome and syncs across windows.
  await main.locator('.mode-switch .mode-side').first().click();
  await expect(main.locator('#enabled')).not.toBeChecked();
  await expect.poll(async () => second.locator('#enabled').isChecked()).toBe(false);
});

test('embedded Settings button opens the host panel', async ({ page }) => {
  const main = await openHost(page);
  // Embedded Settings control is visually hidden; the click handler still opens the host panel.
  await main.locator('#settings-open').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('#settings-panel')).toBeVisible();
});

test('host Autosave on persists unsaved text in every window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  await setHostAutosave(page, false);
  await second.locator('#editor').fill('Shared autosave flush');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  await setHostAutosave(page, true);
  await expect(second.locator('#save-indicator')).toHaveText('Saved', { timeout: 15_000 });
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('typebridge');
      req.onerror = () => reject(req.error ?? new Error('open failed'));
      req.onsuccess = () => resolve(req.result);
    });
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const tx = db.transaction('documents', 'readonly');
        const req = tx.objectStore('documents').getAll();
        req.onerror = () => reject(req.error ?? new Error('getAll failed'));
        req.onsuccess = () => {
          const match = (req.result as Array<{ text?: string }>).find(doc => doc.text === 'Shared autosave flush');
          resolve(match?.text ?? '');
        };
      });
      return text;
    } finally {
      db.close();
    }
  })).toBe('Shared autosave flush');

  await setHostAutosave(page, false);
  await second.locator('#editor').fill('Private again');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('typebridge.autosave.v1'))).toBe('off');
});
