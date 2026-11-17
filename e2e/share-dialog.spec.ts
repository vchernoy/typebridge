import { expect, test, type Page } from '@playwright/test';
import { decodeSharePayload, SHARE_PAYLOAD_MAX_CHARS, sharePayloadFromHash } from '../src/editor/share-link';
import { documentAction } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

// Documents → Share link… (#39): explains sharing, previews, and makes a link the reading
// page opens.
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Share link', exact: true });
const linkField = (page: Page) => dialog(page).getByRole('textbox', { name: 'Link' });

test('collapsed reader options summarize defaults and leave phone Copy reachable (#351)', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await setText(page, 'Options fixture', '**Shared source**');
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#share-link').click();
  const sheet = dialog(page);
  const toggle = sheet.locator('#share-options-toggle');
  await expect(sheet.locator('#share-edit')).toBeHidden();
  await expect(sheet.locator('#share-heading')).toBeHidden();
  await expect(sheet.locator('#share-view')).toBeHidden();
  await expect(toggle).toContainText('Rendered page · Title shown · Edit a copy shown');
  const box = await toggle.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const copy = sheet.locator('#share-copy');
  const rect = await copy.boundingBox();
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(568);
  expect(await sheet.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
  const original = await decodeShown(page);
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(sheet.locator('#share-edit')).toBeVisible();
  await sheet.locator('#share-heading').uncheck();
  await sheet.locator('#share-view').selectOption('source');
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).toContainText('Source · Title hidden · Edit a copy shown');
  const changed = await decodeShown(page);
  expect(changed.decoded).toMatchObject({ ok: true, document: { heading: false, view: 'source', edit: true, text: '**Shared source**' } });
  expect(changed.url.hash).not.toBe(original.url.hash);
  await page.screenshot({ path: '/tmp/351-reader-options-collapsed.png', fullPage: true });
  await toggle.click();
  await expect(sheet.locator('#share-heading')).not.toBeChecked();
  await expect(sheet.locator('#share-view')).toHaveValue('source');
  await page.screenshot({ path: '/tmp/351-reader-options-expanded.png', fullPage: true });
  await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0);
  await expect(page.locator('#doc-menu-open')).toBeFocused();
});

test('preview disclosure loads on demand and cancellation cannot revive a collapsed preview (#351)', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 320, height: 568 } });
  try {
    const page = await context.newPage();
    const requests: string[] = [];
    let release: (() => Promise<void>) | undefined;
    let completed = false;
    await page.route('**/assets/active-renderer-*.js', async route => {
      requests.push(route.request().url());
      await new Promise<void>(resolve => { release = async () => { await route.continue(); resolve(); }; });
    });
    page.on('requestfinished', request => { if (/\/assets\/active-renderer-.*\.js/.test(request.url())) completed = true; });
    const source = '# Disclosure fixture\n\n```calc\ninput x = 2\n```\n\n:input[x] :value[x]';
    await setText(page, 'Disclosure', source);
    await page.locator('#doc-menu-open').click();
    await page.locator('#document-format').selectOption('markdown');
    await page.locator('#share-link').click();
    const sheet = dialog(page);
    const toggle = sheet.locator('#share-preview-toggle');
    await expect(sheet.locator('.share-preview')).toBeHidden();
    await expect(sheet.locator('#share-copy')).toBeEnabled();
    expect(requests).toEqual([]);
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: '/tmp/351-preview-collapsed.png', fullPage: true });
    await toggle.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => !!release).toBe(true);
    await page.keyboard.press('Space');
    await expect(sheet.locator('.share-preview-disclosure')).not.toHaveAttribute('open', '');
    await release!();
    await expect.poll(() => completed).toBe(true);
    await expect(sheet.locator('.active-doc')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(sheet.getByRole('heading', { name: 'Disclosure fixture' })).toBeVisible();
    const input = sheet.locator('[data-active-input="x"]');
    await input.fill('9');
    expect((await decodeShown(page)).decoded).toMatchObject({ ok: true, document: { text: source } });
    await toggle.click(); await expect(sheet.locator('.active-doc')).toHaveCount(0);
    await toggle.click(); await expect(input).toHaveValue('2');
    expect(requests).toHaveLength(1);
    await page.screenshot({ path: '/tmp/351-preview-expanded.png', fullPage: true });
    await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0);
    await expect(page.locator('#doc-menu-open')).toBeFocused();
  } finally { await context.close(); }
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

