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

test('clear-all removes content across tabs, preserves settings, and empties every live document', async ({ page, context }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/editor.html'); await ready(page);
  const id = await save(page, 'CLEAR CANARY saved body');
  const other = await context.newPage(); await other.goto(`/editor.html?doc=${id}`);
  await expect(other.locator('#editor')).toHaveValue('CLEAR CANARY saved body');
  await page.evaluate(() => { localStorage.setItem('typebridge.editor.tabIndent.v1', 'off'); localStorage.setItem('typebridge.find.matchCase.v1', 'on'); });
  const viewer = await context.newPage(); await viewer.goto(`/editor.html?doc=${id}&mode=view`);
  await expect(viewer.locator('#editor')).toHaveValue('CLEAR CANARY saved body');
  await setPrivateSession(page, true);
  await page.locator('#editor').fill('CLEAR CANARY private body');
  await page.locator('#draft-title').fill('CLEAR CANARY private title');
  await page.locator('#find-open').click();
  await page.locator('#find-text').fill('CLEAR CANARY find');
  await page.locator('#replace-text').fill('CLEAR CANARY replacement');
  await clearAll(page, false); expect((await stored(page)).rows).toHaveLength(1);
  await clearAll(page);
  await expect(page.getByText('All local data was cleared', { exact: true })).toBeVisible();
  await expect(other.getByText('Storage was cleared in another tab', { exact: true })).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#draft-title')).not.toHaveValue(/CANARY/);
  await expect(page.locator('#find-text')).toHaveValue('');
  await expect(page.locator('#replace-text')).toHaveValue('');
  await expect(other.locator('#editor')).toHaveValue('');
  await expect(other.locator('#undo')).toBeDisabled();
  await expect(viewer.locator('#editor')).toHaveValue('');
  await expect(viewer.locator('#draft-title')).toHaveValue('');
  await expect(viewer.getByText('Storage was cleared in another tab', { exact: true }).first()).toBeVisible();
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
  await expect(observer.locator('#deleted-bar')).toBeVisible();
  await expect(observer.locator('#editor')).toHaveValue('CLEAR CANARY document');
  await expect(observer.locator('#editor')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', false);
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
  await expect(page.getByText('Some local data could not be cleared.', { exact: false }).first()).toBeVisible();
  expect((await stored(page)).rows).toHaveLength(1);
  await expect(page.locator('#editor')).toHaveValue('Retained after failed clear');
});

test('host clear-all removes layout and empties both live editor windows', async ({ page }) => {
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
  await expect(frame.getByText('Storage was cleared in another tab', { exact: true })).toBeVisible();
  await expect(second.getByText('Storage was cleared in another tab', { exact: true })).toBeVisible();
  await expect(frame.locator('#editor')).toHaveValue('');
  await expect(second.locator('#editor')).toHaveValue('');
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
  await expect(page.getByText('Storage is being cleared.', { exact: true })).toBeVisible();
  await page.locator('#settings-close').click();
  await page.locator('#editor').fill('AFTER CLEAR CANARY');
  await page.evaluate(() => (window as unknown as { releaseClear: () => void }).releaseClear());
  await expect(page.getByText('All local data was cleared', { exact: true })).toBeVisible();
  expect((await stored(page)).all).not.toContain(id);
  expect((await stored(page)).all).not.toContain('CANARY');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(page.locator('#undo')).toBeDisabled();
  await page.locator('#editor').fill('Fresh document after clear');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  expect((await stored(page)).all).not.toContain('CANARY');
  await expect(page.locator('#autosave')).toBeChecked();
  await expect(page.locator('#autosave')).toBeEnabled();
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


test('document clear drains a delayed queued append before deleting its content', async ({ page }) => {
  await page.goto('/editor.html'); await ready(page);
  const id = await save(page, 'Before delayed append');
  await page.evaluate(() => {
    const win = window as unknown as { __typebridgeDelayChangeAppendMs: number; appendFinished: boolean; deletedBeforeAppend: boolean };
    win.__typebridgeDelayChangeAppendMs = 1200; win.appendFinished = false;
    const put = IDBObjectStore.prototype.put, remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = put.apply(this, args);
      if (this.name === 'changes') this.transaction.addEventListener('complete', () => { win.appendFinished = true; });
      return request;
    };
    IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
      if (this.name === 'documents') win.deletedBeforeAppend = !win.appendFinished;
      return remove.apply(this, args);
    };
  });
  await page.locator('#editor').fill('CLEAR CANARY delayed append');
  await documentAction(page, '#clear-document-data');
  await page.getByRole('dialog', { name: 'Clear this document’s saved data?' }).getByRole('button', { name: 'Clear saved data', exact: true }).click();
  await expect.poll(() => page.locator('#drafts').inputValue()).not.toBe(id);
  expect(await page.evaluate(() => (window as unknown as { deletedBeforeAppend: boolean }).deletedBeforeAppend)).toBe(false);
  expect((await stored(page)).rows).toEqual([]);
  expect((await stored(page)).all).not.toContain('CANARY');
  await expect(page.locator('#editor')).toHaveValue('CLEAR CANARY delayed append');
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', false);
  await expect(page.locator('#autosave')).not.toBeChecked();
});

test('a throwing content metadata key reports incomplete erasure in every tab', async ({ page, context }) => {
  await page.goto('/editor.html'); await ready(page); const id = await save(page, 'Saved before partial clear');
  const other = await context.newPage(); await other.goto(`/editor.html?doc=${id}`); await expect(other.locator('#editor')).toHaveValue('Saved before partial clear');
  await page.evaluate(() => {
    localStorage.setItem('typebridge.recovery.v1.throwing', 'CLEAR CANARY retained metadata');
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key: string) {
      if (key === 'typebridge.recovery.v1.throwing') throw new DOMException('Denied', 'SecurityError');
      remove.call(this, key);
    };
  });
  await clearAll(page);
  await expect(page.getByText('Some local data could not be cleared.', { exact: false }).first()).toBeVisible();
  await expect(other.locator('[role=alert]').filter({ hasText: 'Some local data could not be cleared.' })).toBeVisible();
  await expect(page.getByText('All local data was cleared', { exact: true })).toHaveCount(0);
  await expect(other.getByText('Storage was cleared in another tab', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('typebridge.recovery.v1.throwing'))).toContain('CANARY');
});

