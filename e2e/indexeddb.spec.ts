import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const transpile = (path: string): string => ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
/** indexeddb.ts as a browser script exposing window.TypeBridgeDb; its one import is the ownership helpers. */
function compiledDatabaseModule(): string {
  return `{ const ownership = {}; ((exports) => { ${transpile('src/view/ownership.ts')} })(ownership);
    const changeLog = {}; ((exports) => { ${transpile('src/editor/change-log.ts')} })(changeLog);
    const modules = { './change-log': changeLog, '../view/ownership': ownership };
    const exports = {}; const require = name => modules[name]; ${transpile('src/editor/indexeddb.ts')} window.TypeBridgeDb = exports; }`;
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
    // Force a version above DATABASE_VERSION so the real open upgrades while the blocker holds vN.
    indexedDB.open = ((name: string) => original(name, api.DATABASE_VERSION + 1)) as typeof indexedDB.open;
    try { await api.openDraftDatabase(); return 'unexpected success'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
    finally { indexedDB.open = original; }
  });
  expect(message).toContain('Close other TypeBridge tabs');
  await blocker.evaluate(() => (window as unknown as { held: IDBDatabase }).held.close());
  const nextUpgrade = await page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 6);
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
  expect(result.stores).toEqual(['changes', 'discardMarkers', 'documents', 'editOwnership']);
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
  expect(stores).toEqual({ version: 4, names: ['changes', 'discardMarkers', 'documents', 'editOwnership'] });
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
    const crashed = (seq: number, change: [number, string, string], length: number, title?: string) => ({
      documentId: 'crash', seq, run: 'crashed', change, length, ...(title !== undefined ? { title } : {}),
    });
    await api.appendChange(db, crashed(1, [6, '', ', мир'], 11), owner);
    await api.appendChange(db, crashed(2, [11, '', ' 🙂'], 14), owner);
    const copy = await api.salvageChanges(db, 'crash', owner, 'rec-1', undefined, 5);
    const left = await api.listChanges(db, 'crash');
    const again = await api.salvageChanges(db, 'crash', owner, 'rec-2', undefined, 6);
    // Lost text that is only what this window shows (a reload backup, a handoff) is not stored
    // yet: no copy, and the records stay (#252 review). Title must match too (#37 R2c 2d-1).
    await api.appendChange(db, crashed(1, [6, '', '!'], 7), owner);
    const shown = await api.salvageChanges(db, 'crash', owner, 'rec-3', undefined, 7, 'Привет!', 'Заметка');
    const keptForShown = (await api.listChanges(db, 'crash')).length;
    // ...so after another restart (nothing shown) the same text is still recovered.
    const afterRestart = await api.salvageChanges(db, 'crash', owner, 'rec-3', undefined, 8);
    // A save that stores the lost text itself removes the records with no copy, in one transaction.
    await api.appendChange(db, crashed(1, [6, '', '#'], 7), owner);
    const sameText = await api.commitOrCreateConflictCopy(db, { id: 'crash', title: 'Заметка', text: 'Привет#', updatedAt: 9, upTo: 0 }, 1, 'c3', owner, { keepRun: 'mine', recoveryId: 'rec-x' });
    const afterSameText = (await api.listChanges(db, 'crash')).length;
    // A save of a new run first keeps a crashed run's text, in the same transaction.
    await api.appendChange(db, crashed(1, [7, '', '?'], 8), owner);
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
      documentId, seq, run, change: [1, '', inserted] as [number, string, string], length: 1 + inserted.length,
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
      documentId: 'title-crash', seq: 1, run: 'crashed', change: [0, '', ''] as [number, string, string], length: 5, title: 'Новое имя',
    }, owner);
    await api.appendChange(db, {
      documentId: 'title-crash', seq: 2, run: 'crashed', change: [5, '', '!'] as [number, string, string], length: 6,
    }, owner);
    const renamed = await api.salvageChanges(db, 'title-crash', owner, 'rec-title', undefined, 2);
    // Title-only loss (text unchanged) still produces a copy with the new title.
    await api.appendChange(db, {
      documentId: 'title-crash', seq: 1, run: 'crashed', change: [0, '', ''] as [number, string, string], length: 5, title: 'Только заголовок',
    }, owner);
    const titleOnly = await api.salvageChanges(db, 'title-crash', owner, 'rec-title-only', undefined, 3);
    // Shown text + shown title equal to the lost state keeps the records (rule 5).
    await api.appendChange(db, {
      documentId: 'title-crash', seq: 1, run: 'crashed', change: [0, '', ''] as [number, string, string], length: 5, title: 'Показанное',
    }, owner);
    const kept = await api.salvageChanges(db, 'title-crash', owner, 'rec-keep', undefined, 4, 'Текст', 'Показанное');
    const keptCount = (await api.listChanges(db, 'title-crash')).length;
    // Shown text alone with a different title still salvages (title is part of lost state).
    const wrongTitle = await api.salvageChanges(db, 'title-crash', owner, 'rec-wrong', undefined, 5, 'Текст', 'Другое');
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

