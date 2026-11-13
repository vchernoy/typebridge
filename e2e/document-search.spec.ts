import { expect, test, type Page } from '@playwright/test';
import { confirmPrivateSavedCopy, documentAction, fillHostEditor, openFind, selectDocument, setAutosave, setPrivateSession } from './settings-helpers';
import type { StoredDraft } from '../src/editor/indexeddb';

async function ready(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#find-text')).toBeEnabled();
}
async function storage(page: Page) {
  return page.evaluate(() => new Promise<{ rows: StoredDraft[]; serialized: string }>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['documents', 'changes']);
      const rows = tx.objectStore('documents').getAll(); const changes = tx.objectStore('changes').getAll();
      tx.oncomplete = () => {
        db.close(); resolve({ rows: rows.result, serialized: JSON.stringify({ rows: rows.result, changes: changes.result, local: { ...localStorage }, session: { ...sessionStorage } }) });
      };
      tx.onerror = () => reject(tx.error);
    };
  }));
}
async function publicDocument(page: Page) {
  await page.goto('/editor.html'); await ready(page);
  await page.locator('#enabled').uncheck();
  await page.locator('#draft-title').fill('public title');
  await page.locator('#editor').fill('public body');
  await openFind(page);
  await page.locator('#find-text').fill('public find');
  await page.locator('#replace-text').fill('public replace');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  return page.locator('#drafts').inputValue();
}

for (const session of [false, true]) {
  test(`private ${session ? 'session' : 'document'} search leaves no storage trace and reload restores all four fields (#257 2b)`, async ({ page }) => {
    await publicDocument(page);
    if (session) await setPrivateSession(page, true); else await setAutosave(page, false);
    await expect(page.locator('#find-text')).toHaveValue('public find');
    await expect(page.locator('#replace-text')).toHaveValue('public replace');
    for (const [selector, value] of [['#editor', 'SECRET body'], ['#draft-title', 'SECRET title'], ['#find-text', 'SECRET find'], ['#replace-text', 'SECRET replace']]) {
      await page.locator(selector).fill(value);
    }
    await page.locator('#find-text').dispatchEvent('compositionstart');
    await page.locator('#find-text').fill('SECRET IME find');
    await page.locator('#find-text').dispatchEvent('compositionend');
    await page.locator('#replace-text').dispatchEvent('compositionstart');
    await page.locator('#replace-text').fill('SECRET IME replace');
    await page.locator('#replace-text').dispatchEvent('compositionend');
    expect((await storage(page)).serialized).not.toContain('SECRET');
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => /^typebridge\.find\.(query|replace)/.test(k)))).toEqual([]);
    await page.reload(); await ready(page);
    for (const [selector, value] of [['#editor', 'public body'], ['#draft-title', 'public title'], ['#find-text', 'public find'], ['#replace-text', 'public replace']]) {
      await expect(page.locator(selector)).toHaveValue(value);
    }
    await openFind(page); await page.locator('#find-text').press('Control+z');
    expect(await page.locator('#find-text').inputValue()).not.toContain('SECRET');
    expect((await storage(page)).serialized).not.toContain('SECRET');
  });
}

test('switches and reloads restore each field history; Undo stays in the focused field (#257 2b)', async ({ page }) => {
  const a = await publicDocument(page);
  await documentAction(page, '#new-draft');
  await expect(page.locator('#editor')).toHaveValue('');
  await page.locator('#draft-title').fill('B title'); await page.locator('#editor').fill('B body');
  await openFind(page); await page.locator('#find-text').fill('B find'); await page.locator('#replace-text').fill('B replace');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const b = await page.locator('#drafts').inputValue();
  await selectDocument(page, a);
  await expect(page.locator('#find-text')).toHaveValue('public find');
  await expect(page.locator('#replace-text')).toHaveValue('public replace');
  await page.reload(); await ready(page); await openFind(page);
  await page.locator('#find-text').press('Control+z');
  await expect(page.locator('#find-text')).toHaveValue('');
  await expect(page.locator('#replace-text')).toHaveValue('public replace');
  await expect(page.locator('#editor')).toHaveValue('public body');
  await page.locator('#find-text').press('Control+Shift+z');
  await expect(page.locator('#find-text')).toHaveValue('public find');
  await page.locator('#replace-text').press('Control+z');
  await expect(page.locator('#replace-text')).toHaveValue('');
  await expect(page.locator('#find-text')).toHaveValue('public find');
  await page.locator('#draft-title').press('Control+z');
  await expect(page.locator('#draft-title')).not.toHaveValue('public title');
  await expect(page.locator('#editor')).toHaveValue('public body');
  await selectDocument(page, b);
  await expect(page.locator('#find-text')).toHaveValue('B find');
  await expect(page.locator('#replace-text')).toHaveValue('B replace');
  expect((await storage(page)).rows.find(row => row.id === b)).toMatchObject({ findHistory: { current: 'B find' }, replaceHistory: { current: 'B replace' }, titleHistory: { current: 'B title' } });
});

