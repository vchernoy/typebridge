import { expect, test, type Locator } from '@playwright/test';
import { closeDocuments, closeSettings, moreAction, openDocuments, openFind, openSettings } from './settings-helpers';

function luminance(color: string): number {
  const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function ratio(first: string, second: string): number {
  const colors = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (colors[0] + 0.05) / (colors[1] + 0.05);
}
async function textContrast(locator: Locator): Promise<void> {
  const colors = await locator.evaluate(element => {
    const view = element.ownerDocument.defaultView!;
    let parent: Element | null = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (parent) {
      background = view.getComputedStyle(parent).backgroundColor;
      if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break;
      parent = parent.parentElement;
    }
    return { text: view.getComputedStyle(element).color, background };
  });
  expect(ratio(colors.text, colors.background)).toBeGreaterThanOrEqual(4.5);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`new UI text and switch contrast in ${colorScheme} appearance (#137 U10)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto('/editor.html');
    const editor = page.locator('#editor');
    await expect(editor).toBeEnabled();
    await editor.fill('Example text');
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    await textContrast(page.locator('#save-indicator'));
    await textContrast(page.locator('.shortcut-hint'));
    await page.locator('#enabled').uncheck();
    const border = await page.locator('#enabled').evaluate(element => {
      const view = element.ownerDocument.defaultView!;
      return { border: view.getComputedStyle(element).borderTopColor,
        background: view.getComputedStyle(element.closest('section')!).backgroundColor };
    });
    expect(ratio(border.border, border.background)).toBeGreaterThanOrEqual(3);
    await openFind(page);
    await page.getByRole('textbox', { name: 'Find', exact: true }).fill('text');
    await textContrast(page.locator('#find-status'));
    await openSettings(page);
    await textContrast(page.locator('#private-session-hint'));
    await closeSettings(page);
    await openDocuments(page);
    await textContrast(page.locator('#doc-menu .menu-label'));
    await closeDocuments(page);
    await moreAction(page, '#keyboard-shortcuts');
    await textContrast(page.locator('.confirm-dialog-message .shortcut-list dt').first());
    await textContrast(page.locator('.confirm-dialog button').first());
  });
}

test('names, descriptions, modal ownership and focus return remain usable (#137 U10)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const toggle = page.getByRole('switch', { name: 'Кириллица', exact: true });
  await expect(toggle).toHaveAccessibleDescription(/Ctrl\+Shift\+Space/);
  await expect(page.locator('#save-indicator')).not.toHaveAttribute('aria-live');
  await expect(page.locator('#save-indicator')).not.toHaveAttribute('role', 'status');
  await openDocuments(page);
  // #175 step 8: Documents opens on the search box; ArrowDown/Enter move into the list.
  await expect(page.getByRole('dialog', { name: 'Documents', exact: true }).getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Documents', exact: true })).toBeFocused();
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  await settings.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).not.toHaveAttribute('aria-modal', 'true');
  await page.locator('#editor').focus();
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await openFind(page);
  await expect(page.getByRole('search', { name: 'Find and replace', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Match case', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Regex (.*)', exact: true })).toBeVisible();
  await moreAction(page, '#keyboard-shortcuts');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('main')).toHaveAttribute('inert');
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(element => element.contains(element.ownerDocument.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#more-open')).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('inert');
});

test('reduced motion and zoom-equivalent viewport preserve controls (#137 U10)', async ({ page }) => {
  // 1280x800 physical pixels at 200% zoom correspond to this CSS viewport.
  await page.setViewportSize({ width: 640, height: 400 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  expect(await page.locator('#enabled').evaluate(element => element.ownerDocument.defaultView!.getComputedStyle(element, '::before').transitionDuration)).toBe('0s');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await moreAction(page, '#keyboard-shortcuts');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Keyboard shortcuts', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
});

test('forced colors keeps panel boundaries and keyboard focus visible (#137 U10)', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Forced-colors emulation is verified in Chromium.');
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#more-open').focus();
  await page.keyboard.press('Enter');
  const item = page.getByRole('menuitem', { name: 'Go to line…', exact: true });
  await expect(item).toBeFocused();
  const focus = await item.evaluate(element => {
    const style = element.ownerDocument.defaultView!.getComputedStyle(element);
    return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
  });
  expect(focus.width).toBeGreaterThanOrEqual(2);
  expect(focus.style).not.toBe('none');
  expect(await page.locator('#more-menu').evaluate(element => parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).borderTopWidth))).toBeGreaterThanOrEqual(1);
});

test('editing sends no entered text in network requests (#137 U10)', async ({ page }) => {
  const requests: Array<{ url: string; body: string }> = [];
  page.on('request', request => requests.push({ url: request.url(), body: request.postData() ?? '' }));
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const canary = 'private-writing-canary-137';
  await page.locator('#editor').fill(canary);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const origin = new URL(page.url()).origin;
  expect(requests.every(request => new URL(request.url).origin === origin)).toBe(true);
  expect(requests.some(request => request.url.includes(canary) || request.body.includes(canary))).toBe(false);
});
