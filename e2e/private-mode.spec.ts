import { expect, test, type Page } from '@playwright/test';
import { documentAction, fillHostEditor, setAutosave, setPrivateSession } from './settings-helpers';
import { PRIVATE_SWITCH_FLAG_FAILED, PRIVATE_SWITCH_SAVE_FAILED } from '../src/editor/privacy';
import { readStoredDocs } from './storage-helpers';

const status = (page: Page) => page.locator('#status-line');

async function storageSnapshot(page: Page): Promise<{
  docs: Array<{ text: string; title: string; private?: boolean }>;
  changeTexts: string[];
  recovery: string[];
  pending: string | null;
}> {
  return page.evaluate(async () => {
    const docs = await new Promise<Array<{ text: string; title: string; private?: boolean }>>((resolve, reject) => {
      const open = indexedDB.open('typebridge');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const req = db.transaction('documents').objectStore('documents').getAll();
        req.onsuccess = () => { db.close(); resolve(req.result as Array<{ text: string; title: string; private?: boolean }>); };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    });
    const changeTexts = await new Promise<string[]>((resolve, reject) => {
      const open = indexedDB.open('typebridge');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        if (![...db.objectStoreNames].includes('changes')) {
          db.close();
          resolve([]);
          return;
        }
        const req = db.transaction('changes').objectStore('changes').getAll();
        req.onsuccess = () => {
          db.close();
          const rows = req.result as Array<{ text?: string; title?: string }>;
          resolve(rows.flatMap(row => [row.text ?? '', row.title ?? '']).filter(Boolean));
        };
        req.onerror = () => { db.close(); reject(req.error); };
      };
    });
    const recovery: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('typebridge.recovery.v1.')) {
        recovery.push(localStorage.getItem(key) ?? '');
      }
    }
    let pending: string | null = null;
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('typebridge.pendingDraft.v1')) {
        pending = sessionStorage.getItem(key);
        break;
      }
    }
    return { docs, changeTexts, recovery, pending };
  });
}

test('typing while private leaves no post-switch storage trace after reload (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Before private');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Switch title');
  await expect(status(page)).toHaveText('Saved locally');

  await setAutosave(page, false);
  await expect(page.locator('#private-marker')).toBeVisible();

  await page.locator('#editor').fill('Before private SECRET after');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Secret title');
  await expect(status(page)).toHaveText(/Autosave off/);

  // Force a reload-backup opportunity, then reload without discarding UI text first.
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const before = await storageSnapshot(page);
  expect(before.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(before.docs.every(doc => doc.title !== 'Secret title')).toBe(true);
  expect(before.changeTexts.every(text => !text.includes('SECRET') && text !== 'Secret title')).toBe(true);
  expect(before.recovery.every(raw => !raw.includes('SECRET') && !raw.includes('Secret title'))).toBe(true);
  expect(before.pending === null || (!before.pending.includes('SECRET') && !before.pending.includes('Secret title'))).toBe(true);
  expect(before.docs.some(doc => doc.private === true && doc.text === 'Before private')).toBe(true);

  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#editor')).toHaveValue('Before private');
  await expect(page.getByRole('textbox', { name: 'Document title' })).toHaveValue('Switch title');
  await expect(page.locator('#autosave')).not.toBeChecked();
  await expect(page.locator('#private-marker')).toBeVisible();
  const after = await storageSnapshot(page);
  expect(after.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(after.docs.every(doc => !(doc.title ?? '').includes('Secret'))).toBe(true);
});

test('private typing during goPrivate keeps the document dirty (#257 P0)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Freeze base');
  await expect(status(page)).toHaveText('Saved locally');

  // Hold the last pre-private save so typing after the switch still happens before dirty is set.
  await page.evaluate(() => {
    (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 1_500;
  });
  const toggling = setAutosave(page, false);
  await expect.poll(() => page.evaluate(() => (document.querySelector('#autosave') as HTMLInputElement).disabled)).toBe(true);
  await page.locator('#editor').press('End');
  // Digits are not transliterated — a stable private-period marker.
  await page.locator('#editor').pressSequentially(' 99');
  await toggling;
  await page.evaluate(() => {
    delete (window as unknown as { __typebridgeDelayPersistMs?: number }).__typebridgeDelayPersistMs;
  });

  await expect(page.locator('#save-indicator')).toHaveText('Not saved');
  const snap = await storageSnapshot(page);
  expect(snap.docs.every(doc => !doc.text.includes('99'))).toBe(true);
  expect(snap.docs.some(doc => doc.private === true && doc.text === 'Freeze base')).toBe(true);

  // Leaving must confirm: dirty was not cleared by comparing against a post-typing revision.
  await documentAction(page, '#new-draft');
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('#editor')).toHaveValue('Freeze base 99');
});

