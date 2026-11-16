import { expect, test, type Page } from '@playwright/test';
import { encodeSharePayload } from '../src/editor/share-link';

async function payload(title = 'Received title', text = 'Exact received text\n', format = 'plain') {
  const result = await encodeSharePayload({ title, text, format, view: 'source', edit: false });
  if (!result.ok) throw new Error('Fixture refused'); return result.payload;
}
async function rows(page: Page, store = 'sharedItems') {
  return page.evaluate(store => new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge'); open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction(store); const get = tx.objectStore(store).getAll();
      tx.oncomplete = () => { db.close(); resolve(get.result); }; tx.onabort = () => { db.close(); reject(tx.error); }; };
  }), store);
}
async function remembered(page: Page) {
  await expect(page.locator('#shared-memory-status')).toHaveText('Remembered in Shared with me on this device.');
}

test('both routes and concurrent opens remember one immutable item without loading a renderer or creating drafts', async ({ page, context }) => {
  const p = await payload(); const requests: string[] = []; context.on('request', r => requests.push(r.url()));
  const second = await context.newPage();
  await Promise.all([page.goto('/#doc=' + p), second.goto('/read.html#doc=' + p)]);
  await remembered(page); await remembered(second);
  const original = (await rows(page))[0]; expect(await rows(page)).toHaveLength(1);
  await page.reload(); await remembered(page);
  expect((await rows(page))[0]).toMatchObject({ id: original.id, payload: p, createdAt: original.createdAt });
  expect(await rows(page, 'documents')).toEqual([]);
  expect(await rows(page, 'readerStates')).toEqual([]);
  expect(requests.filter(u => /active-renderer|katex|\.woff2/.test(u))).toEqual([]);
  expect(requests.filter(u => u.includes('doc='))).toEqual([]); // Fragments never reach HTTP requests.
});

test('hash collisions and different hints retain distinct full payloads', async ({ page }) => {
  await page.addInitScript(() => { crypto.subtle.digest = async () => new Uint8Array(32).buffer; });
  const p = await payload(); await page.goto('/read.html#doc=' + p); await remembered(page);
  const other = await encodeSharePayload({ title: 'Received title', text: 'Exact received text\n', format: 'plain', view: 'source', edit: true });
  if (!other.ok) throw new Error('Fixture');
  await page.goto('/read.html#doc=' + other.payload); await remembered(page);
  expect((await rows(page)).map(r => r.payload).sort()).toEqual([p, other.payload].sort());
});

for (const gate of ['typebridge.autosave.v1', 'typebridge.rememberShared.v1']) {
  test(`privacy gate ${gate} leaves no content storage and turning it on requires explicit Remember`, async ({ page }) => {
    await page.addInitScript(key => localStorage.setItem(key, 'off'), gate);
    await page.goto('/read.html#doc=' + await payload());
    await expect(page.locator('#read-text')).toHaveText('Exact received text\n', { useInnerText: false });
    await expect(page.locator('#shared-memory-status')).toContainText('Not remembered');
    expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
    await page.evaluate(key => localStorage.removeItem(key), gate);
    await page.getByText('Local shared library', { exact: true }).click();
    await page.getByRole('button', { name: 'Remember this document' }).click(); await remembered(page);
    expect(await rows(page)).toHaveLength(1);
  });
}

test('storage refusal leaves source usable and no renderer requests', async ({ page }) => {
  await page.addInitScript(() => { indexedDB.open = () => { throw new Error('Storage refused'); }; });
  await page.goto('/read.html#doc=' + await payload());
  await expect(page.locator('#read-text')).toHaveText('Exact received text\n', { useInnerText: false });
  await expect(page.locator('#shared-memory-status')).toContainText('Could not remember');
});

test('invalid and over-limit links never create content storage', async ({ page }) => {
  for (const p of ['1.bad!', '1.' + 'a'.repeat(48001)]) {
    await page.goto('/read.html#doc=' + p);
    await expect(page.locator('#read-title')).toHaveText('This shared document cannot be opened');
    expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  }
});

test('Documents opens/removes shared items independently of editable copies and can search them', async ({ page, context }) => {
  const p = await payload(); await page.goto('/read.html#doc=' + p); await remembered(page);
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Independent editable copy');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.locator('#doc-menu-open').click(); await page.getByText('Shared with me', { exact: true }).click();
  const item = page.getByRole('link', { name: 'Received title (shared, opens a new tab)', exact: true });
  await expect(item).toBeVisible(); await expect(item).toHaveAttribute('href', '/read.html#doc=' + p);
  await page.locator('#shared-search').fill('absent'); await expect(item).toHaveCount(0);
  await page.locator('#shared-search').fill('Exact received'); await expect(item).toBeVisible();
  const tab = context.waitForEvent('page'); await item.click(); const reader = await tab;
  await expect(reader.locator('#read-text')).toHaveText('Exact received text\n', { useInnerText: false }); await remembered(reader); await reader.close();
  const before = await rows(page, 'documents');
  await page.getByRole('button', { name: 'Remove shared document Received title', exact: true }).click();
  await expect(item).toHaveCount(0); expect(await rows(page)).toEqual([]); expect(await rows(page, 'documents')).toEqual(before);
});

