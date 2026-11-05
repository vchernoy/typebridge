import { expect, test, type Page } from '@playwright/test';
import { documentAction, selectDocument, setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

async function openSplit(page: Page): Promise<void> {
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'on');
}

async function saveNamed(page: Page, text: string, title: string): Promise<string> {
  await page.locator('#editor').fill(text);
  await page.locator('#draft-title').fill(title);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const docs = await readStoredDocs(page);
  const row = docs.find(d => d.title === title);
  if (!row) throw new Error('missing saved doc');
  return row.id;
}

test('pane B can open a different document with independent edits and Undo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Document A body', 'Doc A');
  await documentAction(page, '#new-draft');
  const secondId = await saveNamed(page, 'Document B body', 'Doc B');
  expect(firstId).not.toBe(secondId);

  await openSplit(page);
  await expect(page.locator('#companion-badge')).toBeVisible();
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await expect(page.locator('#companion-badge')).toBeHidden();
  await expect(page.locator('#draft-title-b')).toBeVisible();
  await expect(page.locator('#draft-title-b')).toHaveValue('Doc A');
  await expect(page.locator('#editor-b')).toHaveValue('Document A body');
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', false);
  await expect(page.locator('#editor')).toHaveValue('Document B body');

  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially('!');
  await expect(page.locator('#editor-b')).toHaveValue('Document A body!');
  await expect(page.locator('#editor')).toHaveValue('Document B body');
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');

  await page.locator('#undo').click();
  await expect(page.locator('#editor-b')).toHaveValue('Document A body');
  await expect(page.locator('#editor')).toHaveValue('Document B body');

  await page.locator('#pane-b-drafts').selectOption(secondId);
  await expect(page.locator('#companion-badge')).toBeVisible();
  await expect(page.locator('#editor-b')).toHaveValue('Document B body');
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', true);
});

test('split restore after reload does not crash when split was open', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('persist split open');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('persist split open');
});

test('primary switching to the companion document promotes pane B edits', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  const firstId = await saveNamed(page, 'Alpha original', 'Alpha');
  await documentAction(page, '#new-draft');
  const secondId = await saveNamed(page, 'Beta original', 'Beta');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' edited');
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');
  await selectDocument(page, firstId);
  await expect(page.locator('#editor')).toHaveValue('Alpha original edited');
  await expect(page.locator('#companion-badge')).toBeVisible();
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', true);
  expect(secondId).toBeTruthy();
});