test('private switches never swap search values, including session reversal during last-save (#257 2b)', async ({ page }) => {
  await publicDocument(page);
  await page.evaluate(() => { (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 1_000; });
  await page.locator('#editor').fill('pre-switch dirty body');
  await setPrivateSession(page, true);
  await page.locator('#find-text').fill('private in memory');
  await page.locator('#replace-text').fill('private replacement');
  await setPrivateSession(page, false);
  await expect(page.locator('#find-text')).toHaveValue('private in memory');
  await expect(page.locator('#replace-text')).toHaveValue('private replacement');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await storage(page)).rows.some(row => row.find === 'private in memory' && row.replace === 'private replacement')).toBe(true);
});

test('comparison search stays in memory across saved-version refresh and cannot change owner content (#257 2b)', async ({ page, context }) => {
  const id = await publicDocument(page);
  const viewer = await context.newPage(); await viewer.goto(`/editor.html?doc=${id}&mode=view`);
  await expect(viewer.locator('#find-text')).toBeEnabled(); await openFind(viewer);
  await viewer.locator('#find-text').fill('VIEWER local find'); await viewer.locator('#replace-text').fill('VIEWER local replace');
  await viewer.locator('#find-text').dispatchEvent('compositionstart');
  await viewer.locator('#find-text').fill('VIEWER composing find');
  await page.locator('#editor').fill('updated owner body'); await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(viewer.locator('#editor')).toHaveValue('updated owner body');
  await expect(viewer.locator('#find-text')).toHaveValue('VIEWER composing find');
  await viewer.locator('#find-text').dispatchEvent('compositionend');
  await viewer.locator('#find-text').press('Control+z');
  await expect(viewer.locator('#find-text')).toHaveValue('VIEWER local find');
  await expect(viewer.locator('#replace-all')).toBeDisabled();
  expect((await storage(page)).serialized).not.toContain('VIEWER');
  await viewer.reload(); await expect(viewer.locator('#find-text')).toHaveValue('public find');
  await expect(viewer.locator('#replace-text')).toHaveValue('public replace');
});

test('a document switch invalidates private IME snapshots in search histories (#257 2b)', async ({ page }) => {
  const a = await publicDocument(page);
  await documentAction(page, '#new-draft'); await page.locator('#editor').fill('B body');
  await expect(page.locator('#save-indicator')).toHaveText('Saved'); const b = await page.locator('#drafts').inputValue();
  await selectDocument(page, a); await openFind(page);
  await page.locator('#find-text').fill('query from A');
  await page.locator('#find-text').dispatchEvent('compositionstart');
  await selectDocument(page, b);
  await page.locator('#find-text').dispatchEvent('compositionend');
  await page.locator('#find-text').press('Control+z');
  await expect(page.locator('#find-text')).toHaveValue('');
  await expect(page.locator('#editor')).toHaveValue('B body');
});

