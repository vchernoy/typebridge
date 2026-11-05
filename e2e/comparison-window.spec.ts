import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { documentAction, openDocuments, selectDocument, setAutosave } from './settings-helpers';

type Row = { id: string; title: string; text: string; revision: number; updatedAt: number };

const MISSING_ID = 'b2c3d4e5-f6a7-4890-b123-456789abcdef';

async function readDocs(page: Page): Promise<Row[]> {
  return page.evaluate(() => new Promise<Row[]>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 2);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('documents', 'readonly').objectStore('documents').getAll();
      request.onsuccess = () => {
        const rows = (request.result as Row[]).map(({ id, title, text, revision, updatedAt }) => ({ id, title, text, revision, updatedAt }));
        db.close();
        resolve(rows.sort((a, b) => a.id.localeCompare(b.id)));
      };
      request.onerror = () => reject(request.error);
    };
  }));
}

async function storageKeys(page: Page): Promise<{ local: string[]; session: string[] }> {
  return page.evaluate(() => ({
    local: Object.keys(localStorage).sort(),
    session: Object.keys(sessionStorage).sort(),
  }));
}

/** Type into the editor and wait until the text is committed; returns the stored row. */
async function saveDocument(page: Page, text: string): Promise<Row> {
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill(text);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readDocs(page)).some(row => row.text === text)).toBe(true);
  return (await readDocs(page)).find(row => row.text === text)!;
}

async function openCompanion(context: BrowserContext, source: Page): Promise<Page> {
  const [viewer] = await Promise.all([
    context.waitForEvent('page'),
    documentAction(source, '#open-comparison'),
  ]);
  // Open goes about:blank first (to strip cloned sessionStorage), then replaces to the viewer URL.
  await viewer.waitForURL(/[?&]mode=view(?:&|$)/);
  await viewer.waitForLoadState('domcontentloaded');
  return viewer;
}

async function expectViewerReady(viewer: Page, text: string): Promise<void> {
  const field = viewer.locator('#editor');
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue(text);
  await expect(field).toHaveJSProperty('readOnly', true);
  await expect(viewer.locator('#draft-title')).toHaveJSProperty('readOnly', true);
  await expect(viewer.locator('#viewer-badge')).toHaveText('Saved version · Read-only');
}

test('opens a read-only companion for the saved document while the source stays editable', async ({ page, context }) => {
  await page.goto('/');
  const row = await saveDocument(page, 'Saved original');
  const viewer = await openCompanion(context, page);

  const url = new URL(viewer.url());
  expect(url.pathname).toBe('/');
  expect(url.searchParams.get('doc')).toBe(row.id);
  expect(url.searchParams.get('mode')).toBe('view');
  expect(viewer.url()).not.toContain('Saved');
  await expectViewerReady(viewer, 'Saved original');
  await expect(page.locator('#status')).toContainText('Opened the last saved version');

  const field = viewer.locator('#editor');
  await field.click();
  await viewer.keyboard.press('End');
  await viewer.keyboard.type('privet');
  await viewer.keyboard.press('ControlOrMeta+z');
  await expect(field).toHaveValue('Saved original');
  await expect(viewer.locator('#save-indicator')).toBeHidden();
  await expect(viewer.locator('#autosave')).toBeDisabled();
  for (const id of ['undo', 'redo', 'convert-cyrillic', 'convert-latin', 'new-draft', 'import-draft', 'delete-draft', 'open-comparison']) {
    await expect(viewer.locator('#' + id)).toBeDisabled();
  }

  // Independent selection: the viewer's range does not move the source caret.
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 5));
  await page.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 2));
  expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 5]);

  const source = page.locator('#editor');
  await source.click();
  await source.press('End');
  await source.pressSequentially(' 123');
  await expect(source).toHaveValue('Saved original 123');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  // W3: the committed edit reaches the read-only viewer; the viewer itself writes nothing.
  await expect(field).toHaveValue('Saved original 123');
  await expect(field).toHaveJSProperty('readOnly', true);
  expect(await readDocs(page)).toHaveLength(1);
});

