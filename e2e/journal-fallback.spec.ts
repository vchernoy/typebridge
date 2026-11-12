import { expect, test } from '@playwright/test';
import { documentAction, selectDocument, setAutosave } from './settings-helpers';

/** Keys for the emergency localStorage journal (#53 / #37 R2c). */
async function journalKeys(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('typebridge.recovery.v1.')));
}

async function journalPayloads(page: import('@playwright/test').Page): Promise<Array<{ title: string; text: string }>> {
  return page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('typebridge.recovery.v1.'))
    .map(key => {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) as { title: string; text: string } : { title: '', text: '' };
      return { title: parsed.title, text: parsed.text };
    }));
}

test('after the first committed save, normal typing writes no recovery journal (#37 R2c 2d-2)', async ({ page }) => {
  // Fails on old code: every edit writes typebridge.recovery.v1.* while Autosave is on.
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Первая сохранённая');
  await expect(page.locator('#status')).toContainText('Saved locally');
  // Drop any journal left from the pre-first-save window; exact-version cleanup may already have.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
  });
  await field.press('End');
  await page.keyboard.type(' и ещё');
  await expect(field).toHaveValue('Первая сохранённая и ещё');
  // Give a stray journal write every chance to land.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
  expect(await journalKeys(page)).toEqual([]);
});

test('before the first save, the journal holds the latest text (#37 R2c 2d-2)', async ({ page }) => {
  // Fails if the journal is never written before a run starts (over-eager skip).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  // Hold full saves so the first commit never starts a change-log run.
  await page.evaluate(() => { (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 60_000; });
  await field.fill('До первого сохранения');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'До первого сохранения' })]),
  );
});

test('when change-log writes fail, the journal holds the latest text and title (#37 R2c 2d-2)', async ({ page }) => {
  // Fails on old code that keeps journaling every keystroke even when the log works, or that
  // does not journal immediately when only the `changes` store rejects (no onUnprotected path).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.locator('#draft-title').fill('Заголовок');
  await field.fill('Основа');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
    const put = IDBObjectStore.prototype.put;
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'changes') throw new Error('change log full');
      return put.apply(this, args);
    };
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'changes') throw new Error('change log full');
      return add.apply(this, args);
    };
  });
  await page.locator('#draft-title').fill('Новое имя');
  await field.click();
  await field.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: 'Новое имя', text: 'Основа!' })]),
  );
});

test('when all IndexedDB writes fail, the journal still holds the unsaved edit (#37 R2c 2d-2)', async ({ page }) => {
  // Same meaning as today's recovery suite: a total IDB failure still journals (fails if the
  // gate skips journaling whenever a run once existed, ignoring IndexedDB unusable / failed appends).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Оригинал');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
    IDBObjectStore.prototype.put = function () { throw new Error('storage dead'); };
    IDBObjectStore.prototype.add = function () { throw new Error('storage dead'); };
  });
  await field.fill('Несохранённое');
  await expect(page.locator('#status')).toContainText('Save failed');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Несохранённое' })]),
  );
});

test('a journal written while a save is held is cleared once the change log protects again (#254)', async ({ page }) => {
  // Fails if protected journalEdit leaves this tab's superseded working journal forever (#254 Claude P2).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { __typebridgeDelayAfterUpToMs: number }).__typebridgeDelayAfterUpToMs = 1500;
  });
  await field.fill('Текст1');
  await expect(page.locator('#status')).toContainText('Saving');
  // While the first save holds an anchor, type newer text so the journal advances past the commit.
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Текст1' })]),
  );
  await field.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Текст1!' })]),
  );
  await expect(page.locator('#status')).toContainText('Saved locally');
  // Protected typing must clear the superseded journal once the queue is idle.
  await field.press('End');
  await page.keyboard.type('?');
  await expect.poll(() => journalKeys(page)).toEqual([]);
  await expect(field).toHaveValue('Текст1!?');
});

test('after a later change-log failure the journal is written again (#254)', async ({ page }) => {
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Основа');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
    const put = IDBObjectStore.prototype.put;
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'changes') throw new Error('change log full');
      return put.apply(this, args);
    };
    IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['add']>) {
      if (this.name === 'changes') throw new Error('change log full');
      return add.apply(this, args);
    };
  });
  await field.press('End');
  await page.keyboard.type('!');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Основа!' })]),
  );
});

