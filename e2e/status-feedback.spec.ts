import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// Status-line races from #52. Timers are controlled with Playwright's clock and
// saves are observed in IndexedDB, so no test depends on sleeps or retries.
function storedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const all = db.transaction('documents').objectStore('documents').getAll();
      all.onsuccess = () => { db.close(); resolve(all.result.map((draft: { text: string }) => draft.text)); };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  }));
}
const status = (page: Page) => page.locator('#status');
const SAVE_FAILED = 'Save failed — your text is unsaved. Copy or export it, then retry by editing.';
const SAVE_FAILED_NO_STORAGE = 'Save failed — browser storage is unavailable. Copy or export your text before closing.';
const STORAGE_UNAVAILABLE = 'Storage unavailable. Copy or export unsaved text before closing.';
const AUTOSAVE_OFF_UNSAVED = 'Autosave off — changes are unsaved';
const RETRYING = 'Saving again… The last save failed; your text stays unsaved until a save succeeds.';
// Copy may be refused by the headless clipboard; either message must keep the warning.
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function expectActionsKeep(page: Page, warning: string): Promise<void> {
  const tail = '\\. ' + escape(warning) + '$';
  await page.locator('#copy').click();
  await expect(status(page)).toHaveText(new RegExp('^(Copied|Copy unavailable\\. Text selected; use your device’s copy command)' + tail));
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText(new RegExp('^Text exported' + tail));
  await page.locator('#editor').evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(status(page)).toHaveText(new RegExp('^Select text to convert' + tail));
}
// The draft list is re-rendered only after a save has updated the status line,
// so waiting for it orders a negative status assertion after the save.
async function watchDraftListRenders(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const w = window as unknown as { draftListRenders: number };
    w.draftListRenders = 0;
    new MutationObserver(() => { w.draftListRenders++; })
      .observe(document.querySelector('#drafts')!, { childList: true });
  });
  return () => page.evaluate(() => (window as unknown as { draftListRenders: number }).draftListRenders);
}
function breakSaves(page: Page): Promise<void> {
  return page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  });
}
const restoreSaves = (page: Page) => page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());

test('a background autosave does not replace newer conversion guidance', async ({ page }) => {
  // install() alone lets fake time flow; pause it so only runFor() fires timers.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.getByRole('textbox', { name: 'Your text' });
  await expect(field).toBeEnabled();
  await field.fill('zhuk');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('zhuk');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 4));
  await field.press('Control+Shift+L');
  await expect(field).toHaveValue('жук');
  await expect(status(page)).toHaveText('Saving…');
  // The conversion's autosave is still pending when the guidance appears.
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(status(page)).toHaveText('Select text to convert');
  const renders = await watchDraftListRenders(page);
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('жук');
  await expect.poll(renders).toBeGreaterThan(0);
  await expect(status(page)).toHaveText('Select text to convert');
  // The next edit returns the line to save progress.
  await field.press('End');
  await field.pressSequentially('i');
  await page.clock.runFor(400);
  await expect(status(page)).toHaveText('Saved locally');
});

test('a failed save stays visible after later action feedback until a save succeeds', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Сохранено');
  await page.clock.runFor(400);
  await expect(status(page)).toHaveText('Saved locally');
  await breakSaves(page);
  await field.press('End');
  await field.pressSequentially(' несохранено');
  await page.clock.runFor(400);
  await expect(status(page)).toHaveText(SAVE_FAILED);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + SAVE_FAILED);
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(status(page)).toHaveText('Select text to convert. ' + SAVE_FAILED);
  await restoreSaves(page);
  await field.press('End');
  await field.pressSequentially('!');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Сохранено несохранено!');
  await expect(status(page)).toHaveText('Saved locally');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported');
});

test('save progress messages are replaced when the save they announce succeeds', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave off');
  await field.press('End');
  await field.pressSequentially(' правка');
  await expect(status(page)).toHaveText('Autosave off — changes are unsaved');
  await page.locator('#autosave').check();
  await expect.poll(() => storedTexts(page)).toContain('Сохранено правка');
  await expect(status(page)).toHaveText('Saved locally');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await page.locator('#autosave').check();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave on');
});