/** Decode the link shown once it is ready: while it regenerates the field is empty (#247 review). */
async function decodeShown(page: Page) {
  await expect(dialog(page).getByRole('button', { name: 'Copy link' })).toBeEnabled();
  await expect(linkField(page)).not.toHaveValue('');
  const url = new URL(await linkField(page).inputValue());
  return { url, decoded: await decodeSharePayload(sharePayloadFromHash(url.hash)) };
}

test('Share link explains sharing, previews and makes a link the reading page opens', async ({ page, context }) => {
  const text = 'Привет!\nЭто текст для ссылки 🙂';
  await setText(page, 'Письмо', text);
  await documentAction(page, '#share-link');
  await expect(dialog(page)).toContainText('Anyone with the link can read this document.');
  await expect(dialog(page)).toContainText('nothing is uploaded');
  await expect(dialog(page)).toContainText('browser history');
  await expect(dialog(page).getByLabel('What the reader sees')).toContainText('Письмо');
  await expect(dialog(page).getByLabel('What the reader sees')).toContainText('Это текст для ссылки');
  const { url, decoded } = await decodeShown(page);
  expect(url.pathname).toBe('/');
  expect(decoded).toEqual({ ok: true, knownFormat: true, document: { title: 'Письмо', text, format: 'plain', view: 'source', edit: true } });
  // The link opens on the reading page, in another tab.
  const reader = await context.newPage();
  await reader.goto(url.pathname + url.hash);
  await expect(reader.locator('#read-title')).toHaveText('Письмо');
  await expect(reader.locator('#read-text')).toHaveText(text, { useInnerText: false });
  await expect(reader.getByRole('link', { name: 'Edit', exact: true })).toBeVisible();
  // Close returns to the document menu button.
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('#doc-menu-open')).toBeFocused();
});

test('the sender can turn off Edit a copy for readers', async ({ page }) => {
  await setText(page, 'Только чтение', 'Текст');
  await documentAction(page, '#share-link');
  const before = await linkField(page).inputValue();
  await dialog(page).locator('#share-options-toggle').click();
  await dialog(page).getByLabel('Readers can edit a copy').uncheck();
  await expect(dialog(page).locator('.share-option-values')).toContainText('Edit a copy hidden');
  await expect(linkField(page)).not.toHaveValue(before);
  await expect(linkField(page)).not.toHaveValue('');
  const { decoded } = await decodeShown(page);
  expect(decoded.ok && decoded.document.edit).toBe(false);
});

test('a too-large regeneration cannot copy the previous link and a later toggle recovers (#242)', async ({ page }) => {
  // Exercise the encoded-size failure without relying on browser-specific compression ratios.
  await page.addInitScript(maxChars => {
    const Native = CompressionStream;
    const w = window as unknown as { oversizeNextCompress?: boolean; CompressionStream: unknown };
    w.CompressionStream = class extends Native {
      constructor(format: CompressionFormat) {
        super(format);
        if (!w.oversizeNextCompress) return;
        w.oversizeNextCompress = false;
        const readable = this.readable.pipeThrough(new TransformStream({
          transform() { /* Consume native output; replace just this result with oversized bytes. */ },
          flush(controller) { controller.enqueue(new Uint8Array(maxChars)); },
        }));
        Object.defineProperty(this, 'readable', { value: readable });
      }
    };
  }, SHARE_PAYLOAD_MAX_CHARS);
  await setText(page, 'Граница', 'Текст');
  await documentAction(page, '#share-link');
  const { decoded: initial } = await decodeShown(page);
  expect(initial.ok && initial.document.edit).toBe(true);
  await dialog(page).locator('#share-options-toggle').click();
  const checkbox = dialog(page).getByLabel('Readers can edit a copy');
  await page.evaluate(() => { (window as unknown as { oversizeNextCompress: boolean }).oversizeNextCompress = true; });
  await checkbox.uncheck();
  await expect(dialog(page).locator('.share-status')).toContainText('too large to share as a link');
  await expect(linkField(page)).toHaveValue('');
  await expect(linkField(page)).toHaveAttribute('placeholder', '');
  await expect(dialog(page).getByRole('button', { name: 'Copy link' })).toBeDisabled();
  await checkbox.check();
  const { decoded } = await decodeShown(page);
  expect(decoded.ok && decoded.document.edit).toBe(true);
  await expect(dialog(page).locator('.share-status')).not.toContainText('too large');
});

