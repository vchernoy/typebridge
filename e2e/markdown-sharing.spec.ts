import { polishedMarkdown, assertPolishedMarkdown } from './markdown-polish-helpers';
import { expect, test } from '@playwright/test';
import { encodeSharePayload, decodeSharePayload, sharePayloadFromHash } from '../src/editor/share-link';
import { readStoredDocs } from './storage-helpers';

const markdown = '# Calculator\n\n```calc\ninput x = 2\ny = x * 3\n```\n\n:input[x] :value[y]\n\n$y={{y}}$';
async function link(text = markdown, view: 'source' | 'rendered' = 'rendered'): Promise<string> {
  const result = await encodeSharePayload({ title: 'Shared Markdown', text, format: 'markdown', view, edit: true });
  if (!result.ok) throw new Error('Could not make test link');
  return '/read.html#doc=' + result.payload;
}

test('Markdown link is live, has minimal chrome, remembers source and accepted inputs and copies its format', async ({ page }) => {
  await page.goto(await link());
  await expect(page.locator('#read-text .active-doc')).toBeVisible();
  await page.locator('#read-text input').fill('5');
  await expect(page.locator('#read-text output')).toHaveText('15');
  await expect(page.locator('#read-text math')).toContainText('15');
  await expect(page.locator('#read-view, .read-label')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toBeVisible();
  await expect(page.locator('#shared-memory-status')).toHaveText('Remembered in Shared with me on this device.');
  expect(await readStoredDocs(page)).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })))
    .toEqual({ local: 0, session: 0 });
  await expect(page.locator('#reader-input-status')).toHaveText('Inputs saved on this device.');
  await page.reload();
  await expect(page.locator('#read-text input')).toHaveValue('5');
  await page.locator('#edit-copy').click();
  await expect(page.locator('.host-status')).toHaveText('Saved as a new document in your Documents.');
  await expect.poll(async () => (await readStoredDocs(page, true)).some(row => row.format === 'markdown' && row.text === markdown)).toBe(true);
  const copy = (await readStoredDocs(page, true)).find(row => row.text === markdown)!;
  const editor = page.frameLocator(`iframe[src*="doc=${copy.id}"]`);
  await expect(editor.locator('#editor')).toHaveValue(markdown);
  await expect(editor.locator('#document-view')).toBeVisible();
});

