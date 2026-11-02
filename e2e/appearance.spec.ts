import { expect, test } from '@playwright/test';
import { openSettings } from './settings-helpers';

const scheme = (page: import('@playwright/test').Page) => page.locator('html');

test('appearance persists manual choices while System follows the device (#137 U12)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'dark');
  await openSettings(page);
  const select = page.getByRole('combobox', { name: 'Color scheme', exact: true });
  await expect(select).toHaveValue('system');
  await select.selectOption('light');
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'light');
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'light');
  await openSettings(page);
  await expect(select).toHaveValue('light');
  await select.selectOption('system');
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'light');
  await select.selectOption('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'dark');
});

test('stored palette applies while the application bundle is still blocked (#137 U12)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('typebridge.appearance.v1', 'dark'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/assets/*.js', async route => { await gate; await route.continue(); });
  try {
    await page.goto('/', { waitUntil: 'commit' });
    await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'dark');
  } finally { release(); }
  await page.waitForLoadState('load');
  await expect(page.locator('#editor')).toBeEnabled();
});

test('blocked appearance storage keeps current choice and reports failure across saves (#137 U12)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'typebridge.appearance.v1') throw new Error('Storage unavailable');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'typebridge.appearance.v1') throw new Error('Storage unavailable');
      set.call(this, key, value);
    };
  });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await openSettings(page);
  await page.getByRole('combobox', { name: 'Color scheme', exact: true }).selectOption('light');
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'light');
  await expect(page.locator('#preference-warning')).toContainText('appearance');
  await page.locator('#editor').fill('Document save keeps the preference warning');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(page.locator('#preference-warning')).toContainText('appearance');
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'dark');
});

test('reset settings restores System appearance (#137 U12)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await openSettings(page);
  const select = page.getByRole('combobox', { name: 'Color scheme', exact: true });
  await select.selectOption('dark');
  await page.locator('#reset-settings').click();
  await page.getByRole('dialog', { name: 'Reset settings to defaults?', exact: true }).getByRole('button', { name: 'Reset settings', exact: true }).click();
  await expect(select).toHaveValue('system');
  await expect(scheme(page)).toHaveAttribute('data-color-scheme', 'light');
});

for (const choice of ['light', 'dark']) for (const width of [390, 1400]) {
  test(`manual appearance evidence ${choice} ${width}px (#137 U12)`, async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Chromium evidence; behavior runs in all engines.');
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('#editor')).toBeEnabled();
    await openSettings(page);
    await page.getByRole('combobox', { name: 'Color scheme', exact: true }).selectOption(choice);
    await page.locator('#appearance').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`appearance-${choice}-${width}.png`), fullPage: true, animations: 'disabled' });
  });
}