test('Copy link copies or explains, and every control is reachable with Tab', async ({ page }) => {
  await setText(page, 'Копия', 'Текст');
  await documentAction(page, '#share-link');
  await dialog(page).getByRole('button', { name: 'Copy link' }).click();
  await expect(dialog(page).locator('.share-status')).toHaveText(/^(Link copied\.|Copy unavailable\. The link is selected; use your device’s copy command\.)$/);
  // Focus starts on Close; Tab cycles through the controls and wraps.
  await dialog(page).getByRole('button', { name: 'Close' }).focus();
  const order: string[] = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent || ''));
  }
  expect(order).toEqual(['share-url', 'share-copy', 'share-options-toggle', 'share-preview-toggle', 'confirm-dialog-close']);
  await dialog(page).locator('#share-options-toggle').focus();
  await page.keyboard.press('Enter');
  await dialog(page).getByRole('button', { name: 'Close' }).focus();
  const expanded: string[] = [];
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('Tab');
    expanded.push(await page.evaluate(() => document.activeElement?.id || ''));
  }
  expect(expanded).toEqual(['share-url', 'share-copy', 'share-options-toggle', 'share-edit', 'share-heading', 'share-preview-toggle', 'confirm-dialog-close']);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});

test('a long link is flagged and a too-large document is refused', async ({ page }) => {
  // Varied text compresses poorly, so the link grows past the messenger-friendly length.
  let varied = '';
  let seed = 7;
  for (let i = 0; i < 3000; i++) { seed = (seed * 48271) % 2147483647; varied += String.fromCharCode(0x0410 + (seed % 64)); }
  await setText(page, 'Длинный', varied);
  await documentAction(page, '#share-link');
  await expect(dialog(page).locator('.share-status')).toContainText('This link is long.');
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  let huge = '';
  for (let i = 0; i < 60_000; i++) { seed = (seed * 48271) % 2147483647; huge += String.fromCharCode(0x4e00 + (seed % 20000)); }
  await setText(page, 'Огромный', huge);
  await documentAction(page, '#share-link');
  await expect(dialog(page)).toContainText('too large to share as a link');
  await expect(linkField(page)).toHaveCount(0);
});

test('a slow regenerate never leaves a link that disagrees with the checkbox (#247 review)', async ({ page }) => {
  // Hold the next compression (the first regenerate) so a later toggle finishes first.
  await page.addInitScript(() => {
    const Native = CompressionStream;
    const w = window as unknown as { holdNextCompress?: boolean; heldCompressDone?: boolean; CompressionStream: unknown };
    w.CompressionStream = class extends Native {
      constructor(format: CompressionFormat) {
        super(format);
        if (!w.holdNextCompress) return;
        w.holdNextCompress = false;
        const readable = this.readable.pipeThrough(new TransformStream({
          async transform(chunk, controller) { await new Promise(resolve => setTimeout(resolve, 800)); controller.enqueue(chunk); },
          flush() { w.heldCompressDone = true; },
        }));
        Object.defineProperty(this, 'readable', { value: readable });
      }
    };
  });
  await setText(page, 'Гонка', 'Текст');
  await documentAction(page, '#share-link');
  await dialog(page).locator('#share-options-toggle').click();
  const checkbox = dialog(page).getByLabel('Readers can edit a copy');
  await page.evaluate(() => { (window as unknown as { holdNextCompress: boolean }).holdNextCompress = true; });
  await checkbox.uncheck(); // edit: false, held
  await dialog(page).locator('#share-options-toggle').click();
  await expect(checkbox).toBeHidden();
  await expect(dialog(page).locator('.share-option-values')).toContainText('Edit a copy hidden');
  await expect(dialog(page).getByRole('button', { name: 'Copy link' })).toBeDisabled();
  // No stale link stays in the field to copy by hand meanwhile.
  await expect(linkField(page)).toHaveValue('');
  await expect(linkField(page)).toHaveAttribute('placeholder', 'Updating link…');
  await dialog(page).locator('#share-options-toggle').click();
  await checkbox.check(); // edit: true, finishes first
  await expect.poll(() => page.evaluate(() => (window as unknown as { heldCompressDone?: boolean }).heldCompressDone)).toBe(true);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await expect(dialog(page).getByRole('button', { name: 'Copy link' })).toBeEnabled();
  const { decoded } = await decodeShown(page);
  expect(decoded.ok && decoded.document.edit).toBe(true);
  await expect(checkbox).toBeChecked();
});

