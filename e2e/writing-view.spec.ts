import { expect, test, type Locator } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FOCUS_KEY = 'typebridge.focusMode.v1';
const PREFIX = 'typebridge.writingPosition.v1.';
const text = Array.from({ length: 140 }, (_, i) => `Строка ${i}: Привет 🙂`).join('\n');

test('Focus preference survives closing and reopening a real browser profile', async ({ playwright, browserName, baseURL }, testInfo) => {
  if (!baseURL) throw new Error('A Playwright baseURL is required');
  const appURL = new URL('/', baseURL).href;
  const options = { ...testInfo.project.use.launchOptions };
  if (testInfo.project.use.headless !== undefined) options.headless = testInfo.project.use.headless;
  if (testInfo.project.use.channel !== undefined) options.channel = testInfo.project.use.channel;
  const dir = await mkdtemp(join(tmpdir(), 'typebridge-writing-view-'));
  let context = await playwright[browserName].launchPersistentContext(dir, options);
  try {
    let page = await context.newPage();
    await page.goto(appURL);
    await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#editor').press('Escape');
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await context.close();
    context = await playwright[browserName].launchPersistentContext(dir, options);
    page = await context.newPage();
    await page.goto(appURL);
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await expect(page.locator('#editor')).toBeFocused();
  } finally { await context.close(); await rm(dir, { recursive: true, force: true }); }
});

async function position(field: Locator) {
  return field.evaluate((el: HTMLTextAreaElement) => ({
    start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, scrollTop: el.scrollTop,
  }));
}

test('Focus mode survives reload and new tabs without overwriting Normal-mode size', async ({ page, context }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  // Use the keyboard resize control so this checks the real size-persistence path.
  await page.locator('#resize-editor').press('ArrowRight');
  await page.locator('#resize-editor').press('ArrowDown');
  const normal = await field.evaluate(el => ({ width: el.style.width, height: el.style.height }));
  const size = await page.evaluate(() => localStorage.getItem('typebridge.editor.size.v1'));
  await field.press('Escape');
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('typebridge.editor.size.v1'))).toBe(size);
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('#editor')).toBeEnabled();
  await expect(other.locator('body')).toHaveClass(/focus-mode/);
  await expect(other.locator('#editor')).toBeFocused();
  await other.close();
  await field.press('Escape');
  expect(await field.evaluate(el => ({ width: el.style.width, height: el.style.height }))).toEqual(normal);
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  expect(await page.evaluate(key => localStorage.getItem(key), FOCUS_KEY)).toBe('off');
});

for (const focused of [false, true]) {
  test(`reload restores backward selection and editor scroll without changing text or Undo; Focus=${focused}`, async ({ page }) => {
    await page.goto('/');
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    await field.fill(text);
    await expect(page.locator('#status')).toContainText('Saved locally');
    if (focused) await field.press('Escape');
    await field.evaluate((el: HTMLTextAreaElement) => {
      el.setSelectionRange(900, 918, 'backward');
      el.scrollTop = 450;
      el.dispatchEvent(new Event('select'));
      el.dispatchEvent(new Event('scroll'));
    });
    const before = await position(field);
    await page.reload();
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(text);
    await expect.poll(() => position(field)).toEqual(before);
    if (focused) await expect(field).toBeFocused();
    // Restoring a view must not insert a history edit or destroy the saved history.
    await field.press('Control+z');
    await expect(field).toHaveValue('');
    await field.press('Control+Shift+z');
    await expect(field).toHaveValue(text);
  });
}

test('each draft and independent tab keeps its own writing position', async ({ page, context }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первый черновик 🙂');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const first = await page.locator('#drafts').inputValue();
  await field.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(3, 7); el.dispatchEvent(new Event('select')); });
  await page.locator('#new-draft').click();
  await field.fill('Второй черновик');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const second = await page.locator('#drafts').inputValue();
  await field.evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(5, 5); el.dispatchEvent(new Event('select')); });
  await page.locator('#drafts').selectOption(first);
  await expect.poll(() => position(field)).toMatchObject({ start: 3, end: 7 });
  await page.locator('#drafts').selectOption(second);
  await expect.poll(() => position(field)).toMatchObject({ start: 5, end: 5 });
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('#editor')).toBeEnabled();
  await expect(other.locator('#editor')).toHaveValue('Второй черновик');
  await expect.poll(() => position(other.locator('#editor'))).toMatchObject({ start: 0, end: 0 });
  await other.locator('#editor').evaluate((el: HTMLTextAreaElement) => { el.setSelectionRange(9, 9); el.dispatchEvent(new Event('select')); });
  await page.reload();
  await expect(field).toBeEnabled();
  await expect.poll(() => position(field)).toMatchObject({ start: 5, end: 5 });
});

test('stale offsets clamp at Unicode boundaries and corrupt view metadata is ignored', async ({ page }) => {
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('a🙂');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const id = await page.locator('#drafts').inputValue();
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, JSON.stringify({ start: 2, end: 900, direction: 'backward', scrollTop: 999999, scrollLeft: 0 })), { key: PREFIX + id });
  await page.reload();
  await expect(field).toBeEnabled();
  await expect.poll(() => position(field)).toMatchObject({ start: 3, end: 3, scrollTop: 0 });
  await expect(field).toHaveValue('a🙂');
  await page.addInitScript(({ key }) => sessionStorage.setItem(key, '{bad'), { key: PREFIX + id });
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue('a🙂');
});

test('blocked view storage starts normally and never prevents editing or toggling Focus', async ({ page }) => {
  await page.addInitScript(({ focus, prefix }) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === focus || key.startsWith(prefix)) throw new DOMException('blocked', 'SecurityError');
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === focus || key.startsWith(prefix)) throw new DOMException('blocked', 'SecurityError');
      return set.call(this, key, value);
    };
  }, { focus: FOCUS_KEY, prefix: PREFIX });
  await page.goto('/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await field.fill('Не терять');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await field.press('Escape');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await page.reload();
  await expect(field).toBeEnabled();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(field).toHaveValue('Не терять');
});