test('a blocked pop-up keeps the text in the source window and explains how to continue', async ({ page, context }) => {
  await page.addInitScript(() => { window.open = () => null; });
  await page.goto('/');
  await saveDocument(page, 'Stays here');
  const pages: Page[] = [];
  context.on('page', opened => pages.push(opened));
  await documentAction(page, '#open-comparison');
  await expect(page.locator('#status')).toContainText('blocked');
  await expect(page.locator('#status')).toContainText('Allow pop-ups');
  await expect(page.locator('#editor')).toHaveValue('Stays here');
  expect(pages).toHaveLength(0);
});

test('invalid or missing document links show the missing state and create nothing', async ({ page }) => {
  for (const search of [
    `?mode=view&doc=${MISSING_ID}`,
    '?mode=view',
    '?mode=view&doc=not-a-uuid',
    `?doc=${MISSING_ID}&mode=view&x=1`,
    `?doc=${MISSING_ID}&mode=typo`,
  ]) {
    await page.goto('/' + search);
    await expect(page.locator('#editor')).toBeEnabled();
    await expect(page.locator('#viewer-notice')).toBeVisible();
    await expect(page.locator('#editor')).toHaveValue('');
    await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
    await expect(page.locator('#viewer-badge')).toBeVisible();
    await page.waitForTimeout(500);
    expect(await readDocs(page)).toEqual([]);
    const keys = await storageKeys(page);
    expect(keys.session.filter(key => /activeDraft|pendingDraft/.test(key))).toEqual([]);
    expect(keys.local.filter(key => /recovery/i.test(key))).toEqual([]);
  }
});

test('an invalid mode never creates or writes a document', async ({ page }) => {
  await page.goto(`/?doc=${MISSING_ID}&mode=edit`);
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#viewer-notice')).toBeVisible();
  await page.locator('#editor').click();
  await page.keyboard.type('should-not-persist');
  await page.waitForTimeout(800);
  expect(await readDocs(page)).toEqual([]);
  const keys = await storageKeys(page);
  expect(keys.session.filter(key => /activeDraft|pendingDraft/.test(key))).toEqual([]);
});

test('a missing-document viewer can still switch to a saved document without gaining edit rights', async ({ page, context }) => {
  await page.goto('/');
  const first = await saveDocument(page, 'First saved');
  await documentAction(page, '#new-draft');
  const second = await saveDocument(page, 'Second saved');
  const before = await readDocs(page);

  const viewer = await context.newPage();
  await viewer.goto(`/?mode=view&doc=${MISSING_ID}`);
  await expect(viewer.locator('#viewer-notice')).toBeVisible();
  await expect(viewer.locator('#drafts option')).toHaveCount(2);
  await selectDocument(viewer, first.id);
  await expectViewerReady(viewer, 'First saved');
  await expect(viewer.locator('#viewer-notice')).toBeHidden();
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(first.id);
  await selectDocument(viewer, second.id);
  await expectViewerReady(viewer, 'Second saved');
  expect(await readDocs(page)).toEqual(before);

  await viewer.reload();
  await expectViewerReady(viewer, 'Second saved');
});

