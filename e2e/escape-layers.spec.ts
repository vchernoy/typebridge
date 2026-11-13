import { expect, test } from '@playwright/test';

test('Escape closes Settings after focus moves to the editor instead of toggling Focus (#132)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#settings-open').click();
  await field.focus();
  await field.press('Escape');
  await expect(page.locator('#settings-panel')).toBeHidden();
  await expect(page.locator('#settings-open')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('Escape closes Find from the editor and only then toggles Focus (#132)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#find-open').click();
  await field.focus();
  await field.press('Escape');
  await expect(page.locator('#find-bar')).toBeHidden();
  await expect(page.locator('#find-open')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
  await field.press('Escape');
  await expect(page.locator('body')).toHaveClass(/focus-mode/);
  await field.press('Escape');
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('Settings, menu and Find close one layer at a time in plan order (#132)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#find-open').click();
  await page.locator('#settings-open').click();
  await page.locator('#more-open').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-panel')).toBeHidden();
  await expect(page.locator('#more-menu')).toBeVisible();
  await expect(page.locator('#find-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#more-menu')).toBeHidden();
  await expect(page.locator('#more-open')).toBeFocused();
  await expect(page.locator('#find-bar')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#find-bar')).toBeHidden();
  await expect(page.locator('#editor')).toBeFocused();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('confirm dialog consumes Escape before Settings; next Escape closes Settings (#132)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Текст для сохранения');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  // Open a confirm from More while Settings is open; Escape dismisses confirm first.
  await page.locator('#more-open').click();
  await page.locator('#clear').click();
  await expect(page.locator('.confirm-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.confirm-dialog')).toHaveCount(0);
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-panel')).toBeHidden();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});

test('composition, repeat, handled events and native selects keep Escape (#132)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#settings-open').click();
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) {
    const prevented = await field.evaluate((el, init) => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, options);
    expect(prevented).toBe(false);
    await expect(page.locator('#settings-panel')).toBeVisible();
  }
  const selectPrevented = await page.locator('#translit-shortcut').evaluate(el => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(selectPrevented).toBe(false);
  await expect(page.locator('#settings-panel')).toBeVisible();
  await field.evaluate(el => el.addEventListener('keydown', event => event.preventDefault(), { once: true }));
  await field.press('Escape');
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
});
