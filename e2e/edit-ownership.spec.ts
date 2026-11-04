import { expect, test, type Page } from '@playwright/test';
import { documentAction, selectDocument } from './settings-helpers';
import { claimFenceElsewhere, heldEditLocks, readOwnership, readStoredDocs, writeForeignRevision } from './storage-helpers';

// Single editing owner per document (#159 W4): Web Lock + IndexedDB fence.

const role = (page: Page) => page.locator('html');
const instanceOf = (page: Page) => page.locator('html').getAttribute('data-instance-id');
const BUSY = 'This document is open for editing in another TypeBridge window, so it is read-only here.';
const LOST = 'Another TypeBridge window is now editing this document, so this window is read-only.';
const UNSAVED_HERE = 'Your unsaved changes here were not saved; copy or export them to keep them.';

async function saveAs(page: Page, text: string): Promise<string> {
  const field = page.locator('#editor');
  await expect(field).toBeEnabled();
  await field.fill(text);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === text)).toBe(true);
  return (await readStoredDocs(page)).find(row => row.text === text)!.id;
}

async function openOrdinary(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#editor')).toBeEnabled();
  await expect(role(page)).toHaveAttribute('data-role', /^(editor|reader)$/);
}

/** Ask a read-only window to try again, the way focusing its text does. */
async function nudge(page: Page): Promise<void> {
  await page.locator('#editor').dispatchEvent('focus');
}

test('two ordinary tabs on one document: only the first can edit', async ({ page, context }) => {
  await openOrdinary(page);
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  const id = await saveAs(page, 'Первый текст');

  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  const field = other.locator('#editor');
  await expect(field).toHaveValue('Первый текст');
  await expect(field).toHaveJSProperty('readOnly', true);
  await expect(other.locator('#draft-title')).toHaveJSProperty('readOnly', true);
  await expect(other.locator('#ownership-notice')).toBeVisible();
  await expect(other.locator('#ownership-notice')).toContainText(BUSY);
  await expect(other.locator('#save-indicator')).toHaveText('Read-only');
  await expect(other.locator('#status')).toHaveText('Read-only here — another window is editing this document.');
  for (const control of ['#delete-draft', '#clear', '#convert-cyrillic', '#undo', '#autosave']) {
    await expect(other.locator(control)).toBeDisabled();
  }
  await expect(other.locator('#export-txt')).toBeEnabled();
  await expect(other.locator('#new-draft')).toBeEnabled();

  await field.click();
  await other.keyboard.type('privet');
  await expect(field).toHaveValue('Первый текст');

  // The owner keeps editing and the reader follows the saved version.
  await page.locator('#editor').fill('Второй текст');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect(field).toHaveValue('Второй текст');
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  const record = await readOwnership(page, id);
  expect(record?.ownerInstanceId).toBe(await instanceOf(page));
  expect((await readStoredDocs(page)).map(row => row.text)).toEqual(['Второй текст']);

  // The reader can still start its own document, which it owns.
  await documentAction(other, '#new-draft');
  await expect(role(other)).toHaveAttribute('data-role', 'editor');
  await expect(other.locator('#ownership-notice')).toBeHidden();
  await other.locator('#editor').fill('Своё');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
});

test('after the owner closes, another window can take over editing', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Исходник');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');

  await page.close();
  await expect.poll(async () => { await nudge(other); return role(other).getAttribute('data-role'); }).toBe('editor');
  await expect(other.locator('#ownership-notice')).toBeHidden();
  await expect(other.locator('#status')).toContainText('You can edit this document in this window now.');
  await other.locator('#editor').fill('Исходник, продолжение');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
  const rows = await readStoredDocs(other);
  expect(rows.map(row => [row.id, row.text])).toEqual([[id, 'Исходник, продолжение']]);
  expect((await readOwnership(other, id))?.ownerInstanceId).toBe(await instanceOf(other));
});

test('switching documents releases ownership of the one left', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Документ А');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');

  await documentAction(page, '#new-draft');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await expect.poll(async () => (await readOwnership(page, id))?.ownerInstanceId).toBe('');
  await expect.poll(async () => { await nudge(other); return role(other).getAttribute('data-role'); }).toBe('editor');
  await other.locator('#editor').fill('Документ А — правка');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');

  // Switching back now opens it read-only in the first window.
  await selectDocument(page, id);
  await expect(page.locator('#editor')).toHaveValue('Документ А — правка');
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
});