test('choosing a document that vanished keeps its id in the address so reload stays missing', async ({ page, context }) => {
  await page.goto('/');
  const first = await saveDocument(page, 'Stays');
  await documentAction(page, '#new-draft');
  const second = await saveDocument(page, 'Vanishes');
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${first.id}&mode=view`);
  await expectViewerReady(viewer, 'Stays');
  await expect(viewer.locator('#drafts option')).toHaveCount(2);
  // Removed without a signal, so the viewer's list still offers it.
  await viewer.evaluate(id => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').delete(id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), second.id);
  await selectDocument(viewer, second.id);
  await expect(viewer.locator('#viewer-notice')).toContainText('no longer available');
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(second.id);
  await viewer.reload();
  await expect(viewer.locator('#viewer-notice')).toContainText('no longer available');
  await expect(viewer.locator('#editor')).toHaveValue('');
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(second.id);
});

test('reloading the companion stays a viewer for the same document with a fresh instance', async ({ page, context }) => {
  await page.goto('/');
  const row = await saveDocument(page, 'Reload me');
  const before = await readDocs(page);
  const viewer = await openCompanion(context, page);
  await expectViewerReady(viewer, 'Reload me');
  const firstInstance = await viewer.evaluate(() => document.documentElement.dataset.instanceId);
  expect(firstInstance).toMatch(/^[0-9a-f-]{36}$/);

  await viewer.reload();
  await expectViewerReady(viewer, 'Reload me');
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(row.id);
  const secondInstance = await viewer.evaluate(() => document.documentElement.dataset.instanceId);
  expect(secondInstance).not.toBe(firstInstance);
  await viewer.keyboard.type('x');
  await expect(viewer.locator('#editor')).toHaveValue('Reload me');
  expect(await readDocs(page)).toEqual(before);
});

test('with no committed copy the action explains, offers Cancel, and sends no text anywhere', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, false);
  const secret = 'PRIVATE-UNSAVED-TEXT';
  await page.locator('#editor').fill(secret);
  const pages: Page[] = [];
  context.on('page', opened => pages.push(opened));

  await documentAction(page, '#open-comparison');
  const dialog = page.getByRole('dialog', { name: 'Cannot open comparison window' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('no saved copy');
  await expect(dialog).toContainText('never turns on Autosave');
  await expect(dialog.getByRole('button')).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await page.waitForTimeout(400);
  expect(pages).toHaveLength(0);
  await expect(page.locator('#editor')).toHaveValue(secret);
  await expect(page.locator('#autosave')).not.toBeChecked();
  expect(await readDocs(page)).toEqual([]);
  const dump = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
  expect(dump).not.toContain(secret);
});

test('the viewer cannot mutate documents through delete, new, import or replace', async ({ page, context }) => {
  await page.goto('/');
  const row = await saveDocument(page, 'alpha beta alpha');
  await documentAction(page, '#new-draft');
  await saveDocument(page, 'other document');
  await selectDocument(page, row.id);
  await expect(page.locator('#editor')).toHaveValue('alpha beta alpha');
  const before = await readDocs(page);
  const localBefore = await page.evaluate(() => JSON.stringify({ ...localStorage }));

  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${row.id}&mode=view`);
  await expectViewerReady(viewer, 'alpha beta alpha');

  // Re-enable the controls to prove each handler also refuses, not only the disabled state.
  await viewer.evaluate(() => {
    for (const id of ['new-draft', 'import-draft', 'delete-draft', 'replace-one', 'replace-all', 'clear', 'convert-latin', 'convert-cyrillic']) {
      document.querySelector<HTMLButtonElement>('#' + id)!.disabled = false;
    }
    document.querySelector<HTMLInputElement>('#autosave')!.disabled = false;
  });
  await documentAction(viewer, '#delete-draft');
  await documentAction(viewer, '#new-draft');
  await viewer.locator('#import-file').setInputFiles({ name: 'incoming.txt', mimeType: 'text/plain', buffer: Buffer.from('Imported') });
  await viewer.locator('#find-open').click();
  await viewer.locator('#find-text').fill('alpha');
  await viewer.locator('#replace-text').fill('omega');
  // force: true — handlers must refuse even if chrome is re-enabled; focus/select must not hang the probe.
  await viewer.locator('#replace-one').click({ force: true });
  await viewer.locator('#replace-all').click({ force: true });
  await viewer.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.select());
  await viewer.locator('#convert-cyrillic').click({ force: true });
  await viewer.locator('#autosave').evaluate((el: HTMLInputElement) => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await viewer.locator('#draft-title').press('End');
  await viewer.keyboard.type('title edit');
  await viewer.waitForTimeout(700);
  await expect(viewer.locator('.confirm-dialog')).toHaveCount(0);
  await expectViewerReady(viewer, 'alpha beta alpha');
  await expect(viewer.locator('#draft-title')).toHaveValue(before.find(doc => doc.id === row.id)!.title);

  await viewer.close();
  await page.waitForTimeout(300);
  expect(await readDocs(page)).toEqual(before);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(localBefore);
  await openDocuments(page);
  await expect(page.locator('#drafts option')).toHaveCount(2);
});