for (const privateEdit of [false, true]) {
  test(`renderer crash restores four fields ${privateEdit ? 'before private edits' : 'from one logged prefix'} (#257 2b)`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Renderer crash requires Chromium CDP');
    await publicDocument(page);
    if (privateEdit) await setAutosave(page, false);
    else await page.evaluate(() => { (window as unknown as { __typebridgeDelayPersistMs: number }).__typebridgeDelayPersistMs = 60_000; });
    const prefix = privateEdit ? 'SECRET' : 'RECOVERY';
    for (const [selector, suffix] of [['#editor', 'body'], ['#draft-title', 'title'], ['#find-text', 'find'], ['#replace-text', 'replace']]) await page.locator(selector).fill(`${prefix} ${suffix}`);
    if (privateEdit) expect((await storage(page)).serialized).not.toContain('SECRET');
    else await expect.poll(async () => (await storage(page)).serialized.includes('RECOVERY replace')).toBe(true);
    const crashed = page.waitForEvent('crash');
    const cdp = await context.newCDPSession(page);
    void cdp.send('Page.crash').catch(() => {});
    await crashed;
    const next = await context.newPage(); await next.goto('/editor.html'); await ready(next);
    if (privateEdit) {
      await expect(next.locator('#find-text')).toHaveValue('public find');
      await expect(next.locator('#replace-text')).toHaveValue('public replace');
      expect((await storage(next)).serialized).not.toContain('SECRET');
    } else {
      await expect.poll(async () => (await storage(next)).rows.some(row => row.title === 'RECOVERY title (recovered)' && row.text === 'RECOVERY body' && row.find === 'RECOVERY find' && row.replace === 'RECOVERY replace')).toBe(true);
    }
    await page.close();
  });
}

test('failed public writes journal/back up search; subsequent private searches remain absent (#257 2b)', async ({ page }) => {
  await publicDocument(page);
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('quota', 'QuotaExceededError'); }; });
  await page.locator('#find-text').fill('fallback find'); await page.locator('#replace-text').fill('fallback replace');
  await expect(page.locator('#save-indicator')).toHaveText('Save failed');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const backedUp = await page.evaluate(() => ({ journal: Object.keys(localStorage).filter(k => k.startsWith('typebridge.recovery.')).map(k => localStorage.getItem(k)), pending: JSON.parse(sessionStorage.getItem('typebridge.pendingDraft.v1') ?? 'null') }));
  expect(backedUp.journal.some(raw => raw?.includes('fallback find') && raw.includes('fallback replace'))).toBe(true);
  expect(backedUp.pending).toMatchObject({ find: 'fallback find', replace: 'fallback replace' });
  await setPrivateSession(page, true);
  await page.locator('#find-text').fill('SECRET failed-save find'); await page.locator('#replace-text').fill('SECRET failed-save replace');
  expect((await storage(page)).serialized).not.toContain('SECRET');
});

