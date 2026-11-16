import { test, expect } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

const source = '```calc\ninput x = 2 in 1..10\n```\n\n:input[x]\n\n:::tip[**Live title** ${{x}}$]\nBody\n:::\n\n:::details[Details ${{x}}$]\nBody\n:::';

for (const surface of ['editor', 'reader'] as const) {
  test(`0.5.0 title math and accessible input validation stay live in ${surface}`, async ({ page }) => {
    if (surface === 'editor') {
      await page.goto('/editor.html');
      await expect(page.locator('#editor')).toBeEnabled();
      await page.locator('#editor').fill(source);
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-view-preview').click();
    } else {
      const encoded = await encodeSharePayload({ title: 'Live title math', text: source, format: 'markdown', view: 'rendered', edit: false });
      if (!encoded.ok) throw new Error('Share encoding failed');
      await page.goto('/read.html#doc=' + encoded.payload);
    }
    const root = page.locator(surface === 'editor' ? '#rendered-document' : '#read-text');
    const input = root.locator('input[data-active-input="x"]');
    await expect(input).toHaveValue('2');
    await expect(root.locator('.callout-title strong')).toHaveText('Live title');
    await expect(root.locator('.callout-title math mn')).toHaveText('2');
    await expect(root.locator('summary math mn')).toHaveText('2');
    await input.fill('5');
    await expect(root.locator('.callout-title math mn')).toHaveText('5');
    await expect(root.locator('summary math mn')).toHaveText('5');
    await input.fill('0');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const description = await input.getAttribute('aria-describedby');
    expect(description).toBeTruthy();
    await expect(root.locator(`[id="${description}"]`)).toBeVisible();
    await expect(root.locator(`[id="${description}"]`)).toContainText('Results use the last accepted value.');
    await expect(root.locator('.callout-title math mn')).toHaveText('5');
    await input.fill('7');
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect(root.locator(`[id="${description}"]`)).toBeEmpty();
    await expect(root.locator('.callout-title math mn')).toHaveText('7');
    await expect(root.locator('summary math mn')).toHaveText('7');
    await expect(root.locator('.active-error, .katex-error')).toHaveCount(0);
    if (surface === 'editor') {
      await page.locator('#document-view-edit').click();
      await expect(page.locator('#editor')).toHaveValue(source);
    }
  });
}
