import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const transpile = (path: string): string => ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
/** indexeddb.ts as a browser script exposing window.TypeBridgeDb; its one import is the ownership helpers. */
function compiledDatabaseModule(): string {
  return `{ const ownership = {}; ((exports) => { ${transpile('src/view/ownership.ts')} })(ownership);
    const exports = {}; const require = () => ownership; ${transpile('src/editor/indexeddb.ts')} window.TypeBridgeDb = exports; }`;
}

test('stale edits are committed as a separate complete conflict draft', async ({ page }) => {
  const compiled = compiledDatabaseModule();
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: compiled });
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
  const compiled = compiledDatabaseModule();
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const blocker = await context.newPage();
  await blocker.goto('/editor.html');
  await expect(blocker.locator('#editor')).toBeEnabled();
  await blocker.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onsuccess = () => { (window as unknown as { held: IDBDatabase }).held = open.result; resolve(); };
    open.onerror = () => reject(open.error);
  }));
  await page.addScriptTag({ content: compiled });
  const message = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const original = indexedDB.open.bind(indexedDB);
    indexedDB.open = ((name: string) => original(name, 4)) as typeof indexedDB.open;
    try { await api.openDraftDatabase(); return 'unexpected success'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    finally { indexedDB.open = original; }
  });
  expect(message).toContain('Close other TypeBridge tabs');
  await blocker.evaluate(() => (window as unknown as { held: IDBDatabase }).held.close());
  const nextUpgrade = await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 5);
    open.onblocked = () => resolve(false);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolve(true); };
  }));
  expect(nextUpgrade).toBe(true);
});

test('the ownership fence gates commits and deletes in the same transaction (#159 W4)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const stores = [...db.objectStoreNames].sort();
    const read = (store: string, key: string) => new Promise<unknown>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const failure = async (run: () => Promise<unknown>) => { try { await run(); return 'wrote'; } catch (error) { return (error as Error).name; } };
    const base = { id: 'doc', title: 'Заметка', text: 'Первый', updatedAt: 1 };
    const first = await api.claimEditOwnership(db, 'doc', 'window-a', 1);
    const saved = await api.commitOrCreateConflictCopy(db, base, 0, 'copy-a', { instanceId: 'window-a', fence: first });
    const second = await api.claimEditOwnership(db, 'doc', 'window-b', 2);
    const staleCommit = await failure(() => api.commitOrCreateConflictCopy(db, { ...base, text: 'Устаревшая правка' }, 1, 'copy-b', { instanceId: 'window-a', fence: first }));
    const wrongWindow = await failure(() => api.commitOrCreateConflictCopy(db, { ...base, text: 'Чужая правка' }, 1, 'copy-c', { instanceId: 'window-a', fence: second }));
    const staleDelete = await failure(() => api.deleteStoredDraft(db, 'doc', 1, { instanceId: 'window-a', fence: first }, true));
    const afterStale = await read('documents', 'doc') as { text: string; revision: number };
    const copies = await api.listStoredDrafts(db);
    // An older build without ownership still writes; the owner's CAS then makes a conflict copy.
    await api.commitDraft(db, { ...base, text: 'Старая версия приложения' }, 1);
    const conflict = await api.commitOrCreateConflictCopy(db, { ...base, text: 'Правка владельца' }, 1, 'copy-d', { instanceId: 'window-b', fence: second });
    // Releasing someone else's fence is a no-op; releasing your own keeps the counter.
    await api.releaseEditOwnership(db, 'doc', { instanceId: 'window-a', fence: first }, 3);
    const notMine = await read('editOwnership', 'doc');
    await api.releaseEditOwnership(db, 'doc', { instanceId: 'window-b', fence: second }, 4);
    const released = await read('editOwnership', 'doc');
    const afterRelease = await api.claimEditOwnership(db, 'doc', 'window-c', 5);
    const deleted = await api.deleteStoredDraft(db, 'doc', 2, { instanceId: 'window-c', fence: afterRelease }, true);
    const droppedRecord = await read('editOwnership', 'doc');
    // A never-saved document's fence record is removed on release.
    const draftFence = await api.claimEditOwnership(db, 'unsaved', 'window-c', 6);
    await api.releaseEditOwnership(db, 'unsaved', { instanceId: 'window-c', fence: draftFence }, 7);
    const unsavedRecord = await read('editOwnership', 'unsaved');
    db.close();
    return { stores, first, second, saved: saved.draft.revision, staleCommit, wrongWindow, staleDelete, afterStale, copyCount: copies.length,
      conflict: { flag: conflict.conflict, id: conflict.draft.id }, notMine, released, afterRelease, deleted, droppedRecord, unsavedRecord };
  });
  expect(result.stores).toEqual(['changes', 'documents', 'editOwnership']);
  expect([result.first, result.second]).toEqual([1, 2]);
  expect(result.saved).toBe(1);
  expect(result.staleCommit).toBe('EditOwnershipLostError');
  expect(result.wrongWindow).toBe('EditOwnershipLostError');
  expect(result.staleDelete).toBe('EditOwnershipLostError');
  expect(result.afterStale).toMatchObject({ text: 'Первый', revision: 1 });
  expect(result.copyCount).toBe(1);
  expect(result.conflict).toEqual({ flag: true, id: 'copy-d' });
  expect(result.notMine).toMatchObject({ ownerInstanceId: 'window-b', fence: 2 });
  expect(result.released).toMatchObject({ ownerInstanceId: '', fence: 2 });
  expect(result.afterRelease).toBe(3);
  expect(result.deleted).toBe(true);
  expect(result.droppedRecord).toBeUndefined();
  expect(result.unsavedRecord).toBeUndefined();
});

