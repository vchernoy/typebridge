import { expect, test, type Page } from '@playwright/test';
import { confirmPrivateSavedCopy, documentAction, selectDocument, setAutosave } from './settings-helpers';
import { claimFenceElsewhere, heldEditLocks, readOwnership, readStoredDocs, writeForeignRevision } from './storage-helpers';

// Single editing owner per document (#159 W4): Web Lock + IndexedDB fence.

const role = (page: Page) => page.locator('html');
const instanceOf = (page: Page) => page.locator('html').getAttribute('data-instance-id');
const LOST = 'Another TypeBridge window is now editing this document, so this window is read-only.';
const UNSAVED_HERE = 'Your unsaved changes here were not saved; copy or export them to keep them.';

async function saveAs(page: Page, text: string): Promise<string> {
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill(text);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === text)).toBe(true);
  return (await readStoredDocs(page)).find(row => row.text === text)!.id;
}

async function openOrdinary(page: Page): Promise<void> {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(role(page)).toHaveAttribute('data-role', /^(editor|reader)$/);
}

/** Ask a read-only window to try again, the way focusing its text does. */
async function nudge(page: Page): Promise<void> {
  await page.locator('#editor').dispatchEvent('focus');
}

test('two ordinary tabs on one document: click and type hand off editing', async ({ page, context }) => {
  test.setTimeout(90_000);
  await openOrdinary(page);
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  const id = await saveAs(page, 'Первый текст');

  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  const field = other.locator('#editor');
  await expect(field).toHaveValue('Первый текст');
  await expect(field).toHaveJSProperty('readOnly', true);
  await expect(other.locator('#draft-title')).toHaveJSProperty('readOnly', true);
  // A clean reader looks like a normal editor: no Read-only badge, notice or status.
  await expect(other.locator('#ownership-notice')).toBeHidden();
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  await expect(other.locator('#status')).toHaveText('Saved locally');
  // Document-changing controls stay enabled; using one takes over editing first.
  for (const control of ['#delete-draft', '#clear', '#convert-cyrillic']) {
    await expect(other.locator(control)).toBeEnabled();
  }
  // Undo/Redo follow the document's history (they take over editing too); Autosave stays locked.
  await expect(other.locator('#autosave')).toBeDisabled();
  await expect(other.locator('#export-txt')).toBeEnabled();
  await expect(other.locator('#new-draft')).toBeEnabled();

  // #175 step 4: a clean Autosave-on owner yields on click + type; buffered keys apply.
  await field.click();
  await field.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(el.value.length, el.value.length);
  });
  await other.keyboard.type('!');
  await expect(role(other)).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
  await expect(field).toHaveValue('Первый текст!');
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#editor')).toHaveValue('Первый текст');
  const record = await readOwnership(other, id);
  expect(record?.ownerInstanceId).toBe(await instanceOf(other));

  // The former reader can still start its own document, which it owns.
  await documentAction(other, '#new-draft');
  await expect(role(other)).toHaveAttribute('data-role', 'editor');
  await expect(other.locator('#ownership-notice')).toBeHidden();
  await other.locator('#editor').fill('Своё');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
});

test('Autosave-off dirty owner refuses cross-tab handoff with Edit here', async ({ page, context }) => {
  test.setTimeout(90_000);
  await openOrdinary(page);
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  const id = await saveAs(page, 'Частный текст');
  await setAutosave(page, false);
  await page.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.value = `${el.value} keep`;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');

  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('Частный текст');

  await other.locator('#editor').click();
  await other.keyboard.type('!');
  await expect(other.locator('#edit-here-bar')).toBeVisible({ timeout: 10_000 });
  await expect(other.locator('#edit-here-warning')).toContainText('unsaved or private');
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('Частный текст');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toHaveValue('Частный текст keep');
  const record = await readOwnership(page, id);
  expect(record?.ownerInstanceId).toBe(await instanceOf(page));
});

test('after the owner closes, another window can take over editing', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Исходник');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');

  await page.close();
  await expect.poll(async () => { await nudge(other); return role(other).getAttribute('data-role'); }).toBe('editor');
  await expect(other.locator('#ownership-notice')).toBeHidden();
  await expect(other.locator('#status')).toContainText('Saved locally');
  await other.locator('#editor').fill('Исходник, продолжение');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  const rows = await readStoredDocs(other);
  expect(rows.map(row => [row.id, row.text])).toEqual([[id, 'Исходник, продолжение']]);
  expect((await readOwnership(other, id))?.ownerInstanceId).toBe(await instanceOf(other));
});

