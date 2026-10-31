import { expect, test } from '@playwright/test';

test('shortcut toggles global mode, can be remapped, disabled and persists', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.focus();
  await page.keyboard.press('Control+Shift+Space');
  await expect(page.locator('#enabled')).not.toBeChecked();
  await page.locator('.shortcut-panel summary').click();
  await page.locator('#translit-shortcut').selectOption('f7');
  await page.reload();
  await page.locator('.shortcut-panel summary').click();
  await expect(page.locator('#translit-shortcut')).toHaveValue('f7');
  await page.locator('#find-text').focus();
  await page.keyboard.press('Control+Shift+F7');
  await expect(page.locator('#enabled')).toBeChecked();
  await page.locator('#translit-shortcut').selectOption('off');
  await field.focus();
  await page.keyboard.press('Control+Shift+F7');
  await expect(page.locator('#enabled')).toBeChecked();
  await page.locator('#shortcut-reset').click();
  await expect(page.locator('#translit-shortcut')).toHaveValue('default');
});

test('shortcut is not intercepted during composition', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const result = await page.locator('#editor').evaluate(el => {
    const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, isComposing: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(result).toBe(false);
  await expect(page.locator('#enabled')).toBeChecked();
});

test('mode announcement and active shortcut remain visible with settings closed', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('.shortcut-panel')).not.toHaveAttribute('open');
  await expect(page.locator('#shortcut-label')).toContainText('Ctrl+Shift+Space');
  await page.locator('#editor').focus();
  await page.keyboard.press('Control+Shift+Space');
  await expect(page.locator('#mode-announcement')).toBeVisible();
  await expect(page.locator('#mode-announcement')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#mode-announcement')).toHaveText('Transliteration off');
  await page.locator('.shortcut-panel summary').click();
  await page.locator('#translit-shortcut').selectOption('f7');
  await expect(page.locator('#shortcut-label')).toContainText('Ctrl+Shift+F7');
  await page.locator('#translit-shortcut').selectOption('off');
  await expect(page.locator('#shortcut-label')).toContainText('Shortcut disabled');
});

test('macOS Control shortcut works while unrelated fields are ignored', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' }));
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#shortcut-label')).toContainText('Ctrl+Shift+Space');
  // The mappings box holds Latin rule text, so the shortcut must not apply there.
  const unrelated = page.locator('#rules-text');
  const blocked = await unrelated.evaluate(el => {
    const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(blocked).toBe(false);
  await expect(page.locator('#enabled')).toBeChecked();
  const handled = await page.locator('#find-text').evaluate(el => {
    const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(handled).toBe(true);
  await expect(page.locator('#enabled')).not.toBeChecked();
  await expect(page.locator('#mode-announcement')).toHaveText('Transliteration off');
});

test('Focus Mode keeps transliteration feedback visible and hides settings', async ({ page }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('.shortcut-panel')).toBeHidden();
  await expect(page.locator('.rules-panel')).toBeHidden();
  await expect(page.locator('#find-text')).toBeHidden();
  await page.keyboard.press('Control+Shift+Space');
  const announcement = page.locator('#mode-announcement');
  await expect(announcement).toBeVisible();
  await expect(announcement).toHaveAttribute('aria-live', 'polite');
  await expect(announcement).toHaveText('Transliteration off');
  await editor.pressSequentially('privet');
  await expect(editor).toHaveValue('privet');
  await page.keyboard.press('Control+Shift+Space');
  await expect(announcement).toHaveText('Transliteration on');
  await editor.pressSequentially(' mir');
  await expect(editor).toHaveValue('privet мир');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(page.locator('.shortcut-panel')).toBeVisible();
});

test('Escape in the editor enters and exits Focus mode (#67)', async ({ page }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Привет');
  await editor.press('Escape');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('#exit-focus')).toBeVisible();
  await expect(editor).toBeFocused();
  await editor.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('Привет');
});

test('Escape keeps its cancel role outside the editor and during composition (#67)', async ({ page }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await page.locator('#find-text').press('Escape');
  await page.locator('#draft-title').press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await editor.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true })));
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await editor.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true })));
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('Escape with no control focused toggles Focus mode (#67)', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('#editor')).toBeFocused();
});

test('Escape guards also apply while Focus mode is active (#67)', async ({ page }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.press('Escape');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  const escape = (init: { isComposing?: boolean; repeat?: boolean }) => editor.evaluate((el, options) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...options })), init);
  await escape({ isComposing: true });
  await escape({ repeat: true });
  // A descendant handler that already handled Escape keeps Focus mode on.
  await editor.evaluate(el => el.addEventListener('keydown', event => event.preventDefault(), { once: true }));
  await escape({});
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await editor.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('Cmd/Ctrl+Shift+Enter toggles Focus mode without inserting text or searching', async ({ page }) => {
  await page.goto('/typebridge/');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Привет');
  await editor.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await editor.press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await expect(editor).toHaveValue('Привет');
  await page.locator('#find-text').fill('zzz');
  await page.locator('#find-text').press('ControlOrMeta+Shift+Enter');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await expect(page.locator('#find-status')).toHaveText('');
  // The old shortcut no longer switches modes.
  await editor.press('ControlOrMeta+Shift+E');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
});
