import { expect, test, type Page } from '@playwright/test';
import { documentAction, openDocuments, openSettings, setPrivateSession } from './settings-helpers';
async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toBeEnabled();
}
async function stored(page: Page) {
  return page.evaluate(() => new Promise<{ rows: Array<{ id: string; text: string }>; all: string }>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onupgradeneeded = () => open.transaction!.abort();
    const metadata = () => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
    open.onerror = () => { if (open.error?.name === 'AbortError') resolve({ rows: [], all: metadata() }); else reject(open.error); };
    open.onsuccess = () => {
      const db = open.result, names = [...db.objectStoreNames];
      if (!names.length) { db.close(); resolve({ rows: [], all: metadata() }); return; }
      const tx = db.transaction(names), requests = names.map(name => tx.objectStore(name).getAll());
      tx.oncomplete = () => {
        const result = Object.fromEntries(names.map((name, i) => [name, requests[i].result]));
        db.close(); resolve({ rows: result.documents ?? [], all: JSON.stringify(result) + metadata() });
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
}
async function save(page: Page, text: string) {
  await page.locator('#editor').fill(text); await expect(page.locator('#save-indicator')).toHaveText('Saved');
  return page.locator('#drafts').inputValue();
}
async function clearAll(page: Page, accept = true) {
  await openSettings(page); await page.locator('#clear-local-data').click();
  const dialog = page.getByRole('dialog', { name: 'Clear local data?' }); await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('cannot be undone');
  await dialog.getByRole('button', { name: accept ? 'Clear local data' : 'Cancel', exact: true }).click();
}

test('clear-all removes content and backups across tabs, preserves settings and live text, and prevents resurrection', async ({ page, context }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/editor.html'); await ready(page);
  const id = await save(page, 'CLEAR CANARY saved body');
  const other = await context.newPage(); await other.goto(`/editor.html?doc=${id}`);
  await expect(other.locator('#editor')).toHaveValue('CLEAR CANARY saved body');
  await page.evaluate(() => { localStorage.setItem('typebridge.editor.tabIndent.v1', 'off'); localStorage.setItem('typebridge.find.matchCase.v1', 'on'); });
  await setPrivateSession(page, true);
  await page.locator('#editor').fill('CLEAR CANARY private body');
  await clearAll(page, false); expect((await stored(page)).rows).toHaveLength(1);
  await clearAll(page);
  await expect(page.getByText('Storage was cleared.', { exact: false }).first()).toBeVisible();
  await expect(other.getByText('Storage was cleared.', { exact: false }).first()).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('CLEAR CANARY private body');
  await expect(other.locator('#editor')).toHaveValue('CLEAR CANARY saved body');
  expect((await stored(page)).all).not.toContain('CLEAR CANARY');
  expect((await stored(other)).all).not.toContain(id);
  expect(await page.evaluate(() => localStorage.getItem('typebridge.autosave.v1'))).toBe('off');
  expect(await page.evaluate(() => localStorage.getItem('typebridge.editor.tabIndent.v1'))).toBe('off');
  expect(await page.evaluate(() => localStorage.getItem('typebridge.find.matchCase.v1'))).toBe('on');
  await page.locator('#editor').fill('AFTER CLEAR CANARY');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect((await stored(page)).all).not.toContain('CANARY');
  await page.reload(); await ready(page); await expect(page.locator('#editor')).toHaveValue('');
  expect((await stored(page)).rows).toEqual([]);
});

test('clear one document preserves other documents, keeps live text private, and clears other-tab backups', async ({ page, context }) => {
  await page.goto('/editor.html'); await ready(page); const id = await save(page, 'CLEAR CANARY document');
  const observer = await context.newPage(); await observer.goto(`/editor.html?doc=${id}`);
  await expect(observer.locator('#editor')).toHaveValue('CLEAR CANARY document');
  await observer.evaluate(id => sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({ id, text: 'CLEAR CANARY backup' })), id);
  const second = await context.newPage(); await second.goto('/editor.html');
  await expect(second.locator('#editor')).toBeEnabled(); await documentAction(second, '#new-draft');
  await expect(second.locator('html')).toHaveAttribute('data-role', 'editor');
  await save(second, 'Other saved document');
  await documentAction(page, '#clear-document-data');
  const dialog = page.getByRole('dialog', { name: 'Clear this document’s saved data?' });
  await expect(dialog).toContainText('cannot be undone'); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await stored(page)).rows).toHaveLength(2);
  await documentAction(page, '#clear-document-data');
  await dialog.getByRole('button', { name: 'Clear saved data', exact: true }).click();
  await expect(observer.getByText('Storage was cleared for this document.', { exact: false })).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('CLEAR CANARY document');
  await expect(page.locator('#autosave')).not.toBeChecked();
  await expect.poll(async () => (await stored(page)).rows.length).toBe(1);
  expect((await stored(page)).rows[0].text).toBe('Other saved document');
  expect((await stored(page)).all).not.toContain('CLEAR CANARY');
  expect((await stored(observer)).all).not.toContain('CLEAR CANARY');
  await openDocuments(second); expect(await second.locator('#drafts').textContent()).not.toContain('CLEAR CANARY');
});