test('global clear cancels a switch that is waiting to acquire an erased target', async ({ page, context }) => {
  await page.goto('/editor.html'); await ready(page); await save(page, 'Current clear initiator');
  const seed = await context.newPage(); await seed.goto('/editor.html'); await expect(seed.locator('#editor')).toBeEnabled();
  await documentAction(seed, '#new-draft');
  const target = await save(seed, 'CLEAR CANARY switched target'); await seed.close();
  const other = await context.newPage(); await other.goto('/editor.html'); await expect(other.locator('#editor')).toBeEnabled();
  await documentAction(other, '#new-draft');
  await ready(other);
  await other.evaluate(() => { (window as unknown as { __typebridgeDelayAcquireMs: number }).__typebridgeDelayAcquireMs = 1500; });
  await openDocuments(other); await other.locator('#drafts').selectOption(target);
  await expect(other.locator('#editor')).toHaveJSProperty('readOnly', true);
  await clearAll(page);
  await expect(other.getByText('Storage was cleared in another tab', { exact: true })).toBeVisible();
  // Cover the deliberately delayed acquire and its stale completion, not only the initial reset.
  await other.waitForTimeout(1800);
  await expect(other.locator('#editor')).toHaveValue('');
  await expect(other.locator('#draft-title')).not.toHaveValue(/CANARY/);
  await expect(other.locator('#editor')).toHaveJSProperty('readOnly', false);
  expect((await stored(other)).all).not.toContain('CANARY');
  await other.locator('#editor').fill('Fresh after cancelled switch');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  expect((await stored(other)).all).not.toContain('CANARY');
});

test('per-document clear propagates a matching recovery backup removal failure', async ({ page, context }) => {
  await page.goto('/editor.html'); await ready(page); const id = await save(page, 'Document before partial clear');
  const other = await context.newPage(); await other.goto(`/editor.html?doc=${id}`);
  await expect(other.locator('#editor')).toHaveValue('Document before partial clear');
  const key = `typebridge.recovery.v1.blocked.${id}`;
  await page.evaluate(({ id, key }) => {
    localStorage.setItem(key, JSON.stringify({ token: 't', tab: 'blocked', documentId: id, revision: 1,
      timestamp: Date.now(), title: 'Recovery', text: 'CLEAR CANARY retained document backup' }));
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (name: string) {
      if (name === key) throw new DOMException('Denied', 'SecurityError');
      remove.call(this, name);
    };
  }, { id, key });
  await documentAction(page, '#clear-document-data');
  await page.getByRole('dialog', { name: 'Clear this document’s saved data?' }).getByRole('button', { name: 'Clear saved data', exact: true }).click();
  await expect(other.locator('[role=alert]').filter({ hasText: 'Some local data could not be cleared.' })).toBeVisible();
  await expect(page.locator('[role=alert]').filter({ hasText: 'Some local data could not be cleared.' })).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toContain('CANARY');
  expect((await stored(page)).rows).toEqual([]);
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', false);
});

