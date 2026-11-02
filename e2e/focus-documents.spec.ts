import { expect, test, type Page } from '@playwright/test';
import { documentAction, setAutosave } from './settings-helpers';

async function twoDocuments(page: Page): Promise<string> {
  await page.goto('/');
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
  test(`Focus document picker shares the header and switches at ${width}px (#104)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const first = await twoDocuments(page);
    const picker = page.getByRole('combobox', { name: 'Documents', exact: true });
    await expect(picker).toBeHidden();
    await page.locator('#focus-mode').click();
    await expect(picker).toBeVisible();
    const rows = await Promise.all(['.focus-heading', '#focus-documents', '#exit-focus'].map(async id => {
      const box = (await page.locator(id).boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.width).toBeGreaterThan(0);
      return box.y + box.height / 2;
    }));
    expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(2);
    await picker.focus();
    await picker.press('Escape');
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await picker.press('Tab');
    await expect(page.locator('#exit-focus')).toBeFocused();
    await picker.selectOption(first);
    await expect(page.locator('#editor')).toHaveValue('Первый текст');
    await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await expect(page.locator('#drafts')).toHaveValue(first);
    await expect(picker).toHaveValue(first);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.locator('#editor').fill('Правка перед переключением');
    const second = await picker.locator('option').evaluateAll((options, id) =>
      (options as HTMLOptionElement[]).find(option => option.value !== id)!.value, first);
    await picker.selectOption(second);
    await expect(page.locator('#editor')).toHaveValue('Второй текст');
    await picker.selectOption(first);
    await expect(page.locator('#editor')).toHaveValue('Правка перед переключением');
  });
}

test('canceling a Focus document switch keeps unsaved text and restores both pickers (#104)', async ({ page }) => {
  const first = await twoDocuments(page);
  await setAutosave(page, false);
  const second = await page.locator('#drafts').inputValue();
  await page.locator('#focus-mode').click();
  await page.locator('#editor').fill('Не сохранено');
  const dialog = page.waitForEvent('dialog');
  const switching = page.locator('#focus-documents').selectOption(first);
  await (await dialog).dismiss();
  await switching;
  await expect(page.locator('#focus-documents')).toHaveValue(second);
  await expect(page.locator('#drafts')).toHaveValue(second);
  await expect(page.locator('#editor')).toHaveValue('Не сохранено');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
});
