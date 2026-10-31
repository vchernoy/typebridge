import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('stale edits are committed as a separate complete conflict draft', async ({ page }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/');
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

test('a blocked upgrade reports the blocker and closes a late connection', async ({ page, context }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  const blocker = await context.newPage();
  await blocker.goto('/');
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
