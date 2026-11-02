import { expect, test, type Page } from '@playwright/test';
import { setAutosave } from './settings-helpers';

async function waitingUpdate(page: Page, options = { late: false, failActivation: false }): Promise<void> {
  await page.addInitScript(({ late, failActivation }) => {
    const container = new EventTarget();
    const registration = new EventTarget();
    const worker = new EventTarget();
    const active = sessionStorage.getItem('test.update.activated') === 'yes';
    Object.assign(worker, {
      state: late ? 'installing' : 'installed',
      postMessage: () => {
        if (failActivation) throw new Error('Update activation unavailable');
        sessionStorage.setItem('test.update.activated', 'yes');
        Object.assign(worker, { state: 'activated' });
        worker.dispatchEvent(new Event('statechange'));
        container.dispatchEvent(new Event('controllerchange'));
      },
    });
    Object.assign(registration, { waiting: !active && !late ? worker : null, installing: null, active: {} });
    Object.assign(container, { controller: {}, ready: Promise.resolve(registration), register: () => Promise.resolve(registration) });
    Object.defineProperty(navigator, 'serviceWorker', { value: container });
    Object.assign(window, { installTestUpdate: () => {
      Object.assign(registration, { installing: worker });
      registration.dispatchEvent(new Event('updatefound'));
      Object.assign(worker, { state: 'installed' });
      Object.assign(registration, { waiting: worker });
      worker.dispatchEvent(new Event('statechange'));
    } });
  }, options);
}

test('a waiting worker is announced without reloading, and dismissal lasts this session (#137 U9)', async ({ page }) => {
  await waitingUpdate(page);
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#update-notice')).toContainText('New version available');
  await page.locator('#editor').fill('Keep writing');
  await expect(page.locator('#editor')).toHaveValue('Keep writing');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  expect(await page.evaluate(() => sessionStorage.getItem('test.update.activated'))).toBeNull();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(page.locator('#update-notice')).toBeHidden();
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue('Keep writing');
  await expect(page.locator('#update-notice')).toBeHidden();
});

test('a later installed worker displays the notice (#137 U9)', async ({ page }) => {
  await waitingUpdate(page, { late: true, failActivation: false });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#update-notice')).toBeHidden();
  await page.evaluate(() => (window as unknown as { installTestUpdate: () => void }).installTestUpdate());
  await expect(page.locator('#update-notice')).toBeVisible();
});

for (const failSave of [false, true]) {
  test(`explicit update reload preserves pending text; failed save=${failSave} (#137 U9)`, async ({ page }) => {
    await waitingUpdate(page);
    await page.goto('/');
    const editor = page.locator('#editor');
    await expect(editor).toBeEnabled();
    if (failSave) await page.evaluate(() => {
      IDBObjectStore.prototype.put = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    });
    await editor.fill('Pending Unicode 🙂');
    await Promise.all([page.waitForEvent('framenavigated'), page.locator('#update-reload').click()]);
    await expect(editor).toHaveValue('Pending Unicode 🙂');
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    await expect(page.locator('#update-notice')).toBeHidden();
  });
}

for (const discard of [false, true]) {
  test(`privacy mode requires explicit ${discard ? 'discard' : 'keep editing'} before update reload (#137 U9)`, async ({ page }) => {
    await waitingUpdate(page);
    await page.goto('/');
    const editor = page.locator('#editor');
    await expect(editor).toBeEnabled();
    await editor.fill('Saved before privacy');
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    await setAutosave(page, false);
    await editor.fill('Private unsaved edit');
    await page.locator('#update-reload').click();
    const dialog = page.getByRole('dialog', { name: 'Reload without saving?', exact: true });
    await expect(dialog).toContainText('Text and title changes will be lost');
    if (discard) {
      await Promise.all([page.waitForEvent('framenavigated'), dialog.getByRole('button', { name: 'Discard changes and reload', exact: true }).click()]);
      await expect(editor).toHaveValue('Saved before privacy');
    } else {
      await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(page.locator('#update-reload')).toBeEnabled();
      await expect(editor).toHaveValue('Private unsaved edit');
      await expect(page.locator('main > section')).not.toHaveAttribute('inert');
      expect(await page.evaluate(() => sessionStorage.getItem('test.update.activated'))).toBeNull();
      expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1') ?? '')).not.toContain('Private unsaved edit');
    }
  });
}

test('failed save and failed reload backup block update reload (#137 U9)', async ({ page }) => {
  await waitingUpdate(page);
  await page.goto('/');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'typebridge.pendingDraft.v1' || key.startsWith('typebridge.recovery.')) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      set.call(this, key, value);
    };
  });
  await editor.fill('Must stay on screen');
  await page.locator('#update-reload').click();
  await expect(page.locator('#update-reload')).toBeEnabled();
  await expect(editor).toHaveValue('Must stay on screen');
  expect(await page.evaluate(() => sessionStorage.getItem('test.update.activated'))).toBeNull();
});

test('activation failure restores editing (#137 U9)', async ({ page }) => {
  await waitingUpdate(page, { late: false, failActivation: true });
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Kept after failure');
  await page.locator('#update-reload').click();
  await expect(page.locator('#update-notice')).toContainText('Could not reload safely');
  await expect(page.locator('main > section')).not.toHaveAttribute('inert');
  await page.locator('#editor').fill('Editing works');
});

for (const colorScheme of ['light', 'dark'] as const) for (const width of [390, 1400]) {
  test(`update notice evidence ${colorScheme} ${width}px (#137 U9)`, async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium', 'Chromium artifact evidence; behavior runs in all engines.');
    await waitingUpdate(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    await page.goto('/');
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#update-notice')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`update-notice-${colorScheme}-${width}.png`), fullPage: true, animations: 'disabled' });
  });
}
