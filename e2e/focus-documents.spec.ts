import { answerNextConfirmation } from './settings-helpers';
import { expect, test, type Page } from '@playwright/test';
import { documentAction, openDocuments, selectDocument, setAutosave } from './settings-helpers';

async function twoDocuments(page: Page): Promise<string> {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Первый текст');
  await page.locator('#draft-title').fill('Длинное название документа '.repeat(8));
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const first = await page.locator('#drafts').inputValue();
  await documentAction(page, '#new-draft');
  await expect(page.locator('#editor')).toHaveValue('');
  await page.locator('#editor').fill('Второй текст');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  return first;
}

for (const width of [390, 1280]) {
  test(`Focus mode keeps the document title bar: rename, switch and create at ${width}px (#104)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const first = await twoDocuments(page);
    await page.locator('#focus-mode').click();
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    const title = page.getByRole('textbox', { name: 'Document title' });
    const menu = page.getByRole('button', { name: 'Documents', exact: true });
    // The same controls as Normal mode, with Exit focus; the rest of the top bar is hidden.
    for (const control of [title, menu, page.locator('#save-indicator'), page.locator('#enabled'), page.locator('#exit-focus')]) {
      await expect(control).toBeVisible();
      const box = (await control.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    for (const id of ['.brand', '#focus-mode', '#settings-open']) await expect(page.locator(id)).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    // One line above the editor on wide screens: title, ▾, Autosave, the save icon, the switch and Exit.
    const oneRow = async () => {
      if (width < 1000) return;
      const rows = await Promise.all(['#draft-title', '#doc-menu-open', '#autosave', '#save-indicator', '#enabled', '#exit-focus'].map(async id => {
        const box = (await page.locator(id).boundingBox())!;
        return box.y + box.height / 2;
      }));
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(4);
    };
    await oneRow();
    // Rename in place.
    await title.fill('Новое имя');
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    await expect(page.locator('#drafts option', { hasText: 'Новое имя' })).toHaveCount(1);
    // Switch documents from the ▾ menu, staying in Focus mode.
    await selectDocument(page, first);
    await expect(page.locator('#editor')).toHaveValue('Первый текст');
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    // The long title ellipsizes; it never pushes ▾ or Autosave onto another line.
    await expect(title).toHaveValue(/^Длинное название/);
    await oneRow();
    // Escape inside the menu closes it but keeps Focus mode.
    await openDocuments(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#doc-menu')).toBeHidden();
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    // Create a new document from the menu.
    await documentAction(page, '#new-draft');
    await expect(page.locator('#editor')).toHaveValue('');
    await expect(title).toHaveValue(/Untitled document( \d+)?/);
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await expect(page.locator('#drafts option')).toHaveCount(3);
  });
}

test('canceling a document switch in Focus mode keeps unsaved text (#104)', async ({ page }) => {
  const first = await twoDocuments(page);
  await setAutosave(page, false);
  const second = await page.locator('#drafts').inputValue();
  await page.locator('#focus-mode').click();
  await page.locator('#editor').fill('Не сохранено');
  const dialog = answerNextConfirmation(page, false);
  const switching = selectDocument(page, first);
  await dialog;
  await switching;
  await expect(page.locator('#drafts')).toHaveValue(second);
  await expect(page.locator('#editor')).toHaveValue('Не сохранено');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
});