test('recovered text reports a completed save', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', 'yes');
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({
      id: 'pending-status', title: 'Черновик', text: 'Восстановленный текст', updatedAt: 1, revision: 0,
    }));
  });
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toHaveValue('Восстановленный текст');
  await expect.poll(() => storedTexts(page)).toContain('Восстановленный текст');
  await expect(status(page)).toHaveText('Saved locally');
});

test('discarding text after a failed save stops reporting unsaved text', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await breakSaves(page);
  await field.press('End');
  await field.pressSequentially(' несохранено');
  await expect(status(page)).toContainText('Save failed');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); // Discard unsaved changes.
  await page.locator('#new-draft').click();
  await expect(field).toHaveValue('');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported');
  // With autosave back on, a stale failure would be appended to action feedback.
  await page.locator('#autosave').check();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave on');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported');
});

test('a save that resolves an earlier failure reports success without a new edit', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Первый');
  await expect(status(page)).toHaveText('Saved locally');
  await breakSaves(page);
  await field.press('End');
  await field.pressSequentially(' два');
  await expect(status(page)).toContainText('Save failed');
  // Switching drafts saves the failed text first.
  await restoreSaves(page);
  await page.locator('#new-draft').click();
  await expect(field).toHaveValue('');
  await expect.poll(() => storedTexts(page)).toContain('Первый два');
  await expect(status(page)).toHaveText('Saved locally');
});

test('a background save on hiding the page clears an earlier failure', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Первый');
  await expect(status(page)).toHaveText('Saved locally');
  await breakSaves(page);
  await field.press('End');
  await field.pressSequentially(' два');
  await expect(status(page)).toContainText('Save failed');
  await page.locator('#export-txt').click();
  await expect(status(page)).toContainText('Text exported');
  await restoreSaves(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => storedTexts(page)).toContain('Первый два');
  await expect(status(page)).toHaveText('Saved locally');
});

test('action feedback during a successful retry does not leave a stale failure', async ({ page }) => {
  // install() alone lets fake time flow; pause it so only runFor() fires timers.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первый');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Первый');
  await breakSaves(page);
  await field.press('End');
  await field.pressSequentially('2');
  await page.clock.runFor(400);
  await expect(status(page)).toContainText('Save failed');
  await restoreSaves(page);
  await field.pressSequentially('3');
  await expect(status(page)).toHaveText(RETRYING);
  await page.locator('#export-txt').click();
  await expect(status(page)).toContainText('Text exported');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Первый23');
  await expect(status(page)).toHaveText('Saved locally');
});

test('a failed reload backup gives way to the save that follows it', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Первый');
  await expect(status(page)).toHaveText('Saved locally');
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key === 'typebridge.pendingDraft.v1') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await field.press('End');
  await field.pressSequentially(' два');
  // Unload starts: the backup fails, then the flush in the same handler saves the text.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => storedTexts(page)).toContain('Первый два');
  await expect(status(page)).toHaveText('Saved locally');
});

test('a failed autosave preference write stays visible when toggling', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Первый');
  await expect(status(page)).toHaveText('Saved locally');
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key === 'typebridge.autosave.v1') throw new DOMException('Blocked', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Could not save preference. Autosave off');
  await page.locator('#autosave').check();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Could not save preference. Autosave on');
  // Deleting the saved copy leaves the text only in memory: say so.
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Could not save preference. Autosave off — changes are unsaved');
  await expect.poll(() => storedTexts(page)).toEqual([]);
});

test('with autosave off after a failure, action feedback keeps the unsaved warning without advising a retry', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await breakSaves(page);
  await field.press('End');
  await field.pressSequentially(' несохранено');
  await expect(status(page)).toContainText('Save failed');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave off — changes are unsaved');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. Autosave off — changes are unsaved');
});

test('without browser storage, failures do not advise retrying by editing', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
  });
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(status(page)).toContainText('Storage unavailable');
  await field.fill('Нельзя потерять');
  await expect(status(page)).toHaveText('Save failed — browser storage is unavailable. Copy or export your text before closing.');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. Save failed — browser storage is unavailable. Copy or export your text before closing.');
  await expect(field).toHaveValue('Нельзя потерять');
});

