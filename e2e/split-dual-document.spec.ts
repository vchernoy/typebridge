import { expect, test, type Page } from '@playwright/test';
import { closeDocuments, documentAction, openDocuments, openFind, selectDocument, setAutosave } from './settings-helpers';
import { readStoredDocs } from './storage-helpers';

async function openSplit(page: Page): Promise<void> {
  await documentAction(page, '#toggle-split');
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-split', 'on');
}

async function saveNamed(page: Page, text: string, title: string): Promise<string> {
  await page.locator('#editor').fill(text);
  await page.locator('#draft-title').fill(title);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const docs = await readStoredDocs(page);
  const row = docs.find(d => d.title === title);
  if (!row) throw new Error('missing saved doc');
  return row.id;
}

test('pane B can open a different document with independent edits and Undo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Document A body', 'Doc A');
  await documentAction(page, '#new-draft');
  const secondId = await saveNamed(page, 'Document B body', 'Doc B');
  expect(firstId).not.toBe(secondId);

  await openSplit(page);
  await expect(page.locator('#companion-badge')).toBeVisible();
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await expect(page.locator('#companion-badge')).toBeHidden();
  await expect(page.locator('#draft-title-b')).toBeVisible();
  await expect(page.locator('#draft-title-b')).toHaveValue('Doc A');
  await expect(page.locator('#editor-b')).toHaveValue('Document A body');
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', false);
  await expect(page.locator('#editor')).toHaveValue('Document B body');

  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially('!');
  await expect(page.locator('#editor-b')).toHaveValue('Document A body!');
  await expect(page.locator('#editor')).toHaveValue('Document B body');
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');

  await page.locator('#undo').click();
  await expect(page.locator('#editor-b')).toHaveValue('Document A body');
  await expect(page.locator('#editor')).toHaveValue('Document B body');

  await page.locator('#pane-b-drafts').selectOption(secondId);
  await expect(page.locator('#companion-badge')).toBeVisible();
  await expect(page.locator('#editor-b')).toHaveValue('Document B body');
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', true);
});

test('split restore after reload does not crash when split was open', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await page.locator('#editor').fill('persist split open');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await openSplit(page);
  await page.reload();
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('persist split open');
});

test('primary switching to the companion document promotes pane B edits', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  const firstId = await saveNamed(page, 'Alpha original', 'Alpha');
  await documentAction(page, '#new-draft');
  const secondId = await saveNamed(page, 'Beta original', 'Beta');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' edited');
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');
  await selectDocument(page, firstId);
  await expect(page.locator('#editor')).toHaveValue('Alpha original edited');
  await expect(page.locator('#companion-badge')).toBeVisible();
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', true);
  expect(secondId).toBeTruthy();
});

test('promoting a dirty companion still autosaves after the cancelled timer', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Gamma body', 'Gamma');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Delta body', 'Delta');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#enabled').uncheck();
  // Keep the secondary 300ms timer from committing before promotion clears it.
  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayPersistSecondaryMs?: number }).__typebridgeDelayPersistSecondaryMs = 60_000;
  });
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' dirty');
  await selectDocument(page, firstId);
  await expect(page.locator('#editor')).toHaveValue('Gamma body dirty');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const docs = await readStoredDocs(page);
  const gamma = docs.find(d => d.title === 'Gamma');
  expect(gamma?.text).toBe('Gamma body dirty');
});

test('pane B pagehide writes a pending snapshot that restores after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Echo body', 'Echo');
  const echoRevision = (await readStoredDocs(page)).find(d => d.id === firstId)!.revision;
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Foxtrot body', 'Foxtrot');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#enabled').uncheck();
  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayPersistSecondaryMs?: number }).__typebridgeDelayPersistSecondaryMs = 60_000;
  });
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' pending');
  const pending = await page.evaluate(() => {
    window.dispatchEvent(new Event('pagehide'));
    return sessionStorage.getItem('typebridge.pendingDraft.paneB.v1');
  });
  expect(pending).toContain('Echo body pending');
  await page.addInitScript(() => {
    (window as Window & { __typebridgeDelayPendingSecondaryMs?: number }).__typebridgeDelayPendingSecondaryMs = 1200;
  });
  await page.reload();
  // Boot keeps controls disabled until pending-B restore finishes.
  await expect(page.locator('#editor')).toBeDisabled();
  await expect(page.locator('#pane-b-drafts')).toBeDisabled();
  await expect(page.locator('#editor')).toBeEnabled({ timeout: 8_000 });
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('#editor-b')).toHaveValue('Echo body pending');
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');
  expect(echoRevision).toBeGreaterThanOrEqual(1);
});

