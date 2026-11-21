import { test, expect } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

// ActiveMD 0.6.2 gives headings ids and makes footnote ids match their links (active-md#106).
const text = '[Jump to Later](#later) and a note[^1].\n\n' + 'Filler paragraph.\n\n'.repeat(40) +
  '## Later\n\nThe end.\n\n' + 'More filler.\n\n'.repeat(40) + '[^1]: The footnote.';

for (const page of ['read', 'embed'] as const) {
  test(`heading and footnote links scroll on the ${page} page and keep the shared document`, async ({ page: browser }) => {
    await browser.setViewportSize({ width: 600, height: 400 });
    const encoded = await encodeSharePayload({ title: 'Anchors', text, format: 'markdown', view: 'rendered', edit: false });
    if (!encoded.ok) throw new Error('Share encoding failed');
    await browser.goto(`/${page}.html#doc=${encoded.payload}`);
    const root = browser.locator(page === 'read' ? '#read-text' : '#embed-content');
    const hash = new URL(browser.url()).hash;
    await root.getByRole('link', { name: 'Jump to Later' }).click();
    await expect(root.getByRole('heading', { name: 'Later' })).toBeInViewport();
    await root.locator('sup a').first().click();
    await expect(root.getByText('The footnote.')).toBeInViewport();
    expect(new URL(browser.url()).hash).toBe(hash);
    await expect(root).not.toContainText('cannot be opened');
  });
}