test('a stale owner that wakes after another window claimed the fence cannot write', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await openOrdinary(page);
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  const field = page.locator('#editor');
  await field.fill('Сохранено');
  await page.clock.runFor(400);
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  const id = (await readStoredDocs(page))[0].id;

  // While this window "slept", another window claimed the document's fence.
  await claimFenceElsewhere(page, id);
  await field.fill('Сохранено и дописано 🙂');
  await page.clock.runFor(400);

  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#ownership-notice')).toContainText(LOST);
  await expect(page.locator('#ownership-notice')).toContainText(UNSAVED_HERE);
  await expect(page.locator('#status')).toContainText('Changes here are not saved — another window is editing this document.');
  await expect(page.locator('#save-indicator')).toHaveText('Not saved');
  // Text stays in memory for copy/export; nothing reached storage, not even a conflict copy.
  await expect(field).toHaveValue('Сохранено и дописано 🙂');
  await expect(field).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#export-txt')).toBeEnabled();
  await expect(page.locator('#copy')).toBeEnabled();
  expect((await readStoredDocs(page)).map(row => row.text)).toEqual(['Сохранено']);
  expect((await readOwnership(page, id))?.ownerInstanceId).toBe('another-window');
});

test('a lock taken from the owner makes it read-only before it writes', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Текст владельца');
  const intruder = await context.newPage();
  await intruder.goto('/icon-192.png');
  await intruder.evaluate(name => new Promise<void>(resolve => {
    void navigator.locks.request(name, { steal: true }, () => { resolve(); return new Promise(() => undefined); });
  }), `typebridge-edit-owner:${id}`);
  await claimFenceElsewhere(intruder, id);

  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#ownership-notice')).toContainText(LOST);
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
  // Retrying cannot win while the lock is held elsewhere.
  await nudge(page);
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  expect((await readStoredDocs(page)).map(row => row.text)).toEqual(['Текст владельца']);
});

test('without Web Locks the window stays read-only and explains why', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  });
  await openOrdinary(page);
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await expect(page.locator('#ownership-notice')).toContainText('Editing needs a browser with Web Locks');
  await expect(page.locator('#status')).toHaveText('Read-only — this browser cannot coordinate editing between windows.');
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', true);
  await page.locator('#editor').click();
  await page.keyboard.type('privet');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(page.locator('#copy')).toBeEnabled();
  await expect(page.locator('#export-txt')).toBeEnabled();
  // A new document is not editable either, and nothing is written.
  await documentAction(page, '#new-draft');
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  await nudge(page);
  await expect(role(page)).toHaveAttribute('data-role', 'reader');
  expect(await readStoredDocs(page)).toEqual([]);
});

test('a comparison viewer never acquires editing ownership', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Для сравнения');
  const viewer = await context.newPage();
  await viewer.goto(`/?doc=${id}&mode=view`);
  await expect(viewer.locator('#editor')).toHaveValue('Для сравнения');
  await expect(role(viewer)).toHaveAttribute('data-role', 'viewer');
  expect(await heldEditLocks(viewer)).toEqual([`typebridge-edit-owner:${id}`]);

  await page.close();
  await expect.poll(() => heldEditLocks(viewer)).toEqual([]);
  // Focus and visibility rereads in the viewer must not claim anything.
  await viewer.evaluate(() => window.dispatchEvent(new Event('focus')));
  await viewer.locator('#editor').dispatchEvent('focus');
  expect(await heldEditLocks(viewer)).toEqual([]);
  const viewerInstance = await instanceOf(viewer);
  expect((await readOwnership(viewer, id))?.ownerInstanceId).not.toBe(viewerInstance);

  const next = await context.newPage();
  await openOrdinary(next);
  await expect(role(next)).toHaveAttribute('data-role', 'editor');
  await expect(next.locator('#editor')).toHaveValue('Для сравнения');
});

test('windows opening the same document at once elect exactly one editor', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Гонка');
  await page.close();
  const pages = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  await Promise.all(pages.map(p => p.goto('/')));
  for (const p of pages) await expect(role(p)).toHaveAttribute('data-role', /^(editor|reader)$/);
  const roles = await Promise.all(pages.map(p => role(p).getAttribute('data-role')));
  expect(roles.filter(r => r === 'editor')).toHaveLength(1);
  const editor = pages[roles.indexOf('editor')];
  expect((await readOwnership(editor, id))?.ownerInstanceId).toBe(await instanceOf(editor));
  expect(await heldEditLocks(editor)).toEqual([`typebridge-edit-owner:${id}`]);
});

test('retry does not claim ownership after the document was deleted elsewhere', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'К удалению');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('К удалению');

  await documentAction(page, '#delete-draft');
  await page.getByRole('dialog', { name: 'Delete document?' }).getByRole('button', { name: 'Delete document' }).click();
  await expect(page.locator('#status')).toContainText('Document deleted');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.id === id)).toBe(false);

  // Owner already moved on; the reader must not resurrect the deleted id by claiming the free lock.
  await expect.poll(async () => {
    await nudge(other);
    return other.locator('#version-notice').isVisible();
  }).toBe(true);
  await expect(other.locator('#version-notice')).toContainText('deleted in another window');
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#ownership-notice')).toBeVisible();
  await expect(other.locator('#status')).not.toContainText('You can edit this document in this window now.');
  expect((await readOwnership(other, id))?.ownerInstanceId ?? '').not.toBe(await instanceOf(other));
  expect((await readStoredDocs(other)).map(row => row.id)).not.toContain(id);
});