test('a failed delete with autosave off does not promise another save', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await field.press('End');
  await field.pressSequentially(' правка');
  await page.evaluate(() => {
    IDBObjectStore.prototype.delete = function () { throw new DOMException('Unknown', 'UnknownError'); };
  });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-draft').click();
  await expect(status(page)).toHaveText('Could not delete draft — your changes are unsaved; autosave is off');
  await expect(field).toHaveValue('Сохранено правка');
});

test('without browser storage, toggling autosave keeps the storage warning', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key === 'typebridge.autosave.v1') throw new DOMException('Blocked', 'SecurityError');
      return setItem.call(this, key, value);
    };
  });
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Could not save preference. Storage unavailable. Copy or export unsaved text before closing.');
  await field.fill('Нельзя потерять');
  await expect(status(page)).toHaveText(SAVE_FAILED_NO_STORAGE);
  await page.locator('#autosave').check();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toContainText('browser storage is unavailable');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Could not save preference. Save failed — browser storage is unavailable. Copy or export your text before closing.');
});

test('switching to a clean draft with autosave off does not report unsaved changes', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Первый');
  await expect(status(page)).toHaveText('Saved locally');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await field.press('End');
  await field.pressSequentially(' черновик');
  await expect(status(page)).toHaveText('Autosave off — changes are unsaved');
  page.once('dialog', dialog => dialog.accept()); // Discard unsaved changes.
  await page.locator('#new-draft').click();
  await expect(field).toHaveValue('');
  await expect(status(page)).toHaveText('Autosave off');
});

test('with autosave off, Copy, Export and Convert keep the unsaved-changes warning until the edit is saved', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  page.once('dialog', dialog => dialog.dismiss()); // Keep the saved copy.
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  // Clean draft: no warning yet.
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported');
  await field.press('End');
  await field.pressSequentially(' правка');
  await expect(status(page)).toHaveText(AUTOSAVE_OFF_UNSAVED);
  await expectActionsKeep(page, AUTOSAVE_OFF_UNSAVED);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + AUTOSAVE_OFF_UNSAVED);
  // Saving resolves the risk.
  await page.locator('#autosave').check();
  await expect.poll(() => storedTexts(page)).toContain('Сохранено правка');
  await expect(status(page)).toHaveText('Saved locally');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported');
});

test('a failed IndexedDB initialization stays visible after Copy, Export and Convert', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
  });
  // Paused fake clock: the autosave debounce runs only when the test says so.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(status(page)).toHaveText(STORAGE_UNAVAILABLE);
  await expectActionsKeep(page, STORAGE_UNAVAILABLE);
  await field.fill('Нельзя потерять');
  await expect(status(page)).toHaveText(SAVE_FAILED_NO_STORAGE);
  await page.clock.runFor(400); // The debounced save fails before the actions below.
  await expect(status(page)).toHaveText(SAVE_FAILED_NO_STORAGE);
  await expectActionsKeep(page, SAVE_FAILED_NO_STORAGE);
  // Autosave off does not hide that storage is unavailable.
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + SAVE_FAILED_NO_STORAGE);
  await expect(field).toHaveValue('Нельзя потерять');
});

test('a blocked database upgrade stays visible after action feedback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => {
      const request: { onblocked?: () => void } = {};
      queueMicrotask(() => request.onblocked?.());
      return request;
    } } });
  });
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const blocked = 'Database upgrade blocked. Close other TypeBridge tabs, then reload.';
  await expect(status(page)).toHaveText(blocked);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + blocked);
  await page.locator('#editor').fill('Текст');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. Changes are unsaved. ' + blocked);
});

test('a database upgrade in another tab stays visible after action feedback and edits', async ({ page, context }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  const other = await context.newPage();
  await other.goto('/typebridge/404');
  await other.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 2);
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  }));
  const upgraded = 'Storage was upgraded in another tab. Copy or export unsaved text, then reload.';
  await expect(status(page)).toHaveText(upgraded);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + upgraded);
  await field.press('End');
  await field.pressSequentially(' правка');
  await expect(status(page)).toHaveText('Changes are unsaved. ' + upgraded);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. Changes are unsaved. ' + upgraded);
  await expect(field).toHaveValue('Сохранено правка');
});