test('reload discard marker write/apply under the fence (#255)', async ({ page }) => {
  // Fails without discardMarkers store or if apply deletes without consent / clears above upToSeq.
  await page.goto('/editor.html');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const stores = [...db.objectStoreNames].sort();
    const fence = await api.claimEditOwnership(db, 'reload-doc', 'window-a', 1);
    const owner = { instanceId: 'window-a', fence };
    await api.commitOrCreateConflictCopy(db, { id: 'reload-doc', title: 'T', text: 'a', updatedAt: 1 }, 0, 'c1', owner);
    const rec = (seq: number, run: string, inserted: string) => ({
      documentId: 'reload-doc', seq, run, change: [0, '', inserted] as [number, string, string], length: inserted.length,
    });
    await api.appendChange(db, rec(1, 'run-a', 'x'), owner);
    await api.appendChange(db, rec(2, 'run-a', 'y'), owner);
    await api.appendChange(db, rec(3, 'run-b', 'z'), owner);
    const marker = await api.writeReloadDiscardMarker(db, 'reload-doc', owner);
    const stored = await api.getReloadDiscardMarker(db, 'reload-doc');
    // No fence → write refuses.
    let noFence: 'wrote' | 'refused' | 'other';
    try {
      await api.writeReloadDiscardMarker(db, 'reload-doc', undefined as unknown as { instanceId: string; fence: number });
      noFence = 'wrote';
    } catch (error) {
      noFence = (error as Error).name === 'EditOwnershipLostError' ? 'refused' : 'other';
    }
    // Stale / cancelled: delete marker only.
    const stale = await api.applyReloadDiscardMarker(db, 'reload-doc', owner, false);
    const afterStale = await api.listChanges(db, 'reload-doc');
    const markerGone = await api.getReloadDiscardMarker(db, 'reload-doc');
    // Rewrite and apply with consent: delete seq <= upToSeq.
    await api.appendChange(db, rec(4, 'run-c', 'w'), owner);
    const marker2 = await api.writeReloadDiscardMarker(db, 'reload-doc', owner);
    const applied = await api.applyReloadDiscardMarker(db, 'reload-doc', owner, true);
    const left = await api.listChanges(db, 'reload-doc');
    // Cancel clear is idempotent.
    await api.clearReloadDiscardMarker(db, 'reload-doc', owner);
    await api.clearReloadDiscardMarker(db, 'reload-doc', owner);
    db.close();
    return {
      stores,
      version: api.DATABASE_VERSION,
      markerUpTo: marker.upToSeq,
      storedUpTo: stored?.upToSeq,
      noFence,
      staleApplied: stale.applied,
      afterStaleSeqs: afterStale.map(r => r.seq),
      markerGone: markerGone === undefined,
      marker2UpTo: marker2.upToSeq,
      applied,
      leftSeqs: left.map(r => r.seq),
    };
  });
  expect(result.stores).toEqual(['changes', 'discardMarkers', 'documents', 'editOwnership']);
  expect(result.version).toBe(4);
  expect(result.markerUpTo).toBe(3);
  expect(result.storedUpTo).toBe(3);
  expect(result.noFence).toBe('refused');
  expect(result.staleApplied).toBe(false);
  expect(result.afterStaleSeqs).toEqual([1, 2, 3]);
  expect(result.markerGone).toBe(true);
  expect(result.marker2UpTo).toBe(4);
  expect(result.applied).toEqual({ applied: true, upToSeq: 4 });
  expect(result.leftSeqs).toEqual([]);
});

test('v3 database upgrades to v4 and keeps documents and changes (#255)', async ({ page }) => {
  // Stay on a static asset so the editor never salvages the seeded change record.
  await page.goto('/icon-192.png');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const del = indexedDB.deleteDatabase('typebridge');
    del.onsuccess = () => resolve();
    del.onerror = () => reject(del.error);
  }));
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 3);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore('documents', { keyPath: 'id' });
      db.createObjectStore('editOwnership', { keyPath: 'documentId' });
      db.createObjectStore('changes', { keyPath: ['documentId', 'seq'] });
      const docs = open.transaction!.objectStore('documents');
      docs.put({ id: 'v3', title: 'Old', text: 'kept', updatedAt: 1, revision: 1, upTo: 0 });
      open.transaction!.objectStore('changes').put({
        documentId: 'v3', seq: 1, run: 'r', change: [0, '', 'x'], length: 1,
      });
    };
    open.onsuccess = () => { open.result.close(); resolve(); };
    open.onerror = () => reject(open.error);
  }));
  await page.addScriptTag({ content: compiledDatabaseModule() });
  const result = await page.evaluate(async () => {
    const api = (window as unknown as { TypeBridgeDb: typeof import('../src/editor/indexeddb') }).TypeBridgeDb;
    const db = await api.openDraftDatabase();
    const stores = [...db.objectStoreNames].sort();
    const docs = await api.listStoredDrafts(db);
    const changes = await api.listChanges(db, 'v3');
    db.close();
    return { stores, doc: docs.find(d => d.id === 'v3'), changeCount: changes.length, version: api.DATABASE_VERSION };
  });
  expect(result.version).toBe(4);
  expect(result.stores).toEqual(['changes', 'discardMarkers', 'documents', 'editOwnership']);
  expect(result.doc?.text).toBe('kept');
  expect(result.changeCount).toBe(1);
});