test('after Delete saved copy, Autosave-on typing journals until a new save commits (#254)', async ({ page }) => {
  // Fails if protects() stays true after deleteStoredDraft removed the durable base (#254 Codex P1).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('Сохранённая база');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await field.press('End');
  await page.keyboard.type('!');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.v1.'))) localStorage.removeItem(key);
  });
  expect(await journalKeys(page)).toEqual([]);

  await setAutosave(page, false, 'delete');
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');
  // Turn Autosave back on with no edit yet, then hold the ensuing full save.
  await page.evaluate(() => {
    (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 60_000;
  });
  await setAutosave(page, true);
  await field.press('End');
  await page.keyboard.type('?');
  await expect.poll(() => journalPayloads(page)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: 'Сохранённая база!?' })]),
  );
});

test('a stale journal warning clears once the change log protects edits (#37 R2c 2d-2)', async ({ page }) => {
  // Fails if the protected path returns without clearing journalWarning (#254 Codex P2).
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as unknown as { __typebridgeRestoreSetItem?: () => void }).__typebridgeRestoreSetItem = () => {
      Storage.prototype.setItem = original;
    };
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('typebridge.recovery.v1.')) throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await field.fill('Пока без журнала');
  await expect(page.getByRole('alert').filter({ hasText: 'Emergency backup unavailable' })).toBeVisible();
  await expect(page.locator('#status')).toContainText('Saved locally');
  await page.evaluate(() => {
    (window as unknown as { __typebridgeRestoreSetItem?: () => void }).__typebridgeRestoreSetItem?.();
  });
  await field.press('End');
  await page.keyboard.type('!');
  await expect(page.getByRole('alert').filter({ hasText: 'Emergency backup unavailable' })).toHaveCount(0);
});

test('a transient journal read warning clears after a successful retry (#254)', async ({ page }) => {
  // Fails if renderRecovery leaves journalWarningKind=read after listRecovery succeeds (#254 Codex P2).
  test.setTimeout(30_000);
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await page.evaluate(() => {
    // A foreign journal key so listRecovery's storage.key() runs and can throw outside its per-item try.
    localStorage.setItem('typebridge.recovery.v1.other.doc', JSON.stringify({
      token: 'tok', tab: 'other', documentId: 'doc', revision: 0, timestamp: Date.now(),
      title: 'Foreign', text: 'x',
    }));
    const original = Storage.prototype.key;
    const hook = window as unknown as { __typebridgeFailRecoveryKey?: boolean; __typebridgeRestoreKey?: () => void };
    hook.__typebridgeFailRecoveryKey = true;
    hook.__typebridgeRestoreKey = () => {
      hook.__typebridgeFailRecoveryKey = false;
      Storage.prototype.key = original;
    };
    Storage.prototype.key = function (index) {
      const key = original.call(this, index);
      if (hook.__typebridgeFailRecoveryKey && key?.startsWith('typebridge.recovery.v1.')) {
        throw new DOMException('blocked', 'UnknownError');
      }
      return key;
    };
  });
  // Same-tab storage listener queues renderRecovery (~1.2s); 5s poll is a backup.
  await page.evaluate(() => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'typebridge.recovery.v1.other.doc',
      newValue: 'changed',
      storageArea: localStorage,
    }));
  });
  const readAlert = page.getByRole('alert').filter({ hasText: 'Emergency backups cannot be read' });
  await expect(readAlert).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    (window as unknown as { __typebridgeRestoreKey?: () => void }).__typebridgeRestoreKey?.();
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'typebridge.recovery.v1.other.doc',
      newValue: null,
      storageArea: localStorage,
    }));
  });
  await expect(readAlert).toHaveCount(0, { timeout: 15_000 });
});

test('switch discard clears change-log so salvage cannot revive (#254)', async ({ page }) => {
  // Fails if switchDraft consent never calls discardUnsavedRecovery (#254 Codex P1).
  test.setTimeout(60_000);
  await page.goto('/editor.html');
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill('First committed');
  await expect(page.locator('#status')).toContainText('Saved locally');
  await field.press('End');
  await page.keyboard.type(' with log');
  await expect(page.locator('#status')).toContainText('Saved locally');
  const firstDocId = await page.locator('#drafts option:checked').getAttribute('value');
  expect(firstDocId).toBeTruthy();

  await setAutosave(page, false, 'keep');
  await field.fill('Private after keep saved copy');
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');

  await documentAction(page, '#new-draft');
  const dialog = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(field).toHaveValue('');

  await selectDocument(page, firstDocId!);
  await expect(page.locator('#status')).not.toContainText('Recovered unsaved text');
  await expect(page.getByRole('button', { name: /Recover / })).toHaveCount(0);
  await expect(field).not.toHaveValue('Private after keep saved copy');
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
});