test('recovered text with autosave off keeps the unsaved warning after actions', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', 'yes');
    localStorage.setItem('typebridge.autosave.v1', 'off');
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({
      id: 'pending-off', title: 'Черновик', text: 'Восстановленный текст', updatedAt: 1, revision: 0,
    }));
  });
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toHaveValue('Восстановленный текст');
  await expect(status(page)).toHaveText('Recovered unsaved text; autosave is off');
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + AUTOSAVE_OFF_UNSAVED);
  await page.locator('#autosave').check();
  await expect.poll(() => storedTexts(page)).toContain('Восстановленный текст');
  await expect(status(page)).toHaveText('Saved locally');
});

test('toggling autosave before initialization finishes does not report unavailable storage', async ({ page }) => {
  await page.addInitScript(() => {
    // Hold initialization at its ownership lock until the test releases it.
    const request = LockManager.prototype.request;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (window as unknown as { releaseInit: () => void }).releaseInit = release;
    LockManager.prototype.request = function (this: LockManager, ...args: unknown[]) {
      return gate.then(() => (request as (...a: unknown[]) => Promise<unknown>).apply(this, args));
    } as LockManager['request'];
  });
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeDisabled();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave off');
  await page.evaluate(() => (window as unknown as { releaseInit: () => void }).releaseInit());
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(status(page)).toHaveText('Autosave off');
});

test('a database upgrade during an in-flight save keeps the storage warning', async ({ page }) => {
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await page.evaluate(() => {
    // Simulate another tab upgrading the database while this save's write is in flight.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      IDBObjectStore.prototype.put = put;
      const db = this.transaction.db;
      const result = put.apply(this, args);
      db.onversionchange?.call(db, new IDBVersionChangeEvent('versionchange', { oldVersion: 1, newVersion: 2 }));
      return result;
    };
  });
  await field.press('End');
  await field.pressSequentially(' правка');
  const upgraded = 'Storage was upgraded in another tab. Copy or export unsaved text, then reload.';
  await expect.poll(() => storedTexts(page)).toContain('Сохранено правка');
  await expect(status(page)).toHaveText(upgraded);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + upgraded);
});

test('importing without browser storage reports the storage warning once', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
  });
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#import-file').setInputFiles({ name: 'post.txt', mimeType: 'text/plain', buffer: Buffer.from('Текст') });
  await expect(status(page)).toHaveText('Import failed: browser storage cannot be used. ' + STORAGE_UNAVAILABLE);
});

// Keystrokes 100 ms apart never let the 300 ms autosave debounce fire.
async function typeFasterThanAutosave(page: Page, text: string, expected: string): Promise<void> {
  const field = page.locator('#editor');
  for (const char of text) {
    await field.press(char === ' ' ? 'Space' : char);
    await page.clock.runFor(100);
    await expect(status(page)).toHaveText(expected);
  }
}

test('continuous typing keeps an IndexedDB initialization failure visible', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
  });
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(status(page)).toHaveText(STORAGE_UNAVAILABLE);
  await field.focus();
  await page.locator('#enabled').uncheck(); // Type Latin letters as they are.
  await field.focus();
  await typeFasterThanAutosave(page, 'abc def', SAVE_FAILED_NO_STORAGE);
  // Typing stops and the debounced save runs: storage is still unavailable.
  await page.clock.runFor(400);
  await expect(status(page)).toHaveText(SAVE_FAILED_NO_STORAGE);
  await expect(field).toHaveValue('abc def');
});

