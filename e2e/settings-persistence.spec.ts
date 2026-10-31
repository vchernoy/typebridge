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
