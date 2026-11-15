import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { answerNextConfirmation, documentAction, selectDocument } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

test('TXT download preserves UTF-8 bytes and imports as a separate durable document', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  const content = 'Русский текст 🙂\n\nLatin and combining e\u0301\nПоследняя строка 🌍\n';
  await field.fill(content);
  await page.locator('#draft-title').fill('Original');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const original = (await readStoredDocs(page))[0];
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    documentAction(page, '#export-txt'),
  ]);
  expect(download.suggestedFilename()).toBe('Original.txt');
  const bytes = await readFile(await download.path());
  expect(bytes.equals(Buffer.from(content, 'utf8'))).toBe(true);
  const confirmation = answerNextConfirmation(page, true);
  await page.locator('#import-file').setInputFiles({ name: 'Imported.txt', mimeType: 'text/plain', buffer: bytes });
  await confirmation;
  await expect(page.locator('#status')).toContainText('Imported as a new document');
  await expect(field).toHaveValue(content);
  await expect(page.locator('#draft-title')).toHaveValue('Imported');
  await expect(page.locator('#drafts option')).toHaveCount(2);
  const stored = await readStoredDocs(page);
  expect(stored.find(doc => doc.id === original.id)).toMatchObject({ title: 'Original', text: content });
  const imported = stored.find(doc => doc.id !== original.id);
  expect(imported).toMatchObject({ title: 'Imported', text: content });
  await page.reload();
  await expect(field).toHaveValue(content);
  await expect(page.locator('#draft-title')).toHaveValue('Imported');
  await selectDocument(page, { label: 'Original' });
  await expect(field).toHaveValue(content);
  expect((await readStoredDocs(page)).map(doc => doc.id).sort()).toEqual([original.id, imported!.id].sort());
});
