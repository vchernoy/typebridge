import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { documentAction, setAutosave } from './settings-helpers';

type Row = { id: string; title: string; text: string; revision: number; updatedAt: number };

const CHANNEL = 'typebridge.documents.v1';

async function readDocs(page: Page): Promise<Row[]> {
  return page.evaluate(() => new Promise<Row[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('documents', 'readonly').objectStore('documents').getAll();
      request.onsuccess = () => {
        const rows = (request.result as Row[]).map(({ id, title, text, revision, updatedAt }) => ({ id, title, text, revision, updatedAt }));
        db.close();
        resolve(rows.sort((a, b) => a.id.localeCompare(b.id)));
      };
      request.onerror = () => reject(request.error);
    };
  }));
}

/** Commit a newer revision straight into IndexedDB without any signal (simulates a missed message). */
async function writeSilently(page: Page, id: string, patch: { text?: string; title?: string }): Promise<number> {
  return page.evaluate(({ id, patch }) => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');
      const get = store.get(id);
      let revision = 0;
      get.onsuccess = () => {
        const row = get.result as Row & Record<string, unknown>;
        revision = row.revision + 1;
        store.put({ ...row, ...patch, revision, updatedAt: Date.now() });
      };
      tx.oncomplete = () => { db.close(); resolve(revision); };
      tx.onerror = () => reject(tx.error);
    };
  }), { id, patch });
}

async function postSignal(page: Page, message: unknown): Promise<void> {
  await page.evaluate(({ name, message }) => {
    const channel = new BroadcastChannel(name);
    channel.postMessage(message);
    channel.close();
  }, { name: CHANNEL, message });
}

async function saveDocument(page: Page, text: string): Promise<Row> {
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill(text);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readDocs(page)).some(row => row.text === text)).toBe(true);
  return (await readDocs(page)).find(row => row.text === text)!;
}

async function openViewer(context: BrowserContext, id: string, text: string): Promise<Page> {
  const viewer = await context.newPage();
  await viewer.goto(`/editor.html?doc=${id}&mode=view`);
  await expect(viewer.locator('#editor')).toBeEnabled();
  await expect(viewer.locator('#editor')).toHaveValue(text);
  await expect(viewer.locator('#viewer-badge')).toHaveText('Saved version · Read-only');
  return viewer;
}

const represented = (viewer: Page): Promise<string | undefined> =>
  viewer.locator('#viewer-badge').evaluate((el: HTMLElement) => el.dataset.revision);

test('an editor save refreshes an open viewer and marks the represented revision', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'First version');
  const viewer = await openViewer(context, row.id, 'First version');
  expect(await represented(viewer)).toBe(String(row.revision));

  await page.locator('#editor').fill('Second version');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(viewer.locator('#editor')).toHaveValue('Second version');
  await expect(viewer.locator('#editor')).toHaveJSProperty('readOnly', true);
  await expect(viewer.locator('#status')).toContainText('latest saved version');
  const latest = (await readDocs(page))[0];
  expect(await represented(viewer)).toBe(String(latest.revision));
  expect(latest.revision).toBeGreaterThan(row.revision);
});

test('a refresh keeps the viewer position when offsets still fit', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'abcdefghij');
  const viewer = await openViewer(context, row.id, 'abcdefghij');
  await viewer.locator('#editor').evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(2, 5); el.dispatchEvent(new Event('select')); });

  await page.locator('#editor').fill('abcdefghij and more');
  await expect(viewer.locator('#editor')).toHaveValue('abcdefghij and more');
  expect(await viewer.locator('#editor').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);
});

test('a rename in the editor updates the viewer title', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Body stays');
  const viewer = await openViewer(context, row.id, 'Body stays');

  await page.locator('#draft-title').fill('Renamed elsewhere');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(viewer.locator('#draft-title')).toHaveValue('Renamed elsewhere');
  await expect(viewer.locator('#editor')).toHaveValue('Body stays');
});

