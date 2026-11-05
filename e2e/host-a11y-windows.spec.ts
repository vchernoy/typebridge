import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/** #175 step 11: F6 window cycle, named regions, Escape layering (host Settings over Find). */

async function openHost(page: Page, layout: 'free' | 'stacked' = 'free'): Promise<FrameLocator> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(mode => {
    localStorage.setItem('typebridge.host.layoutMode.v1', mode);
  }, layout);
  await page.goto('/host.html');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  return frame;
}

async function addWindows(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.getByRole('button', { name: 'New window' }).click();
  }
  await expect(page.locator('.host-window')).toHaveCount(1 + count);
  for (let i = 0; i < count; i++) {
    const id = `w${i + 2}`;
    await expect(page.frameLocator(`.host-window[data-window-id="${id}"] iframe`).locator('#editor'))
      .toBeEnabled({ timeout: 30_000 });
  }
}

async function activeWindowId(page: Page): Promise<string | null> {
  return page.locator('.host-window.is-active').getAttribute('data-window-id');
}

test('F6 cycles host windows in free layout', async ({ page }) => {
  await openHost(page, 'free');
  await addWindows(page, 2);
  await page.getByRole('button', { name: 'Tile side by side' }).click();

  // Start from the first window's editor so F6 is handled inside the iframe.
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await main.locator('#editor').focus();
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);

  await page.keyboard.press('F6');
  await expect.poll(() => activeWindowId(page)).toBe('w2');
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);

  await page.keyboard.press('F6');
  await expect.poll(() => activeWindowId(page)).toBe('w3');

  await page.keyboard.press('F6');
  await expect.poll(() => activeWindowId(page)).toBe('main');

  // Free mode raises z-order of the active window.
  const zMain = await page.locator('.host-window[data-window-id="main"]').evaluate(
    el => Number(getComputedStyle(el).zIndex),
  );
  const zOther = await page.locator('.host-window[data-window-id="w2"]').evaluate(
    el => Number(getComputedStyle(el).zIndex),
  );
  expect(zMain).toBeGreaterThan(zOther);
});

test('F6 cycles host windows in stacked layout', async ({ page }) => {
  await openHost(page, 'stacked');
  await addWindows(page, 1);

  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await main.locator('#editor').focus();
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);

  await page.keyboard.press('F6');
  await expect.poll(() => activeWindowId(page)).toBe('w2');
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);

  await page.keyboard.press('F6');
  await expect.poll(() => activeWindowId(page)).toBe('main');
});

test('F6 from the host title cycles windows', async ({ page }) => {
  await openHost(page, 'free');
  await addWindows(page, 1);
  await page.getByRole('button', { name: 'Tile side by side' }).click();

  // Activate main via the editor (title pointerdown stops shell activation).
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await main.locator('#editor').focus();
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);

  const hostTitle = page.locator('.host-window[data-window-id="main"] .host-window-title');
  await expect(hostTitle).toBeEditable({ timeout: 15_000 });
  await hostTitle.focus();

  await page.keyboard.press('F6');
  await expect.poll(() => activeWindowId(page)).toBe('w2');
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);
});

test('F6 in host Focus maximizes the next window', async ({ page }) => {
  await openHost(page, 'free');
  await addWindows(page, 1);
  await page.getByRole('button', { name: 'Tile side by side' }).click();

  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await main.locator('#focus-mode').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeVisible();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeHidden();

  await main.locator('#editor').focus();
  await page.keyboard.press('F6');
  await expect.poll(() => activeWindowId(page)).toBe('w2');
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeVisible();
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);

  const focused = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'w2');
  });
  expect(focused).toBeTruthy();
  expect(focused!.x).toBe(0);
  expect(focused!.y).toBe(0);
  expect(focused!.w).toBeGreaterThan(1000);
  expect(focused!.h).toBeGreaterThan(500);
});

test('reload keeps the front window active without rewriting z-order', async ({ page }) => {
  await openHost(page, 'free');
  await addWindows(page, 1);
  // Overlap so z-order matters (tile would leave both visible regardless of z).
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await second.locator('#editor').click();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);

  const before = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; z: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  const zMainBefore = before.find(win => win.id === 'main')?.z ?? 0;
  const zW2Before = before.find(win => win.id === 'w2')?.z ?? 0;
  expect(zW2Before).toBeGreaterThan(zMainBefore);

  await page.reload();
  await expect(page.frameLocator('.host-window[data-window-id="w2"] iframe').locator('#editor'))
    .toBeEnabled({ timeout: 30_000 });

  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);
  await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('.host-window[data-window-id="main"]')).not.toHaveAttribute('aria-current');

  const after = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; z: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(after.find(win => win.id === 'w2')?.z).toBe(zW2Before);
  expect(after.find(win => win.id === 'main')?.z).toBe(zMainBefore);
});

test('host window shells are named regions with the document title', async ({ page }) => {
  const frame = await openHost(page, 'free');
  const shell = page.locator('.host-window[data-window-id="main"]');
  await expect(shell).toHaveAttribute('role', 'region');
  await expect(shell).toHaveAttribute('data-window-id', 'main');
  await expect(shell).toHaveAttribute('aria-label', 'Untitled document');
  await expect(shell).toHaveAttribute('aria-current', 'true');
  await expect(shell).not.toHaveAttribute('aria-selected');

  const hostTitle = page.locator('.host-window[data-window-id="main"] .host-window-title');
  await expect(hostTitle).toBeEditable({ timeout: 15_000 });
  await hostTitle.fill('Region title');
  await expect.poll(async () => frame.locator('#draft-title').inputValue()).toBe('Region title');
  await expect(shell).toHaveAttribute('aria-label', 'Region title');
  await expect(page.getByRole('region', { name: 'Region title' })).toHaveCount(1);
});

test('Escape closes host Settings before Find in an embedded window', async ({ page }) => {
  const main = await openHost(page, 'free');
  await main.locator('#find-open').click();
  await expect(main.locator('#find-bar')).toBeVisible();

  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-panel')).toBeVisible();

  await main.locator('#editor').focus();
  await page.keyboard.press('Escape');

  await expect(page.locator('#settings-panel')).toBeHidden();
  // Find stays open — Settings is the higher Escape layer on the host.
  await expect(main.locator('#find-bar')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/host-focus-mode/);
});
