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

/**
 * Toggle Autosave in Settings. Turning it off opens the delete-saved-copy dialog
 * (#114); choose Keep or Delete before the panel is closed.
 */
export async function setAutosave(
  page: Page,
  on: boolean,
  offChoice: 'keep' | 'delete' = 'keep',
): Promise<void> {
  await openSettings(page);
  const box = page.locator('#autosave');
  if (on) await box.check();
  else {
    await box.uncheck();
    const dialog = page.getByRole('dialog', { name: 'Delete the saved copy?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', {
      name: offChoice === 'delete' ? 'Delete saved copy' : 'Keep saved copy',
    }).click();
    await expect(dialog).toBeHidden();
    await expect(box).toBeEnabled();
  }
  await closeSettings(page);
}

/** Find and Go to line open on demand (#123, step 2). */
export async function openFind(page: Page): Promise<void> {
  const bar = page.locator('#find-bar');
  if (await bar.isHidden()) await page.locator('#find-open').click();
  await expect(bar).toBeVisible();
}

export async function openGoto(page: Page): Promise<void> {
  const bar = page.locator('#goto-bar');
  if (await bar.isHidden()) await moreAction(page, '#goto-open');
  await expect(bar).toBeVisible();
}

/** The document list and its actions live in the ▾ document menu (#123, step 3). */
export async function openDocuments(page: Page): Promise<void> {
  const panel = page.locator('#doc-menu');
  if (await panel.isHidden()) await page.locator('#doc-menu-open').click();
  await expect(panel).toBeVisible();
}

export async function closeDocuments(page: Page): Promise<void> {
  const panel = page.locator('#doc-menu');
  if (await panel.isVisible()) await page.locator('#doc-menu-open').click();
  await expect(panel).toBeHidden();
}

/** Open the menu, pick a document (by value or { label }), and close the menu. */
export async function selectDocument(page: Page, value: string | { label: string }): Promise<void> {
  await openDocuments(page);
  await page.locator('#drafts').selectOption(value);
  await closeDocuments(page);
}

/** Open the menu and click one of its actions; the action closes the menu. */
export async function documentAction(page: Page, selector: string): Promise<void> {
  await openDocuments(page);
  await page.locator(selector).click();
}

/** Open the toolbar's ⋯ menu and choose an item (#123, step 4); the item closes the menu. */
export async function moreAction(page: Page, selector: string): Promise<void> {
  const menu = page.locator('#more-menu');
  if (await menu.isHidden()) await page.locator('#more-open').click();
  await expect(menu).toBeVisible();
  await page.locator(selector).click();
}

/** Arm before an action that opens an in-page confirmation, as with native dialog handlers. */
export async function answerNextConfirmation(page: Page, accept: boolean, delay = 0): Promise<void> {
  const dialog = page.locator('.confirm-dialog');
  await expect(dialog).toBeVisible();
  if (delay) await page.waitForTimeout(delay);
  await dialog.getByRole('button').nth(accept ? 1 : 0).click();
  await expect(dialog).toHaveCount(0);
}
