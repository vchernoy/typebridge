import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) {
  test(`storage information is one step away at ${width}px (#137 U6)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    const link = page.getByRole('button', { name: 'About your documents', exact: true });
    await link.focus();
    await page.keyboard.press('Enter');
    const heading = page.getByRole('heading', { name: 'About your documents', exact: true });
    await expect(heading).toBeFocused();
    await expect(heading).toBeInViewport();
    const about = page.locator('#settings-about-documents');
    await expect(about).toContainText('not synced between devices');
    await expect(about).toContainText('Undo history');
    await expect(about).toContainText('reopen offline');
    await expect(page.locator('#private-session-hint')).toContainText('text and title are not saved');
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-panel')).toBeHidden();
    await expect(link).toBeFocused();
    await link.click();
    await expect(heading).toBeFocused();
  });
}