test('focus applies a missed newer revision before taking ownership', async ({ page, context }) => {
  await openOrdinary(page);
  const id = await saveAs(page, 'Версия один');
  const other = await context.newPage();
  await openOrdinary(other);
  await expect(role(other)).toHaveAttribute('data-role', 'reader');
  await expect(other.locator('#editor')).toHaveValue('Версия один');

  // Silent IDB write (no BroadcastChannel) leaves the reader on the old snapshot until focus.
  await writeForeignRevision(page, { text: 'Версия два' }, id);
  await expect(other.locator('#editor')).toHaveValue('Версия один');
  await page.close();
  await expect.poll(async () => heldEditLocks(other)).toEqual([]);

  await expect.poll(async () => {
    await nudge(other);
    return role(other).getAttribute('data-role');
  }).toBe('editor');
  await expect(other.locator('#editor')).toHaveValue('Версия два');
  await expect(other.locator('#ownership-notice')).toBeHidden();
  expect((await readOwnership(other, id))?.ownerInstanceId).toBe(await instanceOf(other));
  await other.locator('#editor').fill('Версия два, правка');
  await expect(other.locator('#save-indicator')).toHaveText('Saved');
});

test('typing during delayed delete refresh stays frozen then can dirty after completion', async ({ page }) => {
  await openOrdinary(page);
  await saveAs(page, 'to delete');
  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayRefreshMs?: number }).__typebridgeDelayRefreshMs = 900;
  });
  await documentAction(page, '#delete-draft');
  const dialog = page.getByRole('dialog', { name: 'Delete document?' });
  await expect(dialog).toBeVisible();
  const deleteDone = dialog.getByRole('button', { name: 'Delete document' }).click();
  await expect.poll(async () => page.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.readOnly)).toBe(true);
  const during = await page.locator('#editor').inputValue();
  await page.locator('#undo').click({ force: true });
  await page.locator('#redo').click({ force: true });
  await page.keyboard.type('should-not-apply');
  await page.locator('#convert-cyrillic').click({ force: true });
  await expect(page.locator('#editor')).toHaveValue(during);
  await expect(page.locator('#ownership-notice')).toBeHidden();
  await deleteDone;
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await expect(page.locator('#editor')).toHaveJSProperty('readOnly', false);
  await page.locator('#editor').fill('after delete dirty');
  await expect(page.locator('#save-indicator')).toHaveText('Saved');
  await expect.poll(async () => (await readStoredDocs(page)).some(row => row.text === 'after delete dirty')).toBe(true);
});

test('Undo/Convert/Replace during ownership transfer do not mutate or leak into the target', async ({ page }) => {
  await openOrdinary(page);
  const first = await saveAs(page, 'alpha beta');
  await documentAction(page, '#new-draft');
  await expect(page.locator('#editor')).toHaveValue('');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  const second = await saveAs(page, 'second document');

  await selectDocument(page, first);
  await expect(page.locator('#editor')).toHaveValue('alpha beta');
  await page.locator('#editor').evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(0, 5);
  });
  await page.locator('#convert-cyrillic').click();
  await expect(page.locator('#editor')).not.toHaveValue('alpha beta');
  const afterConvert = await page.locator('#editor').inputValue();

  // Delay acquire so mutations attempted mid-transfer hit the frozen Editor gates.
  await page.evaluate(() => {
    (window as Window & { __typebridgeDelayAcquireMs?: number }).__typebridgeDelayAcquireMs = 800;
  });
  const switchPromise = selectDocument(page, second);
  await expect.poll(async () => page.locator('#editor').evaluate((el: HTMLTextAreaElement) => el.readOnly)).toBe(true);
  await page.locator('#undo').click({ force: true });
  await page.locator('#redo').click({ force: true });
  await page.locator('#convert-latin').click({ force: true });
  await page.locator('#find-open').click();
  await page.locator('#find-text').fill('second');
  await page.locator('#replace-text').fill('leaked');
  await page.locator('#replace-one').click({ force: true });
  await page.locator('#replace-all').click({ force: true });
  await page.keyboard.press('ControlOrMeta+z');
  await switchPromise;

  await expect(page.locator('#editor')).toHaveValue('second document');
  await expect(role(page)).toHaveAttribute('data-role', 'editor');
  await selectDocument(page, first);
  await expect(page.locator('#editor')).toHaveValue(afterConvert);
  expect(await page.locator('#editor').inputValue()).not.toContain('leaked');
});
