import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const transpile = (path: string): string => ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
/** indexeddb.ts as a browser script exposing window.TypeBridgeDb; its one import is the ownership helpers. */
function compiledDatabaseModule(): string {
  return `{ const ownership = {}; ((exports) => { ${transpile('src/view/ownership.ts')} })(ownership);
    const fields = {}; ((exports) => { ${transpile('src/editor/document-fields.ts')} })(fields);
    const modules = { './document-fields': fields, '../view/ownership': ownership };
    const require = name => modules[name];
    const changeLog = {}; ((exports) => { ${transpile('src/editor/change-log.ts')} })(changeLog);
    modules['./change-log'] = changeLog;
    const exports = {}; ${transpile('src/editor/indexeddb.ts')} window.TypeBridgeDb = exports; }`;
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
    indexedDB.open = ((name: string) => original(name, 7)) as typeof indexedDB.open;
    try { await api.openDraftDatabase(); return 'unexpected success'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    finally { indexedDB.open = original; }
  });
  expect(message).toContain('Close other TypeBridge tabs');
  await blocker.evaluate(() => (window as unknown as { held: IDBDatabase }).held.close());
  const nextUpgrade = await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 8);
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
  expect(stores).toEqual({ version: 6, names: ['changes', 'documents', 'editOwnership'] });
});


test('a version 4 database from #256 opens, keeps its documents, clears its old log, and drops discardMarkers (#257)', async ({ page }) => {
  await page.goto('/icon-192.png');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 4);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('documents', { keyPath: 'id' }).put({ id: 'v4', title: 'Четыре', text: 'Текст v4', updatedAt: 1, revision: 2, upTo: 0 });
      db.createObjectStore('editOwnership', { keyPath: 'documentId' });
      db.createObjectStore('changes', { keyPath: ['documentId', 'seq'] }).put({ documentId: 'v4', seq: 1, run: 'r', change: [0, '', 'x'], length: 1 });
      db.createObjectStore('discardMarkers', { keyPath: 'documentId' }).put({ documentId: 'v4', upToSeq: 1, instanceId: 'i', fence: 1 });
    };
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  }));
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  const stores = await page.evaluate(() => new Promise<{ version: number; names: string[]; documents: number }>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onsuccess = () => {
      const db = open.result;
      const names = [...db.objectStoreNames].sort();
      const count = db.transaction('documents').objectStore('documents').count();
      count.onsuccess = () => { resolve({ version: db.version, names, documents: count.result }); db.close(); };
      count.onerror = () => reject(count.error);
    };
    open.onerror = () => reject(open.error);
  }));
  expect(stores.version).toBe(6);
  expect(stores.names).toEqual(['changes', 'documents', 'editOwnership']);
  expect(stores.documents).toBeGreaterThanOrEqual(1);
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
        find: 'Прежний поиск', replace: 'Прежняя замена',
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
        const changed = { ...base, title: 'Новый заголовок', text: 'Новый текст', find: 'Новый поиск', replace: 'Новая замена', updatedAt: 2 };
        if (operation === 'direct') await api.commitDraft(db, changed, 1);
        else await api.commitOrCreateConflictCopy(db, changed, 1, crypto.randomUUID());
      } catch { rejected = true; }
      finally { IDBObjectStore.prototype.put = put; }
      try { return { requestSucceeded, rejected, stored: await api.getStoredDraft(db, base.id), base }; }
      finally { db.close(); }
    }, operation);
    expect(result.requestSucceeded).toBe(true);
    expect(result.rejected).toBe(true);
    expect(result.stored).toEqual({ ...result.base, format: 'plain', revision: 1 });
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
    const record = (documentId: string, seq: number) => ({ documentId, seq, run: 'run-a', field: 'text' as const, value: 'а'.repeat(seq), previous: 'а'.repeat(seq - 1) });
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
    await api.commitOrCreateConflictCopy(db, { id: 'log', title: 'Журнал', text: 'новый', updatedAt: 3, upTo: 0 }, 2, 'copy-3', { instanceId: 'window-b', fence: taken }, { keepRun: 'run-new', recoveryId: 'unused' });
    const afterClear = await seqs('log');
    // A crashed run's record past upTo never survives a save of the run that continues the text.
    await api.appendChange(db, { ...record('log', 7), run: 'crashed' });
    await api.appendChange(db, { ...record('log', 2), run: 'run-new' }, { instanceId: 'window-b', fence: taken });
    await api.commitOrCreateConflictCopy(db, { id: 'log', title: 'Журнал', text: 'новыйа', updatedAt: 3, upTo: 1 }, 3, 'copy-4', { instanceId: 'window-b', fence: taken }, { keepRun: 'run-new', recoveryId: 'unused' });
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