test('switching documents releases ownership of the one left', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Документ А');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');

  await documentAction(page, '#new-draft');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await expect.poll(async () => (await readOwnership(page, id))?.ownerInstanceId).toBe('');
  await expect.poll(async () => { await nudge(other); return role(other).getAttribute('data-role'); }).toBe('editor');
  await other.locator('#editor').fill('Документ А — правка');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');

  // Switching back now opens it read-only in the first window.
  await selectDocument(page, id);
  await expect(page.locator('#editor')).toHaveValue('Документ А — правка');
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
});

test('a stale owner that wakes after another window claimed the fence cannot write', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await openOrdinary(page);
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await page.clock.runFor(400);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id = (await readStoredDocs(page))[0].id;

  // While this window "slept", another window claimed the document's fence.
  await claimFenceElsewhere(page, id);
  await field.fill('Сохранено и дописано 🙂');
  await page.clock.runFor(400);

  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#ownership-notice')).toContainText(LOST);
  await expect(page.locator('#ownership-notice')).toContainText(UNSAVED_HERE);
  await expect(page.locator('#status')).toContainText('Changes here are not saved — another window is editing this document.');
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');
  // Text stays in memory for copy/export; nothing reached storage, not even a conflict copy.
  await expect(field).toHaveValue('Сохранено и дописано 🙂');
  await expect(field).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#export-txt')).toBeEnabled();
  await expect(page.locator('#copy')).toBeEnabled();
  expect((await readStoredDocs(page)).map(row => row.text)).toEqual(['Сохранено']);
  expect((await readOwnership(page, id))?.ownerInstanceId).toBe('another-window');
});

test('a lock taken from the owner makes it read-only before it writes', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Текст владельца');
  const intruder = await context.newPage();
  await intruder.goto('/icon-192.png');
  await intruder.evaluate(name => new Promise<void>(resolve => {
    void navigator.locks.request(name, { steal: true }, () => { resolve(); return new Promise(() => undefined); });
  }), `typebridge-edit-owner:${id}`);
  await claimFenceElsewhere(intruder, id);

  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#ownership-notice')).toContainText(LOST);
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
  // Retrying cannot win while the lock is held elsewhere.
  await nudge(page);
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  expect((await readStoredDocs(page)).map(row => row.text)).toEqual(['Текст владельца']);
});

test('without Web Locks the window stays read-only and explains why', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  });
  await openOrdinary(page);
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#ownership-notice')).toContainText('Editing needs a browser with Web Locks');
  await expect(page.locator('#status')).toHaveText('Read-only — this browser cannot coordinate editing between windows.');
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
  await page.locator('#editor').click();
  await page.keyboard.type('privet');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(page.locator('#copy')).toBeEnabled();
  await expect(page.locator('#export-txt')).toBeEnabled();
  // A new document is not editable either, and nothing is written.
  await documentAction(page, '#new-draft');
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await nudge(page);
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  expect(await readStoredDocs(page)).toEqual([]);
});

test('a comparison viewer never acquires editing ownership', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Для сравнения');
  const viewer = await context.newPage();
  await viewer.goto(`/editor.html?doc=${id}&mode=view`);
  await expect(viewer.locator('#editor')).toHaveValue('Для сравнения');
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  expect(await heldEditLocks(viewer)).toEqual([`typebridge-edit-owner:${id}`]);

  await page.close();
  await expect.poll(() => heldEditLocks(viewer)).toEqual([]);
  // Focus and visibility rereads in the viewer must not claim anything.
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await viewer.locator('#editor').dispatchEvent('focus');
  expect(await heldEditLocks(viewer)).toEqual([]);
  const viewerInstance = await instanceOf(viewer);
  expect((await readOwnership(viewer, id))?.ownerInstanceId).not.toBe(viewerInstance);

  const next = await context.newPage();
  await openOrdinary(next);
  await expect(role(next)).toHaveAttribute('data-role', 'editor');
  await expect(next.locator('#editor')).toHaveValue('Для сравнения');
});

