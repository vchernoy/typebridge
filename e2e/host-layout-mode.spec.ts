import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/** #175 step 6: Auto / Free / Stacked layout and host Focus maximize. */

async function openHost(page: Page): Promise<FrameLocator> {
  await page.goto('/host.html');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  return frame;
}

async function openEmbeddedSettings(frame: FrameLocator): Promise<void> {
  const panel = frame.locator('#settings-panel');
  if (await panel.isHidden()) await frame.locator('#settings-open').click();
  await expect(panel).toBeVisible();
}

test('Settings Layout Stacked forces full-width phone stack on a wide host', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);

  await openEmbeddedSettings(main);
  await main.locator('#window-layout').selectOption('stacked');
  await expect.poll(() => page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostLayoutMode?: () => string };
    return hooks.__typebridgeHostLayoutMode?.();
  })).toBe('stacked');
  await expect(page.locator('body')).toHaveClass(/host-stacked/);

  const boxes = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(boxes).toHaveLength(2);
  expect(boxes.every(win => win.x === 0)).toBe(true);
  expect(boxes[0].w).toBe(boxes[1].w);
  expect(boxes[0].y + boxes[0].h).toBe(boxes[1].y);
});

test('host Focus mode maximizes the active window and restores on exit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  await page.getByRole('button', { name: 'Tile side by side' }).click();

  const before = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(before).toHaveLength(2);

  await main.locator('#focus-mode').click();
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeHidden();

  const focused = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main');
  });
  expect(focused).toBeTruthy();
  expect(focused!.x).toBe(0);
  expect(focused!.y).toBe(0);
  expect(focused!.w).toBeGreaterThan(1000);
  expect(focused!.h).toBeGreaterThan(500);

  await main.locator('#exit-focus').click();
  await expect(page.locator('body')).not.toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeVisible();

  const after = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(after).toHaveLength(2);
  expect(after.find(win => win.id === 'main')).toMatchObject({
    x: before.find(win => win.id === 'main')!.x,
    y: before.find(win => win.id === 'main')!.y,
    w: before.find(win => win.id === 'main')!.w,
    h: before.find(win => win.id === 'main')!.h,
  });
});