test('crash recovery from the change log keeps another run\'s text as a copy, once (#37 R2c)', async ({ page }) => {
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const fence = await api.claimEditOwnership(db, 'crash', 'window-a', 1);
    const owner = { instanceId: 'window-a', fence };
    await api.commitOrCreateConflictCopy(db, { id: 'crash', title: 'Заметка', text: 'Привет', updatedAt: 1 }, 0, 'c1', owner);
    // A window that crashed had typed ", мир 🙂" after the stored row.
    const crashed = (seq: number, value: string, previous = 'Привет') => ({ documentId: 'crash', seq, run: 'crashed', field: 'text' as const, value, previous });
    await api.appendChange(db, crashed(1, 'Привет, мир'), owner);
    await api.appendChange(db, crashed(2, 'Привет, мир 🙂', 'Привет, мир'), owner);
    const copy = await api.salvageChanges(db, 'crash', owner, 'rec-1', undefined, 5);
    const left = await api.listChanges(db, 'crash');
    const again = await api.salvageChanges(db, 'crash', owner, 'rec-2', undefined, 6);
    // Lost text that is only what this window shows (a reload backup, a handoff) is not stored
    // yet: no copy, and the records stay (#252 review). Title must match too (#37 R2c 2d-1).
    await api.appendChange(db, crashed(1, 'Привет!'), owner);
    const shown = await api.salvageChanges(db, 'crash', owner, 'rec-3', undefined, 7, { text: 'Привет!', title: 'Заметка' });
    const keptForShown = (await api.listChanges(db, 'crash')).length;
    // ...so after another restart (nothing shown) the same text is still recovered.
    const afterRestart = await api.salvageChanges(db, 'crash', owner, 'rec-3', undefined, 8);
    // A save that stores the lost text itself removes the records with no copy, in one transaction.
    await api.appendChange(db, crashed(1, 'Привет#'), owner);
    const sameText = await api.commitOrCreateConflictCopy(db, { id: 'crash', title: 'Заметка', text: 'Привет#', updatedAt: 9, upTo: 0 }, 1, 'c3', owner, { keepRun: 'mine', recoveryId: 'rec-x' });
    const afterSameText = (await api.listChanges(db, 'crash')).length;
    // A save of a new run first keeps a crashed run's text, in the same transaction.
    await api.appendChange(db, crashed(1, 'Привет#?', 'Привет#'), owner);
    const saved = await api.commitOrCreateConflictCopy(db, { id: 'crash', title: 'Заметка', text: 'Привет, друг', updatedAt: 10, upTo: 0 }, 2, 'c2', owner, { keepRun: 'mine', recoveryId: 'rec-4' });
    const original = await api.getStoredDraft(db, 'crash');
    const ids = (await api.listStoredDrafts(db)).map(d => d.id).sort();
    db.close();
    return {
      copy: copy && { id: copy.id, title: copy.title, text: copy.text }, left: left.length, again, shown, keptForShown,
      afterRestart: afterRestart?.text, sameText: sameText.recovered, afterSameText,
      saved: saved.recovered && { id: saved.recovered.id, text: saved.recovered.text }, original: original?.text, ids,
    };
  });
  expect(result).toEqual({
    copy: { id: 'rec-1', title: 'Заметка (recovered)', text: 'Привет, мир 🙂' }, left: 0, again: undefined, shown: undefined, keptForShown: 1,
    afterRestart: 'Привет!', sameText: undefined, afterSameText: 0,
    saved: { id: 'rec-4', text: 'Привет#?' }, original: 'Привет, друг', ids: ['crash', 'rec-1', 'rec-3', 'rec-4'],
  });
});