test('windows opening the same document at once elect exactly one editor', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Гонка');
  await page.close();
  const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  await Promise.all(pages.map(p => p.goto('/editor.html')));
  for (const p of pages) await expect(role(p)).toHaveAttribute('data-role', /^(editor|reader)$/);
  const roles = await Promise.all(pages.map(p => role(p).getAttribute('data-role')));
  expect(roles.filter(r => r === 'editor')).toHaveLength(1);
  const editor = pages[roles.indexOf('editor')];
  expect((await readOwnership(editor, id))?.ownerInstanceId).toBe(await instanceOf(editor));
  expect(await heldEditLocks(editor)).toEqual([`typebridge-edit-owner:${id}`]);
});

test('retry does not claim ownership after the document was deleted elsewhere', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'К удалению');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('К удалению');

  await documentAction(page, '#delete-draft');
  await page.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete document' }).click();
  await expect(page.locator('#status')).toContainText('Document deleted');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.id === id)).toBe(false);

  // Owner already moved on; the reader must not resurrect the deleted id by claiming the free lock.
  await expect.poll(async () => {
    await nudge(other);
    return other.locator('#deleted-bar').isVisible();
  }).toBe(true);
  await expect(other.locator('#deleted-bar')).toContainText('deleted in another window');
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#status')).not.toContainText('You can edit this document in this window now.');
  expect((await readOwnership(other, id))?.ownerInstanceId ?? '').not.toBe(await instanceOf(other));
  expect((await readStoredDocs(other)).map(row => row.id)).not.toContain(id);
});

test('a clean reader adopts the latest save after the owner edits and closes (#257)', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'original text');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('original text');
  await expect.poll(async () => (await readStoredDocs(other)).find(row => row.id === id)?.revision).toBe(1);

  await page.locator('#editor').fill('updated for the reader');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).find(row => row.id === id)?.text).toBe('updated for the reader');

  await page.close();
  await expect.poll(async () => {
    await nudge(other);
    return role(other).getAttribute('data-role');
  }).toBe('editor');
  await expect(other.locator('#editor')).toHaveValue('updated for the reader');
  await other.locator('#editor').fill('reader continues');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  expect((await readStoredDocs(other)).map(row => [row.id, row.text])).toEqual([[id, 'reader continues']]);
});

test('document switch waits for the private-toggle gate before changing documents (#257)', async ({ page }) => {
  await openOrdinary(page);
  const first = await saveAs(page, 'first saved copy');
  await documentAction(page, '#new-draft');
  await saveAs(page, 'second saved copy');
  // Hold the last pre-private save so the toggle gate stays active through save + Keep/Delete.
  await page.evaluate(() => {
    (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 2_000;
  });
  // Playwright's uncheck() resolves when the box flips at the start of goPrivate — not when
  // the gate ends — so do not treat it as "toggle finished" (#260 Keep/Delete follow-up).
  void page.locator('#autosave').uncheck();
  await expect.poll(() => page.evaluate(() => (document.querySelector('#autosave') as HTMLInputElement).disabled)).toBe(true);
  // Queue a switch while going-private owns the gate; it must not apply until the gate ends.
  const switching = page.evaluate(id => new Promise<void>(resolve => {
    const select = document.querySelector<HTMLSelectElement>('#drafts')!;
    select.value = id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    queueMicrotask(() => resolve());
  }), first);
  await switching;
  await expect(page.locator('#editor')).toHaveValue('second saved copy');
  // Keep/Delete still holds the gate after the delayed last-save until dismissed.
  await expect(page.locator('#editor')).toHaveValue('second saved copy');
  await confirmPrivateSavedCopy(page, 'keep');
  // Queued switch applies to the non-private first doc → Autosave checked again.
  await expect.poll(async () => page.locator('#editor').inputValue()).toBe('first saved copy');
  await expect(page.locator('#autosave')).toBeEnabled();
  await expect(page.locator('#autosave')).toBeChecked();
  await expect.poll(async () => (await readStoredDocs(page)).map(row => row.text).sort()).toEqual([
    'first saved copy',
    'second saved copy',
  ]);
});

test('a database upgrade releases the editing lock so another tab can acquire', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'upgrade me');
  expect(await heldEditLocks(page)).toEqual([`typebridge-edit-owner:${id}`]);

  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      IDBObjectStore.prototype.put = put;
      const db = this.transaction.db;
      const result = put.apply(this, args);
      db.onversionchange?.call(db, new IDBVersionChangeEvent('versionchange', { oldVersion: 2, newVersion: 3 }));
      return result;
    };
  });
  await page.locator('#editor').pressSequentially('!');
  await expect(page.locator('#status')).toContainText('Storage was upgraded in another tab');
  await expect.poll(() => heldEditLocks(page)).toEqual([]);

  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'editor');
  expect(await heldEditLocks(other)).toEqual([`typebridge-edit-owner:${id}`]);
});

