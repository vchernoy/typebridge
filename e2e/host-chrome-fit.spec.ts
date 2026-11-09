import { expect, test, type Page } from '@playwright/test';

/**
 * Host chrome follow-ups (#175): the toolbar stays on one line by shortening its buttons
 * to icons, free windows show a corner resize grip, and stacked windows hide ☰ (it stays a
 * keyboard stop for height resize).
 */

async function openHost(page: Page, width: number, layout: 'free' | 'stacked' = 'free'): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  await page.addInitScript(mode => { localStorage.setItem('typebridge.host.layoutMode.v1', mode); }, layout);
  await page.goto('/');
  await expect(page.frameLocator('.host-window[data-window-id="main"] iframe').locator('#editor')).toBeEnabled({ timeout: 30_000 });
}

async function toolbarRows(page: Page): Promise<number> {
  return page.locator('#host-toolbar').evaluate(bar => {
    const tops = [...bar.children]
      .map(el => el.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0);
    const firstBottom = Math.min(...tops.map(box => box.bottom));
    return tops.some(box => box.top >= firstBottom - 1) ? 2 : 1;
  });
}

test('a wide host toolbar keeps full button labels on one line', async ({ page }) => {
  await openHost(page, 1280);
  const toolbar = page.locator('#host-toolbar');
  await expect(toolbar).toHaveAttribute('data-fit', '0');
  await expect(toolbar.locator('[data-host-action="tile-side"] .btn-text')).not.toHaveCSS('position', 'absolute');
  await expect(toolbar.locator('#host-shortcut-label')).toBeVisible();
  expect(await toolbarRows(page)).toBe(1);
});

test('a narrower host toolbar switches to icon buttons instead of wrapping', async ({ page }) => {
  await openHost(page, 1280);
  const toolbar = page.locator('#host-toolbar');
  await page.setViewportSize({ width: 860, height: 800 });
  await expect(toolbar).toHaveAttribute('data-fit', '2');
  expect(await toolbarRows(page)).toBe(1);
  await expect(toolbar.locator('#host-shortcut-label')).toBeHidden();
  for (const name of ['New window', 'Tile side by side', 'Tile stacked', 'Settings']) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    await expect(button.locator('.btn-text')).toHaveCSS('position', 'absolute');
  }
  // Widening again restores the labels.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(toolbar).toHaveAttribute('data-fit', '0');
});

test('free windows show a corner resize grip that resizes the window', async ({ page }) => {
  await openHost(page, 1280);
  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const shell = page.locator('.host-window[data-window-id="main"]');
  const grip = shell.locator('.host-window-resize-se');
  await expect(grip).toBeVisible();
  await expect(grip).not.toHaveCSS('background-image', 'none');
  const shellBox = (await shell.boundingBox())!;
  const gripBox = (await grip.boundingBox())!;
  // Drawn inside the window corner, so it is not clipped away.
  expect(gripBox.x + gripBox.width).toBeLessThanOrEqual(shellBox.x + shellBox.width + 0.5);
  expect(gripBox.y + gripBox.height).toBeLessThanOrEqual(shellBox.y + shellBox.height + 0.5);
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x - 80, gripBox.y - 60, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await shell.boundingBox())!.width).toBeLessThan(shellBox.width - 40);
});

test('stacked windows hide ☰, which still takes keyboard height resize', async ({ page }) => {
  await openHost(page, 390, 'stacked');
  await expect(page.locator('body')).toHaveClass(/host-stacked/);
  const move = page.locator('.host-window[data-window-id="main"] .host-window-move');
  await expect.poll(async () => (await move.boundingBox())?.width ?? 0).toBeLessThan(1);
  const height = () => page.evaluate(() => {
    const hooks = window as Window & { __typebridgeHostWindows?: () => Array<{ id: string; h: number }> };
    return hooks.__typebridgeHostWindows?.().find(win => win.id === 'main')?.h ?? 0;
  });
  // Reach it from the keyboard: Shift+Tab from the title lands on it and shows it.
  await page.locator('.host-window[data-window-id="main"] .host-window-title').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(move).toBeFocused();
  await expect.poll(async () => (await move.boundingBox())?.width ?? 0).toBeGreaterThan(10);
  const before = await height();
  await page.keyboard.press('Control+Shift+ArrowUp');
  await expect.poll(height).toBeLessThan(before);
});