test('clearDocumentChanges removes every run of the document under the ownership fence (#254)', async ({ page }) => {
  // Fails if clear still requires a run id, leaves other runs, clears without a fence, or touches other docs.
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const fence = await api.claimEditOwnership(db, 'discard', 'window-a', 1);
    const owner = { instanceId: 'window-a', fence };
    await api.commitOrCreateConflictCopy(db, { id: 'discard', title: 'T', text: 'a', updatedAt: 1 }, 0, 'c1', owner);
    await api.commitOrCreateConflictCopy(db, { id: 'other-doc', title: 'O', text: 'x', updatedAt: 1 }, 0, 'c2');
    const rec = (documentId: string, seq: number, run: string, inserted: string) => ({
      documentId, seq, run, field: 'text' as const, value: 'a' + inserted, previous: 'a',
    });
    await api.appendChange(db, rec('discard', 1, 'mine', 'b'), owner);
    await api.appendChange(db, rec('discard', 2, 'other', 'c'));
    await api.appendChange(db, rec('other-doc', 1, 'keep', 'y'));
    await api.clearDocumentChanges(db, 'discard', owner);
    const left = await api.listChanges(db, 'discard');
    const otherDoc = await api.listChanges(db, 'other-doc');
    const stale = await (async () => {
      try {
        await api.clearDocumentChanges(db, 'discard', undefined as unknown as { instanceId: string; fence: number });
        return 'cleared-without-owner';
      } catch (error) {
        return (error as Error).name === 'EditOwnershipLostError' ? 'refused' : 'other-error';
      }
    })();
    const foreign = await (async () => {
      try {
        await api.clearDocumentChanges(db, 'other-doc', { instanceId: 'window-b', fence: 1 });
        return 'cleared-by-foreign';
      } catch (error) {
        return (error as Error).name === 'EditOwnershipLostError' ? 'fenced' : 'other-error';
      }
    })();
    const afterForeign = await api.listChanges(db, 'other-doc');
    db.close();
    return {
      left: left.length,
      otherDoc: otherDoc.map(r => r.run),
      stale,
      foreign,
      afterForeign: afterForeign.map(r => r.run),
    };
  });
  expect(result).toEqual({
    left: 0,
    otherDoc: ['keep'],
    stale: 'refused',
    foreign: 'fenced',
    afterForeign: ['keep'],
  });
});

