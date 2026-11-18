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
    Object.assign(window, { retireTestUpdate: (event: string) => {
      Object.assign(worker, { state: 'activated' });
      Object.assign(registration, { waiting: null, active: worker });
      Object.assign(container, { controller: worker });
      if (event === 'statechange') worker.dispatchEvent(new Event(event));
      else container.dispatchEvent(new Event(event));
    }, installTestUpdate: () => {
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
  await page.goto('/editor.html');
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
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#update-notice')).toBeHidden();
  await page.evaluate(() => (window as unknown as { installTestUpdate: () => void }).installTestUpdate());
  await expect(page.locator('#update-notice')).toBeVisible();
});

for (const failSave of [false, true]) {
  test(`explicit update reload preserves pending text; failed save=${failSave} (#137 U9)`, async ({ page }) => {
    await waitingUpdate(page);
    await page.goto('/editor.html');
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
    await page.goto('/editor.html');
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
  await page.goto('/editor.html');
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
  await page.goto('/editor.html');
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
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#update-notice')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`update-notice-${colorScheme}-${width}.png`), fullPage: true, animations: 'disabled' });
  });
}

test('an "installed" event for a worker that is already active and not waiting shows no notice', async ({ page }) => {
  await page.addInitScript(() => {
    const container = new EventTarget();
    const registration = new EventTarget();
    const worker = new EventTarget();
    Object.assign(worker, { state: 'installing', postMessage: () => {} });
    Object.assign(registration, { waiting: null, installing: worker, active: null });
    Object.assign(container, { controller: null, ready: Promise.resolve(registration), register: () => Promise.resolve(registration) });
    Object.defineProperty(navigator, 'serviceWorker', { value: container });
    // The worker activates and claims the page before its late "installed" statechange is handled.
    // It already controls the page and is not waiting, yet still reports "installed".
    Object.assign(window, { lateInstalled: () => {
      Object.assign(worker, { state: 'installed' });
      Object.assign(registration, { installing: worker, waiting: null, active: worker });
      Object.assign(container, { controller: worker });
      worker.dispatchEvent(new Event('statechange'));
    } });
  });
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.evaluate(() => (window as unknown as { lateInstalled: () => void }).lateInstalled());
  await page.waitForTimeout(300);
  await expect(page.locator('#update-notice')).toBeHidden();
});


for (const late of [false, true]) for (const event of ['statechange', 'controllerchange']) {
  test(`externally activated ${late ? 'later' : 'initial'} update retires notice on ${event}`, async ({ page }) => {
    await waitingUpdate(page, { late, failActivation: false });
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    if (late) await page.evaluate(() => (window as unknown as { installTestUpdate: () => void }).installTestUpdate());
    await expect(page.locator('#update-notice')).toBeVisible();
    await page.locator('#editor').fill('Retained after external activation');
    const navigations: string[] = [];
    page.on('framenavigated', frame => navigations.push(frame.url()));
    await page.evaluate(event => (window as unknown as { retireTestUpdate: (event: string) => void }).retireTestUpdate(event), event);
    await expect(page.locator('#update-notice')).toBeHidden();
    await expect(page.locator('#editor')).toHaveValue('Retained after external activation');
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    expect(navigations).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('test.update.activated'))).toBeNull();
    await expect.poll(async () => (await page.locator('#editor').boundingBox())!.y).toBeLessThan(300);
  });
}

for (const width of [320, 390]) for (const enlarged of [false, true]) {
  test(`late waiting update preserves usable phone layout at ${width}px, enlarged=${enlarged} (#304)`, async ({ page }, testInfo) => {
    await waitingUpdate(page, { late: true, failActivation: false });
    await page.setViewportSize({ width, height: 800 });
    if (enlarged) await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = 'html { font-size: 24px; } body { font-size: 1rem; } button, input, label, span, select { font-size: inherit; }';
        document.head.append(style);
      });
    });
    await page.goto('/editor.html');
    const editor = page.locator('#editor');
    const notice = page.locator('#update-notice');
    await expect(editor).toBeEnabled();
    await expect(notice).toBeHidden();
    if (!enlarged) await expect.poll(async () => (await editor.boundingBox())!.y).toBeLessThan(width < 360 ? 340 : 300);
    const before = (await editor.boundingBox())!.y;
    await editor.fill('Keep editing through an update');
    await page.evaluate(() => (window as unknown as { installTestUpdate: () => void }).installTestUpdate());
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('New version available');
    const visible = (await editor.boundingBox())!.y;
    expect(visible).toBeGreaterThan(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    for (const name of ['Reload', 'Not now']) {
      const button = notice.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = (await button.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await editor.fill('Editing still works while update waits');
    await notice.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(notice).toBeHidden();
    await expect(editor).toHaveValue('Editing still works while update waits');
    await expect.poll(async () => Math.abs((await editor.boundingBox())!.y - before)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => sessionStorage.getItem('test.update.activated'))).toBeNull();
    await testInfo.attach('update-layout-geometry', { body: JSON.stringify({ width, enlarged, before, visible, after: (await editor.boundingBox())!.y }), contentType: 'application/json' });
  });
}

test('keyboard dismissal returns focus and selection to the previous editor (#11)', async ({ page }) => {
  await waitingUpdate(page);
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Keep my selection');
  await editor.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(5, 7); });
  const dismiss = page.locator('#update-notice').getByRole('button', { name: 'Not now', exact: true });
  await dismiss.focus();
  await dismiss.press('Enter');
  await expect(page.locator('#update-notice')).toBeHidden();
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([5, 7]);
  await expect(editor).toHaveValue('Keep my selection');
});

for (const retired of ['other', 'hidden', 'detached'] as const) {
  test(`update dismissal does not steal focus from another control, retired target=${retired} (#11)`, async ({ page }) => {
    await waitingUpdate(page);
    await page.goto('/editor.html');
    const editor = page.locator('#editor');
    await expect(editor).toBeEnabled();
    await editor.focus();
    const dismiss = page.locator('#update-notice').getByRole('button', { name: 'Not now', exact: true });
    await dismiss.focus();
    await page.evaluate(retired => {
      const editor = document.querySelector<HTMLElement>('#editor')!;
      if (retired === 'hidden') editor.hidden = true;
      else if (retired === 'detached') editor.remove();
      else document.querySelector<HTMLElement>('#focus-mode')!.focus();
      // Programmatic dismissal must not move focus away from a different control.
      document.querySelector<HTMLButtonElement>('#update-notice button:last-child')!.click();
    }, retired);
    await expect(page.locator('#update-notice')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('editor');
    if (retired === 'other') await expect(page.locator('#focus-mode')).toBeFocused();
  });
}