test('upgrading a version 1 database keeps documents and adds the ownership and change-log stores', async ({ page }) => {
  // A static asset: same origin, but the app does not run and create the database first.
  await page.goto('/icon-192.png');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('documents', { keyPath: 'id' }).put({ id: 'old', title: 'Старый', text: 'Текст v1', updatedAt: 1, revision: 3 }); };
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  }));
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toHaveValue('Текст v1');
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  const stores = await page.evaluate(() => new Promise<{ version: number; names: string[] }>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onsuccess = () => { const db = open.result; resolve({ version: db.version, names: [...db.objectStoreNames].sort() }); db.close(); };
    open.onerror = () => reject(open.error);
  }));
  expect(stores).toEqual({ version: 3, names: ['changes', 'documents', 'editOwnership'] });
});


for (const operation of ['direct', 'save'] as const) {
  test(`aborting a real ${operation} transaction after request success preserves the committed document (#37 R2a)`, async ({ page }) => {
    await page.goto('/editor.html');
    await expect(page.locator('#editor')).toBeEnabled();
    await page.addScriptTag({ content: compiledDatabaseModule() });
    const result = await page.evaluate(async operation => {
      const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
      const db = await api.openDraftDatabase();
      const base = {
        id: crypto.randomUUID(), title: 'Прежний заголовок', text: 'Прежний текст 🙂', updatedAt: 1,
        history: { v: 1 as const, current: 'Прежний текст 🙂', undo: [], redo: [] },
      };
      const initial = await api.commitDraft(db, base, 0);
      if (!initial.ok) throw new Error('Initial commit failed');
      const put = IDBObjectStore.prototype.put;
      let requestSucceeded = false;
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
        const request = put.apply(this, args);
        if (this.name === 'documents' && (args[0] as { id: string }).id === base.id) {
          request.addEventListener('success', () => {
            requestSucceeded = true;
            this.transaction.abort();
          });
        }
        return request;
      };
      let rejected = false;
      try {
        const changed = { ...base, title: 'Новый заголовок', text: 'Новый текст', updatedAt: 2 };
        if (operation === 'direct') await api.commitDraft(db, changed, 1);
        else await api.commitOrCreateConflictCopy(db, changed, 1, crypto.randomUUID());
      } catch { rejected = true; }
      finally { IDBObjectStore.prototype.put = put; }
      try { return { requestSucceeded, rejected, stored: await api.getStoredDraft(db, base.id), base }; }
      finally { db.close(); }
    }, operation);
    expect(result.requestSucceeded).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.stored).toEqual({ ...result.base, revision: 1 });
  });
}