test('crash recovery restores a renamed title from the change log (#37 R2c 2d-1)', async ({ page }) => {
  // Fails on old code: recovered copy uses the stored title; title-only loss makes no copy;
  // shownText alone (wrong title) still keeps records incorrectly, or drops them without matching title.
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const fence = await api.claimEditOwnership(db, 'title-crash', 'window-a', 1);
    const owner = { instanceId: 'window-a', fence };
    await api.commitOrCreateConflictCopy(db, { id: 'title-crash', title: 'Старое', text: 'Текст', updatedAt: 1 }, 0, 'c1', owner);
    // Crashed run renamed the document and typed more.
    await api.appendChange(db, {
      documentId: 'title-crash', seq: 1, run: 'crashed', field: 'title', value: 'Новое имя', previous: 'Старое',
    }, owner);
    await api.appendChange(db, {
      documentId: 'title-crash', seq: 2, run: 'crashed', field: 'text', value: 'Текст!', previous: 'Текст',
    }, owner);
    const renamed = await api.salvageChanges(db, 'title-crash', owner, 'rec-title', undefined, 2);
    // Title-only loss (text unchanged) still produces a copy with the new title.
    await api.appendChange(db, {
      documentId: 'title-crash', seq: 1, run: 'crashed', field: 'title', value: 'Только заголовок', previous: 'Старое',
    }, owner);
    const titleOnly = await api.salvageChanges(db, 'title-crash', owner, 'rec-title-only', undefined, 3);
    // Shown text + shown title equal to the lost state keeps the records (rule 5).
    await api.appendChange(db, {
      documentId: 'title-crash', seq: 1, run: 'crashed', field: 'title', value: 'Показанное', previous: 'Старое',
    }, owner);
    const kept = await api.salvageChanges(db, 'title-crash', owner, 'rec-keep', undefined, 4, { text: 'Текст', title: 'Показанное' });
    const keptCount = (await api.listChanges(db, 'title-crash')).length;
    // Shown text alone with a different title still salvages (title is part of lost state).
    const wrongTitle = await api.salvageChanges(db, 'title-crash', owner, 'rec-wrong', undefined, 5, { text: 'Текст', title: 'Другое' });
    db.close();
    return {
      renamed: renamed && { title: renamed.title, text: renamed.text },
      titleOnly: titleOnly && { title: titleOnly.title, text: titleOnly.text },
      kept, keptCount,
      wrongTitle: wrongTitle && { title: wrongTitle.title, text: wrongTitle.text },
    };
  });
  expect(result).toEqual({
    renamed: { title: 'Новое имя (recovered)', text: 'Текст!' },
    titleOnly: { title: 'Только заголовок (recovered)', text: 'Текст' },
    kept: undefined, keptCount: 1,
    wrongTitle: { title: 'Показанное (recovered)', text: 'Текст' },
  });
});

test('v6 clears the incompatible log, keeps rows/ownership, and reads missing search as empty (#257 2a)', async ({ page }) => {
  await page.goto('/icon-192.png');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 5);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('documents', { keyPath: 'id' }).put({ id: 'old', text: 'body', title: 'T', history: { v: 1, current: 'body', undo: [], redo: [] }, revision: 4, upTo: 9, updatedAt: 1, private: true });
      db.createObjectStore('editOwnership', { keyPath: 'documentId' }).put({ documentId: 'old', ownerInstanceId: '', fence: 7, updatedAt: 1 });
      db.createObjectStore('changes', { keyPath: ['documentId', 'seq'] }).put({ documentId: 'old', seq: 10, run: 'old-run', change: [4, '', 'not migrated'], length: 16 });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { open.result.close(); resolve(); };
  }));
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const row = await api.getStoredDraft(db, 'old');
    const changes = await api.listChanges(db, 'old');
    const fence = await api.claimEditOwnership(db, 'old', 'next', 2);
    const version = db.version;
    db.close();
    return { row, changes, fence, version };
  });
  expect(result.version).toBe(6);
  expect(result.row).toMatchObject({ text: 'body', title: 'T', find: '', replace: '', revision: 4, upTo: 9, private: true, history: { current: 'body', undo: [], redo: [] } });
  expect(result.changes).toEqual([]);
  expect(result.fence).toBe(8);
});

