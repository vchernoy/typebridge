import { expect, test } from '@playwright/test';
import { encodeSharePayload, decodeSharePayload, sharePayloadFromHash } from '../src/editor/share-link';
import { readStoredDocs } from './storage-helpers';

const markdown = '# Calculator\n\n```calc\ninput x = 2\ny = x * 3\n```\n\n:input[x] :value[y]\n\n$y={{y}}$';
async function link(text = markdown, view: 'source' | 'rendered' = 'rendered'): Promise<string> {
  const result = await encodeSharePayload({ title: 'Shared Markdown', text, format: 'markdown', view, edit: true });
  if (!result.ok) throw new Error('Could not make test link');
  return '/read.html#doc=' + result.payload;
}

test('Markdown link is live, toggles source, stores nothing and copies its format', async ({ page }) => {
  await page.goto(await link());
  await expect(page.locator('#read-text .active-doc')).toBeVisible();
  await page.locator('#read-text input').fill('5');
  await expect(page.locator('#read-text output')).toHaveText('15');
  await expect(page.locator('#read-text math')).toContainText('15');
  await page.locator('#read-view').click();
  await expect(page.locator('#read-text')).toHaveText(markdown);
  await page.locator('#read-view').click();
  await expect(page.locator('#read-text input')).toHaveValue('2');
  expect(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, db: await indexedDB.databases() })))
    .toEqual({ local: 0, session: 0, db: [] });
  await page.reload();
  await expect(page.locator('#read-text input')).toHaveValue('2');
  await page.locator('#edit-copy').click();
  await expect(page.locator('.host-status')).toHaveText('Saved as a new document in your Documents.');
  await expect.poll(async () => (await readStoredDocs(page, true)).some(row => row.format === 'markdown' && row.text === markdown)).toBe(true);
  const copy = (await readStoredDocs(page, true)).find(row => row.text === markdown)!;
  const editor = page.frameLocator(`iframe[src*="doc=${copy.id}"]`);
  await expect(editor.locator('#editor')).toHaveValue(markdown);
  await expect(editor.locator('#document-view')).toBeVisible();
});

test('source hint shows source first and can show its page', async ({ page }) => {
  await page.goto(await link(markdown, 'source'));
  await expect(page.locator('#read-text')).toHaveText(markdown);
  await expect(page.locator('#read-view')).toHaveText('Show page');
  await page.locator('#read-view').click();
  await expect(page.locator('#read-text output')).toHaveText('6');
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
