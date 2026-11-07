import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { fillHostEditor } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

/** Follow-ups to the movable windows work (#175): naming, Undo takeover, caret keys, F6. */

async function openHost(page: Page): Promise<FrameLocator> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { localStorage.setItem('typebridge.host.layoutMode.v1', 'free'); });
  await page.goto('/host.html');
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(main.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  return main;
}

async function addWindow(page: Page, id: string): Promise<FrameLocator> {
  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const frame = page.frameLocator(`.host-window[data-window-id="${id}"] iframe`);
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  return frame;
}

async function openSameDocument(frame: FrameLocator, text: string): Promise<void> {
  await frame.getByRole('button', { name: 'Documents', exact: true }).click();
  const value = await frame.locator('#drafts option', { hasText: text }).getAttribute('value');
  await frame.locator('#drafts').dispatchEvent('pointerdown');
  await frame.locator('#drafts').selectOption(value!);
  await expect(frame.locator('#editor')).toHaveValue(text);
}

test('a document started in a new host window keeps its own default name', async ({ page }) => {
  const main = await openHost(page);
  await fillHostEditor(main, 'альфа');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'альфа')).toBe(true);
  const second = await addWindow(page, 'w2');
  const secondTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await expect(secondTitle).toHaveValue('Untitled document 2');
  await fillHostEditor(second, 'бета');
  // The saved rows carry distinct names (the bug saved the new one as "Untitled document").
  await expect.poll(async () => (await readStoredDocs(page))
    .map(row => `${row.title}|${row.text}`).sort())
    .toEqual(['Untitled document 2|бета', 'Untitled document|альфа']);
  await expect(secondTitle).toHaveValue('Untitled document 2');
});

test('Undo in a window that is not editing takes over editing and undoes', async ({ page }) => {
  const main = await openHost(page);
  await main.locator('#editor').click();
  await page.keyboard.type('odin');
  await expect(main.locator('#save-indicator')).toHaveText('Saved');
  await page.keyboard.type(' dva');
  await expect(main.locator('#editor')).toHaveValue('один два');
  await expect(main.locator('#save-indicator')).toHaveText('Saved');
  const second = await addWindow(page, 'w2');
  await openSameDocument(second, 'один два');
  await expect(second.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(second.locator('#undo')).toBeEnabled();
  await second.locator('#undo').click();
  await expect(second.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(second.locator('#editor')).not.toHaveValue('один два');
  await expect(second.locator('#redo')).toBeEnabled();
});

test('Home, End and Shift+arrows move the caret in a read-only title', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.getByRole('textbox', { name: 'Document title' }).fill('Имя');
  await page.locator('#editor').fill('тело');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'reader');
  const title = other.locator('#draft-title');
  await expect(title).toHaveJSProperty('readOnly', true);
  await title.focus();
  const selection = () => title.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd]);
  await title.press('Home');
  await expect.poll(selection).toEqual([0, 0]);
  await title.press('Shift+End');
  await expect.poll(selection).toEqual([0, 3]);
  await title.press('ArrowLeft');
  await expect.poll(selection).toEqual([0, 0]);
  await title.press('ArrowRight');
  await expect.poll(selection).toEqual([1, 1]);
  // Caret keys alone do not take over editing.
  await expect(other.locator('html')).toHaveAttribute('data-role', 'reader');
  // Typing at the placed caret lands there once editing arrives.
  await title.press('x');
  await expect(other.locator('html')).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(title).toHaveValue('Ихмя');
});

test('Shift+F6 cycles host windows backwards', async ({ page }) => {
  const main = await openHost(page);
  await addWindow(page, 'w2');
  await addWindow(page, 'w3');
  const active = () => page.locator('.host-window.is-active').getAttribute('data-window-id');
  await main.locator('#editor').focus();
  await expect.poll(active).toBe('main');
  await page.keyboard.press('Shift+F6');
  await expect.poll(active).toBe('w3');
  await page.keyboard.press('Shift+F6');
  await expect.poll(active).toBe('w2');
  await page.keyboard.press('F6');
  await expect.poll(active).toBe('w3');
});

test('F6 works while focus is on the update notice', async ({ page }) => {
  await page.addInitScript(() => {
    const container = new EventTarget();
    const registration = new EventTarget();
    const worker = new EventTarget();
    Object.assign(worker, { state: 'installed', postMessage: () => {} });
    Object.assign(registration, { waiting: worker, installing: null, active: {} });
    Object.assign(container, { controller: {}, ready: Promise.resolve(registration), register: () => Promise.resolve(registration) });
    Object.defineProperty(navigator, 'serviceWorker', { value: container });
  });
  await openHost(page);
  await addWindow(page, 'w2');
  const notice = page.locator('#update-notice');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  const active = () => page.locator('.host-window.is-active').getAttribute('data-window-id');
  const before = await active();
  await notice.getByRole('button').first().focus();
  await page.keyboard.press('F6');
  await expect.poll(active).not.toBe(before);
});

test('a held control click is dropped when the window switches documents', async ({ page }) => {
  const main = await openHost(page);
  await main.locator('#editor').fill('привет');
  await expect(main.locator('#save-indicator')).toHaveText('Saved');
  const second = await addWindow(page, 'w2');
  await openSameDocument(second, 'привет');
  await expect(second.locator('html')).toHaveAttribute('data-role', 'reader');
  await page.locator('.host-window[data-window-id="w2"] iframe').evaluate((el: HTMLIFrameElement) => {
    (el.contentWindow as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800;
  });
  // To Latin is held while editing moves here; switching documents must drop it.
  await second.getByRole('button', { name: 'To Latin' }).click();
  await second.getByRole('button', { name: 'Documents', exact: true }).click();
  await second.locator('#new-draft').click();
  await expect(second.locator('#editor')).toHaveValue('');
  await second.locator('#editor').fill('новый');
  await page.waitForTimeout(1_500);
  await expect(second.locator('#editor')).toHaveValue('новый');
  await expect(main.locator('#editor')).toHaveValue('привет');
});
