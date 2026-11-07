import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { fillHostEditor, setHostAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

/** #175 step 7: one host Settings panel; prefs apply live to every window. */

async function openHost(page: Page): Promise<FrameLocator> {
  await page.goto('/host.html');
  const frame = page.frameLocator('.host-window iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  return frame;
}

async function openHostSettings(page: Page): Promise<void> {
  const panel = page.locator('#settings-panel');
  if (await panel.isHidden()) await page.locator('#settings-open').click();
  await expect(panel).toBeVisible();
}

test('host Settings appearance and typing mode apply to every window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  await openHostSettings(page);
  await page.locator('#appearance').selectOption('dark');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe('dark');
  await expect.poll(async () => main.locator('html').getAttribute('data-color-scheme')).toBe('dark');
  await expect.poll(async () => second.locator('html').getAttribute('data-color-scheme')).toBe('dark');

  await page.locator('#tab-indent').uncheck();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('typebridge.editor.tabIndent.v1'))).toBe('off');

  await page.locator('#translit-shortcut').selectOption('f8');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('typebridge.transliteration.shortcut.v1'))).toBe('f8');
  await expect.poll(async () => main.locator('#shortcut-label').textContent()).toMatch(/F8/i);
  await expect.poll(async () => second.locator('#shortcut-label').textContent()).toMatch(/F8/i);

  await page.locator('#settings-close').click();
  await expect(page.locator('#settings-panel')).toBeHidden();

  // One shared Latin/Кириллица switch in the host top bar; windows follow it.
  await expect(page.locator('#host-shortcut-label')).toHaveText(/F8/i);
  await expect(main.locator('.mode-switch')).toBeHidden();
  await page.locator('.host-toolbar .mode-switch .mode-side').first().click();
  await expect(page.locator('#host-enabled')).not.toBeChecked();
  await expect.poll(async () => main.locator('#enabled').isChecked()).toBe(false);
  await expect.poll(async () => second.locator('#enabled').isChecked()).toBe(false);
  const secondTitle = page.locator('.host-window[data-window-id="w2"] .host-window-title');
  await secondTitle.fill('w');
  await expect(secondTitle).toHaveValue('w');
  // Latin mode: host title write-through must not transliterate the typed Latin letter.
  await expect.poll(async () => second.locator('#draft-title').inputValue()).toBe('w');
});

test('host custom rules apply live in every window without reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  await openHostSettings(page);
  const mappings = page.getByRole('textbox', { name: 'Transliteration mappings' });
  await mappings.fill((await mappings.inputValue()).replace(/^w = щ$/m, 'w = в'));
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.locator('#rules-status')).toContainText('Rules saved');
  await page.locator('#settings-close').click();

  await second.locator('#editor').click();
  await second.locator('#editor').pressSequentially('w');
  await expect(second.locator('#editor')).toHaveValue('в');
});

test('embedded Settings button opens the host panel', async ({ page }) => {
  const main = await openHost(page);
  // Embedded Settings control is visually hidden; the click handler still opens the host panel.
  await main.locator('#settings-open').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('#settings-panel')).toBeVisible();
});

test('Escape in an embedded editor closes host Settings without entering Focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await openHostSettings(page);
  await expect(page.locator('#settings-open')).toHaveAttribute('aria-expanded', 'true');

  // Try a setting in the editor while the panel stays open (#123 / #175 step 7).
  await fillHostEditor(main, 'try while open');
  await main.locator('#editor').focus();
  await page.keyboard.press('Escape');

  await expect(page.locator('#settings-panel')).toBeHidden();
  await expect(page.locator('#settings-open')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('body')).not.toHaveClass(/host-focus-mode/);
  await expect(main.locator('body')).not.toHaveClass(/focus-mode/);
});

test('embedded host windows hide comparison / another-window control', async ({ page }) => {
  const main = await openHost(page);
  await expect(main.locator('#toggle-split')).toHaveCount(0);
  await expect(main.locator('#editor-b')).toHaveCount(0);
  await expect(main.locator('#open-comparison')).toBeHidden();
});

test('host Autosave on persists unsaved text in every window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });

  await setHostAutosave(page, false);
  await fillHostEditor(second, 'Shared autosave flush');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');

  await setHostAutosave(page, true);
  await expect(second.locator('#save-indicator')).toHaveText('Saved', { timeout: 15_000 });
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('typebridge');
      req.onerror = () => reject(req.error ?? new Error('open failed'));
      req.onsuccess = () => resolve(req.result);
    });
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const tx = db.transaction('documents', 'readonly');
        const req = tx.objectStore('documents').getAll();
        req.onerror = () => reject(req.error ?? new Error('getAll failed'));
        req.onsuccess = () => {
          const match = (req.result as Array<{ text?: string }>).find(doc => doc.text === 'Shared autosave flush');
          resolve(match?.text ?? '');
        };
      });
      return text;
    } finally {
      db.close();
    }
  })).toBe('Shared autosave flush');

  await setHostAutosave(page, false);
  await fillHostEditor(second, 'Private again');
  await expect(second.locator('#save-indicator')).toHaveText('Not saved');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('typebridge.autosave.v1'))).toBe('off');
});