test('boot does not own a document deleted during acquire', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'gone at boot');

  const booting = await context.newPage();
  await booting.addInitScript(() => {
    // The app reads this delay as it enters acquisition: mark that moment for the test.
    Object.defineProperty(window, '__typebridgeDelayAcquireMs', {
      configurable: true,
      get() {
        // Only the first (boot) acquisition waits; the fresh document after the miss does not.
        const state = window as Window & { __typebridgeAcquireEntered?: boolean };
        if (state.__typebridgeAcquireEntered) return 0;
        state.__typebridgeAcquireEntered = true;
        return 3_000;
      },
    });
  });
  const booted = booting.goto('/editor.html');
  // Delete inside the acquire delay (a fixed sleep let it land before boot listed the
  // documents, or after it had opened this one).
  await expect.poll(() => booting.evaluate(() => (window as Window & { __typebridgeAcquireEntered?: boolean }).__typebridgeAcquireEntered === true)
    .catch(() => false)).toBe(true);
  await documentAction(page, '#delete-draft');
  await page.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete document' }).click();
  await expect(page.locator('#status')).toContainText('Document deleted');
  // Still acquiring: the boot tab has not opened anything yet.
  await expect(booting.locator('#editor')).toBeDisabled();
  await booted;
  await expect(booting.locator('#editor')).toBeEnabled();
  await expect.poll(async () => (await readStoredDocs(booting)).some(row => row.id === id)).toBe(false);
  expect((await readOwnership(booting, id))?.ownerInstanceId ?? '').not.toBe(await instanceOf(booting));
  // The post-acquire check saw the document gone and started a fresh one.
  await expect(booting.locator('#deleted-bar')).toBeHidden();
  await expect(role(booting)).toHaveAttribute('data-role', 'editor');
  await booting.locator('#editor').fill('fresh after miss');
  await expect(booting.locator('#save-indicator')).toHaveText('Saved');
  expect((await readStoredDocs(booting)).map(row => row.id)).not.toContain(id);
});

test('boot does not open a document deleted before it lists documents', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'gone before boot');
  await documentAction(page, '#delete-draft');
  await page.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete document' }).click();
  await expect(page.locator('#status')).toContainText('Document deleted');

  const booting = await context.newPage();
  await openOrdinary(booting);
  await expect(booting.locator('#deleted-bar')).toBeHidden();
  await expect(role(booting)).toHaveAttribute('data-role', 'editor');
  await booting.locator('#editor').fill('fresh after miss');
  await expect(booting.locator('#save-indicator')).toHaveText('Saved');
  expect((await readStoredDocs(booting)).map(row => row.id)).not.toContain(id);
});

test('upgrade during acquire releases the new lock before it is installed', async ({ page, context }) => {
  await openOrdinary(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      (window as Window & { __typebridgeDb?: IDBDatabase }).__typebridgeDb = this.transaction.db;
      return put.apply(this, args);
    };
  });
  const id = await saveAs(page, 'acquire then upgrade');
  await documentAction(page, '#new-draft');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');

  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayAfterAcquireMs?: number }).__typebridgeDelayAfterAcquireMs = 900;
  });
  const switching = selectDocument(page, id);
  // Post-acquire delay: Web Lock is held but not yet installed as this window's ownership.
  await expect.poll(() => heldEditLocks(page)).toEqual([`typebridge-edit-owner:${id}`]);
  await page.evaluate(() => {
    const db = (window as Window & { __typebridgeDb?: IDBDatabase }).__typebridgeDb!;
    db.onversionchange?.call(db, new IDBVersionChangeEvent('versionchange', { oldVersion: 2, newVersion: 3 }));
  });
  await switching;
  await expect(page.locator('#status')).toContainText('Storage was upgraded in another tab');
  await expect.poll(() => heldEditLocks(page)).toEqual([]);

  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'editor');
  expect((await readOwnership(other, id))?.ownerInstanceId).toBe(await instanceOf(other));
});

