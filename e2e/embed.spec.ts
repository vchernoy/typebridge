import { expect, test } from '@playwright/test';
import { encodeSharePayload, type SharedDocument } from '../src/editor/share-link';

const link = async (doc: SharedDocument): Promise<string> => {
  const encoded = await encodeSharePayload(doc);
  if (!encoded.ok) throw new Error(encoded.reason);
  return '/embed.html#doc=' + encoded.payload;
};

test('embedded Markdown renders calculations and responds to input', async ({ page }) => {
  await page.goto(await link({
    title: 'Interactive example',
    text: '```calc\ninput x = 3 in 1..10\ny = x * 2\n```\n\n:edit{input=x} Result: :value[y]',
    format: 'markdown', view: 'rendered', edit: false,
  }));
  await expect(page.locator('#embed-title')).toHaveText('Interactive example');
  await expect(page.locator('#embed-content')).toContainText('Result:');
  await expect(page.locator('#embed-content input')).toHaveCount(1);
  await expect(page.locator('#embed-content')).toContainText('6');
  await page.locator('#embed-content input').fill('5');
  await expect(page.locator('#embed-content')).toContainText('10');
  await expect(page.locator('#read-share, #edit-copy, #editor')).toHaveCount(0);
});

test('embedded documents are sanitized and malformed links fail safely', async ({ page }) => {
  await page.goto(await link({
    title: '<img src=x>',
    text: '<img src=x onerror="window.pwned=1">',
    format: 'plain', view: 'source', edit: false,
  }));
  await expect(page.locator('#embed-title')).toHaveText('<img src=x>');
  await expect(page.locator('#embed-content')).toHaveText('<img src=x onerror="window.pwned=1">');
  await expect(page.locator('#embed-content img, #embed-title img')).toHaveCount(0);
  await page.goto('/embed.html#doc=9.abc');
  await expect(page.locator('#embed-content')).toContainText('cannot be opened');
});