test('going private mid-save does not store text typed after the switch (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Pre switch base');
  await expect(status(page)).toHaveText('Saved locally');

  await page.evaluate(() => {
    (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 2_000;
  });
  await page.locator('#editor').press('End');
  await page.locator('#editor').pressSequentially('!');
  // Debounce starts the held save; then switch private and type secrets while it is still in flight.
  await page.waitForTimeout(400);
  await setAutosave(page, false);
  await page.locator('#editor').press('End');
  await page.locator('#editor').pressSequentially(' SECRET');
  await page.waitForTimeout(2_500);
  await page.evaluate(() => {
    delete (window as unknown as { __typebridgeDelayPersistMs?: number }).__typebridgeDelayPersistMs;
  });

  const snap = await storageSnapshot(page);
  expect(snap.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(snap.changeTexts.every(text => !text.includes('SECRET'))).toBe(true);
  expect(snap.docs.some(doc => doc.private === true)).toBe(true);
  await expect(page.locator('#autosave')).not.toBeChecked();
});

test('global private session blocks writes for a normal document (#257)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Session base');
  await expect(status(page)).toHaveText('Saved locally');
  await setPrivateSession(page, true);
  await expect(page.locator('#autosave')).toBeDisabled();
  await page.locator('#editor').fill('Session base SECRET');
  await expect(status(page)).toHaveText(/Autosave off/);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const snap = await storageSnapshot(page);
  expect(snap.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(snap.changeTexts.every(text => !text.includes('SECRET'))).toBe(true);
  expect(snap.recovery.every(raw => !raw.includes('SECRET'))).toBe(true);
});

test('global private session last-saves dirty text without private:true (#257 follow-up)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Session keep');
  await expect(status(page)).toHaveText('Saved locally');
  // Hold the ordinary Autosave so DIRTY is still unsaved when the session turns on.
  await page.evaluate(() => {
    (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 8_000;
  });
  await page.locator('#editor').fill('Session keep DIRTY');
  await expect(page.locator('#save-indicator')).toHaveText('Saving…');
  await setPrivateSession(page, true);
  // Drop the hold so the last pre-session save (and any awaited in-flight persist) can finish.
  await page.evaluate(() => {
    delete (window as unknown as { __typebridgeDelayPersistMs?: number }).__typebridgeDelayPersistMs;
  });
  await expect(page.locator('#autosave')).toBeDisabled({ timeout: 15_000 });
  await expect.poll(async () => {
    const docs = await readStoredDocs(page);
    return docs.some(doc => doc.text === 'Session keep DIRTY' && !(doc as { private?: boolean }).private);
  }, { timeout: 15_000 }).toBe(true);
  const docs = await readStoredDocs(page);
  expect(docs.every(doc => !(doc as { private?: boolean }).private)).toBe(true);
  await page.locator('#editor').fill('Session keep DIRTY SECRET');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const snap = await storageSnapshot(page);
  expect(snap.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(snap.docs.some(doc => doc.text === 'Session keep DIRTY')).toBe(true);
});

test('Delete saved copy removes the row and leaves the document private in memory (#257 follow-up)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Keep or delete');
  await page.getByRole('textbox', { name: 'Document title' }).fill('Delete me');
  await expect(status(page)).toHaveText('Saved locally');
  await setAutosave(page, false, 'delete');
  await expect(page.locator('#private-marker')).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('Keep or delete');
  await expect.poll(async () => (await readStoredDocs(page)).length).toBe(0);
  const snap = await storageSnapshot(page);
  expect(snap.docs).toHaveLength(0);
  expect(snap.changeTexts).toHaveLength(0);
  // Still private in memory: leaving asks to discard.
  await documentAction(page, '#new-draft');
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('#editor')).toHaveValue('Keep or delete');
});

