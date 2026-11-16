import { expect, test } from '@playwright/test';
import { fillHostEditor } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';
import type { HostPageApi, EditorWindow } from '../src/view/embed-api';

for (const scenario of ['activate', 'untracked-edit', 'cancel-after-offer', 'private', 'blocked-preference'] as const) {
  test(`hosted shared-copy owner protocol: ${scenario}`, async ({ page }) => {
    await page.goto('/');
    const first = page.frameLocator('.host-window[data-window-id="main"] iframe');
    await expect(first.locator('#editor')).toBeEnabled({ timeout: 30_000 });
    await fillHostEditor(first, 'Exact owned source');
    await expect(first.locator('#save-indicator')).toHaveText('Saved');
    await page.getByRole('button', { name: 'New window' }).click();
    const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
    await expect(second.locator('#editor')).toBeEnabled({ timeout: 30_000 });
    await fillHostEditor(second, 'Other document');
    await expect(second.locator('#save-indicator')).toHaveText('Saved');
    const before = await readStoredDocs(page);
    const result = await page.evaluate(async scenario => {
      const host = window as unknown as HostPageApi;
      const frame = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="main"] iframe')!;
      const ownerWindow = frame.contentWindow! as EditorWindow;
      const field = frame.contentDocument!.querySelector<HTMLTextAreaElement>('#editor')!;
      const id = ownerWindow.__typebridgeStoredDocumentId!()!;
      const open = indexedDB.open('typebridge');
      const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      const tx = db.transaction(['documents', 'editOwnership'], 'readonly');
      const get = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const rowPromise = get(tx.objectStore('documents').get(id));
      const ownerPromise = get(tx.objectStore('editOwnership').get(id));
      const [row, owner] = await Promise.all([rowPromise, ownerPromise]); db.close();
      if (scenario === 'untracked-edit') field.value = 'Untracked unsaved source';
      if (scenario === 'private') {
        localStorage.setItem('typebridge.autosave.v1', 'off');
        ownerWindow.dispatchEvent(new StorageEvent('storage', { key: 'typebridge.autosave.v1', newValue: 'off' }));
      }
      if (scenario === 'blocked-preference') {
        // The regular privacy helper may have cached public=false. Reuse must
        // still demand a successful current read rather than trust that cache.
        const prototype = Object.getPrototypeOf(ownerWindow.localStorage) as Storage;
        const original = prototype.getItem;
        prototype.getItem = function (key) {
          if (key === 'typebridge.autosave.v1') throw new Error('blocked preference');
          return original.call(this, key);
        };
      }
      let activations = 0;
      const activate = host.__typebridgeActivateExistingEditor;
      host.__typebridgeActivateExistingEditor = (...args) => { activations++; return activate(...args); };
      const channel = new BroadcastChannel('typebridge-shared-copy-reuse.v1');
      const requestId = crypto.randomUUID();
      const outcomes: string[] = [];
      const received: string[] = [];
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2300);
        channel.onmessage = event => {
          const message = event.data;
          if (message.requestId !== requestId) return;
          received.push(message.type);
          if (message.type === 'offer') {
            if (scenario === 'cancel-after-offer') field.dispatchEvent(new Event('compositionstart', { bubbles: true }));
            channel.postMessage({ ...message, type: 'commit' });
          } else if (message.type === 'result') {
            outcomes.push(message.outcome);
            if (scenario === 'activate' && outcomes.length === 1) {
              const { outcome, ...identity } = message;
              void outcome;
              channel.postMessage({ ...identity, type: 'commit' });
              channel.postMessage({ ...identity, type: 'status' });
            }
            if (scenario !== 'activate' || outcomes.length === 3) { clearTimeout(timer); resolve(); }
          }
        };
        channel.postMessage({ v: 1, type: 'probe', documentId: id, revision: row.revision,
          ownerInstanceId: owner.ownerInstanceId, fence: owner.fence,
          requesterId: crypto.randomUUID(), requestId, deadline: Date.now() + 2000 });
      });
      channel.close();
      host.__typebridgeActivateExistingEditor = activate;
      return { activations, outcomes, received, field: field.value };
    }, scenario);
    await expect(page.locator('.host-window')).toHaveCount(2);
    if (scenario === 'activate') {
      expect(result.activations).toBe(1);
      expect(result.outcomes).toEqual(['activated', 'activated', 'activated']);
      await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);
      expect(await readStoredDocs(page)).toEqual(before);
    } else {
      expect(result.activations).toBe(0);
      if (scenario === 'cancel-after-offer') expect(result.outcomes).toEqual(['unknown']);
      else expect(result.received).toEqual([]);
      await expect(page.locator('.host-window[data-window-id="w2"]')).toHaveClass(/is-active/);
    }
    expect(result.field).toBe(scenario === 'untracked-edit' ? 'Untracked unsaved source' : 'Exact owned source');
  });
}

test('a separate reading tab activates the existing hosted owner with metadata only', async ({ page, context }) => {
  await page.goto('/');
  const first = page.frameLocator('.host-window[data-window-id="main"] iframe');
  await expect(first.locator('#editor')).toBeEnabled({ timeout: 30_000 });
  await fillHostEditor(first, 'Cross-tab exact source');
  await expect(first.locator('#save-indicator')).toHaveText('Saved');
  await page.getByRole('button', { name: 'New window' }).click();
  await expect(page.frameLocator('.host-window[data-window-id="w2"] iframe').locator('#editor')).toBeEnabled({ timeout: 30_000 });
  const before = await readStoredDocs(page);
  const metadata = await page.evaluate(async () => {
    const frame = document.querySelector<HTMLIFrameElement>('.host-window[data-window-id="main"] iframe')!;
    const id = (frame.contentWindow as EditorWindow).__typebridgeStoredDocumentId!()!;
    const open = indexedDB.open('typebridge');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const tx = db.transaction(['documents', 'editOwnership'], 'readonly');
    const get = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const row = get(tx.objectStore('documents').get(id)); const owner = get(tx.objectStore('editOwnership').get(id));
    const [r, o] = await Promise.all([row, owner]); db.close();
    return { documentId: id, revision: r.revision as number, ownerInstanceId: o.ownerInstanceId as string, fence: o.fence as number };
  });
  const reader = await context.newPage();
  await reader.goto('/read.html');
  const result = await reader.evaluate(metadata => new Promise<{ outcome: string; keys: string[] } | undefined>(resolve => {
    const channel = new BroadcastChannel('typebridge-shared-copy-reuse.v1');
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { channel.close(); resolve(undefined); }, 2300);
    channel.onmessage = event => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (message.type === 'offer') channel.postMessage({ ...message, type: 'commit' });
      if (message.type === 'result') {
        clearTimeout(timer); channel.close(); resolve({ outcome: message.outcome, keys: Object.keys(message).sort() });
      }
    };
    channel.postMessage({ ...metadata, v: 1, type: 'probe', requesterId: crypto.randomUUID(), requestId, deadline: Date.now() + 2000 });
  }), metadata);
  expect(result?.outcome).toBe('activated');
  expect(result?.keys).toEqual(['deadline', 'documentId', 'fence', 'offerId', 'outcome', 'ownerInstanceId', 'requestId', 'requesterId', 'revision', 'type', 'v']);
  await expect(page.locator('.host-window[data-window-id="main"]')).toHaveClass(/is-active/);
  await expect(page.locator('.host-window')).toHaveCount(2);
  expect(await readStoredDocs(page)).toEqual(before);
  await reader.close();
});
