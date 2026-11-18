import { expect, test } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';

let bundle: string | undefined;
async function fixtureCode() {
  if (bundle) return bundle;
  const built = await build({ configFile: false, build: { write: false,
    lib: { entry: resolve('e2e/fixtures/saved-input-baseline.ts'), name: 'SavedBaselineFixture', formats: ['iife'] },
    rolldownOptions: { output: { codeSplitting: false } },
  } });
  const outputs = Array.isArray(built) ? built : [built];
  const code = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk');
  if (!code || code.type !== 'chunk') throw new Error('No fixture');
  return bundle = code.code;
}
type API = typeof import('./fixtures/saved-input-baseline');
for (const scenario of ['values', 'empty', 'legacy', 'missing', 'corrupt', 'private', 'epoch', 'deleted', 'navigation', 'policy', 'denied', 'failed-proof', 'abort', 'bad-policy', 'bad-epoch', 'bad-revision'] as const) {
  test(`explicit saved input baseline: ${scenario}`, async ({ page }) => {
    await page.goto('/read.html');
    await page.addScriptTag({ content: await fixtureCode() });
    const result = await page.evaluate(async scenario => {
      const api = (window as unknown as { SavedBaselineFixture: API }).SavedBaselineFixture;
      const db = await api.openDraftDatabase();
      const tx = db.transaction(['documents', 'readerStates'], 'readwrite');
      if (scenario !== 'deleted') tx.objectStore('documents').put({ id: 'baseline', title: 'Synthetic', text: 'Source', format: 'markdown', revision: scenario === 'bad-revision' ? 0 : 4, updatedAt: 1, private: scenario === 'bad-policy' ? 'false' : scenario === 'private', ...(scenario === 'legacy' ? {} : { inputEpoch: scenario === 'bad-epoch' ? null : scenario === 'epoch' ? 'new' : 'policy-a' }) });
      if (scenario !== 'missing') tx.objectStore('readerStates').put({ id: 'editable:baseline', version: 1, revision: 2, inputs: scenario === 'corrupt' ? [['x', 'bad']] : scenario === 'empty' ? [] : [['x', 5]] });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      let current = true, allowed = scenario !== 'denied';
      let writes = 0;
      const transactions: { stores: string[]; mode: string }[] = [];
      const transact = db.transaction.bind(db), put = IDBObjectStore.prototype.put, get = IDBObjectStore.prototype.get;
      db.transaction = ((stores: string | string[], mode?: IDBTransactionMode) => { transactions.push({ stores: typeof stores === 'string' ? [stores] : stores, mode: mode ?? 'readonly' }); return transact(stores, mode); }) as typeof db.transaction;
      IDBObjectStore.prototype.put = function (...args) { writes++; return put.apply(this, args); };
      IDBObjectStore.prototype.get = function (key) {
        const request = get.call(this, key);
        if (this.name === 'readerStates') request.addEventListener('success', () => {
          if (scenario === 'navigation') current = false;
          if (scenario === 'policy') allowed = false;
          if (scenario === 'abort') this.transaction.abort();
        });
        return request;
      };
      try {
        const baseline = await api.readSavedInputBaseline(db, 'baseline', scenario === 'legacy' ? '' : 'policy-a', () => current, () => { if (scenario === 'failed-proof') throw new Error('Denied'); return allowed; });
        return { baseline, writes, transactions };
      } finally { IDBObjectStore.prototype.put = put; IDBObjectStore.prototype.get = get; db.close(); }
    }, scenario);
    if (['values', 'empty', 'legacy'].includes(scenario)) expect(result.baseline).toEqual({ kind: 'saved', snapshot: { version: 1, values: scenario === 'empty' ? [] : [['x', 5]] }, documentRevision: 4, inputRevision: 2 });
    else expect(result.baseline).toBeUndefined();
    expect(result.writes).toBe(0);
    expect(result.transactions).toEqual(['denied', 'failed-proof'].includes(scenario) ? [] : [{ stores: ['documents', 'readerStates'], mode: 'readonly' }]);
  });
}
