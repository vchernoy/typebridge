import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload, type SharedDocument } from '../src/editor/share-link';
import { documentAction } from './settings-helpers';

const link = async (doc: SharedDocument): Promise<string> => {
  const encoded = await encodeSharePayload(doc);
  if (!encoded.ok) throw new Error(encoded.reason);
  return '/embed.html#doc=' + encoded.payload;
};
const markdown = (text: string, view: SharedDocument['view'] = 'rendered'): SharedDocument =>
  ({ title: 'Interactive example', text, format: 'markdown', view, edit: false });

test('embedded Markdown renders calculations and responds to input', async ({ page }) => {
  await page.goto(await link(markdown('```calc\ninput x = 3 in 1..10\ny = x * 2\n```\n\n:edit[Amount]{input=x} Result: :value[y]')));
  await expect(page.locator('#embed-title')).toHaveText('Interactive example');
  const output = page.locator('#embed-content output');
  await expect(output).toHaveText('6');
  await page.getByRole('spinbutton', { name: 'Amount' }).fill('5');
  await expect(output).toHaveText('10');
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
  await page.goto('/embed.html#doc=1.@@@');
  await expect(page.locator('#embed-content')).toHaveText('This shared document cannot be opened.');
  await page.goto('/embed.html#doc=9.abc');
  await expect(page.locator('#embed-content')).toContainText('newer version of TypeBridge');
});

test('local anchors scroll inside the embed without losing the shared document', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 400 });
  const url = await link(markdown('See the note[^1] and [a heading](#nowhere).\n\n' + 'Filler paragraph.\n\n'.repeat(40) + '[^1]: The footnote.'));
  await page.goto(url);
  const hash = new URL(page.url()).hash;
  await page.getByRole('link', { name: 'a heading' }).click();
  await page.locator('#embed-content sup a[href^="#user-content-fn"]').click();
  await expect(page.getByText('The footnote.')).toBeInViewport();
  expect(new URL(page.url()).hash).toBe(hash);
  await expect(page.locator('#embed-content')).not.toContainText('cannot be opened');
});

test('Markdown shared as source stays source in the embed', async ({ page }) => {
  await page.goto(await link(markdown('**Bold** and [a link](#x)', 'source')));
  await expect(page.locator('#embed-content')).toHaveText('**Bold** and [a link](#x)');
  await expect(page.locator('#embed-content a, #embed-content strong')).toHaveCount(0);
});

test('external links open outside the frame', async ({ page }) => {
  await page.goto(await link(markdown('[Docs](https://example.com/docs)')));
  const anchor = page.getByRole('link', { name: 'Docs' });
  // The window listener runs after the embed's own handler, so the test checks it without navigating.
  await page.evaluate(() => window.addEventListener('click', event => event.preventDefault()));
  await anchor.click();
  await expect(anchor).toHaveAttribute('target', '_blank');
  await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
});

test('Share offers embed code that opens the same payload on the embed page', async ({ page }) => {
  await setText(page, 'Embed fixture', '**Embedded**');
  await documentAction(page, '#share-link');
  const sheet = page.getByRole('dialog', { name: 'Share link', exact: true });
  const shareLink = sheet.getByRole('textbox', { name: 'Link' });
  await expect(shareLink).not.toHaveValue('');
  await sheet.locator('#share-embed-toggle').click();
  await expect(sheet.getByRole('button', { name: 'Copy embed code' })).toBeEnabled();
  const code = await sheet.getByRole('textbox', { name: 'Embed code' }).inputValue();
  const src = /src="([^"]+)"/.exec(code)?.[1]?.replaceAll('&amp;', '&');
  expect(src).toBeDefined();
  const shared = new URL(await shareLink.inputValue());
  const embed = new URL(src!);
  expect(embed.pathname).toBe('/embed.html');
  expect(embed.hash).toBe(shared.hash);
  expect(code).toContain('referrerpolicy="no-referrer"');
  await page.goto(src!);
  await expect(page.locator('#embed-content')).toContainText('Embedded');
});

async function setText(page: Page, title: string, text: string): Promise<void> {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#draft-title').fill(title);
  await field.evaluate((el, value) => {
    const area = el as HTMLTextAreaElement;
    area.value = value;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
}
