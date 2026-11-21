import { expect, test, type Page } from '@playwright/test';
import { readStoredDocs } from './storage-helpers';

// First-run welcome (#390): a fresh browser sees a working example, not an empty editor.
test.use({ storageState: { cookies: [], origins: [] } });

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Write documents that calculate' });
const example = (page: Page) => page.frameLocator('#welcome-dialog iframe');

test('a first visit shows a live example that writes nothing until the visitor chooses', async ({ page }) => {
  await page.goto('/');
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('#welcome-copy')).toBeFocused();
  // The example is interactive: moving data use changes the verdict.
  await expect(example(page).locator('.callout-title', { hasText: 'Unlimited is cheaper' })).toBeHidden();
  await example(page).getByRole('slider').first().fill('20');
  await expect(example(page).locator('.callout-title', { hasText: 'Unlimited is cheaper' })).toBeVisible();
  expect(await readStoredDocs(page)).toEqual([]);
  // Escape is Start with a blank document; the choice is remembered.
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await page.reload();
  await expect(page.frameLocator('.host-window[data-window-id="main"] iframe').locator('#editor')).toBeEnabled();
  await expect(dialog(page)).toHaveCount(0);
  expect(await readStoredDocs(page)).toEqual([]);
});

test('Make my copy saves the example as a Markdown document and opens it rendered', async ({ page }) => {
  await page.goto('/');
  await page.locator('#welcome-copy').click();
  await expect(page).toHaveURL(/\/$/);
  const main = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(main.locator('#rendered-document').getByRole('heading', { name: 'Which phone plan is cheaper?' })).toBeVisible();
  await expect(main.locator('#rendered-document input[type=range]')).toHaveCount(1);
  const docs = await readStoredDocs(page, true);
  expect(docs).toHaveLength(1);
  expect(docs[0]).toMatchObject({ title: 'Which phone plan is cheaper?', format: 'markdown' });
  expect(docs[0]!.text).toContain('```calc');
  await page.reload();
  await expect(main.locator('#rendered-document').getByRole('heading', { name: 'Which phone plan is cheaper?' })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});

test('Start with a blank document leaves the usual empty editor', async ({ page }) => {
  await page.goto('/');
  await page.locator('#welcome-blank').click();
  await expect(dialog(page)).toHaveCount(0);
  const editor = page.frameLocator('.host-window[data-window-id="main"] iframe').locator('#editor');
  await expect(editor).toBeEnabled();
  await expect(editor).toHaveValue('');
});

test('a visitor who already has documents never sees the welcome', async ({ page }) => {
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('An existing note');
  await expect.poll(async () => (await readStoredDocs(page)).length).toBe(1);
  // Not marked seen (opened via the single editor), but documents exist.
  await page.evaluate(() => localStorage.removeItem('typebridge.welcomeSeen.v1'));
  await page.goto('/');
  await expect(page.frameLocator('.host-window[data-window-id="main"] iframe').locator('#editor')).toHaveValue('An existing note');
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('typebridge.welcomeSeen.v1'))).toBe('1');
});

test('the welcome fits a phone screen and keeps both choices reachable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expect(dialog(page)).toBeVisible();
  for (const id of ['#welcome-copy', '#welcome-blank']) {
    await page.locator(id).scrollIntoViewIfNeeded();
    await expect(page.locator(id)).toBeInViewport();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
