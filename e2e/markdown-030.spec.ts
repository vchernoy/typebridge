import { test, expect } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

test('0.3.0 logarithmic calc agrees in editor and shared reading', async ({ page }) => {
  const source = '```calc\ninput rate = 8 in 0..30\nt = log(2) / log(1 + rate / 100)\n```\n\n:value[t]{format=fixed:2}';
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill(source);
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-view-choice').selectOption('rendered');
  const editor = page.locator('#rendered-document');
  await expect(editor.locator('output[data-active-value="t"]')).toHaveText('9.01');
  await expect(editor.locator('.active-error, .katex-error')).toHaveCount(0);

  const encoded = await encodeSharePayload({
    title: 'Doubling time', text: source, format: 'markdown', view: 'rendered', edit: true
  });
  if (!encoded.ok) throw new Error('Share encoding failed');
  await page.goto('/read.html#doc=' + encoded.payload);
  const reader = page.locator('#read-text');
  await expect(reader.locator('output[data-active-value="t"]')).toHaveText('9.01');
  await expect(reader.locator('.active-error, .katex-error')).toHaveCount(0);
});
