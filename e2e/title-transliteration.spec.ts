import { expect, test } from '@playwright/test';

test('the draft title transliterates, saves and keeps its own undo (#89)', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('#editor');
  const title = page.locator('#draft-title');
  await expect(editor).toBeEnabled();
  await editor.fill('Текст');
  await title.fill('');
  await title.pressSequentially('privet');
  await expect(title).toHaveValue('привет');
  await expect(page.locator('#status')).toHaveText('Saved locally');
  await title.press('ControlOrMeta+z');
  await expect(editor).toHaveValue('Текст');
  await page.reload();
  await expect(page.locator('#draft-title')).toHaveValue(/^прив/);
});

test('the transliteration shortcut works from every text box (#89)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  const enabled = page.locator('#enabled');
  for (const id of ['#editor', '#find-text', '#replace-text', '#draft-title']) {
    const before = await enabled.isChecked();
    await page.locator(id).press('ControlOrMeta+Shift+Space');
    await expect(enabled).toBeChecked({ checked: !before });
    await expect(page.locator('#mode-announcement')).toHaveText(before ? 'Transliteration off' : 'Transliteration on');
  }
  // With transliteration off, the title keeps Latin text.
  await expect(enabled).toBeChecked();
  await page.locator('#draft-title').press('ControlOrMeta+Shift+Space');
  await page.locator('#draft-title').fill('');
  await page.locator('#draft-title').pressSequentially('privet');
  await expect(page.locator('#draft-title')).toHaveValue('privet');
});
