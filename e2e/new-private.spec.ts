import { expect, test, type Page } from '@playwright/test';
import { confirmPrivateSavedCopy, answerNextConfirmation, documentAction, openDocuments, openFind, setAutosave, setPrivateSession, setHostAutosave } from './settings-helpers';

async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toBeEnabled();
}
async function traces(page: Page) {
  return page.evaluate(() => new Promise<{ documents: unknown[]; changes: unknown[]; owners: unknown[]; metadata: string }>((resolve, reject) => {
    const request = indexedDB.open('typebridge'); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['documents', 'changes', 'editOwnership']);
      const documents = tx.objectStore('documents').getAll(), changes = tx.objectStore('changes').getAll(), owners = tx.objectStore('editOwnership').getAll();
      tx.oncomplete = () => { db.close(); resolve({ documents: documents.result, changes: changes.result, owners: owners.result,
        metadata: JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }) }); };
      tx.onerror = () => reject(tx.error);
    };
  }));
}
async function noTrace(page: Page, id: string) {
  const data = await traces(page);
  expect(data.documents).toEqual([]); expect(data.changes).toEqual([]); expect(data.owners).toEqual([]);
  expect(data.metadata).not.toContain(id); expect(data.metadata).not.toContain('PRIVATE CANARY');
}

for (const global of [true, false]) {
  test(`new ${global ? 'session' : 'document'} private document leaves no trace and can later save (#257 step 3)`, async ({ page, context }) => {
    page.on('dialog', dialog => dialog.accept());
    await context.addInitScript(() => {
      const post = BroadcastChannel.prototype.postMessage;
      (window as unknown as { sent: unknown[] }).sent = [];
      BroadcastChannel.prototype.postMessage = function (value) {
        (window as unknown as { sent: unknown[] }).sent.push(value); return post.call(this, value);
      };
    });
    await page.goto('/editor.html'); await ready(page);
    if (global) {
      await setPrivateSession(page, true);
      const previousId = await page.locator('#drafts').inputValue();
      await documentAction(page, '#new-draft');
      await expect.poll(() => page.locator('#drafts').inputValue()).not.toBe(previousId);
    } else await setAutosave(page, false);
    const id = await page.locator('#drafts').inputValue();
    await page.locator('#editor').fill('PRIVATE CANARY body');
    await page.locator('#draft-title').fill('PRIVATE CANARY title');
    await openFind(page); await page.locator('#find-text').fill('PRIVATE CANARY find');
    await page.locator('#replace-text').fill('PRIVATE CANARY replace');
    await page.locator('#editor').evaluate(field => { field.scrollTop = 12; field.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(700); // Cross autosave and position debounce boundaries.
    await noTrace(page, id);
    expect(await page.evaluate(async docId => (await navigator.locks.query()).held?.some(lock => lock.name?.includes(docId)), id)).toBe(false);
    expect(await page.evaluate(() => JSON.stringify((window as unknown as { sent: unknown[] }).sent))).not.toContain(id);
    const other = await context.newPage(); await other.goto('/editor.html'); await ready(other);
    await openDocuments(other);
    expect(await other.locator('#drafts').textContent()).not.toContain('PRIVATE CANARY');
    expect(await other.locator('#drafts option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).not.toContain(id);
    await other.close();
    // An explicit opt-in saves the in-memory fields and starts normal metadata recording.
    if (global) await setPrivateSession(page, false); else await setAutosave(page, true);
    await expect(page.locator('#save-indicator')).toHaveText('Saved');
    await expect.poll(async () => (await traces(page)).documents.length).toBe(1);
    const saved = await traces(page);
    expect(saved.owners.length).toBe(1); expect(saved.metadata).toContain(id);
    await page.locator('#editor').click(); await page.locator('#editor').press('ArrowLeft');
    await expect.poll(() => page.evaluate(docId => Object.keys(sessionStorage).some(key => key.startsWith('typebridge.writingPosition.v1.') && key.endsWith(docId)), id)).toBe(true);
  });
}

test('closing and reopening a new private document never recovers it (#257 step 3)', async ({ page, context }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/editor.html'); await ready(page); await setPrivateSession(page, true);
  const id = await page.locator('#drafts').inputValue();
  await page.locator('#editor').fill('PRIVATE CANARY lost on reload');
  await page.locator('#draft-title').fill('PRIVATE CANARY title');
  await noTrace(page, id);
  await page.reload(); await ready(page);
  await expect(page.locator('#editor')).toHaveValue('');
  expect(await page.locator('#drafts').inputValue()).not.toBe(id);
  await expect(page.getByRole('region', { name: 'Recover unsaved documents' })).toBeHidden();
  await page.close();
  const reopened = await context.newPage(); await reopened.goto('/editor.html'); await ready(reopened);
  await expect(reopened.locator('#editor')).toHaveValue('');
  expect((await traces(reopened)).documents).toEqual([]);
});

test('host layout omits a new private document and reload opens a fresh one (#257 step 3)', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/'); await expect(page.locator('iframe.host-editor')).toHaveCount(1);
  const frame = page.frameLocator('iframe.host-editor').first();
  await expect(frame.locator('#editor')).toBeEnabled();
  await frame.locator('#editor').fill('Unrelated saved document');
  await expect(frame.locator('#save-indicator')).toHaveText('Saved');
  const savedId = await frame.locator('#drafts').inputValue();
  await setHostAutosave(page, false);
  await frame.locator('#doc-menu-open').click(); await frame.locator('#new-draft').click();
  await expect.poll(() => frame.locator('#drafts').inputValue()).not.toBe(savedId);
  const id = await frame.locator('#drafts').inputValue();
  await frame.locator('#editor').fill('PRIVATE CANARY host body');
  const title = page.locator('.host-window-title').first(); await title.fill('PRIVATE CANARY host title');
  await frame.locator('#editor').click();
  await expect.poll(async () => (await traces(page)).metadata.includes(id)).toBe(false);
  const data = await traces(page);
  expect(data.documents).toHaveLength(1);
  expect(JSON.stringify(data)).not.toContain(id); expect(JSON.stringify(data)).not.toContain('PRIVATE CANARY');
  const layout = await page.evaluate(() => JSON.parse(localStorage.getItem('typebridge.host.windows.v1') ?? '{}'));
  expect(JSON.stringify(layout)).not.toContain(id); expect(JSON.stringify(layout)).not.toContain('PRIVATE CANARY');
  await page.reload();
  await expect(page.locator('iframe.host-editor')).toHaveCount(1);
  const next = page.frameLocator('iframe.host-editor').first();
  await expect(next.locator('#editor')).toBeEnabled();
  await expect(next.locator('#editor')).toHaveValue('');
  expect(await next.locator('#drafts').inputValue()).not.toBe(id);
  expect(await next.locator('#drafts').inputValue()).not.toBe(savedId);
});

test('unchecking Autosave before the first save drops preliminary hints and backups (#257 step 3)', async ({ page }) => {
  await page.goto('/editor.html'); await ready(page);
  await page.evaluate(() => { (window as unknown as { __typebridgeDelayAfterUpToMs: number }).__typebridgeDelayAfterUpToMs = 1500; });
  const id = await page.locator('#drafts').inputValue();
  await page.locator('#editor').fill('PRIVATE CANARY before first save');
  // Let the first save prepare its snapshot, while holding it before the actual commit.
  await page.waitForTimeout(700);
  await setAutosave(page, false);
  await page.waitForTimeout(1800);
  await noTrace(page, id);
  await expect(page.locator('#editor')).toHaveValue('PRIVATE CANARY before first save');
});

test('explicit Import saves normally during a private session without storing the private document (#257 step 3)', async ({ page }) => {
  await page.goto('/editor.html'); await ready(page); await setPrivateSession(page, true);
  const id = await page.locator('#drafts').inputValue();
  const confirmation = answerNextConfirmation(page, true);
  await page.locator('#import-file').setInputFiles({ name: 'explicit.txt', mimeType: 'text/plain', buffer: Buffer.from('Explicit import') });
  await confirmation;
  await expect(page.locator('#editor')).toHaveValue('Explicit import');
  const data = await traces(page);
  expect(data.documents).toHaveLength(1); expect(JSON.stringify(data.documents)).toContain('Explicit import');
  expect(JSON.stringify(data)).not.toContain(id);
});

for (const choice of ['keep', 'delete', 'abort'] as const) {
  test(`privacy reconciles the first transaction already started: ${choice} (#268 P0)`, async ({ page, context }) => {
    page.on('dialog', dialog => dialog.accept());
    await page.goto('/editor.html'); await ready(page);
    const id = await page.locator('#drafts').inputValue();
    const other = await context.newPage(); await other.goto('/editor.html?mode=view');
    await expect(other.locator('#editor')).toBeEnabled();
    await page.evaluate(() => {
      const win = window as unknown as { heldFirst: boolean; releaseFirst: (abort: boolean) => void };
      const put = IDBObjectStore.prototype.put;
      let intercepted = false;
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
        const req = put.apply(this, args);
        if (this.name === 'documents' && !intercepted) {
          intercepted = true;
          let hold = true;
          win.releaseFirst = abort => { hold = false; if (abort) this.transaction.abort(); };
          req.addEventListener('success', () => {
            win.heldFirst = true;
            const keepAlive = (): void => {
              if (hold) this.get((args[0] as { id: string }).id).addEventListener('success', keepAlive);
            };
            keepAlive();
          });
        }
        return req;
      };
    });
    await page.locator('#editor').fill('Before transaction privacy');
    await page.locator('#draft-title').fill('Before title');
    await openFind(page); await page.locator('#find-text').fill('Before find');
    await page.locator('#replace-text').fill('Before replace');
    await expect.poll(() => page.evaluate(() => (window as unknown as { heldFirst: boolean }).heldFirst)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    expect(await page.evaluate(() => Object.keys(sessionStorage).some(key => key.startsWith('typebridge.pendingDraft.v1')))).toBe(true);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('typebridge.recovery.v1.')))).toBe(true);
    await page.locator('#autosave').uncheck();
    await expect(page.locator('#private-marker')).toBeVisible();
    await page.locator('#editor').fill('PRIVATE CANARY after transaction began');
    await page.locator('#draft-title').fill('PRIVATE CANARY title');
    await page.locator('#find-text').fill('PRIVATE CANARY find');
    await page.locator('#replace-text').fill('PRIVATE CANARY replace');
    await page.evaluate(abort => (window as unknown as { releaseFirst: (abort: boolean) => void }).releaseFirst(abort), choice === 'abort');
    const dialog = page.getByRole('dialog', { name: 'Delete the saved copy?' });
    if (choice !== 'abort') {
      await expect(dialog).toBeVisible();
      // The original saved signal makes the row visible; Delete must later remove it via its signal.
      await expect(other.locator(`#drafts option[value="${id}"]`)).toHaveCount(1);
      await confirmPrivateSavedCopy(page, choice);
    } else await expect(dialog).toBeHidden();
    await expect(page.locator('#editor')).toBeEditable();
    await expect(page.locator('#editor')).toHaveValue('PRIVATE CANARY after transaction began');
    if (choice === 'keep') {
      const data = await traces(page);
      expect(data.documents).toHaveLength(1);
      expect(data.documents[0]).toMatchObject({ id, private: true, text: 'Before transaction privacy', title: 'Before title', find: 'Before find', replace: 'Before replace' });
      expect(JSON.stringify(data)).not.toContain('PRIVATE CANARY');
      await page.reload(); await ready(page);
      await expect(page.locator('#autosave')).not.toBeChecked();
      await expect(page.locator('#editor')).toHaveValue('Before transaction privacy');
      expect((await traces(page)).documents).toHaveLength(1);
      await expect(page.getByRole('region', { name: 'Recover unsaved documents' })).toBeHidden();
    } else {
      await expect.poll(async () => JSON.stringify(await traces(page)).includes(id)).toBe(false);
      await noTrace(page, id);
      await expect(other.locator(`#drafts option[value="${id}"]`)).toHaveCount(0);
      await page.reload(); await ready(page);
      await expect(page.locator('#editor')).toHaveValue('');
      expect((await traces(page)).documents).toEqual([]);
      await expect(page.getByRole('region', { name: 'Recover unsaved documents' })).toBeHidden();
    }
  });
}