test('cancelling promotion reschedules pane B autosave', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Romeo body', 'Romeo');
  await documentAction(page, '#new-draft');
  const sierraId = await saveNamed(page, 'Sierra body', 'Sierra');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#enabled').uncheck();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  });
  await page.locator('#editor').press('End');
  await page.locator('#editor').pressSequentially(' boom');
  await expect(page.locator('#save-indicator')).toHaveText('Save failed');
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' dirty');
  await openDocuments(page);
  await page.locator('#drafts').selectOption(firstId);
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
  await expect(discard).toBeVisible();
  // Companion picker stays frozen on the promoting document while the flush dialog is open.
  await page.locator('#pane-b-drafts').selectOption(sierraId);
  await expect(page.locator('#pane-b-drafts')).toHaveValue(firstId);
  await expect(page.locator('#editor-b')).toHaveValue('Romeo body dirty');
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await closeDocuments(page);
  await expect(page.locator('#editor-b')).toHaveValue('Romeo body dirty');
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');
});

test('Autosave stays usable for an editable companion while primary is read-only', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const sharedId = await saveNamed(page, 'Shared body', 'Shared');
  await documentAction(page, '#new-draft');
  const privateId = await saveNamed(page, 'Private body', 'Private');
  // Another window claims Shared while this tab stays on Private.
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.locator('#editor')).toBeEnabled();
  await selectDocument(other, sharedId);
  await expect(other.locator('#editor')).toHaveJSProperty('readOnly', false);
  await selectDocument(page, sharedId);
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#autosave')).toBeDisabled();
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(privateId);
  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await expect(page.locator('#autosave')).toBeEnabled();
  await setAutosave(page, false, 'keep');
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' private');
  await expect(page.locator('#save-indicator-b')).toHaveText('Not saved');
  await setAutosave(page, true);
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');
  const docs = await readStoredDocs(page);
  expect(docs.find(d => d.id === privateId)?.text).toBe('Private body private');
  await other.close();
});

test('ownership loss after promoting pane B freezes the primary immediately', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Tango body', 'Tango');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Uniform body', 'Uniform');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' kept');
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');
  await selectDocument(page, firstId);
  await expect(page.locator('#editor')).toHaveValue('Tango body kept');
  await expect(page.locator('html')).toHaveAttribute('data-role', 'editor');
  const stealer = await context.newPage();
  await stealer.goto('/icon-192.png');
  await stealer.evaluate(name => new Promise<void>(resolve => {
    void navigator.locks.request(name, { steal: true }, () => {
      resolve();
      return new Promise(() => undefined);
    });
  }), `typebridge-edit-owner:${firstId}`);
  await expect(page.locator('html')).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#ownership-notice')).toBeVisible();
  await expect(page.locator('#editor')).toHaveValue('Tango body kept');
});

test('Autosave-off pane B asks before discarding on close split', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Hotel body', 'Hotel');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'India body', 'India');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await setAutosave(page, false, 'keep');
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' private');
  await expect(page.locator('#save-indicator-b')).toHaveText('Not saved');
  await documentAction(page, '#toggle-split');
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes in the other pane?' });
  await expect(discard).toBeVisible();
  await discard.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('#editor-b')).toBeVisible();
  await expect(page.locator('#editor-b')).toHaveValue('Hotel body private');
});

test('Find match totals refresh when editing the active companion', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'alpha alpha', 'Papa');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'beta only', 'Quebec');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').focus();
  await openFind(page);
  await page.locator('#find-text').fill('alpha');
  await expect(page.locator('#find-status')).toHaveText('2 matches');
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' alpha');
  await expect(page.locator('#find-status')).toHaveText('3 matches');
});