test('an editing owner still reconciles a missed newer revision on focus', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
  });
  await openOrdinary(page);
  await saveAs(page, 'Owned text');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await writeForeignRevision(page, { text: 'Foreign newer' });
  await expect(page.locator('#version-notice')).toBeHidden();
  await expect(page.locator('#editor')).toHaveValue('Owned text');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#version-notice')).toBeVisible();
  await expect(page.locator('#version-notice')).toContainText('newer saved version');
  await expect(page.locator('#editor')).toHaveValue('Owned text');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
});

test('focus applies a missed newer revision before taking ownership', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Версия один');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('Версия один');

  // Silent IDB write (no BroadcastChannel) leaves the reader on the old snapshot until focus.
  await writeForeignRevision(page, { text: 'Версия два' }, id);
  await expect(other.locator('#editor')).toHaveValue('Версия один');
  await page.close();
  await expect.poll(async () => heldEditLocks(other)).toEqual([]);

  await expect.poll(async () => {
    await nudge(other);
    return role(other).getAttribute('data-role');
  }).toBe('editor');
  await expect(other.locator('#editor')).toHaveValue('Версия два');
  await expect(other.locator('#ownership-notice')).toBeHidden();
  expect((await readOwnership(other, id))?.ownerInstanceId).toBe(await instanceOf(other));
  await other.locator('#editor').fill('Версия два, правка');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
});

test('typing during delayed delete refresh stays frozen then can dirty after completion', async ({ page }) => {
  await openOrdinary(page);
  await saveAs(page, 'to delete');
  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayRefreshMs?: number }).__typebridgeDelayRefreshMs = 900;
  });
  await documentAction(page, '#delete-draft');
  const dialog = page.getByRole('dialog', { name: 'Delete document?' });
  await expect(dialog).toBeVisible();
  const deleteDone = dialog.getByRole('button', { name: 'Delete document' }).click();
  await expect.poll(async () => page.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.readOnly)).toBe(true);
  const during = await page.locator('#editor').inputValue();
  await page.locator('#undo').click({ force: true });
  await page.locator('#redo').click({ force: true });
  await page.keyboard.type('should-not-apply');
  await page.locator('#convert-cyrillic').click({ force: true });
  await expect(page.locator('#editor')).toHaveValue(during);
  await expect(page.locator('#ownership-notice')).toBeHidden();
  await deleteDone;
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', false);
  await page.locator('#editor').fill('after delete dirty');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'after delete dirty')).toBe(true);
});

test('Undo/Convert/Replace during ownership transfer do not mutate or leak into the target', async ({ page }) => {
  await openOrdinary(page);
  const first = await saveAs(page, 'alpha beta');
  await documentAction(page, '#new-draft');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  const second = await saveAs(page, 'second document');

  await selectDocument(page, first);
  await expect(page.locator('#editor')).toHaveValue('alpha beta');
  await page.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(0, 5);
  });
  await page.locator('#convert-cyrillic').click();
  await expect(page.locator('#editor')).not.toHaveValue('alpha beta');
  const afterConvert = await page.locator('#editor').inputValue();

  // Delay acquire so mutations attempted mid-transfer hit the frozen Editor gates. Slow CI
  // browsers needed more than 800ms for the attempts below, so the switch finished first and
  // Replace then (correctly) edited the opened document; the premise is now asserted.
  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 4_000;
  });
  const switchPromise = selectDocument(page, second);
  await expect.poll(async () => page.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.readOnly)).toBe(true);
  await expect(page.locator('#autosave')).toBeDisabled();
  await page.locator('#undo').click({ force: true });
  await page.locator('#redo').click({ force: true });
  await page.locator('#convert-latin').click({ force: true });
  await page.locator('#find-open').click();
  await page.locator('#find-text').fill('second');
  await page.locator('#replace-text').fill('leaked');
  await page.locator('#replace-one').click({ force: true });
  await page.locator('#replace-all').click({ force: true });
  await page.keyboard.press('ControlOrMeta+z');
  // Every attempt above happened while the transfer was still in progress.
  expect(await page.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.readOnly)).toBe(true);
  await switchPromise;
  await expect(page.locator('#autosave')).toBeEnabled();

  await expect(page.locator('#editor')).toHaveValue('second document');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await selectDocument(page, first);
  await expect(page.locator('#editor')).toHaveValue(afterConvert);
  expect(await page.locator('#editor').inputValue()).not.toContain('leaked');
});
