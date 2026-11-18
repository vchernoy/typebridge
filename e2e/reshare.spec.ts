import { expect, test } from '@playwright/test';
import { encodeSharePayload, decodeSharePayload, sharePayloadFromHash } from '../src/editor/share-link';
const text = '```calc\ninput x = 2 in 0..10\ninput seed = 3\ny = x + seed\n```\n\n:input[x] :value[y]\n\n$y={{y}}$';
async function original() {
  const made = await encodeSharePayload({ title: 'Numeric answers', text, format: 'markdown', view: 'rendered', edit: false, heading: false, inputs: { version: 1, values: [['x', 7], ['seed', 3]] } }, { inputSnapshots: true });
  if (!made.ok) throw new Error('Fixture refused');
  return '/read.html#doc=' + made.payload;
}
for (const privateMode of [false, true]) test(`recipient re-shares accepted values without Edit or persistence requirement: private=${privateMode}`, async ({ page, browser }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  if (privateMode) await page.addInitScript(() => localStorage.setItem('typebridge.autosave.v1', 'off'));
  const url = await original(); await page.goto(url);
  const input = page.locator('#read-text input');
  await expect(input).toHaveValue('7'); await expect(page.locator('#read-text output')).toHaveText('10');
  await expect(page.locator('#edit-copy')).toBeHidden();
  await input.fill('9'); await expect(page.locator('#read-text output')).toHaveText('12');
  await page.locator('#read-share').focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Share link', exact: true });
  const field = dialog.locator('#share-url');
  const decode = async () => { const value = await field.inputValue(); return value ? decodeSharePayload(sharePayloadFromHash(new URL(value).hash), { inputSnapshots: true }) : undefined; };
  await expect(dialog.getByLabel('Include current parameters')).not.toBeChecked();
  await dialog.locator('#share-options-toggle').click();
  await expect(dialog.getByLabel('Readers can edit a copy')).not.toBeChecked();
  await expect(dialog.getByLabel('Readers can edit a copy')).toBeDisabled();
  await dialog.locator('#share-options-toggle').click();
  expect((await decode())).toMatchObject({ ok: true, document: { edit: false, heading: false, text } });
  await dialog.getByLabel('Include current parameters').check();
  await expect.poll(decode).toMatchObject({ ok: true, document: { inputs: { version: 1, values: [['x', 9], ['seed', 3]] }, edit: false, heading: false, text } });
  const shared = await field.inputValue();
  await page.keyboard.press('Escape'); await expect(page.locator('#read-share')).toBeFocused();
  expect(new URL(page.url()).pathname + new URL(page.url()).hash).toBe(url);
  await input.fill('4');
  const context = await browser.newContext();
  try {
    const recipient = await context.newPage(); await recipient.goto(shared);
    await expect(recipient.locator('#read-text input')).toHaveValue('9');
    await expect(recipient.locator('#read-text output')).toHaveText('12');
    await expect(recipient.locator('#read-text math')).toContainText('12');
    await expect(recipient.locator('#edit-copy')).toBeHidden();
    await recipient.locator('#read-text input').fill('6');
    await expect(recipient.locator('#reader-input-status')).toHaveText('Inputs saved on this device.');
    await recipient.reload(); await expect(recipient.locator('#read-text input')).toHaveValue('6');
    await recipient.locator('#reader-input-reset').click(); await expect(recipient.locator('#read-text input')).toHaveValue('2');
    await expect(recipient.locator('#reader-input-status')).toHaveText('Inputs saved on this device.');
    await recipient.reload(); await expect(recipient.locator('#read-text input')).toHaveValue('2');
  } finally { await context.close(); }
  if (privateMode) expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
});