test('source hint delivers source without a reading toolbar', async ({ page }) => {
  await page.goto(await link(markdown, 'source'));
  await expect(page.locator('#read-text')).toHaveText(markdown);
  await expect(page.locator('#read-view')).toHaveCount(0);
  await page.getByRole('link', { name: 'Edit', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.host-status')).toContainText('Saved as a new document');
});

for (const [name, payload] of [
  ['script', '<script>alert("executed");window.pwned=1</script>'],
  ['image handler', '<img src=x onerror="alert(1);window.pwned=1">'],
  ['javascript link', '[x](javascript:alert(1))'],
  ['remote image', '![](https://example.com/p.png)'],
  ['KaTeX link', '$\\href{javascript:alert(1)}{x}$'],
]) {
  test(`untrusted Markdown ${name} neither executes nor requests content`, async ({ page }) => {
    const requests: string[] = [];
    const dialogs: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1' || url.pathname === '/x') requests.push(request.url());
    });
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.goto(await link('Safe heading\n\n' + payload));
    await expect(page.locator('#read-text .active-doc')).toBeVisible();
    await expect(page.locator('#read-text script, #read-text img, #read-text [onerror], #read-text a[href^="javascript:"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(requests).toEqual([]);
  });
}

test('share dialog sends real format and selected reader view', async ({ page }) => {
  await page.goto('/editor.html');
  await page.locator('#editor').fill(markdown);
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#share-link').click();
  const dialog = page.getByRole('dialog', { name: 'Share link' });
  await expect(dialog).toBeVisible();
  const field = dialog.locator('#share-url');
  const decode = async () => decodeSharePayload(sharePayloadFromHash(new URL(await field.inputValue()).hash));
  await expect.poll(decode).toMatchObject({ ok: true, document: { text: markdown, format: 'markdown', view: 'rendered' } });
  await dialog.locator('#share-view').selectOption('source');
  await expect(dialog.locator('#share-copy')).toBeEnabled();
  await expect.poll(decode).toMatchObject({ ok: true, document: { format: 'markdown', view: 'source' } });
});

test("local Markdown links preserve the share payload and live reader state", async ({ page }) => {
  await page.goto(await link(markdown + "\n\n[Section](#section)\n\n## Section"));
  await expect(page.locator("#read-text output")).toHaveText("6");
  const url = page.url();
  await page.locator("#read-text input").fill("5");
  await page.getByRole("link", { name: "Section", exact: true }).click();
  expect(page.url()).toBe(url);
  await expect(page.locator("#read-text output")).toHaveText("15");
  await expect(page.locator("#read-title")).toHaveText("Shared Markdown");
  await page.reload();
  await expect(page.locator("#read-text output")).toHaveText("6");
});

test('rendering failure falls back to source without requiring a source control', async ({ page }) => {
  await page.route('**/assets/active-renderer-*.js', route => route.abort());
  await page.goto(await link());
  await expect(page.locator('#read-notice')).toHaveText('Could not render this document. Showing its text as written.');
  await expect(page.locator('#read-text')).toHaveText(markdown);
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toBeVisible();
});

test('rendered links with editing disabled offer only the attribution link outside the content', async ({ page }) => {
  const result = await encodeSharePayload({ title: 'Calculator', text: markdown, format: 'markdown', view: 'rendered', edit: false });
  if (!result.ok) throw new Error('Could not make test link');
  await page.goto('/read.html#doc=' + result.payload);
  await expect(page.locator('#read-text output')).toHaveText('6');
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toBeHidden();
  await expect(page.locator('.read-heading a:visible, .read-footer a:visible')).toHaveCount(1);
  await expect(page.locator('.read-footer')).toHaveText('Written with TypeBridge');
});

test('shared renderer keeps compact controls on one line and formatted math live', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(await link(polishedMarkdown));
  await expect(page.locator('#read-text .active-doc')).toBeVisible();
  await assertPolishedMarkdown(page.locator('#read-text'));
});

for (const [name, title, format, math] of [
  ['inline math', 'Energy $E=mc^2$', 'markdown', true],
  ['broken TeX', 'Broken $\\frac{$', 'markdown', false],
  ['plain document', 'Energy $E=mc^2$', 'plain', false],
  ['display fence', 'Energy $$E=mc^2$$', 'markdown', false],
  ['live binding', 'Energy $E={{energy}}$', 'markdown', false],
  ['escaped delimiter', 'Price \\$5', 'markdown', false],
] as const) {
  test(`shared title ${name} keeps tab title plain`, async ({ page }) => {
    const result = await encodeSharePayload({ title, text: 'Body', format, view: 'rendered', edit: true });
    if (!result.ok) throw new Error('Could not make test link');
    await page.goto('/read.html#doc=' + result.payload);
    await expect(page.locator('#read-text')).toHaveText('Body');
    if (format === 'markdown') await expect(page.locator('#read-text .active-doc')).toBeVisible();
    await expect(page).toHaveTitle(title + ' · TypeBridge');
    await expect(page.locator('#read-title math')).toHaveCount(math ? 1 : 0);
    await expect(page.locator('#read-title .katex-error, #read-title a, #read-title script')).toHaveCount(0);
    if (!math) await expect(page.locator('#read-title')).toHaveText(title);
    if (math) await page.screenshot({ path: `/tmp/312-title-${test.info().project.name}.png` });
  });
}

test('source body still typesets a static title without interpreting title HTML', async ({ page }) => {
  const title = '<img src=x onerror=alert(1)> $x^2$';
  const result = await encodeSharePayload({ title, text: '$body$', format: 'markdown', view: 'source', edit: false });
  if (!result.ok) throw new Error('Could not make test link');
  const unexpected: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/x') unexpected.push(request.url()); });
  await page.goto('/read.html#doc=' + result.payload);
  await expect(page.locator('#read-title math')).toHaveCount(1);
  await expect(page.locator('#read-title')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#read-title img')).toHaveCount(0);
  await expect(page.locator('#read-text')).toHaveText('$body$');
  await expect(page.locator('#read-text math')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