test('the change log: fenced appends, cleanup by upTo, clear on demand and on delete (#37 R2c)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const seqs = async (id: string) => (await api.listChanges(db, id)).map(r => r.seq);
    const failure = async (run: () => Promise<unknown>) => { try { await run(); return 'wrote'; } catch (error) { return (error as Error).name; } };
    const record = (documentId: string, seq: number) => ({ documentId, seq, run: 'run-a', change: [0, '', 'а'] as [number, string, string], length: seq });
    const fence = await api.claimEditOwnership(db, 'log', 'window-a', 1);
    const owner = { instanceId: 'window-a', fence };
    await api.commitOrCreateConflictCopy(db, { id: 'log', title: 'Журнал', text: '', updatedAt: 1 }, 0, 'copy-1', owner);
    for (let seq = 1; seq <= 5; seq++) await api.appendChange(db, record('log', seq), owner);
    const appended = await seqs('log');
    // A save that contains changes up to 3 removes exactly those.
    const saved = await api.commitOrCreateConflictCopy(db, { id: 'log', title: 'Журнал', text: 'ааа', updatedAt: 2, upTo: 3 }, 1, 'copy-2', owner);
    const afterSave = await seqs('log');
    // Another window took editing over: the old window cannot extend the log.
    const taken = await api.claimEditOwnership(db, 'log', 'window-b', 3);
    const staleAppend = await failure(() => api.appendChange(db, record('log', 6), owner));
    const afterStale = await seqs('log');
    // A save no run continues clears the log, except the new run that starts from its text.
    await api.appendChange(db, record('log', 6), { instanceId: 'window-b', fence: taken });
    await api.appendChange(db, { ...record('log', 1), run: 'run-new' }, { instanceId: 'window-b', fence: taken });
    await api.commitOrCreateConflictCopy(db, { id: 'log', title: 'Журнал', text: 'новый', updatedAt: 3, upTo: 0 }, 2, 'copy-3', { instanceId: 'window-b', fence: taken }, { keepRun: 'run-new' });
    const afterClear = await seqs('log');
    // A crashed run's record past upTo never survives a save of the run that continues the text.
    await api.appendChange(db, { ...record('log', 7), run: 'crashed' });
    await api.appendChange(db, { ...record('log', 2), run: 'run-new' }, { instanceId: 'window-b', fence: taken });
    await api.commitOrCreateConflictCopy(db, { id: 'log', title: 'Журнал', text: 'новыйа', updatedAt: 3, upTo: 1 }, 3, 'copy-4', { instanceId: 'window-b', fence: taken }, { keepRun: 'run-new' });
    const afterPrune = await seqs('log');
    // Deleting the document deletes its log; other documents keep theirs.
    await api.appendChange(db, record('log', 1), { instanceId: 'window-b', fence: taken });
    await api.appendChange(db, record('other', 1));
    const deleted = await api.deleteStoredDraft(db, 'log', 4, { instanceId: 'window-b', fence: taken }, true);
    const afterDelete = { log: await seqs('log'), other: await seqs('other') };
    db.close();
    return { appended, savedUpTo: saved.draft.upTo, afterSave, staleAppend, afterStale, afterClear, afterPrune, deleted, afterDelete };
  });
  expect(result).toEqual({
    appended: [1, 2, 3, 4, 5], savedUpTo: 3, afterSave: [4, 5], staleAppend: 'EditOwnershipLostError', afterStale: [4, 5],
    afterClear: [1], afterPrune: [2], deleted: true, afterDelete: { log: [], other: [1] },
  });
});