test('cloned sessionStorage neither makes the viewer an editor nor restores private pending text', async ({ page, context }) => {
  await page.goto('/');
  const first = await saveDocument(page, 'Viewer text 0123456789');
  await documentAction(page, '#new-draft');
  const second = await saveDocument(page, 'Second document');
  const before = await readDocs(page);
  const localBefore = await page.evaluate(() => JSON.stringify({ ...localStorage }));

  const pending = JSON.stringify({ ...second, text: 'PRIVATE PENDING TEXT', title: second.title, updatedAt: second.updatedAt + 10 });
  const editorPosition = JSON.stringify({ start: 7, end: 9, direction: 'forward', scrollTop: 0, scrollLeft: 0 });
  const viewer = await context.newPage();
  await viewer.addInitScript(state => {
    if (!location.search.includes('mode=view')) return;
    sessionStorage.setItem('typebridge.activeDraft.v1', state.second);
    sessionStorage.setItem('typebridge.pendingDraft.v1', state.pending);
    sessionStorage.setItem('typebridge.writingPosition.v1.' + state.first, state.position);
    sessionStorage.setItem('typebridge.instanceId', 'cloned-instance');
  }, { second: second.id, pending, first: first.id, position: editorPosition });
  await viewer.goto(`/?doc=${first.id}&mode=view`);
  await expectViewerReady(viewer, 'Viewer text 0123456789');

  // The editor-scoped position was not applied to the viewer and is not overwritten by it.
  expect(await viewer.locator('#editor').evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 0]);
  await viewer.locator('#editor').click();
  await viewer.keyboard.press('ArrowRight');
  await viewer.keyboard.type('zzz');
  await viewer.waitForTimeout(500);
  await expect(viewer.locator('#editor')).toHaveValue('Viewer text 0123456789');
  await viewer.reload();
  await expectViewerReady(viewer, 'Viewer text 0123456789');
  // Viewer boot must not restore pending text. It also must not delete pending/activeDraft:
  // same-tab editor→viewer navigation relies on those keys for reload restore. The Open
  // action strips cloned keys in openComparisonWindow before navigate instead.
  const session = await viewer.evaluate(() => ({ ...sessionStorage }));
  expect(session['typebridge.pendingDraft.v1']).toBe(pending);
  expect(session['typebridge.activeDraft.v1']).toBe(second.id);
  await expect(viewer.locator('#editor')).toHaveValue('Viewer text 0123456789');
  expect(session['typebridge.writingPosition.v1.' + first.id]).toBe(editorPosition);
  expect(Object.keys(session).some(key => key.startsWith('typebridge.writingPosition.v1.view:'))).toBe(true);
  expect(await viewer.evaluate(() => document.documentElement.dataset.instanceId)).not.toBe('cloned-instance');

  await viewer.close();
  expect(await readDocs(page)).toEqual(before);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(localBefore);
});

test('same-tab navigation to a viewer preserves the editor reload backup', async ({ page }) => {
  await page.goto('/');
  const row = await saveDocument(page, 'Committed for nav');
  // Simulate pagehide writing a pending snapshot without committing that text to IndexedDB.
  await page.evaluate(({ id, title, revision }) => {
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({
      id, title, text: 'Committed for nav PLUS DIRTY', revision, updatedAt: Date.now(),
      history: { undo: [], redo: [] },
    }));
  }, { id: row.id, title: row.title, revision: row.revision });
  await page.goto(`/?doc=${row.id}&mode=view`);
  await expectViewerReady(page, 'Committed for nav');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1') ?? '')).toContain('PLUS DIRTY');
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#editor')).toHaveValue('Committed for nav PLUS DIRTY');
});

