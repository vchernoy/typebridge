import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('find text survives reload within a tab; search options persist in a new tab', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#enabled').uncheck();
  await page.locator('#find-text').fill('Русский 🙂');
  await page.locator('#replace-text').fill('Заменить');
  await page.locator('#match-case').check();
  await page.locator('#regex-mode').check();
  await page.reload();
  await expect(page.locator('#find-text')).toHaveValue('Русский 🙂');
  await expect(page.locator('#replace-text')).toHaveValue('Заменить');
  await expect(page.locator('#match-case')).toBeChecked();
  await expect(page.locator('#regex-mode')).toBeChecked();
  const other = await context.newPage(); await other.goto('/');
  await expect(other.locator('#find-text')).toHaveValue('');
  await expect(other.locator('#replace-text')).toHaveValue('');
  await expect(other.locator('#match-case')).toBeChecked();
  await expect(other.locator('#regex-mode')).toBeChecked();
  await other.locator('#find-text').fill('other');
  await page.reload(); await expect(page.locator('#find-text')).toHaveValue('Русский 🙂');
});

test('options restore when a page is reopened without retaining search text', async ({ page, context }) => {
  await page.goto('/');
  await page.locator('#regex-mode').check();
  await page.locator('#find-text').fill('private text');
  await page.close();
  const reopened = await context.newPage(); await reopened.goto('/');
  await expect(reopened.locator('#regex-mode')).toBeChecked();
  await expect(reopened.locator('#find-text')).toHaveValue('');
});

test('blocked settings storage keeps search usable and reports the problem', async ({ page }) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('typebridge.find.')) throw new DOMException('blocked', 'SecurityError');
      return set.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.locator('#enabled').uncheck();
  await page.locator('#editor').fill('Русский текст');
  await page.locator('#find-text').fill('текст');
  await expect(page.getByText('Find settings could not be saved or restored in this browser.')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('#find-status')).toContainText('1 match');
  await expect(page.locator('#editor')).toHaveValue('Русский текст');
});

test('real resize drag persists across reload and focus mode', async ({ page }) => {
  await page.setViewportSize({ width: 1900, height: 1600 });
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.scrollIntoViewIfNeeded();
  const before = await field.boundingBox();
  if (!before) throw new Error('Editor has no bounding box');
  const handle = await page.locator('#resize-editor').boundingBox();
  if (!handle) throw new Error('Resize control has no bounding box');
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  const endX = Math.min(x + 800, 1895);
  const endY = y + 80;
  await page.mouse.move(endX, endY, { steps: 12 });
  const duringDrag = await field.boundingBox();
  if (!duringDrag) throw new Error('Editor has no bounding box during drag');
  expect(endX > duringDrag.x + duringDrag.width || endY > duringDrag.y + duringDrag.height).toBe(true);
  await page.mouse.up();
  const dimensions = await field.evaluate(el => ({ width: el.style.width, height: el.style.height }));
  expect(dimensions.height).toMatch(/^\d+(?:\.\d+)?px$/);
  expect(parseFloat(dimensions.height)).toBeGreaterThan(before.height);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('typebridge.editor.size.v1'))).toBe(JSON.stringify(dimensions));
  await page.reload();
  await expect(field).toHaveCSS('height', dimensions.height);
  await page.locator('#focus-mode').click();
  await expect(page.locator('#exit-focus')).toBeVisible();
  await page.locator('#exit-focus').click();
  await expect(field).toHaveCSS('height', dimensions.height);
});

test('settings warning clears only after the failed setting is saved', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { failFind: boolean }).failFind = true;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'typebridge.find.query.v1' && (window as unknown as { failFind: boolean }).failFind) throw new DOMException('blocked', 'SecurityError');
      return original.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.locator('#enabled').uncheck();
  await page.locator('#find-text').fill('a');
  const warning = page.getByText('Find settings could not be saved or restored in this browser.');
  await expect(warning).toBeVisible();
  await page.locator('#replace-text').fill('other');
  await expect(warning).toBeVisible();
  await page.evaluate(() => { (window as unknown as { failFind: boolean }).failFind = false; });
  await page.locator('#find-text').fill('ab');
  await expect(warning).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.find.query.v1'))).toBe('ab');
});

