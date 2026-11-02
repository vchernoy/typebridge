import { expect, test } from '@playwright/test';

for (const width of [320, 390]) {
  test(`Find and Copy have compact named touch targets at ${width}px (#137 U8)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.locator('#editor')).toBeEnabled();
    for (const name of ['Find', 'Copy']) {
      const button = page.getByRole('button', { name, exact: true });
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeLessThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(button.locator('svg')).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await expect(page.locator('#find-text')).toBeFocused();
  });
}
