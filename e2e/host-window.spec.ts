import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { moreAction, setAutosave } from './settings-helpers';

/** #175 step 5: host free-layout windows; update notice on the host. */

async function openHost(page: Page): Promise<FrameLocator> {
  await page.goto('/host.html');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(frame.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(frame.locator('html')).toHaveAttribute('data-window-id', 'main');
  return frame;
}

test('host single window matches standalone editor typing and save', async ({ page }) => {
  const editor = await openHost(page);
  await editor.locator('#editor').pressSequentially('privet');
  await expect(editor.locator('#save-indicator')).toHaveText('Saved');
  await expect(editor.locator('#editor')).toHaveValue('привет');
});

test('host keeps Settings in the iframe so delayed lookups still work', async ({ page }) => {
  const editor = await openHost(page);
  await expect(editor.locator('#settings-panel')).toHaveCount(1);
  await expect(page.locator('#settings-panel')).toHaveCount(0);

  await editor.locator('#settings-open').click();
  await expect(editor.locator('#settings-panel')).toBeVisible();
  await editor.locator('#settings-close').click();
  await expect(editor.locator('#settings-panel')).toBeHidden();

  await moreAction(editor as unknown as Page, '#keyboard-shortcuts');
  await expect(editor.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })).toBeVisible();
});

test('embedded editor does not mount its own update notice', async ({ page }) => {
  const editor = await openHost(page);
  await expect(editor.locator('#update-notice')).toHaveCount(0);
});

test('offline host refresh stays on the host shell', async ({ page, context }) => {
  const editor = await openHost(page);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('Offline worker did not activate');
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    }
  });
  await editor.locator('#editor').fill('Offline host draft');
  await expect(editor.locator('#save-indicator')).toHaveText('Saved');
  await context.setOffline(true);
  await page.reload();
  await expect(page).toHaveURL(/host\.html/);
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(frame.locator('html')).toHaveAttribute('data-embed', '1');
  await expect(frame.locator('#editor')).toHaveValue('Offline host draft');
  await context.setOffline(false);
});

test('host does not reload when private edits change after update consent', async ({ page }) => {
  const editor = await openHost(page);
  await setAutosave(editor as unknown as Page, false);
  await editor.locator('#editor').fill('Keep this private text');
  await expect(editor.locator('#save-indicator')).toHaveText('Not saved');

  const prepare = page.evaluate(async () => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.host-editor')!;
    const hooks = frame.contentWindow as Window & { __typebridgePrepareUpdateReload?: () => Promise<boolean> };
    return hooks.__typebridgePrepareUpdateReload?.() ?? false;
  });
  const dialog = editor.getByRole('dialog', { name: 'Reload without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and reload' }).click();
  expect(await prepare).toBe(true);

  await editor.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `${el.value}!`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const outcome = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('iframe.host-editor')!;
    const hooks = frame.contentWindow as Window & { __typebridgeAssertSafeUpdateReload?: () => void };
    try {
      hooks.__typebridgeAssertSafeUpdateReload?.();
      return 'allowed';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(outcome).toContain('Private edits changed');
  await expect(page).toHaveURL(/host\.html/);
  await expect(editor.locator('#editor')).toHaveValue('Keep this private text!');
});

test('New window tiles and persists two free windows', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(second.locator('html')).toHaveAttribute('data-window-id', 'w2');

  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const geometry = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; x: number; w: number }> };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(geometry).toHaveLength(2);
  expect(geometry[0].x).toBe(0);
  expect(geometry[1].x).toBeGreaterThan(0);

  await second.locator('#editor').fill('Second window text');
  await expect(second.locator('#save-indicator')).toHaveText('Saved');

  await page.reload();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const restored = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(restored.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(restored.locator('#editor')).toHaveValue('Second window text');
});

test('update reload asks every window about private text', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await setAutosave(second as unknown as Page, false);
  await second.locator('#editor').fill('Private only in second');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  const prepare = page.evaluate(async () => {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')];
    for (const frame of frames) {
      const hooks = frame.contentWindow as Window & { __typebridgePrepareUpdateReload?: () => Promise<boolean> };
      const prepareOne = hooks.__typebridgePrepareUpdateReload;
      if (!prepareOne) continue;
      if (!await prepareOne()) return false;
    }
    return true;
  });
  const dialog = second.getByRole('dialog', { name: 'Reload without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  expect(await prepare).toBe(false);
  await expect(second.locator('#editor')).toHaveValue('Private only in second');
});

test('clicking a background editor raises its window', async ({ page }) => {
  test.setTimeout(90_000);
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Tile side by side' }).click();
  await page.locator('.host-window[data-window-id="main"] .host-window-titlebar').click();
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);

  await second.locator('#editor').click();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);
  const order = await page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; z: number }> };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  const mainZ = order.find(win => win.id === 'main')?.z ?? 0;
  const secondZ = order.find(win => win.id === 'w2')?.z ?? 0;
  expect(secondZ).toBeGreaterThan(mainZ);
});

test('closing a dirty Autosave-off window asks before removing it', async ({ page }) => {
  test.setTimeout(90_000);
  const editor = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  const secondShell = page.locator('.host-window[data-window-id="w2"]');
  const second = secondShell.frameLocator('iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await setAutosave(second as unknown as Page, false);
  await second.locator('#editor').fill('Private in second');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  await secondShell.locator('.host-window-close').click();
  const dialog = second.getByRole('dialog', { name: 'Close without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);

  await secondShell.locator('.host-window-close').click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and close' }).click();
  await expect(page.locator('.host-window')).toHaveCount(1);
  await expect(editor.locator('#editor')).toBeEnabled();
});
