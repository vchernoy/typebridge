import { expect, test } from '@playwright/test';

for (const apple of [false, true]) {
  test(`tooltips and the Settings picker use this platform's shortcut style; Apple=${apple}`, async ({ page }) => {
    await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { configurable: true, value }), apple ? 'MacIntel' : 'Win32');
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#undo')).toHaveAttribute('title', apple ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)');
    await expect(page.locator('#redo')).toHaveAttribute('title', apple ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Shift+Z)');
    await expect(page.locator('#goto-line')).toHaveAttribute('title', apple ? '⌘G' : 'Ctrl+G');
    await expect(page.locator('#translit-shortcut option[value="default"]')).toHaveText(apple ? 'Default (⌃⇧Space)' : 'Default (Ctrl+Shift+Space)');
    await expect(page.locator('#translit-shortcut option[value="f7"]')).toHaveText(apple ? '⇧⌘F7' : 'Ctrl+Shift+F7');
    await expect(page.locator('#shortcut-label')).toHaveText(apple ? '(⌃⇧Space)' : '(Ctrl+Shift+Space)');
  });
}

test('a touch-only tablet hides the shortcut hint but keeps it as the switch description', async ({ browser, browserName, baseURL }) => {
  // Only Chromium's mobile emulation reports no fine pointer; Firefox has none at all.
  test.skip(browserName !== 'chromium', 'Touch-only pointer emulation is Chromium-only');
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, isMobile: true, hasTouch: true, baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    expect(await page.evaluate(() => matchMedia('(any-pointer: fine)').matches)).toBe(false);
    await expect(page.locator('#shortcut-label')).toBeHidden();
    await expect(page.locator('#enabled')).toHaveAccessibleDescription('(Ctrl+Shift+Space)');
    await expect(page.locator('.mode-switch')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a wide screen with a mouse still shows the shortcut hint', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#shortcut-label')).toBeVisible();
});