test('private host titles stay visible in memory but layout stores no private field text (#257 2b)', async ({ page }) => {
  await page.goto('/');
  const frame = page.frameLocator('.host-window iframe').first();
  await expect(frame.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(frame.locator('#editor')).toBeEnabled();
  await fillHostEditor(frame, 'public host title', '#draft-title'); await fillHostEditor(frame, 'public host body');
  await frame.locator('#find-open').click();
  await frame.locator('#find-text').fill('public host find');
  await expect(frame.locator('#save-indicator')).toHaveText('Saved');
  await frame.locator('#autosave').uncheck(); await confirmPrivateSavedCopy(frame);
  await fillHostEditor(frame, 'SECRET host title', '#draft-title'); await fillHostEditor(frame, 'SECRET host body');
  await frame.locator('#find-text').fill('SECRET host find'); await frame.locator('#replace-text').fill('SECRET host replace');
  await expect(page.locator('.host-window-title').first()).toHaveValue('SECRET host title');
  await page.getByRole('button', { name: 'Tile stacked' }).click();
  expect((await storage(page)).serialized).not.toContain('SECRET');
  await page.reload();
  const restored = page.frameLocator('.host-window iframe').first();
  await expect(restored.locator('#find-text')).toHaveValue('public host find');
  await expect(page.locator('.host-window-title').first()).toHaveValue('public host title');
});

test('a cleared title keeps its own Undo across reload (#257 2b)', async ({ page }) => {
  await publicDocument(page);
  await page.locator('#draft-title').fill('');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await page.reload(); await ready(page);
  await expect(page.locator('#draft-title')).toHaveValue('');
  await page.locator('#draft-title').press('Control+z');
  await expect(page.locator('#draft-title')).toHaveValue('public title');
  await expect(page.locator('#editor')).toHaveValue('public body');
  await expect(page.locator('#find-text')).toHaveValue('public find');
});

test('same-tab private handoff transfers four fields and search histories without persisting them (#257 2b)', async ({ page }) => {
  await page.goto('/');
  const first = page.frameLocator('.host-window iframe').first();
  await expect(first.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(first.locator('#editor')).toBeEnabled();
  await fillHostEditor(first, 'public body'); await fillHostEditor(first, 'public title', '#draft-title');
  await first.locator('#find-open').click(); await first.locator('#find-text').fill('public find');
  await expect(first.locator('#save-indicator')).toHaveText('Saved'); const id = await first.locator('#drafts').inputValue();
  await first.locator('#autosave').uncheck(); await confirmPrivateSavedCopy(first);
  await fillHostEditor(first, 'SECRET body'); await fillHostEditor(first, 'SECRET title', '#draft-title');
  await first.locator('#find-text').fill('SECRET find'); await first.locator('#replace-text').fill('SECRET replace');
  await page.getByRole('button', { name: 'New window' }).click();
  await page.getByRole('button', { name: 'Tile side by side' }).click();
  const second = page.frameLocator('.host-window[data-window-id="w2"] iframe');
  await expect(second.locator('#editor')).toBeEnabled();
  await second.locator('#doc-menu-open').click(); await second.locator('#drafts').selectOption(id);
  await expect(second.locator('#editor')).toHaveJSProperty('readOnly', true);
  if (await second.locator('#doc-menu').isVisible()) await second.locator('#doc-menu-open').click();
  await second.locator('#editor').click();
  await expect(second.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(second.locator('#editor')).toHaveValue('SECRET body');
  await expect(second.locator('#draft-title')).toHaveValue('SECRET title');
  await second.locator('#find-open').click();
  await expect(second.locator('#find-text')).toHaveValue('SECRET find');
  await expect(second.locator('#replace-text')).toHaveValue('SECRET replace');
  await second.locator('#find-text').press('Control+z');
  await expect(second.locator('#find-text')).toHaveValue('public find');
  await expect(second.locator('#editor')).toHaveValue('SECRET body');
  // Replace from the now-reading first window must retain its local command intent
  // after the incoming private snapshot restores the canonical search fields.
  await expect(first.locator('#editor')).toHaveJSProperty('readOnly', true);
  if (await first.locator('#find-bar').isHidden()) await first.locator('#find-open').click();
  await first.locator('#find-text').fill('SECRET'); await first.locator('#replace-text').fill('REPLACED');
  await first.locator('#replace-all').click();
  await expect(first.locator('html')).toHaveAttribute('data-role', 'editor');
  await expect(first.locator('#editor')).toHaveValue('REPLACED body');
  await expect(first.locator('#find-text')).toHaveValue('SECRET');
  await expect(first.locator('#replace-text')).toHaveValue('REPLACED');
  expect((await storage(page)).serialized).not.toContain('REPLACED');
  expect((await storage(page)).serialized).not.toContain('SECRET');
});

test('automatic ownership after owner closes discards reader search without saving (#266)', async ({ page, context }) => {
  const id = await publicDocument(page);
  const before = (await storage(page)).rows.find(row => row.id === id)!;
  const reader = await context.newPage();
  await reader.goto(`/editor.html?doc=${id}`);
  await expect(reader.locator('html')).toHaveAttribute('data-role', 'reader');
  await openFind(reader);
  await reader.locator('#find-text').fill('reader local query');
  await reader.locator('#replace-text').fill('reader local replacement');
  await expect(reader.locator('#find-text')).toHaveValue('reader local query');
  await page.close();
  await reader.bringToFront();
  await reader.evaluate(() => window.dispatchEvent(new Event('focus')));
  await ready(reader);
  await expect(reader.locator('#find-text')).toHaveValue('public find');
  await expect(reader.locator('#replace-text')).toHaveValue('public replace');
  // Cross the normal autosave debounce; a scheduled query save would bump the revision.
  await reader.waitForTimeout(1000);
  const after = (await storage(reader)).rows.find(row => row.id === id)!;
  expect(after.find).toBe('public find'); expect(after.replace).toBe('public replace');
  expect(after.revision).toBe(before.revision);
  await expect(reader.locator('#save-indicator')).toHaveText('Saved');
});
