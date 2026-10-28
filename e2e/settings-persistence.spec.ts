import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('find text survives reload within a tab; search options persist in a new tab', async ({ page, context }) => {
  await page.goto('/typebridge/');
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
  const other = await context.newPage(); await other.goto('/typebridge/');
  await expect(other.locator('#find-text')).toHaveValue('');
  await expect(other.locator('#replace-text')).toHaveValue('');
  await expect(other.locator('#match-case')).toBeChecked();
  await expect(other.locator('#regex-mode')).toBeChecked();
  await other.locator('#find-text').fill('other');
  await page.reload(); await expect(page.locator('#find-text')).toHaveValue('Русский 🙂');
});

test('options restore when a page is reopened without retaining search text', async ({ page, context }) => {
  await page.goto('/typebridge/');
  await page.locator('#regex-mode').check();
  await page.locator('#find-text').fill('private text');
  await page.close();
  const reopened = await context.newPage(); await reopened.goto('/typebridge/');
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
  await page.goto('/typebridge/');
  await page.locator('#enabled').uncheck();
  await page.locator('#editor').fill('Русский текст');
  await page.locator('#find-text').fill('текст');
  await expect(page.getByText('Find settings could not be saved or restored in this browser.')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('#find-status')).toContainText('1 match');
  await expect(page.locator('#editor')).toHaveValue('Русский текст');
});

test('editor resize preference survives reload and focus mode', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.evaluate(el => { el.style.width = '700px'; el.style.height = '350px'; el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });
  await page.reload();
  await expect(field).toHaveCSS('height', '350px');
  await page.locator('#focus-mode').click();
  await expect(page.locator('#exit-focus')).toBeVisible();
  await page.locator('#exit-focus').click();
  await expect(field).toHaveCSS('height', '350px');
});


test('browser profile restart keeps preferences but a new session has no find text', async ({ playwright, browserName }) => {
  const dir = await mkdtemp(join(tmpdir(), 'typebridge-settings-'));
  let ctx = await playwright[browserName].launchPersistentContext(dir, { headless: true });
  try {
    let page = await ctx.newPage(); await page.goto('http://127.0.0.1:4173/typebridge/');
    await page.locator('#match-case').check();
    await page.locator('#regex-mode').check();
    await page.locator('#find-text').fill('private');
    await ctx.close();
    ctx = await playwright[browserName].launchPersistentContext(dir, { headless: true });
    page = await ctx.newPage(); await page.goto('http://127.0.0.1:4173/typebridge/');
    await expect(page.locator('#match-case')).toBeChecked();
    await expect(page.locator('#regex-mode')).toBeChecked();
    await expect(page.locator('#find-text')).toHaveValue('');
  } finally { await ctx.close(); await rm(dir, { recursive: true, force: true }); }
});
