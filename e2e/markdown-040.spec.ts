import { test, expect } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

const source = '```calc\ninput x = 0 in 0..10\nk = 2 + 3\n```\n\n:input[x]\n\n:value[k]\n\n:::when[x < 0]\nImpossible branch :value[x+99]\n:::\n\n:::when[x > 5]\nLive branch :value[x]\n:::';

for (const surface of ['editor', 'reader'] as const) {
  test(`0.4.0 removes impossible conditions but keeps live hidden branches in ${surface}`, async ({ page }) => {
    if (surface === 'editor') {
      await page.goto('/editor.html');
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(source);
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-view-preview').click();
    } else {
      const encoded = await encodeSharePayload({ title: 'Prepared conditions', text: source, format: 'markdown', view: 'rendered', edit: false });
      if (!encoded.ok) throw new Error('Share encoding failed');
      await page.goto('/read.html#doc=' + encoded.payload);
    }
    const root = page.locator(surface === 'editor' ? '#rendered-document' : '#read-text');
    await expect(root.locator('.active-doc')).toBeVisible();
    // Prove removal, rather than merely hiding the impossible subtree/binding.
    await expect(root).not.toContainText('Impossible branch');
    await expect(root.locator('[data-active-when="x < 0"], [data-active-value="x+99"]')).toHaveCount(0);
    await expect(root.locator('output[data-active-value="k"]')).toHaveText('5');
    const live = root.locator('[data-active-when="x > 5"]');
    await expect(live).toBeHidden();
    await root.locator('input[data-active-input="x"]').fill('7');
    await expect(live).toBeVisible();
    await expect(live.locator('output')).toHaveText('7');
    await root.locator('input[data-active-input="x"]').fill('0');
    await expect(live).toBeHidden();
    await expect(root.locator('.active-error, .katex-error')).toHaveCount(0);
    if (surface === 'editor') {
      await page.locator('#document-view-edit').click();
      await expect(page.locator('#editor')).toHaveValue(source);
    }
  });
}