test('continuous typing keeps a failed save visible until a commit succeeds', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#enabled').uncheck();
  await field.focus();
  const renders = await watchDraftListRenders(page);
  await field.pressSequentially('saved');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('saved');
  // The save finishes with a draft-list refresh; wait so no save is still in flight.
  await expect.poll(renders).toBeGreaterThan(0);
  await expect(status(page)).toHaveText('Saved locally');
  await breakSaves(page);
  await field.pressSequentially(' x');
  await page.clock.runFor(400);
  await expect(status(page)).toHaveText(SAVE_FAILED);
  // Each keystroke would reset the debounce; the failure must stay visible.
  await typeFasterThanAutosave(page, ' more', RETRYING);
  await page.clock.runFor(400);
  await expect(status(page)).toHaveText(SAVE_FAILED);
  // Storage recovers, but no commit has happened yet: still unsaved.
  await restoreSaves(page);
  await typeFasterThanAutosave(page, ' text', RETRYING);
  await expect.poll(() => storedTexts(page)).toContain('saved');
  expect(await storedTexts(page)).not.toContain('saved x more text');
  // Only a verified commit clears it.
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('saved x more text');
  await expect(status(page)).toHaveText('Saved locally');
  await field.pressSequentially('!');
  await expect(status(page)).toHaveText('Saving…');
});

for (const failure of ['blocked IndexedDB', 'quota failure'] as const) {
  test(`a failed debounced save keeps newer action feedback with its warning (${failure})`, async ({ page }) => {
    if (failure === 'blocked IndexedDB') {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
      });
    }
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.goto('/typebridge/');
    await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
    const field = page.locator('#editor');
    await expect(field).toBeEnabled();
    let warning = SAVE_FAILED_NO_STORAGE;
    if (failure === 'quota failure') {
      await field.fill('Сохранено');
      await page.clock.runFor(400);
      await expect(status(page)).toHaveText('Saved locally');
      await breakSaves(page);
      await field.press('End');
      await field.pressSequentially(' a');
      await page.clock.runFor(400);
      await expect(status(page)).toHaveText(SAVE_FAILED);
      warning = SAVE_FAILED;
    }
    // Edit, then act before the debounced save runs and fails.
    await field.press('End');
    await field.pressSequentially(' b');
    await page.locator('#export-txt').click();
    await expect(status(page)).toHaveText('Text exported. ' + warning);
    await page.clock.runFor(400);
    await expect(status(page)).toHaveText('Text exported. ' + warning);
    // The next edit still shows progress without hiding the failure.
    await field.pressSequentially('c');
    await expect(status(page)).toHaveText(failure === 'quota failure' ? RETRYING : SAVE_FAILED_NO_STORAGE);
  });
}

test('a failed delete without storage and with autosave off keeps the storage warning', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open: () => { throw new Error('blocked'); } } });
  });
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#autosave').uncheck();
  await expect(page.locator('#autosave')).toBeEnabled();
  await field.fill('Нельзя потерять');
  await expect(status(page)).toHaveText(SAVE_FAILED_NO_STORAGE);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#delete-draft').click();
  await expect(status(page)).toHaveText('Could not delete draft — your text is kept. ' + SAVE_FAILED_NO_STORAGE);
  await expect(field).toHaveValue('Нельзя потерять');
});

const CONFLICT_COPY = 'Another tab changed this draft. Your edits were saved as a conflict copy.';
const UPGRADED = 'Storage was upgraded in another tab. Copy or export unsaved text, then reload.';
const DRAFT_LIST_REFRESH_FAILED = ' — draft list could not be refreshed';

/** Force the next save into a conflict copy by committing a newer revision from another tab. */
async function createForeignRevision(page: Page, context: BrowserContext, text: string): Promise<void> {
  const other = await context.newPage();
  await other.goto('/typebridge/');
  await expect(other.locator('#editor')).toHaveValue(text);
  await other.locator('#editor').fill('Версия другой вкладки');
  await page.clock.runFor(400); // The fake clock is shared by both tabs.
  await expect(other.locator('#status')).toHaveText('Saved locally');
  await other.close();
}

test('a database upgrade while a conflict copy is written keeps the storage warning', async ({ page, context }) => {
  // Paused fake clock: the whole edit below is one save, however slowly it is typed.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  const renders = await watchDraftListRenders(page);
  await field.fill('Исходный');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный');
  await expect.poll(renders).toBeGreaterThan(0); // No save still in flight.
  await expect(status(page)).toHaveText('Saved locally');
  // Another tab saves a newer revision, so this tab's next save becomes a conflict copy.
  await createForeignRevision(page, context, 'Исходный');
  await page.evaluate(() => {
    // Another tab upgrades the database while the conflict copy is being added.
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      IDBObjectStore.prototype.add = add;
      const db = this.transaction.db;
      const result = add.apply(this, args);
      db.onversionchange?.call(db, new IDBVersionChangeEvent('versionchange', { oldVersion: 1, newVersion: 2 }));
      return result;
    };
  });
  await field.press('End');
  await field.pressSequentially(' — правка');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный — правка');
  await expect(status(page)).toHaveText(CONFLICT_COPY + ' ' + UPGRADED);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + UPGRADED);
});