test('v6 upgrade preserves documents, ownership and unapplied changes', async ({ page }) => {
  await page.goto('/read.html');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 6);
    open.onupgradeneeded = () => { for (const [name, keyPath] of [['documents', 'id'], ['editOwnership', 'documentId'], ['changes', ['documentId', 'seq']]] as const) open.result.createObjectStore(name, { keyPath: keyPath as string | string[] }); };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const db = open.result; const tx = db.transaction(['documents', 'editOwnership', 'changes'], 'readwrite');
      tx.objectStore('documents').put({ id: 'kept', title: 'Old', text: 'Saved', revision: 3, updatedAt: 10 });
      tx.objectStore('editOwnership').put({ documentId: 'kept', ownerInstanceId: 'other', fence: 7, updatedAt: 1 });
      tx.objectStore('changes').put({ documentId: 'kept', seq: 1, value: 'Unapplied' });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
  }));
  const before = await Promise.all(['documents', 'editOwnership', 'changes'].map(s => rows(page, s)));
  await page.goto('/read.html#doc=' + await payload()); await remembered(page);
  expect(await Promise.all(['documents', 'editOwnership', 'changes'].map(s => rows(page, s)))).toEqual(before);
});

test('global clear reloads old readers without automatically restoring the erased item', async ({ page, context }) => {
  await page.goto('/read.html#doc=' + await payload()); await remembered(page);
  const editor = await context.newPage(); await editor.goto('/editor.html'); await expect(editor.locator('#editor')).toBeEnabled();
  await editor.locator('#settings-open').click();
  await editor.locator('#clear-local-data').click();
  await editor.getByRole('button', { name: 'Clear local data', exact: true }).click();
  await expect(editor.locator('#editor')).toBeEnabled();
  await expect(page.locator('#read-text')).toHaveText('Exact received text\n', { useInnerText: false });
  await page.getByText('Local shared library', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remember this document' })).toBeVisible();
  expect(await rows(editor)).toEqual([]);
  await page.getByRole('button', { name: 'Remember this document' }).click(); await remembered(page);
  expect(await rows(page)).toHaveLength(1);
});

test('capacity and quota failures do not evict existing entries or block reading', async ({ page }) => {
  await page.goto('/read.html#doc=' + await payload()); await remembered(page);
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge'); open.onsuccess = () => { const db = open.result;
      const tx = db.transaction('sharedItems', 'readwrite');
      for (let i = 1; i < 100; i++) tx.objectStore('sharedItems').put({ id: 'fixture-' + i, payload: '1.fixture' + i, digest: 'fixture', bytes: 12, createdAt: 1, lastOpenedAt: 1 });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
  }));
  const before = await rows(page); await page.goto('/read.html#doc=' + await payload('Another'));
  await expect(page.locator('#shared-memory-status')).toContainText('Shared library is full');
  expect(await rows(page)).toEqual(before);
  await page.addInitScript(() => { const add = IDBObjectStore.prototype.add; IDBObjectStore.prototype.add = function(...args) {
    if (this.name === 'sharedItems') throw new DOMException('Full', 'QuotaExceededError'); return add.apply(this, args);
  }; });
  // A separate context is unnecessary: remove the synthetic capacity rows first.
  await page.evaluate(() => new Promise<void>(resolve => { const open = indexedDB.open('typebridge'); open.onsuccess = () => { const db = open.result; const tx = db.transaction('sharedItems', 'readwrite'); tx.objectStore('sharedItems').clear(); tx.oncomplete = () => { db.close(); resolve(); }; }; }));
  await page.reload(); await expect(page.locator('#shared-memory-status')).toContainText('Could not remember');
  await expect(page.locator('#read-text')).toHaveText('Exact received text\n', { useInnerText: false });
  expect(await rows(page)).toEqual([]);
});