for (const viewport of [{ width: 390, height: 640 }, { width: 320, height: 480 }]) {
  test(`mobile share link stays reachable before a multiline preview at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const text = '```calc\n' + Array.from({ length: 60 }, (_, i) => `v${i} = ${i}\n`).join('') + '```';
    await setText(page, 'Compound interest', text);
    await page.locator('#doc-menu-open').click();
    await page.locator('#document-format').selectOption('markdown');
    await page.locator('#share-link').click();
    await expect(dialog(page)).toBeVisible();
    const link = linkField(page);
    const copy = dialog(page).getByRole('button', { name: 'Copy link' });
    await expect(copy).toBeEnabled();
    // The primary action must be above the secondary preview, not buried after it.
    await dialog(page).locator('#share-preview-toggle').click();
    const rowBox = await dialog(page).locator('.share-link-row').boundingBox();
    const previewBox = await dialog(page).locator('.share-preview').boundingBox();
    expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(previewBox!.y);
    const bounds = await dialog(page).evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.width + 1);
    await copy.scrollIntoViewIfNeeded();
    const box = await copy.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    const value = await link.inputValue();
    const decoded = await decodeSharePayload(sharePayloadFromHash(new URL(value).hash));
    expect(decoded).toMatchObject({ ok: true, document: { text, format: 'markdown', view: 'rendered' } });
    await copy.click();
    await expect(dialog(page).locator('.share-status')).toHaveText(/^(Link copied\.|Copy unavailable\. The link is selected; use your device’s copy command\.)$/);
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('#doc-menu-open')).toBeFocused();
  });
}

test('mobile host window can reach and copy the generated link', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto('/');
  const editor = page.frameLocator('.host-window iframe').first();
  await editor.locator('#editor').fill(('line\n').repeat(80));
  await editor.locator('#doc-menu-open').click();
  await editor.locator('#document-format').selectOption('markdown');
  await editor.locator('#share-link').click();
  const sheet = editor.getByRole('dialog', { name: 'Share link' });
  const copy = sheet.getByRole('button', { name: 'Copy link' });
  await expect(copy).toBeEnabled();
  await expect(sheet.locator('#share-url')).not.toHaveValue('');
  await copy.scrollIntoViewIfNeeded();
  const fits = await copy.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const message = element.closest('.confirm-dialog-message')!.getBoundingClientRect();
    return rect.top >= message.top && rect.bottom <= message.bottom && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  expect(fits).toBe(true);
  await copy.click();
  await expect(sheet.locator('.share-status')).toHaveText(/^(Link copied\.|Copy unavailable\. The link is selected; use your device’s copy command\.)$/);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(editor.locator('#doc-menu-open')).toBeFocused();
});


test('Markdown share preview follows the reader view and header X closes with focus restored', async ({ page }) => {
  const text = '# Preview heading\n\n**Formatted preview**\n\n[Jump](#preview-heading)\n\n```calc\ninput x = 2\n```\n\nInput: :input[x] Result: :value[x]';
  await setText(page, 'Preview', text);
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#share-link').click();
  const sheet = dialog(page);
  await sheet.locator('#share-preview-toggle').click();
  const rendered = sheet.getByLabel('Rendered document preview');
  await expect(rendered.getByRole('heading', { name: 'Preview heading' })).toBeVisible();
  await expect(rendered.locator('strong').filter({ hasText: 'Formatted preview' })).toBeVisible();
  await expect(rendered.locator('[data-active-value="x"]')).toHaveText('2');
  const editorUrl = page.url();
  await rendered.getByRole('link', { name: 'Jump' }).click();
  expect(page.url()).toBe(editorUrl);
  expect((await decodeShown(page)).decoded).toMatchObject({ ok: true, document: { text, view: 'rendered' } });
  await sheet.locator('#share-options-toggle').click();
  await sheet.getByLabel('Readers see:').selectOption('source');
  await expect(sheet.getByLabel('Document source preview')).toContainText('**Formatted preview**');
  await expect(sheet.locator('.active-doc')).toHaveCount(0);
  expect((await decodeShown(page)).decoded).toMatchObject({ ok: true, document: { text, view: 'source' } });
  await sheet.getByLabel('Readers see:').selectOption('rendered');
  await expect(rendered.getByRole('heading', { name: 'Preview heading' })).toBeVisible();
  const close = sheet.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toHaveText('×');
  const closeBox = await close.boundingBox();
  const titleBox = await sheet.getByRole('heading', { name: 'Share link', exact: true }).boundingBox();
  expect(closeBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width);
  expect(Math.abs(closeBox!.y - titleBox!.y)).toBeLessThan(5);
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(rendered.locator('input').last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('#doc-menu-open')).toBeFocused();
});

test('a failed rendered preview shows source while leaving the generated reader link intact', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.route('**/assets/active-renderer-*.js', route => route.abort());
  await setText(page, 'Fallback', '**Source remains available**');
  await page.locator('#doc-menu-open').click();
  await page.locator('#document-format').selectOption('markdown');
  await page.locator('#share-link').click();
  await dialog(page).locator('#share-preview-toggle').click();
  await expect(dialog(page).getByLabel('Document source preview')).toContainText('Rendered preview unavailable. Source: **Source remains available**');
  expect((await decodeShown(page)).decoded).toMatchObject({ ok: true, document: { view: 'rendered' } });
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('#doc-menu-open')).toBeFocused();
  await context.close();
});

for (const format of ['plain', 'markdown'] as const) {
  test(`optional page title matches preview and preserves copy name (${format}, #312)`, async ({ page, context }) => {
    const title = 'Письмо $x^2$';
    const text = '# Own heading\n\nBody stays intact.';
    await setText(page, title, text);
    await expect(page.locator('#status')).toContainText('Saved locally');
    if (format === 'markdown') {
      await page.locator('#doc-menu-open').click();
      await page.locator('#document-format').selectOption('markdown');
      await page.locator('#share-link').click();
    } else {
      await documentAction(page, '#share-link');
    }
    await dialog(page).locator('#share-options-toggle').click();
    const checkbox = dialog(page).getByRole('checkbox', { name: 'Show title on the page', exact: true });
    await expect(checkbox).toBeChecked();
    await dialog(page).locator('#share-preview-toggle').click();
    const previewTitle = dialog(page).locator('.share-preview > strong');
    await expect(previewTitle).toBeVisible();
    const before = await readStoredDocs(page);
    const original = await decodeShown(page);
    expect(original.decoded.ok && original.decoded.document.heading).toBeUndefined();
    await checkbox.uncheck();
    await expect(dialog(page).locator('.share-option-values')).toContainText('Title hidden');
    await expect(previewTitle).toBeHidden();
    const hidden = await decodeShown(page);
    expect(hidden.decoded.ok && hidden.decoded.document.heading).toBe(false);
    const reader = await context.newPage();
    await reader.goto(hidden.url.pathname + hidden.url.hash);
    const heading = reader.locator('#read-title');
    await expect(heading).toHaveText(title);
    await expect(heading).toHaveClass(/visually-hidden/);
    await expect(reader.getByRole('heading', { name: title, exact: true })).toHaveCount(1);
    expect(await heading.evaluate(el => ({ width: el.getBoundingClientRect().width, clip: getComputedStyle(el).clip })))
      .toEqual({ width: 1, clip: 'rect(0px, 0px, 0px, 0px)' });
    await expect(reader).toHaveTitle(`${title} · TypeBridge`);
    await expect(reader.locator('#read-text')).toContainText('Own heading');
    if (format === 'markdown') {
      await dialog(page).locator('#share-view').selectOption('source');
      await expect(previewTitle).toBeHidden();
      const source = await decodeShown(page);
      expect(source.decoded).toMatchObject({ ok: true, document: { heading: false, view: 'source' } });
    }
    await checkbox.check();
    await expect(previewTitle).toBeVisible();
    const restored = await decodeShown(page);
    expect(restored.decoded.ok && restored.decoded.document.heading).toBeUndefined();
    await reader.goto(restored.url.pathname + restored.url.hash);
    await expect(heading).not.toHaveClass(/visually-hidden/);
    await reader.goto(hidden.url.pathname + hidden.url.hash);
    await expect(heading).toHaveClass(/visually-hidden/);
    await reader.evaluate(() => { location.hash = '#doc=9.abc'; });
    await expect(heading).toHaveText('This shared document cannot be opened');
    await expect(heading).not.toHaveClass(/visually-hidden/);
    await reader.goto(hidden.url.pathname + hidden.url.hash);
    await reader.getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(reader.locator('.host-status')).toHaveText('Saved as a new document in your Documents.');
    const after = await readStoredDocs(reader, true);
    const added = after.filter(row => !before.some(old => old.id === row.id));
    expect(added).toHaveLength(1);
    const copy = added[0];
    expect(copy?.text).toBe(text);
    expect(copy?.title).toBe(title);
    expect(copy?.format ?? 'plain').toBe(format);
    expect(copy).toBeDefined();
  });
}
