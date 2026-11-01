import { expect, type Page } from '@playwright/test';

/** Settings live in a side panel (#123); these drive it the way a user would. */
export async function openSettings(page: Page): Promise<void> {
  const panel = page.locator('#settings-panel');
  if (await panel.isHidden()) await page.locator('#settings-open').click();
  await expect(panel).toBeVisible();
}

export async function closeSettings(page: Page): Promise<void> {
  const panel = page.locator('#settings-panel');
  if (await panel.isVisible()) await page.locator('#settings-close').click();
  await expect(panel).toBeHidden();
}

/** Open Settings, set a checkbox, and close the panel again. */
export async function setSetting(page: Page, selector: string, on: boolean): Promise<void> {
  await openSettings(page);
  const box = page.locator(selector);
  if (on) await box.check(); else await box.uncheck();
  await closeSettings(page);
}

export const setAutosave = (page: Page, on: boolean): Promise<void> => setSetting(page, '#autosave', on);