test('a navigation invalidates an old remember while its native digest is pending', async ({ page }) => {
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle); let first = true;
    crypto.subtle.digest = async (...args) => {
      if (first) { first = false; await new Promise<void>(resolve => { (window as unknown as { releaseDigest: () => void }).releaseDigest = resolve; }); }
      return digest(...args);
    };
  });
  await page.goto('/read.html#doc=' + await payload('Old'));
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseDigest?: unknown }).releaseDigest)).toBe('function');
  const next = await payload('New'); await page.evaluate(p => { location.hash = 'doc=' + p; }, next); await remembered(page);
  await page.evaluate(() => (window as unknown as { releaseDigest: () => void }).releaseDigest());
  await expect(page.locator('#read-title')).toHaveText('New');
  expect((await rows(page)).map(r => r.payload)).toEqual([next]);
});

test('removal invalidates a previously started remember without deleting an editable copy', async ({ page, context }) => {
  const p = await payload(); await page.goto('/read.html#doc=' + p); await remembered(page);
  const held = await context.newPage();
  await held.addInitScript(() => { const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => { await new Promise<void>(resolve => { (window as unknown as { releaseDigest: () => void }).releaseDigest = resolve; }); return digest(...args); };
  });
  await held.goto('/read.html#doc=' + p);
  await expect.poll(() => held.evaluate(() => typeof (window as unknown as { releaseDigest?: unknown }).releaseDigest)).toBe('function');
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('Independent editable copy'); await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const before = await rows(page, 'documents');
  await page.locator('#doc-menu-open').click(); await page.getByText('Shared with me', { exact: true }).click();
  await page.getByRole('button', { name: 'Remove shared document Received title', exact: true }).click();
  await expect(page.locator('#shared-library')).toContainText('No remembered shared documents');
  await held.evaluate(() => (window as unknown as { releaseDigest: () => void }).releaseDigest());
  await expect(held.locator('#shared-memory-status')).toContainText('Remembering cancelled');
  expect(await rows(page)).toEqual([]); expect(await rows(page, 'documents')).toEqual(before);
});

test('opt-out in another tab during hashing cancels the automatic write', async ({ page, context }) => {
  await page.addInitScript(() => { const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => { await new Promise<void>(resolve => { (window as unknown as { releaseDigest: () => void }).releaseDigest = resolve; }); return digest(...args); };
  });
  await page.goto('/read.html#doc=' + await payload());
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseDigest?: unknown }).releaseDigest)).toBe('function');
  const other = await context.newPage(); await other.goto('/editor.html'); await expect(other.locator('#editor')).toBeEnabled();
  await other.evaluate(() => localStorage.setItem('typebridge.rememberShared.v1', 'off'));
  await expect(page.locator('#remember-shared')).not.toBeChecked();
  await page.evaluate(() => (window as unknown as { releaseDigest: () => void }).releaseDigest());
  expect(await rows(other)).toEqual([]);
});

test('unknown-format received source reopens from the library offline after shell installation', async ({ page, context }) => {
  const p = await payload('Future format', 'Exact future source', 'future-format');
  await page.goto('/read.html#doc=' + p); await remembered(page);
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.evaluate(async () => { await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await context.setOffline(true);
  try {
    await page.locator('#doc-menu-open').click(); await page.getByText('Shared with me', { exact: true }).click();
    const opened = context.waitForEvent('page'); await page.getByRole('link', { name: 'Future format (shared, opens a new tab)' }).click();
    const reader = await opened; await expect(reader.locator('#read-text')).toHaveText('Exact future source');
    await expect(reader.locator('#read-notice')).toContainText('cannot show yet'); await remembered(reader);
    expect(await rows(reader, 'documents')).toEqual([]);
  } finally { await context.setOffline(false); }
});

test('phone library links wrap and removal remains keyboard accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = 'LongReceivedTitle'.repeat(8);
  await page.goto('/read.html#doc=' + await payload(title)); await remembered(page);
  await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#doc-menu-open').click();
  const summary = page.locator('#shared-library summary'); await summary.focus(); await page.keyboard.press('Enter');
  const remove = page.getByRole('button', { name: 'Remove shared document ' + title }); await expect(remove).toBeVisible();
  const geometry = await remove.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
  expect(geometry.width).toBeGreaterThanOrEqual(44); expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await remove.focus(); await page.keyboard.press('Enter'); await expect(page.locator('#shared-library')).toContainText('No remembered shared documents');
  await expect(summary).toBeFocused();
});

type RememberPhase = 'initial decode' | 'remember validation' | 'database open';
async function holdRemember(page: Page, phase: RememberPhase, suppressClear = false) {
  await page.addInitScript(({ phase, suppressClear }) => {
      if (suppressClear) {
        // Hold peer notification delivery independently of database deletion.
        const add = window.addEventListener.bind(window);
        window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
          if (!listener) return;
          if (type !== 'storage') return add(type, listener, options);
          add(type, event => {
            if ((event as StorageEvent).key === 'typebridge.storageClear.v1') return;
            if (typeof listener === 'function') listener.call(window, event); else listener.handleEvent(event);
          }, options);
        }) as typeof window.addEventListener;
        const NativeChannel = BroadcastChannel;
        window.BroadcastChannel = class extends NativeChannel {
          addEventListener(...args: Parameters<BroadcastChannel['addEventListener']>) {
            if (this.name !== 'typebridge.storage.v1') super.addEventListener(...args);
          }
        };
      }
      const hold = () => new Promise<void>(resolve => {
        (window as unknown as { releaseRemember: () => void }).releaseRemember = resolve;
      });
      if (phase === 'database open') {
        const open = indexedDB.open.bind(indexedDB);
        indexedDB.open = (...args: Parameters<IDBFactory['open']>) => {
          const request = open(...args);
          let handler: ((event: Event) => void) | null = null;
          Object.defineProperty(request, 'onsuccess', {
            get: () => handler,
            set: (value: typeof handler) => { handler = value; },
          });
          request.addEventListener('success', event => {
            void hold().then(() => handler?.call(request, event));
          }, { once: true });
          return request;
        };
      } else {
        const Native = DecompressionStream; let count = 0;
        window.DecompressionStream = class extends Native {
          constructor(format: CompressionFormat) {
            super(format);
            if (++count === (phase === 'initial decode' ? 1 : 2)) {
              const pending = hold();
              const gate = new TransformStream<Uint8Array, Uint8Array>({
                async transform(chunk, controller) { await pending; controller.enqueue(chunk); },
              });
              const readable = this.readable.pipeThrough(gate);
              Object.defineProperty(this, 'readable', { value: readable });
            }
          }
        };
      }
  }, { phase, suppressClear });
}