test('deleting the document shows the viewer missing state and keeps it read-only', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Soon gone');
  const viewer = await openViewer(context, row.id, 'Soon gone');

  await documentAction(page, '#delete-draft');
  await page.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete document' }).click();
  await expect(viewer.locator('#viewer-notice')).toBeVisible();
  await expect(viewer.locator('#viewer-notice')).toContainText('no longer available');
  await expect(viewer.locator('#editor')).toHaveValue('');
  await expect(viewer.locator('#editor')).toHaveJSProperty('readOnly', true);
  expect((await readDocs(page)).filter(r => r.id === row.id)).toEqual([]);
});

test('stale, equal, malformed and other-document signals are ignored; the reread is authoritative', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Base text');
  const viewer = await openViewer(context, row.id, 'Base text');

  // The stored row moves on silently, so only a signal that passes the revision rule can trigger a reread.
  const newest = await writeSilently(page, row.id, { text: 'Silently newer' });
  const now = Date.now();
  for (const message of [
    { v: 1, type: 'saved', documentId: row.id, revision: row.revision, at: now },
    { v: 1, type: 'saved', documentId: row.id, revision: row.revision - 1, at: now },
    { v: 1, type: 'saved', documentId: 'b2c3d4e5-f6a7-4890-b123-456789abcdef', revision: 99, at: now },
    { v: 1, type: 'saved', documentId: 'not-an-id', revision: 99, at: now },
    { v: 2, type: 'saved', documentId: row.id, revision: 99, at: now },
    'saved',
  ]) await postSignal(page, message);
  await page.waitForTimeout(600);
  await expect(viewer.locator('#editor')).toHaveValue('Base text');
  expect(await represented(viewer)).toBe(String(row.revision));

  // An inflated revision cannot force content that storage does not hold.
  await postSignal(page, { v: 1, type: 'saved', documentId: row.id, revision: newest + 10, at: now });
  await expect(viewer.locator('#editor')).toHaveValue('Silently newer');
  expect(await represented(viewer)).toBe(String(newest));

  // An older out-of-order signal after the refresh changes nothing.
  await postSignal(page, { v: 1, type: 'saved', documentId: row.id, revision: row.revision + 1, at: now });
  await page.waitForTimeout(400);
  await expect(viewer.locator('#editor')).toHaveValue('Silently newer');
  expect(await represented(viewer)).toBe(String(newest));
});

test('signals carry metadata only', async ({ page, context }) => {
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    (window as unknown as { __sent: unknown[] }).__sent = sent;
    const original = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (message: unknown) {
      sent.push(JSON.parse(JSON.stringify(message)));
      return original.call(this, message);
    };
  });
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'SECRET-BODY-TEXT');
  await page.locator('#draft-title').fill('SECRET-TITLE');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readDocs(page))[0].title).toBe('SECRET-TITLE');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sent: unknown[] }).__sent.length)).toBeGreaterThan(1);
  const sent = await page.evaluate(() => (window as unknown as { __sent: Record<string, unknown>[] }).__sent);
  for (const message of sent) {
    expect(Object.keys(message).sort()).toEqual(['at', 'documentId', 'revision', 'type', 'v']);
    expect(message.documentId).toBe(row.id);
  }
  expect(JSON.stringify(sent)).not.toContain('SECRET');
  expect(sent.map(m => m.type)).toContain('renamed');
  expect(context.pages()).toContain(page);
});

