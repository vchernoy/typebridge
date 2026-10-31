import { expect, test } from '@playwright/test';

const KEY = 'typebridge.transliteration.shortcut.v1';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' }));
});

for (const saved of [null, 'default', 'invalid']) {
  test(`macOS default uses Control, preserves content and leaves Command+Space alone; stored=${saved}`, async ({ page }) => {
    await page.addInitScript(({ key, value }) => {
      if (value !== null) localStorage.setItem(key, value);
    }, { key: KEY, value: saved });
    await page.goto('/typebridge/');
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    await field.fill('Привет 🙂');
    await expect(page.locator('#status')).toContainText('Saved locally');
    await expect(page.locator('#shortcut-label')).toHaveText('(Ctrl+Shift+Space)');
    await expect(page.locator('#enabled')).toHaveAttribute('title', 'Ctrl+Shift+Space');
    await expect(page.locator('#translit-shortcut option[value="default"]')).toHaveText('Default (Ctrl + Shift + Space)');
    const intercepted = await field.evaluate(el => {
      const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(intercepted).toBe(false);
    await expect(page.locator('#enabled')).toBeChecked();
    await field.press('Control+Shift+Space');
    await expect(page.locator('#enabled')).not.toBeChecked();
    await expect(field).toHaveValue('Привет 🙂');
    await expect(page.locator('#mode-announcement')).toHaveText('Transliteration off');
    await page.reload();
    await expect(field).toHaveValue('Привет 🙂');
    await expect(page.locator('#shortcut-label')).toHaveText('(Ctrl+Shift+Space)');
    await page.locator('#draft-title').press('Control+Shift+Space');
    await expect(page.locator('#enabled')).toBeChecked();
  });
}

for (const saved of ['f7', 'f8', 'f9', 'off']) {
  test(`saved macOS ${saved} choice survives reload and reset selects new default`, async ({ page }) => {
    await page.addInitScript(key => {
      if (!sessionStorage.getItem('shortcut-seeded')) {
        localStorage.setItem(key.key, key.saved);
        sessionStorage.setItem('shortcut-seeded', 'yes');
      }
    }, { key: KEY, saved });
    await page.goto('/typebridge/');
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#translit-shortcut')).toHaveValue(saved);
    await page.locator('#editor').press('Control+Shift+Space');
    await expect(page.locator('#enabled')).toBeChecked();
    if (saved !== 'off') {
      await expect(page.locator('#shortcut-label')).toHaveText(`(⌘+Shift+${saved.toUpperCase()})`);
      await page.locator('#editor').press(`Meta+Shift+${saved.toUpperCase()}`);
      await expect(page.locator('#enabled')).not.toBeChecked();
    } else {
      await page.locator('#editor').press('Meta+Shift+F7');
      await expect(page.locator('#enabled')).toBeChecked();
    }
    await page.reload();
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#translit-shortcut')).toHaveValue(saved);
    await page.locator('.shortcut-panel summary').click();
    await page.locator('#shortcut-reset').click();
    await expect(page.locator('#shortcut-label')).toHaveText('(Ctrl+Shift+Space)');
    expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe('default');
    await page.reload();
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#translit-shortcut')).toHaveValue('default');
    await expect(page.locator('#shortcut-label')).toHaveText('(Ctrl+Shift+Space)');
  });
}

test('macOS default leaves composition, repeats, extra modifiers and unrelated fields alone', async ({ page }) => {
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { metaKey: true }, { shiftKey: false }]) {
    const blocked = await page.locator('#editor').evaluate((el, init) => {
      const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    }, options);
    expect(blocked).toBe(false);
  }
  const blocked = await page.locator('#rules-text').evaluate(el => {
    const event = new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(blocked).toBe(false);
  await expect(page.locator('#enabled')).toBeChecked();
});

test('macOS new default works when shortcut preferences cannot be read or written', async ({ page }) => {
  await page.addInitScript(key => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (name) { if (name === key) throw new DOMException('Blocked', 'SecurityError'); return get.call(this, name); };
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException('Blocked', 'SecurityError'); return set.call(this, name, value); };
  }, KEY);
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').press('Control+Shift+Space');
  await expect(page.locator('#enabled')).not.toBeChecked();
  await page.locator('.shortcut-panel summary').click();
  await page.locator('#translit-shortcut').selectOption('f8');
  await page.locator('#shortcut-reset').click();
  await expect(page.locator('#shortcut-status')).toHaveText('Shortcut could not be saved');
  await page.locator('#editor').press('Control+Shift+Space');
  await expect(page.locator('#enabled')).toBeChecked();
});