test('invalid control text is excluded and unchecked sharing retains legacy authored defaults', async ({ page, browser }) => {
  await page.goto(await original()); const input = page.locator('#read-text input');
  await expect(input).toHaveValue('7'); await input.fill('');
  await page.locator('#read-share').click();
  const dialog = page.getByRole('dialog', { name: 'Share link', exact: true });
  await dialog.getByLabel('Include current parameters').check();
  await expect(dialog.locator('#share-copy')).toBeEnabled();
  const captured = await decodeSharePayload(sharePayloadFromHash(new URL(await dialog.locator('#share-url').inputValue()).hash), { inputSnapshots: true });
  expect(captured).toMatchObject({ ok: true, document: { inputs: { values: [['x', 7], ['seed', 3]] } } });
  await dialog.getByLabel('Include current parameters').uncheck();
  await expect(dialog.locator('#share-copy')).toBeEnabled();
  const url = await dialog.locator('#share-url').inputValue(); expect(new URL(url).hash).toMatch(/^#doc=1\./);
  const context = await browser.newContext(); try {
    const recipient = await context.newPage(); await recipient.goto(url);
    await expect(recipient.locator('#read-text input')).toHaveValue('2');
  } finally { await context.close(); }
});

test('phone re-share keeps captured parameters through preview edits and clipboard refusal', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Denied'); } } }));
  await page.goto(await original()); await expect(page.locator('#read-text input')).toHaveValue('7');
  const share = page.locator('#read-share'); const box = await share.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
  await share.click(); const dialog = page.getByRole('dialog', { name: 'Share link', exact: true });
  await dialog.getByLabel('Include current parameters').check();
  await expect(dialog.locator('#share-copy')).toBeEnabled();
  const url = await dialog.locator('#share-url').inputValue();
  await page.screenshot({ path: '/tmp/372-reshare-320.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await dialog.locator('#share-preview-toggle').click();
  await expect(dialog.locator('[data-active-input="x"]')).toHaveValue('7');
  await dialog.locator('[data-active-input="x"]').fill('3');
  expect(await dialog.locator('#share-url').inputValue()).toBe(url);
  await dialog.locator('#share-copy').click();
  await expect(dialog.locator('.share-status')).toContainText('Copy unavailable');
  await expect(dialog.locator('#share-url')).toBeFocused();
  expect(await dialog.locator('#share-url').evaluate((node: HTMLInputElement) => node.selectionEnd! - node.selectionStart!)).toBe(url.length);
  await page.keyboard.press('Escape'); await expect(share).toBeFocused();
  await expect(page.locator('#read-text input')).toHaveValue('7');
});

test('different incoming parameter snapshots stay distinct under one library group', async ({ page }) => {
  const first = await original(); await page.goto(first); await expect(page.locator('#read-text input')).toHaveValue('7');
  await page.locator('#read-text input').fill('9'); await page.locator('#read-share').click();
  const dialog = page.getByRole('dialog', { name: 'Share link', exact: true });
  await dialog.getByLabel('Include current parameters').check(); await expect(dialog.locator('#share-copy')).toBeEnabled();
  const next = await dialog.locator('#share-url').inputValue();
  await page.keyboard.press('Escape'); await page.goto(next);
  await expect(page.locator('#read-text input')).toHaveValue('9');
  await expect(page.locator('#shared-memory-status')).toContainText('Remembered');
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#doc-menu-open').click(); await page.locator('#shared-library > summary').click();
  const group = page.locator('.shared-group'); await expect(group.locator(':scope > summary')).toContainText('2 received links');
  await group.locator(':scope > summary').click();
  expect((await group.locator('a').evaluateAll(nodes => nodes.map(n => n.getAttribute('href')))).sort()).toEqual([first, '/read.html' + new URL(next).hash].sort());
  await page.locator('#shared-search').fill('x = 9'); await expect(group.locator('a')).toHaveCount(1);
  await expect(group.locator('a')).toHaveAttribute('href', '/read.html' + new URL(next).hash);
});


test('received Edit permission can be retained or narrowed, never enabled from a disabled link', async ({ page }) => {
  const made = await encodeSharePayload({ title: 'Editable hint', text: 'Plain source', format: 'plain', view: 'source', edit: true });
  if (!made.ok) throw new Error('Fixture refused');
  await page.goto('/read.html#doc=' + made.payload); await page.locator('#read-share').click();
  const dialog = page.getByRole('dialog', { name: 'Share link', exact: true });
  await dialog.locator('#share-options-toggle').click();
  const edit = dialog.getByLabel('Readers can edit a copy'); await expect(edit).toBeChecked(); await expect(edit).toBeEnabled();
  await edit.uncheck(); await expect(dialog.locator('#share-copy')).toBeEnabled();
  const next = await dialog.locator('#share-url').inputValue();
  expect(await decodeSharePayload(sharePayloadFromHash(new URL(next).hash))).toMatchObject({ ok: true, document: { edit: false } });
  await page.keyboard.press('Escape'); await page.goto(next); await expect(page.locator('#edit-copy')).toBeHidden();
  await page.locator('#read-share').click(); await dialog.locator('#share-options-toggle').click();
  await expect(dialog.getByLabel('Readers can edit a copy')).toBeDisabled(); await expect(dialog.getByLabel('Readers can edit a copy')).not.toBeChecked();
});

test('navigation during asynchronous Share opening cannot install an old document dialog', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = CompressionStream;
    const w = window as unknown as { holdShare?: boolean; releaseShare?: () => void; shareFinished?: boolean };
    window.CompressionStream = class extends Native {
      constructor(format: CompressionFormat) {
        super(format); if (!w.holdShare) return; w.holdShare = false; let held = false;
        const readable = this.readable.pipeThrough(new TransformStream({
          async transform(chunk, controller) { if (!held) { held = true; await new Promise<void>(resolve => { w.releaseShare = resolve; }); } controller.enqueue(chunk); },
          flush() { w.shareFinished = true; },
        }));
        Object.defineProperty(this, 'readable', { value: readable });
      }
    };
  });
  await page.goto(await original()); await expect(page.locator('#read-text input')).toHaveValue('7');
  await page.evaluate(() => { (window as unknown as { holdShare: boolean }).holdShare = true; });
  await page.locator('#read-share').click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseShare?: unknown }).releaseShare)).toBe('function');
  await page.evaluate(() => { location.hash = '#doc=9.invalid'; });
  await expect(page.locator('#read-title')).toHaveText('This shared document cannot be opened');
  await page.evaluate(() => (window as unknown as { releaseShare: () => void }).releaseShare());
  await expect.poll(() => page.evaluate(() => (window as unknown as { shareFinished?: boolean }).shareFinished)).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Share link', exact: true })).toHaveCount(0);
  await expect(page.locator('#read-share')).toBeHidden();
});
