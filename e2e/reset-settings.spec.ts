import { expect, test, type Page } from '@playwright/test';
import { openSettings } from './settings-helpers';

async function configured(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.evaluate(() => {
    const values = {
      'typebridge.transliteration.enabled.v1': 'off', 'typebridge.transliteration.shortcut.v1': 'f8',
      'typebridge.editor.tabIndent.v1': 'off', 'typebridge.find.matchCase.v1': 'true',
      'typebridge.find.regex.v1': 'true', 'typebridge.autosave.v1': 'off',
      'typebridge-rules-v1': JSON.stringify({ a: 'я' }),
      'typebridge.editor.size.v1': JSON.stringify({ width: '480px', height: '320px' }),
      'typebridge.editor.focusSize.v1': JSON.stringify({ width: '600px', height: '500px' }),
      'typebridge.focusMode.v1': 'on',
    };
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  });
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#exit-focus')).toBeVisible();
  await page.locator('#exit-focus').click();
  await page.locator('#editor').fill('Unsaved private text');
  await page.locator('#draft-title').fill('Private title');
  await openSettings(page);
}

test('confirmed reset keeps private text, title, Undo and Autosave (#137 U11)', async ({ page }) => {
  await configured(page);
  await page.locator('#reset-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Reset settings to defaults?', exact: true });
  await expect(dialog).toContainText('custom rules');
  await expect(dialog.getByRole('button', { name: 'Keep settings', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#enabled')).toBeChecked();
  await expect(page.locator('#translit-shortcut')).toHaveValue('default');
  await expect(page.locator('#tab-indent')).toBeChecked();
  await expect(page.locator('#regex-mode')).not.toBeChecked();
  await expect(page.locator('#match-case')).not.toBeChecked();
  await expect(page.locator('#autosave')).not.toBeChecked();
  await expect(page.locator('#editor')).toHaveValue('Unsaved private text');
  await expect(page.locator('#draft-title')).toHaveValue('Private title');
  await expect(page.locator('#undo')).toBeEnabled();
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');
  const preferences = await page.evaluate(() => ({
    rules: localStorage.getItem('typebridge-rules-v1'),
    normal: localStorage.getItem('typebridge.editor.size.v1'),
    focus: localStorage.getItem('typebridge.editor.focusSize.v1'),
    focusMode: localStorage.getItem('typebridge.focusMode.v1'),
  }));
  expect(preferences).toEqual({ rules: '{}', normal: null, focus: null, focusMode: null });
  await expect(page.locator('#status')).toContainText('Settings reset to defaults');
});

test('Escape cancels reset without changing preferences (#137 U11)', async ({ page }) => {
  await configured(page);
  await page.locator('#reset-settings').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#reset-settings')).toBeFocused();
  await expect(page.locator('#enabled')).not.toBeChecked();
  await expect(page.locator('#translit-shortcut')).toHaveValue('f8');
  await expect(page.locator('#tab-indent')).not.toBeChecked();
  await expect(page.locator('#editor')).toHaveValue('Unsaved private text');
});

test('partial reset failure is reported without deleting text (#137 U11)', async ({ page }) => {
  await configured(page);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'typebridge-rules-v1') throw new DOMException('Storage unavailable', 'QuotaExceededError');
      set.call(this, key, value);
    };
  });
  await page.locator('#reset-settings').click();
  await page.getByRole('dialog', { name: 'Reset settings to defaults?', exact: true }).getByRole('button', { name: 'Reset settings', exact: true }).click();
  await expect(page.locator('#status')).toContainText('Reset incomplete — could not save custom rules');
  await expect(page.locator('#editor')).toHaveValue('Unsaved private text');
  await expect(page.locator('#autosave')).not.toBeChecked();
});