test('four-field replay recovers one prefix and preserves search-only loss at salvage/save (#257 2a)', async ({ page }) => {
  await page.goto('/icon-192.png');
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const fence = await api.claimEditOwnership(db, 'four', 'owner', 1);
    const owner = { instanceId: 'owner', fence };
    const base = { id: 'four', text: 'body', title: 'Title', find: 'old find', replace: 'old replace', updatedAt: 1 };
    await api.commitOrCreateConflictCopy(db, base, 0, 'unused', owner);
    await api.appendChange(db, { documentId: 'four', seq: 1, run: 'crashed', field: 'find', value: 'query', previous: 'old find' }, owner);
    await api.appendChange(db, { documentId: 'four', seq: 2, run: 'crashed', field: 'text', change: [4, '', 'x'.repeat(256)], length: 260 }, owner);
    await api.appendChange(db, { documentId: 'four', seq: 3, run: 'crashed', field: 'title', value: 'Renamed', previous: 'Title' }, owner);
    // Missing seq 4: a later replacement must not be combined with the earlier prefix.
    await api.appendChange(db, { documentId: 'four', seq: 5, run: 'crashed', field: 'replace', value: 'past gap', previous: 'old replace' }, owner);
    const recovered = await api.salvageChanges(db, 'four', owner, 'prefix', undefined, 2);
    const left = await api.listChanges(db, 'four');
    // Search-only loss must not be mistaken for the shown or newly committed text/title.
    await api.appendChange(db, { documentId: 'four', seq: 1, run: 'crashed', field: 'replace', value: 'lost replace', previous: 'old replace' }, owner);
    const searchOnly = await api.salvageChanges(db, 'four', owner, 'search-only', undefined, 3, base);
    await api.appendChange(db, { documentId: 'four', seq: 1, run: 'crashed', field: 'find', value: 'lost find', previous: 'old find' }, owner);
    const saved = await api.commitOrCreateConflictCopy(db, { ...base, find: 'saved find', upTo: 0 }, 1, 'unused-2', owner, { keepRun: 'new', recoveryId: 'save-recovery' });
    // A conflict copy keeps all four values (but starts with its own upTo).
    const conflict = await api.commitOrCreateConflictCopy(db, { ...base, find: 'conflict find', replace: 'conflict replace', upTo: 99 }, 1, 'conflict', owner);
    db.close();
    return { recovered, left, searchOnly, saved, conflict };
  });
  expect(result.recovered).toMatchObject({ title: 'Renamed (recovered)', text: 'body' + 'x'.repeat(256), find: 'query', replace: 'old replace', upTo: 0 });
  expect(result.left).toEqual([]);
  expect(result.searchOnly).toMatchObject({ text: 'body', title: 'Title (recovered)', replace: 'lost replace' });
  expect(result.saved.recovered).toMatchObject({ find: 'lost find', replace: 'old replace' });
  expect(result.saved.draft).toMatchObject({ find: 'saved find', replace: 'old replace' });
  expect(result.conflict).toMatchObject({ conflict: true, draft: { find: 'conflict find', replace: 'conflict replace', upTo: 0 } });
});

/** Actual model/storage modules in a browser; deliberately no step-2b search UI binding. */
function compiledPrivacyModel(): string {
  const modules = [
    ['./document-fields', 'src/editor/document-fields.ts'],
    ['./drafts', 'src/editor/drafts.ts'],
    ['./privacy', 'src/editor/privacy.ts'],
    ['./change-log', 'src/editor/change-log.ts'],
    ['./change-writer', 'src/view/change-writer.ts'],
    ['./reload-backup', 'src/view/reload-backup.ts'],
    ['./recovery-data', 'src/editor/recovery.ts'],
    ['./recovery', 'src/view/recovery.ts'],
  ];
  return `{ const modules = { '../editor/indexeddb': window.TypeBridgeDb, '../ui/confirm-dialog': { askConfirmChoice: async () => false } };
    const require = name => modules[name];
    ${modules.map(([key, path]) => `{ const exports = {}; ${transpile(path)} modules['${key}'] = exports; }\n` +
      (key === './document-fields' ? "modules['../editor/document-fields'] = modules['./document-fields'];" : '') +
      (key === './drafts' ? "modules['../editor/drafts'] = modules['./drafts'];" : '') +
      (key === './change-log' ? "modules['../editor/change-log'] = modules['./change-log'];" : '') +
      (key === './recovery-data' ? "modules['../editor/recovery'] = modules['./recovery-data'];" : '')).join('\n')}
    window.TypeBridgePrivacyModel = Object.assign({}, ...Object.values(modules)); }`;
}

