import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { encodeSharePayload } from '../src/editor/share-link';
import type { openSharedInputs } from '../src/editor/shared-input-state';
let bundle: string | undefined;
async function fixtureCode() {
  if (bundle) return bundle;
  const built = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('src/editor/shared-input-state.ts'), name: 'ReaderStoreFixture', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const outputs = Array.isArray(built) ? built : [built];
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!code || code.type !== 'chunk') throw new Error('No fixture');
  return bundle = code.code;
}
for (const operation of ['reset', 'remove', 'cancel-write'] as const) {
  test(`transactional reader CAS/rollback without notification delivery: ${operation}`, async ({ page }) => {
    const result = await encodeSharePayload({ title: 'CAS fixture', text: 'Plain text', format: 'plain', view: 'source', edit: false });
    if (!result.ok) throw new Error('Encoding failed');
    await page.goto('/read.html#doc=' + result.payload);
    await expect(page.locator('#shared-memory-status')).toContainText('Remembered');
    await page.addScriptTag({ content: await fixtureCode() });
    const values = await page.evaluate(async ({ payload, operation }) => {
      const api = (window as unknown as { ReaderStoreFixture: { openSharedInputs: typeof openSharedInputs } }).ReaderStoreFixture;
      let allowed = true;
      const a = (await api.openSharedInputs(payload, () => allowed, () => {}))!;
      const b = (await api.openSharedInputs(payload, () => true, () => {}))!;
      const first = await a.save(new Map([['x', 5]]));
      const stale = await b.save(new Map([['x', 7]]));
      await b.read();
      let outcome: string;
      if (operation === 'reset') {
        await b.save(new Map()); outcome = await a.save(new Map([['x', 8]]));
      } else if (operation === 'remove') {
        localStorage.setItem('typebridge.sharedRemoval.v1', crypto.randomUUID());
        await new Promise<void>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => { const db = r.result; const tx = db.transaction(['sharedItems', 'readerStates'], 'readwrite'); tx.objectStore('sharedItems').delete(a.id); tx.objectStore('readerStates').delete('shared:' + a.id); tx.oncomplete = () => { db.close(); resolve(); }; }; });
        outcome = await a.save(new Map([['x', 8]]));
      } else {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, key) {
          const r = put.call(this, value, key); if (value?.id === 'shared:' + a.id) r.addEventListener('success', () => { allowed = false; }); return r;
        };
        try { await a.save(new Map([['x', 8]])); outcome = 'committed'; }
        catch { outcome = 'aborted'; }
        finally { IDBObjectStore.prototype.put = put; }
      }
      a.close(); b.close();
      const rows = await new Promise<unknown[]>(resolve => { const r = indexedDB.open('typebridge'); r.onsuccess = () => { const db = r.result; const q = db.transaction('readerStates').objectStore('readerStates').getAll(); q.onsuccess = () => { db.close(); resolve(q.result.filter(row => row.id.startsWith('shared:')).map(row => row.inputs)); }; }; });
      return { first, stale, outcome, rows };
    }, { payload: result.payload, operation });
    expect(values.first).toBe('saved'); expect(values.stale).toBe('conflict');
    expect(values.outcome).toBe(operation === 'reset' ? 'conflict' : operation === 'remove' ? 'cancelled' : 'aborted');
    expect(values.rows).toEqual(operation === 'reset' ? [[]] : operation === 'remove' ? [] : [[['x', 5]]]);
  });
}