test('Copy uses the active pane document', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Juliet only in B', 'Juliet');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Kilo only in A', 'Kilo');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  // Stub clipboard so Chromium/Firefox/WebKit share one assertion path.
  await page.evaluate(() => {
    const copied: string[] = [];
    (window as Window & { __typebridgeCopied?: string[] }).__typebridgeCopied = copied;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copied.push(text); } },
    });
  });
  await page.locator('#editor-b').focus();
  await expect(page.locator('main.workspace')).toHaveAttribute('data-active-pane', 'pane-b');
  await page.locator('#copy').click();
  await expect(page.locator('#status')).toContainText('Copied');
  expect(await page.evaluate(() => (window as Window & { __typebridgeCopied?: string[] }).__typebridgeCopied?.at(-1))).toBe('Juliet only in B');
  await page.locator('#editor').focus();
  await page.locator('#copy').click();
  await expect(page.locator('#status')).toContainText('Copied');
  expect(await page.evaluate(() => (window as Window & { __typebridgeCopied?: string[] }).__typebridgeCopied?.at(-1))).toBe('Kilo only in A');
});

test('Export downloads the active companion document', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Export me from B', 'ExportB');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Keep me in A', 'ExportA');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.locator('#editor-b').focus();
  const downloadPromise = page.waitForEvent('download');
  await documentAction(page, '#export-txt');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/ExportB\.txt$/);
  const stream = await download.createReadStream();
  expect(stream).toBeTruthy();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString('utf8')).toBe('Export me from B');
});

test('Tab indents the active companion when Tab indents is on', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'line', 'TabB');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'primary', 'TabA');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await expect(page.locator('#companion-badge')).toBeHidden();
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', false);
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').focus();
  await page.locator('#editor-b').evaluate(el => {
    const area = el as HTMLTextAreaElement;
    area.setSelectionRange(0, 0);
  });
  await page.keyboard.press('Tab');
  await expect(page.locator('#editor-b')).toHaveValue('    line');
  await expect(page.locator('#editor')).toHaveValue('primary');
});

test('Copy fallback selects the active companion when clipboard is refused', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'Lima in B', 'Lima');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Mike in A', 'Mike');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
  });
  await page.locator('#editor-b').focus();
  await page.locator('#copy').click();
  await expect(page.locator('#status')).toContainText('Copy unavailable');
  await expect(page.locator('#editor-b')).toBeFocused();
  const selected = await page.locator('#editor-b').evaluate(el => {
    const area = el as HTMLTextAreaElement;
    return area.value.slice(area.selectionStart, area.selectionEnd);
  });
  expect(selected).toBe('Lima in B');
});

test('pane B save quota failure keeps Not saved and preserves text', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const firstId = await saveNamed(page, 'November body', 'November');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Oscar body', 'Oscar');
  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(firstId);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as unknown as { restorePut: () => void }).restorePut = () => { IDBObjectStore.prototype.put = put; };
    IDBObjectStore.prototype.put = function () { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
  });
  await page.locator('#enabled').uncheck();
  await page.locator('#editor-b').press('End');
  await page.locator('#editor-b').pressSequentially(' quota');
  await expect(page.locator('#save-indicator-b')).toHaveText('Save failed');
  await expect(page.locator('#editor-b')).toHaveValue('November body quota');
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
});

test('pane B follows foreign saves and can reclaim ownership', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await setAutosave(page, true);
  const sharedId = await saveNamed(page, 'Shared v1', 'Shared');
  await documentAction(page, '#new-draft');
  await saveNamed(page, 'Local primary', 'Local');

  // Another window must own Shared first; pane B never steals a held lock.
  const owner = await context.newPage();
  await owner.goto('/');
  await expect(owner.locator('#editor')).toBeEnabled();
  await selectDocument(owner, sharedId);
  await expect(owner.locator('#editor')).toHaveValue('Shared v1');
  await expect(owner.locator('html')).toHaveAttribute('data-role', 'editor');

  await openSplit(page);
  await page.locator('#pane-b-drafts').selectOption(sharedId);
  await expect(page.locator('#editor-b')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#save-indicator-b')).toHaveText('Read-only');

  await owner.locator('#enabled').uncheck();
  await owner.locator('#editor').press('End');
  await owner.locator('#editor').pressSequentially(' from owner');
  await expect(owner.locator('#save-indicator')).toHaveText('Saved');
  await expect(page.locator('#editor-b')).toHaveValue('Shared v1 from owner');

  await owner.close();
  await expect.poll(async () => {
    await page.bringToFront();
    await page.locator('#editor-b').dispatchEvent('focus');
    return page.locator('#editor-b').evaluate(el => (el as HTMLTextAreaElement).readOnly);
  }).toBe(false);
  await expect(page.locator('#save-indicator-b')).toHaveText('Saved');
});