for (const global of [false, true]) {
  test(`four-field model ${global ? 'session' : 'document'} privacy blocks search log/journal/reload writes (#257 2a)`, async ({ page }) => {
    await page.goto('/icon-192.png');
    await page.addScriptTag({ content: compiledDatabaseModule() });
    await page.addScriptTag({ content: compiledPrivacyModel() });
    const result = await page.evaluate(async global => {
      const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
      type Model = typeof import('../src/view/change-writer') & typeof import('../src/editor/privacy') & typeof import('../src/view/reload-backup') & typeof import('../src/view/recovery');
      const model = (window as unknown as { TypeBridgePrivacyModel: Model }).TypeBridgePrivacyModel;
      const db = await api.openDraftDatabase();
      const fence = await api.claimEditOwnership(db, 'private-four', 'owner', 1);
      const owner = { instanceId: 'owner', fence };
      const initial = { id: 'private-four', text: 'public body', title: 'public title', find: 'public find', replace: 'public replace', revision: 1, updatedAt: 1, private: false };
      await api.commitOrCreateConflictCopy(db, initial, 0, 'unused', owner);
      const state = { active: { ...initial } } as import('../src/view/editor-state').EditorState;
      const field = document.createElement('textarea'); field.value = initial.text;
      const title = document.createElement('input'); title.value = initial.title;
      const mayWrite = () => !model.privateNow(state.active);
      const snapshot = () => ({ ...state.active, text: field.value, title: title.value });
      const writer = model.createChangeWriter({
        mayRecord: mayWrite, shown: () => ({ id: initial.id, generation: 1 }), fields: snapshot,
        append: record => api.appendChange(db, record, owner), newRunId: () => 'run',
      });
      const anchor = writer.upToForSave(initial.id, initial);
      writer.saved(anchor.keepRun, true);
      const recovery = model.createRecovery(state, {} as import('../src/ui/status-line').StatusLine, {
        viewMode: false, autosave: document.createElement('input'), mayWrite, field, draftTitle: title, anchor: field,
        postSignal: () => {}, refreshDrafts: async () => {},
        changeLogProtects: () => false, changeLogIdle: writer.idle, indexedDbUsable: () => true,
      });
      const backup = model.createReloadBackup({ key: 'test.pending', snapshot, mayBackUp: mayWrite, onFailed: () => {} });
      state.active.find = 'public logged find'; writer.edit();
      state.active.replace = 'public logged replace'; writer.edit();
      recovery.journalEdit(); backup.save();
      if (global) model.setPrivateSessionOn(true);
      else state.active.private = true;
      field.value = 'SECRET body'; title.value = 'SECRET title';
      state.active.find = 'SECRET find'; state.active.replace = 'SECRET replace';
      writer.edit(); recovery.journalEdit(); backup.save();
      await writer.idle();
      const rows = await api.listStoredDrafts(db);
      const changes = await api.listChanges(db, initial.id);
      const journal = recovery.currentJournal();
      const pending = backup.read();
      const storage = JSON.stringify({ rows, changes, local: { ...localStorage }, session: { ...sessionStorage } });
      db.close();
      return { storage, changes, journal, pending };
    }, global);
    expect(result.storage).not.toContain('SECRET');
    expect(result.changes.map(r => [r.seq, r.field, r.value])).toEqual([[1, 'find', 'public logged find'], [2, 'replace', 'public logged replace']]);
    expect(result.journal).toMatchObject({ text: 'public body', title: 'public title', find: 'public logged find', replace: 'public logged replace' });
    expect(result.pending).toMatchObject({ text: 'public body', title: 'public title', find: 'public logged find', replace: 'public logged replace' });
  });
}

test('the editor carries four stored fields through autosave and a search-only reload backup (#257 2a)', async ({ page }) => {
  await page.goto('/icon-192.png');
  await page.addScriptTag({ content: compiledDatabaseModule() });
  await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const row = { id: '12345678-1234-4234-8234-123456789abc', text: 'body', title: 'Title', find: 'stored find', replace: 'stored replace', updatedAt: 1 };
    await api.commitDraft(db, row, 0);
    // Only search differs: boot must not mistake this backup for already saved content.
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({ ...row, revision: 1, find: 'reload find', replace: 'reload replace' }));
    db.close();
  });
  await page.goto('/editor.html');
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('body after reload');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const read = () => page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    try { return await api.getStoredDraft(db, '12345678-1234-4234-8234-123456789abc'); }
    finally { db.close(); }
  });
  await expect.poll(read).toMatchObject({ text: 'body after reload', title: 'Title', find: 'reload find', replace: 'reload replace' });
  await page.reload();
  await expect(page.locator('#editor')).toHaveValue('body after reload');
  await page.addScriptTag({ content: compiledDatabaseModule() });
  expect(await read()).toMatchObject({ text: 'body after reload', find: 'reload find', replace: 'reload replace' });
});