test('browser profile restart keeps preferences but a new session has no find text', async ({ playwright, browserName, baseURL }, testInfo) => {
  if (!baseURL) throw new Error('A Playwright baseURL is required');
  const appURL = new URL('/', baseURL).href;
  const launchOptions = { ...testInfo.project.use.launchOptions };
  if (testInfo.project.use.headless !== undefined) launchOptions.headless = testInfo.project.use.headless;
  if (testInfo.project.use.channel !== undefined) launchOptions.channel = testInfo.project.use.channel;
  const dir = await mkdtemp(join(tmpdir(), 'typebridge-settings-'));
  let ctx = await playwright[browserName].launchPersistentContext(dir, launchOptions);
  try {
    let page = await ctx.newPage(); await page.goto(appURL);
    await page.locator('#match-case').check();
    await page.locator('#regex-mode').check();
    await page.locator('#find-text').fill('private');
    await ctx.close();
    ctx = await playwright[browserName].launchPersistentContext(dir, launchOptions);
    page = await ctx.newPage(); await page.goto(appURL);
    await expect(page.locator('#match-case')).toBeChecked();
    await expect(page.locator('#regex-mode')).toBeChecked();
    await expect(page.locator('#find-text')).toHaveValue('');
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});


test('resize control supports keyboard and keeps editor content and history', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('#editor');
  await page.locator('#enabled').uncheck();
  await editor.fill('Текст для редактора');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const before = await editor.boundingBox();
  if (!before) throw new Error('Editor has no bounding box');
  await page.locator('#resize-editor').focus();
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await editor.boundingBox())?.height).toBeGreaterThan(before.height);
  await expect(editor).toHaveValue('Текст для редактора');
  await page.locator('#undo').click();
  await expect(editor).toHaveValue('');
  await page.locator('#redo').click();
  await expect(editor).toHaveValue('Текст для редактора');
});

test('resize control follows the editor right edge when the width changes (#70)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  const field = page.locator('#editor');
  const button = page.locator('#resize-editor');
  await expect(field).toBeEnabled();
  const gap = async (): Promise<number> => {
    const [f, b] = await Promise.all([field.boundingBox(), button.boundingBox()]);
    if (!f || !b) throw new Error('Missing bounding box');
    return Math.abs(f.x + f.width - (b.x + b.width));
  };
  await expect.poll(gap).toBeLessThan(2);
  await button.scrollIntoViewIfNeeded();
  const start = await button.boundingBox();
  if (!start) throw new Error('Resize control has no bounding box');
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 250, y + 40, { steps: 8 });
  await expect.poll(gap).toBeLessThan(2);
  const narrowed = await button.boundingBox();
  expect(narrowed!.x).toBeLessThan(start.x - 200);
  await page.mouse.move(x - 100, y + 40, { steps: 8 });
  await expect.poll(gap).toBeLessThan(2);
  await page.mouse.up();
  await button.focus();
  await button.press('ArrowLeft');
  await expect.poll(gap).toBeLessThan(2);
  await page.reload();
  await expect(field).toBeEnabled();
  await expect.poll(gap).toBeLessThan(2);
  await page.locator('#focus-mode').click();
  await expect(page.locator('#exit-focus')).toBeVisible();
  await expect.poll(gap).toBeLessThan(2);
  await page.locator('#exit-focus').click();
  await expect.poll(gap).toBeLessThan(2);
});

test('corner grip sits on the editor corner and resizes it, down to the new minimum (#70)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto('/');
  const field = page.locator('#editor');
  const grip = page.locator('#resize-grip');
  await expect(field).toBeEnabled();
  await expect(grip).toHaveAttribute('aria-hidden', 'true');
  await grip.scrollIntoViewIfNeeded();
  const onCorner = async (): Promise<boolean> => {
    const [f, g] = await Promise.all([field.boundingBox(), grip.boundingBox()]);
    if (!f || !g) return false;
    const right = f.x + f.width, bottom = f.y + f.height;
    return g.x < right && right < g.x + g.width && g.y < bottom && bottom < g.y + g.height;
  };
  await expect.poll(onCorner).toBe(true);
  const before = await field.boundingBox();
  const start = await grip.boundingBox();
  if (!before || !start) throw new Error('Missing bounding box');
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y + 60, { steps: 8 });
  await expect.poll(onCorner).toBe(true);
  await page.mouse.up();
  const after = await field.boundingBox();
  expect(Math.round(after!.width)).toBe(Math.round(before.width - 120));
  expect(Math.round(after!.height)).toBe(Math.round(before.height + 60));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('typebridge.editor.size.v1'))).toContain(`${Math.round(before.width - 120)}px`);
  // Drag far past the top-left: the editor stops at the new 160 × 96 minimum.
  const now = await grip.boundingBox();
  await page.mouse.move(now!.x + now!.width / 2, now!.y + now!.height / 2);
  await page.mouse.down();
  await page.mouse.move(20, 20, { steps: 10 });
  await page.mouse.up();
  const smallest = await field.boundingBox();
  expect(Math.round(smallest!.width)).toBe(160);
  expect(Math.round(smallest!.height)).toBe(96);
  await expect.poll(onCorner).toBe(true);
  // Focus mode keeps the grip on the corner and usable.
  await page.locator('#focus-mode').click();
  await expect(page.locator('#exit-focus')).toBeVisible();
  await expect.poll(onCorner).toBe(true);
  await expect(page.locator('#resize-editor')).toHaveText('Resize');
});

