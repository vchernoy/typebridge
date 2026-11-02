import { expect, test } from '@playwright/test';
import { moreAction, setSetting } from './settings-helpers';

for (const apple of [false, true]) {
  test(`shortcuts sheet uses current choice and platform labels; Apple=${apple} (#137 U7)`, async ({ page }) => {
    await page.addInitScript(value => Object.defineProperty(navigator, 'platform', { get: () => value }), apple ? 'MacIntel' : 'Linux x86_64');
    await page.goto('/');
    await expect(page.locator('#editor')).toBeEnabled();
    await moreAction(page, '#keyboard-shortcuts');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
    await expect(dialog).toContainText('Toggle typing mode: Ctrl+Shift+Space');
    await expect(dialog).toContainText(`Find: ${apple ? '⌘' : 'Ctrl'}+F`);
    await expect(dialog).toContainText('Resize grip: arrow keys');
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
    await expect(dialog).toContainText(`Toggle typing mode: ${apple ? '⌘' : 'Ctrl'}+Shift+F8`);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await setSetting(page, '#tab-indent', false);
    await moreAction(page, '#keyboard-shortcuts');
    await expect(dialog).toContainText('Tab indents is off');
  });
}
