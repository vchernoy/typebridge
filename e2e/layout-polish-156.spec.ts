import { expect, test } from '@playwright/test';
import { moreAction, openFind, setSetting } from './settings-helpers';
import { readStoredDocs, writeForeignRevision } from './storage-helpers';

test('editing toolbar stays one row at 390px (#156)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const ids = ['#undo', '#redo', '#convert-cyrillic', '#convert-latin', '#find-open', '#copy', '#more-open'];
  const mids = await Promise.all(ids.map(async id => {
    const box = (await page.locator(id).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    return Math.round(box.y + box.height / 2);
  }));
  expect(Math.max(...mids) - Math.min(...mids)).toBeLessThanOrEqual(4);
  await expect(page.getByRole('button', { name: 'To Cyrillic', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'To Latin', exact: true })).toBeVisible();
});

test('phone Find bar keeps each label with its field (#156)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await openFind(page);
  const findLabel = page.locator('label[for="find-text"]');
  const replaceLabel = page.locator('label[for="replace-text"]');
  const findInput = page.locator('#find-text');
  const replaceInput = page.locator('#replace-text');
  const findLabelBox = (await findLabel.boundingBox())!;
  const findInputBox = (await findInput.boundingBox())!;
  const replaceLabelBox = (await replaceLabel.boundingBox())!;
  const replaceInputBox = (await replaceInput.boundingBox())!;
  expect(Math.abs(findLabelBox.y - findInputBox.y)).toBeLessThanOrEqual(12);
  expect(Math.abs(replaceLabelBox.y - replaceInputBox.y)).toBeLessThanOrEqual(12);
  expect(replaceLabelBox.y).toBeGreaterThan(findInputBox.y + findInputBox.height / 2);
});

test('save state is visible once in the top bar (#156)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Hello');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(page.locator('#save-indicator')).toBeVisible();
  await expect(page.locator('#status')).toHaveText('Saved locally');
  await expect(page.locator('#status')).toHaveClass(/status--announced-only/);
  const box = await page.locator('#status').boundingBox();
  expect(box === null || box.width <= 1 || box.height <= 1).toBe(true);
});

test('long titles ellipsize with the full title available (#156)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const title = 'Untitled document with a very long name for ellipsis';
  await page.locator('#draft-title').fill(title);
  const metrics = await page.locator('#draft-title').evaluate(el => {
    const input = el as HTMLInputElement;
    return { scrollWidth: input.scrollWidth, clientWidth: input.clientWidth, title: input.title, overflow: getComputedStyle(input).textOverflow };
  });
  expect(metrics.overflow).toBe('ellipsis');
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  expect(metrics.title).toBe(title);
});

test('document counts use singular forms (#156)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('a');
  await expect(page.locator('#count')).toHaveText('1 character · 1 word · 1 min read');
});

test('narrow shortcuts sheet stacks long keys without overflow (#156)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await setSetting(page, '#tab-indent', false);
  await moreAction(page, '#keyboard-shortcuts');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  const indentKeys = dialog.locator('dl.shortcut-list dd', { hasText: 'Tab indents is off' });
  await expect(indentKeys).toBeVisible();
  const box = (await indentKeys.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const action = dialog.locator('dl.shortcut-list dt', { hasText: 'Indent / outdent' });
  const actionBox = (await action.boundingBox())!;
  // Stacked layout: keys sit below the action, not overlapping it.
  expect(box.y).toBeGreaterThanOrEqual(actionBox.y + actionBox.height - 2);
});

test('conflict-copy title updates the tooltip (#156)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#draft-title').fill('Shared note');
  await page.locator('#editor').fill('Исходный текст');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page))[0]?.text).toBe('Исходный текст');
  // An older build without edit ownership commits a newer revision (#159 W4).
  await writeForeignRevision(page, { text: 'Новое содержание' });
  await page.locator('#editor').fill('Другой вариант');
  await expect(page.locator('#status-line')).toContainText('conflict copy');
  await expect(page.locator('#draft-title')).toHaveValue(/conflict copy/);
  await expect(page.locator('#draft-title')).toHaveAttribute('title', /conflict copy/);
});
