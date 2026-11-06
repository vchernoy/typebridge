import { expect, test, type Page } from '@playwright/test';

/**
 * #197: typing or pasting into the title of a window that is not editing starts the
 * takeover, and every keystroke made while it completes is kept and applied once.
 */

async function savedReaderPair(page: Page, context: import('@playwright/test').BrowserContext): Promise<Page> {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document title' }).fill('Имя');
  await page.locator('#editor').fill('тело');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('#editor')).toHaveValue('тело');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#draft-title')).toHaveValue('Имя');
  // Hold the takeover open so the keys land while it is still in progress.
  await other.evaluate(() => { (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800; });
  return other;
}

test('keys typed into a reader title during a slow takeover are all kept', async ({ page, context }) => {
  const other = await savedReaderPair(page, context);
  const title = other.locator('#draft-title');
  await title.focus();
  await title.press('End');
  await title.pressSequentially('abc');
  await title.press('Backspace');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue('Имяаб');
  await expect(title).toBeFocused();
  await expect(other.locator('#editor')).toHaveValue('тело');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  await expect(page.locator('#draft-title')).toHaveValue('Имяаб', { timeout: 10_000 });
});

test('caret moves between held title keys are kept', async ({ page, context }) => {
  const other = await savedReaderPair(page, context);
  const title = other.locator('#draft-title');
  await title.focus();
  const caretAt = (pos: number) => title.evaluate((el: HTMLInputElement, at: number) => el.setSelectionRange(at, at), pos);
  await caretAt(3);
  await title.press('1');
  await caretAt(0);
  await title.press('2');
  await caretAt(3);
  await title.press('3');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue('2Имя13');
});

test('moving to the text during a slow takeover keeps focus there', async ({ page, context }) => {
  const other = await savedReaderPair(page, context);
  const title = other.locator('#draft-title');
  await title.focus();
  await title.press('End');
  await title.press('1');
  await other.locator('#editor').focus();
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue('Имя1');
  await expect(other.locator('#editor')).toBeFocused();
});

test('a held Backspace after an emoji removes the whole character', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document title' }).fill('Имя😀');
  await page.locator('#editor').fill('тело');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'reader');
  await other.evaluate(() => { (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800; });
  const title = other.locator('#draft-title');
  await title.focus();
  await title.evaluate((el: HTMLInputElement) => el.setSelectionRange(el.value.length, el.value.length));
  await title.press('Backspace');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue('Имя');
});

test('a paste into a reader title is applied after the takeover', async ({ page, context }) => {
  const other = await savedReaderPair(page, context);
  const title = other.locator('#draft-title');
  await title.focus();
  await title.press('End');
  await title.evaluate((el: HTMLInputElement) => {
    const data = new DataTransfer();
    data.setData('text/plain', ' 2');
    const paste = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    // Firefox ignores clipboardData in the constructor; attach it so every engine sees it.
    Object.defineProperty(paste, 'clipboardData', { value: data });
    el.dispatchEvent(paste);
  });
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue('Имя 2');
  await expect(other.locator('#editor')).toHaveValue('тело');
});

test('switching documents during the takeover drops the held title edit', async ({ page, context }) => {
  const other = await savedReaderPair(page, context);
  const title = other.locator('#draft-title');
  await title.focus();
  await title.press('End');
  await title.pressSequentially('x');
  await other.getByRole('button', { name: 'Documents', exact: true }).click();
  await other.locator('#new-draft').click();
  await expect(other.locator('#editor')).toHaveValue('');
  await other.waitForTimeout(1_200);
  await expect(title).not.toHaveValue(/Имя/);
  await expect(page.locator('#draft-title')).toHaveValue('Имя');
});

test('typing into a host window title during a slow takeover keeps every key', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('typebridge.host.layoutMode.v1', 'free'); });
  await page.goto('/host.html');
  const a = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(a.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await a.locator('#editor').fill('общий');
  await expect(a.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const b = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(b.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await b.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await b.locator('#drafts option', { hasText: 'общий' }).getAttribute('value');
  await b.locator('#drafts').dispatchEvent('pointerdown');
  await b.locator('#drafts').selectOption(value!);
  await expect(b.locator('html')).toHaveAttribute('data-role', 'reader');
  await page.locator('.host-window[data-window-id="w2"] iframe').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800;
  });

  const bTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await bTitle.focus();
  await bTitle.press('End');
  await bTitle.pressSequentially(' abc');
  await expect(b.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(bTitle).toHaveValue('Untitled document абц', { timeout: 10_000 });
  await expect(b.locator('#editor')).toHaveValue('общий');
  await expect(page.locator('.host-window[data-window-id="main"] .host-window-title'))
    .toHaveValue('Untitled document абц', { timeout: 10_000 });
});

test('Rename then typing at once in a host window that is not editing replaces the name', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('typebridge.host.layoutMode.v1', 'free'); });
  await page.goto('/host.html');
  const a = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(a.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await a.locator('#editor').fill('общий');
  await expect(a.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const b = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(b.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await b.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await b.locator('#drafts option', { hasText: 'общий' }).getAttribute('value');
  await b.locator('#drafts').dispatchEvent('pointerdown');
  await b.locator('#drafts').selectOption(value!);
  await expect(b.locator('html')).toHaveAttribute('data-role', 'reader');
  await page.locator('.host-window[data-window-id="w2"] iframe').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800;
  });

  const bTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await page.locator('.host-window[data-window-id="w2"]').getByRole('button', { name: 'Rename document' }).click();
  await page.keyboard.type('Novoe');
  await expect(b.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(bTitle).toHaveValue('Новое', { timeout: 10_000 });
  await expect(b.locator('#editor')).toHaveValue('общий');
});
