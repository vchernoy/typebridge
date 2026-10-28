import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('IndexedDB migration is atomic, restartable and preserves legacy data and conflicts', async ({ page }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: `{ const exports = {}; ${compiled} window.TypeBridgeDb = exports; }` });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const legacy = [{ id: 'legacy', title: 'Русский', text: 'Привет 🙂', updatedAt: 1 }];
    const raw = JSON.stringify(legacy);
    localStorage.setItem('typebridge.drafts.v1', raw);
    const db = await api.openDraftDatabase();
    const imported = await api.migrateLegacyDrafts(db);
    const again = await api.migrateLegacyDrafts(db);
    const original = await api.getStoredDraft(db, 'legacy');
    if (!original) throw new Error('Missing migrated document');
    const [one, two] = await Promise.all([
      api.commitDraft(db, { ...original, text: 'First' }, original.revision),
      api.commitDraft(db, { ...original, text: 'Second' }, original.revision),
    ]);
    const current = await api.getStoredDraft(db, 'legacy');
    db.close();
    return { imported, again, legacyStill: localStorage.getItem('typebridge.drafts.v1') === raw, original, results: [one.ok, two.ok].sort(), current };
  });
  expect(result.imported).toBe(1);
  expect(result.again).toBe(0);
  expect(result.legacyStill).toBe(true);
  expect(result.original.text).toBe('Привет 🙂');
  expect(result.results).toEqual([false, true]);
  expect(['First', 'Second']).toContain(result.current?.text);
});

test('migration retains colliding documents and is idempotent', async ({ page }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: `{ const exports = {}; ${compiled} window.TypeBridgeDb = exports; }` });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    await api.commitDraft(db, { id: 'collision', title: 'Existing', text: 'Keep', updatedAt: 1 }, 0);
    const raw = JSON.stringify([{ id: 'new', title: 'New', text: 'New text', updatedAt: 1 }, { id: 'collision', title: 'Legacy', text: 'Keep legacy', updatedAt: 2 }]);
    localStorage.setItem('typebridge.drafts.v1', raw);
    const count = await api.migrateLegacyDrafts(db);
    const again = await api.migrateLegacyDrafts(db);
    const items = await api.listStoredDrafts(db);
    db.close();
    return { count, again, items, legacyStill: localStorage.getItem('typebridge.drafts.v1') === raw };
  });
  expect(result.count).toBe(2);
  expect(result.again).toBe(0);
  expect(result.legacyStill).toBe(true);
  expect(result.items.find(item => item.id === 'collision')?.text).toBe('Keep');
  expect(result.items.some(item => item.text === 'Keep legacy' && item.title.includes('legacy recovery'))).toBe(true);
});

test('stale edits are committed as a separate complete conflict draft', async ({ page }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: `{ const exports = {}; ${compiled} window.TypeBridgeDb = exports; }` });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const base = { id: 'doc', title: 'Русский', text: 'Первый', updatedAt: 1 };
    const first = await api.commitDraft(db, base, 0);
    if (!first.ok) throw new Error('initial write failed');
    const saved = await api.commitOrCreateConflictCopy(db, { ...base, text: 'Новее' }, 1, 'copy-unused');
    const conflict = await api.commitOrCreateConflictCopy(db, { ...base, text: 'Старый 🙂' }, 1, 'copy-1');
    const docs = await api.listStoredDrafts(db);
    db.close();
    return { saved, conflict, docs };
  });
  expect(result.saved.conflict).toBe(false);
  expect(result.conflict.conflict).toBe(true);
  expect(result.docs.find(draft => draft.id === 'doc')?.text).toBe('Новее');
  expect(result.docs.find(draft => draft.id === 'copy-1')?.text).toBe('Старый 🙂');
});

test('a failed migration transaction rolls back and can be retried', async ({ page }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: `{ const exports = {}; ${compiled} window.TypeBridgeDb = exports; }` });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const raw = JSON.stringify([{ id: 'rollback', title: 'Keep', text: 'Данные', updatedAt: 1 }, { bad: true }]);
    localStorage.setItem('typebridge.drafts.v1', raw);
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'metadata') throw new DOMException('Quota', 'QuotaExceededError');
      return put.apply(this, args);
    };
    let failed = false;
    try { await api.migrateLegacyDrafts(db); } catch { failed = true; }
    IDBObjectStore.prototype.put = put;
    const beforeRetry = await api.listStoredDrafts(db);
    const imported = await api.migrateLegacyDrafts(db);
    const afterRetry = await api.listStoredDrafts(db);
    const recovery = await api.legacyRecoveryInfo(db);
    db.close();
    return { failed, beforeRetry, imported, afterRetry, recovery, rawStill: localStorage.getItem('typebridge.drafts.v1') === raw };
  });
  expect(result.failed).toBe(true);
  expect(result.beforeRetry).toHaveLength(0);
  expect(result.imported).toBe(1);
  expect(result.afterRetry[0].text).toBe('Данные');
  expect(result.recovery.backups).toHaveLength(1);
  expect(result.rawStill).toBe(true);
});

test('a blocked upgrade reports the blocker and closes a late connection', async ({ page, context }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/typebridge/');
  await expect(page.locator('#editor')).toBeEnabled();
  const blocker = await context.newPage();
  await blocker.goto('/typebridge/');
  await expect(blocker.locator('#editor')).toBeEnabled();
  await blocker.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 1);
    open.onsuccess = () => { (window as unknown as { held: IDBDatabase }).held = open.result; resolve(); };
    open.onerror = () => reject(open.error);
  }));
  await page.addScriptTag({ content: `{ const exports = {}; ${compiled} window.TypeBridgeDb = exports; }` });
  const message = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((name: string) => original(name, 2)) as typeof indexedDB.open;
    try { await api.openDraftDatabase(); return 'unexpected success'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    finally { indexedDB.open = original; }
  });
  expect(message).toContain('Close other TypeBridge tabs');
  await blocker.evaluate(() => (window as unknown as { held: IDBDatabase }).held.close());
  const nextUpgrade = await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 3);
    open.onblocked = () => resolve(false);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolve(true); };
  }));
  expect(nextUpgrade).toBe(true);
});
