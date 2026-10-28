import { expect, test, type Page } from '@playwright/test';

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
  await page.goto('/typebridge/');
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await expect(status(page)).toHaveText('Saved locally');
  await breakSaves(page);
  await field.press('End');
  await field.pressSequentially(' несохранено');
  await expect(status(page)).toContainText('Save failed');
  await page.locator('#export-txt').click();
  await expect(status(page)).toContainText('Text exported');
  await expect(status(page)).toContainText('Save failed — your text is unsaved');
  await field.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(0, 0));
  await page.getByRole('button', { name: '→ ABC' }).click();
  await expect(status(page)).toContainText('Select text to convert');
  await expect(status(page)).toContainText('Save failed');
  await restoreSaves(page);
  await field.press('End');
  await field.pressSequentially('!');
  await expect(status(page)).toHaveText('Saved locally');
  await expect.poll(() => storedTexts(page)).toContain('Сохранено несохранено!');
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
  await expect(status(page)).toHaveText('Saving…');
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

test('with autosave off after a failure, action feedback does not advise retrying by editing', async ({ page }) => {
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
  await expect(status(page)).toHaveText('Text exported');
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
