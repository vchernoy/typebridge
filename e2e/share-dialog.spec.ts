import { expect, test, type Page } from '@playwright/test';
import { decodeSharePayload, sharePayloadFromHash } from '../src/editor/share-link';
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

async function decodeShown(page: Page) {
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
  const { decoded } = await decodeShown(page);
  expect(decoded.ok && decoded.document.edit).toBe(false);
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