test('clear-all failure is reported without pretending the saved data was removed', async ({ page }) => {
  await page.goto('/editor.html'); await ready(page); await save(page, 'Retained after failed clear');
  await page.evaluate(() => { indexedDB.deleteDatabase = () => { throw new DOMException('Blocked', 'SecurityError'); }; });
  await clearAll(page);
  await expect(page.getByText('Some local data could not be cleared.', { exact: false })).toBeVisible();
  expect((await stored(page)).rows).toHaveLength(1);
  await expect(page.locator('#editor')).toHaveValue('Retained after failed clear');
});

test('host clear-all removes layout and keeps both live editor windows without re-saving metadata', async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(frame.locator('#editor')).toBeEnabled();
  await frame.locator('#editor').fill('CLEAR CANARY host'); await expect(frame.locator('#save-indicator')).toHaveText('Saved');
  const id = await frame.locator('#drafts').inputValue();
  await page.getByRole('button', { name: 'New window', exact: true }).click();
  await expect(page.locator('iframe.host-editor')).toHaveCount(2);
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled();
  await second.locator('#editor').fill('CLEAR CANARY second'); await expect(second.locator('#save-indicator')).toHaveText('Saved');
  await clearAll(page);
  await expect(frame.getByText('Storage was cleared.', { exact: false })).toBeVisible();
  await expect(second.getByText('Storage was cleared.', { exact: false })).toBeVisible();
  await expect(frame.locator('#editor')).toHaveValue('CLEAR CANARY host');
  await expect(second.locator('#editor')).toHaveValue('CLEAR CANARY second');
  expect((await stored(page)).all).not.toContain('CLEAR CANARY');
  expect((await stored(page)).all).not.toContain(id);
  await page.locator('#settings-close').click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  expect(await page.evaluate(() => localStorage.getItem('typebridge.host.windows.v1'))).toBeNull();
});

test('an already-started save cannot restore data or backups after clear-all', async ({ page }) => {
  await page.goto('/editor.html'); await ready(page); const id = await save(page, 'Before held clear');
  await page.evaluate(() => {
    const win = window as unknown as { clearHeld: boolean; releaseClear: () => void };
    const put = IDBObjectStore.prototype.put; let intercepted = false;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const req = put.apply(this, args);
      if (this.name === 'documents' && !intercepted) {
        intercepted = true; let hold = true; win.releaseClear = () => { hold = false; };
        req.addEventListener('success', () => {
          win.clearHeld = true;
          const keepAlive = (): void => { if (hold) this.get(id).addEventListener('success', keepAlive); };
          const id = (args[0] as { id: string }).id;
          keepAlive();
        });
      }
      return req;
    };
  });
  await page.locator('#editor').fill('CLEAR CANARY in flight');
  await expect.poll(() => page.evaluate(() => (window as unknown as { clearHeld: boolean }).clearHeld)).toBe(true);
  await clearAll(page);
  await expect(page.getByText('Storage is being cleared.', { exact: false }).first()).toBeVisible();
  await page.locator('#settings-close').click();
  await page.locator('#editor').fill('AFTER CLEAR CANARY');
  await page.evaluate(() => (window as unknown as { releaseClear: () => void }).releaseClear());
  await expect(page.getByText('Storage was cleared. Settings are kept.', { exact: false })).toHaveText('Storage was cleared. Settings are kept. Reload before saving new documents.');
  expect((await stored(page)).all).not.toContain(id);
  expect((await stored(page)).all).not.toContain('CANARY');
  await expect(page.locator('#editor')).toHaveValue('AFTER CLEAR CANARY');
  await expect(page.locator('#autosave')).not.toBeChecked();
  await expect(page.locator('#autosave')).toBeDisabled();
});

test('cleared host document IDs stay absent from layout; an explicit new save uses a fresh identity', async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(frame.locator('#editor')).toBeEnabled();
  await frame.locator('#editor').fill('Kept text'); await expect(frame.locator('#save-indicator')).toHaveText('Saved');
  const erasedId = await frame.locator('#drafts').inputValue();
  await frame.locator('#doc-menu-open').click(); await frame.locator('#clear-document-data').click();
  await frame.getByRole('dialog', { name: 'Clear this document’s saved data?' }).getByRole('button', { name: 'Clear saved data', exact: true }).click();
  await expect(frame.locator('#editor')).toHaveValue('Kept text');
  await expect.poll(() => frame.locator('#drafts').inputValue()).not.toBe(erasedId);
  const freshId = await frame.locator('#drafts').inputValue();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  expect((await stored(page)).all).not.toContain(erasedId);
  await frame.locator('#autosave').check(); await expect(frame.locator('#save-indicator')).toHaveText('Saved');
  expect((await stored(page)).rows).toEqual([expect.objectContaining({ id: freshId, text: 'Kept text' })]);
  await expect.poll(() => page.evaluate(id => localStorage.getItem('typebridge.host.windows.v1')?.includes(id) ?? false, freshId)).toBe(true);
});