test('global clear cancels startup waiting for its initial ownership acquisition', async ({ page, context }) => {
  await page.goto('/editor.html'); await ready(page); const id = await save(page, 'CLEAR CANARY startup target');
  const other = await context.newPage();
  await other.addInitScript(() => {
    const win = window as unknown as { __typebridgeDelayAcquireMs: number; bootAcquireWaiting: boolean; oldBootTimerFinished: boolean; releaseFreshAcquire?: () => void };
    win.__typebridgeDelayAcquireMs = 1500;
    const timers = window as unknown as { setTimeout: (callback: TimerHandler, delay?: number, ...args: unknown[]) => number };
    const schedule = timers.setTimeout;
    let acquisitions = 0;
    timers.setTimeout = function (callback: TimerHandler, delay?: number, ...args: unknown[]) {
      if (delay !== 1500 || typeof callback !== 'function') return schedule.call(window, callback, delay, ...args);
      win.bootAcquireWaiting = true;
      if (++acquisitions > 1) { win.releaseFreshAcquire = () => callback(...args); return 0; }
      return schedule.call(window, () => { callback(...args); win.oldBootTimerFinished = true; }, delay);
    };
  });
  await other.goto(`/editor.html?doc=${id}`);
  await expect.poll(() => other.evaluate(() => (window as unknown as { bootAcquireWaiting: boolean }).bootAcquireWaiting)).toBe(true);
  await clearAll(page);
  await expect(other.getByText('Storage was cleared in another tab', { exact: true })).toBeVisible();
  // Hold the replacement acquire until the old startup has settled. No input is accepted
  // into the empty editor before that new persistence pipeline is ready.
  await expect.poll(() => other.evaluate(() => typeof (window as unknown as { releaseFreshAcquire?: () => void }).releaseFreshAcquire)).toBe('function');
  await expect(other.locator('#editor')).toBeDisabled();
  await expect.poll(() => other.evaluate(() => (window as unknown as { oldBootTimerFinished: boolean }).oldBootTimerFinished)).toBe(true);
  await expect(other.locator('#editor')).toHaveValue('');
  await other.evaluate(() => (window as unknown as { releaseFreshAcquire: () => void }).releaseFreshAcquire());
  await expect(other.locator('#editor')).toBeEnabled();
  await expect(other.locator('#editor')).toHaveValue('');
  await expect(other.locator('#editor')).toHaveJSProperty('readOnly', false);
  expect((await stored(other)).all).not.toContain('CANARY');
  await other.locator('#editor').fill('Fresh after invalidated startup');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  expect((await stored(other)).all).not.toContain('CANARY');
});

test('a pending emergency Recover cannot recreate erased content in the replacement database', async ({ page, context }) => {
  await page.goto('/editor.html'); await ready(page);
  await page.evaluate(() => localStorage.setItem('typebridge.recovery.v1.closed.erased', JSON.stringify({
    token: 'clear-pending-recovery', tab: 'closed', documentId: 'erased', revision: 1, timestamp: Date.now(),
    title: 'CLEAR CANARY recovery title', text: 'CLEAR CANARY emergency body',
  })));
  await page.reload(); await ready(page);
  const recover = page.getByRole('button', { name: /^Recover CLEAR CANARY recovery title/ });
  await expect(recover).toBeVisible();
  const clearing = await context.newPage(); await clearing.goto('/editor.html'); await expect(clearing.locator('#editor')).toBeEnabled();
  await page.evaluate(() => {
    const query = navigator.locks.query.bind(navigator.locks);
    const win = window as unknown as { recoveryOwnerWaiting: boolean; releaseRecoveryOwner: () => Promise<void> };
    let hold = true;
    navigator.locks.query = () => {
      if (!hold) return query(); hold = false; win.recoveryOwnerWaiting = true;
      return new Promise(resolve => { win.releaseRecoveryOwner = async () => {
        resolve(await query()); await new Promise(done => setTimeout(done, 0));
      }; });
    };
  });
  await recover.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { recoveryOwnerWaiting: boolean }).recoveryOwnerWaiting)).toBe(true);
  await clearAll(clearing);
  await expect(page.getByText('Storage was cleared in another tab', { exact: true })).toBeVisible();
  await expect(page.locator('#autosave')).toBeEnabled();
  await page.evaluate(() => (window as unknown as { releaseRecoveryOwner: () => Promise<void> }).releaseRecoveryOwner());
  const data = await stored(page);
  expect(data.rows).toEqual([]); expect(data.all).not.toContain('CANARY');
  expect(data.all).not.toContain('recovery-clear-pending-recovery');
  await expect(page.locator('#editor')).toHaveValue('');
});