test('a dirty editor gets a notice and its text is never replaced or saved over', async ({ page }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Shared base');
  await setAutosave(page, false, 'keep');
  await page.locator('#editor').fill('Private unsaved edits');
  await expect(page.locator('#version-notice')).toBeHidden();

  // Since #159 W4 a second current tab is read-only, so the newer revision comes from a build
  // that signals but does not take part in edit ownership.
  const revision = await writeSilently(page, row.id, { text: 'Saved elsewhere' });
  await postSignal(page, { v: 1, type: 'saved', documentId: row.id, revision, at: Date.now() });
  await expect(page.locator('#version-notice')).toBeVisible();
  await expect(page.locator('#version-notice')).toContainText('newer saved version');
  await expect(page.locator('#editor')).toHaveValue('Private unsaved edits');
  await expect(page.locator('#editor')).toBeEditable();
  await page.waitForTimeout(500);
  const rows = await readDocs(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(row.id);
  expect(rows[0].text).toBe('Saved elsewhere');
});

test('a signal that arrives while the viewer is still loading is applied once it is ready', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Loaded version');
  const viewer = await context.newPage();
  // Hold the viewer's Documents list read, so it is still initializing when the signal arrives.
  await viewer.addInitScript(() => {
    const getAll = IDBObjectStore.prototype.getAll;
    const state = window as unknown as { listHeld?: boolean; releaseList?: () => void };
    IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) {
      const request = getAll.apply(this, args);
      if (state.listHeld || this.name !== 'documents') return request;
      state.listHeld = true;
      const handler = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!;
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        get: () => handler.get!.call(request),
        set: (fn: (event: Event) => void) => handler.set!.call(request, (event: Event) => { state.releaseList = () => fn.call(request, event); }),
      });
      return request;
    };
  });
  await viewer.goto(`/editor.html?doc=${row.id}&mode=view`);
  await expect.poll(() => viewer.evaluate(() => typeof (window as unknown as { releaseList?: () => void }).releaseList)).toBe('function');
  await expect(viewer.locator('#editor')).toBeDisabled();

  await page.locator('#editor').fill('Saved during load');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readDocs(page))[0].text).toBe('Saved during load');
  await viewer.evaluate(() => (window as unknown as { releaseList: () => void }).releaseList());
  await expect(viewer.locator('#editor')).toBeEnabled();
  await expect(viewer.locator('#editor')).toHaveValue('Saved during load');
});

test('focus and visibility reconcile a signal that was missed', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Before');
  const viewer = await openViewer(context, row.id, 'Before');

  await writeSilently(page, row.id, { text: 'Changed while away' });
  await page.waitForTimeout(400);
  await expect(viewer.locator('#editor')).toHaveValue('Before');
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(viewer.locator('#editor')).toHaveValue('Changed while away');

  await writeSilently(page, row.id, { text: 'Changed again', title: 'Away title' });
  await viewer.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(viewer.locator('#editor')).toHaveValue('Changed again');
  await expect(viewer.locator('#draft-title')).toHaveValue('Away title');
});

test('focus reconciliation covers a deletion that was missed', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Will vanish');
  const viewer = await openViewer(context, row.id, 'Will vanish');
  await page.evaluate(id => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').delete(id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), row.id);
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(viewer.locator('#viewer-notice')).toBeVisible();
  await expect(viewer.locator('#editor')).toHaveValue('');
});

test('without BroadcastChannel a viewer still reconciles on focus and the editor keeps saving', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
  });
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'No channel');
  const viewer = await openViewer(context, row.id, 'No channel');

  await page.locator('#editor').fill('No channel, newer');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.waitForTimeout(600);
  await expect(viewer.locator('#editor')).toHaveValue('No channel');
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(viewer.locator('#editor')).toHaveValue('No channel, newer');
});

test('viewers never write documents because of signals', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Read only');
  const viewer = await openViewer(context, row.id, 'Read only');
  await page.locator('#editor').fill('Read only v2');
  await expect(viewer.locator('#editor')).toHaveValue('Read only v2');
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(500);
  const rows = await readDocs(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].text).toBe('Read only v2');
});

test('without BroadcastChannel a visible viewer rereads on the slow fallback interval', async ({ page, context }) => {
  await page.goto('/editor.html');
  const row = await saveDocument(page, 'Interval base');
  const viewer = await context.newPage();
  await viewer.addInitScript(() => {
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true });
  });
  await viewer.clock.install();
  await viewer.goto(`/editor.html?doc=${row.id}&mode=view`);
  await expect(viewer.locator('#editor')).toHaveValue('Interval base');

  await writeSilently(page, row.id, { text: 'Interval newer' });
  await viewer.clock.fastForward(5_000);
  await viewer.waitForTimeout(300);
  await expect(viewer.locator('#editor')).toHaveValue('Interval base');
  await viewer.clock.fastForward(16_000);
  await expect(viewer.locator('#editor')).toHaveValue('Interval newer');
});