test('host Autosave off updates a read-only window checkbox', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await fillHostEditor(main, 'Shared before privacy');
  await expect(main.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'Shared before privacy')).toBe(true);
  const docId = (await readStoredDocs(page)).find(row => row.text === 'Shared before privacy')!.id;

  await page.getByRole('button', { name: 'New window' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const panel = second.locator('#doc-menu');
  if (await panel.isHidden()) await second.locator('#doc-menu-open').click();
  await expect(panel).toBeVisible();
  await second.locator('#drafts').selectOption(docId);
  await expect(second.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(second.locator('#editor')).toHaveJSProperty('readOnly', true);
  if (await panel.isVisible()) await second.locator('#doc-menu-open').click();
  await expect(panel).toBeHidden();

  // Privacy: even while blocked, the shared Autosave choice must flip locally.
  await setHostAutosave(page, false);
  await expect.poll(async () => page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="w2"] iframe')?.contentDocument;
    return doc?.querySelector<HTMLInputElement>('#autosave')?.checked ?? true;
  }), { timeout: 15_000 }).toBe(false);
  await expect.poll(async () => page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="main"] iframe')?.contentDocument;
    return doc?.querySelector<HTMLInputElement>('#autosave')?.checked ?? true;
  })).toBe(false);
});

test('host Focus mode hides Settings; Reset still exits Focus', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  const main = await openHost(page);
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);

  // Open Settings first; Focus hides the panel and toolbar button (same as standalone).
  await openHostSettings(page);
  await main.locator('#focus-mode').evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.locator('body')).toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeHidden();
  await expect(page.locator('#settings-open')).toBeHidden();
  await expect(page.locator('#settings-panel')).toBeHidden();

  // Panel is only CSS-hidden; Reset (via the still-mounted control) still clears host Focus.
  await page.locator('#reset-settings').evaluate((button: HTMLButtonElement) => button.click());
  const dialog = page.getByRole('dialog', { name: 'Reset settings to defaults?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Reset settings' }).click();
  await expect(page.locator('body')).not.toHaveClass(/host-focus-mode/);
  await expect(page.locator('.host-window[data-window-id="main"]')).toBeVisible();
  await expect(page.locator('.host-window[data-window-id="w2"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New window' })).toBeEnabled();
  await expect(page.locator('#settings-open')).toBeVisible();
});

test('closing a window does not leave a prefs listener that resurrects discarded text', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem('typebridge.host.layoutMode.v1', 'free');
    localStorage.setItem('typebridge.autosave.v1', 'off');
  });
  const mainShell = page.locator('.host-window[data-window-id="main"]');
  const main = await openHost(page);
  await fillHostEditor(main, 'private text that must stay discarded');
  await expect(main.locator('#save-indicator')).toHaveText('Not saved');
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.locator('.host-window')).toHaveCount(2);

  await mainShell.locator('.host-window-close').click();
  const dialog = main.getByRole('dialog', { name: 'Close without saving?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes and close' }).click();
  await expect(page.locator('.host-window')).toHaveCount(1);

  // A leaked parent listener would run applyAutosaveChange on the discarded editor.
  await setHostAutosave(page, true);
  const remaining = page.frameLocator('.host-window iframe').first();
  await expect(remaining.locator('#editor')).not.toHaveValue('private text that must stay discarded');
  const stored = await readStoredDocs(page);
  expect(stored.every(doc => !doc.text.includes('private text that must stay discarded'))).toBe(true);
});

test('the window shortcut updates the shared host switch, and windows have no own switch or About link', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = await openHost(page);
  await expect(page.locator('#host-enabled')).toBeChecked();
  await expect(main.locator('#about-documents-open')).toBeHidden();
  await expect(main.locator('label[for="editor"]')).toHaveText('Your text');
  await main.locator('#editor').focus();
  await page.keyboard.press('Control+Shift+Space');
  await expect.poll(async () => main.locator('#enabled').isChecked()).toBe(false);
  await expect(page.locator('#host-enabled')).not.toBeChecked();
  await page.locator('#host-enabled').check();
  await expect.poll(async () => main.locator('#enabled').isChecked()).toBe(true);
});

test('the shared switch still changes every window when the host cannot save the preference', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const main = await openHost(page);
  // Break preference writes in the host page only (each window has its own Storage realm).
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'typebridge.transliteration.enabled.v1') throw new DOMException('Quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.locator('#host-enabled').uncheck();
  await expect.poll(async () => main.locator('#enabled').isChecked()).toBe(false);
  await expect(page.locator('#host-enabled')).not.toBeChecked();
});
