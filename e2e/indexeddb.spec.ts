import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('IndexedDB migration is atomic, restartable and preserves legacy data and conflicts', async ({ page }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/typebridge/');
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

test('migration collision aborts all changes without overwriting legacy data', async ({ page }) => {
  const compiled = ts.transpileModule(readFileSync('src/editor/indexeddb.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  await page.goto('/typebridge/');
  await page.addScriptTag({ content: `{ const exports = {}; ${compiled} window.TypeBridgeDb = exports; }` });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    await api.commitDraft(db, { id: 'collision', title: 'Existing', text: 'Keep', updatedAt: 1 }, 0);
    const raw = JSON.stringify([{ id: 'new', title: 'New', text: 'New text', updatedAt: 1 }, { id: 'collision', title: 'Legacy', text: 'Keep legacy', updatedAt: 2 }]);
    localStorage.setItem('typebridge.drafts.v1', raw);
    let rejected = false;
    try { await api.migrateLegacyDrafts(db); } catch { rejected = true; }
    const items = await api.listStoredDrafts(db);
    const legacyStill = localStorage.getItem('typebridge.drafts.v1') === raw;
    db.close();
    return { rejected, items, legacyStill };
  });
  expect(result.rejected).toBe(true);
  expect(result.legacyStill).toBe(true);
  expect(result.items.map(item => item.id)).toEqual(['collision']);
  expect(result.items[0].text).toBe('Keep');
});
