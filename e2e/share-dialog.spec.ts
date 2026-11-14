import { expect, test, type Page } from '@playwright/test';
import { decodeSharePayload, SHARE_PAYLOAD_MAX_CHARS, sharePayloadFromHash } from '../src/editor/share-link';
import { documentAction } from './settings-helpers';

// Documents → Share link… (#39): explains sharing, previews, and makes a link the reading
// page opens.
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Share link', exact: true });
const linkField = (page: Page) => dialog(page).getByRole('textbox', { name: 'Link' });

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
  await expect(reader.getByRole('button', { name: 'Edit a copy' })).toBeVisible();
  // Close returns to the document menu button.
  await dialog(page).getByRole('button', { name: 'Close' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('#doc-menu-open')).toBeFocused();
});

test('the sender can turn off Edit a copy for readers', async ({ page }) => {
  await setText(page, 'Только чтение', 'Текст');
  await documentAction(page, '#share-link');
  const before = await linkField(page).inputValue();
  await dialog(page).getByLabel('Readers can edit a copy').uncheck();
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
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent || ''));
  }
  expect(order).toEqual(['share-edit', 'share-url', 'share-copy', 'Close']);
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
  const checkbox = dialog(page).getByLabel('Readers can edit a copy');
  await page.evaluate(() => { (window as unknown as { holdNextCompress: boolean }).holdNextCompress = true; });
  await checkbox.uncheck(); // edit: false, held
  await expect(dialog(page).getByRole('button', { name: 'Copy link' })).toBeDisabled();
  // No stale link stays in the field to copy by hand meanwhile.
  await expect(linkField(page)).toHaveValue('');
  await expect(linkField(page)).toHaveAttribute('placeholder', 'Updating link…');
  await checkbox.check(); // edit: true, finishes first
  await expect.poll(() => page.evaluate(() => (window as unknown as { heldCompressDone?: boolean }).heldCompressDone)).toBe(true);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  await expect(dialog(page).getByRole('button', { name: 'Copy link' })).toBeEnabled();
  const { decoded } = await decodeShown(page);
  expect(decoded.ok && decoded.document.edit).toBe(true);
  await expect(checkbox).toBeChecked();
});
