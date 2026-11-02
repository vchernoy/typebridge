import { expect, test } from '@playwright/test';
import { documentAction, moreAction, setAutosave } from './settings-helpers';

for (const action of ['clear', 'delete', 'import', 'switch'] as const) {
  for (const keyboard of [false, true]) for (const accept of [false, true]) {
    test(`${action}: ${keyboard ? 'keyboard' : 'pointer'} ${accept ? 'confirm' : 'safe choice'} (#137 U2)`, async ({ page }) => {
      await page.goto('/');
      const editor = page.locator('#editor');
      await expect(editor).toBeEnabled();
      await editor.fill('Original text');
      await expect(page.locator('#save-indicator')).toHaveText('Saved');
      if (action === 'switch') {
        await setAutosave(page, false);
        await editor.fill('Unsaved text');
      }
      if (action === 'clear') await moreAction(page, '#clear');
      else if (action === 'delete') await documentAction(page, '#delete-draft');
      else if (action === 'import') await page.locator('#import-file').setInputFiles({
        name: 'incoming.txt', mimeType: 'text/plain', buffer: Buffer.from('Imported text'),
      });
      else await documentAction(page, '#new-draft');
      const title = { clear: 'Clear text?', delete: 'Delete document?', import: 'Import document?', switch: 'Discard unsaved changes?' }[action];
      const label = { clear: 'Clear text', delete: 'Delete document', import: 'Import document', switch: 'Discard changes' }[action];
      const safeLabel = { clear: 'Keep editing', delete: 'Keep document', import: 'Cancel import', switch: 'Keep editing' }[action];
      const dialog = page.getByRole('dialog', { name: title, exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.locator('main')).toHaveAttribute('inert');
      const safe = dialog.getByRole('button', { name: safeLabel, exact: true });
      await expect(safe).toBeFocused();
      if (keyboard) {
        // Shift+Tab wraps to the destructive/affirmative action; Tab wraps back.
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: label, exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(safe).toBeFocused();
        if (accept) { await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); }
        else await page.keyboard.press('Escape');
      } else await dialog.getByRole('button', { name: accept ? label : safeLabel, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator('main')).not.toHaveAttribute('inert');
      const before = action === 'switch' ? 'Unsaved text' : 'Original text';
      const after = action === 'import' ? 'Imported text' : '';
      await expect(editor).toHaveValue(accept ? after : before);
      if (!accept) await expect(page.locator(action === 'clear' ? '#more-open' : '#doc-menu-open')).toBeFocused();
      if (action === 'clear' && accept) {
        await expect(editor).toBeFocused();
        await editor.press('ControlOrMeta+z');
        await expect(editor).toHaveValue(before);
      }
    });
  }
}

for (const accept of [false, true]) {
  test(`emergency backup keyboard ${accept ? 'discard' : 'keep'} (#137 U2)`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#editor')).toBeEnabled();
    await page.evaluate(() => localStorage.setItem('typebridge.recovery.v1.closed.backup', JSON.stringify({
      token: 'backup', tab: 'closed', documentId: 'backup', revision: 0, timestamp: Date.now(), title: 'Backup', text: 'Unsaved backup',
    })));
    await page.reload();
    const discard = page.getByRole('button', { name: 'Discard backup for Backup', exact: true });
    const check = page.getByRole('button', { name: 'Check emergency backups' });
    await expect(check.or(discard)).toBeVisible();
    if (await check.isVisible()) await check.click();
    await discard.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Discard emergency backup?', exact: true });
    await expect(dialog.getByRole('button', { name: 'Keep backup', exact: true })).toBeFocused();
    if (accept) { await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); }
    else await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    if (accept) await expect(discard).toHaveCount(0);
    else await expect(discard).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('typebridge.recovery.v1.closed.backup') !== null)).toBe(!accept);
  });
}
