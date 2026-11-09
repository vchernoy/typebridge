import { expect, test } from '@playwright/test';
import { closeDocuments, documentAction, openDocuments, selectDocument } from './settings-helpers';

test('documents are called documents throughout the page (#108)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Untitled document');
  await openDocuments(page);
  const menu = page.getByRole('dialog', { name: 'Documents' });
  await expect(menu.getByRole('listbox', { name: 'Documents' })).toBeVisible();
  await expect(menu.getByRole('searchbox', { name: 'Search documents' })).toBeVisible();
  await expect(page.locator('#drafts option')).toHaveText([/Untitled document \(current\)/]);
  for (const name of ['New document', 'Delete…', 'Import…']) {
    await expect(menu.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await closeDocuments(page);
  await page.getByRole('button', { name: 'About your documents', exact: true }).click();
  await expect(page.locator('#settings-about-documents')).toContainText('Saved documents stay in this browser only');
  await page.locator('#settings-close').click();
  // A title the user typed, including the old default wording, is kept as is.
  await page.getByRole('textbox', { name: 'Document title' }).fill('Untitled draft');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Untitled draft');
});

test('the ▾ document menu opens the list and actions, and closes cleanly (#123)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первый');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Первый');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const toggle = page.getByRole('button', { name: 'Documents', exact: true });
  const menu = page.getByRole('dialog', { name: 'Documents' });
  // The big header is gone; the page heading is the small TypeBridge name in the top bar.
  await expect(page.getByRole('heading', { level: 1, name: 'TypeBridge' })).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(menu).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('searchbox', { name: 'Search documents' })).toBeFocused();
  // Escape closes it, returns focus to ▾ and does not enter Focus mode.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  // An action closes it and gives keyboard focus back to ▾.
  await toggle.click();
  await menu.getByRole('button', { name: 'Export as TXT' }).focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();
  await toggle.click();
  await menu.getByRole('button', { name: 'New document' }).click();
  await expect(menu).toBeHidden();
  await expect(field).toHaveValue('');
  // Picking a document with the pointer opens it and closes the menu; a click outside closes it too.
  await selectDocument(page, { label: 'Первый' });
  await expect(field).toHaveValue('Первый');
  await expect(menu).toBeHidden();
  await toggle.click();
  // The menu may cover the middle of the editor; click its lower-left corner (outside the menu).
  const editorBox = await field.boundingBox();
  if (!editorBox) throw new Error('Editor not found');
  await field.click({ position: { x: 12, y: editorBox.height - 12 } });
  await expect(menu).toBeHidden();
});

test('arrow keys move through documents without closing the menu (#123)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Один');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await documentAction(page, '#new-draft');
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Untitled document 2');
  await field.fill('Два');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await openDocuments(page);
  await page.getByRole('searchbox', { name: 'Search documents' }).fill('Один');
  await expect(page.locator('#drafts option')).toHaveCount(1);
  await page.locator('#drafts').press('ArrowDown');
  await expect(field).toHaveValue('Один');
  await expect(page.getByRole('dialog', { name: 'Documents' })).toBeVisible();
});

test('host title bar renames the document in place (#175 step 8)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  await page.goto('/');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const hostTitle = page.locator('.host-window[data-window-id="main"] .host-window-title');
  await expect(hostTitle).toHaveValue('Untitled document');
  await expect(hostTitle).toBeEditable({ timeout: 15_000 });
  await hostTitle.fill('Host renamed');
  await expect.poll(async () => frame.locator('#draft-title').inputValue()).toBe('Host renamed');
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveAttribute('aria-label', 'Host renamed');
  // Multi-word titles keep spaces; empty blur falls back to Untitled document.
  await hostTitle.fill('My notes');
  await expect(hostTitle).toHaveValue('My notes');
  await expect.poll(async () => frame.locator('#draft-title').inputValue()).toBe('My notes');
  await hostTitle.fill('');
  await hostTitle.blur();
  await expect(hostTitle).toHaveValue('Untitled document');
  // Host title keystrokes go through the iframe transliteration Editor (default Кириллица on).
  await expect(hostTitle).toBeEditable();
  await hostTitle.fill('');
  await hostTitle.pressSequentially('privet');
  await expect(hostTitle).toHaveValue('привет');
  await expect.poll(async () => frame.locator('#draft-title').inputValue()).toBe('привет');
  await hostTitle.press('Control+z');
  await expect(hostTitle).not.toHaveValue('привет');
});