test('last-save failure then flag-only success warns when the change log did not cover (#257 follow-up)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Flag only base');
  await expect(status(page)).toHaveText('Saved locally');
  // Fail the first documents put (full last save), allow the flag-only put, and block change-log writes
  // so protects() is false and the SAVE_FAILED warning is shown.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    let documentFailsLeft = 1;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'changes') {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      if (this.name === 'documents' && documentFailsLeft > 0) {
        documentFailsLeft -= 1;
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
  await page.locator('#editor').press('End');
  await page.locator('#editor').pressSequentially(' dirty');
  await setAutosave(page, false, 'keep');
  await expect(status(page)).toContainText(PRIVATE_SWITCH_SAVE_FAILED.replace(/\.$/, ''));
  await expect.poll(async () => {
    const docs = await storageSnapshot(page);
    return docs.docs.some(doc => doc.private === true && doc.text === 'Flag only base');
  }).toBe(true);
});

test('last-save and flag-only both failing warn that the document may not reopen private (#257 follow-up)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Both fail base');
  await expect(status(page)).toHaveText('Saved locally');
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    };
    (window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = put;
    };
  });
  await page.locator('#editor').press('End');
  await page.locator('#editor').pressSequentially(' dirty');
  await setAutosave(page, false, 'keep');
  await expect(status(page)).toContainText(PRIVATE_SWITCH_FLAG_FAILED.replace(/\.$/, ''));
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
});

test('private and normal documents stay independent across two host windows (#257 follow-up)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  await page.goto('/');
  const a = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(a.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(a, 'Private window text');
  await expect(a.locator('#save-indicator')).toHaveText('Saved');
  await a.locator('#autosave').uncheck();
  const dialogA = a.getByRole('dialog', { name: 'Delete the saved copy?' });
  await expect(dialogA).toBeVisible({ timeout: 15_000 });
  await dialogA.getByRole('button', { name: 'Keep saved copy' }).click();
  await expect(a.locator('#private-marker')).toBeVisible();
  await fillHostEditor(a, 'Private window text SECRET');

  await page.getByRole('button', { name: 'New window' }).click();
  const b = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(b.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  // Secondary window starts on a fresh document (not the private one).
  await fillHostEditor(b, 'Normal window text');
  await expect(b.locator('#save-indicator')).toHaveText('Saved');
  await expect(b.locator('#autosave')).toBeChecked();
  await expect(b.locator('#private-marker')).toBeHidden();

  await page.evaluate(() => {
    for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe.host-editor')) {
      frame.contentWindow?.dispatchEvent(new Event('pagehide'));
    }
  });
  const snap = await storageSnapshot(page);
  expect(snap.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(snap.docs.some(doc => doc.private === true && doc.text === 'Private window text')).toBe(true);
  expect(snap.docs.some(doc => doc.text === 'Normal window text' && !doc.private)).toBe(true);
});

test('a private document reopens private in a second host window (#257 follow-up)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('typebridge.host.layoutMode.v1', 'free'));
  await page.goto('/');
  const a = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(a.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(a, 'Reopen private body');
  await expect(a.locator('#save-indicator')).toHaveText('Saved');
  await a.locator('#autosave').uncheck();
  const dialog = a.getByRole('dialog', { name: 'Delete the saved copy?' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Keep saved copy' }).click();
  await expect(a.locator('#private-marker')).toBeVisible();
  const docId = await a.locator('#drafts').inputValue();

  await page.getByRole('button', { name: 'New window' }).click();
  const b = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(b.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await b.getByRole('button', { name: 'Documents', exact: true }).click();
  await b.locator('#drafts').dispatchEvent('pointerdown');
  await b.locator('#drafts').selectOption(docId);
  await expect(b.locator('#editor')).toHaveValue('Reopen private body');
  await expect(b.locator('#autosave')).not.toBeChecked();
  await expect(b.locator('#private-marker')).toBeVisible();
  await fillHostEditor(b, 'Reopen private body SECRET');
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="w2"] iframe');
    frame?.contentWindow?.dispatchEvent(new Event('pagehide'));
  });
  const snap = await storageSnapshot(page);
  expect(snap.docs.every(doc => !doc.text.includes('SECRET'))).toBe(true);
  expect(snap.docs.some(doc => doc.private === true && doc.text === 'Reopen private body')).toBe(true);
});
