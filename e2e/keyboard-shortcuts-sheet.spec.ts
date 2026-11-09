import { expect, test } from '@playwright/test';
import { moreAction, setSetting } from './settings-helpers';

for (const apple of [false, true]) {
  test(`shortcuts sheet uses current choice and platform labels; Apple=${apple} (#137 U7)`, async ({ page }) => {
    await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { get: () => value }), apple ? 'MacIntel' : 'Linux x86_64');
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await moreAction(page, '#keyboard-shortcuts');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
    const list = dialog.locator('dl.shortcut-list');
    await expect(list.locator('dt', { hasText: 'Toggle typing mode' })).toBeVisible();
    await expect(list.locator('dd', { hasText: 'Ctrl+Shift+Space' }).first()).toBeVisible();
    await expect(list.locator('dt', { hasText: /^Find$/ })).toBeVisible();
    await expect(list.locator('dd', { hasText: `${apple ? '⌘' : 'Ctrl'}+F` }).first()).toBeVisible();
    await expect(list.locator('dt', { hasText: 'Resize grip' })).toBeVisible();
    await expect(dialog).toContainText('Some systems reserve Ctrl+Shift+Space');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#more-open')).toBeFocused();
    await moreAction(page, '#keyboard-shortcuts');
    await dialog.getByRole('button', { name: 'Change typing shortcut', exact: true }).click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    await expect(page.locator('#translit-shortcut')).toBeFocused();
    await page.locator('#translit-shortcut').selectOption('f8');
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-panel')).toBeHidden();
    await expect(page.locator('#more-open')).toBeFocused();
    await moreAction(page, '#keyboard-shortcuts');
    await expect(dialog.locator('dl.shortcut-list dd').first()).toHaveText(`${apple ? '⌘' : 'Ctrl'}+Shift+F8`);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await setSetting(page, '#tab-indent', false);
    await moreAction(page, '#keyboard-shortcuts');
    await expect(dialog.locator('dl.shortcut-list dd', { hasText: 'Tab indents is off' })).toBeVisible();
  });
}

test('shortcuts sheet keeps the first lines visible on a short viewport (#137 U7)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await moreAction(page, '#keyboard-shortcuts');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Keyboard shortcuts', exact: true })).toBeInViewport();
  await expect(dialog.locator('dl.shortcut-list dt', { hasText: 'Toggle typing mode' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Change typing shortcut', exact: true })).toBeInViewport();
});
