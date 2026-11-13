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

test('Discard changes and reload clears change-log so salvage cannot revive (#255)', async ({ page }) => {
  // Fails on main: leftover change records after Autosave-off discard+reload become a "(recovered)" copy.
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await waitingUpdate(page);
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Before block');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));
  await editor.fill('Discarded after failed save');
  await expect(page.locator('#save-indicator')).toHaveText('Save failed');
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('changes', 'readonly');
      const req = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve((req.result as unknown[]).some(record =>
          JSON.stringify(record).includes('Discarded after failed save'),
        ));
      };
      tx.onerror = () => reject(tx.error);
    };
  }))).toBe(true);

  await setAutosave(page, false, 'keep');
  // Prior save failure can leave the indicator on "Save failed"; privacy mode is what matters.
  await expect(page.locator('#autosave')).not.toBeChecked();
  await page.locator('#update-reload').click();
  const dialog = page.getByRole('dialog', { name: 'Reload without saving?', exact: true });
  await Promise.all([
    page.waitForEvent('framenavigated'),
    dialog.getByRole('button', { name: 'Discard changes and reload', exact: true }).click(),
  ]);
  await expect(editor).toBeEnabled();
  await expect(editor).toHaveValue('Before block');
  await expect(page.locator('#status')).not.toContainText('Recovered unsaved text');
  await expect(page.getByRole('button', { name: /Recover / })).toHaveCount(0);
  const titles = await page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('documents', 'readonly');
      const req = tx.objectStore('documents').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve((req.result as Array<{ title?: string }>).map(doc => doc.title ?? ''));
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
  expect(titles.some(title => title.includes('(recovered)'))).toBe(false);
  await expect.poll(() => page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('changes', 'readonly');
      const req = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve((req.result as unknown[]).filter(record =>
          JSON.stringify(record).includes('Discarded after failed save'),
        ).length);
      };
      tx.onerror = () => reject(tx.error);
    };
  }))).toBe(0);
});

test('Discard changes and reload keeps an unrelated same-document journal (#256 P0)', async ({ page }) => {
  // Fails if apply clears every journal for documentId instead of the exact consented snapshot.
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await waitingUpdate(page);
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Before block');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const documentId = await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>('#drafts');
    return select?.value ?? '';
  });
  expect(documentId).not.toBe('');
  // Orphan journal from another tab/crash: different text, same document id.
  const orphan = {
    token: 'orphan-token',
    tab: 'orphan-tab',
    documentId,
    revision: 1,
    timestamp: Date.now() - 60_000,
    title: 'Untitled document',
    text: 'UNRELATED-ORPHAN-JOURNAL-TEXT',
  };
  await page.evaluate(entry => {
    localStorage.setItem(
      `typebridge.recovery.v1.${entry.tab}.${entry.documentId}`,
      JSON.stringify(entry),
    );
  }, orphan);
  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));
  await editor.fill('Discarded after failed save');
  await expect(page.locator('#save-indicator')).toHaveText('Save failed');
  await setAutosave(page, false, 'keep');
  await page.locator('#update-reload').click();
  const dialog = page.getByRole('dialog', { name: 'Reload without saving?', exact: true });
  await Promise.all([
    page.waitForEvent('framenavigated'),
    dialog.getByRole('button', { name: 'Discard changes and reload', exact: true }).click(),
  ]);
  await expect(editor).toBeEnabled();
  await expect(page.locator('#status')).not.toContainText('Recovered unsaved text');
  const orphanLeft = await page.evaluate(entry => {
    const raw = localStorage.getItem(`typebridge.recovery.v1.${entry.tab}.${entry.documentId}`);
    return raw === JSON.stringify(entry);
  }, orphan);
  expect(orphanLeft).toBe(true);
});

test('cancelled update-reload keeps change records for later salvage (#255)', async ({ page }) => {
  // Fails if cancel leaves session intent so a later ownership salvage deletes the records.
  test.setTimeout(60_000);
  // Unique fragment that survives changeBetween's common-prefix/suffix compression.
  const recoverable = 'ZZZ-must-stay-recoverable-999';
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (sessionStorage.getItem('typebridge.e2e.blockDocumentPuts') === 'yes' && this.name === 'documents') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  });
  await waitingUpdate(page, { late: false, failActivation: true });
  await page.goto('/editor.html');
  const editor = page.locator('#editor');
  await expect(editor).toBeEnabled();
  await editor.fill('Keep base');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.evaluate(() => sessionStorage.setItem('typebridge.e2e.blockDocumentPuts', 'yes'));
  await editor.fill(recoverable);
  await expect(page.locator('#save-indicator')).toHaveText('Save failed');
  await expect.poll(() => page.evaluate(needle => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('changes', 'readonly');
      const req = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve((req.result as unknown[]).some(record => JSON.stringify(record).includes(needle)));
      };
      tx.onerror = () => reject(tx.error);
    };
  }), recoverable)).toBe(true);
  await setAutosave(page, false, 'keep');
  await page.locator('#update-reload').click();
  const dialog = page.getByRole('dialog', { name: 'Reload without saving?', exact: true });
  await dialog.getByRole('button', { name: 'Discard changes and reload', exact: true }).click();
  await expect(page.locator('#update-notice')).toContainText('Could not reload safely');
  // Intent cleared; change records must still be present.
  await expect.poll(() => page.evaluate(needle => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('changes', 'readonly');
      const req = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close();
        resolve((req.result as unknown[]).some(record => JSON.stringify(record).includes(needle)));
      };
      tx.onerror = () => reject(tx.error);
    };
  }), recoverable)).toBe(true);
  // No session intent left for a stale apply.
  expect(await page.evaluate(() =>
    Object.keys(sessionStorage).some(key => key.startsWith('typebridge.reloadDiscard.v1.')),
  )).toBe(false);
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