for (const abort of [false, true]) {
  test(`conflict-copy run cleanup ${abort ? 'rolls back with an aborted copy' : 'prevents duplicate salvage and preserves other runs/documents'} (#265)`, async ({ page }) => {
    await page.goto('/icon-192.png');
    await page.addScriptTag({ content: compiledDatabaseModule() });
    const result = await page.evaluate(async abort => {
      const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
      const db = await api.openDraftDatabase();
      const owner = { instanceId: 'owner', fence: await api.claimEditOwnership(db, 'original', 'owner', 1) };
      const base = { id: 'original', text: 'base', title: 'Title', find: '', replace: '', updatedAt: 1 };
      await api.commitDraft(db, base, 0);
      await api.appendChange(db, { documentId: base.id, seq: 1, run: 'mine', field: 'text', value: 'my edit', previous: 'base' }, owner);
      await api.appendChange(db, { documentId: base.id, seq: 2, run: 'other', field: 'find', value: 'other search', previous: '' }, owner);
      await api.appendChange(db, { documentId: 'other-document', seq: 1, run: 'mine', field: 'text', value: 'other body', previous: '' });
      // An older writer changed the row without advancing its log position.
      await api.commitDraft(db, { ...base, text: 'foreign revision', upTo: 0 }, 1);
      const originalDelete = IDBObjectStore.prototype.delete;
      let abortedAtCleanup = false;
      if (abort) {
        IDBObjectStore.prototype.delete = function (...args: Parameters<IDBObjectStore['delete']>) {
          const request = originalDelete.apply(this, args);
          if (this.name === 'changes') request.addEventListener('success', () => {
            abortedAtCleanup = true;
            this.transaction.abort();
          });
          return request;
        };
      }
      let rejected = false;
      try {
        await api.commitOrCreateConflictCopy(db, { ...base, text: 'my edit', upTo: 1 }, 1, 'conflict-copy', owner, { keepRun: 'mine', recoveryId: 'unexpected' });
      } catch { rejected = true; }
      finally { IDBObjectStore.prototype.delete = originalDelete; }
      const original = await api.getStoredDraft(db, base.id);
      const copy = await api.getStoredDraft(db, 'conflict-copy');
      const originalLog = await api.listChanges(db, base.id);
      const otherLog = await api.listChanges(db, 'other-document');
      // Reacquire under a new fence. There must be no leftover 'mine' prefix to salvage.
      const nextOwner = { instanceId: 'next', fence: await api.claimEditOwnership(db, base.id, 'next', 3) };
      const recovered = abort ? undefined : await api.salvageChanges(db, base.id, nextOwner, 'duplicate', 'other', 4);
      db.close();
      return { rejected, abortedAtCleanup, original, copy, originalLog, otherLog, recovered };
    }, abort);
    expect(result.original).toMatchObject({ text: 'foreign revision', revision: 2, upTo: 0 });
    expect(result.otherLog.map(r => r.run)).toEqual(['mine']);
    if (abort) {
      expect(result.rejected).toBe(true);
      expect(result.abortedAtCleanup).toBe(true);
      expect(result.copy).toBeUndefined();
      expect(result.originalLog.map(r => r.run)).toEqual(['mine', 'other']);
    } else {
      expect(result.rejected).toBe(false);
      expect(result.copy).toMatchObject({ text: 'my edit', upTo: 0 });
      expect(result.originalLog.map(r => r.run)).toEqual(['other']);
      expect(result.recovered).toBeUndefined();
    }
  });
}