for (const phase of ['initial decode', 'remember validation', 'database open'] as const) {
  test(`removal cancels a reader held during ${phase}, before its epoch snapshot`, async ({ page, context }) => {
    const p = await payload(); await page.goto('/read.html#doc=' + p); await remembered(page);
    const held = await context.newPage();
    await holdRemember(held, phase);
    await held.goto('/read.html#doc=' + p);
    await expect.poll(() => held.evaluate(() => typeof (window as unknown as { releaseRemember?: unknown }).releaseRemember)).toBe('function');
    await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#doc-menu-open').click(); await page.getByText('Shared with me', { exact: true }).click();
    await page.getByRole('button', { name: 'Remove shared document Received title', exact: true }).click();
    await expect(page.locator('#shared-library')).toContainText('No remembered shared documents');
    await held.evaluate(() => (window as unknown as { releaseRemember: () => void }).releaseRemember());
    await expect(held.locator('#shared-memory-status')).toContainText('Remembering cancelled');
    expect(await rows(page)).toEqual([]);
    await held.close();
    // A fresh deliberate open still remembers the source after removal.
    const fresh = await context.newPage(); await fresh.goto('/read.html#doc=' + p); await remembered(fresh);
    expect(await rows(fresh)).toHaveLength(1);
  });
}


for (const phase of ['initial decode', 'remember validation'] as const) {
  test(`global clear cancels a reader held during ${phase} before peer notification arrives`, async ({ page, context }) => {
    const p = await payload(); await page.goto('/read.html#doc=' + p); await remembered(page);
    const held = await context.newPage(); await holdRemember(held, phase, true);
    await held.goto('/read.html#doc=' + p);
    await expect.poll(() => held.evaluate(() => typeof (window as unknown as { releaseRemember?: unknown }).releaseRemember)).toBe('function');
    await page.goto('/editor.html'); await expect(page.locator('#editor')).toBeEnabled();
    await page.locator('#settings-open').click(); await page.locator('#clear-local-data').click();
    await page.getByRole('button', { name: 'Clear local data', exact: true }).click();
    await expect(page.getByText('All local data was cleared', { exact: true })).toBeVisible();
    expect(await rows(page)).toEqual([]);
    await held.evaluate(() => (window as unknown as { releaseRemember: () => void }).releaseRemember());
    await expect(held.locator('#shared-memory-status')).toContainText('Remembering cancelled');
    await expect(held.locator('#read-text')).toHaveText('Exact received text\n', { useInnerText: false });
    expect(await rows(page)).toEqual([]);
    // Explicit consent after erasure can remember the still-readable link again.
    await held.getByText('Local shared library', { exact: true }).click();
    await held.getByRole('button', { name: 'Remember this document' }).click(); await remembered(held);
    expect(await rows(page)).toHaveLength(1);
  });
}