async function expectGripClearOfText(page: import('@playwright/test').Page, expectedSize: number): Promise<void> {
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill(Array.from({ length: 60 }, (_, i) => `line ${i + 1} with enough words to reach the right edge of the editor`).join('\n'));
  await field.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.locator('#resize-grip').scrollIntoViewIfNeeded();
  const geometry = await page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('#editor')!;
    const grip = document.querySelector<HTMLElement>('#resize-grip')!.getBoundingClientRect();
    const box = textarea.getBoundingClientRect();
    const style = getComputedStyle(textarea);
    const contentBottom = box.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    const contentRight = box.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const hit = document.elementFromPoint(contentRight - 1, contentBottom - 1);
    return { gripTop: grip.top, gripWidth: grip.width, contentBottom, contentRight, hitIsEditor: hit === textarea };
  });
  expect(geometry.gripWidth).toBe(expectedSize);
  // The grip may cover the bottom padding strip, never the text area itself.
  expect(geometry.gripTop).toBeGreaterThanOrEqual(geometry.contentBottom);
  expect(geometry.hitIsEditor).toBe(true);
  const sizeBefore = await field.evaluate(el => el.style.width + 'x' + el.style.height);
  await page.mouse.click(geometry.contentRight - 4, geometry.contentBottom - 6);
  await expect(field).toBeFocused();
  const caret = await field.evaluate(el => (el as HTMLTextAreaElement).selectionStart);
  expect(caret).toBeGreaterThan(0);
  expect(await field.evaluate(el => el.style.width + 'x' + el.style.height)).toBe(sizeBefore);
}

test('corner grip does not cover editable text with a mouse (#70)', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('/');
  await expectGripClearOfText(page, 32);
});

test('corner grip touch target does not cover editable text on a touch screen (#70)', async ({ browser, browserName, baseURL }) => {
  test.skip(browserName === 'firefox', 'Firefox does not support mobile emulation');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await expectGripClearOfText(page, 44);
  await context.close();
});

for (const mode of ['Normal', 'Focus'] as const) {
  test(`${mode} mode: dragging the grip or button moves the corner with the pointer, past 900 px and down to 160 × 96 (#70)`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto('/');
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    if (mode === 'Focus') {
      await page.locator('#focus-mode').click();
      await expect(page.locator('#exit-focus')).toBeVisible();
    }
    const drag = async (selector: string, dx: number, dy: number): Promise<{ right: number; bottom: number; width: number; height: number }> => {
      await page.locator(selector).scrollIntoViewIfNeeded();
      const before = await field.boundingBox();
      const handle = await page.locator(selector).boundingBox();
      if (!before || !handle) throw new Error('Missing bounding box');
      const x = handle.x + handle.width / 2;
      const y = handle.y + handle.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      await page.mouse.up();
      const after = await field.boundingBox();
      if (!after) throw new Error('Missing bounding box');
      // Height change, not bottom position: shrinking the page near its end can scroll it.
      return { right: after.x + after.width - (before.x + before.width), bottom: after.height - before.height, width: after.width, height: after.height };
    };
    for (const selector of ['#resize-grip', '#resize-editor']) {
      const narrower = await drag(selector, -150, -60);
      expect(Math.abs(narrower.right + 150)).toBeLessThan(2);
      expect(Math.abs(narrower.bottom + 60)).toBeLessThan(2);
      const wider = await drag(selector, 150, 60);
      expect(Math.abs(wider.right - 150)).toBeLessThan(2);
      expect(Math.abs(wider.bottom - 60)).toBeLessThan(2);
    }
    const wide = await drag('#resize-grip', 200, 0);
    expect(wide.width).toBeGreaterThan(1000);
    await drag('#resize-grip', -2000, -2000);
    const smallest = await field.boundingBox();
    expect(Math.round(smallest!.width)).toBe(160);
    expect(Math.round(smallest!.height)).toBe(96);
  });
}
