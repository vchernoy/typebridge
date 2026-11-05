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

test('Settings Layout Stacked forces a scrollable full-width phone stack', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const main = await openHost(page);
  await openEmbeddedSettings(main);
  await main.locator('#window-layout').selectOption('stacked');
  await expect.poll(() => page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostLayoutMode?: () => string };
    return hooks.__typebridgeHostLayoutMode?.();
  })).toBe('stacked');
  await expect(page.locator('body')).toHaveClass(/host-stacked/);

  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(3);

  const boxes = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(boxes).toHaveLength(3);
  expect(boxes.every(win => win.x === 0)).toBe(true);
  expect(boxes[0].w).toBe(boxes[1].w);
  expect(boxes[0].y + boxes[0].h).toBe(boxes[1].y);
  expect(boxes[1].y + boxes[1].h).toBe(boxes[2].y);
  const stackHeight = boxes[2].y + boxes[2].h;
  expect(stackHeight).toBeGreaterThan(844);

  const root = page.locator('#host-root');
  await expect.poll(async () => root.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await root.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('.host-window').nth(2)).toBeInViewport();

  const beforeSecond = boxes[1].h;
  await root.evaluate(el => { el.scrollTop = 0; });
  const handle = page.locator('.host-window[data-window-id="main"] .host-window-resize-s');
  await handle.scrollIntoViewIfNeeded();
  const box = await handle.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 120, { steps: 8 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(after.find(win => win.id === 'main')!.h).toBeGreaterThan(boxes[0].h);
  expect(after.find(win => win.id === 'w2')!.h).toBe(beforeSecond);
});

test('host Focus mode maximizes the active window and restores on exit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  const before = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    return hooks.__typebridgeHostWindows?.() ?? [];
  });
  expect(before).toHaveLength(2);

  await page.getByRole('button', { name: /Move window main/ }).click();
  await main.locator('#focus-mode').click();
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeVisible();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeHidden();
  await expect(main.locator('#exit-focus')).toBeVisible();
  await expect(main.locator('body')).toHaveClass(/focus-mode/);
  await expect(second.locator('body')).not.toHaveClass(/focus-mode/);

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
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeVisible();
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

test('leaving Stacked for Free keeps every window reachable in the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = await openHost(page);
  await openEmbeddedSettings(main);
  await main.locator('#window-layout').selectOption('stacked');
  await expect.poll(() => page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostLayoutMode?: () => string };
    return hooks.__typebridgeHostLayoutMode?.();
  })).toBe('stacked');
  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(3);

  await main.locator('#window-layout').selectOption('free');
  await expect.poll(() => page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostLayoutMode?: () => string };
    return hooks.__typebridgeHostLayoutMode?.();
  })).toBe('free');
  await expect(page.locator('body')).not.toHaveClass(/host-stacked/);

  const boxes = await page.evaluate(() => {
    const hooks = window as Window & {
      __typebridgeHostWindows?: () => Array<{ id: string; x: number; y: number; w: number; h: number }>;
    };
    const root = document.querySelector('#host-root')!.getBoundingClientRect();
    return {
      view: { width: Math.floor(root.width), height: Math.floor(root.height) },
      windows: hooks.__typebridgeHostWindows?.() ?? [],
    };
  });
  expect(boxes.windows).toHaveLength(3);
  for (const win of boxes.windows) {
    expect(win.x).toBeGreaterThanOrEqual(0);
    expect(win.y).toBeGreaterThanOrEqual(0);
    expect(win.x + win.w).toBeLessThanOrEqual(boxes.view.width + 1);
    expect(win.y + win.h).toBeLessThanOrEqual(boxes.view.height + 1);
  }
});

test('host Focus restore after reload shows Exit focus in the focused iframe', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);
  await expect(page.frameLocator('.host-window[data-window-id="w2"] iframe').locator('#editor'))
    .toBeEnabled({ timeout: 30_000 });
  // Raise main above w2 before entering Focus (New window leaves w2 on top).
  await page.getByRole('button', { name: /Move window main/ }).click();
  await main.locator('#focus-mode').click();
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeVisible();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeHidden();
  await expect(main.locator('#exit-focus')).toBeVisible();

  await page.reload();
  const restored = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(restored.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeVisible();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeHidden();
  await expect(restored.locator('#exit-focus')).toBeVisible({ timeout: 10_000 });
  await restored.locator('#exit-focus').click();
  await expect(page.locator('body')).not.toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeVisible();
});