test('opening a companion does not receive a private pending canary from the source', async ({ page, context }) => {
  await page.goto('/');
  const row = await saveDocument(page, 'Committed body');
  const canary = 'PRIVATE-CANARY-NOT-FOR-COMPANION';
  await page.evaluate(({ id, title, canary: text }) => {
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({
      id, title, text, revision: 1, updatedAt: Date.now(), history: { undo: [], redo: [] },
    }));
  }, { id: row.id, title: row.title, canary });
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1') ?? '')).toContain(canary);

  const viewer = await openCompanion(context, page);
  await expectViewerReady(viewer, 'Committed body');
  const dump = await viewer.evaluate(() => JSON.stringify({ ...sessionStorage }));
  expect(dump).not.toContain(canary);
  expect(dump).not.toContain('typebridge.pendingDraft.v1');
  await expect(page.locator('#editor')).toHaveValue('Committed body');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1') ?? '')).toContain(canary);
});

test('selecting a recovery-* document updates the URL so reload keeps it', async ({ page, context }) => {
  await page.goto('/');
  const first = await saveDocument(page, 'Ordinary saved');
  const recoveryId = `recovery-${MISSING_ID}`;
  await page.evaluate(({ id }) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('typebridge', 2);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({
        id, title: 'Recovered copy', text: 'Recovered body', revision: 1, updatedAt: Date.now(),
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }), { id: recoveryId });

  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${first.id}&mode=view`);
  await expectViewerReady(viewer, 'Ordinary saved');
  await selectDocument(viewer, recoveryId);
  await expectViewerReady(viewer, 'Recovered body');
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(recoveryId);
  await viewer.reload();
  await expectViewerReady(viewer, 'Recovered body');
  expect(new URL(viewer.url()).searchParams.get('doc')).toBe(recoveryId);
});

test('viewer badge fits a narrow enlarged-text layout without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  const row = await saveDocument(page, 'Badge layout');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto(`/?doc=${row.id}&mode=view`);
  await expectViewerReady(page, 'Badge layout');
  // Style after navigation — addStyleTag before goto is destroyed by the load.
  await page.addStyleTag({ content: 'html { font-size: 24px; }' });
  await expect.poll(async () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('24px');
  const layout = await page.evaluate(() => {
    const title = document.querySelector('#draft-title') as HTMLInputElement;
    return {
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      titleWidth: title.getBoundingClientRect().width,
    };
  });
  expect(layout.overflow).toBe(false);
  expect(layout.titleWidth).toBeGreaterThan(40);
  await expect(page.locator('#viewer-badge')).toBeVisible();
});

test('comparison open fails closed when inherited session cleanup throws', async ({ page, context }) => {
  await page.goto('/');
  await saveDocument(page, 'Cleanup guard');
  const canary = 'PRIVATE-CLEANUP-CANARY';
  await page.evaluate(text => {
    sessionStorage.setItem('typebridge.pendingDraft.v1', JSON.stringify({
      id: 'a1b2c3d4-e5f6-4789-a012-3456789abcde', title: 'x', text, revision: 1, updatedAt: Date.now(),
    }));
  }, canary);
  await page.evaluate(() => {
    const original = window.open.bind(window);
    window.open = ((...args: Parameters<typeof window.open>) => {
      const win = original(...args);
      if (!win) return win;
      const storage = win.sessionStorage;
      Object.defineProperty(win, 'sessionStorage', {
        configurable: true,
        get() {
          // First length access is the cleanup scan — fail closed instead of navigating.
          throw new DOMException('blocked', 'SecurityError');
        },
      });
      // Keep a real storage object available if cleanup somehow succeeds.
      void storage;
      return win;
    }) as typeof window.open;
  });
  const pages: Page[] = [];
  context.on('page', opened => pages.push(opened));
  await documentAction(page, '#open-comparison');
  await expect(page.locator('#status')).toContainText('Could not open a private comparison window safely');
  await expect(page.locator('#status')).not.toContainText('Unsaved typing was not sent');
  await expect(page.locator('#editor')).toHaveValue('Cleanup guard');
  expect(await page.evaluate(() => sessionStorage.getItem('typebridge.pendingDraft.v1') ?? '')).toContain(canary);
  await page.waitForTimeout(400);
  for (const opened of pages) {
    if (!opened.isClosed()) await opened.close();
  }
});