test('a database upgrade after a conflict copy keeps the conflict notice with the storage warning', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  const renders = await watchDraftListRenders(page);
  await field.fill('Исходный');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный');
  await expect.poll(renders).toBeGreaterThan(0);
  await expect(status(page)).toHaveText('Saved locally');
  await createForeignRevision(page, context, 'Исходный');
  // Capture the page's live IDB connection during the conflict write.
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      IDBObjectStore.prototype.add = add;
      (window as unknown as { typebridgeDb: IDBDatabase }).typebridgeDb = this.transaction.db;
      return add.apply(this, args);
    };
  });
  await field.press('End');
  await field.pressSequentially(' — правка');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный — правка');
  await expect.poll(renders).toBeGreaterThan(1);
  await expect(status(page)).toHaveText(CONFLICT_COPY);
  // Upgrade arrives after the conflict copy has already been announced.
  await page.evaluate(() => {
    const db = (window as unknown as { typebridgeDb: IDBDatabase }).typebridgeDb;
    db.onversionchange?.call(db, new IDBVersionChangeEvent('versionchange', { oldVersion: 1, newVersion: 2 }));
  });
  await expect(status(page)).toHaveText(CONFLICT_COPY + ' ' + UPGRADED);
  await page.locator('#export-txt').click();
  await expect(status(page)).toHaveText('Text exported. ' + UPGRADED);
});

test('a failed follow-up save after a conflict copy keeps the conflict notice with the save warning', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  const renders = await watchDraftListRenders(page);
  await field.fill('Исходный');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный');
  await expect.poll(renders).toBeGreaterThan(0);
  await createForeignRevision(page, context, 'Исходный');
  // Conflict copy succeeds; a later put in the same persist loop fails after an in-flight edit.
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      IDBObjectStore.prototype.add = add;
      const result = add.apply(this, args);
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () {
        IDBObjectStore.prototype.put = put;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      };
      // Keep persist() looping: bump the generation the same way an in-flight edit would.
      const editor = document.querySelector<HTMLTextAreaElement>('#editor')!;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '!', inputType: 'insertText' }));
      return result;
    };
  });
  await field.press('End');
  await field.pressSequentially(' — правка');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный — правка');
  await expect(status(page)).toHaveText(CONFLICT_COPY + ' ' + SAVE_FAILED);
});

test('draft-list refresh failure after a conflict copy stays before the storage warning', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/typebridge/');
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  const renders = await watchDraftListRenders(page);
  await field.fill('Исходный');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный');
  await expect.poll(renders).toBeGreaterThan(0);
  await createForeignRevision(page, context, 'Исходный');
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      IDBObjectStore.prototype.add = add;
      const db = this.transaction.db;
      const result = add.apply(this, args);
      // Storage warning is composed into the conflict notice; db is cleared so listStoredDrafts is skipped.
      db.onversionchange?.call(db, new IDBVersionChangeEvent('versionchange', { oldVersion: 1, newVersion: 2 }));
      return result;
    };
    // Force the post-save refresh path to fail while re-rendering the draft list.
    const replaceChildren = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (this: Element, ...args: Parameters<Element['replaceChildren']>) {
      if (this.id === 'drafts') {
        Element.prototype.replaceChildren = replaceChildren;
        throw new DOMException('InvalidStateError', 'InvalidStateError');
      }
      return replaceChildren.apply(this, args);
    };
  });
  await field.press('End');
  await field.pressSequentially(' — правка');
  await page.clock.runFor(400);
  await expect.poll(() => storedTexts(page)).toContain('Исходный — правка');
  await expect(status(page)).toHaveText(CONFLICT_COPY + DRAFT_LIST_REFRESH_FAILED + ' ' + UPGRADED);
});
