import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { documentAction } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

/**
 * A window showing a document deleted elsewhere holds the last copy of its text: it
 * offers Keep as new document / Close and never tries to take over editing.
 */

async function deletedInOtherTab(page: Page, context: BrowserContext, text: string): Promise<Page> {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill(text);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const other = await context.newPage();
  await other.goto('/editor.html');
  await expect(other.locator('#editor')).toHaveValue(text);
  await expect(other.locator('html')).toHaveAttribute('data-role', 'reader');

  await documentAction(page, '#delete-draft');
  await page.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete document' }).click();
  await expect(page.locator('#status')).toContainText('Document deleted');
  await expect.poll(async () => {
    await other.locator('#editor').dispatchEvent('focus');
    return other.locator('#deleted-bar').isVisible();
  }).toBe(true);
  return other;
}

test('a window showing a deleted document offers Keep, never a takeover', async ({ page, context }) => {
  const other = await deletedInOtherTab(page, context, 'последний текст');
  await expect(other.locator('#deleted-bar')).toContainText('deleted in another window');
  await expect(other.locator('#ownership-notice')).toBeHidden();
  // Clicking the text does not ask a non-existent owner to hand over.
  await other.locator('#editor').click();
  await other.waitForTimeout(1_500);
  await expect(other.locator('#edit-here-bar')).toBeHidden();

  await other.getByRole('button', { name: 'Keep as new document' }).click();
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(other.locator('#deleted-bar')).toBeHidden();
  await expect(other.locator('#editor')).toHaveValue('последний текст');
  await expect(other.locator('#status')).toContainText('Kept as a new document');
  await expect.poll(async () => (await readStoredDocs(other)).some(row => row.text === 'последний текст')).toBe(true);
});

test('typing into a deleted document keeps it as a new document with the keys applied', async ({ page, context }) => {
  const other = await deletedInOtherTab(page, context, 'текст');
  await other.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await other.keyboard.type(' da');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(other.locator('#editor')).toHaveValue('текст да');
  await expect.poll(async () => (await readStoredDocs(other)).some(row => row.text === 'текст да')).toBe(true);
});

test('Close leaves a deleted document for another one', async ({ page, context }) => {
  const other = await deletedInOtherTab(page, context, 'закрыть');
  await other.getByRole('button', { name: 'Close' }).click();
  await expect(other.locator('#deleted-bar')).toBeHidden();
  await expect(other.locator('#editor')).not.toHaveValue('закрыть');
  expect((await readStoredDocs(other)).some(row => row.text === 'закрыть')).toBe(false);
});

test('Delete warns when the document is open in another host window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(main.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await main.locator('#editor').fill('общий');
  await expect(main.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await second.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await second.locator('#drafts option', { hasText: 'общий' }).getAttribute('value');
  await second.locator('#drafts').dispatchEvent('pointerdown');
  await second.locator('#drafts').selectOption(value!);
  await expect(second.locator('#editor')).toHaveValue('общий');

  await main.getByRole('button', { name: 'Documents', exact: true }).click();
  await main.locator('#delete-draft').click();
  await expect(main.getByRole('dialog', { name: 'Delete document?' })).toContainText('also open in another window');
  await main.getByRole('button', { name: 'Delete document' }).click();
  await expect(second.locator('#deleted-bar')).toBeVisible({ timeout: 10_000 });
});

test('keys typed while the kept copy saves stay in order', async ({ page, context }) => {
  const other = await deletedInOtherTab(page, context, 'ряд');
  await other.evaluate(() => {
    const hooks = window as Window & { __typebridgeDelayAcquireMs?: number; __typebridgeDelayPersistMs?: number };
    hooks.__typebridgeDelayAcquireMs = 300;
    hooks.__typebridgeDelayPersistMs = 600;
  });
  await other.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await other.keyboard.type(' ab');
  await other.waitForTimeout(150);
  await other.keyboard.type('v');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(other.locator('#editor')).toHaveValue('ряд абв');
});

test('Close during a slow Keep does not overwrite the document it opens', async ({ page, context }) => {
  const other = await deletedInOtherTab(page, context, 'медленно');
  await other.evaluate(() => { (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800; });
  await other.getByRole('button', { name: 'Keep as new document' }).click();
  await other.getByRole('button', { name: 'Close' }).click();
  await other.waitForTimeout(1_500);
  // Close was ignored while Keep held the transition; the kept copy is what is shown.
  await expect(other.locator('#editor')).toHaveValue('медленно');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor');
});

test('several keys typed in a host title during Keep are applied in order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(main.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await main.locator('#editor').fill('общий');
  await expect(main.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await second.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await second.locator('#drafts option', { hasText: 'общий' }).getAttribute('value');
  await second.locator('#drafts').dispatchEvent('pointerdown');
  await second.locator('#drafts').selectOption(value!);
  await expect(second.locator('#editor')).toHaveValue('общий');
  await main.getByRole('button', { name: 'Documents', exact: true }).click();
  await main.locator('#delete-draft').click();
  await main.getByRole('button', { name: 'Delete document' }).click();
  await expect(second.locator('#deleted-bar')).toBeVisible({ timeout: 10_000 });
  await page.locator('.host-window[data-window-id="w2"] iframe').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 600;
  });
  const title = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await title.focus();
  await title.press('End');
  await title.pressSequentially(' abc');
  await expect(second.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue(/ абц$/, { timeout: 10_000 });
});

test('caret keys are held still while Keep makes the copy', async ({ page, context }) => {
  const other = await deletedInOtherTab(page, context, 'текст');
  await other.evaluate(() => { (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 600; });
  await other.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await other.keyboard.press('a');
  await other.keyboard.press('Home');
  await other.keyboard.press('b');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  // Home during the copy does not move where the held keys land.
  await expect(other.locator('#editor')).toHaveValue('текстаб');
});
